import { useCallback, useEffect, useState } from 'react'

/**
 * 插件市场（设置 › 扩展能力 › 插件）。
 *
 * 设计原则：
 *  1. 远端代码不静默兜进本机——首次安装必须弹确认卡（来源 / 版本 / 能力 / 校验和），
 *     确认后由主进程记进 pluginTrusted，之后这个插件的更新不再打扰。
 *  2. 装完就接入：命令面板、设备侧栏、新建项目、Agent 工具集全部自动生效，
 *     这里只做「装 / 卸 / 换源」，不做重复接入。
 *  3. 颜色一律走 theme.css 令牌，本文件不出现任何 hex。
 */

interface CatalogItem {
  id: string
  name: string
  displayName: string
  version: string
  description: string
  author?: string
  source: string
  url: string
  sha256: string
  size?: number
  exposes?: string[]
  minAppVersion?: string
  installed?: boolean
  trusted?: boolean
}

interface InstalledItem {
  id: string
  name: string
  displayName: string
  version: string
  description: string
  valid: boolean
  error?: string
}

type LogKind = 'info' | 'ok' | 'err'

const LOG_LIMIT = 12

export default function PluginMarket(): React.JSX.Element {
  const [catalog, setCatalog] = useState<CatalogItem[]>([])
  const [installed, setInstalled] = useState<InstalledItem[]>([])
  const [logs, setLogs] = useState<Array<{ kind: LogKind; text: string }>>([])
  const [busyId, setBusyId] = useState<string | null>(null)
  const [pending, setPending] = useState<CatalogItem | null>(null) // 待确认安装
  const [uninstalling, setUninstalling] = useState<string | null>(null) // 待确认卸载
  const [catalogUrl, setCatalogUrl] = useState('')
  const [urlDraft, setUrlDraft] = useState('')
  const [urlMsg, setUrlMsg] = useState('')

  const pushLog = useCallback((kind: LogKind, text: string) => {
    setLogs((prev) => [{ kind, text }, ...prev].slice(0, LOG_LIMIT))
  }, [])

  const refresh = useCallback(async () => {
    try {
      const [items, inst] = await Promise.all([
        window.api.plugin.catalog(),
        window.api.plugin.installed()
      ])
      setCatalog(Array.isArray(items) ? items : [])
      setInstalled(Array.isArray(inst) ? inst : [])
    } catch (e) {
      pushLog('err', `读取插件列表失败：${(e as Error).message}`)
    }
  }, [pushLog])

  useEffect(() => {
    void refresh()
    window.api.plugin
      .getCatalogUrl()
      .then((v) => {
        setCatalogUrl(typeof v === 'string' ? v : '')
        setUrlDraft(typeof v === 'string' ? v : '')
      })
      .catch(() => undefined)
  }, [refresh])

  const doInstall = async (item: CatalogItem): Promise<void> => {
    setBusyId(item.id)
    pushLog('info', `▶ 安装 ${item.displayName} v${item.version}（来源：${item.source}）`)
    try {
      const res = await window.api.plugin.install(item.id, true)
      if (!res || res.ok) {
        pushLog('ok', `✔ 已安装 ${item.displayName}`)
        // 装完立即重扫，命令/面板/工具集当场生效，不用重启 IDE
        const loaded = await window.api.plugin.reload()
        const names = (Array.isArray(loaded) ? loaded : [])
          .filter((l) => l && l.loaded)
          .map((l) => l.manifest.displayName)
        pushLog('ok', `✔ 已接入：${names.join('、') || '（本轮没有新插件被启用）'}`)
      } else {
        pushLog('err', `✘ 安装失败：${res?.error || '未知原因'}`)
      }
    } catch (e) {
      pushLog('err', `✘ 安装失败：${(e as Error).message}`)
    } finally {
      setBusyId(null)
      setPending(null)
      void refresh()
    }
  }

  const doUninstall = async (id: string): Promise<void> => {
    setBusyId(id)
    try {
      const res = await window.api.plugin.uninstall(id)
      pushLog(res && res.ok ? 'ok' : 'err', res && res.ok ? `✔ 已卸载 ${id}` : `✘ 卸载失败：${res?.error || '未知原因'}`)
      if (res && res.ok) {
        const loaded = await window.api.plugin.reload()
        pushLog('info', `已重扫插件目录，当前启用 ${(Array.isArray(loaded) ? loaded : []).length} 个`)
      }
    } catch (e) {
      pushLog('err', `✘ 卸载失败：${(e as Error).message}`)
    } finally {
      setBusyId(null)
      setUninstalling(null)
      void refresh()
    }
  }

  const saveCatalogUrl = async (): Promise<void> => {
    try {
      const res = await window.api.plugin.setCatalogUrl(urlDraft)
      if (res && res.ok) {
        setCatalogUrl(urlDraft.trim())
        setUrlMsg('已保存（下次打开列表生效）')
        pushLog('info', `清单源已切换为 ${urlDraft.trim() || '内置清单'}`)
        void refresh()
      } else {
        setUrlMsg(res?.error || '保存失败')
      }
    } catch (e) {
      setUrlMsg((e as Error).message)
    }
  }

  const stateOf = (item: CatalogItem): { dot: string; text: string; tag: string } => {
    const inst = installed.find((i) => i.id === item.id)
    if (!item.installed) return { dot: '', text: '未安装', tag: '' }
    if (inst && inst.valid === false) return { dot: 'off', text: '未生效', tag: 'tag-off' }
    return { dot: 'on', text: `已启用 v${inst?.version || item.version}`, tag: 'ok' }
  }

  return (
    <div className="settings-section">
      <h3>插件</h3>
      <p className="settings-desc">
        插件是下载到本机执行的扩展包，装好后会自动接入命令面板、设备侧栏与 Agent 工具集。
        首次安装会先弹确认卡（来源 / 版本 / 会拿到的能力 / 包校验和），点确认才算装；
        确认过一次后本机就记住这个插件，之后它的更新不再重复打扰。
      </p>

      {catalog.length === 0 && <p className="settings-desc">清单为空（内置清单没匹配到任何条目）</p>}

      {catalog.map((item) => {
        const st = stateOf(item)
        return (
          <div className="plugin-card" key={item.id}>
            <div className="plugin-card-head">
              <span className="plugin-card-name">{item.displayName}</span>
              <span className="settings-tag">v{item.version}</span>
              <span className={`settings-tag ${st.tag}`}>
                <span className={`plugin-dot ${st.dot}`} />
                {st.text}
              </span>
              {item.installed ? (
                uninstalling === item.id ? (
                  <>
                    <button className="settings-btn" style={{ color: 'var(--danger)' }} disabled={busyId === item.id} onClick={() => void doUninstall(item.id)}>
                      确认卸载
                    </button>
                    <button className="settings-btn" onClick={() => setUninstalling(null)}>
                      取消
                    </button>
                  </>
                ) : (
                  <button className="settings-btn" onClick={() => setUninstalling(item.id)}>
                    卸载
                  </button>
                )
              ) : (
                <button className="settings-btn primary" disabled={busyId === item.id} onClick={() => setPending(item)}>
                  {busyId === item.id ? '安装中…' : '安装'}
                </button>
              )}
            </div>
            <div className="plugin-card-desc">{item.description}</div>
            <div className="plugin-card-meta">
              <span>{item.source}</span>
              {item.author ? <span>· {item.author}</span> : null}
              <span>· sha256 {item.sha256 ? item.sha256.slice(0, 12) : '（未在清单里声明）'}</span>
              {Array.isArray(item.exposes) && item.exposes.length > 0 ? (
                <span className="plugin-exposes">
                  会获得：{item.exposes.map((e) => (
                    <span className="settings-tag" key={e}>
                      {e}
                    </span>
                  ))}
                </span>
              ) : null}
            </div>
          </div>
        )
      })}

      {logs.length > 0 && (
        <div className="plugin-log">
          {logs.map((l, i) => (
            <div className={`plugin-log-line ${l.kind}`} key={`${i}-${l.text}`}>
              {l.text}
            </div>
          ))}
        </div>
      )}

      <div className="settings-foot">
        <div className="settings-row" style={{ borderBottom: 'none' }}>
          <span className="settings-tag">清单源</span>
          <span className="settings-val">{catalogUrl || '内置清单（settings.json 未配置 pluginCatalogUrl）'}</span>
        </div>
        <div className="settings-row" style={{ borderBottom: 'none' }}>
          <input
            className="settings-input"
            placeholder="https://你的清单地址（留空恢复内置）"
            value={urlDraft}
            onChange={(e) => setUrlDraft(e.target.value)}
          />
          <button className="settings-btn" onClick={() => void saveCatalogUrl()}>
            保存并重载
          </button>
          {urlMsg ? <span className="settings-tag">{urlMsg}</span> : null}
        </div>
      </div>

      {pending ? (
        <div className="plugin-confirm">
          <div className="plugin-confirm-head">安装「{pending.displayName}」？</div>
          <p className="settings-desc">这是第一次装这个插件，会执行它自带的 JS（只在本机、只在这个 IDE 里跑）。装完的权限就是确认过的权限。</p>
          <div className="plugin-confirm-grid">
            <span>来源</span>
            <span>{pending.source}</span>
            <span>版本</span>
            <span>v{pending.version}</span>
            {pending.author ? (
              <>
                <span>作者</span>
                <span>{pending.author}</span>
              </>
            ) : null}
            <span>包地址</span>
            <span className="plugin-mono">{pending.url}</span>
            <span>校验和</span>
            <span className="plugin-mono">{pending.sha256 ? pending.sha256.slice(0, 16) : '清单未声明 sha256'}</span>
            <span>会获得</span>
            <span>{Array.isArray(pending.exposes) && pending.exposes.length > 0 ? pending.exposes.join(' / ') : '（未声明额外能力）'}</span>
          </div>
          <div className="settings-actions" style={{ display: 'flex', gap: 8 }}>
            <button className="settings-btn primary" disabled={busyId === pending.id} onClick={() => void doInstall(pending)}>
              确认安装
            </button>
            <button className="settings-btn" onClick={() => setPending(null)}>
              取消
            </button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

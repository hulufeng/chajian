/**
 * 官方插件清单（内置兜底）。
 *
 * 清单条目说明：
 *  - url 支持 https:// 与 file://（file 用于本机离线源 / 自测），正常发布走 https。
 *  - sha256 是 zip 包的校验和，下载后必须一致才允许安装，防止中途换包。
 *  - 想换自己的源：settings.json 里写 pluginCatalogUrl = "<清单 JSON 地址>" 即可，
 *    运行时会优先拉远端清单并覆盖同类条目（失败仍回退到这里的内置清单）。
 *
 * 内置 zip 的 url 不能写死绝对路径（原写法 file:///D:/工作/... 换机器就装不了），
 * 改为按「打包 resources → 开发 resources → cwd」顺序探测，与 knowledgeBase 同一套惯例。
 * 用惰性函数求值而非模块顶层常量：electron 的 process.resourcesPath 只有进程起来后才有值。
 */
import { pathToFileURL } from 'node:url'
import { existsSync } from 'node:fs'
import path from 'node:path'

export interface CatalogEntry {
  id: string
  name: string
  displayName: string
  version: string
  description: string
  author?: string
  /** 来源标识，安装确认卡展示用 */
  source: string
  /** zip 包地址（https 或 file） */
  url: string
  /** zip 包 sha256（小写） */
  sha256: string
  size?: number
  /** 声明的能力/工具名，安装确认卡展示 */
  exposes?: string[]
  minAppVersion?: string
  /** 信任分级：official=随应用分发、已审计（免确认）；thirdparty=第三方/本地市场（首次需确认） */
  tier?: 'official' | 'thirdparty'
}

/**
 * 内置离线包的候选位置。
 * 顺序：打包后的 resources（electron-builder 把 resources/ 拷到 resourcesPath）
 *      → 开发态的项目 resources → cwd/resources。
 * 不用 process.resourcesPath 单独判断是否打包——直接 existsSync 探测，谁存在用谁。
 */
function builtinBundleCandidates(rel: string): string[] {
  return [
    process.resourcesPath ? path.join(process.resourcesPath, rel) : '',
    path.join(__dirname, '..', '..', 'resources', rel),
    path.join(process.cwd(), 'resources', rel)
  ].filter(Boolean)
}

/**
 * 首个真实存在的内置 zip 路径；都找不到则返回空串（安装器会给出明确错误，不静默）。
 * rel 传相对路径（如 'plugin-demo/xxx.zip'）。
 */
export function resolveBuiltinBundle(rel = 'plugin-demo/esp32-sensor-lab.zip'): string {
  for (const p of builtinBundleCandidates(rel)) {
    if (existsSync(p)) return p
  }
  return ''
}

/** 生成一条内置清单条目：惰性解析 zip 真实路径，sha256 由 scripts/build-demo-plugins.mjs 产出 */
function builtinEntry(
  meta: Omit<CatalogEntry, 'url' | 'source'>,
  bundleRel: string
): CatalogEntry {
  return {
    ...meta,
    source: '内置源',
    tier: 'official',
    get url(): string {
      const p = resolveBuiltinBundle(bundleRel)
      return p ? pathToFileURL(p).href : ''
    },
  }
}

export const DEFAULT_CATALOG: CatalogEntry[] = [
  builtinEntry(
    {
      id: 'esp32-sensor-lab',
      name: 'esp32-sensor-lab',
      displayName: 'ESP32 传感器实验台',
      version: '0.1.0',
      description: '内置常见传感器读取（温湿度 / 光照 / 距离）与一键数据曲线，直接接串口即出图。',
      author: 'CodeLab 官方',
      sha256: 'e5eeedae4f7cf4a66941c2261e33bb755ca5e1f40fc87154ea27faf0e53367e5',
      exposes: ['sensor-read', 'sensor-chart'],
      minAppVersion: '0.0.1',
    },
    'plugin-demo/esp32-sensor-lab.zip'
  ),
  builtinEntry(
    {
      id: 'serial-analyser',
      name: 'serial-analyser',
      displayName: '串口数据分析器',
      version: '0.1.0',
      description: '把串口输出当数据流分析：自动识别 CSV/JSON/键值对格式，统计均值/中位数/标准差并标出离群点。',
      author: 'CodeLab 官方',
      sha256: '5e7f8ff6a0aab2b1c17cecf8852da6e81155ab61e63a3ce3d31faab6a37a2bf4',
      exposes: ['serial-analyser'],
      minAppVersion: '0.0.1',
    },
    'plugin-demo/serial-analyser.zip'
  ),
  builtinEntry(
    {
      id: 'serial-scope',
      name: 'serial-scope',
      displayName: '串口波形监视器',
      version: '0.1.0',
      description: '把串口数值流渲染成 ASCII 波形（Agent 可直接读文本波形判断趋势），并估算采样频率、检测丢包。',
      author: 'CodeLab 官方',
      sha256: '13df390274f2b489eed3e98e1f1cc8fde8d8fa396693064e6517a03400344301',
      exposes: ['serial-scope'],
      minAppVersion: '0.0.1',
    },
    'plugin-demo/serial-scope.zip'
  ),
  builtinEntry(
    {
      id: 'esp32-crash-lookup',
      name: 'esp32-crash-lookup',
      displayName: 'ESP32 崩溃速查表',
      version: '0.1.0',
      description: '离线崩溃知识库：10 类 ESP32 崩溃签名（Guru Meditation/Brownout/看门狗/栈溢出…）的原因、自查步骤与修复建议，含 addr2line 解码命令。',
      author: 'CodeLab 官方',
      sha256: 'e5125d2f8139a834a0cbd377ee58d3db542bfdff60b1e2783956daa602e7250c',
      exposes: ['crash-lookup'],
      minAppVersion: '0.0.1',
    },
    'plugin-demo/esp32-crash-lookup.zip'
  ),
  builtinEntry(
    {
      id: 'plugin-dev-toolchain',
      name: 'plugin-dev-toolchain',
      displayName: '插件开发工具链（元插件）',
      version: '0.1.0',
      description: '用来设计插件的插件：create 生成骨架、validate 校验 manifest、install 安装到本机，并配「创建插件」技能引导选型。',
      author: 'CodeLab 官方',
      sha256: '1cbaec48a9cdbf3540d241f1e89c711aaa6cfc64175210f64e0361eb74bd1062',
      exposes: ['plugin-dev.create', 'plugin-dev.validate', 'plugin-dev.install'],
      minAppVersion: '0.0.1',
    },
    'plugin-demo/plugin-dev-toolchain.zip'
  ),
  // SVD 寄存器查询：随应用内置的源码插件（src/main/plugins/svd-query），始终已加载、无需下载安装。
  // 数据来自乐鑫官方 espressif/svd（Apache-2.0，GitHub 托管），不进安装包、不进服务器。
  // 无 zip 包（源码内置），url/sha256 留空，installPlugin 会按内置插件短路。
  {
    id: 'svd-query',
    name: 'svd-query',
    displayName: 'SVD 寄存器查询',
    version: '0.1.0',
    description: '乐鑫官方 CMSIS-SVD 寄存器/位域/绝对地址精确查询。数据来自 espressif/svd（Apache-2.0，GitHub 托管，不进安装包、不进服务器）。写裸寄存器/改外设配置前必须用本工具核对，禁止凭记忆写寄存器地址或位域。',
    author: 'CodeLab 官方',
    source: '内置源（SVD 数据来自 espressif/svd，Apache-2.0）',
    url: '',
    sha256: '',
    exposes: ['svd_query'],
    minAppVersion: '0.1.0',
    tier: 'official',
  },
]

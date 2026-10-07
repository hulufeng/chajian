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

/** 首个真实存在的内置 zip 路径；都找不到则返回空串（安装器会给出明确错误，不静默） */
export function resolveBuiltinBundle(rel = 'plugin-demo/esp32-sensor-lab.zip'): string {
  for (const p of builtinBundleCandidates(rel)) {
    if (existsSync(p)) return p
  }
  return ''
}

export const DEFAULT_CATALOG: CatalogEntry[] = [
  {
    id: 'esp32-sensor-lab',
    name: 'esp32-sensor-lab',
    displayName: 'ESP32 传感器实验台',
    version: '0.1.0',
    description: '内置常见传感器读取（温湿度 / 光照 / 距离）与一键数据曲线，直接接串口即出图。',
    author: 'CodeLab 官方',
    source: '内置源',
    // 惰性 getter：首次读取时才探测真实路径，避免模块加载时就固化某个机器的绝对路径
    get url(): string {
      const p = resolveBuiltinBundle()
      return p ? pathToFileURL(p).href : ''
    },
    // 改包内容后必须同步更新这个校验和（安装器会比对，不符直接中止）
    sha256: 'ffbbcc6631c3dbc5abb7e1e8680803c36f312bcaca92c74327cac59ef3d85aaf',
    exposes: ['sensor-read', 'sensor-chart'],
    minAppVersion: '0.0.1',
  },
]

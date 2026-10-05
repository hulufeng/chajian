/**
 * 官方插件清单（内置兜底）。
 *
 * 清单条目说明：
 *  - url 支持 https:// 与 file://（file 用于本机离线源 / 自测），正常发布走 https。
 *  - sha256 是 zip 包的校验和，下载后必须一致才允许安装，防止中途换包。
 *  - 想换自己的源：settings.json 里写 pluginCatalogUrl = "<清单 JSON 地址>" 即可，
 *    运行时会优先拉远端清单并覆盖同类条目（失败仍回退到这里的内置清单）。
 */

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

export const DEFAULT_CATALOG: CatalogEntry[] = [
  {
    id: 'esp32-sensor-lab',
    name: 'esp32-sensor-lab',
    displayName: 'ESP32 传感器实验台',
    version: '0.1.0',
    description: '内置常见传感器读取（温湿度 / 光照 / 距离）与一键数据曲线，直接接串口即出图。',
    author: 'CodeLab 官方',
    source: '内置源',
    url: 'file:///D:/工作/代码实验室/codelab-desktop/resources/plugin-demo/esp32-sensor-lab.zip',
    // 改包内容后必须同步更新这个校验和（安装器会比对，不符直接中止）
    sha256: 'ffbbcc6631c3dbc5abb7e1e8680803c36f312bcaca92c74327cac59ef3d85aaf',
    exposes: ['sensor-read', 'sensor-chart'],
    minAppVersion: '0.0.1',
  },
]

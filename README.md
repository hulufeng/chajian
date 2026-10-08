# LabCode — ESP32 教学 IDE

面向 ESP32 开发的商业化桌面 IDE，内置 AI 编程助手、真实烧录、板级仿真、课程体系。

## 功能

- **ESP32 真实烧录**：Arduino CLI 工具链，一键编译/烧录/串口监视
- **板级仿真**：OLED/ADC/DHT22/示波器等外设可视化，不接板子也能跑
- **内置 AI 助手**：
  - 本地模型（Qwen2.5 Coder 3B，gguf，4GB 内存可跑）
  - 云端模型（DeepSeek/通义千问，邮箱验证码登录）
  - 40+ 工具：文件读写/终端/Git/网页搜索/编译/烧录/SVD 调试
- **课程体系**：28+ 个 ESP32 教学示例（LED/Wi-Fi/传感器/FreeRTOS/BLE）
- **插件系统**：MCP 外部工具 + GitHub 插件市场

## 技术栈

Electron 44 + React 19 + TypeScript 5.9 + electron-vite 5

## 开发

```bash
npm install
npm run dev
```

## 打包

```bash
npm run build
```

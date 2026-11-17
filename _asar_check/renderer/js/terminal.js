/**
 * BubaiCode 终端管理器
 * 基于 xterm.js 实现终端界面
 */

class TerminalManager {
  constructor() {
    this.terminals = new Map();
    this.activeTerminalId = null;
    this.xtermLoaded = false;
    this.xterm = null;
    this.fitAddon = null;
    this.container = null;
    this.isElectron = window.BubaiCode && window.BubaiCode.terminal;
  }

  /**
   * 初始化 xterm.js
   * @param {HTMLElement} container - 终端容器
   */
  async init(container) {
    this.container = container;
    
    if (!this.xtermLoaded) {
      try {
        // 动态加载 xterm.js
        await this.loadXterm();
        this.xtermLoaded = true;
        console.log('[TerminalManager] xterm.js 加载成功');
      } catch (e) {
        console.error('[TerminalManager] xterm.js 加载失败:', e);
        // 使用降级模式
        this.initFallbackTerminal();
        return;
      }
    }
  }

  /**
   * 动态加载 xterm.js
   */
  async loadXterm() {
    return new Promise((resolve, reject) => {
      // 检查是否已经加载
      if (window.Terminal) {
        this.xterm = window.Terminal;
        resolve();
        return;
      }

      // 尝试从 node_modules 加载
      const scripts = [
        '../../node_modules/xterm/lib/xterm.js',
        '../node_modules/xterm/lib/xterm.js',
        'node_modules/xterm/lib/xterm.js'
      ];

      const cssLinks = [
        '../../node_modules/xterm/css/xterm.css',
        '../node_modules/xterm/css/xterm.css',
        'node_modules/xterm/css/xterm.css'
      ];

      // 加载 CSS
      let cssLoaded = false;
      for (const cssPath of cssLinks) {
        try {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = cssPath;
          document.head.appendChild(link);
          cssLoaded = true;
          break;
        } catch (e) {
          // 继续尝试下一个路径
        }
      }

      // 加载 JS
      let scriptLoaded = false;
      for (const scriptPath of scripts) {
        try {
          const script = document.createElement('script');
          script.src = scriptPath;
          script.onload = () => {
            if (window.Terminal) {
              this.xterm = window.Terminal;
              scriptLoaded = true;
              resolve();
            }
          };
          script.onerror = () => {
            // 继续尝试下一个路径
          };
          document.head.appendChild(script);
          break;
        } catch (e) {
          // 继续尝试下一个路径
        }
      }

      // 如果都失败了，使用 CDN
      if (!scriptLoaded) {
        const cdnScript = document.createElement('script');
        cdnScript.src = 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js';
        cdnScript.onload = () => {
          if (window.Terminal) {
            this.xterm = window.Terminal;
            resolve();
          } else {
            reject(new Error('xterm.js 加载失败'));
          }
        };
        cdnScript.onerror = () => reject(new Error('xterm.js CDN 加载失败'));
        document.head.appendChild(cdnScript);

        // 加载 CSS
        const cdnCss = document.createElement('link');
        cdnCss.rel = 'stylesheet';
        cdnCss.href = 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css';
        document.head.appendChild(cdnCss);
      }
    });
  }

  /**
   * 初始化降级终端（不使用 xterm.js）
   */
  initFallbackTerminal() {
    console.log('[TerminalManager] 使用降级终端模式');
    this.fallbackMode = true;
  }

  /**
   * 创建新终端
   * @param {Object} options - 终端选项
   * @returns {Promise<Object>} 终端信息
   */
  async createTerminal(options = {}) {
    const terminalId = 'term_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    
    if (this.isElectron) {
      // 使用 Electron 主进程终端服务
      const result = await window.BubaiCode.terminal.create(options);
      if (result.success) {
        const id = result.terminal.id;
        const terminal = {
          id: id,
          xterm: null,
          element: null,
          cleanupData: null,
          cleanupExit: null
        };

        // 创建 xterm 实例
        if (this.xterm && !this.fallbackMode) {
          terminal.xterm = new this.xterm({
            cursorBlink: true,
            fontSize: 13,
            fontFamily: 'Consolas, "Courier New", monospace',
            theme: {
              background: '#1e1e1e',
              foreground: '#d4d4d4',
              cursor: '#ffffff',
              selectionBackground: '#264f78',
              black: '#000000',
              red: '#cd3131',
              green: '#0dbc79',
              yellow: '#e5e510',
              blue: '#2472c8',
              magenta: '#bc3fbc',
              cyan: '#11a8cd',
              white: '#e5e5e5',
              brightBlack: '#666666',
              brightRed: '#f14c4c',
              brightGreen: '#23d18b',
              brightYellow: '#f5f543',
              brightBlue: '#3b8eea',
              brightMagenta: '#d670d6',
              brightCyan: '#29b8db',
              brightWhite: '#ffffff'
            }
          });

          // 监听终端输入
          terminal.xterm.onData((data) => {
            window.BubaiCode.terminal.write(id, data);
          });

          // 监听终端大小变化
          terminal.xterm.onResize(({ cols, rows }) => {
            window.BubaiCode.terminal.resize(id, cols, rows);
          });

          // 监听主进程终端数据输出
          terminal.cleanupData = window.BubaiCode.terminal.onData(id, (data) => {
            terminal.xterm.write(data);
          });

          // 监听终端退出
          terminal.cleanupExit = window.BubaiCode.terminal.onExit(id, ({ exitCode, signal }) => {
            terminal.xterm.write(`\r\n\x1b[31m[进程已退出，退出码: ${exitCode}]\x1b[0m\r\n`);
          });
        }

        this.terminals.set(id, terminal);
        this.activeTerminalId = id;
        return { success: true, terminal: result.terminal };
      } else {
        return { success: false, error: result.error };
      }
    } else {
      // 浏览器环境，使用模拟终端
      const terminal = {
        id: terminalId,
        xterm: null,
        element: null,
        isMock: true
      };
      this.terminals.set(terminalId, terminal);
      this.activeTerminalId = terminalId;
      return { success: true, terminal: { id: terminalId, shell: 'mock', cwd: '/' } };
    }
  }

  /**
   * 在指定容器中显示终端
   * @param {string} id - 终端 ID
   * @param {HTMLElement} container - 容器元素
   */
  attachTerminal(id, container) {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      console.error(`终端 ${id} 不存在`);
      return;
    }

    // 清空容器
    container.innerHTML = '';
    terminal.element = container;

    if (terminal.xterm) {
      terminal.xterm.open(container);
      // 调整大小
      setTimeout(() => {
        if (terminal.xterm && container.clientWidth > 0 && container.clientHeight > 0) {
          const cols = Math.floor(container.clientWidth / 8);
          const rows = Math.floor(container.clientHeight / 18);
          terminal.xterm.resize(cols, rows);
        }
      }, 100);
    } else if (terminal.isMock || this.fallbackMode) {
      // 降级模式：使用简单的文本终端
      this.attachFallbackTerminal(terminal, container);
    }
  }

  /**
   * 附加降级终端
   */
  attachFallbackTerminal(terminal, container) {
    const output = document.createElement('div');
    output.className = 'fallback-terminal-output';
    output.style.cssText = `
      flex: 1;
      overflow-y: auto;
      padding: 8px;
      font-family: Consolas, "Courier New", monospace;
      font-size: 13px;
      background: #1e1e1e;
      color: #d4d4d4;
      white-space: pre-wrap;
      word-break: break-all;
    `;

    const inputLine = document.createElement('div');
    inputLine.style.cssText = `
      display: flex;
      padding: 4px 8px;
      background: #1e1e1e;
      border-top: 1px solid #333;
    `;

    const prompt = document.createElement('span');
    prompt.textContent = '$ ';
    prompt.style.cssText = 'color: #0dbc79; margin-right: 8px;';

    const input = document.createElement('input');
    input.type = 'text';
    input.style.cssText = `
      flex: 1;
      background: transparent;
      border: none;
      outline: none;
      color: #d4d4d4;
      font-family: Consolas, "Courier New", monospace;
      font-size: 13px;
    `;

    inputLine.appendChild(prompt);
    inputLine.appendChild(input);

    container.style.cssText = 'display: flex; flex-direction: column; height: 100%; background: #1e1e1e;';
    container.appendChild(output);
    container.appendChild(inputLine);

    terminal.fallbackOutput = output;
    terminal.fallbackInput = input;

    // 欢迎信息
    output.textContent = 'BubaiCode Terminal (降级模式)\n';
    output.textContent += '输入 help 查看可用命令\n\n';

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const command = input.value.trim();
        if (command) {
          output.textContent += `$ ${command}\n`;
          this.executeFallbackCommand(terminal, command);
          output.textContent += '\n';
        }
        input.value = '';
        output.scrollTop = output.scrollHeight;
      }
    });

    input.focus();
  }

  /**
   * 执行降级命令
   */
  executeFallbackCommand(terminal, command) {
    const output = terminal.fallbackOutput;
    const parts = command.split(' ');
    const cmd = parts[0].toLowerCase();

    switch (cmd) {
      case 'help':
        output.textContent += '可用命令:\n';
        output.textContent += '  help     - 显示帮助信息\n';
        output.textContent += '  clear    - 清屏\n';
        output.textContent += '  echo     - 输出文本\n';
        output.textContent += '  date     - 显示当前时间\n';
        output.textContent += '  pwd      - 显示当前目录\n';
        output.textContent += '  ls       - 列出文件\n';
        output.textContent += '  whoami   - 显示当前用户\n';
        output.textContent += '  version  - 显示版本信息\n';
        break;
      case 'clear':
        output.textContent = '';
        break;
      case 'echo':
        output.textContent += parts.slice(1).join(' ') + '\n';
        break;
      case 'date':
        output.textContent += new Date().toString() + '\n';
        break;
      case 'pwd':
        output.textContent += '/home/user/project\n';
        break;
      case 'ls':
        output.textContent += 'src/  tests/  package.json  README.md\n';
        break;
      case 'whoami':
        output.textContent += 'user\n';
        break;
      case 'version':
        output.textContent += 'BubaiCode Terminal v1.0.0 (降级模式)\n';
        break;
      default:
        output.textContent += `命令未找到: ${cmd}\n`;
        output.textContent += '输入 help 查看可用命令\n';
    }
  }

  /**
   * 向终端写入数据
   * @param {string} id - 终端 ID
   * @param {string} data - 数据
   */
  write(id, data) {
    const terminal = this.terminals.get(id);
    if (!terminal) return;

    if (terminal.xterm) {
      terminal.xterm.write(data);
    } else if (terminal.fallbackOutput) {
      terminal.fallbackOutput.textContent += data;
      terminal.fallbackOutput.scrollTop = terminal.fallbackOutput.scrollHeight;
    }
  }

  /**
   * 杀死终端
   * @param {string} id - 终端 ID
   */
  async kill(id) {
    const terminal = this.terminals.get(id);
    if (!terminal) return;

    // 清理事件监听
    if (terminal.cleanupData) terminal.cleanupData();
    if (terminal.cleanupExit) terminal.cleanupExit();

    // 销毁 xterm 实例
    if (terminal.xterm) {
      terminal.xterm.dispose();
    }

    // 通知主进程杀死终端
    if (this.isElectron) {
      await window.BubaiCode.terminal.kill(id);
    }

    this.terminals.delete(id);

    if (this.activeTerminalId === id) {
      this.activeTerminalId = null;
    }
  }

  /**
   * 获取所有终端列表
   * @returns {Array} 终端列表
   */
  listTerminals() {
    const list = [];
    this.terminals.forEach((terminal, id) => {
      list.push({
        id: id,
        isMock: terminal.isMock || false
      });
    });
    return list;
  }

  /**
   * 销毁所有终端
   */
  async destroyAll() {
    const ids = Array.from(this.terminals.keys());
    for (const id of ids) {
      await this.kill(id);
    }
  }

  /**
   * 执行命令并返回结果
   * @param {string} command - 命令
   * @param {string} cwd - 工作目录
   * @param {number} timeout - 超时时间
   * @returns {Promise<Object>} 执行结果
   */
  async executeCommand(command, cwd, timeout = 30000) {
    if (this.isElectron) {
      return await window.BubaiCode.terminal.execute(command, cwd, timeout);
    } else {
      // 浏览器环境，返回模拟结果
      return {
        success: true,
        exitCode: 0,
        stdout: `执行命令: ${command}\n(模拟输出)`,
        stderr: ''
      };
    }
  }
}

// 导出单例
let instance = null;
function getTerminalManager() {
  if (!instance) {
    instance = new TerminalManager();
  }
  return instance;
}

// 兼容 CommonJS 和浏览器环境
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { TerminalManager, getTerminalManager };
} else {
  window.TerminalManager = TerminalManager;
  window.getTerminalManager = getTerminalManager;
}

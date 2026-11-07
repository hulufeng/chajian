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
        this.initPromise = this.loadXterm();
        await this.initPromise;
        this.xtermLoaded = true;
        console.log('[TerminalManager] xterm.js 加载成功');
        // xterm 加载完成后，重新 attach 所有已存在但没有 xterm 实例的终端
        this.terminals.forEach((term, id) => {
          if (!term.xterm && term.element) {
            console.log(`[TerminalManager] xterm 就绪，重新 attach 终端 ${id}`);
            this.attachTerminal(id, term.element);
          }
        });
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

      // 尝试从 node_modules 加载（相对 renderer/index.html 解析，app.asar 根为上一级）
      const scripts = [
        '../node_modules/xterm/lib/xterm.js',
        'node_modules/xterm/lib/xterm.js'
      ];

      const cssLinks = [
        '../node_modules/xterm/css/xterm.css',
        'node_modules/xterm/css/xterm.css'
      ];

      // 加载 CSS
      for (const cssPath of cssLinks) {
        try {
          const link = document.createElement('link');
          link.rel = 'stylesheet';
          link.href = cssPath;
          document.head.appendChild(link);
          break;
        } catch (e) {
          // 继续尝试下一个路径
        }
      }

      // 用 fetch + 隔离作用域执行 xterm 源码（不经过 script 标签与 AMD define，
      // 避免 monaco loader 的全局 define 拦截 UMD 全局导出，也不影响 monaco 加载）
      const loadScriptByFetch = async (url) => {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const code = await resp.text();
        const fn = new Function('define', code + '\n;return (typeof Terminal !== "undefined") ? Terminal : undefined;');
        return fn(undefined);
      };

      const tryLoad = async () => {
        for (const p of scripts) {
          try {
            const T = await loadScriptByFetch(p);
            if (T) {
              this.xterm = T;
              resolve();
              return;
            }
          } catch (e) {
            // 继续尝试下一个路径
          }
        }
        // 全部本地路径失败，回退 CDN
        try {
          const cdnCss = document.createElement('link');
          cdnCss.rel = 'stylesheet';
          cdnCss.href = 'https://cdn.jsdelivr.net/npm/xterm@5.3.0/css/xterm.css';
          document.head.appendChild(cdnCss);
          const T = await loadScriptByFetch('https://cdn.jsdelivr.net/npm/xterm@5.3.0/lib/xterm.js');
          if (T) {
            this.xterm = T;
            resolve();
          } else {
            reject(new Error('xterm.js 加载失败'));
          }
        } catch (e) {
          reject(new Error('xterm.js CDN 加载失败'));
        }
      };

      tryLoad();
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
    
    // 等待 xterm 加载完成（最多等 5 秒）
    if (!this.xtermLoaded && !this.fallbackMode) {
      try {
        if (this.initPromise) {
          await Promise.race([this.initPromise, new Promise(r => setTimeout(r, 5000))]);
        }
      } catch(e) { console.warn('[TerminalManager] 等待 xterm 加载超时:', e); }
    }
    
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
              background: '#ffffff',
              foreground: '#333333',
              cursor: '#000000',
              selectionBackground: '#cce5ff',
              black: '#000000',
              red: '#cd3131',
              green: '#00aa00',
              yellow: '#999900',
              blue: '#0066cc',
              magenta: '#aa00aa',
              cyan: '#009999',
              white: '#dddddd',
              brightBlack: '#666666',
              brightRed: '#ff0000',
              brightGreen: '#00ff00',
              brightYellow: '#ffff00',
              brightBlue: '#0000ff',
              brightMagenta: '#ff00ff',
              brightCyan: '#00ffff',
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

    // 兜底：如果终端没有 xterm 实例但 xterm 已加载，尝试创建
    if (!terminal.xterm && !terminal.isMock && !this.fallbackMode && this.xterm) {
      try {
        terminal.xterm = new this.xterm({
          cursorBlink: true,
          fontSize: 13,
          fontFamily: 'Consolas, "Courier New", monospace',
          theme: { background: '#ffffff', foreground: '#333333', cursor: '#000000' }
        });
        if (this.isElectron && window.BubaiCode && window.BubaiCode.terminal) {
          terminal.xterm.onData((data) => window.BubaiCode.terminal.write(id, data));
          terminal.cleanupData = window.BubaiCode.terminal.onData(id, (data) => terminal.xterm.write(data));
        }
        console.log(`[TerminalManager] 兜底创建 xterm 实例 for ${id}`);
      } catch(e) {
        console.error('[TerminalManager] 兜底创建 xterm 失败:', e);
      }
    }

    if (terminal.xterm) {
      terminal.xterm.open(container);
      // 设置白色背景，确保与容器一致
      terminal.xterm.element.style.backgroundColor = '#ffffff';
      // 调整大小（多次重试，确保容器已渲染）
      const doResize = () => {
        if (terminal.xterm && container.clientWidth > 0 && container.clientHeight > 0) {
          // 使用 xterm 的实际字符尺寸计算
          const core = terminal.xterm._core;
          let charWidth = 8;
          let charHeight = 18;
          if (core && core._renderService && core._renderService.dimensions) {
            charWidth = core._renderService.dimensions.actualCellWidth || 8;
            charHeight = core._renderService.dimensions.actualCellHeight || 18;
          }
          const cols = Math.max(1, Math.floor(container.clientWidth / charWidth));
          const rows = Math.max(1, Math.floor(container.clientHeight / charHeight));
          terminal.xterm.resize(cols, rows);
        }
      };
      setTimeout(doResize, 100);
      setTimeout(doResize, 500);
      setTimeout(doResize, 1000);
      // 监听窗口大小变化
      if (!this._resizeListener) {
        this._resizeListener = () => {
          this.terminals.forEach((t) => {
            if (t.xterm && t.element) {
              const c = t.element;
              if (c.clientWidth > 0 && c.clientHeight > 0) {
                const core = t.xterm._core;
                let cw = 8, ch = 18;
                if (core && core._renderService && core._renderService.dimensions) {
                  cw = core._renderService.dimensions.actualCellWidth || 8;
                  ch = core._renderService.dimensions.actualCellHeight || 18;
                }
                t.xterm.resize(Math.max(1, Math.floor(c.clientWidth / cw)), Math.max(1, Math.floor(c.clientHeight / ch)));
              }
            }
          });
        };
        window.addEventListener('resize', this._resizeListener);
      }
    } else if (terminal.isMock || this.fallbackMode) {
      // 降级模式：使用简单的文本终端
      this.attachFallbackTerminal(terminal, container);
    } else {
      // 终极兜底：显示提示
      const hint = document.createElement('div');
      hint.style.cssText = 'padding:8px;color:#888;font-family:monospace;font-size:12px;';
      hint.textContent = '终端初始化中...';
      container.appendChild(hint);
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
      background: #ffffff;
      color: #333333;
      white-space: pre-wrap;
      word-break: break-all;
    `;

    const inputLine = document.createElement('div');
    inputLine.style.cssText = `
      display: flex;
      padding: 4px 8px;
      background: #ffffff;
      border-top: 1px solid #e0e0e0;
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

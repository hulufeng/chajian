/**
 * BubaiCode 终端服务
 * 基于 node-pty 实现真实的伪终端
 * 支持 Windows PowerShell / cmd / bash
 */

const os = require('os');
const path = require('path');
const guard = require('./terminal-guard');
const audit = require('./audit-store');
const { createKillableTasks } = require('../packages/engine/killable-tasks.js');
const { killProcessTree } = require('./kill-tree.js');

class TerminalService {
  constructor() {
    this.terminals = new Map();
    this.nextId = 1;
    this.pty = null;
    // 一次性命令（executeCommand）的可中止登记：只有带 cancelTag 的（编译/烧录）才进来了，
    // 终端里用户自己敲的长跑命令不归它管——点「取消编译」不该把无关 shell 一起杀掉。
    this.execTasks = createKillableTasks({
      kill: killProcessTree,
      onError: (e) => console.warn('[TerminalService] 取消执行失败:', (e && e.message) || e)
    });
    
    // 尝试加载 node-pty
    try {
      this.pty = require('node-pty');
      console.log('[TerminalService] node-pty 加载成功');
    } catch (e) {
      console.warn('[TerminalService] node-pty 加载失败，将使用降级模式:', e.message);
      this.pty = null;
    }
  }

  /**
   * 获取默认 shell
   */
  getDefaultShell() {
    const platform = os.platform();
    if (platform === 'win32') {
      // Windows: 优先使用 PowerShell，其次 cmd
      const powershellPath = path.join(
        process.env.windir || 'C:\\Windows',
        'System32',
        'WindowsPowerShell',
        'v1.0',
        'powershell.exe'
      );
      return powershellPath;
    } else if (platform === 'darwin') {
      // macOS: 使用 zsh 或 bash
      return process.env.SHELL || '/bin/zsh';
    } else {
      // Linux: 使用 bash
      return process.env.SHELL || '/bin/bash';
    }
  }

  /**
   * 创建新终端
   * @param {Object} options - 终端选项
   * @param {string} options.shell - shell 路径
   * @param {string} options.cwd - 工作目录
   * @param {number} options.cols - 列数
   * @param {number} options.rows - 行数
   * @param {Object} options.env - 环境变量
   * @returns {Object} 终端信息
   */
  createTerminal(options = {}) {
    const id = 'term_' + (this.nextId++);
    const shell = options.shell || this.getDefaultShell();
    const cwd = options.cwd || process.cwd();
    const cols = options.cols || 80;
    const rows = options.rows || 24;
    const env = {
      ...process.env,
      ...options.env,
      TERM: 'xterm-256color',
      COLORTERM: 'truecolor',
      // 中文 Windows 乱码治本：子进程强制 UTF-8（对齐参考基线 terminal-exec UTF8_CHILD_ENV）
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8'
    };

    let ptyProcess = null;
    let fallbackProcess = null;

    if (this.pty) {
      // 使用 node-pty 创建真实伪终端
      try {
        ptyProcess = this.pty.spawn(shell, [], {
          name: 'xterm-256color',
          cols: cols,
          rows: rows,
          cwd: cwd,
          env: env
        });
        console.log(`[TerminalService] 创建终端 ${id}: ${shell} (node-pty)`);
      } catch (e) {
        console.error(`[TerminalService] node-pty 创建终端失败:`, e.message);
        ptyProcess = null;
      }
    }

    // 降级模式：使用 child_process
    if (!ptyProcess) {
      const { spawn } = require('child_process');
      const shellName = path.basename(shell);
      
      if (shellName.includes('powershell')) {
        fallbackProcess = spawn(shell, ['-NoLogo', '-NoExit'], {
          cwd: cwd,
          env: env,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } else if (shellName.includes('cmd')) {
        fallbackProcess = spawn(shell, [], {
          cwd: cwd,
          env: env,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      } else {
        fallbackProcess = spawn(shell, [], {
          cwd: cwd,
          env: env,
          stdio: ['pipe', 'pipe', 'pipe']
        });
      }
      
      console.log(`[TerminalService] 创建终端 ${id}: ${shell} (降级模式)`);
    }

    const terminal = {
      id: id,
      shell: shell,
      cwd: cwd,
      cols: cols,
      rows: rows,
      ptyProcess: ptyProcess,
      fallbackProcess: fallbackProcess,
      listeners: {
        data: [],
        exit: []
      },
      buffer: ''
    };

    // 绑定数据输出事件
    if (ptyProcess) {
      ptyProcess.onData((data) => {
        terminal.buffer += data;
        terminal.listeners.data.forEach(fn => {
          try { fn(data); } catch (e) { console.error('终端数据监听器错误:', e); }
        });
      });

      ptyProcess.onExit(({ exitCode, signal }) => {
        terminal.listeners.exit.forEach(fn => {
          try { fn({ exitCode, signal }); } catch (e) { console.error('终端退出监听器错误:', e); }
        });
        this.terminals.delete(id);
      });
    } else if (fallbackProcess) {
      fallbackProcess.stdout.on('data', (data) => {
        const text = data.toString();
        terminal.buffer += text;
        terminal.listeners.data.forEach(fn => {
          try { fn(text); } catch (e) { console.error('终端数据监听器错误:', e); }
        });
      });

      fallbackProcess.stderr.on('data', (data) => {
        const text = data.toString();
        terminal.buffer += text;
        terminal.listeners.data.forEach(fn => {
          try { fn(text); } catch (e) { console.error('终端数据监听器错误:', e); }
        });
      });

      fallbackProcess.on('exit', (exitCode, signal) => {
        terminal.listeners.exit.forEach(fn => {
          try { fn({ exitCode, signal }); } catch (e) { console.error('终端退出监听器错误:', e); }
        });
        this.terminals.delete(id);
      });
    }

    this.terminals.set(id, terminal);
    return { id, shell, cwd, cols, rows };
  }

  /**
   * 向终端写入数据
   * @param {string} id - 终端 ID
   * @param {string} data - 要写入的数据
   */
  write(id, data) {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      throw new Error(`终端 ${id} 不存在`);
    }

    if (terminal.ptyProcess) {
      terminal.ptyProcess.write(data);
    } else if (terminal.fallbackProcess) {
      terminal.fallbackProcess.stdin.write(data);
    }
  }

  /**
   * 调整终端大小
   * @param {string} id - 终端 ID
   * @param {number} cols - 列数
   * @param {number} rows - 行数
   */
  resize(id, cols, rows) {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      throw new Error(`终端 ${id} 不存在`);
    }

    terminal.cols = cols;
    terminal.rows = rows;

    if (terminal.ptyProcess) {
      try {
        terminal.ptyProcess.resize(cols, rows);
      } catch (e) {
        console.error('调整终端大小失败:', e);
      }
    }
  }

  /**
   * 获取终端缓冲区内容
   * @param {string} id - 终端 ID
   * @returns {string} 缓冲区内容
   */
  getBuffer(id) {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      throw new Error(`终端 ${id} 不存在`);
    }
    return terminal.buffer;
  }

  /**
   * 清除终端缓冲区
   * @param {string} id - 终端 ID
   */
  clearBuffer(id) {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      throw new Error(`终端 ${id} 不存在`);
    }
    terminal.buffer = '';
  }

  /**
   * 杀死终端
   * @param {string} id - 终端 ID
   */
  kill(id) {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      return;
    }

    if (terminal.ptyProcess) {
      try {
        terminal.ptyProcess.kill();
      } catch (e) {
        console.error('杀死终端失败:', e);
      }
    } else if (terminal.fallbackProcess) {
      try {
        terminal.fallbackProcess.kill();
      } catch (e) {
        console.error('杀死终端失败:', e);
      }
    }

    this.terminals.delete(id);
  }

  /**
   * 注册数据监听器
   * @param {string} id - 终端 ID
   * @param {Function} callback - 回调函数
   */
  onData(id, callback) {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      throw new Error(`终端 ${id} 不存在`);
    }
    terminal.listeners.data.push(callback);
  }

  /**
   * 注册退出监听器
   * @param {string} id - 终端 ID
   * @param {Function} callback - 回调函数
   */
  onExit(id, callback) {
    const terminal = this.terminals.get(id);
    if (!terminal) {
      throw new Error(`终端 ${id} 不存在`);
    }
    terminal.listeners.exit.push(callback);
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
        shell: terminal.shell,
        cwd: terminal.cwd,
        cols: terminal.cols,
        rows: terminal.rows
      });
    });
    return list;
  }

  /**
   * 执行命令并返回结果（一次性执行）
   * @param {string} command - 要执行的命令
   * @param {string} cwd - 工作目录
   * @param {number} timeout - 超时时间（毫秒）
   * @param {Object} opts - 选项 { force: boolean, cancelTag: string } force=true 表示用户已确认高风险命令；
   *                        cancelTag 给这次执行挂一个可取消的标签（如「编译」），见 cancelExecutions
   * @returns {Promise<Object>} 执行结果（blocked: 'deny'|'confirm' 表示被护栏拦截）
   */
  async executeCommand(command, cwd = process.cwd(), timeout = 30000, opts = {}) {
    const { exec } = require('child_process');

    // ===== 安全护栏（对齐参考基线 terminal-exec 三层防线，2026-09-13）=====
    const verdict = guard.checkCommand(command);
    if (verdict.verdict === 'deny') {
      const msg = `危险命令已被安全策略拦截：${verdict.reason}（命令未执行）`;
      console.warn(`[TerminalGuard] DENY: ${command}`);
      return { success: false, blocked: 'deny', exitCode: 1, stdout: '', stderr: '', error: msg, guardReason: verdict.reason };
    }
    if (verdict.verdict === 'confirm' && opts.force !== true) {
      const msg = `高风险命令需用户确认：${verdict.reason}（命令未执行，确认后放行）`;
      console.warn(`[TerminalGuard] CONFIRM: ${command}`);
      return { success: false, blocked: 'confirm', exitCode: 1, stdout: '', stderr: '', error: msg, guardReason: verdict.reason };
    }
    
    return new Promise((resolve, reject) => {
      const options = {
        cwd: cwd,
        timeout: timeout,
        maxBuffer: 1024 * 1024,
        // 原始字节输出 + 智能双解码（UTF-8 严格 → 失败回退 GBK，中文 Windows 乱码根治）
        encoding: 'buffer',
        env: {
          ...process.env,
          TERM: 'xterm-256color',
          PYTHONUTF8: '1',
          PYTHONIOENCODING: 'utf-8'
        }
      };

      const tag = typeof opts.cancelTag === 'string' ? opts.cancelTag : '';
      let taskId = 0;
      const child = exec(command, options, (error, stdoutBuf, stderrBuf) => {
        const stdout = guard.decodeOutput(stdoutBuf);
        const stderr = guard.decodeOutput(stderrBuf);
        const cancelled = taskId > 0 && this.execTasks.isCancelled(taskId);
        if (taskId > 0) this.execTasks.end(taskId);
        if (cancelled) {
          // 被「取消」杀掉的进程 error 一定非空（信号退出），不先分流就会报成「命令失败」，
          // 上层还会顺势唤起 AI 诊断根因——用户取消一次，等于凭空多一轮误诊。
          resolve({ success: false, cancelled: true, exitCode: -1, stdout, stderr, error: tag + '已取消' });
        } else if (error) {
          resolve({
            success: false,
            exitCode: error.code || 1,
            stdout: stdout,
            stderr: stderr,
            error: error.message
          });
        } else {
          resolve({
            success: true,
            exitCode: 0,
            stdout: stdout,
            stderr: stderr
          });
        }
      });
      // child 的 pid 在 exec() 返回时就已确定，登记必须紧跟其后（回调至少晚一个 tick）
      if (tag) taskId = this.execTasks.begin(tag, child);
    });
  }

  /**
   * 取消正在跑的一次性命令（编译/烧录走这里，pty 终端不受影响）。
   * @param {string} [tag] 只取消指定标签；不传则全取消
   * @returns {Array<{id:number,tag:string}>} 被取消的任务
   */
  cancelExecutions(tag) {
    return this.execTasks.cancel(tag);
  }

  /**
   * 销毁所有终端
   */
  destroyAll() {
    this.terminals.forEach((terminal, id) => {
      this.kill(id);
    });
    this.terminals.clear();
  }
}

// 导出单例
let instance = null;
function getTerminalService() {
  if (!instance) {
    instance = new TerminalService();
  }
  return instance;
}

module.exports = {
  TerminalService,
  getTerminalService
};

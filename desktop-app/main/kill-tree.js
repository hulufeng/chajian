// 杀掉一个 child 连同它的整棵子进程树。
//
// 为什么单独一份：arduino-cli 自己会派生 xtensa-esp32-elf-g++ / avr-gcc 等一大串子孙，
// 只杀直接 child = 编译器继续在后台跑完，端口与临时目录被占着，用户看到的还是「取消不了」。
// 主进程 execFile 与终端服务 exec 两条出站都要用它，写两处迟早漂移。
'use strict';

const { execFile } = require('child_process');

function killProcessTree(child) {
  if (!child || !child.pid) return false;
  if (process.platform === 'win32') {
    // 必须异步：同步 execSync('taskkill ...') 会与「被杀子进程的管道关闭」互相等待，把主进程卡死
    // （同款坑见 main/index.js 里停 llama-server 的注释）。杀不掉就算了——child 可能已自然退出。
    try {
      execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 8000 }, () => {});
      return true;
    } catch (e) { return false; }
  }
  try { child.kill('SIGKILL'); return true; } catch (e) { return false; }
}

module.exports = { killProcessTree };

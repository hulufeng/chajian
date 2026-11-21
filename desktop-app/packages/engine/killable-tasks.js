// 可中止任务登记表（纯逻辑，杀进程的动作由调用方注入）
//
// 为什么要有它：arduino-cli 编译/烧录一跑就是几十秒，此前没有任何办法停下它——「能不能取消」
// 取决于是否记得住那个 child。编译出站口有两处（主进程 execFile、终端服务 exec），
// 各写一份登记迟早漂移（谁清了标志、谁漏了 end 都会变成「点了取消但杀错进程」），
// 所以两边共用这一份实现；杀进程本身通过 deps.kill 注入，便于单测真跑。
'use strict';

function createKillableTasks(deps) {
  const d = deps || {};
  const kill = typeof d.kill === 'function' ? d.kill : function () {};
  const onError = typeof d.onError === 'function' ? d.onError : function () {};
  const tasks = new Map();
  let seq = 0;

  return {
    // 登记一个正在跑的 child，返回句柄 id；调用方在 child 结束时必须 end(id)。
    begin(tag, child) {
      const id = ++seq;
      tasks.set(id, { id: id, tag: String(tag || ''), child: child, cancelled: false });
      return id;
    },
    end(id) { return tasks.delete(id); },
    // 回调里用它区分「被我杀的」与「自己挂的」：前者要报「已取消」，后者才是真失败。
    isCancelled(id) {
      const t = tasks.get(id);
      return !!(t && t.cancelled);
    },
    size() { return tasks.size; },
    list() {
      return Array.from(tasks.values(), function (t) { return { id: t.id, tag: t.tag, cancelled: t.cancelled }; });
    },
    // 取消（可指定 tag，如只停编译不停烧录）：返回被取消的任务清单。
    // 已标记的不重复杀——用户连点两次「取消」不该把后来接手的进程也捎上。
    cancel(tag) {
      const want = tag == null || tag === '' ? null : String(tag);
      const killed = [];
      tasks.forEach(function (t) {
        if (want !== null && t.tag !== want) return;
        if (t.cancelled) return;
        t.cancelled = true;
        killed.push({ id: t.id, tag: t.tag });
        try { kill(t.child, t); } catch (e) { onError(e, t); }
      });
      return killed;
    }
  };
}

module.exports = { createKillableTasks };

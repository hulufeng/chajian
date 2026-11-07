// AI 供应商 API Key 内联校验（对齐 ChipCode validateKey）
// 复用现有 window.BubaiCode.ai.checkConnection（main 侧真实打端点验证 Key），前端加绿/红反馈。
(function () {
  function debounce(fn, ms) {
    var t;
    return function () {
      var ctx = this, args = arguments;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(ctx, args); }, ms);
    };
  }

  function mkTip(input) {
    var tip = input.parentNode.querySelector('.vkey-tip');
    if (!tip) {
      tip = document.createElement('div');
      tip.className = 'vkey-tip';
      input.parentNode.appendChild(tip);
    }
    return tip;
  }

  function setStatus(input, ok, msg) {
    var tip = mkTip(input);
    input.style.borderColor = ok === true ? '#52C41A' : (ok === false ? '#ef4444' : '');
    if (ok === null) { tip.style.display = 'none'; return; }
    tip.style.display = 'block';
    tip.style.color = ok ? '#52C41A' : '#ef4444';
    tip.textContent = (ok ? 'Key 有效' : '校验失败') + (msg ? ' · ' + msg : '');
  }

  function buildConfig(input) {
    if (input.id === 'byok-key') {
      var active = document.querySelector('#byok-chips .byok-chip.active');
      var prov = active ? active.dataset.provider : 'custom';
      var base = document.getElementById('byok-baseurl');
      var model = document.getElementById('byok-model');
      return { provider: 'custom', apiKey: input.value, baseURL: base ? base.value : '', model: model ? model.value : '', _chip: prov };
    }
    if (input.id === 'ai-apikey') {
      var p = document.getElementById('ai-provider');
      var b = document.getElementById('ai-baseurl');
      var m = document.getElementById('ai-model');
      return { provider: p ? p.value : 'custom', apiKey: input.value, baseURL: b ? b.value : '', model: m ? m.value : '' };
    }
    if (input.id === 'custom-apikey') {
      var cb = document.getElementById('custom-baseurl');
      var cm = document.getElementById('custom-model');
      return { provider: 'custom', apiKey: input.value, baseURL: cb ? cb.value : '', model: cm ? cm.value : '' };
    }
    return null;
  }

  function friendly(err) {
    var s = String(err || '');
    if (/401|unauthorized|invalid/i.test(s)) return '认证失败：API Key 无效';
    if (/ECONNREFUSED/i.test(s)) return '服务未启动 / 地址错误';
    if (/ETIMEDOUT|timeout/i.test(s)) return '连接超时';
    if (/ENOTFOUND|getaddrinfo|DNS/i.test(s)) return '域名无法解析';
    return s.slice(0, 80);
  }

  function attach(input) {
    if (!input || input._vkeyAttached) return;
    input._vkeyAttached = true;
    var run = debounce(function () {
      var key = input.value.trim();
      if (key.length < 8) { setStatus(input, null); return; }
      var cfg = buildConfig(input);
      if (!cfg) return;
      setStatus(input, null);
      if (window.BubaiCode && window.BubaiCode.ai && typeof window.BubaiCode.ai.checkConnection === 'function') {
        window.BubaiCode.ai.checkConnection(cfg).then(function (res) {
          if (!res || !res.success) setStatus(input, false, friendly(res && res.error));
          else setStatus(input, true, res.model ? res.model : '');
        }).catch(function (e) {
          setStatus(input, false, friendly(e && e.message));
        });
      }
    }, 600);
    input.addEventListener('input', run);
  }

  function init() {
    ['byok-key', 'ai-apikey', 'custom-apikey'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) attach(el);
    });
    if (window.MutationObserver) {
      var mo = new MutationObserver(function () {
        ['byok-key', 'ai-apikey', 'custom-apikey'].forEach(function (id) {
          var el = document.getElementById(id);
          if (el) attach(el);
        });
      });
      mo.observe(document.body, { childList: true, subtree: true });
    }
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();

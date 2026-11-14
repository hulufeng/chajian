// AI 语音输入（STT）——对齐参考基线 transcribe/cancelTranscribe。
// 现有 #voice-btn 按钮此前未接线（注释：「功能未实现，点了没反应」），本模块补齐：
// 点击开始/停止录音，使用 Web Speech API(SpeechRecognition/webkitSpeechRecognition)，
// 实时把识别文本填入当前可见的 AI 输入框，并标记录音态（红色 + 脉冲）。
(function () {
  function getRecognition() {
    return window.SpeechRecognition || window.webkitSpeechRecognition || null;
  }

  // 目标：当前可见的 AI 输入框（欢迎页与激活态可能各有一个 .ai-input-textarea）
  function getActiveInput() {
    var inputs = document.querySelectorAll('.ai-input-textarea');
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].offsetParent !== null) return inputs[i];
    }
    return inputs[0] || null;
  }

  function autoResize(el) {
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 160) + 'px';
  }

  function init() {
    var btn = document.getElementById('voice-btn');
    if (!btn) return;
    // 后端 STT（window.BubaiCode.stt）已配置时由 app.js 的 sttToggle 接管，避免双绑定冲突
    if (window.BubaiCode && window.BubaiCode.stt) return;
    var SR = getRecognition();

    if (!SR) {
      btn.title = '当前环境不支持语音输入（Web Speech API）';
      btn.style.opacity = '0.4';
      btn.style.cursor = 'not-allowed';
      return;
    }

    var recog = null;
    var recording = false;

    function setRec(on) {
      recording = on;
      btn.classList.toggle('recording', on);
      btn.style.background = on ? '#ef4444' : '';
      btn.style.color = on ? '#ffffff' : '';
      btn.title = on ? '停止录音' : '语音输入（点击开始/停止录音）';
    }

    function stop() {
      if (recog) {
        try { recog.stop(); } catch (e) {}
      }
      setRec(false);
    }

    btn.addEventListener('click', function (e) {
      e.preventDefault();
      if (!SR) return;

      if (recog && recording) {
        stop();
        return;
      }

      try {
        var inp = getActiveInput();
        if (inp) inp.dataset.voiceBase = '';

        recog = new SR();
        recog.lang = 'zh-CN';
        recog.interimResults = true;
        recog.continuous = true;

        recog.onresult = function (ev) {
          var finalText = '';
          var interim = '';
          for (var i = ev.resultIndex; i < ev.results.length; i++) {
            var r = ev.results[i];
            if (r.isFinal) finalText += r[0].transcript;
            else interim += r[0].transcript;
          }
          var el = getActiveInput();
          if (!el) return;
          if (finalText) el.dataset.voiceBase = (el.dataset.voiceBase || '') + finalText;
          el.value = (el.dataset.voiceBase || '') + interim;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          autoResize(el);
        };

        recog.onerror = function () { stop(); };
        recog.onend = function () {
          // 仍在录音时浏览器自动结束（如静音），自动续录
          if (recording) {
            try { recog.start(); } catch (e) { setRec(false); }
          }
        };

        recog.start();
        setRec(true);
      } catch (err) {
        stop();
      }
    });
  }

  if (document.readyState !== 'loading') init();
  else document.addEventListener('DOMContentLoaded', init);
})();

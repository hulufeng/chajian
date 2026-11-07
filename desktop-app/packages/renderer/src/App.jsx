import React, { useState, useEffect } from 'react';
import { css } from '@emotion/react';

const appStyle = css`
  display: flex;
  height: 100vh;
  background: #1e1e1e;
  color: #e0e0e0;
  font-family: 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', sans-serif;
`;

const sidebarStyle = css`
  width: 240px;
  background: #252526;
  border-right: 1px solid #3c3c3c;
  padding: 16px;
  flex-shrink: 0;
`;

const mainStyle = css`
  flex: 1;
  display: flex;
  flex-direction: column;
`;

const chatAreaStyle = css`
  flex: 1;
  padding: 20px;
  overflow-y: auto;
`;

const inputBarStyle = css`
  padding: 16px;
  border-top: 1px solid #3c3c3c;
  display: flex;
  gap: 8px;
`;

const inputStyle = css`
  flex: 1;
  background: #2d2d2d;
  border: 1px solid #3c3c3c;
  color: #e0e0e0;
  padding: 10px 14px;
  border-radius: 8px;
  font-size: 14px;
  outline: none;
  &:focus { border-color: #059669; }
`;

const sendBtnStyle = css`
  background: #059669;
  color: white;
  border: none;
  padding: 10px 20px;
  border-radius: 8px;
  cursor: pointer;
  font-size: 14px;
  &:hover { background: #047857; }
`;

const msgStyle = css`
  margin-bottom: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  max-width: 80%;
  &.user { background: #059669; color: white; margin-left: auto; }
  &.ai { background: #2d2d2d; }
`;

export default function App() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState('');

  useEffect(() => {
    // 监听工具链进度
    if (window.bubaicode?.toolchain?.onProgress) {
      window.bubaicode.toolchain.onProgress((data) => {
        console.log('toolchain progress:', data);
      });
    }
  }, []);

  const send = async () => {
    if (!input.trim()) return;
    const userMsg = { role: 'user', content: input };
    setMessages(prev => [...prev, userMsg]);
    setInput('');
    // TODO: 调用 AI
    setMessages(prev => [...prev, { role: 'ai', content: '（React 渲染进程脚手架，AI 对接待迁移）' }]);
  };

  return (
    <div css={appStyle}>
      <div css={sidebarStyle}>
        <h2 style={{ margin: '0 0 16px', fontSize: 16, color: '#059669' }}>BubaiCode</h2>
        <div style={{ fontSize: 12, color: '#888' }}>React + Vite + emotion</div>
      </div>
      <div css={mainStyle}>
        <div css={chatAreaStyle}>
          {messages.map((m, i) => (
            <div key={i} css={msgStyle} className={m.role}>
              {m.content}
            </div>
          ))}
        </div>
        <div css={inputBarStyle}>
          <input css={inputStyle} value={input} onChange={e => setInput(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && send()} placeholder="描述你想做的事情..." />
          <button css={sendBtnStyle} onClick={send}>发送</button>
        </div>
      </div>
    </div>
  );
}

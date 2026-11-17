// BubaiCode 管理后台交互逻辑

// ============ 数据存储 ============
const STORAGE_KEYS = {
  users: 'BubaiCode_admin_users',
  apis: 'BubaiCode_admin_apis',
  plugins: 'BubaiCode_admin_plugins',
  sessions: 'BubaiCode_admin_sessions',
  logs: 'BubaiCode_admin_logs',
  settings: 'BubaiCode_admin_settings',
  auth: 'BubaiCode_admin_auth'
};

// 默认数据
const DEFAULT_USERS = [
  { id: 1, username: 'admin', email: 'admin@BubaiCode.com', password: 'admin123', role: 'admin', active: true, createdAt: '2026-01-01', lastLogin: '2026-09-05 10:30', apiCalls: 12580 },
  { id: 2, username: 'developer', email: 'dev@BubaiCode.com', password: 'dev123456', role: 'user', active: true, createdAt: '2026-02-15', lastLogin: '2026-09-04 16:20', apiCalls: 8432 },
  { id: 3, username: 'tester', email: 'test@BubaiCode.com', password: 'test123456', role: 'user', active: true, createdAt: '2026-03-20', lastLogin: '2026-09-03 09:15', apiCalls: 3210 },
  { id: 4, username: 'guest', email: 'guest@BubaiCode.com', password: 'guest123', role: 'guest', active: false, createdAt: '2026-04-10', lastLogin: '2026-08-20 14:00', apiCalls: 156 }
];

const DEFAULT_APIS = [
  { id: 1, provider: 'deepseek', name: 'DeepSeek V4', endpoint: 'https://api.deepseek.com/v1', apiKey: 'sk-deepseek-xxxxxxxxxxxx', model: 'deepseek-chat', active: true, remark: '主力模型', usage: 45230 },
  { id: 2, provider: 'qwen', name: '通义千问 Qwen', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', apiKey: 'sk-qwen-xxxxxxxxxxxx', model: 'qwen-max', active: true, remark: '备用模型', usage: 23100 },
  { id: 3, provider: 'minimax', name: 'MiniMax M3', endpoint: 'https://api.minimax.chat/v1', apiKey: 'sk-minimax-xxxxxxxxxxxx', model: 'MiniMax-M3', active: true, remark: '视觉模型', usage: 12800 },
  { id: 4, provider: 'openai', name: 'OpenAI GPT', endpoint: 'https://api.openai.com/v1', apiKey: 'sk-openai-xxxxxxxxxxxx', model: 'gpt-4o', active: false, remark: '海外模型', usage: 5600 }
];

const DEFAULT_PLUGINS = [
  { id: 1, name: 'Git 集成', version: 'v1.2.0', icon: '📦', description: '提供 Git 版本控制集成，支持提交、分支管理、差异对比等功能。', author: 'BubaiCode Team', active: true, installedAt: '2026-06-15', capabilities: ['版本控制', '代码审查'] },
  { id: 2, name: 'Docker 支持', version: 'v0.9.3', icon: '🐳', description: 'Docker 容器管理插件，支持镜像构建、容器运行、日志查看。', author: 'Community', active: true, installedAt: '2026-07-20', capabilities: ['容器管理', 'DevOps'] },
  { id: 3, name: '数据库浏览器', version: 'v2.1.0', icon: '🗄️', description: '支持 MySQL、PostgreSQL、SQLite、MongoDB 等多种数据库的浏览和查询。', author: 'BubaiCode Team', active: false, installedAt: '2026-05-10', capabilities: ['数据库', '数据查询'] },
  { id: 4, name: 'Markdown 预览', version: 'v1.0.5', icon: '📝', description: '实时 Markdown 预览，支持数学公式、流程图、甘特图。', author: 'Community', active: true, installedAt: '2026-08-01', capabilities: ['文档', '预览'] },
  { id: 5, name: 'REST Client', version: 'v1.5.2', icon: '🌐', description: 'HTTP 请求测试工具，支持 REST API 调试、响应格式化、历史记录。', author: 'Community', active: false, installedAt: '2026-04-25', capabilities: ['API 调试', 'HTTP'] }
];

const DEFAULT_SESSIONS = [
  { id: 'sess_001', userId: 1, username: 'admin', title: 'ESP32 关灯控制器开发', messages: 42, tokens: 15600, createdAt: '2026-09-05 09:00', lastActive: '2026-09-05 10:45' },
  { id: 'sess_002', userId: 2, username: 'developer', title: 'Python 数据分析脚本', messages: 28, tokens: 9800, createdAt: '2026-09-04 14:30', lastActive: '2026-09-04 16:20' },
  { id: 'sess_003', userId: 1, username: 'admin', title: '网站前端重构', messages: 65, tokens: 23400, createdAt: '2026-09-03 10:00', lastActive: '2026-09-03 18:30' },
  { id: 'sess_004', userId: 3, username: 'tester', title: '测试用例生成', messages: 15, tokens: 5200, createdAt: '2026-09-02 11:00', lastActive: '2026-09-02 12:15' }
];

const DEFAULT_LOGS = [
  { time: '2026-09-05 10:45:23', level: 'info', message: '用户 admin 登录成功' },
  { time: '2026-09-05 10:30:15', level: 'info', message: 'API 调用成功: deepseek-chat, tokens: 2340' },
  { time: '2026-09-05 10:15:08', level: 'warn', message: 'API 调用限流: 已达每分钟 60 次上限' },
  { time: '2026-09-05 10:00:00', level: 'info', message: '插件 Git 集成 已启用' },
  { time: '2026-09-05 09:45:30', level: 'error', message: 'API 调用失败: 连接超时 (endpoint: api.openai.com)' },
  { time: '2026-09-05 09:30:12', level: 'info', message: '用户 developer 登录成功' },
  { time: '2026-09-05 09:15:00', level: 'debug', message: '会话 sess_001 创建, 用户: admin' },
  { time: '2026-09-05 09:00:00', level: 'info', message: '系统启动完成, 版本 v1.0.0' }
];

const DEFAULT_SETTINGS = {
  appName: 'BubaiCode',
  version: 'v1.0.0',
  language: 'zh-CN',
  theme: 'dark',
  enableAuth: true,
  enableAudit: true,
  sessionTimeout: 30,
  minPassword: 8,
  defaultProvider: 'deepseek',
  thinkingLevel: 'standard',
  maxTokens: 8192,
  enableCache: true
};

// ============ 状态 ============
let currentUser = null;
let currentPage = 'dashboard';
let editingUserId = null;
let editingApiId = null;

// ============ 初始化 ============
document.addEventListener('DOMContentLoaded', () => {
  initStorage();
  checkAuth();
  bindEvents();
});

// 初始化存储（如果没有数据则使用默认数据）
function initStorage() {
  if (!localStorage.getItem(STORAGE_KEYS.users)) localStorage.setItem(STORAGE_KEYS.users, JSON.stringify(DEFAULT_USERS));
  if (!localStorage.getItem(STORAGE_KEYS.apis)) localStorage.setItem(STORAGE_KEYS.apis, JSON.stringify(DEFAULT_APIS));
  if (!localStorage.getItem(STORAGE_KEYS.plugins)) localStorage.setItem(STORAGE_KEYS.plugins, JSON.stringify(DEFAULT_PLUGINS));
  if (!localStorage.getItem(STORAGE_KEYS.sessions)) localStorage.setItem(STORAGE_KEYS.sessions, JSON.stringify(DEFAULT_SESSIONS));
  if (!localStorage.getItem(STORAGE_KEYS.logs)) localStorage.setItem(STORAGE_KEYS.logs, JSON.stringify(DEFAULT_LOGS));
  if (!localStorage.getItem(STORAGE_KEYS.settings)) localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(DEFAULT_SETTINGS));
}

function getData(key) {
  return JSON.parse(localStorage.getItem(key) || '[]');
}

function setData(key, data) {
  localStorage.setItem(key, JSON.stringify(data));
}

function addLog(level, message) {
  const logs = getData(STORAGE_KEYS.logs);
  const now = new Date();
  const time = now.toISOString().replace('T', ' ').substring(0, 19);
  logs.unshift({ time, level, message });
  if (logs.length > 500) logs.pop();
  setData(STORAGE_KEYS.logs, logs);
}

// ============ 认证 ============
function checkAuth() {
  const auth = localStorage.getItem(STORAGE_KEYS.auth);
  if (auth) {
    currentUser = JSON.parse(auth);
    showMainApp();
  } else {
    showLoginPage();
  }
}

function showLoginPage() {
  document.getElementById('loginPage').classList.remove('hidden');
  document.getElementById('mainApp').classList.add('hidden');
}

function showMainApp() {
  document.getElementById('loginPage').classList.add('hidden');
  document.getElementById('mainApp').classList.remove('hidden');
  document.getElementById('currentUser').textContent = currentUser.username;
  loadDashboard();
}

function login(username, password) {
  const users = getData(STORAGE_KEYS.users);
  const user = users.find(u => u.username === username && u.password === password);
  if (user) {
    if (!user.active) {
      showToast('用户已被禁用，请联系管理员', 'error');
      return false;
    }
    currentUser = user;
    localStorage.setItem(STORAGE_KEYS.auth, JSON.stringify(user));
    addLog('info', `用户 ${username} 登录成功`);
    showToast('登录成功', 'success');
    showMainApp();
    return true;
  }
  showToast('用户名或密码错误', 'error');
  return false;
}

function logout() {
  localStorage.removeItem(STORAGE_KEYS.auth);
  currentUser = null;
  addLog('info', '用户退出登录');
  showToast('已退出登录', 'info');
  showLoginPage();
}

// ============ 事件绑定 ============
function bindEvents() {
  // 登录表单
  document.getElementById('loginForm').addEventListener('submit', (e) => {
    e.preventDefault();
    const username = document.getElementById('loginUsername').value;
    const password = document.getElementById('loginPassword').value;
    login(username, password);
  });

  // 退出登录
  document.getElementById('logoutBtn').addEventListener('click', logout);

  // 导航
  document.querySelectorAll('.nav-item').forEach(item => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      const page = item.dataset.page;
      switchPage(page);
    });
  });

  // 插件来源切换
  document.querySelectorAll('input[name="pluginSource"]').forEach(radio => {
    radio.addEventListener('change', (e) => {
      const source = e.target.value;
      document.getElementById('pluginMarketField').classList.toggle('hidden', source !== 'market');
      document.getElementById('pluginUrlField').classList.toggle('hidden', source !== 'url');
      document.getElementById('pluginLocalField').classList.toggle('hidden', source !== 'local');
    });
  });
}

// ============ 页面切换 ============
function switchPage(page) {
  currentPage = page;
  document.querySelectorAll('.nav-item').forEach(item => {
    item.classList.toggle('active', item.dataset.page === page);
  });
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${page}`).classList.add('active');
  
  const titles = {
    dashboard: '仪表盘',
    users: '用户管理',
    api: 'API 配置',
    plugins: '插件管理',
    sessions: '会话管理',
    logs: '系统日志',
    settings: '系统设置'
  };
  document.getElementById('pageTitle').textContent = titles[page] || page;
  
  // 加载对应页面数据
  if (page === 'dashboard') loadDashboard();
  if (page === 'users') loadUsers();
  if (page === 'api') loadApis();
  if (page === 'plugins') loadPlugins();
  if (page === 'sessions') loadSessions();
  if (page === 'logs') loadLogs();
  if (page === 'settings') loadSettings();
}

// ============ 仪表盘 ============
function loadDashboard() {
  const users = getData(STORAGE_KEYS.users);
  const apis = getData(STORAGE_KEYS.apis);
  const plugins = getData(STORAGE_KEYS.plugins);
  const sessions = getData(STORAGE_KEYS.sessions);
  
  document.getElementById('statUsers').textContent = users.length;
  document.getElementById('statSessions').textContent = sessions.length;
  document.getElementById('statApis').textContent = apis.filter(a => a.active).length;
  document.getElementById('statPlugins').textContent = plugins.filter(p => p.active).length;
  
  // 最近活动
  const logs = getData(STORAGE_KEYS.logs).slice(0, 5);
  const activityHtml = logs.map(log => `
    <div class="activity-item">
      <div class="activity-avatar">${log.level === 'error' ? '❌' : log.level === 'warn' ? '⚠️' : '📌'}</div>
      <div class="activity-content">
        <p>${log.message}</p>
        <span class="time">${log.time}</span>
      </div>
    </div>
  `).join('');
  document.getElementById('recentActivity').innerHTML = activityHtml;
  
  // API 使用统计
  const activeApis = apis.filter(a => a.active);
  const maxUsage = Math.max(...activeApis.map(a => a.usage), 1);
  const colors = ['#4f46e5', '#06b6d4', '#10b981', '#f59e0b'];
  const usageHtml = activeApis.map((api, i) => `
    <div class="usage-item">
      <div class="usage-header">
        <span>${api.name}</span>
        <span>${api.usage.toLocaleString()} tokens</span>
      </div>
      <div class="usage-bar">
        <div class="usage-fill" style="width: ${(api.usage / maxUsage * 100).toFixed(1)}%; background: ${colors[i % colors.length]}"></div>
      </div>
    </div>
  `).join('');
  document.getElementById('apiUsage').innerHTML = usageHtml;
}

// ============ 用户管理 ============
function loadUsers() {
  const users = getData(STORAGE_KEYS.users);
  const search = document.getElementById('userSearch')?.value.toLowerCase() || '';
  const roleFilter = document.getElementById('userRoleFilter')?.value || '';
  
  let filtered = users;
  if (search) {
    filtered = filtered.filter(u => 
      u.username.toLowerCase().includes(search) || 
      u.email.toLowerCase().includes(search)
    );
  }
  if (roleFilter) {
    filtered = filtered.filter(u => u.role === roleFilter);
  }
  
  const html = filtered.map(user => `
    <tr>
      <td>
        <div class="user-cell">
          <div class="user-cell-avatar">${user.username.charAt(0).toUpperCase()}</div>
          <div class="user-cell-info">
            <span class="user-cell-name">${user.username}</span>
            <span class="user-cell-id">ID: ${user.id}</span>
          </div>
        </div>
      </td>
      <td>${user.email}</td>
      <td><span class="badge badge-${user.role}">${user.role === 'admin' ? '管理员' : user.role === 'user' ? '普通用户' : '访客'}</span></td>
      <td><span class="badge badge-${user.active ? 'active' : 'inactive'}">${user.active ? '启用' : '禁用'}</span></td>
      <td>${user.lastLogin || '从未登录'}</td>
      <td>${user.apiCalls?.toLocaleString() || 0}</td>
      <td>
        <div class="action-buttons">
          <button class="action-btn edit" onclick="editUser(${user.id})">编辑</button>
          <button class="action-btn delete" onclick="deleteUser(${user.id})">删除</button>
        </div>
      </td>
    </tr>
  `).join('');
  
  document.getElementById('userTableBody').innerHTML = html || '<tr><td colspan="7" style="text-align:center;padding:40px;color:#94a3b8">暂无用户数据</td></tr>';
}

function filterUsers() {
  loadUsers();
}

function editUser(id) {
  const users = getData(STORAGE_KEYS.users);
  const user = users.find(u => u.id === id);
  if (!user) return;
  
  editingUserId = id;
  document.getElementById('userModalTitle').textContent = '编辑用户';
  document.getElementById('userId').value = user.id;
  document.getElementById('userName').value = user.username;
  document.getElementById('userEmail').value = user.email;
  document.getElementById('userPassword').value = user.password;
  document.getElementById('userRole').value = user.role;
  document.getElementById('userActive').checked = user.active;
  showModal('userModal');
}

function saveUser() {
  const id = document.getElementById('userId').value;
  const username = document.getElementById('userName').value.trim();
  const email = document.getElementById('userEmail').value.trim();
  const password = document.getElementById('userPassword').value;
  const role = document.getElementById('userRole').value;
  const active = document.getElementById('userActive').checked;
  
  if (!username || !email || !password) {
    showToast('请填写必填项', 'error');
    return;
  }
  
  const users = getData(STORAGE_KEYS.users);
  
  if (id) {
    // 编辑
    const index = users.findIndex(u => u.id === parseInt(id));
    if (index !== -1) {
      users[index] = { ...users[index], username, email, password, role, active };
      addLog('info', `用户 ${username} 已更新`);
      showToast('用户更新成功', 'success');
    }
  } else {
    // 新增
    const newId = Math.max(...users.map(u => u.id), 0) + 1;
    const now = new Date().toISOString().split('T')[0];
    users.push({ id: newId, username, email, password, role, active, createdAt: now, lastLogin: null, apiCalls: 0 });
    addLog('info', `新用户 ${username} 已创建`);
    showToast('用户创建成功', 'success');
  }
  
  setData(STORAGE_KEYS.users, users);
  hideModal('userModal');
  loadUsers();
  editingUserId = null;
}

function deleteUser(id) {
  if (!confirm('确定要删除该用户吗？此操作不可恢复。')) return;
  const users = getData(STORAGE_KEYS.users);
  const user = users.find(u => u.id === id);
  const filtered = users.filter(u => u.id !== id);
  setData(STORAGE_KEYS.users, filtered);
  addLog('warn', `用户 ${user?.username} 已删除`);
  showToast('用户已删除', 'success');
  loadUsers();
}

// ============ API 配置管理 ============
const PROVIDER_ENDPOINTS = {
  deepseek: 'https://api.deepseek.com/v1',
  qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  minimax: 'https://api.minimax.chat/v1',
  openai: 'https://api.openai.com/v1',
  claude: 'https://api.anthropic.com/v1',
  ollama: 'http://localhost:11434/v1',
  custom: ''
};

const PROVIDER_ICONS = {
  deepseek: '🐋', qwen: '☁️', minimax: '🎵', openai: '🤖', claude: '🧠', ollama: '🦙', custom: '⚙️'
};

function loadApis() {
  const apis = getData(STORAGE_KEYS.apis);
  const search = document.getElementById('apiSearch')?.value.toLowerCase() || '';
  
  let filtered = apis;
  if (search) {
    filtered = filtered.filter(a => 
      a.name.toLowerCase().includes(search) || 
      a.provider.toLowerCase().includes(search) ||
      a.model.toLowerCase().includes(search)
    );
  }
  
  const html = filtered.map(api => `
    <div class="api-card ${api.active ? 'active' : ''}">
      <div class="api-card-header">
        <div class="api-provider">
          <div class="api-provider-icon">${PROVIDER_ICONS[api.provider] || '⚙️'}</div>
          <div class="api-provider-info">
            <h4>${api.name}</h4>
            <p>${api.provider}</p>
          </div>
        </div>
        <span class="api-status ${api.active ? 'active' : 'inactive'}">${api.active ? '已启用' : '已禁用'}</span>
      </div>
      <div class="api-details">
        <div class="api-detail-row">
          <span class="label">端点</span>
          <span class="value" title="${api.endpoint}">${api.endpoint.length > 30 ? api.endpoint.substring(0, 30) + '...' : api.endpoint}</span>
        </div>
        <div class="api-detail-row">
          <span class="label">模型</span>
          <span class="value">${api.model}</span>
        </div>
        <div class="api-detail-row">
          <span class="label">API Key</span>
          <span class="value">${api.apiKey.substring(0, 8)}...${api.apiKey.substring(api.apiKey.length - 4)}</span>
        </div>
        <div class="api-detail-row">
          <span class="label">用量</span>
          <span class="value">${api.usage?.toLocaleString() || 0} tokens</span>
        </div>
        ${api.remark ? `<div class="api-detail-row"><span class="label">备注</span><span class="value">${api.remark}</span></div>` : ''}
      </div>
      <div class="api-actions">
        <button class="action-btn edit" onclick="editApi(${api.id})">编辑</button>
        <button class="action-btn" onclick="toggleApi(${api.id})">${api.active ? '禁用' : '启用'}</button>
        <button class="action-btn delete" onclick="deleteApi(${api.id})">删除</button>
      </div>
    </div>
  `).join('');
  
  document.getElementById('apiGrid').innerHTML = html || '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#94a3b8">暂无 API 配置</div>';
}

function filterApis() {
  loadApis();
}

function updateApiEndpoint() {
  const provider = document.getElementById('apiProvider').value;
  document.getElementById('apiEndpoint').value = PROVIDER_ENDPOINTS[provider] || '';
}

function editApi(id) {
  const apis = getData(STORAGE_KEYS.apis);
  const api = apis.find(a => a.id === id);
  if (!api) return;
  
  editingApiId = id;
  document.getElementById('apiModalTitle').textContent = '编辑 API 配置';
  document.getElementById('apiId').value = api.id;
  document.getElementById('apiProvider').value = api.provider;
  document.getElementById('apiEndpoint').value = api.endpoint;
  document.getElementById('apiKey').value = api.apiKey;
  document.getElementById('apiModel').value = api.model;
  document.getElementById('apiRemark').value = api.remark || '';
  document.getElementById('apiActive').checked = api.active;
  showModal('apiModal');
}

function saveApi() {
  const id = document.getElementById('apiId').value;
  const provider = document.getElementById('apiProvider').value;
  const endpoint = document.getElementById('apiEndpoint').value.trim();
  const apiKey = document.getElementById('apiKey').value.trim();
  const model = document.getElementById('apiModel').value.trim();
  const remark = document.getElementById('apiRemark').value.trim();
  const active = document.getElementById('apiActive').checked;
  
  if (!endpoint || !apiKey || !model) {
    showToast('请填写必填项', 'error');
    return;
  }
  
  const apis = getData(STORAGE_KEYS.apis);
  const providerNames = { deepseek: 'DeepSeek', qwen: '通义千问', minimax: 'MiniMax', openai: 'OpenAI', claude: 'Claude', ollama: 'Ollama', custom: '自定义' };
  
  if (id) {
    const index = apis.findIndex(a => a.id === parseInt(id));
    if (index !== -1) {
      apis[index] = { ...apis[index], provider, endpoint, apiKey, model, remark, active, name: `${providerNames[provider]} ${model}` };
      addLog('info', `API 配置 ${apis[index].name} 已更新`);
      showToast('API 配置更新成功', 'success');
    }
  } else {
    const newId = Math.max(...apis.map(a => a.id), 0) + 1;
    apis.push({ id: newId, provider, name: `${providerNames[provider]} ${model}`, endpoint, apiKey, model, remark, active, usage: 0 });
    addLog('info', `新 API 配置 ${providerNames[provider]} 已创建`);
    showToast('API 配置创建成功', 'success');
  }
  
  setData(STORAGE_KEYS.apis, apis);
  hideModal('apiModal');
  loadApis();
  editingApiId = null;
}

function toggleApi(id) {
  const apis = getData(STORAGE_KEYS.apis);
  const api = apis.find(a => a.id === id);
  if (api) {
    api.active = !api.active;
    setData(STORAGE_KEYS.apis, apis);
    addLog('info', `API 配置 ${api.name} 已${api.active ? '启用' : '禁用'}`);
    showToast(`API 已${api.active ? '启用' : '禁用'}`, 'success');
    loadApis();
  }
}

function deleteApi(id) {
  if (!confirm('确定要删除该 API 配置吗？')) return;
  const apis = getData(STORAGE_KEYS.apis);
  const api = apis.find(a => a.id === id);
  const filtered = apis.filter(a => a.id !== id);
  setData(STORAGE_KEYS.apis, filtered);
  addLog('warn', `API 配置 ${api?.name} 已删除`);
  showToast('API 配置已删除', 'success');
  loadApis();
}

async function testApiConnection() {
  const endpoint = document.getElementById('apiEndpoint').value;
  const apiKey = document.getElementById('apiKey').value;
  
  if (!endpoint || !apiKey) {
    showToast('请先填写端点和 API Key', 'error');
    return;
  }
  
  showToast('正在测试连接...', 'info');
  
  // 模拟连接测试
  await new Promise(resolve => setTimeout(resolve, 1500));
  
  const success = Math.random() > 0.3;
  if (success) {
    showToast('连接测试成功！响应时间 128ms', 'success');
  } else {
    showToast('连接测试失败：超时，请检查网络和 API Key', 'error');
  }
}

// ============ 插件管理 ============
function loadPlugins() {
  const plugins = getData(STORAGE_KEYS.plugins);
  const search = document.getElementById('pluginSearch')?.value.toLowerCase() || '';
  const statusFilter = document.getElementById('pluginStatusFilter')?.value || '';
  
  let filtered = plugins;
  if (search) {
    filtered = filtered.filter(p => 
      p.name.toLowerCase().includes(search) || 
      p.description.toLowerCase().includes(search)
    );
  }
  if (statusFilter) {
    filtered = filtered.filter(p => statusFilter === 'active' ? p.active : !p.active);
  }
  
  const html = filtered.map(plugin => `
    <div class="plugin-card">
      <div class="plugin-header">
        <div class="plugin-icon">${plugin.icon}</div>
        <div class="plugin-info">
          <h4>${plugin.name}</h4>
          <span class="version">${plugin.version} · ${plugin.author}</span>
        </div>
      </div>
      <p class="plugin-desc">${plugin.description}</p>
      <div class="plugin-meta">
        <span>安装于 ${plugin.installedAt}</span>
        <label class="switch">
          <input type="checkbox" ${plugin.active ? 'checked' : ''} onchange="togglePlugin(${plugin.id})">
          <span class="switch-slider"></span>
        </label>
      </div>
      <div class="plugin-actions">
        <button class="action-btn" onclick="showPluginDetail(${plugin.id})">详情</button>
        <button class="action-btn delete" onclick="uninstallPlugin(${plugin.id})">卸载</button>
      </div>
    </div>
  `).join('');
  
  document.getElementById('pluginGrid').innerHTML = html || '<div style="grid-column:1/-1;text-align:center;padding:40px;color:#94a3b8">暂无插件</div>';
}

function filterPlugins() {
  loadPlugins();
}

function togglePlugin(id) {
  const plugins = getData(STORAGE_KEYS.plugins);
  const plugin = plugins.find(p => p.id === id);
  if (plugin) {
    plugin.active = !plugin.active;
    setData(STORAGE_KEYS.plugins, plugins);
    addLog('info', `插件 ${plugin.name} 已${plugin.active ? '启用' : '禁用'}`);
    showToast(`插件已${plugin.active ? '启用' : '禁用'}`, 'success');
  }
}

function installPlugin() {
  const source = document.querySelector('input[name="pluginSource"]:checked').value;
  let name, description;
  
  if (source === 'market') {
    const select = document.getElementById('pluginMarketSelect');
    const marketPlugins = {
      'git-integration': { name: 'Git 集成', desc: 'Git 版本控制集成' },
      'docker-support': { name: 'Docker 支持', desc: 'Docker 容器管理' },
      'database-explorer': { name: '数据库浏览器', desc: '多数据库浏览查询' },
      'markdown-preview': { name: 'Markdown 预览', desc: '实时 Markdown 预览' },
      'rest-client': { name: 'REST Client', desc: 'HTTP API 调试工具' }
    };
    const selected = marketPlugins[select.value];
    name = selected.name;
    description = selected.desc;
  } else if (source === 'url') {
    name = 'URL 安装插件';
    description = document.getElementById('pluginUrl').value;
  } else {
    name = '本地插件';
    description = document.getElementById('pluginFile')?.files[0]?.name || '本地文件';
  }
  
  const plugins = getData(STORAGE_KEYS.plugins);
  const newId = Math.max(...plugins.map(p => p.id), 0) + 1;
  const now = new Date().toISOString().split('T')[0];
  
  plugins.push({
    id: newId,
    name,
    version: 'v1.0.0',
    icon: '🧩',
    description,
    author: 'User',
    active: true,
    installedAt: now,
    capabilities: ['自定义']
  });
  
  setData(STORAGE_KEYS.plugins, plugins);
  addLog('info', `插件 ${name} 已安装`);
  showToast('插件安装成功', 'success');
  hideModal('pluginModal');
  loadPlugins();
}

function uninstallPlugin(id) {
  if (!confirm('确定要卸载该插件吗？插件配置将被删除。')) return;
  const plugins = getData(STORAGE_KEYS.plugins);
  const plugin = plugins.find(p => p.id === id);
  const filtered = plugins.filter(p => p.id !== id);
  setData(STORAGE_KEYS.plugins, filtered);
  addLog('warn', `插件 ${plugin?.name} 已卸载`);
  showToast('插件已卸载', 'success');
  loadPlugins();
}

function showPluginDetail(id) {
  const plugins = getData(STORAGE_KEYS.plugins);
  const plugin = plugins.find(p => p.id === id);
  if (plugin) {
    alert(`插件详情\n\n名称: ${plugin.name}\n版本: ${plugin.version}\n作者: ${plugin.author}\n安装时间: ${plugin.installedAt}\n状态: ${plugin.active ? '已启用' : '已禁用'}\n能力: ${plugin.capabilities?.join(', ') || '无'}\n\n描述: ${plugin.description}`);
  }
}

// ============ 会话管理 ============
function loadSessions() {
  const sessions = getData(STORAGE_KEYS.sessions);
  const search = document.getElementById('sessionSearch')?.value.toLowerCase() || '';
  
  let filtered = sessions;
  if (search) {
    filtered = filtered.filter(s => 
      s.title.toLowerCase().includes(search) || 
      s.username.toLowerCase().includes(search) ||
      s.id.toLowerCase().includes(search)
    );
  }
  
  const html = filtered.map(session => `
    <tr>
      <td><code>${session.id}</code></td>
      <td>${session.username}</td>
      <td>${session.title}</td>
      <td>${session.messages}</td>
      <td>${session.tokens.toLocaleString()}</td>
      <td>${session.createdAt}</td>
      <td>${session.lastActive}</td>
      <td>
        <div class="action-buttons">
          <button class="action-btn" onclick="viewSession('${session.id}')">查看</button>
          <button class="action-btn delete" onclick="deleteSession('${session.id}')">删除</button>
        </div>
      </td>
    </tr>
  `).join('');
  
  document.getElementById('sessionTableBody').innerHTML = html || '<tr><td colspan="8" style="text-align:center;padding:40px;color:#94a3b8">暂无会话数据</td></tr>';
}

function filterSessions() {
  loadSessions();
}

function viewSession(id) {
  const sessions = getData(STORAGE_KEYS.sessions);
  const session = sessions.find(s => s.id === id);
  if (session) {
    alert(`会话详情\n\nID: ${session.id}\n用户: ${session.username}\n标题: ${session.title}\n消息数: ${session.messages}\nToken 用量: ${session.tokens.toLocaleString()}\n创建时间: ${session.createdAt}\n最后活跃: ${session.lastActive}`);
  }
}

function deleteSession(id) {
  if (!confirm('确定要删除该会话吗？')) return;
  const sessions = getData(STORAGE_KEYS.sessions);
  const filtered = sessions.filter(s => s.id !== id);
  setData(STORAGE_KEYS.sessions, filtered);
  addLog('warn', `会话 ${id} 已删除`);
  showToast('会话已删除', 'success');
  loadSessions();
}

function clearAllSessions() {
  if (!confirm('确定要清空所有会话吗？此操作不可恢复！')) return;
  setData(STORAGE_KEYS.sessions, []);
  addLog('warn', '所有会话已清空');
  showToast('所有会话已清空', 'success');
  loadSessions();
}

// ============ 系统日志 ============
function loadLogs() {
  const logs = getData(STORAGE_KEYS.logs);
  const levelFilter = document.getElementById('logLevelFilter')?.value || '';
  
  let filtered = logs;
  if (levelFilter) {
    filtered = filtered.filter(l => l.level === levelFilter);
  }
  
  const html = filtered.map(log => `
    <div class="log-item">
      <span class="log-time">${log.time}</span>
      <span class="log-level ${log.level}">${log.level}</span>
      <span class="log-message">${log.message}</span>
    </div>
  `).join('');
  
  document.getElementById('logList').innerHTML = html || '<div style="padding:40px;text-align:center;color:#94a3b8">暂无日志</div>';
}

function filterLogs() {
  loadLogs();
}

function exportLogs() {
  const logs = getData(STORAGE_KEYS.logs);
  const text = logs.map(l => `[${l.time}] [${l.level.toUpperCase()}] ${l.message}`).join('\n');
  const blob = new Blob([text], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `BubaiCode_logs_${new Date().toISOString().split('T')[0]}.txt`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('日志已导出', 'success');
}

function clearLogs() {
  if (!confirm('确定要清空所有日志吗？')) return;
  setData(STORAGE_KEYS.logs, []);
  showToast('日志已清空', 'success');
  loadLogs();
}

// ============ 系统设置 ============
function loadSettings() {
  const settings = JSON.parse(localStorage.getItem(STORAGE_KEYS.settings) || JSON.stringify(DEFAULT_SETTINGS));
  document.getElementById('settingAppName').value = settings.appName;
  document.getElementById('settingVersion').value = settings.version;
  document.getElementById('settingLanguage').value = settings.language;
  document.getElementById('settingTheme').value = settings.theme;
  document.getElementById('settingEnableAuth').checked = settings.enableAuth;
  document.getElementById('settingEnableAudit').checked = settings.enableAudit;
  document.getElementById('settingSessionTimeout').value = settings.sessionTimeout;
  document.getElementById('settingMinPassword').value = settings.minPassword;
  document.getElementById('settingDefaultProvider').value = settings.defaultProvider;
  document.getElementById('settingThinkingLevel').value = settings.thinkingLevel;
  document.getElementById('settingMaxTokens').value = settings.maxTokens;
  document.getElementById('settingEnableCache').checked = settings.enableCache;
}

function saveSettings() {
  const settings = {
    appName: document.getElementById('settingAppName').value,
    version: document.getElementById('settingVersion').value,
    language: document.getElementById('settingLanguage').value,
    theme: document.getElementById('settingTheme').value,
    enableAuth: document.getElementById('settingEnableAuth').checked,
    enableAudit: document.getElementById('settingEnableAudit').checked,
    sessionTimeout: parseInt(document.getElementById('settingSessionTimeout').value),
    minPassword: parseInt(document.getElementById('settingMinPassword').value),
    defaultProvider: document.getElementById('settingDefaultProvider').value,
    thinkingLevel: document.getElementById('settingThinkingLevel').value,
    maxTokens: parseInt(document.getElementById('settingMaxTokens').value),
    enableCache: document.getElementById('settingEnableCache').checked
  };
  
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(settings));
  addLog('info', '系统设置已更新');
  showToast('设置已保存', 'success');
}

function resetSettings() {
  if (!confirm('确定要恢复默认设置吗？')) return;
  localStorage.setItem(STORAGE_KEYS.settings, JSON.stringify(DEFAULT_SETTINGS));
  loadSettings();
  addLog('info', '系统设置已恢复默认');
  showToast('已恢复默认设置', 'success');
}

// ============ 模态框 ============
function showModal(id) {
  document.getElementById(id).classList.remove('hidden');
  // 如果是用户模态框且不是编辑状态，清空表单
  if (id === 'userModal' && !editingUserId) {
    document.getElementById('userModalTitle').textContent = '添加用户';
    document.getElementById('userId').value = '';
    document.getElementById('userName').value = '';
    document.getElementById('userEmail').value = '';
    document.getElementById('userPassword').value = '';
    document.getElementById('userRole').value = 'user';
    document.getElementById('userActive').checked = true;
  }
  if (id === 'apiModal' && !editingApiId) {
    document.getElementById('apiModalTitle').textContent = '添加 API 配置';
    document.getElementById('apiId').value = '';
    document.getElementById('apiProvider').value = 'deepseek';
    document.getElementById('apiEndpoint').value = PROVIDER_ENDPOINTS.deepseek;
    document.getElementById('apiKey').value = '';
    document.getElementById('apiModel').value = 'deepseek-chat';
    document.getElementById('apiRemark').value = '';
    document.getElementById('apiActive').checked = true;
  }
}

function hideModal(id) {
  document.getElementById(id).classList.add('hidden');
}

// 点击模态框外部关闭
document.addEventListener('click', (e) => {
  if (e.target.classList.contains('modal')) {
    e.target.classList.add('hidden');
  }
});

// ============ Toast ============
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.className = `toast ${type}`;
  toast.classList.remove('hidden');
  
  setTimeout(() => {
    toast.classList.add('hidden');
  }, 3000);
}

// ============ 刷新数据 ============
function refreshData() {
  switchPage(currentPage);
  showToast('数据已刷新', 'success');
}

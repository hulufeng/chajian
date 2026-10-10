// AI 网关桩：只保证 import 不崩、调用返回合法形状
// 检查脚本只测确定性的 scanLogFindings，走 AI 的部分返回空即可

export function getAiState() {
  return {
    token: null,
    email: null,
    planCredits: 0,
    rechargeCredits: 0,
    totalCredits: 0,
    planMonth: null,
    modelId: 'stub',
    byok: null,
    byokProfiles: [],
    activeByokId: null
  }
}

export async function aiChat(_messages, _opts) {
  return {
    text: '',
    modelId: 'stub-model',
    usage: { prompt_tokens: 0, completion_tokens: 0 }
  }
}

export function getChannelHealth() {
  return { local: 'unknown', gateway: 'unknown', byok: 'unknown' }
}

export function resolveActiveByok() { return null }

export function isAnthropicEndpoint() { return false }
export function toAnthropicMessages() { return { system: '', messages: [] } }
export function toAnthropicTools() { return [] }
export function anthropicHeaders() { return {} }
export function anthropicMessagesUrl() { return '' }
export async function chatByokAnthropic() { return '' }
export function anthropicStream() {
  return { abort: () => {}, state: { token: '' } }
}

export const ChatStreamState = {
  IDLE: 'idle',
  RUNNING: 'running',
  DONE: 'done'
}

export function stateFile() { return '' }
export function getServer() { return '' }
export function listByokProfiles() { return [] }
export function saveByokProfile(p) { return getAiState() }
export function deleteByokProfile() { return getAiState() }
export function setActiveByok() { return getAiState() }
export function noteChannelError() {}
export async function listModels() { return [] }
export async function authRegister() { return { token: '', user: { email: '', planCredits: 0, rechargeCredits: 0, totalCredits: 0, planMonth: '' } } }
export async function authLogin() { return { token: '', user: { email: '', planCredits: 0, rechargeCredits: 0, totalCredits: 0, planMonth: '' } } }
export async function sendLoginCode() { return { ok: true } }
export async function verifyLoginCode() { return { token: '', user: { email: '', planCredits: 0, rechargeCredits: 0, totalCredits: 0, planMonth: '' } } }
export async function loginWithCode() { return getAiState() }
export async function refreshMe() { return { email: '', planCredits: 0, rechargeCredits: 0, totalCredits: 0, planMonth: '' } }
export async function guestLogin() { return getAiState() }
export async function login() { return getAiState() }
export async function register() { return getAiState() }
export async function refreshAccount() { return getAiState() }
export function logout() { return getAiState() }
export function setAiState() {}
export function clearAiState() { return getAiState() }
export function setLocalModel() {}
export function getLocalModel() { return null }

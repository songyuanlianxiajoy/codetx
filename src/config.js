/**
 * 配置加载与连接解析。
 *
 * 文件布局（全部在 $CODETX_HOME，默认 ~/.codetx）：
 *   config.toml   主配置（600）
 *   .env          API Key，KEY=VALUE（600；优先级高于 shell 环境变量，与 codex 习惯一致）
 *   sessions/     会话 JSONL
 *   history       输入历史
 *   cache/        临时缓存
 *
 * 优先级：CLI 参数 > 环境变量/`.env` > config.toml > 内置默认值。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { parse as parseToml, stringify as stringifyToml, TomlError, deepMerge } from './toml.js';
import { atomicWrite } from './util.js';
import { HOME } from './termux.js';

export class ConfigError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ConfigError';
  }
}

export class AuthError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AuthError';
  }
}

export const DEFAULT_CONFIG = {
  model: '',
  provider: '',
  approval_policy: 'ask', // ask | auto | full | read-only
  max_turns: 40,
  max_tool_calls: 200,
  show_reasoning: false,
  auto_compact: true,
  context_window: 200000,
  shell: '',
  workspace_only: true,
  request_timeout_ms: 300000,
  stream_idle_timeout_ms: 180000,
  include_usage: true,
  providers: {},
};

export const APPROVAL_POLICIES = ['ask', 'auto', 'full', 'read-only'];
export const PROVIDER_TYPES = ['openai', 'responses'];
export const DEFAULT_CONTEXT_WINDOW = 200000;

export function homeDir() {
  return path.resolve(process.env.CODETX_HOME || path.join(HOME, '.codetx'));
}

export function configPath() {
  return path.join(homeDir(), 'config.toml');
}

export function envPath() {
  return path.join(homeDir(), '.env');
}

export function historyPath() {
  return path.join(homeDir(), 'history');
}

export function sessionsDir() {
  return path.join(homeDir(), 'sessions');
}

export function cacheDir() {
  return path.join(homeDir(), 'cache');
}

export async function ensureHome() {
  const dir = homeDir();
  await fsp.mkdir(dir, { recursive: true, mode: 0o700 });
  await fsp.mkdir(sessionsDir(), { recursive: true, mode: 0o700 });
  await fsp.mkdir(cacheDir(), { recursive: true, mode: 0o700 });
  try {
    await fsp.chmod(dir, 0o700);
  } catch {
    /* ignore */
  }
}

/** 解析 .env（不覆盖进程环境，由 readEnv 决定优先级）。 */
export function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    let key = line.slice(0, eq).trim();
    if (key.startsWith('export ')) key = key.slice(7).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

export function loadDotEnvSync() {
  try {
    return parseDotEnv(fs.readFileSync(envPath(), 'utf8'));
  } catch {
    return {};
  }
}

/** 读取一个变量：.env 优先于 shell（方便中转站切换脚本统一改 .env）。 */
export function readEnv(key, dotenv = loadDotEnvSync()) {
  if (dotenv[key] != null && dotenv[key] !== '') return dotenv[key];
  if (process.env[key] != null && process.env[key] !== '') return process.env[key];
  return '';
}

function applyEnvOverrides(config) {
  const next = structuredClone(config);
  const dotenv = loadDotEnvSync();
  const model = readEnv('CODETX_MODEL', dotenv);
  const provider = readEnv('CODETX_PROVIDER', dotenv);
  const approval = readEnv('CODETX_APPROVAL_POLICY', dotenv);
  if (model) next.model = model;
  if (provider) next.provider = provider;
  if (approval) next.approval_policy = approval;
  if (dotenv.CODETX_SHOW_REASONING) next.show_reasoning = dotenv.CODETX_SHOW_REASONING === '1' || dotenv.CODETX_SHOW_REASONING === 'true';
  if (dotenv.CODETX_CONTEXT_WINDOW && Number(dotenv.CODETX_CONTEXT_WINDOW) > 0) {
    next.context_window = Number(dotenv.CODETX_CONTEXT_WINDOW);
  }
  return next;
}

function coerceTypes(config) {
  const next = { ...config };
  for (const key of ['max_turns', 'max_tool_calls', 'context_window', 'request_timeout_ms', 'stream_idle_timeout_ms']) {
    if (next[key] != null) {
      const n = Number(next[key]);
      if (Number.isFinite(n) && n > 0) next[key] = Math.round(n);
    }
  }
  for (const key of ['show_reasoning', 'auto_compact', 'workspace_only', 'include_usage']) {
    if (typeof next[key] === 'string') next[key] = next[key] === 'true' || next[key] === '1';
  }
  return next;
}

/**
 * 载入配置。
 * @param {object} [options]
 * @param {string} [options.file] 指定配置文件（测试/多环境）
 */
export function loadConfig(options = {}) {
  const file = options.file || configPath();
  let raw = {};
  let exists = false;
  try {
    const text = fs.readFileSync(file, 'utf8');
    exists = true;
    raw = parseToml(text);
  } catch (err) {
    if (err && err.code !== 'ENOENT') {
      if (err instanceof TomlError) throw new ConfigError(`配置文件 ${file} 解析失败：${err.message}`);
      throw err;
    }
  }

  if (raw.providers && typeof raw.providers === 'object') {
    for (const [name, provider] of Object.entries(raw.providers)) {
      if (!provider || typeof provider !== 'object') {
        throw new ConfigError(`provider "${name}" 必须是一个表，例如 [providers.${name}]`);
      }
    }
  }

  let config = deepMerge(DEFAULT_CONFIG, raw);
  config = coerceTypes(config);
  config = applyEnvOverrides(config);
  validateConfig(config, file);
  return { config, file, exists };
}

export function validateConfig(config, file = configPath()) {
  if (!APPROVAL_POLICIES.includes(config.approval_policy)) {
    throw new ConfigError(
      `approval_policy = ${JSON.stringify(config.approval_policy)} 不合法，可选：${APPROVAL_POLICIES.join(' / ')}`,
    );
  }
  for (const [name, provider] of Object.entries(config.providers || {})) {
    const type = provider.type || 'openai';
    if (!PROVIDER_TYPES.includes(type)) {
      throw new ConfigError(`[providers.${name}] type = ${JSON.stringify(type)} 不合法，可选：${PROVIDER_TYPES.join(' / ')}`);
    }
    if (provider.base_url != null && typeof provider.base_url !== 'string') {
      throw new ConfigError(`[providers.${name}] base_url 必须是字符串`);
    }
    if (provider.models != null && !Array.isArray(provider.models)) {
      throw new ConfigError(`[providers.${name}] models 必须是数组`);
    }
  }
  for (const key of ['max_turns', 'max_tool_calls', 'context_window']) {
    if (!Number.isFinite(config[key]) || config[key] <= 0) {
      throw new ConfigError(`${key} 必须是正整数`);
    }
  }
  if (config.provider && !config.providers[config.provider]) {
    throw new ConfigError(
      `默认 provider "${config.provider}" 不存在。已配置的 provider：${
        Object.keys(config.providers).join(', ') || '（无）'
      }\n先运行 codetx login 或 codetx relay use 配置一个。`,
    );
  }
  return true;
}

export async function saveConfig(config) {
  await ensureHome();
  const text = [
    '# codetx 配置 —— 由 codetx 生成，可手工编辑',
    '# 详细说明见 https://github.com/songyuanlianxiajoy/codetx',
    '',
    stringifyToml(config),
  ].join('\n');
  await atomicWrite(configPath(), text, 0o600);
}

/** 掩码显示 key，避免日志/截图泄露。 */
export function maskKey(key) {
  const s = String(key || '');
  if (s.length <= 8) return s ? '****' : '';
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

/**
 * 把 provider 配置解析成可直连的连接信息。
 * @param {object} config
 * @param {{provider?: string, model?: string, baseUrl?: string, apiKey?: string, type?: string}} [overrides]
 */
export function resolveConnection(config, overrides = {}) {
  const providerName = overrides.provider || config.provider || Object.keys(config.providers || {})[0] || '';
  const providers = config.providers || {};
  const provider = providerName ? providers[providerName] : undefined;

  if (!providerName || !provider) {
    throw new ConfigError(
      '还没有配置任何 provider。\n' +
        '两种方式任选其一：\n' +
        '  1) 交互式配置：codetx login\n' +
        '  2) 中转站一条命令：codetx relay use https://api.example.com/v1 sk-xxx 模型名\n' +
        '也可以手工编辑 ~/.codetx/config.toml（参考 config.example.toml）。',
    );
  }

  const dotenv = loadDotEnvSync();
  const type = overrides.type || provider.type || 'openai';
  const baseUrl = normalizeBaseUrl(overrides.baseUrl || provider.base_url || '');
  if (!baseUrl) {
    throw new ConfigError(`provider "${providerName}" 缺少 base_url。在 ~/.codetx/config.toml 的 [providers.${providerName}] 下补上。`);
  }

  const envKey = provider.env_key || 'CODETX_API_KEY';
  const apiKey =
    overrides.apiKey ||
    provider.api_key ||
    readEnv(envKey, dotenv) ||
    readEnv('CODETX_API_KEY', dotenv);

  if (!apiKey) {
    throw new AuthError(
      `provider "${providerName}" 没有可用的 API Key。\n` +
        `设置方式（任选）：\n` +
        `  codetx relay use <base_url> <api_key> <model>   # 自动写入\n` +
        `  codetx login                                    # 交互式输入\n` +
        `  在 ${envPath()} 里加一行 ${envKey}=sk-xxx（推荐，权限 600）\n` +
        `  或 export ${envKey}=sk-xxx`,
    );
  }

  const model = overrides.model || provider.model || config.model;
  if (!model) {
    throw new ConfigError(
      `没有指定模型。用 --model 指定，或在 ${configPath()} 里设置 model = "..."，` +
        `或在 [providers.${providerName}] 下写 model = "..."。`,
    );
  }

  const contextWindow =
    Number(provider.context_window) || Number(config.context_window) || DEFAULT_CONTEXT_WINDOW;

  return {
    providerName,
    providerType: type,
    baseUrl,
    apiKey,
    model,
    contextWindow,
    headers: provider.headers && typeof provider.headers === 'object' ? provider.headers : {},
    workspaceOnly: config.workspace_only !== false,
    timeoutMs: Number(config.request_timeout_ms) || 300000,
    idleTimeoutMs: Number(config.stream_idle_timeout_ms) || 180000,
    includeUsage: config.include_usage !== false,
    models: Array.isArray(provider.models) ? provider.models : [],
  };
}

/**
 * base_url 规范化：去尾斜杠；如果只有域名（没路径），补 /v1。
 * 例如 https://api.x.com → https://api.x.com/v1
 */
export function normalizeBaseUrl(raw) {
  let url = String(raw || '').trim();
  if (!url) return '';
  url = url.replace(/\/+$/, '');
  try {
    const parsed = new URL(url);
    if (parsed.pathname === '' || parsed.pathname === '/') {
      parsed.pathname = '/v1';
      url = parsed.toString().replace(/\/+$/, '');
    }
  } catch {
    // 不是完整 URL（例如本地 unix socket 写法），原样返回
  }
  return url;
}

export function endpoint(baseUrl, suffix) {
  return `${String(baseUrl).replace(/\/+$/, '')}/${String(suffix).replace(/^\/+/, '')}`;
}

/** 配置文件的 dotted path 读写（codetx config get/set）。 */
export function getPath(obj, dotted) {
  if (!dotted) return obj;
  const parts = dotted.split('.').filter(Boolean);
  let cur = obj;
  for (const part of parts) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

export function coerceValue(raw) {
  const s = String(raw).trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (/^-?\d+$/.test(s)) return Number(s);
  if (/^-?\d+\.\d+$/.test(s)) return Number(s);
  if (s.startsWith('[') || s.startsWith('{')) {
    try {
      return JSON.parse(s);
    } catch {
      /* fallthrough */
    }
  }
  if (s.startsWith('"') && s.endsWith('"')) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  return s;
}

export function setPath(obj, dotted, value) {
  const parts = dotted.split('.').filter(Boolean);
  if (parts.length === 0) throw new ConfigError('配置键不能为空');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (cur[part] == null || typeof cur[part] !== 'object') cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
  return obj;
}

/** 默认配置模板（install.sh / codetx init 使用）。 */
export function defaultConfigText() {
  return `# codetx 配置（参考 config.example.toml）
# 最快的配置方式：
#   codetx relay use https://api.example.com/v1 sk-xxx 模型名
# 然后直接运行：codetx

# 默认模型（也可在 [providers.*] 里各写一个）
model = ""
# 默认 provider 名
provider = ""
# 审批策略：ask（默认，逐条问）/ auto（工作区内写文件自动放行）/ full（全放行）/ read-only（只读）
approval_policy = "ask"
# 单轮最多几轮模型调用 / 工具调用
max_turns = 40
max_tool_calls = 200
# 是否显示模型思考过程（reasoning_content）
show_reasoning = false
# 上下文窗口（token），用于自动压缩提醒
context_window = 200000

# 示例 provider（去掉注释即可用）：
# [providers.relay]
# type = "openai"            # openai = /chat/completions；responses = /responses
# base_url = "https://api.example.com/v1"
# env_key = "CODETX_RELAY_KEY"   # Key 放在 ~/.codetx/.env
# model = "gpt-5.6-sol"
# models = ["gpt-5.6-sol", "gpt-5.6-terra"]
# context_window = 200000
`;
}

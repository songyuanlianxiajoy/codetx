/**
 * codetx relay：中转站一键切换。
 *
 * 设计跟本机其它 CLI 的 relay 保持一致：
 *   relay use <base_url> <key> [模型...] --type openai|responses
 *   relay on / off / status / models / test / list
 *
 * 状态文件 ~/.codetx/relay.json 记录「当前这一套中转站」，config.toml 里
 * 由它生成的 provider 段可以随时被 off/on 摘掉/装回；key 只放 .env（600）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { homeDir, resolveConnection, saveConfig, maskKey, normalizeBaseUrl, readEnv, loadDotEnvSync } from './config.js';
import { saveProvider, upsertEnv } from './provider-setup.js';
import { listModels, pingProvider } from './providers/index.js';
import { atomicWrite } from './util.js';
import { st } from './ansi.js';

const DEFAULT_PROVIDER = 'relay';
const DEFAULT_ENV_KEY = 'CODETX_RELAY_KEY';

export function relayFile() {
  return path.join(homeDir(), 'relay.json');
}

export function readRelayState() {
  try {
    const json = JSON.parse(fs.readFileSync(relayFile(), 'utf8'));
    if (json && typeof json === 'object') return json;
  } catch {
    /* ignore */
  }
  return null;
}

async function writeRelayState(state) {
  await atomicWrite(relayFile(), `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

export async function runRelay(argv, { config, write = (t) => process.stdout.write(t) } = {}) {
  const [sub = 'status', ...rest] = argv;
  switch (sub) {
    case 'use':
      return relayUse(rest, { config, write });
    case 'on':
      return relayOn({ config, write });
    case 'off':
      return relayOff({ config, write });
    case 'status':
      return relayStatus({ config, write });
    case 'models':
      return relayModels({ config, write });
    case 'test':
      return relayTest({ config, write });
    case 'list':
      return relayList({ config, write });
    case 'help':
    case '--help':
    case '-h':
    default:
      printRelayHelp(write);
      return { exitCode: sub === 'help' || sub === '--help' || sub === '-h' ? 0 : 1 };
  }
}

async function relayUse(args, { config, write }) {
  let baseUrl = '';
  let apiKey = '';
  const models = [];
  let type = 'openai';
  let model = '';
  let providerName = DEFAULT_PROVIDER;
  let contextWindow = 200000;
  let envKey = DEFAULT_ENV_KEY;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--type') type = args[++i] || 'openai';
    else if (arg === '--model') model = args[++i] || '';
    else if (arg === '--provider') providerName = args[++i] || DEFAULT_PROVIDER;
    else if (arg === '--ctx' || arg === '--context-window') contextWindow = Number(args[++i]) || 200000;
    else if (arg === '--env-key') envKey = args[++i] || DEFAULT_ENV_KEY;
    else if (!baseUrl) baseUrl = arg;
    else if (!apiKey) apiKey = arg;
    else models.push(...String(arg).split(',').map((m) => m.trim()).filter(Boolean));
  }

  if (!baseUrl || !apiKey) {
    write(
      `${st.red('用法')}：codetx relay use <base_url> <api_key> [模型1 模型2 ...] [--type openai|responses] [--ctx 200000]\n` +
        `${st.dim('例：codetx relay use https://api.hnsec.cn/v1 sk-xxx deepseek-v4-flash')}\n`,
    );
    return { exitCode: 1 };
  }
  if (!/^https?:\/\//i.test(baseUrl)) {
    write(`${st.red('base_url 必须以 http:// 或 https:// 开头')}\n`);
    return { exitCode: 1 };
  }
  if (!['openai', 'responses'].includes(type)) {
    write(`${st.red('--type 只能是 openai 或 responses')}\n`);
    return { exitCode: 1 };
  }

  baseUrl = sanitizeBaseUrl(baseUrl, type);
  if (model) models.unshift(model);
  model = models[0] || '';

  const state = {
    enabled: true,
    provider: providerName,
    base_url: baseUrl,
    type,
    models,
    model,
    env_key: envKey,
    context_window: contextWindow,
    updated_at: new Date().toISOString(),
  };

  await saveProvider(config, {
    name: providerName,
    baseUrl,
    type,
    apiKey,
    model,
    models,
    contextWindow,
    envKey,
  });
  await writeRelayState(state);

  write(`\n${st.green('✓')} 中转站已配置\n`);
  write(`  provider  ${st.bold(providerName)}（${type}）\n`);
  write(`  base_url  ${baseUrl}\n`);
  write(`  模型      ${model || st.yellow('未指定（用 /model 或 --model 指定）')}\n`);
  write(`  密钥      ${maskKey(apiKey)} → ~/.codetx/.env（${envKey}）\n`);
  write(`  上下文    ${contextWindow} tokens\n`);
  write(`\n${st.dim('下一步：codetx relay test 验证；codetx 直接开始对话。')}\n\n`);
  return { exitCode: 0 };
}

function sanitizeBaseUrl(url, type) {
  let next = String(url).trim().replace(/\/+$/, '');
  if (next.endsWith('/chat/completions')) next = next.slice(0, -'/chat/completions'.length);
  if (next.endsWith('/responses')) next = next.slice(0, -'/responses'.length);
  if (!/\/v\d+$/.test(next) && !next.includes('/v1/') && type === 'openai') {
    // 只提示，不擅自加：有些站点是 /api 或裸路径
  }
  return normalizeBaseUrl(next) || next;
}

async function relayOff({ config, write }) {
  const state = readRelayState();
  if (!state) {
    write(`${st.yellow('还没有 relay 配置。')}\n`);
    return { exitCode: 1 };
  }
  const providerName = state.provider || DEFAULT_PROVIDER;
  if (config.providers && config.providers[providerName]) {
    delete config.providers[providerName];
  }
  if (config.provider === providerName) config.provider = '';
  await saveConfig(config);
  state.enabled = false;
  state.updated_at = new Date().toISOString();
  await writeRelayState(state);
  write(`${st.green('✓')} 已停用 relay provider「${providerName}」（key 保留在 .env）\n`);
  write(st.dim('恢复：codetx relay on\n'));
  return { exitCode: 0 };
}

async function relayOn({ config, write }) {
  const state = readRelayState();
  if (!state) {
    write(`${st.red('没有 relay 配置，先运行 codetx relay use ...')}\n`);
    return { exitCode: 1 };
  }
  const envKey = state.env_key || DEFAULT_ENV_KEY;
  const key = readEnv(envKey, loadDotEnvSync());
  if (!key) {
    write(`${st.red('找不到 key')}：~/.codetx/.env 里没有 ${envKey}，请重新 relay use。\n`);
    return { exitCode: 1 };
  }
  await saveProvider(config, {
    name: state.provider || DEFAULT_PROVIDER,
    baseUrl: state.base_url,
    type: state.type || 'openai',
    apiKey: '',
    model: state.model || '',
    models: state.models || [],
    contextWindow: state.context_window || 200000,
    envKey,
  });
  state.enabled = true;
  state.updated_at = new Date().toISOString();
  await writeRelayState(state);
  write(`${st.green('✓')} 已启用 relay：${state.base_url}（${state.model || '未指定模型'}）\n`);
  return { exitCode: 0 };
}

async function relayStatus({ config, write }) {
  const state = readRelayState();
  write(`\n${st.bold('codetx relay')}\n\n`);
  if (!state) {
    write(`${st.dim('未配置。用 codetx relay use <url> <key> [模型...] 添加。')}\n\n`);
    return { exitCode: 0 };
  }
  const providerName = state.provider || DEFAULT_PROVIDER;
  const configured = Boolean(config.providers && config.providers[providerName]);
  write(`  状态       ${state.enabled && configured ? st.green('已启用') : st.yellow('未启用')}\n`);
  write(`  provider   ${providerName}（${state.type}）\n`);
  write(`  base_url   ${state.base_url}\n`);
  write(`  模型       ${state.model || '-'}\n`);
  if (Array.isArray(state.models) && state.models.length > 0) write(`  模型列表   ${state.models.join(', ')}\n`);
  write(`  上下文     ${state.context_window || 200000} tokens\n`);
  const dotenv = loadDotEnvSync();
  write(`  密钥       ${maskKey(readEnv(state.env_key || DEFAULT_ENV_KEY, dotenv)) || st.red('缺失')}\n`);
  write(`  配置段     ${configured ? '存在' : st.yellow('缺失（codetx relay on 可恢复）')}\n`);
  write(`  更新时间   ${state.updated_at || '-'}\n\n`);
  if (config.provider && config.provider !== providerName) {
    write(st.yellow(`注意：当前默认 provider 是 ${config.provider}，不是 ${providerName}。`) + '\n\n');
  }
  return { exitCode: 0 };
}

async function relayModels({ config, write }) {
  const state = readRelayState();
  let conn;
  try {
    conn = resolveConnection(config);
  } catch (err) {
    if (state) {
      write(`${st.red('读取连接配置失败：')}${err.message}\n`);
    } else {
      write(`${st.red('还没有配置 provider，先 codetx relay use ...')}\n`);
    }
    return { exitCode: 1 };
  }
  write(st.dim(`正在获取模型列表：${conn.baseUrl}\n`));
  try {
    const models = await listModels(conn);
    if (models.length === 0) {
      write(`${st.yellow('站点没有返回模型列表。')}\n`);
      return { exitCode: 0 };
    }
    write(`${st.green(`共 ${models.length} 个模型：`)}\n`);
    for (const model of models) {
      const mark = model === conn.model ? st.green('*') : ' ';
      write(`  ${mark} ${model}\n`);
    }
    write(st.dim('\n切换模型：/model <名字>（TUI 内），或 codetx relay use 时带模型名。\n'));
    return { exitCode: 0 };
  } catch (err) {
    write(`${st.red('获取失败：')}${err.message.split('\n')[0]}\n`);
    return { exitCode: 1 };
  }
}

async function relayTest({ config, write }) {
  let conn;
  try {
    conn = resolveConnection(config);
  } catch (err) {
    write(`${st.red('连接配置不可用：')}${err.message}\n`);
    return { exitCode: 1 };
  }
  write(st.dim(`正在测试 ${conn.providerName} / ${conn.model}（${conn.providerType}）…\n`));
  try {
    const result = await pingProvider(conn);
    write(`${st.green('✓ 通')}  延迟 ${result.ms}ms\n`);
    if (result.text) write(`  回复：${result.text.trim().slice(0, 120)}\n`);
    return { exitCode: 0 };
  } catch (err) {
    write(`${st.red('✗ 不通')}\n${err.message}\n`);
    return { exitCode: 1 };
  }
}

async function relayList({ config, write }) {
  const names = Object.keys(config.providers || {});
  write(`\n${st.bold('已配置的 provider')}\n\n`);
  if (names.length === 0) {
    write(st.dim('（无）\n'));
  }
  for (const name of names) {
    const provider = config.providers[name];
    const mark = name === config.provider ? st.green('●') : ' ';
    write(
      `  ${mark} ${st.bold(name)}  ${provider.type || 'openai'}  ${provider.base_url}  ${st.dim(
        provider.model || '',
      )}\n`,
    );
  }
  write('\n');
  return { exitCode: 0 };
}

function printRelayHelp(write) {
  write(`
${st.bold('codetx relay')} —— 中转站一键切换

  ${st.cyan('codetx relay use')} <base_url> <api_key> [模型...] [选项]
      写配置 + 存 key 到 ~/.codetx/.env，并设为默认 provider
      选项：--type openai|responses  --model 名字  --ctx 200000  --provider 名字  --env-key 变量名

  ${st.cyan('codetx relay test')}     发一次最小请求验证连通性
  ${st.cyan('codetx relay models')}   列出站点模型（GET /models）
  ${st.cyan('codetx relay status')}   查看当前 relay 状态
  ${st.cyan('codetx relay off')}      从 config.toml 摘掉 relay provider（key 保留）
  ${st.cyan('codetx relay on')}       重新装回
  ${st.cyan('codetx relay list')}     列出所有 provider

${st.dim('例：codetx relay use https://api.hnsec.cn/v1 sk-xxx deepseek-v4-flash')}
`);
}

/**
 * provider 写盘辅助：config.toml 的 provider 段 + .env 里的 key。
 * 供 codetx login / codetx relay 共用，保证两条路径写出来的配置一致。
 */
import fs from 'node:fs';
import { envPath, saveConfig, ensureHome } from './config.js';
import { atomicWrite } from './util.js';

const HEADER = '# codetx 密钥文件（权限 600；.env 里的值优先于 shell 环境变量）';

export function readEnvLines() {
  try {
    const text = fs.readFileSync(envPath(), 'utf8');
    return text.split('\n').filter((line) => line.trim() !== '');
  } catch {
    return [HEADER];
  }
}

export async function upsertEnv(key, value) {
  await ensureHome();
  const lines = readEnvLines();
  if (lines.length === 0 || !lines[0].startsWith('#')) lines.unshift(HEADER);
  let found = false;
  const next = lines.map((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    if (match && match[1] === key) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });
  if (!found) next.push(`${key}=${value}`);
  await atomicWrite(envPath(), `${next.join('\n')}\n`, 0o600);
}

export async function removeEnv(key) {
  const lines = readEnvLines().filter((line) => {
    const match = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(line);
    return !(match && match[1] === key);
  });
  await atomicWrite(envPath(), `${lines.join('\n')}\n`, 0o600);
}

/**
 * 写入（或覆盖）一个 provider 并设为默认。
 * @param {object} config
 * @param {object} options
 */
export async function saveProvider(config, options) {
  const {
    name = 'relay',
    baseUrl,
    type = 'openai',
    apiKey = '',
    model = '',
    models = [],
    contextWindow = 0,
    envKey = 'CODETX_RELAY_KEY',
  } = options;

  if (!baseUrl) throw new Error('base_url 不能为空');
  if (!['openai', 'responses'].includes(type)) throw new Error(`type 只能是 openai 或 responses（收到 ${type}）`);

  config.providers = config.providers && typeof config.providers === 'object' ? config.providers : {};
  config.providers[name] = {
    type,
    base_url: baseUrl,
    env_key: envKey,
    ...(model ? { model } : {}),
    ...(models.length > 0 ? { models } : {}),
    ...(contextWindow > 0 ? { context_window: contextWindow } : {}),
  };
  config.provider = name;
  if (model) config.model = model;

  await saveConfig(config);
  if (apiKey) await upsertEnv(envKey, apiKey);
  return config;
}

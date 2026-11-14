import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  loadConfig,
  saveConfig,
  resolveConnection,
  normalizeBaseUrl,
  parseDotEnv,
  readEnv,
  maskKey,
  getPath,
  setPath,
  coerceValue,
  configPath,
  envPath,
  homeDir,
  validateConfig,
  AuthError,
  ConfigError,
  DEFAULT_CONFIG,
} from '../src/config.js';

const ISOLATED_KEYS = [
  'CODETX_HOME',
  'CODETX_MODEL',
  'CODETX_PROVIDER',
  'CODETX_BASE_URL',
  'CODETX_API_KEY',
  'CODETX_APPROVAL_POLICY',
];

function isolate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codetx-config-'));
  const saved = {};
  for (const key of ISOLATED_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.CODETX_HOME = dir;
  return {
    dir,
    restore() {
      for (const key of ISOLATED_KEYS) {
        if (saved[key] === undefined) delete process.env[key];
        else process.env[key] = saved[key];
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test('默认配置与 home 目录', () => {
  const env = isolate();
  assert.equal(homeDir(), env.dir);
  assert.equal(configPath(), path.join(env.dir, 'config.toml'));
  const { config, exists } = loadConfig();
  assert.equal(exists, false);
  assert.equal(config.approval_policy, DEFAULT_CONFIG.approval_policy);
  assert.equal(config.max_turns, 40);
  env.restore();
});

test('读写配置并解析 provider', async () => {
  const env = isolate();
  const { config } = loadConfig();
  config.providers = {
    relay: {
      type: 'openai',
      base_url: 'https://api.example.com/v1',
      env_key: 'TEST_KEY',
      model: 'm1',
      models: ['m1', 'm2'],
    },
  };
  config.provider = 'relay';
  config.model = 'm1';
  await saveConfig(config);

  const reloaded = loadConfig().config;
  assert.equal(reloaded.providers.relay.base_url, 'https://api.example.com/v1');

  fs.writeFileSync(envPath(), 'TEST_KEY=sk-test-123456\n', { mode: 0o600 });
  const conn = resolveConnection(reloaded);
  assert.equal(conn.apiKey, 'sk-test-123456');
  assert.equal(conn.model, 'm1');
  assert.equal(conn.providerType, 'openai');
  assert.deepEqual(conn.models, ['m1', 'm2']);

  const withoutKey = resolveConnection(reloaded, { apiKey: '' });
  void withoutKey;
  fs.rmSync(envPath());
  assert.throws(() => resolveConnection(reloaded), AuthError);
  env.restore();
});

test('.env 优先级高于 process.env（与 codex 习惯一致）', () => {
  const env = isolate();
  fs.writeFileSync(envPath(), 'MY_KEY=from-file\n');
  process.env.MY_KEY = 'from-shell';
  assert.equal(readEnv('MY_KEY'), 'from-file');
  delete process.env.MY_KEY;
  env.restore();
});

test('parseDotEnv 处理注释、引号、export', () => {
  const parsed = parseDotEnv(`
# 注释
A=1
export B="two words"
C='single'
D = spaced
bad line
`);
  assert.deepEqual(parsed, { A: '1', B: 'two words', C: 'single', D: 'spaced' });
});

test('normalizeBaseUrl 补 /v1 与去尾斜杠', () => {
  assert.equal(normalizeBaseUrl('https://a.com'), 'https://a.com/v1');
  assert.equal(normalizeBaseUrl('https://a.com/'), 'https://a.com/v1');
  assert.equal(normalizeBaseUrl('https://a.com/v1/'), 'https://a.com/v1');
  assert.equal(normalizeBaseUrl('https://a.com/api/v1'), 'https://a.com/api/v1');
  assert.equal(normalizeBaseUrl('http://127.0.0.1:11434/v1'), 'http://127.0.0.1:11434/v1');
  assert.equal(normalizeBaseUrl(''), '');
});

test('配置校验：非法值给出明确错误', () => {
  const env = isolate();
  const { config } = loadConfig();
  assert.throws(
    () => validateConfig({ ...config, approval_policy: 'yolo' }),
    /approval_policy/,
  );
  assert.throws(
    () => validateConfig({ ...config, provider: 'missing', providers: {} }),
    /不存在/,
  );
  assert.throws(
    () => validateConfig({ ...config, providers: { a: { type: 'grpc' } } }),
    /type/,
  );
  assert.throws(() => validateConfig({ ...config, max_turns: 0 }), /max_turns/);
  env.restore();
});

test('环境变量覆盖模型与审批策略', () => {
  const env = isolate();
  fs.writeFileSync(
    configPath(),
    `model = "file-model"\nprovider = "p"\napproval_policy = "ask"\n[providers.p]\ntype = "openai"\nbase_url = "https://x/v1"\nenv_key = "K"\n`,
  );
  process.env.CODETX_MODEL = 'env-model';
  process.env.CODETX_APPROVAL_POLICY = 'full';
  const { config } = loadConfig();
  assert.equal(config.model, 'env-model');
  assert.equal(config.approval_policy, 'full');
  env.restore();
});

test('配置文件语法错误给出可读定位', () => {
  const env = isolate();
  fs.writeFileSync(configPath(), 'model = \n');
  assert.throws(() => loadConfig(), (err) => {
    assert.ok(err instanceof ConfigError);
    assert.match(err.message, /解析失败|缺少值/);
    return true;
  });
  env.restore();
});

test('dotted path 读写与类型转换', () => {
  const obj = {};
  setPath(obj, 'providers.relay.base_url', 'https://a/v1');
  assert.deepEqual(obj, { providers: { relay: { base_url: 'https://a/v1' } } });
  assert.equal(getPath(obj, 'providers.relay.base_url'), 'https://a/v1');
  assert.equal(getPath(obj, 'nope.x'), undefined);
  assert.equal(coerceValue('true'), true);
  assert.equal(coerceValue('42'), 42);
  assert.equal(coerceValue('0.5'), 0.5);
  assert.deepEqual(coerceValue('[1,2]'), [1, 2]);
  assert.equal(coerceValue('plain'), 'plain');
});

test('maskKey 脱敏', () => {
  assert.equal(maskKey('sk-1234567890abcdef'), 'sk-1…cdef');
  assert.equal(maskKey(''), '');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, configPath, envPath, loadDotEnvSync } from '../src/config.js';
import { saveProvider, upsertEnv, removeEnv } from '../src/provider-setup.js';

function isolate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codetx-setup-'));
  process.env.CODETX_HOME = dir;
  return {
    dir,
    restore() {
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.CODETX_HOME;
    },
  };
}

test('saveProvider：补 /v1、写 config.toml 与 .env', async () => {
  const env = isolate();
  const { config } = loadConfig();
  await saveProvider(config, {
    name: 'relay',
    baseUrl: 'http://127.0.0.1:8080',
    type: 'openai',
    apiKey: 'sk-abc123',
    model: 'm1',
    models: ['m1', 'm2'],
    contextWindow: 100000,
  });
  const saved = fs.readFileSync(configPath(), 'utf8');
  assert.match(saved, /base_url = "http:\/\/127\.0\.0\.1:8080\/v1"/);
  assert.match(saved, /models = \["m1", "m2"\]/);
  assert.equal(loadDotEnvSync().CODETX_RELAY_KEY, 'sk-abc123');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(envPath()).mode & 0o777, 0o600);
  }
  const reloaded = loadConfig().config;
  assert.equal(reloaded.provider, 'relay');
  assert.equal(reloaded.model, 'm1');
  env.restore();
});

test('upsertEnv / removeEnv 保留其它变量', async () => {
  const env = isolate();
  await upsertEnv('A', '1');
  await upsertEnv('B', '2');
  await upsertEnv('A', '3');
  assert.equal(loadDotEnvSync().A, '3');
  assert.equal(loadDotEnvSync().B, '2');
  await removeEnv('A');
  assert.equal(loadDotEnvSync().A, undefined);
  assert.equal(loadDotEnvSync().B, '2');
  env.restore();
});

test('saveProvider 拒绝非法 type', async () => {
  const env = isolate();
  const { config } = loadConfig();
  await assert.rejects(
    () => saveProvider(config, { baseUrl: 'https://x/v1', type: 'grpc' }),
    /openai 或 responses/,
  );
  env.restore();
});

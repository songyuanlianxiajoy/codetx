import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore } from '../src/session.js';

function isolate() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codetx-session-'));
  process.env.CODETX_HOME = dir;
  return {
    dir,
    restore() {
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.CODETX_HOME;
    },
  };
}

test('会话创建 / 追加 / 载入', async () => {
  const env = isolate();
  const store = new SessionStore();
  const { id, meta } = await store.create({
    cwd: '/tmp/work',
    model: 'm1',
    provider: 'relay',
    policy: 'ask',
  });
  assert.equal(meta.id, id);
  assert.ok(store.exists(id));

  await store.append(id, { role: 'user', content: '你好' });
  await store.append(id, { role: 'assistant', content: '你好呀', toolCalls: [] });

  const loaded = await store.load(id);
  assert.equal(loaded.meta.model, 'm1');
  assert.deepEqual(
    loaded.messages.map((m) => m.role),
    ['user', 'assistant'],
  );

  const title = await store.setTitle(id, '打个招呼');
  assert.equal(title.title, '打个招呼');
  const reloaded = await store.load(id, { withMessages: false });
  assert.equal(reloaded.meta.title, '打个招呼');
  assert.deepEqual(reloaded.messages, []);

  const list = await store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, '打个招呼');
  assert.equal((await store.latest()).id, id);

  await store.remove(id);
  assert.equal(store.exists(id), false);
  env.restore();
});

test('会话损坏行会被跳过（断点续传）', async () => {
  const env = isolate();
  const store = new SessionStore();
  await store.init();
  const id = 'broken-test';
  const file = path.join(env.dir, 'sessions', `${id}.jsonl`);
  fs.writeFileSync(
    file,
    `${JSON.stringify({ type: 'meta', id, createdAt: new Date().toISOString(), cwd: '/x' })}\n` +
      `{"type":"message","message":{"role":"user","content":"ok"}}\n` +
      `{broken json\n` +
      `{"type":"message","message":{"role":"assistant","content":"fine"}}\n`,
  );
  const loaded = await store.load(id);
  assert.equal(loaded.messages.length, 2);
  env.restore();
});

test('空会话文件给出明确错误', async () => {
  const env = isolate();
  const store = new SessionStore();
  await store.init();
  fs.writeFileSync(path.join(env.dir, 'sessions', 'empty.jsonl'), '');
  await assert.rejects(() => store.load('empty'), /为空/);
  env.restore();
});

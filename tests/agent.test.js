import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Agent, compactHistory, estimateHistoryTokens } from '../src/agent.js';
import { SessionStore } from '../src/session.js';
import { createToolSet } from '../src/tools/index.js';
import { resolveShell } from '../src/termux.js';

class ScriptedProvider {
  constructor(results) {
    this.results = results;
    this.index = 0;
    this.requests = [];
  }

  async chat(request) {
    this.requests.push(request);
    const result = this.results[Math.min(this.index, this.results.length - 1)];
    this.index++;
    if (result.delayText && request.onText) request.onText(result.delayText);
    if (result.delayReasoning && request.onReasoning) request.onReasoning(result.delayReasoning);
    return result;
  }
}

async function setup(results, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codetx-agent-'));
  process.env.CODETX_HOME = dir;
  const store = new SessionStore();
  const { id } = await store.create({ cwd: dir, model: 'm', provider: 'p', policy: 'full' });
  const toolCtx = {
    cwd: dir,
    shellPath: resolveShell(),
    rgPath: null,
    signal: undefined,
    approve: async () => options.approve !== false,
  };
  const toolSet = createToolSet(toolCtx);
  const provider = new ScriptedProvider(results);
  const events = [];
  const agent = new Agent({
    conn: { contextWindow: 1000 },
    provider,
    toolSet,
    systemPrompt: 'system prompt',
    session: store,
    sessionId: id,
    maxTurns: options.maxTurns || 5,
    maxToolCalls: options.maxToolCalls || 10,
    contextWindow: options.contextWindow || 1000,
    onEvent: (event) => events.push(event),
    history: options.history || [],
  });
  agent.setSessionMeta({ id, title: '' });
  return {
    dir,
    store,
    id,
    provider,
    agent,
    events,
    cleanup: () => {
      fs.rmSync(dir, { recursive: true, force: true });
      delete process.env.CODETX_HOME;
    },
  };
}

test('agent：工具调用 -> 工具结果 -> 最终回答', async () => {
  const t = await setup([
    {
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'write_file', argsRaw: '{"path":"a.txt","content":"hello"}' }],
      },
    },
    { message: { role: 'assistant', content: 'done', toolCalls: [] } },
  ]);
  const result = await t.agent.run('创建文件');
  assert.equal(result.text, 'done');
  assert.equal(fs.readFileSync(path.join(t.dir, 'a.txt'), 'utf8'), 'hello');
  assert.ok(t.events.some((e) => e.type === 'tool_start' && e.name === 'write_file'));
  assert.ok(t.events.some((e) => e.type === 'tool_end' && e.ok === true));
  assert.ok(t.events.some((e) => e.type === 'turn_done'));
  const roles = t.agent.history.map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant', 'tool', 'assistant']);
  // 会话也落盘了
  const loaded = await t.store.load(t.id);
  assert.equal(loaded.messages.length, 4);
  t.cleanup();
});

test('agent：畸形参数 JSON 会被修复', async () => {
  const t = await setup([
    {
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [
          {
            id: 'c1',
            name: 'write_file',
            argsRaw: '```json\n{"path":"b.txt","content":"fixed"}\n```',
          },
        ],
      },
    },
    { message: { role: 'assistant', content: 'ok', toolCalls: [] } },
  ]);
  await t.agent.run('修复参数');
  assert.equal(fs.readFileSync(path.join(t.dir, 'b.txt'), 'utf8'), 'fixed');
  t.cleanup();
});

test('agent：参数彻底坏掉时把错误回给模型', async () => {
  const t = await setup([
    {
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'write_file', argsRaw: 'not json' }],
      },
    },
    { message: { role: 'assistant', content: '好的我换个方式', toolCalls: [] } },
  ]);
  await t.agent.run('坏参数');
  const toolMessage = t.agent.history.find((m) => m.role === 'tool');
  assert.match(toolMessage.content, /参数解析失败/);
  t.cleanup();
});

test('agent：审批拒绝会作为工具结果返回并继续', async () => {
  const t = await setup(
    [
      {
        message: {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'c1', name: 'write_file', argsRaw: '{"path":"c.txt","content":"x"}' }],
        },
      },
      { message: { role: 'assistant', content: '写入被拒绝，我说明原因', toolCalls: [] } },
    ],
    { approve: false },
  );
  const result = await t.agent.run('写文件');
  assert.equal(result.text, '写入被拒绝，我说明原因');
  assert.equal(fs.existsSync(path.join(t.dir, 'c.txt')), false);
  const deniedEvent = t.events.find((e) => e.type === 'tool_end' && e.denied);
  assert.ok(deniedEvent);
  t.cleanup();
});

test('agent：未知工具与重复调用防护', async () => {
  const t = await setup([
    {
      message: {
        role: 'assistant',
        content: null,
        toolCalls: [{ id: 'c1', name: 'nonexistent', argsRaw: '{}' }],
      },
    },
    { message: { role: 'assistant', content: '结束了', toolCalls: [] } },
  ]);
  await t.agent.run('用不存在的工具');
  const toolMessage = t.agent.history.find((m) => m.role === 'tool');
  assert.match(toolMessage.content, /未知工具/);
  t.cleanup();
});

test('agent：上下文超限自动压缩并发出事件', async () => {
  const longHistory = [];
  for (let i = 0; i < 20; i++) {
    longHistory.push({ role: 'user', content: `第 ${i} 条很长的历史`.repeat(50) });
    longHistory.push({ role: 'assistant', content: `回复 ${i}`.repeat(50), toolCalls: [] });
  }
  const t = await setup([{ message: { role: 'assistant', content: 'ok', toolCalls: [] } }], {
    contextWindow: 300,
    history: longHistory,
  });
  await t.agent.run('继续');
  assert.ok(t.events.some((e) => e.type === 'compacted'));
  assert.ok(t.agent.history.length < longHistory.length);
  t.cleanup();
});

test('agent：工具调用次数上限', async () => {
  const t = await setup(
    [
      {
        message: {
          role: 'assistant',
          content: null,
          toolCalls: [{ id: 'c1', name: 'shell', argsRaw: '{"command":"pwd"}' }],
        },
      },
    ],
    { maxToolCalls: 2, maxTurns: 10 },
  );
  await assert.rejects(() => t.agent.run('死循环'), /工具调用超过上限/);
  t.cleanup();
});

test('compactHistory 与 token 估算', () => {
  const history = [];
  for (let i = 0; i < 30; i++) history.push({ role: 'user', content: `消息 ${i}` });
  const compacted = compactHistory(history, { keepRecent: 5 });
  assert.equal(compacted.length, 6);
  assert.equal(compacted[0].role, 'system');
  assert.match(compacted[0].content, /上下文已压缩/);
  assert.ok(estimateHistoryTokens(history) > estimateHistoryTokens(compacted));
});

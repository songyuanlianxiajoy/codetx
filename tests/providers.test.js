import test from 'node:test';
import assert from 'node:assert/strict';
import { ChatProvider } from '../src/providers/chat.js';
import { ResponsesProvider, toResponsesInput } from '../src/providers/responses.js';
import { SseDecoder } from '../src/http.js';
import { ProviderError } from '../src/providers/common.js';

const enc = new TextEncoder();

function sseResponse(chunks, { status = 200 } = {}) {
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(enc.encode(chunk));
      controller.close();
    },
  });
  return new Response(stream, { status, headers: { 'content-type': 'text/event-stream' } });
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function makeConn(overrides = {}) {
  return {
    providerName: 'relay',
    providerType: 'openai',
    baseUrl: 'https://api.test/v1',
    apiKey: 'sk-test',
    model: 'mock-model',
    headers: {},
    includeUsage: true,
    timeoutMs: 5000,
    idleTimeoutMs: 5000,
    retries: 0,
    contextWindow: 1000,
    ...overrides,
  };
}

test('SseDecoder：多行 data / CRLF / 注释', () => {
  const decoder = new SseDecoder();
  const events = [];
  for (const chunk of decoder.feed(': ping\r\ndata: {\r\n')) events.push(...chunk);
  for (const event of decoder.feed('data: "a":1}\r\n\r\n')) events.push(event);
  for (const event of decoder.flush()) events.push(event);
  assert.equal(events.length, 1);
  assert.equal(events[0].data, '{\n"a":1}');
});

test('chat：文本流 + 工具调用 + usage', async () => {
  const chunks = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'Hello ' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'world' } }] })}\n\n`,
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'call_1', function: { name: 'shell', arguments: '{"command":"ls"}' } }],
          },
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ finish_reason: 'tool_calls' }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    })}\n\n`,
    'data: [DONE]\n\n',
  ];
  let capturedBody = null;
  const provider = new ChatProvider(makeConn(), {
    fetchImpl: async (url, init) => {
      capturedBody = JSON.parse(init.body);
      return sseResponse(chunks);
    },
  });
  const deltas = [];
  const result = await provider.chat({
    system: 'sys',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'shell', description: 'run', parameters: { type: 'object' } }],
    onText: (text) => deltas.push(text),
  });
  assert.equal(deltas.join(''), 'Hello world');
  assert.equal(result.message.content, 'Hello world');
  assert.equal(result.message.toolCalls.length, 1);
  assert.equal(result.message.toolCalls[0].name, 'shell');
  assert.deepEqual(JSON.parse(result.message.toolCalls[0].argsRaw), { command: 'ls' });
  assert.deepEqual(result.usage, { input: 10, output: 5, total: 15, cached: 0 });
  assert.equal(capturedBody.stream, true);
  assert.equal(capturedBody.messages[0].role, 'system');
  assert.equal(capturedBody.tools[0].type, 'function');
});

test('chat：工具参数分片拼接', async () => {
  const chunks = [
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{"pa' } }],
          },
        },
      ],
    })}\n\n`,
    `data: ${JSON.stringify({
      choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] } }],
    })}\n\n`,
    'data: [DONE]\n\n',
  ];
  const provider = new ChatProvider(makeConn(), { fetchImpl: async () => sseResponse(chunks) });
  const result = await provider.chat({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [] });
  assert.deepEqual(JSON.parse(result.message.toolCalls[0].argsRaw), { path: 'a.txt' });
});

test('chat：服务端无视 stream 返回整包 JSON', async () => {
  const provider = new ChatProvider(makeConn(), {
    fetchImpl: async () =>
      jsonResponse({ choices: [{ message: { content: '整包回复', tool_calls: [] } }], usage: { total_tokens: 3 } }),
  });
  const result = await provider.chat({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [] });
  assert.equal(result.message.content, '整包回复');
});

test('chat：5xx 自动重试', async () => {
  let calls = 0;
  const provider = new ChatProvider(makeConn({ retries: 1 }), {
    fetchImpl: async () => {
      calls++;
      if (calls === 1) return jsonResponse({ error: { message: 'upstream busy' } }, 503);
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    },
  });
  const result = await provider.chat({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [] });
  assert.equal(calls, 2);
  assert.equal(result.message.content, 'ok');
});

test('chat：站点不支持 stream_options 时自动去掉重试', async () => {
  const bodies = [];
  const provider = new ChatProvider(makeConn({ retries: 0 }), {
    fetchImpl: async (url, init) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) {
        return jsonResponse({ error: { message: 'unknown field stream_options' } }, 400);
      }
      return sseResponse([
        `data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`,
        'data: [DONE]\n\n',
      ]);
    },
  });
  const result = await provider.chat({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [] });
  assert.equal(result.message.content, 'ok');
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].stream_options != null, true);
  assert.equal(bodies[1].stream_options == null, true);
});

test('chat：空响应给出中文可读错误', async () => {
  const provider = new ChatProvider(makeConn(), {
    fetchImpl: async () => sseResponse([`data: ${JSON.stringify({ choices: [{ delta: {} }] })}\n\ndata: [DONE]\n\n`]),
  });
  await assert.rejects(
    () => provider.chat({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [] }),
    /没有返回任何内容/,
  );
});

test('responses：事件流、工具调用、usage、rawOutput', async () => {
  const events = [
    { type: 'response.created', response: { model: 'mock-model' } },
    {
      type: 'response.output_item.added',
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'shell', arguments: '' },
    },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '{"command":' },
    { type: 'response.function_call_arguments.delta', item_id: 'fc_1', delta: '"pwd"}' },
    { type: 'response.output_text.delta', delta: 'ok' },
    {
      type: 'response.completed',
      response: {
        status: 'completed',
        output: [
          { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
          { type: 'function_call', id: 'fc_1', call_id: 'call_9', name: 'shell', arguments: '{"command":"pwd"}' },
        ],
        usage: { input_tokens: 7, output_tokens: 2, total_tokens: 9 },
      },
    },
  ];
  const chunks = events.map((event) => `data: ${JSON.stringify(event)}\n\n`);
  chunks.push('data: [DONE]\n\n');

  const provider = new ResponsesProvider(makeConn({ providerType: 'responses' }), {
    fetchImpl: async (url, init) => {
      assert.equal(url, 'https://api.test/v1/responses');
      const body = JSON.parse(init.body);
      assert.equal(body.store, false);
      assert.ok(Array.isArray(body.input));
      return sseResponse(chunks);
    },
  });
  const result = await provider.chat({ system: 'sys', messages: [{ role: 'user', content: 'x' }], tools: [] });
  assert.equal(result.message.content, 'ok');
  assert.equal(result.message.toolCalls[0].id, 'call_9');
  assert.deepEqual(JSON.parse(result.message.toolCalls[0].argsRaw), { command: 'pwd' });
  assert.deepEqual(result.usage, { input: 7, output: 2, total: 9, cached: 0 });
  assert.equal(result.message.meta.rawOutput.length, 2);
});

test('responses：response.failed 抛 ProviderError', async () => {
  const provider = new ResponsesProvider(makeConn({ providerType: 'responses' }), {
    fetchImpl: async () =>
      sseResponse([
        `data: ${JSON.stringify({ type: 'response.failed', response: { error: { message: 'bad model' } } })}\n\n`,
      ]),
  });
  await assert.rejects(
    () =>
      provider.chat({ system: '', messages: [{ role: 'user', content: 'x' }], tools: [] }),
    (err) => {
      assert.ok(err instanceof ProviderError);
      assert.match(err.message, /bad model/);
      return true;
    },
  );
});

test('toResponsesInput：消息/工具调用/工具结果', () => {
  const input = toResponsesInput([
    { role: 'user', content: 'hi' },
    {
      role: 'assistant',
      content: '想一下',
      toolCalls: [{ id: 'c1', name: 'shell', argsRaw: '{"command":"ls"}' }],
    },
    { role: 'tool', toolCallId: 'c1', content: 'out' },
  ]);
  assert.deepEqual(input[0], { role: 'user', content: 'hi' });
  assert.equal(input[1].type, 'message');
  assert.equal(input[1].content[0].text, '想一下');
  assert.equal(input[2].type, 'function_call');
  assert.equal(input[2].call_id, 'c1');
  assert.equal(input[3].type, 'function_call_output');
  assert.equal(input[3].output, 'out');
});

test('chat：toChatMessages 保持工具调用结构', async () => {
  let body;
  const provider = new ChatProvider(makeConn(), {
    fetchImpl: async (url, init) => {
      body = JSON.parse(init.body);
      return sseResponse(['data: [DONE]\n\n']);
    },
  });
  await assert.rejects(() =>
    provider.chat({
      system: 'sys',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: null, toolCalls: [{ id: 'c1', name: 'shell', argsRaw: '{"command":"ls"}' }] },
        { role: 'tool', toolCallId: 'c1', content: 'out' },
      ],
      tools: [],
    }),
  );
  const messages = body.messages;
  assert.equal(messages[0].role, 'system');
  assert.equal(messages[1].role, 'user');
  assert.equal(messages[2].role, 'assistant');
  assert.equal(messages[2].tool_calls[0].function.name, 'shell');
  assert.equal(messages[2].tool_calls[0].function.arguments, '{"command":"ls"}');
  assert.equal(messages[3].role, 'tool');
  assert.equal(messages[3].tool_call_id, 'c1');
});

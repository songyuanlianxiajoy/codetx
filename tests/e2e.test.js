import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'codetx.js');

function startMockServer() {
  const requests = [];
  let callCount = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        requests.push(JSON.parse(body));
      } catch {
        requests.push({ raw: body });
      }
      callCount++;
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      if (callCount % 2 === 1) {
        const args = JSON.stringify({ path: 'e2e.txt', content: '来自 e2e 的内容\n' });
        res.write(
          `data: ${JSON.stringify({
            choices: [
              {
                delta: {
                  tool_calls: [{ index: 0, id: `call_${callCount}`, function: { name: 'write_file', arguments: args } }],
                },
              },
            ],
          })}\n\n`,
        );
        res.write(`data: ${JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] })}\n\n`);
      } else {
        res.write(
          `data: ${JSON.stringify({ choices: [{ delta: { content: '已完成：文件已创建。' } }] })}\n\n`,
        );
      }
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, port, requests });
    });
  });
}

function runCodetx(args, { cwd, env }) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [BIN, ...args], {
      cwd,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    const timer = setTimeout(() => child.kill('SIGKILL'), 30000);
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

test('端到端：exec + 工具调用 + 文件落盘 + --output-last-message', async () => {
  const { server, port, requests } = await startMockServer();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codetx-e2e-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codetx-e2e-work-'));
  try {
    const result = await runCodetx(
      ['exec', '--full-auto', '--output-last-message', 'last.txt', '创建 e2e.txt'],
      {
        cwd: work,
        env: {
          CODETX_HOME: home,
          CODETX_BASE_URL: `http://127.0.0.1:${port}/v1`,
          CODETX_API_KEY: 'sk-e2e',
          CODETX_MODEL: 'mock-model',
        },
      },
    );
    assert.equal(result.code, 0, `exit=${result.code}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
    assert.match(result.stdout, /已完成：文件已创建/);
    assert.match(fs.readFileSync(path.join(work, 'e2e.txt'), 'utf8'), /来自 e2e 的内容/);
    assert.match(fs.readFileSync(path.join(work, 'last.txt'), 'utf8'), /已完成/);
    assert.equal(requests.length, 2);
    assert.equal(requests[0].model, 'mock-model');
    assert.ok(Array.isArray(requests[0].tools));
    // 第二次请求带上了工具结果
    const toolMessages = requests[1].messages.filter((m) => m.role === 'tool');
    assert.equal(toolMessages.length, 1);
    assert.match(toolMessages[0].content, /已创建 e2e\.txt/);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('端到端：--json 输出 JSONL 事件', async () => {
  const { server, port } = await startMockServer();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codetx-e2e-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codetx-e2e-work-'));
  try {
    const result = await runCodetx(['exec', '--full-auto', '--json', '创建文件'], {
      cwd: work,
      env: {
        CODETX_HOME: home,
        CODETX_BASE_URL: `http://127.0.0.1:${port}/v1`,
        CODETX_API_KEY: 'sk-e2e',
        CODETX_MODEL: 'mock-model',
      },
    });
    assert.equal(result.code, 0);
    const events = result.stdout
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.ok(events.some((e) => e.type === 'tool_start' && e.name === 'write_file'));
    assert.ok(events.some((e) => e.type === 'tool_end' && e.ok === true));
    assert.ok(events.some((e) => e.type === 'turn_done' && /已完成/.test(e.text)));
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('端到端：非 TTY 下 ask 策略拒绝写入并提示 --full-auto', async () => {
  const { server, port } = await startMockServer();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codetx-e2e-home-'));
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'codetx-e2e-work-'));
  try {
    const result = await runCodetx(['exec', '创建文件'], {
      cwd: work,
      env: {
        CODETX_HOME: home,
        CODETX_BASE_URL: `http://127.0.0.1:${port}/v1`,
        CODETX_API_KEY: 'sk-e2e',
        CODETX_MODEL: 'mock-model',
      },
    });
    assert.equal(result.code, 0);
    assert.equal(fs.existsSync(path.join(work, 'e2e.txt')), false);
    assert.match(result.stderr, /需要审批|full-auto|拒绝/);
  } finally {
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('端到端：sessions 列出刚才的会话', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codetx-e2e-home-'));
  try {
    const sessionsDir = path.join(home, 'sessions');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionsDir, '2026-01-01-000000-abcdef.jsonl'),
      `${JSON.stringify({
        type: 'meta',
        id: '2026-01-01-000000-abcdef',
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        cwd: '/tmp',
        model: 'mock-model',
        provider: 'env',
        title: '测试会话',
        turns: 1,
      })}\n`,
    );
    const result = await runCodetx(['sessions'], {
      cwd: home,
      env: { CODETX_HOME: home },
    });
    assert.equal(result.code, 0);
    assert.match(result.stdout, /测试会话/);
    assert.match(result.stdout, /2026-01-01-000000-abcdef/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

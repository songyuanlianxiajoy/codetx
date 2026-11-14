import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  parseToolArgs,
  buildDiff,
  truncateMiddle,
  estimateTokens,
  isInside,
  atomicWrite,
  formatDuration,
  formatTokens,
  summarizeArgs,
  expandTilde,
} from '../src/util.js';

test('parseToolArgs：正常 JSON', () => {
  assert.deepEqual(parseToolArgs('{"command":"ls"}'), { command: 'ls' });
  assert.deepEqual(parseToolArgs(''), {});
  assert.deepEqual(parseToolArgs(null), {});
});

test('parseToolArgs：修复 code fence / 多包一层 / 尾逗号 / 前后废话', () => {
  assert.deepEqual(parseToolArgs('```json\n{"path":"a.txt"}\n```'), { path: 'a.txt' });
  assert.deepEqual(parseToolArgs('{"arguments":{"command":"pwd"}}'), { command: 'pwd' });
  assert.deepEqual(parseToolArgs('{"a":1,}'), { a: 1 });
  assert.deepEqual(parseToolArgs('这是参数：{"a":1} 完毕'), { a: 1 });
  assert.deepEqual(parseToolArgs('{"a":{"b":1}}'), { a: { b: 1 } });
});

test('parseToolArgs：双重编码', () => {
  assert.deepEqual(parseToolArgs('"{\\"x\\":1}"'), { x: 1 });
});

test('parseToolArgs：实在解析不了要抛错', () => {
  assert.throws(() => parseToolArgs('not json at all'), /不是合法 JSON/);
});

test('buildDiff：修改一行', () => {
  const diff = buildDiff('a\nb\nc\n', 'a\nB\nc\n', { file: 'x.txt' });
  assert.ok(diff.length >= 5);
  assert.equal(diff[0], '--- a/x.txt');
  assert.equal(diff[1], '+++ b/x.txt');
  assert.ok(diff.some((line) => line === '-b'));
  assert.ok(diff.some((line) => line === '+B'));
});

test('buildDiff：无改动返回空数组', () => {
  assert.deepEqual(buildDiff('same\n', 'same\n'), []);
});

test('buildDiff：新增文件', () => {
  const diff = buildDiff('', 'hello\nworld\n', { file: 'new.txt' });
  assert.equal(diff[0], '--- /dev/null');
  assert.ok(diff.includes('+hello'));
  assert.ok(diff.includes('+world'));
});

test('truncateMiddle / estimateTokens / 格式化', () => {
  const text = 'a'.repeat(100);
  const cut = truncateMiddle(text, 40);
  assert.ok(cut.includes('已省略'));
  assert.ok(cut.length < 100);
  assert.ok(estimateTokens('你好') > 0);
  assert.equal(formatDuration(1500), '1.5s');
  assert.equal(formatTokens(1200), '1.2k');
  assert.equal(summarizeArgs({ a: 1, b: 'x' }), 'a=1 b=x');
});

test('isInside 与 expandTilde', () => {
  assert.equal(isInside('/a/b/c', '/a/b'), true);
  assert.equal(isInside('/a/bc', '/a/b'), false);
  assert.equal(expandTilde('~/x', '/home/u'), '/home/u/x');
  assert.equal(expandTilde('~', '/home/u'), '/home/u');
});

test('atomicWrite 原子落盘并设置权限', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codetx-util-'));
  const file = path.join(dir, 'secret.env');
  await atomicWrite(file, 'KEY=1\n', 0o600);
  assert.equal(fs.readFileSync(file, 'utf8'), 'KEY=1\n');
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }
  fs.rmSync(dir, { recursive: true, force: true });
});

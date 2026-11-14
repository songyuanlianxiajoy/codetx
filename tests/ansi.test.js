import test from 'node:test';
import assert from 'node:assert/strict';
import { width, stripAnsi, truncate, padEnd, st, setColorEnabled, sanitize } from '../src/ansi.js';

test('显示宽度：ASCII / 中文 / 全角 / emoji', () => {
  assert.equal(width('abc'), 3);
  assert.equal(width('中文'), 4);
  assert.equal(width('a中'), 3);
  assert.equal(width('，'), 2);
  assert.equal(width('😀'), 2);
  assert.equal(width('👍🏽'), 4); // 基础 emoji + 肤色修饰
});

test('stripAnsi 去色后宽度不变', () => {
  setColorEnabled(true);
  const colored = st.red('hello');
  assert.notEqual(colored, 'hello');
  assert.equal(stripAnsi(colored), 'hello');
  assert.equal(width(colored), 5);
  setColorEnabled(false);
  assert.equal(st.red('hello'), 'hello');
});

test('truncate 按显示宽度截断', () => {
  assert.equal(truncate('中文测试', 5), '中文…');
  assert.equal(width(truncate('中文测试', 5)) <= 5, true);
  assert.equal(truncate('abc', 10), 'abc');
});

test('padEnd 补齐到显示宽度', () => {
  assert.equal(padEnd('中', 4), '中  ');
  assert.equal(width(padEnd('中', 4)), 4);
});

test('sanitize 清理控制字符但保留换行', () => {
  assert.equal(sanitize('a\x01b\nc'), 'ab\nc');
});

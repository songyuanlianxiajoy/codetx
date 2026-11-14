import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, stringify, deepMerge } from '../src/toml.js';

test('解析基本键值与表', () => {
  const config = parse(`
# 注释
model = "gpt-5.6-sol"
provider = "relay"
max_turns = 40
show_reasoning = false
ratio = 0.75

[providers.relay]
type = "openai"
base_url = "https://api.example.com/v1"
models = ["a", "b"]
`);
  assert.equal(config.model, 'gpt-5.6-sol');
  assert.equal(config.max_turns, 40);
  assert.equal(config.show_reasoning, false);
  assert.equal(config.ratio, 0.75);
  assert.equal(config.providers.relay.base_url, 'https://api.example.com/v1');
  assert.deepEqual(config.providers.relay.models, ['a', 'b']);
});

test('字符串转义、字面量与点号键', () => {
  const config = parse(`
title = "a\\tb\\n"
literal = 'C:\\path\\to'
a.b.c = true
`);
  assert.equal(config.title, 'a\tb\n');
  assert.equal(config.literal, 'C:\\path\\to');
  assert.deepEqual(config.a, { b: { c: true } });
});

test('内联表', () => {
  const config = parse(`headers = { "x-title" = "codetx", "x-y" = 1 }`);
  assert.deepEqual(config.headers, { 'x-title': 'codetx', 'x-y': 1 });
});

test('注释与 # 出现在字符串里', () => {
  const config = parse(`color = "#fff" # 这才是注释`);
  assert.equal(config.color, '#fff');
});

test('序列化后可再次解析（roundtrip）', () => {
  const original = {
    model: 'x',
    provider: 'relay',
    max_turns: 3,
    show_reasoning: true,
    providers: {
      relay: {
        type: 'openai',
        base_url: 'https://a.b/v1',
        env_key: 'KEY',
        models: ['a', 'b'],
      },
    },
  };
  const text = stringify(original);
  const parsed = parse(text);
  assert.deepEqual(parsed, original);
});

test('不支持语法与非法输入明确报错', () => {
  assert.throws(() => parse('a = '), /缺少值|无法识别/);
  assert.throws(() => parse('[[x]]'), /数组表/);
  assert.throws(() => parse('a b = 1'), /缺少 =|非法键名/);
  assert.throws(() => parse('[a]\nb = 1\n[a]\nc = 2\n'), /重复|冲突|无法/);
});

test('deepMerge 递归合并且数组整体替换', () => {
  const base = { a: { x: 1, arr: [1, 2] }, b: 2 };
  const override = { a: { y: 3, arr: [9] } };
  assert.deepEqual(deepMerge(base, override), { a: { x: 1, y: 3, arr: [9] }, b: 2 });
});

test('空文件返回空对象', () => {
  assert.deepEqual(parse(''), {});
  assert.deepEqual(parse('\n# only comments\n'), {});
});

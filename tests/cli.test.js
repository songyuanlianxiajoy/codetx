import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArgs } from '../src/main.js';
import { completionScript } from '../src/completion.js';

test('parseArgs：默认交互与位置参数', () => {
  assert.deepEqual(parseArgs([]), { command: 'interactive', options: {}, positional: [] });
  const parsed = parseArgs(['修复登录 bug', '并加测试']);
  assert.equal(parsed.command, 'interactive');
  assert.deepEqual(parsed.positional, ['修复登录 bug', '并加测试']);
});

test('parseArgs：子命令与别名', () => {
  assert.equal(parseArgs(['exec', 'do it']).command, 'exec');
  assert.equal(parseArgs(['e', 'do it']).command, 'exec');
  assert.equal(parseArgs(['doctor', '--probe']).command, 'doctor');
});

test('parseArgs：选项（长短、等号、布尔）', () => {
  const parsed = parseArgs([
    'exec',
    '--model',
    'gpt-x',
    '-p',
    'relay',
    '-C',
    '/tmp',
    '--full-auto',
    '--json',
    '--approvals=auto',
    '--output-last-message',
    'out.txt',
    '任务',
  ]);
  assert.equal(parsed.command, 'exec');
  assert.equal(parsed.options.model, 'gpt-x');
  assert.equal(parsed.options.provider, 'relay');
  assert.equal(parsed.options.cd, '/tmp');
  assert.equal(parsed.options.fullAuto, true);
  assert.equal(parsed.options.json, true);
  assert.equal(parsed.options.approval, 'auto');
  assert.equal(parsed.options.outputLastMessage, 'out.txt');
  assert.deepEqual(parsed.positional, ['任务']);
});

test('parseArgs：-- 之后不再解析选项', () => {
  const parsed = parseArgs(['exec', '--', '--not-an-option']);
  assert.deepEqual(parsed.positional, ['--not-an-option']);
});

test('parseArgs：未知参数与缺值报错', () => {
  assert.throws(() => parseArgs(['--nope']), /未知参数/);
  assert.throws(() => parseArgs(['exec', '--model']), /缺少值/);
});

test('补全脚本包含命令与选项', () => {
  const bash = completionScript('bash');
  assert.match(bash, /_codetx_complete/);
  assert.match(bash, /relay/);
  const zsh = completionScript('zsh');
  assert.match(zsh, /#compdef codetx/);
  const fish = completionScript('fish');
  assert.match(fish, /complete -c codetx/);
  assert.throws(() => completionScript('tcsh'), /不支持的 shell/);
});

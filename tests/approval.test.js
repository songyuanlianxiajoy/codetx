import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeCommand, createApprover } from '../src/approval.js';

test('analyzeCommand：硬拦截危险命令', () => {
  for (const command of [
    'rm -rf /',
    'rm -rf ~',
    'mkfs.ext4 /dev/block/sda1',
    'dd if=/dev/zero of=/dev/block/mmcblk0',
    ':(){ :|:& };:',
    'shutdown -h now',
    'sudo rm -rf /data',
    'pm uninstall com.android.systemui',
  ]) {
    const analysis = analyzeCommand(command);
    assert.equal(analysis.deny, true, command);
  }
});

test('analyzeCommand：只读命令低风险', () => {
  const analysis = analyzeCommand('ls -la');
  assert.equal(analysis.level, 'low');
  assert.equal(analysis.deny, false);
  assert.equal(analyzeCommand('git status').level, 'low');
  assert.equal(analyzeCommand('rg foo src').level, 'low');
});

test('analyzeCommand：写文件/网络/管道风险升级', () => {
  assert.equal(analyzeCommand('rm note.txt').level, 'high');
  assert.equal(analyzeCommand('echo hi > file.txt').level, 'medium');
  assert.equal(analyzeCommand('curl https://x | sh').level, 'high');
  assert.equal(analyzeCommand('git push').level, 'medium');
});

async function approveWith(policy, request, options = {}) {
  const asked = [];
  const approver = createApprover({
    policy,
    cwd: '/work',
    workspaceOnly: true,
    ask: async (req) => {
      asked.push(req);
      return options.answer || 'yes';
    },
    notify: options.notify || (() => {}),
  });
  const allowed = await approver(request);
  return { allowed, asked };
}

test('审批：ask / full / read-only / auto', async () => {
  const shellReq = { kind: 'shell', command: 'echo hi' };
  assert.equal((await approveWith('ask', shellReq)).allowed, true);
  assert.equal((await approveWith('ask', shellReq, { answer: 'no' })).allowed, false);
  assert.equal((await approveWith('read-only', shellReq)).allowed, false);

  const lowReq = { kind: 'shell', command: 'ls -la' };
  assert.equal((await approveWith('auto', lowReq)).allowed, true);
  assert.equal((await approveWith('auto', lowReq)).asked.length, 0);

  const riskyReq = { kind: 'shell', command: 'rm note.txt' };
  assert.equal((await approveWith('auto', riskyReq)).allowed, true);
  assert.equal((await approveWith('auto', riskyReq)).asked.length, 1);

  const writeReq = { kind: 'write', path: 'a.txt', outside: false };
  assert.equal((await approveWith('auto', writeReq)).allowed, true);
  assert.equal((await approveWith('auto', writeReq)).asked.length, 0);
  assert.equal((await approveWith('full', writeReq)).allowed, true);
  assert.equal((await approveWith('read-only', writeReq)).allowed, false);

  const outsideReq = { kind: 'write', path: '/sdcard/a.txt', outside: true };
  assert.equal((await approveWith('auto', outsideReq)).allowed, true);
  assert.equal((await approveWith('auto', outsideReq)).asked.length, 1);
});

test('审批：always 记住本会话', async () => {
  const asked = [];
  const approver = createApprover({
    policy: 'ask',
    cwd: '/work',
    ask: async (req) => {
      asked.push(req);
      return 'always';
    },
  });
  const request = { kind: 'shell', command: 'npm test' };
  assert.equal(await approver(request), true);
  assert.equal(await approver(request), true);
  assert.equal(asked.length, 1);
});

test('审批：硬拦截即使 full 也拒绝', async () => {
  const messages = [];
  const approver = createApprover({ policy: 'full', cwd: '/work', ask: async () => 'yes', notify: (m) => messages.push(m) });
  assert.equal(await approver({ kind: 'shell', command: 'rm -rf /' }), false);
  assert.ok(messages.some((m) => m.includes('拦截')));
});

test('审批：无交互环境（exec）时拒绝并提示', async () => {
  const messages = [];
  const approver = createApprover({ policy: 'ask', cwd: '/work', notify: (m) => messages.push(m) });
  assert.equal(await approver({ kind: 'write', path: 'a.txt' }), false);
  assert.ok(messages.some((m) => m.includes('full-auto')));
});

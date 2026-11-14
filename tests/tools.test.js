import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createToolSet } from '../src/tools/index.js';
import { resolveShell } from '../src/termux.js';
import { ToolError } from '../src/tools/common.js';

function setup(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codetx-tools-'));
  const ctx = {
    cwd: dir,
    shellPath: resolveShell(),
    rgPath: null,
    signal: undefined,
    approve: options.approve || (async () => true),
  };
  const set = createToolSet(ctx);
  return {
    dir,
    ctx,
    run: (name, args) => set.byName.get(name).run(args),
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}

test('read_file：行号、offset/limit、缺文件报错', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.dir, 'a.txt'), 'one\ntwo\nthree\nfour\n');
  const all = await t.run('read_file', { path: 'a.txt' });
  assert.match(all.output, /共 4 行/);
  assert.match(all.output, /1\| one/);
  assert.match(all.output, /4\| four/);

  const part = await t.run('read_file', { path: 'a.txt', offset: 2, limit: 2 });
  assert.match(part.output, /2\| two/);
  assert.match(part.output, /3\| three/);
  assert.doesNotMatch(part.output, /1\| one/);
  assert.match(part.output, /还有 1 行/);

  await assert.rejects(() => t.run('read_file', { path: 'nope.txt' }), /文件不存在/);
  t.cleanup();
});

test('write_file：新建、覆盖、diff、拒绝', async () => {
  const t = setup();
  const created = await t.run('write_file', { path: 'sub/b.txt', content: 'hello\n' });
  assert.match(created.output, /已创建 sub\/b.txt/);
  assert.equal(fs.readFileSync(path.join(t.dir, 'sub/b.txt'), 'utf8'), 'hello\n');

  const updated = await t.run('write_file', { path: 'sub/b.txt', content: 'hello world\n' });
  assert.match(updated.output, /已覆盖/);
  assert.ok(updated.diff.some((line) => line.startsWith('-hello')));
  assert.ok(updated.diff.some((line) => line.startsWith('+hello world')));

  const deny = setup({ approve: async () => false });
  await assert.rejects(() => deny.run('write_file', { path: 'x.txt', content: 'x' }), (err) => {
    assert.ok(err instanceof ToolError);
    assert.equal(err.denied, true);
    return true;
  });
  assert.equal(fs.existsSync(path.join(deny.dir, 'x.txt')), false);
  t.cleanup();
  deny.cleanup();
});

test('edit_file：精确替换、多处命中、找不到', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.dir, 'c.txt'), 'alpha beta\ngamma beta\n');

  // beta 出现两次，默认拒绝猜
  await assert.rejects(() => t.run('edit_file', { path: 'c.txt', old_string: 'beta', new_string: 'x' }), /出现了 2 次/);
  await assert.rejects(() => t.run('edit_file', { path: 'c.txt', old_string: 'zzz', new_string: 'x' }), /找不到 old_string/);

  const ok = await t.run('edit_file', { path: 'c.txt', old_string: 'alpha beta', new_string: 'alpha BETA' });
  assert.match(ok.output, /已更新/);
  assert.equal(fs.readFileSync(path.join(t.dir, 'c.txt'), 'utf8'), 'alpha BETA\ngamma beta\n');

  fs.writeFileSync(path.join(t.dir, 'c.txt'), 'alpha beta\ngamma beta\n');
  const all = await t.run('edit_file', { path: 'c.txt', old_string: 'beta', new_string: 'β', replace_all: true });
  assert.match(all.output, /替换 2 处/);
  assert.equal(fs.readFileSync(path.join(t.dir, 'c.txt'), 'utf8'), 'alpha β\ngamma β\n');
  t.cleanup();
});

test('list_dir：目录树与跳过 .git', async () => {
  const t = setup();
  fs.mkdirSync(path.join(t.dir, 'src'));
  fs.writeFileSync(path.join(t.dir, 'src/index.js'), '');
  fs.writeFileSync(path.join(t.dir, 'README.md'), '');
  fs.mkdirSync(path.join(t.dir, '.git'));
  const result = await t.run('list_dir', { path: '.' });
  assert.match(result.output, /src\//);
  assert.match(result.output, /index\.js/);
  assert.match(result.output, /README\.md/);
  assert.doesNotMatch(result.output, /\.git/);
  t.cleanup();
});

test('glob：模式匹配与时间排序', async () => {
  const t = setup();
  fs.mkdirSync(path.join(t.dir, 'src/deep'), { recursive: true });
  fs.writeFileSync(path.join(t.dir, 'a.js'), '');
  fs.writeFileSync(path.join(t.dir, 'src/b.js'), '');
  fs.writeFileSync(path.join(t.dir, 'src/deep/c.ts'), '');
  fs.writeFileSync(path.join(t.dir, 'notes.md'), '');

  const js = await t.run('glob', { pattern: '*.js' });
  assert.match(js.output, /a\.js/);
  assert.match(js.output, /src\/b\.js/);
  assert.doesNotMatch(js.output, /notes\.md/);

  const deep = await t.run('glob', { pattern: '**/*.ts' });
  assert.match(deep.output, /src\/deep\/c\.ts/);

  const none = await t.run('glob', { pattern: '*.rs' });
  assert.match(none.output, /没有匹配到文件/);
  t.cleanup();
});

test('grep：JS 兜底实现（带 include 过滤）', async () => {
  const t = setup();
  fs.mkdirSync(path.join(t.dir, 'src'));
  fs.writeFileSync(path.join(t.dir, 'src/a.js'), 'const needle = 1;\nother\n');
  fs.writeFileSync(path.join(t.dir, 'src/b.py'), 'needle = 2\n');
  const result = await t.run('grep', { pattern: 'needle', include: '*.js' });
  assert.match(result.output, /src\/a\.js:1/);
  assert.doesNotMatch(result.output, /b\.py/);

  const none = await t.run('grep', { pattern: 'nope' });
  assert.match(none.output, /没有匹配到内容/);
  await assert.rejects(() => t.run('grep', { pattern: '(' }), /正则不合法/);
  t.cleanup();
});

test('shell：输出、退出码、非交互 env', async () => {
  const t = setup();
  const ok = await t.run('shell', { command: 'echo hello-world' });
  assert.match(ok.output, /hello-world/);
  assert.equal(ok.meta.exitCode, 0);

  const fail = await t.run('shell', { command: 'echo oops >&2; exit 3' });
  assert.equal(fail.meta.exitCode, 3);
  assert.match(fail.output, /stderr/);

  const denied = setup({ approve: async () => false });
  await assert.rejects(() => denied.run('shell', { command: 'echo x' }), /拒绝/);
  t.cleanup();
  denied.cleanup();
});

test('shell：超时终止', async () => {
  const t = setup();
  const started = Date.now();
  const result = await t.run('shell', { command: 'sleep 5', timeout_ms: 1000 });
  const elapsed = Date.now() - started;
  assert.equal(result.meta.timedOut, true);
  assert.ok(elapsed < 6000, `应该被超时终止，实际 ${elapsed}ms`);
  t.cleanup();
});

test('apply_patch：修改文件', async () => {
  const t = setup();
  fs.writeFileSync(path.join(t.dir, 'p.txt'), 'one\ntwo\nthree\n');
  const patch = `--- a/p.txt\n+++ b/p.txt\n@@ -1,3 +1,3 @@\n one\n-two\n+TWO\n three\n`;
  const result = await t.run('apply_patch', { patch });
  assert.match(result.output, /已应用补丁/);
  assert.equal(fs.readFileSync(path.join(t.dir, 'p.txt'), 'utf8'), 'one\nTWO\nthree\n');

  await assert.rejects(() => t.run('apply_patch', { patch: 'garbage' }), /没有解析到任何文件块/);
  t.cleanup();
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp } from '../src/tools/search.js';
import { parseUnifiedPatch, applyHunks } from '../src/tools/patch.js';

test('globToRegExp：基本通配符', () => {
  assert.equal(globToRegExp('*.js').test('a.js'), true);
  assert.equal(globToRegExp('*.js').test('src/a.js'), false);
  assert.equal(globToRegExp('**/*.js').test('src/deep/a.js'), true);
  assert.equal(globToRegExp('**/*.js').test('a.js'), true);
  assert.equal(globToRegExp('src/**/test?.ts').test('src/a/b/test1.ts'), true);
  assert.equal(globToRegExp('src/**/test?.ts').test('src/a/b/test10.ts'), false);
});

test('globToRegExp：字符集与花括号', () => {
  assert.equal(globToRegExp('file.[jt]s').test('file.ts'), true);
  assert.equal(globToRegExp('file.[!j]s').test('file.ts'), true);
  assert.equal(globToRegExp('{src,lib}/**/*.md').test('lib/a/b.md'), true);
  assert.equal(globToRegExp('{src,lib}/**/*.md').test('test/a.md'), false);
  assert.equal(globToRegExp('a{b,c{d,e}}').test('acd'), true);
});

test('parseUnifiedPatch：单文件多 hunk', () => {
  const files = parseUnifiedPatch(`--- a/x.txt
+++ b/x.txt
@@ -1,3 +1,3 @@
 a
-b
+B
 c
@@ -10,2 +10,2 @@
-x
+X
 y
`);
  assert.equal(files.length, 1);
  assert.equal(files[0].oldPath, 'x.txt');
  assert.equal(files[0].newPath, 'x.txt');
  assert.equal(files[0].hunks.length, 2);
});

test('applyHunks：修改 / 新增 / 删除', () => {
  assert.equal(
    applyHunks('a\nb\nc\n', parseUnifiedPatch(`--- a/x\n+++ b/x\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n`)[0].hunks),
    'a\nB\nc\n',
  );

  const created = applyHunks('', parseUnifiedPatch(`--- /dev/null\n+++ b/new.txt\n@@ -0,0 +1,2 @@\n+hi\n+there\n`)[0].hunks);
  assert.equal(created, 'hi\nthere\n');

  const deleted = applyHunks('a\nb\n', parseUnifiedPatch(`--- a/x\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-a\n-b\n`)[0].hunks);
  assert.equal(deleted, '');
});

test('applyHunks：上下文按偏移容错搜索', () => {
  const text = 'header\n\n\na\nb\nc\n';
  const hunks = parseUnifiedPatch(`--- a/x\n+++ b/x\n@@ -2,3 +2,3 @@\n a\n-b\n+B\n c\n`)[0].hunks;
  assert.equal(applyHunks(text, hunks), 'header\n\n\na\nB\nc\n');
});

test('applyHunks：上下文对不上要报错', () => {
  const hunks = parseUnifiedPatch(`--- a/x\n+++ b/x\n@@ -1,2 +1,2 @@\n-nope\n+yes\n keep\n`)[0].hunks;
  assert.throws(() => applyHunks('completely\ndifferent\n', hunks), /找不到/);
});

test('parseUnifiedPatch：拒绝非法补丁', () => {
  assert.throws(() => parseUnifiedPatch('随便写点什么'), /没有解析到任何文件块/);
  assert.throws(() => parseUnifiedPatch('--- a/x\nnot-plus-plus\n'), /缺少 \+\+\+/);
});

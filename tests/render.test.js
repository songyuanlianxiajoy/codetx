import test from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownRenderer, ReasoningRenderer, renderInline, formatToolResult, formatApprovalPrompt, toolHeadline, Spinner } from '../src/render.js';
import { setColorEnabled, stripAnsi } from '../src/ansi.js';

setColorEnabled(false);

function clean(text) {
  return stripAnsi(text).replace(/\r\x1b\[2K/g, '').replace(/\r/g, '');
}

test('renderInline 去掉 markdown 标记（无色模式）', () => {
  assert.equal(renderInline('**粗** 和 `code`'), '粗 和 code');
  assert.equal(renderInline('[链接](https://a.b)'), '链接');
  assert.equal(renderInline('a *斜* b'), 'a 斜 b');
});

test('MarkdownRenderer：流式正文、列表、代码块', () => {
  let out = '';
  const renderer = new MarkdownRenderer({ out: (s) => (out += s), color: false });
  renderer.push('## 标题\n\n- 第一项\n- 第二项\n\n');
  renderer.push('```js\nconst a = 1;\n```\n');
  renderer.push('结束 **加粗**');
  renderer.flush();
  const text = clean(out);
  assert.match(text, /标题/);
  assert.match(text, /• 第一项/);
  assert.match(text, /┌ js/);
  assert.match(text, /const a = 1;/);
  assert.match(text, /└/);
  assert.match(text, /结束 加粗/);
});

test('MarkdownRenderer：半行会即时渲染并在换行后清掉重画', () => {
  let out = '';
  const renderer = new MarkdownRenderer({ out: (s) => (out += s), color: false, cols: 80 });
  renderer.push('半行');
  assert.ok(out.includes('半行'));
  renderer.push('继续\n');
  renderer.flush();
  assert.equal(clean(out).includes('半行继续'), true);
});

test('ReasoningRenderer 输出暗色行（无色时是纯文本）', () => {
  let out = '';
  const renderer = new ReasoningRenderer({ out: (s) => (out += s) });
  renderer.push('思考一\n思考二');
  renderer.flush();
  assert.match(clean(out), /◌ 思考一/);
  assert.match(clean(out), /◌ 思考二/);
});

test('toolHeadline 摘要', () => {
  assert.deepEqual(toolHeadline('shell', { command: 'ls -la' }), { title: 'shell', detail: 'ls -la' });
  assert.equal(toolHeadline('write_file', { path: 'a.txt', content: 'x\ny' }).detail, 'a.txt（2 行）');
  assert.equal(toolHeadline('grep', { pattern: 'foo', include: '*.js' }).detail, '/foo/ in *.js');
});

test('formatToolResult：diff 着色与截断', () => {
  const lines = formatToolResult('write_file', {
    ok: true,
    diff: ['--- a/x', '+++ b/x', '@@ -1 +1 @@', '-a', '+b'],
  });
  assert.ok(lines.some((line) => line.includes('-a')));
  assert.ok(lines.some((line) => line.includes('+b')));
});

test('formatApprovalPrompt 显示命令与风险', () => {
  const text = formatApprovalPrompt({
    kind: 'shell',
    command: 'rm file.txt',
    risk: { level: 'high', reasons: ['删除文件'] },
  });
  assert.match(clean(text), /rm file.txt/);
  assert.match(clean(text), /高风险/);
});

test('Spinner 在非 TTY 下静默', () => {
  let written = '';
  const spinner = new Spinner({ out: { isTTY: false, write: (s) => (written += s) } });
  spinner.start('x');
  spinner.stop();
  assert.equal(written, '');
});

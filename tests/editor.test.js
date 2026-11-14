import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  KeyParser,
  layoutInput,
  maskText,
  wordBoundaryLeft,
  wordBoundaryRight,
  commonPrefix,
  LineEditor,
} from '../src/editor.js';

test('layoutInput：单行与光标列', () => {
  const result = layoutInput('hello', { columns: 40, prompt: '› ' });
  assert.equal(result.lines.length, 1);
  assert.equal(result.cursorRow, 0);
  assert.equal(result.cursorCol, 5);
});

test('layoutInput：自动换行（中文宽字符）', () => {
  const result = layoutInput('中文中文中文', { columns: 12, prompt: '› ' });
  // 内容宽度 10，每个汉字 2 列 → 一行 5 个字
  assert.equal(result.lines.length, 2);
  assert.equal(result.lines[0].text, '中文中文中');
  assert.equal(result.lines[1].text, '文');
  assert.equal(result.cursorRow, 1);
  assert.equal(result.cursorCol, 2);
});

test('layoutInput：换行符分成多行', () => {
  const result = layoutInput('ab\ncd', { columns: 40, prompt: '› ', contPrompt: '  ' });
  assert.deepEqual(
    result.lines.map((line) => line.text),
    ['ab', 'cd'],
  );
  assert.equal(result.cursorRow, 1);
  assert.equal(result.cursorCol, 2);
});

test('layoutInput：末尾换行后光标在新行', () => {
  const result = layoutInput('ab\n', { columns: 40 });
  assert.equal(result.lines.length, 2);
  assert.equal(result.cursorRow, 1);
  assert.equal(result.cursorCol, 0);
});

test('layoutInput：换行边界的光标归属下一行', () => {
  const text = 'a'.repeat(11);
  const result = layoutInput(text, { columns: 12, prompt: '› ', cursorIndex: 10 });
  assert.equal(result.lines.length, 2);
  assert.equal(result.cursorRow, 1);
  assert.equal(result.cursorCol, 0);
});

test('maskText 保持码点数量与换行', () => {
  assert.equal(maskText('ab\nc'), '**\n*');
});

test('wordBoundaryLeft / Right', () => {
  const cps = Array.from('foo bar-baz');
  assert.equal(wordBoundaryLeft(cps, 7), 4); // 在 bar 里向左跳到 bar 开头
  assert.equal(wordBoundaryLeft(cps, 4), 0); // 已在词首，向左跳到上一个词开头
  assert.equal(wordBoundaryRight(cps, 0), 3);
  // 中文按词字符处理
  const cjk = Array.from('你好 世界');
  assert.equal(wordBoundaryRight(cjk, 0), 2);
});

test('commonPrefix', () => {
  assert.equal(commonPrefix(['help', 'hello', 'help']), 'hel');
  assert.equal(commonPrefix([]), '');
});

test('KeyParser：方向键 / 修饰键 / 控制键', () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.feed('\x1b[A'), [{ type: 'up' }]);
  assert.deepEqual(parser.feed('\x1b[1;5C'), [{ type: 'word-right' }]);
  assert.deepEqual(parser.feed('\x1bOA'), [{ type: 'up' }]);
  assert.deepEqual(parser.feed('\x7f'), [{ type: 'backspace' }]);
  assert.deepEqual(parser.feed('\x03'), [{ type: 'ctrl+c' }]);
  assert.deepEqual(parser.feed('\r'), [{ type: 'enter' }]);
  assert.deepEqual(parser.feed('\n'), [{ type: 'newline' }]);
  assert.deepEqual(parser.feed('ab'), [
    { type: 'char', value: 'a' },
    { type: 'char', value: 'b' },
  ]);
});

test('KeyParser：粘贴序列（含 CRLF）与跨 chunk', () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.feed('\x1b[200~hi\r\nthere\x1b[201~'), [{ type: 'paste', text: 'hi\nthere' }]);

  const split = new KeyParser();
  assert.deepEqual(split.feed('\x1b[20'), []);
  assert.deepEqual(split.feed('0~ab\x1b[201~'), [{ type: 'paste', text: 'ab' }]);
});

test('KeyParser：单独的 ESC 与跨 chunk 的 CSI', () => {
  const parser = new KeyParser();
  assert.deepEqual(parser.feed('\x1b'), []);
  assert.deepEqual(parser.flush(), [{ type: 'escape' }]);

  const csi = new KeyParser();
  assert.deepEqual(csi.feed('\x1b['), []);
  assert.deepEqual(csi.feed('A'), [{ type: 'up' }]);
});

function makeEditor(history = []) {
  const input = new EventEmitter();
  input.isTTY = true;
  input.setEncoding = () => {};
  input.resume = () => {};
  const output = {
    columns: 40,
    rows: 24,
    text: '',
    write(chunk) {
      this.text += chunk;
    },
  };
  const editor = new LineEditor({ input, output, prompt: '› ', history });
  return { input, output, editor };
}

test('LineEditor：输入并提交', async () => {
  const { input, output, editor } = makeEditor();
  const promise = editor.readLine();
  input.emit('data', 'hi');
  input.emit('data', '\r');
  const result = await promise;
  assert.deepEqual(result, { type: 'submit', text: 'hi' });
  assert.match(output.text, /hi/);
});

test('LineEditor：Ctrl+C 先清空再中断，Ctrl+D 退出', async () => {
  const { input, editor } = makeEditor();
  const promise = editor.readLine();
  input.emit('data', 'abc');
  input.emit('data', '\x03');
  assert.equal(editor.buffer, '');
  input.emit('data', '\x03');
  assert.deepEqual(await promise, { type: 'interrupt' });

  const second = makeEditor();
  const p2 = second.editor.readLine();
  second.input.emit('data', '\x04');
  assert.deepEqual(await p2, { type: 'eof' });
});

test('LineEditor：历史与粘贴、多行', async () => {
  const { input, editor } = makeEditor(['older']);
  const promise = editor.readLine();
  input.emit('data', '\x1b[A');
  assert.equal(editor.buffer, 'older');
  input.emit('data', '\x1b[200~line1\nline2\x1b[201~');
  assert.equal(editor.buffer, 'olderline1\nline2');
  input.emit('data', '\r');
  const result = await promise;
  assert.equal(result.text, 'olderline1\nline2');
});

test('LineEditor：退格、删除与单词删除', async () => {
  const { input, editor } = makeEditor();
  const promise = editor.readLine();
  input.emit('data', 'foo bar');
  input.emit('data', '\x7f'); // 退格
  assert.equal(editor.buffer, 'foo ba');
  input.emit('data', '\x1b[3~'); // delete
  assert.equal(editor.buffer, 'foo ba');
  input.emit('data', '\x17'); // Ctrl+W 删词
  assert.equal(editor.buffer, 'foo ');
  input.emit('data', '\r');
  assert.deepEqual(await promise, { type: 'submit', text: 'foo ' });
});

test('LineEditor：Tab 补全唯一候选', async () => {
  const input = new EventEmitter();
  input.isTTY = true;
  input.setEncoding = () => {};
  input.resume = () => {};
  const output = { columns: 40, rows: 24, write() {} };
  const editor = new LineEditor({
    input,
    output,
    completer: (buffer, cursor) => {
      const before = Array.from(buffer).slice(0, cursor).join('');
      if (!before.startsWith('/he')) return null;
      return { start: 0, end: cursor, items: ['/help'] };
    },
  });
  const promise = editor.readLine();
  input.emit('data', '/he');
  input.emit('data', '\t');
  assert.equal(editor.buffer, '/help');
  input.emit('data', '\r');
  assert.deepEqual(await promise, { type: 'submit', text: '/help' });
});

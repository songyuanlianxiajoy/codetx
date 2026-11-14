import test from 'node:test';
import assert from 'node:assert/strict';
import { setColorEnabled, st, stripAnsi, width } from '../src/ansi.js';
import { wrapStyled, truncateStyled, drawBox, padStyled } from '../src/tui/text.js';
import { Composer } from '../src/tui/composer.js';
import { Screen } from '../src/tui/screen.js';
import { Transcript, MarkdownBlock, renderHistory } from '../src/tui/transcript.js';

setColorEnabled(false);

test('wrapStyled：中文按显示宽度换行', () => {
  const lines = wrapStyled('中文测试中文', 6);
  assert.deepEqual(lines.map((line) => stripAnsi(line)), ['中文测', '试中文']);
  const withPrefix = wrapStyled('中文测试', 6, { firstPrefix: '› ', nextPrefix: '  ' });
  assert.deepEqual(withPrefix.map((line) => stripAnsi(line)), ['› 中文', '  测试']);
});

test('wrapStyled：保留 ANSI 且断行后重新着色', () => {
  setColorEnabled(true);
  const colored = st.red('abcdef');
  const lines = wrapStyled(colored, 4);
  assert.equal(lines.length, 2);
  for (const line of lines) assert.ok(width(line) <= 4);
  assert.equal(stripAnsi(lines[0]), 'abcd');
  assert.equal(stripAnsi(lines[1]), 'ef');
  assert.ok(lines[1].startsWith('\x1b['));
  setColorEnabled(false);
});

test('truncateStyled / padStyled', () => {
  assert.equal(stripAnsi(truncateStyled('abcdef', 4)), 'abc…');
  assert.equal(width(padStyled('中', 4)), 4);
  setColorEnabled(true);
  const truncated = truncateStyled(st.red('abcdef'), 4);
  assert.ok(truncated.includes('\x1b[0m'));
  assert.equal(stripAnsi(truncated), 'abc…');
  setColorEnabled(false);
});

test('drawBox：固定宽度与内容', () => {
  const box = drawBox({ width: 20, title: '标题', lines: ['hi'] });
  assert.equal(box.length, 3);
  for (const line of box) assert.equal(width(line), 20);
  assert.match(stripAnsi(box[0]), /标题/);
  assert.match(stripAnsi(box[1]), /hi/);
});

test('Composer：编辑、历史与布局', () => {
  const composer = new Composer({ history: ['old'] });
  composer.insert('hello');
  assert.equal(composer.text, 'hello');
  composer.left();
  composer.insert('X');
  assert.equal(composer.text, 'hellXo');
  composer.backspace();
  assert.equal(composer.text, 'hello');
  composer.home();
  composer.insert('> ');
  assert.equal(composer.text, '> hello');
  composer.end();
  composer.wordDeleteBackward();
  assert.equal(composer.text, '> ');
  composer.historyPrev();
  assert.equal(composer.text, 'old');
  composer.historyNext();
  assert.equal(composer.text, '> ');
  composer.setText('a\nb');
  const layout = composer.layout(20);
  assert.equal(layout.lines.length, 2);
  assert.equal(layout.cursorRow, 1);
  composer.clear();
  assert.equal(composer.text, '');
});

test('MarkdownBlock：流式行缓存与半行', () => {
  const block = new MarkdownBlock();
  block.push('**bold**\n- item\npartial');
  const lines = block.lines(60);
  assert.equal(stripAnsi(lines[0]), 'bold');
  assert.match(stripAnsi(lines[1]), /• item/);
  assert.match(stripAnsi(lines[2]), /partial/);
  block.push(' done\n');
  const next = block.lines(60);
  assert.match(stripAnsi(next[2]), /partial done/);
});

test('Transcript：欢迎框 / 用户 / 助手 / 工具 / 提示', () => {
  const transcript = new Transcript();
  transcript.addBanner({
    version: '1.0.0',
    model: 'mock',
    cwd: '/tmp/work',
    policy: 'ask',
    sessionId: 'abc',
  });
  transcript.addUser('你好');
  const assistant = transcript.addAssistant();
  assistant.push('回答 **加粗**');
  assistant.finish();
  const tool = transcript.addToolStart({ name: 'shell', args: { command: 'ls' } });
  tool.end({ ok: true, output: 'file.txt', durationMs: 10 });
  transcript.addNotice('完成', 'success');

  const text = transcript.render(80).map((line) => stripAnsi(line)).join('\n');
  assert.match(text, /codetx/);
  assert.match(text, /mock/);
  assert.match(text, /› 你好/);
  assert.match(text, /• 回答 加粗/);
  assert.match(text, /shell/);
  assert.match(text, /file\.txt/);
  assert.match(text, /完成/);
});

test('Transcript：流式与工具结果会刷新缓存', () => {
  const transcript = new Transcript();
  const assistant = transcript.addAssistant();
  assistant.push('第一段');
  transcript.render(80);
  assistant.push('\n第二段');
  const text1 = transcript.render(80).map((line) => stripAnsi(line)).join('\n');
  assert.match(text1, /第二段/);

  const tool = transcript.addToolStart({ name: 'shell', args: { command: 'ls' } });
  const before = transcript.render(80).map((line) => stripAnsi(line)).join('\n');
  assert.match(before, /运行中/);
  tool.end({ ok: true, output: 'very-unique-output', durationMs: 5 });
  const after = transcript.render(80).map((line) => stripAnsi(line)).join('\n');
  assert.match(after, /very-unique-output/);
  assert.doesNotMatch(after, /运行中/);
});

test('renderHistory 恢复消息', () => {
  const transcript = new Transcript();
  renderHistory(transcript, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello', toolCalls: [] },
    { role: 'tool', name: 'shell', content: 'out' },
  ]);
  const text = transcript.render(80).map((line) => stripAnsi(line)).join('\n');
  assert.match(text, /hi/);
  assert.match(text, /hello/);
  assert.match(text, /out/);
});

test('Screen：alt-screen、差分刷新与光标', () => {
  let data = '';
  const output = {
    isTTY: true,
    columns: 40,
    rows: 8,
    write(chunk) {
      data += chunk;
    },
  };
  const input = { isTTY: true };
  const screen = new Screen({ input, output });
  screen.start();
  assert.match(data, /\x1b\[\?1049h/);

  data = '';
  screen.render(['a', 'b']);
  // 首次渲染会写满整屏（含清空），之后只写变化行
  assert.equal((data.match(/\x1b\[\d+;1H/g) || []).length, 8);
  data = '';
  screen.render(['a', 'b']);
  assert.equal((data.match(/\x1b\[\d+;1H/g) || []).length, 0);
  data = '';
  screen.render(['a', 'B'], { row: 1, col: 0 });
  assert.ok(data.includes('B'));
  assert.match(data, /\x1b\[2;1H/);

  screen.stop();
  assert.match(data, /\x1b\[\?1049l/);
});

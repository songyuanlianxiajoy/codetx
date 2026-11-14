#!/usr/bin/env python3
"""codetx TUI 冒烟测试：用 pty 起一个真实终端，接本地 mock 模型，验证
banner/输入/工具审批/流式输出/退出 全链路。

用法：python3 scripts/tui-smoke.py [--timeout 30]
"""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import tempfile
import termios
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, 'bin', 'codetx.js')
REQUESTS = []


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get('content-length', '0'))
        body = json.loads(self.rfile.read(length))
        REQUESTS.append(body)
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()
        if len(REQUESTS) % 2 == 1:
            args = json.dumps({'path': 'tui.txt', 'content': 'hello from pty\n'})
            chunk = {
                'choices': [{'delta': {'tool_calls': [{'index': 0, 'id': 'call_1', 'function': {'name': 'write_file', 'arguments': args}}]}}]
            }
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.write(f"data: {json.dumps({'choices': [{'finish_reason': 'tool_calls'}]})}\n\n".encode())
        else:
            chunk = {'choices': [{'delta': {'content': '完成：tui.txt 已写入。'}}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b'data: [DONE]\n\n')

    def log_message(self, *args):
        pass


def main():
    timeout = 30
    if '--timeout' in sys.argv:
        timeout = int(sys.argv[sys.argv.index('--timeout') + 1])

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    home = tempfile.mkdtemp(prefix='codetx-tui-home-')
    work = tempfile.mkdtemp(prefix='codetx-tui-work-')
    env = dict(os.environ)
    env.update({
        'CODETX_HOME': home,
        'CODETX_BASE_URL': f'http://127.0.0.1:{port}/v1',
        'CODETX_API_KEY': 'sk-tui',
        'CODETX_MODEL': 'mock-model',
        'TERM': env.get('TERM') or 'xterm-256color',
    })

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(work)
        os.execvpe('node', ['node', BIN], env)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 100, 0, 0))
    output = b''
    start = time.time()
    sent_prompt = False
    sent_approval = False

    def drain(duration):
        nonlocal output
        deadline = time.time() + duration
        while time.time() < deadline:
            r, _, _ = select.select([fd], [], [], 0.1)
            if not r:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return False
            if not chunk:
                return False
            output += chunk
        return True

    try:
        while time.time() - start < timeout:
            drain(0.3)
            text = output.decode('utf-8', 'ignore')
            if not sent_prompt and '›' in text:
                os.write(fd, '创建 tui.txt\r'.encode())
                sent_prompt = True
            if sent_prompt and not sent_approval and ('按 y 允许' in text or '要写入文件' in text):
                os.write(fd, b'y')
                sent_approval = True
            if sent_approval and '完成：tui.txt 已写入。' in text:
                time.sleep(0.3)
                os.write(fd, b'\x04')
                break
        drain(0.5)
    finally:
        try:
            os.kill(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
        try:
            os.waitpid(pid, 0)
        except ChildProcessError:
            pass
        server.shutdown()

    text = output.decode('utf-8', 'ignore')
    checks = [
        ('banner', 'codetx' in text and 'Termux' in text),
        ('prompt', '›' in text),
        ('approval', '按 y 允许' in text or '要写入文件' in text),
        ('streamed answer', '完成：tui.txt 已写入。' in text),
        ('file written', os.path.exists(os.path.join(work, 'tui.txt'))),
        ('session saved', any(name.endswith('.jsonl') for name in os.listdir(os.path.join(home, 'sessions')) if os.path.isdir(os.path.join(home, 'sessions')))),
    ]
    failed = [name for name, ok in checks if not ok]
    print('checks:', ', '.join(f'{name}={"ok" if ok else "FAIL"}' for name, ok in checks))
    print('model requests:', len(REQUESTS))
    if failed:
        print('---- output tail ----')
        print(text[-3000:])
        sys.exit(1)
    print('TUI smoke: PASS')


if __name__ == '__main__':
    main()

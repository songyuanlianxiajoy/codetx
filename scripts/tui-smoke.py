#!/usr/bin/env python3
"""codetx TUI 冒烟测试（pty + 本地 mock 模型）。

覆盖：alt-screen 启动、欢迎框、`/` 命令弹窗、输入提交、审批浮层、
流式回答、工具落盘、Ctrl+D 退出、终端恢复（alt-screen 退出序列）。

用法：python3 scripts/tui-smoke.py [--timeout 40]
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
REQUEST_COUNT = 0


class Handler(BaseHTTPRequestHandler):
    def do_POST(self):
        global REQUEST_COUNT
        length = int(self.headers.get('content-length', '0'))
        self.rfile.read(length)
        REQUEST_COUNT += 1
        self.send_response(200)
        self.send_header('content-type', 'text/event-stream')
        self.end_headers()
        if REQUEST_COUNT % 2 == 1:
            args = json.dumps({'path': 'tui.txt', 'content': 'hello from tui\n'})
            chunk = {
                'choices': [
                    {
                        'delta': {
                            'tool_calls': [
                                {'index': 0, 'id': 'call_1', 'function': {'name': 'write_file', 'arguments': args}}
                            ]
                        }
                    }
                ]
            }
        else:
            chunk = {'choices': [{'delta': {'content': '完成：tui.txt 已写入。'}}]}
        self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
        self.wfile.write(b'data: [DONE]\n\n')

    def log_message(self, *args):
        pass


def main():
    timeout = 40
    if '--timeout' in sys.argv:
        timeout = int(sys.argv[sys.argv.index('--timeout') + 1])

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    port = server.server_address[1]
    threading.Thread(target=server.serve_forever, daemon=True).start()

    home = tempfile.mkdtemp(prefix='codetx-tui-home-')
    work = tempfile.mkdtemp(prefix='codetx-tui-work-')
    dump = os.path.join(home, 'frames.txt')
    env = dict(os.environ)
    env.update(
        {
            'CODETX_HOME': home,
            'CODETX_BASE_URL': f'http://127.0.0.1:{port}/v1',
            'CODETX_API_KEY': 'sk-tui',
            'CODETX_MODEL': 'mock-model',
            'CODETX_TUI_DUMP': dump,
            'TERM': env.get('TERM') or 'xterm-256color',
        }
    )

    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(work)
        os.execvpe('node', ['node', BIN], env)

    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 38, 100, 0, 0))
    output = b''

    def frames():
        try:
            with open(dump, 'r', encoding='utf-8', errors='ignore') as handle:
                return handle.read()
        except FileNotFoundError:
            return ''

    def drain(seconds=0.1):
        nonlocal output
        end = time.time() + seconds
        while time.time() < end:
            ready, _, _ = select.select([fd], [], [], 0.05)
            if not ready:
                continue
            try:
                chunk = os.read(fd, 65536)
            except OSError:
                return False
            if not chunk:
                return False
            output += chunk
        return True

    def wait_for(predicate, limit=6):
        end = time.time() + limit
        while time.time() < end:
            drain(0.1)
            if predicate(frames()):
                return True
        return False

    checks = {}
    try:
        checks['banner'] = wait_for(lambda f: '>_ codetx' in f)
        checks['composer'] = wait_for(lambda f: '› 输入任务' in f)
        if checks['composer']:
            os.write(fd, b'/')
            checks['slash_popup'] = wait_for(lambda f: '╭─ 命令 ─' in f and '/approvals' in f)
            os.write(fd, b'\x1b')  # Esc 关闭弹窗
            os.write(fd, b'\x15')  # Ctrl+U 清空
            os.write(fd, '创建 tui.txt\r'.encode())
            checks['approval_modal'] = wait_for(lambda f: '需要审批' in f, limit=8)
            if checks['approval_modal']:
                os.write(fd, b'y')
            checks['answer'] = wait_for(lambda f: '完成：tui.txt 已写入。' in f, limit=8)
            checks['tool_result'] = wait_for(lambda f: '已创建 tui.txt' in f, limit=4)
        os.write(fd, b'\x04')  # Ctrl+D 退出
        drain(0.5)
        checks['alt_screen'] = b'\x1b[?1049h' in output
        checks['alt_screen_exit'] = b'\x1b[?1049l' in output
        checks['file_written'] = os.path.exists(os.path.join(work, 'tui.txt'))
        checks['session_saved'] = os.path.isdir(os.path.join(home, 'sessions')) and any(
            name.endswith('.jsonl') for name in os.listdir(os.path.join(home, 'sessions'))
        )
    finally:
        exited = False
        deadline = time.time() + 8
        while time.time() < deadline:
            done_pid, status = os.waitpid(pid, os.WNOHANG)
            if done_pid == pid:
                exited = True
                checks['exit_code'] = os.waitstatus_to_exitcode(status)
                break
            drain(0.1)
        if not exited:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            try:
                os.waitpid(pid, 0)
            except ChildProcessError:
                pass
            checks['exit_code'] = 'HANG'
        server.shutdown()

    failed = [
        name
        for name, ok in checks.items()
        if (name == 'exit_code' and ok != 0) or (name != 'exit_code' and ok is not True)
    ]
    print('checks:', ', '.join(f'{name}={value}' for name, value in checks.items()))
    print('model requests:', REQUEST_COUNT)
    if failed:
        print('---- last frame ----')
        blocks = frames().split('---FRAME---')
        print(blocks[-1][-3000:] if blocks else frames()[-3000:])
        print('TUI smoke: FAIL', failed)
        sys.exit(1)
    print('TUI smoke: PASS')


if __name__ == '__main__':
    main()

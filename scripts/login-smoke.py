#!/usr/bin/env python3
"""codetx 登录向导 pty 冒烟测试（本地 mock 服务）。"""
import fcntl, json, os, pty, re, select, signal, struct, sys, tempfile, termios, threading, time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BIN = os.path.join(ROOT, 'bin', 'codetx.js')
REQS = []

class H(BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path.endswith('/models'):
            body = json.dumps({'data': [{'id': 'mock-model'}, {'id': 'other-model'}]}).encode()
            self.send_response(200); self.send_header('content-type', 'application/json')
            self.send_header('content-length', str(len(body))); self.end_headers(); self.wfile.write(body)
        else:
            self.send_error(404)
    def do_POST(self):
        n = int(self.headers.get('content-length', '0'))
        REQS.append(json.loads(self.rfile.read(n)))
        self.send_response(200); self.send_header('content-type', 'text/event-stream'); self.end_headers()
        self.wfile.write(b'data: {"choices":[{"delta":{"content":"pong"}}]}\n\n')
        self.wfile.write(b'data: [DONE]\n\n')
    def log_message(self, *a): pass

server = ThreadingHTTPServer(('127.0.0.1', 0), H)
port = server.server_address[1]
threading.Thread(target=server.serve_forever, daemon=True).start()
home = tempfile.mkdtemp(prefix='codetx-login-home-')
env = dict(os.environ); env['CODETX_HOME'] = home
pid, fd = pty.fork()
if pid == 0:
    os.execvpe('node', ['node', BIN, 'login'], env)
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 100, 0, 0))
out = b''
sent = {'url': False, 'key': False, 'proto': False, 'model': False}
start = time.time()
url = f'http://127.0.0.1:{port}/v1'
while time.time() - start < 60:
    r, _, _ = select.select([fd], [], [], 0.1)
    if not r: continue
    try: chunk = os.read(fd, 65536)
    except OSError: break
    if not chunk: break
    out += chunk
    t = out.decode('utf-8', 'ignore')
    if not sent['url'] and 'API base URL' in t:
        os.write(fd, (url + '\r').encode()); sent['url'] = True
    elif sent['url'] and not sent['key'] and 'API Key' in t:
        os.write(fd, b'sk-wizard-key\r'); sent['key'] = True
    elif sent['key'] and not sent['proto'] and '协议类型' in t:
        os.write(fd, b'\r'); sent['proto'] = True
    elif sent['proto'] and not sent['model'] and '模型名' in t and '协议类型' not in t.split('模型名')[-1][-50:]:
        os.write(fd, b'mock-model\r'); sent['model'] = True
    if '连通性正常' in t or '连通性测试失败' in t:
        time.sleep(0.3)
        break
try: os.kill(pid, signal.SIGKILL)
except ProcessLookupError: pass
try: os.waitpid(pid, 0)
except ChildProcessError: pass
server.shutdown()
text = out.decode('utf-8', 'ignore')
cfg = open(os.path.join(home, 'config.toml')).read() if os.path.exists(os.path.join(home, 'config.toml')) else ''
envf = open(os.path.join(home, '.env')).read() if os.path.exists(os.path.join(home, '.env')) else ''
checks = {
    'wizard-banner': 'codetx 初始化' in text,
    'masked-key': '*' in text,
    'models-list': '个模型' in text or '端点可用' in text,
    'saved': '已保存' in text and 'mock-model' in cfg,
    'env-written': 'CODETX_RELAY_KEY=sk-wizard-key' in envf,
    'ping': '连通性正常' in text,
    'requests': len(REQS) >= 1,
}
print('checks:', checks)
print('REQS', len(REQS))
if not all(checks.values()):
    print('---- output tail ----'); print(text[-4000:])
    sys.exit(1)
print('login wizard smoke: PASS')

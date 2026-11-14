/**
 * 会话持久化：每次对话一个 JSONL 文件，第一行是 meta。
 *
 * 为什么用 JSONL 而不是 sqlite：
 *   - 纯 Node 零依赖；
 *   - 崩溃/断电最多丢最后一行，前面还能 resume；
 *   - 手机上用 cat/less 就能看，方便排查。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { sessionsDir, ensureHome } from './config.js';
import { randomId, timeStampName, nowIso, atomicWrite } from './util.js';

export class SessionStore {
  constructor(dir = sessionsDir()) {
    this.dir = dir;
  }

  async init() {
    await ensureHome();
    await fsp.mkdir(this.dir, { recursive: true, mode: 0o700 });
  }

  filePath(id) {
    return path.join(this.dir, `${id}.jsonl`);
  }

  async create({ cwd, model, provider, policy, title = '' }) {
    await this.init();
    const id = `${timeStampName()}-${randomId(3)}`;
    const meta = {
      type: 'meta',
      id,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      cwd,
      model,
      provider,
      policy,
      title,
      turns: 0,
      usage: { input: 0, output: 0, total: 0 },
    };
    await fsp.writeFile(this.filePath(id), `${JSON.stringify(meta)}\n`, { mode: 0o600 });
    return { id, meta };
  }

  async append(id, message) {
    const line = JSON.stringify({ type: 'message', ts: nowIso(), message });
    await fsp.appendFile(this.filePath(id), `${line}\n`, { mode: 0o600 });
  }

  async updateMeta(id, patch) {
    const { meta } = await this.load(id, { withMessages: false });
    const next = { ...meta, ...patch, updatedAt: nowIso() };
    const text = await fsp.readFile(this.filePath(id), 'utf8');
    const lines = text.split('\n');
    lines[0] = JSON.stringify(next);
    await atomicWrite(this.filePath(id), lines.join('\n'), 0o600);
    return next;
  }

  async setTitle(id, title) {
    return this.updateMeta(id, { title });
  }

  async load(id, { withMessages = true } = {}) {
    const text = await fsp.readFile(this.filePath(id), 'utf8');
    const lines = text.split('\n').filter((line) => line.trim() !== '');
    if (lines.length === 0) throw new Error(`会话文件为空：${this.filePath(id)}`);
    let meta;
    try {
      meta = JSON.parse(lines[0]);
    } catch {
      throw new Error(`会话文件损坏（第一行不是 JSON）：${this.filePath(id)}`);
    }
    const messages = [];
    if (withMessages) {
      for (let i = 1; i < lines.length; i++) {
        try {
          const record = JSON.parse(lines[i]);
          if (record?.type === 'message' && record.message) messages.push(record.message);
        } catch {
          // 断点续传：损坏的行跳过
        }
      }
    }
    return { meta, messages };
  }

  async list({ limit = 40 } = {}) {
    await this.init();
    let names;
    try {
      names = await fsp.readdir(this.dir);
    } catch {
      return [];
    }
    const sessions = [];
    for (const name of names) {
      if (!name.endsWith('.jsonl')) continue;
      const file = path.join(this.dir, name);
      try {
        const stat = await fsp.stat(file);
        const head = await readFirstLine(file);
        const meta = JSON.parse(head);
        sessions.push({ ...meta, file, mtimeMs: stat.mtimeMs, size: stat.size });
      } catch {
        /* 跳过坏文件 */
      }
    }
    sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
    return sessions.slice(0, limit);
  }

  async latest() {
    const list = await this.list({ limit: 1 });
    return list[0] || null;
  }

  async remove(id) {
    await fsp.rm(this.filePath(id), { force: true });
  }

  exists(id) {
    return fs.existsSync(this.filePath(id));
  }
}

async function readFirstLine(file) {
  const handle = await fsp.open(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    const idx = text.indexOf('\n');
    if (idx < 0 && bytesRead === buffer.length) throw new Error('meta 行过长');
    return (idx < 0 ? text : text.slice(0, idx)).trim();
  } finally {
    await handle.close();
  }
}

/** 会话摘要：最近一条用户消息 + 轮数，列表里展示用。 */
export function summarizeSession(meta) {
  const title = meta.title || '(未命名会话)';
  return {
    ...meta,
    title,
    age: meta.updatedAt ? new Date(meta.updatedAt).getTime() : meta.mtimeMs,
  };
}

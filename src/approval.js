/**
 * 审批策略与命令风险分析。
 *
 * 手机上没有可用的内核级沙箱（Termux 无 bwrap/landlock），所以用
 * 「命令风险分级 + 审批策略 + 硬拦截」来兜底。这是防手滑，不是安全边界——
 * 真正不可信的代码请放进 proot/容器里跑。
 */
import { truncateLine } from './util.js';

export class ApprovalDenied extends Error {
  constructor(message) {
    super(message);
    this.name = 'ApprovalDenied';
  }
}

/** 无论如何都不放行的命令（防止模型把手机搞砖）。 */
export const HARD_DENY = [
  { re: /(^|[;&|]\s*)rm\s+(?:-[a-zA-Z]*[rR][a-zA-Z]*\s+)*(?:\/|\/\*|~|\$HOME)(?:\s|$)/, reason: '递归删除根目录/家目录' },
  { re: /(^|[;&|]\s*)mkfs(?:\.|\s)/, reason: '格式化文件系统' },
  { re: /\bdd\b[^\n]*\bof=\/dev\/(?!null\b)/, reason: '直接写块设备' },
  { re: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/, reason: 'fork 炸弹' },
  { re: /\bchmod\s+-R\s+(?:777|666)\s+\/(?:\s|$)/, reason: '把根目录改成全局可写' },
  { re: />\s*\/dev\/(?:sd[a-z]|block\/)/, reason: '重定向写块设备' },
  { re: /\b(?:shutdown|reboot|poweroff|halt)\b/, reason: '关机/重启类命令' },
  { re: /\bsu\b|\bsudo\b/, reason: '提权命令（Termux 里通常也没有）' },
  { re: /\bpm\s+(?:uninstall|clear)\b/, reason: '卸载/清空 Android 应用' },
  { re: /\bmagisk\b/, reason: '改动 Magisk/root 环境' },
];

/** 只读白名单：auto 模式下不用问就能跑。 */
const SAFE_COMMANDS = new Set([
  'ls',
  'cat',
  'head',
  'tail',
  'wc',
  'pwd',
  'echo',
  'printf',
  'which',
  'file',
  'stat',
  'du',
  'df',
  'tree',
  'rg',
  'grep',
  'find',
  'fd',
  'sort',
  'uniq',
  'cut',
  'sed',
  'awk',
  'diff',
  'comm',
  'date',
  'whoami',
  'uname',
  'printenv',
  'node',
  'npm',
  'pnpm',
  'git',
  'python',
  'python3',
]);

const WRITEY = /(\brm\b|\bmv\b|\bcp\b|\bchmod\b|\bchown\b|\bmkdir\b|\btouch\b|\btee\b|\bsed\s+-i\b|\bgit\s+(?:reset|clean|checkout|switch|restore|push|rebase)\b|>|\bnpm\s+(?:install|i|uninstall|publish)\b|\bpip\s+install\b|\bapt\b|\bpkg\b)/;

const NETWORKY = /(\bcurl\b|\bwget\b|\bnc\b|\bssh\b|\bscp\b|\bping\b|\bgit\s+(?:clone|fetch|pull|push)\b|\bnpm\s+(?:install|i)\b|\bpip\s+install\b)/;

/**
 * 分析一条 shell 命令，返回风险等级与原因。
 * @returns {{level:'low'|'medium'|'high', reasons:string[], deny:boolean, denyReason?:string}}
 */
export function analyzeCommand(command) {
  const cmd = String(command || '');
  for (const rule of HARD_DENY) {
    if (rule.re.test(cmd)) {
      return { level: 'high', reasons: [rule.reason], deny: true, denyReason: rule.reason };
    }
  }

  const firstWordMatch = cmd.trim().match(/^([A-Za-z0-9_./-]+)/);
  const firstWord = firstWordMatch ? firstWordMatch[1].split('/').pop() : '';
  const reasons = [];
  let level = 'low';

  if (WRITEY.test(cmd)) {
    level = 'medium';
    reasons.push('可能修改文件');
  }
  if (NETWORKY.test(cmd)) {
    level = level === 'low' ? 'medium' : level;
    reasons.push('访问网络');
  }
  if (/(\;|&&|\|\|)/.test(cmd)) {
    reasons.push('包含命令串联');
    if (level === 'low') level = 'medium';
  }
  if (/\|\s*(?:ba|z|k|da)?sh\b/.test(cmd)) {
    level = 'high';
    reasons.push('把网络内容直接交给 shell 执行');
  }
  if (/\brm\b/.test(cmd)) {
    level = 'high';
    reasons.push('删除文件');
  }

  if (SAFE_COMMANDS.has(firstWord) && level === 'low') {
    return { level: 'low', reasons: ['只读命令'], deny: false };
  }
  return { level, reasons, deny: false };
}

/**
 * 创建审批函数。
 *
 * @param {object} options
 * @param {'ask'|'auto'|'full'|'read-only'} options.policy
 * @param {string} options.cwd
 * @param {boolean} options.workspaceOnly
 * @param {(req:object)=>Promise<'yes'|'no'|'always'>} [options.ask] 交互式询问；非 TTY 时不给
 * @param {(text:string)=>void} [options.notify] 解释拒绝原因
 */
export function createApprover(options) {
  const { policy, workspaceOnly = true, ask, notify = () => {} } = options;
  const alwaysShell = new Set();
  const alwaysWrite = new Set();

  return async function approve(request) {
    const { kind, command = '', path = '', outside = false } = request;

    if (kind === 'shell') {
      const analysis = analyzeCommand(command);
      if (analysis.deny) {
        notify(`⛔ 已拦截危险命令：${analysis.denyReason}\n  ${truncateLine(command, 120)}`);
        return false;
      }
      if (policy === 'read-only') {
        notify('当前是只读模式（read-only），不执行 shell 命令。需要执行请 /approvals auto 或 ask。');
        return false;
      }
      if (policy === 'full') return true;
      if (alwaysShell.has(command)) return true;

      if (policy === 'auto' && analysis.level === 'low') return true;

      if (!ask) {
        notify(
          `需要审批才能执行（当前策略 ${policy}）：${truncateLine(command, 120)}\n` +
            '非交互模式请加 --full-auto，或改用 ask 策略在 TUI 里确认。',
        );
        return false;
      }
      const answer = await ask({ kind: 'shell', command, risk: analysis, policy });
      if (answer === 'always') {
        alwaysShell.add(command);
        return true;
      }
      return answer === 'yes';
    }

    if (kind === 'write') {
      if (policy === 'read-only') {
        notify(`当前是只读模式，不能修改文件：${path}`);
        return false;
      }
      if (policy === 'full') return true;
      if (alwaysWrite.has(path)) return true;

      // ask：所有写入都问；auto：工作区内自动放行，越界写仍然问；full：全放行
      const shouldAsk = policy === 'ask' || (policy === 'auto' && outside && workspaceOnly);
      if (!shouldAsk) return true;
      if (!ask) {
        notify(`需要审批才能写入（当前策略 ${policy}）：${path}\n非交互模式请加 --full-auto。`);
        return false;
      }
      const answer = await ask({ kind: 'write', path, outside, policy });
      if (answer === 'always') {
        alwaysWrite.add(path);
        return true;
      }
      return answer === 'yes';
    }

    return true;
  };
}

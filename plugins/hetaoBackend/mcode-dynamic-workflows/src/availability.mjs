import { spawn } from 'node:child_process';
import { executablePath, resolveMcode } from './mcode-location.mjs';
import { safeDetail } from './failure.mjs';
export { executablePath, resolveMcode };
// Fail-loud preflight. Field evidence (2026-09-20, this machine): during a
// broken-CLI window (better-sqlite3 ABI break + mcode v0.2.4) three runs
// persisted run.started → run.finished(succeeded) within 42ms with
// attempts:0, steps:0, errorDetails:null and a valid topology containing
// planned agent nodes — the executor layer was completely dead and the engine
// translated that into success. Resolution alone cannot see this class: the
// CLI file exists and resolves; the process dies on startup. This probe runs
// the resolved entry with --version — a cheap liveness check that NEVER
// invokes a model — so an unusable CLI fails the run before any dispatch,
// with actionable details, instead of being translated into success.
export async function preflightMcode(command = 'mcode', { args = [], env = process.env, timeoutMs = 20000 } = {}) {
  let cli = null;
  try { cli = await resolveMcode(command, { env }); }
  catch (e) {
    return { ok: false, code: 'MCODE_PREFLIGHT_FAILED', executor: 'mcode', probe: null,
      message: `MCode CLI 解析失败：${safeDetail(e.message)}`,
      suggestion: '修复该 CLI 安装后重试；本次运行未执行任何 Agent。' };
  }
  if (!cli) {
    return { ok: false, code: 'MCODE_PREFLIGHT_FAILED', executor: 'mcode', probe: null,
      message: '找不到 MCode CLI，请通过官方渠道安装并登录，再按 Skill 的 CLI preflight 检查 mcode --version 和 mcode exec --help。',
      suggestion: '安装或修复 mcode 后重试；本次运行未执行任何 Agent。' };
  }
  // Cheap liveness probe only: --version never starts a model call.
  const probe = await new Promise(resolve => {
    const captured = { stdout: '', stderr: '' };
    let timedOut = false;
    const child = spawn(cli.command, [...cli.args, ...args, '--version'], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs); timer.unref();
    for (const [stream, key] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) {
      stream.setEncoding('utf8');
      stream.on('data', chunk => { const text = captured[key]; captured[key] = text.length + chunk.length > 8000 ? text : text + chunk; });
    }
    const finish = result => { clearTimeout(timer); resolve(result); };
    child.on('error', e => finish({ exitCode: null, spawnError: e.code ?? safeDetail(e.message), ...captured, timedOut }));
    child.on('close', exitCode => finish({ exitCode, spawnError: null, ...captured, timedOut }));
  });
  if (probe.exitCode === 0 && !probe.spawnError && !probe.timedOut) {
    return { ok: true, executor: 'mcode', probe: '--version', source: cli.source, checkedAt: Date.now(),
      version: probe.stdout.trim().split('\n').pop()?.slice(0, 120) || null };
  }
  const cause = probe.timedOut ? `探测超时（超过 ${Math.round(timeoutMs / 1000)} 秒未退出）`
    : probe.spawnError ? `无法启动（${probe.spawnError}）`
    : `mcode --version 退出码 ${probe.exitCode ?? '未知'}`;
  const tail = safeDetail(probe.stderr.trim() || probe.stdout.trim()).slice(-300);
  return { ok: false, code: 'MCODE_PREFLIGHT_FAILED', executor: 'mcode', probe: '--version',
    exitCode: probe.exitCode, spawnError: probe.spawnError, ...(tail ? { stderr: tail } : {}),
    message: `MCode CLI 不可用：${cause}${tail ? `：${tail}` : ''}。本次运行已按失败处理，未执行任何 Agent。`,
    suggestion: '先在终端运行 mcode --version 确认可用：检查 mcode 安装与升级（版本损坏或原生模块不匹配时重装）、登录状态与网络，修复后恢复运行。' };
}

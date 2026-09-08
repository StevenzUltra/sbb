// Run an external command with a timeout. Injectable so transports can be tested without binaries.
import { execFile } from 'node:child_process';

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ env?: NodeJS.ProcessEnv, timeoutMs?: number, cwd?: string, input?: string }} [opts]
 * @returns {Promise<{ code: number|null, stdout: string, stderr: string, timedOut: boolean }>}
 */
export function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      { env: { ...process.env, ...(opts.env ?? {}) }, timeout: opts.timeoutMs ?? 30000, cwd: opts.cwd, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout, stderr) => {
        resolve({
          code: err && typeof err.code === 'number' ? err.code : err ? (err.killed ? null : 1) : 0,
          stdout: String(stdout ?? ''),
          stderr: String(stderr ?? '') + (err && err.code === 'ENOENT' ? `\n${cmd}: not found` : ''),
          timedOut: Boolean(err && err.killed),
        });
      },
    );
    if (opts.input !== undefined) child.stdin?.end(opts.input);
  });
}

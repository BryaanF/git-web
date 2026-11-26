import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export class GitCommandError extends Error {
  readonly code: number | string | null;
  readonly stderr: string;
  readonly stdout: string;
  readonly args: string[];

  constructor(message: string, details: { code: number | string | null; stderr: string; stdout: string; args: string[] }) {
    super(message);
    this.name = 'GitCommandError';
    this.code = details.code;
    this.stderr = details.stderr;
    this.stdout = details.stdout;
    this.args = details.args;
  }
}

interface QueueSlot {
  active: number;
  waiting: Array<() => void>;
}

const repoQueues = new Map<string, QueueSlot>();
const MAX_CONCURRENT_PER_REPO = 4;

async function withRepoSlot<T>(repoKey: string, task: () => Promise<T>): Promise<T> {
  let slot = repoQueues.get(repoKey);
  if (!slot) {
    slot = { active: 0, waiting: [] };
    repoQueues.set(repoKey, slot);
  }

  if (slot.active >= MAX_CONCURRENT_PER_REPO) {
    await new Promise<void>((resolve) => {
      slot.waiting.push(resolve);
    });
  }

  slot.active += 1;
  try {
    return await task();
  } finally {
    slot.active -= 1;
    const next = slot.waiting.shift();
    if (next) {
      next();
    } else if (slot.active === 0) {
      repoQueues.delete(repoKey);
    }
  }
}

export interface RunGitOptions {
  timeoutMs?: number;
  allowNonZeroExit?: boolean;
  readOnly?: boolean;
  maxBuffer?: number;
  env?: Record<string, string>;
}

export interface RunGitResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/**
 * Executes git.exe safely without shell interpolation and limits concurrency
 * per repository to avoid Windows process-creation thrashing.
 */
export async function runGit(
  repoPath: string,
  args: string[],
  options: RunGitOptions = {},
): Promise<RunGitResult> {
  const fullArgs = ['-c', 'core.quotepath=false', '-C', repoPath, ...args];
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxBuffer = options.maxBuffer ?? 32 * 1024 * 1024;

  return withRepoSlot(repoPath, async () => {
    try {
      const { stdout, stderr } = await execFileAsync('git', fullArgs, {
        shell: false,
        windowsHide: true,
        timeout: timeoutMs,
        maxBuffer,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C.UTF-8',
          ...(options.readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
          ...options.env,
        },
      });
      return { stdout, stderr, exitCode: 0 };
    } catch (error) {
      const err = error as {
        code?: number | string;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const exitCode = typeof err.code === 'number' ? err.code : 1;
      const stdout = typeof err.stdout === 'string' ? err.stdout : '';
      const stderr = typeof err.stderr === 'string' ? err.stderr : (err.message ?? 'Git command failed');

      if (options.allowNonZeroExit && typeof err.code === 'number') {
        return { stdout, stderr, exitCode };
      }

      throw new GitCommandError(stderr.trim() || `git ${args[0] ?? ''} exited with code ${exitCode}`, {
        code: err.code ?? exitCode,
        stderr,
        stdout,
        args,
      });
    }
  });
}

export async function runGitBinaryWithInput(
  repoPath: string,
  args: string[],
  stdinText: string,
  options: { timeoutMs?: number; maxOutputBytes?: number; readOnly?: boolean } = {},
): Promise<Buffer> {
  const fullArgs = ['-c', 'core.quotepath=false', '-C', repoPath, ...args];
  const timeoutMs = options.timeoutMs ?? 20_000;
  const maxOutputBytes = options.maxOutputBytes ?? 2 * 1024 * 1024;

  return withRepoSlot(repoPath, () => {
    return new Promise<Buffer>((resolve, reject) => {
      const child = spawn('git', fullArgs, {
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          GIT_TERMINAL_PROMPT: '0',
          LC_ALL: 'C.UTF-8',
          ...(options.readOnly ? { GIT_OPTIONAL_LOCKS: '0' } : {}),
        },
      });

      const chunks: Buffer[] = [];
      let totalBytes = 0;
      let settled = false;
      const errChunks: Buffer[] = [];

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill();
        reject(new Error(`git ${args[0] ?? ''} timed out`));
      }, timeoutMs);

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };

      child.stdout.on('data', (chunk: Buffer) => {
        totalBytes += chunk.length;
        if (totalBytes > maxOutputBytes) {
          child.kill();
          finish(() => reject(new Error('Git batch output exceeded buffer limit')));
          return;
        }
        chunks.push(chunk);
      });

      child.stderr.on('data', (chunk: Buffer) => {
        if (errChunks.length < 16) errChunks.push(chunk);
      });

      child.on('error', (err) => {
        finish(() => reject(err));
      });

      child.on('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          const stderr = Buffer.concat(errChunks).toString('utf8').trim();
          finish(() => reject(new Error(stderr || `git ${args[0] ?? ''} exited with code ${code}`)));
          return;
        }
        finish(() => resolve(Buffer.concat(chunks)));
      });

      child.stdin.end(stdinText, 'utf8');
    });
  });
}

export async function runSystemCommand(
  binary: string,
  args: string[],
  timeoutMs = 3000,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(binary, args, {
      shell: false,
      windowsHide: true,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      encoding: 'utf8',
    });
    return { ok: true, stdout, stderr };
  } catch (error) {
    const err = error as { stdout?: string; stderr?: string };
    return {
      ok: false,
      stdout: typeof err.stdout === 'string' ? err.stdout : '',
      stderr: typeof err.stderr === 'string' ? err.stderr : '',
    };
  }
}

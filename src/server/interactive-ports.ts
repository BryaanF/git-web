import { createInterface } from 'node:readline';
import {
  isPortAvailable,
  parsePortSpec,
  probePorts,
  resolvePortSpec,
} from './ports.ts';

export interface PromptSession {
  ask: (question: string) => Promise<string | null>;
  close: () => void;
}

export function createPromptSession(): PromptSession {
  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: Boolean(process.stdin.isTTY),
  });

  const queuedLines: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let closed = false;

  rl.on('line', (line) => {
    const waiter = waiters.shift();
    if (waiter) {
      waiter(line);
    } else {
      queuedLines.push(line);
    }
  });

  rl.on('close', () => {
    closed = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift();
      waiter?.(null);
    }
  });

  return {
    ask: (question: string) => {
      process.stdout.write(question);
      if (queuedLines.length > 0) {
        const next = queuedLines.shift()!;
        if (!process.stdin.isTTY) {
          process.stdout.write(`${next}\n`);
        }
        return Promise.resolve(next);
      }
      if (closed) {
        if (!process.stdin.isTTY) {
          process.stdout.write('\n');
        }
        return Promise.resolve(null);
      }
      return new Promise<string | null>((resolve) => {
        waiters.push(resolve);
      });
    },
    close: () => {
      rl.close();
    },
  };
}

export interface PromptPortOptions {
  title: string;
  defaultSpec: string;
  suggestedPorts: readonly number[];
  host: string;
  allowPrivileged?: boolean;
  strict?: boolean;
  excludePorts?: ReadonlySet<number>;
  allowOff?: boolean;
}

export async function promptServicePort(
  session: PromptSession,
  options: PromptPortOptions,
): Promise<{ port: number | null; spec: string }> {
  const probed = await probePorts(options.suggestedPorts, options.host);
  const statusLine = probed
    .map(({ port, available }) => {
      if (options.excludePorts?.has(port)) {
        return `${port} (used by another service)`;
      }
      return `${port} (${available ? 'free' : 'in use'})`;
    })
    .join(' | ');

  console.log(`\n[${options.title}]`);
  console.log(`  Port scan (${options.host}): ${statusLine}`);

  const offHint = options.allowOff ? ', "off"' : '';

  while (true) {
    const answer = await session.ask(
      `  Choose port, list (e.g. 7745,8080), range (8000-8010), "auto"${offHint} [${options.defaultSpec}]: `,
    );

    const raw = (answer === null ? '' : answer).trim() || options.defaultSpec;

    try {
      const parsed = parsePortSpec(raw);
      if (parsed.mode === 'disabled') {
        if (!options.allowOff) {
          console.log('  This service requires an active port and cannot be set to "off".');
          continue;
        }
        return { port: null, spec: raw };
      }

      // If user typed a single port that is occupied and strict is off, confirm before auto-stepping
      if (
        parsed.mode === 'candidates' &&
        !parsed.hasRange &&
        parsed.candidates.length === 1 &&
        !options.strict
      ) {
        const requested = parsed.candidates[0];
        if (!options.excludePorts?.has(requested)) {
          const isPrivilegedBlocked = !options.allowPrivileged && requested < 1024;
          const free = !isPrivilegedBlocked && (await isPortAvailable(requested, options.host));
          if (!free) {
            const nextPort = await resolvePortSpec(parsed, {
              host: options.host,
              strict: false,
              allowPrivileged: options.allowPrivileged,
              excludePorts: options.excludePorts,
            });
            const reason = isPrivilegedBlocked
              ? `Port ${requested} is privileged (< 1024)`
              : `Port ${requested} is already in use`;
            const confirm = await session.ask(
              `  ${reason}. Use free port ${nextPort} instead? [Y/n]: `,
            );
            const normalized = (confirm ?? 'y').trim().toLowerCase();
            if (normalized === '' || normalized === 'y' || normalized === 'yes') {
              return { port: nextPort, spec: String(nextPort) };
            }
            if (answer === null) {
              return { port: nextPort, spec: String(nextPort) };
            }
            continue;
          }
        }
      }

      const resolved = await resolvePortSpec(parsed, {
        host: options.host,
        strict: options.strict,
        allowPrivileged: options.allowPrivileged,
        excludePorts: options.excludePorts,
      });

      return { port: resolved, spec: raw };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(`  Invalid selection: ${msg}`);
      if (answer === null) {
        throw err;
      }
    }
  }
}

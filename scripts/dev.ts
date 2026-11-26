import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPromptSession, promptServicePort } from '../src/server/interactive-ports.ts';
import { DEFAULT_SERVER_PORT, formatHostForUrl } from '../src/server/ports.ts';
import {
  formatRunnerPlan,
  getRunnerHelpText,
  parseRunnerArgs,
  resolveRunnerPlan,
  type RunnerCliOptions,
} from './runner-core.ts';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const viteBinPath = path.resolve(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');

async function runInteractiveWizard(options: RunnerCliOptions): Promise<RunnerCliOptions> {
  const session = createPromptSession();
  try {
    console.log('\n==============================================================');
    console.log('  GitDock Web — Flexible Project Runner & Port Selector');
    console.log('==============================================================');
    console.log(`  Bind Host: ${options.host}   Mode: ${options.mode}`);
    console.log('\nSelect services to activate:');
    console.log('  [1] server + client  (Full Dev: API Server + Vite HMR UI)');
    console.log('  [2] server only      (API Server + built dist/client if available)');
    console.log('  [3] client only      (Vite HMR UI proxying to an external API)');

    const defaultChoice =
      options.enableServer && options.enableClient ? '1' : options.enableServer ? '2' : '3';
    const answer = await session.ask(`  Choice [1-3] (Enter = ${defaultChoice}): `);
    const serviceSelection = answer?.trim() || defaultChoice;

    const updated: RunnerCliOptions = { ...options };

    if (serviceSelection === '2' || serviceSelection.toLowerCase() === 'server') {
      updated.enableServer = true;
      updated.enableClient = false;
    } else if (serviceSelection === '3' || serviceSelection.toLowerCase() === 'client') {
      updated.enableServer = false;
      updated.enableClient = true;
    } else {
      updated.enableServer = true;
      updated.enableClient = true;
    }

    const allocated = new Set<number>();

    if (updated.enableServer) {
      const serverPick = await promptServicePort(session, {
        title: 'Service 1: server (Backend API & Git Engine)',
        defaultSpec: updated.serverPortSpec,
        suggestedPorts: [7745, 7746, 8000, 8080, 8888, 9000],
        host: updated.host,
        allowPrivileged: updated.allowPrivilegedPort,
        strict: updated.strictPort,
        allowOff: false,
      });
      if (serverPick.port !== null) {
        updated.serverPortSpec = String(serverPick.port);
        allocated.add(serverPick.port);
      }
    } else if (updated.enableClient) {
      const defaultProxy = String(updated.proxyPort ?? DEFAULT_SERVER_PORT);
      const proxyAnswer = await session.ask(
        `\n[Proxy Target] Backend API port to proxy /api requests to [${defaultProxy}]: `,
      );
      const rawProxy = proxyAnswer?.trim() || defaultProxy;
      const parsedProxy = Number.parseInt(rawProxy, 10);
      if (Number.isInteger(parsedProxy) && parsedProxy > 0 && parsedProxy <= 65535) {
        updated.proxyPort = parsedProxy;
      }
    }

    if (updated.enableClient) {
      const clientPick = await promptServicePort(session, {
        title: 'Service 2: client (Vite Dev Server)',
        defaultSpec: updated.clientPortSpec,
        suggestedPorts: [5173, 5174, 3000, 4173, 5000, 5500],
        host: updated.host,
        allowPrivileged: updated.allowPrivilegedPort,
        strict: updated.strictPort,
        excludePorts: allocated,
        allowOff: updated.enableServer,
      });
      if (clientPick.port === null) {
        updated.enableClient = false;
        updated.clientPortSpec = 'off';
      } else {
        updated.clientPortSpec = String(clientPick.port);
        allocated.add(clientPick.port);
      }
    }

    if (updated.enableServer) {
      const tsPick = await promptServicePort(session, {
        title: 'Companion: tailscale serve HTTPS port',
        defaultSpec: updated.tailscalePort === null ? 'off' : String(updated.tailscalePort),
        suggestedPorts: [8443, 8444, 9443],
        host: updated.host,
        allowPrivileged: updated.allowPrivilegedPort,
        strict: false,
        excludePorts: allocated,
        allowOff: true,
      });
      updated.tailscalePort = tsPick.port;
    }

    return updated;
  } finally {
    session.close();
  }
}

function canConnectTcp(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ host, port });
    socket.setTimeout(300);
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => {
      socket.destroy();
      resolve(false);
    });
  });
}

async function waitForPortReady(
  host: string,
  port: number,
  child: ChildProcess,
  timeoutMs = 10_000,
): Promise<boolean> {
  const probeHost = formatHostForUrl(host);
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.killed) {
      return false;
    }
    if (await canConnectTcp(probeHost, port)) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 80));
  }
  return false;
}

async function main() {
  let options = parseRunnerArgs(process.argv.slice(2));

  if (options.help) {
    console.log(getRunnerHelpText());
    process.exit(0);
  }

  if (options.interactive) {
    options = await runInteractiveWizard(options);
  }

  const plan = await resolveRunnerPlan(options);
  console.log(`\n${formatRunnerPlan(plan)}\n`);

  if (options.dryRun) {
    process.exit(0);
  }

  const children: ChildProcess[] = [];
  let shuttingDown = false;

  const terminateAll = (exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    for (const child of children) {
      if (child.exitCode === null && !child.killed) {
        try {
          child.kill('SIGTERM');
        } catch {
          // Ignore
        }
      }
    }
    setTimeout(() => {
      for (const child of children) {
        if (child.exitCode === null && !child.killed) {
          try {
            child.kill('SIGKILL');
          } catch {
            // Ignore
          }
        }
      }
      process.exit(exitCode);
    }, 300).unref();
  };

  process.on('SIGINT', () => terminateAll(0));
  process.on('SIGTERM', () => terminateAll(0));

  const watchChild = (name: string, child: ChildProcess) => {
    child.on('exit', (code, signal) => {
      if (shuttingDown) return;
      if (code && code !== 0) {
        console.error(`[Runner] Service "${name}" exited with code ${code}. Stopping runner...`);
        terminateAll(code);
        return;
      }
      if (signal) {
        terminateAll(0);
        return;
      }
      const anyStillRunning = children.some((c) => c !== child && c.exitCode === null);
      if (!anyStillRunning) {
        process.exit(0);
      } else {
        console.log(`[Runner] Service "${name}" stopped. Stopping remaining services...`);
        terminateAll(0);
      }
    });
  };

  if (plan.server.enabled && plan.server.port !== null) {
    const serverChild = spawn(process.execPath, plan.server.args, {
      cwd: projectRoot,
      stdio: 'inherit',
      shell: false,
      env: { ...process.env, ...plan.server.env },
    });
    children.push(serverChild);
    watchChild('server', serverChild);

    if (plan.client.enabled) {
      await waitForPortReady(plan.host, plan.server.port, serverChild, 10_000);
      if (shuttingDown) return;
    }
  }

  if (plan.client.enabled) {
    const hasLocalVite = fs.existsSync(viteBinPath);
    const viteChild = hasLocalVite
      ? spawn(process.execPath, [viteBinPath, ...plan.client.args], {
          cwd: projectRoot,
          stdio: 'inherit',
          shell: false,
          env: { ...process.env, ...plan.client.env },
        })
      : spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', ...plan.client.args], {
          cwd: projectRoot,
          stdio: 'inherit',
          shell: process.platform === 'win32',
          env: { ...process.env, ...plan.client.env },
        });
    children.push(viteChild);
    watchChild('client', viteChild);
  }
}

main().catch((err) => {
  console.error('[Runner] Error:', err instanceof Error ? err.message : err);
  process.exit(1);
});

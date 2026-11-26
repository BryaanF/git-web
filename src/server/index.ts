import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { setCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { createAuthManager, type AuthManager } from './auth.ts';
import { browseDirectories } from './fs/browse.ts';
import { GitCommandError } from './git/runner.ts';
import {
  checkoutBranch,
  createCommit,
  discardUnstagedFile,
  fetchRemote,
  getCommitDetail,
  getCommitFileDiff,
  getCommitHistory,
  getRepoStatus,
  getWorkingFileDiff,
  listBranches,
  pullBranch,
  pushBranch,
  stageFiles,
  unstageFiles,
  verifyRemoteSync,
} from './git/service.ts';
import { createPromptSession, promptServicePort } from './interactive-ports.ts';
import {
  buildNetworkInfo,
  DEFAULT_PORT,
  DEFAULT_TAILSCALE_PORT,
  PRIVILEGED_WEB_PORTS,
  parsePortSpec,
  renderTerminalQr,
  resolvePortSpec,
} from './network.ts';
import { RepoStore } from './repos/store.ts';

interface CliConfig {
  portSpec: string;
  tailscalePort: number | null;
  clientPort: number | null;
  host: string;
  noAuth: boolean;
  repoPaths: string[];
  allowPrivilegedPort: boolean;
  strictPort: boolean;
  ensureBuild: boolean;
  forceBuild: boolean;
  interactive: boolean;
  help: boolean;
}

function parseTailscalePortValue(raw: string): number | null {
  const spec = parsePortSpec(raw);
  if (spec.mode === 'disabled') return null;
  if (spec.mode === 'candidates' && !spec.hasRange && spec.candidates.length === 1) {
    return spec.candidates[0];
  }
  throw new Error(`Invalid --tailscale-port value "${raw}". Expected a port number (1-65535) or "off".`);
}

function splitFlagAndValue(argv: string[], index: number): { flag: string; value?: string; consumedNext: boolean } {
  const current = argv[index];
  const eqIdx = current.indexOf('=');
  if (eqIdx > 0 && current.startsWith('-')) {
    return {
      flag: current.slice(0, eqIdx),
      value: current.slice(eqIdx + 1),
      consumedNext: false,
    };
  }
  const next = argv[index + 1];
  if (next !== undefined) {
    return { flag: current, value: next, consumedNext: true };
  }
  return { flag: current, value: undefined, consumedNext: false };
}

function parseCliArgs(argv: string[]): CliConfig {
  const envPortSpec =
    process.env.GITWEB_SERVER_PORT?.trim() ||
    process.env.GITWEB_PORT?.trim() ||
    process.env.PORT?.trim() ||
    String(DEFAULT_PORT);

  const envTailscaleRaw = process.env.GITWEB_TAILSCALE_PORT?.trim();
  const envClientRaw = process.env.GITWEB_CLIENT_PORT?.trim();
  const parsedClientPort = envClientRaw ? Number.parseInt(envClientRaw, 10) : Number.NaN;

  const config: CliConfig = {
    portSpec: envPortSpec,
    tailscalePort: envTailscaleRaw ? parseTailscalePortValue(envTailscaleRaw) : DEFAULT_TAILSCALE_PORT,
    clientPort:
      Number.isInteger(parsedClientPort) && parsedClientPort > 0 && parsedClientPort <= 65535
        ? parsedClientPort
        : null,
    host: process.env.GITWEB_HOST || '0.0.0.0',
    noAuth: process.env.GITWEB_NO_AUTH === '1',
    repoPaths: [],
    allowPrivilegedPort: process.env.GITWEB_ALLOW_PRIVILEGED_PORT === '1',
    strictPort: process.env.GITWEB_STRICT_PORT === '1',
    ensureBuild: false,
    forceBuild: false,
    interactive: false,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const { flag, value, consumedNext } = splitFlagAndValue(argv, i);
    if (
      flag === '--port' ||
      flag === '-p' ||
      flag === '--server-port' ||
      flag === '--api-port' ||
      flag === '--ports'
    ) {
      if (!value) throw new Error(`Missing value for ${flag}`);
      parsePortSpec(value);
      config.portSpec = value;
      if (consumedNext) i += 1;
    } else if (flag === '--tailscale-port') {
      if (!value) throw new Error(`Missing value for ${flag}`);
      config.tailscalePort = parseTailscalePortValue(value);
      if (consumedNext) i += 1;
    } else if (flag === '--host' || flag === '-H') {
      if (!value) throw new Error(`Missing value for ${flag}`);
      config.host = value;
      if (consumedNext) i += 1;
    } else if (flag === '--repo' || flag === '-r') {
      if (!value) throw new Error(`Missing value for ${flag}`);
      config.repoPaths.push(value);
      if (consumedNext) i += 1;
    } else if (flag === '--no-auth') {
      config.noAuth = true;
    } else if (flag === '--allow-privileged-port') {
      config.allowPrivilegedPort = true;
    } else if (flag === '--strict-port') {
      config.strictPort = true;
    } else if (flag === '--ensure-build') {
      config.ensureBuild = true;
    } else if (flag === '--build') {
      config.forceBuild = true;
    } else if (flag === '--interactive' || flag === '-i' || flag === '--pick' || flag === '--choose') {
      config.interactive = true;
    } else if (flag === '--help' || flag === '-h') {
      config.help = true;
    }
  }

  if (config.repoPaths.length === 0) {
    config.repoPaths.push(process.cwd());
  }

  return config;
}

function printServerHelp() {
  console.log(`GitDock Web Server

Usage:
  node src/server/index.ts [options]

Options:
  -p, --port <spec>          Server port, list (7745,8080), range (8000-8010), or "auto"
      --server-port <spec>   Alias for --port
      --tailscale-port <n>   Tailscale HTTPS serve port or "off" (default: 8443)
  -H, --host <ip>            Bind host interface (default: 0.0.0.0)
  -r, --repo <path>          Register a local Git repository (repeatable)
      --strict-port          Fail instead of auto-stepping if selected port(s) are busy
      --allow-privileged-port Allow ports < 1024 (including 80/443)
      --ensure-build         Build client bundle automatically if dist/client is missing
      --build                Rebuild client bundle before starting the server
      --no-auth              Disable LAN pairing token requirement
  -i, --interactive          Interactively probe & pick ports before starting
  -h, --help                 Show this help message
`);
}

function parseErrorPayload(err: unknown): { status: 400 | 404 | 500; message: string } {
  if (err instanceof GitCommandError) {
    return { status: 400, message: err.stderr.trim() || err.message };
  }
  if (err instanceof Error) {
    const msg = err.message;
    const status = msg.includes('not found') ? 404 : 400;
    return { status, message: msg };
  }
  return { status: 500, message: 'Unexpected server error' };
}

export interface CreateAppOptions {
  repoStore: RepoStore;
  auth: AuthManager;
  port: number;
  host: string;
  clientPort?: number | null;
  tailscalePort?: number | null;
  distClientDir?: string;
  hasBuiltClient?: boolean;
}

export function createGitDockApp(options: CreateAppOptions): Hono {
  const {
    repoStore,
    auth,
    port,
    host,
    clientPort = null,
    tailscalePort = DEFAULT_TAILSCALE_PORT,
    distClientDir = '',
    hasBuiltClient = false,
  } = options;
  const app = new Hono();

  app.use('/api/*', auth.middleware);

  app.get('/api/health', (c) => {
    return c.json({
      ok: true,
      port,
      clientPort,
      tailscalePort,
      authEnabled: auth.enabled,
      avoidsPrivilegedPorts: !PRIVILEGED_WEB_PORTS.has(port),
    });
  });

  app.get('/api/auth/session', (c) => {
    return c.json({ authenticated: true, authEnabled: auth.enabled });
  });

  app.post('/api/auth/pair', async (c) => {
    if (!auth.enabled) {
      return c.json({ ok: true, authEnabled: false });
    }
    const body = (await c.req.json().catch(() => ({}))) as { token?: string };
    const provided = (body.token ?? '').trim();
    if (!provided || provided !== auth.token) {
      return c.json({ ok: false, error: 'Invalid pairing token' }, 401);
    }
    setCookie(c, 'gitdock_token', auth.token, {
      httpOnly: true,
      sameSite: 'Lax',
      path: '/',
      maxAge: 60 * 60 * 24 * 30,
    });
    return c.json({ ok: true, authEnabled: true });
  });

  app.get('/api/network', async (c) => {
    const info = await buildNetworkInfo(port, host, auth.enabled, auth.token, {
      tailscalePort,
      clientPort,
    });
    return c.json(info);
  });

  app.get('/api/fs/browse', async (c) => {
    try {
      const requestedPath = c.req.query('path');
      const showHidden = c.req.query('hidden') === '1' || c.req.query('hidden') === 'true';
      const nearest = c.req.query('nearest') === '1' || c.req.query('nearest') === 'true';
      const data = await browseDirectories(requestedPath, { showHidden, nearest });
      return c.json(data);
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  app.get('/api/repos', (c) => {
    return c.json({ repos: repoStore.list() });
  });

  app.post('/api/repos', async (c) => {
    try {
      const body = (await c.req.json()) as { path?: string };
      if (!body.path || !body.path.trim()) {
        return c.json({ error: 'Repository path is required' }, 400);
      }
      const repo = await repoStore.addRepo(body.path.trim());
      return c.json({ repo }, 201);
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  app.delete('/api/repos/:id', async (c) => {
    const removed = await repoStore.removeRepo(c.req.param('id'));
    if (!removed) {
      return c.json({ error: 'Repository not found' }, 404);
    }
    return c.json({ ok: true });
  });

  const resolveRepo = (id: string) => {
    const repo = repoStore.getById(id);
    if (!repo) throw new Error(`Repository "${id}" not found`);
    return repo;
  };

  app.get('/api/repos/:id/status', async (c) => {
    try {
      const repo = resolveRepo(c.req.param('id'));
      const status = await getRepoStatus(repo);
      return c.json(status);
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  app.get('/api/repos/:id/diff', async (c) => {
    try {
      const repo = resolveRepo(c.req.param('id'));
      const filePath = c.req.query('path') ?? '';
      const sectionRaw = c.req.query('section') ?? 'unstaged';
      const hintRaw = c.req.query('hint');
      const context = Number.parseInt(c.req.query('context') ?? '3', 10) || 3;
      const section =
        sectionRaw === 'staged' || sectionRaw === 'conflicted' ? sectionRaw : 'unstaged';
      const hint = hintRaw === 'untracked' ? 'untracked' : undefined;

      if (!filePath) {
        return c.json({ error: 'Query parameter "path" is required' }, 400);
      }

      const diff = await getWorkingFileDiff(repo.path, filePath, section, context, hint);
      return c.json(diff);
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  app.post('/api/repos/:id/stage', async (c) => {
    try {
      const repo = resolveRepo(c.req.param('id'));
      const body = (await c.req.json().catch(() => ({}))) as { paths?: string[] };
      await stageFiles(repo.path, body.paths);
      const status = await getRepoStatus(repo);
      return c.json(status);
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  app.post('/api/repos/:id/unstage', async (c) => {
    try {
      const repo = resolveRepo(c.req.param('id'));
      const body = (await c.req.json().catch(() => ({}))) as { paths?: string[] };
      await unstageFiles(repo.path, body.paths);
      const status = await getRepoStatus(repo);
      return c.json(status);
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  app.post('/api/repos/:id/discard', async (c) => {
    try {
      const repo = resolveRepo(c.req.param('id'));
      const body = (await c.req.json()) as { path?: string };
      if (!body.path) {
        return c.json({ error: 'File path is required' }, 400);
      }
      await discardUnstagedFile(repo.path, body.path);
      const status = await getRepoStatus(repo);
      return c.json(status);
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  app.post('/api/repos/:id/commit', async (c) => {
    try {
      const repo = resolveRepo(c.req.param('id'));
      const body = (await c.req.json()) as { summary?: string; description?: string };
      const result = await createCommit(repo.path, body.summary ?? '', body.description ?? '');
      const status = await getRepoStatus(repo);
      return c.json({ ...result, status });
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  app.get('/api/repos/:id/commits', async (c) => {
    try {
      const repo = resolveRepo(c.req.param('id'));
      const limit = Math.min(100, Math.max(1, Number.parseInt(c.req.query('limit') ?? '40', 10) || 40));
      const offset = Math.max(0, Number.parseInt(c.req.query('offset') ?? '0', 10) || 0);
      const history = await getCommitHistory(repo.path, limit, offset);
      return c.json(history);
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  app.get('/api/repos/:id/commits/:sha', async (c) => {
    try {
      const repo = resolveRepo(c.req.param('id'));
      const detail = await getCommitDetail(repo.path, c.req.param('sha'));
      return c.json(detail);
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  app.get('/api/repos/:id/commits/:sha/diff', async (c) => {
    try {
      const repo = resolveRepo(c.req.param('id'));
      const filePath = c.req.query('path') ?? '';
      const context = Number.parseInt(c.req.query('context') ?? '3', 10) || 3;
      if (!filePath) {
        return c.json({ error: 'Query parameter "path" is required' }, 400);
      }
      const diff = await getCommitFileDiff(repo.path, c.req.param('sha'), filePath, context);
      return c.json(diff);
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  app.get('/api/repos/:id/remote/verify', async (c) => {
    try {
      const repo = resolveRepo(c.req.param('id'));
      const verification = await verifyRemoteSync(repo.path);
      return c.json(verification);
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  app.post('/api/repos/:id/remote/fetch', async (c) => {
    try {
      const repo = resolveRepo(c.req.param('id'));
      const res = await fetchRemote(repo.path);
      const status = await getRepoStatus(repo);
      return c.json({ ...res, status });
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  app.post('/api/repos/:id/remote/pull', async (c) => {
    try {
      const repo = resolveRepo(c.req.param('id'));
      const res = await pullBranch(repo.path);
      const status = await getRepoStatus(repo);
      return c.json({ ...res, status });
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  app.post('/api/repos/:id/remote/push', async (c) => {
    try {
      const repo = resolveRepo(c.req.param('id'));
      const body = (await c.req.json().catch(() => ({}))) as { setUpstream?: boolean };
      const res = await pushBranch(repo.path, Boolean(body.setUpstream));
      const status = await getRepoStatus(repo);
      return c.json({ ...res, status });
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  app.get('/api/repos/:id/branches', async (c) => {
    try {
      const repo = resolveRepo(c.req.param('id'));
      const branches = await listBranches(repo.path);
      return c.json({ branches });
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  app.post('/api/repos/:id/branches/checkout', async (c) => {
    try {
      const repo = resolveRepo(c.req.param('id'));
      const body = (await c.req.json()) as { branch?: string; create?: boolean };
      await checkoutBranch(repo.path, body.branch ?? '', Boolean(body.create));
      const status = await getRepoStatus(repo);
      return c.json({ status });
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }
  });

  // Live SSE watcher for instant mobile updates when code changes on desktop
  app.get('/api/repos/:id/events', async (c) => {
    let repo;
    try {
      repo = resolveRepo(c.req.param('id'));
    } catch (err) {
      const parsed = parseErrorPayload(err);
      return c.json({ error: parsed.message }, parsed.status);
    }

    return streamSSE(c, async (stream) => {
      let closed = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const watchers: fs.FSWatcher[] = [];

      const notifyChange = () => {
        if (closed) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          if (closed) return;
          void stream.writeSSE({ event: 'repo-changed', data: String(Date.now()) }).catch(() => {});
        }, 500);
      };

      const shouldIgnoreWatchPath = (rawName: string | null): boolean => {
        if (!rawName) return false;
        const rel = rawName.replace(/\\/g, '/').replace(/^\.\//, '');
        if (!rel) return true;
        if (
          rel === 'node_modules' ||
          rel.startsWith('node_modules/') ||
          rel.includes('/node_modules/') ||
          rel === 'dist' ||
          rel.startsWith('dist/') ||
          rel === '.vite' ||
          rel.startsWith('.vite/') ||
          rel === '.gitweb-repos.json' ||
          rel === '.gitweb-auth.json' ||
          rel.endsWith('.lock') ||
          rel.endsWith('.tmp') ||
          rel.endsWith('.swp') ||
          rel.endsWith('~')
        ) {
          return true;
        }
        if (rel === '.git' || rel.startsWith('.git/')) {
          const gitSub = rel === '.git' ? '' : rel.slice(5);
          if (!gitSub) return true;
          if (
            gitSub === 'HEAD' ||
            gitSub === 'index' ||
            gitSub === 'MERGE_HEAD' ||
            gitSub === 'REBASE_HEAD' ||
            gitSub === 'CHERRY_PICK_HEAD' ||
            gitSub.startsWith('refs/')
          ) {
            return false;
          }
          return true;
        }
        return false;
      };

      const safeWatch = (target: string, recursive: boolean) => {
        try {
          if (!fs.existsSync(target)) return;
          const watcher = fs.watch(target, { recursive }, (_eventType, filename) => {
            if (shouldIgnoreWatchPath(filename ? String(filename) : null)) {
              return;
            }
            notifyChange();
          });
          watchers.push(watcher);
        } catch {
          // Ignore OS watch limits gracefully
        }
      };

      safeWatch(repo.path, true);
      if (process.platform === 'linux') {
        safeWatch(path.join(repo.path, '.git', 'refs'), true);
      }

      const keepAlive = setInterval(() => {
        if (closed) return;
        void stream.writeSSE({ event: 'ping', data: 'ok' }).catch(() => {});
      }, 20_000);

      await stream.writeSSE({ event: 'connected', data: repo.id });

      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          closed = true;
          clearInterval(keepAlive);
          if (timer) clearTimeout(timer);
          for (const w of watchers) {
            try {
              w.close();
            } catch {
              // Ignore
            }
          }
          resolve();
        });
      });
    });
  });

  if (hasBuiltClient && distClientDir) {
    const relRoot = path.relative(process.cwd(), distClientDir) || '.';
    app.use('/*', serveStatic({ root: relRoot }));
    app.get('*', async (c) => {
      const html = await fsPromises.readFile(path.join(distClientDir, 'index.html'), 'utf8');
      return c.html(html);
    });
  } else {
    app.get('/', (c) => {
      const devHintPort = clientPort ?? 5173;
      return c.html(`
        <html><body style="font-family:system-ui;background:#0d1117;color:#e6edf3;padding:2rem;">
          <h2>GitDock Web API is running on port ${port}</h2>
          <p>Run <code>npm run build</code> for standalone SPA mode, or use <code>npm run dev</code> (Vite UI on port ${devHintPort}).</p>
        </body></html>
      `);
    });
  }

  return app;
}

export async function startServer() {
  const cli = parseCliArgs(process.argv.slice(2));

  if (cli.help) {
    printServerHelp();
    process.exit(0);
  }

  let effectivePortSpec = cli.portSpec;
  let effectiveTailscalePort = cli.tailscalePort;

  if (cli.interactive) {
    const session = createPromptSession();
    try {
      console.log('\n==============================================================');
      console.log('  GitDock Web Server — Interactive Port Selector');
      console.log('==============================================================');
      const serverChoice = await promptServicePort(session, {
        title: 'Service: server (Backend API & Git Engine)',
        defaultSpec: cli.portSpec,
        suggestedPorts: [7745, 7746, 8000, 8080, 8888, 9000],
        host: cli.host,
        allowPrivileged: cli.allowPrivilegedPort,
        strict: cli.strictPort,
        allowOff: false,
      });
      effectivePortSpec = String(serverChoice.port ?? cli.portSpec);

      const tsChoice = await promptServicePort(session, {
        title: 'Companion: tailscale serve HTTPS port',
        defaultSpec: effectiveTailscalePort === null ? 'off' : String(effectiveTailscalePort),
        suggestedPorts: [8443, 8444, 9443],
        host: cli.host,
        allowPrivileged: cli.allowPrivilegedPort,
        strict: false,
        allowOff: true,
      });
      effectiveTailscalePort = tsChoice.port;
    } finally {
      session.close();
    }
  } else {
    const parsedSpec = parsePortSpec(effectivePortSpec);
    if (
      !cli.allowPrivilegedPort &&
      parsedSpec.mode === 'candidates' &&
      parsedSpec.candidates.every((p) => PRIVILEGED_WEB_PORTS.has(p))
    ) {
      console.warn(
        `[GitDock] Refusing privileged port "${effectivePortSpec}" to avoid colliding with local web services (80/443). Selecting safe port near ${DEFAULT_PORT}...`,
      );
      effectivePortSpec = String(DEFAULT_PORT);
    }
  }

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  const distClientDir = path.join(projectRoot, 'dist', 'client');
  const distIndexHtml = path.join(distClientDir, 'index.html');
  let hasBuiltClient = fs.existsSync(distIndexHtml);

  if (cli.forceBuild || (cli.ensureBuild && !hasBuiltClient)) {
    const viteBinPath = path.resolve(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
    if (!fs.existsSync(viteBinPath)) {
      throw new Error('Cannot auto-build client: Vite binary not found in node_modules. Run npm install.');
    }
    console.log(
      cli.forceBuild
        ? '[GitDock] Rebuilding production client bundle...'
        : '[GitDock] dist/client not found — building production client bundle...',
    );
    execFileSync(process.execPath, [viteBinPath, 'build'], {
      cwd: projectRoot,
      stdio: 'inherit',
    });
    hasBuiltClient = fs.existsSync(distIndexHtml);
  }

  const repoStore = new RepoStore(projectRoot);
  await repoStore.init(cli.repoPaths);

  const auth = await createAuthManager(projectRoot, {
    disabled: cli.noAuth,
    explicitToken: process.env.GITWEB_TOKEN,
  });

  const resolvedPort = await resolvePortSpec(effectivePortSpec, {
    host: cli.host,
    strict: cli.strictPort,
    allowPrivileged: cli.allowPrivilegedPort,
    fallbackPort: DEFAULT_PORT,
  });
  if (resolvedPort === null) {
    throw new Error('Server port cannot be disabled ("off") when starting the server directly.');
  }
  const port = resolvedPort;
  const app = createGitDockApp({
    repoStore,
    auth,
    port,
    host: cli.host,
    clientPort: cli.clientPort,
    tailscalePort: effectiveTailscalePort,
    distClientDir,
    hasBuiltClient,
  });

  let server!: ReturnType<typeof serve>;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      reject(err);
    };
    server = serve(
      {
        fetch: app.fetch,
        port,
        hostname: cli.host,
      },
      () => {
        server.off('error', onError);
        resolve();
      },
    );
    server.once('error', onError);
  });

  const network = await buildNetworkInfo(port, cli.host, auth.enabled, auth.token, {
    tailscalePort: effectiveTailscalePort,
    clientPort: cli.clientPort,
  });
  const qrText = await renderTerminalQr(network.pairingUrl);

  console.log('\n==============================================================');
  console.log('  GitDock Web — Mobile-First Git Diff & Sync Companion');
  console.log('==============================================================');
  console.log(`  API Server  : http://localhost:${port} (bind ${cli.host})`);
  if (cli.clientPort) {
    console.log(`  Vite Dev UI : ${network.localUrl} (proxies /api -> 127.0.0.1:${port})`);
  } else {
    console.log(`  PC Local    : ${network.localUrl}`);
  }
  for (const lan of network.lanUrls) {
    console.log(`  Phone LAN   : ${lan.url}  (${lan.label})`);
  }
  if (network.tailscale.installed) {
    if (network.tailscale.serveHttpsUrl) {
      console.log(`  Tailscale HTTPS: ${network.tailscale.serveHttpsUrl}`);
    }
    if (network.tailscale.tailscaleUrl) {
      console.log(`  Tailscale HTTP : ${network.tailscale.tailscaleUrl}`);
    }
    if (network.tailscale.serveCommand && effectiveTailscalePort !== null) {
      console.log(`  HTTPS (${effectiveTailscalePort}) : ${network.tailscale.serveCommand}`);
    }
  }
  console.log(
    `  Ports 80/443: ${network.avoidsPrivilegedPorts ? `Untouched (active port ${port})` : `Privileged port ${port} active`}`,
  );
  if (auth.enabled) {
    console.log(`  Pair URL    : ${network.pairingUrl}`);
  } else {
    console.log('  Pairing Auth: Disabled (--no-auth)');
  }
  console.log(`  Repos Loaded: ${repoStore.list().length}`);
  console.log('--------------------------------------------------------------');
  console.log('  Scan QR from your smartphone camera:');
  console.log(qrText);
  console.log('==============================================================\n');

  return { server, port, app };
}

const isMainModule =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));

if (isMainModule) {
  startServer().catch((err) => {
    console.error('[GitDock] Fatal startup error:', err);
    process.exit(1);
  });
}

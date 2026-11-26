import {
  DEFAULT_CLIENT_PORT,
  DEFAULT_SERVER_PORT,
  DEFAULT_TAILSCALE_PORT,
  formatHostForUrl,
  parsePortSpec,
  resolvePortSpec,
  type ResolvePortOptions,
} from '../src/server/ports.ts';

export type RunnerMode = 'dev' | 'start';

export interface RunnerCliOptions {
  mode: RunnerMode;
  enableServer: boolean;
  enableClient: boolean;
  serverPortSpec: string;
  clientPortSpec: string;
  tailscalePort: number | null;
  proxyPort: number | null;
  apiTarget: string | null;
  host: string;
  repoPaths: string[];
  noAuth: boolean;
  strictPort: boolean;
  allowPrivilegedPort: boolean;
  watch: boolean;
  interactive: boolean;
  dryRun: boolean;
  help: boolean;
}

export interface RunnerPlan {
  mode: RunnerMode;
  host: string;
  strictPort: boolean;
  allowPrivilegedPort: boolean;
  watch: boolean;
  server: {
    enabled: boolean;
    port: number | null;
    args: string[];
    env: Record<string, string>;
  };
  client: {
    enabled: boolean;
    port: number | null;
    apiTarget: string;
    args: string[];
    env: Record<string, string>;
  };
  tailscalePort: number | null;
}

function splitFlagAndValue(
  argv: string[],
  index: number,
): { flag: string; value?: string; consumedNext: boolean } {
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

function parseSinglePortOrOff(raw: string, flagName: string): number | null {
  const spec = parsePortSpec(raw);
  if (spec.mode === 'disabled') return null;
  if (spec.mode === 'candidates' && !spec.hasRange && spec.candidates.length === 1) {
    return spec.candidates[0];
  }
  throw new Error(`Invalid ${flagName} value "${raw}". Expected a single port (1-65535) or "off".`);
}

function parseServicesList(raw: string): { enableServer: boolean; enableClient: boolean } {
  const tokens = raw
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  if (tokens.length === 0) {
    throw new Error('Option --services requires at least one service: server, client, or all');
  }

  let enableServer = false;
  let enableClient = false;

  for (const token of tokens) {
    if (token === 'all' || token === 'both') {
      enableServer = true;
      enableClient = true;
    } else if (token === 'server' || token === 'api' || token === 'backend') {
      enableServer = true;
    } else if (token === 'client' || token === 'vite' || token === 'ui' || token === 'frontend') {
      enableClient = true;
    } else {
      throw new Error(
        `Unknown service "${token}" in --services. Valid values: server, client, all.`,
      );
    }
  }

  return { enableServer, enableClient };
}

export function parseRunnerArgs(
  argv: string[],
  env: Record<string, string | undefined> = process.env,
): RunnerCliOptions {
  const envModeRaw = env.GITWEB_MODE?.trim().toLowerCase();
  const initialMode: RunnerMode = envModeRaw === 'start' || envModeRaw === 'prod' ? 'start' : 'dev';

  let mode: RunnerMode = initialMode;
  let servicesExplicit = false;
  let enableServer = true;
  let enableClient = initialMode === 'dev';

  if (env.GITWEB_SERVICES?.trim()) {
    const parsed = parseServicesList(env.GITWEB_SERVICES);
    enableServer = parsed.enableServer;
    enableClient = parsed.enableClient;
    servicesExplicit = true;
  }

  const envServerSpec =
    env.GITWEB_SERVER_PORT?.trim() ||
    env.GITWEB_PORT?.trim() ||
    env.PORT?.trim() ||
    String(DEFAULT_SERVER_PORT);

  const envClientSpec =
    env.GITWEB_CLIENT_PORT?.trim() || env.VITE_PORT?.trim() || String(DEFAULT_CLIENT_PORT);

  const envTailscaleRaw = env.GITWEB_TAILSCALE_PORT?.trim();
  const envProxyRaw = env.GITWEB_PROXY_PORT?.trim();

  const options: RunnerCliOptions = {
    mode,
    enableServer,
    enableClient,
    serverPortSpec: envServerSpec,
    clientPortSpec: envClientSpec,
    tailscalePort: envTailscaleRaw
      ? parseSinglePortOrOff(envTailscaleRaw, 'GITWEB_TAILSCALE_PORT')
      : DEFAULT_TAILSCALE_PORT,
    proxyPort: envProxyRaw ? parseSinglePortOrOff(envProxyRaw, 'GITWEB_PROXY_PORT') : null,
    apiTarget: env.GITWEB_API_TARGET?.trim() || null,
    host: env.GITWEB_HOST?.trim() || '0.0.0.0',
    repoPaths: [],
    noAuth: env.GITWEB_NO_AUTH === '1',
    strictPort: env.GITWEB_STRICT_PORT === '1',
    allowPrivilegedPort: env.GITWEB_ALLOW_PRIVILEGED_PORT === '1',
    watch: initialMode === 'dev',
    interactive: false,
    dryRun: false,
    help: false,
  };

  let watchExplicit = false;

  for (let i = 0; i < argv.length; i += 1) {
    const { flag, value, consumedNext } = splitFlagAndValue(argv, i);

    if (flag === '--help' || flag === '-h') {
      options.help = true;
    } else if (flag === '--interactive' || flag === '-i' || flag === '--pick' || flag === '--choose') {
      options.interactive = true;
    } else if (flag === '--dry-run' || flag === '--plan' || flag === '--check-ports') {
      options.dryRun = true;
    } else if (flag === '--mode' || flag === '-m') {
      if (!value) throw new Error(`Missing value for ${flag}`);
      const m = value.trim().toLowerCase();
      if (m === 'dev') {
        mode = 'dev';
      } else if (m === 'start' || m === 'prod' || m === 'production') {
        mode = 'start';
      } else {
        throw new Error(`Invalid --mode "${value}". Expected "dev" or "start".`);
      }
      options.mode = mode;
      if (!servicesExplicit) {
        options.enableServer = true;
        options.enableClient = mode === 'dev';
      }
      if (!watchExplicit) {
        options.watch = mode === 'dev';
      }
      if (consumedNext) i += 1;
    } else if (flag === '--services' || flag === '-s' || flag === '--only') {
      if (!value) throw new Error(`Missing value for ${flag}`);
      const parsed = parseServicesList(value);
      options.enableServer = parsed.enableServer;
      options.enableClient = parsed.enableClient;
      servicesExplicit = true;
      if (consumedNext) i += 1;
    } else if (flag === '--no-client' || flag === '--server-only') {
      options.enableServer = true;
      options.enableClient = false;
      servicesExplicit = true;
    } else if (flag === '--no-server' || flag === '--client-only') {
      options.enableServer = false;
      options.enableClient = true;
      servicesExplicit = true;
    } else if (
      flag === '--server-port' ||
      flag === '--api-port' ||
      flag === '--port' ||
      flag === '-p' ||
      flag === '--ports'
    ) {
      if (!value) throw new Error(`Missing value for ${flag}`);
      const spec = parsePortSpec(value);
      options.serverPortSpec = value;
      if (spec.mode === 'disabled') {
        options.enableServer = false;
      }
      if (consumedNext) i += 1;
    } else if (flag === '--client-port' || flag === '--vite-port' || flag === '--ui-port') {
      if (!value) throw new Error(`Missing value for ${flag}`);
      const spec = parsePortSpec(value);
      options.clientPortSpec = value;
      if (spec.mode === 'disabled') {
        options.enableClient = false;
      } else if (!servicesExplicit && options.mode === 'dev') {
        options.enableClient = true;
      }
      if (consumedNext) i += 1;
    } else if (flag === '--tailscale-port') {
      if (!value) throw new Error(`Missing value for ${flag}`);
      options.tailscalePort = parseSinglePortOrOff(value, flag);
      if (consumedNext) i += 1;
    } else if (flag === '--proxy-port') {
      if (!value) throw new Error(`Missing value for ${flag}`);
      const port = parseSinglePortOrOff(value, flag);
      if (port === null) {
        throw new Error('--proxy-port cannot be "off"');
      }
      options.proxyPort = port;
      if (consumedNext) i += 1;
    } else if (flag === '--api-target') {
      if (!value) throw new Error(`Missing value for ${flag}`);
      options.apiTarget = value.trim();
      if (consumedNext) i += 1;
    } else if (flag === '--host' || flag === '-H') {
      if (!value) throw new Error(`Missing value for ${flag}`);
      options.host = value.trim();
      if (consumedNext) i += 1;
    } else if (flag === '--repo' || flag === '-r') {
      if (!value) throw new Error(`Missing value for ${flag}`);
      options.repoPaths.push(value);
      if (consumedNext) i += 1;
    } else if (flag === '--no-auth') {
      options.noAuth = true;
    } else if (flag === '--strict-port') {
      options.strictPort = true;
    } else if (flag === '--allow-privileged-port') {
      options.allowPrivilegedPort = true;
    } else if (flag === '--watch') {
      options.watch = true;
      watchExplicit = true;
    } else if (flag === '--no-watch') {
      options.watch = false;
      watchExplicit = true;
    } else {
      throw new Error(`Unknown runner option "${flag}". Run with --help to see supported options.`);
    }
  }

  // Validate specs even when inherited from env
  const parsedServerSpec = parsePortSpec(options.serverPortSpec);
  if (parsedServerSpec.mode === 'disabled') {
    options.enableServer = false;
  }
  const parsedClientSpec = parsePortSpec(options.clientPortSpec);
  if (parsedClientSpec.mode === 'disabled') {
    options.enableClient = false;
  }

  if (!options.help && !options.interactive && !options.enableServer && !options.enableClient) {
    throw new Error('At least one service ("server" or "client") must be active.');
  }

  return options;
}

function inferProxyPort(options: RunnerCliOptions): number {
  if (options.proxyPort !== null) return options.proxyPort;
  const spec = parsePortSpec(options.serverPortSpec);
  if (spec.mode === 'candidates' && spec.candidates.length > 0) {
    return spec.candidates[0];
  }
  return DEFAULT_SERVER_PORT;
}

export async function resolveRunnerPlan(
  options: RunnerCliOptions,
  portResolverOverrides: Pick<ResolvePortOptions, 'isAvailable' | 'getEphemeral'> = {},
): Promise<RunnerPlan> {
  if (!options.enableServer && !options.enableClient) {
    throw new Error('At least one service ("server" or "client") must be active.');
  }

  const allocatedPorts = new Set<number>();

  let serverPort: number | null = null;
  if (options.enableServer) {
    serverPort = await resolvePortSpec(options.serverPortSpec, {
      host: options.host,
      strict: options.strictPort,
      allowPrivileged: options.allowPrivilegedPort,
      fallbackPort: DEFAULT_SERVER_PORT,
      ...portResolverOverrides,
    });
    if (serverPort === null) {
      throw new Error('Server service is enabled, so server port cannot be "off".');
    }
    allocatedPorts.add(serverPort);
  }

  let clientPort: number | null = null;
  if (options.enableClient) {
    clientPort = await resolvePortSpec(options.clientPortSpec, {
      host: options.host,
      strict: options.strictPort,
      allowPrivileged: options.allowPrivilegedPort,
      excludePorts: allocatedPorts,
      fallbackPort: DEFAULT_CLIENT_PORT,
      ...portResolverOverrides,
    });
    if (clientPort === null) {
      throw new Error('Client service is enabled, so client port cannot be "off".');
    }
    allocatedPorts.add(clientPort);
  }

  const proxyHost = formatHostForUrl(options.host);
  const proxyTargetPort = serverPort ?? inferProxyPort(options);
  const apiTarget = options.apiTarget || `http://${proxyHost}:${proxyTargetPort}`;

  const serverArgs: string[] = [];
  if (options.watch) {
    serverArgs.push('--watch');
  }
  serverArgs.push('src/server/index.ts');

  if (serverPort !== null) {
    serverArgs.push('--port', String(serverPort));
  }
  serverArgs.push('--host', options.host);
  serverArgs.push(
    '--tailscale-port',
    options.tailscalePort === null ? 'off' : String(options.tailscalePort),
  );
  if (options.strictPort) {
    serverArgs.push('--strict-port');
  }
  if (options.allowPrivilegedPort) {
    serverArgs.push('--allow-privileged-port');
  }
  if (options.noAuth) {
    serverArgs.push('--no-auth');
  }
  for (const repoPath of options.repoPaths) {
    serverArgs.push('--repo', repoPath);
  }

  const serverEnv: Record<string, string> = {
    GITWEB_HOST: options.host,
    GITWEB_TAILSCALE_PORT: options.tailscalePort === null ? 'off' : String(options.tailscalePort),
  };
  if (serverPort !== null) {
    serverEnv.GITWEB_PORT = String(serverPort);
    serverEnv.GITWEB_SERVER_PORT = String(serverPort);
  }
  if (clientPort !== null) {
    serverEnv.GITWEB_CLIENT_PORT = String(clientPort);
  }
  if (options.strictPort) {
    serverEnv.GITWEB_STRICT_PORT = '1';
  }
  if (options.allowPrivilegedPort) {
    serverEnv.GITWEB_ALLOW_PRIVILEGED_PORT = '1';
  }
  if (options.noAuth) {
    serverEnv.GITWEB_NO_AUTH = '1';
  }

  const viteArgs: string[] =
    clientPort !== null
      ? ['--host', options.host, '--port', String(clientPort), '--strictPort']
      : [];

  const viteEnv: Record<string, string> = {
    GITWEB_HOST: options.host,
    GITWEB_API_TARGET: apiTarget,
    GITWEB_STRICT_PORT: '1',
  };
  if (clientPort !== null) {
    viteEnv.GITWEB_CLIENT_PORT = String(clientPort);
  }
  const portStr = String(proxyTargetPort);
  viteEnv.GITWEB_SERVER_PORT = portStr;
  viteEnv.GITWEB_PORT = portStr;

  return {
    mode: options.mode,
    host: options.host,
    strictPort: options.strictPort,
    allowPrivilegedPort: options.allowPrivilegedPort,
    watch: options.watch,
    server: {
      enabled: serverPort !== null,
      port: serverPort,
      args: serverArgs,
      env: serverEnv,
    },
    client: {
      enabled: clientPort !== null,
      port: clientPort,
      apiTarget,
      args: viteArgs,
      env: viteEnv,
    },
    tailscalePort: options.tailscalePort,
  };
}

export function formatRunnerPlan(plan: RunnerPlan): string {
  const localHost = formatHostForUrl(plan.host);
  const lines: string[] = [
    '--------------------------------------------------------------',
    `  Project Runner Plan (mode: ${plan.mode}, host: ${plan.host})`,
    '--------------------------------------------------------------',
  ];

  if (plan.server.enabled && plan.server.port !== null) {
    lines.push(
      `  [ACTIVE] server    -> port ${plan.server.port} (http://${localHost}:${plan.server.port})${plan.watch ? ' [watch]' : ''}`,
    );
  } else {
    lines.push('  [OFF]    server    -> disabled');
  }

  if (plan.client.enabled && plan.client.port !== null) {
    lines.push(
      `  [ACTIVE] client    -> port ${plan.client.port} (http://${localHost}:${plan.client.port}) [proxy /api -> ${plan.client.apiTarget}]`,
    );
  } else {
    lines.push('  [OFF]    client    -> disabled');
  }

  if (plan.tailscalePort !== null) {
    lines.push(`  [CONFIG] tailscale -> HTTPS port ${plan.tailscalePort}`);
  } else {
    lines.push('  [OFF]    tailscale -> disabled');
  }

  lines.push('--------------------------------------------------------------');
  return lines.join('\n');
}

export function getRunnerHelpText(): string {
  return `GitDock Web — Flexible Project Runner

Usage:
  npm run dev -- [options]
  npm run dev:pick

Service Selection:
  -s, --services <list>        Services to activate: "server", "client", or "all"
      --only <list>            Alias for --services
      --no-client              Run backend server only (alias: --server-only)
      --no-server              Run Vite dev client only (alias: --client-only)
  -m, --mode <dev|start>       "dev" (server watch + Vite) or "start" (server only)

Flexible Port Selection (<spec> = 8080 | 7745,8080 | 8000-8010 | auto | off):
  -p, --server-port <spec>     Backend API port spec (aliases: --port, --api-port)
      --client-port <spec>     Vite UI dev server port spec (aliases: --vite-port, --ui-port)
      --tailscale-port <n|off> Tailscale HTTPS serve port (default: 8443)
      --proxy-port <port>      Backend port for /api proxy when server is off
      --api-target <url>       Explicit backend URL for /api proxy
      --strict-port            Fail if specified port(s) are busy instead of auto-stepping
      --allow-privileged-port  Allow ports < 1024 (including 80/443)

General & Interactive Options:
  -i, --interactive            Interactive live port scanner & service picker
      --dry-run                Resolve and print the service/port plan without starting
  -H, --host <ip>              Bind interface (default: 0.0.0.0)
  -r, --repo <path>            Register a local Git repository (repeatable)
      --no-auth                Disable LAN pairing token requirement
      --watch / --no-watch     Toggle Node --watch on backend server
  -h, --help                   Show this help message

Examples:
  npm run dev:pick
  npm run dev -- --server-port 8080 --client-port 3000
  npm run dev -- --server-port 7750-7760 --client-port auto
  npm run dev -- --services server --server-port 9000 --tailscale-port 9443
  npm run dev -- --services client --client-port 4000 --proxy-port 9000
`;
}

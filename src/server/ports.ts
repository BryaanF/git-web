import net from 'node:net';

export const DEFAULT_SERVER_PORT = 7745;
export const DEFAULT_CLIENT_PORT = 5173;
export const DEFAULT_TAILSCALE_PORT = 8443;
export const PRIVILEGED_WEB_PORTS = new Set([80, 443]);

export type PortSpec =
  | { mode: 'disabled'; raw: string }
  | { mode: 'auto'; raw: string }
  | { mode: 'candidates'; raw: string; candidates: number[]; hasRange: boolean };

export interface ResolvePortOptions {
  host?: string;
  strict?: boolean;
  allowPrivileged?: boolean;
  excludePorts?: ReadonlySet<number>;
  fallbackPort?: number;
  maxAutoStep?: number;
  isAvailable?: (port: number, host: string) => Promise<boolean>;
  getEphemeral?: (host: string) => Promise<number>;
}

const MAX_PORT = 65535;
const MAX_RANGE_SPAN = 10000;

export function formatHostForUrl(host: string): string {
  const trimmed = host.trim();
  if (!trimmed || trimmed === '0.0.0.0' || trimmed === '::') {
    return '127.0.0.1';
  }
  if (trimmed.includes(':') && !trimmed.startsWith('[')) {
    return `[${trimmed}]`;
  }
  return trimmed;
}

export function isPortAvailable(port: number, host = '0.0.0.0'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}

export function getEphemeralPort(host = '0.0.0.0'): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', (err) => reject(err));
    server.once('listening', () => {
      const addr = server.address();
      if (!addr || typeof addr !== 'object') {
        server.close(() => reject(new Error('Failed to obtain ephemeral port from OS')));
        return;
      }
      const chosen = addr.port;
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve(chosen);
      });
    });
    server.listen(0, host);
  });
}

export async function probePorts(
  ports: readonly number[],
  host = '0.0.0.0',
  checkAvailable: (port: number, host: string) => Promise<boolean> = isPortAvailable,
): Promise<Array<{ port: number; available: boolean }>> {
  return Promise.all(
    ports.map(async (port) => ({
      port,
      available: await checkAvailable(port, host),
    })),
  );
}

/**
 * Parses a flexible port specifier:
 * - "off" / "none" / "disabled" -> disabled
 * - "auto" / "any" / "random" / "0" -> dynamic ephemeral port
 * - "7745" -> single port
 * - "7745,8080,9000" -> ordered candidate list
 * - "8000-8010" -> inclusive port range
 * - "7745,8000-8010" -> combined ordered candidates and ranges
 */
export function parsePortSpec(rawInput: string | number): PortSpec {
  const raw = String(rawInput).trim();
  if (!raw) {
    throw new Error('Port specification cannot be empty');
  }

  const lower = raw.toLowerCase();
  if (lower === 'off' || lower === 'none' || lower === 'disabled' || lower === 'false') {
    return { mode: 'disabled', raw };
  }
  if (lower === 'auto' || lower === 'any' || lower === 'random' || lower === '0') {
    return { mode: 'auto', raw };
  }

  const seen = new Set<number>();
  const candidates: number[] = [];
  let hasRange = false;

  for (const segmentRaw of raw.split(',')) {
    const segment = segmentRaw.trim();
    if (!segment) {
      throw new Error(`Invalid empty item in port specification "${raw}"`);
    }

    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(segment);
    if (rangeMatch) {
      const start = Number.parseInt(rangeMatch[1], 10);
      const end = Number.parseInt(rangeMatch[2], 10);
      if (start < 1 || end > MAX_PORT || start > end) {
        throw new Error(`Invalid port range "${segment}" (expected 1-${MAX_PORT} with start <= end)`);
      }
      if (end - start > MAX_RANGE_SPAN) {
        throw new Error(`Port range "${segment}" is too wide (max ${MAX_RANGE_SPAN} ports)`);
      }
      hasRange = true;
      for (let p = start; p <= end; p += 1) {
        if (!seen.has(p)) {
          seen.add(p);
          candidates.push(p);
        }
      }
      continue;
    }

    if (/^\d+$/.test(segment)) {
      const port = Number.parseInt(segment, 10);
      if (port < 1 || port > MAX_PORT) {
        throw new Error(`Port ${port} is out of range (expected 1-${MAX_PORT})`);
      }
      if (!seen.has(port)) {
        seen.add(port);
        candidates.push(port);
      }
      continue;
    }

    throw new Error(
      `Invalid port specification "${raw}". Use a port (e.g. 7745), list (7745,8080), range (8000-8010), "auto", or "off".`,
    );
  }

  if (candidates.length === 0) {
    throw new Error(`No valid ports found in specification "${raw}"`);
  }

  return { mode: 'candidates', raw, candidates, hasRange };
}

function isPortAcceptable(
  port: number,
  allowPrivileged: boolean,
  excludePorts?: ReadonlySet<number>,
): boolean {
  if (port < 1 || port > MAX_PORT) return false;
  if (excludePorts?.has(port)) return false;
  if (!allowPrivileged && (PRIVILEGED_WEB_PORTS.has(port) || port < 1024)) {
    return false;
  }
  return true;
}

/**
 * Resolves a flexible port specification against live socket availability while
 * avoiding excluded ports (such as another active service) and privileged ports
 * unless explicitly permitted.
 */
export async function resolvePortSpec(
  specInput: string | number | PortSpec,
  options: ResolvePortOptions = {},
): Promise<number | null> {
  const spec = typeof specInput === 'object' ? specInput : parsePortSpec(specInput);
  if (spec.mode === 'disabled') {
    return null;
  }

  const host = options.host ?? '0.0.0.0';
  const strict = Boolean(options.strict);
  const allowPrivileged = Boolean(options.allowPrivileged);
  const excludePorts = options.excludePorts;
  const fallbackPort = options.fallbackPort ?? DEFAULT_SERVER_PORT;
  const maxAutoStep = options.maxAutoStep ?? 60;
  const checkAvailable = options.isAvailable ?? isPortAvailable;
  const pickEphemeral = options.getEphemeral ?? getEphemeralPort;

  if (spec.mode === 'auto') {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const candidate = await pickEphemeral(host);
      if (isPortAcceptable(candidate, allowPrivileged, excludePorts)) {
        return candidate;
      }
    }
    throw new Error('Failed to allocate an available non-conflicting ephemeral port');
  }

  let rejectedPrivileged = false;

  for (const port of spec.candidates) {
    if (!isPortAcceptable(port, allowPrivileged, excludePorts)) {
      if (!allowPrivileged && (PRIVILEGED_WEB_PORTS.has(port) || port < 1024)) {
        rejectedPrivileged = true;
      }
      continue;
    }
    if (await checkAvailable(port, host)) {
      return port;
    }
  }

  if (strict || spec.hasRange) {
    if (rejectedPrivileged && !allowPrivileged) {
      throw new Error(
        `No usable port from "${spec.raw}" on ${host}: ports < 1024 require --allow-privileged-port and other candidates are occupied or already assigned.`,
      );
    }
    throw new Error(
      `No free port available matching "${spec.raw}" on ${host}${strict ? ' (--strict-port enabled)' : ''}.`,
    );
  }

  const first = spec.candidates[0];
  const stepBase =
    !allowPrivileged && (PRIVILEGED_WEB_PORTS.has(first) || first < 1024) ? fallbackPort : first;

  for (let offset = 0; offset < maxAutoStep; offset += 1) {
    const candidate = stepBase + offset;
    if (!isPortAcceptable(candidate, allowPrivileged, excludePorts)) continue;
    if (await checkAvailable(candidate, host)) {
      return candidate;
    }
  }

  throw new Error(`No free unprivileged port found near ${stepBase} on ${host}`);
}

/**
 * Picks a safe port starting from preferredPort, automatically stepping
 * forward if another local dev service already holds it (unless strict=true).
 */
export async function findSafePort(
  preferredPort = DEFAULT_SERVER_PORT,
  host = '0.0.0.0',
  options: Omit<ResolvePortOptions, 'host'> = {},
): Promise<number> {
  const resolved = await resolvePortSpec(preferredPort, {
    ...options,
    host,
    fallbackPort: options.fallbackPort ?? DEFAULT_SERVER_PORT,
  });
  if (resolved === null) {
    throw new Error('Server port cannot be disabled');
  }
  return resolved;
}

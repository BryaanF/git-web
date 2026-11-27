import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

export interface AuthManager {
  enabled: boolean;
  token: string;
  middleware: (c: Context, next: Next) => Promise<Response | void>;
  checkPairRateLimit: (c: Context) => { allowed: boolean; retryAfterSec?: number };
  recordPairAttempt: (c: Context, success: boolean) => void;
}

const PAIR_WINDOW_MS = 60_000;
const MAX_PAIR_FAILURES = 10;
const MAX_RATE_LIMIT_KEYS = 1000;

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}

function extractHostHostname(hostHeader: string | undefined): string {
  if (!hostHeader) return '';
  const trimmed = hostHeader.trim().toLowerCase();
  if (!trimmed) return '';
  if (trimmed.startsWith('[')) {
    const endIdx = trimmed.indexOf(']');
    return endIdx > 0 ? trimmed.slice(1, endIdx) : trimmed;
  }
  const colonIdx = trimmed.indexOf(':');
  return colonIdx > 0 ? trimmed.slice(0, colonIdx) : trimmed;
}

export function isLoopbackHostname(hostname: string): boolean {
  const lower = hostname.trim().toLowerCase();
  return lower === 'localhost' || lower === '127.0.0.1' || lower === '::1';
}

export function isHttpsRequest(c: Context): boolean {
  const forwardedProto = c.req.header('x-forwarded-proto')?.split(',')[0]?.trim().toLowerCase();
  if (forwardedProto === 'https') return true;
  return c.req.url.startsWith('https://');
}

export function setAuthCookie(c: Context, token: string): void {
  setCookie(c, 'gitdock_token', token, {
    httpOnly: true,
    sameSite: 'Lax',
    secure: isHttpsRequest(c),
    path: '/',
    maxAge: 60 * 60 * 24 * 30,
  });
}

function isAllowedOrigin(
  originHeader: string,
  c: Context,
  remoteAddr: string | undefined,
  clientPort: number | null,
): boolean {
  if (originHeader === 'null') return false;
  let originUrl: URL;
  try {
    originUrl = new URL(originHeader);
  } catch {
    return false;
  }
  if (originUrl.protocol !== 'http:' && originUrl.protocol !== 'https:') {
    return false;
  }

  const forwardedHost = c.req.header('x-forwarded-host')?.split(',')[0]?.trim().toLowerCase();
  const hostHeader = (forwardedHost || c.req.header('host') || '').trim().toLowerCase();
  if (hostHeader && originUrl.host.toLowerCase() === hostHeader) {
    return true;
  }

  const requestHostname = extractHostHostname(hostHeader);
  const originHostname = originUrl.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (isLoopbackHostname(originHostname) && isLoopbackHostname(requestHostname)) {
    return true;
  }

  // Allow browsers asserting same-origin via Sec-Fetch-Site (forbidden header in browser JS)
  const secFetchSite = c.req.header('sec-fetch-site')?.trim().toLowerCase();
  if (secFetchSite === 'same-origin') {
    return true;
  }

  // Allow Tailscale Serve HTTPS origins when Tailscale identity header is present
  if (
    c.req.header('tailscale-user-login') &&
    originUrl.protocol === 'https:' &&
    originUrl.hostname.toLowerCase().endsWith('.ts.net')
  ) {
    return true;
  }

  // Allow Vite dev proxy forwarding from LAN browser origins when clientPort matches.
  if (
    clientPort !== null &&
    !c.req.header('tailscale-user-login') &&
    isLoopbackAddress(remoteAddr) &&
    originUrl.port === String(clientPort)
  ) {
    return true;
  }

  return false;
}

function getClientRateLimitKey(c: Context): string {
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  const remoteAddr = incoming?.socket?.remoteAddress || 'unknown';
  if (isLoopbackAddress(remoteAddr)) {
    const forwarded = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
    if (forwarded) return `proxy:${forwarded}`;
  }
  return remoteAddr;
}

export async function createAuthManager(
  dataDir: string,
  options: { disabled?: boolean; explicitToken?: string; clientPort?: number | null } = {},
): Promise<AuthManager> {
  const pairFailures = new Map<string, number[]>();
  const clientPort = options.clientPort ?? null;

  const checkPairRateLimit = (c: Context): { allowed: boolean; retryAfterSec?: number } => {
    const key = getClientRateLimitKey(c);
    const now = Date.now();
    const recent = (pairFailures.get(key) ?? []).filter((ts) => now - ts < PAIR_WINDOW_MS);
    if (recent.length === 0) {
      pairFailures.delete(key);
      return { allowed: true };
    }
    pairFailures.set(key, recent);
    if (recent.length >= MAX_PAIR_FAILURES) {
      const oldest = recent[0];
      const retryAfterSec = Math.max(1, Math.ceil((PAIR_WINDOW_MS - (now - oldest)) / 1000));
      return { allowed: false, retryAfterSec };
    }
    return { allowed: true };
  };

  const recordPairAttempt = (c: Context, success: boolean): void => {
    const key = getClientRateLimitKey(c);
    if (success) {
      pairFailures.delete(key);
      return;
    }
    const now = Date.now();
    const recent = (pairFailures.get(key) ?? []).filter((ts) => now - ts < PAIR_WINDOW_MS);
    recent.push(now);
    if (pairFailures.size >= MAX_RATE_LIMIT_KEYS && !pairFailures.has(key)) {
      const firstKey = pairFailures.keys().next().value;
      if (firstKey) pairFailures.delete(firstKey);
    }
    pairFailures.set(key, recent);
  };

  const checkCsrfProtection = (c: Context, remoteAddr: string | undefined): Response | null => {
    const secFetchSite = c.req.header('sec-fetch-site')?.trim().toLowerCase();
    if (secFetchSite === 'cross-site') {
      return c.json({ error: 'Cross-site API requests are forbidden', code: 'CSRF_BLOCKED' }, 403);
    }

    const method = c.req.method.toUpperCase();
    if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') {
      return null;
    }

    const originHeader = c.req.header('origin');
    if (originHeader !== undefined && !isAllowedOrigin(originHeader, c, remoteAddr, clientPort)) {
      return c.json({ error: 'Invalid request origin', code: 'CSRF_BLOCKED' }, 403);
    }

    const isBrowserContext = Boolean(
      originHeader ||
      secFetchSite ||
      c.req.header('referer') ||
      c.req.header('cookie'),
    );
    if (isBrowserContext) {
      const hasCustomHeader = Boolean(
        c.req.header('x-gitdock-request') ||
        c.req.header('x-gitweb-token') ||
        c.req.header('authorization'),
      );
      const contentType = c.req.header('content-type')?.toLowerCase() ?? '';
      const hasJsonContentType = contentType.includes('application/json');
      if (!hasCustomHeader && !hasJsonContentType) {
        return c.json(
          { error: 'Missing required anti-CSRF request header', code: 'CSRF_BLOCKED' },
          403,
        );
      }
    }

    return null;
  };

  if (options.disabled) {
    return {
      enabled: false,
      token: '',
      checkPairRateLimit,
      recordPairAttempt,
      middleware: async (c, next) => {
        const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
        const csrfDenied = checkCsrfProtection(c, incoming?.socket?.remoteAddress);
        if (csrfDenied) return csrfDenied;
        await next();
      },
    };
  }

  const tokenFile = path.join(dataDir, '.gitweb-auth.json');
  let token = options.explicitToken?.trim() || '';

  if (!token) {
    try {
      const raw = await fs.readFile(tokenFile, 'utf8');
      const parsed = JSON.parse(raw) as { token?: string };
      if (parsed.token && parsed.token.length >= 16) {
        token = parsed.token;
        await fs.chmod(tokenFile, 0o600).catch(() => {});
      }
    } catch {
      // Create new token below
    }
  }

  if (!token) {
    token = crypto.randomBytes(18).toString('base64url');
    await fs
      .writeFile(tokenFile, JSON.stringify({ token }, null, 2), { encoding: 'utf8', mode: 0o600 })
      .catch(() => {});
    await fs.chmod(tokenFile, 0o600).catch(() => {});
  }

  const cookieName = 'gitdock_token';

  const middleware = async (c: Context, next: Next): Promise<Response | void> => {
    const reqPath = c.req.path;
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
    const remoteAddr = incoming?.socket?.remoteAddress;

    const csrfDenied = checkCsrfProtection(c, remoteAddr);
    if (csrfDenied) return csrfDenied;

    // Allow health and token exchange endpoints without prior cookie
    if (reqPath === '/api/health' || reqPath === '/api/auth/pair') {
      await next();
      return;
    }

    // Allow direct loopback desktop browser automatically, guarded against DNS rebinding via Host check
    const forwardedFor = c.req.header('x-forwarded-for');
    const isTailscaleOrProxy = Boolean(forwardedFor || c.req.header('tailscale-user-login'));
    const hostHostname = extractHostHostname(c.req.header('host'));
    const hasSafeLoopbackHost = hostHostname
      ? isLoopbackHostname(hostHostname)
      : isLoopbackHostname(new URL(c.req.url).hostname);

    if (!isTailscaleOrProxy && isLoopbackAddress(remoteAddr) && hasSafeLoopbackHost) {
      await next();
      return;
    }

    const headerToken = c.req.header('x-gitweb-token') || c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const queryToken = c.req.query('token');
    const cookieToken = getCookie(c, cookieName);
    const provided = headerToken || queryToken || cookieToken || '';

    if (provided && timingSafeEquals(provided, token)) {
      if (queryToken && provided === queryToken) {
        setAuthCookie(c, token);
      }
      await next();
      return;
    }

    return c.json(
      {
        error: 'Pairing token required. Scan the QR code on your PC or paste your pairing token.',
        code: 'AUTH_REQUIRED',
      },
      401,
    );
  };

  return {
    enabled: true,
    token,
    middleware,
    checkPairRateLimit,
    recordPairAttempt,
  };
}

function timingSafeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

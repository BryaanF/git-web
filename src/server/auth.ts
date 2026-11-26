import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Context, Next } from 'hono';
import { getCookie, setCookie } from 'hono/cookie';

export interface AuthManager {
  enabled: boolean;
  token: string;
  middleware: (c: Context, next: Next) => Promise<Response | void>;
}

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return (
    remoteAddress === '127.0.0.1' ||
    remoteAddress === '::1' ||
    remoteAddress === '::ffff:127.0.0.1'
  );
}

export async function createAuthManager(
  dataDir: string,
  options: { disabled?: boolean; explicitToken?: string } = {},
): Promise<AuthManager> {
  if (options.disabled) {
    return {
      enabled: false,
      token: '',
      middleware: async (_c, next) => {
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
      }
    } catch {
      // Create new token below
    }
  }

  if (!token) {
    token = crypto.randomBytes(18).toString('base64url');
    await fs.writeFile(tokenFile, JSON.stringify({ token }, null, 2), 'utf8').catch(() => {});
  }

  const cookieName = 'gitdock_token';

  const middleware = async (c: Context, next: Next): Promise<Response | void> => {
    const reqPath = c.req.path;

    // Allow health and token exchange endpoints without prior cookie
    if (reqPath === '/api/health' || reqPath === '/api/auth/pair') {
      await next();
      return;
    }

    // Allow direct loopback desktop browser automatically
    const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
    const remoteAddr = incoming?.socket?.remoteAddress;
    const forwardedFor = c.req.header('x-forwarded-for');
    const isTailscaleOrProxy = Boolean(forwardedFor || c.req.header('tailscale-user-login'));

    if (!isTailscaleOrProxy && isLoopbackAddress(remoteAddr)) {
      await next();
      return;
    }

    const headerToken = c.req.header('x-gitweb-token') || c.req.header('authorization')?.replace(/^Bearer\s+/i, '');
    const queryToken = c.req.query('token');
    const cookieToken = getCookie(c, cookieName);
    const provided = headerToken || queryToken || cookieToken || '';

    if (provided && timingSafeEquals(provided, token)) {
      if (queryToken && provided === queryToken) {
        setCookie(c, cookieName, token, {
          httpOnly: true,
          sameSite: 'Lax',
          path: '/',
          maxAge: 60 * 60 * 24 * 30,
        });
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
  };
}

function timingSafeEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

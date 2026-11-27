import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { serve, type ServerType } from '@hono/node-server';
import { createAuthManager } from '../src/server/auth.ts';
import { browseDirectories } from '../src/server/fs/browse.ts';
import { createGitDockApp } from '../src/server/index.ts';
import { RepoStore } from '../src/server/repos/store.ts';
import type { DirectoryBrowseResponse } from '../src/shared/types.ts';

test('browseDirectories lists subfolders, flags .git repos, respects hidden toggle, and resolves nearest ancestor', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdock-browse-unit-'));
  try {
    const projectA = path.join(tmpRoot, 'alpha-repo');
    const plainDir = path.join(tmpRoot, 'beta-folder');
    const hiddenDir = path.join(tmpRoot, '.hidden-cache');
    await fs.mkdir(path.join(projectA, '.git'), { recursive: true });
    await fs.mkdir(plainDir, { recursive: true });
    await fs.mkdir(hiddenDir, { recursive: true });
    await fs.writeFile(path.join(tmpRoot, 'notes.txt'), 'hello', 'utf8');

    const rootListing = await browseDirectories(tmpRoot);
    assert.equal(rootListing.currentPath, path.resolve(tmpRoot));
    assert.equal(rootListing.currentIsGitRepo, false);
    assert.equal(rootListing.parentPath, path.dirname(path.resolve(tmpRoot)));
    assert.ok(rootListing.roots.length >= 1);

    // Excludes regular files, .git, and hidden dot-folders by default
    assert.deepEqual(
      rootListing.entries.map((e) => ({ name: e.name, isGitRepo: e.isGitRepo })),
      [
        { name: 'alpha-repo', isGitRepo: true },
        { name: 'beta-folder', isGitRepo: false },
      ],
    );

    const hiddenListing = await browseDirectories(tmpRoot, { showHidden: true });
    assert.ok(hiddenListing.entries.some((e) => e.name === '.hidden-cache'));

    // Opening the git repo itself sets currentIsGitRepo and suppresses .git in entries
    const insideRepo = await browseDirectories(projectA);
    assert.equal(insideRepo.currentIsGitRepo, true);
    assert.deepEqual(insideRepo.entries, []);

    // Nearest ancestor resolution falls back to existing parent when typing incomplete path
    const nearest = await browseDirectories(path.join(plainDir, 'missing', 'deep'), {
      nearest: true,
    });
    assert.equal(nearest.currentPath, path.resolve(plainDir));

    // Strict mode throws for missing directory
    await assert.rejects(() => browseDirectories(path.join(tmpRoot, 'does-not-exist')));
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

test('GET /api/fs/browse enforces auth and serves host directory listings cleanly', async () => {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdock-browse-http-'));
  const dataDir = path.join(tmpBase, 'data');
  const workspaceDir = path.join(tmpBase, 'workspace');
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.join(workspaceDir, 'my-git-project', '.git'), { recursive: true });
  await fs.mkdir(path.join(workspaceDir, 'docs'), { recursive: true });

  let server: ServerType | null = null;
  try {
    const repoStore = new RepoStore(dataDir);
    await repoStore.init([]);
    const auth = await createAuthManager(dataDir, { explicitToken: 'test-token-1234567890' });
    const app = createGitDockApp({
      repoStore,
      auth,
      port: 0,
      host: '127.0.0.1',
    });

    const port = await new Promise<number>((resolve, reject) => {
      const created = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        resolve(info.port);
      });
      created.once('error', reject);
      server = created;
    });

    const baseUrl = `http://127.0.0.1:${port}`;

    // Simulate remote/proxied request without token -> must return 401
    const unauthRes = await fetch(
      `${baseUrl}/api/fs/browse?path=${encodeURIComponent(workspaceDir)}`,
      { headers: { 'x-forwarded-for': '100.64.0.2' } },
    );
    assert.equal(unauthRes.status, 401);

    // Authenticated request -> 200 with structured entries
    const okRes = await fetch(
      `${baseUrl}/api/fs/browse?path=${encodeURIComponent(workspaceDir)}`,
      {
        headers: {
          'x-forwarded-for': '100.64.0.2',
          'X-GitWeb-Token': 'test-token-1234567890',
        },
      },
    );
    assert.equal(okRes.status, 200);
    const body = (await okRes.json()) as DirectoryBrowseResponse;
    assert.equal(body.currentPath, path.resolve(workspaceDir));
    assert.deepEqual(
      body.entries.map((e) => ({ name: e.name, isGitRepo: e.isGitRepo })),
      [
        { name: 'docs', isGitRepo: false },
        { name: 'my-git-project', isGitRepo: true },
      ],
    );

    // Missing strict path -> 404
    const missingRes = await fetch(
      `${baseUrl}/api/fs/browse?path=${encodeURIComponent(path.join(workspaceDir, 'missing'))}`,
    );
    assert.equal(missingRes.status, 404);
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
});

test('Security hardening: CSRF checks, DNS rebinding guard, pairing rate limit, and workspaceRoot confinement', async () => {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdock-sec-'));
  const dataDir = path.join(tmpBase, 'data');
  const workspaceDir = path.join(tmpBase, 'workspace');
  const allowedRepo = path.join(workspaceDir, 'allowed-repo');
  const outsideRepo = path.join(tmpBase, 'outside-repo');

  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(path.join(allowedRepo, '.git'), { recursive: true });
  await fs.mkdir(path.join(outsideRepo, '.git'), { recursive: true });

  // Unit check: workspaceRoot blocks browsing outside the allowed folder
  const confinedListing = await browseDirectories(undefined, { workspaceRoot: workspaceDir });
  assert.equal(confinedListing.currentPath, path.resolve(workspaceDir));
  assert.equal(confinedListing.parentPath, null);
  await assert.rejects(() => browseDirectories(outsideRepo, { workspaceRoot: workspaceDir }));

  let server: ServerType | null = null;
  try {
    const repoStore = new RepoStore(dataDir, { workspaceRoot: workspaceDir });
    await repoStore.init([]);
    await assert.rejects(() => repoStore.addRepo(outsideRepo));

    const auth = await createAuthManager(dataDir, {
      explicitToken: 'secure-test-token-123456',
      clientPort: 5173,
    });
    const app = createGitDockApp({
      repoStore,
      auth,
      port: 0,
      host: '127.0.0.1',
      clientPort: 5173,
      workspaceRoot: workspaceDir,
    });

    const port = await new Promise<number>((resolve, reject) => {
      const created = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        resolve(info.port);
      });
      created.once('error', reject);
      server = created;
    });

    const baseUrl = `http://127.0.0.1:${port}`;

    // 1. DNS rebinding protection: non-loopback Host on loopback socket must require auth
    // Use node:http because Fetch/undici strips user-supplied Host headers.
    const rebindStatus = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/api/repos',
          method: 'GET',
          headers: { Host: 'evil.example:7745' },
        },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        },
      );
      req.on('error', reject);
      req.end();
    });
    assert.equal(rebindStatus, 401);

    // 2. Cross-site Sec-Fetch-Site must be blocked with 403
    const crossSiteRes = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: {
        'Sec-Fetch-Site': 'cross-site',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: allowedRepo }),
    });
    assert.equal(crossSiteRes.status, 403);

    // 3. Untrusted browser Origin on mutating POST must be blocked with 403
    const badOriginRes = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: {
        Origin: 'https://evil.example',
        'X-GitDock-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: allowedRepo }),
    });
    assert.equal(badOriginRes.status, 403);

    // 4. Browser-originated POST without custom header or JSON content-type must be blocked with 403
    const formCsrfRes = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: {
        Origin: `http://127.0.0.1:${port}`,
        'Content-Type': 'text/plain',
      },
      body: JSON.stringify({ path: allowedRepo }),
    });
    assert.equal(formCsrfRes.status, 403);

    // 5. Same-origin / Vite dev proxy POST with X-GitDock-Request passes CSRF check and reaches workspaceRoot guard (400)
    const devOriginRes = await fetch(`${baseUrl}/api/repos`, {
      method: 'POST',
      headers: {
        Origin: 'http://127.0.0.1:5173',
        'X-GitDock-Request': '1',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ path: outsideRepo }),
    });
    assert.equal(devOriginRes.status, 400);

    // 6. Rate limiting on POST /api/auth/pair after 10 invalid token attempts -> 429
    for (let i = 0; i < 10; i += 1) {
      const badPair = await fetch(`${baseUrl}/api/auth/pair`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: `wrong-${i}` }),
      });
      assert.equal(badPair.status, 401);
    }
    const throttledRes = await fetch(`${baseUrl}/api/auth/pair`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'secure-test-token-123456' }),
    });
    assert.equal(throttledRes.status, 429);
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
});

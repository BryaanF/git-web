import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
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

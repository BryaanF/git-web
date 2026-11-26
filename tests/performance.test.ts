import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { suite, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { serve } from '@hono/node-server';
import { DiffFile } from '@git-diff-view/file';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createServer as createViteServer } from 'vite';
import { createAuthManager } from '../src/server/auth.ts';
import { parseStatusPorcelainV2Z, parseUnifiedPatch } from '../src/server/git/parsers.ts';
import { runGit } from '../src/server/git/runner.ts';
import { createGitDockApp } from '../src/server/index.ts';
import { RepoStore } from '../src/server/repos/store.ts';
import type {
  ChangedFile,
  CommitSummary,
  DiffPayload,
  RepoStatusSummary,
} from '../src/shared/types.ts';

interface PerfStats {
  samplesMs: number[];
  minMs: number;
  meanMs: number;
  p50Ms: number;
  p95Ms: number;
  maxMs: number;
}

function summarizeSamples(samplesMs: number[]): PerfStats {
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const sum = sorted.reduce((acc, v) => acc + v, 0);
  const percentile = (p: number) => {
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx];
  };
  return {
    samplesMs,
    minMs: sorted[0],
    meanMs: sum / sorted.length,
    p50Ms: percentile(50),
    p95Ms: percentile(95),
    maxMs: sorted[sorted.length - 1],
  };
}

function measureSync(iterations: number, fn: (index: number) => void, warmup = 5): PerfStats {
  for (let i = 0; i < warmup; i += 1) fn(i);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    fn(i);
    samples.push(performance.now() - t0);
  }
  return summarizeSamples(samples);
}

async function measureAsync(
  iterations: number,
  fn: (index: number) => Promise<void>,
  warmup = 1,
): Promise<PerfStats> {
  for (let i = 0; i < warmup; i += 1) await fn(i);
  const samples: number[] = [];
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now();
    await fn(i);
    samples.push(performance.now() - t0);
  }
  return summarizeSamples(samples);
}

function logMetric(label: string, stats: PerfStats, budgetP95Ms: number): void {
  console.log(
    `[PERF] ${label.padEnd(44)} | mean=${stats.meanMs.toFixed(2)}ms p50=${stats.p50Ms.toFixed(2)}ms p95=${stats.p95Ms.toFixed(2)}ms max=${stats.maxMs.toFixed(2)}ms (budget p95<=${budgetP95Ms}ms)`,
  );
}

function buildSyntheticTsSource(lineCount: number, tag = 'v1'): string {
  const lines: string[] = [];
  for (let i = 1; i <= lineCount; i += 1) {
    lines.push(`export function computeMetric_${i}(input: number): number { return input * ${i} + "${tag}".length; }`);
  }
  return lines.join('\n') + '\n';
}

function buildMultiHunkPatch(filePath: string, totalLines: number, hunkCount: number): {
  oldContent: string;
  newContent: string;
  patch: string;
} {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  const step = Math.max(10, Math.floor(totalLines / hunkCount));
  const changedIndices = new Set<number>();
  for (let h = 0; h < hunkCount; h += 1) {
    const idx = Math.min(totalLines - 2, h * step + 3);
    changedIndices.add(idx);
    changedIndices.add(idx + 1);
  }

  for (let i = 0; i < totalLines; i += 1) {
    const base = `export const item_${i} = computeValue(${i}, "baseline");`;
    oldLines.push(base);
    if (changedIndices.has(i)) {
      newLines.push(`export const item_${i} = computeValue(${i}, "updated_${i}");`);
    } else {
      newLines.push(base);
    }
  }

  const hunks: string[] = [];
  for (let h = 0; h < hunkCount; h += 1) {
    const startIdx = Math.min(totalLines - 4, h * step + 3);
    const ctxStart = Math.max(0, startIdx - 2);
    const ctxEnd = Math.min(totalLines - 1, startIdx + 3);
    const count = ctxEnd - ctxStart + 1;
    const body: string[] = [
      `@@ -${ctxStart + 1},${count} +${ctxStart + 1},${count} @@`,
    ];
    for (let i = ctxStart; i <= ctxEnd; i += 1) {
      if (changedIndices.has(i)) {
        body.push(`-${oldLines[i]}`);
        body.push(`+${newLines[i]}`);
      } else {
        body.push(` ${oldLines[i]}`);
      }
    }
    hunks.push(body.join('\n'));
  }

  const patch = [
    `diff --git a/${filePath} b/${filePath}`,
    `--- a/${filePath}`,
    `+++ b/${filePath}`,
    ...hunks,
  ].join('\n') + '\n';

  return {
    oldContent: oldLines.join('\n') + '\n',
    newContent: newLines.join('\n') + '\n',
    patch,
  };
}

suite('GitDock Performance Suite', { concurrency: 1 }, () => {
test('Backend Parser Performance: status porcelain-v2 & unified patch parsing meet SLA', () => {
  const statusRecords: string[] = [
    '# branch.oid 0123456789abcdef0123456789abcdef01234567',
    '# branch.head main',
    '# branch.upstream origin/main',
    '# branch.ab +2 -0',
  ];
  for (let i = 0; i < 200; i += 1) {
    statusRecords.push(`1 MM N... 100644 100644 100644 111111 222222 src/module-${i}/index.ts`);
  }
  for (let i = 0; i < 150; i += 1) {
    statusRecords.push(`1 A. N... 000000 100644 100644 000000 333333 src/new-${i}.ts`);
  }
  for (let i = 0; i < 100; i += 1) {
    statusRecords.push(`? temp/untracked-${i}.ts`);
  }
  for (let i = 0; i < 50; i += 1) {
    statusRecords.push(`2 R. N... 100644 100644 100644 444444 444444 R100 src/renamed-${i}.ts\0src/old-${i}.ts`);
  }
  const statusRaw = statusRecords.join('\0') + '\0';

  const statusStats = measureSync(50, () => {
    const parsed = parseStatusPorcelainV2Z(statusRaw);
    assert.equal(parsed.staged.length, 400);
    assert.equal(parsed.unstaged.length, 300);
  });
  logMetric('parser.parseStatusPorcelainV2Z (500 entries)', statusStats, 20);
  assert.ok(statusStats.p95Ms <= 20, `parseStatusPorcelainV2Z p95 ${statusStats.p95Ms.toFixed(2)}ms exceeded 20ms`);

  const { patch } = buildMultiHunkPatch('src/large.ts', 3000, 60);
  const patchStats = measureSync(50, () => {
    const parsed = parseUnifiedPatch(patch);
    assert.equal(parsed.hunks.length, 60);
    assert.equal(parsed.additions, 120);
  });
  logMetric('parser.parseUnifiedPatch (60 hunks)', patchStats, 20);
  assert.ok(patchStats.p95Ms <= 20, `parseUnifiedPatch p95 ${patchStats.p95Ms.toFixed(2)}ms exceeded 20ms`);
});

test('Backend End-to-End HTTP & Git Engine Performance: API endpoints and concurrent burst meet SLA', async () => {
  const tmpBase = await fs.mkdtemp(path.join(os.tmpdir(), 'gitdock-perf-api-'));
  const repoDir = path.join(tmpBase, 'perf-repo');
  const dataDir = path.join(tmpBase, 'data');

  await fs.mkdir(repoDir, { recursive: true });
  await fs.mkdir(dataDir, { recursive: true });

  let server: ReturnType<typeof serve> | null = null;

  try {
    await runGit(repoDir, ['init', '--initial-branch=main']);
    await runGit(repoDir, ['config', 'user.name', 'Perf Runner']);
    await runGit(repoDir, ['config', 'user.email', 'perf@example.com']);

    await fs.mkdir(path.join(repoDir, 'src'), { recursive: true });
    const writes: Array<Promise<void>> = [];
    for (let i = 0; i < 78; i += 1) {
      writes.push(fs.writeFile(path.join(repoDir, 'src', `mod-${i}.ts`), `export const m${i} = ${i};\n`, 'utf8'));
    }
    const baseLarge = buildSyntheticTsSource(1000, 'base');
    writes.push(fs.writeFile(path.join(repoDir, 'src', 'large-component.ts'), baseLarge, 'utf8'));
    writes.push(fs.writeFile(path.join(repoDir, 'src', 'staged-file.ts'), 'export const stage = "v1";\n', 'utf8'));
    await Promise.all(writes);

    await runGit(repoDir, ['add', '-A']);
    await runGit(repoDir, ['commit', '-m', 'Initial repository snapshot']);

    for (let c = 1; c <= 15; c += 1) {
      await fs.writeFile(path.join(repoDir, 'src', 'mod-0.ts'), `export const m0 = ${c};\n`, 'utf8');
      await runGit(repoDir, ['add', 'src/mod-0.ts']);
      await runGit(repoDir, ['commit', '-m', `Perf commit #${c}`]);
    }

    await fs.writeFile(path.join(repoDir, 'src', 'staged-file.ts'), 'export const stage = "v2";\n', 'utf8');
    await runGit(repoDir, ['add', 'src/staged-file.ts']);
    await fs.writeFile(
      path.join(repoDir, 'src', 'large-component.ts'),
      buildSyntheticTsSource(1000, 'modified-on-mobile'),
      'utf8',
    );
    await fs.writeFile(
      path.join(repoDir, 'src', 'fresh-untracked.ts'),
      buildSyntheticTsSource(120, 'untracked'),
      'utf8',
    );

    const repoStore = new RepoStore(dataDir);
    await repoStore.init([repoDir]);
    const repo = repoStore.list()[0];
    assert.ok(repo);

    const auth = await createAuthManager(dataDir, { disabled: true });
    const app = createGitDockApp({
      repoStore,
      auth,
      port: 0,
      host: '127.0.0.1',
    });

    const actualPort = await new Promise<number>((resolve, reject) => {
      server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => {
        resolve(info.port);
      });
      server.once('error', reject);
    });

    const baseUrl = `http://127.0.0.1:${actualPort}`;
    const getJson = async <T>(urlPath: string): Promise<T> => {
      const res = await fetch(`${baseUrl}${urlPath}`);
      assert.equal(res.status, 200, `Expected 200 for ${urlPath}, got ${res.status}`);
      return (await res.json()) as T;
    };

    const healthStats = await measureAsync(20, async () => {
      const data = await getJson<{ ok: boolean }>('/api/health');
      assert.equal(data.ok, true);
    });
    logMetric('http.GET /api/health', healthStats, 30);
    assert.ok(healthStats.p95Ms <= 30, `health p95 ${healthStats.p95Ms.toFixed(2)}ms exceeded 30ms`);

    const statusStats = await measureAsync(20, async () => {
      const data = await getJson<RepoStatusSummary>(`/api/repos/${repo.id}/status`);
      assert.equal(data.unstaged.length, 2);
      assert.equal(data.staged.length, 1);
    });
    logMetric('http.GET /status (80 files)', statusStats, 450);
    assert.ok(statusStats.p50Ms <= 320, `status p50 ${statusStats.p50Ms.toFixed(2)}ms exceeded 320ms`);
    assert.ok(statusStats.p95Ms <= 450, `status p95 ${statusStats.p95Ms.toFixed(2)}ms exceeded 450ms`);

    const unstagedDiffStats = await measureAsync(20, async () => {
      const data = await getJson<DiffPayload>(
        `/api/repos/${repo.id}/diff?path=${encodeURIComponent('src/large-component.ts')}&section=unstaged&context=3`,
      );
      assert.equal(data.additions, 1000);
      assert.equal(data.deletions, 1000);
    });
    logMetric('http.GET /diff unstaged (1000 lines)', unstagedDiffStats, 1200);
    assert.ok(unstagedDiffStats.p50Ms <= 420, `unstaged diff p50 ${unstagedDiffStats.p50Ms.toFixed(2)}ms exceeded 420ms`);
    assert.ok(unstagedDiffStats.p95Ms <= 1200, `unstaged diff p95 ${unstagedDiffStats.p95Ms.toFixed(2)}ms exceeded 1200ms`);

    const stagedDiffStats = await measureAsync(20, async () => {
      const data = await getJson<DiffPayload>(
        `/api/repos/${repo.id}/diff?path=${encodeURIComponent('src/staged-file.ts')}&section=staged&context=3`,
      );
      assert.equal(data.additions, 1);
      assert.equal(data.deletions, 1);
    });
    logMetric('http.GET /diff staged', stagedDiffStats, 1200);
    assert.ok(stagedDiffStats.p50Ms <= 420, `staged diff p50 ${stagedDiffStats.p50Ms.toFixed(2)}ms exceeded 420ms`);
    assert.ok(stagedDiffStats.p95Ms <= 1200, `staged diff p95 ${stagedDiffStats.p95Ms.toFixed(2)}ms exceeded 1200ms`);

    const untrackedHintStats = await measureAsync(20, async () => {
      const data = await getJson<DiffPayload>(
        `/api/repos/${repo.id}/diff?path=${encodeURIComponent('src/fresh-untracked.ts')}&section=unstaged&context=3&hint=untracked`,
      );
      assert.equal(data.status, 'untracked');
      assert.equal(data.additions, 120);
    });
    logMetric('http.GET /diff untracked (hint fast path)', untrackedHintStats, 50);
    assert.ok(untrackedHintStats.p95Ms <= 50, `untracked hint diff p95 ${untrackedHintStats.p95Ms.toFixed(2)}ms exceeded 50ms`);

    const commitsStats = await measureAsync(20, async () => {
      const data = await getJson<{ commits: CommitSummary[] }>(`/api/repos/${repo.id}/commits?limit=40&offset=0`);
      assert.equal(data.commits.length, 16);
    });
    logMetric('http.GET /commits (16 commits)', commitsStats, 1200);
    assert.ok(commitsStats.p50Ms <= 450, `commits p50 ${commitsStats.p50Ms.toFixed(2)}ms exceeded 450ms`);
    assert.ok(commitsStats.p95Ms <= 1200, `commits p95 ${commitsStats.p95Ms.toFixed(2)}ms exceeded 1200ms`);

    const tBurst0 = performance.now();
    await Promise.all([
      getJson(`/api/repos/${repo.id}/status`),
      getJson(`/api/repos/${repo.id}/diff?path=${encodeURIComponent('src/large-component.ts')}&section=unstaged`),
      getJson(`/api/repos/${repo.id}/diff?path=${encodeURIComponent('src/staged-file.ts')}&section=staged`),
      getJson(`/api/repos/${repo.id}/diff?path=${encodeURIComponent('src/fresh-untracked.ts')}&section=unstaged&hint=untracked`),
      getJson(`/api/repos/${repo.id}/commits?limit=40&offset=0`),
      getJson(`/api/repos/${repo.id}/branches`),
      getJson('/api/health'),
      getJson('/api/repos'),
    ]);
    const burstMs = performance.now() - tBurst0;
    console.log(`[PERF] ${'http.burst (8 concurrent endpoints)'.padEnd(44)} | total=${burstMs.toFixed(2)}ms (budget <=2000ms)`);
    assert.ok(burstMs <= 2000, `Concurrent burst took ${burstMs.toFixed(2)}ms (>2000ms)`);
  } finally {
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await fs.rm(tmpBase, { recursive: true, force: true });
  }
});

test('Frontend Diff Engine & React Render Performance: DiffFile highlighting and UI rendering meet SLA', async () => {
  const medium = buildMultiHunkPatch('src/medium.ts', 400, 4);
  const large = buildMultiHunkPatch('src/large.ts', 2500, 12);

  const mediumDiffStats = measureSync(20, () => {
    const df = DiffFile.createInstance({
      oldFile: { fileName: 'src/medium.ts', fileLang: 'typescript', content: medium.oldContent },
      newFile: { fileName: 'src/medium.ts', fileLang: 'typescript', content: medium.newContent },
      hunks: [medium.patch],
    });
    df.initTheme('dark');
    df.init();
    df.buildUnifiedDiffLines();
    assert.equal(df.additionLength, 8);
    assert.equal(df.deletionLength, 8);
  });
  logMetric('frontend.DiffFile unified (400L, 4 hunks)', mediumDiffStats, 120);
  assert.ok(mediumDiffStats.p95Ms <= 120, `Medium DiffFile p95 ${mediumDiffStats.p95Ms.toFixed(2)}ms exceeded 120ms`);

  const largeDiffStats = measureSync(20, () => {
    const df = DiffFile.createInstance({
      oldFile: { fileName: 'src/large.ts', fileLang: 'typescript', content: large.oldContent },
      newFile: { fileName: 'src/large.ts', fileLang: 'typescript', content: large.newContent },
      hunks: [large.patch],
    });
    df.initTheme('dark');
    df.init();
    df.buildUnifiedDiffLines();
    assert.equal(df.additionLength, 24);
    assert.equal(df.deletionLength, 24);
  }, 1);
  logMetric('frontend.DiffFile unified (2500L, 12 hunks)', largeDiffStats, 500);
  assert.ok(largeDiffStats.p95Ms <= 500, `Large DiffFile p95 ${largeDiffStats.p95Ms.toFixed(2)}ms exceeded 500ms`);

  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const viteServer = await createViteServer({
    root: projectRoot,
    logLevel: 'silent',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true },
  });

  try {
    const [{ MobileDiffViewer }, { ChangesTab }, { HistoryTab }] = await Promise.all([
      viteServer.ssrLoadModule('/src/client/components/MobileDiffViewer.tsx') as Promise<
        typeof import('../src/client/components/MobileDiffViewer.tsx')
      >,
      viteServer.ssrLoadModule('/src/client/components/ChangesTab.tsx') as Promise<
        typeof import('../src/client/components/ChangesTab.tsx')
      >,
      viteServer.ssrLoadModule('/src/client/components/HistoryTab.tsx') as Promise<
        typeof import('../src/client/components/HistoryTab.tsx')
      >,
    ]);

    const parsedMedium = parseUnifiedPatch(medium.patch);
    const diffPayload: DiffPayload = {
      path: 'src/medium.ts',
      patch: medium.patch,
      hunks: parsedMedium.hunks,
      oldContent: medium.oldContent,
      newContent: medium.newContent,
      lang: 'typescript',
      isBinary: false,
      isTooLarge: false,
      lineCount: parsedMedium.lineCount,
      additions: parsedMedium.additions,
      deletions: parsedMedium.deletions,
      status: 'modified',
    };

    let renderedDiffHtml = '';
    const viewerRenderStats = measureSync(20, () => {
      renderedDiffHtml = renderToStaticMarkup(
        React.createElement(MobileDiffViewer, {
          diff: diffPayload,
          loading: false,
          error: null,
          contextLines: 3,
          onChangeContextLines: () => {},
          sectionLabel: 'unstaged',
        }),
      );
    });
    assert.ok(renderedDiffHtml.includes('data-operator="+"'), 'Expected rendered diff to contain + operator markers');
    assert.ok(renderedDiffHtml.includes('data-operator="-"'), 'Expected rendered diff to contain - operator markers');
    assert.ok(renderedDiffHtml.includes('data-diff-highlight'), 'Expected rendered diff to contain intra-line word highlights');
    logMetric('frontend.MobileDiffViewer render (400L)', viewerRenderStats, 320);
    assert.ok(viewerRenderStats.p50Ms <= 80, `MobileDiffViewer render p50 ${viewerRenderStats.p50Ms.toFixed(2)}ms exceeded 80ms`);
    assert.ok(viewerRenderStats.p95Ms <= 320, `MobileDiffViewer render p95 ${viewerRenderStats.p95Ms.toFixed(2)}ms exceeded 320ms`);

    const makeFiles = (count: number, section: 'unstaged' | 'staged'): ChangedFile[] =>
      Array.from({ length: count }, (_, idx) => ({
        path: `src/components/feature-${idx}/Panel.tsx`,
        status: idx % 5 === 0 ? 'added' : 'modified',
        section,
      }));

    const status100: RepoStatusSummary = {
      repo: { id: 'perf', name: 'perf', path: '/tmp/perf', addedAt: '2026-01-01T00:00:00.000Z' },
      branch: 'main',
      headSha: 'abcdef1234567890',
      upstream: 'origin/main',
      ahead: 1,
      behind: 0,
      isDetached: false,
      hasRemote: true,
      remoteName: 'origin',
      unstaged: makeFiles(50, 'unstaged'),
      staged: makeFiles(50, 'staged'),
      conflicted: [],
      lastRefreshedAt: '2026-01-01T00:00:00.000Z',
    };

    const changesRenderStats = measureSync(20, () => {
      const html = renderToStaticMarkup(
        React.createElement(ChangesTab, {
          repoId: 'perf',
          status: status100,
          refreshTick: 0,
          onStatusUpdated: () => {},
          onCommitted: () => {},
        }),
      );
      assert.ok(html.includes('All (100)'));
    });
    logMetric('frontend.ChangesTab render (100 files)', changesRenderStats, 320);
    assert.ok(changesRenderStats.p50Ms <= 160, `ChangesTab render p50 ${changesRenderStats.p50Ms.toFixed(2)}ms exceeded 160ms`);
    assert.ok(changesRenderStats.p95Ms <= 320, `ChangesTab render p95 ${changesRenderStats.p95Ms.toFixed(2)}ms exceeded 320ms`);

    const historyRenderStats = measureSync(20, () => {
      const html = renderToStaticMarkup(
        React.createElement(HistoryTab, {
          repoId: 'perf',
          status: status100,
          refreshTick: 0,
          onStatusUpdated: () => {},
        }),
      );
      assert.ok(html.includes('Remote Push Verification'));
    });
    logMetric('frontend.HistoryTab shell render', historyRenderStats, 80);
    assert.ok(historyRenderStats.p95Ms <= 80, `HistoryTab render p95 ${historyRenderStats.p95Ms.toFixed(2)}ms exceeded 80ms`);
  } finally {
    await viteServer.close();
  }
});

test('Frontend Production Bundle Budget: dist/client chunks stay within size limits', async (t) => {
  const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const distDir = path.join(projectRoot, 'dist', 'client');
  const indexHtmlPath = path.join(distDir, 'index.html');

  let hasDist = true;
  try {
    await fs.access(indexHtmlPath);
  } catch {
    hasDist = false;
  }

  if (!hasDist) {
    if (process.env.GITWEB_REQUIRE_BUNDLE === '1') {
      assert.fail('dist/client/index.html is missing. Run "npm run build" before running performance budget checks.');
    }
    t.skip('dist/client not built yet; run "npm run build" or "npm run test:perf" to enforce bundle budgets.');
    return;
  }

  const indexHtml = await fs.readFile(indexHtmlPath);
  const assetsDir = path.join(distDir, 'assets');
  const assetNames = await fs.readdir(assetsDir);

  let entryJsRaw = 0;
  let entryJsGzip = 0;
  let maxJsChunkRaw = 0;
  let maxJsChunkName = '';
  let totalCssRaw = 0;
  let totalCssGzip = 0;

  for (const name of assetNames) {
    const buf = await fs.readFile(path.join(assetsDir, name));
    const gz = zlib.gzipSync(buf).length;
    if (name.endsWith('.js')) {
      if (buf.length > maxJsChunkRaw) {
        maxJsChunkRaw = buf.length;
        maxJsChunkName = name;
      }
      if (name.startsWith('index-')) {
        entryJsRaw = buf.length;
        entryJsGzip = gz;
      }
    } else if (name.endsWith('.css')) {
      totalCssRaw += buf.length;
      totalCssGzip += gz;
    }
  }

  console.log(
    `[PERF] bundle.html=${(indexHtml.length / 1024).toFixed(2)}kB | entryJs=${(entryJsRaw / 1024).toFixed(2)}kB (${(entryJsGzip / 1024).toFixed(2)}kB gz) | maxChunk(${maxJsChunkName})=${(maxJsChunkRaw / 1024).toFixed(2)}kB | css=${(totalCssRaw / 1024).toFixed(2)}kB (${(totalCssGzip / 1024).toFixed(2)}kB gz)`,
  );

  assert.ok(indexHtml.length <= 10 * 1024, `index.html ${indexHtml.length}B exceeded 10KB`);
  assert.ok(entryJsRaw > 0 && entryJsRaw <= 100 * 1024, `entry JS ${(entryJsRaw / 1024).toFixed(1)}kB exceeded 100kB`);
  assert.ok(entryJsGzip <= 35 * 1024, `entry JS gzip ${(entryJsGzip / 1024).toFixed(1)}kB exceeded 35kB`);
  assert.ok(maxJsChunkRaw <= 500 * 1024, `chunk ${maxJsChunkName} ${(maxJsChunkRaw / 1024).toFixed(1)}kB exceeded 500kB`);
  assert.ok(totalCssRaw <= 120 * 1024, `total CSS ${(totalCssRaw / 1024).toFixed(1)}kB exceeded 120kB`);
});
});

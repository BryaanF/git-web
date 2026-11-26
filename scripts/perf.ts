import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distIndexPath = path.join(projectRoot, 'dist', 'client', 'index.html');
const forceBuild = process.argv.includes('--build');

if (forceBuild || !fs.existsSync(distIndexPath)) {
  const viteBinPath = path.resolve(projectRoot, 'node_modules', 'vite', 'bin', 'vite.js');
  if (!fs.existsSync(viteBinPath)) {
    console.error('[Perf] Vite binary not found in node_modules. Run npm install first.');
    process.exit(1);
  }
  console.log('[Perf] Building production client bundle before enforcing bundle & render budgets...');
  execFileSync(process.execPath, [viteBinPath, 'build'], {
    cwd: projectRoot,
    stdio: 'inherit',
  });
}

execFileSync(process.execPath, ['--test', '--test-concurrency=1', 'tests/performance.test.ts'], {
  cwd: projectRoot,
  stdio: 'inherit',
  env: {
    ...process.env,
    GITWEB_REQUIRE_BUNDLE: '1',
  },
});

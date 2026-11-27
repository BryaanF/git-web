import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const gitMarker = path.join(projectRoot, '.git');
const hookFile = path.join(projectRoot, '.githooks', 'commit-msg');

if (process.env.CI === 'true' || process.env.CI === '1') {
  // Do not alter local Git config inside automated CI environments.
  process.exit(0);
}

if (!fs.existsSync(gitMarker)) {
  // Skip gracefully in tarball installs / non-Git build environments.
  process.exit(0);
}

if (!fs.existsSync(hookFile)) {
  console.error(`Hook file not found at ${hookFile}`);
  process.exit(1);
}

const force = process.argv.includes('--force');
let existingHooksPath = '';
try {
  existingHooksPath = execFileSync('git', ['config', '--local', '--get', 'core.hooksPath'], {
    cwd: projectRoot,
    encoding: 'utf8',
    shell: false,
  }).trim();
} catch {
  existingHooksPath = '';
}

if (existingHooksPath === '.githooks') {
  console.log('Local Git core.hooksPath is already configured -> .githooks');
  process.exit(0);
}

if (existingHooksPath && existingHooksPath !== '.githooks' && !force) {
  console.log(
    `Preserving existing local core.hooksPath ("${existingHooksPath}"). Pass --force to switch to .githooks.`,
  );
  process.exit(0);
}

try {
  fs.chmodSync(hookFile, 0o755);
} catch {
  // Windows NTFS ignores POSIX mode bits cleanly
}

execFileSync('git', ['config', '--local', 'core.hooksPath', '.githooks'], {
  cwd: projectRoot,
  stdio: 'inherit',
  shell: false,
});

console.log('Configured local Git core.hooksPath -> .githooks');
console.log('Allowed commit types: bugfix, features, chores, improvement');

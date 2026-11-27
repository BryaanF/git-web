import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  buildWindowsStartupVbs,
  buildWindowsTaskArgs,
  findPm2CliScript,
  getWindowsStartupVbsPath,
} from '../scripts/pm2-autostart.ts';

const require = createRequire(import.meta.url);
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('ecosystem.config.cjs defines single-fork unattended Tailscale preset cleanly', () => {
  const eco = require('../ecosystem.config.cjs') as {
    apps: Array<{
      name: string;
      script: string;
      args: string;
      exec_mode: string;
      instances: number;
      autorestart: boolean;
      watch: boolean;
      windowsHide: boolean;
      env: Record<string, string>;
    }>;
  };

  assert.equal(eco.apps.length, 1);
  const app = eco.apps[0];
  assert.equal(app.name, 'gitdock-web');
  assert.equal(app.exec_mode, 'fork');
  assert.equal(app.instances, 1);
  assert.equal(app.autorestart, true);
  assert.equal(app.watch, false);
  assert.equal(app.windowsHide, true);
  assert.equal(app.args, '--ensure-build');
  assert.ok(fs.existsSync(app.script), `PM2 entry script should exist at ${app.script}`);
  assert.equal(app.env.GITWEB_HOST, '127.0.0.1');
  assert.equal(app.env.GITWEB_PORT, '8001');
  assert.equal(app.env.GITWEB_STRICT_PORT, '1');
  assert.equal(app.env.GITWEB_TAILSCALE_PORT, '8443');
});

test('buildWindowsStartupVbs generates silent hidden WScript launcher calling boot-resurrect', () => {
  const autostartScriptPath = path.join(projectRoot, 'scripts', 'pm2-autostart.ts');
  const vbs = buildWindowsStartupVbs({
    nodeExe: 'C:\\Program Files\\nodejs\\node.exe',
    autostartScriptPath,
    projectRoot,
  });

  assert.ok(vbs.includes('CreateObject("WScript.Shell")'));
  assert.ok(vbs.includes('boot-resurrect'));
  assert.ok(vbs.includes(', 0, False'));
});

test('findPm2CliScript, getWindowsStartupVbsPath, and buildWindowsTaskArgs resolve paths safely', () => {
  const expectedBin = path.join('C:\\Users\\demo\\AppData\\Roaming', 'npm', 'node_modules', 'pm2', 'bin', 'pm2');
  const found = findPm2CliScript({
    appData: 'C:\\Users\\demo\\AppData\\Roaming',
    existsSync: (p) => p === expectedBin,
  });
  assert.equal(found, expectedBin);

  const startupPath = getWindowsStartupVbsPath('C:\\Users\\demo\\AppData\\Roaming');
  assert.ok(startupPath.endsWith(path.join('Startup', 'gitdock-web-pm2.vbs')));

  const taskArgs = buildWindowsTaskArgs({
    vbsPath: startupPath,
    trigger: 'ONSTART',
    userName: 'PC\\demo',
  });
  assert.ok(taskArgs.includes('ONSTART'));
  assert.ok(taskArgs.includes('PC\\demo'));
});

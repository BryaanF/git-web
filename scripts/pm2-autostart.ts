import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ECOSYSTEM_PATH = path.join(projectRoot, 'ecosystem.config.cjs');
const ENTRY_SCRIPT_PATH = path.resolve(fileURLToPath(import.meta.url));
const APP_NAME = 'gitdock-web';
const STARTUP_VBS_NAME = 'gitdock-web-pm2.vbs';
const BOOT_TASK_NAME = 'GitDockWeb-PM2-Boot';

function escapeVbsString(value: string): string {
  return value.replace(/"/g, '""');
}

export function getWindowsStartupVbsPath(
  appDataDir = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
): string {
  return path.join(
    appDataDir,
    'Microsoft',
    'Windows',
    'Start Menu',
    'Programs',
    'Startup',
    STARTUP_VBS_NAME,
  );
}

export function findPm2CliScript(options: {
  appData?: string;
  wherePaths?: string[];
  existsSync?: (targetPath: string) => boolean;
} = {}): string | null {
  const exists = options.existsSync ?? fs.existsSync;
  const appData = options.appData ?? process.env.APPDATA ?? '';
  const candidates: string[] = [];

  if (appData) {
    candidates.push(path.join(appData, 'npm', 'node_modules', 'pm2', 'bin', 'pm2'));
  }

  for (const raw of options.wherePaths ?? []) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const dir = path.dirname(trimmed);
    candidates.push(path.join(dir, 'node_modules', 'pm2', 'bin', 'pm2'));
    candidates.push(path.resolve(dir, '..', 'lib', 'node_modules', 'pm2', 'bin', 'pm2'));
  }

  for (const candidate of candidates) {
    if (exists(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function buildWindowsStartupVbs(params: {
  nodeExe: string;
  autostartScriptPath: string;
  projectRoot: string;
}): string {
  const cmdLine = `"${params.nodeExe}" "${params.autostartScriptPath}" boot-resurrect`;

  return [
    "' GitDock Web unattended PM2 auto-start launcher (runs silently without a console window)",
    'Set WshShell = CreateObject("WScript.Shell")',
    `WshShell.CurrentDirectory = "${escapeVbsString(params.projectRoot)}"`,
    `WshShell.Run "${escapeVbsString(cmdLine)}", 0, False`,
    '',
  ].join('\r\n');
}

export function buildWindowsTaskArgs(params: {
  taskName?: string;
  vbsPath: string;
  trigger: 'ONLOGON' | 'ONSTART';
  userName?: string;
}): string[] {
  const args = [
    '/Create',
    '/TN',
    params.taskName ?? BOOT_TASK_NAME,
    '/TR',
    `wscript.exe //B "${params.vbsPath}"`,
    '/SC',
    params.trigger,
    '/F',
  ];
  if (params.userName) {
    args.push('/RU', params.userName);
  }
  return args;
}

function resolveHostPm2Cli(): string {
  let wherePaths: string[] = [];
  if (process.platform === 'win32') {
    try {
      const raw = execFileSync('where.exe', ['pm2.cmd'], {
        encoding: 'utf8',
        shell: false,
        windowsHide: true,
      });
      wherePaths = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch {
      wherePaths = [];
    }
  } else {
    try {
      const raw = execFileSync('which', ['pm2'], { encoding: 'utf8', shell: false });
      wherePaths = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    } catch {
      wherePaths = [];
    }
  }

  const found = findPm2CliScript({ wherePaths });
  if (!found) {
    throw new Error(
      'Global PM2 CLI script not found. Ensure PM2 is installed globally (npm install -g pm2).',
    );
  }
  return found;
}

function runPm2(pm2BinScript: string, args: string[], options: { allowFailure?: boolean; quiet?: boolean } = {}): string {
  try {
    const out = execFileSync(process.execPath, [pm2BinScript, ...args], {
      cwd: projectRoot,
      encoding: 'utf8',
      stdio: options.quiet ? 'pipe' : 'inherit',
      shell: false,
      windowsHide: true,
    });
    return out ?? '';
  } catch (err) {
    if (options.allowFailure) return '';
    throw err;
  }
}

function hasSavedAppInPm2(pm2BinScript: string): boolean {
  const raw = runPm2(pm2BinScript, ['jlist'], { allowFailure: true, quiet: true });
  if (!raw.trim()) return false;
  try {
    const startIdx = raw.indexOf('[');
    const jsonText = startIdx >= 0 ? raw.slice(startIdx) : raw;
    const list = JSON.parse(jsonText) as Array<{ name?: string; pm2_env?: { status?: string } }>;
    return list.some((item) => item.name === APP_NAME);
  } catch {
    return false;
  }
}

function bootResurrect(): void {
  const pm2BinScript = resolveHostPm2Cli();
  runPm2(pm2BinScript, ['resurrect'], { allowFailure: true, quiet: true });
  if (!hasSavedAppInPm2(pm2BinScript)) {
    runPm2(pm2BinScript, ['start', ECOSYSTEM_PATH, '--update-env'], { quiet: true });
    runPm2(pm2BinScript, ['save'], { allowFailure: true, quiet: true });
  }
}

function setupAutostart(options: { dryRun: boolean; bootTask: boolean }): void {
  const pm2BinScript = resolveHostPm2Cli();
  const vbsPath = getWindowsStartupVbsPath();
  const vbsContent = buildWindowsStartupVbs({
    nodeExe: process.execPath,
    autostartScriptPath: ENTRY_SCRIPT_PATH,
    projectRoot,
  });

  if (options.dryRun) {
    console.log(`[dry-run] Ecosystem config : ${ECOSYSTEM_PATH}`);
    console.log(`[dry-run] Global PM2 bin   : ${pm2BinScript}`);
    if (process.platform === 'win32') {
      console.log(`[dry-run] Windows Startup  : ${vbsPath}`);
      console.log('--- VBS Launcher Preview ---');
      console.log(vbsContent.trimEnd());
    }
    return;
  }

  runPm2(pm2BinScript, ['delete', APP_NAME], { allowFailure: true });
  runPm2(pm2BinScript, ['start', ECOSYSTEM_PATH, '--update-env']);
  runPm2(pm2BinScript, ['save']);

  if (process.platform === 'win32') {
    fs.mkdirSync(path.dirname(vbsPath), { recursive: true });
    fs.writeFileSync(vbsPath, vbsContent, 'utf8');
    console.log(`[GitDock PM2] Installed silent Windows Startup launcher: ${vbsPath}`);

    if (options.bootTask) {
      const userName = process.env.USERDOMAIN && process.env.USERNAME
        ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
        : process.env.USERNAME;
      const taskArgs = buildWindowsTaskArgs({
        vbsPath,
        trigger: 'ONSTART',
        userName,
      });
      execFileSync('schtasks.exe', taskArgs, { stdio: 'inherit', shell: false });
      console.log(`[GitDock PM2] Registered Windows boot Task Scheduler job: ${BOOT_TASK_NAME}`);
    }
  } else {
    console.log('[GitDock PM2] Process started & saved. Run "pm2 startup" to enable OS boot hook.');
  }
}

function removeAutostart(): void {
  const pm2BinScript = resolveHostPm2Cli();
  runPm2(pm2BinScript, ['delete', APP_NAME], { allowFailure: true });
  runPm2(pm2BinScript, ['save', '--force'], { allowFailure: true });

  if (process.platform === 'win32') {
    const vbsPath = getWindowsStartupVbsPath();
    if (fs.existsSync(vbsPath)) {
      fs.unlinkSync(vbsPath);
      console.log(`[GitDock PM2] Removed Windows Startup launcher: ${vbsPath}`);
    }
    try {
      execFileSync('schtasks.exe', ['/Delete', '/TN', BOOT_TASK_NAME, '/F'], {
        stdio: 'ignore',
        shell: false,
      });
      console.log(`[GitDock PM2] Removed Task Scheduler job: ${BOOT_TASK_NAME}`);
    } catch {
      // Optional boot task not registered
    }
  }
}

function printStatus(): void {
  const pm2BinScript = resolveHostPm2Cli();
  if (process.platform === 'win32') {
    const vbsPath = getWindowsStartupVbsPath();
    console.log(
      `[GitDock PM2] Windows Startup launcher: ${fs.existsSync(vbsPath) ? `INSTALLED (${vbsPath})` : 'not installed'}`,
    );
  }
  runPm2(pm2BinScript, ['status']);
}

function main(): void {
  const args = process.argv.slice(2);
  const action = args.find((a) => !a.startsWith('-')) ?? 'setup';
  const dryRun = args.includes('--dry-run');
  const bootTask = args.includes('--boot-task');

  if (action === 'setup' || action === 'install') {
    setupAutostart({ dryRun, bootTask });
  } else if (action === 'boot-resurrect') {
    bootResurrect();
  } else if (action === 'remove' || action === 'uninstall') {
    removeAutostart();
  } else if (action === 'status') {
    printStatus();
  } else {
    console.error(`Unknown action "${action}". Expected setup | boot-resurrect | remove | status.`);
    process.exit(1);
  }
}

const isEntrypoint = process.argv[1] && path.resolve(process.argv[1]).endsWith('pm2-autostart.ts');
if (isEntrypoint) {
  main();
}

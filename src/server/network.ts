import os from 'node:os';
import QRCode from 'qrcode';
import type { ServerNetworkInfo } from '../shared/types.ts';
import { runSystemCommand } from './git/runner.ts';
import {
  DEFAULT_CLIENT_PORT,
  DEFAULT_SERVER_PORT,
  DEFAULT_TAILSCALE_PORT,
  PRIVILEGED_WEB_PORTS,
  findSafePort,
  isPortAvailable,
  parsePortSpec,
  probePorts,
  resolvePortSpec,
} from './ports.ts';

export const DEFAULT_PORT = DEFAULT_SERVER_PORT;
export {
  DEFAULT_CLIENT_PORT,
  DEFAULT_SERVER_PORT,
  DEFAULT_TAILSCALE_PORT,
  PRIVILEGED_WEB_PORTS,
  findSafePort,
  isPortAvailable,
  parsePortSpec,
  probePorts,
  resolvePortSpec,
};

export function getLanIpv4Addresses(): Array<{ label: string; address: string }> {
  const interfaces = os.networkInterfaces();
  const candidates: Array<{ label: string; address: string; priority: number }> = [];

  for (const [name, list] of Object.entries(interfaces)) {
    if (!list) continue;
    const lower = name.toLowerCase();
    // De-prioritize virtual adapters (WSL, Hyper-V, VirtualBox, Docker) vs Wi-Fi/Ethernet
    const isVirtual =
      lower.includes('vethernet') ||
      lower.includes('wsl') ||
      lower.includes('docker') ||
      lower.includes('vmware') ||
      lower.includes('virtualbox');

    for (const info of list) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (info.address.startsWith('169.254.')) continue;
      if (info.address.startsWith('100.')) continue; // Tailscale CGNAT handled separately

      let priority = isVirtual ? 3 : 1;
      if (lower.includes('wi-fi') || lower.includes('wifi') || lower.includes('wlan')) {
        priority = 0;
      }

      candidates.push({ label: name, address: info.address, priority });
    }
  }

  candidates.sort((a, b) => a.priority - b.priority);
  return candidates.map(({ label, address }) => ({ label, address }));
}

export function isLoopbackBindHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1'
  );
}

export async function detectTailscaleInfo(
  port: number,
  tailscalePort: number | null = DEFAULT_TAILSCALE_PORT,
  options: { loopbackOnly?: boolean } = {},
): Promise<ServerNetworkInfo['tailscale']> {
  const serveCommand =
    tailscalePort !== null ? `tailscale serve --bg --https=${tailscalePort} http://127.0.0.1:${port}` : '';
  const versionRes = await runSystemCommand('tailscale', ['version'], 1500);
  if (!versionRes.ok) {
    return {
      installed: false,
      running: false,
      ipv4: null,
      dnsName: null,
      servePort: tailscalePort,
      serveHttpsUrl: null,
      serveHttpsPort8443Url: null,
      serveCommand,
      tailscaleUrl: null,
      tailscaleQrSvg: null,
    };
  }

  const [ipRes, statusRes] = await Promise.all([
    runSystemCommand('tailscale', ['ip', '-4'], 2000),
    runSystemCommand('tailscale', ['status', '--json'], 2500),
  ]);

  const ipv4 = ipRes.ok ? ipRes.stdout.trim().split(/\r?\n/)[0]?.trim() || null : null;
  let dnsName: string | null = null;
  let running = Boolean(ipv4);

  if (statusRes.ok && statusRes.stdout.trim()) {
    try {
      const parsed = JSON.parse(statusRes.stdout) as {
        BackendState?: string;
        Self?: { DNSName?: string };
      };
      running = parsed.BackendState === 'Running' || Boolean(ipv4);
      const rawDns = parsed.Self?.DNSName?.replace(/\.$/, '');
      if (rawDns) dnsName = rawDns;
    } catch {
      // Ignore malformed status output
    }
  }

  const tailscaleUrl = !options.loopbackOnly && ipv4 ? `http://${ipv4}:${port}` : null;
  const serveHttpsUrl = dnsName && tailscalePort !== null ? `https://${dnsName}:${tailscalePort}` : null;

  return {
    installed: true,
    running,
    ipv4,
    dnsName,
    servePort: tailscalePort,
    serveHttpsUrl,
    serveHttpsPort8443Url: tailscalePort === 8443 ? serveHttpsUrl : null,
    serveCommand,
    tailscaleUrl,
    tailscaleQrSvg: null,
  };
}

export async function buildNetworkInfo(
  port: number,
  host: string,
  authEnabled: boolean,
  token: string,
  options: { tailscalePort?: number | null; clientPort?: number | null } = {},
): Promise<ServerNetworkInfo> {
  const clientPort = options.clientPort ?? null;
  const uiPort = clientPort ?? port;
  const tailscalePort =
    options.tailscalePort === undefined ? DEFAULT_TAILSCALE_PORT : options.tailscalePort;
  const loopbackOnly = isLoopbackBindHost(host);

  const localUrl = `http://localhost:${uiPort}`;
  const lanList = loopbackOnly ? [] : getLanIpv4Addresses();
  const tokenSuffix = authEnabled && token ? `/?token=${encodeURIComponent(token)}` : '/';

  const lanUrls = await Promise.all(
    lanList.map(async (item) => {
      const baseUrl = `http://${item.address}:${uiPort}`;
      const pairUrl = `${baseUrl}${tokenSuffix}`;
      const qrSvg = await QRCode.toString(pairUrl, {
        type: 'svg',
        margin: 1,
        color: { dark: '#e6edf3', light: '#0d1117' },
      });
      return {
        label: item.label,
        url: baseUrl,
        qrSvg,
      };
    }),
  );

  const tailscale = await detectTailscaleInfo(port, tailscalePort, { loopbackOnly });
  const qrTargetUrl = tailscale.serveHttpsUrl ?? tailscale.tailscaleUrl;
  if (qrTargetUrl) {
    const tsPairUrl = `${qrTargetUrl}${tokenSuffix}`;
    tailscale.tailscaleQrSvg = await QRCode.toString(tsPairUrl, {
      type: 'svg',
      margin: 1,
      color: { dark: '#e6edf3', light: '#0d1117' },
    });
  }

  const primaryBase =
    lanUrls[0]?.url ??
    (loopbackOnly ? tailscale.serveHttpsUrl : null) ??
    tailscale.tailscaleUrl ??
    tailscale.serveHttpsUrl ??
    localUrl;
  const pairingUrl = `${primaryBase}${tokenSuffix}`;
  const pairingQrSvg = await QRCode.toString(pairingUrl, {
    type: 'svg',
    margin: 1,
    color: { dark: '#e6edf3', light: '#0d1117' },
  });

  return {
    port,
    clientPort,
    host,
    localUrl,
    lanUrls,
    tailscale,
    authEnabled,
    pairingUrl,
    pairingQrSvg,
    avoidsPrivilegedPorts:
      !PRIVILEGED_WEB_PORTS.has(port) && (clientPort === null || !PRIVILEGED_WEB_PORTS.has(clientPort)),
  };
}

export async function renderTerminalQr(url: string): Promise<string> {
  return QRCode.toString(url, { type: 'terminal', small: true });
}

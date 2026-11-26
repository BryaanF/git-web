import { Check, Copy, ShieldCheck, Smartphone, Wifi, X } from 'lucide-react';
import { useState } from 'react';
import type { ServerNetworkInfo } from '../../shared/types.ts';

interface ConnectModalProps {
  open: boolean;
  network: ServerNetworkInfo | null;
  onClose: () => void;
}

export function ConnectModal({ open, network, onClose }: ConnectModalProps) {
  const [copiedKey, setCopiedKey] = useState<string | null>(null);

  if (!open) return null;

  const copyText = async (key: string, value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopiedKey(key);
      setTimeout(() => setCopiedKey(null), 1600);
    } catch {
      // Fallback prompt if HTTP non-localhost clipboard restricted
      window.prompt('Copy URL:', value);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/75 p-0 sm:items-center sm:p-4">
      <div className="max-h-[92dvh] w-full max-w-lg overflow-y-auto rounded-t-2xl border border-[#30363d] bg-[#161b22] p-5 shadow-2xl sm:rounded-2xl">
        <div className="mb-4 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-sky-500/15 text-sky-400">
              <Smartphone className="h-5 w-5" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-[#e6edf3]">Connect Smartphone</h2>
              <p className="text-xs text-[#8b949e]">
                {network?.clientPort
                  ? `UI Port ${network.clientPort} · API Port ${network.port}`
                  : `Port ${network?.port ?? 7745}`}{' '}
                · {network?.avoidsPrivilegedPorts === false ? 'Privileged port active' : 'Ports 80 & 443 untouched'}
              </p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg p-2 text-[#8b949e] hover:bg-[#30363d]/50 hover:text-white"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        {!network ? (
          <div className="py-8 text-center text-sm text-[#8b949e]">Loading network details...</div>
        ) : (
          <div className="space-y-4">
            <div className="flex flex-col items-center rounded-xl border border-[#30363d] bg-[#0d1117] p-4">
              <div
                className="h-44 w-44 overflow-hidden rounded-lg bg-[#0d1117] [&>svg]:h-full [&>svg]:w-full"
                dangerouslySetInnerHTML={{ __html: network.pairingQrSvg }}
              />
              <p className="mt-2.5 text-center text-xs text-[#8b949e]">
                Scan QR with your phone camera on the same Wi-Fi (or Tailscale).
              </p>
              <div className="mt-3 flex w-full items-center gap-2 rounded-lg border border-[#30363d] bg-[#161b22] px-3 py-2">
                <span className="min-w-0 flex-1 truncate font-mono text-xs text-sky-300">
                  {network.pairingUrl}
                </span>
                <button
                  type="button"
                  onClick={() => void copyText('pair', network.pairingUrl)}
                  className="inline-flex shrink-0 items-center gap-1 rounded-md bg-[#21262d] px-2.5 py-1 text-xs font-medium text-[#e6edf3] hover:bg-[#30363d]"
                >
                  {copiedKey === 'pair' ? (
                    <>
                      <Check className="h-3.5 w-3.5 text-emerald-400" />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="h-3.5 w-3.5" />
                      Copy
                    </>
                  )}
                </button>
              </div>
            </div>

            {network.lanUrls.length > 0 && (
              <div className="space-y-2 rounded-xl border border-[#30363d] bg-[#0d1117] p-3.5">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#8b949e]">
                  <Wifi className="h-3.5 w-3.5 text-emerald-400" />
                  Local Wi-Fi Interfaces
                </div>
                {network.lanUrls.map((lan) => (
                  <div
                    key={lan.url}
                    className="flex items-center justify-between gap-2 rounded-lg bg-[#161b22] px-3 py-2 text-xs"
                  >
                    <div className="min-w-0">
                      <div className="text-[11px] text-[#8b949e]">{lan.label}</div>
                      <div className="truncate font-mono text-[#e6edf3]">{lan.url}</div>
                    </div>
                    <button
                      type="button"
                      onClick={() => void copyText(lan.url, lan.url)}
                      className="rounded-md bg-[#21262d] px-2 py-1 text-xs text-[#e6edf3] hover:bg-[#30363d]"
                    >
                      {copiedKey === lan.url ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                ))}
              </div>
            )}

            <div className="space-y-2 rounded-xl border border-[#30363d] bg-[#0d1117] p-3.5">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-[#8b949e]">
                  <ShieldCheck className="h-3.5 w-3.5 text-sky-400" />
                  Tailscale &amp; Trusted HTTPS{' '}
                  {network.tailscale.servePort !== null && network.tailscale.servePort !== undefined
                    ? `(Port ${network.tailscale.servePort})`
                    : '(Disabled)'}
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 text-[10px] font-medium ${
                    network.tailscale.running
                      ? 'bg-emerald-500/15 text-emerald-300'
                      : 'bg-zinc-500/15 text-zinc-400'
                  }`}
                >
                  {network.tailscale.running
                    ? 'Active'
                    : network.tailscale.installed
                      ? 'Installed (Idle)'
                      : 'Not Installed'}
                </span>
              </div>

              {network.tailscale.serveHttpsUrl && (
                <div className="flex items-center justify-between gap-2 rounded-lg bg-[#161b22] px-3 py-2 text-xs">
                  <div className="min-w-0">
                    <div className="text-[11px] text-[#8b949e]">Tailscale HTTPS Endpoint</div>
                    <div className="truncate font-mono text-emerald-300">
                      {network.tailscale.serveHttpsUrl}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => void copyText('tsHttps', network.tailscale.serveHttpsUrl ?? '')}
                    className="shrink-0 rounded-md bg-[#21262d] px-2 py-1 text-xs text-[#e6edf3]"
                  >
                    {copiedKey === 'tsHttps' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              )}

              {network.tailscale.tailscaleUrl && (
                <div className="flex items-center justify-between gap-2 rounded-lg bg-[#161b22] px-3 py-2 text-xs">
                  <span className="truncate font-mono text-sky-300">
                    {network.tailscale.tailscaleUrl}
                  </span>
                  <button
                    type="button"
                    onClick={() => void copyText('ts', network.tailscale.tailscaleUrl ?? '')}
                    className="rounded-md bg-[#21262d] px-2 py-1 text-xs text-[#e6edf3]"
                  >
                    {copiedKey === 'ts' ? 'Copied' : 'Copy'}
                  </button>
                </div>
              )}

              {network.tailscale.serveCommand ? (
                <>
                  <p className="text-xs leading-relaxed text-[#8b949e]">
                    For trusted HTTPS PWA install over mobile data without touching port 80 or 443, run:
                  </p>
                  <div className="flex items-center justify-between gap-2 rounded-lg bg-[#161b22] px-3 py-2">
                    <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap text-[11px] text-amber-200">
                      {network.tailscale.serveCommand}
                    </code>
                    <button
                      type="button"
                      onClick={() => void copyText('serveCmd', network.tailscale.serveCommand)}
                      className="shrink-0 rounded-md bg-[#21262d] px-2 py-1 text-xs text-[#e6edf3]"
                    >
                      {copiedKey === 'serveCmd' ? 'Copied' : 'Copy'}
                    </button>
                  </div>
                </>
              ) : (
                <p className="text-xs leading-relaxed text-[#8b949e]">
                  Tailscale HTTPS serve command is disabled for this session.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

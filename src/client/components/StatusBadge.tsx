import { parseCommitSubject, type CommitType } from '../../shared/commit-standard.ts';
import type { CommitPushState, FileChangeStatus } from '../../shared/types.ts';

const FILE_STATUS_CONFIG: Record<
  FileChangeStatus,
  { code: string; label: string; badgeClass: string }
> = {
  modified: {
    code: 'M',
    label: 'Modified',
    badgeClass: 'bg-amber-500/15 text-amber-300 border-amber-500/30',
  },
  added: {
    code: 'A',
    label: 'Added',
    badgeClass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30',
  },
  deleted: {
    code: 'D',
    label: 'Deleted',
    badgeClass: 'bg-rose-500/15 text-rose-300 border-rose-500/30',
  },
  renamed: {
    code: 'R',
    label: 'Renamed',
    badgeClass: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  },
  copied: {
    code: 'C',
    label: 'Copied',
    badgeClass: 'bg-sky-500/15 text-sky-300 border-sky-500/30',
  },
  untracked: {
    code: '?',
    label: 'Untracked',
    badgeClass: 'bg-violet-500/15 text-violet-300 border-violet-500/30',
  },
  conflicted: {
    code: 'U',
    label: 'Conflict',
    badgeClass: 'bg-red-500/20 text-red-300 border-red-500/40',
  },
  typechange: {
    code: 'T',
    label: 'Type',
    badgeClass: 'bg-zinc-500/15 text-zinc-300 border-zinc-500/30',
  },
};

export function FileStatusBadge({
  status,
  showLabel = false,
}: {
  status: FileChangeStatus;
  showLabel?: boolean;
}) {
  const cfg = FILE_STATUS_CONFIG[status] ?? FILE_STATUS_CONFIG.modified;
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${cfg.badgeClass}`}
    >
      <span>{cfg.code}</span>
      {showLabel && <span>{cfg.label}</span>}
    </span>
  );
}

const PUSH_STATE_CONFIG: Record<
  CommitPushState,
  { label: string; dotClass: string; badgeClass: string }
> = {
  pushed: {
    label: 'Pushed',
    dotClass: 'bg-emerald-400',
    badgeClass: 'bg-emerald-500/15 text-emerald-300 border-emerald-500/35',
  },
  unpushed: {
    label: 'Unpushed (Local)',
    dotClass: 'bg-amber-400',
    badgeClass: 'bg-amber-500/15 text-amber-300 border-amber-500/35',
  },
  remote_only: {
    label: 'Remote Only',
    dotClass: 'bg-sky-400',
    badgeClass: 'bg-sky-500/15 text-sky-300 border-sky-500/35',
  },
};

export function PushStateBadge({
  state,
  remoteRef,
}: {
  state: CommitPushState;
  remoteRef?: string;
}) {
  const cfg = PUSH_STATE_CONFIG[state];
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium ${cfg.badgeClass}`}
    >
      <span className={`h-1.5 w-1.5 rounded-full ${cfg.dotClass}`} />
      <span>{cfg.label}</span>
      {remoteRef && state === 'pushed' && (
        <span className="max-w-[110px] truncate opacity-80">· {remoteRef}</span>
      )}
    </span>
  );
}

const COMMIT_TYPE_STYLE: Record<CommitType, string> = {
  bugfix: 'border-rose-500/40 bg-rose-500/15 text-rose-300',
  features: 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300',
  chores: 'border-zinc-400/35 bg-zinc-500/15 text-zinc-200',
  improvement: 'border-sky-500/40 bg-sky-500/15 text-sky-300',
};

export function CommitTypeBadge({ subject }: { subject: string }) {
  const parsed = parseCommitSubject(subject);
  if (!parsed) return null;
  const cls = COMMIT_TYPE_STYLE[parsed.type];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${cls}`}
    >
      <span>{parsed.type}</span>
      {parsed.scope && <span className="opacity-75">({parsed.scope})</span>}
    </span>
  );
}

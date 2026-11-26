export type FileChangeStatus =
  | 'modified'
  | 'added'
  | 'deleted'
  | 'renamed'
  | 'copied'
  | 'untracked'
  | 'conflicted'
  | 'typechange';

export type ChangeSection = 'unstaged' | 'staged' | 'conflicted';

export interface RepoEntry {
  id: string;
  name: string;
  path: string;
  remoteUrl?: string;
  addedAt: string;
}

export interface ChangedFile {
  path: string;
  oldPath?: string;
  status: FileChangeStatus;
  section: ChangeSection;
  isUntracked?: boolean;
  isBinary?: boolean;
  additions?: number;
  deletions?: number;
}

export interface RepoStatusSummary {
  repo: RepoEntry;
  branch: string;
  headSha: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  isDetached: boolean;
  hasRemote: boolean;
  remoteName: string | null;
  unstaged: ChangedFile[];
  staged: ChangedFile[];
  conflicted: ChangedFile[];
  lastRefreshedAt: string;
}

export interface DiffPayload {
  path: string;
  oldPath?: string;
  patch: string;
  hunks: string[];
  oldContent?: string;
  newContent?: string;
  lang: string;
  isBinary: boolean;
  isTooLarge: boolean;
  lineCount: number;
  additions: number;
  deletions: number;
  status: FileChangeStatus;
  note?: string;
}

export type CommitPushState = 'pushed' | 'unpushed' | 'remote_only';

export interface CommitSummary {
  sha: string;
  shortSha: string;
  subject: string;
  body: string;
  authorName: string;
  authorEmail: string;
  authoredAt: string;
  relativeDate: string;
  parents: string[];
  refs: string[];
  pushState: CommitPushState;
  pushedToRefs: string[];
}

export interface CommitHistoryResponse {
  commits: CommitSummary[];
  branch: string;
  upstream: string | null;
  ahead: number;
  behind: number;
  hasMore: boolean;
}

export interface CommitChangedFile {
  path: string;
  oldPath?: string;
  status: FileChangeStatus;
  additions: number;
  deletions: number;
  isBinary: boolean;
}

export interface CommitDetail {
  commit: CommitSummary;
  files: CommitChangedFile[];
}

export type RemoteVerifyVerdict =
  | 'synced'
  | 'ahead_unpushed'
  | 'behind_remote'
  | 'diverged'
  | 'stale_local_cache'
  | 'no_remote_branch'
  | 'no_upstream'
  | 'error';

export interface RemoteVerifyResult {
  ok: boolean;
  checkedAt: string;
  remoteName: string | null;
  remoteUrl: string | null;
  branch: string;
  upstreamRef: string | null;
  localHeadSha: string | null;
  localTrackingSha: string | null;
  remoteLiveSha: string | null;
  verdict: RemoteVerifyVerdict;
  message: string;
  aheadCount: number;
  behindCount: number;
}

export interface BranchItem {
  name: string;
  shortName: string;
  isCurrent: boolean;
  isRemote: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
  lastCommitSha: string;
  lastCommitSubject: string;
  lastCommitDate: string;
}

export interface ServerNetworkInfo {
  port: number;
  clientPort?: number | null;
  host: string;
  localUrl: string;
  lanUrls: Array<{ label: string; url: string; qrSvg: string }>;
  tailscale: {
    installed: boolean;
    running: boolean;
    ipv4: string | null;
    dnsName: string | null;
    servePort?: number | null;
    serveHttpsUrl?: string | null;
    serveHttpsPort8443Url: string | null;
    serveCommand: string;
    tailscaleUrl: string | null;
    tailscaleQrSvg: string | null;
  };
  authEnabled: boolean;
  pairingUrl: string;
  pairingQrSvg: string;
  avoidsPrivilegedPorts: boolean;
}

import type {
  BranchItem,
  CommitDetail,
  CommitHistoryResponse,
  DiffPayload,
  DirectoryBrowseResponse,
  RemoteVerifyResult,
  RepoEntry,
  RepoStatusSummary,
  ServerNetworkInfo,
} from '../shared/types.ts';

const TOKEN_STORAGE_KEY = 'gitdock_pairing_token';

export function bootstrapTokenFromUrl(): string | null {
  const url = new URL(window.location.href);
  const queryToken = url.searchParams.get('token');
  if (queryToken) {
    localStorage.setItem(TOKEN_STORAGE_KEY, queryToken);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.pathname + url.search + url.hash);
    return queryToken;
  }
  return localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function getStoredToken(): string {
  return localStorage.getItem(TOKEN_STORAGE_KEY) ?? '';
}

export function setStoredToken(token: string): void {
  if (token.trim()) {
    localStorage.setItem(TOKEN_STORAGE_KEY, token.trim());
  } else {
    localStorage.removeItem(TOKEN_STORAGE_KEY);
  }
}

export class ApiAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiAuthError';
  }
}

async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = getStoredToken();
  const headers = new Headers(init.headers);
  if (token) {
    headers.set('X-GitWeb-Token', token);
  }
  if (init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(path, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (res.status === 401) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new ApiAuthError(body.error ?? 'Pairing token required');
  }

  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) {
    throw new Error(data.error ?? `Request failed (${res.status})`);
  }
  return data;
}

export const api = {
  pair: (token: string) =>
    requestJson<{ ok: boolean }>('/api/auth/pair', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  getSession: () => requestJson<{ authenticated: boolean; authEnabled: boolean }>('/api/auth/session'),

  getNetworkInfo: () => requestJson<ServerNetworkInfo>('/api/network'),

  browseDirectories: (options: { path?: string; showHidden?: boolean; nearest?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (options.path) params.set('path', options.path);
    if (options.showHidden) params.set('hidden', '1');
    if (options.nearest) params.set('nearest', '1');
    const qs = params.toString();
    return requestJson<DirectoryBrowseResponse>(`/api/fs/browse${qs ? `?${qs}` : ''}`);
  },

  listRepos: () => requestJson<{ repos: RepoEntry[] }>('/api/repos'),

  addRepo: (repoPath: string) =>
    requestJson<{ repo: RepoEntry }>('/api/repos', {
      method: 'POST',
      body: JSON.stringify({ path: repoPath }),
    }),

  removeRepo: (id: string) =>
    requestJson<{ ok: boolean }>(`/api/repos/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  getStatus: (repoId: string) =>
    requestJson<RepoStatusSummary>(`/api/repos/${encodeURIComponent(repoId)}/status`),

  getWorkingDiff: (
    repoId: string,
    filePath: string,
    section: 'unstaged' | 'staged' | 'conflicted',
    context = 3,
    hint?: 'untracked',
  ) =>
    requestJson<DiffPayload>(
      `/api/repos/${encodeURIComponent(repoId)}/diff?path=${encodeURIComponent(filePath)}&section=${section}&context=${context}${hint ? `&hint=${encodeURIComponent(hint)}` : ''}`,
    ),

  stageFiles: (repoId: string, paths?: string[]) =>
    requestJson<RepoStatusSummary>(`/api/repos/${encodeURIComponent(repoId)}/stage`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),

  unstageFiles: (repoId: string, paths?: string[]) =>
    requestJson<RepoStatusSummary>(`/api/repos/${encodeURIComponent(repoId)}/unstage`, {
      method: 'POST',
      body: JSON.stringify({ paths }),
    }),

  discardFile: (repoId: string, filePath: string) =>
    requestJson<RepoStatusSummary>(`/api/repos/${encodeURIComponent(repoId)}/discard`, {
      method: 'POST',
      body: JSON.stringify({ path: filePath }),
    }),

  commit: (repoId: string, summary: string, description: string) =>
    requestJson<{ sha: string; status: RepoStatusSummary }>(
      `/api/repos/${encodeURIComponent(repoId)}/commit`,
      {
        method: 'POST',
        body: JSON.stringify({ summary, description }),
      },
    ),

  getCommits: (repoId: string, limit = 40, offset = 0) =>
    requestJson<CommitHistoryResponse>(
      `/api/repos/${encodeURIComponent(repoId)}/commits?limit=${limit}&offset=${offset}`,
    ),

  getCommitDetail: (repoId: string, sha: string) =>
    requestJson<CommitDetail>(
      `/api/repos/${encodeURIComponent(repoId)}/commits/${encodeURIComponent(sha)}`,
    ),

  getCommitFileDiff: (repoId: string, sha: string, filePath: string, context = 3) =>
    requestJson<DiffPayload>(
      `/api/repos/${encodeURIComponent(repoId)}/commits/${encodeURIComponent(sha)}/diff?path=${encodeURIComponent(filePath)}&context=${context}`,
    ),

  verifyRemote: (repoId: string) =>
    requestJson<RemoteVerifyResult>(`/api/repos/${encodeURIComponent(repoId)}/remote/verify`),

  fetchRemote: (repoId: string) =>
    requestJson<{ output: string; status: RepoStatusSummary }>(
      `/api/repos/${encodeURIComponent(repoId)}/remote/fetch`,
      { method: 'POST' },
    ),

  pullRemote: (repoId: string) =>
    requestJson<{ output: string; status: RepoStatusSummary }>(
      `/api/repos/${encodeURIComponent(repoId)}/remote/pull`,
      { method: 'POST' },
    ),

  pushRemote: (repoId: string, setUpstream = false) =>
    requestJson<{ output: string; status: RepoStatusSummary }>(
      `/api/repos/${encodeURIComponent(repoId)}/remote/push`,
      {
        method: 'POST',
        body: JSON.stringify({ setUpstream }),
      },
    ),

  listBranches: (repoId: string) =>
    requestJson<{ branches: BranchItem[] }>(`/api/repos/${encodeURIComponent(repoId)}/branches`),

  checkoutBranch: (repoId: string, branch: string, create = false) =>
    requestJson<{ status: RepoStatusSummary }>(
      `/api/repos/${encodeURIComponent(repoId)}/branches/checkout`,
      {
        method: 'POST',
        body: JSON.stringify({ branch, create }),
      },
    ),
};

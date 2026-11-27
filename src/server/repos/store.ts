import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { RepoEntry } from '../../shared/types.ts';
import { validateGitRepo } from '../git/service.ts';

export class RepoStore {
  private readonly configPath: string;
  private readonly workspaceRoot?: string;
  private repos: RepoEntry[] = [];

  constructor(dataDir: string, options: { workspaceRoot?: string } = {}) {
    this.configPath = path.join(dataDir, '.gitweb-repos.json');
    this.workspaceRoot = options.workspaceRoot ? path.resolve(options.workspaceRoot) : undefined;
  }

  private async isAllowedRepoPath(repoRoot: string): Promise<boolean> {
    if (!this.workspaceRoot) return true;
    try {
      const [realWorkspace, realRepo] = await Promise.all([
        fs.realpath(this.workspaceRoot),
        fs.realpath(path.resolve(repoRoot)),
      ]);
      const rel = path.relative(realWorkspace, realRepo);
      return !rel || (!rel.startsWith('..') && !path.isAbsolute(rel));
    } catch {
      return false;
    }
  }

  private makeId(repoPath: string): string {
    const base = path.basename(repoPath).toLowerCase().replace(/[^a-z0-9-_]+/g, '-').slice(0, 24) || 'repo';
    const hash = crypto.createHash('sha1').update(repoPath.toLowerCase()).digest('hex').slice(0, 8);
    return `${base}-${hash}`;
  }

  async init(initialRepoPaths: string[] = []): Promise<void> {
    try {
      const raw = await fs.readFile(this.configPath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (Array.isArray(parsed)) {
        const valid: RepoEntry[] = [];
        for (const item of parsed) {
          if (item && typeof item === 'object' && typeof (item as RepoEntry).path === 'string') {
            try {
              const info = await validateGitRepo((item as RepoEntry).path);
              if (!(await this.isAllowedRepoPath(info.rootPath))) {
                continue;
              }
              valid.push({
                id: this.makeId(info.rootPath),
                name: info.name,
                path: info.rootPath,
                remoteUrl: info.remoteUrl,
                addedAt: (item as RepoEntry).addedAt || new Date().toISOString(),
              });
            } catch {
              // Skip deleted/moved repos silently on startup
            }
          }
        }
        this.repos = valid;
      }
    } catch {
      this.repos = [];
    }

    for (const candidate of initialRepoPaths) {
      try {
        await this.addRepo(candidate);
      } catch {
        // Ignore if CWD or candidate is not a git repo yet
      }
    }

    // Also auto-discover sibling git repos one level up or down if none found yet
    if (this.repos.length === 0) {
      await this.discoverNearbyRepos(this.workspaceRoot ?? process.cwd());
    }
  }

  private async discoverNearbyRepos(baseDir: string): Promise<void> {
    const candidates = this.workspaceRoot ? [this.workspaceRoot] : [baseDir, path.dirname(baseDir)];
    for (const dir of candidates) {
      try {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === 'node_modules') continue;
          const full = path.join(dir, entry.name);
          try {
            await fs.access(path.join(full, '.git'));
            await this.addRepo(full);
          } catch {
            // Not a git repo
          }
          if (this.repos.length >= 6) return;
        }
      } catch {
        // Ignore inaccessible dirs
      }
    }
  }

  private async persist(): Promise<void> {
    await fs.writeFile(this.configPath, JSON.stringify(this.repos, null, 2), 'utf8');
  }

  list(): RepoEntry[] {
    return [...this.repos];
  }

  getById(id: string): RepoEntry | undefined {
    return this.repos.find((r) => r.id === id);
  }

  async addRepo(candidatePath: string): Promise<RepoEntry> {
    const info = await validateGitRepo(candidatePath);
    if (!(await this.isAllowedRepoPath(info.rootPath))) {
      throw new Error('Repository path is outside the configured workspace root');
    }
    const id = this.makeId(info.rootPath);
    const existing = this.repos.find((r) => r.id === id);
    if (existing) {
      existing.remoteUrl = info.remoteUrl;
      await this.persist();
      return existing;
    }

    const entry: RepoEntry = {
      id,
      name: info.name,
      path: info.rootPath,
      remoteUrl: info.remoteUrl,
      addedAt: new Date().toISOString(),
    };
    this.repos.unshift(entry);
    await this.persist();
    return entry;
  }

  async removeRepo(id: string): Promise<boolean> {
    const next = this.repos.filter((r) => r.id !== id);
    if (next.length === this.repos.length) return false;
    this.repos = next;
    await this.persist();
    return true;
  }
}

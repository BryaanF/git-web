export const COMMIT_TYPES = ['bugfix', 'features', 'chores', 'improvement'] as const;

export type CommitType = (typeof COMMIT_TYPES)[number];

export const MAX_COMMIT_SUBJECT_LENGTH = 50;

export interface CommitTypeInfo {
  type: CommitType;
  label: string;
  description: string;
  example: string;
}

export const COMMIT_TYPE_META: Record<CommitType, CommitTypeInfo> = {
  bugfix: {
    type: 'bugfix',
    label: 'bugfix',
    description: 'Perbaikan bug, error, atau regresi',
    example: 'bugfix(ui): clear diff spinner on clean tree',
  },
  features: {
    type: 'features',
    label: 'features',
    description: 'Penambahan fitur atau kapabilitas baru',
    example: 'features(repo): add host folder browser',
  },
  chores: {
    type: 'chores',
    label: 'chores',
    description: 'Konfigurasi, build, deps, docs, atau tooling/tests',
    example: 'chores(ci): add hook and workflow checks',
  },
  improvement: {
    type: 'improvement',
    label: 'improvement',
    description: 'Optimasi performa, refactor, atau peningkatan UX',
    example: 'improvement(git): batch staged diff blobs',
  },
};

export interface ParsedCommitSubject {
  type: CommitType;
  scope?: string;
  description: string;
}

export interface CommitValidationResult {
  valid: boolean;
  subject: string;
  parsed?: ParsedCommitSubject;
  reason?: string;
}

const SUBJECT_PATTERN = /^(bugfix|features|chores|improvement)(?:\(([a-z0-9][a-z0-9._/-]*)\))?: (.+)$/;
const GIT_AUTO_PREFIX_PATTERN = /^(Merge |Revert "|fixup! |squash! |amend! )/;

export function isCommitType(value: string): value is CommitType {
  return (COMMIT_TYPES as readonly string[]).includes(value);
}

export function parseCommitSubject(subject: string): ParsedCommitSubject | null {
  const firstLine = subject.split(/\r?\n/, 1)[0]?.trim() ?? '';
  const match = firstLine.match(SUBJECT_PATTERN);
  if (!match) return null;

  const [, rawType, scope, description] = match;
  if (!isCommitType(rawType) || !description.trim()) {
    return null;
  }

  return {
    type: rawType,
    scope: scope || undefined,
    description: description.trim(),
  };
}

export function formatCommitSubject(params: {
  type: CommitType | 'custom' | null;
  scope?: string;
  summary: string;
}): string {
  const cleanSummary = params.summary.trim();
  if (!cleanSummary) return '';

  if (params.type === 'custom') {
    return cleanSummary;
  }

  // If the summary already adheres to <type>(<scope>): <desc>, avoid double-prefixing.
  const existing = parseCommitSubject(cleanSummary);
  if (existing && (!params.type || existing.type === params.type)) {
    return cleanSummary;
  }

  if (!params.type) {
    return cleanSummary;
  }

  const cleanScope = (params.scope ?? '')
    .trim()
    .replace(/^[()]+|[()]+$/g, '')
    .replace(/\s+/g, '-')
    .toLowerCase();

  const bodyText = existing ? existing.description : cleanSummary;
  return cleanScope
    ? `${params.type}(${cleanScope}): ${bodyText}`
    : `${params.type}: ${bodyText}`;
}

export function validateCommitMessage(rawMessage: string): CommitValidationResult {
  const lines = rawMessage
    .split(/\r?\n/)
    .map((line) => line.replace(/\r$/, ''))
    .filter((line) => !line.startsWith('#'));

  const subject = (lines.find((line) => line.trim().length > 0) ?? '').trim();
  if (!subject) {
    return {
      valid: false,
      subject: '',
      reason: 'Commit message cannot be empty.',
    };
  }

  if (GIT_AUTO_PREFIX_PATTERN.test(subject)) {
    return { valid: true, subject };
  }

  const parsed = parseCommitSubject(subject);
  if (!parsed) {
    return {
      valid: false,
      subject,
      reason:
        'Commit header must follow "<type>: <summary>" or "<type>(<scope>): <summary>" using one of: bugfix, features, chores, improvement.',
    };
  }

  if (subject.length > MAX_COMMIT_SUBJECT_LENGTH) {
    return {
      valid: false,
      subject,
      parsed,
      reason: `Commit summary header is ${subject.length} characters (max ${MAX_COMMIT_SUBJECT_LENGTH} to avoid UI truncation; put details in the description body).`,
    };
  }

  return {
    valid: true,
    subject,
    parsed,
  };
}

import { DiffFile } from '@git-diff-view/file';
import { DiffModeEnum, DiffView } from '@git-diff-view/react';
import {
  AlignLeft,
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Columns2,
  Copy,
  FileCode2,
  Minus,
  Plus,
  Rows3,
  WrapText,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import type { DiffPayload } from '../../shared/types.ts';
import { FileStatusBadge } from './StatusBadge.tsx';

export interface DiffViewerPreferences {
  mode: 'unified' | 'split';
  wordWrap: boolean;
  fontSize: number;
  rawMode: boolean;
}

export function getDefaultDiffViewerPreferences(): DiffViewerPreferences {
  return {
    mode: typeof window !== 'undefined' && window.innerWidth >= 1024 ? 'split' : 'unified',
    wordWrap: true,
    fontSize: 12,
    rawMode: false,
  };
}

interface MobileDiffViewerProps {
  diff: DiffPayload | null;
  loading: boolean;
  error: string | null;
  contextLines: number;
  onChangeContextLines: (next: number) => void;
  onBack?: () => void;
  onCollapse?: () => void;
  inline?: boolean;
  preferences?: DiffViewerPreferences;
  onChangePreferences?: (next: DiffViewerPreferences) => void;
  onPrevFile?: () => void;
  onNextFile?: () => void;
  filePositionLabel?: string;
  sectionLabel?: string;
  emptyTitle?: string;
  emptyDescription?: string;
  actionButton?: {
    label: string;
    variant: 'stage' | 'unstage';
    busy?: boolean;
    onClick: () => void;
  };
}

/**
 * Ensures the patch passed to @git-diff-view/file always includes unified
 * `---` / `+++` headers and LF line endings so every hunk, addition, deletion,
 * and intra-line word diff parses reliably.
 */
function buildDiffPatchList(diff: DiffPayload): string[] {
  const normalized = (diff.patch ?? '').replace(/\r\n/g, '\n');
  if (!normalized.trim()) {
    return [];
  }
  const hasHeader = /^---\s+/m.test(normalized) && /^\+\+\+\s+/m.test(normalized);
  if (hasHeader) {
    return [normalized.endsWith('\n') ? normalized : `${normalized}\n`];
  }
  if (diff.hunks.length === 0) {
    return [];
  }
  const oldHeader =
    diff.status === 'added' || diff.status === 'untracked'
      ? '--- /dev/null'
      : `--- a/${diff.oldPath ?? diff.path}`;
  const newHeader = diff.status === 'deleted' ? '+++ /dev/null' : `+++ b/${diff.path}`;
  const body = diff.hunks.map((h) => h.replace(/\r\n/g, '\n')).join('\n');
  return [`${oldHeader}\n${newHeader}\n${body}\n`];
}

function normalizeContentForPatch(content: string | undefined, patchHasCr: boolean): string {
  if (!content) return '';
  return patchHasCr ? content : content.replace(/\r\n/g, '\n');
}

function DiffStatBlocks({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (total === 0) return null;
  const slots = 5;
  const addBlocks = Math.round((additions / total) * slots);
  const delBlocks = total > 0 && deletions > 0 && addBlocks === slots ? slots - 1 : slots - addBlocks;
  const finalAdd = additions > 0 && addBlocks === 0 ? 1 : Math.min(slots, addBlocks);
  const finalDel = Math.max(0, Math.min(slots - finalAdd, delBlocks));

  return (
    <span className="inline-flex items-center gap-0.5" title={`+${additions} additions, -${deletions} deletions`}>
      {Array.from({ length: slots }).map((_, idx) => {
        const color =
          idx < finalAdd
            ? 'bg-emerald-400'
            : idx < finalAdd + finalDel
              ? 'bg-rose-500'
              : 'bg-[#30363d]';
        return <span key={idx} className={`h-2 w-2 rounded-[2px] ${color}`} />;
      })}
    </span>
  );
}

function renderColorizedRawPatch(patch: string, wordWrap: boolean, fontSize: number) {
  const lines = patch.replace(/\r\n/g, '\n').split('\n');
  return (
    <div
      className={`font-mono leading-relaxed ${wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre'}`}
      style={{ fontSize: `${fontSize}px` }}
    >
      {lines.map((line, idx) => {
        let rowClass = 'text-[#c9d1d9] px-2 py-0.5';
        if (line.startsWith('@@ ')) {
          rowClass = 'bg-[#122136] text-sky-300 px-2 py-1 border-y border-[#213654]';
        } else if (line.startsWith('+') && !line.startsWith('+++')) {
          rowClass = 'bg-[#12281c] text-emerald-200 border-l-2 border-emerald-400 px-2 py-0.5';
        } else if (line.startsWith('-') && !line.startsWith('---')) {
          rowClass = 'bg-[#2d1619] text-rose-200 border-l-2 border-rose-500 px-2 py-0.5';
        } else if (
          line.startsWith('diff --git ') ||
          line.startsWith('index ') ||
          line.startsWith('--- ') ||
          line.startsWith('+++ ')
        ) {
          rowClass = 'text-[#8b949e] px-2 py-0.5';
        }
        return (
          <div key={idx} className={rowClass}>
            {line || ' '}
          </div>
        );
      })}
    </div>
  );
}

export function MobileDiffViewer({
  diff,
  loading,
  error,
  contextLines,
  onChangeContextLines,
  onBack,
  onCollapse,
  inline = false,
  preferences,
  onChangePreferences,
  onPrevFile,
  onNextFile,
  filePositionLabel,
  sectionLabel,
  emptyTitle,
  emptyDescription,
  actionButton,
}: MobileDiffViewerProps) {
  const [isMobileScreen, setIsMobileScreen] = useState(() =>
    typeof window !== 'undefined' ? window.innerWidth < 768 : true,
  );
  const [localPrefs, setLocalPrefs] = useState<DiffViewerPreferences>(() =>
    getDefaultDiffViewerPreferences(),
  );
  const activePrefs = preferences ?? localPrefs;
  const { mode, wordWrap, fontSize, rawMode } = activePrefs;
  const updatePrefs = (patch: Partial<DiffViewerPreferences>) => {
    const next = { ...activePrefs, ...patch };
    if (onChangePreferences) {
      onChangePreferences(next);
    } else {
      setLocalPrefs(next);
    }
  };
  const [copiedPath, setCopiedPath] = useState(false);

  useEffect(() => {
    const onResize = () => setIsMobileScreen(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const effectiveMode = mode === 'split' && isMobileScreen ? 'unified' : mode;

  const built = useMemo(() => {
    if (!diff || diff.isBinary || diff.isTooLarge || rawMode) {
      return { instance: null as DiffFile | null, parseError: null as string | null };
    }
    const patchList = buildDiffPatchList(diff);
    if (patchList.length === 0) {
      return { instance: null as DiffFile | null, parseError: null as string | null };
    }
    try {
      const patchHasCr = patchList[0].includes('\r');
      const instance = DiffFile.createInstance({
        oldFile: {
          fileName: diff.oldPath ?? diff.path,
          fileLang: diff.lang,
          content: normalizeContentForPatch(diff.oldContent, patchHasCr),
        },
        newFile: {
          fileName: diff.path,
          fileLang: diff.lang,
          content: normalizeContentForPatch(diff.newContent, patchHasCr),
        },
        hunks: patchList,
      });
      instance.initTheme('dark');
      instance.init();
      if (effectiveMode === 'split') {
        instance.buildSplitDiffLines();
      } else {
        instance.buildUnifiedDiffLines();
      }
      return { instance, parseError: null };
    } catch (err) {
      return {
        instance: null,
        parseError: err instanceof Error ? err.message : 'Unable to parse diff hunks',
      };
    }
  }, [diff, effectiveMode, rawMode]);

  const copyFilePath = async () => {
    if (!diff) return;
    try {
      await navigator.clipboard.writeText(diff.path);
      setCopiedPath(true);
      setTimeout(() => setCopiedPath(false), 1200);
    } catch {
      // Ignore clipboard failures on insecure origins
    }
  };

  if (loading && !diff) {
    return (
      <div
        className={`flex ${inline ? 'min-h-[200px]' : 'min-h-[320px]'} flex-col items-center justify-center rounded-2xl border border-[#30363d] bg-[#161b22] p-8 text-center`}
      >
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-sky-400 border-t-transparent" />
        <p className="mt-3 text-sm text-[#8b949e]">Loading diff...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-2xl border border-rose-500/40 bg-rose-500/10 p-5 text-sm text-rose-200">
        {(onBack || onCollapse) && (
          <button
            type="button"
            onClick={onBack ?? onCollapse}
            className="mb-3 inline-flex items-center gap-1.5 rounded-lg bg-[#21262d] px-3 py-1.5 text-xs font-medium text-[#e6edf3]"
          >
            {onBack ? <ArrowLeft className="h-3.5 w-3.5" /> : <ChevronUp className="h-3.5 w-3.5" />}
            {onBack ? 'Back' : 'Collapse'}
          </button>
        )}
        <p>{error}</p>
      </div>
    );
  }

  if (!diff) {
    return (
      <div className="hidden min-h-[420px] flex-col items-center justify-center rounded-2xl border border-dashed border-[#30363d] bg-[#161b22]/50 p-8 text-center lg:flex">
        <FileCode2 className="h-10 w-10 text-[#484f58]" />
        <h3 className="mt-3 text-sm font-medium text-[#e6edf3]">
          {emptyTitle ?? 'Select a file to inspect diff'}
        </h3>
        <p className="mt-1 max-w-xs text-xs text-[#8b949e]">
          {emptyDescription ??
            'Choose an unstaged, untracked, staged, or committed file from the list to view syntax-highlighted changes.'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      {/* Sticky header optimized for mobile thumb navigation */}
      <div className="sticky top-[52px] z-20 rounded-2xl border border-[#30363d] bg-[#161b22]/95 p-3 shadow-lg backdrop-blur">
        <div className="flex items-start justify-between gap-2">
          <div className="flex min-w-0 flex-1 items-start gap-2">
            {onBack && (
              <button
                type="button"
                onClick={onBack}
                className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[#30363d] bg-[#21262d] text-[#e6edf3] active:scale-95"
                aria-label="Back to files"
              >
                <ArrowLeft className="h-4 w-4" />
              </button>
            )}
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                {sectionLabel && (
                  <span className="rounded bg-[#21262d] px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[#8b949e]">
                    {sectionLabel}
                  </span>
                )}
                <FileStatusBadge status={diff.status} showLabel />
                <DiffStatBlocks additions={diff.additions} deletions={diff.deletions} />
                <span className="font-mono text-xs font-semibold text-emerald-400">
                  +{diff.additions}
                </span>
                <span className="font-mono text-xs font-semibold text-rose-400">
                  -{diff.deletions}
                </span>
                {diff.hunks.length > 0 && (
                  <span className="text-[11px] text-[#8b949e]">
                    · {diff.hunks.length} {diff.hunks.length === 1 ? 'hunk' : 'hunks'}
                  </span>
                )}
                {loading && (
                  <span className="inline-flex items-center gap-1 text-[11px] text-sky-400">
                    <span className="h-2.5 w-2.5 animate-spin rounded-full border border-sky-400 border-t-transparent" />
                    Loading...
                  </span>
                )}
              </div>
              <button
                type="button"
                onClick={() => void copyFilePath()}
                className="mt-1 flex max-w-full items-center gap-1.5 text-left"
                title="Copy file path"
              >
                <span className="break-all font-mono text-xs font-medium text-[#e6edf3]">
                  {diff.oldPath ? `${diff.oldPath} → ${diff.path}` : diff.path}
                </span>
                <Copy className="h-3 w-3 shrink-0 text-[#6e7681]" />
                {copiedPath && <span className="text-[10px] text-emerald-400">Copied</span>}
              </button>
            </div>
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {actionButton && (
              <button
                type="button"
                disabled={actionButton.busy}
                onClick={actionButton.onClick}
                className={`inline-flex shrink-0 items-center gap-1 rounded-xl px-3 py-2 text-xs font-semibold transition active:scale-95 disabled:opacity-50 ${
                  actionButton.variant === 'stage'
                    ? 'bg-emerald-600 text-white hover:bg-emerald-500'
                    : 'border border-amber-500/40 bg-amber-500/15 text-amber-200 hover:bg-amber-500/25'
                }`}
              >
                {actionButton.variant === 'stage' ? (
                  <Plus className="h-3.5 w-3.5" />
                ) : (
                  <Minus className="h-3.5 w-3.5" />
                )}
                {actionButton.label}
              </button>
            )}
            {onCollapse && !onBack && (
              <button
                type="button"
                onClick={onCollapse}
                title="Collapse diff"
                aria-label="Collapse diff"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border border-[#30363d] bg-[#21262d] text-[#8b949e] hover:border-[#484f58] hover:text-[#e6edf3] active:scale-95"
              >
                <ChevronUp className="h-4 w-4" />
              </button>
            )}
          </div>
        </div>

        {/* Viewer controls bar */}
        <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2 border-t border-[#30363d]/70 pt-2.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              onClick={() => updatePrefs({ wordWrap: !wordWrap })}
              className={`inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition ${
                wordWrap
                  ? 'border-sky-500/40 bg-sky-500/15 text-sky-300'
                  : 'border-[#30363d] bg-[#0d1117] text-[#8b949e]'
              }`}
            >
              <WrapText className="h-3.5 w-3.5" />
              {wordWrap ? 'Wrap ON' : 'H-Scroll'}
            </button>

            <button
              type="button"
              onClick={() => updatePrefs({ mode: mode === 'unified' ? 'split' : 'unified' })}
              className="hidden items-center gap-1 rounded-lg border border-[#30363d] bg-[#0d1117] px-2.5 py-1.5 text-xs font-medium text-[#e6edf3] md:inline-flex"
            >
              {effectiveMode === 'unified' ? (
                <>
                  <Rows3 className="h-3.5 w-3.5 text-sky-400" />
                  Unified
                </>
              ) : (
                <>
                  <Columns2 className="h-3.5 w-3.5 text-sky-400" />
                  Split
                </>
              )}
            </button>

            <select
              value={contextLines}
              onChange={(e) => onChangeContextLines(Number(e.target.value))}
              aria-label="Context lines"
              className="rounded-lg border border-[#30363d] bg-[#0d1117] px-2 py-1.5 text-xs text-[#e6edf3] focus:outline-none"
            >
              <option value={3}>Ctx: 3</option>
              <option value={15}>Ctx: 15</option>
              <option value={40}>Ctx: 40</option>
            </select>

            <select
              value={fontSize}
              onChange={(e) => updatePrefs({ fontSize: Number(e.target.value) })}
              aria-label="Font size"
              className="rounded-lg border border-[#30363d] bg-[#0d1117] px-2 py-1.5 text-xs text-[#e6edf3] focus:outline-none"
            >
              <option value={11}>11px</option>
              <option value={12}>12px</option>
              <option value={14}>14px</option>
            </select>

            <button
              type="button"
              onClick={() => updatePrefs({ rawMode: !rawMode })}
              className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-xs font-medium ${
                rawMode
                  ? 'border-amber-500/40 bg-amber-500/15 text-amber-300'
                  : 'border-[#30363d] bg-[#0d1117] text-[#8b949e]'
              }`}
            >
              <AlignLeft className="h-3.5 w-3.5" />
              Raw
            </button>
          </div>

          {(onPrevFile || onNextFile) && (
            <div className="flex items-center gap-1">
              <button
                type="button"
                disabled={!onPrevFile}
                onClick={onPrevFile}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#30363d] bg-[#0d1117] text-[#e6edf3] disabled:opacity-30"
                aria-label="Previous file"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              {filePositionLabel && (
                <span className="px-1.5 font-mono text-[11px] text-[#8b949e]">
                  {filePositionLabel}
                </span>
              )}
              <button
                type="button"
                disabled={!onNextFile}
                onClick={onNextFile}
                className="flex h-8 w-8 items-center justify-center rounded-lg border border-[#30363d] bg-[#0d1117] text-[#e6edf3] disabled:opacity-30"
                aria-label="Next file"
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Diff Content Area */}
      {diff.isBinary ? (
        <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-6 text-center text-sm text-[#8b949e]">
          {diff.note ?? 'Binary file changed — text diff unavailable.'}
        </div>
      ) : diff.isTooLarge ? (
        <div className="rounded-2xl border border-amber-500/30 bg-amber-500/10 p-6 text-center text-sm text-amber-200">
          {diff.note ?? `Diff is very large (${diff.lineCount} lines) and skipped to keep mobile rendering fast.`}
        </div>
      ) : rawMode || built.parseError ? (
        <div className="overflow-x-auto rounded-2xl border border-[#30363d] bg-[#0d1117] py-2">
          {built.parseError && (
            <p className="mb-2 px-3 text-xs text-amber-300">
              Showing raw patch ({built.parseError})
            </p>
          )}
          {diff.patch
            ? renderColorizedRawPatch(diff.patch, wordWrap, fontSize)
            : <div className="px-3 py-2 text-xs text-[#8b949e]">(Empty file / no textual diff)</div>}
        </div>
      ) : built.instance ? (
        <div className="gitdock-diff">
          <DiffView
            diffFile={built.instance}
            diffViewMode={effectiveMode === 'split' ? DiffModeEnum.Split : DiffModeEnum.Unified}
            diffViewTheme="dark"
            diffViewWrap={wordWrap}
            diffViewFontSize={fontSize}
            diffViewHighlight={true}
          />
        </div>
      ) : (
        <div className="rounded-2xl border border-[#30363d] bg-[#161b22] p-6 text-center text-sm text-[#8b949e]">
          {diff.note ?? 'No textual changes in this file (e.g., empty file or mode-only change).'}
        </div>
      )}
    </div>
  );
}

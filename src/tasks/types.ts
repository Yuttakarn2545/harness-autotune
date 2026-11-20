export interface FileContent {
  /** Repo-relative POSIX path. */
  path: string;
  content: string;
}

export type TaskKind = "git-commit" | "stub";

/**
 * A benchmark task mined from a real repository.
 *
 * The agent sees: the snapshot of `baseCommit` + `overlay`, minus `hiddenTests`, sealed into a fresh
 * single-commit repo. The scorer then writes `hiddenTests` into the workspace and runs `testCommand`.
 * `reference` is the known-good solution, used only to verify the task is solvable; agents never see it.
 */
export interface Task {
  id: string;
  kind: TaskKind;
  /** Display name of the source repo (never an absolute path). */
  repoName: string;
  baseCommit: string;
  instruction: string;
  overlay: FileContent[];
  hiddenTests: FileContent[];
  /** Files to delete from the agent's view (e.g. tests added by the reference commit that exist nowhere at base). */
  removeFromWorkspace: string[];
  reference: FileContent[];
  testCommand: string;
  meta: Record<string, string>;
  verified?: { baseFails: boolean; referencePasses: boolean; baseMs: number; referenceMs: number };
}

export interface MineOptions {
  /** Shell command template; `{files}` is replaced with the hidden test paths. */
  testCommand?: string;
  /** Max tasks to emit. */
  limit?: number;
  /** Only consider files under this repo-relative prefix (e.g. "packages/core"). */
  scope?: string;
}

export const TEST_FILE_RE = /(^|\/)(test|tests|__tests__|spec)\/|[._-](test|spec)\.[cm]?[jt]sx?$|_test\.go$|(^|\/)test_[^/]+\.py$|_test\.py$/;
export const CODE_FILE_RE = /\.(ts|tsx|js|jsx|mjs|cjs|vue|go|rs|py|java|kt|cs|rb|php)$/;

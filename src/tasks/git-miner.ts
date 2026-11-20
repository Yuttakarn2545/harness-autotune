import { basename } from "node:path";
import { git } from "../exec.js";
import { CODE_FILE_RE, TEST_FILE_RE, type FileContent, type MineOptions, type Task } from "./types.js";

export async function showFile(repo: string, commit: string, path: string): Promise<string | undefined> {
  try {
    return await git(repo, ["show", `${commit}:${path}`], { maxOutput: 20_000_000 });
  } catch {
    return undefined;
  }
}

/** Guess how to run a given set of test files at a commit. `{files}` is substituted later. */
export async function detectTestCommand(repo: string, commit: string): Promise<string | undefined> {
  const pkg = await showFile(repo, commit, "package.json");
  if (pkg) {
    try {
      const j = JSON.parse(pkg) as { devDependencies?: Record<string, string>; dependencies?: Record<string, string> };
      const deps = { ...j.dependencies, ...j.devDependencies };
      if (deps["vitest"]) return "npx vitest run {files}";
      if (deps["jest"]) return "npx jest {files}";
      if (deps["mocha"]) return "npx mocha {files}";
    } catch {
      /* not JSON */
    }
    return "node --test {files}";
  }
  if (await showFile(repo, commit, "go.mod")) return "go test ./...";
  if ((await showFile(repo, commit, "pyproject.toml")) || (await showFile(repo, commit, "pytest.ini"))) return "python -m pytest -q {files}";
  if (await showFile(repo, commit, "Cargo.toml")) return "cargo test";
  return undefined;
}

export function renderTestCommand(template: string, files: string[]): string {
  return template.replace("{files}", files.map((f) => (/\s/.test(f) ? `"${f}"` : f)).join(" "));
}

const TRAILER_RE = /^(co-authored-by|signed-off-by|reviewed-by|change-id|🤖 generated with).*$/gim;

/** Turn a commit message into a task instruction. The diff is never shown. */
export function instructionFromCommit(subject: string, body: string, changedSource: string[]): string {
  const cleanBody = body.replace(TRAILER_RE, "").replace(/\n{3,}/g, "\n\n").trim();
  const where = changedSource.length <= 6 ? `\n\nRelevant files (hint): ${changedSource.map((f) => `\`${f}\``).join(", ")}.` : "";
  return [
    `Make the following change to this repository.`,
    ``,
    `### ${subject.trim()}`,
    cleanBody ? `\n${cleanBody}` : "",
    where,
    ``,
    `Hidden tests will check the result, so keep existing behaviour working.`,
  ]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

interface CommitInfo {
  sha: string;
  parents: string[];
  subject: string;
  body: string;
}

async function listCommits(repo: string, max: number): Promise<CommitInfo[]> {
  const raw = await git(repo, ["log", `--max-count=${max}`, "--format=%H%x00%P%x00%s%x00%b%x1e"], { maxOutput: 50_000_000 });
  return raw
    .split("\x1e")
    .map((r) => r.replace(/^\s+/, ""))
    .filter(Boolean)
    .map((r) => {
      const [sha = "", parents = "", subject = "", body = ""] = r.split("\x00");
      return { sha, parents: parents.split(" ").filter(Boolean), subject, body };
    });
}

/**
 * Mine tasks from history: a commit qualifies when it changes both tests and source.
 * Task = parent commit + instruction from the message; hidden tests = the commit's version of the
 * changed test files. Solvability (fails at base, passes at reference) is checked by `verifyTask`.
 */
export async function mineGitTasks(repo: string, opts: MineOptions & { maxCommits?: number } = {}): Promise<Task[]> {
  const repoName = basename(repo);
  const commits = await listCommits(repo, opts.maxCommits ?? 500);
  const tasks: Task[] = [];
  for (const c of commits) {
    if (opts.limit && tasks.length >= opts.limit) break;
    if (c.parents.length !== 1) continue;
    const parent = c.parents[0]!;
    const status = await git(repo, ["diff", "--name-status", "--no-renames", parent, c.sha]);
    const changes = status
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        const [st = "", path = ""] = l.split("\t");
        return { st, path };
      })
      .filter((x) => !opts.scope || x.path.startsWith(opts.scope));
    const tests = changes.filter((x) => TEST_FILE_RE.test(x.path) && CODE_FILE_RE.test(x.path) && x.st !== "D");
    const source = changes.filter((x) => !TEST_FILE_RE.test(x.path) && CODE_FILE_RE.test(x.path));
    if (!tests.length || !source.length) continue;
    const template = opts.testCommand ?? (await detectTestCommand(repo, c.sha));
    if (!template) continue;

    const hiddenTests: FileContent[] = [];
    for (const t of tests) {
      const content = await showFile(repo, c.sha, t.path);
      if (content !== undefined) hiddenTests.push({ path: t.path, content });
    }
    const reference: FileContent[] = [];
    for (const s of source.filter((s) => s.st !== "D")) {
      const content = await showFile(repo, c.sha, s.path);
      if (content !== undefined) reference.push({ path: s.path, content });
    }
    tasks.push({
      id: `${repoName}-git-${c.sha.slice(0, 8)}`,
      kind: "git-commit",
      repoName,
      baseCommit: parent,
      instruction: instructionFromCommit(c.subject, c.body, source.map((s) => s.path)),
      overlay: [],
      hiddenTests,
      // Tests newly added by the commit simply don't exist at base; modified tests keep their old visible version.
      removeFromWorkspace: [],
      reference,
      testCommand: renderTestCommand(template, hiddenTests.map((h) => h.path)),
      meta: { subject: c.subject, referenceCommit: c.sha, deletedSource: source.filter((s) => s.st === "D").map((s) => s.path).join(",") },
    });
  }
  return tasks;
}

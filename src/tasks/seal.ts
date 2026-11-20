import { spawn } from "node:child_process";
import { cp, lstat, mkdir, mkdtemp, readdir, readlink, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { git, sh } from "../exec.js";
import type { FileContent, Task } from "./types.js";

export type DepsMode = "none" | "copy" | { setup: string };

export interface SealOptions {
  /** Absolute path of the source repo. Opened read-only: only `git archive` / `git show` touch it. */
  sourceRepo: string;
  /** Extra files laid over the snapshot before sealing (config variants: CLAUDE.md, skills). */
  extraFiles?: FileContent[];
  deps?: DepsMode;
  /** Parent directory for workspaces (default: OS temp). */
  root?: string;
}

export interface SealedWorkspace {
  dir: string;
  dispose(): Promise<void>;
}

const FIXED_DATE = "2000-01-01T00:00:00Z";

/** Extract a commit's tree into `dest` without touching the source working tree or index. */
export async function exportCommit(sourceRepo: string, commit: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  await new Promise<void>((resolveP, reject) => {
    const archive = spawn("git", ["archive", "--format=tar", commit], { cwd: sourceRepo, windowsHide: true });
    const tar = spawn("tar", ["-xf", "-"], { cwd: dest, windowsHide: true });
    let err = "";
    archive.stderr.on("data", (d) => (err += d));
    tar.stderr.on("data", (d) => (err += d));
    archive.stdout.pipe(tar.stdin);
    archive.on("error", reject);
    tar.on("error", reject);
    let archiveCode: number | null = null;
    archive.on("close", (c) => (archiveCode = c));
    tar.on("close", (c) => {
      if (c === 0 && archiveCode === 0) resolveP();
      else reject(new Error(`export of ${commit} failed (git ${archiveCode}, tar ${c}): ${err.trim()}`));
    });
  });
}

async function writeFiles(root: string, files: FileContent[]) {
  for (const f of files) {
    const p = join(root, ...f.path.split("/"));
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, f.content);
  }
}

/**
 * Build a sealed workspace for a task: snapshot at base, overlay applied, hidden tests removed,
 * then a brand-new git repo with exactly one orphan commit, no remotes, no reflog of the source.
 * Agents that run `git log` see nothing from the future (cf. agentbench-local, Claw-SWE-Bench).
 */
export async function sealWorkspace(task: Task, opts: SealOptions): Promise<SealedWorkspace> {
  const parent = opts.root ?? tmpdir();
  await mkdir(parent, { recursive: true });
  const dir = await mkdtemp(join(parent, "autotune-"));
  await exportCommit(opts.sourceRepo, task.baseCommit, dir);
  await writeFiles(dir, task.overlay);
  for (const p of [...task.removeFromWorkspace, ...task.hiddenTests.map((t) => t.path)]) {
    await rm(join(dir, ...p.split("/")), { force: true });
  }
  await writeFiles(dir, opts.extraFiles ?? []);

  const env = {
    ...process.env,
    GIT_AUTHOR_NAME: "autotune",
    GIT_AUTHOR_EMAIL: "autotune@localhost",
    GIT_COMMITTER_NAME: "autotune",
    GIT_COMMITTER_EMAIL: "autotune@localhost",
    GIT_AUTHOR_DATE: FIXED_DATE,
    GIT_COMMITTER_DATE: FIXED_DATE,
  };
  await git(dir, ["init", "-q", "-b", "main"], { env });
  await writeFile(join(dir, ".git", "info", "exclude"), "node_modules/\n.autotune/\n");
  await git(dir, ["add", "-A"], { env });
  await git(dir, ["-c", "commit.gpgsign=false", "commit", "-q", "--no-verify", "-m", "snapshot"], { env });

  const deps = opts.deps ?? "none";
  if (deps === "copy") await copyNodeModules(opts.sourceRepo, dir);
  else if (typeof deps === "object") {
    const r = await sh(deps.setup, { cwd: dir, timeoutMs: 15 * 60_000 });
    if (r.code !== 0) throw new Error(`setup command failed (${r.code}): ${(r.stderr || r.stdout).slice(-2000)}`);
  }

  return { dir, dispose: () => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }) };
}

/** Facts an auditor can check: the workspace leaks nothing from the source repo's history. */
export async function auditSeal(dir: string, task: Task): Promise<{ ok: boolean; problems: string[] }> {
  const problems: string[] = [];
  const count = (await git(dir, ["rev-list", "--all", "--count"])).trim();
  if (count !== "1") problems.push(`expected 1 commit, found ${count}`);
  const remotes = (await git(dir, ["remote"])).trim();
  if (remotes) problems.push(`unexpected remotes: ${remotes}`);
  const tracked = new Set((await git(dir, ["ls-files"])).split("\n").filter(Boolean));
  for (const h of task.hiddenTests) if (tracked.has(h.path)) problems.push(`hidden test is visible: ${h.path}`);
  const objects = await git(dir, ["count-objects", "-v"]);
  if (/packs: [1-9]/.test(objects)) problems.push("workspace contains pack files (possible copied history)");
  return { ok: problems.length === 0, problems };
}

/**
 * Copy node_modules trees from the source repo (top level and one level of workspaces).
 * Symlinks that point back into the source repo (npm/pnpm workspace links) are re-pointed into the
 * workspace, so tests exercise the agent's code, not the original, and writes never reach the source.
 */
export async function copyNodeModules(sourceRepo: string, dest: string): Promise<void> {
  const src = resolve(sourceRepo);
  const roots = [""];
  for (const group of ["packages", "apps", "libs"]) {
    try {
      for (const e of await readdir(join(src, group), { withFileTypes: true })) if (e.isDirectory()) roots.push(join(group, e.name));
    } catch {
      /* no such dir */
    }
  }
  for (const r of roots) {
    const from = join(src, r, "node_modules");
    try {
      await lstat(from);
    } catch {
      continue;
    }
    const to = join(dest, r, "node_modules");
    await cp(from, to, { recursive: true, verbatimSymlinks: true, force: true });
    await relinkInto(to, src, resolve(dest));
  }
}

async function relinkInto(dir: string, src: string, dest: string, depth = 0): Promise<void> {
  if (depth > 1) return;
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isSymbolicLink()) {
      let target = await readlink(p);
      if (!isAbsolute(target)) target = resolve(dirname(p), target);
      const rel = relative(src, target);
      if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
        await unlink(p);
        await symlink(join(dest, rel), p, process.platform === "win32" ? "junction" : "dir");
      }
    } else if (e.isDirectory() && e.name.startsWith("@")) {
      await relinkInto(p, src, dest, depth + 1);
    }
  }
}

export function toPosix(p: string): string {
  return p.split(sep).join("/");
}

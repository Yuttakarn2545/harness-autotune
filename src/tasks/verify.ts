import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { sh } from "../exec.js";
import { auditSeal, sealWorkspace, type DepsMode } from "./seal.js";
import type { FileContent, Task } from "./types.js";

export async function writeInto(dir: string, files: FileContent[]) {
  for (const f of files) {
    const p = join(dir, ...f.path.split("/"));
    await mkdir(dirname(p), { recursive: true });
    await writeFile(p, f.content);
  }
}

export interface TestOutcome {
  pass: boolean;
  code: number;
  ms: number;
  timedOut: boolean;
  tail: string;
}

/** Restore hidden tests (overwriting anything the agent wrote at those paths) and run them. */
export async function scoreWorkspace(dir: string, task: Task, timeoutMs = 10 * 60_000): Promise<TestOutcome> {
  await writeInto(dir, task.hiddenTests);
  const r = await sh(task.testCommand, { cwd: dir, timeoutMs, env: { ...process.env, CI: "1", FORCE_COLOR: "0" } });
  const out = (r.stdout + "\n" + r.stderr).trim();
  return { pass: r.code === 0 && !r.timedOut, code: r.code, ms: r.ms, timedOut: r.timedOut, tail: out.slice(-1500) };
}

export interface VerifyOptions {
  sourceRepo: string;
  deps?: DepsMode;
  root?: string;
  timeoutMs?: number;
}

/** A task is usable only if its hidden tests fail on the sealed base and pass once the reference is applied. */
export async function verifyTask(task: Task, opts: VerifyOptions): Promise<Task & { verifyLog?: string }> {
  const ws = await sealWorkspace(task, { sourceRepo: opts.sourceRepo, deps: opts.deps, root: opts.root });
  try {
    const audit = await auditSeal(ws.dir, task);
    if (!audit.ok) throw new Error(`seal audit failed for ${task.id}: ${audit.problems.join("; ")}`);
    const base = await scoreWorkspace(ws.dir, task, opts.timeoutMs);
    await writeInto(ws.dir, task.reference);
    for (const p of (task.meta["deletedSource"] ?? "").split(",").filter(Boolean)) await rm(join(ws.dir, ...p.split("/")), { force: true });
    const ref = await scoreWorkspace(ws.dir, task, opts.timeoutMs);
    return {
      ...task,
      verified: { baseFails: !base.pass, referencePasses: ref.pass, baseMs: base.ms, referenceMs: ref.ms },
      verifyLog: ref.pass ? undefined : ref.tail,
    };
  } finally {
    await ws.dispose();
  }
}

export function isUsable(t: Task): boolean {
  return !!t.verified && t.verified.baseFails && t.verified.referencePasses;
}

// ---------- splits & storage ----------

export function taskHash(id: string): number {
  return createHash("sha256").update(id).digest().readUInt32BE(0);
}

/**
 * Deterministic train / held-out split by hashed task id, so adding tasks never reshuffles existing
 * ones between splits. Proposals may be tuned on train; acceptance is decided on held-out only.
 */
export function splitTasks<T extends { id: string }>(tasks: T[], heldOutFraction = 0.5): { train: T[]; heldOut: T[] } {
  const sorted = [...tasks].sort((a, b) => taskHash(a.id) - taskHash(b.id));
  let nHeld = Math.round(sorted.length * heldOutFraction);
  if (sorted.length >= 2) nHeld = Math.min(Math.max(nHeld, 1), sorted.length - 1);
  return { heldOut: sorted.slice(0, nHeld), train: sorted.slice(nHeld) };
}

export async function saveTasks(dir: string, tasks: Task[]): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const t of tasks) await writeFile(join(dir, `${t.id}.json`), JSON.stringify(t, null, 2));
}

export async function loadTasks(dir: string): Promise<Task[]> {
  const out: Task[] = [];
  for (const f of (await readdir(dir)).filter((f) => f.endsWith(".json")).sort()) {
    out.push(JSON.parse(await readFile(join(dir, f), "utf8")) as Task);
  }
  return out;
}

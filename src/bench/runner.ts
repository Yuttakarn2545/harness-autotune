import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { showFile } from "../tasks/git-miner.js";
import { sealWorkspace, type DepsMode } from "../tasks/seal.js";
import type { FileContent, Task } from "../tasks/types.js";
import { scoreWorkspace, splitTasks } from "../tasks/verify.js";
import { applyCandidate, type Candidate } from "../propose/types.js";
import { totalTokens } from "../pricing.js";
import { isContaminated, type Agent, type AgentOptions } from "./agent.js";
import type { RunRecord } from "./stats.js";

export interface Variant {
  id: string;
  candidate?: Candidate;
}

export const BASELINE: Variant = { id: "baseline" };

/** Config files a candidate touches, resolved against the task's base snapshot. */
export async function variantFiles(variant: Variant, sourceRepo: string, task: Task): Promise<FileContent[]> {
  if (!variant.candidate) return [];
  const current = new Map<string, string>();
  for (const e of variant.candidate.edits) {
    const overlay = task.overlay.find((o) => o.path === e.file)?.content;
    const fromRepo = overlay ?? (await showFile(sourceRepo, task.baseCommit, e.file));
    if (fromRepo !== undefined) current.set(e.file, fromRepo);
  }
  return applyCandidate(current, variant.candidate);
}

export interface BenchOptions extends AgentOptions {
  sourceRepo: string;
  seeds: number;
  heldOutFraction: number;
  deps: DepsMode;
  resultsFile: string;
  workspaceRoot?: string;
  testTimeoutMs?: number;
  log?: (msg: string) => void;
}

export interface BenchPlan {
  runs: { variant: Variant; task: Task; seed: number; split: "train" | "heldout" }[];
  train: string[];
  heldOut: string[];
}

export function planBench(tasks: Task[], variants: Variant[], seeds: number, heldOutFraction: number): BenchPlan {
  const { train, heldOut } = splitTasks(tasks, heldOutFraction);
  const splitOf = new Map<string, "train" | "heldout">([...train.map((t) => [t.id, "train"] as const), ...heldOut.map((t) => [t.id, "heldout"] as const)]);
  const runs: BenchPlan["runs"] = [];
  // Interleave variants per (seed, task) so time-of-day drift and rate limits hit every arm equally.
  for (let seed = 0; seed < seeds; seed++) for (const task of tasks) for (const variant of variants) runs.push({ variant, task, seed, split: splitOf.get(task.id)! });
  return { runs, train: train.map((t) => t.id), heldOut: heldOut.map((t) => t.id) };
}

export async function loadRecords(file: string): Promise<RunRecord[]> {
  try {
    return (await readFile(file, "utf8"))
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as RunRecord);
  } catch {
    return [];
  }
}

const key = (v: string, t: string, s: number) => `${v}\u0000${t}\u0000${s}`;

/** Execute the plan, appending one JSON line per run. Re-running resumes where it left off. */
export async function runBench(plan: BenchPlan, agent: Agent, opts: BenchOptions): Promise<RunRecord[]> {
  const log = opts.log ?? (() => {});
  await mkdir(dirname(opts.resultsFile), { recursive: true });
  const existing = await loadRecords(opts.resultsFile);
  const done = new Set(existing.map((r) => key(r.variant, r.task, r.seed)));
  const out = [...existing];
  let i = 0;
  for (const { variant, task, seed, split } of plan.runs) {
    i++;
    if (done.has(key(variant.id, task.id, seed))) continue;
    let record: RunRecord;
    let ws;
    try {
      ws = await sealWorkspace(task, {
        sourceRepo: opts.sourceRepo,
        deps: opts.deps,
        root: opts.workspaceRoot,
        extraFiles: await variantFiles(variant, opts.sourceRepo, task),
      });
    } catch (e) {
      record = { variant: variant.id, task: task.id, seed, split, pass: false, costUsd: 0, tokens: 0, turns: 0, wallMs: 0, contaminated: false, error: `infra: ${(e as Error).message.slice(0, 200)}` };
      log(`[${i}/${plan.runs.length}] ${variant.id} × ${task.id} #${seed}: workspace setup failed: ${(e as Error).message}`);
      out.push(record);
      await appendFile(opts.resultsFile, JSON.stringify(record) + "\n");
      continue;
    }
    try {
      const a = await agent.run(ws.dir, task.instruction, opts, task);
      const score = await scoreWorkspace(ws.dir, task, opts.testTimeoutMs);
      record = {
        variant: variant.id,
        task: task.id,
        seed,
        split,
        pass: score.pass,
        costUsd: a.costUsd,
        tokens: totalTokens(a.tokens),
        turns: a.turns,
        wallMs: a.wallMs,
        contaminated: isContaminated(a.toolInputs, opts.sourceRepo),
        error: a.error,
      };
    } finally {
      await ws.dispose().catch(() => {});
    }
    log(
      `[${i}/${plan.runs.length}] ${variant.id} × ${task.id} #${seed}: ${record.pass ? "PASS" : "fail"} $${record.costUsd.toFixed(3)} ${record.turns} turns ${(record.wallMs / 1000).toFixed(0)}s${record.contaminated ? " CONTAMINATED" : ""}${record.error ? ` (${record.error})` : ""}`,
    );
    out.push(record);
    await appendFile(opts.resultsFile, JSON.stringify(record) + "\n");
  }
  return out;
}

export interface CostEstimate {
  runs: number;
  pending: number;
  perRunUsd: number;
  perRunSource: string;
  expectedUsd: number;
  worstCaseUsd: number;
}

/**
 * Cost before a live run. Expected = pending runs × mean measured cost (from earlier results) or the
 * caller's assumption; worst case = pending runs × the per-run budget cap passed to `claude`.
 */
export function estimateCost(plan: BenchPlan, existing: RunRecord[], maxBudgetUsd: number, assumedPerRunUsd: number): CostEstimate {
  const done = new Set(existing.map((r) => key(r.variant, r.task, r.seed)));
  const pending = plan.runs.filter((r) => !done.has(key(r.variant.id, r.task.id, r.seed))).length;
  const measured = existing.filter((r) => r.costUsd > 0);
  const perRun = measured.length ? measured.reduce((n, r) => n + r.costUsd, 0) / measured.length : assumedPerRunUsd;
  return {
    runs: plan.runs.length,
    pending,
    perRunUsd: perRun,
    perRunSource: measured.length ? `mean of ${measured.length} measured runs` : "assumption (no runs measured yet)",
    expectedUsd: pending * perRun,
    worstCaseUsd: pending * maxBudgetUsd,
  };
}

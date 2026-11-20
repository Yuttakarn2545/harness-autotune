/** Small, dependency-free statistics for comparing harness variants. */

export interface Interval {
  point: number;
  lo: number;
  hi: number;
}

/** Wilson score interval for a binomial proportion (95% by default). */
export function wilson(successes: number, n: number, z = 1.96): Interval {
  if (n === 0) return { point: NaN, lo: 0, hi: 1 };
  const p = successes / n;
  const denom = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { point: p, lo: Math.max(0, center - half), hi: Math.min(1, center + half) };
}

/** Deterministic PRNG so reported intervals are reproducible from the same results file. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (pos - lo);
}

/**
 * Cluster bootstrap over tasks: resample tasks with replacement (keeping each task's seeds together)
 * and recompute `stat`. Tasks are the unit of generalisation, so seeds are not treated as independent.
 */
export function bootstrapByTask<T>(
  groups: T[],
  stat: (sample: T[]) => number,
  opts: { iterations?: number; seed?: number; alpha?: number } = {},
): Interval {
  const point = stat(groups);
  if (groups.length < 2) return { point, lo: NaN, hi: NaN };
  const rand = mulberry32(opts.seed ?? 12345);
  const iters = opts.iterations ?? 4000;
  const alpha = opts.alpha ?? 0.05;
  const vals: number[] = [];
  for (let i = 0; i < iters; i++) {
    const sample: T[] = [];
    for (let j = 0; j < groups.length; j++) sample.push(groups[Math.floor(rand() * groups.length)]!);
    const v = stat(sample);
    if (Number.isFinite(v)) vals.push(v);
  }
  vals.sort((a, b) => a - b);
  return { point, lo: quantile(vals, alpha / 2), hi: quantile(vals, 1 - alpha / 2) };
}

export interface RunRecord {
  variant: string;
  task: string;
  seed: number;
  split: "train" | "heldout";
  pass: boolean;
  costUsd: number;
  tokens: number;
  turns: number;
  wallMs: number;
  contaminated: boolean;
  error?: string;
}

export interface ArmSummary {
  variant: string;
  split: string;
  runs: number;
  tasks: number;
  passes: number;
  passRate: Interval;
  costUsd: number;
  costPerSolved: number;
  meanTokens: number;
  meanTurns: number;
  meanWallSec: number;
  excluded: number;
}

export function usable(records: RunRecord[]): RunRecord[] {
  return records.filter((r) => !r.contaminated && r.error !== "infra");
}

export function summarizeArm(records: RunRecord[], variant: string, split: string): ArmSummary {
  const all = records.filter((r) => r.variant === variant && (split === "all" || r.split === split));
  const rs = usable(all);
  const passes = rs.filter((r) => r.pass).length;
  const cost = rs.reduce((n, r) => n + r.costUsd, 0);
  const mean = (f: (r: RunRecord) => number) => (rs.length ? rs.reduce((n, r) => n + f(r), 0) / rs.length : NaN);
  return {
    variant,
    split,
    runs: rs.length,
    tasks: new Set(rs.map((r) => r.task)).size,
    passes,
    passRate: wilson(passes, rs.length),
    costUsd: cost,
    costPerSolved: passes ? cost / passes : Infinity,
    meanTokens: mean((r) => r.tokens),
    meanTurns: mean((r) => r.turns),
    meanWallSec: mean((r) => r.wallMs / 1000),
    excluded: all.length - rs.length,
  };
}

interface PairedTask {
  task: string;
  base: RunRecord[];
  cand: RunRecord[];
}

function pairByTask(records: RunRecord[], baseline: string, candidate: string, split: string): PairedTask[] {
  const rs = usable(records).filter((r) => split === "all" || r.split === split);
  const tasks = [...new Set(rs.map((r) => r.task))].sort();
  return tasks
    .map((task) => ({
      task,
      base: rs.filter((r) => r.task === task && r.variant === baseline),
      cand: rs.filter((r) => r.task === task && r.variant === candidate),
    }))
    .filter((p) => p.base.length && p.cand.length);
}

const rate = (rs: RunRecord[]) => rs.filter((r) => r.pass).length / rs.length;
function costPerSolved(groups: PairedTask[], arm: "base" | "cand"): number {
  let cost = 0;
  let solved = 0;
  for (const g of groups) for (const r of g[arm]) {
    cost += r.costUsd;
    solved += r.pass ? 1 : 0;
  }
  return solved ? cost / solved : Infinity;
}

export type Verdict = "accept" | "reject" | "inconclusive";

export interface Comparison {
  baseline: string;
  candidate: string;
  split: string;
  tasks: number;
  /** Candidate pass rate minus baseline (mean of per-task differences). */
  passDelta: Interval;
  /** Candidate cost-per-solved divided by baseline's; < 1 is cheaper. */
  costRatio: Interval;
  verdict: Verdict;
  reason: string;
}

export interface DecisionRule {
  /** Largest pass-rate drop (CI lower bound) tolerated when accepting on cost alone. */
  nonInferiorityMargin: number;
  /** Fewer paired held-out tasks than this is always inconclusive: a bootstrap over 2–4 clusters is overconfident. */
  minTasks: number;
}

export const DEFAULT_RULE: DecisionRule = { nonInferiorityMargin: 0.05, minTasks: 5 };

/**
 * Acceptance rule (held-out split only):
 *  accept  if the pass-rate gain is significant (CI lower bound > 0), or
 *          if pass rate did not drop (point ≥ 0, CI lower bound ≥ −margin) AND cost per solved task is
 *          significantly lower (ratio CI upper bound < 1);
 *  reject  if pass rate significantly dropped (CI upper < 0), or it is significantly more expensive with
 *          no pass-rate gain;
 *  otherwise inconclusive — more tasks or seeds are needed. Small benchmarks will mostly land here; that
 *  is the honest answer, not a bug.
 */
export function compare(records: RunRecord[], baseline: string, candidate: string, split = "heldout", rule = DEFAULT_RULE): Comparison {
  const groups = pairByTask(records, baseline, candidate, split);
  const passDelta = bootstrapByTask(groups, (s) => s.reduce((n, g) => n + rate(g.cand) - rate(g.base), 0) / s.length);
  const costRatio = bootstrapByTask(groups, (s) => costPerSolved(s, "cand") / costPerSolved(s, "base"));
  const base = { baseline, candidate, split, tasks: groups.length, passDelta, costRatio };
  if (groups.length < rule.minTasks) return { ...base, verdict: "inconclusive", reason: `only ${groups.length} paired held-out task(s); need ≥ ${rule.minTasks}` };
  if (passDelta.lo > 0) return { ...base, verdict: "accept", reason: "pass rate rose (95% CI excludes 0)" };
  if (passDelta.hi < 0) return { ...base, verdict: "reject", reason: "pass rate dropped (95% CI excludes 0)" };
  if (passDelta.point >= 0 && passDelta.lo >= -rule.nonInferiorityMargin && costRatio.hi < 1) {
    return { ...base, verdict: "accept", reason: `pass rate held (CI ≥ −${rule.nonInferiorityMargin}) and cost per solved fell (CI < 1×)` };
  }
  if (passDelta.point <= 0 && costRatio.lo > 1) return { ...base, verdict: "reject", reason: "more expensive per solved task with no pass-rate gain" };
  return { ...base, verdict: "inconclusive", reason: "confidence intervals too wide — add tasks or seeds" };
}

import { compare, summarizeArm, type ArmSummary, type Comparison, type RunRecord } from "../bench/stats.js";
import type { Candidate } from "../propose/types.js";

export interface BenchReport {
  generatedAt: string;
  label: string;
  arms: ArmSummary[];
  comparisons: Comparison[];
  candidates: Candidate[];
  diffs: Record<string, string>;
  notes: string[];
}

export function buildBenchReport(records: RunRecord[], candidates: Candidate[], diffs: Record<string, string>, label: string): BenchReport {
  const variants = [...new Set(records.map((r) => r.variant))].sort((a, b) => (a === "baseline" ? -1 : b === "baseline" ? 1 : a.localeCompare(b)));
  const arms: ArmSummary[] = [];
  for (const split of ["train", "heldout"]) for (const v of variants) arms.push(summarizeArm(records, v, split));
  const comparisons = variants.filter((v) => v !== "baseline").map((v) => compare(records, "baseline", v, "heldout"));
  const contaminated = records.filter((r) => r.contaminated).length;
  const infra = records.filter((r) => r.error?.startsWith("infra")).length;
  return {
    generatedAt: new Date().toISOString(),
    label,
    arms,
    comparisons,
    candidates: candidates.filter((c) => variants.includes(c.id)),
    diffs,
    notes: [
      `${records.length} runs recorded; ${contaminated} excluded as contaminated (agent touched the source repo path), ${infra} excluded for infrastructure failures.`,
      "Pass = hidden tests exit 0 after the agent finishes. Cost = Claude Code's reported total_cost_usd (API list-price equivalent).",
      "Intervals: Wilson 95% for pass rate; 95% cluster bootstrap over tasks for deltas and cost ratios.",
    ],
  };
}

const pct = (x: number) => (Number.isFinite(x) ? `${(x * 100).toFixed(0)}%` : "–");
const money = (x: number) => (Number.isFinite(x) ? `$${x.toFixed(2)}` : "–");
const ci = (lo: number, hi: number, f: (x: number) => string) => (Number.isFinite(lo) && Number.isFinite(hi) ? `[${f(lo)}, ${f(hi)}]` : "");
const signedPct = (x: number) => (Number.isFinite(x) ? `${x >= 0 ? "+" : ""}${(x * 100).toFixed(0)} pp` : "–");
const ratio = (x: number) => (Number.isFinite(x) ? `${x.toFixed(2)}×` : "–");

export function benchMarkdown(r: BenchReport): string {
  const L: string[] = [];
  L.push(`### ${r.label}`, "");
  L.push("| Split | Variant | Runs | Pass rate (95% CI) | Cost / solved | Mean tokens | Mean turns | Mean wall |");
  L.push("|---|---|---:|---|---:|---:|---:|---:|");
  for (const a of r.arms) {
    if (!a.runs) continue;
    L.push(
      `| ${a.split} | ${a.variant} | ${a.runs} | ${pct(a.passRate.point)} ${ci(a.passRate.lo, a.passRate.hi, pct)} | ${money(a.costPerSolved)} | ${Number.isFinite(a.meanTokens) ? Math.round(a.meanTokens).toLocaleString("en-US") : "–"} | ${a.meanTurns.toFixed(1)} | ${a.meanWallSec.toFixed(0)}s |`,
    );
  }
  if (r.comparisons.length) {
    L.push("", "**Held-out decision (candidate vs baseline)**", "");
    L.push("| Candidate | Paired tasks | Δ pass rate (95% CI) | Cost-per-solved ratio (95% CI) | Verdict |");
    L.push("|---|---:|---|---|---|");
    for (const c of r.comparisons) {
      L.push(
        `| ${c.candidate} | ${c.tasks} | ${signedPct(c.passDelta.point)} ${ci(c.passDelta.lo, c.passDelta.hi, signedPct)} | ${ratio(c.costRatio.point)} ${ci(c.costRatio.lo, c.costRatio.hi, ratio)} | **${c.verdict}** — ${c.reason} |`,
      );
    }
  }
  for (const c of r.candidates) {
    L.push("", `<details><summary>${c.id}: ${c.title}</summary>`, "", c.rationale, "", "```diff", r.diffs[c.id] ?? "", "```", "</details>");
  }
  L.push("");
  for (const n of r.notes) L.push(`> ${n}`);
  return L.join("\n") + "\n";
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function benchHtml(r: BenchReport): string {
  const held = r.arms.filter((a) => a.split === "heldout" && a.runs);
  const bars = held
    .map((a, i) => {
      const y = 20 + i * 44;
      const w = Number.isFinite(a.passRate.point) ? a.passRate.point * 360 : 0;
      const lo = a.passRate.lo * 360;
      const hi = a.passRate.hi * 360;
      return `<text x="0" y="${y + 17}" class="lbl">${esc(a.variant)}</text>
<rect x="140" y="${y}" width="${w}" height="24" rx="3" class="${a.variant === "baseline" ? "base" : "cand"}"/>
<line x1="${140 + lo}" x2="${140 + hi}" y1="${y + 12}" y2="${y + 12}" class="ci"/>
<text x="${148 + Math.max(w, hi)}" y="${y + 17}" class="val">${pct(a.passRate.point)} · ${money(a.costPerSolved)}/solved</text>`;
    })
    .join("\n");
  const md = benchMarkdown(r);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Harness Autotune report</title>
<style>
:root{--bg:#fbfaf7;--fg:#1d1d1b;--muted:#6b6a65;--line:#e4e1d8;--base:#9a9890;--cand:#2f6f5e;--ci:#1d1d1b}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--fg:#ecebe6;--muted:#a3a198;--line:#33322e;--base:#6d6b64;--cand:#5fb39b;--ci:#ecebe6}}
body{background:var(--bg);color:var(--fg);font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;margin:0;padding:24px 16px;max-width:980px;margin:auto}
h1{font-size:22px;margin:0 0 4px}p.sub{color:var(--muted);margin:0 0 20px}
svg{width:100%;height:auto;max-width:720px}.lbl,.val{fill:var(--fg);font-size:13px}.base{fill:var(--base)}.cand{fill:var(--cand)}.ci{stroke:var(--ci);stroke-width:2}
pre{white-space:pre-wrap;background:transparent;border:1px solid var(--line);border-radius:6px;padding:12px;overflow-x:auto;font-size:12.5px}
</style></head><body>
<h1>Harness Autotune — ${esc(r.label)}</h1>
<p class="sub">Generated ${esc(r.generatedAt)} · held-out pass rate with 95% Wilson interval</p>
<svg viewBox="0 0 720 ${30 + held.length * 44}" role="img" aria-label="Held-out pass rate by variant">${bars}</svg>
<pre>${esc(md)}</pre>
</body></html>
`;
}

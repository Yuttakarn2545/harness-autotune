import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { addTotals, emptyTotals, totalTokens, type TokenTotals } from "../pricing.js";
import { CATEGORY_LABEL, DEFAULT_DETECTOR_OPTIONS, detectAll, type DetectorOptions, type Finding, type FrictionCategory } from "./detectors.js";
import { parseSessionFile, type Session } from "./parse.js";

export interface CategorySummary {
  category: FrictionCategory;
  label: string;
  findings: number;
  occurrences: number;
  sessions: number;
  usd: number;
  tokens: TokenTotals;
  /** Most frequent keys (command heads, file names) — what a config edit would target. */
  topKeys: { key: string; count: number; usd: number }[];
  examples: string[];
}

export interface FrictionReport {
  generatedAt: string;
  source: string;
  sessions: number;
  turns: number;
  toolCalls: number;
  usd: number;
  tokens: TokenTotals;
  unknownModels: string[];
  categories: CategorySummary[];
  /** Per-finding detail; already redacted. */
  findings: Finding[];
  notes: string[];
}

/** Claude Code stores transcripts under ~/.claude/projects/<cwd with separators replaced by '-'>. */
export function projectDirFor(cwd: string, claudeHome = join(homedir(), ".claude")): string {
  const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
  return join(claudeHome, "projects", slug);
}

export async function listTranscripts(dir: string, opts: { sinceDays?: number; limit?: number } = {}): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: { path: string; mtime: number }[] = [];
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".jsonl")) continue;
    const p = join(dir, e.name);
    const s = await stat(p);
    if (opts.sinceDays && Date.now() - s.mtimeMs > opts.sinceDays * 86_400_000) continue;
    files.push({ path: p, mtime: s.mtimeMs });
  }
  files.sort((a, b) => b.mtime - a.mtime);
  return files.slice(0, opts.limit ?? files.length).map((f) => f.path);
}

// ---------- redaction ----------

const SECRET_RE = /\b(sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\b/g;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// Windows (C:\...\x) and POSIX (/home/x/..., /Users/x/..., /c/Users/x/...) absolute paths → basename.
const WIN_PATH_RE = /\b[A-Za-z]:[\\/](?:[^\s"'`<>|:*?\\/]+[\\/])*([^\s"'`<>|:*?\\/]*)/g;
const POSIX_PATH_RE = /(?<![\w.])\/(?:home|Users|c\/Users|mnt|tmp|var|private)\/(?:[^\s"'`<>/]+\/)*([^\s"'`<>/]*)/g;

export function redact(text: string): string {
  return text
    .replace(SECRET_RE, "[secret]")
    .replace(EMAIL_RE, "[email]")
    .replace(WIN_PATH_RE, (_m, base: string) => `…/${base}`)
    .replace(POSIX_PATH_RE, (_m, base: string) => `…/${base}`);
}

// ---------- aggregation ----------

export function summarize(sessions: Session[], findingsBySession: Finding[][], source: string): FrictionReport {
  const findings = findingsBySession.flat().map((f) => ({ ...f, evidence: redact(f.evidence), key: redact(f.key), sessionId: f.sessionId.slice(0, 8) }));
  const categories: CategorySummary[] = [];
  for (const category of Object.keys(CATEGORY_LABEL) as FrictionCategory[]) {
    const fs = findings.filter((f) => f.category === category);
    const keys = new Map<string, { count: number; usd: number }>();
    for (const f of fs) {
      const k = keys.get(f.key) ?? { count: 0, usd: 0 };
      k.count += f.count;
      k.usd += f.usd;
      keys.set(f.key, k);
    }
    categories.push({
      category,
      label: CATEGORY_LABEL[category],
      findings: fs.length,
      occurrences: fs.reduce((n, f) => n + f.count, 0),
      sessions: new Set(fs.map((f) => f.sessionId)).size,
      usd: fs.reduce((n, f) => n + f.usd, 0),
      tokens: fs.reduce((t, f) => addTotals(t, f.tokens), emptyTotals()),
      topKeys: [...keys.entries()]
        .map(([key, v]) => ({ key, ...v }))
        .sort((a, b) => b.usd - a.usd || b.count - a.count)
        .slice(0, 8),
      examples: [...fs].sort((a, b) => b.usd - a.usd).slice(0, 5).map((f) => f.evidence),
    });
  }
  categories.sort((a, b) => b.usd - a.usd);
  const tokens = sessions.reduce((t, s) => addTotals(t, s.tokens), emptyTotals());
  return {
    generatedAt: new Date().toISOString(),
    source: redact(source),
    sessions: sessions.length,
    turns: sessions.reduce((n, s) => n + s.turns.length, 0),
    toolCalls: sessions.reduce((n, s) => n + s.turns.reduce((m, t) => m + t.toolCalls.length, 0), 0),
    usd: sessions.reduce((n, s) => n + s.usd, 0),
    tokens,
    unknownModels: [...new Set(sessions.flatMap((s) => s.unknownModels))],
    categories,
    findings,
    notes: [
      "Costs are API list-price equivalents computed from each response's usage block (deduplicated by message id). On a subscription plan this is not what you were billed.",
      "Categories can overlap (a token-heavy turn may also contain failing retries); do not sum category costs.",
      "Attributed cost is the friction itself (retries, redundant reads, the corrected turn), not the whole session.",
    ],
  };
}

export async function mineSessions(files: string[], opts: DetectorOptions = DEFAULT_DETECTOR_OPTIONS, source = ""): Promise<FrictionReport> {
  const sessions: Session[] = [];
  const findings: Finding[][] = [];
  for (const f of files) {
    const s = await parseSessionFile(f);
    if (!s.turns.length) continue;
    sessions.push(s);
    findings.push(detectAll(s, opts));
  }
  return summarize(sessions, findings, source);
}

const usd = (n: number) => `$${n.toFixed(2)}`;
const mtok = (n: number) => `${(n / 1e6).toFixed(2)}M`;

export function frictionMarkdown(r: FrictionReport): string {
  const lines: string[] = [];
  lines.push(`# Friction report`, "");
  lines.push(`${r.sessions} sessions · ${r.turns} human turns · ${r.toolCalls} tool calls · ${usd(r.usd)} API-equivalent · ${mtok(totalTokens(r.tokens))} tokens`, "");
  lines.push(`| Category | Findings | Occurrences | Sessions | Attributed cost | Tokens |`);
  lines.push(`|---|---:|---:|---:|---:|---:|`);
  for (const c of r.categories) {
    lines.push(`| ${c.label} | ${c.findings} | ${c.occurrences} | ${c.sessions} | ${usd(c.usd)} | ${mtok(totalTokens(c.tokens))} |`);
  }
  lines.push("");
  for (const c of r.categories) {
    if (!c.findings) continue;
    lines.push(`## ${c.label}`, "");
    if (c.topKeys.length > 1 || (c.topKeys[0] && !["correction", "unverified-done", "heavy"].includes(c.topKeys[0].key))) {
      lines.push(`Top keys: ${c.topKeys.map((k) => `\`${k.key}\` (${k.count}x, ${usd(k.usd)})`).join(", ")}`, "");
    }
    for (const e of c.examples) lines.push(`- ${e}`);
    lines.push("");
  }
  if (r.unknownModels.length) lines.push(`> Unknown models priced at Opus 5.5 rates: ${r.unknownModels.join(", ")}`, "");
  for (const n of r.notes) lines.push(`> ${n}`);
  return lines.join("\n") + "\n";
}

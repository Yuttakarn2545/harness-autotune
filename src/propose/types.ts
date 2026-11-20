import { z } from "zod";

export const EditSchema = z.object({
  /** Repo-relative path: CLAUDE.md, or .claude/skills/<name>/SKILL.md */
  file: z.string(),
  mode: z.enum(["append", "create"]),
  content: z.string(),
});

export const CandidateSchema = z.object({
  id: z.string(),
  title: z.string(),
  rationale: z.string(),
  /** Friction categories this edit targets. */
  targets: z.array(z.string()),
  edits: z.array(EditSchema),
});

export const ProposalSetSchema = z.object({ candidates: z.array(CandidateSchema) });

export type Edit = z.infer<typeof EditSchema>;
export type Candidate = z.infer<typeof CandidateSchema>;
export type ProposalSet = z.infer<typeof ProposalSetSchema>;

const ALLOWED_FILE = /^(CLAUDE\.md|\.claude\/skills\/[a-z0-9][a-z0-9-]{0,40}\/SKILL\.md)$/;

/** Keep proposals small and inside the harness surface; reject anything that edits code or settings. */
export function validateCandidate(c: Candidate, maxChars = 2500): string[] {
  const problems: string[] = [];
  if (!/^[a-z0-9][a-z0-9-]{0,40}$/.test(c.id)) problems.push(`bad id "${c.id}"`);
  if (!c.edits.length) problems.push("no edits");
  let total = 0;
  for (const e of c.edits) {
    if (!ALLOWED_FILE.test(e.file)) problems.push(`edit target not allowed: ${e.file}`);
    if (e.file === "CLAUDE.md" && e.mode === "create") problems.push("CLAUDE.md must be appended, not replaced");
    total += e.content.length;
  }
  if (total > maxChars) problems.push(`edits too large (${total} chars > ${maxChars})`);
  return problems;
}

/** Apply a candidate's edits to the current config files of a repo snapshot. */
export function applyCandidate(current: Map<string, string>, c: Candidate): { path: string; content: string }[] {
  const out = new Map<string, string>();
  for (const e of c.edits) {
    const before = out.get(e.file) ?? current.get(e.file) ?? "";
    const content = e.mode === "create" ? e.content : `${before.replace(/\s*$/, "")}${before.trim() ? "\n\n" : ""}${e.content.trim()}\n`;
    out.set(e.file, content);
  }
  return [...out.entries()].map(([path, content]) => ({ path, content }));
}

/** Unified-diff-ish rendering for reports and PR bodies. */
export function renderDiff(current: Map<string, string>, c: Candidate): string {
  const parts: string[] = [];
  for (const f of applyCandidate(current, c)) {
    const before = current.get(f.path) ?? "";
    const added = f.content.startsWith(before.replace(/\s*$/, "")) ? f.content.slice(before.replace(/\s*$/, "").length) : f.content;
    parts.push(`--- a/${f.path}\n+++ b/${f.path}\n` + added.replace(/^\n+/, "").split("\n").filter((l, i, a) => i < a.length - 1 || l).map((l) => `+${l}`).join("\n"));
  }
  return parts.join("\n");
}

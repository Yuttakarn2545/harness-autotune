import { addTotals, emptyTotals, type TokenTotals } from "../pricing.js";
import type { AssistantMessage, Session, ToolCall, Turn } from "./parse.js";

export type FrictionCategory =
  | "repeated-failing-command"
  | "repeated-read"
  | "user-correction"
  | "unverified-done"
  | "token-heavy-turn";

export const CATEGORY_LABEL: Record<FrictionCategory, string> = {
  "repeated-failing-command": "Same command failed repeatedly",
  "repeated-read": "Same file re-read without changes",
  "user-correction": "User had to correct the agent",
  "unverified-done": "Claimed done without running tests",
  "token-heavy-turn": "Token-heavy turn",
};

export interface Finding {
  category: FrictionCategory;
  sessionId: string;
  turnIndex: number;
  /** Short human-readable evidence. Redacted again before it leaves the machine. */
  evidence: string;
  /** Normalised key used to group the same problem across sessions (command head, file basename…). */
  key: string;
  count: number;
  /** Cost attributed to this friction (the retries / the wasted turn), not the whole session. */
  usd: number;
  tokens: TokenTotals;
}

export interface DetectorOptions {
  /** A command must fail at least this many times in one session to count. */
  minCommandFailures: number;
  /** A file must be read at least this many times between edits to count. */
  minReads: number;
  /** A turn is token-heavy if its cost is at least this multiple of the session's median turn… */
  heavyTurnMultiple: number;
  /** …and at least this many USD. */
  heavyTurnMinUsd: number;
}

export const DEFAULT_DETECTOR_OPTIONS: DetectorOptions = {
  minCommandFailures: 2,
  minReads: 3,
  heavyTurnMultiple: 5,
  heavyTurnMinUsd: 1,
};

// ---------- helpers ----------

function messageCost(turn: Turn, ids: Set<number>): { usd: number; tokens: TokenTotals } {
  // messageIndex is session-global; map to messages in this turn by tool call ownership.
  let usd = 0;
  let tokens = emptyTotals();
  const seen = new Set<AssistantMessage>();
  for (const call of turn.toolCalls) {
    if (!ids.has(call.messageIndex)) continue;
    const msg = turn.messages.find((m) => m.toolUseIds.includes(call.id));
    if (msg && !seen.has(msg)) {
      seen.add(msg);
      usd += msg.usd;
      tokens = addTotals(tokens, msg.tokens);
    }
  }
  return { usd, tokens };
}

/** Collapse a shell command to a stable "what was run" key: first two words of the last pipeline stage-ish. */
export function commandKey(cmd: string): string {
  const firstLine = cmd.trim().split(/\r?\n/)[0] ?? "";
  // Drop leading `cd X &&` / env assignments, which vary run to run.
  const stripped = firstLine
    .replace(/^(cd\s+("[^"]*"|'[^']*'|\S+)\s*(&&|;)\s*)+/, "")
    .replace(/^(\w+=\S+\s+)+/, "");
  const words = stripped.split(/\s+/).filter(Boolean);
  const head = words[0] ?? "";
  const runners = new Set(["npm", "npx", "pnpm", "yarn", "bun", "go", "cargo", "python", "python3", "node", "git", "dotnet", "make", "uv", "pip"]);
  const take = runners.has(head) ? (["run", "exec", "x"].includes(words[1] ?? "") ? 3 : 2) : 1;
  return words.slice(0, take).join(" ").slice(0, 60);
}

function isEditTool(name: string): boolean {
  return name === "Edit" || name === "Write" || name === "MultiEdit" || name === "NotebookEdit";
}

function filePathOf(call: ToolCall): string | undefined {
  const p = call.input["file_path"] ?? call.input["notebook_path"] ?? call.input["path"];
  return typeof p === "string" ? p.replace(/\\/g, "/").toLowerCase() : undefined;
}

const VERIFY_RE =
  /\b(test|tests|vitest|jest|pytest|mocha|check|typecheck|tsc|lint|eslint|build|go\s+test|go\s+vet|cargo\s+(test|check|build)|dotnet\s+test|make)\b/i;

export function isVerificationCommand(cmd: string): boolean {
  return VERIFY_RE.test(cmd);
}

const DONE_RE =
  /(\b(done|fixed|implemented|complete[d]?|all set|works now|should work now|ready to (use|go)|all tests pass(ing)?)\b|เสร็จ(แล้ว|เรียบร้อย)?|เรียบร้อย(แล้ว)?|ทำให้แล้ว|แก้(ให้)?แล้ว|ใช้ได้แล้ว)/i;

// English corrections are anchored to the start of the message; Thai ones are specific phrases.
const CORRECTION_RE_EN =
  /^\s*(no[,.! ]|nope\b|wrong\b|stop\b|that'?s (not|wrong)|this is (not|wrong)|not what i|i (said|told you|asked)|i meant\b|don'?t\b|why did you|you (broke|forgot|didn'?t|missed)|undo\b|revert\b|still (broken|not|wrong|fail))/i;
const CORRECTION_RE_TH =
  /(ไม่ใช่(?!แค่|เพียง|ว่า)|ผิดแล้ว|บอกแล้ว(ว่า)?|บอกไปแล้ว|ไม่ได้บอกให้|ไม่ได้สั่ง|ไม่เอาแบบนี้|ทำไมไม่|ทำไมถึง|ยังไม่ได้|ยังไม่หาย|ยังพัง|แก้ใหม่|ทำใหม่|ย้อนกลับ|อย่าทำ)/;

export function isCorrection(text: string): boolean {
  const t = text.trim();
  if (!t || t.startsWith("<")) return false;
  return CORRECTION_RE_EN.test(t) || CORRECTION_RE_TH.test(t);
}

export function claimsDone(text: string): boolean {
  return DONE_RE.test(text);
}

function bashCommand(call: ToolCall): string | undefined {
  if (call.name !== "Bash" && call.name !== "PowerShell") return undefined;
  const c = call.input["command"];
  return typeof c === "string" ? c : undefined;
}

function median(xs: number[]): number {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

// ---------- detectors ----------

export function detectRepeatedFailingCommands(session: Session, opts: DetectorOptions): Finding[] {
  const groups = new Map<string, { turn: Turn; calls: ToolCall[] }[]>();
  for (const turn of session.turns) {
    for (const call of turn.toolCalls) {
      const cmd = bashCommand(call);
      if (!cmd || !call.isError) continue;
      const key = commandKey(cmd);
      if (!key) continue;
      const list = groups.get(key) ?? [];
      const slot = list.find((g) => g.turn === turn);
      if (slot) slot.calls.push(call);
      else list.push({ turn, calls: [call] });
      groups.set(key, list);
    }
  }
  const out: Finding[] = [];
  for (const [key, list] of groups) {
    const count = list.reduce((n, g) => n + g.calls.length, 0);
    if (count < opts.minCommandFailures) continue;
    let usd = 0;
    let tokens = emptyTotals();
    let first = true;
    for (const g of list) {
      // The first failure is information; every repeat after it is the friction.
      const retryIdx = new Set(g.calls.slice(first ? 1 : 0).map((c) => c.messageIndex));
      first = false;
      const c = messageCost(g.turn, retryIdx);
      usd += c.usd;
      tokens = addTotals(tokens, c.tokens);
    }
    const sample = list[0]!.calls[0]!;
    out.push({
      category: "repeated-failing-command",
      sessionId: session.id,
      turnIndex: list[0]!.turn.index,
      key,
      count,
      evidence: `\`${key}\` failed ${count}x — e.g. ${firstLine(sample.output)}`,
      usd,
      tokens,
    });
  }
  return out;
}

export function detectRepeatedReads(session: Session, opts: DetectorOptions): Finding[] {
  const reads = new Map<string, { turn: Turn; call: ToolCall }[]>();
  const out: Finding[] = [];
  const flush = (path: string) => {
    const list = reads.get(path);
    reads.delete(path);
    if (!list || list.length < opts.minReads) return;
    let usd = 0;
    let tokens = emptyTotals();
    for (const { turn, call } of list.slice(1)) {
      const c = messageCost(turn, new Set([call.messageIndex]));
      usd += c.usd;
      tokens = addTotals(tokens, c.tokens);
    }
    const base = path.split("/").pop() ?? path;
    out.push({
      category: "repeated-read",
      sessionId: session.id,
      turnIndex: list[0]!.turn.index,
      key: base,
      count: list.length,
      evidence: `read \`${base}\` ${list.length}x with no edit in between`,
      usd,
      tokens,
    });
  };
  for (const turn of session.turns) {
    for (const call of turn.toolCalls) {
      const p = filePathOf(call);
      if (!p) continue;
      if (call.name === "Read") {
        // Images/media are usually render outputs re-inspected after a script regenerates them.
        if (MEDIA_EXT.test(p)) continue;
        const list = reads.get(p) ?? [];
        list.push({ turn, call });
        reads.set(p, list);
      } else if (isEditTool(call.name)) {
        flush(p);
      }
    }
  }
  for (const p of [...reads.keys()]) flush(p);
  return out;
}

export function detectUserCorrections(session: Session): Finding[] {
  const out: Finding[] = [];
  for (let i = 1; i < session.turns.length; i++) {
    const turn = session.turns[i]!;
    if (!isCorrection(turn.userText)) continue;
    const prev = session.turns[i - 1]!;
    out.push({
      category: "user-correction",
      sessionId: session.id,
      turnIndex: turn.index,
      key: "correction",
      count: 1,
      evidence: `user: "${truncate(turn.userText, 80)}"`,
      // The turn being corrected is what was (at least partly) wasted.
      usd: prev.usd,
      tokens: prev.tokens,
    });
  }
  return out;
}

export function detectUnverifiedDone(session: Session): Finding[] {
  const out: Finding[] = [];
  for (const turn of session.turns) {
    const lastEdit = findLastIndex(turn.toolCalls, (c) => isEditTool(c.name) && isCodePath(filePathOf(c)));
    if (lastEdit < 0) continue;
    const verifiedAfter = turn.toolCalls.slice(lastEdit + 1).some((c) => {
      const cmd = bashCommand(c);
      return cmd !== undefined && isVerificationCommand(cmd);
    });
    if (verifiedAfter) continue;
    const finalText = turn.messages.at(-1)?.text ?? "";
    if (!claimsDone(finalText)) continue;
    out.push({
      category: "unverified-done",
      sessionId: session.id,
      turnIndex: turn.index,
      key: "unverified-done",
      count: 1,
      evidence: `edited code then said "${truncate(firstLine(finalText.match(DONE_RE)?.input ?? finalText), 70)}" with no test/build run after the last edit`,
      usd: turn.usd,
      tokens: turn.tokens,
    });
  }
  return out;
}

export function detectTokenHeavyTurns(session: Session, opts: DetectorOptions): Finding[] {
  const costs = session.turns.map((t) => t.usd);
  const med = median(costs);
  const out: Finding[] = [];
  for (const turn of session.turns) {
    if (turn.usd < opts.heavyTurnMinUsd || turn.usd < med * opts.heavyTurnMultiple) continue;
    const bigOutputs = turn.toolCalls.filter((c) => c.outputChars > 20_000).length;
    out.push({
      category: "token-heavy-turn",
      sessionId: session.id,
      turnIndex: turn.index,
      key: "heavy",
      count: 1,
      evidence: `turn cost $${turn.usd.toFixed(2)} (${(turn.usd / Math.max(med, 1e-9)).toFixed(0)}x session median), ${turn.toolCalls.length} tool calls${bigOutputs ? `, ${bigOutputs} tool outputs >20k chars` : ""}`,
      usd: Math.max(0, turn.usd - med),
      tokens: turn.tokens,
    });
  }
  return out;
}

export function detectAll(session: Session, opts: DetectorOptions = DEFAULT_DETECTOR_OPTIONS): Finding[] {
  return [
    ...detectRepeatedFailingCommands(session, opts),
    ...detectRepeatedReads(session, opts),
    ...detectUserCorrections(session),
    ...detectUnverifiedDone(session),
    ...detectTokenHeavyTurns(session, opts),
  ];
}

// ---------- small utils ----------

const MEDIA_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|mp4|webm|mov|wav|mp3|pdf)$/i;
const CODE_EXT = /\.(ts|tsx|js|jsx|mjs|cjs|vue|svelte|go|rs|py|java|kt|cs|rb|php|swift|c|cc|cpp|h|hpp|sql)$/i;
function isCodePath(p: string | undefined): boolean {
  return !!p && CODE_EXT.test(p) && !/\/(memory|\.claude)\//.test(p);
}

function findLastIndex<T>(xs: T[], pred: (x: T) => boolean): number {
  for (let i = xs.length - 1; i >= 0; i--) if (pred(xs[i]!)) return i;
  return -1;
}

export function truncate(s: string, n: number): string {
  const one = s.replace(/\s+/g, " ").trim();
  return one.length > n ? one.slice(0, n - 1) + "…" : one;
}

function firstLine(s: string): string {
  const lines = s.split(/\r?\n/).filter((l) => l.trim());
  return truncate(lines.find((l) => !/^\s*exit code \d+\s*$/i.test(l)) ?? lines[0] ?? "", 100);
}

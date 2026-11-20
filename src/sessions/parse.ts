import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { addTotals, emptyTotals, usageCost, type TokenTotals, type Usage } from "../pricing.js";

/** One tool invocation the agent made, joined with its result. */
export interface ToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  isError: boolean;
  /** First characters of the tool output (kept short; reports redact further). */
  output: string;
  outputChars: number;
  /** Index of the assistant message that issued the call, within the session. */
  messageIndex: number;
}

export interface AssistantMessage {
  id: string;
  model: string | undefined;
  text: string;
  toolUseIds: string[];
  tokens: TokenTotals;
  usd: number;
  pricedKnown: boolean;
}

/** A human prompt and everything the agent did until the next human prompt. */
export interface Turn {
  index: number;
  userText: string;
  timestamp: string | undefined;
  messages: AssistantMessage[];
  toolCalls: ToolCall[];
  tokens: TokenTotals;
  usd: number;
}

export interface Session {
  id: string;
  file: string;
  cwd: string | undefined;
  turns: Turn[];
  tokens: TokenTotals;
  usd: number;
  /** Lines that failed to parse — transcripts are append-only logs and can be truncated mid-write. */
  badLines: number;
  unknownModels: string[];
}

interface RawLine {
  type?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  isCompactSummary?: boolean;
  cwd?: string;
  sessionId?: string;
  timestamp?: string;
  origin?: { kind?: string };
  message?: {
    id?: string;
    model?: string;
    role?: string;
    content?: unknown;
    usage?: Usage;
  };
}

interface ContentBlock {
  type?: string;
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  is_error?: boolean;
  content?: unknown;
}

const OUTPUT_KEEP = 600;

function blockText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: ContentBlock) => (b && typeof b === "object" && b.type === "text" ? (b.text ?? "") : ""))
      .join("\n");
  }
  return "";
}

/**
 * Is this user line a real human prompt (vs. tool results, hook/system injections, task notifications)?
 * Newer Claude Code versions stamp `origin.kind`; older ones do not, so fall back to content heuristics.
 */
export function isHumanPrompt(line: RawLine): boolean {
  if (line.type !== "user" || line.isMeta || line.isSidechain || line.isCompactSummary) return false;
  const kind = line.origin?.kind;
  if (kind && kind !== "human") return false;
  const content = line.message?.content;
  if (Array.isArray(content) && content.some((b: ContentBlock) => b?.type === "tool_result")) return false;
  const text = blockText(content).trim();
  if (!text) return false;
  if (!kind && /^<(command-|local-command|task-notification|system-reminder|bash-)/.test(text)) return false;
  return true;
}

export async function parseSessionFile(file: string): Promise<Session> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  const lines: RawLine[] = [];
  let badLines = 0;
  for await (const raw of rl) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as RawLine);
    } catch {
      badLines++;
    }
  }
  return buildSession(lines, file, badLines);
}

export function parseSessionText(text: string, file = "<memory>"): Session {
  const lines: RawLine[] = [];
  let badLines = 0;
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    try {
      lines.push(JSON.parse(raw) as RawLine);
    } catch {
      badLines++;
    }
  }
  return buildSession(lines, file, badLines);
}

function buildSession(lines: RawLine[], file: string, badLines: number): Session {
  const turns: Turn[] = [];
  const results = new Map<string, { isError: boolean; output: string; chars: number }>();
  const unknownModels = new Set<string>();
  let cwd: string | undefined;
  let sessionId: string | undefined;

  // Pass 1: collect tool results keyed by tool_use_id.
  for (const line of lines) {
    if (line.type !== "user" || !Array.isArray(line.message?.content)) continue;
    for (const b of line.message!.content as ContentBlock[]) {
      if (b?.type !== "tool_result" || !b.tool_use_id) continue;
      const out = typeof b.content === "string" ? b.content : blockText(b.content);
      results.set(b.tool_use_id, { isError: !!b.is_error, output: out.slice(0, OUTPUT_KEEP), chars: out.length });
    }
  }

  // Pass 2: walk the main thread. Claude Code writes one line per content block, all sharing message.id,
  // each repeating the same usage — so usage must be counted once per message id.
  let current: Turn | undefined;
  const msgById = new Map<string, AssistantMessage>();
  let messageCounter = 0;
  for (const line of lines) {
    cwd ??= line.cwd;
    sessionId ??= line.sessionId;
    if (line.isSidechain) continue;
    if (isHumanPrompt(line)) {
      current = {
        index: turns.length,
        userText: blockText(line.message?.content).trim(),
        timestamp: line.timestamp,
        messages: [],
        toolCalls: [],
        tokens: emptyTotals(),
        usd: 0,
      };
      turns.push(current);
      continue;
    }
    if (line.type !== "assistant" || !line.message) continue;
    if (!current) {
      current = { index: 0, userText: "", timestamp: line.timestamp, messages: [], toolCalls: [], tokens: emptyTotals(), usd: 0 };
      turns.push(current);
    }
    const id = line.message.id ?? `anon-${messageCounter}`;
    let msg = msgById.get(id);
    if (!msg) {
      const cost = usageCost(line.message.usage ?? {}, line.message.model);
      if (!cost.known && line.message.model && line.message.model !== "<synthetic>") unknownModels.add(line.message.model);
      msg = { id, model: line.message.model, text: "", toolUseIds: [], tokens: cost.tokens, usd: cost.usd, pricedKnown: cost.known };
      msgById.set(id, msg);
      current.messages.push(msg);
      current.tokens = addTotals(current.tokens, cost.tokens);
      current.usd += cost.usd;
      messageCounter++;
    }
    const blocks = Array.isArray(line.message.content) ? (line.message.content as ContentBlock[]) : [];
    for (const b of blocks) {
      if (b?.type === "text" && b.text) msg.text += (msg.text ? "\n" : "") + b.text;
      if (b?.type === "tool_use" && b.id && !msg.toolUseIds.includes(b.id)) {
        msg.toolUseIds.push(b.id);
        const r = results.get(b.id);
        current.toolCalls.push({
          id: b.id,
          name: b.name ?? "?",
          input: b.input ?? {},
          isError: r?.isError ?? false,
          output: r?.output ?? "",
          outputChars: r?.chars ?? 0,
          messageIndex: messageCounter - 1,
        });
      }
    }
  }

  let tokens = emptyTotals();
  let usd = 0;
  for (const t of turns) {
    tokens = addTotals(tokens, t.tokens);
    usd += t.usd;
  }
  return { id: sessionId ?? file, file, cwd, turns, tokens, usd, badLines, unknownModels: [...unknownModels] };
}

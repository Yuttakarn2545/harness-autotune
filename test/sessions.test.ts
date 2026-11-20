import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { usageCost } from "../src/pricing.js";
import { parseSessionText } from "../src/sessions/parse.js";
import { commandKey, detectAll, isCorrection, claimsDone, isVerificationCommand } from "../src/sessions/detectors.js";
import { frictionMarkdown, listTranscripts, mineSessions, projectDirFor, redact } from "../src/sessions/report.js";
import { frictionTranscript, transcript } from "./helpers.js";

describe("pricing", () => {
  it("prices cache tiers relative to input", () => {
    const c = usageCost(
      { input_tokens: 1_000_000, output_tokens: 1_000_000, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 2_000_000, cache_creation: { ephemeral_5m_input_tokens: 1_000_000, ephemeral_1h_input_tokens: 1_000_000 } },
      "claude-opus-5-5",
    );
    // 4 + 20 + 0.4 + 5 + 8
    expect(c.usd).toBeCloseTo(37.4, 6);
    expect(c.known).toBe(true);
  });
  it("flags unknown models", () => {
    expect(usageCost({ input_tokens: 1 }, "mystery-model").known).toBe(false);
    expect(usageCost({ input_tokens: 1 }, "claude-sonnet-4-6[1m]").known).toBe(true);
  });
});

describe("parse", () => {
  it("counts usage once per message id even when split across lines", () => {
    const t = transcript();
    t.human("hi");
    t.assistant({ text: "a", tools: [{ name: "Read", input: { file_path: "x" } }, { name: "Read", input: { file_path: "y" } }], usage: { input_tokens: 1_000_000, output_tokens: 0 } });
    const s = parseSessionText(t.jsonl());
    expect(s.turns).toHaveLength(1);
    expect(s.turns[0]!.messages).toHaveLength(1);
    expect(s.turns[0]!.toolCalls).toHaveLength(2);
    expect(s.usd).toBeCloseTo(4, 6);
  });
  it("ignores tool results, meta lines, task notifications and bad lines as prompts", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { content: "real prompt" } }),
      JSON.stringify({ type: "user", isMeta: true, message: { content: "meta" } }),
      JSON.stringify({ type: "user", origin: { kind: "task-notification" }, message: { content: "<task-notification>x" } }),
      JSON.stringify({ type: "user", message: { content: "<command-name>/clear</command-name>" } }),
      "{not json",
    ].join("\n");
    const s = parseSessionText(lines);
    expect(s.turns.map((t) => t.userText)).toEqual(["real prompt"]);
    expect(s.badLines).toBe(1);
  });
});

describe("detectors", () => {
  const session = parseSessionText(frictionTranscript());
  const findings = detectAll(session);
  const by = (c: string) => findings.filter((f) => f.category === c);

  it("finds repeated failing commands grouped by command head", () => {
    const f = by("repeated-failing-command");
    expect(f).toHaveLength(1);
    expect(f[0]!.key).toBe("npm run build");
    expect(f[0]!.count).toBe(3);
    expect(f[0]!.usd).toBeGreaterThan(0);
  });
  it("finds re-reads of an unchanged file, normalising path separators", () => {
    const f = by("repeated-read");
    expect(f).toHaveLength(1);
    expect(f[0]!.count).toBe(3);
    expect(f[0]!.key).toBe("util.ts");
  });
  it("does not count re-viewing rendered images as redundant reads", () => {
    const t = transcript();
    t.human("render it");
    for (let i = 0; i < 4; i++) t.assistant({ tools: [{ name: "Read", input: { file_path: "out/frame.png" } }] });
    expect(detectAll(parseSessionText(t.jsonl())).filter((f) => f.category === "repeated-read")).toEqual([]);
  });
  it("finds user corrections and charges the corrected turn", () => {
    const f = by("user-correction");
    expect(f).toHaveLength(1);
    expect(f[0]!.usd).toBeCloseTo(session.turns[0]!.usd, 9);
  });
  it("flags done-claims without a test run, but not when tests ran after the last edit", () => {
    const f = by("unverified-done");
    expect(f.map((x) => x.turnIndex)).toEqual([0]);
  });
  it("flags the token-heavy turn", () => {
    const f = by("token-heavy-turn");
    expect(f.map((x) => x.turnIndex)).toEqual([2]);
  });
  it("classifies text", () => {
    expect(commandKey("cd /x && npm run build -- --watch")).toBe("npm run build");
    expect(commandKey("FOO=1 pytest -q")).toBe("pytest");
    expect(isCorrection("No, use the other file")).toBe(true);
    expect(isCorrection("ไม่ใช่แบบนี้ ทำใหม่")).toBe(true);
    expect(isCorrection("Now add a README")).toBe(false);
    expect(isCorrection("ทำต่อเลย EP2")).toBe(false);
    expect(isCorrection("ต้องปรับแต่งได้ ไม่ใช่แค่เจนไปเฉยๆ")).toBe(false);
    expect(claimsDone("เสร็จแล้วครับ")).toBe(true);
    expect(isVerificationCommand("npx vitest run")).toBe(true);
    expect(isVerificationCommand("ls -la")).toBe(false);
  });
});

describe("report", () => {
  it("redacts paths, emails and secrets", () => {
    const s = redact("read C:\\Users\\alice\\proj\\a.ts and /home/bob/x/y.py, mail bob@example.com key sk-ant-abcdefghijklmnop");
    expect(s).not.toMatch(/alice|bob@|abcdefghij/);
    expect(s).toContain("…/a.ts");
    expect(s).toContain("…/y.py");
  });
  it("aggregates a directory of transcripts into json + markdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "autotune-tx-"));
    writeFileSync(join(dir, "a.jsonl"), frictionTranscript());
    writeFileSync(join(dir, "empty.jsonl"), "");
    const files = await listTranscripts(dir);
    const r = await mineSessions(files, undefined, dir);
    expect(r.sessions).toBe(1);
    const cats = Object.fromEntries(r.categories.map((c) => [c.category, c.findings]));
    expect(cats).toMatchObject({ "repeated-failing-command": 1, "repeated-read": 1, "user-correction": 1, "unverified-done": 1, "token-heavy-turn": 1 });
    const md = frictionMarkdown(r);
    expect(md).toContain("| Same command failed repeatedly |");
    expect(JSON.stringify(r)).not.toContain("C:\\\\Work");
  });
  it("maps a cwd to Claude Code's project folder name", () => {
    expect(projectDirFor("C:\\Dev\\katun", "/h")).toMatch(/projects[\\/]C--Dev-katun$/);
  });
});

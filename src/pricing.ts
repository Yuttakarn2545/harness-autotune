/**
 * Per-model list prices in USD per million tokens (Anthropic first-party API).
 * Cache writes: 5-minute TTL = 1.25x input, 1-hour TTL = 2x input. Cache reads = 0.1x input.
 * Source: Claude API model table (cached 2026-11-03). Unknown models fall back to Opus 5.5 pricing
 * and are flagged so reports never present a guess as a measurement.
 */
export interface ModelPrice {
  input: number;
  output: number;
}

export const PRICES: Record<string, ModelPrice> = {
  "claude-fable-5-2": { input: 8, output: 40 },
  "claude-fable-5-1": { input: 10, output: 50 },
  "claude-fable-5": { input: 10, output: 50 },
  "claude-opus-5-5": { input: 4, output: 20 },
  "claude-opus-5": { input: 5, output: 25 },
  "claude-opus-4-8": { input: 5, output: 25 },
  "claude-opus-4-7": { input: 5, output: 25 },
  "claude-opus-4-6": { input: 5, output: 25 },
  "claude-sonnet-5-5": { input: 2, output: 10 },
  "claude-sonnet-5": { input: 2, output: 10 },
  "claude-sonnet-4-6": { input: 3, output: 15 },
  "claude-haiku-5-5": { input: 0.1, output: 0.5 },
  "claude-haiku-4-5": { input: 1, output: 5 },
};

export const FALLBACK_MODEL = "claude-opus-5-5";

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_creation?: { ephemeral_5m_input_tokens?: number; ephemeral_1h_input_tokens?: number };
}

export interface TokenTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export function emptyTotals(): TokenTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
  };
}

export function totalTokens(t: TokenTotals): number {
  return t.input + t.output + t.cacheRead + t.cacheWrite;
}

export function priceFor(model: string | undefined): { price: ModelPrice; known: boolean } {
  const base = (model ?? "").replace(/\[.*\]$/, "").replace(/-\d{8}$/, "");
  const hit = PRICES[base];
  if (hit) return { price: hit, known: true };
  return { price: PRICES[FALLBACK_MODEL]!, known: false };
}

/** USD cost of one API response's usage block. */
export function usageCost(usage: Usage, model: string | undefined): { usd: number; tokens: TokenTotals; known: boolean } {
  const { price, known } = priceFor(model);
  const input = usage.input_tokens ?? 0;
  const output = usage.output_tokens ?? 0;
  const cacheRead = usage.cache_read_input_tokens ?? 0;
  const cacheWrite = usage.cache_creation_input_tokens ?? 0;
  const w1h = usage.cache_creation?.ephemeral_1h_input_tokens ?? 0;
  const w5m = usage.cache_creation ? (usage.cache_creation.ephemeral_5m_input_tokens ?? 0) : cacheWrite;
  const perTok = (n: number, rate: number) => (n * rate) / 1_000_000;
  const usd =
    perTok(input, price.input) +
    perTok(output, price.output) +
    perTok(cacheRead, price.input * 0.1) +
    perTok(w5m, price.input * 1.25) +
    perTok(w1h, price.input * 2);
  return { usd, tokens: { input, output, cacheRead, cacheWrite }, known };
}

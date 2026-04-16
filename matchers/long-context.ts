// ABOUTME: Detects requests with large estimated token counts
// ABOUTME: Uses ~4 chars/token heuristic, threshold via LONG_CONTEXT_THRESHOLD env (default 60000)

import type { MatchContext } from '../src/matcher.js';
import { extractText } from './_util.js';

const DEFAULT_THRESHOLD = 60_000;

const THRESHOLD = (() => {
  const env = process.env.LONG_CONTEXT_THRESHOLD;
  if (env) {
    const parsed = Number(env);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_THRESHOLD;
})();

function estimateTokens(ctx: MatchContext): number {
  const messages = ctx.body.messages;
  if (!Array.isArray(messages)) return 0;

  let totalChars = 0;
  for (const msg of messages) {
    if (msg !== null && typeof msg === 'object' && 'content' in (msg as Record<string, unknown>)) {
      totalChars += extractText((msg as Record<string, unknown>).content).length;
    }
  }

  return Math.ceil(totalChars / 4);
}

export default function isLongContext(ctx: MatchContext): boolean {
  return estimateTokens(ctx) > THRESHOLD;
}

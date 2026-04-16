// ABOUTME: Detects extended thinking / reasoning mode requests
// ABOUTME: Matches when body.thinking is present (Anthropic: object with budget_tokens, OpenAI: boolean true)

import type { MatchContext } from '../src/matcher.js';

export default function isThink(ctx: MatchContext): boolean {
  const thinking = ctx.body.thinking;
  if (!thinking) return false;

  if (ctx.wireFormat === 'anthropic') {
    // Anthropic sends { type: "enabled", budget_tokens: N }
    return typeof thinking === 'object' && !Array.isArray(thinking);
  }

  // OpenAI-style: boolean true
  return thinking === true;
}

// ABOUTME: Detects background/lightweight requests (subagent calls, quick tasks)
// ABOUTME: Matches when system message contains '@' or 'background', or request is lightweight

import type { MatchContext } from '../src/matcher.js';
import { extractText } from './_util.js';

const BACKGROUND_RE = /background/i;

function isLightweightRequest(ctx: MatchContext): boolean {
  const messages = ctx.body.messages;
  if (!Array.isArray(messages)) return false;

  const userMessages = messages.filter(
    (m: unknown) =>
      m !== null &&
      typeof m === 'object' &&
      'role' in (m as Record<string, unknown>) &&
      (m as Record<string, unknown>).role === 'user',
  );

  if (userMessages.length !== 1) return false;

  const content = extractText((userMessages[0] as Record<string, unknown>).content);
  return content.length < 200 && !Array.isArray(ctx.body.tools);
}

export default function isBackground(ctx: MatchContext): boolean {
  const messages = ctx.body.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return isLightweightRequest(ctx);
  }

  // Check if lightweight first — cache to avoid double call
  const lightweight = isLightweightRequest(ctx);
  if (lightweight) return true;

  const first = messages[0];
  if (
    first !== null &&
    typeof first === 'object' &&
    'content' in (first as Record<string, unknown>)
  ) {
    const systemContent = extractText((first as Record<string, unknown>).content);
    if (systemContent.includes('@') || BACKGROUND_RE.test(systemContent)) {
      return true;
    }
  }

  return false;
}

// ABOUTME: Detects requests containing image content blocks
// ABOUTME: Matches when any message content has type 'image' or 'image_url'

import type { MatchContext } from '../src/matcher.js';

export default function hasImage(ctx: MatchContext): boolean {
  const messages = ctx.body.messages;
  if (!Array.isArray(messages)) return false;

  return messages.some((msg: unknown) => {
    if (msg === null || typeof msg !== 'object') return false;
    const content = (msg as Record<string, unknown>).content;
    if (!Array.isArray(content)) return false;

    return content.some(
      (block: unknown) =>
        block !== null &&
        typeof block === 'object' &&
        'type' in (block as Record<string, unknown>) &&
        ((block as Record<string, unknown>).type === 'image' ||
          (block as Record<string, unknown>).type === 'image_url'),
    );
  });
}

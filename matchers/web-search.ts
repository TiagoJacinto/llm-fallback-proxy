// ABOUTME: Detects web search requests by checking for web_search tool type
// ABOUTME: Anthropic-format requests include tools with type starting with "web_search"

import type { MatchContext } from '../src/matcher.js';

export default function isWebSearch(ctx: MatchContext): boolean {
  const tools = ctx.body.tools;
  if (!Array.isArray(tools)) return false;

  return tools.some(
    (tool: unknown) =>
      tool !== null &&
      typeof tool === 'object' &&
      'type' in (tool as Record<string, unknown>) &&
      typeof (tool as Record<string, unknown>).type === 'string' &&
      (tool as Record<string, unknown>).type.startsWith('web_search'),
  );
}

// ABOUTME: Shared utilities for user-written matcher predicates

/**
 * Flatten message content (string or content-block array) into plain text.
 * Handles Anthropic-style `[{type:"text", text:"..."}]` and OpenAI-style plain strings.
 */
export function extractText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part: unknown) => {
      if (typeof part === 'string') return part;
      if (part !== null && typeof part === 'object' && 'text' in (part as Record<string, unknown>)) {
        return String((part as Record<string, unknown>).text);
      }
      return '';
    })
    .filter(Boolean)
    .join(' ');
}

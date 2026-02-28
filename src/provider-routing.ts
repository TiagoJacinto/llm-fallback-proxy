export type ProviderWireFormat = 'anthropic' | 'openai';
export type ProviderCompletionEndpointPath = '/v1/messages' | '/chat/completions';

function parseBaseUrl(baseUrl: string): URL | null {
  try {
    return new URL(baseUrl);
  } catch {
    return null;
  }
}

function normalizePathname(pathname: string): string {
  const normalized = pathname.toLowerCase().replace(/\/+$/, '');
  return normalized || '/';
}

function pathMatchesPrefix(pathname: string, prefix: string): boolean {
  return pathname === prefix || pathname.startsWith(`${prefix}/`);
}

function isAnthropicHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return normalized === 'anthropic.com' || normalized.endsWith('.anthropic.com');
}

export function inferProviderWireFormat(baseUrl: string): ProviderWireFormat {
  const parsed = parseBaseUrl(baseUrl);
  if (!parsed) {
    const normalized = baseUrl.toLowerCase();
    if (normalized.includes('/api/anthropic')) {
      return 'anthropic';
    }
    return 'openai';
  }

  const pathname = normalizePathname(parsed.pathname);

  // z.ai PaaS is OpenAI-compatible (chat/completions)
  if (pathMatchesPrefix(pathname, '/api/paas')) {
    return 'openai';
  }

  // Anthropic hosts or explicit Anthropic API path use /v1/messages wire format
  if (isAnthropicHost(parsed.hostname) || pathMatchesPrefix(pathname, '/api/anthropic')) {
    return 'anthropic';
  }

  return 'openai';
}

export function getProviderCompletionEndpointPath(baseUrl: string): ProviderCompletionEndpointPath {
  return inferProviderWireFormat(baseUrl) === 'anthropic' ? '/v1/messages' : '/chat/completions';
}

export function buildProviderCompletionUrl(baseUrl: string): string {
  const endpointPath = getProviderCompletionEndpointPath(baseUrl);
  return `${baseUrl.replace(/\/+$/, '')}${endpointPath}`;
}

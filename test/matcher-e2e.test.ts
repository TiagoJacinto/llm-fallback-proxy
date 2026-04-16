import { expect, test, describe, beforeAll, afterAll } from 'bun:test';
import router from '../src/router.js';
import { getConfig, loadConfig, updateConfig } from '../src/config.js';
import { MatcherRegistry } from '../src/matcher.js';

// ── Fake config ─────────────────────────────────────────────────────────

const CCS_QWEN_PROVIDER = {
  baseUrl: 'http://127.0.0.1:8317/api/provider/qwen',
  description: 'Test Qwen provider',
  timeout: 30000,
  apiKey: 'ccs-internal-managed',
  models: ['coder-model', 'qwen3-coder-flash', 'qwen3-coder-plus'],
};

function fakeConfig() {
  return {
    providers: { 'ccs-qwen': structuredClone(CCS_QWEN_PROVIDER) },
    matchers: {
      rules: [{ name: 'web-search', file: './matchers/web-search.ts' }],
    },
    combos: {
      'router': {
        description: 'Router combo with model-ref-level matchers',
        models: [
          { model: 'webSearch', matchers: ['web-search'] },
          { model: 'fallback' },
        ],
      },
      'fallback': {
        description: 'Fallback - qwen3-coder-plus',
        models: [{ provider: 'ccs-qwen', model: 'qwen3-coder-plus' }],
      },
      'webSearch': {
        description: 'Web Search - qwen3-coder-flash',
        models: [{ provider: 'ccs-qwen', model: 'qwen3-coder-flash' }],
      },
    },
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────

function chatBody(overrides: Record<string, unknown> = {}) {
  return {
    model: 'router',
    messages: [{ role: 'user', content: 'Reply with exactly: ok' }],
    max_tokens: 16,
    temperature: 0,
    ...overrides,
  };
}

async function postChat(body: Record<string, unknown>) {
  return router.request('http://localhost/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

// ── Tests ───────────────────────────────────────────────────────────────

describe('matcher e2e: web-search routing', () => {
  let originalConfig: ReturnType<typeof getConfig>;

  beforeAll(async () => {
    // Snapshot original config so we can restore it
    await loadConfig(true);
    originalConfig = structuredClone(getConfig());

    // Install fake config + load matchers
    updateConfig(fakeConfig() as any);
    await MatcherRegistry.getInstance().loadFromRules([
      { name: 'web-search', file: './matchers/web-search.ts' },
    ]);
  });

  afterAll(() => {
    updateConfig(originalConfig as any);
    MatcherRegistry.resetInstance();
  });

  test('request without web_search tools → fallback combo (qwen3-coder-plus)', async () => {
    const res = await postChat(chatBody());
    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.model).toContain('qwen3-coder-plus');
  });

  test('request with web_search tool → webSearch combo (qwen3-coder-flash)', async () => {
    const body = chatBody({
      tools: [
        { type: 'web_search', name: 'web_search' },
      ],
    });

    const res = await postChat(body);
    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.model).toContain('qwen3-coder-flash');
  });

  test('request with web_search_preview tool variant → webSearch combo', async () => {
    const body = chatBody({
      tools: [
        { type: 'web_search_preview', name: 'web_search_preview' },
      ],
    });

    const res = await postChat(body);
    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    expect(json.model).toContain('qwen3-coder-flash');
  });

  test('provider/model direct request bypasses matchers', async () => {
    const body = chatBody({
      model: 'ccs-qwen/qwen3-coder-flash',
      tools: [
        { type: 'web_search', name: 'web_search' },
      ],
    });

    const res = await postChat(body);
    expect(res.status).toBe(200);

    const json = (await res.json()) as any;
    // Direct provider/model should NOT be overridden by matchers
    expect(json.model).toContain('qwen3-coder-flash');
  });
});

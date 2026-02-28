import { afterAll, expect, test } from 'bun:test';
import { serve } from 'bun';
import router from '../src/router.js';
import { getConfig, loadConfig, updateConfig } from '../src/config.js';

let paasMessagesRequests = 0;
let paasChatCompletionsRequests = 0;

const zAiPaaSServer = serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === '/api/paas/v4/v1/messages') {
      paasMessagesRequests += 1;
      return new Response(
        JSON.stringify({
          error: {
            message: 'Not Found'
          }
        }),
        {
          status: 404,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    if (url.pathname === '/api/paas/v4/chat/completions') {
      paasChatCompletionsRequests += 1;
      return new Response(
        JSON.stringify({
          error: {
            code: '1302',
            message: 'Rate limit reached for requests'
          }
        }),
        {
          status: 429,
          headers: { 'Content-Type': 'application/json' }
        }
      );
    }

    return new Response('Not Found', { status: 404 });
  }
});

afterAll(() => {
  zAiPaaSServer.stop(true);
});

test('z.ai paas routes to chat/completions and preserves upstream 429', async () => {
  await loadConfig(true);
  const originalConfig = getConfig();
  const testConfig = structuredClone(originalConfig);

  testConfig.providers = {
    'z-ai': {
      baseUrl: `http://127.0.0.1:${zAiPaaSServer.port}/api/paas/v4/`,
      description: 'z.ai PaaS mock',
      timeout: 5000,
      apiKey: 'dummy',
      models: ['glm-4.7-flash']
    }
  };

  testConfig.combos = {
    test: {
      description: 'z.ai routing test combo',
      models: [{ provider: 'z-ai', model: 'glm-4.7-flash' }]
    }
  };

  paasMessagesRequests = 0;
  paasChatCompletionsRequests = 0;
  updateConfig(testConfig);

  try {
    const response = await router.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });

    const payload = await response.json();

    expect(response.status).toBe(429);
    expect(response.status).not.toBe(422);
    expect(payload.error?.type).toBe('rate_limit');
    expect(payload.error?.message).toContain('Rate limit reached for requests');
    expect(payload.error?.code).not.toBe('all_models_failed');

    expect(paasChatCompletionsRequests).toBe(1);
    expect(paasMessagesRequests).toBe(0);
  } finally {
    updateConfig(originalConfig);
  }
}, 60_000);

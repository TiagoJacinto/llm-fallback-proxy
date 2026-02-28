import { afterAll, expect, test } from 'bun:test';
import { serve } from 'bun';
import router from '../src/router.js';
import { loadConfig, getConfig, updateConfig } from '../src/config.js';
const providerAServer = serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/chat/completions') {
      providerARequests += 1;
      return new Response(JSON.stringify({
        error: {
          message: 'Forbidden from upstream',
          type: 'forbidden'
        }
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return new Response('Not Found', { status: 404 });
  }
});
const providerBServer = serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/chat/completions') {
      providerBRequests += 1;
      return Response.json({
        id: 'b-ok',
        object: 'chat.completion',
        created: Date.now(),
        model: 'm',
        choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }]
      });
    }
    return new Response('Not Found', { status: 404 });
  }
});

let providerARequests = 0;
let providerBRequests = 0;

afterAll(() => {
  providerAServer.stop(true);
  providerBServer.stop(true);
});

test('fail-fast status does not fall back to second provider', async () => {
  await loadConfig(true);
  const originalConfig = getConfig();
  const testConfig = structuredClone(originalConfig);

  testConfig.providers = {
    p1: {
      baseUrl: `http://127.0.0.1:${providerAServer.port}`,
      description: 'provider a',
      timeout: 5000,
      apiKey: 'dummy',
      models: ['m'],
      statusCodes: {
        'fail-fast': [403]
      }
    },
    p2: {
      baseUrl: `http://127.0.0.1:${providerBServer.port}`,
      description: 'provider b',
      timeout: 5000,
      apiKey: 'dummy',
      models: ['m']
    }
  };

  testConfig.combos = {
    test: {
      description: 'fallback chain',
      models: [
        { provider: 'p1', model: 'm' },
        { provider: 'p2', model: 'm' }
      ]
    }
  };

  providerARequests = 0;
  providerBRequests = 0;
  updateConfig(testConfig);

  try {
    const res = await router.request('http://localhost/v1/chat/completions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'test',
        messages: [{ role: 'user', content: 'hello' }]
      })
    });

    expect(res.status).toBe(422);
    expect(providerARequests).toBe(1);
    expect(providerBRequests).toBe(0);
  } finally {
    updateConfig(originalConfig);
  }
}, 60_000);

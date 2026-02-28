import { afterAll, expect, test } from 'bun:test';
import { serve } from 'bun';
import router from '../src/router.js';
import { getConfig, loadConfig, updateConfig } from '../src/config.js';

let openaiRequests = 0;

const mockServer = serve({
  port: 0,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === '/chat/completions') {
      openaiRequests++;
      return Response.json({
        id: 'chatcmpl-stream-test',
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: 'vision-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'stream ok' },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 5,
          completion_tokens: 2,
          total_tokens: 7
        }
      });
    }
    return new Response('Not Found', { status: 404 });
  }
});

afterAll(() => {
  mockServer.stop();
});

test('v1/messages stream returns Anthropic SSE text_delta and single upstream call', async () => {
  await loadConfig(true);
  const originalConfig = getConfig();
  const testConfig = structuredClone(originalConfig);

  testConfig.providers = {
    mock: {
      baseUrl: `http://127.0.0.1:${mockServer.port}`,
      description: 'mock provider',
      timeout: 5000,
      apiKey: 'dummy-token',
      models: ['vision-model']
    }
  };
  testConfig.combos = {
    image: {
      description: 'image test combo',
      models: [{ provider: 'mock', model: 'vision-model' }]
    }
  };

  openaiRequests = 0;
  updateConfig(testConfig);

  try {
    const response = await router.request('http://localhost/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'image',
        stream: true,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'describe image' }]
      })
    });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const body = await response.text();
    expect(body).toContain('event: message_start');
    expect(body).toContain('event: content_block_delta');
    expect(body).toContain('"type":"text_delta"');
    expect(body).toContain('"text":"stream ok"');
    expect(body).toContain('event: message_stop');
    expect(openaiRequests).toBe(1);
  } finally {
    updateConfig(originalConfig);
  }
}, 60_000);

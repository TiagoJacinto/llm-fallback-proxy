import { describe, expect, test } from 'bun:test';
import { ConfigSchema, getModelQuota } from '../src/config.js';

describe('Config model quota (no extending)', () => {
  test('returns only explicit model quota override', () => {
    const config = ConfigSchema.parse({
      providers: {
        p: {
          baseUrl: 'http://example.com',
          description: 'p',
          timeout: 30000,
          apiKey: 'k',
          quota: {
            usageServer: { type: 'http', url: 'http://example.com/quota' },
            quotaRemaining: { path: '$.remaining' },
            reset: { mode: 'timestamp', path: '$.resetAt' }
          },
          models: [
            {
              name: 'm1',
              quota: {
                usageServer: { type: 'http', url: 'http://example.com/model-quota' },
                quotaRemaining: { path: '$.models[0].remaining' },
                reset: { mode: 'timestamp', path: '$.models[0].resetAt' }
              }
            },
            { name: 'm2' }
          ]
        }
      },
      combos: {
        c: {
          description: 'c',
          models: [{ provider: 'p', model: 'm1' }]
        }
      }
    });

    const m1 = config.providers.p.models[0];
    const m2 = config.providers.p.models[1];

    expect(getModelQuota(m1)).toEqual({
      usageServer: { type: 'http', url: 'http://example.com/model-quota' },
      quotaRemaining: { path: '$.models[0].remaining' },
      reset: { mode: 'timestamp', path: '$.models[0].resetAt' }
    });
    expect(getModelQuota(m2)).toBeUndefined();
  });
});

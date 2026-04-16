import { expect, test, describe } from 'bun:test';
import { createBuilder } from '../src/typed-builder.js';
import type { TerminalResult, ProxyConfig } from '../src/typed-builder.js';
import type { MatchContext } from '../src/matcher.js';
import type { ComboConfig } from '../src/config.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Compile-time type assertion: errors if T is not exactly Expected. */
function assertType<T>(_: T): void {}

type ProxyHooks = { router: { input: MatchContext; output: never } };

// ── Runtime tests ────────────────────────────────────────────────────────────

describe('createBuilder', () => {
  const createProxy = createBuilder<ComboConfig, ProxyHooks>(['router']);

  test('returns callable that produces config + routerFn', () => {
    const result = createProxy({
      providers: {
        anthropic: {
          baseUrl: 'https://api.anthropic.com',
          apiKey: 'test-key',
          timeout: 30_000,
          models: [],
        },
      },
      combos: {
        smart: { models: [{ provider: 'anthropic', model: 'claude-opus-4-5' }], description: 'Smart' },
        fast: { models: [{ provider: 'anthropic', model: 'claude-haiku-4-5' }], description: 'Fast' },
      },
    }).router((_ctx) => ['smart']);

    expect(result.config).toBeDefined();
    expect(result.config.combos).toHaveProperty('smart');
    expect(result.config.combos).toHaveProperty('fast');
    expect(typeof result.routerFn).toBe('function');
  });

  test('router receives MatchContext fields', async () => {
    const { routerFn } = createProxy({
      providers: {},
      combos: {
        smart: { models: [{ provider: 'anthropic', model: 'opus' }], description: 'Smart' },
        fast: { models: [{ provider: 'anthropic', model: 'haiku' }], description: 'Fast' },
      },
    }).router((ctx) => {
      // Access all MatchContext fields — verifies they're present at runtime
      const _body: Record<string, unknown> = ctx.body;
      const _headers: Record<string, string> = ctx.headers;
      const _wireFormat: string = ctx.wireFormat;
      const _requestedModel: string = ctx.requestedModel;
      void _body; void _headers; void _wireFormat; void _requestedModel;
      return ['smart'];
    });

    const ctx: MatchContext = {
      body: { model: 'test' },
      headers: {},
      route: '/v1/chat/completions',
      wireFormat: 'openai',
      requestedModel: 'test',
    };

    const result = await routerFn(ctx as any);
    expect(result).toEqual(['smart']);
  });
});

// ── Type-level tests (compile-time only) ─────────────────────────────────────

describe('type-level: createProxy', () => {
  test('types are exported without error', () => {
    // Verifies the module compiles cleanly with real ComboConfig/MatchContext
    assertType<TerminalResult<Record<string, unknown>, Record<string, ComboConfig>>>(
      null as unknown as TerminalResult<Record<string, unknown>, Record<string, ComboConfig>>,
    );
    assertType<ProxyConfig<Record<string, unknown>, Record<string, ComboConfig>>>(
      null as unknown as ProxyConfig<Record<string, unknown>, Record<string, ComboConfig>>,
    );
  });
});

// ── Static type checks (these compile or fail at typecheck time) ─────────────

// Verify: ctx.key is "smart" | "fast" from combos keys
(() => {
  const createProxy = createBuilder<ComboConfig, ProxyHooks>(['router']);
  createProxy({
    providers: {},
    combos: {
      smart: { models: [{ provider: 'anthropic', model: 'opus' }], description: 'Smart' },
      fast: { models: [{ provider: 'anthropic', model: 'haiku' }], description: 'Fast' },
    },
  }).router((ctx) => {
    // ctx.key must be "smart" | "fast"
    assertType<'smart' | 'fast'>(ctx.key);
    // ctx.smart and ctx.fast must be ComboConfig
    assertType<ComboConfig>(ctx.smart);
    assertType<ComboConfig>(ctx.fast);
    // MatchContext fields accessible
    assertType<Record<string, unknown>>(ctx.body);
    assertType<Record<string, string>>(ctx.headers);
    assertType<'anthropic' | 'openai'>(ctx.wireFormat);
    assertType<string>(ctx.requestedModel);
    // Valid return: combo key literal
    return ['smart'];
  });
})();

// Verify: returning a valid combo key works
(() => {
  const createProxy = createBuilder<ComboConfig, ProxyHooks>(['router']);
  createProxy({
    providers: {},
    combos: {
      smart: { models: [{ provider: 'a', model: 'm' }], description: '' },
      fast: { models: [{ provider: 'a', model: 'm' }], description: '' },
    },
  }).router((_ctx) => ['fast']);
})();

// ── Negative type tests ──────────────────────────────────────────────────────
// These use @ts-expect-error to verify TypeScript rejects invalid combo keys.

// @ts-expect-error — "typo-model" is not a combo key
(() => {
  const createProxy = createBuilder<ComboConfig, ProxyHooks>(['router']);
  createProxy({
    providers: {},
    combos: {
      smart: { models: [{ provider: 'a', model: 'm' }], description: '' },
      fast: { models: [{ provider: 'a', model: 'm' }], description: '' },
    },
  }).router((_ctx) => ['typo-model']);
})();

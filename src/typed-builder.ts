// ABOUTME: Typed builder for creating proxy configs with compile-time combo key validation
// ABOUTME: createBuilder returns a callable that preserves literal combo keys for router type safety

import type { MatchContext } from './router-registry.js';

// ── Hook definition ──────────────────────────────────────────────────────────

interface THookDef {
  input: unknown;
  output: unknown;
}

// ── Router context: MatchContext + combo key union + item properties ──────────

type RouterContext<TCombos extends Record<string, unknown>> = MatchContext & {
  key: keyof TCombos;
} & { [K in keyof TCombos]: TCombos[K] };

// ── Terminal result ──────────────────────────────────────────────────────────

export interface ProxyConfig<
  TProviders extends Record<string, unknown> = Record<string, unknown>,
  TCombos extends Record<string, unknown> = Record<string, unknown>,
> {
  providers: TProviders;
  combos: TCombos;
}

export interface TerminalResult<
  TProviders extends Record<string, unknown>,
  TCombos extends Record<string, unknown>,
> {
  config: ProxyConfig<TProviders, TCombos>;
  routerFn: (ctx: RouterContext<TCombos>) => (keyof TCombos)[] | Promise<(keyof TCombos)[]>;
}

// ── Builder after source is defined ──────────────────────────────────────────

interface Builder<
  TProviders extends Record<string, unknown>,
  TCombos extends Record<string, unknown>,
  THooksMap extends Record<string, THookDef>,
> {
  router(
    fn: (
      ctx: RouterContext<TCombos>,
    ) => (keyof TCombos)[] | Promise<(keyof TCombos)[]>,
  ): TerminalResult<TProviders, TCombos>;
}

// ── DefineCallable: callable that also has .define ───────────────────────────

interface DefineCallable<TConfig, THooksMap extends Record<string, THookDef>> {
  <TProviders extends Record<string, unknown>, TCombos extends Record<string, TConfig>>(
    source: { providers: TProviders; combos: TCombos },
  ): Builder<TProviders, TCombos, THooksMap>;
}

// ── createBuilder ────────────────────────────────────────────────────────────

export function createBuilder<
  TConfig,
  THooksMap extends Record<string, THookDef>,
>(hookNames: Array<keyof THooksMap>): DefineCallable<TConfig, THooksMap> {
  function callable<
    TProviders extends Record<string, unknown>,
    TCombos extends Record<string, TConfig>,
  >(source: { providers: TProviders; combos: TCombos }): Builder<TProviders, TCombos, THooksMap> {
    const config: ProxyConfig<TProviders, TCombos> = {
      providers: source.providers,
      combos: source.combos,
    };

    return {
      router(fn) {
        return {
          config,
          routerFn: fn as TerminalResult<TProviders, TCombos>['routerFn'],
        };
      },
    };
  }

  return callable as DefineCallable<TConfig, THooksMap>;
}

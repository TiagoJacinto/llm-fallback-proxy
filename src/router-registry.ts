// ABOUTME: Router registry — loads user-defined TS router functions for programmatic combo routing
// ABOUTME: Router functions receive MatchContext and return RouterCandidate[] for dynamic model selection

import { resolve, isAbsolute } from 'path';
import { z } from 'zod';
import { logger } from './logger.js';

// ── Types ──────────────────────────────────────────────────────────────

/** Everything a router can inspect about an incoming request. */
export interface MatchContext {
  body: Record<string, unknown>;
  headers: Record<string, string>;
  route: '/v1/chat/completions' | '/v1/messages';
  wireFormat: 'anthropic' | 'openai';
  requestedModel: string;
}

/** A candidate returned by a router function.
 * Can be a simple string (model/combo name) or object with explicit provider.
 */
export type RouterCandidate = string | { model: string; provider?: string };

/** Signature user router files must export as default. */
export type RouterFunction = (
  ctx: MatchContext,
) => RouterCandidate[] | Promise<RouterCandidate[]>;

// ── Schemas for boundary validation ─────────────────────────────────────

/** Validates each router candidate returned from a user router function.
 * Accepts either a string (model/combo name) or object with model + optional provider.
 */
export const RouterCandidateSchema = z.union([
  z.string().min(1),
  z.object({
    model: z.string().min(1),
    provider: z.string().optional(),
  }),
]);

/** Zod schema for router function input/output.
 * implementAsync() awaits the user function before output validation,
 * so output is just z.array — no need for z.promise().
 */
const RouterFunctionSchema = z.function({
  input: [z.custom<MatchContext>()],
  output: z.array(RouterCandidateSchema),
});

/** Validates the module has a default export that is a function.
 * We do NOT use RouterFunctionSchema here because z.function().parse()
 * wraps the function in a sync validator, destroying async behavior.
 * We use implementAsync() directly on the raw export instead.
 */
const RouterModuleSchema = z.object({ default: z.function() });

// ── Router file loader ─────────────────────────────────────────────────

/**
 * Load a router function from a user TS file.
 *
 * Bun caches by URL, so we append `?t=Date.now()` to force a fresh load.
 * Validates the module has a default function export, then wraps it with
 * Zod runtime input/output validation via implementAsync().
 * Returns null on failure (fail-open).
 */
async function loadRouterFile(
  filePath: string,
): Promise<RouterFunction | null> {
  try {
    const url = `file://${filePath}?t=${Date.now()}`;
    const parsed = RouterModuleSchema.safeParse(await import(url));

    if (!parsed.success) {
      logger.warn('Router file has no default export function, skipping', {
        file: filePath,
      });
      return null;
    }

    // Cast through unknown: module schema only verifies "is a function";
    // implementAsync() provides the actual input/output runtime validation.
    const fn = RouterFunctionSchema.implementAsync(
      parsed.data.default as unknown as RouterFunction,
    );
    logger.debug('Router file loaded', { file: filePath });
    return fn;
  } catch (error) {
    logger.warn('Router file failed to load, skipping', {
      file: filePath,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

// ── Registry ───────────────────────────────────────────────────────────

/**
 * Singleton registry for router TS files.
 *
 * Loads user router TS files with cache-busting.
 * Keeps last-known-good on reload failure (fail-open).
 */
export class RouterRegistry {
  private static instance: RouterRegistry | null = null;
  private routerFn: RouterFunction | null = null;
  private routerFile: string | null = null;

  private constructor() {}

  static getInstance(): RouterRegistry {
    if (!RouterRegistry.instance) {
      RouterRegistry.instance = new RouterRegistry();
    }
    return RouterRegistry.instance;
  }

  /** Reset singleton — tests only. */
  static resetInstance(): void {
    RouterRegistry.instance = null;
  }

  /** Load router function from a TS file. Called at startup. */
  async load(routerPath: string, configDir: string): Promise<void> {
    const absPath = isAbsolute(routerPath) ? routerPath : resolve(configDir, routerPath);
    const fn = await loadRouterFile(absPath);

    if (fn) {
      this.routerFn = fn;
      this.routerFile = routerPath;
      logger.info('Router loaded', { file: routerPath });
    } else {
      logger.warn('Router file failed to load', { file: routerPath });
    }
  }

  /** Get the current router function, or null if not loaded. */
  getRouter(): RouterFunction | null {
    return this.routerFn;
  }

  /** Reload if the router file path changed. Keeps last-known-good on failure. */
  async reloadIfNeeded(newRouterFile: string | null, configDir: string): Promise<void> {
    if (newRouterFile === this.routerFile) {
      return;
    }

    if (!newRouterFile) {
      this.routerFn = null;
      this.routerFile = null;
      logger.info('Router cleared (no router in config)');
      return;
    }

    const absPath = isAbsolute(newRouterFile) ? newRouterFile : resolve(configDir, newRouterFile);
    const fn = await loadRouterFile(absPath);

    if (fn) {
      this.routerFn = fn;
      this.routerFile = newRouterFile;
      logger.info('Router reloaded', { file: newRouterFile });
    } else {
      // Load failed — keep existing routerFn (last-known-good)
      logger.warn('Router reload failed, keeping current router', { file: newRouterFile });
    }
  }
}

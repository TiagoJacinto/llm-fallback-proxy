// ABOUTME: Quota pacing manager with stdio/http support and rolling-window persistence
// ABOUTME: Checks quota before requests, persists rolling-window timestamps to config.json

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import { logger } from './logger.js';
import { QuotaConfig, loadConfig, saveConfig, getConfig, ProviderConfig } from './config.js';
import { JSONPath } from 'jsonpath-plus';
import { z } from 'zod';

interface CacheEntry {
  quotaRemaining: number;
  timestamp: number;
  resetTimestamp?: string; // ISO 8601 datetime string
  duration?: number; // in seconds, for rolling-window
}

export class QuotaManager {
  private static instance: QuotaManager;
  private cache: Record<string, CacheEntry> = {};
  private cachePath = new URL('../quota_cache.json', import.meta.url).pathname;

  private constructor() {
    this.loadCache();
  }

  public static getInstance(): QuotaManager {
    if (!QuotaManager.instance) {
      QuotaManager.instance = new QuotaManager();
    }
    return QuotaManager.instance;
  }

  private async loadCache(): Promise<void> {
    try {
      if (existsSync(this.cachePath)) {
        const content = await readFile(this.cachePath, 'utf-8');
        this.cache = JSON.parse(content);
        logger.debug('Quota cache loaded successfully');
      }
    } catch (error) {
      logger.error('Failed to load quota cache', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async saveCache(): Promise<void> {
    try {
      await writeFile(this.cachePath, JSON.stringify(this.cache, null, 2), 'utf-8');
    } catch (error) {
      logger.error('Failed to save quota cache', { error: error instanceof Error ? error.message : String(error) });
    }
  }

  /**
   * Fetch quota data from usageServer (stdio or http)
   */
  private async fetchQuotaData(providerId: string, quotaConfig: QuotaConfig): Promise<{
    quotaRemaining: number;
    resetTimestamp?: string;
    duration?: number;
  } | null> {
    // Check required fields
    if (!quotaConfig.usageServer) {
      throw new Error('usageServer is required for quota fetching');
    }
    if (!quotaConfig.quotaRemaining) {
      throw new Error('quotaRemaining is required for quota fetching');
    }
    if (!quotaConfig.quotaRemaining.path) {
      throw new Error('quotaRemaining.path is required for quota fetching');
    }
    if (!quotaConfig.reset) {
      throw new Error('reset is required for quota fetching');
    }

    const timeout = quotaConfig.timeoutSeconds || 20;
    const startTime = Date.now();

    try {
      let data: unknown;

      if (quotaConfig.usageServer.type === 'http') {
        const response = await fetch(quotaConfig.usageServer.url, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          signal: AbortSignal.timeout(timeout * 1000)
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }

        data = await response.json();

      } else {
        // stdio type - spawn command
        const result = await this.spawnCommand(
          quotaConfig.usageServer.command,
          quotaConfig.usageServer.args || [],
          quotaConfig.usageServer.env || {},
          timeout * 1000
        );
        data = JSON.parse(result);
      }

      // Extract quotaRemaining using JSONPath
      const quotaResults = JSONPath({ path: quotaConfig.quotaRemaining.path, json: data as Record<string, unknown> });
      const quotaResultsArray = Array.from(quotaResults) as unknown[];
      if (!quotaResultsArray || quotaResultsArray.length === 0 || typeof quotaResultsArray[0] !== 'number') {
        throw new Error(`Failed to extract quotaRemaining using path ${quotaConfig.quotaRemaining.path}`);
      }

      const quotaRemaining = Math.max(0, Math.min(100, quotaResultsArray[0]));

      // Extract reset data based on mode
      let resetTimestamp: string | undefined;
      let duration: number | undefined;

      if (quotaConfig.reset.mode === 'timestamp') {
        if (!quotaConfig.reset.path) {
          throw new Error('reset.path is required for timestamp mode');
        }
        const resetResults = JSONPath({ path: quotaConfig.reset.path, json: data as Record<string, unknown> });
        const resetResultsArray = Array.from(resetResults) as unknown[];
        if (resetResultsArray && resetResultsArray.length > 0) {
          const resetVal = resetResultsArray[0];
          if (typeof resetVal === 'string') {
            // Validate ISO 8601 timestamp format
            const timestampSchema = z.iso.datetime();
            const parseResult = timestampSchema.safeParse(resetVal);
            if (!parseResult.success) {
              throw new Error(
                `Invalid timestamp format: "${resetVal}". Expected ISO 8601 format (e.g., "2026-02-24T20:29:42Z" or "2026-03-01")`
              );
            }
            resetTimestamp = resetVal;
          } else if (typeof resetVal === 'number') {
            // Assume milliseconds if > 10 digits, otherwise seconds
            const isMs = resetVal > 10000000000;
            const isoTimestamp = new Date(isMs ? resetVal : resetVal * 1000).toISOString();
            resetTimestamp = isoTimestamp;
          }
        }
      } else if (quotaConfig.reset.mode === 'rolling-window') {
        if (!quotaConfig.reset.durationPath) {
          throw new Error('reset.durationPath is required for rolling-window mode');
        }
        // Extract duration (in seconds)
        const durationResults = JSONPath({ path: quotaConfig.reset.durationPath, json: data as Record<string, unknown> });
        const durationResultsArray = Array.from(durationResults) as unknown[];
        if (durationResultsArray && durationResultsArray.length > 0 && typeof durationResultsArray[0] === 'number') {
          duration = durationResultsArray[0];
        }
      }

      return { quotaRemaining, resetTimestamp, duration };

    } catch (error) {
      logger.warn(`Failed to fetch quota for provider ${providerId}`, {
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Spawn a command and return its stdout
   */
  private async spawnCommand(
    command: string,
    args: string[],
    env: Record<string, string>,
    timeoutMs: number
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const envWithPath = { ...process.env, ...env };
      const proc = spawn(command, args, { env: envWithPath });

      let stdout = '';
      let stderr = '';

      const timer = setTimeout(() => {
        proc.kill();
        reject(new Error('Command timed out'));
      }, timeoutMs);

      proc.stdout?.on('data', (data) => { stdout += data; });
      proc.stderr?.on('data', (data) => { stderr += data; });

      proc.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) {
          resolve(stdout.trim());
        } else {
          reject(new Error(`Command failed with code ${code}: ${stderr}`));
        }
      });

      proc.on('error', (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  /**
   * Calculate time remaining in the current billing cycle (0 to 100)
   */
  private calculateTimeRemaining(quotaConfig: QuotaConfig, cachedData?: {
    resetTimestamp?: string;
    duration?: number;
    latestStartTimestamp?: string;
  }): number {
    const now = Date.now();

    if (!quotaConfig.reset) {
      return 100; // No reset config - allow all
    }

    if (quotaConfig.reset.mode === 'timestamp') {
      // For timestamp mode, we need the actual reset timestamp value
      // If we have cachedData.resetTimestamp, use it; otherwise we can't calculate
      if (!cachedData?.resetTimestamp) {
        return 100; // Allow all if we don't have reset timestamp yet
      }

      const resetTimeMs = new Date(cachedData.resetTimestamp).getTime();
      // For timestamp mode, we need a cycle duration - use 30 days as default
      const cycleMs = 30 * 24 * 60 * 60 * 1000;

      let cycleStartMs: number;
      if (now < resetTimeMs) {
        cycleStartMs = resetTimeMs - cycleMs;
      } else {
        const cyclesSinceReset = Math.floor((now - resetTimeMs) / cycleMs);
        cycleStartMs = resetTimeMs + (cyclesSinceReset * cycleMs);
      }

      const elapsedMs = now - cycleStartMs;
      const timeRemainingPercent = 100 - (100 * (elapsedMs / cycleMs));

      return Math.max(0, Math.min(100, timeRemainingPercent));

    } else if (quotaConfig.reset.mode === 'rolling-window') {
      const duration = cachedData?.duration;
      const latestStartTimestampStr = cachedData?.latestStartTimestamp;

      if (latestStartTimestampStr) {
        // Validate timestamp format when loading from config
        const timestampSchema = z.iso.datetime();
        const parseResult = timestampSchema.safeParse(latestStartTimestampStr);
        if (!parseResult.success) {
          logger.warn(`Invalid latestStartTimestamp in cache: ${latestStartTimestampStr}. Resetting.`);
          return 100; // Allow all if timestamp is invalid
        }
      }

      const latestStartTimestamp = latestStartTimestampStr
        ? new Date(latestStartTimestampStr).getTime()
        : undefined;

      if (!duration || !latestStartTimestamp) {
        // First fetch - no data yet
        return 100; // Allow all requests until we establish the window
      }

      const windowEndMs = latestStartTimestamp + (duration * 1000);
      const elapsedMs = now - latestStartTimestamp;
      const timeRemainingPercent = 100 - (100 * (elapsedMs / (duration * 1000)));

      return Math.max(0, Math.min(100, timeRemainingPercent));
    }

    return 100; // Default fallback
  }

  /**
   * Persist rolling-window timestamp to provider config
   */
  private async persistRollingWindowStart(
    providerId: string,
    timestamp: string
  ): Promise<void> {
    try {
      // Load config first to get current state
      const config = await loadConfig(true);
      const provider = config.providers[providerId];
      if (!provider) return;

      const modelQuota = provider.models?.find((m) => {
        if (typeof m === 'string') return false;
        return m.quota?.reset?.mode === 'rolling-window';
      });

      const quotaToUpdate = modelQuota && typeof modelQuota !== 'string'
        ? modelQuota.quota
        : provider.quota;

      if (quotaToUpdate?.reset?.mode === 'rolling-window') {
        // Ensure reset has the rolling-window structure
        if (quotaToUpdate.reset.mode === 'rolling-window') {
          quotaToUpdate.reset = {
            mode: 'rolling-window',
            latestStartTimestamp: timestamp,
            durationPath: quotaToUpdate.reset.durationPath
          };
          await saveConfig(config);
          logger.debug(`Persisted rolling-window start for ${providerId}`, { timestamp });
        }
      }
    } catch (error) {
      logger.error('Failed to persist rolling-window timestamp', {
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  /**
   * Clear all cached data (for testing)
   */
  public clearCache(): void {
    this.cache = {};
    this.saveCache();
  }

  /**
   * Seed cache with specific values (for testing)
   * For rolling-window mode, pass resetTimestamp as the latestStartTimestamp
   */
  public seedCache(providerId: string, quotaRemaining: number, resetTimestamp?: string, duration?: number): void {
    this.cache[providerId] = {
      quotaRemaining,
      timestamp: Date.now(),
      resetTimestamp,
      duration
    };
    this.saveCache();
  }

  /**
   * Check if a request should be allowed based on quota pacing
   */
  public async checkPacing(providerId: string, quotaConfig: QuotaConfig): Promise<boolean> {
    try {
      const cachedEntry = this.cache[providerId];
      const cacheTTL = quotaConfig.cacheTTLSeconds ?? 60; // Default to 60 seconds if not specified
      const cacheValid = cachedEntry && (Date.now() - cachedEntry.timestamp) < (cacheTTL * 1000);

      let quotaRemaining: number | null = null;
      let resetTimestamp: string | undefined;
      let duration: number | undefined;
      let isDegraded = false;
      let isNewWindow = false; // Track if we just detected a new window (quota increased)

      // Build cached data context for time calculation
      const cachedDataContext = {
        resetTimestamp: undefined as string | undefined,
        duration: cachedEntry?.duration,
        latestStartTimestamp: undefined as string | undefined
      };

      if (cacheValid) {
        quotaRemaining = cachedEntry.quotaRemaining;
        duration = cachedEntry.duration;
        resetTimestamp = cachedEntry.resetTimestamp;
        // Use cached reset timestamp if available
        if (resetTimestamp) {
          cachedDataContext.resetTimestamp = resetTimestamp;
        }
        // For rolling-window mode, the resetTimestamp is the latestStartTimestamp
        if (quotaConfig.reset?.mode === 'rolling-window' && resetTimestamp) {
          cachedDataContext.latestStartTimestamp = resetTimestamp;
        }
      } else {
        // Try to fetch fresh quota data
        const freshData = await this.fetchQuotaData(providerId, quotaConfig);

        if (freshData) {
          quotaRemaining = freshData.quotaRemaining;
          resetTimestamp = freshData.resetTimestamp;
          duration = freshData.duration;

          // Set cachedDataContext with fresh resetTimestamp for time calculation
          if (resetTimestamp) {
            cachedDataContext.resetTimestamp = resetTimestamp;
          }

          // Rolling-window: detect quota increase and persist new start
          if (quotaConfig.reset?.mode === 'rolling-window') {
            const prevQuota = cachedEntry?.quotaRemaining ?? -1;
            if (quotaRemaining > prevQuota) {
              const newStart = new Date().toISOString();
              await this.persistRollingWindowStart(providerId, newStart);
              cachedDataContext.latestStartTimestamp = newStart;
              isNewWindow = true; // Mark as new window - allow this request
            } else {
              // Use existing timestamp from config
              const config = await loadConfig(true);
              const provider = config.providers[providerId];
              const modelQuota = provider?.models?.find((m) => {
                if (typeof m === 'string') return false;
                return m.quota?.reset?.mode === 'rolling-window';
              });
              const quota = (modelQuota && typeof modelQuota !== 'string') ? modelQuota.quota : provider?.quota;
              if (quota?.reset?.mode === 'rolling-window' && quota.reset.mode === 'rolling-window' && quota.reset.latestStartTimestamp) {
                cachedDataContext.latestStartTimestamp = quota.reset.latestStartTimestamp;
              }
            }
          }

          // Update cache
          this.cache[providerId] = {
            quotaRemaining,
            timestamp: Date.now(),
            resetTimestamp,
            duration
          };
          await this.saveCache();

        } else {
          // Fetch failed, check if we have stale cache
          if (cachedEntry) {
            quotaRemaining = cachedEntry.quotaRemaining;
            duration = cachedEntry.duration;
            resetTimestamp = cachedEntry.resetTimestamp;
            if (resetTimestamp) {
              cachedDataContext.resetTimestamp = resetTimestamp;
            }
            if (quotaConfig.reset?.mode === 'rolling-window' && resetTimestamp) {
              // In rolling-window mode, cache stores latestStartTimestamp in resetTimestamp field.
              cachedDataContext.latestStartTimestamp = resetTimestamp;
            }
            cachedDataContext.duration = cachedEntry.duration;
            isDegraded = true;
            logger.warn(`Using stale quota cache for provider ${providerId} (Degraded Mode)`);
          } else {
            // No cache, fetch failed (Cold Start -> fail closed)
            logger.error(`Quota check failed for provider ${providerId}: Endpoint unreachable and no cache available`);
            return false;
          }
        }
      }

      if (quotaRemaining === null) {
        return false;
      }

      // If we just detected a new rolling window (quota increased), allow this request
      if (isNewWindow) {
        logger.debug(`New rolling window detected for provider ${providerId}, allowing request`);
        return true;
      }

      const timeRemaining = this.calculateTimeRemaining(quotaConfig, cachedDataContext);
      const overdraftPercent = quotaConfig.quotaRemaining?.overdraftPercent ?? 2;
      const overdraftAllowed = isDegraded ? overdraftPercent : 0;
      const pacingThreshold = Math.max(0, timeRemaining - overdraftAllowed);

      const isAllowed = quotaRemaining >= pacingThreshold;

      if (!isAllowed) {
        logger.info(`Quota pacing violation for provider ${providerId}`, {
          quotaRemaining,
          timeRemaining,
          isDegraded,
          overdraftAllowed
        });
      }

      return isAllowed;
    } catch (error) {
      logger.error(`Error checking quota pacing for provider ${providerId}`, {
        error: error instanceof Error ? error.message : String(error)
      });
      return false;
    }
  }
}

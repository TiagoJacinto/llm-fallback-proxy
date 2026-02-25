// ABOUTME: Dynamic model discovery from provider modelsServer
// ABOUTME: Requires modelsServer responses to be an array of strings

import { logger } from './logger.js';
import { ProviderConfig } from './config.js';
import { z } from 'zod';

const ModelsArraySchema = z.array(z.string());
const MODELS_CACHE_TTL_MS = 60_000;
const modelsCache = new Map<string, { timestamp: number; models: string[] }>();

function parseModelsArray(providerName: string, payload: unknown): string[] {
  const parsed = ModelsArraySchema.safeParse(payload);
  if (!parsed.success) {
    logger.warn('Invalid modelsServer response format: expected array', {
      provider: providerName,
      details: parsed.error.issues.map(issue => issue.message).join('; ')
    });
    return [];
  }

  return parsed.data.map(id => id.trim()).filter(id => id.length > 0);
}

/**
 * Fetch available models from a provider's models endpoint and return their IDs
 */
export async function fetchProviderModels(providerName: string, config: ProviderConfig): Promise<string[]> {
  try {
    if (!config.modelsServer) {
      logger.warn('modelsServer is required for model discovery', { provider: providerName });
      return [];
    }

    let payload: unknown;
    let source: string;

    if (config.modelsServer.type === 'http') {
      source = config.modelsServer.url;
      const cacheKey = `${providerName}:http:${source}`;
      const cached = modelsCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < MODELS_CACHE_TTL_MS) {
        logger.debug('Using cached models from modelsServer', { provider: providerName, source });
        return cached.models;
      }
      logger.info('Fetching models from modelsServer (http)', { provider: providerName, url: source });
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), config.timeout || 10000);

      const response = await fetch(source, {
        headers: {
          'Content-Type': 'application/json',
        },
        signal: controller.signal,
      });

      clearTimeout(timeoutId);
      if (!response.ok) {
        logger.warn('Failed to fetch models from modelsServer (http)', {
          provider: providerName,
          status: response.status,
          statusText: response.statusText,
        });
        return [];
      }

      payload = await response.json();
      const modelIds = parseModelsArray(providerName, payload);
      modelsCache.set(cacheKey, { timestamp: Date.now(), models: modelIds });
      logger.info('Successfully fetched models from provider', {
        provider: providerName,
        source,
        count: modelIds.length,
        models: modelIds.slice(0, 10),
      });
      return modelIds;
    } else {
      source = config.modelsServer.command;
      const cacheKey = `${providerName}:stdio:${source}:${(config.modelsServer.args || []).join(' ')}`;
      const cached = modelsCache.get(cacheKey);
      if (cached && Date.now() - cached.timestamp < MODELS_CACHE_TTL_MS) {
        logger.debug('Using cached models from modelsServer', { provider: providerName, source });
        return cached.models;
      }
      logger.info('Fetching models from modelsServer (stdio)', { provider: providerName, command: source });
      const proc = Bun.spawn({
        cmd: [
          config.modelsServer.command,
          ...(config.modelsServer.args || [])
        ],
        env: {
          ...process.env,
          ...(config.modelsServer.env || {})
        },
        stdout: 'pipe',
        stderr: 'pipe'
      });

      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();

      if (exitCode !== 0) {
        logger.warn('Failed to fetch models from modelsServer (stdio)', {
          provider: providerName,
          command: source,
          exitCode,
          stderr: stderr.trim()
        });
        return [];
      }

      try {
        payload = JSON.parse(stdout);
      } catch {
        payload = stdout.split('\n').map(line => line.trim()).filter(Boolean);
      }
      const modelIds = parseModelsArray(providerName, payload);
      modelsCache.set(cacheKey, { timestamp: Date.now(), models: modelIds });
      logger.info('Successfully fetched models from provider', {
        provider: providerName,
        source,
        count: modelIds.length,
        models: modelIds.slice(0, 10),
      });
      return modelIds;
    }
  } catch (error) {
    logger.error('Error fetching models from provider', {
      provider: providerName,
      error: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

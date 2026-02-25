// ABOUTME: Hono router for /v1/chat/completions, /v1/models, and /health
// ABOUTME: Handles OpenAI-compatible API routing with proper error responses

import { Hono } from 'hono';
import { logger } from './logger.js';
import { getConfig, saveConfig, updateConfig, Config, getModelName } from './config.js';
import { fetchProviderModels } from './model-discovery.js';
import { executeModelSelection, ErrorResponse } from './fallback.js';

const app = new Hono();

// GET /health - Health check endpoint
app.get('/health', (c) => {
  return c.json({ status: 'ok' });
});

// GET /v1/models - List all available combos (Anthropic-compatible format)
app.get('/v1/models', (c) => {
  try {
    const config = getConfig();

    const ids = Array.from(new Set([
      ...Object.keys(config.combos),
      ...Object.values(config.providers).flatMap(provider => (provider.models ?? []).map(modelEntry => getModelName(modelEntry)))
    ]));
    const models = ids.map((id) => ({
      id,
      created_at: new Date().toISOString(),
      display_name: id,
      type: 'model' as const,
    }));

    return c.json({
      data: models,
      firstId: ids[0] ?? null,
      hasMore: false,
      lastId: ids[ids.length - 1] ?? null,
    });
  } catch (error) {
    logger.error('Failed to list models', { error: error instanceof Error ? error.message : String(error) });
    return c.json(
      {
        error: {
          message: 'Failed to retrieve models list',
          type: 'internal_error',
          code: 'model_list_failed'
        }
      } as ErrorResponse,
      500
    );
  }
});

// GET /v1/providers - List all available providers
app.get('/v1/providers', (c) => {
  try {
    const config = getConfig();

    const providers = Object.entries(config.providers).map(([id, provider]) => ({
      id,
      description: provider.description,
      baseUrl: provider.baseUrl,
      modelsCount: provider.models?.length ?? 0,
    }));

    return c.json({ data: providers });
  } catch (error) {
    logger.error('Failed to list providers', { error: error instanceof Error ? error.message : String(error) });
    return c.json(
      {
        error: {
          message: 'Failed to retrieve providers list',
          type: 'internal_error',
          code: 'provider_list_failed'
        }
      } as ErrorResponse,
      500
    );
  }
});

// GET /v1/providers/:providerId/models - List models for a specific provider
app.get('/v1/providers/:providerId/models', (c) => {
  try {
    const providerId = c.req.param('providerId');
    const config = getConfig();

    const provider = config.providers[providerId];
    if (!provider) {
      return c.json(
        {
          error: {
            message: `Unknown provider: ${providerId}. Available providers: ${Object.keys(config.providers).join(', ')}`,
            type: 'invalid_request_error',
            code: 'provider_not_found',
            param: 'providerId'
          }
        } as ErrorResponse,
        404
      );
    }

    const models = (provider.models ?? []).map((modelEntry) => ({
      id: getModelName(modelEntry),
      created_at: new Date().toISOString(),
      display_name: getModelName(modelEntry),
      type: 'model' as const,
    }));

    return c.json({
      data: models,
      provider: {
        id: providerId,
        description: provider.description,
        baseUrl: provider.baseUrl,
      },
      firstId: models[0]?.id ?? null,
      hasMore: false,
      lastId: models[models.length - 1]?.id ?? null,
    });
  } catch (error) {
    logger.error('Failed to list provider models', { error: error instanceof Error ? error.message : String(error) });
    return c.json(
      {
        error: {
          message: 'Failed to retrieve provider models',
          type: 'internal_error',
          code: 'provider_models_failed'
        }
      } as ErrorResponse,
      500
    );
  }
});

// POST /v1/providers/:providerId/discover - Discover unknown model status code
app.post('/v1/providers/:providerId/discover', async (c) => {
  try {
    const providerId = c.req.param('providerId');
    const config = getConfig();

    const provider = config.providers[providerId];
    if (!provider) {
      return c.json(
        {
          error: {
            message: `Unknown provider: ${providerId}. Available providers: ${Object.keys(config.providers).join(', ')}`,
            type: 'invalid_request_error',
            code: 'provider_not_found',
            param: 'providerId'
          }
        } as ErrorResponse,
        404
      );
    }

    // Determine the provider type to choose the right endpoint
    const isAnthropicProvider = provider.baseUrl.includes('anthropic') || provider.baseUrl.includes('z.ai');
    const fakeModel = 'llm-fallback-proxy-fake-model';

    let url: string;
    let body: unknown;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (isAnthropicProvider) {
      url = `${provider.baseUrl}/v1/messages`;
      headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      body = {
        model: fakeModel,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 10,
        stream: false
      };
    } else {
      url = `${provider.baseUrl}/chat/completions`;
      headers['Authorization'] = `Bearer ${provider.apiKey}`;
      body = {
        model: fakeModel,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 10
      };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), provider.timeout);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      return c.json({
        providerId,
        unknownModelStatusCode: response.status,
        statusText: response.statusText,
        testedModel: fakeModel,
        requestUrl: url
      });
    } catch (error) {
      clearTimeout(timeoutId);

      if (error instanceof Error && error.name === 'AbortError') {
        return c.json(
          {
            error: {
              message: `Request timeout while discovering status code for provider ${providerId}`,
              type: 'timeout',
              code: 'timeout'
            }
          } as ErrorResponse,
          504
        );
      }

      throw error;
    }
  } catch (error) {
    logger.error('Failed to discover unknown model status code', { error: error instanceof Error ? error.message : String(error) });
    return c.json(
      {
        error: {
          message: error instanceof Error ? error.message : 'Failed to discover status code',
          type: 'internal_error',
          code: 'discover_failed'
        }
      } as ErrorResponse,
      500
    );
  }
});

// POST /v1/providers/:providerId/populate - Populate models array and optionally discover status code
app.post('/v1/providers/:providerId/populate', async (c) => {
  try {
    const providerId = c.req.param('providerId');
    const body = await c.req.json().catch(() => ({}));
    const { discoverUnknownModelStatusCode = true, fetchModels = true } = body as {
      discoverUnknownModelStatusCode?: boolean;
      fetchModels?: boolean;
    };

    const config = getConfig();
    const provider = config.providers[providerId];

    if (!provider) {
      return c.json(
        {
          error: {
            message: `Unknown provider: ${providerId}. Available providers: ${Object.keys(config.providers).join(', ')}`,
            type: 'invalid_request_error',
            code: 'provider_not_found',
            param: 'providerId'
          }
        } as ErrorResponse,
        404
      );
    }

    const result: {
      providerId: string;
      discovered?: {
        unknownModelStatusCode?: number;
        models?: string[];
      };
      persisted: boolean;
    } = {
      providerId,
      persisted: false
    };

    result.discovered = {};

    // Discover unknown model status code if requested
    if (discoverUnknownModelStatusCode) {
      const isAnthropicProvider = provider.baseUrl.includes('anthropic') || provider.baseUrl.includes('z.ai');
      const fakeModel = 'llm-fallback-proxy-fake-model';

      let url: string;
      let requestBody: unknown;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };

      if (isAnthropicProvider) {
        url = `${provider.baseUrl}/v1/messages`;
        headers['x-api-key'] = provider.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        requestBody = {
          model: fakeModel,
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 10,
          stream: false
        };
      } else {
        url = `${provider.baseUrl}/chat/completions`;
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
        requestBody = {
          model: fakeModel,
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 10
        };
      }

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), provider.timeout);

      try {
        const response = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify(requestBody),
          signal: controller.signal
        });

        clearTimeout(timeoutId);

        // Update provider config with discovered status code
        provider.unknownModelStatusCode = response.status;
        result.discovered.unknownModelStatusCode = response.status;

        logger.info(`Discovered unknown model status code for provider`, {
          provider: providerId,
          statusCode: response.status
        });
      } catch (error) {
        clearTimeout(timeoutId);
        logger.warn('Failed to discover unknown model status code', {
          provider: providerId,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }

    // Fetch models if requested
    if (fetchModels && provider.modelsServer) {
      const models = await fetchProviderModels(providerId, provider);
      provider.models = models;
      result.discovered.models = models;

      logger.info(`Fetched models for provider`, {
        provider: providerId,
        count: models.length
      });
    }

    // Persist to disk if persistAutoDeletedModels is enabled
    if (provider.persistAutoDeletedModels) {
      try {
        await saveConfig(config);
        result.persisted = true;
      } catch (error) {
        logger.error('Failed to persist config after populate', {
          error: error instanceof Error ? error.message : String(error)
        });
      }
    } else {
      // Update in-memory config
      updateConfig(config);
    }

    return c.json(result);
  } catch (error) {
    logger.error('Failed to populate provider', { error: error instanceof Error ? error.message : String(error) });
    return c.json(
      {
        error: {
          message: error instanceof Error ? error.message : 'Failed to populate provider',
          type: 'internal_error',
          code: 'populate_failed'
        }
      } as ErrorResponse,
      500
    );
  }
});

// POST /v1/chat/completions - Main chat completions endpoint with fallback
app.post('/v1/chat/completions', async (c) => {
  try {
    const body = await c.req.json();
    const { model, ...rest } = body;

    if (!model) {
      return c.json(
        {
          error: {
            message: 'Missing required field: model',
            type: 'invalid_request_error',
            code: 'missing_model',
            param: 'model'
          }
        } as ErrorResponse,
        400
      );
    }

    const config = getConfig();

    logger.info(`Received chat completion request`, { model: model });

    // Extract Authorization header from incoming request
    const authHeader = c.req.header('Authorization');

    // Execute model selection (combo fallback or direct provider model)
    const response = await executeModelSelection(model, body, authHeader);

    return c.json(response);
  } catch (error) {
    const errorObj = error as ErrorResponse;

    // If it's already a properly formatted error response, return it
    if (errorObj.error) {
      const statusCode = errorObj.error.code === 'model_not_found' ? 404
        : errorObj.error.type === 'unauthorized' ? 401
        : errorObj.error.type === 'forbidden' ? 403
        : errorObj.error.type === 'client_error' ? 400
        : 500;

      logger.error(`Chat completion failed`, {
        error: errorObj.error.message,
        type: errorObj.error.type
      });

      return c.json(errorObj, statusCode);
    }

    // Unknown error format
    logger.error(`Unexpected error in chat completion`, { error: error instanceof Error ? error.message : String(error) });

    return c.json(
      {
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          type: 'internal_error',
          code: 'internal_error'
        }
      } as ErrorResponse,
      500
    );
  }
});

// POST /v1/messages - Anthropic-format messages endpoint (Claude CLI uses this)
app.post('/v1/messages', async (c) => {
  try {
    const body = await c.req.json();
    const { model, ...rest } = body;

    if (!model) {
      return c.json(
        {
          error: {
            message: 'Missing required field: model',
            type: 'invalid_request_error',
          }
        },
        400
      );
    }

    logger.info(`Received Anthropic messages request`, { model, stream: !!body.stream });

    const authHeader = c.req.header('Authorization');

    // Execute model selection (combo fallback or direct provider model)
    const response = await executeModelSelection(model, body, authHeader, 'anthropic');

    return c.json(response);
  } catch (error) {
    const errorObj = error as ErrorResponse;

    if (errorObj.error) {
      const statusCode = errorObj.error.code === 'model_not_found' ? 404
        : errorObj.error.type === 'unauthorized' ? 401
        : errorObj.error.type === 'forbidden' ? 403
        : errorObj.error.type === 'client_error' ? 400
        : 500;

      logger.error(`Anthropic messages failed`, {
        error: errorObj.error.message,
        type: errorObj.error.type
      });

      return c.json(errorObj, statusCode);
    }

    logger.error(`Unexpected error in Anthropic messages`, { error: error instanceof Error ? error.message : String(error) });

    return c.json(
      {
        error: {
          message: error instanceof Error ? error.message : 'Unknown error',
          type: 'api_error',
        }
      },
      500
    );
  }
});

export default app;

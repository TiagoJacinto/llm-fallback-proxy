// ABOUTME: Hono router for /v1/chat/completions, /v1/models, and /health
// ABOUTME: Handles OpenAI-compatible API routing with proper error responses

import { Hono, type Context } from 'hono';
import { HTTPException } from 'hono/http-exception';
import { logger } from './logger.js';
import { getConfig, saveConfig, updateConfig, getModelName } from './config.js';
import { fetchProviderModels } from './model-discovery.js';
import {
  executeModelSelection,
  ChatCompletionRequestSchema,
  AnthropicRequestSchema,
} from './fallback.js';
import {
  type ExceptionResponse,
  AppException,
  AllModelsFailedException,
  ChainTimeoutException,
  InvalidRequestException,
  ModelFailedException,
  ModelNotFoundException,
  ProviderNotFoundException,
} from './exceptions.js';
import { buildProviderCompletionUrl, inferProviderWireFormat } from './provider-routing.js';

import { zValidator } from '@hono/zod-validator';

const app = new Hono();

function invalidRequestResponse(c: Context, message: string, code = 'invalid_request', param?: string): Response {
  return c.json(new InvalidRequestException(message, code, param).toResponse(), 400);
}

app.onError((error, c) => {
  if (error instanceof HTTPException && error.status === 400 && error.message === 'Malformed JSON in request body') {
    return invalidRequestResponse(c, 'Request body must be valid JSON', 'invalid_json_body');
  }

  logger.error('Unhandled router error', { error: error instanceof Error ? error.message : String(error) });
  return c.json(createExceptionResponse('Unknown error', 'internal_error', 'internal_error'), 500);
});
const encoder = new TextEncoder();

interface AnthropicMessageResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{ type: string; text?: string; [key: string]: unknown }>;
  model: string;
  stop_reason?: string | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    [key: string]: unknown;
  };
}

interface ModelListEntry {
  id: string;
  created_at: string;
  display_name: string;
  type: 'model';
}


function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function createExceptionResponse(
  message: string,
  type: string,
  code?: string,
  param?: string
): ExceptionResponse {
  const error: ExceptionResponse['error'] = { message, type };
  if (code !== undefined) {
    error.code = code;
  }
  if (param !== undefined) {
    error.param = param;
  }
  return { error };
}

function createModelListEntry(id: string): ModelListEntry {
  return {
    id,
    created_at: new Date().toISOString(),
    display_name: id,
    type: 'model',
  };
}

async function parsePopulateRequestBody(parseJson: () => Promise<unknown>): Promise<{
  discoverUnknownModelStatusCode: boolean;
  fetchModels: boolean;
}> {
  const parsed = await parseJson().catch(() => ({}));
  if (!isRecord(parsed)) {
    return {
      discoverUnknownModelStatusCode: true,
      fetchModels: true,
    };
  }

  return {
    discoverUnknownModelStatusCode:
      typeof parsed.discoverUnknownModelStatusCode === 'boolean'
        ? parsed.discoverUnknownModelStatusCode
        : true,
    fetchModels: typeof parsed.fetchModels === 'boolean' ? parsed.fetchModels : true,
  };
}

function isAnthropicMessageResponse(value: unknown): value is AnthropicMessageResponse {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string') return false;
  if (value.type !== 'message') return false;
  if (value.role !== 'assistant') return false;
  if (typeof value.model !== 'string') return false;
  if (!Array.isArray(value.content)) return false;

  for (const block of value.content) {
    if (!isRecord(block)) return false;
    if (typeof block.type !== 'string' || block.type.trim() === '') return false;
    if ('text' in block && block.text !== undefined && typeof block.text !== 'string') return false;
  }

  if ('stop_reason' in value) {
    const stopReason = value.stop_reason;
    if (stopReason !== undefined && stopReason !== null && typeof stopReason !== 'string') {
      return false;
    }
  }

  if ('usage' in value && value.usage !== undefined) {
    if (!isRecord(value.usage)) {
      return false;
    }
    const usage = value.usage;
    if ('input_tokens' in usage && usage.input_tokens !== undefined && typeof usage.input_tokens !== 'number') {
      return false;
    }
    if ('output_tokens' in usage && usage.output_tokens !== undefined && typeof usage.output_tokens !== 'number') {
      return false;
    }
  }

  return true;
}

function formatSseEvent(event: string, payload: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
}

function splitText(text: string, chunkSize = 256): string[] {
  if (!text) return [''];
  const chunks: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    chunks.push(text.slice(i, i + chunkSize));
  }
  return chunks;
}

function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';

  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (isRecord(part) && typeof part.text === 'string') {
        return part.text;
      }
      return '';
    })
    .filter(Boolean)
    .join(' ');
}

function extractPromptMeta(body: Record<string, unknown>): { prompt_preview?: string; prompt_preview_tail?: string; prompt_length?: number } {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (messages.length === 0) return {};

  const typedMessages = messages.filter((m): m is { role?: unknown; content?: unknown } => !!m && typeof m === 'object');
  const userMessages = typedMessages.filter((m) => m.role === 'user');
  const source = userMessages.length > 0 ? userMessages : typedMessages;
  const combined = source.map((m) => extractTextFromContent(m.content)).join('\n').trim();

  if (!combined) return {};

  const previewMax = 220;
  return {
    prompt_length: combined.length,
    prompt_preview: combined.length > previewMax ? `${combined.slice(0, previewMax)}...` : combined,
    prompt_preview_tail: combined.length > previewMax ? `...${combined.slice(-previewMax)}` : combined
  };
}

function getExceptionStatusCode(error: AppException): 400 | 401 | 403 | 404 | 422 | 429 | 500 | 504 {
  if (error instanceof ModelNotFoundException) return 404;
  if (error instanceof ProviderNotFoundException) return 400;
  if (error instanceof ModelFailedException) return 422;
  if (error instanceof AllModelsFailedException) return 422;
  if (error instanceof ChainTimeoutException) return 504;

  if (
    error.status === 400 ||
    error.status === 401 ||
    error.status === 403 ||
    error.status === 404 ||
    error.status === 422 ||
    error.status === 429 ||
    error.status === 500 ||
    error.status === 504
  ) {
    return error.status;
  }

  if (error.type === 'unauthorized') return 401;
  if (error.type === 'forbidden') return 403;
  if (error.type === 'rate_limit') return 429;
  if (error.type === 'client_error') return 400;
  return 500;
}

// Create Anthropic SSE response generator
function createAnthropicSseResponse(message: AnthropicMessageResponse): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, payload: unknown) => {
        controller.enqueue(encoder.encode(formatSseEvent(event, payload)));
      };

      send('message_start', {
        type: 'message_start',
        message: {
          id: message.id,
          type: 'message',
          role: 'assistant',
          model: message.model,
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: message.usage?.input_tokens ?? 0,
            output_tokens: 0
          }
        }
      });

      const textBlocks = (message.content ?? []).filter((b) => b.type === 'text');
      const blocks = textBlocks.length > 0 ? textBlocks : [{ type: 'text', text: '' }];

      for (let index = 0; index < blocks.length; index++) {
        const block = blocks[index];
        const text = typeof block.text === 'string' ? block.text : '';

        send('content_block_start', {
          type: 'content_block_start',
          index,
          content_block: { type: 'text', text: '' }
        });

        for (const chunk of splitText(text)) {
          send('content_block_delta', {
            type: 'content_block_delta',
            index,
            delta: {
              type: 'text_delta',
              text: chunk
            }
          });
        }

        send('content_block_stop', {
          type: 'content_block_stop',
          index
        });
      }

      send('message_delta', {
        type: 'message_delta',
        delta: {
          stop_reason: message.stop_reason ?? 'end_turn',
          stop_sequence: null
        },
        usage: {
          output_tokens: message.usage?.output_tokens ?? 0
        }
      });

      send('message_stop', { type: 'message_stop' });
      controller.close();
    }
  });

  return new Response(stream, {
    headers: {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      connection: 'keep-alive'
    }
  });
}

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
    const models = ids.map((id) => createModelListEntry(id));

    return c.json({
      data: models,
      firstId: ids[0] ?? null,
      hasMore: false,
      lastId: ids[ids.length - 1] ?? null,
    });
  } catch (error) {
    logger.error('Failed to list models', { error: error instanceof Error ? error.message : String(error) });
    return c.json(
      createExceptionResponse('Failed to retrieve models list', 'internal_error', 'model_list_failed'),
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
      createExceptionResponse('Failed to retrieve providers list', 'internal_error', 'provider_list_failed'),
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
        createExceptionResponse(
          `Unknown provider: ${providerId}. Available providers: ${Object.keys(config.providers).join(', ')}`,
          'invalid_request_error',
          'provider_not_found',
          'providerId'
        ),
        404
      );
    }

    const models = (provider.models ?? []).map((modelEntry) => createModelListEntry(getModelName(modelEntry)));

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
      createExceptionResponse('Failed to retrieve provider models', 'internal_error', 'provider_models_failed'),
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
        createExceptionResponse(
          `Unknown provider: ${providerId}. Available providers: ${Object.keys(config.providers).join(', ')}`,
          'invalid_request_error',
          'provider_not_found',
          'providerId'
        ),
        404
      );
    }

    const providerWireFormat = inferProviderWireFormat(provider.baseUrl);
    const isAnthropicProvider = providerWireFormat === 'anthropic';
    const fakeModel = 'llm-fallback-proxy-fake-model';

    const url = buildProviderCompletionUrl(provider.baseUrl);
    let body: unknown;
    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (isAnthropicProvider) {
      headers['x-api-key'] = provider.apiKey;
      headers['anthropic-version'] = '2023-06-01';
      body = {
        model: fakeModel,
        messages: [{ role: 'user', content: 'test' }],
        max_tokens: 10,
        stream: false
      };
    } else {
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
          createExceptionResponse(
            `Request timeout while discovering status code for provider ${providerId}`,
            'timeout',
            'timeout'
          ),
          504
        );
      }

      throw error;
    }
  } catch (error) {
    logger.error('Failed to discover unknown model status code', { error: error instanceof Error ? error.message : String(error) });
    return c.json(
      createExceptionResponse(
        error instanceof Error ? error.message : 'Failed to discover status code',
        'internal_error',
        'discover_failed'
      ),
      500
    );
  }
});

// POST /v1/providers/:providerId/populate - Populate models array and optionally discover status code
app.post('/v1/providers/:providerId/populate', async (c) => {
  try {
    const providerId = c.req.param('providerId');
    const { discoverUnknownModelStatusCode, fetchModels } = await parsePopulateRequestBody(() => c.req.json());

    const config = getConfig();
    const provider = config.providers[providerId];

    if (!provider) {
      return c.json(
        createExceptionResponse(
          `Unknown provider: ${providerId}. Available providers: ${Object.keys(config.providers).join(', ')}`,
          'invalid_request_error',
          'provider_not_found',
          'providerId'
        ),
        404
      );
    }

    const result: {
      providerId: string;
      discovered?: {
        unknownModelStatusCodes?: number[];
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
      const providerWireFormat = inferProviderWireFormat(provider.baseUrl);
      const isAnthropicProvider = providerWireFormat === 'anthropic';
      const fakeModel = 'llm-fallback-proxy-fake-model';

      const url = buildProviderCompletionUrl(provider.baseUrl);
      let requestBody: unknown;
      const headers: Record<string, string> = {
        'Content-Type': 'application/json'
      };

      if (isAnthropicProvider) {
        headers['x-api-key'] = provider.apiKey;
        headers['anthropic-version'] = '2023-06-01';
        requestBody = {
          model: fakeModel,
          messages: [{ role: 'user', content: 'test' }],
          max_tokens: 10,
          stream: false
        };
      } else {
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
        provider.statusCodes ??= {};
        provider.statusCodes['unknown-model'] = Array.from(new Set([
          ...(provider.statusCodes['unknown-model'] ?? []),
          response.status
        ]));
        result.discovered.unknownModelStatusCodes = provider.statusCodes['unknown-model'];

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
      createExceptionResponse(
        error instanceof Error ? error.message : 'Failed to populate provider',
        'internal_error',
        'populate_failed'
      ),
      500
    );
  }
});

// POST /v1/chat/completions - Main chat completions endpoint with fallback
app.post(
  '/v1/chat/completions',
  zValidator('json', ChatCompletionRequestSchema, (result, c) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      const param = issue?.path?.join('.') || undefined;
      return invalidRequestResponse(c, issue?.message ?? 'Invalid request body', 'invalid_request', param);
    }
  }),
  async (c) => {
    const body = c.req.valid('json');
    const model = body.model;

    logger.info(`Received chat completion request`, { model, ...extractPromptMeta(body) });

    // Extract Authorization header from incoming request
    const authHeader = c.req.header('Authorization');

    // Execute model selection (combo fallback or direct provider model)
    const selectionResult = await executeModelSelection(model, body, authHeader);

    if (selectionResult.isOk) {
      return c.json(selectionResult.value);
    }

    const exception = selectionResult.error;
    const statusCode = getExceptionStatusCode(exception);

    logger.error(`Chat completion failed`, {
      error: exception.message,
      type: exception.type
    });

    return c.json(exception.toResponse(), statusCode);
  }
);

// POST /v1/messages - Anthropic-format messages endpoint (Claude CLI uses this)
app.post(
  '/v1/messages',
  zValidator('json', AnthropicRequestSchema, (result, c) => {
    if (!result.success) {
      const issue = result.error.issues[0];
      const param = issue?.path?.join('.') || undefined;
      return invalidRequestResponse(c, issue?.message ?? 'Invalid request body', 'invalid_request', param);
    }
  }),
  async (c) => {
    const body = c.req.valid('json');
    const model = body.model;

    logger.info(`Received Anthropic messages request`, { model, stream: !!body.stream, ...extractPromptMeta(body) });

    const authHeader = c.req.header('Authorization');

    // Execute model selection (combo fallback or direct provider model)
    const selectionResult = await executeModelSelection(model, body, authHeader, 'anthropic');

    if (!selectionResult.isOk) {
      const exception = selectionResult.error;
      const statusCode = getExceptionStatusCode(exception);

      logger.error(`Anthropic messages failed`, {
        error: exception.message,
        type: exception.type
      });

      return c.json(exception.toResponse(), statusCode);
    }

    const response = selectionResult.value;
    if (body.stream) {
      if (!isAnthropicMessageResponse(response)) {
        throw new Error('Invalid Anthropic message response for streaming');
      }
      return createAnthropicSseResponse(response);
    }

    return c.json(response);
  }
);

export default app;

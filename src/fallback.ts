// ABOUTME: Core model execution logic with combo-chain fallback across providers/models
// ABOUTME: Resolves model selection and attempts subsequent models when retryable failures occur

import { getConfig, updateConfig, saveConfig, ProviderConfig, ModelRef, Config, getModelName, getModelQuota } from './config.js';
import { logger } from './logger.js';
import { QuotaManager } from './quota.js';
import { tryFn } from './defineTryFn.js';
import { err, ok, type Result } from '@primitivestack/core';
import { z } from 'zod';
import {
  type ProviderErrorPayload,
  type RetryableException,
  type SelectionException,
  AbortException,
  AllModelsFailedException,
  ChainTimeoutException,
  ModelFailedException,
  ModelNotFoundException,
  ProviderNotFoundException,
  QuotaPacingViolationException,
  RateLimitException,
  ServerErrorException,
  TimeoutException,
  UnauthorizedException,
} from './exceptions.js';
import { buildProviderCompletionUrl, inferProviderWireFormat } from './provider-routing.js';
export interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string | unknown }>;
  [key: string]: unknown;
}

export const ChatCompletionRequestSchema = z.object({
  model: z.string().min(1, 'Model must be a non-empty string'),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(
          z.object({
            type: z.string().min(1, 'type must be a non-empty string')
          }).passthrough()
        )
      ])
    })
  ).min(1, 'messages must not be empty'),
  stream: z.boolean().optional(),
  temperature: z.number().optional(),
  top_p: z.number().optional(),
  max_tokens: z.number().optional(),
}).passthrough();

interface ChatCompletionResponse {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    message: { role: string; content: string };
    finish_reason: string;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
  };
}

// Anthropic API types
interface AnthropicRequest {
  model: string;
  messages: Array<{ role: string; content: string | unknown }>;
  max_tokens?: number;
  system?: string | unknown;
  stream?: boolean;
  thinking?: unknown;
  [key: string]: unknown;
}

interface AnthropicResponse {
  id: string;
  type: 'message';
  role: 'assistant';
  content: Array<{ type: string; text?: string; thinking?: string; [key: string]: unknown }>;
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens?: number;
    cache_read_input_tokens?: number;
  };
}

const ContentTextBlockSchema = z.object({
  type: z.string(),
  text: z.string().optional(),
  thinking: z.string().optional(),
}).passthrough();

const ProviderErrorPayloadSchema = z.object({
  message: z.string().optional(),
  type: z.string().optional(),
  param: z.string().optional(),
  code: z.string().optional(),
});

const ProviderErrorEnvelopeSchema = z.object({
  error: ProviderErrorPayloadSchema.optional(),
  message: z.string().optional(),
}).passthrough();

const OpenAIChoiceSchema = z.object({
  index: z.number(),
  message: z.object({
    role: z.string(),
    content: z.string(),
  }),
  finish_reason: z.string(),
});

const ChatCompletionResponseSchema = z.object({
  id: z.string(),
  object: z.string(),
  created: z.number(),
  model: z.string(),
  choices: z.array(OpenAIChoiceSchema),
  usage: z.object({
    prompt_tokens: z.number(),
    completion_tokens: z.number(),
    total_tokens: z.number(),
  }).optional(),
});

const AnthropicResponseSchema = z.object({
  id: z.string(),
  type: z.literal('message'),
  role: z.literal('assistant'),
  content: z.array(ContentTextBlockSchema),
  model: z.string(),
  stop_reason: z.string(),
  usage: z.object({
    input_tokens: z.number(),
    output_tokens: z.number(),
    cache_creation_input_tokens: z.number().optional(),
    cache_read_input_tokens: z.number().optional(),
  }),
});

const AnthropicMessageSchema = z.object({
  role: z.string(),
  content: z.union([z.string(), z.array(z.unknown())]),
});

export const AnthropicRequestSchema = z.object({
  model: z.string().min(1, 'Model must be a non-empty string'),
  messages: z.array(
    z.object({
      role: z.string(),
      content: z.union([
        z.string(),
        z.array(
          z.object({
            type: z.string().min(1, 'type must be a non-empty string')
          }).passthrough()
        )
      ])
    })
  ).min(1, 'messages must not be empty'),
  max_tokens: z.number().optional(),
  system: z.union([
    z.string(),
    z.array(
      z.object({
        type: z.string().min(1, 'type must be a non-empty string')
      }).passthrough()
    )
  ]).optional(),
  stream: z.boolean().optional(),
  thinking: z.unknown().optional(),
}).catchall(z.unknown());

type ProviderErrorEnvelope = z.infer<typeof ProviderErrorEnvelopeSchema>;

type ModelRequest = Record<string, unknown>;

function parseSystemTextBlocks(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => {
      const parsed = ContentTextBlockSchema.safeParse(block);
      if (!parsed.success) return '';
      return parsed.data.text || '';
    })
    .join('\n');
}

function parseMessageTextBlocks(value: unknown): string {
  if (!Array.isArray(value)) return '';
  return value
    .map((block) => ContentTextBlockSchema.safeParse(block))
    .filter((parsed) => parsed.success && parsed.data.type === 'text')
    .map((parsed) => (parsed.success ? parsed.data.text || '' : ''))
    .join('\n');
}

function parseProviderErrorEnvelope(raw: unknown): ProviderErrorEnvelope {
  const parsed = ProviderErrorEnvelopeSchema.safeParse(raw);
  if (!parsed.success) {
    return {};
  }
  return parsed.data;
}

function parseChatCompletionResponse(raw: unknown): ChatCompletionResponse | null {
  const parsed = ChatCompletionResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

function parseAnthropicResponse(raw: unknown): AnthropicResponse | null {
  const parsed = AnthropicResponseSchema.safeParse(raw);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

function parseRequestAsAnthropic(input: ModelRequest): AnthropicRequest | null {
  const parsed = AnthropicRequestSchema.safeParse(input);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

function convertAnthropicToOpenAIForRequest(
  request: ModelRequest,
  modelName: string
): ChatCompletionRequest {
  const parsed = parseRequestAsAnthropic(request);
  if (!parsed) {
    return {
      ...request,
      model: modelName,
      stream: false,
      messages: [],
    };
  }

  return {
    ...anthropicToOpenAI(parsed),
    model: modelName,
  };
}

function convertAnthropicToChatCompletion(anthRes: AnthropicResponse): ChatCompletionResponse {
  const textContent = anthRes.content.find((c) => c.type === 'text');
  return {
    id: anthRes.id,
    object: 'chat.completion',
    created: Date.now(),
    model: anthRes.model,
    choices: [{
      index: 0,
      message: { role: 'assistant', content: textContent?.text || '' },
      finish_reason: anthRes.stop_reason === 'end_turn' ? 'stop' : anthRes.stop_reason,
    }],
    usage: {
      prompt_tokens: anthRes.usage?.input_tokens || 0,
      completion_tokens: anthRes.usage?.output_tokens || 0,
      total_tokens: (anthRes.usage?.input_tokens || 0) + (anthRes.usage?.output_tokens || 0),
    },
  };
}

interface QuotaExhaustedCacheEntry {
  status: number;
  expiresAtMs: number;
}

const DEFAULT_QUOTA_EXHAUSTED_CACHE_TTL_SECONDS = 120;
const DEFAULT_CHAIN_MAX_DURATION_MS = 45_000;
const quotaExhaustedCacheByProvider = new Map<string, QuotaExhaustedCacheEntry>();

function getQuotaExhaustedStatusCodes(provider: ProviderConfig): number[] {
  return provider.statusCodes?.quotaExhausted ?? [];
}

function getUnknownModelStatusCodes(provider: ProviderConfig): number[] {
  return provider.statusCodes?.['unknown-model'] ?? [];
}

function getProviderQuotaCacheKey(providerId: string, provider: ProviderConfig): string {
  return `${providerId}:${provider.baseUrl}`;
}

function isProviderQuotaExhaustedCached(cacheKey: string): QuotaExhaustedCacheEntry | null {
  const entry = quotaExhaustedCacheByProvider.get(cacheKey);
  if (!entry) {
    return null;
  }
  if (entry.expiresAtMs <= Date.now()) {
    quotaExhaustedCacheByProvider.delete(cacheKey);
    return null;
  }
  return entry;
}

function isRetryableStatusCode(status: number): boolean {
  return status === 401 || status === 429 || (status >= 500 && status < 600);
}

function getChainMaxDurationMs(): number {
  const raw = process.env.CHAIN_MAX_DURATION_MS;
  if (!raw) return DEFAULT_CHAIN_MAX_DURATION_MS;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_CHAIN_MAX_DURATION_MS;
  }

  return Math.floor(parsed);
}

// Convert Anthropic messages request to OpenAI chat completions format
function anthropicToOpenAI(req: AnthropicRequest): ChatCompletionRequest {
  const messages: Array<{ role: string; content: string | unknown }> = [];

  // Convert system prompt to system message
  if (req.system) {
    if (typeof req.system === 'string') {
      messages.push({ role: 'system', content: req.system });
    } else if (Array.isArray(req.system)) {
      const text = parseSystemTextBlocks(req.system);
      messages.push({ role: 'system', content: text });
    }
  }

  // Convert messages (handle content blocks)
  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // Flatten content blocks to text
      const text = parseMessageTextBlocks(msg.content);
      messages.push({ role: msg.role, content: text || '' });
    } else {
      messages.push(msg);
    }
  }

  const result: ChatCompletionRequest = {
    model: req.model,
    messages,
    stream: false, // Never stream to backends (we translate the response)
  };

  if (req.max_tokens) {
    result.max_tokens = req.max_tokens;
  }

  // Pass through temperature, top_p, etc.
  for (const key of ['temperature', 'top_p', 'top_k', 'stop']) {
    if (req[key] !== undefined) {
      result[key] = req[key];
    }
  }

  return result;
}

// Convert OpenAI chat completion response to Anthropic messages format
function openAIToAnthropic(res: ChatCompletionResponse, modelName: string): AnthropicResponse {
  const choice = res.choices?.[0];
  const content: Array<{ type: string; text?: string }> = [];

  if (choice?.message?.content) {
    content.push({ type: 'text', text: choice.message.content });
  }

  return {
    id: res.id || `msg_${Date.now()}`,
    type: 'message',
    role: 'assistant',
    content,
    model: modelName,
    stop_reason: choice?.finish_reason === 'stop' ? 'end_turn' : (choice?.finish_reason || 'end_turn'),
    usage: {
      input_tokens: res.usage?.prompt_tokens || 0,
      output_tokens: res.usage?.completion_tokens || 0,
    },
  };
}

// Flatten combo chain into individual model refs with runtime cycle detection
function resolveComboChain(
  comboName: string,
  visited: Set<string> = new Set()
): ModelRef[] {
  const config = getConfig();
  const combo = config.combos[comboName];

  if (!combo) {
    throw new Error(`Unknown combo: ${comboName}`);
  }

  // Runtime cycle detection
  if (visited.has(comboName)) {
    throw new Error(`Circular reference detected at runtime: ${comboName} in ${Array.from(visited).join(' -> ')}`);
  }

  const newVisited = new Set(visited).add(comboName);
  const result: ModelRef[] = [];

  for (const modelRef of combo.models) {
    // If no provider specified and it references another combo, expand it
    if (!modelRef.provider && config.combos[modelRef.model]) {
      const nestedModels = resolveComboChain(modelRef.model, newVisited);
      result.push(...nestedModels);
    } else {
      // Direct model reference (including "all" special reference)
      if (!modelRef.provider) {
        throw new Error(`Model "${modelRef.model}" in combo "${comboName}" has no provider and is not a known combo`);
      }
      result.push(modelRef);
    }
  }

  return result;
}

function resolveDirectModelChain(requestedModel: string, config: Config): ModelRef[] {
  const directMatches: ModelRef[] = [];
  for (const [providerId, provider] of Object.entries(config.providers)) {
    const hasModel = (provider.models ?? []).some(m => getModelName(m) === requestedModel);
    if (hasModel) {
      directMatches.push({ provider: providerId, model: requestedModel });
    }
  }

  return directMatches;
}

async function executeModelRequest(
  provider: ProviderConfig,
  providerId: string,
  modelName: string,
  request: ModelRequest,
  inputFormat: 'anthropic' | 'openai',
  authHeader?: string,
  requestTimeoutMs?: number
): Promise<Result<AnthropicResponse | ChatCompletionResponse, RetryableException>> {
  const providerWireFormat = inferProviderWireFormat(provider.baseUrl);
  const providerIsAnthropic = providerWireFormat === 'anthropic';
  const providerQuotaCacheKey = getProviderQuotaCacheKey(providerId, provider);
  const quotaExhaustedStatusCodes = getQuotaExhaustedStatusCodes(provider);
  const unknownModelStatusCodes = getUnknownModelStatusCodes(provider);

  const cachedQuotaExhausted = isProviderQuotaExhaustedCached(providerQuotaCacheKey);
  if (cachedQuotaExhausted) {
    logger.warn(`Provider skipped due to cached quota exhaustion`, {
      provider: provider.baseUrl,
      providerId,
      status: cachedQuotaExhausted.status,
      retryAfterMs: cachedQuotaExhausted.expiresAtMs - Date.now()
    });
    return err(new RateLimitException('Provider quota exhaustion is cached', cachedQuotaExhausted.status));
  }

  // Determine endpoint and request body based on provider format
  let url: string;
  let body: unknown;

  if (providerIsAnthropic) {
    // Provider expects Anthropic format
    url = buildProviderCompletionUrl(provider.baseUrl);
    body = { ...request, model: modelName, stream: false };
  } else {
    // Provider expects OpenAI format - translate if incoming is Anthropic
    url = buildProviderCompletionUrl(provider.baseUrl);
    if (inputFormat === 'anthropic') {
      body = convertAnthropicToOpenAIForRequest(request, modelName);
    } else {
      body = { ...request, model: modelName };
    }
  }

  const controller = new AbortController();
  const effectiveTimeoutMs = requestTimeoutMs ? Math.min(provider.timeout, requestTimeoutMs) : provider.timeout;
  let didTimeout = false;
  const timeoutId = setTimeout(() => {
    didTimeout = true;
    controller.abort();
  }, effectiveTimeoutMs);

  try {
    logger.debug(`Attempting model`, {
      provider: provider.baseUrl,
      model: modelName,
      timeout: effectiveTimeoutMs
    });

    const headers: Record<string, string> = {
      'Content-Type': 'application/json'
    };

    if (provider.apiKey) {
      if (providerIsAnthropic) {
        headers['x-api-key'] = provider.apiKey;
        headers['anthropic-version'] = '2023-06-01';
      } else {
        headers['Authorization'] = `Bearer ${provider.apiKey}`;
      }
    } else if (authHeader) {
      headers['Authorization'] = authHeader;
    }

    const [response, requestError] = await tryFn(fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    }));

    if (requestError) {
      if (requestError.name === 'AbortError') {
        if (didTimeout) {
          logger.warn(`Request timeout`, {
            provider: provider.baseUrl,
            model: modelName,
            timeout: effectiveTimeoutMs
          });
          return err(new TimeoutException(`Request timed out after ${effectiveTimeoutMs}ms`));
        }

        logger.warn(`Connection aborted`, {
          provider: provider.baseUrl,
          model: modelName
        });
        return err(new AbortException('Connection aborted'));
      }

      logger.error(`Unknown error executing request`, {
        provider: provider.baseUrl,
        model: modelName,
        error: requestError.message
      });
      return err(new ServerErrorException(requestError.message || 'Request failed', 0));
    }

    const status = response.status;

    if (quotaExhaustedStatusCodes.length > 0 && quotaExhaustedStatusCodes.includes(status)) {
      const ttlSeconds = provider.quotaExhaustedCacheTTLSeconds ?? DEFAULT_QUOTA_EXHAUSTED_CACHE_TTL_SECONDS;
      quotaExhaustedCacheByProvider.set(providerQuotaCacheKey, {
        status,
        expiresAtMs: Date.now() + (ttlSeconds * 1000)
      });
      logger.warn(`Cached provider quota exhaustion status`, {
        provider: provider.baseUrl,
        providerId,
        model: modelName,
        status,
        ttlSeconds
      });
    } else {
      quotaExhaustedCacheByProvider.delete(providerQuotaCacheKey);
    }

    // Auto-delete logic for unknown model errors
    if (!response.ok && unknownModelStatusCodes.includes(status)) {
      if (provider.autoDeleteModels && provider.models && provider.models.some(m => getModelName(m) === modelName)) {
        const config = getConfig();

        // Remove model from provider's models array
        const updatedProvider = { ...provider, models: provider.models.filter(m => getModelName(m) !== modelName) };
        config.providers[providerId] = updatedProvider;

        logger.warn(`Auto-deleted model "${modelName}" from provider "${providerId}" due to status ${status}`, {
          provider: provider.baseUrl,
          model: modelName,
          statusCode: status
        });

        // Update in-memory config
        updateConfig(config);

        // Optionally persist to disk
        if (provider.persistAutoDeletedModels) {
          const [, saveError] = await tryFn(saveConfig(config));
          if (saveError) {
            logger.error('Failed to persist config after auto-deleting model', {
              error: saveError.message
            });
          }
        }
      }
    }

    if (!response.ok) {
      const [errorDataRaw] = await tryFn(response.json());
      const errorData = parseProviderErrorEnvelope(errorDataRaw);
      const errorMessage = errorData.error?.message || errorData.message || response.statusText;

      if (quotaExhaustedStatusCodes.length > 0 && quotaExhaustedStatusCodes.includes(status)) {
        logger.warn(`Configured quota exhaustion status from provider`, {
          provider: provider.baseUrl,
          model: modelName,
          status,
          error: errorMessage
        });
        return err(new RateLimitException(errorMessage, status, errorData.error));
      }

      // Check if 400 error should be retryable (model not supported)
      if (status === 400) {
        const msg = errorMessage.toLowerCase();
        const isModelNotSupported = msg.includes('model') &&
                                    (msg.includes('not supported') || msg.includes('not found'));

        if (isModelNotSupported) {
          logger.warn(`Retryable model error from provider`, {
            provider: provider.baseUrl, model: modelName, status, error: errorMessage
          });
          return err(new ServerErrorException(errorMessage, status, errorData.error));
        }
      }

      if (isRetryableStatusCode(status)) {
        logger.warn(`Retryable error from provider`, {
          provider: provider.baseUrl, model: modelName, status, error: errorMessage
        });
        if (status === 401) {
          return err(new UnauthorizedException(errorMessage, errorData.error));
        }
        if (status === 429) {
          return err(new RateLimitException(errorMessage, status, errorData.error));
        }
        return err(new ServerErrorException(errorMessage, status, errorData.error));
      }

      logger.warn(`Non-fail-fast provider error, treating as retryable`, {
        provider: provider.baseUrl, model: modelName, status, error: errorMessage
      });
      return err(new ServerErrorException(errorMessage, status, errorData.error));
    }

    const [data, parseError] = await tryFn(response.json());
    if (parseError) {
      logger.error('Failed to parse successful provider response', {
        provider: provider.baseUrl,
        model: modelName,
        status: response.status,
        error: parseError.message
      });
      return err(new ServerErrorException(parseError.message || 'Failed to parse provider response', 502));
    }

    const parsedOpenAI = parseChatCompletionResponse(data);
    const parsedAnthropic = parseAnthropicResponse(data);

    if (!parsedOpenAI && !parsedAnthropic) {
      logger.error('Successful provider response has invalid shape', {
        provider: provider.baseUrl,
        model: modelName,
        status: response.status
      });
      return err(new ServerErrorException('Failed to parse provider response', 502));
    }

    const responseId = parsedOpenAI?.id ?? parsedAnthropic?.id ?? 'unknown';
    quotaExhaustedCacheByProvider.delete(providerQuotaCacheKey);
    logger.info(`Successfully executed model`, {
      provider: provider.baseUrl,
      model: modelName,
      id: responseId
    });

    // Translate response back to caller's expected format
    if (inputFormat === 'anthropic' && !providerIsAnthropic) {
      if (!parsedOpenAI) {
        return err(new ServerErrorException('Provider response format mismatch', 502));
      }
      return ok(openAIToAnthropic(parsedOpenAI, modelName));
    }

    if (inputFormat === 'openai' && providerIsAnthropic) {
      if (!parsedAnthropic) {
        return err(new ServerErrorException('Provider response format mismatch', 502));
      }
      return ok(convertAnthropicToChatCompletion(parsedAnthropic));
    }

    if (parsedAnthropic) {
      return ok(parsedAnthropic);
    }

    if (parsedOpenAI) {
      return ok(parsedOpenAI);
    }

    return err(new ServerErrorException('Failed to parse provider response', 502));
  } finally {
    clearTimeout(timeoutId);
  }
}

async function executeResolvedChain(
  chainLabel: string,
  modelChain: ModelRef[],
  request: ModelRequest,
  requestTargetForErrors: string,
  authHeader?: string,
  inputFormat: 'anthropic' | 'openai' = 'openai'
): Promise<Result<AnthropicResponse | ChatCompletionResponse, SelectionException>> {
  const config = getConfig();
  const chainMaxDurationMs = getChainMaxDurationMs();
  const chainStartMs = Date.now();
  const chainDeadlineMs = chainStartMs + chainMaxDurationMs;
  logger.info(`Executing model chain`, {
    chainLabel,
    requestedModel: requestTargetForErrors,
    chainLength: modelChain.length,
    chain: modelChain.map(m => `${m.provider}:${m.model}`).join(' -> '),
    maxDurationMs: chainMaxDurationMs
  });

  const defaultFailFastStatusCodes = new Set([400, 401, 403]);
  let lastFailureMessage = 'unknown_error';
  let attempts = 0;

  for (let index = 0; index < modelChain.length; index++) {
    const modelRef = modelChain[index];
    const remainingChainMs = chainDeadlineMs - Date.now();
    if (remainingChainMs <= 0) {
      logger.error(`Chain timed out before next model attempt`, {
        chainLabel,
        requestedModel: requestTargetForErrors,
        elapsedMs: Date.now() - chainStartMs,
        maxDurationMs: chainMaxDurationMs,
        attempts
      });
      return err(new ChainTimeoutException(
        `Model chain "${requestTargetForErrors}" exceeded ${chainMaxDurationMs}ms after ${attempts} attempt(s)`
      ));
    }

    const provider = config.providers[modelRef.provider!];
    if (!provider) {
      logger.error(`Provider not found`, { provider: modelRef.provider });
      return err(new ProviderNotFoundException(`Provider not found for "${requestTargetForErrors}": ${modelRef.provider}`));
    }

    attempts += 1;

    const modelEntry = provider.models?.find(m => getModelName(m) === modelRef.model);
    const modelQuota = modelEntry ? getModelQuota(modelEntry) : undefined;
    const effectiveQuota = modelQuota || provider.quota;
    if (effectiveQuota) {
      const quotaManager = QuotaManager.getInstance();
      const cacheKey = modelQuota ? `${modelRef.provider!}-${modelRef.model}` : modelRef.provider!;
      const isAllowed = await quotaManager.checkPacing(cacheKey, effectiveQuota);
      if (!isAllowed) {
        const quotaResult = err(new QuotaPacingViolationException());
        const errorObj = quotaResult.error;
        lastFailureMessage = `${provider.baseUrl}:${modelRef.model} - ${errorObj.providerError?.message ?? errorObj.message}`;

        const configuredFailFast = provider.statusCodes?.['fail-fast'] ?? [];
        const isFailFastStatus =
          typeof errorObj.status === 'number' &&
          (defaultFailFastStatusCodes.has(errorObj.status) || configuredFailFast.includes(errorObj.status));
        const isLastModel = index === modelChain.length - 1;

        if (isFailFastStatus) {
          logger.error(`Model chain aborted on fail-fast status`, {
            chainLabel,
            requestedModel: requestTargetForErrors,
            provider: provider.baseUrl,
            model: modelRef.model,
            status: errorObj.status,
            error: errorObj.providerError?.message ?? errorObj.message
          });
          return err(new ModelFailedException(
            `Model "${requestTargetForErrors}" failed with fail-fast status ${errorObj.status}: ${lastFailureMessage}`
          ));
        }

        if (isLastModel && errorObj.type === 'rate_limit') {
          logger.error(`Model chain ended with terminal rate limit`, {
            chainLabel,
            requestedModel: requestTargetForErrors,
            attempts,
            status: errorObj.status ?? null,
            lastError: errorObj.providerError?.message ?? errorObj.message
          });
          return err(errorObj);
        }

        if (isLastModel) {
          logger.error(`All models in chain failed`, {
            chainLabel,
            requestedModel: requestTargetForErrors,
            attempts,
            lastError: errorObj.providerError?.message ?? errorObj.message
          });
          return err(new AllModelsFailedException(
            `All ${attempts} model attempt(s) failed for "${requestTargetForErrors}". Last failure: ${lastFailureMessage}`
          ));
        }

        logger.warn(`Model attempt failed; trying next fallback`, {
          chainLabel,
          requestedModel: requestTargetForErrors,
          provider: provider.baseUrl,
          model: modelRef.model,
          status: errorObj.status ?? null,
          error: errorObj.providerError?.message ?? errorObj.message,
          nextModel: `${modelChain[index + 1].provider}:${modelChain[index + 1].model}`
        });

        continue;
      }
    }

    const requestResult = await executeModelRequest(
      provider,
      modelRef.provider!,
      modelRef.model,
      request,
      inputFormat,
      authHeader,
      remainingChainMs
    );

    if (requestResult.isOk) {
      return ok(requestResult.value);
    }

    const errorObj = requestResult.error;
    const resolvedProviderErrorMessage = errorObj.providerError?.message || errorObj.message || errorObj.type;
    lastFailureMessage = `${provider.baseUrl}:${modelRef.model} - ${resolvedProviderErrorMessage}`;

    const configuredFailFast = provider.statusCodes?.['fail-fast'] ?? [];
    const isFailFastStatus =
      typeof errorObj.status === 'number' &&
      (defaultFailFastStatusCodes.has(errorObj.status) || configuredFailFast.includes(errorObj.status));
    const isLastModel = index === modelChain.length - 1;

    if (isFailFastStatus) {
      logger.error(`Model chain aborted on fail-fast status`, {
        chainLabel,
        requestedModel: requestTargetForErrors,
        provider: provider.baseUrl,
        model: modelRef.model,
        status: errorObj.status,
        error: resolvedProviderErrorMessage
      });
      return err(new ModelFailedException(
        `Model "${requestTargetForErrors}" failed with fail-fast status ${errorObj.status}: ${lastFailureMessage}`
      ));
    }

    if (isLastModel && errorObj.type === 'rate_limit') {
      logger.error(`Model chain ended with terminal rate limit`, {
        chainLabel,
        requestedModel: requestTargetForErrors,
        attempts,
        status: errorObj.status ?? null,
        lastError: resolvedProviderErrorMessage
      });
      return err(errorObj);
    }

    if (isLastModel) {
      logger.error(`All models in chain failed`, {
        chainLabel,
        requestedModel: requestTargetForErrors,
        attempts,
        lastError: resolvedProviderErrorMessage
      });
      return err(new AllModelsFailedException(
        `All ${attempts} model attempt(s) failed for "${requestTargetForErrors}". Last failure: ${lastFailureMessage}`
      ));
    }

    logger.warn(`Model attempt failed; trying next fallback`, {
      chainLabel,
      requestedModel: requestTargetForErrors,
      provider: provider.baseUrl,
      model: modelRef.model,
      status: errorObj.status ?? null,
      error: resolvedProviderErrorMessage,
      nextModel: `${modelChain[index + 1].provider}:${modelChain[index + 1].model}`
    });
  }

  return err(new AllModelsFailedException(
    `All model attempts failed for "${requestTargetForErrors}". Last failure: ${lastFailureMessage}`
  ));
}

export async function executeComboFallback(
  comboName: string,
  request: ModelRequest,
  authHeader?: string,
  inputFormat: 'anthropic' | 'openai' = 'openai'
): Promise<Result<AnthropicResponse | ChatCompletionResponse, SelectionException>> {
  const modelChain = resolveComboChain(comboName);
  return executeResolvedChain(`combo:${comboName}`, modelChain, request, comboName, authHeader, inputFormat);
}

export async function executeModelSelection(
  requestedModel: string,
  request: ModelRequest,
  authHeader?: string,
  inputFormat: 'anthropic' | 'openai' = 'openai'
): Promise<Result<AnthropicResponse | ChatCompletionResponse, SelectionException>> {
  const config = getConfig();

  if (config.combos[requestedModel]) {
    return executeComboFallback(requestedModel, request, authHeader, inputFormat);
  }

  const directChain = resolveDirectModelChain(requestedModel, config);
  if (directChain.length === 0) {
    return err(new ModelNotFoundException(
      `Unknown model: ${requestedModel}. Available models: ${[
        ...Object.keys(config.combos),
        ...Object.values(config.providers).flatMap(provider => (provider.models ?? []).map(m => getModelName(m)))
      ].join(', ')}`
    ));
  }

  return executeResolvedChain(`direct:${requestedModel}`, directChain, request, requestedModel, authHeader, inputFormat);
}

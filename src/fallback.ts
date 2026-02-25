// ABOUTME: Core fallback execution logic with retry handling
// ABOUTME: Resolves combo chains and tries each model with proper error classification

import { getConfig, updateConfig, saveConfig, ProviderConfig, ModelRef, Config, getModelName, getModelQuota } from './config.js';
import { logger } from './logger.js';
import { QuotaManager } from './quota.js';

interface ChatCompletionRequest {
  model: string;
  messages: Array<{ role: string; content: string | unknown }>;
  [key: string]: unknown;
}

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

export interface ErrorResponse {
  error: {
    message: string;
    type: string;
    param?: string;
    code?: string;
  };
}

interface ProviderErrorPayload {
  message?: string;
  type?: string;
  param?: string;
  code?: string;
}

type RetryableError =
  | { type: 'rate_limit'; status: 429 }
  | { type: 'server_error'; status: number }
  | { type: 'timeout' }
  | { type: 'abort' }
  | { type: 'quota_pacing_violation'; status: 429 };

type FailFastError =
  | { type: 'client_error'; status: number }
  | { type: 'unauthorized'; status: 401 }
  | { type: 'forbidden'; status: 403 };

function isRetryableStatusCode(status: number): boolean {
  return status === 401 || status === 429 || (status >= 500 && status < 600);
}

function isFailFastStatusCode(status: number): boolean {
  return status === 400 || status === 403;
}

function isAnthropicProvider(baseUrl: string): boolean {
  return baseUrl.includes('anthropic') || baseUrl.includes('z.ai');
}

// Convert Anthropic messages request to OpenAI chat completions format
function anthropicToOpenAI(req: AnthropicRequest): ChatCompletionRequest {
  const messages: Array<{ role: string; content: string | unknown }> = [];

  // Convert system prompt to system message
  if (req.system) {
    if (typeof req.system === 'string') {
      messages.push({ role: 'system', content: req.system });
    } else if (Array.isArray(req.system)) {
      const text = (req.system as Array<{ text?: string }>)
        .map(b => b.text || '')
        .join('\n');
      messages.push({ role: 'system', content: text });
    }
  }

  // Convert messages (handle content blocks)
  for (const msg of req.messages) {
    if (typeof msg.content === 'string') {
      messages.push({ role: msg.role, content: msg.content });
    } else if (Array.isArray(msg.content)) {
      // Flatten content blocks to text
      const text = (msg.content as Array<{ type: string; text?: string }>)
        .filter(b => b.type === 'text')
        .map(b => b.text || '')
        .join('\n');
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
  request: AnthropicRequest | ChatCompletionRequest,
  inputFormat: 'anthropic' | 'openai',
  authHeader?: string
): Promise<AnthropicResponse | ChatCompletionResponse> {
  const providerIsAnthropic = isAnthropicProvider(provider.baseUrl);

  // Determine endpoint and request body based on provider format
  let url: string;
  let body: unknown;

  if (providerIsAnthropic) {
    // Provider expects Anthropic format
    url = `${provider.baseUrl}/v1/messages`;
    body = { ...request, model: modelName, stream: false };
  } else {
    // Provider expects OpenAI format - translate if incoming is Anthropic
    url = `${provider.baseUrl}/chat/completions`;
    if (inputFormat === 'anthropic') {
      body = { ...anthropicToOpenAI(request as AnthropicRequest), model: modelName };
    } else {
      body = { ...request, model: modelName };
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort();
  }, provider.timeout);

  try {
    logger.debug(`Attempting model`, {
      provider: provider.baseUrl,
      model: modelName,
      timeout: provider.timeout
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

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: controller.signal
    });

    clearTimeout(timeoutId);

    const status = response.status;

    // Auto-delete logic for unknown model errors
    if (!response.ok && provider.unknownModelStatusCode && status === provider.unknownModelStatusCode) {
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
          try {
            await saveConfig(config);
          } catch (error) {
            logger.error('Failed to persist config after auto-deleting model', {
              error: error instanceof Error ? error.message : String(error)
            });
          }
        }
      }
    }

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as {
        error?: ProviderErrorPayload;
        message?: string;
      };
      const errorMessage = errorData.error?.message || errorData.message || response.statusText;

      // Check if 400 error should be retryable (model not supported)
      if (status === 400) {
        const msg = errorMessage.toLowerCase();
        const isModelNotSupported = msg.includes('model') &&
                                    (msg.includes('not supported') || msg.includes('not found'));

        if (isModelNotSupported) {
          logger.warn(`Retryable model error from provider`, {
            provider: provider.baseUrl, model: modelName, status, error: errorMessage
          });
          throw { type: 'server_error' as const, status, error: errorData.error } as RetryableError;
        }
      }

      if (isFailFastStatusCode(status)) {
        logger.error(`Fail-fast error from provider`, {
          provider: provider.baseUrl, model: modelName, status, error: errorMessage
        });
        throw {
          type: status === 403 ? 'forbidden' : 'client_error', status, error: errorData.error
        } as FailFastError;
      }

      if (isRetryableStatusCode(status)) {
        logger.warn(`Retryable error from provider`, {
          provider: provider.baseUrl, model: modelName, status, error: errorMessage
        });
        throw {
          type: status === 401 ? 'unauthorized' : status === 429 ? 'rate_limit' : 'server_error',
          status, error: errorData.error
        } as RetryableError;
      }

      logger.error(`Unknown error from provider`, {
        provider: provider.baseUrl, model: modelName, status
      });
      throw { type: 'client_error', status, error: errorData.error } as FailFastError;
    }

    const data = await response.json() as AnthropicResponse | ChatCompletionResponse;
    logger.info(`Successfully executed model`, {
      provider: provider.baseUrl, model: modelName, id: data.id
    });

    // Translate response back to caller's expected format
    if (inputFormat === 'anthropic' && !providerIsAnthropic) {
      return openAIToAnthropic(data as ChatCompletionResponse, modelName);
    }
    if (inputFormat === 'openai' && providerIsAnthropic) {
      // Caller wants OpenAI format but got Anthropic - translate
      const anthRes = data as AnthropicResponse;
      const textContent = anthRes.content?.find(c => c.type === 'text');
      return {
        id: anthRes.id,
        object: 'chat.completion',
        created: Date.now(),
        model: anthRes.model,
        choices: [{
          index: 0,
          message: { role: 'assistant', content: textContent?.text || '' },
          finish_reason: anthRes.stop_reason === 'end_turn' ? 'stop' : anthRes.stop_reason
        }],
        usage: {
          prompt_tokens: anthRes.usage?.input_tokens || 0,
          completion_tokens: anthRes.usage?.output_tokens || 0,
          total_tokens: (anthRes.usage?.input_tokens || 0) + (anthRes.usage?.output_tokens || 0)
        }
      } as ChatCompletionResponse;
    }

    return data;
  } catch (error) {
    clearTimeout(timeoutId);

    // Re-throw typed errors
    if (error && typeof error === 'object' && 'type' in error) {
      throw error;
    }

    if (error instanceof Error) {
      if (error.name === 'AbortError') {
        logger.warn(`Request timeout`, {
          provider: provider.baseUrl, model: modelName, timeout: provider.timeout
        });
        throw { type: 'timeout' } as RetryableError;
      }

      if (error.message.includes('ECONNRESET') || error.message.includes('ECONNABORTED')) {
        logger.warn(`Connection aborted`, {
          provider: provider.baseUrl, model: modelName
        });
        throw { type: 'abort' } as RetryableError;
      }
    }

    logger.error(`Unknown error executing request`, {
      provider: provider.baseUrl, model: modelName,
      error: error instanceof Error ? error.message : String(error)
    });
    throw {
      type: 'client_error', status: 0,
      error: { message: error instanceof Error ? error.message : String(error), type: 'network_error' }
    } as FailFastError;
  }
}

async function executeResolvedChain(
  chainLabel: string,
  modelChain: ModelRef[],
  request: AnthropicRequest | ChatCompletionRequest,
  requestedModelForErrors: string,
  authHeader?: string,
  inputFormat: 'anthropic' | 'openai' = 'openai'
): Promise<AnthropicResponse | ChatCompletionResponse> {
  const config = getConfig();
  logger.info(`Executing model chain`, {
    chainLabel,
    requestedModel: requestedModelForErrors,
    chainLength: modelChain.length,
    chain: modelChain.map(m => `${m.provider}:${m.model}`).join(' -> ')
  });

  const errors: Array<{ provider: string; model: string; error: string }> = [];

  for (let chainIndex = 0; chainIndex < modelChain.length; chainIndex++) {
    const modelRef = modelChain[chainIndex];
    const provider = config.providers[modelRef.provider!];

    if (!provider) {
      logger.error(`Provider not found`, { provider: modelRef.provider });
      continue;
    }

    // Regular model reference
    try {
      // Check quota: model-level quota takes precedence over provider-level quota
      const modelEntry = provider.models?.find(m => getModelName(m) === modelRef.model);
      const modelQuota = modelEntry ? getModelQuota(modelEntry) : undefined;
      const effectiveQuota = modelQuota || provider.quota;

      if (effectiveQuota) {
        const quotaManager = QuotaManager.getInstance();
        // Use provider-model-modelName as the cache key for model-level quota
        const cacheKey = modelQuota ? `${modelRef.provider!}-${modelRef.model}` : modelRef.provider!;
        const isAllowed = await quotaManager.checkPacing(cacheKey, effectiveQuota);
        if (!isAllowed) {
          throw { type: 'quota_pacing_violation', status: 429, error: { message: 'QUOTA_PACING_VIOLATION' } } as RetryableError;
        }
      }

      const response = await executeModelRequest(provider, modelRef.provider!, modelRef.model, request, inputFormat, authHeader);

      if (chainIndex > 0) {
        logger.info(`Fallback succeeded after ${chainIndex} attempt(s)`, {
          chainLabel,
          requestedModel: requestedModelForErrors,
          successfulProvider: provider.baseUrl,
          successfulModel: modelRef.model,
          previousErrors: errors
        });
      }

      return response;
    } catch (error) {
      const errorObj = error as {
        type: string;
        status?: number;
        error?: ErrorResponse | ProviderErrorPayload;
      };
      const providerErrorMessage = (() => {
        if (!errorObj.error) {
          return errorObj.type;
        }
        if ('error' in errorObj.error) {
          return errorObj.error.error.message || errorObj.type;
        }
        return errorObj.error.message || errorObj.type;
      })();

      if (errorObj.type === 'client_error' || errorObj.type === 'forbidden') {
        logger.error(`Fail-fast error, stopping fallback chain`, {
          chainLabel,
          requestedModel: requestedModelForErrors,
          provider: provider.baseUrl,
          model: modelRef.model,
          status: errorObj.status,
          error: providerErrorMessage
        });

        throw {
          error: {
            message: `Client error from ${provider.baseUrl} for model ${modelRef.model}: ${providerErrorMessage}`,
            type: errorObj.type,
            code: errorObj.status?.toString(),
            param: undefined
          }
        } as ErrorResponse;
      }

      errors.push({
        provider: provider.baseUrl,
        model: modelRef.model,
        error: providerErrorMessage
      });

      logger.warn(`Model failed, trying next in chain`, {
        chainLabel,
        requestedModel: requestedModelForErrors,
        provider: provider.baseUrl,
        model: modelRef.model,
        error: providerErrorMessage,
        remaining: modelChain.length - chainIndex - 1
      });
    }
  }

  logger.error(`All models in chain failed`, { chainLabel, requestedModel: requestedModelForErrors, errors });

  throw {
    error: {
      message: `All models for "${requestedModelForErrors}" failed. Errors: ${errors.map(e => `${e.provider}:${e.model} - ${e.error}`).join('; ')}`,
      type: 'fallback_exhausted',
      code: 'all_models_failed'
    }
  } as ErrorResponse;
}

export async function executeComboFallback(
  comboName: string,
  request: AnthropicRequest | ChatCompletionRequest,
  authHeader?: string,
  inputFormat: 'anthropic' | 'openai' = 'openai'
): Promise<AnthropicResponse | ChatCompletionResponse> {
  const modelChain = resolveComboChain(comboName);
  return executeResolvedChain(`combo:${comboName}`, modelChain, request, comboName, authHeader, inputFormat);
}

export async function executeModelSelection(
  requestedModel: string,
  request: AnthropicRequest | ChatCompletionRequest,
  authHeader?: string,
  inputFormat: 'anthropic' | 'openai' = 'openai'
): Promise<AnthropicResponse | ChatCompletionResponse> {
  const config = getConfig();

  if (config.combos[requestedModel]) {
    return executeComboFallback(requestedModel, request, authHeader, inputFormat);
  }

  const directChain = resolveDirectModelChain(requestedModel, config);
  if (directChain.length === 0) {
    throw {
      error: {
        message: `Unknown model: ${requestedModel}. Available models: ${[
          ...Object.keys(config.combos),
          ...Object.values(config.providers).flatMap(provider => (provider.models ?? []).map(m => getModelName(m)))
        ].join(', ')}`,
        type: 'invalid_request_error',
        code: 'model_not_found',
        param: 'model'
      }
    } as ErrorResponse;
  }

  return executeResolvedChain(`direct:${requestedModel}`, directChain, request, requestedModel, authHeader, inputFormat);
}

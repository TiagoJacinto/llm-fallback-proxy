export interface ExceptionResponse {
  error: {
    message: string;
    type: string;
    param?: string;
    code?: string;
  };
}

export interface ProviderErrorPayload {
  message?: string;
  type?: string;
  param?: string;
  code?: string;
}

interface AppExceptionOptions {
  type: string;
  code?: string;
  param?: string;
  status?: number;
}

export class AppException extends Error {
  readonly type: string;
  readonly code?: string;
  readonly param?: string;
  readonly status?: number;

  constructor(message: string, options: AppExceptionOptions) {
    super(message);
    this.name = new.target.name;
    this.type = options.type;
    this.code = options.code;
    this.param = options.param;
    this.status = options.status;
  }

  toResponse(): ExceptionResponse {
    const response: ExceptionResponse = {
      error: {
        message: this.message,
        type: this.type,
      }
    };

    if (this.code !== undefined) {
      response.error.code = this.code;
    }

    if (this.param !== undefined) {
      response.error.param = this.param;
    }

    return response;
  }
}

class RetryableAppException extends AppException {
  readonly providerError?: ProviderErrorPayload;

  constructor(message: string, options: AppExceptionOptions & { providerError?: ProviderErrorPayload }) {
    super(message, options);
    this.providerError = options.providerError;
  }
}

export class InvalidRequestException extends AppException {
  constructor(message: string, code: string, param?: string) {
    super(message, {
      type: 'invalid_request_error',
      code,
      param,
      status: 400,
    });
  }
}

export class ModelNotFoundException extends AppException {
  constructor(message: string) {
    super(message, {
      type: 'invalid_request_error',
      code: 'model_not_found',
      param: 'model',
      status: 404,
    });
  }
}

export class ProviderNotFoundException extends AppException {
  constructor(message: string) {
    super(message, {
      type: 'invalid_request_error',
      code: 'provider_not_found',
      status: 400,
    });
  }
}

export class ModelFailedException extends AppException {
  constructor(message: string) {
    super(message, {
      type: 'model_execution_failed',
      code: 'model_failed',
      status: 422,
    });
  }
}

export class AllModelsFailedException extends AppException {
  constructor(message: string) {
    super(message, {
      type: 'model_execution_failed',
      code: 'all_models_failed',
      status: 422,
    });
  }
}

export class ChainTimeoutException extends AppException {
  constructor(message: string) {
    super(message, {
      type: 'timeout',
      code: 'chain_timeout',
      status: 504,
    });
  }
}

export class RateLimitException extends RetryableAppException {
  constructor(message: string, status: number = 429, providerError?: ProviderErrorPayload) {
    super(message, {
      type: 'rate_limit',
      status,
      providerError,
    });
  }
}

export class ServerErrorException extends RetryableAppException {
  constructor(message: string, status: number, providerError?: ProviderErrorPayload) {
    super(message, {
      type: 'server_error',
      status,
      providerError,
    });
  }
}

export class UnauthorizedException extends RetryableAppException {
  constructor(message: string = 'Unauthorized', providerError?: ProviderErrorPayload) {
    super(message, {
      type: 'unauthorized',
      status: 401,
      providerError,
    });
  }
}

export class TimeoutException extends RetryableAppException {
  constructor(message: string = 'Request timeout') {
    super(message, {
      type: 'timeout',
    });
  }
}

export class AbortException extends RetryableAppException {
  constructor(message: string = 'Connection aborted') {
    super(message, {
      type: 'abort',
    });
  }
}

export class QuotaPacingViolationException extends RetryableAppException {
  constructor(message: string = 'QUOTA_PACING_VIOLATION') {
    super(message, {
      type: 'quota_pacing_violation',
      status: 429,
      providerError: { message },
    });
  }
}

export type RetryableException =
  | RateLimitException
  | ServerErrorException
  | UnauthorizedException
  | TimeoutException
  | AbortException
  | QuotaPacingViolationException;

export type SelectionException =
  | InvalidRequestException
  | ModelNotFoundException
  | ProviderNotFoundException
  | ModelFailedException
  | AllModelsFailedException
  | ChainTimeoutException
  | RateLimitException;

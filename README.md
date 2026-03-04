# llm-fallback-proxy

Barebones LLM API proxy server with model fallback/cascade capabilities. When a model fails with retryable errors (429, 5xx, timeout, abort), automatically try the next model in the chain.

## Features

- OpenAI-compatible API (`/v1/chat/completions`, `/v1/models`)
- Configurable provider/combo chains with fallback support
- Hot-reload configuration changes
- Per-provider timeout configuration
- Automatic retry on: 429 (rate limit), 5xx (server errors), timeout, connection abort
- Fail-fast on: 400 (bad request), 401 (unauthorized), 403 (forbidden)
- Static and runtime circular reference detection

## Prerequisites

- **[Bun](https://bun.sh/)**

## Quick Start

1. **Clone and install dependencies:**
   ```bash
   git clone <repo-url>
   cd llm-fallback-proxy
   bun install
   ```

2. **Create configuration file:**
   ```bash
   cp config.json.example config.json
   ```
   Then edit `config.json` with your providers and API keys (see [Configuration](#configuration) below).

3. **Start the server:**
   ```bash
   bun run src/index.ts
   ```
   Or use the dev server with hot-reload:
   ```bash
   bun run dev
   ```

4. **Verify it's running:**
   ```bash
   curl http://localhost:8000/health
   ```

## Configuration

### 1. Create `config.json`

Copy the example configuration:
```bash
cp config.json.example config.json
```

Then edit `config.json` to define your providers and combo chains:

### 2. Configuration Structure

```json
{
  "providers": {
    "openai": {
      "baseUrl": "https://api.openai.com/v1",
      "description": "OpenAI API",
      "timeout": 30000
    },
    "anthropic": {
      "baseUrl": "https://api.anthropic.com/v1",
      "description": "Anthropic Claude API",
      "timeout": 30000
    }
  },
  "combos": {
    "gpt-4-fallback": {
      "description": "GPT-4 with fallback to GPT-3.5",
      "models": [
        { "provider": "openai", "model": "gpt-4-turbo" },
        { "provider": "openai", "model": "gpt-3.5-turbo" }
      ]
    },
    "mixed-tier": {
      "description": "Mix of providers",
      "models": [
        { "provider": "anthropic", "model": "claude-3-opus-20240229" },
        { "provider": "openai", "model": "gpt-4-turbo" }
      ]
    }
  }
}
```

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `8000` | Port the server listens on |
| `CHAIN_MAX_DURATION_MS` | unset | Maximum duration for a fallback chain (per request) |
| `LLM_FALLBACK_PROXY_LOG_FILE` | unset | Path to file for request/response logging |

## Usage

### Start the server

**Production:**
```bash
bun run src/index.ts
```

**Development (with hot-reload):**
```bash
bun run dev
```

The server runs on port 8000 by default (configure via `PORT` env var).

### API Endpoints

#### Health Check
```bash
curl http://localhost:8000/health
```

#### List Available Models
```bash
curl http://localhost:8000/v1/models
```

#### Chat Completions
```bash
curl -X POST http://localhost:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gpt-4-fallback",
    "messages": [{"role": "user", "content": "Hello!"}]
  }'
```

> **Note:** API keys are configured per-provider in `config.json`. The proxy handles authentication with upstream providers.

## Error Handling

| Retryable (next model) | Fail-fast (return error) |
|------------------------|--------------------------|
| 429 Too Many Requests  | 400 Bad Request |
| 500-599 Server errors  | 401 Unauthorized |
| Timeout (ETIMEDOUT)    | 403 Forbidden |
| Abort (ECONNRESET)     | |

## Combo Chaining

You can reference other combos in your models list to create fallback chains:

```json
{
  "combos": {
    "tier-1": {
      "description": "High quality models",
      "models": [
        { "provider": "provider-a", "model": "premium-model" }
      ]
    },
    "tier-2": {
      "description": "Fallback with tier-1 then local",
      "models": [
        { "model": "tier-1" },
        { "provider": "local", "model": "local-model" }
      ]
    }
  }
}
```

Circular references are detected both at load time and runtime.

## Dynamic Config Example

If you need a dynamic provider/combo setup (for example with CCS-managed providers), use `config.json` with a structure like:

```json
{
  "providers": {
    "ccs-agy": {
      "baseUrl": "http://127.0.0.1:8317/api/provider/agy",
      "description": "CLI Proxy Plus AGY (Managed by CCS)",
      "timeout": 30000,
      "apiKey": "ccs-internal-managed"
    },
    "z-ai": {
      "baseUrl": "https://api.z.ai/api/anthropic",
      "description": "z.ai API",
      "timeout": 30000,
      "apiKey": "YOUR_API_KEY_HERE"
    }
  },
  "combos": {
    "all-available-models": {
      "description": "Try all models from all providers in sequence",
      "models": [
        { "provider": "ccs-agy", "model": "all" },
        { "provider": "z-ai", "model": "all" }
      ]
    }
  }
}
```

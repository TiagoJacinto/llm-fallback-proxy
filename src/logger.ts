// ABOUTME: Simple structured logging to console
// ABOUTME: Log format: [timestamp] [level] message with optional context

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

type LogLevel = 'info' | 'warn' | 'error' | 'debug';

const LOG_FILE_PATH = process.env.LLM_FALLBACK_PROXY_LOG_FILE;

function writeToFile(line: string): void {
  if (!LOG_FILE_PATH) return;

  try {
    mkdirSync(dirname(LOG_FILE_PATH), { recursive: true });
    appendFileSync(LOG_FILE_PATH, `${line}\n`, 'utf8');
  } catch {
    // Keep logging resilient: file write failures must not break request handling.
  }
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatMessage(level: LogLevel, message: string, context?: Record<string, unknown>): string {
  const timestamp = formatTimestamp();
  const levelUpper = level.toUpperCase();
  const baseMessage = `[${timestamp}] [${levelUpper}] ${message}`;

  if (context && Object.keys(context).length > 0) {
    return `${baseMessage} ${JSON.stringify(context)}`;
  }

  return baseMessage;
}

export const logger = {
  info(message: string, context?: Record<string, unknown>): void {
    const line = formatMessage('info', message, context);
    console.log(line);
    writeToFile(line);
  },

  warn(message: string, context?: Record<string, unknown>): void {
    const line = formatMessage('warn', message, context);
    console.warn(line);
    writeToFile(line);
  },

  error(message: string, context?: Record<string, unknown>): void {
    const line = formatMessage('error', message, context);
    console.error(line);
    writeToFile(line);
  },

  debug(message: string, context?: Record<string, unknown>): void {
    const line = formatMessage('debug', message, context);
    console.debug(line);
    writeToFile(line);
  }
};

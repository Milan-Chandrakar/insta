import { config } from '../config.js';
import { addApiLog } from './api-logs.js';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldRetry(status, attempt, retries) {
  if (attempt >= retries) {
    return false;
  }

  return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
}

function redactUrl(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.searchParams.has('access_token')) {
      parsed.searchParams.set('access_token', '[redacted]');
    }
    return parsed.toString();
  } catch {
    return String(rawUrl).replace(/([?&]access_token=)[^&]+/i, '$1[redacted]');
  }
}

function describeError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = error.cause instanceof Error
    ? `; cause: ${error.cause.message}`
    : error.cause
      ? `; cause: ${String(error.cause)}`
      : '';
  return `${error.message}${cause}`;
}

export async function fetchWithPolicy(url, options = {}) {
  const timeoutMs = options.timeoutMs ?? config.http.timeoutMs;
  const retries = Number.isInteger(options.retries) ? options.retries : config.http.retries;
  const retryDelayMs = Number.isInteger(options.retryDelayMs) ? options.retryDelayMs : config.http.retryDelayMs;
  const logContext = options.logContext || {};
  const requestOptions = { ...options };
  delete requestOptions.timeoutMs;
  delete requestOptions.retries;
  delete requestOptions.retryDelayMs;
  delete requestOptions.logContext;
  let lastError = null;
  let lastStatus = null;
  const method = String(requestOptions.method || 'GET').toUpperCase();
  const service = logContext.service || 'http';
  const operation = logContext.operation || 'request';
  const safeUrl = redactUrl(url);

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        ...requestOptions,
        signal: controller.signal
      });
      clearTimeout(timer);
      lastStatus = response.status;

      if (shouldRetry(response.status, attempt, retries)) {
        await sleep(retryDelayMs * (attempt + 1));
        continue;
      }

      return response;
    } catch (error) {
      clearTimeout(timer);
      lastError = error;

      if (attempt >= retries) {
        break;
      }

      await sleep(retryDelayMs * (attempt + 1));
    }
  }

  const message = lastError instanceof Error
    ? `${service} ${operation} request failed for ${method} ${safeUrl}${lastStatus ? ` (last HTTP status ${lastStatus})` : ''}: ${describeError(lastError)}`
    : `${service} ${operation} request failed for ${method} ${safeUrl}${lastStatus ? ` (last HTTP status ${lastStatus})` : ''}`;

  addApiLog({
    service,
    operation,
    status: 'error',
    model: null,
    durationMs: null,
    usage: null,
    limits: null,
    http: {
      status: lastStatus || null
    },
    summary: `${service} request failed before a response was returned.`,
    error: message,
    details: {
      url: safeUrl,
      method,
      attempts: retries + 1,
      timeoutMs
    }
  });

  throw new Error(message);
}

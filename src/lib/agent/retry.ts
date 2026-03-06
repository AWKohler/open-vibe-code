/**
 * Retry logic with exponential backoff for transient errors.
 */

import { agentLog } from "./logger";
import { classifyError, type AgentError } from "./errors";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const MAX_DELAY_MS = 30000;

function getDelay(attempt: number): number {
  // Exponential backoff with jitter
  const exponential = BASE_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.random() * 500;
  return Math.min(exponential + jitter, MAX_DELAY_MS);
}

function isRetryable(error: AgentError): boolean {
  // quota_exceeded has retry-after of hours/days — never worth retrying inline
  return error.type === "rate_limit" || error.type === "network";
}

/**
 * Execute an async function with retry logic.
 * Only retries on transient errors (rate limit, network).
 * Does NOT retry auth errors, context overflow, or invalid requests.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  options?: {
    maxRetries?: number;
    onRetry?: (error: AgentError, attempt: number) => void;
    signal?: AbortSignal;
  }
): Promise<T> {
  const maxRetries = options?.maxRetries ?? MAX_RETRIES;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // Check if aborted before attempting
      if (options?.signal?.aborted) {
        throw new DOMException("Aborted", "AbortError");
      }

      return await fn();
    } catch (err) {
      // Don't retry abort errors
      if (err instanceof DOMException && err.name === "AbortError") {
        throw err;
      }

      const classified = classifyError(err);

      // Don't retry non-retryable errors
      if (!isRetryable(classified) || attempt >= maxRetries) {
        throw err;
      }

      const delay = classified.retryAfter
        ? classified.retryAfter * 1000
        : getDelay(attempt);

      agentLog.retry({
        attempt: attempt + 1,
        maxRetries,
        error: classified.message,
        delayMs: delay,
      });

      options?.onRetry?.(classified, attempt + 1);

      // Wait before retrying
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(resolve, delay);

        // Allow abort during wait
        if (options?.signal) {
          const onAbort = () => {
            clearTimeout(timer);
            reject(new DOMException("Aborted", "AbortError"));
          };
          options.signal.addEventListener("abort", onAbort, { once: true });
        }
      });
    }
  }

  // Should never reach here, but TypeScript needs it
  throw new Error("Retry loop exited unexpectedly");
}

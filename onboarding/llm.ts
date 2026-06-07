/**
 * onboarding/llm.ts — Stretch goal: Ollama onboarding summary
 *
 * Generates a plain-English onboarding summary after a successful hire by
 * calling a local Ollama model via its REST API.
 *
 * CONTRACT (non-negotiable):
 *  - Returns null on ANY error — Ollama not running, network error, timeout,
 *    model not found, malformed response — all cases return null, never throw.
 *  - The core provisioning flow must never depend on this module.
 *    Callers must fire-and-forget; they must never await this function inline.
 *  - All output goes to stderr only via the shared logger.
 *
 * Configuration (from environment):
 *  - OLLAMA_BASE_URL   default: http://localhost:11434
 *  - OLLAMA_MODEL      default: llama3
 *  - OLLAMA_TIMEOUT_MS default: 60000 (60 s — llama3 first-load can be slow)
 *
 * Implementation uses Node 20's built-in fetch — same REST call as the
 * `ollama` npm package, zero additional dependency.
 */

import { logger } from './logger';

/** Minimal employee fields needed to compose the onboarding prompt. */
export interface EmployeeSummaryInput {
  email:     string;
  full_name: string;
  role:      string;
}

/**
 * POST to Ollama /api/generate and return the generated summary string.
 *
 * Returns null (never throws) when Ollama is not running or any error occurs.
 * Debug-level log lines are emitted at each decision point so failures are
 * visible when LOG_LEVEL=debug without any noise at info level.
 */
export async function generateOnboardingSummary(
  employee:    EmployeeSummaryInput,
  grantedApps: string[],
): Promise<string | null> {
  const baseUrl = (process.env.OLLAMA_BASE_URL ?? 'http://localhost:11434').replace(/\/$/, '');
  const model   = process.env.OLLAMA_MODEL    ?? 'llama3';
  const timeoutMs = parseInt(process.env.OLLAMA_TIMEOUT_MS ?? '60000', 10);

  logger.debug('Ollama: attempting onboarding summary', { model, baseUrl, timeoutMs });

  try {
    const prompt =
      `You are an IT onboarding assistant. Write a brief, friendly one-paragraph ` +
      `summary confirming that a new employee has been onboarded.\n\n` +
      `Name: ${employee.full_name}\n` +
      `Email: ${employee.email}\n` +
      `Role: ${employee.role}\n` +
      `Applications granted: ${grantedApps.join(', ')}\n\n` +
      `Summary:`;

    // AbortController cleans up the timer if the request finishes early.
    const controller = new AbortController();
    const tid = setTimeout(() => {
      logger.debug('Ollama: request timed out', { model, timeoutMs });
      controller.abort();
    }, timeoutMs);

    let response: Response;
    try {
      response = await fetch(`${baseUrl}/api/generate`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ model, prompt, stream: false }),
        signal:  controller.signal,
      });
    } finally {
      clearTimeout(tid);
    }

    if (!response.ok) {
      logger.debug('Ollama: non-OK response — skipping summary', {
        status:     response.status,
        statusText: response.statusText,
        hint:       response.status === 404
          ? `Model "${model}" may not be pulled. Run: ollama pull ${model}`
          : 'Check Ollama logs for details.',
      });
      return null;
    }

    const data    = (await response.json()) as { response?: string };
    const summary = data.response?.trim();

    if (!summary) {
      logger.debug('Ollama: empty response body — skipping summary', { model });
      return null;
    }

    logger.debug('Ollama: summary generated successfully', {
      model,
      chars: summary.length,
    });
    return summary;

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Common cases: ECONNREFUSED (Ollama not running), AbortError (timeout).
    logger.debug('Ollama: call failed silently', {
      error: msg,
      hint:  msg.includes('ECONNREFUSED')
        ? 'Ollama is not running. Start it with: ollama serve'
        : msg.includes('abort') || msg.includes('Abort')
        ? `Request aborted after ${timeoutMs}ms timeout`
        : 'See error for details',
    });
    return null;
  }
}

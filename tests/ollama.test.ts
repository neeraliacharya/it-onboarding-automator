/**
 * tests/ollama.test.ts
 *
 * Tests for onboarding/llm.ts — generateOnboardingSummary().
 *
 * These tests mock the global `fetch` so Ollama does NOT need to be running.
 * No database access — this module is pure async I/O with a configurable HTTP call.
 *
 * Covers:
 *   - Happy path: valid JSON response → returns trimmed summary string
 *   - HTTP errors: 404 (model not found), 500, 503 → returns null
 *   - Network errors: ECONNREFUSED, AbortError (timeout), generic failure → returns null
 *   - Bad response bodies: empty string, whitespace, missing key, json() rejection → null
 *   - Environment variable overrides: OLLAMA_BASE_URL, OLLAMA_MODEL, OLLAMA_TIMEOUT_MS
 *   - Trailing slash in OLLAMA_BASE_URL is stripped
 *   - Contract: never throws — all failure modes resolve to null
 *   - Prompt content: includes employee name, email, role, and all granted apps
 *
 * Isolation: env vars are snapshotted + restored in afterEach; fetch is mocked
 * via jest.spyOn(global, 'fetch') and restored with jest.restoreAllMocks().
 */

import { generateOnboardingSummary, type EmployeeSummaryInput } from '../onboarding/llm';

// ── Fixtures ──────────────────────────────────────────────────────────────────

const EMPLOYEE: EmployeeSummaryInput = {
  email:     'alex.chen@example.com',
  full_name: 'Alex Chen',
  role:      'engineer',
};

const APPS = ['slack', 'google_workspace', 'jira'];

// ── Mock helpers ──────────────────────────────────────────────────────────────

/**
 * Creates a minimal Response-like object for mocking global fetch.
 * json() returns a resolved Promise (matching the real Fetch API).
 */
function mockResponse(
  body: unknown,
  ok     = true,
  status = 200,
): Response {
  return {
    ok,
    status,
    statusText: ok ? 'OK' : 'Error',
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

// ── Suite ─────────────────────────────────────────────────────────────────────

describe('generateOnboardingSummary (Ollama integration)', () => {
  let fetchSpy: jest.SpyInstance;
  let savedEnv: Record<string, string | undefined>;

  beforeEach(() => {
    // Snapshot the relevant env vars so afterEach can restore them exactly.
    savedEnv = {
      OLLAMA_BASE_URL:   process.env.OLLAMA_BASE_URL,
      OLLAMA_MODEL:      process.env.OLLAMA_MODEL,
      OLLAMA_TIMEOUT_MS: process.env.OLLAMA_TIMEOUT_MS,
    };

    // Set known defaults for every test (individual tests override as needed).
    process.env.OLLAMA_BASE_URL   = 'http://localhost:11434';
    process.env.OLLAMA_MODEL      = 'llama3';
    process.env.OLLAMA_TIMEOUT_MS = '60000';

    fetchSpy = jest.spyOn(global, 'fetch');
  });

  afterEach(() => {
    jest.restoreAllMocks();

    // Restore env to pre-test state.
    for (const [key, val] of Object.entries(savedEnv)) {
      if (val === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = val;
      }
    }
  });

  // ── Happy path ──────────────────────────────────────────────────────────────

  describe('happy path', () => {
    test('returns the trimmed summary string from Ollama', async () => {
      fetchSpy.mockResolvedValueOnce(
        mockResponse({ response: '  Welcome Alex Chen to the team!  ' }),
      );

      const result = await generateOnboardingSummary(EMPLOYEE, APPS);

      expect(result).toBe('Welcome Alex Chen to the team!');
    });

    test('calls the correct Ollama REST endpoint', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ response: 'Summary here.' }));

      await generateOnboardingSummary(EMPLOYEE, APPS);

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.objectContaining({
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    });

    test('sends model=llama3 and stream=false in the request body', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ response: 'Summary.' }));

      await generateOnboardingSummary(EMPLOYEE, APPS);

      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string) as Record<string, unknown>;
      expect(body.model).toBe('llama3');
      expect(body.stream).toBe(false);
      expect(typeof body.prompt).toBe('string');
    });
  });

  // ── HTTP error responses → null ─────────────────────────────────────────────

  describe('HTTP error responses → null', () => {
    test('404 (model not pulled) → null', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(null, false, 404));

      await expect(generateOnboardingSummary(EMPLOYEE, APPS)).resolves.toBeNull();
    });

    test('500 (Ollama internal error) → null', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(null, false, 500));

      await expect(generateOnboardingSummary(EMPLOYEE, APPS)).resolves.toBeNull();
    });

    test('503 (service unavailable) → null', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(null, false, 503));

      await expect(generateOnboardingSummary(EMPLOYEE, APPS)).resolves.toBeNull();
    });
  });

  // ── Network / connection errors → null ─────────────────────────────────────

  describe('network / connection errors → null', () => {
    test('ECONNREFUSED (Ollama not running) → null', async () => {
      const err = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), {
        code: 'ECONNREFUSED',
      });
      fetchSpy.mockRejectedValueOnce(err);

      await expect(generateOnboardingSummary(EMPLOYEE, APPS)).resolves.toBeNull();
    });

    test('AbortError (request timeout) → null', async () => {
      const abortErr = new DOMException('The operation was aborted.', 'AbortError');
      fetchSpy.mockRejectedValueOnce(abortErr);

      await expect(generateOnboardingSummary(EMPLOYEE, APPS)).resolves.toBeNull();
    });

    test('generic network failure → null', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('network failure'));

      await expect(generateOnboardingSummary(EMPLOYEE, APPS)).resolves.toBeNull();
    });
  });

  // ── Bad response bodies → null ──────────────────────────────────────────────

  describe('bad response bodies → null', () => {
    test('response.response is empty string → null', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ response: '' }));

      await expect(generateOnboardingSummary(EMPLOYEE, APPS)).resolves.toBeNull();
    });

    test('response.response is whitespace-only → null', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ response: '   \n\t  ' }));

      await expect(generateOnboardingSummary(EMPLOYEE, APPS)).resolves.toBeNull();
    });

    test('response.response key is absent → null', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({}));

      await expect(generateOnboardingSummary(EMPLOYEE, APPS)).resolves.toBeNull();
    });

    test('response.json() rejects (malformed JSON) → null', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok:     true,
        status: 200,
        json:   jest.fn().mockRejectedValueOnce(new SyntaxError('Unexpected token')),
      } as unknown as Response);

      await expect(generateOnboardingSummary(EMPLOYEE, APPS)).resolves.toBeNull();
    });
  });

  // ── Environment variable overrides ──────────────────────────────────────────

  describe('environment variable overrides', () => {
    test('OLLAMA_BASE_URL is reflected in the fetch URL', async () => {
      process.env.OLLAMA_BASE_URL = 'http://custom-host:9999';
      fetchSpy.mockResolvedValueOnce(mockResponse({ response: 'ok' }));

      await generateOnboardingSummary(EMPLOYEE, APPS);

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://custom-host:9999/api/generate',
        expect.anything(),
      );
    });

    test('trailing slash in OLLAMA_BASE_URL is stripped before appending path', async () => {
      process.env.OLLAMA_BASE_URL = 'http://localhost:11434/';
      fetchSpy.mockResolvedValueOnce(mockResponse({ response: 'ok' }));

      await generateOnboardingSummary(EMPLOYEE, APPS);

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.anything(),
      );
    });

    test('OLLAMA_MODEL is sent in the request body', async () => {
      process.env.OLLAMA_MODEL = 'mistral';
      fetchSpy.mockResolvedValueOnce(mockResponse({ response: 'ok' }));

      await generateOnboardingSummary(EMPLOYEE, APPS);

      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string) as Record<string, unknown>;
      expect(body.model).toBe('mistral');
    });

    test('missing env vars fall back to defaults (llama3, localhost:11434)', async () => {
      delete process.env.OLLAMA_BASE_URL;
      delete process.env.OLLAMA_MODEL;
      delete process.env.OLLAMA_TIMEOUT_MS;

      fetchSpy.mockResolvedValueOnce(mockResponse({ response: 'ok' }));

      await generateOnboardingSummary(EMPLOYEE, APPS);

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://localhost:11434/api/generate',
        expect.anything(),
      );
      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string) as Record<string, unknown>;
      expect(body.model).toBe('llama3');
    });
  });

  // ── Contract: function never throws ────────────────────────────────────────

  describe('contract: never throws — all failure modes resolve to null', () => {
    test('does not throw when fetch rejects', async () => {
      fetchSpy.mockRejectedValueOnce(new Error('any error'));

      await expect(generateOnboardingSummary(EMPLOYEE, APPS)).resolves.toBeNull();
    });

    test('does not throw on HTTP 500 non-OK response', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse(null, false, 500));

      await expect(generateOnboardingSummary(EMPLOYEE, APPS)).resolves.toBeNull();
    });

    test('does not throw when response.json() rejects', async () => {
      fetchSpy.mockResolvedValueOnce({
        ok:     true,
        status: 200,
        json:   jest.fn().mockRejectedValueOnce(new SyntaxError('bad json')),
      } as unknown as Response);

      await expect(generateOnboardingSummary(EMPLOYEE, APPS)).resolves.toBeNull();
    });
  });

  // ── Prompt content ──────────────────────────────────────────────────────────

  describe('prompt content', () => {
    test('prompt includes employee full_name, email, role, and all granted app names', async () => {
      fetchSpy.mockResolvedValueOnce(mockResponse({ response: 'ok' }));

      await generateOnboardingSummary(EMPLOYEE, APPS);

      const [, options] = fetchSpy.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(options.body as string) as Record<string, unknown>;
      const prompt = body.prompt as string;

      expect(prompt).toContain('Alex Chen');
      expect(prompt).toContain('alex.chen@example.com');
      expect(prompt).toContain('engineer');
      expect(prompt).toContain('slack');
      expect(prompt).toContain('google_workspace');
      expect(prompt).toContain('jira');
    });
  });
});

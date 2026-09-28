/**
 * Google-exact error envelopes.
 *
 * Clients of the legacy Custom Search JSON API parse this exact shape:
 *   { "error": { "code", "message", "errors": [{ "message", "domain", "reason" }], "status" } }
 *
 * Rules that matter for drop-in compatibility:
 *  - Quota problems are 429 RESOURCE_EXHAUSTED (never 402 — no Google client handles 402).
 *  - Bad parameters are 400 INVALID_ARGUMENT.
 *  - Upstream failures surface as 500 backendError, which Google clients already retry.
 */

interface GoogleErrorItem {
  message: string;
  domain: string;
  reason: string;
}

export function googleError(
  code: number,
  message: string,
  reason: string,
  status: string,
  domain = 'global',
): Response {
  const body = {
    error: {
      code,
      message,
      errors: [{ message, domain, reason } satisfies GoogleErrorItem],
      status,
    },
  };
  return new Response(JSON.stringify(body, null, 1), {
    status: code,
    headers: { 'Content-Type': 'application/json; charset=UTF-8' },
  });
}

export const invalidArgument = (message: string) =>
  googleError(400, message, 'invalid', 'INVALID_ARGUMENT');

export const badApiKey = () =>
  googleError(400, 'API key not valid. Please pass a valid API key.', 'badRequest', 'INVALID_ARGUMENT');

export const missingApiKey = () =>
  googleError(403, 'The request is missing a valid API key.', 'forbidden', 'PERMISSION_DENIED');

export const rateLimited = (message = 'Quota exceeded. Try again later.') =>
  googleError(429, message, 'rateLimitExceeded', 'RESOURCE_EXHAUSTED', 'usageLimits');

export const backendError = (message = 'Backend Error') =>
  googleError(500, message, 'backendError', 'INTERNAL');

export const notFound = () =>
  googleError(404, 'The requested URL was not found on this server.', 'notFound', 'NOT_FOUND');

/** Upstream credential failures are the caller's own BYOK key — tell them plainly. */
export const upstreamCredentialError = (provider: string) =>
  googleError(
    403,
    `Your configured upstream credential for provider "${provider}" was rejected. Check the key in your cse-compat configuration.`,
    'forbidden',
    'PERMISSION_DENIED',
  );

export const upstreamQuotaError = (provider: string) =>
  googleError(
    429,
    `Your upstream provider "${provider}" reports its quota is exhausted for your key.`,
    'rateLimitExceeded',
    'RESOURCE_EXHAUSTED',
    'usageLimits',
  );

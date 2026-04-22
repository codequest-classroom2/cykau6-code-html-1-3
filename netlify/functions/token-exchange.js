/**
 * Netlify serverless function: token-exchange
 *
 * Completes the GitHub OAuth Web Application Flow on behalf of the browser.
 * The browser cannot do this itself because GitHub's token endpoint does not
 * send CORS headers, and because CLIENT_SECRET must never be exposed to the
 * client.
 *
 * Required Netlify environment variables (set in Site → Environment variables):
 *   CLIENT_ID      — GitHub OAuth App client ID
 *   CLIENT_SECRET  — GitHub OAuth App client secret
 *
 * Receives (POST, JSON):
 *   { code: "<one-time OAuth code from GitHub redirect>" }
 *
 * Returns (JSON):
 *   Success → { access_token, token_type, scope }
 *   Error   → { error, error_description }
 *
 * Requires Node 18+ (uses global fetch).
 * For older runtimes, install node-fetch and replace fetch() calls accordingly.
 */

'use strict';

const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '*').split(',').map(s => s.trim());

/**
 * Pick the right Access-Control-Allow-Origin value.
 * If ALLOWED_ORIGINS contains '*', we allow everything.
 * Otherwise we echo back the request origin only if it is in the allowlist.
 */
function corsOrigin(requestOrigin) {
  if (ALLOWED_ORIGINS.includes('*')) return '*';
  if (requestOrigin && ALLOWED_ORIGINS.includes(requestOrigin)) return requestOrigin;
  return ALLOWED_ORIGINS[0]; // fallback — GitHub will reject the exchange anyway
}

const BASE_HEADERS = {
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

exports.handler = async function handler(event) {
  const origin  = event.headers?.origin || event.headers?.Origin || '';
  const headers = { ...BASE_HEADERS, 'Access-Control-Allow-Origin': corsOrigin(origin) };

  // ── Preflight ──────────────────────────────────────────────────────────────
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'method_not_allowed' }) };
  }

  // ── Parse body ─────────────────────────────────────────────────────────────
  let code;
  try {
    ({ code } = JSON.parse(event.body || '{}'));
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'invalid_json' }) };
  }

  if (!code || typeof code !== 'string') {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: 'missing_code', error_description: 'Request body must include { "code": "..." }' }),
    };
  }

  // ── Server-side credentials ────────────────────────────────────────────────
  const clientId     = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('[token-exchange] CLIENT_ID or CLIENT_SECRET env var is not set');
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: 'server_misconfigured',
        error_description: 'CLIENT_ID and CLIENT_SECRET must be set as Netlify environment variables',
      }),
    };
  }

  // ── Exchange code → access_token with GitHub ───────────────────────────────
  let ghRes;
  try {
    const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code });
    ghRes = await fetch(`https://github.com/login/oauth/access_token?${params.toString()}`, {
      method: 'POST',
      headers: { Accept: 'application/json' },
    });
  } catch (err) {
    console.error('[token-exchange] fetch to GitHub failed:', err);
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'upstream_error', error_description: 'Could not reach GitHub' }),
    };
  }

  let data;
  try {
    data = await ghRes.json();
  } catch {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({ error: 'upstream_parse_error', error_description: 'GitHub returned non-JSON' }),
    };
  }

  // GitHub returns { error, error_description } on failure — surface it cleanly.
  // Strip any fields we don't want to expose (none currently, but good practice).
  const safe = {
    ...(data.access_token    && { access_token:    data.access_token }),
    ...(data.token_type      && { token_type:      data.token_type }),
    ...(data.scope           && { scope:           data.scope }),
    ...(data.error           && { error:           data.error }),
    ...(data.error_description && { error_description: data.error_description }),
  };

  return {
    statusCode: ghRes.ok ? 200 : 400,
    headers,
    body: JSON.stringify(safe),
  };
};

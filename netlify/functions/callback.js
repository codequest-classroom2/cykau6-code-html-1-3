/**
 * Netlify serverless function: callback
 * Canonical URL: https://codequest-oauth.netlify.app/callback
 *
 * This is the registered GitHub OAuth redirect_uri. GitHub sends the student
 * here after they authorise (or deny) the app. This function:
 *   1. Exchanges the one-time ?code with GitHub using server-side credentials.
 *   2. Redirects the student back to the submit.html they came from, passing
 *      the access token in the URL *hash* (fragment) so it is never sent to
 *      any server or written to access logs.
 *
 * Required Netlify environment variables:
 *   CLIENT_ID      — GitHub OAuth App client ID
 *   CLIENT_SECRET  — GitHub OAuth App client secret
 *
 * Optional environment variable:
 *   ALLOWED_RETURN_HOSTS — comma-separated list of hostnames submit.html may
 *                          live on (e.g. "alice.github.io,my-class.netlify.app").
 *                          Defaults to allowing *.github.io and *.netlify.app.
 *
 * submit.html encodes { nonce, returnUrl } as base64 JSON into the OAuth
 * `state` parameter. This function decodes it to know where to redirect, and
 * passes the nonce back so submit.html can verify the response is genuine.
 *
 * Requires Node 18+ (uses the global fetch API).
 */

'use strict';

// Hostnames that submit.html is allowed to live on.
const allowedHosts = (process.env.ALLOWED_RETURN_HOSTS || '')
  .split(',')
  .map(h => h.trim())
  .filter(Boolean);

function isAllowedReturnUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { return false; }
  const host = parsed.hostname;

  // Always allow localhost and 127.0.0.1 for local development.
  if (host === 'localhost' || host === '127.0.0.1') return true;

  // Allow hosts listed in the env var.
  if (allowedHosts.some(h => host === h || host.endsWith('.' + h))) return true;

  // Default allowlist: GitHub Pages and Netlify.
  return host.endsWith('.github.io') || host.endsWith('.netlify.app') || host.endsWith('.netlify.live');
}

/** Build a 302 redirect to baseUrl with params appended as a URL hash fragment. */
function hashRedirect(baseUrl, params) {
  const fragment = new URLSearchParams(params).toString();
  return {
    statusCode: 302,
    headers: { Location: `${baseUrl}#${fragment}` },
    body: '',
  };
}

exports.handler = async function handler(event) {
  const qs = event.queryStringParameters || {};
  const { code, state, error: ghError } = qs;

  // ── 1. Decode state → { nonce, returnUrl } ──────────────────────────────────
  let returnUrl = '/';
  let nonce     = '';
  try {
    const decoded = JSON.parse(Buffer.from(state || '', 'base64').toString('utf8'));
    if (typeof decoded.returnUrl === 'string') returnUrl = decoded.returnUrl;
    if (typeof decoded.nonce     === 'string') nonce     = decoded.nonce;
  } catch {
    // state was absent or malformed — returnUrl stays as '/'
  }

  // ── 2. Validate the return URL (open-redirect guard) ────────────────────────
  if (!isAllowedReturnUrl(returnUrl)) {
    return {
      statusCode: 400,
      headers: { 'Content-Type': 'text/plain' },
      body: `OAuth error: returnUrl "${returnUrl}" is not on the allowlist.`,
    };
  }

  // ── 3. Surface GitHub authorisation errors back to submit.html ───────────────
  if (ghError) {
    return hashRedirect(returnUrl, { oauth_error: ghError });
  }

  if (!code) {
    return hashRedirect(returnUrl, { oauth_error: 'missing_code' });
  }

  // ── 4. Server-side credential check ─────────────────────────────────────────
  const clientId     = process.env.CLIENT_ID;
  const clientSecret = process.env.CLIENT_SECRET;

  if (!clientId || !clientSecret) {
    console.error('[callback] CLIENT_ID or CLIENT_SECRET env var is not set');
    return hashRedirect(returnUrl, { oauth_error: 'server_misconfigured' });
  }

  // ── 5. Exchange code → access_token with GitHub ──────────────────────────────
  let accessToken;
  try {
    const params = new URLSearchParams({ client_id: clientId, client_secret: clientSecret, code });
    const res  = await fetch(`https://github.com/login/oauth/access_token?${params}`, {
      method:  'POST',
      headers: { Accept: 'application/json' },
    });
    const data = await res.json();

    if (data.error) {
      console.error('[callback] GitHub returned error:', data.error, data.error_description);
      return hashRedirect(returnUrl, { oauth_error: data.error });
    }
    accessToken = data.access_token;
  } catch (err) {
    console.error('[callback] fetch to GitHub failed:', err.message);
    return hashRedirect(returnUrl, { oauth_error: 'exchange_failed' });
  }

  // ── 6. Redirect student back to submit.html with token in the URL hash ───────
  //
  // The hash is never sent to servers or written to access logs, which is
  // safer than a query-string for short-lived but sensitive values.
  // submit.html reads the hash, stores the token in localStorage, and
  // immediately calls history.replaceState to remove the hash from the URL.
  return hashRedirect(returnUrl, { token: accessToken, nonce });
};

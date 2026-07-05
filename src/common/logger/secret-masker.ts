/**
 * Recursively mask values for keys that look like credentials.
 *
 * Catches: `access_token`, `refresh_token`, `id_token`, `client_secret`,
 * `password`, `authorization`, `cookie`, `x-api-key`, plus any key ending in
 * `_token`, `_secret`, `_password`, or `_key`.
 *
 * Also masks long bearer-looking strings that appear inside the values
 * themselves (e.g. an error message that quoted the token back).
 *
 * Returns a clone — does not mutate the input.
 */
const SECRET_KEY_RE =
  /^(authorization|cookie|set-cookie|password|secret|token|api-key|apikey|x-api-key|x-hub-signature.*)$/i;
const SECRET_KEY_SUFFIX_RE =
  /(_token|_secret|_password|_key|_credential|_credentials)$/i;
const BEARER_IN_STRING_RE = /(Bearer\s+)[A-Za-z0-9._-]{8,}/g;
const LONG_JWT_RE = /\b(eyJ[A-Za-z0-9._-]{20,})\b/g;
const MAX_DEPTH = 8;

function isSecretKey(key: string): boolean {
  return SECRET_KEY_RE.test(key) || SECRET_KEY_SUFFIX_RE.test(key);
}

function maskString(value: string): string {
  return value
    .replace(BEARER_IN_STRING_RE, '$1[REDACTED]')
    .replace(LONG_JWT_RE, '[REDACTED_JWT]');
}

export function maskSecrets(value: any, depth = 0): any {
  if (depth > MAX_DEPTH) return value;
  if (value == null) return value;
  if (typeof value === 'string') return maskString(value);
  if (typeof value !== 'object') return value;

  if (Array.isArray(value)) {
    return value.map((item) => maskSecrets(item, depth + 1));
  }

  // Don't try to clone Buffers / streams / class instances we don't own.
  if (Buffer.isBuffer(value) || value instanceof Date) return value;

  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(value)) {
    if (isSecretKey(k)) {
      out[k] = typeof v === 'string' && v.length > 0 ? '[REDACTED]' : v;
      continue;
    }
    out[k] = maskSecrets(v, depth + 1);
  }
  return out;
}

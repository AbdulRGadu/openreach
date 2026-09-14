import type { Env } from './env';

const encoder = new TextEncoder();

/**
 * Constant-time string comparison: SHA-256 both values (fixed length), then
 * timingSafeEqual where available, else a constant-time XOR fold over the digests.
 */
export async function safeEqualStrings(a: string, b: string): Promise<boolean> {
  const [da, db] = await Promise.all([
    crypto.subtle.digest('SHA-256', encoder.encode(a)),
    crypto.subtle.digest('SHA-256', encoder.encode(b)),
  ]);
  const subtle = crypto.subtle as SubtleCrypto & {
    timingSafeEqual?: (x: ArrayBuffer, y: ArrayBuffer) => boolean;
  };
  if (typeof subtle.timingSafeEqual === 'function') {
    return subtle.timingSafeEqual(da, db);
  }
  const xa = new Uint8Array(da);
  const xb = new Uint8Array(db);
  let diff = 0;
  for (let i = 0; i < xa.length; i++) diff |= (xa[i] ?? 0) ^ (xb[i] ?? 0);
  return diff === 0;
}

export async function isAuthorized(request: Request, env: Env): Promise<boolean> {
  const header = request.headers.get('Authorization') ?? '';
  if (!header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length).trim();
  if (!token) return false;
  const pin = env.DASHBOARD_PIN?.trim();
  if (pin && await safeEqualStrings(token, pin)) return true;
  return !!env.API_KEY && safeEqualStrings(token, env.API_KEY);
}

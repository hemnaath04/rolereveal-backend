// ---------------------------------------------------------------------------
// AI Jobby backend proxy (Vercel Edge Function).
//
// Why this exists: a Chrome extension is public JS, so any key shipped in it is
// extractable. This proxy holds the real LLM key SERVER-SIDE (env var) and the
// extension calls this endpoint instead. It's OpenAI-compatible, so the
// extension's existing "custom" provider works unchanged — just point its base
// URL at `https://<this-deployment>/api`.
//
// Route: POST /api/chat/completions   (Vercel maps this file to that path)
// ---------------------------------------------------------------------------
export const config = { runtime: 'edge' };

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-app-token',
  'access-control-max-age': '86400',
};

const json = (data: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...CORS, ...extra },
  });

function clampNum(v: unknown, min: number, max: number, dflt: number): number {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, n));
}

// Per-IP rate limit. Only enforced when Upstash Redis env vars are set; without
// them it fails open (deploy works immediately, add Upstash before going wide).
async function withinRateLimit(ip: string): Promise<boolean> {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN;
  if (!url || !tok) return true;
  const limit = Number(process.env.RATE_LIMIT_PER_MIN || '20');
  const bucket = `aj:${ip}:${Math.floor(Date.now() / 60000)}`;
  try {
    const r = await fetch(`${url}/incr/${bucket}`, {
      headers: { authorization: `Bearer ${tok}` },
    });
    const count = Number((await r.json()).result);
    if (count === 1) {
      await fetch(`${url}/expire/${bucket}/120`, {
        headers: { authorization: `Bearer ${tok}` },
      });
    }
    return count <= limit;
  } catch {
    return true; // never block on limiter failure
  }
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  const UPSTREAM = process.env.UPSTREAM_BASE_URL; // e.g. https://generativelanguage.googleapis.com/v1beta/openai
  const KEY = process.env.UPSTREAM_API_KEY; // the REAL provider/gateway key — server-only
  if (!UPSTREAM || !KEY) return json({ error: 'server_not_configured' }, 500);

  // Optional revocable app token. If APP_TOKEN is set, the extension must send a
  // matching Authorization: Bearer <token> (or x-app-token). It's still public
  // (it's in the extension), but you can rotate it to cut off abuse.
  const appToken = process.env.APP_TOKEN;
  if (appToken) {
    const sent =
      req.headers.get('x-app-token') ||
      (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
    if (sent !== appToken) return json({ error: 'unauthorized' }, 401);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: 'bad_json' }, 400);
  }

  const messages = body?.messages;
  if (!Array.isArray(messages) || messages.length === 0) {
    return json({ error: 'messages_required' }, 400);
  }
  // Bound prompt size so nobody runs huge jobs on your key.
  if (JSON.stringify(messages).length > 140_000) {
    return json({ error: 'request_too_large' }, 413);
  }

  // Optional model allowlist — keeps all traffic on cheap models.
  const allowed = (process.env.ALLOWED_MODELS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const model = body.model || process.env.DEFAULT_MODEL || 'auto';
  if (allowed.length && !allowed.includes(model)) {
    return json({ error: 'model_not_allowed', model }, 400);
  }

  const ip = (req.headers.get('x-forwarded-for') || '').split(',')[0].trim() || 'anon';
  if (!(await withinRateLimit(ip))) {
    return json({ error: 'rate_limited' }, 429, { 'retry-after': '60' });
  }

  const upstreamBody = {
    model,
    messages,
    temperature: clampNum(body.temperature, 0, 2, 0.2),
    max_tokens: Math.min(clampNum(body.max_tokens, 1, 4096, 900), 1200),
    ...(body.response_format ? { response_format: body.response_format } : {}),
  };

  let upstream: Response;
  try {
    upstream = await fetch(`${UPSTREAM.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(upstreamBody),
    });
  } catch (e: any) {
    return json({ error: 'upstream_unreachable', detail: String(e?.message || e) }, 502);
  }

  // Pass the OpenAI-shaped response straight through (extension reads choices[0]).
  const text = await upstream.text();
  return new Response(text, {
    status: upstream.status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

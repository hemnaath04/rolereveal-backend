// ---------------------------------------------------------------------------
// RoleReveal backend proxy (Vercel Edge Function).
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

// Vercel provides process.env at runtime; declare it so we don't need @types/node.
declare const process: { env: Record<string, string | undefined> };

const CORS: Record<string, string> = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'POST, OPTIONS',
  'access-control-allow-headers': 'authorization, content-type, x-app-token, x-client-id',
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

// ── Strict, persistent rate limiting via Upstash Redis ──────────────────────
// Counters survive across edge invocations. Enforced ONLY when Upstash env vars
// are set — set them before going public, or there is no shared counter to
// enforce against (serverless has no shared memory).
function redisConfigured(): boolean {
  return !!(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);
}

async function incrWithTtl(key: string, ttlSeconds: number): Promise<number | null> {
  const url = process.env.UPSTASH_REDIS_REST_URL!;
  const tok = process.env.UPSTASH_REDIS_REST_TOKEN!;
  try {
    const r = await fetch(`${url}/incr/${encodeURIComponent(key)}`, {
      headers: { authorization: `Bearer ${tok}` },
    });
    const count = Number((await r.json()).result);
    if (count === 1) {
      await fetch(`${url}/expire/${encodeURIComponent(key)}/${ttlSeconds}`, {
        headers: { authorization: `Bearer ${tok}` },
      });
    }
    return count;
  } catch {
    return null; // never hard-fail a request because the limiter glitched
  }
}

const dayStamp = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const secsToUtcMidnight = () => {
  const now = new Date();
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  return Math.max(1, Math.floor((next.getTime() - now.getTime()) / 1000));
};

interface LimitVerdict {
  ok: boolean;
  error?: string;
  message?: string;
  retryAfter?: number;
}

async function checkLimits(clientId: string, ip: string): Promise<LimitVerdict> {
  if (!redisConfigured()) return { ok: true }; // can't enforce without a store
  const day = dayStamp();
  const perUser = Number(process.env.DAILY_LIMIT_PER_USER || '100');
  const perIpDay = Number(process.env.DAILY_LIMIT_PER_IP || '300');
  const perMin = Number(process.env.RATE_LIMIT_PER_MIN || '20');
  const globalDay = Number(process.env.GLOBAL_DAILY_CAP || '0'); // 0 = disabled

  // 1) Burst per IP (per minute).
  const burst = await incrWithTtl(`aj:min:${ip}:${Math.floor(Date.now() / 60000)}`, 120);
  if (burst !== null && burst > perMin)
    return { ok: false, error: 'rate_limited', message: 'Too many requests, slow down.', retryAfter: 60 };

  // 2) Daily per IP (defeats client-id rotation).
  const ipDay = await incrWithTtl(`aj:ipday:${ip}:${day}`, 90000);
  if (ipDay !== null && ipDay > perIpDay)
    return { ok: false, error: 'daily_ip_limit', message: 'Daily limit reached for this network.', retryAfter: secsToUtcMidnight() };

  // 3) Daily per user (the 100/day cap).
  const userDay = await incrWithTtl(`aj:uday:${clientId || ip}:${day}`, 90000);
  if (userDay !== null && userDay > perUser)
    return {
      ok: false,
      error: 'daily_limit_reached',
      message: `Daily limit of ${perUser} scored jobs reached. Try again tomorrow, or add your own API key in RoleReveal → Options.`,
      retryAfter: secsToUtcMidnight(),
    };

  // 4) Optional global backstop across all users.
  if (globalDay > 0) {
    const all = await incrWithTtl(`aj:gday:${day}`, 90000);
    if (all !== null && all > globalDay)
      return { ok: false, error: 'service_busy', message: 'Daily capacity reached. Please try again tomorrow.', retryAfter: secsToUtcMidnight() };
  }

  return { ok: true };
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
  const clientId = (req.headers.get('x-client-id') || '').slice(0, 64);
  const verdict = await checkLimits(clientId, ip);
  if (!verdict.ok) {
    return json(
      { error: verdict.error, message: verdict.message },
      429,
      { 'retry-after': String(verdict.retryAfter ?? 60) },
    );
  }

  const baseBody = {
    model,
    messages,
    temperature: clampNum(body.temperature, 0, 2, 0.2),
    max_tokens: Math.min(clampNum(body.max_tokens, 1, 4096, 900), 1200),
  };
  const upstreamBody = {
    ...baseBody,
    ...(body.response_format ? { response_format: body.response_format } : {}),
  };

  const call = (b: Record<string, unknown>) =>
    fetch(`${UPSTREAM.replace(/\/+$/, '')}/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${KEY}` },
      body: JSON.stringify(b),
    });

  let upstream: Response;
  let text: string;
  try {
    upstream = await call(upstreamBody);
    text = await upstream.text();
  } catch (e: any) {
    return json({ error: 'upstream_unreachable', detail: String(e?.message || e) }, 502);
  }

  // Manifest's Anthropic route currently 400s on a schema it auto-builds for
  // plain `response_format: {type:"json_object"}` requests (the schema it
  // generates omits the `additionalProperties: false` Anthropic's structured-
  // output API requires — a bug in Manifest, not fixable from here: see
  // github.com/mnfst/manifest PR #2421, toAnthropicOutputConfig's json_object
  // branch). Retry once without response_format so a real request still
  // succeeds; the system prompt already requires JSON-only output and
  // extractJson() tolerates the resulting plain-text-mode response.
  if (
    upstream.status === 400 &&
    body.response_format &&
    text.includes('additionalProperties')
  ) {
    try {
      upstream = await call(baseBody);
      text = await upstream.text();
    } catch (e: any) {
      return json({ error: 'upstream_unreachable', detail: String(e?.message || e) }, 502);
    }
  }

  // Pass the OpenAI-shaped response straight through (extension reads choices[0]).
  return new Response(text, {
    status: upstream.status,
    headers: { 'content-type': 'application/json', ...CORS },
  });
}

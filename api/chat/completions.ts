// ---------------------------------------------------------------------------
// RoleReveal backend proxy (Vercel Edge Function).
//
// Why this exists: a Chrome extension is public JS, so any key shipped in it is
// extractable. This proxy holds the real LLM key SERVER-SIDE (env var) and the
// extension calls this endpoint instead. It's OpenAI-compatible, so the
// extension's existing "custom" provider works unchanged — just point its base
// URL at `https://<this-deployment>/api`.
//
// Model routing: tries Groq's free tier FIRST (fast, no cost), and falls back
// to the configured upstream (the Manifest gateway) on any Groq failure —
// error, non-2xx, free-tier rate limit, timeout, or empty response. Groq is
// entirely optional: with no GROQ_API_KEY set, behavior is unchanged (upstream
// only). Neither key ever leaves this server.
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

// ── Groq free-tier attempt (primary), Manifest/upstream is the fallback ─────
// Server-held key only (GROQ_API_KEY) — never sent to or read from the
// extension. Kept fast with a short internal timeout so a hung Groq call
// fails over to the fallback quickly instead of stalling the whole request.
const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

interface GroqAttempt {
  ok: boolean;
  text?: string; // raw OpenAI-shaped JSON body, passed straight through
}

async function tryGroq(
  body: Record<string, unknown>,
): Promise<GroqAttempt> {
  const key = process.env.GROQ_API_KEY;
  if (!key) return { ok: false }; // not configured — skip silently, no error

  const model = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
  const timeoutMs = Number(process.env.GROQ_TIMEOUT_MS || '12000');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(GROQ_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
      body: JSON.stringify({ ...body, model }),
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      console.error(`groq ${res.status}: ${text.slice(0, 300)}`);
      return { ok: false };
    }
    // Validate there's real content before trusting this leg (a malformed or
    // empty response should also fail over, not return junk to the client).
    let content = '';
    try {
      content = JSON.parse(text)?.choices?.[0]?.message?.content ?? '';
    } catch {
      /* falls through to ok:false below */
    }
    if (!content) return { ok: false };
    return { ok: true, text };
  } catch (e: any) {
    console.error(`groq unreachable/timeout: ${String(e?.message || e)}`);
    return { ok: false };
  } finally {
    clearTimeout(timer);
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
  const clientId = (req.headers.get('x-client-id') || '').slice(0, 64);
  const verdict = await checkLimits(clientId, ip);
  if (!verdict.ok) {
    return json(
      { error: verdict.error, message: verdict.message },
      429,
      { 'retry-after': String(verdict.retryAfter ?? 60) },
    );
  }

  // Shared, already-clamped fields; `model` is overridden per leg (Groq uses
  // its own fixed GROQ_MODEL, unrelated to the upstream model/allowlist above).
  const sharedBody = {
    messages,
    temperature: clampNum(body.temperature, 0, 2, 0.2),
    max_tokens: Math.min(clampNum(body.max_tokens, 1, 4096, 900), 1200),
    ...(body.response_format ? { response_format: body.response_format } : {}),
  };

  // 1) Try Groq's free tier first. No-op (falls through immediately) if
  // GROQ_API_KEY isn't set, or on any error/rate-limit/timeout/empty response.
  const groq = await tryGroq(sharedBody);
  if (groq.ok && groq.text) {
    return new Response(groq.text, {
      status: 200,
      headers: { 'content-type': 'application/json', ...CORS, 'x-rr-provider': 'groq' },
    });
  }

  // 2) Fall back to the configured upstream (the Manifest gateway).
  const upstreamBody = { ...sharedBody, model };
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
    headers: { 'content-type': 'application/json', ...CORS, 'x-rr-provider': 'manifest' },
  });
}

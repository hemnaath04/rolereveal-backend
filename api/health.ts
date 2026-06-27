// Lightweight health/uptime check: GET /api/health → { ok, configured }.
export const config = { runtime: 'edge' };

declare const process: { env: Record<string, string | undefined> };

export default function handler(): Response {
  const body = {
    ok: true,
    service: 'ai-jobby-backend',
    upstream_configured: !!(process.env.UPSTREAM_BASE_URL && process.env.UPSTREAM_API_KEY),
    ratelimit_configured: !!(
      process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
    ),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json', 'access-control-allow-origin': '*' },
  });
}

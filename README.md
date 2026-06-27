# RoleReveal Backend

A tiny OpenAI-compatible proxy so the **RoleReveal** extension never ships a real
API key. The extension calls this endpoint; this proxy adds the key (from a
server env var), rate-limits, caps request size, and forwards to your LLM.

```
extension  ──POST /api/chat/completions──▶  this proxy  ──+ secret key──▶  LLM upstream
(no secret)                                 (Vercel Edge)                  (Gemini/OpenAI/gateway)
```

## Endpoint
`POST /api/chat/completions` — standard OpenAI chat-completions body
(`{ model, messages, temperature, max_tokens, response_format }`), standard
response (`choices[0].message.content`). CORS-enabled.

## Deploy (Vercel)
```bash
cd ai-jobby-backend
npx vercel        # first deploy (links/creates the project)
npx vercel --prod # production
```
Then set env vars in the Vercel dashboard (Project → Settings → Environment
Variables) — see `.env.example`. Minimum:
- `UPSTREAM_BASE_URL` — e.g. `https://generativelanguage.googleapis.com/v1beta/openai`
- `UPSTREAM_API_KEY` — your real key (server-only)

Recommended before going public:
- `ALLOWED_MODELS=gemini-3.5-flash` (force cheap model)
- `APP_TOKEN=<random>` (revocable gate; also set it as the extension's key)
- `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN` (per-IP rate limit)

## Point the extension at it
In `ai-jobby/src/lib/config.ts`:
```ts
export const DEFAULT_BACKEND = {
  provider: 'custom',
  customBaseUrl: 'https://<this-deployment>.vercel.app/api', // note the /api
  apiKey: '',          // leave '' — or set to APP_TOKEN if you enabled it
  model: 'auto', // Manifest gateway routes the model
};
```

## Abuse model
The proxy keeps the provider key secret, but the endpoint itself is public.
Defenses included: model allowlist, request-size cap, output-token cap, optional
revocable app token, optional per-IP rate limit. For real scale, move to
per-user sign-in and meter per account.

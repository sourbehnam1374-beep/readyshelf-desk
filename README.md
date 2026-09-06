# ReadyShelf Desk

Telegram Mini App for one-channel approval.

**Forward a source → get a clean draft → Approve freezes exact text → it posts to the channel.**

Live: https://desk-production-537d.up.railway.app  
Bot: [@ReadyShelfShopBot](https://t.me/ReadyShelfShopBot) · Channel: [@readyshelf](https://t.me/readyshelf)

## Draft Engine v1

Not “AI in your voice.” A short English channel post from the source:

- Keep facts that appear in the source
- Strip tracking links, hashtag spam, subscribe CTAs
- Tips-length, dry tone, one idea
- **Never invent claims**
- Approve freezes `draft_text` exactly — publish sends that string

## Trust rules (do not break)

`trust/v1` — enforced on publish and on frozen posts.

1. Source is the only evidence. Draft may omit junk; it may not add facts.
2. If unsure, keep closer to the source.
3. Never fabricate medical or news facts.
4. Approve freezes the exact draft text. Publish sends that string — no rewrite.
5. Frozen or published posts cannot be edited or regenerated.
6. Nothing publishes without Approve of frozen text.
7. Operator auth is Telegram initData HMAC. Mock key stays off in production.
8. Review shows source + draft. Never show a Verified badge — the engine does not fact-check.

`POST /api/approve-queue` requires `postId` and freezes that post’s exact text. `POST /api/publish` sends only that `frozen_text` (`postId` or matching text). Anything else is `409`.

### Provider (pluggable)

First key wins:

| Env | Provider | Default model |
| --- | --- | --- |
| `XAI_API_KEY` | Grok (`https://api.x.ai/v1`) | `grok-4.5` |
| `OPENAI_API_KEY` | OpenAI | `gpt-4.1-mini` |
| (neither) | Deterministic cleaner | `cleaner/v1` |

Optional:

- `DRAFT_MODEL` — override model id
- `DRAFT_ON_INGEST` — `1` (default) generates in the background after `POST /api/sources`. Set `0` to generate only when the operator taps **Generate draft**.
- `DATA_DIR` — JSON store. Defaults to `/app/data` when that directory exists (Railway volume), else `./data`.

### API

Auth on mutating operator routes: Telegram WebApp `initData` HMAC (`X-Telegram-Init-Data`). `ALLOW_MOCK_KEY=1` plus `X-ReadyShelf-Mock-Key: dev` is local-only.

Ingest (bot):

```
POST /api/sources
Header: X-ReadyShelf-Ingest-Key
{ "text": "...", "fromUsername": "…", "forwardedFrom": "…" }
```

Operator:

```
POST /api/sources/manual          { text }                 initData
POST /api/drafts/generate         { sourceId }             initData
→ { ok, postId, draft_text, post }

GET  /api/posts?status=draft|ready|frozen
PATCH /api/posts/:id              { draft_text, status }   initData
  (409 if frozen)

POST /api/approve-queue           { text|frozenText, postId? }
POST /api/publish                 { text }                 LIVE to CHANNEL_ID
GET  /api/health                  public, includes draft.provider
```

Post record: `source_id`, `draft_text`, `model`, `prompt_version` (`draft-engine/v1.1`), `created_at`, `status`.

## Auth

- Mini App HMAC as before. `ALLOW_MOCK_KEY` must stay **off** in production.

## Run

```
npm start
```

`Procfile`: `web: node index.js`

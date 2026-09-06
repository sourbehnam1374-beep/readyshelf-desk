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
7. initData HMAC on all Mini App mutations. Bot ingest uses INGEST_KEY only. Mock key stays off in production.
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
- `DATA_DIR` — SQLite file `readyshelf.sqlite` (WAL). Defaults to `/app/data` when that directory exists (Railway volume), else `./data`. Existing `sources.json` / `posts.json` / `queue.json` are imported once, then left as backup.

### API

Auth on mutating operator routes: Telegram WebApp `initData` HMAC (`X-Telegram-Init-Data`). `ALLOW_MOCK_KEY=1` plus `X-ReadyShelf-Mock-Key: dev` is local-only.

Ingest (bot):

```
POST /api/sources
Header: X-ReadyShelf-Ingest-Key
{ "text": "...", "fromUsername": "…", "forwardedFrom": "…" }

POST /api/telegram/webhook     Telegram secret header (forwards from @ReadyShelfShopBot)
```

Forward a message to `@ReadyShelfShopBot` → stored as a source → Desk Inbox (polls every 5s). On boot the service registers `WEBAPP_URL/api/telegram/webhook`.

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

- **initData HMAC on all Mini App mutations** (`X-Telegram-Init-Data`). Catch-all middleware — a new POST/PATCH/PUT/DELETE cannot skip it.
- Bot ingest `POST /api/sources` uses `X-ReadyShelf-Ingest-Key` only.
- `ALLOW_MOCK_KEY` must stay **off** in production.
- `GET /api/health` stays public.


## Success criteria

1. Forward or paste a source → it is stored.
2. Generate (or ingest) → a Post with status ready, `source_id`, `draft_text`, `model`, `prompt_version`. Draft opens in Review automatically, or in one tap.
3. Inbox shows sources and Draft ready.
4. Review is Source | Draft. No Verified badge.
5. Operator edits → Approve → live post on `@readyshelf` with a t.me link.
6. Do this 3 times with zero unapproved publishes.
7. Stranger path: `/start` → Demo → Buy Desk · ⭐500 (`desk30`).
7. Provider: `XAI_API_KEY`, else `OPENAI_API_KEY`, else deterministic cleaner. Temperature 0.
8. initData HMAC on every Mini App mutation. Bot ingest uses `INGEST_KEY`.
9. SQLite on the Railway volume (`/app/data`). JSON imported once.
10. Same Railway service. `WEBAPP_URL` / `BOT_TOKEN` / `INGEST_KEY` unchanged.
11. Stars billing remains `desk30`.

## Must NOT ship

- “AI in your voice” / style cloning / personality theater
- Fake Verified or fact-check stamps
- Auto-publish without Approve of frozen text
- Invented claims, especially medical or news facts
- Mock auth in production (`ALLOW_MOCK_KEY`, `?mock=1`) — forced off on Railway prod
- Logging `BOT_TOKEN`, `INGEST_KEY`, or `initData`
- Rewrite of frozen text at publish
- A new Railway service, or rotating `WEBAPP_URL` / `BOT_TOKEN` / `INGEST_KEY`
- Rebuild from zero
- Audience Gates
- Multi-agent roster
- AI voice clone
- Module marketplace
- RSS network
- Reinventing Stars billing (already `desk30`)

## Deploy

Existing Railway service **`readyshelf-desk`** · URL stays `https://desk-production-537d.up.railway.app`.

**Keep these env vars as they are. Do not rotate or overwrite:**

- `WEBAPP_URL`
- `BOT_TOKEN`
- `INGEST_KEY`

Optional (do not remove if set): `CHANNEL_ID`, `XAI_API_KEY` / `OPENAI_API_KEY`, `DRAFT_MODEL`. `ALLOW_MOCK_KEY` stays off. Volume stays `/app/data`.

Push to `main` deploys that service (GitHub integration or `RAILWAY_TOKEN` Action). `railway.toml` does not define secrets.

## Run

```
npm start
```

`Procfile`: `web: node index.js`

/** ReadyShelf Desk — trust/v1. Do not break. */

export const TRUST_VERSION = "trust/v1";

export const TRUST_RULES = [
  "Source is the only evidence. Draft may omit junk; it may not add facts.",
  "If unsure, keep closer to the source.",
  "Never fabricate medical or news facts.",
  "Approve freezes the exact draft text. Publish sends that string — no rewrite.",
  "Frozen or published posts cannot be edited or regenerated.",
  "Nothing publishes without Approve of frozen text.",
  "Review shows source + draft. Never show a Verified badge — the engine does not fact-check.",
  "initData HMAC on all Mini App mutations. Bot ingest uses INGEST_KEY only. Mock key stays off in production.",
];

export const MUST_NOT_SHIP = [
  "“AI in your voice” / style cloning / personality theater",
  "Fake Verified or fact-check stamps",
  "Auto-publish without Approve of frozen text",
  "Invented claims, especially medical or news facts",
  "Mock auth in production (ALLOW_MOCK_KEY, ?mock=1)",
  "Logging BOT_TOKEN, INGEST_KEY, or initData",
  "Rewrite of frozen text at publish",
  "A new Railway service, or rotating WEBAPP_URL / BOT_TOKEN / INGEST_KEY",
  "Rebuild from zero",
  "Audience Gates",
  "Multi-agent roster",
  "AI voice clone",
  "Module marketplace",
  "RSS network",
  "Reinventing Stars billing (already desk30)",
];

export const SUCCESS_CRITERIA = [
  "Forward or paste a source → it is stored.",
  "Generate (or ingest) → a Post with status ready, source_id, draft_text, model, prompt_version. Draft opens in Review automatically, or in one tap.",
  "Inbox shows sources and Draft ready.",
  "Review is Source | Draft. No Verified badge.",
  "Operator edits → Approve → live post on @readyshelf with a t.me link.",
  "Provider: XAI_API_KEY, else OPENAI_API_KEY, else deterministic cleaner. Temperature 0.",
  "initData HMAC on every Mini App mutation. Bot ingest uses INGEST_KEY.",
  "SQLite on the Railway volume (/app/data). JSON imported once.",
  "Same Railway service. WEBAPP_URL / BOT_TOKEN / INGEST_KEY unchanged.",
  "Stars billing remains desk30.",
];

export function isLocked(post) {
  return post?.status === "frozen" || post?.status === "published";
}

export function resolvePublishText(posts, body) {
  const postId = body && typeof body.postId === "string" ? body.postId : "";
  const incoming = body && typeof body.text === "string" ? body.text.trim() : "";

  if (postId) {
    const post = posts.find((p) => p.id === postId);
    if (!post) {
      const err = new Error("post not found");
      err.status = 404;
      throw err;
    }
    if (post.status !== "frozen") {
      const err = new Error("Approve first — publish sends frozen text only");
      err.status = 409;
      throw err;
    }
    const frozen = String(post.frozen_text || "").trim();
    if (!frozen) {
      const err = new Error("frozen_text missing");
      err.status = 409;
      throw err;
    }
    if (incoming && incoming !== frozen) {
      const err = new Error("text does not match frozen_text");
      err.status = 409;
      throw err;
    }
    return { text: frozen, post };
  }

  if (!incoming) {
    const err = new Error("postId or frozen text is required");
    err.status = 400;
    throw err;
  }
  const post = posts.find(
    (p) => p.status === "frozen" && String(p.frozen_text || "").trim() === incoming,
  );
  if (!post) {
    const err = new Error("publish requires a frozen approved draft");
    err.status = 409;
    throw err;
  }
  return { text: incoming, post };
}

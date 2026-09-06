/** ReadyShelf Desk — trust/v1. Do not break. */

export const TRUST_VERSION = "trust/v1";

export const TRUST_RULES = [
  "Source is the only evidence. Draft may omit junk; it may not add facts.",
  "If unsure, keep closer to the source.",
  "Never fabricate medical or news facts.",
  "Approve freezes the exact draft text. Publish sends that string — no rewrite.",
  "Frozen or published posts cannot be edited or regenerated.",
  "Nothing goes to the channel until Approve.",
  "Operator auth is Telegram initData HMAC. Mock key stays off in production.",
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

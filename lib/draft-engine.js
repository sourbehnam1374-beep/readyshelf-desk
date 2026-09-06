/**
 * ReadyShelf Draft Engine v1
 * Pluggable LLM: XAI_API_KEY (Grok) → OPENAI_API_KEY → deterministic cleaner.
 * Never invents claims. Output is the frozen candidate, not "your voice".
 */
export const PROMPT_VERSION = "draft-engine/v1";

export const SYSTEM_PROMPT = `You are ReadyShelf Draft Engine (${PROMPT_VERSION}).
Turn a raw forwarded source into a clean English Telegram channel post.

Rules:
- Tips-length: a short title line starting with "Tip:", then 2–5 short sentences. Aim under 500 characters.
- Keep only facts that appear in the source. Never invent names, numbers, dates, URLs, quotes, or claims.
- Strip tracking links, URL junk, hashtag spam, subscribe CTAs, and boilerplate.
- Dry, useful tone. One idea. No hype.
- Output ONLY the post text. No preamble, no wrapping quotes, no markdown fences.
- If the source has no usable fact, output exactly: [unusable source]`;

const TRACKING = /(?:https?:\/\/\S+|www\.\S+)(?:[^\s).,;!?]*)/gi;
const JUNK_LINE =
  /^(subscribe|follow us|click here|read more|share this|like and|comment below|t\.me\/\S+|#[\w]+(\s+#[\w]+)+)\s*$/i;

export function deterministicDraft(sourceText) {
  const raw = String(sourceText || "").replace(/\u00a0/g, " ");
  if (!raw.trim()) return "[unusable source]";

  const stripped = raw
    .replace(TRACKING, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split(/\n/)
    .map((line) => line.trim())
    .filter((line) => line && !JUNK_LINE.test(line))
    .join("\n")
    .trim();

  if (!stripped) return "[unusable source]";

  const sentences = stripped
    .replace(/\s+/g, " ")
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);

  const first = sentences[0] || stripped;
  const titleSeed = first
    .replace(/^["“]+|["”]+$/g, "")
    .replace(/^(tip|note|fwd|forwarded)\s*[:.\-–—]\s*/i, "")
    .slice(0, 64)
    .replace(/[,;:\s]+$/g, "");

  const title = titleSeed
    ? `Tip: ${titleSeed.charAt(0).toUpperCase()}${titleSeed.slice(1)}`
    : "Tip";

  const body = sentences.slice(0, 4).join(" ").slice(0, 420).trim();
  return `${title}\n\n${body}`.trim().slice(0, 500);
}

const STOP = new Set([
  "that", "this", "with", "from", "your", "have", "will", "them",
  "they", "then", "than", "into", "just", "about", "would", "could", "should",
]);

export function groundDraft(sourceText, draft) {
  const src = String(sourceText || "").toLowerCase();
  if (!src.trim()) return "[unusable source]";
  const lines = String(draft || "")
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);
  const kept = lines.filter((line, i) => {
    if (i === 0 && /^tip:/i.test(line)) return true;
    const words = line
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 3 && !STOP.has(w));
    if (words.length === 0) return false;
    const hits = words.filter((w) => src.includes(w)).length;
    return hits / words.length >= 0.4;
  });
  const out = kept.join("\n\n").trim();
  return out || deterministicDraft(sourceText);
}

export function pickProvider() {
  if (process.env.XAI_API_KEY) {
    return {
      name: "xai",
      model: process.env.DRAFT_MODEL || "grok-4.5",
      key: process.env.XAI_API_KEY,
      base: "https://api.x.ai/v1",
    };
  }
  if (process.env.OPENAI_API_KEY) {
    return {
      name: "openai",
      model: process.env.DRAFT_MODEL || "gpt-4.1-mini",
      key: process.env.OPENAI_API_KEY,
      base: "https://api.openai.com/v1",
    };
  }
  return { name: "deterministic", model: "cleaner/v1", key: null, base: null };
}

export async function generateDraftText(sourceText) {
  const provider = pickProvider();
  const fallback = deterministicDraft(sourceText);

  if (provider.name === "deterministic" || !provider.key || !provider.base) {
    return {
      draft_text: fallback,
      model: provider.model,
      provider: provider.name,
      prompt_version: PROMPT_VERSION,
      warning: "No LLM key — used deterministic cleaner",
    };
  }

  try {
    const res = await fetch(`${provider.base}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${provider.key}`,
      },
      body: JSON.stringify({
        model: provider.model,
        temperature: 0.2,
        max_tokens: 400,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: `SOURCE:\n${String(sourceText || "").slice(0, 6000)}` },
        ],
      }),
    });
    if (!res.ok) {
      return {
        draft_text: fallback,
        model: `${provider.model}+fallback`,
        provider: provider.name,
        prompt_version: PROMPT_VERSION,
        warning: `LLM HTTP ${res.status} — used cleaner`,
      };
    }
    const body = await res.json();
    let text = (body.choices && body.choices[0] && body.choices[0].message && body.choices[0].message.content) || "";
    text = String(text)
      .trim()
      .replace(/^```[\w]*\n?/, "")
      .replace(/\n?```$/, "")
      .trim();
    if (!text) text = fallback;
    text = groundDraft(sourceText, text);
    return {
      draft_text: text.slice(0, 2000),
      model: provider.model,
      provider: provider.name,
      prompt_version: PROMPT_VERSION,
    };
  } catch (err) {
    return {
      draft_text: fallback,
      model: `${provider.model}+fallback`,
      provider: provider.name,
      prompt_version: PROMPT_VERSION,
      warning: err && err.message ? err.message : "llm failed",
    };
  }
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import crypto from "node:crypto";
import fsSync from "node:fs";
import { generateDraftText, pickProvider, PROMPT_VERSION } from "./lib/draft-engine.js";
import { TRUST_VERSION, resolvePublishText, isLocked, freezePost, SUCCESS_CRITERIA } from "./lib/trust.js";
import { openStore } from "./lib/db.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const publicDir = path.resolve(__dirname, "public");
const DATA_DIR =
  process.env.DATA_DIR ||
  (fsSync.existsSync("/app/data") ? "/app/data" : path.join(__dirname, "data"));
const store = openStore(DATA_DIR);

// Load bot/.env first, then local server/.env. Never log token values.
// Empty BOT_TOKEN in server/.env must NOT wipe a real token from bot/.env.
// BOT_TOKEN from Railway env only
const priorToken = process.env.BOT_TOKEN;
dotenv.config({ path: path.join(__dirname, ".env"), override: true });
if (!process.env.BOT_TOKEN && priorToken) process.env.BOT_TOKEN = priorToken;

const PORT = Number(process.env.PORT) || 8787;
const CHANNEL_ID = process.env.CHANNEL_ID || "@readyshelf";
const WEBAPP_URL = process.env.WEBAPP_URL || `http://localhost:${PORT}`;
const BOT_TOKEN = process.env.BOT_TOKEN || "";

const MOCK_KEY = "dev";
const IS_PROD =
  String(process.env.RAILWAY_ENVIRONMENT || "").toLowerCase().includes("prod") ||
  String(process.env.WEBAPP_URL || "").includes("desk-production-");
const ALLOW_MOCK_KEY = process.env.ALLOW_MOCK_KEY === "1" && !IS_PROD;
const INGEST_KEY = process.env.INGEST_KEY || "";

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));
app.use(express.static(publicDir));

/**
 * Validate Telegram Mini App initData (HMAC-SHA256).
 * Official algorithm: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
 * Never log initData or botToken.
 */
function validateTelegramWebAppData(initData, botToken, maxAgeSec = 86400) {
  if (!initData || typeof initData !== "string" || !botToken) {
    return { ok: false, error: "missing initData or bot token" };
  }

  let params;
  try {
    params = new URLSearchParams(initData);
  } catch {
    return { ok: false, error: "invalid initData" };
  }

  const hash = params.get("hash");
  if (!hash) return { ok: false, error: "missing hash" };

  const pairs = [];
  for (const [key, value] of params.entries()) {
    if (key === "hash") continue;
    pairs.push(`${key}=${value}`);
  }
  pairs.sort();
  const dataCheckString = pairs.join("\n");

  const secretKey = crypto
    .createHmac("sha256", "WebAppData")
    .update(botToken)
    .digest();
  const calculated = crypto
    .createHmac("sha256", secretKey)
    .update(dataCheckString)
    .digest("hex");

  let hashBuf;
  let calcBuf;
  try {
    hashBuf = Buffer.from(hash, "hex");
    calcBuf = Buffer.from(calculated, "hex");
  } catch {
    return { ok: false, error: "invalid hash encoding" };
  }
  if (hashBuf.length !== calcBuf.length || !crypto.timingSafeEqual(hashBuf, calcBuf)) {
    return { ok: false, error: "bad signature" };
  }

  const authDateRaw = params.get("auth_date");
  const authDate = Number(authDateRaw);
  if (!Number.isFinite(authDate) || authDate <= 0) {
    return { ok: false, error: "missing auth_date" };
  }
  const nowSec = Math.floor(Date.now() / 1000);
  if (nowSec - authDate > maxAgeSec) {
    return { ok: false, error: "initData expired" };
  }
  if (authDate > nowSec + 60) {
    return { ok: false, error: "auth_date in the future" };
  }

  let user = null;
  const userRaw = params.get("user");
  if (userRaw) {
    try {
      user = JSON.parse(userRaw);
    } catch {
      return { ok: false, error: "invalid user JSON" };
    }
  }

  return { ok: true, user, authDate, params };
}

function requireTelegramAuth(req, res, next) {
  const initData = req.get("X-Telegram-Init-Data") || "";

  if (initData && BOT_TOKEN) {
    const result = validateTelegramWebAppData(initData, BOT_TOKEN);
    if (result.ok) {
      req.tgUser = result.user || null;
      return next();
    }
    return res.status(401).json({
      ok: false,
      error: "Unauthorized — invalid Telegram initData",
    });
  }

  if (ALLOW_MOCK_KEY) {
    const key = req.get("X-ReadyShelf-Mock-Key");
    if (key === MOCK_KEY) {
      req.tgUser = { id: 0, username: "mock", first_name: "Mock" };
      return next();
    }
  }

  return res.status(401).json({
    ok: false,
    error: ALLOW_MOCK_KEY
      ? "Unauthorized — missing Telegram initData or mock key"
      : "Unauthorized — open Desk from @ReadyShelfShopBot",
  });
}

function getBot() {
  if (!BOT_TOKEN) {
    const err = new Error("BOT_TOKEN is not set (check bot/.env or server/.env)");
    err.status = 503;
    throw err;
  }
  // polling: false — HTTP API only for sendMessage
  return new TelegramBot(BOT_TOKEN, { polling: false });
}

function channelMessageLink(channelId, messageId) {
  if (!messageId) return undefined;
  const raw = String(channelId || "");
  if (raw.startsWith("@")) {
    return `https://t.me/${raw.slice(1)}/${messageId}`;
  }
  // Private/supergroup numeric ids are not linkable this way
  return undefined;
}

async function readQueue() {
  return store.readQueue();
}

async function writeQueue(items) {
  return store.writeQueue(items);
}

async function readSources() {
  return store.readSources();
}

async function writeSources(items) {
  return store.writeSources(items);
}

async function readPosts() {
  return store.readPosts();
}

async function writePosts(items) {
  return store.writePosts(items);
}

function newId(prefix) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function ingestSource(fields) {
  const text = String(fields.text || "").trim();
  if (!text) {
    const err = new Error("text is required");
    err.status = 400;
    throw err;
  }
  const now = new Date().toISOString();
  const source = {
    id: newId("src"),
    text,
    fromUserId: fields.fromUserId ?? null,
    fromUsername: fields.fromUsername ?? null,
    messageId: fields.messageId ?? null,
    forwardedFrom: fields.forwardedFrom ?? null,
    status: "new",
    createdAt: now,
  };
  const sources = await readSources();
  sources.push(source);
  await writeSources(sources);
  if (process.env.DRAFT_ON_INGEST !== "0") {
    generateForSourceId(source.id).catch((err) => {
      console.error("draft-on-ingest failed", err && err.message);
    });
  }
  return source;
}

function webhookSecret() {
  if (process.env.TELEGRAM_WEBHOOK_SECRET) return String(process.env.TELEGRAM_WEBHOOK_SECRET);
  if (!BOT_TOKEN) return "";
  return crypto.createHmac("sha256", BOT_TOKEN).update("readyshelf-webhook").digest("hex").slice(0, 48);
}

function requireTelegramWebhook(req, res, next) {
  const want = webhookSecret();
  const got = req.get("X-Telegram-Bot-Api-Secret-Token") || "";
  if (!want) {
    return res.status(503).json({ ok: false, error: "webhook secret not configured" });
  }
  const a = Buffer.from(String(got));
  const b = Buffer.from(String(want));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: "Unauthorized — bad webhook secret" });
  }
  return next();
}

function forwardedFromLabel(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (msg.forward_from) {
    return msg.forward_from.username
      ? `@${msg.forward_from.username}`
      : msg.forward_from.first_name || "forward";
  }
  if (msg.forward_from_chat) {
    return msg.forward_from_chat.username
      ? `@${msg.forward_from_chat.username}`
      : msg.forward_from_chat.title || "forward";
  }
  if (msg.forward_sender_name) return msg.forward_sender_name;
  const origin = msg.forward_origin;
  if (origin) {
    if (origin.sender_user?.username) return `@${origin.sender_user.username}`;
    if (origin.sender_user?.first_name) return origin.sender_user.first_name;
    if (origin.sender_user_name) return origin.sender_user_name;
    if (origin.chat?.title) return origin.chat.title;
    if (origin.sender_chat?.title) return origin.sender_chat.title;
    return "forward";
  }
  return msg.forward_date ? "forward" : null;
}

function sourceFieldsFromTelegramMessage(msg) {
  const text = String(msg.text || msg.caption || "").trim();
  if (!text) return null;
  if (text.startsWith("/")) return null;
  return {
    text,
    fromUserId: msg.from?.id ?? null,
    fromUsername: msg.from?.username ?? null,
    messageId: msg.message_id ?? null,
    forwardedFrom: forwardedFromLabel(msg),
  };
}

async function handleBotCommand(msg) {
  const text = String(msg.text || "").trim();
  const chatId = msg.chat?.id;
  if (!chatId) return;
  const bot = getBot();
  const deskBtn = {
    reply_markup: {
      inline_keyboard: [[{ text: "Open Desk", web_app: { url: WEBAPP_URL } }]],
    },
  };
  const cmd = text.split(/\s+/)[0].split("@")[0].toLowerCase();
  if (cmd === "/start" || cmd === "/desk" || /^desk$/i.test(text)) {
    await bot.sendMessage(chatId, "ReadyShelf Desk — forward a source here, then Approve in Desk.", deskBtn);
    return;
  }
  if (cmd === "/help" || cmd === "/how" || /^how$/i.test(text) || /^help$/i.test(text)) {
    await bot.sendMessage(
      chatId,
      "Forward a message to this bot → it appears in Desk Inbox.\nGenerate a draft → Approve freezes exact text → it posts to @readyshelf.",
      deskBtn,
    );
    return;
  }
  if (cmd === "/plan" || /^plan$/i.test(text)) {
    await bot.sendMessage(chatId, "Plan is desk30 — ⭐ 500 / 30 days on @ReadyShelfShopBot. Existing Stars SKU.", deskBtn);
    return;
  }
  if (cmd === "/demo" || /^demo$/i.test(text)) {
    await bot.sendMessage(chatId, "Forward any tip or note to this bot, then open Desk to see it in Inbox.", deskBtn);
  }
}

async function upsertDraftForSource(source, generated) {
  const now = new Date().toISOString();
  const posts = await readPosts();
  const existing = posts.find(
    (p) => p.source_id === source.id && p.status !== "frozen" && p.status !== "published"
  );
  const post = existing
    ? {
        ...existing,
        draft_text: generated.draft_text,
        status: "ready",
        model: generated.model,
        provider: generated.provider,
        prompt_version: generated.prompt_version || PROMPT_VERSION,
        warning: generated.warning || null,
        updated_at: now,
      }
    : {
        id: newId("post"),
        source_id: source.id,
        draft_text: generated.draft_text,
        status: "ready",
        model: generated.model,
        provider: generated.provider,
        prompt_version: generated.prompt_version || PROMPT_VERSION,
        warning: generated.warning || null,
        created_at: now,
        updated_at: now,
      };
  const next = existing
    ? posts.map((p) => (p.id === post.id ? post : p))
    : [post, ...posts];
  await writePosts(next);

  const sources = await readSources();
  const srcNext = sources.map((s) =>
    s.id === source.id ? { ...s, status: "ready" } : s
  );
  await writeSources(srcNext);
  return post;
}

async function generateForSourceId(sourceId) {
  const sources = await readSources();
  const source = sources.find((s) => s.id === sourceId);
  if (!source) {
    const err = new Error("source not found");
    err.status = 404;
    throw err;
  }
  const generated = await generateDraftText(source.text || "");
  return upsertDraftForSource(source, generated);
}

function requireIngestKey(req, res, next) {
  if (!INGEST_KEY) {
    return res.status(503).json({ ok: false, error: "INGEST_KEY is not configured" });
  }
  const key = req.get("X-ReadyShelf-Ingest-Key") || "";
  const a = Buffer.from(String(key));
  const b = Buffer.from(String(INGEST_KEY));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res.status(401).json({ ok: false, error: "Unauthorized — bad ingest key" });
  }
  return next();
}

/** initData HMAC on all Mini App mutations. Bot ingest/webhook are the only exceptions. */
function requireInitDataOnMutations(req, res, next) {
  if (!req.path.startsWith("/api")) return next();
  const method = req.method.toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return next();
  if (method === "POST" && (req.path === "/api/sources" || req.path === "/api/telegram/webhook")) {
    return next();
  }
  return requireTelegramAuth(req, res, next);
}

app.use(requireInitDataOnMutations);


app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "readyshelf-app",
    channel: CHANNEL_ID,
    webapp: WEBAPP_URL,
    hasToken: Boolean(BOT_TOKEN),
    draft: (() => {
      const p = pickProvider();
      return { provider: p.name, model: p.model, prompt_version: PROMPT_VERSION };
    })(),
    trust: { version: TRUST_VERSION },
    auth: {
      initDataMutations: true,
      mock: ALLOW_MOCK_KEY,
      ingest: Boolean(INGEST_KEY),
    },
    persist: { driver: "sqlite", volume: DATA_DIR },
    success: SUCCESS_CRITERIA,
    bot: { webhook: "/api/telegram/webhook" },
  });
});

app.get("/api/me", requireTelegramAuth, (req, res) => {
  const u = req.tgUser || {};
  return res.json({
    ok: true,
    user: {
      id: u.id,
      username: u.username,
      first_name: u.first_name,
    },
  });
});

app.post("/api/publish", requireTelegramAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const posts = await readPosts();
    const { text, post } = resolvePublishText(posts, body);

    const bot = getBot();
    const msg = await bot.sendMessage(CHANNEL_ID, text, {
      disable_web_page_preview: false,
    });

    const message_id = msg?.message_id;
    const link =
      channelMessageLink(CHANNEL_ID, message_id) ||
      (message_id ? `https://t.me/readyshelf/${message_id}` : null);
    const now = new Date().toISOString();
    await writePosts(
      posts.map((p) =>
        p.id === post.id
          ? { ...p, status: "published", published_at: now, link, updated_at: now }
          : p,
      ),
    );

    return res.json({ ok: true, message_id, link, postId: post.id, text });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({
      ok: false,
      error: err.message || "publish failed",
    });
  }
});

app.post("/api/approve-queue", requireTelegramAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const postId = typeof body.postId === "string" ? body.postId.trim() : "";
    if (!postId) {
      return res.status(400).json({
        ok: false,
        error: "postId is required — nothing publishes without Approve of frozen text",
      });
    }
    const text =
      typeof body.text === "string"
        ? body.text
        : typeof body.frozenText === "string"
          ? body.frozenText
          : "";
    if (!text.trim()) {
      return res.status(400).json({ ok: false, error: "text (frozen) is required" });
    }

    const posts = await readPosts();
    const idx = posts.findIndex((p) => p.id === postId);
    if (idx < 0) return res.status(404).json({ ok: false, error: "post not found" });
    const post = posts[idx];
    if (post.status === "published") {
      return res.status(409).json({ ok: false, error: "post already published" });
    }
    try {
      const frozen = freezePost(post, text);
      posts[idx] = { ...frozen, updated_at: new Date().toISOString() };
      await writePosts(posts);
    } catch (err) {
      return res.status(err.status || 409).json({ ok: false, error: err.message });
    }

    const scheduledAt = body.scheduledAt || body.time || body.publishAt || null;
    const now = new Date().toISOString();
    const item = {
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      postId,
      text: text.trim(),
      time: scheduledAt || now,
      scheduledAt: scheduledAt || null,
      status: "approved",
      createdAt: now,
      source: body.source || null,
    };

    const queue = await readQueue();
    queue.push(item);
    await writeQueue(queue);

    return res.json({ ok: true, item, count: queue.length, frozen_text: text.trim() });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "approve-queue failed",
    });
  }
});

app.post("/api/telegram/webhook", requireTelegramWebhook, async (req, res) => {
  try {
    const update = req.body || {};
    const msg = update.message || update.edited_message || update.channel_post;
    if (!msg) return res.json({ ok: true });

    const text = String(msg.text || "").trim();
    if (text.startsWith("/") || /^(desk|demo|how|plan|help)$/i.test(text)) {
      handleBotCommand(msg).catch((err) => {
        console.error("bot command failed", err && err.message);
      });
      return res.json({ ok: true });
    }

    const fields = sourceFieldsFromTelegramMessage(msg);
    if (!fields) {
      if (msg.chat?.id && BOT_TOKEN) {
        getBot()
          .sendMessage(msg.chat.id, "Forward a text message (or a caption) to save it in Desk.")
          .catch(() => {});
      }
      return res.json({ ok: true });
    }

    const source = await ingestSource(fields);
    if (msg.chat?.id && BOT_TOKEN) {
      getBot()
        .sendMessage(msg.chat.id, "Saved to Desk Inbox.", {
          reply_markup: {
            inline_keyboard: [[{ text: "Open Desk", web_app: { url: WEBAPP_URL } }]],
          },
        })
        .catch(() => {});
    }
    return res.json({ ok: true, sourceId: source.id });
  } catch (err) {
    return res.status(err.status || 500).json({
      ok: false,
      error: err.message || "webhook failed",
    });
  }
});

app.post("/api/sources", requireIngestKey, async (req, res) => {
  try {
    const body = req.body || {};
    const source = await ingestSource({
      text: body.text,
      fromUserId: body.fromUserId ?? null,
      fromUsername: body.fromUsername ?? null,
      messageId: body.messageId ?? null,
      forwardedFrom: body.forwardedFrom ?? null,
    });
    const sources = await readSources();
    return res.json({ ok: true, source, count: sources.length });
  } catch (err) {
    return res.status(err.status || 500).json({
      ok: false,
      error: err.message || "ingest failed",
    });
  }
});

app.get("/api/sources", requireTelegramAuth, async (req, res) => {
  try {
    const sources = await readSources();
    const newest = sources
      .slice()
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")));
    return res.json({ ok: true, sources: newest });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "list sources failed",
    });
  }
});


app.post("/api/sources/manual", requireTelegramAuth, async (req, res) => {
  try {
    const body = req.body || {};
    const text = typeof body.text === "string" ? body.text.trim() : "";
    if (!text) {
      return res.status(400).json({ ok: false, error: "text is required" });
    }
    const now = new Date().toISOString();
    const u = req.tgUser || {};
    const source = {
      id: newId("src"),
      text,
      fromUserId: u.id ?? null,
      fromUsername: u.username ?? "desk",
      messageId: null,
      forwardedFrom: "Desk paste",
      status: "new",
      createdAt: now,
    };
    const sources = await readSources();
    sources.push(source);
    await writeSources(sources);
    return res.json({ ok: true, source, count: sources.length });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "manual ingest failed" });
  }
});

app.post("/api/drafts/generate", requireTelegramAuth, async (req, res) => {
  try {
    const sourceId = req.body && req.body.sourceId;
    if (!sourceId || typeof sourceId !== "string") {
      return res.status(400).json({ ok: false, error: "sourceId is required" });
    }
    const post = await generateForSourceId(sourceId);
    return res.json({ ok: true, postId: post.id, draft_text: post.draft_text, post });
  } catch (err) {
    const status = err.status || 500;
    return res.status(status).json({ ok: false, error: err.message || "generate failed" });
  }
});

app.get("/api/posts", requireTelegramAuth, async (req, res) => {
  try {
    const status = typeof req.query.status === "string" ? req.query.status : "";
    let posts = await readPosts();
    if (status) {
      const allowed = status.split(",").map((s) => s.trim()).filter(Boolean);
      posts = posts.filter((p) => allowed.includes(p.status));
    }
    posts = posts
      .slice()
      .sort((a, b) => String(b.updated_at || b.created_at || "").localeCompare(String(a.updated_at || a.created_at || "")));
    return res.json({ ok: true, posts });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "list posts failed" });
  }
});

app.patch("/api/posts/:id", requireTelegramAuth, async (req, res) => {
  try {
    const id = req.params.id;
    const body = req.body || {};
    const posts = await readPosts();
    const idx = posts.findIndex((p) => p.id === id);
    if (idx < 0) return res.status(404).json({ ok: false, error: "post not found" });
    const post = posts[idx];
    if (isLocked(post)) {
      return res.status(409).json({ ok: false, error: "post is frozen" });
    }
    if (typeof body.draft_text === "string") {
      post.draft_text = body.draft_text.trim();
    }
    if (typeof body.status === "string" && ["draft", "ready"].includes(body.status)) {
      post.status = body.status;
    }
    post.updated_at = new Date().toISOString();
    posts[idx] = post;
    await writePosts(posts);
    return res.json({ ok: true, post });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message || "patch post failed" });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  // Do not print BOT_TOKEN or any secret values
  console.log(`ReadyShelf server listening on http://localhost:${PORT}`);
  console.log(`Static UI: ${publicDir}`);
  console.log(`Channel: ${CHANNEL_ID}`);
  console.log(`Token configured: ${BOT_TOKEN ? "yes" : "no"}`);
  const p = pickProvider();
  console.log(`Draft Engine: ${p.name} · ${p.model} · ${PROMPT_VERSION}`);
  console.log(`Data dir: ${DATA_DIR} · sqlite`);
  if (BOT_TOKEN && /^https:\/\//i.test(WEBAPP_URL)) {
    const hook = `${String(WEBAPP_URL).replace(/\/$/, "")}/api/telegram/webhook`;
    getBot()
      .setWebHook(hook, { secret_token: webhookSecret() })
      .then(() => console.log("Telegram webhook registered"))
      .catch((err) => console.error("webhook register failed", err && err.message));
  }
});


import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";
import crypto from "node:crypto";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../..");
const publicDir = path.resolve(__dirname, "public");
const queuePath = path.join(__dirname, "data", "queue.json");

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
const ALLOW_MOCK_KEY = process.env.ALLOW_MOCK_KEY === "1";

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
  try {
    const raw = await fs.readFile(queuePath, "utf8");
    const data = JSON.parse(raw);
    return Array.isArray(data) ? data : [];
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }
}

async function writeQueue(items) {
  await fs.mkdir(path.dirname(queuePath), { recursive: true });
  await fs.writeFile(queuePath, JSON.stringify(items, null, 2) + "\n", "utf8");
}

app.get("/api/health", (_req, res) => {
  res.json({
    ok: true,
    service: "readyshelf-app",
    channel: CHANNEL_ID,
    webapp: WEBAPP_URL,
    hasToken: Boolean(BOT_TOKEN),
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
    const { text, scheduledAt } = req.body || {};
    if (!text || typeof text !== "string" || !text.trim()) {
      return res.status(400).json({ ok: false, error: "text is required" });
    }

    // scheduledAt reserved for a real scheduler; v1 publishes immediately
    if (scheduledAt) {
      // acknowledged but not deferred yet
    }

    const bot = getBot();
    const msg = await bot.sendMessage(CHANNEL_ID, text.trim(), {
      disable_web_page_preview: false,
    });

    const message_id = msg?.message_id;
    const link = channelMessageLink(CHANNEL_ID, message_id);

    return res.json({ ok: true, message_id, link });
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
    const text =
      typeof body.text === "string"
        ? body.text
        : typeof body.frozenText === "string"
          ? body.frozenText
          : "";
    if (!text.trim()) {
      return res.status(400).json({ ok: false, error: "text (frozen) is required" });
    }

    const scheduledAt =
      body.scheduledAt || body.time || body.publishAt || null;
    const now = new Date().toISOString();

    const item = {
      id: `q_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      text: text.trim(), // frozen approved copy
      time: scheduledAt || now,
      scheduledAt: scheduledAt || null,
      status: body.status || "approved",
      createdAt: now,
      source: body.source || null,
    };

    const queue = await readQueue();
    queue.push(item);
    await writeQueue(queue);

    return res.json({ ok: true, item, count: queue.length });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message || "approve-queue failed",
    });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  // Do not print BOT_TOKEN or any secret values
  console.log(`ReadyShelf server listening on http://localhost:${PORT}`);
  console.log(`Static UI: ${publicDir}`);
  console.log(`Channel: ${CHANNEL_ID}`);
  console.log(`Token configured: ${BOT_TOKEN ? "yes" : "no"}`);
});


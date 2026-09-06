import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import TelegramBot from "node-telegram-bot-api";

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

const app = express();
app.use(cors());
app.use(express.json({ limit: "256kb" }));
app.use(express.static(publicDir));

function requireMockKey(req, res, next) {
  // TODO: replace with Telegram WebApp initData HMAC validation
  // (validate initData signature with BOT_TOKEN; reject expired auth_date)
  const key = req.get("X-ReadyShelf-Mock-Key");
  if (key !== MOCK_KEY) {
    return res.status(401).json({
      ok: false,
      error: "Unauthorized — missing or invalid X-ReadyShelf-Mock-Key",
    });
  }
  next();
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

app.post("/api/publish", requireMockKey, async (req, res) => {
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

app.post("/api/approve-queue", requireMockKey, async (req, res) => {
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


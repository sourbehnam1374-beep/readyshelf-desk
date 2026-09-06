/** Positioning — copy inside the app. Keep every screen on this voice. */

export const POSITIONING = {
  name: "ReadyShelf Desk",
  line: "Forward a source → get a clean draft → Approve freezes exact text → it posts to the channel.",
  is: "An approval inbox with an assisted draft.",
  yes: "Your next posts are ready for your approval.",
  isNot: "Not “AI writes your channel.” Not “AI in your voice.” Not a fact-checker. Not auto-post.",
  who: "One operator. One channel.",
  price: "desk30 · ⭐500 / 30 days",
  screens: {
    inbox: "Your next posts are ready for your approval.",
    review: "Source | Draft. Approve freezes exact text — then live on @readyshelf.",
    queue: "Only frozen text goes live. Each sent item has a t.me link.",
    settings: "One channel · one approver · not AI in your voice.",
  },
};

export const REFERENCE = {
  live: "https://desk-production-537d.up.railway.app",
  github: "https://github.com/sourbehnam1374-beep/readyshelf-desk",
  railway: "readyshelf-desk",
  bot: "@ReadyShelfShopBot",
  channel: "@readyshelf",
  sku: "desk30",
  stars: 500,
  volume: "/app/data",
  keepEnv: ["WEBAPP_URL", "BOT_TOKEN", "INGEST_KEY"],
};

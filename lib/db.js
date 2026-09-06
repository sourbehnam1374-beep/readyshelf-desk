/**
 * SQLite store on the Railway volume (DATA_DIR).
 * Replaces crash-fragile JSON rewrites. Migrates sources.json / posts.json / queue.json once.
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const TABLES = ["sources", "posts", "queue"];

export function openStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true });
  const dbPath = path.join(dataDir, "readyshelf.sqlite");
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA busy_timeout = 5000;");
  db.exec("PRAGMA synchronous = NORMAL;");
  db.exec(`
    CREATE TABLE IF NOT EXISTS sources (
      id TEXT PRIMARY KEY,
      status TEXT,
      created_at TEXT,
      ord INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS posts (
      id TEXT PRIMARY KEY,
      source_id TEXT,
      status TEXT,
      created_at TEXT,
      updated_at TEXT,
      ord INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS posts_source ON posts(source_id);
    CREATE INDEX IF NOT EXISTS posts_status ON posts(status);
    CREATE TABLE IF NOT EXISTS queue (
      id TEXT PRIMARY KEY,
      created_at TEXT,
      ord INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );
  `);

  migrateJson(db, dataDir);

  function list(table) {
    const rows = db.prepare(`SELECT payload FROM ${table} ORDER BY ord ASC`).all();
    const out = [];
    for (const row of rows) {
      try {
        out.push(JSON.parse(row.payload));
      } catch {
        /* skip corrupt row */
      }
    }
    return out;
  }

  function replace(table, items) {
    const rows = Array.isArray(items) ? items : [];
    const insert =
      table === "posts"
        ? db.prepare(
            "INSERT INTO posts(id, source_id, status, created_at, updated_at, ord, payload) VALUES (?,?,?,?,?,?,?)",
          )
        : table === "sources"
          ? db.prepare(
              "INSERT INTO sources(id, status, created_at, ord, payload) VALUES (?,?,?,?,?)",
            )
          : db.prepare(
              "INSERT INTO queue(id, created_at, ord, payload) VALUES (?,?,?,?)",
            );
    db.exec("BEGIN");
    try {
      db.exec(`DELETE FROM ${table}`);
      rows.forEach((item, ord) => {
        if (!item || typeof item !== "object") return;
        const id = String(item.id || "");
        if (!id) return;
        const payload = JSON.stringify(item);
        if (table === "posts") {
          insert.run(
            id,
            item.source_id ?? null,
            item.status ?? null,
            item.created_at ?? null,
            item.updated_at ?? null,
            ord,
            payload,
          );
        } else if (table === "sources") {
          insert.run(id, item.status ?? null, item.createdAt ?? item.created_at ?? null, ord, payload);
        } else {
          insert.run(id, item.createdAt ?? item.created_at ?? null, ord, payload);
        }
      });
      db.exec("COMMIT");
    } catch (err) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw err;
    }
  }

  return {
    driver: "sqlite",
    path: dbPath,
    async readQueue() {
      return list("queue");
    },
    async writeQueue(items) {
      replace("queue", items);
    },
    async readSources() {
      return list("sources");
    },
    async writeSources(items) {
      replace("sources", items);
    },
    async readPosts() {
      return list("posts");
    },
    async writePosts(items) {
      replace("posts", items);
    },
  };
}

function migrateJson(db, dataDir) {
  const get = db.prepare("SELECT value FROM meta WHERE key = ?");
  const put = db.prepare("INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)");
  if (get.get("migrated_json")?.value === "1") return;

  const sourcesEmpty = db.prepare("SELECT COUNT(*) AS n FROM sources").get().n === 0;
  const postsEmpty = db.prepare("SELECT COUNT(*) AS n FROM posts").get().n === 0;
  const queueEmpty = db.prepare("SELECT COUNT(*) AS n FROM queue").get().n === 0;

  const insertSource = db.prepare(
    "INSERT OR IGNORE INTO sources(id, status, created_at, ord, payload) VALUES (?,?,?,?,?)",
  );
  const insertPost = db.prepare(
    "INSERT OR IGNORE INTO posts(id, source_id, status, created_at, updated_at, ord, payload) VALUES (?,?,?,?,?,?,?)",
  );
  const insertQueue = db.prepare(
    "INSERT OR IGNORE INTO queue(id, created_at, ord, payload) VALUES (?,?,?,?)",
  );

  db.exec("BEGIN");
  try {
    if (sourcesEmpty) importFile(path.join(dataDir, "sources.json"), insertSource, "sources");
    if (postsEmpty) importFile(path.join(dataDir, "posts.json"), insertPost, "posts");
    if (queueEmpty) importFile(path.join(dataDir, "queue.json"), insertQueue, "queue");
    put.run("migrated_json", "1");
    put.run("migrated_at", new Date().toISOString());
    db.exec("COMMIT");
  } catch (err) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw err;
  }
}

function importFile(filePath, insert, table) {
  if (!fs.existsSync(filePath)) return;
  let data;
  try {
    data = JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return;
  }
  if (!Array.isArray(data)) return;
  data.forEach((item, ord) => {
    if (!item || typeof item !== "object" || !item.id) return;
    const payload = JSON.stringify(item);
    if (table === "posts") {
      insert.run(
        String(item.id),
        item.source_id ?? null,
        item.status ?? null,
        item.created_at ?? null,
        item.updated_at ?? null,
        ord,
        payload,
      );
    } else if (table === "sources") {
      insert.run(
        String(item.id),
        item.status ?? null,
        item.createdAt ?? item.created_at ?? null,
        ord,
        payload,
      );
    } else {
      insert.run(String(item.id), item.createdAt ?? item.created_at ?? null, ord, payload);
    }
  });
}

void TABLES;

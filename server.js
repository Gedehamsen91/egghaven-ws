import "dotenv/config";
import http from "http";
import crypto from "crypto";
import { WebSocketServer } from "ws";
import pg from "pg";

const PORT = process.env.PORT ? Number(process.env.PORT) : 10000;
const DATABASE_URL = process.env.DATABASE_URL || "";
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const { Pool } = pg;

function shouldUseSsl(connectionString) {
  // Hvis du en dag bruger en URL med sslmode=require, så tænder vi SSL.
  return /sslmode=require/i.test(connectionString);
}

const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: shouldUseSsl(DATABASE_URL) ? { rejectUnauthorized: false } : false
    })
  : null;

// -------- In-memory fallback (bruges altid, DB bruges kun til drops hvis sat) --------
const clients = new Map(); // ws -> { id, name, room, x, y }
const rooms = new Map();   // room -> Set(ws)
const dropsMem = new Map(); // room -> Map(dropId -> drop)

function rid() {
  return crypto.randomBytes(8).toString("hex");
}
function safeName(s) {
  const t = String(s ?? "").trim().slice(0, 18);
  return t || "Player";
}
function roomKey(msgRoom) {
  if (msgRoom === undefined || msgRoom === null) return "Lobby";
  return String(msgRoom).slice(0, 40) || "Lobby";
}
function getRoomSet(room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  return rooms.get(room);
}
function getRoomDrops(room) {
  if (!dropsMem.has(room)) dropsMem.set(room, new Map());
  return dropsMem.get(room);
}
function broadcast(room, obj) {
  const set = rooms.get(room);
  if (!set) return;
  const msg = JSON.stringify(obj);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}
function snapshot(room) {
  const set = rooms.get(room) ?? new Set();
  const players = [];
  for (const ws of set) {
    const p = clients.get(ws);
    if (p) players.push({ id: p.id, name: p.name, x: p.x, y: p.y });
  }
  const roomDrops = [...getRoomDrops(room).values()];
  return { players, drops: roomDrops };
}

// -------- DB: kun drops persistence --------
async function dbInit() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_drops (
      room      TEXT NOT NULL,
      drop_id   TEXT PRIMARY KEY,
      item_type TEXT NOT NULL,
      x         INTEGER NOT NULL,
      y         INTEGER NOT NULL,
      payload   JSONB NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);
}

async function dbLoadDrops(room) {
  if (!pool) return [];
  const res = await pool.query(
    `SELECT payload FROM room_drops WHERE room = $1 ORDER BY created_at ASC`,
    [room]
  );
  return res.rows.map(r => r.payload);
}

async function dbInsertDrop(room, drop) {
  if (!pool) return;
  await pool.query(
    `INSERT INTO room_drops(room, drop_id, item_type, x, y, payload)
     VALUES($1, $2, $3, $4, $5, $6)
     ON CONFLICT (drop_id) DO NOTHING`,
    [room, drop.dropId, drop.itemType, drop.x, drop.y, drop]
  );
}

async function dbDeleteDrop(dropId) {
  if (!pool) return;
  await pool.query(`DELETE FROM room_drops WHERE drop_id = $1`, [dropId]);
}

// -------- HTTP + WS server --------
const server = http.createServer(async (req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(
      JSON.stringify({
        ok: true,
        db: Boolean(pool),
        databaseUrlSet: Boolean(DATABASE_URL)
      })
    );
  }

  res.writeHead(200, { "content-type": "text/plain" });
  res.end("EggHaven WS server running");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws, req) => {
  // (valgfrit) origin check – hvis du får problemer, så lad ALLOWED_ORIGINS være tom
  const origin = req.headers.origin || "";
  if (ALLOWED_ORIGINS.length && origin && !ALLOWED_ORIGINS.includes(origin)) {
    ws.close(1008, "Origin not allowed");
    return;
  }

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    if (msg.t === "join") {
      const id = rid();
      const name = safeName(msg.name);
      const room = roomKey(msg.room);
      const x = Number.isFinite(msg.x) ? msg.x : 5;
      const y = Number.isFinite(msg.y) ? msg.y : 5;

      clients.set(ws, { id, name, room, x, y });
      getRoomSet(room).add(ws);

      // load drops fra DB (en gang pr join) og merge til memory
      try {
        const dbDrops = pool ? await dbLoadDrops(room) : [];
        const m = getRoomDrops(room);
        for (const d of dbDrops) m.set(d.dropId, d);
      } catch (e) {
        // hvis DB fejler, fortsæt bare med in-memory
        console.error("DB load drops failed:", e?.message || e);
      }

      ws.send(JSON.stringify({ t: "welcome", id, room, snapshot: snapshot(room) }));
      broadcast(room, { t: "player_join", player: { id, name, x, y } });
      return;
    }

    const me = clients.get(ws);
    if (!me) return;

    if (msg.t === "move") {
      me.x = Number.isFinite(msg.x) ? msg.x : me.x;
      me.y = Number.isFinite(msg.y) ? msg.y : me.y;
      broadcast(me.room, { t: "player_move", id: me.id, x: me.x, y: me.y });
      return;
    }

    if (msg.t === "chat") {
      const text = String(msg.text ?? "").trim().slice(0, 180);
      if (!text) return;
      broadcast(me.room, { t: "chat", id: me.id, name: me.name, text });
      return;
    }

    if (msg.t === "drop") {
      const itemType = String(msg.itemType ?? "item").slice(0, 24);
      const x = Number.isFinite(msg.x) ? msg.x : me.x;
      const y = Number.isFinite(msg.y) ? msg.y : me.y;
      const dropId = rid();

      const drop = { dropId, itemType, x, y, by: me.id };
      getRoomDrops(me.room).set(dropId, drop);

      // persist
      try { await dbInsertDrop(me.room, drop); } catch (e) {
        console.error("DB insert drop failed:", e?.message || e);
      }

      broadcast(me.room, { t: "drop_spawn", drop });
      return;
    }

    if (msg.t === "pickup") {
      const dropId = String(msg.dropId ?? "");
      const roomDrops = getRoomDrops(me.room);
      const drop = roomDrops.get(dropId);
      if (!drop) return;

      roomDrops.delete(dropId);

      // persist
      try { await dbDeleteDrop(dropId); } catch (e) {
        console.error("DB delete drop failed:", e?.message || e);
      }

      broadcast(me.room, { t: "drop_picked", dropId, by: me.id });
      return;
    }
  });

  ws.on("close", () => {
    const me = clients.get(ws);
    if (!me) return;
    clients.delete(ws);

    const set = rooms.get(me.room);
    if (set) {
      set.delete(ws);
      if (set.size === 0) rooms.delete(me.room);
    }

    broadcast(me.room, { t: "player_leave", id: me.id });
  });
});

await dbInit();

server.listen(PORT, "0.0.0.0", () => {
  console.log("WS server listening on", PORT);
  console.log("DATABASE_URL set:", Boolean(DATABASE_URL));
});

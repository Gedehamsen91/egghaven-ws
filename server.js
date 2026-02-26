import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";
import pg from "pg";

const { Pool } = pg;

const PORT = process.env.PORT || 3000;
const DATABASE_URL = process.env.DATABASE_URL || "";

// -----------------------------
// DB
// -----------------------------
const hasDb = Boolean(DATABASE_URL && DATABASE_URL.trim().length > 0);

// Render Postgres: brug SSL, men allow self-signed / managed certs.
// Hvis du bruger Render "Internal Database URL", kan SSL stadig være ok.
const pool = hasDb
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl: { rejectUnauthorized: false }
    })
  : null;

async function dbInit() {
  if (!pool) return;

  // Gem droppede items per room
  await pool.query(`
    CREATE TABLE IF NOT EXISTS room_drops (
      room TEXT NOT NULL,
      drop_id TEXT NOT NULL,
      item_type TEXT NOT NULL,
      x INT NOT NULL,
      y INT NOT NULL,
      by_id TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (room, drop_id)
    );
  `);

  // (Valgfrit) lidt housekeeping: index til hurtig load pr room
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_room_drops_room ON room_drops(room);
  `);

  console.log("[DB] ready");
}

async function dbLoadDrops(room) {
  if (!pool) return [];
  const { rows } = await pool.query(
    `SELECT drop_id, item_type, x, y, by_id FROM room_drops WHERE room = $1`,
    [room]
  );
  return rows.map((r) => ({
    dropId: r.drop_id,
    itemType: r.item_type,
    x: r.x,
    y: r.y,
    by: r.by_id
  }));
}

async function dbInsertDrop(room, drop) {
  if (!pool) return;
  await pool.query(
    `
    INSERT INTO room_drops (room, drop_id, item_type, x, y, by_id)
    VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT (room, drop_id) DO UPDATE
      SET item_type = EXCLUDED.item_type,
          x = EXCLUDED.x,
          y = EXCLUDED.y,
          by_id = EXCLUDED.by_id
  `,
    [room, drop.dropId, drop.itemType, drop.x, drop.y, drop.by]
  );
}

async function dbDeleteDrop(room, dropId) {
  if (!pool) return;
  await pool.query(`DELETE FROM room_drops WHERE room = $1 AND drop_id = $2`, [
    room,
    dropId
  ]);
}

// -----------------------------
// In-memory runtime state
// -----------------------------
const clients = new Map(); // ws -> {id,name,room,x,y}
const rooms = new Map(); // room -> Set(ws)
const drops = new Map(); // room -> Map(dropId -> drop)

function rid() {
  return crypto.randomBytes(8).toString("hex");
}

function safeName(s) {
  const t = String(s ?? "").trim().slice(0, 18);
  return t || "Player";
}

function getRoomSet(room) {
  if (!rooms.has(room)) rooms.set(room, new Set());
  return rooms.get(room);
}

function getRoomDrops(room) {
  if (!drops.has(room)) drops.set(room, new Map());
  return drops.get(room);
}

function broadcast(room, obj) {
  const set = rooms.get(room);
  if (!set) return;
  const msg = JSON.stringify(obj);
  for (const ws of set) {
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

async function snapshot(room) {
  const set = rooms.get(room) ?? new Set();
  const players = [];
  for (const ws of set) {
    const p = clients.get(ws);
    if (p) players.push({ id: p.id, name: p.name, x: p.x, y: p.y });
  }

  // drops fra memory (hurtigt) — hvis room ikke er loaded endnu, hent fra DB
  const roomDropsMap = getRoomDrops(room);
  if (roomDropsMap.size === 0 && hasDb) {
    const fromDb = await dbLoadDrops(room);
    for (const d of fromDb) roomDropsMap.set(d.dropId, d);
  }

  const roomDrops = [...roomDropsMap.values()];
  return { players, drops: roomDrops };
}

// -----------------------------
// HTTP + WS
// -----------------------------
const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true, db: hasDb }));
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("EggHaven WS server running");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.on("message", async (raw) => {
    let msg;
    try {
      msg = JSON.parse(String(raw));
    } catch {
      return;
    }

    // JOIN
    if (msg.t === "join") {
      const id = rid();
      const name = safeName(msg.name);
      const room = String(msg.room ?? "Lobby").slice(0, 32);
      const x = Number.isFinite(msg.x) ? msg.x : 5;
      const y = Number.isFinite(msg.y) ? msg.y : 5;

      clients.set(ws, { id, name, room, x, y });
      const set = getRoomSet(room);
      set.add(ws);

      const snap = await snapshot(room);

      ws.send(JSON.stringify({ t: "welcome", id, room, snapshot: snap }));
      broadcast(room, { t: "player_join", player: { id, name, x, y } });
      return;
    }

    const me = clients.get(ws);
    if (!me) return;

    // MOVE
    if (msg.t === "move") {
      me.x = Number.isFinite(msg.x) ? msg.x : me.x;
      me.y = Number.isFinite(msg.y) ? msg.y : me.y;
      broadcast(me.room, { t: "player_move", id: me.id, x: me.x, y: me.y });
      return;
    }

    // CHAT
    if (msg.t === "chat") {
      const text = String(msg.text ?? "").trim().slice(0, 180);
      if (!text) return;
      broadcast(me.room, { t: "chat", id: me.id, name: me.name, text });
      return;
    }

    // DROP (persist)
    if (msg.t === "drop") {
      const itemType = String(msg.itemType ?? "item").slice(0, 24);
      const x = Number.isFinite(msg.x) ? msg.x : me.x;
      const y = Number.isFinite(msg.y) ? msg.y : me.y;
      const dropId = rid();

      const drop = { dropId, itemType, x, y, by: me.id };

      // memory
      getRoomDrops(me.room).set(dropId, drop);

      // db
      try {
        await dbInsertDrop(me.room, drop);
      } catch (e) {
        console.error("[DB] insert drop failed", e?.message || e);
      }

      broadcast(me.room, { t: "drop_spawn", drop });
      return;
    }

    // PICKUP (persist delete)
    if (msg.t === "pickup") {
      const dropId = String(msg.dropId ?? "");
      const roomDrops = getRoomDrops(me.room);
      const drop = roomDrops.get(dropId);
      if (!drop) return;

      // memory
      roomDrops.delete(dropId);

      // db
      try {
        await dbDeleteDrop(me.room, dropId);
      } catch (e) {
        console.error("[DB] delete drop failed", e?.message || e);
      }

      broadcast(me.room, { t: "drop_picked", dropId, by: me.id });
      return;
    }
  });

  ws.on("close", () => {
    const me = clients.get(ws);
    if (!me) return;
    const set = rooms.get(me.room);
    if (set) set.delete(ws);
    clients.delete(ws);
    broadcast(me.room, { t: "player_leave", id: me.id });
  });
});

server.listen(PORT, async () => {
  console.log(`WS server listening on ${PORT}`);
  if (!hasDb) {
    console.log("[DB] DATABASE_URL not set -> running WITHOUT persistence");
    return;
  }
  try {
    await dbInit();
  } catch (e) {
    console.error("[DB] init failed", e?.message || e);
  }
});

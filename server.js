import http from "http";
import { WebSocketServer } from "ws";
import crypto from "crypto";

const PORT = process.env.PORT || 3000;

const clients = new Map();
const rooms = new Map();
const drops = new Map();

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

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("EggHaven WS server running");
});

const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }

    if (msg.t === "join") {
      const id = rid();
      const name = safeName(msg.name);
      const room = String(msg.room ?? "Lobby").slice(0, 32);
      const x = Number.isFinite(msg.x) ? msg.x : 5;
      const y = Number.isFinite(msg.y) ? msg.y : 5;

      clients.set(ws, { id, name, room, x, y });
      const set = getRoomSet(room);
      set.add(ws);

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
      broadcast(me.room, { t: "drop_spawn", drop });
      return;
    }

    if (msg.t === "pickup") {
      const dropId = String(msg.dropId ?? "");
      const roomDrops = getRoomDrops(me.room);
      const drop = roomDrops.get(dropId);
      if (!drop) return;

      roomDrops.delete(dropId);
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

server.listen(PORT, () => {
  console.log(`WS server listening on ${PORT}`);
});
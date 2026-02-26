import 'dotenv/config';
import http from 'http';
import { WebSocketServer } from 'ws';
import pg from 'pg';

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
const DATABASE_URL = process.env.DATABASE_URL || '';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// ----- Simple in-memory state (always used), DB-backed for drops when DATABASE_URL exists -----
// rooms: Map<roomKey, { players: Map<clientId, Player>, drops: Map<dropId, Drop> }>
const rooms = new Map();
let nextClientId = 1;

function roomKeyFrom(msgRoom) {
  // client sends either room: "5600" or roomKey:"yourfarm_xxx" (private)
  if (msgRoom === undefined || msgRoom === null) return '0';
  return String(msgRoom);
}

function getRoom(key) {
  let r = rooms.get(key);
  if (!r) {
    r = { players: new Map(), drops: new Map() };
    rooms.set(key, r);
  }
  return r;
}

// ----- Database (optional) -----
const { Pool } = pg;
const pool = DATABASE_URL
  ? new Pool({
      connectionString: DATABASE_URL,
      ssl:
        DATABASE_URL.includes('render.com') || DATABASE_URL.includes('supabase')
          ? { rejectUnauthorized: false }
          : undefined
    })
  : null;

async function dbInit() {
  if (!pool) return;
  await pool.query(`
    create table if not exists egghaven_drops(
      room_key text not null,
      drop_id text primary key,
      item_type text not null,
      x int not null,
      y int not null,
      skin text,
      created_at timestamptz not null default now()
    );
  `);
  await pool.query(
    `create index if not exists egghaven_drops_room_idx on egghaven_drops(room_key);`
  );
}

async function dbLoadRoomDrops(room_key) {
  if (!pool) return [];
  const res = await pool.query(
    `select drop_id, item_type, x, y, skin from egghaven_drops where room_key=$1`,
    [room_key]
  );
  return res.rows.map(r => ({
    id: r.drop_id,
    itemType: r.item_type,
    x: r.x,
    y: r.y,
    skin: r.skin || null
  }));
}

async function dbUpsertDrop(room_key, drop) {
  if (!pool) return;
  await pool.query(
    `insert into egghaven_drops(room_key, drop_id, item_type, x, y, skin)
     values($1,$2,$3,$4,$5,$6)
     on conflict(drop_id) do update set
       room_key=excluded.room_key,
       item_type=excluded.item_type,
       x=excluded.x,
       y=excluded.y,
       skin=excluded.skin`,
    [room_key, drop.id, drop.itemType, drop.x, drop.y, drop.skin || null]
  );
}

async function dbDeleteDrop(drop_id) {
  if (!pool) return;
  await pool.query(`delete from egghaven_drops where drop_id=$1`, [drop_id]);
}

// ----- HTTP server (healthcheck) -----
const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('EggHaven WS server');
});

const wss = new WebSocketServer({ server });

// ----- Helpers -----
function send(ws, obj) {
  try {
    ws.send(JSON.stringify(obj));
  } catch {}
}

function broadcast(roomKey, obj) {
  const room = getRoom(roomKey);
  for (const player of room.players.values()) {
    send(player.ws, obj);
  }
}

function originAllowed(req) {
  if (!ALLOWED_ORIGINS.length) return true; // allow all if not specified
  const origin = req.headers.origin || '';
  return ALLOWED_ORIGINS.includes(origin);
}

// ----- WS handling -----
wss.on('connection', async (ws, req) => {
  if (!originAllowed(req)) {
    ws.close(1008, 'Origin not allowed');
    return;
  }

  const clientId = String(nextClientId++);
  let currentRoomKey = null;

  ws.on('message', async raw => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    // expected messages:
    // {type:"join", room:"5600", name, x,y, skin}
    // {type:"move", x,y, dir, anim}
    // {type:"drop_item", room, drop:{id,itemType,x,y,skin}}
    // {type:"pickup_item", room, dropId}
    // {type:"chat", text}
    const type = msg.type;

    if (type === 'join') {
      const rk = roomKeyFrom(msg.room ?? msg.roomKey);
      currentRoomKey = rk;

      const room = getRoom(rk);

      // Load drops from DB once per room (only when room is empty drops map)
      if (pool && room.drops.size === 0) {
        try {
          const dbDrops = await dbLoadRoomDrops(rk);
          for (const d of dbDrops) room.drops.set(d.id, d);
        } catch (e) {
          console.log('dbLoadRoomDrops error', e?.message || e);
        }
      }

      room.players.set(clientId, {
        id: clientId,
        ws,
        name: msg.name || 'Player',
        x: msg.x ?? 0,
        y: msg.y ?? 0,
        skin: msg.skin || null
      });

      // send initial state to this client
      send(ws, {
        type: 'state',
        you: clientId,
        players: Array.from(room.players.values()).map(p => ({
          id: p.id,
          name: p.name,
          x: p.x,
          y: p.y,
          skin: p.skin
        })),
        drops: Array.from(room.drops.values())
      });

      // tell others
      broadcast(rk, {
        type: 'player_join',
        player: {
          id: clientId,
          name: msg.name || 'Player',
          x: msg.x ?? 0,
          y: msg.y ?? 0,
          skin: msg.skin || null
        }
      });

      return;
    }

    if (!currentRoomKey) return;
    const room = getRoom(currentRoomKey);

    if (type === 'move') {
      const p = room.players.get(clientId);
      if (!p) return;
      p.x = msg.x ?? p.x;
      p.y = msg.y ?? p.y;

      broadcast(currentRoomKey, {
        type: 'player_move',
        id: clientId,
        x: p.x,
        y: p.y,
        dir: msg.dir ?? null,
        anim: msg.anim ?? null
      });
      return;
    }

    if (type === 'chat') {
      broadcast(currentRoomKey, {
        type: 'chat',
        id: clientId,
        text: String(msg.text || '').slice(0, 200)
      });
      return;
    }

    if (type === 'drop_item') {
      const rk = roomKeyFrom(msg.room ?? currentRoomKey);
      const drop = msg.drop;
      if (!drop || !drop.id) return;

      const room2 = getRoom(rk);
      room2.drops.set(drop.id, {
        id: String(drop.id),
        itemType: String(drop.itemType || 'unknown'),
        x: Number(drop.x || 0),
        y: Number(drop.y || 0),
        skin: drop.skin || null
      });

      try {
        await dbUpsertDrop(rk, room2.drops.get(drop.id));
      } catch (e) {
        console.log('dbUpsertDrop error', e?.message || e);
      }

      broadcast(rk, { type: 'drop_added', drop: room2.drops.get(drop.id) });
      return;
    }

    if (type === 'pickup_item') {
      const rk = roomKeyFrom(msg.room ?? currentRoomKey);
      const dropId = String(msg.dropId || '');
      if (!dropId) return;

      const room2 = getRoom(rk);
      if (!room2.drops.has(dropId)) return;

      room2.drops.delete(dropId);
      try {
        await dbDeleteDrop(dropId);
      } catch (e) {
        console.log('dbDeleteDrop error', e?.message || e);
      }

      broadcast(rk, { type: 'drop_removed', dropId });
      return;
    }
  });

  ws.on('close', () => {
    if (!currentRoomKey) return;
    const room = getRoom(currentRoomKey);
    room.players.delete(clientId);
    broadcast(currentRoomKey, { type: 'player_leave', id: clientId });
  });
});

// Start
(async () => {
  try {
    await dbInit();
  } catch (e) {
    console.log('dbInit error', e?.message || e);
  }

  server.listen(PORT, () => {
    console.log(`WS server listening on ${PORT}`);
    console.log(`DATABASE_URL set: ${!!DATABASE_URL}`);
  });
})();

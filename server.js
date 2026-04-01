const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3007;

// ── Static file server ──────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
};
const PUBLIC = path.join(__dirname, 'public');

// Route /maze and /tetris to their HTML files
const ROUTES = { '/': '/lobby.html', '/maze': '/maze.html', '/tetris': '/tetris.html' };

const httpServer = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const safePath = path.normalize(ROUTES[urlPath] || urlPath).replace(/^(\.\.[/\\])+/, '');
  const isRoot = safePath === '/' || safePath === '\\' || safePath === '.';
  const filePath = path.join(PUBLIC, isRoot ? 'lobby.html' : safePath);
  if (!filePath.startsWith(PUBLIC)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

// ── Rooms & Players ─────────────────────────────────────────────
// conn: { id, ws, name, mode: 'lobby'|'room', roomId }
const conns = new Map();    // id → conn
const rooms = new Map();    // roomId → room
let nextId = 1;

function genRoomId() {
  const chars = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  let id = '';
  for (let i = 0; i < 5; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return rooms.has(id) ? genRoomId() : id;
}

function send(ws, msg) { if (ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function broadcastLobby() {
  const list = serializeRooms();
  const raw = JSON.stringify({ type: 'room-list', rooms: list });
  for (const [, c] of conns) {
    if (c.mode === 'lobby' && c.ws.readyState === 1) c.ws.send(raw);
  }
}

function broadcastRoom(roomId, msg, excludeId) {
  const room = rooms.get(roomId);
  if (!room) return;
  const raw = JSON.stringify(msg);
  for (const [pid, p] of room.players) {
    if (pid !== excludeId && p.ws.readyState === 1) p.ws.send(raw);
  }
}

function serializeRooms() {
  const list = [];
  for (const [id, r] of rooms) {
    list.push({
      id, name: r.name, type: r.type,
      players: r.players.size, maxPlayers: r.maxPlayers,
      status: r.status, // waiting | playing
    });
  }
  return list;
}

function roomPlayerList(room, excludeId) {
  const list = [];
  for (const [pid, p] of room.players) {
    if (pid !== excludeId) list.push({ id: pid, name: p.name, state: p.gameState });
  }
  return list;
}

function removeFromRoom(conn) {
  if (conn.mode !== 'room' || !conn.roomId) return;
  const room = rooms.get(conn.roomId);
  if (!room) { conn.mode = 'lobby'; conn.roomId = null; return; }
  room.players.delete(conn.id);
  broadcastRoom(conn.roomId, { type: 'player-left', id: conn.id });

  // Clean up race/battle state
  if (room.race) {
    room.race.finished.delete(conn.id);
    if (room.players.size === 0) {
      room.race = null;
      if (room.countdown) { clearInterval(room.countdown); room.countdown = null; }
    } else checkRaceComplete(room);
  }
  if (room.battle) {
    room.battle.eliminated.delete(conn.id);
    if (room.players.size === 0) {
      room.battle = null;
      if (room.countdown) { clearInterval(room.countdown); room.countdown = null; }
    } else checkBattleEnd(room);
  }

  // Remove empty rooms
  if (room.players.size === 0) {
    if (room.countdown) clearInterval(room.countdown);
    rooms.delete(conn.roomId);
  } else {
    room.status = 'waiting';
  }
  conn.mode = 'lobby';
  conn.roomId = null;
  broadcastLobby();
}

// ── Race helpers (Maze) ─────────────────────────────────────────
function checkRaceComplete(room) {
  if (!room.race || !room.race.started) return;
  const active = [...room.players.keys()];
  if (active.every(id => room.race.finished.has(id)) && active.length > 0) {
    const rankings = [...room.race.finished.values()].sort((a, b) => a.rank - b.rank);
    broadcastRoom(room.id, { type: 'race-results', rankings });
    room.race = null;
    room.status = 'waiting';
    broadcastLobby();
  }
}

// ── Battle helpers (Tetris) ─────────────────────────────────────
function checkBattleEnd(room) {
  if (!room.battle || !room.battle.started) return;
  const alive = [];
  for (const [id, p] of room.players) {
    if (!room.battle.eliminated.has(id)) alive.push({ id, name: p.name });
  }
  if (alive.length <= 1) {
    broadcastRoom(room.id, { type: 'battle-end', winner: alive[0] || null });
    room.battle = null;
    room.status = 'waiting';
    broadcastLobby();
  }
}

// ── WebSocket ───────────────────────────────────────────────────
const wss = new WebSocketServer({ server: httpServer });

wss.on('connection', (ws) => {
  const id = String(nextId++);
  const conn = { id, ws, name: '', mode: 'lobby', roomId: null };
  conns.set(id, conn);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Lobby ─────────────────────────────────────────────
      case 'lobby': {
        conn.name = String(msg.name || 'Player').slice(0, 20);
        conn.mode = 'lobby';
        send(ws, { type: 'room-list', rooms: serializeRooms() });
        break;
      }

      case 'create-room': {
        const type = msg.gameType === 'tetris' ? 'tetris' : 'maze';
        const name = String(msg.roomName || conn.name + "'s Room").slice(0, 30);
        const max = Math.min(8, Math.max(2, parseInt(msg.maxPlayers) || 6));
        const roomId = genRoomId();
        const room = {
          id: roomId, type, name, maxPlayers: max,
          players: new Map(), status: 'waiting',
          race: null, battle: null, countdown: null,
        };
        rooms.set(roomId, room);
        // Don't auto-join — the game page will join via its own WS
        send(ws, { type: 'room-created', roomId, roomType: type, roomName: name });
        broadcastLobby();
        break;
      }

      case 'join-room': {
        const room = rooms.get(msg.roomId);
        if (!room) { send(ws, { type: 'error', msg: 'Room not found' }); break; }
        if (room.players.size >= room.maxPlayers) { send(ws, { type: 'error', msg: 'Room full' }); break; }
        // Accept name from game page (new WS connection)
        if (msg.name) conn.name = String(msg.name).slice(0, 20);
        removeFromRoom(conn); // leave any existing room
        conn.mode = 'room';
        conn.roomId = room.id;
        room.players.set(id, { ws, name: conn.name, gameState: null });
        send(ws, {
          type: 'room-joined', roomId: room.id, roomType: room.type,
          roomName: room.name, players: roomPlayerList(room, id),
        });
        broadcastRoom(room.id, { type: 'player-joined', id, name: conn.name }, id);
        broadcastLobby();
        break;
      }

      case 'leave-room': {
        removeFromRoom(conn);
        send(ws, { type: 'room-list', rooms: serializeRooms() });
        break;
      }

      // ── In-Room: Shared ───────────────────────────────────
      case 'state': {
        if (conn.mode !== 'room') return;
        const room = rooms.get(conn.roomId);
        if (!room) return;
        const p = room.players.get(id);
        if (p) p.gameState = msg.data;
        broadcastRoom(conn.roomId, { type: 'player-state', id, data: msg.data }, id);
        break;
      }

      // ── Maze: Race ────────────────────────────────────────
      case 'start-race': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'maze' || room.race) return;
        const mode = msg.mode === 'same' ? 'same' : 'individual';
        const size = Math.min(40, Math.max(10, parseInt(msg.size) || 15));
        const speed = Math.min(100, Math.max(1, parseInt(msg.speed) || 50));
        const seed = Math.floor(Math.random() * 2147483647);
        room.race = { mode, size, speed, seed, started: false, finished: new Map() };
        room.status = 'playing';
        broadcastLobby();
        let count = 3;
        broadcastRoom(room.id, { type: 'race-countdown', count, mode, size });
        room.countdown = setInterval(() => {
          count--;
          if (count > 0) {
            broadcastRoom(room.id, { type: 'race-countdown', count, mode, size });
          } else {
            clearInterval(room.countdown); room.countdown = null;
            room.race.started = true;
            broadcastRoom(room.id, { type: 'race-go', mode, size, speed, seed });
          }
        }, 1000);
        break;
      }
      case 'race-finish': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.race || !room.race.started) return;
        if (room.race.finished.has(id)) return;
        const p = room.players.get(id);
        const rank = room.race.finished.size + 1;
        const entry = { id, name: p?.name || '?', time: msg.time, moves: msg.moves, rank };
        room.race.finished.set(id, entry);
        broadcastRoom(room.id, { type: 'race-player-finish', ...entry });
        checkRaceComplete(room);
        break;
      }

      // ── Tetris: Battle & Garbage ──────────────────────────
      case 'start-battle': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'tetris' || room.battle) return;
        room.battle = { started: false, eliminated: new Set() };
        room.status = 'playing';
        broadcastLobby();
        let count = 3;
        broadcastRoom(room.id, { type: 'battle-countdown', count });
        room.countdown = setInterval(() => {
          count--;
          if (count > 0) {
            broadcastRoom(room.id, { type: 'battle-countdown', count });
          } else {
            clearInterval(room.countdown); room.countdown = null;
            room.battle.started = true;
            broadcastRoom(room.id, { type: 'battle-go' });
          }
        }, 1000);
        break;
      }
      case 'garbage': {
        if (conn.mode !== 'room') return;
        broadcastRoom(conn.roomId, {
          type: 'garbage', from: id,
          lines: Math.min(20, Math.max(0, parseInt(msg.lines) || 0)),
        }, id);
        break;
      }
      case 'game-over': {
        const room = rooms.get(conn.roomId);
        if (!room) return;
        broadcastRoom(room.id, { type: 'player-gameover', id, name: conn.name }, id);
        if (room.battle && room.battle.started) {
          room.battle.eliminated.add(id);
          checkBattleEnd(room);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    removeFromRoom(conn);
    conns.delete(id);
    broadcastLobby();
  });
});

httpServer.listen(PORT, () => {
  console.log(`\n  🎮 Game Arena running at http://localhost:${PORT}\n`);
});

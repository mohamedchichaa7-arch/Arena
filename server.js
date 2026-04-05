const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createHmac } = require('crypto');
const admin = require('firebase-admin');

// ── Firebase Admin SDK ──────────────────────────────────────────
let serviceAccount;
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  serviceAccount = require('./service-account.json');
}

const appCredential = admin.credential.cert(serviceAccount);
admin.initializeApp({
  credential: appCredential,
});
const db = admin.firestore();

// ── Firestore auto-provisioning ─────────────────────────────────
let firestoreReady = false;

async function tryCreateFirestoreDatabase() {
  try {
    const tokenObj = await appCredential.getAccessToken();
    const projectId = serviceAccount.project_id;
    const createUrl = `https://firestore.googleapis.com/v1/projects/${projectId}/databases?databaseId=(default)`;
    const createRes = await fetch(createUrl, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${tokenObj.access_token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'FIRESTORE_NATIVE', locationId: 'eur3' }),
    });
    if (createRes.ok || createRes.status === 409) {
      log('info', 'firestore-created', { status: createRes.status });
      await new Promise(r => setTimeout(r, 4000));
      return true;
    }
    const body = await createRes.text();
    log('error', 'firestore-create-failed', { status: createRes.status, body });
    return false;
  } catch (createErr) {
    log('warn', 'firestore-create-skipped', { err: createErr.message.split('\n')[0] });
    return false;
  }
}

async function ensureFirestoreDatabase() {
  try {
    await db.listCollections();
    firestoreReady = true;
    log('info', 'firestore-ready', {});
    return true;
  } catch (err) {
    const notFound = err.code === 5 || (err.message && (err.message.includes('NOT_FOUND') || err.message.includes('does not exist')));
    if (!notFound) {
      log('warn', 'firestore-warn', { err: err.message.split('\n')[0] });
      // Still mark ready — may succeed on actual requests
      firestoreReady = true;
      return true;
    }
    log('warn', 'firestore-creating', { msg: 'Firestore database not found — attempting auto-create…' });
    const created = await tryCreateFirestoreDatabase();
    if (created) {
      try { await db.listCollections(); firestoreReady = true; return true; } catch {}
    }
    // Auto-create failed (e.g. local SSL proxy). Retry silently in background every 30s.
    log('warn', 'firestore-manual-setup', {
      msg: 'Auto-create failed. Go to https://console.firebase.google.com/project/' +
           serviceAccount.project_id + '/firestore → click "Create database" → choose Native mode → nam5 region. Server will detect it automatically.',
    });
    const retryInterval = setInterval(async () => {
      try {
        await db.listCollections();
        firestoreReady = true;
        clearInterval(retryInterval);
        log('info', 'firestore-ready', { msg: 'Firestore is now ready!' });
      } catch {}
    }, 30_000);
    return false;
  }
}

async function ensureFirestoreIndexes() {
  try {
    const tokenObj = await appCredential.getAccessToken();
    const projectId = serviceAccount.project_id;
    const base = `https://firestore.googleapis.com/v1/projects/${projectId}/databases/(default)/collectionGroups/leaderboard/indexes`;
    const headers = { 'Authorization': `Bearer ${tokenObj.access_token}`, 'Content-Type': 'application/json' };

    const needed = [
      // maze: game ASC + score ASC
      { queryScope: 'COLLECTION', fields: [{ fieldPath: 'game', order: 'ASCENDING' }, { fieldPath: 'score', order: 'ASCENDING' }, { fieldPath: '__name__', order: 'ASCENDING' }] },
      // tetris/tictactoe/bluffrummy: game ASC + score DESC
      { queryScope: 'COLLECTION', fields: [{ fieldPath: 'game', order: 'ASCENDING' }, { fieldPath: 'score', order: 'DESCENDING' }, { fieldPath: '__name__', order: 'DESCENDING' }] },
    ];

    for (const index of needed) {
      const r = await fetch(base, { method: 'POST', headers, body: JSON.stringify(index) });
      if (r.ok) {
        log('info', 'firestore-index-creating', { fields: index.fields.map(f => f.fieldPath + ':' + f.order).join(',') });
      } else if (r.status === 409 || r.status === 403) {
        // 409 = already exists, 403 = service account lacks index-create IAM role (indexes exist or must be created manually) — both are fine
      } else {
        const body = await r.text();
        log('warn', 'firestore-index-warn', { status: r.status, body });
      }
    }
  } catch (err) {
    log('warn', 'firestore-index-skip', { err: err.message.split('\n')[0] });
  }
}


// For maze: lower score (time) is better. For all others: higher is better.
const VALID_GAMES = new Set(['maze', 'tetris', 'tictactoe', 'bluffrummy', 'rami', 'pool']);
const LOWER_IS_BETTER = new Set(['maze']);
const WIN_INCREMENT_GAMES = new Set(['tictactoe', 'bluffrummy', 'rami', 'pool']);

const ROOM_PW_SECRET = process.env.ROOM_PW_SECRET || 'arena-room-secret-default';
function hashRoomPw(pw) { return createHmac('sha256', ROOM_PW_SECRET).update(pw).digest('hex'); }

const PORT = process.env.PORT || 3008;

// ── Logging ─────────────────────────────────────────────────────
const startTime = Date.now();
let totalConnections = 0;

function log(level, event, data = {}) {
  const ts = new Date().toISOString();
  const uptime = Math.floor((Date.now() - startTime) / 1000);
  const parts = [`[${ts}]`, `[${level.toUpperCase()}]`, `[${event}]`];
  const extras = Object.entries(data).map(([k, v]) => `${k}=${v}`).join(' ');
  if (extras) parts.push(extras);
  parts.push(`| uptime=${uptime}s conns=${conns.size} rooms=${rooms.size}`);
  console.log(parts.join(' '));
}

// ── Static file server ──────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
};
const PUBLIC = path.join(__dirname, 'public');

// Route /maze and /tetris to their HTML files
const ROUTES = { '/': '/lobby.html', '/maze': '/maze.html', '/tetris': '/tetris.html', '/tictactoe': '/tictactoe.html', '/bluffrummy': '/bluffrummy.html', '/rami': '/rami.html', '/pool': '/pool.html' };

const httpServer = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];

  // ── API: GET /api/leaderboard?game=X ────────────────────────
  if (req.method === 'GET' && urlPath === '/api/leaderboard') {
    if (!firestoreReady) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Database not ready yet', entries: [] }));
    }
    const params = new URLSearchParams(req.url.split('?')[1] || '');
    const game = params.get('game') || 'maze';
    if (!VALID_GAMES.has(game)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Invalid game' }));
    }
    const order = LOWER_IS_BETTER.has(game) ? 'asc' : 'desc';
    db.collection('leaderboard')
      .where('game', '==', game)
      .orderBy('score', order)
      .limit(20)
      .get()
      .then(snap => {
        const entries = snap.docs.map((doc, i) => ({
          rank: i + 1,
          uid: doc.data().uid,
          displayName: doc.data().displayName,
          score: doc.data().score,
        }));
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(entries));
      })
      .catch(err => {
        log('error', 'leaderboard-fetch', { game, err: err.message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Internal server error' }));
      });
    return;
  }

  // ── API: POST /api/score ─────────────────────────────────────
  if (req.method === 'POST' && urlPath === '/api/score') {
    if (!firestoreReady) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Database not ready yet' }));
    }
    let body = '';
    req.on('data', chunk => { if (body.length < 4096) body += chunk; });
    req.on('end', async () => {
      try {
        const { game, score } = JSON.parse(body);
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Unauthorized' }));
        }
        if (!VALID_GAMES.has(game) || typeof score !== 'number' || !isFinite(score) || score < 0) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'Invalid payload' }));
        }
        const decoded = await admin.auth().verifyIdToken(token);
        const uid = decoded.uid;
        const displayName = decoded.name || decoded.email?.split('@')[0] || 'Player';
        const docRef = db.collection('leaderboard').doc(`${uid}_${game}`);
        if (WIN_INCREMENT_GAMES.has(game)) {
          // Increment wins counter
          await docRef.set({
            uid, displayName, game,
            score: admin.firestore.FieldValue.increment(1),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }, { merge: true });
        } else {
          // Keep personal best only
          const doc = await docRef.get();
          if (!doc.exists) {
            await docRef.set({ uid, displayName, game, score, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
          } else {
            const current = doc.data().score;
            const isBetter = LOWER_IS_BETTER.has(game) ? score < current : score > current;
            if (isBetter) {
              await docRef.update({ score, displayName, updatedAt: admin.firestore.FieldValue.serverTimestamp() });
            }
          }
        }
        log('info', 'score-saved', { uid, game, score });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        const status = err.code === 'auth/argument-error' || err.code === 'auth/id-token-expired' ? 401 : 500;
        log('warn', 'score-error', { err: err.message });
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── API: GET /api/skins ────────────────────────────────────────────────────
  if (req.method === 'GET' && urlPath === '/api/skins') {
    if (!firestoreReady) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ equippedSkin: 'sprites', bestScore: 0, unlockedSkins: ['sprites', 'classic', 'pixel'] }));
    }
    const authHeader = req.headers['authorization'] || '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
    if (!token) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Unauthorized' }));
    }
    (async () => {
      try {
        const SKIN_UNLOCK_SCORES = {
          sprites: 0, classic: 0, pixel: 500, neon: 2000, candy: 3500, glass: 6000,
          pastel: 8000, metal: 12000, retro: 18000, wireframe: 25000, galaxy: 38000,
          diamond: 55000, fire: 80000, hologram: 110000, lava: 140000, ice: 175000, matrix: 250000,
        };
        const decoded = await admin.auth().verifyIdToken(token);
        const uid = decoded.uid;
        const [scoreDoc, prefsDoc] = await Promise.all([
          db.collection('leaderboard').doc(`${uid}_tetris`).get(),
          db.collection('user_prefs').doc(uid).get(),
        ]);
        const bestScore = scoreDoc.exists ? (scoreDoc.data().score || 0) : 0;
        const isTester  = !!(prefsDoc.exists && prefsDoc.data().tester);
        const equippedSkin = (prefsDoc.exists && prefsDoc.data().equippedSkin) || 'sprites';
        const unlockedSkins = isTester
          ? Object.keys(SKIN_UNLOCK_SCORES)
          : Object.entries(SKIN_UNLOCK_SCORES).filter(([, s]) => bestScore >= s).map(([id]) => id);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ equippedSkin, bestScore, unlockedSkins, isTester }));
      } catch (err) {
        log('warn', 'skins-get-error', { err: err.message });
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Invalid token' }));
      }
    })();
    return;
  }

  // ── API: POST /api/skins/equip ─────────────────────────────────────────────
  if (req.method === 'POST' && urlPath === '/api/skins/equip') {
    if (!firestoreReady) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'Database not ready yet' }));
    }
    let body = '';
    req.on('data', chunk => { if (body.length < 1024) body += chunk; });
    req.on('end', async () => {
      try {
        const SKIN_UNLOCK_SCORES = {
          sprites: 0, classic: 0, pixel: 500, neon: 2000, candy: 3500, glass: 6000,
          pastel: 8000, metal: 12000, retro: 18000, wireframe: 25000, galaxy: 38000,
          diamond: 55000, fire: 80000, hologram: 110000, lava: 140000, ice: 175000, matrix: 250000,
        };
        const { skin } = JSON.parse(body);
        const authHeader = req.headers['authorization'] || '';
        const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
        if (!token) { res.writeHead(401, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Unauthorized' })); }
        if (!Object.prototype.hasOwnProperty.call(SKIN_UNLOCK_SCORES, skin)) {
          res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Invalid skin' }));
        }
        const decoded = await admin.auth().verifyIdToken(token);
        const uid = decoded.uid;
        const [scoreDoc, prefsDoc] = await Promise.all([
          db.collection('leaderboard').doc(`${uid}_tetris`).get(),
          db.collection('user_prefs').doc(uid).get(),
        ]);
        const isTester  = !!(prefsDoc.exists && prefsDoc.data().tester);
        const bestScore = scoreDoc.exists ? (scoreDoc.data().score || 0) : 0;
        if (!isTester && bestScore < SKIN_UNLOCK_SCORES[skin]) {
          res.writeHead(403, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Skin not unlocked' }));
        }
        await db.collection('user_prefs').doc(uid).set({ equippedSkin: skin }, { merge: true });
        log('info', 'skin-equipped', { uid, skin, tester: isTester });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        log('warn', 'skins-equip-error', { err: err.message });
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: err.message }));
      }
    });
    return;
  }

  // ── Static files ─────────────────────────────────────────────
  const safePath = path.normalize(ROUTES[urlPath] || urlPath).replace(/^(\.\.[/\\])+/, '');
  const isRoot = safePath === '/' || safePath === '\\' || safePath === '.';
  const filePath = path.join(PUBLIC, isRoot ? 'lobby.html' : safePath);
  // Block any attempt to reach files outside the public directory
  if (!filePath.startsWith(PUBLIC)) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    log('warn', 'path-traversal', { ip, url: req.url });
    res.writeHead(403); return res.end('Forbidden');
  }
  // Explicitly block sensitive file types even if somehow inside public
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.json' && !filePath.endsWith('manifest.json')) {
    res.writeHead(403); return res.end('Forbidden');
  }
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
  const seen = new Set();
  const onlineUsers = [];
  for (const [, c] of conns) { if (c.name && !seen.has(c.name)) { seen.add(c.name); onlineUsers.push(c.name); } }
  const raw = JSON.stringify({ type: 'room-list', rooms: list, onlineUsers });
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
      status: r.status, locked: !!r.passwordHash,
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
  if (room.br && room.br.active) {
    const brHand = room.br.hands.get(conn.id);
    room.br.turnOrder = room.br.turnOrder.filter(pid => pid !== conn.id);
    room.br.hands.delete(conn.id);
    if (room.br.turnIdx >= room.br.turnOrder.length) room.br.turnIdx = 0;
    if (room.players.size === 0) {
      room.br = null;
    } else if (room.br.turnOrder.length < 1) {
      endBluffRummy(room);
    } else {
      // Store hand for reconnect window and pause the game
      if (!room.br.disconnects) room.br.disconnects = new Map();
      if (brHand) room.br.disconnects.set(conn.name, { hand: [...brHand], at: Date.now() });
      room.br.paused = true;
      const disconnectedName = conn.name;
      const roomId = room.id;
      broadcastRoom(roomId, {
        type: 'br-player-disconnect', name: disconnectedName,
        voteTimeoutMs: 15000, playerCount: room.players.size,
      });
      room.br.pauseVotes = { redistribute: 0, wait: 0, voters: new Set() };
      if (room.br.voteTimer) clearTimeout(room.br.voteTimer);
      room.br.voteTimer = setTimeout(() => {
        const r = rooms.get(roomId);
        if (r?.br?.paused) applyBrVoteResult(r, 'redistribute');
      }, 15000);
      broadcastBrPlayerUpdate(room);
    }
  }
  if (room.rami && room.rami.active) {
    // Remove from human turn order only; AI stays
    room.rami.turnOrder = room.rami.turnOrder.filter(pid => pid !== conn.id);
    room.rami.hands.delete(conn.id);
    if (room.rami.turnIdx >= room.rami.turnOrder.length) room.rami.turnIdx = 0;
    if (room.rami.turnOrder.length === 0 || room.players.size === 0) {
      room.rami.active = false;
    }
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

wss.on('connection', (ws, req) => {
  const id = String(nextId++);
  const ip = (req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown').replace('::ffff:', '');
  const userAgent = (req.headers['user-agent'] || 'unknown').slice(0, 80);
  totalConnections++;
  const conn = { id, ws, name: '', mode: 'lobby', roomId: null, ip, connectedAt: Date.now() };
  conns.set(id, conn);
  log('info', 'connect', { id, ip, ua: `"${userAgent}"`, total: totalConnections });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      // ── Lobby ─────────────────────────────────────────────
      case 'lobby': {
        conn.name = String(msg.name || 'Player').slice(0, 20);
        conn.mode = 'lobby';
        const seenNow = new Set();
        const onlineUsersNow = [];
        for (const [, c] of conns) { if (c.name && !seenNow.has(c.name)) { seenNow.add(c.name); onlineUsersNow.push(c.name); } }
        send(ws, { type: 'room-list', rooms: serializeRooms(), onlineUsers: onlineUsersNow });
        log('info', 'lobby-join', { id, name: conn.name, ip: conn.ip });
        break;
      }

      case 'create-room': {
        const type = msg.gameType === 'tetris' ? 'tetris' : msg.gameType === 'tictactoe' ? 'tictactoe' : msg.gameType === 'bluffrummy' ? 'bluffrummy' : msg.gameType === 'rami' ? 'rami' : 'maze';
        const name = String(msg.roomName || conn.name + "'s Room").slice(0, 30);
        const max = type === 'tictactoe' ? 2 : type === 'bluffrummy' ? Math.min(4, Math.max(2, parseInt(msg.maxPlayers) || 4)) : type === 'rami' ? Math.min(4, Math.max(1, parseInt(msg.maxPlayers) || 4)) : Math.min(8, Math.max(2, parseInt(msg.maxPlayers) || 6));
        const rawPw = msg.password ? String(msg.password).trim().slice(0, 30) : null;
        const passwordHash = rawPw ? hashRoomPw(rawPw) : null;
        const roomId = genRoomId();
        const room = {
          id: roomId, type, name, maxPlayers: max,
          players: new Map(), status: 'waiting',
          race: null, battle: null, countdown: null,
          passwordHash,
        };
        rooms.set(roomId, room);
        // Don't auto-join — the game page will join via its own WS
        send(ws, { type: 'room-created', roomId, roomType: type, roomName: name });
        broadcastLobby();
        log('info', 'room-created', { id, name: conn.name, ip: conn.ip, roomId, type, maxPlayers: max, roomName: name, locked: !!passwordHash });
        break;
      }

      case 'join-room': {
        const room = rooms.get(msg.roomId);
        if (!room) { send(ws, { type: 'error', msg: 'Room not found' }); break; }
        if (room.players.size >= room.maxPlayers) { send(ws, { type: 'error', msg: 'Room full' }); break; }
        if (room.passwordHash) {
          const supplied = msg.password ? String(msg.password).trim().slice(0, 30) : '';
          if (!supplied || hashRoomPw(supplied) !== room.passwordHash) {
            send(ws, { type: 'error', msg: 'Wrong password' }); break;
          }
        }
        // Accept name from game page (new WS connection)
        if (msg.name) conn.name = String(msg.name).slice(0, 20);

        // Remove any duplicate in this room with the same name (page-refresh cleanup)
        for (const [existingId, existingP] of room.players) {
          if (existingP.name === conn.name && existingId !== id) {
            const oldConn = conns.get(existingId);
            if (oldConn) { oldConn.mode = 'lobby'; oldConn.roomId = null; }
            room.players.delete(existingId);
            if (room.br?.active) {
              room.br.turnOrder = room.br.turnOrder.filter(p => p !== existingId);
              if (room.br.turnIdx >= room.br.turnOrder.length) room.br.turnIdx = 0;
            }
            break;
          }
        }

        // Check for BluffRummy reconnect (disconnected player rejoining)
        let isBrReconnect = false;
        if (room.br?.active && room.br.disconnects?.has(conn.name)) isBrReconnect = true;

        // Lock game-in-progress rooms to new players (allow BR reconnects)
        if (room.status === 'playing' && room.type === 'bluffrummy' && !isBrReconnect) {
          send(ws, { type: 'error', msg: 'Game in progress — this room is locked' }); break;
        }

        removeFromRoom(conn); // leave any existing room
        conn.mode = 'room';
        conn.roomId = room.id;
        room.players.set(id, { ws, name: conn.name, gameState: null });
        send(ws, {
          type: 'room-joined', roomId: room.id, roomType: room.type,
          roomName: room.name, myId: id, players: roomPlayerList(room, id),
        });
        broadcastRoom(room.id, { type: 'player-joined', id, name: conn.name }, id);

        // Restore BR hand on reconnect
        if (isBrReconnect) {
          const disc = room.br.disconnects.get(conn.name);
          room.br.disconnects.delete(conn.name);
          room.br.hands.set(id, disc.hand);
          if (!room.br.turnOrder.includes(id)) {
            const insertAt = Math.min(room.br.turnIdx, room.br.turnOrder.length);
            room.br.turnOrder.splice(insertAt, 0, id);
          }
          if (room.br.voteTimer) { clearTimeout(room.br.voteTimer); room.br.voteTimer = null; }
          room.br.paused = false;
          room.br.pauseVotes = null;
          broadcastRoom(room.id, { type: 'br-reconnected', name: conn.name }, id);
          send(ws, { type: 'br-hand-update', hand: disc.hand });
          sendBrFullState(room);
          sendBrTurn(room);
        }

        broadcastLobby();
        log('info', 'room-joined', { id, name: conn.name, ip: conn.ip, roomId: room.id, roomType: room.type, players: room.players.size, reconnect: isBrReconnect });
        break;
      }

      case 'leave-room': {
        const leftRoomId = conn.roomId;
        removeFromRoom(conn);
        send(ws, { type: 'room-list', rooms: serializeRooms() });
        log('info', 'room-left', { id, name: conn.name, ip: conn.ip, roomId: leftRoomId });
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
        const algo = String(msg.algo || 'kruskal').slice(0, 30);
        const seed = Math.floor(Math.random() * 2147483647);
        room.race = { mode, size, speed, seed, algo, started: false, finished: new Map(), startedAt: Date.now() };
        room.status = 'playing';
        broadcastLobby();
        log('info', 'race-start', { startedBy: conn.name, ip: conn.ip, roomId: room.id, roomName: room.name, mode, size, speed, algo, players: room.players.size });
        let count = 3;
        broadcastRoom(room.id, { type: 'race-countdown', count, mode, size, algo });
        room.countdown = setInterval(() => {
          count--;
          if (count > 0) {
            broadcastRoom(room.id, { type: 'race-countdown', count, mode, size, algo });
          } else {
            clearInterval(room.countdown); room.countdown = null;
            room.race.started = true;
            broadcastRoom(room.id, { type: 'race-go', mode, size, speed, seed, algo });
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
        log('info', 'race-finish', { id, name: entry.name, ip: conn.ip, roomId: room.id, rank, time: msg.time, moves: msg.moves });
        checkRaceComplete(room);
        break;
      }

      // ── Tetris: Battle & Garbage ──────────────────────────
      case 'start-battle': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'tetris' || room.battle) return;
        room.battle = { started: false, eliminated: new Set(), startedAt: Date.now() };
        room.status = 'playing';
        broadcastLobby();
        log('info', 'battle-start', { startedBy: conn.name, ip: conn.ip, roomId: room.id, roomName: room.name, players: room.players.size });
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
      case 'chat': {
        if (conn.mode !== 'room') return;
        const text = String(msg.text || '').trim().slice(0, 200);
        if (!text) return;
        broadcastRoom(conn.roomId, { type: 'chat', id, name: conn.name, text, ts: Date.now() }, id);
        log('info', 'chat', { id, name: conn.name, roomId: conn.roomId });
        break;
      }

      // ── Tic Tac Toe ───────────────────────────────────────
      case 'ttt-new': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'tictactoe') return;
        if (room.players.size < 2) { send(ws, { type: 'error', msg: 'Need 2 players' }); return; }
        const playerIds = [...room.players.keys()];
        // Alternate who goes first
        if (room.tttRound == null) room.tttRound = 0;
        room.tttRound++;
        const xIdx = room.tttRound % 2 === 1 ? 0 : 1;
        const xId = playerIds[xIdx], oId = playerIds[1 - xIdx];
        room.ttt = {
          board: Array(9).fill(null),
          xHistory: [], oHistory: [],
          currentTurn: 'X',
          xPlayer: xId, oPlayer: oId,
          active: true
        };
        room.status = 'playing';
        broadcastLobby();
        // Send each player their perspective (self = 'self')
        for (const [pid, p] of room.players) {
          send(p.ws, {
            type: 'ttt-start',
            xPlayer: pid === xId ? 'self' : xId,
            oPlayer: pid === oId ? 'self' : oId,
          });
        }
        log('info', 'ttt-new', { roomId: room.id, xPlayer: room.players.get(xId)?.name, oPlayer: room.players.get(oId)?.name });
        break;
      }
      case 'ttt-move': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.ttt || !room.ttt.active) return;
        const ttt = room.ttt;
        const symbol = id === ttt.xPlayer ? 'X' : id === ttt.oPlayer ? 'O' : null;
        if (!symbol || symbol !== ttt.currentTurn) return;
        const cell = parseInt(msg.cell);
        if (cell < 0 || cell > 8 || ttt.board[cell] !== null) return;
        const history = symbol === 'X' ? ttt.xHistory : ttt.oHistory;
        // Remove oldest piece if at max
        if (history.length >= 3) {
          const oldIdx = history.shift();
          ttt.board[oldIdx] = null;
        }
        ttt.board[cell] = symbol;
        history.push(cell);
        ttt.currentTurn = symbol === 'X' ? 'O' : 'X';
        broadcastRoom(room.id, { type: 'ttt-move', cell, symbol });
        // Check win
        const WIN = [[0,1,2],[3,4,5],[6,7,8],[0,3,6],[1,4,7],[2,5,8],[0,4,8],[2,4,6]];
        for (const combo of WIN) {
          if (combo.every(i => ttt.board[i] === symbol)) {
            ttt.active = false;
            room.status = 'waiting';
            broadcastRoom(room.id, { type: 'ttt-win', winner: symbol, combo });
            broadcastLobby();
            log('info', 'ttt-win', { roomId: room.id, winner: symbol });
            return;
          }
        }
        break;
      }

      // ── Bluff Rummy ─────────────────────────────────────────
      case 'br-start': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'bluffrummy') return;
        if (room.br?.active) { send(ws, { type: 'error', msg: 'A game is already in progress' }); return; }
        if (room.players.size < 2) { send(ws, { type: 'error', msg: 'Need 2-4 players' }); return; }
        startBluffRummy(room);
        break;
      }
      case 'br-play': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.br || !room.br.active) return;
        const br = room.br;
        if (br.paused) return; // game paused
        if (br.turnOrder[br.turnIdx] !== id) return; // not your turn
        const sentCards = msg.cards;
        const annNum = parseInt(msg.announceNum);
        if (!Array.isArray(sentCards) || sentCards.length < 1 || sentCards.length > 3) return;
        if (annNum < 1 || annNum > 13) return;
        // If meld exists, announced number must match
        if (br.meldNum !== null && annNum !== br.meldNum) return;
        const playerHand = br.hands.get(id);
        if (!playerHand) return;
        // Find each sent card in the server hand by identity (num+suit)
        const playedCards = [];
        const workingHand = [...playerHand];
        for (const c of sentCards) {
          const num = parseInt(c.num), suit = String(c.suit);
          const idx = workingHand.findIndex(h => h.num === num && h.suit === suit);
          if (idx === -1) return; // card not in hand — reject
          playedCards.push(workingHand[idx]);
          workingHand.splice(idx, 1);
        }
        // Remove played cards from the actual hand
        for (const c of playedCards) {
          const idx = playerHand.findIndex(h => h.num === c.num && h.suit === c.suit);
          if (idx !== -1) playerHand.splice(idx, 1);
        }
        // Add to meld
        br.meldCards.push(...playedCards.map(c => ({ ...c, playedBy: id })));
        if (br.meldNum === null) br.meldNum = annNum;
        br.lastPlayerId = id;
        br.lastPlayerCards = playedCards;
        br.lastAnnouncedNum = annNum;
        // Broadcast play
        broadcastRoom(room.id, {
          type: 'br-play', playerId: id, count: playedCards.length,
          announcedNum: annNum, meldSize: br.meldCards.length, meldNum: br.meldNum,
          cardCount: playerHand.length,
        });
        // Send updated hand to the player
        send(ws, { type: 'br-hand-update', hand: playerHand });
        // Check if this player is now out of cards
        if (playerHand.length === 0) {
          br.finishOrder.push(id);
          const rank = br.finishOrder.length;
          broadcastRoom(room.id, { type: 'br-eliminate', playerId: id, rank });
          log('info', 'br-eliminate', { roomId: room.id, playerId: id, name: conn.name, rank });
          // Remove from turn order
          br.turnOrder = br.turnOrder.filter(pid => pid !== id);
          if (br.turnOrder.length <= 1) { endBluffRummy(room); return; }
          // Fix turn index
          br.turnIdx = br.turnIdx % br.turnOrder.length;
        } else {
          advanceBrTurn(room);
        }
        sendBrTurn(room);
        break;
      }
      case 'br-challenge': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.br || !room.br.active) return;
        const br = room.br;
        if (!br.lastPlayerId || br.lastPlayerId === id) return; // no play to challenge, or own play
        if (!br.hands.has(id)) return; // must be active player
        const challengerName = conn.name;
        const targetConn = conns.get(br.lastPlayerId);
        const targetName = targetConn ? targetConn.name : 'Player';
        broadcastRoom(room.id, { type: 'br-challenge', challengerName, targetName });
        // Reveal only the last-played cards (the ones being challenged) — never expose full meld to prevent sniffing
        const revealCards = br.lastPlayerCards.map(c => ({ num: c.num, suit: c.suit }));
        const totalMeldCards = br.meldCards.length; // full meld goes to taker
        const wasBluff = br.lastPlayerCards.some(c => c.num !== br.lastAnnouncedNum);
        let takerId;
        if (wasBluff) {
          takerId = br.lastPlayerId; // bluffer takes cards
        } else {
          takerId = id; // challenger takes cards
        }
        const takerConn = conns.get(takerId);
        const takerHand = br.hands.get(takerId);
        if (takerHand) {
          for (const c of br.meldCards) takerHand.push({ num: c.num, suit: c.suit });
          // Auto-discard any 4-of-a-kind gained from taking the meld
          autoDiscardFours(room, takerId, br);
        }
        broadcastRoom(room.id, {
          type: 'br-reveal', cards: revealCards, totalCards: totalMeldCards,
          announcedNum: br.lastAnnouncedNum,
          wasBluff, challengerName, targetName,
          takerName: takerConn ? takerConn.name : 'Player',
          takerId,
        });
        // Send updated hand to the taker (after any auto-discards)
        if (takerHand) send(conns.get(takerId)?.ws, { type: 'br-hand-update', hand: br.hands.get(takerId) });
        log('info', 'br-challenge', { roomId: room.id, challenger: challengerName, target: targetName, wasBluff, cardsRevealed: totalMeldCards });
        // Save before clearing
        const prevLastPlayerId = br.lastPlayerId;
        // Reset meld
        br.meldCards = [];
        br.meldNum = null;
        br.lastPlayerId = null;
        br.lastPlayerCards = null;
        br.lastAnnouncedNum = null;
        // Winner of challenge starts new meld: if bluff, challenger was right → challenger starts. If honest, target was right → target starts.
        const newStarterId = wasBluff ? id : prevLastPlayerId;
        // Find them in turnOrder
        // If the starter got eliminated, advance
        let starterIdx = br.turnOrder.indexOf(newStarterId !== undefined ? newStarterId : id);
        if (starterIdx === -1) starterIdx = br.turnIdx % br.turnOrder.length;
        br.turnIdx = starterIdx;
        // Broadcast new meld
        const starterConn = conns.get(br.turnOrder[br.turnIdx]);
        broadcastRoom(room.id, { type: 'br-new-meld', starterName: starterConn?.name || 'Player' });
        // Check if anyone got eliminated in the process or game ended
        brCheckEliminations(room);
        if (br.turnOrder.length <= 1) { endBluffRummy(room); return; }
        sendBrTurn(room);
        // Broadcast player updates
        broadcastBrPlayerUpdate(room);
        break;
      }

      case 'br-vote': {
        const room = rooms.get(conn.roomId);
        if (!room?.br?.pauseVotes) break;
        const votes = room.br.pauseVotes;
        if (votes.voters.has(id)) break; // already voted
        votes.voters.add(id);
        const choice = msg.choice === 'wait' ? 'wait' : 'redistribute';
        votes[choice]++;
        const total = room.players.size;
        broadcastRoom(room.id, { type: 'br-vote-update', redistribute: votes.redistribute, wait: votes.wait, total });
        if (votes.voters.size >= total) applyBrVoteResult(room, votes.redistribute >= votes.wait ? 'redistribute' : 'wait');
        break;
      }

      // ── Rami Tunisien ──────────────────────────────────────
      case 'rami-start': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'rami') break;
        if (room.players.size < 1) { send(ws, {type:'error', msg:'Need at least 1 player'}); break; }
        if (room.rami?.roundActive) break;

        // Build turn order: real players first, then AI to fill up to 4
        const humanIds = [...room.players.keys()];
        const loseThreshold = Math.max(50, Math.min(500, parseInt(msg.loseThreshold) || 200));
        const totalSeats = Math.min(4, Math.max(2, humanIds.length + (parseInt(msg.aiCount) ?? (4 - humanIds.length))));
        const aiNeeded = Math.max(0, totalSeats - humanIds.length);

        const aiIds = new Set();
        const aiNames = new Map();
        const aiHands = new Map();
        const allIds = [...humanIds];
        for (let i = 0; i < aiNeeded; i++) {
          const aiId = `ai-rami-${++ramiAiSeq}`;
          aiIds.add(aiId);
          aiNames.set(aiId, RAMI_AI_NAMES[i % RAMI_AI_NAMES.length] + (aiNeeded > 3 ? ' '+(i+1) : ''));
          aiHands.set(aiId, []);
          allIds.push(aiId);
        }

        const scoreMap = new Map();
        if (room.rami?.scores) {
          for (const [pid, s] of room.rami.scores) scoreMap.set(pid, s);
        }
        for (const pid of allIds) if (!scoreMap.has(pid)) scoreMap.set(pid, 0);

        room.rami = {
          deck: [], discardPile: [], melds: [], meldCounter: 0,
          hands: new Map([...humanIds.map(id => [id,[]]), ...aiHands]),
          hasOpened: new Map(),
          scores: scoreMap,
          roundNum: room.rami?.roundNum || 0,
          loseThreshold,
          turnOrder: allIds,
          turnIdx: 0,
          aiIds, aiNames,
          active: true,
          roundActive: false,
          drawnThisTurn: false,
          turnPendingMelds: [],
          turnOpenPts: 0,
        };
        room.status = 'playing';
        broadcastLobby();
        startRamiRound(room);
        log('info', 'rami-start', {roomId:room.id, players:allIds.length, ai:aiNeeded});
        break;
      }

      case 'rami-draw': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.rami?.roundActive) break;
        const r = room.rami;
        if (r.turnOrder[r.turnIdx] !== id || r.drawnThisTurn) break;
        if (r.deck.length === 0) ramiReshuffleDeck(r);
        if (r.deck.length === 0) break;
        const card = r.deck.pop();
        r.hands.get(id).push(card);
        r.drawnThisTurn = true;
        send(ws, {type:'rami-drew', card, deckCount: r.deck.length, source:'deck'});
        broadcastRoom(room.id, {type:'rami-drew-public', playerId:id, deckCount:r.deck.length}, id);
        sendRamiStateAll(room);
        break;
      }

      case 'rami-pick-discard': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.rami?.roundActive) break;
        const r = room.rami;
        if (r.turnOrder[r.turnIdx] !== id || r.drawnThisTurn) break;
        if (r.discardPile.length === 0) break;
        const card = r.discardPile.pop();
        r.hands.get(id).push(card);
        r.drawnThisTurn = true;
        send(ws, {type:'rami-drew', card, source:'discard'});
        broadcastRoom(room.id, {
          type:'rami-log',
          text: (room.players.get(id)?.name||'?')+' picked up '+ramiCardStr(card)+' from discard.',
          cls:'info',
        }, id);
        sendRamiStateAll(room);
        break;
      }

      case 'rami-meld': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.rami?.roundActive) break;
        const r = room.rami;
        if (r.turnOrder[r.turnIdx] !== id || !r.drawnThisTurn) break;
        const h = r.hands.get(id);
        const cids = Array.isArray(msg.cids) ? msg.cids.map(Number) : [];
        const cards = cids.map(cid => h.find(c => c.cid === cid)).filter(Boolean);
        if (cards.length !== cids.length || cards.length < 3) break;
        const result = validateRamiMeld(cards.map(c => ({...c})));
        if (!result.valid) { send(ws, {type:'rami-error', msg: result.reason}); break; }
        const removeByCids = (cidList) => {
          const removed = [];
          for (const cid of cidList) {
            const idx = h.findIndex(c => c.cid === cid);
            if (idx !== -1) removed.push(h.splice(idx, 1)[0]);
          }
          return removed;
        };
        // Check opening
        if (!r.hasOpened.get(id)) {
          const newTotal = r.turnOpenPts + result.pts;
          const meldCards = removeByCids(cids);
          validateRamiMeld(meldCards); // tag jokers
          const meldId = ++r.meldCounter;
          r.melds.push({id: meldId, cards: meldCards});
          r.turnPendingMelds.push(meldId);
          r.turnOpenPts = newTotal;
          if (newTotal >= 71) {
            r.hasOpened.set(id, true);
            r.turnPendingMelds = [];
            r.turnOpenPts = 0;
            broadcastRoom(room.id, {type:'rami-log', text:(room.players.get(id)?.name||'?')+' opened with '+newTotal+' pts!', cls:'meld'});
          } else {
            broadcastRoom(room.id, {type:'rami-log', text:(room.players.get(id)?.name||'?')+' melded '+result.pts+' pts ('+newTotal+'/71 toward opening).', cls:'meld'});
          }
        } else {
          const meldCards = removeByCids(cids);
          validateRamiMeld(meldCards);
          r.melds.push({id: ++r.meldCounter, cards: meldCards});
          broadcastRoom(room.id, {type:'rami-log', text:(room.players.get(id)?.name||'?')+' melded a '+result.type+'.', cls:'meld'});
        }
        sendRamiStateAll(room);
        if (h.length === 0) { ramiEndRound(room, id); }
        break;
      }

      case 'rami-add-to-meld': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.rami?.roundActive) break;
        const r = room.rami;
        if (r.turnOrder[r.turnIdx] !== id || !r.drawnThisTurn) break;
        if (!r.hasOpened.get(id)) { send(ws, {type:'rami-error', msg:'Open first (need 71+ pts total)!'}); break; }
        const h = r.hands.get(id);
        const cardCid = parseInt(msg.cardCid);
        const meldId = parseInt(msg.meldId);
        const cardIdx = h.findIndex(c => c.cid === cardCid);
        if (isNaN(cardCid) || cardIdx === -1) break;
        const meld = r.melds.find(m => m.id === meldId);
        if (!meld) { send(ws, {type:'rami-error', msg:'Meld not found'}); break; }
        const newCards = ramiAddCardToMeld(meld.cards, h[cardIdx]);
        if (!newCards) { send(ws, {type:'rami-error', msg:'Card doesn\'t fit this meld'}); break; }
        meld.cards = newCards;
        const card = h.splice(cardIdx, 1)[0];
        broadcastRoom(room.id, {type:'rami-log', text:(room.players.get(id)?.name||'?')+' added '+ramiCardStr(card)+' to a meld.', cls:'meld'});
        sendRamiStateAll(room);
        if (h.length === 0) { ramiEndRound(room, id); }
        break;
      }

      case 'rami-swap-joker': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.rami?.roundActive) break;
        const r = room.rami;
        if (r.turnOrder[r.turnIdx] !== id || !r.drawnThisTurn) break;
        if (!r.hasOpened.get(id)) { send(ws, {type:'rami-error', msg:'Open first!'}); break; }
        const h = r.hands.get(id);
        const cardCid = parseInt(msg.cardCid);
        const meldId = parseInt(msg.meldId);
        const cardIdx = h.findIndex(c => c.cid === cardCid);
        if (isNaN(cardCid) || cardIdx === -1) break;
        const meld = r.melds.find(m => m.id === meldId);
        if (!meld) { send(ws, {type:'rami-error', msg:'Meld not found'}); break; }
        const jokerPos = meld.cards.findIndex(c => c.isJoker);
        if (jokerPos === -1) { send(ws, {type:'rami-error', msg:'No Joker in this meld!'}); break; }
        const testCards = [...meld.cards];
        testCards[jokerPos] = h[cardIdx];
        if (!validateRamiMeld(testCards).valid) { send(ws, {type:'rami-error', msg:'Card doesn\'t replace the Joker\'s position here'}); break; }
        const joker = meld.cards[jokerPos];
        joker.substituteNum = undefined; joker.substituteSuit = undefined;
        meld.cards[jokerPos] = h[cardIdx];
        h.splice(cardIdx, 1);
        h.push(joker);
        broadcastRoom(room.id, {type:'rami-log', text:(room.players.get(id)?.name||'?')+' swapped a Joker from a meld!', cls:'meld'});
        sendRamiStateAll(room);
        break;
      }

      case 'rami-discard': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.rami?.roundActive) break;
        const r = room.rami;
        if (r.turnOrder[r.turnIdx] !== id || !r.drawnThisTurn) break;
        const h = r.hands.get(id);
        const cardCid = parseInt(msg.cardCid);
        const cardIdx = h.findIndex(c => c.cid === cardCid);
        if (isNaN(cardCid) || cardIdx === -1) break;

        // If not opened and has pending melds, undo them
        if (!r.hasOpened.get(id) && r.turnPendingMelds.length > 0) {
          for (let i = r.turnPendingMelds.length - 1; i >= 0; i--) {
            const meldId = r.turnPendingMelds[i];
            const idx = r.melds.findIndex(m => m.id === meldId);
            if (idx !== -1) {
              const meldCards = r.melds.splice(idx, 1)[0].cards;
              h.push(...meldCards);
            }
          }
          r.turnPendingMelds = [];
          r.turnOpenPts = 0;
          sendRamiStateAll(room);
          send(ws, {type:'rami-error', msg:'Opening not reached (need 71 pts) — melds returned to your hand.'});
          break;
        }

        const card = h.splice(cardIdx, 1)[0];
        r.discardPile.push(card);
        r.turnPendingMelds = [];
        r.turnOpenPts = 0;
        broadcastRoom(room.id, {type:'rami-log', text:(room.players.get(id)?.name||'?')+' discarded '+ramiCardStr(card)+'.', cls:'info'});
        sendRamiStateAll(room);
        if (h.length === 0) { ramiEndRound(room, id); return; }
        ramiAdvanceTurn(room);
        break;
      }

      case 'rami-next-round': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.rami?.active || room.rami?.roundActive) break;
        startRamiRound(room);
        break;
      }

      case 'game-over': {
        const room = rooms.get(conn.roomId);
        if (!room) break;
        broadcastRoom(room.id, { type: 'player-gameover', id, name: conn.name }, id);
        const elapsedGame = room.battle?.startedAt ? Math.floor((Date.now() - room.battle.startedAt) / 1000) : null;
        log('info', 'game-over', { id, name: conn.name, ip: conn.ip, roomId: room.id, elapsedSec: elapsedGame });
        if (room.battle && room.battle.started) {
          room.battle.eliminated.add(id);
          checkBattleEnd(room);
        }
        break;
      }
    }
  });

  ws.on('close', () => {
    const sessionSec = Math.floor((Date.now() - conn.connectedAt) / 1000);
    log('info', 'disconnect', { id, name: conn.name || '(unnamed)', ip: conn.ip, sessionSec });
    removeFromRoom(conn);
    conns.delete(id);
    broadcastLobby();
  });
});

// ── Bluff Rummy helpers ─────────────────────────────────────────
// Remove all 4-of-a-kind sets from a player's hand in-place; broadcast each removal
function autoDiscardFours(room, pid, br) {
  const hand = br.hands.get(pid);
  if (!hand) return;
  let changed = true;
  while (changed) {
    changed = false;
    const counts = {};
    for (const c of hand) counts[c.num] = (counts[c.num] || 0) + 1;
    for (const [numStr, cnt] of Object.entries(counts)) {
      if (cnt >= 4) {
        const num = parseInt(numStr);
        let removed = 0;
        for (let i = hand.length - 1; i >= 0 && removed < 4; i--) {
          if (hand[i].num === num) { hand.splice(i, 1); removed++; }
        }
        if (!br.discards) br.discards = [];
        br.discards.push({ playerName: room.players.get(pid)?.name || 'Player', num });
        broadcastRoom(room.id, { type: 'br-auto-discard', playerId: pid, num });
        log('info', 'br-auto-discard', { roomId: room.id, playerId: pid, num });
        changed = true;
        break;
      }
    }
  }
}

function startBluffRummy(room) {
  // Build deck: 1-13, 4 suits
  const SUITS = ['♠', '♥', '♦', '♣'];
  const deck = [];
  for (let num = 1; num <= 13; num++) {
    for (const suit of SUITS) deck.push({ num, suit });
  }
  // Shuffle (Fisher-Yates)
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  // Distribute cards
  const playerIds = [...room.players.keys()];
  const hands = new Map();
  for (const pid of playerIds) hands.set(pid, []);
  let idx = 0;
  for (const card of deck) {
    hands.get(playerIds[idx % playerIds.length]).push(card);
    idx++;
  }
  // Auto-discard any set of 4 same-number cards
  const initialDiscards = [];
  for (const pid of playerIds) {
    const counts = {};
    for (const c of hands.get(pid)) counts[c.num] = (counts[c.num] || 0) + 1;
    for (const [numStr, cnt] of Object.entries(counts)) {
      if (cnt === 4) {
        const num = parseInt(numStr);
        hands.set(pid, hands.get(pid).filter(c => c.num !== num));
        initialDiscards.push({ playerName: room.players.get(pid)?.name || 'Player', num });
        broadcastRoom(room.id, { type: 'br-auto-discard', playerId: pid, num });
        log('info', 'br-auto-discard', { roomId: room.id, playerId: pid, num });
      }
    }
  }
  // Random starting player
  const startIdx = Math.floor(Math.random() * playerIds.length);
  // Create turn order (only players with cards)
  const turnOrder = [...playerIds];
  const finishOrder = [];

  room.br = {
    hands,
    turnOrder,
    turnIdx: startIdx,
    meldCards: [],
    meldNum: null,
    lastPlayerId: null,
    lastPlayerCards: null,
    lastAnnouncedNum: null,
    finishOrder,
    discards: initialDiscards,
    active: true,
    paused: false,
    disconnects: new Map(),
    pauseVotes: null,
    voteTimer: null,
  };
  room.status = 'playing';
  broadcastLobby();

  // Send initial hands
  for (const [pid, p] of room.players) {
    send(p.ws, { type: 'br-dealt', hand: hands.get(pid), discards: initialDiscards });
  }

  // Send full state to everyone
  sendBrFullState(room);
  sendBrTurn(room);
  log('info', 'br-start', { roomId: room.id, players: playerIds.length });
}

function sendBrFullState(room) {
  const br = room.br;
  for (const [pid, p] of room.players) {
    const playersList = [];
    for (const [otherId,] of room.players) {
      const hand = br.hands.get(otherId);
      const rank = br.finishOrder.indexOf(otherId);
      playersList.push({
        id: otherId,
        name: room.players.get(otherId)?.name || 'Player',
        cardCount: hand ? hand.length : 0,
        eliminated: rank >= 0,
        rank: rank >= 0 ? rank + 1 : null,
      });
    }
    const currentTurnId = br.turnOrder[br.turnIdx];
    send(p.ws, {
      type: 'br-state',
      yourId: pid,
      hand: br.hands.get(pid) || [],
      active: br.active,
      currentTurn: currentTurnId,
      canChallenge: !!(br.lastPlayerId) && br.lastPlayerId !== pid,
      meldNum: br.meldNum,
      meldSize: br.meldCards.length,
      players: playersList,
      discards: br.discards || [],
      rankings: br.active ? [] : br.finishOrder.map((fid, i) => ({
        id: fid, name: room.players.get(fid)?.name || 'Player', rank: i + 1,
      })),
    });
  }
}

function sendBrTurn(room) {
  const br = room.br;
  if (!br || !br.active || br.turnOrder.length === 0 || br.paused) return;
  const currentTurnId = br.turnOrder[br.turnIdx];
  for (const [pid, p] of room.players) {
    send(p.ws, {
      type: 'br-turn',
      currentTurn: currentTurnId,
      canChallenge: br.lastPlayerId != null && br.lastPlayerId !== pid,
      meldNum: br.meldNum,
    });
  }
}

function advanceBrTurn(room) {
  const br = room.br;
  br.turnIdx = (br.turnIdx + 1) % br.turnOrder.length;
}

function brCheckEliminations(room) {
  const br = room.br;
  // Check for any player with 0 cards still in turnOrder
  for (const pid of [...br.turnOrder]) {
    const hand = br.hands.get(pid);
    if (hand && hand.length === 0 && !br.finishOrder.includes(pid)) {
      br.finishOrder.push(pid);
      const rank = br.finishOrder.length;
      broadcastRoom(room.id, { type: 'br-eliminate', playerId: pid, rank });
      br.turnOrder = br.turnOrder.filter(p => p !== pid);
      if (br.turnIdx >= br.turnOrder.length) br.turnIdx = 0;
    }
  }
}

function broadcastBrPlayerUpdate(room) {
  const br = room.br;
  const playersList = [];
  for (const [pid,] of room.players) {
    const hand = br.hands.get(pid);
    const rank = br.finishOrder.indexOf(pid);
    playersList.push({
      id: pid,
      name: room.players.get(pid)?.name || 'Player',
      cardCount: hand ? hand.length : 0,
      eliminated: rank >= 0,
      rank: rank >= 0 ? rank + 1 : null,
    });
  }
  broadcastRoom(room.id, { type: 'br-player-update', players: playersList });
}

// ── Rami Tunisien helpers ────────────────────────────────────────
const RAMI_SUITS = ['♠','♥','♦','♣'];
const RAMI_AI_NAMES = ['Aziz','Fatma','Youssef'];
let ramiAiSeq = 0;

function ramiCardPts(c) {
  if (c.isJoker) return 0;
  if (c.num === 1 || c.num >= 11) return 10;
  return c.num;
}
function ramiHandPts(h) { return h.reduce((s,c) => s + ramiCardPts(c), 0); }
function ramiRankLabel(n) { return n === 1 ? 'A' : n === 11 ? 'J' : n === 12 ? 'Q' : n === 13 ? 'K' : String(n); }

function validateRamiMeld(cards) {
  if (cards.length < 3) return {valid:false, reason:'Need at least 3 cards'};
  const reals = cards.filter(c => !c.isJoker);
  const jokerCount = cards.length - reals.length;

  // ── SET: 3-4 cards same rank, different suits ──
  if (cards.length <= 4) {
    const rankSet = new Set(reals.map(c => c.num));
    const suits = reals.map(c => c.suit);
    const suitSet = new Set(suits);
    if (rankSet.size <= 1 && suitSet.size === suits.length) {
      const rank = reals.length > 0 ? reals[0].num : 1;
      const ptVal = (rank === 1 || rank >= 11) ? 10 : rank;
      const pts = cards.length * ptVal;
      const usedSuits = new Set(suits);
      const availSuits = RAMI_SUITS.filter(s => !usedSuits.has(s));
      let ji = 0;
      cards.forEach(c => { if (c.isJoker) { c.substituteNum = rank; c.substituteSuit = availSuits[ji++] || '♠'; }});
      return {valid:true, type:'set', pts};
    }
    if (rankSet.size === 1 && suitSet.size < suits.length)
      return {valid:false, reason:'Sets need different suits for each card'};
  }

  // ── RUN: 3+ consecutive same suit ──
  const suitSetAll = new Set(reals.map(c => c.suit));
  if (suitSetAll.size <= 1) {
    const suit = suitSetAll.size === 1 ? [...suitSetAll][0] : '♠';
    const tryStart = (start) => {
      const needed = [];
      for (let i = 0; i < cards.length; i++) needed.push(start + i);
      if (needed[needed.length-1] > 14) return null;
      const usedReal = new Set();
      let jUsed = 0;
      for (const n of needed) {
        let found = false;
        for (let ri = 0; ri < reals.length; ri++) {
          if (usedReal.has(ri)) continue;
          if (reals[ri].num === n || (reals[ri].num === 1 && n === 14)) { usedReal.add(ri); found = true; break; }
        }
        if (!found) jUsed++;
      }
      if (jUsed !== jokerCount) return null;
      let pts = 0;
      const jokers = cards.filter(c => c.isJoker);
      let ji = 0;
      const usedReal2 = new Set();
      for (const n of needed) {
        const actualNum = n > 13 ? 1 : n;
        let found = false;
        for (let ri = 0; ri < reals.length; ri++) {
          if (usedReal2.has(ri)) continue;
          if (reals[ri].num === n || (reals[ri].num === 1 && n === 14)) {
            usedReal2.add(ri); pts += ramiCardPts(reals[ri]); found = true; break;
          }
        }
        if (!found && ji < jokers.length) {
          jokers[ji].substituteNum = actualNum;
          jokers[ji].substituteSuit = suit;
          pts += (actualNum === 1 || actualNum >= 11) ? 10 : actualNum;
          ji++;
        }
      }
      return pts;
    };
    for (let s = 1; s <= 14; s++) {
      const pts = tryStart(s);
      if (pts !== null) return {valid:true, type:'run', pts};
    }
    return {valid:false, reason:'Cards are not consecutive (for a run they must follow in order, same suit)'};
  }

  // Mixed ranks and suits
  const rankSet2 = new Set(reals.map(c => c.num));
  if (rankSet2.size === 1) return {valid:false, reason:'Cards must have different suits in a set'};
  return {valid:false, reason:'Cards must be same rank (set) or consecutive same suit (run)'};
}

function ramiAddCardToMeld(meld, card) {
  const test1 = [...meld, card];
  if (validateRamiMeld(test1).valid) return test1;
  const test2 = [card, ...meld];
  if (validateRamiMeld(test2).valid) return test2;
  return null;
}

function buildRamiDeck() {
  let cid = 0;
  const d = [];
  for (let copy = 0; copy < 2; copy++) {
    for (let num = 1; num <= 13; num++) {
      for (const suit of RAMI_SUITS) d.push({num, suit, isJoker:false, cid:++cid});
    }
  }
  d.push({num:0, suit:'🃏', isJoker:true, jokerColor:'black', cid:++cid});
  d.push({num:0, suit:'🃏', isJoker:true, jokerColor:'red',   cid:++cid});
  return d;
}

function ramiShuffle(arr) {
  for (let i = arr.length-1; i > 0; i--) {
    const j = Math.floor(Math.random()*(i+1)); [arr[i],arr[j]] = [arr[j],arr[i]];
  }
}

function startRamiRound(room) {
  const r = room.rami;
  r.roundNum++;
  const deck = buildRamiDeck();
  ramiShuffle(deck);
  r.deck = deck;
  r.discardPile = [];
  r.melds = [];
  r.meldCounter = 0;
  r.turnPendingMelds = [];
  r.turnOpenPts = 0;

  r.hasOpened = new Map();
  for (const pid of r.turnOrder) { r.hasOpened.set(pid, false); r.hands.set(pid, []); }

  // Deal 14 cards each
  for (let i = 0; i < 14; i++) {
    for (const pid of r.turnOrder) r.hands.get(pid).push(r.deck.pop());
  }
  // Flip initial discard
  r.discardPile.push(r.deck.pop());
  r.roundActive = true;
  r.turnIdx = 0;
  r.drawnThisTurn = false;

  sendRamiStateAll(room);
  sendRamiTurn(room);
  broadcastRoom(room.id, {type:'rami-log', text:'Round '+r.roundNum+' begins!', cls:'info'});
}

function sendRamiStateAll(room) {
  const r = room.rami;
  // Send each player their private state (own hand)
  for (const [pid, p] of room.players) {
    const myHand = r.hands.get(pid) || [];
    send(p.ws, {
      type: 'rami-state',
      hand: myHand,
      melds: r.melds,
      discardTop: r.discardPile.length > 0 ? r.discardPile[r.discardPile.length-1] : null,
      discardCount: r.discardPile.length,
      deckCount: r.deck.length,
      roundNum: r.roundNum,
      loseThreshold: r.loseThreshold,
      players: r.turnOrder.map(id => ({
        id,
        name: r.aiNames.has(id) ? r.aiNames.get(id) : room.players.get(id)?.name || 'Player',
        isAI: r.aiIds.has(id),
        cardCount: r.hands.get(id)?.length ?? 0,
        score: r.scores.get(id) || 0,
        hasOpened: r.hasOpened.get(id) || false,
      })),
      turnId: r.turnOrder[r.turnIdx],
      hasOpened: r.hasOpened.get(pid) || false,
      turnOpenPts: r.turnOrder[r.turnIdx] === pid ? r.turnOpenPts : 0,
      myId: pid,
      active: r.roundActive,
      drawnThisTurn: r.turnOrder[r.turnIdx] === pid ? r.drawnThisTurn : false,
    });
  }
}

function sendRamiTurn(room) {
  const r = room.rami;
  const currentId = r.turnOrder[r.turnIdx];
  broadcastRoom(room.id, {
    type: 'rami-turn',
    turnId: currentId,
    isAI: r.aiIds.has(currentId),
    playerName: r.aiNames.has(currentId) ? r.aiNames.get(currentId) : room.players.get(currentId)?.name || 'Player',
  });
}

function ramiReshuffleDeck(r) {
  if (r.discardPile.length <= 1) return;
  const top = r.discardPile.pop();
  r.deck = [...r.discardPile];
  r.discardPile = [top];
  ramiShuffle(r.deck);
}

function ramiAdvanceTurn(room) {
  const r = room.rami;
  r.turnIdx = (r.turnIdx + 1) % r.turnOrder.length;
  r.drawnThisTurn = false;
  r.turnPendingMelds = [];
  r.turnOpenPts = 0;
  sendRamiTurn(room);
  sendRamiStateAll(room);
  // If next is AI, run after short delay
  const nextId = r.turnOrder[r.turnIdx];
  if (r.aiIds.has(nextId)) {
    setTimeout(() => runRamiAI(room, nextId), 900);
  }
}

function ramiEndRound(room, winnerId) {
  const r = room.rami;
  r.roundActive = false;
  const winnerName = r.aiNames.has(winnerId) ? r.aiNames.get(winnerId) : room.players.get(winnerId)?.name || 'Player';

  const results = r.turnOrder.map(pid => {
    const pts = pid === winnerId ? 0 : ramiHandPts(r.hands.get(pid) || []);
    r.scores.set(pid, (r.scores.get(pid) || 0) + pts);
    return {
      id: pid,
      name: r.aiNames.has(pid) ? r.aiNames.get(pid) : room.players.get(pid)?.name || 'Player',
      penalty: pts,
      total: r.scores.get(pid),
      isWinner: pid === winnerId,
    };
  });

  broadcastRoom(room.id, {type:'rami-round-over', winnerName, results});
  broadcastRoom(room.id, {type:'rami-log', text:winnerName+' wins Round '+r.roundNum+'!', cls:'win'});

  // Report score for human winner
  if (!r.aiIds.has(winnerId) && room.players.has(winnerId)) {
    // Score reported by client via /api/score
  }

  // Check game over
  const maxScore = Math.max(...r.turnOrder.map(pid => r.scores.get(pid) || 0));
  if (maxScore >= r.loseThreshold) {
    endRamiGame(room);
  }
}

function endRamiGame(room) {
  const r = room.rami;
  r.active = false;
  room.status = 'waiting';
  const sorted = [...r.turnOrder]
    .map(pid => ({
      id: pid,
      name: r.aiNames.has(pid) ? r.aiNames.get(pid) : room.players.get(pid)?.name || 'Player',
      score: r.scores.get(pid) || 0,
    }))
    .sort((a,b) => a.score - b.score);
  broadcastRoom(room.id, {type:'rami-game-over', rankings: sorted});
  broadcastLobby();
  log('info', 'rami-gameover', {roomId:room.id, winner:sorted[0]?.name});
}

// ── Rami AI ───────────────────────────────────────────────────
function ramiAiCanUseDiscard(hand, card) {
  for (let i = 0; i < hand.length; i++) {
    for (let j = i+1; j < hand.length; j++) {
      if (validateRamiMeld([hand[i], hand[j], {...card}]).valid) return true;
    }
  }
  return false;
}

function ramiCombinations(n, k) {
  if (k > n) return [];
  const result = [];
  const combo = [];
  function gen(start) {
    if (combo.length === k) { result.push([...combo]); return; }
    if (start >= n) return;
    if (result.length > 8000) return;
    combo.push(start);
    gen(start+1);
    combo.pop();
    gen(start+1);
  }
  gen(0);
  return result;
}

function ramiFindAllMelds(h) {
  const used = new Set();
  const result = [];
  for (let size = Math.min(h.length, 13); size >= 3; size--) {
    const combos = ramiCombinations(h.length, size);
    for (const indices of combos) {
      if (indices.some(i => used.has(i))) continue;
      const cards = indices.map(i => ({...h[i]}));
      const v = validateRamiMeld(cards);
      if (v.valid) { result.push({indices, type:v.type, pts:v.pts}); for (const i of indices) used.add(i); }
    }
  }
  return result;
}

function ramiFindBestMeld(h) {
  let best = null;
  for (let size = Math.min(h.length, 13); size >= 3; size--) {
    const combos = ramiCombinations(h.length, size);
    for (const indices of combos) {
      const cards = indices.map(i => ({...h[i]}));
      const v = validateRamiMeld(cards);
      if (v.valid && (!best || v.pts > best.pts)) best = {indices, type:v.type, pts:v.pts};
    }
    if (best) break;
  }
  return best;
}

function ramiBestDiscard(h) {
  let bestIdx = 0, bestScore = Infinity;
  for (let i = 0; i < h.length; i++) {
    const c = h[i];
    if (c.isJoker) continue;
    let score = 0;
    for (let j = 0; j < h.length; j++) {
      if (j === i) continue;
      if (!h[j].isJoker && h[j].num === c.num) score += 3;
      if (!h[j].isJoker && h[j].suit === c.suit && Math.abs(h[j].num - c.num) <= 2) score += 2;
    }
    score -= ramiCardPts(c) * 0.5;
    if (score < bestScore) { bestScore = score; bestIdx = i; }
  }
  return bestIdx;
}

function runRamiAI(room, aiId) {
  const r = room.rami;
  if (!r || !r.roundActive || r.turnOrder[r.turnIdx] !== aiId) return;
  const h = r.hands.get(aiId);

  // 1. Draw
  let drewDiscard = false;
  if (r.discardPile.length > 0 && ramiAiCanUseDiscard(h, r.discardPile[r.discardPile.length-1])) {
    const card = r.discardPile.pop();
    h.push(card);
    drewDiscard = true;
    broadcastRoom(room.id, {
      type:'rami-log',
      text: r.aiNames.get(aiId)+' picked up '+ramiCardStr(card)+' from discard.',
      cls:'ai',
    });
  } else {
    if (r.deck.length === 0) ramiReshuffleDeck(r);
    if (r.deck.length > 0) h.push(r.deck.pop());
    broadcastRoom(room.id, {type:'rami-log', text:r.aiNames.get(aiId)+' drew from the deck.', cls:'ai'});
  }

  // 2. Meld
  if (!r.hasOpened.get(aiId)) {
    const allMelds = ramiFindAllMelds(h);
    const total = allMelds.reduce((s,m) => s+m.pts, 0);
    if (total >= 71) {
      const allIdx = new Set();
      for (const m of allMelds) for (const i of m.indices) allIdx.add(i);
      const removeSorted = [...allIdx].sort((a,b) => b-a);
      const removedMap = new Map();
      for (const i of removeSorted) removedMap.set(i, h.splice(i,1)[0]);
      for (const m of allMelds) {
        const meldCards = m.indices.map(i => removedMap.get(i));
        validateRamiMeld(meldCards); // tag jokers
        r.melds.push({id: ++r.meldCounter, cards: meldCards});
        broadcastRoom(room.id, {
          type:'rami-log',
          text: r.aiNames.get(aiId)+' melded a '+m.type+' ('+m.pts+' pts).',
          cls:'ai',
        });
      }
      r.hasOpened.set(aiId, true);
      broadcastRoom(room.id, {
        type:'rami-log',
        text: r.aiNames.get(aiId)+' opened with '+total+' points!',
        cls:'ai',
      });
    }
  } else {
    // Keep melding while possible
    let found = true;
    while (found) {
      found = false;
      const best = ramiFindBestMeld(h);
      if (best) {
        const sorted = [...best.indices].sort((a,b) => b-a);
        const meldCards = [];
        for (const i of sorted) meldCards.unshift(h.splice(i,1)[0]);
        validateRamiMeld(meldCards);
        r.melds.push({id: ++r.meldCounter, cards: meldCards});
        broadcastRoom(room.id, {type:'rami-log', text:r.aiNames.get(aiId)+' melded a '+best.type+'.', cls:'ai'});
        found = true;
      }
    }
    // Add to existing melds
    let changed = true;
    while (changed) {
      changed = false;
      for (let ci = h.length-1; ci >= 0; ci--) {
        for (const meld of r.melds) {
          const newCards = ramiAddCardToMeld(meld.cards, h[ci]);
          if (newCards) {
            broadcastRoom(room.id, {type:'rami-log', text:r.aiNames.get(aiId)+' added '+ramiCardStr(h[ci])+' to a meld.', cls:'ai'});
            meld.cards = newCards;
            h.splice(ci,1);
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
    }
  }

  // Win check
  if (h.length === 0) {
    sendRamiStateAll(room);
    ramiEndRound(room, aiId);
    return;
  }

  // 3. Discard
  const discIdx = ramiBestDiscard(h);
  const disc = h.splice(discIdx,1)[0];
  r.discardPile.push(disc);
  broadcastRoom(room.id, {type:'rami-log', text:r.aiNames.get(aiId)+' discarded '+ramiCardStr(disc)+'.', cls:'ai'});

  if (h.length === 0) {
    sendRamiStateAll(room);
    ramiEndRound(room, aiId);
    return;
  }

  sendRamiStateAll(room);
  ramiAdvanceTurn(room);
}

function ramiCardStr(c) {
  if (c.isJoker) return '🃏';
  return ramiRankLabel(c.num) + c.suit;
}

function applyBrVoteResult(room, choice) {
  const br = room.br;
  if (!br) return;
  if (br.voteTimer) { clearTimeout(br.voteTimer); br.voteTimer = null; }
  br.pauseVotes = null;
  if (choice === 'redistribute') {
    const allCards = [];
    for (const [, disc] of (br.disconnects || new Map())) allCards.push(...disc.hand);
    br.disconnects = new Map();
    let ci = 0;
    for (const c of allCards) {
      const pid = br.turnOrder[ci % br.turnOrder.length];
      if (pid) br.hands.get(pid)?.push(c);
      ci++;
    }
    br.paused = false;
    broadcastRoom(room.id, { type: 'br-vote-result', choice: 'redistribute' });
    for (const [pid, p] of room.players) {
      send(p.ws, { type: 'br-hand-update', hand: br.hands.get(pid) || [] });
    }
    broadcastBrPlayerUpdate(room);
    if (br.turnOrder.length <= 1) { endBluffRummy(room); return; }
    sendBrTurn(room);
  } else {
    broadcastRoom(room.id, { type: 'br-vote-result', choice: 'wait', waitMs: 45000 });
    br.voteTimer = setTimeout(() => {
      const r = rooms.get(room.id);
      if (r?.br?.paused) applyBrVoteResult(r, 'redistribute');
    }, 45000);
  }
}

function endBluffRummy(room) {
  const br = room.br;
  // Last player standing is the loser
  for (const pid of br.turnOrder) {
    if (!br.finishOrder.includes(pid)) {
      br.finishOrder.push(pid); // loser
    }
  }
  br.active = false;
  room.status = 'waiting';
  const rankings = br.finishOrder.map((pid, i) => ({
    id: pid,
    name: room.players.get(pid)?.name || 'Player',
    rank: i + 1,
  }));
  broadcastRoom(room.id, { type: 'br-gameover', rankings });
  broadcastLobby();
  log('info', 'br-gameover', { roomId: room.id, winner: rankings[0]?.name });
}

// ── Start ───────────────────────────────────────────────────────
ensureFirestoreDatabase().then(async dbReady => {
  if (!dbReady) {
    log('warn', 'firestore-unavailable', { msg: 'Leaderboard/skins will not work until Firestore is ready' });
  } else {
    await ensureFirestoreIndexes();
  }
  httpServer.listen(PORT, () => {
    console.log(`\n  🎮 Game Arena running at http://localhost:${PORT}\n`);
    log('info', 'server-start', { port: PORT, node: process.version, pid: process.pid });
  });
});

// ── Periodic stats ───────────────────────────────────────────────
setInterval(() => {
  const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
  const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
  log('stats', 'heartbeat', { conns: conns.size, rooms: rooms.size, totalConnections, uptimeSec, memMB });
}, 60_000);

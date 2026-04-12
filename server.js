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
const VALID_GAMES = new Set(['maze', 'tetris', 'tictactoe', 'bluffrummy', 'rami', 'pool', 'battleship', 'egame', 'snakesladders', 'uno', 'tanks', 'bomberman', 'minesweeper']);
const LOWER_IS_BETTER = new Set(['maze']);
const WIN_INCREMENT_GAMES = new Set(['tictactoe', 'bluffrummy', 'rami', 'pool', 'battleship', 'egame', 'snakesladders', 'uno', 'tanks', 'bomberman']);

const ROOM_PW_SECRET = process.env.ROOM_PW_SECRET || 'arena-room-secret-default';
function hashRoomPw(pw) { return createHmac('sha256', ROOM_PW_SECRET).update(pw).digest('hex'); }

const PORT = process.env.PORT || 3009;

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
const ROUTES = { '/': '/lobby.html', '/maze': '/maze.html', '/tetris': '/tetris.html', '/tictactoe': '/tictactoe.html', '/bluffrummy': '/bluffrummy.html', '/rami': '/rami.html', '/pool': '/pool.html', '/battleship': '/battleship.html', '/egame': '/egame.html', '/snakesladders': '/snakesladders.html', '/uno': '/uno.html', '/tanks': '/tanks.html', '/bomberman': '/bomberman.html', '/minesweeper': '/minesweeper.html' };

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
  if (room.eg && room.eg.active) {
    room.eg.active = false;
    room.eg = null;
  }
  if (room.sl && room.sl.active) {
    if (room.sl.pendingTimer) { clearTimeout(room.sl.pendingTimer); room.sl.pendingTimer = null; room.sl.pendingTwist = null; }
    const wasTurn = room.sl.playerOrder[room.sl.turnIdx] === conn.id;
    room.sl.playerOrder = room.sl.playerOrder.filter(pid => pid !== conn.id);
    delete room.sl.positions[conn.id];
    delete room.sl.shields[conn.id];
    if (room.sl.playerOrder.length < 2) {
      room.sl.active = false;
      room.status = 'waiting';
      broadcastRoom(room.id, { type: 'sl-aborted', reason: 'Not enough players' });
    } else {
      if (room.sl.turnIdx >= room.sl.playerOrder.length) room.sl.turnIdx = 0;
      broadcastRoom(room.id, { type: 'sl-player-left', id: conn.id, nextTurnId: room.sl.playerOrder[room.sl.turnIdx] });
    }
  }
  if (room.uno && room.uno.active) {
    const unoHand = room.uno.hands.get(conn.id);
    room.uno.turnOrder = room.uno.turnOrder.filter(pid => pid !== conn.id);
    room.uno.hands.delete(conn.id);
    if (room.uno.turnIdx >= room.uno.turnOrder.length) room.uno.turnIdx = 0;
    if (room.players.size === 0) {
      if (room.uno.roundTimer) clearTimeout(room.uno.roundTimer);
      room.uno = null;
    } else if (room.uno.turnOrder.length < 2) {
      room.uno.active = false;
      room.status = 'waiting';
      broadcastRoom(room.id, { type: 'uno-aborted', reason: 'Not enough players' });
    } else {
      if (!room.uno.disconnects) room.uno.disconnects = new Map();
      if (unoHand) room.uno.disconnects.set(conn.name, { hand: [...unoHand], at: Date.now() });
      // If it was this player's turn, advance
      if (room.uno.turnOrder.length > 0) {
        if (room.uno.turnIdx >= room.uno.turnOrder.length) room.uno.turnIdx = 0;
        sendUnoTurn(room);
      }
      broadcastUnoPlayerUpdate(room);
    }
  }
  if (room.tanks && room.tanks.active) {
    // Remove tank
    delete room.tanks.tankState[conn.id];
    room.tanks.turnOrder = room.tanks.turnOrder.filter(pid => pid !== conn.id);
    if (room.tanks.turnTimer) { clearTimeout(room.tanks.turnTimer); room.tanks.turnTimer = null; }
    if (room.players.size === 0) {
      room.tanks = null;
    } else if (room.tanks.turnOrder.length < 2) {
      // Only one left — they win
      tanksCheckGameOver(room);
    } else {
      // If it was this player's turn, skip to next
      if (room.tanks.turnIdx >= room.tanks.turnOrder.length) room.tanks.turnIdx = 0;
      broadcastRoom(room.id, { type: 'player-left', id: conn.id });
      tanksStartTurn(room);
    }
  }
  if (room.bomberman && room.bomberman.active) {
    const bm = room.bomberman;
    const ps = bm.players[conn.id];
    if (ps) { ps.alive = false; ps.disconnected = true; }
    if (room.players.size === 0) {
      if (bm.tickInterval) clearInterval(bm.tickInterval);
      room.bomberman = null;
    } else {
      bmCheckRoundEnd(room);
    }
  }
  if (room.minesweeper && room.minesweeper.active) {
    const ms = room.minesweeper;
    delete ms.players[conn.id];
    if (room.players.size === 0) {
      if (ms.timer) clearTimeout(ms.timer);
      room.minesweeper = null;
    } else {
      broadcastRoom(room.id, { type: 'ms-player-left', id: conn.id });
    }
  }

  // Remove empty rooms
  if (room.players.size === 0) {
    if (room.countdown) clearInterval(room.countdown);
    rooms.delete(conn.roomId);
  } else {
    // Don't reset status if an active game is still running
    const hasActiveGame = (room.uno?.active) || (room.br?.active) || (room.sl?.active) || (room.rami?.roundActive) || (room.tanks?.active) || (room.bomberman?.active) || (room.minesweeper?.active);
    if (!hasActiveGame) room.status = 'waiting';
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

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // ── Require verified auth for every message except the first auth ──
    // lobby and join-room are the two entry-points; they carry the Firebase token.
    // All other messages are only processed after the connection is verified.
    if (!conn.verified && msg.type !== 'lobby' && msg.type !== 'join-room') {
      send(ws, { type: 'error', msg: 'Not authenticated' });
      ws.close();
      return;
    }

    switch (msg.type) {

      // ── Lobby ─────────────────────────────────────────────
      case 'lobby': {
        const sendRoomList = () => {
          conn.mode = 'lobby';
          if (msg.name) conn.name = String(msg.name).slice(0, 20);
          const seenNow = new Set();
          const onlineUsersNow = [];
          for (const [, c] of conns) { if (c.name && !seenNow.has(c.name)) { seenNow.add(c.name); onlineUsersNow.push(c.name); } }
          send(ws, { type: 'room-list', rooms: serializeRooms(), onlineUsers: onlineUsersNow });
        };
        // If already authenticated, just refresh the room list
        if (conn.verified) { sendRoomList(); break; }
        // First-time auth: require token
        const rawToken = msg.token ? String(msg.token) : null;
        if (!rawToken) {
          send(ws, { type: 'error', msg: 'Auth required' });
          ws.close();
          return;
        }
        admin.auth().verifyIdToken(rawToken).then(decoded => {
          conn.uid      = decoded.uid;
          conn.verified = true;
          conn.name     = String(msg.name || decoded.name || 'Player').slice(0, 20);
          sendRoomList();
          log('info', 'lobby-join', { id, name: conn.name, ip: conn.ip });
        }).catch(() => {
          send(ws, { type: 'error', msg: 'Invalid or expired token — please log in again' });
          ws.close();
        });
        break;
      }

      case 'create-room': {
        const type = msg.gameType === 'tetris' ? 'tetris' : msg.gameType === 'tictactoe' ? 'tictactoe' : msg.gameType === 'bluffrummy' ? 'bluffrummy' : msg.gameType === 'rami' ? 'rami' : msg.gameType === 'pool' ? 'pool' : msg.gameType === 'battleship' ? 'battleship' : msg.gameType === 'egame' ? 'egame' : msg.gameType === 'snakesladders' ? 'snakesladders' : msg.gameType === 'uno' ? 'uno' : msg.gameType === 'tanks' ? 'tanks' : msg.gameType === 'bomberman' ? 'bomberman' : msg.gameType === 'minesweeper' ? 'minesweeper' : 'maze';
        const name = String(msg.roomName || conn.name + "'s Room").slice(0, 30);
        const max = type === 'tictactoe' || type === 'pool' || type === 'battleship' || type === 'egame' ? 2 : type === 'bluffrummy' || type === 'snakesladders' ? Math.min(4, Math.max(2, parseInt(msg.maxPlayers) || 4)) : type === 'rami' ? Math.min(4, Math.max(1, parseInt(msg.maxPlayers) || 4)) : type === 'uno' ? Math.min(6, Math.max(2, parseInt(msg.maxPlayers) || 6)) : type === 'tanks' || type === 'bomberman' || type === 'minesweeper' ? Math.min(4, Math.max(2, parseInt(msg.maxPlayers) || 4)) : Math.min(8, Math.max(2, parseInt(msg.maxPlayers) || 6));
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
        // Game pages open a fresh WS and immediately send join-room with their token.
        // Verify now if not yet verified (lobby message was on a different WS connection).
        const joinToken = msg.token ? String(msg.token) : null;
        if (!conn.verified) {
          if (!joinToken) {
            send(ws, { type: 'error', msg: 'Auth required' });
            ws.close();
            return;
          }
          try {
            const decoded = await admin.auth().verifyIdToken(joinToken);
            conn.uid      = decoded.uid;
            conn.verified = true;
          } catch {
            send(ws, { type: 'error', msg: 'Invalid or expired token — please log in again' });
            ws.close();
            return;
          }
        }

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
            if (room.uno?.active) {
              room.uno.turnOrder = room.uno.turnOrder.filter(p => p !== existingId);
              if (room.uno.turnIdx >= room.uno.turnOrder.length) room.uno.turnIdx = 0;
            }
            break;
          }
        }

        // Check for BluffRummy reconnect (disconnected player rejoining)
        let isBrReconnect = false;
        if (room.br?.active && room.br.disconnects?.has(conn.name)) isBrReconnect = true;

        // Lock snakesladders rooms while game is running
        if (room.status === 'playing' && room.type === 'snakesladders') {
          send(ws, { type: 'error', msg: 'Game in progress — this room is locked' }); break;
        }
        // Lock game-in-progress rooms to new players (allow BR reconnects)
        if (room.status === 'playing' && room.type === 'bluffrummy' && !isBrReconnect) {
          send(ws, { type: 'error', msg: 'Game in progress — this room is locked' }); break;
        }
        // Lock UNO rooms while game is running (allow reconnect by same name)
        if (room.status === 'playing' && room.type === 'uno') {
          const isUnoReconnect = room.uno?.active && room.uno.disconnects?.has(conn.name);
          if (!isUnoReconnect) {
            send(ws, { type: 'error', msg: 'Game in progress — this room is locked' }); break;
          }
        }
        // Lock tanks rooms while game is running
        if (room.status === 'playing' && room.type === 'tanks') {
          send(ws, { type: 'error', msg: 'Game in progress — this room is locked' }); break;
        }
        // Lock bomberman rooms while game is running
        if (room.status === 'playing' && room.type === 'bomberman') {
          send(ws, { type: 'error', msg: 'Game in progress — this room is locked' }); break;
        }
        // Lock minesweeper rooms while game is running
        if (room.status === 'playing' && room.type === 'minesweeper') {
          send(ws, { type: 'error', msg: 'Game in progress — this room is locked' }); break;
        }

        removeFromRoom(conn); // leave any existing room
        conn.mode = 'room';
        conn.roomId = room.id;
        room.players.set(id, { ws, name: conn.name, gameState: null });
        send(ws, {
          type: 'room-joined', roomId: room.id, roomType: room.type,
          roomName: room.name, myId: id, players: roomPlayerList(room, id),
          leaderId: room.players.keys().next().value,
        });
        broadcastRoom(room.id, {
          type: 'player-joined', id, name: conn.name,
          leaderId: room.players.keys().next().value,
        }, id);

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

        // Restore UNO hand on reconnect
        if (room.uno?.active && room.uno.disconnects?.has(conn.name)) {
          const disc = room.uno.disconnects.get(conn.name);
          room.uno.disconnects.delete(conn.name);
          room.uno.hands.set(id, disc.hand);
          if (!room.uno.turnOrder.includes(id)) {
            const insertAt = Math.min(room.uno.turnIdx, room.uno.turnOrder.length);
            room.uno.turnOrder.splice(insertAt, 0, id);
          }
          broadcastRoom(room.id, { type: 'player-joined', id, name: conn.name, leaderId: room.players.keys().next().value }, id);
          sendUnoFullState(room, id);
          sendUnoTurn(room);
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
        const room = rooms.get(conn.roomId);
        if (!room) return;
        const lines = Math.min(20, Math.max(0, parseInt(msg.lines) || 0));
        // In an active battle, target one random alive opponent instead of everyone
        if (room.battle && room.battle.started) {
          const targets = [];
          for (const [pid] of room.players) {
            if (pid !== id && !room.battle.eliminated.has(pid)) targets.push(pid);
          }
          if (targets.length > 0) {
            const target = targets[Math.floor(Math.random() * targets.length)];
            const tp = room.players.get(target);
            if (tp) send(tp.ws, { type: 'garbage', from: id, lines });
          }
        } else {
          broadcastRoom(conn.roomId, { type: 'garbage', from: id, lines }, id);
        }
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
        // Eliminate any player who played their last card previously (not challenged)
        if (br.lastPlayerId && br.lastPlayerId !== id) {
          const lastHand = br.hands.get(br.lastPlayerId);
          if (lastHand && lastHand.length === 0 && !br.finishOrder.includes(br.lastPlayerId)) {
            br.finishOrder.push(br.lastPlayerId);
            const elimRank = br.finishOrder.length;
            broadcastRoom(room.id, { type: 'br-eliminate', playerId: br.lastPlayerId, rank: elimRank });
            log('info', 'br-eliminate', { roomId: room.id, playerId: br.lastPlayerId, rank: elimRank });
            br.turnOrder = br.turnOrder.filter(pid => pid !== br.lastPlayerId);
            if (br.turnOrder.length <= 1) { endBluffRummy(room); return; }
            br.turnIdx = br.turnOrder.indexOf(id);
            if (br.turnIdx === -1) return;
          }
        }
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
        // If player has 0 cards, don't eliminate yet — next player gets a chance to challenge.
        // Elimination happens when the next player plays (no challenge) or after challenge resolution.
        advanceBrTurn(room);
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

      // ── Pool: match start ─────────────────────────────────
      case 'pool-match-start': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'pool') break;
        if (room.players.size < 2) { send(ws, { type: 'error', msg: 'Need 2 players to start' }); break; }
        const mode   = (msg.mode === '9ball') ? '9ball' : '8ball';
        const seats  = Array.isArray(msg.seats) ? msg.seats.slice(0, 2) : [];
        const pNames = Array.isArray(msg.players) ? msg.players.slice(0, 2) : [];
        room.status = 'playing';
        broadcastLobby();
        broadcastRoom(room.id, { type: 'pool-match-start', mode, seats, players: pNames });
        log('info', 'pool-match-start', { startedBy: conn.name, ip: conn.ip, roomId: room.id, mode, players: room.players.size });
        break;
      }

      // ── Pool: relay shot to opponent ──────────────────────
      case 'pool-shot': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'pool') break;
        // Relay to all OTHER players in the room (not back to sender)
        broadcastRoom(room.id, { type: 'pool-shot', vx: msg.vx, vy: msg.vy, balls: msg.balls }, id);
        break;
      }

      // ── Pool: relay authoritative end-of-turn state ───────
      case 'pool-state': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'pool') break;
        broadcastRoom(room.id, { type: 'pool-state', state: msg.state }, id);
        break;
      }

      // ── Pool: relay mouse position ────────────────────────
      case 'pool-mouse': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'pool') break;
        broadcastRoom(room.id, { type: 'pool-mouse', x: msg.x, y: msg.y }, id);
        break;
      }

      // ── Pool: game over ───────────────────────────────────
      case 'pool-gameover': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'pool') break;
        broadcastRoom(room.id, { type: 'pool-gameover', winner: msg.winner, reason: msg.reason }, id);
        room.status = 'waiting';
        broadcastLobby();
        log('info', 'pool-gameover', { id, name: conn.name, ip: conn.ip, roomId: room.id, winner: msg.winner });
        break;
      }

      // ── Battleship ─────────────────────────────────────────
      case 'bs-ready': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'battleship') break;
        if (!room.bs) room.bs = { layouts: new Map(), ready: new Set(), shots: new Map() };
        const layout = Array.isArray(msg.layout) ? msg.layout : [];
        const SHIP_SIZES = { Carrier: 5, Battleship: 4, Cruiser: 3, Submarine: 3, Destroyer: 2 };
        const board = Array.from({ length: 10 }, () => new Array(10).fill(0));
        let valid = layout.length === 5;
        if (valid) {
          for (const ship of layout) {
            const expected = SHIP_SIZES[String(ship.name)];
            if (!expected || ship.size !== expected) { valid = false; break; }
            const r = parseInt(ship.row), c = parseInt(ship.col), horiz = !!ship.horiz;
            if (isNaN(r) || isNaN(c) || r < 0 || r >= 10 || c < 0 || c >= 10) { valid = false; break; }
            for (let i = 0; i < expected; i++) {
              const sr = horiz ? r : r + i;
              const sc = horiz ? c + i : c;
              if (sr < 0 || sr >= 10 || sc < 0 || sc >= 10 || board[sr][sc]) { valid = false; break; }
              board[sr][sc] = ship.name;
            }
            if (!valid) break;
          }
        }
        if (!valid) { send(ws, { type: 'error', msg: 'Invalid fleet placement' }); break; }
        room.bs.layouts.set(id, {
          board,
          ships: layout.map(s => ({ name: s.name, size: s.size, row: s.row, col: s.col, horiz: s.horiz, hits: 0 })),
        });
        room.bs.ready.add(id);
        if (room.bs.ready.size >= 2 && room.players.size >= 2) {
          const pids = [...room.players.keys()];
          room.bs.currentTurn = pids[Math.floor(Math.random() * 2)];
          room.status = 'playing';
          broadcastLobby();
          for (const [pid, p] of room.players) {
            const opp = [...room.players.entries()].find(([oid]) => oid !== pid);
            send(p.ws, { type: 'bs-start', firstTurn: room.bs.currentTurn, oppName: opp?.[1].name || 'Opponent' });
          }
          log('info', 'bs-start', { roomId: room.id, firstTurn: room.players.get(room.bs.currentTurn)?.name, ip: conn.ip });
        }
        break;
      }

      case 'bs-fire': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'battleship' || !room.bs) break;
        if (room.bs.currentTurn !== id) break;
        const row = parseInt(msg.row), col = parseInt(msg.col);
        if (isNaN(row) || isNaN(col) || row < 0 || row >= 10 || col < 0 || col >= 10) break;
        const myShots = room.bs.shots.get(id) || new Set();
        const shotKey = `${row},${col}`;
        if (myShots.has(shotKey)) break;
        myShots.add(shotKey);
        room.bs.shots.set(id, myShots);
        const oppId = [...room.players.keys()].find(p => p !== id);
        if (!oppId) break;
        const oppLayout = room.bs.layouts.get(oppId);
        if (!oppLayout) break;
        const cellContent = oppLayout.board[row][col];
        const isHit = !!cellContent;
        let sunk = null, sunkCells = null;
        if (isHit) {
          const ship = oppLayout.ships.find(s => s.name === cellContent);
          if (ship) {
            ship.hits++;
            if (ship.hits >= ship.size) {
              sunk = ship.name;
              sunkCells = [];
              for (let i = 0; i < ship.size; i++) {
                sunkCells.push({ r: ship.horiz ? ship.row : ship.row + i, c: ship.horiz ? ship.col + i : ship.col });
              }
            }
          }
        }
        const allSunk = oppLayout.ships.every(s => s.hits >= s.size);
        const result = isHit ? 'hit' : 'miss';
        send(ws, { type: 'bs-shot-result', row, col, result, sunk, sunkCells, win: allSunk });
        const oppPlayer = room.players.get(oppId);
        if (oppPlayer) send(oppPlayer.ws, { type: 'bs-inbound', row, col, result, sunk, sunkCells, win: allSunk });
        if (allSunk) {
          room.bs = null; room.status = 'waiting'; broadcastLobby();
          log('info', 'bs-win', { roomId: room.id, winner: conn.name, ip: conn.ip });
        } else {
          room.bs.currentTurn = isHit ? id : oppId; // hit = keep turn, miss = switch
        }
        log('info', 'bs-fire', { roomId: room.id, by: conn.name, row, col, result, sunk: sunk || '' });
        break;
      }

      // ── E-Game ───────────────────────────────────────────────
      case 'eg-new': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'egame') return;
        if (room.players.size < 2) { send(ws, { type: 'error', msg: 'Need 2 players' }); return; }
        startEGame(room);
        break;
      }
      case 'eg-pick': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.eg || !room.eg.active) return;
        const eg = room.eg;
        const cardType = String(msg.card);
        if (!['emperor', 'citizen', 'slave'].includes(cardType)) return;
        // Check it's a valid player
        if (!eg.hands.has(id)) return;
        // Check player hasn't already picked
        if (eg.picks.has(id)) return;
        // Check card is in hand
        const hand = eg.hands.get(id);
        const cardIdx = hand.indexOf(cardType);
        if (cardIdx === -1) return;
        // Remove card from hand
        hand.splice(cardIdx, 1);
        eg.picks.set(id, cardType);
        // Notify the picker they are waiting
        send(ws, { type: 'eg-waiting' });
        // Notify opponent they are being waited on
        const oppId = eg.players.find(p => p !== id);
        if (oppId && !eg.picks.has(oppId)) {
          const oppPlayer = room.players.get(oppId);
          if (oppPlayer) send(oppPlayer.ws, { type: 'eg-waiting' });
        }
        // If both picked, resolve
        if (eg.picks.size === 2) {
          resolveEGameTurn(room);
        }
        break;
      }

      // ── Snakes & Ladders ──────────────────────────────────
      case 'sl-start': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'snakesladders') return;
        if (room.sl?.active) { send(ws, { type: 'error', msg: 'A game is already in progress' }); return; }
        if (room.players.size < 2) { send(ws, { type: 'error', msg: 'Need at least 2 players' }); return; }
        // Only the leader (first player) may start
        if (room.players.keys().next().value !== id) return;
        // Per-twist weights: object { swap:0-100, shield:0-100, ... } defaults to 50 each
        const DEFAULT_W = 50;
        const twistWeights = {
          swap:       Math.min(100, Math.max(0, parseInt(msg.twistWeights?.swap)       || DEFAULT_W)),
          shield:     Math.min(100, Math.max(0, parseInt(msg.twistWeights?.shield)     || DEFAULT_W)),
          bomb:       Math.min(100, Math.max(0, parseInt(msg.twistWeights?.bomb)       || DEFAULT_W)),
          doubleroll: Math.min(100, Math.max(0, parseInt(msg.twistWeights?.doubleroll) || DEFAULT_W)),
          chaos:      Math.min(100, Math.max(0, parseInt(msg.twistWeights?.chaos)      || DEFAULT_W)),
          freemove:   Math.min(100, Math.max(0, parseInt(msg.twistWeights?.freemove)   || DEFAULT_W)),
        };
        startSnakesLadders(room, twistWeights);
        break;
      }
      case 'sl-roll': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.sl || !room.sl.active) return;
        const sl = room.sl;
        if (sl.pendingTwist) return;  // already awaiting a twist choice
        if (sl.playerOrder[sl.turnIdx] !== id) return;

        // Roll both dice
        const moveDice = Math.floor(Math.random() * 6) + 1;
        // Weighted twist roll: build a pool where each twist appears proportional to its weight
        const tw = sl.twistWeights || {};
        const TWIST_POOL = [];
        for (const name of SL_TWIST_NAMES) {
          const w = Math.round((tw[name] ?? 50) / 10); // 0-10 slots
          for (let i = 0; i < w; i++) TWIST_POOL.push(name);
        }
        let twist = TWIST_POOL.length > 0
          ? TWIST_POOL[Math.floor(Math.random() * TWIST_POOL.length)]
          : 'blank';
        let moveDice2 = null;
        if (twist === 'doubleroll') moveDice2 = Math.floor(Math.random() * 6) + 1;
        const totalMove = moveDice + (moveDice2 || 0);

        // Apply movement
        const from      = sl.positions[id] || 0;
        const rawTo     = from + totalMove;
        const overshoot = rawTo > 100;
        let landedOn = from, finalPos = from;
        let event = null;

        if (!overshoot) {
          landedOn = finalPos = rawTo;
          if (SL_LADDERS[finalPos] !== undefined) {
            event = 'ladder'; finalPos = SL_LADDERS[finalPos];
          } else if (SL_SNAKES[finalPos] !== undefined) {
            if ((sl.shields[id] || 0) > 0) {
              event = 'shield-block';
            } else {
              event = 'snake'; finalPos = SL_SNAKES[finalPos];
            }
          }
          sl.positions[id] = finalPos;
          // Decay shield (one turn used up regardless of whether snake was blocked)
          if ((sl.shields[id] || 0) > 0) sl.shields[id]--;
        }

        // Instant twists
        let chaosPositions = null;
        if (twist === 'shield') {
          sl.shields[id] = (sl.shields[id] || 0) + 2;
        } else if (twist === 'chaos' && sl.playerOrder.length > 1) {
          const order   = sl.playerOrder;
          const posCopy = { ...sl.positions };
          for (let i = 0; i < order.length; i++)
            // Clamp to 1 so nobody gets sent to the off-board (position 0) slot
            sl.positions[order[i]] = Math.max(1, posCopy[order[(i + 1) % order.length]]);
          chaosPositions = { ...sl.positions };
        }

        // Winner check (movement + chaos)
        const activePos = chaosPositions ? chaosPositions[id] : sl.positions[id];
        const winner    = activePos === 100 ? { id, name: conn.name } : null;
        if (winner) { sl.active = false; room.status = 'waiting'; broadcastLobby(); }

        // Targeting twists need a follow-up choice
        const NEEDS_TARGET = ['swap', 'bomb', 'freemove'];
        let validTargets   = null;
        if (!winner && NEEDS_TARGET.includes(twist)) {
          if (twist === 'freemove') {
            validTargets = [];
            for (let s = Math.max(1, finalPos - 5); s <= Math.min(100, finalPos + 5); s++)
              if (s !== finalPos) validTargets.push(s);
            if (validTargets.length === 0) twist = 'blank';
          } else {
            validTargets = sl.playerOrder.filter(pid => pid !== id && (sl.positions[pid] || 0) > 0);
            if (validTargets.length === 0) twist = 'blank';
          }
        }

        if (!winner && NEEDS_TARGET.includes(twist) && validTargets && validTargets.length > 0) {
          // Park game waiting for choice
          sl.pendingTwist = { twist, playerId: id, finalPos, validTargets };
          sl.pendingTimer = setTimeout(() => {
            const r = rooms.get(room.id);
            if (!r?.sl?.pendingTwist) return;
            r.sl.pendingTwist = null;
            r.sl.pendingTimer = null;
            r.sl.turnIdx = (r.sl.turnIdx + 1) % r.sl.playerOrder.length;
            broadcastRoom(r.id, {
              type: 'sl-twist-resolved',
              playerId: id, playerName: conn.name,
              timedOut: true,
              twistDetail: { twist: 'timeout' },
              positions: { ...r.sl.positions },
              shields: { ...r.sl.shields },
              nextTurnId: r.sl.playerOrder[r.sl.turnIdx],
              winner: null,
            });
          }, 15000);
          broadcastRoom(room.id, {
            type: 'sl-rolled',
            playerId: id, playerName: conn.name,
            moveDice, moveDice2, twist,
            from, landedOn, finalPos, event, overshoot,
            positions: { ...sl.positions },
            shields:   { ...sl.shields },
            validTargets, awaitingTwist: true,
            nextTurnId: null, winner: null, chaosPositions: null,
          });
        } else {
          if (!winner) sl.turnIdx = (sl.turnIdx + 1) % sl.playerOrder.length;
          broadcastRoom(room.id, {
            type: 'sl-rolled',
            playerId: id, playerName: conn.name,
            moveDice, moveDice2, twist,
            from, landedOn, finalPos, event, overshoot,
            positions: chaosPositions || { ...sl.positions },
            shields:   { ...sl.shields },
            awaitingTwist: false,
            nextTurnId:    winner ? null : sl.playerOrder[sl.turnIdx],
            winner, chaosPositions,
          });
        }
        log('info', 'sl-roll', { roomId: room.id, player: conn.name, moveDice, twist, from, finalPos, event: event||'none', overshoot });
        if (winner) log('info', 'sl-win', { roomId: room.id, winner: conn.name });
        break;
      }

      case 'sl-twist-choice': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.sl?.active) return;
        const sl = room.sl;
        if (!sl.pendingTwist || sl.pendingTwist.playerId !== id) return;

        clearTimeout(sl.pendingTimer);
        sl.pendingTimer = null;
        const { twist, finalPos, validTargets } = sl.pendingTwist;
        sl.pendingTwist = null;

        const twistDetail = { twist };
        if (twist === 'swap') {
          const targetId = msg.targetId;
          if (!validTargets.includes(targetId)) return;
          const myPos = sl.positions[id], theirPos = sl.positions[targetId];
          sl.positions[id] = theirPos;
          sl.positions[targetId] = myPos;
          twistDetail.targetId   = targetId;
          twistDetail.targetName = room.players.get(targetId)?.name || '';
          twistDetail.myNewPos   = theirPos;
          twistDetail.theirNewPos = myPos;
        } else if (twist === 'bomb') {
          const targetId = msg.targetId;
          if (!validTargets.includes(targetId)) return;
          const prev = sl.positions[targetId] || 0;
          sl.positions[targetId] = Math.max(1, prev - 10);
          twistDetail.targetId   = targetId;
          twistDetail.targetName = room.players.get(targetId)?.name || '';
          twistDetail.from       = prev;
          twistDetail.to         = sl.positions[targetId];
        } else if (twist === 'freemove') {
          const sq = parseInt(msg.square);
          if (!validTargets.includes(sq)) return;
          // Apply snake or ladder if the chosen square triggers one
          let fmFinalPos = sq, fmEvent = null;
          if (SL_LADDERS[sq] !== undefined) {
            fmEvent = 'ladder'; fmFinalPos = SL_LADDERS[sq];
          } else if (SL_SNAKES[sq] !== undefined) {
            if ((sl.shields[id] || 0) > 0) { fmEvent = 'shield-block'; }
            else { fmEvent = 'snake'; fmFinalPos = SL_SNAKES[sq]; }
          }
          sl.positions[id] = fmFinalPos;
          twistDetail.square    = sq;
          twistDetail.fmFinalPos = fmFinalPos;
          twistDetail.fmEvent   = fmEvent;
        }

        const winner = sl.positions[id] === 100 ? { id, name: conn.name } : null;
        if (winner) { sl.active = false; room.status = 'waiting'; broadcastLobby(); }
        if (!winner) sl.turnIdx = (sl.turnIdx + 1) % sl.playerOrder.length;

        broadcastRoom(room.id, {
          type:       'sl-twist-resolved',
          playerId:   id,
          playerName: conn.name,
          timedOut:   false,
          twistDetail,
          positions:  { ...sl.positions },
          shields:    { ...sl.shields },
          nextTurnId: winner ? null : sl.playerOrder[sl.turnIdx],
          winner,
        });
        log('info', 'sl-twist', { roomId: room.id, player: conn.name, twist, detail: twistDetail });
        break;
      }

      // ── UNO ───────────────────────────────────────────────
      case 'uno-start': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'uno') break;
        if (room.uno?.active) { send(ws, { type: 'error', msg: 'A game is already in progress' }); break; }
        if (room.players.size < 2) { send(ws, { type: 'error', msg: 'Need 2-6 players' }); break; }
        startUno(room);
        break;
      }

      case 'uno-play': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.uno?.active) break;
        const uno = room.uno;
        if (uno.turnOrder[uno.turnIdx] !== id) break; // not your turn
        const cardIndex = parseInt(msg.cardIndex);
        const playerHand = uno.hands.get(id);
        if (!playerHand || cardIndex < 0 || cardIndex >= playerHand.length) break;
        const card = playerHand[cardIndex];
        // Validate play
        if (!unoIsPlayable(card, uno.topCard, uno.currentColor)) break;
        // Wild cards need chosen color
        let chosenColor = null;
        if (card.type === 'wild' || card.type === 'wild_draw_four') {
          chosenColor = msg.chosenColor;
          if (!['red', 'yellow', 'green', 'blue'].includes(chosenColor)) break;
        }
        // Remove card from hand
        playerHand.splice(cardIndex, 1);
        // Update top card and current color
        uno.topCard = card;
        uno.currentColor = chosenColor || card.color;
        // Clear drawn-this-turn state
        uno.drawnThisTurn = false;
        // Handle special cards
        let skipNext = false;
        if (card.type === 'skip') {
          skipNext = true;
        } else if (card.type === 'reverse') {
          if (uno.turnOrder.length === 2) { skipNext = true; } // acts as skip in 2-player
          else { uno.direction *= -1; }
        } else if (card.type === 'draw_two') {
          skipNext = true;
          const nextIdx = unoNextIdx(uno);
          const nextPid = uno.turnOrder[nextIdx];
          const nextHand = uno.hands.get(nextPid);
          if (nextHand) {
            for (let d = 0; d < 2; d++) {
              if (uno.drawPile.length === 0) unoReshuffleDraw(uno);
              if (uno.drawPile.length > 0) nextHand.push(uno.drawPile.pop());
            }
          }
          // Notify penalty
          const nextP = room.players.get(nextPid);
          if (nextP) {
            send(nextP.ws, { type: 'uno-penalty-draw', playerId: nextPid, count: 2, cardCount: nextHand.length, drawPileCount: uno.drawPile.length, handUpdate: nextHand });
          }
          broadcastRoom(room.id, { type: 'uno-penalty-draw', playerId: nextPid, count: 2, cardCount: nextHand.length, drawPileCount: uno.drawPile.length }, nextPid);
        } else if (card.type === 'wild_draw_four') {
          skipNext = true;
          const nextIdx = unoNextIdx(uno);
          const nextPid = uno.turnOrder[nextIdx];
          const nextHand = uno.hands.get(nextPid);
          if (nextHand) {
            for (let d = 0; d < 4; d++) {
              if (uno.drawPile.length === 0) unoReshuffleDraw(uno);
              if (uno.drawPile.length > 0) nextHand.push(uno.drawPile.pop());
            }
          }
          const nextP = room.players.get(nextPid);
          if (nextP) {
            send(nextP.ws, { type: 'uno-penalty-draw', playerId: nextPid, count: 4, cardCount: nextHand.length, drawPileCount: uno.drawPile.length, handUpdate: nextHand });
          }
          broadcastRoom(room.id, { type: 'uno-penalty-draw', playerId: nextPid, count: 4, cardCount: nextHand.length, drawPileCount: uno.drawPile.length }, nextPid);
        }
        // Broadcast play to all
        for (const [pid, p] of room.players) {
          const payload = {
            type: 'uno-played', playerId: id, card, currentColor: uno.currentColor,
            direction: uno.direction, cardCount: playerHand.length,
            drawPileCount: uno.drawPile.length, chosenColor,
          };
          if (pid === id) payload.handUpdate = playerHand;
          send(p.ws, payload);
        }
        // Check if player won the round — hand is empty
        if (playerHand.length === 0) {
          unoEndRound(room, id);
          break;
        }
        // UNO flag: auto-clear if hand > 1
        if (playerHand.length !== 1) uno.unoFlags.delete(id);
        // Advance turn
        unoAdvanceTurn(uno, skipNext);
        sendUnoTurn(room);
        log('info', 'uno-play', { roomId: room.id, player: conn.name, card: cardLabelServer(card) });
        break;
      }

      case 'uno-draw': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.uno?.active) break;
        const uno = room.uno;
        if (uno.turnOrder[uno.turnIdx] !== id) break;
        if (uno.drawnThisTurn) break; // already drew
        // Draw one card
        if (uno.drawPile.length === 0) unoReshuffleDraw(uno);
        if (uno.drawPile.length === 0) break; // no cards
        const drawn = uno.drawPile.pop();
        const playerHand = uno.hands.get(id);
        playerHand.push(drawn);
        uno.drawnThisTurn = true;
        const canPlay = unoIsPlayable(drawn, uno.topCard, uno.currentColor);
        // Send to drawing player (with their new hand)
        send(ws, { type: 'uno-drew', playerId: id, handUpdate: playerHand, drawnCard: drawn, canPlay, cardCount: playerHand.length, drawPileCount: uno.drawPile.length });
        // Broadcast to others (without revealing card)
        broadcastRoom(room.id, { type: 'uno-drew', playerId: id, cardCount: playerHand.length, drawPileCount: uno.drawPile.length, count: 1 }, id);
        if (!canPlay) {
          // Auto-pass: card not playable
          unoAdvanceTurn(uno, false);
          sendUnoTurn(room);
        }
        // If canPlay, player can either play it or pass
        log('info', 'uno-draw', { roomId: room.id, player: conn.name });
        break;
      }

      case 'uno-pass': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.uno?.active) break;
        const uno = room.uno;
        if (uno.turnOrder[uno.turnIdx] !== id) break;
        if (!uno.drawnThisTurn) break; // must draw first
        uno.drawnThisTurn = false;
        broadcastRoom(room.id, { type: 'uno-pass', playerId: id });
        unoAdvanceTurn(uno, false);
        sendUnoTurn(room);
        break;
      }

      case 'uno-call-uno': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.uno?.active) break;
        const uno = room.uno;
        const playerHand = uno.hands.get(id);
        if (!playerHand || playerHand.length > 2) break; // can only call when at 2 or 1 cards
        uno.unoFlags.add(id);
        broadcastRoom(room.id, { type: 'uno-flag', playerId: id, flag: true });
        break;
      }

      // ── Tank Battle ──────────────────────────────────────
      case 'tanks-start': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'tanks') break;
        if (room.tanks?.active) { send(ws, { type: 'error', msg: 'A game is already in progress' }); break; }
        if (room.players.size < 2) { send(ws, { type: 'error', msg: 'Need 2-4 players' }); break; }
        if (room.players.keys().next().value !== id) { send(ws, { type: 'error', msg: 'Only the leader can start' }); break; }
        startTanks(room);
        break;
      }

      case 'tanks-move': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.tanks?.active) break;
        const tk = room.tanks;
        if (tk.turnOrder[tk.turnIdx] !== id) break;
        if (tk.hasFired) break;
        const dir = msg.direction === -1 ? -1 : 1;
        const tank = tk.tankState[id];
        if (!tank || !tank.alive) break;
        const moveAmount = Math.min(5, tank.moveBudget);
        if (moveAmount <= 0) break;
        tank.moveBudget -= moveAmount;
        const newX = Math.max(15, Math.min(tk.terrainW - 15, tank.x + dir * moveAmount));
        tank.x = newX;
        // Settle on terrain
        tank.y = tanksGetGroundY(tk.terrain, tk.terrainW, tk.terrainH, tank.x);
        // Check if fell into void
        if (tank.y >= tk.terrainH - 15) { tank.hp = 0; tank.alive = false; }
        // Check crate pickup
        let pickedCrate = null;
        for (let ci = tk.crates.length - 1; ci >= 0; ci--) {
          const crate = tk.crates[ci];
          if (Math.abs(tank.x - crate.x) < 28) {
            pickedCrate = crate;
            tk.crates.splice(ci, 1);
            if (crate.type === 'health') {
              tank.hp = Math.min(TANKS_MAX_HP, tank.hp + crate.payload.hp);
            } else {
              const w = crate.payload.weapon, cnt = crate.payload.count || 1;
              tank.inventory[w] = (tank.inventory[w] || 0) + cnt;
            }
            break;
          }
        }
        broadcastRoom(room.id, { type: 'tanks-move', playerId: id, x: tank.x, y: tank.y, moveBudget: tank.moveBudget,
          pickedCrate: pickedCrate ? { id: pickedCrate.id, type: pickedCrate.type, icon: pickedCrate.icon, label: pickedCrate.label } : null,
          tankHp: tank.hp });
        break;
      }

      case 'tanks-fire': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.tanks?.active) break;
        const tk = room.tanks;
        if (tk.turnOrder[tk.turnIdx] !== id) break;
        if (tk.hasFired) break;
        tk.hasFired = true;
        if (tk.turnTimer) { clearTimeout(tk.turnTimer); tk.turnTimer = null; }
        const weapon = String(msg.weapon || 'standard');
        const angle = Math.max(0, Math.min(180, parseInt(msg.angle) || 90));
        const power = Math.max(5, Math.min(100, parseInt(msg.power) || 50));
        const tank = tk.tankState[id];
        if (!tank || !tank.alive) break;
        // Validate weapon ammo
        if (weapon !== 'standard') {
          if (!tank.inventory[weapon] || tank.inventory[weapon] <= 0) break;
          tank.inventory[weapon]--;
        }
        // Store angle
        tank.angle = angle;
        const result = tanksResolveShot(tk, id, weapon, angle, power, msg.airstrikeX);
        broadcastRoom(room.id, result);
        // Check game over
        if (!tanksCheckGameOver(room)) {
          // Advance turn
          tanksAdvanceTurn(room);
        }
        log('info', 'tanks-fire', { roomId: room.id, player: conn.name, weapon, angle, power });
        break;
      }

      case 'tanks-shield': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.tanks?.active) break;
        const tk = room.tanks;
        if (tk.turnOrder[tk.turnIdx] !== id) break;
        if (tk.hasFired) break;
        tk.hasFired = true;
        if (tk.turnTimer) { clearTimeout(tk.turnTimer); tk.turnTimer = null; }
        const tank = tk.tankState[id];
        if (!tank || !tank.alive) break;
        if (!tank.inventory.shield || tank.inventory.shield <= 0) break;
        tank.inventory.shield--;
        tank.shielded = true;
        broadcastRoom(room.id, { type: 'tanks-shield', playerId: id });
        tanksAdvanceTurn(room);
        break;
      }

      // ── Bomberman ──────────────────────────────────────────
      case 'bm-start': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'bomberman') break;
        if (room.bomberman?.active) break;
        if (room.players.size < 2) { send(ws, { type: 'error', msg: 'Need at least 2 players' }); break; }
        bmStartMatch(room);
        break;
      }
      case 'bm-input': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.bomberman?.active) break;
        const bm = room.bomberman;
        const ps = bm.players[id];
        if (!ps || !ps.alive) break;
        // msg.action: 'move-start','move-stop','bomb','ability'
        // msg.dir: 'up','down','left','right'
        if (msg.action === 'move-start' && ['up','down','left','right'].includes(msg.dir)) {
          ps.moveDir = msg.dir;
          ps.moving = true;
        } else if (msg.action === 'move-stop') {
          ps.moving = false;
          ps.moveDir = null;
        } else if (msg.action === 'bomb') {
          bmPlaceBomb(room, id);
        } else if (msg.action === 'ability') {
          bmUseAbility(room, id);
        }
        break;
      }

      // ── Minesweeper ────────────────────────────────────────
      case 'ms-start': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'minesweeper') break;
        if (room.minesweeper?.active) break;
        if (room.players.size < 2) { send(ws, { type: 'error', msg: 'Need at least 2 players' }); break; }
        const boardSize = [12,20,30].includes(parseInt(msg.boardSize)) ? parseInt(msg.boardSize) : 20;
        const density = [12,18,25].includes(parseInt(msg.density)) ? parseInt(msg.density) : 18;
        const timeLimit = [3,5,10].includes(parseInt(msg.timeLimit)) ? parseInt(msg.timeLimit) : 5;
        msStartGame(room, boardSize, density, timeLimit);
        break;
      }
      case 'ms-reveal': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.minesweeper?.active) break;
        const ms = room.minesweeper;
        const msp = ms.players[id];
        if (!msp || msp.stunUntil > Date.now()) break;
        const r = parseInt(msg.row), c = parseInt(msg.col);
        if (r < 0 || r >= ms.size || c < 0 || c >= ms.size) break;
        // If targeting mode (powerup)
        if (msp.targeting) {
          msUsePowerupTarget(room, id, r, c);
          break;
        }
        msRevealCell(room, id, r, c);
        break;
      }
      case 'ms-flag': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.minesweeper?.active) break;
        const ms = room.minesweeper;
        const msp = ms.players[id];
        if (!msp || msp.stunUntil > Date.now()) break;
        if (msp.flags <= 0) break;
        const r = parseInt(msg.row), c = parseInt(msg.col);
        if (r < 0 || r >= ms.size || c < 0 || c >= ms.size) break;
        const cell = ms.board[r][c];
        if (cell.revealed) break;
        if (cell.flaggedBy) {
          // Unflag if same player
          if (cell.flaggedBy === id) {
            cell.flaggedBy = null;
            msp.flags++;
            broadcastRoom(room.id, { type: 'ms-unflagged', row: r, col: c, playerId: id, flagsLeft: msp.flags });
          }
          break;
        }
        cell.flaggedBy = id;
        msp.flags--;
        broadcastRoom(room.id, { type: 'ms-flagged', row: r, col: c, playerId: id, flagsLeft: msp.flags });
        break;
      }
      case 'ms-powerup': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.minesweeper?.active) break;
        const ms = room.minesweeper;
        const msp = ms.players[id];
        if (!msp || msp.stunUntil > Date.now()) break;
        if (msp.charges <= 0) break;
        const ptype = String(msg.powerup);
        const validPowerups = ['reveal','magnet','shield','scanner','frenzy','trap'];
        if (!validPowerups.includes(ptype)) break;
        if (['reveal','magnet','trap'].includes(ptype)) {
          // Need targeting
          msp.targeting = ptype;
          send(ws, { type: 'ms-targeting', powerup: ptype });
        } else {
          msApplyInstantPowerup(room, id, ptype);
        }
        break;
      }
      case 'ms-cancel-target': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.minesweeper?.active) break;
        const msp = room.minesweeper.players[id];
        if (msp) msp.targeting = null;
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

// ── Snakes & Ladders helpers ─────────────────────────────────────
const SL_SNAKES       = { 17:7, 54:34, 62:19, 64:60, 87:24, 93:73, 95:75, 99:78 };
const SL_LADDERS      = { 4:14, 9:31, 20:38, 28:84, 40:59, 51:67, 63:81, 71:91 };
const SL_TWIST_NAMES  = ['swap','shield','bomb','doubleroll','chaos','freemove'];

function startSnakesLadders(room, twistWeights = {}) {
  const playerOrder = [...room.players.keys()];
  const positions = {}, shields = {};
  for (const pid of playerOrder) { positions[pid] = 0; shields[pid] = 0; }
  room.sl = { active: true, positions, playerOrder, turnIdx: 0, shields, pendingTwist: null, pendingTimer: null, twistWeights };
  room.status = 'playing';
  broadcastLobby();
  const playersInfo = playerOrder.map((pid, i) => ({ id: pid, name: room.players.get(pid).name, colorIdx: i }));
  for (const [pid, p] of room.players) {
    send(p.ws, { type: 'sl-start', yourId: pid, players: playersInfo, positions: { ...positions }, shields: { ...shields }, turnId: playerOrder[0], twistWeights });
  }
  log('info', 'sl-start', { roomId: room.id, players: playerOrder.length });
}

// ── E-Game helpers ──────────────────────────────────────────────
function buildEGameHand(side) {
  // Emperor side: 1 emperor + 4 citizens. Slave side: 1 slave + 4 citizens.
  const special = side === 'emperor' ? 'emperor' : 'slave';
  return [special, 'citizen', 'citizen', 'citizen', 'citizen'];
}

function startEGame(room) {
  const playerIds = [...room.players.keys()];
  // Random assignment of sides
  const shuffle = Math.random() < 0.5;
  const sides = new Map();
  sides.set(playerIds[0], shuffle ? 'emperor' : 'slave');
  sides.set(playerIds[1], shuffle ? 'slave' : 'emperor');

  const hands = new Map();
  for (const pid of playerIds) {
    hands.set(pid, buildEGameHand(sides.get(pid)));
  }

  room.eg = {
    players: playerIds,
    sides,
    hands,
    picks: new Map(),
    round: 1,
    turn: 1,
    totalTurn: 1,
    scores: new Map(playerIds.map(pid => [pid, 0])),
    active: true,
  };
  room.status = 'playing';
  broadcastLobby();

  // Send start to each player
  for (const [pid, p] of room.players) {
    const oppId = playerIds.find(x => x !== pid);
    send(p.ws, {
      type: 'eg-start',
      side: sides.get(pid),
      hand: hands.get(pid),
      round: 1,
      turn: 1,
      scores: { you: 0, opp: 0 },
      oppName: room.players.get(oppId)?.name || 'Opponent',
    });
  }
  log('info', 'eg-start', { roomId: room.id, players: playerIds.length });
}

function resolveEGameTurn(room) {
  const eg = room.eg;
  const [p1, p2] = eg.players;
  const c1 = eg.picks.get(p1);
  const c2 = eg.picks.get(p2);

  // Determine winner of this turn
  function getResult(a, b) {
    if (a === b) return 'draw';
    if (a === 'emperor' && b === 'citizen') return 'win';
    if (a === 'citizen' && b === 'slave') return 'win';
    if (a === 'slave' && b === 'emperor') return 'win';
    return 'lose';
  }

  const r1 = getResult(c1, c2);
  const r2 = getResult(c2, c1);

  // Award points
  if (r1 === 'win') {
    const pts = eg.sides.get(p1) === 'slave' ? 3 : 1;
    eg.scores.set(p1, eg.scores.get(p1) + pts);
  }
  if (r2 === 'win') {
    const pts = eg.sides.get(p2) === 'slave' ? 3 : 1;
    eg.scores.set(p2, eg.scores.get(p2) + pts);
  }

  // Advance turn/round
  const nextTotalTurn = eg.totalTurn + 1;
  const isGameOver = nextTotalTurn > 12;
  const isRoundOver = eg.turn >= 3 && !isGameOver;

  const nextTurn = isRoundOver ? 1 : eg.turn + 1;
  const nextRound = isRoundOver ? eg.round + 1 : eg.round;

  // Send reveal to both players
  for (const pid of eg.players) {
    const oppId = eg.players.find(x => x !== pid);
    const yourCard = eg.picks.get(pid);
    const oppCard = eg.picks.get(oppId);
    const result = pid === p1 ? r1 : r2;

    const pConn = room.players.get(pid);
    if (pConn) {
      send(pConn.ws, {
        type: 'eg-reveal',
        yourCard,
        oppCard,
        result,
        points: result === 'win' ? (eg.sides.get(pid) === 'slave' ? 3 : 1) : 0,
        scores: { you: eg.scores.get(pid), opp: eg.scores.get(oppId) },
        round: isGameOver ? eg.round : nextRound,
        turn: isGameOver ? eg.turn : nextTurn,
      });
    }
  }

  log('info', 'eg-reveal', {
    roomId: room.id, turn: eg.totalTurn,
    p1card: c1, p2card: c2, r1, r2,
  });

  eg.picks.clear();
  eg.totalTurn = nextTotalTurn;
  eg.turn = nextTurn;
  eg.round = nextRound;

  if (isGameOver) {
    // End the game
    eg.active = false;
    room.status = 'waiting';
    broadcastLobby();

    for (const pid of eg.players) {
      const oppId = eg.players.find(x => x !== pid);
      const myScore = eg.scores.get(pid);
      const oppScore = eg.scores.get(oppId);
      const winner = myScore > oppScore ? 'you' : myScore < oppScore ? 'opp' : 'tie';
      const pConn = room.players.get(pid);
      if (pConn) {
        send(pConn.ws, {
          type: 'eg-end',
          scores: { you: myScore, opp: oppScore },
          winner,
        });
      }
    }
    log('info', 'eg-end', { roomId: room.id, s1: eg.scores.get(p1), s2: eg.scores.get(p2) });
  } else if (isRoundOver) {
    // Swap sides and deal new hands after a short delay
    setTimeout(() => {
      for (const pid of eg.players) {
        eg.sides.set(pid, eg.sides.get(pid) === 'emperor' ? 'slave' : 'emperor');
        eg.hands.set(pid, buildEGameHand(eg.sides.get(pid)));
      }
      for (const pid of eg.players) {
        const pConn = room.players.get(pid);
        if (pConn) {
          send(pConn.ws, {
            type: 'eg-round-swap',
            side: eg.sides.get(pid),
            hand: eg.hands.get(pid),
            round: eg.round,
            turn: eg.turn,
          });
        }
      }
      log('info', 'eg-swap', { roomId: room.id, round: eg.round });
    }, 2000);
  }
}

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
  // Skip players with 0 cards (awaiting challenge window to close)
  let safety = br.turnOrder.length;
  while (safety-- > 0) {
    const pid = br.turnOrder[br.turnIdx];
    const hand = br.hands.get(pid);
    if (hand && hand.length === 0 && pid !== br.lastPlayerId) {
      br.turnIdx = (br.turnIdx + 1) % br.turnOrder.length;
    } else {
      break;
    }
  }
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

// ── UNO helpers ─────────────────────────────────────────────────
function buildUnoDeck() {
  const colors = ['red', 'yellow', 'green', 'blue'];
  const deck = [];
  for (const color of colors) {
    // One zero
    deck.push({ color, type: 'number', value: 0 });
    // Two each of 1-9
    for (let v = 1; v <= 9; v++) {
      deck.push({ color, type: 'number', value: v });
      deck.push({ color, type: 'number', value: v });
    }
    // Two each of Skip, Reverse, Draw Two
    for (let n = 0; n < 2; n++) {
      deck.push({ color, type: 'skip' });
      deck.push({ color, type: 'reverse' });
      deck.push({ color, type: 'draw_two' });
    }
  }
  // 4 Wild, 4 Wild Draw Four
  for (let n = 0; n < 4; n++) {
    deck.push({ color: null, type: 'wild' });
    deck.push({ color: null, type: 'wild_draw_four' });
  }
  return deck; // 108 cards
}

function shuffleDeck(deck) {
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
}

function unoIsPlayable(card, topCard, currentColor) {
  if (card.type === 'wild' || card.type === 'wild_draw_four') return true;
  if (card.color === currentColor) return true;
  if (card.type === 'number' && topCard.type === 'number' && card.value === topCard.value) return true;
  if (card.type !== 'number' && card.type === topCard.type) return true;
  return false;
}

function unoNextIdx(uno) {
  return ((uno.turnIdx + uno.direction) % uno.turnOrder.length + uno.turnOrder.length) % uno.turnOrder.length;
}

function unoAdvanceTurn(uno, skip) {
  uno.turnIdx = unoNextIdx(uno);
  if (skip && uno.turnOrder.length > 1) {
    uno.turnIdx = unoNextIdx(uno);
  }
  uno.drawnThisTurn = false;
}

function unoReshuffleDraw(uno) {
  if (uno.discardPile.length <= 1) return;
  const top = uno.discardPile.pop();
  uno.drawPile = [...uno.discardPile];
  uno.discardPile = [top];
  shuffleDeck(uno.drawPile);
}

function cardLabelServer(card) {
  if (!card) return '?';
  if (card.type === 'wild') return 'Wild';
  if (card.type === 'wild_draw_four') return 'Wild+4';
  const c = card.color || '';
  if (card.type === 'number') return `${c}${card.value}`;
  return `${c}_${card.type}`;
}

function unoCardPoints(card) {
  if (card.type === 'number') return card.value;
  if (card.type === 'skip' || card.type === 'reverse' || card.type === 'draw_two') return 20;
  if (card.type === 'wild' || card.type === 'wild_draw_four') return 50;
  return 0;
}

function startUno(room) {
  const deck = buildUnoDeck();
  shuffleDeck(deck);
  const playerIds = [...room.players.keys()];
  const hands = new Map();
  for (const pid of playerIds) hands.set(pid, []);
  // Deal 7 cards each
  for (let i = 0; i < 7; i++) {
    for (const pid of playerIds) {
      hands.get(pid).push(deck.pop());
    }
  }
  // Flip top card for discard pile — if Wild Draw Four, put back and retry
  let topCard = deck.pop();
  while (topCard.type === 'wild_draw_four') {
    deck.unshift(topCard);
    shuffleDeck(deck);
    topCard = deck.pop();
  }
  // If first card is Wild, set a random color
  let currentColor = topCard.color;
  if (topCard.type === 'wild') {
    currentColor = ['red','yellow','green','blue'][Math.floor(Math.random()*4)];
  }

  // Determine starting player
  const prevWinner = room.uno?.lastWinner;
  let startIdx = 0;
  if (prevWinner) {
    const wi = playerIds.indexOf(prevWinner);
    if (wi >= 0) startIdx = wi;
  }

  // Restore or init scores
  const scores = {};
  for (const pid of playerIds) {
    scores[pid] = room.uno?.scores?.[pid] || 0;
  }

  const roundNum = (room.uno?.roundNum || 0) + 1;

  room.uno = {
    deck: null, // not used — we use drawPile
    drawPile: deck,
    discardPile: [topCard],
    hands,
    topCard,
    currentColor,
    direction: 1,
    turnOrder: playerIds,
    turnIdx: startIdx,
    active: true,
    scores,
    roundNum,
    roundHistory: room.uno?.roundHistory || [],
    lastWinner: prevWinner || null,
    unoFlags: new Set(),
    disconnects: new Map(),
    drawnThisTurn: false,
    roundTimer: null,
  };

  // Handle first-card effects
  let skipFirst = false;
  if (topCard.type === 'skip') {
    skipFirst = true;
  } else if (topCard.type === 'reverse') {
    if (playerIds.length === 2) skipFirst = true;
    else room.uno.direction = -1;
  } else if (topCard.type === 'draw_two') {
    skipFirst = true;
    const firstPid = playerIds[startIdx];
    const firstHand = hands.get(firstPid);
    for (let d = 0; d < 2; d++) {
      if (room.uno.drawPile.length > 0) firstHand.push(room.uno.drawPile.pop());
    }
  }

  if (skipFirst) {
    unoAdvanceTurn(room.uno, false);
  }

  room.status = 'playing';
  broadcastLobby();

  // Build card counts
  const cardCounts = {};
  for (const pid of playerIds) cardCounts[pid] = hands.get(pid).length;

  // Send dealt hands to each player
  for (const [pid, p] of room.players) {
    send(p.ws, {
      type: 'uno-dealt',
      hand: hands.get(pid),
      topCard, currentColor: room.uno.currentColor,
      direction: room.uno.direction,
      drawPileCount: room.uno.drawPile.length,
      turnOrder: playerIds,
      cardCounts,
      scores,
    });
  }

  sendUnoTurn(room);
  log('info', 'uno-start', { roomId: room.id, players: playerIds.length, round: roundNum });
}

function sendUnoTurn(room) {
  const uno = room.uno;
  if (!uno || !uno.active || uno.turnOrder.length === 0) return;
  const currentTurnId = uno.turnOrder[uno.turnIdx];
  broadcastRoom(room.id, { type: 'uno-turn', currentTurn: currentTurnId });
}

function sendUnoFullState(room, toId) {
  const uno = room.uno;
  if (!uno) return;
  const playersList = [];
  for (const [pid,] of room.players) {
    const hand = uno.hands.get(pid);
    playersList.push({
      id: pid,
      name: room.players.get(pid)?.name || 'Player',
      cardCount: hand ? hand.length : 0,
      score: uno.scores[pid] || 0,
      unoFlag: uno.unoFlags.has(pid),
    });
  }
  const targetPlayer = room.players.get(toId);
  if (!targetPlayer) return;
  send(targetPlayer.ws, {
    type: 'uno-state',
    hand: uno.hands.get(toId) || [],
    topCard: uno.topCard,
    currentColor: uno.currentColor,
    direction: uno.direction,
    drawPileCount: uno.drawPile.length,
    turnOrder: uno.turnOrder,
    currentTurn: uno.turnOrder[uno.turnIdx],
    active: uno.active,
    players: playersList,
  });
}

function broadcastUnoPlayerUpdate(room) {
  const uno = room.uno;
  if (!uno) return;
  for (const [pid, p] of room.players) {
    const playersList = [];
    for (const [oid,] of room.players) {
      const hand = uno.hands.get(oid);
      playersList.push({
        id: oid,
        name: room.players.get(oid)?.name || 'Player',
        cardCount: hand ? hand.length : 0,
        score: uno.scores[oid] || 0,
        unoFlag: uno.unoFlags.has(oid),
      });
    }
    send(p.ws, { type: 'uno-state',
      hand: uno.hands.get(pid) || [],
      topCard: uno.topCard,
      currentColor: uno.currentColor,
      direction: uno.direction,
      drawPileCount: uno.drawPile.length,
      turnOrder: uno.turnOrder,
      currentTurn: uno.turnOrder[uno.turnIdx],
      active: uno.active,
      players: playersList,
    });
  }
}

function unoEndRound(room, winnerId) {
  const uno = room.uno;
  uno.active = false;

  // Calculate points from other players' hands
  let roundScore = 0;
  const playerHands = [];
  for (const [pid,] of room.players) {
    const hand = uno.hands.get(pid) || [];
    let pts = 0;
    for (const c of hand) pts += unoCardPoints(c);
    playerHands.push({
      id: pid,
      name: room.players.get(pid)?.name || 'Player',
      cards: hand,
      points: pts,
    });
    if (pid !== winnerId) roundScore += pts;
  }

  // Update scores
  uno.scores[winnerId] = (uno.scores[winnerId] || 0) + roundScore;
  uno.lastWinner = winnerId;

  // Record round history
  uno.roundHistory.push({
    round: uno.roundNum,
    winnerId, winnerName: room.players.get(winnerId)?.name || 'Player',
    points: roundScore,
    scores: { ...uno.scores },
  });

  const winnerName = room.players.get(winnerId)?.name || 'Player';

  // Check if someone hit 500
  let gameWinnerId = null;
  let gameWinnerScore = 0;
  for (const [pid, sc] of Object.entries(uno.scores)) {
    if (sc >= 500 && sc > gameWinnerScore) {
      gameWinnerId = pid;
      gameWinnerScore = sc;
    }
  }

  if (gameWinnerId) {
    // Game over!
    const gwName = room.players.get(gameWinnerId)?.name || 'Player';
    broadcastRoom(room.id, {
      type: 'uno-game-over',
      winnerId: gameWinnerId,
      winnerName: gwName,
      winnerScore: gameWinnerScore,
      finalScores: { ...uno.scores },
      roundHistory: uno.roundHistory,
    });
    room.status = 'waiting';
    uno.roundHistory = [];
    broadcastLobby();
    log('info', 'uno-game-over', { roomId: room.id, winner: gwName, score: gameWinnerScore });
    return;
  }

  // Broadcast round summary
  broadcastRoom(room.id, {
    type: 'uno-round-over',
    winnerId,
    winnerName,
    roundNum: uno.roundNum,
    roundScore,
    playerHands,
    scores: { ...uno.scores },
  });

  log('info', 'uno-round-over', { roomId: room.id, winner: winnerName, roundScore, round: uno.roundNum });

  // Auto-start next round after 10 seconds
  uno.roundTimer = setTimeout(() => {
    const r = rooms.get(room.id);
    if (!r || !r.uno) return;
    if (r.players.size < 2) return;
    startUno(r);
  }, 10000);
}

// ── Tank Battle helpers ──────────────────────────────────────────
const TANKS_WORLD_W = 1200, TANKS_WORLD_H = 600;
const TANKS_MOVE_BUDGET = 50;
const TANKS_TURN_TIME = 30000; // 30 seconds
const TANKS_MAX_HP = 200;

const TANKS_CRATE_TYPES = [
  { type: 'health',         weight: 30, icon: '\u2764\uFE0F',  label: 'Health Pack',      payload: { hp: 80 } },
  { type: 'ammo',           weight: 20, icon: '\uD83D\uDCE6',  label: 'Ammo Crate',       payload: { weapon: 'heavy', count: 3 } },
  { type: 'napalm',         weight: 15, icon: '\uD83D\uDD25',  label: 'Napalm Bomb',      payload: { weapon: 'napalm', count: 1 } },
  { type: 'bouncer',        weight: 15, icon: '\uD83E\uDEA3',  label: 'Bouncer Shell',    payload: { weapon: 'bouncer', count: 2 } },
  { type: 'chainlightning', weight: 12, icon: '\u26A1',         label: 'Chain Lightning',  payload: { weapon: 'chainlightning', count: 1 } },
  { type: 'meganuke',       weight:  8, icon: '\u2622\uFE0F',  label: 'Mega Nuke',        payload: { weapon: 'meganuke', count: 1 } },
];

function tanksRandomCrateType() {
  const total = TANKS_CRATE_TYPES.reduce((s, t) => s + t.weight, 0);
  let r = Math.floor(Math.random() * total);
  for (const ct of TANKS_CRATE_TYPES) { r -= ct.weight; if (r < 0) return ct; }
  return TANKS_CRATE_TYPES[0];
}

function tanksGenerateTerrain(w, h) {
  // Terrain as Uint8Array: 1 = solid, 0 = air
  const terrain = new Uint8Array(w * h);
  // Generate rolling hills using sine combinations
  const seed = Math.random;
  const freqs = [];
  for (let i = 0; i < 5; i++) freqs.push({ amp: 20 + seed() * 40, freq: 0.002 + seed() * 0.006, phase: seed() * Math.PI * 2 });

  for (let x = 0; x < w; x++) {
    let surfaceY = h * 0.5; // base height
    for (const f of freqs) surfaceY += f.amp * Math.sin(x * f.freq + f.phase);
    // Add a few platforms / valleys
    surfaceY += Math.sin(x * 0.015) * 30;
    surfaceY = Math.max(h * 0.25, Math.min(h * 0.85, surfaceY));
    const sy = Math.floor(surfaceY);
    for (let y = sy; y < h - 15; y++) { // Leave bottom 15px as water/void
      terrain[y * w + x] = 1;
    }
  }
  return terrain;
}

function tanksGetGroundY(terrain, w, h, x) {
  const ix = Math.max(0, Math.min(w - 1, Math.round(x)));
  for (let y = 0; y < h; y++) {
    if (terrain[y * w + ix]) return y;
  }
  return h; // fell into void
}

function tanksEncodeTerrain(terrain) {
  // Pack bits: 8 terrain pixels per byte, base64 encode
  const byteLen = Math.ceil(terrain.length / 8);
  const bytes = new Uint8Array(byteLen);
  for (let i = 0; i < terrain.length; i++) {
    if (terrain[i]) bytes[Math.floor(i / 8)] |= (1 << (7 - (i % 8)));
  }
  // Convert to base64
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return Buffer.from(binary, 'binary').toString('base64');
}

function startTanks(room) {
  const terrain = tanksGenerateTerrain(TANKS_WORLD_W, TANKS_WORLD_H);
  const playerIds = [...room.players.keys()];
  const tankState = {};
  const spacing = TANKS_WORLD_W / (playerIds.length + 1);

  for (let i = 0; i < playerIds.length; i++) {
    const pid = playerIds[i];
    const x = Math.floor(spacing * (i + 1));
    const y = tanksGetGroundY(terrain, TANKS_WORLD_W, TANKS_WORLD_H, x);
    tankState[pid] = {
      x, y, hp: TANKS_MAX_HP, alive: true, angle: 90, shielded: false,
      colorIdx: i,
      name: room.players.get(pid)?.name || 'Player',
      moveBudget: TANKS_MOVE_BUDGET,
      inventory: { heavy: 5, cluster: 3, sniper: 4, airstrike: 2, shield: 2, napalm: 0, bouncer: 0, chainlightning: 0, meganuke: 0 },
      damageDealt: 0,
    };
  }

  const wind = tanksRandomWind();
  const startIdx = Math.floor(Math.random() * playerIds.length);

  room.tanks = {
    terrain,
    terrainW: TANKS_WORLD_W,
    terrainH: TANKS_WORLD_H,
    tankState,
    turnOrder: playerIds,
    turnIdx: startIdx,
    wind,
    active: true,
    hasFired: false,
    turnTimer: null,
    crates: [],
    crateSeq: 0,
  };
  room.status = 'playing';
  broadcastLobby();

  const encodedTerrain = tanksEncodeTerrain(terrain);
  const tanksArr = playerIds.map(pid => {
    const t = tankState[pid];
    return { id: pid, x: t.x, y: t.y, hp: t.hp, name: t.name, colorIdx: t.colorIdx };
  });

  broadcastRoom(room.id, { type: 'tanks-start', terrain: encodedTerrain, tanks: tanksArr });
  log('info', 'tanks-start', { roomId: room.id, players: playerIds.length });

  // Start first turn after a brief delay
  setTimeout(() => tanksStartTurn(room), 1000);
}

function tanksRandomWind() {
  return (Math.random() - 0.5) * 20; // -10 to +10
}

function tanksStartTurn(room) {
  const tk = room.tanks;
  if (!tk || !tk.active) return;

  // Skip dead players
  let safety = tk.turnOrder.length;
  while (safety-- > 0) {
    const pid = tk.turnOrder[tk.turnIdx];
    if (tk.tankState[pid]?.alive) break;
    tk.turnIdx = (tk.turnIdx + 1) % tk.turnOrder.length;
  }

  const pid = tk.turnOrder[tk.turnIdx];
  const tank = tk.tankState[pid];
  if (!tank || !tank.alive) return;

  tk.wind = tanksRandomWind();
  tk.hasFired = false;
  tank.moveBudget = TANKS_MOVE_BUDGET;

  // Possibly drop a supply crate
  if (Math.random() < 0.45 && tk.crates.length < 4) {
    const crateX = Math.floor(Math.random() * (tk.terrainW - 120)) + 60;
    const landY = tanksGetGroundY(tk.terrain, tk.terrainW, tk.terrainH, crateX);
    if (landY < tk.terrainH - 15) {
      const crateId = `cr_${++tk.crateSeq}`;
      const ct = tanksRandomCrateType();
      tk.crates.push({ id: crateId, x: crateX, y: landY, type: ct.type, payload: ct.payload, icon: ct.icon, label: ct.label });
      broadcastRoom(room.id, { type: 'tanks-crate-spawn', id: crateId, x: crateX, landY, crateType: ct.type, icon: ct.icon, label: ct.label });
    }
  }

  broadcastRoom(room.id, {
    type: 'tanks-turn',
    playerId: pid,
    wind: tk.wind,
    moveBudget: TANKS_MOVE_BUDGET,
    timeLeft: 30,
  });

  // Turn timer
  if (tk.turnTimer) clearTimeout(tk.turnTimer);
  const roomId = room.id;
  tk.turnTimer = setTimeout(() => {
    const r = rooms.get(roomId);
    if (!r?.tanks?.active) return;
    broadcastRoom(roomId, { type: 'tanks-timeout', playerId: pid });
    tanksAdvanceTurn(r);
  }, TANKS_TURN_TIME);
}

function tanksAdvanceTurn(room) {
  const tk = room.tanks;
  if (!tk || !tk.active) return;
  tk.turnIdx = (tk.turnIdx + 1) % tk.turnOrder.length;
  // Brief delay before next turn
  setTimeout(() => tanksStartTurn(room), 1500);
}

function tanksCheckGameOver(room) {
  const tk = room.tanks;
  if (!tk || !tk.active) return false;
  const alive = tk.turnOrder.filter(pid => tk.tankState[pid]?.alive);
  if (alive.length <= 1) {
    tk.active = false;
    if (tk.turnTimer) { clearTimeout(tk.turnTimer); tk.turnTimer = null; }
    room.status = 'waiting';
    const winner = alive.length === 1 ? { id: alive[0], name: tk.tankState[alive[0]]?.name || 'Player' } : null;
    const summary = tk.turnOrder.map(pid => ({
      id: pid,
      name: tk.tankState[pid]?.name || 'Player',
      damageDealt: tk.tankState[pid]?.damageDealt || 0,
    }));
    broadcastRoom(room.id, { type: 'tanks-gameover', winner, summary });
    broadcastLobby();
    log('info', 'tanks-gameover', { roomId: room.id, winner: winner?.name });
    return true;
  }
  return false;
}

function tanksResolveShot(tk, shooterId, weapon, angle, power, airstrikeX) {
  const tank = tk.tankState[shooterId];
  const angleRad = angle * Math.PI / 180;
  const speed = power * 0.12;
  const vx = Math.cos(Math.PI - angleRad) * speed;
  const vy = -Math.sin(angleRad) * speed;
  const startX = tank.x;
  const startY = tank.y - 18; // barrel tip

  const result = {
    type: 'tanks-fire-result',
    playerId: shooterId,
    weapon,
    projectiles: [],
    impacts: [],
    terrainPatches: [],
    damages: [],
    tankUpdates: [],
    kills: [],
  };

  if (weapon === 'airstrike') {
    // 3 shells raining down at the chosen X with slight spread
    const baseX = typeof airstrikeX === 'number' ? Math.max(0, Math.min(tk.terrainW, airstrikeX)) : tk.terrainW / 2;
    for (let i = 0; i < 3; i++) {
      const dropX = baseX + (i - 1) * 30;
      const impactY = tanksGetGroundY(tk.terrain, tk.terrainW, tk.terrainH, dropX);
      const impX = Math.max(0, Math.min(tk.terrainW - 1, Math.round(dropX)));
      result.projectiles.push({
        startX: impX, startY: 0, vx: 0, vy: 5,
        impactX: impX, impactY: Math.min(impactY, tk.terrainH),
        weapon: 'airstrike', delay: i * 300,
      });
      if (impactY < tk.terrainH - 15) {
        tanksApplyExplosion(tk, result, impX, impactY, 20, 35, shooterId);
      }
    }
  } else if (weapon === 'sniper') {
    // Straight line, ignores wind, hits first tank or goes off-screen
    const dirX = Math.cos(Math.PI - angleRad);
    const dirY = -Math.sin(angleRad);
    let hitTank = null, hitDist = Infinity;
    for (const pid in tk.tankState) {
      if (pid === shooterId) continue;
      const other = tk.tankState[pid];
      if (!other.alive) continue;
      // Ray-box intersection
      const dx = other.x - startX, dy = (other.y - 12) - startY;
      const t_val = (dx * dirX + dy * dirY) / (dirX * dirX + dirY * dirY);
      if (t_val <= 0) continue;
      const closestX = startX + dirX * t_val, closestY = startY + dirY * t_val;
      const dist = Math.sqrt((closestX - other.x) ** 2 + (closestY - (other.y - 12)) ** 2);
      if (dist < 20 && t_val < hitDist) {
        hitTank = pid;
        hitDist = t_val;
      }
    }
    const impactX = hitTank ? tk.tankState[hitTank].x : startX + dirX * 1500;
    const impactY = hitTank ? tk.tankState[hitTank].y - 12 : startY + dirY * 1500;
    result.projectiles.push({
      startX, startY, vx: dirX * 15, vy: dirY * 15,
      impactX, impactY, isSniper: true, weapon: 'sniper',
    });
    if (hitTank) {
      tanksApplyDamage(tk, result, hitTank, 55, impactX, impactY, shooterId);
    }
  } else if (weapon === 'chainlightning') {
    // Instant zap — damages every other living tank; a fake projectile animates to each
    let delay = 0;
    for (const pid in tk.tankState) {
      if (pid === shooterId) continue;
      const other = tk.tankState[pid];
      if (!other.alive) continue;
      result.projectiles.push({
        startX: tank.x, startY: tank.y - 18,
        vx: 0, vy: 0,
        impactX: other.x, impactY: other.y - 12,
        isSniper: true, weapon: 'chainlightning', delay,
      });
      tanksApplyDamage(tk, result, pid, 40, other.x, other.y - 9, shooterId);
      result.impacts.push({ x: other.x, y: other.y - 9, radius: 14 });
      delay += 250;
    }
  } else {
    // Standard, heavy, cluster — parabolic arc
    const windEffect = tk.wind;
    let projX = startX, projY = startY;
    let projVx = vx, projVy = vy;
    const gravity = 0.15;
    let impactX = startX, impactY = startY;
    let maxSteps = 2000;

  while (maxSteps-- > 0) {
    projX += projVx;
    projY += projVy;
    projVy += gravity;
    projVx += windEffect * 0.002;

    // Out of bounds
    if (projX < -50 || projX > tk.terrainW + 50 || projY > tk.terrainH + 50) {
      impactX = projX; impactY = projY;
      break;
    }
    // Check terrain collision
    const ix = Math.round(projX), iy = Math.round(projY);
    if (ix >= 0 && ix < tk.terrainW && iy >= 0 && iy < tk.terrainH && tk.terrain[iy * tk.terrainW + ix]) {
      impactX = projX; impactY = projY;
      break;
    }
    // Check tank collision
    let hitTank = false;
    for (const pid in tk.tankState) {
      if (pid === shooterId) continue;
      const other = tk.tankState[pid];
      if (!other.alive) continue;
      const dx = projX - other.x, dy = projY - (other.y - 9);
      if (Math.sqrt(dx * dx + dy * dy) < 18) {
        impactX = projX; impactY = projY;
        hitTank = true;
        break;
      }
    }
    if (hitTank) break;
  }

  result.projectiles.push({
    startX, startY, vx, vy,
    impactX, impactY, weapon,
  });

  if (weapon === 'cluster') {
    // Explodes mid-flight or at impact, then scatters 5 bomblets
    tanksApplyExplosion(tk, result, impactX, impactY, 10, 10, shooterId);
    for (let i = 0; i < 5; i++) {
      const bAngle = (Math.PI * 2 / 5) * i + (Math.random() - 0.5) * 0.3;
      const bSpeed = 2 + Math.random() * 2;
      let bx = impactX, by = impactY;
      let bvx = Math.cos(bAngle) * bSpeed;
      let bvy = -Math.abs(Math.sin(bAngle)) * bSpeed - 1;
      let steps = 300;
      while (steps-- > 0) {
        bx += bvx; by += bvy; bvy += gravity;
        if (bx < 0 || bx >= tk.terrainW || by > tk.terrainH) break;
        const bix = Math.round(bx), biy = Math.round(by);
        if (bix >= 0 && bix < tk.terrainW && biy >= 0 && biy < tk.terrainH && tk.terrain[biy * tk.terrainW + bix]) break;
      }
      result.projectiles.push({ startX: impactX, startY: impactY, vx: bvx, vy: bvy, impactX: bx, impactY: by, weapon: 'cluster-sub', delay: 200 + i * 100 });
      if (by < tk.terrainH - 15) tanksApplyExplosion(tk, result, bx, by, 12, 20, shooterId);
    }
  } else if (weapon === 'heavy') {
    tanksApplyExplosion(tk, result, impactX, impactY, 38, 70, shooterId);
  } else if (weapon === 'napalm') {
    // Wide central blast + horizontal fire spread
    tanksApplyExplosion(tk, result, impactX, impactY, 48, 60, shooterId);
    for (const ox of [-50, -28, 28, 50]) {
      const sx = impactX + ox, sy = tanksGetGroundY(tk.terrain, tk.terrainW, tk.terrainH, sx);
      if (sy < tk.terrainH - 15) tanksApplyExplosion(tk, result, sx, sy, 22, 30, shooterId);
    }
  } else if (weapon === 'bouncer') {
    // Simulate bouncing trajectory — up to 3 bounces before final explosion
    let bpx = startX, bpy = startY, bvx2 = vx, bvy2 = vy;
    let bounces = 0;
    let bSteps = 3000;
    while (bSteps-- > 0) {
      bpx += bvx2; bpy += bvy2; bvy2 += gravity; bvx2 += windEffect * 0.002;
      if (bpx < 0 || bpx > tk.terrainW || bpy > tk.terrainH + 50) break;
      const bix = Math.round(bpx), biy = Math.round(bpy);
      if (biy >= 0 && bix >= 0 && bix < tk.terrainW && biy < tk.terrainH && tk.terrain[biy * tk.terrainW + bix]) {
        if (bounces >= 3) break;
        bvy2 = -Math.abs(bvy2) * 0.55; bvx2 *= 0.8; bpy -= 3; bounces++;
      }
    }
    // Update impactX/Y to final bounce landing
    impactX = bpx; impactY = bpy;
    result.projectiles[result.projectiles.length - 1].impactX = impactX;
    result.projectiles[result.projectiles.length - 1].impactY = impactY;
    tanksApplyExplosion(tk, result, impactX, impactY, 25, 40, shooterId);
  } else if (weapon === 'meganuke') {
    tanksApplyExplosion(tk, result, impactX, impactY, 70, 95, shooterId);
  } else {
    // standard
    tanksApplyExplosion(tk, result, impactX, impactY, 22, 38, shooterId);
  }
  } // end else (parabolic weapons)

  // Always settle all tanks after any weapon resolves
  for (const pid in tk.tankState) {
    const t = tk.tankState[pid];
    if (t.alive) {
      // Apply gravity — settle onto terrain or fall into void
      const newY = tanksGetGroundY(tk.terrain, tk.terrainW, tk.terrainH, t.x);
      if (newY >= tk.terrainH - 15) {
        t.hp = 0; t.alive = false;
        t.y = tk.terrainH;
        result.kills.push({ id: pid, name: t.name, x: t.x, y: t.y });
      } else {
        t.y = newY;
      }
    }
    // Push every tank (alive or dead) so the client always gets the authoritative HP
    result.tankUpdates.push({ id: pid, x: t.x, y: t.y, hp: t.hp, alive: t.alive, shielded: t.shielded });
  }

  return result;
}

function tanksApplyExplosion(tk, result, cx, cy, radius, damage, shooterId) {
  // Carve terrain
  const r = Math.round(radius);
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      if (dx * dx + dy * dy <= r * r) {
        const px = Math.round(cx) + dx, py = Math.round(cy) + dy;
        if (px >= 0 && px < tk.terrainW && py >= 0 && py < tk.terrainH) {
          tk.terrain[py * tk.terrainW + px] = 0;
        }
      }
    }
  }
  result.impacts.push({ x: Math.round(cx), y: Math.round(cy), radius: r });
  result.terrainPatches.push({ x: Math.round(cx), y: Math.round(cy), radius: r });

  // Damage tanks in blast radius
  for (const pid in tk.tankState) {
    const t = tk.tankState[pid];
    if (!t.alive) continue;
    const dx = t.x - cx, dy = (t.y - 9) - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < radius + 15) {
      const falloff = Math.max(0, 1 - dist / (radius + 15));
      const dmg = Math.round(damage * falloff);
      if (dmg > 0) {
        tanksApplyDamage(tk, result, pid, dmg, t.x, t.y - 9, shooterId);
        // Knockback
        if (dist > 0) {
          const kb = falloff * 8;
          t.x += (dx / dist) * kb;
          t.x = Math.max(5, Math.min(tk.terrainW - 5, t.x));
        }
      }
    }
  }
}

function tanksApplyDamage(tk, result, targetId, damage, hitX, hitY, shooterId) {
  const t = tk.tankState[targetId];
  if (!t || !t.alive) return;

  if (t.shielded) {
    t.shielded = false;
    result.damages.push({ id: targetId, damage: 0, x: hitX, y: hitY, shieldBlocked: true });
    return;
  }

  t.hp -= damage;
  if (shooterId && tk.tankState[shooterId]) {
    tk.tankState[shooterId].damageDealt += damage;
  }
  result.damages.push({ id: targetId, damage, x: hitX, y: hitY });

  if (t.hp <= 0) {
    t.hp = 0;
    t.alive = false;
    result.kills.push({ id: targetId, name: t.name, x: t.x, y: t.y });
  }
}

// ═══════════════════════════════════════════════════════════════════
//  BOMBERMAN HELPERS
// ═══════════════════════════════════════════════════════════════════

const BM_COLS = 15, BM_ROWS = 13;
const BM_TICK_MS = 50; // 20 ticks/sec
const BM_BOMB_FUSE = 3000;
const BM_EXPLOSION_DURATION = 500;
const BM_ROUND_TIME = 120000; // 2 minutes
const BM_SHRINK_INTERVAL = 3000;
const BM_COUNTDOWN = 3000;
const BM_BETWEEN_ROUNDS = 5000;
const BM_WINS_NEEDED = 3;
const BM_CELL_SIZE = 48;
const BM_POWERUP_TYPES = ['extra-bomb','blast-up','speed-up','vest','punch','remote','skull'];
const BM_POWERUP_CHANCE = 0.40;
const BM_CURSE_DURATION = 10000;
const BM_CURSE_TYPES = ['reverse','speed','auto-bomb','slow'];
const BM_SPAWN_CORNERS = [[0,0],[BM_COLS-1,0],[0,BM_ROWS-1],[BM_COLS-1,BM_ROWS-1]];
const BM_SPEED_BASE = 8; // cells/sec at base
const BM_SPEED_INCREMENT = 2;

function bmGenerateArena() {
  // 0=floor, 1=hard, 2=soft
  const grid = [];
  for (let y = 0; y < BM_ROWS; y++) {
    const row = [];
    for (let x = 0; x < BM_COLS; x++) {
      if (x % 2 === 1 && y % 2 === 1) row.push(1); // hard wall checkerboard
      else row.push(0);
    }
    grid.push(row);
  }
  // Clear spawn corners (2-cell corridors)
  for (const [cx, cy] of BM_SPAWN_CORNERS) {
    grid[cy][cx] = 0;
    if (cx + 1 < BM_COLS) grid[cy][cx + 1] = 0;
    if (cx - 1 >= 0) grid[cy][cx - 1] = 0;
    if (cy + 1 < BM_ROWS) grid[cy + 1][cx] = 0;
    if (cy - 1 >= 0) grid[cy - 1][cx] = 0;
  }
  // Place soft walls (~65% of remaining floor cells)
  const softPowerups = {};
  for (let y = 0; y < BM_ROWS; y++) {
    for (let x = 0; x < BM_COLS; x++) {
      if (grid[y][x] !== 0) continue;
      // Don't place on spawn corners
      let isSpawn = false;
      for (const [sx, sy] of BM_SPAWN_CORNERS) {
        if (Math.abs(x - sx) + Math.abs(y - sy) <= 2) { isSpawn = true; break; }
      }
      if (isSpawn) continue;
      if (Math.random() < 0.65) {
        grid[y][x] = 2;
        // assign powerup underneath
        if (Math.random() < BM_POWERUP_CHANCE) {
          const ptype = BM_POWERUP_TYPES[Math.floor(Math.random() * BM_POWERUP_TYPES.length)];
          softPowerups[y + ',' + x] = ptype;
        }
      }
    }
  }
  return { grid, softPowerups };
}

function bmStartMatch(room) {
  const playerIds = [...room.players.keys()];
  const { grid, softPowerups } = bmGenerateArena();
  const players = {};
  playerIds.forEach((pid, i) => {
    const [sx, sy] = BM_SPAWN_CORNERS[i % 4];
    players[pid] = {
      x: sx, y: sy, alive: true, disconnected: false,
      bombMax: 1, bombRadius: 2, speedLevel: 0,
      vest: false, ability: null, // 'punch' or 'remote'
      curse: null, curseUntil: 0,
      name: room.players.get(pid).name, colorIdx: i,
      moving: false, moveDir: null,
      moveProgress: 0, // 0-1 fractional progress
      facingDir: 'down',
    };
  });

  room.bomberman = {
    active: true, grid: grid.map(r => [...r]),
    softPowerups, powerupsOnFloor: {},
    players, bombs: [], explosions: [],
    roundWins: {},
    currentRound: 1, shrinking: false, shrinkRing: 0,
    roundStartedAt: 0, roundActive: false,
    tickInterval: null,
    nextBombId: 1,
  };
  for (const pid of playerIds) room.bomberman.roundWins[pid] = 0;
  room.status = 'playing';
  broadcastLobby();

  // Send start countdown
  const playersInfo = playerIds.map(pid => ({ id: pid, name: players[pid].name, colorIdx: players[pid].colorIdx }));
  broadcastRoom(room.id, { type: 'bm-match-start', grid, playersInfo, roundWins: room.bomberman.roundWins });

  // Start round after countdown
  setTimeout(() => {
    if (!room.bomberman?.active) return;
    bmStartRound(room);
  }, BM_COUNTDOWN);
}

function bmStartRound(room) {
  const bm = room.bomberman;
  if (!bm.active) return;
  // Regenerate arena for new rounds (round 1 already generated)
  if (bm.currentRound > 1) {
    const { grid, softPowerups } = bmGenerateArena();
    bm.grid = grid;
    bm.softPowerups = softPowerups;
  }
  bm.powerupsOnFloor = {};
  bm.bombs = [];
  bm.explosions = [];
  bm.shrinking = false;
  bm.shrinkRing = 0;
  bm.roundStartedAt = Date.now();
  bm.roundActive = true;

  const playerIds = Object.keys(bm.players);
  playerIds.forEach((pid, i) => {
    const [sx, sy] = BM_SPAWN_CORNERS[i % 4];
    const ps = bm.players[pid];
    ps.x = sx; ps.y = sy; ps.alive = true;
    ps.bombMax = 1; ps.bombRadius = 2; ps.speedLevel = 0;
    ps.vest = false; ps.ability = null;
    ps.curse = null; ps.curseUntil = 0;
    ps.moving = false; ps.moveDir = null; ps.moveProgress = 0;
    ps.facingDir = 'down';
  });

  broadcastRoom(room.id, {
    type: 'bm-round-start', round: bm.currentRound,
    grid: bm.grid, players: bmSerializePlayers(bm),
  });

  // Start tick loop
  if (bm.tickInterval) clearInterval(bm.tickInterval);
  bm.tickInterval = setInterval(() => bmTick(room), BM_TICK_MS);
}

function bmSerializePlayers(bm) {
  const out = {};
  for (const [pid, ps] of Object.entries(bm.players)) {
    out[pid] = {
      x: ps.x, y: ps.y, alive: ps.alive,
      bombMax: ps.bombMax, bombRadius: ps.bombRadius,
      speedLevel: ps.speedLevel, vest: ps.vest,
      ability: ps.ability, curse: ps.curse,
      name: ps.name, colorIdx: ps.colorIdx,
      moving: ps.moving, moveDir: ps.moveDir,
      moveProgress: ps.moveProgress,
      facingDir: ps.facingDir,
    };
  }
  return out;
}

function bmTick(room) {
  const bm = room.bomberman;
  if (!bm || !bm.active || !bm.roundActive) return;
  const now = Date.now();
  const dt = BM_TICK_MS / 1000; // seconds
  const events = [];

  // ── Move players ──
  for (const [pid, ps] of Object.entries(bm.players)) {
    if (!ps.alive || !ps.moving || !ps.moveDir) continue;
    const speed = BM_SPEED_BASE + ps.speedLevel * BM_SPEED_INCREMENT;
    let dir = ps.moveDir;
    // Curse: reverse controls
    if (ps.curse === 'reverse' && ps.curseUntil > now) {
      dir = dir === 'up' ? 'down' : dir === 'down' ? 'up' : dir === 'left' ? 'right' : 'left';
    }
    // Curse: slow
    let effectiveSpeed = speed;
    if (ps.curse === 'slow' && ps.curseUntil > now) effectiveSpeed = speed * 0.4;
    if (ps.curse === 'speed' && ps.curseUntil > now) effectiveSpeed = speed * 2.5;

    ps.facingDir = dir;
    const progress = dt * effectiveSpeed;
    ps.moveProgress += progress;

    while (ps.moveProgress >= 1) {
      ps.moveProgress -= 1;
      let nx = ps.x, ny = ps.y;
      if (dir === 'up') ny--;
      else if (dir === 'down') ny++;
      else if (dir === 'left') nx--;
      else if (dir === 'right') nx++;

      if (nx < 0 || nx >= BM_COLS || ny < 0 || ny >= BM_ROWS || bm.grid[ny][nx] !== 0) {
        ps.moveProgress = 0;
        break;
      }
      // Check for bomb blocking (can't walk through bombs unless just placed)
      let bombBlock = false;
      for (const b of bm.bombs) {
        if (b.x === nx && b.y === ny && !(b.x === ps.x && b.y === ps.y)) { bombBlock = true; break; }
      }
      if (bombBlock) { ps.moveProgress = 0; break; }
      ps.x = nx; ps.y = ny;

      // Pickup powerup
      const key = ny + ',' + nx;
      if (bm.powerupsOnFloor[key]) {
        const ptype = bm.powerupsOnFloor[key];
        delete bm.powerupsOnFloor[key];
        bmApplyPowerup(ps, ptype, now);
        events.push({ type: 'bm-powerup-collected', playerId: pid, ptype, x: nx, y: ny });
      }
    }

    // Curse: auto-bomb
    if (ps.curse === 'auto-bomb' && ps.curseUntil > now) {
      bmPlaceBomb(room, pid);
    }
    // Clear expired curses
    if (ps.curse && ps.curseUntil <= now) {
      ps.curse = null;
      ps.curseUntil = 0;
    }
  }

  // ── Update bombs ──
  const toDetonate = [];
  for (const b of bm.bombs) {
    if (!b.remote && now >= b.detonateAt) toDetonate.push(b);
  }
  for (const b of toDetonate) bmDetonateBomb(room, b, events, now);

  // ── Expire explosions ──
  bm.explosions = bm.explosions.filter(e => now < e.expiresAt);

  // ── Check shrink timer (2 min) ──
  const elapsed = now - bm.roundStartedAt;
  if (elapsed >= BM_ROUND_TIME && !bm.shrinking) {
    bm.shrinking = true;
    bm.shrinkRing = 0;
    bm.lastShrinkAt = now;
    events.push({ type: 'bm-shrink-warning' });
  }
  if (bm.shrinking && now - (bm.lastShrinkAt || now) >= BM_SHRINK_INTERVAL) {
    bm.lastShrinkAt = now;
    bmShrinkRing(room, events, now);
  }

  // ── Broadcast state ──
  const state = {
    type: 'bm-state',
    players: bmSerializePlayers(bm),
    bombs: bm.bombs.map(b => ({ id: b.id, x: b.x, y: b.y, remote: b.remote, ownerId: b.ownerId, detonateAt: b.detonateAt })),
    explosions: bm.explosions.map(e => ({ cells: e.cells, expiresAt: e.expiresAt })),
    powerups: bm.powerupsOnFloor,
    elapsed: elapsed,
    shrinking: bm.shrinking,
    shrinkRing: bm.shrinkRing,
    events,
  };
  broadcastRoom(room.id, state);

  // ── Check round over ──
  bmCheckRoundEnd(room);
}

function bmPlaceBomb(room, pid) {
  const bm = room.bomberman;
  const ps = bm.players[pid];
  if (!ps || !ps.alive) return;
  // Count active bombs for this player
  const activeBombs = bm.bombs.filter(b => b.ownerId === pid).length;
  if (activeBombs >= ps.bombMax) return;
  // Check no bomb already at this cell
  if (bm.bombs.some(b => b.x === ps.x && b.y === ps.y)) return;
  const bomb = {
    id: bm.nextBombId++, x: ps.x, y: ps.y, ownerId: pid,
    radius: ps.bombRadius,
    remote: ps.ability === 'remote',
    detonateAt: ps.ability === 'remote' ? Infinity : Date.now() + BM_BOMB_FUSE,
  };
  bm.bombs.push(bomb);
}

function bmUseAbility(room, pid) {
  const bm = room.bomberman;
  const ps = bm.players[pid];
  if (!ps || !ps.alive) return;
  if (ps.ability === 'remote') {
    // Detonate all remote bombs
    const events = [];
    const myBombs = bm.bombs.filter(b => b.ownerId === pid && b.remote);
    for (const b of myBombs) bmDetonateBomb(room, b, events, Date.now());
    if (events.length > 0) broadcastRoom(room.id, { type: 'bm-remote-detonate', events });
  } else if (ps.ability === 'punch') {
    // Punch bomb in facing direction
    const dx = ps.facingDir === 'left' ? -1 : ps.facingDir === 'right' ? 1 : 0;
    const dy = ps.facingDir === 'up' ? -1 : ps.facingDir === 'down' ? 1 : 0;
    // Find bomb at current cell or adjacent in facing direction
    const nx = ps.x + dx, ny = ps.y + dy;
    let punchBomb = bm.bombs.find(b => b.x === ps.x && b.y === ps.y);
    if (!punchBomb) punchBomb = bm.bombs.find(b => b.x === nx && b.y === ny);
    if (punchBomb) {
      // Slide the bomb
      let bx = punchBomb.x, by = punchBomb.y;
      while (true) {
        const tx = bx + dx, ty = by + dy;
        if (tx < 0 || tx >= BM_COLS || ty < 0 || ty >= BM_ROWS || bm.grid[ty][tx] !== 0) break;
        if (bm.bombs.some(b => b !== punchBomb && b.x === tx && b.y === ty)) break;
        bx = tx; by = ty;
      }
      punchBomb.x = bx; punchBomb.y = by;
    }
  }
}

function bmDetonateBomb(room, bomb, events, now) {
  const bm = room.bomberman;
  const idx = bm.bombs.indexOf(bomb);
  if (idx === -1) return;
  bm.bombs.splice(idx, 1);

  const cells = [{ x: bomb.x, y: bomb.y }]; // center
  const dirs = [[0,-1],[0,1],[-1,0],[1,0]];
  for (const [dx, dy] of dirs) {
    for (let i = 1; i <= bomb.radius; i++) {
      const nx = bomb.x + dx * i, ny = bomb.y + dy * i;
      if (nx < 0 || nx >= BM_COLS || ny < 0 || ny >= BM_ROWS) break;
      if (bm.grid[ny][nx] === 1) break; // hard wall
      cells.push({ x: nx, y: ny });
      if (bm.grid[ny][nx] === 2) {
        // Destroy soft wall
        bm.grid[ny][nx] = 0;
        events.push({ type: 'bm-wall-destroyed', x: nx, y: ny });
        // Reveal powerup
        const key = ny + ',' + nx;
        if (bm.softPowerups[key]) {
          bm.powerupsOnFloor[key] = bm.softPowerups[key];
          delete bm.softPowerups[key];
          events.push({ type: 'bm-powerup-revealed', x: nx, y: ny, ptype: bm.powerupsOnFloor[key] });
        }
        break; // Stop blast at first soft wall
      }
    }
  }

  bm.explosions.push({ cells, expiresAt: now + BM_EXPLOSION_DURATION });

  // Check chain reaction — detonate any bombs in blast
  const chainBombs = bm.bombs.filter(b => cells.some(c => c.x === b.x && c.y === b.y));
  for (const cb of chainBombs) bmDetonateBomb(room, cb, events, now);

  // Check player damage
  for (const [pid, ps] of Object.entries(bm.players)) {
    if (!ps.alive) continue;
    if (cells.some(c => c.x === ps.x && c.y === ps.y)) {
      if (ps.vest) {
        ps.vest = false;
        events.push({ type: 'bm-vest-break', playerId: pid });
      } else {
        ps.alive = false;
        events.push({ type: 'bm-player-eliminated', playerId: pid, name: ps.name });
      }
    }
  }
}

function bmApplyPowerup(ps, ptype, now) {
  switch (ptype) {
    case 'extra-bomb': ps.bombMax++; break;
    case 'blast-up': ps.bombRadius = Math.min(8, ps.bombRadius + 1); break;
    case 'speed-up': ps.speedLevel = Math.min(3, ps.speedLevel + 1); break;
    case 'vest': ps.vest = true; break;
    case 'punch': ps.ability = 'punch'; break;
    case 'remote': ps.ability = 'remote'; break;
    case 'skull':
      ps.curse = BM_CURSE_TYPES[Math.floor(Math.random() * BM_CURSE_TYPES.length)];
      ps.curseUntil = now + BM_CURSE_DURATION;
      break;
  }
}

function bmShrinkRing(room, events, now) {
  const bm = room.bomberman;
  bm.shrinkRing++;
  const ring = bm.shrinkRing - 1;
  // Fill in edges ring by ring
  for (let x = ring; x < BM_COLS - ring; x++) {
    for (const y of [ring, BM_ROWS - 1 - ring]) {
      if (y >= 0 && y < BM_ROWS && x >= 0 && x < BM_COLS && bm.grid[y][x] !== 1) {
        bm.grid[y][x] = 1; // becomes hard wall
        // Kill any player standing here
        for (const [pid, ps] of Object.entries(bm.players)) {
          if (ps.alive && ps.x === x && ps.y === y) {
            ps.alive = false;
            events.push({ type: 'bm-player-eliminated', playerId: pid, name: ps.name });
          }
        }
      }
    }
  }
  for (let y = ring; y < BM_ROWS - ring; y++) {
    for (const x of [ring, BM_COLS - 1 - ring]) {
      if (y >= 0 && y < BM_ROWS && x >= 0 && x < BM_COLS && bm.grid[y][x] !== 1) {
        bm.grid[y][x] = 1;
        for (const [pid, ps] of Object.entries(bm.players)) {
          if (ps.alive && ps.x === x && ps.y === y) {
            ps.alive = false;
            events.push({ type: 'bm-player-eliminated', playerId: pid, name: ps.name });
          }
        }
      }
    }
  }
  events.push({ type: 'bm-shrink', ring: bm.shrinkRing, grid: bm.grid });
}

function bmCheckRoundEnd(room) {
  const bm = room.bomberman;
  if (!bm || !bm.active || !bm.roundActive) return;
  const alive = Object.entries(bm.players).filter(([, ps]) => ps.alive && !ps.disconnected);
  if (alive.length > 1) return;

  bm.roundActive = false;
  if (bm.tickInterval) { clearInterval(bm.tickInterval); bm.tickInterval = null; }

  const winnerId = alive.length === 1 ? alive[0][0] : null;
  if (winnerId) bm.roundWins[winnerId] = (bm.roundWins[winnerId] || 0) + 1;

  broadcastRoom(room.id, {
    type: 'bm-round-over',
    winnerId, winnerName: winnerId ? bm.players[winnerId].name : null,
    roundWins: bm.roundWins, round: bm.currentRound,
  });

  // Check match over
  if (winnerId && bm.roundWins[winnerId] >= BM_WINS_NEEDED) {
    setTimeout(() => {
      if (!room.bomberman?.active) return;
      room.bomberman.active = false;
      room.status = 'waiting';
      broadcastRoom(room.id, {
        type: 'bm-match-over',
        winnerId, winnerName: bm.players[winnerId].name,
        roundWins: bm.roundWins,
      });
      broadcastLobby();
    }, BM_BETWEEN_ROUNDS);
  } else {
    // Next round
    bm.currentRound++;
    setTimeout(() => {
      if (!room.bomberman?.active) return;
      bmStartRound(room);
    }, BM_BETWEEN_ROUNDS);
  }
}


// ═══════════════════════════════════════════════════════════════════
//  MINESWEEPER HELPERS
// ═══════════════════════════════════════════════════════════════════

function msStartGame(room, size, density, timeLimit) {
  const totalCells = size * size;
  const mineCount = Math.floor(totalCells * density / 100);
  const board = [];
  for (let r = 0; r < size; r++) {
    const row = [];
    for (let c = 0; c < size; c++) {
      row.push({ mine: false, adjacent: 0, revealed: false, revealedBy: null, flaggedBy: null, trap: null, decoy: null });
    }
    board.push(row);
  }
  // Mines placed after first click
  const players = {};
  let colorIdx = 0;
  for (const [pid, p] of room.players) {
    players[pid] = {
      name: p.name, colorIdx: colorIdx++,
      score: 0, flags: 10, charges: 0,
      stunUntil: 0, shield: false, frenzy: false, frenzyUntil: 0,
      targeting: null, pointsAccum: 0,
    };
  }

  room.minesweeper = {
    active: true, board, size, mineCount, density,
    minesPlaced: false, players,
    totalSafe: totalCells - mineCount,
    revealedCount: 0,
    timeLimit: timeLimit * 60 * 1000,
    startedAt: Date.now(),
    timer: null,
  };
  room.status = 'playing';
  broadcastLobby();

  const playersInfo = {};
  for (const [pid, ps] of Object.entries(players)) {
    playersInfo[pid] = { name: ps.name, colorIdx: ps.colorIdx, score: 0, flags: 10, charges: 0 };
  }
  broadcastRoom(room.id, {
    type: 'ms-start', size, mineCount, density,
    players: playersInfo, timeLimit: room.minesweeper.timeLimit,
  });

  // Set time limit
  room.minesweeper.timer = setTimeout(() => msEndGame(room), room.minesweeper.timeLimit);
  log('info', 'ms-start', { roomId: room.id, size, density, timeLimit, players: Object.keys(players).length });
}

function msPlaceMines(ms, safeR, safeC) {
  const positions = [];
  for (let r = 0; r < ms.size; r++) {
    for (let c = 0; c < ms.size; c++) {
      if (Math.abs(r - safeR) <= 1 && Math.abs(c - safeC) <= 1) continue;
      positions.push([r, c]);
    }
  }
  // Shuffle and pick
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  const count = Math.min(ms.mineCount, positions.length);
  for (let i = 0; i < count; i++) {
    const [r, c] = positions[i];
    ms.board[r][c].mine = true;
  }
  // Calculate adjacency
  for (let r = 0; r < ms.size; r++) {
    for (let c = 0; c < ms.size; c++) {
      if (ms.board[r][c].mine) continue;
      let adj = 0;
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          const nr = r + dr, nc = c + dc;
          if (nr >= 0 && nr < ms.size && nc >= 0 && nc < ms.size && ms.board[nr][nc].mine) adj++;
        }
      }
      ms.board[r][c].adjacent = adj;
    }
  }
  ms.minesPlaced = true;
}

function msRevealCell(room, pid, r, c) {
  const ms = room.minesweeper;
  const msp = ms.players[pid];
  if (!msp) return;
  const now = Date.now();
  if (msp.stunUntil > now) return;
  const cell = ms.board[r][c];
  if (cell.revealed) return;
  if (cell.flaggedBy) return;

  if (!ms.minesPlaced) msPlaceMines(ms, r, c);

  // Check for decoy trap
  if (cell.decoy && cell.decoy !== pid) {
    cell.decoy = null;
    msp.stunUntil = now + 4000;
    broadcastRoom(room.id, { type: 'ms-trap-triggered', playerId: pid, row: r, col: c, stunUntil: msp.stunUntil });
    return;
  }

  // Check for planted trap on revealed cell
  if (cell.trap && cell.trap !== pid && cell.revealed) {
    cell.trap = null;
    msp.stunUntil = now + 4000;
    broadcastRoom(room.id, { type: 'ms-trap-triggered', playerId: pid, row: r, col: c, stunUntil: msp.stunUntil });
    return;
  }

  if (cell.mine) {
    // Hit mine
    msp.score -= 5;
    msp.stunUntil = now + (msp.frenzy && msp.frenzyUntil > now ? 0 : (msp.shield ? 0 : 4000));
    if (msp.shield) {
      msp.shield = false;
      msp.stunUntil = 0;
    }
    cell.revealed = true;
    cell.revealedBy = pid;
    broadcastRoom(room.id, {
      type: 'ms-mine-hit', playerId: pid, row: r, col: c,
      score: msp.score, stunUntil: msp.stunUntil,
    });
    msCheckEnd(room);
    return;
  }

  // Safe cell — flood fill if 0
  const revealed = [];
  const stack = [[r, c]];
  while (stack.length > 0) {
    const [cr, cc] = stack.pop();
    if (cr < 0 || cr >= ms.size || cc < 0 || cc >= ms.size) continue;
    const cl = ms.board[cr][cc];
    if (cl.revealed || cl.mine || cl.flaggedBy) continue;
    cl.revealed = true;
    cl.revealedBy = pid;
    ms.revealedCount++;
    msp.score++;
    msp.pointsAccum++;
    revealed.push({ row: cr, col: cc, adjacent: cl.adjacent });
    if (cl.adjacent === 0) {
      for (let dr = -1; dr <= 1; dr++) {
        for (let dc = -1; dc <= 1; dc++) {
          if (dr === 0 && dc === 0) continue;
          stack.push([cr + dr, cc + dc]);
        }
      }
    }
  }

  // Award charges: 1 per 10 points accumulated
  while (msp.pointsAccum >= 10) {
    msp.pointsAccum -= 10;
    if (msp.charges < 3) msp.charges++;
  }

  broadcastRoom(room.id, {
    type: 'ms-revealed', playerId: pid, cells: revealed,
    score: msp.score, charges: msp.charges,
  });

  msCheckEnd(room);
}

function msApplyInstantPowerup(room, pid, ptype) {
  const ms = room.minesweeper;
  const msp = ms.players[pid];
  if (msp.charges <= 0) return;
  msp.charges--;

  if (ptype === 'shield') {
    msp.shield = true;
    const p = room.players.get(pid);
    if (p) send(p.ws, { type: 'ms-powerup-applied', powerup: 'shield', charges: msp.charges });
  } else if (ptype === 'scanner') {
    // Reveal 3 random mine locations to this player only
    const mines = [];
    for (let r = 0; r < ms.size; r++) {
      for (let c = 0; c < ms.size; c++) {
        if (ms.board[r][c].mine && !ms.board[r][c].revealed) mines.push({ row: r, col: c });
      }
    }
    // Shuffle and take 3
    for (let i = mines.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [mines[i], mines[j]] = [mines[j], mines[i]];
    }
    const revealed = mines.slice(0, 3);
    const p = room.players.get(pid);
    if (p) send(p.ws, { type: 'ms-scanner', mines: revealed, duration: 5000, charges: msp.charges });
  } else if (ptype === 'frenzy') {
    msp.frenzy = true;
    msp.frenzyUntil = Date.now() + 6000;
    msp.shield = true; // frenzy includes stun immunity
    const p = room.players.get(pid);
    if (p) send(p.ws, { type: 'ms-frenzy', until: msp.frenzyUntil, charges: msp.charges });
    broadcastRoom(room.id, { type: 'ms-player-frenzy', playerId: pid, until: msp.frenzyUntil });
  }

  broadcastRoom(room.id, { type: 'ms-score-update', playerId: pid, score: msp.score, charges: msp.charges, shield: msp.shield });
}

function msUsePowerupTarget(room, pid, r, c) {
  const ms = room.minesweeper;
  const msp = ms.players[pid];
  if (!msp || msp.charges <= 0) { msp.targeting = null; return; }
  const ptype = msp.targeting;
  msp.targeting = null;
  msp.charges--;

  if (ptype === 'reveal') {
    // Safely reveal 3x3 area, mines stay hidden but flash for player
    const revealed = [];
    const minesInArea = [];
    for (let dr = -1; dr <= 1; dr++) {
      for (let dc = -1; dc <= 1; dc++) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= ms.size || nc < 0 || nc >= ms.size) continue;
        const cl = ms.board[nr][nc];
        if (cl.revealed) continue;
        if (cl.mine) {
          minesInArea.push({ row: nr, col: nc });
          continue;
        }
        cl.revealed = true;
        cl.revealedBy = pid;
        ms.revealedCount++;
        msp.score++;
        msp.pointsAccum++;
        revealed.push({ row: nr, col: nc, adjacent: cl.adjacent });
      }
    }
    while (msp.pointsAccum >= 10) { msp.pointsAccum -= 10; if (msp.charges < 3) msp.charges++; }
    broadcastRoom(room.id, { type: 'ms-revealed', playerId: pid, cells: revealed, score: msp.score, charges: msp.charges });
    const p = room.players.get(pid);
    if (p && minesInArea.length > 0) send(p.ws, { type: 'ms-reveal-mines-flash', mines: minesInArea, duration: 3000 });
  } else if (ptype === 'magnet') {
    // Place decoy trap
    const cl = ms.board[r][c];
    if (!cl.revealed) {
      cl.decoy = pid;
      const p = room.players.get(pid);
      if (p) send(p.ws, { type: 'ms-decoy-placed', row: r, col: c, charges: msp.charges });
    }
  } else if (ptype === 'trap') {
    // Plant trap on revealed safe cell
    const cl = ms.board[r][c];
    if (cl.revealed && !cl.mine) {
      cl.trap = pid;
      const p = room.players.get(pid);
      if (p) send(p.ws, { type: 'ms-trap-placed', row: r, col: c, charges: msp.charges });
    }
  }

  broadcastRoom(room.id, { type: 'ms-score-update', playerId: pid, score: msp.score, charges: msp.charges, shield: msp.shield });
  msCheckEnd(room);
}

function msCheckEnd(room) {
  const ms = room.minesweeper;
  if (!ms || !ms.active) return;
  if (ms.revealedCount >= ms.totalSafe) {
    msEndGame(room);
  }
}

function msEndGame(room) {
  const ms = room.minesweeper;
  if (!ms || !ms.active) return;
  ms.active = false;
  if (ms.timer) { clearTimeout(ms.timer); ms.timer = null; }
  room.status = 'waiting';

  // Calculate final scores — correct flags bonus, incorrect flag penalty
  const flagResults = {};
  for (let r = 0; r < ms.size; r++) {
    for (let c = 0; c < ms.size; c++) {
      const cl = ms.board[r][c];
      if (cl.flaggedBy) {
        const pid = cl.flaggedBy;
        if (!flagResults[pid]) flagResults[pid] = { correct: 0, incorrect: 0 };
        if (cl.mine) {
          flagResults[pid].correct++;
          if (ms.players[pid]) ms.players[pid].score += 3;
        } else {
          flagResults[pid].incorrect++;
          if (ms.players[pid]) ms.players[pid].score -= 2;
        }
      }
    }
  }

  // Find winner
  let winnerId = null, bestScore = -Infinity;
  for (const [pid, ps] of Object.entries(ms.players)) {
    if (ps.score > bestScore) { bestScore = ps.score; winnerId = pid; }
  }

  // Reveal all mines
  const mines = [];
  for (let r = 0; r < ms.size; r++) {
    for (let c = 0; c < ms.size; c++) {
      if (ms.board[r][c].mine) mines.push({ row: r, col: c });
    }
  }

  const finalScores = {};
  for (const [pid, ps] of Object.entries(ms.players)) {
    finalScores[pid] = { name: ps.name, score: ps.score, colorIdx: ps.colorIdx, flagResults: flagResults[pid] || { correct: 0, incorrect: 0 } };
  }

  broadcastRoom(room.id, {
    type: 'ms-game-over',
    winnerId, winnerName: winnerId ? ms.players[winnerId].name : null,
    finalScores, mines, flagResults,
  });
  broadcastLobby();
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

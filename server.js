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
const VALID_GAMES = new Set(['maze', 'tetris', 'tictactoe', 'bluffrummy', 'rami', 'pool', 'battleship', 'egame', 'snakesladders', 'uno', 'tanks', 'bomberman', 'minesweeper', 'barricade', 'td', 'ballescape', 'sudoku', 'geoguessr', 'memoryduel']);
const LOWER_IS_BETTER = new Set(['maze']);
const WIN_INCREMENT_GAMES = new Set(['tictactoe', 'bluffrummy', 'rami', 'pool', 'battleship', 'egame', 'snakesladders', 'uno', 'tanks', 'bomberman', 'barricade', 'td', 'sudoku', 'geoguessr', 'memoryduel']);

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
const ROUTES = { '/': '/lobby.html', '/maze': '/maze.html', '/tetris': '/tetris.html', '/tictactoe': '/tictactoe.html', '/bluffrummy': '/bluffrummy.html', '/rami': '/rami.html', '/pool': '/pool.html', '/battleship': '/battleship.html', '/egame': '/egame.html', '/snakesladders': '/snakesladders.html', '/uno': '/uno.html', '/tanks': '/tanks.html', '/bomberman': '/bomberman.html', '/minesweeper': '/minesweeper.html', '/barricade': '/barricade.html', '/td': '/td.html', '/ballescape': '/ballescape.html', '/sudoku': '/sudoku.html', '/geoguessr': '/geoguessr.html', '/memoryduel': '/memoryduel.html' };

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
      // If fewer than 2 non-disconnected players remain, end the match immediately
      const remaining = Object.values(bm.players).filter(p => !p.disconnected);
      if (remaining.length < 2) {
        if (bm.tickInterval) { clearInterval(bm.tickInterval); bm.tickInterval = null; }
        bm.active = false;
        bm.roundActive = false;
        room.status = 'waiting';
        broadcastRoom(room.id, { type: 'bm-match-over', winnerId: null, winnerName: null, roundWins: bm.roundWins });
        broadcastLobby();
      } else {
        bmCheckRoundEnd(room);
      }
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
  if (room.barricade && room.barricade.active) {
    const bar = room.barricade;
    const roomId = room.id;
    // In the 2-player Quoridor game, disconnection = the other player wins
    bar.active = false;
    room.status = 'waiting';
    broadcastRoom(roomId, { type: 'bar2-gameover', winnerIdx: bar.turnIdx === 0 ? 1 : 0, reason: 'opponent_disconnect' });
    broadcastLobby();
    log('info', 'bar2-disconnect-forfeit', { roomId, name: conn.name });
  }
  if (room.td && room.td.active) {
    tdEliminatePlayer(room, conn.id, true);
    if (room.players.size === 0) {
      if (room.td.tickInterval) clearInterval(room.td.tickInterval);
      room.td = null;
    }
  }
  if (room.sudoku && room.sudoku.active) {
    if (room.players.size === 0) {
      room.sudoku = null;
    } else if (!room.sudoku.winner) {
      if (room.players.size === 1) {
        const [[winId, winP]] = [...room.players.entries()];
        room.sudoku.winner = winId;
        room.sudoku.active = false;
        room.status = 'waiting';
        broadcastRoom(room.id, { type: 'sudoku-winner', winnerId: winId, winnerName: winP.name, time: 0 });
        broadcastLobby();
      } else {
        broadcastRoom(room.id, { type: 'sudoku-player-left', id: conn.id });
      }
    }
  }
  if (room.geo && room.geo.active) {
    if (room.geo.phaseTimer) { clearTimeout(room.geo.phaseTimer); room.geo.phaseTimer = null; }
    if (room.players.size === 0) {
      room.geo = null;
    } else {
      const [[winId, winP]] = [...room.players.entries()];
      room.geo.active = false;
      room.status = 'waiting';
      broadcastRoom(room.id, { type: 'geo-opponent-left', winnerId: winId, winnerName: winP.name });
      broadcastLobby();
    }
  }
  if (room.md && room.md.active) {
    if (room.md.stealWindow?.stealTimer) { clearTimeout(room.md.stealWindow.stealTimer); room.md.stealWindow.stealTimer = null; }
    if (room.players.size === 0) {
      room.md = null;
    } else {
      const [[winId, winP]] = [...room.players.entries()];
      room.md.active = false;
      room.status = 'waiting';
      broadcastRoom(room.id, { type: 'md-opponent-left', winnerId: winId, winnerName: winP.name });
      broadcastLobby();
    }
  }

  // Remove empty rooms
  if (room.players.size === 0) {
    if (room.countdown) clearInterval(room.countdown);
    rooms.delete(conn.roomId);
  } else {
    // Don't reset status if an active game is still running
    const hasActiveGame = (room.uno?.active) || (room.br?.active) || (room.sl?.active) || (room.rami?.roundActive) || (room.tanks?.active) || (room.bomberman?.active) || (room.minesweeper?.active) || (room.barricade?.active) || (room.td?.active) || (room.sudoku?.active) || (room.geo?.active) || (room.md?.active);
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
        const type = msg.gameType === 'tetris' ? 'tetris' : msg.gameType === 'tictactoe' ? 'tictactoe' : msg.gameType === 'bluffrummy' ? 'bluffrummy' : msg.gameType === 'rami' ? 'rami' : msg.gameType === 'pool' ? 'pool' : msg.gameType === 'battleship' ? 'battleship' : msg.gameType === 'egame' ? 'egame' : msg.gameType === 'snakesladders' ? 'snakesladders' : msg.gameType === 'uno' ? 'uno' : msg.gameType === 'tanks' ? 'tanks' : msg.gameType === 'bomberman' ? 'bomberman' : msg.gameType === 'minesweeper' ? 'minesweeper' : msg.gameType === 'barricade' ? 'barricade' : msg.gameType === 'td' ? 'td' : msg.gameType === 'sudoku' ? 'sudoku' : msg.gameType === 'geoguessr' ? 'geoguessr' : msg.gameType === 'memoryduel' ? 'memoryduel' : 'maze';
        const name = String(msg.roomName || conn.name + "'s Room").slice(0, 30);
        const max = type === 'tictactoe' || type === 'pool' || type === 'battleship' || type === 'egame' || type === 'geoguessr' || type === 'memoryduel' ? 2 : type === 'bluffrummy' || type === 'snakesladders' || type === 'barricade' ? Math.min(4, Math.max(2, parseInt(msg.maxPlayers) || 4)) : type === 'rami' ? Math.min(4, Math.max(1, parseInt(msg.maxPlayers) || 4)) : type === 'uno' ? Math.min(6, Math.max(2, parseInt(msg.maxPlayers) || 6)) : type === 'tanks' || type === 'bomberman' || type === 'minesweeper' || type === 'td' ? Math.min(4, Math.max(2, parseInt(msg.maxPlayers) || 4)) : type === 'sudoku' ? Math.min(6, Math.max(2, parseInt(msg.maxPlayers) || 4)) : Math.min(8, Math.max(2, parseInt(msg.maxPlayers) || 6));
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

        // Barricade (Quoridor) has no reconnect — disconnect = forfeit

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
        // Lock barricade rooms while game is running
        if (room.status === 'playing' && room.type === 'barricade') {
          send(ws, { type: 'error', msg: 'Game in progress — this room is locked' }); break;
        }
        // Lock tower-defense rooms while game is running
        if (room.status === 'playing' && room.type === 'td') {
          send(ws, { type: 'error', msg: 'Game in progress — this room is locked' }); break;
        }
        // Lock sudoku rooms while game is running
        if (room.status === 'playing' && room.type === 'sudoku') {
          send(ws, { type: 'error', msg: 'Game in progress — this room is locked' }); break;
        }
        // Lock geoguessr rooms while game is running
        if (room.status === 'playing' && room.type === 'geoguessr') {
          send(ws, { type: 'error', msg: 'Game in progress — this room is locked' }); break;
        }
        // Lock memoryduel rooms while game is running
        if (room.status === 'playing' && room.type === 'memoryduel') {
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

        // Send current TD lobby config to the joiner so they see the host's mode/map pick
        if (room.type === 'td' && room.tdConfig) {
          send(ws, { type: 'td-config', mode: room.tdConfig.mode, map: room.tdConfig.map });
        }
        // Send current GeoGuessr lobby config to the joiner
        if (room.type === 'geoguessr' && room.geoConfig) {
          send(ws, { type: 'geo-config', difficulty: room.geoConfig.difficulty, totalRounds: room.geoConfig.totalRounds });
        }
        // Send current Memory Duel lobby config to the joiner
        if (room.type === 'memoryduel' && room.mdConfig) {
          send(ws, { type: 'md-lobby-config', gridSize: room.mdConfig.gridSize, stealWindowMs: room.mdConfig.stealWindowMs, ghostMode: room.mdConfig.ghostMode, cardTheme: room.mdConfig.cardTheme });
        }

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

      // ── Sudoku ────────────────────────────────────────────
      case 'sudoku-start': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'sudoku') break;
        if (room.players.keys().next().value !== id) break; // host only
        if (room.sudoku?.active) break;
        if (room.countdown) { clearInterval(room.countdown); room.countdown = null; }
        const difficulty = ['easy','medium','hard','expert'].includes(msg.difficulty) ? msg.difficulty : 'medium';
        const seed = Math.floor(Math.random() * 2147483647) + 1;
        room.sudoku = { seed, difficulty, started: false, active: false, winner: null, startedAt: Date.now() };
        room.status = 'playing';
        broadcastLobby();
        log('info', 'sudoku-start', { startedBy: conn.name, ip: conn.ip, roomId: room.id, difficulty, players: room.players.size });
        let sudokuCount = 3;
        broadcastRoom(room.id, { type: 'sudoku-countdown', count: sudokuCount, difficulty });
        room.countdown = setInterval(() => {
          sudokuCount--;
          if (sudokuCount > 0) {
            broadcastRoom(room.id, { type: 'sudoku-countdown', count: sudokuCount });
          } else {
            clearInterval(room.countdown); room.countdown = null;
            room.sudoku.started = true;
            room.sudoku.active = true;
            broadcastRoom(room.id, { type: 'sudoku-go', seed, difficulty });
          }
        }, 1000);
        break;
      }
      case 'sudoku-progress': {
        if (conn.mode !== 'room') break;
        const room = rooms.get(conn.roomId);
        if (!room || !room.sudoku?.active) break;
        const p = room.players.get(id);
        const filled = Math.min(81, Math.max(0, parseInt(msg.filled) || 0));
        broadcastRoom(room.id, { type: 'sudoku-player-progress', id, name: p?.name || '?', filled }, id);
        break;
      }
      case 'sudoku-complete': {
        if (conn.mode !== 'room') break;
        const room = rooms.get(conn.roomId);
        if (!room || !room.sudoku?.active) break;
        if (room.sudoku.winner) break;
        const p = room.players.get(id);
        const time = Math.max(0, parseInt(msg.time) || 0);
        room.sudoku.winner = id;
        room.sudoku.active = false;
        room.status = 'waiting';
        broadcastRoom(room.id, { type: 'sudoku-winner', winnerId: id, winnerName: p?.name || '?', time });
        broadcastLobby();
        log('info', 'sudoku-complete', { id, name: p?.name || '?', ip: conn.ip, roomId: room.id, time });
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
        if (room.players.size + (room.bmBots?.length || 0) < 2) { send(ws, { type: 'error', msg: 'Need at least 2 players (add a bot!)' }); break; }
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
          ps.facingDir = msg.dir;
        } else if (msg.action === 'move-stop') {
          ps.moving = false;
          ps.moveDir = null;
        } else if (msg.action === 'pos') {
          // Client reports a cell step — validate and accept
          const nx = Math.round(msg.x), ny = Math.round(msg.y);
          if (nx >= 0 && nx < BM_COLS && ny >= 0 && ny < BM_ROWS) {
            const dist = Math.abs(nx - ps.x) + Math.abs(ny - ps.y);
            const cellOk = bm.grid[ny][nx] === 0;
            // Only accept steps of 0 or 1 cell (no teleporting)
            if (dist <= 1 && cellOk) {
              ps.x = nx; ps.y = ny;
              if (msg.dir && ['up','down','left','right'].includes(msg.dir)) ps.facingDir = msg.dir;
              // Pick up powerup if present
              const key = ny + ',' + nx;
              if (bm.powerupsOnFloor[key]) {
                const ptype = bm.powerupsOnFloor[key];
                delete bm.powerupsOnFloor[key];
                bmApplyPowerup(ps, ptype, Date.now());
              }
            }
          }
        } else if (msg.action === 'bomb') {
          bmPlaceBomb(room, id);
        } else if (msg.action === 'ability') {
          bmUseAbility(room, id);
        }
        break;
      }
      case 'bm-add-bot': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'bomberman' || room.bomberman?.active) break;
        const hostId = [...room.players.keys()][0];
        if (id !== hostId) break;
        if (!room.bmBots) room.bmBots = [];
        const totalPlayers = room.players.size + room.bmBots.length;
        if (totalPlayers >= room.maxPlayers) { send(ws, { type: 'error', msg: 'Room is full' }); break; }
        const botNum = room.bmBots.length + 1;
        const botId = 'bot-' + botNum;
        room.bmBots.push({ id: botId, name: 'Bot ' + botNum });
        broadcastRoom(room.id, { type: 'bm-bot-added', botId, botName: 'Bot ' + botNum });
        break;
      }
      case 'bm-remove-bot': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'bomberman' || room.bomberman?.active) break;
        const hostId = [...room.players.keys()][0];
        if (id !== hostId || !room.bmBots?.length) break;
        const removed = room.bmBots.pop();
        if (removed) broadcastRoom(room.id, { type: 'bm-bot-removed', botId: removed.id });
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

      // ── Barricade (Quoridor-style) ────────────────────────────────
      case 'bar2-start': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'barricade') break;
        if (room.barricade?.active) { send(ws, { type: 'error', msg: 'Game already in progress' }); break; }
        if (room.players.size < 2) { send(ws, { type: 'error', msg: 'Need 2 players' }); break; }
        startBarricade2(room);
        break;
      }
      case 'bar2-move': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.barricade?.active) break;
        const bar = room.barricade;
        if (bar.turnOrder[bar.turnIdx] !== id) break;
        const row = parseInt(msg.row), col = parseInt(msg.col);
        if (isNaN(row) || isNaN(col) || row < 0 || row >= 9 || col < 0 || col >= 9) break;
        // Validate move
        const validMoves = bar2GetValidMoves(bar, bar.turnIdx);
        if (!validMoves.find(m => m.row === row && m.col === col)) break;
        // Execute
        bar.players[bar.turnIdx].row = row;
        bar.players[bar.turnIdx].col = col;
        broadcastRoom(room.id, { type: 'bar2-moved', playerIdx: bar.turnIdx, row, col });
        // Check win
        if (row === bar.players[bar.turnIdx].goalRow) {
          broadcastRoom(room.id, { type: 'bar2-gameover', winnerIdx: bar.turnIdx });
          bar.active = false;
          room.status = 'waiting';
          broadcastLobby();
          log('info', 'bar2-win', { roomId: room.id, winner: conn.name });
          break;
        }
        bar2AdvanceTurn(bar);
        broadcastRoom(room.id, { type: 'bar2-turn', currentPlayer: bar.turnIdx });
        break;
      }
      case 'bar2-wall': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.barricade?.active) break;
        const bar = room.barricade;
        if (bar.turnOrder[bar.turnIdx] !== id) break;
        const wallType = msg.wallType, r = parseInt(msg.r), c = parseInt(msg.c);
        if (!wallType || isNaN(r) || isNaN(c)) break;
        if (bar.players[bar.turnIdx].wallsLeft <= 0) break;
        if (!bar2IsWallValid(bar, wallType, r, c)) break;
        if (bar2WouldBlock(bar, wallType, r, c)) break;
        // Place wall
        bar.walls.push({ type: wallType, r, c, player: bar.turnIdx });
        bar.players[bar.turnIdx].wallsLeft--;
        broadcastRoom(room.id, { type: 'bar2-wall', playerIdx: bar.turnIdx, wallType, r, c, wallsLeft: bar.players[bar.turnIdx].wallsLeft });
        bar2AdvanceTurn(bar);
        broadcastRoom(room.id, { type: 'bar2-turn', currentPlayer: bar.turnIdx });
        log('info', 'bar2-wall', { roomId: room.id, player: conn.name, wallType, r, c });
        break;
      }

      // ── Tower Defense ──────────────────────────────────────
      case 'td-start': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'td') break;
        if (room.td?.active) break;
        const hostId = [...room.players.keys()][0];
        if (id !== hostId) { send(ws, { type: 'error', msg: 'Only the host can start' }); break; }
        const botEnabled = !!msg.bot;
        if (room.players.size < 2 && !botEnabled) { send(ws, { type: 'error', msg: 'Need at least 2 players or enable bot' }); break; }
        const cfg = room.tdConfig || {};
        const mode = TD_MODES[msg.mode] ? msg.mode : (cfg.mode || 'classic');
        const map = (TD_MAPS[msg.map] || msg.map === 'random') ? msg.map : (cfg.map || 'serpent');
        tdStartMatch(room, mode, map, botEnabled || room.players.size < 2);
        break;
      }
      case 'td-config': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'td' || room.td?.active) break;
        const hostId = [...room.players.keys()][0];
        if (id !== hostId) break;
        const mode = TD_MODES[msg.mode] ? msg.mode : 'classic';
        const map = (TD_MAPS[msg.map] || msg.map === 'random') ? msg.map : 'serpent';
        room.tdConfig = { mode, map };
        broadcastRoom(room.id, { type: 'td-config', mode, map });
        break;
      }
      case 'td-place-tower': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.td?.active) break;
        tdPlaceTower(room, id, msg.towerType, parseInt(msg.x), parseInt(msg.y));
        break;
      }
      case 'td-upgrade-tower': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.td?.active) break;
        tdUpgradeTower(room, id, parseInt(msg.towerId));
        break;
      }
      case 'td-buy-perk': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.td?.active) break;
        tdBuyPerk(room, id, parseInt(msg.towerId), String(msg.perkId || ''));
        break;
      }
      case 'td-buy-upgrade': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.td?.active) break;
        const td = room.td; const lane = td.lanes[id];
        if (!lane || !lane.alive) break;
        const upg = TD_LANE_UPGRADES[msg.upgradeId];
        if (!upg || lane.upgrades.has(msg.upgradeId)) { send(ws, { type: 'td-action-error', reason: 'Already owned or invalid' }); break; }
        if (lane.gold < upg.cost) { send(ws, { type: 'td-action-error', reason: 'Not enough gold' }); break; }
        lane.gold -= upg.cost; lane.upgrades.add(msg.upgradeId);
        tdResolveLaneAmps(lane);
        send(ws, { type: 'td-gold', gold: lane.gold });
        break;
      }
      case 'td-buy-ability': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.td?.active) break;
        const td = room.td; const lane = td.lanes[id];
        if (!lane || !lane.alive) break;
        const abi = TD_ABILITIES[msg.abilityId];
        if (!abi || lane.abilityOwned.has(msg.abilityId)) { send(ws, { type: 'td-action-error', reason: 'Already owned or invalid' }); break; }
        if (lane.gold < abi.cost) { send(ws, { type: 'td-action-error', reason: 'Not enough gold' }); break; }
        lane.gold -= abi.cost; lane.abilityOwned.add(msg.abilityId);
        send(ws, { type: 'td-gold', gold: lane.gold });
        break;
      }
      case 'td-use-ability': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.td?.active) break;
        tdUseAbility(room, id, String(msg.abilityId || ''));
        break;
      }
      case 'td-config-autosend': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.td?.active) break;
        const lane = room.td.lanes[id];
        if (!lane || !lane.alive) break;
        if (msg.enabled !== undefined) lane.autoSend.enabled = !!msg.enabled;
        if (msg.packageIdx !== undefined && TD_SEND_PACKAGES[msg.packageIdx]) lane.autoSend.packageIdx = parseInt(msg.packageIdx);
        if (['random','lowest_hp','highest_hp'].includes(msg.targeting)) lane.autoSend.targeting = msg.targeting;
        send(ws, { type: 'td-autosend-cfg', autoSend: lane.autoSend });
        break;
      }
      case 'td-skip-prep': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.td?.active) break;
        tdSkipPrep(room, id);
        break;
      }
      case 'td-sell-tower': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.td?.active) break;
        tdSellTower(room, id, parseInt(msg.towerId));
        break;
      }
      case 'td-send-enemies': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.td?.active) break;
        tdSendEnemies(room, id, parseInt(msg.packageIdx), msg.targetId);
        break;
      }

      // ── Memory Duel ────────────────────────────────────────────
      case 'md-lobby-config': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'memoryduel') break;
        if (room.players.keys().next().value !== id) break;
        if (room.md?.active) break;
        const validSizes = ['4x4', '6x6', '8x6'];
        const validSw = [1000, 2000, 3000];
        const gs = validSizes.includes(msg.gridSize) ? msg.gridSize : '6x6';
        const sw = validSw.includes(Number(msg.stealWindowMs)) ? Number(msg.stealWindowMs) : 2000;
        const gm = !!msg.ghostMode;
        const ct = ['emoji', 'numbers', 'colors'].includes(msg.cardTheme) ? msg.cardTheme : 'emoji';
        room.mdConfig = { gridSize: gs, stealWindowMs: sw, ghostMode: gm, cardTheme: ct };
        broadcastRoom(room.id, { type: 'md-lobby-config', gridSize: gs, stealWindowMs: sw, ghostMode: gm, cardTheme: ct }, id);
        break;
      }
      case 'md-start': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'memoryduel') break;
        if (room.players.keys().next().value !== id) break;
        if (room.md?.active) break;
        if (room.players.size < 2) { send(ws, { type: 'error', msg: 'Need 2 players to start' }); break; }
        const gs = room.mdConfig?.gridSize || '6x6';
        const sw = room.mdConfig?.stealWindowMs || 2000;
        const gm = room.mdConfig?.ghostMode || false;
        const ct = room.mdConfig?.cardTheme || 'emoji';
        const [cols, rows] = gs === '4x4' ? [4, 4] : gs === '8x6' ? [8, 6] : [6, 6];
        const totalCards = cols * rows;
        const pairCount = totalCards / 2;
        const deck = [];
        for (let i = 0; i < pairCount; i++) {
          deck.push({ value: i, emoji: MD_EMOJIS[i], color: MD_COLORS[i] });
          deck.push({ value: i, emoji: MD_EMOJIS[i], color: MD_COLORS[i] });
        }
        for (let i = deck.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          [deck[i], deck[j]] = [deck[j], deck[i]];
        }
        const grid = deck.map(card => ({ value: card.value, emoji: card.emoji, color: card.color, captured: false, capturedBy: null }));
        const playerIds = [...room.players.keys()];
        const turnId = playerIds[Math.floor(Math.random() * playerIds.length)];
        const scores = {}, streaks = {}, stealStats = {}, longestStreak = {};
        for (const pid of playerIds) { scores[pid] = 0; streaks[pid] = 0; stealStats[pid] = { attempts: 0, successes: 0, failures: 0 }; longestStreak[pid] = 0; }
        room.md = {
          active: true, grid, gridSize: gs, cols, rows, totalCards, pairCount,
          turnId, scores, streaks, stealStats, longestStreak,
          penalties: new Set(), stealWindow: null, firstFlip: null, turnPhase: 'idle',
          capturedPairs: 0, totalPairs: pairCount, winner: null,
          stealWindowMs: sw, ghostMode: gm, cardTheme: ct,
          startedAt: Date.now(), lastCaptor: null,
        };
        room.status = 'playing';
        broadcastLobby();
        broadcastRoom(room.id, { type: 'md-go', gridSize: gs, cols, rows, totalCards, pairCount, turnId, stealWindowMs: sw, ghostMode: gm, cardTheme: ct, scores: { ...scores } });
        log('info', 'md-start', { roomId: room.id, gridSize: gs, pairCount, turnId });
        break;
      }
      case 'md-flip': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.md?.active) break;
        const md = room.md;
        if (md.turnId !== id) break;
        if (md.turnPhase !== 'idle' && md.turnPhase !== 'second-flip') break;
        const pos = Number(msg.pos);
        if (!Number.isInteger(pos) || pos < 0 || pos >= md.grid.length) break;
        const card = md.grid[pos];
        if (!card || card.captured) break;
        if (md.turnPhase === 'idle') {
          md.firstFlip = { pos, value: card.value, emoji: card.emoji, color: card.color };
          md.turnPhase = 'steal-window';
          broadcastRoom(room.id, { type: 'md-card-revealed', pos, value: card.value, emoji: card.emoji, color: card.color });
          const endsAt = Date.now() + md.stealWindowMs;
          md.stealWindow = {
            active: true, firstPos: pos, firstValue: card.value, endsAt,
            stealTimer: setTimeout(() => {
              if (!room.md?.stealWindow?.active) return;
              room.md.stealWindow.active = false;
              room.md.stealWindow.stealTimer = null;
              room.md.turnPhase = 'second-flip';
              broadcastRoom(room.id, { type: 'md-steal-window-close' });
            }, md.stealWindowMs),
          };
          broadcastRoom(room.id, { type: 'md-steal-window-open', durationMs: md.stealWindowMs, pos, value: card.value, emoji: card.emoji, color: card.color });
        } else if (md.turnPhase === 'second-flip') {
          if (pos === md.firstFlip.pos) break;
          if (card.captured) break;
          md.turnPhase = 'resolving';
          broadcastRoom(room.id, { type: 'md-card-revealed', pos, value: card.value, emoji: card.emoji, color: card.color });
          const first = md.firstFlip;
          const activeId = id;
          setTimeout(() => {
            if (!room.md?.active) return;
            if (first.value === card.value) {
              md.grid[first.pos].captured = true; md.grid[first.pos].capturedBy = activeId;
              md.grid[pos].captured = true; md.grid[pos].capturedBy = activeId;
              md.streaks[activeId] = (md.streaks[activeId] || 0) + 1;
              if (md.streaks[activeId] > (md.longestStreak[activeId] || 0)) md.longestStreak[activeId] = md.streaks[activeId];
              const bonus = md.streaks[activeId] >= 3 ? md.streaks[activeId] - 2 : 0;
              md.scores[activeId] = (md.scores[activeId] || 0) + 1 + bonus;
              md.capturedPairs++;
              md.lastCaptor = activeId;
              const ap = room.players.get(activeId);
              broadcastRoom(room.id, { type: 'md-pair-captured', captorId: activeId, captorName: ap?.name || '?', positions: [first.pos, pos], value: first.value, emoji: first.emoji, color: first.color, newScores: { ...md.scores }, streak: md.streaks[activeId], bonus });
              if (md.capturedPairs >= md.totalPairs) { mdEndGame(room); return; }
              md.firstFlip = null;
              md.stealWindow = null;
              md.turnPhase = 'idle';
              broadcastRoom(room.id, { type: 'md-turn-change', activeId: activeId });
            } else {
              md.streaks[activeId] = 0;
              md.firstFlip = null;
              md.stealWindow = null;
              broadcastRoom(room.id, { type: 'md-no-match', positions: [first.pos, pos] });
              mdAdvanceTurn(room, activeId);
            }
          }, 1500);
        }
        break;
      }
      case 'md-steal-attempt': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.md?.active) break;
        const md = room.md;
        if (md.turnId === id) break;
        if (!md.stealWindow?.active) break;
        if (Date.now() > md.stealWindow.endsAt + 200) break; // 200ms server leniency
        const sPos = Number(msg.pos);
        if (!Number.isInteger(sPos) || sPos < 0 || sPos >= md.grid.length) break;
        const sCard = md.grid[sPos];
        if (!sCard || sCard.captured || sPos === md.stealWindow.firstPos) break;
        if (md.stealWindow.stealTimer) { clearTimeout(md.stealWindow.stealTimer); md.stealWindow.stealTimer = null; }
        md.stealWindow.active = false;
        md.turnPhase = 'resolving';
        const firstPos = md.stealWindow.firstPos;
        const firstValue = md.stealWindow.firstValue;
        md.stealStats[id].attempts++;
        const stealerId = id;
        const originalTurnId = md.turnId;
        if (sCard.value === firstValue) {
          md.stealStats[stealerId].successes++;
          md.grid[firstPos].captured = true; md.grid[firstPos].capturedBy = stealerId;
          md.grid[sPos].captured = true; md.grid[sPos].capturedBy = stealerId;
          md.streaks[stealerId] = (md.streaks[stealerId] || 0) + 1;
          if (md.streaks[stealerId] > (md.longestStreak[stealerId] || 0)) md.longestStreak[stealerId] = md.streaks[stealerId];
          md.streaks[originalTurnId] = 0;
          const isPerfectSteal = md.capturedPairs === 0;
          const bonus = isPerfectSteal ? 3 : 1;
          md.scores[stealerId] = (md.scores[stealerId] || 0) + 1 + bonus;
          md.capturedPairs++;
          md.lastCaptor = stealerId;
          const sp = room.players.get(stealerId);
          broadcastRoom(room.id, { type: 'md-steal-success', stealerId, stealerName: sp?.name || '?', positions: [firstPos, sPos], value: firstValue, emoji: md.grid[firstPos].emoji, color: md.grid[firstPos].color, newScores: { ...md.scores }, streak: md.streaks[stealerId], bonus, isPerfectSteal });
          if (md.capturedPairs >= md.totalPairs) { setTimeout(() => mdEndGame(room), 1400); return; }
          md.firstFlip = null;
          md.stealWindow = null;
          setTimeout(() => {
            if (!room.md?.active) return;
            md.turnPhase = 'idle';
            mdAdvanceTurn(room, stealerId);
          }, 1400);
        } else {
          md.stealStats[stealerId].failures++;
          md.penalties.add(stealerId);
          broadcastRoom(room.id, { type: 'md-steal-failed', attempterId: stealerId, wrongPos: sPos });
          setTimeout(() => {
            if (!room.md?.active) return;
            md.turnPhase = 'second-flip';
            broadcastRoom(room.id, { type: 'md-steal-window-close' });
          }, 800);
        }
        break;
      }

      // ── GeoGuessr ──────────────────────────────────────────────
      case 'geo-start': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'geoguessr') break;
        if (room.players.keys().next().value !== id) break;
        if (room.geo?.active) break;
        if (room.players.size < 2) { send(ws, { type: 'error', msg: 'Need 2 players to start' }); break; }
        const difficulty = ['easy', 'normal', 'hard', 'nohints'].includes(msg.difficulty) ? msg.difficulty : 'normal';
        const totalRounds = [5, 10, 15].includes(parseInt(msg.rounds)) ? parseInt(msg.rounds) : 10;
        const customPhotos = Array.isArray(msg.customPhotos) ? msg.customPhotos.slice(0, 5) : [];
        room.geo = {
          active: true, difficulty, totalRounds, currentRound: 0, rounds: [],
          phase: 'loading', phaseTimer: null, viewStart: null, guessStart: null,
          ready: new Set(), guesses: {},
          scores: Object.fromEntries([...room.players.keys()].map(pid => [pid, 0])),
          roundHistory: [],
        };
        room.status = 'playing';
        broadcastLobby();
        broadcastRoom(room.id, { type: 'geo-preparing', difficulty, totalRounds });
        const geoRoomId = room.id;
        selectGeoRounds(difficulty, totalRounds, customPhotos).then(rounds => {
          const r = rooms.get(geoRoomId);
          if (!r || !r.geo?.active || r.geo.phase !== 'loading') return;
          if (rounds.length === 0) {
            r.geo.active = false; r.status = 'waiting';
            broadcastRoom(geoRoomId, { type: 'error', msg: 'No photos found. Check internet and try again.' });
            broadcastLobby(); return;
          }
          r.geo.rounds = rounds;
          r.geo.totalRounds = Math.min(r.geo.totalRounds, rounds.length);
          broadcastRoom(geoRoomId, { type: 'geo-game-start', difficulty: r.geo.difficulty, totalRounds: r.geo.totalRounds });
          geoStartViewPhase(r);
        }).catch(err => {
          const r = rooms.get(geoRoomId);
          if (!r?.geo) return;
          r.geo.active = false; r.status = 'waiting';
          broadcastRoom(geoRoomId, { type: 'error', msg: 'Failed to load photos. Please try again.' });
          broadcastLobby();
          log('error', 'geo-start-fail', { roomId: geoRoomId, err: String(err) });
        });
        log('info', 'geo-start', { by: conn.name, roomId: room.id, difficulty, totalRounds });
        break;
      }
      case 'geo-ready': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.geo?.active || room.geo.phase !== 'viewing') break;
        room.geo.ready.add(id);
        broadcastRoom(room.id, { type: 'geo-player-ready', id, readyCount: room.geo.ready.size, total: room.players.size });
        if (room.geo.ready.size >= room.players.size) {
          if (room.geo.phaseTimer) { clearTimeout(room.geo.phaseTimer); room.geo.phaseTimer = null; }
          geoStartGuessPhase(room);
        }
        break;
      }
      case 'geo-guess': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.geo?.active || room.geo.phase !== 'guessing') break;
        if (room.geo.guesses[id]) break;
        const gLat = parseFloat(msg.lat), gLng = parseFloat(msg.lng);
        if (!isFinite(gLat) || !isFinite(gLng) || gLat < -90 || gLat > 90 || gLng < -180 || gLng > 180) break;
        room.geo.guesses[id] = { lat: gLat, lng: gLng, confirmedAt: Date.now() };
        broadcastRoom(room.id, { type: 'geo-opponent-guessed', id }, id);
        send(ws, { type: 'geo-guess-confirmed' });
        if (Object.keys(room.geo.guesses).length >= room.players.size) {
          if (room.geo.phaseTimer) { clearTimeout(room.geo.phaseTimer); room.geo.phaseTimer = null; }
          geoResolveRound(room);
        }
        break;
      }
      case 'geo-lobby-config': {
        const room = rooms.get(conn.roomId);
        if (!room || room.type !== 'geoguessr') break;
        if (room.players.keys().next().value !== id) break;
        const cfgDiff = ['easy', 'normal', 'hard', 'nohints'].includes(msg.difficulty) ? msg.difficulty : 'normal';
        const cfgRounds = [5, 10, 15].includes(parseInt(msg.rounds)) ? parseInt(msg.rounds) : 10;
        room.geoConfig = { difficulty: cfgDiff, totalRounds: cfgRounds };
        broadcastRoom(room.id, { type: 'geo-config', difficulty: cfgDiff, totalRounds: cfgRounds }, id);
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
    scores: new Map(playerIds.map(pid => [pid, 0])),
    cardsPlayed: new Map(playerIds.map(pid => [pid, 0])),
    active: true,
  };
  room.status = 'playing';
  broadcastLobby();

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

  // Win/lose triangle
  function getResult(a, b) {
    if (a === b) return 'draw';
    if (a === 'emperor' && b === 'citizen') return 'win';
    if (a === 'citizen'  && b === 'slave')   return 'win';
    if (a === 'slave'    && b === 'emperor') return 'win';
    return 'lose';
  }

  // Points depend on WHICH cards clashed, not just who won
  function getMatchupPoints(winner, loser) {
    if (winner === 'slave'   && loser === 'emperor') return 4; // slave beats king
    if (winner === 'emperor' && loser === 'citizen') return 2; // king beats citizen
    if (winner === 'citizen' && loser === 'slave')   return 1; // citizen beats slave
    return 0;
  }

  const r1 = getResult(c1, c2);
  const r2 = getResult(c2, c1);
  const pts1 = r1 === 'win' ? getMatchupPoints(c1, c2) : 0;
  const pts2 = r2 === 'win' ? getMatchupPoints(c2, c1) : 0;

  eg.scores.set(p1, eg.scores.get(p1) + pts1);
  eg.scores.set(p2, eg.scores.get(p2) + pts2);

  // Track cards played this round (both play simultaneously so counts stay equal)
  eg.cardsPlayed.set(p1, (eg.cardsPlayed.get(p1) || 0) + 1);
  eg.cardsPlayed.set(p2, (eg.cardsPlayed.get(p2) || 0) + 1);
  const played = eg.cardsPlayed.get(p1);
  eg.turn++;

  // Round ends only after ALL 5 cards have been played (last pair always gets matched)
  const isRoundOver = played >= 5;
  // Game = 2 rounds total (each player plays both sides once)
  const isGameOver  = isRoundOver && eg.round >= 2;

  // Send eg-reveal to both players
  for (const pid of eg.players) {
    const oppId    = eg.players.find(x => x !== pid);
    const yourCard = eg.picks.get(pid);
    const oppCard  = eg.picks.get(oppId);
    const result   = pid === p1 ? r1 : r2;
    const pts      = pid === p1 ? pts1 : pts2;
    const pConn    = room.players.get(pid);
    if (pConn) {
      send(pConn.ws, {
        type: 'eg-reveal',
        yourCard, oppCard, result,
        points: pts,
        scores: { you: eg.scores.get(pid), opp: eg.scores.get(oppId) },
        round: eg.round,
        turn: played,
        roundOver: isRoundOver,
        gameOver: isGameOver,
      });
    }
  }

  log('info', 'eg-reveal', { roomId: room.id, round: eg.round, turn: played, c1, c2, r1, r2 });
  eg.picks.clear();

  if (isGameOver) {
    eg.active = false;
    room.status = 'waiting';
    broadcastLobby();
    // Delay so clients can animate the round-end overlay before showing final result
    setTimeout(() => {
      for (const pid of eg.players) {
        const oppId    = eg.players.find(x => x !== pid);
        const myScore  = eg.scores.get(pid);
        const oppScore = eg.scores.get(oppId);
        const winner   = myScore > oppScore ? 'you' : myScore < oppScore ? 'opp' : 'tie';
        const pConn    = room.players.get(pid);
        if (pConn) send(pConn.ws, { type: 'eg-end', scores: { you: myScore, opp: oppScore }, winner });
      }
      log('info', 'eg-end', { roomId: room.id, s1: eg.scores.get(p1), s2: eg.scores.get(p2) });
    }, 4000);
  } else if (isRoundOver) {
    eg.round++;
    // Delay so clients can animate the round-end overlay before side swap
    setTimeout(() => {
      for (const pid of eg.players) {
        eg.sides.set(pid, eg.sides.get(pid) === 'emperor' ? 'slave' : 'emperor');
        eg.hands.set(pid, buildEGameHand(eg.sides.get(pid)));
        eg.cardsPlayed.set(pid, 0);
      }
      eg.turn = 1;
      for (const pid of eg.players) {
        const pConn = room.players.get(pid);
        if (pConn) {
          send(pConn.ws, {
            type: 'eg-round-swap',
            side: eg.sides.get(pid),
            hand: eg.hands.get(pid),
            round: eg.round,
            turn: 1,
          });
        }
      }
      log('info', 'eg-swap', { roomId: room.id, round: eg.round });
    }, 4000);
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
  const humanIds = [...room.players.keys()];
  const bots = room.bmBots || [];
  const allIds = [...humanIds, ...bots.map(b => b.id)];
  const { grid, softPowerups } = bmGenerateArena();
  const players = {};
  allIds.forEach((pid, i) => {
    const [sx, sy] = BM_SPAWN_CORNERS[i % 4];
    const isBot = bots.some(b => b.id === pid);
    const name = isBot ? bots.find(b => b.id === pid).name : room.players.get(pid).name;
    players[pid] = {
      x: sx, y: sy, alive: true, disconnected: false,
      bombMax: 1, bombRadius: 2, speedLevel: 0,
      vest: false, ability: null,
      curse: null, curseUntil: 0,
      name, colorIdx: i,
      moving: false, moveDir: null,
      moveProgress: 0,
      facingDir: 'down',
      isBot,
      botNextMoveAt: 0,
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
  for (const pid of allIds) room.bomberman.roundWins[pid] = 0;
  room.status = 'playing';
  broadcastLobby();

  // Send start countdown
  const playersInfo = allIds.map(pid => ({ id: pid, name: players[pid].name, colorIdx: players[pid].colorIdx, isBot: players[pid].isBot }));
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
      facingDir: ps.facingDir,
    };
  }
  return out;
}

function bmTick(room) {
  const bm = room.bomberman;
  if (!bm || !bm.active || !bm.roundActive) return;
  const now = Date.now();
  const events = [];

  // ── Curse effects (server-side only, no movement simulation) ──
  for (const [pid, ps] of Object.entries(bm.players)) {
    if (!ps.alive) continue;
    // auto-bomb curse
    if (ps.curse === 'auto-bomb' && ps.curseUntil > now) {
      bmPlaceBomb(room, pid);
    }
    // clear expired curses
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

  // ── Bot AI ──
  bmTickBots(room);

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


// ── Bomberman Bot AI ────────────────────────────────────────────────

const BM_BOT_BASE_INTERVAL_MS = 320; // ms between bot moves at speed level 0

function bmTickBots(room) {
  const bm = room.bomberman;
  const now = Date.now();
  for (const [pid, ps] of Object.entries(bm.players)) {
    if (!ps.isBot || !ps.alive) continue;
    if ((ps.botNextMoveAt || 0) > now) continue;
    const speedInterval = Math.max(100, BM_BOT_BASE_INTERVAL_MS - (ps.speedLevel || 0) * 60);
    ps.botNextMoveAt = now + speedInterval;
    bmBotDecide(room, pid);
  }
}

function bmBotDecide(room, botId) {
  const bm = room.bomberman;
  const ps = bm.players[botId];
  if (!ps || !ps.alive) return;
  const now = Date.now();

  // ── Pick up powerup if standing on one ──────────────────────────
  const puKey = ps.y + ',' + ps.x;
  if (bm.powerupsOnFloor[puKey]) {
    const ptype = bm.powerupsOnFloor[puKey];
    delete bm.powerupsOnFloor[puKey];
    bmApplyPowerup(ps, ptype, now);
  }

  // ── 1. Build danger map (bombs with <2500ms fuse) ──────────────
  const dangerMap = new Set();
  for (const b of bm.bombs) {
    const fuseLeft = b.remote ? Infinity : (b.detonateAt - now);
    if (fuseLeft > 2500) continue;
    bmBotBlastCells(bm, b.x, b.y, b.radius).forEach(c => dangerMap.add(c.x + ',' + c.y));
  }

  // ── 2. FLEE if currently in danger ─────────────────────────────
  if (dangerMap.has(ps.x + ',' + ps.y)) {
    const safeCell = bmBotFindSafeCell(bm, ps.x, ps.y, dangerMap);
    if (safeCell) {
      const step = bmBotNextStep(bm, ps.x, ps.y, safeCell.x, safeCell.y, dangerMap, false);
      if (step) { ps.x = step.x; ps.y = step.y; ps.facingDir = step.dir; }
    }
    return;
  }

  // ── 2.5. Handle remote detonation ability ──────────────────────
  // Remote bombs have Infinity fuse so they never appear in dangerMap.
  // The bot must: (a) flee its own blast zone before detonating, (b) detonate once safe.
  if (ps.ability === 'remote') {
    const myRemoteBombs = bm.bombs.filter(b => b.ownerId === botId && b.remote);
    if (myRemoteBombs.length > 0) {
      const remoteDanger = new Set();
      for (const rb of myRemoteBombs) {
        bmBotBlastCells(bm, rb.x, rb.y, rb.radius).forEach(c => remoteDanger.add(c.x + ',' + c.y));
      }
      if (remoteDanger.has(ps.x + ',' + ps.y)) {
        // Still inside own blast zone — move to safety first
        const safeCell = bmBotFindSafeCell(bm, ps.x, ps.y, remoteDanger);
        if (safeCell) {
          const step = bmBotNextStep(bm, ps.x, ps.y, safeCell.x, safeCell.y, remoteDanger, false);
          if (step) { ps.x = step.x; ps.y = step.y; ps.facingDir = step.dir; }
        }
        return;
      }
      // Bot is clear — detonate (destroys walls and/or hits enemies in blast zone)
      bmUseAbility(room, botId);
      return;
    }
  }

  const activeBombs = bm.bombs.filter(b => b.ownerId === botId).length;
  const canBomb = activeBombs < ps.bombMax && !bm.bombs.some(b => b.x === ps.x && b.y === ps.y);

  // ── 3. BOMB if enemy is directly in blast range ─────────────────
  if (canBomb) {
    const blastCells = bmBotBlastCells(bm, ps.x, ps.y, ps.bombRadius);
    const hitsEnemy = blastCells.some(c =>
      Object.entries(bm.players).some(([epid, ep]) => epid !== botId && ep.alive && ep.x === c.x && ep.y === c.y)
    );
    if (hitsEnemy) {
      const futureDanger = new Set(dangerMap);
      blastCells.forEach(c => futureDanger.add(c.x + ',' + c.y));
      const escape = bmBotFindSafeCell(bm, ps.x, ps.y, futureDanger);
      if (escape) {
        bmPlaceBomb(room, botId);
        const step = bmBotNextStep(bm, ps.x, ps.y, escape.x, escape.y, futureDanger, false);
        if (step) { ps.x = step.x; ps.y = step.y; ps.facingDir = step.dir; }
        return;
      }
    }
  }

  // ── 4. Pick target: nearby powerup on open path, else nearest enemy ──
  let target = null;
  let bestDist = Infinity;
  for (const [key] of Object.entries(bm.powerupsOnFloor)) {
    const [ky, kx] = key.split(',').map(Number);
    const d = Math.abs(kx - ps.x) + Math.abs(ky - ps.y);
    if (d < 5 && d < bestDist) { bestDist = d; target = { x: kx, y: ky }; }
  }
  if (!target) {
    for (const [epid, ep] of Object.entries(bm.players)) {
      if (epid === botId || !ep.alive) continue;
      const d = Math.abs(ep.x - ps.x) + Math.abs(ep.y - ps.y);
      if (d < bestDist) { bestDist = d; target = { x: ep.x, y: ep.y }; }
    }
  }
  if (!target) return;

  // ── Navigation danger: all active bomb blast zones (any fuse), not just urgent ──
  // dangerMap only covers <2500ms fuse, so without navDanger the bot happily
  // walks back into the blast zone of its freshly placed bomb every tick.
  const navDanger = new Set(dangerMap);
  for (const b of bm.bombs) {
    bmBotBlastCells(bm, b.x, b.y, b.radius).forEach(c => navDanger.add(c.x + ',' + c.y));
  }

  // ── 5. Try direct floor-only path first ───────────────────────
  const directStep = bmBotNextStep(bm, ps.x, ps.y, target.x, target.y, navDanger, true);
  if (directStep) {
    ps.x = directStep.x; ps.y = directStep.y; ps.facingDir = directStep.dir;
    return;
  }

  // ── 6. No open path — wall-passthrough BFS to find direction ──
  // This finds the shortest path treating soft walls as passable, then:
  //   • If next cell is a soft wall → bomb it (and flee) to create a corridor
  //   • If next cell is floor → move there (longer detour around walls)
  const wallStep = bmBotPathThroughWalls(bm, ps.x, ps.y, target.x, target.y);
  if (!wallStep) return;

  if (wallStep.isWall) {
    // The soft wall is directly in our way — bomb it if we can escape
    if (canBomb) {
      const blastCells = bmBotBlastCells(bm, ps.x, ps.y, ps.bombRadius);
      const hitsWall = blastCells.some(c => bm.grid[c.y][c.x] === 2);
      if (hitsWall) {
        const futureDanger = new Set(dangerMap);
        blastCells.forEach(c => futureDanger.add(c.x + ',' + c.y));
        const escape = bmBotFindSafeCell(bm, ps.x, ps.y, futureDanger);
        if (escape) {
          bmPlaceBomb(room, botId);
          const step = bmBotNextStep(bm, ps.x, ps.y, escape.x, escape.y, futureDanger, false);
          if (step) { ps.x = step.x; ps.y = step.y; ps.facingDir = step.dir; }
          return;
        }
      }
    }
    // Can't bomb right now — face the wall and wait for bomb cooldown
    ps.facingDir = wallStep.dir;
  } else {
    // Detour through floor cells — only move if the cell is not inside a bomb blast zone
    if (!navDanger.has(wallStep.x + ',' + wallStep.y)) {
      ps.x = wallStep.x; ps.y = wallStep.y; ps.facingDir = wallStep.dir;
    } else {
      ps.facingDir = wallStep.dir; // face the direction but wait for blast to clear
    }
  }
}

// BFS that passes through soft walls (treats them as floor for planning).
// Returns the first step info including isWall flag.
function bmBotPathThroughWalls(bm, startX, startY, goalX, goalY) {
  if (startX === goalX && startY === goalY) return null;
  const visited = new Map([[startX + ',' + startY, null]]);
  const queue = [{ x: startX, y: startY }];
  while (queue.length) {
    const cur = queue.shift();
    if (cur.x === goalX && cur.y === goalY) {
      let node = cur;
      let prev = visited.get(node.x + ',' + node.y);
      while (prev !== null) {
        const pp = visited.get(prev.x + ',' + prev.y);
        if (pp === null) {
          const dx = node.x - startX, dy = node.y - startY;
          const dir = dx === 1 ? 'right' : dx === -1 ? 'left' : dy === 1 ? 'down' : 'up';
          const isWall = bm.grid[node.y][node.x] === 2;
          return { x: node.x, y: node.y, dir, isWall };
        }
        node = prev; prev = pp;
      }
      return null;
    }
    for (const [ddx, ddy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
      const nx = cur.x + ddx, ny = cur.y + ddy;
      const k = nx + ',' + ny;
      if (visited.has(k)) continue;
      if (nx < 0 || nx >= BM_COLS || ny < 0 || ny >= BM_ROWS) continue;
      if (bm.grid[ny][nx] === 1) continue; // hard walls always block
      visited.set(k, cur);
      queue.push({ x: nx, y: ny });
    }
  }
  return null;
}

function bmBotBlastCells(bm, bx, by, radius) {
  const cells = [{ x: bx, y: by }];
  for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
    for (let i = 1; i <= radius; i++) {
      const nx = bx + dx * i, ny = by + dy * i;
      if (nx < 0 || nx >= BM_COLS || ny < 0 || ny >= BM_ROWS) break;
      if (bm.grid[ny][nx] === 1) break;
      cells.push({ x: nx, y: ny });
      if (bm.grid[ny][nx] === 2) break;
    }
  }
  return cells;
}

function bmBotCanStep(bm, nx, ny) {
  if (nx < 0 || nx >= BM_COLS || ny < 0 || ny >= BM_ROWS) return false;
  if (bm.grid[ny][nx] !== 0) return false;
  if (bm.bombs.some(b => b.x === nx && b.y === ny)) return false;
  return true;
}

// BFS: find nearest reachable cell NOT in dangerMap (excluding start)
function bmBotFindSafeCell(bm, startX, startY, dangerMap) {
  const visited = new Set([startX + ',' + startY]);
  const queue = [{ x: startX, y: startY }];
  while (queue.length) {
    const { x, y } = queue.shift();
    if (!dangerMap.has(x + ',' + y) && (x !== startX || y !== startY)) return { x, y };
    for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
      const nx = x + dx, ny = y + dy;
      const k = nx + ',' + ny;
      if (visited.has(k) || !bmBotCanStep(bm, nx, ny)) continue;
      visited.add(k);
      queue.push({ x: nx, y: ny });
    }
  }
  return null;
}

// BFS path: return {x, y, dir} of first step from start toward (goalX, goalY)
function bmBotNextStep(bm, startX, startY, goalX, goalY, dangerMap, avoidDanger) {
  const visited = new Map([[startX + ',' + startY, null]]);
  const queue = [{ x: startX, y: startY }];
  while (queue.length) {
    const cur = queue.shift();
    if (cur.x === goalX && cur.y === goalY) {
      // Trace back to find the first step
      let node = cur;
      let prev = visited.get(node.x + ',' + node.y);
      while (prev !== null) {
        const pp = visited.get(prev.x + ',' + prev.y);
        if (pp === null) {
          // prev is start — node is the first step
          const dx = node.x - startX, dy = node.y - startY;
          return { x: node.x, y: node.y, dir: dx === 1 ? 'right' : dx === -1 ? 'left' : dy === 1 ? 'down' : 'up' };
        }
        node = prev;
        prev = pp;
      }
      return null; // start === goal
    }
    for (const [dx, dy] of [[0,-1],[0,1],[-1,0],[1,0]]) {
      const nx = cur.x + dx, ny = cur.y + dy;
      const k = nx + ',' + ny;
      if (visited.has(k)) continue;
      if (!bmBotCanStep(bm, nx, ny)) continue;
      if (avoidDanger && dangerMap.has(k)) continue;
      visited.set(k, cur);
      queue.push({ x: nx, y: ny });
    }
  }
  return null;
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

// ── Barricade (Malefiz) helpers ──────────────────────────────────

// ── Barricade v2 (Quoridor-style) helpers ──────────────────────────
const BAR2_GRID = 9, BAR2_MAX_WALLS = 10;
const BAR2_DIRS = [[0,1],[0,-1],[1,0],[-1,0]];

function startBarricade2(room) {
  const playerIds = [...room.players.keys()].slice(0, 2);
  const names = playerIds.map(pid => room.players.get(pid)?.name || 'Player');
  const bar = {
    active: true,
    players: [
      { id: playerIds[0], row: 0, col: 4, wallsLeft: BAR2_MAX_WALLS, goalRow: BAR2_GRID - 1 },
      { id: playerIds[1], row: BAR2_GRID - 1, col: 4, wallsLeft: BAR2_MAX_WALLS, goalRow: 0 }
    ],
    walls: [],
    turnOrder: playerIds,
    turnIdx: 0,
  };
  room.barricade = bar;
  room.status = 'playing';
  broadcastLobby();
  for (const [pid, p] of room.players) {
    const yourIdx = pid === playerIds[0] ? 0 : pid === playerIds[1] ? 1 : -1;
    send(p.ws, {
      type: 'bar2-start',
      yourIdx,
      players: [
        { name: names[0], row: bar.players[0].row, col: bar.players[0].col, wallsLeft: bar.players[0].wallsLeft, goalRow: bar.players[0].goalRow },
        { name: names[1], row: bar.players[1].row, col: bar.players[1].col, wallsLeft: bar.players[1].wallsLeft, goalRow: bar.players[1].goalRow }
      ],
      walls: [],
      currentPlayer: 0,
    });
  }
  log('info', 'bar2-start', { roomId: room.id, players: names });
}

function bar2AdvanceTurn(bar) {
  bar.turnIdx = 1 - bar.turnIdx;
}

function bar2CanPass(walls, r1, c1, r2, c2) {
  for (const w of walls) {
    if (w.type === 'h') {
      if (r2 === r1 + 1 && c1 === c2 && w.r === r1 && (w.c === c1 || w.c === c1 - 1)) return false;
      if (r2 === r1 - 1 && c1 === c2 && w.r === r1 - 1 && (w.c === c1 || w.c === c1 - 1)) return false;
    }
    if (w.type === 'v') {
      if (c2 === c1 + 1 && r1 === r2 && w.c === c1 && (w.r === r1 || w.r === r1 - 1)) return false;
      if (c2 === c1 - 1 && r1 === r2 && w.c === c1 - 1 && (w.r === r1 || w.r === r1 - 1)) return false;
    }
  }
  return true;
}

function bar2GetValidMoves(bar, pidx) {
  const p = bar.players[pidx], opp = bar.players[1 - pidx], moves = [];
  for (const [dr, dc] of BAR2_DIRS) {
    const nr = p.row + dr, nc = p.col + dc;
    if (nr < 0 || nr >= BAR2_GRID || nc < 0 || nc >= BAR2_GRID) continue;
    if (!bar2CanPass(bar.walls, p.row, p.col, nr, nc)) continue;
    if (nr === opp.row && nc === opp.col) {
      const jr = nr + dr, jc = nc + dc;
      if (jr >= 0 && jr < BAR2_GRID && jc >= 0 && jc < BAR2_GRID && bar2CanPass(bar.walls, nr, nc, jr, jc)) {
        moves.push({ row: jr, col: jc });
      } else {
        for (const [dr2, dc2] of BAR2_DIRS) {
          if (dr2 === -dr && dc2 === -dc) continue;
          const sr = nr + dr2, sc = nc + dc2;
          if (sr < 0 || sr >= BAR2_GRID || sc < 0 || sc >= BAR2_GRID) continue;
          if (sr === p.row && sc === p.col) continue;
          if (!bar2CanPass(bar.walls, nr, nc, sr, sc)) continue;
          moves.push({ row: sr, col: sc });
        }
      }
    } else {
      moves.push({ row: nr, col: nc });
    }
  }
  return moves;
}

function bar2Bfs(walls, sr, sc, goalRow) {
  const visited = new Set();
  const queue = [[sr, sc]];
  visited.add(sr * BAR2_GRID + sc);
  while (queue.length > 0) {
    const [r, c] = queue.shift();
    if (r === goalRow) return true;
    for (const [dr, dc] of BAR2_DIRS) {
      const nr = r + dr, nc = c + dc;
      if (nr < 0 || nr >= BAR2_GRID || nc < 0 || nc >= BAR2_GRID) continue;
      if (visited.has(nr * BAR2_GRID + nc)) continue;
      if (!bar2CanPass(walls, r, c, nr, nc)) continue;
      visited.add(nr * BAR2_GRID + nc);
      queue.push([nr, nc]);
    }
  }
  return false;
}

function bar2IsWallValid(bar, type, r, c) {
  if (r < 0 || r >= BAR2_GRID - 1 || c < 0 || c >= BAR2_GRID - 1) return false;
  for (const w of bar.walls) {
    if (w.type === type && w.r === r && w.c === c) return false;
    if (w.type !== type && w.r === r && w.c === c) return false;
    if (w.type === 'h' && type === 'h' && w.r === r && Math.abs(w.c - c) === 1) return false;
    if (w.type === 'v' && type === 'v' && w.c === c && Math.abs(w.r - r) === 1) return false;
  }
  return true;
}

function bar2WouldBlock(bar, type, r, c) {
  const testWalls = [...bar.walls, { type, r, c }];
  for (let i = 0; i < 2; i++) {
    if (!bar2Bfs(testWalls, bar.players[i].row, bar.players[i].col, bar.players[i].goalRow)) return true;
  }
  return false;
}

// ── Tower Defense ────────────────────────────────────────────────
const TD_COLS = 20, TD_ROWS = 15;
const TD_TICK_MS = 50;            // 20 ticks/sec
const TD_COUNTDOWN_MS = 3000;
const TD_SEND_REBATE = 5;
// Defaults (game modes override these)
const TD_PREP_MS = 15000;
const TD_FIRST_PREP_MS = 12000;
const TD_START_GOLD = 150;
const TD_START_HP = 20;
const TD_INCOME = 10;
const TD_INCOME_INTERVAL = 5000;
const TD_WAVE_CLEAR_BONUS = 20;

// ── Bot AI ────────────────────────────────────────────────────────────────────
const TD_BOT_NAMES    = ['Alaric','Seraph','Kira','Dex','Voss','Nyx','Colt','Zeta'];
const TD_BOT_THINK_MS = 1800;   // base ms between decisions
const TD_BOT_JITTER   = 1600;   // extra random ms added — total think gap 1.8s–3.4s

// Six personality archetypes; one is picked at match-start and noised ± 0.1
const TD_BOT_ARCHETYPES = [
  { name:'Rusher',    aggression:0.88, thrift:0.15, upgradeWeight:0.28 },
  { name:'Fortifier', aggression:0.22, thrift:0.42, upgradeWeight:0.82 },
  { name:'Economist', aggression:0.38, thrift:0.78, upgradeWeight:0.52 },
  { name:'Balanced',  aggression:0.52, thrift:0.44, upgradeWeight:0.56 },
  { name:'Blitzer',   aggression:0.92, thrift:0.08, upgradeWeight:0.22 },
  { name:'Turtle',    aggression:0.12, thrift:0.68, upgradeWeight:0.78 },
];

// Score every buildable cell for every affordable tower — returns { score, type, x, y }
function tdBotBestBuild(td, lane) {
  const rng = Math.random;
  // Sample candidate tiles (human-like: don't exhaustively search the map)
  const sampleN = 30 + Math.floor(rng() * 25);
  const cells = [];
  for (let i = 0; i < sampleN; i++) {
    const x = 1 + Math.floor(rng() * (TD_COLS - 2));
    const y = 1 + Math.floor(rng() * (TD_ROWS - 2));
    if (tdIsBuildable(td, x, y) && !lane.towers.some(t => t.x === x && t.y === y)) cells.push({x, y});
  }
  if (!cells.length) return null;

  const existTypes = new Set(lane.towers.map(t => t.type));
  let best = null, bestScore = 0;

  for (const [type, def] of Object.entries(TD_TOWERS)) {
    if (lane.gold < def.levels[0].cost) continue;
    const range = def.levels[0].range;
    const variety = existTypes.has(type) ? 0.7 : 1.2; // reward diversification

    for (const {x, y} of cells) {
      let coverage = 0, maxLate = 0;
      for (let i = 0; i < td.path.length; i++) {
        const p = td.path[i];
        const d = Math.sqrt((p.x - x) ** 2 + (p.y - y) ** 2);
        if (d <= range) { coverage++; maxLate = Math.max(maxLate, i / td.pathLen); }
      }
      if (!coverage) continue;
      const score = coverage * (0.55 + maxLate * 1.45) * variety * (0.82 + rng() * 0.36);
      if (score > bestScore) { bestScore = score; best = { type, x, y }; }
    }
  }
  return bestScore > 0 ? { score: bestScore, ...best } : null;
}

// Score the best upgrade available — returns { score, towerId } or null
function tdBotBestUpgrade(td, lane) {
  let best = null, bestScore = 0;
  for (const tower of lane.towers) {
    const def = TD_TOWERS[tower.type];
    if (tower.level >= def.levels.length) continue;
    const cost = def.levels[tower.level].cost;
    if (lane.gold < cost) continue;
    // Efficiency: kills earned per gold invested, with level-depth bonus
    const eff = (tower.kills || 0) / Math.max(1, tower.invested);
    const score = (eff * 800 + 1) * (1 + 0.25 * tower.level) * (0.75 + Math.random() * 0.5);
    if (score > bestScore) { bestScore = score; best = { score, towerId: tower.id }; }
  }
  return best;
}

// Best perk to buy — returns { score, towerId, perkId } or null
function tdBotBestPerk(td, lane) {
  let best = null, bestScore = 0;
  for (const tower of lane.towers) {
    for (const perk of (TD_PERKS[tower.type] || [])) {
      if ((tower.perks || []).includes(perk.id)) continue;
      if (lane.gold < perk.cost) continue;
      // Perks valued more on high-kill towers; scaled by wave progress
      const score = ((tower.kills || 0) + 5) / perk.cost * (0.8 + Math.random() * 0.4);
      if (score > bestScore) { bestScore = score; best = { score, towerId: tower.id, perkId: perk.id }; }
    }
  }
  return best;
}

// Main bot think function — called from tdTick at throttled intervals
function tdBotThink(room) {
  const td = room.td;
  const pid = td.botId;
  const lane = td.lanes[pid];
  if (!lane || !lane.alive) return;
  const now = Date.now();
  if (now < (td.botNextThink || 0)) return;

  // Irregular human-like think cadence
  td.botNextThink = now + TD_BOT_THINK_MS + Math.floor(Math.random() * TD_BOT_JITTER);

  // 13% hesitation — bot "thinks" but doesn't act this tick
  if (Math.random() < 0.13) return;

  const p = td.botPersonality;

  // ── Always check sending during wave ──
  if (lane.phase === 'wave') {
    let bestPkg = -1;
    for (let i = 0; i < TD_SEND_PACKAGES.length; i++) if (lane.sendMeter >= TD_SEND_PACKAGES[i].pts) bestPkg = i;
    if (bestPkg >= 0) {
      // Aggression roll: aggressive bots send at lower thresholds
      const rollNeeded = (1 - p.aggression) * 0.75; // 0=always send, 0.75=rarely send
      if (Math.random() > rollNeeded) {
        const targets = td.order.filter(q => q !== pid && td.lanes[q] && td.lanes[q].alive);
        if (targets.length) {
          const tgt = targets[Math.floor(Math.random() * targets.length)];
          tdSendEnemies(room, pid, bestPkg, tgt);
        }
      }
    }
  }

  // ── Gold threshold: thrifty bots wait for more gold before building ──
  const spendFloor = 100 + p.thrift * 250; // 100g (Blitzer) – 295g (Economist)
  if (lane.gold < spendFloor && lane.towers.length > 0) return;

  // ── Decide: build / upgrade / perk via noisy weighted comparison ──
  const build   = tdBotBestBuild(td, lane);
  const upgrade = tdBotBestUpgrade(td, lane);
  const perk    = (lane.wave >= 3) ? tdBotBestPerk(td, lane) : null;

  const bScore  = build   ? build.score   * (0.9 + Math.random() * 0.2)                      : 0;
  const uScore  = upgrade ? upgrade.score * (0.9 + Math.random() * 0.2) * (0.4 + p.upgradeWeight * 0.8) : 0;
  const pkScore = perk    ? perk.score    * (0.9 + Math.random() * 0.2) * (lane.wave / 8)     : 0;

  if (bScore <= 0 && uScore <= 0 && pkScore <= 0) return;

  if (uScore >= bScore && uScore >= pkScore && upgrade) {
    tdUpgradeTower(room, pid, upgrade.towerId);
  } else if (pkScore >= bScore && pkScore >= uScore && perk) {
    tdBuyPerk(room, pid, perk.towerId, perk.perkId);
  } else if (build) {
    tdPlaceTower(room, pid, build.type, build.x, build.y);
  }
}

// Expand orthogonal waypoints (each segment horizontal or vertical) into a full adjacent-cell path.
// ── Procedural path generator (seeded) ──────────────────────────────────────
// Zigzag bands with random turn depths, row gaps, and occasional short detours.
// Guaranteed: non-self-intersecting, all cells in-bounds, strictly adjacent.
function tdGenerateProceduralPath(seed) {
  let s = ((seed ^ 2463534242) >>> 0) || 1;
  function rng() { s ^= s << 13; s ^= s >> 17; s ^= s << 5; return (s >>> 0) / 4294967296; }
  function ri(a, b) { return a + Math.floor(rng() * (b - a + 1)); }

  const MX = TD_COLS - 2, MY = TD_ROWS - 2; // usable range 1..18, 1..13
  const out = [];
  const vis = new Set();
  function push(x, y) {
    const k = y * TD_COLS + x;
    if (x >= 1 && x <= MX && y >= 1 && y <= MY && !vis.has(k)) { out.push({x, y}); vis.add(k); return true; }
    return false;
  }

  let x = 1, y = ri(1, 3);
  push(x, y);
  let right = true;

  // Main band loop — each iteration does one horizontal run + vertical drop.
  // Randomised turn depth and row-gap guarantee non-self-intersecting paths.
  while (y < MY) {
    // How far to go this band (don't always reach the wall for variety)
    const tX = right ? ri(MX - 5, MX) : ri(1, 6);
    const dx = right ? 1 : -1;
    // Main horizontal run
    while (x !== tX) { x += dx; push(x, y); }
    // Vertical drop (random 1-4 rows)
    const drop = ri(1, Math.min(4, MY - y));
    for (let i = 0; i < drop; i++) { y++; push(x, y); }
    right = !right;
  }

  // Reach the bottom if not already there
  while (y < MY) { y++; push(x, y); }
  // Final horizontal to right side
  const fx = ri(MX - 4, MX);
  const fdx = x < fx ? 1 : -1;
  while (x !== fx) { x += fdx; push(x, y); }

  return out;
}

function tdExpand(waypoints) {
  const path = [{ x: waypoints[0].x, y: waypoints[0].y }];
  for (let i = 1; i < waypoints.length; i++) {
    const a = waypoints[i - 1], b = waypoints[i];
    const dx = Math.sign(b.x - a.x), dy = Math.sign(b.y - a.y);
    let cx = a.x, cy = a.y;
    while (cx !== b.x || cy !== b.y) { cx += dx; cy += dy; path.push({ x: cx, y: cy }); }
  }
  return path;
}
function tdBuildSerpent() {
  const path = [];
  const bands = [1, 3, 5, 7, 9, 11, 13]; // 7 horizontal bands
  for (let i = 0; i < bands.length; i++) {
    const y = bands[i];
    if (i % 2 === 0) { for (let x = 1; x <= 18; x++) path.push({ x, y }); }
    else { for (let x = 18; x >= 1; x--) path.push({ x, y }); }
    if (i < bands.length - 1) { const x = (i % 2 === 0) ? 18 : 1; path.push({ x, y: y + 1 }); path.push({ x, y: y + 2 }); }
  }
  return path;
}

// ── Maps ── each a distinct enemy route. Entrance = path[0], base = last cell.
const TD_MAPS = {
  serpent:    { name: 'Serpentine', desc: 'Classic 7-band weave — balanced.', path: tdBuildSerpent() },
  switchback: { name: 'Switchback', desc: 'Long open lanes — snipers thrive.',
    path: tdExpand([{x:1,y:1},{x:18,y:1},{x:18,y:5},{x:1,y:5},{x:1,y:9},{x:18,y:9},{x:18,y:13},{x:1,y:13}]) },
  spiral:     { name: 'Spiral', desc: 'Coils inward to the core — splash heaven.',
    path: tdExpand([{x:1,y:1},{x:18,y:1},{x:18,y:13},{x:1,y:13},{x:1,y:3},{x:16,y:3},{x:16,y:11},{x:3,y:11},{x:3,y:5},{x:14,y:5},{x:14,y:9},{x:5,y:9},{x:5,y:7},{x:12,y:7}]) },
  labyrinth:  { name: 'Labyrinth', desc: 'Tight comb — slows & AoE shine.',
    path: tdExpand([{x:1,y:1},{x:1,y:13},{x:3,y:13},{x:3,y:1},{x:5,y:1},{x:5,y:13},{x:7,y:13},{x:7,y:1},{x:9,y:1},{x:9,y:13},{x:11,y:13},{x:11,y:1},{x:13,y:1},{x:13,y:13},{x:15,y:13},{x:15,y:1},{x:17,y:1},{x:17,y:13}]) },
  // Procedural maps (seeded — same layout each game)
  delta:      { name: 'Delta', desc: 'Procedural meander — organic river bends.',    path: tdGenerateProceduralPath(0x1A2B3C4D) },
  canyon:     { name: 'Canyon', desc: 'Procedural gorge — deep flanking corridors.', path: tdGenerateProceduralPath(0xDEADBEEF) },
  ruins:      { name: 'Ruins', desc: 'Procedural ruins — chaotic broken passages.', path: tdGenerateProceduralPath(0xC0FFEE42) },
  // Special: regenerated fresh every match
  random:     { name: 'Random', desc: 'New procedural maze every game!', path: [] /* overridden at match start */ },
};
const TD_MAP_KEYS = Object.keys(TD_MAPS);
const TD_PATH = TD_MAPS.serpent.path;        // default / back-compat
const TD_PATH_LEN = TD_PATH.length;
function tdPathSet(path) { return new Set(path.map(p => p.y * TD_COLS + p.x)); }

// ── Game modes ── each tweaks economy, pacing and enemy stats.
const TD_MODES = {
  classic:  { name:'Classic',      icon:'🏰', desc:'Standard survival. Build, defend, send.',
    startGold:150, startHp:20, income:10, incomeIntervalMs:5000, prepMs:15000, firstPrepMs:12000, hpMul:1,    speedMul:1,    rewardMul:1,    sendMul:1,   sizeMul:1,    clearBonus:20 },
  blitz:    { name:'Blitz',        icon:'⚡', desc:'Short prep, rapid waves, fat income.',
    startGold:210, startHp:20, income:16, incomeIntervalMs:4000, prepMs:8000,  firstPrepMs:8000,  hpMul:0.9,  speedMul:1.35, rewardMul:1.1,  sendMul:1.2, sizeMul:1.15, clearBonus:25 },
  ironman:  { name:'Sudden Death', icon:'💀', desc:'Start at 3 HP. Every leak stings.',
    startGold:280, startHp:3,  income:15, incomeIntervalMs:4000, prepMs:14000, firstPrepMs:14000, hpMul:1,    speedMul:1,    rewardMul:1.2,  sendMul:1,   sizeMul:1,    clearBonus:35 },
  goldrush: { name:'Gold Rush',    icon:'💰', desc:'Booming economy vs beefy hordes.',
    startGold:320, startHp:25, income:24, incomeIntervalMs:4000, prepMs:15000, firstPrepMs:12000, hpMul:1.55, speedMul:1,    rewardMul:1.85, sendMul:1,   sizeMul:1.25, clearBonus:45 },
  bossrush: { name:'Boss Rush',    icon:'👑', desc:'Elites & bosses every single wave.',
    startGold:260, startHp:20, income:14, incomeIntervalMs:4500, prepMs:16000, firstPrepMs:14000, hpMul:1.1,  speedMul:1,    rewardMul:1.35, sendMul:1,   sizeMul:0.7,  clearBonus:30, everyWaveBoss:true },
  chaos:    { name:'Chaos',        icon:'🎲', desc:'A random twist every wave.',
    startGold:210, startHp:20, income:12, incomeIntervalMs:5000, prepMs:13000, firstPrepMs:12000, hpMul:1,    speedMul:1,    rewardMul:1.1,  sendMul:1.1, sizeMul:1,    clearBonus:25, chaos:true },
};
const TD_MODE_KEYS = Object.keys(TD_MODES);
const TD_CHAOS_TWISTS = [
  { label:'Calm Wave',       hpMul:1,    speedMul:1,    rewardMul:1,   sizeMul:1 },
  { label:'Swarm!',          hpMul:0.75, speedMul:1.05, rewardMul:0.9, sizeMul:1.8 },
  { label:'Juggernauts',     hpMul:1.9,  speedMul:0.8,  rewardMul:1.5, sizeMul:0.8 },
  { label:'Frenzy',          hpMul:0.8,  speedMul:1.7,  rewardMul:1.1, sizeMul:1 },
  { label:'Gilded Horde',    hpMul:1.25, speedMul:1,    rewardMul:2.0, sizeMul:1 },
  { label:'Glass Cannons',   hpMul:0.45, speedMul:1.5,  rewardMul:0.9, sizeMul:1.4 },
  { label:'Iron Tide',       hpMul:1.5,  speedMul:1.1,  rewardMul:1.3, sizeMul:1.1 },
  { label:'Blitz Storm',     hpMul:0.6,  speedMul:2.2,  rewardMul:0.85,sizeMul:1.3 },
  { label:'Nightmare',       hpMul:2.5,  speedMul:1.1,  rewardMul:2.0, sizeMul:0.9 },
  { label:'Phantom Army',    hpMul:1,    speedMul:1.2,  rewardMul:1.3, sizeMul:1,   typeOverride:'cloaker' },
  { label:'Air Raid!',       hpMul:0.9,  speedMul:1.4,  rewardMul:1.1, sizeMul:2,   typeOverride:'flyer' },
  { label:'Endless Tide',    hpMul:0.7,  speedMul:1,    rewardMul:0.8, sizeMul:3.0 },
  { label:'Splitter Wave',   hpMul:1.1,  speedMul:1,    rewardMul:1.2, sizeMul:1,   typeOverride:'splitter' },
  { label:'Regen Horde',     hpMul:1,    speedMul:0.9,  rewardMul:1.4, sizeMul:1.2, typeOverride:'regenerator' },
];

// Enemy definitions. armor reduces physical, magicRes reduces magic (negative = weakness).
// Special flags: flying (antiAir towers only), cloaked (reveals towers only),
//   blink (teleports forward), regenHps (heals per sec), splitInto (spawns on death).
const TD_ENEMIES = {
  grunt:       { name:'Grunt',      hp:60,   speed:1.7,  armor:0.0,  magicRes:0.0,  slowImmune:false, reward:10,  sendPts:1,  baseDmg:1 },
  runner:      { name:'Runner',     hp:40,   speed:3.4,  armor:0.0,  magicRes:0.0,  slowImmune:false, reward:8,   sendPts:1,  baseDmg:1 },
  brute:       { name:'Brute',      hp:240,  speed:1.1,  armor:0.3,  magicRes:0.0,  slowImmune:false, reward:25,  sendPts:3,  baseDmg:1 },
  armored:     { name:'Armored',    hp:150,  speed:1.5,  armor:0.6,  magicRes:-0.3, slowImmune:false, reward:20,  sendPts:3,  baseDmg:1 },
  phantom:     { name:'Phantom',    hp:110,  speed:2.8,  armor:0.0,  magicRes:0.0,  slowImmune:true,  reward:18,  sendPts:2,  baseDmg:1 },
  boss:        { name:'Boss',       hp:2600, speed:0.85, armor:0.4,  magicRes:0.4,  slowImmune:false, reward:100, sendPts:10, baseDmg:10 },
  // New types
  splitling:   { name:'Splitling',  hp:35,   speed:2.8,  armor:0.0,  magicRes:0.0,  slowImmune:false, reward:3,   sendPts:0,  baseDmg:1 },
  splitter:    { name:'Splitter',   hp:280,  speed:1.3,  armor:0.2,  magicRes:0.0,  slowImmune:false, reward:30,  sendPts:4,  baseDmg:1, splitInto:['splitling','splitling','splitling'] },
  cloaker:     { name:'Cloaker',    hp:120,  speed:2.1,  armor:0.0,  magicRes:0.2,  slowImmune:false, reward:22,  sendPts:3,  baseDmg:1, cloaked:true },
  flyer:       { name:'Flyer',      hp:65,   speed:4.5,  armor:0.0,  magicRes:0.0,  slowImmune:true,  reward:14,  sendPts:2,  baseDmg:1, flying:true },
  colossus:    { name:'Colossus',   hp:5500, speed:0.65, armor:0.6,  magicRes:0.4,  slowImmune:false, reward:200, sendPts:20, baseDmg:3 },
  blinker:     { name:'Blinker',    hp:80,   speed:1.6,  armor:0.0,  magicRes:0.2,  slowImmune:true,  reward:24,  sendPts:3,  baseDmg:1, blink:true },
  regenerator: { name:'Regen',      hp:400,  speed:1.1,  armor:0.25, magicRes:0.0,  slowImmune:false, reward:45,  sendPts:5,  baseDmg:1, regenHps:20 },
};

// Tower definitions per level (index 0 = level 1). cost = build/upgrade cost for that level.
const TD_TOWERS = {
  arrow: {
    name: 'Arrow', dmgClass: 'physical', behavior: 'single', antiAir: true,
    superName: 'Ballista',
    levels: [
      { cost: 50,  damage: 14,   range: 3.0, fireMs: 480 },
      { cost: 45,  damage: 26,   range: 3.3, fireMs: 420 },
      { cost: 75,  damage: 44,   range: 3.6, fireMs: 350 },
      { cost: 350, damage: 200,  range: 5.0, fireMs: 200 },
    ],
  },
  cannon: {
    name: 'Cannon', dmgClass: 'physical', behavior: 'splash',
    superName: 'Siege Engine',
    levels: [
      { cost: 100, damage: 45,  range: 2.6, fireMs: 1300, splash: 1.3 },
      { cost: 85,  damage: 80,  range: 2.7, fireMs: 1200, splash: 1.5 },
      { cost: 150, damage: 135, range: 2.9, fireMs: 1050, splash: 1.7 },
      { cost: 400, damage: 420, range: 3.5, fireMs: 800,  splash: 2.8 },
    ],
  },
  frost: {
    name: 'Frost', dmgClass: 'none', behavior: 'frost',
    superName: 'Blizzard',
    levels: [
      { cost: 80,  damage: 0, range: 2.8, fireMs: 700, slow: 0.4, slowMs: 2000 },
      { cost: 65,  damage: 0, range: 3.0, fireMs: 700, slow: 0.5, slowMs: 2000 },
      { cost: 110, damage: 0, range: 3.3, fireMs: 700, slow: 0.6, slowMs: 2500 },
      { cost: 350, damage: 0, range: 5.0, fireMs: 500, slow: 0.8, slowMs: 4000 },
    ],
  },
  tesla: {
    name: 'Tesla', dmgClass: 'magic', behavior: 'chain', antiAir: true,
    superName: 'Storm Spire',
    levels: [
      { cost: 150, damage: 24,  range: 3.0, fireMs: 700, chains: 4 },
      { cost: 115, damage: 38,  range: 3.2, fireMs: 650, chains: 5 },
      { cost: 185, damage: 58,  range: 3.4, fireMs: 600, chains: 6 },
      { cost: 450, damage: 200, range: 4.5, fireMs: 380, chains: 16 },
    ],
  },
  inferno: {
    name: 'Inferno', dmgClass: 'magic', behavior: 'burn',
    superName: 'Volcano',
    levels: [
      { cost: 120, damage: 0, range: 2.8, fireMs: 500, burn: 9,  burnMs: 3000 },
      { cost: 90,  damage: 0, range: 3.0, fireMs: 500, burn: 15, burnMs: 3000 },
      { cost: 150, damage: 0, range: 3.2, fireMs: 500, burn: 24, burnMs: 3000 },
      { cost: 400, damage: 0, range: 4.2, fireMs: 300, burn: 90, burnMs: 4500 },
    ],
  },
  sniper: {
    name: 'Sniper', dmgClass: 'physical', behavior: 'sniper', antiAir: true, reveals: true,
    superName: 'War Cannon',
    levels: [
      { cost: 180,  damage: 160,  range: 8.0,  fireMs: 3000 },
      { cost: 140,  damage: 300,  range: 8.5,  fireMs: 2600 },
      { cost: 220,  damage: 520,  range: 9.5,  fireMs: 2200 },
      { cost: 550,  damage: 1800, range: 14.0, fireMs: 1500 },
    ],
  },
  missile: {
    name: 'Missile', dmgClass: 'physical', behavior: 'missile', antiAir: true,
    superName: 'MLRS',
    levels: [
      { cost: 140, damage: 55,  range: 3.8, fireMs: 1200, splash: 0.9 },
      { cost: 110, damage: 90,  range: 4.1, fireMs: 1050, splash: 1.1 },
      { cost: 180, damage: 150, range: 4.4, fireMs: 900,  splash: 1.3 },
      { cost: 450, damage: 500, range: 6.0, fireMs: 600,  splash: 2.2 },
    ],
  },
  laser: {
    name: 'Laser', dmgClass: 'true', behavior: 'laser', antiAir: true, reveals: true,
    superName: 'Photon Cannon',
    levels: [
      { cost: 160, damage: 22,  range: 3.5, fireMs: 220 },
      { cost: 130, damage: 38,  range: 3.8, fireMs: 200 },
      { cost: 200, damage: 62,  range: 4.2, fireMs: 180 },
      { cost: 500, damage: 180, range: 5.5, fireMs: 120 },
    ],
  },
  venom: {
    name: 'Venom', dmgClass: 'magic', behavior: 'venom',
    superName: 'Plague Spire',
    levels: [
      { cost: 110, damage: 0, range: 2.7, fireMs: 600, venom: 10, venomMs: 4500 },
      { cost: 90,  damage: 0, range: 3.0, fireMs: 550, venom: 17, venomMs: 5000 },
      { cost: 145, damage: 0, range: 3.3, fireMs: 500, venom: 28, venomMs: 5500 },
      { cost: 380, damage: 0, range: 5.0, fireMs: 350, venom: 100, venomMs: 8000 },
    ],
  },
  railgun: {
    name: 'Railgun', dmgClass: 'physical', behavior: 'railgun', antiAir: true,
    superName: 'Mass Driver',
    levels: [
      { cost: 200, damage: 180,  range: 6.5,  fireMs: 3800 },
      { cost: 175, damage: 340,  range: 7.5,  fireMs: 3200 },
      { cost: 280, damage: 580,  range: 8.5,  fireMs: 2700 },
      { cost: 600, damage: 2200, range: 12.0, fireMs: 1500 },
    ],
  },
};

const TD_PERKS = {
  arrow: [
    { id:'pierce', name:'Piercing Shot',   icon:'➶', cost:120, desc:'Each shot strikes up to 3 enemies.' },
    { id:'eagle',  name:'Eagle Eye',       icon:'👁', cost:140, desc:'+0.8 range · 25% chance for a triple-damage crit.' },
    { id:'rapid',  name:'Rapid Fire',      icon:'💨', cost:130, desc:'Reload 35% faster.' },
  ],
  cannon: [
    { id:'cluster', name:'Cluster Bombs',  icon:'✸',  cost:150, desc:'+0.9 splash radius · +15% damage.' },
    { id:'siege',   name:'Siege Payload',  icon:'🛠', cost:170, desc:'+60% damage to Brutes, Armored & Bosses.' },
    { id:'napalm',  name:'Napalm',         icon:'🔥', cost:160, desc:'Blasts ignite everything hit.' },
  ],
  frost: [
    { id:'permafrost', name:'Permafrost',  icon:'🧊', cost:120, desc:'Stronger slow, lasts far longer.' },
    { id:'shatter',    name:'Shatter',     icon:'💔', cost:150, desc:'Slowed enemies take +25% damage.' },
    { id:'coldsnap',   name:'Cold Snap',   icon:'❄',  cost:200, desc:'12% chance to freeze for 0.8s.' },
  ],
  tesla: [
    { id:'overload', name:'Overload',      icon:'⚡', cost:160, desc:'+2 chain jumps · +20% damage.' },
    { id:'conduct',  name:'Conductor',     icon:'🔗', cost:170, desc:'Each chain jump deals 25% more.' },
    { id:'static',   name:'Static Field',  icon:'🌀', cost:140, desc:'Struck enemies are slowed 25%.' },
  ],
  inferno: [
    { id:'incinerate', name:'Incinerate',  icon:'☄',  cost:180, desc:'+60% burn damage.' },
    { id:'pyro',       name:'Pyromaniac',  icon:'🎇', cost:130, desc:'Burn stacks to 5, ignites two targets.' },
    { id:'wildfire',   name:'Wildfire',    icon:'🌋', cost:160, desc:'Burns spread to a nearby enemy.' },
  ],
  sniper: [
    { id:'armorpierce', name:'Armor Pierce', icon:'🗡', cost:150, desc:'Shots ignore all armor.' },
    { id:'execute',     name:'Executioner',  icon:'☠',  cost:220, desc:'Instakill non-bosses under 18% HP · +40% vs bosses.' },
    { id:'doubletap',   name:'Double Tap',   icon:'⏩', cost:200, desc:'Fires twice per shot.' },
  ],
  missile: [
    { id:'warhead',  name:'Warhead',   icon:'💥', cost:160, desc:'+0.6 splash radius · +40% damage vs flying.' },
    { id:'tracker',  name:'Tracker',   icon:'🔍', cost:140, desc:'+0.8 range · Missiles reveal & target cloakers.' },
    { id:'barrage',  name:'Barrage',   icon:'🚀', cost:180, desc:'Fires 2 missiles simultaneously.' },
  ],
  laser: [
    { id:'prismatic',  name:'Prismatic',   icon:'🌈', cost:180, desc:'Beam chains to 3 total enemies.' },
    { id:'overcharge', name:'Overcharge',  icon:'🔴', cost:160, desc:'Every 5th shot deals triple damage.' },
    { id:'blind',      name:'Blind',       icon:'🕶',  cost:150, desc:'Struck enemies are slowed 40% for 1.5s.' },
  ],
  venom: [
    { id:'corrosive',  name:'Corrosive',   icon:'🧪', cost:150, desc:'Poisoned enemies take +30% physical damage.' },
    { id:'plague',     name:'Plague',      icon:'☣',  cost:170, desc:'Venom spreads to 2 additional enemies.' },
    { id:'neurotoxin', name:'Neurotoxin',  icon:'🧠', cost:140, desc:'Venom slows enemies to 20% movement speed.' },
  ],
  railgun: [
    { id:'penetrator', name:'Penetrator',  icon:'⚫', cost:200, desc:'Shots ignore all armor.' },
    { id:'charged',    name:'Charged',     icon:'⚡', cost:220, desc:'+80% damage · -30% fire rate.' },
    { id:'emp',        name:'EMP Slug',    icon:'📡', cost:180, desc:'Hit enemies are stunned for 1.5s.' },
  ],
};

function tdTowerStats(tower) {
  const def = TD_TOWERS[tower.type];
  const base = def.levels[tower.level - 1];
  const s = {
    damage: base.damage || 0, range: base.range, fireMs: base.fireMs,
    splash: base.splash || 0, slow: base.slow || 0, slowMs: base.slowMs || 0,
    chains: base.chains || 0, burn: base.burn || 0, burnMs: base.burnMs || 0,
    venom: base.venom || 0, venomMs: base.venomMs || 0,
    pierce: 1, crit: 0, critMul: 3, vsBig: 1, napalm: false,
    shatter: false, freezeChance: 0, amplify: 1, staticSlow: 0,
    burnSpread: false, burnStacks: 3, burnTargets: 1,
    armorPierce: false, executeFrac: 0, bossBonus: 1, multishot: 1,
    vsFlying: 1, reveal: !!(def.reveals),
    laserChains: 1, overcharge: false, laserSlow: 0,
    venomTargets: 1, venomStacks: 3, venomCorrosive: false, venomSpread: false, venomSlow: 0,
    emp: false,
  };
  const perks = tower.perks || [];
  for (const id of perks) {
    switch (id) {
      case 'pierce': s.pierce = 3; break;
      case 'eagle':  s.range += 0.8; s.crit = 0.25; break;
      case 'rapid':  s.fireMs = Math.round(s.fireMs * 0.65); break;
      case 'cluster': s.splash += 0.9; s.damage = Math.round(s.damage * 1.15); break;
      case 'siege':   s.vsBig = 1.6; break;
      case 'napalm':  s.napalm = true; break;
      case 'permafrost': s.slow = Math.min(0.85, s.slow + 0.12); s.slowMs = Math.round(s.slowMs * 1.6); break;
      case 'shatter':    s.shatter = true; break;
      case 'coldsnap':   s.freezeChance = 0.12; break;
      case 'overload': s.chains += 2; s.damage = Math.round(s.damage * 1.2); break;
      case 'conduct':  s.amplify = 1.25; break;
      case 'static':   s.staticSlow = 0.25; break;
      case 'incinerate': s.burn = Math.round(s.burn * 1.6); break;
      case 'pyro':       s.burnStacks = 5; s.burnTargets = 2; break;
      case 'wildfire':   s.burnSpread = true; break;
      case 'armorpierce': s.armorPierce = true; break;
      case 'execute':     s.executeFrac = 0.18; s.bossBonus = 1.4; break;
      case 'doubletap':   s.multishot = 2; break;
      case 'warhead':  s.splash += 0.6; s.vsFlying = 1.4; break;
      case 'tracker':  s.range += 0.8; s.fireMs = Math.round(s.fireMs * 0.85); s.reveal = true; break;
      case 'barrage':  s.multishot = 2; break;
      case 'prismatic':  s.laserChains = 3; break;
      case 'overcharge': s.overcharge = true; break;
      case 'blind':      s.laserSlow = 0.4; break;
      case 'corrosive':  s.venomCorrosive = true; break;
      case 'plague':     s.venomSpread = true; s.venomTargets = Math.max(s.venomTargets, 2); break;
      case 'neurotoxin': s.venomSlow = 0.8; break;
      case 'penetrator': s.armorPierce = true; break;
      case 'charged':    s.damage = Math.round(s.damage * 1.8); s.fireMs = Math.round(s.fireMs * 1.3); break;
      case 'emp':        s.emp = true; break;
    }
  }
  return s;
}

const TD_SEND_PACKAGES = [
  { pts: 10,  label: '5 Grunts',               enemies: ['grunt','grunt','grunt','grunt','grunt'] },
  { pts: 20,  label: '3 Runners + Flyer',       enemies: ['runner','runner','runner','flyer'] },
  { pts: 30,  label: '2 Brutes',                enemies: ['brute','brute'] },
  { pts: 40,  label: '3 Blinkers',              enemies: ['blinker','blinker','blinker'] },
  { pts: 55,  label: '2 Cloakers + Armored',    enemies: ['cloaker','cloaker','armored'] },
  { pts: 75,  label: 'Splitter + 2 Runners',    enemies: ['splitter','runner','runner'] },
  { pts: 100, label: '1 Boss',                  enemies: ['boss'] },
  { pts: 140, label: '1 Colossus',              enemies: ['colossus'] },
];

// ── Lane-wide permanent upgrades (bought once each) ──────────────────────────
const TD_LANE_UPGRADES = {
  income:     { name:'Tax Office',     icon:'💰', cost:120, desc:'+6 passive income per interval.' },
  kill_gold:  { name:'Bounty Board',   icon:'🎯', cost:140, desc:'+2g per enemy killed.' },
  wave_bonus: { name:'War Chest',      icon:'🎁', cost:180, desc:'+50g at the start of each wave.' },
  dmg_amp:    { name:'Forge',          icon:'⚒',  cost:150, desc:'All towers deal +15% damage.' },
  range_amp:  { name:'Watchtower',     icon:'🗼', cost:160, desc:'All towers gain +0.5 range.' },
  speed_amp:  { name:'Clockwork',      icon:'⏱', cost:200, desc:'All towers reload 15% faster.' },
  regen:      { name:'Field Hospital', icon:'❤',  cost:180, desc:'Restore 1 HP every 3 clean waves.' },
  send_amp:   { name:'War Machine',    icon:'⚔',  cost:150, desc:'+25% send meter from kills.' },
  boss_bane:  { name:'Giant Slayer',   icon:'🐉', cost:220, desc:'All towers deal +35% damage to Bosses.' },
};
const TD_LANE_UPGRADE_ORDER = ['income','kill_gold','wave_bonus','dmg_amp','range_amp','speed_amp','regen','send_amp','boss_bane'];

// ── Active special abilities (buyable once, triggered by player, have cooldowns) ──
const TD_ABILITIES = {
  airstrike: { name:'Airstrike',  icon:'✈',  cost:350, cooldownMs:90000,  desc:'Deal 500 dmg to every enemy in your lane.' },
  gold_rush:  { name:'Gold Rush', icon:'💎', cost:200, cooldownMs:75000,  desc:'Instantly gain 150g.' },
  fortify:   { name:'Fortify',    icon:'🛡', cost:220, cooldownMs:120000, desc:'All towers +50% damage for 12 sec.' },
  overclock: { name:'Overclock',  icon:'⚡', cost:180, cooldownMs:100000, desc:'Towers fire 60% faster for 10 sec.' },
  repair:    { name:'Repair',     icon:'🔧', cost:300, cooldownMs:180000, desc:'Restore 2 HP to your base.' },
};
const TD_ABILITY_ORDER = ['airstrike','gold_rush','fortify','overclock','repair'];

function tdStartMatch(room, modeKey, mapKey, botEnabled) {
  const mode = TD_MODES[modeKey] || TD_MODES.classic;
  modeKey = TD_MODES[modeKey] ? modeKey : 'classic';

  // Inject a bot player if requested or if only 1 human is present
  if (botEnabled || room.players.size < 2) {
    const botId = 'bot_' + Date.now();
    const archetype = TD_BOT_ARCHETYPES[Math.floor(Math.random() * TD_BOT_ARCHETYPES.length)];
    const noise = () => (Math.random() - 0.5) * 0.2;
    const personality = {
      name: archetype.name,
      aggression:    Math.max(0, Math.min(1, archetype.aggression    + noise())),
      thrift:        Math.max(0, Math.min(1, archetype.thrift        + noise())),
      upgradeWeight: Math.max(0, Math.min(1, archetype.upgradeWeight + noise())),
    };
    const botName = TD_BOT_NAMES[Math.floor(Math.random() * TD_BOT_NAMES.length)] + ' [Bot]';
    // Mock ws — silently swallows all messages
    const botWs = { readyState: 1, send: () => {}, _bot: true };
    room.players.set(botId, { ws: botWs, name: botName, isBot: true });
    room.botMeta = { id: botId, personality, name: botName };
  }

  // Procedural 'random' map: generate a fresh path per match
  let map, path;
  if (mapKey === 'random') {
    const seed = Math.floor(Math.random() * 0xFFFFFFFF) >>> 0;
    path = tdGenerateProceduralPath(seed);
    map = { name: 'Random', desc: `Procedural maze (seed ${seed.toString(16).toUpperCase()})` };
    // mapKey stays 'random' for bookkeeping but we use the fresh path
  } else {
    map = TD_MAPS[mapKey] || TD_MAPS.serpent;
    mapKey = TD_MAPS[mapKey] ? mapKey : 'serpent';
    path = map.path;
  }

  const pathLen = path.length;
  const pathSet = tdPathSet(path);

  const ids = [...room.players.keys()];
  const lanes = {};
  ids.forEach((pid, i) => {
    const laneInitAt = Date.now();
    lanes[pid] = {
      name: room.players.get(pid).name,
      colorIdx: i,
      baseHp: mode.startHp,
      gold: mode.startGold,
      towers: [],
      enemies: [],
      spawnQueue: [],     // [{type, at, muls}]
      sendMeter: 0,
      alive: true,
      damagedThisWave: false,
      killsThisWave: 0,
      sentCount: 0,
      lastIncomeAt: 0,
      // Per-lane wave progression (independent)
      wave: 0,
      phase: 'prep',
      phaseEndsAt: laneInitAt + TD_COUNTDOWN_MS + mode.firstPrepMs,
      nextWaveData: null,
      // Upgrades & abilities
      upgrades: new Set(),
      abilityOwned: new Set(),
      abilityCooldown: {},  // abilityId -> expiresAt timestamp
      abilityActive: {},    // abilityId -> { until } for timed effects
      autoSend: { enabled: false, packageIdx: 0, targeting: 'random' },
      cleanWaves: 0,        // consecutive waves survived without damage (regen tracking)
      amps: { dmg:1, range:0, reload:1, killGold:0, income:0, waveBonus:0, regen:false, sendAmp:1, bossBonus:1 },
    };
  });

  const botMeta = room.botMeta || null;
  delete room.botMeta; // consumed here

  room.td = {
    active: true,
    lanes,
    order: ids,
    nextTowerId: 1,
    nextEnemyId: 1,
    eliminationOrder: [],   // [{id, name, wave, hpAtDeath}] in death order
    tickInterval: null,
    startedAt: Date.now(),
    mode, modeKey, mapKey,
    path, pathLen, pathSet,
    maxHp: mode.startHp,
    botId: botMeta ? botMeta.id : null,
    botPersonality: botMeta ? botMeta.personality : null,
    botNextThink: 0,
  };
  room.status = 'playing';
  broadcastLobby();

  const playersInfo = ids.map((pid, i) => ({
    id: pid, name: lanes[pid].name, colorIdx: i,
    isBot: !!(room.players.get(pid) && room.players.get(pid).isBot),
  }));
  broadcastRoom(room.id, {
    type: 'td-match-start',
    path, cols: TD_COLS, rows: TD_ROWS,
    playersInfo, startGold: mode.startGold, startHp: mode.startHp,
    prepMs: mode.firstPrepMs, countdownMs: TD_COUNTDOWN_MS,
    mode: modeKey, modeName: mode.name, modeIcon: mode.icon, modeDesc: mode.desc,
    map: mapKey, mapName: map.name, mapDesc: map.desc,
  });

  if (room.td.tickInterval) clearInterval(room.td.tickInterval);
  room.td.tickInterval = setInterval(() => tdTick(room), TD_TICK_MS);
}

// Generate the (shared) wave composition for a given wave number.
function tdGenerateWave(waveNum, opts) {
  opts = opts || {};
  const sizeMul = opts.sizeMul || 1;
  const sc = n => Math.max(0, Math.round(n * sizeMul));
  const out = [];
  let t = 0;
  const spawnGap = Math.max(200, 850 - waveNum * 50); // scales harder; min 200ms

  // Themed wave override (chaos mode twists)
  if (opts.typeOverride) {
    const count = sc(5 + Math.floor(waveNum * 1.8));
    for (let i = 0; i < count; i++) { out.push({ type: opts.typeOverride, at: t }); t += spawnGap; }
    if (opts.everyWaveBoss) { out.push({ type: 'boss', at: t + 500 }); }
    else if (waveNum % 5 === 0) { out.push({ type: 'boss', at: t + 500 }); }
    if (waveNum % 15 === 0 && waveNum > 0) out.push({ type: 'colossus', at: t + 1500 });
    return out;
  }

  // Standard escalating composition
  const grunts = sc(3 + Math.floor(waveNum * 1.2));
  for (let i = 0; i < grunts; i++) { out.push({ type: 'grunt', at: t }); t += spawnGap; }
  if (waveNum >= 2) {
    const runners = sc(2 + Math.floor(waveNum * 0.7));
    for (let i = 0; i < runners; i++) { out.push({ type: 'runner', at: t }); t += Math.round(spawnGap * 0.65); }
  }
  if (waveNum >= 3) {
    const brutes = sc(Math.floor(waveNum / 2));
    for (let i = 0; i < brutes; i++) { out.push({ type: 'brute', at: t }); t += Math.round(spawnGap * 1.3); }
  }
  if (waveNum >= 4) {
    const armored = sc(Math.floor(waveNum / 3));
    for (let i = 0; i < armored; i++) { out.push({ type: 'armored', at: t }); t += Math.round(spawnGap * 1.1); }
  }
  if (waveNum >= 5) {
    const phantoms = sc(Math.floor(waveNum / 3));
    for (let i = 0; i < phantoms; i++) { out.push({ type: 'phantom', at: t }); t += spawnGap; }
  }
  if (waveNum >= 6) {
    const flyers = sc(1 + Math.floor((waveNum - 6) * 0.6));
    for (let i = 0; i < flyers; i++) { out.push({ type: 'flyer', at: t }); t += Math.round(spawnGap * 0.7); }
  }
  if (waveNum >= 7) {
    const blinkers = sc(Math.floor((waveNum - 7) * 0.5 + 1));
    for (let i = 0; i < blinkers; i++) { out.push({ type: 'blinker', at: t }); t += Math.round(spawnGap * 0.9); }
  }
  if (waveNum >= 8) {
    const splitters = sc(Math.floor((waveNum - 8) * 0.4 + 1));
    for (let i = 0; i < splitters; i++) { out.push({ type: 'splitter', at: t }); t += Math.round(spawnGap * 1.5); }
  }
  if (waveNum >= 9) {
    const cloakers = sc(Math.floor((waveNum - 9) * 0.5 + 1));
    for (let i = 0; i < cloakers; i++) { out.push({ type: 'cloaker', at: t }); t += spawnGap; }
  }
  if (waveNum >= 10) {
    const regens = sc(Math.floor((waveNum - 10) * 0.4 + 1));
    for (let i = 0; i < regens; i++) { out.push({ type: 'regenerator', at: t }); t += Math.round(spawnGap * 1.4); }
  }
  if (opts.everyWaveBoss) {
    const bosses = 1 + Math.floor(waveNum / 6);
    for (let i = 0; i < bosses; i++) { out.push({ type: 'boss', at: t + 500 + i * 1200 }); }
  } else if (waveNum % 5 === 0) {
    out.push({ type: 'boss', at: t + 500 });
  }
  if (waveNum % 15 === 0 && waveNum > 0) {
    out.push({ type: 'colossus', at: t + 1500 });
  }
  return out;
}

// Recompute lane-level amplifier cache whenever upgrades change.
function tdResolveLaneAmps(lane) {
  const u = lane.upgrades;
  lane.amps = {
    dmg:       u.has('dmg_amp')    ? 1.15 : 1,
    range:     u.has('range_amp')  ? 0.5  : 0,
    reload:    u.has('speed_amp')  ? 0.85 : 1,
    killGold:  u.has('kill_gold')  ? 2    : 0,
    income:    u.has('income')     ? 6    : 0,
    waveBonus: u.has('wave_bonus') ? 50   : 0,
    regen:     u.has('regen'),
    sendAmp:   u.has('send_amp')   ? 1.25 : 1,
    bossBonus: u.has('boss_bane')  ? 1.35 : 1,
  };
}

// Skip the current prep phase — immediately start this player's next wave.
function tdSkipPrep(room, pid) {
  const lane = room.td.lanes[pid];
  if (!lane || !lane.alive || lane.phase !== 'prep') return;
  lane.gold += 20;
  send(room.players.get(pid).ws, { type: 'td-gold', gold: lane.gold });
  send(room.players.get(pid).ws, { type: 'td-skipped', bonus: 20 });
  tdStartLaneWave(room, pid);
}

// Use an active special ability.
function tdUseAbility(room, pid, abilityId) {
  const td = room.td;
  const lane = td.lanes[pid];
  if (!lane || !lane.alive) return;
  const abi = TD_ABILITIES[abilityId];
  if (!abi || !lane.abilityOwned.has(abilityId)) { send(room.players.get(pid).ws, { type: 'td-action-error', reason: 'Ability not unlocked' }); return; }
  const now = Date.now();
  if (lane.abilityCooldown[abilityId] && now < lane.abilityCooldown[abilityId]) {
    const rem = Math.ceil((lane.abilityCooldown[abilityId] - now) / 1000);
    send(room.players.get(pid).ws, { type: 'td-action-error', reason: `${abi.name} on cooldown (${rem}s)` }); return;
  }
  lane.abilityCooldown[abilityId] = now + abi.cooldownMs;
  switch (abilityId) {
    case 'airstrike':
      for (const e of lane.enemies) tdDamageEnemy(e, 500, 'true');
      broadcastRoom(room.id, { type: 'td-ability-used', pid, abilityId, label: abi.icon + ' Airstrike!' });
      break;
    case 'gold_rush':
      lane.gold += 150;
      send(room.players.get(pid).ws, { type: 'td-gold', gold: lane.gold });
      send(room.players.get(pid).ws, { type: 'td-ability-used', pid, abilityId, label: abi.icon + ' +150g!' });
      break;
    case 'fortify':
      lane.abilityActive.fortify = { until: now + 12000 };
      send(room.players.get(pid).ws, { type: 'td-ability-used', pid, abilityId, label: abi.icon + ' Fortify 12s!' });
      break;
    case 'overclock':
      lane.abilityActive.overclock = { until: now + 10000 };
      send(room.players.get(pid).ws, { type: 'td-ability-used', pid, abilityId, label: abi.icon + ' Overclock 10s!' });
      break;
    case 'repair':
      if (lane.baseHp >= td.maxHp) { send(room.players.get(pid).ws, { type: 'td-action-error', reason: 'HP already full' }); lane.abilityCooldown[abilityId] = 0; return; }
      lane.baseHp = Math.min(td.maxHp, lane.baseHp + 2);
      send(room.players.get(pid).ws, { type: 'td-ability-used', pid, abilityId, label: abi.icon + ' +2 HP!' });
      break;
  }
}

// Start the next wave for a single lane.
function tdStartLaneWave(room, pid) {
  const td = room.td;
  const lane = td.lanes[pid];
  if (!lane || !lane.alive) return;
  let comp, muls, twist;
  if (lane.nextWaveData) {
    ({ comp, muls, twist } = lane.nextWaveData);
    lane.wave = lane.nextWaveData.wave;
    lane.nextWaveData = null;
  } else {
    lane.wave++;
    twist = td.mode.chaos ? TD_CHAOS_TWISTS[Math.floor(Math.random() * TD_CHAOS_TWISTS.length)] : null;
    const sizeMul = td.mode.sizeMul * (twist ? twist.sizeMul : 1);
    comp = tdGenerateWave(lane.wave, { sizeMul, everyWaveBoss: td.mode.everyWaveBoss, typeOverride: twist && twist.typeOverride });
    muls = {
      hp: td.mode.hpMul * (twist ? twist.hpMul : 1),
      spd: td.mode.speedMul * (twist ? twist.speedMul : 1),
      reward: td.mode.rewardMul * (twist ? twist.rewardMul : 1),
      send: td.mode.sendMul,
    };
  }
  lane.phase = 'wave';
  lane.damagedThisWave = false;
  lane.killsThisWave = 0;
  const now = Date.now();
  lane.spawnQueue = comp.map(e => ({ type: e.type, at: now + e.at, muls }));
  // War Chest upgrade: bonus gold at wave start.
  const bonus = (lane.amps && lane.amps.waveBonus) || 0;
  if (bonus > 0) { lane.gold += bonus; send(room.players.get(pid).ws, { type: 'td-gold', gold: lane.gold }); }
  send(room.players.get(pid).ws, { type: 'td-wave-start', wave: lane.wave, twist: twist ? twist.label : null });
}

// End the current wave for a single lane, enter prep phase.
function tdEndLaneWave(room, pid) {
  const td = room.td;
  const lane = td.lanes[pid];
  if (!lane || !lane.alive) return;
  lane.phase = 'prep';
  lane.phaseEndsAt = Date.now() + td.mode.prepMs;
  // Precompute next wave so skip-prep can fire it immediately.
  const nextWave = lane.wave + 1;
  const twist = td.mode.chaos ? TD_CHAOS_TWISTS[Math.floor(Math.random() * TD_CHAOS_TWISTS.length)] : null;
  const sizeMul = td.mode.sizeMul * (twist ? twist.sizeMul : 1);
  const comp = tdGenerateWave(nextWave, { sizeMul, everyWaveBoss: td.mode.everyWaveBoss, typeOverride: twist && twist.typeOverride });
  const muls = {
    hp: td.mode.hpMul * (twist ? twist.hpMul : 1),
    spd: td.mode.speedMul * (twist ? twist.speedMul : 1),
    reward: td.mode.rewardMul * (twist ? twist.rewardMul : 1),
    send: td.mode.sendMul,
  };
  lane.nextWaveData = { wave: nextWave, comp, muls, twist };
  // Clear wave bonus + regen.
  if (!lane.damagedThisWave) {
    lane.gold += td.mode.clearBonus;
    if (lane.amps && lane.amps.regen) {
      lane.cleanWaves = (lane.cleanWaves || 0) + 1;
      if (lane.cleanWaves % 3 === 0) lane.baseHp = Math.min(td.maxHp, lane.baseHp + 1);
    }
  } else if (lane.amps && lane.amps.regen) {
    lane.cleanWaves = 0;
  }
  send(room.players.get(pid).ws, {
    type: 'td-wave-end', wave: lane.wave, prepMs: td.mode.prepMs,
    upcomingTwist: twist ? twist.label : null,
  });
}

// Validate a cell as a placeable buildable tile (in bounds, not on path).
function tdIsBuildable(td, x, y) {
  if (x < 0 || x >= TD_COLS || y < 0 || y >= TD_ROWS) return false;
  return !td.pathSet.has(y * TD_COLS + x);
}

function tdPlaceTower(room, pid, towerType, x, y) {
  const td = room.td;
  const lane = td.lanes[pid];
  if (!lane || !lane.alive) return;
  const def = TD_TOWERS[towerType];
  if (!def) return;
  if (!Number.isInteger(x) || !Number.isInteger(y) || !tdIsBuildable(td, x, y)) {
    send(room.players.get(pid).ws, { type: 'td-action-error', reason: 'Invalid tile' }); return;
  }
  if (lane.towers.some(t => t.x === x && t.y === y)) {
    send(room.players.get(pid).ws, { type: 'td-action-error', reason: 'Tile occupied' }); return;
  }
  const cost = def.levels[0].cost;
  if (lane.gold < cost) {
    send(room.players.get(pid).ws, { type: 'td-action-error', reason: 'Not enough gold' }); return;
  }
  lane.gold -= cost;
  const tower = {
    id: td.nextTowerId++, type: towerType, level: 1,
    x, y, invested: cost, cooldown: 0, perks: [],
  };
  lane.towers.push(tower);
  send(room.players.get(pid).ws, { type: 'td-gold', gold: lane.gold });
  broadcastRoom(room.id, { type: 'td-tower-placed', playerId: pid, tower: tdSerializeTower(tower) });
}

function tdUpgradeTower(room, pid, towerId) {
  const td = room.td;
  const lane = td.lanes[pid];
  if (!lane || !lane.alive) return;
  const tower = lane.towers.find(t => t.id === towerId);
  if (!tower) return;
  const def = TD_TOWERS[tower.type];
  if (tower.level >= def.levels.length) {
    send(room.players.get(pid).ws, { type: 'td-action-error', reason: 'Max level' }); return;
  }
  const cost = def.levels[tower.level].cost; // next level cost
  if (lane.gold < cost) {
    send(room.players.get(pid).ws, { type: 'td-action-error', reason: 'Not enough gold' }); return;
  }
  lane.gold -= cost;
  tower.level++;
  tower.invested += cost;
  send(room.players.get(pid).ws, { type: 'td-gold', gold: lane.gold });
  broadcastRoom(room.id, { type: 'td-tower-upgraded', playerId: pid, tower: tdSerializeTower(tower) });
}

function tdBuyPerk(room, pid, towerId, perkId) {
  const td = room.td;
  const lane = td.lanes[pid];
  if (!lane || !lane.alive) return;
  const tower = lane.towers.find(t => t.id === towerId);
  if (!tower) return;
  const list = TD_PERKS[tower.type] || [];
  const perk = list.find(p => p.id === perkId);
  if (!perk) return;
  if (!tower.perks) tower.perks = [];
  if (tower.perks.includes(perkId)) {
    send(room.players.get(pid).ws, { type: 'td-action-error', reason: 'Already installed' }); return;
  }
  if (lane.gold < perk.cost) {
    send(room.players.get(pid).ws, { type: 'td-action-error', reason: 'Not enough gold' }); return;
  }
  lane.gold -= perk.cost;
  tower.perks.push(perkId);
  tower.invested += perk.cost;
  send(room.players.get(pid).ws, { type: 'td-gold', gold: lane.gold });
  broadcastRoom(room.id, { type: 'td-tower-upgraded', playerId: pid, tower: tdSerializeTower(tower) });
}

function tdSellTower(room, pid, towerId) {
  const td = room.td;
  const lane = td.lanes[pid];
  if (!lane || !lane.alive) return;
  const idx = lane.towers.findIndex(t => t.id === towerId);
  if (idx === -1) return;
  const tower = lane.towers[idx];
  const refund = Math.floor(tower.invested * 0.6);
  lane.gold += refund;
  lane.towers.splice(idx, 1);
  send(room.players.get(pid).ws, { type: 'td-gold', gold: lane.gold });
  broadcastRoom(room.id, { type: 'td-tower-sold', playerId: pid, towerId, refund });
}

function tdSendEnemies(room, pid, packageIdx, targetId) {
  const td = room.td;
  const lane = td.lanes[pid];
  if (!lane || !lane.alive) return;
  const pkg = TD_SEND_PACKAGES[packageIdx];
  if (!pkg) return;
  if (lane.sendMeter < pkg.pts) {
    send(room.players.get(pid).ws, { type: 'td-action-error', reason: 'Meter not charged' }); return;
  }
  // Resolve target
  let target = targetId;
  const aliveOpponents = td.order.filter(o => o !== pid && td.lanes[o].alive);
  if (aliveOpponents.length === 0) return;
  if (aliveOpponents.length === 1) target = aliveOpponents[0];
  if (!aliveOpponents.includes(target)) {
    send(room.players.get(pid).ws, { type: 'td-action-error', reason: 'Pick a valid target' }); return;
  }
  lane.sendMeter = 0;
  lane.sentCount += pkg.enemies.length;
  const tLane = td.lanes[target];
  const now = Date.now();
  const muls = { hp: td.mode.hpMul, spd: td.mode.speedMul, reward: td.mode.rewardMul, send: td.mode.sendMul };
  pkg.enemies.forEach((etype, i) => {
    tLane.spawnQueue.push({ type: etype, at: now + i * 250, sentBy: pid, muls });
  });
  broadcastRoom(room.id, {
    type: 'td-enemies-sent', fromId: pid, fromName: lane.name,
    toId: target, toName: tLane.name, label: pkg.label, colorIdx: lane.colorIdx,
  });
  send(room.players.get(pid).ws, { type: 'td-send-meter', meter: lane.sendMeter });
}

function tdSpawnEnemy(td, lane, type, sentBy, muls) {
  const def = TD_ENEMIES[type];
  const m = muls || {};
  const now = Date.now();
  const hp = Math.max(1, Math.round(def.hp * (m.hp || 1)));
  const e = {
    id: td.nextEnemyId++, type, hp, maxHp: hp,
    dist: 0, slowUntil: 0, slowFactor: 1, freezeUntil: 0, shatterUntil: 0,
    burns: [], sentBy: sentBy || null,
    spdMul: m.spd || 1, rewardMul: m.reward || 1, sendMul: m.send || 1,
  };
  if (def.blink) e.blinkNext = now + 1500 + Math.random() * 1000;
  if (def.cloaked) e.cloaked = true;
  if (def.flying) e.flying = true;
  lane.enemies.push(e);
}

// Compute enemy world position (cell coords, floats) from path distance.
function tdEnemyPos(td, dist) {
  const path = td.path, len = td.pathLen;
  if (dist >= len - 1) return { x: path[len - 1].x, y: path[len - 1].y };
  const i = Math.floor(dist);
  const f = dist - i;
  const a = path[i], b = path[i + 1];
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f };
}

// Apply damage to an enemy accounting for class/armor/resistances. Returns actual damage dealt.
function tdDamageEnemy(enemy, amount, dmgClass) {
  const def = TD_ENEMIES[enemy.type];
  let mult = 1;
  if (dmgClass === 'physical') {
    let eff = def.armor;
    if (enemy.venomCorrosiveUntil && Date.now() < enemy.venomCorrosiveUntil) eff = Math.max(0, eff - 0.3);
    mult = 1 - eff;
  }
  else if (dmgClass === 'magic') mult = 1 - def.magicRes;
  else if (dmgClass === 'true') mult = 1;
  let dealt = Math.max(0, amount * mult);
  if (enemy.shatterUntil && Date.now() < enemy.shatterUntil) dealt *= 1.25; // Shatter perk vulnerability
  enemy.hp -= dealt;
  return dealt;
}

function tdTick(room) {
  const td = room.td;
  if (!td || !td.active) return;
  const now = Date.now();
  const dt = TD_TICK_MS / 1000;
  const events = [];

  // ── Bot AI ──
  if (td.botId) tdBotThink(room);

  // ── Passive income (per lane) ──
  for (const pid of td.order) {
    const lane = td.lanes[pid];
    if (!lane.alive) continue;
    if (lane.lastIncomeAt === 0) lane.lastIncomeAt = now;
    if (now - lane.lastIncomeAt >= td.mode.incomeIntervalMs) {
      lane.lastIncomeAt = now;
      const inc = td.mode.income + ((lane.amps && lane.amps.income) || 0);
      lane.gold += inc;
      send(room.players.get(pid).ws, { type: 'td-gold', gold: lane.gold });
    }
  }

  // ── Per-lane simulation (each lane advances independently) ──
  for (const pid of td.order) {
    const lane = td.lanes[pid];
    if (!lane.alive) continue;

    // Per-lane phase transition
    if (lane.phase === 'prep' && now >= lane.phaseEndsAt) {
      tdStartLaneWave(room, pid);
      if (!lane.alive) continue;
    }

    // Spawn from queue
    if (lane.spawnQueue.length) {
      const remain = [];
      for (const s of lane.spawnQueue) {
        if (now >= s.at) tdSpawnEnemy(td, lane, s.type, s.sentBy, s.muls);
        else remain.push(s);
      }
      lane.spawnQueue = remain;
    }

    // Move enemies + burn/venom DoT
    const burnSpawns = [];
    const survivors = [];
    for (const e of lane.enemies) {
      const eDef = TD_ENEMIES[e.type];
      // Burn / venom DoT ticks
      if (e.burns.length) {
        e.burns = e.burns.filter(b => now < b.until);
        for (const b of e.burns) tdDamageEnemy(e, b.dps * dt, b.dmgClass || 'magic');
      }
      // Regenerator heals
      if (eDef.regenHps && e.hp > 0 && e.hp < e.maxHp) e.hp = Math.min(e.maxHp, e.hp + eDef.regenHps * dt);
      if (e.hp <= 0) { tdOnKill(room, lane, e, events, pid, burnSpawns); continue; }
      const frozen = now < e.freezeUntil;
      const slowed = now < e.slowUntil && !eDef.slowImmune;
      const factor = frozen ? 0 : (slowed ? e.slowFactor : 1);
      e.dist += eDef.speed * (e.spdMul || 1) * factor * dt;
      // Blinker teleport
      if (eDef.blink && !frozen && e.hp > 0 && now >= (e.blinkNext || 0)) {
        e.dist += 10 + Math.random() * 10;
        e.blinkNext = now + 3000 + Math.random() * 2000;
        const bp = tdEnemyPos(td, e.dist);
        events.push({ ev: 'blink', pid, ex: bp.x, ey: bp.y });
      }
      if (e.dist >= td.pathLen - 1) {
        // Reached base
        lane.baseHp -= eDef.baseDmg;
        lane.damagedThisWave = true;
        events.push({ ev: 'reached', pid, etype: e.type });
        // Send rebate to whoever sent this enemy
        if (e.sentBy && td.lanes[e.sentBy]?.alive) {
          td.lanes[e.sentBy].gold += TD_SEND_REBATE;
          send(room.players.get(e.sentBy).ws, { type: 'td-gold', gold: td.lanes[e.sentBy].gold });
        }
        if (lane.baseHp <= 0) {
          lane.baseHp = 0;
          tdEliminatePlayer(room, pid, false);
        }
        continue;
      }
      survivors.push(e);
    }
    lane.enemies = [...survivors, ...burnSpawns];
    if (!lane.alive) continue;

    // Towers fire
    for (const tower of lane.towers) {
      tower.cooldown -= TD_TICK_MS;
      if (tower.cooldown > 0) continue;
      const def = TD_TOWERS[tower.type];
      const s = tdTowerStats(tower);
      // Apply lane-wide amplifiers + timed ability effects
      const la = lane.amps || {};
      const fortActive = lane.abilityActive && lane.abilityActive.fortify && now < lane.abilityActive.fortify.until;
      const clockActive = lane.abilityActive && lane.abilityActive.overclock && now < lane.abilityActive.overclock.until;
      s.range     += la.range || 0;
      const dmgMul = (la.dmg || 1) * (fortActive ? 1.5 : 1);
      if (s.damage > 0) s.damage = Math.round(s.damage * dmgMul);
      if (s.burn   > 0) s.burn   = Math.round(s.burn   * dmgMul);
      s.bossBonus  = (s.bossBonus || 1) * (la.bossBonus || 1);
      s.fireMs     = Math.round(s.fireMs * (la.reload || 1) * (clockActive ? 0.4 : 1));
      const fired = tdTowerFire(td, lane, tower, def, s, now, events, pid);
      if (fired) tower.cooldown = s.fireMs;
      else tower.cooldown = 0;
    }

    // Clean up enemies killed by towers
    const towerSpawns = [];
    const after = [];
    for (const e of lane.enemies) {
      if (e.hp <= 0) tdOnKill(room, lane, e, events, pid, towerSpawns);
      else after.push(e);
    }
    lane.enemies = [...after, ...towerSpawns];

    // Auto-send: fire automatically when meter threshold is reached
    const pws = room.players.get(pid);
    if (!pws || !pws._bot) { // human players only
      const as = lane.autoSend;
      if (as && as.enabled) {
        // Only fire when the meter reaches the exact configured package threshold
        const bestPkg = (TD_SEND_PACKAGES[as.packageIdx] && lane.sendMeter >= TD_SEND_PACKAGES[as.packageIdx].pts) ? as.packageIdx : -1;
        if (bestPkg >= 0) {
          const targets = td.order.filter(q => q !== pid && td.lanes[q] && td.lanes[q].alive);
          if (targets.length) {
            let tgt;
            if (as.targeting === 'lowest_hp')  tgt = targets.reduce((a,b) => td.lanes[a].baseHp <= td.lanes[b].baseHp ? a : b);
            else if (as.targeting === 'highest_hp') tgt = targets.reduce((a,b) => td.lanes[a].baseHp >= td.lanes[b].baseHp ? a : b);
            else tgt = targets[Math.floor(Math.random() * targets.length)];
            tdSendEnemies(room, pid, bestPkg, tgt);
          }
        }
      }
    }

    // Per-lane end-of-wave detection
    if (lane.alive && lane.phase === 'wave' && lane.enemies.length === 0 && lane.spawnQueue.length === 0) {
      tdEndLaneWave(room, pid);
    }
  }

  // Check win condition
  tdCheckGameOver(room);
  if (!td.active) return;

  // ── Broadcast compact state ──
  const laneState = {};
  for (const pid of td.order) {
    const lane = td.lanes[pid];
    const cdMs = {}; for (const [k,v] of Object.entries(lane.abilityCooldown||{})) cdMs[k] = Math.max(0, v - now);
    const actMs = {}; for (const [k,v] of Object.entries(lane.abilityActive||{})) actMs[k] = Math.max(0, v.until - now);
    laneState[pid] = {
      baseHp: lane.baseHp, gold: lane.gold, alive: lane.alive,
      sendMeter: lane.sendMeter, kills: lane.killsThisWave, sent: lane.sentCount,
      wave: lane.wave, phase: lane.phase,
      phaseRemainingMs: lane.phase === 'prep' ? Math.max(0, lane.phaseEndsAt - now) : 0,
      towers: lane.towers.map(tdSerializeTower),
      enemies: lane.enemies.map(e => {
        const p = tdEnemyPos(td, e.dist);
        return { i: e.id, t: e.type, x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100,
                 h: Math.max(0, Math.round(e.hp / e.maxHp * 100) / 100),
                 sl: now < e.slowUntil ? 1 : 0, bn: e.burns.length ? 1 : 0,
                 fz: now < e.freezeUntil ? 1 : 0,
                 fl: e.flying ? 1 : 0, cl: e.cloaked ? 1 : 0 };
      }),
      upgrades: [...(lane.upgrades||[])],
      abilityOwned: [...(lane.abilityOwned||[])],
      abilityCooldownMs: cdMs,
      abilityActiveMs: actMs,
      autoSend: lane.autoSend,
    };
  }
  broadcastRoom(room.id, { type: 'td-state', lanes: laneState, events });
}

function tdSerializeTower(t) {
  return { id: t.id, type: t.type, level: t.level, x: t.x, y: t.y, invested: t.invested, perks: t.perks || [] };
}

// Find best target & fire. Returns true if it actually fired. `s` = resolved stats+perk flags.
function tdTowerFire(td, lane, tower, def, s, now, events, pid) {
  const inRange = [];
  for (const e of lane.enemies) {
    if (e.hp <= 0) continue;
    if (e.flying && !def.antiAir) continue;    // only antiAir towers hit flyers
    if (e.cloaked && !s.reveal) continue;      // only reveal towers hit cloakers
    const p = tdEnemyPos(td, e.dist);
    const d = Math.hypot(p.x - tower.x, p.y - tower.y);
    if (d <= s.range) inRange.push({ e, d, p });
  }
  if (!inRange.length) return false;

  // Shared damage resolver
  const resolve = (e, amount, cls) => {
    let amt = amount;
    if (s.vsBig > 1 && (e.type === 'brute' || e.type === 'armored' || e.type === 'boss' || e.type === 'colossus')) amt *= s.vsBig;
    if ((e.type === 'boss' || e.type === 'colossus') && s.bossBonus > 1) amt *= s.bossBonus;
    if (e.flying && s.vsFlying > 1) amt *= s.vsFlying;
    const useCls = (s.armorPierce && cls === 'physical') ? 'true' : cls;
    if (s.executeFrac > 0 && e.type !== 'boss' && e.type !== 'colossus' && e.maxHp > 0 && (e.hp / e.maxHp) <= s.executeFrac) {
      const d = e.hp; e.hp = 0; return d;
    }
    let dealt = tdDamageEnemy(e, amt, useCls);
    if (s.crit > 0 && Math.random() < s.crit) dealt += tdDamageEnemy(e, amt * (s.critMul - 1), useCls);
    return dealt;
  };

  if (def.behavior === 'frost') {
    for (const { e } of inRange) {
      if (s.freezeChance > 0 && Math.random() < s.freezeChance && !TD_ENEMIES[e.type].slowImmune) e.freezeUntil = now + 800;
      e.slowUntil = now + s.slowMs;
      e.slowFactor = 1 - s.slow;
      if (s.shatter) e.shatterUntil = now + s.slowMs;
    }
    events.push({ ev: 'frost', pid, tx: tower.x, ty: tower.y });
    return true;
  }

  if (def.behavior === 'burn') {
    const ordered = inRange.slice().sort((a, b) => b.e.dist - a.e.dist);
    const targets = ordered.slice(0, s.burnTargets);
    for (const c of targets) {
      const e = c.e;
      if (e.burns.length < s.burnStacks) e.burns.push({ dps: s.burn, until: now + s.burnMs });
      else e.burns[e.burns.length - 1] = { dps: s.burn, until: now + s.burnMs };
      events.push({ ev: 'burn', pid, tx: tower.x, ty: tower.y, ex: c.p.x, ey: c.p.y });
    }
    if (s.burnSpread) {
      const tset = new Set(targets.map(c => c.e.id));
      let near = null, nd = 1.8;
      for (const c of inRange) {
        if (tset.has(c.e.id)) continue;
        for (const tg of targets) { const dd = Math.hypot(c.p.x - tg.p.x, c.p.y - tg.p.y); if (dd < nd) { nd = dd; near = c; } }
      }
      if (near && near.e.burns.length < s.burnStacks) near.e.burns.push({ dps: s.burn, until: now + s.burnMs });
    }
    return true;
  }

  if (def.behavior === 'chain') {
    inRange.sort((a, b) => a.d - b.d);
    const hits = inRange.slice(0, s.chains);
    const chainPts = [{ x: tower.x, y: tower.y }];
    let amp = 1;
    for (const c of hits) {
      const dealt = tdDamageEnemy(c.e, s.damage * amp, def.dmgClass);
      if (s.staticSlow > 0 && !TD_ENEMIES[c.e.type].slowImmune) {
        c.e.slowUntil = Math.max(c.e.slowUntil, now + 1000);
        c.e.slowFactor = Math.min(c.e.slowFactor || 1, 1 - s.staticSlow);
      }
      chainPts.push({ x: c.p.x, y: c.p.y });
      events.push({ ev: 'hit', pid, ex: c.p.x, ey: c.p.y, dmg: Math.round(dealt) });
      amp *= s.amplify;
    }
    events.push({ ev: 'chain', pid, pts: chainPts });
    return true;
  }

  if (def.behavior === 'splash') {
    let target = inRange[0];
    for (const c of inRange) if (c.e.dist > target.e.dist) target = c;
    const cx = target.p.x, cy = target.p.y;
    for (const e of lane.enemies) {
      if (e.hp <= 0) continue;
      const p = tdEnemyPos(td, e.dist);
      if (Math.hypot(p.x - cx, p.y - cy) <= s.splash) {
        const dealt = resolve(e, s.damage, def.dmgClass);
        if (s.napalm && e.burns.length < 3) e.burns.push({ dps: Math.round(s.damage * 0.1) + 4, until: now + 2500 });
        events.push({ ev: 'hit', pid, ex: p.x, ey: p.y, dmg: Math.round(dealt) });
      }
    }
    events.push({ ev: 'splash', pid, x: cx, y: cy, r: s.splash, tx: tower.x, ty: tower.y });
    return true;
  }

  if (def.behavior === 'sniper') {
    let target = inRange[0];
    for (const c of inRange) if (c.e.hp > target.e.hp) target = c;
    let total = 0;
    for (let k = 0; k < s.multishot; k++) { if (target.e.hp <= 0) break; total += resolve(target.e, s.damage, def.dmgClass); }
    events.push({ ev: 'snipe', pid, tx: tower.x, ty: tower.y, ex: target.p.x, ey: target.p.y, dmg: Math.round(total) });
    return true;
  }

  // ── New tower behaviors ──
  if (def.behavior === 'missile') {
    for (let k = 0; k < (s.multishot || 1); k++) {
      // Prioritize flying targets (furthest first), fallback to any furthest enemy
      let target = null;
      for (const c of inRange) if (c.e.flying && c.e.hp > 0 && (!target || c.e.dist > target.e.dist)) target = c;
      if (!target) { target = inRange[0]; for (const c of inRange) if (c.e.dist > target.e.dist) target = c; }
      const cx = target.p.x, cy = target.p.y;
      for (const e of lane.enemies) {
        if (e.hp <= 0) continue;
        const p = tdEnemyPos(td, e.dist);
        if (Math.hypot(p.x - cx, p.y - cy) <= s.splash) {
          events.push({ ev: 'hit', pid, ex: p.x, ey: p.y, dmg: Math.round(resolve(e, s.damage, def.dmgClass)) });
        }
      }
      events.push({ ev: 'splash', pid, x: cx, y: cy, r: s.splash, tx: tower.x, ty: tower.y });
    }
    return true;
  }

  if (def.behavior === 'laser') {
    inRange.sort((a, b) => a.d - b.d);
    const targets = inRange.slice(0, s.laserChains);
    let dmgMul = 1;
    if (s.overcharge) { tower.shotCount = (tower.shotCount || 0) + 1; if (tower.shotCount % 5 === 0) dmgMul = 3; }
    for (const c of targets) {
      const dealt = tdDamageEnemy(c.e, s.damage * dmgMul, 'true');
      if (s.laserSlow > 0 && !TD_ENEMIES[c.e.type].slowImmune) {
        c.e.slowUntil = Math.max(c.e.slowUntil, now + 1500);
        c.e.slowFactor = Math.min(c.e.slowFactor || 1, 1 - s.laserSlow);
      }
      events.push({ ev: 'snipe', pid, tx: tower.x, ty: tower.y, ex: c.p.x, ey: c.p.y, dmg: Math.round(dealt) });
    }
    return true;
  }

  if (def.behavior === 'venom') {
    const ordered = inRange.slice().sort((a, b) => b.e.dist - a.e.dist);
    const targets = ordered.slice(0, s.venomTargets);
    for (const c of targets) {
      const e = c.e;
      const venomStacks = e.burns.filter(b => b.isVenom);
      if (venomStacks.length < s.venomStacks) {
        e.burns.push({ dps: s.venom, until: now + s.venomMs, isVenom: true });
      } else {
        venomStacks.sort((a, b) => a.until - b.until);
        venomStacks[0].until = now + s.venomMs; venomStacks[0].dps = s.venom;
      }
      if (s.venomSlow > 0 && !TD_ENEMIES[e.type].slowImmune) {
        e.slowUntil = Math.max(e.slowUntil, now + s.venomMs);
        e.slowFactor = Math.min(e.slowFactor || 1, 1 - s.venomSlow);
      }
      if (s.venomCorrosive) e.venomCorrosiveUntil = now + s.venomMs;
      events.push({ ev: 'venom', pid, tx: tower.x, ty: tower.y, ex: c.p.x, ey: c.p.y });
    }
    if (s.venomSpread) {
      const tset = new Set(targets.map(c => c.e.id));
      let spread = 0;
      for (const c of inRange) {
        if (tset.has(c.e.id) || spread >= 2) continue;
        const vs = c.e.burns.filter(b => b.isVenom);
        if (vs.length < s.venomStacks) { c.e.burns.push({ dps: s.venom, until: now + s.venomMs, isVenom: true }); spread++; }
      }
    }
    return true;
  }

  if (def.behavior === 'railgun') {
    // Fires through ALL enemies in range (furthest first); reuses chain visual
    const ordered = inRange.slice().sort((a, b) => b.e.dist - a.e.dist);
    const pts = [{ x: tower.x, y: tower.y }];
    for (const c of ordered) {
      if (c.e.hp <= 0) continue;
      const dealt = resolve(c.e, s.damage, def.dmgClass);
      if (s.emp && !TD_ENEMIES[c.e.type].slowImmune) c.e.freezeUntil = Math.max(c.e.freezeUntil, now + 1500);
      pts.push({ x: c.p.x, y: c.p.y });
      events.push({ ev: 'hit', pid, ex: c.p.x, ey: c.p.y, dmg: Math.round(dealt), tx: tower.x, ty: tower.y });
    }
    events.push({ ev: 'chain', pid, pts });
    return true;
  }

  // single (arrow): furthest-along enemies (Piercing hits several)
  const ordered = inRange.slice().sort((a, b) => b.e.dist - a.e.dist).slice(0, s.pierce);
  for (const c of ordered) {
    const dealt = resolve(c.e, s.damage, def.dmgClass);
    events.push({ ev: 'hit', pid, ex: c.p.x, ey: c.p.y, dmg: Math.round(dealt), tx: tower.x, ty: tower.y, single: 1 });
  }
  return true;
}

function tdOnKill(room, lane, enemy, events, pid, spawned) {
  const def = TD_ENEMIES[enemy.type];
  const reward = Math.round(def.reward * (enemy.rewardMul || 1));
  lane.gold += reward + ((lane.amps && lane.amps.killGold) || 0);
  lane.killsThisWave++;
  const rawPts = def.sendPts * (enemy.sendMul || 1) * ((lane.amps && lane.amps.sendAmp) || 1);
  if (rawPts > 0) lane.sendMeter += Math.max(1, Math.round(rawPts));
  const p = tdEnemyPos(room.td, enemy.dist);
  events.push({ ev: 'kill', pid, etype: enemy.type, ex: p.x, ey: p.y, reward });
  // Split on death
  if (def.splitInto && spawned) {
    for (const stype of def.splitInto) {
      const sdef = TD_ENEMIES[stype];
      if (!sdef) continue;
      const hp = Math.max(1, Math.round(sdef.hp));
      const ne = {
        id: room.td.nextEnemyId++, type: stype, hp, maxHp: hp,
        dist: Math.max(0, enemy.dist - 0.5), slowUntil: 0, slowFactor: 1,
        freezeUntil: 0, shatterUntil: 0, burns: [],
        sentBy: enemy.sentBy, spdMul: enemy.spdMul || 1,
        rewardMul: enemy.rewardMul || 1, sendMul: 0,
      };
      if (sdef.blink) ne.blinkNext = Date.now() + 1500;
      if (sdef.cloaked) ne.cloaked = true;
      if (sdef.flying) ne.flying = true;
      spawned.push(ne);
    }
    events.push({ ev: 'split', pid, ex: p.x, ey: p.y });
  }
}

function tdEliminatePlayer(room, pid, isDisconnect) {
  const td = room.td;
  const lane = td.lanes[pid];
  if (!lane || !lane.alive) return;
  lane.alive = false;
  lane.enemies = [];
  lane.spawnQueue = [];
  td.eliminationOrder.push({ id: pid, name: lane.name, wave: lane.wave, hpAtDeath: lane.baseHp });
  broadcastRoom(room.id, {
    type: 'td-player-eliminated', playerId: pid, name: lane.name,
    reason: isDisconnect ? 'disconnect' : 'base-destroyed', wave: lane.wave,
  });
}

function tdCheckGameOver(room) {
  const td = room.td;
  if (!td || !td.active) return;
  const alive = td.order.filter(pid => td.lanes[pid].alive);
  if (alive.length > 1) return;

  td.active = false;
  if (td.tickInterval) { clearInterval(td.tickInterval); td.tickInterval = null; }

  let winnerId = alive[0] || null;
  // Build final ranking: survivors first, then by survival (later wave / higher HP at death ranks higher).
  const ranking = [];
  if (winnerId) ranking.push({ id: winnerId, name: td.lanes[winnerId].name, place: 1 });
  const elims = [...td.eliminationOrder].sort((a, b) => b.wave - a.wave || b.hpAtDeath - a.hpAtDeath);
  let place = ranking.length + 1;
  for (const e of elims) {
    if (e.id === winnerId) continue;
    ranking.push({ id: e.id, name: e.name, place: place++ });
  }

  if (winnerId) {
    const p = room.players.get(winnerId);
    if (p) {
      // Persist a win for the leaderboard (mirrors other win-increment games)
      send(p.ws, { type: 'td-record-win' });
    }
  }

  const maxWave = Math.max(...td.order.map(p => td.lanes[p].wave));
  broadcastRoom(room.id, { type: 'td-game-over', winnerId, winnerName: winnerId ? td.lanes[winnerId].name : null, ranking, wave: maxWave });
  room.status = 'waiting';
  broadcastLobby();
  log('info', 'td-game-over', { roomId: room.id, winner: winnerId ? td.lanes[winnerId].name : '(none)', wave: td.wave });
}

// Detect end of wave: all alive lanes have no enemies & empty spawn queue while in wave phase.
// ── GeoGuessr helpers ────────────────────────────────────────────

function geoHaversine(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function geoCalcScore(distKm) {
  return Math.max(0, Math.floor(1000 * Math.exp(-distKm / 2000)));
}

function geoStartViewPhase(room) {
  const g = room.geo;
  if (!g || !g.active) return;
  const effectiveTotal = Math.min(g.totalRounds, g.rounds.length);
  if (g.currentRound >= effectiveTotal) { geoEndGame(room); return; }
  g.phase = 'viewing';
  g.viewStart = Date.now();
  g.ready = new Set();
  g.guesses = {};
  const round = g.rounds[g.currentRound];
  broadcastRoom(room.id, {
    type: 'geo-round-start',
    round: g.currentRound + 1, total: effectiveTotal,
    photoUrl: round.photoUrl, title: round.title || '',
    country: g.difficulty !== 'nohints' ? (round.country || '') : '',
    city: g.difficulty !== 'nohints' ? (round.city || '') : '',
  });
  g.phaseTimer = setTimeout(() => {
    const r = rooms.get(room.id);
    if (r?.geo?.phase === 'viewing') geoStartGuessPhase(r);
  }, 30000);
}

function geoStartGuessPhase(room) {
  const g = room.geo;
  if (!g || !g.active) return;
  g.phase = 'guessing';
  g.guessStart = Date.now();
  broadcastRoom(room.id, { type: 'geo-guess-phase', timeLimit: 45 });
  g.phaseTimer = setTimeout(() => {
    const r = rooms.get(room.id);
    if (r?.geo?.phase === 'guessing') geoResolveRound(r);
  }, 45000);
}

function geoResolveRound(room) {
  const g = room.geo;
  if (!g || !g.active) return;
  g.phase = 'reveal';
  const round = g.rounds[g.currentRound];
  const effectiveTotal = Math.min(g.totalRounds, g.rounds.length);
  const results = [];
  let winnerId = null, bestDist = Infinity;
  for (const [pid, p] of room.players) {
    const guess = g.guesses[pid];
    let distKm = 20000, roundScore = 0, speedBonus = 0;
    let guessLat = null, guessLng = null;
    if (guess) {
      guessLat = guess.lat; guessLng = guess.lng;
      distKm = geoHaversine(round.lat, round.lng, guess.lat, guess.lng);
      roundScore = geoCalcScore(distKm);
      const elapsedS = (guess.confirmedAt - g.guessStart) / 1000;
      const remaining = 45 - elapsedS;
      if (remaining > 20) speedBonus = Math.floor(100 * (remaining - 20) / 25);
      if (distKm < bestDist) { bestDist = distKm; winnerId = pid; }
    }
    const total = roundScore + speedBonus;
    g.scores[pid] = (g.scores[pid] || 0) + total;
    results.push({ id: pid, name: p.name, lat: guessLat, lng: guessLng,
      distKm: Math.round(distKm), roundScore, speedBonus, totalRoundScore: total,
      cumulativeScore: g.scores[pid] });
  }
  g.roundHistory.push({ round: g.currentRound + 1, photoUrl: round.photoUrl,
    correctLat: round.lat, correctLng: round.lng,
    country: round.country || '', city: round.city || '', title: round.title || '', results });
  broadcastRoom(room.id, {
    type: 'geo-round-reveal',
    round: g.currentRound + 1, total: effectiveTotal,
    correctLat: round.lat, correctLng: round.lng,
    country: round.country || '', city: round.city || '', title: round.title || '',
    results, winnerId,
  });
  g.currentRound++;
  const nextRound = g.currentRound;
  const geoRoomId = room.id;
  g.phaseTimer = setTimeout(() => {
    const r = rooms.get(geoRoomId);
    if (!r?.geo?.active) return;
    if (nextRound >= Math.min(r.geo.totalRounds, r.geo.rounds.length)) geoEndGame(r);
    else geoStartViewPhase(r);
  }, 8000);
}

function geoEndGame(room) {
  const g = room.geo;
  if (!g) return;
  if (g.phaseTimer) { clearTimeout(g.phaseTimer); g.phaseTimer = null; }
  g.active = false; g.phase = 'done';
  room.status = 'waiting';
  let winnerId = null, winnerScore = -1;
  const finalScores = [];
  for (const [pid] of room.players) {
    const score = g.scores[pid] || 0;
    finalScores.push({ id: pid, name: room.players.get(pid)?.name || '?', score });
    if (score > winnerScore) { winnerScore = score; winnerId = pid; }
  }
  broadcastRoom(room.id, {
    type: 'geo-game-over', winnerId,
    winnerName: room.players.get(winnerId)?.name || '?',
    finalScores, roundHistory: g.roundHistory,
  });
  broadcastLobby();
  log('info', 'geo-game-over', { roomId: room.id, winnerId, score: winnerScore });
}

// Wikimedia API policy requires a descriptive User-Agent; omitting it causes aggressive rate limiting
const GEO_UA = 'ArenaMultiplayerGames/1.0 (multiplayer-arena; https://arena-games.onrender.com)';
function geoFetch(url, timeoutMs = 7000) {
  return fetch(url, { headers: { 'User-Agent': GEO_UA, 'Api-User-Agent': GEO_UA }, signal: AbortSignal.timeout(timeoutMs) });
}

async function resolveWikimediaThumb(filename) {
  try {
    const apiUrl = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent('File:' + filename)}&prop=imageinfo&iiprop=url&iiurlwidth=1200&format=json&origin=*`;
    const resp = await geoFetch(apiUrl, 5000);
    if (!resp.ok) { log('warn', 'geo-thumb-http', { file: filename.slice(0, 60), status: resp.status }); return null; }
    const data = await resp.json();
    const page = Object.values(data.query?.pages || {})[0];
    const url = page?.imageinfo?.[0]?.thumburl || page?.imageinfo?.[0]?.url;
    if (url && /\.(jpg|jpeg|png|webp|gif)/i.test(url)) return url;
    log('warn', 'geo-thumb-badext', { file: filename.slice(0, 60), url: String(url).slice(0, 80) });
    return null;
  } catch (e) { log('warn', 'geo-thumb-err', { file: filename.slice(0, 60), err: String(e).slice(0, 80) }); return null; }
}

async function fetchWikipediaPhoto(wikiTitle, lat, lng, meta) {
  try {
    const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(wikiTitle)}&prop=pageimages&pithumbsize=1200&format=json&origin=*`;
    const resp = await geoFetch(url, 6000);
    if (!resp.ok) { log('warn', 'geo-wp-http', { title: wikiTitle, status: resp.status }); return null; }
    const data = await resp.json();
    for (const page of Object.values(data.query?.pages || {})) {
      if (page.thumbnail?.source) {
        log('debug', 'geo-wp-ok', { title: wikiTitle });
        return { photoUrl: page.thumbnail.source, lat, lng, country: meta.country || '?', city: meta.city || '?', difficulty: meta.difficulty || 'medium', title: meta.title || wikiTitle.replace(/_/g, ' ') };
      }
    }
    log('warn', 'geo-wp-nothumb', { title: wikiTitle });
    return null;
  } catch (e) { log('warn', 'geo-wp-err', { title: wikiTitle, err: String(e).slice(0, 80) }); return null; }
}

async function fetchWikimediaTextSearch(searchTerm, lat, lng, meta) {
  try {
    // gsrnamespace and gsrlimit are the correct prefixed params for generator=search
    const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrsearch=${encodeURIComponent(searchTerm)}&gsrlimit=5&prop=imageinfo&iiprop=url&iiurlwidth=1200&format=json&origin=*`;
    const resp = await geoFetch(url, 6000);
    if (!resp.ok) { log('warn', 'geo-textsearch-http', { term: searchTerm.slice(0,40), status: resp.status }); return null; }
    const data = await resp.json();
    const pages = Object.values(data.query?.pages || {});
    if (data.warnings) log('warn', 'geo-textsearch-apiwarn', { term: searchTerm.slice(0,40), warn: JSON.stringify(data.warnings).slice(0,120) });
    for (const page of pages) {
      const info = page.imageinfo?.[0];
      const photoUrl = info?.thumburl || info?.url;
      if (photoUrl && /\.(jpg|jpeg|png|webp)/i.test(photoUrl)) {
        log('debug', 'geo-textsearch-ok', { term: searchTerm.slice(0,40) });
        return { photoUrl, lat, lng, country: meta.country || '?', city: meta.city || '?', difficulty: meta.difficulty || 'medium', title: meta.title || searchTerm };
      }
    }
    log('warn', 'geo-textsearch-none', { term: searchTerm.slice(0,40), hits: pages.length });
    return null;
  } catch (e) { log('warn', 'geo-textsearch-err', { term: searchTerm.slice(0,40), err: String(e).slice(0, 80) }); return null; }
}

async function fetchGeoPhoto(lat, lng, meta) {
  const label = (meta.title || 'unknown').slice(0, 40);
  // Layer 1: Wikimedia Commons geosearch (50km then 200km)
  for (const radius of [50000, 200000]) {
    try {
      const url = `https://commons.wikimedia.org/w/api.php?action=query&list=geosearch&gsradius=${radius}&gscoord=${lat}|${lng}&gslimit=10&gsnamespace=6&format=json&origin=*`;
      const resp = await geoFetch(url, 6000);
      if (!resp.ok) { log('warn', 'geo-geosearch-http', { label, radius, status: resp.status }); break; }
      const data = await resp.json();
      const hits = (data.query?.geosearch || [])
        .filter(h => !/\.(pdf|ogg|ogv|webm|mp4|mp3|wav|flac|midi|djvu)$/i.test(h.title))
        .slice(0, 5);
      log('debug', 'geo-geosearch-hits', { label, radius, hits: hits.length });
      for (const hit of hits) {
        const thumbUrl = await resolveWikimediaThumb(hit.title.replace(/^File:/i, ''));
        if (thumbUrl) {
          log('debug', 'geo-photo-found', { label, layer: 'geosearch', radius });
          return { photoUrl: thumbUrl, lat: hit.lat, lng: hit.lon, country: meta.country || '?', city: meta.city || '?', difficulty: meta.difficulty || 'medium', title: hit.title.replace(/^File:/i,'').replace(/_/g,' ').replace(/\.[^.]+$/,'').slice(0,80) };
        }
      }
    } catch (e) { log('warn', 'geo-geosearch-err', { label, radius, err: String(e).slice(0, 80) }); }
  }
  // Layer 2: Wikipedia article thumbnail (reliable for famous places with wikiTitle)
  if (meta.wikiTitle) {
    const wp = await fetchWikipediaPhoto(meta.wikiTitle, lat, lng, meta);
    if (wp) { log('debug', 'geo-photo-found', { label, layer: 'wikipedia' }); return wp; }
  }
  // Layer 3 (text search) removed — returns non-location images (books, diagrams, etc.)
  log('warn', 'geo-photo-fail', { label, wikiTitle: meta.wikiTitle || 'none' });
  return null;
}

// Tracks titles used in recent games so the same location isn't repeated across games
const geoRecentTitles = new Set();
const GEO_RECENT_MAX = 40;

async function selectGeoRounds(difficulty, totalRounds, customPhotos) {
  const rounds = [];
  for (const cp of (customPhotos || [])) {
    if (rounds.length >= totalRounds) break;
    const lat = parseFloat(cp.lat), lng = parseFloat(cp.lng);
    const url = typeof cp.photoUrl === 'string' && /^https?:\/\//i.test(cp.photoUrl) ? cp.photoUrl.slice(0, 500) : null;
    if (!isFinite(lat) || !isFinite(lng) || lat < -90 || lat > 90 || !url) continue;
    rounds.push({ photoUrl: url, lat, lng, country: String(cp.country || '?').slice(0, 50), city: String(cp.city || '').slice(0, 50), title: 'Custom Photo', difficulty: 'medium' });
  }
  const needed = totalRounds - rounds.length;
  if (needed <= 0) return rounds;
  const pool = getGeoDifficultyPool(difficulty);
  // Prefer entries not seen recently; fall back to all entries if not enough fresh ones
  const fresh = pool.filter(e => !geoRecentTitles.has(e.title));
  const candidates = (fresh.length >= needed ? fresh : pool).sort(() => Math.random() - 0.5).slice(0, Math.min(needed * 3, pool.length));
  log('info', 'geo-select-start', { difficulty, totalRounds, poolSize: pool.length, fresh: fresh.length, trying: candidates.length });
  const usedUrls = new Set(rounds.map(r => r.photoUrl));
  // Sequential fetching — parallel requests trigger Wikimedia 429 rate limiting
  for (const entry of candidates) {
    if (rounds.length >= totalRounds) break;
    const result = await fetchGeoPhoto(entry.lat, entry.lng, entry);
    if (result && !usedUrls.has(result.photoUrl)) {
      usedUrls.add(result.photoUrl); rounds.push(result);
      geoRecentTitles.add(entry.title);
      if (geoRecentTitles.size > GEO_RECENT_MAX) geoRecentTitles.delete(geoRecentTitles.values().next().value);
    }
  }
  log('info', 'geo-select-done', { got: rounds.length, needed: totalRounds });
  return rounds.slice(0, totalRounds);
}

function randomGeoCoord() {
  const regions = [
    [35, 60, -10, 40], [20, 40, -10, 55], [-35, 35, -20, 55],
    [5, 55, 60, 145], [25, 50, -130, -60], [-55, 15, -80, -35], [-45, -10, 110, 180],
  ];
  const r = regions[Math.floor(Math.random() * regions.length)];
  return { lat: r[0] + Math.random() * (r[1] - r[0]), lng: r[2] + Math.random() * (r[3] - r[2]) };
}

function getGeoDifficultyPool(difficulty) {
  if (difficulty === 'easy') return GEO_DB.filter(e => e.difficulty === 'easy');
  if (difficulty === 'hard' || difficulty === 'nohints') return GEO_DB.filter(e => e.difficulty !== 'easy');
  return GEO_DB;
}

// ── Memory Duel helpers ───────────────────────────────────────────
const MD_EMOJIS = ['🐶','🐱','🐸','🦊','🐼','🐨','🦁','🐯','🦋','🌸','🌺','🍕','🍔','🎸','🎮','🚀','🌈','⚡','🔥','💎','👑','🎯','🎪','🏆'];
const MD_COLORS = ['#6d28d9','#1d4ed8','#0891b2','#059669','#65a30d','#d97706','#dc2626','#db2777','#7c3aed','#2563eb','#0e7490','#047857','#4d7c0f','#b45309','#b91c1c','#9d174d','#5b21b6','#1e40af','#155e75','#064e3b','#365314','#78350f','#7f1d1d','#831843'];

function mdAdvanceTurn(room, fromId) {
  if (!room.md?.active) return;
  const md = room.md;
  const playerIds = [...room.players.keys()];
  const fromIdx = playerIds.indexOf(fromId);
  let nextIdx = (fromIdx + 1) % playerIds.length;
  let nextId = playerIds[nextIdx];
  let skipReason = undefined;
  if (md.penalties.has(nextId)) {
    md.penalties.delete(nextId);
    skipReason = 'steal-penalty';
    const skippedId = nextId;
    nextIdx = (nextIdx + 1) % playerIds.length;
    nextId = playerIds[nextIdx];
    broadcastRoom(room.id, { type: 'md-turn-change', activeId: skippedId, skipped: true, skipReason, nextId });
    setTimeout(() => {
      if (!room.md?.active) return;
      md.turnId = nextId;
      md.firstFlip = null;
      md.stealWindow = null;
      md.turnPhase = 'idle';
      broadcastRoom(room.id, { type: 'md-turn-change', activeId: nextId });
    }, 1500);
    return;
  }
  md.turnId = nextId;
  md.firstFlip = null;
  md.stealWindow = null;
  md.turnPhase = 'idle';
  broadcastRoom(room.id, { type: 'md-turn-change', activeId: nextId });
}

function mdEndGame(room) {
  if (!room.md) return;
  const md = room.md;
  md.active = false;
  room.status = 'waiting';
  const playerIds = [...room.players.keys()];
  let winnerId = null, highScore = -1, tie = false;
  for (const pid of playerIds) {
    const s = md.scores[pid] || 0;
    if (s > highScore) { highScore = s; winnerId = pid; tie = false; }
    else if (s === highScore) { tie = true; }
  }
  if (tie && md.lastCaptor) winnerId = md.lastCaptor;
  md.winner = winnerId;
  const winnerName = room.players.get(winnerId)?.name || '?';
  const stats = {};
  for (const pid of playerIds) {
    stats[pid] = { score: md.scores[pid] || 0, stealAttempts: md.stealStats[pid]?.attempts || 0, stealSuccesses: md.stealStats[pid]?.successes || 0, stealFailures: md.stealStats[pid]?.failures || 0, longestStreak: md.longestStreak[pid] || 0 };
  }
  broadcastRoom(room.id, { type: 'md-game-over', winnerId, winnerName, scores: { ...md.scores }, stats });
  broadcastLobby();
  log('info', 'md-end', { roomId: room.id, winnerId, winnerName });
}

const GEO_DB = [
  // ── Easy — famous landmarks ──────────────────────────────────
  { lat: 48.8584, lng: 2.2945, country: 'France', city: 'Paris', difficulty: 'easy', title: 'Eiffel Tower', wikiTitle: 'Eiffel_Tower' },
  { lat: 41.8902, lng: 12.4922, country: 'Italy', city: 'Rome', difficulty: 'easy', title: 'Colosseum', wikiTitle: 'Colosseum' },
  { lat: 27.1751, lng: 78.0421, country: 'India', city: 'Agra', difficulty: 'easy', title: 'Taj Mahal', wikiTitle: 'Taj_Mahal' },
  { lat: 40.4319, lng: 116.5704, country: 'China', city: 'Beijing', difficulty: 'easy', title: 'Great Wall of China', wikiTitle: 'Great_Wall_of_China' },
  { lat: 29.9792, lng: 31.1342, country: 'Egypt', city: 'Giza', difficulty: 'easy', title: 'Pyramids of Giza', wikiTitle: 'Egyptian_pyramids' },
  { lat: 40.6892, lng: -74.0445, country: 'USA', city: 'New York', difficulty: 'easy', title: 'Statue of Liberty', wikiTitle: 'Statue_of_Liberty' },
  { lat: 51.5007, lng: -0.1246, country: 'UK', city: 'London', difficulty: 'easy', title: 'Big Ben', wikiTitle: 'Big_Ben' },
  { lat: 41.4036, lng: 2.1744, country: 'Spain', city: 'Barcelona', difficulty: 'easy', title: 'Sagrada Familia', wikiTitle: 'Sagrada_Família' },
  { lat: -33.8568, lng: 151.2153, country: 'Australia', city: 'Sydney', difficulty: 'easy', title: 'Sydney Opera House', wikiTitle: 'Sydney_Opera_House' },
  { lat: -22.9519, lng: -43.2105, country: 'Brazil', city: 'Rio de Janeiro', difficulty: 'easy', title: 'Christ the Redeemer', wikiTitle: 'Christ_the_Redeemer_(statue)' },
  { lat: 25.1972, lng: 55.2744, country: 'UAE', city: 'Dubai', difficulty: 'easy', title: 'Burj Khalifa', wikiTitle: 'Burj_Khalifa' },
  { lat: 37.9715, lng: 23.7257, country: 'Greece', city: 'Athens', difficulty: 'easy', title: 'Acropolis of Athens', wikiTitle: 'Acropolis_of_Athens' },
  { lat: -13.1631, lng: -72.5450, country: 'Peru', city: 'Cusco', difficulty: 'easy', title: 'Machu Picchu', wikiTitle: 'Machu_Picchu' },
  { lat: 13.4125, lng: 103.8660, country: 'Cambodia', city: 'Siem Reap', difficulty: 'easy', title: 'Angkor Wat', wikiTitle: 'Angkor_Wat' },
  { lat: 35.3606, lng: 138.7274, country: 'Japan', city: 'Fujiyoshida', difficulty: 'easy', title: 'Mount Fuji', wikiTitle: 'Mount_Fuji' },
  { lat: 43.8791, lng: 10.8997, country: 'Italy', city: 'Pisa', difficulty: 'easy', title: 'Leaning Tower of Pisa', wikiTitle: 'Leaning_Tower_of_Pisa' },
  { lat: 37.8199, lng: -122.4783, country: 'USA', city: 'San Francisco', difficulty: 'easy', title: 'Golden Gate Bridge', wikiTitle: 'Golden_Gate_Bridge' },
  { lat: 36.1069, lng: -112.1129, country: 'USA', city: 'Grand Canyon', difficulty: 'easy', title: 'Grand Canyon', wikiTitle: 'Grand_Canyon' },
  { lat: 48.2093, lng: 16.3728, country: 'Austria', city: 'Vienna', difficulty: 'easy', title: 'Schönbrunn Palace', wikiTitle: 'Schönbrunn_Palace' },
  { lat: 51.1789, lng: -1.8262, country: 'UK', city: 'Wiltshire', difficulty: 'easy', title: 'Stonehenge', wikiTitle: 'Stonehenge' },
  { lat: 36.3932, lng: 25.4615, country: 'Greece', city: 'Santorini', difficulty: 'easy', title: 'Santorini Caldera', wikiTitle: 'Santorini' },
  { lat: 45.4371, lng: 12.3328, country: 'Italy', city: 'Venice', difficulty: 'easy', title: 'Venice Grand Canal', wikiTitle: 'Grand_Canal_(Venice)' },
  { lat: 55.7558, lng: 37.6173, country: 'Russia', city: 'Moscow', difficulty: 'easy', title: 'Red Square', wikiTitle: 'Red_Square' },
  { lat: 39.9163, lng: 116.3972, country: 'China', city: 'Beijing', difficulty: 'easy', title: 'Forbidden City', wikiTitle: 'Forbidden_City' },
  { lat: 20.9101, lng: 107.1839, country: 'Vietnam', city: 'Ha Long Bay', difficulty: 'easy', title: 'Ha Long Bay', wikiTitle: 'Ha_Long_Bay' },
  { lat: 30.3285, lng: 35.4444, country: 'Jordan', city: 'Petra', difficulty: 'easy', title: 'Petra Treasury', wikiTitle: 'Petra' },
  { lat: 38.6431, lng: 34.8289, country: 'Turkey', city: 'Nevşehir', difficulty: 'easy', title: 'Cappadocia', wikiTitle: 'Cappadocia' },
  { lat: 43.0799, lng: -79.0747, country: 'Canada', city: 'Niagara', difficulty: 'easy', title: 'Niagara Falls', wikiTitle: 'Niagara_Falls' },
  { lat: -3.0674, lng: 37.3556, country: 'Tanzania', city: 'Kilimanjaro', difficulty: 'easy', title: 'Mount Kilimanjaro', wikiTitle: 'Mount_Kilimanjaro' },
  { lat: -17.9243, lng: 25.8572, country: 'Zimbabwe', city: 'Victoria Falls', difficulty: 'easy', title: 'Victoria Falls', wikiTitle: 'Victoria_Falls' },
  { lat: -33.9625, lng: 18.4107, country: 'South Africa', city: 'Cape Town', difficulty: 'easy', title: 'Table Mountain', wikiTitle: 'Table_Mountain' },
  { lat: -25.3444, lng: 131.0369, country: 'Australia', city: 'Northern Territory', difficulty: 'easy', title: 'Uluru', wikiTitle: 'Uluru' },
  // ── Tunisia (20 entries) ──────────────────────────────────────
  { lat: 35.2965, lng: 8.6935, country: 'Tunisia', city: 'El Jem', difficulty: 'easy', title: 'Amphitheater of El Jem', wikiTitle: 'El_Djem' },
  { lat: 36.7992, lng: 10.1714, country: 'Tunisia', city: 'Tunis', difficulty: 'medium', title: 'Medina of Tunis', wikiTitle: 'Medina_of_Tunis' },
  { lat: 36.8705, lng: 10.3434, country: 'Tunisia', city: 'Sidi Bou Said', difficulty: 'easy', title: 'Sidi Bou Said', wikiTitle: 'Sidi_Bou_Said' },
  { lat: 35.6781, lng: 10.0517, country: 'Tunisia', city: 'Kairouan', difficulty: 'easy', title: 'Great Mosque of Kairouan', wikiTitle: 'Great_Mosque_of_Kairouan' },
  { lat: 36.4228, lng: 9.2191, country: 'Tunisia', city: 'Dougga', difficulty: 'medium', title: 'Dougga Roman Ruins', wikiTitle: 'Dougga' },
  { lat: 33.5000, lng: 8.0000, country: 'Tunisia', city: 'Tozeur', difficulty: 'medium', title: 'Chott el Djerid' },
  { lat: 33.0667, lng: 9.0167, country: 'Tunisia', city: 'Tataouine', difficulty: 'hard', title: 'Ksar Ouled Soltane' },
  { lat: 33.5406, lng: 9.9715, country: 'Tunisia', city: 'Matmata', difficulty: 'medium', title: 'Matmata Underground Houses' },
  { lat: 33.9197, lng: 8.1337, country: 'Tunisia', city: 'Tozeur', difficulty: 'medium', title: 'Tozeur Oasis' },
  { lat: 37.2736, lng: 9.8736, country: 'Tunisia', city: 'Bizerte', difficulty: 'medium', title: 'Port of Bizerte' },
  { lat: 36.4000, lng: 10.6167, country: 'Tunisia', city: 'Hammamet', difficulty: 'medium', title: 'Hammamet Beach' },
  { lat: 35.8286, lng: 10.6380, country: 'Tunisia', city: 'Sousse', difficulty: 'medium', title: 'Sousse Medina' },
  { lat: 34.7398, lng: 10.7600, country: 'Tunisia', city: 'Sfax', difficulty: 'medium', title: 'Sfax Old City' },
  { lat: 36.8528, lng: 10.3232, country: 'Tunisia', city: 'Carthage', difficulty: 'easy', title: 'Carthage Ruins' },
  { lat: 36.4533, lng: 10.7358, country: 'Tunisia', city: 'Nabeul', difficulty: 'hard', title: 'Nabeul Pottery Town' },
  { lat: 36.9553, lng: 8.7582, country: 'Tunisia', city: 'Tabarka', difficulty: 'hard', title: 'Tabarka Coastline' },
  { lat: 35.7765, lng: 10.8262, country: 'Tunisia', city: 'Monastir', difficulty: 'medium', title: 'Monastir Ribat' },
  { lat: 36.5569, lng: 8.7565, country: 'Tunisia', city: 'Jendouba', difficulty: 'hard', title: 'Bulla Regia Ruins' },
  { lat: 33.4567, lng: 9.0236, country: 'Tunisia', city: 'Douz', difficulty: 'medium', title: 'Douz Desert Gateway' },
  { lat: 33.2167, lng: 10.6833, country: 'Tunisia', city: 'Zarzis', difficulty: 'hard', title: 'Zarzis Coastal Area' },
  // ── North Africa ──────────────────────────────────────────────
  { lat: 31.6259, lng: -7.9891, country: 'Morocco', city: 'Marrakech', difficulty: 'easy', title: 'Djemaa el-Fna', wikiTitle: 'Djemaa_el-Fna' },
  { lat: 35.1686, lng: -5.2697, country: 'Morocco', city: 'Chefchaouen', difficulty: 'easy', title: 'Blue City Chefchaouen', wikiTitle: 'Chefchaouen' },
  { lat: 33.6083, lng: -7.6325, country: 'Morocco', city: 'Casablanca', difficulty: 'medium', title: 'Hassan II Mosque', wikiTitle: 'Hassan_II_Mosque' },
  { lat: 34.0641, lng: -4.9776, country: 'Morocco', city: 'Fez', difficulty: 'medium', title: 'Fes el-Bali Medina', wikiTitle: 'Fes_el-Bali' },
  { lat: 31.0475, lng: -7.1295, country: 'Morocco', city: 'Ouarzazate', difficulty: 'medium', title: 'Ait Benhaddou', wikiTitle: 'Aït_Benhaddou' },
  { lat: 29.9753, lng: 31.1376, country: 'Egypt', city: 'Giza', difficulty: 'easy', title: 'Great Sphinx of Giza', wikiTitle: 'Great_Sphinx_of_Giza' },
  { lat: 25.7188, lng: 32.6573, country: 'Egypt', city: 'Luxor', difficulty: 'easy', title: 'Karnak Temple', wikiTitle: 'Karnak' },
  { lat: 22.3372, lng: 31.6259, country: 'Egypt', city: 'Aswan', difficulty: 'easy', title: 'Abu Simbel Temple', wikiTitle: 'Abu_Simbel' },
  { lat: 30.0444, lng: 31.2357, country: 'Egypt', city: 'Cairo', difficulty: 'medium', title: 'Cairo Citadel', wikiTitle: 'Cairo_Citadel' },
  { lat: 35.4842, lng: 6.4684, country: 'Algeria', city: 'Batna', difficulty: 'hard', title: 'Timgad Roman Ruins' },
  { lat: 32.4908, lng: 3.6740, country: 'Algeria', city: 'Ghardaia', difficulty: 'hard', title: "Ghardaia M'Zab Valley" },
  { lat: 32.6387, lng: 14.2975, country: 'Libya', city: 'Al Khums', difficulty: 'hard', title: 'Leptis Magna' },
  // ── Europe ───────────────────────────────────────────────────
  { lat: 50.0755, lng: 14.4378, country: 'Czech Republic', city: 'Prague', difficulty: 'medium', title: 'Prague Castle', wikiTitle: 'Prague_Castle' },
  { lat: 52.3702, lng: 4.8952, country: 'Netherlands', city: 'Amsterdam', difficulty: 'medium', title: 'Amsterdam Canals', wikiTitle: 'Amsterdam' },
  { lat: 55.9486, lng: -3.1999, country: 'UK', city: 'Edinburgh', difficulty: 'medium', title: 'Edinburgh Castle', wikiTitle: 'Edinburgh_Castle' },
  { lat: 42.6507, lng: 18.0944, country: 'Croatia', city: 'Dubrovnik', difficulty: 'medium', title: 'Dubrovnik Old Town', wikiTitle: 'Dubrovnik' },
  { lat: 37.1767, lng: -3.5886, country: 'Spain', city: 'Granada', difficulty: 'medium', title: 'Alhambra Palace', wikiTitle: 'Alhambra' },
  { lat: 64.1355, lng: -21.8954, country: 'Iceland', city: 'Reykjavík', difficulty: 'medium', title: 'Icelandic Landscape' },
  { lat: 60.3913, lng: 5.3221, country: 'Norway', city: 'Bergen', difficulty: 'medium', title: 'Bergen Fjords' },
  { lat: 48.1351, lng: 11.5820, country: 'Germany', city: 'Munich', difficulty: 'medium', title: 'Marienplatz Munich' },
  { lat: 47.3769, lng: 8.5417, country: 'Switzerland', city: 'Zürich', difficulty: 'hard', title: 'Zurich Old Town' },
  { lat: 53.3498, lng: -6.2603, country: 'Ireland', city: 'Dublin', difficulty: 'hard', title: 'Dublin Streets' },
  // ── Asia ──────────────────────────────────────────────────────
  { lat: -8.4095, lng: 115.1889, country: 'Indonesia', city: 'Bali', difficulty: 'medium', title: 'Bali Rice Terraces' },
  { lat: 35.0116, lng: 135.7681, country: 'Japan', city: 'Kyoto', difficulty: 'medium', title: 'Kyoto Fushimi Inari' },
  { lat: 13.7563, lng: 100.5018, country: 'Thailand', city: 'Bangkok', difficulty: 'medium', title: 'Bangkok Temples' },
  { lat: 28.6139, lng: 77.2090, country: 'India', city: 'New Delhi', difficulty: 'medium', title: 'India Gate Delhi' },
  { lat: 27.9881, lng: 86.9250, country: 'Nepal', city: 'Solukhumbu', difficulty: 'hard', title: 'Everest Base Camp Area' },
  { lat: 27.4728, lng: 89.6390, country: 'Bhutan', city: 'Thimphu', difficulty: 'hard', title: 'Bhutan Mountains' },
  { lat: 4.1755, lng: 73.5093, country: 'Maldives', city: 'Malé', difficulty: 'hard', title: 'Maldives Atoll' },
  { lat: 21.1717, lng: 94.8586, country: 'Myanmar', city: 'Bagan', difficulty: 'medium', title: 'Bagan Temples' },
  { lat: 1.3521, lng: 103.8198, country: 'Singapore', city: 'Singapore', difficulty: 'medium', title: 'Singapore City' },
  // ── Americas ─────────────────────────────────────────────────
  { lat: 40.7580, lng: -73.9855, country: 'USA', city: 'New York', difficulty: 'easy', title: 'Times Square NYC' },
  { lat: 19.4326, lng: -99.1332, country: 'Mexico', city: 'Mexico City', difficulty: 'medium', title: 'Zócalo Mexico City' },
  { lat: 23.1370, lng: -82.3589, country: 'Cuba', city: 'Havana', difficulty: 'medium', title: 'Old Havana' },
  { lat: 10.4230, lng: -75.5500, country: 'Colombia', city: 'Cartagena', difficulty: 'medium', title: 'Cartagena Walled City' },
  { lat: -34.6037, lng: -58.3816, country: 'Argentina', city: 'Buenos Aires', difficulty: 'medium', title: 'Buenos Aires Centro' },
  { lat: -33.4489, lng: -70.6693, country: 'Chile', city: 'Santiago', difficulty: 'medium', title: 'Santiago de Chile' },
  { lat: -54.8019, lng: -68.3030, country: 'Argentina', city: 'Ushuaia', difficulty: 'hard', title: 'Ushuaia End of the World' },
  { lat: -13.5319, lng: -71.9675, country: 'Peru', city: 'Cusco', difficulty: 'medium', title: 'Cusco Main Square' },
  // ── Africa ───────────────────────────────────────────────────
  { lat: -2.3333, lng: 34.8333, country: 'Tanzania', city: 'Serengeti', difficulty: 'hard', title: 'Serengeti Plains' },
  { lat: 12.0320, lng: 39.0472, country: 'Ethiopia', city: 'Lalibela', difficulty: 'hard', title: 'Lalibela Rock Churches' },
  { lat: 14.7167, lng: -17.4677, country: 'Senegal', city: 'Dakar', difficulty: 'medium', title: 'Dakar Atlantic Coast' },
  // ── Oceania ──────────────────────────────────────────────────
  { lat: -36.8485, lng: 174.7633, country: 'New Zealand', city: 'Auckland', difficulty: 'medium', title: 'Auckland City' },
  { lat: -18.2861, lng: 147.6992, country: 'Australia', city: 'Queensland', difficulty: 'medium', title: 'Great Barrier Reef' },
  { lat: -38.1368, lng: 176.2497, country: 'New Zealand', city: 'Rotorua', difficulty: 'hard', title: 'Rotorua Geysers' },
  { lat: -37.8136, lng: 144.9631, country: 'Australia', city: 'Melbourne', difficulty: 'medium', title: 'Melbourne CBD' },
];

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

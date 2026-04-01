const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { createHmac } = require('crypto');

const ROOM_PW_SECRET = process.env.ROOM_PW_SECRET || 'arena-room-secret-default';
function hashRoomPw(pw) { return createHmac('sha256', ROOM_PW_SECRET).update(pw).digest('hex'); }

const PORT = process.env.PORT || 3007;

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
const ROUTES = { '/': '/lobby.html', '/maze': '/maze.html', '/tetris': '/tetris.html', '/tictactoe': '/tictactoe.html', '/bluffrummy': '/bluffrummy.html' };

const httpServer = http.createServer((req, res) => {
  const urlPath = req.url.split('?')[0];
  const safePath = path.normalize(ROUTES[urlPath] || urlPath).replace(/^(\.\.[/\\])+/, '');
  const isRoot = safePath === '/' || safePath === '\\' || safePath === '.';
  const filePath = path.join(PUBLIC, isRoot ? 'lobby.html' : safePath);
  if (!filePath.startsWith(PUBLIC)) {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress;
    log('warn', 'path-traversal', { ip, url: req.url });
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
    // Remove player from bluff rummy
    room.br.turnOrder = room.br.turnOrder.filter(pid => pid !== conn.id);
    room.br.hands.delete(conn.id);
    if (room.br.turnIdx >= room.br.turnOrder.length) room.br.turnIdx = 0;
    if (room.players.size === 0) {
      room.br = null;
    } else if (room.br.turnOrder.length <= 1) {
      endBluffRummy(room);
    } else {
      broadcastBrPlayerUpdate(room);
      sendBrTurn(room);
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
        send(ws, { type: 'room-list', rooms: serializeRooms() });
        log('info', 'lobby-join', { id, name: conn.name, ip: conn.ip });
        break;
      }

      case 'create-room': {
        const type = msg.gameType === 'tetris' ? 'tetris' : msg.gameType === 'tictactoe' ? 'tictactoe' : msg.gameType === 'bluffrummy' ? 'bluffrummy' : 'maze';
        const name = String(msg.roomName || conn.name + "'s Room").slice(0, 30);
        const max = type === 'tictactoe' ? 2 : type === 'bluffrummy' ? Math.min(4, Math.max(2, parseInt(msg.maxPlayers) || 4)) : Math.min(8, Math.max(2, parseInt(msg.maxPlayers) || 6));
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
        log('info', 'room-joined', { id, name: conn.name, ip: conn.ip, roomId: room.id, roomType: room.type, players: room.players.size });
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
        if (room.players.size < 2) { send(ws, { type: 'error', msg: 'Need 2-4 players' }); return; }
        startBluffRummy(room);
        break;
      }
      case 'br-play': {
        const room = rooms.get(conn.roomId);
        if (!room || !room.br || !room.br.active) return;
        const br = room.br;
        if (br.turnOrder[br.turnIdx] !== id) return; // not your turn
        const indices = msg.indices;
        const annNum = parseInt(msg.announceNum);
        if (!Array.isArray(indices) || indices.length < 1 || indices.length > 3) return;
        if (annNum < 1 || annNum > 13) return;
        // If meld exists, announced number must match
        if (br.meldNum !== null && annNum !== br.meldNum) return;
        const playerHand = br.hands.get(id);
        if (!playerHand) return;
        // Validate indices
        const sortedIdx = [...new Set(indices)].sort((a, b) => b - a);
        if (sortedIdx.some(i => i < 0 || i >= playerHand.length)) return;
        // Extract cards
        const playedCards = sortedIdx.map(i => playerHand[i]);
        sortedIdx.forEach(i => playerHand.splice(i, 1));
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
        if (br.turnOrder[br.turnIdx] !== id) return;
        if (!br.lastPlayerId || br.lastPlayerId === id) return; // can't challenge self or if no play
        const challengerName = conn.name;
        const targetConn = conns.get(br.lastPlayerId);
        const targetName = targetConn ? targetConn.name : 'Player';
        broadcastRoom(room.id, { type: 'br-challenge', challengerName, targetName });
        // Reveal all cards in the meld
        const allCards = br.meldCards.map(c => ({ num: c.num, suit: c.suit }));
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
        }
        broadcastRoom(room.id, {
          type: 'br-reveal', cards: allCards, announcedNum: br.lastAnnouncedNum,
          wasBluff, challengerName, targetName,
          takerName: takerConn ? takerConn.name : 'Player',
          takerId,
        });
        // Send updated hand to the taker
        if (takerHand) send(conns.get(takerId)?.ws, { type: 'br-hand-update', hand: takerHand });
        log('info', 'br-challenge', { roomId: room.id, challenger: challengerName, target: targetName, wasBluff, cardsRevealed: allCards.length });
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

      case 'game-over': {
        const room = rooms.get(conn.roomId);
        if (!room) return;
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
  for (const pid of playerIds) {
    const hand = hands.get(pid);
    const counts = {};
    for (const c of hand) counts[c.num] = (counts[c.num] || 0) + 1;
    for (const [numStr, cnt] of Object.entries(counts)) {
      if (cnt === 4) {
        const num = parseInt(numStr);
        // Remove all 4
        const newHand = hand.filter(c => c.num !== num);
        hands.set(pid, newHand);
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
    active: true,
  };
  room.status = 'playing';
  broadcastLobby();

  // Send initial hands
  for (const [pid, p] of room.players) {
    const hand = hands.get(pid);
    send(p.ws, { type: 'br-dealt', hand });
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
      canChallenge: currentTurnId === pid && br.lastPlayerId && br.lastPlayerId !== pid,
      meldNum: br.meldNum,
      meldSize: br.meldCards.length,
      players: playersList,
      rankings: br.active ? [] : br.finishOrder.map((fid, i) => ({
        id: fid, name: room.players.get(fid)?.name || 'Player', rank: i + 1,
      })),
    });
  }
}

function sendBrTurn(room) {
  const br = room.br;
  if (!br || !br.active || br.turnOrder.length === 0) return;
  const currentTurnId = br.turnOrder[br.turnIdx];
  for (const [pid, p] of room.players) {
    send(p.ws, {
      type: 'br-turn',
      currentTurn: currentTurnId,
      canChallenge: currentTurnId === pid && br.lastPlayerId != null && br.lastPlayerId !== pid,
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

httpServer.listen(PORT, () => {
  console.log(`\n  🎮 Game Arena running at http://localhost:${PORT}\n`);
  log('info', 'server-start', { port: PORT, node: process.version, pid: process.pid });
});

// ── Periodic stats ───────────────────────────────────────────────
setInterval(() => {
  const uptimeSec = Math.floor((Date.now() - startTime) / 1000);
  const memMB = (process.memoryUsage().rss / 1024 / 1024).toFixed(1);
  log('stats', 'heartbeat', { conns: conns.size, rooms: rooms.size, totalConnections, uptimeSec, memMB });
}, 60_000);

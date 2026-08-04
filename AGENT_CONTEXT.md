# AGENT_CONTEXT.md — Game Arena Platform

> **Purpose:** Read this file first. It replaces all codebase exploration for new feature work.
> Written from a full read of every relevant file. Last updated: 2026-08-04.

---

## 1. PROJECT OVERVIEW

### What it is
A browser-based multiplayer gaming platform where friends create/join rooms and play games together in real time. Hosted on Render. No login wall for gameplay — Firebase Auth gates score submission.

### Tech Stack

**Backend**
| Technology | Version | Role |
|---|---|---|
| Node.js | ≥20.0.0 | Runtime |
| `ws` | ^8.16.0 | WebSocket server |
| `firebase-admin` | ^12.0.0 | Auth token verification + Firestore |
| Built-in `http`, `fs`, `path`, `crypto` | — | HTTP server, static files, HMAC |

**Frontend**
| Technology | Role |
|---|---|
| Vanilla HTML/CSS/JS | No framework, no build step |
| Firebase Web SDK compat 10.12.5 | Auth (Google + email/password) |
| Google Fonts: Orbitron + Inter | Typography |
| Game-specific CDN libs (Three.js, etc.) | Per-game imports in HTML `<head>` |

### Directory Structure
```
arena/
├── server.js            # Single backend entry point — HTTP + WebSocket + all game logic
├── package.json         # scripts:{start:"node server.js"}, deps: ws + firebase-admin
├── render.yaml          # Render deployment config
├── service-account.json # Firebase service account (local only; prod uses env var)
├── firestore.rules      # Firestore security rules
├── AGENT_CONTEXT.md     # This file
└── public/              # All static files served at /
    ├── lobby.html/css/js          # Main hub: auth, room list, create/join
    ├── firebase-init.js           # Shared Firebase SDK init (included by every page)
    ├── {game}.html/css/js         # One triplet per game
    └── assets/                    # Card images, etc.
```

### Running Locally
```bash
npm install
node server.js
# Runs at http://localhost:3009
```
Requires `service-account.json` with Firebase credentials OR env var `FIREBASE_SERVICE_ACCOUNT` (JSON string).

### Deployment (Render)
- **Build command:** `npm install`
- **Start command:** `npm start` (`node server.js`)
- **Env vars needed in production:**
  - `FIREBASE_SERVICE_ACCOUNT` — full JSON of service account (replaces local file)
  - `ROOM_PW_SECRET` — HMAC secret for hashing room passwords (defaults to `arena-room-secret-default`)
  - `PORT` — auto-set by Render (defaults to 3009 locally)
- Static files served directly from `public/` by the same Node process (no CDN, no Nginx)

---

## 2. BACKEND ARCHITECTURE

### Entry Point: `server.js`
One monolithic file (~6800 lines). Contains:
1. Firebase Admin SDK init + Firestore auto-provisioning
2. Constants: `VALID_GAMES`, `LOWER_IS_BETTER`, `WIN_INCREMENT_GAMES`, `ROUTES`
3. HTTP server (static files + REST APIs)
4. WebSocket server
5. All room lifecycle logic
6. All game-specific message handlers and helpers (inline, not separate files)

### HTTP Server
```js
const httpServer = http.createServer((req, res) => { ... });
```
Routes handled in order:
1. `GET /api/leaderboard?game=X` — Firestore query
2. `POST /api/score` — save personal best / increment wins (requires Firebase Bearer token)
3. `GET /api/skins` — tetris skin system
4. `POST /api/skins/equip` — equip skin
5. Static files from `public/` using `ROUTES` map + path normalization
   - Path traversal blocked (`!filePath.startsWith(PUBLIC)`)
   - `.json` files blocked (except `manifest.json`)

**`ROUTES` map** (maps URL path → file in `public/`):
```js
const ROUTES = {
  '/': '/lobby.html',
  '/maze': '/maze.html',
  '/tetris': '/tetris.html',
  // ... one entry per game
  '/sudoku': '/sudoku.html',
};
```
**Adding a game requires adding its route here.**

### WebSocket Server
```js
const wss = new WebSocketServer({ server: httpServer });
```
Attached to the same HTTP server (same port). All WS messages are JSON strings.

### Connection Tracking
```js
const conns = new Map();  // id (String) → conn object
const rooms = new Map();  // roomId (String) → room object
let nextId = 1;           // auto-incrementing integer ID (as String)
```

**`conn` object:**
```js
{
  id: '42',                 // String(nextId++)
  ws: WebSocket,
  name: 'PlayerName',       // up to 20 chars
  mode: 'lobby' | 'room',
  roomId: 'ABCD1' | null,
  ip: '1.2.3.4',
  connectedAt: 1700000000000,
  uid: 'firebase-uid',      // set after auth
  verified: true,           // set after token verification
}
```

**`room` object:**
```js
{
  id: 'ABCD1',              // 5-char code from genRoomId()
  type: 'sudoku',           // game type string
  name: "Alice's Room",
  maxPlayers: 4,
  players: new Map(),       // playerId → { ws, name, gameState }
  status: 'waiting' | 'playing',
  race: null,               // Maze-specific
  battle: null,             // Tetris-specific
  countdown: null,          // setInterval reference for countdown timers
  passwordHash: null | 'hex-string',
  // Game-specific state added at game start:
  // room.sudoku, room.br, room.rami, room.sl, room.uno,
  // room.tanks, room.bomberman, room.minesweeper, room.barricade,
  // room.td, room.eg, etc.
}
```

### Room Lifecycle
```
genRoomId() → 5 chars from 'ABCDEFGHJKMNPQRSTUVWXYZ23456789' (no ambiguous chars)
             → recursive retry if collision
```

1. **Create:** `create-room` message → `rooms.set(roomId, room)` → respond with `room-created`
2. **Join:** `join-room` message → add to `room.players` → respond with `room-joined` + broadcast `player-joined`
3. **Leave/Disconnect:** `removeFromRoom(conn)` → `room.players.delete(id)` → broadcast `player-left` → cleanup game state → if empty: `rooms.delete(roomId)`
4. **Destroy:** automatic when last player leaves

### Shared Utility Functions
```js
send(ws, msg)                          // ws.send(JSON.stringify(msg)) if readyState===1
broadcastRoom(roomId, msg, excludeId)  // send to all room.players except excludeId
broadcastLobby()                       // send room-list to all mode==='lobby' connections
serializeRooms()                       // → array of {id,name,type,players,maxPlayers,status,locked}
roomPlayerList(room, excludeId)        // → [{id,name,state}] excluding self
genRoomId()                            // → 5-char unique room code
hashRoomPw(pw)                         // HMAC-SHA256 of password
log(level, event, data)                // structured console log
```

### Message Routing (WebSocket)
```js
ws.on('message', async (raw) => {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  // Auth gate — every message except 'lobby' and 'join-room' requires conn.verified
  if (!conn.verified && msg.type !== 'lobby' && msg.type !== 'join-room') {
    send(ws, { type: 'error', msg: 'Not authenticated' });
    ws.close();
    return;
  }

  switch (msg.type) {
    case 'lobby': ...
    case 'create-room': ...
    case 'join-room': ...
    case 'leave-room': ...
    case 'state': ...           // generic state relay
    case 'chat': ...            // broadcast chat message
    // game-specific cases...
    case 'game-over': ...       // Tetris battle elimination
  }
});
```

### Disconnection Handling
`ws.on('close')` → calls `removeFromRoom(conn)` → game-specific cleanup per `room.{gameKey}?.active`. Each game block in `removeFromRoom` handles its own teardown (end game, forfeit, AI takeover, etc.).

### Authentication
- Firebase Auth — Google Sign-In + email/password
- Token sent in `lobby` and `join-room` messages
- Server calls `admin.auth().verifyIdToken(token)` to verify
- After verification: `conn.verified = true`, `conn.uid` = Firebase UID
- Token refresh: client sends fresh token on every `lobby` message (auto-refresh every 20s)

### Database (Firestore)
- Collection: `leaderboard`, doc ID: `{uid}_{game}`
- Collection: `user_prefs`, doc ID: `{uid}` — stores `equippedSkin`, `tester` flag
- Auto-provisioned on first run; retries every 30s if not ready
- Composite indexes auto-created on startup (game+score for leaderboard queries)

---

## 3. WEBSOCKET EVENT SYSTEM

### Message Format
```json
{ "type": "event-name-kebab-case", ...additionalFields }
```
**No nested `payload` object.** All data is flat at root level alongside `type`.

```js
// Examples from real code:
{ type: 'lobby', name: 'Alice', token: 'firebase-id-token' }
{ type: 'create-room', roomName: "Alice's Room", gameType: 'sudoku', maxPlayers: 4, password: null }
{ type: 'join-room', roomId: 'ABCD1', name: 'Alice', password: null, token: '...' }
{ type: 'room-joined', roomId: 'ABCD1', roomType: 'sudoku', roomName: "Alice's Room", myId: '42', players: [{id:'43',name:'Bob',state:null}], leaderId: '42' }
{ type: 'player-joined', id: '43', name: 'Bob', leaderId: '42' }
{ type: 'player-left', id: '43' }
{ type: 'error', msg: 'Room not found' }
{ type: 'room-list', rooms: [...], onlineUsers: ['Alice','Bob'] }
{ type: 'chat', text: 'hello!' }
{ type: 'state', data: { /* arbitrary game state */ } }
{ type: 'player-state', id: '43', data: { /* state */ } }  // broadcast of state
```

### Naming Conventions for Event Types
- **Shared platform events:** `lobby`, `create-room`, `join-room`, `leave-room`, `room-created`, `room-joined`, `player-joined`, `player-left`, `error`, `room-list`, `state`, `player-state`, `chat`, `game-over`
- **Game-specific events:** prefixed with a short game identifier in kebab-case:
  - Maze: `start-race`, `finish`, `race-started`, `race-results`
  - Tetris: `start-battle`, `battle-start`, `battle-end`, `player-gameover`
  - Tictactoe: `ttt-new`, `ttt-start`, `ttt-move`, `ttt-win`
  - Bluff Rummy: `br-*` prefix
  - Rami: `rami-*` prefix
  - Snakes & Ladders: `sl-*` prefix
  - UNO: `uno-*` prefix
  - Tanks: `tanks-*` prefix
  - Bomberman: `bm-*` prefix
  - Minesweeper: `ms-*` prefix
  - Barricade (Quoridor): `bar2-*` prefix
  - Tower Defense: `td-*` prefix
  - Sudoku: `sudoku-*` prefix

### Sending to One Client
```js
send(ws, { type: 'event', ...data });
// or direct: if (ws.readyState === 1) ws.send(JSON.stringify(msg));
```

### Sending to All Room Players
```js
broadcastRoom(roomId, { type: 'event', ...data });          // all players
broadcastRoom(roomId, { type: 'event', ...data }, senderId); // all except sender
```

### Error Communication
```js
send(ws, { type: 'error', msg: 'Human-readable error message' });
```

### No Heartbeat / Ping-Pong
The `ws` library handles TCP keepalive. No application-level ping/pong is implemented.

---

## 4. FRONTEND ARCHITECTURE

### No Framework
Pure HTML + CSS + JS. Each game is a self-contained triple of `.html` / `.css` / `.js`. No module bundler, no imports, no build step.

### Page Structure Pattern
Every game page follows this structure:
```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
  <title>GameName — Game Arena</title>
  <link rel="stylesheet" href="gamename.css">
  <link href="https://fonts.googleapis.com/css2?family=Orbitron:wght@400;700;900&family=Inter:wght@300;400;600&display=swap" rel="stylesheet">
  <script src="https://www.gstatic.com/firebasejs/10.12.5/firebase-app-compat.js"></script>
  <script src="https://www.gstatic.com/firebasejs/10.12.5/firebase-auth-compat.js"></script>
  <script src="/firebase-init.js"></script>
  <script>
    async function postScore(game, score) {
      try {
        const token = sessionStorage.getItem('arena-token') || (typeof fbAuth !== 'undefined' && fbAuth.currentUser ? await fbAuth.currentUser.getIdToken() : null);
        if (!token) return;
        await fetch('/api/score', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token }, body: JSON.stringify({ game, score }) });
      } catch {}
    }
    function reportScore(game, score) { postScore(game, score); }
  </script>
</head>
<body>
  <div class="layout">
    <aside class="sidebar" id="sidebar"> ... players list ... </aside>
    <main class="main-content">
      <header class="game-header">
        <button class="btn btn-sm btn-back" id="btnBack">← Lobby</button>
        <h1 class="logo logo-sm">GAME NAME</h1>
        <span class="room-badge" id="roomBadge"></span>
        <button class="btn btn-sm btn-rules" id="btnRules">📜 Rules</button>
      </header>
      <!-- lobby controls, game area, overlays -->
    </main>
  </div>
  <script src="gamename.js"></script>
</body>
</html>
```

### JS File Structure Pattern (IIFE)
All game JS is wrapped in an IIFE to avoid global scope pollution:
```js
(() => {
'use strict';

// URL / SESSION
const params = new URLSearchParams(location.search);
const roomId = params.get('room');
const myName = sessionStorage.getItem('arena-name') || 'Player';
if (!roomId) { location.href = '/'; return; }  // redirect if no room

// DOM REFS
const $ = id => document.getElementById(id);

// ROOM STATE
let ws = null, myId = null, leaderId = null;
const players = new Map(); // id → player data

// GAME STATE
// ...

// NETWORK
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    const pw = sessionStorage.getItem('arena-room-password') || undefined;
    sessionStorage.removeItem('arena-room-password');
    wsSend({ type: 'join-room', roomId, name: myName, password: pw, token: sessionStorage.getItem('arena-token') || '' });
  };
  ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => { statusEl.textContent = 'Disconnected. Returning to lobby…'; setTimeout(() => { location.href = '/'; }, 3000); };
}
function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function handleMsg(msg) {
  switch (msg.type) {
    case 'room-joined':
      myId = msg.myId; leaderId = msg.leaderId;
      // populate players Map, render player list, show host/guest UI
      break;
    case 'player-joined':
      // add to players Map, update UI
      leaderId = msg.leaderId;
      break;
    case 'player-left':
      players.delete(msg.id);
      break;
    case 'error':
      alert(msg.msg);
      location.href = '/';
      break;
    // game-specific cases...
  }
}

connect();
})();
```

### Session Storage Keys
| Key | Set by | Content |
|---|---|---|
| `arena-token` | lobby.js (Firebase auth) | Firebase ID token |
| `arena-name` | lobby.js | Display name |
| `arena-uid` | lobby.js | Firebase UID |
| `arena-display-name` | lobby.js | Display name (duplicate) |
| `arena-room-password` | lobby.js | Room password (cleared after join-room) |

### Navigation
- All navigation is `window.location.href` assignments — no client-side router
- Lobby → game page: `window.location.href = '/' + roomType + '?room=' + roomId`
- Game page → lobby: `location.href = '/'`
- `btnBack` button always navigates to `'/'`

### Host Detection
```js
const isHost = leaderId === myId;
// leaderId = room.players.keys().next().value on server (first player to join)
// Updated in player-joined/player-left messages
```

### Connection Loss
On WS close: show "Disconnected" message + `setTimeout(() => location.href = '/', 3000)`. No reconnect logic in game pages (unlike lobby which reconnects).

---

## 5. ROOM & LOBBY SYSTEM — FULL FLOW

### A. Player Creates a Room

**Lobby → Server:**
```json
{ "type": "create-room", "roomName": "Alice's Room", "gameType": "sudoku", "maxPlayers": 4, "password": null }
```

**Server → Lobby:**
```json
{ "type": "room-created", "roomId": "XKPQ7", "roomType": "sudoku", "roomName": "Alice's Room" }
```

**Lobby JS reaction:**
```js
case 'room-created':
  sessionStorage.setItem('arena-name', myName);
  // save password if set
  window.location.href = '/' + msg.roomType + '?room=' + msg.roomId;
  break;
```

### B. Player Joins a Room

Player clicks a room card → lobby navigates to `/{roomType}?room={roomId}`.

Game page opens fresh WebSocket → sends:
```json
{ "type": "join-room", "roomId": "XKPQ7", "name": "Bob", "password": null, "token": "firebase-token" }
```

**Server → Joiner:**
```json
{
  "type": "room-joined",
  "roomId": "XKPQ7",
  "roomType": "sudoku",
  "roomName": "Alice's Room",
  "myId": "43",
  "players": [{ "id": "42", "name": "Alice", "state": null }],
  "leaderId": "42"
}
```

**Server → All existing players:**
```json
{ "type": "player-joined", "id": "43", "name": "Bob", "leaderId": "42" }
```

### C. Game Start (Sudoku example)

Host sends:
```json
{ "type": "sudoku-start", "difficulty": "medium" }
```

Server broadcasts countdown + game start:
```json
{ "type": "sudoku-countdown", "count": 3, "difficulty": "medium" }
{ "type": "sudoku-countdown", "count": 2 }
{ "type": "sudoku-countdown", "count": 1 }
{ "type": "sudoku-go", "seed": 1234567, "difficulty": "medium" }
```

Both clients generate identical puzzle from `seed` deterministically (no puzzle data sent over wire).

### D. Mid-Game Events (Sudoku example)

Client → Server (progress update):
```json
{ "type": "sudoku-progress", "filled": 42 }
```

Server → All others:
```json
{ "type": "sudoku-player-progress", "id": "43", "name": "Bob", "filled": 42 }
```

### E. Game End (Sudoku example)

First solver sends:
```json
{ "type": "sudoku-complete", "time": 187 }
```

Server broadcasts:
```json
{ "type": "sudoku-winner", "winnerId": "43", "winnerName": "Bob", "time": 187 }
```

Server sets `room.status = 'waiting'`, calls `broadcastLobby()`.

### F. Player Leaves Mid-Game

Server detects disconnect or `leave-room` message → `removeFromRoom(conn)`:
1. `room.players.delete(id)`
2. Broadcasts `{ type: 'player-left', id }`
3. Game-specific teardown (varies by game — see §7)
4. If room empty: `rooms.delete(roomId)`
5. Calls `broadcastLobby()`

### G. Generic State Relay

Any client can send:
```json
{ "type": "state", "data": { "x": 100, "y": 200 } }
```

Server broadcasts to all others:
```json
{ "type": "player-state", "id": "42", "data": { "x": 100, "y": 200 } }
```

Used by games like Pool for continuous position updates.

---

## 6. HOW TO BUILD A NEW GAME MODULE

### Step-by-step guide (follow in order)

#### Step 1 — Register in server.js constants (top of file, ~line 117)

```js
// Add to VALID_GAMES:
const VALID_GAMES = new Set([..., 'mygame']);

// If wins should be tracked (increment counter per win):
const WIN_INCREMENT_GAMES = new Set([..., 'mygame']);

// If lower score is better (e.g. time-based):
// const LOWER_IS_BETTER = new Set([..., 'mygame']);
```

#### Step 2 — Add HTTP route (~line 148)

```js
const ROUTES = {
  ...,
  '/mygame': '/mygame.html',
};
```

#### Step 3 — Add to create-room type ternary (~line 676)

Find the large ternary chain for `type` and append before the final `'maze'` fallback:
```js
const type = ... : msg.gameType === 'sudoku' ? 'sudoku' : msg.gameType === 'mygame' ? 'mygame' : 'maze';
```

#### Step 4 — Add max players in create-room (~line 678)

Find the large ternary chain for `max`:
```js
const max = ... : type === 'mygame' ? 2 : Math.min(8, ...);
// For 1v1: 2
// For up to 4: Math.min(4, Math.max(2, parseInt(msg.maxPlayers) || 4))
```

#### Step 5 — Lock room while playing in join-room (~line 870 area)

Add after the existing lock blocks:
```js
if (room.status === 'playing' && room.type === 'mygame') {
  send(ws, { type: 'error', msg: 'Game in progress — this room is locked' }); break;
}
```

#### Step 6 — Add cleanup in removeFromRoom (~line 530 area)

Add before the `hasActiveGame` line:
```js
if (room.mygame && room.mygame.active) {
  room.mygame.active = false;
  room.status = 'waiting';
  broadcastRoom(room.id, { type: 'mygame-opponent-left' });
  broadcastLobby();
}
```

Add to `hasActiveGame` (~line 603):
```js
const hasActiveGame = ... || (room.mygame?.active);
```

#### Step 7 — Add message handlers (before `case 'game-over':` at ~line 2446)

```js
case 'mygame-start': {
  const room = rooms.get(conn.roomId);
  if (!room || room.type !== 'mygame') break;
  if (room.players.keys().next().value !== id) break; // host only
  if (room.mygame?.active) break;
  room.mygame = { active: true, startedAt: Date.now(), /* ...state */ };
  room.status = 'playing';
  broadcastLobby();
  broadcastRoom(room.id, { type: 'mygame-go', /* ...initial state */ });
  log('info', 'mygame-start', { roomId: room.id, players: room.players.size });
  break;
}
case 'mygame-move': {
  const room = rooms.get(conn.roomId);
  if (!room || !room.mygame?.active) break;
  const p = room.players.get(id);
  // validate and apply move
  broadcastRoom(room.id, { type: 'mygame-move', id, /* ...move data */ });
  break;
}
case 'mygame-complete': {
  const room = rooms.get(conn.roomId);
  if (!room || !room.mygame?.active) break;
  if (room.mygame.winner) break; // already decided
  const p = room.players.get(id);
  room.mygame.winner = id;
  room.mygame.active = false;
  room.status = 'waiting';
  broadcastRoom(room.id, { type: 'mygame-winner', winnerId: id, winnerName: p?.name || '?' });
  broadcastLobby();
  log('info', 'mygame-complete', { id, name: p?.name, roomId: room.id });
  break;
}
```

#### Step 8 — Add to lobby.html

In `#gameTypeSelect`:
```html
<option value="mygame">My Game</option>
```

In `.game-picker` div:
```html
<div class="game-pick-card" data-game="mygame">
  <span class="gpc-icon">🎮</span><span class="gpc-label">My Game</span>
</div>
```

In `.lb-tabs` div:
```html
<button class="lb-tab" data-game="mygame">🎮 My Game</button>
```

#### Step 9 — Add to lobby.js

In `renderRooms()` icon ternary (the big `icon = r.type === 'tetris' ? ...` chain):
```js
: r.type === 'mygame' ? '\u{1F3AE}'  // or appropriate unicode
: r.type === 'maze' ? '\u{1F3C1}' : '\u{1F3C1}';  // maze is the final fallback
```

In `LB_SUBTITLES` object:
```js
const LB_SUBTITLES = {
  ...,
  mygame: 'Total wins',
};
```

#### Step 10 — Create frontend files

**`public/mygame.html`** — Use the template in §4. Key points:
- Include Firebase SDK + `firebase-init.js` + `postScore` helper
- `.layout` > `.sidebar` > `.main-content` structure
- `#btnBack`, `#sidebar`, `#playerList`, `#playerCount`, `#roomBadge`, `#status` are platform standard IDs

**`public/mygame.css`** — Copy CSS variables block from any game CSS:
```css
:root {
  --bg: #0a0a1a;
  --bg-card: #12122a;
  --accent: #7c3aed;
  --accent-g: #a78bfa;
  --accent2: #06b6d4;
  --accent2-g: #67e8f9;
  --text: #e2e8f0;
  --text-dim: #94a3b8;
  --danger: #ef4444;
}
```

**`public/mygame.js`** — Minimal working skeleton:
```js
(() => {
'use strict';

const params = new URLSearchParams(location.search);
const roomId = params.get('room');
const myName = sessionStorage.getItem('arena-name') || 'Player';
if (!roomId) { location.href = '/'; return; }

const $ = id => document.getElementById(id);
const statusEl    = $('status');
const playerListEl = $('playerList');
const playerCountEl = $('playerCount');
const roomBadge   = $('roomBadge');
const btnBack     = $('btnBack');
const btnStart    = $('btnStart');

roomBadge.textContent = 'Room ' + roomId;
btnBack.addEventListener('click', () => { location.href = '/'; });

let ws = null, myId = null, leaderId = null;
const players = new Map();
let gamePhase = 'lobby'; // lobby | playing | ended

function isHost() { return leaderId === myId; }

function renderPlayerList() {
  playerListEl.innerHTML = '';
  playerCountEl.textContent = players.size;
  for (const [pid, p] of players) {
    const el = document.createElement('div');
    el.className = 'player-item' + (pid === myId ? ' is-me' : '');
    el.textContent = p.name + (pid === leaderId ? ' 👑' : '');
    playerListEl.appendChild(el);
  }
}

function updateHostUI() {
  if (btnStart) btnStart.style.display = isHost() && gamePhase === 'lobby' ? '' : 'none';
}

if (btnStart) {
  btnStart.addEventListener('click', () => {
    wsSend({ type: 'mygame-start' });
  });
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    const pw = sessionStorage.getItem('arena-room-password') || undefined;
    sessionStorage.removeItem('arena-room-password');
    wsSend({ type: 'join-room', roomId, name: myName, password: pw, token: sessionStorage.getItem('arena-token') || '' });
  };
  ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => { statusEl.textContent = 'Disconnected. Returning to lobby…'; setTimeout(() => { location.href = '/'; }, 3000); };
}

function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function handleMsg(msg) {
  switch (msg.type) {
    case 'room-joined':
      myId = msg.myId; leaderId = msg.leaderId;
      players.set(myId, { name: myName });
      for (const p of msg.players) players.set(p.id, { name: p.name });
      renderPlayerList(); updateHostUI();
      statusEl.textContent = `Room ${roomId} · ${players.size} player(s)`;
      break;
    case 'player-joined':
      players.set(msg.id, { name: msg.name });
      leaderId = msg.leaderId;
      renderPlayerList(); updateHostUI();
      statusEl.textContent = `${msg.name} joined.`;
      break;
    case 'player-left':
      players.delete(msg.id);
      renderPlayerList(); updateHostUI();
      break;
    case 'mygame-go':
      gamePhase = 'playing';
      updateHostUI();
      // initialize and render game state
      break;
    case 'mygame-move':
      // apply opponent move
      break;
    case 'mygame-winner':
      gamePhase = 'ended';
      statusEl.textContent = msg.winnerId === myId ? 'You win!' : `${msg.winnerName} wins!`;
      if (msg.winnerId === myId) reportScore('mygame', 1);
      break;
    case 'mygame-opponent-left':
      statusEl.textContent = 'Opponent disconnected.';
      gamePhase = 'ended';
      break;
    case 'error':
      alert(msg.msg);
      location.href = '/';
      break;
  }
}

connect();
})();
```

### Solo Game Pattern (no WebSocket room needed)

For solo games like `ballescape`:
1. In `lobby.html`, add `data-solo="true"` to the game-pick-card
2. Lobby.js handles `data-solo="true"` by navigating directly without creating a room
3. Game page does NOT use WebSocket — uses localStorage for persistence, `reportScore()` for leaderboard
4. No `?room=` URL param needed

---

## 7. EXISTING GAMES — CATALOGUE

### maze
- **Files:** `public/maze.html/css/js`
- **Players:** 2–8
- **Mode:** Race — all players solve the same or individual mazes
- **State shape:** `room.race = { mode, size, speed, seed, algo, started, finished: Map(), startedAt }`
- **Key events:** `start-race`, `race-started`, `finish`, `race-results`
- **Notes:** Uses seeded RNG (`mulberry32`). `mode='same'` sends one seed to all; `mode='individual'` each gets own. Score submitted as elapsed seconds (lower is better — in `LOWER_IS_BETTER`). No lock on join-while-playing (late joiners spectate).

### tetris
- **Files:** `public/tetris.html/css/js`
- **Players:** 2–8
- **Mode:** Battle — players send garbage lines to others; last standing wins
- **State shape:** `room.battle = { started, eliminated: Set(), startedAt }`
- **Key events:** `start-battle`, `battle-start`, `battle-end`, `game-over` (player elimination)
- **Notes:** `case 'game-over'` in the shared switch handles Tetris elimination — only game using this generic event. Has skin system (`/api/skins`).

### tictactoe
- **Files:** `public/tictactoe.html/css/js`
- **Players:** 2 (fixed)
- **Mode:** 1v1 turn-based
- **State shape:** `room.ttt = { board[9], xHistory[], oHistory[], currentTurn, xPlayer, oPlayer, active }`
- **Key events:** `ttt-new`, `ttt-start`, `ttt-move`, `ttt-win`
- **Notes:** Vanishing variant — each player can have at most 3 pieces on board (oldest removed). Server validates all moves. Alternates who goes first each round (`room.tttRound`).

### bluffrummy (br)
- **Files:** `public/bluffrummy.html/css/js`
- **Players:** 2–4
- **Mode:** Multiplayer card game
- **State shape:** `room.br = { active, hands: Map(), turnOrder[], turnIdx, deck[], discardPile[], paused, disconnects: Map() }`
- **Key events:** `br-*` prefix (many events)
- **Notes:** Supports reconnect within a window. Disconnect handling includes vote-to-redistribute logic. Most complex game in codebase.

### rami
- **Files:** `public/rami.html/css/js`
- **Players:** 1–4 (tester-only — not shown in standard lobby)
- **Mode:** Tunisian Rami card game, supports AI players
- **State shape:** `room.rami = { active, roundActive, hands: Map(), ... }`
- **Notes:** Hidden from non-tester users. Added dynamically to lobby by `checkTesterAndUnlock()`.

### pool
- **Files:** `public/pool.html/css/js`
- **Players:** 2 (fixed, like tictactoe)
- **Mode:** 1v1 physics billiards
- **Notes:** Uses generic `state` relay for physics position updates rather than game-specific events.

### battleship
- **Files:** `public/battleship.html/css/js`
- **Players:** 2 (fixed)
- **Mode:** 1v1 sea battle
- **Notes:** Standard battleship rules.

### egame
- **Files:** `public/egame.html/css/js`
- **Players:** 2 (fixed)
- **Mode:** Custom 1v1 game
- **Notes:** Uses `room.eg` state.

### snakesladders (sl)
- **Files:** `public/snakesladders.html/css/js`
- **Players:** 2–4
- **Mode:** Board game with special tile events
- **State shape:** `room.sl = { active, playerOrder[], turnIdx, positions{}, shields{}, pendingTimer, pendingTwist }`
- **Key events:** `sl-*` prefix
- **Notes:** Rooms locked while playing (no late joins). Has twist events with vote timers.

### uno
- **Files:** `public/uno.html/css/js`
- **Players:** 2–6
- **Mode:** Standard UNO card game
- **State shape:** `room.uno = { active, hands: Map(), turnOrder[], turnIdx, deck[], discardPile[], disconnects: Map() }`
- **Key events:** `uno-*` prefix
- **Notes:** Supports reconnect by same name.

### tanks
- **Files:** `public/tanks.html/css/js`
- **Players:** 2–4
- **Mode:** Turn-based tank battle on grid
- **State shape:** `room.tanks = { active, tankState{}, turnOrder[], turnIdx, turnTimer }`
- **Notes:** Turn timer auto-advances if player doesn't move.

### bomberman (bm)
- **Files:** `public/bomberman.html/css/js`
- **Players:** 2–4
- **Mode:** Real-time multiplayer Bomberman
- **State shape:** `room.bomberman = { active, players{}, grid[][], bombs[], roundActive, tickInterval, roundWins{} }`
- **Key events:** `bm-*` prefix, server tick at 20Hz (`setInterval(..., 50)`)
- **Notes:** The only game using server-side game loop (`tickInterval`). State broadcast every tick. Most performance-sensitive.

### minesweeper (ms)
- **Files:** `public/minesweeper.html/css/js`
- **Players:** 2–4
- **Mode:** Competitive — same board, race to reveal safe cells and score points
- **State shape:** `room.minesweeper = { active, board[][], players{}, size, totalSafe, revealedCount, timer }`
- **Key events:** `ms-*` prefix
- **Notes:** Has powerup system (reveal, magnet, shield, scanner, frenzy, trap). Rooms locked while playing.

### barricade (bar2)
- **Files:** `public/barricade.html/css/js`
- **Players:** 2 (fixed)
- **Mode:** 1v1 Quoridor-style wall-placing pathfinding game
- **State shape:** `room.barricade = { active, players[2], walls[], turnOrder[], turnIdx }`
- **Key events:** `bar2-start`, `bar2-move`, `bar2-wall`, `bar2-gameover`
- **Notes:** Disconnect = immediate forfeit (no reconnect). Server validates all moves using pathfinding.

### td (Tower Defense)
- **Files:** `public/td.html/css/js`
- **Players:** 2–4
- **Mode:** Competitive tower defense — each player defends own lane, sends enemies to others
- **State shape:** `room.td = { active, order[], lanes{}, wave, tickInterval, tdConfig }`
- **Key events:** `td-*` prefix, server tick every 100ms
- **Notes:** Second game with server game loop. Complex — has 6 enemy types, multiple tower types with 3-level upgrades + modifiers, auto-send system. `tdConfig` sent to joiners for host-picked mode/map sync.

### ballescape
- **Files:** `public/ballescape.html/css/js`
- **Players:** Solo only (no WebSocket room)
- **Mode:** Idle/action ball game, infinite procedural levels
- **Notes:** `data-solo="true"` in lobby. No WS. localStorage save key: `ballEscape_save`. Uses `mulberry32` seeded RNG. Scores personal best to leaderboard. Very large JS file.

### sudoku
- **Files:** `public/sudoku.html/css/js`
- **Players:** 2–6
- **Mode:** Competitive — same puzzle (seeded), first to complete wins
- **State shape:** `room.sudoku = { seed, difficulty, started, active, winner, startedAt }`
- **Key events:** `sudoku-start`, `sudoku-countdown`, `sudoku-go`, `sudoku-progress`, `sudoku-complete`, `sudoku-winner`, `sudoku-player-left`
- **Notes:** Puzzle generated client-side from seed — no puzzle data sent over wire. Server sends only seed + difficulty. Uses same `mulberry32` RNG as maze. Good reference for new 2–6 player competitive games.

---

## 8. STYLING & UI CONVENTIONS

### CSS Approach
- Plain CSS per game (no modules, no Tailwind, no CSS-in-JS)
- Each `.css` file is self-contained but copies the same CSS variable block
- CSS variables defined on `:root` — same values in every file

### Design Tokens (CSS Variables)
```css
:root {
  --bg:       #0a0a1a;   /* page background — very dark navy */
  --bg-card:  #12122a;   /* card/panel background */
  --accent:   #7c3aed;   /* primary purple */
  --accent-g: #a78bfa;   /* purple gradient end / lighter purple */
  --accent2:  #06b6d4;   /* cyan / teal */
  --accent2-g:#67e8f9;   /* cyan gradient end */
  --text:     #e2e8f0;   /* primary text */
  --text-dim: #94a3b8;   /* secondary text / labels */
  --danger:   #ef4444;   /* error / danger red */
}
```

### Typography
| Usage | Font | Weight | Size |
|---|---|---|---|
| Logo / game title | Orbitron | 900 | 2.8rem (lobby), 1.6rem (game header) |
| Buttons | Orbitron | 700 | 0.78rem, uppercase, letter-spacing 1.5px |
| Body text | Inter | 400 | 0.85–0.95rem |
| Labels / dim text | Inter | 300 | 0.8rem |
| Headings in panels | Inter | 600 | 1–1.2rem |

### Standard Button Classes
```css
.btn            /* base: Orbitron, 0.78rem, 0.55rem/1.4rem padding, border-radius 10px */
.btn-primary    /* purple gradient: accent → #5b21b6, box-shadow glow */
.btn-accent     /* cyan gradient: accent2 → #0891b2 */
.btn-join-room  /* green gradient: #34d399 → #059669 */
.btn-sm         /* smaller: 0.72rem, 0.4rem/1rem padding */
.btn-back       /* subtle: rgba white background, text-dim color */
.btn-rules      /* same as btn-back */
.btn-lg         /* larger: 0.9rem, 0.7rem/2rem padding */
```

### Layout Pattern (game pages)
```
.layout {
  display: grid;
  grid-template-columns: 220px 1fr 220px; /* sidebar | main | right-rail (optional) */
  height: 100vh;
}
.sidebar          /* left panel: player list */
.main-content     /* center: header + game area */
.right-rail       /* optional right panel (TD, Bomberman) */
```

### Game Header Pattern
```html
<header class="game-header">
  <button class="btn btn-sm btn-back" id="btnBack">← Lobby</button>
  <button class="btn btn-mobile-toggle" id="btnToggleSidebar">👥</button>
  <h1 class="logo logo-sm">GAME TITLE</h1>
  <span class="room-badge" id="roomBadge"></span>
  <button class="btn btn-sm btn-rules" id="btnRules">📜 Rules</button>
</header>
```

### Background Decoration
Every page has this ambient background animation:
```css
body::before {
  content: '';
  position: fixed;
  inset: -50%;
  width: 200%; height: 200%;
  background:
    radial-gradient(ellipse at 30% 20%, rgba(124,58,237,.07) 0%, transparent 50%),
    radial-gradient(ellipse at 70% 80%, rgba(6,182,212,.05) 0%, transparent 50%);
  animation: bgShift 20s ease-in-out infinite alternate;
  z-index: -1;
}
@keyframes bgShift { to { transform: translate(3%, 3%) rotate(3deg); } }
```

### Player List (sidebar)
```html
<aside class="sidebar" id="sidebar">
  <div class="sidebar-header">
    <h3>Players</h3>
    <span class="player-count" id="playerCount">0</span>
  </div>
  <div class="player-grid" id="playerList"></div>
</aside>
```

### Overlays / Modals
Result cards are absolutely positioned overlays:
```css
.overlay { position:fixed; inset:0; display:flex; align-items:center; justify-content:center; background:rgba(0,0,0,.7); z-index:100; }
.result-card { background:var(--bg-card); border-radius:20px; padding:2.5rem; text-align:center; }
```

### Seeded RNG (shared pattern across games)
`mulberry32` — used in maze, sudoku, bomberman, ballescape:
```js
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}
```

### Confetti Animation
Used in Sudoku (canvas-based). Can be copied from `sudoku.js`.

### Mobile / Responsive
- Sidebar toggle buttons (`.btn-mobile-toggle`) with id `btnToggleSidebar` / `btnToggleRail`
- `user-scalable=no` in viewport meta to prevent accidental zoom on canvas games
- Media queries in CSS adjust layout for narrow screens

---

## 9. LEADERBOARD & USER SYSTEM

### User Identity
- Firebase Authentication — Google Sign-In or email/password
- UID from Firebase token (`decoded.uid`)
- Display name from `decoded.name` or email prefix
- No anonymous auth — must be signed in to submit scores (games still playable without it)

### Score Submission
```js
// Client-side (in every game page HTML):
async function postScore(game, score) {
  try {
    const token = sessionStorage.getItem('arena-token') || (fbAuth.currentUser ? await fbAuth.currentUser.getIdToken() : null);
    if (!token) return;
    await fetch('/api/score', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
      body: JSON.stringify({ game, score })
    });
  } catch {}
}
```

### Score Storage Modes
| Mode | Games | Behavior |
|---|---|---|
| Personal best (higher) | tetris, minesweeper, ballescape, sudoku | Only updates if new score > stored |
| Personal best (lower) | maze | Only updates if new score < stored (`LOWER_IS_BETTER`) |
| Win increment | tictactoe, bluffrummy, rami, pool, battleship, egame, snakesladders, uno, tanks, bomberman, barricade, td, sudoku | `FieldValue.increment(1)` on each win — scores accumulate |

### Firestore Schema
```
leaderboard/{uid}_{game}:
  uid: string
  displayName: string
  game: string
  score: number
  updatedAt: Timestamp

user_prefs/{uid}:
  equippedSkin: string    (tetris only)
  tester: boolean         (unlocks rami game)
```

### Leaderboard Query
```js
db.collection('leaderboard')
  .where('game', '==', game)
  .orderBy('score', LOWER_IS_BETTER.has(game) ? 'asc' : 'desc')
  .limit(20)
  .get()
```

---

## 10. KNOWN PATTERNS, GOTCHAS & DECISIONS

### Architecture Decisions

**1. Monolithic `server.js`**
All game logic is in one ~6800-line file. No separate game modules or files. Intentional simplicity — avoids module system complexity for a no-build project. Side effect: file is hard to navigate; use code search.

**2. No build step**
Plain `<script src="...">` tags, no ESM imports, no bundler. CDN libs loaded in each HTML file's `<head>`. New games should follow this pattern — don't introduce npm packages for frontend code.

**3. Client-side puzzle/game generation from seed**
Sudoku, maze, and others send only a seed from server. Both clients run identical deterministic generation. Avoids serializing large game state. Requires both clients to use the exact same algorithm — if you change generation logic, old seeds become invalid.

**4. LeaderId = first player to join**
Server: `leaderId = room.players.keys().next().value`. Host privileges (start game, set config) are assigned to this player. If host leaves, no automatic re-assignment — the second player must handle the "host left" case in their game.

**5. Firebase token on every WebSocket connection**
Game pages open a fresh WebSocket (not reusing lobby's WS). Token must be sent in `join-room`. Token can be stale — `sudoku.js` shows the pattern of falling back to `fbAuth.currentUser.getIdToken()`.

**6. No server-side game logic for most games**
Most games (Sudoku, Pool, Maze) trust the client to self-report completion. Only a few games (Tanks, Barricade, Tictactoe, Bomberman, TD, Minesweeper) have server-side move validation. This is a known trade-off for development speed.

**7. Chat is generic**
`{ type: 'chat', text: '...' }` → server broadcasts to room. Any game gets chat for free if frontend wires it up.

### Known Gotchas

**Lobby icon ternary**
In `lobby.js`, `renderRooms()` has a long ternary chain for room type icons. When adding a game, you must add your icon before the final `: '\u{1F3C1}'` fallback (which is maze). Forgetting this makes your rooms show the maze flag icon.

**`data-solo="true"` pattern**
Solo games (ballescape) use `data-solo="true"` on their game-pick-card. Lobby.js checks this and navigates directly to `/{game}` without creating a room. The game page must not expect a `?room=` query param.

**`sudoku` is in both `VALID_GAMES` and `WIN_INCREMENT_GAMES`**
This means wins are tracked, not time. Despite the puzzle being time-based internally.

**Room password is in sessionStorage**
`arena-room-password` is set before navigation and cleared in the game page's `ws.onopen`. If the user refreshes, password is gone and they'll get "Wrong password" on reconnect. This is by design for security but can confuse users.

**`removeFromRoom` must handle `room.players.size === 0` before accessing game state**
After `room.players.delete(id)`, the player count is already decremented. Game-specific cleanup blocks check `room.players.size === 0` to decide whether to null out the game state entirely.

**Barricade disconnect = forfeit**
Unlike most games, `barricade` disconnect immediately ends the game in favor of the remaining player. No grace period, no reconnect.

**Server validates Barricade moves with pathfinding**
`bar2-move` and `bar2-wall` are validated server-side including full pathfinding checks (BFS). This is unusual — most games trust the client.

**Bomberman uses `setInterval` at 50ms (20Hz)**
If the server is overloaded, tick intervals pile up. `tickInterval` is stored on `room.bomberman` and must be cleared in `removeFromRoom` when the last player leaves.

**Tower Defense config sync**
When a player joins a TD room mid-lobby (before game starts), the server sends a `td-config` message with the host's current mode/map selection. New games that have lobby config should follow this pattern.

**`rami` is tester-only**
It's in `VALID_GAMES` but not shown in lobby unless user has `tester: true` in Firestore. The game-pick-card and leaderboard tab are added dynamically in `checkTesterAndUnlock()`.

### Files to Never Modify Without Full Understanding
- `firebase-init.js` — shared by all 18+ pages. A typo breaks all auth.
- `firestore.rules` — controls data access. Mistakes allow data leaks or denial of service.
- `service-account.json` — Firebase private key. Never commit to git; in production use env var.
- The `VALID_GAMES` set in `server.js` — used for score API validation. Missing a game means scores can't be saved for it.

### Performance Considerations
- Bomberman and TD use server-side game loops. If many rooms run simultaneously, CPU usage scales linearly. No worker threads.
- `broadcastRoom` serializes the message to JSON once per player (inefficient — should pre-serialize). For large rooms this is measurable.
- No compression on WebSocket messages.
- Firestore reads on every score save — not batched. Fine for current scale.

---

## QUICK REFERENCE

**10 most commonly needed facts:**

1. **Add a game:** 9 locations to touch — `VALID_GAMES`, `WIN_INCREMENT_GAMES`, `ROUTES`, `create-room type ternary`, `create-room max ternary`, `join-room lock`, `removeFromRoom cleanup`, `hasActiveGame`, `message switch cases`; plus 3 lobby files, 3 public files.

2. **WS message format:** `{ type: 'kebab-case-event', ...flatFields }` — no nested payload object.

3. **Send to one client:** `send(ws, msg)` or `send(room.players.get(id).ws, msg)`

4. **Broadcast to room:** `broadcastRoom(roomId, msg)` or `broadcastRoom(roomId, msg, excludeId)`

5. **Broadcast to lobby:** `broadcastLobby()` — call after any room status change.

6. **Host detection (server):** `room.players.keys().next().value === id`

7. **Host detection (client):** `leaderId === myId`

8. **Key session storage:** `arena-token`, `arena-name`, `arena-room-password`

9. **Design tokens:** `--bg:#0a0a1a`, `--bg-card:#12122a`, `--accent:#7c3aed`, `--accent2:#06b6d4`, `--text:#e2e8f0`

10. **Fonts:** `'Orbitron'` for logos/buttons, `'Inter'` for body — both from Google Fonts, loaded in every page `<head>`

11. **Room code:** 5-char alphanumeric, no ambiguous chars (no O, I, 0, 1) — `genRoomId()`

12. **Score API:** `POST /api/score` with `{ game, score }` body + `Authorization: Bearer {token}` header

13. **Seeded RNG:** `mulberry32(seed)` — returns closure. Same implementation in maze/sudoku/bomberman/ballescape.

14. **Game state on server:** stored directly on room object as `room.{prefix}` (e.g. `room.sudoku`, `room.br`). Always check `room.{prefix}?.active` before handling messages.

15. **Firestore:** collection `leaderboard`, doc `{uid}_{game}`. Collection `user_prefs`, doc `{uid}`.

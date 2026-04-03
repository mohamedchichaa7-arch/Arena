/* ═══════════════════════════════════════════════════════════════════
   TETRIS BATTLE — Arena Room Client  |  tetris.js
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  // ── URL / session ────────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  const myName = sessionStorage.getItem('arena-name') || 'Player';
  if (!roomId) { location.href = '/'; return; }

  // ── Constants ────────────────────────────────────────────────────
  const ROWS = 20, COLS = 10;
  const COLORS = ['', '#06b6d4', '#eab308', '#a855f7', '#22c55e', '#ef4444', '#3b82f6', '#f97316', '#94a3b8'];
  const GLOW   = ['', '#67e8f9', '#fde047', '#c084fc', '#4ade80', '#f87171', '#60a5fa', '#fb923c', '#cbd5e1'];

  // ── Skins ────────────────────────────────────────────────────────────────────
  // Tetris Guideline bright colors used by the Sprites skin
  const SPRITE_COLORS = ['', '#00f0f0', '#f0f000', '#a000f0', '#00e040', '#f00000', '#0050f0', '#f09000', '#888888'];

  const SKINS = {
    sprites:   { name: 'Sprites',   icon: '🖼️',  unlockScore: 0,      style: 'sprite',
      colors: SPRITE_COLORS },
    classic:   { name: 'Classic',   icon: '🎮',  unlockScore: 0,      style: 'solid',
      colors: ['', '#06b6d4', '#eab308', '#a855f7', '#22c55e', '#ef4444', '#3b82f6', '#f97316', '#94a3b8'] },
    pixel:     { name: 'Pixel',     icon: '🕹️',  unlockScore: 500,    style: 'pixel',
      colors: ['', '#14e8ff', '#ffe714', '#e714c8', '#14e840', '#e81414', '#1490e8', '#e87814', '#888888'] },
    neon:      { name: 'Neon',      icon: '⚡',   unlockScore: 2000,   style: 'glow',
      colors: ['', '#00ffff', '#ffff00', '#ff00ff', '#00ff88', '#ff3366', '#66aaff', '#ff8800', '#aaaaaa'] },
    candy:     { name: 'Candy',     icon: '🍬',  unlockScore: 3500,   style: 'candy',
      colors: ['', '#ff79b0', '#ffee58', '#ce93d8', '#80cbc4', '#ef9a9a', '#64b5f6', '#ffb74d', '#e0e0e0'] },
    glass:     { name: 'Glass',     icon: '🔮',  unlockScore: 6000,   style: 'glass',
      colors: ['', '#00d4ff', '#ffe600', '#bb00ff', '#00e676', '#ff1744', '#2979ff', '#ff9100', '#9e9e9e'] },
    pastel:    { name: 'Pastel',    icon: '🌸',  unlockScore: 8000,   style: 'soft',
      colors: ['', '#7ec8e3', '#ffe0a3', '#c3aed6', '#a8e6cf', '#ffb3b3', '#a3c4f3', '#ffd6a0', '#d4d4d4'] },
    metal:     { name: 'Metal',     icon: '⚙️',  unlockScore: 12000,  style: 'metal',
      colors: ['', '#80c8d8', '#d8c880', '#b880d8', '#80d898', '#d88080', '#8098d8', '#d8a880', '#a8a8a8'] },
    retro:     { name: 'Retro',     icon: '👾',  unlockScore: 18000,  style: 'flat',
      colors: ['', '#55cc22', '#ccaa00', '#aa33cc', '#22cc55', '#cc2233', '#2233cc', '#cc6600', '#888888'] },
    wireframe: { name: 'Wireframe', icon: '📐',  unlockScore: 25000,  style: 'wireframe',
      colors: ['', '#00f0f0', '#f0f000', '#c000f0', '#00e040', '#f00000', '#0050f0', '#f09000', '#888888'] },
    galaxy:    { name: 'Galaxy',    icon: '🌌',  unlockScore: 38000,  style: 'gradient',
      colors: ['', '#818cf8', '#c084fc', '#f472b6', '#34d399', '#fb7185', '#60a5fa', '#fb923c', '#94a3b8'] },
    diamond:   { name: 'Diamond',   icon: '💎',  unlockScore: 55000,  style: 'diamond',
      colors: ['', '#00e5ff', '#ffd600', '#e040fb', '#00e676', '#ff1744', '#448aff', '#ff9100', '#bdbdbd'] },
    fire:      { name: 'Fire',      icon: '🔥',  unlockScore: 80000,  style: 'glow',
      colors: ['', '#fbbf24', '#f97316', '#ef4444', '#fcd34d', '#b91c1c', '#fb923c', '#dc2626', '#6b6b6b'] },
    hologram:  { name: 'Hologram',  icon: '💠',  unlockScore: 110000, style: 'hologram',
      colors: ['', '#00fff0', '#f0ff00', '#ff00f0', '#00ff80', '#ff4000', '#00aaff', '#ffaa00', '#aaaaaa'] },
    lava:      { name: 'Lava',      icon: '🌋',  unlockScore: 140000, style: 'lava',
      colors: ['', '#ff8f00', '#ffab00', '#ff6d00', '#ffca28', '#d32f2f', '#e65100', '#bf360c', '#5d4037'] },
    ice:       { name: 'Ice',       icon: '❄️',  unlockScore: 175000, style: 'soft',
      colors: ['', '#bae6fd', '#e0f2fe', '#c7d2fe', '#ccfbf1', '#dbeafe', '#a5f3fc', '#e0f7fa', '#f1f5f9'] },
    matrix:    { name: 'Matrix',    icon: '🟩',  unlockScore: 250000, style: 'matrix',
      colors: ['', '#00ff41', '#00cc33', '#33ff66', '#00ff41', '#00ff41', '#00ff41', '#33ff11', '#003300'] },
  };

  let activeSkinColors = SPRITE_COLORS.slice();
  let activeSkinStyle  = 'sprite';
  let equippedSkinId   = 'sprites';
  let unlockedSkins    = ['sprites', 'classic', 'pixel'];
  const TYPES = ['I', 'O', 'T', 'S', 'Z', 'J', 'L'];
  const SHAPES = { I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]], O: [[1, 1], [1, 1]], T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]], S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]], Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]], J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]], L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]] };
  const COLOR_IDX = { I: 1, O: 2, T: 3, S: 4, Z: 5, J: 6, L: 7 };
  const LINE_SCORES = [0, 100, 300, 500, 800];
  const SPAWN_X = { I: 3, O: 4, T: 3, S: 3, Z: 3, J: 3, L: 3 };
  const SPAWN_Y = { I: -1, O: 0, T: 0, S: 0, Z: 0, J: 0, L: 0 };

  // Rotations
  const ROTATIONS = {};
  function rotMat(m) { const N = m.length, r = []; for (let i = 0; i < N; i++) { r[i] = []; for (let j = 0; j < N; j++)r[i][j] = m[N - 1 - j][i]; } return r; }
  for (const t of TYPES) { ROTATIONS[t] = [SHAPES[t]]; for (let i = 1; i < 4; i++)ROTATIONS[t][i] = rotMat(ROTATIONS[t][i - 1]); }

  const AI_PROFILES = { easy: { actionDelay: 450, errorRate: .25 }, medium: { actionDelay: 180, errorRate: .08 }, hard: { actionDelay: 70, errorRate: .01 }, godlike: { actionDelay: 22, errorRate: 0 } };

  // ── DOM refs ─────────────────────────────────────────────────────
  const $ = s => document.getElementById(s);
  const btnStart = $('btnStart'), btnBattle = $('btnBattle'), btnVsAI = $('btnVsAI'), aiDiffSelect = $('aiDifficulty');
  const statusEl = $('status'), playerListEl = $('playerList'), playerCountEl = $('playerCount');
  const panelScore = $('panelScore'), panelLevel = $('panelLevel'), panelLines = $('panelLines'), panelGarbage = $('panelGarbage');
  const boardCanvas = $('boardCanvas'), bctx = boardCanvas.getContext('2d');
  const holdCanvas = $('holdCanvas'), hctx = holdCanvas.getContext('2d');
  const nextCanvas = $('nextCanvas'), nctx = nextCanvas.getContext('2d');
  const countdownOvl = $('countdownOverlay'), countdownText = $('countdownText');
  const gameOverOvl = $('gameOverOverlay'), goTitle = $('goTitle'), goScore = $('goScore'), goLines = $('goLines'), goLevel = $('goLevel');
  const btnRestart = $('btnRestart'), confettiCvs = $('confetti'), cctx = confettiCvs.getContext('2d');
  const roomBadge = $('roomBadge'), btnBack = $('btnBack');
  const chatMessages = $('chatMessages'), chatInput = $('chatInput'), chatSend = $('chatSend');
  const modeSelect = $('modeSelect');
  const timerBox = $('timerBox'), panelTimer = $('panelTimer'), timerLabel = $('timerLabel');
  const goLevelLabel = $('goLevelLabel');

  roomBadge.textContent = 'Room ' + roomId;

  // ══════════════════════════════════════════════════════════════════
  //  TETRIS ENGINE
  // ══════════════════════════════════════════════════════════════════
  class TetrisEngine {
    constructor() { this.reset(); }
    reset() { this.board = Array.from({ length: ROWS }, () => Array(COLS).fill(0)); this.piece = null; this.holdType = null; this.holdUsed = false; this.bag = []; this.score = 0; this.level = 1; this.lines = 0; this.combo = -1; this.state = 'idle'; this.dropCounter = 0; this.lockCounter = 0; this.lockResets = 0; this.maxLockResets = 15; this.lockLimit = 500; this.clearingRows = []; this.clearTimer = 0; this.pendingGarbage = 0; this.garbageSent = 0; this.lockedPiece = null; this.clearingStarted = false; this.lastClearInfo = null; }
    start() { this.reset(); this.state = 'playing'; this.spawnPiece(); }
    fillBag() { const b = [...TYPES]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[b[i], b[j]] = [b[j], b[i]]; } this.bag.push(...b); }
    nextType() { if (this.bag.length < 7) this.fillBag(); return this.bag.shift(); }
    peekNext(n) { while (this.bag.length < n + 7) this.fillBag(); return this.bag.slice(0, n); }
    spawnPiece() { const type = this.nextType(); this.piece = { type, colorIdx: COLOR_IDX[type], rotation: 0, shape: ROTATIONS[type][0], x: SPAWN_X[type], y: SPAWN_Y[type] }; this.lockCounter = 0; this.lockResets = 0; this.dropCounter = 0; this.holdUsed = false; if (this.collides(this.piece.shape, this.piece.x, this.piece.y)) this.state = 'gameover'; }
    collides(shape, ox, oy) { for (let r = 0; r < shape.length; r++)for (let c = 0; c < shape[r].length; c++) { if (!shape[r][c]) continue; const br = oy + r, bc = ox + c; if (bc < 0 || bc >= COLS || br >= ROWS) return true; if (br >= 0 && this.board[br][bc]) return true; } return false; }
    moveLeft() { if (!this.piece || this.state !== 'playing') return false; if (!this.collides(this.piece.shape, this.piece.x - 1, this.piece.y)) { this.piece.x--; this._tryResetLock(); return true; } return false; }
    moveRight() { if (!this.piece || this.state !== 'playing') return false; if (!this.collides(this.piece.shape, this.piece.x + 1, this.piece.y)) { this.piece.x++; this._tryResetLock(); return true; } return false; }
    moveDown() { if (!this.piece || this.state !== 'playing') return false; if (!this.collides(this.piece.shape, this.piece.x, this.piece.y + 1)) { this.piece.y++; return true; } return false; }
    softDrop() { if (this.moveDown()) { this.score += 1; return true; } return false; }
    hardDrop() { if (!this.piece || this.state !== 'playing') return 0; let d = 0; while (!this.collides(this.piece.shape, this.piece.x, this.piece.y + 1)) { this.piece.y++; d++; } this.score += d * 2; return this.lock(); }
    rotate(dir) { if (!this.piece || this.state !== 'playing') return false; const nr = (this.piece.rotation + dir + 4) % 4; const ns = ROTATIONS[this.piece.type][nr]; const kicks = this.piece.type === 'I' ? [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2], [2, 0], [-1, 0], [2, 1], [-1, -2]] : [[0, 0], [-1, 0], [1, 0], [0, -1], [-1, -1], [1, -1], [0, 1], [-1, 1], [1, 1]]; for (const [dx, dy] of kicks) if (!this.collides(ns, this.piece.x + dx, this.piece.y + dy)) { this.piece.x += dx; this.piece.y += dy; this.piece.rotation = nr; this.piece.shape = ns; this._tryResetLock(); return true; } return false; }
    doHold() { if (!this.piece || this.holdUsed || this.state !== 'playing') return; const t = this.piece.type; if (this.holdType) { const s = this.holdType; this.holdType = t; this.piece = { type: s, colorIdx: COLOR_IDX[s], rotation: 0, shape: ROTATIONS[s][0], x: SPAWN_X[s], y: SPAWN_Y[s] }; } else { this.holdType = t; this.spawnPiece(); } this.holdUsed = true; this.lockCounter = 0; this.lockResets = 0; }
    _tryResetLock() { if (!this.piece) return; if (this.collides(this.piece.shape, this.piece.x, this.piece.y + 1)) { if (this.lockResets < this.maxLockResets) { this.lockCounter = 0; this.lockResets++; } } }
    ghostY() { if (!this.piece) return 0; let gy = this.piece.y; while (!this.collides(this.piece.shape, this.piece.x, gy + 1)) gy++; return gy; }
    lock() { if (!this.piece) return 0; const { shape, x, y, colorIdx } = this.piece; this.lockedPiece = { shape: shape.map(r => [...r]), x, y, colorIdx }; for (let r = 0; r < shape.length; r++)for (let c = 0; c < shape[r].length; c++) { if (!shape[r][c]) continue; const br = y + r, bc = x + c; if (br < 0) { this.state = 'gameover'; return 0; } this.board[br][bc] = colorIdx; } this.piece = null; const full = []; for (let r = 0; r < ROWS; r++)if (this.board[r].every(c => c !== 0)) full.push(r); if (full.length > 0) { this.clearingRows = full; this.clearTimer = 0; this.state = 'clearing'; this.clearingStarted = true; return 0; } this.combo = -1; this.applyGarbage(); this.spawnPiece(); return 0; }
    finishClear() { const count = this.clearingRows.length; const sorted = [...this.clearingRows].sort((a, b) => b - a); for (const r of sorted) { this.board.splice(r, 1); } for (let i = 0; i < count; i++) { this.board.unshift(Array(COLS).fill(0)); } this.lines += count; this.combo++; const lvl = Math.floor(this.lines / 10) + 1; const leveledUp = lvl > this.level; if (leveledUp) this.level = lvl; const scoreBefore = this.score; this.score += (LINE_SCORES[count] || 0) * this.level; if (this.combo > 0) this.score += 50 * this.combo * this.level; this.lastClearInfo = { count, rows: [...sorted], combo: this.combo, scoreGain: this.score - scoreBefore, leveledUp }; this.clearingRows = []; this.state = 'playing'; let garbage = 0; if (count === 2) garbage = 1; else if (count === 3) garbage = 2; else if (count >= 4) garbage = 4; garbage += Math.max(0, this.combo - 1); const cancel = Math.min(garbage, this.pendingGarbage); this.pendingGarbage -= cancel; garbage -= cancel; this.applyGarbage(); this.spawnPiece(); this.garbageSent = garbage; return garbage; }
    applyGarbage() { if (this.pendingGarbage <= 0) return; const lines = Math.min(this.pendingGarbage, ROWS - 4); this.pendingGarbage -= lines; for (let i = 0; i < lines; i++) { this.board.shift(); const row = Array(COLS).fill(8); row[Math.floor(Math.random() * COLS)] = 0; this.board.push(row); } }
    addGarbage(n) { this.pendingGarbage += n; }
    getDropInterval() { return Math.max(40, 1000 - (this.level - 1) * 80); }
    update(delta) { if (this.state === 'clearing') { this.clearTimer += delta; if (this.clearTimer >= 250) return this.finishClear(); return 0; } if (this.state !== 'playing' || !this.piece) return 0; this.dropCounter += delta; if (this.dropCounter >= this.getDropInterval()) { this.dropCounter = 0; this.moveDown(); } if (!this.collides(this.piece.shape, this.piece.x, this.piece.y + 1)) this.lockCounter = 0; else { this.lockCounter += delta; if (this.lockCounter >= this.lockLimit) return this.lock(); } return 0; }
    encodedBoard() { const f = new Array(ROWS * COLS); for (let r = 0; r < ROWS; r++)for (let c = 0; c < COLS; c++)f[r * COLS + c] = this.board[r][c]; return f; }
    getState() { return { board: this.encodedBoard(), score: this.score, level: this.level, lines: this.lines, state: this.state, piece: this.piece ? { type: this.piece.type, x: this.piece.x, y: this.piece.y, rot: this.piece.rotation } : null }; }
  }

  // ══════════════════════════════════════════════════════════════════
  //  AI CONTROLLER
  // ══════════════════════════════════════════════════════════════════
  class TetrisAI {
    constructor(engine, difficulty) { this.engine = engine; this.profile = AI_PROFILES[difficulty] || AI_PROFILES.medium; this.target = null; this.timer = 0; }
    update(delta) { const e = this.engine; if (e.state !== 'playing' || !e.piece || e.clearingRows.length) return; this.timer += delta; if (this.timer < this.profile.actionDelay) return; this.timer = 0; if (!this.target || this.target.type !== e.piece.type) { this.target = this.findBest(); if (!this.target) { e.hardDrop(); return; } } if (e.piece.rotation !== this.target.rot) e.rotate(1); else if (e.piece.x < this.target.x) e.moveRight(); else if (e.piece.x > this.target.x) e.moveLeft(); else { e.hardDrop(); this.target = null; } }
    findBest() { const e = this.engine, type = e.piece.type; let best = null, bestScore = -Infinity; const cands = []; for (let rot = 0; rot < 4; rot++) { const shape = ROTATIONS[type][rot]; for (let x = -2; x < COLS + 2; x++) { let y = SPAWN_Y[type]; if (e.collides(shape, x, y)) continue; while (!e.collides(shape, x, y + 1)) y++; const bc = e.board.map(r => [...r]); let valid = true; for (let r = 0; r < shape.length; r++)for (let c = 0; c < shape[r].length; c++) { if (!shape[r][c]) continue; const br = y + r, bx = x + c; if (br < 0 || br >= ROWS || bx < 0 || bx >= COLS) { valid = false; break; } bc[br][bx] = 1; } if (!valid) continue; const sc = this.evaluate(bc); cands.push({ rot, x, score: sc }); if (sc > bestScore) { bestScore = sc; best = { type, rot, x }; } } } if (this.profile.errorRate > 0 && Math.random() < this.profile.errorRate && cands.length > 1) { cands.sort((a, b) => b.score - a.score); const pick = cands[Math.floor(Math.random() * Math.min(5, cands.length))]; return { type, rot: pick.rot, x: pick.x }; } return best; }
    evaluate(board) { let score = 0; const heights = Array(COLS).fill(0); for (let c = 0; c < COLS; c++)for (let r = 0; r < ROWS; r++)if (board[r][c]) { heights[c] = ROWS - r; break; } score -= heights.reduce((a, b) => a + b, 0) * .51; let complete = 0; for (let r = 0; r < ROWS; r++)if (board[r].every(c => c !== 0)) complete++; score += complete * 7.6; let holes = 0; for (let c = 0; c < COLS; c++) { let found = false; for (let r = 0; r < ROWS; r++) { if (board[r][c]) found = true; else if (found) holes++; } } score -= holes * 3.5; let bumpy = 0; for (let c = 0; c < COLS - 1; c++)bumpy += Math.abs(heights[c] - heights[c + 1]); score -= bumpy * .18; return score; }
  }

  // ── Globals ──────────────────────────────────────────────────────
  let ws = null, myId = null;
  const others = new Map();
  let inBattle = false;
  const game = new TetrisEngine();
  let cellSize = 28, lastTime = 0, stateThrottle = null;
  const AI_ID = '__ai__';
  let aiActive = false, aiEngine = null, aiCtrl = null;
  const keys = {};
  let dasKey = null, dasTimer = null;
  const DAS_DELAY = 140, DAS_REPEAT = 30;

  // ── Game mode state ──────────────────────────────────────────────
  let currentMode = 'marathon';
  let modeTimer = 0, modeActive = false;
  let survivalAccum = 0, survivalGapMs = 9000, survivalWave = 0;

  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ── Canvas sizing ────────────────────────────────────────────────
  function sizeCanvases() {
    const maxH = window.innerHeight - 220, sidebar = 270, panels = 230;
    const maxW = Math.min(window.innerWidth - sidebar - panels - 60, 400);
    cellSize = Math.max(16, Math.min(Math.floor(maxH / ROWS), Math.floor(maxW / COLS)));
    const dpr = window.devicePixelRatio || 1;
    const lw = COLS * cellSize, lh = ROWS * cellSize;
    boardCanvas.width = lw * dpr; boardCanvas.height = lh * dpr;
    boardCanvas.style.width = lw + 'px'; boardCanvas.style.height = lh + 'px';
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ══════════════════════════════════════════════════════════════════
  //  RENDERING
  // ══════════════════════════════════════════════════════════════════

  function drawBoard() {
    const cs = cellSize, w = COLS * cs, h = ROWS * cs;
    bctx.clearRect(0, 0, w, h);
    const bg = bctx.createLinearGradient(0, 0, w, h); bg.addColorStop(0, '#0f0f2e'); bg.addColorStop(1, '#0a0a1a');
    bctx.fillStyle = bg; bctx.fillRect(0, 0, w, h);
    bctx.strokeStyle = 'rgba(124,58,237,0.06)'; bctx.lineWidth = 1;
    for (let r = 1; r < ROWS; r++) { bctx.beginPath(); bctx.moveTo(0, r * cs); bctx.lineTo(w, r * cs); bctx.stroke(); }
    for (let c = 1; c < COLS; c++) { bctx.beginPath(); bctx.moveTo(c * cs, 0); bctx.lineTo(c * cs, h); bctx.stroke(); }
    for (let r = 0; r < ROWS; r++)for (let c = 0; c < COLS; c++)if (game.board[r][c]) drawBlock(bctx, c * cs, r * cs, cs, game.board[r][c]);
    if (game.state === 'clearing') {
      const progress = game.clearTimer / 250;
      const flash = Math.sin(progress * Math.PI) * .75;
      const count = game.clearingRows.length;
      const fx = getSkinFx();
      const flashColor = fx.flashA(count, flash);
      bctx.fillStyle = flashColor;
      for (const row of game.clearingRows) bctx.fillRect(0, row * cs, w, cs);
      if (progress > .3) {
        for (const row of game.clearingRows) {
          const shimGrad = bctx.createLinearGradient(0, row * cs, w, row * cs);
          shimGrad.addColorStop(0, 'transparent');
          shimGrad.addColorStop((progress - .3) % 1, fx.shimmer);
          shimGrad.addColorStop(1, 'transparent');
          bctx.fillStyle = shimGrad; bctx.fillRect(0, row * cs, w, cs);
        }
      }
    }
    if (game.piece && game.state === 'playing') { const gy = game.ghostY(); drawPieceAt(bctx, game.piece.shape, game.piece.x, gy, cs, game.piece.colorIdx, .18); }
    if (game.piece && (game.state === 'playing' || game.state === 'clearing')) drawPieceAt(bctx, game.piece.shape, game.piece.x, game.piece.y, cs, game.piece.colorIdx, 1);
    if (game.pendingGarbage > 0) { const gH = Math.min(game.pendingGarbage, ROWS) * cs; const gg = bctx.createLinearGradient(0, h - gH, 0, h); gg.addColorStop(0, 'rgba(239,68,68,0.1)'); gg.addColorStop(1, 'rgba(239,68,68,0.5)'); bctx.fillStyle = gg; bctx.fillRect(0, h - gH, 4, gH); bctx.fillStyle = '#ef4444'; bctx.fillRect(0, h - gH, 3, gH); }
    bctx.strokeStyle = 'rgba(124,58,237,0.3)'; bctx.lineWidth = 2; bctx.strokeRect(0, 0, w, h);
  }

  function drawBlock(ctx, x, y, s, colorIdx) {
    const color = activeSkinColors[colorIdx] || activeSkinColors[1];
    const style = activeSkinStyle;
    if (style === 'sprite') {
      const sc = SPRITE_COLORS[colorIdx] || SPRITE_COLORS[1];
      const hl = Math.max(2, Math.floor(s * 0.30));  // top highlight height
      const sh = Math.max(2, Math.floor(s * 0.22));  // bottom shadow height
      const sw = Math.max(2, Math.floor(s * 0.18));  // side strip width
      // Dark outer border
      ctx.fillStyle = 'rgba(0,0,0,0.70)';
      ctx.fillRect(x, y, s, s);
      // Base color
      ctx.fillStyle = sc;
      ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      // Top highlight
      ctx.fillStyle = 'rgba(255,255,255,0.55)';
      ctx.fillRect(x + 2, y + 2, s - 4, hl);
      // Left highlight strip
      ctx.fillStyle = 'rgba(255,255,255,0.20)';
      ctx.fillRect(x + 2, y + 2 + hl, sw, s - 4 - hl);
      // Bottom shadow
      ctx.fillStyle = 'rgba(0,0,0,0.42)';
      ctx.fillRect(x + 2, y + s - sh - 1, s - 4, sh);
      // Right shadow strip
      ctx.fillStyle = 'rgba(0,0,0,0.20)';
      ctx.fillRect(x + s - sw - 1, y + 2, sw, s - sh - 4);
      // Inner shine spot (top-left)
      ctx.fillStyle = 'rgba(255,255,255,0.80)';
      ctx.fillRect(x + 3, y + 3, Math.max(2, Math.floor(s * 0.28)), Math.max(1, Math.floor(s * 0.12)));
      return;
    }
    if (style === 'pixel') {
      // Classic NES-Tetris 3-D bevel
      const bv = Math.max(2, Math.floor(s * 0.22));
      ctx.fillStyle = color; ctx.fillRect(x, y, s, s);
      ctx.fillStyle = 'rgba(255,255,255,0.65)'; ctx.fillRect(x, y, s, bv); ctx.fillRect(x, y, bv, s);
      ctx.fillStyle = 'rgba(0,0,0,0.55)'; ctx.fillRect(x, y + s - bv, s, bv); ctx.fillRect(x + s - bv, y, bv, s);
      ctx.fillStyle = color; ctx.fillRect(x + bv, y + bv, s - bv * 2, s - bv * 2);
      // Single bright pixel top-left
      ctx.fillStyle = 'rgba(255,255,255,0.9)'; ctx.fillRect(x + bv, y + bv, Math.max(1, Math.floor(s * 0.14)), Math.max(1, Math.floor(s * 0.14)));
    } else if (style === 'candy') {
      // Glossy candy: rounded block + big teardrop gloss
      const rc = Math.min(5, s * 0.22);
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(x, y, s, s);
      ctx.beginPath(); ctx.roundRect(x + 1, y + 1, s - 2, s - 2, rc); ctx.fillStyle = color; ctx.fill();
      // White border gleam
      ctx.strokeStyle = 'rgba(255,255,255,0.50)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.roundRect(x + 1.5, y + 1.5, s - 3, s - 3, rc); ctx.stroke();
      // Large gloss blob top
      const glossH = Math.floor(s * 0.44);
      const gg = ctx.createLinearGradient(x, y + 2, x, y + 2 + glossH);
      gg.addColorStop(0, 'rgba(255,255,255,0.78)'); gg.addColorStop(1, 'rgba(255,255,255,0.02)');
      ctx.beginPath(); ctx.roundRect(x + 2, y + 2, s - 4, glossH, [rc, rc, 0, 0]); ctx.fillStyle = gg; ctx.fill();
      // Bottom subtle shadow arc
      ctx.fillStyle = 'rgba(0,0,0,0.18)'; ctx.fillRect(x + 2, y + s - Math.max(2, Math.floor(s * 0.18)) - 1, s - 4, Math.max(2, Math.floor(s * 0.18)));
    } else if (style === 'glass') {
      // Frosted glass: transparent tint + diagonal reflection
      ctx.fillStyle = 'rgba(0,0,0,0.50)'; ctx.fillRect(x, y, s, s);
      ctx.fillStyle = color + '50'; ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      // Diagonal glare gradient (top-left → center)
      const dg = ctx.createLinearGradient(x + 1, y + 1, x + s * 0.75, y + s * 0.75);
      dg.addColorStop(0,   'rgba(255,255,255,0.52)');
      dg.addColorStop(0.45,'rgba(255,255,255,0.10)');
      dg.addColorStop(1,   'rgba(255,255,255,0.00)');
      ctx.fillStyle = dg; ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      // Colored rim (top + left)
      ctx.fillStyle = color + 'cc'; ctx.fillRect(x, y, s, 1); ctx.fillRect(x, y, 1, s);
      // Dark rim (bottom + right)
      ctx.fillStyle = 'rgba(0,0,0,0.60)'; ctx.fillRect(x, y + s - 1, s, 1); ctx.fillRect(x + s - 1, y, 1, s);
      // Thin vertical shimmer stripe
      ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(x + Math.floor(s * 0.68), y + 2, Math.max(1, Math.floor(s * 0.09)), s - 4);
    } else if (style === 'metal') {
      // Brushed chrome: horizontal light bands
      ctx.fillStyle = 'rgba(0,0,0,0.75)'; ctx.fillRect(x, y, s, s);
      const mg = ctx.createLinearGradient(x, y, x, y + s);
      mg.addColorStop(0,    'rgba(255,255,255,0.88)');
      mg.addColorStop(0.12, 'rgba(200,200,200,0.65)');
      mg.addColorStop(0.38, 'rgba(140,140,140,0.40)');
      mg.addColorStop(0.62, 'rgba(30,30,30,0.70)');
      mg.addColorStop(0.82, 'rgba(80,80,80,0.50)');
      mg.addColorStop(1,    'rgba(180,180,180,0.45)');
      ctx.fillStyle = mg; ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      // Color tint overlay
      ctx.fillStyle = color + '28'; ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      // Sharp specular line
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillRect(x + 2, y + Math.floor(s * 0.10), s - 4, Math.max(1, Math.floor(s * 0.07)));
    } else if (style === 'wireframe') {
      // Dark hollow frame with X-cross inner lines and corner pips
      ctx.fillStyle = 'rgba(0,0,0,0.88)'; ctx.fillRect(x, y, s, s);
      ctx.strokeStyle = color; ctx.lineWidth = 1.5;
      ctx.strokeRect(x + 1, y + 1, s - 2, s - 2);
      ctx.strokeStyle = color + '55'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(x + 2, y + 2); ctx.lineTo(x + s - 2, y + s - 2);
      ctx.moveTo(x + s - 2, y + 2); ctx.lineTo(x + 2, y + s - 2); ctx.stroke();
      const dp = Math.max(1, Math.ceil(s * 0.11));
      ctx.fillStyle = color;
      ctx.fillRect(x + 2, y + 2, dp, dp); ctx.fillRect(x + s - 2 - dp, y + 2, dp, dp);
      ctx.fillRect(x + 2, y + s - 2 - dp, dp, dp); ctx.fillRect(x + s - 2 - dp, y + s - 2 - dp, dp, dp);
    } else if (style === 'diamond') {
      // Four triangular facets meeting at block centre
      const cx = x + s / 2, cy = y + s / 2;
      ctx.fillStyle = color + 'aa';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + s, y); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.42)';
      ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + s, y); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill();
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.moveTo(x + s, y); ctx.lineTo(x + s, y + s); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.30)';
      ctx.beginPath(); ctx.moveTo(x + s, y + s); ctx.lineTo(x, y + s); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill();
      ctx.fillStyle = color + '88';
      ctx.beginPath(); ctx.moveTo(x, y + s); ctx.lineTo(x, y); ctx.lineTo(cx, cy); ctx.closePath(); ctx.fill();
      ctx.strokeStyle = 'rgba(0,0,0,0.55)'; ctx.lineWidth = 0.5; ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
      // Specular sparkle
      const spk = Math.floor(s * 0.16);
      ctx.fillStyle = 'rgba(255,255,255,0.92)'; ctx.fillRect(x + Math.floor(s * 0.18), y + Math.floor(s * 0.14), spk, Math.max(1, Math.floor(spk * 0.5)));
    } else if (style === 'hologram') {
      // Sci-fi hologram: dark bg, horizontal scan lines, colored glow rim
      ctx.fillStyle = 'rgba(0,0,0,0.72)'; ctx.fillRect(x, y, s, s);
      ctx.fillStyle = color + '44'; ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      // Scan lines
      for (let rl = y + 1; rl < y + s - 1; rl += 3) { ctx.fillStyle = color + '55'; ctx.fillRect(x + 1, rl, s - 2, 1); }
      // Bright colored border with glow
      ctx.shadowColor = color; ctx.shadowBlur = Math.max(4, s * 0.3);
      ctx.strokeStyle = color + 'cc'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
      ctx.shadowBlur = 0;
      // Vertical shimmer band
      ctx.fillStyle = 'rgba(255,255,255,0.30)'; ctx.fillRect(x + Math.floor(s * 0.28), y + 1, Math.max(1, Math.floor(s * 0.10)), s - 2);
      // Top glow line
      ctx.fillStyle = color + '99'; ctx.fillRect(x + 1, y + 1, s - 2, Math.max(1, Math.floor(s * 0.10)));
    } else if (style === 'lava') {
      // Molten rock: dark block, glowing crack network
      ctx.fillStyle = '#100500'; ctx.fillRect(x, y, s, s);
      ctx.fillStyle = color + '22'; ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      // Crack lines with glow
      ctx.shadowColor = color; ctx.shadowBlur = Math.max(4, s * 0.35);
      ctx.strokeStyle = color; ctx.lineWidth = Math.max(1, s * 0.065);
      ctx.beginPath();
      ctx.moveTo(x + s * 0.20, y + 1);
      ctx.lineTo(x + s * 0.50, y + s * 0.44);
      ctx.lineTo(x + s * 0.82, y + s - 1);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(x + s - 1, y + s * 0.22);
      ctx.lineTo(x + s * 0.50, y + s * 0.44);
      ctx.lineTo(x + 1, y + s * 0.78);
      ctx.stroke();
      ctx.shadowBlur = 0;
      // Hot radial glow at intersection
      const lg = ctx.createRadialGradient(x + s * 0.5, y + s * 0.44, 0, x + s * 0.5, y + s * 0.44, s * 0.42);
      lg.addColorStop(0, color + 'cc'); lg.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = lg; ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
    } else if (style === 'matrix') {
      // Digital rain: black-green with simulated character glyphs
      ctx.fillStyle = '#000d00'; ctx.fillRect(x, y, s, s);
      ctx.fillStyle = '#00ff4122'; ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      ctx.strokeStyle = '#00ff41'; ctx.lineWidth = 1; ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
      // Glyph rows — thin bars that look like characters
      const gh = Math.max(1, Math.floor(s * 0.13)), gw = Math.floor(s * 0.58), gx = x + Math.floor((s - gw) / 2);
      const rows = Math.max(2, Math.floor(s / (gh * 2.6)));
      for (let ri = 0; ri < rows; ri++) {
        const gy2 = y + Math.floor(s * 0.16) + ri * Math.floor(s / rows);
        const alpha = ri === 0 ? 'ee' : ri === rows - 1 ? '55' : '99';
        ctx.fillStyle = '#00ff41' + alpha; ctx.fillRect(gx, gy2, gw, gh);
        // Notch in the glyph bar to suggest character texture
        ctx.fillStyle = '#000d00'; ctx.fillRect(gx + Math.floor(gw * 0.3), gy2, Math.floor(gw * 0.18), gh);
      }
      // Bright top edge (leading drop)
      ctx.fillStyle = '#aaffaacc'; ctx.fillRect(x + 1, y + 1, s - 2, Math.max(1, Math.floor(s * 0.09)));
    } else if (style === 'glow') {
      ctx.shadowColor = color; ctx.shadowBlur = Math.max(6, s * .4);
      ctx.fillStyle = 'rgba(0,0,0,0.7)'; ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      ctx.fillStyle = color;
      ctx.fillRect(x + 1, y + 1, s - 2, 3); ctx.fillRect(x + 1, y + s - 4, s - 2, 3);
      ctx.fillRect(x + 1, y + 1, 3, s - 2); ctx.fillRect(x + s - 4, y + 1, 3, s - 2);
      ctx.fillStyle = color + '35'; ctx.fillRect(x + 4, y + 4, s - 8, s - 8);
      ctx.shadowBlur = 0;
    } else if (style === 'flat') {
      ctx.fillStyle = 'rgba(0,0,0,0.5)'; ctx.fillRect(x, y, s, s);
      ctx.fillStyle = color; ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      ctx.fillStyle = 'rgba(255,255,255,0.5)'; ctx.fillRect(x + 1, y + 1, s - 2, 2); ctx.fillRect(x + 1, y + 1, 2, s - 2);
      ctx.fillStyle = 'rgba(0,0,0,0.4)'; ctx.fillRect(x + 1, y + s - 3, s - 2, 2); ctx.fillRect(x + s - 3, y + 1, 2, s - 2);
    } else if (style === 'soft') {
      const r = Math.min(4, s / 5);
      ctx.fillStyle = color + '25'; ctx.fillRect(x, y, s, s);
      ctx.beginPath(); ctx.roundRect(x + 1, y + 1, s - 2, s - 2, r); ctx.fillStyle = color; ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.35)'; ctx.fillRect(x + 2, y + 2, s - 4, Math.max(2, s * .18));
      ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.fillRect(x + 2, y + s - Math.max(2, s * .18) - 2, s - 4, Math.max(2, s * .18));
    } else if (style === 'gradient') {
      const gr = ctx.createLinearGradient(x, y, x + s, y + s);
      gr.addColorStop(0, color + 'ee'); gr.addColorStop(1, color + '88');
      ctx.fillStyle = color + '22'; ctx.fillRect(x, y, s, s);
      ctx.fillStyle = gr; ctx.fillRect(x + 1, y + 1, s - 2, s - 2);
      ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(x + 1, y + 1, s - 2, Math.max(2, s * .15));
      ctx.fillStyle = 'rgba(0,0,0,0.2)'; ctx.fillRect(x + 1, y + s - Math.max(2, s * .15) - 1, s - 2, Math.max(2, s * .15));
    } else {
      // solid (classic)
      const g = 1;
      ctx.fillStyle = color + '30'; ctx.fillRect(x, y, s, s);
      ctx.fillStyle = color; ctx.fillRect(x + g, y + g, s - g * 2, s - g * 2);
      ctx.fillStyle = 'rgba(255,255,255,0.18)'; ctx.fillRect(x + g, y + g, s - g * 2, Math.max(1, s * .12)); ctx.fillRect(x + g, y + g, Math.max(1, s * .12), s - g * 2);
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(x + g, y + s - g - Math.max(1, s * .1), s - g * 2, Math.max(1, s * .1)); ctx.fillRect(x + s - g - Math.max(1, s * .1), y + g, Math.max(1, s * .1), s - g * 2);
    }
  }

  function drawPieceAt(ctx, shape, px, py, cs, colorIdx, alpha) {
    ctx.globalAlpha = alpha;
    for (let r = 0; r < shape.length; r++)for (let c = 0; c < shape[r].length; c++)if (shape[r][c]) { const br = py + r; if (br >= 0) drawBlock(ctx, (px + c) * cs, br * cs, cs, colorIdx); }
    ctx.globalAlpha = 1;
  }

  function drawHold() {
    const w = holdCanvas.width, h = holdCanvas.height; hctx.clearRect(0, 0, w, h); hctx.fillStyle = '#0f0f2e'; hctx.fillRect(0, 0, w, h);
    if (!game.holdType) return; const shape = ROTATIONS[game.holdType][0]; const cs = Math.floor(Math.min(w / (shape[0].length + 1), h / (shape.length + 1)));
    const ox = Math.floor((w - shape[0].length * cs) / 2), oy = Math.floor((h - shape.length * cs) / 2);
    hctx.globalAlpha = game.holdUsed ? .3 : 1;
    for (let r = 0; r < shape.length; r++)for (let c = 0; c < shape[r].length; c++)if (shape[r][c]) drawBlock(hctx, ox + c * cs, oy + r * cs, cs, COLOR_IDX[game.holdType]);
    hctx.globalAlpha = 1;
  }

  function drawNext() {
    const w = nextCanvas.width, h = nextCanvas.height; nctx.clearRect(0, 0, w, h); nctx.fillStyle = '#0f0f2e'; nctx.fillRect(0, 0, w, h);
    const nexts = game.peekNext(3); let ty = 10;
    for (const type of nexts) {
      const shape = ROTATIONS[type][0]; const cs = Math.floor(Math.min(w / (shape[0].length + 1), 60 / shape.length)); const ox = Math.floor((w - shape[0].length * cs) / 2);
      for (let r = 0; r < shape.length; r++)for (let c = 0; c < shape[r].length; c++)if (shape[r][c]) drawBlock(nctx, ox + c * cs, ty + r * cs, cs, COLOR_IDX[type]); ty += shape.length * cs + 15;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  SKIN FX THEME  — drives all celebration colours & shapes
  // ══════════════════════════════════════════════════════════════════
  function getSkinFx() {
    switch (activeSkinStyle) {
      case 'sprite':    return { palette: ['#00f0f0','#f0f000','#f00000','#0050f0','#f09000','#a000f0','#00e040'],
                                 flashA: (n,f)=>`rgba(255,255,255,${f})`,
                                 shimmer: 'rgba(255,255,255,.45)',
                                 labelColors: ['','#94a3b8','#06b6d4','#f97316','#fbbf24'],
                                 scoreColor: '#a78bfa', comboColor: '#22c55e', levelColor: '#fbbf24',
                                 particleShape: 'square', lockShape: 'square',
                                 textShadow: '#ffffff', vy: -1.6, decay: .016 };
      case 'pixel':     return { palette: ['#14e8ff','#ffe714','#e81414','#1490e8','#e87814','#e714c8','#14e840'],
                                 flashA: (n,f)=>`rgba(255,255,255,${f})`,
                                 shimmer: 'rgba(255,255,255,.55)',
                                 labelColors: ['','#94a3b8','#14e8ff','#e87814','#ffe714'],
                                 scoreColor: '#e714c8', comboColor: '#14e840', levelColor: '#ffe714',
                                 particleShape: 'square', lockShape: 'square',
                                 textShadow: '#14e8ff', vy: -1.8, decay: .018 };
      case 'candy':     return { palette: ['#ff79b0','#ffee58','#ce93d8','#80cbc4','#ef9a9a','#64b5f6','#ffb74d','#ffffff','#f48fb1'],
                                 flashA: (n,f)=>`rgba(255,180,210,${f})`,
                                 shimmer: 'rgba(255,255,255,.65)',
                                 labelColors: ['','#f48fb1','#80cbc4','#ffb74d','#ce93d8'],
                                 scoreColor: '#ff79b0', comboColor: '#80cbc4', levelColor: '#ffee58',
                                 particleShape: 'circle', lockShape: 'circle',
                                 textShadow: '#ff79b0', vy: -1.5, decay: .014 };
      case 'glass':     return { palette: ['#00d4ff','#ffffff','#ffe600','#2979ff','#00e676','#e040fb','#ccffff'],
                                 flashA: (n,f)=>`rgba(180,240,255,${f})`,
                                 shimmer: 'rgba(200,240,255,.55)',
                                 labelColors: ['','#90caf9','#00e5ff','#b39ddb','#e040fb'],
                                 scoreColor: '#00e5ff', comboColor: '#00e676', levelColor: '#ffffff',
                                 particleShape: 'diamond', lockShape: 'diamond',
                                 textShadow: '#00d4ff', vy: -1.4, decay: .015 };
      case 'metal':     return { palette: ['#e0e0e0','#bdbdbd','#9e9e9e','#ffffff','#eeeeee','#f5f5f5','#d4d4d4'],
                                 flashA: (n,f)=>`rgba(220,220,220,${f})`,
                                 shimmer: 'rgba(255,255,255,.70)',
                                 labelColors: ['','#9e9e9e','#bdbdbd','#e0e0e0','#ffffff'],
                                 scoreColor: '#e0e0e0', comboColor: '#bdbdbd', levelColor: '#ffffff',
                                 particleShape: 'square', lockShape: 'square',
                                 textShadow: '#aaaaaa', vy: -1.3, decay: .020 };
      case 'wireframe': return { palette: ['#00f0f0','#f0f000','#f00000','#0050f0','#f09000','#c000f0','#00e040'],
                                 flashA: (n,f)=>`rgba(0,240,240,${f * .8})`,
                                 shimmer: 'rgba(0,255,255,.40)',
                                 labelColors: ['','#6ee7b7','#00f0f0','#f0f000','#f00000'],
                                 scoreColor: '#c000f0', comboColor: '#00e040', levelColor: '#f0f000',
                                 particleShape: 'cross', lockShape: 'cross',
                                 textShadow: '#00f0f0', vy: -1.7, decay: .019 };
      case 'gradient':  return { palette: ['#818cf8','#c084fc','#f472b6','#34d399','#fb7185','#60a5fa','#fb923c','#a78bfa'],
                                 flashA: (n,f)=>`rgba(192,132,252,${f})`,
                                 shimmer: 'rgba(192,132,252,.45)',
                                 labelColors: ['','#a78bfa','#60a5fa','#fb923c','#c084fc'],
                                 scoreColor: '#c084fc', comboColor: '#34d399', levelColor: '#f472b6',
                                 particleShape: 'circle', lockShape: 'circle',
                                 textShadow: '#818cf8', vy: -1.5, decay: .015 };
      case 'diamond':   return { palette: ['#00e5ff','#ffd600','#e040fb','#00e676','#ff1744','#448aff','#ff9100','#ffffff'],
                                 flashA: (n,f)=>`rgba(220,240,255,${f})`,
                                 shimmer: 'rgba(255,255,255,.70)',
                                 labelColors: ['','#90caf9','#00e5ff','#ffd600','#e040fb'],
                                 scoreColor: '#ffffff', comboColor: '#00e676', levelColor: '#ffd600',
                                 particleShape: 'diamond', lockShape: 'diamond',
                                 textShadow: '#00e5ff', vy: -1.9, decay: .013 };
      case 'hologram':  return { palette: ['#00fff0','#f0ff00','#ff00f0','#00ff80','#00aaff','#ffaa00','#aaffff'],
                                 flashA: (n,f)=>`rgba(0,255,240,${f * .7})`,
                                 shimmer: 'rgba(0,255,255,.35)',
                                 labelColors: ['','#00ffcc','#00fff0','#f0ff00','#ff00f0'],
                                 scoreColor: '#00aaff', comboColor: '#00ff80', levelColor: '#f0ff00',
                                 particleShape: 'cross', lockShape: 'cross',
                                 textShadow: '#00fff0', vy: -1.6, decay: .017 };
      case 'lava':      return { palette: ['#ff8f00','#ffab00','#ff6d00','#d32f2f','#e65100','#bf360c','#ff6e40','#ffca28'],
                                 flashA: (n,f)=>`rgba(255,80,0,${f * .85})`,
                                 shimmer: 'rgba(255,140,0,.50)',
                                 labelColors: ['','#ff8f00','#ffab00','#ff6d00','#d32f2f'],
                                 scoreColor: '#ffca28', comboColor: '#ff6e40', levelColor: '#ff8f00',
                                 particleShape: 'ember', lockShape: 'ember',
                                 textShadow: '#ff4500', vy: -2.0, decay: .018 };
      case 'matrix':    return { palette: ['#00ff41','#33ff66','#00cc33','#aaffaa','#00ff41','#00ff41','#33ff11'],
                                 flashA: (n,f)=>`rgba(0,255,65,${f * .8})`,
                                 shimmer: 'rgba(0,255,65,.40)',
                                 labelColors: ['','#00cc33','#00ff41','#33ff66','#aaffaa'],
                                 scoreColor: '#00ff41', comboColor: '#33ff66', levelColor: '#aaffaa',
                                 particleShape: 'square', lockShape: 'square',
                                 textShadow: '#00ff41', vy: -1.4, decay: .022 };
      // glow skins: neon / fire
      case 'glow':      return { palette: activeSkinColors.slice(1,8).concat(['#ffffff']),
                                 flashA: (n,f)=>{
                                   const c = activeSkinColors[n>=4?7:n>=3?3:n>=2?1:2]||'#ffffff';
                                   return `${c}${Math.round(f*255).toString(16).padStart(2,'0')}`; },
                                 shimmer: (activeSkinColors[1]||'#ffffff')+'66',
                                 labelColors: ['','#aaaaaa', activeSkinColors[1], activeSkinColors[7], activeSkinColors[2]],
                                 scoreColor: activeSkinColors[3]||'#a78bfa', comboColor: activeSkinColors[4]||'#22c55e', levelColor: activeSkinColors[2]||'#fbbf24',
                                 particleShape: 'circle', lockShape: 'circle',
                                 textShadow: activeSkinColors[1]||'#ffffff', vy: -1.5, decay: .016 };
      // flat/soft/solid
      default:          return { palette: count => count >= 4
                                   ? ['#fbbf24','#ef4444','#a855f7','#06b6d4','#22c55e','#f97316']
                                   : activeSkinColors.slice(1,4),
                                 flashA: (n,f)=> n>=4?`rgba(251,191,36,${f})`:n>=3?`rgba(249,115,22,${f})`:n>=2?`rgba(6,182,212,${f})`:`rgba(255,255,255,${f})`,
                                 shimmer: 'rgba(255,255,255,.35)',
                                 labelColors: ['','#94a3b8','#06b6d4','#f97316','#fbbf24'],
                                 scoreColor: '#a78bfa', comboColor: '#22c55e', levelColor: '#fbbf24',
                                 particleShape: 'square', lockShape: 'square',
                                 textShadow: '#ffffff', vy: -1.4, decay: .017 };
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  PARTICLE & EFFECTS SYSTEM
  // ══════════════════════════════════════════════════════════════════

  const particles    = [];
  const floatingTexts = [];

  function spawnLockParticles(piece) {
    const fx = getSkinFx();
    const baseColor = activeSkinColors[piece.colorIdx] || activeSkinColors[1];
    for (let r = 0; r < piece.shape.length; r++) {
      for (let c = 0; c < piece.shape[r].length; c++) {
        if (!piece.shape[r][c]) continue;
        const br = piece.y + r; if (br < 0) continue;
        const px = (piece.x + c + .5) * cellSize, py = (br + .5) * cellSize;
        const count = activeSkinStyle === 'matrix' ? 3 : activeSkinStyle === 'metal' ? 4 : 5;
        for (let i = 0; i < count; i++) {
          const ang = Math.random() * Math.PI * 2, spd = Math.random() * 2.5 + .8;
          const color = fx.lockShape === 'ember'
            ? fx.palette[Math.floor(Math.random() * fx.palette.length)]
            : baseColor;
          particles.push({ x: px, y: py, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - .5,
            color, size: Math.random() * 3.5 + 1.5, life: 1,
            decay: .05 + Math.random() * .04, shape: fx.lockShape });
        }
      }
    }
  }

  function spawnClearParticles(rows, count) {
    const fx = getSkinFx();
    const palette = typeof fx.palette === 'function' ? fx.palette(count) : fx.palette;
    const perCell = count >= 4 ? 8 : count >= 2 ? 5 : 4;
    const spd0    = count >= 4 ? 8 : 5;
    for (const row of rows) {
      for (let c = 0; c < COLS; c++) {
        const px = (c + .5) * cellSize, py = (row + .5) * cellSize;
        for (let i = 0; i < perCell; i++) {
          const ang = Math.random() * Math.PI * 2, spd = Math.random() * spd0 + 1.5;
          particles.push({ x: px, y: py,
            vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - 1.5,
            color: palette[Math.floor(Math.random() * palette.length)],
            size: Math.random() * (count >= 4 ? 5 : 3.5) + 1.5,
            life: 1, decay: fx.decay + Math.random() * .015,
            shape: fx.particleShape });
        }
      }
    }
  }

  function spawnFloatingText(text, boardX, boardY, color) {
    const fx = getSkinFx();
    floatingTexts.push({ text, x: boardX, y: boardY, vy: fx.vy, life: 1, decay: fx.decay,
      color: color || fx.labelColors[4] || '#fbbf24',
      size: Math.max(11, cellSize * .75), shadow: fx.textShadow });
  }

  function updateEffects(delta) {
    const f = delta / 16;
    for (let i = particles.length - 1; i >= 0; i--) {
      const p = particles[i]; p.x += p.vx * f; p.y += p.vy * f; p.vy += .12 * f; p.life -= p.decay * f;
      if (p.life <= 0) particles.splice(i, 1);
    }
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
      const t = floatingTexts[i]; t.y += t.vy * f; t.life -= t.decay * f;
      if (t.life <= 0) floatingTexts.splice(i, 1);
    }
  }

  function drawEffects() {
    for (const p of particles) {
      bctx.globalAlpha = Math.max(0, p.life);
      bctx.fillStyle   = p.color;
      const sh = p.shape || 'square';
      const s  = p.size;
      if (sh === 'circle') {
        bctx.beginPath(); bctx.arc(p.x, p.y, s / 2, 0, Math.PI * 2); bctx.fill();
      } else if (sh === 'diamond') {
        bctx.beginPath(); bctx.moveTo(p.x, p.y - s * .7); bctx.lineTo(p.x + s * .5, p.y);
        bctx.lineTo(p.x, p.y + s * .7); bctx.lineTo(p.x - s * .5, p.y); bctx.closePath(); bctx.fill();
      } else if (sh === 'cross') {
        const t = Math.max(1, Math.floor(s * .32));
        bctx.fillRect(p.x - t / 2, p.y - s / 2, t, s);
        bctx.fillRect(p.x - s / 2, p.y - t / 2, s, t);
      } else if (sh === 'ember') {
        // Teardrop — wider at bottom, tapers to point at top
        bctx.beginPath(); bctx.moveTo(p.x, p.y - s * .8);
        bctx.bezierCurveTo(p.x + s * .5, p.y - s * .2, p.x + s * .5, p.y + s * .5, p.x, p.y + s * .5);
        bctx.bezierCurveTo(p.x - s * .5, p.y + s * .5, p.x - s * .5, p.y - s * .2, p.x, p.y - s * .8);
        bctx.closePath(); bctx.fill();
      } else {
        bctx.fillRect(p.x - s / 2, p.y - s / 2, s, s);
      }
    }
    for (const t of floatingTexts) {
      bctx.globalAlpha = Math.max(0, t.life);
      bctx.font = `bold ${t.size}px Orbitron, sans-serif`;
      bctx.textAlign = 'center';
      bctx.shadowColor = t.shadow || t.color; bctx.shadowBlur = 10;
      bctx.fillStyle = t.color;
      bctx.fillText(t.text, t.x, t.y);
      bctx.shadowBlur = 0;
    }
    bctx.globalAlpha = 1; bctx.textAlign = 'left';
  }

  // ── Process engine event flags ───────────────────────────────────
  function consumeEngineEvents(g, isPlayer) {
    if (g.lockedPiece) {
      spawnLockParticles(g.lockedPiece);
      if (isPlayer) SFX.play('lock');
      g.lockedPiece = null;
    }
    if (g.clearingStarted) {
      g.clearingStarted = false;
      spawnClearParticles(g.clearingRows, g.clearingRows.length);
    }
    if (g.lastClearInfo) {
      const { count, scoreGain, combo, leveledUp } = g.lastClearInfo;
      g.lastClearInfo = null;
      if (isPlayer) {
        const fx = getSkinFx();
        const cx = COLS * cellSize / 2;
        const clearLabels = {
          sprite:    ['','CLEAR','DOUBLE!','TRIPLE!!','TETRIS!!!'],
          pixel:     ['','CLEAR','DOUBLE!','TRIPLE!!','TETRIS!!!'],
          candy:     ['','✨ nice','✨✨ sweet!','✨✨✨ yummy!','🎀 TETRIS 🎀'],
          glass:     ['','CLEAR','2x CLEAR','3x CLEAR','✨ TETRIS ✨'],
          metal:     ['','CLEAR','DOUBLE','TRIPLE','T E T R I S'],
          wireframe: ['','[ ok ]','[ 2x ]','[ 3x ]','[ TETRIS ]'],
          gradient:  ['','clear','2× clear','3× clear','🌌 TETRIS'],
          diamond:   ['','◆','2◆ DOUBLE','◆◆◆ TRIPLE','◆◆◆◆ TETRIS'],
          hologram:  ['','[LINE]','[DUAL]','[TRIPLE]','[TETRIS]'],
          lava:      ['','🔥','DOUBLE🔥','🔥🔥🔥 TRIPLE','🌋 ERUPTION'],
          matrix:    ['','01','10 11','11 10 01','1111 TETRIS'],
          glow:      ['','CLEAR','DOUBLE!','TRIPLE!!','TETRIS!!!'],
          flat:      ['','SINGLE','DOUBLE','TRIPLE','TETRIS!'],
          soft:      ['','single','double','triple','TETRIS!'],
        };
        const labels = clearLabels[activeSkinStyle] || ['','SINGLE','DOUBLE','TRIPLE','TETRIS!'];
        const label  = labels[count] || `${count} LINES`;
        const lc     = (fx.labelColors[count] || fx.labelColors[4] || '#fbbf24');
        spawnFloatingText(label, cx, ROWS * cellSize * .35, lc);
        if (scoreGain > 0) spawnFloatingText(`+${scoreGain}`, cx, ROWS * cellSize * .45, fx.scoreColor);
        if (combo > 0) { spawnFloatingText(`COMBO ×${combo + 1}`, cx, ROWS * cellSize * .55, fx.comboColor); SFX.play('combo'); }
        SFX.play(['clear1','clear2','clear3','clear4'][Math.min(count, 4) - 1] || 'clear4');
        if (leveledUp) {
          boardCanvas.classList.add('level-up');
          setTimeout(() => boardCanvas.classList.remove('level-up'), 700);
          spawnFloatingText(`LEVEL ${g.level}!`, cx, ROWS * cellSize * .25, fx.levelColor);
          setTimeout(() => SFX.play('levelUp'), 150);
        }
      }
    }
  }

  function drawMiniBoard(cvs, data, pState) {
    const c = cvs.getContext('2d'), w = cvs.width, h = cvs.height; c.clearRect(0, 0, w, h); c.fillStyle = '#0f0f2e'; c.fillRect(0, 0, w, h);
    if (!data) return; const cs = Math.floor(Math.min(w / COLS, h / ROWS)); const ox = Math.floor((w - COLS * cs) / 2), oy = Math.floor((h - ROWS * cs) / 2);
    for (let r = 0; r < ROWS; r++)for (let col = 0; col < COLS; col++) { const v = data[r * COLS + col]; if (v) { c.fillStyle = COLORS[v] || '#94a3b8'; c.fillRect(ox + col * cs, oy + r * cs, cs - 1, cs - 1); } }
    if (pState && pState.piece && (pState.state === 'playing' || pState.state === 'clearing')) {
      const pi = pState.piece; const shape = ROTATIONS[pi.type] ? ROTATIONS[pi.type][pi.rot || 0] : null;
      if (shape) { c.fillStyle = COLORS[COLOR_IDX[pi.type]] || '#fff'; for (let r = 0; r < shape.length; r++)for (let cc = 0; cc < shape[r].length; cc++)if (shape[r][cc]) { const br = pi.y + r, bc = pi.x + cc; if (br >= 0 && br < ROWS && bc >= 0 && bc < COLS) c.fillRect(ox + bc * cs, oy + br * cs, cs - 1, cs - 1); } }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  GAME LOOP
  // ══════════════════════════════════════════════════════════════════

  function gameLoop(time) {
    const delta = Math.min(time - lastTime, 100); lastTime = time;
    if (game.state === 'playing' || game.state === 'clearing') {
      const garbage = game.update(delta);
      consumeEngineEvents(game, true);
      handleModeUpdate(delta);
      if (garbage > 0 && (inBattle || aiActive)) {
        if (inBattle) wsSend({ type: 'garbage', lines: garbage });
        if (aiActive && aiEngine) aiEngine.addGarbage(garbage);
        boardCanvas.parentElement.classList.add('shake');
        setTimeout(() => boardCanvas.parentElement.classList.remove('shake'), 350);
      }
      if (game.state === 'gameover') onGameOver();
    }
    if (aiActive && aiEngine) {
      if (aiEngine.state === 'playing' || aiEngine.state === 'clearing') { const ag = aiEngine.update(delta); consumeEngineEvents(aiEngine, false); if (ag > 0) game.addGarbage(ag); if (aiEngine.state === 'gameover') onAIGameOver(); }
      if (aiCtrl && aiEngine.state === 'playing') aiCtrl.update(delta);
    }
    updateEffects(delta);
    drawBoard(); drawHold(); drawNext(); drawEffects(); updatePanels(); throttledBroadcast(); updateMyCard();
    if (aiActive && aiEngine) updateAICard();
    requestAnimationFrame(gameLoop);
  }

  function updatePanels() { panelScore.textContent = game.score; panelLevel.textContent = game.level; panelLines.textContent = game.lines; panelGarbage.textContent = game.pendingGarbage; }

  // ══════════════════════════════════════════════════════════════════
  //  NETWORK
  // ══════════════════════════════════════════════════════════════════

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      const password = sessionStorage.getItem('arena-room-password') || undefined;
      sessionStorage.removeItem('arena-room-password');
      wsSend({ type: 'join-room', roomId, name: myName, password });
    };
    ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch { } };
    ws.onclose = () => { statusEl.textContent = 'Disconnected. Returning to lobby…'; setTimeout(() => location.href = '/', 3000); };
  }

  // ══════════════════════════════════════════════════════════════════
  //  SKINS — load & apply
  // ══════════════════════════════════════════════════════════════════

  function applySkin(skinId) {
    const skin = SKINS[skinId] || SKINS.classic;
    activeSkinColors = [...skin.colors];
    activeSkinStyle  = skin.style;
    equippedSkinId   = skinId;
  }

  async function loadUserSkins() {
    try {
      const token = sessionStorage.getItem('arena-token') ||
        (typeof fbAuth !== 'undefined' && fbAuth.currentUser ? await fbAuth.currentUser.getIdToken() : null);
      if (!token) return;
      const res = await fetch('/api/skins', { headers: { 'Authorization': 'Bearer ' + token } });
      if (!res.ok) return;
      const data = await res.json();
      unlockedSkins = data.isTester ? Object.keys(SKINS) : (data.unlockedSkins || ['sprites', 'classic', 'pixel']);
      // If user has no saved preference, default to sprites skin
      applySkin(data.equippedSkin || 'sprites');
    } catch {}
  }

  async function equipSkin(skinId) {
    applySkin(skinId);
    try {
      const token = sessionStorage.getItem('arena-token') ||
        (typeof fbAuth !== 'undefined' && fbAuth.currentUser ? await fbAuth.currentUser.getIdToken() : null);
      if (!token) return;
      await fetch('/api/skins/equip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token },
        body: JSON.stringify({ skin: skinId }),
      });
    } catch {}
  }

  // ══════════════════════════════════════════════════════════════════
  //  SKIN MODAL
  // ══════════════════════════════════════════════════════════════════

  const skinModal = $('skinModal'), skinClose = $('skinClose'), skinGrid = $('skinGrid'), skinSub = $('skinSub'), btnSkin = $('btnSkin');

  function openSkinModal() {
    skinGrid.innerHTML = '';
    const skinEntries = Object.entries(SKINS);
    skinSub.textContent = `${unlockedSkins.length} of ${skinEntries.length} skins unlocked`;
    for (const [id, skin] of skinEntries) {
      const locked   = !unlockedSkins.includes(id);
      const equipped = id === equippedSkinId;
      const item = document.createElement('div');
      item.className = 'skin-item' + (locked ? ' locked' : '') + (equipped ? ' equipped' : '');
      // Color preview swatches (show piece colors 1-7)
      const swatches = skin.colors.slice(1, 8).map(c => `<div class="skin-preview-swatch" style="background:${c}"></div>`).join('');
      const previewHtml = `<div class="skin-preview">${swatches}</div>`;
      item.innerHTML = `
        ${equipped ? '<div class="skin-item-badge">ON</div>' : ''}
        <span class="skin-item-icon">${skin.icon}</span>
        <div class="skin-item-name">${skin.name}</div>
        ${previewHtml}
        <div class="skin-item-lock">${locked ? '🔒 ' + skin.unlockScore.toLocaleString() + ' pts' : equipped ? '✓ Equipped' : 'Click to use'}</div>
      `;
      if (!locked) {
        item.addEventListener('click', async () => {
          await equipSkin(id);
          openSkinModal(); // re-render to show new equipped state
        });
      }
      skinGrid.appendChild(item);
    }
    skinModal.classList.add('show');
  }

  btnSkin.addEventListener('click', openSkinModal);
  skinClose.addEventListener('click', () => skinModal.classList.remove('show'));
  skinModal.addEventListener('click', e => { if (e.target === skinModal) skinModal.classList.remove('show'); });
  function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }
  function broadcastState() { wsSend({ type: 'state', data: game.getState() }); }
  function throttledBroadcast() { if (stateThrottle) return; stateThrottle = setTimeout(() => { stateThrottle = null; broadcastState(); }, 100); }

  function handleMsg(msg) {
    switch (msg.type) {
      case 'room-joined':
        myId = msg.myId || 'self';
        addPlayerCard('self', myName, true);
        for (const p of msg.players) { addPlayerCard(p.id, p.name, false); if (p.state) updateOtherState(p.id, p.state); }
        updatePlayerCount();
        statusEl.textContent = 'Press Start to play, or Battle for multiplayer!';
        break;
      case 'player-joined': addPlayerCard(msg.id, msg.name, false); updatePlayerCount(); break;
      case 'player-left': removePlayerCard(msg.id); updatePlayerCount(); break;
      case 'player-state': updateOtherState(msg.id, msg.data); break;
      case 'garbage': game.addGarbage(msg.lines); SFX.play('garbage'); break;
      case 'player-gameover': { const p = others.get(msg.id); if (p) { const t = p.el.querySelector('.pc-timer'); t.textContent = 'K.O.'; t.style.color = '#ef4444'; } break; }
      case 'battle-countdown':
        inBattle = true; countdownOvl.classList.add('show');
        countdownText.textContent = msg.count;
        countdownText.style.animation = 'none';
        requestAnimationFrame(() => { countdownText.style.animation = ''; });
        break;
      case 'battle-go':
        countdownOvl.classList.remove('show'); gameOverOvl.classList.remove('show');
        startGame(); statusEl.textContent = 'BATTLE! Clear lines to send garbage!'; break;
      case 'battle-end':
        inBattle = false;
        if (msg.winner) { goTitle.textContent = msg.winner.id === myId ? 'YOU WIN!' : msg.winner.name + ' WINS!'; if (msg.winner.id === myId) { launchConfetti(); if (typeof reportScore === 'function') reportScore('tetris', game.score); } }
        else goTitle.textContent = 'DRAW!';
        goScore.textContent = game.score; goLines.textContent = game.lines; goLevel.textContent = game.level;
        gameOverOvl.classList.add('show'); break;
      case 'chat': appendChat(msg.id === myId ? 'me' : 'other', msg.name, msg.text); break;
      case 'error': statusEl.textContent = msg.msg; break;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  AUDIO ENGINE  (Web Audio API, no files required)
  // ══════════════════════════════════════════════════════════════════
  const SFX = (() => {
    let ctx = null;
    let muted = false;
    const VOL = 0.38;

    function init() {
      if (ctx) return;
      try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch {}
    }

    function master() {
      const g = ctx.createGain(); g.gain.value = VOL;
      g.connect(ctx.destination); return g;
    }
    function osc(freq, type, duration, vol = 0.5, pitchEnd = null, when = 0) {
      if (muted || !ctx) return;
      const t = ctx.currentTime + when;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = type; o.frequency.setValueAtTime(freq, t);
      if (pitchEnd !== null) o.frequency.exponentialRampToValueAtTime(pitchEnd, t + duration * 0.8);
      g.gain.setValueAtTime(vol, t);
      g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      o.connect(g); g.connect(master()); o.start(t); o.stop(t + duration + 0.01);
    }
    function noise(duration, vol = 0.25, type = 'bandpass', freq = 400, Q = 1, when = 0) {
      if (muted || !ctx) return;
      const t = ctx.currentTime + when;
      const sr = ctx.sampleRate, len = Math.ceil(sr * duration);
      const buf = ctx.createBuffer(1, len, sr), d = buf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      const src = ctx.createBufferSource(); src.buffer = buf;
      const f = ctx.createBiquadFilter(); f.type = type; f.frequency.value = freq; f.Q.value = Q;
      const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + duration);
      src.connect(f); f.connect(g); g.connect(master()); src.start(t); src.stop(t + duration + 0.01);
    }
    function arp(freqs, type, noteDur, vol = 0.40, gap = 0) {
      freqs.forEach((f, i) => osc(f, type, noteDur, vol, null, i * (noteDur + gap)));
    }
    function chord(freqs, type, dur, vol = 0.26, when = 0) {
      freqs.forEach(f => osc(f, type, dur, vol, null, when));
    }

    // Skin sound group
    function grp() {
      switch (activeSkinStyle) {
        case 'sprite': case 'pixel': case 'flat': return 'retro';
        case 'glow': case 'wireframe': case 'hologram': return 'synth';
        case 'matrix': return 'matrix';
        case 'candy': case 'soft': return 'bell';
        case 'glass': case 'diamond': return 'crystal';
        case 'gradient': return 'space';
        case 'lava': return 'lava';
        case 'metal': return 'metal';
        default: return 'retro';
      }
    }

    const S = {
      move: {
        retro:   () => osc(220, 'square',   0.025, 0.12),
        synth:   () => osc(660, 'sawtooth', 0.018, 0.08),
        matrix:  () => osc(110, 'square',   0.020, 0.10),
        bell:    () => osc(880, 'sine',     0.035, 0.09),
        crystal: () => osc(1100,'sine',     0.025, 0.07),
        space:   () => osc(440, 'sine',     0.030, 0.07, 330),
        lava:    () => noise(0.025, 0.12, 'lowpass', 120, 0.8),
        metal:   () => osc(180, 'sawtooth', 0.022, 0.10),
      },
      rotate: {
        retro:   () => osc(330, 'square',   0.04, 0.18),
        synth:   () => osc(880, 'sawtooth', 0.03, 0.13, 1320),
        matrix:  () => { osc(220,'square',0.02,0.10); osc(440,'square',0.02,0.08,null,0.02); },
        bell:    () => osc(1320,'triangle', 0.06, 0.16),
        crystal: () => { osc(1760,'sine',0.05,0.13); osc(2200,'sine',0.04,0.07,null,0.01); },
        space:   () => osc(660, 'sine',     0.06, 0.12, 990),
        lava:    () => noise(0.04, 0.18, 'bandpass', 200, 2),
        metal:   () => { osc(220,'sawtooth',0.03,0.12); noise(0.03,0.08,'highpass',2000,1); },
      },
      softDrop: {
        retro:   () => osc(165, 'square',   0.03, 0.10),
        synth:   () => osc(330, 'sawtooth', 0.025, 0.08),
        matrix:  () => osc(110, 'square',   0.03, 0.08),
        bell:    () => osc(440, 'triangle', 0.04, 0.08),
        crystal: () => osc(660, 'sine',     0.03, 0.07),
        space:   () => osc(330, 'sine',     0.04, 0.06, 220),
        lava:    () => noise(0.03, 0.10, 'lowpass', 80, 1),
        metal:   () => osc(120, 'sawtooth', 0.025, 0.09),
      },
      hardDrop: {
        retro:   () => { osc(110,'square',0.07,0.30,55);   noise(0.06,0.18,'lowpass',200,1); },
        synth:   () => { osc(80,'sawtooth',0.08,0.28,40);  noise(0.06,0.15,'bandpass',300,2); },
        matrix:  () => { osc(55,'square',0.10,0.25);       noise(0.08,0.20,'lowpass',150,0.8); },
        bell:    () => { osc(220,'sine',0.09,0.22,110);    noise(0.05,0.10,'lowpass',300,1); },
        crystal: () => { osc(330,'sine',0.07,0.18,165);    noise(0.04,0.08,'highpass',1000,2); },
        space:   () => { osc(110,'sine',0.12,0.20,55);     noise(0.08,0.12,'bandpass',200,1); },
        lava:    () => { osc(55,'sawtooth',0.12,0.35,28);  noise(0.10,0.28,'lowpass',100,0.6); },
        metal:   () => { osc(60,'sawtooth',0.10,0.32,30);  noise(0.10,0.22,'bandpass',400,3); },
      },
      lock: {
        retro:   () => { osc(200,'square',0.05,0.20);      osc(150,'square',0.05,0.15,null,0.04); },
        synth:   () => { osc(300,'sawtooth',0.04,0.18);    noise(0.03,0.08,'highpass',1500,2); },
        matrix:  () => { osc(160,'square',0.06,0.16);      noise(0.04,0.10,'bandpass',600,3); },
        bell:    () => osc(660, 'triangle', 0.08, 0.22),
        crystal: () => { osc(880,'sine',0.07,0.18);        osc(1320,'sine',0.05,0.09,null,0.02); },
        space:   () => osc(440, 'sine',     0.10, 0.18, 220),
        lava:    () => { noise(0.07,0.22,'lowpass',150,0.8); osc(80,'sawtooth',0.08,0.18,50); },
        metal:   () => { noise(0.06,0.18,'bandpass',600,4); osc(140,'sawtooth',0.07,0.16); },
      },
      clear1: {
        retro:   () => arp([262,330,392], 'square', 0.07, 0.30),
        synth:   () => arp([440,660,880], 'sawtooth', 0.06, 0.22),
        matrix:  () => arp([110,220,165], 'square', 0.06, 0.20),
        bell:    () => arp([523,659,784], 'triangle', 0.08, 0.25),
        crystal: () => arp([880,1109,1318], 'sine', 0.07, 0.20),
        space:   () => { osc(440,'sine',0.15,0.22,660); osc(550,'sine',0.12,0.12,825,0.05); },
        lava:    () => { noise(0.12,0.22,'bandpass',300,2); osc(110,'sawtooth',0.10,0.20,220); },
        metal:   () => { noise(0.08,0.20,'bandpass',800,3); arp([220,330],'sawtooth',0.07,0.18); },
      },
      clear2: {
        retro:   () => arp([262,330,392,523], 'square', 0.07, 0.33),
        synth:   () => arp([440,660,880,1100], 'sawtooth', 0.06, 0.25),
        matrix:  () => arp([110,220,330,220], 'square', 0.055, 0.22),
        bell:    () => arp([523,659,784,988], 'triangle', 0.08, 0.28),
        crystal: () => arp([880,1109,1318,1760], 'sine', 0.07, 0.22),
        space:   () => { osc(440,'sine',0.18,0.25,880); osc(660,'sine',0.15,0.15,990,0.06); },
        lava:    () => { noise(0.15,0.28,'bandpass',400,2); osc(110,'sawtooth',0.13,0.24,330); },
        metal:   () => { noise(0.10,0.24,'bandpass',1000,3); arp([220,330,440],'sawtooth',0.07,0.20); },
      },
      clear3: {
        retro:   () => arp([262,330,392,523,659], 'square', 0.065, 0.35),
        synth:   () => arp([330,495,660,990,1320], 'sawtooth', 0.06, 0.28),
        matrix:  () => arp([110,165,220,330,440], 'square', 0.055, 0.24),
        bell:    () => arp([523,659,784,988,1175], 'triangle', 0.075, 0.30),
        crystal: () => arp([880,1109,1318,1760,2218], 'sine', 0.065, 0.24),
        space:   () => { osc(330,'sine',0.22,0.28,990); osc(550,'sine',0.18,0.18,1320,0.07); },
        lava:    () => { noise(0.18,0.32,'bandpass',500,2.5); osc(80,'sawtooth',0.16,0.28,440); },
        metal:   () => { noise(0.12,0.28,'bandpass',1200,3.5); arp([180,270,360,540],'sawtooth',0.07,0.22); },
      },
      clear4: {
        retro:   () => { arp([262,330,392,523,659,784,1047],'square',0.065,0.38);   chord([330,415,523],'square',0.40,0.18); },
        synth:   () => { arp([220,330,440,660,880,1320],'sawtooth',0.06,0.30);      chord([440,550,660],'sawtooth',0.45,0.15); },
        matrix:  () => { arp([55,110,220,440,880],'square',0.08,0.28);             noise(0.35,0.20,'bandpass',600,2); },
        bell:    () => { arp([523,659,784,988,1175,1319,1568],'triangle',0.07,0.32); chord([784,988,1175],'triangle',0.45,0.20); },
        crystal: () => { arp([880,1109,1318,1760,2218,2637,3520],'sine',0.065,0.28); chord([1318,1760,2218],'sine',0.40,0.15); },
        space:   () => { arp([220,330,440,660,880,1320],'sine',0.07,0.32); chord([440,550,660],'sine',0.50,0.12,0.44); },
        lava:    () => { noise(0.28,0.38,'lowpass',600,2); arp([55,110,165,220,330],'sawtooth',0.09,0.35); osc(55,'sawtooth',0.55,0.30,28); },
        metal:   () => { noise(0.20,0.35,'bandpass',1500,4); arp([110,165,220,330,440,660],'sawtooth',0.075,0.32); chord([220,330,440],'sawtooth',0.50,0.18); },
      },
      levelUp: {
        retro:   () => arp([262,330,392,523,659,784], 'square', 0.08, 0.40),
        synth:   () => { arp([220,330,440,660,880],'sawtooth',0.07,0.35); osc(1760,'sawtooth',0.18,0.18,null,0.35); },
        matrix:  () => { arp([110,220,330,440,660],'square',0.08,0.30); noise(0.25,0.15,'highpass',2000,1,0.35); },
        bell:    () => arp([523,659,784,988,1175,1319], 'triangle', 0.09, 0.35),
        crystal: () => { arp([880,1109,1318,1760,2218,2637],'sine',0.08,0.28); chord([1318,1760,2218],'sine',0.28,0.15,0.42); },
        space:   () => { arp([220,330,440,660,880,1320],'sine',0.08,0.38); osc(880,'sine',0.35,0.18,1760,0.45); },
        lava:    () => { arp([55,82,110,165,220,330],'sawtooth',0.09,0.38); noise(0.20,0.22,'bandpass',400,2,0.44); },
        metal:   () => { arp([110,165,220,330,440,660],'sawtooth',0.08,0.40); noise(0.25,0.20,'bandpass',1200,3,0.44); },
      },
      combo: {
        retro:   () => osc(784, 'square',   0.06, 0.25),
        synth:   () => osc(1100,'sawtooth', 0.05, 0.20, 1650),
        matrix:  () => { osc(440,'square',0.04,0.18); osc(880,'square',0.04,0.12,null,0.04); },
        bell:    () => osc(1568,'triangle', 0.08, 0.22),
        crystal: () => { osc(2637,'sine',0.06,0.18); osc(3136,'sine',0.05,0.10,null,0.03); },
        space:   () => osc(880, 'sine',     0.10, 0.20, 1760),
        lava:    () => { noise(0.06,0.18,'bandpass',600,3); osc(220,'sawtooth',0.06,0.16); },
        metal:   () => { noise(0.05,0.16,'highpass',2000,2); osc(330,'sawtooth',0.06,0.18); },
      },
      hold: {
        retro:   () => { osc(392,'square',0.05,0.20); osc(330,'square',0.04,0.15,null,0.04); },
        synth:   () => osc(550, 'sawtooth', 0.04, 0.18, 440),
        matrix:  () => { osc(220,'square',0.04,0.15); osc(330,'square',0.03,0.10,null,0.04); },
        bell:    () => osc(784, 'triangle', 0.07, 0.20),
        crystal: () => { osc(1318,'sine',0.05,0.16); osc(988,'sine',0.04,0.10,null,0.04); },
        space:   () => osc(660, 'sine',     0.08, 0.18, 440),
        lava:    () => noise(0.05, 0.16, 'bandpass', 250, 2),
        metal:   () => { osc(200,'sawtooth',0.04,0.16); noise(0.04,0.10,'highpass',1500,2); },
      },
      garbage: {
        retro:   () => { osc(110,'square',0.08,0.28,82);     osc(82,'square',0.08,0.20,55,0.06); },
        synth:   () => { osc(80,'sawtooth',0.10,0.28,50);    noise(0.08,0.15,'lowpass',200,1); },
        matrix:  () => { noise(0.12,0.22,'lowpass',200,0.8); osc(55,'square',0.12,0.20,40); },
        bell:    () => { osc(220,'triangle',0.10,0.22,165);  osc(165,'triangle',0.09,0.15,110,0.05); },
        crystal: () => { osc(330,'sine',0.09,0.20,220);      noise(0.07,0.12,'bandpass',400,2); },
        space:   () => osc(165, 'sine',     0.15, 0.22, 82),
        lava:    () => { noise(0.14,0.30,'lowpass',120,0.6); osc(55,'sawtooth',0.14,0.28,28); },
        metal:   () => { noise(0.12,0.26,'bandpass',300,3);  osc(80,'sawtooth',0.12,0.24,40); },
      },
      gameOver: {
        retro:   () => arp([392,330,262,220,165,110], 'square', 0.12, 0.35),
        synth:   () => { arp([440,330,220,165,110,82],'sawtooth',0.11,0.30); noise(0.40,0.15,'lowpass',150,0.8,0.55); },
        matrix:  () => { arp([220,165,110,82,55,41],'square',0.12,0.28); noise(0.50,0.18,'lowpass',100,0.6,0.60); },
        bell:    () => arp([659,523,440,349,262,220,165], 'triangle', 0.13, 0.30),
        crystal: () => arp([1318,1047,880,698,523,440,330], 'sine', 0.12, 0.25),
        space:   () => { osc(440,'sine',0.80,0.22,55); arp([330,247,196,165,110],'sine',0.14,0.28,0.02); },
        lava:    () => { arp([110,82,65,55,41,33],'sawtooth',0.13,0.38); noise(0.55,0.25,'lowpass',100,0.5,0.55); },
        metal:   () => { arp([220,165,110,82,55],'sawtooth',0.13,0.36); noise(0.55,0.25,'bandpass',200,2,0.55); },
      },
    };

    function play(event) {
      if (muted || !ctx) return;
      const g = grp(), bucket = S[event];
      if (!bucket) return;
      try { (bucket[g] || bucket.retro)(); } catch {}
    }

    function toggleMute() { muted = !muted; return muted; }
    function isMuted() { return muted; }

    return { init, play, toggleMute, isMuted };
  })();

  // ══════════════════════════════════════════════════════════════════
  //  CHAT
  // ══════════════════════════════════════════════════════════════════

  function appendChat(kind, name, text) {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + kind;
    div.innerHTML = kind !== 'system'
      ? `<span class="cm-name">${escapeHtml(name)}:</span>${escapeHtml(text)}`
      : escapeHtml(text);
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    wsSend({ type: 'chat', text });
    appendChat('me', myName, text);
    chatInput.value = '';
  }

  chatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    e.stopPropagation(); // prevent game keys while typing
  });

  // ══════════════════════════════════════════════════════════════════
  //  SIDEBAR — Compact Player Cards
  // ══════════════════════════════════════════════════════════════════

  const PALETTE = ['#34d399', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#fb923c', '#2dd4bf', '#e879f9'];
  let colorIdx = 0; function nextColor() { return PALETTE[colorIdx++ % PALETTE.length]; }

  function addPlayerCard(id, name, isMe) {
    if (isMe && document.querySelector('.player-card[data-id="self"]')) return;
    if (!isMe && others.has(id)) return;
    const color = isMe ? '#34d399' : nextColor();
    const card = document.createElement('div');
    card.className = 'player-card' + (isMe ? ' me' : '');
    card.dataset.id = isMe ? 'self' : id;
    card.innerHTML = `
    <div class="pc-header">
      <span class="pc-dot" style="background:${color}"></span>
      <span class="pc-name">${escapeHtml(name)}${isMe ? ' (you)' : ''}</span>
      <span class="pc-timer">0 pts</span>
    </div>
    <div class="mini-board-wrap"><canvas width="100" height="200"></canvas></div>
  `;
    playerListEl.appendChild(card);
    if (!isMe) others.set(id, { name, state: null, el: card, canvas: card.querySelector('canvas') });
  }
  function removePlayerCard(id) { const p = others.get(id); if (p) { p.el.remove(); others.delete(id); } }
  function updatePlayerCount() { const ai = document.querySelector(`.player-card[data-id="${AI_ID}"]`) ? 1 : 0; playerCountEl.textContent = 1 + others.size + ai; }

  function updateMyCard() {
    const card = document.querySelector('.player-card[data-id="self"]'); if (!card) return;
    card.querySelector('.pc-timer').textContent = game.score + ' pts';
    drawMiniBoard(card.querySelector('canvas'), game.encodedBoard(), game.getState());
  }

  function updateOtherState(id, data) {
    const p = others.get(id); if (!p) return; p.state = data;
    p.el.querySelector('.pc-timer').textContent = data.score + ' pts';
    drawMiniBoard(p.canvas, data.board, data);
  }

  // ── AI ───────────────────────────────────────────────────────────
  function toggleAI() {
    aiActive = !aiActive;
    if (aiActive) { btnVsAI.textContent = 'Stop AI'; ensureAICard(); if (game.state === 'playing') startAIEngine(); }
    else { btnVsAI.textContent = 'VS AI'; aiEngine = null; aiCtrl = null; removeAICardEl(); updatePlayerCount(); }
  }
  function startAIEngine() { aiEngine = new TetrisEngine(); aiEngine.start(); aiCtrl = new TetrisAI(aiEngine, aiDiffSelect.value); ensureAICard(); }
  function ensureAICard() {
    if (document.querySelector(`.player-card[data-id="${AI_ID}"]`)) return;
    const diff = aiDiffSelect.value, label = diff.charAt(0).toUpperCase() + diff.slice(1);
    const card = document.createElement('div'); card.className = 'player-card ai'; card.dataset.id = AI_ID;
    card.innerHTML = `<div class="pc-header"><span class="pc-dot" style="background:#ef4444"></span><span class="pc-name">CPU (${escapeHtml(label)})</span><span class="pc-timer">0 pts</span></div><div class="mini-board-wrap"><canvas width="100" height="200"></canvas></div>`;
    playerListEl.appendChild(card); updatePlayerCount();
  }
  function removeAICardEl() { const c = document.querySelector(`.player-card[data-id="${AI_ID}"]`); if (c) c.remove(); }
  function updateAICard() { const card = document.querySelector(`.player-card[data-id="${AI_ID}"]`); if (!card || !aiEngine) return; card.querySelector('.pc-timer').textContent = aiEngine.score + ' pts'; drawMiniBoard(card.querySelector('canvas'), aiEngine.encodedBoard(), aiEngine.getState()); }
  function onAIGameOver() { if (game.state === 'playing') statusEl.textContent = 'AI defeated! You win!'; }

  // ── Game Lifecycle ───────────────────────────────────────────────
  function fillDigBoard() {
    for (let r = 4; r < ROWS; r++) {
      const hole = Math.floor(Math.random() * COLS);
      for (let c = 0; c < COLS; c++) game.board[r][c] = c === hole ? 0 : 8;
    }
  }
  function isDigComplete() {
    for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++) if (game.board[r][c] === 8) return false;
    return true;
  }
  function fmtTime(ms) { const m = Math.floor(ms / 60000); const s = Math.floor((ms % 60000) / 1000).toString().padStart(2,'0'); return m + ':' + s; }
  function fmtTimePrecise(ms) { const m = Math.floor(ms / 60000); const s = ((ms % 60000) / 1000).toFixed(2).padStart(5,'0'); return m + ':' + s; }
  function updateModeDisplay() {
    if (currentMode === 'marathon') { timerBox.style.display = 'none'; return; }
    timerBox.style.display = '';
    switch (currentMode) {
      case 'sprint': timerLabel.textContent = 'TIME'; panelTimer.textContent = fmtTimePrecise(modeTimer); break;
      case 'ultra':  timerLabel.textContent = 'LEFT'; { const t = Math.max(0, modeTimer); const m = Math.floor(t/60000); const s = String(Math.ceil((t%60000)/1000)).padStart(2,'0'); panelTimer.textContent = m+':'+s; } break;
      case 'survival': timerLabel.textContent = 'ALIVE'; panelTimer.textContent = fmtTime(modeTimer); break;
      case 'dig': { timerLabel.textContent = 'CELLS'; let gray=0; for (let r=0;r<ROWS;r++) for (let c=0;c<COLS;c++) if (game.board[r][c]===8) gray++; panelTimer.textContent = gray; } break;
    }
  }
  function showModeEnd(title, stat3Label, stat3Val, confetti) {
    modeActive = false;
    goLevelLabel.textContent = stat3Label;
    goTitle.textContent = title; goScore.textContent = game.score; goLines.textContent = game.lines; goLevel.textContent = stat3Val;
    gameOverOvl.classList.add('show'); btnStart.disabled = false;
    if (typeof reportScore === 'function') reportScore('tetris', game.score);
    if (confetti) launchConfetti();
  }
  function onSprintWin() { game.state = 'idle'; SFX.play('levelUp'); showModeEnd('🏁 SPRINT CLEAR!', 'Time', fmtTimePrecise(modeTimer), true); broadcastState(); }
  function onUltraEnd()  { game.state = 'idle'; showModeEnd('⚡ ULTRA END!', 'Level', game.level, true); launchConfetti(); broadcastState(); }
  function onDigWin()    { game.state = 'idle'; SFX.play('levelUp'); showModeEnd('⛏️ DIG COMPLETE!', 'Level', game.level, true); broadcastState(); }
  function handleModeUpdate(delta) {
    if (!modeActive) return;
    if (game.state !== 'playing' && game.state !== 'clearing') return;
    switch (currentMode) {
      case 'sprint':
        if (game.state === 'playing' || game.state === 'clearing') modeTimer += delta;
        updateModeDisplay();
        if (game.lines >= 40) onSprintWin();
        break;
      case 'ultra':
        modeTimer = Math.max(0, modeTimer - delta);
        updateModeDisplay();
        if (modeTimer <= 0) onUltraEnd();
        break;
      case 'survival':
        modeTimer += delta;
        survivalAccum += delta;
        if (survivalAccum >= survivalGapMs) {
          survivalAccum = 0; survivalWave++;
          const wl = Math.min(4, 1 + Math.floor(survivalWave / 4));
          game.addGarbage(wl);
          survivalGapMs = Math.max(1800, survivalGapMs * 0.92);
          boardCanvas.parentElement.classList.add('shake');
          setTimeout(() => boardCanvas.parentElement.classList.remove('shake'), 350);
          SFX.play('garbage');
        }
        updateModeDisplay();
        break;
      case 'dig':
        updateModeDisplay();
        if (game.state === 'playing' && game.lines > 0 && isDigComplete()) onDigWin();
        break;
    }
  }
  function startGame() {
    currentMode = modeSelect.value;
    modeTimer = currentMode === 'ultra' ? 120000 : 0;
    modeActive = true;
    survivalAccum = 0; survivalGapMs = 9000; survivalWave = 0;
    game.start();
    if (currentMode === 'dig') fillDigBoard();
    goLevelLabel.textContent = 'Level';
    updateModeDisplay();
    gameOverOvl.classList.remove('show');
    const modeHints = { marathon:'Marathon — survive!', sprint:'Sprint — clear 40 lines!', ultra:'Ultra — 2 minutes!', survival:'Survival — hold on!', dig:'Dig — clear the board!' };
    statusEl.textContent = modeHints[currentMode] || 'Playing!';
    btnStart.disabled = true;
    if (aiActive) startAIEngine();
  }
  function onGameOver() {
    game.state = 'gameover';
    modeActive = false;
    SFX.play('gameOver');
    if (inBattle) { wsSend({ type: 'game-over' }); statusEl.textContent = 'Game Over! Waiting…'; }
    else if (aiActive && aiEngine && aiEngine.state === 'playing') { goLevelLabel.textContent = 'Level'; goTitle.textContent = 'AI WINS!'; goScore.textContent = game.score; goLines.textContent = game.lines; goLevel.textContent = game.level; gameOverOvl.classList.add('show'); }
    else if (currentMode === 'survival') { goLevelLabel.textContent = 'Survived'; goTitle.textContent = '💀 YOU FELL!'; goScore.textContent = game.score; goLines.textContent = game.lines; goLevel.textContent = fmtTime(modeTimer); gameOverOvl.classList.add('show'); if (typeof reportScore === 'function') reportScore('tetris', game.score); }
    else { goLevelLabel.textContent = 'Level'; goTitle.textContent = 'GAME OVER'; goScore.textContent = game.score; goLines.textContent = game.lines; goLevel.textContent = game.level; gameOverOvl.classList.add('show'); if (typeof reportScore === 'function') reportScore('tetris', game.score); }
    btnStart.disabled = false; broadcastState();
  }

  // ── Confetti ─────────────────────────────────────────────────────
  function launchConfetti() {
    confettiCvs.width = window.innerWidth; confettiCvs.height = window.innerHeight;
    const parts = [], colors = ['#7c3aed', '#06b6d4', '#f59e0b', '#34d399', '#ef4444', '#ec4899', '#a78bfa', '#fbbf24'];
    for (let i = 0; i < 180; i++)parts.push({ x: Math.random() * confettiCvs.width, y: Math.random() * confettiCvs.height - confettiCvs.height, vx: (Math.random() - .5) * 6, vy: Math.random() * 4 + 2, size: Math.random() * 8 + 3, color: colors[Math.floor(Math.random() * colors.length)], rot: Math.random() * 360, rotSpd: (Math.random() - .5) * 10, life: 1 });
    let frame = 0; function anim() { cctx.clearRect(0, 0, confettiCvs.width, confettiCvs.height); let alive = false; for (const p of parts) { if (p.life <= 0) continue; alive = true; p.x += p.vx; p.y += p.vy; p.vy += .08; p.rot += p.rotSpd; if (frame > 70) p.life -= .015; cctx.save(); cctx.translate(p.x, p.y); cctx.rotate(p.rot * Math.PI / 180); cctx.globalAlpha = Math.max(0, p.life); cctx.fillStyle = p.color; cctx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2); cctx.restore(); } frame++; if (alive) requestAnimationFrame(anim); else cctx.clearRect(0, 0, confettiCvs.width, confettiCvs.height); } anim();
  }

  // ══════════════════════════════════════════════════════════════════
  //  INPUT
  // ══════════════════════════════════════════════════════════════════

  function handleKey(key) {
    if (game.state !== 'playing') return;
    switch (key) {
      case 'ArrowLeft':  if (game.moveLeft())  SFX.play('move');    break;
      case 'ArrowRight': if (game.moveRight()) SFX.play('move');    break;
      case 'ArrowDown':  game.softDrop(); SFX.play('softDrop');     break;
      case 'ArrowUp': case 'x': case 'X': if (game.rotate(1))  SFX.play('rotate'); break;
      case 'z': case 'Z':                  if (game.rotate(-1)) SFX.play('rotate'); break;
      case ' ': {
        SFX.play('hardDrop');
        const g = game.hardDrop();
        if (g > 0 && (inBattle || aiActive)) { if (inBattle) wsSend({ type: 'garbage', lines: g }); if (aiActive && aiEngine) aiEngine.addGarbage(g); }
        if (game.state === 'gameover') onGameOver();
        break;
      }
      case 'c': case 'C': case 'Shift': game.doHold(); SFX.play('hold'); break;
    }
  }

  document.addEventListener('keydown', e => {
    if (game.state !== 'playing') return;
    const k = e.key; if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', ' ', 'z', 'Z', 'x', 'X', 'c', 'C', 'Shift'].includes(k)) e.preventDefault();
    if (k === 'm' || k === 'M') { const m = SFX.toggleMute(); statusEl.textContent = m ? '🔇 Muted' : '🔊 Sound on'; setTimeout(() => { if (game.state === 'playing') statusEl.textContent = 'Playing!'; }, 1500); return; }
    if (keys[k]) return; keys[k] = true; handleKey(k);
    if (['ArrowLeft', 'ArrowRight', 'ArrowDown'].includes(k)) { clearTimeout(dasTimer); clearInterval(dasTimer); dasKey = k; dasTimer = setTimeout(() => { dasTimer = setInterval(() => { if (keys[dasKey]) handleKey(dasKey); else { clearInterval(dasTimer); dasTimer = null; } }, DAS_REPEAT); }, DAS_DELAY); }
  });
  document.addEventListener('keyup', e => { keys[e.key] = false; if (e.key === dasKey) { clearTimeout(dasTimer); clearInterval(dasTimer); dasTimer = null; } });
  document.addEventListener('keydown', SFX.init, { once: true });
  document.addEventListener('pointerdown', SFX.init, { once: true });

  // ── Button Events ────────────────────────────────────────────────
  btnStart.addEventListener('click', startGame);
  btnBattle.addEventListener('click', () => wsSend({ type: 'start-battle' }));
  btnVsAI.addEventListener('click', toggleAI);
  btnRestart.addEventListener('click', () => { gameOverOvl.classList.remove('show'); cctx.clearRect(0, 0, confettiCvs.width, confettiCvs.height); startGame(); });
  btnBack.addEventListener('click', () => { wsSend({ type: 'leave-room' }); location.href = '/'; });
  window.addEventListener('resize', sizeCanvases);

  // ══════════════════════════════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════════════════════════════

  sizeCanvases();
  loadUserSkins();
  connect();
  requestAnimationFrame(gameLoop);

})();

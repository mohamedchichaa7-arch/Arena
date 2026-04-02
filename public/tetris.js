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
  const SKINS = {
    classic: { name: 'Classic', icon: '🎮', unlockScore: 0,      style: 'solid',
      colors: ['', '#06b6d4', '#eab308', '#a855f7', '#22c55e', '#ef4444', '#3b82f6', '#f97316', '#94a3b8'] },
    neon:    { name: 'Neon',    icon: '⚡',  unlockScore: 1000,   style: 'glow',
      colors: ['', '#00ffff', '#ffff00', '#ff00ff', '#00ff88', '#ff3366', '#66aaff', '#ff8800', '#aaaaaa'] },
    pastel:  { name: 'Pastel',  icon: '🌸', unlockScore: 5000,   style: 'soft',
      colors: ['', '#7ec8e3', '#ffe0a3', '#c3aed6', '#a8e6cf', '#ffb3b3', '#a3c4f3', '#ffd6a0', '#d4d4d4'] },
    retro:   { name: 'Retro',   icon: '👾', unlockScore: 15000,  style: 'flat',
      colors: ['', '#55cc22', '#ccaa00', '#aa33cc', '#22cc55', '#cc2233', '#2233cc', '#cc6600', '#888888'] },
    galaxy:  { name: 'Galaxy',  icon: '🌌', unlockScore: 30000,  style: 'gradient',
      colors: ['', '#818cf8', '#c084fc', '#f472b6', '#34d399', '#fb7185', '#60a5fa', '#fb923c', '#94a3b8'] },
    fire:    { name: 'Fire',    icon: '🔥', unlockScore: 75000,  style: 'glow',
      colors: ['', '#fbbf24', '#f97316', '#ef4444', '#fcd34d', '#b91c1c', '#fb923c', '#dc2626', '#6b6b6b'] },
    ice:     { name: 'Ice',     icon: '❄️',  unlockScore: 150000, style: 'soft',
      colors: ['', '#bae6fd', '#e0f2fe', '#c7d2fe', '#ccfbf1', '#dbeafe', '#a5f3fc', '#e0f7fa', '#f1f5f9'] },
  };

  let activeSkinColors = [...COLORS];
  let activeSkinStyle  = 'solid';
  let equippedSkinId   = 'classic';
  let unlockedSkins    = ['classic'];
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

  roomBadge.textContent = 'Room ' + roomId;

  // ══════════════════════════════════════════════════════════════════
  //  TETRIS ENGINE
  // ══════════════════════════════════════════════════════════════════
  class TetrisEngine {
    constructor() { this.reset(); }
    reset() { this.board = Array.from({ length: ROWS }, () => Array(COLS).fill(0)); this.piece = null; this.holdType = null; this.holdUsed = false; this.bag = []; this.score = 0; this.level = 1; this.lines = 0; this.combo = -1; this.state = 'idle'; this.dropCounter = 0; this.lockCounter = 0; this.lockLimit = 500; this.clearingRows = []; this.clearTimer = 0; this.pendingGarbage = 0; this.garbageSent = 0; this.lockedPiece = null; this.clearingStarted = false; this.lastClearInfo = null; }
    start() { this.reset(); this.state = 'playing'; this.spawnPiece(); }
    fillBag() { const b = [...TYPES]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1));[b[i], b[j]] = [b[j], b[i]]; } this.bag.push(...b); }
    nextType() { if (this.bag.length < 7) this.fillBag(); return this.bag.shift(); }
    peekNext(n) { while (this.bag.length < n + 7) this.fillBag(); return this.bag.slice(0, n); }
    spawnPiece() { const type = this.nextType(); this.piece = { type, colorIdx: COLOR_IDX[type], rotation: 0, shape: ROTATIONS[type][0], x: SPAWN_X[type], y: SPAWN_Y[type] }; this.lockCounter = 0; this.dropCounter = 0; this.holdUsed = false; if (this.collides(this.piece.shape, this.piece.x, this.piece.y)) this.state = 'gameover'; }
    collides(shape, ox, oy) { for (let r = 0; r < shape.length; r++)for (let c = 0; c < shape[r].length; c++) { if (!shape[r][c]) continue; const br = oy + r, bc = ox + c; if (bc < 0 || bc >= COLS || br >= ROWS) return true; if (br >= 0 && this.board[br][bc]) return true; } return false; }
    moveLeft() { if (!this.piece || this.state !== 'playing') return false; if (!this.collides(this.piece.shape, this.piece.x - 1, this.piece.y)) { this.piece.x--; this.lockCounter = 0; return true; } return false; }
    moveRight() { if (!this.piece || this.state !== 'playing') return false; if (!this.collides(this.piece.shape, this.piece.x + 1, this.piece.y)) { this.piece.x++; this.lockCounter = 0; return true; } return false; }
    moveDown() { if (!this.piece || this.state !== 'playing') return false; if (!this.collides(this.piece.shape, this.piece.x, this.piece.y + 1)) { this.piece.y++; return true; } return false; }
    softDrop() { if (this.moveDown()) { this.score += 1; return true; } return false; }
    hardDrop() { if (!this.piece || this.state !== 'playing') return 0; let d = 0; while (!this.collides(this.piece.shape, this.piece.x, this.piece.y + 1)) { this.piece.y++; d++; } this.score += d * 2; return this.lock(); }
    rotate(dir) { if (!this.piece || this.state !== 'playing') return false; const nr = (this.piece.rotation + dir + 4) % 4; const ns = ROTATIONS[this.piece.type][nr]; const kicks = this.piece.type === 'I' ? [[0, 0], [-2, 0], [1, 0], [-2, -1], [1, 2], [2, 0], [-1, 0], [2, 1], [-1, -2]] : [[0, 0], [-1, 0], [1, 0], [0, -1], [-1, -1], [1, -1], [0, 1], [-1, 1], [1, 1]]; for (const [dx, dy] of kicks) if (!this.collides(ns, this.piece.x + dx, this.piece.y + dy)) { this.piece.x += dx; this.piece.y += dy; this.piece.rotation = nr; this.piece.shape = ns; this.lockCounter = 0; return true; } return false; }
    doHold() { if (!this.piece || this.holdUsed || this.state !== 'playing') return; const t = this.piece.type; if (this.holdType) { const s = this.holdType; this.holdType = t; this.piece = { type: s, colorIdx: COLOR_IDX[s], rotation: 0, shape: ROTATIONS[s][0], x: SPAWN_X[s], y: SPAWN_Y[s] }; } else { this.holdType = t; this.spawnPiece(); } this.holdUsed = true; this.lockCounter = 0; }
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
      const flashColor = count >= 4 ? `rgba(251,191,36,${flash})` : count >= 3 ? `rgba(249,115,22,${flash})` : count >= 2 ? `rgba(6,182,212,${flash})` : `rgba(255,255,255,${flash})`;
      bctx.fillStyle = flashColor;
      for (const row of game.clearingRows) bctx.fillRect(0, row * cs, w, cs);
      // Shimmer effect on clearing rows
      if (progress > .3) {
        for (const row of game.clearingRows) {
          const shimGrad = bctx.createLinearGradient(0, row * cs, w, row * cs);
          shimGrad.addColorStop(0, 'transparent');
          shimGrad.addColorStop((progress - .3) % 1, 'rgba(255,255,255,.35)');
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
    if (style === 'glow') {
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
  //  PARTICLE & EFFECTS SYSTEM
  // ══════════════════════════════════════════════════════════════════

  const particles    = [];
  const floatingTexts = [];

  function spawnLockParticles(piece) {
    const color = activeSkinColors[piece.colorIdx] || activeSkinColors[1];
    for (let r = 0; r < piece.shape.length; r++) {
      for (let c = 0; c < piece.shape[r].length; c++) {
        if (!piece.shape[r][c]) continue;
        const br = piece.y + r; if (br < 0) continue;
        const px = (piece.x + c + .5) * cellSize, py = (br + .5) * cellSize;
        for (let i = 0; i < 5; i++) {
          const ang = Math.random() * Math.PI * 2, spd = Math.random() * 2.5 + .8;
          particles.push({ x: px, y: py, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - .5, color, size: Math.random() * 3.5 + 1.5, life: 1, decay: .05 + Math.random() * .04 });
        }
      }
    }
  }

  function spawnClearParticles(rows, count) {
    const palette = count >= 4
      ? ['#fbbf24', '#ef4444', '#a855f7', '#06b6d4', '#22c55e', '#f97316']
      : count >= 2 ? [activeSkinColors[1] || '#06b6d4', activeSkinColors[3] || '#a855f7'] : [activeSkinColors[1] || '#94a3b8'];
    const perCell = count >= 4 ? 7 : 4;
    for (const row of rows) {
      for (let c = 0; c < COLS; c++) {
        const px = (c + .5) * cellSize, py = (row + .5) * cellSize;
        for (let i = 0; i < perCell; i++) {
          const ang = Math.random() * Math.PI * 2, spd = Math.random() * (count >= 4 ? 7 : 4) + 1.5;
          particles.push({ x: px, y: py, vx: Math.cos(ang) * spd, vy: Math.sin(ang) * spd - 1.5, color: palette[Math.floor(Math.random() * palette.length)], size: Math.random() * 4 + 2, life: 1, decay: .022 + Math.random() * .018 });
        }
      }
    }
  }

  function spawnFloatingText(text, boardX, boardY, color) {
    floatingTexts.push({ text, x: boardX, y: boardY, vy: -1.4, life: 1, decay: .017, color: color || '#fbbf24', size: Math.max(11, cellSize * .75) });
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
      bctx.fillStyle = p.color;
      bctx.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
    }
    for (const t of floatingTexts) {
      bctx.globalAlpha = Math.max(0, t.life);
      bctx.font = `bold ${t.size}px Orbitron, sans-serif`;
      bctx.textAlign = 'center';
      bctx.shadowColor = t.color; bctx.shadowBlur = 8;
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
        const cx = COLS * cellSize / 2;
        const clearLabels = ['', 'SINGLE', 'DOUBLE', 'TRIPLE', 'TETRIS!'];
        const label = clearLabels[count] || `${count} LINES`;
        const color = count >= 4 ? '#fbbf24' : count >= 3 ? '#f97316' : '#06b6d4';
        spawnFloatingText(label, cx, ROWS * cellSize * .35, color);
        if (scoreGain > 0) spawnFloatingText(`+${scoreGain}`, cx, ROWS * cellSize * .45, '#a78bfa');
        if (combo > 0) spawnFloatingText(`COMBO \u00d7${combo + 1}`, cx, ROWS * cellSize * .55, '#22c55e');
        if (leveledUp) {
          boardCanvas.classList.add('level-up');
          setTimeout(() => boardCanvas.classList.remove('level-up'), 700);
          spawnFloatingText(`LEVEL ${g.level}!`, cx, ROWS * cellSize * .25, '#fbbf24');
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
      unlockedSkins = data.unlockedSkins || ['classic'];
      applySkin(data.equippedSkin || 'classic');
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
      item.innerHTML = `
        ${equipped ? '<div class="skin-item-badge">ON</div>' : ''}
        <span class="skin-item-icon">${skin.icon}</span>
        <div class="skin-item-name">${skin.name}</div>
        <div class="skin-preview">${swatches}</div>
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
      case 'garbage': game.addGarbage(msg.lines); break;
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
  function startGame() { game.start(); gameOverOvl.classList.remove('show'); statusEl.textContent = 'Playing!'; btnStart.disabled = true; if (aiActive) startAIEngine(); }
  function onGameOver() {
    game.state = 'gameover';
    if (inBattle) { wsSend({ type: 'game-over' }); statusEl.textContent = 'Game Over! Waiting…'; }
    else if (aiActive && aiEngine && aiEngine.state === 'playing') { goTitle.textContent = 'AI WINS!'; goScore.textContent = game.score; goLines.textContent = game.lines; goLevel.textContent = game.level; gameOverOvl.classList.add('show'); }
    else { goTitle.textContent = 'GAME OVER'; goScore.textContent = game.score; goLines.textContent = game.lines; goLevel.textContent = game.level; gameOverOvl.classList.add('show'); if (typeof reportScore === 'function') reportScore('tetris', game.score); }
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
      case 'ArrowLeft': game.moveLeft(); break;
      case 'ArrowRight': game.moveRight(); break;
      case 'ArrowDown': game.softDrop(); break;
      case 'ArrowUp': case 'x': case 'X': game.rotate(1); break;
      case 'z': case 'Z': game.rotate(-1); break;
      case ' ': { const g = game.hardDrop(); if (g > 0 && (inBattle || aiActive)) { if (inBattle) wsSend({ type: 'garbage', lines: g }); if (aiActive && aiEngine) aiEngine.addGarbage(g); } if (game.state === 'gameover') onGameOver(); break; }
      case 'c': case 'C': case 'Shift': game.doHold(); break;
    }
  }

  document.addEventListener('keydown', e => {
    if (game.state !== 'playing') return;
    const k = e.key; if (['ArrowLeft', 'ArrowRight', 'ArrowDown', 'ArrowUp', ' ', 'z', 'Z', 'x', 'X', 'c', 'C', 'Shift'].includes(k)) e.preventDefault();
    if (keys[k]) return; keys[k] = true; handleKey(k);
    if (['ArrowLeft', 'ArrowRight', 'ArrowDown'].includes(k)) { clearTimeout(dasTimer); clearInterval(dasTimer); dasKey = k; dasTimer = setTimeout(() => { dasTimer = setInterval(() => { if (keys[dasKey]) handleKey(dasKey); else { clearInterval(dasTimer); dasTimer = null; } }, DAS_REPEAT); }, DAS_DELAY); }
  });
  document.addEventListener('keyup', e => { keys[e.key] = false; if (e.key === dasKey) { clearTimeout(dasTimer); clearInterval(dasTimer); dasTimer = null; } });

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

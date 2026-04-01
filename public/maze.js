/* ═══════════════════════════════════════════════════════════════════
   MAZE RUNNER — Arena Room Client  |  maze.js
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  // ── URL / session ────────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  const myName = sessionStorage.getItem('arena-name') || 'Player';
  if (!roomId) { location.href = '/'; return; }

  // ── DOM refs ─────────────────────────────────────────────────────
  const $ = s => document.getElementById(s);
  const sizeSelect = $('sizeSelect');
  const speedRange = $('speedRange');
  const speedLabel = $('speedLabel');
  const btnGenerate = $('btnGenerate');
  const secretDot = $('secretDot');
  const btnRace = $('btnRace');
  const raceMode = $('raceMode');
  const btnVsAI = $('btnVsAI');
  const aiDifficulty = $('aiDifficulty');
  const statMoves = $('statMoves');
  const statTime = $('statTime');
  const statCells = $('statCells');
  const statusEl = $('status');
  const playerList = $('playerList');
  const playerCountEl = $('playerCount');
  const canvas = $('mazeCanvas');
  const ctx = canvas.getContext('2d');
  const winOverlay = $('winOverlay');
  const winTitle = winOverlay.querySelector('.win-title');
  const winTime = $('winTime');
  const winMoves = $('winMoves');
  const btnPlayAgain = $('btnPlayAgain');
  const countdownOverlay = $('countdownOverlay');
  const countdownText = $('countdownText');
  const countdownSub = $('countdownSub');
  const raceResultsOverlay = $('raceResultsOverlay');
  const raceResultsList = $('raceResultsList');
  const btnRaceClose = $('btnRaceClose');
  const confettiCanvas = $('confetti');
  const confettiCtx = confettiCanvas.getContext('2d');
  const roomBadge = $('roomBadge');
  const btnBack = $('btnBack');

  roomBadge.textContent = 'Room ' + roomId;

  // ── State ────────────────────────────────────────────────────────
  let ws = null, myId = null;
  const others = new Map();       // id → { name, state, el, canvas }
  let inRace = false, raceFinished = false;

  // ── AI state ─────────────────────────────────────────────────────
  const AI_ID = '__ai__';
  let aiActive = false, aiPath = [], aiStep = 0, aiPos = { r: 0, c: 0 };
  let aiTimer = null, aiElapsed = 0, aiTimerStart = null, aiMoves = 0, aiDone = false;
  const AI_PROFILES = {
    easy: { msPerStep: 520, mistakeRate: 0.30 },
    medium: { msPerStep: 220, mistakeRate: 0.10 },
    hard: { msPerStep: 90, mistakeRate: 0.02 },
    godlike: { msPerStep: 28, mistakeRate: 0.00 },
  };

  // ── Maze state ───────────────────────────────────────────────────
  let rows = 15, cols = 15, cellSize = 20;
  let grid = null;
  let player = { r: 0, c: 0 }, goal = { r: 0, c: 0 };
  let moves = 0, elapsed = 0;
  let timerStart = null, timerInterval = null;
  let gameState = 'idle';          // idle | generating | playing | won
  let genAbort = false;
  let visited = new Set();
  let solutionPath = null, showSolution = false;
  let recentlyRemoved = [];
  let stateThrottle = null;

  // ══════════════════════════════════════════════════════════════════
  //  UTILITIES
  // ══════════════════════════════════════════════════════════════════

  function mulberry32(seed) {
    return () => {
      seed |= 0; seed = seed + 0x6D2B79F5 | 0;
      let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
      t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
      return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
  }
  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function fmtTime(sec) { const m = Math.floor(sec / 60); return m + ':' + String(sec % 60).padStart(2, '0'); }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  function shuffleWith(arr, rng) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }
  function encodeGrid(g, R, C) {
    const d = new Array(R * C);
    for (let r = 0; r < R; r++)
      for (let c = 0; c < C; c++) {
        const cl = g[r][c];
        d[r * C + c] = (cl.top ? 1 : 0) | (cl.right ? 2 : 0) | (cl.bottom ? 4 : 0) | (cl.left ? 8 : 0);
      }
    return d;
  }

  // ══════════════════════════════════════════════════════════════════
  //  UNION-FIND
  // ══════════════════════════════════════════════════════════════════

  class UF {
    constructor(n) { this.p = new Int32Array(n); this.rk = new Int32Array(n); for (let i = 0; i < n; i++) this.p[i] = i; }
    find(x) { while (this.p[x] !== x) { this.p[x] = this.p[this.p[x]]; x = this.p[x]; } return x; }
    union(a, b) {
      a = this.find(a); b = this.find(b); if (a === b) return false;
      if (this.rk[a] < this.rk[b]) [a, b] = [b, a];
      this.p[b] = a; if (this.rk[a] === this.rk[b]) this.rk[a]++; return true;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  CANVAS SIZING
  // ══════════════════════════════════════════════════════════════════

  function computeSize() {
    const sidebar = 270;
    const maxW = Math.min(window.innerWidth - sidebar - 60, 580);
    const maxH = window.innerHeight - 260;
    const maxDim = Math.max(200, Math.min(maxW, maxH));
    cellSize = Math.floor(maxDim / cols);
    const dpr = window.devicePixelRatio || 1;
    const logW = cols * cellSize + 2, logH = rows * cellSize + 2;
    canvas.width = logW * dpr; canvas.height = logH * dpr;
    canvas.style.width = logW + 'px'; canvas.style.height = logH + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  // ══════════════════════════════════════════════════════════════════
  //  MAZE GENERATION  (Kruskal's, optionally seeded)
  // ══════════════════════════════════════════════════════════════════

  function initGrid() {
    grid = [];
    for (let r = 0; r < rows; r++) {
      grid[r] = [];
      for (let c = 0; c < cols; c++) grid[r][c] = { top: true, right: true, bottom: true, left: true };
    }
  }

  function buildWalls(rng) {
    const w = [];
    for (let r = 0; r < rows; r++)
      for (let c = 0; c < cols; c++) {
        if (c < cols - 1) w.push({ r1: r, c1: c, r2: r, c2: c + 1 });
        if (r < rows - 1) w.push({ r1: r, c1: c, r2: r + 1, c2: c });
      }
    shuffleWith(w, rng);
    return w;
  }

  function removeWall(r1, c1, r2, c2) {
    if (r1 === r2) {
      if (c2 === c1 + 1) { grid[r1][c1].right = false; grid[r2][c2].left = false; }
      else { grid[r1][c1].left = false; grid[r2][c2].right = false; }
    } else {
      if (r2 === r1 + 1) { grid[r1][c1].bottom = false; grid[r2][c2].top = false; }
      else { grid[r1][c1].top = false; grid[r2][c2].bottom = false; }
    }
  }

  async function generateMaze(size, speed, seed) {
    genAbort = true; await sleep(30); genAbort = false;
    stopTimer(); stopAI();
    aiPos = { r: 0, c: 0 }; aiStep = 0; aiMoves = 0; aiElapsed = 0; aiDone = false;
    showSolution = false; solutionPath = null;
    visited.clear(); recentlyRemoved = [];
    moves = 0; elapsed = 0;

    rows = cols = size || parseInt(sizeSelect.value);
    computeSize(); initGrid();

    const rng = seed != null ? mulberry32(seed) : mulberry32(Math.floor(Math.random() * 2147483647));
    const walls = buildWalls(rng);
    const uf = new UF(rows * cols);

    player = { r: 0, c: 0 };
    goal = { r: rows - 1, c: cols - 1 };
    gameState = 'generating';
    updateUI(); draw(); broadcastState();

    const spd = speed || parseInt(speedRange.value);
    const perBatch = Math.max(1, Math.floor(spd / 5));
    const delay = Math.max(1, Math.floor(120 - spd * 1.15));

    let wi = 0, removed = 0;
    const need = rows * cols - 1;
    while (wi < walls.length && removed < need) {
      if (genAbort) return;
      let done = 0;
      while (done < perBatch && wi < walls.length && removed < need) {
        const w = walls[wi++];
        if (uf.union(w.r1 * cols + w.c1, w.r2 * cols + w.c2)) {
          removeWall(w.r1, w.c1, w.r2, w.c2);
          removed++; recentlyRemoved.push({ ...w, alpha: 1 }); done++;
        }
      }
      recentlyRemoved = recentlyRemoved.map(r => ({ ...r, alpha: r.alpha - 0.15 })).filter(r => r.alpha > 0);
      draw(); throttledBroadcast();
      await sleep(delay);
    }
    recentlyRemoved = [];
    gameState = 'playing';
    startTimer(); draw(); broadcastState(); updateUI();
    if (aiActive) startAI();
  }

  // ══════════════════════════════════════════════════════════════════
  //  PLAYER MOVEMENT
  // ══════════════════════════════════════════════════════════════════

  function movePlayer(dr, dc) {
    if (gameState !== 'playing') return;
    const nr = player.r + dr, nc = player.c + dc;
    if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) return;
    const c = grid[player.r][player.c];
    if (dr === -1 && c.top) return; if (dr === 1 && c.bottom) return;
    if (dc === -1 && c.left) return; if (dc === 1 && c.right) return;
    player.r = nr; player.c = nc; moves++;
    visited.add(nr + ',' + nc);
    draw(); broadcastState(); updateUI();
    if (player.r === goal.r && player.c === goal.c) winGame();
  }

  function winGame() {
    gameState = 'won'; stopTimer(); stopAI();
    draw(); broadcastState(); updateUI();
    if (inRace && !raceFinished) {
      raceFinished = true;
      wsSend({ type: 'race-finish', time: elapsed, moves });
      statusEl.textContent = 'Finished! Waiting for others…';
    } else if (aiActive && !aiDone) {
      winOverlay.classList.add('show');
      winTime.textContent = fmtTime(elapsed);
      winMoves.textContent = moves;
      statusEl.textContent = 'You beat the AI!';
      launchConfetti();
    } else {
      winOverlay.classList.add('show');
      winTime.textContent = fmtTime(elapsed);
      winMoves.textContent = moves;
      launchConfetti();
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  AI ENGINE
  // ══════════════════════════════════════════════════════════════════

  function bfsSolve(fromR, fromC, toR, toC) {
    const prev = Array.from({ length: rows }, () => Array(cols).fill(null));
    const vis = Array.from({ length: rows }, () => Array(cols).fill(false));
    const q = [[fromR, fromC]]; vis[fromR][fromC] = true;
    const dirs = [[-1, 0, 'top'], [1, 0, 'bottom'], [0, -1, 'left'], [0, 1, 'right']];
    while (q.length) {
      const [r, c] = q.shift();
      if (r === toR && c === toC) break;
      for (const [dr, dc, wn] of dirs) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
        if (vis[nr][nc] || grid[r][c][wn]) continue;
        vis[nr][nc] = true; prev[nr][nc] = [r, c]; q.push([nr, nc]);
      }
    }
    const path = []; let cur = [toR, toC];
    while (cur) { path.unshift(cur); cur = prev[cur[0]][cur[1]]; }
    return path;
  }

  function buildAIPath(difficulty) {
    const profile = AI_PROFILES[difficulty] || AI_PROFILES.medium;
    const base = bfsSolve(0, 0, goal.r, goal.c);
    if (!profile.mistakeRate) return base;
    const result = [];
    const dirs = [[-1, 0, 'top'], [1, 0, 'bottom'], [0, -1, 'left'], [0, 1, 'right']];
    for (let i = 0; i < base.length - 1; i++) {
      result.push(base[i]);
      if (Math.random() < profile.mistakeRate) {
        const [r, c] = base[i];
        const nexts = base[i + 1];
        for (const [dr, dc, wn] of dirs) {
          const nr = r + dr, nc = c + dc;
          if (nr < 0 || nr >= rows || nc < 0 || nc >= cols) continue;
          if (grid[r][c][wn]) continue;
          if (nr === nexts[0] && nc === nexts[1]) continue;
          const detourLen = 1 + Math.floor(Math.random() * 3);
          result.push([nr, nc]);
          for (let d = 1; d < detourLen; d++) {
            const [cr, cc] = result[result.length - 1];
            const opts = [];
            for (const [ddr, ddc, wwn] of dirs) {
              const nnr = cr + ddr, nnc = cc + ddc;
              if (nnr < 0 || nnr >= rows || nnc < 0 || nnc >= cols) continue;
              if (!grid[cr][cc][wwn]) opts.push([nnr, nnc]);
            }
            if (opts.length) result.push(opts[Math.floor(Math.random() * opts.length)]);
          }
          const [lr, lc] = result[result.length - 1];
          const toNext = bfsSolve(lr, lc, nexts[0], nexts[1]);
          for (let k = 1; k < toNext.length; k++) result.push(toNext[k]);
          break;
        }
      }
    }
    result.push(base[base.length - 1]);
    return result;
  }

  function startAI() {
    stopAI();
    if (!grid || gameState !== 'playing') return;
    const diff = aiDifficulty.value;
    const profile = AI_PROFILES[diff] || AI_PROFILES.medium;
    aiPos = { r: 0, c: 0 }; aiStep = 0; aiMoves = 0; aiDone = false;
    aiTimerStart = Date.now(); aiPath = buildAIPath(diff);
    ensureAICard(); updateAICard();
    aiTimer = setInterval(() => {
      if (aiDone || gameState !== 'playing') return;
      aiStep++;
      if (aiStep >= aiPath.length) {
        aiPos = { r: goal.r, c: goal.c }; aiDone = true;
        aiElapsed = Math.floor((Date.now() - aiTimerStart) / 1000);
        clearInterval(aiTimer); aiTimer = null;
        updateAICard(); draw();
        if (gameState === 'playing') {
          gameState = 'won'; stopTimer(); draw(); broadcastState(); updateUI();
          statusEl.textContent = 'AI wins! Better luck next time.';
          winTime.textContent = fmtTime(elapsed);
          winMoves.textContent = moves;
          winTitle.textContent = 'AI WINS!';
          winOverlay.classList.add('show');
          setTimeout(() => { winTitle.textContent = 'YOU WIN!'; }, 100);
        }
        return;
      }
      const [nr, nc] = aiPath[aiStep];
      aiPos = { r: nr, c: nc }; aiMoves++;
      aiElapsed = Math.floor((Date.now() - aiTimerStart) / 1000);
      updateAICard(); draw();
    }, profile.msPerStep);
  }

  function stopAI() { if (aiTimer) { clearInterval(aiTimer); aiTimer = null; } }

  function toggleAI() {
    aiActive = !aiActive;
    if (aiActive) {
      btnVsAI.textContent = 'Stop AI'; ensureAICard();
      if (gameState === 'playing') startAI();
    } else {
      btnVsAI.textContent = 'VS AI'; stopAI(); removeAICard(); updatePlayerCount(); draw();
    }
  }

  function ensureAICard() {
    if (document.querySelector(`.player-card[data-id="${AI_ID}"]`)) return;
    const diff = aiDifficulty.value;
    const label = diff.charAt(0).toUpperCase() + diff.slice(1);
    const card = document.createElement('div');
    card.className = 'player-card ai';
    card.dataset.id = AI_ID;
    card.innerHTML = `
    <div class="pc-header">
      <span class="pc-dot" style="background:#ef4444"></span>
      <span class="pc-name">CPU (${escapeHtml(label)})</span>
      <span class="pc-timer">0:00</span>
    </div>
    <div class="mini-maze-wrap"><canvas width="150" height="150"></canvas></div>
  `;
    playerList.appendChild(card);
    updatePlayerCount();
  }
  function removeAICard() { const c = document.querySelector(`.player-card[data-id="${AI_ID}"]`); if (c) c.remove(); }

  function updateAICard() {
    const card = document.querySelector(`.player-card[data-id="${AI_ID}"]`);
    if (!card || !grid) return;
    const timer = card.querySelector('.pc-timer');
    if (aiDone) { timer.textContent = 'Done ' + fmtTime(aiElapsed); timer.classList.add('pc-finish'); }
    else { timer.textContent = fmtTime(aiElapsed); timer.classList.remove('pc-finish'); }
    const miniCvs = card.querySelector('canvas');
    drawMiniMaze(miniCvs, encodeGrid(grid, rows, cols), rows, cols, aiPos, aiDone ? 'won' : 'playing');
  }

  // ══════════════════════════════════════════════════════════════════
  //  SOLVER & TIMER
  // ══════════════════════════════════════════════════════════════════

  function solve() { if (gameState !== 'playing') return; solutionPath = bfsSolve(player.r, player.c, goal.r, goal.c); showSolution = !showSolution; draw(); }

  function startTimer() {
    timerStart = Date.now();
    timerInterval = setInterval(() => { elapsed = Math.floor((Date.now() - timerStart) / 1000); statTime.textContent = fmtTime(elapsed); }, 250);
  }
  function stopTimer() { if (timerInterval) { clearInterval(timerInterval); timerInterval = null; } if (timerStart) elapsed = Math.floor((Date.now() - timerStart) / 1000); }

  // ══════════════════════════════════════════════════════════════════
  //  RENDERING — Main Canvas
  // ══════════════════════════════════════════════════════════════════

  function draw() {
    const w = canvas.width, h = canvas.height;
    ctx.clearRect(0, 0, w, h);
    const bg = ctx.createLinearGradient(0, 0, w, h);
    bg.addColorStop(0, '#0f0f2e'); bg.addColorStop(1, '#0a0a1a');
    ctx.fillStyle = bg; ctx.fillRect(0, 0, w, h);
    if (!grid) return;
    const cs = cellSize, off = 1;

    // Visited tint
    for (const key of visited) {
      const [vr, vc] = key.split(',').map(Number);
      ctx.fillStyle = 'rgba(124,58,237,0.06)';
      ctx.fillRect(off + vc * cs, off + vr * cs, cs, cs);
    }
    // Gen flash
    for (const item of recentlyRemoved) {
      const cx = off + ((item.c1 + item.c2) / 2) * cs + cs / 2, cy = off + ((item.r1 + item.r2) / 2) * cs + cs / 2;
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, cs * 1.2);
      g.addColorStop(0, `rgba(6,182,212,${0.3 * item.alpha})`); g.addColorStop(1, 'transparent');
      ctx.fillStyle = g; ctx.fillRect(cx - cs * 1.2, cy - cs * 1.2, cs * 2.4, cs * 2.4);
    }
    // Solution
    if (showSolution && solutionPath) {
      ctx.strokeStyle = 'rgba(6,182,212,0.35)'; ctx.lineWidth = cs * 0.3;
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath();
      for (let i = 0; i < solutionPath.length; i++) {
        const [sr, sc] = solutionPath[i];
        const sx = off + sc * cs + cs / 2, sy = off + sr * cs + cs / 2;
        i === 0 ? ctx.moveTo(sx, sy) : ctx.lineTo(sx, sy);
      }
      ctx.stroke();
    }

    // Walls — HD multi-pass
    const wallW = Math.max(1.5, cs * 0.13);
    function strokeAllWalls() {
      ctx.beginPath();
      for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
        const x = off + c * cs, y = off + r * cs, cl = grid[r][c];
        if (cl.top) { ctx.moveTo(x, y); ctx.lineTo(x + cs, y); }
        if (cl.right) { ctx.moveTo(x + cs, y); ctx.lineTo(x + cs, y + cs); }
        if (cl.bottom) { ctx.moveTo(x, y + cs); ctx.lineTo(x + cs, y + cs); }
        if (cl.left) { ctx.moveTo(x, y); ctx.lineTo(x, y + cs); }
      }
      ctx.stroke();
    }
    ctx.lineCap = 'square'; ctx.lineJoin = 'miter';
    ctx.strokeStyle = 'rgba(91,33,182,0.22)'; ctx.lineWidth = wallW * 5;
    ctx.shadowColor = 'rgba(124,58,237,0.5)'; ctx.shadowBlur = cs * 0.7; strokeAllWalls();
    ctx.strokeStyle = 'rgba(124,58,237,0.55)'; ctx.lineWidth = wallW * 2.5; ctx.shadowBlur = cs * 0.3; strokeAllWalls();
    ctx.strokeStyle = '#6d28d9'; ctx.lineWidth = wallW; ctx.shadowBlur = 0; strokeAllWalls();
    ctx.strokeStyle = 'rgba(167,139,250,0.45)'; ctx.lineWidth = wallW * 0.3; strokeAllWalls();
    ctx.shadowBlur = 0;

    // Goal
    {
      const gx = off + goal.c * cs + cs / 2, gy = off + goal.r * cs + cs / 2, gr = cs * 0.6;
      const gg = ctx.createRadialGradient(gx, gy, 0, gx, gy, gr);
      gg.addColorStop(0, 'rgba(245,158,11,0.35)'); gg.addColorStop(1, 'transparent');
      ctx.fillStyle = gg; ctx.fillRect(gx - gr, gy - gr, gr * 2, gr * 2);
      ctx.fillStyle = '#f59e0b'; ctx.shadowColor = '#fbbf24'; ctx.shadowBlur = 10;
      drawStar(ctx, gx, gy, cs * 0.22, cs * 0.1, 5); ctx.shadowBlur = 0;
    }

    // AI dot
    if (aiActive && (gameState === 'playing' || gameState === 'won')) {
      const ax = off + aiPos.c * cs + cs / 2, ay = off + aiPos.r * cs + cs / 2, ar = cs * 0.28;
      const ag = ctx.createRadialGradient(ax, ay, 0, ax, ay, cs * 0.6);
      ag.addColorStop(0, 'rgba(248,113,113,0.25)'); ag.addColorStop(1, 'transparent');
      ctx.fillStyle = ag; ctx.beginPath(); ctx.arc(ax, ay, cs * 0.6, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#ef4444'; ctx.shadowColor = '#f87171'; ctx.shadowBlur = 10;
      ctx.beginPath(); ctx.arc(ax, ay, ar, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.25)'; ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(ax - ar * 0.25, ay - ar * 0.25, ar * 0.4, 0, Math.PI * 2); ctx.fill();
    }

    // Player
    if (gameState === 'playing' || gameState === 'won') {
      const px = off + player.c * cs + cs / 2, py = off + player.r * cs + cs / 2, pr = cs * 0.32;
      const pg = ctx.createRadialGradient(px, py, 0, px, py, cs * 0.7);
      pg.addColorStop(0, 'rgba(52,211,153,0.3)'); pg.addColorStop(1, 'transparent');
      ctx.fillStyle = pg; ctx.beginPath(); ctx.arc(px, py, cs * 0.7, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#34d399'; ctx.shadowColor = '#6ee7b7'; ctx.shadowBlur = 12;
      ctx.beginPath(); ctx.arc(px, py, pr, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,0.3)'; ctx.shadowBlur = 0;
      ctx.beginPath(); ctx.arc(px - pr * 0.25, py - pr * 0.25, pr * 0.4, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawStar(c, cx, cy, outer, inner, pts) {
    c.beginPath();
    for (let i = 0; i < pts * 2; i++) {
      const r = i % 2 === 0 ? outer : inner;
      const a = (Math.PI * i) / pts - Math.PI / 2;
      i === 0 ? c.moveTo(cx + r * Math.cos(a), cy + r * Math.sin(a)) : c.lineTo(cx + r * Math.cos(a), cy + r * Math.sin(a));
    }
    c.closePath(); c.fill();
  }

  // ══════════════════════════════════════════════════════════════════
  //  MINI-MAZE RENDERING
  // ══════════════════════════════════════════════════════════════════

  function drawMiniMaze(cvs, data, R, C, pl, gs) {
    const c = cvs.getContext('2d'); const w = cvs.width, h = cvs.height;
    c.clearRect(0, 0, w, h); c.fillStyle = '#0f0f2e'; c.fillRect(0, 0, w, h);
    if (!data || !R) return;
    const cs = Math.floor(Math.min(w, h) / Math.max(R, C));
    const ox = Math.floor((w - C * cs) / 2), oy = Math.floor((h - R * cs) / 2);
    c.strokeStyle = '#3b0f82'; c.lineWidth = Math.max(1, cs * 0.15);
    for (let r = 0; r < R; r++) for (let col = 0; col < C; col++) {
      const v = data[r * C + col], x = ox + col * cs, y = oy + r * cs;
      c.beginPath();
      if (v & 1) { c.moveTo(x, y); c.lineTo(x + cs, y); }
      if (v & 2) { c.moveTo(x + cs, y); c.lineTo(x + cs, y + cs); }
      if (v & 4) { c.moveTo(x, y + cs); c.lineTo(x + cs, y + cs); }
      if (v & 8) { c.moveTo(x, y); c.lineTo(x, y + cs); }
      c.stroke();
    }
    // Goal
    const gx = ox + (C - 1) * cs + cs / 2, gy = oy + (R - 1) * cs + cs / 2;
    c.fillStyle = '#f59e0b'; c.beginPath(); c.arc(gx, gy, Math.max(2, cs * 0.28), 0, Math.PI * 2); c.fill();
    // Player
    if (pl && (gs === 'playing' || gs === 'won')) {
      c.fillStyle = '#34d399'; c.shadowColor = '#6ee7b7'; c.shadowBlur = 4;
      c.beginPath(); c.arc(ox + pl.c * cs + cs / 2, oy + pl.r * cs + cs / 2, Math.max(2, cs * 0.28), 0, Math.PI * 2); c.fill();
      c.shadowBlur = 0;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  NETWORK  (WebSocket)
  // ══════════════════════════════════════════════════════════════════

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      // Join room with our name
      wsSend({ type: 'join-room', roomId, name: myName });
    };
    ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch { } };
    ws.onclose = () => { statusEl.textContent = 'Disconnected. Returning to lobby…'; setTimeout(() => location.href = '/', 3000); };
  }

  function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  function broadcastState() {
    wsSend({
      type: 'state', data: {
        grid: grid ? encodeGrid(grid, rows, cols) : null,
        rows, cols, player: { ...player }, moves, time: elapsed, gameState
      }
    });
  }

  function throttledBroadcast() {
    if (stateThrottle) return;
    const spd = parseInt(speedRange.value);
    const ms = Math.max(16, Math.round(180 - spd * 1.6));
    stateThrottle = setTimeout(() => { stateThrottle = null; broadcastState(); }, ms);
  }

  function handleMsg(msg) {
    switch (msg.type) {
      case 'room-joined':
        myId = 'self';     // we don't get a numeric id from room-joined, use marker
        addPlayerCard('self', myName, true);
        for (const p of msg.players) {
          addPlayerCard(p.id, p.name, false);
          if (p.state) updateOtherState(p.id, p.state);
        }
        updatePlayerCount();
        statusEl.textContent = 'Press Generate to create a maze';
        generateMaze();
        break;

      case 'player-joined':
        addPlayerCard(msg.id, msg.name, false);
        updatePlayerCount();
        break;

      case 'player-left':
        removePlayerCard(msg.id);
        updatePlayerCount();
        break;

      case 'player-state':
        updateOtherState(msg.id, msg.data);
        break;

      case 'race-countdown':
        inRace = true; raceFinished = false;
        countdownOverlay.classList.add('show');
        countdownText.textContent = msg.count;
        countdownSub.textContent = msg.mode === 'same' ? 'Same map race' : 'Individual map race';
        break;

      case 'race-go':
        countdownOverlay.classList.remove('show');
        winOverlay.classList.remove('show');
        raceResultsOverlay.classList.remove('show');
        statusEl.textContent = 'RACE! Go go go!';
        generateMaze(msg.size, msg.speed, msg.mode === 'same' ? msg.seed : null);
        break;

      case 'race-player-finish':
        updateRaceRank(msg.id, msg.rank, msg.time);
        break;

      case 'race-results':
        inRace = false;
        showRaceResults(msg.rankings);
        break;

      case 'error':
        statusEl.textContent = msg.msg;
        break;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  SIDEBAR — Player Cards (compact, side-by-side)
  // ══════════════════════════════════════════════════════════════════

  const PALETTE = ['#34d399', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#fb923c', '#2dd4bf', '#e879f9'];
  let colorIdx = 0;
  function nextColor() { return PALETTE[colorIdx++ % PALETTE.length]; }

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
      <span class="pc-timer">0:00</span>
    </div>
    <div class="mini-maze-wrap"><canvas width="150" height="150"></canvas></div>
  `;
    playerList.appendChild(card);
    if (!isMe) {
      others.set(id, { name, state: null, el: card, canvas: card.querySelector('canvas') });
    }
  }

  function removePlayerCard(id) {
    const p = others.get(id);
    if (p) { p.el.remove(); others.delete(id); }
  }

  function updatePlayerCount() {
    const ai = document.querySelector(`.player-card[data-id="${AI_ID}"]`) ? 1 : 0;
    playerCountEl.textContent = 1 + others.size + ai;
  }

  function updateMyCard() {
    const card = document.querySelector('.player-card[data-id="self"]');
    if (!card) return;
    const timer = card.querySelector('.pc-timer');
    timer.textContent = fmtTime(elapsed);
    if (gameState === 'won') { timer.classList.add('pc-finish'); }
    else { timer.classList.remove('pc-finish'); }
    const cvs = card.querySelector('canvas');
    if (grid) drawMiniMaze(cvs, encodeGrid(grid, rows, cols), rows, cols, player, gameState);
  }

  function updateOtherState(id, data) {
    const p = others.get(id);
    if (!p) return;
    p.state = data;
    const timer = p.el.querySelector('.pc-timer');
    timer.textContent = fmtTime(data.time);
    if (data.gameState === 'won') timer.classList.add('pc-finish');
    else timer.classList.remove('pc-finish');
    if (data.grid) drawMiniMaze(p.canvas, data.grid, data.rows, data.cols, data.player, data.gameState);
  }

  function updateRaceRank(id, rank, time) {
    const card = id === 'self'
      ? document.querySelector('.player-card[data-id="self"]')
      : others.get(id)?.el;
    if (!card) return;
    let tag = card.querySelector('.pc-rank');
    if (!tag) { tag = document.createElement('span'); tag.className = 'pc-rank'; card.querySelector('.pc-header').appendChild(tag); }
    tag.textContent = '#' + rank;
    tag.style.cssText = 'font-family:Orbitron,sans-serif;font-size:.5rem;font-weight:700;color:#fbbf24;margin-left:auto';
  }

  // ══════════════════════════════════════════════════════════════════
  //  RACE MODE
  // ══════════════════════════════════════════════════════════════════

  function startRace() {
    wsSend({ type: 'start-race', mode: raceMode.value, size: parseInt(sizeSelect.value), speed: parseInt(speedRange.value) });
  }

  function showRaceResults(rankings) {
    raceResultsList.innerHTML = '';
    for (const r of rankings) {
      const cls = r.rank === 1 ? 'gold' : r.rank === 2 ? 'silver' : r.rank === 3 ? 'bronze' : '';
      const row = document.createElement('div');
      row.className = 'result-row ' + cls;
      row.innerHTML = `
      <span class="result-rank">#${r.rank}</span>
      <span>${escapeHtml(r.name)}</span>
      <span style="margin-left:auto;font-family:Orbitron,sans-serif;font-size:.7rem;color:var(--accent)">${fmtTime(r.time)} · ${r.moves} moves</span>
    `;
      raceResultsList.appendChild(row);
    }
    raceResultsOverlay.classList.add('show');
    document.querySelectorAll('.pc-rank').forEach(el => el.remove());
  }

  // ══════════════════════════════════════════════════════════════════
  //  UI UPDATES
  // ══════════════════════════════════════════════════════════════════

  function updateUI() {
    statMoves.textContent = moves;
    statTime.textContent = fmtTime(elapsed);
    statCells.textContent = rows * cols;
    if (gameState === 'generating') { statusEl.textContent = 'Generating maze…'; btnGenerate.disabled = true; }
    else if (gameState === 'playing') { statusEl.textContent = 'Navigate to the golden star!'; btnGenerate.disabled = false; }
    else if (gameState === 'won') { statusEl.textContent = 'Maze Complete!'; btnGenerate.disabled = false; }
    else btnGenerate.disabled = false;
    updateMyCard();
  }

  // ══════════════════════════════════════════════════════════════════
  //  CONFETTI
  // ══════════════════════════════════════════════════════════════════

  function launchConfetti() {
    confettiCanvas.width = window.innerWidth;
    confettiCanvas.height = window.innerHeight;
    const particles = [];
    const colors = ['#7c3aed', '#06b6d4', '#f59e0b', '#34d399', '#ef4444', '#ec4899', '#a78bfa', '#fbbf24'];
    for (let i = 0; i < 180; i++) {
      particles.push({
        x: Math.random() * confettiCanvas.width, y: Math.random() * confettiCanvas.height - confettiCanvas.height,
        vx: (Math.random() - 0.5) * 6, vy: Math.random() * 4 + 2,
        size: Math.random() * 8 + 3, color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360, rotSpeed: (Math.random() - 0.5) * 10, life: 1
      });
    }
    let frame = 0;
    function anim() {
      confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
      let alive = false;
      for (const p of particles) {
        if (p.life <= 0) continue; alive = true;
        p.x += p.vx; p.y += p.vy; p.vy += 0.08; p.rotation += p.rotSpeed;
        if (frame > 70) p.life -= 0.015;
        confettiCtx.save(); confettiCtx.translate(p.x, p.y);
        confettiCtx.rotate(p.rotation * Math.PI / 180); confettiCtx.globalAlpha = Math.max(0, p.life);
        confettiCtx.fillStyle = p.color; confettiCtx.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
        confettiCtx.restore();
      }
      frame++;
      if (alive) requestAnimationFrame(anim);
      else confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height);
    }
    anim();
  }

  // ══════════════════════════════════════════════════════════════════
  //  EVENT LISTENERS
  // ══════════════════════════════════════════════════════════════════

  btnGenerate.addEventListener('click', () => generateMaze());
  secretDot.addEventListener('click', solve);
  btnRace.addEventListener('click', startRace);
  btnVsAI.addEventListener('click', toggleAI);
  speedRange.addEventListener('input', () => { speedLabel.textContent = speedRange.value; });
  btnPlayAgain.addEventListener('click', () => { winOverlay.classList.remove('show'); confettiCtx.clearRect(0, 0, confettiCanvas.width, confettiCanvas.height); generateMaze(); });
  btnRaceClose.addEventListener('click', () => { raceResultsOverlay.classList.remove('show'); });
  btnBack.addEventListener('click', () => { wsSend({ type: 'leave-room' }); location.href = '/'; });

  document.addEventListener('keydown', e => {
    switch (e.key) {
      case 'ArrowUp': e.preventDefault(); movePlayer(-1, 0); break;
      case 'ArrowDown': e.preventDefault(); movePlayer(1, 0); break;
      case 'ArrowLeft': e.preventDefault(); movePlayer(0, -1); break;
      case 'ArrowRight': e.preventDefault(); movePlayer(0, 1); break;
    }
  });

  window.addEventListener('resize', () => { if (rows && cols && grid) { computeSize(); draw(); } });

  // ══════════════════════════════════════════════════════════════════
  //  INIT — connect immediately
  // ══════════════════════════════════════════════════════════════════

  connect();

})();

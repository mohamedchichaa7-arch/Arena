/* ═══════════════════════════════════════════════════════════════════
   COMPETITIVE MINESWEEPER — Arena Room Client  |  minesweeper.js
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  const myName = sessionStorage.getItem('arena-name') || 'Player';
  if (!roomId) { location.href = '/'; return; }

  const $ = s => document.getElementById(s);
  const statusEl = $('status'), playerListEl = $('playerList');
  const roomBadge = $('roomBadge'), btnBack = $('btnBack'), btnStart = $('btnStart');
  const timerDisplay = $('timerDisplay');
  const boardEl = $('board'), boardWrap = $('boardWrap');
  const stunOverlay = $('stunOverlay'), stunTimer = $('stunTimer');
  const frenzyGlow = $('frenzyGlow');
  const powerupBar = $('powerupBar'), chargeCount = $('chargeCount');
  const resultOverlay = $('resultOverlay'), resultTitle = $('resultTitle'), finalScoresEl = $('finalScores');
  const rulesOverlay = $('rulesOverlay');
  const gameSettings = $('gameSettings');

  roomBadge.textContent = 'Room ' + roomId;

  const PLAYER_COLORS = ['#ef4444','#3b82f6','#22c55e','#f59e0b'];
  const PLAYER_TINTS = ['rgba(239,68,68,.08)','rgba(59,130,246,.08)','rgba(34,197,94,.08)','rgba(245,158,11,.08)'];
  const NUM_CLASSES = ['','n1','n2','n3','n4','n5','n6','n7','n8'];

  let ws = null, myId = null;
  const others = new Map();
  let boardSize = 20, mineCount = 0;
  let cells = []; // 2D array of DOM elements
  let cellState = []; // 2D: { revealed, revealedBy, flaggedBy, adjacent, mine }
  let playersData = {}; // pid -> { name, colorIdx, score, flags, charges }
  let myCharges = 0, myFlags = 10, myShield = false;
  let targeting = null; // powerup targeting mode
  let gameActive = false;
  let timeLimit = 0, startedAt = 0;
  let stunUntilTime = 0;
  let frenzyUntilTime = 0;
  let scannerMines = []; // temp flashing mines visible to me
  let scannerTimeout = null;
  let playersInfo = []; // from start msg

  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ── Network ──────────────────────────────────────────────────
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      const password = sessionStorage.getItem('arena-room-password') || undefined;
      sessionStorage.removeItem('arena-room-password');
      wsSend({ type: 'join-room', roomId, name: myName, password, token: sessionStorage.getItem('arena-token') || '' });
    };
    ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => {
      statusEl.textContent = 'Disconnected. Returning to lobby…';
      setTimeout(() => location.href = '/', 3000);
    };
  }
  function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  function handleMsg(msg) {
    switch (msg.type) {
      case 'room-joined':
        myId = msg.myId;
        for (const p of msg.players) others.set(p.id, p.name);
        statusEl.textContent = 'Configure settings and press Start Game';
        break;

      case 'player-joined':
        others.set(msg.id, msg.name);
        break;

      case 'player-left':
      case 'ms-player-left':
        others.delete(msg.id);
        break;

      case 'ms-start':
        onGameStart(msg);
        break;

      case 'ms-revealed':
        onRevealed(msg);
        break;

      case 'ms-mine-hit':
        onMineHit(msg);
        break;

      case 'ms-flagged':
        onFlagged(msg);
        break;

      case 'ms-unflagged':
        onUnflagged(msg);
        break;

      case 'ms-score-update':
        onScoreUpdate(msg);
        break;

      case 'ms-trap-triggered':
        onTrapTriggered(msg);
        break;

      case 'ms-targeting':
        targeting = msg.powerup;
        updatePowerupBar();
        statusEl.textContent = 'Click a cell to use ' + msg.powerup;
        break;

      case 'ms-powerup-applied':
        if (msg.powerup === 'shield') myShield = true;
        myCharges = msg.charges;
        updatePowerupBar();
        break;

      case 'ms-scanner':
        onScanner(msg);
        break;

      case 'ms-frenzy':
        frenzyUntilTime = msg.until;
        myCharges = msg.charges;
        frenzyGlow.style.display = '';
        updatePowerupBar();
        break;

      case 'ms-player-frenzy':
        // Show frenzy indicator on leaderboard
        updatePlayerCard(msg.playerId);
        break;

      case 'ms-reveal-mines-flash':
        onRevealMinesFlash(msg);
        break;

      case 'ms-decoy-placed':
        onDecoyPlaced(msg);
        break;

      case 'ms-trap-placed':
        onTrapPlaced(msg);
        break;

      case 'ms-game-over':
        onGameOver(msg);
        break;

      case 'error':
        statusEl.textContent = msg.msg;
        break;
    }
  }

  // ── Game start ───────────────────────────────────────────────
  function onGameStart(msg) {
    boardSize = msg.size;
    mineCount = msg.mineCount;
    timeLimit = msg.timeLimit;
    startedAt = Date.now();
    gameActive = true;
    targeting = null;
    myCharges = 0;
    myFlags = 10;
    myShield = false;
    stunUntilTime = 0;
    frenzyUntilTime = 0;
    scannerMines = [];

    playersData = msg.players;
    playersInfo = Object.entries(msg.players).map(([pid, ps]) => ({
      id: pid, name: ps.name, colorIdx: ps.colorIdx,
    }));

    btnStart.style.display = 'none';
    gameSettings.style.display = 'none';
    powerupBar.style.display = 'flex';
    statusEl.textContent = '';

    buildBoard();
    renderPlayerList();
    updatePowerupBar();

    // Timer
    updateTimer();
  }

  function buildBoard() {
    boardEl.innerHTML = '';
    boardEl.style.gridTemplateColumns = 'repeat(' + boardSize + ', 1fr)';
    cells = [];
    cellState = [];
    for (let r = 0; r < boardSize; r++) {
      const rowCells = [];
      const rowState = [];
      for (let c = 0; c < boardSize; c++) {
        const el = document.createElement('div');
        el.className = 'cell hidden';
        el.dataset.r = r;
        el.dataset.c = c;
        boardEl.appendChild(el);
        rowCells.push(el);
        rowState.push({ revealed: false, revealedBy: null, flaggedBy: null, adjacent: 0, mine: false });
      }
      cells.push(rowCells);
      cellState.push(rowState);
    }
  }

  // ── Board interactions ───────────────────────────────────────
  boardEl.addEventListener('click', e => {
    if (!gameActive) return;
    const cel = e.target.closest('.cell');
    if (!cel) return;
    const r = parseInt(cel.dataset.r), c = parseInt(cel.dataset.c);
    if (isNaN(r) || isNaN(c)) return;
    if (Date.now() < stunUntilTime) return;

    if (targeting) {
      wsSend({ type: 'ms-reveal', row: r, col: c });
    } else {
      wsSend({ type: 'ms-reveal', row: r, col: c });
    }
  });

  boardEl.addEventListener('contextmenu', e => {
    e.preventDefault();
    if (!gameActive) return;
    const cel = e.target.closest('.cell');
    if (!cel) return;
    const r = parseInt(cel.dataset.r), c = parseInt(cel.dataset.c);
    if (isNaN(r) || isNaN(c)) return;
    if (Date.now() < stunUntilTime) return;
    wsSend({ type: 'ms-flag', row: r, col: c });
  });

  // ── Cell updates ─────────────────────────────────────────────
  function onRevealed(msg) {
    const pid = msg.playerId;
    const info = playersInfo.find(i => i.id === pid);
    const tint = info ? PLAYER_TINTS[info.colorIdx] : 'transparent';

    for (const c of msg.cells) {
      const st = cellState[c.row][c.col];
      st.revealed = true;
      st.revealedBy = pid;
      st.adjacent = c.adjacent;
      const el = cells[c.row][c.col];
      el.className = 'cell revealed' + (c.adjacent > 0 ? ' ' + NUM_CLASSES[c.adjacent] : '');
      el.style.background = tint;
      el.textContent = c.adjacent > 0 ? c.adjacent : '';
    }

    // Update scores
    if (playersData[pid]) {
      playersData[pid].score = msg.score;
      playersData[pid].charges = msg.charges;
    }
    if (pid === myId) {
      myCharges = msg.charges;
      updatePowerupBar();
    }
    updatePlayerCard(pid);
  }

  function onMineHit(msg) {
    const el = cells[msg.row][msg.col];
    el.className = 'cell revealed mine exploded';
    el.innerHTML = '<span class="mine-icon">💥</span>';
    cellState[msg.row][msg.col].revealed = true;
    cellState[msg.row][msg.col].mine = true;

    if (playersData[msg.playerId]) {
      playersData[msg.playerId].score = msg.score;
    }
    updatePlayerCard(msg.playerId);

    if (msg.playerId === myId) {
      stunUntilTime = msg.stunUntil;
      if (myShield) {
        myShield = false;
        stunUntilTime = 0;
      }
      showStun();
    }
  }

  function onFlagged(msg) {
    const el = cells[msg.row][msg.col];
    el.className = 'cell hidden flagged';
    el.textContent = '';
    cellState[msg.row][msg.col].flaggedBy = msg.playerId;
    if (msg.playerId === myId) myFlags = msg.flagsLeft;
    if (playersData[msg.playerId]) playersData[msg.playerId].flags = msg.flagsLeft;
    updatePlayerCard(msg.playerId);
  }

  function onUnflagged(msg) {
    const el = cells[msg.row][msg.col];
    el.className = 'cell hidden';
    cellState[msg.row][msg.col].flaggedBy = null;
    if (msg.playerId === myId) myFlags = msg.flagsLeft;
    if (playersData[msg.playerId]) playersData[msg.playerId].flags = msg.flagsLeft;
    updatePlayerCard(msg.playerId);
  }

  function onScoreUpdate(msg) {
    if (playersData[msg.playerId]) {
      playersData[msg.playerId].score = msg.score;
      playersData[msg.playerId].charges = msg.charges;
    }
    if (msg.playerId === myId) {
      myCharges = msg.charges;
      myShield = msg.shield;
      updatePowerupBar();
    }
    updatePlayerCard(msg.playerId);
  }

  function onTrapTriggered(msg) {
    if (msg.playerId === myId) {
      stunUntilTime = msg.stunUntil;
      showStun();
    }
    updatePlayerCard(msg.playerId);
  }

  function onScanner(msg) {
    scannerMines = msg.mines;
    myCharges = msg.charges;
    updatePowerupBar();
    // Flash mine outlines
    for (const m of scannerMines) {
      const el = cells[m.row][m.col];
      const flash = document.createElement('div');
      flash.className = 'scanner-flash';
      el.appendChild(flash);
    }
    if (scannerTimeout) clearTimeout(scannerTimeout);
    scannerTimeout = setTimeout(() => {
      for (const m of scannerMines) {
        const el = cells[m.row][m.col];
        const flash = el.querySelector('.scanner-flash');
        if (flash) flash.remove();
      }
      scannerMines = [];
    }, msg.duration || 5000);
  }

  function onRevealMinesFlash(msg) {
    for (const m of msg.mines) {
      const el = cells[m.row][m.col];
      const flash = document.createElement('div');
      flash.className = 'scanner-flash';
      el.appendChild(flash);
      setTimeout(() => flash.remove(), msg.duration || 3000);
    }
  }

  function onDecoyPlaced(msg) {
    const el = cells[msg.row][msg.col];
    el.classList.add('decoy-mine');
    myCharges = msg.charges;
    targeting = null;
    updatePowerupBar();
    statusEl.textContent = '';
  }

  function onTrapPlaced(msg) {
    const el = cells[msg.row][msg.col];
    el.classList.add('trap-mine');
    myCharges = msg.charges;
    targeting = null;
    updatePowerupBar();
    statusEl.textContent = '';
  }

  // ── Stun effect ──────────────────────────────────────────────
  function showStun() {
    const updateStun = () => {
      const remain = stunUntilTime - Date.now();
      if (remain <= 0) {
        stunOverlay.style.display = 'none';
        return;
      }
      stunOverlay.style.display = 'flex';
      stunTimer.textContent = (remain / 1000).toFixed(1) + 's';
      requestAnimationFrame(updateStun);
    };
    updateStun();
  }

  // ── Game over ────────────────────────────────────────────────
  function onGameOver(msg) {
    gameActive = false;

    // Reveal all mines
    for (const m of msg.mines) {
      const el = cells[m.row][m.col];
      if (!cellState[m.row][m.col].revealed) {
        el.className = 'cell revealed mine';
        el.innerHTML = '<span class="mine-icon">💣</span>';
      }
    }

    resultTitle.textContent = (msg.winnerName || 'Nobody') + ' wins!';
    finalScoresEl.innerHTML = '';
    const sorted = Object.entries(msg.finalScores).sort((a, b) => b[1].score - a[1].score);
    for (const [pid, data] of sorted) {
      const div = document.createElement('div');
      div.className = 'fs-row' + (pid === msg.winnerId ? ' winner' : '');
      const fr = data.flagResults || { correct: 0, incorrect: 0 };
      div.innerHTML = '<div class="pc-color" style="background:' + PLAYER_COLORS[data.colorIdx] + '"></div>'
        + '<span class="fs-name">' + escapeHtml(data.name) + '</span>'
        + '<span class="fs-score">' + data.score + '</span>'
        + '<span class="fs-flags">🚩✓' + fr.correct + ' ✗' + fr.incorrect + '</span>';
      finalScoresEl.appendChild(div);
    }
    resultOverlay.style.display = 'flex';

    // Report score (not win-increment — highest score)
    if (playersData[myId]) {
      reportScore('minesweeper', playersData[myId].score);
    }
  }

  // ── Player list ──────────────────────────────────────────────
  function renderPlayerList() {
    playerListEl.innerHTML = '';
    for (const info of playersInfo) {
      const div = document.createElement('div');
      div.className = 'player-card' + (info.id === myId ? ' is-me' : '');
      div.id = 'mpc-' + info.id;
      const ps = playersData[info.id];
      div.innerHTML = '<div class="pc-color" style="background:' + PLAYER_COLORS[info.colorIdx] + '"></div>'
        + '<span class="pc-name">' + escapeHtml(info.name) + '</span>'
        + '<span class="pc-score" id="mscore-' + info.id + '">' + (ps ? ps.score : 0) + '</span>'
        + '<div class="pc-meta" id="mmeta-' + info.id + '">🚩' + (ps ? ps.flags : 10) + '</div>';
      playerListEl.appendChild(div);
    }
  }

  function updatePlayerCard(pid) {
    const ps = playersData[pid];
    if (!ps) return;
    const scoreEl = $('mscore-' + pid);
    if (scoreEl) scoreEl.textContent = ps.score;
    const metaEl = $('mmeta-' + pid);
    if (metaEl) {
      let html = '🚩' + ps.flags;
      if (ps.charges > 0 || (pid === myId && myCharges > 0)) html += ' ⚡' + (pid === myId ? myCharges : ps.charges);
      if (pid === myId && myShield) html += ' <span class="pc-effect">🛡️</span>';
      metaEl.innerHTML = html;
    }
    const card = $('mpc-' + pid);
    if (card) card.classList.toggle('stunned', ps.stunUntil > Date.now());
  }

  // ── Powerup bar ──────────────────────────────────────────────
  function updatePowerupBar() {
    chargeCount.textContent = myCharges;
    const btns = powerupBar.querySelectorAll('.pu-btn[data-pu]');
    btns.forEach(btn => {
      btn.classList.toggle('no-charges', myCharges <= 0);
      btn.disabled = myCharges <= 0;
      btn.classList.toggle('active', targeting === btn.dataset.pu);
    });
    $('btnCancelTarget').style.display = targeting ? '' : 'none';
  }

  powerupBar.addEventListener('click', e => {
    const btn = e.target.closest('.pu-btn[data-pu]');
    if (!btn || !gameActive || myCharges <= 0) return;
    wsSend({ type: 'ms-powerup', powerup: btn.dataset.pu });
  });

  $('btnCancelTarget').addEventListener('click', () => {
    targeting = null;
    wsSend({ type: 'ms-cancel-target' });
    updatePowerupBar();
    statusEl.textContent = '';
  });

  // ── Timer ────────────────────────────────────────────────────
  function updateTimer() {
    if (!gameActive) return;
    const elapsed = Date.now() - startedAt;
    const remain = Math.max(0, timeLimit - elapsed);
    const s = Math.ceil(remain / 1000);
    const m = Math.floor(s / 60), sec = s % 60;
    timerDisplay.textContent = m + ':' + String(sec).padStart(2, '0');
    timerDisplay.classList.toggle('danger', s <= 30);

    // Frenzy check
    if (frenzyUntilTime > 0 && Date.now() >= frenzyUntilTime) {
      frenzyGlow.style.display = 'none';
      frenzyUntilTime = 0;
    }

    if (remain > 0) requestAnimationFrame(updateTimer);
  }

  // ── Buttons ──────────────────────────────────────────────────
  btnBack.addEventListener('click', () => { location.href = '/'; });
  btnStart.addEventListener('click', () => {
    wsSend({
      type: 'ms-start',
      boardSize: parseInt($('selBoardSize').value),
      density: parseInt($('selDensity').value),
      timeLimit: parseInt($('selTime').value),
    });
  });
  $('btnCloseRules').addEventListener('click', () => { rulesOverlay.style.display = 'none'; });
  $('btnRules').addEventListener('click', () => { rulesOverlay.style.display = 'flex'; });
  $('btnBackToLobby').addEventListener('click', () => { location.href = '/'; });

  connect();
})();

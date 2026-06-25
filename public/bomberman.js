/* ═══════════════════════════════════════════════════════════════════
   BOMBERMAN — Arena Room Client  |  bomberman.js
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  const myName = sessionStorage.getItem('arena-name') || 'Player';
  if (!roomId) { location.href = '/'; return; }

  const $ = s => document.getElementById(s);
  const statusEl = $('status'), playerListEl = $('playerList'), playerCountEl = $('playerCount');
  const roomBadge = $('roomBadge'), btnBack = $('btnBack'), btnStart = $('btnStart');
  const btnAddBot = $('btnAddBot'), btnRemoveBot = $('btnRemoveBot'), botCountEl = $('botCount');
  const timerDisplay = $('timerDisplay'), roundNum = $('roundNum'), roundWinsEl = $('roundWins');
  const canvas = $('arena'), ctx = canvas.getContext('2d');
  const chatMessages = $('chatMessages'), chatInput = $('chatInput'), chatSend = $('chatSend');
  const roundOverlay = $('roundOverlay'), roundTitle = $('roundTitle'), roundScores = $('roundScores');
  const matchOverlay = $('matchOverlay'), matchTitle = $('matchTitle'), matchScoresEl = $('matchScores');
  const rulesOverlay = $('rulesOverlay'), countdownOverlay = $('countdownOverlay'), countdownNumber = $('countdownNumber');
  const mobileControls = $('mobileControls');

  roomBadge.textContent = 'Room ' + roomId;

  const COLS = 15, ROWS = 13, CELL = 48;
  const PLAYER_COLORS = ['#ef4444','#3b82f6','#22c55e','#f59e0b'];
  const POWERUP_ICONS = {
    'extra-bomb': '💣', 'blast-up': '🔥', 'speed-up': '👟',
    'vest': '🦺', 'punch': '🔪', 'remote': '🪃', 'skull': '☠️',
  };

  let ws = null, myId = null, amHost = false;
  const others = new Map();
  let botIds = new Set();
  let grid = null, players = {}, bombs = [], explosions = [], powerups = {};
  let roundWins = {}, currentRound = 1;
  let gameActive = false, matchStarted = false;
  let shrinking = false, shrinkRing = 0;
  let elapsed = 0;
  let playersInfo = [];
  let animFrame = null;
  let shakeAmount = 0;

  // ── Interpolation for REMOTE players ─────────────────────────────────────────────
  // Each remote player: we store the last two server snapshots and lerp between them
  const iFrom   = {};   // render position when latest server tick arrived
  const iTo     = {};   // server-computed sub-cell float for latest tick
  const iAt     = {};   // performance.now() when iTo was set
  const iFacing = {};   // facing direction per player
  const REMOTE_LERP_MS = 80; // lerp window — slightly > server tick (50ms) to smooth jitter

  // ── Client-side prediction for LOCAL PLAYER ──────────────────────────────────────
  // Source/target cell model: collision is checked BEFORE animation starts so the
  // player NEVER visually enters a wall. A single tap always completes one full step.
  const BM_SPEED = 8; // must match server BM_SPEED_BASE
  let myGridX = 0, myGridY = 0;   // cell the player is currently at (or animating FROM)
  let myNextX = 0, myNextY = 0;   // cell the player is animating TOWARD
  let myProgress = 0;             // 0→1 animation progress between myGrid and myNext
  let myMoving  = false;          // true while animating between cells
  let myMoveDir = null;           // current held direction: 'up'|'down'|'left'|'right'|null
  let localFacingDir = 'down';
  let lastFrameTime = 0;

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
        amHost = (msg.players.length === 0); // first player is host
        addPlayerCard('self', myName, true);
        for (const p of msg.players) addPlayerCard(p.id, p.name, false);
        updatePlayerCount();
        updateBotButtons();
        statusEl.textContent = 'Press Start Match when ready (or add bots to play solo!)';
        break;

      case 'player-joined':
        addPlayerCard(msg.id, msg.name, false);
        updatePlayerCount();
        updateBotButtons();
        break;

      case 'player-left':
        removePlayerCard(msg.id);
        updatePlayerCount();
        updateBotButtons();
        break;

      case 'bm-bot-added':
        botIds.add(msg.botId);
        addPlayerCard(msg.botId, '🤖 ' + msg.botName, false);
        updatePlayerCount();
        updateBotButtons();
        break;

      case 'bm-bot-removed':
        botIds.delete(msg.botId);
        removePlayerCard(msg.botId);
        updatePlayerCount();
        updateBotButtons();
        break;

      case 'bm-match-start':
        onMatchStart(msg);
        break;

      case 'bm-round-start':
        onRoundStart(msg);
        break;

      case 'bm-state':
        onState(msg);
        break;

      case 'bm-round-over':
        onRoundOver(msg);
        break;

      case 'bm-match-over':
        onMatchOver(msg);
        break;

      case 'bm-remote-detonate':
        // Process the detonation events (wall destruction, eliminations, etc.)
        if (msg.events) {
          for (const ev of msg.events) {
            if (ev.type === 'bm-wall-destroyed') {
              if (grid) grid[ev.y][ev.x] = 0;
            } else if (ev.type === 'bm-player-eliminated') {
              addChatMsg('💀', ev.name + ' eliminated!');
              shakeAmount = 6;
            } else if (ev.type === 'bm-vest-break') {
              addChatMsg('🦺', (players[ev.playerId]?.name || 'Player') + "'s vest broke!");
            }
          }
        }
        break;

      case 'chat':
        addChatMsg(msg.name, msg.text);
        break;

      case 'error':
        statusEl.textContent = msg.msg;
        break;
    }
  }

  // ── Player cards ─────────────────────────────────────────────
  function addPlayerCard(id, name, isMe) {
    if (id !== 'self') others.set(id, name);
    const el = document.createElement('div');
    el.className = 'player-card' + (isMe ? ' is-me' : '');
    el.id = 'pc-' + id;
    el.innerHTML = '<div class="pc-color" style="background:' + PLAYER_COLORS[playerListEl.children.length % 4] + '"></div>'
      + '<span class="pc-name">' + escapeHtml(name) + '</span>'
      + '<span class="pc-stats" id="ps-' + id + '"></span>';
    playerListEl.appendChild(el);
  }
  function removePlayerCard(id) {
    others.delete(id);
    const el = $('pc-' + id);
    if (el) el.remove();
  }
  function updatePlayerCount() {
    playerCountEl.textContent = playerListEl.children.length;
  }

  function updateBotButtons() {
    if (!amHost || matchStarted) {
      btnAddBot.style.display = 'none';
      btnRemoveBot.style.display = 'none';
      botCountEl.style.display = 'none';
      return;
    }
    btnAddBot.style.display = '';
    if (botIds.size > 0) {
      btnRemoveBot.style.display = '';
      botCountEl.style.display = '';
      botCountEl.textContent = botIds.size + ' bot' + (botIds.size > 1 ? 's' : '');
    } else {
      btnRemoveBot.style.display = 'none';
      botCountEl.style.display = 'none';
    }
  }

  // ── Game init ────────────────────────────────────────────────
  function onMatchStart(msg) {
    grid = msg.grid;
    playersInfo = msg.playersInfo;
    roundWins = msg.roundWins;
    matchStarted = true;
    gameActive = false;
    btnStart.style.display = 'none';
    btnAddBot.style.display = 'none';
    btnRemoveBot.style.display = 'none';
    botCountEl.style.display = 'none';
    statusEl.textContent = '';

    // Show countdown
    countdownOverlay.style.display = 'flex';
    let count = 3;
    countdownNumber.textContent = count;
    const iv = setInterval(() => {
      count--;
      if (count > 0) {
        countdownNumber.textContent = count;
      } else {
        clearInterval(iv);
        countdownOverlay.style.display = 'none';
      }
    }, 1000);

    resizeCanvas();
    updateRoundWins();
    if (!animFrame) renderLoop();

    // Mobile detection
    if ('ontouchstart' in window) mobileControls.style.display = 'flex';
  }

  function onRoundStart(msg) {
    grid = msg.grid;
    players = msg.players;
    bombs = [];
    explosions = [];
    powerups = {};
    currentRound = msg.round;
    roundNum.textContent = currentRound;
    gameActive = true;
    shrinking = false;
    shrinkRing = 0;
    elapsed = 0;
    roundOverlay.style.display = 'none';
    statusEl.textContent = '';
    localFacingDir = 'down';
    myMoveDir = null;
    myMoving  = false;
    myProgress = 0;
    lastFrameTime = 0;

    // Seed local position from server spawn
    const myStartPos = players[myId];
    if (myStartPos) {
      myGridX = myNextX = myStartPos.x;
      myGridY = myNextY = myStartPos.y;
    }

    // Seed remote-player interpolation at spawn positions
    const t0 = performance.now();
    for (const [pid, ps] of Object.entries(players)) {
      if (pid === myId) continue;
      const fx = ps.x + (ps.moving && ps.moveDir === 'right' ? 1 : ps.moving && ps.moveDir === 'left' ? -1 : 0) * (ps.moveProgress || 0);
      const fy = ps.y + (ps.moving && ps.moveDir === 'down'  ? 1 : ps.moving && ps.moveDir === 'up'   ? -1 : 0) * (ps.moveProgress || 0);
      iFrom[pid]   = { x: fx, y: fy };
      iTo[pid]     = { x: fx, y: fy };
      iAt[pid]     = t0;
      iFacing[pid] = ps.facingDir || 'down';
    }
    updatePlayerCards();
  }

  function onState(msg) {
    if (!gameActive) return;
    players = msg.players;
    bombs = msg.bombs;
    explosions = msg.explosions;
    powerups = msg.powerups;
    elapsed = msg.elapsed;
    shrinking = msg.shrinking;
    shrinkRing = msg.shrinkRing;

    // Process inline events
    if (msg.events) {
      for (const ev of msg.events) {
        if (ev.type === 'bm-wall-destroyed') {
          grid[ev.y][ev.x] = 0;
        } else if (ev.type === 'bm-player-eliminated') {
          addChatMsg('💀', ev.name + ' eliminated!');
          shakeAmount = 6;
        } else if (ev.type === 'bm-vest-break') {
          addChatMsg('🦺', (players[ev.playerId]?.name || 'Player') + "'s vest broke!");
        } else if (ev.type === 'bm-powerup-collected') {
          // Visual feedback handled in render
        } else if (ev.type === 'bm-shrink-warning') {
          addChatMsg('⚠️', 'Arena shrinking!');
        } else if (ev.type === 'bm-shrink') {
          grid = ev.grid;
          shakeAmount = 4;
        }
      }
    }

    // Update timer
    const remain = Math.max(0, 120 - Math.floor(elapsed / 1000));
    const m = Math.floor(remain / 60), s = remain % 60;
    timerDisplay.textContent = m + ':' + String(s).padStart(2, '0');
    timerDisplay.classList.toggle('danger', remain <= 30);

    // Server is NOT authoritative for local player position (client owns movement).
    // Only sync curse/powerup state that the server tracks.
    if (msg.players[myId]) {
      const sp = msg.players[myId];
      // If server says we're dead, trust it (explosion logic is server-side)
      if (!sp.alive && players[myId]?.alive) {
        players[myId].alive = false;
      }
      // Apply speedLevel changes from powerups
      if (sp.speedLevel !== undefined) players[myId] = { ...players[myId], ...sp };
    }

    // Update remote-player interpolation targets
    const tickNow = performance.now();
    for (const [pid, ps] of Object.entries(msg.players)) {
      if (pid === myId) continue;
      // For remote players the server IS authoritative — lerp between their last two cell positions
      iFrom[pid] = getRemoteRenderPos(pid) || iTo[pid] || { x: ps.x, y: ps.y };
      iTo[pid]   = { x: ps.x, y: ps.y };
      iAt[pid]   = tickNow;
      iFacing[pid] = ps.facingDir || iFacing[pid] || 'down';
    }

    updatePlayerCards();
  }

  function onRoundOver(msg) {
    gameActive = false;
    roundWins = msg.roundWins;
    updateRoundWins();
    roundTitle.textContent = msg.winnerName ? msg.winnerName + ' wins Round ' + msg.round + '!' : 'Round ' + msg.round + ' — Draw!';
    roundScores.innerHTML = '';
    for (const info of playersInfo) {
      const wins = msg.roundWins[info.id] || 0;
      const div = document.createElement('div');
      div.className = 'rs-row' + (info.id === msg.winnerId ? ' winner' : '');
      div.innerHTML = '<div class="pc-color" style="background:' + PLAYER_COLORS[info.colorIdx] + '"></div>'
        + '<span class="rs-name">' + escapeHtml(info.name) + '</span>'
        + '<span class="rs-wins">' + wins + ' / 3</span>';
      roundScores.appendChild(div);
    }
    roundOverlay.style.display = 'flex';
  }

  function onMatchOver(msg) {
    gameActive = false;
    matchStarted = false;
    roundOverlay.style.display = 'none';
    matchTitle.textContent = (msg.winnerName || 'Nobody') + ' wins the match!';
    matchScoresEl.innerHTML = '';
    for (const info of playersInfo) {
      const wins = msg.roundWins[info.id] || 0;
      const div = document.createElement('div');
      div.className = 'rs-row' + (info.id === msg.winnerId ? ' winner' : '');
      div.innerHTML = '<div class="pc-color" style="background:' + PLAYER_COLORS[info.colorIdx] + '"></div>'
        + '<span class="rs-name">' + escapeHtml(info.name) + '</span>'
        + '<span class="rs-wins">' + wins + ' wins</span>';
      matchScoresEl.appendChild(div);
    }
    matchOverlay.style.display = 'flex';

    if (msg.winnerId === myId) reportScore('bomberman', 1);
  }

  function updatePlayerCards() {
    for (const info of playersInfo) {
      const pid = info.id;
      const cardId = pid === myId ? 'self' : pid;
      const el = $('pc-' + cardId);
      const ps = players[pid];
      if (!el || !ps) continue;
      el.classList.toggle('dead', !ps.alive);
      const statsEl = $('ps-' + cardId);
      if (statsEl) {
        let txt = ps.alive ? '💣' + ps.bombMax + ' 🔥' + ps.bombRadius : '💀';
        if (ps.vest) txt += ' 🦺';
        if (ps.ability) txt += ' ' + (ps.ability === 'punch' ? '🔪' : '🪃');
        if (ps.curse) txt += ' ☠️';
        statsEl.textContent = txt;
      }
    }
  }

  function updateRoundWins() {
    roundWinsEl.innerHTML = '';
    for (const info of playersInfo) {
      const wins = roundWins[info.id] || 0;
      const div = document.createElement('div');
      div.className = 'rw-row';
      let dots = '';
      for (let i = 0; i < 3; i++) dots += '<div class="rw-dot' + (i < wins ? ' won' : '') + '"></div>';
      div.innerHTML = '<div class="pc-color" style="background:' + PLAYER_COLORS[info.colorIdx] + ';width:8px;height:8px"></div>'
        + '<span style="flex:1;font-size:.65rem">' + escapeHtml(info.name) + '</span>'
        + '<div class="rw-dots">' + dots + '</div>';
      roundWinsEl.appendChild(div);
    }
  }

  // ── Input ────────────────────────────────────────────────────
  const keysDown = new Set();
  const dirMap = { w: 'up', arrowup: 'up', s: 'down', arrowdown: 'down', a: 'left', arrowleft: 'left', d: 'right', arrowright: 'right' };
  let lastMoveDirSent = null;

  document.addEventListener('keydown', e => {
    if (e.target === chatInput) return;
    if (!gameActive) return;
    const key = e.key.toLowerCase();
    if (keysDown.has(key)) return;
    keysDown.add(key);

    if (key === 'w' || key === 'arrowup') { 
      localFacingDir = 'up'; 
      if (myMoveDir !== 'up') { myMoveDir = 'up'; wsSend({ type: 'bm-input', action: 'move-start', dir: 'up' }); }
      e.preventDefault(); 
    }
    else if (key === 's' || key === 'arrowdown') { 
      localFacingDir = 'down'; 
      if (myMoveDir !== 'down') { myMoveDir = 'down'; wsSend({ type: 'bm-input', action: 'move-start', dir: 'down' }); }
      e.preventDefault(); 
    }
    else if (key === 'a' || key === 'arrowleft') { 
      localFacingDir = 'left'; 
      if (myMoveDir !== 'left') { myMoveDir = 'left'; wsSend({ type: 'bm-input', action: 'move-start', dir: 'left' }); }
      e.preventDefault(); 
    }
    else if (key === 'd' || key === 'arrowright') { 
      localFacingDir = 'right'; 
      if (myMoveDir !== 'right') { myMoveDir = 'right'; wsSend({ type: 'bm-input', action: 'move-start', dir: 'right' }); }
      e.preventDefault(); 
    }
    else if (key === ' ') { wsSend({ type: 'bm-input', action: 'bomb' }); e.preventDefault(); }
    else if (key === 'e' || key === 'f') { wsSend({ type: 'bm-input', action: 'ability' }); e.preventDefault(); }
  });

  document.addEventListener('keyup', e => {
    const key = e.key.toLowerCase();
    keysDown.delete(key);
    if (!gameActive) return;
    if (['w','s','a','d','arrowup','arrowdown','arrowleft','arrowright'].includes(key)) {
      // Find next direction still held
      let nextDir = null;
      for (const k of keysDown) {
        if (dirMap[k]) { nextDir = dirMap[k]; localFacingDir = nextDir; break; }
      }
      if (nextDir !== myMoveDir) {
        myMoveDir = nextDir;
        if (nextDir) {
          wsSend({ type: 'bm-input', action: 'move-start', dir: nextDir });
        } else {
          wsSend({ type: 'bm-input', action: 'move-stop' });
        }
      }
    }
  });

  // Mobile D-pad
  const dpadBtns = document.querySelectorAll('.dpad-btn');
  dpadBtns.forEach(btn => {
    btn.addEventListener('touchstart', e => {
      e.preventDefault();
      const dir = btn.dataset.dir;
      localFacingDir = dir;
      if (myMoveDir !== dir) {
        myMoveDir = dir;
        wsSend({ type: 'bm-input', action: 'move-start', dir: dir });
      }
    });
    btn.addEventListener('touchend', e => {
      e.preventDefault();
      if (myMoveDir) {
        myMoveDir = null;
        wsSend({ type: 'bm-input', action: 'move-stop' });
      }
    });
  });
  $('btnBomb')?.addEventListener('touchstart', e => { e.preventDefault(); wsSend({ type: 'bm-input', action: 'bomb' }); });
  $('btnAbility')?.addEventListener('touchstart', e => { e.preventDefault(); wsSend({ type: 'bm-input', action: 'ability' }); });

  // ── Rendering ────────────────────────────────────────────────
  function resizeCanvas() {
    const wrap = document.querySelector('.arena-wrap');
    const maxW = wrap.clientWidth - 10, maxH = wrap.clientHeight - 10;
    const arenaW = COLS * CELL, arenaH = ROWS * CELL;
    const scale = Math.min(maxW / arenaW, maxH / arenaH, 1);
    canvas.width = arenaW;
    canvas.height = arenaH;
    canvas.style.width = Math.floor(arenaW * scale) + 'px';
    canvas.style.height = Math.floor(arenaH * scale) + 'px';
  }
  window.addEventListener('resize', resizeCanvas);

  // ── Remote player render position (lerp between two server snapshots) ──────────
  function getRemoteRenderPos(pid) {
    if (!iTo[pid]) return null;
    const from = iFrom[pid] || iTo[pid];
    const t = Math.min(1, (performance.now() - iAt[pid]) / REMOTE_LERP_MS);
    return {
      x: from.x + (iTo[pid].x - from.x) * t,
      y: from.y + (iTo[pid].y - from.y) * t,
    };
  }

  // ── Local player: cell-based collision check (mirrors server exactly) ─────────
  function localCanStepTo(nx, ny) {
    if (nx < 0 || nx >= COLS || ny < 0 || ny >= ROWS) return false;
    if (!grid || grid[ny][nx] !== 0) return false;
    // Bomb blocking: can't enter a bomb's cell (server rule)
    for (const b of bombs) {
      if (b.x === nx && b.y === ny && !(b.x === myGridX && b.y === myGridY)) return false;
    }
    return true;
  }

  // ── Update local player movement each frame ─────────────────────────────────
  function updateLocalMovement(dt) {
    if (!gameActive) return;

    const myPs = players[myId];
    const speedLevel = myPs ? (myPs.speedLevel || 0) : 0;
    let effectiveSpeed = BM_SPEED + speedLevel * 2;
    if (myPs?.curse === 'slow')  effectiveSpeed *= 0.4;
    if (myPs?.curse === 'speed') effectiveSpeed *= 2.5;

    if (myMoving) {
      // Continue animating toward myNext
      myProgress += dt * effectiveSpeed;
      if (myProgress >= 1) {
        // Arrived — commit to destination
        myGridX = myNextX;
        myGridY = myNextY;
        myProgress -= 1;
        // Tell server we stepped here
        wsSend({ type: 'bm-input', action: 'pos', x: myGridX, y: myGridY, dir: localFacingDir });

        // Immediately queue next step if direction still held
        if (myMoveDir) {
          const nx = myGridX + (myMoveDir === 'right' ? 1 : myMoveDir === 'left' ? -1 : 0);
          const ny = myGridY + (myMoveDir === 'down'  ? 1 : myMoveDir === 'up'   ? -1 : 0);
          if (localCanStepTo(nx, ny)) {
            myNextX = nx; myNextY = ny;
            // myMoving stays true, myProgress carries over (smooth continuous movement)
          } else {
            myMoving = false;
            myProgress = 0;
          }
        } else {
          myMoving = false;
          myProgress = 0;
        }
      }
    } else if (myMoveDir) {
      // Not animating — try to start a step
      // Apply reverse curse (server used to do this in its movement loop)
      const myPs = players[myId];
      let stepDir = myMoveDir;
      if (myPs?.curse === 'reverse') {
        stepDir = stepDir === 'up' ? 'down' : stepDir === 'down' ? 'up' : stepDir === 'left' ? 'right' : 'left';
      }
      const nx = myGridX + (stepDir === 'right' ? 1 : stepDir === 'left' ? -1 : 0);
      const ny = myGridY + (stepDir === 'down'  ? 1 : stepDir === 'up'   ? -1 : 0);
      if (localCanStepTo(nx, ny)) {
        myNextX = nx; myNextY = ny;
        myMoving = true;
        myProgress = 0;
      }
    }
  }

  // ── Visual position for local player ─────────────────────────────────────────
  function getLocalRenderPos() {
    if (!myMoving) return { x: myGridX, y: myGridY };
    return {
      x: myGridX + (myNextX - myGridX) * myProgress,
      y: myGridY + (myNextY - myGridY) * myProgress,
    };
  }

  function renderLoop(now) {
    const dt = lastFrameTime ? Math.min((now - lastFrameTime) / 1000, 0.05) : 0;
    lastFrameTime = now;
    updateLocalMovement(dt);
    render();
    animFrame = requestAnimationFrame(renderLoop);
  }

  function render() {
    if (!grid) return;
    ctx.save();

    // Screen shake
    if (shakeAmount > 0) {
      const sx = (Math.random() - 0.5) * shakeAmount * 2;
      const sy = (Math.random() - 0.5) * shakeAmount * 2;
      ctx.translate(sx, sy);
      shakeAmount *= 0.9;
      if (shakeAmount < 0.3) shakeAmount = 0;
    }

    // Draw grid
    for (let y = 0; y < ROWS; y++) {
      for (let x = 0; x < COLS; x++) {
        const px = x * CELL, py = y * CELL;
        const cellType = grid[y][x];
        if (cellType === 1) {
          // Hard wall
          ctx.fillStyle = '#374151';
          ctx.fillRect(px, py, CELL, CELL);
          ctx.fillStyle = '#4b5563';
          ctx.fillRect(px + 2, py + 2, CELL - 4, CELL - 4);
          // Brick pattern
          ctx.strokeStyle = '#374151';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px, py + CELL / 2); ctx.lineTo(px + CELL, py + CELL / 2);
          ctx.moveTo(px + CELL / 2, py); ctx.lineTo(px + CELL / 2, py + CELL / 2);
          ctx.stroke();
        } else if (cellType === 2) {
          // Soft wall
          ctx.fillStyle = '#92400e';
          ctx.fillRect(px, py, CELL, CELL);
          ctx.fillStyle = '#b45309';
          ctx.fillRect(px + 3, py + 3, CELL - 6, CELL - 6);
          // Cross pattern
          ctx.strokeStyle = '#92400e';
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(px + 4, py + 4); ctx.lineTo(px + CELL - 4, py + CELL - 4);
          ctx.moveTo(px + CELL - 4, py + 4); ctx.lineTo(px + 4, py + CELL - 4);
          ctx.stroke();
        } else {
          // Floor
          ctx.fillStyle = (x + y) % 2 === 0 ? '#1a472a' : '#166534';
          ctx.fillRect(px, py, CELL, CELL);
        }
      }
    }

    // Powerups on floor
    ctx.font = Math.floor(CELL * 0.6) + 'px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const [key, ptype] of Object.entries(powerups)) {
      const [gy, gx] = key.split(',').map(Number);
      const px = gx * CELL + CELL / 2, py = gy * CELL + CELL / 2;
      // Bob animation
      const bob = Math.sin(Date.now() / 300 + gx + gy) * 3;
      ctx.fillText(POWERUP_ICONS[ptype] || '?', px, py + bob);
    }

    // Shrink warning edges
    if (shrinking) {
      ctx.strokeStyle = 'rgba(239,68,68,0.6)';
      ctx.lineWidth = 4;
      const ring = shrinkRing;
      ctx.strokeRect(ring * CELL, ring * CELL, (COLS - ring * 2) * CELL, (ROWS - ring * 2) * CELL);
    }

    // Bombs
    const now = Date.now();
    for (const b of bombs) {
      const px = b.x * CELL + CELL / 2, py = b.y * CELL + CELL / 2;
      const timeLeft = b.remote ? Infinity : (b.detonateAt - now);
      const pulse = b.remote ? 1 : (1 + 0.15 * Math.sin(now / (timeLeft < 1000 ? 80 : 200)));
      const radius = CELL * 0.3 * pulse;
      ctx.beginPath();
      ctx.arc(px, py, radius, 0, Math.PI * 2);
      ctx.fillStyle = '#1f2937';
      ctx.fill();
      ctx.strokeStyle = b.remote ? '#a78bfa' : '#ef4444';
      ctx.lineWidth = 2;
      ctx.stroke();
      // Fuse
      ctx.beginPath();
      ctx.moveTo(px, py - radius);
      ctx.lineTo(px + 4, py - radius - 6);
      ctx.strokeStyle = '#fbbf24';
      ctx.lineWidth = 2;
      ctx.stroke();
      // Spark
      if (!b.remote && timeLeft < 1500) {
        ctx.beginPath();
        ctx.arc(px + 4, py - radius - 8, 3 + Math.random() * 2, 0, Math.PI * 2);
        ctx.fillStyle = '#fbbf24';
        ctx.fill();
      }
    }

    // Explosions
    for (const exp of explosions) {
      for (const cell of exp.cells) {
        const px = cell.x * CELL, py = cell.y * CELL;
        const life = (exp.expiresAt - now) / 500;
        const alpha = Math.max(0, life);
        ctx.fillStyle = `rgba(251,191,36,${alpha * 0.8})`;
        ctx.fillRect(px + 2, py + 2, CELL - 4, CELL - 4);
        ctx.fillStyle = `rgba(239,68,68,${alpha * 0.5})`;
        ctx.fillRect(px + 6, py + 6, CELL - 12, CELL - 12);
      }
    }

    // Players
    for (const [pid, ps] of Object.entries(players)) {
      if (!ps.alive) continue;
      const info = playersInfo.find(i => i.id === pid);
      const color = PLAYER_COLORS[info ? info.colorIdx : 0];
      // Use client-predicted position for local player, interpolated for remote players
      let rp;
      if (pid === myId) {
        rp = getLocalRenderPos();
      } else {
        rp = getRemoteRenderPos(pid) || { x: ps.x, y: ps.y };
      }
      const px = rp.x * CELL + CELL / 2;
      const py = rp.y * CELL + CELL / 2;
      const facing = (pid === myId) ? localFacingDir : (iFacing[pid] || 'down');

      // Body
      ctx.beginPath();
      ctx.arc(px, py, CELL * 0.35, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,.3)';
      ctx.lineWidth = 2;
      ctx.stroke();

      // Eyes (direction-based)
      const eyeOffX = facing === 'left' ? -4 : facing === 'right' ? 4 : 0;
      const eyeOffY = facing === 'up' ? -4 : facing === 'down' ? 4 : 0;
      ctx.fillStyle = '#fff';
      ctx.beginPath();
      ctx.arc(px - 4 + eyeOffX * 0.5, py - 3 + eyeOffY * 0.5, 3, 0, Math.PI * 2);
      ctx.arc(px + 4 + eyeOffX * 0.5, py - 3 + eyeOffY * 0.5, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1a1a2e';
      ctx.beginPath();
      ctx.arc(px - 4 + eyeOffX, py - 3 + eyeOffY, 1.5, 0, Math.PI * 2);
      ctx.arc(px + 4 + eyeOffX, py - 3 + eyeOffY, 1.5, 0, Math.PI * 2);
      ctx.fill();

      // Vest indicator
      if (ps.vest) {
        ctx.strokeStyle = '#22c55e';
        ctx.lineWidth = 2;
        ctx.setLineDash([3, 3]);
        ctx.beginPath();
        ctx.arc(px, py, CELL * 0.4, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      // Curse effect
      if (ps.curse) {
        ctx.fillStyle = 'rgba(139,92,246,0.3)';
        ctx.beginPath();
        ctx.arc(px, py, CELL * 0.42, 0, Math.PI * 2);
        ctx.fill();
        ctx.font = '12px sans-serif';
        ctx.fillText('☠️', px, py - CELL * 0.45);
      }

      // Name tag
      ctx.font = '10px Orbitron, sans-serif';
      ctx.fillStyle = '#fff';
      ctx.textAlign = 'center';
      ctx.fillText(ps.name || '', px, py + CELL * 0.5 + 10);
    }

    ctx.restore();
  }

  // ── Chat ─────────────────────────────────────────────────────
  function addChatMsg(name, text) {
    const div = document.createElement('div');
    div.className = 'chat-msg';
    div.innerHTML = '<b>' + escapeHtml(name) + '</b> ' + escapeHtml(text);
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  chatSend.addEventListener('click', () => {
    const text = chatInput.value.trim();
    if (!text) return;
    wsSend({ type: 'chat', text });
    addChatMsg(myName, text);
    chatInput.value = '';
  });
  chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') chatSend.click(); });

  // ── Buttons ──────────────────────────────────────────────────
  btnBack.addEventListener('click', () => { location.href = '/'; });
  btnStart.addEventListener('click', () => { wsSend({ type: 'bm-start' }); });
  btnAddBot.addEventListener('click', () => { wsSend({ type: 'bm-add-bot' }); });
  btnRemoveBot.addEventListener('click', () => { wsSend({ type: 'bm-remove-bot' }); });
  $('btnCloseRules').addEventListener('click', () => { rulesOverlay.style.display = 'none'; });
  $('btnRules').addEventListener('click', () => { rulesOverlay.style.display = 'flex'; });
  $('btnBackToLobby').addEventListener('click', () => { location.href = '/'; });

  connect();
})();

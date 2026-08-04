(() => {
'use strict';

// ── URL / session ────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const roomId = params.get('room');
const myName = sessionStorage.getItem('arena-name') || 'Player';
if (!roomId) { location.href = '/'; return; }

// ── DOM refs ─────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const statusEl      = $('status');
const playerListEl  = $('playerList');
const playerCountEl = $('playerCount');
const roomBadge     = $('roomBadge');
const btnBack       = $('btnBack');
const btnStart      = $('btnStart');
const btnRules      = $('btnRules');
const btnCloseRules = $('btnCloseRules');
const btnToggle     = $('btnToggleSidebar');
const lobbyArea     = $('lobbyArea');
const gameArea      = $('gameArea');
const lobbyConfig   = $('lobbyConfig');
const waitingHint   = $('waitingHint');
const cardGrid      = $('cardGrid');
const turnBanner    = $('turnBanner');
const stealBtn      = $('stealBtn');
const stealHint     = $('stealHint');
const stealRingFg   = $('stealRingFg');
const penaltyNotice = $('penaltyNotice');
const scorePanel    = $('scorePanel');
const scoreRow1     = $('scoreRow1');
const scoreRow2     = $('scoreRow2');
const pairsLeft     = $('pairsLeft');
const resultOverlay = $('resultOverlay');
const resultTrophy  = $('resultTrophy');
const resultTitle   = $('resultTitle');
const resultScores  = $('resultScores');
const resultStats   = $('resultStats');
const btnPlayAgain  = $('btnPlayAgain');
const rulesOverlay  = $('rulesOverlay');
const ghostOverlay  = $('ghostOverlay');

roomBadge.textContent = 'Room ' + roomId;

// ── Game state ───────────────────────────────────────────────────
let ws = null, myId = null, leaderId = null;
const players = new Map(); // id → { name }
let gamePhase = 'lobby'; // lobby | playing | ended

// Board state
let grid = [];           // [{ value, emoji, color, captured, capturedBy }]
let gridCols = 6, gridRows = 6;
let totalPairs = 18;
let pairsRemaining = 18;
let scores = {};         // id → number
let streaks = {};        // id → number
let myPenaltyNext = false;

// Turn state
let turnId = null;
let turnPhase = 'idle'; // idle | steal-window | second-flip | resolving
let firstFlippedPos = null;
let firstFlippedValue = null;

// Steal window
let stealWindowActive = false;
let stealSelectMode = false;
let stealRingAnim = null;
let stealWindowMs = 2000;

// Config
let cfg = { gridSize: '6x6', stealWindowMs: 2000, ghostMode: false, cardTheme: 'emoji' };
let isHost = false;

// Memory for ghost mode
const revealedHistory = new Map(); // pos → { value, emoji, color }

// ── Theme helpers ────────────────────────────────────────────────
function cardDisplay(value, emoji, color, theme) {
  if (theme === 'numbers') return { text: String(value + 1), bg: color };
  if (theme === 'colors') return { text: '', bg: color };
  return { text: emoji, bg: color };
}

// ── Player list ─────────────────────────────────────────────────
function renderPlayerList() {
  playerListEl.innerHTML = '';
  playerCountEl.textContent = players.size;
  for (const [pid, p] of players) {
    const el = document.createElement('div');
    el.className = 'player-item' + (pid === myId ? ' is-me' : '') + (pid === turnId && gamePhase === 'playing' ? ' is-active' : '');
    el.innerHTML = `<span class="pip"></span><span>${escHtml(p.name)}${pid === leaderId ? ' 👑' : ''}${pid === myId ? ' (you)' : ''}</span>`;
    playerListEl.appendChild(el);
  }
}

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Score panel ──────────────────────────────────────────────────
function renderScores() {
  if (gamePhase !== 'playing') return;
  scorePanel.style.display = '';
  const playerArr = [...players.entries()];
  if (playerArr.length < 2) return;
  const [pid1, p1] = playerArr[0];
  const [pid2, p2] = playerArr[1];
  const s1 = scores[pid1] || 0;
  const s2 = scores[pid2] || 0;
  const streak1 = streaks[pid1] || 0;
  const streak2 = streaks[pid2] || 0;
  scoreRow1.innerHTML = `<span class="s-name">${escHtml(p1.name)}</span>${streak1 >= 2 ? `<span class="s-streak">🔥×${streak1}</span>` : ''}<span class="s-pts">${s1}</span>`;
  scoreRow2.innerHTML = `<span class="s-name">${escHtml(p2.name)}</span>${streak2 >= 2 ? `<span class="s-streak">🔥×${streak2}</span>` : ''}<span class="s-pts">${s2}</span>`;
  scoreRow1.className = 'score-row' + (s1 > s2 ? ' is-leading' : '');
  scoreRow2.className = 'score-row' + (s2 > s1 ? ' is-leading' : '');
  pairsLeft.textContent = `${pairsRemaining} pair${pairsRemaining !== 1 ? 's' : ''} remaining`;
}

// ── Config controls (host) ───────────────────────────────────────
function setupConfigControls() {
  for (const groupId of ['cfgGridSize','cfgStealWindow','cfgGhostMode','cfgCardTheme']) {
    const group = $(groupId);
    if (!group) continue;
    group.addEventListener('click', e => {
      if (!isHost) return;
      const btn = e.target.closest('.cfg-btn');
      if (!btn) return;
      group.querySelectorAll('.cfg-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      const newCfg = readConfig();
      cfg = newCfg;
      wsSend({ type: 'md-lobby-config', ...newCfg });
    });
  }
}

function readConfig() {
  function activeVal(groupId) {
    const group = $(groupId);
    const active = group?.querySelector('.cfg-btn.active');
    return active?.dataset.val;
  }
  return {
    gridSize: activeVal('cfgGridSize') || '6x6',
    stealWindowMs: Number(activeVal('cfgStealWindow')) || 2000,
    ghostMode: activeVal('cfgGhostMode') === 'true',
    cardTheme: activeVal('cfgCardTheme') || 'emoji',
  };
}

function applyRemoteCfg(data) {
  cfg = { gridSize: data.gridSize, stealWindowMs: Number(data.stealWindowMs), ghostMode: !!data.ghostMode, cardTheme: data.cardTheme || 'emoji' };
  stealWindowMs = cfg.stealWindowMs;
  if (!isHost) {
    // Update UI to reflect host's choice
    function syncGroup(groupId, val) {
      const group = $(groupId);
      if (!group) return;
      group.querySelectorAll('.cfg-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.val === String(val));
      });
    }
    syncGroup('cfgGridSize', cfg.gridSize);
    syncGroup('cfgStealWindow', String(cfg.stealWindowMs));
    syncGroup('cfgGhostMode', String(cfg.ghostMode));
    syncGroup('cfgCardTheme', cfg.cardTheme);
  }
}

// ── Card grid rendering ──────────────────────────────────────────
function buildGrid(cols, rows) {
  cardGrid.innerHTML = '';
  cardGrid.className = 'card-grid grid-' + cols + 'x' + rows;
  cardGrid.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  grid = [];
  for (let i = 0; i < cols * rows; i++) {
    grid.push({ value: -1, emoji: '', color: '', captured: false, capturedBy: null, faceUp: false });
    const cardEl = document.createElement('div');
    cardEl.className = 'card';
    cardEl.dataset.pos = i;
    cardEl.innerHTML = `<div class="card-face card-back"><div class="card-back-pattern">🂠</div></div><div class="card-face card-front"></div>`;
    cardEl.addEventListener('click', () => onCardClick(i));
    cardGrid.appendChild(cardEl);
  }
}

function getCardEl(pos) {
  return cardGrid.querySelector(`.card[data-pos="${pos}"]`);
}

function flipCardFaceUp(pos, value, emoji, color) {
  grid[pos].value = value;
  grid[pos].emoji = emoji;
  grid[pos].color = color;
  grid[pos].faceUp = true;
  const el = getCardEl(pos);
  if (!el) return;
  const front = el.querySelector('.card-front');
  const d = cardDisplay(value, emoji, color, cfg.cardTheme);
  front.style.background = `linear-gradient(135deg, ${d.bg}cc, ${d.bg}88)`;
  front.style.border = `1.5px solid ${d.bg}`;
  front.innerHTML = `<span class="card-emoji">${d.text}</span>`;
  el.classList.add('flipped');
}

function flipCardFaceDown(pos) {
  grid[pos].faceUp = false;
  const el = getCardEl(pos);
  if (!el) return;
  el.classList.remove('flipped', 'steal-glow');
}

function markCardCaptured(pos, captorId) {
  grid[pos].captured = true;
  grid[pos].capturedBy = captorId;
  const el = getCardEl(pos);
  if (!el) return;
  el.classList.add('captured');
  el.classList.remove('steal-glow', 'clickable');
}

// ── Click handling ───────────────────────────────────────────────
function onCardClick(pos) {
  if (gamePhase !== 'playing') return;
  const card = grid[pos];
  if (!card || card.captured || card.faceUp) return;

  if (stealSelectMode) {
    // Attempting a steal — send to server
    stealSelectMode = false;
    setStealSelectVisual(false);
    wsSend({ type: 'md-steal-attempt', pos });
    return;
  }

  if (turnId !== myId) return;
  if (turnPhase !== 'idle' && turnPhase !== 'second-flip') return;

  wsSend({ type: 'md-flip', pos });
}

// ── Steal window UI ──────────────────────────────────────────────
let stealRingInterval = null;

function openStealWindow(durationMs) {
  stealWindowActive = true;
  stealWindowMs = durationMs;
  const CIRC = 169.6; // 2π × 27
  stealRingFg.style.strokeDashoffset = 0;
  stealRingFg.style.transition = 'none';

  if (stealRingInterval) clearInterval(stealRingInterval);
  const start = Date.now();
  stealRingInterval = setInterval(() => {
    const elapsed = Date.now() - start;
    const progress = Math.min(elapsed / durationMs, 1);
    stealRingFg.style.strokeDashoffset = CIRC * progress;
    // Color shift green→yellow→red
    const hue = Math.round(120 * (1 - progress));
    stealRingFg.style.stroke = `hsl(${hue},90%,55%)`;
    if (progress >= 1) closeStealWindowUI();
  }, 30);
}

function closeStealWindowUI() {
  stealWindowActive = false;
  stealSelectMode = false;
  if (stealRingInterval) { clearInterval(stealRingInterval); stealRingInterval = null; }
  stealRingFg.style.strokeDashoffset = 169.6;
  stealBtn.disabled = true;
  stealBtn.classList.remove('active-window', 'selecting-mode');
  stealHint.textContent = '';
  stealHint.className = 'steal-hint';
  setStealSelectVisual(false);
}

function setStealSelectVisual(on) {
  cardGrid.querySelectorAll('.card:not(.captured)').forEach(el => {
    const pos = Number(el.dataset.pos);
    const g = grid[pos];
    if (!g || g.faceUp || g.captured) return;
    el.classList.toggle('steal-select-hover', on);
  });
  if (on) {
    stealBtn.classList.add('selecting-mode');
    stealBtn.classList.remove('active-window');
    stealHint.textContent = '👆 Click the matching card!';
    stealHint.className = 'steal-hint selecting';
  }
}

// ── Clickable card highlighting ──────────────────────────────────
function updateClickableCards() {
  cardGrid.querySelectorAll('.card').forEach(el => el.classList.remove('clickable'));
  if (gamePhase !== 'playing') return;
  if (turnId === myId && (turnPhase === 'idle' || turnPhase === 'second-flip')) {
    cardGrid.querySelectorAll('.card:not(.captured):not(.flipped)').forEach(el => el.classList.add('clickable'));
  } else if (stealSelectMode) {
    cardGrid.querySelectorAll('.card:not(.captured)').forEach(el => {
      const pos = Number(el.dataset.pos);
      if (!grid[pos]?.faceUp && !grid[pos]?.captured) el.classList.add('clickable');
    });
  }
}

// ── Turn banner ──────────────────────────────────────────────────
function setTurnBanner(text, cls) {
  turnBanner.textContent = text;
  turnBanner.className = 'turn-banner' + (cls ? ' ' + cls : '');
}

function updateTurnUI() {
  if (gamePhase !== 'playing') return;
  if (turnId === myId) {
    if (turnPhase === 'steal-window') {
      setTurnBanner('Your turn · Opponent may steal!', 'steal-active');
    } else {
      setTurnBanner('Your Turn!', '');
    }
  } else {
    const opp = players.get(turnId);
    if (turnPhase === 'steal-window') {
      setTurnBanner(`${opp?.name || 'Opponent'}'s turn · STEAL available!`, 'steal-active');
    } else {
      setTurnBanner(`${opp?.name || 'Opponent'}'s turn`, 'opponent');
    }
  }
  updateClickableCards();
}

// ── Ghost mode flash ─────────────────────────────────────────────
function flashGhost() {
  if (!cfg.ghostMode || revealedHistory.size === 0) return;
  ghostOverlay.innerHTML = '';
  ghostOverlay.className = 'ghost-overlay grid-' + gridCols + 'x' + gridRows;
  ghostOverlay.style.gridTemplateColumns = `repeat(${gridCols}, 1fr)`;
  ghostOverlay.style.display = 'grid';

  for (let i = 0; i < gridCols * gridRows; i++) {
    const div = document.createElement('div');
    div.className = 'ghost-card';
    const h = revealedHistory.get(i);
    if (h && !grid[i]?.captured) {
      const d = cardDisplay(h.value, h.emoji, h.color, cfg.cardTheme);
      div.style.background = d.bg + '99';
      div.textContent = d.text;
    } else {
      div.style.background = 'transparent';
      div.style.border = 'none';
    }
    ghostOverlay.appendChild(div);
  }

  setTimeout(() => {
    ghostOverlay.style.display = 'none';
    ghostOverlay.innerHTML = '';
  }, 500);
}

// ── Float text ───────────────────────────────────────────────────
function spawnFloatText(text, color, x, y) {
  const el = document.createElement('div');
  el.className = 'float-text';
  el.style.left = x + 'px';
  el.style.top = y + 'px';
  el.style.color = color;
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 1400);
}

function getCardCenter(pos) {
  const el = getCardEl(pos);
  if (!el) return { x: window.innerWidth / 2, y: window.innerHeight / 2 };
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

// ── WS ───────────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    const pw = sessionStorage.getItem('arena-room-password') || undefined;
    sessionStorage.removeItem('arena-room-password');
    wsSend({ type: 'join-room', roomId, name: myName, password: pw, token: sessionStorage.getItem('arena-token') || '' });
  };
  ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch(err) { console.error(err); } };
  ws.onclose = () => { statusEl.textContent = 'Disconnected. Returning to lobby…'; setTimeout(() => { location.href = '/'; }, 3000); };
}

function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

// ── Message handler ──────────────────────────────────────────────
function handleMsg(msg) {
  switch (msg.type) {
    case 'room-joined': {
      myId = msg.myId;
      leaderId = msg.leaderId;
      players.set(myId, { name: myName });
      for (const p of msg.players) players.set(p.id, { name: p.name });
      isHost = (myId === leaderId);
      renderPlayerList();
      updateLobbyUI();
      statusEl.textContent = `Room ${roomId} · ${players.size} player(s)`;
      break;
    }
    case 'player-joined': {
      players.set(msg.id, { name: msg.name });
      leaderId = msg.leaderId;
      isHost = (myId === leaderId);
      renderPlayerList();
      updateLobbyUI();
      statusEl.textContent = `${msg.name} joined.`;
      break;
    }
    case 'player-left': {
      players.delete(msg.id);
      renderPlayerList();
      updateLobbyUI();
      break;
    }
    case 'error': {
      alert(msg.msg);
      location.href = '/';
      break;
    }

    // Config sync
    case 'md-lobby-config': {
      applyRemoteCfg(msg);
      break;
    }

    // Game start
    case 'md-go': {
      gridCols = msg.cols;
      gridRows = msg.rows;
      totalPairs = msg.pairCount;
      pairsRemaining = msg.pairCount;
      stealWindowMs = msg.stealWindowMs;
      cfg.ghostMode = !!msg.ghostMode;
      cfg.cardTheme = msg.cardTheme || 'emoji';
      scores = { ...msg.scores };
      streaks = {};
      for (const pid of players.keys()) streaks[pid] = 0;
      turnId = msg.turnId;
      turnPhase = 'idle';
      firstFlippedPos = null;
      firstFlippedValue = null;
      stealWindowActive = false;
      stealSelectMode = false;
      myPenaltyNext = false;
      revealedHistory.clear();
      gamePhase = 'playing';

      lobbyArea.style.display = 'none';
      gameArea.style.display = 'flex';
      scorePanel.style.display = '';

      buildGrid(gridCols, gridRows);
      renderPlayerList();
      renderScores();
      updateTurnUI();
      closeStealWindowUI();
      penaltyNotice.style.display = 'none';

      // Ghost flash on turn start
      if (turnId === myId && cfg.ghostMode) flashGhost();
      break;
    }

    // Card revealed (server validated flip)
    case 'md-card-revealed': {
      const { pos, value, emoji, color } = msg;
      flipCardFaceUp(pos, value, emoji, color);
      revealedHistory.set(pos, { value, emoji, color });

      if (firstFlippedPos === null) {
        firstFlippedPos = pos;
        firstFlippedValue = value;
      }
      updateTurnUI();
      break;
    }

    // Steal window
    case 'md-steal-window-open': {
      turnPhase = 'steal-window';
      const { pos } = msg;
      // Glow first card
      const el = getCardEl(pos);
      if (el) el.classList.add('steal-glow');

      if (turnId !== myId) {
        // I'm the inactive player — activate steal button
        stealWindowActive = true;
        stealBtn.disabled = false;
        stealBtn.classList.add('active-window');
        stealHint.textContent = 'Click STEAL then pick the matching card!';
        stealHint.className = 'steal-hint active';
        openStealWindow(msg.durationMs || stealWindowMs);
      } else {
        // I'm active player — show info
        openStealWindow(msg.durationMs || stealWindowMs);
        stealBtn.disabled = true;
      }
      updateTurnUI();
      break;
    }
    case 'md-steal-window-close': {
      turnPhase = 'second-flip';
      closeStealWindowUI();
      // Remove glow from first card
      if (firstFlippedPos !== null) {
        const el = getCardEl(firstFlippedPos);
        if (el) el.classList.remove('steal-glow');
      }
      updateTurnUI();
      break;
    }

    // Steal success
    case 'md-steal-success': {
      turnPhase = 'resolving';
      closeStealWindowUI();
      scores = { ...msg.newScores };
      streaks[msg.stealerId] = msg.streak || 0;
      if (msg.stealerId !== myId) streaks[myId] = 0;
      pairsRemaining--;

      const [p1, p2] = msg.positions;
      const el1 = getCardEl(p1), el2 = getCardEl(p2);
      if (el1) el1.classList.remove('steal-glow');
      if (el2) el2.classList.remove('steal-glow');
      flipCardFaceUp(p1, msg.value, msg.emoji, msg.color);
      flipCardFaceUp(p2, msg.value, msg.emoji, msg.color);

      setTimeout(() => {
        markCardCaptured(p1, msg.stealerId);
        markCardCaptured(p2, msg.stealerId);
        renderScores();
        renderPlayerList();
      }, 700);

      // Float text
      const center = getCardCenter(p1);
      const isMeSteal = msg.stealerId === myId;
      if (msg.isPerfectSteal) {
        spawnFloatText('⚡ PERFECT STEAL! +' + msg.bonus, '#f59e0b', center.x, center.y - 40);
      } else {
        spawnFloatText(isMeSteal ? '🎉 STEAL! +' + msg.bonus : `${msg.stealerName} STEALS!`, '#f59e0b', center.x, center.y - 40);
      }

      if (msg.stealerId === myId && !msg.isPerfectSteal) {
        // Show a +steal indicator
      }

      firstFlippedPos = null;
      firstFlippedValue = null;
      break;
    }

    // Steal failed
    case 'md-steal-failed': {
      const { attempterId, wrongPos } = msg;
      if (attempterId === myId) {
        myPenaltyNext = true;
        penaltyNotice.style.display = '';
      }
      const el = getCardEl(wrongPos);
      if (el) {
        el.classList.add('wrong-steal');
        setTimeout(() => el.classList.remove('wrong-steal'), 600);
      }
      // Steal window already closed by server; md-steal-window-close follows shortly
      break;
    }

    // Pair captured (active player match)
    case 'md-pair-captured': {
      turnPhase = 'resolving';
      scores = { ...msg.newScores };
      streaks[msg.captorId] = msg.streak || 0;
      pairsRemaining--;

      const [p1, p2] = msg.positions;
      setTimeout(() => {
        markCardCaptured(p1, msg.captorId);
        markCardCaptured(p2, msg.captorId);
        renderScores();
        renderPlayerList();
      }, 400);

      if (msg.bonus > 0) {
        const center = getCardCenter(p1);
        spawnFloatText(`🔥 STREAK ×${msg.streak} +${msg.bonus}`, '#a78bfa', center.x, center.y - 30);
      }

      firstFlippedPos = null;
      firstFlippedValue = null;
      break;
    }

    // No match
    case 'md-no-match': {
      const [p1, p2] = msg.positions;
      setTimeout(() => {
        flipCardFaceDown(p1);
        flipCardFaceDown(p2);
        firstFlippedPos = null;
        firstFlippedValue = null;
        turnPhase = 'idle';
        updateTurnUI();
      }, 1500);
      break;
    }

    // Turn change
    case 'md-turn-change': {
      if (msg.skipped) {
        // Show skip notification briefly
        const skippedName = players.get(msg.activeId)?.name || 'Player';
        setTurnBanner(`⚠️ ${msg.activeId === myId ? 'Your' : skippedName + "'s"} turn skipped!`, 'skipped');
        if (msg.activeId === myId) {
          penaltyNotice.style.display = '';
          setTimeout(() => { penaltyNotice.style.display = 'none'; }, 2500);
        }
        return; // Wait for the follow-up md-turn-change without skipped flag
      }
      turnId = msg.activeId;
      turnPhase = 'idle';
      firstFlippedPos = null;
      firstFlippedValue = null;
      stealWindowActive = false;
      stealSelectMode = false;
      closeStealWindowUI();

      if (msg.activeId === myId) {
        myPenaltyNext = false;
        penaltyNotice.style.display = 'none';
        if (cfg.ghostMode) setTimeout(flashGhost, 200);
      }

      renderPlayerList();
      updateTurnUI();
      break;
    }

    // Game over
    case 'md-game-over': {
      gamePhase = 'ended';
      showResult(msg);
      if (msg.winnerId === myId) reportScore('memoryduel', 1);
      break;
    }

    // Opponent left mid-game
    case 'md-opponent-left': {
      gamePhase = 'ended';
      const oppLeft = [...players.entries()].find(([pid]) => pid !== myId);
      const banner = oppLeft ? `${oppLeft[1].name} disconnected. You win!` : 'Opponent disconnected.';
      turnBanner.textContent = banner;
      if (msg.winnerId === myId) {
        setTimeout(() => showResultSimple('You Win!', '🏆'), 1500);
        reportScore('memoryduel', 1);
      }
      break;
    }
  }
}

// ── Result screen ────────────────────────────────────────────────
function showResult(msg) {
  const { winnerId, winnerName, scores: finalScores, stats } = msg;
  const iWon = winnerId === myId;
  resultTrophy.textContent = iWon ? '🏆' : '😤';
  resultTitle.textContent = iWon ? 'You Win!' : `${winnerName} Wins!`;

  resultScores.innerHTML = '';
  for (const [pid, p] of players) {
    const div = document.createElement('div');
    div.className = 'result-score-item' + (pid === winnerId ? ' winner' : '');
    div.innerHTML = `<span class="rs-name">${escHtml(p.name)}</span><span class="rs-pts">${finalScores[pid] || 0}</span>`;
    resultScores.appendChild(div);
  }

  let statsHtml = '';
  for (const [pid, p] of players) {
    const s = stats[pid] || {};
    statsHtml += `<div><strong>${escHtml(p.name)}</strong>: ${s.stealAttempts || 0} steal attempts · ${s.stealSuccesses || 0} successes · ${s.stealFailures || 0} failures · longest streak ${s.longestStreak || 0}</div>`;
  }
  resultStats.innerHTML = statsHtml;
  resultOverlay.style.display = 'flex';
}

function showResultSimple(title, trophy) {
  resultTrophy.textContent = trophy;
  resultTitle.textContent = title;
  resultScores.innerHTML = '';
  resultStats.innerHTML = '';
  resultOverlay.style.display = 'flex';
}

// ── Lobby UI ─────────────────────────────────────────────────────
function updateLobbyUI() {
  isHost = (myId === leaderId);
  if (gamePhase !== 'lobby') return;
  lobbyConfig.style.display = isHost ? '' : 'none';
  btnStart.style.display = isHost && players.size >= 2 ? '' : 'none';
  waitingHint.style.display = !isHost ? '' : 'none';
  // Disable/enable config buttons for non-host
  lobbyConfig.querySelectorAll('.cfg-btn').forEach(b => { b.style.opacity = isHost ? '' : '.5'; b.style.pointerEvents = isHost ? '' : 'none'; });
}

// ── Event listeners ──────────────────────────────────────────────
btnBack.addEventListener('click', () => { location.href = '/'; });

btnStart.addEventListener('click', () => {
  cfg = readConfig();
  wsSend({ type: 'md-lobby-config', ...cfg });
  wsSend({ type: 'md-start' });
});

stealBtn.addEventListener('click', () => {
  if (!stealWindowActive) return;
  if (turnId === myId) return;
  if (stealSelectMode) {
    // Cancel steal select mode
    stealSelectMode = false;
    setStealSelectVisual(false);
    stealBtn.classList.remove('selecting-mode');
    stealBtn.classList.add('active-window');
    stealHint.textContent = 'Click STEAL then pick the matching card!';
    stealHint.className = 'steal-hint active';
  } else {
    stealSelectMode = true;
    setStealSelectVisual(true);
  }
  updateClickableCards();
});

btnPlayAgain.addEventListener('click', () => {
  resultOverlay.style.display = 'none';
  location.href = '/';
});

btnRules.addEventListener('click', () => { rulesOverlay.style.display = 'flex'; });
btnCloseRules.addEventListener('click', () => { rulesOverlay.style.display = 'none'; });
rulesOverlay.addEventListener('click', e => { if (e.target === rulesOverlay) rulesOverlay.style.display = 'none'; });

btnToggle.addEventListener('click', () => {
  const sb = $('sidebar');
  sb.classList.toggle('open');
});

// ── Init ─────────────────────────────────────────────────────────
setupConfigControls();
connect();

})();

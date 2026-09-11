(() => {
'use strict';

// ── Setup ────────────────────────────────────────────────────────
const params  = new URLSearchParams(location.search);
const roomId  = params.get('room');
const myName  = sessionStorage.getItem('arena-name') || 'Player';
if (!roomId) { location.href = '/'; return; }

const $  = id => document.getElementById(id);
const playerListEl   = $('playerList');
const playerCountEl  = $('playerCount');
const roomBadge      = $('roomBadge');
const btnBack        = $('btnBack');
const btnStart       = $('btnStart');
const btnRules       = $('btnRules');
const btnToggleSidebar = $('btnToggleSidebar');
const sidebar        = $('sidebar');

const lobbyScreen    = $('lobbyScreen');
const gameScreen     = $('gameScreen');
const configGroup    = $('configGroup');
const waitingMsg     = $('waitingMsg');

const opponentsArea  = $('opponentsArea');
const chainRow       = $('chainRow');
const chainEndLeft   = $('chainEndLeft');
const chainEndRight  = $('chainEndRight');
const chainScroll    = $('chainScroll');
const boneyardCount  = $('boneyardCount');
const boneyardArea   = $('boneyardArea');
const turnBanner     = $('turnBanner');
const actionBar      = $('actionBar');
const btnDraw        = $('btnDraw');
const btnPass        = $('btnPass');
const btnCancelSel   = $('btnCancelSel');
const handTray       = $('handTray');
const handLabel      = $('handLabel');
const scorePanel     = $('scorePanel');

const roundSummaryOverlay = $('roundSummaryOverlay');
const matchOverOverlay    = $('matchOverOverlay');
const rulesOverlay        = $('rulesOverlay');
const btnNextRound        = $('btnNextRound');
const btnRematch          = $('btnRematch');
const btnMatchBack        = $('btnMatchBack');

roomBadge.textContent = 'Room ' + roomId;
btnBack.addEventListener('click', () => { location.href = '/'; });
btnMatchBack.addEventListener('click', () => { location.href = '/'; });
btnRules.addEventListener('click', () => { rulesOverlay.style.display = 'flex'; });
$('btnCloseRules').addEventListener('click', () => { rulesOverlay.style.display = 'none'; });
btnToggleSidebar.addEventListener('click', () => sidebar.classList.toggle('open'));

// ── Pip layout (positions as [x%, y%] within a half) ────────────
const PIP_POS = {
  0: [],
  1: [[50,50]],
  2: [[28,72],[72,28]],
  3: [[28,72],[50,50],[72,28]],
  4: [[28,28],[72,28],[28,72],[72,72]],
  5: [[28,28],[72,28],[50,50],[28,72],[72,72]],
  6: [[28,22],[72,22],[28,50],[72,50],[28,78],[72,78]],
};

function buildHalf(value) {
  const div = document.createElement('div');
  div.className = 'domino-half';
  for (const [x,y] of (PIP_POS[value] || [])) {
    const pip = document.createElement('div');
    pip.className = 'pip';
    pip.style.left  = x + '%';
    pip.style.top   = y + '%';
    div.appendChild(pip);
  }
  return div;
}

// Build a tile DOM element. left/right = pip values for the two halves.
// `cls` extra classes e.g. 'chain-tile' or 'hand-tile'
// `isDouble` = true if left === right
function buildTile(left, right, cls = '') {
  const el = document.createElement('div');
  const isDouble = (left === right);
  el.className = 'domino ' + cls + (isDouble ? ' dbl' : '');
  el.dataset.left  = left;
  el.dataset.right = right;
  el.appendChild(buildHalf(left));
  el.appendChild(buildHalf(right));
  return el;
}

function buildFaceDownTile(cls = '') {
  const el = document.createElement('div');
  el.className = 'domino face-down ' + cls;
  el.appendChild(document.createElement('div')); // empty halves
  el.appendChild(document.createElement('div'));
  return el;
}

// ── State ────────────────────────────────────────────────────────
let ws = null, myId = null, leaderId = null;
const players = new Map(); // id → { name }
let gamePhase = 'lobby';  // lobby | deal | playing | round-summary | match-over

// Round state
let myHand = [];           // [{a,b}] — my tiles
let chain = [];            // [{left,right}] — chain tiles
let leftEnd  = null;
let rightEnd = null;
let boneyardCnt = 0;
let handSizes = {};        // { [id]: number }
let turnOrder = [];        // [id, ...]
let currentTurn = null;
let matchScores = {};      // { [id]: number }
let configTarget = 150;
let mustPlayTile = null;   // {a,b} forced first tile
let selectedIdx  = null;   // index in myHand
let roundHistory = [];
let roundNumber  = 1;

// Drag & touch state
let dragIdx = null;
let touchDragIdx = null, touchClone = null;

// ── Host / config ────────────────────────────────────────────────
function isHost()  { return leaderId === myId; }
function myTurn()  { return currentTurn === myId; }

function renderPlayerList() {
  playerListEl.innerHTML = '';
  playerCountEl.textContent = players.size;
  for (const [pid, p] of players) {
    const el = document.createElement('div');
    el.className = 'player-item' + (pid === myId ? ' is-me' : '') + (pid === leaderId ? ' is-host' : '');
    el.textContent = p.name;
    playerListEl.appendChild(el);
  }
  if (isHost()) { btnStart.style.display = ''; waitingMsg.style.display = 'none'; }
  else          { btnStart.style.display = 'none'; waitingMsg.style.display = players.size > 1 ? '' : 'none'; }
  // Host-only config group
  if (configGroup) configGroup.style.display = isHost() ? '' : 'none';
}

// Config buttons
document.querySelectorAll('.cfg-btn').forEach(b => {
  b.addEventListener('click', () => {
    const cfg = b.dataset.cfg, val = parseInt(b.dataset.val);
    document.querySelectorAll(`.cfg-btn[data-cfg="${cfg}"]`).forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    if (cfg === 'target') configTarget = val;
    if (isHost()) wsSend({ type: 'domino-config', target: configTarget });
  });
});

btnStart.addEventListener('click', () => {
  if (!isHost() || players.size < 2) return;
  wsSend({ type: 'domino-start', target: configTarget });
});

// ── Score panel ──────────────────────────────────────────────────
function renderScorePanel() {
  const rows = [...players.entries()].map(([id, p]) => {
    const s = matchScores[id] || 0;
    return { id, name: p.name, score: s };
  }).sort((a,b) => b.score - a.score);
  const max = Math.max(...rows.map(r => r.score), 1);
  scorePanel.innerHTML = `
    <div class="sp-title">MATCH SCORES</div>
    ${rows.map((r,i) => `
      <div class="sp-row">
        <span class="sp-name">${escHtml(r.name)}</span>
        <span class="sp-score${i===0?' leader':''}">${r.score}</span>
      </div>`).join('')}
    <div class="sp-target">Target: ${configTarget}</div>`;
}

// ── Opponent panels ───────────────────────────────────────────────
function renderOpponents() {
  opponentsArea.innerHTML = '';
  for (const id of turnOrder) {
    if (id === myId) continue;
    const p = players.get(id);
    if (!p) continue;
    const cnt = handSizes[id] ?? 7;
    const panel = document.createElement('div');
    panel.className = 'opponent-panel' + (currentTurn === id ? ' active-turn' : '');
    panel.id = 'opp-' + id;

    const initial = (p.name[0] || '?').toUpperCase();
    const color = playerColor(id);
    const tilesHtml = Array.from({length: Math.min(cnt, 14)}, () =>
      '<div class="opp-tile-back"></div>').join('');

    panel.innerHTML = `
      <div class="opp-avatar" style="background:${color}">${initial}</div>
      <div class="opp-info">
        <div class="opp-name">${escHtml(p.name)}</div>
        <div class="opp-tiles">${cnt} tile${cnt!==1?'s':''}</div>
        <div class="opp-hand">${tilesHtml}</div>
      </div>`;
    opponentsArea.appendChild(panel);
  }
}

function updateOpponentPanel(id) {
  const panel = $('opp-' + id);
  if (!panel) { renderOpponents(); return; }
  const p = players.get(id);
  const cnt = handSizes[id] ?? 0;
  panel.className = 'opponent-panel' + (currentTurn === id ? ' active-turn' : '');
  const tilesHtml = Array.from({length: Math.min(cnt,14)}, () => '<div class="opp-tile-back"></div>').join('');
  panel.querySelector('.opp-tiles').textContent = cnt + ' tile' + (cnt!==1?'s':'');
  panel.querySelector('.opp-hand').innerHTML = tilesHtml;
}

function updateAllOpponentPanels() {
  for (const [id] of players) {
    if (id !== myId) updateOpponentPanel(id);
  }
}

// ── Hand tray ────────────────────────────────────────────────────
function renderHand() {
  handTray.innerHTML = '';
  handLabel.textContent = myTurn() ? '↑ Your turn — drag or tap a tile' : 'Your tiles';
  myHand.forEach((tile, idx) => {
    const playable = myTurn() && canPlayTile(tile);
    const isMustPlay = mustPlayTile && tile.a === mustPlayTile.a && tile.b === mustPlayTile.b;
    const isSel = idx === selectedIdx;

    const el = buildTile(tile.a, tile.b, 'hand-tile tile-enter');
    el.style.animationDelay = (idx * 40) + 'ms';
    if (!myTurn() || !playable) el.classList.add('inactive');
    else if (isMustPlay)        el.classList.add('must-play');
    if (isSel) el.classList.add('selected');

    if (myTurn() && playable) {
      el.setAttribute('draggable', 'true');

      el.addEventListener('click', () => {
        if (chain.length === 0) {
          // First tile of the round — play directly, no end selection
          playTileFromHand(idx, 'right');
        } else if (isSel) {
          deselect();
        } else {
          selectTile(idx);
        }
      });

      el.addEventListener('dragstart', e => {
        dragIdx = idx;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(idx));
        activateDropZones(idx);
        setTimeout(() => { el.style.opacity = '0.35'; }, 0);
      });

      el.addEventListener('dragend', () => {
        el.style.opacity = '';
        if (dragIdx !== null) { dragIdx = null; deactivateDropZones(); }
        if (selectedIdx === null) renderHand();
      });

      // Touch: first tile auto-plays; subsequent tiles begin touch-drag
      el.addEventListener('touchstart', e => {
        if (!myTurn() || !playable) return;
        if (chain.length === 0) { playTileFromHand(idx, 'right'); return; }
        touchDragIdx = idx;
        activateDropZones(idx);
        const rect = el.getBoundingClientRect();
        const t = e.touches[0];
        touchClone = el.cloneNode(true);
        touchClone._offX = t.clientX - rect.left;
        touchClone._offY = t.clientY - rect.top;
        touchClone.style.cssText = `position:fixed;z-index:9999;pointer-events:none;opacity:.85;width:${rect.width}px;height:${rect.height}px;left:${t.clientX - touchClone._offX}px;top:${t.clientY - touchClone._offY}px;`;
        document.body.appendChild(touchClone);
        e.preventDefault();
      }, { passive: false });
    }
    handTray.appendChild(el);
  });
}

function canPlayTile(tile) {
  if (chain.length === 0) return true;
  return tile.a === leftEnd || tile.b === leftEnd || tile.a === rightEnd || tile.b === rightEnd;
}

function hasAnyPlayable() {
  return myHand.some(t => canPlayTile(t));
}

function playTileFromHand(idx, end) {
  const tile = myHand[idx];
  if (!tile) return;
  selectedIdx = null;
  dragIdx = null;
  touchDragIdx = null;
  deactivateDropZones();
  renderHand();
  updateActionBar();
  wsSend({ type: 'domino-play', tileA: tile.a, tileB: tile.b, end });
}

function activateDropZones(tileIdx) {
  const tile = myHand[tileIdx];
  if (!tile) return;
  if (chain.length === 0) {
    chainEndLeft.classList.add('active', 'drop-ready');
    chainEndRight.classList.add('active', 'drop-ready');
    $('feltTable').classList.add('drop-zone');
  } else {
    if (tile.a === leftEnd  || tile.b === leftEnd)  chainEndLeft.classList.add('active', 'drop-ready');
    if (tile.a === rightEnd || tile.b === rightEnd) chainEndRight.classList.add('active', 'drop-ready');
  }
}

function deactivateDropZones() {
  chainEndLeft.classList.remove('active', 'drop-ready', 'drag-over');
  chainEndRight.classList.remove('active', 'drop-ready', 'drag-over');
  const ft = $('feltTable');
  if (ft) ft.classList.remove('drop-zone', 'drag-over-table');
}

function selectTile(idx) {
  selectedIdx = idx;
  activateDropZones(idx);
  renderHand();
  btnCancelSel.style.display = '';
  btnDraw.style.display = 'none';
  btnPass.style.display = 'none';
  actionBar.style.display = 'flex';
}

function deselect() {
  selectedIdx = null;
  deactivateDropZones();
  renderHand();
  updateActionBar();
}

function updateActionBar() {
  if (!myTurn()) {
    actionBar.style.display = 'none';
    return;
  }
  actionBar.style.display = 'flex';
  const canPlay = hasAnyPlayable();

  if (selectedIdx !== null) {
    btnDraw.style.display = 'none';
    btnPass.style.display = 'none';
    btnCancelSel.style.display = '';
  } else {
    btnCancelSel.style.display = 'none';
    btnDraw.style.display = (!canPlay && boneyardCnt > 0) ? '' : 'none';
    btnPass.style.display = (!canPlay && boneyardCnt === 0) ? '' : 'none';
  }
}

btnCancelSel.addEventListener('click', deselect);
btnDraw.addEventListener('click', () => { wsSend({ type: 'domino-draw' }); });
btnPass.addEventListener('click', () => { wsSend({ type: 'domino-pass' }); });

// Drop zone setup on chain ends and felt table
function setupDropZone(zone) {
  zone.addEventListener('click', () => {
    if (!zone.classList.contains('drop-ready')) return;
    if (selectedIdx !== null) { playTileFromHand(selectedIdx, zone.dataset.end); }
  });
  zone.addEventListener('dragover', e => {
    if (!zone.classList.contains('drop-ready')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    zone.classList.add('drag-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag-over'));
  zone.addEventListener('drop', e => {
    e.preventDefault();
    zone.classList.remove('drag-over');
    if (dragIdx === null) return;
    playTileFromHand(dragIdx, zone.dataset.end);
  });
}
setupDropZone(chainEndLeft);
setupDropZone(chainEndRight);

// Felt table: drop zone for the very first tile
(function() {
  const ft = $('feltTable');
  ft.addEventListener('dragover', e => {
    if (dragIdx === null || chain.length !== 0) return;
    e.preventDefault();
    ft.classList.add('drag-over-table');
  });
  ft.addEventListener('dragleave', () => ft.classList.remove('drag-over-table'));
  ft.addEventListener('drop', e => {
    e.preventDefault();
    ft.classList.remove('drag-over-table');
    if (dragIdx === null || chain.length !== 0) return;
    playTileFromHand(dragIdx, 'right');
  });
}());

// ── Chain rendering ───────────────────────────────────────────────
function renderChain() {
  chainRow.innerHTML = '';
  for (let i = 0; i < chain.length; i++) {
    const { left, right } = chain[i];
    const el = buildTile(left, right, 'chain-tile');
    chainRow.appendChild(el);
  }
  // Update end indicators
  if (chain.length > 0) {
    chainEndLeft.textContent  = leftEnd;
    chainEndRight.textContent = rightEnd;
  } else {
    chainEndLeft.textContent  = '';
    chainEndRight.textContent = '';
  }
  if (myTurn() && selectedIdx !== null) highlightValidEnds();
}

function appendChainTile(left, right, side) {
  const el = buildTile(left, right, 'chain-tile tile-enter');
  if (side === 'left') chainRow.prepend(el);
  else chainRow.appendChild(el);
  // Update end text
  chainEndLeft.textContent  = leftEnd;
  chainEndRight.textContent = rightEnd;
  // Scroll to show new tile
  requestAnimationFrame(() => {
    if (side === 'left') chainScroll.scrollLeft = 0;
    else chainScroll.scrollLeft = chainScroll.scrollWidth;
  });
}

// ── Turn indicator ────────────────────────────────────────────────
function updateTurnBanner() {
  if (gamePhase !== 'playing') { turnBanner.textContent = ''; return; }
  if (myTurn()) {
    turnBanner.textContent = '⭐ Your Turn';
    turnBanner.className = 'turn-banner my-turn';
  } else {
    const p = players.get(currentTurn);
    turnBanner.textContent = p ? `${p.name}'s turn` : '…';
    turnBanner.className = 'turn-banner';
  }
}

function updateBoneyard() {
  boneyardCount.textContent = boneyardCnt;
  boneyardArea.classList.toggle('empty', boneyardCnt === 0);
}

// ── Round summary overlay ─────────────────────────────────────────
let rsTimer = null;

function showRoundSummary(msg) {
  gamePhase = 'round-summary';
  roundHistory.push({ round: roundNumber, winnerId: msg.winnerId, scores: { ...msg.matchScores } });

  $('rsHeader').innerHTML = msg.winnerId === myId
    ? '🎉 You won the round!'
    : `<span style="color:var(--text-dim)">${escHtml(players.get(msg.winnerId)?.name || '?')} won the round!</span>`;

  // Build hands table
  const rows = Object.entries(msg.allHands || {}).map(([id, pips]) => {
    const isWinner = id === msg.winnerId;
    const name = players.get(id)?.name || id;
    return `<div class="rs-row">
      <span class="rs-pname${isWinner?' winner':''}">${escHtml(name)}${isWinner?' 🏆':''}</span>
      <span class="rs-pips">${pips} pips</span>
      <span class="rs-pts">${isWinner ? '+'+msg.roundScore : ''}</span>
    </div>`;
  }).join('');
  $('rsTable').innerHTML = rows;

  // Updated scores
  const scoreRows = Object.entries(msg.matchScores).map(([id, s]) => {
    const name = players.get(id)?.name || id;
    return `<div class="rs-score-row"><span>${escHtml(name)}</span><span style="font-family:Orbitron,sans-serif;color:var(--accent-g)">${s}</span></div>`;
  }).join('');
  $('rsScores').innerHTML = `<div style="font-size:.75rem;color:var(--text-dim);margin-bottom:.4rem">MATCH SCORES</div>` + scoreRows;

  // Progress bar for leader
  const maxScore = Math.max(...Object.values(msg.matchScores), 0);
  $('rsProgress').innerHTML = `
    <div style="font-size:.72rem;color:var(--text-dim);margin-bottom:.3rem">Leader: ${maxScore} / ${configTarget}</div>
    <div class="progress-bar-bg"><div class="progress-bar-fill" style="width:${Math.min(100, maxScore/configTarget*100)}%"></div></div>`;

  roundSummaryOverlay.style.display = 'flex';
  let countdown = 8;
  $('rsCountdown').textContent = countdown;
  if (rsTimer) clearInterval(rsTimer);
  rsTimer = setInterval(() => {
    countdown--;
    $('rsCountdown').textContent = countdown;
    if (countdown <= 0) { clearInterval(rsTimer); rsTimer = null; startNextRound(); }
  }, 1000);
}

btnNextRound.addEventListener('click', () => {
  if (rsTimer) { clearInterval(rsTimer); rsTimer = null; }
  startNextRound();
});

function startNextRound() {
  roundSummaryOverlay.style.display = 'none';
  if (isHost()) wsSend({ type: 'domino-next-round' });
}

// ── Match over overlay ────────────────────────────────────────────
function showMatchOver(msg) {
  gamePhase = 'match-over';
  if (rsTimer) { clearInterval(rsTimer); rsTimer = null; }
  roundSummaryOverlay.style.display = 'none';

  const winnerName = players.get(msg.winnerId)?.name || '?';
  $('moWinner').textContent = msg.winnerId === myId ? '🏆 You Win!' : `${winnerName} Wins!`;
  $('moSubtitle').textContent = `Reached ${msg.finalScores[msg.winnerId]} points`;

  const scoreRows = Object.entries(msg.finalScores).sort((a,b)=>b[1]-a[1]).map(([id,s])=>
    `<div class="mo-score-row"><span>${escHtml(players.get(id)?.name||'?')}</span><span class="mo-score-val">${s}</span></div>`
  ).join('');
  $('moScores').innerHTML = scoreRows;

  // Round history table
  if (roundHistory.length) {
    const playerIds = [...players.keys()];
    const headers = ['Round', ...playerIds.map(id => escHtml(players.get(id)?.name || id))].map(h=>`<th>${h}</th>`).join('');
    const rows = roundHistory.map(r => {
      const cells = playerIds.map(id => {
        const s = r.scores[id] || 0;
        return `<td style="color:${id===r.winnerId?'var(--gold)':'var(--text-dim)'}">${s}</td>`;
      }).join('');
      return `<tr><td>R${r.round}</td>${cells}</tr>`;
    }).join('');
    $('moHistory').innerHTML = `<table><thead><tr>${headers}</tr></thead><tbody>${rows}</tbody></table>`;
  }

  matchOverOverlay.style.display = 'flex';
  if (msg.winnerId === myId) { launchConfetti(); reportScore('domino', 1); }
}

btnRematch.addEventListener('click', () => {
  wsSend({ type: 'domino-rematch' });
  btnRematch.disabled = true;
  btnRematch.textContent = 'Waiting…';
});

// ── Confetti ──────────────────────────────────────────────────────
function launchConfetti() {
  const canvas = $('confettiCanvas');
  canvas.width = innerWidth; canvas.height = innerHeight;
  const ctx = canvas.getContext('2d');
  const pieces = Array.from({length:120}, () => ({
    x: Math.random()*innerWidth, y: -20,
    vx: (Math.random()-0.5)*4, vy: Math.random()*3+2,
    r: Math.random()*6+3, color: `hsl(${Math.random()*360},80%,60%)`,
    rot: Math.random()*360, rv: (Math.random()-0.5)*5
  }));
  let frame = 0;
  function draw() {
    if (frame++ > 200) { ctx.clearRect(0,0,canvas.width,canvas.height); return; }
    ctx.clearRect(0,0,canvas.width,canvas.height);
    for (const p of pieces) {
      p.x += p.vx; p.y += p.vy; p.rot += p.rv; p.vy += 0.05;
      ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot*Math.PI/180);
      ctx.fillStyle = p.color; ctx.fillRect(-p.r,-p.r/2,p.r*2,p.r);
      ctx.restore();
    }
    requestAnimationFrame(draw);
  }
  draw();
}

// ── Deal animation ────────────────────────────────────────────────
function dealHand(hand) {
  myHand = hand;
  renderHand();
}

function addDrawnTile(tile) {
  myHand.push(tile);
  const el = buildTile(tile.a, tile.b, 'hand-tile tile-enter');
  el.style.animationDelay = '0ms';
  el.classList.add('inactive'); // will become interactive after re-render
  handTray.appendChild(el);
  setTimeout(() => renderHand(), 50);
}

// ── Transition to game screen ─────────────────────────────────────
function enterGameScreen() {

  lobbyScreen.style.display = 'none';
  gameScreen.style.display = 'flex';
  gameScreen.style.flexDirection = 'column';
  renderScorePanel();
  renderOpponents();
  renderChain();
  updateBoneyard();
  updateTurnBanner();
}

// ── Network ───────────────────────────────────────────────────────
function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    const pw = sessionStorage.getItem('arena-room-password') || undefined;
    sessionStorage.removeItem('arena-room-password');
    wsSend({ type: 'join-room', roomId, name: myName, password: pw, token: sessionStorage.getItem('arena-token') || '' });
  };
  ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch(err) { console.error(err); } };
  ws.onclose   = () => {
    if (gamePhase !== 'match-over') {
      setTimeout(() => { location.href = '/'; }, 3000);
    }
  };
}

function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function handleMsg(msg) {
  switch (msg.type) {
    case 'room-joined': {
      myId = msg.myId; leaderId = msg.leaderId;
      players.set(myId, { name: myName });
      for (const p of msg.players) players.set(p.id, { name: p.name });
      renderPlayerList();
      if (msg.dominoConfig) {
        configTarget = msg.dominoConfig.target || 150;
        document.querySelectorAll('.cfg-btn[data-cfg="target"]').forEach(b => {
          b.classList.toggle('active', parseInt(b.dataset.val) === configTarget);
        });
      }
      break;
    }
    case 'player-joined': {
      players.set(msg.id, { name: msg.name });
      leaderId = msg.leaderId;
      renderPlayerList();
      break;
    }
    case 'player-left': {
      players.delete(msg.id);
      leaderId = msg.leaderId || leaderId;
      renderPlayerList();
      if (gamePhase === 'playing') updateOpponentPanel(msg.id);
      break;
    }

    // Config sync from host
    case 'domino-config': {
      configTarget = msg.target || 150;
      document.querySelectorAll('.cfg-btn[data-cfg="target"]').forEach(b => {
        b.classList.toggle('active', parseInt(b.dataset.val) === configTarget);
      });
      break;
    }

    // Deal — round starts
    case 'domino-deal': {
      turnOrder    = msg.turnOrder.map(p => p.id);
      currentTurn  = msg.currentTurn;
      boneyardCnt  = msg.boneyardCount;
      matchScores  = msg.matchScores || {};
      roundNumber  = msg.roundNumber || 1;
      mustPlayTile = msg.mustPlayTile || null;
      chain = []; leftEnd = null; rightEnd = null;
      selectedIdx  = null; dragIdx = null; touchDragIdx = null;
      gamePhase = 'playing';

      for (const p of msg.turnOrder) handSizes[p.id] = p.handSize;

      dealHand(msg.hand);
      enterGameScreen();

      updateBoneyard();
      updateTurnBanner();
      updateAllOpponentPanels();
      updateActionBar();
      renderScorePanel();
      break;
    }

    // A tile was played on the chain
    case 'domino-played': {
      const { playerId, left, right, end, newLeftEnd, newRightEnd, handSize } = msg;
      leftEnd  = newLeftEnd;
      rightEnd = newRightEnd;
      handSizes[playerId] = handSize;

      if (playerId === myId) {
        // Remove from myHand
        const idx = myHand.findIndex(t =>
          (t.a === msg.tileA && t.b === msg.tileB) ||
          (t.a === msg.tileB && t.b === msg.tileA)
        );
        if (idx !== -1) myHand.splice(idx, 1);
        mustPlayTile = null;
        selectedIdx = null;
        renderHand();
      }

      // Append tile to chain DOM
      if (chain.length === 0) {
        chain.push({ left, right });
        renderChain();
      } else {
        chain[end === 'left' ? 'unshift' : 'push']({ left, right });
        appendChainTile(left, right, end);
      }

      currentTurn = msg.nextTurn;
      updateTurnBanner();
      updateActionBar();
      updateOpponentPanel(playerId);
      updateAllOpponentPanels();
      break;
    }

    // I drew a tile
    case 'domino-drawn': {
      boneyardCnt = msg.boneyardCount;
      updateBoneyard();
      addDrawnTile({ a: msg.tileA, b: msg.tileB });
      // After draw, update action bar
      setTimeout(() => { updateActionBar(); }, 60);
      break;
    }

    // Someone else drew
    case 'domino-draw-notify': {
      handSizes[msg.playerId] = (handSizes[msg.playerId] || 0) + 1;
      boneyardCnt = msg.boneyardCount;
      updateBoneyard();
      updateOpponentPanel(msg.playerId);
      break;
    }

    // Someone passed
    case 'domino-passed': {
      currentTurn = msg.nextTurn;
      updateTurnBanner();
      updateActionBar();
      break;
    }

    // Round ended
    case 'domino-round-over': {
      matchScores = msg.matchScores;
      renderScorePanel();
      showRoundSummary(msg);
      break;
    }

    // Match ended
    case 'domino-match-over': {
      matchScores = msg.finalScores;
      renderScorePanel();
      showMatchOver(msg);
      break;
    }

    // Rematch
    case 'domino-rematch-start': {
      matchScores = {};
      roundHistory = [];
      roundNumber  = 1;
      chain = []; leftEnd = null; rightEnd = null;
      selectedIdx = null;
      btnRematch.disabled = false;
      btnRematch.textContent = '🔄 Rematch';
      matchOverOverlay.style.display = 'none';
      // New deal will arrive as domino-deal
      break;
    }

    case 'domino-opponent-left': {
      const leaverName = players.get(msg.leftId)?.name || 'Opponent';
      if (gamePhase === 'playing' || gamePhase === 'deal') {
        turnBanner.textContent = `${leaverName} left the game`;
        turnBanner.className = 'turn-banner';
        setTimeout(() => { location.href = '/'; }, 4000);
      }
      break;
    }

    case 'error': { alert(msg.msg); location.href = '/'; break; }
  }
}

// ── Helpers ───────────────────────────────────────────────────────
const PLAYER_COLORS = ['#7c3aed','#06b6d4','#f59e0b','#10b981','#ef4444','#8b5cf6'];
function playerColor(id) {
  const ids = [...players.keys()];
  return PLAYER_COLORS[ids.indexOf(id) % PLAYER_COLORS.length] || '#7c3aed';
}
function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Touch drag move + end handlers
document.addEventListener('touchmove', e => {
  if (touchDragIdx === null) return;
  e.preventDefault();
  const t = e.touches[0];
  if (touchClone) {
    touchClone.style.left = (t.clientX - touchClone._offX) + 'px';
    touchClone.style.top  = (t.clientY - touchClone._offY) + 'px';
  }
  const under = document.elementFromPoint(t.clientX, t.clientY);
  chainEndLeft.classList.toggle('drag-over',  !!under && (chainEndLeft === under  || chainEndLeft.contains(under)));
  chainEndRight.classList.toggle('drag-over', !!under && (chainEndRight === under || chainEndRight.contains(under)));
}, { passive: false });

document.addEventListener('touchend', e => {
  if (touchDragIdx === null) return;
  if (touchClone) { document.body.removeChild(touchClone); touchClone = null; }
  const t = e.changedTouches[0];
  const under = document.elementFromPoint(t.clientX, t.clientY);
  chainEndLeft.classList.remove('drag-over');
  chainEndRight.classList.remove('drag-over');
  for (const zone of [chainEndLeft, chainEndRight]) {
    if (zone.classList.contains('drop-ready') && under && (zone === under || zone.contains(under))) {
      playTileFromHand(touchDragIdx, zone.dataset.end);
      touchDragIdx = null;
      e.preventDefault();
      return;
    }
  }
  touchDragIdx = null;
  deactivateDropZones();
  renderHand();
}, { passive: false });

connect();
})();

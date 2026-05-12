/* ═══════════════════════════════════════════════════════════════════
   BARRICADE (MALEFIZ) — Arena Room Client  |  barricade.js
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  const myName = sessionStorage.getItem('arena-name') || 'Player';
  if (!roomId) { location.href = '/'; return; }

  const $ = s => document.getElementById(s);
  const statusEl = $('status');
  const playerListEl = $('playerList'), playerCountEl = $('playerCount');
  const roomBadge = $('roomBadge'), btnBack = $('btnBack');
  const btnStartGame = $('btnStartGame'), controls = $('controls');
  const diceArea = $('diceArea'), diceCube = $('diceCube');
  const btnRoll = $('btnRoll'), turnTag = $('turnTag');
  const boardOuter = $('boardOuter'), boardGrid = $('boardGrid'), pieceLayer = $('pieceLayer');
  const barricadePlaceBar = $('barricadePlaceBar'), barricadeCountdown = $('barricadeCountdown');
  const resultOverlay = $('resultOverlay'), resultTitle = $('resultTitle');
  const resultSub = $('resultSub'), resultEmoji = $('resultEmoji');
  const btnPlayAgain = $('btnPlayAgain');
  const confettiCvs = $('confetti'), cctx = confettiCvs.getContext('2d');
  const chatMessages = $('chatMessages'), chatInput = $('chatInput'), chatSend = $('chatSend');
  const eventLog = $('eventLog'), eventLogList = $('eventLogList');
  const btnRules = $('btnRules'), rulesPanel = $('rulesPanel'), rulesClose = $('rulesClose');
  const sidebar = $('sidebar'), chatPanel = $('chatPanel'), panelBackdrop = $('panelBackdrop');
  const btnToggleSidebar = $('btnToggleSidebar'), btnToggleChat = $('btnToggleChat');

  roomBadge.textContent = 'Room ' + roomId;

  const PLAYER_COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#fbbf24'];

  // ── State ──
  let ws = null, myId = null, leaderId = null;
  const others = new Map();
  let gameActive = false, myColorIdx = -1;
  let currentTurnId = null, dieResult = null;
  let selectedPawnIdx = null;
  let placingBarricade = false, barricadePlaceTimer = null, barricadePlaceCountdownVal = 15;
  let animating = false;
  let nodes = [], nodeMap = new Map();
  let pawns = {}, barricades = [], playersInfo = [];

  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ══════════════════════════════════════════════════════════════════
  //  BOARD LAYOUT
  // ══════════════════════════════════════════════════════════════════

  function buildBoardFromLayout(layout) {
    nodes = layout.nodes;
    nodeMap.clear();
    for (const n of nodes) nodeMap.set(n.id, n);
  }

  // ══════════════════════════════════════════════════════════════════
  //  RENDERING
  // ══════════════════════════════════════════════════════════════════

  const cellEls = new Map();
  const pieceEls = new Map();

  function renderBoard() {
    boardGrid.innerHTML = '';
    pieceLayer.innerHTML = '';
    cellEls.clear();
    pieceEls.clear();

    const drawn = new Set();
    for (const n of nodes) {
      for (const nid of (n.neighbors || [])) {
        const key = [Math.min(n.id, nid), Math.max(n.id, nid)].join('-');
        if (drawn.has(key)) continue;
        drawn.add(key);
        const nb = nodeMap.get(nid);
        if (nb) drawLine(n, nb);
      }
    }

    const cellSize = 4.2;
    const aspect = 17 / 20;
    for (const n of nodes) {
      const el = document.createElement('div');
      el.className = 'bcell';
      if (n.type === 'path') el.classList.add('path');
      else if (n.type === 'house') el.classList.add('house-' + n.houseOf);
      else if (n.type === 'goal') el.classList.add('goal');
      if (n.barricadeStart) el.classList.add('barricade-start');

      const pos = nodePos(n);
      el.style.left = pos.x + '%';
      el.style.top = pos.y + '%';
      el.style.width = cellSize + '%';
      el.style.height = (cellSize * aspect) + '%';
      el.style.transform = 'translate(-50%, -50%)';
      el.dataset.nodeId = n.id;
      boardGrid.appendChild(el);
      cellEls.set(n.id, el);
    }
  }

  function nodePos(n) {
    return { x: (n.x / 16) * 100, y: (n.y / 19) * 100 };
  }

  function drawLine(a, b) {
    const pa = nodePos(a), pb = nodePos(b);
    const el = document.createElement('div');
    el.className = 'board-line';
    const dx = pb.x - pa.x, dy = pb.y - pa.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    const angle = Math.atan2(dy, dx) * 180 / Math.PI;
    el.style.left = pa.x + '%';
    el.style.top = pa.y + '%';
    el.style.width = len + '%';
    el.style.height = '2px';
    el.style.transformOrigin = '0 50%';
    el.style.transform = `rotate(${angle}deg)`;
    boardGrid.appendChild(el);
  }

  function renderPieces() {
    pieceLayer.innerHTML = '';
    pieceEls.clear();
    const cellSize = 4.2;
    const aspect = 17 / 20;
    const sz = cellSize * 0.8;

    barricades.forEach((nodeId, i) => {
      const n = nodeMap.get(nodeId);
      if (!n) return;
      const el = document.createElement('div');
      el.className = 'piece barricade';
      el.textContent = '▬';
      const pos = nodePos(n);
      el.style.width = (sz * 0.95) + '%';
      el.style.height = (sz * 0.95 * aspect) + '%';
      el.style.left = pos.x + '%';
      el.style.top = pos.y + '%';
      el.style.transform = 'translate(-50%, -50%)';
      pieceLayer.appendChild(el);
      pieceEls.set('bar-' + i, el);
    });

    for (const info of playersInfo) {
      const positions = pawns[info.id] || [];
      positions.forEach((nodeId, pi) => {
        const n = nodeMap.get(nodeId);
        if (!n) return;
        const el = document.createElement('div');
        el.className = 'piece pawn pawn-' + info.colorIdx;
        el.textContent = (pi + 1);
        const pos = nodePos(n);
        const offset = getOverlapOffset(nodeId, info.id, pi);
        el.style.width = sz + '%';
        el.style.height = (sz * aspect) + '%';
        el.style.left = (pos.x + offset.dx) + '%';
        el.style.top = (pos.y + offset.dy) + '%';
        el.style.transform = 'translate(-50%, -50%)';
        el.dataset.playerId = info.id;
        el.dataset.pawnIdx = pi;
        el.addEventListener('click', () => onPawnClick(info.id, pi));
        pieceLayer.appendChild(el);
        pieceEls.set('pawn-' + info.id + '-' + pi, el);
      });
    }
  }

  function getOverlapOffset(nodeId, playerId, pawnIdx) {
    let count = 0, myOrder = 0;
    for (const info of playersInfo) {
      const positions = pawns[info.id] || [];
      for (let i = 0; i < positions.length; i++) {
        if (positions[i] === nodeId) {
          if (info.id === playerId && i === pawnIdx) myOrder = count;
          count++;
        }
      }
    }
    if (count <= 1) return { dx: 0, dy: 0 };
    const offsets = [[-0.8, -0.6], [0.8, -0.6], [-0.8, 0.6], [0.8, 0.6], [0, 0]];
    return { dx: offsets[myOrder % 5][0], dy: offsets[myOrder % 5][1] };
  }

  // ══════════════════════════════════════════════════════════════════
  //  HIGHLIGHTING
  // ══════════════════════════════════════════════════════════════════

  function clearHighlights() {
    for (const [, el] of cellEls) {
      el.classList.remove('highlight-dest', 'highlight-pawn', 'highlight-place');
      el.onclick = null;
    }
    for (const [, el] of pieceEls) {
      el.classList.remove('selectable', 'selected');
    }
  }

  function highlightSelectablePawns(indices) {
    clearHighlights();
    for (const pi of indices) {
      const el = pieceEls.get('pawn-' + myId + '-' + pi);
      if (el) el.classList.add('selectable');
    }
  }

  function highlightDestinations(destinations) {
    for (const d of destinations) {
      const el = cellEls.get(d.nodeId);
      if (el) {
        el.classList.add('highlight-dest');
        el.onclick = () => onDestClick(d.nodeId);
      }
    }
  }

  function highlightBarricadePlacements(validNodes) {
    clearHighlights();
    for (const nid of validNodes) {
      const el = cellEls.get(nid);
      if (el) {
        el.classList.add('highlight-place');
        el.onclick = () => onBarricadePlaceClick(nid);
      }
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  PLAYER LIST
  // ══════════════════════════════════════════════════════════════════

  function updatePlayerList() {
    playerListEl.innerHTML = '';
    for (const info of playersInfo) {
      const card = document.createElement('div');
      card.className = 'player-card';
      if (info.id === myId) card.classList.add('me');
      if (info.id === currentTurnId) card.classList.add('turn');
      const homeCount = (pawns[info.id] || []).filter(nid => {
        const n = nodeMap.get(nid);
        return n && n.type === 'house';
      }).length;
      card.innerHTML = `<span class="pc-dot" style="background:${PLAYER_COLORS[info.colorIdx]}"></span>
        <span class="pc-name">${escapeHtml(info.name)}${info.id === myId ? ' (you)' : ''}</span>
        <span class="pc-info">${5 - homeCount}/5</span>`;
      playerListEl.appendChild(card);
    }
    playerCountEl.textContent = playersInfo.length;
  }

  // ══════════════════════════════════════════════════════════════════
  //  DICE
  // ══════════════════════════════════════════════════════════════════

  function initDicePips() {
    const layouts = [
      [[50,50]], [[25,25],[75,75]], [[25,25],[50,50],[75,75]],
      [[25,25],[75,25],[25,75],[75,75]], [[25,25],[75,25],[50,50],[25,75],[75,75]],
      [[25,25],[75,25],[25,50],[75,50],[25,75],[75,75]],
    ];
    for (let f = 1; f <= 6; f++) {
      const face = document.querySelector('.face-' + f);
      if (!face) continue;
      face.innerHTML = '';
      for (const [px, py] of layouts[f - 1]) {
        const pip = document.createElement('div');
        pip.className = 'pip';
        pip.style.cssText = `position:absolute;left:${px}%;top:${py}%;transform:translate(-50%,-50%)`;
        face.appendChild(pip);
      }
    }
  }

  const DICE_ROT = {
    1:'rotateX(0deg) rotateY(0deg)', 2:'rotateX(0deg) rotateY(-90deg)',
    3:'rotateX(-90deg) rotateY(0deg)', 4:'rotateX(90deg) rotateY(0deg)',
    5:'rotateX(0deg) rotateY(90deg)', 6:'rotateX(0deg) rotateY(180deg)',
  };

  function animateDice(value) {
    return new Promise(resolve => {
      diceCube.style.transition = 'transform .12s ease';
      let spins = 0;
      const spin = () => {
        diceCube.style.transform = `rotateX(${Math.random()*360|0}deg) rotateY(${Math.random()*360|0}deg)`;
        if (++spins < 8) setTimeout(spin, 70);
        else {
          diceCube.style.transition = 'transform .5s cubic-bezier(.4,0,.2,1)';
          diceCube.style.transform = DICE_ROT[value];
          setTimeout(resolve, 520);
        }
      };
      spin();
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  PIECE ANIMATION
  // ══════════════════════════════════════════════════════════════════

  function animatePawnSteps(playerId, pawnIdx, path) {
    return new Promise(resolve => {
      const el = pieceEls.get('pawn-' + playerId + '-' + pawnIdx);
      if (!el || !path.length) { resolve(); return; }
      el.classList.add('step-anim');
      let step = 0;
      const next = () => {
        if (step >= path.length) { el.classList.remove('step-anim'); resolve(); return; }
        const n = nodeMap.get(path[step]);
        if (n) { const p = nodePos(n); el.style.left = p.x + '%'; el.style.top = p.y + '%'; }
        step++;
        setTimeout(next, 160);
      };
      next();
    });
  }

  function animateCapture(playerId, pawnIdx) {
    const el = pieceEls.get('pawn-' + playerId + '-' + pawnIdx);
    if (el) { el.classList.add('captured'); setTimeout(() => el.classList.remove('captured'), 600); }
  }

  // ══════════════════════════════════════════════════════════════════
  //  NETWORK
  // ══════════════════════════════════════════════════════════════════

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      const password = sessionStorage.getItem('arena-room-password') || undefined;
      sessionStorage.removeItem('arena-room-password');
      wsSend({ type: 'join-room', roomId, name: myName, password, token: sessionStorage.getItem('arena-token') || '' });
    };
    ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
    ws.onclose = () => { statusEl.textContent = 'Disconnected…'; setTimeout(() => location.href = '/', 3000); };
  }
  function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  function handleMsg(msg) {
    switch (msg.type) {
      case 'room-joined':
        myId = msg.myId; leaderId = msg.leaderId; others.clear();
        for (const p of msg.players) others.set(p.id, { name: p.name });
        updateLobbyUI();
        statusEl.textContent = 'Waiting for players… Leader starts the game.';
        break;
      case 'player-joined':
        others.set(msg.id, { name: msg.name }); leaderId = msg.leaderId;
        updateLobbyUI(); addChat(null, msg.name + ' joined');
        break;
      case 'player-left':
        others.delete(msg.id); leaderId = msg.leaderId; updateLobbyUI();
        break;
      case 'bar-start': onGameStart(msg); break;
      case 'bar-turn': onTurn(msg); break;
      case 'bar-rolled': onRolled(msg); break;
      case 'bar-pawn-selected': onPawnSelected(msg); break;
      case 'bar-no-moves': onNoMoves(msg); break;
      case 'bar-moved': onMoved(msg); break;
      case 'bar-captured': onCaptured(msg); break;
      case 'bar-barricade-captured': onBarricadeCaptured(msg); break;
      case 'bar-barricade-placed': onBarricadePlaced(msg); break;
      case 'bar-state': onFullState(msg); break;
      case 'bar-game-over': onGameOver(msg); break;
      case 'bar-aborted':
        gameActive = false; controls.style.display = ''; diceArea.style.display = 'none';
        boardOuter.style.display = 'none'; statusEl.textContent = msg.reason || 'Game aborted';
        break;
      case 'bar-player-disconnect':
        addLogEntry(msg.name + ' disconnected — waiting 30s for reconnect…', 'capture');
        statusEl.textContent = msg.name + ' disconnected. Waiting for reconnect…';
        btnRoll.disabled = true;
        break;
      case 'bar-reconnected':
        addLogEntry(msg.name + ' reconnected!', 'win');
        if (msg.pawns) { pawns = msg.pawns; barricades = msg.barricades; renderPieces(); }
        updatePlayerList(); syncUI();
        break;
      case 'bar-disconnect-timeout':
        addLogEntry(msg.name + ' timed out — removed from game', 'capture');
        if (msg.pawns) { pawns = msg.pawns; barricades = msg.barricades; renderPieces(); }
        updatePlayerList(); syncUI();
        break;
      case 'error': alert(msg.msg); break;
      case 'chat': addChat(msg.name, msg.text); break;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  GAME EVENTS
  // ══════════════════════════════════════════════════════════════════

  function onGameStart(msg) {
    gameActive = true;
    controls.style.display = 'none'; diceArea.style.display = 'flex';
    boardOuter.style.display = 'flex'; eventLog.style.display = '';
    if (!msg.reconnect) resultOverlay.style.display = 'none';
    buildBoardFromLayout(msg.layout);
    playersInfo = msg.players; pawns = msg.pawns; barricades = msg.barricades;
    myColorIdx = playersInfo.find(p => p.id === myId)?.colorIdx ?? -1;
    currentTurnId = msg.turnId;
    renderBoard(); renderPieces(); updatePlayerList(); syncUI();
    addLogEntry(msg.reconnect ? 'Reconnected to game' : 'Game started!', 'info');
  }

  function onTurn(msg) {
    currentTurnId = msg.turnId; dieResult = null; selectedPawnIdx = null;
    placingBarricade = false; clearHighlights(); updatePlayerList(); syncUI();
  }

  function onRolled(msg) {
    dieResult = msg.die;
    animating = true;
    animateDice(msg.die).then(() => {
      animating = false;
      syncUI();
      if (msg.turnId === myId) {
        if (msg.selectablePawns && msg.selectablePawns.length > 0) {
          highlightSelectablePawns(msg.selectablePawns);
          statusEl.textContent = 'Rolled ' + msg.die + ' — select a pawn';
        } else {
          statusEl.textContent = 'Rolled ' + msg.die + ' — no moves available';
        }
      } else {
        statusEl.textContent = getPlayerName(msg.turnId) + ' rolled ' + msg.die;
      }
    });
    addLogEntry(getPlayerName(msg.turnId) + ' rolled ' + msg.die, 'info');
  }

  function onPawnSelected(msg) {
    if (msg.destinations && msg.destinations.length > 0) {
      clearHighlights();
      const el = pieceEls.get('pawn-' + myId + '-' + msg.pawnIdx);
      if (el) el.classList.add('selected');
      highlightDestinations(msg.destinations);
      statusEl.textContent = 'Select a destination';
    } else {
      statusEl.textContent = 'No valid moves for this pawn. Try another.';
      selectedPawnIdx = null;
    }
  }

  function onNoMoves(msg) {
    statusEl.textContent = 'No valid moves — turn skipped';
    addLogEntry(getPlayerName(msg.turnId) + ' — no moves, skipped', 'info');
  }

  function onMoved(msg) {
    animating = true;
    clearHighlights();
    animatePawnSteps(msg.playerId, msg.pawnIdx, msg.path || []).then(() => {
      pawns = msg.pawns; barricades = msg.barricades;
      renderPieces(); updatePlayerList(); animating = false; syncUI();
    });
    addLogEntry(getPlayerName(msg.playerId) + ' moved pawn ' + (msg.pawnIdx + 1), 'info');
  }

  function onCaptured(msg) {
    animateCapture(msg.capturedPlayerId, msg.capturedPawnIdx);
    pawns = msg.pawns; barricades = msg.barricades;
    setTimeout(() => { renderPieces(); updatePlayerList(); syncUI(); }, 600);
    addLogEntry(getPlayerName(msg.capturedPlayerId) + "'s pawn sent home!", 'capture');
  }

  function onBarricadeCaptured(msg) {
    pawns = msg.pawns; barricades = msg.barricades; renderPieces();
    if (msg.playerId === myId) {
      placingBarricade = true; barricadePlaceBar.style.display = 'flex';
      highlightBarricadePlacements(msg.validPlacements);
      statusEl.textContent = 'Place the captured barricade!';
      startBarricadeTimer();
    } else {
      statusEl.textContent = getPlayerName(msg.playerId) + ' placing barricade…';
    }
    addLogEntry(getPlayerName(msg.playerId) + ' captured a barricade!', 'barricade');
  }

  function onBarricadePlaced(msg) {
    placingBarricade = false; barricadePlaceBar.style.display = 'none';
    clearBarricadeTimer(); clearHighlights();
    pawns = msg.pawns; barricades = msg.barricades;
    renderPieces(); updatePlayerList();
    addLogEntry(getPlayerName(msg.playerId) + ' placed a barricade', 'barricade');
  }

  function onFullState(msg) {
    pawns = msg.pawns; barricades = msg.barricades; currentTurnId = msg.turnId;
    if (msg.layout) { buildBoardFromLayout(msg.layout); renderBoard(); }
    renderPieces(); updatePlayerList(); syncUI();
  }

  function onGameOver(msg) {
    gameActive = false; clearHighlights(); clearBarricadeTimer();
    const info = playersInfo.find(p => p.id === msg.winnerId);
    const name = info ? info.name : 'Unknown';
    const isMe = msg.winnerId === myId;
    resultEmoji.textContent = isMe ? '🏆' : '😔';
    resultTitle.textContent = isMe ? 'You Win!' : name + ' Wins!';
    resultSub.textContent = name + ' reached the goal!';
    resultOverlay.style.display = 'flex';
    if (isMe) { reportScore('barricade', 1); launchConfetti(); }
    addLogEntry(name + ' wins!', 'win');
  }

  // ══════════════════════════════════════════════════════════════════
  //  USER ACTIONS
  // ══════════════════════════════════════════════════════════════════

  function onPawnClick(playerId, pawnIdx) {
    if (animating || !gameActive || placingBarricade) return;
    if (playerId !== myId || currentTurnId !== myId || dieResult === null) return;
    selectedPawnIdx = pawnIdx;
    wsSend({ type: 'bar-select-pawn', pawnIdx });
  }

  function onDestClick(nodeId) {
    if (animating || !gameActive || currentTurnId !== myId || selectedPawnIdx === null) return;
    wsSend({ type: 'bar-move', pawnIdx: selectedPawnIdx, destNode: nodeId });
    clearHighlights();
  }

  function onBarricadePlaceClick(nodeId) {
    if (!placingBarricade || currentTurnId !== myId) return;
    wsSend({ type: 'bar-place-barricade', nodeId });
    clearHighlights();
  }

  btnRoll.addEventListener('click', () => {
    if (currentTurnId !== myId || animating || dieResult !== null) return;
    wsSend({ type: 'bar-roll' }); btnRoll.disabled = true;
  });

  btnStartGame.addEventListener('click', () => wsSend({ type: 'bar-start' }));
  btnPlayAgain.addEventListener('click', () => { resultOverlay.style.display = 'none'; wsSend({ type: 'bar-start' }); });

  // ══════════════════════════════════════════════════════════════════
  //  UI SYNC
  // ══════════════════════════════════════════════════════════════════

  function syncUI() {
    const isMyTurn = currentTurnId === myId && gameActive;
    btnRoll.disabled = !isMyTurn || animating || dieResult !== null || placingBarricade;
    if (isMyTurn && !placingBarricade && dieResult === null) {
      turnTag.textContent = 'Your turn — Roll!'; statusEl.textContent = 'Your turn! Roll the die.';
    } else if (isMyTurn && placingBarricade) {
      turnTag.textContent = 'Place barricade';
    } else if (!isMyTurn && gameActive) {
      const n = getPlayerName(currentTurnId);
      turnTag.textContent = n + "'s turn"; statusEl.textContent = n + "'s turn…";
    }
    controls.style.display = gameActive ? 'none' : '';
    btnStartGame.style.display = (leaderId === myId && !gameActive) ? '' : 'none';
  }

  function updateLobbyUI() {
    if (!gameActive) {
      playersInfo = []; let idx = 0;
      playersInfo.push({ id: myId, name: myName, colorIdx: idx++ });
      for (const [id, p] of others) playersInfo.push({ id, name: p.name, colorIdx: idx++ });
      updatePlayerList();
    }
    controls.style.display = gameActive ? 'none' : '';
    btnStartGame.style.display = (leaderId === myId && !gameActive) ? '' : 'none';
  }

  function getPlayerName(pid) {
    const info = playersInfo.find(p => p.id === pid);
    return info ? info.name : 'Player';
  }

  // ══════════════════════════════════════════════════════════════════
  //  BARRICADE TIMER
  // ══════════════════════════════════════════════════════════════════

  function startBarricadeTimer() {
    barricadePlaceCountdownVal = 15; barricadeCountdown.textContent = '15';
    clearBarricadeTimer();
    barricadePlaceTimer = setInterval(() => {
      barricadePlaceCountdownVal--;
      barricadeCountdown.textContent = barricadePlaceCountdownVal;
      if (barricadePlaceCountdownVal <= 0) clearBarricadeTimer();
    }, 1000);
  }

  function clearBarricadeTimer() {
    if (barricadePlaceTimer) { clearInterval(barricadePlaceTimer); barricadePlaceTimer = null; }
    barricadePlaceBar.style.display = 'none';
  }

  // ══════════════════════════════════════════════════════════════════
  //  CHAT
  // ══════════════════════════════════════════════════════════════════

  function addChat(name, text) {
    const el = document.createElement('div');
    el.className = 'chat-msg' + (name ? '' : ' system');
    el.innerHTML = name ? `<span class="chat-name">${escapeHtml(name)}:</span> ${escapeHtml(text)}` : escapeHtml(text);
    chatMessages.appendChild(el); chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  function sendChat() {
    const text = chatInput.value.trim(); if (!text) return;
    wsSend({ type: 'chat', text }); addChat(myName, text); chatInput.value = '';
  }
  chatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  // ══════════════════════════════════════════════════════════════════
  //  EVENT LOG
  // ══════════════════════════════════════════════════════════════════

  function addLogEntry(text, cls) {
    const el = document.createElement('div');
    el.className = 'event-log-item' + (cls ? ' ' + cls : '');
    el.textContent = text; eventLogList.appendChild(el);
    eventLogList.scrollTop = eventLogList.scrollHeight;
  }

  // ══════════════════════════════════════════════════════════════════
  //  CONFETTI
  // ══════════════════════════════════════════════════════════════════

  function launchConfetti() {
    confettiCvs.width = window.innerWidth; confettiCvs.height = window.innerHeight;
    const ps = [];
    for (let i = 0; i < 200; i++) ps.push({
      x: Math.random()*confettiCvs.width, y: Math.random()*-confettiCvs.height,
      w: Math.random()*8+4, h: Math.random()*6+2,
      vx: (Math.random()-.5)*4, vy: Math.random()*3+2,
      rot: Math.random()*360, vr: (Math.random()-.5)*10,
      color: ['#ef4444','#3b82f6','#22c55e','#fbbf24','#8b5cf6','#06b6d4'][Math.random()*6|0],
      life: 1,
    });
    let frame = 0;
    (function draw() {
      cctx.clearRect(0,0,confettiCvs.width,confettiCvs.height);
      let alive = false;
      for (const p of ps) {
        if (p.life <= 0) continue; alive = true;
        p.x += p.vx; p.y += p.vy; p.vy += .05; p.rot += p.vr;
        if (frame > 60) p.life -= .01;
        cctx.save(); cctx.translate(p.x,p.y); cctx.rotate(p.rot*Math.PI/180);
        cctx.globalAlpha = p.life; cctx.fillStyle = p.color;
        cctx.fillRect(-p.w/2,-p.h/2,p.w,p.h); cctx.restore();
      }
      frame++;
      if (alive && frame < 300) requestAnimationFrame(draw);
      else cctx.clearRect(0,0,confettiCvs.width,confettiCvs.height);
    })();
  }

  // ══════════════════════════════════════════════════════════════════
  //  MISC UI
  // ══════════════════════════════════════════════════════════════════

  btnBack.addEventListener('click', () => { if (confirm('Leave the game?')) { wsSend({ type: 'leave-room' }); location.href = '/'; } });
  btnRules.addEventListener('click', () => rulesPanel.style.display = 'flex');
  rulesClose.addEventListener('click', () => rulesPanel.style.display = 'none');
  rulesPanel.addEventListener('click', e => { if (e.target === rulesPanel) rulesPanel.style.display = 'none'; });
  btnToggleSidebar.addEventListener('click', () => { sidebar.classList.toggle('open'); panelBackdrop.classList.toggle('open'); });
  btnToggleChat.addEventListener('click', () => { chatPanel.classList.toggle('open'); panelBackdrop.classList.toggle('open'); });
  panelBackdrop.addEventListener('click', () => { sidebar.classList.remove('open'); chatPanel.classList.remove('open'); panelBackdrop.classList.remove('open'); });

  initDicePips();
  connect();
})();

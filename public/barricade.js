/* ═══════════════════════════════════════════════════════════════════
   BARRICADE — Arena Game  (Quoridor-style, online + bot)
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const GRID = 9, MAX_WALLS = 10;
  const DIRS = [[0,1],[0,-1],[1,0],[-1,0]];

  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  const myName = sessionStorage.getItem('arena-name') || 'Player';

  const $ = id => document.getElementById(id);
  const modeOverlay = $('modeOverlay');
  const layout = $('layout');
  const boardEl = $('board');
  const turnText = $('turnText'), turnDot = $('turnDot');
  const p1Walls = $('p1Walls'), p2Walls = $('p2Walls');
  const p1Info = $('p1Info'), p2Info = $('p2Info');
  const p1Name = $('p1Name'), p2Name = $('p2Name');
  const actionHint = $('actionHint');
  const resultOverlay = $('resultOverlay'), resultTitle = $('resultTitle'), resultSub = $('resultSub');
  const statusEl = $('status');
  const controlsEl = $('controls'), btnStartGame = $('btnStartGame');
  const playerBar = $('playerBar'), actionBar = $('actionBar'), boardWrap = $('boardWrap');
  const playerListEl = $('playerList'), playerCountEl = $('playerCount');
  const roomBadge = $('roomBadge');
  const chatMessages = $('chatMessages'), chatInput = $('chatInput'), chatSend = $('chatSend');
  const confettiCvs = $('confetti'), cctx = confettiCvs.getContext('2d');
  const sidebar = $('sidebar'), chatPanel = $('chatPanel'), panelBackdrop = $('panelBackdrop');

  // ── State ──
  let ws = null, myId = null, leaderId = null;
  const others = new Map();
  let isOnline = !!roomId;
  let gameActive = false, gameOver = false;
  let players = [], walls = [], currentPlayer = 0;
  let myPlayerIdx = -1; // 0 or 1 — which player am I?
  let cells = [], wallSlots = [], pawnEls = [];
  let isBotMode = false;

  // ══════════════════════════════════════════════════════════════════
  //  ENTRY POINT
  // ══════════════════════════════════════════════════════════════════

  if (isOnline) {
    // Online mode — connect WebSocket
    modeOverlay.style.display = 'none';
    layout.style.display = 'flex';
    roomBadge.textContent = 'Room ' + roomId;
    connect();
  } else {
    // No room — show bot mode overlay
    modeOverlay.style.display = 'flex';
    layout.style.display = 'none';
  }

  // ══════════════════════════════════════════════════════════════════
  //  WEBSOCKET (ONLINE)
  // ══════════════════════════════════════════════════════════════════

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      const pw = sessionStorage.getItem('arena-room-password') || undefined;
      sessionStorage.removeItem('arena-room-password');
      wsSend({ type: 'join-room', roomId, name: myName, password: pw, token: sessionStorage.getItem('arena-token') || '' });
    };
    ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => { statusEl.textContent = 'Disconnected — returning to lobby…'; setTimeout(() => location.href = '/', 3000); };
  }
  function wsSend(msg) { if (ws?.readyState === 1) ws.send(JSON.stringify(msg)); }

  function handleMsg(msg) {
    switch (msg.type) {
      case 'room-joined':
        myId = msg.myId;
        leaderId = msg.leaderId;
        statusEl.textContent = 'Waiting for players…';
        for (const p of msg.players) addPlayerCard(p.id, p.name, p.id === myId);
        updatePlayerCount();
        updateControls();
        break;
      case 'player-joined':
        addPlayerCard(msg.id, msg.name, false);
        leaderId = msg.leaderId;
        updatePlayerCount();
        updateControls();
        appendChat('system', '', `${escHtml(msg.name)} joined`);
        break;
      case 'player-left':
        removePlayerCard(msg.id);
        updatePlayerCount();
        if (gameActive && !gameOver) {
          gameOver = true;
          statusEl.textContent = 'Opponent left.';
          showResult('Opponent Left', 'They disconnected.');
        }
        updateControls();
        break;
      case 'bar2-start':
        onOnlineGameStart(msg);
        break;
      case 'bar2-moved':
        onOnlineMove(msg);
        break;
      case 'bar2-wall':
        onOnlineWall(msg);
        break;
      case 'bar2-turn':
        onOnlineTurn(msg);
        break;
      case 'bar2-gameover':
        onOnlineGameOver(msg);
        break;
      case 'chat':
        appendChat('other', msg.name, msg.text);
        break;
      case 'error':
        statusEl.textContent = msg.msg;
        break;
    }
  }

  // ── Online game handlers ──

  function onOnlineGameStart(msg) {
    gameActive = true; gameOver = false;
    myPlayerIdx = msg.yourIdx; // 0 or 1
    players = [
      { row: msg.players[0].row, col: msg.players[0].col, wallsLeft: msg.players[0].wallsLeft, goalRow: msg.players[0].goalRow },
      { row: msg.players[1].row, col: msg.players[1].col, wallsLeft: msg.players[1].wallsLeft, goalRow: msg.players[1].goalRow }
    ];
    walls = msg.walls || [];
    currentPlayer = msg.currentPlayer;
    p1Name.textContent = msg.players[0].name;
    p2Name.textContent = msg.players[1].name;
    controlsEl.style.display = 'none';
    statusEl.textContent = '';
    playerBar.style.display = 'flex';
    actionBar.style.display = 'flex';
    boardWrap.style.display = 'flex';
    buildBoard();
    renderWalls();
    updateUI();
  }

  function onOnlineMove(msg) {
    players[msg.playerIdx].row = msg.row;
    players[msg.playerIdx].col = msg.col;
    const cell = getCell(msg.row, msg.col);
    const pawn = pawnEls[msg.playerIdx];
    pawn.remove();
    if (cell) cell.appendChild(pawn);
  }

  function onOnlineWall(msg) {
    walls.push({ type: msg.wallType, r: msg.r, c: msg.c, player: msg.playerIdx });
    players[msg.playerIdx].wallsLeft = msg.wallsLeft;
    const slot = findWallSlot(msg.wallType, msg.r, msg.c);
    if (slot) {
      slot.classList.add('placed', `p${msg.playerIdx + 1}-wall`);
      slot.classList.remove('preview');
      slot.style.display = 'block';
    }
  }

  function onOnlineTurn(msg) {
    currentPlayer = msg.currentPlayer;
    updateUI();
  }

  function onOnlineGameOver(msg) {
    gameOver = true; gameActive = false;
    const winnerName = msg.winnerIdx === 0 ? p1Name.textContent : p2Name.textContent;
    const didIWin = msg.winnerIdx === myPlayerIdx;
    if (didIWin) reportScore('barricade', 1);
    showResult(`${winnerName} Wins!`, 'Reached the other side!');
  }

  // ── Player cards ──

  function addPlayerCard(id, name, isMe) {
    if (id === myId) { /* me */ } else { others.set(id, { name }); }
    const card = document.createElement('div');
    card.className = 'player-card' + (isMe ? ' me' : '');
    card.id = 'pc-' + id;
    card.innerHTML = `<span class="dot" style="background:${isMe ? 'var(--p1)' : 'var(--p2)'}"></span><span class="pname">${escHtml(name)}${isMe ? ' (you)' : ''}</span>`;
    playerListEl.appendChild(card);
  }
  function removePlayerCard(id) {
    others.delete(id);
    const el = document.getElementById('pc-' + id);
    if (el) el.remove();
  }
  function updatePlayerCount() { playerCountEl.textContent = 1 + others.size; }
  function updateControls() {
    if (gameActive) { controlsEl.style.display = 'none'; return; }
    controlsEl.style.display = 'block';
    btnStartGame.disabled = others.size < 1;
    btnStartGame.style.display = (myId === leaderId) ? 'inline-block' : 'none';
    if (myId !== leaderId) statusEl.textContent = 'Waiting for host to start…';
    else if (others.size < 1) statusEl.textContent = 'Need 2 players to start';
    else statusEl.textContent = 'Ready!';
  }

  // ── Chat ──
  function appendChat(who, name, text) {
    const d = document.createElement('div');
    d.className = 'chat-msg';
    if (who === 'system') d.innerHTML = `<i>${text}</i>`;
    else d.innerHTML = `<b>${escHtml(name)}:</b> ${escHtml(text)}`;
    chatMessages.appendChild(d);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  function sendChat() {
    const t = chatInput.value.trim();
    if (!t) return;
    if (isOnline) { wsSend({ type: 'chat', text: t }); appendChat('me', myName, t); }
    chatInput.value = '';
  }

  function escHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ══════════════════════════════════════════════════════════════════
  //  BOARD BUILD (shared by online + bot)
  // ══════════════════════════════════════════════════════════════════

  function buildBoard() {
    boardEl.innerHTML = '';
    cells = []; wallSlots = []; pawnEls = [];

    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.r = r; cell.dataset.c = c;
        if (r === GRID - 1) cell.classList.add('goal-p1');
        if (r === 0) cell.classList.add('goal-p2');
        cell.addEventListener('click', () => onCellClick(r, c));
        boardEl.appendChild(cell);
        cells.push(cell);
      }
    }
    createWallSlots();
    for (let i = 0; i < 2; i++) {
      const pawn = document.createElement('div');
      pawn.className = `pawn p${i + 1}`;
      pawn.textContent = i === 0 ? '▲' : '▼';
      pawnEls.push(pawn);
    }
    placePawns();
  }

  function createWallSlots() {
    for (let r = 0; r < GRID - 1; r++) {
      for (let c = 0; c < GRID - 1; c++) {
        const slot = document.createElement('div');
        slot.className = 'wall-slot horizontal';
        slot.dataset.type = 'h'; slot.dataset.r = r; slot.dataset.c = c;
        slot.addEventListener('click', () => onWallClick('h', r, c));
        slot.addEventListener('mouseenter', () => onWallHover('h', r, c));
        slot.addEventListener('mouseleave', () => onWallLeave('h', r, c));
        boardEl.appendChild(slot);
        wallSlots.push(slot);
      }
    }
    for (let r = 0; r < GRID - 1; r++) {
      for (let c = 0; c < GRID - 1; c++) {
        const slot = document.createElement('div');
        slot.className = 'wall-slot vertical';
        slot.dataset.type = 'v'; slot.dataset.r = r; slot.dataset.c = c;
        slot.addEventListener('click', () => onWallClick('v', r, c));
        slot.addEventListener('mouseenter', () => onWallHover('v', r, c));
        slot.addEventListener('mouseleave', () => onWallLeave('v', r, c));
        boardEl.appendChild(slot);
        wallSlots.push(slot);
      }
    }
    requestAnimationFrame(positionWallSlots);
  }

  function positionWallSlots() {
    if (cells.length === 0) return;
    const cellW = cells[0].offsetWidth, cellH = cells[0].offsetHeight;
    if (cellW === 0) { requestAnimationFrame(positionWallSlots); return; }
    const gapH = cells[1].offsetLeft - (cells[0].offsetLeft + cellW);
    const gapV = cells[GRID].offsetTop - (cells[0].offsetTop + cellH);

    wallSlots.forEach(slot => {
      const type = slot.dataset.type;
      const r = parseInt(slot.dataset.r), c = parseInt(slot.dataset.c);
      const idx = r * GRID + c;
      const offX = cells[idx].offsetLeft, offY = cells[idx].offsetTop;
      if (type === 'h') {
        slot.style.top = (offY + cellH) + 'px'; slot.style.left = offX + 'px';
        slot.style.width = (2 * cellW + gapH) + 'px'; slot.style.height = Math.max(gapV, 6) + 'px';
      } else {
        slot.style.top = offY + 'px'; slot.style.left = (offX + cellW) + 'px';
        slot.style.width = Math.max(gapH, 6) + 'px'; slot.style.height = (2 * cellH + gapV) + 'px';
      }
    });
  }

  const resizeObserver = new ResizeObserver(() => positionWallSlots());
  resizeObserver.observe(boardEl);

  function placePawns() {
    pawnEls.forEach(p => p.remove());
    for (let i = 0; i < 2; i++) {
      const cell = getCell(players[i].row, players[i].col);
      if (cell) cell.appendChild(pawnEls[i]);
    }
  }

  function renderWalls() {
    for (const w of walls) {
      const slot = findWallSlot(w.type, w.r, w.c);
      if (slot) {
        slot.classList.add('placed', `p${w.player + 1}-wall`);
        slot.style.display = 'block';
      }
    }
  }

  function getCell(r, c) { return cells[r * GRID + c] || null; }
  function findWallSlot(type, r, c) {
    return wallSlots.find(s => s.dataset.type === type && parseInt(s.dataset.r) === r && parseInt(s.dataset.c) === c);
  }

  // ══════════════════════════════════════════════════════════════════
  //  GAME LOGIC (shared validation — used by bot mode client-side)
  // ══════════════════════════════════════════════════════════════════

  function canPassBetween(r1, c1, r2, c2, wallSet) {
    const ws = wallSet || walls;
    for (const w of ws) {
      if (w.type === 'h') {
        if (r2 === r1 + 1 && c1 === c2 && w.r === r1 && (w.c === c1 || w.c === c1 - 1)) return false;
        if (r2 === r1 - 1 && c1 === c2 && w.r === r1 - 1 && (w.c === c1 || w.c === c1 - 1)) return false;
      }
      if (w.type === 'v') {
        if (c2 === c1 + 1 && r1 === r2 && w.c === c1 && (w.r === r1 || w.r === r1 - 1)) return false;
        if (c2 === c1 - 1 && r1 === r2 && w.c === c1 - 1 && (w.r === r1 || w.r === r1 - 1)) return false;
      }
    }
    return true;
  }

  function getValidMoves(pidx) {
    const p = players[pidx], opp = players[1 - pidx], moves = [];
    for (const [dr, dc] of DIRS) {
      const nr = p.row + dr, nc = p.col + dc;
      if (nr < 0 || nr >= GRID || nc < 0 || nc >= GRID) continue;
      if (!canPassBetween(p.row, p.col, nr, nc)) continue;
      if (nr === opp.row && nc === opp.col) {
        const jr = nr + dr, jc = nc + dc;
        if (jr >= 0 && jr < GRID && jc >= 0 && jc < GRID && canPassBetween(nr, nc, jr, jc)) {
          moves.push({ row: jr, col: jc });
        } else {
          for (const [dr2, dc2] of DIRS) {
            if (dr2 === -dr && dc2 === -dc) continue;
            const sr = nr + dr2, sc = nc + dc2;
            if (sr < 0 || sr >= GRID || sc < 0 || sc >= GRID) continue;
            if (sr === p.row && sc === p.col) continue;
            if (!canPassBetween(nr, nc, sr, sc)) continue;
            moves.push({ row: sr, col: sc });
          }
        }
      } else {
        moves.push({ row: nr, col: nc });
      }
    }
    return moves;
  }

  function isWallValid(type, r, c) {
    if (r < 0 || r >= GRID - 1 || c < 0 || c >= GRID - 1) return false;
    for (const w of walls) {
      if (w.type === type && w.r === r && w.c === c) return false;
      if (w.type !== type && w.r === r && w.c === c) return false;
      if (w.type === 'h' && type === 'h' && w.r === r && Math.abs(w.c - c) === 1) return false;
      if (w.type === 'v' && type === 'v' && w.c === c && Math.abs(w.r - r) === 1) return false;
    }
    return true;
  }

  function bfs(sr, sc, goalRow, wallSet) {
    const visited = new Set();
    const queue = [[sr, sc, 0]];
    visited.add(sr * GRID + sc);
    while (queue.length > 0) {
      const [r, c, dist] = queue.shift();
      if (r === goalRow) return dist;
      for (const [dr, dc] of DIRS) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr >= GRID || nc < 0 || nc >= GRID) continue;
        if (visited.has(nr * GRID + nc)) continue;
        if (!canPassBetween(r, c, nr, nc, wallSet)) continue;
        visited.add(nr * GRID + nc);
        queue.push([nr, nc, dist + 1]);
      }
    }
    return -1;
  }

  function wouldBlockPath(type, r, c) {
    const testWalls = [...walls, { type, r, c }];
    for (let i = 0; i < 2; i++) {
      if (bfs(players[i].row, players[i].col, players[i].goalRow, testWalls) === -1) return true;
    }
    return false;
  }

  function canPlaceWall(type, r, c, pidx) {
    const p = pidx !== undefined ? pidx : currentPlayer;
    if (players[p].wallsLeft <= 0) return false;
    if (!isWallValid(type, r, c)) return false;
    if (wouldBlockPath(type, r, c)) return false;
    return true;
  }

  // ══════════════════════════════════════════════════════════════════
  //  UI UPDATE
  // ══════════════════════════════════════════════════════════════════

  function updateUI() {
    p1Walls.textContent = `🧱 ×${players[0].wallsLeft}`;
    p2Walls.textContent = `🧱 ×${players[1].wallsLeft}`;

    const name = currentPlayer === 0 ? p1Name.textContent : p2Name.textContent;
    turnText.textContent = `${name}'s Turn`;
    turnDot.style.background = currentPlayer === 0 ? 'var(--p1)' : 'var(--p2)';

    p1Info.classList.toggle('active-turn', currentPlayer === 0);
    p2Info.classList.toggle('active-turn', currentPlayer === 1);
    pawnEls[0].classList.toggle('active', currentPlayer === 0);
    pawnEls[1].classList.toggle('active', currentPlayer === 1);

    const isMyTurn = isBotMode ? currentPlayer === 0 : currentPlayer === myPlayerIdx;
    if (isMyTurn && !gameOver) {
      if (players[currentPlayer].wallsLeft > 0) actionHint.textContent = 'Move to a cell or place a barricade in the gaps';
      else actionHint.textContent = 'Move to an adjacent cell';
    } else if (!gameOver) {
      actionHint.textContent = 'Waiting for opponent…';
    }

    highlightValidMoves();

    wallSlots.forEach(slot => {
      if (slot.classList.contains('placed')) return;
      slot.style.display = 'block';
    });

    updateBoardRotation();
    positionWallSlots();
  }

  function highlightValidMoves() {
    cells.forEach(cell => cell.classList.remove('valid-move'));
    if (gameOver) return;
    const isMyTurn = isBotMode ? currentPlayer === 0 : currentPlayer === myPlayerIdx;
    if (!isMyTurn) return;
    const moves = getValidMoves(currentPlayer);
    for (const m of moves) {
      const cell = getCell(m.row, m.col);
      if (cell) cell.classList.add('valid-move');
    }
  }

  function updateBoardRotation() {
    // Rotate board so current player always sees themselves at the bottom
    // In online mode: rotate if I'm player 1 (who starts at row 0, top)
    // In bot mode: never rotate (human is always at top, bot at bottom)
    let shouldRotate = false;
    if (isOnline) {
      shouldRotate = myPlayerIdx === 0; // Player 0 spawns at row 0 (top), so rotate to put them at bottom
    }
    boardEl.style.transition = 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
    boardEl.style.transform = shouldRotate ? 'rotate(180deg)' : 'rotate(0deg)';
    cells.forEach(cell => {
      cell.style.transition = 'transform 0.5s cubic-bezier(0.4, 0, 0.2, 1)';
      cell.style.transform = shouldRotate ? 'rotate(180deg)' : 'rotate(0deg)';
    });
  }

  // ══════════════════════════════════════════════════════════════════
  //  EVENT HANDLERS
  // ══════════════════════════════════════════════════════════════════

  function isMyTurn() {
    if (gameOver) return false;
    if (isBotMode) return currentPlayer === 0;
    return currentPlayer === myPlayerIdx;
  }

  function onCellClick(r, c) {
    if (!isMyTurn()) return;
    const moves = getValidMoves(currentPlayer);
    if (!moves.find(m => m.row === r && m.col === c)) return;

    if (isOnline) {
      wsSend({ type: 'bar2-move', row: r, col: c });
    } else {
      executeLocalMove(r, c);
    }
  }

  function onWallClick(type, r, c) {
    if (!isMyTurn()) return;
    if (players[currentPlayer].wallsLeft <= 0) return;
    if (!canPlaceWall(type, r, c)) return;

    if (isOnline) {
      wsSend({ type: 'bar2-wall', wallType: type, r, c });
    } else {
      placeLocalWall(type, r, c);
    }
  }

  function onWallHover(type, r, c) {
    if (!isMyTurn()) return;
    if (players[currentPlayer].wallsLeft <= 0) return;
    const slot = findWallSlot(type, r, c);
    if (!slot || slot.classList.contains('placed')) return;
    if (canPlaceWall(type, r, c)) { slot.classList.add('preview'); slot.classList.remove('invalid'); }
    else { slot.classList.add('invalid'); }
  }

  function onWallLeave(type, r, c) {
    const slot = findWallSlot(type, r, c);
    if (slot) slot.classList.remove('preview', 'invalid');
  }

  // ══════════════════════════════════════════════════════════════════
  //  LOCAL (BOT) MODE
  // ══════════════════════════════════════════════════════════════════

  function initBotGame() {
    isBotMode = true; isOnline = false;
    gameActive = true; gameOver = false;
    myPlayerIdx = 0;
    players = [
      { row: 0, col: 4, wallsLeft: MAX_WALLS, goalRow: GRID - 1 },
      { row: GRID - 1, col: 4, wallsLeft: MAX_WALLS, goalRow: 0 }
    ];
    walls = []; currentPlayer = 0;

    modeOverlay.style.display = 'none';
    layout.style.display = 'flex';
    sidebar.style.display = 'none';
    chatPanel.style.display = 'none';
    controlsEl.style.display = 'none';
    statusEl.textContent = '';
    playerBar.style.display = 'flex';
    actionBar.style.display = 'flex';
    boardWrap.style.display = 'flex';

    p1Name.textContent = 'You';
    p2Name.textContent = 'Bot 🤖';
    roomBadge.textContent = 'vs Bot';

    buildBoard();
    updateUI();
  }

  function executeLocalMove(r, c) {
    players[currentPlayer].row = r;
    players[currentPlayer].col = c;
    const cell = getCell(r, c);
    const pawn = pawnEls[currentPlayer];
    pawn.remove();
    if (cell) cell.appendChild(pawn);

    if (r === players[currentPlayer].goalRow) { endLocalGame(currentPlayer); return; }
    localEndTurn();
  }

  function placeLocalWall(type, r, c) {
    walls.push({ type, r, c, player: currentPlayer });
    players[currentPlayer].wallsLeft--;
    const slot = findWallSlot(type, r, c);
    if (slot) { slot.classList.add('placed', `p${currentPlayer + 1}-wall`); slot.classList.remove('preview'); slot.style.display = 'block'; }
    localEndTurn();
  }

  function localEndTurn() {
    currentPlayer = 1 - currentPlayer;
    updateUI();
    if (isBotMode && currentPlayer === 1 && !gameOver) {
      setTimeout(botTurn, 600);
    }
  }

  function endLocalGame(winner) {
    gameOver = true; gameActive = false;
    const name = winner === 0 ? p1Name.textContent : p2Name.textContent;
    showResult(`${name} Wins!`, 'Reached the other side!');
  }

  // ── Bot AI ──

  function botTurn() {
    if (gameOver) return;
    const botIdx = 1, oppIdx = 0;

    const moves = getValidMoves(botIdx);
    const winMove = moves.find(m => m.row === players[botIdx].goalRow);
    if (winMove) { executeLocalMove(winMove.row, winMove.col); return; }

    const myPath = bfs(players[botIdx].row, players[botIdx].col, players[botIdx].goalRow, walls);
    const oppPath = bfs(players[oppIdx].row, players[oppIdx].col, players[oppIdx].goalRow, walls);
    let bestWall = null, bestWallScore = 0;

    if (players[botIdx].wallsLeft > 0) {
      for (let r = 0; r < GRID - 1; r++) {
        for (let c = 0; c < GRID - 1; c++) {
          for (const type of ['h', 'v']) {
            if (!canPlaceWall(type, r, c, botIdx)) continue;
            const tw = [...walls, { type, r, c }];
            const nop = bfs(players[oppIdx].row, players[oppIdx].col, players[oppIdx].goalRow, tw);
            const nmp = bfs(players[botIdx].row, players[botIdx].col, players[botIdx].goalRow, tw);
            if (nop === -1 || nmp === -1) continue;
            const score = (nop - oppPath) - (nmp - myPath) * 0.5;
            if (score > bestWallScore) { bestWallScore = score; bestWall = { type, r, c }; }
          }
        }
      }
    }

    if (bestWall && ((bestWallScore >= 2 && players[botIdx].wallsLeft > 3) || bestWallScore >= 3)) {
      placeLocalWall(bestWall.type, bestWall.r, bestWall.c);
    } else {
      const best = findBestBotMove(botIdx);
      if (best) executeLocalMove(best.row, best.col);
      else localEndTurn();
    }
  }

  function findBestBotMove(pidx) {
    const moves = getValidMoves(pidx);
    if (!moves.length) return null;
    let best = null, bestDist = Infinity;
    for (const m of moves) {
      const d = bfs(m.row, m.col, players[pidx].goalRow, walls);
      if (d !== -1 && d < bestDist) { bestDist = d; best = m; }
    }
    return best || moves[0];
  }

  // ══════════════════════════════════════════════════════════════════
  //  RESULT / CONFETTI
  // ══════════════════════════════════════════════════════════════════

  function showResult(title, sub) {
    resultTitle.textContent = title;
    resultSub.textContent = sub;
    resultOverlay.style.display = 'flex';
    launchConfetti();
  }

  let confettiParts = [], confettiAnim = null;
  function launchConfetti() {
    confettiCvs.width = window.innerWidth; confettiCvs.height = window.innerHeight;
    confettiParts = [];
    const colors = ['#ef4444','#3b82f6','#22c55e','#fbbf24','#8b5cf6','#06b6d4'];
    for (let i = 0; i < 150; i++) {
      confettiParts.push({
        x: Math.random()*confettiCvs.width, y: Math.random()*confettiCvs.height - confettiCvs.height,
        w: Math.random()*8+4, h: Math.random()*6+3,
        color: colors[Math.floor(Math.random()*colors.length)],
        vx: (Math.random()-.5)*4, vy: Math.random()*3+2,
        rot: Math.random()*360, vr: (Math.random()-.5)*10
      });
    }
    if (confettiAnim) cancelAnimationFrame(confettiAnim);
    animateConfetti();
  }
  function animateConfetti() {
    cctx.clearRect(0, 0, confettiCvs.width, confettiCvs.height);
    let alive = false;
    for (const p of confettiParts) {
      p.x += p.vx; p.y += p.vy; p.vy += 0.05; p.rot += p.vr;
      if (p.y < confettiCvs.height + 50) alive = true;
      cctx.save(); cctx.translate(p.x, p.y); cctx.rotate(p.rot*Math.PI/180);
      cctx.fillStyle = p.color; cctx.fillRect(-p.w/2, -p.h/2, p.w, p.h); cctx.restore();
    }
    if (alive) confettiAnim = requestAnimationFrame(animateConfetti);
  }

  // ══════════════════════════════════════════════════════════════════
  //  EVENT BINDINGS
  // ══════════════════════════════════════════════════════════════════

  // Mode overlay
  $('btnBotMode').addEventListener('click', () => initBotGame());
  $('btnBackLobby').addEventListener('click', () => { location.href = '/'; });

  // Game controls
  $('btnBack').addEventListener('click', () => {
    if (isOnline) { wsSend({ type: 'leave-room' }); }
    location.href = '/';
  });
  btnStartGame.addEventListener('click', () => {
    if (isOnline) wsSend({ type: 'bar2-start' });
  });
  $('btnPlayAgain').addEventListener('click', () => {
    resultOverlay.style.display = 'none';
    if (isOnline) { wsSend({ type: 'bar2-start' }); }
    else initBotGame();
  });

  // Rules
  $('btnRules').addEventListener('click', () => { $('rulesPanel').style.display = 'flex'; });
  $('rulesClose').addEventListener('click', () => { $('rulesPanel').style.display = 'none'; });
  $('rulesPanel').addEventListener('click', e => { if (e.target.id === 'rulesPanel') $('rulesPanel').style.display = 'none'; });

  // Chat
  chatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });

  // Mobile toggles
  $('btnToggleSidebar').addEventListener('click', () => { sidebar.classList.toggle('open'); panelBackdrop.classList.toggle('show'); });
  $('btnToggleChat').addEventListener('click', () => { chatPanel.classList.toggle('open'); panelBackdrop.classList.toggle('show'); });
  panelBackdrop.addEventListener('click', () => { sidebar.classList.remove('open'); chatPanel.classList.remove('open'); panelBackdrop.classList.remove('show'); });

  // Resize
  window.addEventListener('resize', () => { positionWallSlots(); confettiCvs.width = window.innerWidth; confettiCvs.height = window.innerHeight; });

})();
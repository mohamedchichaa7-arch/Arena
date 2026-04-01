/* ═══════════════════════════════════════════════════════════════════
   INFINITE TIC TAC TOE — Arena Room Client  |  tictactoe.js
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
  const statusEl = $('status');
  const playerListEl = $('playerList'), playerCountEl = $('playerCount');
  const roomBadge = $('roomBadge'), btnBack = $('btnBack');
  const btnNewGame = $('btnNewGame'), btnRematch = $('btnRematch');
  const resultOverlay = $('resultOverlay'), resultTitle = $('resultTitle');
  const confettiCvs = $('confetti'), cctx = confettiCvs.getContext('2d');
  const chatMessages = $('chatMessages'), chatInput = $('chatInput'), chatSend = $('chatSend');
  const scoreXEl = $('scoreX'), scoreOEl = $('scoreO'), scoreDrawEl = $('scoreDraw');
  const boardEl = $('board');
  const cells = [...boardEl.querySelectorAll('.cell')];
  const winLineEl = $('winLine');

  roomBadge.textContent = 'Room ' + roomId;

  // ── Constants ────────────────────────────────────────────────────
  const WIN_COMBOS = [
    [0,1,2],[3,4,5],[6,7,8], // rows
    [0,3,6],[1,4,7],[2,5,8], // cols
    [0,4,8],[2,4,6],         // diagonals
  ];
  const MAX_PIECES = 3; // each player keeps max 3 pieces

  // ── State ────────────────────────────────────────────────────────
  let ws = null, myId = null;
  const others = new Map();
  let mySymbol = null;   // 'X' or 'O', assigned on ttt-start
  let board = Array(9).fill(null);  // null | 'X' | 'O'
  let xHistory = [];     // indices of X moves in order
  let oHistory = [];     // indices of O moves in order
  let currentTurn = 'X';
  let gameActive = false;
  let scores = { X: 0, O: 0, draw: 0 };

  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

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
  function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  function handleMsg(msg) {
    switch (msg.type) {
      case 'room-joined':
        myId = 'self';
        addPlayerCard('self', myName, true);
        for (const p of msg.players) addPlayerCard(p.id, p.name, false);
        updatePlayerCount();
        statusEl.textContent = 'Press New Game when both players are ready';
        break;

      case 'player-joined':
        addPlayerCard(msg.id, msg.name, false);
        updatePlayerCount();
        break;

      case 'player-left':
        removePlayerCard(msg.id);
        updatePlayerCount();
        if (gameActive) {
          gameActive = false;
          statusEl.textContent = 'Opponent left. Press New Game.';
        }
        break;

      case 'ttt-start':
        startGame(msg.xPlayer, msg.oPlayer);
        break;

      case 'ttt-move':
        applyMove(msg.cell, msg.symbol);
        break;

      case 'ttt-win':
        handleWin(msg.winner, msg.combo);
        break;

      case 'chat':
        appendChat(msg.id === myId ? 'me' : 'other', msg.name, msg.text);
        break;

      case 'error':
        statusEl.textContent = msg.msg;
        break;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  GAME LOGIC
  // ══════════════════════════════════════════════════════════════════

  function resetBoard() {
    board = Array(9).fill(null);
    xHistory = [];
    oHistory = [];
    currentTurn = 'X';
    gameActive = false;
    winLineEl.classList.remove('show');
    cells.forEach(c => {
      c.classList.remove('taken', 'win-cell');
      c.innerHTML = '';
    });
  }

  function startGame(xPlayerId, oPlayerId) {
    resetBoard();
    gameActive = true;
    resultOverlay.classList.remove('show');

    // Determine my symbol
    if (xPlayerId === 'self' || xPlayerId === myId) {
      mySymbol = 'X';
    } else if (oPlayerId === 'self' || oPlayerId === myId) {
      mySymbol = 'O';
    } else {
      mySymbol = null; // spectator
    }

    // Update player card symbols
    updateSymbolBadges(xPlayerId, oPlayerId);
    updateTurnStatus();
  }

  function updateSymbolBadges(xId, oId) {
    // Remove old symbol badges
    document.querySelectorAll('.pc-symbol').forEach(el => el.remove());

    function addBadge(id, sym) {
      const sel = id === 'self' ? '.player-card[data-id="self"]' : `.player-card[data-id="${id}"]`;
      const card = document.querySelector(sel);
      if (!card) return;
      const badge = document.createElement('span');
      badge.className = 'pc-symbol ' + (sym === 'X' ? 'x-sym' : 'o-sym');
      badge.textContent = sym === 'X' ? '✕' : '○';
      card.appendChild(badge);
    }
    addBadge(xId, 'X');
    addBadge(oId, 'O');
  }

  function updateTurnStatus() {
    if (!gameActive) return;
    const isMyTurn = mySymbol === currentTurn;
    if (mySymbol) {
      statusEl.textContent = isMyTurn ? `Your turn (${mySymbol === 'X' ? '✕' : '○'})` : `Opponent's turn…`;
    } else {
      statusEl.textContent = `${currentTurn}'s turn`;
    }
  }

  function onCellClick(idx) {
    if (!gameActive || !mySymbol || currentTurn !== mySymbol) return;
    if (board[idx] !== null) return;
    // Send move to server — server validates and broadcasts
    wsSend({ type: 'ttt-move', cell: idx });
  }

  function applyMove(idx, symbol) {
    const history = symbol === 'X' ? xHistory : oHistory;

    // If at max pieces, remove the oldest
    if (history.length >= MAX_PIECES) {
      const oldIdx = history.shift();
      board[oldIdx] = null;
      const oldCell = cells[oldIdx];
      const oldPiece = oldCell.querySelector('.piece');
      if (oldPiece) oldPiece.remove();
      oldCell.classList.remove('taken');
    }

    // Mark the next-to-be-removed piece as fading
    cells.forEach(c => {
      const p = c.querySelector('.piece.fading');
      if (p) p.classList.remove('fading');
    });
    if (history.length >= MAX_PIECES - 1 && history.length > 0) {
      const fadingIdx = history[0];
      const fadingPiece = cells[fadingIdx].querySelector('.piece');
      if (fadingPiece) fadingPiece.classList.add('fading');
    }

    // Place the new piece
    board[idx] = symbol;
    history.push(idx);
    const cell = cells[idx];
    cell.classList.add('taken');
    const piece = document.createElement('div');
    piece.className = 'piece ' + (symbol === 'X' ? 'x-piece' : 'o-piece');
    cell.appendChild(piece);

    // Switch turn
    currentTurn = symbol === 'X' ? 'O' : 'X';
    updateTurnStatus();
  }

  function handleWin(winner, combo) {
    gameActive = false;
    if (winner === 'draw') {
      scores.draw++;
      resultTitle.textContent = 'DRAW!';
    } else {
      scores[winner]++;
      resultTitle.textContent = (winner === 'X' ? '✕' : '○') + ' WINS!';
      if (combo) {
        for (const i of combo) cells[i].classList.add('win-cell');
      }
      if (mySymbol === winner) launchConfetti();
    }
    scoreXEl.textContent = scores.X;
    scoreOEl.textContent = scores.O;
    scoreDrawEl.textContent = scores.draw;
    statusEl.textContent = winner === 'draw' ? 'Draw!' : (winner === 'X' ? '✕' : '○') + ' wins!';
    setTimeout(() => resultOverlay.classList.add('show'), 800);
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
    e.stopPropagation();
  });

  // ══════════════════════════════════════════════════════════════════
  //  SIDEBAR — Player Cards
  // ══════════════════════════════════════════════════════════════════

  const PALETTE = ['#34d399', '#60a5fa', '#f472b6', '#fbbf24', '#a78bfa', '#fb923c'];
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
      <span class="pc-dot" style="background:${color}"></span>
      <span class="pc-name">${escapeHtml(name)}${isMe ? ' (you)' : ''}</span>
    `;
    playerListEl.appendChild(card);
    if (!isMe) others.set(id, { name, el: card });
  }

  function removePlayerCard(id) {
    const p = others.get(id);
    if (p) { p.el.remove(); others.delete(id); }
  }

  function updatePlayerCount() {
    playerCountEl.textContent = 1 + others.size;
  }

  // ══════════════════════════════════════════════════════════════════
  //  CONFETTI
  // ══════════════════════════════════════════════════════════════════

  function launchConfetti() {
    confettiCvs.width = window.innerWidth;
    confettiCvs.height = window.innerHeight;
    const particles = [];
    const colors = ['#f472b6', '#38bdf8', '#fbbf24', '#34d399', '#a78bfa', '#fb923c'];
    for (let i = 0; i < 150; i++) {
      particles.push({
        x: Math.random() * confettiCvs.width, y: Math.random() * confettiCvs.height - confettiCvs.height,
        vx: (Math.random() - 0.5) * 6, vy: Math.random() * 4 + 2,
        size: Math.random() * 8 + 3, color: colors[Math.floor(Math.random() * colors.length)],
        rotation: Math.random() * 360, rotSpeed: (Math.random() - 0.5) * 10, life: 1
      });
    }
    function anim() {
      cctx.clearRect(0, 0, confettiCvs.width, confettiCvs.height);
      let alive = false;
      for (const p of particles) {
        p.x += p.vx; p.y += p.vy; p.vy += 0.08; p.rotation += p.rotSpeed; p.life -= 0.003;
        if (p.life <= 0) continue; alive = true;
        cctx.save(); cctx.translate(p.x, p.y); cctx.rotate(p.rotation * Math.PI / 180);
        cctx.globalAlpha = p.life; cctx.fillStyle = p.color; cctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.5);
        cctx.restore();
      }
      if (alive) requestAnimationFrame(anim);
      else cctx.clearRect(0, 0, confettiCvs.width, confettiCvs.height);
    }
    anim();
  }

  // ══════════════════════════════════════════════════════════════════
  //  EVENT LISTENERS
  // ══════════════════════════════════════════════════════════════════

  cells.forEach((cell, i) => cell.addEventListener('click', () => onCellClick(i)));
  btnNewGame.addEventListener('click', () => wsSend({ type: 'ttt-new' }));
  btnRematch.addEventListener('click', () => { resultOverlay.classList.remove('show'); wsSend({ type: 'ttt-new' }); });
  btnBack.addEventListener('click', () => { wsSend({ type: 'leave-room' }); location.href = '/'; });

  // ══════════════════════════════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════════════════════════════
  connect();
})();

/* ═══════════════════════════════════════════════════════════════════
   E-GAME — Arena Room Client  |  egame.js
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
  const resultScores = $('resultScores');
  const confettiCvs = $('confetti'), cctx = confettiCvs.getContext('2d');
  const chatMessages = $('chatMessages'), chatInput = $('chatInput'), chatSend = $('chatSend');
  const gameInfo = $('gameInfo');
  const infoRound = $('infoRound'), infoTurn = $('infoTurn'), infoSide = $('infoSide');
  const infoSideBadge = $('infoSideBadge');
  const opponentArea = $('opponentArea'), opponentHand = $('opponentHand'), opponentLabel = $('opponentLabel');
  const playerArea = $('playerArea'), playerHand = $('playerHand');
  const clashArea = $('clashArea');
  const clashYour = $('clashYour').querySelector('.clash-card-inner');
  const clashOpp = $('clashOpp').querySelector('.clash-card-inner');
  const turnResult = $('turnResult');
  const scoreYouEl = $('scoreYou'), scoreOppEl = $('scoreOpp');
  const scoreYourName = $('scoreYourName'), scoreOppName = $('scoreOppName');
  const scoreboard = $('scoreboard');
  const btnRules = $('btnRules'), rulesPanel = $('rulesPanel'), rulesClose = $('rulesClose');
  const btnToggleSidebar = $('btnToggleSidebar'), btnToggleChat = $('btnToggleChat');

  roomBadge.textContent = 'Room ' + roomId;

  // ── Card display helpers ─────────────────────────────────────────
  const CARD_ICONS = { emperor: '👑', citizen: '🛡️', slave: '⛓️' };
  const CARD_LABELS = { emperor: 'Emperor', citizen: 'Citizen', slave: 'Slave' };

  function makeCardEl(type, clickable) {
    const el = document.createElement('div');
    el.className = 'e-card ' + type;
    el.innerHTML = `<div class="card-icon">${CARD_ICONS[type]}</div><div class="card-label">${CARD_LABELS[type]}</div>`;
    el.dataset.type = type;
    if (clickable) el.addEventListener('click', () => onCardClick(el));
    return el;
  }

  function makeFaceDownCard() {
    const el = document.createElement('div');
    el.className = 'e-card face-down';
    return el;
  }

  // ── State ────────────────────────────────────────────────────────
  let ws = null, myId = null;
  const others = new Map();
  let mySide = null;        // 'emperor' or 'slave'
  let myHand = [];           // array of card types: ['emperor','citizen','citizen','citizen','citizen']
  let oppCardCount = 5;
  let picked = false;
  let round = 1, turn = 1;
  let myScore = 0, oppScore = 0;
  let gameActive = false;
  let oppName = 'Opponent';

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
      wsSend({ type: 'join-room', roomId, name: myName, password, token: sessionStorage.getItem('arena-token') || '' });
    };
    ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => { statusEl.textContent = 'Disconnected. Returning to lobby…'; setTimeout(() => location.href = '/', 3000); };
  }

  function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  function handleMsg(msg) {
    switch (msg.type) {
      case 'room-joined':
        myId = msg.myId || 'self';
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

      case 'eg-start':
        onGameStart(msg);
        break;

      case 'eg-waiting':
        statusEl.textContent = 'Waiting for opponent to pick…';
        break;

      case 'eg-reveal':
        onReveal(msg);
        break;

      case 'eg-round-swap':
        onRoundSwap(msg);
        break;

      case 'eg-end':
        onGameEnd(msg);
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

  function onGameStart(msg) {
    gameActive = true;
    picked = false;
    resultOverlay.classList.remove('show');
    clashArea.style.display = 'none';
    turnResult.style.display = 'none';

    mySide = msg.side;
    myHand = msg.hand.slice();
    oppCardCount = 5;
    round = msg.round;
    turn = msg.turn;
    myScore = msg.scores.you;
    oppScore = msg.scores.opp;
    oppName = msg.oppName || 'Opponent';

    // Update display
    gameInfo.style.display = 'flex';
    opponentArea.style.display = 'flex';
    playerArea.style.display = 'flex';
    scoreboard.style.display = 'flex';

    opponentLabel.textContent = oppName;
    scoreYourName.textContent = 'You';
    scoreOppName.textContent = oppName;

    updateInfoBar();
    updateScores();
    renderMyHand();
    renderOppHand();
    updateSideBadges();
    statusEl.textContent = 'Pick a card to play!';
  }

  function onCardClick(el) {
    if (!gameActive || picked) return;
    if (el.classList.contains('used')) return;

    const cardType = el.dataset.type;
    picked = true;
    el.classList.add('picked');
    statusEl.textContent = 'Waiting for opponent…';

    wsSend({ type: 'eg-pick', card: cardType });
  }

  function onReveal(msg) {
    const yourCard = msg.yourCard;
    const oppCard = msg.oppCard;
    const result = msg.result;     // 'win', 'lose', 'draw'
    const points = msg.points;

    // Update scores
    myScore = msg.scores.you;
    oppScore = msg.scores.opp;
    updateScores();

    // Remove the played card from hand
    const idx = myHand.indexOf(yourCard);
    if (idx !== -1) myHand.splice(idx, 1);
    oppCardCount--;

    // Show clash animation
    clashArea.style.display = 'flex';
    clashArea.classList.remove('animate');
    void clashArea.offsetWidth; // force reflow
    clashArea.classList.add('animate');

    setClashCard(clashYour, yourCard);
    setClashCard(clashOpp, oppCard);

    // Show result text
    turnResult.style.display = 'block';
    turnResult.className = 'turn-result ' + result;
    if (result === 'win') {
      const pts = mySide === 'slave' ? 3 : 1;
      turnResult.textContent = 'YOU WIN! +' + pts + (pts > 1 ? ' pts' : ' pt');
    } else if (result === 'lose') {
      turnResult.textContent = 'YOU LOSE';
    } else {
      turnResult.textContent = 'DRAW';
    }

    // Re-render hands (with used cards removed)
    renderMyHand();
    renderOppHand();

    // Advance turn display
    turn = msg.turn;
    round = msg.round;
    updateInfoBar();

    statusEl.textContent = result === 'win' ? 'You won this turn!' : result === 'lose' ? 'You lost this turn.' : 'Draw — no points.';
    picked = false;
  }

  function onRoundSwap(msg) {
    mySide = msg.side;
    myHand = msg.hand.slice();
    oppCardCount = 5;
    round = msg.round;
    turn = msg.turn;

    updateInfoBar();
    renderMyHand();
    renderOppHand();
    updateSideBadges();

    clashArea.style.display = 'none';
    turnResult.style.display = 'none';
    picked = false;
    statusEl.textContent = 'Sides swapped! You are now ' + mySide.toUpperCase() + '. Pick a card!';
  }

  function onGameEnd(msg) {
    gameActive = false;
    myScore = msg.scores.you;
    oppScore = msg.scores.opp;
    updateScores();

    const won = msg.winner === 'you';
    const tied = msg.winner === 'tie';

    resultTitle.textContent = tied ? 'TIE GAME!' : (won ? 'YOU WIN!' : 'YOU LOSE');
    resultScores.innerHTML =
      `<span class="rs-you">You: ${myScore}</span>` +
      `<span class="rs-opp">${escapeHtml(oppName)}: ${oppScore}</span>`;

    setTimeout(() => resultOverlay.classList.add('show'), 1000);

    if (won) {
      launchConfetti();
      if (typeof reportScore === 'function') reportScore('egame', 1);
    }
  }

  // ── Rendering ────────────────────────────────────────────────────

  function setClashCard(el, type) {
    el.className = 'clash-card-inner ' + type;
    el.innerHTML = `<div class="card-icon">${CARD_ICONS[type]}</div><div class="card-label">${CARD_LABELS[type]}</div>`;
  }

  function renderMyHand() {
    playerHand.innerHTML = '';
    for (const type of myHand) {
      playerHand.appendChild(makeCardEl(type, true));
    }
  }

  function renderOppHand() {
    opponentHand.innerHTML = '';
    for (let i = 0; i < oppCardCount; i++) {
      opponentHand.appendChild(makeFaceDownCard());
    }
  }

  function updateInfoBar() {
    infoRound.textContent = round + '/4';
    infoTurn.textContent = turn + '/3';
    const sideEl = infoSide;
    sideEl.textContent = mySide ? mySide.toUpperCase() : '—';
    sideEl.className = 'info-value ' + (mySide || '');
  }

  function updateScores() {
    scoreYouEl.textContent = myScore;
    scoreOppEl.textContent = oppScore;
  }

  function updateSideBadges() {
    // Update player cards with side badges
    document.querySelectorAll('.pc-side').forEach(el => el.remove());

    const myCard = document.querySelector('.player-card[data-id="self"]');
    if (myCard && mySide) {
      const badge = document.createElement('span');
      badge.className = 'pc-side ' + mySide;
      badge.textContent = mySide === 'emperor' ? '👑' : '⛓️';
      myCard.appendChild(badge);
    }

    const oppSide = mySide === 'emperor' ? 'slave' : 'emperor';
    for (const [, info] of others) {
      const badge = document.createElement('span');
      badge.className = 'pc-side ' + oppSide;
      badge.textContent = oppSide === 'emperor' ? '👑' : '⛓️';
      info.el.appendChild(badge);
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
    const colors = ['#fbbf24', '#f472b6', '#38bdf8', '#34d399', '#a78bfa', '#fb923c'];
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
  //  RULES PANEL
  // ══════════════════════════════════════════════════════════════════

  btnRules.addEventListener('click', () => { rulesPanel.style.display = 'flex'; });
  rulesClose.addEventListener('click', () => { rulesPanel.style.display = 'none'; });
  rulesPanel.addEventListener('click', e => { if (e.target === rulesPanel) rulesPanel.style.display = 'none'; });

  // ══════════════════════════════════════════════════════════════════
  //  MOBILE TOGGLES
  // ══════════════════════════════════════════════════════════════════

  btnToggleSidebar.addEventListener('click', () => {
    document.querySelector('.sidebar').classList.toggle('open');
    document.querySelector('.chat-panel').classList.remove('open');
  });
  btnToggleChat.addEventListener('click', () => {
    document.querySelector('.chat-panel').classList.toggle('open');
    document.querySelector('.sidebar').classList.remove('open');
  });

  // ══════════════════════════════════════════════════════════════════
  //  EVENT LISTENERS
  // ══════════════════════════════════════════════════════════════════

  btnNewGame.addEventListener('click', () => wsSend({ type: 'eg-new' }));
  btnRematch.addEventListener('click', () => { resultOverlay.classList.remove('show'); wsSend({ type: 'eg-new' }); });
  btnBack.addEventListener('click', () => { wsSend({ type: 'leave-room' }); location.href = '/'; });

  // ══════════════════════════════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════════════════════════════
  connect();
})();

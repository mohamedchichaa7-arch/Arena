(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const btnBack        = $('btnBack');
  const btnStart       = $('btnStartGame');
  const statusEl       = $('status');
  const roomBadge      = $('roomBadge');
  const playerSeats    = $('playerSeats');
  const handCardsEl    = $('handCards');
  const handCountEl    = $('handCount');
  const drawPile       = $('drawPile');
  const drawCountEl    = $('drawCount');
  const discardCard    = $('discardCard');
  const currentColorRing = $('currentColorRing');
  const dirIndicator   = $('directionIndicator');
  const actionLog      = $('actionLog');
  const scoreList      = $('scoreList');
  const colorPicker    = $('colorPicker');
  const roundOverlay   = $('roundOverlay');
  const roundTitle     = $('roundTitle');
  const roundWinner    = $('roundWinner');
  const roundHands     = $('roundHands');
  const roundPoints    = $('roundPoints');
  const roundScores    = $('roundScores');
  const roundTimer     = $('roundTimer');
  const btnRoundReady  = $('btnRoundReady');
  const gameOverOverlay = $('gameOverOverlay');
  const goTitle        = $('goTitle');
  const goWinner       = $('goWinner');
  const goHistory      = $('goHistory');
  const btnPlayAgain   = $('btnPlayAgain');
  const btnUno         = $('btnUno');
  const chatPanel      = $('chatPanel');
  const chatBackdrop   = $('chatBackdrop');
  const chatMessages   = $('chatMessages');
  const chatInput      = $('chatInput');
  const chatSend       = $('chatSend');
  const chatClose      = $('chatClose');
  const btnChat        = $('btnToggleChat');
  const drawAnimContainer = $('drawAnimContainer');
  const tableEl        = $('table');

  // ── State ─────────────────────────────────────────────────
  let ws, myId, myName;
  let hand = [];
  let gameActive = false;
  let isMyTurn = false;
  let currentColor = null;
  let topCard = null;
  let direction = 1; // 1=CW, -1=CCW
  let currentTurnId = null;
  let drawPileCount = 0;
  let players = new Map(); // id → {name, cardCount, score, unoFlag}
  let turnOrder = [];
  let scores = {};
  let leaderId = null;
  let pendingWildCard = null; // card to play after color chosen
  let hasDrawnThisTurn = false;
  let canPlayDrawn = false;
  let drawnCardData = null;
  let roundTimerInterval = null;
  let dealingInProgress = false;

  const SEAT_COLORS = ['#8b5cf6', '#06b6d4', '#f472b6', '#e8a838', '#22c55e', '#ef4444'];
  const UNO_ASSET_DIR = 'assets/uno_cards';

  // ── Card image mapping ────────────────────────────────────
  const NUM_NAMES = {
    0:'zero',1:'one',2:'two',3:'three',4:'four',5:'five',
    6:'six',7:'seven',8:'eight',9:'nine'
  };

  function cardImgPath(card) {
    if (!card) return `${UNO_ASSET_DIR}/card_uno_card_back.png`;
    if (card.type === 'wild') return `${UNO_ASSET_DIR}/card_wild_card.png`;
    if (card.type === 'wild_draw_four') return `${UNO_ASSET_DIR}/card_wild_draw_four.png`;
    const color = card.color;
    if (card.type === 'number') return `${UNO_ASSET_DIR}/card_${color}_${NUM_NAMES[card.value]}.png`;
    if (card.type === 'skip') return `${UNO_ASSET_DIR}/card_${color}_skip.png`;
    if (card.type === 'reverse') return `${UNO_ASSET_DIR}/card_${color}_reverse.png`;
    if (card.type === 'draw_two') return `${UNO_ASSET_DIR}/card_${color}_draw_two.png`;
    return `${UNO_ASSET_DIR}/card_uno_card_back.png`;
  }

  function cardBackPath() {
    return `${UNO_ASSET_DIR}/card_uno_card_back.png`;
  }

  function cardLabel(card) {
    if (!card) return '?';
    if (card.type === 'wild') return 'Wild';
    if (card.type === 'wild_draw_four') return 'Wild +4';
    const colorName = card.color ? card.color.charAt(0).toUpperCase() + card.color.slice(1) : '';
    if (card.type === 'number') return `${colorName} ${card.value}`;
    if (card.type === 'skip') return `${colorName} Skip`;
    if (card.type === 'reverse') return `${colorName} Reverse`;
    if (card.type === 'draw_two') return `${colorName} +2`;
    return '?';
  }

  function isPlayable(card) {
    if (!gameActive || !isMyTurn || !topCard) return false;
    if (card.type === 'wild' || card.type === 'wild_draw_four') return true;
    if (card.color === currentColor) return true;
    if (card.type === 'number' && topCard.type === 'number' && card.value === topCard.value) return true;
    if (card.type !== 'number' && card.type === topCard.type) return true;
    return false;
  }

  // ── Helpers ───────────────────────────────────────────────
  function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
  function getInitials(name) { return name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?'; }

  function addLog(text, cls) {
    const el = document.createElement('div');
    el.className = 'log-entry' + (cls ? ' ' + cls : '');
    el.textContent = text;
    actionLog.prepend(el);
    if (actionLog.children.length > 30) actionLog.lastChild.remove();
  }

  // ── WebSocket ─────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  if (!roomId) { location.href = '/'; return; }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => {
      myName = sessionStorage.getItem('arena-name') || 'Player';
      const pw = sessionStorage.getItem('arena-room-password') || '';
      sessionStorage.removeItem('arena-room-password');
      ws.send(JSON.stringify({ type: 'join-room', roomId, name: myName, password: pw, token: sessionStorage.getItem('arena-token') || '' }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (handlers[msg.type]) handlers[msg.type](msg);
    };

    ws.onclose = () => {
      statusEl.textContent = 'Disconnected — reconnecting…';
      setTimeout(connect, 3000);
    };
  }

  function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  // ── Message handlers ──────────────────────────────────────
  const handlers = {
    'room-joined'(msg) {
      myId = msg.myId;
      leaderId = msg.leaderId;
      roomBadge.textContent = msg.roomId;
      statusEl.textContent = 'In room — waiting for players';
      players.clear();
      for (const p of msg.players) {
        players.set(p.id, { name: p.name, cardCount: 0, score: 0, unoFlag: false });
      }
      players.set(myId, { name: myName, cardCount: 0, score: 0, unoFlag: false });
      updateStartButton();
      renderSeats();
      renderScoreboard();
    },

    'player-joined'(msg) {
      players.set(msg.id, { name: msg.name, cardCount: 0, score: 0, unoFlag: false });
      leaderId = msg.leaderId;
      addLog(`${msg.name} joined`);
      updateStartButton();
      renderSeats();
      renderScoreboard();
    },

    'player-left'(msg) {
      const p = players.get(msg.id);
      if (p) addLog(`${p.name} left`);
      players.delete(msg.id);
      updateStartButton();
      renderSeats();
      renderScoreboard();
    },

    'error'(msg) {
      alert(msg.msg);
      if (msg.msg.includes('token') || msg.msg.includes('Auth')) {
        location.href = '/';
      }
    },

    'chat'(msg) {
      const el = document.createElement('div');
      el.className = 'chat-msg';
      el.innerHTML = `<span class="cm-name">${escapeHtml(msg.name)}</span>${escapeHtml(msg.text)}`;
      chatMessages.appendChild(el);
      chatMessages.scrollTop = chatMessages.scrollHeight;
    },

    // ── UNO game events ────────────────────────────────────
    'uno-dealt'(msg) {
      hand = msg.hand;
      topCard = msg.topCard;
      currentColor = msg.currentColor;
      direction = msg.direction;
      drawPileCount = msg.drawPileCount;
      turnOrder = msg.turnOrder;
      gameActive = true;
      hasDrawnThisTurn = false;
      canPlayDrawn = false;
      drawnCardData = null;

      btnStart.style.display = 'none';
      roundOverlay.style.display = 'none';
      gameOverOverlay.style.display = 'none';

      // Restore scores
      if (msg.scores) {
        for (const [pid, s] of Object.entries(msg.scores)) {
          const p = players.get(pid);
          if (p) p.score = s;
        }
      }

      // Start all players at 0 cards so seats render empty before deal anim
      for (const pid of Object.keys(msg.cardCounts)) {
        const p = players.get(pid);
        if (p) p.cardCount = 0;
      }

      // Show table state with empty hands, then animate deal
      renderDiscard();
      renderSeats();
      renderScoreboard();
      updateDrawCount();
      updateDirection();
      handCardsEl.innerHTML = '';
      handCountEl.textContent = '0';

      dealingInProgress = true;
      animateDeal(msg, () => {
        dealingInProgress = false;
        // Restore card counts, then reveal fans and own hand
        for (const [pid, count] of Object.entries(msg.cardCounts)) {
          const p = players.get(pid);
          if (p) p.cardCount = count;
        }
        renderSeats();
        renderHand();
        addLog('Cards dealt! Game on!', 'highlight');
        statusEl.textContent = isMyTurn ? 'Your turn!' : `${getPlayerName(currentTurnId)}'s turn`;
      });
    },

    'uno-turn'(msg) {
      currentTurnId = msg.currentTurn;
      isMyTurn = (msg.currentTurn === myId);
      hasDrawnThisTurn = false;
      canPlayDrawn = false;
      drawnCardData = null;
      statusEl.textContent = isMyTurn ? 'Your turn!' : `${getPlayerName(msg.currentTurn)}'s turn`;
      if (!dealingInProgress) {
        renderHand();
        renderSeats();
      }
    },

    'uno-played'(msg) {
      const pName = getPlayerName(msg.playerId);

      // Remove from own hand first so animatePlay can read the DOM position
      if (msg.playerId === myId && msg.handUpdate) {
        hand = msg.handUpdate;
      }

      // Animate BEFORE updating discard so we capture card's current position
      animatePlay(msg.playerId, msg.card);

      topCard = msg.card;
      currentColor = msg.currentColor;
      direction = msg.direction;
      drawPileCount = msg.drawPileCount;

      const p = players.get(msg.playerId);
      if (p) p.cardCount = msg.cardCount;

      addLog(`${pName} played ${cardLabel(msg.card)}`);
      if (msg.chosenColor) addLog(`Color → ${msg.chosenColor}`, 'highlight');

      // Update discard pile AFTER animation starts (390ms delay handled in animatePlay)
      setTimeout(() => { renderDiscard(); }, 350);
      updateDrawCount();
      updateDirection();
      renderSeats();
      renderScoreboard();
      renderHand();
    },

    'uno-drew'(msg) {
      if (msg.playerId === myId) {
        hand = msg.handUpdate;
        hasDrawnThisTurn = true;
        canPlayDrawn = !!msg.canPlay;
        drawnCardData = msg.drawnCard;
        renderHand();
        if (msg.canPlay) {
          statusEl.textContent = 'You drew — play it or pass';
        } else {
          statusEl.textContent = 'You drew — not playable, turn passes';
        }
      }
      drawPileCount = msg.drawPileCount;
      const p = players.get(msg.playerId);
      if (p) p.cardCount = msg.cardCount;
      const pName = getPlayerName(msg.playerId);
      addLog(`${pName} drew a card`);
      animateDraw(msg.playerId, msg.count || 1);
      updateDrawCount();
      renderSeats();
    },

    'uno-penalty-draw'(msg) {
      const pName = getPlayerName(msg.playerId);
      const p = players.get(msg.playerId);
      if (p) p.cardCount = msg.cardCount;
      drawPileCount = msg.drawPileCount;
      if (msg.playerId === myId && msg.handUpdate) {
        hand = msg.handUpdate;
        renderHand();
      }
      addLog(`${pName} draws ${msg.count} cards!`, 'highlight');
      animateDraw(msg.playerId, msg.count);
      updateDrawCount();
      renderSeats();
    },

    'uno-pass'(msg) {
      if (msg.playerId === myId) {
        hasDrawnThisTurn = false;
        canPlayDrawn = false;
        drawnCardData = null;
      }
      addLog(`${getPlayerName(msg.playerId)} passed`);
    },

    'uno-flag'(msg) {
      const p = players.get(msg.playerId);
      if (p) p.unoFlag = msg.flag;
      addLog(`${getPlayerName(msg.playerId)} called UNO!`, 'highlight');
      renderSeats();
    },

    'uno-round-over'(msg) {
      gameActive = false;
      isMyTurn = false;
      // Update scores
      for (const [pid, s] of Object.entries(msg.scores)) {
        const p = players.get(pid);
        if (p) p.score = s;
      }
      showRoundSummary(msg);
      renderScoreboard();
    },

    'uno-game-over'(msg) {
      gameActive = false;
      isMyTurn = false;
      showGameOver(msg);
    },

    'uno-state'(msg) {
      // Full state sync (reconnect)
      hand = msg.hand;
      topCard = msg.topCard;
      currentColor = msg.currentColor;
      direction = msg.direction;
      drawPileCount = msg.drawPileCount;
      turnOrder = msg.turnOrder;
      gameActive = msg.active;
      currentTurnId = msg.currentTurn;
      isMyTurn = msg.currentTurn === myId;

      for (const p of msg.players) {
        const existing = players.get(p.id);
        if (existing) {
          existing.cardCount = p.cardCount;
          existing.score = p.score;
          existing.unoFlag = p.unoFlag;
        } else {
          players.set(p.id, { name: p.name, cardCount: p.cardCount, score: p.score, unoFlag: p.unoFlag });
        }
      }

      btnStart.style.display = 'none';
      renderHand();
      renderDiscard();
      renderSeats();
      renderScoreboard();
      updateDrawCount();
      updateDirection();
      statusEl.textContent = isMyTurn ? 'Your turn!' : `${getPlayerName(currentTurnId)}'s turn`;
    },

    'uno-aborted'(msg) {
      gameActive = false;
      isMyTurn = false;
      statusEl.textContent = msg.reason || 'Game aborted';
      addLog(msg.reason || 'Game aborted');
      updateStartButton();
    },
  };

  // ── Player name helper ────────────────────────────────────
  function getPlayerName(pid) {
    const p = players.get(pid);
    return p ? p.name : 'Player';
  }

  // ── Update start button ───────────────────────────────────
  function updateStartButton() {
    btnStart.style.display = (!gameActive && myId === leaderId && players.size >= 2) ? '' : 'none';
  }

  // ── Render hand (fan + drag-to-sort) ─────────────────────
  let dragSrcIdx = null;   // index being dragged
  let dragGhost = null;    // the floating ghost element

  function fanAngle(i, total) {
    if (total <= 1) return 0;
    const spread = Math.min(3.5 * (total - 1), 40); // max ±20deg total
    return -spread / 2 + (spread / (total - 1)) * i;
  }
  function fanRise(i, total) {
    if (total <= 1) return 0;
    // Cards arc up from both ends toward centre (parabola)
    const mid = (total - 1) / 2;
    return -Math.pow((i - mid) / (mid || 1), 2) * 14;
  }

  function applyFanTransform(el, i, total, extraY) {
    const rot = fanAngle(i, total);
    const rise = fanRise(i, total) + (extraY || 0);
    el.style.transform = `rotate(${rot}deg) translateY(${rise}px)`;
    el.style.zIndex = i;
  }

  function renderHand() {
    handCardsEl.innerHTML = '';
    const total = hand.length;

    hand.forEach((card, i) => {
      const el = document.createElement('div');
      el.className = 'hand-card';
      const playable = isMyTurn && isPlayable(card);
      if (playable) el.classList.add('playable');
      if (!isMyTurn) el.classList.add('not-my-turn');

      applyFanTransform(el, i, total, 0);

      const img = document.createElement('img');
      img.src = cardImgPath(card);
      img.alt = cardLabel(card);
      img.draggable = false;
      el.appendChild(img);

      // Click to play
      el.addEventListener('click', () => onCardClick(card, i));

      // Hover: lift card out of fan
      el.addEventListener('mouseenter', () => {
        if (dragSrcIdx !== null) return;
        const rot = fanAngle(i, total);
        el.style.transform = `rotate(${rot}deg) translateY(-18px) scale(1.1)`;
        el.style.zIndex = 100;
        el.style.filter = playable ? 'brightness(1.12)' : '';
      });
      el.addEventListener('mouseleave', () => {
        if (dragSrcIdx !== null) return;
        applyFanTransform(el, i, total, 0);
        el.style.filter = '';
      });

      // ── Drag to sort ──────────────────────────────────────
      el.addEventListener('mousedown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        startDrag(e, i, card, el);
      });
      el.addEventListener('touchstart', e => {
        e.preventDefault();
        startDrag(e.touches[0], i, card, el);
      }, { passive: false });

      handCardsEl.appendChild(el);
    });

    handCountEl.textContent = hand.length;
    btnUno.style.display = (hand.length === 2 && isMyTurn && gameActive) ? '' : 'none';
  }

  function startDrag(e, srcIdx, card, srcEl) {
    dragSrcIdx = srcIdx;
    const rect = srcEl.getBoundingClientRect();

    // Create ghost
    if (dragGhost) dragGhost.remove();
    dragGhost = document.createElement('div');
    dragGhost.className = 'drag-ghost';
    const gImg = document.createElement('img');
    gImg.src = cardImgPath(card);
    gImg.width = 70; gImg.height = 100;
    dragGhost.appendChild(gImg);
    document.body.appendChild(dragGhost);

    const offsetX = e.clientX - rect.left;
    const offsetY = e.clientY - rect.top;

    function moveGhost(cx, cy) {
      dragGhost.style.left = (cx - offsetX) + 'px';
      dragGhost.style.top  = (cy - offsetY) + 'px';
    }
    moveGhost(e.clientX, e.clientY);

    srcEl.classList.add('dragging');

    let dropIdx = srcIdx;

    function onMove(cx, cy) {
      moveGhost(cx, cy);
      // Find which slot we're hovering over
      const cards = handCardsEl.querySelectorAll('.hand-card');
      let best = srcIdx, bestDist = Infinity;
      cards.forEach((c, i) => {
        if (i === srcIdx) return;
        const r = c.getBoundingClientRect();
        const mid = r.left + r.width / 2;
        const dist = Math.abs(cx - mid);
        if (dist < bestDist) { bestDist = dist; best = i; }
      });
      // Compute drop index from cursor vs card midpoints
      const newDrop = getDropIndex(cx);
      if (newDrop !== dropIdx) {
        dropIdx = newDrop;
        showDropPreview(dropIdx);
      }
    }

    function onMouseMove(me) { onMove(me.clientX, me.clientY); }
    function onTouchMove(te) { te.preventDefault(); onMove(te.touches[0].clientX, te.touches[0].clientY); }

    function finish(cx, cy) {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('touchmove', onTouchMove);
      document.removeEventListener('touchend', onTouchEnd);

      dragGhost.remove(); dragGhost = null;
      dragSrcIdx = null;

      // Commit reorder
      if (dropIdx !== srcIdx) {
        const newHand = [...hand];
        const [moved] = newHand.splice(srcIdx, 1);
        newHand.splice(dropIdx, 0, moved);
        hand = newHand;
      }
      renderHand();
    }
    function onMouseUp(me) { finish(me.clientX, me.clientY); }
    function onTouchEnd(te) {
      const t = te.changedTouches[0];
      finish(t.clientX, t.clientY);
    }

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('touchmove', onTouchMove, { passive: false });
    document.addEventListener('touchend', onTouchEnd);
  }

  function getDropIndex(cursorX) {
    const cards = handCardsEl.querySelectorAll('.hand-card');
    // Build list of midpoint X for each card
    const mids = Array.from(cards).map(c => {
      const r = c.getBoundingClientRect();
      return r.left + r.width / 2;
    });
    // Find first slot where cursor is left of that card's mid
    for (let i = 0; i < mids.length; i++) {
      if (cursorX < mids[i]) return i;
    }
    return mids.length - 1;
  }

  function showDropPreview(dropIdx) {
    const cards = handCardsEl.querySelectorAll('.hand-card');
    cards.forEach((c, i) => {
      c.classList.remove('drag-over-left', 'drag-over-right', 'drop-preview');
      if (i === dragSrcIdx) return;
      if (i === dropIdx) {
        c.classList.add('drop-preview');
      } else if (i === dropIdx - 1) {
        c.classList.add('drag-over-right');
      } else if (i === dropIdx) {
        c.classList.add('drag-over-left');
      }
    });
  }


  // ── Render discard pile ──────────────────────────────────
  function renderDiscard() {
    discardCard.innerHTML = '';
    if (topCard) {
      const img = document.createElement('img');
      img.src = cardImgPath(topCard);
      img.alt = cardLabel(topCard);
      discardCard.appendChild(img);
    }
    // Update color ring
    currentColorRing.className = 'current-color-ring';
    if (currentColor) currentColorRing.classList.add(currentColor);
  }

  // ── Render seats ─────────────────────────────────────────
  function renderSeats() {
    playerSeats.innerHTML = '';
    const otherIds = turnOrder.filter(id => id !== myId);
    const count = otherIds.length;
    if (count === 0) return;

    // Position opponents around top of table
    const tableRect = tableEl.getBoundingClientRect();
    const cx = tableRect.width / 2;
    const cy = tableRect.height / 2;

    otherIds.forEach((pid, i) => {
      const p = players.get(pid);
      if (!p) return;
      const colorIdx = turnOrder.indexOf(pid) % SEAT_COLORS.length;

      // Distribute seats in an arc at the top
      const angle = Math.PI + (Math.PI * (i + 1)) / (count + 1);
      const rx = Math.min(cx * 0.7, 280);
      const ry = Math.min(cy * 0.6, 180);
      const x = cx + rx * Math.cos(angle);
      const y = cy + ry * Math.sin(angle) - 20;

      const seat = document.createElement('div');
      seat.id = `seat-${pid}`;
      seat.className = 'seat';
      seat.style.left = x + 'px';
      seat.style.top = y + 'px';
      seat.style.transform = 'translate(-50%, -50%)';

      // Fan of face-down cards (show opponent's hand as card backs)
      const fanEl = document.createElement('div');
      fanEl.className = 'seat-hand-fan';
      const displayCount = Math.min(p.cardCount || 0, 14);
      for (let ci = 0; ci < displayCount; ci++) {
        const cardEl = document.createElement('div');
        cardEl.className = 'seat-fan-card';
        cardEl.style.transform = `rotate(${fanAngle(ci, displayCount)}deg) translateY(${fanRise(ci, displayCount)}px)`;
        cardEl.style.zIndex = ci;
        const img = document.createElement('img');
        img.src = cardBackPath();
        img.draggable = false;
        cardEl.appendChild(img);
        fanEl.appendChild(cardEl);
      }
      seat.appendChild(fanEl);

      const isCurrentTurn = pid === currentTurnId;
      const avatarEl = document.createElement('div');
      avatarEl.className = 'seat-avatar' + (isCurrentTurn ? ' active-turn' : '');
      avatarEl.style.background = SEAT_COLORS[colorIdx];
      avatarEl.textContent = getInitials(p.name);
      seat.appendChild(avatarEl);

      const nameEl = document.createElement('div');
      nameEl.className = 'seat-name';
      nameEl.textContent = p.name;
      seat.appendChild(nameEl);

      const cardsEl = document.createElement('div');
      cardsEl.className = 'seat-cards';
      cardsEl.textContent = `${p.cardCount} card${p.cardCount !== 1 ? 's' : ''}`;
      seat.appendChild(cardsEl);

      const unoBadge = document.createElement('div');
      unoBadge.className = 'seat-uno-badge' + (p.unoFlag ? ' show' : '');
      unoBadge.textContent = 'UNO';
      seat.appendChild(unoBadge);

      playerSeats.appendChild(seat);
    });
  }

  // ── Render scoreboard ────────────────────────────────────
  function renderScoreboard() {
    scoreList.innerHTML = '';
    const sorted = [...players.entries()].sort((a, b) => (b[1].score || 0) - (a[1].score || 0));
    for (const [pid, p] of sorted) {
      const row = document.createElement('div');
      row.className = 'sb-row';
      row.innerHTML = `<span class="sb-name">${escapeHtml(p.name)}${pid === myId ? ' (you)' : ''}</span><span class="sb-score">${p.score || 0}</span>`;
      scoreList.appendChild(row);
    }
  }

  // ── Update counters ──────────────────────────────────────
  function updateDrawCount() { drawCountEl.textContent = drawPileCount; }
  function updateDirection() {
    dirIndicator.classList.toggle('ccw', direction === -1);
    dirIndicator.title = direction === 1 ? 'Clockwise' : 'Counter-clockwise';
  }
  function onCardClick(card, index) {
    if (!gameActive || !isMyTurn) return;
    if (dragSrcIdx !== null) return; // ignore click that ends a drag

    // If we drew this turn and can play the drawn card, only allow the drawn card (last in hand)
    if (hasDrawnThisTurn && canPlayDrawn) {
      if (index !== hand.length - 1) return;
    } else if (hasDrawnThisTurn) {
      return; // drew but card not playable
    }

    if (!isPlayable(card)) return;

    // Wild cards → show color picker
    if (card.type === 'wild' || card.type === 'wild_draw_four') {
      pendingWildCard = { card, index };
      colorPicker.style.display = '';
      return;
    }

    wsSend({ type: 'uno-play', cardIndex: index });
  }

  // ── Color picker ─────────────────────────────────────────
  document.querySelectorAll('.color-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!pendingWildCard) return;
      const chosenColor = btn.dataset.color;
      wsSend({ type: 'uno-play', cardIndex: pendingWildCard.index, chosenColor });
      pendingWildCard = null;
      colorPicker.style.display = 'none';
    });
  });

  // ── Draw pile click ──────────────────────────────────────
  drawPile.addEventListener('click', () => {
    if (!gameActive || !isMyTurn) return;
    if (!hasDrawnThisTurn) {
      wsSend({ type: 'uno-draw' });
    } else if (hasDrawnThisTurn && canPlayDrawn) {
      // Player chose not to play drawn card — pass
      wsSend({ type: 'uno-pass' });
    }
  });

  // ── UNO button ───────────────────────────────────────────
  btnUno.addEventListener('click', () => {
    wsSend({ type: 'uno-call-uno' });
  });

  // ── Start button ─────────────────────────────────────────
  btnStart.addEventListener('click', () => {
    wsSend({ type: 'uno-start' });
  });

  // ── Back button ──────────────────────────────────────────
  btnBack.addEventListener('click', () => { location.href = '/'; });

  // ── Play again ───────────────────────────────────────────
  btnPlayAgain.addEventListener('click', () => { location.href = '/'; });

  // ── Round ready ──────────────────────────────────────────
  btnRoundReady.addEventListener('click', () => {
    roundOverlay.style.display = 'none';
    if (roundTimerInterval) { clearInterval(roundTimerInterval); roundTimerInterval = null; }
  });

  // ── Chat ─────────────────────────────────────────────────
  btnChat.addEventListener('click', () => { chatPanel.classList.toggle('open'); chatBackdrop.classList.toggle('show'); });
  chatClose.addEventListener('click', () => { chatPanel.classList.remove('open'); chatBackdrop.classList.remove('show'); });
  chatBackdrop.addEventListener('click', () => { chatPanel.classList.remove('open'); chatBackdrop.classList.remove('show'); });
  chatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    chatInput.value = '';
    wsSend({ type: 'chat', text });
    // Show own message
    const el = document.createElement('div');
    el.className = 'chat-msg';
    el.innerHTML = `<span class="cm-name">${escapeHtml(myName)}</span>${escapeHtml(text)}`;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  // ── Animations ────────────────────────────────────────────
  function animatePlay(playerId, card) {
    // Get destination (discard pile)
    const discardRect = discardCard.getBoundingClientRect();
    const destX = discardRect.left + discardRect.width / 2;
    const destY = discardRect.top + discardRect.height / 2;

    let startX, startY, startW, startH;
    if (playerId === myId) {
      // Find the played card element before renderHand clears it
      const cardEls = handCardsEl.querySelectorAll('.hand-card');
      // The card at the played index
      const playedEl = cardEls[hand.indexOf(card)] || cardEls[cardEls.length - 1];
      if (playedEl) {
        const r = playedEl.getBoundingClientRect();
        startX = r.left + r.width / 2;
        startY = r.top + r.height / 2;
        startW = r.width; startH = r.height;
      } else {
        startX = destX; startY = destY + 120; startW = 70; startH = 100;
      }
    } else {
      const seatEl = document.getElementById(`seat-${playerId}`);
      if (seatEl) {
        const r = seatEl.getBoundingClientRect();
        startX = r.left + r.width / 2; startY = r.top + r.height / 2;
      } else { startX = destX; startY = destY - 140; }
      startW = 40; startH = 57;
    }

    const W = discardRect.width, H = discardRect.height;

    // Create flying element
    const anim = document.createElement('div');
    anim.style.cssText = `position:fixed;z-index:200;pointer-events:none;will-change:transform,opacity;
      left:${startX - startW/2}px;top:${startY - startH/2}px;
      width:${startW}px;height:${startH}px`;
    const img = document.createElement('img');
    img.src = cardImgPath(card);
    img.style.cssText = `width:100%;height:100%;display:block;image-rendering:pixelated;image-rendering:-moz-crisp-edges`;
    anim.appendChild(img);
    document.body.appendChild(anim);

    const dx = destX - startX - (W - startW) / 2;
    const dy = destY - startY - (H - startH) / 2;
    const scaleX = W / startW;
    const scaleY = H / startH;

    // Force initial paint, then animate
    requestAnimationFrame(() => requestAnimationFrame(() => {
      anim.style.transition = 'transform .38s cubic-bezier(.22,1,.36,1), opacity .38s';
      anim.style.transform = `translate(${dx}px,${dy}px) scale(${scaleX},${scaleY})`;
    }));

    setTimeout(() => {
      anim.remove();
      // Add landing pop to discard card
      const dImg = discardCard.querySelector('img');
      if (dImg) { dImg.classList.remove('discard-land'); void dImg.offsetWidth; dImg.classList.add('discard-land'); }
    }, 390);
  }

  function animateDraw(playerId, count) {
    const sourceRect = drawPile.getBoundingClientRect();
    const srcX = sourceRect.left + sourceRect.width / 2;
    const srcY = sourceRect.top + sourceRect.height / 2;

    let targetX, targetY;
    if (playerId === myId) {
      const handRect = handCardsEl.getBoundingClientRect();
      targetX = handRect.left + handRect.width / 2;
      targetY = handRect.top + 50;
    } else {
      const seatEl = document.getElementById(`seat-${playerId}`);
      if (seatEl) {
        const r = seatEl.getBoundingClientRect();
        targetX = r.left + r.width / 2; targetY = r.top + r.height / 2;
      } else { targetX = srcX; targetY = srcY + 120; }
    }

    const W = 70, H = 100;
    for (let i = 0; i < count; i++) {
      setTimeout(() => {
        const anim = document.createElement('div');
        anim.style.cssText = `position:fixed;z-index:200;pointer-events:none;will-change:transform;
          left:${srcX - W/2}px;top:${srcY - H/2}px;width:${W}px;height:${H}px`;
        const img = document.createElement('img');
        img.src = cardBackPath();
        img.style.cssText = 'width:100%;height:100%;display:block;image-rendering:pixelated;image-rendering:-moz-crisp-edges';
        anim.appendChild(img);
        document.body.appendChild(anim);

        const dx = targetX - srcX;
        const dy = targetY - srcY;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          anim.style.transition = 'transform .42s cubic-bezier(.22,1,.36,1), opacity .42s';
          anim.style.transform = `translate(${dx}px,${dy}px) scale(.7)`;
          anim.style.opacity = '.15';
        }));
        setTimeout(() => anim.remove(), 440);
      }, i * 130);
    }
  }

  // ── Deal animation (round start) ─────────────────────────
  function animateDeal(msg, callback) {
    statusEl.textContent = 'Dealing cards…';
    const sourceRect = drawPile.getBoundingClientRect();
    const srcX = sourceRect.left + sourceRect.width / 2;
    const srcY = sourceRect.top + sourceRect.height / 2;

    // Build round-robin deal sequence matching how cards are physically dealt
    const maxCards = Math.max(...Object.values(msg.cardCounts));
    const sequence = [];
    for (let round = 0; round < maxCards; round++) {
      for (const pid of msg.turnOrder) {
        const cnt = msg.cardCounts[pid] || 0;
        if (round < cnt) sequence.push(pid);
      }
    }
    if (sequence.length === 0) { if (callback) callback(); return; }

    const W = 40, H = 57; // card back size for deal anim

    sequence.forEach((pid, i) => {
      setTimeout(() => {
        let targetX, targetY;
        if (pid === myId) {
          const tray = handCardsEl.getBoundingClientRect();
          targetX = tray.left + tray.width / 2;
          targetY = tray.top + tray.height / 2;
        } else {
          const seatEl = document.getElementById(`seat-${pid}`);
          if (seatEl) {
            const r = seatEl.getBoundingClientRect();
            targetX = r.left + r.width / 2;
            targetY = r.top + r.height / 2;
          } else {
            targetX = srcX; targetY = srcY + 100;
          }
        }

        const anim = document.createElement('div');
        anim.style.cssText = `position:fixed;z-index:200;pointer-events:none;will-change:transform,opacity;
          left:${srcX - W / 2}px;top:${srcY - H / 2}px;width:${W}px;height:${H}px`;
        const img = document.createElement('img');
        img.src = cardBackPath();
        img.style.cssText = 'width:100%;height:100%;display:block;image-rendering:pixelated;image-rendering:-moz-crisp-edges';
        anim.appendChild(img);
        document.body.appendChild(anim);

        const dx = targetX - srcX;
        const dy = targetY - srcY;
        requestAnimationFrame(() => requestAnimationFrame(() => {
          anim.style.transition = 'transform .32s cubic-bezier(.22,1,.36,1), opacity .32s';
          anim.style.transform = `translate(${dx}px,${dy}px)`;
          anim.style.opacity = pid === myId ? '1' : '0.55';
        }));
        setTimeout(() => anim.remove(), 340);

        // After the last card lands, reveal everything
        if (i === sequence.length - 1) {
          setTimeout(() => { if (callback) callback(); }, 400);
        }
      }, i * 75);
    });
  }

  // ── Round summary ────────────────────────────────────────
  function showRoundSummary(msg) {
    roundTitle.textContent = `Round ${msg.roundNum} Over!`;
    roundWinner.textContent = `${msg.winnerName} went out!`;

    roundHands.innerHTML = '';
    for (const ph of msg.playerHands) {
      const row = document.createElement('div');
      row.className = 'round-hand-row';
      let cardsHtml = '';
      for (const c of ph.cards) {
        cardsHtml += `<img src="${cardImgPath(c)}" alt="${cardLabel(c)}">`;
      }
      row.innerHTML = `
        <span class="round-hand-name">${escapeHtml(ph.name)}</span>
        <div class="round-hand-cards">${cardsHtml}</div>
        <span class="round-hand-pts">${ph.points} pts</span>
      `;
      roundHands.appendChild(row);
    }

    roundPoints.textContent = `${msg.winnerName} scored ${msg.roundScore} points this round!`;

    roundScores.innerHTML = '';
    const scoreEntries = Object.entries(msg.scores).sort((a, b) => b[1] - a[1]);
    for (const [pid, sc] of scoreEntries) {
      const row = document.createElement('div');
      row.className = 'round-score-row';
      row.innerHTML = `<span>${escapeHtml(getPlayerName(pid))}</span><span>${sc}</span>`;
      roundScores.appendChild(row);
    }

    // Timer
    let countdown = 10;
    roundTimer.textContent = `Next round in ${countdown}s`;
    if (roundTimerInterval) clearInterval(roundTimerInterval);
    roundTimerInterval = setInterval(() => {
      countdown--;
      if (countdown <= 0) {
        clearInterval(roundTimerInterval);
        roundTimerInterval = null;
        roundOverlay.style.display = 'none';
      } else {
        roundTimer.textContent = `Next round in ${countdown}s`;
      }
    }, 1000);

    roundOverlay.style.display = '';
  }

  // ── Game over ────────────────────────────────────────────
  function showGameOver(msg) {
    roundOverlay.style.display = 'none';
    if (roundTimerInterval) { clearInterval(roundTimerInterval); roundTimerInterval = null; }

    goTitle.textContent = '🏆 Game Over!';
    goWinner.textContent = `${msg.winnerName} wins with ${msg.winnerScore} points!`;

    goHistory.innerHTML = '<h4 style="margin-bottom:8px;color:var(--muted)">Score History</h4>';
    if (msg.roundHistory) {
      for (const rh of msg.roundHistory) {
        const row = document.createElement('div');
        row.className = 'go-round-row';
        const parts = Object.entries(rh.scores).map(([pid, s]) => `${getPlayerName(pid)}: ${s}`).join(' | ');
        row.textContent = `Round ${rh.round}: Winner ${rh.winnerName} (+${rh.points}) — ${parts}`;
        goHistory.appendChild(row);
      }
    }

    // Final scores
    const finalDiv = document.createElement('div');
    finalDiv.style.marginTop = '12px';
    const finalEntries = Object.entries(msg.finalScores).sort((a, b) => b[1] - a[1]);
    for (const [pid, sc] of finalEntries) {
      const row = document.createElement('div');
      row.className = 'round-score-row';
      row.innerHTML = `<span style="font-weight:700">${escapeHtml(getPlayerName(pid))}</span><span style="color:var(--gold);font-weight:700">${sc}</span>`;
      finalDiv.appendChild(row);
    }
    goHistory.appendChild(finalDiv);

    gameOverOverlay.style.display = '';

    // Report score for winner
    if (msg.winnerId === myId) {
      reportScore('uno', 1);
    }
  }

  // ── Init ─────────────────────────────────────────────────
  connect();
})();

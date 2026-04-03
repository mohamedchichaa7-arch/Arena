(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const btnBack = $('btnBack');
  const btnStart = $('btnStartGame');
  const status = $('status');
  const roomBadge = $('roomBadge');
  const playerList = $('playerList');
  const playerCount = $('playerCount');
  const handCards = $('handCards');
  const handCount = $('handCount');
  const pileCards = $('pileCards');
  const pileLabel = $('pileLabel');
  const playArea = $('playArea');
  const btnPlay = $('btnPlayCards');
  const btnChallenge = $('btnChallenge');
  const announceNum = $('announceNum');
  const actionLog = $('actionLog');
  const revealOverlay = $('revealOverlay');
  const revealTitle = $('revealTitle');
  const revealCardsEl = $('revealCards');
  const revealResult = $('revealResult');
  const challengeFlashEl = $('challengeFlash');
  const gameOverOverlay = $('gameOverOverlay');
  const goTitle = $('goTitle');
  const goRankings = $('goRankings');
  const btnPlayAgain = $('btnPlayAgain');
  const chatMessages = $('chatMessages');
  const chatInput = $('chatInput');
  const chatSend = $('chatSend');

  // ── State ─────────────────────────────────────────────────────
  let ws, myId, myName;
  let hand = [];           // [{num, suit}]
  let selectedIndices = new Set();
  let gameActive = false;
  let myTurn = false;
  let canChallenge = false;
  let currentMeldNum = null;
  let currentTurnId = null;
  let players = new Map(); // id -> {name, cardCount, eliminated, rank}
  let discardHistory = []; // [{playerName, num}]
  let rankings = [];

  const SUITS = ['♠', '♥', '♦', '♣'];
  const SUIT_COLORS = { '♠': 'black', '♥': 'red', '♦': 'red', '♣': 'black' };

  // ── Helpers ───────────────────────────────────────────────────
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function cardLabel(num) {
    if (num === 1) return 'A';
    if (num === 11) return 'J';
    if (num === 12) return 'Q';
    if (num === 13) return 'K';
    return String(num);
  }

  // ── WebSocket ─────────────────────────────────────────────────
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
      ws.send(JSON.stringify({ type: 'join-room', roomId, name: myName, password: pw }));
    };

    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      handlers[msg.type]?.(msg);
    };

    ws.onclose = () => {
      status.textContent = 'Disconnected — refreshing…';
      setTimeout(() => location.reload(), 2000);
    };
  }

  function wsSend(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // ── Message handlers ──────────────────────────────────────────
  const handlers = {
    'room-joined'(msg) {
      myId = msg.players ? undefined : undefined; // set below
      roomBadge.textContent = msg.roomName + ' #' + msg.roomId;
      status.textContent = 'In room — waiting for players…';
      // We don't know our own ID directly; the server sends it in br-state
    },

    'error'(msg) {
      status.textContent = msg.msg;
    },

    'player-joined'(msg) {
      addLog(`<span class="feed-name">${escapeHtml(msg.name)}</span> joined the room`, 'info');
    },

    'player-left'(msg) {
      const p = players.get(msg.id);
      addLog(`<span class="feed-name">${escapeHtml(p?.name || 'Player')}</span> left`, 'info');
    },

    // ── Bluff Rummy specific ─────────────────────────────────
    'br-state'(msg) {
      // Full state sync
      myId = msg.yourId;
      hand = msg.hand || [];
      gameActive = msg.active;
      myTurn = msg.currentTurn === myId;
      canChallenge = msg.canChallenge && msg.currentTurn === myId;
      currentMeldNum = msg.meldNum;
      currentTurnId = msg.currentTurn || null;
      rankings = msg.rankings || [];

      // Update players map
      players.clear();
      for (const p of msg.players) {
        players.set(p.id, { name: p.name, cardCount: p.cardCount, eliminated: p.eliminated, rank: p.rank });
      }

      renderPlayers();
      renderHand();
      renderPile(msg.meldSize || 0, msg.meldNum);
      if (msg.discards) { discardHistory = msg.discards; updateDiscardDeck(); }
      updateControls();

      if (!gameActive && rankings.length === 0) {
        status.textContent = myTurn ? '' : 'Waiting for game to start…';
        btnStart.style.display = '';
        playArea.style.display = 'none';
      }
    },

    'br-dealt'(msg) {
      hand = msg.hand;
      gameActive = true;
      btnStart.style.display = 'none';
      discardHistory = msg.discards || [];
      updateDiscardDeck();
      renderHand(true);
      addLog('Cards dealt! Game started.', 'info');
    },

    'br-auto-discard'(msg) {
      const p = players.get(msg.playerId);
      const playerName = p?.name || 'Player';
      addLog(`<span class="feed-name">${escapeHtml(playerName)}</span> auto-discarded 4 × ${cardLabel(msg.num)}`, 'discard');
      discardHistory.push({ playerName, num: msg.num });
      animateDiscard(msg.num);
    },

    'br-turn'(msg) {
      myTurn = msg.currentTurn === myId;
      canChallenge = msg.canChallenge && myTurn;
      currentMeldNum = msg.meldNum;
      currentTurnId = msg.currentTurn;
      const turnPlayer = players.get(msg.currentTurn);
      if (myTurn) {
        status.textContent = canChallenge ? 'Your turn — play cards or challenge!' : 'Your turn — play cards!';
      } else {
        status.textContent = `${escapeHtml(turnPlayer?.name || 'Opponent')}'s turn…`;
      }
      updateControls();
      renderPlayers();
    },

    'br-play'(msg) {
      const p = players.get(msg.playerId);
      if (p) p.cardCount = msg.cardCount;
      addLog(`<span class="log-name">${escapeHtml(p?.name || '?')}</span> played ${msg.count} card(s) as "${cardLabel(msg.announcedNum)}s"`);
      renderPile(msg.meldSize, msg.meldNum);
      renderPlayers();

      // If it was us, remove played cards from hand
      if (msg.playerId === myId) {
        hand = msg.newHand || hand;
        selectedIndices.clear();
        renderHand();
      }
    },

    'br-challenge'(msg) {
      addLog(`<span class="feed-name">${escapeHtml(msg.challengerName)}</span> challenges <span class="feed-name">${escapeHtml(msg.targetName)}</span>!`, 'challenge');
      triggerChallengeSequence();
    },

    'br-reveal'(msg) {
      showRevealOverlay(msg);
      if (msg.wasBluff) {
        addLog(`<span class="feed-name">${escapeHtml(msg.challengerName)}</span> caught <span class="feed-name">${escapeHtml(msg.targetName)}</span> bluffing! +${msg.cards.length} cards`, 'bluff');
      } else {
        addLog(`<span class="feed-name">${escapeHtml(msg.targetName)}</span> was honest — <span class="feed-name">${escapeHtml(msg.challengerName)}</span> takes ${msg.cards.length} card${msg.cards.length !== 1 ? 's' : ''}`, 'honest');
      }
    },

    'br-hand-update'(msg) {
      hand = msg.hand;
      selectedIndices.clear();
      renderHand();
    },

    'br-player-update'(msg) {
      for (const p of msg.players) {
        const existing = players.get(p.id);
        if (existing) Object.assign(existing, p);
        else players.set(p.id, p);
      }
      renderPlayers();
    },

    'br-eliminate'(msg) {
      const p = players.get(msg.playerId);
      if (p) { p.eliminated = true; p.rank = msg.rank; }
      const label = msg.playerId === myId ? 'You' : escapeHtml(p?.name || 'Player');
      addLog(`<span class="feed-name">${label}</span> finished in place #${msg.rank}!`, 'win');
      renderPlayers();
    },

    'br-gameover'(msg) {
      gameActive = false;
      rankings = msg.rankings;
      showGameOver(msg.rankings);
    },

    'br-new-meld'(msg) {
      currentMeldNum = null;
      pileCards.innerHTML = '';
      pileLabel.textContent = '🔀 New meld — ' + (msg.starterName || 'Someone') + ' starts';
      addLog(`New meld started by <span class="feed-name">${escapeHtml(msg.starterName || '?')}</span>`, 'meld');
      flashPileArea();
    },

    // ── Chat ─────────────────────────────────────────────────
    'chat'(msg) {
      appendChat(msg.name, msg.text, 'other');
    },
  };

  // ── UI Rendering ──────────────────────────────────────────────
  function renderPlayers() {
    playerList.innerHTML = '';
    let count = 0;
    for (const [pid, p] of players) {
      count++;
      const div = document.createElement('div');
      div.className = 'player-card' +
        (pid === myId ? ' me' : '') +
        (p.eliminated ? ' eliminated' : '') +
        (pid === currentTurnId && gameActive && !p.eliminated ? ' active-turn' : '');

      const colors = ['#8b5cf6', '#06b6d4', '#f472b6', '#fbbf24', '#22c55e', '#ef4444', '#a78bfa', '#34d399'];
      const ci = [...players.keys()].indexOf(pid) % colors.length;
      const badge = p.eliminated ? (p.rank === 1 ? '🏆' : `#${p.rank}`) : `🃏 ${p.cardCount}`;

      div.innerHTML = `
        <span class="pc-dot" style="background:${colors[ci]}"></span>
        <span class="pc-name">${escapeHtml(p.name)}${pid === myId ? ' (You)' : ''}</span>
        <span class="pc-cards">${badge}</span>`;
      playerList.appendChild(div);
    }
    playerCount.textContent = count;
  }

  function renderHand(animate) {
    handCards.innerHTML = '';
    selectedIndices.clear();
    handCount.textContent = hand.length;

    // Sort hand by number then suit
    const sorted = hand.map((c, i) => ({ ...c, origIdx: i }));
    sorted.sort((a, b) => a.num - b.num || SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit));
    hand = sorted.map(c => ({ num: c.num, suit: c.suit }));

    hand.forEach((card, i) => {
      const el = document.createElement('div');
      const colorClass = SUIT_COLORS[card.suit] || 'black';
      el.className = `game-card ${colorClass}` + (animate ? ' dealt' : '');
      if (animate) el.style.animationDelay = `${i * 0.06}s`;

      el.innerHTML = `
        <span class="card-corner">${cardLabel(card.num)}<br>${card.suit}</span>
        <span class="card-num">${cardLabel(card.num)}</span>
        <span class="card-suit">${card.suit}</span>`;

      el.addEventListener('click', () => {
        if (!myTurn || !gameActive) return;
        if (selectedIndices.has(i)) {
          selectedIndices.delete(i);
          el.classList.remove('selected');
        } else {
          if (selectedIndices.size >= 3) return; // max 3
          selectedIndices.add(i);
          el.classList.add('selected');
        }
      });

      handCards.appendChild(el);
    });
  }

  function renderPile(size, num) {
    pileCards.innerHTML = '';
    if (num) {
      pileLabel.textContent = `🏦 Meld: “${cardLabel(num)}s”`;
    } else {
      pileLabel.textContent = 'No meld yet';
    }
    // Show up to 5 stacked face-down cards + a count badge
    const show = Math.min(size, 5);
    for (let i = 0; i < show; i++) {
      const el = document.createElement('div');
      el.className = 'pile-card face-down';
      el.style.animationDelay = `${i * 0.06}s`;
      pileCards.appendChild(el);
    }
    if (size > 0) {
      const badge = document.createElement('span');
      badge.className = 'pile-count-badge';
      badge.textContent = `×${size}`;
      pileCards.appendChild(badge);
    }
  }

  function updateControls() {
    if (!gameActive) {
      playArea.style.display = 'none';
      return;
    }
    playArea.style.display = '';
    btnPlay.disabled = !myTurn;
    btnChallenge.style.display = canChallenge ? '' : 'none';

    // Rebuild announce-number select, excluding already-discarded numbers
    const discardedNums = new Set(discardHistory.map(d => d.num));
    const prevVal = announceNum.value;
    announceNum.innerHTML = '';
    for (let n = 1; n <= 13; n++) {
      if (discardedNums.has(n)) continue;
      const opt = document.createElement('option');
      opt.value = String(n);
      const labels = { 1:'A — Ace', 11:'J — Jack', 12:'Q — Queen', 13:'K — King' };
      opt.textContent = labels[n] || String(n);
      announceNum.appendChild(opt);
    }

    if (currentMeldNum) {
      announceNum.value = String(currentMeldNum);
      announceNum.disabled = true;
    } else {
      if (announceNum.querySelector(`option[value="${prevVal}"]`)) announceNum.value = prevVal;
      announceNum.disabled = !myTurn;
    }
  }

  const FEED_ICONS = { play:'🃏', challenge:'🤥', bluff:'😤', honest:'✅', win:'🏆', meld:'🔀', discard:'♻️', info:'ℹ️' };
  function addLog(html, type) {
    const cls = type || 'info';
    const div = document.createElement('div');
    div.className = `feed-entry feed-${cls}`;
    const icon = document.createElement('span');
    icon.className = 'feed-icon';
    icon.textContent = FEED_ICONS[cls] || 'ℹ️';
    const text = document.createElement('span');
    text.innerHTML = html;
    div.appendChild(icon);
    div.appendChild(text);
    actionLog.insertBefore(div, actionLog.firstChild);
    while (actionLog.children.length > 40) actionLog.removeChild(actionLog.lastChild);
  }

  // ── Reveal banner (auto-dismisses after ~4.5 s) ────────────────
  let _revealTimer = null;
  function showRevealOverlay(msg) {
    revealCardsEl.innerHTML = '';
    const annNum = msg.announcedNum;
    const wasBluff = msg.wasBluff;

    for (let i = 0; i < msg.cards.length; i++) {
      const c = msg.cards[i];
      const honest = c.num === annNum;
      const colorClass = SUIT_COLORS[c.suit] || 'black';
      const el = document.createElement('div');
      el.className = `reveal-card ${colorClass} ${honest ? 'honest' : 'bluff'}`;
      el.style.animationDelay = `${i * 0.14}s`;
      el.innerHTML = `<span class="rv-num">${cardLabel(c.num)}</span><span class="rv-suit">${c.suit}</span>`;
      revealCardsEl.appendChild(el);
    }

    const challengerName = escapeHtml(msg.challengerName);
    const targetName     = escapeHtml(msg.targetName);

    if (wasBluff) {
      revealTitle.className   = 'reveal-banner-title bluff';
      revealTitle.textContent = 'BLUFF CAUGHT!';
      revealResult.innerHTML  = `<span style="color:var(--green)">${challengerName}</span> was right!<br><span style="color:var(--red)">${targetName}</span> takes ${msg.cards.length} card${msg.cards.length !== 1 ? 's' : ''}!`;
    } else {
      revealTitle.className   = 'reveal-banner-title honest';
      revealTitle.textContent = 'HONEST PLAY!';
      revealResult.innerHTML  = `<span style="color:var(--green)">${targetName}</span> was telling the truth!<br><span style="color:var(--red)">${challengerName}</span> takes ${msg.cards.length} card${msg.cards.length !== 1 ? 's' : ''}!`;
    }

    const banner = $('revealOverlay');
    const bar    = $('revealCountdownBar');
    banner.classList.add('show');
    bar.style.transition = 'none'; bar.style.width = '100%';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bar.style.transition = 'width 4500ms linear'; bar.style.width = '0%';
    }));
    clearTimeout(_revealTimer);
    _revealTimer = setTimeout(() => banner.classList.remove('show'), 4500);
  }

  // ── Challenge screen flash ────────────────────────────────────
  function triggerChallengeSequence() {
    challengeFlashEl.classList.remove('active');
    void challengeFlashEl.offsetWidth;
    challengeFlashEl.classList.add('active');
    setTimeout(() => challengeFlashEl.classList.remove('active'), 700);
  }

  // ── Pile area new-meld flash ──────────────────────────────────
  function flashPileArea() {
    const el = document.querySelector('.pile-area');
    if (!el) return;
    el.classList.remove('meld-flash'); void el.offsetWidth;
    el.classList.add('meld-flash');
    setTimeout(() => el.classList.remove('meld-flash'), 600);
  }

  // ── Discard animation system ─────────────────────────────────
  function animateDiscard(num) {
    const deckEl = $('discardDeck');
    const pileEl = document.querySelector('.pile-area');
    if (!deckEl || !pileEl) return;

    const deckRect  = deckEl.getBoundingClientRect();
    const pileRect  = pileEl.getBoundingClientRect();
    const targetX   = deckRect.left + deckRect.width  / 2;
    const targetY   = deckRect.top  + deckRect.height / 2;
    // Source: centre of the meld pile
    const srcX = pileRect.left + pileRect.width  / 2;
    const srcY = pileRect.top  + pileRect.height / 2;

    const dirs = [-1, 1, -1, 1]; // alternate spin direction per card
    for (let i = 0; i < 4; i++) {
      setTimeout(() => {
        const ghost = document.createElement('div');
        ghost.className = 'discard-ghost';
        // Small random jitter so cards don't stack perfectly
        const jx = (Math.random() - .5) * 14;
        const jy = (Math.random() - .5) * 10;
        const tx = targetX - srcX + jx;
        const ty = targetY - srcY + jy;
        ghost.style.cssText =
          `left:${srcX - 19}px;top:${srcY - 27}px;` +
          `--tx:${tx}px;--ty:${ty}px;--rdir:${dirs[i] * (6 + i * 3)}deg`;
        document.body.appendChild(ghost);
        setTimeout(() => ghost.remove(), 600);
      }, i * 110);
    }

    // Update deck visual once last card lands
    setTimeout(updateDiscardDeck, 4 * 110 + 250);
  }

  function updateDiscardDeck() {
    const stack    = $('discardDeckStack');
    const countEl  = $('discardCount');
    if (!stack || !countEl) return;

    stack.innerHTML = '';
    const total = discardHistory.length;
    const show  = Math.min(total, 3);
    for (let i = 0; i < show; i++) {
      const card = document.createElement('div');
      card.className = 'discard-pile-card';
      card.style.animationDelay = `${i * 0.04}s`;
      stack.appendChild(card);
    }
    if (total > 0) {
      countEl.style.display = 'flex';
      countEl.textContent    = total;
      // re-trigger pop animation
      countEl.style.animation = 'none';
      void countEl.offsetWidth;
      countEl.style.animation = '';
    } else {
      countEl.style.display = 'none';
    }
    renderDiscardTooltip();
  }

  function renderDiscardTooltip() {
    const container = $('dtSets');
    if (!container) return;
    container.innerHTML = '';

    if (discardHistory.length === 0) {
      container.innerHTML = '<div class="dt-empty">No discards yet</div>';
      return;
    }

    // Newest discard first
    for (let hi = discardHistory.length - 1; hi >= 0; hi--) {
      const { playerName, num } = discardHistory[hi];
      const setDiv = document.createElement('div');
      setDiv.className = 'dt-set';

      const header = document.createElement('div');
      header.className = 'dt-set-header';
      header.textContent = `${playerName} — ${cardLabel(num)}s`;
      setDiv.appendChild(header);

      const cardsDiv = document.createElement('div');
      cardsDiv.className = 'dt-cards';
      SUITS.forEach((suit, si) => {
        const c = document.createElement('div');
        c.className = `dt-card ${SUIT_COLORS[suit] || 'black'}`;
        c.style.animationDelay = `${si * 0.07}s`;
        c.innerHTML =
          `<span>${cardLabel(num)}</span>` +
          `<span class="dt-suit">${suit}</span>`;
        cardsDiv.appendChild(c);
      });
      setDiv.appendChild(cardsDiv);
      container.appendChild(setDiv);
    }
  }

  // ── Ghost card fly animation (played cards) ───────────────────
  function animateCardFly(count) {
    const pileEl = document.querySelector('.pile-area');
    if (!pileEl) return;
    const pileRect = pileEl.getBoundingClientRect();
    const handRect = handCards.getBoundingClientRect();
    const n = Math.min(count, 3);
    for (let i = 0; i < n; i++) {
      const ghost = document.createElement('div');
      ghost.className = 'card-ghost';
      const sx = handRect.left + handRect.width / 2 + (i - (n - 1) / 2) * 16;
      const sy = handRect.top;
      const tx = pileRect.left + pileRect.width / 2 - sx;
      const ty = pileRect.top  + pileRect.height / 2 - sy;
      ghost.style.cssText = `left:${sx}px;top:${sy}px;--tx:${tx}px;--ty:${ty}px;animation-delay:${i * 0.06}s`;
      document.body.appendChild(ghost);
      setTimeout(() => ghost.remove(), 700 + i * 60);
    }
  }

  // ── Game over ─────────────────────────────────────────────────
  function showGameOver(ranks) {
    goRankings.innerHTML = '';
    let winnerIsMe = false;
    for (const r of ranks) {
      const row = document.createElement('div');
      row.className = 'rank-row';
      row.innerHTML = `<span class="rank-pos">#${r.rank}</span><span>${escapeHtml(r.name)}${r.id === myId ? ' (You)' : ''}</span>`;
      goRankings.appendChild(row);
      if (r.rank === 1 && r.id === myId) winnerIsMe = true;
    }
    goTitle.textContent = winnerIsMe ? '🏆 YOU WIN!' : '🏆 GAME OVER';
    gameOverOverlay.classList.add('show');
    if (winnerIsMe) {
      fireConfetti();
      if (typeof reportScore === 'function') reportScore('bluffrummy', 1);
    }
  }

  btnPlayAgain.addEventListener('click', () => {
    gameOverOverlay.classList.remove('show');
    wsSend({ type: 'br-start' });
  });

  // ── Actions ───────────────────────────────────────────────────
  btnStart.addEventListener('click', () => {
    wsSend({ type: 'br-start' });
  });

  btnPlay.addEventListener('click', () => {
    if (!myTurn || selectedIndices.size === 0 || selectedIndices.size > 3) return;
    const cards = [...selectedIndices].sort((a, b) => a - b).map(i => ({ num: hand[i].num, suit: hand[i].suit }));
    const num = parseInt(announceNum.value);
    wsSend({ type: 'br-play', cards, announceNum: num });
    selectedIndices.clear();
  });

  btnChallenge.addEventListener('click', () => {
    if (!myTurn || !canChallenge) return;
    wsSend({ type: 'br-challenge' });
  });

  // ── Chat ──────────────────────────────────────────────────────
  function appendChat(name, text, cls) {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + cls;
    div.innerHTML = `<span class="cm-name">${escapeHtml(name)}</span>${escapeHtml(text)}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
    while (chatMessages.children.length > 100) chatMessages.removeChild(chatMessages.firstChild);
  }

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    wsSend({ type: 'chat', text });
    appendChat(myName, text, 'me');
    chatInput.value = '';
  }

  chatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') sendChat();
  });

  // ── Navigation ────────────────────────────────────────────────
  btnBack.addEventListener('click', () => {
    location.href = '/';
  });

  // ── Confetti ──────────────────────────────────────────────────
  function fireConfetti() {
    const canvas = $('confetti');
    const ctx = canvas.getContext('2d');
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    const particles = [];
    const colors = ['#fbbf24', '#8b5cf6', '#06b6d4', '#22c55e', '#ef4444', '#f472b6'];
    for (let i = 0; i < 150; i++) {
      particles.push({
        x: Math.random() * canvas.width,
        y: Math.random() * canvas.height - canvas.height,
        w: Math.random() * 8 + 4,
        h: Math.random() * 6 + 3,
        color: colors[Math.floor(Math.random() * colors.length)],
        vx: (Math.random() - 0.5) * 4,
        vy: Math.random() * 3 + 2,
        rot: Math.random() * 360,
        vr: (Math.random() - 0.5) * 10,
      });
    }
    let frame = 0;
    function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      let alive = false;
      for (const p of particles) {
        p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.vy += 0.05;
        if (p.y < canvas.height + 20) alive = true;
        ctx.save();
        ctx.translate(p.x, p.y);
        ctx.rotate(p.rot * Math.PI / 180);
        ctx.fillStyle = p.color;
        ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
        ctx.restore();
      }
      frame++;
      if (alive && frame < 300) requestAnimationFrame(draw);
      else ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
    draw();
  }

  // ── Connect ───────────────────────────────────────────────────
  connect();
})();

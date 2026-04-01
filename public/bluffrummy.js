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
  const btnRevealClose = $('btnRevealClose');
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
  let players = new Map(); // id -> {name, cardCount, eliminated, rank}
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
      addLog(`<span class="log-name">${escapeHtml(msg.name)}</span> joined the room`);
    },

    'player-left'(msg) {
      const p = players.get(msg.id);
      addLog(`<span class="log-name">${escapeHtml(p?.name || 'Player')}</span> left`);
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
      rankings = msg.rankings || [];

      // Update players map
      players.clear();
      for (const p of msg.players) {
        players.set(p.id, { name: p.name, cardCount: p.cardCount, eliminated: p.eliminated, rank: p.rank });
      }

      renderPlayers();
      renderHand();
      renderPile(msg.meldSize || 0, msg.meldNum);
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
      renderHand(true);
      addLog('Cards dealt! Game started.');
    },

    'br-auto-discard'(msg) {
      const p = players.get(msg.playerId);
      addLog(`<span class="log-name">${escapeHtml(p?.name || 'Player')}</span> auto-discarded 4× ${cardLabel(msg.num)}`);
    },

    'br-turn'(msg) {
      myTurn = msg.currentTurn === myId;
      canChallenge = msg.canChallenge && myTurn;
      currentMeldNum = msg.meldNum;
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
      addLog(`<span class="log-name">${escapeHtml(msg.challengerName)}</span> challenges <span class="log-name">${escapeHtml(msg.targetName)}</span>!`, 'log-challenge');
    },

    'br-reveal'(msg) {
      // Show reveal overlay
      showRevealOverlay(msg);
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
      addLog(`🏆 ${label} finished in place #${msg.rank}!`, 'log-win');
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
      pileLabel.textContent = 'New meld — ' + (msg.starterName || 'Someone') + ' starts';
      addLog(`New meld started by <span class="log-name">${escapeHtml(msg.starterName || '?')}</span>`);
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
        (gameActive && !p.eliminated && myTurn === false && false ? '' : '');

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
      pileLabel.textContent = `Meld: "${cardLabel(num)}s" — ${size} card(s)`;
    } else {
      pileLabel.textContent = 'No meld yet';
    }
    for (let i = 0; i < size; i++) {
      const el = document.createElement('div');
      el.className = 'pile-card face-down';
      el.style.animationDelay = `${i * 0.08}s`;
      pileCards.appendChild(el);
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
    if (currentMeldNum) {
      announceNum.value = String(currentMeldNum);
      announceNum.disabled = true;
    } else {
      announceNum.disabled = false;
    }
  }

  function addLog(html, cls) {
    const div = document.createElement('div');
    div.className = 'log-entry' + (cls ? ' ' + cls : '');
    div.innerHTML = html;
    actionLog.appendChild(div);
    actionLog.scrollTop = actionLog.scrollHeight;
    // Keep max 30 entries
    while (actionLog.children.length > 30) actionLog.removeChild(actionLog.firstChild);
  }

  // ── Reveal overlay ────────────────────────────────────────────
  function showRevealOverlay(msg) {
    revealCardsEl.innerHTML = '';
    const annNum = msg.announcedNum;

    for (let i = 0; i < msg.cards.length; i++) {
      const c = msg.cards[i];
      const honest = c.num === annNum;
      const colorClass = SUIT_COLORS[c.suit] || 'black';
      const el = document.createElement('div');
      el.className = `reveal-card ${colorClass} ${honest ? 'honest' : 'bluff'}`;
      el.style.animationDelay = `${i * 0.15}s`;
      el.innerHTML = `<span class="rv-num">${cardLabel(c.num)}</span><span class="rv-suit">${c.suit}</span>`;
      revealCardsEl.appendChild(el);
    }

    const wasBluff = msg.wasBluff;
    const challengerName = escapeHtml(msg.challengerName);
    const targetName = escapeHtml(msg.targetName);
    const takerName = escapeHtml(msg.takerName);

    if (wasBluff) {
      revealTitle.textContent = 'CAUGHT BLUFFING!';
      revealResult.innerHTML = `<span style="color:var(--green)">${challengerName}</span> was right! <br><span style="color:var(--red)">${targetName}</span> takes ${msg.cards.length} cards.`;
    } else {
      revealTitle.textContent = 'BAD CALL!';
      revealResult.innerHTML = `<span style="color:var(--red)">${challengerName}</span> was wrong! <br>${targetName} was honest. <span style="color:var(--red)">${challengerName}</span> takes ${msg.cards.length} cards.`;
    }

    revealOverlay.classList.add('show');
  }

  btnRevealClose.addEventListener('click', () => {
    revealOverlay.classList.remove('show');
  });

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
    if (winnerIsMe) fireConfetti();
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

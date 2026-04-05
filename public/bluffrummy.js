(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const btnBack      = $('btnBack');
  const btnStart     = $('btnStartGame');
  const status       = $('status');
  const roomBadge    = $('roomBadge');
  const playerSeats  = $('playerSeats');
  const handCards    = $('handCards');
  const handCount    = $('handCount');
  const pileCards    = $('pileCards');
  const pileLabel    = $('pileLabel');
  const playArea     = $('playArea');
  const btnPlay      = $('btnPlayCards');
  const btnChallenge = $('btnChallenge');
  const actionLog    = $('actionLog');
  const revealOverlay   = $('revealOverlay');
  const revealTitle     = $('revealTitle');
  const revealCardsEl   = $('revealCards');
  const revealResult    = $('revealResult');
  const challengeFlashEl = $('challengeFlash');
  const gameOverOverlay  = $('gameOverOverlay');
  const goTitle      = $('goTitle');
  const goRankings   = $('goRankings');
  const btnPlayAgain = $('btnPlayAgain');
  const chatMessages = $('chatMessages');
  const chatInput    = $('chatInput');
  const chatSend     = $('chatSend');
  const tableEl      = $('table');
  const tableCenter  = $('tableCenter');

  // Modal
  const playModal    = $('playModal');
  const modalCards   = $('modalCards');
  const announceGrid = $('announceGrid');
  const modalCancel  = $('modalCancel');
  const modalConfirm = $('modalConfirm');

  // Chat
  const chatPanel    = $('chatPanel');
  const chatBackdrop = $('chatBackdrop');
  const btnChat      = $('btnToggleChat');
  const chatClose    = $('chatClose');

  // ── State ─────────────────────────────────────────────────
  let ws, myId, myName;
  let hand = [];
  let selectedIndices = new Set();
  let gameActive = false;
  let myTurn = false;
  let canChallenge = false;
  let currentMeldNum = null;
  let currentTurnId = null;
  let players = new Map();
  let discardHistory = [];
  let rankings = [];
  let modalAnnounceNum = null;

  const SUITS = ['♠', '♥', '♦', '♣'];
  const SUIT_COLORS = { '♠': 'black', '♥': 'red', '♦': 'red', '♣': 'black' };

  // ── Helpers ───────────────────────────────────────────────
  function escapeHtml(s) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  function cardLabel(num) {
    if (num === 1)  return 'A';
    if (num === 11) return 'J';
    if (num === 12) return 'Q';
    if (num === 13) return 'K';
    return String(num);
  }

  function getInitials(name) {
    return name.split(/\s+/).map(w => w[0]).join('').toUpperCase().slice(0, 2) || '?';
  }

  const SEAT_COLORS = ['#8b5cf6', '#06b6d4', '#f472b6', '#e8a838', '#22c55e', '#ef4444', '#a78bfa', '#34d399'];

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

  // ── Message handlers ──────────────────────────────────────
  const handlers = {
    'room-joined'(msg) {
      roomBadge.textContent = msg.roomName + ' #' + msg.roomId;
      status.textContent = 'Waiting for players…';
    },

    'error'(msg) {
      status.textContent = msg.msg;
    },

    'player-joined'(msg) {
      addLog(`<span class="feed-name">${escapeHtml(msg.name)}</span> joined`, 'info');
    },

    'player-left'(msg) {
      const p = players.get(msg.id);
      addLog(`<span class="feed-name">${escapeHtml(p?.name || 'Player')}</span> left`, 'info');
    },

    'br-state'(msg) {
      myId = msg.yourId;
      hand = msg.hand || [];
      gameActive = msg.active;
      myTurn = msg.currentTurn === myId;
      canChallenge = msg.canChallenge;
      currentMeldNum = msg.meldNum;
      currentTurnId = msg.currentTurn || null;
      rankings = msg.rankings || [];

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
        status.textContent = 'Waiting for game to start…';
        btnStart.style.display = '';
        playArea.style.display = 'none';
      } else if (gameActive) {
        btnStart.style.display = 'none';
        playArea.style.display = '';
      }
    },

    'br-dealt'(msg) {
      hand = msg.hand;
      gameActive = true;
      btnStart.style.display = 'none';
      discardHistory = msg.discards || [];
      updateDiscardDeck();
      clearLastPlayed();
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
      canChallenge = msg.canChallenge;
      currentMeldNum = msg.meldNum;
      currentTurnId = msg.currentTurn;
      const turnPlayer = players.get(msg.currentTurn);
      if (myTurn) {
        status.textContent = canChallenge ? 'Your turn — play or challenge!' : 'Your turn!';
      } else {
        status.textContent = `${escapeHtml(turnPlayer?.name || 'Opponent')}'s turn…`;
      }
      updateControls();
      renderPlayers();
    },

    'br-play'(msg) {
      const p = players.get(msg.playerId);
      if (p) p.cardCount = msg.cardCount;
      addLog(`<span class="feed-name">${escapeHtml(p?.name || '?')}</span> played ${msg.count} card${msg.count !== 1 ? 's' : ''} as <strong>"${cardLabel(msg.announcedNum)}s"</strong>`, 'play');

      // Animate cards flying from the player's seat (or hand tray) to center
      animatePlayFromSeat(msg.playerId, msg.count);

      renderPile(msg.meldSize, msg.meldNum);
      renderPlayers();
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
      addLog(`<span class="feed-name">${label}</span> finished #${msg.rank}!`, 'win');
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
      addLog(`New meld started by <span class="feed-name">${escapeHtml(msg.starterName || '?')}</span>`, 'meld');
      clearLastPlayed();
      flashPileArea();
    },

    'chat'(msg) {
      appendChat(msg.name, msg.text, 'other');
    },

    'br-player-disconnect'(msg) {
      const overlay = $('disconnectVoteOverlay');
      if (!overlay) return;
      $('dvTitle').textContent = `\u26a1 ${escapeHtml(msg.name)} Disconnected`;
      $('dvSubtitle').textContent = 'Vote: redistribute their cards or wait for reconnect?';
      $('dvVoteCounts').innerHTML = '';
      overlay.classList.add('show');
      // Timer fill animation
      const fill = $('dvTimerFill');
      if (fill) {
        fill.style.transition = 'none';
        fill.style.width = '100%';
        requestAnimationFrame(() => {
          fill.style.transition = `width ${msg.timeout || 30}s linear`;
          fill.style.width = '0%';
        });
      }
    },

    'br-vote-update'(msg) {
      const vc = $('dvVoteCounts');
      if (!vc) return;
      vc.innerHTML =
        `<span class="dv-vote">\u267b\ufe0f Redistribute: ${msg.redistribute}</span>` +
        `<span class="dv-vote">\u23f3 Wait: ${msg.wait}</span>`;
    },

    'br-vote-result'(msg) {
      $('disconnectVoteOverlay')?.classList.remove('show');
      if (msg.result === 'redistribute') {
        addLog(`Cards redistributed after disconnect`, 'info');
      } else {
        addLog(`Waiting for disconnected player to return`, 'info');
      }
    },

    'br-reconnected'(msg) {
      $('disconnectVoteOverlay')?.classList.remove('show');
      addLog(`<span class="feed-name">${escapeHtml(msg.name)}</span> reconnected!`, 'info');
    },
  };

  // ── Player rendering (seats around table) ─────────────────
  function renderPlayers() {
    playerSeats.innerHTML = '';
    const ids = [...players.keys()];
    const total = ids.length;
    if (total === 0) return;

    const myIdx = ids.indexOf(myId);
    if (myIdx === -1) return;

    // Ellipse parameters (% of table dimensions)
    const cx = 50, cy = 46;
    const rx = 40, ry = 36;

    ids.forEach((pid, i) => {
      if (pid === myId) return; // self is the hand tray

      const p = players.get(pid);
      // Calculate angle: my seat is at bottom (270°), others distributed clockwise
      const offset = ((i - myIdx + total) % total);
      const angle = (Math.PI * 1.5) + (offset / total) * 2 * Math.PI;
      const x = cx + rx * Math.cos(angle);
      const y = cy + ry * Math.sin(angle);

      const seat = document.createElement('div');
      seat.className = 'seat' +
        (pid === currentTurnId && gameActive && !p.eliminated ? ' active' : '') +
        (p.eliminated ? ' eliminated' : '');
      seat.style.left = x + '%';
      seat.style.top = y + '%';
      seat.dataset.pid = pid;

      const ci = ids.indexOf(pid) % SEAT_COLORS.length;
      const color = SEAT_COLORS[ci];
      const initials = getInitials(p.name);
      const cardCount = p.eliminated ? 0 : (p.cardCount || 0);
      const showCards = Math.min(cardCount, 8);

      // Build mini card fan
      let miniCardsHtml = '';
      for (let c = 0; c < showCards; c++) {
        const spread = showCards > 1 ? (c / (showCards - 1) - 0.5) : 0;
        const rot = spread * 30;
        const tx = spread * (showCards * 2.5);
        miniCardsHtml += `<div class="mini-card" style="transform:translate(calc(-50% + ${tx}px), 0) rotate(${rot}deg);"></div>`;
      }

      const badge = p.eliminated ? (p.rank === 1 ? '🏆' : `#${p.rank}`) : '';

      seat.innerHTML =
        `<div class="seat-name">${escapeHtml(p.name)}${pid === currentTurnId && gameActive && !p.eliminated ? '<span class="pc-turn-arrow">▶</span>' : ''}</div>` +
        `<div class="seat-avatar" style="background:${color}">${initials}</div>` +
        `<div class="seat-hand">${miniCardsHtml}${cardCount > 8 ? `<span class="seat-count">${cardCount}</span>` : ''}</div>` +
        (badge ? `<div class="seat-badge">${badge}</div>` : '');

      playerSeats.appendChild(seat);
    });
  }

  // ── Hand rendering (overlapping fan) ──────────────────────
  function renderHand(animate) {
    handCards.innerHTML = '';
    selectedIndices.clear();
    handCount.textContent = hand.length;

    // Sort by number then suit
    const sorted = hand.map((c, i) => ({ ...c, origIdx: i }));
    sorted.sort((a, b) => a.num - b.num || SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit));
    hand = sorted.map(c => ({ num: c.num, suit: c.suit }));

    const total = hand.length;
    const maxSpread = Math.min(total * 2.5, 35); // max fan angle

    hand.forEach((card, i) => {
      const el = document.createElement('div');
      const colorClass = SUIT_COLORS[card.suit] || 'black';

      // Fan geometry
      const t = total > 1 ? (i / (total - 1)) - 0.5 : 0;
      const angle = t * maxSpread;
      const yOffset = Math.abs(t) * 18; // arc: edges lower
      const overlap = Math.min(22, Math.max(8, 600 / total));

      el.className = `game-card ${colorClass}` + (animate ? ' dealt' : '');
      el.style.transform = `rotate(${angle}deg) translateY(${yOffset}px)`;
      el.style.setProperty('--rest-transform', `rotate(${angle}deg) translateY(${yOffset}px)`);
      el.style.marginLeft = i === 0 ? '0' : `-${overlap}px`;
      el.style.zIndex = i;
      if (animate) el.style.animationDelay = `${i * 0.04}s`;

      el.innerHTML =
        `<span class="card-corner">${cardLabel(card.num)}<br>${card.suit}</span>` +
        `<span class="card-num">${cardLabel(card.num)}</span>` +
        `<span class="card-suit">${card.suit}</span>`;

      el.addEventListener('click', () => {
        if (!myTurn || !gameActive) return;
        if (selectedIndices.has(i)) {
          selectedIndices.delete(i);
          el.classList.remove('selected');
          el.style.transform = `rotate(${angle}deg) translateY(${yOffset}px)`;
        } else {
          if (selectedIndices.size >= 3) return;
          selectedIndices.add(i);
          el.classList.add('selected');
          el.style.transform = `rotate(${angle}deg) translateY(${yOffset - 20}px)`;
        }
      });

      handCards.appendChild(el);
    });
  }

  // ── Pile rendering ────────────────────────────────────────
  function renderPile(size, num) {
    pileCards.innerHTML = '';
    if (num) {
      const suits = ['♠','♥','♦','♣'];
      const lbl = cardLabel(num);
      pileLabel.innerHTML = suits.map(s => {
        const cls = (s === '♥' || s === '♦') ? 'pile-suit-tag red' : 'pile-suit-tag black';
        return `<span class="${cls}">${lbl}${s}</span>`;
      }).join(' ');
    } else {
      pileLabel.textContent = 'No meld yet';
    }

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

  // ── Controls ──────────────────────────────────────────────
  function updateControls() {
    if (!gameActive) {
      playArea.style.display = 'none';
      return;
    }
    playArea.style.display = '';
    btnPlay.disabled = !myTurn;
    btnChallenge.style.display = canChallenge ? '' : 'none';
    btnChallenge.disabled = !canChallenge;
  }

  // ── Game feed ─────────────────────────────────────────────
  const FEED_ICONS = { play: '🃏', challenge: '🤥', bluff: '😤', honest: '✅', win: '🏆', meld: '🔀', discard: '♻️', info: 'ℹ️' };

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
    actionLog.appendChild(div);
    actionLog.scrollTop = actionLog.scrollHeight;
    while (actionLog.children.length > 40) actionLog.removeChild(actionLog.firstChild);
  }

  // ── Play modal ────────────────────────────────────────────
  function openPlayModal() {
    if (selectedIndices.size === 0 || selectedIndices.size > 3) return;

    // If meld is active, skip modal — play immediately with the locked number
    if (currentMeldNum) {
      const cards = [...selectedIndices].sort((a, b) => a - b).map(i => ({ num: hand[i].num, suit: hand[i].suit }));
      showLastPlayed(cards, currentMeldNum);
      wsSend({ type: 'br-play', cards, announceNum: currentMeldNum });
      selectedIndices.clear();
      return;
    }

    const selectedCards = [...selectedIndices].sort((a, b) => a - b).map(i => hand[i]);
    modalAnnounceNum = null;

    // Render selected cards in modal
    modalCards.innerHTML = '';
    selectedCards.forEach(card => {
      const el = document.createElement('div');
      const colorClass = SUIT_COLORS[card.suit] || 'black';
      el.className = `modal-card ${colorClass}`;
      el.innerHTML = `<span class="mc-num">${cardLabel(card.num)}</span><span class="mc-suit">${card.suit}</span>`;
      modalCards.appendChild(el);
    });

    // Build announce grid
    const discardedNums = new Set(discardHistory.map(d => d.num));
    announceGrid.innerHTML = '';
    for (let n = 1; n <= 13; n++) {
      const chip = document.createElement('button');
      chip.className = 'announce-chip';
      chip.textContent = cardLabel(n);
      chip.dataset.num = n;

      if (discardedNums.has(n)) {
        chip.classList.add('disabled');
      } else if (currentMeldNum) {
        if (n === currentMeldNum) {
          chip.classList.add('locked');
          modalAnnounceNum = n;
        } else {
          chip.classList.add('disabled');
        }
      } else {
        chip.addEventListener('click', () => {
          announceGrid.querySelectorAll('.announce-chip').forEach(c => c.classList.remove('active'));
          chip.classList.add('active');
          modalAnnounceNum = n;
          modalConfirm.disabled = false;
        });
        // Auto-select first available if nothing selected
        if (modalAnnounceNum === null) {
          modalAnnounceNum = n;
          chip.classList.add('active');
        }
      }

      announceGrid.appendChild(chip);
    }

    modalConfirm.disabled = !modalAnnounceNum;
    playModal.classList.add('show');
  }

  function closePlayModal() {
    playModal.classList.remove('show');
    modalAnnounceNum = null;
  }

  function confirmPlay() {
    if (!modalAnnounceNum) return;
    const cards = [...selectedIndices].sort((a, b) => a - b).map(i => ({ num: hand[i].num, suit: hand[i].suit }));
    showLastPlayed(cards, modalAnnounceNum);
    wsSend({ type: 'br-play', cards, announceNum: modalAnnounceNum });
    selectedIndices.clear();
    closePlayModal();
  }

  btnPlay.addEventListener('click', openPlayModal);
  modalCancel.addEventListener('click', closePlayModal);
  modalConfirm.addEventListener('click', confirmPlay);

  // Close modal on backdrop click
  playModal.addEventListener('click', (e) => {
    if (e.target === playModal) closePlayModal();
  });

  // ── Reveal banner ─────────────────────────────────────────
  let _revealTimer = null;
  function showRevealOverlay(msg) {
    revealCardsEl.innerHTML = '';
    const annNum = msg.announcedNum;

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

    if (msg.wasBluff) {
      revealTitle.className = 'reveal-title bluff';
      revealTitle.textContent = 'BLUFF CAUGHT!';
      revealResult.innerHTML = `<span style="color:var(--green)">${challengerName}</span> was right!<br><span style="color:var(--red)">${targetName}</span> takes ${msg.totalCards || msg.cards.length} card${(msg.totalCards || msg.cards.length) !== 1 ? 's' : ''}!`;
    } else {
      revealTitle.className = 'reveal-title honest';
      revealTitle.textContent = 'HONEST PLAY!';
      revealResult.innerHTML = `<span style="color:var(--green)">${targetName}</span> was telling the truth!<br><span style="color:var(--red)">${challengerName}</span> takes ${msg.totalCards || msg.cards.length} card${(msg.totalCards || msg.cards.length) !== 1 ? 's' : ''}!`;
    }

    const banner = revealOverlay;
    const bar = $('revealCountdownBar');
    banner.classList.add('show');
    bar.style.transition = 'none';
    bar.style.width = '100%';
    requestAnimationFrame(() => requestAnimationFrame(() => {
      bar.style.transition = 'width 4500ms linear';
      bar.style.width = '0%';
    }));
    clearTimeout(_revealTimer);
    _revealTimer = setTimeout(() => banner.classList.remove('show'), 4500);
  }

  // ── Challenge flash ───────────────────────────────────────
  function triggerChallengeSequence() {
    challengeFlashEl.classList.remove('active');
    void challengeFlashEl.offsetWidth;
    challengeFlashEl.classList.add('active');
    setTimeout(() => challengeFlashEl.classList.remove('active'), 700);
  }

  // ── Pile flash ────────────────────────────────────────────
  function flashPileArea() {
    tableCenter.classList.remove('meld-flash');
    void tableCenter.offsetWidth;
    tableCenter.classList.add('meld-flash');
    setTimeout(() => tableCenter.classList.remove('meld-flash'), 600);
  }

  // ── Last played ───────────────────────────────────────────
  function showLastPlayed(cards, announcedNum) {
    const bar    = $('lastPlayedBar');
    const lpCrds = $('lpCards');
    const lpAnn  = $('lpAnnounced');
    if (!bar) return;
    lpCrds.innerHTML = '';
    for (const card of cards) {
      const el = document.createElement('div');
      el.className = `lp-card ${SUIT_COLORS[card.suit] || 'black'}`;
      el.innerHTML = `<span class="lp-num">${cardLabel(card.num)}</span><span class="lp-suit">${card.suit}</span>`;
      lpCrds.appendChild(el);
    }
    lpAnn.textContent = `${cardLabel(announcedNum)}s`;
    bar.style.display = 'flex';
  }
  function clearLastPlayed() {
    const bar = $('lastPlayedBar');
    if (bar) bar.style.display = 'none';
  }

  // ── Animations: play from seat to center ──────────────────
  function animatePlayFromSeat(playerId, count) {
    const centerRect = tableCenter.getBoundingClientRect();
    const targetX = centerRect.left + centerRect.width / 2;
    const targetY = centerRect.top + centerRect.height / 2;

    let srcX, srcY;

    if (playerId === myId) {
      // From hand tray
      const handRect = handCards.getBoundingClientRect();
      srcX = handRect.left + handRect.width / 2;
      srcY = handRect.top;
    } else {
      // From player seat
      const seatEl = playerSeats.querySelector(`[data-pid="${playerId}"]`);
      if (seatEl) {
        const seatRect = seatEl.getBoundingClientRect();
        srcX = seatRect.left + seatRect.width / 2;
        srcY = seatRect.top + seatRect.height / 2;
      } else {
        return;
      }
    }

    const n = Math.min(count, 3);
    for (let i = 0; i < n; i++) {
      const ghost = document.createElement('div');
      ghost.className = 'card-ghost';
      const tx = targetX - srcX;
      const ty = targetY - srcY;
      ghost.style.cssText = `left:${srcX - 21}px;top:${srcY - 30}px;--tx:${tx}px;--ty:${ty}px;animation-delay:${i * 0.07}s`;
      document.body.appendChild(ghost);
      setTimeout(() => ghost.remove(), 600 + i * 70);
    }
  }

  // ── Discard animation ─────────────────────────────────────
  function animateDiscard(num) {
    const deckEl = $('discardDeck');
    const pileEl = document.querySelector('.table-center');
    if (!deckEl || !pileEl) return;

    const deckRect = deckEl.getBoundingClientRect();
    const pileRect = pileEl.getBoundingClientRect();
    const targetX = deckRect.left + deckRect.width / 2;
    const targetY = deckRect.top + deckRect.height / 2;
    const srcX = pileRect.left + pileRect.width / 2;
    const srcY = pileRect.top + pileRect.height / 2;

    const dirs = [-1, 1, -1, 1];
    for (let i = 0; i < 4; i++) {
      setTimeout(() => {
        const ghost = document.createElement('div');
        ghost.className = 'discard-ghost';
        const jx = (Math.random() - .5) * 12;
        const jy = (Math.random() - .5) * 8;
        const tx = targetX - srcX + jx;
        const ty = targetY - srcY + jy;
        ghost.style.cssText =
          `left:${srcX - 18}px;top:${srcY - 25}px;` +
          `--tx:${tx}px;--ty:${ty}px;--rdir:${dirs[i] * (5 + i * 3)}deg`;
        document.body.appendChild(ghost);
        setTimeout(() => ghost.remove(), 600);
      }, i * 100);
    }

    setTimeout(updateDiscardDeck, 4 * 100 + 250);
  }

  function updateDiscardDeck() {
    const stack   = $('discardDeckStack');
    const countEl = $('discardCount');
    if (!stack || !countEl) return;

    stack.innerHTML = '';
    const total = discardHistory.length;
    const show = Math.min(total, 3);
    for (let i = 0; i < show; i++) {
      const card = document.createElement('div');
      card.className = 'discard-pile-card';
      card.style.animationDelay = `${i * 0.04}s`;
      stack.appendChild(card);
    }
    if (total > 0) {
      countEl.style.display = 'flex';
      countEl.textContent = total;
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
      SUITS.forEach((suit) => {
        const c = document.createElement('div');
        c.className = `dt-card ${SUIT_COLORS[suit] || 'black'}`;
        c.innerHTML = `<span>${cardLabel(num)}</span><span class="dt-suit">${suit}</span>`;
        cardsDiv.appendChild(c);
      });
      setDiv.appendChild(cardsDiv);
      container.appendChild(setDiv);
    }
  }

  // ── Game over ─────────────────────────────────────────────
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
    goTitle.textContent = winnerIsMe ? 'YOU WIN!' : 'GAME OVER';
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

  // ── Actions ───────────────────────────────────────────────
  btnStart.addEventListener('click', () => {
    wsSend({ type: 'br-start' });
  });

  btnChallenge.addEventListener('click', () => {
    if (!canChallenge) return;
    wsSend({ type: 'br-challenge' });
  });

  $('btnVoteRedist')?.addEventListener('click', () => {
    wsSend({ type: 'br-vote', choice: 'redistribute' });
    $('disconnectVoteOverlay')?.classList.remove('show');
  });
  $('btnVoteWait')?.addEventListener('click', () => {
    wsSend({ type: 'br-vote', choice: 'wait' });
    $('disconnectVoteOverlay')?.classList.remove('show');
  });

  // ── Chat ──────────────────────────────────────────────────
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

  // Chat panel toggle
  function openChat() {
    chatPanel.classList.add('open');
    chatBackdrop.classList.add('show');
  }
  function closeChat() {
    chatPanel.classList.remove('open');
    chatBackdrop.classList.remove('show');
  }
  btnChat.addEventListener('click', openChat);
  chatClose.addEventListener('click', closeChat);
  chatBackdrop.addEventListener('click', closeChat);

  // ── Navigation ────────────────────────────────────────────
  btnBack.addEventListener('click', () => {
    location.href = '/';
  });

  // ── Confetti ──────────────────────────────────────────────
  function fireConfetti() {
    const canvas = $('confetti');
    const ctx = canvas.getContext('2d');
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    const particles = [];
    const colors = ['#8b5cf6', '#a78bfa', '#c4b5fd', '#06b6d4', '#22c55e', '#ef4444', '#f472b6'];
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

  // ── Connect ───────────────────────────────────────────────
  connect();
})();

(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const setupScreen    = $('setupScreen');
  const statusEl       = $('status');
  const gameFeed       = $('gameFeed');
  const tableArea      = $('tableArea');
  const tableMelds     = $('tableMelds');
  const pilesRow       = $('pilesRow');
  const drawPileEl     = $('drawPile');
  const discardPileEl  = $('discardPile');
  const discardTop     = $('discardTop');
  const drawCount      = $('drawCount');
  const actionBar      = $('actionBar');
  const handArea       = $('handArea');
  const handCards      = $('handCards');
  const handCount      = $('handCount');
  const playerList     = $('playerList');
  const sbRows         = $('sbRows');
  const roundBadge     = $('roundBadge');
  const btnBack        = $('btnBack');
  const btnStartGame   = $('btnStartGame');
  const btnDraw        = $('btnDraw');
  const btnPickDiscard = $('btnPickDiscard');
  const btnMeld        = $('btnMeld');
  const btnAddToMeld   = $('btnAddToMeld');
  const btnSwapJoker   = $('btnSwapJoker');
  const btnDiscard     = $('btnDiscard');
  const meldPointsEl   = $('meldPoints');
  const meldPtsVal     = $('meldPtsVal');
  const roundOverlay   = $('roundOverlay');
  const ovTitle        = $('ovTitle');
  const ovBody         = $('ovBody');
  const btnNextRound   = $('btnNextRound');
  const gameOverOverlay= $('gameOverOverlay');
  const goTitle        = $('goTitle');
  const goBody         = $('goBody');
  const btnNewGameOver = $('btnNewGameOver');
  const sidebar        = $('sidebar');
  const btnToggleSidebar = $('btnToggleSidebar');
  const roomBadge      = $('roomBadge');
  const errorToast     = $('errorToast');

  // ── Constants ─────────────────────────────────────────────────
  const SUIT_COLORS = { '♠':'black', '♥':'red', '♦':'red', '♣':'black' };
  const FEED_ICONS  = { play:'🃏', meld:'📤', info:'ℹ️', win:'🏆', ai:'🤖', error:'⚠️' };

  // ── Client state ──────────────────────────────────────────────
  let ws, myId, myName;
  let hand = [];
  let melds = [];
  let players = [];
  let currentTurnId = null;
  let myTurn = false;
  let hasDrawn = false;
  let myHasOpened = false;
  let turnOpenPts = 0;
  let discardTopCard = null;
  let deckCount = 0;
  let selectedIndices = new Set();
  let selectedMeldId  = -1;
  let gameActive = false;
  let lastSortedRound = 0;

  // ── Helpers ───────────────────────────────────────────────────
  function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function rankLabel(n) { return n===1?'A':n===11?'J':n===12?'Q':n===13?'K':String(n); }
  function colorClass(c) { return c.isJoker ? 'joker' : (SUIT_COLORS[c.suit] || 'black'); }
  function cardPts(c) { if (c.isJoker) return 0; if (c.num===1||c.num>=11) return 10; return c.num; }

  // Client-side validation (display only — server is authoritative)
  function validateMeldClient(cards) {
    if (cards.length < 3) return { valid:false, reason:'Need at least 3 cards' };
    const reals = cards.filter(c => !c.isJoker);
    const jokerCount = cards.length - reals.length;

    if (cards.length <= 4) {
      const rankSet  = new Set(reals.map(c => c.num));
      const suits    = reals.map(c => c.suit);
      const suitSet  = new Set(suits);
      if (rankSet.size <= 1 && suitSet.size === suits.length) {
        const rank  = reals.length > 0 ? reals[0].num : 1;
        const ptVal = (rank===1||rank>=11) ? 10 : rank;
        return { valid:true, type:'set', pts: cards.length * ptVal };
      }
      if (rankSet.size === 1 && suitSet.size < suits.length)
        return { valid:false, reason:'Sets need different suits for each card' };
    }

    const suitSetAll = new Set(reals.map(c => c.suit));
    if (suitSetAll.size <= 1) {
      const tryStart = (start) => {
        const needed = Array.from({length:cards.length}, (_,i) => start+i);
        if (needed[needed.length-1] > 14) return null;
        const used = new Set(); let jUsed = 0;
        for (const n of needed) {
          let found = false;
          for (let ri=0;ri<reals.length;ri++) {
            if (used.has(ri)) continue;
            if (reals[ri].num===n||(reals[ri].num===1&&n===14)) { used.add(ri); found=true; break; }
          }
          if (!found) jUsed++;
        }
        if (jUsed !== jokerCount) return null;
        let pts=0; const used2=new Set();
        for (const n of needed) {
          const an=n>13?1:n; let found=false;
          for (let ri=0;ri<reals.length;ri++) {
            if (used2.has(ri)) continue;
            if (reals[ri].num===n||(reals[ri].num===1&&n===14)) { used2.add(ri); pts+=cardPts(reals[ri]); found=true; break; }
          }
          if (!found) pts+=(an===1||an>=11)?10:an;
        }
        return pts;
      };
      for (let s=1;s<=14;s++) { const p=tryStart(s); if (p!==null) return {valid:true,type:'run',pts:p}; }
      return { valid:false, reason:'Cards are not consecutive (run needs same suit, in order)' };
    }
    const rankSet2 = new Set(reals.map(c => c.num));
    if (rankSet2.size===1) return { valid:false, reason:'Sets need different suits for each card' };
    return { valid:false, reason:'Cards must be same rank (set) or consecutive same suit (run)' };
  }

  // ── WebSocket ─────────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  if (!roomId) { location.href='/'; return; }

  function connect() {
    const proto = location.protocol==='https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      myName = sessionStorage.getItem('arena-name') || 'Player';
      const pw = sessionStorage.getItem('arena-room-password') || '';
      sessionStorage.removeItem('arena-room-password');
      ws.send(JSON.stringify({type:'join-room', roomId, name:myName, password:pw}));
    };
    ws.onmessage = e => { try { const m=JSON.parse(e.data); handlers[m.type]?.(m); } catch {} };
    ws.onclose  = () => { setStatus('Disconnected — reconnecting…'); setTimeout(()=>location.reload(), 2000); };
  }

  function wsSend(obj) { if (ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }

  // ── Handlers ─────────────────────────────────────────────────
  const handlers = {
    'room-joined'(msg) {
      myId = msg.myId;
      if (roomBadge) roomBadge.textContent = msg.roomName + ' #' + msg.roomId;
      setStatus('Waiting for players — host can start the game.');
      [statusEl, gameFeed].forEach(el => el.style.display='');
      btnStartGame.style.display = '';
    },
    'error'(msg) { setStatus(msg.msg); },
    'player-joined'(msg) { addLog('<strong>'+escapeHtml(msg.name)+'</strong> joined.', 'info'); },
    'player-left'(msg)   { addLog('A player left.', 'info'); },

    'rami-state'(msg) {
      myId         = myId || msg.myId;
      hand         = msg.hand || [];
      if (!msg.drawnThisTurn) {
        // Auto-sort at round start: by suit then rank, jokers last
        const suitOrder = {'\u2660':0,'\u2665':1,'\u2666':2,'\u2663':3};
        hand.sort((a, b) => {
          if (a.isJoker && b.isJoker) return 0;
          if (a.isJoker) return 1;
          if (b.isJoker) return -1;
          const sd = (suitOrder[a.suit]||0) - (suitOrder[b.suit]||0);
          return sd !== 0 ? sd : a.num - b.num;
        });
      }
      if (pileDragLive) {
        pileDrewReceived = true; // hand now contains the drawn card
      } else if (pilePendingDropIdx >= 0 && hand.length > 0) {
        applyPileDrop(pilePendingDropIdx); // user dropped before this state arrived
        pilePendingDropIdx = -1; pileDrewReceived = false;
      }
      melds        = msg.melds || [];
      players      = msg.players || [];
      currentTurnId= msg.turnId;
      myTurn       = msg.turnId === myId;
      hasDrawn     = myTurn ? (msg.drawnThisTurn || false) : false;
      myHasOpened  = msg.hasOpened || false;
      turnOpenPts  = msg.turnOpenPts || 0;
      discardTopCard = msg.discardTop;
      deckCount    = msg.deckCount || 0;
      gameActive   = msg.active !== false;
      if (roundBadge && msg.roundNum) roundBadge.textContent = 'Round ' + msg.roundNum;

      setupScreen.style.display = 'none';
      [statusEl, gameFeed, tableArea, pilesRow, actionBar, handArea].forEach(el => el.style.display='');
      btnStartGame.style.display = 'none';

      renderAll(false);
      updateButtons();

      if (myTurn && !hasDrawn) setStatus('Your turn — draw a card from deck or discard.');
      else if (myTurn)         setStatus('Meld, add to melds, swap, or discard to end your turn.');
      else {
        const tp = players.find(p => p.id === currentTurnId);
        setStatus((tp?.name || 'Opponent') + '\'s turn…');
      }
    },

    'rami-turn'(msg) {
      currentTurnId = msg.turnId;
      myTurn = msg.turnId === myId;
      hasDrawn = false;
      selectedIndices.clear();
      selectedMeldId = -1;
      if (myTurn) setStatus('Your turn — draw a card from deck or discard.');
      else setStatus(escapeHtml(msg.playerName) + '\'s turn' + (msg.isAI ? ' 🤖':'') + '…');
      renderPlayers();
      renderTable();
      updateButtons();
    },

    'rami-drew'(msg) {
      if (msg.card) hand.push(msg.card);
      hasDrawn = true;
      if (pileDragLive) {
        pileDrewReceived = true;
        // Upgrade draw-pile ghost from card-back to real card face
        if (pileDragSource === 'draw' && pileDragGhost && msg.card) {
          const cc = colorClass(msg.card);
          pileDragGhost.className = 'game-card drag-ghost ' + cc;
          if (msg.card.isJoker) {
            pileDragGhost.innerHTML = jokerImg(msg.card);
          } else {
            pileDragGhost.innerHTML = '<span class="card-corner">'+rankLabel(msg.card.num)+'<br>'+msg.card.suit+'</span>'+
              '<span class="card-num">'+rankLabel(msg.card.num)+'</span>'+
              '<span class="card-suit">'+msg.card.suit+'</span>';
          }
        }
        // Don't renderHand — user is still dragging
      } else if (pilePendingDropIdx >= 0) {
        // User released before server responded — apply now, keep pending for rami-state re-apply
        applyPileDrop(pilePendingDropIdx);
        pileDrewReceived = false;
        renderHand();
      } else {
        renderHand();
      }
      updateButtons();
      if (myTurn) setStatus('Meld, add to melds, swap, or discard to end your turn.');
    },

    'rami-log'(msg) { addLog(escapeHtml(msg.text), msg.cls||'info'); },
    'rami-error'(msg) { showErrorToast(msg.msg); },

    'rami-round-over'(msg) {
      gameActive = false;
      ovTitle.textContent = escapeHtml(msg.winnerName) + ' wins the round!';
      ovBody.innerHTML = '';
      for (const r of (msg.results||[])) {
        const row = document.createElement('div');
        row.className = 'ov-row' + (r.isWinner ? ' winner' : '');
        row.innerHTML = `<span class="ov-name">${escapeHtml(r.name)}</span>`+
          `<span class="ov-pts">${r.isWinner?'—':'+'+r.penalty}</span>`+
          `<span class="ov-total">Total: ${r.total}</span>`;
        ovBody.appendChild(row);
      }
      roundOverlay.classList.add('show');
      const me = msg.results?.find(r => r.id === myId);
      if (me?.isWinner) {
        fireConfetti();
        if (typeof reportScore==='function') reportScore('rami',1);
      }
    },

    'rami-game-over'(msg) {
      roundOverlay.classList.remove('show');
      const sorted = msg.rankings || [];
      const winner = sorted[0];
      goTitle.textContent = winner?.id===myId ? '🏆 YOU WIN!' : (winner?.name||'?')+' Wins!';
      goBody.innerHTML = '';
      sorted.forEach((p,i) => {
        const row = document.createElement('div');
        row.className = 'ov-row'+(i===0?' winner':'');
        row.innerHTML = `<span class="ov-name">${['🥇','🥈','🥉'][i]||'#'+(i+1)} ${escapeHtml(p.name)}</span>`+
          `<span class="ov-total">${p.score} pts</span>`;
        goBody.appendChild(row);
      });
      gameOverOverlay.classList.add('show');
      if (winner?.id===myId) fireConfetti();
    },

    'chat'(msg) { addLog('<strong>'+escapeHtml(msg.name)+':</strong> '+escapeHtml(msg.text),'info'); },
  };

  // ── Rendering ─────────────────────────────────────────────────
  // Keep client hand order in sync with server without clobbering user's sort/reorder
  function syncHand(serverHand) {
    if (serverHand.length === 0) { hand = []; return; }
    const serverSet = new Set(serverHand.map(c => c.cid));
    const serverMap = new Map(serverHand.map(c => [c.cid, c]));
    hand = hand.filter(c => serverSet.has(c.cid));           // remove melded/discarded
    for (const c of serverHand) {                            // append newly arrived cards
      if (!hand.some(h => h.cid === c.cid)) hand.push(c);
    }
    hand = hand.map(c => serverMap.get(c.cid) || c);         // refresh props (e.g. joker tags)
  }

  function jokerImg(card) {
    const f = card.jokerColor === 'red' ? 'red_joker.svg' : 'black_joker.svg';
    return `<img src="/assets/cards/${f}" alt="Joker" class="card-img">`;
  }

  function renderAll(animate) {
    if (!pileDragLive) renderHand(animate);
    renderTable();
    renderDiscard();
    renderDraw();
    renderPlayers();
    renderScoreboard();
    updateMeldPoints();
  }

  function renderHand(animate) {
    handCards.innerHTML = '';
    handCount.textContent = hand.length;
    selectedIndices = new Set([...selectedIndices].filter(i => i < hand.length));

    hand.forEach((card, i) => {
      const el = document.createElement('div');
      const cc = colorClass(card);
      el.className = 'game-card '+cc+(selectedIndices.has(i)?' selected':'')+(animate?' dealt':'');
      if (animate) el.style.animationDelay = `${i*0.04}s`;
      el.dataset.idx = String(i);

      if (card.isJoker) {
        el.innerHTML = jokerImg(card);
        el.classList.add('joker');
      } else {
        el.innerHTML = `<span class="card-corner">${rankLabel(card.num)}<br>${card.suit}</span>`+
          `<span class="card-num">${rankLabel(card.num)}</span><span class="card-suit">${card.suit}</span>`;
      }

      el.addEventListener('click', () => {
        if (!myTurn || !gameActive) return;
        if (selectedIndices.has(i)) { selectedIndices.delete(i); el.classList.remove('selected'); }
        else { selectedIndices.add(i); el.classList.add('selected'); }
        updateButtons();
        updateMeldPoints();
      });

      handCards.appendChild(el);
    });

    attachPointerDrag();
  }

  function renderTable() {
    tableMelds.innerHTML = '';
    if (melds.length===0) {
      tableMelds.innerHTML = '<div class="table-empty">No melds on the table yet</div>';
      return;
    }
    for (const meld of melds) {
      const group = document.createElement('div');
      group.className = 'meld-group'+(selectedMeldId===meld.id?' selected':'');
      const badge = document.createElement('span');
      badge.className = 'mg-idx';
      badge.textContent = melds.indexOf(meld)+1;
      group.appendChild(badge);
      for (const card of meld.cards) {
        const el = document.createElement('div');
        el.className = 'table-card '+colorClass(card);
        if (card.isJoker) {
          el.innerHTML = jokerImg(card);
          el.classList.add('joker');
        } else {
          el.innerHTML = `<span class="tc-num">${rankLabel(card.num)}</span><span class="tc-suit">${card.suit}</span>`;
        }
        group.appendChild(el);
      }
      group.addEventListener('click', () => {
        selectedMeldId = selectedMeldId===meld.id ? -1 : meld.id;
        renderTable();
        updateButtons();
      });
      tableMelds.appendChild(group);
    }
  }

  function renderDiscard() {
    if (!discardTopCard) {
      discardTop.className = 'discard-top';
      discardTop.innerHTML = '<span class="dt-empty-msg">Empty</span>';
      return;
    }
    const cc = colorClass(discardTopCard);
    discardTop.className = 'discard-top has-card ' + cc;
    if (discardTopCard.isJoker) {
      discardTop.innerHTML = jokerImg(discardTopCard);
    } else {
      discardTop.innerHTML = `<span class="dt-num">${rankLabel(discardTopCard.num)}</span><span class="dt-suit">${discardTopCard.suit}</span>`;
    }
  }

  function renderDraw() { drawCount.textContent = deckCount; }

  function renderPlayers() {
    playerList.innerHTML = '';
    const colors = ['#22c55e','#06b6d4','#f472b6','#fbbf24'];
    players.forEach((p, i) => {
      const div = document.createElement('div');
      div.className = 'player-card'+(p.id===myId?' me':'')+(p.id===currentTurnId&&gameActive?' active':'');
      div.innerHTML = `<span class="pc-dot" style="background:${colors[i%colors.length]}"></span>`+
        `<span class="pc-name">${escapeHtml(p.name)}${p.id===myId?' (You)':''}${p.isAI?' 🤖':''}</span>`+
        `<span class="pc-cards">🃏 ${p.cardCount}</span>`;
      playerList.appendChild(div);
    });
  }

  function renderScoreboard() {
    sbRows.innerHTML = '';
    players.forEach(p => {
      const row = document.createElement('div');
      row.className = 'sb-row'+(p.id===myId?' me':'');
      row.innerHTML = `<span class="sb-name">${escapeHtml(p.name)}</span><span class="sb-score">${p.score}</span>`;
      sbRows.appendChild(row);
    });
  }

  function updateMeldPoints() {
    if (selectedIndices.size >= 3) {
      const cards = [...selectedIndices].map(i => hand[i]);
      const result = validateMeldClient(cards);
      meldPointsEl.style.display = '';
      if (result.valid) {
        const total = myHasOpened ? result.pts : turnOpenPts + result.pts;
        meldPtsVal.style.color = '';
        meldPtsVal.textContent = myHasOpened
          ? result.pts + ' pts'
          : total + ' / 71 pts to open';
      } else {
        meldPtsVal.style.color = 'var(--red)';
        meldPtsVal.textContent = '✗ ' + result.reason;
      }
      return;
    }
    if (!myHasOpened && turnOpenPts > 0) {
      meldPointsEl.style.display = '';
      meldPtsVal.style.color = '';
      meldPtsVal.textContent = turnOpenPts + ' / 71 pts toward opening';
      return;
    }
    meldPtsVal.style.color = '';
    meldPointsEl.style.display = 'none';
  }

  function updateButtons() {
    const inDraw = myTurn && gameActive && !hasDrawn;
    const inPlay = myTurn && gameActive && hasDrawn;
    btnDraw.disabled        = !inDraw;
    btnPickDiscard.disabled = !(inDraw && !!discardTopCard);
    btnMeld.disabled        = !(inPlay && selectedIndices.size >= 3);
    btnAddToMeld.disabled   = !(inPlay && selectedIndices.size===1 && selectedMeldId>=0 && myHasOpened);
    btnSwapJoker.disabled   = !(inPlay && selectedIndices.size===1 && selectedMeldId>=0 && myHasOpened);
    btnDiscard.disabled     = !(inPlay && selectedIndices.size===1);
    btnStartGame.style.display = (gameActive ? 'none' : '');
  }

  function setStatus(t) { statusEl.textContent = t; }

  function addLog(html, type) {
    const cls = type||'info';
    const div = document.createElement('div');
    div.className = 'feed-entry feed-'+cls;
    const icon = document.createElement('span'); icon.className='feed-icon'; icon.textContent=FEED_ICONS[cls]||'ℹ️';
    const txt  = document.createElement('span'); txt.innerHTML = html;
    div.appendChild(icon); div.appendChild(txt);
    gameFeed.insertBefore(div, gameFeed.firstChild);
    while (gameFeed.children.length > 60) gameFeed.removeChild(gameFeed.lastChild);
  }

  let _errTimer = null;
  function showErrorToast(msg) {
    errorToast.textContent = msg;
    errorToast.classList.add('show');
    clearTimeout(_errTimer);
    _errTimer = setTimeout(() => errorToast.classList.remove('show'), 3500);
  }

  // ── Pointer drag & drop (card follows cursor, others shift) ───
  let dragIdx = -1, dropIdx = -1;
  let ghostEl = null;
  let ptrOffX = 0, ptrOffY = 0;
  let startX = 0, startY = 0;
  let dragLive = false;

  function attachPointerDrag() {
    const cards = handCards.querySelectorAll('.game-card');
    cards.forEach(card => card.addEventListener('pointerdown', onPtrDown, {passive:false}));
  }

  function onPtrDown(e) {
    if (e.button && e.button !== 0) return;
    const card = e.currentTarget;
    dragIdx = parseInt(card.dataset.idx);
    if (isNaN(dragIdx)) return;
    startX = e.clientX; startY = e.clientY;
    dragLive = false;
    const rect = card.getBoundingClientRect();
    ptrOffX = e.clientX - rect.left;
    ptrOffY = e.clientY - rect.top;
    document.addEventListener('pointermove', onPtrMove, {passive:false});
    document.addEventListener('pointerup',   onPtrUp);
    document.addEventListener('pointercancel', onPtrUp);
  }

  function onPtrMove(e) {
    e.preventDefault();
    const dx = e.clientX - startX, dy = e.clientY - startY;

    if (!dragLive && Math.hypot(dx,dy) < 8) return; // dead zone

    if (!dragLive) {
      dragLive = true;
      const srcCard = handCards.querySelector(`[data-idx="${dragIdx}"]`);
      if (!srcCard) return;
      const rect = srcCard.getBoundingClientRect();
      ghostEl = srcCard.cloneNode(true);
      ghostEl.classList.add('drag-ghost');
      ghostEl.classList.remove('selected');
      ghostEl.style.width  = rect.width  + 'px';
      ghostEl.style.height = rect.height + 'px';
      ghostEl.style.left   = (e.clientX - ptrOffX) + 'px';
      ghostEl.style.top    = (e.clientY - ptrOffY - 8) + 'px';
      document.body.appendChild(ghostEl);
      srcCard.classList.add('dragging');
    }

    if (!ghostEl) return;
    ghostEl.style.left = (e.clientX - ptrOffX) + 'px';
    ghostEl.style.top  = (e.clientY - ptrOffY - 8) + 'px';

    // Check if hovering over discard pile (to discard the card)
    if (myTurn && hasDrawn && gameActive) {
      const dr = discardPileEl.getBoundingClientRect();
      const overDiscard = e.clientX >= dr.left && e.clientX <= dr.right &&
                          e.clientY >= dr.top  && e.clientY <= dr.bottom;
      discardPileEl.classList.toggle('drop-target', overDiscard);
      if (overDiscard) {
        handCards.querySelectorAll('.game-card:not(.dragging)').forEach(c => {
          c.style.transform = ''; c.style.transition = '';
        });
        dropIdx = -2; // sentinel: discard pile
        return;
      }
    }
    discardPileEl.classList.remove('drop-target');
    const cards = [...handCards.querySelectorAll('.game-card:not(.dragging)')];
    let newDrop = hand.length;
    let nearCard = null;

    if (cards.length > 0) {
      let minDist = Infinity;
      for (const c of cards) {
        const r = c.getBoundingClientRect();
        const dist = Math.hypot(e.clientX - (r.left + r.width / 2), e.clientY - (r.top + r.height / 2));
        if (dist < minDist) { minDist = dist; nearCard = c; }
      }
      const nr = nearCard.getBoundingClientRect();
      const ni = parseInt(nearCard.dataset.idx);
      newDrop = e.clientX < nr.left + nr.width * 0.5 ? ni : ni + 1;
      newDrop = Math.max(0, Math.min(newDrop, hand.length));
    }

    if (newDrop !== dropIdx) {
      dropIdx = newDrop;
      // Only shift cards on the same visual row as the nearest card
      const baseY = nearCard ? nearCard.getBoundingClientRect().top : -999;
      cards.forEach(c => {
        const ci = parseInt(c.dataset.idx);
        const cr = c.getBoundingClientRect();
        const sameRow = Math.abs(cr.top - baseY) < 10;
        c.style.transition = 'transform 0.15s ease';
        c.style.transform  = (sameRow && ci >= newDrop) ? 'translateX(68px)' : '';
      });
    }
  }

  function onPtrUp() {
    document.removeEventListener('pointermove', onPtrMove);
    document.removeEventListener('pointerup',   onPtrUp);
    document.removeEventListener('pointercancel', onPtrUp);

    handCards.querySelectorAll('.game-card').forEach(c => {
      c.style.transform  = '';
      c.style.transition = '';
      c.classList.remove('dragging');
    });

    if (ghostEl) { ghostEl.remove(); ghostEl = null; }
    discardPileEl.classList.remove('drop-target');

    if (dragLive && dragIdx !== -1) {
      if (dropIdx === -2 && myTurn && hasDrawn && gameActive) {
        // Dropped on discard pile
        wsSend({type:'rami-discard', cardIdx: dragIdx});
        selectedIndices.clear();
      } else if (dropIdx !== -1 && dropIdx !== -2) {
        // Reorder within hand
        const effectiveTarget = dropIdx > dragIdx ? dropIdx - 1 : dropIdx;
        if (effectiveTarget !== dragIdx) {
          const card = hand.splice(dragIdx, 1)[0];
          hand.splice(Math.min(effectiveTarget, hand.length), 0, card);
          selectedIndices.clear();
          renderHand();
          updateButtons();
        }
      }
    }

    dragIdx = -1; dropIdx = -1; dragLive = false;
  }

  // ── Pile drag (draw/discard pile → hand) ──────────────────────
  let pileDragSource     = null;  // 'draw' | 'discard'
  let pileDragGhost      = null;
  let pileDragLive       = false;
  let pileDrewReceived   = false;
  let pileStartX = 0, pileStartY = 0;
  let pileDropIdx        = 0;
  let pilePendingDropIdx = -1;

  function applyPileDrop(targetIdx) {
    if (hand.length === 0) return;
    const last = hand.length - 1;
    const to   = Math.max(0, Math.min(targetIdx, last));
    if (last !== to) { const c = hand.splice(last, 1)[0]; hand.splice(to, 0, c); }
  }

  function onPilePointerDown(e, source) {
    if (e.button && e.button !== 0) return;
    if (!myTurn || hasDrawn || !gameActive) return;
    if (source === 'discard' && !discardTopCard) return;
    pileDragSource = source; pileDragGhost = null; pileDragLive = false;
    pileDrewReceived = false; pileDropIdx = hand.length;
    pileStartX = e.clientX; pileStartY = e.clientY;
    document.addEventListener('pointermove', onPilePtrMove, {passive:false});
    document.addEventListener('pointerup',   onPilePtrUp);
    document.addEventListener('pointercancel', onPilePtrUp);
  }

  function onPilePtrMove(e) {
    e.preventDefault();
    if (!pileDragLive) {
      if (Math.hypot(e.clientX - pileStartX, e.clientY - pileStartY) < 8) return;
      pileDragLive = true;
      wsSend(pileDragSource === 'draw' ? {type:'rami-draw'} : {type:'rami-pick-discard'});
      hasDrawn = true; updateButtons();
      (pileDragSource === 'discard' ? discardPileEl : drawPileEl).style.opacity = '0.35';
      // Build ghost card
      const ref = handCards.querySelector('.game-card');
      const rw  = ref ? ref.getBoundingClientRect().width  : 58;
      const rh  = ref ? ref.getBoundingClientRect().height : 84;
      pileDragGhost = document.createElement('div');
      if (pileDragSource === 'discard' && discardTopCard && discardTopCard.isJoker) {
        pileDragGhost.className = 'game-card drag-ghost joker';
        pileDragGhost.innerHTML = jokerImg(discardTopCard);
      } else if (pileDragSource === 'discard' && discardTopCard) {
        pileDragGhost.className = 'game-card drag-ghost ' + colorClass(discardTopCard);
        pileDragGhost.innerHTML = '<span class="card-corner">'+rankLabel(discardTopCard.num)+'<br>'+discardTopCard.suit+'</span>'+
          '<span class="card-num">'+rankLabel(discardTopCard.num)+'</span>'+
          '<span class="card-suit">'+discardTopCard.suit+'</span>';
      } else {
        // Draw pile: show card back until rami-drew arrives with the real card
        pileDragGhost.className = 'game-card drag-ghost black';
        pileDragGhost.style.background = 'linear-gradient(145deg,#1a1a2e,#0d0d22)';
        pileDragGhost.style.borderColor = 'rgba(139,92,246,.5)';
      }
      pileDragGhost.style.width  = rw + 'px';
      pileDragGhost.style.height = rh + 'px';
      document.body.appendChild(pileDragGhost);
    }
    if (!pileDragGhost) return;
    const gw = pileDragGhost.offsetWidth || 58, gh = pileDragGhost.offsetHeight || 84;
    pileDragGhost.style.left = (e.clientX - gw / 2) + 'px';
    pileDragGhost.style.top  = (e.clientY - gh / 2 - 8) + 'px';
    // Find nearest hand card and compute drop index
    const hcards = [...handCards.querySelectorAll('.game-card')];
    let nearCard = null;
    if (hcards.length > 0) {
      let minD = Infinity;
      for (const c of hcards) {
        const rr = c.getBoundingClientRect();
        const d  = Math.hypot(e.clientX - (rr.left + rr.width/2), e.clientY - (rr.top + rr.height/2));
        if (d < minD) { minD = d; nearCard = c; }
      }
      const nr = nearCard.getBoundingClientRect(), ni = parseInt(nearCard.dataset.idx);
      pileDropIdx = Math.max(0, Math.min(ni + (e.clientX < nr.left + nr.width*0.5 ? 0 : 1), hand.length));
    } else {
      pileDropIdx = 0;
    }
    const baseY = nearCard ? nearCard.getBoundingClientRect().top : -999;
    hcards.forEach(c => {
      const ci = parseInt(c.dataset.idx), cr = c.getBoundingClientRect();
      c.style.transition = 'transform 0.15s ease';
      c.style.transform  = (Math.abs(cr.top - baseY) < 10 && ci >= pileDropIdx) ? 'translateX(68px)' : '';
    });
  }

  function onPilePtrUp() {
    document.removeEventListener('pointermove', onPilePtrMove);
    document.removeEventListener('pointerup',   onPilePtrUp);
    document.removeEventListener('pointercancel', onPilePtrUp);
    discardPileEl.style.opacity = ''; drawPileEl.style.opacity = '';
    handCards.querySelectorAll('.game-card').forEach(c => { c.style.transform = ''; c.style.transition = ''; });
    if (pileDragGhost) { pileDragGhost.remove(); pileDragGhost = null; }
    if (!pileDragLive) { pileDragSource = null; return; } // was a tap, not a drag
    pileDragLive = false;
    if (pileDrewReceived) {
      // Card already in hand — reorder and render now
      applyPileDrop(pileDropIdx);
      renderHand();
      pileDrewReceived = false;
    } else {
      // Still waiting for server — defer to rami-drew / rami-state
      pilePendingDropIdx = pileDropIdx;
    }
    pileDragSource = null;
  }

  // ── Action buttons ────────────────────────────────────────────
  btnDraw.addEventListener('click', () => {
    if (!myTurn || hasDrawn || !gameActive) return;
    wsSend({type:'rami-draw'});
    hasDrawn = true; updateButtons();
  });

  btnPickDiscard.addEventListener('click', () => {
    if (!myTurn || hasDrawn || !gameActive || !discardTopCard) return;
    wsSend({type:'rami-pick-discard'});
    hasDrawn = true; updateButtons();
  });

  btnMeld.addEventListener('click', () => {
    if (!myTurn || !hasDrawn || !gameActive) return;
    const indices = [...selectedIndices].sort((a,b)=>a-b);
    if (indices.length < 3) return;
    const result = validateMeldClient(indices.map(i => hand[i]));
    if (!result.valid) { showErrorToast(result.reason); return; }
    const cids = indices.map(i => hand[i].cid);
    wsSend({type:'rami-meld', cids});
    selectedIndices.clear();
  });

  btnAddToMeld.addEventListener('click', () => {
    if (!myTurn || !hasDrawn || !gameActive || !myHasOpened || selectedMeldId < 0) return;
    if (selectedIndices.size !== 1) return;
    const cardCid = hand[[...selectedIndices][0]].cid;
    wsSend({type:'rami-add-to-meld', cardCid, meldId:selectedMeldId});
    selectedIndices.clear();
  });

  btnSwapJoker.addEventListener('click', () => {
    if (!myTurn || !hasDrawn || !gameActive || !myHasOpened || selectedMeldId < 0) return;
    if (selectedIndices.size !== 1) return;
    const cardCid = hand[[...selectedIndices][0]].cid;
    wsSend({type:'rami-swap-joker', cardCid, meldId:selectedMeldId});
    selectedIndices.clear();
  });

  btnDiscard.addEventListener('click', () => {
    if (!myTurn || !hasDrawn || !gameActive) return;
    if (selectedIndices.size !== 1) return;
    const cardCid = hand[[...selectedIndices][0]].cid;
    wsSend({type:'rami-discard', cardCid});
    selectedIndices.clear();
  });

  drawPileEl.addEventListener('click', () => {
    if (!myTurn || hasDrawn || !gameActive) return;
    wsSend({type:'rami-draw'});
    hasDrawn = true; updateButtons();
  });
  drawPileEl.addEventListener('pointerdown', e => onPilePointerDown(e, 'draw'));

  discardPileEl.addEventListener('click', () => {
    if (!myTurn || hasDrawn || !gameActive || !discardTopCard) return;
    wsSend({type:'rami-pick-discard'});
    hasDrawn = true; updateButtons();
  });
  discardPileEl.addEventListener('pointerdown', e => onPilePointerDown(e, 'discard'));

  btnStartGame.addEventListener('click', () => {
    const aiCount      = parseInt($('aiCountSel')?.value ?? 3);
    const loseThreshold= parseInt($('loseThreshSel')?.value ?? 200);
    wsSend({type:'rami-start', aiCount, loseThreshold});
    btnStartGame.style.display = 'none';
    setStatus('Starting…');
  });

  btnNextRound.addEventListener('click', () => {
    roundOverlay.classList.remove('show');
    wsSend({type:'rami-next-round'});
  });

  btnNewGameOver.addEventListener('click', () => {
    gameOverOverlay.classList.remove('show');
    gameActive = false;
    hand = []; melds = []; players = [];
    updateButtons();
    [tableArea, pilesRow, actionBar, handArea].forEach(el => el.style.display='none');
    setupScreen.style.display = '';
    btnStartGame.style.display = '';
    gameFeed.innerHTML = '';
  });

  btnBack.addEventListener('click', () => { location.href='/'; });
  if (btnToggleSidebar) btnToggleSidebar.addEventListener('click', () => sidebar.classList.toggle('open'));

  // ── Confetti ──────────────────────────────────────────────────
  function fireConfetti() {
    const canvas = $('confetti');
    const ctx = canvas.getContext('2d');
    canvas.width = innerWidth; canvas.height = innerHeight;
    const colors = ['#fbbf24','#8b5cf6','#06b6d4','#22c55e','#ef4444','#f472b6'];
    const particles = Array.from({length:150}, () => ({
      x:Math.random()*canvas.width, y:Math.random()*canvas.height-canvas.height,
      w:Math.random()*8+4, h:Math.random()*6+3,
      color:colors[Math.floor(Math.random()*colors.length)],
      vx:(Math.random()-.5)*4, vy:Math.random()*3+2,
      rot:Math.random()*360, vr:(Math.random()-.5)*10,
    }));
    let frame=0;
    (function draw() {
      ctx.clearRect(0,0,canvas.width,canvas.height);
      let alive=false;
      for (const p of particles) {
        p.x+=p.vx; p.y+=p.vy; p.rot+=p.vr; p.vy+=0.05;
        if (p.y<canvas.height+20) alive=true;
        ctx.save(); ctx.translate(p.x,p.y); ctx.rotate(p.rot*Math.PI/180);
        ctx.fillStyle=p.color; ctx.fillRect(-p.w/2,-p.h/2,p.w,p.h); ctx.restore();
      }
      if (alive && ++frame<300) requestAnimationFrame(draw);
      else ctx.clearRect(0,0,canvas.width,canvas.height);
    })();
  }

  // ── Boot ─────────────────────────────────────────────────────
  connect();
})();

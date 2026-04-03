(function () {
  'use strict';

  // ── DOM refs ──────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const setupScreen   = $('setupScreen');
  const statusEl      = $('status');
  const gameFeed      = $('gameFeed');
  const tableArea     = $('tableArea');
  const tableMelds    = $('tableMelds');
  const pilesRow      = $('pilesRow');
  const drawPile      = $('drawPile');
  const discardPile   = $('discardPile');
  const discardTop    = $('discardTop');
  const drawCount     = $('drawCount');
  const actionBar     = $('actionBar');
  const handArea      = $('handArea');
  const handCards     = $('handCards');
  const handCount     = $('handCount');
  const playerList    = $('playerList');
  const sbRows        = $('sbRows');
  const roundBadge    = $('roundBadge');
  const btnNewGame    = $('btnNewGame');
  const btnBack       = $('btnBack');
  const btnDraw       = $('btnDraw');
  const btnPickDiscard= $('btnPickDiscard');
  const btnMeld       = $('btnMeld');
  const btnAddToMeld  = $('btnAddToMeld');
  const btnSwapJoker  = $('btnSwapJoker');
  const btnDiscard    = $('btnDiscard');
  const meldPointsEl  = $('meldPoints');
  const meldPtsVal    = $('meldPtsVal');
  const roundOverlay  = $('roundOverlay');
  const ovTitle       = $('ovTitle');
  const ovBody        = $('ovBody');
  const btnNextRound  = $('btnNextRound');
  const gameOverOverlay = $('gameOverOverlay');
  const goTitle       = $('goTitle');
  const goBody        = $('goBody');
  const btnNewGameOver= $('btnNewGameOver');
  const sidebar       = $('sidebar');
  const btnToggleSidebar = $('btnToggleSidebar');

  // ── Constants ─────────────────────────────────────────────────
  const SUITS = ['♠','♥','♦','♣'];
  const SUIT_COLORS = {'♠':'black','♥':'red','♦':'red','♣':'black'};
  const RANK_NAMES = {1:'A',11:'J',12:'Q',13:'K'};
  const FEED_ICONS = {play:'🃏',meld:'📤',info:'ℹ️',win:'🏆',ai:'🤖'};
  const AI_NAMES = ['Aziz','Fatma','Youssef'];
  const AI_DELAY = 800;

  // ── State ─────────────────────────────────────────────────────
  let deck = [];
  let discardPileCards = [];     // full discard pile (stack)
  let hand = [];                 // player hand [{num,suit,isJoker}]
  let melds = [];                // table melds — each is [{num,suit,isJoker,originalCard?}]
  let players = [];              // [{name,hand[],score,hasOpened}]
  let currentPlayer = 0;
  let phase = 'setup';          // setup | draw | play | discard | ai | roundover | gameover
  let selectedIndices = new Set();
  let selectedMeldIdx = -1;
  let roundNum = 0;
  let loseThreshold = 200;
  let hasDrawn = false;
  let dragSrcIdx = -1;
  let turnOpenPts = 0;        // accumulated points for opening meld in a single turn
  let pendingOpenMelds = [];  // melds placed this turn before opening (indices into melds[])
  let pendingOpenCards = [];  // cards that were in hand before pending melds (for undo)

  // ── Helpers ───────────────────────────────────────────────────
  function escapeHtml(s) { return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  function rankLabel(num) { return RANK_NAMES[num] || String(num); }
  function cardStr(c) { return c.isJoker ? '🃏' : rankLabel(c.num) + c.suit; }
  function cardPts(c) {
    if (c.isJoker) return 0;          // joker value determined by context
    if (c.num === 1 || c.num >= 11) return 10;
    return c.num;
  }
  function cardPtsInMeld(c) {
    // When used in a meld, a joker takes the value of the card it substitutes
    if (c.isJoker && c.substituteNum) {
      if (c.substituteNum === 1 || c.substituteNum >= 11) return 10;
      return c.substituteNum;
    }
    return cardPts(c);
  }
  function handPts(h) { return h.reduce((s,c) => s + cardPts(c), 0); }
  function colorClass(c) { return c.isJoker ? 'joker' : (SUIT_COLORS[c.suit] || 'black'); }

  function buildDeck() {
    const d = [];
    for (let copy = 0; copy < 2; copy++) {
      for (let num = 1; num <= 13; num++) {
        for (const suit of SUITS) d.push({num, suit, isJoker: false});
      }
    }
    d.push({num:0, suit:'🃏', isJoker:true});
    d.push({num:0, suit:'🃏', isJoker:true});
    return d;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  // ── Meld validation ──────────────────────────────────────────
  // Returns {valid, type:'set'|'run', pts} or {valid:false}
  function validateMeld(cards) {
    if (cards.length < 3) return {valid:false};
    const realCards = cards.filter(c => !c.isJoker);
    const jokerCount = cards.length - realCards.length;

    // ── Try SET: 3-4 cards same rank, different suits ──
    if (cards.length >= 3 && cards.length <= 4) {
      const ranks = new Set(realCards.map(c => c.num));
      const suits = realCards.map(c => c.suit);
      const uniqueSuits = new Set(suits);
      if (ranks.size <= 1 && uniqueSuits.size === suits.length && realCards.length + jokerCount <= 4) {
        const rank = realCards.length > 0 ? realCards[0].num : 1;
        const ptVal = (rank === 1 || rank >= 11) ? 10 : rank;
        const pts = cards.length * ptVal;
        // Tag jokers
        const usedSuits = new Set(suits);
        const availSuits = SUITS.filter(s => !usedSuits.has(s));
        let ji = 0;
        cards.forEach(c => { if (c.isJoker) { c.substituteNum = rank; c.substituteSuit = availSuits[ji++] || '♠'; }});
        return {valid:true, type:'set', pts};
      }
    }

    // ── Try RUN: 3+ consecutive same suit ──
    const suitSet = new Set(realCards.map(c => c.suit));
    if (suitSet.size <= 1) {
      const suit = suitSet.size === 1 ? [...suitSet][0] : '♠';
      // Sort real cards by num
      const sorted = realCards.map(c => c.num).sort((a,b) => a-b);

      // Try fitting cards into a run of length = cards.length
      // Ace can be 1 or 14 (high)
      const tryStart = (start) => {
        const needed = [];
        for (let i = 0; i < cards.length; i++) needed.push(start + i);
        // Check no value exceeds 14 (Ace-high = 14, no wrap around)
        if (needed[needed.length - 1] > 14) return null;
        // Map real card nums; ace can be 1 or 14
        const available = [];
        for (const c of realCards) {
          available.push(c.num);
          if (c.num === 1) available.push(14); // ace-high
        }
        // Greedy match
        const usedReal = new Set();
        let jUsed = 0;
        for (const n of needed) {
          // Find a real card for this position
          let found = false;
          for (let ri = 0; ri < realCards.length; ri++) {
            if (usedReal.has(ri)) continue;
            const rn = realCards[ri].num;
            if (rn === n || (rn === 1 && n === 14)) {
              usedReal.add(ri);
              found = true;
              break;
            }
          }
          if (!found) jUsed++;
        }
        if (jUsed !== jokerCount) return null;
        // Valid! Calculate points
        let pts = 0;
        const jokers = cards.filter(c => c.isJoker);
        let ji = 0;
        const usedReal2 = new Set();
        for (let i = 0; i < needed.length; i++) {
          const n = needed[i];
          const actualNum = n > 13 ? 1 : n; // 14 -> Ace
          let found = false;
          for (let ri = 0; ri < realCards.length; ri++) {
            if (usedReal2.has(ri)) continue;
            const rn = realCards[ri].num;
            if (rn === n || (rn === 1 && n === 14)) {
              usedReal2.add(ri);
              pts += cardPts(realCards[ri]);
              found = true;
              break;
            }
          }
          if (!found && ji < jokers.length) {
            jokers[ji].substituteNum = actualNum;
            jokers[ji].substituteSuit = suit;
            pts += (actualNum === 1 || actualNum >= 11) ? 10 : actualNum;
            ji++;
          }
        }
        return pts;
      };

      // Try all starting points 1..14
      for (let s = 1; s <= 14; s++) {
        const pts = tryStart(s);
        if (pts !== null) return {valid:true, type:'run', pts};
      }
    }

    return {valid:false};
  }

  // Check if a card can be added to a meld
  function canAddToMeld(meld, card) {
    const test = [...meld, card];
    return validateMeld(test).valid;
  }

  // Check which position a card can be added (for runs, beginning or end)
  function addCardToMeld(meld, card) {
    // Try appending
    let test = [...meld, card];
    if (validateMeld(test).valid) return test;
    // Try prepending
    test = [card, ...meld];
    if (validateMeld(test).valid) return test;
    return null;
  }

  // ── Game flow ─────────────────────────────────────────────────
  function startNewGame() {
    const aiCountVal = parseInt($('aiCount').value);
    loseThreshold = parseInt($('loseThreshold').value);
    roundNum = 0;

    players = [{name:'You', hand:[], score:0, hasOpened:false, isHuman:true}];
    for (let i = 0; i < aiCountVal; i++) {
      players.push({name: AI_NAMES[i], hand:[], score:0, hasOpened:false, isHuman:false});
    }

    setupScreen.style.display = 'none';
    [statusEl, gameFeed, tableArea, pilesRow, actionBar, handArea].forEach(el => el.style.display = '');
    gameFeed.innerHTML = '';

    startRound();
  }

  function startRound() {
    roundNum++;
    roundBadge.textContent = 'Round ' + roundNum;
    deck = buildDeck();
    shuffle(deck);
    discardPileCards = [];
    melds = [];
    selectedIndices.clear();
    selectedMeldIdx = -1;
    hasDrawn = false;

    // Reset opening
    players.forEach(p => { p.hand = []; p.hasOpened = false; });

    // Deal 14 cards each
    for (let i = 0; i < 14; i++) {
      for (const p of players) {
        p.hand.push(deck.pop());
      }
    }

    // Flip one card to discard
    discardPileCards.push(deck.pop());

    hand = players[0].hand;
    sortHand(hand);

    currentPlayer = 0;
    phase = 'draw';
    turnOpenPts = 0;
    pendingOpenMelds = [];
    pendingOpenCards = [];

    addLog('Round ' + roundNum + ' begins! Your turn — draw a card.', 'info');
    renderAll(true);
    updateButtons();
  }

  function sortHand(h) {
    h.sort((a, b) => {
      if (a.isJoker && !b.isJoker) return 1;
      if (!a.isJoker && b.isJoker) return -1;
      if (a.isJoker && b.isJoker) return 0;
      return a.num - b.num || SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
    });
  }

  // ── Drawing ───────────────────────────────────────────────────
  function drawFromDeck() {
    if (phase !== 'draw' || currentPlayer !== 0 || hasDrawn) return;
    if (deck.length === 0) reshuffleDeck();
    const card = deck.pop();
    hand.push(card);
    hasDrawn = true;
    phase = 'play';
    addLog('You drew a card from the deck.', 'info');
    drawPile.classList.add('glow');
    setTimeout(() => drawPile.classList.remove('glow'), 600);
    renderAll();
    updateButtons();
  }

  function pickFromDiscard() {
    if (phase !== 'draw' || currentPlayer !== 0 || hasDrawn) return;
    if (discardPileCards.length === 0) return;
    const card = discardPileCards.pop();
    hand.push(card);
    hasDrawn = true;
    phase = 'play';
    addLog('You picked ' + cardStr(card) + ' from the discard pile.', 'info');
    discardPile.classList.add('glow');
    setTimeout(() => discardPile.classList.remove('glow'), 500);
    renderAll();
    updateButtons();
  }

  function reshuffleDeck() {
    if (discardPileCards.length <= 1) return;
    const top = discardPileCards.pop();
    deck = [...discardPileCards];
    discardPileCards = [top];
    shuffle(deck);
    addLog('Deck reshuffled from discard pile.', 'info');
  }

  // ── Melding ───────────────────────────────────────────────────
  function meldSelected() {
    if (phase !== 'play' || currentPlayer !== 0) return;
    const cards = [...selectedIndices].sort((a,b) => a-b).map(i => ({...hand[i]}));
    const result = validateMeld(cards);
    if (!result.valid) { setStatus('Invalid meld!'); return; }

    const p = players[0];

    // Remove from hand (descending indices)
    const indices = [...selectedIndices].sort((a,b) => b-a);
    const meldCards = [];
    for (const i of indices) {
      meldCards.unshift(hand.splice(i, 1)[0]);
    }

    // Re-validate with actual card objects (joker tags get set on these)
    validateMeld(meldCards);

    const meldIdx = melds.length;
    melds.push(meldCards);

    if (!p.hasOpened) {
      turnOpenPts += result.pts;
      pendingOpenMelds.push(meldIdx);
      pendingOpenCards.push({indices: [...selectedIndices].sort((a,b) => a-b), cards: meldCards});
      if (turnOpenPts >= 71) {
        p.hasOpened = true;
        pendingOpenMelds = [];
        pendingOpenCards = [];
        addLog('You opened with ' + turnOpenPts + ' points!', 'meld');
      } else {
        addLog('You melded ' + result.pts + ' pts (need ' + (71 - turnOpenPts) + ' more to open).', 'meld');
      }
    } else {
      addLog('You melded a ' + result.type + ' of ' + meldCards.map(cardStr).join(' '), 'meld');
    }

    selectedIndices.clear();
    renderAll();
    updateButtons();
    checkWin(0);
  }

  function addToMeld() {
    if (phase !== 'play' || currentPlayer !== 0) return;
    if (!players[0].hasOpened) { setStatus('Open first before adding to melds!'); return; }
    if (selectedMeldIdx < 0 || selectedMeldIdx >= melds.length) { setStatus('Select a meld on the table first!'); return; }
    if (selectedIndices.size !== 1) { setStatus('Select exactly 1 card to add!'); return; }

    const cardIdx = [...selectedIndices][0];
    const card = hand[cardIdx];
    const meld = melds[selectedMeldIdx];
    const newMeld = addCardToMeld(meld, card);
    if (!newMeld) { setStatus('Card doesn\'t fit this meld!'); return; }

    hand.splice(cardIdx, 1);
    melds[selectedMeldIdx] = newMeld;
    selectedIndices.clear();
    selectedMeldIdx = -1;
    addLog('You added ' + cardStr(card) + ' to a meld.', 'meld');
    renderAll();
    updateButtons();
    checkWin(0);
  }

  function swapJoker() {
    if (phase !== 'play' || currentPlayer !== 0) return;
    if (!players[0].hasOpened) { setStatus('Open first!'); return; }
    if (selectedMeldIdx < 0) { setStatus('Select a meld with a Joker!'); return; }
    if (selectedIndices.size !== 1) { setStatus('Select exactly 1 card to swap for the Joker!'); return; }

    const cardIdx = [...selectedIndices][0];
    const card = hand[cardIdx];
    const meld = melds[selectedMeldIdx];

    // Find a joker in the meld that this card can replace
    const jokerPos = meld.findIndex(c => c.isJoker);
    if (jokerPos === -1) { setStatus('No Joker in this meld!'); return; }

    // Check if the card can substitute
    const testMeld = [...meld];
    testMeld[jokerPos] = card;
    if (!validateMeld(testMeld).valid) { setStatus('Card doesn\'t match the Joker\'s position!'); return; }

    // Swap
    const joker = meld[jokerPos];
    joker.substituteNum = undefined;
    joker.substituteSuit = undefined;
    meld[jokerPos] = card;
    hand.splice(cardIdx, 1);
    hand.push(joker);

    selectedIndices.clear();
    selectedMeldIdx = -1;
    addLog('You swapped a Joker from a meld!', 'meld');
    renderAll();
    updateButtons();
  }

  function discardCard() {
    if (phase !== 'play' || currentPlayer !== 0) return;
    if (selectedIndices.size !== 1) { setStatus('Select exactly 1 card to discard!'); return; }

    const p = players[0];
    // If the player hasn't opened and has pending melds, undo them
    if (!p.hasOpened && pendingOpenMelds.length > 0) {
      // Undo pending melds — put cards back in hand
      for (let i = pendingOpenMelds.length - 1; i >= 0; i--) {
        const meldIdx = pendingOpenMelds[i];
        const meldCards = melds.splice(meldIdx, 1)[0];
        hand.push(...meldCards);
      }
      pendingOpenMelds = [];
      pendingOpenCards = [];
      turnOpenPts = 0;
      addLog('Opening not reached — melds returned to hand.', 'info');
      // Re-sort and re-render — selected index may have shifted
      sortHand(hand);
      selectedIndices.clear();
      renderAll();
      updateButtons();
      setStatus('You need ≥ 71 points to open. Melds returned to your hand. Select a card to discard.');
      return;
    }

    const cardIdx = [...selectedIndices][0];
    const card = hand.splice(cardIdx, 1)[0];
    discardPileCards.push(card);
    selectedIndices.clear();
    addLog('You discarded ' + cardStr(card) + '.', 'info');

    if (hand.length === 0) {
      endRound(0);
      return;
    }

    phase = 'ai';
    hasDrawn = false;
    renderAll();
    updateButtons();
    advanceTurn();
  }

  // ── Win check ─────────────────────────────────────────────────
  function checkWin(playerIdx) {
    if (players[playerIdx].hand.length === 0) {
      endRound(playerIdx);
      return true;
    }
    return false;
  }

  function endRound(winnerIdx) {
    phase = 'roundover';
    const winner = players[winnerIdx];
    addLog(winner.name + ' wins the round!', 'win');

    // Calculate penalties
    const penalties = players.map((p, i) => {
      const pts = i === winnerIdx ? 0 : handPts(p.hand);
      p.score += pts;
      return {name: p.name, pts, total: p.score, isWinner: i === winnerIdx};
    });

    // Show overlay
    ovTitle.textContent = winner.name + ' wins Round ' + roundNum + '!';
    ovBody.innerHTML = '';
    for (const r of penalties) {
      const row = document.createElement('div');
      row.className = 'ov-row' + (r.isWinner ? ' winner' : '');
      row.innerHTML = `<span class="ov-name">${escapeHtml(r.name)}</span>
        <span class="ov-pts">${r.isWinner ? '—' : '+' + r.pts}</span>
        <span class="ov-total">Total: ${r.total}</span>`;
      ovBody.appendChild(row);
    }
    roundOverlay.classList.add('show');

    if (winnerIdx === 0) {
      fireConfetti();
      if (typeof reportScore === 'function') reportScore('rami', 1);
    }

    renderScoreboard();
    renderPlayers();
  }

  function nextRound() {
    roundOverlay.classList.remove('show');
    // Check for game over
    const maxScore = Math.max(...players.map(p => p.score));
    if (maxScore >= loseThreshold) {
      endGame();
      return;
    }
    startRound();
  }

  function endGame() {
    phase = 'gameover';
    const sorted = [...players].sort((a, b) => a.score - b.score);
    goTitle.textContent = sorted[0].name === 'You' ? '🏆 YOU WIN!' : '🏆 ' + sorted[0].name + ' Wins!';
    goBody.innerHTML = '';
    sorted.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'ov-row' + (i === 0 ? ' winner' : '');
      row.innerHTML = `<span class="ov-name">${i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '#' + (i+1)} ${escapeHtml(p.name)}</span>
        <span class="ov-total">${p.score} pts</span>`;
      goBody.appendChild(row);
    });
    gameOverOverlay.classList.add('show');
    if (sorted[0].name === 'You') fireConfetti();
  }

  // ── AI Turn ───────────────────────────────────────────────────
  function advanceTurn() {
    currentPlayer = (currentPlayer + 1) % players.length;
    if (currentPlayer === 0) {
      phase = 'draw';
      hasDrawn = false;
      turnOpenPts = 0;
      pendingOpenMelds = [];
      pendingOpenCards = [];
      setStatus('Your turn — draw a card.');
      renderAll();
      updateButtons();
      return;
    }
    phase = 'ai';
    setStatus(players[currentPlayer].name + ' is thinking…');
    renderPlayers();
    setTimeout(() => runAI(currentPlayer), AI_DELAY);
  }

  function runAI(idx) {
    if (phase !== 'ai') return;
    const p = players[idx];
    const aiHand = p.hand;

    // 1. Draw — prefer discard if it helps complete a meld
    let drewFromDiscard = false;
    if (discardPileCards.length > 0) {
      const topDiscard = discardPileCards[discardPileCards.length - 1];
      if (aiCanUseDraw(aiHand, topDiscard)) {
        discardPileCards.pop();
        aiHand.push(topDiscard);
        drewFromDiscard = true;
        addLog(p.name + ' picked up ' + cardStr(topDiscard) + ' from discard.', 'ai');
      }
    }
    if (!drewFromDiscard) {
      if (deck.length === 0) reshuffleDeck();
      if (deck.length > 0) {
        aiHand.push(deck.pop());
        addLog(p.name + ' drew from the deck.', 'ai');
      }
    }

    // 2. Meld if possible
    aiTryMeld(idx);

    // 3. Add to existing melds if opened
    if (p.hasOpened) aiTryAdd(idx);

    // 4. Check win before discard
    if (aiHand.length === 0) {
      if (checkWin(idx)) { renderAll(); return; }
    }

    // 5. Discard least useful
    if (aiHand.length > 0) {
      const discIdx = aiBestDiscard(aiHand);
      const disc = aiHand.splice(discIdx, 1)[0];
      discardPileCards.push(disc);
      addLog(p.name + ' discarded ' + cardStr(disc) + '.', 'ai');

      if (aiHand.length === 0) {
        if (checkWin(idx)) { renderAll(); return; }
      }
    }

    renderAll();
    updateButtons();
    setTimeout(() => advanceTurn(), AI_DELAY / 2);
  }

  // AI: check if a discard card helps
  function aiCanUseDraw(h, card) {
    for (let i = 0; i < h.length; i++) {
      for (let j = i + 1; j < h.length; j++) {
        const test = [h[i], h[j], card];
        if (validateMeld(test).valid) return true;
      }
    }
    return false;
  }

  // AI: try to meld
  function aiTryMeld(idx) {
    const p = players[idx];
    const h = p.hand;

    if (p.hasOpened) {
      // Already opened — just meld anything valid
      let found = true;
      while (found) {
        found = false;
        const best = aiFindBestMeld(h, true);
        if (best) {
          const sorted = [...best.indices].sort((a,b) => b-a);
          const meldCards = [];
          for (const i of sorted) meldCards.unshift(h.splice(i, 1)[0]);
          validateMeld(meldCards); // tag jokers
          melds.push(meldCards);
          const desc = best.type === 'set'
            ? 'a set of ' + rankLabel(meldCards.find(c => !c.isJoker)?.num || 1) + 's'
            : 'a run of ' + meldCards.map(cardStr).join(' ');
          addLog(p.name + ' melded ' + desc + '.', 'ai');
          found = true;
        }
      }
    } else {
      // Not opened — find all valid melds and see if total >= 71
      const allMelds = aiFindAllMelds(h);
      const totalPts = allMelds.reduce((s, m) => s + m.pts, 0);
      if (totalPts >= 71) {
        // Place all of them
        // Remove in reverse order of indices to keep indices stable
        const allIndices = new Set();
        const meldGroups = [];
        for (const m of allMelds) {
          meldGroups.push(m.indices);
          for (const i of m.indices) allIndices.add(i);
        }
        // Remove from hand in descending index order
        const removeSorted = [...allIndices].sort((a,b) => b-a);
        const removedCards = new Map();
        for (const i of removeSorted) {
          removedCards.set(i, h.splice(i, 1)[0]);
        }
        for (const group of meldGroups) {
          const meldCards = group.map(i => removedCards.get(i));
          validateMeld(meldCards); // tag jokers
          melds.push(meldCards);
          const result = validateMeld([...meldCards]);
          const desc = (result.type === 'set')
            ? 'a set of ' + rankLabel(meldCards.find(c => !c.isJoker)?.num || 1) + 's'
            : 'a run of ' + meldCards.map(cardStr).join(' ');
          addLog(p.name + ' melded ' + desc + '.', 'ai');
        }
        p.hasOpened = true;
        addLog(p.name + ' opened with ' + totalPts + ' points!', 'ai');
      }
    }
  }

  // Find all non-overlapping valid melds in a hand (greedy — biggest first)
  function aiFindAllMelds(h) {
    const used = new Set();
    const result = [];
    for (let size = Math.min(h.length, 13); size >= 3; size--) {
      const combos = combinations(h.length, size);
      for (const indices of combos) {
        if (indices.some(i => used.has(i))) continue;
        const cards = indices.map(i => ({...h[i]}));
        const v = validateMeld(cards);
        if (v.valid) {
          result.push({indices, type: v.type, pts: v.pts});
          for (const i of indices) used.add(i);
        }
      }
    }
    return result;
  }

  function aiFindBestMeld(h, hasOpened) {
    // Try all 3-card and 4-card combinations
    let bestMeld = null;
    for (let size = Math.min(h.length, 13); size >= 3; size--) {
      const combos = combinations(h.length, size);
      for (const indices of combos) {
        const cards = indices.map(i => ({...h[i]}));
        const result = validateMeld(cards);
        if (result.valid) {
          if (!hasOpened && result.pts < 71) continue;
          if (!bestMeld || result.pts > bestMeld.pts) {
            bestMeld = {indices, type: result.type, pts: result.pts};
          }
        }
      }
      if (bestMeld) break; // prefer larger melds
    }
    return bestMeld;
  }

  // AI: try adding to existing melds
  function aiTryAdd(idx) {
    const h = players[idx].hand;
    let changed = true;
    while (changed) {
      changed = false;
      for (let ci = h.length - 1; ci >= 0; ci--) {
        for (let mi = 0; mi < melds.length; mi++) {
          const newMeld = addCardToMeld(melds[mi], h[ci]);
          if (newMeld) {
            addLog(players[idx].name + ' added ' + cardStr(h[ci]) + ' to a meld.', 'ai');
            melds[mi] = newMeld;
            h.splice(ci, 1);
            changed = true;
            break;
          }
        }
        if (changed) break;
      }
    }
  }

  // AI: pick least useful card to discard
  function aiBestDiscard(h) {
    // Score each card: lower = less useful
    let bestIdx = 0, bestScore = Infinity;
    for (let i = 0; i < h.length; i++) {
      const c = h[i];
      if (c.isJoker) continue; // never discard joker
      let score = 0;
      // Count how many partial melds this card is in
      for (let j = 0; j < h.length; j++) {
        if (j === i) continue;
        if (h[j].num === c.num) score += 3;
        if (!h[j].isJoker && h[j].suit === c.suit && Math.abs(h[j].num - c.num) <= 2) score += 2;
      }
      // Higher point cards are worse to keep (penalty risk)
      score -= cardPts(c) * 0.5;
      if (score < bestScore) { bestScore = score; bestIdx = i; }
    }
    return bestIdx;
  }

  // Generate combinations of size k from n
  function combinations(n, k) {
    if (k > n) return [];
    const result = [];
    const combo = [];
    function gen(start) {
      if (combo.length === k) { result.push([...combo]); return; }
      if (start >= n) return;
      if (result.length > 8000) return; // safety limit
      combo.push(start);
      gen(start + 1);
      combo.pop();
      gen(start + 1);
    }
    gen(0);
    return result;
  }

  // ── Rendering ─────────────────────────────────────────────────
  function renderAll(animate) {
    renderHand(animate);
    renderTable();
    renderDiscard();
    renderDraw();
    renderPlayers();
    renderScoreboard();
  }

  function renderHand(animate) {
    handCards.innerHTML = '';
    selectedIndices = new Set([...selectedIndices].filter(i => i < hand.length));
    handCount.textContent = hand.length;

    hand.forEach((card, i) => {
      const el = document.createElement('div');
      const cc = colorClass(card);
      el.className = 'game-card ' + cc + (selectedIndices.has(i) ? ' selected' : '') + (animate ? ' dealt' : '');
      if (animate) el.style.animationDelay = `${i * 0.04}s`;
      el.dataset.idx = i;
      el.draggable = true;

      if (card.isJoker) {
        el.innerHTML = `<span class="card-num">🃏</span><span class="card-suit">Joker</span>`;
      } else {
        el.innerHTML = `<span class="card-corner">${rankLabel(card.num)}<br>${card.suit}</span>
          <span class="card-num">${rankLabel(card.num)}</span>
          <span class="card-suit">${card.suit}</span>`;
      }

      // Click to select
      el.addEventListener('click', () => {
        if (phase !== 'play' && phase !== 'draw') return;
        if (selectedIndices.has(i)) {
          selectedIndices.delete(i);
          el.classList.remove('selected');
        } else {
          selectedIndices.add(i);
          el.classList.add('selected');
        }
        updateButtons();
        updateMeldPoints();
      });

      // Drag and drop for reordering
      el.addEventListener('dragstart', e => {
        dragSrcIdx = i;
        el.classList.add('dragging');
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', String(i));
      });
      el.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        handCards.querySelectorAll('.drag-over').forEach(c => c.classList.remove('drag-over'));
      });
      el.addEventListener('dragover', e => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        el.classList.add('drag-over');
      });
      el.addEventListener('dragleave', () => el.classList.remove('drag-over'));
      el.addEventListener('drop', e => {
        e.preventDefault();
        el.classList.remove('drag-over');
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
        const toIdx = i;
        if (fromIdx === toIdx || isNaN(fromIdx)) return;
        // Reorder
        const card = hand.splice(fromIdx, 1)[0];
        hand.splice(toIdx, 0, card);
        // Rebuild selected indices after reorder
        selectedIndices.clear();
        renderHand();
        updateButtons();
      });

      handCards.appendChild(el);
    });
  }

  function renderTable() {
    tableMelds.innerHTML = '';
    if (melds.length === 0) {
      tableMelds.innerHTML = '<div class="table-empty">No melds on the table yet</div>';
      return;
    }
    melds.forEach((meld, mi) => {
      const group = document.createElement('div');
      group.className = 'meld-group' + (selectedMeldIdx === mi ? ' selected' : '');
      const idx = document.createElement('span');
      idx.className = 'mg-idx';
      idx.textContent = mi + 1;
      group.appendChild(idx);

      for (const card of meld) {
        const el = document.createElement('div');
        const cc = colorClass(card);
        el.className = 'table-card ' + cc;
        if (card.isJoker) {
          el.innerHTML = `<span class="tc-num">🃏</span>`;
        } else {
          el.innerHTML = `<span class="tc-num">${rankLabel(card.num)}</span><span class="tc-suit">${card.suit}</span>`;
        }
        group.appendChild(el);
      }

      group.addEventListener('click', () => {
        if (selectedMeldIdx === mi) {
          selectedMeldIdx = -1;
        } else {
          selectedMeldIdx = mi;
        }
        renderTable();
        updateButtons();
      });

      tableMelds.appendChild(group);
    });
  }

  function renderDiscard() {
    discardTop.innerHTML = '';
    if (discardPileCards.length === 0) {
      discardTop.className = 'discard-top';
      discardTop.innerHTML = '<span class="dt-empty-msg">Empty</span>';
      return;
    }
    const top = discardPileCards[discardPileCards.length - 1];
    const cc = colorClass(top);
    discardTop.className = 'discard-top has-card ' + cc;
    if (top.isJoker) {
      discardTop.innerHTML = `<span class="dt-num">🃏</span>`;
    } else {
      discardTop.innerHTML = `<span class="dt-num">${rankLabel(top.num)}</span><span class="dt-suit">${top.suit}</span>`;
    }
  }

  function renderDraw() {
    drawCount.textContent = deck.length;
  }

  function renderPlayers() {
    playerList.innerHTML = '';
    const colors = ['#22c55e','#06b6d4','#f472b6','#fbbf24'];
    players.forEach((p, i) => {
      const div = document.createElement('div');
      div.className = 'player-card' + (i === 0 ? ' me' : '') + (i === currentPlayer && phase !== 'setup' && phase !== 'roundover' && phase !== 'gameover' ? ' active' : '');
      const badge = p.hand.length + ' cards';
      div.innerHTML = `<span class="pc-dot" style="background:${colors[i]}"></span>
        <span class="pc-name">${escapeHtml(p.name)}${i === 0 ? ' (You)' : ''}</span>
        <span class="pc-cards">🃏 ${p.hand.length}</span>`;
      playerList.appendChild(div);
    });
  }

  function renderScoreboard() {
    sbRows.innerHTML = '';
    players.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'sb-row' + (i === 0 ? ' me' : '');
      row.innerHTML = `<span class="sb-name">${escapeHtml(p.name)}</span><span class="sb-score">${p.score}</span>`;
      sbRows.appendChild(row);
    });
  }

  function updateMeldPoints() {
    if (selectedIndices.size >= 3) {
      const cards = [...selectedIndices].map(i => ({...hand[i]}));
      const result = validateMeld(cards);
      if (result.valid) {
        const total = players[0].hasOpened ? result.pts : turnOpenPts + result.pts;
        const label = players[0].hasOpened
          ? result.pts + ' pts'
          : total + ' / 71 pts to open';
        meldPointsEl.style.display = '';
        meldPtsVal.textContent = label;
        return;
      }
    }
    // Show current opening progress even when no selection
    if (!players[0].hasOpened && turnOpenPts > 0) {
      meldPointsEl.style.display = '';
      meldPtsVal.textContent = turnOpenPts + ' / 71 pts toward opening';
      return;
    }
    meldPointsEl.style.display = 'none';
  }

  // ── Buttons ───────────────────────────────────────────────────
  function updateButtons() {
    const isMyTurn = currentPlayer === 0;
    const inDraw = phase === 'draw' && isMyTurn;
    const inPlay = phase === 'play' && isMyTurn;

    btnDraw.disabled = !inDraw;
    btnPickDiscard.disabled = !(inDraw && discardPileCards.length > 0);
    btnMeld.disabled = !(inPlay && selectedIndices.size >= 3);
    btnAddToMeld.disabled = !(inPlay && selectedIndices.size === 1 && selectedMeldIdx >= 0 && players[0].hasOpened);
    btnSwapJoker.disabled = !(inPlay && selectedIndices.size === 1 && selectedMeldIdx >= 0 && players[0].hasOpened);
    btnDiscard.disabled = !(inPlay && selectedIndices.size === 1);

    if (isMyTurn && inDraw) {
      setStatus('Draw a card from the deck or discard pile.');
    } else if (isMyTurn && inPlay) {
      setStatus('Meld, add to melds, or discard to end your turn.');
    }

    updateMeldPoints();
  }

  function setStatus(text) { statusEl.textContent = text; }

  function addLog(html, type) {
    const cls = type || 'info';
    const div = document.createElement('div');
    div.className = 'feed-entry feed-' + cls;
    const icon = document.createElement('span');
    icon.className = 'feed-icon';
    icon.textContent = FEED_ICONS[cls] || 'ℹ️';
    const text = document.createElement('span');
    text.innerHTML = html;
    div.appendChild(icon);
    div.appendChild(text);
    gameFeed.insertBefore(div, gameFeed.firstChild);
    while (gameFeed.children.length > 50) gameFeed.removeChild(gameFeed.lastChild);
  }

  // ── Confetti ──────────────────────────────────────────────────
  function fireConfetti() {
    const canvas = $('confetti');
    const ctx = canvas.getContext('2d');
    canvas.width = innerWidth;
    canvas.height = innerHeight;
    const particles = [];
    const colors = ['#fbbf24','#8b5cf6','#06b6d4','#22c55e','#ef4444','#f472b6'];
    for (let i = 0; i < 150; i++) {
      particles.push({
        x: Math.random() * canvas.width, y: Math.random() * canvas.height - canvas.height,
        w: Math.random() * 8 + 4, h: Math.random() * 6 + 3,
        color: colors[Math.floor(Math.random() * colors.length)],
        vx: (Math.random() - .5) * 4, vy: Math.random() * 3 + 2,
        rot: Math.random() * 360, vr: (Math.random() - .5) * 10,
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

  // ── Event listeners ───────────────────────────────────────────
  btnNewGame.addEventListener('click', startNewGame);
  btnBack.addEventListener('click', () => { location.href = '/'; });
  btnDraw.addEventListener('click', drawFromDeck);
  btnPickDiscard.addEventListener('click', pickFromDiscard);
  btnMeld.addEventListener('click', meldSelected);
  btnAddToMeld.addEventListener('click', addToMeld);
  btnSwapJoker.addEventListener('click', swapJoker);
  btnDiscard.addEventListener('click', discardCard);
  btnNextRound.addEventListener('click', nextRound);
  btnNewGameOver.addEventListener('click', () => {
    gameOverOverlay.classList.remove('show');
    setupScreen.style.display = '';
    [statusEl, gameFeed, tableArea, pilesRow, actionBar, handArea].forEach(el => el.style.display = 'none');
  });

  drawPile.addEventListener('click', drawFromDeck);
  discardPile.addEventListener('click', pickFromDiscard);

  if (btnToggleSidebar) {
    btnToggleSidebar.addEventListener('click', () => sidebar.classList.toggle('open'));
  }
})();

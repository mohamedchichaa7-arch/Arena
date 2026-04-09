/* ═══════════════════════════════════════════════════════════════════
   SNAKES & LADDERS — Arena Room Client  |  snakesladders.js
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  // ── URL / session ────────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  const myName = sessionStorage.getItem('arena-name') || 'Player';
  if (!roomId) { location.href = '/'; return; }

  // ── Game constants ───────────────────────────────────────────────
  // Must match server exactly
  const SNAKES  = { 17:7, 54:34, 62:19, 64:60, 87:24, 93:73, 95:75, 99:78 };
  const LADDERS = { 4:14, 9:31, 20:38, 28:84, 40:59, 51:67, 63:81, 71:91 };

  const PLAYER_COLORS = ['#f472b6', '#38bdf8', '#4ade80', '#fbbf24'];

  // Dot positions (0..8 = 3×3 grid index) for each dice face
  const DOT_PATTERNS = {
    1: [4],
    2: [0, 8],
    3: [0, 4, 8],
    4: [0, 2, 6, 8],
    5: [0, 2, 4, 6, 8],
    6: [0, 2, 3, 5, 6, 8],
  };

  const STEP_MS = 150; // delay per square during step-by-step animation

  // ── DOM refs ─────────────────────────────────────────────────────
  const $ = s => document.getElementById(s);
  const statusEl       = $('status');
  const playerListEl   = $('playerList');
  const playerCountEl  = $('playerCount');
  const roomBadge      = $('roomBadge');
  const btnBack        = $('btnBack');
  const btnStartGame   = $('btnStartGame');
  const controls       = $('controls');
  const diceArea       = $('diceArea');
  const diceEl         = $('diceEl');
  const dotGrid        = $('dotGrid');
  const btnRoll        = $('btnRoll');
  const turnTag        = $('turnTag');
  const boardOuter     = $('boardOuter');
  const boardGrid      = $('boardGrid');
  const boardSvg       = $('boardSvg');
  const tokenLayer     = $('tokenLayer');
  const resultOverlay  = $('resultOverlay');
  const resultTitle    = $('resultTitle');
  const resultEmoji    = $('resultEmoji');
  const resultSub      = $('resultSub');
  const chatMessages   = $('chatMessages');
  const chatInput      = $('chatInput');
  const chatSend       = $('chatSend');
  const confettiCvs    = $('confetti');
  const cctx           = confettiCvs.getContext('2d');

  roomBadge.textContent = 'Room ' + roomId;

  // ── State ────────────────────────────────────────────────────────
  let ws = null, myId = null;
  let players      = [];  // [{ id, name, colorIdx }]  ordered by turn
  let positions    = {};  // { [id]: squareNumber }  0 = off-board
  let currentTurnId = null;
  let gameActive   = false;
  let animating    = false;
  let lobby        = new Map(); // id → name (everyone in room)

  // ── Board geometry ───────────────────────────────────────────────
  // Returns 0-based { col, rowFromTop } for square n (1-100)
  // The board snakes: row 0 (bottom) is L→R, row 1 is R→L, etc.
  function squareCoords(n) {
    const rb = Math.floor((n - 1) / 10);          // row from bottom (0=bottom)
    const cf = rb % 2 === 0
      ? (n - 1) % 10                              // even row: L→R
      : 9 - (n - 1) % 10;                         // odd row: R→L
    return { col: cf, rowFromTop: 9 - rb };
  }

  // Token position as % of board size
  function squarePct(n) {
    if (!n) return { x: 5, y: 105 };              // off-board: below square 1
    const { col, rowFromTop } = squareCoords(n);
    return { x: (col + 0.5) * 10, y: (rowFromTop + 0.5) * 10 };
  }

  // SVG viewBox(0-1000) centre of square n
  function squareSVG(n) {
    const { col, rowFromTop } = squareCoords(n);
    return { x: col * 100 + 50, y: rowFromTop * 100 + 50 };
  }

  // ── Build board ──────────────────────────────────────────────────
  function buildBoard() {
    boardGrid.innerHTML = '';
    for (let n = 1; n <= 100; n++) {
      const { col, rowFromTop } = squareCoords(n);
      const cell = document.createElement('div');
      cell.id = 'sq' + n;
      cell.className = 'board-cell ' + ((rowFromTop + col) % 2 === 0 ? 'cell-light' : 'cell-dark');
      if (n === 1)        cell.classList.add('cell-start');
      if (n === 100)      cell.classList.add('cell-end');
      if (SNAKES[n])      cell.classList.add('cell-snake-head');
      if (LADDERS[n])     cell.classList.add('cell-ladder-foot');
      cell.style.gridRow    = (rowFromTop + 1);
      cell.style.gridColumn = (col + 1);
      const numEl = document.createElement('span');
      numEl.className = 'cell-num';
      numEl.textContent = n;
      cell.appendChild(numEl);
      boardGrid.appendChild(cell);
    }
    drawSnakesAndLadders();
  }

  // ── SVG: draw all snakes and ladders ─────────────────────────────
  function drawSnakesAndLadders() {
    boardSvg.innerHTML = '';
    const ns = 'http://www.w3.org/2000/svg';
    // Ladders first (behind snakes)
    for (const [from, to] of Object.entries(LADDERS)) {
      drawLadder(parseInt(from), parseInt(to), ns);
    }
    // Snakes on top
    for (const [from, to] of Object.entries(SNAKES)) {
      drawSnakeSVG(parseInt(from), parseInt(to), ns);
    }
  }

  function drawLadder(from, to, ns) {
    const a = squareSVG(from); // foot (lower square)
    const b = squareSVG(to);   // top  (higher square)
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;
    const ux = dx / len, uy = dy / len;  // unit vector foot→top
    const px = -uy * 13, py = ux * 13;  // perpendicular offset for rails

    const g = document.createElementNS(ns, 'g');
    g.setAttribute('opacity', '0.78');

    function line(x1, y1, x2, y2, color, w) {
      const el = document.createElementNS(ns, 'line');
      el.setAttribute('x1', x1); el.setAttribute('y1', y1);
      el.setAttribute('x2', x2); el.setAttribute('y2', y2);
      el.setAttribute('stroke', color);
      el.setAttribute('stroke-width', w);
      el.setAttribute('stroke-linecap', 'round');
      g.appendChild(el);
    }

    // Two rails
    line(a.x + px, a.y + py, b.x + px, b.y + py, '#4ade80', 9);
    line(a.x - px, a.y - py, b.x - px, b.y - py, '#4ade80', 9);

    // 4 rungs evenly spaced
    for (let i = 1; i <= 4; i++) {
      const t = i / 5;
      const mx = a.x + dx * t, my = a.y + dy * t;
      line(mx + px, my + py, mx - px, my - py, '#86efac', 7);
    }

    // Foot & top circles
    function circle(cx, cy, r, fill) {
      const el = document.createElementNS(ns, 'circle');
      el.setAttribute('cx', cx); el.setAttribute('cy', cy);
      el.setAttribute('r', r);
      el.setAttribute('fill', fill);
      el.setAttribute('stroke', 'rgba(255,255,255,.5)');
      el.setAttribute('stroke-width', '3');
      g.appendChild(el);
    }
    circle(a.x, a.y, 11, '#22c55e');
    circle(b.x, b.y, 9,  '#4ade80');

    boardSvg.appendChild(g);
  }

  function drawSnakeSVG(from, to, ns) {
    const a = squareSVG(from); // head
    const b = squareSVG(to);   // tail
    const dx = b.x - a.x, dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy);
    if (len === 0) return;
    const ux = dx / len, uy = dy / len; // unit vector head→tail

    // Control points for a wavy cubic Bezier
    const cx1 = a.x + dx * 0.25 + uy * len * 0.35;
    const cy1 = a.y + dy * 0.25 - ux * len * 0.35;
    const cx2 = a.x + dx * 0.75 - uy * len * 0.35;
    const cy2 = a.y + dy * 0.75 + ux * len * 0.35;
    const d   = `M ${a.x} ${a.y} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${b.x} ${b.y}`;

    const g = document.createElementNS(ns, 'g');
    g.setAttribute('opacity', '0.82');

    // Outer body
    const body = document.createElementNS(ns, 'path');
    body.setAttribute('d', d);
    body.setAttribute('stroke', '#ef4444');
    body.setAttribute('stroke-width', '18');
    body.setAttribute('stroke-linecap', 'round');
    body.setAttribute('fill', 'none');
    g.appendChild(body);

    // Scale-texture inner dash
    const texture = document.createElementNS(ns, 'path');
    texture.setAttribute('d', d);
    texture.setAttribute('stroke', '#fca5a5');
    texture.setAttribute('stroke-width', '7');
    texture.setAttribute('stroke-linecap', 'round');
    texture.setAttribute('stroke-dasharray', '22 18');
    texture.setAttribute('fill', 'none');
    g.appendChild(texture);

    // Head circle
    const head = document.createElementNS(ns, 'circle');
    head.setAttribute('cx', a.x); head.setAttribute('cy', a.y);
    head.setAttribute('r', '19');
    head.setAttribute('fill', '#dc2626');
    head.setAttribute('stroke', 'rgba(255,255,255,.6)');
    head.setAttribute('stroke-width', '3');
    g.appendChild(head);

    // Tongue (forked, pointing away from tail)
    const tBase = { x: a.x - ux * 22, y: a.y - uy * 22 };
    const tongue = document.createElementNS(ns, 'path');
    tongue.setAttribute('d',
      `M ${tBase.x} ${tBase.y}` +
      ` L ${a.x - ux * 34 + uy * 11} ${a.y - uy * 34 - ux * 11}` +
      ` M ${tBase.x} ${tBase.y}` +
      ` L ${a.x - ux * 34 - uy * 11} ${a.y - uy * 34 + ux * 11}`
    );
    tongue.setAttribute('stroke', '#fde047');
    tongue.setAttribute('stroke-width', '4');
    tongue.setAttribute('stroke-linecap', 'round');
    g.appendChild(tongue);

    // Eyes (two small dots perpendicular to direction)
    function eye(ox, oy) {
      const el = document.createElementNS(ns, 'circle');
      el.setAttribute('cx', a.x - ux * 8 + ox);
      el.setAttribute('cy', a.y - uy * 8 + oy);
      el.setAttribute('r', '4');
      el.setAttribute('fill', '#fff');
      g.appendChild(el);
      const pupil = document.createElementNS(ns, 'circle');
      pupil.setAttribute('cx', a.x - ux * 8 + ox);
      pupil.setAttribute('cy', a.y - uy * 8 + oy);
      pupil.setAttribute('r', '2');
      pupil.setAttribute('fill', '#111');
      g.appendChild(pupil);
    }
    eye(-uy * 8, ux * 8);
    eye( uy * 8, -ux * 8);

    // Tail dot
    const tail = document.createElementNS(ns, 'circle');
    tail.setAttribute('cx', b.x); tail.setAttribute('cy', b.y);
    tail.setAttribute('r', '8');
    tail.setAttribute('fill', '#b91c1c');
    tail.setAttribute('stroke', 'rgba(255,255,255,.4)');
    tail.setAttribute('stroke-width', '2');
    g.appendChild(tail);

    boardSvg.appendChild(g);
  }

  // ── Tokens ───────────────────────────────────────────────────────
  function getOrCreateToken(playerId) {
    let el = $('tok-' + playerId);
    if (!el) {
      el = document.createElement('div');
      el.className = 'token';
      el.id = 'tok-' + playerId;
      const p = players.find(x => x.id === playerId);
      if (p) {
        el.style.background = PLAYER_COLORS[p.colorIdx] || '#888';
        el.textContent = (p.name || '?')[0].toUpperCase();
      }
      tokenLayer.appendChild(el);
    }
    return el;
  }

  function placeToken(playerId, square, offsetIdx) {
    const el = getOrCreateToken(playerId);
    const { x, y } = squarePct(square || 0);
    // Small 2×2 grid offset so overlapping tokens are visible
    const ox = (offsetIdx % 2) * 3.2 - 1.6;
    const oy = Math.floor(offsetIdx / 2) * -3.2;
    el.style.left = (x + ox) + '%';
    el.style.top  = (y + oy) + '%';
  }

  function refreshAllTokens() {
    players.forEach(p => {
      const sq = positions[p.id] || 0;
      const sharers = players.filter(q => (positions[q.id] || 0) === sq && sq > 0);
      const idx = sharers.findIndex(q => q.id === p.id);
      placeToken(p.id, sq, Math.max(0, idx));
    });
  }

  // ── Dice ─────────────────────────────────────────────────────────
  function renderDice(face) {
    dotGrid.innerHTML = '';
    const dots = DOT_PATTERNS[face] || [];
    for (let i = 0; i < 9; i++) {
      const d = document.createElement('div');
      d.className = dots.includes(i) ? 'dot' : 'dot empty';
      dotGrid.appendChild(d);
    }
  }

  function animateDice(finalFace) {
    return new Promise(resolve => {
      diceEl.classList.add('rolling');
      let t = 0;
      const iv = setInterval(() => {
        renderDice(Math.floor(Math.random() * 6) + 1);
        if (++t >= 10) {
          clearInterval(iv);
          diceEl.classList.remove('rolling');
          renderDice(finalFace);
          resolve();
        }
      }, 55);
    });
  }

  // ── Movement animation ───────────────────────────────────────────
  async function animateMove(playerId, from, landedOn, finalPos, event) {
    animating = true;
    syncRollBtn();

    const tokenEl = getOrCreateToken(playerId);

    // Step by step from `from` up to `landedOn`
    if (from !== landedOn && landedOn > 0) {
      const steps = landedOn - from;
      for (let i = 1; i <= steps; i++) {
        positions[playerId] = from + i;
        placeToken(playerId, from + i, 0);
        // pulse on each step
        tokenEl.style.animation = '';
        tokenEl.offsetWidth; // reflow
        tokenEl.style.animation = 'none';
        await sleep(STEP_MS);
      }
    }

    // Snake or ladder: smooth slide to finalPos
    if (event && finalPos !== landedOn) {
      await sleep(280);
      tokenEl.classList.add(event === 'snake' ? 'snake-slide' : 'ladder-climb');
      positions[playerId] = finalPos;
      placeToken(playerId, finalPos, 0);
      await sleep(620);
      tokenEl.classList.remove('snake-slide', 'ladder-climb');
    }

    // Pulse at the final landing spot
    tokenEl.classList.add('pulse');
    setTimeout(() => tokenEl.classList.remove('pulse'), 550);

    animating = false;
    syncRollBtn();
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── UI helpers ───────────────────────────────────────────────────
  function syncRollBtn() {
    btnRoll.disabled = !gameActive || currentTurnId !== myId || animating;
  }

  function syncTurnTag() {
    if (!gameActive || !currentTurnId) { turnTag.textContent = ''; return; }
    if (currentTurnId === myId) {
      turnTag.textContent = 'YOUR TURN';
      turnTag.style.color = 'var(--green)';
    } else {
      const p = players.find(x => x.id === currentTurnId);
      turnTag.textContent = (p?.name || 'Opponent') + "'s turn";
      turnTag.style.color = 'var(--dim)';
    }
  }

  function renderPlayerList() {
    playerListEl.innerHTML = '';
    if (gameActive) {
      players.forEach(p => {
        const card = document.createElement('div');
        const isTurn = p.id === currentTurnId;
        card.className = 'player-card' +
          (p.id === myId   ? ' me'   : '') +
          (isTurn          ? ' turn' : '');
        const color = PLAYER_COLORS[p.colorIdx] || '#aaa';
        const sq = positions[p.id] || 0;
        card.innerHTML = `
          <span class="pc-dot" style="background:${color}"></span>
          <span class="pc-name">${esc(p.name)}${p.id === myId ? ' (you)' : ''}</span>
          <span class="pc-sq">${sq > 0 ? sq : '—'}</span>
        `;
        playerListEl.appendChild(card);
      });
      playerCountEl.textContent = players.length;
    } else {
      let n = 0;
      lobby.forEach((name, pid) => {
        n++;
        const card = document.createElement('div');
        card.className = 'player-card' + (pid === myId ? ' me' : '');
        card.innerHTML = `
          <span class="pc-dot" style="background:${pid === myId ? '#34d399' : 'var(--accent)'}"></span>
          <span class="pc-name">${esc(name)}${pid === myId ? ' (you)' : ''}</span>
        `;
        playerListEl.appendChild(card);
      });
      playerCountEl.textContent = n;
    }
  }

  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ── Chat ─────────────────────────────────────────────────────────
  function chat(kind, name, text) {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + kind;
    div.innerHTML = kind !== 'system'
      ? `<span class="cm-name">${esc(name)}:</span>${esc(text)}`
      : esc(text);
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function sendChat() {
    const t = chatInput.value.trim();
    if (!t) return;
    wsSend({ type: 'chat', text: t });
    chat('me', myName, t);
    chatInput.value = '';
  }

  // ── Confetti ─────────────────────────────────────────────────────
  function launchConfetti() {
    confettiCvs.width = innerWidth; confettiCvs.height = innerHeight;
    const colors = ['#f472b6', '#38bdf8', '#fbbf24', '#34d399', '#a78bfa', '#fb923c'];
    const pp = Array.from({ length: 160 }, () => ({
      x: Math.random() * confettiCvs.width,
      y: Math.random() * confettiCvs.height - confettiCvs.height,
      vx: (Math.random() - 0.5) * 6, vy: Math.random() * 4 + 2,
      size: Math.random() * 8 + 3,
      color: colors[Math.floor(Math.random() * colors.length)],
      rotation: Math.random() * 360, rotSpeed: (Math.random() - 0.5) * 10,
      life: 1,
    }));
    (function anim() {
      cctx.clearRect(0, 0, confettiCvs.width, confettiCvs.height);
      let alive = false;
      for (const p of pp) {
        p.x += p.vx; p.y += p.vy; p.vy += 0.08;
        p.rotation += p.rotSpeed; p.life -= 0.003;
        if (p.life <= 0) continue; alive = true;
        cctx.save(); cctx.translate(p.x, p.y);
        cctx.rotate(p.rotation * Math.PI / 180);
        cctx.globalAlpha = p.life; cctx.fillStyle = p.color;
        cctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size * 0.5);
        cctx.restore();
      }
      if (alive) requestAnimationFrame(anim);
      else cctx.clearRect(0, 0, confettiCvs.width, confettiCvs.height);
    })();
  }

  // ── WebSocket ────────────────────────────────────────────────────
  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      const pw = sessionStorage.getItem('arena-room-password') || undefined;
      sessionStorage.removeItem('arena-room-password');
      wsSend({ type: 'join-room', roomId, name: myName, password: pw, token: sessionStorage.getItem('arena-token') || '' });
    };
    ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => {
      statusEl.textContent = 'Disconnected. Returning to lobby…';
      setTimeout(() => location.href = '/', 3000);
    };
  }

  function wsSend(obj) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // ── Message handling ─────────────────────────────────────────────
  function handleMsg(msg) {
    switch (msg.type) {

      case 'room-joined':
        myId = msg.myId;
        lobby.set(myId, myName);
        for (const p of (msg.players || [])) lobby.set(p.id, p.name);
        statusEl.textContent = 'Waiting for players… (' + lobby.size + ' in room)';
        controls.style.display = '';
        renderPlayerList();
        break;

      case 'player-joined':
        lobby.set(msg.id, msg.name);
        chat('system', '', esc(msg.name) + ' joined the room.');
        statusEl.textContent = lobby.size + ' player' + (lobby.size !== 1 ? 's' : '') + ' in room.';
        renderPlayerList();
        break;

      case 'player-left':
        lobby.delete(msg.id);
        chat('system', '', (msg.name || 'A player') + ' left.');
        renderPlayerList();
        break;

      // ── Game start ──────────────────────────────────────────────
      case 'sl-start': {
        players       = msg.players; // [{ id, name, colorIdx }]
        positions     = Object.assign({}, msg.positions);
        currentTurnId = msg.turnId;
        gameActive    = true;

        controls.style.display = 'none';
        diceArea.style.display = 'flex';
        boardOuter.style.display = 'flex';

        buildBoard();
        renderDice(1);
        refreshAllTokens();
        syncRollBtn();
        syncTurnTag();
        renderPlayerList();

        const first = players.find(p => p.id === msg.turnId);
        const firstIsMe = msg.turnId === myId;
        statusEl.textContent = firstIsMe
          ? 'You go first — roll the dice!'
          : (first?.name || 'Opponent') + ' goes first…';
        chat('system', '', '🎲 Game started! Good luck!');
        break;
      }

      // ── Roll result ─────────────────────────────────────────────
      case 'sl-rolled': {
        const { playerId, playerName, dice, from, landedOn, finalPos, event, overshoot, nextTurnId, winner, positions: newPos } = msg;

        // Show dice animation then resolve
        animateDice(dice).then(async () => {
          const who = playerId === myId ? 'You' : esc(playerName);

          if (overshoot) {
            chat('system', '', `${who} rolled ${dice} — overshoot! Stays at ${from}.`);
          } else if (event === 'snake') {
            chat('system', '', `${who} rolled ${dice} 🐍 Snake! ${landedOn} → ${finalPos}`);
          } else if (event === 'ladder') {
            chat('system', '', `${who} rolled ${dice} 🪜 Ladder! ${landedOn} → ${finalPos}`);
          } else {
            chat('system', '', `${who} rolled ${dice} → square ${finalPos}.`);
          }

          // Animate token movement
          await animateMove(playerId, from, landedOn, finalPos, event);

          // Sync authoritative positions from server
          Object.assign(positions, newPos);
          refreshAllTokens();
          renderPlayerList();

          currentTurnId = nextTurnId;

          if (winner) {
            gameActive = false;
            const isMe = winner.id === myId;
            resultEmoji.textContent = isMe ? '🥳' : '😔';
            resultTitle.textContent = isMe ? 'You Win!' : esc(winner.name) + ' Wins!';
            resultSub.textContent   = isMe
              ? 'You reached square 100 first! 🏆'
              : esc(winner.name) + ' reached square 100 first.';
            resultOverlay.style.display = 'flex';
            if (isMe) { launchConfetti(); reportScore('snakesladders', 1); }
          } else {
            syncRollBtn();
            syncTurnTag();
            const nextPlayer = players.find(p => p.id === nextTurnId);
            statusEl.textContent = nextTurnId === myId
              ? 'Your turn — roll the dice!'
              : (nextPlayer?.name || 'Opponent') + "'s turn…";
            renderPlayerList();
          }
        });
        break;
      }

      // ── Player disconnected mid-game ────────────────────────────
      case 'sl-player-left': {
        const leftToken = $('tok-' + msg.id);
        if (leftToken) leftToken.remove();
        players = players.filter(p => p.id !== msg.id);
        delete positions[msg.id];
        lobby.delete(msg.id);
        currentTurnId = msg.nextTurnId;
        syncRollBtn();
        syncTurnTag();
        renderPlayerList();
        chat('system', '', 'A player disconnected. Turn advanced.');
        break;
      }

      // ── Game aborted (too few players) ──────────────────────────
      case 'sl-aborted':
        gameActive = false;
        diceArea.style.display = 'none';
        boardOuter.style.display = 'none';
        controls.style.display = '';
        statusEl.textContent = 'Game aborted — ' + (msg.reason || 'not enough players');
        chat('system', '', '⚠ Game aborted.');
        renderPlayerList();
        break;

      case 'chat':
        chat(msg.id === myId ? 'me' : 'other', msg.name, msg.text);
        break;

      case 'error':
        statusEl.textContent = msg.msg;
        break;
    }
  }

  // ── Event listeners ──────────────────────────────────────────────
  btnStartGame.addEventListener('click', () => wsSend({ type: 'sl-start' }));

  btnRoll.addEventListener('click', () => {
    if (!gameActive || currentTurnId !== myId || animating) return;
    btnRoll.disabled = true;
    wsSend({ type: 'sl-roll' });
  });

  btnBack.addEventListener('click', () => {
    wsSend({ type: 'leave-room' });
    location.href = '/';
  });

  $('btnPlayAgain').addEventListener('click', () => {
    // Reset client to pre-game state — server still holds the room
    resultOverlay.style.display = 'none';
    gameActive = false; players = []; positions = {};
    currentTurnId = null; animating = false;
    tokenLayer.innerHTML = '';
    boardGrid.innerHTML = '';
    boardSvg.innerHTML = '';
    diceArea.style.display = 'none';
    boardOuter.style.display = 'none';
    controls.style.display = '';
    statusEl.textContent = 'Press Start Game when everyone is ready.';
    renderPlayerList();
  });

  chatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    e.stopPropagation();
  });

  // Mobile panel toggles
  const sidebar = $('sidebar'), chatPanel = $('chatPanel'), backdrop = $('panelBackdrop');
  $('btnToggleSidebar').addEventListener('click', () => {
    sidebar.classList.toggle('open');
    chatPanel.classList.remove('open');
    backdrop.classList.toggle('show', sidebar.classList.contains('open'));
  });
  $('btnToggleChat').addEventListener('click', () => {
    chatPanel.classList.toggle('open');
    sidebar.classList.remove('open');
    backdrop.classList.toggle('show', chatPanel.classList.contains('open'));
  });
  backdrop.addEventListener('click', () => {
    sidebar.classList.remove('open');
    chatPanel.classList.remove('open');
    backdrop.classList.remove('show');
  });

  // Rules panel
  const rulesPanel = $('rulesPanel');
  $('btnRules').addEventListener('click', () => { rulesPanel.style.display = 'flex'; });
  $('rulesClose').addEventListener('click', () => { rulesPanel.style.display = 'none'; });
  rulesPanel.addEventListener('click', e => { if (e.target === rulesPanel) rulesPanel.style.display = 'none'; });

  // ── Init ─────────────────────────────────────────────────────────
  connect();
})();

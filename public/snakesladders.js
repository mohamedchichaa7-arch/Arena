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

  const STEP_MS = 150; // delay per square during step-by-step animation

  // ── 3D Dice constants ────────────────────────────────────────────
  // Physical face layout:
  //   face-1 (front, die:1)  face-2 (back, die:6)
  //   face-3 (right, die:3)  face-4 (left, die:4)
  //   face-5 (top,  die:2)   face-6 (bottom, die:5)
  // Cube rotations (rx,ry) to bring each die value to face the camera
  const FACE_ANGLES = {
    1: { rx: -15, ry:  20  },
    2: { rx:  78, ry:  15  },
    3: { rx: -12, ry: -78  },
    4: { rx: -12, ry:  78  },
    5: { rx: -78, ry:  15  },
    6: { rx: -15, ry: 200  },
  };

  // Pip center positions [x%, y%] for each physical face
  const PIP_POSITIONS = [
    null,                                                           // index 0 unused
    [[50, 50]],                                                     // face-1: 1 pip  (die 1)
    [[28,22],[72,22],[28,50],[72,50],[28,78],[72,78]],               // face-2: 6 pips (die 6)
    [[28,28],[50,50],[72,72]],                                       // face-3: 3 pips (die 3)
    [[28,28],[72,28],[28,72],[72,72]],                               // face-4: 4 pips (die 4)
    [[28,28],[72,72]],                                              // face-5: 2 pips (die 2)
    [[28,25],[72,25],[50,50],[28,75],[72,75]],                       // face-6: 5 pips (die 5)
  ];

  const DICE_SKINS = [
    { id: 'dark',    label: 'Dark'    },
    { id: 'classic', label: 'Classic' },
    { id: 'neon',    label: 'Neon'    },
    { id: 'fire',    label: 'Fire'    },
    { id: 'ice',     label: 'Ice'     },
    { id: 'gold',    label: 'Gold'    },
  ];

  // ── Twist die constants ──────────────────────────────────────────
  const TWIST_META = {
    blank:      { emoji: '—',  label: 'No Twist',    desc: 'Nothing happens.',                      color: '#6b7280' },
    swap:       { emoji: '🔁', label: 'Swap!',        desc: 'Choose a player to swap positions with.', color: '#0ea5e9' },
    shield:     { emoji: '🛡️', label: 'Shield!',      desc: 'Snake-proof for your next 2 turns.',     color: '#22c55e' },
    bomb:       { emoji: '💣', label: 'Bomb!',        desc: 'Choose a player to send back 10 squares.', color: '#ef4444' },
    doubleroll: { emoji: '🎲', label: 'Double Roll!', desc: 'Your movement dice was rolled twice!',    color: '#f59e0b' },
    chaos:      { emoji: '🔀', label: 'Chaos!',       desc: "Everyone's positions rotate clockwise.", color: '#a78bfa' },
    freemove:   { emoji: '⭐', label: 'Free Move!',   desc: 'Jump to any square within ±5 of here.',  color: '#06b6d4' },
  };

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
  const diceCube       = $('diceCube');
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
  // Twist system DOM refs
  const twistDiceInner = $('twistDiceInner');
  const twistDiceBack  = $('twistDiceBack');
  const twistOverlay   = $('twistOverlay');
  const twistOvEmoji   = $('twistOvEmoji');
  const twistOvName    = $('twistOvName');
  const twistOvDesc    = $('twistOvDesc');
  const targetOverlay  = $('targetOverlay');
  const targetTitle    = $('targetTitle');
  const targetSubtitle = $('targetSubtitle');
  const targetOptions  = $('targetOptions');
  const targetCountdown= $('targetCountdown');
  const btnSkipTwist   = $('btnSkipTwist');
  const eventLog       = $('eventLog');
  const eventLogList   = $('eventLogList');
  // Free move bar refs
  const freeMoveBar       = $('freeMoveBar');
  const freeMoveCountdown = $('freeMoveCountdown');
  const btnFreeMoveSkip   = $('btnFreeMoveSkip');

  roomBadge.textContent = 'Room ' + roomId;

  // ── State ────────────────────────────────────────────────────────
  let ws = null, myId = null;
  let players      = [];  // [{ id, name, colorIdx }]  ordered by turn
  let positions    = {};  // { [id]: squareNumber }  0 = off-board
  let shields      = {};  // { [id]: turnsRemaining }
  let currentTurnId = null;
  let gameActive   = false;
  let animating    = false;
  let lobby        = new Map(); // id → name (everyone in room)

  // Twist die flip state
  let twistCardRy  = 0;   // cumulative Y-rotation of the flip card
  let freeMoveCancel = null; // set while board free-move is active

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

  // ── 3D Dice ───────────────────────────────────────────────────────
  let diceRx = -15, diceRy = 20;   // current cube rotation (deg)
  let currentSkin = 'dark';

  function buildDice() {
    for (let f = 1; f <= 6; f++) {
      const faceEl = $('diceFace' + f);
      if (!faceEl) continue;
      faceEl.innerHTML = '';
      for (const [x, y] of PIP_POSITIONS[f]) {
        const pip = document.createElement('div');
        pip.className = 'pip';
        pip.style.left = x + '%';
        pip.style.top  = y + '%';
        faceEl.appendChild(pip);
      }
    }
    // Set initial resting angle
    setDiceRotation(FACE_ANGLES[1].rx, FACE_ANGLES[1].ry, false);
  }

  function buildSkinPicker() {
    const pickerEl = $('skinPicker');
    if (!pickerEl) return;
    pickerEl.innerHTML = '';
    for (const sk of DICE_SKINS) {
      const btn = document.createElement('button');
      btn.className = `skin-btn sb-${sk.id}` + (sk.id === currentSkin ? ' active' : '');
      btn.title = sk.label;
      btn.type = 'button';
      btn.addEventListener('click', () => {
        currentSkin = sk.id;
        diceCube.className = `dice-cube skin-${sk.id}`;
        pickerEl.querySelectorAll('.skin-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
      });
      pickerEl.appendChild(btn);
    }
  }

  function setDiceRotation(rx, ry, animate) {
    diceCube.style.transition = animate
      ? 'transform .55s cubic-bezier(.2,.82,.2,1)'
      : 'none';
    diceCube.style.transform = `rotateX(${rx}deg) rotateY(${ry}deg)`;
    diceRx = rx;
    diceRy = ry;
  }

  // Shortest-path angle adjustment (keeps cumulative rotation valid)
  function adjustAngle(current, target) {
    let delta = ((target - current) % 360 + 360) % 360;
    if (delta > 180) delta -= 360;
    return current + delta;
  }

  async function animateDice(finalFace) {
    // Phase 1: smooth tumbling — each step transitions over 92ms
    diceCube.style.transition = 'transform 92ms ease-in-out';
    for (let i = 0; i < 10; i++) {
      diceRx += (Math.random() < .5 ? 1 : -1) * (82 + Math.random() * 64);
      diceRy += (Math.random() < .5 ? 1 : -1) * (82 + Math.random() * 64);
      diceCube.style.transform = `rotateX(${diceRx}deg) rotateY(${diceRy}deg)`;
      await sleep(98);
    }
    // Phase 2: smooth settle to target face
    const target = FACE_ANGLES[finalFace];
    const rx = adjustAngle(diceRx, target.rx);
    const ry = adjustAngle(diceRy, target.ry);
    diceCube.style.transition = 'transform .58s cubic-bezier(.2,.82,.2,1)';
    diceCube.style.transform  = `rotateX(${rx}deg) rotateY(${ry}deg)`;
    diceRx = rx; diceRy = ry;
    await sleep(600);
  }

  // ── Twist die (flip card) ────────────────────────────────────────
  // Reset flip card to show "?" front face
  function resetTwistCard() {
    twistDiceInner.style.transition = 'none';
    const base = Math.ceil(twistCardRy / 360) * 360;
    twistCardRy = base;
    twistDiceInner.style.transform = `rotateY(${base}deg)`;
  }

  async function animateTwistCard(twistName) {
    const meta = TWIST_META[twistName] || TWIST_META.blank;
    // Prepare back face content
    twistDiceBack.className = 'twist-die-back tw-' + twistName;
    twistDiceBack.innerHTML =
      `<span class="tw-emoji">${meta.emoji}</span>` +
      `<span class="tw-text">${meta.label}</span>`;

    // Smooth spinning phase — each step transitions over 92ms
    twistDiceInner.style.transition = 'transform 92ms ease-in-out';
    for (let i = 0; i < 10; i++) {
      twistCardRy += 90 + Math.random() * 72;
      twistDiceInner.style.transform = `rotateY(${twistCardRy}deg)`;
      await sleep(98);
    }
    // Settle on back face (nearest multiple of 360 + 180)
    const base   = Math.ceil(twistCardRy / 360) * 360;
    const target = base + 180;
    twistDiceInner.style.transition = 'transform .65s cubic-bezier(.2,.82,.2,1)';
    twistCardRy = target;
    twistDiceInner.style.transform = `rotateY(${target}deg)`;
    await sleep(700);
  }

  // ── Twist announcement overlay ───────────────────────────────────
  function showTwistOverlay(twistName) {
    const meta = TWIST_META[twistName] || TWIST_META.blank;
    twistOvEmoji.textContent = meta.emoji;
    twistOvName.textContent  = meta.label;
    twistOvDesc.textContent  = meta.desc;
    twistOvName.style.color  = meta.color || '#fff';
    twistOverlay.style.display = 'flex';
    return sleep(1600);
  }

  function hideTwistOverlay() {
    twistOverlay.style.display = 'none';
  }

  // ── Target selection UI (swap / bomb only) ──────────────────────
  // Returns a Promise that resolves with { targetId } or null on skip/timeout
  function showTargetUI(twist, validTargets) {
    return new Promise(resolve => {
      const meta = TWIST_META[twist];
      targetTitle.textContent = meta.emoji + ' ' + meta.label;

      let countdownSec = 15;
      targetCountdown.textContent = countdownSec;
      targetCountdown.classList.remove('urgent');

      let resolved = false;
      let interval = null;

      function done(choice) {
        if (resolved) return;
        resolved = true;
        clearInterval(interval);
        targetOverlay.style.display = 'none';
        resolve(choice);
      }

      // Countdown
      interval = setInterval(() => {
        countdownSec--;
        targetCountdown.textContent = countdownSec;
        if (countdownSec <= 5) targetCountdown.classList.add('urgent');
        if (countdownSec <= 0) done(null);
      }, 1000);

      targetSubtitle.textContent = twist === 'swap'
        ? 'Choose a player to swap positions with:'
        : 'Choose a player to send back 10 squares:';

      targetOptions.innerHTML = '';
      for (const tid of validTargets) {
        const p = players.find(x => x.id === tid);
        if (!p) continue;
        const sq  = positions[tid] || 0;
        const btn = document.createElement('button');
        btn.className = 'target-btn';
        btn.style.borderColor = PLAYER_COLORS[p.colorIdx] || '#aaa';
        btn.innerHTML = `<span style="color:${PLAYER_COLORS[p.colorIdx]||'#aaa'}">${esc(p.name)}</span> <small style="color:var(--dim)">(sq ${sq})</small>`;
        btn.addEventListener('click', () => done({ targetId: tid }));
        targetOptions.appendChild(btn);
      }

      btnSkipTwist.onclick = () => done(null);
      targetOverlay.style.display = 'flex';
    });
  }

  // ── Free Move board interaction ──────────────────────────────────
  // Highlights valid squares on the board; player clicks one to choose.
  // Returns a Promise resolving to { square } or null on skip/timeout.
  function showFreeMoveOnBoard(validTargets) {
    return new Promise(resolve => {
      let countdown  = 15;
      freeMoveCountdown.textContent = countdown;
      freeMoveCountdown.classList.remove('urgent');
      freeMoveBar.style.display = 'flex';

      let resolved = false;
      let interval = null;
      const ac = new AbortController();

      function done(choice) {
        if (resolved) return;
        resolved = true;
        clearInterval(interval);
        ac.abort();
        document.querySelectorAll('.board-cell.freemove-target')
          .forEach(el => el.classList.remove('freemove-target'));
        freeMoveBar.style.display = 'none';
        freeMoveCancel = null;
        resolve(choice);
      }

      // Store a cancel hook for external callers (disconnect, abort)
      freeMoveCancel = () => done(null);

      interval = setInterval(() => {
        countdown--;
        freeMoveCountdown.textContent = countdown;
        if (countdown <= 5) freeMoveCountdown.classList.add('urgent');
        if (countdown <= 0) done(null);
      }, 1000);

      for (const sq of validTargets) {
        const cellEl = $('sq' + sq);
        if (!cellEl) continue;
        cellEl.classList.add('freemove-target');
        cellEl.addEventListener('click', () => done({ square: sq }), { signal: ac.signal });
      }

      btnFreeMoveSkip.onclick = () => done(null);
    });
  }

  // ── Event log ────────────────────────────────────────────────────
  const MAX_EVENTS = 8;
  function addEvent(text) {
    eventLog.style.display = '';
    const item = document.createElement('div');
    item.className = 'evl-item';
    item.textContent = text;
    eventLogList.prepend(item);
    // Trim to max
    while (eventLogList.children.length > MAX_EVENTS)
      eventLogList.removeChild(eventLogList.lastChild);
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
        const sh = shields[p.id] || 0;
        const shBadge = sh > 0
          ? `<span class="shield-badge">🛡️${sh}</span>`
          : '';
        card.innerHTML = `
          <span class="pc-dot" style="background:${color}"></span>
          <span class="pc-name">${esc(p.name)}${p.id === myId ? ' (you)' : ''}${shBadge}</span>
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
        shields       = Object.assign({}, msg.shields || {});
        currentTurnId = msg.turnId;
        gameActive    = true;

        controls.style.display = 'none';
        diceArea.style.display = 'flex';
        boardOuter.style.display = 'flex';

        // Reset dice visuals
        buildBoard();
        setDiceRotation(FACE_ANGLES[1].rx, FACE_ANGLES[1].ry, false);
        resetTwistCard();
        refreshAllTokens();
        syncRollBtn();
        syncTurnTag();
        renderPlayerList();

        eventLogList.innerHTML = '';
        eventLog.style.display = 'none';

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
        const {
          playerId, playerName, moveDice, moveDice2, twist,
          from, landedOn, finalPos, event, overshoot,
          positions: newPos, shields: newShields,
          validTargets, awaitingTwist, nextTurnId, winner, chaosPositions,
        } = msg;

        const who = playerId === myId ? 'You' : esc(playerName);

        // Animate both dice simultaneously, then handle movement + twist
        Promise.all([
          animateDice(moveDice),
          animateTwistCard(twist),
        ]).then(async () => {
          // ── Movement result ──
          if (overshoot) {
            chat('system', '', `${who} rolled ${moveDice}${moveDice2 ? '+'+moveDice2 : ''} — overshoot! Stays at ${from}.`);
            addEvent(`🎲 ${playerName}: rolled ${moveDice}${moveDice2?'+'+moveDice2:''}, overshoot (sq ${from})`);
          } else if (event === 'shield-block') {
            chat('system', '', `${who} rolled ${moveDice}${moveDice2 ? '+'+moveDice2 : ''} 🛡️ Shield blocked a snake at ${landedOn}!`);
            addEvent(`🛡️ ${playerName}: shield blocked snake at sq ${landedOn}!`);
          } else if (event === 'snake') {
            chat('system', '', `${who} rolled ${moveDice}${moveDice2 ? '+'+moveDice2 : ''} 🐍 Snake! ${landedOn} → ${finalPos}`);
            addEvent(`🐍 ${playerName}: snake ${landedOn}→${finalPos}`);
          } else if (event === 'ladder') {
            chat('system', '', `${who} rolled ${moveDice}${moveDice2 ? '+'+moveDice2 : ''} 🪜 Ladder! ${landedOn} → ${finalPos}`);
            addEvent(`🪜 ${playerName}: ladder ${landedOn}→${finalPos}`);
          } else {
            chat('system', '', `${who} rolled ${moveDice}${moveDice2 ? '+'+moveDice2 : ''} → sq ${finalPos}.`);
            addEvent(`🎲 ${playerName}: rolled ${moveDice}${moveDice2?'+'+moveDice2:''} → sq ${finalPos}`);
          }

          // Animate token movement
          if (!overshoot) {
            await animateMove(playerId, from, landedOn, finalPos, event);
          }

          // Sync positions + shields
          Object.assign(positions, newPos);
          shields = Object.assign({}, newShields);
          refreshAllTokens();
          renderPlayerList();

          // ── Twist handling ──
          if (twist !== 'blank') {
            const meta = TWIST_META[twist] || TWIST_META.blank;

            // Instant-effect twists handled before overlay for chaos (all tokens move)
            if (twist === 'chaos' && chaosPositions) {
              await showTwistOverlay(twist);
              hideTwistOverlay();
              // Animate everyone moving at once
              const moveProms = players.map(p => {
                const newSq = chaosPositions[p.id] || 0;
                const oldSq = positions[p.id] || 0;
                if (newSq === oldSq) return Promise.resolve();
                const tok = getOrCreateToken(p.id);
                positions[p.id] = newSq;
                placeToken(p.id, newSq, 0);
                return sleep(500);
              });
              await Promise.all(moveProms);
              refreshAllTokens();
              renderPlayerList();
              addEvent(`🔀 ${playerName}: Chaos! Everyone rotated`);
              chat('system', '', `${who} triggered 🔀 Chaos — all positions rotated!`);
            } else if (twist === 'shield') {
              await showTwistOverlay(twist);
              hideTwistOverlay();
              addEvent(`🛡️ ${playerName}: gained Shield (2 turns)`);
              chat('system', '', `${who} gained 🛡️ Shield — snake-proof for 2 turns!`);
              renderPlayerList();
            } else if (twist === 'doubleroll') {
              await showTwistOverlay(twist);
              hideTwistOverlay();
              addEvent(`🎲 ${playerName}: Double Roll! +${moveDice2} total ${moveDice}+${moveDice2}`);
              chat('system', '', `${who} triggered 🎲 Double Roll (${moveDice}+${moveDice2}=${moveDice+moveDice2})!`);
            } else if (awaitingTwist && playerId === myId) {
              // Show announcement then targeting UI
              await showTwistOverlay(twist);
              hideTwistOverlay();
              addEvent(`${meta.emoji} ${playerName}: ${meta.label} — choosing target…`);

              let choice;
              if (twist === 'freemove') {
                choice = await showFreeMoveOnBoard(validTargets);
              } else {
                choice = await showTargetUI(twist, validTargets);
              }

              if (choice) {
                wsSend({ type: 'sl-twist-choice', ...choice });
              } else {
                // Skip / timed-out locally — server will also time out
                wsSend({ type: 'sl-twist-choice', skip: true });
              }
              return; // wait for sl-twist-resolved
            } else if (awaitingTwist && playerId !== myId) {
              // Another player is choosing — show announcement and wait
              await showTwistOverlay(twist);
              hideTwistOverlay();
              addEvent(`${meta.emoji} ${playerName}: ${meta.label} — choosing target…`);
              statusEl.textContent = esc(playerName) + ' is choosing a target…';
              return; // wait for sl-twist-resolved
            } else if (twist !== 'blank') {
              // Non-targeting instant twist already applied (shield / doubleroll handled above)
              // or targeting twist with no valid targets (falls through as blank)
            }
          }

          // ── Wrap-up (also reached after non-awaitingTwist) ──
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
            resetTwistCard();
            const nextPlayer = players.find(p => p.id === nextTurnId);
            statusEl.textContent = nextTurnId === myId
              ? 'Your turn — roll the dice!'
              : (nextPlayer?.name || 'Opponent') + "'s turn…";
            renderPlayerList();
          }
        });
        break;
      }

      // ── Twist resolved (after choice or timeout) ────────────────
      case 'sl-twist-resolved': {
        const { playerId, playerName, timedOut, twistDetail, positions: newPos, shields: newShields, nextTurnId, winner } = msg;

        // Apply position changes
        Object.assign(positions, newPos);
        shields = Object.assign({}, newShields);

        (async () => {
          const who  = playerId === myId ? 'You' : esc(playerName);
          const meta = TWIST_META[twistDetail?.twist] || TWIST_META.blank;

          if (timedOut) {
            addEvent(`⏱ ${playerName}: ${meta.emoji || ''} twist timed out — skipped`);
            chat('system', '', `${who} ran out of time — twist skipped.`);
          } else {
            const { twist, targetId, targetName, myNewPos, theirNewPos, from: bFrom, to: bTo, square } = twistDetail || {};
            if (twist === 'swap') {
              getOrCreateToken(playerId);
              if (targetId) getOrCreateToken(targetId);
              placeToken(playerId, myNewPos || 0, 0);
              if (targetId) placeToken(targetId, theirNewPos || 0, 0);
              await sleep(500);
              addEvent(`🔁 ${playerName}: swapped with ${targetName} (sq ${myNewPos}↔${theirNewPos})`);
              chat('system', '', `${who} swapped with ${esc(targetName)}!`);
            } else if (twist === 'bomb') {
              if (targetId) {
                placeToken(targetId, bTo, 0);
                await sleep(300);
              }
              addEvent(`💣 ${playerName}: bombed ${targetName} ${bFrom}→${bTo}`);
              chat('system', '', `${who} 💣 bombed ${esc(targetName)} back to sq ${bTo}!`);
            } else if (twist === 'freemove') {
              placeToken(playerId, square, 0);
              await sleep(300);
              addEvent(`⭐ ${playerName}: free-moved to sq ${square}`);
              chat('system', '', `${who} ⭐ moved to square ${square}!`);
            }
          }

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
            resetTwistCard();
            const nextPlayer = players.find(p => p.id === nextTurnId);
            statusEl.textContent = nextTurnId === myId
              ? 'Your turn — roll the dice!'
              : (nextPlayer?.name || 'Opponent') + "'s turn…";
            renderPlayerList();
          }
        })();
        break;
      }

      // ── Player disconnected mid-game ────────────────────────────
      case 'sl-player-left': {
        const leftToken = $('tok-' + msg.id);
        if (leftToken) leftToken.remove();
        players = players.filter(p => p.id !== msg.id);
        delete positions[msg.id];
        delete shields[msg.id];
        lobby.delete(msg.id);
        currentTurnId = msg.nextTurnId;
        syncRollBtn();
        syncTurnTag();
        renderPlayerList();
        chat('system', '', 'A player disconnected. Turn advanced.');
        // Close any open targeting UI (skip choice)
        targetOverlay.style.display = 'none';
        hideTwistOverlay();
        if (freeMoveCancel) freeMoveCancel();
        break;
      }

      // ── Game aborted (too few players) ──────────────────────────
      case 'sl-aborted':
        gameActive = false;
        targetOverlay.style.display = 'none';
        hideTwistOverlay();
        if (freeMoveCancel) freeMoveCancel();
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
    targetOverlay.style.display = 'none';
    hideTwistOverlay();
    if (freeMoveCancel) freeMoveCancel();
    gameActive = false; players = []; positions = {}; shields = {};
    currentTurnId = null; animating = false;
    tokenLayer.innerHTML = '';
    boardGrid.innerHTML = '';
    boardSvg.innerHTML = '';
    eventLogList.innerHTML = '';
    eventLog.style.display = 'none';
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
  buildDice();
  buildSkinPicker();
  connect();
})();

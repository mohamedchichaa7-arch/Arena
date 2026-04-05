/* global requestAnimationFrame */
(() => {
  'use strict';

  // ── Table geometry (internal canvas units) ─────────────────────────────
  const RAIL = 54;       // rail (wood border) width in px
  const CW   = 900;      // cloth width
  const CH   = 450;      // cloth height
  const CVW  = CW + 2 * RAIL;   // total canvas width  = 1008
  const CVH  = CH + 2 * RAIL;   // total canvas height = 558
  const CX   = RAIL;     // cloth left in canvas
  const CY   = RAIL;     // cloth top in canvas

  // ── Ball physics constants ──────────────────────────────────────────────
  const BR          = 13;      // ball radius
  const BD          = BR * 2;  // ball diameter
  const FRICTION    = 0.982;   // speed multiplier per frame (rolling friction)
  const MIN_SPD     = 0.10;    // stop threshold
  const CUSHION_R   = 0.72;    // cushion restitution
  const BALL_REST   = 0.965;   // ball-ball restitution
  const MAX_SPD     = 24;      // max shot speed
  const MAX_AIM_D   = 210;     // mouse dist → full power
  const SUB         = 6;       // physics sub-steps per frame
  const HEAD_STRING = CX + CW * 0.26;  // break line x
  const RACK_CX     = CX + Math.round(CW * 0.745); // rack centre x

  // ── Pocket positions (canvas coords) ───────────────────────────────────
  const PO  = 19;  // offset from cloth corner
  const CP_C = 21; // corner pocket capture radius
  const CP_M = 23; // side pocket capture radius

  const POCKETS = [
    { x: CX + PO,      y: CY + PO,      r: CP_C }, // TL
    { x: CX + CW - PO, y: CY + PO,      r: CP_C }, // TR
    { x: CX + CW / 2,  y: CY,           r: CP_M }, // TM — long-rail side pocket
    { x: CX + CW / 2,  y: CY + CH,      r: CP_M }, // BM — long-rail side pocket
    { x: CX + PO,      y: CY + CH - PO, r: CP_C }, // BL
    { x: CX + CW - PO, y: CY + CH - PO, r: CP_C }, // BR
  ];

  // ── Ball colours ────────────────────────────────────────────────────────
  const BALL_COL = [
    '#f0ede6', // 0  cue
    '#f4d03f', // 1  yellow
    '#2980b9', // 2  blue
    '#e74c3c', // 3  red
    '#8e44ad', // 4  purple
    '#e67e22', // 5  orange
    '#27ae60', // 6  green
    '#7d572e', // 7  maroon
    '#111111', // 8  black
    '#f4d03f', // 9  yellow stripe
    '#2980b9', // 10 blue stripe
    '#e74c3c', // 11 red stripe
    '#8e44ad', // 12 purple stripe
    '#e67e22', // 13 orange stripe
    '#27ae60', // 14 green stripe
    '#7d572e', // 15 maroon stripe
  ];

  // ── Ball tracker UI ─────────────────────────────────────────────────────
  function makeTball(id, dimmed) {
    const col = BALL_COL[id] || '#aaa';
    const isStripe = id >= 9;
    const isEight  = id === 8;

    const div = document.createElement('div');
    div.className = 'tball' + (isStripe ? ' striped' : '') + (dimmed ? ' pocketed-ball' : '') + (isEight ? ' eight-ball' : '');

    if (!isEight) {
      if (isStripe) {
        // White base ball with a colored stripe band via CSS custom property
        div.style.setProperty('--spc', col);
      } else {
        div.style.background = `radial-gradient(circle at 35% 35%, ${lighten(col, 50)}, ${col} 60%, ${darken(col, 30)})`;
      }
    }
    div.style.border = `1.5px solid ${isEight ? 'rgba(255,255,255,.38)' : 'rgba(255,255,255,.22)'}`;

    // Number badge — always a white circle with dark number, readable on any background
    const badge = document.createElement('span');
    badge.className = 'tball-badge';
    badge.textContent = String(id);
    div.appendChild(badge);
    div.title = `Ball ${id}`;
    return div;
  }

  function updateTrackerUI() {
    const p1Name = $('trackerNameP1');
    const p2Name = $('trackerNameP2');
    const t1 = $('trackerP1');
    const t2 = $('trackerP2');

    if (!t1 || !t2) return;

    // In practice or single-player modes, hide P2 tracker
    const isSolo = (gameMode === 'practice');
    t2.style.display = isSolo ? 'none' : '';

    // Update names
    const n1 = players[0] || 'Player 1';
    const n2 = (vsMode === 'ai') ? 'AI' : (players[1] || 'Player 2');
    if (p1Name) p1Name.textContent = n1;
    if (p2Name) p2Name.textContent = n2;

    // Turn indicator arrow
    const arrow1 = t1.querySelector('.tracker-turn-arrow');
    const arrow2 = t2.querySelector('.tracker-turn-arrow');
    if (arrow1) arrow1.style.visibility = (turn === 0 && gamePhase !== 'over') ? 'visible' : 'hidden';
    if (arrow2) arrow2.style.visibility = (turn === 1 && gamePhase !== 'over') ? 'visible' : 'hidden';

    // Scores
    const s1 = $('scoreP1');
    const s2 = $('scoreP2');
    if (s1) s1.textContent = `Wins: ${scores[0]}`;
    if (s2) s2.textContent = `Wins: ${scores[1]}`;

    // Determine each player's ball set
    for (let p = 0; p < 2; p++) {
      const pocketedEl  = $(p === 0 ? 'pocketedP1' : 'pocketedP2');
      const remainingEl = $(p === 0 ? 'remainingP1' : 'remainingP2');
      if (!pocketedEl || !remainingEl) continue;

      pocketedEl.innerHTML  = '';
      remainingEl.innerHTML = '';

      if (gameMode === 'practice') continue;

      if (gameMode === '8ball') {
        const grp = playerGroup[p];
        if (!grp) {
          // Groups not assigned yet — show what they've pocketed so far
          const myIds = pocketedByPlayer[p].filter(id => id !== 8);
          if (myIds.length === 0) {
            const hint = document.createElement('span');
            hint.style.cssText = 'font-size:6px;color:#94a3b8;line-height:1.3;';
            hint.textContent = 'First pocket\nassigns group';
            pocketedEl.appendChild(hint);
          }
          myIds.forEach(id => pocketedEl.appendChild(makeTball(id, true)));
          remainingEl.innerHTML = '<span style="font-size:6px;color:#94a3b8;">TBD</span>';
        } else {
          const myNums = grp === 'solid' ? [1,2,3,4,5,6,7] : [9,10,11,12,13,14,15];
          const pocketed  = myNums.filter(id => !balls.some(b => b.id === id && b.active));
          const remaining = myNums.filter(id => balls.some(b => b.id === id && b.active));

          pocketed.forEach(id  => pocketedEl.appendChild(makeTball(id, true)));
          remaining.forEach(id => remainingEl.appendChild(makeTball(id, false)));

          // Show 8-ball status
          if (eightLegal[p]) {
            remainingEl.appendChild(makeTball(8, false));
          }
        }
      } else if (gameMode === '9ball') {
        // In 9-ball, both players share all balls; show who's pocketed what
        const myPocketed = pocketedByPlayer[p];
        myPocketed.forEach(id => pocketedEl.appendChild(makeTball(id, true)));

        // Remaining = all active balls 1-9 not yet pocketed by anyone
        const remaining = balls.filter(b => b.active && b.id >= 1 && b.id <= 9).map(b => b.id).sort((a,b)=>a-b);
        remaining.forEach(id => remainingEl.appendChild(makeTball(id, false)));
      }
    }
  }

  // ── Utilities ───────────────────────────────────────────────────────────
  const $    = id => document.getElementById(id);
  const clamp = (v, lo, hi) => v < lo ? lo : v > hi ? hi : v;
  const dist2 = (ax, ay, bx, by) => (ax - bx) ** 2 + (ay - by) ** 2;
  const hypot = (ax, ay, bx, by) => Math.sqrt(dist2(ax, ay, bx, by));

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  function lighten(hex, amt) {
    const n = parseInt(hex.replace('#', ''), 16);
    const r = clamp((n >> 16) + amt, 0, 255);
    const g = clamp(((n >> 8) & 0xff) + amt, 0, 255);
    const b = clamp((n & 0xff) + amt, 0, 255);
    return `rgb(${r},${g},${b})`;
  }
  function darken(hex, amt) { return lighten(hex, -amt); }

  // ── State ───────────────────────────────────────────────────────────────
  let canvas, ctx, dpr;
  let balls = [];
  let gameMode = null;     // 'practice' | '8ball' | '9ball'
  let vsMode   = null;     // 'human' | 'ai'
  let gamePhase = 'menu';  // 'menu' | 'aiming' | 'placing' | 'rolling' | 'over'
  let turn  = 0;
  let scores = [0, 0];
  let players = ['Player 1', 'Player 2'];

  // 8-ball
  let groupAssigned = false;
  let playerGroup   = [null, null]; // 'solid' | 'stripe'
  let eightLegal    = [false, false];

  // Per-shot tracking
  let pocketedThisTurn = [];
  let cueHitValidFirst = false;
  let cueHitAnyBall    = false;

  // AI
  let aiThinking  = false;
  let aiTimerRef  = null;

  // Input
  let mouse = { x: CVW / 2, y: CVH / 2 };
  let activeSkin    = 'classic';
  let activeCueSkin = 'classic';

  // Ball tracking per player: pocketedByPlayer[p] = array of ball ids pocketed
  let pocketedByPlayer = [[], []];

  // ── Online multiplayer state ────────────────────────────────────────────
  const urlRoomId   = new URLSearchParams(location.search).get('room');
  const myName      = sessionStorage.getItem('arena-name') || 'Player';
  const myToken     = sessionStorage.getItem('arena-token') || '';
  let   onlineMode  = false;       // true when connected to a WS room
  let   ws          = null;
  let   wsMyId      = null;        // server-assigned connection id
  let   myPlayerIdx = -1;          // 0 = host/breaks, 1 = guest
  let   onlinePlayers = [];        // [{ id, name }]
  // Mouse position broadcast (sent to opponent so they see your aim)
  let   lastMouseBroadcast = 0;

  // ── Ball factory ────────────────────────────────────────────────────────
  function makeBall(id, x, y) {
    return { id, x, y, vx: 0, vy: 0, active: true };
  }
  function getCueBall() { return balls.find(b => b.id === 0 && b.active); }
  function ballsMoving() {
    return balls.some(b => b.active && (Math.abs(b.vx) > MIN_SPD || Math.abs(b.vy) > MIN_SPD));
  }

  // ── Rack positions ──────────────────────────────────────────────────────
  function trianglePositions() {
    const ry = CY + CH / 2;
    const s  = BD + 0.6;
    const h  = s * Math.sqrt(3) / 2;
    const pos = [];
    for (let row = 0; row < 5; row++) {
      for (let col = 0; col <= row; col++) {
        pos.push({ x: RACK_CX + row * h, y: ry + (col - row / 2) * s });
      }
    }
    return pos; // 15 positions, index 0 = apex, index 4 = centre row-2
  }

  function diamondPositions() {
    const ry = CY + CH / 2;
    const s  = BD + 0.6;
    const h  = s * Math.sqrt(3) / 2;
    return [
      { x: RACK_CX - 2 * h, y: ry       },  // 0 front apex  → ball 1
      { x: RACK_CX - h,     y: ry - s / 2 }, // 1
      { x: RACK_CX - h,     y: ry + s / 2 }, // 2
      { x: RACK_CX,         y: ry - s     }, // 3
      { x: RACK_CX,         y: ry         }, // 4 centre       → ball 9
      { x: RACK_CX,         y: ry + s     }, // 5
      { x: RACK_CX + h,     y: ry - s / 2 }, // 6
      { x: RACK_CX + h,     y: ry + s / 2 }, // 7
      { x: RACK_CX + 2 * h, y: ry         }, // 8 back
    ];
  }

  // ── Game initialisation ─────────────────────────────────────────────────
  function startGame8Ball() {
    balls = [makeBall(0, CX + CW * 0.27, CY + CH / 2)];
    const pos     = trianglePositions();
    const solids  = shuffle([1, 2, 3, 4, 5, 6, 7]);
    const stripes = shuffle([9, 10, 11, 12, 13, 14, 15]);
    const asgn    = new Array(15);
    // Standard 8-ball rack: apex=1(head), centre=8, back corners: 1 solid + 1 stripe
    asgn[0]  = 1;
    asgn[4]  = 8;
    asgn[10] = solids.pop();
    asgn[14] = stripes.pop();
    const rest = shuffle([...solids, ...stripes]);
    let ri = 0;
    for (let i = 0; i < 15; i++) if (asgn[i] === undefined) asgn[i] = rest[ri++];
    for (let i = 0; i < 15; i++) balls.push(makeBall(asgn[i], pos[i].x, pos[i].y));

    groupAssigned = false;
    playerGroup   = [null, null];
    eightLegal    = [false, false];
  }

  function startGame9Ball() {
    balls = [makeBall(0, CX + CW * 0.27, CY + CH / 2)];
    const pos  = diamondPositions();
    const rest = shuffle([2, 3, 4, 5, 6, 7, 8]);
    const nums = [1, rest[0], rest[1], rest[2], 9, rest[3], rest[4], rest[5], rest[6]];
    for (let i = 0; i < 9; i++) balls.push(makeBall(nums[i], pos[i].x, pos[i].y));
  }

  function startGamePractice() {
    balls = [makeBall(0, CX + CW * 0.27, CY + CH / 2)];
    const pos  = trianglePositions();
    const nums = shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);
    for (let i = 0; i < 15; i++) balls.push(makeBall(nums[i], pos[i].x, pos[i].y));
  }

  function initGame(mode, vs) {
    gameMode = mode;
    vsMode   = vs;
    turn     = 0;
    scores   = [0, 0];
    groupAssigned = false;
    playerGroup   = [null, null];
    eightLegal    = [false, false];
    pocketedThisTurn = [];
    cueHitValidFirst = false;
    cueHitAnyBall    = false;
    aiThinking = false;
    pocketedByPlayer = [[], []];
    if (aiTimerRef) clearTimeout(aiTimerRef);

    if (mode === '8ball')    startGame8Ball();
    else if (mode === '9ball') startGame9Ball();
    else                       startGamePractice();

    $('modeScreen').style.display = 'none';
    $('gameArea').style.display   = '';
    $('goOverlay').classList.remove('show');

    // Inject turn arrows into trackers if not present
    for (let p = 0; p < 2; p++) {
      const tid = p === 0 ? 'trackerP1' : 'trackerP2';
      const el  = $(tid);
      if (el && !el.querySelector('.tracker-turn-arrow')) {
        const arr = document.createElement('div');
        arr.className = 'tracker-turn-arrow';
        arr.textContent = '▶';
        el.insertBefore(arr, el.firstChild);
      }
    }

    gamePhase = 'aiming';
    turn = 0;
    updateTrackerUI();
  }

  // ── Physics ─────────────────────────────────────────────────────────────
  function stepPhysics() {
    // Rolling friction – applied once per frame
    for (const b of balls) {
      if (!b.active) continue;
      const spd = Math.hypot(b.vx, b.vy);
      if (spd < MIN_SPD) { b.vx = 0; b.vy = 0; }
      else { b.vx *= FRICTION; b.vy *= FRICTION; }
    }

    const h = 1 / SUB;
    for (let s = 0; s < SUB; s++) {
      // Advance positions fractionally
      for (const b of balls) {
        if (!b.active || (b.vx === 0 && b.vy === 0)) continue;
        b.x += b.vx * h;
        b.y += b.vy * h;
      }
      checkPockets();   // before cushions so balls near pockets don't bounce
      resolveCushions();
      resolveBallBall();
    }
  }

  function resolveCushions() {
    const lx = CX + BR + 1;
    const rx = CX + CW - BR - 1;
    const ty = CY + BR + 1;
    const by = CY + CH - BR - 1;

    for (const b of balls) {
      if (!b.active) continue;

      // Left cushion — no side pocket on short walls
      if (b.x < lx) { b.x = lx; b.vx = Math.abs(b.vx) * CUSHION_R; }
      // Right cushion
      if (b.x > rx) { b.x = rx; b.vx = -Math.abs(b.vx) * CUSHION_R; }
      // Top cushion — gap at TM side pocket
      if (b.y < ty && Math.abs(b.x - (CX + CW / 2)) > CP_M + BR) {
        b.y = ty; b.vy = Math.abs(b.vy) * CUSHION_R;
      }
      // Bottom cushion — gap at BM side pocket
      if (b.y > by && Math.abs(b.x - (CX + CW / 2)) > CP_M + BR) {
        b.y = by; b.vy = -Math.abs(b.vy) * CUSHION_R;
      }
    }
  }

  function resolveBallBall() {
    const n = balls.length;
    for (let i = 0; i < n - 1; i++) {
      const a = balls[i];
      if (!a.active) continue;
      for (let j = i + 1; j < n; j++) {
        const b = balls[j];
        if (!b.active) continue;

        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const d2 = dx * dx + dy * dy;
        if (d2 >= BD * BD || d2 === 0) continue;

        const d  = Math.sqrt(d2);
        const nx = dx / d;
        const ny = dy / d;

        // Push apart to prevent overlap
        const ov = (BD - d) * 0.5 + 0.03;
        a.x -= nx * ov; a.y -= ny * ov;
        b.x += nx * ov; b.y += ny * ov;

        // Impulse (elastic equal-mass collision with restitution)
        const dvx = b.vx - a.vx;
        const dvy = b.vy - a.vy;
        const dot = dvx * nx + dvy * ny;
        if (dot >= 0) continue; // already separating

        const imp = dot * BALL_REST;
        a.vx += imp * nx; a.vy += imp * ny;
        b.vx -= imp * nx; b.vy -= imp * ny;

        // Rule tracking: record first ball cue ball touches
        if (!cueHitAnyBall && gamePhase === 'rolling') {
          if (a.id === 0 || b.id === 0) {
            cueHitAnyBall = true;
            const other = (a.id === 0) ? b : a;
            if (isValidFirstHit(other)) cueHitValidFirst = true;
          }
        }
      }
    }
  }

  function checkPockets() {
    for (const b of balls) {
      if (!b.active) continue;
      for (const p of POCKETS) {
        if (dist2(b.x, b.y, p.x, p.y) < p.r * p.r) {
          pocketBall(b, p);
          break;
        }
      }
    }
  }

  // ── Game rules ───────────────────────────────────────────────────────────
  function isValidFirstHit(ball) {
    if (gameMode === 'practice') return true;
    if (gameMode === '9ball') {
      const low = lowestBallOnTable();
      return low !== null && ball.id === low.id;
    }
    if (gameMode === '8ball') {
      if (!groupAssigned) return ball.id !== 8;
      const grp = playerGroup[turn];
      if (eightLegal[turn]) return ball.id === 8;
      if (grp === 'solid')  return ball.id >= 1 && ball.id <= 7;
      if (grp === 'stripe') return ball.id >= 9 && ball.id <= 15;
    }
    return false;
  }

  function lowestBallOnTable() {
    let low = null;
    for (const b of balls) {
      if (b.active && b.id >= 1 && b.id <= 9) {
        if (low === null || b.id < low.id) low = b;
      }
    }
    return low;
  }

  function pocketBall(b, _pocket) {
    b.active = false;
    b.vx = 0; b.vy = 0;
    if (gamePhase !== 'rolling') return;
    pocketedThisTurn.push(b);

    if (b.id === 0) { updateTrackerUI(); return; } // cue scratch handled in endTurn

    // Track pocketed ball ownership for tracker
    // We record immediately; tracker shows per-group assignment
    pocketedByPlayer[turn].push(b.id);
    updateTrackerUI();

    if (gameMode === '8ball') {
      if (b.id === 8) {
        // Potting 8-ball ends the game immediately
        if (!groupAssigned || !eightLegal[turn]) {
          endGame(1 - turn, '8-ball pocketed too early!');
        } else {
          endGame(turn, '8-ball pocketed — victory!');
        }
      }
    } else if (gameMode === '9ball') {
      if (b.id === 9) {
        if (cueHitValidFirst) {
          endGame(turn, '9-ball pocketed — victory!');
        } else {
          // Illegal — re-spot the 9-ball
          b.active = true;
          b.x = RACK_CX;
          b.y = CY + CH / 2;
          b.vx = 0; b.vy = 0;
          pocketedThisTurn.pop();
          // Remove from tracker too
          const idx = pocketedByPlayer[turn].lastIndexOf(b.id);
          if (idx !== -1) pocketedByPlayer[turn].splice(idx, 1);
          updateTrackerUI();
        }
      }
    }
  }

  // ── Turn end logic ───────────────────────────────────────────────────────
  function endTurnProcessing() {
    if (gamePhase === 'over') return;

    const scratched = pocketedThisTurn.some(b => b.id === 0);
    const pocketed  = pocketedThisTurn.filter(b => b.id !== 0);
    const foul      = scratched || !cueHitAnyBall || !cueHitValidFirst;

    if (gameMode === 'practice') {
      if (scratched) respawnCueBall(CX + CW * 0.27, CY + CH / 2);
      resetTurnTracking();
      gamePhase = 'aiming';
      return;
    }

    if (gameMode === '8ball') {
      process8BallTurn(pocketed, scratched, foul);
    } else if (gameMode === '9ball') {
      process9BallTurn(pocketed, scratched, foul);
    }
  }

  function process8BallTurn(pocketed, scratched, foul) {
    if (gamePhase === 'over') return;

    // Assign groups on first legal pocket
    if (!groupAssigned) {
      const first = pocketed.find(b => b.id !== 8);
      if (first) {
        groupAssigned = true;
        if (first.id <= 7) {
          playerGroup[turn]     = 'solid';
          playerGroup[1 - turn] = 'stripe';
        } else {
          playerGroup[turn]     = 'stripe';
          playerGroup[1 - turn] = 'solid';
        }
      }
    }

    // Check if current player cleared their group → 8-ball now legal
    if (groupAssigned) {
      const grp    = playerGroup[turn];
      const myNums = grp === 'solid' ? [1,2,3,4,5,6,7] : [9,10,11,12,13,14,15];
      const cleared = myNums.every(id => !balls.some(b => b.id === id && b.active));
      if (cleared) eightLegal[turn] = true;
    }

    // Count valid pockets this turn
    let validPocketed = 0;
    if (groupAssigned) {
      const grp = playerGroup[turn];
      for (const b of pocketed) {
        if (grp === 'solid'  && b.id >= 1 && b.id <= 7)  validPocketed++;
        if (grp === 'stripe' && b.id >= 9 && b.id <= 15) validPocketed++;
      }
    } else {
      validPocketed = pocketed.filter(b => b.id !== 8).length;
    }

    resetTurnTracking();

    if (scratched) {
      // Scratch: cue ball was pocketed → opponent gets ball-in-hand anywhere
      turn = 1 - turn;
      beginBallInHand();
    } else if (foul) {
      // Non-scratch foul (wrong ball first / no ball hit): just switch turns,
      // cue ball stays where it is
      turn = 1 - turn;
      gamePhase = 'aiming';
      checkAI();
    } else if (validPocketed > 0) {
      // Legal pocket(s): keep turn
      gamePhase = 'aiming';
      checkAI();
    } else {
      // No pocket, no foul: switch turn
      turn = 1 - turn;
      gamePhase = 'aiming';
      checkAI();
    }
    updateTrackerUI();
  }

  function process9BallTurn(pocketed, scratched, foul) {
    if (gamePhase === 'over') return;
    resetTurnTracking();

    if (scratched) {
      // Scratch: cue ball pocketed → ball-in-hand anywhere
      turn = 1 - turn;
      beginBallInHand();
    } else if (foul) {
      // Non-scratch foul (didn't hit lowest ball): switch turn, cue stays
      turn = 1 - turn;
      gamePhase = 'aiming';
      checkAI();
    } else if (pocketed.length > 0) {
      // Legal pocket(s): keep turn
      gamePhase = 'aiming';
      checkAI();
    } else {
      // No pocket, no foul: switch turn
      turn = 1 - turn;
      gamePhase = 'aiming';
      checkAI();
    }
    updateTrackerUI();
  }

  function resetTurnTracking() {
    pocketedThisTurn = [];
    cueHitValidFirst = false;
    cueHitAnyBall    = false;
  }

  function respawnCueBall(x, y) {
    const cb = balls.find(b => b.id === 0);
    if (cb) {
      cb.active = true;
      cb.x = x; cb.y = y;
      cb.vx = 0; cb.vy = 0;
    } else {
      balls.push(makeBall(0, x, y));
    }
  }

  function beginBallInHand() {
    gamePhase = 'placing';
    // Position cue ball at a safe default (will follow mouse)
    respawnCueBall(CX + CW * 0.25, CY + CH / 2);
    updateTrackerUI();
  }

  function checkAI() {
    if (vsMode === 'ai' && turn === 1 && gamePhase === 'aiming') {
      aiThinking = true;
      if (aiTimerRef) clearTimeout(aiTimerRef);
      aiTimerRef = setTimeout(() => {
        aiThinking = false;
        doAIShot();
      }, 1500 + Math.random() * 600);
    }
  }

  function endGame(winner, reason) {
    if (gamePhase === 'over') return;
    gamePhase = 'over';
    scores[winner]++;

    $('goTitle').textContent  = (vsMode === 'ai' && winner === 1) ? 'You Lose!'
      : (vsMode === 'ai' && winner === 0) ? 'You Win!'
      : (onlineMode && winner === myPlayerIdx) ? 'You Win! 🏆'
      : (onlineMode && winner !== myPlayerIdx) ? 'You Lose!'
      : `${players[winner]} Wins!`;
    $('goReason').textContent = reason || '';
    $('goOverlay').classList.add('show');
    updateTrackerUI();

    // Broadcast result to server so opponent's screen updates too
    if (onlineMode) {
      wsSend({ type: 'pool-gameover', winner, reason });
    }
  }

  // ── AI opponent ──────────────────────────────────────────────────────────
  function aiTargetBalls() {
    if (gameMode === '9ball') {
      const low = lowestBallOnTable();
      return low ? [low] : [];
    }
    if (gameMode === '8ball') {
      if (!groupAssigned) return balls.filter(b => b.active && b.id !== 0 && b.id !== 8);
      if (eightLegal[1]) return balls.filter(b => b.active && b.id === 8);
      const grp = playerGroup[1];
      if (grp === 'solid')  return balls.filter(b => b.active && b.id >= 1  && b.id <= 7);
      if (grp === 'stripe') return balls.filter(b => b.active && b.id >= 9  && b.id <= 15);
    }
    return balls.filter(b => b.active && b.id !== 0);
  }

  function isLineClear(x1, y1, x2, y2, excludeId) {
    for (const b of balls) {
      if (!b.active || b.id === 0 || b.id === excludeId) continue;
      const dx = x2 - x1, dy = y2 - y1;
      const len2 = dx * dx + dy * dy;
      if (len2 < 1) continue;
      const t  = clamp(((b.x - x1) * dx + (b.y - y1) * dy) / len2, 0, 1);
      const px = x1 + t * dx, py = y1 + t * dy;
      if (dist2(b.x, b.y, px, py) < (BD + 1) ** 2) return false;
    }
    return true;
  }

  function doAIShot() {
    const cb = getCueBall();
    if (!cb || gamePhase !== 'aiming') return;

    const targets = aiTargetBalls();
    let bestAngle = Math.random() * Math.PI * 2;
    let bestPow   = MAX_SPD * 0.38;
    let bestScore = -1;

    for (const tb of targets) {
      for (const pk of POCKETS) {
        const toPk  = Math.atan2(pk.y - tb.y, pk.x - tb.x);
        const gbx   = tb.x - Math.cos(toPk) * BD;
        const gby   = tb.y - Math.sin(toPk) * BD;

        if (!isLineClear(cb.x, cb.y, gbx, gby, tb.id)) continue;
        if (!isLineClear(tb.x, tb.y, pk.x, pk.y, -1)) continue;

        const d     = hypot(cb.x, cb.y, gbx, gby);
        const score = 1 / (d + 1);
        if (score > bestScore) {
          bestScore = score;
          const err  = (Math.random() - 0.5) * 0.11;
          bestAngle  = Math.atan2(gby - cb.y, gbx - cb.x) + err;
          bestPow    = clamp(0.38 + Math.random() * 0.42, 0.3, 0.88) * MAX_SPD;
        }
      }
    }

    cb.vx = Math.cos(bestAngle) * bestPow;
    cb.vy = Math.sin(bestAngle) * bestPow;
    resetTurnTracking();
    gamePhase = 'rolling';
  }

  // ── Aiming helper: find ghost-ball position ──────────────────────────────
  function findGhostBall(cx, cy, nx, ny) {
    let minT = Infinity, hitBall = null;

    for (const b of balls) {
      if (!b.active || b.id === 0) continue;
      const fx = cx - b.x, fy = cy - b.y;
      const B  = 2 * (fx * nx + fy * ny);
      const C  = fx * fx + fy * fy - BD * BD;
      const disc = B * B - 4 * C;
      if (disc < 0) continue;
      const t = (-B - Math.sqrt(disc)) / 2;
      if (t < 1 || t >= minT) continue;
      minT = t; hitBall = b;
    }

    if (hitBall) {
      return { x: cx + minT * nx, y: cy + minT * ny, ball: hitBall, t: minT, nx, ny };
    }

    // Find cushion intersection
    const lx = CX + BR, rx2 = CX + CW - BR;
    const ty = CY + BR, by2 = CY + CH - BR;
    let wt = Infinity;
    if (nx > 0) wt = Math.min(wt, (rx2 - cx) / nx);
    else if (nx < 0) wt = Math.min(wt, (lx  - cx) / nx);
    if (ny > 0) wt = Math.min(wt, (by2 - cy) / ny);
    else if (ny < 0) wt = Math.min(wt, (ty  - cy) / ny);

    return { x: cx + wt * nx, y: cy + wt * ny, ball: null, t: wt, nx, ny };
  }

  // ── Rendering ────────────────────────────────────────────────────────────
  function drawTable() {
    // Outer wood frame
    const woodGr = ctx.createLinearGradient(0, 0, CVW, CVH);
    woodGr.addColorStop(0,   '#6b3a1f');
    woodGr.addColorStop(0.5, '#7e4a28');
    woodGr.addColorStop(1,   '#4e2b10');
    ctx.fillStyle = woodGr;
    ctx.beginPath();
    roundRect(ctx, 0, 0, CVW, CVH, 14);
    ctx.fill();

    // Inner wood highlights (rail face bevel)
    ctx.fillStyle = 'rgba(0,0,0,0.25)';
    roundRect(ctx, 4, 4, CVW - 8, CVH - 8, 11);
    ctx.fill();

    // Cushion strips (dark green)
    ctx.fillStyle = '#235518';
    roundRect(ctx, CX - 14, CY - 14, CW + 28, CH + 28, 6);
    ctx.fill();

    // Felt cloth
    const feltGr = ctx.createRadialGradient(CX + CW / 2, CY + CH / 2, 30, CX + CW / 2, CY + CH / 2, Math.max(CW, CH) * 0.65);
    feltGr.addColorStop(0,   '#2e7d32');
    feltGr.addColorStop(0.7, '#2a7430');
    feltGr.addColorStop(1,   '#1b5e20');
    ctx.fillStyle = feltGr;
    ctx.fillRect(CX, CY, CW, CH);

    // Felt subtle texture overlay
    ctx.fillStyle = 'rgba(255,255,255,0.024)';
    for (let fy = CY; fy < CY + CH; fy += 4) {
      ctx.fillRect(CX, fy, CW, 2);
    }

    // Head string line
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.13)';
    ctx.lineWidth   = 1;
    ctx.setLineDash([5, 9]);
    ctx.beginPath();
    ctx.moveTo(HEAD_STRING, CY + 6);
    ctx.lineTo(HEAD_STRING, CY + CH - 6);
    ctx.stroke();
    ctx.restore();

    // Rack spot
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.beginPath();
    ctx.arc(RACK_CX, CY + CH / 2, 3, 0, Math.PI * 2);
    ctx.fill();

    // Pockets
    for (const p of POCKETS) {
      // Shadow halo
      const sha = ctx.createRadialGradient(p.x + 2, p.y + 3, 0, p.x, p.y, p.r + 6);
      sha.addColorStop(0, 'rgba(0,0,0,0.55)');
      sha.addColorStop(1, 'transparent');
      ctx.fillStyle = sha;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 6, 0, Math.PI * 2);
      ctx.fill();

      // Pocket hole
      const hGr = ctx.createRadialGradient(p.x - 2, p.y - 2, 1, p.x, p.y, p.r);
      hGr.addColorStop(0, '#1a1a1a');
      hGr.addColorStop(0.75, '#0d0d0d');
      hGr.addColorStop(1,  '#333');
      ctx.fillStyle = hGr;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();

      // Leather rim
      ctx.strokeStyle = 'rgba(100,60,20,0.55)';
      ctx.lineWidth   = 1.5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r + 1, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  function drawBall(b) {
    if (!b.active) return;
    const x = b.x, y = b.y;
    const col     = BALL_COL[b.id] || '#f0ede6';
    const isStripe = b.id >= 9;
    const isCue    = b.id === 0;

    // Drop shadow (all skins)
    const sha = ctx.createRadialGradient(x + 2.5, y + 5, 0, x + 2.5, y + 4.5, BR * 2.1);
    sha.addColorStop(0,    'rgba(0,0,0,0.52)');
    sha.addColorStop(0.55, 'rgba(0,0,0,0.20)');
    sha.addColorStop(1,    'transparent');
    ctx.fillStyle = sha;
    ctx.beginPath();
    ctx.arc(x + 2.5, y + 4.5, BR * 1.85, 0, Math.PI * 2);
    ctx.fill();

    if      (activeSkin === 'neon')    drawBallNeon(x, y, col, isStripe, isCue, b);
    else if (activeSkin === 'crystal') drawBallCrystal(x, y, col, isStripe, isCue, b);
    else if (activeSkin === 'marble')  drawBallMarble(x, y, col, isStripe, isCue, b);
    else if (activeSkin === 'gold')    drawBallGold(x, y, col, isStripe, isCue, b);
    else                               drawBallClassic(x, y, col, isStripe, isCue, b);
  }

  // ── Shared: number badge ────────────────────────────────────────────────
  function drawBallNumber(x, y, id, textCol) {
    ctx.fillStyle = activeSkin === 'neon' ? 'rgba(0,0,0,0.82)' : 'rgba(255,255,255,0.92)';
    ctx.beginPath();
    ctx.arc(x, y, BR * 0.44, 0, Math.PI * 2);
    ctx.fill();
    if (activeSkin === 'neon') {
      ctx.strokeStyle = 'rgba(255,255,255,0.28)';
      ctx.lineWidth   = 0.6;
      ctx.stroke();
    }
    ctx.fillStyle    = textCol || '#111';
    ctx.font         = `bold ${id >= 10 ? 6.5 : 7.5}px Inter,sans-serif`;
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(id), x, y + 0.5);
  }

  // ── Skin: Classic ───────────────────────────────────────────────────────
  function drawBallClassic(x, y, col, isStripe, isCue, b) {
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, BR, 0, Math.PI * 2); ctx.clip();

    if (isCue) {
      const cg = ctx.createRadialGradient(x - BR*0.35, y - BR*0.38, 0, x, y, BR);
      cg.addColorStop(0,    '#ffffff');
      cg.addColorStop(0.42, '#f5f2eb');
      cg.addColorStop(0.82, '#e0dcd4');
      cg.addColorStop(1,    '#b0ada6');
      ctx.fillStyle = cg;
      ctx.fillRect(x - BR, y - BR, BD, BD);
    } else if (isStripe) {
      // White base with sphere gradient
      const bg = ctx.createRadialGradient(x - BR*0.28, y - BR*0.28, 0, x, y, BR);
      bg.addColorStop(0,    '#ffffff');
      bg.addColorStop(0.55, '#f5f2eb');
      bg.addColorStop(0.88, '#e2dfd8');
      bg.addColorStop(1,    '#c2bfb8');
      ctx.fillStyle = bg;
      ctx.fillRect(x - BR, y - BR, BD, BD);

      // Narrow colour band — white caps clearly visible
      const bw = BR * 0.58;
      const bandGr = ctx.createLinearGradient(x, y - bw, x, y + bw);
      bandGr.addColorStop(0,    lighten(col, 55));
      bandGr.addColorStop(0.28, lighten(col, 25));
      bandGr.addColorStop(0.5,  col);
      bandGr.addColorStop(0.72, darken(col, 20));
      bandGr.addColorStop(1,    darken(col, 38));
      ctx.fillStyle = bandGr;
      ctx.fillRect(x - BR, y - bw, BD, bw * 2);
    } else {
      // Solid — rich 5-stop sphere gradient
      const grad = ctx.createRadialGradient(x - BR*0.3, y - BR*0.32, 0, x, y, BR);
      grad.addColorStop(0,    lighten(col, 75));
      grad.addColorStop(0.28, lighten(col, 38));
      grad.addColorStop(0.6,  col);
      grad.addColorStop(0.85, darken(col, 28));
      grad.addColorStop(1,    darken(col, 52));
      ctx.fillStyle = grad;
      ctx.fillRect(x - BR, y - BR, BD, BD);
    }
    ctx.restore();

    // Edge shadow ring
    ctx.strokeStyle = 'rgba(0,0,0,0.22)';
    ctx.lineWidth   = 0.8;
    ctx.beginPath(); ctx.arc(x, y, BR - 0.4, 0, Math.PI * 2); ctx.stroke();

    if (!isCue) drawBallNumber(x, y, b.id, '#111');

    // Specular highlight
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, BR, 0, Math.PI * 2); ctx.clip();
    const hi = ctx.createRadialGradient(x - BR*0.38, y - BR*0.42, 0, x - BR*0.3, y - BR*0.34, BR*0.6);
    hi.addColorStop(0,   'rgba(255,255,255,0.75)');
    hi.addColorStop(0.4, 'rgba(255,255,255,0.22)');
    hi.addColorStop(1,   'transparent');
    ctx.fillStyle = hi;
    ctx.fillRect(x - BR, y - BR, BD, BD);
    ctx.restore();
  }

  // ── Skin: Neon ──────────────────────────────────────────────────────────
  function drawBallNeon(x, y, col, isStripe, isCue, b) {
    const nCol = isCue ? '#a0aaff' : (b.id === 8 ? '#aab0cc' : lighten(col, 55));

    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, BR, 0, Math.PI * 2); ctx.clip();

    // Dark base (all variants)
    const bg = ctx.createRadialGradient(x, y, 0, x, y, BR);
    bg.addColorStop(0, '#1c1c2e');
    bg.addColorStop(1, '#06060f');
    ctx.fillStyle = bg;
    ctx.fillRect(x - BR, y - BR, BD, BD);

    if (isCue) {
      const cg = ctx.createRadialGradient(x, y, 0, x, y, BR);
      cg.addColorStop(0,    'rgba(210,218,255,0.82)');
      cg.addColorStop(0.55, 'rgba(150,165,255,0.35)');
      cg.addColorStop(1,    'transparent');
      ctx.fillStyle = cg;
      ctx.fillRect(x - BR, y - BR, BD, BD);
    } else if (isStripe) {
      // Glowing neon band centre
      const bw = BR * 0.58;
      const bandGr = ctx.createLinearGradient(x, y - bw, x, y + bw);
      bandGr.addColorStop(0,   lighten(col, 80));
      bandGr.addColorStop(0.5, lighten(col, 50));
      bandGr.addColorStop(1,   lighten(col, 25));
      ctx.fillStyle = bandGr;
      ctx.fillRect(x - BR, y - bw, BD, bw * 2);
    } else {
      // Inner glow
      const ig = ctx.createRadialGradient(x, y, 0, x, y, BR);
      ig.addColorStop(0,    lighten(col, 90));
      ig.addColorStop(0.4,  lighten(col, 50));
      ig.addColorStop(0.78, col);
      ig.addColorStop(1,    darken(col, 18));
      ctx.fillStyle = ig;
      ctx.fillRect(x - BR, y - BR, BD, BD);
    }
    ctx.restore();

    // Glowing outline ring
    ctx.save();
    ctx.shadowBlur  = 14;
    ctx.shadowColor = nCol;
    ctx.strokeStyle = nCol;
    ctx.lineWidth   = 1.5;
    ctx.beginPath(); ctx.arc(x, y, BR - 0.75, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();

    if (!isCue) drawBallNumber(x, y, b.id, '#ffffff');

    // Specular
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, BR, 0, Math.PI * 2); ctx.clip();
    const hi = ctx.createRadialGradient(x - BR*0.36, y - BR*0.40, 0, x - BR*0.28, y - BR*0.32, BR*0.55);
    hi.addColorStop(0,   'rgba(255,255,255,0.62)');
    hi.addColorStop(0.45,'rgba(255,255,255,0.18)');
    hi.addColorStop(1,   'transparent');
    ctx.fillStyle = hi;
    ctx.fillRect(x - BR, y - BR, BD, BD);
    ctx.restore();
  }

  // ── Skin: Crystal ───────────────────────────────────────────────────────
  function drawBallCrystal(x, y, col, isStripe, isCue, b) {
    function hRGB(h) { const n = parseInt(h.replace('#',''), 16); return [(n>>16)&255, (n>>8)&255, n&255]; }
    const [cr, cg2, cb2] = hRGB(col);

    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, BR, 0, Math.PI * 2); ctx.clip();

    if (isCue) {
      const cgrad = ctx.createRadialGradient(x - BR*0.3, y - BR*0.3, 0, x, y, BR);
      cgrad.addColorStop(0,    'rgba(255,255,255,0.98)');
      cgrad.addColorStop(0.38, 'rgba(230,238,255,0.88)');
      cgrad.addColorStop(0.75, 'rgba(185,205,240,0.68)');
      cgrad.addColorStop(1,    'rgba(140,170,220,0.45)');
      ctx.fillStyle = cgrad;
      ctx.fillRect(x - BR, y - BR, BD, BD);
    } else if (isStripe) {
      // Frosted glass base
      const fbg = ctx.createRadialGradient(x - BR*0.25, y - BR*0.25, 0, x, y, BR);
      fbg.addColorStop(0,   'rgba(255,255,255,0.94)');
      fbg.addColorStop(0.6, 'rgba(225,232,250,0.80)');
      fbg.addColorStop(1,   'rgba(180,195,228,0.65)');
      ctx.fillStyle = fbg;
      ctx.fillRect(x - BR, y - BR, BD, BD);
      // Translucent color band
      const bw = BR * 0.58;
      const bandGr = ctx.createLinearGradient(x, y - bw, x, y + bw);
      bandGr.addColorStop(0,   `rgba(${clamp(cr+100,0,255)},${clamp(cg2+100,0,255)},${clamp(cb2+100,0,255)},0.78)`);
      bandGr.addColorStop(0.5, `rgba(${cr},${cg2},${cb2},0.72)`);
      bandGr.addColorStop(1,   `rgba(${clamp(cr-50,0,255)},${clamp(cg2-50,0,255)},${clamp(cb2-50,0,255)},0.78)`);
      ctx.fillStyle = bandGr;
      ctx.fillRect(x - BR, y - bw, BD, bw * 2);
    } else {
      // Tinted glass sphere
      const grad = ctx.createRadialGradient(x - BR*0.28, y - BR*0.28, 0, x, y, BR);
      grad.addColorStop(0,    `rgba(${clamp(cr+115,0,255)},${clamp(cg2+115,0,255)},${clamp(cb2+115,0,255)},0.92)`);
      grad.addColorStop(0.35, `rgba(${clamp(cr+55,0,255)},${clamp(cg2+55,0,255)},${clamp(cb2+55,0,255)},0.82)`);
      grad.addColorStop(0.72, `rgba(${cr},${cg2},${cb2},0.72)`);
      grad.addColorStop(1,    `rgba(${clamp(cr-60,0,255)},${clamp(cg2-60,0,255)},${clamp(cb2-60,0,255)},0.62)`);
      ctx.fillStyle = grad;
      ctx.fillRect(x - BR, y - BR, BD, BD);
    }
    ctx.restore();

    // Glass rim
    ctx.strokeStyle = 'rgba(255,255,255,0.55)';
    ctx.lineWidth   = 1.1;
    ctx.beginPath(); ctx.arc(x, y, BR - 0.55, 0, Math.PI * 2); ctx.stroke();

    if (!isCue) drawBallNumber(x, y, b.id, b.id === 8 ? '#dde' : '#224');

    // Dual crystal highlight
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, BR, 0, Math.PI * 2); ctx.clip();
    const hi1 = ctx.createRadialGradient(x - BR*0.36, y - BR*0.42, 0, x - BR*0.28, y - BR*0.32, BR*0.58);
    hi1.addColorStop(0,   'rgba(255,255,255,0.88)');
    hi1.addColorStop(0.45,'rgba(255,255,255,0.28)');
    hi1.addColorStop(1,   'transparent');
    ctx.fillStyle = hi1;
    ctx.fillRect(x - BR, y - BR, BD, BD);
    const hi2 = ctx.createRadialGradient(x + BR*0.22, y + BR*0.28, 0, x + BR*0.22, y + BR*0.28, BR*0.30);
    hi2.addColorStop(0,  'rgba(255,255,255,0.38)');
    hi2.addColorStop(1,  'transparent');
    ctx.fillStyle = hi2;
    ctx.fillRect(x - BR, y - BR, BD, BD);
    ctx.restore();
  }

  // ── Skin: Marble ────────────────────────────────────────────────────────
  function drawBallMarble(x, y, col, isStripe, isCue, b) {
    function hRGB(h) { const n = parseInt(h.replace('#',''), 16); return [(n>>16)&255, (n>>8)&255, n&255]; }
    const [cr, cg2, cb2] = isCue ? [240,237,230] : hRGB(col);

    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, BR, 0, Math.PI * 2); ctx.clip();

    // Base marble gradient
    const bg = ctx.createRadialGradient(x - BR*0.25, y - BR*0.25, 0, x, y, BR);
    bg.addColorStop(0,    `rgb(${clamp(cr+80,0,255)},${clamp(cg2+80,0,255)},${clamp(cb2+80,0,255)})`);
    bg.addColorStop(0.5,  `rgb(${clamp(cr+30,0,255)},${clamp(cg2+30,0,255)},${clamp(cb2+30,0,255)})`);
    bg.addColorStop(1,    `rgb(${clamp(cr-40,0,255)},${clamp(cg2-40,0,255)},${clamp(cb2-40,0,255)})`);
    ctx.fillStyle = bg;
    ctx.fillRect(x - BR, y - BR, BD, BD);

    // Marble veins
    ctx.strokeStyle = `rgba(255,255,255,0.28)`;
    ctx.lineWidth = 0.8;
    for (let i = 0; i < 3; i++) {
      const ang = (i * 1.3 + (b.id * 0.7));
      ctx.beginPath();
      ctx.moveTo(x + Math.cos(ang) * BR, y + Math.sin(ang) * BR);
      ctx.bezierCurveTo(
        x + Math.cos(ang + 0.9) * BR * 0.6, y + Math.sin(ang + 0.9) * BR * 0.6,
        x - Math.cos(ang + 0.3) * BR * 0.5, y - Math.sin(ang + 0.3) * BR * 0.5,
        x - Math.cos(ang) * BR, y  - Math.sin(ang) * BR
      );
      ctx.stroke();
    }

    if (isStripe) {
      // Stripe band on top of marble
      const bw = BR * 0.52;
      ctx.fillStyle = `rgba(${cr},${cg2},${cb2},0.55)`;
      ctx.fillRect(x - BR, y - bw, BD, bw * 2);
    }
    ctx.restore();

    ctx.strokeStyle = 'rgba(0,0,0,0.18)';
    ctx.lineWidth   = 0.8;
    ctx.beginPath(); ctx.arc(x, y, BR - 0.4, 0, Math.PI * 2); ctx.stroke();

    if (!isCue) drawBallNumber(x, y, b.id, '#111');

    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, BR, 0, Math.PI * 2); ctx.clip();
    const hi = ctx.createRadialGradient(x - BR*0.38, y - BR*0.42, 0, x - BR*0.3, y - BR*0.34, BR*0.6);
    hi.addColorStop(0,   'rgba(255,255,255,0.72)');
    hi.addColorStop(0.4, 'rgba(255,255,255,0.18)');
    hi.addColorStop(1,   'transparent');
    ctx.fillStyle = hi;
    ctx.fillRect(x - BR, y - BR, BD, BD);
    ctx.restore();
  }

  // ── Skin: Gold ──────────────────────────────────────────────────────────
  function drawBallGold(x, y, col, isStripe, isCue, b) {
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, BR, 0, Math.PI * 2); ctx.clip();

    if (isCue) {
      const cg = ctx.createRadialGradient(x - BR*0.35, y - BR*0.38, 0, x, y, BR);
      cg.addColorStop(0,    '#fffde0');
      cg.addColorStop(0.35, '#f5d060');
      cg.addColorStop(0.72, '#c8900a');
      cg.addColorStop(1,    '#7a5200');
      ctx.fillStyle = cg;
      ctx.fillRect(x - BR, y - BR, BD, BD);
    } else if (isStripe) {
      const bg = ctx.createRadialGradient(x - BR*0.28, y - BR*0.28, 0, x, y, BR);
      bg.addColorStop(0,    '#fffde8');
      bg.addColorStop(0.55, '#f0e8c8');
      bg.addColorStop(1,    '#c8a850');
      ctx.fillStyle = bg;
      ctx.fillRect(x - BR, y - BR, BD, BD);
      const bw = BR * 0.54;
      const bandGr = ctx.createLinearGradient(x, y - bw, x, y + bw);
      bandGr.addColorStop(0,   '#ffe066');
      bandGr.addColorStop(0.5, '#e8a800');
      bandGr.addColorStop(1,   '#b87800');
      ctx.fillStyle = bandGr;
      ctx.fillRect(x - BR, y - bw, BD, bw * 2);
    } else {
      const grad = ctx.createRadialGradient(x - BR*0.3, y - BR*0.32, 0, x, y, BR);
      grad.addColorStop(0,    '#fffce0');
      grad.addColorStop(0.25, '#ffe066');
      grad.addColorStop(0.58, '#e8a800');
      grad.addColorStop(0.82, '#c07800');
      grad.addColorStop(1,    '#7a4800');
      ctx.fillStyle = grad;
      ctx.fillRect(x - BR, y - BR, BD, BD);
    }
    ctx.restore();

    // Gold rim ring
    ctx.strokeStyle = '#e0a020';
    ctx.lineWidth   = 1.2;
    ctx.beginPath(); ctx.arc(x, y, BR - 0.6, 0, Math.PI * 2); ctx.stroke();

    if (!isCue) drawBallNumber(x, y, b.id, '#3a2000');

    // Metallic sheen
    ctx.save();
    ctx.beginPath(); ctx.arc(x, y, BR, 0, Math.PI * 2); ctx.clip();
    const hi = ctx.createRadialGradient(x - BR*0.38, y - BR*0.44, 0, x - BR*0.28, y - BR*0.34, BR*0.62);
    hi.addColorStop(0,   'rgba(255,255,240,0.88)');
    hi.addColorStop(0.35,'rgba(255,240,180,0.28)');
    hi.addColorStop(1,   'transparent');
    ctx.fillStyle = hi;
    ctx.fillRect(x - BR, y - BR, BD, BD);
    ctx.restore();
  }

  function drawAim() {
    if ((gamePhase !== 'aiming' && gamePhase !== 'placing') || aiThinking) return;
    const cb = getCueBall();
    if (!cb) return;

    const dx = mouse.x - cb.x;
    const dy = mouse.y - cb.y;
    const d  = Math.hypot(dx, dy);
    if (d < 8) return;

    const nx = dx / d, ny = dy / d;

    // Power based on mouse distance from cue ball
    const pct    = clamp(d, 0, MAX_AIM_D) / MAX_AIM_D;
    const pullback = 4 + pct * 26; // visual cue pull-back

    if (gamePhase === 'aiming') {
      const ghost = findGhostBall(cb.x, cb.y, nx, ny);

      // Primary aim line (dashed white)
      ctx.save();
      ctx.strokeStyle = 'rgba(255,255,255,0.42)';
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([8, 7]);
      ctx.beginPath();
      ctx.moveTo(cb.x, cb.y);
      ctx.lineTo(ghost.x, ghost.y);
      ctx.stroke();
      ctx.restore();

      if (ghost.ball) {
        // Ghost cue ball at impact point
        ctx.save();
        ctx.globalAlpha = 0.36;
        ctx.fillStyle   = '#f0ede6';
        ctx.strokeStyle = 'rgba(255,255,255,0.65)';
        ctx.lineWidth   = 1.2;
        ctx.beginPath();
        ctx.arc(ghost.x, ghost.y, BR, 0, Math.PI * 2);
        ctx.fill();
        ctx.stroke();
        ctx.restore();

        // Deflection of target ball (green dotted)
        const impNx = (ghost.ball.x - ghost.x) / BD;
        const impNy = (ghost.ball.y - ghost.y) / BD;
        ctx.save();
        ctx.strokeStyle = 'rgba(100,255,100,0.45)';
        ctx.lineWidth   = 1.2;
        ctx.setLineDash([5, 8]);
        ctx.beginPath();
        ctx.moveTo(ghost.ball.x, ghost.ball.y);
        ctx.lineTo(ghost.ball.x + impNx * 130, ghost.ball.y + impNy * 130);
        ctx.stroke();
        ctx.restore();
      }
    }

    // Cue stick
    drawCueStick(cb.x, cb.y, nx, ny, pullback);
  }

  function drawCueStick(cx, cy, nx, ny, pullback) {
    const tipDist = BR + pullback;
    const len     = 148;

    const tx = cx - nx * tipDist;
    const ty = cy - ny * tipDist;
    const bx = cx - nx * (tipDist + len);
    const by = cy - ny * (tipDist + len);

    const px = -ny, py = nx;  // perpendicular for width

    // ── Cue skin definitions ─────────────────────────────────────────
    const CUE_SKINS = {
      classic: {
        stops: [
          [0,    '#3e1f08'],  // butt
          [0.22, '#5c3010'],
          [0.42, '#8b5e2a'],
          [0.65, '#c4a060'],  // shaft
          [0.88, '#e8d298'],
          [1,    '#a07840'],  // tip end
        ],
        tipCol: '#2c6fad',
        rimCol: '#c8902a',
        buttW: 5.5, tipW: 1.4,
        outline: 'rgba(0,0,0,0.32)',
        wrap: { col: '#b8380a', spacing: 0.18, count: 3 } // decorative wraps
      },
      maple: {
        stops: [
          [0,    '#1c0e04'],
          [0.18, '#3d2108'],
          [0.38, '#7a5230'],
          [0.62, '#d4a96a'],
          [0.84, '#f0d090'],
          [1,    '#bfa060'],
        ],
        tipCol: '#1a5a8a',
        rimCol: '#e6b040',
        buttW: 5.2, tipW: 1.3,
        outline: 'rgba(0,0,0,0.28)',
        wrap: { col: '#2c4a90', spacing: 0.20, count: 2 }
      },
      ebony: {
        stops: [
          [0,    '#090909'],
          [0.20, '#1a1a1a'],
          [0.45, '#2e2e2e'],
          [0.72, '#3d3d3d'],
          [0.90, '#555'],
          [1,    '#1c1c1c'],
        ],
        tipCol: '#c84040',
        rimCol: '#888',
        buttW: 5.0, tipW: 1.3,
        outline: 'rgba(0,0,0,0.5)',
        wrap: { col: '#c84040', spacing: 0.22, count: 4 }
      },
      neon: {
        stops: [
          [0,    '#0a001a'],
          [0.25, '#1a0038'],
          [0.50, '#2a006a'],
          [0.72, '#5500cc'],
          [0.88, '#8833ff'],
          [1,    '#aa66ff'],
        ],
        tipCol: '#00ffee',
        rimCol: '#ff00cc',
        buttW: 5.2, tipW: 1.4,
        outline: 'rgba(150,0,255,0.55)',
        glow: '#9933ff',
        wrap: { col: '#00ffee', spacing: 0.16, count: 5 }
      },
      carbon: {
        stops: [
          [0,    '#0e0e0e'],
          [0.15, '#1e1e1e'],
          [0.40, '#111'],
          [0.65, '#2a2a2a'],
          [0.85, '#3a3a3a'],
          [1,    '#1a1a1a'],
        ],
        tipCol: '#44aaff',
        rimCol: '#555',
        buttW: 5.3, tipW: 1.3,
        outline: 'rgba(0,80,180,0.3)',
        carbonFiber: true,
        wrap: { col: '#44aaff', spacing: 0.24, count: 2 }
      },
      ivory: {
        stops: [
          [0,    '#b8a870'],
          [0.20, '#d4c898'],
          [0.42, '#f2ecd8'],
          [0.68, '#faf6ea'],
          [0.88, '#f0ebda'],
          [1,    '#d8d0b8'],
        ],
        tipCol: '#2C6FAD',
        rimCol: '#c8a840',
        buttW: 5.0, tipW: 1.3,
        outline: 'rgba(100,80,20,0.3)',
        wrap: { col: '#c8a840', spacing: 0.19, count: 3 }
      },
      rosewood: {
        stops: [
          [0,    '#2a0808'],
          [0.18, '#5a1818'],
          [0.38, '#8b2828'],
          [0.62, '#c45050'],
          [0.84, '#d88080'],
          [1,    '#a03030'],
        ],
        tipCol: '#2c6fad',
        rimCol: '#e0a040',
        buttW: 5.5, tipW: 1.4,
        outline: 'rgba(80,0,0,0.35)',
        wrap: { col: '#e0a040', spacing: 0.17, count: 4 }
      },
      chrome: {
        stops: [
          [0,    '#1a1a2e'],
          [0.10, '#2e2e4e'],
          [0.28, '#5e6080'],
          [0.48, '#b0b8d0'],
          [0.62, '#e8ecf8'],
          [0.74, '#c0c8e0'],
          [0.88, '#909ab8'],
          [1,    '#6070a0'],
        ],
        tipCol: '#00ccff',
        rimCol: '#c0c8e0',
        buttW: 5.4, tipW: 1.4,
        outline: 'rgba(100,120,200,0.4)',
        glow: '#88aaff',
        wrap: { col: '#00ccff', spacing: 0.20, count: 3 }
      },
    };

    const sk = CUE_SKINS[activeCueSkin] || CUE_SKINS.classic;

    // Build shaft gradient
    const cg = ctx.createLinearGradient(bx, by, tx, ty);
    for (const [stop, col] of sk.stops) cg.addColorStop(stop, col);

    ctx.save();

    // Glow for neon/chrome
    if (sk.glow) {
      ctx.shadowBlur  = 18;
      ctx.shadowColor = sk.glow;
    }

    // Main shaft
    ctx.beginPath();
    ctx.moveTo(bx + px * sk.buttW, by + py * sk.buttW);
    ctx.lineTo(bx - px * sk.buttW, by - py * sk.buttW);
    ctx.lineTo(tx - px * sk.tipW,  ty - py * sk.tipW);
    ctx.lineTo(tx + px * sk.tipW,  ty + py * sk.tipW);
    ctx.closePath();
    ctx.fillStyle = cg;
    ctx.fill();

    // Outline
    ctx.strokeStyle = sk.outline;
    ctx.lineWidth   = 0.8;
    ctx.stroke();
    ctx.shadowBlur = 0;

    // Carbon fiber cross-hatch overlay
    if (sk.carbonFiber) {
      ctx.save();
      ctx.clip();
      ctx.strokeStyle = 'rgba(80,120,200,0.18)';
      ctx.lineWidth   = 0.7;
      for (let i = -len; i < len; i += 6) {
        ctx.beginPath();
        ctx.moveTo(tx + nx * i + px * sk.buttW, ty + ny * i + py * sk.buttW);
        ctx.lineTo(tx + nx * i - px * sk.buttW, ty + ny * i - py * sk.buttW);
        ctx.stroke();
      }
      ctx.restore();
    }

    // Specular highlight (right edge of shaft)
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(bx + px * sk.buttW, by + py * sk.buttW);
    ctx.lineTo(bx - px * sk.buttW, by - py * sk.buttW);
    ctx.lineTo(tx - px * sk.tipW,  ty - py * sk.tipW);
    ctx.lineTo(tx + px * sk.tipW,  ty + py * sk.tipW);
    ctx.closePath();
    ctx.clip();
    const hiGr = ctx.createLinearGradient(
      cx - py * sk.buttW, cy + px * sk.buttW,
      cx + py * sk.buttW, cy - px * sk.buttW
    );
    hiGr.addColorStop(0,    'rgba(255,255,255,0.22)');
    hiGr.addColorStop(0.35, 'rgba(255,255,255,0.06)');
    hiGr.addColorStop(1,    'rgba(0,0,0,0.12)');
    ctx.fillStyle = hiGr;
    ctx.fillRect(bx - sk.buttW * 2, by - sk.buttW * 2, len + sk.buttW * 4, len + sk.buttW * 4);
    ctx.restore();

    // Decorative wraps (rings)
    if (sk.wrap) {
      const { col: wc, spacing, count } = sk.wrap;
      for (let i = 0; i < count; i++) {
        const t2 = 0.10 + i * spacing;
        if (t2 > 0.92) continue;
        const wx = bx + (tx - bx) * t2;
        const wy = by + (ty - by) * t2;
        const hw = sk.buttW * (1 - t2 * 0.5) + sk.tipW * t2 * 0.5 + 0.5;
        ctx.strokeStyle = wc;
        ctx.lineWidth   = 1.6;
        ctx.beginPath();
        ctx.moveTo(wx + px * hw, wy + py * hw);
        ctx.lineTo(wx - px * hw, wy - py * hw);
        ctx.stroke();
      }
    }

    // Butt cap
    ctx.fillStyle   = sk.rimCol;
    ctx.strokeStyle = 'rgba(0,0,0,0.4)';
    ctx.lineWidth   = 0.7;
    ctx.beginPath();
    ctx.ellipse(bx, by, sk.buttW + 1.2, 2.2, Math.atan2(ny, nx) + Math.PI / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Cue tip
    ctx.shadowBlur  = sk.glow ? 8 : 0;
    ctx.shadowColor = sk.glow || 'transparent';
    ctx.fillStyle   = sk.tipCol;
    ctx.beginPath();
    ctx.ellipse(tx, ty, 2.4, 1.4, Math.atan2(ny, nx) + Math.PI / 2, 0, Math.PI * 2);
    ctx.fill();
    // Chalk mark on tip
    ctx.fillStyle = 'rgba(100,160,255,0.5)';
    ctx.beginPath();
    ctx.ellipse(tx, ty, 1.2, 0.7, Math.atan2(ny, nx) + Math.PI / 2, 0, Math.PI * 2);
    ctx.fill();
    ctx.shadowBlur = 0;

    ctx.restore();
  }

  function drawPowerBar() {
    if ((gamePhase !== 'aiming') || aiThinking) return;
    const cb = getCueBall();
    if (!cb) return;

    const pct = clamp(Math.hypot(mouse.x - cb.x, mouse.y - cb.y), 0, MAX_AIM_D) / MAX_AIM_D;
    const bx  = CVW - 30;
    const by  = CY + 12;
    const bh  = CH - 24;

    // Background track
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    roundRect(ctx, bx - 6, by - 4, 20, bh + 8, 6);
    ctx.fill();

    // Fill gradient
    const fillH  = bh * pct;
    const fillGr = ctx.createLinearGradient(bx, by + bh, bx, by);
    fillGr.addColorStop(0,    '#22c55e');
    fillGr.addColorStop(0.55, '#f59e0b');
    fillGr.addColorStop(1,    '#ef4444');
    ctx.fillStyle = fillGr;
    ctx.beginPath();
    roundRect(ctx, bx - 3, by + bh - fillH, 14, fillH, 4);
    ctx.fill();

    // Label
    ctx.fillStyle    = 'rgba(255,255,255,0.65)';
    ctx.font         = 'bold 7px Inter,sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'alphabetic';
    ctx.fillText('PWR', bx + 4, by + bh + 16);
  }

  function drawHUD() {
    const numPlayers = gameMode === 'practice' ? 1 : 2;

    for (let p = 0; p < numPlayers; p++) {
      const active   = turn === p && (gamePhase === 'aiming' || gamePhase === 'rolling' || gamePhase === 'placing');
      const name     = (vsMode === 'ai' && p === 1) ? 'AI' : players[p];
      const boxW = 148, boxH = 40;
      const bx   = p === 0 ? CX : CX + CW - boxW;
      const by   = 6;

      ctx.fillStyle = active ? 'rgba(109,56,207,0.88)' : 'rgba(0,0,0,0.52)';
      roundRect(ctx, bx, by, boxW, boxH, 9);
      ctx.fill();

      if (active) {
        ctx.strokeStyle = '#a78bfa';
        ctx.lineWidth   = 1.5;
        roundRect(ctx, bx, by, boxW, boxH, 9);
        ctx.stroke();
      }

      ctx.fillStyle    = '#fff';
      ctx.font         = `${active ? 'bold ' : ''}12px Inter,sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(name, bx + boxW / 2, by + 13);

      // Sub-line info
      let sub = '';
      if (gameMode === '8ball' && groupAssigned) {
        const grp = playerGroup[p];
        if (eightLegal[p]) sub = (grp === 'solid' ? '● ' : '◑ ') + 'Shoot the 8!';
        else if (grp === 'solid')  sub = '● Solids';
        else if (grp === 'stripe') sub = '◑ Stripes';
      } else if (gameMode === '9ball' && active) {
        const low = lowestBallOnTable();
        if (low) sub = `Hit the ${low.id}-ball first`;
      }
      if (sub) {
        ctx.font         = '8px Inter,sans-serif';
        ctx.fillStyle    = 'rgba(200,185,255,0.82)';
        ctx.fillText(sub, bx + boxW / 2, by + 29);
      }
    }

    // Centre mode label
    ctx.fillStyle    = 'rgba(255,255,255,0.38)';
    ctx.font         = 'bold 9px Inter,sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    const modeLabel  = { practice: 'PRACTICE', '8ball': '8-BALL', '9ball': '9-BALL' }[gameMode] || '';
    ctx.fillText(modeLabel, CVW / 2, 16);

    // Ball-in-hand prompt
    if (gamePhase === 'placing') {
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      roundRect(ctx, CVW / 2 - 105, CY + CH - 50, 210, 30, 8);
      ctx.fill();
      ctx.fillStyle    = '#a78bfa';
      ctx.font         = 'bold 11px Inter,sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('Click to place cue ball', CVW / 2, CY + CH - 35);
    }

    // AI thinking badge
    if (aiThinking) {
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      roundRect(ctx, CVW / 2 - 75, CY + CH - 50, 150, 30, 8);
      ctx.fill();
      ctx.fillStyle    = '#f59e0b';
      ctx.font         = 'bold 11px Inter,sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('AI thinking…', CVW / 2, CY + CH - 35);
    }

    // Online: waiting for opponent badge
    if (onlineMode && !isMyOnlineTurn() && gamePhase !== 'over') {
      ctx.fillStyle = 'rgba(0,0,0,0.62)';
      roundRect(ctx, CVW / 2 - 100, CY + CH - 50, 200, 30, 8);
      ctx.fill();
      ctx.fillStyle    = '#a78bfa';
      ctx.font         = 'bold 11px Inter,sans-serif';
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${players[turn]}'s turn…`, CVW / 2, CY + CH - 35);
    }

    // Ball-in-hand ghost (follows mouse)
    if (gamePhase === 'placing') {
      const col = '#f0ede6';
      ctx.save();
      ctx.globalAlpha = 0.48;
      const cg = ctx.createRadialGradient(mouse.x - BR * 0.3, mouse.y - BR * 0.3, 1, mouse.x, mouse.y, BR);
      cg.addColorStop(0, '#ffffff');
      cg.addColorStop(1, '#ccc');
      ctx.fillStyle = cg;
      ctx.beginPath();
      ctx.arc(mouse.x, mouse.y, BR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
  }

  function render() {
    ctx.clearRect(0, 0, CVW, CVH);
    drawTable();
    for (const b of balls) drawBall(b);
    drawAim();
    drawPowerBar();
    drawHUD();
  }

  // ── Canvas roundRect polyfill ─────────────────────────────────────────
  function roundRect(c, x, y, w, h, r) {
    if (c.roundRect) { c.roundRect(x, y, w, h, r); return; }
    c.beginPath();
    c.moveTo(x + r, y);
    c.lineTo(x + w - r, y);
    c.quadraticCurveTo(x + w, y, x + w, y + r);
    c.lineTo(x + w, y + h - r);
    c.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    c.lineTo(x + r, y + h);
    c.quadraticCurveTo(x, y + h, x, y + h - r);
    c.lineTo(x, y + r);
    c.quadraticCurveTo(x, y, x + r, y);
    c.closePath();
  }

  // ── Input ────────────────────────────────────────────────────────────────
  function getPos(e) {
    const rect = canvas.getBoundingClientRect();
    const sx   = CVW / rect.width;
    const sy   = CVH / rect.height;
    const src  = e.touches ? e.touches[0] : e;
    return {
      x: (src.clientX - rect.left) * sx,
      y: (src.clientY - rect.top)  * sy,
    };
  }

  function onMove(e) {
    mouse = getPos(e);
    if (gamePhase === 'placing') {
      const cb = getCueBall();
      if (cb) { cb.x = mouse.x; cb.y = mouse.y; }
    }
    // Broadcast mouse to opponent so they see your aim line
    if (onlineMode && isMyOnlineTurn()) {
      const now = Date.now();
      if (now - lastMouseBroadcast > 50) {
        lastMouseBroadcast = now;
        wsSend({ type: 'pool-mouse', x: mouse.x, y: mouse.y });
      }
    }
  }

  function onDown(e) {
    if (e.button !== undefined && e.button !== 0) return;
    const pos = getPos(e);

    // Block input when it's not your turn in online mode
    if (onlineMode && !isMyOnlineTurn()) return;

    if (gamePhase === 'placing') {
      placeCueBall(pos.x, pos.y);
      return;
    }
    if (gamePhase === 'aiming' && !aiThinking) {
      fireShot();
    }
  }

  function placeCueBall(x, y) {
    x = clamp(x, CX + BR + 2, CX + CW - BR - 2);
    y = clamp(y, CY + BR + 2, CY + CH - BR - 2);

    // Reject overlapping other balls
    for (const b of balls) {
      if (!b.active || b.id === 0) continue;
      if (dist2(x, y, b.x, b.y) < BD * BD + 4) return;
    }

    const cb = balls.find(b => b.id === 0);
    if (cb) { cb.active = true; cb.x = x; cb.y = y; cb.vx = 0; cb.vy = 0; }
    else    { balls.push(makeBall(0, x, y)); }

    gamePhase = 'aiming';
    checkAI();
  }

  function fireShot() {
    const cb = getCueBall();
    if (!cb) return;

    const dx = mouse.x - cb.x;
    const dy = mouse.y - cb.y;
    const d  = Math.hypot(dx, dy);
    if (d < 6) return;

    const pct = clamp(d, 0, MAX_AIM_D) / MAX_AIM_D;
    const spd = pct * MAX_SPD;
    cb.vx = (dx / d) * spd;
    cb.vy = (dy / d) * spd;

    // In online mode, broadcast the shot so opponent simulates it simultaneously
    if (onlineMode) {
      wsSend({ type: 'pool-shot', vx: cb.vx, vy: cb.vy, balls: onlineSerializeBalls() });
    }

    resetTurnTracking();
    gamePhase = 'rolling';
  }

  // ── Game loop ────────────────────────────────────────────────────────────
  function loop() {
    requestAnimationFrame(loop);
    if (gamePhase === 'rolling') {
      // In online mode, only the active player runs physics authoritatively
      if (!onlineMode || isMyOnlineTurn()) {
        stepPhysics();
        if (!ballsMoving()) {
          endTurnProcessing();
          // Send authoritative state to server after turn ends
          if (onlineMode) onlineSendTurnState();
        }
      }
    }
    if (gamePhase !== 'menu') render();
  }

  // ── Canvas setup ─────────────────────────────────────────────────────────
  function setupCanvas() {
    canvas = $('poolCanvas');
    dpr    = Math.min(window.devicePixelRatio || 1, 2);

    canvas.width  = CVW * dpr;
    canvas.height = CVH * dpr;
    canvas.style.width  = CVW + 'px';
    canvas.style.height = CVH + 'px';

    ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Scale canvas to fit viewport
    function resize() {
      const maxW = window.innerWidth  - 16;
      const maxH = window.innerHeight - 64;
      const scale = Math.min(maxW / CVW, maxH / CVH, 1);
      canvas.style.width  = Math.floor(CVW * scale) + 'px';
      canvas.style.height = Math.floor(CVH * scale) + 'px';
    }
    resize();
    window.addEventListener('resize', resize);
  }

  // ── Online multiplayer helpers ────────────────────────────────────────────
  function wsSend(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function onlineSerializeBalls() {
    return balls.map(b => ({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, active: b.active }));
  }

  function onlineApplyBallState(bArr) {
    balls = bArr.map(b => ({ id: b.id, x: b.x, y: b.y, vx: b.vx, vy: b.vy, active: b.active }));
  }

  // Serialize full game state to send to opponent
  function onlineSerializeState() {
    return {
      balls: onlineSerializeBalls(),
      turn, groupAssigned, playerGroup: [...playerGroup], eightLegal: [...eightLegal],
      pocketedByPlayer: [pocketedByPlayer[0].slice(), pocketedByPlayer[1].slice()],
      gamePhase, gameMode,
    };
  }

  // Apply full state received from opponent/server
  function onlineApplyState(st) {
    if (!st) return;
    onlineApplyBallState(st.balls);
    turn            = st.turn;
    groupAssigned   = st.groupAssigned;
    playerGroup     = st.playerGroup   || [null, null];
    eightLegal      = st.eightLegal    || [false, false];
    pocketedByPlayer = [st.pocketedByPlayer[0] || [], st.pocketedByPlayer[1] || []];
    gamePhase = st.gamePhase;
    updateTrackerUI();
    resetTurnTracking();
  }

  // Is it my turn in online mode?
  function isMyOnlineTurn() {
    return onlineMode && myPlayerIdx === turn;
  }

  function connectOnline() {
    onlineMode = true;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => {
      const pw = sessionStorage.getItem('arena-room-password') || undefined;
      sessionStorage.removeItem('arena-room-password');
      wsSend({ type: 'join-room', roomId: urlRoomId, name: myName, password: pw, token: myToken });
    };

    ws.onmessage = e => { try { handleOnlineMsg(JSON.parse(e.data)); } catch {} };

    ws.onclose = () => {
      onlineMode = false;
      $('roomStatus').textContent = 'Disconnected. Returning to lobby…';
      setTimeout(() => { location.href = '/'; }, 3000);
    };
  }

  function renderOnlinePlayers() {
    const el = $('roomPlayers');
    if (!el) return;
    el.innerHTML = '';
    for (let i = 0; i < 2; i++) {
      const p = onlinePlayers[i];
      const card = document.createElement('div');
      card.className = 'room-player-card' + (p && p.id === wsMyId ? ' me' : '') + (!p ? ' empty' : '');
      card.innerHTML = `<span class="rpc-icon">${p ? '🎱' : '⌛'}</span><span>${p ? p.name : 'Waiting…'}</span>`;
      el.appendChild(card);
    }
    // Show Start buttons only if 2 players and I'm host (playerIdx 0)
    const actions = $('roomActions');
    if (actions) actions.style.display = (onlinePlayers.length >= 2 && myPlayerIdx === 0 && gamePhase === 'menu') ? '' : 'none';
  }

  function handleOnlineMsg(msg) {
    switch (msg.type) {
      case 'room-joined': {
        wsMyId = msg.myId;
        onlinePlayers = [];
        // Self is always first joined
        onlinePlayers.push({ id: wsMyId, name: myName });
        // Others already in room
        for (const p of (msg.players || [])) onlinePlayers.push({ id: p.id, name: p.name });
        myPlayerIdx = 0; // first to arrive is host
        $('roomStatus').textContent = onlinePlayers.length >= 2 ? 'Room full — ready to start!' : 'Waiting for opponent…';
        renderOnlinePlayers();
        break;
      }

      case 'player-joined': {
        onlinePlayers.push({ id: msg.id, name: msg.name });
        myPlayerIdx = onlinePlayers.findIndex(p => p.id === wsMyId);
        if (myPlayerIdx < 0) myPlayerIdx = 0;
        $('roomStatus').textContent = 'Opponent joined — ready to start!';
        renderOnlinePlayers();
        break;
      }

      case 'player-left': {
        onlinePlayers = onlinePlayers.filter(p => p.id !== msg.id);
        if (gamePhase !== 'menu' && gamePhase !== 'over') {
          gamePhase = 'over';
          $('goTitle').textContent  = 'Opponent Left';
          $('goReason').textContent = 'Your opponent disconnected.';
          $('goOverlay').classList.add('show');
        }
        $('roomStatus').textContent = 'Opponent left.';
        renderOnlinePlayers();
        break;
      }

      // Host sends pool-match-start → both clients initialise
      case 'pool-match-start': {
        const mode = msg.mode || '8ball';
        players[0] = msg.players[0] || onlinePlayers[0]?.name || 'Player 1';
        players[1] = msg.players[1] || onlinePlayers[1]?.name || 'Player 2';
        // Confirm my player index from server-assigned seat
        myPlayerIdx = msg.seats ? msg.seats.indexOf(wsMyId) : myPlayerIdx;
        if (myPlayerIdx < 0) myPlayerIdx = 0;

        // Hide online room lobby, show game area
        $('onlineRoom').style.display = 'none';
        initGame(mode, 'online');
        $('roomStatus') && ($('roomStatus').textContent = '');
        break;
      }

      // Opponent fired a shot — apply their velocity to cue ball and let physics run here too
      case 'pool-shot': {
        if (!onlineMode || gamePhase !== 'aiming') break;
        const cb = getCueBall();
        if (!cb) break;
        // Apply the shot state from opponent
        if (msg.balls) onlineApplyBallState(msg.balls);
        const cb2 = getCueBall();
        if (cb2) { cb2.vx = msg.vx; cb2.vy = msg.vy; }
        resetTurnTracking();
        gamePhase = 'rolling';
        break;
      }

      // End-of-turn authoritative state from the active player
      case 'pool-state': {
        if (!onlineMode) break;
        onlineApplyState(msg.state);
        // If it's now MY turn, set to aiming
        if (myPlayerIdx === msg.state.turn && msg.state.gamePhase === 'aiming') {
          gamePhase = 'aiming';
        } else if (msg.state.gamePhase === 'placing' && myPlayerIdx === msg.state.turn) {
          beginBallInHand();
        }
        break;
      }

      // Opponent's mouse position (for spectation / watching aim)
      case 'pool-mouse': {
        // Only update if it's NOT my turn (so I see opponent aiming)
        if (myPlayerIdx !== turn) {
          mouse = { x: msg.x, y: msg.y };
        }
        break;
      }

      case 'pool-gameover': {
        endGame(msg.winner, msg.reason);
        break;
      }

      case 'error': {
        alert(msg.msg);
        break;
      }
    }
  }

  // Called by active player when balls stop — sends authoritative state to server
  function onlineSendTurnState() {
    if (!onlineMode) return;
    wsSend({ type: 'pool-state', state: onlineSerializeState() });
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  function init() {
    setupCanvas();
    players[0] = myName;
    players[1] = 'Player 2';

    // ── Online room mode: URL has ?room= ────────────────────────────────
    if (urlRoomId) {
      $('modeScreen').style.display = 'none';
      $('onlineRoom').style.display = '';

      // Wire up start-match buttons (host only — visibility controlled by renderOnlinePlayers)
      document.querySelectorAll('.room-start-btn').forEach(btn => {
        btn.addEventListener('click', () => {
          if (onlinePlayers.length < 2) {
            $('roomStatus').textContent = 'Waiting for opponent to join first…';
            return;
          }
          const mode = btn.dataset.mode;
          const seats  = onlinePlayers.map(p => p.id);
          const pNames = onlinePlayers.map(p => p.name);
          wsSend({ type: 'pool-match-start', mode, seats, players: pNames });
        });
      });

      $('btnLeaveRoom').addEventListener('click', () => { location.href = '/'; });

      connectOnline();
    }

    // Skin picker (ball skins)
    document.querySelectorAll('.skin-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        activeSkin = pill.dataset.skin;
        document.querySelectorAll('.skin-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
      });
    });

    // Cue skin picker
    document.querySelectorAll('.cue-pill').forEach(pill => {
      pill.addEventListener('click', () => {
        activeCueSkin = pill.dataset.cue;
        document.querySelectorAll('.cue-pill').forEach(p => p.classList.remove('active'));
        pill.classList.add('active');
      });
    });

    // Mode card clicks
    document.querySelectorAll('.mode-card').forEach(card => {
      card.addEventListener('click', () => {
        const mode = card.dataset.mode;
        const vs   = card.dataset.vs;
        if (vs === 'ai') {
          players[1] = 'AI';
        } else {
          players[1] = sessionStorage.getItem('arena-p2name') || 'Player 2';
        }
        initGame(mode, vs);
      });
    });

    // Canvas events
    canvas.addEventListener('mousemove', onMove);
    canvas.addEventListener('mousedown', onDown);
    canvas.addEventListener('touchmove', e => { e.preventDefault(); onMove(e); }, { passive: false });
    canvas.addEventListener('touchstart', e => { e.preventDefault(); onDown(e); }, { passive: false });

    // Back button
    $('btnBack').addEventListener('click', () => {
      if (gamePhase !== 'menu') {
        gamePhase = 'menu';
        if (aiTimerRef) clearTimeout(aiTimerRef);
        $('gameArea').style.display   = 'none';
        if (onlineMode) {
          $('onlineRoom').style.display = '';
        } else {
          $('modeScreen').style.display = '';
        }
        $('goOverlay').classList.remove('show');
        return;
      }
      location.href = '/';
    });

    // Game over buttons
    $('btnPlayAgain').addEventListener('click', () => {
      $('goOverlay').classList.remove('show');
      if (onlineMode && myPlayerIdx === 0) {
        // Host re-sends match-start with same mode
        const seats  = onlinePlayers.map(p => p.id);
        const pNames = onlinePlayers.map(p => p.name);
        wsSend({ type: 'pool-match-start', mode: gameMode, seats, players: pNames });
      } else if (!onlineMode) {
        initGame(gameMode, vsMode);
      }
    });
    $('btnToMenu').addEventListener('click', () => {
      gamePhase = 'menu';
      if (aiTimerRef) clearTimeout(aiTimerRef);
      $('gameArea').style.display = 'none';
      if (onlineMode) {
        $('onlineRoom').style.display = '';
        renderOnlinePlayers();
      } else {
        $('modeScreen').style.display = '';
      }
      $('goOverlay').classList.remove('show');
    });
    $('btnBackLobby').addEventListener('click', () => { location.href = '/'; });

    requestAnimationFrame(loop);
  }

  init();
})();

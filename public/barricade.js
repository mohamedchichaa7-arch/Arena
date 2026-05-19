/* ═══════════════════════════════════════════════════════════════════
   BARRICADE — Arena Game  (Quoridor-style)
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const GRID = 9;
  const MAX_WALLS = 10;
  const DIRS = [[0,1],[0,-1],[1,0],[-1,0]];

  // DOM
  const $ = id => document.getElementById(id);
  const modeOverlay = $('modeOverlay');
  const gameContainer = $('gameContainer');
  const boardEl = $('board');
  const turnText = $('turnText');
  const turnDot = $('turnDot');
  const p1Walls = $('p1Walls');
  const p2Walls = $('p2Walls');
  const p1Info = $('p1Info');
  const p2Info = $('p2Info');
  const p1Name = $('p1Name');
  const p2Name = $('p2Name');
  const btnMove = $('btnMove');
  const btnWall = $('btnWall');
  const actionHint = $('actionHint');
  const resultOverlay = $('resultOverlay');
  const resultTitle = $('resultTitle');
  const resultSub = $('resultSub');
  const rulesOverlay = $('rulesOverlay');
  const confettiCvs = $('confetti');
  const cctx = confettiCvs.getContext('2d');

  // State
  let mode = null; // 'pvp' | 'bot'
  let players = [];
  let walls = [];
  let currentPlayer = 0;
  let action = 'move'; // 'move' | 'wall'
  let gameOver = false;
  let cells = [];
  let wallSlots = [];
  let pawnEls = [];

  // ══════════════════════════════════════════════════════════════════
  //  INITIALIZATION
  // ══════════════════════════════════════════════════════════════════

  function initGame(selectedMode) {
    mode = selectedMode;
    modeOverlay.style.display = 'none';
    gameContainer.style.display = 'flex';
    resultOverlay.style.display = 'none';

    players = [
      { row: 0, col: 4, wallsLeft: MAX_WALLS, goalRow: GRID - 1 },
      { row: GRID - 1, col: 4, wallsLeft: MAX_WALLS, goalRow: 0 }
    ];
    walls = [];
    currentPlayer = 0;
    action = 'move';
    gameOver = false;

    if (mode === 'bot') {
      p2Name.textContent = 'Bot 🤖';
    } else {
      p2Name.textContent = 'Player 2';
    }

    buildBoard();
    updateUI();
  }

  function buildBoard() {
    boardEl.innerHTML = '';
    cells = [];
    wallSlots = [];
    pawnEls = [];

    // Create cells
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.r = r;
        cell.dataset.c = c;
        if (r === GRID - 1) cell.classList.add('goal-p1'); // P1 goal
        if (r === 0) cell.classList.add('goal-p2'); // P2 goal
        cell.addEventListener('click', () => onCellClick(r, c));
        boardEl.appendChild(cell);
        cells.push(cell);
      }
    }

    // Create wall slots (overlaid on gaps)
    createWallSlots();

    // Create pawns
    for (let i = 0; i < 2; i++) {
      const pawn = document.createElement('div');
      pawn.className = `pawn p${i + 1}`;
      pawn.textContent = i === 0 ? '▲' : '▼';
      pawnEls.push(pawn);
    }
    placePawns();
  }

  function createWallSlots() {
    // Horizontal walls: between rows r and r+1, spanning cols c and c+1
    for (let r = 0; r < GRID - 1; r++) {
      for (let c = 0; c < GRID - 1; c++) {
        const slot = document.createElement('div');
        slot.className = 'wall-slot horizontal';
        slot.dataset.type = 'h';
        slot.dataset.r = r;
        slot.dataset.c = c;
        slot.addEventListener('click', () => onWallClick('h', r, c));
        slot.addEventListener('mouseenter', () => onWallHover('h', r, c));
        slot.addEventListener('mouseleave', () => onWallLeave('h', r, c));
        boardEl.appendChild(slot);
        wallSlots.push(slot);
      }
    }
    // Vertical walls: between cols c and c+1, spanning rows r and r+1
    for (let r = 0; r < GRID - 1; r++) {
      for (let c = 0; c < GRID - 1; c++) {
        const slot = document.createElement('div');
        slot.className = 'wall-slot vertical';
        slot.dataset.type = 'v';
        slot.dataset.r = r;
        slot.dataset.c = c;
        slot.addEventListener('click', () => onWallClick('v', r, c));
        slot.addEventListener('mouseenter', () => onWallHover('v', r, c));
        slot.addEventListener('mouseleave', () => onWallLeave('v', r, c));
        boardEl.appendChild(slot);
        wallSlots.push(slot);
      }
    }
    requestAnimationFrame(positionWallSlots);
  }

  function positionWallSlots() {
    if (cells.length === 0) return;
    const boardRect = boardEl.getBoundingClientRect();
    if (boardRect.width === 0) {
      requestAnimationFrame(positionWallSlots);
      return;
    }

    // Get actual cell positions from the first few cells
    const c00 = cells[0].getBoundingClientRect();          // row 0, col 0
    const c01 = cells[1].getBoundingClientRect();          // row 0, col 1
    const c10 = cells[GRID].getBoundingClientRect();       // row 1, col 0
    const cellW = c00.width;
    const cellH = c00.height;
    const gapH = c01.left - c00.right;  // horizontal gap between cols
    const gapV = c10.top - c00.bottom;  // vertical gap between rows

    wallSlots.forEach(slot => {
      const type = slot.dataset.type;
      const r = parseInt(slot.dataset.r);
      const c = parseInt(slot.dataset.c);

      // Get cell positions relative to board
      const cellIdx = r * GRID + c;
      const cellRect = cells[cellIdx].getBoundingClientRect();
      const offX = cellRect.left - boardRect.left;
      const offY = cellRect.top - boardRect.top;

      if (type === 'h') {
        // Horizontal wall between row r and r+1, spanning col c and c+1
        slot.style.top = (offY + cellH) + 'px';
        slot.style.left = offX + 'px';
        slot.style.width = (2 * cellW + gapH) + 'px';
        slot.style.height = Math.max(gapV, 6) + 'px';
      } else {
        // Vertical wall between col c and c+1, spanning row r and r+1
        slot.style.top = offY + 'px';
        slot.style.left = (offX + cellW) + 'px';
        slot.style.width = Math.max(gapH, 6) + 'px';
        slot.style.height = (2 * cellH + gapV) + 'px';
      }
    });
  }

  const resizeObserver = new ResizeObserver(() => positionWallSlots());
  resizeObserver.observe(boardEl);

  function placePawns() {
    // Remove existing pawns from cells
    pawnEls.forEach(p => p.remove());
    for (let i = 0; i < 2; i++) {
      const p = players[i];
      const cell = getCell(p.row, p.col);
      if (cell) cell.appendChild(pawnEls[i]);
    }
  }

  function getCell(r, c) {
    return cells[r * GRID + c] || null;
  }

  // ══════════════════════════════════════════════════════════════════
  //  MOVEMENT LOGIC
  // ══════════════════════════════════════════════════════════════════

  function canPassBetween(r1, c1, r2, c2) {
    // Check if a wall blocks passage between adjacent cells (r1,c1) and (r2,c2)
    for (const w of walls) {
      if (w.type === 'h') {
        // Horizontal wall at (wr, wc): blocks (wr,wc)↔(wr+1,wc) and (wr,wc+1)↔(wr+1,wc+1)
        if (r2 === r1 + 1 && c1 === c2) {
          // Moving down from (r1,c1) to (r1+1, c1)
          if (w.r === r1 && (w.c === c1 || w.c === c1 - 1)) return false;
        }
        if (r2 === r1 - 1 && c1 === c2) {
          // Moving up from (r1,c1) to (r1-1, c1)
          if (w.r === r1 - 1 && (w.c === c1 || w.c === c1 - 1)) return false;
        }
      }
      if (w.type === 'v') {
        // Vertical wall at (wr, wc): blocks (wr,wc)↔(wr,wc+1) and (wr+1,wc)↔(wr+1,wc+1)
        if (c2 === c1 + 1 && r1 === r2) {
          // Moving right from (r1,c1) to (r1, c1+1)
          if (w.c === c1 && (w.r === r1 || w.r === r1 - 1)) return false;
        }
        if (c2 === c1 - 1 && r1 === r2) {
          // Moving left from (r1,c1) to (r1, c1-1)
          if (w.c === c1 - 1 && (w.r === r1 || w.r === r1 - 1)) return false;
        }
      }
    }
    return true;
  }

  function getValidMoves(playerIdx) {
    const p = players[playerIdx];
    const opp = players[1 - playerIdx];
    const moves = [];

    for (const [dr, dc] of DIRS) {
      const nr = p.row + dr;
      const nc = p.col + dc;
      if (nr < 0 || nr >= GRID || nc < 0 || nc >= GRID) continue;
      if (!canPassBetween(p.row, p.col, nr, nc)) continue;

      // Check if opponent is there
      if (nr === opp.row && nc === opp.col) {
        // Try to jump over opponent
        const jr = nr + dr;
        const jc = nc + dc;
        if (jr >= 0 && jr < GRID && jc >= 0 && jc < GRID &&
            canPassBetween(nr, nc, jr, jc)) {
          moves.push({ row: jr, col: jc });
        } else {
          // Can't jump straight, try diagonals from opponent's position
          for (const [dr2, dc2] of DIRS) {
            if (dr2 === -dr && dc2 === -dc) continue; // Don't go back
            const sr = nr + dr2;
            const sc = nc + dc2;
            if (sr < 0 || sr >= GRID || sc < 0 || sc >= GRID) continue;
            if (sr === p.row && sc === p.col) continue;
            if (!canPassBetween(nr, nc, sr, sc)) continue;
            moves.push({ row: sr, col: sc });
          }
        }
      } else {
        moves.push({ row: nr, col: nc });
      }
    }
    return moves;
  }

  // ══════════════════════════════════════════════════════════════════
  //  WALL LOGIC
  // ══════════════════════════════════════════════════════════════════

  function isWallValid(type, r, c) {
    if (r < 0 || r >= GRID - 1 || c < 0 || c >= GRID - 1) return false;
    // Check overlap
    for (const w of walls) {
      if (w.type === type && w.r === r && w.c === c) return false;
      // Same position different type (crossing)
      if (w.type !== type && w.r === r && w.c === c) return false;
      // Adjacent same-type overlap
      if (w.type === 'h' && type === 'h' && w.r === r && Math.abs(w.c - c) === 1) return false;
      if (w.type === 'v' && type === 'v' && w.c === c && Math.abs(w.r - r) === 1) return false;
    }
    return true;
  }

  function bfs(startRow, startCol, goalRow, wallSet) {
    // BFS from (startRow, startCol) to any cell in goalRow
    const visited = new Set();
    const queue = [[startRow, startCol, 0]];
    visited.add(startRow * GRID + startCol);

    while (queue.length > 0) {
      const [r, c, dist] = queue.shift();
      if (r === goalRow) return dist;

      for (const [dr, dc] of DIRS) {
        const nr = r + dr;
        const nc = c + dc;
        if (nr < 0 || nr >= GRID || nc < 0 || nc >= GRID) continue;
        if (visited.has(nr * GRID + nc)) continue;
        if (!canPassBetweenWithWalls(r, c, nr, nc, wallSet)) continue;
        visited.add(nr * GRID + nc);
        queue.push([nr, nc, dist + 1]);
      }
    }
    return -1; // No path
  }

  function canPassBetweenWithWalls(r1, c1, r2, c2, wallSet) {
    for (const w of wallSet) {
      if (w.type === 'h') {
        if (r2 === r1 + 1 && c1 === c2) {
          if (w.r === r1 && (w.c === c1 || w.c === c1 - 1)) return false;
        }
        if (r2 === r1 - 1 && c1 === c2) {
          if (w.r === r1 - 1 && (w.c === c1 || w.c === c1 - 1)) return false;
        }
      }
      if (w.type === 'v') {
        if (c2 === c1 + 1 && r1 === r2) {
          if (w.c === c1 && (w.r === r1 || w.r === r1 - 1)) return false;
        }
        if (c2 === c1 - 1 && r1 === r2) {
          if (w.c === c1 - 1 && (w.r === r1 || w.r === r1 - 1)) return false;
        }
      }
    }
    return true;
  }

  function wouldBlockPath(type, r, c) {
    const testWalls = [...walls, { type, r, c }];
    for (let i = 0; i < 2; i++) {
      const dist = bfs(players[i].row, players[i].col, players[i].goalRow, testWalls);
      if (dist === -1) return true;
    }
    return false;
  }

  function canPlaceWall(type, r, c) {
    if (players[currentPlayer].wallsLeft <= 0) return false;
    if (!isWallValid(type, r, c)) return false;
    if (wouldBlockPath(type, r, c)) return false;
    return true;
  }

  // ══════════════════════════════════════════════════════════════════
  //  UI UPDATE
  // ══════════════════════════════════════════════════════════════════

  function updateUI() {
    // Player info
    p1Walls.textContent = `🧱 ×${players[0].wallsLeft}`;
    p2Walls.textContent = `🧱 ×${players[1].wallsLeft}`;

    // Turn indicator
    const name = currentPlayer === 0 ? p1Name.textContent : p2Name.textContent;
    turnText.textContent = `${name}'s Turn`;
    turnDot.style.background = currentPlayer === 0 ? 'var(--p1)' : 'var(--p2)';

    // Active player highlight
    p1Info.classList.toggle('active-turn', currentPlayer === 0);
    p2Info.classList.toggle('active-turn', currentPlayer === 1);

    // Pawn active state
    pawnEls[0].classList.toggle('active', currentPlayer === 0);
    pawnEls[1].classList.toggle('active', currentPlayer === 1);

    // Action buttons
    btnMove.classList.toggle('active', action === 'move');
    btnWall.classList.toggle('active', action === 'wall');
    btnWall.disabled = players[currentPlayer].wallsLeft <= 0;

    if (action === 'move') {
      actionHint.textContent = 'Click a highlighted cell to move';
    } else {
      actionHint.textContent = 'Click between cells to place a barricade';
    }

    // Highlight valid moves
    highlightValidMoves();

    // Show/hide wall slots
    wallSlots.forEach(slot => {
      if (slot.classList.contains('placed')) return;
      slot.style.display = action === 'wall' ? 'block' : 'none';
    });

    // Reposition wall slots
    positionWallSlots();
  }

  function highlightValidMoves() {
    cells.forEach(cell => cell.classList.remove('valid-move'));
    if (action !== 'move' || gameOver) return;

    const moves = getValidMoves(currentPlayer);
    for (const m of moves) {
      const cell = getCell(m.row, m.col);
      if (cell) cell.classList.add('valid-move');
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  EVENT HANDLERS
  // ══════════════════════════════════════════════════════════════════

  function onCellClick(r, c) {
    if (gameOver) return;
    if (action !== 'move') return;
    if (mode === 'bot' && currentPlayer === 1) return; // Bot's turn

    const moves = getValidMoves(currentPlayer);
    const move = moves.find(m => m.row === r && m.col === c);
    if (!move) return;

    executeMove(r, c);
  }

  function executeMove(r, c) {
    players[currentPlayer].row = r;
    players[currentPlayer].col = c;

    // Animate pawn
    const cell = getCell(r, c);
    const pawn = pawnEls[currentPlayer];
    pawn.remove();
    cell.appendChild(pawn);

    // Check win
    if (r === players[currentPlayer].goalRow) {
      endGame(currentPlayer);
      return;
    }

    endTurn();
  }

  function onWallClick(type, r, c) {
    if (gameOver) return;
    if (action !== 'wall') return;
    if (mode === 'bot' && currentPlayer === 1) return;

    if (!canPlaceWall(type, r, c)) return;

    placeWall(type, r, c, currentPlayer);
    endTurn();
  }

  function placeWall(type, r, c, playerIdx) {
    walls.push({ type, r, c, player: playerIdx });
    players[playerIdx].wallsLeft--;

    // Mark the slot as placed
    const slot = wallSlots.find(s =>
      s.dataset.type === type &&
      parseInt(s.dataset.r) === r &&
      parseInt(s.dataset.c) === c
    );
    if (slot) {
      slot.classList.add('placed', `p${playerIdx + 1}-wall`);
      slot.classList.remove('preview');
      slot.style.display = 'block';
    }
  }

  function onWallHover(type, r, c) {
    if (action !== 'wall' || gameOver) return;
    if (mode === 'bot' && currentPlayer === 1) return;
    const slot = wallSlots.find(s =>
      s.dataset.type === type &&
      parseInt(s.dataset.r) === r &&
      parseInt(s.dataset.c) === c
    );
    if (!slot || slot.classList.contains('placed')) return;

    if (canPlaceWall(type, r, c)) {
      slot.classList.add('preview');
      slot.classList.remove('invalid');
    } else {
      slot.classList.add('invalid');
    }
  }

  function onWallLeave(type, r, c) {
    const slot = wallSlots.find(s =>
      s.dataset.type === type &&
      parseInt(s.dataset.r) === r &&
      parseInt(s.dataset.c) === c
    );
    if (slot) {
      slot.classList.remove('preview', 'invalid');
    }
  }

  function endTurn() {
    currentPlayer = 1 - currentPlayer;
    action = 'move';
    updateUI();

    // Bot turn
    if (mode === 'bot' && currentPlayer === 1 && !gameOver) {
      btnMove.disabled = true;
      btnWall.disabled = true;
      setTimeout(botTurn, 600);
    }
  }

  function endGame(winner) {
    gameOver = true;
    const name = winner === 0 ? p1Name.textContent : p2Name.textContent;
    resultTitle.textContent = `${name} Wins!`;
    resultSub.textContent = 'Reached the other side!';
    resultOverlay.style.display = 'flex';
    launchConfetti();
  }

  // ══════════════════════════════════════════════════════════════════
  //  BOT AI
  // ══════════════════════════════════════════════════════════════════

  function botTurn() {
    if (gameOver) return;

    const botIdx = 1;
    const oppIdx = 0;

    // 1. Check if bot can win in one move
    const moves = getValidMoves(botIdx);
    const winMove = moves.find(m => m.row === players[botIdx].goalRow);
    if (winMove) {
      executeMove(winMove.row, winMove.col);
      return;
    }

    // 2. Evaluate wall placements vs moving
    const myPath = bfs(players[botIdx].row, players[botIdx].col, players[botIdx].goalRow, walls);
    const oppPath = bfs(players[oppIdx].row, players[oppIdx].col, players[oppIdx].goalRow, walls);

    let bestWall = null;
    let bestWallScore = 0;

    if (players[botIdx].wallsLeft > 0) {
      // Sample wall placements (check all, but limit computation)
      for (let r = 0; r < GRID - 1; r++) {
        for (let c = 0; c < GRID - 1; c++) {
          for (const type of ['h', 'v']) {
            if (!canPlaceWall(type, r, c)) continue;

            const testWalls = [...walls, { type, r, c }];
            const newOppPath = bfs(players[oppIdx].row, players[oppIdx].col, players[oppIdx].goalRow, testWalls);
            const newMyPath = bfs(players[botIdx].row, players[botIdx].col, players[botIdx].goalRow, testWalls);

            if (newOppPath === -1 || newMyPath === -1) continue;

            const score = (newOppPath - oppPath) - (newMyPath - myPath) * 0.5;
            if (score > bestWallScore) {
              bestWallScore = score;
              bestWall = { type, r, c };
            }
          }
        }
      }
    }

    // 3. Decide: place wall or move
    if (bestWall && bestWallScore >= 2 && players[botIdx].wallsLeft > 3) {
      placeWall(bestWall.type, bestWall.r, bestWall.c, botIdx);
      endTurn();
    } else if (bestWall && bestWallScore >= 3) {
      placeWall(bestWall.type, bestWall.r, bestWall.c, botIdx);
      endTurn();
    } else {
      // Move along shortest path
      const bestMove = findBestMove(botIdx);
      if (bestMove) {
        executeMove(bestMove.row, bestMove.col);
      } else {
        // No moves available (shouldn't happen), just end turn
        endTurn();
      }
    }
  }

  function findBestMove(playerIdx) {
    const moves = getValidMoves(playerIdx);
    if (moves.length === 0) return null;

    let best = null;
    let bestDist = Infinity;

    for (const m of moves) {
      const dist = bfs(m.row, m.col, players[playerIdx].goalRow, walls);
      if (dist !== -1 && dist < bestDist) {
        bestDist = dist;
        best = m;
      }
    }
    return best || moves[0];
  }

  // ══════════════════════════════════════════════════════════════════
  //  CONFETTI
  // ══════════════════════════════════════════════════════════════════

  let confettiParts = [];
  let confettiAnim = null;

  function launchConfetti() {
    confettiCvs.width = window.innerWidth;
    confettiCvs.height = window.innerHeight;
    confettiParts = [];
    const colors = ['#ef4444', '#3b82f6', '#22c55e', '#fbbf24', '#8b5cf6', '#06b6d4'];
    for (let i = 0; i < 150; i++) {
      confettiParts.push({
        x: Math.random() * confettiCvs.width,
        y: Math.random() * confettiCvs.height - confettiCvs.height,
        w: Math.random() * 8 + 4,
        h: Math.random() * 6 + 3,
        color: colors[Math.floor(Math.random() * colors.length)],
        vx: (Math.random() - 0.5) * 4,
        vy: Math.random() * 3 + 2,
        rot: Math.random() * 360,
        vr: (Math.random() - 0.5) * 10
      });
    }
    if (confettiAnim) cancelAnimationFrame(confettiAnim);
    animateConfetti();
  }

  function animateConfetti() {
    cctx.clearRect(0, 0, confettiCvs.width, confettiCvs.height);
    let alive = false;
    for (const p of confettiParts) {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05;
      p.rot += p.vr;
      if (p.y < confettiCvs.height + 50) alive = true;
      cctx.save();
      cctx.translate(p.x, p.y);
      cctx.rotate(p.rot * Math.PI / 180);
      cctx.fillStyle = p.color;
      cctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      cctx.restore();
    }
    if (alive) confettiAnim = requestAnimationFrame(animateConfetti);
  }

  // ══════════════════════════════════════════════════════════════════
  //  EVENT BINDINGS
  // ══════════════════════════════════════════════════════════════════

  $('btnPvP').addEventListener('click', () => initGame('pvp'));
  $('btnBot').addEventListener('click', () => initGame('bot'));
  $('btnBackLobby').addEventListener('click', () => { location.href = '/'; });
  $('btnBack').addEventListener('click', () => {
    gameContainer.style.display = 'none';
    modeOverlay.style.display = 'flex';
    gameOver = true;
  });
  $('btnRules').addEventListener('click', () => { rulesOverlay.style.display = 'flex'; });
  $('rulesClose').addEventListener('click', () => { rulesOverlay.style.display = 'none'; });
  rulesOverlay.addEventListener('click', e => { if (e.target === rulesOverlay) rulesOverlay.style.display = 'none'; });

  $('btnPlayAgain').addEventListener('click', () => { initGame(mode); });
  $('btnBackMenu').addEventListener('click', () => {
    resultOverlay.style.display = 'none';
    gameContainer.style.display = 'none';
    modeOverlay.style.display = 'flex';
  });

  btnMove.addEventListener('click', () => {
    if (gameOver) return;
    if (mode === 'bot' && currentPlayer === 1) return;
    action = 'move';
    updateUI();
  });

  btnWall.addEventListener('click', () => {
    if (gameOver) return;
    if (mode === 'bot' && currentPlayer === 1) return;
    if (players[currentPlayer].wallsLeft <= 0) return;
    action = 'wall';
    updateUI();
  });

  // Resize handler
  window.addEventListener('resize', () => {
    positionWallSlots();
    confettiCvs.width = window.innerWidth;
    confettiCvs.height = window.innerHeight;
  });

})();

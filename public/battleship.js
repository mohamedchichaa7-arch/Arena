/* ═══════════════════════════════════════════════════════════════════
   Sea Battle — Battleship  (full multiplayer + all rules)
   ═══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  // ── Constants ────────────────────────────────────────────────────
  const GRID = 10;
  const SHIPS = [
    { name: 'Carrier',    size: 5, count: 1 },
    { name: 'Battleship', size: 4, count: 1 },
    { name: 'Cruiser',    size: 3, count: 1 },
    { name: 'Submarine',  size: 3, count: 1 },
    { name: 'Destroyer',  size: 2, count: 1 },
  ];

  // ── Session state ─────────────────────────────────────────────────
  const urlRoomId = new URLSearchParams(location.search).get('room');
  const myName    = sessionStorage.getItem('arena-name') || 'Captain';
  const myToken   = sessionStorage.getItem('arena-token') || '';

  // WS / online
  let ws         = null;
  let wsMyId     = null;
  let oppId      = null;
  let oppName    = 'Opponent';
  let iAmHost    = false;   // first joiner = host
  let myTurn     = false;
  let gameActive = false;

  // Placement state
  let myBoard      = createBoard();   // 0=empty, ship obj ref or 0
  let placedShips  = [];              // [{def, row, col, horiz, cells:[{r,c}]}]
  let dragShip     = null;            // {def, horiz, fromDock, fromPlaced}
  let dragOffset   = { r: 0, c: 0 }; // which cell within ship is grabbed
  let pendingRotate = false;

  // Battle state
  let myShots     = createBoard();   // 'hit'|'miss'|0
  let oppShots    = createBoard();   // 'hit'|'miss'|0  (shots fired at me)
  let mySunkCount = 0;
  let oppSunkCount= 0;

  // FX
  const fxCanvas  = document.getElementById('fxCanvas');
  const fxCtx     = fxCanvas.getContext('2d');
  let particles   = [];
  let fxRAF       = 0;

  // Audio context (lazy)
  let audioCtx    = null;

  // ── Utils ─────────────────────────────────────────────────────────
  function $ (id) { return document.getElementById(id); }
  function createBoard() {
    return Array.from({ length: GRID }, () => new Array(GRID).fill(0));
  }
  function colLetter(c) { return String.fromCharCode(65 + c); }

  // ── Audio ─────────────────────────────────────────────────────────
  function ensureAudio() {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  function playTone(freq, type, duration, gain) {
    try {
      ensureAudio();
      const osc = audioCtx.createOscillator();
      const g   = audioCtx.createGain();
      osc.connect(g); g.connect(audioCtx.destination);
      osc.type = type; osc.frequency.value = freq;
      g.gain.setValueAtTime(gain, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + duration);
      osc.start(); osc.stop(audioCtx.currentTime + duration);
    } catch {}
  }

  function sfxMiss()    { playTone(220, 'sine',   .4, .18); }
  function sfxHit()     { playTone(110, 'sawtooth',.3, .25); playTone(80,'square',.5,.15); }
  function sfxSunk()    {
    [200,150,100,60].forEach((f, i) => setTimeout(() => playTone(f,'sawtooth',.4,.3), i*80));
  }
  function sfxVictory() {
    [523,659,784,1046].forEach((f, i) => setTimeout(() => playTone(f,'sine',.4,.25), i*120));
  }
  function sfxDefeat()  {
    [220,196,174,131].forEach((f, i) => setTimeout(() => playTone(f,'sine',.6,.25), i*120));
  }
  function sfxPlace()   { playTone(440,'sine',.12,.12); }

  // ── Particle FX ──────────────────────────────────────────────────
  function resizeFx() {
    fxCanvas.width  = window.innerWidth;
    fxCanvas.height = window.innerHeight;
  }
  window.addEventListener('resize', resizeFx);
  resizeFx();

  function spawnExplosion(px, py, big) {
    const count = big ? 60 : 30;
    for (let i = 0; i < count; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = (2 + Math.random() * (big ? 7 : 4));
      particles.push({
        x: px, y: py,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        life: 1,
        decay: .02 + Math.random() * .03,
        r: 3 + Math.random() * (big ? 8 : 5),
        color: big
          ? `hsl(${20 + Math.random()*40},100%,${50+Math.random()*30}%)`
          : `hsl(${190 + Math.random()*40},80%,${60+Math.random()*30}%)`,
      });
    }
    if (!fxRAF) fxLoop();
  }

  function spawnSplash(px, py) {
    for (let i = 0; i < 18; i++) {
      const angle = -Math.PI/2 + (Math.random()-.5)*Math.PI*.8;
      const speed = 2 + Math.random()*3;
      particles.push({
        x: px, y: py,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed - 2,
        life: 1, decay: .035 + Math.random()*.02,
        r: 2 + Math.random()*4,
        color: `hsl(200,60%,${70+Math.random()*20}%)`,
      });
    }
    if (!fxRAF) fxLoop();
  }

  function fxLoop() {
    fxCtx.clearRect(0, 0, fxCanvas.width, fxCanvas.height);
    particles = particles.filter(p => p.life > 0);
    for (const p of particles) {
      p.x  += p.vx; p.y += p.vy;
      p.vy += .15;  // gravity
      p.life -= p.decay;
      fxCtx.globalAlpha = Math.max(0, p.life);
      fxCtx.fillStyle   = p.color;
      fxCtx.beginPath();
      fxCtx.arc(p.x, p.y, p.r, 0, Math.PI*2);
      fxCtx.fill();
    }
    fxCtx.globalAlpha = 1;
    if (particles.length > 0) {
      fxRAF = requestAnimationFrame(fxLoop);
    } else {
      fxRAF = 0;
    }
  }

  function cellCenter(gridEl, row, col) {
    const cells = gridEl.querySelectorAll('.cell');
    const idx   = row * GRID + col;
    if (idx >= cells.length) return { x: 0, y: 0 };
    const rect = cells[idx].getBoundingClientRect();
    return { x: rect.left + rect.width/2, y: rect.top + rect.height/2 };
  }

  // ── Board helpers ────────────────────────────────────────────────
  function canPlace(row, col, size, horiz, skip) {
    for (let i = 0; i < size; i++) {
      const r = horiz ? row       : row + i;
      const c = horiz ? col + i   : col;
      if (r < 0 || r >= GRID || c < 0 || c >= GRID) return false;
      const cell = myBoard[r][c];
      if (cell && cell !== skip) return false;
    }
    return true;
  }

  function placeShip(def, row, col, horiz) {
    const cells = [];
    for (let i = 0; i < def.size; i++) {
      const r = horiz ? row     : row + i;
      const c = horiz ? col + i : col;
      const ship = { def, horiz, row, col };
      myBoard[r][c] = ship;
      cells.push({ r, c });
    }
    const entry = { def, row, col, horiz, cells, hits: 0 };
    placedShips.push(entry);
    // Backfill correct ref (cell obj must point to entry)
    for (const { r, c } of cells) myBoard[r][c] = entry;
    sfxPlace();
    return entry;
  }

  function removeShip(entry) {
    for (const { r, c } of entry.cells) myBoard[r][c] = 0;
    placedShips = placedShips.filter(s => s !== entry);
  }

  function allShipsPlaced() {
    return SHIPS.every(def =>
      placedShips.filter(s => s.def.name === def.name).length >= def.count
    );
  }

  // ── Grid builder ─────────────────────────────────────────────────
  function buildGrid(el, clickHandler) {
    el.innerHTML = '';
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const cell = document.createElement('div');
        cell.className = 'cell';
        cell.dataset.r = r; cell.dataset.c = c;
        if (clickHandler) cell.addEventListener('click', () => clickHandler(r, c));
        el.appendChild(cell);
      }
    }
  }

  function buildColumnLabels(container) {
    const top = container.querySelector('.grid-labels-top');
    if (!top) return;
    top.innerHTML = '';
    for (let c = 0; c < GRID; c++) {
      const s = document.createElement('span');
      s.textContent = colLetter(c);
      top.appendChild(s);
    }
  }

  function buildRowLabels(leftEl) {
    leftEl.innerHTML = '';
    for (let r = 0; r < GRID; r++) {
      const s = document.createElement('div');
      s.className = 'grid-label-left';
      s.textContent = r + 1;
      leftEl.appendChild(s);
    }
  }

  // ── Placement Grid Render ─────────────────────────────────────────
  function renderPlacementGrid() {
    const grid = $('placementGrid');
    const cells = grid.querySelectorAll('.cell');
    for (const c of cells) c.className = 'cell';
    for (const ship of placedShips) {
      for (let i = 0; i < ship.cells.length; i++) {
        const { r, c } = ship.cells[i];
        const el = cells[r * GRID + c];
        el.classList.add('ship');
        if (!ship.horiz) el.classList.add('vert');
        if (i === 0) el.classList.add('ship-head');
        if (i === ship.cells.length - 1) el.classList.add('ship-tail');
      }
    }
  }

  function highlightPlacement(hRow, hCol, size, horiz, skip) {
    const grid  = $('placementGrid');
    const cells = grid.querySelectorAll('.cell');
    // Remove previous hover classes
    for (const c of cells) c.classList.remove('hover-valid','hover-invalid');
    if (hRow === null) return;

    const valid = canPlace(hRow, hCol, size, horiz, skip);
    for (let i = 0; i < size; i++) {
      const r = horiz ? hRow       : hRow + i;
      const c = horiz ? hCol + i   : hCol;
      if (r < 0 || r >= GRID || c < 0 || c >= GRID) continue;
      cells[r * GRID + c].classList.add(valid ? 'hover-valid' : 'hover-invalid');
    }
  }

  // ── Ship Dock ────────────────────────────────────────────────────
  function renderDock() {
    const dock = $('shipDock');
    dock.innerHTML = '';
    for (const def of SHIPS) {
      const placed = placedShips.filter(s => s.def.name === def.name).length;
      const isPlaced = placed >= def.count;

      const row = document.createElement('div');
      row.className = 'dock-ship' + (isPlaced ? ' placed' : '');
      row.dataset.ship = def.name;

      const label = document.createElement('span');
      label.className = 'dock-ship-label';
      label.textContent = def.name;
      row.appendChild(label);

      const blocks = document.createElement('div');
      blocks.className = 'ship-blocks';
      for (let i = 0; i < def.size; i++) {
        const b = document.createElement('div');
        b.className = 'ship-block';
        blocks.appendChild(b);
      }
      row.appendChild(blocks);

      if (!isPlaced) {
        row.style.touchAction = 'none';
        row.addEventListener('pointerdown', e => onDockPointerDown(e, def));
      }
      dock.appendChild(row);
    }
  }

  // ── Drag & Drop (Pointer Events — mouse + touch + stylus) ──────────
  let dragHoriz   = true;
  let isDragging  = false;
  let ghostEl     = null;
  let activePtrId = null;
  let lastPtrX = 0, lastPtrY = 0;

  /* Called when user presses down on a dock ship row */
  function onDockPointerDown(e, def) {
    if (isDragging) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    e.preventDefault();
    activePtrId = e.pointerId;
    isDragging  = true;
    dragShip    = { def, horiz: dragHoriz, fromDock: true, fromPlaced: null };
    dragOffset  = { r: 0, c: 0 };
    lastPtrX    = e.clientX; lastPtrY = e.clientY;
    createGhost();
  }

  function createGhost() {
    if (ghostEl) { ghostEl.remove(); ghostEl = null; }
    ghostEl = document.createElement('div');
    ghostEl.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;display:flex;gap:2px;opacity:.8;'
      + (dragShip.horiz ? '' : 'flex-direction:column;');
    for (let i = 0; i < dragShip.def.size; i++) {
      const b = document.createElement('div');
      b.style.cssText = 'width:30px;height:30px;flex-shrink:0;border-radius:4px;'
        + 'background:linear-gradient(135deg,#2563eb,#3b82f6);border:1px solid #60a5fa;';
      ghostEl.appendChild(b);
    }
    document.body.appendChild(ghostEl);
    positionGhost();
  }

  function positionGhost() {
    if (!ghostEl) return;
    ghostEl.style.left = (lastPtrX + 10) + 'px';
    ghostEl.style.top  = (lastPtrY + 10) + 'px';
  }

  function cleanupDrag() {
    isDragging = false; activePtrId = null;
    if (ghostEl) { ghostEl.remove(); ghostEl = null; }
    highlightPlacement(null, null, 0, true, null);
    dragShip = null;
  }

  function getCellUnderPointer(x, y) {
    if (ghostEl) ghostEl.style.visibility = 'hidden';
    const el = document.elementFromPoint(x, y);
    if (ghostEl) ghostEl.style.visibility = '';
    if (!el) return null;
    return el.classList && el.classList.contains('cell') ? el : el.closest && el.closest('.cell[data-r]');
  }

  document.addEventListener('pointermove', e => {
    if (!isDragging || e.pointerId !== activePtrId) return;
    e.preventDefault();
    lastPtrX = e.clientX; lastPtrY = e.clientY;
    positionGhost();
    if (dragShip) {
      const cell = getCellUnderPointer(e.clientX, e.clientY);
      if (cell && cell.closest('#placementGrid')) {
        highlightPlacement(
          +cell.dataset.r - dragOffset.r,
          +cell.dataset.c - dragOffset.c,
          dragShip.def.size, dragShip.horiz, dragShip.fromPlaced
        );
      } else {
        highlightPlacement(null, null, 0, true, null);
      }
    }
  }, { passive: false });

  document.addEventListener('pointerup', e => {
    if (!isDragging || e.pointerId !== activePtrId) return;
    if (dragShip) {
      const cell = getCellUnderPointer(e.clientX, e.clientY);
      if (cell && cell.closest('#placementGrid')) {
        tryDropShip(+cell.dataset.r - dragOffset.r, +cell.dataset.c - dragOffset.c);
      } else if (dragShip.fromPlaced) {
        const s = dragShip.fromPlaced;
        placeShip(s.def, s.row, s.col, s.horiz);
        renderPlacementGrid(); renderDock();
      }
    }
    cleanupDrag();
  });

  document.addEventListener('pointercancel', e => {
    if (e.pointerId !== activePtrId) return;
    if (dragShip && dragShip.fromPlaced) {
      const s = dragShip.fromPlaced;
      placeShip(s.def, s.row, s.col, s.horiz);
      renderPlacementGrid(); renderDock();
    }
    cleanupDrag();
  });

  // ── Placement grid setup ────────────────────────────────────────
  function setupPlacementGrid() {
    const grid = $('placementGrid');
    buildGrid(grid, null);
    renderPlacementGrid();
    setupCellEvents(grid);
  }

  function setupCellEvents(grid) {
    for (const cell of grid.querySelectorAll('.cell')) {
      const r = +cell.dataset.r, c = +cell.dataset.c;

      // Right-click: rotate dragged ship or placed ship
      cell.addEventListener('contextmenu', e => {
        e.preventDefault();
        if (isDragging && dragShip) {
          dragShip.horiz = !dragShip.horiz;
          dragHoriz = dragShip.horiz;
          if (ghostEl) { ghostEl.remove(); ghostEl = null; createGhost(); }
        } else {
          const existing = myBoard[r][c];
          if (existing && existing.def) rotateExistingShip(existing);
        }
      });

      // Pick up a placed ship from the grid
      cell.addEventListener('pointerdown', e => {
        if (isDragging) return;
        if (e.pointerType === 'mouse' && e.button !== 0) return;
        const existing = myBoard[r][c];
        if (!existing || !existing.def) return;
        e.preventDefault(); e.stopPropagation();
        const idx = existing.cells.findIndex(p => p.r === r && p.c === c);
        dragOffset  = existing.horiz ? { r: 0, c: idx } : { r: idx, c: 0 };
        dragShip    = { def: existing.def, horiz: existing.horiz, fromDock: false, fromPlaced: existing };
        activePtrId = e.pointerId;
        isDragging  = true;
        lastPtrX = e.clientX; lastPtrY = e.clientY;
        removeShip(existing); renderPlacementGrid(); renderDock();
        createGhost();
      }, { passive: false });
    }
  }

  function tryDropShip(row, col) {
    if (!dragShip) return;
    if (canPlace(row, col, dragShip.def.size, dragShip.horiz, dragShip.fromPlaced)) {
      if (dragShip.fromPlaced) removeShip(dragShip.fromPlaced);
      placeShip(dragShip.def, row, col, dragShip.horiz);
    } else if (dragShip.fromPlaced) {
      placeShip(dragShip.fromPlaced.def, dragShip.fromPlaced.row, dragShip.fromPlaced.col, dragShip.fromPlaced.horiz);
    }
    renderPlacementGrid(); renderDock(); updateReadyBtn();
    dragShip = null;
    highlightPlacement(null, null, 0, true, null);
  }

  function rotateExistingShip(entry) {
    const r = entry.row, c = entry.col;
    const newH = !entry.horiz;
    removeShip(entry);
    if (canPlace(r, c, entry.def.size, newH, null)) {
      placeShip(entry.def, r, c, newH);
    } else {
      // Try to fit after rotation
      placeShip(entry.def, r, c, entry.horiz);
    }
    renderPlacementGrid();
    renderDock();
    updateReadyBtn();
  }

  // R key while dragging: rotate ghost ship
  document.addEventListener('keydown', e => {
    if ((e.key === 'r' || e.key === 'R') && isDragging && dragShip) {
      dragShip.horiz = !dragShip.horiz;
      dragHoriz = dragShip.horiz;
      if (ghostEl) { ghostEl.remove(); ghostEl = null; createGhost(); }
    }
  });

  // ── Auto-placement ───────────────────────────────────────────────
  function autoPlace() {
    // Clear
    myBoard = createBoard();
    placedShips = [];

    for (const def of SHIPS) {
      for (let attempt = 0; attempt < 1000; attempt++) {
        const horiz = Math.random() < .5;
        const row   = Math.floor(Math.random() * GRID);
        const col   = Math.floor(Math.random() * GRID);
        if (canPlace(row, col, def.size, horiz, null)) {
          placeShip(def, row, col, horiz);
          break;
        }
      }
    }
    renderPlacementGrid();
    renderDock();
    updateReadyBtn();
  }

  function resetPlacement() {
    myBoard = createBoard();
    placedShips = [];
    dragHoriz = true;
    renderPlacementGrid();
    renderDock();
    updateReadyBtn();
  }

  function updateReadyBtn() {
    const btn = $('btnReady');
    if (!btn) return;
    btn.disabled = !allShipsPlaced();
    $('placementMsg').textContent = allShipsPlaced()
      ? '✅ All ships placed — click Ready when you are!'
      : `Place ${SHIPS.reduce((a,d) => a + d.count - placedShips.filter(s=>s.def.name===d.name).length, 0)} more ship(s)`;
  }

  // ── Fleet status bars ─────────────────────────────────────────────
  function renderFleetStatus(el, ships, sunkNames) {
    el.innerHTML = '';
    for (const def of SHIPS) {
      const bar = document.createElement('div');
      bar.className = 'fs-ship' + (sunkNames.includes(def.name) ? ' sunk-bar' : '');
      bar.style.width = (def.size * 14) + 'px';
      bar.title = def.name + ' (' + def.size + ')';
      el.appendChild(bar);
    }
  }

  // ── Battle Grid Render ────────────────────────────────────────────
  function renderSelfGrid() {
    const cells = $('selfGrid').querySelectorAll('.cell');
    // Draw ships
    for (const ship of placedShips) {
      for (let i = 0; i < ship.cells.length; i++) {
        const { r, c } = ship.cells[i];
        const el = cells[r * GRID + c];
        el.classList.add('ship');
        if (!ship.horiz) el.classList.add('vert');
        if (i === 0) el.classList.add('ship-head');
        if (i === ship.cells.length-1) el.classList.add('ship-tail');
      }
    }
    // Draw opponent's shots on my board
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const st = oppShots[r][c];
        if (st) cells[r*GRID+c].classList.add(st);
      }
    }
  }

  function renderEnemyGrid() {
    const cells = $('enemyGrid').querySelectorAll('.cell');
    for (let r = 0; r < GRID; r++) {
      for (let c = 0; c < GRID; c++) {
        const st = myShots[r][c];
        cells[r*GRID+c].classList.remove('hit','miss','sunk');
        if (st) cells[r*GRID+c].classList.add(st);
      }
    }
  }

  // ── Battle Log ────────────────────────────────────────────────────
  function addLog(msg, cls) {
    const log = $('battleLog');
    const e   = document.createElement('div');
    e.className = 'log-entry' + (cls ? ' ' + cls : '');
    e.textContent = msg;
    log.prepend(e);
  }

  // ── Turn display ─────────────────────────────────────────────────
  function setTurnDisplay(mine) {
    const el = $('turnDisplay');
    el.textContent = mine ? 'Your Turn 🎯' : `${oppName}'s Turn…`;
    el.classList.toggle('enemy-turn', !mine);
  }

  // ── Fire shot ─────────────────────────────────────────────────────
  function fireAt(row, col) {
    if (!myTurn || !gameActive) return;
    if (myShots[row][col]) return; // already shot here
    myTurn = false;
    setTurnDisplay(false);
    wsSend({ type: 'bs-fire', row, col });
  }

  // ── WS ────────────────────────────────────────────────────────────
  function wsSend(msg) {
    if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg));
  }

  function connectWS() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);

    ws.onopen = () => {
      const pw = sessionStorage.getItem('arena-room-password') || '';
      sessionStorage.removeItem('arena-room-password');
      wsSend({ type: 'join-room', roomId: urlRoomId, name: myName, password: pw, token: myToken });
    };

    ws.onmessage = e => {
      try { handleMsg(JSON.parse(e.data)); } catch {}
    };

    ws.onclose = () => {
      $('wr-status').textContent = 'Disconnected — returning to lobby…';
      setTimeout(() => location.href = '/', 3000);
    };
  }

  function handleMsg(msg) {
    switch (msg.type) {

      case 'room-joined': {
        wsMyId  = msg.myId;
        iAmHost = msg.players.length === 0; // no one else yet = I'm first
        updateWaitingRoom(msg.players);
        break;
      }

      case 'player-joined': {
        oppId   = msg.id;
        oppName = msg.name;
        updateWaitingRoom([{ id: msg.id, name: msg.name }]);
        break;
      }

      case 'player-left': {
        if (gameActive) {
          addLog(`${oppName} disconnected — you win!`, 'log-win');
          endGame(true, `${oppName} left the game`);
        } else {
          oppId   = null;
          oppName = 'Opponent';
          $('wr-status').textContent = 'Opponent left. Waiting for someone to join…';
          updateWaitingRoom([]);
        }
        break;
      }

      // Server confirmed both players ready — battle begins
      case 'bs-start': {
        // msg: { firstTurn: wsMyId or oppId, oppName }
        oppName  = msg.oppName || oppName;
        myTurn   = msg.firstTurn === wsMyId;
        gameActive = true;
        startBattle();
        break;
      }

      // Result of MY shot coming back from server
      case 'bs-shot-result': {
        // msg: { row, col, result:'hit'|'miss', sunk: shipName|null, win: bool }
        applyMyShot(msg);
        break;
      }

      // Opponent fired at me
      case 'bs-inbound': {
        // msg: { row, col, result:'hit'|'miss', sunk: shipName|null, win: bool }
        applyInboundShot(msg);
        break;
      }

      case 'error': {
        alert(msg.msg);
        break;
      }
    }
  }

  // ── Waiting Room UI ───────────────────────────────────────────────
  function updateWaitingRoom(others) {
    const el = $('wr-players');
    el.innerHTML = '';

    const addCard = (name, isReady) => {
      const card = document.createElement('div');
      card.className = 'wr-card' + (isReady ? '' : ' waiting');
      card.innerHTML = `<span class="wr-dot"></span><span>${name}</span>`;
      el.appendChild(card);
    };

    addCard(myName, true);
    for (const p of others) addCard(p.name, true);

    if (others.length === 0) {
      $('wr-status').textContent = 'Waiting for opponent to join…';
    } else {
      oppId   = others[0].id;
      oppName = others[0].name;
      $('wr-status').textContent = 'Opponent found! Place your ships.';
      showPlacementScreen();
    }
  }

  // ── Screens ───────────────────────────────────────────────────────
  function showPlacementScreen() {
    $('waitingRoom').style.display    = 'none';
    $('placementScreen').style.display = '';
    $('battleScreen').style.display   = 'none';

    const gridEl = $('placementGrid');
    setupPlacementGrid();

    // Build column + row labels
    const wrap = gridEl.closest('.grid-wrap');
    const top  = wrap?.previousElementSibling;
    if (top?.classList.contains('grid-labels-top')) {
      top.innerHTML = '';
      for (let c = 0; c < GRID; c++) {
        const s = document.createElement('span');
        s.textContent = colLetter(c);
        top.appendChild(s);
      }
    }
    const left = gridEl.previousElementSibling;
    if (left?.classList.contains('grid-labels-left')) buildRowLabels(left);

    renderDock();
    updateReadyBtn();

    $('btnReady').onclick = () => {
      if (!allShipsPlaced()) return;
      $('btnReady').disabled = true;
      $('placementMsg').textContent = '⏳ Waiting for opponent to finish placing…';
      const layout = placedShips.map(s => ({
        name: s.def.name, size: s.def.size,
        row: s.row, col: s.col, horiz: s.horiz,
      }));
      wsSend({ type: 'bs-ready', layout });
    };

    $('btnAutoPlace').onclick     = autoPlace;
    $('btnResetPlacement').onclick = resetPlacement;

    // Rotate button: toggle orientation (affects next drag; also rotates last hovered ship)
    $('btnRotate').onclick = () => {
      dragHoriz = !dragHoriz;
      if (isDragging && dragShip) {
        dragShip.horiz = dragHoriz;
        createGhost();
      }
      $('placementMsg').textContent = `Orientation: ${dragHoriz ? 'Horizontal \u2192' : 'Vertical \u2193'}`;
      setTimeout(updateReadyBtn, 1200);
    };
  }

  function showBattleScreen() {
    $('waitingRoom').style.display    = 'none';
    $('placementScreen').style.display = 'none';
    $('battleScreen').style.display   = '';

    // Build both grids
    buildGrid($('selfGrid'),  null);
    buildGrid($('enemyGrid'), (r,c) => { if (myTurn && gameActive) fireAt(r, c); });

    renderSelfGrid();
    renderEnemyGrid();

    // Player names
    $('nameSelf').textContent = myName;
    $('nameOpp').textContent  = oppName;

    renderFleetStatus($('fleetSelf'), placedShips, []);
    renderFleetStatus($('fleetOpp'),  [], []);

    setTurnDisplay(myTurn);
    addLog('⚓ Battle started! ' + (myTurn ? 'You go first.' : `${oppName} goes first.`));
  }

  function startBattle() {
    myShots     = createBoard();
    oppShots    = createBoard();
    mySunkCount = 0;
    oppSunkCount= 0;
    showBattleScreen();
  }

  // ── Shot application ──────────────────────────────────────────────
  function applyMyShot(msg) {
    const { row, col, result, sunk, win } = msg;
    myShots[row][col] = result === 'hit' ? (sunk ? 'sunk' : 'hit') : 'miss';

    // If sunk, mark all cells of that ship
    if (sunk) {
      markSunkOnEnemy(msg.sunkCells);
      mySunkCount++;
      sfxSunk();
      addLog(`💥 You sunk their ${sunk}!`, 'log-sunk');
      const pos = cellCenter($('enemyGrid'), row, col);
      spawnExplosion(pos.x, pos.y, true);
    } else if (result === 'hit') {
      sfxHit();
      addLog(`🎯 HIT at ${colLetter(col)}${row+1}`, 'log-hit');
      const pos = cellCenter($('enemyGrid'), row, col);
      spawnExplosion(pos.x, pos.y, false);
    } else {
      sfxMiss();
      addLog(`🌊 Miss at ${colLetter(col)}${row+1}`, 'log-miss');
      const pos = cellCenter($('enemyGrid'), row, col);
      spawnSplash(pos.x, pos.y);
    }

    renderEnemyGrid();
    renderFleetStatus($('fleetOpp'), [],
      placedShips.filter((_,i) => false).map(s => s.def.name) // updated below
    );
    updateOppFleet();

    if (win) {
      endGame(true, 'You sunk the entire enemy fleet!');
      return;
    }

    // After hit: keep turn; after miss: switch
    if (result === 'hit' && !win) {
      myTurn = true;
      setTurnDisplay(true);
    } else {
      myTurn = false;
      setTurnDisplay(false);
    }
  }

  function applyInboundShot(msg) {
    const { row, col, result, sunk, sunkCells, win } = msg;
    oppShots[row][col] = result === 'hit' ? (sunk ? 'sunk' : 'hit') : 'miss';

    if (sunk) {
      markSunkOnSelf(sunkCells);
      oppSunkCount++;
      addLog(`💀 ${oppName} sunk your ${sunk}!`, 'log-sunk');
      const pos = cellCenter($('selfGrid'), row, col);
      spawnExplosion(pos.x, pos.y, true);
    } else if (result === 'hit') {
      addLog(`💥 ${oppName} hit your ship at ${colLetter(col)}${row+1}!`, 'log-hit');
      const pos = cellCenter($('selfGrid'), row, col);
      spawnExplosion(pos.x, pos.y, false);
    } else {
      addLog(`🌊 ${oppName} missed at ${colLetter(col)}${row+1}`, 'log-miss');
      const pos = cellCenter($('selfGrid'), row, col);
      spawnSplash(pos.x, pos.y);
    }

    renderSelfGrid();
    updateSelfFleet();

    if (win) {
      endGame(false, `${oppName} sunk your entire fleet!`);
      return;
    }

    // After hit: they keep turn; after miss: I get my turn
    if (result === 'hit' && !win) {
      myTurn = false;
      setTurnDisplay(false);
    } else {
      myTurn = true;
      setTurnDisplay(true);
    }
  }

  function markSunkOnEnemy(cells) {
    if (!cells) return;
    const gridCells = $('enemyGrid').querySelectorAll('.cell');
    for (const { r, c } of cells) {
      myShots[r][c] = 'sunk';
      gridCells[r*GRID+c].classList.remove('hit','miss');
      gridCells[r*GRID+c].classList.add('sunk');
    }
  }

  function markSunkOnSelf(cells) {
    if (!cells) return;
    const gridCells = $('selfGrid').querySelectorAll('.cell');
    for (const { r, c } of cells) {
      oppShots[r][c] = 'sunk';
      gridCells[r*GRID+c].classList.remove('hit','miss');
      gridCells[r*GRID+c].classList.add('sunk');
    }
  }

  let oppSunkShipNames = [];
  function updateOppFleet() {
    // Track sunk count by number
    renderFleetStatus($('fleetOpp'), [], oppSunkShipNames);
  }
  let selfSunkShipNames = [];
  function updateSelfFleet() {
    renderFleetStatus($('fleetSelf'), placedShips, selfSunkShipNames);
  }

  // ── Game Over ─────────────────────────────────────────────────────
  function endGame(won, reason) {
    gameActive = false;
    if (won) { sfxVictory(); } else { sfxDefeat(); }

    const title = $('goTitle');
    title.textContent = won ? '🏆 Victory!' : '💀 Defeat!';
    title.className = 'go-title' + (won ? '' : ' lose');
    $('goReason').textContent = reason || '';
    $('goOverlay').style.display = 'flex';

    addLog(won ? '🏆 You won!' : '💀 You lost!', 'log-win');
  }

  // ── Init ──────────────────────────────────────────────────────────
  function init() {
    // Topbar user
    try {
      if (typeof fbAuth !== 'undefined') {
        fbAuth.onAuthStateChanged(u => {
          if (u) $('topbarUser').textContent = u.displayName || u.email || '';
        });
      }
    } catch {}

    if (!urlRoomId) {
      // Not in a room → go to lobby
      location.href = '/';
      return;
    }

    // Show waiting room
    $('waitingRoom').style.display = '';

    $('btnLeaveRoom').onclick = () => { location.href = '/'; };

    // Rematch
    $('btnRematch').onclick = () => {
      $('goOverlay').style.display = 'none';
      myBoard     = createBoard();
      placedShips = [];
      dragHoriz   = true;
      showPlacementScreen();
    };
    $('btnToLobby').onclick = () => { location.href = '/'; };

    // Rules panel
    const rulesPanel = $('rulesPanel');
    $('btnRules').onclick = () => { rulesPanel.style.display = 'flex'; };
    $('rulesClose').onclick = () => { rulesPanel.style.display = 'none'; };
    rulesPanel.onclick = e => { if (e.target === rulesPanel) rulesPanel.style.display = 'none'; };

    connectWS();
  }

  init();
})();

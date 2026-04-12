/* ═══════════════════════════════════════════════════════════════════
   TANK BATTLE — Arena Room Client  |  tanks.js
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  // ── URL / session ────────────────────────────────────────────────
  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  const myName = sessionStorage.getItem('arena-name') || 'Player';
  if (!roomId) { location.href = '/'; return; }

  // ── DOM refs ─────────────────────────────────────────────────────
  const $ = s => document.getElementById(s);
  const statusEl = $('status');
  const playerListEl = $('playerList'), playerCountEl = $('playerCount');
  const roomBadge = $('roomBadge'), btnBack = $('btnBack');
  const btnStartGame = $('btnStartGame'), btnRematch = $('btnRematch');
  const resultOverlay = $('resultOverlay'), resultTitle = $('resultTitle');
  const resultSummary = $('resultSummary');
  const chatMessages = $('chatMessages'), chatInput = $('chatInput'), chatSend = $('chatSend');
  const canvas = $('gameCanvas'), ctx = canvas.getContext('2d');
  const windBar = $('windBar'), windArrow = $('windArrow'), windValue = $('windValue');
  const turnTimerEl = $('turnTimer'), timerValueEl = $('timerValue');
  const hudEl = $('hud');
  const preGameControls = $('preGameControls');
  const angleSlider = $('angleSlider'), angleValueEl = $('angleValue');
  const powerSlider = $('powerSlider'), powerValueEl = $('powerValue');
  const btnMoveLeft = $('btnMoveLeft'), btnMoveRight = $('btnMoveRight');
  const moveBudgetEl = $('moveBudget');
  const weaponSelector = $('weaponSelector');
  const btnFire = $('btnFire'), btnShield = $('btnShield');
  const airstrikeOverlay = $('airstrikeOverlay'), btnCancelAirstrike = $('btnCancelAirstrike');

  roomBadge.textContent = 'Room ' + roomId;

  // ── Constants ────────────────────────────────────────────────────
  const WORLD_W = 1200, WORLD_H = 600;
  const TANK_W = 30, TANK_H = 18;
  const GRAVITY = 0.15;
  const TANK_COLORS = ['#34d399', '#60a5fa', '#f472b6', '#fbbf24'];
  const WEAPON_DEFS = [
    { key: 'standard',  icon: '\u{1F535}', name: 'Standard',  ammo: Infinity },
    { key: 'heavy',     icon: '\u{1F4A5}', name: 'Heavy',     ammo: 3 },
    { key: 'cluster',   icon: '\u{1F300}', name: 'Cluster',   ammo: 2 },
    { key: 'sniper',    icon: '\u{1F3AF}', name: 'Sniper',    ammo: 3 },
    { key: 'airstrike', icon: '\u2601\uFE0F', name: 'Air Strike', ammo: 1 },
    { key: 'shield',    icon: '\u{1F6E1}\uFE0F', name: 'Shield',    ammo: 1 },
  ];

  // ── State ────────────────────────────────────────────────────────
  let ws = null, myId = null, leaderId = null;
  const others = new Map();
  let gameActive = false;
  let terrain = null; // Uint8Array — 1=solid, 0=air — WORLD_W*WORLD_H
  let tanks = {};     // id → { x, y, hp, alive, color, name, angle, shielded, colorIdx }
  let turnPlayerId = null;
  let isMyTurn = false;
  let moveBudget = 0;
  let currentWeapon = 'standard';
  let inventory = {};
  let wind = 0;
  let timerInterval = null;
  let timerValue = 30;
  let projectiles = []; // client animation
  let explosions = [];
  let floatingTexts = [];
  let shakeFrames = 0;
  let airstrikeMode = false;
  let cameraX = 0, cameraY = 0, cameraTargetX = 0, cameraTargetY = 0;
  let followingProjectile = false;
  let damageDealt = {};
  let crates = []; // { id, x, landY, currentY, landed, crateType, icon, label }

  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ══════════════════════════════════════════════════════════════════
  //  NETWORK
  // ══════════════════════════════════════════════════════════════════

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => {
      const password = sessionStorage.getItem('arena-room-password') || undefined;
      sessionStorage.removeItem('arena-room-password');
      wsSend({ type: 'join-room', roomId, name: myName, password, token: sessionStorage.getItem('arena-token') || '' });
    };
    ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch {} };
    ws.onclose = () => { statusEl.textContent = 'Disconnected. Returning to lobby…'; setTimeout(() => location.href = '/', 3000); };
  }
  function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  function handleMsg(msg) {
    switch (msg.type) {
      case 'room-joined':
        myId = msg.myId || 'self';
        leaderId = msg.leaderId;
        addPlayerCard('self', myName, true);
        for (const p of msg.players) addPlayerCard(p.id, p.name, false);
        updatePlayerCount();
        updateStartButton();
        statusEl.textContent = 'Waiting for players… Leader starts the game.';
        break;

      case 'player-joined':
        addPlayerCard(msg.id, msg.name, false);
        leaderId = msg.leaderId;
        updatePlayerCount();
        updateStartButton();
        break;

      case 'player-left':
        removePlayerCard(msg.id);
        leaderId = msg.leaderId;
        updatePlayerCount();
        updateStartButton();
        break;

      case 'tanks-start':
        onGameStart(msg);
        break;

      case 'tanks-turn':
        onTurnStart(msg);
        break;

      case 'tanks-crate-spawn':
        crates.push({ id: msg.id, x: msg.x, landY: msg.landY, currentY: 0, landed: false, crateType: msg.crateType, icon: msg.icon, label: msg.label });
        break;

      case 'tanks-crate-pickup':
        crates = crates.filter(c => c.id !== msg.crateId);
        // Update inventory + HP if it's our own pickup
        if (msg.pickedCrate) {
          const pc = msg.pickedCrate;
          if (pc.type === 'health') {
            if (tanks[myId]) tanks[myId].hp = msg.tankHp || tanks[myId].hp;
            updatePlayerHP(myId, tanks[myId]?.hp ?? 0, true);
          } else if (pc.payload?.weapon) {
            inventory[pc.payload.weapon] = (inventory[pc.payload.weapon] || 0) + (pc.payload.count || 1);
            buildWeaponUI();
          }
        }
        break;

      case 'tanks-move':
        onTankMove(msg);
        break;

      case 'tanks-fire-result':
        onFireResult(msg);
        break;

      case 'tanks-shield':
        onShieldUsed(msg);
        break;

      case 'tanks-timeout':
        onTurnTimeout(msg);
        break;

      case 'tanks-gameover':
        onGameOver(msg);
        break;

      case 'chat':
        appendChat(msg.id === myId ? 'me' : 'other', msg.name, msg.text);
        break;

      case 'error':
        statusEl.textContent = msg.msg;
        break;
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  GAME EVENTS
  // ══════════════════════════════════════════════════════════════════

  function onGameStart(msg) {
    gameActive = true;
    crates = [];
    preGameControls.style.display = 'none';
    windBar.style.display = '';
    resultOverlay.classList.remove('show');
    damageDealt = {};

    // Decode terrain
    terrain = new Uint8Array(WORLD_W * WORLD_H);
    const raw = atob(msg.terrain);
    for (let i = 0; i < raw.length; i++) {
      const byte = raw.charCodeAt(i);
      for (let b = 0; b < 8 && i * 8 + b < terrain.length; b++) {
        terrain[i * 8 + b] = (byte >> (7 - b)) & 1;
      }
    }

    // Init tanks
    tanks = {};
    for (const t of msg.tanks) {
      tanks[t.id] = { x: t.x, y: t.y, hp: t.hp, alive: true, color: TANK_COLORS[t.colorIdx] || '#ccc', name: t.name, angle: 90, shielded: false, colorIdx: t.colorIdx };
      damageDealt[t.id] = 0;
    }

    // Init inventory — new weapons start at 0; defaults come from server inventory
    inventory = {};
    for (const w of WEAPON_DEFS) {
      inventory[w.key] = (w.ammo === Infinity) ? Infinity : 0;
    }
    // Set defaults matching server starting inventory
    inventory.heavy = 5; inventory.cluster = 3; inventory.sniper = 4;
    inventory.airstrike = 2; inventory.shield = 2;

    currentWeapon = 'standard';
    buildWeaponUI();
    resizeCanvas();
    statusEl.textContent = 'Battle started!';
    requestAnimationFrame(renderLoop);
  }

  function onTurnStart(msg) {
    turnPlayerId = msg.playerId;
    wind = msg.wind;
    moveBudget = msg.moveBudget;
    isMyTurn = (turnPlayerId === myId);

    // Update wind display
    windValue.textContent = Math.abs(wind).toFixed(1);
    windArrow.textContent = wind >= 0 ? '→' : '←';
    windArrow.style.transform = wind >= 0 ? 'scaleX(1)' : 'scaleX(-1)';

    // Update sidebar turn indicator
    document.querySelectorAll('.player-card').forEach(el => el.classList.remove('active-turn'));
    const turnCard = document.querySelector(`.player-card[data-id="${turnPlayerId === myId ? 'self' : turnPlayerId}"]`);
    if (turnCard) turnCard.classList.add('active-turn');

    if (isMyTurn) {
      hudEl.style.display = '';
      turnTimerEl.style.display = '';
      moveBudgetEl.textContent = moveBudget;
      angleSlider.value = tanks[myId]?.angle || 90;
      angleValueEl.textContent = angleSlider.value;
      statusEl.textContent = 'Your turn! Aim and fire.';
      updateWeaponUI();
      // Update shield button
      btnShield.style.display = inventory.shield > 0 ? '' : 'none';
    } else {
      hudEl.style.display = 'none';
      turnTimerEl.style.display = '';
      const name = tanks[turnPlayerId]?.name || 'Player';
      statusEl.textContent = name + "'s turn…";
    }

    // Camera pan to active tank
    const t = tanks[turnPlayerId];
    if (t) {
      cameraTargetX = t.x - canvas.width / 2;
      cameraTargetY = t.y - canvas.height / 2;
    }
    followingProjectile = false;

    // Start timer
    timerValue = msg.timeLeft || 30;
    timerValueEl.textContent = timerValue;
    turnTimerEl.classList.remove('urgent');
    if (timerInterval) clearInterval(timerInterval);
    timerInterval = setInterval(() => {
      timerValue--;
      if (timerValue < 0) timerValue = 0;
      timerValueEl.textContent = timerValue;
      if (timerValue <= 5) turnTimerEl.classList.add('urgent');
      if (timerValue <= 0) clearInterval(timerInterval);
    }, 1000);
  }

  function onTankMove(msg) {
    const t = tanks[msg.playerId];
    if (t) { t.x = msg.x; t.y = msg.y; }
    if (msg.playerId === myId) {
      moveBudget = msg.moveBudget;
      moveBudgetEl.textContent = moveBudget;
      // Crate pickup feedback
      if (msg.pickedCrate) {
        const pc = msg.pickedCrate;
        addFloatingText(msg.x, msg.y - 30, pc.icon + ' ' + pc.label + '!', '#fbbf24');
        appendChat('system', '', 'You picked up ' + pc.label + '!');
        crates = crates.filter(c => c.id !== pc.id);
        // Update HP display if health crate
        if (pc.type === 'health' && msg.tankHp !== undefined) {
          t.hp = msg.tankHp;
          updatePlayerHP(myId, t.hp, true);
        }
        buildWeaponUI();
      }
    } else if (msg.pickedCrate) {
      // Someone else picked it up
      const pc = msg.pickedCrate;
      crates = crates.filter(c => c.id !== pc.id);
      addFloatingText(msg.x, msg.y - 30, pc.icon + ' ' + pc.label, tanks[msg.playerId]?.color || '#fff');
      appendChat('system', '', (tanks[msg.playerId]?.name || 'Player') + ' picked up ' + pc.label + '!');
    }
  }

  function onFireResult(msg) {
    if (timerInterval) clearInterval(timerInterval);
    turnTimerEl.style.display = 'none';
    hudEl.style.display = 'none';
    airstrikeMode = false;
    airstrikeOverlay.style.display = 'none';

    // Consume ammo locally
    if (msg.playerId === myId && msg.weapon !== 'standard') {
      if (inventory[msg.weapon] !== undefined && inventory[msg.weapon] !== Infinity) {
        inventory[msg.weapon]--;
      }
    }

    // Animate projectile(s)
    const projList = msg.projectiles || [];
    const impacts = msg.impacts || [];
    const terrainPatches = msg.terrainPatches || [];
    const damages = msg.damages || [];
    const tankUpdates = msg.tankUpdates || [];
    const kills = msg.kills || [];

    // Track damage
    for (const d of damages) {
      if (damageDealt[msg.playerId] !== undefined) damageDealt[msg.playerId] += d.damage;
    }

    // Animate projectiles then resolve
    animateProjectiles(projList, () => {
      // Apply impacts
      for (const imp of impacts) {
        addExplosion(imp.x, imp.y, imp.radius);
      }

      // Apply terrain patches
      for (const patch of terrainPatches) {
        const cx = patch.x, cy = patch.y, r = patch.radius;
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (dx * dx + dy * dy <= r * r) {
              const px = cx + dx, py = cy + dy;
              if (px >= 0 && px < WORLD_W && py >= 0 && py < WORLD_H) {
                terrain[py * WORLD_W + px] = 0;
              }
            }
          }
        }
      }

      // Apply damages
      for (const d of damages) {
        addFloatingText(d.x, d.y, '-' + d.damage, '#ef4444');
      }

      // Update tanks
      for (const u of tankUpdates) {
        const t = tanks[u.id];
        if (t) {
          t.hp = u.hp;
          t.x = u.x;
          t.y = u.y;
          t.alive = u.alive;
          t.shielded = u.shielded;
          updatePlayerHP(u.id, u.hp, u.alive);
        }
      }

      // Show kills
      for (const k of kills) {
        addFloatingText(k.x, k.y, k.name + ' destroyed!', '#fbbf24');
        appendChat('system', '', k.name + ' was destroyed!');
      }

      // Screen shake for large explosions
      const maxRadius = Math.max(0, ...impacts.map(i => i.radius));
      if (maxRadius >= 30) shakeFrames = 12;
      else if (maxRadius >= 15) shakeFrames = 6;
    });
  }

  function onShieldUsed(msg) {
    if (timerInterval) clearInterval(timerInterval);
    turnTimerEl.style.display = 'none';
    hudEl.style.display = 'none';
    const t = tanks[msg.playerId];
    if (t) t.shielded = true;
    addFloatingText(t?.x || 600, t?.y || 300, '🛡️ SHIELD!', '#06b6d4');
    appendChat('system', '', (t?.name || 'Player') + ' activated a shield!');
    if (msg.playerId === myId) {
      inventory.shield = 0;
    }
  }

  function onTurnTimeout(msg) {
    if (timerInterval) clearInterval(timerInterval);
    turnTimerEl.style.display = 'none';
    hudEl.style.display = 'none';
    airstrikeMode = false;
    airstrikeOverlay.style.display = 'none';
    if (msg.playerId === myId) {
      statusEl.textContent = 'Turn skipped (time out!)';
    } else {
      statusEl.textContent = (tanks[msg.playerId]?.name || 'Player') + "'s turn was skipped.";
    }
  }

  function onGameOver(msg) {
    gameActive = false;
    if (timerInterval) clearInterval(timerInterval);
    turnTimerEl.style.display = 'none';
    hudEl.style.display = 'none';
    windBar.style.display = 'none';

    const winner = msg.winner;
    if (winner) {
      resultTitle.textContent = winner.name + ' Wins!';
      if (winner.id === myId && typeof reportScore === 'function') {
        reportScore('tanks', 1);
      }
    } else {
      resultTitle.textContent = 'Draw!';
    }

    // Build summary
    let html = '';
    if (msg.summary) {
      for (const s of msg.summary) {
        html += `<div class="dmg-row"><span>${escapeHtml(s.name)}</span><span>${s.damageDealt} dmg dealt</span></div>`;
      }
    }
    resultSummary.innerHTML = html;
    setTimeout(() => resultOverlay.classList.add('show'), 1000);
  }

  // ══════════════════════════════════════════════════════════════════
  //  PLAYER ACTIONS
  // ══════════════════════════════════════════════════════════════════

  btnStartGame.addEventListener('click', () => {
    wsSend({ type: 'tanks-start' });
  });

  btnBack.addEventListener('click', () => { location.href = '/'; });
  btnRematch.addEventListener('click', () => { location.href = '/'; });

  btnMoveLeft.addEventListener('click', () => {
    if (!isMyTurn || moveBudget <= 0) return;
    wsSend({ type: 'tanks-move', direction: -1 });
  });
  btnMoveRight.addEventListener('click', () => {
    if (!isMyTurn || moveBudget <= 0) return;
    wsSend({ type: 'tanks-move', direction: 1 });
  });

  angleSlider.addEventListener('input', () => {
    angleValueEl.textContent = angleSlider.value;
    if (tanks[myId]) tanks[myId].angle = parseInt(angleSlider.value);
  });

  powerSlider.addEventListener('input', () => {
    powerValueEl.textContent = powerSlider.value;
  });

  btnFire.addEventListener('click', () => {
    if (!isMyTurn) return;
    if (currentWeapon === 'airstrike') {
      // Enter airstrike mode
      airstrikeMode = true;
      airstrikeOverlay.style.display = '';
      return;
    }
    doFire();
  });

  btnShield.addEventListener('click', () => {
    if (!isMyTurn || inventory.shield <= 0) return;
    wsSend({ type: 'tanks-shield' });
  });

  function doFire(airstrikeX) {
    if (!isMyTurn) return;
    const angle = parseInt(angleSlider.value);
    const power = parseInt(powerSlider.value);
    const payload = { type: 'tanks-fire', weapon: currentWeapon, angle, power };
    if (airstrikeX !== undefined) payload.airstrikeX = airstrikeX;
    wsSend(payload);
    isMyTurn = false;
    hudEl.style.display = 'none';
  }

  // Airstrike click — the overlay sits on top of the canvas so listen there instead
  airstrikeOverlay.addEventListener('click', (e) => {
    if (!airstrikeMode) return;
    // Ignore clicks on the Cancel button itself
    if (btnCancelAirstrike.contains(e.target)) return;
    const rect = canvas.getBoundingClientRect();
    // Rendering is 1:1 (translate-only, no scale), so canvas pixel == world pixel
    const worldX = (e.clientX - rect.left) + cameraX;
    airstrikeMode = false;
    airstrikeOverlay.style.display = 'none';
    doFire(Math.round(worldX));
  });

  // Keep canvas listener as no-op for other uses (kept for safety)
  canvas.addEventListener('click', (e) => {
    if (!airstrikeMode) return; // overlay intercepts first, this is a fallback
  });

  btnCancelAirstrike.addEventListener('click', () => {
    airstrikeMode = false;
    airstrikeOverlay.style.display = 'none';
  });

  // Keyboard controls
  document.addEventListener('keydown', (e) => {
    if (e.target === chatInput) return;
    if (!isMyTurn) return;
    switch (e.key) {
      case 'ArrowLeft': case 'a':
        btnMoveLeft.click();
        break;
      case 'ArrowRight': case 'd':
        btnMoveRight.click();
        break;
      case 'ArrowUp': case 'w':
        angleSlider.value = Math.min(180, parseInt(angleSlider.value) + 2);
        angleSlider.dispatchEvent(new Event('input'));
        break;
      case 'ArrowDown': case 's':
        angleSlider.value = Math.max(0, parseInt(angleSlider.value) - 2);
        angleSlider.dispatchEvent(new Event('input'));
        break;
      case ' ':
        e.preventDefault();
        btnFire.click();
        break;
      case '1': case '2': case '3': case '4': case '5': case '6':
        selectWeaponByIndex(parseInt(e.key) - 1);
        break;
    }
  });

  // ══════════════════════════════════════════════════════════════════
  //  WEAPON UI
  // ══════════════════════════════════════════════════════════════════

  function buildWeaponUI() {
    weaponSelector.innerHTML = '';
    for (let i = 0; i < WEAPON_DEFS.length; i++) {
      const w = WEAPON_DEFS[i];
      if (w.key === 'shield') continue; // shield has its own button
      const btn = document.createElement('button');
      btn.className = 'weapon-btn' + (w.key === currentWeapon ? ' selected' : '');
      btn.dataset.weapon = w.key;
      const ammoStr = w.ammo === Infinity ? '∞' : inventory[w.key];
      btn.innerHTML = `${w.icon}<span class="weapon-ammo">${ammoStr}</span>`;
      btn.title = w.name + ' [' + (i + 1) + ']';
      btn.addEventListener('click', () => selectWeapon(w.key));
      weaponSelector.appendChild(btn);
    }
  }

  function updateWeaponUI() {
    const btns = weaponSelector.querySelectorAll('.weapon-btn');
    btns.forEach(btn => {
      const key = btn.dataset.weapon;
      const def = WEAPON_DEFS.find(w => w.key === key);
      if (!def) return;
      const ammo = inventory[key];
      btn.querySelector('.weapon-ammo').textContent = ammo === Infinity ? '∞' : ammo;
      btn.classList.toggle('selected', key === currentWeapon);
      btn.classList.toggle('empty', ammo !== Infinity && ammo <= 0);
    });
    btnShield.style.display = inventory.shield > 0 ? '' : 'none';
  }

  function selectWeapon(key) {
    const ammo = inventory[key];
    if (ammo !== Infinity && ammo <= 0) return;
    currentWeapon = key;
    updateWeaponUI();
  }

  function selectWeaponByIndex(idx) {
    const filtered = WEAPON_DEFS.filter(w => w.key !== 'shield');
    if (idx >= 0 && idx < filtered.length) selectWeapon(filtered[idx].key);
  }

  // ══════════════════════════════════════════════════════════════════
  //  PROJECTILE ANIMATION (client-side)
  // ══════════════════════════════════════════════════════════════════

  function animateProjectiles(projDataList, onComplete) {
    if (!projDataList || projDataList.length === 0) { onComplete(); return; }

    let completed = 0;
    const total = projDataList.length;

    for (const pd of projDataList) {
      const proj = {
        x: pd.startX, y: pd.startY,
        vx: pd.vx, vy: pd.vy,
        trail: [],
        weapon: pd.weapon || 'standard',
        isSniper: pd.isSniper || false,
        done: false,
        targetX: pd.impactX, targetY: pd.impactY,
        delay: pd.delay || 0,
      };
      projectiles.push(proj);

      if (pd.delay > 0) {
        setTimeout(() => startProjectileAnim(proj, () => {
          completed++;
          if (completed >= total) onComplete();
        }), pd.delay);
      } else {
        startProjectileAnim(proj, () => {
          completed++;
          if (completed >= total) onComplete();
        });
      }
    }
  }

  function startProjectileAnim(proj, onDone) {
    followingProjectile = true;
    const step = () => {
      if (proj.done) return;

      proj.trail.push({ x: proj.x, y: proj.y });
      if (proj.trail.length > 30) proj.trail.shift();

      if (proj.isSniper) {
        // Straight line — just lerp
        const dx = proj.targetX - proj.x;
        const dy = proj.targetY - proj.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        if (dist < 8) {
          proj.x = proj.targetX;
          proj.y = proj.targetY;
          proj.done = true;
          followingProjectile = false;
          onDone();
          return;
        }
        const speed = 15;
        proj.x += (dx / dist) * speed;
        proj.y += (dy / dist) * speed;
      } else {
        proj.x += proj.vx;
        proj.y += proj.vy;
        proj.vy += GRAVITY;
        proj.vx += wind * 0.002;

        // Check if reached impact point (within tolerance) or out of bounds
        const dx = proj.targetX - proj.x;
        const dy = proj.targetY - proj.y;
        if (Math.sqrt(dx * dx + dy * dy) < 10 || proj.y > WORLD_H + 50 || proj.x < -50 || proj.x > WORLD_W + 50) {
          proj.x = proj.targetX;
          proj.y = proj.targetY;
          proj.done = true;
          followingProjectile = false;
          onDone();
          return;
        }
      }

      // Camera follow
      cameraTargetX = proj.x - canvas.width / 2;
      cameraTargetY = proj.y - canvas.height / 2;

      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  // ══════════════════════════════════════════════════════════════════
  //  RENDERING
  // ══════════════════════════════════════════════════════════════════

  function resizeCanvas() {
    const area = $('canvasArea');
    canvas.width = area.clientWidth;
    canvas.height = area.clientHeight;
  }
  window.addEventListener('resize', resizeCanvas);

  function renderLoop() {
    if (!gameActive && projectiles.length === 0 && explosions.length === 0) return;

    // Smooth camera
    cameraX += (cameraTargetX - cameraX) * 0.08;
    cameraY += (cameraTargetY - cameraY) * 0.08;
    // Clamp camera
    cameraX = Math.max(0, Math.min(WORLD_W - canvas.width, cameraX));
    cameraY = Math.max(0, Math.min(WORLD_H - canvas.height, cameraY));

    ctx.save();

    // Screen shake
    let shakeX = 0, shakeY = 0;
    if (shakeFrames > 0) {
      shakeX = (Math.random() - 0.5) * shakeFrames * 1.5;
      shakeY = (Math.random() - 0.5) * shakeFrames * 1.5;
      shakeFrames--;
    }
    ctx.translate(shakeX, shakeY);
    ctx.translate(-cameraX, -cameraY);

    // Clear
    drawSky();
    drawTerrain();
    drawWater();
    drawTrajectoryPreview();
    drawTanks();
    drawCrates();
    drawProjectiles();
    drawExplosions();
    drawFloatingTexts();

    ctx.restore();

    requestAnimationFrame(renderLoop);
  }

  function drawTrajectoryPreview() {
    if (!isMyTurn || followingProjectile || !terrain) return;
    if (currentWeapon === 'airstrike' || currentWeapon === 'shield' || currentWeapon === 'chainlightning') return;

    const myTank = tanks[myId];
    if (!myTank || !myTank.alive) return;

    const angle = parseInt(angleSlider.value);
    const power = parseInt(powerSlider.value);
    const angleRad = angle * Math.PI / 180;
    const speed = power * 0.12;

    const PREVIEW_STEPS = 60;   // how many simulation steps to show
    const DOT_INTERVAL  = 4;    // draw a dot every N steps

    if (currentWeapon === 'sniper') {
      // Straight dashed line preview
      const dx = Math.cos(Math.PI - angleRad);
      const dy = -Math.sin(angleRad);
      ctx.save();
      ctx.setLineDash([6, 8]);
      ctx.strokeStyle = 'rgba(244, 114, 182, 0.55)';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(myTank.x, myTank.y - 18);
      ctx.lineTo(myTank.x + dx * 220, myTank.y - 18 + dy * 220);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      return;
    }

    // Parabolic arc preview
    let px = myTank.x;
    let py = myTank.y - 18;
    let pvx = Math.cos(Math.PI - angleRad) * speed;
    let pvy = -Math.sin(angleRad) * speed;

    ctx.save();
    for (let i = 0; i < PREVIEW_STEPS; i++) {
      px += pvx;
      py += pvy;
      pvy += GRAVITY;
      pvx += wind * 0.002;

      // Stop if hit terrain or left the world
      if (px < 0 || px >= WORLD_W || py >= WORLD_H) break;
      const ix = Math.round(px), iy = Math.round(py);
      if (iy >= 0 && ix >= 0 && ix < WORLD_W && iy < WORLD_H && terrain[iy * WORLD_W + ix]) break;

      if (i % DOT_INTERVAL !== 0) continue;

      // Dots fade out with distance
      const alpha = (1 - i / PREVIEW_STEPS) * 0.65;
      const radius = 2.5 - (i / PREVIEW_STEPS) * 1.5;
      ctx.fillStyle = `rgba(255, 220, 80, ${alpha})`;
      ctx.beginPath();
      ctx.arc(px, py, Math.max(0.5, radius), 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.restore();
  }

  function drawSky() {
    const gradient = ctx.createLinearGradient(0, 0, 0, WORLD_H);
    gradient.addColorStop(0, '#0f0f3d');
    gradient.addColorStop(0.3, '#1a1a5e');
    gradient.addColorStop(0.6, '#2a1a4e');
    gradient.addColorStop(1, '#0a0a2a');
    ctx.fillStyle = gradient;
    ctx.fillRect(cameraX, cameraY, canvas.width, canvas.height);

    // Stars
    const starSeed = 42;
    for (let i = 0; i < 60; i++) {
      const sx = ((starSeed * (i + 1) * 7919) % WORLD_W);
      const sy = ((starSeed * (i + 1) * 6271) % (WORLD_H * 0.5));
      const size = ((i * 31) % 3) + 1;
      ctx.fillStyle = `rgba(255, 255, 255, ${0.3 + (i % 5) * 0.1})`;
      ctx.fillRect(sx, sy, size, size);
    }
  }

  function drawTerrain() {
    if (!terrain) return;

    // Only draw visible portion
    const startX = Math.max(0, Math.floor(cameraX));
    const endX = Math.min(WORLD_W, Math.ceil(cameraX + canvas.width));
    const startY = Math.max(0, Math.floor(cameraY));
    const endY = Math.min(WORLD_H, Math.ceil(cameraY + canvas.height));

    // Draw terrain using ImageData for performance
    const imgW = endX - startX;
    const imgH = endY - startY;
    if (imgW <= 0 || imgH <= 0) return;

    const imgData = ctx.createImageData(imgW, imgH);
    const data = imgData.data;

    for (let y = startY; y < endY; y++) {
      const rowOffset = y * WORLD_W;
      const imgRow = (y - startY) * imgW;
      for (let x = startX; x < endX; x++) {
        if (terrain[rowOffset + x]) {
          const idx = (imgRow + (x - startX)) * 4;
          // Earth color — varies by depth
          const depth = (y - (WORLD_H * 0.3)) / (WORLD_H * 0.7);
          const r = Math.floor(50 + depth * 40 + ((x * 7 + y * 3) % 15));
          const g = Math.floor(100 + depth * (-30) + ((x * 3 + y * 11) % 20));
          const b = Math.floor(30 + depth * 20 + ((x * 13 + y * 5) % 10));
          data[idx] = r;
          data[idx + 1] = g;
          data[idx + 2] = b;
          data[idx + 3] = 255;

          // Grass on surface — check if pixel above is air
          if (y > 0 && !terrain[(y - 1) * WORLD_W + x]) {
            data[idx] = 50;
            data[idx + 1] = 160;
            data[idx + 2] = 50;
          }
        }
      }
    }

    // putImageData ignores canvas transforms, so offset manually to match world→screen coords
    ctx.putImageData(imgData, Math.round(startX - cameraX), Math.round(startY - cameraY));
  }

  function drawCrates() {
    const now = Date.now();
    for (const c of crates) {
      // Animate falling: drop from y=10 down to landY at ~3px/frame
      if (!c.landed) {
        c.currentY = Math.min(c.landY, (c.currentY || 10) + 3);
        if (c.currentY >= c.landY) c.landed = true;
      }
      const cx = c.x, cy = c.currentY;

      // Parachute (only while falling)
      if (!c.landed) {
        const chuteW = 36, chuteH = 20;
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.7)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(cx, cy - 18, chuteW / 2, Math.PI, 0);
        ctx.stroke();
        // Strings
        ctx.beginPath();
        ctx.moveTo(cx - chuteW / 2, cy - 16);
        ctx.lineTo(cx - 7, cy - 4);
        ctx.moveTo(cx + chuteW / 2, cy - 16);
        ctx.lineTo(cx + 7, cy - 4);
        ctx.stroke();
      }

      // Crate box
      const bw = 20, bh = 18;
      ctx.fillStyle = '#8B6914';
      ctx.fillRect(cx - bw / 2, cy - bh, bw, bh);
      // Wooden cross lines
      ctx.strokeStyle = '#5a4010';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(cx - bw / 2, cy - bh / 2); ctx.lineTo(cx + bw / 2, cy - bh / 2);
      ctx.moveTo(cx, cy - bh); ctx.lineTo(cx, cy);
      ctx.stroke();
      // Icon
      ctx.font = '11px serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(c.icon, cx, cy - bh / 2);
      ctx.textBaseline = 'alphabetic';

      // Pulse glow when landed
      if (c.landed) {
        const pulse = 0.35 + 0.25 * Math.sin(now * 0.005);
        ctx.strokeStyle = `rgba(251, 191, 36, ${pulse})`;
        ctx.lineWidth = 2;
        ctx.strokeRect(cx - bw / 2 - 2, cy - bh - 2, bw + 4, bh + 4);

        // Label above
        ctx.fillStyle = 'rgba(251, 191, 36, 0.9)';
        ctx.font = 'bold 9px Inter, sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(c.label, cx, cy - bh - 6);
      }
    }
  }

  function drawWater() {
    // Water at bottom
    const waterY = WORLD_H - 15;
    const gradient = ctx.createLinearGradient(0, waterY, 0, WORLD_H);
    gradient.addColorStop(0, 'rgba(30, 80, 200, 0.5)');
    gradient.addColorStop(1, 'rgba(10, 40, 120, 0.8)');
    ctx.fillStyle = gradient;
    ctx.fillRect(0, waterY, WORLD_W, 15);

    // Waves
    ctx.strokeStyle = 'rgba(100, 180, 255, 0.4)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let x = 0; x < WORLD_W; x += 2) {
      const wy = waterY + Math.sin(x * 0.05 + Date.now() * 0.002) * 2;
      if (x === 0) ctx.moveTo(x, wy);
      else ctx.lineTo(x, wy);
    }
    ctx.stroke();
  }

  function drawTanks() {
    for (const id in tanks) {
      const t = tanks[id];
      if (!t.alive) continue;

      const cx = t.x, cy = t.y;

      // Tank body
      ctx.fillStyle = t.color;
      ctx.fillRect(cx - TANK_W / 2, cy - TANK_H, TANK_W, TANK_H);

      // Treads
      ctx.fillStyle = 'rgba(0,0,0,0.3)';
      ctx.fillRect(cx - TANK_W / 2 - 2, cy - 4, TANK_W + 4, 4);

      // Turret
      ctx.fillStyle = t.color;
      ctx.beginPath();
      ctx.arc(cx, cy - TANK_H, 8, 0, Math.PI * 2);
      ctx.fill();

      // Cannon barrel
      const angle = (t.angle || 90) * Math.PI / 180;
      const barrelLen = 22;
      const bx = cx + Math.cos(Math.PI - angle) * barrelLen;
      const by = cy - TANK_H - Math.sin(angle) * barrelLen;
      ctx.strokeStyle = t.color;
      ctx.lineWidth = 4;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(cx, cy - TANK_H);
      ctx.lineTo(bx, by);
      ctx.stroke();

      // Shield glow
      if (t.shielded) {
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.6)';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.arc(cx, cy - TANK_H / 2, TANK_W * 0.8, 0, Math.PI * 2);
        ctx.stroke();
        ctx.strokeStyle = 'rgba(6, 182, 212, 0.2)';
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.arc(cx, cy - TANK_H / 2, TANK_W * 0.8 + 3, 0, Math.PI * 2);
        ctx.stroke();
      }

      // Name
      ctx.fillStyle = '#fff';
      ctx.font = '10px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(t.name, cx, cy - TANK_H - 28);

      // HP bar
      const hpW = 36, hpH = 4;
      const hpX = cx - hpW / 2, hpY = cy - TANK_H - 22;
      ctx.fillStyle = '#333';
      ctx.fillRect(hpX, hpY, hpW, hpH);
      const hpPct = Math.max(0, t.hp) / MAX_HP;
      ctx.fillStyle = hpPct > 0.5 ? '#22c55e' : hpPct > 0.25 ? '#fbbf24' : '#ef4444';
      ctx.fillRect(hpX, hpY, hpW * hpPct, hpH);

      // Angle indicator (only for active turn)
      if (id === turnPlayerId && (id === myId || !isMyTurn)) {
        ctx.fillStyle = 'rgba(255,255,255,0.5)';
        ctx.font = '9px Orbitron, sans-serif';
        ctx.fillText((t.angle || 90) + '°', cx, cy - TANK_H - 38);
      }
    }
  }

  function drawProjectiles() {
    for (const p of projectiles) {
      if (p.done) continue;
      // Trail
      ctx.strokeStyle = 'rgba(255, 200, 50, 0.4)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < p.trail.length; i++) {
        if (i === 0) ctx.moveTo(p.trail[i].x, p.trail[i].y);
        else ctx.lineTo(p.trail[i].x, p.trail[i].y);
      }
      ctx.stroke();

      // Projectile
      ctx.fillStyle = p.isSniper ? '#f472b6' : '#fbbf24';
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.isSniper ? 3 : 4, 0, Math.PI * 2);
      ctx.fill();

      // Glow
      ctx.fillStyle = p.isSniper ? 'rgba(244,114,182,0.3)' : 'rgba(251,191,36,0.3)';
      ctx.beginPath();
      ctx.arc(p.x, p.y, 8, 0, Math.PI * 2);
      ctx.fill();
    }
    // Clean up done projectiles
    projectiles = projectiles.filter(p => !p.done);
  }

  function addExplosion(x, y, radius) {
    explosions.push({ x, y, radius, frame: 0, maxFrame: 20 });
  }

  function drawExplosions() {
    for (let i = explosions.length - 1; i >= 0; i--) {
      const e = explosions[i];
      const progress = e.frame / e.maxFrame;

      // Flash
      if (e.frame < 4) {
        ctx.fillStyle = `rgba(255, 255, 200, ${0.8 - progress * 2})`;
        ctx.beginPath();
        ctx.arc(e.x, e.y, e.radius * 1.5, 0, Math.PI * 2);
        ctx.fill();
      }

      // Shockwave ring
      ctx.strokeStyle = `rgba(255, 150, 50, ${1 - progress})`;
      ctx.lineWidth = 3 * (1 - progress);
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.radius * progress * 2, 0, Math.PI * 2);
      ctx.stroke();

      // Fire
      ctx.fillStyle = `rgba(255, ${Math.floor(100 + 100 * (1 - progress))}, 0, ${0.6 * (1 - progress)})`;
      ctx.beginPath();
      ctx.arc(e.x, e.y, e.radius * (0.5 + progress * 0.5), 0, Math.PI * 2);
      ctx.fill();

      e.frame++;
      if (e.frame > e.maxFrame) explosions.splice(i, 1);
    }
  }

  function addFloatingText(x, y, text, color) {
    floatingTexts.push({ x, y, text, color, frame: 0, maxFrame: 60 });
  }

  function drawFloatingTexts() {
    for (let i = floatingTexts.length - 1; i >= 0; i--) {
      const ft = floatingTexts[i];
      const progress = ft.frame / ft.maxFrame;
      ctx.fillStyle = ft.color;
      ctx.globalAlpha = 1 - progress;
      ctx.font = 'bold 14px Inter, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText(ft.text, ft.x, ft.y - progress * 40);
      ctx.globalAlpha = 1;
      ft.frame++;
      if (ft.frame > ft.maxFrame) floatingTexts.splice(i, 1);
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  SIDEBAR — Player Cards
  // ══════════════════════════════════════════════════════════════════

  function addPlayerCard(id, name, isMe) {
    if (isMe && document.querySelector('.player-card[data-id="self"]')) return;
    if (!isMe && others.has(id)) return;
    const cIdx = isMe ? 0 : (others.size % TANK_COLORS.length) + 1;
    const color = TANK_COLORS[cIdx % TANK_COLORS.length];
    const card = document.createElement('div');
    card.className = 'player-card' + (isMe ? ' me' : '');
    card.dataset.id = isMe ? 'self' : id;
    card.innerHTML = `
      <span class="pc-dot" style="background:${color}"></span>
      <span class="pc-name">${escapeHtml(name)}${isMe ? ' (you)' : ''}</span>
      <div class="pc-hp-bar"><div class="pc-hp-fill" style="width:100%"></div></div>
      <span class="pc-hp">${MAX_HP}</span>
    `;
    playerListEl.appendChild(card);
    if (!isMe) others.set(id, { name, el: card });
  }

  function removePlayerCard(id) {
    const p = others.get(id);
    if (p) { p.el.remove(); others.delete(id); }
  }

  function updatePlayerHP(id, hp, alive) {
    const sel = id === myId ? '.player-card[data-id="self"]' : `.player-card[data-id="${id}"]`;
    const card = document.querySelector(sel);
    if (!card) return;
    const fill = card.querySelector('.pc-hp-fill');
    const hpEl = card.querySelector('.pc-hp');
    if (fill) {
      fill.style.width = (Math.max(0, hp) / MAX_HP * 100) + '%';
      fill.className = 'pc-hp-fill' + (hp <= MAX_HP * 0.25 ? ' critical' : hp <= MAX_HP * 0.5 ? ' low' : '');
    }
    if (hpEl) hpEl.textContent = Math.max(0, hp);
    card.classList.toggle('dead', !alive);
  }

  function updatePlayerCount() {
    playerCountEl.textContent = 1 + others.size;
  }

  function updateStartButton() {
    // Only the leader can start
    const isLeader = (leaderId && myId) ? (leaderId === myId) : (others.size === 0);
    btnStartGame.style.display = isLeader && !gameActive ? '' : 'none';
    if (!gameActive && !isLeader) {
      statusEl.textContent = 'Waiting for leader to start…';
    }
  }

  // ══════════════════════════════════════════════════════════════════
  //  CHAT
  // ══════════════════════════════════════════════════════════════════

  function appendChat(kind, name, text) {
    const div = document.createElement('div');
    div.className = 'chat-msg ' + kind;
    div.innerHTML = kind !== 'system'
      ? `<span class="cm-name">${escapeHtml(name)}:</span>${escapeHtml(text)}`
      : escapeHtml(text);
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  function sendChat() {
    const text = chatInput.value.trim();
    if (!text) return;
    wsSend({ type: 'chat', text });
    appendChat('me', myName, text);
    chatInput.value = '';
  }

  chatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
    e.stopPropagation();
  });

  // ══════════════════════════════════════════════════════════════════
  //  RULES PANEL
  // ══════════════════════════════════════════════════════════════════

  $('btnRules').addEventListener('click', () => { $('rulesPanel').style.display = ''; });
  $('rulesClose').addEventListener('click', () => { $('rulesPanel').style.display = 'none'; });
  $('rulesPanel').addEventListener('click', e => { if (e.target === $('rulesPanel')) $('rulesPanel').style.display = 'none'; });

  // ══════════════════════════════════════════════════════════════════
  //  INIT
  // ══════════════════════════════════════════════════════════════════

  connect();
})();

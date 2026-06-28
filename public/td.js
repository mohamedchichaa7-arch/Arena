/* ═══════════════════════════════════════════════════════════════════
   TOWER DEFENSE — Arena Room Client  |  td.js
   ═══════════════════════════════════════════════════════════════════ */
(() => {
  'use strict';

  const params = new URLSearchParams(location.search);
  const roomId = params.get('room');
  const myName = sessionStorage.getItem('arena-name') || 'Player';
  if (!roomId) { location.href = '/'; return; }

  const $ = s => document.getElementById(s);
  const statusEl = $('status'), playerListEl = $('playerList'), playerCountEl = $('playerCount');
  const roomBadge = $('roomBadge'), btnBack = $('btnBack'), btnStart = $('btnStart'), controlsEl = $('controls');
  const modeSelect = $('modeSelect'), mapSelect = $('mapSelect'), cfgDesc = $('cfgDesc'), cfgRow = $('cfgRow');
  const modeBadge = $('modeBadge');
  const wavePill = $('wavePill'), timerDisplay = $('timerDisplay');
  const canvas = $('lane'), ctx = canvas.getContext('2d');
  const goldVal = $('goldVal'), hpVal = $('hpVal'), hpChip = $('hpChip');
  const towerShop = $('towerShop'), towerPanel = $('towerPanel');
  const sendFill = $('sendFill'), sendTicks = $('sendTicks'), sendThreshold = $('sendThreshold'), btnSend = $('btnSend');
  const targetPicker = $('targetPicker'), tpList = $('tpList'), tpCancel = $('tpCancel');
  const minimapsEl = $('minimaps'), killFeed = $('killFeed'), incomingBanner = $('incomingBanner');
  const chatMessages = $('chatMessages'), chatInput = $('chatInput'), chatSend = $('chatSend');
  const rulesOverlay = $('rulesOverlay'), countdownOverlay = $('countdownOverlay'), countdownNumber = $('countdownNumber');
  const waveAnnounce = $('waveAnnounce'), gameOverlay = $('gameOverlay'), resultTitle = $('resultTitle'), finalRanking = $('finalRanking');

  roomBadge.textContent = 'Room ' + roomId;

  // ── Constants (mirror server) ──
  const COLS = 20, ROWS = 15, CELL = 36, TICK_MS = 50;
  canvas.width = COLS * CELL; canvas.height = ROWS * CELL;
  const COLORS = ['#ef4444', '#3b82f6', '#22c55e', '#f59e0b'];

  const TOWER_DEFS = {
    arrow:   { name: 'Arrow',   icon: '🏹', color: '#22c55e', dmgClass: 'physical', desc: 'Fast · single',
      levels: [{ cost: 50, damage: 14, range: 3.0, fireMs: 480 }, { cost: 45, damage: 26, range: 3.3, fireMs: 420 }, { cost: 75, damage: 44, range: 3.6, fireMs: 350 }] },
    cannon:  { name: 'Cannon',  icon: '💣', color: '#f97316', dmgClass: 'physical', desc: 'AoE splash',
      levels: [{ cost: 100, damage: 45, range: 2.6, fireMs: 1300, splash: 1.3 }, { cost: 85, damage: 80, range: 2.7, fireMs: 1200, splash: 1.5 }, { cost: 150, damage: 135, range: 2.9, fireMs: 1050, splash: 1.7 }] },
    frost:   { name: 'Frost',   icon: '❄️', color: '#38bdf8', dmgClass: 'none', desc: 'Slows enemies',
      levels: [{ cost: 80, damage: 0, range: 2.8, fireMs: 700, slow: 0.4, slowMs: 2000 }, { cost: 65, damage: 0, range: 3.0, fireMs: 700, slow: 0.5, slowMs: 2000 }, { cost: 110, damage: 0, range: 3.3, fireMs: 700, slow: 0.6, slowMs: 2500 }] },
    tesla:   { name: 'Tesla',   icon: '⚡', color: '#a78bfa', dmgClass: 'magic', desc: 'Chain lightning',
      levels: [{ cost: 150, damage: 24, range: 3.0, fireMs: 700, chains: 4 }, { cost: 115, damage: 38, range: 3.2, fireMs: 650, chains: 5 }, { cost: 185, damage: 58, range: 3.4, fireMs: 600, chains: 6 }] },
    inferno: { name: 'Inferno', icon: '🔥', color: '#ef4444', dmgClass: 'magic', desc: 'Burn (stacks 3)',
      levels: [{ cost: 120, damage: 0, range: 2.8, fireMs: 500, burn: 9, burnMs: 3000 }, { cost: 90, damage: 0, range: 3.0, fireMs: 500, burn: 15, burnMs: 3000 }, { cost: 150, damage: 0, range: 3.2, fireMs: 500, burn: 24, burnMs: 3000 }] },
    sniper:  { name: 'Sniper',  icon: '🎯', color: '#e2e8f0', dmgClass: 'physical', desc: 'Huge range',
      levels: [{ cost: 180, damage: 160, range: 8.0, fireMs: 3000 }, { cost: 140, damage: 300, range: 8.5, fireMs: 2600 }, { cost: 220, damage: 520, range: 9.5, fireMs: 2200 }] },
  };
  const TOWER_ORDER = ['arrow', 'cannon', 'frost', 'tesla', 'inferno', 'sniper'];

  const ENEMY_DEFS = {
    grunt:   { name: 'Grunt',   color: '#9ca3af', r: 0.30, shape: 'circle' },
    runner:  { name: 'Runner',  color: '#fde047', r: 0.24, shape: 'tri' },
    brute:   { name: 'Brute',   color: '#b45309', r: 0.40, shape: 'square' },
    armored: { name: 'Armored', color: '#64748b', r: 0.36, shape: 'hex' },
    phantom: { name: 'Phantom', color: '#c084fc', r: 0.32, shape: 'diamond' },
    boss:    { name: 'Boss',    color: '#dc2626', r: 0.52, shape: 'circle' },
  };

  const SEND_PACKAGES = [
    { pts: 10, label: '5 Grunts' },
    { pts: 20, label: '3 Runners' },
    { pts: 35, label: '2 Brutes' },
    { pts: 50, label: '1 Armored + 3 Runners' },
    { pts: 75, label: '1 Boss' },
  ];
  const SEND_MAX = 75;

  // ── Game modes (mirror server) ──
  const MODES = {
    classic:  { name: 'Classic',      icon: '🏰', desc: 'Standard survival. Build, defend, send.' },
    blitz:    { name: 'Blitz',        icon: '⚡', desc: 'Short prep, rapid waves, fat income.' },
    ironman:  { name: 'Sudden Death', icon: '💀', desc: 'Start at 3 HP. Every leak stings.' },
    goldrush: { name: 'Gold Rush',    icon: '💰', desc: 'Booming economy vs beefy hordes.' },
    bossrush: { name: 'Boss Rush',    icon: '👑', desc: 'Elites & bosses every single wave.' },
    chaos:    { name: 'Chaos',        icon: '🎲', desc: 'A random twist every wave.' },
  };
  const MODE_ORDER = ['classic', 'blitz', 'ironman', 'goldrush', 'bossrush', 'chaos'];

  // ── Maps (mirror server) ──
  const MAPS = {
    serpent:    { name: 'Serpentine', desc: 'Classic 7-band weave — balanced.' },
    switchback: { name: 'Switchback', desc: 'Long open lanes — snipers thrive.' },
    spiral:     { name: 'Spiral',     desc: 'Coils inward to the core — splash heaven.' },
    labyrinth:  { name: 'Labyrinth',  desc: 'Tight comb — slows & AoE shine.' },
    delta:      { name: 'Delta',      desc: 'Procedural meander — organic river bends.' },
    canyon:     { name: 'Canyon',     desc: 'Procedural gorge — deep flanking corridors.' },
    ruins:      { name: 'Ruins',      desc: 'Procedural ruins — chaotic broken passages.' },
    random:     { name: '🎲 Random',   desc: 'New procedural maze every game!' },
  };
  const MAP_ORDER = ['serpent', 'switchback', 'spiral', 'labyrinth', 'delta', 'canyon', 'ruins', 'random'];

  // ── Per-tower perks (mirror server) ──
  const PERKS = {
    arrow: [
      { id: 'pierce', name: 'Piercing Shot', icon: '➶', cost: 120, desc: 'Each shot strikes up to 3 enemies down the lane.' },
      { id: 'eagle',  name: 'Eagle Eye',     icon: '👁', cost: 140, desc: '+0.8 range · 25% chance for a triple-damage crit.' },
      { id: 'rapid',  name: 'Rapid Fire',    icon: '💨', cost: 130, desc: 'Reload 35% faster.' },
    ],
    cannon: [
      { id: 'cluster', name: 'Cluster Bombs', icon: '✸', cost: 150, desc: '+0.9 splash radius · +15% damage.' },
      { id: 'siege',   name: 'Siege Payload', icon: '🛠', cost: 170, desc: '+60% damage to Brutes, Armored & Bosses.' },
      { id: 'napalm',  name: 'Napalm',        icon: '🔥', cost: 160, desc: 'Blasts ignite everything they hit.' },
    ],
    frost: [
      { id: 'permafrost', name: 'Permafrost', icon: '🧊', cost: 120, desc: 'Stronger slow that lasts far longer.' },
      { id: 'shatter',    name: 'Shatter',    icon: '💔', cost: 150, desc: 'Slowed enemies take +25% damage from everything.' },
      { id: 'coldsnap',   name: 'Cold Snap',  icon: '❄', cost: 200, desc: '12% chance to freeze an enemy solid for 0.8s.' },
    ],
    tesla: [
      { id: 'overload', name: 'Overload',     icon: '⚡', cost: 160, desc: '+2 chain jumps · +20% damage.' },
      { id: 'conduct',  name: 'Conductor',    icon: '🔗', cost: 170, desc: 'Each chain jump deals 25% more than the last.' },
      { id: 'static',   name: 'Static Field', icon: '🌀', cost: 140, desc: 'Struck enemies are slowed 25%.' },
    ],
    inferno: [
      { id: 'incinerate', name: 'Incinerate', icon: '☄', cost: 180, desc: '+60% burn damage.' },
      { id: 'pyro',       name: 'Pyromaniac', icon: '🎇', cost: 130, desc: 'Burn stacks to 5 and ignites two targets.' },
      { id: 'wildfire',   name: 'Wildfire',   icon: '🌋', cost: 160, desc: 'Burns spread to a nearby enemy.' },
    ],
    sniper: [
      { id: 'armorpierce', name: 'Armor Piercing', icon: '🗡', cost: 150, desc: 'Shots ignore all armor.' },
      { id: 'execute',     name: 'Executioner',    icon: '☠', cost: 220, desc: 'Instakill non-bosses under 18% HP · +40% vs bosses.' },
      { id: 'doubletap',   name: 'Double Tap',     icon: '⏩', cost: 200, desc: 'Fires twice per shot.' },
    ],
  };

  // ── State ──
  let ws = null, myId = null, amHost = false, matchActive = false;
  let path = [], pathSet = new Set();
  let playersInfo = [];
  const playerCards = new Map(); // pid -> {el, name, colorIdx}
  let lanes = {};               // latest server lane snapshot
  let myGold = 150, myHp = 20, maxHp = 20, mySendMeter = 0;
  let wave = 0, phase = 'prep', phaseRemainingMs = 0, phaseStampAt = 0;

  let selectedShopTower = null;   // tower type to place
  let selectedTowerId = null;     // placed tower selected for panel
  let hoverCell = null;
  let prevHp = 20;
  let selMode = 'classic', selMap = 'serpent';

  // Interpolation buffers: per lane, Map(enemyId -> {fx,fy,tx,ty,at,h,sl,bn,t})
  const laneRender = {};
  const effects = [];             // {kind, ...,until}
  const damageNumbers = [];       // {x,y,val,until,color}
  const miniCanvases = new Map(); // pid -> {wrap, canvas, hpFill, head, skull}

  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  // ── Network ──
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
        myId = msg.myId;
        amHost = (msg.players.length === 0);
        addPlayerCard(myId, myName, true);
        for (const p of msg.players) addPlayerCard(p.id, p.name, false);
        updatePlayerCount();
        buildConfigSelectors();
        refreshLobbyControls();
        break;
      case 'player-joined':
        addPlayerCard(msg.id, msg.name, false);
        updatePlayerCount();
        refreshLobbyControls();
        break;
      case 'player-left':
        if (!matchActive) { removePlayerCard(msg.id); updatePlayerCount(); refreshLobbyControls(); }
        break;
      case 'chat':
        addChat(msg.name, msg.text);
        break;
      case 'error':
        statusEl.textContent = msg.msg || 'Error';
        break;

      case 'td-match-start': onMatchStart(msg); break;
      case 'td-config':      onConfig(msg); break;
      case 'td-state':       onState(msg); break;
      case 'td-gold':        myGold = msg.gold; goldVal.textContent = myGold; refreshShopAffordability(); break;
      case 'td-send-meter':  mySendMeter = msg.meter; break;
      case 'td-action-error': flashStatus(msg.reason); break;
      case 'td-tower-placed':
      case 'td-tower-upgraded':
      case 'td-tower-sold':  break; // reflected in next state
      case 'td-wave-start':  onWaveStart(msg); break;
      case 'td-wave-end':    onWaveEnd(msg); break;
      case 'td-enemies-sent': onEnemiesSent(msg); break;
      case 'td-player-eliminated': onEliminated(msg); break;
      case 'td-record-win':  reportScore('td', 1); break;
      case 'td-game-over':   onGameOver(msg); break;
    }
  }

  // ── Lobby UI ──
  function addPlayerCard(pid, name, isMe) {
    if (playerCards.has(pid)) return;
    const el = document.createElement('div');
    el.className = 'player-card' + (isMe ? ' is-me' : '');
    el.innerHTML = `<span class="pc-color"></span><div class="pc-body"><div class="pc-name">${escapeHtml(name)}${isMe ? ' (you)' : ''}</div><div class="pc-stats" data-stats></div></div>`;
    playerListEl.appendChild(el);
    playerCards.set(pid, { el, name, colorIdx: playerCards.size });
    paintCardColors();
  }
  function removePlayerCard(pid) { const c = playerCards.get(pid); if (c) { c.el.remove(); playerCards.delete(pid); } paintCardColors(); }
  function paintCardColors() { let i = 0; for (const [, c] of playerCards) { c.colorIdx = i; c.el.querySelector('.pc-color').style.background = COLORS[i % 4]; i++; } }
  function updatePlayerCount() { playerCountEl.textContent = playerCards.size; }
  function refreshLobbyControls() {
    if (matchActive) { controlsEl.style.display = 'none'; return; }
    controlsEl.style.display = 'flex';
    btnStart.style.display = amHost ? 'inline-flex' : 'none';
    btnStart.disabled = playerCards.size < 2;
    // Mode/map selectors: host can change them, others see them locked.
    modeSelect.disabled = !amHost;
    mapSelect.disabled = !amHost;
    cfgRow.querySelector('.cfg-hint') && (cfgRow.querySelector('.cfg-hint').style.display = amHost ? 'none' : 'block');
    statusEl.textContent = amHost
      ? (playerCards.size < 2 ? 'Pick a mode & map — waiting for one more player…' : 'Choose mode & map, then Start Match')
      : 'Waiting for the host to start…';
  }

  // ── Mode / Map config ──
  function buildConfigSelectors() {
    if (modeSelect.options.length === 0) {
      for (const k of MODE_ORDER) { const o = document.createElement('option'); o.value = k; o.textContent = `${MODES[k].icon} ${MODES[k].name}`; modeSelect.appendChild(o); }
      for (const k of MAP_ORDER) { const o = document.createElement('option'); o.value = k; o.textContent = MAPS[k].name; mapSelect.appendChild(o); }
      modeSelect.addEventListener('change', onConfigChanged);
      mapSelect.addEventListener('change', onConfigChanged);
    }
    modeSelect.value = selMode; mapSelect.value = selMap;
    updateConfigDesc();
  }
  function onConfigChanged() {
    selMode = modeSelect.value; selMap = mapSelect.value;
    updateConfigDesc();
    if (amHost) wsSend({ type: 'td-config', mode: selMode, map: selMap });
  }
  function onConfig(msg) {
    if (MODES[msg.mode]) selMode = msg.mode;
    if (MAPS[msg.map]) selMap = msg.map;
    if (!amHost) { modeSelect.value = selMode; mapSelect.value = selMap; }
    updateConfigDesc();
  }
  function updateConfigDesc() {
    const m = MODES[selMode], mp = MAPS[selMap];
    cfgDesc.innerHTML = `<b>${m.icon} ${m.name}</b> — ${escapeHtml(m.desc)} · <b>🗺️ ${mp.name}</b> — ${escapeHtml(mp.desc)}`;
  }

  function addChat(name, text) {
    const el = document.createElement('div');
    el.className = 'chat-msg';
    el.innerHTML = `<b>${escapeHtml(name)}:</b> ${escapeHtml(text)}`;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }
  function sysChat(text) {
    const el = document.createElement('div');
    el.className = 'chat-msg sys';
    el.textContent = text;
    chatMessages.appendChild(el);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  let statusTimer = null;
  function flashStatus(text) {
    statusEl.textContent = text;
    statusEl.style.color = 'var(--danger)';
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { statusEl.style.color = ''; }, 1500);
  }

  // ── Match start ──
  function onMatchStart(msg) {
    matchActive = true;
    path = msg.path; pathSet = new Set(path.map(p => p.y * COLS + p.x));
    playersInfo = msg.playersInfo;
    maxHp = msg.startHp; myHp = msg.startHp; prevHp = msg.startHp;
    myGold = msg.startGold; goldVal.textContent = myGold;
    hpVal.textContent = `${myHp}/${maxHp}`;
    wave = 0; phase = 'prep';
    controlsEl.style.display = 'none';
    rulesOverlay.style.display = 'none';
    buildShop();
    buildSendTicks();
    buildMinimaps();
    // colour sidebar cards by authoritative colorIdx
    for (const p of playersInfo) {
      const c = playerCards.get(p.id);
      if (c) c.el.querySelector('.pc-color').style.background = COLORS[p.colorIdx % 4];
    }
    runCountdown(Math.round(msg.countdownMs / 1000));
    if (modeBadge) { modeBadge.textContent = `${msg.modeIcon || ''} ${msg.modeName || ''} · 🗺️ ${msg.mapName || ''}`; modeBadge.style.display = 'inline-flex'; }
    setTimeout(() => announce(`${msg.modeIcon || ''} ${msg.modeName || 'Classic'}`), 200);
    statusEl.textContent = 'Build your defenses! First wave incoming…';
    if (!rafId) loop();
  }

  function runCountdown(n) {
    countdownOverlay.style.display = 'flex';
    countdownNumber.textContent = n;
    const iv = setInterval(() => {
      n--;
      if (n > 0) { countdownNumber.textContent = n; countdownNumber.style.animation = 'none'; void countdownNumber.offsetWidth; countdownNumber.style.animation = ''; }
      else { clearInterval(iv); countdownOverlay.style.display = 'none'; }
    }, 1000);
  }

  function onWaveStart(msg) {
    wave = msg.wave;
    announce('WAVE ' + msg.wave + (msg.twist && msg.twist !== 'Calm Wave' ? ' · ' + msg.twist : ''));
    if (msg.twist && msg.twist !== 'Calm Wave') sysChat('🎲 ' + msg.twist);
  }
  function onWaveEnd(msg) {
    announce('Wave ' + msg.wave + ' cleared!');
  }
  function announce(text) {
    waveAnnounce.textContent = text;
    waveAnnounce.style.display = 'block';
    waveAnnounce.style.animation = 'none'; void waveAnnounce.offsetWidth; waveAnnounce.style.animation = '';
    setTimeout(() => { waveAnnounce.style.display = 'none'; }, 1800);
  }

  function onEnemiesSent(msg) {
    if (msg.toId === myId) {
      incomingBanner.textContent = `⚠️ Incoming from ${msg.fromName}! ${msg.label}`;
      incomingBanner.classList.add('show');
      setTimeout(() => incomingBanner.classList.remove('show'), 2600);
      addKill(`<b>${escapeHtml(msg.fromName)}</b> sent you ${escapeHtml(msg.label)}`, true);
    } else if (msg.fromId === myId) {
      addKill(`You sent <b>${escapeHtml(msg.label)}</b> → ${escapeHtml(msg.toName)}`, true);
    } else {
      addKill(`${escapeHtml(msg.fromName)} attacked ${escapeHtml(msg.toName)}`, true);
    }
    // flash recipient minimap entrance
    const mini = miniCanvases.get(msg.toId);
    if (mini) { mini.attackColor = COLORS[msg.colorIdx % 4]; mini.attackUntil = performance.now() + 800; }
  }

  function onEliminated(msg) {
    const c = playerCards.get(msg.playerId);
    if (c) c.el.classList.add('dead');
    const mini = miniCanvases.get(msg.playerId);
    if (mini && mini.skull) mini.skull.style.display = 'flex';
    if (mini) mini.wrap.classList.add('dead');
    sysChat(`💀 ${msg.name} was eliminated (wave ${msg.wave})`);
    if (msg.playerId === myId) flashStatus('You were eliminated! Watching…');
  }

  function onGameOver(msg) {
    matchActive = false;
    resultTitle.textContent = msg.winnerId === myId ? '🏆 Victory!' : (msg.winnerName ? `${msg.winnerName} Wins!` : 'Game Over');
    finalRanking.innerHTML = '';
    for (const r of msg.ranking) {
      const row = document.createElement('div');
      row.className = 'rs-row' + (r.place === 1 ? ' winner' : '');
      const medal = r.place === 1 ? '🥇' : r.place === 2 ? '🥈' : r.place === 3 ? '🥉' : '#' + r.place;
      row.innerHTML = `<span class="rs-place">${medal}</span><span class="rs-name">${escapeHtml(r.name)}</span>`;
      finalRanking.appendChild(row);
    }
    gameOverlay.style.display = 'flex';
  }

  // ── State / interpolation ──
  function onState(msg) {
    wave = msg.wave; phase = msg.phase; phaseRemainingMs = msg.phaseRemainingMs; phaseStampAt = performance.now();
    lanes = msg.lanes;
    const now = performance.now();

    for (const pid in lanes) {
      const lane = lanes[pid];
      if (!laneRender[pid]) laneRender[pid] = new Map();
      const buf = laneRender[pid];
      const seen = new Set();
      for (const e of lane.enemies) {
        seen.add(e.i);
        const cur = buf.get(e.i);
        if (cur) { cur.fx = lerpX(cur); cur.fy = lerpY(cur); cur.tx = e.x; cur.ty = e.y; cur.at = now; cur.h = e.h; cur.sl = e.sl; cur.bn = e.bn; cur.fz = e.fz; cur.t = e.t; }
        else buf.set(e.i, { fx: e.x, fy: e.y, tx: e.x, ty: e.y, at: now, h: e.h, sl: e.sl, bn: e.bn, fz: e.fz, t: e.t });
      }
      for (const id of [...buf.keys()]) if (!seen.has(id)) buf.delete(id);
    }

    // My HUD
    const me = lanes[myId];
    if (me) {
      myGold = me.gold; goldVal.textContent = myGold;
      mySendMeter = me.sendMeter;
      if (me.baseHp !== myHp) { prevHp = myHp; myHp = me.baseHp; onHpChange(); }
      updateSendUI();
      refreshShopAffordability();
    }
    // process events
    if (msg.events) for (const ev of msg.events) handleEvent(ev);
    // sidebar stats
    updateSidebarStats();
  }
  function lerpX(c) { const f = Math.min(1, (performance.now() - c.at) / TICK_MS); return c.fx + (c.tx - c.fx) * f; }
  function lerpY(c) { const f = Math.min(1, (performance.now() - c.at) / TICK_MS); return c.fy + (c.ty - c.fy) * f; }

  function onHpChange() {
    hpVal.textContent = `${Math.max(0, myHp)}/${maxHp}`;
    hpChip.classList.toggle('low', myHp <= 5);
    if (myHp < prevHp) { hpChip.classList.add('flash'); setTimeout(() => hpChip.classList.remove('flash'), 400); }
  }

  function handleEvent(ev) {
    if (ev.pid !== myId) return; // only render effects in our own lane (minimaps just use state)
    const now = performance.now();
    if (ev.ev === 'hit' || ev.ev === 'snipe') {
      if (ev.dmg) damageNumbers.push({ x: ev.ex, y: ev.ey, val: ev.dmg, until: now + 700, color: '#fff' });
      if (ev.tx !== undefined) effects.push({ kind: 'beam', x1: ev.tx, y1: ev.ty, x2: ev.ex, y2: ev.ey, until: now + 110, color: ev.ev === 'snipe' ? '#e2e8f0' : '#a3e635' });
      effects.push({ kind: 'spark', x: ev.ex, y: ev.ey, until: now + 180 });
    } else if (ev.ev === 'splash') {
      effects.push({ kind: 'explosion', x: ev.x, y: ev.y, r: ev.r, until: now + 320 });
    } else if (ev.ev === 'chain') {
      effects.push({ kind: 'chain', pts: ev.pts, until: now + 160 });
    } else if (ev.ev === 'frost') {
      effects.push({ kind: 'frost', x: ev.tx, y: ev.ty, until: now + 220 });
    } else if (ev.ev === 'burn') {
      effects.push({ kind: 'burn', x: ev.ex, y: ev.ey, until: now + 260 });
    } else if (ev.ev === 'kill') {
      const d = ENEMY_DEFS[ev.etype];
      effects.push({ kind: 'death', x: ev.ex, y: ev.ey, color: d ? d.color : '#fff', until: now + 300 });
      addKill(`Killed <b>${d ? d.name : ev.etype}</b> +${ev.reward}g`, false);
    } else if (ev.ev === 'reached') {
      effects.push({ kind: 'breach', until: now + 400 });
    }
  }

  let killItems = [];
  function addKill(html, isAttack) {
    const el = document.createElement('div');
    el.className = 'kf-item' + (isAttack ? ' attack' : '');
    el.innerHTML = html;
    killFeed.appendChild(el);
    killItems.push(el);
    while (killItems.length > 5) { const old = killItems.shift(); old.remove(); }
    setTimeout(() => { el.style.transition = 'opacity .4s'; el.style.opacity = '0'; setTimeout(() => { el.remove(); killItems = killItems.filter(k => k !== el); }, 400); }, 3500);
  }

  // ── Shop ──
  function buildShop() {
    towerShop.innerHTML = '';
    for (const type of TOWER_ORDER) {
      const def = TOWER_DEFS[type];
      const el = document.createElement('div');
      el.className = 'shop-tower';
      el.dataset.type = type;
      el.innerHTML = `<span class="st-icon">${def.icon}</span><span class="st-name">${def.name}</span><span class="st-cost">${def.levels[0].cost}g</span><span class="st-desc">${def.desc}</span>`;
      el.addEventListener('click', () => {
        if (selectedShopTower === type) { selectedShopTower = null; }
        else { selectedShopTower = type; selectedTowerId = null; towerPanel.style.display = 'none'; }
        refreshShopSelection();
      });
      towerShop.appendChild(el);
    }
  }
  function refreshShopSelection() {
    towerShop.querySelectorAll('.shop-tower').forEach(el => el.classList.toggle('selected', el.dataset.type === selectedShopTower));
  }
  function refreshShopAffordability() {
    towerShop.querySelectorAll('.shop-tower').forEach(el => {
      const def = TOWER_DEFS[el.dataset.type];
      el.classList.toggle('cant', myGold < def.levels[0].cost);
    });
  }

  // ── Send meter UI ──
  function buildSendTicks() {
    sendTicks.innerHTML = '';
    for (const pkg of SEND_PACKAGES) {
      const t = document.createElement('div');
      t.className = 'send-tick';
      t.style.left = (pkg.pts / SEND_MAX * 100) + '%';
      t.dataset.pts = pkg.pts;
      sendTicks.appendChild(t);
    }
  }
  function highestPkgIdx() { let idx = -1; for (let i = 0; i < SEND_PACKAGES.length; i++) if (mySendMeter >= SEND_PACKAGES[i].pts) idx = i; return idx; }
  function updateSendUI() {
    sendFill.style.width = Math.min(100, mySendMeter / SEND_MAX * 100) + '%';
    sendTicks.querySelectorAll('.send-tick').forEach(t => t.classList.toggle('reached', mySendMeter >= +t.dataset.pts));
    const idx = highestPkgIdx();
    if (idx >= 0) {
      sendThreshold.innerHTML = `ready: <b>${SEND_PACKAGES[idx].label}</b>`;
      btnSend.disabled = false; btnSend.classList.add('ready');
    } else {
      const next = SEND_PACKAGES[0];
      sendThreshold.innerHTML = `${mySendMeter}/${next.pts} pts → ${next.label}`;
      btnSend.disabled = true; btnSend.classList.remove('ready');
    }
  }

  function doSend() {
    const idx = highestPkgIdx();
    if (idx < 0) return;
    const opponents = playersInfo.filter(p => p.id !== myId && lanes[p.id] && lanes[p.id].alive);
    if (opponents.length === 0) return;
    if (opponents.length === 1) { wsSend({ type: 'td-send-enemies', packageIdx: idx, targetId: opponents[0].id }); return; }
    // open target picker
    tpList.innerHTML = '';
    for (const p of opponents) {
      const lane = lanes[p.id];
      const opt = document.createElement('div');
      opt.className = 'tp-opt';
      opt.innerHTML = `<span class="dot" style="background:${COLORS[p.colorIdx % 4]}"></span><span class="nm">${escapeHtml(p.name)}</span><span class="hp">🛡️ ${lane.baseHp}</span>`;
      opt.addEventListener('click', () => { wsSend({ type: 'td-send-enemies', packageIdx: idx, targetId: p.id }); targetPicker.style.display = 'none'; });
      tpList.appendChild(opt);
    }
    targetPicker.style.display = 'block';
  }

  // ── Minimaps ──
  function buildMinimaps() {
    minimapsEl.innerHTML = '';
    miniCanvases.clear();
    const opponents = playersInfo.filter(p => p.id !== myId);
    const mw = 200, mh = Math.round(mw * ROWS / COLS);
    for (const p of opponents) {
      const wrap = document.createElement('div');
      wrap.className = 'mini';
      wrap.innerHTML = `<div class="mini-head"><span class="dot" style="background:${COLORS[p.colorIdx % 4]}"></span><span class="nm">${escapeHtml(p.name)}</span><span class="wv" data-wv></span></div>`;
      const cv = document.createElement('canvas');
      cv.width = mw; cv.height = mh;
      wrap.appendChild(cv);
      const hp = document.createElement('div'); hp.className = 'mini-hp'; hp.innerHTML = '<div class="fill"></div>';
      wrap.appendChild(hp);
      const skull = document.createElement('div'); skull.className = 'mini-skull'; skull.textContent = '💀'; skull.style.display = 'none';
      wrap.appendChild(skull);
      minimapsEl.appendChild(wrap);
      miniCanvases.set(p.id, { wrap, canvas: cv, ctx: cv.getContext('2d'), hpFill: hp.querySelector('.fill'), wv: wrap.querySelector('[data-wv]'), skull, colorIdx: p.colorIdx });

      // hover tooltip
      wrap.addEventListener('mousemove', ev => showMiniTip(p.id, ev));
      wrap.addEventListener('mouseleave', hideMiniTip);
    }
  }

  let tipEl = null;
  function showMiniTip(pid, ev) {
    const lane = lanes[pid]; if (!lane) return;
    if (!tipEl) { tipEl = document.createElement('div'); tipEl.className = 'mini-tip'; document.body.appendChild(tipEl); }
    const info = playersInfo.find(p => p.id === pid);
    tipEl.innerHTML = `<b>${escapeHtml(info ? info.name : '')}</b><br>🛡️ HP ${lane.baseHp} · 💰 ${lane.gold}<br>Kills ${lane.kills} · Sent ${lane.sent}`;
    tipEl.style.display = 'block';
    tipEl.style.left = (ev.clientX - 180) + 'px';
    tipEl.style.top = (ev.clientY - 10) + 'px';
  }
  function hideMiniTip() { if (tipEl) tipEl.style.display = 'none'; }

  function drawMinimaps() {
    const now = performance.now();
    for (const [pid, m] of miniCanvases) {
      const lane = lanes[pid]; if (!lane) continue;
      const c = m.ctx, W = m.canvas.width, H = m.canvas.height;
      const sx = W / COLS, sy = H / ROWS;
      c.fillStyle = '#0d1117'; c.fillRect(0, 0, W, H);
      // path
      c.strokeStyle = '#3a3526'; c.lineWidth = sy * 0.8; c.lineCap = 'round'; c.lineJoin = 'round';
      c.beginPath();
      for (let i = 0; i < path.length; i++) { const px = (path[i].x + 0.5) * sx, py = (path[i].y + 0.5) * sy; i ? c.lineTo(px, py) : c.moveTo(px, py); }
      c.stroke();
      // towers
      for (const t of lane.towers) { c.fillStyle = TOWER_DEFS[t.type].color; c.fillRect((t.x + 0.2) * sx, (t.y + 0.2) * sy, sx * 0.6, sy * 0.6); }
      // enemies
      for (const e of lane.enemies) { const d = ENEMY_DEFS[e.t]; c.fillStyle = d.color; c.beginPath(); c.arc((e.x + 0.5) * sx, (e.y + 0.5) * sy, Math.max(1.5, d.r * sx), 0, 7); c.fill(); }
      // attack flash at entrance
      if (m.attackUntil && now < m.attackUntil) {
        c.fillStyle = m.attackColor; c.globalAlpha = (m.attackUntil - now) / 800;
        c.fillRect((path[0].x) * sx, (path[0].y) * sy, sx * 2, sy * 2); c.globalAlpha = 1;
      }
      m.hpFill.style.width = Math.max(0, lane.baseHp / maxHp * 100) + '%';
      m.hpFill.style.background = lane.baseHp <= 5 ? 'var(--danger)' : 'var(--success)';
      m.wv.textContent = 'W' + wave;
      // base damage pulse
      if (lane._lastHp === undefined) lane._lastHp = lane.baseHp;
      if (lane.baseHp < (m._prevHp ?? lane.baseHp)) { m.wrap.classList.add('flash'); setTimeout(() => m.wrap.classList.remove('flash'), 350); }
      m._prevHp = lane.baseHp;
    }
  }
  let lastMiniDraw = 0;

  // ── Main lane render ──
  function loop() { rafId = requestAnimationFrame(loop); render(); }
  let rafId = null;

  function render() {
    const now = performance.now();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // terrain
    for (let y = 0; y < ROWS; y++) for (let x = 0; x < COLS; x++) {
      const onPath = pathSet.has(y * COLS + x);
      ctx.fillStyle = onPath ? '#cdb98c' : ((x + y) % 2 ? '#1b2230' : '#202838');
      ctx.fillRect(x * CELL, y * CELL, CELL, CELL);
      if (onPath) { ctx.fillStyle = 'rgba(0,0,0,0.05)'; ctx.fillRect(x * CELL, y * CELL, CELL, CELL); }
    }
    // path outline (entrance/exit)
    if (path.length) {
      ctx.fillStyle = 'rgba(34,197,94,0.25)'; ctx.fillRect(path[0].x * CELL, path[0].y * CELL, CELL, CELL);
      const last = path[path.length - 1];
      ctx.fillStyle = 'rgba(239,68,68,0.3)'; ctx.fillRect(last.x * CELL, last.y * CELL, CELL, CELL);
      ctx.font = `${CELL * 0.7}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText('🏰', (last.x + 0.5) * CELL, (last.y + 0.5) * CELL);
    }

    const me = lanes[myId];

    // hover ghost / range when placing
    if (selectedShopTower && hoverCell) {
      const def = TOWER_DEFS[selectedShopTower];
      const ok = isBuildable(hoverCell.x, hoverCell.y) && !(me && me.towers.some(t => t.x === hoverCell.x && t.y === hoverCell.y));
      drawRange((hoverCell.x + 0.5) * CELL, (hoverCell.y + 0.5) * CELL, def.levels[0].range * CELL, ok ? 'rgba(6,182,212,0.5)' : 'rgba(239,68,68,0.5)');
      ctx.globalAlpha = 0.6; ctx.font = `${CELL * 0.7}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(def.icon, (hoverCell.x + 0.5) * CELL, (hoverCell.y + 0.5) * CELL); ctx.globalAlpha = 1;
    }

    // selected tower range
    if (me && selectedTowerId != null) {
      const t = me.towers.find(t => t.id === selectedTowerId);
      if (t) { const lvl = TOWER_DEFS[t.type].levels[t.level - 1]; drawRange((t.x + 0.5) * CELL, (t.y + 0.5) * CELL, lvl.range * CELL, 'rgba(167,139,250,0.55)'); }
    }

    // towers
    if (me) for (const t of me.towers) drawTower(t);

    // enemies (interpolated)
    const buf = laneRender[myId];
    if (buf) for (const [, e] of buf) drawEnemy(e, now);

    // effects
    drawEffects(now);
    // damage numbers
    for (let i = damageNumbers.length - 1; i >= 0; i--) {
      const d = damageNumbers[i];
      const t = (d.until - now) / 700;
      if (t <= 0) { damageNumbers.splice(i, 1); continue; }
      ctx.globalAlpha = Math.min(1, t * 1.5);
      ctx.fillStyle = d.color; ctx.font = `bold ${CELL * 0.45}px Orbitron, sans-serif`; ctx.textAlign = 'center';
      ctx.fillText(d.val, d.x * CELL + CELL / 2, (d.y + 0.5) * CELL - (1 - t) * CELL); ctx.globalAlpha = 1;
    }

    // timer / wave HUD
    updateTimerHUD();

    // minimaps @ ~500ms
    if (now - lastMiniDraw > 250) { drawMinimaps(); lastMiniDraw = now; }
  }

  function drawRange(cx, cy, r, color) { ctx.beginPath(); ctx.arc(cx, cy, r, 0, 7); ctx.fillStyle = color.replace(/[\d.]+\)$/, '0.08)'); ctx.fill(); ctx.strokeStyle = color; ctx.lineWidth = 1.5; ctx.stroke(); }

  function drawTower(t) {
    const def = TOWER_DEFS[t.type];
    const cx = (t.x + 0.5) * CELL, cy = (t.y + 0.5) * CELL;
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.arc(cx, cy + 2, CELL * 0.42, 0, 7); ctx.fill();
    ctx.fillStyle = def.color; ctx.beginPath(); ctx.arc(cx, cy, CELL * 0.40, 0, 7); ctx.fill();
    ctx.fillStyle = '#0a0a1a'; ctx.beginPath(); ctx.arc(cx, cy, CELL * 0.30, 0, 7); ctx.fill();
    ctx.font = `${CELL * 0.42}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(def.icon, cx, cy + 1);
    // level pips
    for (let i = 0; i < t.level; i++) { ctx.fillStyle = '#fbbf24'; ctx.beginPath(); ctx.arc(cx - CELL * 0.25 + i * 6, cy - CELL * 0.35, 2.2, 0, 7); ctx.fill(); }
    // perk markers (purple ring + count)
    const pk = (t.perks || []).length;
    if (pk) {
      ctx.strokeStyle = '#c084fc'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, CELL * 0.44, 0, 7); ctx.stroke();
      for (let i = 0; i < pk; i++) { ctx.fillStyle = '#c084fc'; ctx.beginPath(); ctx.arc(cx - CELL * 0.2 + i * 6, cy + CELL * 0.34, 2.4, 0, 7); ctx.fill(); }
    }
  }

  function drawEnemy(e, now) {
    const d = ENEMY_DEFS[e.t]; if (!d) return;
    const x = lerpX(e), y = lerpY(e);
    const cx = (x + 0.5) * CELL, cy = (y + 0.5) * CELL, r = d.r * CELL;
    // body
    ctx.fillStyle = d.color;
    ctx.beginPath();
    if (d.shape === 'circle') ctx.arc(cx, cy, r, 0, 7);
    else if (d.shape === 'square') ctx.rect(cx - r, cy - r, r * 2, r * 2);
    else if (d.shape === 'tri') { ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy + r); ctx.lineTo(cx - r, cy + r); ctx.closePath(); }
    else if (d.shape === 'diamond') { ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath(); }
    else if (d.shape === 'hex') { for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i - Math.PI / 6; const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } ctx.closePath(); }
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.5; ctx.stroke();
    // status tints
    if (e.fz) { ctx.fillStyle = 'rgba(125,211,252,0.55)'; ctx.beginPath(); ctx.arc(cx, cy, r + 3, 0, 7); ctx.fill(); ctx.strokeStyle = '#e0f2fe'; ctx.lineWidth = 1.5; ctx.stroke(); }
    else if (e.sl) { ctx.fillStyle = 'rgba(56,189,248,0.35)'; ctx.beginPath(); ctx.arc(cx, cy, r + 2, 0, 7); ctx.fill(); }
    if (e.bn) { ctx.fillStyle = 'rgba(239,68,68,0.3)'; ctx.beginPath(); ctx.arc(cx, cy - r, 2.5, 0, 7); ctx.fill(); }
    // hp bar
    const bw = r * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(cx - bw / 2, cy - r - 7, bw, 4);
    ctx.fillStyle = e.h > 0.5 ? '#22c55e' : e.h > 0.25 ? '#f59e0b' : '#ef4444';
    ctx.fillRect(cx - bw / 2, cy - r - 7, bw * e.h, 4);
  }

  function drawEffects(now) {
    for (let i = effects.length - 1; i >= 0; i--) {
      const f = effects[i];
      if (now >= f.until) { effects.splice(i, 1); continue; }
      const life = (f.until - now);
      if (f.kind === 'beam') { ctx.strokeStyle = f.color; ctx.lineWidth = 2.5; ctx.globalAlpha = Math.min(1, life / 110); ctx.beginPath(); ctx.moveTo((f.x1 + 0.5) * CELL, (f.y1 + 0.5) * CELL); ctx.lineTo((f.x2 + 0.5) * CELL, (f.y2 + 0.5) * CELL); ctx.stroke(); ctx.globalAlpha = 1; }
      else if (f.kind === 'spark') { ctx.fillStyle = '#fff'; ctx.globalAlpha = life / 180; ctx.beginPath(); ctx.arc((f.x + 0.5) * CELL, (f.y + 0.5) * CELL, 4, 0, 7); ctx.fill(); ctx.globalAlpha = 1; }
      else if (f.kind === 'explosion') { const p = 1 - life / 320; ctx.fillStyle = `rgba(249,115,22,${0.5 * (1 - p)})`; ctx.beginPath(); ctx.arc((f.x + 0.5) * CELL, (f.y + 0.5) * CELL, f.r * CELL * (0.4 + p), 0, 7); ctx.fill(); ctx.strokeStyle = `rgba(253,224,71,${1 - p})`; ctx.lineWidth = 2; ctx.stroke(); }
      else if (f.kind === 'chain') { ctx.strokeStyle = '#a78bfa'; ctx.lineWidth = 2; ctx.globalAlpha = life / 160; ctx.beginPath(); for (let j = 0; j < f.pts.length; j++) { const px = (f.pts[j].x + 0.5) * CELL, py = (f.pts[j].y + 0.5) * CELL; j ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } ctx.stroke(); ctx.globalAlpha = 1; }
      else if (f.kind === 'frost') { ctx.strokeStyle = `rgba(56,189,248,${life / 220})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc((f.x + 0.5) * CELL, (f.y + 0.5) * CELL, CELL * 2.8 * (1 - life / 220), 0, 7); ctx.stroke(); }
      else if (f.kind === 'burn') { ctx.fillStyle = `rgba(239,68,68,${life / 260})`; ctx.font = `${CELL * 0.5}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText('🔥', (f.x + 0.5) * CELL, (f.y + 0.5) * CELL); }
      else if (f.kind === 'death') { const p = 1 - life / 300; ctx.fillStyle = f.color; ctx.globalAlpha = 1 - p; for (let k = 0; k < 6; k++) { const a = k / 6 * 7; ctx.beginPath(); ctx.arc((f.x + 0.5) * CELL + Math.cos(a) * p * 14, (f.y + 0.5) * CELL + Math.sin(a) * p * 14, 3, 0, 7); ctx.fill(); } ctx.globalAlpha = 1; }
      else if (f.kind === 'breach') { ctx.fillStyle = `rgba(239,68,68,${life / 400 * 0.4})`; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    }
  }

  function updateTimerHUD() {
    if (phase === 'prep') {
      const rem = Math.max(0, phaseRemainingMs - (performance.now() - phaseStampAt));
      const s = Math.ceil(rem / 1000);
      wavePill.textContent = wave === 0 ? 'Get Ready' : `Wave ${wave + 1} in`;
      timerDisplay.textContent = s + 's';
      timerDisplay.classList.toggle('danger', s <= 5);
    } else {
      wavePill.textContent = 'Wave ' + wave;
      const me = lanes[myId];
      const remaining = me ? me.enemies.length : 0;
      timerDisplay.textContent = remaining ? remaining + ' 👾' : '…';
      timerDisplay.classList.remove('danger');
    }
  }

  function updateSidebarStats() {
    for (const [pid, lane] of Object.entries(lanes)) {
      const c = playerCards.get(pid);
      if (!c) continue;
      const stats = c.el.querySelector('[data-stats]');
      if (stats) stats.innerHTML = `<span>🛡️${lane.baseHp}</span><span>💰${lane.gold}</span>`;
      c.el.classList.toggle('dead', !lane.alive);
    }
  }

  function isBuildable(x, y) { return x >= 0 && x < COLS && y >= 0 && y < ROWS && !pathSet.has(y * COLS + x); }

  // ── Canvas interaction ──
  function cellFromEvent(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.floor((ev.clientX - rect.left) / rect.width * COLS);
    const y = Math.floor((ev.clientY - rect.top) / rect.height * ROWS);
    return { x, y };
  }
  canvas.addEventListener('mousemove', ev => { hoverCell = cellFromEvent(ev); });
  canvas.addEventListener('mouseleave', () => { hoverCell = null; });
  canvas.addEventListener('click', ev => {
    if (!matchActive) return;
    const cell = cellFromEvent(ev);
    const me = lanes[myId];
    if (!me || !me.alive) return;
    if (selectedShopTower) {
      if (isBuildable(cell.x, cell.y) && !me.towers.some(t => t.x === cell.x && t.y === cell.y)) {
        wsSend({ type: 'td-place-tower', towerType: selectedShopTower, x: cell.x, y: cell.y });
      } else flashStatus('Place on a dark buildable tile');
      return;
    }
    // select existing tower
    const t = me.towers.find(t => t.x === cell.x && t.y === cell.y);
    if (t) { selectedTowerId = t.id; openTowerPanel(t); }
    else { selectedTowerId = null; towerPanel.style.display = 'none'; }
  });

  function openTowerPanel(t) {
    const def = TOWER_DEFS[t.type];
    const lvl = def.levels[t.level - 1];
    const next = def.levels[t.level]; // may be undefined
    const refund = Math.floor(t.invested * 0.6);
    const owned = t.perks || [];
    let statsHtml = `<div>Damage: ${lvl.damage || (lvl.burn ? lvl.burn + '/s burn' : lvl.slow ? (lvl.slow * 100) + '% slow' : '—')}</div>`;
    statsHtml += `<div>Range: ${lvl.range.toFixed(1)} · Rate: ${(1000 / lvl.fireMs).toFixed(2)}/s</div>`;
    statsHtml += `<div>Type: ${def.dmgClass}</div>`;
    if (next) {
      const dmgFrom = lvl.damage || lvl.burn || (lvl.slow ? lvl.slow * 100 : 0);
      const dmgTo = next.damage || next.burn || (next.slow ? next.slow * 100 : 0);
      statsHtml += `<div class="up">⬆ Lvl ${t.level + 1}: dmg ${dmgFrom}→${dmgTo}, range ${lvl.range.toFixed(1)}→${next.range.toFixed(1)}</div>`;
    }
    let actions = '';
    if (next) actions += `<button class="btn btn-sm btn-upgrade" id="tpUpgrade">⬆ ${next.cost}g</button>`;
    else actions += `<button class="btn btn-sm" disabled>MAX</button>`;
    actions += `<button class="btn btn-sm btn-sell" id="tpSell">Sell ${refund}g</button>`;
    // Perk shop
    const perks = PERKS[t.type] || [];
    let perkHtml = '<div class="tp-perks-title">⚙ Modifiers</div><div class="tp-perks">';
    for (const pk of perks) {
      const have = owned.includes(pk.id);
      const afford = myGold >= pk.cost;
      perkHtml += `<button class="perk${have ? ' owned' : ''}${(!have && !afford) ? ' cant' : ''}" data-perk="${pk.id}" ${have ? 'disabled' : ''} title="${escapeHtml(pk.name)} — ${escapeHtml(pk.desc)}"><span class="pk-ic">${pk.icon}</span><span class="pk-nm">${escapeHtml(pk.name)}</span><span class="pk-cost">${have ? '✓ owned' : pk.cost + 'g'}</span></button>`;
    }
    perkHtml += '</div>';
    towerPanel.innerHTML = `<div class="tp-head">${def.icon} ${def.name}<span class="tp-lvl">Lv ${t.level}/3</span></div><div class="tp-stats">${statsHtml}</div><div class="tp-actions">${actions}<button class="btn btn-sm btn-close-tp" id="tpClose">✕</button></div>${perkHtml}`;
    // position near tower
    const rect = canvas.getBoundingClientRect();
    const wrapRect = canvas.parentElement.getBoundingClientRect();
    const px = rect.left - wrapRect.left + (t.x + 1) / COLS * rect.width;
    const py = rect.top - wrapRect.top + (t.y) / ROWS * rect.height;
    towerPanel.style.left = Math.min(px, wrapRect.width - 230) + 'px';
    towerPanel.style.top = Math.max(4, Math.min(py, wrapRect.height - 260)) + 'px';
    towerPanel.style.display = 'block';
    const reopen = () => setTimeout(() => { const nt = (lanes[myId] && lanes[myId].towers || []).find(x => x.id === t.id); if (nt && selectedTowerId === t.id) openTowerPanel(nt); }, 130);
    const up = $('tpUpgrade'); if (up) up.onclick = () => { wsSend({ type: 'td-upgrade-tower', towerId: t.id }); reopen(); };
    $('tpSell').onclick = () => { wsSend({ type: 'td-sell-tower', towerId: t.id }); towerPanel.style.display = 'none'; selectedTowerId = null; };
    $('tpClose').onclick = () => { towerPanel.style.display = 'none'; selectedTowerId = null; };
    towerPanel.querySelectorAll('.perk:not(.owned)').forEach(btn => {
      btn.onclick = () => { wsSend({ type: 'td-buy-perk', towerId: t.id, perkId: btn.dataset.perk }); reopen(); };
    });
  }

  // ── Buttons ──
  btnStart.addEventListener('click', () => wsSend({ type: 'td-start', mode: selMode, map: selMap }));
  btnSend.addEventListener('click', doSend);
  tpCancel.addEventListener('click', () => { targetPicker.style.display = 'none'; });
  btnBack.addEventListener('click', () => { wsSend({ type: 'leave-room' }); location.href = '/'; });
  $('btnBackLobby').addEventListener('click', () => { location.href = '/'; });
  $('btnRules').addEventListener('click', () => { rulesOverlay.style.display = 'flex'; });
  $('btnCloseRules').addEventListener('click', () => { rulesOverlay.style.display = 'none'; });
  $('btnToggleSidebar').addEventListener('click', () => $('sidebar').classList.toggle('open'));
  $('btnToggleRail').addEventListener('click', () => $('rightRail').classList.toggle('open'));
  chatSend.addEventListener('click', sendChat);
  chatInput.addEventListener('keydown', e => { if (e.key === 'Enter') sendChat(); });
  function sendChat() { const text = chatInput.value.trim(); if (!text) return; wsSend({ type: 'chat', text }); chatInput.value = ''; }

  document.addEventListener('keydown', e => {
    if (document.activeElement === chatInput) return;
    if (e.key === 'Escape') { selectedShopTower = null; selectedTowerId = null; towerPanel.style.display = 'none'; targetPicker.style.display = 'none'; refreshShopSelection(); }
    const idx = parseInt(e.key); // 1-6 quick select towers
    if (idx >= 1 && idx <= 6) { selectedShopTower = TOWER_ORDER[idx - 1]; selectedTowerId = null; towerPanel.style.display = 'none'; refreshShopSelection(); }
    if (e.key === ' ' && !btnSend.disabled) { e.preventDefault(); doSend(); }
  });

  connect();
})();

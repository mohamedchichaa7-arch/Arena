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
  const botToggle = $('botToggle'), botLabel = $('botLabel');
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
    arrow:   { name: 'Arrow',   superName: 'Ballista',      icon: '🏹', color: '#22c55e', dmgClass: 'physical', antiAir: true,  desc: 'Fast · single · hits flyers',
      levels: [{ cost: 50, damage: 14, range: 3.0, fireMs: 480 }, { cost: 45, damage: 26, range: 3.3, fireMs: 420 }, { cost: 75, damage: 44, range: 3.6, fireMs: 350 }, { cost: 350, damage: 200, range: 5.0, fireMs: 200 }] },
    cannon:  { name: 'Cannon',  superName: 'Siege Engine',  icon: '💣', color: '#f97316', dmgClass: 'physical',               desc: 'AoE splash',
      levels: [{ cost: 100, damage: 45, range: 2.6, fireMs: 1300, splash: 1.3 }, { cost: 85, damage: 80, range: 2.7, fireMs: 1200, splash: 1.5 }, { cost: 150, damage: 135, range: 2.9, fireMs: 1050, splash: 1.7 }, { cost: 400, damage: 420, range: 3.5, fireMs: 800, splash: 2.8 }] },
    frost:   { name: 'Frost',   superName: 'Blizzard',      icon: '❄️', color: '#38bdf8', dmgClass: 'none',                   desc: 'Slows enemies',
      levels: [{ cost: 80, damage: 0, range: 2.8, fireMs: 700, slow: 0.4, slowMs: 2000 }, { cost: 65, damage: 0, range: 3.0, fireMs: 700, slow: 0.5, slowMs: 2000 }, { cost: 110, damage: 0, range: 3.3, fireMs: 700, slow: 0.6, slowMs: 2500 }, { cost: 350, damage: 0, range: 5.0, fireMs: 500, slow: 0.8, slowMs: 4000 }] },
    tesla:   { name: 'Tesla',   superName: 'Storm Spire',   icon: '⚡', color: '#a78bfa', dmgClass: 'magic',   antiAir: true,  desc: 'Chain lightning · hits flyers',
      levels: [{ cost: 150, damage: 24, range: 3.0, fireMs: 700, chains: 4 }, { cost: 115, damage: 38, range: 3.2, fireMs: 650, chains: 5 }, { cost: 185, damage: 58, range: 3.4, fireMs: 600, chains: 6 }, { cost: 450, damage: 200, range: 4.5, fireMs: 380, chains: 16 }] },
    inferno: { name: 'Inferno', superName: 'Volcano',       icon: '🔥', color: '#ef4444', dmgClass: 'magic',                  desc: 'Burn (stacks 3)',
      levels: [{ cost: 120, damage: 0, range: 2.8, fireMs: 500, burn: 9, burnMs: 3000 }, { cost: 90, damage: 0, range: 3.0, fireMs: 500, burn: 15, burnMs: 3000 }, { cost: 150, damage: 0, range: 3.2, fireMs: 500, burn: 24, burnMs: 3000 }, { cost: 400, damage: 0, range: 4.2, fireMs: 300, burn: 90, burnMs: 4500 }] },
    sniper:  { name: 'Sniper',  superName: 'War Cannon',    icon: '🎯', color: '#e2e8f0', dmgClass: 'physical', antiAir: true, reveals: true, desc: 'Huge range · reveals cloakers',
      levels: [{ cost: 180, damage: 160, range: 8.0, fireMs: 3000 }, { cost: 140, damage: 300, range: 8.5, fireMs: 2600 }, { cost: 220, damage: 520, range: 9.5, fireMs: 2200 }, { cost: 550, damage: 1800, range: 14.0, fireMs: 1500 }] },
    missile: { name: 'Missile', superName: 'MLRS',          icon: '🚀', color: '#f59e0b', dmgClass: 'physical', antiAir: true, desc: 'Splash · anti-air',
      levels: [{ cost: 140, damage: 55, range: 3.8, fireMs: 1200, splash: 0.9 }, { cost: 110, damage: 90, range: 4.1, fireMs: 1050, splash: 1.1 }, { cost: 180, damage: 150, range: 4.4, fireMs: 900, splash: 1.3 }, { cost: 450, damage: 500, range: 6.0, fireMs: 600, splash: 2.2 }] },
    laser:   { name: 'Laser',   superName: 'Photon Cannon', icon: '🔴', color: '#f43f5e', dmgClass: 'true',     antiAir: true, reveals: true, desc: 'True dmg · fast · reveals',
      levels: [{ cost: 160, damage: 22, range: 3.5, fireMs: 220 }, { cost: 130, damage: 38, range: 3.8, fireMs: 200 }, { cost: 200, damage: 62, range: 4.2, fireMs: 180 }, { cost: 500, damage: 180, range: 5.5, fireMs: 120 }] },
    venom:   { name: 'Venom',   superName: 'Plague Spire',  icon: '🧪', color: '#84cc16', dmgClass: 'magic',                  desc: 'Poison DoT stack',
      levels: [{ cost: 110, damage: 0, range: 2.7, fireMs: 600, venom: 10, venomMs: 4500 }, { cost: 90, damage: 0, range: 3.0, fireMs: 550, venom: 17, venomMs: 5000 }, { cost: 145, damage: 0, range: 3.3, fireMs: 500, venom: 28, venomMs: 5500 }, { cost: 380, damage: 0, range: 5.0, fireMs: 350, venom: 100, venomMs: 8000 }] },
    railgun: { name: 'Railgun', superName: 'Mass Driver',   icon: '🔫', color: '#06b6d4', dmgClass: 'physical', antiAir: true, desc: 'Pierces all · huge range',
      levels: [{ cost: 200, damage: 180, range: 6.5, fireMs: 3800 }, { cost: 175, damage: 340, range: 7.5, fireMs: 3200 }, { cost: 280, damage: 580, range: 8.5, fireMs: 2700 }, { cost: 600, damage: 2200, range: 12.0, fireMs: 1500 }] },
  };
  const TOWER_ORDER = ['arrow','cannon','frost','tesla','inferno','sniper','missile','laser','venom','railgun'];

  const ENEMY_DEFS = {
    grunt:       { name: 'Grunt',      color: '#9ca3af', r: 0.30, shape: 'circle' },
    runner:      { name: 'Runner',     color: '#fde047', r: 0.24, shape: 'tri' },
    brute:       { name: 'Brute',      color: '#b45309', r: 0.40, shape: 'square' },
    armored:     { name: 'Armored',    color: '#64748b', r: 0.36, shape: 'hex' },
    phantom:     { name: 'Phantom',    color: '#c084fc', r: 0.32, shape: 'diamond' },
    boss:        { name: 'Boss',       color: '#dc2626', r: 0.52, shape: 'circle' },
    splitter:    { name: 'Splitter',   color: '#f97316', r: 0.44, shape: 'star' },
    splitling:   { name: 'Splitling',  color: '#fb923c', r: 0.22, shape: 'circle' },
    cloaker:     { name: 'Cloaker',    color: '#818cf8', r: 0.30, shape: 'diamond', cloaked: true },
    flyer:       { name: 'Flyer',      color: '#67e8f9', r: 0.26, shape: 'tri',    flying: true },
    colossus:    { name: 'Colossus',   color: '#b91c1c', r: 0.60, shape: 'hex' },
    blinker:     { name: 'Blinker',    color: '#a3e635', r: 0.28, shape: 'diamond' },
    regenerator: { name: 'Regen',      color: '#4ade80', r: 0.42, shape: 'square' },
  };

  const SEND_PACKAGES = [
    { pts: 10,  label: '5 Grunts' },
    { pts: 20,  label: '3 Runners + Flyer' },
    { pts: 30,  label: '2 Brutes' },
    { pts: 40,  label: '3 Blinkers' },
    { pts: 55,  label: '2 Cloakers + Armored' },
    { pts: 75,  label: 'Splitter + 2 Runners' },
    { pts: 100, label: '1 Boss' },
    { pts: 140, label: '1 Colossus' },
  ];
  const SEND_MAX = 140;

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

  // ── Lane upgrades (mirror server) ──
  const LANE_UPGRADES = {
    income:     { name:'Tax Office',     icon:'\u{1F4B0}', cost:120, desc:'+6 income per interval.' },
    kill_gold:  { name:'Bounty Board',   icon:'\u{1F3AF}', cost:140, desc:'+2g per kill.' },
    wave_bonus: { name:'War Chest',      icon:'\u{1F381}', cost:180, desc:'+50g at wave start.' },
    dmg_amp:    { name:'Forge',          icon:'\u2692',    cost:150, desc:'All towers +15% damage.' },
    range_amp:  { name:'Watchtower',     icon:'\u{1F5FC}', cost:160, desc:'All towers +0.5 range.' },
    speed_amp:  { name:'Clockwork',      icon:'\u23F1',    cost:200, desc:'Towers reload 15% faster.' },
    regen:      { name:'Field Hospital', icon:'\u2764',    cost:180, desc:'+1 HP every 3 clean waves.' },
    send_amp:   { name:'War Machine',    icon:'\u2694',    cost:150, desc:'+25% send meter from kills.' },
    boss_bane:  { name:'Giant Slayer',   icon:'\u{1F409}', cost:220, desc:'All towers +35% vs Bosses.' },
  };
  const LANE_UPGRADE_ORDER = ['income','kill_gold','wave_bonus','dmg_amp','range_amp','speed_amp','regen','send_amp','boss_bane'];

  // ── Active abilities (mirror server) ──
  const ABILITIES = {
    airstrike: { name:'Airstrike',  icon:'\u2708',    cost:350, cooldownMs:90000,  desc:'Deal 500 dmg to all enemies in your lane.' },
    gold_rush:  { name:'Gold Rush', icon:'\u{1F48E}', cost:200, cooldownMs:75000,  desc:'Instantly gain 150g.' },
    fortify:   { name:'Fortify',    icon:'\u{1F6E1}', cost:220, cooldownMs:120000, desc:'All towers +50% dmg for 12 sec.' },
    overclock: { name:'Overclock',  icon:'\u26A1',    cost:180, cooldownMs:100000, desc:'Towers fire 60% faster for 10 sec.' },
    repair:    { name:'Repair',     icon:'\u{1F527}', cost:300, cooldownMs:180000, desc:'Restore 2 HP to your base.' },
  };
  const ABILITY_ORDER = ['airstrike','gold_rush','fortify','overclock','repair'];

  // ── Per-tower perks (mirror server) ──
  const PERKS = {
    arrow: [
      { id: 'pierce', name: 'Piercing Shot',   icon: '➶', cost: 120, desc: 'Each shot strikes up to 3 enemies.' },
      { id: 'eagle',  name: 'Eagle Eye',        icon: '👁', cost: 140, desc: '+0.8 range · 25% chance for a triple-damage crit.' },
      { id: 'rapid',  name: 'Rapid Fire',       icon: '💨', cost: 130, desc: 'Reload 35% faster.' },
    ],
    cannon: [
      { id: 'cluster', name: 'Cluster Bombs',   icon: '✸', cost: 150, desc: '+0.9 splash radius · +15% damage.' },
      { id: 'siege',   name: 'Siege Payload',   icon: '🛠', cost: 170, desc: '+60% damage to Brutes, Armored & Bosses.' },
      { id: 'napalm',  name: 'Napalm',          icon: '🔥', cost: 160, desc: 'Blasts ignite everything hit.' },
    ],
    frost: [
      { id: 'permafrost', name: 'Permafrost',   icon: '🧊', cost: 120, desc: 'Stronger slow, lasts far longer.' },
      { id: 'shatter',    name: 'Shatter',       icon: '💔', cost: 150, desc: 'Slowed enemies take +25% damage.' },
      { id: 'coldsnap',   name: 'Cold Snap',     icon: '❄', cost: 200, desc: '12% chance to freeze for 0.8s.' },
    ],
    tesla: [
      { id: 'overload', name: 'Overload',        icon: '⚡', cost: 160, desc: '+2 chain jumps · +20% damage.' },
      { id: 'conduct',  name: 'Conductor',       icon: '🔗', cost: 170, desc: 'Each chain jump deals 25% more.' },
      { id: 'static',   name: 'Static Field',    icon: '🌀', cost: 140, desc: 'Struck enemies are slowed 25%.' },
    ],
    inferno: [
      { id: 'incinerate', name: 'Incinerate',    icon: '☄', cost: 180, desc: '+60% burn damage.' },
      { id: 'pyro',       name: 'Pyromaniac',    icon: '🎇', cost: 130, desc: 'Burn stacks to 5, ignites two targets.' },
      { id: 'wildfire',   name: 'Wildfire',      icon: '🌋', cost: 160, desc: 'Burns spread to a nearby enemy.' },
    ],
    sniper: [
      { id: 'armorpierce', name: 'Armor Pierce', icon: '🗡', cost: 150, desc: 'Shots ignore all armor.' },
      { id: 'execute',     name: 'Executioner',  icon: '☠', cost: 220, desc: 'Instakill non-bosses under 18% HP · +40% vs bosses.' },
      { id: 'doubletap',   name: 'Double Tap',   icon: '⏩', cost: 200, desc: 'Fires twice per shot.' },
    ],
    missile: [
      { id: 'warhead',  name: 'Warhead',          icon: '💥', cost: 160, desc: '+0.6 splash · +40% damage vs flying.' },
      { id: 'tracker',  name: 'Tracker',          icon: '🔍', cost: 140, desc: '+0.8 range · reveals & targets cloakers.' },
      { id: 'barrage',  name: 'Barrage',          icon: '🚀', cost: 180, desc: 'Fires 2 missiles simultaneously.' },
    ],
    laser: [
      { id: 'prismatic',  name: 'Prismatic',      icon: '🌈', cost: 180, desc: 'Beam chains to 3 total enemies.' },
      { id: 'overcharge', name: 'Overcharge',     icon: '🔴', cost: 160, desc: 'Every 5th shot deals triple damage.' },
      { id: 'blind',      name: 'Blind',          icon: '🕶',  cost: 150, desc: 'Struck enemies are slowed 40% for 1.5s.' },
    ],
    venom: [
      { id: 'corrosive',  name: 'Corrosive',      icon: '🧪', cost: 150, desc: 'Poisoned enemies take +30% physical damage.' },
      { id: 'plague',     name: 'Plague',         icon: '☣', cost: 170, desc: 'Venom spreads to 2 additional enemies.' },
      { id: 'neurotoxin', name: 'Neurotoxin',     icon: '🧠', cost: 140, desc: 'Venom slows enemies to 20% movement speed.' },
    ],
    railgun: [
      { id: 'penetrator', name: 'Penetrator',     icon: '⚫', cost: 200, desc: 'Shots ignore all armor.' },
      { id: 'charged',    name: 'Charged',        icon: '⚡', cost: 220, desc: '+80% damage · -30% fire rate.' },
      { id: 'emp',        name: 'EMP Slug',       icon: '📡', cost: 180, desc: 'Hit enemies are stunned for 1.5s.' },
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
  // Upgrade / ability panel state (my lane)
  let myUpgrades = new Set(), myAbilityOwned = new Set();
  let myAbilityCooldownMs = {}, myAbilityActiveMs = {};
  let myAutoSend = { enabled: false, packageIdx: 0, targeting: 'random' };
  let myWaveQueued = false;
  let upgradePanel = null; // will be set after DOM build

  let selectedShopTower = null;   // tower type to place
  let myReveals = false;          // true if local player has a sniper/laser/tracker tower
  let selectedTowerId = null;     // placed tower selected for panel
  let hoverCell = null;
  let prevHp = 20;
  let selMode = 'classic', selMap = 'serpent', selBot = false;

  // Interpolation buffers: per lane, Map(enemyId -> {fx,fy,tx,ty,at,h,sl,bn,t})
  const laneRender = {};
  const effects = [];             // {kind, ...,until}
  const damageNumbers = [];       // {x,y,val,until,color}
  const projectiles = [];         // {towerType,level,perks,x1,y1,x2,y2,startAt,endAt,evKind}
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
      case 'td-gold':        myGold = msg.gold; goldVal.textContent = myGold; refreshShopAffordability(); refreshUpgradePanel(); break;
      case 'td-send-meter':  mySendMeter = msg.meter; break;
      case 'td-action-error': flashStatus(msg.reason); break;
      case 'td-tower-placed':
      case 'td-tower-upgraded':
      case 'td-tower-sold':  break;
      case 'td-wave-start':  onWaveStart(msg); break;
      case 'td-wave-end':    onWaveEnd(msg); break;
      case 'td-enemies-sent': onEnemiesSent(msg); break;
      case 'td-player-eliminated': onEliminated(msg); break;
      case 'td-record-win':  reportScore('td', 1); break;
      case 'td-game-over':   onGameOver(msg); break;
      case 'td-skipped':     showToast(`⚡ Skipped! +${msg.bonus}g`); break;
      case 'td-ability-used': if (msg.label) showToast(msg.label); break;
      case 'td-autosend-cfg': myAutoSend = msg.autoSend; refreshAutoSendUI(); break;
    }
  }

  // ── Lobby UI ──
  function addPlayerCard(pid, name, isMe, isBot) {
    if (playerCards.has(pid)) return;
    const el = document.createElement('div');
    el.className = 'player-card' + (isMe ? ' is-me' : '') + (isBot ? ' is-bot' : '');
    const icon = isBot ? '🤖' : '';
    el.innerHTML = `<span class="pc-color">${icon}</span><div class="pc-body"><div class="pc-name">${escapeHtml(name)}${isMe ? ' (you)' : ''}</div><div class="pc-stats" data-stats></div></div>`;
    playerListEl.appendChild(el);
    playerCards.set(pid, { el, name, colorIdx: playerCards.size, isBot: !!isBot });
    paintCardColors();
  }
  function removePlayerCard(pid) { const c = playerCards.get(pid); if (c) { c.el.remove(); playerCards.delete(pid); } paintCardColors(); }
  function paintCardColors() { let i = 0; for (const [, c] of playerCards) { c.colorIdx = i; c.el.querySelector('.pc-color').style.background = COLORS[i % 4]; i++; } }
  function updatePlayerCount() { playerCountEl.textContent = playerCards.size; }
  function refreshLobbyControls() {
    if (matchActive) { controlsEl.style.display = 'none'; return; }
    controlsEl.style.display = 'flex';
    btnStart.style.display = amHost ? 'inline-flex' : 'none';
    if (botToggle) { botToggle.disabled = !amHost; botToggle.style.display = amHost ? '' : 'none'; if (botLabel) botLabel.style.display = amHost ? '' : 'none'; }
    // Enable start if 2+ humans OR solo+bot
    const canStart = playerCards.size >= 2 || (amHost && selBot);
    btnStart.disabled = !canStart;
    modeSelect.disabled = !amHost;
    mapSelect.disabled = !amHost;
    cfgRow.querySelector('.cfg-hint') && (cfgRow.querySelector('.cfg-hint').style.display = amHost ? 'none' : 'block');
    statusEl.textContent = amHost
      ? (canStart ? 'Choose mode & map, then Start Match' : 'Waiting for one more player (or enable bot)…')
      : 'Waiting for the host to start…';
  }

  // ── Mode / Map config ──
  function buildConfigSelectors() {
    if (modeSelect.options.length === 0) {
      for (const k of MODE_ORDER) { const o = document.createElement('option'); o.value = k; o.textContent = `${MODES[k].icon} ${MODES[k].name}`; modeSelect.appendChild(o); }
      for (const k of MAP_ORDER) { const o = document.createElement('option'); o.value = k; o.textContent = MAPS[k].name; mapSelect.appendChild(o); }
      modeSelect.addEventListener('change', onConfigChanged);
      mapSelect.addEventListener('change', onConfigChanged);
      if (botToggle) botToggle.addEventListener('change', () => { selBot = botToggle.checked; refreshLobbyControls(); });
    }
    modeSelect.value = selMode; mapSelect.value = selMap;
    if (botToggle) botToggle.checked = selBot;
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
    // Ensure bot player cards exist in the sidebar
    for (const p of playersInfo) {
      if (!playerCards.has(p.id)) addPlayerCard(p.id, p.name, p.id === myId, p.isBot);
    }
    buildShop();
    buildSendTicks();
    buildMinimaps();
    // colour sidebar cards by authoritative colorIdx
    for (const p of playersInfo) {
      const c = playerCards.get(p.id);
      if (c) {
        c.colorIdx = p.colorIdx;
        if (!p.isBot) c.el.querySelector('.pc-color').style.background = COLORS[p.colorIdx % 4];
      }
    }
    runCountdown(Math.round(msg.countdownMs / 1000));
    if (modeBadge) { modeBadge.textContent = `${msg.modeIcon || ''} ${msg.modeName || ''} · 🗺️ ${msg.mapName || ''}`; modeBadge.style.display = 'inline-flex'; }
    setTimeout(() => showToast(`${msg.modeIcon || ''} ${msg.modeName || 'Classic'}`), 200);
    statusEl.textContent = 'Build your defenses! First wave incoming…';
    // Reset and build upgrade / ability panel
    myUpgrades = new Set(); myAbilityOwned = new Set();
    myAbilityCooldownMs = {}; myAbilityActiveMs = {};
    myAutoSend = { enabled: false, packageIdx: 0, targeting: 'random' };
    myWaveQueued = false;
    projectiles.length = 0;
    buildUpgradePanel();
    buildAbilityBar();
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
    refreshSkipButton();
    if (msg.twist && msg.twist !== 'Calm Wave') sysChat('\u{1F3B2} ' + msg.twist);
  }
  function onWaveEnd(msg) {
    announce('Wave ' + msg.wave + ' cleared!');
    refreshSkipButton();
  }
  function announce(text) {
    waveAnnounce.textContent = text;
    waveAnnounce.style.display = 'block';
    waveAnnounce.style.animation = 'none'; void waveAnnounce.offsetWidth; waveAnnounce.style.animation = '';
    setTimeout(() => { waveAnnounce.style.display = 'none'; }, 1800);
  }

  function showToast(text) {
    const el = document.createElement('div');
    el.className = 'announce-toast';
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2200);
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
    // wave/phase/phaseRemainingMs are now per-lane; read from myId's lane
    const myLaneHdr = msg.lanes && msg.lanes[myId];
    if (myLaneHdr) {
      wave = myLaneHdr.wave ?? wave;
      phase = myLaneHdr.phase ?? phase;
      phaseRemainingMs = myLaneHdr.phaseRemainingMs ?? 0;
    }
    phaseStampAt = performance.now();
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
      // copy fl/cl into interpolation buffer
      for (const e of lane.enemies) {
        const cur = buf.get(e.i);
        if (cur) { cur.fl = e.fl; cur.cl = e.cl; }
      }
    }

    // My HUD
    const me = lanes[myId];
    if (me) {
      myGold = me.gold; goldVal.textContent = myGold;
      mySendMeter = me.sendMeter;
      if (me.baseHp !== myHp) { prevHp = myHp; myHp = me.baseHp; onHpChange(); }
      updateSendUI();
      refreshShopAffordability();
      // Sync upgrade / ability / autosend / skip state
      if (me.upgrades)          myUpgrades       = new Set(me.upgrades);
      if (me.abilityOwned)      myAbilityOwned   = new Set(me.abilityOwned);
      if (me.abilityCooldownMs) myAbilityCooldownMs = me.abilityCooldownMs;
      if (me.abilityActiveMs)   myAbilityActiveMs   = me.abilityActiveMs;
      if (me.autoSend)          myAutoSend          = me.autoSend;
      // Update myReveals: true if any tower has antiAir reveals flag
      myReveals = (me.towers || []).some(t => TOWER_DEFS[t.type] && TOWER_DEFS[t.type].reveals);
      refreshUpgradePanel();
      refreshAbilityPanel();
      refreshSkipButton();
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

  function getTowerAtGrid(gx, gy) {
    const me = lanes[myId];
    if (!me || !me.towers) return null;
    return me.towers.find(t => t.x === gx && t.y === gy);
  }

  // Flight durations per tower behavior (ms)
  const PROJ_FLIGHT = { single: 160, splash: 280, burn: 200, venom: 230, frost: 190, sniper: 75, missile: 310, laser: 55, railgun: 90 };

  function spawnProjectile(ev, evKind, x1, y1, x2, y2) {
    const tower = getTowerAtGrid(Math.round(x1), Math.round(y1));
    const towerType = tower ? tower.type : evKind; // fallback
    const level = tower ? tower.level : 1;
    const perks = tower ? (tower.perks || []) : [];
    const def = towerType && TOWER_DEFS[towerType] ? TOWER_DEFS[towerType] : null;
    const behavior = def ? def : null; // we just need towerType
    const flightKey = (def && def.desc && def.desc.includes('Pierces')) ? 'railgun'
                    : (def && def.desc && def.desc.includes('chain')) ? 'single'
                    : PROJ_FLIGHT[evKind] ? evKind : 'single';
    const dur = PROJ_FLIGHT[flightKey] || 160;
    const now = performance.now();
    projectiles.push({ towerType, level, perks, x1, y1, x2, y2, startAt: now, endAt: now + dur, evKind });
  }

  function handleEvent(ev) {
    if (ev.pid !== myId) return;
    const now = performance.now();
    if (ev.ev === 'hit' || ev.ev === 'snipe') {
      if (ev.tx !== undefined && ev.ex !== undefined) {
        spawnProjectile(ev, ev.ev === 'snipe' ? 'sniper' : 'single', ev.tx, ev.ty, ev.ex, ev.ey);
      }
      if (ev.dmg) damageNumbers.push({ x: ev.ex, y: ev.ey, val: ev.dmg, until: now + 700, color: '#fff' });
    } else if (ev.ev === 'splash') {
      if (ev.tx !== undefined) spawnProjectile(ev, 'splash', ev.tx, ev.ty, ev.x, ev.y);
      else effects.push({ kind: 'explosion', x: ev.x, y: ev.y, r: ev.r, until: now + 320 });
    } else if (ev.ev === 'chain') {
      effects.push({ kind: 'chain', pts: ev.pts, until: now + 160 });
    } else if (ev.ev === 'frost') {
      spawnProjectile(ev, 'frost', ev.tx, ev.ty, ev.tx, ev.ty + 0.01); // frost pulses from tower
      effects.push({ kind: 'frost', x: ev.tx, y: ev.ty, until: now + 220 });
    } else if (ev.ev === 'burn') {
      if (ev.tx !== undefined) spawnProjectile(ev, 'burn', ev.tx, ev.ty, ev.ex, ev.ey);
    } else if (ev.ev === 'venom') {
      if (ev.tx !== undefined) spawnProjectile(ev, 'venom', ev.tx, ev.ty, ev.ex, ev.ey);
    } else if (ev.ev === 'blink') {
      effects.push({ kind: 'blink', x: ev.ex, y: ev.ey, until: now + 350 });
    } else if (ev.ev === 'split') {
      effects.push({ kind: 'split', x: ev.ex, y: ev.ey, until: now + 400 });
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
      wrap.className = 'mini' + (p.isBot ? ' is-bot' : '');
      const dotHtml = p.isBot
        ? `<span class="dot bot-dot">🤖</span>`
        : `<span class="dot" style="background:${COLORS[p.colorIdx % 4]}"></span>`;
      wrap.innerHTML = `<div class="mini-head">${dotHtml}<span class="nm">${escapeHtml(p.name)}</span><span class="wv" data-wv></span></div>`;
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

    // projectiles (fly above enemies, below effects)
    drawProjectiles(now);

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
    const isSuper = t.level >= 4;
    const cx = (t.x + 0.5) * CELL, cy = (t.y + 0.5) * CELL;
    // Super glow ring
    if (isSuper) {
      ctx.save();
      ctx.shadowBlur = 14; ctx.shadowColor = '#fbbf24';
      ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 2.5;
      ctx.beginPath(); ctx.arc(cx, cy, CELL * 0.48, 0, 7); ctx.stroke();
      ctx.restore();
    }
    ctx.fillStyle = 'rgba(0,0,0,0.35)'; ctx.beginPath(); ctx.arc(cx, cy + 2, CELL * 0.42, 0, 7); ctx.fill();
    ctx.fillStyle = isSuper ? '#fef08a' : def.color; ctx.beginPath(); ctx.arc(cx, cy, CELL * 0.40, 0, 7); ctx.fill();
    ctx.fillStyle = '#0a0a1a'; ctx.beginPath(); ctx.arc(cx, cy, CELL * 0.30, 0, 7); ctx.fill();
    ctx.font = `${CELL * 0.42}px sans-serif`; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(def.icon, cx, cy + 1);
    // level pips (gold for super)
    const pipColor = isSuper ? '#f59e0b' : '#fbbf24';
    for (let i = 0; i < Math.min(t.level, 4); i++) { ctx.fillStyle = pipColor; ctx.beginPath(); ctx.arc(cx - CELL * 0.25 + i * 6, cy - CELL * 0.35, 2.2, 0, 7); ctx.fill(); }
    // perk markers (purple ring + count)
    const pk = (t.perks || []).length;
    if (pk) {
      ctx.strokeStyle = '#c084fc'; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc(cx, cy, CELL * 0.44, 0, 7); ctx.stroke();
      for (let i = 0; i < pk; i++) { ctx.fillStyle = '#c084fc'; ctx.beginPath(); ctx.arc(cx - CELL * 0.2 + i * 6, cy + CELL * 0.34, 2.4, 0, 7); ctx.fill(); }
    }
  }

  function drawEnemy(e, now) {
    const d = ENEMY_DEFS[e.t]; if (!d) return;
    // Cloaked enemies only render for the local player who has a reveal tower
    // (server still sends them; we just show them faintly so the cloaked player can see)
    const isCloaked = e.cl && !myReveals;
    if (isCloaked && !myReveals) {
      // Draw as very faint ghost so it's not invisible to the attacker
      // (the server only sends cloaked enemies to the lane owner)
    }
    const x = lerpX(e), y = lerpY(e);
    const cx = (x + 0.5) * CELL, cy = (y + 0.5) * CELL, r = d.r * CELL;
    ctx.save();
    if (e.cl) ctx.globalAlpha = 0.3;  // cloaked: semi-transparent
    // body
    ctx.fillStyle = d.color;
    ctx.beginPath();
    if (d.shape === 'circle') ctx.arc(cx, cy, r, 0, 7);
    else if (d.shape === 'square') ctx.rect(cx - r, cy - r, r * 2, r * 2);
    else if (d.shape === 'tri') { ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy + r); ctx.lineTo(cx - r, cy + r); ctx.closePath(); }
    else if (d.shape === 'diamond') { ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy); ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy); ctx.closePath(); }
    else if (d.shape === 'hex') { for (let i = 0; i < 6; i++) { const a = Math.PI / 3 * i - Math.PI / 6; const px = cx + r * Math.cos(a), py = cy + r * Math.sin(a); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); } ctx.closePath(); }
    else if (d.shape === 'star') {
      // 4-point star (splitter)
      for (let i = 0; i < 8; i++) { const a = Math.PI / 4 * i - Math.PI / 2; const rad = (i % 2 === 0) ? r : r * 0.45; const px = cx + rad * Math.cos(a), py = cy + rad * Math.sin(a); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }
      ctx.closePath();
    }
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.4)'; ctx.lineWidth = 1.5; ctx.stroke();
    // Flying halo
    if (e.fl) { ctx.strokeStyle = '#67e8f9'; ctx.lineWidth = 1.5; ctx.setLineDash([3,3]); ctx.beginPath(); ctx.arc(cx, cy - r * 0.15, r * 1.35, 0, 7); ctx.stroke(); ctx.setLineDash([]); }
    // status tints
    if (e.fz) { ctx.fillStyle = 'rgba(125,211,252,0.55)'; ctx.beginPath(); ctx.arc(cx, cy, r + 3, 0, 7); ctx.fill(); ctx.strokeStyle = '#e0f2fe'; ctx.lineWidth = 1.5; ctx.stroke(); }
    else if (e.sl) { ctx.fillStyle = 'rgba(56,189,248,0.35)'; ctx.beginPath(); ctx.arc(cx, cy, r + 2, 0, 7); ctx.fill(); }
    if (e.bn) { ctx.fillStyle = 'rgba(239,68,68,0.3)'; ctx.beginPath(); ctx.arc(cx, cy - r, 2.5, 0, 7); ctx.fill(); }
    ctx.restore();
    // hp bar (always opaque)
    const bw = r * 2;
    ctx.fillStyle = 'rgba(0,0,0,0.6)'; ctx.fillRect(cx - bw / 2, cy - r - 7, bw, 4);
    ctx.fillStyle = e.h > 0.5 ? '#22c55e' : e.h > 0.25 ? '#f59e0b' : '#ef4444';
    ctx.fillRect(cx - bw / 2, cy - r - 7, bw * e.h, 4);
  }

  // ── Projectile colours per level ────────────────────────────────────────────
  // [lvl1, lvl2, lvl3, superLvl4]
  const PROJ_COLORS = {
    arrow:   ['#86efac','#fde047','#f97316','#fbbf24'],
    cannon:  ['#94a3b8','#6b7280','#dc2626','#1e1b18'],
    frost:   ['#bae6fd','#7dd3fc','#38bdf8','#e0f2fe'],
    tesla:   ['#c4b5fd','#a78bfa','#7c3aed','#e9d5ff'],
    inferno: ['#fb923c','#ef4444','#991b1b','#fbbf24'],
    sniper:  ['#e2e8f0','#cbd5e1','#fbbf24','#fef3c7'],
    missile: ['#fbbf24','#f97316','#ef4444','#dc2626'],
    laser:   ['#fca5a5','#f87171','#ef4444','#ff00ff'],
    venom:   ['#86efac','#4ade80','#16a34a','#15803d'],
    railgun: ['#67e8f9','#22d3ee','#06b6d4','#f0f9ff'],
  };

  function projColor(towerType, level) {
    const arr = PROJ_COLORS[towerType] || ['#ffffff','#ffffff','#ffffff','#fbbf24'];
    return arr[Math.min(level - 1, arr.length - 1)];
  }

  function drawProjectiles(now) {
    for (let i = projectiles.length - 1; i >= 0; i--) {
      const p = projectiles[i];
      if (now >= p.endAt) {
        // Spawn landing effect when projectile arrives
        const ex = p.x2, ey = p.y2;
        if (p.evKind === 'splash') effects.push({ kind: 'explosion', x: ex, y: ey, r: 1.3, until: now + 320 });
        else if (p.evKind === 'burn') effects.push({ kind: 'burn', x: ex, y: ey, until: now + 260 });
        else if (p.evKind === 'venom') effects.push({ kind: 'venom', x: ex, y: ey, until: now + 280 });
        else effects.push({ kind: 'spark', x: ex, y: ey, until: now + 180 });
        projectiles.splice(i, 1);
        continue;
      }
      const t = (now - p.startAt) / (p.endAt - p.startAt); // 0→1
      const sx = (p.x1 + 0.5) * CELL, sy = (p.y1 + 0.5) * CELL;
      const ex2 = (p.x2 + 0.5) * CELL, ey2 = (p.y2 + 0.5) * CELL;
      const cx = sx + (ex2 - sx) * t, cy = sy + (ey2 - sy) * t;
      const angle = Math.atan2(ey2 - sy, ex2 - sx);
      const col = projColor(p.towerType, p.level);
      const isSuper = p.level >= 4;
      const sz = CELL * (0.11 + p.level * 0.04); // base size scales with level

      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(angle);

      switch (p.towerType) {
        // ── Arrow / Ballista ──────────────────────────────────────────────────
        case 'arrow': {
          const len = CELL * (0.28 + p.level * 0.07);
          const w = CELL * (0.055 + p.level * 0.01);
          if (isSuper) ctx.shadowBlur = 8, ctx.shadowColor = '#fbbf24';
          ctx.strokeStyle = col; ctx.lineWidth = w * 1.4;
          ctx.beginPath(); ctx.moveTo(-len * 0.5, 0); ctx.lineTo(len * 0.6, 0); ctx.stroke();
          // arrowhead
          ctx.fillStyle = col;
          ctx.beginPath(); ctx.moveTo(len * 0.6, 0); ctx.lineTo(len * 0.1, -w * 2); ctx.lineTo(len * 0.1, w * 2); ctx.closePath(); ctx.fill();
          // fletching
          ctx.strokeStyle = isSuper ? '#fef9c3' : '#fff'; ctx.lineWidth = 1;
          ctx.beginPath(); ctx.moveTo(-len * 0.4, 0); ctx.lineTo(-len * 0.6, -w * 2.5); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(-len * 0.4, 0); ctx.lineTo(-len * 0.6, w * 2.5); ctx.stroke();
          if (isSuper) {
            // second fletching pair for Ballista
            ctx.beginPath(); ctx.moveTo(-len * 0.25, 0); ctx.lineTo(-len * 0.45, -w * 2.5); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(-len * 0.25, 0); ctx.lineTo(-len * 0.45, w * 2.5); ctx.stroke();
          }
          break;
        }
        // ── Cannon / Siege Engine ─────────────────────────────────────────────
        case 'cannon': {
          const r = sz * (isSuper ? 2.2 : 1.4);
          if (isSuper) { ctx.shadowBlur = 12; ctx.shadowColor = '#ef4444'; }
          // smoke trail
          const trailLen = r * 3;
          const grad = ctx.createLinearGradient(-trailLen, 0, 0, 0);
          grad.addColorStop(0, 'rgba(0,0,0,0)');
          grad.addColorStop(1, col + '88');
          ctx.fillStyle = grad; ctx.beginPath();
          ctx.ellipse(-trailLen * 0.5, 0, trailLen * 0.5, r * 0.4, 0, 0, 7); ctx.fill();
          // ball
          const bGrad = ctx.createRadialGradient(-r * 0.3, -r * 0.3, r * 0.05, 0, 0, r);
          bGrad.addColorStop(0, isSuper ? '#6b7280' : '#d1d5db');
          bGrad.addColorStop(1, col);
          ctx.fillStyle = bGrad; ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
          ctx.strokeStyle = 'rgba(0,0,0,0.5)'; ctx.lineWidth = 1; ctx.stroke();
          if (isSuper) {
            // lava cracks
            ctx.strokeStyle = '#fbbf24'; ctx.lineWidth = 0.8;
            for (let k = 0; k < 4; k++) {
              const ka = k / 4 * Math.PI * 2;
              ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(ka) * r * 0.8, Math.sin(ka) * r * 0.8); ctx.stroke();
            }
          }
          break;
        }
        // ── Frost / Blizzard ──────────────────────────────────────────────────
        case 'frost': {
          const spikes = isSuper ? 8 : 6;
          const r1 = sz * (isSuper ? 2.0 : 1.3), r2 = r1 * 0.45;
          if (isSuper) { ctx.shadowBlur = 10; ctx.shadowColor = '#bae6fd'; }
          ctx.strokeStyle = col; ctx.lineWidth = isSuper ? 2 : 1.5;
          for (let k = 0; k < spikes; k++) {
            const a = k / spikes * Math.PI * 2;
            ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(Math.cos(a) * r1, Math.sin(a) * r1); ctx.stroke();
            // side branches
            const bx = Math.cos(a) * r1 * 0.55, by = Math.sin(a) * r1 * 0.55;
            ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(a + 1.1) * r2, by + Math.sin(a + 1.1) * r2); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + Math.cos(a - 1.1) * r2, by + Math.sin(a - 1.1) * r2); ctx.stroke();
          }
          ctx.fillStyle = col + 'cc'; ctx.beginPath(); ctx.arc(0, 0, sz * 0.6, 0, 7); ctx.fill();
          break;
        }
        // ── Tesla / Storm Spire ───────────────────────────────────────────────
        case 'tesla': {
          const len = CELL * (0.3 + p.level * 0.06);
          if (isSuper) { ctx.shadowBlur = 14; ctx.shadowColor = '#a78bfa'; }
          ctx.strokeStyle = col; ctx.lineWidth = isSuper ? 3 : 1.8;
          // main zigzag bolt
          ctx.beginPath();
          const segs = isSuper ? 8 : 5;
          ctx.moveTo(-len * 0.5, 0);
          for (let k = 1; k <= segs; k++) {
            const bx = -len * 0.5 + len * (k / segs);
            const by = (k % 2 === 0 ? 1 : -1) * CELL * 0.1 * (isSuper ? 1.5 : 1);
            ctx.lineTo(bx, by);
          }
          ctx.stroke();
          // secondary bolt (super only)
          if (isSuper) {
            ctx.strokeStyle = '#e9d5ff'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(-len * 0.4, 0);
            for (let k = 1; k <= 4; k++) {
              const bx = -len * 0.4 + len * 0.8 * (k / 4);
              const by = (k % 2 === 0 ? -1 : 1) * CELL * 0.13;
              ctx.lineTo(bx, by);
            }
            ctx.stroke();
          }
          break;
        }
        // ── Inferno / Volcano ─────────────────────────────────────────────────
        case 'inferno': {
          const r = sz * (isSuper ? 2.5 : 1.6);
          if (isSuper) { ctx.shadowBlur = 16; ctx.shadowColor = '#fbbf24'; }
          // fire trail
          const trailLen = r * 4;
          const fGrad = ctx.createLinearGradient(-trailLen, 0, 0, 0);
          fGrad.addColorStop(0, 'rgba(0,0,0,0)');
          fGrad.addColorStop(0.6, isSuper ? 'rgba(251,191,36,0.3)' : 'rgba(239,68,68,0.3)');
          fGrad.addColorStop(1, col + 'aa');
          ctx.fillStyle = fGrad;
          ctx.beginPath(); ctx.ellipse(-trailLen * 0.5, 0, trailLen * 0.5, r * 0.35, 0, 0, 7); ctx.fill();
          // fireball core
          const fbGrad = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
          fbGrad.addColorStop(0, isSuper ? '#fef08a' : '#fde047');
          fbGrad.addColorStop(0.5, col);
          fbGrad.addColorStop(1, isSuper ? '#7f1d1d' : '#991b1b');
          ctx.fillStyle = fbGrad; ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
          // lick spikes
          const spikes = isSuper ? 6 : 4;
          ctx.fillStyle = isSuper ? '#fef08a' : '#fde04788';
          for (let k = 0; k < spikes; k++) {
            const a = (k / spikes) * Math.PI * 2 - 0.4;
            ctx.beginPath(); ctx.moveTo(Math.cos(a) * r * 0.7, Math.sin(a) * r * 0.7);
            ctx.lineTo(Math.cos(a - 0.3) * r * 1.4, Math.sin(a - 0.3) * r * 1.4);
            ctx.lineTo(Math.cos(a + 0.3) * r * 1.4, Math.sin(a + 0.3) * r * 1.4);
            ctx.closePath(); ctx.fill();
          }
          break;
        }
        // ── Sniper / War Cannon ───────────────────────────────────────────────
        case 'sniper': {
          const len = CELL * (0.35 + p.level * 0.06);
          const w = CELL * (0.04 + (p.level - 1) * 0.015);
          if (isSuper) { ctx.shadowBlur = 10; ctx.shadowColor = col; }
          // tracer streak
          const sGrad = ctx.createLinearGradient(-len, 0, len * 0.3, 0);
          sGrad.addColorStop(0, 'rgba(255,255,255,0)');
          sGrad.addColorStop(0.6, col + 'aa');
          sGrad.addColorStop(1, '#ffffff');
          ctx.strokeStyle = sGrad; ctx.lineWidth = w * 2;
          ctx.beginPath(); ctx.moveTo(-len, 0); ctx.lineTo(len * 0.3, 0); ctx.stroke();
          // bullet tip
          ctx.fillStyle = '#ffffff';
          ctx.beginPath(); ctx.ellipse(len * 0.3, 0, w * 3, w * 1.2, 0, 0, 7); ctx.fill();
          if (isSuper) {
            // energy halo
            ctx.strokeStyle = col + 'aa'; ctx.lineWidth = 1.5;
            ctx.beginPath(); ctx.ellipse(0, 0, len * 0.6, w * 4, 0, 0, 7); ctx.stroke();
          }
          break;
        }
        // ── Missile / MLRS ────────────────────────────────────────────────────
        case 'missile': {
          const blen = CELL * (0.32 + p.level * 0.07);
          const bw = CELL * (0.07 + p.level * 0.02);
          if (isSuper) { ctx.shadowBlur = 12; ctx.shadowColor = '#ef4444'; }
          // flame exhaust
          const flen = blen * (isSuper ? 2.5 : 1.8);
          const fGrad2 = ctx.createLinearGradient(-flen, 0, -blen * 0.4, 0);
          fGrad2.addColorStop(0, 'rgba(0,0,0,0)');
          fGrad2.addColorStop(0.5, isSuper ? 'rgba(239,68,68,0.5)' : 'rgba(249,115,22,0.5)');
          fGrad2.addColorStop(1, '#fde04799');
          ctx.fillStyle = fGrad2;
          ctx.beginPath(); ctx.ellipse(-(flen + blen * 0.4) * 0.5, 0, flen * 0.5, bw * (isSuper ? 1.4 : 1), 0, 0, 7); ctx.fill();
          // rocket body
          const rGrad = ctx.createLinearGradient(0, -bw, 0, bw);
          rGrad.addColorStop(0, '#e2e8f0'); rGrad.addColorStop(1, '#64748b');
          ctx.fillStyle = rGrad;
          ctx.beginPath(); ctx.roundRect(-blen * 0.45, -bw, blen * 0.7, bw * 2, bw * 0.3); ctx.fill();
          ctx.strokeStyle = '#1e293b'; ctx.lineWidth = 0.8; ctx.stroke();
          // nose cone
          ctx.fillStyle = col;
          ctx.beginPath(); ctx.moveTo(blen * 0.25, -bw); ctx.lineTo(blen * 0.25, bw); ctx.lineTo(blen * 0.7, 0); ctx.closePath(); ctx.fill();
          // fins
          ctx.fillStyle = col + 'cc';
          ctx.beginPath(); ctx.moveTo(-blen * 0.35, -bw); ctx.lineTo(-blen * 0.55, -bw * 2.5); ctx.lineTo(-blen * 0.15, -bw); ctx.closePath(); ctx.fill();
          ctx.beginPath(); ctx.moveTo(-blen * 0.35, bw);  ctx.lineTo(-blen * 0.55, bw * 2.5);  ctx.lineTo(-blen * 0.15, bw);  ctx.closePath(); ctx.fill();
          if (isSuper) {
            // extra side rockets
            ctx.fillStyle = '#f97316cc';
            ctx.beginPath(); ctx.roundRect(-blen * 0.3, -bw * 2.8, blen * 0.5, bw * 1.0, 2); ctx.fill();
            ctx.beginPath(); ctx.roundRect(-blen * 0.3, bw * 1.8,  blen * 0.5, bw * 1.0, 2); ctx.fill();
          }
          break;
        }
        // ── Laser / Photon Cannon ─────────────────────────────────────────────
        case 'laser': {
          // laser: render as a fast bright beam (full path, fades with age)
          ctx.rotate(-angle); // undo rotation so we can draw in screen coords
          const totalLen = Math.hypot(ex2 - sx, ey2 - sy);
          const drawn = totalLen * Math.min(t * 3, 1); // beam extends quickly
          const beamAngle = Math.atan2(ey2 - sy, ex2 - sx);
          const lGrad = ctx.createLinearGradient(0, 0, Math.cos(beamAngle) * drawn, Math.sin(beamAngle) * drawn);
          lGrad.addColorStop(0, isSuper ? '#ff00ffcc' : '#f87171cc');
          lGrad.addColorStop(0.5, '#ffffff');
          lGrad.addColorStop(1, isSuper ? '#ff00ffcc' : '#f87171cc');
          ctx.strokeStyle = lGrad;
          ctx.lineWidth = isSuper ? 4 : (1 + p.level);
          if (isSuper) { ctx.shadowBlur = 16; ctx.shadowColor = '#ff00ff'; }
          ctx.beginPath();
          ctx.moveTo(0, 0);
          ctx.lineTo(Math.cos(beamAngle) * drawn, Math.sin(beamAngle) * drawn);
          ctx.stroke();
          break;
        }
        // ── Venom / Plague Spire ─────────────────────────────────────────────
        case 'venom': {
          const r = sz * (isSuper ? 2.2 : 1.5);
          if (isSuper) { ctx.shadowBlur = 10; ctx.shadowColor = '#86efac'; }
          // drip trail
          const trailLen = r * 3.5;
          const vGrad = ctx.createLinearGradient(-trailLen, 0, 0, 0);
          vGrad.addColorStop(0, 'rgba(0,0,0,0)');
          vGrad.addColorStop(1, col + '66');
          ctx.fillStyle = vGrad;
          ctx.beginPath(); ctx.ellipse(-trailLen * 0.5, 0, trailLen * 0.5, r * 0.3, 0, 0, 7); ctx.fill();
          // main orb
          const oGrad = ctx.createRadialGradient(-r * 0.25, -r * 0.25, r * 0.05, 0, 0, r);
          oGrad.addColorStop(0, isSuper ? '#bbf7d0' : '#d1fae5');
          oGrad.addColorStop(0.6, col);
          oGrad.addColorStop(1, '#14532d');
          ctx.fillStyle = oGrad; ctx.beginPath(); ctx.arc(0, 0, r, 0, 7); ctx.fill();
          ctx.strokeStyle = '#166534'; ctx.lineWidth = 1; ctx.stroke();
          if (isSuper) {
            // skull cross
            ctx.strokeStyle = '#15803d'; ctx.lineWidth = 1.2;
            ctx.beginPath(); ctx.moveTo(-r * 0.5, 0); ctx.lineTo(r * 0.5, 0); ctx.stroke();
            ctx.beginPath(); ctx.moveTo(0, -r * 0.5); ctx.lineTo(0, r * 0.5); ctx.stroke();
          }
          break;
        }
        // ── Railgun / Mass Driver ─────────────────────────────────────────────
        case 'railgun': {
          const len = CELL * (0.4 + p.level * 0.06);
          const w = CELL * 0.05;
          if (isSuper) { ctx.shadowBlur = 18; ctx.shadowColor = '#06b6d4'; }
          // glow streak
          const rGrad2 = ctx.createLinearGradient(-len * 0.6, 0, len * 0.5, 0);
          rGrad2.addColorStop(0, 'rgba(0,0,0,0)');
          rGrad2.addColorStop(0.4, col + '55');
          rGrad2.addColorStop(1, '#ffffff');
          ctx.strokeStyle = rGrad2; ctx.lineWidth = w * (isSuper ? 5 : 3);
          ctx.beginPath(); ctx.moveTo(-len * 0.6, 0); ctx.lineTo(len * 0.5, 0); ctx.stroke();
          // core slug
          ctx.fillStyle = '#ffffff';
          ctx.beginPath(); ctx.ellipse(0, 0, len * 0.3, w * (isSuper ? 2.5 : 1.8), 0, 0, 7); ctx.fill();
          // cyan energy rings (super)
          if (isSuper) {
            ctx.strokeStyle = col; ctx.lineWidth = 1.5;
            for (let k = 0; k < 3; k++) {
              ctx.beginPath(); ctx.arc(-len * 0.1 + k * w * 3, 0, w * 2 + k * 1, 0, 7); ctx.stroke();
            }
          }
          break;
        }
        default: {
          // fallback: simple dot
          ctx.fillStyle = col; ctx.beginPath(); ctx.arc(0, 0, sz, 0, 7); ctx.fill();
          break;
        }
      }
      ctx.restore();
    }
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
      else if (f.kind === 'venom') { ctx.fillStyle = `rgba(132,204,22,${life / 280})`; ctx.font = `${CELL * 0.45}px sans-serif`; ctx.textAlign = 'center'; ctx.fillText('☣', (f.x + 0.5) * CELL, (f.y + 0.5) * CELL); }
      else if (f.kind === 'blink') { const p = 1 - life / 350; ctx.strokeStyle = `rgba(163,230,53,${1 - p})`; ctx.lineWidth = 2; ctx.beginPath(); ctx.arc((f.x + 0.5) * CELL, (f.y + 0.5) * CELL, CELL * (0.5 + p * 0.8), 0, 7); ctx.stroke(); }
      else if (f.kind === 'split') { const p = 1 - life / 400; for (let k = 0; k < 3; k++) { const a = k / 3 * Math.PI * 2; ctx.fillStyle = `rgba(249,115,22,${1 - p})`; ctx.beginPath(); ctx.arc((f.x + 0.5) * CELL + Math.cos(a) * p * CELL * 0.8, (f.y + 0.5) * CELL + Math.sin(a) * p * CELL * 0.8, 4, 0, 7); ctx.fill(); } }
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

  // ── Upgrade / Ability / AutoSend / Skip UI ──────────────────────────────────

  function buildUpgradePanel() {
    const p = document.getElementById('upgradePanel');
    if (!p) return;
    if (p.dataset.built) return;
    p.dataset.built = '1';

    // Header with close button
    const hdr = document.createElement('div');
    hdr.className = 'up-header';
    hdr.innerHTML = '<span class="up-title">\u2699 Lane Upgrades</span>';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'up-close'; closeBtn.textContent = '\u00d7'; closeBtn.title = 'Close';
    closeBtn.addEventListener('click', () => { p.style.display = 'none'; });
    hdr.appendChild(closeBtn);
    p.appendChild(hdr);

    // Lane upgrades grid
    const secU = document.createElement('div');
    secU.className = 'up-section';
    const gridU = document.createElement('div'); gridU.className = 'up-grid'; gridU.id = 'upgGrid'; secU.appendChild(gridU);
    for (const id of LANE_UPGRADE_ORDER) {
      const u = LANE_UPGRADES[id];
      const btn = document.createElement('button');
      btn.className = 'upg-btn'; btn.dataset.upgId = id; btn.id = 'upg_' + id;
      btn.innerHTML = `<span class="upg-icon">${u.icon}</span><span class="upg-name">${u.name}</span><span class="upg-cost">\uD83D\uDCB0${u.cost}</span><span class="upg-desc">${u.desc}</span>`;
      btn.title = u.desc;
      btn.addEventListener('click', () => { if (ws) ws.send(JSON.stringify({ type: 'td-buy-upgrade', upgradeId: id })); });
      gridU.appendChild(btn);
    }
    p.appendChild(secU);

    // Auto-send config
    const secAS = document.createElement('div');
    secAS.className = 'up-section';
    secAS.id = 'autoSendSec';
    const hAS = document.createElement('h4'); hAS.textContent = '\uD83E\uDD16 Auto-Send'; secAS.appendChild(hAS);
    secAS.innerHTML += `
      <label class="as-row"><input type="checkbox" id="asEnabled"> Enable Auto-Send</label>
      <div class="as-row"><label>Max Package:</label>
        <select id="asPkgSel">${Array.from({length: 6},(_,i)=>i).map(i=>`<option value="${i}">Pkg ${i+1}</option>`).join('')}</select>
      </div>
      <div class="as-row"><label>Target:</label>
        <select id="asTarget">
          <option value="random">Random</option>
          <option value="lowest_hp">Lowest HP</option>
          <option value="highest_hp">Highest HP</option>
        </select>
      </div>`;
    p.appendChild(secAS);

    const asEn = document.getElementById('asEnabled');
    const asPkg = document.getElementById('asPkgSel');
    const asTgt = document.getElementById('asTarget');
    if (asEn) asEn.addEventListener('change', sendAutoSendCfg);
    if (asPkg) asPkg.addEventListener('change', sendAutoSendCfg);
    if (asTgt) asTgt.addEventListener('change', sendAutoSendCfg);

    upgradePanel = p;
  }

  function buildAbilityBar() {
    const bar = document.getElementById('abilityBar');
    if (!bar || bar.dataset.built) return;
    bar.dataset.built = '1';
    bar.innerHTML = '<span class="abi-bar-label">\u26A1 Abilities</span>';
    for (const id of ABILITY_ORDER) {
      const a = ABILITIES[id];
      const btn = document.createElement('button');
      btn.className = 'abi-bar-btn'; btn.id = 'abi_' + id; btn.title = a.desc;
      btn.innerHTML = `<span class="abi-bar-icon">${a.icon}</span><span class="abi-bar-name">${a.name}</span><span class="abi-bar-cost" id="abicost_${id}">\uD83D\uDCB0${a.cost}</span><div class="abi-cd-overlay" id="abicd_${id}"></div>`;
      btn.addEventListener('click', () => handleAbilityClick(id));
      bar.appendChild(btn);
    }
    bar.style.display = '';
  }

  function sendAutoSendCfg() {
    const en  = document.getElementById('asEnabled')?.checked ?? false;
    const pkg = parseInt(document.getElementById('asPkgSel')?.value ?? '0');
    const tgt = document.getElementById('asTarget')?.value ?? 'random';
    if (ws) ws.send(JSON.stringify({ type: 'td-config-autosend', enabled: en, packageIdx: pkg, targeting: tgt }));
  }

  function handleAbilityClick(id) {
    if (!myAbilityOwned.has(id)) {
      // buy
      if (ws) ws.send(JSON.stringify({ type: 'td-buy-ability', abilityId: id }));
    } else {
      // use
      if (ws) ws.send(JSON.stringify({ type: 'td-use-ability', abilityId: id }));
    }
  }

  function refreshUpgradePanel() {
    for (const id of LANE_UPGRADE_ORDER) {
      const btn = document.getElementById('upg_' + id);
      if (!btn) continue;
      const owned = myUpgrades.has(id);
      btn.classList.toggle('owned', owned);
      btn.disabled = owned || myGold < LANE_UPGRADES[id].cost;
    }
  }

  function refreshAbilityPanel() {
    for (const id of ABILITY_ORDER) {
      const btn = document.getElementById('abi_' + id);
      if (!btn) continue;
      const owned = myAbilityOwned.has(id);
      const cdLeft = myAbilityCooldownMs[id] || 0;
      const activeLeft = myAbilityActiveMs[id] || 0;
      btn.classList.toggle('owned', owned);
      btn.classList.toggle('on-cooldown', owned && cdLeft > 0);
      btn.classList.toggle('ability-active', owned && activeLeft > 0);
      btn.disabled = !owned ? myGold < ABILITIES[id].cost : cdLeft > 0;
      const overlay = document.getElementById('abicd_' + id);
      if (overlay) overlay.textContent = owned && cdLeft > 0 ? `${Math.ceil(cdLeft/1000)}s` : (owned && activeLeft > 0 ? `${Math.ceil(activeLeft/1000)}s` : '');
      const costEl = document.getElementById('abicost_' + id);
      if (costEl) costEl.style.display = owned ? 'none' : '';
    }
  }

  function refreshAutoSendUI() {
    const asEn  = document.getElementById('asEnabled');
    const asPkg = document.getElementById('asPkgSel');
    const asTgt = document.getElementById('asTarget');
    if (asEn  && asEn.checked  !== myAutoSend.enabled)     asEn.checked  = myAutoSend.enabled;
    if (asPkg && parseInt(asPkg.value) !== myAutoSend.packageIdx) asPkg.value = myAutoSend.packageIdx;
    if (asTgt && asTgt.value   !== myAutoSend.targeting)   asTgt.value   = myAutoSend.targeting;
  }

  function refreshSkipButton() {
    const btn = document.getElementById('btnSkip');
    if (!btn) return;
    btn.style.display = phase === 'prep' ? '' : 'none';
    btn.disabled = false;
    btn.textContent = '⚡ Skip Wait';
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
    const maxLevel = def.levels.length; // 4 with super
    const isSuper = t.level >= maxLevel;
    const lvl = def.levels[t.level - 1];
    const next = def.levels[t.level]; // may be undefined at max
    const displayName = isSuper ? `⭐ ${def.superName || def.name}` : def.name;
    const refund = Math.floor(t.invested * 0.6);
    const owned = t.perks || [];
    let statsHtml = `<div>Damage: ${lvl.damage || (lvl.burn ? lvl.burn + '/s burn' : lvl.venom ? lvl.venom + '/s venom' : lvl.slow ? (lvl.slow * 100) + '% slow' : '—')}</div>`;
    statsHtml += `<div>Range: ${lvl.range.toFixed(1)} · Rate: ${(1000 / lvl.fireMs).toFixed(2)}/s</div>`;
    statsHtml += `<div>Type: ${def.dmgClass}</div>`;
    if (next) {
      const dmgFrom = lvl.damage || lvl.burn || lvl.venom || (lvl.slow ? lvl.slow * 100 : 0);
      const dmgTo   = next.damage || next.burn || next.venom || (next.slow ? next.slow * 100 : 0);
      const upgradeLabel = t.level === maxLevel - 1 ? `★ SUPER (${def.superName || 'Max'})` : `Lv ${t.level + 1}`;
      statsHtml += `<div class="up">⬆ ${upgradeLabel}: dmg ${dmgFrom}→${dmgTo}, range ${lvl.range.toFixed(1)}→${next.range.toFixed(1)}</div>`;
    }
    let actions = '';
    if (next) actions += `<button class="btn btn-sm btn-upgrade" id="tpUpgrade">⬆ ${next.cost}g${t.level === maxLevel - 1 ? ' ★' : ''}</button>`;
    else actions += `<button class="btn btn-sm" disabled>⭐ SUPER</button>`;
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
    const lvlLabel = isSuper ? `<span class="tp-lvl super">⭐ SUPER</span>` : `<span class="tp-lvl">Lv ${t.level}/${maxLevel}</span>`;
    towerPanel.innerHTML = `<div class="tp-head">${def.icon} ${displayName}${lvlLabel}</div><div class="tp-stats">${statsHtml}</div><div class="tp-actions">${actions}<button class="btn btn-sm btn-close-tp" id="tpClose">✕</button></div>${perkHtml}`;
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
  btnStart.addEventListener('click', () => wsSend({ type: 'td-start', mode: selMode, map: selMap, bot: selBot }));
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

  // Upgrade panel toggle + click-outside-to-close
  const _btnUpgrade = $('btnUpgrade');
  if (_btnUpgrade) {
    _btnUpgrade.addEventListener('click', (e) => {
      e.stopPropagation();
      const p = $('upgradePanel');
      if (!p) return;
      const isOpen = p.style.display !== 'none' && p.style.display !== '';
      p.style.display = isOpen ? 'none' : '';
    });
  }
  // Close upgrade panel when clicking anywhere outside it
  document.addEventListener('mousedown', (e) => {
    const p = $('upgradePanel');
    if (!p || p.style.display === 'none') return;
    if (!p.contains(e.target) && e.target !== _btnUpgrade) {
      p.style.display = 'none';
    }
  });
  // Skip button
  const _btnSkip = $('btnSkip');
  if (_btnSkip) {
    _btnSkip.addEventListener('click', () => { if (ws) ws.send(JSON.stringify({ type: 'td-skip-prep' })); });
  }

  document.addEventListener('keydown', e => {
    if (document.activeElement === chatInput) return;
    if (e.key === 'Escape') { selectedShopTower = null; selectedTowerId = null; towerPanel.style.display = 'none'; targetPicker.style.display = 'none'; refreshShopSelection(); const p=$('upgradePanel'); if(p) p.style.display='none'; }
    const idx = parseInt(e.key); // 1-6 quick select towers
    if (idx >= 1 && idx <= 6) { selectedShopTower = TOWER_ORDER[idx - 1]; selectedTowerId = null; towerPanel.style.display = 'none'; refreshShopSelection(); }
    if (e.key === ' ' && !btnSend.disabled) { e.preventDefault(); doSend(); }
  });

  connect();
})();

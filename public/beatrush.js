(() => {
'use strict';

const params = new URLSearchParams(location.search);
const roomId = params.get('room');
const myName = sessionStorage.getItem('arena-name') || 'Player';
if (!roomId) { location.href = '/'; return; }

const $ = id => document.getElementById(id);
const statusEl = $('status');
const playerListEl = $('playerList');
const playerCountEl = $('playerCount');
const roomBadge = $('roomBadge');
const btnBack = $('btnBack');

roomBadge.textContent = 'Room ' + roomId;
btnBack.addEventListener('click', () => { location.href = '/'; });

// ── Room / WS state ──────────────────────────────────────────────────
let ws = null, myId = null, leaderId = null;
const players = new Map();
let gamePhase = 'hub'; // hub | countdown | playing | results
function isHost() { return leaderId === myId; }

function renderPlayerList() {
  playerListEl.innerHTML = '';
  playerCountEl.textContent = players.size;
  for (const [pid, p] of players) {
    const el = document.createElement('div');
    el.className = 'player-item' + (pid === myId ? ' is-me' : '');
    el.textContent = p.name + (pid === leaderId ? ' \u{1F451}' : '');
    playerListEl.appendChild(el);
  }
}

function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => {
    const pw = sessionStorage.getItem('arena-room-password') || undefined;
    sessionStorage.removeItem('arena-room-password');
    wsSend({ type: 'join-room', roomId, name: myName, password: pw, token: sessionStorage.getItem('arena-token') || '' });
  };
  ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
  ws.onclose = () => { statusEl.textContent = 'Disconnected. Returning to lobby\u2026'; setTimeout(() => { location.href = '/'; }, 3000); };
}

function updateHostUI() {
  $('btnAnalyze').style.display = isHost() ? '' : 'none';
  $('hostOnlyHint').style.display = isHost() ? 'none' : '';
  const diffSelect = $('diffSelect');
  diffSelect.querySelectorAll('.br-diff-card').forEach(c => { c.style.pointerEvents = isHost() ? '' : 'none'; c.style.opacity = isHost() ? '1' : '.6'; });
}

function handleMsg(msg) {
  switch (msg.type) {
    case 'room-joined':
      myId = msg.myId; leaderId = msg.leaderId;
      players.set(myId, { name: myName });
      for (const p of msg.players) players.set(p.id, { name: p.name });
      renderPlayerList(); updateHostUI();
      statusEl.textContent = `Room ${roomId} \u00b7 ${players.size} player(s)`;
      updateReadyHint();
      break;
    case 'player-joined':
      players.set(msg.id, { name: msg.name });
      leaderId = msg.leaderId;
      renderPlayerList(); updateHostUI();
      statusEl.textContent = `${msg.name} joined.`;
      updateReadyHint();
      break;
    case 'player-left':
      players.delete(msg.id);
      renderPlayerList(); updateHostUI();
      updateReadyHint();
      break;
    case 'beat-song-ready':
      onSongReady(msg);
      break;
    case 'beat-difficulty':
      selectedDifficulty = msg.difficulty;
      renderDifficultySelection();
      break;
    case 'beat-player-ready':
      updateReadyHint();
      break;
    case 'beat-go':
      startCountdown(msg);
      break;
    case 'beat-opponent-update':
      updateOpponentPanel(msg);
      break;
    case 'beat-game-over':
      onGameOver(msg);
      break;
    case 'beat-opponent-left':
      if (gamePhase === 'playing') { endGame(false); }
      statusEl.textContent = 'Opponent left the race.';
      break;
    case 'beat-reset':
      resetToHub();
      break;
    case 'error':
      alert(msg.msg);
      location.href = '/';
      break;
  }
}

function updateReadyHint() {
  const hint = $('readyHint');
  if (!hint) return;
  if (players.size === 1) hint.textContent = 'Ready up to play solo.';
  else hint.textContent = 'Both players must ready up to start the race.';
}

connect();

// ── Rules modal ──────────────────────────────────────────────────────
$('btnRules').addEventListener('click', () => { $('rulesModal').style.display = 'flex'; });
$('btnCloseRules').addEventListener('click', () => { $('rulesModal').style.display = 'none'; });

// ── Source tabs ──────────────────────────────────────────────────────
let currentSrc = 'youtube';
document.querySelectorAll('.br-tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.br-tab').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    currentSrc = tab.dataset.src;
    ['Youtube', 'Spotify', 'Upload'].forEach(s => { $('src' + s).style.display = (s.toLowerCase() === currentSrc) ? '' : 'none'; });
  });
});

// ── Prepare / analyze song ────────────────────────────────────────────
function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

$('btnAnalyze').addEventListener('click', async () => {
  if (!isHost()) return;
  const errBox = $('prepareError'); errBox.style.display = 'none'; errBox.textContent = '';
  const loadingBox = $('loadingBox'); const loadingText = $('loadingText');
  let payload;
  try {
    if (currentSrc === 'youtube') {
      const url = $('youtubeUrl').value.trim();
      if (!url) throw new Error('Paste a YouTube URL first');
      payload = { type: 'youtube', url };
    } else if (currentSrc === 'spotify') {
      const url = $('spotifyUrl').value.trim();
      if (!url) throw new Error('Paste a Spotify track URL first');
      payload = { type: 'spotify', url };
    } else {
      const file = $('uploadFile').files[0];
      if (!file) throw new Error('Choose an audio file first');
      if (file.size > 20 * 1024 * 1024) throw new Error('File too large \u2014 max 20MB');
      loadingText.textContent = 'Uploading file\u2026';
      loadingBox.style.display = '';
      const dataBase64 = await fileToBase64(file);
      payload = { type: 'upload', filename: file.name, mime: file.type, dataBase64 };
    }
  } catch (err) {
    errBox.textContent = err.message; errBox.style.display = ''; loadingBox.style.display = 'none';
    return;
  }

  $('btnAnalyze').disabled = true;
  loadingBox.style.display = '';
  const stages = ['Extracting audio\u2026', 'Detecting beats\u2026', 'Generating note map\u2026'];
  let stageIdx = 0;
  loadingText.textContent = stages[0];
  const stageTimer = setInterval(() => { stageIdx = Math.min(stageIdx + 1, stages.length - 1); loadingText.textContent = stages[stageIdx]; }, 2500);

  try {
    const res = await fetch('/api/beatgame/prepare', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to prepare song');
    loadingText.textContent = 'Ready!';
    wsSend({ type: 'beat-song-ready', title: data.title, artist: data.artist, thumbnail: data.thumbnail, bpm: data.bpm, duration: data.duration, sessionId: data.sessionId, noteMaps: data.noteMaps });
    saveRecent({ title: data.title, thumbnail: data.thumbnail, url: payload.url || null, bpm: data.bpm, duration: data.duration });
  } catch (err) {
    errBox.textContent = err.message; errBox.style.display = '';
  } finally {
    clearInterval(stageTimer);
    loadingBox.style.display = 'none';
    $('btnAnalyze').disabled = false;
  }
});

// ── Recently played (localStorage) ───────────────────────────────────
const RECENT_KEY = 'beatrush_recent';
function loadRecents() { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch { return []; } }
function saveRecent(entry) {
  if (!entry.url) return;
  const list = loadRecents().filter(r => r.url !== entry.url);
  list.unshift({ ...entry, lastPlayed: Date.now() });
  localStorage.setItem(RECENT_KEY, JSON.stringify(list.slice(0, 8)));
  renderRecents();
}
function renderRecents() {
  const list = loadRecents();
  const box = $('recentList');
  if (!list.length) { box.innerHTML = '<div class="br-hint">No songs played yet.</div>'; return; }
  box.innerHTML = '';
  for (const r of list) {
    const el = document.createElement('div');
    el.className = 'br-recent-card';
    el.innerHTML = `<img src="${r.thumbnail || ''}" onerror="this.style.visibility='hidden'"><div class="br-recent-meta"><b>${escapeHtml(r.title)}</b>${r.bpm ? r.bpm + ' BPM \u00b7 ' : ''}${Math.round(r.duration || 0)}s</div>`;
    el.addEventListener('click', () => {
      if (!isHost()) return;
      const isYt = /youtu/.test(r.url);
      document.querySelector(`.br-tab[data-src="${isYt ? 'youtube' : 'spotify'}"]`).click();
      $(isYt ? 'youtubeUrl' : 'spotifyUrl').value = r.url;
    });
    box.appendChild(el);
  }
}
function escapeHtml(s) { return String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
renderRecents();

// ── Local best scores ─────────────────────────────────────────────────
const BEST_KEY = 'beatrush_scores';
function songKey(title, duration) { return title + '|' + Math.round(duration); }
function getLocalBest(title, duration, diff) {
  try { const all = JSON.parse(localStorage.getItem(BEST_KEY)) || {}; return (all[songKey(title, duration)] || {})[diff] || 0; } catch { return 0; }
}
function setLocalBest(title, duration, diff, score) {
  try {
    const all = JSON.parse(localStorage.getItem(BEST_KEY)) || {};
    const key = songKey(title, duration);
    all[key] = all[key] || {};
    if (score > (all[key][diff] || 0)) all[key][diff] = score;
    localStorage.setItem(BEST_KEY, JSON.stringify(all));
  } catch {}
}

// ── Song info / difficulty ────────────────────────────────────────────
let currentSong = null; // { title, artist, thumbnail, bpm, duration, sessionId, noteMaps }
let selectedDifficulty = 'normal';

function onSongReady(msg) {
  currentSong = { title: msg.title, artist: msg.artist, thumbnail: msg.thumbnail, bpm: msg.bpm, duration: msg.duration, sessionId: msg.sessionId, noteMaps: msg.noteMaps };
  $('songThumb').src = msg.thumbnail || '';
  $('songTitle').textContent = msg.title;
  $('songArtist').textContent = msg.artist || '';
  $('songBpm').textContent = Math.round(msg.bpm) + ' BPM';
  $('songDuration').textContent = fmtTime(msg.duration);
  $('countEasy').textContent = (msg.noteMaps.easy.notes.length) + ' notes';
  $('countNormal').textContent = (msg.noteMaps.normal.notes.length) + ' notes';
  $('countHard').textContent = (msg.noteMaps.hard.notes.length) + ' notes';
  $('songInfo').style.display = '';
  renderDifficultySelection();
  prefetchAudio(msg.sessionId);
}

function renderDifficultySelection() {
  document.querySelectorAll('.br-diff-card').forEach(c => c.classList.toggle('selected', c.dataset.diff === selectedDifficulty));
}
document.querySelectorAll('.br-diff-card').forEach(card => {
  card.addEventListener('click', () => {
    if (!isHost()) return;
    wsSend({ type: 'beat-set-difficulty', difficulty: card.dataset.diff });
  });
});

$('btnReady').addEventListener('click', () => { wsSend({ type: 'beat-ready' }); $('btnReady').disabled = true; });

function fmtTime(sec) { sec = Math.max(0, Math.round(sec || 0)); return Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0'); }

// ── Audio prefetch / decode ────────────────────────────────────────────
let audioCtx = null, audioBuffer = null, audioSource = null, audioStartCtxTime = 0;
async function prefetchAudio(sessionId) {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const res = await fetch('/api/beatgame/audio/' + sessionId);
    if (!res.ok) throw new Error('Audio fetch failed');
    const arr = await res.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(arr);
  } catch (err) {
    console.error('Beat Rush audio prefetch failed', err);
  }
}

// ── Countdown / game start ─────────────────────────────────────────────
function startCountdown(msg) {
  selectedDifficulty = msg.difficulty;
  gamePhase = 'countdown';
  showScreen('screenCountdown');
  const numEl = $('countdownNum');
  function tick() {
    const remain = Math.ceil((msg.startTimestamp - Date.now()) / 1000);
    if (remain <= 0) { beginGame(msg); return; }
    numEl.textContent = String(remain);
    numEl.style.animation = 'none'; void numEl.offsetWidth; numEl.style.animation = '';
    setTimeout(tick, 250);
  }
  tick();

  if (audioCtx && audioBuffer) {
    const delaySec = Math.max(0, (msg.startTimestamp - Date.now()) / 1000);
    audioStartCtxTime = audioCtx.currentTime + delaySec;
    audioSource = audioCtx.createBufferSource();
    audioSource.buffer = audioBuffer;
    audioSource.connect(audioCtx.destination);
    audioSource.start(audioStartCtxTime);
  }
}

// ── Gameplay state ──────────────────────────────────────────────────
const LANE_X = [-1.5, -0.5, 0.5, 1.5];
const TRAVEL_TIME = 2.6; // seconds from spawn to hit zone
const HIT_Z = 2;
const SPAWN_Z = -50;
let scene, camera, renderer, clock;
let laneObjects = [], starField, wallGrids = [];
let activeNotes = [];
let noteMap = null, timingWindow = 0.1;
let songDuration = 0, opponentExists = false;
let combo = 0, maxCombo = 0, multiplier = 1, health = 100;
let totalBase = 0, totalPossibleBase = 0, totalScore = 0;
const counts = { perfect: 0, great: 0, good: 0, miss: 0, bomb: 0 };
let lastScoreSend = 0, ended = false;
let arrowTextures = {};

function initThree() {
  const canvas = $('gameCanvas');
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  scene = new THREE.Scene();
  scene.background = new THREE.Color(0x050508);
  scene.fog = new THREE.Fog(0x050508, 40, 100);
  camera = new THREE.PerspectiveCamera(70, 1, 0.1, 200);
  camera.position.set(0, 0.5, 4.5);
  camera.lookAt(0, 0.3, -10);

  scene.add(new THREE.AmbientLight(0x334455, 1.2));
  const hitLight = new THREE.PointLight(0x00ffff, 2, 15);
  hitLight.position.set(0, 1, HIT_Z);
  scene.add(hitLight);

  // Floor + ceiling neon grids
  const floorGrid = new THREE.GridHelper(60, 40, 0x00ffff, 0x0a2a3a);
  floorGrid.position.set(0, -1.6, -20);
  scene.add(floorGrid); wallGrids.push(floorGrid);
  const ceilGrid = new THREE.GridHelper(60, 40, 0x7c3aed, 0x1a0a3a);
  ceilGrid.position.set(0, 2.6, -20);
  scene.add(ceilGrid); wallGrids.push(ceilGrid);

  // Lane guide lines
  const laneMat = new THREE.LineBasicMaterial({ color: 0x00ffff, transparent: true, opacity: 0.35 });
  for (const x of LANE_X) {
    const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(x, -1.5, SPAWN_Z), new THREE.Vector3(x, -1.5, 6)]);
    scene.add(new THREE.Line(geo, laneMat));
  }

  // Hit zone plane
  const hitGeo = new THREE.PlaneGeometry(6, 3);
  const hitMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, side: THREE.DoubleSide });
  const hitPlane = new THREE.Mesh(hitGeo, hitMat);
  hitPlane.position.set(0, 0.4, HIT_Z);
  scene.add(hitPlane);

  // Star field
  const starGeo = new THREE.BufferGeometry();
  const starCount = 400;
  const starPos = new Float32Array(starCount * 3);
  for (let i = 0; i < starCount; i++) {
    starPos[i * 3] = (Math.random() - 0.5) * 100;
    starPos[i * 3 + 1] = (Math.random() - 0.5) * 60;
    starPos[i * 3 + 2] = -Math.random() * 100;
  }
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starField = new THREE.Points(starGeo, new THREE.PointsMaterial({ color: 0x88ccff, size: 0.15, transparent: true, opacity: 0.6 }));
  scene.add(starField);

  clock = new THREE.Clock();
  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);
}

function resizeCanvas() {
  const el = $('screenGame');
  if (!renderer || !el) return;
  const w = el.clientWidth || window.innerWidth, h = el.clientHeight || window.innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}

function makeArrowTexture(direction) {
  if (arrowTextures[direction]) return arrowTextures[direction];
  const c = document.createElement('canvas'); c.width = 64; c.height = 64;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, 64, 64);
  ctx.strokeStyle = '#fff'; ctx.fillStyle = '#fff'; ctx.lineWidth = 6;
  ctx.translate(32, 32);
  const angles = { up: 0, 'up-right': 45, right: 90, 'down-right': 135, down: 180, 'down-left': 225, left: 270, 'up-left': 315 };
  if (direction === 'dot') {
    ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.fill();
  } else {
    ctx.rotate((angles[direction] || 0) * Math.PI / 180);
    ctx.beginPath();
    ctx.moveTo(0, -18); ctx.lineTo(12, 6); ctx.lineTo(4, 6); ctx.lineTo(4, 20); ctx.lineTo(-4, 20); ctx.lineTo(-4, 6); ctx.lineTo(-12, 6);
    ctx.closePath(); ctx.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  arrowTextures[direction] = tex;
  return tex;
}

function makeGlowSprite(color) {
  const c = document.createElement('canvas'); c.width = 128; c.height = 128;
  const ctx = c.getContext('2d');
  const grad = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  const hex = '#' + color.toString(16).padStart(6, '0');
  grad.addColorStop(0, hex); grad.addColorStop(0.4, hex); grad.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grad; ctx.fillRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c);
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
  const sprite = new THREE.Sprite(mat);
  sprite.scale.set(3, 3, 3);
  return sprite;
}

function spawnNoteMesh(note) {
  let mesh;
  if (note.type === 'bomb') {
    const geo = new THREE.IcosahedronGeometry(0.65, 0);
    const mat = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, emissive: 0xff0000, emissiveIntensity: 0.9, roughness: 0.6 });
    mesh = new THREE.Mesh(geo, mat);
    mesh.add(makeGlowSprite(0xff0000));
  } else {
    const color = note.lane % 2 === 0 ? 0xff3366 : 0x3366ff;
    const geo = new THREE.BoxGeometry(1.15, 1.15, 1.15);
    const mat = new THREE.MeshStandardMaterial({ color, emissive: color, emissiveIntensity: 0.9, roughness: 0.3 });
    mesh = new THREE.Mesh(geo, mat);
    mesh.add(makeGlowSprite(color));
    const spriteMat = new THREE.SpriteMaterial({ map: makeArrowTexture(note.direction), depthTest: false });
    const sprite = new THREE.Sprite(spriteMat);
    sprite.scale.set(0.95, 0.95, 0.95);
    sprite.position.z = 0.6;
    mesh.add(sprite);
  }
  mesh.position.set(LANE_X[note.lane], 0.4, SPAWN_Z);
  const light = new THREE.PointLight(note.type === 'bomb' ? 0xff0000 : (note.lane % 2 === 0 ? 0xff3366 : 0x3366ff), 1.5, 8);
  mesh.add(light);
  scene.add(mesh);
  note.mesh = mesh;
}

function burstParticles(pos, color) {
  const count = 24;
  const geo = new THREE.BufferGeometry();
  const positions = new Float32Array(count * 3);
  const velocities = [];
  for (let i = 0; i < count; i++) {
    positions[i * 3] = pos.x; positions[i * 3 + 1] = pos.y; positions[i * 3 + 2] = pos.z;
    const theta = Math.random() * Math.PI * 2, phi = Math.random() * Math.PI;
    velocities.push(new THREE.Vector3(Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)).multiplyScalar(2 + Math.random() * 2));
  }
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const mat = new THREE.PointsMaterial({ color, size: 0.12, transparent: true, opacity: 1 });
  const points = new THREE.Points(geo, mat);
  scene.add(points);
  const start = performance.now();
  function animateBurst() {
    const t = (performance.now() - start) / 600;
    if (t >= 1) { scene.remove(points); geo.dispose(); mat.dispose(); return; }
    const pos2 = geo.attributes.position;
    for (let i = 0; i < count; i++) {
      pos2.array[i * 3] += velocities[i].x * 0.02;
      pos2.array[i * 3 + 1] += velocities[i].y * 0.02 - 0.02;
      pos2.array[i * 3 + 2] += velocities[i].z * 0.02;
    }
    pos2.needsUpdate = true;
    mat.opacity = 1 - t;
    requestAnimationFrame(animateBurst);
  }
  animateBurst();
}

function showJudge(text, color) {
  const el = $('judgeText');
  el.textContent = text;
  el.style.color = color;
  el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
}

// ── Game start ──────────────────────────────────────────────────────
function beginGame(msg) {
  gamePhase = 'playing';
  showScreen('screenGame');
  if (!scene) initThree();
  resizeCanvas();

  opponentExists = players.size > 1;
  $('opponentPanel').style.display = opponentExists ? '' : 'none';
  if (opponentExists) {
    const opp = [...players.entries()].find(([pid]) => pid !== myId);
    $('oppName').textContent = opp ? opp[1].name : 'Opponent';
  }

  const map = currentSong.noteMaps[selectedDifficulty];
  timingWindow = map.timingWindow;
  activeNotes = map.notes.map((n, i) => ({ ...n, id: i, judged: false, mesh: null, spawnTime: n.time - TRAVEL_TIME }));
  totalPossibleBase = activeNotes.filter(n => n.type !== 'bomb').length * 300;
  songDuration = currentSong.duration;

  combo = 0; maxCombo = 0; multiplier = 1; health = 100;
  totalBase = 0; totalScore = 0; ended = false;
  counts.perfect = 0; counts.great = 0; counts.good = 0; counts.miss = 0; counts.bomb = 0;
  lastScoreSend = 0;

  $('hudTitle').textContent = currentSong.title;
  $('healthFill').style.width = '100%';
  updateHud();

  // clear leftover meshes from previous run
  for (const n of activeNotes) if (n.mesh) { scene.remove(n.mesh); n.mesh = null; }

  requestAnimationFrame(animate);
}

function updateHud() {
  $('hudScore').textContent = Math.round(totalScore);
  $('hudMult').textContent = 'x' + multiplier;
  const acc = totalPossibleBase > 0 ? (totalBase / totalPossibleBase) * 100 : 100;
  $('hudAcc').textContent = acc.toFixed(1) + '%';
  $('healthFill').style.width = Math.max(0, Math.min(100, health)) + '%';
  $('hudTime').textContent = fmtTime(Math.max(0, (audioCtx ? audioCtx.currentTime - audioStartCtxTime : 0))) + ' / ' + fmtTime(songDuration);
}

function updateMultiplier() {
  if (combo >= 30) multiplier = 8;
  else if (combo >= 20) multiplier = 4;
  else if (combo >= 10) multiplier = 2;
  else multiplier = 1;
  maxCombo = Math.max(maxCombo, combo);
}

function judgeHit(note, diff) {
  note.judged = true;
  let judgement, base, color;
  if (diff <= 0.03) { judgement = 'PERFECT'; base = 300; color = '#ffd700'; health = Math.min(100, health + 2); }
  else if (diff <= 0.07) { judgement = 'GREAT'; base = 200; color = '#00ffff'; health = Math.min(100, health + 1); }
  else { judgement = 'GOOD'; base = 100; color = '#00ff88'; health = Math.min(100, health + 0.5); }
  combo++; updateMultiplier();
  totalBase += base; totalScore += base * multiplier;
  counts[judgement.toLowerCase()]++;
  showJudge(judgement, color);
  if (note.mesh) { burstParticles(note.mesh.position, note.lane % 2 === 0 ? 0xff3366 : 0x3366ff); scene.remove(note.mesh); note.mesh = null; }
  updateHud();
}

function judgeMiss(note) {
  note.judged = true;
  combo = 0; multiplier = 1;
  counts.miss++;
  health = Math.max(0, health - 10);
  showJudge('MISS', '#666666');
  if (note.mesh) { scene.remove(note.mesh); note.mesh = null; }
  updateHud();
}

function judgeBomb(note) {
  note.judged = true;
  combo = 0; multiplier = 1;
  totalScore = Math.max(0, totalScore - 10);
  counts.bomb++;
  health = Math.max(0, health - 10);
  showJudge('BOMB!', '#ff3333');
  if (note.mesh) { burstParticles(note.mesh.position, 0xff0000); scene.remove(note.mesh); note.mesh = null; }
  updateHud();
}

const KEY_DIR = { ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right', q: 'up-left', e: 'up-right', z: 'down-left', c: 'down-right', ' ': 'dot' };
window.addEventListener('keydown', (e) => {
  if (gamePhase !== 'playing') return;
  const dir = KEY_DIR[e.key] || KEY_DIR[e.key.toLowerCase()];
  if (!dir) return;
  e.preventDefault();
  attemptSlash(dir);
});

function attemptSlash(dir) {
  if (!audioCtx) return;
  const songTime = audioCtx.currentTime - audioStartCtxTime;
  let bestNormal = null, bestNormalDiff = Infinity;
  let bestBomb = null, bestBombDiff = Infinity;
  for (const note of activeNotes) {
    if (note.judged) continue;
    const diff = Math.abs(songTime - note.time);
    if (diff > timingWindow) continue;
    if (note.type === 'bomb') { if (diff < bestBombDiff) { bestBomb = note; bestBombDiff = diff; } continue; }
    if (note.direction === dir || note.direction === 'dot') { if (diff < bestNormalDiff) { bestNormal = note; bestNormalDiff = diff; } }
  }
  if (bestNormal) judgeHit(bestNormal, bestNormalDiff);
  else if (bestBomb) judgeBomb(bestBomb);
}

function animate() {
  if (gamePhase !== 'playing') return;
  requestAnimationFrame(animate);
  const songTime = audioCtx ? audioCtx.currentTime - audioStartCtxTime : 0;

  for (const note of activeNotes) {
    if (note.judged) continue;
    const progress = (songTime - note.spawnTime) / TRAVEL_TIME;
    if (progress < 0) continue;
    if (!note.mesh) spawnNoteMesh(note);
    const z = THREE.MathUtils.lerp(SPAWN_Z, HIT_Z, Math.min(1.15, progress));
    note.mesh.position.z = z;
    note.mesh.rotation.y = Math.min(1, progress) * Math.PI * 0.5;
    if (songTime - note.time > timingWindow) judgeMiss(note);
  }

  // subtle camera bob + beat pulse on tunnel walls
  const bpm = currentSong?.bpm || 120;
  const beatInterval = 60 / bpm;
  const phase = (songTime % beatInterval) / beatInterval;
  const pulse = Math.max(0, 1 - phase * 4);
  camera.position.y = 0.5 + Math.sin(songTime * 2) * 0.02;
  for (const g of wallGrids) g.scale.setScalar(1 + pulse * 0.03);
  if (starField) starField.rotation.z += 0.0003;

  renderer.render(scene, camera);

  if (songTime - lastScoreSend > 2 && gamePhase === 'playing') {
    lastScoreSend = songTime;
    const acc = totalPossibleBase > 0 ? (totalBase / totalPossibleBase) * 100 : 100;
    wsSend({ type: 'beat-score-update', score: Math.round(totalScore), health: Math.max(0, health), combo, accuracy: Math.round(acc * 10) / 10 });
  }

  if (songTime >= songDuration + 0.5 && !ended) endGame(false);
}

function updateOpponentPanel(msg) {
  $('oppScore').textContent = Math.round(msg.score);
  $('oppHealthFill').style.width = Math.max(0, Math.min(100, msg.health)) + '%';
  $('oppCombo').textContent = msg.combo > 1 ? msg.combo + ' combo' : '';
}

// ── End of game / results ────────────────────────────────────────────
let myFinalResult = null;
function endGame(failed) {
  if (ended) return;
  ended = true;
  gamePhase = 'results';
  try { if (audioSource) audioSource.stop(); } catch {}

  const acc = totalPossibleBase > 0 ? (totalBase / totalPossibleBase) * 100 : 100;
  const accFrac = acc / 100;
  const fullCombo = counts.miss === 0 && counts.bomb === 0 && !failed;
  const finalScore = failed ? Math.round(totalScore) : Math.round(totalScore + accFrac * accFrac * 500 + (fullCombo ? 2000 : 0));
  const rank = failed ? 'F' : acc >= 95 ? 'S' : acc >= 85 ? 'A' : acc >= 70 ? 'B' : acc >= 50 ? 'C' : 'D';

  myFinalResult = { score: finalScore, accuracy: Math.round(acc * 10) / 10, maxCombo, rank, breakdown: { ...counts }, failed, fullCombo };

  reportScore('beatrush', finalScore);
  setLocalBest(currentSong.title, currentSong.duration, selectedDifficulty, finalScore);

  wsSend({ type: 'beat-final-score', score: finalScore, accuracy: myFinalResult.accuracy, maxCombo, rank, breakdown: counts, failed });

  renderResults(myFinalResult, null);
  showScreen('screenResults');
}

function renderResults(mine, gameOverMsg) {
  $('resultRank').textContent = mine.rank;
  $('resultScore').textContent = mine.score;
  $('resultAcc').textContent = mine.accuracy + '%';
  $('resultCombo').textContent = mine.maxCombo;
  $('resultFC').style.display = mine.fullCombo ? '' : 'none';
  $('resultBreakdown').innerHTML = `
    <div><b>${mine.breakdown.perfect}</b>Perfect</div>
    <div><b>${mine.breakdown.great}</b>Great</div>
    <div><b>${mine.breakdown.good}</b>Good</div>
    <div><b>${mine.breakdown.miss}</b>Miss</div>`;

  const cmp = $('pvpCompare');
  if (gameOverMsg && !gameOverMsg.solo) {
    const oppEntry = Object.entries(gameOverMsg.results).find(([pid]) => pid !== myId);
    if (oppEntry) {
      const [, opp] = oppEntry;
      const won = gameOverMsg.winnerId === myId;
      cmp.innerHTML = `<div>${won ? '\u{1F3C6} You win!' : opp.score > mine.score ? opp.name + ' wins!' : 'Tied!'}</div>
        <div style="margin-top:.5rem">You: <b>${mine.score}</b> (${mine.rank}) vs ${escapeHtml(opp.name)}: <b>${opp.score}</b> (${opp.rank})</div>`;
      cmp.style.display = '';
    }
  } else {
    cmp.style.display = 'none';
  }
}

function onGameOver(msg) {
  if (myFinalResult) renderResults(myFinalResult, msg);
}

$('btnPlayAgain').addEventListener('click', () => {
  wsSend({ type: 'beat-play-again' });
});
$('btnBackHub').addEventListener('click', () => { resetToHub(); wsSend({ type: 'beat-play-again' }); });

function resetToHub() {
  gamePhase = 'hub';
  $('btnReady').disabled = false;
  showScreen('screenHub');
}

function showScreen(id) {
  ['screenHub', 'screenCountdown', 'screenGame', 'screenResults'].forEach(s => { $(s).style.display = s === id ? '' : 'none'; });
}

document.addEventListener('visibilitychange', () => {
  if (!audioCtx) return;
  if (document.hidden && gamePhase === 'playing') { audioCtx.suspend(); }
  else if (!document.hidden && gamePhase === 'playing') { audioCtx.resume(); }
});

})();

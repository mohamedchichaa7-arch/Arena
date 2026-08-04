(() => {
'use strict';

// ── Bootstrap ─────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const roomId = params.get('room');
const myName = sessionStorage.getItem('arena-name') || 'Player';
if (!roomId) { location.href = '/'; return; }

const $ = id => document.getElementById(id);

// ── DOM refs ──────────────────────────────────────────────────────
const statusEl       = $('status');
const playerListEl   = $('playerList');
const playerCountEl  = $('playerCount');
const roomBadge      = $('roomBadge');
const btnBack        = $('btnBack');
const btnRules       = $('btnRules');
const btnCloseRules  = $('btnCloseRules');
const btnToggleSide  = $('btnToggleSidebar');
const rulesModal     = $('rulesModal');
const hostControls   = $('hostControls');
const scorePanelEl   = $('scorePanel');
const scoreListEl    = $('scoreList');
const btnStart       = $('btnStart');
const btnReady       = $('btnReady');
const btnConfirm     = $('btnConfirm');
const btnToggleCorner= $('btnToggleCorner');
const btnRematch     = $('btnRematch');
const btnLobby       = $('btnLobby');
const btnAddPhoto    = $('btnAddPhoto');

// Phase panels
const PHASES = ['lobby','loading','viewing','guessing','reveal','ended'];
const phasePanels = {};
PHASES.forEach(p => { phasePanels[p] = $('phase' + p); });

// ── State ─────────────────────────────────────────────────────────
let ws = null, myId = null, leaderId = null;
const players = new Map();
let phase = 'lobby';
let currentRound = 0, totalRounds = 10;
let gameScores = {};
let roundData = null;           // current geo-round-start data
let myGuessLat = null, myGuessLng = null;
let guessConfirmed = false;
let opponentGuessed = false;
let timerInterval = null;
let selectedDifficulty = 'normal';
let selectedRounds = 10;
let customPhotos = [];          // { photoUrl, lat, lng, country, city }

let roundPhotoUrls = {};        // round number → resolved photo URL

// ── Leaflet maps ──────────────────────────────────────────────────
let guessMap = null, guessMarker = null;
let revealMap = null;
let recapMap  = null;
let cpMap = null, cpMarker = null, cpLat = null, cpLng = null;

// Custom icons
const myPinIcon = () => L.divIcon({ html: '<div class="geo-pin geo-pin-me"></div>', iconSize:[20,20], iconAnchor:[10,10], className:'' });
const oppPinIcon= () => L.divIcon({ html: '<div class="geo-pin geo-pin-opp"></div>', iconSize:[20,20], iconAnchor:[10,10], className:'' });
const okPinIcon = () => L.divIcon({ html: '<div class="geo-pin geo-pin-correct"></div>', iconSize:[20,20], iconAnchor:[10,10], className:'' });
const numPinIcon= n  => L.divIcon({ html: `<div class="geo-num-pin">${n}</div>`, iconSize:[26,26], iconAnchor:[13,13], className:'' });

// ── Utility ───────────────────────────────────────────────────────
function escHtml(s) { return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function fmtDist(km) {
  if (!isFinite(km) || km >= 20000) return 'No guess';
  if (km < 1) return '<1 km';
  if (km >= 1000) return (km/1000).toFixed(1) + ',000 km';
  return Math.round(km) + ' km';
}
roomBadge.textContent = 'Room ' + roomId;

// ── Timer ─────────────────────────────────────────────────────────
function startTimer(seconds, displayEl, onDone) {
  stopTimer();
  let rem = seconds;
  if (displayEl) { displayEl.textContent = rem; displayEl.classList.remove('warning'); }
  timerInterval = setInterval(() => {
    rem--;
    if (displayEl) {
      displayEl.textContent = Math.max(0, rem);
      if (rem <= 5) displayEl.classList.add('warning');
    }
    if (rem <= 0) { stopTimer(); if (onDone) onDone(); }
  }, 1000);
}
function stopTimer() {
  if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
  [$('viewTimer'), $('guessTimer'), $('revealCountdown')].forEach(el => el?.classList.remove('warning'));
}

// ── Phase management ──────────────────────────────────────────────
function showPhase(name) {
  phase = name;
  PHASES.forEach(p => { if (phasePanels[p]) phasePanels[p].style.display = p === name ? '' : 'none'; });
  updateScorePanel();
  if (name === 'guessing') setTimeout(initGuessMap, 60);
}

// ── Player list ───────────────────────────────────────────────────
function renderPlayerList() {
  playerListEl.innerHTML = '';
  playerCountEl.textContent = players.size;
  for (const [pid, p] of players) {
    const el = document.createElement('div');
    el.className = 'player-item' + (pid === myId ? ' is-me' : '');
    el.textContent = p.name + (pid === leaderId ? ' 👑' : '');
    playerListEl.appendChild(el);
  }
}

function updateScorePanel() {
  if (phase === 'lobby' || phase === 'loading') { scorePanelEl.style.display = 'none'; return; }
  scorePanelEl.style.display = '';
  scoreListEl.innerHTML = '';
  [...players.entries()].sort((a,b) => (gameScores[b[0]]||0) - (gameScores[a[0]]||0)).forEach(([pid,p]) => {
    const el = document.createElement('div');
    el.className = 'score-row' + (pid === myId ? ' is-me' : '');
    el.innerHTML = `<span class="score-name">${escHtml(p.name)}</span><span class="score-val">${gameScores[pid]||0}</span>`;
    scoreListEl.appendChild(el);
  });
}

function updateHostUI() {
  if (hostControls) hostControls.style.display = (leaderId === myId && phase === 'lobby') ? '' : 'none';
}

// ── Difficulty / rounds pickers ───────────────────────────────────
document.querySelectorAll('.diff-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.diff-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedDifficulty = btn.dataset.diff;
    wsSend({ type: 'geo-lobby-config', difficulty: selectedDifficulty, rounds: selectedRounds });
  });
});
document.querySelectorAll('.rounds-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.rounds-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    selectedRounds = parseInt(btn.dataset.rounds);
    wsSend({ type: 'geo-lobby-config', difficulty: selectedDifficulty, rounds: selectedRounds });
  });
});
function applyConfig(diff, rounds) {
  selectedDifficulty = diff;
  selectedRounds = rounds;
  document.querySelectorAll('.diff-btn').forEach(b => b.classList.toggle('active', b.dataset.diff === diff));
  document.querySelectorAll('.rounds-btn').forEach(b => b.classList.toggle('active', parseInt(b.dataset.rounds) === rounds));
}

// ── Custom photo submission ────────────────────────────────────────
const cpUrl     = $('cpUrl');
const cpPreview = $('cpPreview');
cpUrl?.addEventListener('input', () => {
  const u = cpUrl.value.trim();
  if (u && /^https?:\/\//i.test(u)) { cpPreview.src = u; cpPreview.style.display = ''; }
  else cpPreview.style.display = 'none';
});

function initCpMap() {
  if (cpMap) { cpMap.invalidateSize(); return; }
  cpMap = L.map('cpMap', { center:[20,0], zoom:1 });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OpenStreetMap' }).addTo(cpMap);
  cpMap.on('click', e => {
    cpLat = e.latlng.lat; cpLng = e.latlng.lng;
    if (cpMarker) cpMarker.setLatLng(e.latlng);
    else cpMarker = L.marker(e.latlng, { icon: myPinIcon() }).addTo(cpMap);
  });
}
document.querySelector('.custom-photos-panel')?.addEventListener('toggle', e => {
  if (e.target.open) setTimeout(() => { initCpMap(); }, 200);
});

btnAddPhoto?.addEventListener('click', () => {
  const url = cpUrl.value.trim();
  if (!url || !/^https?:\/\//i.test(url)) { alert('Enter a valid https:// URL.'); return; }
  if (cpLat === null) { alert('Click the map to pin the location.'); return; }
  const country = ($('cpCountry').value.trim() || 'Unknown');
  const city    = ($('cpCity').value.trim() || '');
  customPhotos.push({ photoUrl: url, lat: cpLat, lng: cpLng, country, city });
  renderCpList();
  cpUrl.value = ''; cpPreview.style.display = 'none';
  $('cpCountry').value = ''; $('cpCity').value = '';
  if (cpMarker) { cpMap.removeLayer(cpMarker); cpMarker = null; }
  cpLat = null; cpLng = null;
});

function renderCpList() {
  const list = $('customPhotoList');
  if (!list) return;
  list.innerHTML = '';
  const countEl = $('cpCount');
  if (countEl) countEl.textContent = customPhotos.length ? `(${customPhotos.length})` : '';
  customPhotos.forEach((cp, i) => {
    const el = document.createElement('div');
    el.className = 'cp-list-item';
    el.innerHTML = `<img src="${escHtml(cp.photoUrl)}" alt="" class="cp-thumb"><span>${escHtml(cp.city||cp.country)}</span><button class="cp-remove" data-i="${i}">✕</button>`;
    list.appendChild(el);
  });
  list.querySelectorAll('.cp-remove').forEach(btn => {
    btn.addEventListener('click', () => { customPhotos.splice(parseInt(btn.dataset.i), 1); renderCpList(); });
  });
}

// ── Start game ────────────────────────────────────────────────────
btnStart?.addEventListener('click', () => {
  if (players.size < 2) { statusEl.textContent = 'Need 2 players to start!'; return; }
  wsSend({ type: 'geo-start', difficulty: selectedDifficulty, rounds: selectedRounds, customPhotos });
});

// ── Viewing phase actions ─────────────────────────────────────────
btnReady?.addEventListener('click', () => {
  wsSend({ type: 'geo-ready' });
  btnReady.disabled = true;
  btnReady.textContent = 'Waiting for opponent…';
});
function enableReadyDelayed() {
  btnReady.disabled = true;
  btnReady.textContent = '⏳ Please wait…';
  setTimeout(() => {
    if (phase === 'viewing') {
      btnReady.disabled = false;
      btnReady.textContent = '👉 Ready to Guess';
    }
  }, 5000);
}

// Photo zoom lightbox
$('photoFrame')?.addEventListener('click', () => { openLightbox($('roundPhoto').src); });
$('lightboxOverlay')?.addEventListener('click', closeLightbox);
$('btnCloseLightbox')?.addEventListener('click', closeLightbox);
function openLightbox(src) { $('lightboxImg').src = src; $('lightbox').style.display = 'flex'; }
function closeLightbox() { $('lightbox').style.display = 'none'; }

// ── Guess map ─────────────────────────────────────────────────────
function initGuessMap() {
  if (guessMap) { guessMap.invalidateSize(); return; }
  guessMap = L.map('map', { center:[20,0], zoom:2, minZoom:1 });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>', maxZoom:18,
  }).addTo(guessMap);
  guessMap.on('click', onGuessClick);
}

function onGuessClick(e) {
  if (guessConfirmed) return;
  myGuessLat = e.latlng.lat; myGuessLng = e.latlng.lng;
  if (guessMarker) guessMarker.setLatLng(e.latlng);
  else guessMarker = L.marker(e.latlng, { icon: myPinIcon() }).addTo(guessMap);
  btnConfirm.disabled = false;
  $('guessStatus').textContent = 'Pin placed — confirm when ready.';
}

btnConfirm?.addEventListener('click', () => {
  if (myGuessLat === null || guessConfirmed) return;
  guessConfirmed = true;
  btnConfirm.disabled = true;
  btnConfirm.textContent = 'Sent ✓';
  $('guessStatus').textContent = opponentGuessed ? 'Both guessed! Revealing…' : 'Waiting for opponent…';
  stopTimer();
  wsSend({ type: 'geo-guess', lat: myGuessLat, lng: myGuessLng });
});

btnToggleCorner?.addEventListener('click', () => {
  const c = $('photoCorner');
  c.classList.toggle('collapsed');
  btnToggleCorner.textContent = c.classList.contains('collapsed') ? '+' : '−';
});

// ── Reveal map ────────────────────────────────────────────────────
function buildRevealMap(data) {
  if (revealMap) { revealMap.remove(); revealMap = null; }
  const el = $('revealMap');
  if (!el) return;
  revealMap = L.map(el, { zoomControl:true });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OpenStreetMap' }).addTo(revealMap);

  const bounds = [];
  const correctLL = [data.correctLat, data.correctLng];
  bounds.push(correctLL);

  const popup = [data.city, data.country].filter(Boolean).join(', ') || data.title || '?';
  L.marker(correctLL, { icon: okPinIcon() }).addTo(revealMap).bindPopup(`✅ ${popup}`).openPopup();

  for (const r of data.results) {
    if (r.lat === null) continue;
    const ll = [r.lat, r.lng];
    bounds.push(ll);
    const icon = r.id === myId ? myPinIcon() : oppPinIcon();
    L.marker(ll, { icon }).addTo(revealMap).bindPopup(`${escHtml(r.name)}: ${fmtDist(r.distKm)}`);
    L.polyline([ll, correctLL], {
      color: r.id === myId ? '#a78bfa' : '#67e8f9',
      weight: 2, dashArray: '6 4', opacity: 0.8,
    }).addTo(revealMap);
  }
  if (bounds.length > 1) revealMap.fitBounds(bounds, { padding:[50,50] });
  else revealMap.setView(correctLL, 6);
}

// ── Show reveal ───────────────────────────────────────────────────
function showReveal(data) {
  showPhase('reveal');

  $('revealRoundInd').textContent = `Round ${data.round} / ${data.total}`;
  $('revealPhoto').src = roundData?.photoUrl || '';

  const hints = [data.city, data.country].filter(Boolean).join(', ');
  $('revealLocation').textContent = hints ? '📍 ' + hints : (data.title || '');

  // Score cards
  const scoresEl = $('revealScores');
  scoresEl.innerHTML = '';
  for (const r of data.results) {
    const isWin = r.id === data.winnerId && r.lat !== null;
    const div = document.createElement('div');
    div.className = 'reveal-result' + (isWin ? ' winner' : '');
    const label = r.id === myId ? 'You' : escHtml(r.name);
    div.innerHTML = `
      <div class="result-name">${isWin ? '🏆 ' : ''}${label}</div>
      <div class="result-dist">${fmtDist(r.distKm)}</div>
      <div class="result-score">+${r.totalRoundScore} pts${r.speedBonus > 0 ? ` <small>(⚡+${r.speedBonus})</small>` : ''}</div>
      <div class="result-total">Total: ${r.cumulativeScore}</div>`;
    scoresEl.appendChild(div);
    gameScores[r.id] = r.cumulativeScore;
  }
  updateScorePanel();

  setTimeout(() => buildRevealMap(data), 60);
  startTimer(8, $('revealCountdown'), () => {});
}

// ── Show game over ─────────────────────────────────────────────────
function showGameOver(data) {
  showPhase('ended');
  stopTimer();

  const won = data.winnerId === myId;
  $('endWinner').textContent = won ? '🏆 You Win!' : `${escHtml(data.winnerName)} Wins!`;

  const endScores = $('endScores');
  endScores.innerHTML = '';
  (data.finalScores || []).sort((a,b) => b.score - a.score).forEach(s => {
    const el = document.createElement('div');
    el.className = 'end-score-row' + (s.id === myId ? ' is-me' : '');
    el.innerHTML = `<span>${escHtml(s.id === myId ? 'You' : s.name)}</span><span class="end-pts">${s.score} pts</span>`;
    endScores.appendChild(el);
  });

  // Recap table headers
  const ids = (data.finalScores || []).map(s => s.id);
  const name0 = ids[0] === myId ? 'You' : ((data.finalScores||[]).find(s=>s.id===ids[0])?.name||'P1');
  const name1 = ids[1] === myId ? 'You' : ((data.finalScores||[]).find(s=>s.id===ids[1])?.name||'P2');
  $('rh1').textContent = name0 + ' · Distance';
  $('rh2').textContent = name1 + ' · Distance';
  $('rs1').textContent = name0 + ' · Score';
  $('rs2').textContent = name1 + ' · Score';

  const tbody = $('recapBody');
  tbody.innerHTML = '';
  (data.roundHistory || []).forEach(rh => {
    const r0 = rh.results.find(r => r.id === ids[0]);
    const r1 = rh.results.find(r => r.id === ids[1]);
    const location = rh.title || ([rh.city, rh.country].filter(Boolean).join(', ')) || '?';
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${rh.round}</td><td>${escHtml(location)}</td>
      <td>${r0 ? fmtDist(r0.distKm) : '—'}</td><td>${r1 ? fmtDist(r1.distKm) : '—'}</td>
      <td>${r0 ? '+' + r0.totalRoundScore : '—'}</td><td>${r1 ? '+' + r1.totalRoundScore : '—'}</td>`;
    tbody.appendChild(tr);
  });

  setTimeout(() => buildRecapMap(data), 150);
  if (won) reportScore('geoguessr', 1);
}

function buildRecapMap(data) {
  if (recapMap) { recapMap.remove(); recapMap = null; }
  const el = $('recapMap');
  if (!el) return;
  recapMap = L.map(el, { center:[20,0], zoom:2 });
  L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution:'© OpenStreetMap' }).addTo(recapMap);
  const bounds = [];
  (data.roundHistory || []).forEach((rh, i) => {
    const ll = [rh.correctLat, rh.correctLng];
    bounds.push(ll);
    const popupContent = (roundPhotoUrls[i+1] || rh.photoUrl
      ? `<img src="${escHtml(roundPhotoUrls[i+1] || rh.photoUrl)}" style="width:120px;height:72px;object-fit:cover;border-radius:6px;display:block;margin-bottom:4px">` : '') +
      `<b>${escHtml(rh.title || [rh.city,rh.country].filter(Boolean).join(', ') || '?')}</b>`;
    L.marker(ll, { icon: numPinIcon(i+1) }).addTo(recapMap).bindPopup(popupContent);
  });
  if (bounds.length > 0) recapMap.fitBounds(bounds, { padding:[40,40] });
}

// ── Rematch / lobby buttons ────────────────────────────────────────
btnRematch?.addEventListener('click', () => {
  if (recapMap) { recapMap.remove(); recapMap = null; }
  // Clear photo cache for the new game
  roundPhotoUrls = {};
  for (const [pid] of players) gameScores[pid] = 0;
  showPhase('lobby');
  statusEl.textContent = 'Waiting to start…';
  renderPlayerList(); updateHostUI();
});
btnLobby?.addEventListener('click', () => { location.href = '/'; });

// ── Rules modal ───────────────────────────────────────────────────
btnRules?.addEventListener('click', () => { rulesModal.style.display = 'flex'; });
btnCloseRules?.addEventListener('click', () => { rulesModal.style.display = 'none'; });
rulesModal?.addEventListener('click', e => { if (e.target === rulesModal) rulesModal.style.display = 'none'; });

// ── Sidebar toggle ────────────────────────────────────────────────
btnToggleSide?.addEventListener('click', () => { document.getElementById('sidebar').classList.toggle('open'); });
btnBack?.addEventListener('click', () => { location.href = '/'; });

// ── Message handling ──────────────────────────────────────────────
function handleMsg(msg) {
  switch (msg.type) {

    case 'room-joined': {
      myId = msg.myId; leaderId = msg.leaderId;
      players.set(myId, { name: myName });
      for (const p of msg.players) players.set(p.id, { name: p.name });
      gameScores = {}; for (const [pid] of players) gameScores[pid] = 0;
      renderPlayerList(); updateHostUI();
      statusEl.textContent = `Room ${roomId} · ${players.size}/2 player(s)`;
      break;
    }

    case 'player-joined': {
      players.set(msg.id, { name: msg.name });
      leaderId = msg.leaderId; gameScores[msg.id] = 0;
      renderPlayerList(); updateHostUI();
      statusEl.textContent = `${escHtml(msg.name)} joined!${players.size === 2 ? ' Ready to start.' : ''}`;
      break;
    }

    case 'player-left': {
      players.delete(msg.id); leaderId = msg.leaderId;
      renderPlayerList(); updateHostUI();
      break;
    }

    case 'geo-config': {
      applyConfig(msg.difficulty, msg.totalRounds || msg.rounds || 10);
      break;
    }

    case 'geo-preparing': {
      showPhase('loading');
      break;
    }

    case 'geo-game-start': {
      totalRounds = msg.totalRounds;
      break;
    }

    case 'geo-round-start': {
      currentRound = msg.round; totalRounds = msg.total;
      roundData = msg;
      myGuessLat = null; myGuessLng = null; guessConfirmed = false; opponentGuessed = false;
      showPhase('viewing');
      $('roundPhoto').src = msg.photoUrl || '';
      $('roundIndicator').textContent = `Round ${msg.round} / ${msg.total}`;
      $('readyStatus').textContent = '';
      enableReadyDelayed();
      startTimer(30, $('viewTimer'), () => {});
      // Fetch photo in the browser if not already provided (custom photos have a URL)
      if (!msg.photoUrl) {
        fetchGeoPhotoClient(msg.wikiTitle, msg.title).then(url => {
          if (url) {
            roundData.photoUrl = url;
            roundPhotoUrls[msg.round] = url;
            $('roundPhoto').src = url;
          }
        });
      } else {
        roundPhotoUrls[msg.round] = msg.photoUrl;
      }
      break;
    }

    case 'geo-player-ready': {
      $('readyStatus').textContent = `${msg.readyCount} / ${msg.total} ready`;
      if (msg.id !== myId) {
        // opponent clicked ready — prompt the player
        if (!guessConfirmed && phase === 'viewing') {
          $('readyStatus').textContent += ' — Opponent is ready!';
        }
      }
      break;
    }

    case 'geo-guess-phase': {
      showPhase('guessing');
      $('cornerPhoto').src = roundData?.photoUrl || '';
      $('guessRoundInd').textContent = `Round ${currentRound} / ${totalRounds}`;
      $('guessStatus').textContent = 'Click the map to place your pin';
      btnConfirm.disabled = true;
      btnConfirm.textContent = 'Confirm Guess ✓';
      if (guessMarker && guessMap) { guessMap.removeLayer(guessMarker); guessMarker = null; }
      if (guessMap) guessMap.setView([20, 0], 2);
      startTimer(msg.timeLimit || 45, $('guessTimer'), () => {
        if (myGuessLat !== null && !guessConfirmed) {
          guessConfirmed = true;
          btnConfirm.disabled = true; btnConfirm.textContent = 'Time\'s up ✓';
          $('guessStatus').textContent = 'Time is up — guess submitted.';
          wsSend({ type: 'geo-guess', lat: myGuessLat, lng: myGuessLng });
        }
      });
      break;
    }

    case 'geo-opponent-guessed': {
      opponentGuessed = true;
      if (guessConfirmed) $('guessStatus').textContent = 'Both guessed! Revealing…';
      else $('guessStatus').textContent = '⚡ Opponent guessed — hurry!';
      break;
    }

    case 'geo-guess-confirmed':
      break;

    case 'geo-round-reveal': {
      stopTimer();
      showReveal(msg);
      break;
    }

    case 'geo-game-over': {
      stopTimer();
      showGameOver(msg);
      break;
    }

    case 'geo-opponent-left': {
      stopTimer();
      if (phase !== 'lobby' && phase !== 'loading') {
        showPhase('lobby');
      }
      statusEl.textContent = 'Opponent disconnected.';
      updateHostUI(); renderPlayerList();
      break;
    }

    case 'error': {
      alert(msg.msg);
      if (msg.msg.toLowerCase().includes('progress') || msg.msg.toLowerCase().includes('locked')) {
        location.href = '/';
      }
      break;
    }
  }
}

// ── Client-side Wikimedia photo fetch ────────────────────────────
async function resolveWikimediaThumbClient(filename) {
  try {
    const url = `https://commons.wikimedia.org/w/api.php?action=query&titles=${encodeURIComponent('File:' + filename)}&prop=imageinfo&iiprop=url&iiurlwidth=1200&format=json&origin=*`;
    const data = await fetch(url).then(r => r.json());
    const page = Object.values(data.query?.pages || {})[0];
    const thumb = page?.imageinfo?.[0]?.thumburl || page?.imageinfo?.[0]?.url;
    return (thumb && /\.(jpg|jpeg|png|webp|gif)/i.test(thumb)) ? thumb : null;
  } catch { return null; }
}

async function fetchGeoPhotoClient(wikiTitle, title) {
  // Layer 1: Wikipedia article thumbnail
  if (wikiTitle) {
    try {
      const url = `https://en.wikipedia.org/w/api.php?action=query&titles=${encodeURIComponent(wikiTitle)}&prop=pageimages&pithumbsize=1200&format=json&origin=*`;
      const data = await fetch(url).then(r => r.json());
      for (const page of Object.values(data.query?.pages || {})) {
        if (page.thumbnail?.source) return page.thumbnail.source;
      }
    } catch {}
  }
  // Layer 2: Wikimedia Commons text search by title
  if (title && title !== 'Custom Photo') {
    try {
      const url = `https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsnamespace=6&gsrsearch=${encodeURIComponent(title)}&prop=imageinfo&iiprop=url&iiurlwidth=1200&format=json&origin=*&gslimit=8`;
      const data = await fetch(url).then(r => r.json());
      for (const page of Object.values(data.query?.pages || {})) {
        const info = page.imageinfo?.[0];
        const src = info?.thumburl || info?.url;
        if (src && /\.(jpg|jpeg|png|webp)/i.test(src)) return src;
      }
    } catch {}
  }
  return null;
}

// ── WebSocket ─────────────────────────────────────────────────────
function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

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
    stopTimer();
    if (statusEl) statusEl.textContent = 'Disconnected. Returning to lobby…';
    setTimeout(() => { location.href = '/'; }, 3000);
  };
}

connect();
})();

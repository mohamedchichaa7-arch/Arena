(() => {
'use strict';

// ── Bootstrap ─────────────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const roomId = params.get('room');
const myName = sessionStorage.getItem('arena-name') || 'Player';
if (!roomId) { location.href = '/'; return; }

const $ = id => document.getElementById(id);

// ── DOM refs ──────────────────────────────────────────────────────
const statusEl = $('status');
const playerListEl = $('playerList');
const playerCountEl = $('playerCount');
const roomBadge = $('roomBadge');
const btnBack = $('btnBack');
const btnRules = $('btnRules');
const btnCloseRules = $('btnCloseRules');
const btnToggleSide = $('btnToggleSidebar');
const rulesModal = $('rulesModal');
const btnStart = $('btnStart');
const settingsModal = $('settingsModal');

roomBadge.textContent = 'Room ' + roomId;
btnBack.addEventListener('click', () => { location.href = '/'; });
btnRules?.addEventListener('click', () => { rulesModal.style.display = 'flex'; });
btnCloseRules?.addEventListener('click', () => { rulesModal.style.display = 'none'; });
btnToggleSide?.addEventListener('click', () => { $('sidebar').classList.toggle('open'); });
$('btnSettings').addEventListener('click', () => { settingsModal.style.display = 'flex'; });
$('btnCloseSettings').addEventListener('click', () => { settingsModal.style.display = 'none'; });

// ── State ─────────────────────────────────────────────────────────
let ws = null, myId = null, leaderId = null;
const players = new Map();
let phase = 'lobby';
let config = { mode: 'solo', difficulty: 'easy', hardMode: false, totalRounds: 5, isDaily: false };
let round = { active: false, mode: 'solo', totalRounds: null, roundNum: 0, hardMode: false };
let curRow = 0, curGuess = '';
let keyState = {}; // letter -> 'correct'|'present'|'absent'
let roundStartedAt = 0;
let matchWinsTally = {};

// ── localStorage stats ───────────────────────────────────────────
const SAVE_KEY = 'wordle_save';
function loadSave() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || defaultSave(); } catch { return defaultSave(); }
}
function defaultSave() {
  return {
    daily: { lastPlayed: null, streak: 0, bestStreak: 0, history: [] },
    solo: {
      easy: soloDiffDefault(), normal: soloDiffDefault(), hard: soloDiffDefault(), expert: soloDiffDefault(),
    },
    pvp: { matchesPlayed: 0, matchesWon: 0, roundsWon: 0, roundsPlayed: 0, avgGuessesPerRound: 0 },
    seenWords: [],
  };
}
function soloDiffDefault() { return { played: 0, won: 0, currentStreak: 0, bestStreak: 0, distribution: [0,0,0,0,0,0], avgGuesses: 0, totalTimeMs: 0 }; }
function saveSave(s) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch {} }

function todayStr() { return new Date().toISOString().slice(0, 10); }

function renderSidebarStats() {
  const s = loadSave();
  let played = 0, won = 0;
  for (const d of ['easy','normal','hard','expert']) { played += s.solo[d].played; won += s.solo[d].won; }
  $('statStreak').textContent = Math.max(s.daily.streak || 0, s.solo.normal.currentStreak || 0);
  $('statWinRate').textContent = played > 0 ? Math.round((won / played) * 100) + '%' : '0%';
  $('statGames').textContent = played;
}
renderSidebarStats();

function refreshDailyStatus() {
  const s = loadSave();
  const played = s.daily.lastPlayed === todayStr();
  $('dailyStatus').textContent = played ? `✓ Played — streak ${s.daily.streak}` : (s.daily.streak > 3 ? `🔥 Streak ${s.daily.streak}` : 'Not played today');
  $('btnModeDaily').classList.toggle('disabled', played);
}
refreshDailyStatus();

// ── Color-blind mode ─────────────────────────────────────────────
function loadColorBlind() { return localStorage.getItem('wordle_colorblind') === '1'; }
$('vColorBlind').checked = loadColorBlind();
document.body.classList.toggle('wd-colorblind', loadColorBlind());
$('vColorBlind').addEventListener('change', () => {
  localStorage.setItem('wordle_colorblind', $('vColorBlind').checked ? '1' : '0');
  document.body.classList.toggle('wd-colorblind', $('vColorBlind').checked);
});

// ── Mode / setup UI ──────────────────────────────────────────────
function selectMode(mode) {
  config.mode = mode === 'daily' ? 'solo' : mode;
  config.isDaily = mode === 'daily';
  document.querySelectorAll('.wd-mode-btn').forEach(b => b.classList.remove('active'));
  ({ daily: $('btnModeDaily'), solo: $('btnModeSolo'), race: $('btnModeRace') })[mode].classList.add('active');
  $('difficultyRow').style.display = mode === 'daily' ? 'none' : '';
  $('roundsRow').style.display = mode === 'race' ? '' : 'none';
  if (mode === 'daily') { config.difficulty = 'normal'; }
  syncConfig();
}
$('btnModeDaily').addEventListener('click', () => {
  const s = loadSave();
  if (s.daily.lastPlayed === todayStr()) { alert("You've already played today's word! Come back tomorrow."); return; }
  selectMode('daily');
});
$('btnModeSolo').addEventListener('click', () => selectMode('solo'));
$('btnModeRace').addEventListener('click', () => selectMode('race'));
selectMode('solo');

function wirePillGroup(containerId, dataKey, cb) {
  $(containerId).querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      $(containerId).querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      cb(btn.dataset[dataKey]);
    });
  });
}
wirePillGroup('difficultyPicker', 'diff', v => { config.difficulty = v; syncConfig(); });
wirePillGroup('roundsPicker', 'rounds', v => { config.totalRounds = parseInt(v); syncConfig(); });
$('vHardMode').addEventListener('change', () => { config.hardMode = $('vHardMode').checked; syncConfig(); });

function syncConfig() {
  if (!isHost()) return;
  wsSend({ type: 'wd-lobby-config', difficulty: config.difficulty, mode: config.mode, hardMode: config.hardMode, totalRounds: config.totalRounds });
}
function applyConfig(c) {
  config.difficulty = c.difficulty; config.mode = c.mode; config.hardMode = c.hardMode; config.totalRounds = c.totalRounds;
  document.querySelector(`#difficultyPicker button[data-diff="${c.difficulty}"]`)?.click();
  document.querySelector(`#roundsPicker button[data-rounds="${c.totalRounds}"]`)?.click();
  $('vHardMode').checked = !!c.hardMode;
}

function isHost() { return leaderId === myId; }
function updateHostUI() {
  const canStart = isHost();
  btnStart.style.display = canStart ? '' : 'none';
  $('lobbyHint').style.display = canStart ? 'none' : '';
}

btnStart.addEventListener('click', () => {
  const s = loadSave();
  wsSend({
    type: 'wd-start', mode: config.mode, difficulty: config.difficulty, hardMode: config.hardMode,
    totalRounds: config.totalRounds, isDaily: config.isDaily, seenWords: s.seenWords || [],
  });
});

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

// ── Phase switching ───────────────────────────────────────────────
const PHASES = ['lobby', 'game', 'results', 'matchover', 'stats'];
function showPhase(p) {
  phase = p;
  PHASES.forEach(name => { const el = $('phase' + name); if (el) el.style.display = name === p ? '' : 'none'; });
}

// ── Grid ──────────────────────────────────────────────────────────
function buildGrid() {
  const grid = $('myGrid');
  grid.innerHTML = '';
  for (let r = 0; r < 6; r++) {
    const row = document.createElement('div');
    row.className = 'wd-grid-row';
    row.id = 'row' + r;
    for (let c = 0; c < 5; c++) {
      const tile = document.createElement('div');
      tile.className = 'wd-tile';
      tile.id = `t${r}_${c}`;
      row.appendChild(tile);
    }
    grid.appendChild(row);
  }
  curRow = 0; curGuess = '';
  $('wordRevealRow').style.display = 'none';
}

function renderCurRow() {
  for (let c = 0; c < 5; c++) {
    const tile = $(`t${curRow}_${c}`);
    const ch = curGuess[c] || '';
    tile.textContent = ch;
    tile.classList.toggle('filled', !!ch);
  }
}
function typeLetter(ch) {
  if (curGuess.length >= 5 || !round.active) return;
  curGuess += ch;
  renderCurRow();
  const tile = $(`t${curRow}_${curGuess.length - 1}`);
  tile.classList.add('pop');
  setTimeout(() => tile.classList.remove('pop'), 130);
}
function deleteLetter() {
  if (curGuess.length === 0 || !round.active) return;
  curGuess = curGuess.slice(0, -1);
  renderCurRow();
}
function submitGuess() {
  if (curGuess.length !== 5 || !round.active) return;
  wsSend({ type: 'wd-guess', guess: curGuess });
}
function shakeRow(hardViol) {
  const row = $('row' + curRow);
  row.classList.add(hardViol ? 'hardviol' : 'shake');
  setTimeout(() => row.classList.remove(hardViol ? 'hardviol' : 'shake'), 400);
}

document.addEventListener('keydown', e => {
  if (phase !== 'game' || !round.active) return;
  if (e.key === 'Enter') submitGuess();
  else if (e.key === 'Backspace') deleteLetter();
  else if (/^[a-zA-Z]$/.test(e.key)) typeLetter(e.key.toUpperCase());
});

// ── Keyboard ──────────────────────────────────────────────────────
const KB_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ENTER:ZXCVBNM:BACK'];
function buildKeyboard() {
  const kb = $('keyboard');
  kb.innerHTML = '';
  keyState = {};
  KB_ROWS.forEach(rowSpec => {
    const rowEl = document.createElement('div');
    rowEl.className = 'wd-kb-row';
    if (rowSpec.includes(':')) {
      const [enterKey, letters, backKey] = rowSpec.split(':');
      addKey(rowEl, 'ENTER', true);
      letters.split('').forEach(ch => addKey(rowEl, ch, false));
      addKey(rowEl, '⌫', true, 'BACK');
    } else {
      rowSpec.split('').forEach(ch => addKey(rowEl, ch, false));
    }
    kb.appendChild(rowEl);
  });
  function addKey(rowEl, label, wide, action) {
    const btn = document.createElement('button');
    btn.className = 'wd-key' + (wide ? ' wide' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      if (label === 'ENTER') submitGuess();
      else if (action === 'BACK') deleteLetter();
      else typeLetter(label);
    });
    if (!wide) btn.dataset.letter = label;
    rowEl.appendChild(btn);
  }
}
buildKeyboard();
function updateKeyboard(feedback) {
  feedback.forEach((f, i) => {
    setTimeout(() => {
      const letter = f.letter.toUpperCase();
      const cur = keyState[letter];
      if (cur === 'correct') return;
      if (f.state === 'correct') keyState[letter] = 'correct';
      else if (f.state === 'present' && cur !== 'present') keyState[letter] = 'present';
      else if (!cur) keyState[letter] = 'absent';
      const btn = document.querySelector(`.wd-key[data-letter="${letter}"]`);
      if (btn) {
        btn.classList.remove('correct', 'present', 'absent');
        btn.classList.add(keyState[letter]);
        btn.classList.add('flip');
        setTimeout(() => btn.classList.remove('flip'), 300);
      }
    }, i * 50);
  });
}

// ── Round setup ───────────────────────────────────────────────────
function onWdGo(msg) {
  showPhase('game');
  round = { active: true, mode: msg.mode, totalRounds: msg.totalRounds, roundNum: msg.round, hardMode: msg.hardMode, isDaily: msg.isDaily };
  roundStartedAt = Date.now();
  buildGrid();
  buildKeyboard();
  $('diffBadge').textContent = msg.isDaily ? '📅 Daily' : `${{easy:'🟢',normal:'🟡',hard:'🔴',expert:'💀'}[msg.difficulty]||''} ${cap(msg.difficulty)}`;
  $('roundIndicator').textContent = msg.mode === 'race' ? `Round ${msg.round + 1} / ${msg.totalRounds}` : '';
  renderRoundDots(matchWinsTally);
  $('opponentPanel').style.display = msg.mode === 'race' ? '' : 'none';
  if (msg.mode === 'race') { buildOppGrid(); $('oppGuesses').textContent = '0 guesses used'; $('oppStatus').textContent = ''; $('oppStatus').className = 'wd-opp-status'; $('opponentPanel').classList.remove('flash'); }
}
function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }
function renderRoundDots(roundWins) {
  const el = $('roundDots');
  el.innerHTML = '';
  if (!round.totalRounds) return;
  const mine = roundWins?.[myId] || 0;
  const oppId = [...players.keys()].find(pid => pid !== myId);
  const theirs = oppId ? (roundWins?.[oppId] || 0) : 0;
  for (let i = 0; i < round.totalRounds; i++) {
    const d = document.createElement('span');
    if (i < mine) d.classList.add('won');
    else if (i < mine + theirs) d.classList.add('lost');
    el.appendChild(d);
  }
}
function buildOppGrid() {
  const el = $('oppGrid');
  el.innerHTML = '';
  for (let r = 0; r < 6; r++) {
    const row = document.createElement('div');
    row.className = 'wd-opp-row';
    for (let c = 0; c < 5; c++) {
      const t = document.createElement('div');
      t.className = 'wd-opp-tile';
      row.appendChild(t);
    }
    el.appendChild(row);
  }
}

// ── Guess result (flip animation) ────────────────────────────────
function applyGuessResult(msg) {
  const row = $('row' + curRow);
  const tiles = [...row.children];
  msg.feedback.forEach((f, i) => {
    setTimeout(() => {
      tiles[i].classList.add('flip');
      setTimeout(() => {
        tiles[i].classList.remove('filled');
        tiles[i].classList.add(f.state);
        if (f.state === 'correct') { tiles[i].classList.add('bounce'); setTimeout(() => tiles[i].classList.remove('bounce'), 400); }
      }, 250);
    }, i * 100);
  });
  updateKeyboard(msg.feedback);
  const totalFlipMs = 100 * 4 + 500;
  setTimeout(() => {
    curRow++; curGuess = '';
    if (msg.gameOver) {
      round.active = false;
      if (msg.solved) winSequence();
      if (round.mode === 'solo') { /* server sends wd-round-over right after */ }
    }
  }, totalFlipMs);
}
function winSequence() {
  const row = $('row' + curRow);
  [...row.children].forEach((t, i) => setTimeout(() => { t.classList.add('bounce'); }, i * 150));
}

// ── Results screens ──────────────────────────────────────────────
const WIN_MESSAGES = ['Genius!', 'Magnificent!', 'Impressive!', 'Splendid!', 'Great!', 'Phew!'];
function showSoloResults(msg) {
  showPhase('results');
  $('btnBackHub').textContent = 'Back to Setup';
  $('btnBackHub').onclick = () => { showPhase('lobby'); updateHostUI(); };
  $('resultsHeader').textContent = msg.won ? WIN_MESSAGES[Math.max(0, msg.guessCount - 1)] : '💀 Out of guesses';
  $('resultsWord').textContent = msg.word.toUpperCase();
  $('resultsStats').innerHTML = msg.won ? `<div>Solved in ${msg.guessCount} / 6 guesses</div>` : `<div>The word was: ${msg.word.toUpperCase()}</div>`;
  updateStatsAfterSolo(msg);
  if (msg.isDaily) {
    $('shareBlock').style.display = '';
    $('shareGrid').textContent = buildShareGrid(msg);
    $('btnPlayAgain').style.display = 'none';
  } else {
    $('shareBlock').style.display = 'none';
    $('btnPlayAgain').style.display = '';
  }
}
function buildShareGrid(msg) {
  const cb = loadColorBlind();
  const gsq = cb ? '🟧' : '🟩', ysq = cb ? '🟦' : '🟨', bsq = '⬛';
  const lines = msg.feedbacks.map(fb => fb.map(f => f.state === 'correct' ? gsq : f.state === 'present' ? ysq : bsq).join(''));
  return `Wordle (Game Arena) — ${todayStr()} — ${msg.won ? msg.guessCount : 'X'}/6\n\n${lines.join('\n')}`;
}
$('btnCopyShare').addEventListener('click', () => {
  navigator.clipboard?.writeText($('shareGrid').textContent).then(() => { $('btnCopyShare').textContent = '✅ Copied!'; setTimeout(() => { $('btnCopyShare').textContent = '📋 Copy Result'; }, 2000); });
});

function updateStatsAfterSolo(msg) {
  const s = loadSave();
  if (msg.isDaily) {
    s.daily.lastPlayed = todayStr();
    s.daily.streak = msg.won ? (s.daily.streak || 0) + 1 : 0;
    s.daily.bestStreak = Math.max(s.daily.bestStreak || 0, s.daily.streak);
    s.daily.history.push({ date: todayStr(), guesses: msg.guessCount, won: msg.won });
    if (s.daily.history.length > 100) s.daily.history.shift();
  } else {
    const d = s.solo[config.difficulty] || soloDiffDefault();
    d.played++;
    if (msg.won) {
      d.won++; d.currentStreak++; d.bestStreak = Math.max(d.bestStreak, d.currentStreak);
      d.distribution[msg.guessCount - 1] = (d.distribution[msg.guessCount - 1] || 0) + 1;
      const totalGuesses = d.distribution.reduce((sum, c, i) => sum + c * (i + 1), 0);
      d.avgGuesses = totalGuesses / d.won;
    } else { d.currentStreak = 0; }
    d.totalTimeMs = (d.totalTimeMs || 0) + (Date.now() - roundStartedAt);
    s.solo[config.difficulty] = d;
    s.seenWords = s.seenWords || [];
    s.seenWords.unshift(msg.word);
    s.seenWords = [...new Set(s.seenWords)].slice(0, 200);
    if (msg.won) reportScore('wordle', 1);
  }
  saveSave(s);
  renderSidebarStats();
  refreshDailyStatus();
}

function showMatchOver(msg) {
  showPhase('matchover');
  const won = msg.matchWinnerId === myId;
  $('matchHeader').textContent = msg.matchWinnerId === null ? "🤝 It's a Draw!" : (won ? '🏆 You Win the Match!' : '😔 You Lost the Match');
  const rows = [];
  for (const [pid, wins] of Object.entries(msg.roundWins || {})) {
    const p = players.get(pid);
    rows.push(`<div class="wd-match-score-row"><span>${pid === myId ? 'You' : (p?.name || '?')}</span><span>${wins} rounds won</span></div>`);
  }
  $('matchScores').innerHTML = rows.join('');
  const s = loadSave();
  s.pvp.matchesPlayed++;
  if (won) { s.pvp.matchesWon++; reportScore('wordle', 1); }
  saveSave(s);
  renderSidebarStats();
}

$('btnPlayAgain').addEventListener('click', () => { showPhase('game'); wsSend({ type: 'wd-next' }); });
$('btnBackHub').addEventListener('click', () => { showPhase('lobby'); updateHostUI(); });
$('btnRematch').addEventListener('click', () => { showPhase('lobby'); updateHostUI(); });
$('btnLobbyReturn').addEventListener('click', () => { location.href = '/'; });

// ── Full stats screen ────────────────────────────────────────────
$('btnFullStats').addEventListener('click', () => { renderFullStats(); showPhase('stats'); });
$('btnCloseStats').addEventListener('click', () => { showPhase('lobby'); updateHostUI(); });
function renderFullStats() {
  const s = loadSave();
  let played = 0, won = 0, dist = [0,0,0,0,0,0];
  for (const d of ['easy','normal','hard','expert']) {
    played += s.solo[d].played; won += s.solo[d].won;
    s.solo[d].distribution.forEach((c, i) => dist[i] += c);
  }
  $('statsGrid').innerHTML = `
    <div class="cell"><b>${played > 0 ? Math.round(won/played*100) : 0}%</b>Win Rate</div>
    <div class="cell"><b>${s.daily.streak || 0} 🔥</b>Daily Streak</div>
    <div class="cell"><b>${s.daily.bestStreak || 0}</b>Best Daily Streak</div>
    <div class="cell"><b>${played}</b>Solo Games</div>
    <div class="cell"><b>${s.pvp.matchesWon}/${s.pvp.matchesPlayed}</b>PvP Matches Won</div>
    <div class="cell"><b>${won}</b>Solo Wins</div>`;
  const max = Math.max(1, ...dist);
  const latest = s.solo[config.difficulty]?.distribution || [];
  $('distChart').innerHTML = dist.map((c, i) => `
    <div class="wd-dist-row"><span>${i+1}</span><div class="wd-dist-bar" style="width:${Math.max(24, c/max*220)}px">${c}</div></div>`).join('');
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
    statusEl.textContent = 'Disconnected. Returning to lobby…';
    setTimeout(() => { location.href = '/'; }, 3000);
  };
}

function handleMsg(msg) {
  switch (msg.type) {
    case 'room-joined': {
      myId = msg.myId; leaderId = msg.leaderId;
      players.set(myId, { name: myName });
      for (const p of msg.players) players.set(p.id, { name: p.name });
      renderPlayerList(); updateHostUI();
      statusEl.textContent = `Room ${roomId} · ${players.size} player(s)`;
      break;
    }
    case 'player-joined': {
      players.set(msg.id, { name: msg.name });
      leaderId = msg.leaderId;
      renderPlayerList(); updateHostUI();
      statusEl.textContent = `${msg.name} joined.`;
      break;
    }
    case 'player-left': {
      players.delete(msg.id);
      renderPlayerList(); updateHostUI();
      break;
    }
    case 'wd-lobby-config': {
      applyConfig(msg);
      break;
    }
    case 'wd-go': {
      onWdGo(msg);
      break;
    }
    case 'wd-guess-result': {
      applyGuessResult(msg);
      break;
    }
    case 'wd-opponent-update': {
      const rowIdx = msg.guessNumber - 1;
      const row = $('oppGrid').children[rowIdx];
      if (row) { [...row.children].forEach((t, i) => { if (msg.greenPositions[i]) t.classList.add('green'); }); }
      $('oppGuesses').textContent = `${msg.guessNumber} guesses used`;
      if (msg.solved) {
        $('opponentPanel').classList.add('flash');
        $('oppStatus').textContent = 'SOLVED ✓';
        $('oppStatus').className = 'wd-opp-status solved';
      } else if (msg.failed) {
        $('oppStatus').textContent = '✗ Failed';
        $('oppStatus').className = 'wd-opp-status failed';
      }
      break;
    }
    case 'wd-round-over': {
      if (msg.mode === 'solo') { showSoloResults(msg); break; }
      matchWinsTally = msg.roundWins || {};
      renderRoundDots(matchWinsTally);
      showPhase('results');
      const mine = msg.stats?.[myId];
      const theirs = Object.entries(msg.stats || {}).find(([pid]) => pid !== myId)?.[1];
      $('resultsHeader').textContent = msg.winnerId === null ? "🤝 Round Draw" : (msg.winnerId === myId ? '🎉 You Won the Round!' : 'Opponent Won the Round');
      $('resultsWord').textContent = msg.word.toUpperCase();
      $('shareBlock').style.display = 'none';
      $('resultsStats').innerHTML = mine ? `<div>Your guesses: ${mine.guesses}${mine.solved ? '' : ' (failed)'}</div><div>Opponent guesses: ${theirs?.guesses ?? '?'}${theirs?.solved ? '' : ' (failed)'}</div>` : '';
      $('btnPlayAgain').style.display = 'none';
      $('btnBackHub').textContent = 'Continue';
      $('btnBackHub').onclick = () => { showPhase('game'); $('btnPlayAgain').style.display = ''; $('btnBackHub').textContent = 'Back to Setup'; $('btnBackHub').onclick = () => { showPhase('lobby'); updateHostUI(); }; };
      break;
    }
    case 'wd-game-over': {
      showMatchOver(msg);
      break;
    }
    case 'wd-opponent-left': {
      if (phase !== 'lobby') showPhase('lobby');
      statusEl.textContent = 'Opponent disconnected.';
      updateHostUI(); renderPlayerList();
      break;
    }
    case 'error': {
      if (msg.hardModeViolation) shakeRow(true);
      else if (msg.msg === 'Not a word') shakeRow(false);
      else alert(msg.msg);
      break;
    }
  }
}

connect();
})();

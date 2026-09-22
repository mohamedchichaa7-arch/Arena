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

roomBadge.textContent = 'Room ' + roomId;
btnBack.addEventListener('click', () => { location.href = '/'; });
btnRules?.addEventListener('click', () => { rulesModal.style.display = 'flex'; });
btnCloseRules?.addEventListener('click', () => { rulesModal.style.display = 'none'; });
btnToggleSide?.addEventListener('click', () => { $('sidebar').classList.toggle('open'); });

// ── State ─────────────────────────────────────────────────────────
let ws = null, myId = null, leaderId = null;
const players = new Map();
let phase = 'lobby';
let config = { mode: 'solo', difficulty: 'easy', category: 'all', variants: { hiddenCategory: false, speedMode: false, blindMode: false, arabicMode: false } };
let round = { active: false, wordLength: 0, triesBudget: 0, breakdown: null, category: null, categoryIcon: '❓', hintsLeft: 0, mode: 'solo', role: null, totalRounds: null, roundNum: 0 };
let revealedChars = [];
let guessedLetters = new Set();
let wrongCount = 0;
let lastWrong = 0;
let roundStartTs = 0;
let speedTimer = null;
let roundWinsTally = {};

// ── localStorage stats (solo only) ─────────────────────────────────
const SAVE_KEY = 'hangman_save';
function loadStats() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || defaultStats(); } catch { return defaultStats(); }
}
function defaultStats() {
  return { solvedByDiff: {}, bestScoreByDiff: {}, streak: 0, bestStreak: 0, totalGames: 0, totalWins: 0, totalLosses: 0, failedLetters: {}, hardestWord: null };
}
function saveStats(s) { try { localStorage.setItem(SAVE_KEY, JSON.stringify(s)); } catch {} }
function renderStats() {
  const s = loadStats();
  $('statStreak').textContent = s.bestStreak || 0;
  const rate = s.totalGames > 0 ? Math.round((s.totalWins / s.totalGames) * 100) : 0;
  $('statWinRate').textContent = rate + '%';
  $('statGames').textContent = s.totalGames || 0;
}
renderStats();

// ── Setup UI wiring ─────────────────────────────────────────────────
function wirePillGroup(containerId, key, cb) {
  const el = $(containerId);
  el.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      el.querySelectorAll('button').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      cb(btn.dataset[key]);
    });
  });
}
wirePillGroup('modePicker', 'mode', v => { config.mode = v; syncConfig(); });
wirePillGroup('difficultyPicker', 'diff', v => { config.difficulty = v; syncConfig(); });
$('categoryPicker').querySelectorAll('button').forEach(btn => {
  btn.addEventListener('click', () => {
    $('categoryPicker').querySelectorAll('button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    config.category = btn.dataset.cat;
    syncConfig();
  });
});
['vHidden','vSpeed','vBlind','vArabic'].forEach(id => $(id).addEventListener('change', () => {
  config.variants = {
    hiddenCategory: $('vHidden').checked, speedMode: $('vSpeed').checked,
    blindMode: $('vBlind').checked, arabicMode: $('vArabic').checked,
  };
  syncConfig();
}));

function syncConfig() {
  if (!isHost()) return;
  wsSend({ type: 'hm-lobby-config', difficulty: config.difficulty, category: config.category, mode: config.mode, variants: config.variants });
}
function applyConfig(c) {
  config = c;
  document.querySelector(`#modePicker button[data-mode="${c.mode}"]`)?.click();
  document.querySelector(`#difficultyPicker button[data-diff="${c.difficulty}"]`)?.click();
  document.querySelector(`#categoryPicker button[data-cat="${c.category}"]`)?.click();
  $('vHidden').checked = !!c.variants?.hiddenCategory;
  $('vSpeed').checked = !!c.variants?.speedMode;
  $('vBlind').checked = !!c.variants?.blindMode;
  $('vArabic').checked = !!c.variants?.arabicMode;
}

function isHost() { return leaderId === myId; }

btnStart.addEventListener('click', () => {
  wsSend({ type: 'hm-start', mode: config.mode, difficulty: config.difficulty, category: config.category, variants: config.variants });
});

function updateHostUI() {
  const canStart = isHost();
  btnStart.style.display = canStart ? '' : 'none';
  $('lobbyHint').style.display = canStart ? 'none' : '';
  $('categoryPicker').querySelectorAll('button').forEach(b => b.disabled = !canStart);
  $('modePicker').querySelectorAll('button').forEach(b => b.disabled = !canStart);
  $('difficultyPicker').querySelectorAll('button').forEach(b => b.disabled = !canStart);
  ['vHidden','vSpeed','vBlind','vArabic'].forEach(id => $(id).disabled = !canStart);
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

// ── Phase switching ───────────────────────────────────────────────
const PHASES = ['lobby', 'game', 'results', 'matchover'];
function showPhase(p) {
  phase = p;
  PHASES.forEach(name => { const el = $('phase' + name); if (el) el.style.display = name === p ? '' : 'none'; });
}

// ── Keyboard ──────────────────────────────────────────────────────
const KB_ROWS = ['QWERTYUIOP', 'ASDFGHJKL', 'ZXCVBNM'];
function buildKeyboard() {
  const kb = $('keyboard');
  kb.innerHTML = '';
  KB_ROWS.forEach(row => {
    const rowEl = document.createElement('div');
    rowEl.className = 'hm-kb-row';
    row.split('').forEach(ch => {
      const btn = document.createElement('button');
      btn.className = 'hm-key';
      btn.textContent = ch;
      btn.dataset.letter = ch;
      btn.addEventListener('click', () => guessLetter(ch));
      rowEl.appendChild(btn);
    });
    kb.appendChild(rowEl);
  });
}
buildKeyboard();
document.addEventListener('keydown', e => {
  if (phase !== 'game' || !round.active) return;
  if (round.mode === 'host' && round.role === 'host') return;
  const ch = e.key.toUpperCase();
  if (/^[A-Z]$/.test(ch)) guessLetter(ch);
});
function guessLetter(letter) {
  if (!round.active || guessedLetters.has(letter)) return;
  if (round.mode === 'host' && round.role === 'host') return;
  wsSend({ type: 'hm-guess', letter });
}
function markKey(letter, correct) {
  const btn = document.querySelector(`.hm-key[data-letter="${letter}"]`);
  if (!btn) return;
  btn.classList.add(correct ? 'hm-correct' : 'hm-wrong');
  btn.disabled = true;
}

// ── Word display ──────────────────────────────────────────────────
function buildWordDisplay() {
  const wd = $('wordDisplay');
  wd.innerHTML = '';
  for (let i = 0; i < round.wordLength; i++) {
    const box = document.createElement('div');
    box.className = 'hm-letter-box';
    box.id = 'wl' + i;
    const fill = document.createElement('span');
    fill.className = 'hm-letter-fill';
    box.appendChild(fill);
    wd.appendChild(box);
  }
  $('lengthLabel').textContent = `${round.wordLength} letters`;
}
function revealPositions(positions, letter, animateStagger) {
  positions.forEach((pos, i) => {
    setTimeout(() => {
      const box = $('wl' + pos);
      if (!box) return;
      revealedChars[pos] = letter;
      box.querySelector('.hm-letter-fill').textContent = letter;
      box.classList.add('hm-filled', 'hm-flash-green');
      setTimeout(() => box.classList.remove('hm-flash-green'), 500);
    }, i * 80);
  });
}
function shakeWordDisplay() {
  const wd = $('wordDisplay');
  wd.classList.add('hm-shake-wrong');
  setTimeout(() => wd.classList.remove('hm-shake-wrong'), 400);
}

// ── Gallows ───────────────────────────────────────────────────────
const HM_STAGE_ORDER = ['pHead','pBody','pArmL','pArmR','pLegL','pLegR','pEyeL','pEyeR','pMouth','pHandL','pHandR','pFootL','pFootR','pHair','pTear'];
function resetGallows() {
  const figure = $('hmFigure');
  figure.classList.remove('hm-win', 'hm-lose');
  HM_STAGE_ORDER.forEach(id => $(id)?.classList.remove('hm-visible'));
  $('pHat')?.classList.remove('hm-visible');
  $('pEyeX').style.display = 'none';
  $('pEyeL').style.display = '';
  $('pEyeR').style.display = '';
  $('gallowsSvg').classList.remove('hm-shake', 'hm-sway');
  lastWrong = 0;
}
function updateGallows(wrong, triesBudget) {
  const frac = triesBudget > 0 ? wrong / triesBudget : 0;
  HM_STAGE_ORDER.forEach((id, i) => {
    const partFrac = (i + 1) / HM_STAGE_ORDER.length;
    if (frac >= partFrac) $(id)?.classList.add('hm-visible');
  });
  if (wrong > lastWrong) {
    const svg = $('gallowsSvg');
    svg.classList.remove('hm-shake'); void svg.offsetWidth; svg.classList.add('hm-shake');
  }
  lastWrong = wrong;
}
function gallowsWin() {
  $('hmFigure').classList.add('hm-win');
  setTimeout(() => $('pHat')?.classList.add('hm-visible'), 300);
}
function gallowsLose() {
  HM_STAGE_ORDER.forEach(id => $(id)?.classList.add('hm-visible'));
  $('hmFigure').classList.add('hm-lose');
  $('pEyeL').style.display = 'none';
  $('pEyeR').style.display = 'none';
  $('pEyeX').style.display = '';
  $('gallowsSvg').classList.add('hm-sway');
}

// ── Round setup from hm-go ─────────────────────────────────────────
function onHmGo(msg) {
  showPhase('game');
  round = {
    active: true, wordLength: msg.wordLength, triesBudget: msg.triesBudget, breakdown: msg.breakdown,
    category: msg.category, categoryIcon: msg.categoryIcon || '❓', hintsLeft: msg.hintsLeft || 0,
    mode: msg.mode, role: msg.role || null, totalRounds: msg.totalRounds, roundNum: msg.round,
  };
  revealedChars = new Array(msg.wordLength).fill(null);
  guessedLetters = new Set();
  wrongCount = 0;
  roundStartTs = Date.now();
  resetGallows();
  buildWordDisplay();
  document.querySelectorAll('.hm-key').forEach(k => { k.disabled = false; k.classList.remove('hm-correct', 'hm-wrong'); });

  $('roundIndicator').textContent = round.totalRounds ? `Round ${round.roundNum + 1} / ${round.totalRounds}` : `Word ${round.roundNum + 1}`;
  $('categoryBadge').textContent = round.category ? `Category: ${round.categoryIcon} ${cap(round.category)}` : 'Category: 🔒 Hidden';
  $('triesDisplay').textContent = `You have ${round.triesBudget} wrong guesses allowed`;
  $('breakdownPanel').innerHTML = round.breakdown ? `Word length: +${round.breakdown.base} base, Rare/uncommon letters: +${round.breakdown.bonus}, Repeated letters: -${round.breakdown.penalty}, Difficulty ×${round.breakdown.mult} = ${round.triesBudget} tries` : '';
  $('breakdownPanel').style.display = 'none';
  $('blindCover').style.display = msg.variants?.blindMode ? '' : 'none';
  $('hintsLeftBadge').textContent = round.hintsLeft;
  $('btnHintLetter').disabled = round.hintsLeft <= 0;
  $('btnHintWord').disabled = round.hintsLeft <= 0;

  $('opponentPanel').style.display = round.mode === 'race' ? '' : 'none';
  $('hostPanel').style.display = (round.mode === 'host' && round.role === 'host') ? '' : 'none';
  $('hostWordInputPanel').style.display = 'none';
  $('waitingForHostPanel').style.display = 'none';
  if (round.mode === 'host') {
    if (round.role === 'host') {
      $('hostWordView').textContent = '';
      $('hostKeyboardView').innerHTML = '';
      $('hostAutoMsg').textContent = '';
    }
  }
  if (round.mode === 'race') { $('oppBlanks').textContent = '_'.repeat(msg.wordLength); $('oppWrong').textContent = 'Wrong: 0'; $('oppBanner').style.display = 'none'; }

  $('guessTimerWrap').style.display = config.variants.speedMode && round.mode !== 'host' ? '' : 'none';
  if (config.variants.speedMode && round.mode !== 'host') startSpeedTimer();
  $('scoreLive').textContent = '';
}

function cap(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : ''; }

function startSpeedTimer() {
  clearInterval(speedTimer);
  let t = 10;
  $('guessTimer').textContent = t;
  speedTimer = setInterval(() => {
    t--;
    $('guessTimer').textContent = t;
    if (t <= 0) {
      const unguessed = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').filter(c => !guessedLetters.has(c));
      if (unguessed.length && round.active) guessLetter(unguessed[Math.floor(Math.random() * unguessed.length)]);
      t = 10;
    }
  }, 1000);
}
function stopSpeedTimer() { clearInterval(speedTimer); speedTimer = null; }

$('btnBreakdown').addEventListener('click', () => {
  const p = $('breakdownPanel');
  p.style.display = p.style.display === 'none' ? '' : 'none';
});
$('btnHintLetter').addEventListener('click', () => { wsSend({ type: 'hm-hint', hintType: 'letter' }); });
$('btnHintWord').addEventListener('click', () => { wsSend({ type: 'hm-hint', hintType: 'word' }); });

// ── Host word submission ────────────────────────────────────────────
$('btnSubmitHostWord').addEventListener('click', submitHostWord);
$('hostWordField').addEventListener('keydown', e => { if (e.key === 'Enter') submitHostWord(); });
function submitHostWord() {
  const w = $('hostWordField').value.toUpperCase().replace(/[^A-Z]/g, '');
  if (!w) return;
  wsSend({ type: 'hm-host-word', word: w });
  $('hostWordField').value = '';
}

$('btnTauntRedHerring').addEventListener('click', () => wsSend({ type: 'hm-taunt', taunt: 'redherring' }));
$('btnTauntTime').addEventListener('click', () => wsSend({ type: 'hm-taunt', taunt: 'time' }));

// ── Results screens ─────────────────────────────────────────────────
$('btnPlayAgain').addEventListener('click', () => {
  showPhase('game');
  wsSend({ type: 'hm-next' });
});
$('btnRematch').addEventListener('click', () => { showPhase('lobby'); updateHostUI(); });
$('btnLobbyReturn').addEventListener('click', () => { location.href = '/'; });

function showSoloResults(msg) {
  stopSpeedTimer();
  showPhase('results');
  $('btnPlayAgain').style.display = '';
  $('btnBackHub').textContent = 'Back to Setup';
  $('btnBackHub').onclick = () => { showPhase('lobby'); updateHostUI(); };
  $('resultsHeader').textContent = msg.won ? '🎉 You Won!' : '💀 You Lost';
  $('resultsWord').textContent = msg.word;
  $('resultsHint').textContent = msg.hint || '';
  $('resultsStars').textContent = msg.rating;
  $('resultsStats').innerHTML = `
    <div>Score: <b>${msg.score}</b></div>
    <div>Used ${msg.wrong} of ${msg.triesBudget} allowed guesses</div>`;
  updateStatsLocal(msg);
}
function updateStatsLocal(msg) {
  const s = loadStats();
  s.totalGames++;
  if (msg.won) {
    s.totalWins++; s.streak = (s.streak || 0) + 1;
    s.bestStreak = Math.max(s.bestStreak || 0, s.streak);
    s.solvedByDiff[config.difficulty] = (s.solvedByDiff[config.difficulty] || 0) + 1;
    s.bestScoreByDiff[config.difficulty] = Math.max(s.bestScoreByDiff[config.difficulty] || 0, msg.score);
    if (!s.hardestWord || msg.word.length > s.hardestWord.length) s.hardestWord = msg.word;
    reportScore('hangman', 1);
  } else {
    s.totalLosses++; s.streak = 0;
  }
  saveStats(s);
  renderStats();
}

function showMatchOver(msg) {
  showPhase('matchover');
  const won = msg.matchWinnerId === myId;
  $('matchHeader').textContent = msg.matchWinnerId === null ? "🤝 It's a Draw!" : (won ? '🏆 You Win the Match!' : '😔 You Lost the Match');
  const rows = [];
  for (const [pid, wins] of Object.entries(msg.roundWins || {})) {
    const p = players.get(pid);
    rows.push(`<div class="hm-match-score-row"><span>${pid === myId ? 'You' : (p?.name || '?')}</span><span>${wins} round wins · ${msg.scores?.[pid] || 0} pts</span></div>`);
  }
  $('matchScores').innerHTML = rows.join('');
  if (won) reportScore('hangman', 1);
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
    stopSpeedTimer();
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
    case 'hm-lobby-config': {
      applyConfig({ difficulty: msg.difficulty, category: msg.category, mode: msg.mode, variants: msg.variants });
      break;
    }
    case 'hm-go': {
      onHmGo(msg);
      break;
    }
    case 'hm-your-turn-to-host': {
      showPhase('game');
      $('hostWordInputPanel').style.display = '';
      $('waitingForHostPanel').style.display = 'none';
      $('roundIndicator').textContent = `Round ${msg.round} / ${msg.totalRounds} — You are hosting`;
      break;
    }
    case 'hm-waiting-for-host': {
      showPhase('game');
      $('waitingForHostPanel').style.display = '';
      $('hostWordInputPanel').style.display = 'none';
      $('waitingForHostMsg').textContent = `Waiting for ${msg.hostName} to pick a word…`;
      $('roundIndicator').textContent = `Round ${msg.round} / ${msg.totalRounds}`;
      break;
    }
    case 'hm-guess-result': {
      if (msg.letter) guessedLetters.add(msg.letter);
      wrongCount = msg.wrongCount;
      if (msg.correct) {
        if (msg.letter) markKey(msg.letter, true);
        revealPositions(msg.positions, msg.letter);
      } else {
        if (msg.letter) markKey(msg.letter, false);
        shakeWordDisplay();
      }
      updateGallows(wrongCount, round.triesBudget);
      $('triesDisplay').textContent = `${msg.triesLeft} wrong guesses left`;
      if (msg.wordComplete) {
        round.active = false;
        setTimeout(() => gallowsWin(), 200);
      } else if (msg.triesLeft <= 0) {
        round.active = false;
        gallowsLose();
      }
      break;
    }
    case 'hm-opponent-update': {
      $('oppBlanks').textContent = '_ '.repeat(msg.blanksRemaining).trim() || '(solved)';
      $('oppWrong').textContent = 'Wrong: ' + msg.wrongGuesses;
      if (msg.wordComplete) {
        $('oppBanner').style.display = '';
        $('oppBanner').textContent = 'THEY GOT IT!';
      }
      break;
    }
    case 'hm-host-view-update': {
      if (msg.letter) {
        const span = document.createElement('span');
        span.textContent = msg.letter;
        span.className = msg.correct ? 'hm-k-correct' : 'hm-k-wrong';
        $('hostKeyboardView').appendChild(span);
      }
      const wrongN = msg.wrongCount;
      $('hostAutoMsg').textContent = wrongN >= (round.triesBudget - 1) ? 'They\'re going to lose 😈' : (msg.wordComplete ? 'They got it... 😤' : '');
      break;
    }
    case 'hm-hint-result': {
      round.hintsLeft = msg.hintsLeft;
      $('hintsLeftBadge').textContent = round.hintsLeft;
      $('btnHintLetter').disabled = round.hintsLeft <= 0;
      $('btnHintWord').disabled = round.hintsLeft <= 0;
      if (msg.hintType === 'word') {
        alert('💡 Hint: ' + msg.hintText);
      } else if (msg.hintType === 'letter') {
        guessedLetters.add(msg.letter);
        markKey(msg.letter, true);
        revealPositions(msg.positions, msg.letter);
        if (msg.wordComplete) { round.active = false; setTimeout(() => gallowsWin(), 200); }
      }
      break;
    }
    case 'hm-taunt-applied': {
      const banner = document.createElement('div');
      banner.className = 'hm-taunt-warning';
      banner.textContent = msg.taunt === 'redherring' ? '😈 Host used a taunt — one key glows suspiciously!' : '⏱️ Host used Time Pressure — 30s to guess!';
      if (msg.taunt === 'time' && round.hintsLeft > 0) {
        const cancelBtn = document.createElement('button');
        cancelBtn.className = 'btn btn-sm';
        cancelBtn.style.marginLeft = '.6rem';
        cancelBtn.textContent = 'Cancel (1 hint)';
        cancelBtn.addEventListener('click', () => { wsSend({ type: 'hm-cancel-taunt' }); banner.remove(); });
        banner.appendChild(cancelBtn);
      }
      document.body.appendChild(banner);
      setTimeout(() => banner.remove(), msg.taunt === 'time' ? 30000 : 3000);
      if (msg.taunt === 'redherring' && msg.letter) {
        const btn = document.querySelector(`.hm-key[data-letter="${msg.letter}"]`);
        if (btn) { btn.classList.add('hm-glow'); setTimeout(() => btn.classList.remove('hm-glow'), 1200); }
      }
      break;
    }
    case 'hm-taunt-cancelled': {
      round.hintsLeft = msg.hintsLeft;
      $('hintsLeftBadge').textContent = round.hintsLeft;
      break;
    }
    case 'hm-round-over': {
      stopSpeedTimer();
      round.active = false;
      document.querySelectorAll('.hm-key').forEach(k => k.disabled = true);
      if (msg.mode === 'solo') { showSoloResults(msg); break; }
      roundWinsTally = msg.roundWins || {};
      const stats = msg.stats;
      const winnerId = msg.winnerId;
      showPhase('results');
      $('resultsHeader').textContent = winnerId === null ? "🤝 Round Draw" : (winnerId === myId ? '🎉 You Won the Round!' : 'Opponent Won the Round');
      $('resultsWord').textContent = msg.word;
      $('resultsHint').textContent = msg.hint || '';
      $('resultsStars').textContent = '';
      if (msg.mode === 'race' && stats) {
        const mine = stats[myId];
        $('resultsStats').innerHTML = mine ? `<div>Wrong guesses: ${mine.wrong}</div><div>Round score: ${mine.score}</div><div>Total score: ${mine.cumulativeScore}</div>` : '';
      } else if (msg.mode === 'host') {
        $('resultsStats').innerHTML = `<div>Guesser wrong guesses: ${msg.guesserWrong}</div>`;
      }
      $('btnPlayAgain').style.display = 'none';
      $('btnBackHub').textContent = 'Continue';
      $('btnBackHub').onclick = () => { showPhase('game'); $('btnPlayAgain').style.display = ''; };
      break;
    }
    case 'hm-game-over': {
      showMatchOver(msg);
      break;
    }
    case 'hm-opponent-left': {
      stopSpeedTimer();
      if (phase !== 'lobby') showPhase('lobby');
      statusEl.textContent = 'Opponent disconnected.';
      updateHostUI(); renderPlayerList();
      break;
    }
    case 'error': {
      alert(msg.msg);
      break;
    }
  }
}

connect();
})();

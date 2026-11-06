(() => {
'use strict';

// ── URL / session ─────────────────────────────────────────────
const params = new URLSearchParams(location.search);
const roomId = params.get('room');
const myName = sessionStorage.getItem('arena-name') || 'Player';
if (!roomId) { location.href = '/'; return; }
// Kept in memory only, so automatic reconnects to a private room still work
const roomPw = sessionStorage.getItem('arena-room-password') || undefined;
sessionStorage.removeItem('arena-room-password');

// ── DOM ───────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const statusEl = $('status');
const playerListEl = $('playerList');
const playerCountEl = $('playerCount');
const boardEl = $('board');
const boardWrap = $('boardWrap');
const ghostLayer = $('ghostLayer');
const setupTrayEl = $('setupTray');
const btnBluff = $('btnBluff');
const btnCall = $('btnCall');

$('roomBadge').textContent = 'Room ' + roomId;

// ── Constants ─────────────────────────────────────────────────
const TYPES = ['K', 'Q', 'R', 'B', 'N', 'P'];
const COUNTS = { K: 1, Q: 1, R: 2, B: 2, N: 2, P: 8 };
const GLYPH = { K: '\u265A', Q: '\u265B', R: '\u265C', B: '\u265D', N: '\u265E', P: '\u265F' };
const NAME = { K: 'King', Q: 'Queen', R: 'Rook', B: 'Bishop', N: 'Knight', P: 'Pawn' };
const COLOR_NAME = ['White', 'Black'];
const CLASSIC = ['R', 'N', 'B', 'Q', 'K', 'B', 'N', 'R', 'P', 'P', 'P', 'P', 'P', 'P', 'P', 'P'];
const TRAY_ORDER = ['K', 'Q', 'R', 'B', 'N', 'P'];
const FILES = 'abcdefgh';
const LAYOUT_KEY = 'cs-saved-layout';
const NOTES_KEY = 'cs-notes-' + roomId;
const RING_C = 2 * Math.PI * 26;

const sqName = s => FILES[s & 7] + ((s >> 3) + 1);
const glyphHtml = (t, c) => `<span class="g ${c === 0 ? 'w' : 'b'}">${GLYPH[t]}\uFE0E</span>`;
const esc = s => String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
const wait = ms => new Promise(r => setTimeout(r, ms));
const isHome = (c, sq) => (c === 0 ? sq < 16 : sq >= 48);
const secs = ms => Math.ceil(Math.max(0, ms) / 1000);

// ── Room state ────────────────────────────────────────────────
let ws = null, myId = null, leaderId = null;
const players = new Map();
let leaving = false, reconnecting = false, reconnectUntil = 0;

// ── Game state ────────────────────────────────────────────────
let config = { clock: 'untimed', callWindowSec: 15, enPassant: true, revealPromotions: false, startColor: 'random', drawMoves: 0 };
let phase = 'lobby';           // lobby | setup | play | over
let view = null, viewAt = 0;   // latest server view + performance.now() when it arrived
let myColor = 0;
let selected = -1;
let targets = new Map();       // sq -> 'legal'|'cap'|'ep'|'castle'|'bluff'|'bluff-cap'|'bluff-castle'
let bluffMode = false;
let moveInFlight = false, callSent = false, pickSent = false;
let skipFlipId = null;
let setupLayout = new Array(64).fill(null);
let setupSel = null;           // { kind:'tray', t } | { kind:'board', sq }
let syncTimer = null;
let notes = {}, notesGame = 0;
let result = null, resultHidden = false;
let rematch = { mine: false, theirs: false };
let oppDiscUntil = 0;
let lastCsAt = 0;
let lensOn = false, lens = null;

const isHost = () => leaderId === myId;
const since = () => performance.now() - viewAt;
const remain = ms => Math.max(0, ms - since());

// ── Basic UI wiring ───────────────────────────────────────────
$('btnBack').addEventListener('click', () => {
  if ((phase === 'setup' || phase === 'play') && !confirm('Leave the game? You forfeit if you don\'t return within 60 seconds.')) return;
  leaving = true;
  location.href = '/';
});
$('btnToggleSidebar').addEventListener('click', () => $('sidebar').classList.toggle('open'));
$('btnToggleRail').addEventListener('click', () => $('rail').classList.toggle('open'));
$('btnRules').addEventListener('click', () => showModal('rulesModal'));
$('btnCloseRules').addEventListener('click', () => hideModal('rulesModal'));

function showModal(id) { $(id).style.display = 'flex'; }
function hideModal(id) { $(id).style.display = 'none'; }
function showPhase(name) {
  $('phaseLobby').style.display = name === 'lobby' ? '' : 'none';
  $('phaseGame').style.display = name === 'game' ? '' : 'none';
}

let toastTimer = null;
function toast(text, ms = 2400) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

let bannerTimer = null;
function banner(cls, title, sub, ms) {
  const el = $('banner');
  el.hidden = true;
  void el.offsetWidth;
  el.className = 'cs-banner ' + cls;
  $('bannerTitle').textContent = title;
  $('bannerSub').textContent = sub || '';
  el.hidden = false;
  clearTimeout(bannerTimer);
  return new Promise(res => { bannerTimer = setTimeout(() => { el.hidden = true; res(); }, ms); });
}

let chipUntil = 0;
function showChip(text, cls) {
  const el = $('chip');
  el.textContent = text;
  el.className = 'cs-chip ' + (cls || '');
  el.hidden = false;
}
function hideChip(force) {
  if (!force && performance.now() < chipUntil) return;
  $('chip').hidden = true;
}
function flashChip(text, cls, ms) {
  showChip(text, cls);
  chipUntil = performance.now() + ms;
  setTimeout(() => hideChip(), ms + 20);
}

// ── Players ───────────────────────────────────────────────────
function renderPlayers() {
  playerListEl.innerHTML = '';
  playerCountEl.textContent = players.size;
  for (const [pid, p] of players) {
    const el = document.createElement('div');
    el.className = 'player-item' + (pid === myId ? ' is-me' : '');
    const ci = view && phase !== 'lobby' ? view.names.indexOf(p.name) : -1;
    el.innerHTML = (ci >= 0 ? `<span class="pdot ${ci === 0 ? 'w' : 'b'}"></span>` : '') + esc(p.name) + (pid === leaderId ? ' 👑' : '');
    playerListEl.appendChild(el);
  }
}

// ── Lobby settings ────────────────────────────────────────────
function renderLobby() {
  document.querySelectorAll('.cs-pills').forEach(group => {
    const key = group.dataset.key;
    group.querySelectorAll('button').forEach(b => {
      b.classList.toggle('active', String(config[key]) === b.dataset.val);
      b.disabled = !isHost();
    });
  });
  const btn = $('btnStart');
  btn.style.display = isHost() ? '' : 'none';
  btn.disabled = players.size < 2;
  $('lobbyHint').textContent = players.size < 2 ? 'Waiting for an opponent to join…'
    : isHost() ? 'Ready when you are.' : 'Waiting for the host to start…';
  if (phase === 'lobby') statusEl.textContent = `Room ${roomId} · ${players.size}/2 players`;
}

document.querySelectorAll('.cs-pills').forEach(group => {
  group.addEventListener('click', e => {
    const b = e.target.closest('button');
    if (!b || !isHost()) return;
    const key = group.dataset.key, raw = b.dataset.val;
    config[key] = key === 'callWindowSec' || key === 'drawMoves' ? Number(raw)
      : key === 'enPassant' || key === 'revealPromotions' ? raw === 'true' : raw;
    wsSend({ type: 'cs-config', config });
    renderLobby();
  });
});
$('btnStart').addEventListener('click', () => wsSend({ type: 'cs-start' }));

// ── Deduction notes (client-only) ─────────────────────────────
function loadNotes(gameNo) {
  notesGame = gameNo;
  notes = {};
  try {
    const s = JSON.parse(sessionStorage.getItem(NOTES_KEY) || 'null');
    if (s && s.gameNo === gameNo && s.notes && typeof s.notes === 'object') notes = s.notes;
  } catch {}
}
function saveNotes() {
  try { sessionStorage.setItem(NOTES_KEY, JSON.stringify({ gameNo: notesGame, notes })); } catch {}
}
function openNote(sq, id) {
  const pop = $('notePop');
  pop.innerHTML = TYPES.map(t => `<button data-t="${t}" title="${NAME[t]}" class="${notes[id] === t ? 'active' : ''}">${GLYPH[t]}\uFE0E</button>`).join('')
    + '<button class="clear" data-t="" title="Clear">✕</button>';
  pop.hidden = false;
  const r = sqEls[sq].getBoundingClientRect();
  const w = pop.offsetWidth, h = pop.offsetHeight;
  pop.style.left = Math.min(Math.max(8, r.left + r.width / 2 - w / 2), innerWidth - w - 8) + 'px';
  pop.style.top = (r.top - h - 6 < 8 ? r.bottom + 6 : r.top - h - 6) + 'px';
  pop.onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.t) notes[id] = b.dataset.t; else delete notes[id];
    saveNotes();
    closeNote();
    render({ animate: false });
  };
}
function closeNote() { $('notePop').hidden = true; }
document.addEventListener('pointerdown', e => {
  const pop = $('notePop');
  if (!pop.hidden && !pop.contains(e.target)) closeNote();
});

// ── Board construction ────────────────────────────────────────
const sqEls = new Array(64);
let boardOrient = -1;
function buildBoard() {
  boardEl.innerHTML = '';
  for (let i = 0; i < 64; i++) {
    const row = i >> 3, col = i & 7;
    const rank = myColor === 0 ? 7 - row : row;
    const file = myColor === 0 ? col : 7 - col;
    const sq = rank * 8 + file;
    const el = document.createElement('div');
    el.dataset.sq = sq;
    if (col === 0) el.insertAdjacentHTML('beforeend', `<span class="coord rank">${rank + 1}</span>`);
    if (row === 7) el.insertAdjacentHTML('beforeend', `<span class="coord file">${FILES[file]}</span>`);
    boardEl.appendChild(el);
    sqEls[sq] = el;
  }
  boardOrient = myColor;
}

function setupBoard() {
  const b = new Array(64).fill(null);
  for (let sq = 0; sq < 64; sq++) {
    if (setupLayout[sq]) b[sq] = { id: 's' + sq, c: myColor, t: setupLayout[sq], rv: false };
    else if (isHome(1 - myColor, sq)) b[sq] = { id: 'e' + sq, c: 1 - myColor, t: null, rv: false };
  }
  return b;
}

function pieceEl(p) {
  const el = document.createElement('div');
  el.dataset.id = p.id;
  let cls = 'pc ' + (p.c === 0 ? 'w' : 'b');
  if (p.t) {
    el.innerHTML = glyphHtml(p.t, p.c);
    if (p.c === myColor) { cls += ' own'; if (p.rv && phase !== 'over') cls += ' exposed'; }
    else { cls += ' enemy'; if (p.rv) cls += ' known'; else if (phase === 'over') cls += ' final-hidden'; }
  } else {
    cls += ' token';
    el.innerHTML = '<span class="q">?</span>';
    if (notes[p.id]) el.insertAdjacentHTML('beforeend', `<span class="note">${GLYPH[notes[p.id]]}\uFE0E</span>`);
  }
  el.className = cls;
  return el;
}

const MARK_CLASS = { legal: 'legal', cap: 'legal cap', ep: 'ep', castle: 'castle', bluff: 'bluff', 'bluff-cap': 'bluff cap', 'bluff-castle': 'bluff castle' };

// ── Rendering ─────────────────────────────────────────────────
function render(opts = {}) {
  if (phase === 'lobby' || !view) return;
  if (boardOrient !== myColor) buildBoard();
  const animate = opts.animate !== false;
  const prev = new Map();
  if (animate) {
    boardEl.querySelectorAll('.pc[data-id]').forEach(el => prev.set(el.dataset.id, {
      rect: el.getBoundingClientRect(), html: el.outerHTML, token: el.classList.contains('token'), c: el.classList.contains('w') ? 0 : 1,
    }));
  }
  const isSetup = phase === 'setup';
  const b = isSetup ? setupBoard() : view.board;
  const lm = !isSetup ? view.lastMove : null;
  const pd = phase === 'play' ? view.pending : null;
  const bp = phase === 'play' ? view.blindPick : null;
  const myPick = bp && bp.picker === myColor && !pickSent ? new Set(bp.tokens || []) : null;
  const editable = isSetup && canEditSetup();

  for (let sq = 0; sq < 64; sq++) {
    const el = sqEls[sq];
    el.querySelectorAll('.pc, .mark').forEach(n => n.remove());
    const cls = ['sq', (((sq >> 3) + (sq & 7)) & 1) ? 'light' : 'dark'];
    const p = b[sq];
    if (lm && (sq === lm.from || sq === lm.to)) cls.push('last');
    if (sq === selected) cls.push('sel');
    if (editable && isHome(myColor, sq)) cls.push('home', 'can');
    if (setupSel?.kind === 'board' && setupSel.sq === sq) cls.push('setup-sel');
    if (pd && pd.mover !== myColor && sq === pd.to) cls.push('suspect');
    if (myPick?.has(sq)) cls.push('pickable');
    if (bp && bp.picker !== myColor && p && p.c === myColor && !p.rv) cls.push('victim');
    if (targets.has(sq) || (p && p.c === myColor && canMove())) cls.push('can');
    el.className = cls.join(' ');
    if (p) el.appendChild(pieceEl(p));
    const k = targets.get(sq);
    if (k) {
      const m = document.createElement('div');
      m.className = 'mark ' + MARK_CLASS[k];
      el.appendChild(m);
    }
  }
  boardEl.classList.toggle('bluff-mode', phase === 'play' && bluffMode);
  hoverSq = null;
  if (!targets.size) hideChip();
  if (animate) runFlip(prev, opts.removed);
  skipFlipId = null;
  renderHud();
  renderLens();
}

function lensXY(sq) {
  const f = sq & 7, r = sq >> 3;
  return myColor === 0 ? [f + 0.5, 7.5 - r] : [7.5 - f, r + 0.5];
}
function lensArrow(from, to, color, width, dashed) {
  const [x1, y1] = lensXY(from), [x2, y2] = lensXY(to);
  const len = Math.hypot(x2 - x1, y2 - y1) || 1, ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  const head = color === 'p' ? 'lhP' : 'lhG', stroke = color === 'p' ? 'rgba(192,132,252,.85)' : color === 'g' ? 'rgba(52,211,153,.9)' : 'rgba(52,211,153,.42)';
  return `<line x1="${x1 + ux * 0.2}" y1="${y1 + uy * 0.2}" x2="${x2 - ux * 0.3}" y2="${y2 - uy * 0.3}" stroke="${stroke}" stroke-width="${width}" stroke-linecap="round"${dashed ? ' stroke-dasharray=".15 .12"' : ''} marker-end="url(#${head})"/>`;
}
function renderLens() {
  const svg = $('lensLayer'), pill = $('lensPill');
  if (!lensOn || !lens || phase !== 'play' || !view) { svg.innerHTML = ''; pill.hidden = true; return; }
  const sc = m => (m.score >= 50000 ? 'WIN' : m.score <= -50000 ? 'loses K' : (m.score >= 0 ? '+' : '') + m.score.toFixed(1));
  const mvTxt = m => (m.castle ? `O-O ${sqName(m.from)}⇄${sqName(m.to)}` : `${view.board[m.from]?.t || '?'} ${sqName(m.from)}→${sqName(m.to)}${m.capT ? '×' + m.capT : ''}`) + ' ' + sc(m);
  let g = '<defs>'
    + '<marker id="lhG" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3" markerHeight="3" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="rgba(52,211,153,.9)"/></marker>'
    + '<marker id="lhP" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="3" markerHeight="3" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="rgba(192,132,252,.9)"/></marker></defs>';
  const lines = [];
  if (lens.call !== null) lines.push(lens.call ? '<b class="bad">⚑ CALL</b>' : '<b class="ok">✓ no call</b>');
  if (lens.pick !== null) {
    const [cx, cy] = lensXY(lens.pick);
    g += `<circle cx="${cx}" cy="${cy}" r=".44" fill="none" stroke="rgba(251,191,36,.95)" stroke-width=".07"/>`;
    lines.push(`🎯 ${sqName(lens.pick)} ${lens.pickT}`);
  }
  lens.moves.slice().reverse().forEach((m, i, arr) => {
    const top = i === arr.length - 1;
    g += lensArrow(m.from, m.castle ? m.kTo : m.to, top ? 'g' : 'f', top ? 0.13 : 0.08, false);
  });
  if (lens.moves[0]) lines.push(mvTxt(lens.moves[0]));
  if (lens.bluff) {
    g += lensArrow(lens.bluff.from, lens.bluff.to, 'p', 0.08, true);
    lines.push(`<span class="bl">◇ ${view.board[lens.bluff.from]?.t || '?'} ${sqName(lens.bluff.from)}→${sqName(lens.bluff.to)}×${lens.bluff.capT} as ${lens.bluff.as}</span>`);
  }
  svg.innerHTML = g;
  pill.innerHTML = lines.join('<br>');
  pill.hidden = !lines.length;
}

const LENS_SEQ = 'mmmoo';
let lensBuf = '', lensAt = 0;
function lensTap(ch) {
  if (phase === 'lobby') return;
  const now = performance.now();
  if (now - lensAt > 1500) lensBuf = '';
  lensAt = now;
  lensBuf = (lensBuf + ch).slice(-LENS_SEQ.length);
  if (lensBuf === LENS_SEQ) { lensBuf = ''; wsSend({ type: 'cs-lens-toggle', on: !lensOn }); }
}
$('myDot').addEventListener('click', () => lensTap('m'));
$('oppDot').addEventListener('click', () => lensTap('o'));

function flashAt(rect) {
  const wr = boardWrap.getBoundingClientRect();
  const f = document.createElement('div');
  f.className = 'flash';
  f.style.left = (rect.left - wr.left) + 'px';
  f.style.top = (rect.top - wr.top) + 'px';
  f.style.width = rect.width + 'px';
  f.style.height = rect.height + 'px';
  ghostLayer.appendChild(f);
  setTimeout(() => f.remove(), 800);
}

function flipIn(el) {
  el.classList.add('flip');
  el.addEventListener('animationend', () => el.classList.remove('flip'), { once: true });
  flashAt(el.getBoundingClientRect());
}

// FLIP-animates moved pieces, flips newly revealed ones, and leaves a fading ghost for removed ones.
function runFlip(prev, removed) {
  const wr = boardWrap.getBoundingClientRect();
  const seen = new Set();
  boardEl.querySelectorAll('.pc[data-id]').forEach(el => {
    const id = el.dataset.id;
    seen.add(id);
    const old = prev.get(id);
    if (!old) return;
    const r1 = el.getBoundingClientRect();
    const dx = old.rect.left - r1.left, dy = old.rect.top - r1.top;
    if ((Math.abs(dx) > 1 || Math.abs(dy) > 1) && id !== skipFlipId) {
      el.style.zIndex = 6;
      el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 300, easing: 'cubic-bezier(.2,.8,.2,1)' })
        .onfinish = () => { el.style.zIndex = ''; };
    }
    if (old.token && !el.classList.contains('token')) flipIn(el);
  });
  for (const [id, old] of prev) {
    if (seen.has(id)) continue;
    const t = removed?.get(id);
    const g = document.createElement('div');
    g.className = 'ghost';
    g.style.left = (old.rect.left - wr.left) + 'px';
    g.style.top = (old.rect.top - wr.top) + 'px';
    g.style.width = old.rect.width + 'px';
    g.style.height = old.rect.height + 'px';
    g.innerHTML = t ? pieceEl({ id, c: old.c, t, rv: true }).outerHTML : old.html;
    const inner = g.firstElementChild;
    inner.style.inset = '0';
    ghostLayer.appendChild(g);
    if (t && old.token) { inner.classList.add('flip'); flashAt(old.rect); }
    g.animate(
      [{ opacity: 1, transform: 'scale(1)' }, { opacity: 1, transform: 'scale(1.05)', offset: t ? 0.65 : 0.2 }, { opacity: 0, transform: 'scale(.5)' }],
      { duration: t ? 1200 : 450, easing: 'ease-in' },
    ).onfinish = () => g.remove();
  }
}

function renderHud() {
  const isSetup = phase === 'setup', isPlay = phase === 'play', isOver = phase === 'over';
  const opp = 1 - myColor;
  $('myDot').classList.toggle('w', myColor === 0);
  $('myDot').classList.toggle('b', myColor !== 0);
  $('oppDot').classList.toggle('w', opp === 0);
  $('oppDot').classList.toggle('b', opp !== 0);
  $('myNameEl').textContent = (view.names?.[myColor] || myName) + ' (you)';
  $('oppName').textContent = view.names?.[opp] || 'Opponent';
  const trayHtml = c => (view.captured?.[c] || []).slice().sort((a, b) => TRAY_ORDER.indexOf(a) - TRAY_ORDER.indexOf(b)).map(t => glyphHtml(t, c)).join('');
  $('myTray').innerHTML = trayHtml(myColor);
  $('oppTray').innerHTML = trayHtml(opp);
  $('myBar').classList.toggle('active', isPlay && view.turn === myColor);
  $('oppBar').classList.toggle('active', isPlay && view.turn === opp);

  const oppTag = $('oppTag');
  oppTag.className = 'cs-tag';
  if (!view.connected?.[opp] && !isOver) { oppTag.textContent = 'disconnected'; oppTag.classList.add('bad'); }
  else if (isSetup) { oppTag.textContent = view.setup.ready[opp] ? '✔ ready' : 'arranging…'; }
  else oppTag.textContent = '';
  $('myTag').textContent = isSetup && view.setup.ready[myColor] ? '✔ ready' : '';

  $('setupPanel').hidden = !isSetup;
  $('rail').hidden = isSetup;
  $('playControls').hidden = !isPlay;
  if (isSetup) renderSetupPanel();

  btnBluff.classList.toggle('on', bluffMode);
  btnBluff.setAttribute('aria-pressed', String(bluffMode));
  const pd = view.pending;
  btnCall.hidden = !(isPlay && pd && pd.mover !== myColor && !pd.kingCapture && !view.paused && !view.blindPick);
  btnCall.disabled = callSent;
  $('btnDraw').disabled = !isPlay || view.drawOffer !== null || view.paused;
  $('btnDraw').textContent = view.drawOffer === myColor ? '½ Offered…' : '½ Offer Draw';
  $('noCapInfo').textContent = view.config?.drawMoves ? `No-capture: ${Math.floor(view.noCapture / 2)}/${view.config.drawMoves}` : '';

  const kingVisible = isPlay && pd?.kingCapture && pd.mover !== myColor && !view.paused;
  if (kingVisible) {
    $('kingIcon').innerHTML = glyphHtml('K', myColor);
    $('btnKingCall').disabled = callSent;
    showModal('kingModal');
  } else hideModal('kingModal');
  if (isPlay && view.drawOffer === opp && !view.paused) showModal('drawModal'); else hideModal('drawModal');
  $('btnShowResult').hidden = !(isOver && result && resultHidden);

  renderRemaining();
  renderLog();
  renderPlayers();
  renderTimers();
}

function renderSetupPanel() {
  const left = remainingCounts();
  setupTrayEl.innerHTML = TRAY_ORDER.map(t => {
    const n = left[t];
    const cls = 'cs-tray-btn' + (n <= 0 ? ' empty' : '') + (setupSel?.kind === 'tray' && setupSel.t === t ? ' active' : '');
    return `<button class="${cls}" data-t="${t}" title="${NAME[t]}">${glyphHtml(t, myColor)}<small>×${n}</small></button>`;
  }).join('');
  const editable = canEditSetup();
  ['btnRandomize', 'btnClassic', 'btnLoadLayout', 'btnClear'].forEach(id => { $(id).disabled = !editable; });
  $('btnSaveLayout').disabled = placedCount() !== 16;
  $('btnReady').disabled = !editable || placedCount() !== 16;
  $('btnReady').textContent = view.setup.ready[myColor] ? '✔ Locked in' : '✔ Ready';
  $('setupStatus').textContent = view.setup.ready[myColor]
    ? (view.setup.ready[1 - myColor] ? 'Both players ready!' : 'Locked in. Waiting for your opponent…')
    : `${placedCount()}/16 placed. Drag pieces from the tray, or click a piece then a square. Unplaced pieces are randomized when time runs out.`;
}

function renderRemaining() {
  const enemy = 1 - myColor;
  if (phase === 'setup') {
    $('remainingList').innerHTML = TYPES.map(t => `<div class="rm-item"><span class="g ${enemy === 0 ? 'w' : 'b'}">${GLYPH[t]}\uFE0E</span><b>${COUNTS[t]}</b></div>`).join('');
    $('hiddenCount').textContent = '16 hidden tokens';
    return;
  }
  const left = { ...COUNTS };
  for (const t of view.captured[enemy]) left[t]--;
  let hidden = 0;
  view.board.forEach(p => {
    if (!p || p.c !== enemy) return;
    // At game end every type is visible, so only count what was actually revealed during play
    if (phase === 'over' ? p.rv : p.t) left[p.t]--;
    else hidden++;
  });
  $('remainingList').innerHTML = TYPES.map(t => {
    const n = Math.max(0, left[t]);
    return `<div class="rm-item${n ? '' : ' zero'}" title="${NAME[t]}"><span class="g ${enemy === 0 ? 'w' : 'b'}">${GLYPH[t]}\uFE0E</span><b>${n}</b></div>`;
  }).join('');
  $('hiddenCount').textContent = phase === 'over'
    ? `${hidden} piece${hidden === 1 ? ' was' : 's were'} never revealed`
    : `${hidden} hidden token${hidden === 1 ? '' : 's'} on the board`;
}

function logLine(e) {
  const who = c => (c === myColor ? 'You' : 'Opponent');
  if (e.kind === 'move') {
    const nm = t => (t ? NAME[t] : 'Token');
    let txt = e.castle
      ? `Castle: ${nm(e.t)} ${sqName(e.from)}→${sqName(e.to)}, ${nm(e.castle.rt)} ${sqName(e.castle.rFrom)}→${sqName(e.castle.rTo)}`
      : `${nm(e.t)} ${sqName(e.from)}→${sqName(e.to)}`;
    if (e.cap) txt += ` ×${NAME[e.cap.t]}`;
    if (e.promo) txt += ` =${NAME[e.promo]}`;
    let badges = '';
    if (e.bluff) badges += '<span class="bdg bluff">bluff</span>';
    if (e.called === 'caught') badges += '<span class="bdg caught">caught</span>';
    if (e.called === 'legal') badges += '<span class="bdg legal">called · legal</span>';
    return `<div class="le ${e.c === myColor ? 'mine' : 'theirs'}"><span class="n">${Math.ceil(e.n / 2)}${e.c === 0 ? '.' : '…'}</span><span class="dot c${e.c}"></span><span>${txt}</span>${badges}</div>`;
  }
  if (e.kind === 'call') {
    return e.outcome === 'caught'
      ? `<div class="le call">⚠ ${who(e.c)} called bluff: ${NAME[e.t]} revealed (illegal). It was removed.</div>`
      : `<div class="le call false">⚠ ${who(e.c)} called bluff: ${NAME[e.t]} revealed (legal). ${e.c === myColor ? 'You lost' : 'They lost'} a random piece.</div>`;
  }
  if (e.kind === 'pick') {
    const what = e.c === myColor ? `You removed a random enemy token: ${NAME[e.t]}` : `Opponent removed one of your pieces: ${NAME[e.t]}`;
    return `<div class="le pick">🎲 ${what}${e.auto ? ' (auto)' : ''}${e.lucky ? ' (LUCKY GUESS!)' : ''}</div>`;
  }
  if (e.kind === 'end') {
    const w = e.winner === null ? 'Draw' : e.winner === myColor ? 'You win' : 'Opponent wins';
    return `<div class="le end">${w}: ${reasonShort(e.reason)}</div>`;
  }
  return `<div class="le sys">${esc(e.text || '')}</div>`;
}

function renderLog() {
  const el = $('moveLog');
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  el.innerHTML = (view.log || []).map(logLine).join('');
  if (atBottom) el.scrollTop = el.scrollHeight;
}

function fmtClock(ms) {
  if (ms < 10000) return (Math.max(0, ms) / 1000).toFixed(1);
  const s = Math.ceil(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}

function computeStatus() {
  if (reconnecting) return 'Connection lost. Reconnecting…';
  if (phase === 'setup') {
    const r = view.setup.ready;
    if (r[myColor]) return r[1 - myColor] ? 'Both ready!' : 'Locked in. Waiting for your opponent…';
    return `Setup: you play ${COLOR_NAME[myColor]}. ${placedCount()}/16 placed${r[1 - myColor] ? '. Opponent is ready!' : ''}`;
  }
  if (phase === 'over') return result ? reasonText(result) : 'Game over';
  if (view.paused) return 'Game paused: opponent disconnected.';
  const pd = view.pending, bp = view.blindPick;
  if (bp) return bp.picker === myColor ? 'False accusation! Pick one enemy token to remove.' : 'Your call was wrong. Your opponent is picking one of your pieces blind…';
  if (pd?.kingCapture) return pd.mover === myColor ? 'You took their King! Waiting to see if they call your bluff…' : 'Your King was captured! Call the bluff or accept defeat.';
  if (view.turn === myColor) {
    if (moveInFlight) return 'Sending move…';
    const noLegal = !Object.keys(view.legal || {}).length && !(view.castles || []).length && !(view.epMaybe || []).length;
    const call = pd && pd.mover !== myColor ? ` Moving accepts their last move. Call bluff (${secs(remain(pd.remainingMs))}s)?` : '';
    if (noLegal) return 'Your move. You have no legal moves, so turn on Bluff Mode.' + call;
    return (bluffMode ? 'Your move (BLUFF MODE).' : 'Your move.') + call;
  }
  if (pd && pd.mover === myColor) return `Opponent may call your bluff… (${secs(remain(pd.remainingMs))}s)`;
  return 'Opponent is thinking…';
}

function computeBoardMsg() {
  if (reconnecting) return { html: '<b>CONNECTION LOST</b><br>Reconnecting…', cls: 'center bad' };
  if (phase !== 'over' && (view.paused || oppDiscUntil)) {
    const s = oppDiscUntil ? ` They have ${secs(oppDiscUntil - performance.now())}s to return or forfeit.` : '';
    return { html: `<b>OPPONENT DISCONNECTED</b><br>Game paused.${s}`, cls: 'center bad' };
  }
  if (phase === 'play' && view.blindPick) {
    const s = secs(remain(view.blindPick.remainingMs));
    return view.blindPick.picker === myColor
      ? { html: `<b>BLIND PICK</b>: choose one glowing enemy token to remove (${s}s)`, cls: 'gold' }
      : { html: `<b>BLIND PICK</b>: opponent is choosing one of your pieces… (${s}s)`, cls: 'gold' };
  }
  if (phase === 'setup' && view.setup.ready[myColor] && !view.setup.ready[1 - myColor]) return { html: 'Waiting for your opponent to finish setup…', cls: 'center' };
  return null;
}

function renderTimers() {
  if (!view || phase === 'lobby') return;
  const opp = 1 - myColor;
  const setClock = (el, c) => {
    if (!view.clocks) { el.textContent = ''; return; }
    const ms = view.clocks[c] - (view.running === c ? since() : 0);
    el.textContent = fmtClock(ms);
    el.className = 'cs-clock' + (view.running === c ? ' running' : '') + (ms < 20000 ? ' low' : '');
  };
  setClock($('myClock'), myColor);
  setClock($('oppClock'), opp);

  if (phase === 'setup') {
    const s = secs(remain(view.setup.remainingMs));
    $('setupTimer').textContent = view.paused ? '⏸' : s + 's';
    $('setupTimer').classList.toggle('low', s <= 10);
  }
  const pd = view.pending;
  if (pd && phase === 'play') {
    const total = (view.config.callWindowSec || 15) * 1000;
    const left = view.paused ? pd.remainingMs : remain(pd.remainingMs);
    if (!btnCall.hidden) {
      $('callSecs').textContent = secs(left);
      $('callRing').style.strokeDashoffset = String(RING_C * (1 - left / total));
      if (left <= 0) btnCall.hidden = true;
    }
    if (pd.kingCapture) $('kingTimer').textContent = secs(left) + 's';
  }
  statusEl.textContent = computeStatus();
  const bm = computeBoardMsg(), msgEl = $('boardMsg');
  if (bm) { msgEl.innerHTML = bm.html; msgEl.className = 'cs-board-msg ' + bm.cls; msgEl.hidden = false; }
  else msgEl.hidden = true;
}
setInterval(renderTimers, 100);

// ── Move targets ──────────────────────────────────────────────
function canMove() {
  return phase === 'play' && !!view && view.turn === myColor && !view.blindPick && !view.pending?.kingCapture
    && !view.paused && !moveInFlight && !reconnecting;
}

// Mirrors server castling geometry using public occupancy only
function castleGeom(k, s) {
  const b = view.board;
  if (!b[k] || !b[s] || b[k].c !== b[s].c || k === s || (k >> 3) !== (s >> 3)) return false;
  const dir = (s & 7) > (k & 7) ? 1 : -1;
  const kf = (k & 7) + 2 * dir;
  if (kf < 0 || kf > 7) return false;
  const rookTo = k + dir, kingTo = k + 2 * dir;
  return !((b[rookTo] && rookTo !== s) || (b[kingTo] && kingTo !== s));
}

function computeTargets() {
  targets = new Map();
  if (selected < 0 || !canMove()) return;
  const from = selected, p = view.board[from];
  if (!p || p.c !== myColor) return;
  for (const s of view.legal?.[from] || []) targets.set(s, view.board[s] ? 'cap' : 'legal');
  for (const e of view.epMaybe || []) if (e.from === from) targets.set(e.to, 'ep');
  for (const c of view.castles || []) if (c.from === from) targets.set(c.to, 'castle');
  if (!bluffMode) return;
  for (let s = 0; s < 64; s++) {
    if (s === from || targets.has(s)) continue;
    const x = view.board[s];
    if (x && x.c === myColor) {
      if (p.t === 'K' && castleGeom(from, s)) targets.set(s, 'bluff-castle');
      continue;
    }
    targets.set(s, x ? 'bluff-cap' : 'bluff');
  }
}

let hoverSq = null;
function hoverSquare(sq) {
  if (sq === hoverSq) return;
  if (hoverSq !== null) sqEls[hoverSq]?.classList.remove('hover');
  hoverSq = sq;
  if (sq !== null) sqEls[sq]?.classList.add('hover');
  const k = sq !== null ? targets.get(sq) : null;
  if (k === 'bluff-castle') showChip('⚠ Illegal castle: you\'re bluffing', 'warn');
  else if (k && k.startsWith('bluff')) showChip('⚠ Illegal move: you\'re bluffing', 'warn');
  else if (k === 'ep') showChip('En passant: legal only if that token is really a pawn', 'ep');
  else hideChip();
}

function attemptMove(from, to, kind, viaDrag) {
  const p = view.board[from];
  const castle = kind === 'castle' || kind === 'bluff-castle';
  const go = promotion => {
    wsSend({ type: 'cs-move-submit', from, to, castle, promotion });
    moveInFlight = true;
    if (viaDrag) skipFlipId = String(p.id);
    selected = -1;
    computeTargets();
    hideChip(true);
    if (kind.startsWith('bluff')) flashChip('Bluff played. Fingers crossed…', 'warn', 1800);
    else if (kind === 'ep') flashChip('En passant gamble: legal only if that token is a pawn', 'ep', 1800);
    render({ animate: false });
  };
  if (!castle && p.t === 'P' && (to >> 3) === (myColor === 0 ? 7 : 0)) openPromo(go);
  else go(undefined);
}

function openPromo(cb) {
  const box = $('promoBtns');
  box.innerHTML = ['Q', 'R', 'B', 'N'].map(t => `<button data-t="${t}" title="${NAME[t]}">${glyphHtml(t, myColor)}</button>`).join('');
  showModal('promoModal');
  box.onclick = e => {
    const b = e.target.closest('button');
    if (!b) return;
    hideModal('promoModal');
    cb(b.dataset.t);
  };
  $('promoModal').onclick = e => {
    if (e.target.id !== 'promoModal') return;
    hideModal('promoModal');
    selected = -1;
    computeTargets();
    render({ animate: false });
  };
}

// ── Setup ─────────────────────────────────────────────────────
function placedCount() { return setupLayout.filter(Boolean).length; }
function remainingCounts() {
  const left = { ...COUNTS };
  for (const t of setupLayout) if (t) left[t]--;
  return left;
}
function canEditSetup() { return phase === 'setup' && !!view && !view.setup.ready[myColor] && !view.paused && !reconnecting; }
function homeSquares(c) {
  const back = c === 0 ? 0 : 7, front = c === 0 ? 1 : 6, out = [];
  for (let f = 0; f < 8; f++) out.push(back * 8 + f);
  for (let f = 0; f < 8; f++) out.push(front * 8 + f);
  return out;
}
// Layouts are stored relative to the owner (back rank a-h, then front rank a-h) so they work for both colors
function applyRel(rel) {
  setupLayout = new Array(64).fill(null);
  homeSquares(myColor).forEach((sq, i) => { setupLayout[sq] = rel[i]; });
}
function toRel() { return homeSquares(myColor).map(sq => setupLayout[sq]); }
function validRel(rel) {
  if (!Array.isArray(rel) || rel.length !== 16) return false;
  const c = {};
  for (const t of rel) { if (!TYPES.includes(t)) return false; c[t] = (c[t] || 0) + 1; }
  return TYPES.every(t => c[t] === COUNTS[t]);
}
function shuffled(a) {
  const r = a.slice();
  for (let i = r.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [r[i], r[j]] = [r[j], r[i]]; }
  return r;
}
function setupChanged() {
  render({ animate: false });
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncPlacement, 250);
}
function placementList() {
  const out = [];
  setupLayout.forEach((t, sq) => { if (t) out.push({ sq, t }); });
  return out;
}
function syncPlacement() {
  if (canEditSetup()) wsSend({ type: 'cs-placement-submit', placements: placementList(), confirm: false });
}
function placeType(t, sq) {
  if (setupLayout[sq] === t || remainingCounts()[t] <= 0) return;
  setupLayout[sq] = t;
}
function swapSquares(a, b) { [setupLayout[a], setupLayout[b]] = [setupLayout[b], setupLayout[a]]; }

function setupClick(sq) {
  if (!canEditSetup()) return;
  if (!isHome(myColor, sq)) { setupSel = null; setupChanged(); return; }
  if (setupSel?.kind === 'tray') {
    placeType(setupSel.t, sq);
    if (remainingCounts()[setupSel.t] <= 0) setupSel = null;
  } else if (setupSel?.kind === 'board') {
    if (setupSel.sq !== sq) swapSquares(setupSel.sq, sq);
    setupSel = null;
  } else if (setupLayout[sq]) {
    setupSel = { kind: 'board', sq };
  }
  setupChanged();
}
function trayClick(t) {
  if (!canEditSetup()) return;
  if (setupSel?.kind === 'board') { setupLayout[setupSel.sq] = null; setupSel = null; }
  else if (setupSel?.kind === 'tray' && setupSel.t === t) setupSel = null;
  else if (remainingCounts()[t] > 0) setupSel = { kind: 'tray', t };
  setupChanged();
}

$('btnRandomize').addEventListener('click', () => { if (!canEditSetup()) return; applyRel(shuffled(CLASSIC)); setupSel = null; setupChanged(); });
$('btnClassic').addEventListener('click', () => { if (!canEditSetup()) return; applyRel(CLASSIC); setupSel = null; setupChanged(); });
$('btnClear').addEventListener('click', () => { if (!canEditSetup()) return; setupLayout = new Array(64).fill(null); setupSel = null; setupChanged(); });
$('btnSaveLayout').addEventListener('click', () => {
  if (placedCount() !== 16) { toast('Place all 16 pieces before saving'); return; }
  try { localStorage.setItem(LAYOUT_KEY, JSON.stringify(toRel())); toast('Layout saved'); } catch { toast('Could not save layout'); }
});
$('btnLoadLayout').addEventListener('click', () => {
  if (!canEditSetup()) return;
  let rel = null;
  try { rel = JSON.parse(localStorage.getItem(LAYOUT_KEY) || 'null'); } catch {}
  if (!validRel(rel)) { toast('No saved layout yet'); return; }
  applyRel(rel);
  setupSel = null;
  setupChanged();
  toast('Layout loaded');
});
$('btnReady').addEventListener('click', () => {
  if (!canEditSetup() || placedCount() !== 16) return;
  clearTimeout(syncTimer);
  setupSel = null;
  wsSend({ type: 'cs-placement-submit', placements: placementList(), confirm: true });
});

// ── Play interactions ─────────────────────────────────────────
function playClick(sq) {
  const bp = view.blindPick;
  if (bp) {
    if (bp.picker === myColor && !pickSent && bp.tokens?.includes(sq)) confirmPick(sq);
    return;
  }
  const p = view.board[sq];
  if (selected >= 0 && targets.has(sq)) { attemptMove(selected, sq, targets.get(sq), false); return; }
  if (p && p.c === myColor && canMove()) {
    selected = selected === sq ? -1 : sq;
    computeTargets();
    render({ animate: false });
    return;
  }
  if (p && p.c !== myColor && !p.t) openNote(sq, p.id);
  if (selected >= 0) { selected = -1; computeTargets(); render({ animate: false }); }
}

function confirmPick(sq) {
  pickSent = true;
  render({ animate: false });
  sqEls[sq].classList.add('picking');
  wsSend({ type: 'cs-blind-pick', square: sq });
}

function onSquareClick(sq) {
  if (phase === 'setup') setupClick(sq);
  else if (phase === 'play') playClick(sq);
}

btnBluff.addEventListener('click', toggleBluff);
function toggleBluff() {
  if (phase !== 'play') return;
  bluffMode = !bluffMode;
  computeTargets();
  render({ animate: false });
  toast(bluffMode ? 'Bluff Mode ON: any destination allowed' : 'Bluff Mode OFF', 1200);
}
btnCall.addEventListener('click', sendCall);
$('btnKingCall').addEventListener('click', sendCall);
function sendCall() {
  if (callSent) return;
  callSent = true;
  // Block moves until the resolution arrives so nothing is computed against the pre-call board
  moveInFlight = true;
  selected = -1;
  computeTargets();
  render({ animate: false });
  wsSend({ type: 'cs-bluff-call' });
}
$('btnKingAccept').addEventListener('click', () => wsSend({ type: 'cs-accept-capture' }));
$('btnDraw').addEventListener('click', () => wsSend({ type: 'cs-draw-offer' }));
$('btnDrawAccept').addEventListener('click', () => { hideModal('drawModal'); wsSend({ type: 'cs-draw-accept' }); });
$('btnDrawDecline').addEventListener('click', () => { hideModal('drawModal'); wsSend({ type: 'cs-draw-decline' }); });
$('btnResign').addEventListener('click', () => { if (confirm('Resign this game?')) wsSend({ type: 'cs-resign' }); });

document.addEventListener('keydown', e => {
  if (e.key === 'b' || e.key === 'B') toggleBluff();
  else if (e.key === 'Escape') {
    closeNote();
    if (selected >= 0) { selected = -1; computeTargets(); render({ animate: false }); }
  }
});

// ── Pointer: click + drag for both board and setup tray ───────
let press = null;
function squareAt(x, y) {
  const el = document.elementFromPoint(x, y)?.closest?.('.sq');
  return el && boardEl.contains(el) ? Number(el.dataset.sq) : null;
}
function dragSourceAt(sq) {
  if (phase === 'setup') return canEditSetup() && setupLayout[sq] ? { kind: 'board', sq } : null;
  if (phase === 'play' && canMove() && view.board[sq]?.c === myColor) return { kind: 'board', sq };
  return null;
}
function startPress(e, sq, src, trayT) {
  press = { x: e.clientX, y: e.clientY, sq, src, trayT, pid: e.pointerId, dragging: false, ghost: null };
}
boardEl.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const el = e.target.closest('.sq');
  if (!el) return;
  e.preventDefault();
  const sq = Number(el.dataset.sq);
  startPress(e, sq, dragSourceAt(sq), null);
});
boardEl.addEventListener('contextmenu', e => {
  e.preventDefault();
  const el = e.target.closest('.sq');
  if (!el || phase !== 'play') return;
  const sq = Number(el.dataset.sq), p = view.board[sq];
  if (p && p.c !== myColor && !p.t) openNote(sq, p.id);
});
setupTrayEl.addEventListener('pointerdown', e => {
  const btn = e.target.closest('.cs-tray-btn');
  if (!btn || e.button !== 0) return;
  e.preventDefault();
  const t = btn.dataset.t;
  startPress(e, null, canEditSetup() && remainingCounts()[t] > 0 ? { kind: 'tray', t } : null, t);
});
// Keyboard activation produces a click with no pointer events (detail === 0)
setupTrayEl.addEventListener('click', e => {
  const btn = e.target.closest('.cs-tray-btn');
  if (btn && e.detail === 0) trayClick(btn.dataset.t);
});
function beginDrag() {
  press.dragging = true;
  const src = press.src;
  let t;
  if (src.kind === 'tray') t = src.t;
  else if (phase === 'setup') t = setupLayout[src.sq];
  else {
    t = view.board[src.sq].t;
    if (selected !== src.sq) { selected = src.sq; computeTargets(); render({ animate: false }); }
  }
  if (src.kind === 'board') sqEls[src.sq].querySelector('.pc')?.classList.add('dragging');
  const size = boardEl.getBoundingClientRect().width / 8;
  const g = document.createElement('div');
  g.className = 'drag-ghost';
  g.style.width = g.style.height = size + 'px';
  g.innerHTML = glyphHtml(t, myColor);
  document.body.appendChild(g);
  press.ghost = g;
}
function endDrag(p) {
  p.ghost?.remove();
  hoverSquare(null);
}
window.addEventListener('pointermove', e => {
  if (!press || e.pointerId !== press.pid) {
    if (phase === 'play' && selected >= 0) hoverSquare(squareAt(e.clientX, e.clientY));
    return;
  }
  if (!press.dragging) {
    if (!press.src || Math.hypot(e.clientX - press.x, e.clientY - press.y) < 6) return;
    beginDrag();
  }
  press.ghost.style.left = e.clientX + 'px';
  press.ghost.style.top = e.clientY + 'px';
  hoverSquare(squareAt(e.clientX, e.clientY));
});
window.addEventListener('pointerup', e => {
  if (!press || e.pointerId !== press.pid) return;
  const p = press;
  press = null;
  const sq = squareAt(e.clientX, e.clientY);
  if (p.dragging) { endDrag(p); onDrop(p.src, sq); }
  else if (p.trayT) trayClick(p.trayT);
  else if (sq !== null && sq === p.sq) onSquareClick(sq);
});
window.addEventListener('pointercancel', () => {
  if (press?.dragging) { endDrag(press); render({ animate: false }); }
  press = null;
});
function onDrop(src, sq) {
  if (phase === 'setup') {
    if (!canEditSetup()) { render({ animate: false }); return; }
    if (src.kind === 'tray') { if (sq !== null && isHome(myColor, sq)) placeType(src.t, sq); }
    else if (sq === null) setupLayout[src.sq] = null;
    else if (isHome(myColor, sq) && sq !== src.sq) swapSquares(src.sq, sq);
    setupSel = null;
    setupChanged();
    return;
  }
  if (phase === 'play') {
    const kind = sq !== null && selected === src.sq ? targets.get(sq) : null;
    if (kind) attemptMove(src.sq, sq, kind, true);
    else render({ animate: false });
  }
}

// ── Result ────────────────────────────────────────────────────
function reasonShort(reason) {
  return {
    king_captured: 'King captured', bluff_caught_king: 'King caught bluffing', lucky_guess: 'lucky guess',
    resign: 'resignation', timeout: 'timeout', disconnect: 'disconnect', agreement: 'agreement', no_capture: 'no-capture rule',
  }[reason] || reason;
}
function reasonText(r) {
  const won = r.winner === myColor;
  switch (r.reason) {
    case 'king_captured': return won ? 'You captured the enemy King.' : 'Your King was captured.';
    case 'bluff_caught_king': return won ? 'Their King was caught bluffing and removed.' : 'Your King was caught bluffing and removed.';
    case 'lucky_guess': return won ? 'Your blind pick found their King!' : 'Their blind pick found your King.';
    case 'resign': return won ? 'Your opponent resigned.' : 'You resigned.';
    case 'timeout': return won ? 'Your opponent ran out of time.' : 'You ran out of time.';
    case 'disconnect': return won ? 'Your opponent disconnected.' : 'You were disconnected for too long.';
    case 'agreement': return 'Draw by agreement.';
    case 'no_capture': return `Draw: no captures in ${view?.config?.drawMoves || ''} moves each.`;
    default: return 'Game over.';
  }
}
function fmtDuration(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + 'm ' + String(s % 60).padStart(2, '0') + 's';
}
function showResult() {
  if (!result) return;
  const r = result, me = myColor, opp = 1 - me;
  const titleEl = $('resultTitle');
  titleEl.textContent = r.winner === null ? 'DRAW' : r.winner === me ? 'VICTORY' : 'DEFEAT';
  titleEl.className = 'cs-result-title ' + (r.winner === null ? 'draw' : r.winner === me ? 'win' : 'lose');
  $('resultLucky').hidden = r.reason !== 'lucky_guess';
  $('resultReason').textContent = reasonText(r);
  $('resultMeta').textContent = `${r.moveCount} moves · ${fmtDuration(r.durationMs || 0)}`;
  const rows = [['Moves', 'moves'], ['Bluffs attempted', 'bluffs'], ['Bluffs caught', 'caught'], ['Bluff calls made', 'calls'], ['Correct calls', 'correctCalls'], ['False calls', 'falseCalls']];
  $('resultStats').innerHTML = `<tr><th></th><th>You</th><th>${esc(view?.names?.[opp] || 'Opponent')}</th></tr>`
    + rows.map(([label, k]) => `<tr><td>${label}</td><td>${r.stats?.[me]?.[k] ?? 0}</td><td>${r.stats?.[opp]?.[k] ?? 0}</td></tr>`).join('');
  resultHidden = false;
  updateResultButtons();
  showModal('resultModal');
  renderHud();
}
function updateResultButtons() {
  const btn = $('btnRematch');
  btn.disabled = rematch.mine || players.size < 2;
  btn.textContent = rematch.mine ? 'Waiting…' : rematch.theirs ? 'Accept Rematch' : 'Rematch';
  $('rematchHint').textContent = players.size < 2 ? 'Your opponent left the room.'
    : rematch.theirs && !rematch.mine ? 'Your opponent wants a rematch. Colors swap.'
    : rematch.mine ? 'Waiting for your opponent to accept…' : '';
}
$('btnRematch').addEventListener('click', () => {
  rematch.mine = true;
  updateResultButtons();
  wsSend({ type: 'cs-rematch-request' });
});
$('btnViewBoard').addEventListener('click', () => { hideModal('resultModal'); resultHidden = true; renderHud(); });
$('btnShowResult').addEventListener('click', showResult);
$('btnBackRoom').addEventListener('click', () => {
  hideModal('resultModal');
  phase = 'lobby';
  showPhase('lobby');
  renderLobby();
  renderPlayers();
});

// ── Server messages ───────────────────────────────────────────
function applyView(v, at, opts = {}) {
  view = v;
  viewAt = at || performance.now();
  lastCsAt = performance.now();
  myColor = v.color;
  if (v.gameNo !== notesGame) loadNotes(v.gameNo);
  phase = v.phase;
  moveInFlight = false;
  callSent = false;
  lens = null;
  if (!v.blindPick || v.blindPick.picker !== myColor) pickSent = false;
  if (!(selected >= 0 && canMove() && v.board[selected]?.c === myColor)) selected = -1;
  computeTargets();
  showPhase('game');
  render(opts);
}

let chain = Promise.resolve();
function queue(fn) { chain = chain.then(fn).catch(err => console.error(err)); }

async function handleCs(msg) {
  const at = msg._at;
  switch (msg.type) {
    case 'cs-setup-start':
    case 'cs-rematch-start': {
      result = null; resultHidden = false; hideModal('resultModal');
      rematch = { mine: false, theirs: false };
      oppDiscUntil = 0; bluffMode = false; selected = -1; setupSel = null;
      setupLayout = msg.view.setup.placements.slice();
      applyView(msg.view, at, { animate: false });
      banner('info', msg.type === 'cs-rematch-start' ? 'REMATCH' : 'SETUP', `You play ${COLOR_NAME[myColor]}. Arrange your pieces.`, 1500);
      break;
    }
    case 'cs-setup-ready':
      if (view?.setup) view.setup.ready = msg.ready;
      render({ animate: false });
      break;
    case 'cs-game-start':
      hideModal('promoModal');
      applyView(msg.view, at, { animate: false });
      await banner('info', view.turn === myColor ? 'YOUR MOVE' : 'GAME ON',
        myColor === 0 ? 'You are White and move first.' : 'You are Black. White moves first.', 1400);
      break;
    case 'cs-state':
      reconnecting = false;
      if (msg.view.phase === 'setup') setupLayout = msg.view.setup.placements.slice();
      applyView(msg.view, at, { animate: false });
      break;
    case 'cs-move-result': {
      const removed = new Map();
      if (msg.captured) removed.set(String(msg.captured.id), msg.captured.t);
      applyView(msg.view, at, { removed });
      if (msg.kingCaptured && msg.view.lastMove?.c === myColor) {
        await banner('info', 'KING TAKEN!', 'If they call your bluff and the move was legal, you win.', 1600);
      }
      break;
    }
    case 'cs-call-window-closed':
      applyView(msg.view, at);
      break;
    case 'cs-bluff-resolved': {
      if (view?.pending) sqEls[view.pending.to]?.classList.add('picking');
      hideModal('kingModal');
      await wait(700);
      const rp = msg.revealedPiece;
      const removed = new Map();
      if (msg.removedPiece) removed.set(String(msg.removedPiece.id), msg.removedPiece.t);
      applyView(msg.view, at, { removed });
      const iCalled = rp.c !== myColor;
      if (msg.outcome === 'caught') {
        boardWrap.classList.remove('shake'); void boardWrap.offsetWidth; boardWrap.classList.add('shake');
        await banner('caught', 'CAUGHT!', iCalled
          ? `Their ${NAME[rp.t]} was bluffing. It has been removed.`
          : `Your ${NAME[rp.t]} was caught bluffing and removed.`, 2100);
      } else {
        await banner('false', 'FALSE ACCUSATION', iCalled
          ? `Their ${NAME[rp.t]} moved legally. They now remove one of your pieces blind…`
          : `Your ${NAME[rp.t]} was legal! Pick one of their tokens to remove.`, 2300);
      }
      break;
    }
    case 'cs-blind-pick-request':
      pickSent = false;
      render({ animate: false });
      break;
    case 'cs-blind-pick-result': {
      const rp = msg.removedPiece;
      sqEls[rp.sq]?.classList.add('picking');
      await wait(1400);
      pickSent = false;
      applyView(msg.view, at, { removed: new Map([[String(rp.id), rp.t]]) });
      const mine = rp.c === myColor;
      if (msg.lucky) {
        await banner('lucky', 'LUCKY GUESS!', mine ? 'Their blind pick found your King…' : 'Your blind pick found their KING!', 2600);
      } else {
        await banner(mine ? 'bad' : 'info', `${NAME[rp.t].toUpperCase()} REMOVED`, mine
          ? `You lost a ${NAME[rp.t]}${msg.auto ? ' (auto-pick)' : ''}.`
          : `You removed their ${NAME[rp.t]}${msg.auto ? ' (time ran out, auto-pick)' : ''}.`, 1700);
      }
      break;
    }
    case 'cs-draw-offer':
      applyView(msg.view, at, { animate: false });
      if (msg.from === myColor) toast('Draw offered');
      break;
    case 'cs-draw-declined':
      applyView(msg.view, at, { animate: false });
      if (msg.by !== myColor) toast('Your draw offer was declined');
      break;
    case 'cs-draw-accepted':
      toast('Draw agreed');
      break;
    case 'cs-opponent-disconnected':
      oppDiscUntil = at + msg.reconnectMs;
      applyView(msg.view, at, { animate: false });
      break;
    case 'cs-opponent-reconnected':
      oppDiscUntil = 0;
      applyView(msg.view, at, { animate: false });
      toast(`${msg.name} reconnected`);
      break;
    case 'cs-game-over': {
      reconnecting = false;
      result = msg;
      oppDiscUntil = 0;
      hideModal('kingModal'); hideModal('drawModal'); hideModal('promoModal');
      applyView(msg.view, at);
      if (msg.winner === myColor && !msg.rejoin) reportScore('chessstratego', 1);
      if (!msg.rejoin) await wait(1500);
      showResult();
      break;
    }
    case 'cs-rematch-request':
      rematch.theirs = true;
      updateResultButtons();
      toast('Your opponent wants a rematch!');
      break;
    case 'cs-rematch-accepted':
      toast('Rematch! Colors swap.');
      break;
    case 'cs-rematch-cancelled':
      rematch = { mine: false, theirs: false };
      updateResultButtons();
      break;
    case 'cs-lens':
      if (!lensOn) break;
      lens = msg;
      renderLens();
      break;
  }
}

function handleMsg(msg) {
  switch (msg.type) {
    case 'room-joined': {
      myId = msg.myId; leaderId = msg.leaderId;
      players.clear();
      players.set(myId, { name: myName });
      for (const p of msg.players) players.set(p.id, { name: p.name });
      if (reconnecting) {
        // If the game ended while we were away the server sends nothing more, so fall back to the room lobby
        const joinedAt = performance.now();
        setTimeout(() => {
          if (reconnecting && lastCsAt < joinedAt) { reconnecting = false; phase = 'lobby'; showPhase('lobby'); renderLobby(); }
        }, 2500);
      }
      renderPlayers();
      renderLobby();
      break;
    }
    case 'player-joined':
      players.set(msg.id, { name: msg.name });
      leaderId = msg.leaderId;
      renderPlayers();
      renderLobby();
      if (phase === 'over') updateResultButtons();
      if (phase === 'lobby') statusEl.textContent = `${msg.name} joined.`;
      break;
    case 'player-left':
      players.delete(msg.id);
      if (players.size === 1) leaderId = myId;
      renderPlayers();
      renderLobby();
      if (phase === 'over') updateResultButtons();
      break;
    case 'error':
      alert(msg.msg);
      leaving = true;
      location.href = '/';
      break;
    case 'cs-error':
      toast(msg.msg);
      moveInFlight = false;
      callSent = false;
      pickSent = false;
      if (view && phase !== 'lobby') render({ animate: false });
      break;
    case 'cs-lobby-config':
      config = { ...config, ...msg.config };
      renderLobby();
      break;
    case 'cs-lens-state': {
      lensOn = msg.on;
      if (!lensOn) lens = null;
      const dot = $('myDot');
      dot.classList.add('ack');
      setTimeout(() => dot.classList.remove('ack'), 600);
      renderLens();
      break;
    }
    default:
      if (typeof msg.type === 'string' && msg.type.startsWith('cs-')) queue(() => handleCs(msg));
  }
}

// ── Network ───────────────────────────────────────────────────
async function freshToken() {
  try {
    if (typeof fbAuth !== 'undefined' && fbAuth.currentUser) {
      const t = await fbAuth.currentUser.getIdToken();
      sessionStorage.setItem('arena-token', t);
      return t;
    }
  } catch {}
  return sessionStorage.getItem('arena-token') || '';
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = async () => {
    const token = await freshToken();
    wsSend({ type: 'join-room', roomId, name: myName, password: roomPw, token });
  };
  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    msg._at = performance.now();
    try { handleMsg(msg); } catch (err) { console.error(err); }
  };
  ws.onclose = () => {
    if (leaving) return;
    if (phase === 'setup' || phase === 'play') {
      if (!reconnecting) {
        reconnecting = true;
        reconnectUntil = performance.now() + 55000;
        if (view) render({ animate: false });
      }
      if (performance.now() < reconnectUntil) { setTimeout(connect, 2000); return; }
    }
    statusEl.textContent = 'Disconnected. Returning to lobby…';
    setTimeout(() => { location.href = '/'; }, 3000);
  };
}
function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

showPhase('lobby');
renderLobby();
connect();
})();

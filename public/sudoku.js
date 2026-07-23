/* ═══════════════════════════════════════════════════════════════════
   COMPETITIVE SUDOKU — Arena Room Client  |  sudoku.js
   ═══════════════════════════════════════════════════════════════════ */
(() => {
'use strict';

// ─── URL / SESSION ───────────────────────────────────────────────────────────
const params  = new URLSearchParams(location.search);
const roomId  = params.get('room');
const myName  = sessionStorage.getItem('arena-name') || 'Player';
if (!roomId) { location.href = '/'; return; }

// ─── DOM REFS ────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);
const statusEl       = $('status');
const playerListEl   = $('playerList');
const playerCountEl  = $('playerCount');
const roomBadge      = $('roomBadge');
const btnBack        = $('btnBack');
const btnToggleSidebar = $('btnToggleSidebar');
const sidebar        = $('sidebar');
const sidebarConfig  = $('sidebarConfig');
const diffPills      = $('diffPills');
const btnStart       = $('btnStart');
const waitingText    = $('waitingText');
const countdownOverlay = $('countdownOverlay');
const countdownNumber  = $('countdownNumber');
const countdownDiff    = $('countdownDiff');
const gameArea       = $('gameArea');
const diffBadge      = $('diffBadge');
const timerDisplay   = $('timerDisplay');
const btnTimerToggle = $('btnTimerToggle');
const hintsLeft      = $('hintsLeft');
const sudokuGrid     = $('sudokuGrid');
const gridGenerating = $('gridGenerating');
const confettiCanvas = $('confettiCanvas');
const numpadEl       = $('numpad');
const btnUndo        = $('btnUndo');
const btnRedo        = $('btnRedo');
const btnHint        = $('btnHint');
const resultOverlay  = $('resultOverlay');
const resultIcon     = $('resultIcon');
const resultTitleEl  = $('resultTitle');
const resultBody     = $('resultBody');
const btnBackToLobby = $('btnBackToLobby');
const rulesOverlay   = $('rulesOverlay');
const btnRules       = $('btnRules');
const btnCloseRules  = $('btnCloseRules');

roomBadge.textContent = 'Room ' + roomId;

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const DIFF_CFG = {
  easy:   { label: 'Easy',   emoji: '🟢', clues: [38, 42], hints: 3, mult: 1.0, color: '#22c55e' },
  medium: { label: 'Medium', emoji: '🟡', clues: [30, 34], hints: 2, mult: 1.5, color: '#eab308' },
  hard:   { label: 'Hard',   emoji: '🔴', clues: [24, 28], hints: 2, mult: 2.5, color: '#f97316' },
  expert: { label: 'Expert', emoji: '💀', clues: [20, 23], hints: 1, mult: 4.0, color: '#ef4444' },
};

// ─── ROOM STATE ──────────────────────────────────────────────────────────────
let ws = null, myId = null, leaderId = null;
const players = new Map(); // id → { name, filled, done, el }
let difficulty = 'medium';
let gamePhase  = 'lobby'; // lobby | countdown | playing | ended

// ─── GAME STATE ──────────────────────────────────────────────────────────────
let grid       = new Array(81).fill(0);
let solution   = new Array(81).fill(0);
let given      = new Array(81).fill(false);
let notes      = Array.from({ length: 81 }, () => new Set());
let selectedCell   = -1;
let notesMode      = false;
let undoStack      = [];
let redoStack      = [];
let elapsedSeconds = 0;
let timerInterval  = null;
let timerStarted   = false;
let timerHidden    = false;
let hintsRemaining = 0;
let hintsUsed      = 0;
let errorCount     = 0;
let isAssisted     = false;
let prevConflicts  = new Set();
let completedBoxes = new Set();
let completedRows  = new Set();
let completedCols  = new Set();
let completedCells = new Set();   // cells that belong to a fully-solved row/col/box

// ─── SEEDED PRNG (mulberry32 — same as maze.js) ───────────────────────────────
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = seed + 0x6D2B79F5 | 0;
    let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// ─── UTILS ────────────────────────────────────────────────────────────────────
const delay  = ms => new Promise(r => setTimeout(r, ms));
function shuffleWith(arr, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
function getCellEl(idx)  { return sudokuGrid.querySelector(`.sudoku-cell[data-idx="${idx}"]`); }
function formatTime(s)   { return `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}`; }
function escapeHtml(s)   { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ─── PEERS ────────────────────────────────────────────────────────────────────
const PEERS = Array.from({ length: 81 }, (_, idx) => {
  const row = Math.floor(idx/9), col = idx%9;
  const br = Math.floor(row/3)*3, bc = Math.floor(col/3)*3;
  const s = new Set();
  for (let i = 0; i < 9; i++) {
    s.add(row*9+i); s.add(i*9+col);
    s.add((br+Math.floor(i/3))*9+bc+(i%3));
  }
  s.delete(idx); return s;
});

// ─── PUZZLE GENERATION (deterministic) ──────────────────────────────────────
function isValidAt(g, idx, d) {
  const row = Math.floor(idx/9), col = idx%9;
  const br = Math.floor(row/3)*3, bc = Math.floor(col/3)*3;
  for (let i = 0; i < 9; i++) {
    if (g[row*9+i]===d || g[i*9+col]===d) return false;
    if (g[(br+Math.floor(i/3))*9+bc+(i%3)]===d) return false;
  }
  return true;
}

function generateSolvedGrid(rng) {
  const g = new Array(81).fill(0);
  function bt(pos) {
    if (pos===81) return true;
    if (g[pos]!==0) return bt(pos+1);
    for (const d of shuffleWith([1,2,3,4,5,6,7,8,9], rng)) {
      if (isValidAt(g, pos, d)) { g[pos]=d; if (bt(pos+1)) return true; g[pos]=0; }
    }
    return false;
  }
  bt(0); return g;
}

function countSolutions(puzzle, limit=2) {
  const g = [...puzzle]; let count = 0;
  function solve() {
    if (count >= limit) return;
    // ── Phase 1: propagate naked singles (forced cells — no branching needed) ──
    const forced = [];
    let contradiction = false;
    let progress = true;
    while (progress && !contradiction) {
      progress = false;
      for (let i = 0; i < 81; i++) {
        if (g[i] !== 0) continue;
        let cnt = 0, lastD = 0;
        for (let d = 1; d <= 9; d++) { if (isValidAt(g,i,d)) { cnt++; lastD = d; } }
        if (cnt === 0) { contradiction = true; break; }
        if (cnt === 1) { g[i] = lastD; forced.push(i); progress = true; }
      }
    }
    if (!contradiction) {
      // ── Phase 2: pick branching cell with fewest candidates (MRV) ──
      let minCell = -1, minCnt = 10;
      for (let i = 0; i < 81; i++) {
        if (g[i] !== 0) continue;
        let cnt = 0;
        for (let d = 1; d <= 9; d++) if (isValidAt(g,i,d)) cnt++;
        if (cnt === 0) { contradiction = true; break; }
        if (cnt < minCnt) { minCnt = cnt; minCell = i; if (minCnt === 2) break; }
      }
      if (!contradiction) {
        if (minCell === -1) { count++; }
        else {
          for (let d = 1; d <= 9; d++) {
            if (count >= limit) break;
            if (isValidAt(g, minCell, d)) { g[minCell] = d; solve(); g[minCell] = 0; }
          }
        }
      }
    }
    for (const i of forced) g[i] = 0; // undo propagated assignments
  }
  solve(); return count;
}

function generatePuzzle(diff, seed) {
  const cfg = DIFF_CFG[diff];
  let lastResult = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    // Deterministically derive a different seed each attempt so both clients agree
    const rng    = mulberry32(seed + attempt * 1000003);
    const sol    = generateSolvedGrid(rng);
    const puzzle = [...sol];
    const target = cfg.clues[0] + Math.floor(rng() * (cfg.clues[1]-cfg.clues[0]+1));
    let clues    = 81;
    const t0     = performance.now();
    let timedOut = false;

    for (const pos of shuffleWith([...Array(81).keys()], rng)) {
      if (clues <= target) break;
      if (performance.now() - t0 > 2000) { timedOut = true; break; }
      const bak = puzzle[pos]; puzzle[pos] = 0;
      // Check uniqueness after EVERY removal — never skip this step
      if (countSolutions([...puzzle], 2) !== 1) puzzle[pos] = bak; else clues--;
    }

    lastResult = { puzzle, solution: sol };

    if (timedOut) {
      console.warn(`[Sudoku] generation timed out on attempt ${attempt+1}, retrying…`);
      continue;
    }
    // Final sanity check: assert exactly one solution before handing off
    if (countSolutions([...puzzle], 2) === 1) return lastResult;
    console.warn(`[Sudoku] sanity check failed on attempt ${attempt+1}, retrying…`);
  }
  console.error('[Sudoku] could not generate a valid unique puzzle in 10 attempts');
  return lastResult; // return last attempt rather than crashing the game
}

// ─── GRID BUILDER ────────────────────────────────────────────────────────────
function buildGrid() {
  sudokuGrid.innerHTML = '';
  for (let i=0; i<81; i++) {
    const row = Math.floor(i/9), col = i%9;
    const cell = document.createElement('div');
    cell.className='sudoku-cell'; cell.dataset.idx=i;
    if (col===2||col===5) cell.classList.add('box-right');
    if (row===2||row===5) cell.classList.add('box-bottom');
    const digitEl = document.createElement('div'); digitEl.className='cell-digit';
    const notesEl = document.createElement('div'); notesEl.className='cell-notes';
    for (let n=1; n<=9; n++) {
      const sp=document.createElement('span'); sp.className='note-digit';
      sp.dataset.n=n; sp.textContent=n; notesEl.appendChild(sp);
    }
    cell.appendChild(digitEl); cell.appendChild(notesEl);
    cell.addEventListener('click', e => onCellClick(e, i));
    sudokuGrid.appendChild(cell);
  }
}

function onCellClick(e, idx) {
  if (gamePhase!=='playing') return;
  const cell = e.currentTarget;
  const ripple = document.createElement('div');
  ripple.className='cell-ripple';
  const rect = cell.getBoundingClientRect();
  ripple.style.setProperty('--rx',(e.clientX-rect.left)+'px');
  ripple.style.setProperty('--ry',(e.clientY-rect.top)+'px');
  cell.appendChild(ripple);
  setTimeout(()=>ripple.remove(),600);
  selectCell(idx);
}

// ─── RENDERING ────────────────────────────────────────────────────────────────
function renderCell(idx) {
  const cell = getCellEl(idx); if (!cell) return;
  const digitEl=cell.querySelector('.cell-digit');
  const notesEl=cell.querySelector('.cell-notes');
  const val=grid[idx], ns=notes[idx];
  cell.classList.toggle('given', given[idx]);
  cell.classList.toggle('has-digit', val!==0);
  if (val!==0) { digitEl.textContent=val; notesEl.style.display='none'; }
  else {
    digitEl.textContent=''; notesEl.style.display='grid';
    for (let n=1; n<=9; n++) notesEl.querySelector(`[data-n="${n}"]`).classList.toggle('active', ns.has(n));
  }
}
function renderAllCells() { for (let i=0;i<81;i++) renderCell(i); }

function animateDigitPop(idx) {
  const cell=getCellEl(idx); if (!cell) return;
  const d=cell.querySelector('.cell-digit');
  d.classList.remove('pop'); void d.offsetWidth; d.classList.add('pop');
  setTimeout(()=>d.classList.remove('pop'),380);
}

// ─── SELECTION ────────────────────────────────────────────────────────────────
function selectCell(idx) { selectedCell=idx; updateHighlights(); }

function updateHighlights() {
  const cells=sudokuGrid.querySelectorAll('.sudoku-cell');
  cells.forEach(c=>c.classList.remove('highlight','same-digit','selected'));
  if (selectedCell<0) return;
  const row=Math.floor(selectedCell/9), col=selectedCell%9;
  const br=Math.floor(row/3)*3, bc=Math.floor(col/3)*3;
  const digit=grid[selectedCell];
  cells.forEach((c,i)=>{
    if (i===selectedCell) { c.classList.add('selected'); return; }
    const r=Math.floor(i/9), cl=i%9;
    if (r===row||cl===col||(Math.floor(r/3)*3===br&&Math.floor(cl/3)*3===bc)) c.classList.add('highlight');
    if (digit!==0&&grid[i]===digit) c.classList.add('same-digit');
  });
}

// ─── CONFLICT DETECTION ───────────────────────────────────────────────────────
function getConflicts() {
  const out=new Set();
  for (let i=0;i<81;i++) {
    if (!grid[i]) continue;
    for (const p of PEERS[i]) if (grid[p]===grid[i]) { out.add(i); out.add(p); }
  }
  return out;
}
function updateConflicts() {
  const cur=getConflicts();
  for (const i of prevConflicts) { const c=getCellEl(i); if(c) c.classList.remove('conflict'); }
  for (const i of cur)           { const c=getCellEl(i); if(c) c.classList.add('conflict'); }
  prevConflicts=cur;
}

// ─── DIGIT INPUT ──────────────────────────────────────────────────────────────
function enterDigit(digit) {
  if (selectedCell<0||gamePhase!=='playing') return;
  if (given[selectedCell]||completedCells.has(selectedCell)) return;
  if (notesMode) { enterNote(digit); return; }
  if (grid[selectedCell]===digit) return;
  pushUndo();
  if (!timerStarted) startTimer();
  grid[selectedCell]=digit; notes[selectedCell].clear();
  renderCell(selectedCell); animateDigitPop(selectedCell);
  autoRemoveNotes(selectedCell, digit);
  const before=new Set(prevConflicts);
  updateConflicts();
  const newConflict=[...prevConflicts].some(i=>!before.has(i));
  if (newConflict) {
    errorCount++;
    const toShake=new Set([selectedCell,...prevConflicts]);
    toShake.forEach(i=>{ const c=getCellEl(i); if(!c) return; c.classList.remove('shake'); void c.offsetWidth; c.classList.add('shake'); setTimeout(()=>c.classList.remove('shake'),520); });
  } else if (digit&&digit===solution[selectedCell]) {
    flashCell(getCellEl(selectedCell),'correct');
    checkCompletions(selectedCell);
  }
  updateNumpadDimming(); updateHighlights();
  reportProgress();
  if (checkWin()) onLocalWin();
}

function eraseCell() {
  if (selectedCell<0||gamePhase!=='playing') return;
  if (given[selectedCell]||completedCells.has(selectedCell)) return;
  if (!grid[selectedCell]&&!notes[selectedCell].size) return;
  pushUndo();
  const cell=getCellEl(selectedCell);
  cell.classList.add('cell-erasing'); setTimeout(()=>cell.classList.remove('cell-erasing'),280);
  grid[selectedCell]=0; notes[selectedCell].clear();
  renderCell(selectedCell); updateConflicts(); updateHighlights(); updateNumpadDimming();
}

// ─── NOTES ────────────────────────────────────────────────────────────────────
function enterNote(digit) {
  if (selectedCell<0||given[selectedCell]||completedCells.has(selectedCell)||grid[selectedCell]!==0) return;
  if (!timerStarted) startTimer();
  pushUndo();
  const ns=notes[selectedCell];
  if (ns.has(digit)) { ns.delete(digit); renderCell(selectedCell); }
  else {
    ns.add(digit); renderCell(selectedCell);
    const sp=getCellEl(selectedCell)?.querySelector(`.note-digit[data-n="${digit}"]`);
    if (sp) { sp.classList.add('just-added'); setTimeout(()=>sp.classList.remove('just-added'),200); }
  }
  updateHighlights();
}

function autoRemoveNotes(idx, digit) {
  if (!digit) return;
  for (const peer of PEERS[idx]) {
    if (!notes[peer].has(digit)) continue;
    notes[peer].delete(digit);
    const cell=getCellEl(peer);
    if (cell) {
      const sp=cell.querySelector(`.note-digit[data-n="${digit}"]`);
      if (sp&&sp.classList.contains('active')) { sp.classList.add('note-removing'); setTimeout(()=>sp.classList.remove('note-removing'),280); }
    }
    renderCell(peer);
  }
}

// ─── COMPLETION CHECKS ────────────────────────────────────────────────────────
function lockCells(cells) {
  cells.forEach(i => {
    completedCells.add(i);
    const c = getCellEl(i); if (c) { c.classList.add('line-complete'); c.classList.remove('selected','highlight','same-digit'); }
  });
  if (selectedCell >= 0 && completedCells.has(selectedCell)) { selectedCell = -1; updateHighlights(); }
}

function checkCompletions(idx) {
  const row=Math.floor(idx/9), col=idx%9;
  const br=Math.floor(row/3)*3, bc=Math.floor(col/3)*3;
  const boxKey=`${br},${bc}`;
  if (!completedBoxes.has(boxKey)) {
    const cells=[]; for (let r=br;r<br+3;r++) for (let c=bc;c<bc+3;c++) cells.push(r*9+c);
    if (cells.every(i=>grid[i]&&grid[i]===solution[i])) { completedBoxes.add(boxKey); animateBoxComplete(cells); setTimeout(()=>lockCells(cells), 800); }
  }
  if (!completedRows.has(row)) {
    const cells=Array.from({length:9},(_,c)=>row*9+c);
    if (cells.every(i=>grid[i]&&grid[i]===solution[i])) { completedRows.add(row); animateRowComplete(row); setTimeout(()=>lockCells(cells), 500); }
  }
  if (!completedCols.has(col)) {
    const cells=Array.from({length:9},(_,r)=>r*9+col);
    if (cells.every(i=>grid[i]&&grid[i]===solution[i])) { completedCols.add(col); animateColComplete(col); setTimeout(()=>lockCells(cells), 500); }
  }
}

// ─── WIN DETECTION ────────────────────────────────────────────────────────────
function checkWin() {
  for (let i=0;i<81;i++) if (grid[i]!==solution[i]) return false;
  return prevConflicts.size===0;
}

function onLocalWin() {
  wsSend({ type:'sudoku-complete', time: elapsedSeconds });
  stopTimer();
}

// ─── UNDO / REDO ──────────────────────────────────────────────────────────────
function snapshot() { return { grid:[...grid], notes:notes.map(s=>new Set(s)) }; }
function pushUndo()  { undoStack.push(snapshot()); if (undoStack.length>100) undoStack.shift(); redoStack=[]; }
function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot()); const p=undoStack.pop();
  grid=p.grid; notes=p.notes;
  renderAllCells(); updateConflicts(); updateHighlights(); updateNumpadDimming();
  if (selectedCell>=0) flashCell(getCellEl(selectedCell),'undo');
  reportProgress();
}
function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot()); const n=redoStack.pop();
  grid=n.grid; notes=n.notes;
  renderAllCells(); updateConflicts(); updateHighlights(); updateNumpadDimming();
  if (selectedCell>=0) flashCell(getCellEl(selectedCell),'redo');
  reportProgress();
}

// ─── HINT SYSTEM ──────────────────────────────────────────────────────────────
function getBestHintCell() {
  let best=-1, min=10;
  for (let i=0;i<81;i++) {
    if (grid[i]||given[i]) continue;
    let cnt=0; for (let d=1;d<=9;d++) if (isValidAt(grid,i,d)) cnt++;
    if (cnt<min) { min=cnt; best=i; }
  }
  return best;
}

function requestHint() {
  if (gamePhase!=='playing'||hintsRemaining<=0) return;
  const hc=getBestHintCell(); if (hc<0) return;
  if (!timerStarted) startTimer();
  pushUndo();
  hintsRemaining--; hintsUsed++; isAssisted=true;
  grid[hc]=solution[hc]; notes[hc].clear(); given[hc]=true;
  autoRemoveNotes(hc,solution[hc]); renderCell(hc);
  const cell=getCellEl(hc);
  if (cell) {
    cell.classList.add('hint-glow');
    const d=cell.querySelector('.cell-digit'); d.classList.add('hint-anim');
    setTimeout(()=>{ cell.classList.remove('hint-glow'); d.classList.remove('hint-anim'); },2500);
  }
  updateConflicts(); updateHighlights(); updateNumpadDimming(); updateHintUI();
  checkCompletions(hc);
  reportProgress();
  if (checkWin()) onLocalWin();
}
function updateHintUI() {
  hintsLeft.textContent=hintsRemaining;
  btnHint.disabled=hintsRemaining<=0||gamePhase!=='playing';
}

// ─── TIMER ────────────────────────────────────────────────────────────────────
function startTimer() {
  if (timerInterval) return;
  timerStarted=true;
  timerInterval=setInterval(()=>{ elapsedSeconds++; updateTimerDisplay(); },1000);
}
function stopTimer()  { clearInterval(timerInterval); timerInterval=null; }
function updateTimerDisplay() {
  const txt=formatTime(elapsedSeconds);
  if (timerDisplay.textContent!==txt) {
    timerDisplay.textContent=txt;
    timerDisplay.classList.remove('timer-tick'); void timerDisplay.offsetWidth; timerDisplay.classList.add('timer-tick');
    setTimeout(()=>timerDisplay.classList.remove('timer-tick'),200);
  }
}
document.addEventListener('visibilitychange',()=>{ if (document.hidden) stopTimer(); else if (gamePhase==='playing') startTimer(); });

// ─── SCORE ────────────────────────────────────────────────────────────────────
function calculateScore() {
  const cfg=DIFF_CFG[difficulty];
  return Math.max(100, Math.round(Math.max(0,10000-elapsedSeconds*2)*cfg.mult - hintsUsed*500 - errorCount*100));
}

// ─── NUMPAD ───────────────────────────────────────────────────────────────────
function buildNumpad() {
  numpadEl.innerHTML='';
  for (let d=1;d<=9;d++) {
    const btn=document.createElement('button');
    btn.className='numpad-btn'; btn.dataset.digit=d; btn.textContent=d;
    btn.addEventListener('mousedown',()=>btn.classList.add('pressed'));
    btn.addEventListener('mouseup',()=>{ btn.classList.remove('pressed'); enterDigit(d); });
    btn.addEventListener('mouseleave',()=>btn.classList.remove('pressed'));
    btn.addEventListener('touchstart',e=>{ e.preventDefault(); btn.classList.add('pressed'); enterDigit(d); },{passive:false});
    btn.addEventListener('touchend',()=>btn.classList.remove('pressed'));
    numpadEl.appendChild(btn);
  }
  const erBtn=document.createElement('button'); erBtn.className='numpad-btn erase-btn'; erBtn.textContent='⌫'; erBtn.addEventListener('click',eraseCell); numpadEl.appendChild(erBtn);
  const ntBtn=document.createElement('button'); ntBtn.className='numpad-btn notes-btn'; ntBtn.id='btnNotes';
  ntBtn.innerHTML='<span class="notes-icon">✏️</span><span class="notes-label">Notes</span>';
  ntBtn.addEventListener('click',toggleNotes); numpadEl.appendChild(ntBtn);
}
function updateNumpadDimming() {
  for (let d=1;d<=9;d++) {
    const btn=numpadEl.querySelector(`.numpad-btn[data-digit="${d}"]`);
    if (btn) btn.classList.toggle('dimmed', grid.filter(v=>v===d).length===9);
  }
}
function toggleNotes() {
  notesMode=!notesMode;
  const btn=$('btnNotes'); if (btn) btn.classList.toggle('active',notesMode);
}
function setGridLocked(locked) {
  sudokuGrid.querySelectorAll('.sudoku-cell:not(.given)').forEach(c=>c.classList.toggle('locked',locked));
}

// ─── PROGRESS REPORTING ───────────────────────────────────────────────────────
let lastReportedFilled = -1;
function reportProgress() {
  const filled=grid.filter(v=>v!==0).length;
  if (filled!==lastReportedFilled) {
    lastReportedFilled=filled;
    wsSend({ type:'sudoku-progress', filled });
  }
}

// ─── WIN / GAME OVER SEQUENCE ─────────────────────────────────────────────────
async function doWinSequence(winnerId, winnerName, time) {
  const iWon = winnerId===myId;
  if (iWon) {
    // Bloom + confetti
    const rings=getRingsFromCenter(40);
    rings.forEach((ring,ri)=>{
      ring.forEach(idx=>{
        setTimeout(()=>{ const c=getCellEl(idx); if(!c) return; c.classList.remove('win-bloom'); void c.offsetWidth; c.classList.add('win-bloom'); },ri*50);
      });
    });
    await delay(rings.length*50+80);
    launchConfetti();
    for (let r=0;r<9;r++) setTimeout(()=>animateRowShimmer(r),r*80);
    await delay(600);

    const score=calculateScore();
    try { reportScore('sudoku',score); } catch {}

    resultIcon.textContent='🏆';
    resultTitleEl.textContent='You Win!';
    resultTitleEl.className='result-title win';
    resultBody.innerHTML=`
      <strong>${escapeHtml(winnerName)}</strong> solved the puzzle first!<br>
      Time: <strong>${formatTime(elapsedSeconds)}</strong><br>
      Score: <strong>${score.toLocaleString()}</strong>${hintsUsed?`<br>(${hintsUsed} hint${hintsUsed>1?'s':''} used)`:''}
    `;
  } else {
    stopTimer();
    setGridLocked(true);
    resultIcon.textContent='❌';
    resultTitleEl.textContent='Game Over';
    resultTitleEl.className='result-title lose';
    resultBody.innerHTML=`<strong>${escapeHtml(winnerName)}</strong> finished first in <strong>${formatTime(time)}</strong>.<br>Better luck next time!`;
  }
  resultOverlay.style.display='flex';
}

// ─── ANIMATIONS ──────────────────────────────────────────────────────────────
function flashCell(cellEl, type) {
  if (!cellEl) return;
  const cls={correct:'flash-correct',undo:'flash-undo',redo:'flash-redo'}[type]; if (!cls) return;
  cellEl.classList.remove(cls); void cellEl.offsetWidth; cellEl.classList.add(cls);
  setTimeout(()=>cellEl.classList.remove(cls),420);
}
function animateBoxComplete(cells) {
  cells.forEach((idx,i)=>{
    setTimeout(()=>{ const c=getCellEl(idx); if(!c) return; c.classList.remove('box-complete'); void c.offsetWidth; c.classList.add('box-complete'); setTimeout(()=>c.classList.remove('box-complete'),750); },i*50);
  });
}
function animateRowComplete(row) { animateRowShimmer(row); }
function animateColComplete(col) {
  for (let r=0;r<9;r++) setTimeout(()=>{ const c=getCellEl(r*9+col); if(c){c.classList.add('shimmer');setTimeout(()=>c.classList.remove('shimmer'),400);}},r*40);
}
function animateRowShimmer(row) {
  for (let col=0;col<9;col++) setTimeout(()=>{ const c=getCellEl(row*9+col); if(c){c.classList.add('shimmer');setTimeout(()=>c.classList.remove('shimmer'),400);}},col*40);
}
function getRingsFromCenter(center) {
  const rings=[],visited=new Set([center]); let cur=[center];
  while (cur.length) {
    rings.push([...cur]); const next=[];
    const dirs=[[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
    for (const idx of cur) {
      const r=Math.floor(idx/9),c=idx%9;
      for (const [dr,dc] of dirs) { const nr=r+dr,nc=c+dc; if(nr<0||nr>8||nc<0||nc>8) continue; const ni=nr*9+nc; if(!visited.has(ni)){visited.add(ni);next.push(ni);} }
    }
    cur=next;
  }
  return rings;
}

// ─── CONFETTI ─────────────────────────────────────────────────────────────────
function launchConfetti() {
  const ctx=confettiCanvas.getContext('2d');
  const rect=sudokuGrid.getBoundingClientRect();
  confettiCanvas.width=rect.width; confettiCanvas.height=rect.height;
  confettiCanvas.style.display='block';
  const COLORS=['#a78bfa','#7c3aed','#67e8f9','#06b6d4','#fbbf24','#34d399','#f472b6','#fb923c'];
  const P=Array.from({length:80},()=>({
    x:confettiCanvas.width/2, y:confettiCanvas.height/2,
    vx:(Math.random()-.5)*15, vy:(Math.random()-.5)*15-5,
    color:COLORS[Math.floor(Math.random()*COLORS.length)],
    w:6+Math.random()*8, h:3+Math.random()*4,
    rot:Math.random()*360, rotV:(Math.random()-.5)*10, alpha:1, g:0.28,
  }));
  let frame=0;
  function anim() {
    ctx.clearRect(0,0,confettiCanvas.width,confettiCanvas.height); frame++;
    let alive=false;
    for (const p of P) {
      p.vy+=p.g; p.x+=p.vx; p.y+=p.vy; p.rot+=p.rotV;
      if (frame>55) p.alpha=Math.max(0,p.alpha-.016);
      if (p.alpha>0) alive=true;
      ctx.save(); ctx.globalAlpha=p.alpha; ctx.translate(p.x,p.y); ctx.rotate(p.rot*Math.PI/180);
      ctx.fillStyle=p.color; ctx.fillRect(-p.w/2,-p.h/2,p.w,p.h); ctx.restore();
    }
    if (alive&&frame<220) requestAnimationFrame(anim);
    else { ctx.clearRect(0,0,confettiCanvas.width,confettiCanvas.height); confettiCanvas.style.display='none'; }
  }
  requestAnimationFrame(anim);
}

// ─── PLAYER LIST ──────────────────────────────────────────────────────────────
function renderPlayerList() {
  playerListEl.innerHTML='';
  playerCountEl.textContent=players.size;
  for (const [pid,p] of players) {
    const el=document.createElement('div');
    el.className='player-entry'+(pid===myId?' is-me':'');
    el.id='player-entry-'+pid;
    el.innerHTML=`
      <div class="player-entry-header">
        <span class="player-entry-name">${escapeHtml(p.name)}${pid===leaderId?' 👑':''}</span>
        <span class="player-entry-badge"></span>
      </div>
      <div class="player-entry-progress-text">0 / 81</div>
      <div class="progress-bar-bg"><div class="progress-bar-fill" style="width:0%"></div></div>
    `;
    playerListEl.appendChild(el);
    p.el=el;
  }
}

function updatePlayerEntry(pid, filled, done) {
  const p=players.get(pid); if (!p) return;
  const el=p.el||document.getElementById('player-entry-'+pid); if (!el) return;
  const pctEl=el.querySelector('.player-entry-progress-text');
  const fillEl=el.querySelector('.progress-bar-fill');
  const badgeEl=el.querySelector('.player-entry-badge');
  p.filled=filled; p.done=done;
  if (pctEl) pctEl.textContent=`${filled} / 81`;
  if (fillEl) fillEl.style.width=(filled/81*100)+'%';
  if (done) {
    el.classList.add('winner');
    if (badgeEl) badgeEl.textContent='🏆';
  }
}

function updateHostUI() {
  const isHost = leaderId===myId;
  sidebarConfig.style.display = isHost && gamePhase==='lobby' ? '' : 'none';
  btnStart.style.display      = isHost && gamePhase==='lobby' ? '' : 'none';
  waitingText.style.display   = !isHost && gamePhase==='lobby' ? '' : 'none';
}

// ─── DIFFICULTY SELECTION ─────────────────────────────────────────────────────
diffPills.addEventListener('click', e=>{
  const pill=e.target.closest('.diff-pill'); if (!pill) return;
  difficulty=pill.dataset.diff;
  diffPills.querySelectorAll('.diff-pill').forEach(p=>p.classList.toggle('active',p===pill));
});

function updateDiffBadge() {
  const cfg=DIFF_CFG[difficulty];
  diffBadge.textContent=`${cfg.emoji} ${cfg.label}`;
  diffBadge.style.color=cfg.color;
  diffBadge.style.borderColor=cfg.color+'55';
  diffBadge.style.backgroundColor=cfg.color+'12';
}

// ─── START GAME ───────────────────────────────────────────────────────────────
btnStart.addEventListener('click',()=>{ if (leaderId===myId) wsSend({type:'sudoku-start', difficulty}); });

// ─── NETWORK ──────────────────────────────────────────────────────────────────
function connect() {
  const proto=location.protocol==='https:'?'wss':'ws';
  ws=new WebSocket(`${proto}://${location.host}`);
  ws.onopen=()=>{
    const pw=sessionStorage.getItem('arena-room-password')||undefined;
    sessionStorage.removeItem('arena-room-password');
    wsSend({type:'join-room', roomId, name:myName, password:pw, token:sessionStorage.getItem('arena-token')||''});
  };
  ws.onmessage=e=>{ try { handleMsg(JSON.parse(e.data)); } catch {} };
  ws.onclose=()=>{ statusEl.textContent='Disconnected. Returning to lobby…'; setTimeout(()=>{ location.href='/'; },3000); };
}
function wsSend(msg) { if (ws&&ws.readyState===1) ws.send(JSON.stringify(msg)); }

function handleMsg(msg) {
  switch (msg.type) {

    case 'room-joined':
      myId=msg.myId; leaderId=msg.leaderId;
      players.set(myId,{name:myName, filled:0, done:false, el:null});
      for (const p of msg.players) players.set(p.id,{name:p.name, filled:0, done:false, el:null});
      renderPlayerList(); updateHostUI();
      statusEl.textContent=`${players.size} player${players.size!==1?'s':''} in room. ${leaderId===myId?'You are the host.':'Waiting for host.'}`;
      break;

    case 'player-joined':
      players.set(msg.id,{name:msg.name, filled:0, done:false, el:null});
      leaderId=msg.leaderId;
      renderPlayerList(); updateHostUI();
      statusEl.textContent=`${escapeHtml(msg.name)} joined. ${players.size} player${players.size!==1?'s':''}.`;
      break;

    case 'player-left':
    case 'sudoku-player-left':
      players.delete(msg.id);
      renderPlayerList(); updateHostUI();
      break;

    case 'sudoku-countdown':
      gamePhase='countdown';
      updateHostUI();
      difficulty=msg.difficulty||difficulty;
      btnStart.style.display='none'; waitingText.style.display='none';
      countdownDiff.textContent=`${DIFF_CFG[difficulty]?.emoji||''} ${DIFF_CFG[difficulty]?.label||''} · Solve First To Win`;
      countdownNumber.textContent=msg.count;
      countdownNumber.style.animation='none'; void countdownNumber.offsetWidth; countdownNumber.style.animation='countPop .5s cubic-bezier(0.34,1.56,0.64,1)';
      countdownOverlay.style.display='flex';
      break;

    case 'sudoku-go': {
      countdownOverlay.style.display='none';
      gamePhase='playing';
      difficulty=msg.difficulty;
      const cfg=DIFF_CFG[difficulty];
      hintsRemaining=cfg.hints; hintsUsed=0; errorCount=0; isAssisted=false;
      elapsedSeconds=0; timerStarted=false; timerInterval=null;
      undoStack=[]; redoStack=[]; selectedCell=-1; notesMode=false;
      prevConflicts=new Set(); completedBoxes=new Set(); completedRows=new Set(); completedCols=new Set(); completedCells=new Set();
      lastReportedFilled=-1;

      updateDiffBadge(); updateHintUI();
      timerDisplay.textContent='0:00'; timerDisplay.classList.remove('hidden');
      btnTimerToggle.textContent='👁'; timerHidden=false;
      gameArea.style.display='';

      // Show spinner while generating
      gridGenerating.style.display='flex';
      statusEl.textContent='Generating puzzle…';

      setTimeout(()=>{
        const {puzzle, solution:sol}=generatePuzzle(difficulty, msg.seed);
        grid=puzzle; solution=sol; given=puzzle.map(v=>v!==0);
        notes=Array.from({length:81},()=>new Set());
        buildGrid(); renderAllCells(); updateConflicts(); buildNumpad(); updateNumpadDimming();
        gridGenerating.style.display='none';
        const notesBtn=$('btnNotes'); if (notesBtn) notesBtn.classList.remove('active');
        statusEl.textContent=`🏁 Race started! ${cfg.emoji} ${cfg.label} — first to finish wins!`;
        reportProgress();
      }, 80);
      break;
    }

    case 'sudoku-player-progress': {
      const p=players.get(msg.id);
      if (p) updatePlayerEntry(msg.id, msg.filled, false);
      break;
    }

    case 'sudoku-winner':
      gamePhase='ended';
      stopTimer();
      setGridLocked(true);
      updatePlayerEntry(msg.winnerId, 81, true);
      doWinSequence(msg.winnerId, msg.winnerName, msg.time);
      break;

    case 'error':
      statusEl.textContent='Error: '+msg.msg;
      break;
  }
}

// ─── KEYBOARD ─────────────────────────────────────────────────────────────────
document.addEventListener('keydown',e=>{
  if (e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
  if (gamePhase!=='playing') return;
  if (e.key>='1'&&e.key<='9') { e.preventDefault(); enterDigit(+e.key); return; }
  if (e.key==='Backspace'||e.key==='Delete') { e.preventDefault(); eraseCell(); return; }
  if ((e.key==='n'||e.key==='N')&&!e.ctrlKey) { e.preventDefault(); toggleNotes(); return; }
  if ((e.key==='h'||e.key==='H')&&!e.ctrlKey) { e.preventDefault(); requestHint(); return; }
  if (e.ctrlKey&&e.key==='z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey&&(e.key==='y'||e.key==='Y')) { e.preventDefault(); redo(); return; }
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key)&&selectedCell>=0) {
    e.preventDefault();
    const r=Math.floor(selectedCell/9), c=selectedCell%9;
    let nr=r, nc=c;
    if (e.key==='ArrowUp')   nr=Math.max(0,r-1);
    if (e.key==='ArrowDown') nr=Math.min(8,r+1);
    if (e.key==='ArrowLeft') nc=Math.max(0,c-1);
    if (e.key==='ArrowRight')nc=Math.min(8,c+1);
    selectCell(nr*9+nc);
  }
});

// ─── BUTTON WIRING ────────────────────────────────────────────────────────────
btnBack.addEventListener('click',()=>{ if (confirm('Leave this room?')) { wsSend({type:'leave-room'}); location.href='/'; } });
btnBackToLobby.addEventListener('click',()=>{ wsSend({type:'leave-room'}); location.href='/'; });
btnUndo.addEventListener('click',undo);
btnRedo.addEventListener('click',redo);
btnHint.addEventListener('click',requestHint);
btnTimerToggle.addEventListener('click',()=>{
  timerHidden=!timerHidden;
  timerDisplay.classList.toggle('hidden',timerHidden);
  btnTimerToggle.textContent=timerHidden?'🙈':'👁';
});
btnToggleSidebar.addEventListener('click',()=>sidebar.classList.toggle('open'));
document.addEventListener('click',e=>{ if (!sidebar.contains(e.target)&&!btnToggleSidebar.contains(e.target)) sidebar.classList.remove('open'); });
btnRules.addEventListener('click',()=>rulesOverlay.style.display='flex');
btnCloseRules.addEventListener('click',()=>rulesOverlay.style.display='none');
rulesOverlay.addEventListener('click',e=>{ if (e.target===rulesOverlay) rulesOverlay.style.display='none'; });

// ─── INIT ─────────────────────────────────────────────────────────────────────
connect();

})();

const SAVE_KEY  = 'sudoku_save';
const STATS_KEY = 'sudoku_stats';

const DIFF_CFG = {
  easy:   { label: 'Easy',   emoji: '🟢', clues: [38, 42], hints: 3, mult: 1.0, color: '#22c55e' },
  medium: { label: 'Medium', emoji: '🟡', clues: [30, 34], hints: 2, mult: 1.5, color: '#eab308' },
  hard:   { label: 'Hard',   emoji: '🔴', clues: [24, 28], hints: 2, mult: 2.5, color: '#f97316' },
  expert: { label: 'Expert', emoji: '💀', clues: [20, 23], hints: 1, mult: 4.0, color: '#ef4444' },
};

/* ── STATE ───────────────────────────────────────────────────────────────────── */
let grid       = new Array(81).fill(0);
let solution   = new Array(81).fill(0);
let given      = new Array(81).fill(false);
let notes      = Array.from({ length: 81 }, () => new Set());
let selectedCell   = -1;
let notesMode      = false;
let difficulty     = 'medium';
let undoStack      = [];
let redoStack      = [];
let elapsedSeconds = 0;
let timerInterval  = null;
let timerStarted   = false;
let hintsRemaining = 0;
let hintsUsed      = 0;
let errorCount     = 0;
let timerHidden    = false;
let gameActive     = false;
let isAssisted     = false;
let prevConflicts  = new Set();
let completedBoxes = new Set();
let completedRows  = new Set();
let completedCols  = new Set();

/* ── UTILS ───────────────────────────────────────────────────────────────────── */
const delay = ms => new Promise(r => setTimeout(r, ms));

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getCellEl(idx) {
  return document.querySelector(`.sudoku-cell[data-idx="${idx}"]`);
}

function formatTime(s) {
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
}

/* ── PEERS LOOKUP TABLE ──────────────────────────────────────────────────────── */
const PEERS = Array.from({ length: 81 }, (_, idx) => {
  const row = Math.floor(idx / 9), col = idx % 9;
  const br  = Math.floor(row / 3) * 3, bc = Math.floor(col / 3) * 3;
  const s   = new Set();
  for (let i = 0; i < 9; i++) {
    s.add(row * 9 + i);
    s.add(i * 9 + col);
    s.add((br + Math.floor(i / 3)) * 9 + bc + (i % 3));
  }
  s.delete(idx);
  return s;
});

/* ── PUZZLE GENERATION ────────────────────────────────────────────────────────── */
function isValidAt(g, idx, digit) {
  const row = Math.floor(idx / 9), col = idx % 9;
  const br  = Math.floor(row / 3) * 3, bc = Math.floor(col / 3) * 3;
  for (let i = 0; i < 9; i++) {
    if (g[row * 9 + i] === digit) return false;
    if (g[i * 9 + col] === digit) return false;
    if (g[(br + Math.floor(i / 3)) * 9 + bc + (i % 3)] === digit) return false;
  }
  return true;
}

function generateSolvedGrid() {
  const g = new Array(81).fill(0);

  function backtrack(pos) {
    if (pos === 81) return true;
    if (g[pos] !== 0) return backtrack(pos + 1);
    for (const d of shuffle([1, 2, 3, 4, 5, 6, 7, 8, 9])) {
      if (isValidAt(g, pos, d)) {
        g[pos] = d;
        if (backtrack(pos + 1)) return true;
        g[pos] = 0;
      }
    }
    return false;
  }

  backtrack(0);
  return g;
}

/** Count solutions (stops at limit); uses MRV heuristic for speed. */
function countSolutions(puzzle, limit = 2) {
  const g = [...puzzle];
  let count = 0;

  function solve() {
    if (count >= limit) return;
    let minCell = -1, minCnt = 10;
    for (let i = 0; i < 81; i++) {
      if (g[i] !== 0) continue;
      let cnt = 0;
      for (let d = 1; d <= 9; d++) if (isValidAt(g, i, d)) cnt++;
      if (cnt === 0) return;
      if (cnt < minCnt) { minCnt = cnt; minCell = i; if (minCnt === 1) break; }
    }
    if (minCell === -1) { count++; return; }
    for (let d = 1; d <= 9; d++) {
      if (count >= limit) return;
      if (isValidAt(g, minCell, d)) { g[minCell] = d; solve(); g[minCell] = 0; }
    }
  }

  solve();
  return count;
}

function generatePuzzle(diff) {
  const sol    = generateSolvedGrid();
  const puzzle = [...sol];
  const cfg    = DIFF_CFG[diff];
  const target = cfg.clues[0] + Math.floor(Math.random() * (cfg.clues[1] - cfg.clues[0] + 1));
  let clues    = 81;

  for (const pos of shuffle([...Array(81).keys()])) {
    if (clues <= target) break;
    const backup = puzzle[pos];
    puzzle[pos] = 0;
    if (countSolutions([...puzzle], 2) !== 1) { puzzle[pos] = backup; }
    else clues--;
  }

  return { puzzle, solution: sol };
}

/* ── GRID BUILDER ─────────────────────────────────────────────────────────────── */
function buildGrid() {
  const gridEl = document.getElementById('sudokuGrid');
  gridEl.innerHTML = '';

  for (let i = 0; i < 81; i++) {
    const row = Math.floor(i / 9), col = i % 9;
    const cell = document.createElement('div');
    cell.className = 'sudoku-cell';
    cell.dataset.idx = i;
    if (col === 2 || col === 5) cell.classList.add('box-right');
    if (row === 2 || row === 5) cell.classList.add('box-bottom');

    const digitEl = document.createElement('div');
    digitEl.className = 'cell-digit';

    const notesEl = document.createElement('div');
    notesEl.className = 'cell-notes';
    for (let n = 1; n <= 9; n++) {
      const span = document.createElement('span');
      span.className = 'note-digit';
      span.dataset.n = n;
      span.textContent = n;
      notesEl.appendChild(span);
    }

    cell.appendChild(digitEl);
    cell.appendChild(notesEl);
    cell.addEventListener('click', e => onCellClick(e, i));
    gridEl.appendChild(cell);
  }
}

function onCellClick(e, idx) {
  if (!gameActive) return;

  // Ripple
  const cell = e.currentTarget;
  const ripple = document.createElement('div');
  ripple.className = 'cell-ripple';
  const rect = cell.getBoundingClientRect();
  ripple.style.setProperty('--rx', (e.clientX - rect.left) + 'px');
  ripple.style.setProperty('--ry', (e.clientY - rect.top) + 'px');
  cell.appendChild(ripple);
  setTimeout(() => ripple.remove(), 600);

  selectCell(idx);
}

/* ── RENDERING ────────────────────────────────────────────────────────────────── */
function renderCell(idx) {
  const cell = getCellEl(idx);
  if (!cell) return;
  const digitEl = cell.querySelector('.cell-digit');
  const notesEl = cell.querySelector('.cell-notes');
  const val = grid[idx];
  const noteSet = notes[idx];

  cell.classList.toggle('given', given[idx]);
  cell.classList.toggle('has-digit', val !== 0);

  if (val !== 0) {
    digitEl.textContent = val;
    notesEl.style.display = 'none';
  } else {
    digitEl.textContent = '';
    notesEl.style.display = 'grid';
    for (let n = 1; n <= 9; n++) {
      const span = notesEl.querySelector(`[data-n="${n}"]`);
      span.classList.toggle('active', noteSet.has(n));
    }
  }
}

function renderAllCells() {
  for (let i = 0; i < 81; i++) renderCell(i);
}

function animateDigitPop(idx) {
  const cell = getCellEl(idx);
  if (!cell) return;
  const digitEl = cell.querySelector('.cell-digit');
  digitEl.classList.remove('pop');
  void digitEl.offsetWidth;
  digitEl.classList.add('pop');
  setTimeout(() => digitEl.classList.remove('pop'), 380);
}

/* ── SELECTION & HIGHLIGHTS ───────────────────────────────────────────────────── */
function selectCell(idx) {
  selectedCell = idx;
  updateHighlights();
}

function updateHighlights() {
  const cells = document.querySelectorAll('.sudoku-cell');

  // Remove all selection-related classes (preserve state classes like conflict/shake)
  cells.forEach(c => c.classList.remove('highlight', 'same-digit', 'selected'));

  if (selectedCell < 0) return;
  const row = Math.floor(selectedCell / 9), col = selectedCell % 9;
  const br  = Math.floor(row / 3) * 3,     bc  = Math.floor(col / 3) * 3;
  const digit = grid[selectedCell];

  cells.forEach((c, i) => {
    if (i === selectedCell) { c.classList.add('selected'); return; }
    const r = Math.floor(i / 9), cl = i % 9;
    if (r === row || cl === col || (Math.floor(r/3)*3 === br && Math.floor(cl/3)*3 === bc)) {
      c.classList.add('highlight');
    }
    if (digit !== 0 && grid[i] === digit) c.classList.add('same-digit');
  });
}

/* ── CONFLICT DETECTION ───────────────────────────────────────────────────────── */
function getConflicts() {
  const out = new Set();
  for (let i = 0; i < 81; i++) {
    if (grid[i] === 0) continue;
    for (const p of PEERS[i]) {
      if (grid[p] === grid[i]) { out.add(i); out.add(p); }
    }
  }
  return out;
}

function updateConflicts() {
  const cur = getConflicts();
  for (const i of prevConflicts) { const c = getCellEl(i); if (c) c.classList.remove('conflict'); }
  for (const i of cur)           { const c = getCellEl(i); if (c) c.classList.add('conflict'); }
  prevConflicts = cur;
}

/* ── DIGIT INPUT ──────────────────────────────────────────────────────────────── */
function enterDigit(digit) {
  if (selectedCell < 0 || !gameActive) return;
  if (given[selectedCell]) return;

  if (notesMode) { enterNote(digit); return; }
  if (grid[selectedCell] === digit) return;

  pushUndo();
  if (!timerStarted) startTimer();

  grid[selectedCell] = digit;
  notes[selectedCell].clear();
  renderCell(selectedCell);
  animateDigitPop(selectedCell);
  autoRemoveNotes(selectedCell, digit);

  const before = new Set(prevConflicts);
  updateConflicts();
  const newConflict = [...prevConflicts].some(i => !before.has(i));

  if (newConflict) {
    errorCount++;
    const toShake = new Set([selectedCell, ...prevConflicts]);
    toShake.forEach(i => {
      const c = getCellEl(i);
      if (!c) return;
      c.classList.remove('shake');
      void c.offsetWidth;
      c.classList.add('shake');
      setTimeout(() => c.classList.remove('shake'), 520);
    });
  } else if (digit !== 0 && digit === solution[selectedCell]) {
    const c = getCellEl(selectedCell);
    flashCell(c, 'correct');
    checkCompletions(selectedCell);
  }

  updateNumpadDimming();
  updateHighlights();
  saveGame();
  if (checkWin()) triggerWinSequence();
}

function eraseCell() {
  if (selectedCell < 0 || !gameActive) return;
  if (given[selectedCell]) return;
  if (grid[selectedCell] === 0 && notes[selectedCell].size === 0) return;

  pushUndo();

  const cell = getCellEl(selectedCell);
  cell.classList.add('cell-erasing');
  setTimeout(() => cell.classList.remove('cell-erasing'), 280);

  grid[selectedCell] = 0;
  notes[selectedCell].clear();
  renderCell(selectedCell);
  updateConflicts();
  updateHighlights();
  updateNumpadDimming();
  saveGame();
}

/* ── NOTES ────────────────────────────────────────────────────────────────────── */
function enterNote(digit) {
  if (selectedCell < 0 || !gameActive) return;
  if (given[selectedCell]) return;
  if (grid[selectedCell] !== 0) return;

  if (!timerStarted) startTimer();
  pushUndo();

  const ns = notes[selectedCell];
  if (ns.has(digit)) {
    ns.delete(digit);
  } else {
    ns.add(digit);
    // Brief appear animation on new note
    renderCell(selectedCell);
    const span = getCellEl(selectedCell)?.querySelector(`.note-digit[data-n="${digit}"]`);
    if (span) {
      span.classList.add('just-added');
      setTimeout(() => span.classList.remove('just-added'), 200);
    }
    updateHighlights();
    saveGame();
    return;
  }

  renderCell(selectedCell);
  updateHighlights();
  saveGame();
}

function autoRemoveNotes(idx, digit) {
  if (!digit) return;
  for (const peer of PEERS[idx]) {
    if (!notes[peer].has(digit)) continue;
    notes[peer].delete(digit);
    const cell = getCellEl(peer);
    if (cell) {
      const span = cell.querySelector(`.note-digit[data-n="${digit}"]`);
      if (span && span.classList.contains('active')) {
        span.classList.add('note-removing');
        setTimeout(() => span.classList.remove('note-removing'), 280);
      }
    }
    renderCell(peer);
  }
}

/* ── COMPLETION CHECKS ────────────────────────────────────────────────────────── */
function checkCompletions(idx) {
  const row = Math.floor(idx / 9), col = idx % 9;
  const br  = Math.floor(row / 3) * 3, bc = Math.floor(col / 3) * 3;
  const boxKey = `${br},${bc}`;

  if (!completedBoxes.has(boxKey)) {
    const cells = [];
    for (let r = br; r < br + 3; r++)
      for (let c = bc; c < bc + 3; c++)
        cells.push(r * 9 + c);
    if (cells.every(i => grid[i] !== 0 && grid[i] === solution[i])) {
      completedBoxes.add(boxKey);
      animateBoxComplete(cells);
    }
  }
  if (!completedRows.has(row)) {
    const cells = Array.from({ length: 9 }, (_, c) => row * 9 + c);
    if (cells.every(i => grid[i] !== 0 && grid[i] === solution[i])) {
      completedRows.add(row);
      animateRowComplete(row);
    }
  }
  if (!completedCols.has(col)) {
    const cells = Array.from({ length: 9 }, (_, r) => r * 9 + col);
    if (cells.every(i => grid[i] !== 0 && grid[i] === solution[i])) {
      completedCols.add(col);
      animateColComplete(col);
    }
  }
}

/* ── WIN DETECTION ────────────────────────────────────────────────────────────── */
function checkWin() {
  for (let i = 0; i < 81; i++) if (grid[i] !== solution[i]) return false;
  return prevConflicts.size === 0;
}

/* ── UNDO / REDO ──────────────────────────────────────────────────────────────── */
function snapshot() {
  return { grid: [...grid], notes: notes.map(s => new Set(s)) };
}

function pushUndo() {
  undoStack.push(snapshot());
  if (undoStack.length > 100) undoStack.shift();
  redoStack = [];
}

function undo() {
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  const prev = undoStack.pop();
  grid = prev.grid; notes = prev.notes;
  renderAllCells(); updateConflicts(); updateHighlights(); updateNumpadDimming(); saveGame();
  if (selectedCell >= 0) flashCell(getCellEl(selectedCell), 'undo');
}

function redo() {
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  const next = redoStack.pop();
  grid = next.grid; notes = next.notes;
  renderAllCells(); updateConflicts(); updateHighlights(); updateNumpadDimming(); saveGame();
  if (selectedCell >= 0) flashCell(getCellEl(selectedCell), 'redo');
}

/* ── HINT SYSTEM ──────────────────────────────────────────────────────────────── */
function getBestHintCell() {
  let best = -1, minCnt = 10;
  for (let i = 0; i < 81; i++) {
    if (grid[i] !== 0 || given[i]) continue;
    let cnt = 0;
    for (let d = 1; d <= 9; d++) if (isValidAt(grid, i, d)) cnt++;
    if (cnt < minCnt) { minCnt = cnt; best = i; }
  }
  return best;
}

function requestHint() {
  if (!gameActive || hintsRemaining <= 0) return;
  const hintCell = getBestHintCell();
  if (hintCell < 0) return;

  if (!timerStarted) startTimer();
  pushUndo();
  hintsRemaining--;
  hintsUsed++;
  isAssisted = true;

  grid[hintCell] = solution[hintCell];
  notes[hintCell].clear();
  given[hintCell] = true;
  autoRemoveNotes(hintCell, solution[hintCell]);
  renderCell(hintCell);

  const cell = getCellEl(hintCell);
  if (cell) {
    cell.classList.add('hint-glow');
    const digitEl = cell.querySelector('.cell-digit');
    digitEl.classList.add('hint-anim');
    setTimeout(() => { cell.classList.remove('hint-glow'); digitEl.classList.remove('hint-anim'); }, 2500);
  }

  updateConflicts(); updateHighlights(); updateNumpadDimming(); updateHintUI();
  checkCompletions(hintCell);
  saveGame();
  if (checkWin()) triggerWinSequence();
}

function updateHintUI() {
  const el = document.getElementById('hintsLeft');
  if (el) el.textContent = hintsRemaining;
  const btnHint = document.getElementById('btnHint');
  if (btnHint) btnHint.disabled = hintsRemaining <= 0;
}

/* ── TIMER ────────────────────────────────────────────────────────────────────── */
function startTimer() {
  if (timerInterval) return;
  timerStarted = true;
  timerInterval = setInterval(() => {
    elapsedSeconds++;
    updateTimerDisplay();
    if (elapsedSeconds % 30 === 0) saveGame();
  }, 1000);
}

function stopTimer()  { clearInterval(timerInterval); timerInterval = null; }
function pauseTimer() { stopTimer(); }
function resumeTimer() {
  if (timerStarted && gameActive && !timerInterval)
    timerInterval = setInterval(() => { elapsedSeconds++; updateTimerDisplay(); }, 1000);
}

function updateTimerDisplay() {
  const el = document.getElementById('timerDisplay');
  if (!el) return;
  const txt = formatTime(elapsedSeconds);
  if (el.textContent !== txt) {
    el.textContent = txt;
    el.classList.remove('timer-tick');
    void el.offsetWidth;
    el.classList.add('timer-tick');
    setTimeout(() => el.classList.remove('timer-tick'), 200);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.hidden) pauseTimer();
  else if (gameActive) resumeTimer();
});

/* ── SCORE ────────────────────────────────────────────────────────────────────── */
function calculateScore() {
  const cfg       = DIFF_CFG[difficulty];
  const base      = Math.max(0, 10000 - elapsedSeconds * 2);
  const withMult  = Math.round(base * cfg.mult);
  const hintPen   = hintsUsed  * 500;
  const errorPen  = errorCount * 100;
  const total     = Math.max(100, withMult - hintPen - errorPen);
  return { base: Math.round(base), withMult, hintPen, errorPen, total };
}

function getStars(score) {
  const max = 10000 * DIFF_CFG[difficulty].mult;
  if (score / max >= 0.8) return 3;
  if (score / max >= 0.4) return 2;
  return 1;
}

/* ── WIN SEQUENCE ─────────────────────────────────────────────────────────────── */
async function triggerWinSequence() {
  gameActive = false;
  stopTimer();

  const scoreData = calculateScore();
  updateStats(scoreData.total);
  try { reportScore('sudoku', scoreData.total); } catch {}
  localStorage.removeItem(SAVE_KEY);

  await delay(300);

  // Bloom from center outward
  const rings = getRingsFromCenter(40);
  rings.forEach((ring, ri) => {
    ring.forEach(idx => {
      setTimeout(() => {
        const c = getCellEl(idx);
        if (!c) return;
        c.classList.remove('win-bloom');
        void c.offsetWidth;
        c.classList.add('win-bloom');
      }, ri * 50);
    });
  });

  await delay(rings.length * 50 + 100);

  launchConfetti();

  for (let row = 0; row < 9; row++)
    setTimeout(() => animateRowShimmer(row), row * 80);

  await delay(650);
  showWinCard(scoreData);
}

function getRingsFromCenter(center) {
  const rings = [], visited = new Set([center]);
  let cur = [center];
  while (cur.length) {
    rings.push([...cur]);
    const next = [];
    const dirs = [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]];
    for (const idx of cur) {
      const r = Math.floor(idx / 9), c = idx % 9;
      for (const [dr, dc] of dirs) {
        const nr = r + dr, nc = c + dc;
        if (nr < 0 || nr > 8 || nc < 0 || nc > 8) continue;
        const ni = nr * 9 + nc;
        if (!visited.has(ni)) { visited.add(ni); next.push(ni); }
      }
    }
    cur = next;
  }
  return rings;
}

/* ── ANIMATIONS ───────────────────────────────────────────────────────────────── */
function flashCell(cellEl, type) {
  if (!cellEl) return;
  const cls = { correct: 'flash-correct', undo: 'flash-undo', redo: 'flash-redo' }[type];
  if (!cls) return;
  cellEl.classList.remove(cls);
  void cellEl.offsetWidth;
  cellEl.classList.add(cls);
  setTimeout(() => cellEl.classList.remove(cls), 420);
}

function animateBoxComplete(boxCells) {
  boxCells.forEach((idx, i) => {
    setTimeout(() => {
      const c = getCellEl(idx);
      if (!c) return;
      c.classList.remove('box-complete');
      void c.offsetWidth;
      c.classList.add('box-complete');
      setTimeout(() => c.classList.remove('box-complete'), 750);
    }, i * 50);
  });
}

function animateRowComplete(row) { animateRowShimmer(row); }

function animateColComplete(col) {
  for (let r = 0; r < 9; r++) {
    setTimeout(() => {
      const c = getCellEl(r * 9 + col);
      if (!c) return;
      c.classList.add('shimmer');
      setTimeout(() => c.classList.remove('shimmer'), 400);
    }, r * 40);
  }
}

function animateRowShimmer(row) {
  for (let col = 0; col < 9; col++) {
    setTimeout(() => {
      const c = getCellEl(row * 9 + col);
      if (!c) return;
      c.classList.add('shimmer');
      setTimeout(() => c.classList.remove('shimmer'), 400);
    }, col * 40);
  }
}

/* ── CONFETTI ─────────────────────────────────────────────────────────────────── */
function launchConfetti() {
  const canvas = document.getElementById('confettiCanvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  const gridEl = document.getElementById('sudokuGrid');
  const rect = gridEl.getBoundingClientRect();
  canvas.width  = rect.width;
  canvas.height = rect.height;
  canvas.style.display = 'block';

  const COLORS = ['#a78bfa','#7c3aed','#67e8f9','#06b6d4','#fbbf24','#34d399','#f472b6','#fb923c'];
  const particles = Array.from({ length: 90 }, () => ({
    x: canvas.width / 2, y: canvas.height / 2,
    vx: (Math.random() - 0.5) * 15,
    vy: (Math.random() - 0.5) * 15 - 5,
    color: COLORS[Math.floor(Math.random() * COLORS.length)],
    w: 6 + Math.random() * 8, h: 3 + Math.random() * 4,
    rot: Math.random() * 360, rotV: (Math.random() - 0.5) * 10,
    alpha: 1, gravity: 0.28,
  }));

  let frame = 0;
  function animate() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    frame++;
    let alive = false;
    for (const p of particles) {
      p.vy += p.gravity; p.x += p.vx; p.y += p.vy; p.rot += p.rotV;
      if (frame > 55) p.alpha = Math.max(0, p.alpha - 0.016);
      if (p.alpha > 0) alive = true;
      ctx.save();
      ctx.globalAlpha = p.alpha;
      ctx.translate(p.x, p.y);
      ctx.rotate(p.rot * Math.PI / 180);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h);
      ctx.restore();
    }
    if (alive && frame < 210) requestAnimationFrame(animate);
    else { ctx.clearRect(0, 0, canvas.width, canvas.height); canvas.style.display = 'none'; }
  }
  requestAnimationFrame(animate);
}

/* ── WIN CARD ──────────────────────────────────────────────────────────────────── */
function showWinCard(scoreData) {
  const cfg   = DIFF_CFG[difficulty];
  const stars = getStars(scoreData.total);

  document.getElementById('winStars').innerHTML = [1,2,3].map(i =>
    `<span class="win-star ${i <= stars ? 'active' : ''}" style="animation-delay:${(i-1)*0.15}s">${i <= stars ? '⭐' : '☆'}</span>`
  ).join('');

  document.getElementById('winTime').innerHTML =
    `<span class="win-label">Time</span><span class="win-value">${formatTime(elapsedSeconds)}</span>`;

  document.getElementById('winBreakdown').innerHTML = `
    <div class="breakdown-row"><span>Base Score</span><span>${scoreData.base.toLocaleString()}</span></div>
    <div class="breakdown-row"><span>${cfg.label} ×${cfg.mult}</span><span>${scoreData.withMult.toLocaleString()}</span></div>
    ${scoreData.hintPen  > 0 ? `<div class="breakdown-row penalty"><span>Hints (${hintsUsed}×−500)</span><span>−${scoreData.hintPen.toLocaleString()}</span></div>` : ''}
    ${scoreData.errorPen > 0 ? `<div class="breakdown-row penalty"><span>Errors (${errorCount}×−100)</span><span>−${scoreData.errorPen.toLocaleString()}</span></div>` : ''}
    <div class="breakdown-row total"><span>Total</span><span>${scoreData.total.toLocaleString()}</span></div>
  `;

  document.getElementById('winBadges').innerHTML = [
    isAssisted
      ? '<span class="win-badge assisted">📝 Assisted</span>'
      : '<span class="win-badge clean">✨ Clean Solve</span>',
    hintsUsed === 0 && errorCount === 0 ? '<span class="win-badge perfect">🏆 Perfect</span>' : '',
    `<span class="win-badge diff" style="background:${cfg.color}1a;color:${cfg.color};border-color:${cfg.color}66">${cfg.emoji} ${cfg.label}</span>`,
  ].filter(Boolean).join('');

  const modal = document.getElementById('winModal');
  modal.style.display = 'flex';
  setTimeout(() => modal.classList.add('show'), 10);
}

/* ── STATS ────────────────────────────────────────────────────────────────────── */
function defaultStats() {
  const d = {};
  for (const k of Object.keys(DIFF_CFG))
    d[k] = { played: 0, completed: 0, assisted: 0, bestTime: null, recentTimes: [], streak: 0, bestStreak: 0, totalScore: 0 };
  return { byDiff: d, global: { totalCompleted: 0, totalTimePlayed: 0, totalHintsUsed: 0 } };
}

function loadStats() {
  try { return JSON.parse(localStorage.getItem(STATS_KEY)) || defaultStats(); }
  catch { return defaultStats(); }
}

function updateStats(score) {
  const stats = loadStats();
  const d = stats.byDiff[difficulty];
  d.played++;
  d.completed++;
  if (isAssisted) d.assisted++;
  if (d.bestTime === null || elapsedSeconds < d.bestTime) d.bestTime = elapsedSeconds;
  d.recentTimes.push(elapsedSeconds);
  if (d.recentTimes.length > 10) d.recentTimes.shift();
  d.streak++;
  if (d.streak > d.bestStreak) d.bestStreak = d.streak;
  d.totalScore += score;
  stats.global.totalCompleted++;
  stats.global.totalTimePlayed += elapsedSeconds;
  stats.global.totalHintsUsed  += hintsUsed;
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch {}
}

function renderStats(diff) {
  const stats = loadStats();
  const d = stats.byDiff[diff] || defaultStats().byDiff[diff];
  const avg = d.recentTimes.length ? Math.round(d.recentTimes.reduce((a,b)=>a+b,0) / d.recentTimes.length) : null;
  const avgScore = d.completed ? Math.round(d.totalScore / d.completed) : 0;

  document.getElementById('statsCards').innerHTML = `
    <div class="stat-grid">
      <div class="stat-item"><div class="stat-value">${d.played}</div><div class="stat-label">Played</div></div>
      <div class="stat-item"><div class="stat-value">${d.completed}</div><div class="stat-label">Completed</div></div>
      <div class="stat-item"><div class="stat-value">${d.completed - d.assisted}</div><div class="stat-label">Clean Solves</div></div>
      <div class="stat-item"><div class="stat-value">${d.bestTime !== null ? formatTime(d.bestTime) : '—'}</div><div class="stat-label">Best Time</div></div>
      <div class="stat-item"><div class="stat-value">${avg !== null ? formatTime(avg) : '—'}</div><div class="stat-label">Avg Time</div></div>
      <div class="stat-item"><div class="stat-value">${d.streak}</div><div class="stat-label">Streak</div></div>
      <div class="stat-item"><div class="stat-value">${d.bestStreak}</div><div class="stat-label">Best Streak</div></div>
      <div class="stat-item"><div class="stat-value">${avgScore ? avgScore.toLocaleString() : '—'}</div><div class="stat-label">Avg Score</div></div>
    </div>`;

  const g = stats.global;
  document.getElementById('statsGlobal').innerHTML = `
    <h3 class="global-stats-title">Global</h3>
    <div class="stat-grid">
      <div class="stat-item"><div class="stat-value">${g.totalCompleted}</div><div class="stat-label">Total Completed</div></div>
      <div class="stat-item"><div class="stat-value">${formatTime(g.totalTimePlayed)}</div><div class="stat-label">Total Time</div></div>
      <div class="stat-item"><div class="stat-value">${g.totalHintsUsed}</div><div class="stat-label">Hints Used</div></div>
    </div>`;
}

/* ── SAVE / LOAD ──────────────────────────────────────────────────────────────── */
function saveGame() {
  const data = {
    grid: [...grid], solution: [...solution], given: [...given],
    notes: notes.map(s => [...s]), difficulty,
    elapsedSeconds, hintsRemaining, hintsUsed, errorCount, isAssisted, timerStarted,
    undoStack: undoStack.map(s => ({ grid: [...s.grid], notes: s.notes.map(n => [...n]) })),
    redoStack: redoStack.map(s => ({ grid: [...s.grid], notes: s.notes.map(n => [...n]) })),
  };
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(data)); } catch {}
}

function hasSave() {
  try { return !!localStorage.getItem(SAVE_KEY); } catch { return false; }
}

function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return false;
    const d = JSON.parse(raw);
    grid           = d.grid;
    solution       = d.solution;
    given          = d.given;
    notes          = d.notes.map(a => new Set(a));
    difficulty     = d.difficulty;
    elapsedSeconds = d.elapsedSeconds;
    hintsRemaining = d.hintsRemaining;
    hintsUsed      = d.hintsUsed;
    errorCount     = d.errorCount || 0;
    isAssisted     = d.isAssisted || false;
    timerStarted   = d.timerStarted || false;
    undoStack      = (d.undoStack || []).map(s => ({ grid: [...s.grid], notes: s.notes.map(n => new Set(n)) }));
    redoStack      = (d.redoStack || []).map(s => ({ grid: [...s.grid], notes: s.notes.map(n => new Set(n)) }));
    return true;
  } catch { return false; }
}

/* ── NUMPAD ───────────────────────────────────────────────────────────────────── */
function buildNumpad() {
  const numpad = document.getElementById('numpad');
  if (!numpad) return;
  numpad.innerHTML = '';

  for (let d = 1; d <= 9; d++) {
    const btn = document.createElement('button');
    btn.className = 'numpad-btn';
    btn.dataset.digit = d;
    btn.textContent = d;
    btn.addEventListener('mousedown',  () => btn.classList.add('pressed'));
    btn.addEventListener('mouseup',    () => { btn.classList.remove('pressed'); enterDigit(d); });
    btn.addEventListener('mouseleave', () => btn.classList.remove('pressed'));
    btn.addEventListener('touchstart', e => { e.preventDefault(); btn.classList.add('pressed'); enterDigit(d); }, { passive: false });
    btn.addEventListener('touchend',   () => btn.classList.remove('pressed'));
    numpad.appendChild(btn);
  }

  const eraseBtn = document.createElement('button');
  eraseBtn.className = 'numpad-btn erase-btn';
  eraseBtn.id = 'btnErase';
  eraseBtn.textContent = '⌫';
  eraseBtn.addEventListener('click', eraseCell);
  numpad.appendChild(eraseBtn);

  const notesBtn = document.createElement('button');
  notesBtn.className = 'numpad-btn notes-btn';
  notesBtn.id = 'btnNotes';
  notesBtn.innerHTML = '<span class="notes-icon">✏️</span><span class="notes-label">Notes</span>';
  notesBtn.addEventListener('click', toggleNotes);
  numpad.appendChild(notesBtn);
}

function updateNumpadDimming() {
  for (let d = 1; d <= 9; d++) {
    const btn = document.querySelector(`.numpad-btn[data-digit="${d}"]`);
    if (btn) btn.classList.toggle('dimmed', grid.filter(v => v === d).length === 9);
  }
}

function toggleNotes() {
  notesMode = !notesMode;
  const btn = document.getElementById('btnNotes');
  if (btn) btn.classList.toggle('active', notesMode);
}

/* ── SCREEN SWITCHING ─────────────────────────────────────────────────────────── */
function showScreen(id) {
  ['hubScreen','gameScreen','statsScreen'].forEach(s => {
    document.getElementById(s).style.display = s === id ? '' : 'none';
  });
}

function showHub() {
  showScreen('hubScreen');
  document.getElementById('btnContinue').style.display = hasSave() ? '' : 'none';
}

function showGame() {
  showScreen('gameScreen');
  updateDiffBadge();
  updateHintUI();
  updateTimerDisplay();
}

function showStats(fromGame = false) {
  showScreen('statsScreen');
  renderStats(difficulty);
  document.querySelectorAll('.stats-tab').forEach(t => t.classList.toggle('active', t.dataset.diff === difficulty));
}

function updateDiffBadge() {
  const cfg = DIFF_CFG[difficulty];
  const el  = document.getElementById('diffBadge');
  if (!el) return;
  el.textContent = `${cfg.emoji} ${cfg.label}`;
  el.style.color = cfg.color;
  el.style.borderColor = cfg.color + '55';
  el.style.backgroundColor = cfg.color + '12';
}

/* ── GAME START / CONTINUE ────────────────────────────────────────────────────── */
function startNewGame() {
  stopTimer();
  timerStarted = timerHidden = false;
  timerInterval = null;
  elapsedSeconds = selectedCell = 0;
  selectedCell = -1;
  notesMode = isAssisted = false;
  undoStack = []; redoStack = [];
  completedBoxes = new Set(); completedRows = new Set(); completedCols = new Set();
  prevConflicts = new Set();
  errorCount = 0;
  hintsRemaining = DIFF_CFG[difficulty].hints;
  hintsUsed = 0;
  gameActive = false;

  showGame();
  const gridEl = document.getElementById('sudokuGrid');
  gridEl.innerHTML = '<div class="sk-generating"><div class="sk-spinner"></div><p>Generating puzzle…</p></div>';

  setTimeout(() => {
    const { puzzle, solution: sol } = generatePuzzle(difficulty);
    grid     = puzzle;
    solution = sol;
    given    = puzzle.map(v => v !== 0);
    notes    = Array.from({ length: 81 }, () => new Set());
    gameActive = true;

    buildGrid();
    renderAllCells();
    updateConflicts();
    buildNumpad();
    updateNumpadDimming();

    const timerEl = document.getElementById('timerDisplay');
    if (timerEl) { timerEl.textContent = '0:00'; timerEl.classList.remove('hidden'); }
    document.getElementById('btnTimerToggle').textContent = '👁';
    timerHidden = false;

    saveGame();
  }, 80);
}

function continueGame() {
  if (!loadSave()) { startNewGame(); return; }
  gameActive = true;
  completedBoxes = new Set(); completedRows = new Set(); completedCols = new Set();
  buildGrid();
  renderAllCells();
  updateConflicts();
  buildNumpad();
  updateNumpadDimming();
  showGame();
  if (timerStarted) startTimer();
}

/* ── PAUSE MODAL ──────────────────────────────────────────────────────────────── */
function openPause() {
  if (!gameActive) return;
  pauseTimer();
  document.getElementById('pauseModal').style.display = 'flex';
}
function closePause() {
  document.getElementById('pauseModal').style.display = 'none';
  if (gameActive) resumeTimer();
}

/* ── KEYBOARD ─────────────────────────────────────────────────────────────────── */
document.addEventListener('keydown', e => {
  if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
  const inGame = document.getElementById('gameScreen').style.display !== 'none';
  if (!inGame || !gameActive) return;

  if (e.key >= '1' && e.key <= '9') { e.preventDefault(); enterDigit(+e.key); return; }
  if (e.key === 'Backspace' || e.key === 'Delete') { e.preventDefault(); eraseCell(); return; }
  if ((e.key === 'n' || e.key === 'N') && !e.ctrlKey) { e.preventDefault(); toggleNotes(); return; }
  if ((e.key === 'h' || e.key === 'H') && !e.ctrlKey) { e.preventDefault(); requestHint(); return; }
  if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); return; }
  if (e.ctrlKey && (e.key === 'y' || e.key === 'Y')) { e.preventDefault(); redo(); return; }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (document.getElementById('pauseModal').style.display !== 'none') closePause();
    else openPause();
    return;
  }
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(e.key) && selectedCell >= 0) {
    e.preventDefault();
    const r = Math.floor(selectedCell / 9), c = selectedCell % 9;
    let nr = r, nc = c;
    if (e.key === 'ArrowUp')    nr = Math.max(0, r - 1);
    if (e.key === 'ArrowDown')  nr = Math.min(8, r + 1);
    if (e.key === 'ArrowLeft')  nc = Math.max(0, c - 1);
    if (e.key === 'ArrowRight') nc = Math.min(8, c + 1);
    selectCell(nr * 9 + nc);
  }
});

/* ── BUTTON WIRING ────────────────────────────────────────────────────────────── */
document.getElementById('btnBackToLobby').addEventListener('click',  () => { window.location.href = '/'; });
document.getElementById('btnNewGame').addEventListener('click',       startNewGame);
document.getElementById('btnContinue').addEventListener('click',      continueGame);
document.getElementById('btnStats').addEventListener('click',         () => showStats());
document.getElementById('btnBackToHub').addEventListener('click',     () => { pauseTimer(); showHub(); });
document.getElementById('btnUndo').addEventListener('click',          undo);
document.getElementById('btnRedo').addEventListener('click',          redo);
document.getElementById('btnHint').addEventListener('click',          requestHint);
document.getElementById('btnPause').addEventListener('click',         openPause);

document.getElementById('btnTimerToggle').addEventListener('click', () => {
  timerHidden = !timerHidden;
  document.getElementById('timerDisplay').classList.toggle('hidden', timerHidden);
  document.getElementById('btnTimerToggle').textContent = timerHidden ? '🙈' : '👁';
});

// Pause modal
document.getElementById('btnResume').addEventListener('click',          closePause);
document.getElementById('btnNewGameFromPause').addEventListener('click', () => { document.getElementById('pauseModal').style.display = 'none'; startNewGame(); });
document.getElementById('btnChangeDiff').addEventListener('click',       () => { document.getElementById('pauseModal').style.display = 'none'; stopTimer(); showHub(); });
document.getElementById('btnStatsFromPause').addEventListener('click',   () => { document.getElementById('pauseModal').style.display = 'none'; stopTimer(); showStats(); });

// Win modal
document.getElementById('btnNewGameFromWin').addEventListener('click', () => {
  document.getElementById('winModal').style.display = 'none';
  document.getElementById('winModal').classList.remove('show');
  startNewGame();
});
document.getElementById('btnStatsFromWin').addEventListener('click', () => {
  document.getElementById('winModal').style.display = 'none';
  document.getElementById('winModal').classList.remove('show');
  showStats();
});

// Stats tabs
document.getElementById('statsTabs').addEventListener('click', e => {
  const tab = e.target.closest('.stats-tab');
  if (!tab) return;
  document.querySelectorAll('.stats-tab').forEach(t => t.classList.toggle('active', t === tab));
  renderStats(tab.dataset.diff);
});

// Stats back
document.getElementById('btnBackFromStats').addEventListener('click', () => {
  gameActive ? showGame() : showHub();
});

// Difficulty selector (hub)
document.getElementById('diffSelector').addEventListener('click', e => {
  const btn = e.target.closest('.diff-btn');
  if (!btn) return;
  difficulty = btn.dataset.diff;
  document.querySelectorAll('.diff-btn').forEach(b => b.classList.toggle('active', b.dataset.diff === difficulty));
});

/* ── INIT ─────────────────────────────────────────────────────────────────────── */
showHub();

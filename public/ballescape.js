/* ═══════════════════════════════════════════════════════════════════
   BALL ESCAPE  —  ballescape.js
   Solo idle-ball game for Game Arena platform.
   No WebSocket · localStorage persistence · infinite procedural levels
   ═══════════════════════════════════════════════════════════════════ */
(() => {
'use strict';

// ═══════════════════════════════════════════════════════
// §1  CONSTANTS
// ═══════════════════════════════════════════════════════
const SAVE_KEY    = 'ballEscape_save';
const FIXED_DT    = 1 / 60;
const TAU         = Math.PI * 2;
const GRAVITY_BASE= 210;        // px/s²
const MIN_SPEED   = 80;         // px/s  soft floor
const MAX_SPEED   = 600;        // px/s  hard cap (lifted during Frenzy)
const RESTITUTION = 1.0;
const RING_THICK  = 10;         // px — thinner rings for more density

// ═══════════════════════════════════════════════════════
// §2  SEEDED RNG  (mulberry32)
// ═══════════════════════════════════════════════════════
function mkRng(seed) {
  let s = seed >>> 0;
  return function() {
    s = Math.imul(s ^ (s >>> 15), s | 1);
    s ^= s + Math.imul(s ^ (s >>> 7), s | 61);
    return ((s ^ (s >>> 14)) >>> 0) / 4294967296;
  };
}

// ═══════════════════════════════════════════════════════
// §3  UPGRADE & ABILITY DEFINITIONS
// ═══════════════════════════════════════════════════════
const UPGRADES = {
  // ── Ball ──────────────────────────────────────────
  ballSpeed:    { cat:'ball', icon:'⚡', name:'Ball Speed',      max:15, cost:n=>Math.floor(80*1.4**n),    desc:'Increases base movement speed. Faster ball means more ring hits per second.',                                              stat:n=>`+${n*8}% speed` },
  damage:       { cat:'ball', icon:'💥', name:'Damage',           max:25, cost:n=>Math.floor(60*1.35**n),   desc:'Increases damage dealt per ring hit.',                                                                                stat:n=>`×${(1+n*.15).toFixed(2)} dmg` },
  bounceEnergy: { cat:'ball', icon:'🔁', name:'Bounce Energy',    max:10, cost:n=>Math.floor(90*1.45**n),   desc:'Each bounce adds a small speed boost. Base restitution is already 1.0; this upgrade pushes it above 1 so the ball accelerates with every hit.',                                                 stat:n=>`restitution ${(RESTITUTION+n*.0015).toFixed(4)}` },
  gapSeeker:    { cat:'ball', icon:'🧲', name:'Gap Seeker',       max:5,  cost:n=>Math.floor(120*1.5**n),   desc:'Ball steers subtly toward gaps when nearby. Disabled during Frenzy.',                                                   stat:n=>`${n*20}% seek force` },
  ballSize:     { cat:'ball', icon:'🎱', name:'Ball Size',        max:5,  cost:n=>Math.floor(100*1.5**n),   desc:'Larger ball hits more arc surface per collision. Tradeoff: at high upgrade levels the ball may be too wide to fit through shrinking gaps — forcing full-destruction play.', stat:n=>`radius ${8+n*3}px` },
  multiBounce:  { cat:'ball', icon:'🌀', name:'Multi-Bounce',     max:5,  cost:n=>Math.floor(150*1.5**n),   desc:'Each hit has a chance to chain a bonus hit (60% damage) to the next INNER ring.',                                         stat:n=>`${5+n*5}% chain chance` },
  gravityCtrl:  { cat:'ball', icon:'🪂', name:'Gravity Control',  max:8,  cost:n=>Math.floor(110*1.45**n),  desc:'Reduces gravity. Makes movement floatier and more chaotic — pairs well with Frenzy.',                                  stat:n=>`-${n*10}% gravity` },
  // ── Rings ─────────────────────────────────────────
  segWeakness:  { cat:'rings',icon:'💣', name:'Ring Weakness',    max:10, cost:n=>Math.floor(70*1.38**n),   desc:'All rings start each level with reduced HP.',                                                                    stat:n=>`-${n*5}% HP` },
  ringSlow:     { cat:'rings',icon:'🐌', name:'Ring Slow',        max:10, cost:n=>Math.floor(80*1.4**n),    desc:'All rings rotate slower.',                                                                                               stat:n=>`-${n*3}% rotation speed` },
  chainBreak:   { cat:'rings',icon:'🧨', name:'Chain Break',      max:5,  cost:n=>Math.floor(200*1.55**n),  desc:'When a ring is destroyed, deals bonus damage equal to 20-60% max HP to the NEXT outer ring.',           stat:n=>n===0?'Locked':`${20+(n-1)*10}% splash to outer ring` },
  gapWidener:   { cat:'rings',icon:'🔓', name:'Gap Widener',      max:8,  cost:n=>Math.floor(90*1.42**n),   desc:'Procedurally generated gaps are wider. Does not affect boss ring gaps.',                                               stat:n=>`+${n*3}° per gap` },
  weakPoints:   { cat:'rings',icon:'🎯', name:'Weak Points',      max:1,  cost:_=>500,                      desc:'Each ring has a chance to spawn as a weak point at 50% HP, visually marked with a glowing outline.',                          stat:n=>n===0?'Locked':'Active' },
  // ── Economy ───────────────────────────────────────
  goldBoost:    { cat:'econ', icon:'💰', name:'Gold Boost',       max:10, cost:n=>Math.floor(100*1.4**n),   desc:'+12% gold per level completion per upgrade level.',                                                                     stat:n=>`+${n*12}% gold` },
  chestLuck:    { cat:'econ', icon:'🎁', name:'Chest Luck',       max:5,  cost:n=>Math.floor(200*1.5**n),   desc:'Increases chest drop chance and shifts rarity upward.',                                                                 stat:n=>`+${n*5}% drop chance` },
  gemFinder:    { cat:'econ', icon:'💎', name:'Gem Finder',       max:5,  cost:n=>Math.floor(250*1.5**n),   desc:'Chance to find a bonus gem on each ring destruction.',                                                                  stat:n=>`${3+n*3}% per ring` },
  timeBonus:    { cat:'econ', icon:'⏱️', name:'Time Bonus',       max:5,  cost:n=>Math.floor(150*1.45**n),  desc:'Bonus gold for completing levels under the generated par time.',                                                        stat:n=>`+${n*10}% gold if under par` },
};

const ABILITIES = {
  inferno:      { icon:'🔥', name:'Inferno',        cost:10, proc:.08, passive:false, color:'#f97316', desc:'Burns the hit ring with fire damage over time. At lvl 2+ spreads to adjacent rings.',          levelCost:n=>Math.floor(100*1.45**n), procLabel:n=>`${Math.round((.08+n*.01)*100)}%` },
  freeze:       { icon:'❄️', name:'Freeze',         cost:15, proc:.06, passive:false, color:'#67e8f9', desc:'The current ring stops rotating for 2+ seconds.',                   levelCost:n=>Math.floor(120*1.45**n), procLabel:n=>`${Math.round((.06+n*.01)*100)}%` },
  chainLight:   { icon:'⚡', name:'Chain Lightning',cost:20, proc:.07, passive:false, color:'#e2e8f0', desc:'Lightning jumps to 2+ rings in the stack, dealing chained damage across multiple rings.',     levelCost:n=>Math.floor(140*1.45**n), procLabel:n=>`${Math.round((.07+n*.01)*100)}%` },
  regen:        { icon:'💚', name:'Regen',          cost:10, proc:0,   passive:true,  color:'#22c55e', desc:'Passive — ball speed regenerates when below 60% base speed.',       levelCost:n=>Math.floor(90*1.4**n),  procLabel:_=>'passive' },
  vortex:       { icon:'🌀', name:'Vortex',         cost:25, proc:.05, passive:false, color:'#a855f7', desc:'Ball teleports to center and fires outward, piercing every ring.',  levelCost:n=>Math.floor(180*1.5**n), procLabel:n=>`${Math.round((.05+n*.01)*100)}%` },
  shockwave:    { icon:'💥', name:'Shockwave',      cost:20, proc:.06, passive:false, color:'#06b6d4', desc:'Shockwave blasts the current ring, then ripples outward dealing reduced damage to outer rings.', levelCost:n=>Math.floor(150*1.48**n),procLabel:n=>`${Math.round((.06+n*.01)*100)}%` },
  critHit:      { icon:'🎯', name:'Critical Hit',   cost:15, proc:.10, passive:false, color:'#ef4444', desc:'Next hit deals 3× damage. "CRIT!" floating text.',                  levelCost:n=>Math.floor(100*1.42**n),procLabel:n=>`${Math.round((.10+n*.01)*100)}%` },
  blackHole:    { icon:'🌑', name:'Black Hole',     cost:40, proc:.03, passive:false, color:'#4c1d95', desc:'Singularity distorts the current ring, accelerating its collapse for 1.5 s.',   levelCost:n=>Math.floor(250*1.55**n),procLabel:n=>`${Math.round((.03+n*.005)*100)}%` },
  tsunami:      { icon:'🌊', name:'Tsunami',        cost:30, proc:.04, passive:false, color:'#3b82f6', desc:'Wave deals burst damage to the current ring instantly. At lvl 2+ sweeps all rings with distance falloff.',   levelCost:n=>Math.floor(200*1.5**n), procLabel:n=>`${Math.round((.04+n*.01)*100)}%` },
  meteor:       { icon:'☄️', name:'Meteor',         cost:35, proc:.03, passive:false, color:'#fb923c', desc:'Meteor crashes into the current ring dealing 5× damage + AoE to adjacent outer rings.',       levelCost:n=>Math.floor(220*1.52**n),procLabel:n=>`${Math.round((.03+n*.005)*100)}%` },
  frenzy:       { icon:'💫', name:'Frenzy',         cost:30, proc:.025, passive:false, color:'#f0abfc', desc:'Ball speed ×3 for 3 s, all damage ×1.4, speed cap lifted. Gap Seeker disabled. "FRENZY!!" explosion.',levelCost:n=>Math.floor(210*1.5**n),procLabel:n=>`${Math.round((.025+n*.01)*100)}%` },
};

const RING_PALETTE = ['#3b82f6','#8b5cf6','#ec4899','#f97316','#06b6d4','#22c55e'];

// Per-level roguelite perk choices (reset each level)
const LEVEL_PERKS = [
  { key:'dmgUp',       icon:'💥', name:'Damage Up',       desc:'+30% damage this level' },
  { key:'speedUp',     icon:'⚡', name:'Speed Up',         desc:'+20% ball speed immediately' },
  { key:'superBounce', icon:'🔁', name:'Super Bounce',     desc:'Near-perfect restitution this level' },
  { key:'weakenRings', icon:'💣', name:'Weaken All Rings', desc:'-20% HP on every remaining ring' },
  { key:'critSurge',   icon:'🎯', name:'Crit Surge',       desc:'+15% crit proc chance this level' },
  { key:'multiStrike', icon:'🌀', name:'Multi-Strike',     desc:'+15% multi-bounce chain this level' },
  { key:'gapSense',    icon:'🔓', name:'Gap Sense',        desc:'Gaps are 15° wider this level' },
  { key:'slowCollapse',icon:'🐌', name:'Slow Collapse',    desc:'Rings shrink 60% slower this level' },
  { key:'abilityPower',icon:'✨', name:'Ability Power',    desc:'+25% ability damage this level' },
  { key:'doubleXP',    icon:'⭐', name:'XP Rush',          desc:'Double XP from hits this level' },
  { key:'momentum',    icon:'💚', name:'Momentum',         desc:'Speed soft-floor 50% higher this level' },
];

const MILESTONES = [
  { level:5,  gems:0,  gold:50,  msg:'First milestone! Upgrades are key.',         title:null,      abilitySlots:1 },
  { level:10, gems:5,  gold:0,   msg:'Boss defeated! 2nd ability slot unlocked.',   title:null,      abilitySlots:2 },
  { level:20, gems:10, gold:0,   msg:'Incredible! 3rd ability slot unlocked.',      title:null,      abilitySlots:3 },
  { level:30, gems:15, gold:0,   msg:'Unstoppable. 4th ability slot unlocked.',     title:null,      abilitySlots:4 },
  { level:50, gems:25, gold:0,   msg:'"Veteran" title earned!',                     title:'Veteran', abilitySlots:4 },
  { level:100,gems:50, gold:0,   msg:'"Master" title + special trail unlocked!',    title:'Master',  abilitySlots:4, specialTrail:true },
];

// ═══════════════════════════════════════════════════════
// §4  SAVE / LOAD
// ═══════════════════════════════════════════════════════
function mkDefaultSave() {
  return {
    currentLevel:1, highestLevel:1, gold:0, gems:0, bestInfiniteScore:0,
    upgrades: Object.fromEntries(Object.keys(UPGRADES).map(k=>[k,0])),
    abilities: Object.fromEntries(Object.keys(ABILITIES).map(k=>[k,{unlocked:false,level:0}])),
    equippedAbilities: [],          // array of up to 4 ability keys
    abilitySlots: 1,               // unlocked ability slots
    chestInventory: [],
    milestones: [],
    stats: { totalDamage:0, totalRingsBroken:0, totalLevels:0, totalPlayTime:0, highestCombo:0, totalGold:0, totalGems:0 },
    title: null, specialTrail: false, trailLevelsLeft: 0,
  };
}

let S = (() => {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    if (!raw) return mkDefaultSave();
    const p = JSON.parse(raw);
    const d = mkDefaultSave();
    return { ...d, ...p,
      upgrades:  { ...d.upgrades,  ...(p.upgrades  || {}) },
      abilities: Object.fromEntries(Object.keys(d.abilities).map(k=>[k,{ ...d.abilities[k], ...(p.abilities?.[k]||{}) }])),
      stats:     { ...d.stats,     ...(p.stats      || {}) },
    };
  } catch { return mkDefaultSave(); }
})();

let saveTimer = null;
function doSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(()=>{
    try { localStorage.setItem(SAVE_KEY, JSON.stringify(S)); } catch {}
    const el = document.getElementById('savedFlash');
    if (el) { el.textContent='Saved ✓'; el.classList.add('show'); setTimeout(()=>el.classList.remove('show'),2000); }
  }, 200);
}

// ═══════════════════════════════════════════════════════
// §5  DOM REFS
// ═══════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
let canvas, ctx, cx, cy, cSize;

// ═══════════════════════════════════════════════════════
// §6  GAME STATE
// ═══════════════════════════════════════════════════════
let screen      = 'hub';          // hub | intro | playing | levelend | chest | upgrade | stats
let rings       = [];
let ball        = { x:0, y:0, vx:0, vy:0, radius:8 };
let ballTrail   = [];
let combo       = 0;
let comboTimer  = 0;              // seconds since last hit (reset combo)
let comboDisplayTimer = 0;
let gameRunning = false;
let paused      = false;
let physAccum   = 0;
let lastTime    = 0;
let animId      = null;
let levelStart  = 0;
let levelPlayTime = 0;
let parTime     = 0;
let levelGoldPartial = 0;        // gold from rings cleared so far
let ringsClearedCount = 0;
let totalDmgThisLevel = 0;
let tooBigShownThisLevel = false;
let critPending = false;
let frenzyActive= false;
let frenzyTimer = 0;
let frenzyDecayTimer = 0;
let preFrenzySpeed = 0;
// ── Infinite mode ─────────────────────────────────────
let infiniteMode  = false;
let infiniteScore = 0;
let infTime       = 0;
let infSpawnTimer = 1.5;
let frozenRings  = new Map();    // ringIdx → frozenSecondsLeft
let burnEffects  = [];           // { ringIdx, segIdx, dmgPerSec, duration }
let blackHoles   = [];           // { x, y, ringIdx, duration, angle }
let vortexActive = false;
let vortexTimer  = 0;
let vortexAngle  = 0;
let particles    = [];
let floatTexts   = [];
let shockwaveRings = [];
let lightningArcs  = [];
let tsunamiEffects = [];
let meteorEffects  = [];
let milestoneQueue = [];         // pending milestone messages to show
let pendingChests  = [];         // chest rarities queued to open after level-end screen
let upgradeTabActive = 'ball';
let screenBeforeUpgrade = 'hub';

// ── Per-level XP / roguelite progression ──────────────────
let xp          = 0;
let xpLevel     = 0;
let xpToNext    = 120;
let levelPerks  = [];   // array of perk keys picked this level (reset each level)
let xpPickerOpen= false;
let pendingXPLevels = 0; // queued level-ups waiting to be picked

// ── Level-scoped coin upgrades ───────────────────────────
const LVL_UPG_STEPS  = 5;    // purchases to fill the bar and level up
const LVL_COINS_BASE = 3;    // base coins per hit
let levelCoins  = 0;         // coins earned this level (level-scoped)
let lvlUpg = {
  dmg:   { tier: 0, steps: 0 },   // damage boost upgrade
  coins: { tier: 0, steps: 0 },   // coins-per-hit upgrade
};

// ═══════════════════════════════════════════════════════
// §7  MATH HELPERS
// ═══════════════════════════════════════════════════════
function norm(a)       { return ((a % TAU) + TAU) % TAU; }
function angDist(a, b) { return norm(b - a); }   // clockwise distance a→b
function inArc(angle, start, span) {
  if (span <= 0) return false;
  return angDist(start, norm(angle)) < span;
}
function lerp(a, b, t) { return a + (b - a) * t; }
function rndFrom(rng, arr) { return arr[Math.floor(rng() * arr.length)]; }

// ═══════════════════════════════════════════════════════
// §8  CANVAS RESIZE
// ═══════════════════════════════════════════════════════
function resizeCanvas() {
  canvas = $('beCanvas');
  const parent = canvas.parentElement;
  const W = parent.clientWidth, H = parent.clientHeight;
  const size = Math.min(W, H, 900);
  canvas.width = canvas.height = size;
  cSize = size; cx = cy = size / 2;
}

// ═══════════════════════════════════════════════════════
// §9  PROCEDURAL LEVEL GENERATION
// ═══════════════════════════════════════════════════════
function getRingCount(lv, rng) {
  if (lv === 1)  return 3;
  if (lv <= 3)   return 4  + Math.floor(rng() * 2);   // 4-5
  if (lv <= 6)   return 6  + Math.floor(rng() * 3);   // 6-8
  if (lv <= 10)  return 9  + Math.floor(rng() * 4);   // 9-12
  if (lv <= 18)  return 12 + Math.floor(rng() * 5);   // 12-16
  if (lv <= 30)  return 16 + Math.floor(rng() * 6);   // 16-21
  if (lv <= 50)  return 21 + Math.floor(rng() * 7);   // 21-27
  if (lv <= 100) return 26 + Math.floor(rng() * 8);   // 26-33
  return Math.min(42, 32 + Math.floor(rng() * 10));   // 32-41
}

function computeRadii(numRings) {
  const maxR    = cSize / 2 - 12;
  const inner0  = 38;
  const avail   = maxR - inner0;
  // Scale thickness to always fit all rings with at least minimal spacing
  const thick   = Math.max(3, Math.min(RING_THICK, avail / numRings * 0.52));
  const spacing = numRings > 1 ? Math.max(0, (avail - thick * numRings) / (numRings - 1)) : 0;
  return Array.from({ length: numRings }, (_, i) => ({
    inner: inner0 + i * (thick + spacing),
    outer: inner0 + i * (thick + spacing) + thick,
  }));
}

// Each ring: ONE segment (full arc minus gap) + ONE gap (or no gap for outermost)
function buildRingLayout(rng, gapDeg, isOutermost) {
  if (isOutermost) {
    // Solid wall — no gap, single full-circle segment
    return {
      gaps:     [],
      segments: [{ startAngle: 0, span: TAU, hp:0, maxHp:0, alive:true, burns:0, weakPoint:false }]
    };
  }
  const gapRad   = Math.max(0.08, gapDeg * Math.PI / 180);
  const gapStart = rng() * TAU;
  return {
    gaps:     [{ startAngle: norm(gapStart), span: gapRad }],
    segments: [{ startAngle: norm(gapStart + gapRad), span: TAU - gapRad, hp:0, maxHp:0, alive:true, burns:0, weakPoint:false }]
  };
}

function buildRing(lv, ringIdx, totalRings, radii, rng, isBoss, prevDir, isOutermost) {
  // Outermost ring: no gap (solid wall). Boss rings: small gap. Others: scaling gap.
  const gapDeg = isOutermost ? 0 : (isBoss ? 14 : Math.max(5, 18 - lv * 0.4 + S.upgrades.gapWidener * 3));

  // Direction: alternate from previous
  let dir = rng() < 0.5 ? 1 : -1;
  if (prevDir !== undefined && dir === prevDir) dir = -dir;

  // Speed
  const baseSpd  = 0.25 + lv * 0.012;
  const variation= 0.80 + rng() * 0.40;
  let rotSpd     = Math.min(1.8, baseSpd * variation) * dir;
  rotSpd *= 1 - S.upgrades.ringSlow * 0.03;

  // HP — single segment carries the entire ring HP, scaled up vs multi-segment
  const ringMult = 0.70 + (ringIdx / Math.max(1, totalRings - 1)) * 0.70;
  const hpBase   = Math.floor(80 * (1.22 ** lv) * ringMult * (1 - S.upgrades.segWeakness * 0.05));

  // Type (outermost is always just a solid red wall)
  let type = 'normal';
  if (!isBoss && !isOutermost) {
    const r = rng();
    if      (lv >= 25 && r < 0.10) type = 'magnet';
    else if (lv >= 20 && r < 0.20) type = 'phantom';
    else if (lv >= 15 && r < 0.35) type = 'shard';
    else if (lv >= 10 && r < 0.55) type = 'armored';
    else if (lv >= 8  && r < 0.70) type = 'speed';
  } else if (isBoss) { type = 'boss'; }

  const hpMult = type === 'armored' ? 1.8 : type === 'boss' ? 3.0 : isOutermost ? 2.5 : 1.0;
  if (type === 'speed') rotSpd *= 2.0;

  // Outermost ring is always vivid red; others use palette
  const colorBase = isOutermost ? '#ef4444' : RING_PALETTE[(ringIdx + Math.floor(lv * 0.5)) % RING_PALETTE.length];
  const layout    = buildRingLayout(rng, gapDeg, isOutermost);
  const thickness = radii.outer - radii.inner;

  for (const seg of layout.segments) {
    seg.maxHp = Math.max(1, Math.floor(hpBase * hpMult));
    seg.hp    = seg.maxHp;
  }
  // Weak points only on non-outermost rings
  if (!isOutermost && S.upgrades.weakPoints > 0 && layout.segments.length > 0) {
    layout.segments[0].weakPoint = true;
    layout.segments[0].maxHp = Math.max(1, Math.floor(layout.segments[0].maxHp * 0.5));
    layout.segments[0].hp    = layout.segments[0].maxHp;
  }

  // Shrink rate: px/s — pressure scales hard with level. activeTime acceleration added in physicsStep.
  const shrinkRate = 8 + lv * 1.0;

  return {
    inner: radii.inner, outer: radii.outer,
    thickness, shrinkRate,
    angle: rng() * TAU,
    rotSpd, dir,
    segments: layout.segments,
    gaps: layout.gaps,
    type, color: colorBase,
    isOutermost,
    cleared: false,
    activeTime: 0,      // seconds this ring has been the active (current) ring
    frozenTimer: 0,
    phantomVisible: true,
    phantomTimer:   0,
    phantomCycle:   3.0 + rng(),
    isBoss,
  };
}

function generateLevel(lv) {
  const rng      = mkRng(lv * 2654435761 | 0);
  const numRings = getRingCount(lv, rng);
  const radii    = computeRadii(numRings);
  const result   = [];
  for (let i = 0; i < numRings; i++) {
    const isBoss      = (lv % 10 === 0) && (i === numRings - 1);
    const isOutermost = (i === numRings - 1);
    const ring   = buildRing(lv, i, numRings, radii[i], rng, isBoss, result.length ? result[result.length-1].dir : undefined, isOutermost);
    result.push(ring);
  }
  // Compute par time: ~2 s per ring + level modifier
  parTime = (numRings * 2 + lv * 0.3) * Math.max(1, 1 - S.upgrades.ballSpeed * 0.03);
  return result;
}

// ═══════════════════════════════════════════════════════
// §DEBUG  Stuck / teleport diagnostics
// ═══════════════════════════════════════════════════════
let _dbgStuckFrames = 0;
let _dbgLastSpd     = 0;
let _dbgBounceLog   = []; // last 10 bounces
function _dbgLogBounce(label, ring, ri, dist, dot, tgt, spdBefore, spdAfter) {
  const entry = {
    t: performance.now().toFixed(1),
    label, ri,
    inner: ring.inner.toFixed(1), outer: ring.outer.toFixed(1),
    dist: dist.toFixed(1), dot: dot.toFixed(1), tgt: tgt.toFixed(1),
    spdBefore: spdBefore.toFixed(1), spdAfter: spdAfter.toFixed(1),
    frenzy: frenzyActive, ballX: ball.x.toFixed(1), ballY: ball.y.toFixed(1)
  };
  _dbgBounceLog.push(entry);
  if (_dbgBounceLog.length > 10) _dbgBounceLog.shift();
}
function _dbgCheckStuck(spd) {
  if (spd < 5) {
    _dbgStuckFrames++;
    if (_dbgStuckFrames === 3) {
      console.warn('[BallEscape] BALL STUCK! speed=' + spd.toFixed(2)
        + ' frenzy=' + frenzyActive
        + ' pos=(' + ball.x.toFixed(1) + ',' + ball.y.toFixed(1) + ')'
        + ' dist=' + Math.hypot(ball.x - cx, ball.y - cy).toFixed(1));
      console.warn('[BallEscape] Last 10 bounces:', JSON.stringify(_dbgBounceLog, null, 2));
      const ri = rings.findIndex(r => !r.cleared);
      if (ri >= 0) {
        const r = rings[ri];
        console.warn('[BallEscape] Current ring ri=' + ri + ' inner=' + r.inner.toFixed(1) + ' outer=' + r.outer.toFixed(1));
      }
    }
  } else {
    _dbgStuckFrames = 0;
  }
}

// ═══════════════════════════════════════════════════════
// §10  PHYSICS
// ═══════════════════════════════════════════════════════
function physicsStep() {
  const g = GRAVITY_BASE * (1 - S.upgrades.gravityCtrl * 0.10);
  const gFactor = frenzyActive ? 0.3 : 1.0;
  ball.vy += g * gFactor * FIXED_DT;

  // Dynamic sub-stepping: scale with speed so ball never tunnels through RING_THICK walls.
  // Frenzy can push speed to 3600+ px/s which would skip 10px walls at SUB=4.
  // Adaptive sub-stepping — re-evaluates step size after every iteration.
  // Critical: Frenzy fires mid-substep (rollProcs → triggerFrenzy → vx*=6).
  // A pre-computed fixed SUB uses the pre-frenzy speed and leaves the remaining
  // sub-steps too coarse, tunneling through 10px ring walls. By re-checking
  // speed each iteration the step shrinks automatically the moment frenzy fires.
  let remainingDT = FIXED_DT;
  let safetyIter  = 0;
  while (remainingDT > 1e-7 && safetyIter < 64) {
    safetyIter++;
    let subSpd = Math.hypot(ball.vx, ball.vy);
    // Cap speed per-substep: prevents bounceEnergy compounding across 64 iters → Infinity
    const subSpdCap = frenzyActive ? 2400 : MAX_SPEED * (1 + S.upgrades.ballSpeed * 0.08);
    if (subSpd > subSpdCap) {
      const sc = subSpdCap / subSpd; ball.vx *= sc; ball.vy *= sc; subSpd = subSpdCap;
    }
    const sdt    = subSpd > 0
      ? Math.min(remainingDT, (RING_THICK * 0.4) / subSpd)
      : remainingDT;
    remainingDT -= sdt;
    ball.x += ball.vx * sdt;
    ball.y += ball.vy * sdt;
    checkAllCollisions();
    // Arena boundary (keep inside canvas)
    const bx = ball.x - cx, by = ball.y - cy;
    const bd = Math.hypot(bx, by);
    const maxD = cSize / 2 - ball.radius - 3;
    if (bd > maxD && bd > 0) {
      const nx = bx / bd, ny = by / bd;
      ball.x = cx + nx * maxD;
      ball.y = cy + ny * maxD;
      const dot = ball.vx * nx + ball.vy * ny;
      ball.vx -= 2 * dot * nx;
      ball.vy -= 2 * dot * ny;
      const r = RESTITUTION + S.upgrades.bounceEnergy * 0.0015;
      ball.vx *= r; ball.vy *= r;
    }
  }

  // Speed management
  let spd = Math.hypot(ball.vx, ball.vy);
  _dbgCheckStuck(spd);
  const maxSpd = frenzyActive ? 99999 : MAX_SPEED * (1 + S.upgrades.ballSpeed * 0.08);
  if (!frenzyActive && spd > maxSpd) {
    const sc = maxSpd / spd;
    ball.vx *= sc; ball.vy *= sc;
  }
  // Soft minimum
  if (spd < MIN_SPEED * 0.5 && !frenzyActive) {
    const nudge = MIN_SPEED * 0.6;
    const a = Math.random() * TAU;
    ball.vx += Math.cos(a) * nudge;
    ball.vy += Math.sin(a) * nudge;
  }

  // Gap Seeker steering
  if (S.upgrades.gapSeeker > 0 && !frenzyActive) applyGapSeeker();

  // Regen
  applyRegen();

  const shrinkMul = Math.max(0.1, 1 - levelPerks.filter(k=>k==='slowCollapse').length * 0.60);

  if (infiniteMode) {
    // ── INFINITE MODE: all rings march inward together ──────────
    infTime += FIXED_DT;
    const infSpeed = Math.min(80, 10 + infTime * 0.5);

    for (let ri = 0; ri < rings.length; ri++) {
      const ring = rings[ri];
      if (ring.cleared) continue;
      if (ring.frozenTimer > 0) { ring.frozenTimer -= FIXED_DT; }
      else { ring.angle += ring.rotSpd * FIXED_DT; }
      ring.inner -= infSpeed * shrinkMul * FIXED_DT;
      ring.outer  = ring.inner + ring.thickness;
      if (ring.type === 'phantom') {
        ring.phantomTimer += FIXED_DT;
        const t = ring.phantomTimer % ring.phantomCycle;
        ring.phantomVisible = t < ring.phantomCycle * 0.67;
      }
      if (ring.type === 'magnet') applyMagnet(ring, ri);
    }
    // Kill check on innermost uncleared ring
    const curRi = rings.findIndex(r => !r.cleared);
    if (curRi >= 0 && rings[curRi].outer <= ball.radius && gameRunning) {
      spawnParticles(ball.x, ball.y, '#ef4444', 32, 200);
      spawnFloat(cx, cy - 40, '\ud83d\udc80 CRUSHED!', '#ef4444', 2.0);
      gameRunning = false;
      setTimeout(() => endInfinite(), 500);
      return;
    }
    // Spawn new rings when timer fires or running low
    infSpawnTimer -= FIXED_DT;
    const unclearedCount = rings.filter(r => !r.cleared).length;
    if (infSpawnTimer <= 0 || unclearedCount < 2) {
      const toSpawn = Math.max(1, 3 - unclearedCount);
      for (let _s = 0; _s < toSpawn; _s++) spawnInfiniteRing();
      infSpawnTimer = Math.max(0.4, 2.5 - infTime * 0.025);
    }

  } else {
    // ── NORMAL MODE: only innermost ring shrinks ─────────────────
    const currentRingIdx = rings.findIndex(r => !r.cleared);

    for (let ri = 0; ri < rings.length; ri++) {
      const ring = rings[ri];
      if (ring.cleared) continue;
      if (ring.frozenTimer > 0) {
        ring.frozenTimer -= FIXED_DT;
      } else {
        ring.angle += ring.rotSpd * FIXED_DT;
      }
      // Only the current (innermost uncleared) ring shrinks
      if (ri === currentRingIdx) {
        ring.activeTime += FIXED_DT;
        // Shrink accelerates the longer you stay on the same ring — 4% faster per second
        const accel = 1 + ring.activeTime * 0.04;
        ring.inner -= ring.shrinkRate * accel * shrinkMul * FIXED_DT;
        ring.outer  = ring.inner + ring.thickness;
        // Kill: ring collapsed to ball size or smaller
        if (ring.outer <= ball.radius && gameRunning) {
          spawnParticles(ball.x, ball.y, '#ef4444', 32, 200);
          spawnFloat(cx, cy - 40, '\ud83d\udc80 CRUSHED!', '#ef4444', 2.0);
          gameRunning = false;
          setTimeout(() => endLevel(false), 500);
          return;
        }
      }
      if (ring.type === 'phantom') {
        ring.phantomTimer += FIXED_DT;
        const t = ring.phantomTimer % ring.phantomCycle;
        ring.phantomVisible = t < ring.phantomCycle * 0.67; // invisible 33% of cycle
      }
      if (ring.type === 'magnet') applyMagnet(ring, ri);
    }
  }

  // Frenzy end — snap back to pre-frenzy speed instantly
  if (frenzyActive) {
    frenzyTimer -= FIXED_DT;
    if (frenzyTimer <= 0) {
      frenzyActive = false;
      const curSpd = Math.hypot(ball.vx, ball.vy);
      if (curSpd > 0 && preFrenzySpeed > 0) {
        ball.vx = (ball.vx / curSpd) * preFrenzySpeed;
        ball.vy = (ball.vy / curSpd) * preFrenzySpeed;
      }
      document.getElementById('beMain').classList.remove('frenzy-pulse');
    }
  }

  // Burn effects
  updateBurns();
  // Black holes
  updateBlackHoles();
  // Vortex
  if (vortexActive) updateVortex();

  // Update particles / texts / effects
  updateParticles();
  updateFloatTexts();
  updateShockwaves();
  updateLightning();
  updateTsunami();
  updateMeteors();

  // Combo timeout (no hit for 0.8 s = clean pass resets combo)
  if (comboTimer > 0) {
    comboTimer -= FIXED_DT;
    if (comboTimer <= 0) resetCombo();
  }
  if (comboDisplayTimer > 0) comboDisplayTimer -= FIXED_DT;

  // Trail
  ballTrail.push({ x: ball.x, y: ball.y, t: Date.now() });
  if (ballTrail.length > 28) ballTrail.shift();

  // Level play time
  levelPlayTime += FIXED_DT;
  S.stats.totalPlayTime += FIXED_DT;
}

// ── Collision ───────────────────────────────────────────
function checkAllCollisions() {
  const bx = ball.x - cx, by = ball.y - cy;
  const dist = Math.hypot(bx, by);
  if (dist < 1) return;
  const worldAngle = Math.atan2(by, bx);
  const br = ball.radius;

  for (let ri = 0; ri < rings.length; ri++) {
    const ring = rings[ri];
    if (ring.cleared) continue;
    // Radial overlap check
    if (dist + br < ring.inner - 1) continue;
    if (dist - br > ring.outer + 1) continue;
    // Phantom: skip if invisible
    if (ring.type === 'phantom' && !ring.phantomVisible) continue;

    const localAngle = norm(worldAngle - ring.angle);
    const midR       = (ring.inner + ring.outer) / 2;
    const physGapWidth = (s) => s.span * midR; // arc length of gap

    // Check if ball is in a gap
    let gapHit = null;
    for (const gap of ring.gaps) {
      if (inArc(localAngle, gap.startAngle, gap.span)) { gapHit = gap; break; }
    }

    if (gapHit !== null) {
      // Determine graze / too-big
      const gapPhysW  = physGapWidth(gapHit);
      const ballDiam  = br * 2;
      if (ballDiam > gapPhysW) {
        // TOO BIG — bounce off both flanking segments
        bounceOff(ring, dist, bx, by);
        const fl = flankingSegs(ring, gapHit);
        for (const fs of fl) if (fs && fs.alive) dealDmg(fs, ring, ri, calcDmg(), false);
        if (!tooBigShownThisLevel) {
          tooBigShownThisLevel = true;
          spawnFloat(ball.x, ball.y - 30, 'TOO BIG!', '#fbbf24', 1.4);
        }
      } else {
        // Check if ball has passed THROUGH the gap (center crossed past inner edge)
        if (dist > ring.inner) {
          // Ball has exited through the gap — mark segment dead and clear ring
          for (const s of ring.segments) { s.alive = false; s.hp = 0; }
          spawnFloat(ball.x, ball.y - 40, 'GAP ESCAPE!', '#06b6d4', 1.6);
          checkRingClear(ring, ri);
          break;
        }
        // Angular distance from ball center to nearest gap edge
        const dToStart = Math.min(angDist(localAngle, gapHit.startAngle),
                                   angDist(gapHit.startAngle, localAngle));
        const dToEnd   = angDist(gapHit.startAngle, localAngle);
        const halfSpan = gapHit.span / 2;
        // graze zone = outer 20% on each side = within halfSpan*0.4 of either edge
        const distFromEdge = Math.min(
          Math.min(angDist(localAngle, gapHit.startAngle), angDist(gapHit.startAngle, localAngle)),
          Math.min(angDist(localAngle, norm(gapHit.startAngle + gapHit.span)), angDist(norm(gapHit.startAngle + gapHit.span), localAngle))
        );
        if (distFromEdge < gapHit.span * 0.20) {
          // Graze
          const fl = flankingSegs(ring, gapHit);
          for (const fs of fl) if (fs && fs.alive) dealDmg(fs, ring, ri, calcDmg() * 0.15, false);
          spawnGrazeSpark(ball.x, ball.y);
        }
        // else clean pass — combo NOT reset on graze or clean
      }
      break; // handled this ring
    }

    // Hitting a segment: find which one
    // Check radial overlap properly
    const innerHit = dist - br < ring.outer && dist + br > ring.inner;
    if (!innerHit) continue;
    const seg = segAtAngle(ring, localAngle);
    if (!seg || !seg.alive) continue;

    // Bounce
    bounceOff(ring, dist, bx, by);

    // Deal damage
    const dmg = calcDmg();
    dealDmg(seg, ring, ri, dmg, true);
    registerHit();
    rollProcs(seg, ring, ri, dmg);
    break; // one ring per sub-step
  }
}

function bounceOff(ring, dist, bx, by) {
  const nx = bx / dist, ny = by / dist;
  const dot = ball.vx * nx + ball.vy * ny;
  const perkBounce = levelPerks.filter(k=>k==='superBounce').length * 0.004;
  const r   = RESTITUTION + S.upgrades.bounceEnergy * 0.0015 + perkBounce;
  const spdBefore = Math.hypot(ball.vx, ball.vy);
  ball.vx   = (ball.vx - 2 * dot * nx) * r;
  ball.vy   = (ball.vy - 2 * dot * ny) * r;
  // Use pre-bounce radial velocity (dot) to decide which wall was hit.
  // dot < 0 = ball was moving inward → hit outer wall → push outside.
  // dot > 0 = ball was moving outward → hit inner wall → push inside.
  // This is reliable even when the ball tunnels past the midpoint at high speed.
  const tgt = dot < 0 ? ring.outer + ball.radius + 0.5 : ring.inner - ball.radius - 0.5;
  ball.x    = cx + nx * tgt;
  ball.y    = cy + ny * tgt;
  const ri = rings.indexOf(ring);
  _dbgLogBounce('ring', ring, ri, dist, dot, tgt, spdBefore, Math.hypot(ball.vx, ball.vy));
}

function segAtAngle(ring, localAngle) {
  for (const seg of ring.segments) {
    if (!seg.alive) continue;
    if (inArc(localAngle, seg.startAngle, seg.span)) return seg;
  }
  return null;
}

function flankingSegs(ring, gap) {
  const before = norm(gap.startAngle - 0.01);
  const after  = norm(gap.startAngle + gap.span + 0.01);
  return [segAtAngle(ring, before), segAtAngle(ring, after)];
}

// ── Gap Seeker steering ──────────────────────────────────
function applyGapSeeker() {
  const bx = ball.x - cx, by = ball.y - cy;
  const dist = Math.hypot(bx, by);
  const worldAngle = Math.atan2(by, bx);
  const force = S.upgrades.gapSeeker * 0.20 * 60; // px/s²
  let closestAngle = null, closestDist = Infinity;
  for (const ring of rings) {
    if (ring.cleared) continue;
    if (Math.abs(dist - (ring.inner + ring.outer) / 2) > ball.radius + 20) continue;
    for (const gap of ring.gaps) {
      const gapCenter = norm(gap.startAngle + gap.span / 2) + ring.angle;
      const d = Math.min(angDist(worldAngle, gapCenter), angDist(gapCenter, worldAngle));
      if (d < closestDist) { closestDist = d; closestAngle = gapCenter; }
    }
  }
  if (closestAngle !== null && closestDist < 0.5) {
    // Tangential steering toward gap
    const perpX = -by / dist, perpY = bx / dist; // tangent (CW)
    const targetA = closestAngle;
    const curA    = norm(worldAngle);
    const diff    = norm(targetA - curA) < Math.PI ? 1 : -1;
    ball.vx += diff * perpX * force * FIXED_DT;
    ball.vy += diff * perpY * force * FIXED_DT;
  }
}

// ── Magnet ring ──────────────────────────────────────────
function applyMagnet(ring, ri) {
  const bx = ball.x - cx, by = ball.y - cy;
  const dist = Math.hypot(bx, by);
  const midR = (ring.inner + ring.outer) / 2;
  if (Math.abs(dist - midR) > 60) return;
  const localA = norm(Math.atan2(by, bx) - ring.angle);
  // Find nearest segment and pull toward its center
  let best = null, bestD = Infinity;
  for (const seg of ring.segments) {
    if (!seg.alive) continue;
    const sc = norm(seg.startAngle + seg.span / 2);
    const d  = Math.min(angDist(localA, sc), angDist(sc, localA));
    if (d < bestD) { bestD = d; best = seg; }
  }
  if (!best) return;
  const segWorldA = norm(best.startAngle + best.span / 2 + ring.angle);
  const tx = cx + Math.cos(segWorldA) * midR;
  const ty = cy + Math.sin(segWorldA) * midR;
  const dx = tx - ball.x, dy = ty - ball.y;
  const dlen = Math.hypot(dx, dy);
  if (dlen < 1) return;
  const pullF = 30 * FIXED_DT;
  ball.vx += (dx / dlen) * pullF;
  ball.vy += (dy / dlen) * pullF;
}

// ═══════════════════════════════════════════════════════
// §11  DAMAGE & EFFECTS
// ═══════════════════════════════════════════════════════
function calcDmg() {
  const perkMult = 1 + levelPerks.filter(k=>k==='dmgUp').length * 0.30;
  const lvlMult  = lvlUpgDmgMult();
  let d = (1 + S.upgrades.damage * 0.15) * 10 * perkMult * lvlMult;
  if (critPending) { d *= 3 + S.abilities.critHit.level; critPending = false; }
  if (frenzyActive) d *= 1.4;
  return d;
}

function dealDmg(seg, ring, ri, dmg, canMultiBounce) {
  if (!seg.alive) return;
  seg.hp -= dmg;
  S.stats.totalDamage += dmg;
  totalDmgThisLevel   += dmg;
  if (seg.hp <= 0) destroySeg(seg, ring, ri);
  else if (canMultiBounce) tryMultiBounce(seg, ring, ri, dmg);
}

function destroySeg(seg, ring, ri) {
  seg.alive = false;
  seg.hp    = 0;
  spawnDestroyParticles(ring, seg);
  // Chain Break: splash damage to the NEXT outer ring when this ring is cleared
  if (S.upgrades.chainBreak > 0) {
    const pct    = 0.20 + (S.upgrades.chainBreak - 1) * 0.10;
    const nextRi = ri + 1;
    if (nextRi < rings.length && !rings[nextRi].cleared) {
      const nSeg = rings[nextRi].segments[0];
      if (nSeg && nSeg.alive) dealDmg(nSeg, rings[nextRi], nextRi, nSeg.maxHp * pct, false);
    }
  }
  // Gem finder
  const gfChance = S.upgrades.gemFinder * 0.03;
  if (Math.random() < gfChance) { S.gems++; S.stats.totalGems++; spawnFloat(ball.x, ball.y - 20, '+1 💎', '#a78bfa'); }
  // Shard ring
  if (ring.type === 'shard') spawnShardParticles(ring, seg);
  checkRingClear(ring, ri);
}

// Multi-bounce: chain a bonus hit to the next INNER ring on proc
function tryMultiBounce(seg, ring, ri, dmg) {
  const chance = S.upgrades.multiBounce * 0.05 + levelPerks.filter(k=>k==='multiStrike').length * 0.15;
  if (Math.random() > chance) return;
  // Chain to the next inner ring
  const innerRi = ri - 1;
  if (innerRi >= 0 && !rings[innerRi].cleared) {
    const iSeg = rings[innerRi].segments[0];
    if (iSeg && iSeg.alive) dealDmg(iSeg, rings[innerRi], innerRi, dmg * 0.6, false);
  }
}

// Adjacent rings helper — returns segments from rings immediately before/after in the stack
function getNeighborSegs(ring) {
  const ri = rings.indexOf(ring);
  const result = [];
  if (ri > 0 && !rings[ri - 1].cleared) {
    const s = rings[ri - 1].segments[0];
    if (s && s.alive) result.push({ seg: s, ring: rings[ri - 1], ri: ri - 1 });
  }
  if (ri < rings.length - 1 && !rings[ri + 1].cleared) {
    const s = rings[ri + 1].segments[0];
    if (s && s.alive) result.push({ seg: s, ring: rings[ri + 1], ri: ri + 1 });
  }
  return result;
}

function checkRingClear(ring, ri) {
  if (ring.segments.some(s => s.alive)) return;
  ring.cleared = true;
  ringsClearedCount++;
  S.stats.totalRingsBroken++;
  const partialGold = Math.floor(5 * (S.currentLevel || 1));
  levelGoldPartial += partialGold;
  spawnFloat(ball.x, ball.y - 40, 'RING CLEARED!', '#22c55e', 1.6);
  if (infiniteMode) {
    infiniteScore++;
    gainXP(20);
  } else if (rings.every(r => r.cleared)) {
    endLevel(true);
  }
}

// ═══════════════════════════════════════════════════════
// §12  ABILITY PROCS
// ═══════════════════════════════════════════════════════
function rollProcs(seg, ring, ri, dmg) {
  const equipped = S.equippedAbilities;
  for (const key of equipped) {
    const def  = ABILITIES[key];
    const info = S.abilities[key];
    if (!info.unlocked || def.passive) continue;
    const critBonus = key === 'critHit' ? levelPerks.filter(k=>k==='critSurge').length * 0.15 : 0;
    const proc = def.proc + info.level * 0.01 + critBonus;
    if (Math.random() > proc) continue;
    flashAbilitySlot(key);
    switch (key) {
      case 'inferno':    triggerInferno(seg, ring, ri, info.level); break;
      case 'freeze':     triggerFreeze(ring, ri, info.level); break;
      case 'chainLight': triggerChainLightning(seg, ring, ri, dmg, info.level); break;
      case 'vortex':     triggerVortex(info.level); break;
      case 'shockwave':  triggerShockwave(ring, ri, dmg, info.level); break;
      case 'critHit':    triggerCrit(); break;
      case 'blackHole':  triggerBlackHole(ring, ri, info.level); break;
      case 'tsunami':    triggerTsunami(ring, ri, info.level); break;
      case 'meteor':     triggerMeteor(ring, ri, info.level); break;
      case 'frenzy':     triggerFrenzy(info.level); break;
    }
  }
}

function applyRegen() {
  if (!S.equippedAbilities.includes('regen')) return;
  if (!S.abilities.regen.unlocked) return;
  const lvl    = S.abilities.regen.level;
  const thresh = 0.60 + lvl * 0.05;
  const baseSpd= MIN_SPEED * (1 + S.upgrades.ballSpeed * 0.08) * 4;
  const cur    = Math.hypot(ball.vx, ball.vy);
  if (cur < baseSpd * thresh) {
    const rate = (10 + lvl * 5) * FIXED_DT;
    const a    = Math.atan2(ball.vy, ball.vx);
    ball.vx   += Math.cos(a) * rate;
    ball.vy   += Math.sin(a) * rate;
  }
}

function triggerInferno(seg, ring, ri, lvl) {
  const dmgPerSec = 20 + lvl * 8;
  const duration  = 3 + lvl * 0.5;
  // Always burn hit segment
  burnEffects.push({ ringIdx: ri, seg, dmgPerSec, duration });
  // At lvl 2+ spread burn to immediately adjacent rings
  if (lvl >= 2) {
    for (const { seg: adjSeg, ring: adjRing, ri: adjRi } of getNeighborSegs(ring)) {
      burnEffects.push({ ringIdx: adjRi, seg: adjSeg, dmgPerSec: dmgPerSec * 0.5, duration });
    }
  }
  spawnParticles(ball.x, ball.y, '#f97316', 14, 70);
  spawnFloat(ball.x, ball.y - 25, '🔥 Inferno!', '#f97316');
}
function triggerFreeze(ring, ri, lvl) {
  ring.frozenTimer = 2 + lvl * 0.5;
  const extra = lvl >= 3 ? 1 : 0; // freeze adjacent
  if (extra && ri > 0) rings[ri - 1].frozenTimer = ring.frozenTimer * 0.7;
  spawnParticles(ball.x, ball.y, '#67e8f9', 16, 80);
  spawnFloat(ball.x, ball.y - 25, '❄️ Freeze!', '#67e8f9');
}
function triggerChainLightning(seg, ring, ri, baseDmg, lvl) {
  // Chain lightning jumps to (1 + lvl) adjacent rings in the stack
  const jumps     = 1 + lvl;
  const dmgPerJump = baseDmg * (0.55 + lvl * 0.05);
  let lastRi = ri;
  let hits   = 0;
  for (let j = 0; j < jumps && hits < rings.length - 1; j++) {
    // Alternate inward / outward for interesting spread
    const candidatesRi = [];
    if (lastRi > 0 && !rings[lastRi - 1].cleared)           candidatesRi.push(lastRi - 1);
    if (lastRi < rings.length - 1 && !rings[lastRi + 1].cleared) candidatesRi.push(lastRi + 1);
    if (!candidatesRi.length) break;
    const nextRi  = candidatesRi[Math.floor(Math.random() * candidatesRi.length)];
    const nextSeg = rings[nextRi].segments[0];
    if (nextSeg && nextSeg.alive) {
      dealDmg(nextSeg, rings[nextRi], nextRi, dmgPerJump, false);
      lightningArcs.push({ from: { x: ball.x, y: ball.y }, toSeg: nextSeg, ring: rings[nextRi], life: 0.3 });
      hits++;
    }
    lastRi = nextRi;
  }
  spawnFloat(ball.x, ball.y - 25, '⚡ Lightning!', '#e2e8f0');
}
function triggerCrit() {
  critPending = true;
  spawnFloat(ball.x, ball.y - 25, '🎯 CRIT ready!', '#ef4444');
}
function triggerVortex(lvl) {
  if (vortexActive) return;
  vortexActive = true;
  vortexTimer  = 0;
  vortexAngle  = Math.random() * TAU;
  const preVortexSpd = Math.hypot(ball.vx, ball.vy);
  const preVortexPos = { x: ball.x, y: ball.y, dist: Math.hypot(ball.x - cx, ball.y - cy) };
  ball.x = cx; ball.y = cy;
  const spd = MAX_SPEED * 1.5;
  ball.vx = Math.cos(vortexAngle) * spd;
  ball.vy = Math.sin(vortexAngle) * spd;
  console.log('[BallEscape] VORTEX fired: preSpd=' + preVortexSpd.toFixed(1)
    + ' prePos=(' + preVortexPos.x.toFixed(1) + ',' + preVortexPos.y.toFixed(1) + ')'
    + ' preDist=' + preVortexPos.dist.toFixed(1)
    + ' angle=' + (vortexAngle * 180 / Math.PI).toFixed(1) + '°'
    + ' frenzy=' + frenzyActive);
  spawnFloat(cx, cy - 50, '🌀 VORTEX!', '#a855f7', 1.8);
}
function updateVortex() {
  vortexTimer += FIXED_DT;
  if (vortexTimer > 2) { vortexActive = false; return; }
  // Vortex trail visual
  spawnParticles(ball.x, ball.y, '#a855f7', 3, 40);
}
function triggerShockwave(ring, ri, baseDmg, lvl) {
  const pct  = 0.45 + lvl * 0.05;
  const seg  = ring.segments[0];
  if (seg && seg.alive) dealDmg(seg, ring, ri, baseDmg * pct, false);
  // Also ripple to (lvl) rings outward
  for (let n = 1; n <= lvl && ri + n < rings.length; n++) {
    const tRi  = ri + n;
    if (rings[tRi].cleared) continue;
    const tSeg = rings[tRi].segments[0];
    if (tSeg && tSeg.alive) dealDmg(tSeg, rings[tRi], tRi, baseDmg * pct * (0.4 ** n), false);
  }
  shockwaveRings.push({ x: ball.x, y: ball.y, r: (ring.inner + ring.outer) / 2, life: 0.5, color: '#06b6d4' });
  spawnFloat(ball.x, ball.y - 25, '💥 Shockwave!', '#06b6d4');
}
function triggerBlackHole(ring, ri, lvl) {
  // Replace any existing black hole on the same ring
  const ei = blackHoles.findIndex(bh => bh.ringIdx === ri);
  if (ei >= 0) blackHoles.splice(ei, 1);
  blackHoles.push({ ringIdx: ri, duration: 1.5 + lvl * 0.3, timer: 0, shrinkMult: 2 + lvl * 0.5 });
  spawnFloat(ball.x, ball.y - 25, '🌑 Black Hole!', '#7c3aed');
}
function updateBlackHoles() {
  for (let i = blackHoles.length - 1; i >= 0; i--) {
    const bh = blackHoles[i];
    bh.timer += FIXED_DT;
    if (bh.timer >= bh.duration) { blackHoles.splice(i, 1); continue; }
    const ri = bh.ringIdx;
    if (ri >= rings.length || rings[ri].cleared) { blackHoles.splice(i, 1); continue; }
    // Only accelerate the current active ring
    if (ri !== rings.findIndex(r => !r.cleared)) continue;
    const ring = rings[ri];
    // Extra shrink on top of physicsStep's normal shrink
    ring.inner -= ring.shrinkRate * bh.shrinkMult * FIXED_DT;
    ring.outer  = ring.inner + ring.thickness;
    // Kill check
    if (ring.outer <= ball.radius && gameRunning) {
      spawnParticles(ball.x, ball.y, '#ef4444', 32, 200);
      spawnFloat(cx, cy - 40, '💀 CRUSHED!', '#ef4444', 2.0);
      gameRunning = false;
      setTimeout(() => endLevel(false), 500);
      return;
    }
    // Visual pulse
    const midR = (ring.inner + ring.outer) / 2;
    spawnParticles(cx + Math.cos(ring.angle) * midR, cy + Math.sin(ring.angle) * midR, '#4c1d95', 4, 30);
  }
}
function triggerTsunami(ring, ri, lvl) {
  const pct = 0.30 + lvl * 0.05;
  const seg = ring.segments[0];
  if (seg && seg.alive) dealDmg(seg, ring, ri, seg.maxHp * pct, false);
  tsunamiEffects.push({ ringIdx: ri, angle: 0, life: 0.8, color: '#3b82f6' });
  spawnFloat(ball.x, ball.y - 25, '🌊 Tsunami!', '#3b82f6', 1.4);
  // At lvl 2+ spread to ALL rings (tsunami sweeps everything)
  if (lvl >= 2) {
    for (let adj = 0; adj < rings.length; adj++) {
      if (adj === ri || rings[adj].cleared) continue;
      const aSeg = rings[adj].segments[0];
      const dist = Math.abs(adj - ri);
      if (aSeg && aSeg.alive) dealDmg(aSeg, rings[adj], adj, aSeg.maxHp * pct * (0.5 / dist), false);
    }
  }
}
function triggerMeteor(ring, ri, lvl) {
  const seg = ring.segments[0];
  if (!seg || !seg.alive) return;
  // Primary impact on current ring
  const midR = (ring.inner + ring.outer) / 2;
  const wa   = seg.startAngle + seg.span / 2 + ring.angle;
  meteorEffects.push({ tx: cx + Math.cos(wa) * midR, ty: cy + Math.sin(wa) * midR, progress: 0, seg, ring, ri, lvl });
  // Extra meteors on nearby rings at higher levels
  for (let n = 1; n < 1 + Math.floor(lvl / 2); n++) {
    const tRi = ri + n;
    if (tRi >= rings.length || rings[tRi].cleared) break;
    const tSeg = rings[tRi].segments[0];
    if (!tSeg || !tSeg.alive) continue;
    const tmR = (rings[tRi].inner + rings[tRi].outer) / 2;
    const twa = tSeg.startAngle + tSeg.span / 2 + rings[tRi].angle;
    meteorEffects.push({ tx: cx + Math.cos(twa) * tmR, ty: cy + Math.sin(twa) * tmR, progress: 0, seg: tSeg, ring: rings[tRi], ri: tRi, lvl });
  }
  spawnFloat(ball.x, ball.y - 25, '☄️ Meteor!', '#fb923c', 1.4);
}
function triggerFrenzy(lvl) {
  if (frenzyActive) return;          // prevent re-trigger causing exponential speed blow-up
  preFrenzySpeed = Math.hypot(ball.vx, ball.vy);
  frenzyActive = true;
  frenzyTimer  = 3 + lvl * 0.5;
  ball.vx *= 3; ball.vy *= 3;
  spawnParticles(ball.x, ball.y, '#f0abfc', 25, 120);
  spawnFloat(cx, cy - 80, 'FRENZY!!', '#f0abfc', 2.0);
  document.getElementById('beMain').classList.add('frenzy-pulse');
}

function updateBurns() {
  for (let i = burnEffects.length - 1; i >= 0; i--) {
    const b = burnEffects[i];
    if (!b.seg.alive) { burnEffects.splice(i, 1); continue; }
    b.duration -= FIXED_DT;
    if (b.duration <= 0) { burnEffects.splice(i, 1); continue; }
    dealDmg(b.seg, rings[b.ringIdx], b.ringIdx, b.dmgPerSec * FIXED_DT, false);
  }
}

// ═══════════════════════════════════════════════════════
// §13  COMBO
// ═══════════════════════════════════════════════════════
const COMBO_TIERS = [
  { at: 0,  color: '#e2e8f0', goldMult: 1.0 },
  { at: 5,  color: '#fbbf24', goldMult: 1.2 },
  { at: 10, color: '#f97316', goldMult: 1.5 },
  { at: 20, color: '#ef4444', goldMult: 2.0 },
  { at: 30, color: '#ffffff', goldMult: 2.5 },
  { at: 50, color: '#f0abfc', goldMult: 3.5 },
];
function getComboTier() {
  let tier = COMBO_TIERS[0];
  for (const t of COMBO_TIERS) if (combo >= t.at) tier = t;
  return tier;
}
function registerHit() {
  combo++;
  comboTimer = 0.8;
  comboDisplayTimer = 1.5;
  if (combo > S.stats.highestCombo) S.stats.highestCombo = combo;
  const tier = getComboTier();
  if ([5, 10, 20, 30, 50].includes(combo)) {
    spawnFloat(ball.x, ball.y - 55, `×${combo} Combo!`, tier.color, 1.5);
  }
  gainXP(10);
  // Earn level-scoped coins per hit
  levelCoins += lvlUpgCoinsPerHit();
}
function resetCombo() { combo = 0; comboTimer = 0; }

// ═══════════════════════════════════════════════════════
// §XP  PER-LEVEL ROGUELITE PROGRESSION
// ═══════════════════════════════════════════════════════
function gainXP(amount) {
  const mult = 1 + levelPerks.filter(k=>k==='doubleXP').length;
  xp += amount * mult;
  while (xp >= xpToNext) {
    xp -= xpToNext;
    xpLevel++;
    xpToNext = Math.floor(120 + xpLevel * 60);
    if (xpPickerOpen) {
      pendingXPLevels++;
    } else {
      showXPPicker();
    }
  }
}

function showXPPicker() {
  xpPickerOpen = true;
  const shuffled = [...LEVEL_PERKS].sort(() => Math.random() - 0.5);
  const choices  = shuffled.slice(0, 3);
  const overlay  = $('xpPickerOverlay');
  const content  = $('xpPickerContent');
  if (!overlay || !content) return;
  const queueLabel = pendingXPLevels > 0 ? ` <span style="color:var(--gold)">(+${pendingXPLevels} queued)</span>` : '';
  content.innerHTML = `
    <div class="be-xpp-title">⭐ LEVEL UP!</div>
    <div class="be-xpp-sub">XP Level ${xpLevel} — Pick a power-up${queueLabel}</div>
    <div class="be-xpp-cards">
      ${choices.map(p=>`<div class="be-xpp-card" data-key="${p.key}"><div class="be-xpp-icon">${p.icon}</div><div class="be-xpp-name">${p.name}</div><div class="be-xpp-desc">${p.desc}</div></div>`).join('')}
    </div>`;
  overlay.style.display = '';
  content.querySelectorAll('.be-xpp-card').forEach(card => {
    card.addEventListener('click', () => {
      applyLevelPerk(card.dataset.key);
      if (pendingXPLevels > 0) {
        pendingXPLevels--;
        showXPPicker();
      } else {
        overlay.style.display = 'none';
        xpPickerOpen = false;
      }
      lastTime = performance.now(); physAccum = 0;
    }, { once: true });
  });
}

function applyLevelPerk(key) {
  levelPerks.push(key);
  if (key === 'weakenRings') {
    for (const ring of rings) {
      for (const seg of ring.segments) {
        if (seg.alive) { seg.hp *= 0.80; seg.maxHp *= 0.80; if (seg.hp < 1) seg.hp = 1; }
      }
    }
  }
  if (key === 'speedUp') {
    const spd = Math.hypot(ball.vx, ball.vy);
    if (spd > 0) { ball.vx = (ball.vx / spd) * spd * 1.20; ball.vy = (ball.vy / spd) * spd * 1.20; }
  }
  if (key === 'gapSense') {
    const bonusRad = 15 * Math.PI / 180;
    for (const ring of rings) {
      for (const gap of ring.gaps) gap.span += bonusRad;
      const totalGap = ring.gaps.reduce((s, g) => s + g.span, 0);
      for (const seg of ring.segments) if (ring.gaps.length) seg.span = Math.max(0.1, TAU - totalGap);
    }
  }
  const def = LEVEL_PERKS.find(p => p.key === key);
  if (def) spawnFloat(cx, cy - 70, `${def.icon} ${def.name}!`, '#fbbf24', 1.6);
}

// ═══════════════════════════════════════════════════════
// §14  PARTICLES & FLOATING TEXT
// ═══════════════════════════════════════════════════════
function spawnParticles(x, y, color, n, speed) {
  for (let i = 0; i < n; i++) {
    const a = Math.random() * TAU;
    const s = speed * (0.5 + Math.random());
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: 2 + Math.random() * 3, color, life: 1, maxLife: 1 });
  }
}
function spawnDestroyParticles(ring, seg) {
  const midR = (ring.inner + ring.outer) / 2;
  const wa   = seg.startAngle + seg.span / 2 + ring.angle;
  const x    = cx + Math.cos(wa) * midR;
  const y    = cy + Math.sin(wa) * midR;
  spawnParticles(x, y, ring.color, 14, 90);
}
function spawnShardParticles(ring, seg) {
  const midR = (ring.inner + ring.outer) / 2;
  const wa   = seg.startAngle + seg.span / 2 + ring.angle;
  const x    = cx + Math.cos(wa) * midR;
  const y    = cy + Math.sin(wa) * midR;
  for (let i = 0; i < 2; i++) {
    const a = Math.random() * TAU;
    const s = 60 + Math.random() * 60;
    particles.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, r: 5, color: '#ef4444', life: 1, maxLife: 1, isShard: true });
  }
}
function spawnGrazeSpark(x, y) { spawnParticles(x, y, '#fb923c', 8, 60); }
function updateParticles() {
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x  += p.vx * FIXED_DT; p.y  += p.vy * FIXED_DT;
    p.vy += 120 * FIXED_DT; // gravity
    p.life -= FIXED_DT / 0.7;
    if (p.life <= 0) particles.splice(i, 1);
  }
}

function spawnFloat(x, y, text, color, scale = 1) {
  floatTexts.push({ x, y, text, color, life: 1.2, maxLife: 1.2, vy: -60, scale });
}
function updateFloatTexts() {
  for (let i = floatTexts.length - 1; i >= 0; i--) {
    const f = floatTexts[i];
    f.y   += f.vy * FIXED_DT;
    f.life -= FIXED_DT;
    if (f.life <= 0) floatTexts.splice(i, 1);
  }
}

function updateShockwaves() {
  for (let i = shockwaveRings.length - 1; i >= 0; i--) {
    const sw = shockwaveRings[i];
    sw.r += 80 * FIXED_DT;
    sw.life -= FIXED_DT / 0.5;
    if (sw.life <= 0) shockwaveRings.splice(i, 1);
  }
}
function updateLightning() {
  for (let i = lightningArcs.length - 1; i >= 0; i--) {
    lightningArcs[i].life -= FIXED_DT / 0.3;
    if (lightningArcs[i].life <= 0) lightningArcs.splice(i, 1);
  }
}
function updateTsunami() {
  for (let i = tsunamiEffects.length - 1; i >= 0; i--) {
    const t = tsunamiEffects[i];
    t.angle += FIXED_DT * TAU;
    t.life  -= FIXED_DT / 0.8;
    if (t.life <= 0) tsunamiEffects.splice(i, 1);
  }
}
function updateMeteors() {
  for (let i = meteorEffects.length - 1; i >= 0; i--) {
    const m = meteorEffects[i];
    m.progress += FIXED_DT / 0.6;
    if (m.progress >= 1) {
      // Impact
      if (m.seg.alive) dealDmg(m.seg, m.ring, m.ri, calcDmg() * 5, false);
      spawnParticles(m.tx, m.ty, '#fb923c', 20, 120);
      meteorEffects.splice(i, 1);
    }
  }
}

function flashAbilitySlot(key) {
  const bar = $('abilityBar');
  if (!bar) return;
  const slots = bar.querySelectorAll('.be-aslot');
  const idx   = S.equippedAbilities.indexOf(key);
  if (idx >= 0 && slots[idx]) {
    const slot = slots[idx];
    slot.style.setProperty('--pc', ABILITIES[key]?.color || '#fff');
    slot.classList.remove('just-proced');
    void slot.offsetWidth;
    slot.classList.add('just-proced');
  }
}

// ═══════════════════════════════════════════════════════
// §15  RENDERING
// ═══════════════════════════════════════════════════════
function renderFrame() {
  if (!ctx) return;
  ctx.clearRect(0, 0, cSize, cSize);

  // Background
  const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, cSize / 2);
  grad.addColorStop(0, '#0e0e20');
  grad.addColorStop(1, '#080810');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, cSize, cSize);

  if (screen === 'hub') { drawIdleBackground(); return; }

  // Draw rings
  for (let ri = 0; ri < rings.length; ri++) drawRing(rings[ri], ri);

  // ── Active ring HP display at canvas center ────────────────────────
  const activeRing = rings.find(r => !r.cleared);
  if (activeRing && activeRing.segments[0]) {
    const seg = activeRing.segments[0];
    if (seg.alive) {
      const hpFrac = seg.hp / seg.maxHp;
      const arcR   = 30;
      ctx.save();
      // Background arc
      ctx.beginPath();
      ctx.arc(cx, cy, arcR, 0, TAU);
      ctx.strokeStyle = 'rgba(255,255,255,0.06)';
      ctx.lineWidth   = 4;
      ctx.stroke();
      // HP fill arc
      ctx.beginPath();
      ctx.arc(cx, cy, arcR, -Math.PI / 2, -Math.PI / 2 + TAU * hpFrac);
      ctx.strokeStyle = hexAlpha(activeRing.color, 0.8);
      ctx.lineWidth   = 4;
      ctx.stroke();
      // HP text
      const dispStr = Math.ceil(seg.hp).toLocaleString();
      ctx.fillStyle    = `rgba(255,255,255,${0.45 + hpFrac * 0.55})`;
      ctx.font         = `700 ${dispStr.length > 5 ? 9 : dispStr.length > 3 ? 11 : 13}px 'Orbitron',sans-serif`;
      ctx.textAlign    = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(dispStr, cx, cy);
      ctx.textBaseline = 'alphabetic';
      ctx.restore();
    }
  }

  // Draw shockwaves
  for (const sw of shockwaveRings) {
    ctx.beginPath();
    ctx.arc(sw.x, sw.y, sw.r, 0, TAU);
    ctx.strokeStyle = hexAlpha(sw.color, sw.life * 0.8);
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  // Draw black holes — pulsing ring overlay on the targeted ring
  for (const bh of blackHoles) {
    if (bh.ringIdx >= rings.length || rings[bh.ringIdx].cleared) continue;
    const ring = rings[bh.ringIdx];
    const prog = bh.timer / bh.duration;
    const midR = (ring.inner + ring.outer) / 2;
    const pulse = 0.4 + Math.sin(prog * TAU * 6) * 0.3;
    ctx.beginPath();
    ctx.arc(cx, cy, midR, 0, TAU);
    ctx.strokeStyle = `rgba(124,58,237,${pulse})`;
    ctx.lineWidth   = ring.outer - ring.inner + 4;
    ctx.stroke();
  }

  // Draw lightning arcs
  for (const la of lightningArcs) {
    const midR = (la.ring.inner + la.ring.outer) / 2;
    const wa   = la.toSeg.startAngle + la.toSeg.span / 2 + la.ring.angle;
    const tx   = cx + Math.cos(wa) * midR;
    const ty   = cy + Math.sin(wa) * midR;
    ctx.strokeStyle = hexAlpha('#e2e8f0', la.life);
    ctx.lineWidth   = 1.5;
    ctx.setLineDash([3, 3]);
    ctx.beginPath();
    ctx.moveTo(la.from.x, la.from.y);
    ctx.lineTo(tx, ty);
    ctx.stroke();
    ctx.setLineDash([]);
  }

  // Tsunami sweep
  for (const ts of tsunamiEffects) {
    if (ts.ringIdx >= rings.length) continue;
    const ring = rings[ts.ringIdx];
    const midR = (ring.inner + ring.outer) / 2;
    ctx.strokeStyle = hexAlpha('#3b82f6', ts.life * 0.8);
    ctx.lineWidth   = ring.outer - ring.inner;
    ctx.beginPath();
    ctx.arc(cx, cy, midR, ts.angle, ts.angle + 0.8);
    ctx.stroke();
  }

  // Meteors
  for (const m of meteorEffects) {
    const startX = m.tx + (1 - m.progress) * -80;
    const startY = m.ty + (1 - m.progress) * -120;
    const ex     = lerp(startX, m.tx, m.progress);
    const ey     = lerp(startY, m.ty, m.progress);
    ctx.fillStyle = '#fb923c';
    ctx.beginPath();
    ctx.arc(ex, ey, 6, 0, TAU);
    ctx.fill();
    // Tail
    ctx.strokeStyle = hexAlpha('#fb923c', 0.5);
    ctx.lineWidth   = 3;
    ctx.beginPath();
    ctx.moveTo(startX, startY);
    ctx.lineTo(ex, ey);
    ctx.stroke();
  }

  // Ball trail
  drawBallTrail();

  // Particles
  for (const p of particles) {
    const alpha = Math.max(0, p.life);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = p.color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // Ball
  drawBall();

  // Floating texts
  for (const f of floatTexts) {
    const alpha = Math.min(1, f.life / f.maxLife * 2);
    ctx.globalAlpha = Math.max(0, alpha);
    ctx.fillStyle   = f.color;
    ctx.font        = `900 ${Math.floor(13 * f.scale)}px 'Orbitron',sans-serif`;
    ctx.textAlign   = 'center';
    ctx.fillText(f.text, f.x, f.y);
  }
  ctx.globalAlpha = 1;

  // Frenzy rainbow trail overlay
  if (frenzyActive || frenzyDecayTimer > 0) drawFrenzyTrail();
}

function drawBallTrail() {
  const tier = getComboTier();
  for (let i = 0; i < ballTrail.length; i++) {
    const t  = ballTrail[i];
    const a  = (i / ballTrail.length) * 0.45;
    let color;
    if (frenzyActive) {
      const hue = (Date.now() / 5 + i * 12) % 360;
      color = `hsla(${hue},100%,60%,${a})`;
    } else {
      color = hexAlpha(tier.color, a);
    }
    const r = ball.radius * (i / ballTrail.length) * 0.7;
    ctx.beginPath();
    ctx.arc(t.x, t.y, Math.max(1, r), 0, TAU);
    ctx.fillStyle = color;
    ctx.fill();
  }
}

function drawBall() {
  const bx = ball.x, by = ball.y, br = ball.radius;
  // Glow
  const tier  = getComboTier();
  const glowC = frenzyActive ? `hsla(${(Date.now() / 4) % 360},100%,70%,0.35)` : hexAlpha(tier.color, 0.3);
  const glow  = ctx.createRadialGradient(bx, by, 0, bx, by, br * 3);
  glow.addColorStop(0, glowC);
  glow.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(bx, by, br * 3, 0, TAU);
  ctx.fill();

  // Ball body
  const bodyG = ctx.createRadialGradient(bx - br * 0.3, by - br * 0.3, 0, bx, by, br);
  bodyG.addColorStop(0, frenzyActive ? '#fff' : '#e2e8f0');
  bodyG.addColorStop(1, frenzyActive ? '#f0abfc' : '#94a3b8');
  ctx.fillStyle = bodyG;
  ctx.beginPath();
  ctx.arc(bx, by, br, 0, TAU);
  ctx.fill();

  // Specular
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  ctx.beginPath();
  ctx.arc(bx - br * 0.3, by - br * 0.3, br * 0.3, 0, TAU);
  ctx.fill();
}

function drawFrenzyTrail() {
  for (let i = 0; i < ballTrail.length; i++) {
    const t   = ballTrail[i];
    const hue = (Date.now() / 4 + i * 15) % 360;
    const a   = (i / ballTrail.length) * 0.6 * (frenzyDecayTimer > 0 ? frenzyDecayTimer : 1);
    ctx.globalAlpha = a;
    ctx.fillStyle   = `hsl(${hue},100%,60%)`;
    const r = ball.radius * 1.1 * (i / ballTrail.length);
    ctx.beginPath();
    ctx.arc(t.x, t.y, Math.max(1, r), 0, TAU);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

function drawRing(ring, ri) {
  if (ring.cleared) return;
  const midR  = (ring.inner + ring.outer) / 2;
  const thick = ring.outer - ring.inner;
  const alpha = ring.type === 'phantom' ? (ring.phantomVisible ? 1 : 0.15) : 1;

  for (const seg of ring.segments) {
    if (!seg.alive) continue;
    const worldStart = seg.startAngle + ring.angle;
    const worldEnd   = worldStart + seg.span;

    // HP-based color
    const hpFrac = seg.hp / seg.maxHp;
    let color    = ring.color;
    if (hpFrac < 0.3) color = mixColors(color, '#6b7280', 1 - hpFrac / 0.3);

    // Type visual modifiers
    let strokeExtra = false;
    if (ring.type === 'armored') {
      color = mixColors(color, '#94a3b8', 0.5);
    } else if (ring.type === 'speed') {
      color = mixColors(color, '#f97316', 0.4);
    } else if (ring.type === 'shard') {
      color = mixColors(color, '#ef4444', 0.4);
    } else if (ring.type === 'magnet') {
      color = mixColors(color, '#22c55e', 0.35);
    } else if (ring.isBoss) {
      color = mixColors(color, '#ef4444', 0.6);
      strokeExtra = true;
    }

    ctx.globalAlpha = alpha;
    ctx.beginPath();
    ctx.arc(cx, cy, midR, worldStart, worldEnd);
    ctx.strokeStyle = color;
    ctx.lineWidth   = thick;
    ctx.lineCap     = 'butt';
    ctx.stroke();

    // Crack overlay when HP < 50%
    if (hpFrac < 0.5) {
      ctx.beginPath();
      ctx.arc(cx, cy, midR, worldStart, worldEnd);
      ctx.strokeStyle = `rgba(0,0,0,${(1 - hpFrac * 2) * 0.5})`;
      ctx.lineWidth   = thick;
      ctx.stroke();
    }

    // Boss glow pulse
    if (ring.isBoss) {
      const p = 0.5 + Math.sin(Date.now() / 400) * 0.5;
      ctx.beginPath();
      ctx.arc(cx, cy, midR, worldStart, worldEnd);
      ctx.strokeStyle = `rgba(239,68,68,${p * 0.3})`;
      ctx.lineWidth   = thick + 4;
      ctx.stroke();
    }

    // Weak point glow
    if (seg.weakPoint && seg.alive) {
      ctx.beginPath();
      ctx.arc(cx, cy, midR, worldStart, worldEnd);
      ctx.strokeStyle = `rgba(255,255,100,${0.4 + Math.sin(Date.now() / 300) * 0.3})`;
      ctx.lineWidth   = thick + 2;
      ctx.stroke();
    }

    // Burn effect
    const hasBurn = burnEffects.some(b => b.seg === seg);
    if (hasBurn) {
      ctx.beginPath();
      ctx.arc(cx, cy, midR, worldStart, worldEnd);
      ctx.strokeStyle = `rgba(249,115,22,${0.4 + Math.random() * 0.2})`;
      ctx.lineWidth   = thick + 2;
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  // Phantom ring: draw ghost outline when invisible
  if (ring.type === 'phantom' && !ring.phantomVisible) {
    ctx.globalAlpha = 0.08;
    ctx.beginPath();
    ctx.arc(cx, cy, midR, 0, TAU);
    ctx.strokeStyle = '#94a3b8';
    ctx.lineWidth   = thick;
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // Magnet pull lines
  if (ring.type === 'magnet' && !ring.cleared) {
    const bx = ball.x - cx, by2 = ball.y - cy;
    const bd = Math.hypot(bx, by2);
    if (Math.abs(bd - midR) < 60) {
      ctx.strokeStyle = 'rgba(34,197,94,0.15)';
      ctx.lineWidth   = 1;
      ctx.setLineDash([2, 4]);
      ctx.beginPath();
      ctx.moveTo(ball.x, ball.y);
      ctx.lineTo(cx + bx / bd * midR, cy + by2 / bd * midR);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function drawIdleBackground() {
  // Show gentle rotating demo rings
  const t = Date.now() / 1000;
  for (let i = 0; i < 4; i++) {
    const r     = 80 + i * 55;
    const alpha = 0.08 + i * 0.02;
    ctx.globalAlpha = alpha;
    ctx.strokeStyle = RING_PALETTE[i % RING_PALETTE.length];
    ctx.lineWidth   = 14;
    ctx.beginPath();
    // draw 3/4 arc rotating
    ctx.arc(cx, cy, r, t * (0.3 + i * 0.07), t * (0.3 + i * 0.07) + TAU * 0.75);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// Color helpers
function hexAlpha(hex, a) {
  if (hex.startsWith('hsl')) return hex.replace(/[\d.]+\)$/, `${a})`).replace('hsl','hsla').replace(/,(\d)/, ',1,$1');
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
}
function mixColors(hex1, hex2, t) {
  const r1=parseInt(hex1.slice(1,3),16),g1=parseInt(hex1.slice(3,5),16),b1=parseInt(hex1.slice(5,7),16);
  const r2=parseInt(hex2.slice(1,3),16),g2=parseInt(hex2.slice(3,5),16),b2=parseInt(hex2.slice(5,7),16);
  const r=Math.round(r1*(1-t)+r2*t),g=Math.round(g1*(1-t)+g2*t),b=Math.round(b1*(1-t)+b2*t);
  return `rgb(${r},${g},${b})`;
}

// ═══════════════════════════════════════════════════════
// §16  HUD UPDATE
// ═══════════════════════════════════════════════════════
function updateHUD() {
  if (infiniteMode) {
    const hudLv = $('hudLevel');
    if (hudLv) hudLv.textContent = '∞';
    const hudRings = $('hudRings');
    if (hudRings) hudRings.textContent = `Score: ${infiniteScore}`;
    const secsInf = Math.floor(infTime);
    const hudTime = $('hudTimer');
    if (hudTime) hudTime.textContent = `${Math.floor(secsInf/60)}:${String(secsInf%60).padStart(2,'0')}`;
    const hudPar = $('hudPar');
    if (hudPar) hudPar.style.display = 'none';
  } else {
    const lv = S.currentLevel;
    // Level
    const hudLv = $('hudLevel');
    if (hudLv) hudLv.textContent = `Lv ${lv}`;
    // Ring progress
    const total   = rings.length;
    const cleared = rings.filter(r => r.cleared).length;
    const hudRings = $('hudRings');
    if (hudRings) hudRings.textContent = `Ring ${Math.min(cleared + 1, total)}/${total}`;
    // Timer
    const secs    = Math.floor(levelPlayTime);
    const mm      = Math.floor(secs / 60);
    const ss      = String(secs % 60).padStart(2, '0');
    const hudTime = $('hudTimer');
    if (hudTime) hudTime.textContent = `${mm}:${ss}`;
    // Par
    const hudPar  = $('hudPar');
    if (hudPar) {
      if (levelPlayTime <= parTime) {
        hudPar.textContent = `⏱ Under par`;
        hudPar.style.display = '';
      } else { hudPar.style.display = 'none'; }
    }
  }
  // Combo
  const cw   = $('comboWrap');
  const ct   = $('comboText');
  if (cw && ct) {
    if (combo >= 5 && comboDisplayTimer > 0) {
      cw.style.opacity = '1';
      const tier = getComboTier();
      ct.textContent   = `×${combo}`;
      ct.style.color   = tier.color;
      ct.style.fontSize= `${Math.min(3.5, 2.2 + combo * 0.025)}rem`;
    } else {
      cw.style.opacity = '0';
    }
  }
  // Currency header
  updateCurrencyDisplay();
  // Ability bar
  rebuildAbilityBar();
  // XP bar
  const xpFill = $('xpBar');
  if (xpFill) xpFill.style.width = `${xpToNext > 0 ? Math.min(100, (xp / xpToNext) * 100) : 0}%`;
  const xpLbl = $('xpLabel');
  if (xpLbl) xpLbl.textContent = `LVL ${xpLevel}`;
  updateLvlUpgHUD();
}

function rebuildAbilityBar() {
  const bar = $('abilityBar');
  if (!bar) return;
  const equipped = S.equippedAbilities.slice(0, S.abilitySlots);
  if (bar.dataset.built === equipped.join(',')) return;
  bar.dataset.built = equipped.join(',');
  bar.innerHTML = '';
  for (const key of equipped) {
    const def  = ABILITIES[key];
    const info = S.abilities[key];
    if (!def) continue;
    const slot = document.createElement('div');
    slot.className    = 'be-aslot';
    slot.id           = `aslot_${key}`;
    slot.innerHTML    = `<span class="be-aslot-icon">${def.icon}</span><span class="be-aslot-label">${def.procLabel(info.level)}</span>`;
    bar.appendChild(slot);
  }
}

function updateCurrencyDisplay() {
  const sets = [['goldHdr','gemHdr'],['hubGold','hubGems'],['goldUpg','gemUpg']];
  for (const [gi,gemi] of sets) {
    const ge = $(gi), gme = $(gemi);
    if (ge)  ge.textContent  = S.gold.toLocaleString();
    if (gme) gme.textContent = S.gems.toLocaleString();
  }
}

// ═══════════════════════════════════════════════════════
// §16b LEVEL-SCOPE COIN UPGRADES
// ═══════════════════════════════════════════════════════
function lvlUpgDmgMult() {
  return Math.pow(2, lvlUpg.dmg.tier) * (1 + lvlUpg.dmg.steps * 0.20);
}
function lvlUpgCoinsPerHit() {
  return Math.round(LVL_COINS_BASE * Math.pow(2, lvlUpg.coins.tier) * (1 + lvlUpg.coins.steps * 0.20));
}
function lvlUpgStepCost(which) {
  const u = lvlUpg[which];
  const totalBought = u.tier * LVL_UPG_STEPS + u.steps;
  return Math.floor(10 * Math.pow(1.5, totalBought));
}
function buyLvlUpg(which) {
  const cost = lvlUpgStepCost(which);
  if (levelCoins < cost) return;
  levelCoins -= cost;
  const u = lvlUpg[which];
  u.steps++;
  if (u.steps >= LVL_UPG_STEPS) {
    u.steps = 0;
    u.tier++;
    const label = which === 'dmg' ? '\ud83d\udca5 DMG' : '\ud83e\ude99 COINS';
    spawnFloat(cx, cy - 90, `${label} DOUBLED!`, '#fbbf24', 1.8);
  }
}
function updateLvlUpgHUD() {
  const coinEl = $('lvlCoinsDisplay');
  if (!coinEl) return;
  coinEl.textContent = levelCoins;
  // \u2500 Damage upgrade
  const dMult   = lvlUpgDmgMult();
  const dStat   = $('lvlUpgDmgStat');   if (dStat)   dStat.textContent  = `\u00d7${dMult.toFixed(1)}`;
  const dBar    = $('lvlUpgDmgBar');    if (dBar)    dBar.style.width   = `${(lvlUpg.dmg.steps / LVL_UPG_STEPS) * 100}%`;
  const dCost   = lvlUpgStepCost('dmg');
  const dCostEl = $('lvlUpgDmgCost');   if (dCostEl) dCostEl.textContent = dCost;
  const dBtn    = $('btnLvlUpgDmg');    if (dBtn)    dBtn.disabled = levelCoins < dCost;
  // \u2500 Coins-per-hit upgrade
  const cph     = lvlUpgCoinsPerHit();
  const cStat   = $('lvlUpgCoinsStat'); if (cStat)   cStat.textContent  = `${cph}/hit`;
  const cBar    = $('lvlUpgCoinsBar');  if (cBar)    cBar.style.width   = `${(lvlUpg.coins.steps / LVL_UPG_STEPS) * 100}%`;
  const cCost   = lvlUpgStepCost('coins');
  const cCostEl = $('lvlUpgCoinsCost'); if (cCostEl) cCostEl.textContent = cCost;
  const cBtn    = $('btnLvlUpgCoins'); if (cBtn)    cBtn.disabled = levelCoins < cCost;
}


const ALL_SCREENS = ['screenHub','screenIntro','screenLevelEnd','screenChest','screenUpgrade','screenStats'];
function showScreen(id) {
  for (const s of ALL_SCREENS) {
    const el = $(s);
    if (el) el.style.display = s === id ? '' : 'none';
  }
  $('beHud').style.display        = 'none';
  $('pauseOverlay').style.display  = 'none';
  const xpOvr = $('xpPickerOverlay');
  if (xpOvr) xpOvr.style.display = 'none';
  screen = id.replace('screen','').toLowerCase();
}
function showGameCanvas() {
  for (const s of ALL_SCREENS) { const el = $(s); if (el) el.style.display = 'none'; }
  $('beHud').style.display        = '';
  $('pauseOverlay').style.display = 'none';
  const xpOvr = $('xpPickerOverlay');
  if (xpOvr) xpOvr.style.display = 'none';
  screen = 'playing';
}

// ═══════════════════════════════════════════════════════
// §18  HUB SCREEN
// ═══════════════════════════════════════════════════════
function renderHub() {
  showScreen('screenHub');
  $('hubLevelNum').textContent  = `LEVEL ${S.currentLevel}`;
  updateCurrencyDisplay();
  const tb = $('hubTitleBadge');
  if (S.title) { tb.textContent = S.title.toUpperCase(); tb.style.display = ''; }
  else          { tb.style.display = 'none'; }
}

// ═══════════════════════════════════════════════════════
// §19  LEVEL INTRO SCREEN
// ═══════════════════════════════════════════════════════
function getDifficultyTier(lv) {
  if (lv <= 10)  return { label: 'Easy',      cls: 'tier-easy'  };
  if (lv <= 25)  return { label: 'Normal',    cls: 'tier-normal'};
  if (lv <= 50)  return { label: 'Hard',      cls: 'tier-hard'  };
  if (lv <= 100) return { label: 'Brutal',    cls: 'tier-brutal'};
  return                 { label: 'Nightmare',cls: 'tier-nightmare'};
}

function renderIntro() {
  const lv   = S.currentLevel;
  const tier = getDifficultyTier(lv);
  // Generate rings (preview only, not assigned yet)
  const previewRings = generateLevel(lv);
  const specials = [...new Set(previewRings.filter(r => r.type !== 'normal' && r.type !== 'boss').map(r => r.type))];
  const hasBoss  = previewRings.some(r => r.isBoss);
  const typeLabels = { armored:'🔩 Armored', speed:'⚡ Speed Ring', phantom:'👻 Phantom', magnet:'🧲 Magnet', shard:'💥 Shard' };
  const specialHTML = [...specials.map(t => `<span class="be-special-badge">${typeLabels[t]||t}</span>`),
    ...(hasBoss ? ['<span class="be-special-badge" style="color:#ef4444;border-color:rgba(239,68,68,.3)">💀 Boss Ring</span>'] : [])
  ].join('');

  $('introCard').innerHTML = `
    <div class="be-intro-lvl-label">LEVEL ${lv}</div>
    <div class="be-intro-title">Level ${lv}</div>
    <span class="be-intro-tier ${tier.cls}">${tier.label}</span>
    <div class="be-intro-info">${previewRings.length} rings · solid outer wall · rings shrink over time</div>
    ${specials.length || hasBoss ? `<div class="be-intro-specials">${specialHTML}</div>` : '<div style="margin-bottom:1.4rem"></div>'}
    <div class="be-intro-btns">
      <button class="btn btn-primary be-btn-xl" id="btnStartLevel">▶ Start Level</button>
      <button class="btn be-btn-sec" id="btnIntroUpgrades">⚙ Upgrades</button>
    </div>`;
  showScreen('screenIntro');
  $('btnStartLevel').onclick   = () => startLevel();
  $('btnIntroUpgrades').onclick = () => { screenBeforeUpgrade = 'intro'; openUpgradeMenu(); };
}

// ═══════════════════════════════════════════════════════
// §20  GAME LOOP & LEVEL FLOW
// ═══════════════════════════════════════════════════════
function startLevel() {
  const lv   = S.currentLevel;
  rings      = generateLevel(lv);
  // Reset state
  ball.radius           = 8 + S.upgrades.ballSize * 3;
  ball.x = cx; ball.y = cy;
  const initSpeed       = (MIN_SPEED * 4 + S.upgrades.ballSpeed * MIN_SPEED * 0.4) * (1 + S.upgrades.ballSpeed * 0.08);
  const initAngle       = Math.random() * TAU;
  ball.vx               = Math.cos(initAngle) * initSpeed;
  ball.vy               = Math.sin(initAngle) * initSpeed;
  ballTrail             = [];
  combo = 0; comboTimer = 0; comboDisplayTimer = 0;
  critPending           = false;
  frenzyActive          = false; frenzyTimer = 0; frenzyDecayTimer = 0;
  frozenRings.clear();
  burnEffects           = [];
  blackHoles            = [];
  vortexActive          = false;
  particles             = [];
  floatTexts            = [];
  shockwaveRings        = [];
  lightningArcs         = [];
  tsunamiEffects        = [];
  meteorEffects         = [];
  levelPlayTime         = 0;
  levelGoldPartial      = 0;
  ringsClearedCount     = 0;
  totalDmgThisLevel     = 0;
  tooBigShownThisLevel  = false;
  // Reset per-level XP / roguelite state
  xp           = 0;
  xpLevel      = 0;
  xpToNext     = 120;
  levelPerks   = [];
  xpPickerOpen = false;
  pendingXPLevels = 0;
  // Reset level-scope coin upgrades
  levelCoins           = 0;
  lvlUpg.dmg.tier      = 0;  lvlUpg.dmg.steps   = 0;
  lvlUpg.coins.tier    = 0;  lvlUpg.coins.steps  = 0;
  const xpOvr = $('xpPickerOverlay');
  if (xpOvr) xpOvr.style.display = 'none';
  paused        = false;
  gameRunning   = true;
  showGameCanvas();
  rebuildAbilityBar();
  startGameLoop();
}

// ═══════════════════════════════════════════════════════
// §10b  INFINITE MODE FUNCTIONS
// ═══════════════════════════════════════════════════════
function generateInfiniteLevel(rng) {
  const numRings = 5;
  const radii    = computeRadii(numRings);
  const result   = [];
  let prevDir;
  for (let i = 0; i < numRings; i++) {
    const gapDeg = Math.max(8, 18 - i * 2 + S.upgrades.gapWidener * 3);
    const layout = buildRingLayout(rng, gapDeg, false);
    const hpBase = Math.floor(100 * Math.pow(1.05, i));
    for (const seg of layout.segments) { seg.hp = hpBase; seg.maxHp = hpBase; }
    let dir = rng() < 0.5 ? 1 : -1;
    if (prevDir !== undefined && dir === prevDir) dir = -dir;
    prevDir = dir;
    const rotSpd = (0.25 + rng() * 0.15) * dir * (1 - S.upgrades.ringSlow * 0.03);
    result.push({
      inner: radii[i].inner, outer: radii[i].outer,
      thickness: radii[i].outer - radii[i].inner,
      shrinkRate: 0,
      angle: rng() * TAU, dir,
      rotSpd,
      segments: layout.segments,
      gaps: layout.gaps,
      type: 'normal',
      color: RING_PALETTE[i % RING_PALETTE.length],
      isOutermost: false,
      cleared: false,
      activeTime: 0,
      frozenTimer: 0,
      phantomVisible: true, phantomTimer: 0, phantomCycle: 3.0 + rng(),
      isBoss: false,
    });
  }
  return result;
}

function spawnInfiniteRing() {
  // Prune old cleared rings to keep the array lean
  rings = rings.filter(r => !r.cleared);

  const seed = ((performance.now() * 1000 + infiniteScore * 7919 + infTime * 100) | 0) >>> 0;
  const rng  = mkRng(seed);

  // Spawn just outside the outermost uncleared ring
  let outermostOuter = 0;
  for (const r of rings) {
    if (!r.cleared && r.outer > outermostOuter) outermostOuter = r.outer;
  }
  const maxR       = cSize / 2 - 12;
  const spawnInner = outermostOuter > 0 ? outermostOuter + 8 : maxR - RING_THICK;
  const spawnOuter = spawnInner + RING_THICK;

  const gapDeg = Math.max(5, 18 - Math.floor(infTime / 10) * 2 + S.upgrades.gapWidener * 3);
  const layout = buildRingLayout(rng, gapDeg, false);
  const hpBase = Math.floor(100 * Math.pow(1.06, infiniteScore));
  for (const seg of layout.segments) { seg.hp = hpBase; seg.maxHp = hpBase; }

  const dir    = rng() < 0.5 ? 1 : -1;
  const rotSpd = Math.min(1.8, (0.25 + infTime * 0.003 + rng() * 0.1)) * dir * (1 - S.upgrades.ringSlow * 0.03);

  rings.push({
    inner: spawnInner, outer: spawnOuter,
    thickness: RING_THICK,
    shrinkRate: 0,
    angle: rng() * TAU, dir,
    rotSpd,
    segments: layout.segments,
    gaps: layout.gaps,
    type: 'normal',
    color: RING_PALETTE[infiniteScore % RING_PALETTE.length],
    isOutermost: false,
    cleared: false,
    activeTime: 0,
    frozenTimer: 0,
    phantomVisible: true, phantomTimer: 0, phantomCycle: 3.0 + rng(),
    isBoss: false,
  });
}

function startInfiniteMode() {
  infiniteMode  = true;
  infiniteScore = 0;
  infTime       = 0;
  infSpawnTimer = 1.5;

  const rng = mkRng(((performance.now() * 999) | 0) >>> 0);
  rings = generateInfiniteLevel(rng);

  ball.radius           = 8 + S.upgrades.ballSize * 3;
  ball.x = cx; ball.y = cy;
  const initSpeed       = (MIN_SPEED * 4 + S.upgrades.ballSpeed * MIN_SPEED * 0.4) * (1 + S.upgrades.ballSpeed * 0.08);
  const initAngle       = Math.random() * TAU;
  ball.vx               = Math.cos(initAngle) * initSpeed;
  ball.vy               = Math.sin(initAngle) * initSpeed;
  ballTrail             = [];
  combo = 0; comboTimer = 0; comboDisplayTimer = 0;
  critPending           = false;
  frenzyActive          = false; frenzyTimer = 0; frenzyDecayTimer = 0;
  frozenRings.clear();
  burnEffects           = [];
  blackHoles            = [];
  vortexActive          = false;
  particles             = [];
  floatTexts            = [];
  shockwaveRings        = [];
  lightningArcs         = [];
  tsunamiEffects        = [];
  meteorEffects         = [];
  levelPlayTime         = 0;
  levelGoldPartial      = 0;
  ringsClearedCount     = 0;
  totalDmgThisLevel     = 0;
  tooBigShownThisLevel  = false;
  xp           = 0;
  xpLevel      = 0;
  xpToNext     = 120;
  levelPerks   = [];
  xpPickerOpen = false;
  pendingXPLevels = 0;
  levelCoins           = 0;
  lvlUpg.dmg.tier      = 0;  lvlUpg.dmg.steps   = 0;
  lvlUpg.coins.tier    = 0;  lvlUpg.coins.steps  = 0;
  const xpOvr = $('xpPickerOverlay');
  if (xpOvr) xpOvr.style.display = 'none';
  paused      = false;
  gameRunning = true;
  showGameCanvas();
  rebuildAbilityBar();
  startGameLoop();
}

function endInfinite() {
  const wasInfinite = infiniteMode;
  infiniteMode = false;
  stopGameLoop();
  if (wasInfinite && infiniteScore > (S.bestInfiniteScore || 0)) {
    S.bestInfiniteScore = infiniteScore;
    doSave();
  }
  const rc = $('resultCard');
  if (rc) {
    rc.innerHTML = `
      <div class="be-result-loss">\u221e GAME OVER</div>
      <div class="be-result-sub">Infinite Mode</div>
      <div class="be-result-row"><span>Rings Cleared</span><span class="be-result-val">${infiniteScore}</span></div>
      <div class="be-result-row"><span>Time Survived</span><span class="be-result-val">${Math.floor(infTime)}s</span></div>
      <div class="be-result-row"><span>Best Score</span><span class="be-result-val">${S.bestInfiniteScore || 0}</span></div>
      <div class="be-result-btns">
        <button class="btn btn-primary" id="btnInfRetry">\u21a9 Play Again</button>
        <button class="btn be-btn-sec" id="btnInfHub">\u2b05 Hub</button>
      </div>`;
  }
  showScreen('screenLevelEnd');
  $('btnInfRetry').onclick = () => startInfiniteMode();
  $('btnInfHub').onclick   = () => renderHub();
}

function startGameLoop() {
  if (animId) cancelAnimationFrame(animId);
  lastTime = performance.now();
  physAccum = 0;
  function loop(ts) {
    if (!gameRunning) return;
    const dt = Math.min((ts - lastTime) / 1000, 0.1);
    lastTime = ts;
    if (!paused) { physAccum += dt; while (physAccum >= FIXED_DT) { physicsStep(); physAccum -= FIXED_DT; } }
    renderFrame();
    updateHUD();
    animId = requestAnimationFrame(loop);
  }
  animId = requestAnimationFrame(loop);
}

function stopGameLoop() { if (animId) { cancelAnimationFrame(animId); animId = null; } gameRunning = false; }

function pauseGame() {
  paused = true;
  $('pauseOverlay').style.display = '';
}
function resumeGame() {
  paused = false;
  $('pauseOverlay').style.display = 'none';
  lastTime = performance.now(); physAccum = 0;
}

function endLevel(win) {
  stopGameLoop();
  if (!win) {
    showLevelLoss();
    return;
  }

  S.stats.totalLevels++;
  if (S.currentLevel > S.highestLevel) S.highestLevel = S.currentLevel;

  // Gold calculation
  const comboMult  = getComboTier().goldMult;
  const goldMult   = 1 + S.upgrades.goldBoost * 0.12;
  const timeBonusMult = levelPlayTime <= parTime ? 1 + S.upgrades.timeBonus * 0.10 : 1;
  const goldEarned = Math.floor(50 * S.currentLevel * comboMult * goldMult * timeBonusMult);
  const gemsEarned = 1 + (S.currentLevel % 5 === 0 ? 2 : 0);
  S.gold += goldEarned; S.stats.totalGold += goldEarned;
  S.gems += gemsEarned; S.stats.totalGems += gemsEarned;

  // Chest roll
  const chestDropChance = 0.40 + S.upgrades.chestLuck * 0.05;
  const chestGuaranteed = S.currentLevel % 5 === 0;
  const bossDrop        = S.currentLevel % 10 === 0;
  let chestRarity = null;
  if (bossDrop || chestGuaranteed || Math.random() < chestDropChance) {
    chestRarity = rollChestRarity(bossDrop);
    S.chestInventory.push(chestRarity);
    if (S.chestInventory.length > 10) S.chestInventory.shift();
  }

  S.currentLevel++;
  checkMilestones(S.currentLevel - 1);
  doSave();

  showLevelEnd(goldEarned, gemsEarned, chestRarity);
}

function abandonLevel() {
  stopGameLoop();
  if (infiniteMode) { endInfinite(); return; }
  // Award partial gold
  const partial = Math.floor(levelGoldPartial * 0.5);
  if (partial > 0) { S.gold += partial; S.stats.totalGold += partial; }
  doSave();
  renderHub();
}

function showLevelLoss() {
  $('resultCard').innerHTML = `
    <div class="be-result-loss">💀 CRUSHED!</div>
    <div class="be-result-sub">A ring closed around your ball.</div>
    <div class="be-result-row"><span>Level</span><span class="be-result-val">${S.currentLevel}</span></div>
    <div class="be-result-row"><span>Rings broken</span><span class="be-result-val">${ringsClearedCount}</span></div>
    <div class="be-result-row"><span>Total damage</span><span class="be-result-val">${Math.floor(totalDmgThisLevel).toLocaleString()}</span></div>
    <div class="be-result-btns">
      <button class="btn btn-primary" id="btnTryAgain">↩ Try Again</button>
      <button class="btn be-btn-sec" id="btnGoHub">⬅ Hub</button>
    </div>`;
  showScreen('screenLevelEnd');
  $('btnTryAgain').onclick = () => startLevel();
  $('btnGoHub').onclick    = () => renderHub();
}

// ═══════════════════════════════════════════════════════
// §21  LEVEL END SCREEN
// ═══════════════════════════════════════════════════════
function showLevelEnd(goldEarned, gemsEarned, chestRarity) {
  const t = levelPlayTime;
  const mm = Math.floor(t / 60), ss = (t % 60).toFixed(1);
  const underPar = t <= parTime;
  $('resultCard').innerHTML = `
    <div class="be-result-win">✓ LEVEL COMPLETE</div>
    <div class="be-result-row"><span>Time</span><span class="be-result-val">${mm}:${String(ss).padStart(4,'0')} ${underPar ? '⚡ Under par!' : ''}</span></div>
    <div class="be-result-row"><span>Rings broken</span><span class="be-result-val">${ringsClearedCount}</span></div>
    <div class="be-result-row"><span>Total damage</span><span class="be-result-val">${Math.floor(totalDmgThisLevel).toLocaleString()}</span></div>
    <div class="be-result-row"><span>Highest combo</span><span class="be-result-val">×${S.stats.highestCombo}</span></div>
    <div class="be-result-earn">
      <div class="be-result-gold">+${goldEarned.toLocaleString()} 🪙</div>
      <div class="be-result-gems">+${gemsEarned} 💎</div>
    </div>
    ${chestRarity ? `<div class="be-result-chest-notif">🎁 Chest dropped: <b>${chestRarity.charAt(0).toUpperCase()+chestRarity.slice(1)}</b></div>` : ''}
    <div class="be-result-btns">
      ${chestRarity ? `<button class="btn btn-primary" id="btnOpenChest">🎁 Open Chest</button>` : ''}
      <button class="btn be-btn-sec" id="btnGoUpgrades">⚙ Upgrades</button>
      <button class="btn btn-primary" id="btnNextLevel">▶ Next Level</button>
    </div>`;
  showScreen('screenLevelEnd');
  updateCurrencyDisplay();
  if (chestRarity) $('btnOpenChest').onclick = () => openChestScreen(chestRarity, true);
  $('btnGoUpgrades').onclick = () => { screenBeforeUpgrade = 'upgrade_then_next'; openUpgradeMenu(); };
  $('btnNextLevel').onclick   = () => { showMilestoneQueueThenDo(() => renderIntro()); };
}

// ═══════════════════════════════════════════════════════
// §22  CHEST SYSTEM
// ═══════════════════════════════════════════════════════
const CHEST_RARITIES = {
  common:    { icon:'📦', label:'Common',    color:'#94a3b8' },
  rare:      { icon:'🟦', label:'Rare',      color:'#3b82f6' },
  epic:      { icon:'🟣', label:'Epic',      color:'#a855f7' },
  legendary: { icon:'🌟', label:'Legendary', color:'#fbbf24' },
};

function rollChestRarity(isBoss) {
  const luck = S.upgrades.chestLuck;
  const r    = Math.random();
  if (isBoss) {
    if (r < 0.03 + luck * 0.01) return 'legendary';
    if (r < 0.15 + luck * 0.03) return 'epic';
    return 'rare';
  }
  if (r < 0.03 + luck * 0.01)  return 'legendary';
  if (r < 0.15 + luck * 0.03)  return 'epic';
  if (r < 0.40 + luck * 0.05)  return 'rare';
  return 'common';
}

function openChestScreen(rarity, fromLevelEnd) {
  const def  = CHEST_RARITIES[rarity] || CHEST_RARITIES.common;
  const scene= $('chestScene');
  scene.innerHTML = `
    <div class="be-chest-rarity-title rarity-${rarity}">${def.icon} ${def.label} Chest</div>
    <div class="be-chest-emoji shaking" id="chestEmoji">${def.icon}</div>
    <div class="be-chest-instruction">CLICK TO OPEN</div>
    <div class="be-chest-rewards" id="chestRewards"></div>
    <button class="btn be-btn-sec be-chest-continue-btn" id="btnChestContinue">Continue →</button>`;
  showScreen('screenChest');
  let opened = false;
  $('chestEmoji').onclick = () => {
    if (opened) return;
    opened = true;
    $('chestEmoji').classList.remove('shaking');
    $('chestEmoji').style.transform = 'scale(1.2)';
    revealChestRewards(rarity, $('chestRewards'), fromLevelEnd);
  };
}

function revealChestRewards(rarity, container, fromLevelEnd) {
  const rewards = computeChestRewards(rarity);
  // Apply rewards
  S.gold += rewards.gold; S.stats.totalGold += rewards.gold;
  S.gems += rewards.gems; S.stats.totalGems += rewards.gems;
  // Remove chest from inventory if opened from upgrade tab
  if (!fromLevelEnd) {
    const idx = S.chestInventory.indexOf(rarity);
    if (idx >= 0) S.chestInventory.splice(idx, 1);
  }
  // Reveal rewards one by one
  let i = 0;
  const rewardList = [];
  rewardList.push(`🪙 +${rewards.gold.toLocaleString()} Gold`);
  rewardList.push(`💎 +${rewards.gems} Gems`);
  if (rewards.upgradeKeys.length) rewardList.push(`⬆ +1 ${UPGRADES[rewards.upgradeKeys[0]]?.name || 'Upgrade'}`);
  if (rewards.upgradeKeys.length > 1) rewardList.push(`⬆ +1 ${UPGRADES[rewards.upgradeKeys[1]]?.name || 'Upgrade'}`);
  if (rewards.abilityUnlock) rewardList.push(`✨ Ability Unlocked: ${ABILITIES[rewards.abilityUnlock]?.name || rewards.abilityUnlock}`);
  // Apply upgrades
  for (const k of rewards.upgradeKeys) {
    if (UPGRADES[k]) {
      const max = UPGRADES[k].max;
      if (S.upgrades[k] < max) S.upgrades[k]++;
    }
  }
  if (rewards.abilityUnlock) S.abilities[rewards.abilityUnlock].unlocked = true;
  doSave(); updateCurrencyDisplay();
  function showNext() {
    if (i >= rewardList.length) {
      const btn = $('btnChestContinue');
      if (btn) { btn.classList.add('show'); btn.onclick = () => fromLevelEnd ? openUpgradeMenu('upgrade_then_next') : openUpgradeMenu(); }
      return;
    }
    const el = document.createElement('div');
    el.className = 'be-chest-reward-item';
    el.textContent = rewardList[i++];
    container.appendChild(el);
    setTimeout(showNext, 400);
  }
  setTimeout(showNext, 300);
}

function computeChestRewards(rarity) {
  switch (rarity) {
    case 'legendary': return {
      gold: 800 + Math.floor(Math.random() * 700), gems: 15 + Math.floor(Math.random() * 16),
      upgradeKeys: pick2RandomUpgrades(), abilityUnlock: pickRandomAbility(true),
    };
    case 'epic': return {
      gold: 300 + Math.floor(Math.random() * 301), gems: 6 + Math.floor(Math.random() * 7),
      upgradeKeys: [pickRandomUpgrade()], abilityUnlock: Math.random() < 0.3 ? pickRandomAbility(false) : null,
    };
    case 'rare': return {
      gold: 100 + Math.floor(Math.random() * 151), gems: 2 + Math.floor(Math.random() * 4),
      upgradeKeys: [pickRandomUpgrade()], abilityUnlock: null,
    };
    default: return {
      gold: 30 + Math.floor(Math.random() * 51), gems: Math.random() < 0.5 ? 1 : 0,
      upgradeKeys: [], abilityUnlock: null,
    };
  }
}

function pickRandomUpgrade() {
  const keys = Object.keys(UPGRADES).filter(k => S.upgrades[k] < UPGRADES[k].max);
  return keys.length ? keys[Math.floor(Math.random() * keys.length)] : null;
}
function pick2RandomUpgrades() {
  const keys = Object.keys(UPGRADES).filter(k => S.upgrades[k] < UPGRADES[k].max);
  if (keys.length < 2) return keys;
  const i1 = Math.floor(Math.random() * keys.length);
  const i2 = (i1 + 1 + Math.floor(Math.random() * (keys.length - 1))) % keys.length;
  return [keys[i1], keys[i2]];
}
function pickRandomAbility(levelUp) {
  const keys = Object.keys(ABILITIES).filter(k => levelUp ? S.abilities[k].unlocked : !S.abilities[k].unlocked);
  return keys.length ? keys[Math.floor(Math.random() * keys.length)] : null;
}

// ═══════════════════════════════════════════════════════
// §23  UPGRADE MENU
// ═══════════════════════════════════════════════════════
let _upgMenuFromLevelEnd = false;
function openUpgradeMenu(fromCtx) {
  _upgMenuFromLevelEnd = (fromCtx === 'upgrade_then_next');
  screenBeforeUpgrade  = fromCtx || screen;
  showScreen('screenUpgrade');
  updateCurrencyDisplay();
  renderUpgradeTab(upgradeTabActive);
  updateChestCount();
}

function updateChestCount() {
  const el = $('chestCount');
  if (el) el.textContent = S.chestInventory.length;
}

function renderUpgradeTab(tab) {
  upgradeTabActive = tab;
  $('upgTabs').querySelectorAll('.be-upg-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const body = $('upgBody');
  body.innerHTML = '';
  if (tab === 'ball' || tab === 'rings' || tab === 'economy') {
    const catMap = { ball:'ball', rings:'rings', economy:'econ' };
    const cat    = catMap[tab];
    const grid   = document.createElement('div');
    grid.className = 'be-upg-grid';
    for (const [key, def] of Object.entries(UPGRADES)) {
      if (def.cat !== cat) continue;
      const lvl   = S.upgrades[key];
      const maxed = lvl >= def.max;
      const cost  = maxed ? 0 : def.cost(lvl);
      const canBuy= !maxed && S.gold >= cost;
      const card  = document.createElement('div');
      card.className = `be-upg-card${maxed ? ' maxed' : ''}`;
      card.innerHTML = `
        <div class="be-upg-head">
          <span class="be-upg-icon">${def.icon}</span>
          <span class="be-upg-name">${def.name}</span>
          <span class="be-upg-lvl${maxed?' maxed':''}">${lvl}/${def.max}</span>
        </div>
        <div class="be-upg-desc">${def.desc}</div>
        <div class="be-upg-stat">${def.stat(lvl)}</div>
        <button class="be-upg-btn ${maxed?'done':canBuy?'can':'no'}" data-key="${key}">
          ${maxed ? 'MAX' : `🪙 ${cost.toLocaleString()}`}
        </button>`;
      grid.appendChild(card);
    }
    body.appendChild(grid);
    body.querySelectorAll('.be-upg-btn.can').forEach(btn => {
      btn.addEventListener('click', () => handleUpgradePurchase(btn.dataset.key));
    });
  } else if (tab === 'abilities') {
    renderAbilitiesTab(body);
  } else if (tab === 'chests') {
    renderChestsTab(body);
  }
}

function handleUpgradePurchase(key) {
  const def = UPGRADES[key];
  if (!def) return;
  const lvl = S.upgrades[key];
  if (lvl >= def.max) return;
  const cost = def.cost(lvl);
  if (S.gold < cost) return;
  S.gold -= cost;
  S.upgrades[key]++;
  doSave(); updateCurrencyDisplay();
  renderUpgradeTab(upgradeTabActive);
}

function renderAbilitiesTab(body) {
  // Equip slots header
  const maxSlots = S.abilitySlots;
  const slotDiv  = document.createElement('div');
  slotDiv.className = 'be-ability-equip-row';
  slotDiv.innerHTML = `<span class="be-eq-label">EQUIPPED (${S.equippedAbilities.length}/${maxSlots})</span>`;
  for (let i = 0; i < 4; i++) {
    const key   = S.equippedAbilities[i];
    const locked= i >= maxSlots;
    const slot  = document.createElement('div');
    slot.className = `be-eq-slot${key && !locked ? ' filled' : ''}`;
    slot.title = locked ? 'Slot locked (reach milestone)' : key ? `${ABILITIES[key].name} — click to unequip` : 'Empty';
    slot.style.opacity = locked ? '0.35' : '1';
    slot.innerHTML = key && !locked ? ABILITIES[key].icon : locked ? '🔒' : '';
    if (key && !locked) slot.onclick = () => { unequipAbility(key); renderUpgradeTab('abilities'); };
    slotDiv.appendChild(slot);
  }
  body.appendChild(slotDiv);

  const grid = document.createElement('div');
  grid.className = 'be-ability-grid';
  for (const [key, def] of Object.entries(ABILITIES)) {
    const info    = S.abilities[key];
    const unlocked= info.unlocked;
    const lvl     = info.level;
    const equipped= S.equippedAbilities.includes(key);
    const canLevel= unlocked && S.gold >= def.levelCost(lvl);
    const card    = document.createElement('div');
    card.className = `be-ab-card${equipped?' equipped':''}${!unlocked?' locked':''}`;
    let btnHTML = '';
    if (!unlocked) {
      const canBuy = S.gems >= def.cost;
      btnHTML = `<button class="be-ab-btn unlock${canBuy?'':' no'}" data-key="${key}" data-action="unlock">💎 ${def.cost} Unlock</button>`;
    } else if (equipped) {
      btnHTML = `<button class="be-ab-btn unequip" data-key="${key}" data-action="unequip">Unequip</button>`;
    } else {
      const canEquip = S.equippedAbilities.length < maxSlots;
      btnHTML = `<button class="be-ab-btn equip${canEquip?'':' no'}" data-key="${key}" data-action="equip">Equip</button>`;
    }
    if (unlocked && !def.passive) {
      const lc = def.levelCost(lvl);
      btnHTML += `<button class="be-ab-btn levelup${canLevel?'':' no'}" data-key="${key}" data-action="levelup" style="margin-top:.3rem">⬆ ${lc.toLocaleString()} Gold (Lv${lvl+1})</button>`;
    }
    card.innerHTML = `
      <div class="be-ab-head">
        <span class="be-ab-icon">${def.icon}</span>
        <span class="be-ab-name">${def.name}</span>
        <span class="be-ab-proc">${unlocked ? def.procLabel(lvl) : `💎${def.cost}`}</span>
      </div>
      <div class="be-ab-desc">${def.desc}</div>
      ${btnHTML}`;
    grid.appendChild(card);
  }
  body.appendChild(grid);
  // Event listeners
  body.querySelectorAll('[data-action]').forEach(btn => {
    btn.addEventListener('click', () => handleAbilityAction(btn.dataset.key, btn.dataset.action));
  });
}

function handleAbilityAction(key, action) {
  const def  = ABILITIES[key];
  const info = S.abilities[key];
  if (action === 'unlock') {
    if (S.gems < def.cost) return;
    S.gems -= def.cost; S.abilities[key].unlocked = true;
    doSave(); renderUpgradeTab('abilities'); updateCurrencyDisplay();
  } else if (action === 'equip') {
    if (S.equippedAbilities.length >= S.abilitySlots) return;
    if (!S.equippedAbilities.includes(key)) S.equippedAbilities.push(key);
    doSave(); renderUpgradeTab('abilities');
  } else if (action === 'unequip') {
    unequipAbility(key); doSave(); renderUpgradeTab('abilities');
  } else if (action === 'levelup') {
    const lc = def.levelCost(info.level);
    if (S.gold < lc) return;
    S.gold -= lc; S.abilities[key].level++;
    doSave(); renderUpgradeTab('abilities'); updateCurrencyDisplay();
  }
}

function unequipAbility(key) {
  const idx = S.equippedAbilities.indexOf(key);
  if (idx >= 0) S.equippedAbilities.splice(idx, 1);
}

function renderChestsTab(body) {
  if (S.chestInventory.length === 0) {
    body.innerHTML = '<div class="be-chests-empty">No chests yet. Complete levels to earn chests!</div>';
    return;
  }
  const list = document.createElement('div');
  list.className = 'be-chests-list';
  // Group by rarity
  const counts = {};
  for (const r of S.chestInventory) counts[r] = (counts[r] || 0) + 1;
  for (const [rarity, count] of Object.entries(counts)) {
    const def  = CHEST_RARITIES[rarity] || CHEST_RARITIES.common;
    const item = document.createElement('div');
    item.className = 'be-chest-item';
    item.innerHTML = `
      <span class="be-ci-icon">${def.icon}</span>
      <span class="be-ci-name ci-${rarity}">${def.label} ×${count}</span>
      <button class="be-ci-btn" data-rarity="${rarity}">Open</button>`;
    list.appendChild(item);
  }
  body.appendChild(list);
  body.querySelectorAll('.be-ci-btn').forEach(btn => {
    btn.addEventListener('click', () => { openChestScreen(btn.dataset.rarity, false); });
  });
}

// ═══════════════════════════════════════════════════════
// §24  STATS SCREEN
// ═══════════════════════════════════════════════════════
function renderStats() {
  const st   = S.stats;
  const hh   = Math.floor(st.totalPlayTime / 3600);
  const mm   = Math.floor((st.totalPlayTime % 3600) / 60);
  const ss   = Math.floor(st.totalPlayTime % 60);
  $('statsCard').innerHTML = `
    <div class="be-stats-title">📊 STATISTICS</div>
    <div class="be-stat-row"><span>Highest Level</span><span class="be-stat-val">${S.highestLevel}</span></div>
    <div class="be-stat-row"><span>Levels Completed</span><span class="be-stat-val">${st.totalLevels}</span></div>
    <div class="be-stat-row"><span>Total Damage Dealt</span><span class="be-stat-val">${Math.floor(st.totalDamage).toLocaleString()}</span></div>
    <div class="be-stat-row"><span>Rings Broken</span><span class="be-stat-val">${st.totalRingsBroken.toLocaleString()}</span></div>
    <div class="be-stat-row"><span>Highest Combo</span><span class="be-stat-val">×${st.highestCombo}</span></div>
    <div class="be-stat-row"><span>Total Gold Earned</span><span class="be-stat-val">🪙 ${st.totalGold.toLocaleString()}</span></div>
    <div class="be-stat-row"><span>Total Gems Earned</span><span class="be-stat-val">💎 ${st.totalGems.toLocaleString()}</span></div>
    <div class="be-stat-row"><span>Total Play Time</span><span class="be-stat-val">${hh}h ${mm}m ${ss}s</span></div>
    <div class="be-stats-btns">
      <button class="btn be-btn-sec" id="btnStatsBack">← Back</button>
    </div>`;
  showScreen('screenStats');
  $('btnStatsBack').onclick = () => renderHub();
}

// ═══════════════════════════════════════════════════════
// §25  MILESTONES
// ═══════════════════════════════════════════════════════
function checkMilestones(lv) {
  const alreadySeen = S.milestones || [];
  for (const m of MILESTONES) {
    if (m.level !== lv) continue;
    if (alreadySeen.includes(m.level)) continue;
    alreadySeen.push(m.level);
    S.milestones = alreadySeen;
    if (m.gold)  { S.gold  += m.gold;  S.stats.totalGold += m.gold;  }
    if (m.gems)  { S.gems  += m.gems;  S.stats.totalGems += m.gems;  }
    if (m.title) S.title = m.title;
    if (m.abilitySlots) S.abilitySlots = m.abilitySlots;
    if (m.specialTrail) { S.specialTrail = true; S.trailLevelsLeft = 999; }
    milestoneQueue.push({ msg: m.msg, gold: m.gold, gems: m.gems, level: m.level });
    doSave();
  }
  // Every 25 levels after 100
  if (lv > 100 && lv % 25 === 0 && !alreadySeen.includes(lv)) {
    alreadySeen.push(lv);
    S.milestones = alreadySeen;
    S.gems += 20; S.stats.totalGems += 20;
    milestoneQueue.push({ msg: `+20 Gems milestone at Lv ${lv}!`, gems: 20, level: lv });
    doSave();
  }
}

function showMilestoneQueueThenDo(callback) {
  if (milestoneQueue.length === 0) { callback(); return; }
  const m    = milestoneQueue.shift();
  const card = $('milestoneCard');
  card.innerHTML = `
    <div class="be-mile-icon">🏆</div>
    <div class="be-mile-title">MILESTONE — LEVEL ${m.level}</div>
    <div class="be-mile-desc">${m.msg}${m.gold ? `<br>+${m.gold} 🪙` : ''}${m.gems ? `<br>+${m.gems} 💎` : ''}</div>
    <button class="btn btn-primary" id="btnMilestoneOk">OK</button>`;
  $('milestonePop').style.display = '';
  $('btnMilestoneOk').onclick = () => {
    $('milestonePop').style.display = 'none';
    showMilestoneQueueThenDo(callback);
  };
}

// ═══════════════════════════════════════════════════════
// §26  EVENT HANDLERS
// ═══════════════════════════════════════════════════════
function bindEvents() {
  $('btnBack').onclick    = () => location.href = '/';
  $('btnPlay').onclick    = () => renderIntro();
  $('btnInfinite').onclick = () => startInfiniteMode();
  $('btnUpgradesHub').onclick = () => { screenBeforeUpgrade = 'hub'; openUpgradeMenu(); };
  $('btnStatsHub').onclick    = () => renderStats();
  $('btnPause').onclick       = () => pauseGame();
  $('btnResume').onclick      = () => resumeGame();
  $('btnAbandon').onclick = () => {
    const msg = infiniteMode ? 'Quit Infinite Mode?' : 'Abandon level? You will receive partial gold.';
    if (confirm(msg)) abandonLevel();
  };
  $('btnViewUpgradesFromPause').onclick = () => { pauseGame(); screenBeforeUpgrade = 'paused'; openUpgradeMenu(); };
  $('btnLvlUpgDmg').onclick   = () => buyLvlUpg('dmg');
  $('btnLvlUpgCoins').onclick = () => buyLvlUpg('coins');

  // Upgrade tabs
  $('upgTabs').addEventListener('click', e => {
    const tab = e.target.closest('.be-upg-tab');
    if (!tab) return;
    renderUpgradeTab(tab.dataset.tab);
  });

  // Close upgrade menu
  $('btnCloseUpgrade').onclick = () => {
    if (_upgMenuFromLevelEnd || screenBeforeUpgrade === 'upgrade_then_next') {
      showMilestoneQueueThenDo(() => renderIntro());
    } else if (screenBeforeUpgrade === 'paused') {
      showGameCanvas(); $('pauseOverlay').style.display = ''; paused = true;
    } else if (screenBeforeUpgrade === 'intro') {
      renderIntro();
    } else {
      renderHub();
    }
  };

  window.addEventListener('resize', () => {
    resizeCanvas();
    if (ctx) ctx = canvas.getContext('2d');
    if (rings.length) rings = generateLevel(S.currentLevel); // re-compute ring radii
  });
}

// ═══════════════════════════════════════════════════════
// §27  INIT
// ═══════════════════════════════════════════════════════
function init() {
  canvas = $('beCanvas');
  resizeCanvas();
  ctx = canvas.getContext('2d');
  bindEvents();
  // Idle animation loop on hub
  function idleLoop(ts) {
    if (screen === 'hub' || screen === 'intro') {
      ctx.clearRect(0, 0, cSize, cSize);
      drawIdleBackground();
    }
    requestAnimationFrame(idleLoop);
  }
  requestAnimationFrame(idleLoop);
  renderHub();
  updateCurrencyDisplay();
}

init();
})();

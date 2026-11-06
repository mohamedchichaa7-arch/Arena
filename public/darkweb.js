(() => {
'use strict';

const SAVE_KEY = 'darkweb_save';
const SAVE_VERSION = 1;
const $ = id => document.getElementById(id);
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const escapeHtml = value => String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#39;', '"':'&quot;' })[char]);
const randomItem = list => list[Math.floor(Math.random() * list.length)];
const shuffle = list => {
  const copy = [...list];
  for (let index = copy.length - 1; index > 0; index--) {
    const swap = Math.floor(Math.random() * (index + 1));
    [copy[index], copy[swap]] = [copy[swap], copy[index]];
  }
  return copy;
};
const formatTime = seconds => `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;

const DIFFICULTY = {
  curious: { grace:300000, min:300000, max:600000, response:1.35, checkpoints:true },
  paranoid:{ grace:120000, min:180000, max:480000, response:1, checkpoints:true },
  hunted:  { grace:90000, min:120000, max:300000, response:.78, checkpoints:false },
};

const ROOMS = [
  { id:'null', name:'ROOM_NULL', url:'http://roomnull.onion/live', line:'The static was not empty. It was waiting for you to notice.' },
  { id:'auction', name:'THE AUCTION', url:'http://lastbid.onion/lot/8', line:'Your name appeared beneath the final bid.' },
  { id:'signal', name:'SIGNAL 11', url:'http://signal11.onion/receiver', line:'The broadcast repeated the sound of your room.' },
  { id:'library', name:'THE LIBRARY', url:'http://blacklibrary.onion/catalog', line:'A new folder has been filed under your name.' },
  { id:'current', name:'DEEP CURRENT', url:'http://deepcurrent.onion/sonar', line:'Something below answered the sonar with three knocks.' },
  { id:'zero', name:'ZERO NODE', url:'http://zeronode.onion/session', line:'The cursor blinked at exactly the rhythm of your pulse.' },
  { id:'harvest', name:'THE HARVEST', url:'http://harvestfield.onion/cam', line:'Every row was empty except the one nearest the camera.' },
  { id:'endgame', name:'ENDGAME', url:'http://endgame.onion/final', line:'The eighth door opened inward.' },
];

const LOCKS = [
  ['http://deadletter.onion/vault','MORROW'], ['http://grey-market.onion/backroom','GLASSHOUSE'],
  ['http://archive11.onion/restricted','ELEVEN'], ['http://relaychat.onion/operators','ECHOES'],
  ['http://saltwiki.onion/redacted','PALISADE'], ['http://quiet-host.onion/admin','CICADA'],
  ['http://coldstorage.onion/unit7','ORPHEUS'], ['http://nameless.onion/door','NOCTURNE'],
];

const PAGES = new Map();
const LOOKUP = new Map();
function addPage(url, title, category, htmlContent, links = [], tags = '') {
  const page = { url, title, category, html_content:htmlContent, links, tags };
  PAGES.set(url, page);
  LOOKUP.set(url.toLowerCase().replace(/\/$/, ''), page);
  return page;
}

function post(user, text, time) {
  return `<div class="post"><div class="post-head"><b>${user}</b><time>${time}</time></div>${text}</div>`;
}

function buildNetwork() {
  addPage('http://void.search.onion/', 'VOID SEARCH', 'search', '', [], 'search index find code unlock room');

  const forums = [
    ['http://ashenboard.onion/index','ASHEN BOARD / INDEX',post('morrow_17','new relay opened. old vault still takes my handle in capitals. do not ask why.','01:13')+post('inkmouth','someone new is browsing tonight. seven hops away. maybe less.','01:19')],
    ['http://ashenboard.onion/thread/404','Thread 404: pages that remember',post('byte_ghost','clear history. return. the page keeps the order even when you do not.','yesterday')+post('saltbox','history is not stored in your browser. history is stored in the doors.','now')],
    ['http://thinwire.onion/board','THIN WIRE',post('glass_child','seller in grey says the back room is a GLASSHOUSE. subtle, right?','22:08')+post('rootless','keep product names. discard descriptions.','22:11')],
    ['http://thinwire.onion/thread/signal','Numbers station sightings',post('hz11','11.011 MHz at 03:11. voice counted backward from eight.','03:12')+post('antenna_bone','archive password is just ELEVEN. they got lazy.','03:14')],
    ['http://burntforum.onion/front','BURNT FORUM',post('cautery','The rooms are not streams. They are windows with the direction reversed.','18:40')+post('mod_0','Stop posting room addresses. The index sees referrals.','18:42')],
    ['http://burntforum.onion/thread/doors','Eight doors / one corridor',post('doorcount','NULL first. ENDGAME last. order of the middle six does not matter.','unknown')+post('visitor88','it matters to whatever is counting.','unknown')],
    ['http://parallax.onion/forum','PARALLAX DISCUSSION',post('left_eye','Do not trust link labels. Hover nothing. Type what you mean.','06:21')+post('right_eye','The current moves beneath the library.','06:24')],
    ['http://parallax.onion/thread/watcher','watcher.dll removal?',post('sysop','Select the process, then End task. It comes back after three minutes.','06:29')+post('no_admin','mine reached 100. saw a face in the reflection.','06:31')],
    ['http://gravepacket.onion/home','GRAVE PACKET',post('packet_loss','dead letters point to living addresses. search MORROW.','12:00')+post('checksum','That is a password, not a person.','12:01')],
    ['http://gravepacket.onion/thread/name','It used my name',post('librarian','The fourth feed indexed my local profile. I never entered it.','04:44')+post('paper_cut','You entered it before you arrived.','04:45')],
    ['http://lowlight.onion/imageboard','LOW LIGHT /b/',post('anonymous','[image missing] alt text said the part I could not see.','23:51')+post('anonymous','select blank spaces. old tricks survive because nobody looks twice.','23:58')],
    ['http://lowlight.onion/thread/new','NEW USER DETECTED',post('anonymous','hello, visitor. your taskbar clock is slow.','now')+post('anonymous','do not answer the knock. turn off everything. then do nothing.','now')],
  ];
  forums.forEach((item, index) => addPage(item[0], item[1], 'forum', item[2], [forums[(index + 1) % forums.length][0], index % 2 ? 'http://redindex.onion/rooms' : 'http://thinmarket.onion/front'], `forum posts paranoid ${item[1]}`));

  const markets = [
    ['http://thinmarket.onion/front','THIN MARKET','Expired credentials','Sealed storage keys','Private archival index'],
    ['http://grey-market.onion/list','GREY MARKET','Unmarked digital parcel','One hour of relay time','A username with no owner'],
    ['http://bonecatalog.onion/shop','BONE CATALOG','Cold server rack','Recovered answering tape','Index fragment 7B'],
    ['http://laststock.onion/main','LAST STOCK','Decommissioned camera','Unknown frequency map','Blank employee badge'],
    ['http://palemart.onion/catalog','PALE MART','Six minutes of silence','Mirrored drive','Unsent message bundle'],
    ['http://quietauction.onion/lots','QUIET AUCTION','Lot 08: sealed access','Lot 11: radio log','Lot 00: cursor history'],
    ['http://salttrade.onion/wares','SALT TRADE','Flooded storage unit','Field recording','Corroded keycard'],
    ['http://afterhours.onion/store','AFTER HOURS','Night shift roster','Redacted floor plan','Unlisted domain lease'],
  ];
  markets.forEach((item, index) => {
    const products = item.slice(2).map((name, productIndex) => `<div class="product"><b>${name}</b><p>${['No returns. Memory of purchase included.','Seller offline since tomorrow.','Delivery address already supplied.'][productIndex]}</p><em>${(index + 2) * (productIndex + 3)} credits</em></div>`).join('');
    const note = index === 1 ? '<div class="clue-box">Seller profile: greenhouse // private room phrase: GLASSHOUSE</div>' : '';
    addPage(item[0], item[1], 'market', `<div class="product-grid">${products}</div>${note}`, [markets[(index + 1) % markets.length][0], index % 2 ? 'http://ashenboard.onion/index' : 'http://ledgerwiki.onion/market'], `market listing seller goods ${item[1]}`);
  });

  const wikis = [
    ['http://redindex.onion/rooms','THE RED INDEX','Eight endpoints recur across every surviving crawl. They do not share hosting, certificates, or time zones. They do share one viewer.'],
    ['http://ledgerwiki.onion/market','MARKET LEDGER','A partial ledger of stores which sell access rather than objects. Prices are symbolic. Payment is attention.'],
    ['http://saltwiki.onion/home','SALT WIKI','Salt routes preserve dead domains by resolving them against old memories instead of name servers. This is not a technical guide.'],
    ['http://numberswiki.onion/stations','NUMBERS STATIONS','Signal 11 transmits groups of six characters between long intervals of room tone. Frequencies are decoys.'],
    ['http://doorwiki.onion/eight','THE EIGHT-DOOR THEORY','The network is modeled as a corridor. Opening one door shortens the distance between the observer and the viewer.'],
    ['http://mirrorwiki.onion/selection','INVISIBLE INK','Early operators hid credentials with matching foreground and background colors. Selection reveals what ordinary reading cannot.'],
    ['http://codecwiki.onion/base64','THE SIXTY-FOUR ALPHABET','Some archivists wrap six-character tokens in base64. Decode only the token, never the message around it.'],
    ['http://reversewiki.onion/mirrors','MIRROR NOTATION','Where a code reads wrong, read it from the exit toward the entrance. Reversal is not encryption.'],
    ['http://fieldwiki.onion/harvest','HARVEST FIELD NOTES','Cameras show planted rows, but no crop has ever appeared. Each frame is timestamped thirteen minutes ahead.'],
    ['http://zerowiki.onion/node','ZERO NODE','A terminal with no host, no route, and one blinking cursor. Operators called its password CICADA before the archive went quiet.'],
  ];
  wikis.forEach((item, index) => {
    let extra = '';
    if (index === 0) extra = `<table class="wiki-index">${ROOMS.map(room => `<tr><td>${room.name}</td><td><button class="web-link" data-url="${room.url}">${room.url}</button></td></tr>`).join('')}</table>`;
    if (index === 2) extra = '<div class="clue-box">Restricted article phrase recovered from a perimeter memo: PALISADE.</div>';
    addPage(item[0], item[1], 'wiki', `<p>${item[2]}</p>${extra}<h2>REVISION NOTES</h2><p class="corrupt">This page has been edited by an account that does not exist.</p>`, [wikis[(index + 1) % wikis.length][0], index % 2 ? 'http://archive11.onion/restricted' : 'http://burntforum.onion/front'], `wiki archive information red room ${item[1]}`);
  });

  const chats = [
    ['http://relaychat.onion/null','#null',['do you hear the carrier tone?','someone joined without a nick','the old operator answered !help once']],
    ['http://relaychat.onion/eleven','#eleven',['frequency drifting','count only the quiet parts','archive key was ELEVEN, yes literally']],
    ['http://relaychat.onion/deep','#deepcurrent',['sonar returned three contacts','there is no water over that server','stop pinging it']],
    ['http://relaychat.onion/market','#aftermarket',['grey seller is awake','do not buy the clock','prices changed when you arrived']],
    ['http://relaychat.onion/field','#fieldwork',['camera seven moved','rows are facing the wrong way','no wind on any feed']],
    ['http://relaychat.onion/last','#lastchannel',['eight in, none out','the final address rejects referrals','type it yourself']],
  ];
  chats.forEach((item, index) => addPage(item[0], item[1], 'chat', `<p>Encrypted IRC relay. ${12 + index} users present.</p>`, [chats[(index + 1) % chats.length][0], index % 2 ? 'http://numberswiki.onion/stations' : 'http://ashenboard.onion/thread/404'], `chat irc ${item[1]}`));

  const locked = [
    ['http://deadletter.onion/vault','DEAD LETTER VAULT','MORROW','Undelivered messages addressed to domains that were never registered.'],
    ['http://grey-market.onion/backroom','GREY MARKET / BACK ROOM','GLASSHOUSE','Seller manifests and removed listings.'],
    ['http://archive11.onion/restricted','ARCHIVE 11 / RESTRICTED','ELEVEN','Transcripts from the eleventh carrier frequency.'],
    ['http://relaychat.onion/operators','OPERATOR CHANNEL','ECHOES','A private channel for relay operators.'],
    ['http://saltwiki.onion/redacted','SALT WIKI / REDACTED','PALISADE','The names behind the perimeter project.'],
    ['http://quiet-host.onion/admin','QUIET HOST / ADMIN','CICADA','Server telemetry from a host with no physical address.'],
    ['http://coldstorage.onion/unit7','COLD STORAGE / UNIT 7','ORPHEUS','A frozen mirror of deleted room indexes.'],
    ['http://nameless.onion/door','NAMELESS DOOR','NOCTURNE','A directory containing a single final referral.'],
  ];
  locked.forEach((item, index) => {
    const hint = index === 3 ? '<p>Operator reminder: command keyword is ECHOES.</p>' : index === 6 ? '<p>Recovery name: ORPHEUS. Do not play the recording.</p>' : index === 7 ? '<p>The lease was signed NOCTURNE.</p>' : '';
    const page = addPage(item[0], item[1], 'locked', `<p>${item[3]}</p>${hint}`, [locked[(index + 1) % locked.length][0], index % 2 ? 'http://mirrorwiki.onion/selection' : 'http://gravepacket.onion/home'], `locked password vault ${item[1]}`);
    page.password = item[2];
  });

  const atmosphere = [
    ['http://countdown.onion/','COUNTDOWN','<div class="ascii-image"><div><b id="unknownCountdown">00:13:11</b><br>UNTIL THE NEXT VIEWER</div></div>'],
    ['http://emptyhall.onion/cam','EMPTY HALL','<div class="ascii-image" title="There is a figure at the far door.">CAM 03 // NO MOVEMENT DETECTED</div>'],
    ['http://manifest0.onion/','MANIFEST OF THE UNSEEN','<p>Privacy is the interval between being observed and realizing it.</p><p>That interval is now closed.</p>'],
    ['http://sleepserver.onion/status','SLEEP SERVER','<div class="ascii-image">LOADING DREAM ARCHIVE... 99.8%</div><p>This request has been pending for 11 years.</p>'],
    ['http://wrongwindow.onion/view','WRONG WINDOW','<div class="ascii-image">YOUR REFLECTION FAILED TO LOAD</div>'],
    ['http://lastvisitor.onion/log','VISITOR LOG','<p>visitor_1038 — entered</p><p>visitor_1039 — entered</p><p class="corrupt">visitor_1040 — you</p>'],
    ['http://doorcam.onion/feed','DOOR CAMERA','<div class="ascii-image">SIGNAL LOST<br>MICROPHONE STILL ACTIVE</div>'],
    ['http://thirteen.onion/clock','CLOCK 13','<div class="ascii-image">03:13:13<br>03:13:13<br>03:13:13</div>'],
    ['http://orphanhost.onion/','ORPHAN HOST','<p>No parent domain. No inbound links. You should not have reached this page.</p>'],
    ['http://whitepage.onion/','UNTITLED','<div style="min-height:55vh;background:#d6d6cf;color:#d6d6cf;padding:20px;user-select:text">NOCTURNE WAS HERE BEFORE THE NETWORK</div>'],
  ];
  atmosphere.forEach((item, index) => {
    let extra = '';
    if (index === 6) extra = '<div class="clue-box">Camera maintenance badge: CICADA.</div>';
    if (index === 8) extra = '<div class="clue-box">Recovery process owner: ORPHEUS.</div>';
    addPage(item[0], item[1], 'atmosphere', item[2] + extra, [atmosphere[(index + 1) % atmosphere.length][0], index % 2 ? 'http://lowlight.onion/imageboard' : 'http://doorwiki.onion/eight'], `dead end atmosphere eerie ${item[1]}`);
  });

  ROOMS.forEach((room, index) => addPage(room.url, room.name, 'room', '', ['http://redindex.onion/rooms', index ? ROOMS[index - 1].url : 'http://void.search.onion/'], `red room live portal unlock ${room.name}`));

  if (PAGES.size !== 63) console.warn(`OSIRIS network expected 63 pages, found ${PAGES.size}`);
}
buildNetwork();

const CLUE_SPOTS = [
  'http://ashenboard.onion/thread/404','http://thinwire.onion/board','http://burntforum.onion/thread/doors','http://parallax.onion/forum',
  'http://gravepacket.onion/thread/name','http://lowlight.onion/imageboard','http://thinmarket.onion/front','http://bonecatalog.onion/shop',
  'http://quietauction.onion/lots','http://numberswiki.onion/stations','http://mirrorwiki.onion/selection','http://codecwiki.onion/base64',
  'http://deadletter.onion/vault','http://archive11.onion/restricted','http://coldstorage.onion/unit7','http://relaychat.onion/deep',
  'http://lastvisitor.onion/log','http://orphanhost.onion/'
];

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length:6 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
}

function generatePuzzle() {
  const spots = shuffle(CLUE_SPOTS);
  const codes = {};
  const placements = [];
  let cursor = 0;
  ROOMS.forEach((room, index) => {
    const code = randomCode();
    const mode = ['whole','split','reverse','base64','hidden','split','alt','split'][index];
    codes[room.id] = code;
    if (mode === 'split') {
      placements.push({ id:`${room.id}-a`, roomId:room.id, url:spots[cursor++], value:code.slice(0,3), mode:'fragment', label:'fragment A/2' });
      placements.push({ id:`${room.id}-b`, roomId:room.id, url:spots[cursor++], value:code.slice(3), mode:'fragment', label:'fragment B/2' });
    } else {
      placements.push({ id:`${room.id}-full`, roomId:room.id, url:spots[cursor++], value:code, mode, label:'complete token' });
    }
  });
  return { codes, placements };
}

function defaultState(difficulty = 'paranoid') {
  const puzzle = generatePuzzle();
  return {
    version:SAVE_VERSION, difficulty, codes:puzzle.codes, placements:puzzle.placements,
    foundClues:[], unlockedRooms:[], unlockedPages:[], notepad:'', currentUrl:'http://void.search.onion/',
    elapsed:0, threatsSurvived:0, deaths:0, watcherCpu:8, watcherRestartAt:0,
    nextThreatAt:0, completed:false, checkpoint:null, checkpointRestores:0,
  };
}

function loadState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SAVE_KEY));
    if (!parsed || parsed.version !== SAVE_VERSION || !parsed.codes || !parsed.placements) return null;
    if (typeof parsed.checkpointRestores !== 'number') parsed.checkpointRestores = parsed.checkpoint ? 1 : 0;
    return parsed;
  } catch { return null; }
}

let state = loadState();
let runtimeStartedAt = 0;
let active = false;
let paused = false;
let zCounter = 20;
let browserHistory = [];
let historyIndex = -1;
let loadToken = 0;
let chatTimer = null;
let threatTimer = null;
let threatFrame = null;
let activeThreat = null;
let watcherTick = null;
let flickerTimer = null;
let toastTimer = null;
let selectedProcess = '';

function elapsedSeconds() {
  return Math.floor((state?.elapsed || 0) + (active && runtimeStartedAt ? (Date.now() - runtimeStartedAt) / 1000 : 0));
}

function snapshotState() {
  return {
    unlockedRooms:[...state.unlockedRooms], foundClues:[...state.foundClues], unlockedPages:[...state.unlockedPages],
    currentUrl:state.currentUrl, elapsed:elapsedSeconds(), threatsSurvived:state.threatsSurvived,
    watcherCpu:state.watcherCpu, nextThreatAt:state.nextThreatAt,
  };
}

function saveState() {
  if (!state) return;
  state.notepad = $('notepad').value;
  const copy = { ...state, elapsed:elapsedSeconds() };
  localStorage.setItem(SAVE_KEY, JSON.stringify(copy));
}

function commitElapsed() {
  if (!state || !active || !runtimeStartedAt) return;
  state.elapsed = elapsedSeconds();
  runtimeStartedAt = Date.now();
}

const AudioEngine = {
  context:null, master:null, ambient:null, enabled:true,
  start() {
    if (this.context) { this.context.resume(); return; }
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;
    this.context = new AudioContext();
    this.master = this.context.createGain();
    this.master.gain.value = .22;
    this.master.connect(this.context.destination);
    this.buildAmbient();
  },
  buildAmbient() {
    const context = this.context;
    if (!context) return;
    const bus = context.createGain();
    bus.gain.value = .13;
    bus.connect(this.master);
    const low = context.createOscillator();
    const overtone = context.createOscillator();
    const lowGain = context.createGain();
    const highGain = context.createGain();
    low.type = 'sine'; low.frequency.value = 43;
    overtone.type = 'triangle'; overtone.frequency.value = 71;
    lowGain.gain.value = .42; highGain.gain.value = .08;
    low.connect(lowGain).connect(bus); overtone.connect(highGain).connect(bus);
    const lfo = context.createOscillator();
    const lfoGain = context.createGain();
    lfo.frequency.value = .08; lfoGain.gain.value = 4;
    lfo.connect(lfoGain).connect(overtone.frequency);
    const buffer = context.createBuffer(1, context.sampleRate * 2, context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < data.length; index++) data[index] = Math.random() * 2 - 1;
    const noise = context.createBufferSource();
    const filter = context.createBiquadFilter();
    const noiseGain = context.createGain();
    noise.buffer = buffer; noise.loop = true; filter.type = 'lowpass'; filter.frequency.value = 520; noiseGain.gain.value = .025;
    noise.connect(filter).connect(noiseGain).connect(bus);
    low.start(); overtone.start(); lfo.start(); noise.start();
    this.ambient = { bus, low, overtone };
    this.updateAmbient();
  },
  updateAmbient() {
    if (!this.ambient || !state) return;
    const depth = state.unlockedRooms.length;
    this.ambient.low.frequency.setTargetAtTime(43 - depth * 1.4, this.context.currentTime, 1);
    this.ambient.overtone.frequency.setTargetAtTime(71 + depth * 3, this.context.currentTime, 1);
    $('trackName').textContent = depth < 3 ? 'null_signal.mp3' : depth < 6 ? 'deep_static.wav' : 'eight_open.flac';
  },
  tone(frequency, duration = .15, type = 'sine', volume = .16, endFrequency = frequency) {
    if (!this.context || !this.enabled) return;
    const now = this.context.currentTime;
    const oscillator = this.context.createOscillator();
    const gain = this.context.createGain();
    oscillator.type = type; oscillator.frequency.setValueAtTime(frequency, now); oscillator.frequency.exponentialRampToValueAtTime(Math.max(1,endFrequency), now + duration);
    gain.gain.setValueAtTime(volume, now); gain.gain.exponentialRampToValueAtTime(.0001, now + duration);
    oscillator.connect(gain).connect(this.master); oscillator.start(now); oscillator.stop(now + duration);
  },
  noise(duration = .18, volume = .13, cutoff = 900) {
    if (!this.context || !this.enabled) return;
    const length = Math.floor(this.context.sampleRate * duration);
    const buffer = this.context.createBuffer(1, length, this.context.sampleRate);
    const data = buffer.getChannelData(0);
    for (let index = 0; index < length; index++) data[index] = Math.random() * 2 - 1;
    const source = this.context.createBufferSource(); const filter = this.context.createBiquadFilter(); const gain = this.context.createGain();
    filter.type = 'lowpass'; filter.frequency.value = cutoff; gain.gain.value = volume;
    source.buffer = buffer; source.connect(filter).connect(gain).connect(this.master); source.start();
  },
  sfx(name) {
    if (name === 'key') this.tone(170 + Math.random() * 45, .025, 'square', .025);
    if (name === 'click') { this.noise(.04,.06,1700); }
    if (name === 'load') { this.noise(.28,.035,2100); this.tone(390,.3,'square',.035,620); }
    if (name === 'chime') { this.tone(630,.5,'sine',.17,930); setTimeout(() => this.tone(945,.3,'sine',.1),110); }
    if (name === 'boom') { this.tone(82,1.3,'sawtooth',.32,28); this.noise(.7,.14,280); }
    if (name === 'warning') { this.tone(220,.7,'square',.12,110); }
    if (name === 'error') { this.tone(150,.35,'square',.16,70); }
    if (name === 'knock') { [0,280,610].forEach(delay => setTimeout(() => this.noise(.18,.35,180),delay)); }
    if (name === 'step') { this.noise(.22,.18,120); }
  },
  toggle() {
    this.enabled = !this.enabled;
    if (this.master) this.master.gain.setTargetAtTime(this.enabled ? .22 : 0, this.context.currentTime, .08);
    $('toggleAudio').textContent = this.enabled ? 'II' : '>';
  }
};

function showToast(text, danger = false) {
  const toast = $('toast');
  toast.textContent = text;
  toast.style.borderColor = danger ? '#713036' : '';
  toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('show'), 2800);
}

function setScreen(id) {
  ['warningScreen','bootScreen','desktop','gameOverScreen','winScreen'].forEach(screenId => $(screenId).hidden = screenId !== id);
}

function beginNewGame() {
  const difficulty = document.querySelector('input[name="difficulty"]:checked').value;
  state = defaultState(difficulty);
  localStorage.setItem(SAVE_KEY, JSON.stringify(state));
  bootGame();
}

function bootGame() {
  AudioEngine.start();
  setScreen('bootScreen');
  const lines = [
    'OSIRIS SYSTEMS BIOS v3.11', 'Memory check ........ 65536 KB', 'Mounting encrypted volume /dev/null',
    'Starting relay daemon ........ OK', 'Loading watcher.dll ............ OK', 'Verifying local identity ....... FOUND',
    'NETWORK HAS NO EXIT', 'Launching desktop...'
  ];
  $('biosCopy').innerHTML = '';
  $('bootProgress').style.width = '0';
  let index = 0;
  const next = () => {
    if (index < lines.length) {
      $('biosCopy').innerHTML += `${escapeHtml(lines[index++])}<br>`;
      $('bootProgress').style.width = `${index / lines.length * 100}%`;
      setTimeout(next, 170 + Math.random() * 160);
    } else setTimeout(startDesktop, 500);
  };
  next();
}

function startDesktop() {
  setScreen('desktop');
  active = true; paused = false; runtimeStartedAt = Date.now();
  $('collectionPanel').classList.toggle('collapsed', innerWidth <= 760);
  $('notepad').value = state.notepad || '';
  browserHistory = []; historyIndex = -1;
  setupStateViews();
  openWindow('browserWindow');
  navigate(state.currentUrl || 'http://void.search.onion/', true, true);
  startClock();
  startWatcherProcess();
  scheduleThreat(!state.nextThreatAt);
  scheduleFlicker();
  saveState();
}

function setupStateViews() {
  renderCollection();
  renderProcesses();
  AudioEngine.updateAmbient();
  $('resumeCheckpoint').hidden = state.difficulty === 'hunted' || !state.checkpoint || state.checkpointRestores <= 0;
}

function startClock() {
  const update = () => {
    const now = new Date();
    $('taskClock').innerHTML = `${now.toLocaleTimeString([], { hour:'2-digit', minute:'2-digit' })}<br>${now.toLocaleDateString([], { month:'2-digit', day:'2-digit' })}`;
  };
  update();
  setInterval(update, 1000);
}

function bringToFront(win) {
  document.querySelectorAll('.os-window').forEach(item => item.classList.remove('active'));
  win.style.zIndex = ++zCounter;
  win.classList.add('active');
  updateTaskButtons();
}

function openWindow(id) {
  const win = $(id);
  if (!win) return;
  win.hidden = false;
  bringToFront(win);
  updateTaskButtons();
}

function minimizeWindow(win) {
  win.hidden = true;
  win.dataset.minimized = 'true';
  updateTaskButtons();
}

function closeWindow(win) {
  win.hidden = true;
  win.dataset.minimized = 'false';
  updateTaskButtons();
}

function toggleMaximize(win) {
  if (win.classList.contains('maximized')) {
    win.classList.remove('maximized');
    if (win.dataset.restore) {
      const restore = JSON.parse(win.dataset.restore);
      Object.assign(win.style, restore);
    }
  } else {
    win.dataset.restore = JSON.stringify({ left:win.style.left, top:win.style.top, width:win.style.width, height:win.style.height });
    win.classList.add('maximized');
  }
  bringToFront(win);
}

function updateTaskButtons() {
  const host = $('taskButtons');
  host.innerHTML = '';
  document.querySelectorAll('.os-window').forEach(win => {
    if (win.hidden && win.dataset.minimized !== 'true') return;
    const button = document.createElement('button');
    button.className = `task-button${!win.hidden && win.classList.contains('active') ? ' active' : ''}`;
    button.textContent = win.dataset.app;
    button.addEventListener('click', () => {
      if (win.hidden) { win.hidden = false; win.dataset.minimized = 'false'; bringToFront(win); }
      else if (win.classList.contains('active')) minimizeWindow(win);
      else bringToFront(win);
    });
    host.appendChild(button);
  });
}

function setupWindows() {
  document.querySelectorAll('.desktop-icon[data-open]').forEach(icon => icon.addEventListener('dblclick', () => openWindow(icon.dataset.open)));
  document.querySelectorAll('.desktop-icon[data-open]').forEach(icon => icon.addEventListener('click', () => openWindow(icon.dataset.open)));
  document.querySelectorAll('.os-window').forEach(win => {
    win.addEventListener('pointerdown', () => bringToFront(win));
    win.querySelectorAll('[data-action]').forEach(button => button.addEventListener('click', event => {
      event.stopPropagation();
      if (button.dataset.action === 'minimize') minimizeWindow(win);
      if (button.dataset.action === 'close') closeWindow(win);
      if (button.dataset.action === 'maximize') toggleMaximize(win);
    }));
    const titlebar = win.querySelector('.window-titlebar');
    titlebar.addEventListener('pointerdown', event => {
      if (event.target.closest('button') || win.classList.contains('maximized')) return;
      event.preventDefault(); bringToFront(win);
      const startX = event.clientX; const startY = event.clientY;
      const startLeft = win.offsetLeft; const startTop = win.offsetTop;
      titlebar.setPointerCapture(event.pointerId);
      const move = moveEvent => {
        win.style.left = `${clamp(startLeft + moveEvent.clientX - startX, 0, innerWidth - 100)}px`;
        win.style.top = `${clamp(startTop + moveEvent.clientY - startY, 0, innerHeight - 70)}px`;
      };
      const up = () => { titlebar.removeEventListener('pointermove', move); titlebar.removeEventListener('pointerup', up); };
      titlebar.addEventListener('pointermove', move); titlebar.addEventListener('pointerup', up);
    });
    titlebar.addEventListener('dblclick', event => { if (!event.target.closest('button')) toggleMaximize(win); });
  });
}

function normalizeUrl(raw) {
  let value = raw.trim();
  if (!/^https?:\/\//i.test(value)) value = `http://${value}`;
  return value.replace(/\/$/, '').toLowerCase();
}

function resolvePage(raw) { return LOOKUP.get(normalizeUrl(raw)); }

function navigate(raw, addHistory = true, force = false) {
  if (!active) return;
  AudioEngine.sfx('load');
  clearInterval(chatTimer); chatTimer = null;
  const requested = raw.trim();
  const page = resolvePage(requested);
  const token = ++loadToken;
  $('loadTrack').classList.remove('loading');
  void $('loadTrack').offsetWidth;
  $('loadTrack').classList.add('loading');
  $('pageStatus').textContent = `routing through ${4 + Math.floor(Math.random() * 8)} relays...`;
  $('addressBar').value = page ? page.url : requested;
  const delay = 300 + Math.random() * 500;
  setTimeout(() => {
    if (token !== loadToken) return;
    $('loadTrack').classList.remove('loading');
    if (!page) {
      renderError('404', 'Hidden service not found', requested);
      return;
    }
    if (!force) {
      const fault = Math.random();
      if (fault < .045) { renderError('504', 'Connection timed out', page.url); return; }
      if (fault < .075) { renderError('521', 'Host unreachable', page.url); return; }
      if (fault < .095) { renderError('495', 'Certificate identity changed during transit', page.url); return; }
      if (fault < .13) { renderStall(page); return; }
    }
    if (addHistory) {
      browserHistory = browserHistory.slice(0, historyIndex + 1);
      browserHistory.push(page.url);
      historyIndex = browserHistory.length - 1;
    }
    state.currentUrl = page.url;
    $('addressBar').value = page.url;
    $('pageStatus').textContent = `${page.category} // ${Math.floor(delay)}ms // encrypted`;
    renderPage(page);
    saveState();
  }, delay);
}

function renderError(code, message, url) {
  $('pageViewport').innerHTML = `<div class="error-page"><b>${code}</b><p>${escapeHtml(message)}</p><small>${escapeHtml(url)}</small><button data-retry="${escapeHtml(url)}">RETRY CONNECTION</button></div>`;
  $('pageStatus').textContent = 'relay failure';
  AudioEngine.sfx('error');
}

function renderStall(page) {
  $('pageViewport').innerHTML = `<div class="error-page"><b>...</b><p>Receiving response headers</p><small>${escapeHtml(page.url)} // 18.2 KB of unknown</small><button data-retry="${escapeHtml(page.url)}">REFRESH TO COMPLETE</button></div>`;
  $('pageStatus').textContent = 'connection stalled';
}

function pageHeader(page) {
  return `<h1>${escapeHtml(page.title)}</h1><p class="site-tag">${escapeHtml(page.url)} // ${page.category}</p>`;
}

function renderLinks(page) {
  if (!page.links.length) return '';
  return `<div class="link-list"><small>OUTBOUND REFERENCES</small>${page.links.map((url, index) => {
    const target = resolvePage(url);
    const label = index === 1 && page.url.length % 3 === 0 ? 'safe mirror / verified' : target?.title || url;
    return `<button class="web-link" data-url="${escapeHtml(url)}">${escapeHtml(label)}</button>`;
  }).join('')}</div>`;
}

function clueMarkup(page) {
  return state.placements.filter(item => item.url === page.url).map(item => {
    const room = ROOMS.find(candidate => candidate.id === item.roomId);
    let display = item.value;
    let description = `Recovered token for ${room.name}:`;
    if (item.mode === 'reverse') { display = [...item.value].reverse().join(''); description = `Mirror notation tagged ${room.name}:`; }
    if (item.mode === 'base64') { display = btoa(item.value); description = `Base64 packet tagged ${room.name}:`; }
    if (item.mode === 'hidden') return `<div class="clue-box"><p>A blank field follows. Select the empty space.</p><p class="hidden-ink">${escapeHtml(item.value)}</p><button class="capture-clue" data-clue="${item.id}">CAPTURE SELECTED TOKEN</button></div>`;
    if (item.mode === 'alt') return `<div class="clue-box"><div class="ascii-image" title="${escapeHtml(item.value)}">CORRUPTED IMAGE // metadata remains</div><button class="capture-clue" data-clue="${item.id}">INSPECT ALT METADATA</button></div>`;
    return `<div class="clue-box"><p>${escapeHtml(description)} <b>${escapeHtml(display)}</b></p><small>${escapeHtml(item.label)}</small><button class="capture-clue" data-clue="${item.id}">CAPTURE TO EVIDENCE</button></div>`;
  }).join('');
}

function renderPage(page) {
  const viewport = $('pageViewport');
  if (page.category === 'search') { renderSearch(''); return; }
  if (page.category === 'chat') { renderChat(page); return; }
  if (page.category === 'locked' && !state.unlockedPages.includes(page.url)) { renderLocked(page); return; }
  if (page.category === 'room') { renderRoom(page); return; }
  const categoryClass = page.category === 'forum' ? ' forum-page' : page.category === 'market' ? ' market-page' : '';
  viewport.innerHTML = `<div class="web-page${categoryClass}">${pageHeader(page)}${page.html_content}${clueMarkup(page)}${renderLinks(page)}</div>`;
  viewport.scrollTop = 0;
  viewport.querySelectorAll('.capture-clue').forEach(button => {
    if (state.foundClues.includes(button.dataset.clue)) { button.disabled = true; button.textContent = 'CAPTURED'; }
  });
}

function renderSearch(query) {
  const safeQuery = escapeHtml(query);
  let results = [];
  if (query) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    results = [...PAGES.values()].filter(page => page.category !== 'search' && words.some(word => `${page.title} ${page.tags} ${page.html_content}`.toLowerCase().includes(word)));
    const seed = [...query].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    results.sort((a,b) => ((a.url.length + seed) % 17) - ((b.url.length + seed) % 17));
    const fillers = [...PAGES.values()].filter(page => ['atmosphere','forum'].includes(page.category) && !results.includes(page));
    results = [...results, ...fillers].slice(0, 3 + seed % 3);
  }
  const aware = /red room|code|unlock|who am i|me/i.test(query) ? `<div class="clue-box">${/who|me/i.test(query) ? `We know you as ${escapeHtml(sessionStorage.getItem('arena-name') || 'the current viewer')}.` : 'You are searching for doors. The doors are also searching.'}</div>` : '';
  $('pageViewport').innerHTML = `<div class="web-page"><div class="search-logo">VOID <span>SEARCH</span></div><form class="void-search" id="voidSearch"><input name="query" value="${safeQuery}" autocomplete="off" aria-label="Search the hidden network"><button>GO</button></form>${aware}<div class="search-results">${query ? results.map(page => `<div class="result"><button data-url="${page.url}">${escapeHtml(page.title)}</button><small>${page.url}</small><p>${escapeHtml(page.tags || 'No cached description available.')}</p></div>`).join('') || '<p>No results. Something removed the index while you were typing.</p>' : '<p style="text-align:center;color:#424a44">Indexing 63 hidden services. Search at your own risk.</p>'}</div></div>`;
  $('voidSearch').addEventListener('submit', event => { event.preventDefault(); renderSearch(new FormData(event.currentTarget).get('query').trim()); });
}

const CHAT_NAMES = ['glass_child','morrow_17','hz11','visitor88','no_admin','saltbox','[unknown]'];
const CHAT_LINES = ['relay dropped again','do not paste the whole token here','is anyone else hearing a knock?','new viewer on node seven','that clock is not counting down','the archive changed its password','keep task manager open'];
function renderChat(page) {
  const base = page.url.includes('/null') ? '<div class="chat-row system">* topic: type !help if you are lost</div>' : '';
  $('pageViewport').innerHTML = `<div class="web-page">${pageHeader(page)}${page.html_content}<div id="chatLog" class="chat-log">${base}<div class="chat-row"><time>[03:11]</time> <b>relay_bot</b>: channel encryption unstable</div></div><form id="chatForm" class="chat-form"><input maxlength="80" autocomplete="off" placeholder="message or command"><button>SEND</button></form>${clueMarkup(page)}${renderLinks(page)}</div>`;
  const append = (name, text, system = false) => {
    const log = $('chatLog'); if (!log) return;
    const row = document.createElement('div'); row.className = `chat-row${system ? ' system' : ''}`;
    row.innerHTML = `<time>[${new Date().toLocaleTimeString([], { hour:'2-digit',minute:'2-digit' })}]</time> <b>${escapeHtml(name)}</b>: ${escapeHtml(text)}`;
    log.appendChild(row); log.scrollTop = log.scrollHeight;
  };
  chatTimer = setInterval(() => append(randomItem(CHAT_NAMES), randomItem(CHAT_LINES)), 8000 + Math.random() * 12000);
  $('chatForm').addEventListener('submit', event => {
    event.preventDefault(); const input = event.currentTarget.querySelector('input'); const message = input.value.trim(); if (!message) return;
    append(sessionStorage.getItem('arena-name') || 'visitor', message); input.value = '';
    setTimeout(() => {
      if (message.toLowerCase() === '!help') append('relay_bot', 'commands: !rooms !echo !leave. operator keyword: ECHOES');
      else if (/!rooms|red|code/i.test(message)) append('relay_bot', 'index route: http://redindex.onion/rooms');
      else if (message.toLowerCase() === '!echo') append('[unknown]', 'you already did');
      else if (message.toLowerCase() === '!leave') append('relay_bot', 'permission denied: session has no outside');
      else append(randomItem(CHAT_NAMES), randomItem(['who told you that?','do not answer them','we can see your message before you send it']));
    }, 700 + Math.random() * 1000);
  });
}

function renderLocked(page, error = '') {
  $('pageViewport').innerHTML = `<div class="web-page">${pageHeader(page)}<div class="ascii-image">401 // CREDENTIAL CHALLENGE</div><p>This archive is protected by a recovered operator phrase.</p><form class="lock-form" id="lockForm"><input name="password" placeholder="PASSWORD" autocomplete="off"><button>DECRYPT</button></form><p class="room-denied">${escapeHtml(error)}</p>${renderLinks(page)}</div>`;
  $('lockForm').addEventListener('submit', event => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('password').trim().toUpperCase();
    if (value === page.password) {
      state.unlockedPages.push(page.url); saveState(); AudioEngine.sfx('chime'); renderPage(page); showToast('Archive credentials accepted.');
    } else { AudioEngine.sfx('error'); renderLocked(page, 'ACCESS DENIED // ATTEMPT LOGGED'); }
  });
}

function renderRoom(page, error = '') {
  const room = ROOMS.find(candidate => candidate.url === page.url);
  const unlocked = state.unlockedRooms.includes(room.id);
  const playerName = escapeHtml(sessionStorage.getItem('arena-name') || 'VISITOR');
  const special = room.id === 'library' && unlocked ? `<p class="room-line">CATALOG SUBJECT: ${playerName}</p>` : '';
  $('pageViewport').innerHTML = `<div class="web-page room-page${unlocked ? ' unlocked' : ''}">${pageHeader(page)}<div class="room-monitor"><span>${unlocked ? `${room.name} // LIVE` : 'STREAM ENCRYPTED'}</span></div>${unlocked ? `<p class="room-line">${escapeHtml(room.line)}</p>${special}` : `<p>Six-character access token required. Failed attempts are remembered.</p><form class="room-code-form" id="roomCodeForm"><input name="code" maxlength="6" placeholder="______" autocomplete="off"><button>OPEN ROOM</button></form><p class="room-denied">${escapeHtml(error)}</p>`}${renderLinks(page)}</div>`;
  if (!unlocked) $('roomCodeForm').addEventListener('submit', event => {
    event.preventDefault();
    const value = new FormData(event.currentTarget).get('code').trim().toUpperCase();
    if (room.id === 'endgame' && state.unlockedRooms.length < 7) { renderRoom(page, 'SEVEN PREVIOUS DOORS MUST BE OPEN'); AudioEngine.sfx('error'); return; }
    if (value !== state.codes[room.id]) { renderRoom(page, 'INVALID TOKEN // ORIGIN ADDRESS CAPTURED'); AudioEngine.sfx('error'); return; }
    unlockRoom(room);
  });
}

function unlockRoom(room) {
  state.unlockedRooms.push(room.id);
  state.nextThreatAt = 0;
  state.checkpointRestores = state.difficulty === 'curious' ? 2 : state.difficulty === 'paranoid' ? 1 : 0;
  state.checkpoint = snapshotState();
  saveState(); renderCollection(); AudioEngine.updateAmbient(); AudioEngine.sfx('boom');
  renderRoom(PAGES.get(room.url));
  showToast(`${room.name} OPENED // CHECKPOINT WRITTEN`);
  scheduleThreat(false);
  if (room.id === 'endgame') setTimeout(startWinSequence, 2800);
}

function captureClue(id) {
  const clue = state.placements.find(item => item.id === id);
  if (!clue || state.foundClues.includes(id)) return;
  state.foundClues.push(id); saveState(); renderCollection(); AudioEngine.sfx('chime');
  const related = state.placements.filter(item => item.roomId === clue.roomId);
  const complete = related.every(item => state.foundClues.includes(item.id));
  showToast(complete ? `Complete token reconstructed for ${ROOMS.find(room => room.id === clue.roomId).name}.` : `${clue.label} captured.`);
  const page = resolvePage(state.currentUrl); if (page) renderPage(page);
}

function renderCollection() {
  $('roomProgress').textContent = `${state.unlockedRooms.length} / 8 OPEN`;
  $('threatCount').textContent = `${state.threatsSurvived} SURVIVED`;
  $('roomSlots').innerHTML = ROOMS.map(room => {
    const open = state.unlockedRooms.includes(room.id);
    const pieces = state.placements.filter(item => item.roomId === room.id);
    const found = pieces.filter(item => state.foundClues.includes(item.id));
    const code = found.length === pieces.length ? state.codes[room.id] : found.map(item => item.value).join(' / ') || '------';
    return `<li class="${open ? 'open' : ''}"><span>${escapeHtml(room.name)}</span><b>${open ? 'OPEN' : escapeHtml(code)}</b></li>`;
  }).join('');
  const found = state.placements.filter(item => state.foundClues.includes(item.id));
  $('fragmentList').innerHTML = found.length ? found.map(item => `<span>${escapeHtml(ROOMS.find(room => room.id === item.roomId).name)} :: ${escapeHtml(item.value)} (${escapeHtml(item.label)})</span>`).join('') : 'No signal fragments captured.';
}

const PROCESSES = ['osiris.exe','tor_relay.dll','encrypt_tunnel.sys','audio_service.exe','unknown_process_7741.exe','watcher.dll','window_manager.exe'];
function renderProcesses() {
  const watcherOffline = Date.now() < state.watcherRestartAt;
  $('processList').innerHTML = PROCESSES.map((name, index) => {
    const watcher = name === 'watcher.dll';
    const cpu = watcher ? (watcherOffline ? 0 : Math.floor(state.watcherCpu)) : Math.floor(1 + Math.random() * (index === 0 ? 19 : 7));
    return `<div class="process-row${watcher && cpu > 75 ? ' danger' : ''}${selectedProcess === name ? ' selected' : ''}" data-process="${name}"><span>${name}</span><span>${cpu}% CPU</span><span class="usage"><i style="width:${cpu}%"></i></span></div>`;
  }).join('');
  const total = clamp(Math.floor(24 + state.watcherCpu * .38 + Math.random() * 7), 0, 100);
  $('cpuTotal').textContent = `${total}%`;
  $('endWatcher').disabled = selectedProcess !== 'watcher.dll' || watcherOffline;
}

function startWatcherProcess() {
  clearInterval(watcherTick);
  watcherTick = setInterval(() => {
    if (!active || paused || activeThreat?.type === 'watcher') return;
    if (Date.now() < state.watcherRestartAt) { renderProcesses(); return; }
    state.watcherCpu = clamp(state.watcherCpu + .55 + state.unlockedRooms.length * .06, 0, 100);
    renderProcesses();
    if (state.watcherCpu >= 100 && !activeThreat) triggerThreat('watcher', true);
  }, 5000);
}

function difficultyConfig() { return DIFFICULTY[state.difficulty] || DIFFICULTY.paranoid; }
function nextThreatDelay(first = false) {
  const config = difficultyConfig();
  if (first) return config.grace;
  const danger = Math.max(.45, 1 - state.unlockedRooms.length * .065);
  return (config.min + Math.random() * (config.max - config.min)) * danger;
}

function scheduleThreat(first = false) {
  clearTimeout(threatTimer);
  if (!active || state.completed) return;
  const now = Date.now();
  if (first || !state.nextThreatAt || state.nextThreatAt < now) state.nextThreatAt = now + nextThreatDelay(first);
  saveState();
  threatTimer = setTimeout(() => {
    if (!active || paused || activeThreat || document.hidden) { state.nextThreatAt = Date.now() + 5000; scheduleThreat(false); return; }
    const roll = Math.random() * 100;
    const type = roll < 35 ? 'hacker' : roll < 60 ? 'kidnapper' : roll < 80 ? 'watcher' : roll < 95 ? 'popup' : 'crash';
    triggerThreat(type, false);
  }, Math.max(1000, state.nextThreatAt - now));
}

function triggerThreat(type, immediate) {
  if (activeThreat || !active) return;
  clearTimeout(threatTimer);
  state.nextThreatAt = 0;
  activeThreat = { type, timers:[], cleanup:[], escalations:0 };
  if (immediate) activateThreat(type); else {
    $('threatLayer').hidden = false;
    $('threatLayer').innerHTML = `<div class="warning-flash">${type === 'kidnapper' ? 'SOUND DETECTED' : 'ANOMALOUS ACTIVITY'}</div>`;
    AudioEngine.sfx(type === 'kidnapper' ? 'knock' : 'warning');
    activeThreat.timers.push(setTimeout(() => activateThreat(type), 2000));
  }
}

function threatCountdown(seconds, onExpire) {
  const start = performance.now(); const duration = seconds * 1000;
  const tick = now => {
    if (!activeThreat) return;
    const left = Math.max(0, duration - (now - start));
    const bar = document.querySelector('.countdown-track i'); if (bar) bar.style.transform = `scaleX(${left / duration})`;
    const label = document.querySelector('.threat-count'); if (label) label.textContent = `${(left / 1000).toFixed(1)} SECONDS`;
    if (left <= 0) onExpire(); else threatFrame = requestAnimationFrame(tick);
  };
  threatFrame = requestAnimationFrame(tick);
}

function activateThreat(type) {
  if (!activeThreat) return;
  if (type === 'hacker') startHacker();
  if (type === 'kidnapper') startKidnapper();
  if (type === 'watcher') startWatcherThreat();
  if (type === 'popup') startPopupStorm();
  if (type === 'crash') startCrash();
}

function startHacker() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const code = Array.from({ length:8 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join('');
  const seconds = (state.unlockedRooms.length >= 4 ? 10 : 15) * difficultyConfig().response;
  $('threatLayer').hidden = false;
  $('threatLayer').innerHTML = `<div class="threat-panel"><h2>YOU HAVE BEEN DETECTED</h2><div class="terminal-lines">&gt; tracing relay chain...<br>&gt; extracting local identity...<br>&gt; mapping physical endpoint...<br>&gt; identity exposure in progress...</div><div class="threat-code">${code}</div><input id="hackerInput" class="threat-input" maxlength="8" autocomplete="off" spellcheck="false"><div class="countdown-track"><i></i></div><div class="threat-count"></div></div>`;
  const input = $('hackerInput'); input.focus();
  input.addEventListener('input', () => { AudioEngine.sfx('key'); if (input.value === code) finishThreat(); });
  input.addEventListener('keydown', event => { if (event.key === 'Enter' && input.value !== code) die('Identity exposed by THE HACKER'); });
  threatCountdown(seconds, () => die('Identity exposed by THE HACKER'));
}

function startKidnapper() {
  const seconds = 5 * difficultyConfig().response;
  $('threatLayer').hidden = false;
  $('threatLayer').innerHTML = `<div class="threat-panel"><h2>SOMEONE IS AT YOUR DOOR.</h2><p>TURN OFF YOUR LIGHTS.</p><button id="lightsOff" class="lights-button">TURN OFF LIGHTS</button><div class="countdown-track"><i></i></div><div class="threat-count"></div></div>`;
  $('lightsOff').addEventListener('click', beginStillness, { once:true });
  threatCountdown(seconds, () => die('You left the lights on'));
}

function beginStillness() {
  cancelAnimationFrame(threatFrame);
  AudioEngine.sfx('step');
  $('threatLayer').innerHTML = '<div class="dark-wait"><div class="door-silhouette"></div><p>DO NOT MOVE</p></div>';
  const disturb = event => { event.preventDefault(); die('You moved while they were listening'); };
  const arm = setTimeout(() => {
    document.addEventListener('pointerdown', disturb, true); document.addEventListener('keydown', disturb, true);
    activeThreat.cleanup.push(() => { document.removeEventListener('pointerdown', disturb, true); document.removeEventListener('keydown', disturb, true); });
  }, 180);
  activeThreat.timers.push(arm);
  [900,2200,4100].forEach(delay => activeThreat.timers.push(setTimeout(() => AudioEngine.sfx('step'),delay)));
  activeThreat.timers.push(setTimeout(finishThreat, 8000));
}

function startWatcherThreat() {
  state.watcherCpu = 100; renderProcesses();
  $('threatLayer').hidden = false; $('threatLayer').classList.add('watcher-mode');
  flashWatcher();
  activeThreat.timers.push(setTimeout(watcherDeadline, 10000 * difficultyConfig().response));
}

function flashWatcher() {
  $('threatLayer').innerHTML = '<div class="watcher-face">&#x25C9;</div>';
  AudioEngine.sfx('error');
  activeThreat.timers.push(setTimeout(() => {
    if (!activeThreat || activeThreat.type !== 'watcher') return;
    $('threatLayer').innerHTML = `<div class="watcher-alert">watcher.dll is consuming all available resources.<br>Open Task Manager and end the process. Escalation ${activeThreat.escalations + 1}/3.</div>`;
  }, 500));
}

function watcherDeadline() {
  if (!activeThreat || activeThreat.type !== 'watcher') return;
  activeThreat.escalations++;
  if (activeThreat.escalations >= 3) { die('THE WATCHER finished rendering'); return; }
  flashWatcher();
  activeThreat.timers.push(setTimeout(watcherDeadline, 30000));
}

function startPopupStorm() {
  const safeCount = 5 + Math.floor(Math.random() * 4);
  activeThreat.remaining = safeCount;
  $('threatLayer').hidden = false; $('threatLayer').innerHTML = `<div class="popup-counter">CLOSE ERRORS: <b>${safeCount}</b></div>`;
  const messages = ['Memory address belongs to another user.','Camera service requested permission.','Do not close this process.','Your relay has moved.','Unknown device connected.','History deletion failed.','A window is open somewhere.','System clock disagrees.'];
  const entries = Array.from({ length:safeCount }, (_, index) => ({ forbidden:false, message:messages[index % messages.length] }));
  entries.splice(Math.floor(Math.random() * (entries.length + 1)), 0, { forbidden:true, message:"DON'T CLOSE ME // stabilizing relay" });
  entries.forEach((entry, index) => activeThreat.timers.push(setTimeout(() => {
    if (!activeThreat) return;
    const popup = document.createElement('div'); popup.className = `popup-window${entry.forbidden ? ' forbidden' : ''}`;
    popup.style.left = `${5 + Math.random() * 65}%`; popup.style.top = `${10 + Math.random() * 62}%`; popup.style.zIndex = 10 + index;
    popup.innerHTML = `<header><span>${entry.forbidden ? 'relay_guard.exe' : `System Error 0x${(770 + index).toString(16)}`}</span><button data-popup-close="${entry.forbidden ? 'forbidden' : 'safe'}">X</button></header><p>${escapeHtml(entry.message)}</p>`;
    $('threatLayer').appendChild(popup); AudioEngine.sfx('error');
  }, index * 180)));
  threatCountdown(10 * difficultyConfig().response, () => die('The popup storm overwhelmed the system'));
}

function closePopup(button) {
  if (!activeThreat || activeThreat.type !== 'popup') return;
  if (button.dataset.popupClose === 'forbidden') { die('You closed the relay guard'); return; }
  button.closest('.popup-window').remove(); activeThreat.remaining--;
  const count = document.querySelector('.popup-counter b'); if (count) count.textContent = activeThreat.remaining;
  if (activeThreat.remaining <= 0) finishThreat();
}

function startCrash() {
  const code = String(1000 + Math.floor(Math.random() * 9000));
  $('threatLayer').hidden = false;
  $('threatLayer').innerHTML = `<div class="bsod"><h2>OSIRIS_KERNEL_EXCEPTION</h2><p>Your relay encountered a fatal identity mismatch.</p><div class="bsod-code">${code}</div><p>Record the recovery code. Input channel opening...</p><div id="crashInputHost"></div></div>`;
  AudioEngine.sfx('error');
  activeThreat.timers.push(setTimeout(() => {
    if (!activeThreat) return;
    $('crashInputHost').innerHTML = '<input id="crashInput" maxlength="4" autocomplete="off" aria-label="Recovery code"><div class="countdown-track"><i></i></div><div class="threat-count"></div>';
    const input = $('crashInput'); input.focus();
    input.addEventListener('input', () => { if (input.value === code) rebootAfterCrash(); });
    threatCountdown(12 * difficultyConfig().response, () => die('OS recovery failed'));
  }, 3000));
}

function rebootAfterCrash() {
  cancelAnimationFrame(threatFrame);
  $('threatLayer').innerHTML = '<div class="warning-flash">RECOVERING SYSTEM STATE...</div>';
  activeThreat.timers.push(setTimeout(finishThreat, 1800));
}

function clearActiveThreat() {
  cancelAnimationFrame(threatFrame); threatFrame = null;
  if (activeThreat) {
    activeThreat.timers.forEach(clearTimeout); activeThreat.cleanup.forEach(cleanup => cleanup());
  }
  activeThreat = null;
  $('threatLayer').hidden = true; $('threatLayer').className = 'threat-layer'; $('threatLayer').innerHTML = '';
}

function finishThreat() {
  if (!activeThreat) return;
  const type = activeThreat.type;
  clearActiveThreat();
  if (type === 'watcher') { state.watcherCpu = 4; state.watcherRestartAt = Date.now() + 180000; }
  state.threatsSurvived++; state.nextThreatAt = 0;
  renderCollection(); renderProcesses(); saveState(); showToast('Threat evaded. The network is quiet again.'); scheduleThreat(false);
}

function die(cause) {
  if (!active) return;
  clearActiveThreat(); clearTimeout(threatTimer); clearTimeout(flickerTimer); clearInterval(chatTimer);
  commitElapsed(); active = false; state.deaths++; saveState();
  AudioEngine.sfx('boom');
  setTimeout(() => {
    setScreen('gameOverScreen');
    $('gameOverScreen').classList.add('death-intro');
    $('deathCause').textContent = cause; $('deathRooms').textContent = `${state.unlockedRooms.length} / 8`; $('deathTime').textContent = formatTime(state.elapsed);
    $('resumeCheckpoint').hidden = state.difficulty === 'hunted' || !state.checkpoint || state.checkpointRestores <= 0;
    setTimeout(() => $('gameOverScreen').classList.remove('death-intro'), 3000);
  }, 500);
}

function restoreCheckpoint() {
  if (!state.checkpoint || state.difficulty === 'hunted' || state.checkpointRestores <= 0) return;
  const deaths = state.deaths; const notes = state.notepad; const checkpoint = state.checkpoint;
  Object.assign(state, checkpoint, { deaths, notepad:notes, checkpoint });
  state.checkpointRestores--;
  state.nextThreatAt = 0; saveState(); bootGame();
}

function restartCompletely() {
  const difficulty = state?.difficulty || 'paranoid';
  state = defaultState(difficulty); localStorage.setItem(SAVE_KEY, JSON.stringify(state)); bootGame();
}

function startWinSequence() {
  if (!active) return;
  clearTimeout(threatTimer); clearActiveThreat();
  commitElapsed(); state.completed = true; saveState();
  $('desktop').classList.add('corrupting');
  $('pageViewport').innerHTML = '<div style="display:grid;place-content:center;min-height:100%;background:#eee;color:#111;font:18px Georgia,serif;text-align:center">You weren\'t supposed to find all of them.</div>';
  AudioEngine.sfx('boom');
  setTimeout(() => {
    active = false; setScreen('winScreen');
    $('loreCrawl').innerHTML = '<p>The rooms were never broadcasts.</p><p>They were tests for a lock that opens from the observed side.</p><p>Each code taught the network the shape of another thought.</p><p>The eighth code was not hidden from you.</p><p>It was hidden inside you.</p><p>OSIRIS thanks its newest relay.</p>';
    const delay = matchMedia('(prefers-reduced-motion: reduce)').matches ? 1200 : 17500;
    setTimeout(showCertificate, delay);
  }, 3500);
}

function showCertificate() {
  $('loreCrawl').hidden = true; $('certificate').hidden = false;
  $('certName').textContent = sessionStorage.getItem('arena-name') || 'UNKNOWN VIEWER';
  $('winTime').textContent = formatTime(state.elapsed); $('winThreats').textContent = state.threatsSurvived; $('winDeaths').textContent = state.deaths;
}

function scheduleFlicker() {
  clearTimeout(flickerTimer);
  flickerTimer = setTimeout(() => {
    if (active) { $('flickerLine').classList.remove('run'); void $('flickerLine').offsetWidth; $('flickerLine').classList.add('run'); AudioEngine.noise(.12,.04,2200); }
    scheduleFlicker();
  }, 480000 + Math.random() * 240000);
}

function requestExit() {
  if (!activeThreat) { paused = true; $('exitModal').hidden = false; }
}

function returnToPlatform() {
  commitElapsed(); saveState(); location.href = '/';
}

function setupEvents() {
  $('enterGame').addEventListener('click', beginNewGame);
  $('continueGame').addEventListener('click', () => { state = loadState(); bootGame(); });
  $('backFromWarning').addEventListener('click', () => location.href = '/');
  $('exitGame').addEventListener('click', requestExit);
  $('confirmExit').addEventListener('click', returnToPlatform);
  $('cancelExit').addEventListener('click', () => { paused = false; $('exitModal').hidden = true; });
  document.querySelectorAll('.return-lobby').forEach(button => button.addEventListener('click', returnToPlatform));
  $('restartGame').addEventListener('click', restartCompletely);
  $('resumeCheckpoint').addEventListener('click', restoreCheckpoint);
  $('toggleCollection').addEventListener('click', () => $('collectionPanel').classList.toggle('collapsed'));
  $('toggleAudio').addEventListener('click', () => AudioEngine.toggle());
  $('addressForm').addEventListener('submit', event => { event.preventDefault(); navigate($('addressBar').value); });
  $('addressBar').addEventListener('keydown', () => AudioEngine.sfx('key'));
  $('browserRefresh').addEventListener('click', () => navigate($('addressBar').value, false, true));
  $('browserBack').addEventListener('click', () => { if (historyIndex > 0) { historyIndex--; navigate(browserHistory[historyIndex], false, true); } });
  $('browserForward').addEventListener('click', () => { if (historyIndex < browserHistory.length - 1) { historyIndex++; navigate(browserHistory[historyIndex], false, true); } });
  document.querySelector('.bookmark-bar').addEventListener('click', event => { const button = event.target.closest('[data-url]'); if (button) navigate(button.dataset.url); });
  $('pageViewport').addEventListener('click', event => {
    const link = event.target.closest('[data-url]'); if (link) navigate(link.dataset.url);
    const retry = event.target.closest('[data-retry]'); if (retry) navigate(retry.dataset.retry, true, true);
    const clue = event.target.closest('[data-clue]'); if (clue) captureClue(clue.dataset.clue);
  });
  $('threatLayer').addEventListener('click', event => { const close = event.target.closest('[data-popup-close]'); if (close) closePopup(close); });
  $('processList').addEventListener('click', event => { const row = event.target.closest('[data-process]'); if (row) { selectedProcess = row.dataset.process; renderProcesses(); } });
  $('endWatcher').addEventListener('click', () => {
    if (selectedProcess !== 'watcher.dll') return;
    state.watcherCpu = 4; state.watcherRestartAt = Date.now() + 180000; selectedProcess = ''; renderProcesses(); saveState();
    if (activeThreat?.type === 'watcher') finishThreat(); else showToast('watcher.dll ended. Automatic restart scheduled.');
  });
  let noteSaveTimer;
  const updateNote = () => {
    const input = $('notepad'); const before = input.value.slice(0,input.selectionStart).split('\n');
    $('noteLine').textContent = before.length; $('noteCol').textContent = before[before.length - 1].length + 1;
    clearTimeout(noteSaveTimer); noteSaveTimer = setTimeout(() => { state.notepad = input.value; saveState(); }, 300);
  };
  $('notepad').addEventListener('input', updateNote); $('notepad').addEventListener('click', updateNote); $('notepad').addEventListener('keyup', updateNote);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && active && !activeThreat) requestExit();
  });
  document.addEventListener('visibilitychange', () => {
    if (!state || !active) return;
    if (document.hidden) { commitElapsed(); paused = true; saveState(); }
    else { runtimeStartedAt = Date.now(); paused = false; scheduleThreat(false); }
  });
  window.addEventListener('beforeunload', saveState);
}

setupWindows();
setupEvents();
$('continueGame').hidden = !state || state.completed;
setScreen('warningScreen');
})();
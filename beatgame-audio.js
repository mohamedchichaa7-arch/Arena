// ── Beat Rush — server-side audio pipeline ──────────────────────────────
// YouTube (yt-dlp) / Spotify (Web API preview) / file upload → PCM decode →
// custom onset-detection beat analysis → seeded note-map generation.
//
// No native audio-decoding dependency (node-web-audio-api requires native
// compilation, which is fragile on Render/Windows) — instead ffmpeg always
// normalizes whatever source audio we get down to mono 16-bit PCM WAV, and
// we parse that ourselves with a small hand-rolled WAV reader.
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const TEMP_DIR = path.join(os.tmpdir(), 'arena-beatgame');
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

// yt-dlp is pip-installed into this fixed project-local dir at build time
// (render.yaml: `pip3 install --target ./py-deps yt-dlp`) — using PYTHONPATH
// instead of relying on `pip --user` avoids HOME/site-packages mismatches
// between the build and runtime environment on Render.
const PY_DEPS_DIR = path.join(__dirname, 'py-deps');
function pyEnv() {
  const existing = process.env.PYTHONPATH;
  return { ...process.env, PYTHONPATH: existing ? `${PY_DEPS_DIR}${path.delimiter}${existing}` : PY_DEPS_DIR };
}

let ytDlpAvailable = false;
let ffmpegAvailable = false;
let activeJobs = 0;
const MAX_CONCURRENT_JOBS = 3;
let toolsCheckPromise = null;

// Self-healing install: works even if the host's dashboard build command was
// never updated to run `pip3 install ... yt-dlp` (e.g. render.yaml only takes
// effect for Blueprint-managed services — a plain dashboard-created Web Service
// ignores it). python3-pip is available at runtime on Render's native Node
// image too, so we can install on first boot instead of relying on the build step.
async function ensureYtDlpInstalled(logFn) {
  if (!fs.existsSync(PY_DEPS_DIR)) fs.mkdirSync(PY_DEPS_DIR, { recursive: true });
  try {
    await execFileAsync('pip3', ['install', '--break-system-packages', '--target', PY_DEPS_DIR, 'yt-dlp'], { timeout: 90000, env: pyEnv() });
    return true;
  } catch (err) {
    logFn('warn', 'beatgame-ytdlp-install-failed', { err: String(err.message || err).split('\n')[0].slice(0, 300) });
    return false;
  }
}

function checkTools(log) {
  toolsCheckPromise = doCheckTools(log);
  return toolsCheckPromise;
}

async function doCheckTools(log) {
  const logFn = log || (() => {});
  try {
    await execFileAsync('python3', ['-m', 'yt_dlp', '--version'], { timeout: 10000, env: pyEnv() });
    ytDlpAvailable = true;
  } catch {
    logFn('info', 'beatgame-ytdlp-installing', { msg: 'yt-dlp not found — attempting one-time pip install…' });
    if (await ensureYtDlpInstalled(logFn)) {
      try {
        await execFileAsync('python3', ['-m', 'yt_dlp', '--version'], { timeout: 10000, env: pyEnv() });
        ytDlpAvailable = true;
      } catch { ytDlpAvailable = false; }
    }
    if (!ytDlpAvailable) logFn('warn', 'beatgame-ytdlp-missing', { msg: 'yt-dlp not found (pip install yt-dlp) — YouTube support disabled for Beat Rush' });
  }
  try {
    await execFileAsync('ffmpeg', ['-version'], { timeout: 10000 });
    ffmpegAvailable = true;
  } catch {
    ffmpegAvailable = false;
    logFn('warn', 'beatgame-ffmpeg-missing', { msg: 'ffmpeg not found — Beat Rush audio analysis disabled entirely' });
  }
}

// ── Sessions (temp playback files served once, then deleted) ───────────
const sessions = new Map(); // sessionId -> { filePath, timer }
function registerSession(filePath) {
  const sessionId = crypto.randomUUID();
  const timer = setTimeout(() => cleanupSession(sessionId), 5 * 60 * 1000);
  sessions.set(sessionId, { filePath, timer });
  return sessionId;
}
function consumeSessionAudio(sessionId) {
  if (!/^[a-f0-9-]{36}$/i.test(String(sessionId || ''))) return null;
  return sessions.get(sessionId) || null;
}
function cleanupSession(sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return;
  clearTimeout(s.timer);
  fs.unlink(s.filePath, () => {});
  sessions.delete(sessionId);
}

// ── Song cache (note maps only, 24h, in-memory) ─────────────────────────
const songCache = new Map(); // key -> { data, expiresAt }
function cacheKey(type, url) { return type + ':' + String(url || '').trim().toLowerCase(); }
function getCached(type, url) {
  const entry = songCache.get(cacheKey(type, url));
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { songCache.delete(cacheKey(type, url)); return null; }
  return entry.data;
}
function setCached(type, url, data) {
  songCache.set(cacheKey(type, url), { data, expiresAt: Date.now() + 24 * 60 * 60 * 1000 });
}

// ── YouTube ──────────────────────────────────────────────────────────
const YT_URL_RE = /^https?:\/\/(www\.|m\.)?(youtube\.com\/(watch\?v=|shorts\/)|youtu\.be\/)/i;
// android/ios clients historically skip the PO-token "sign in to confirm you're
// not a bot" check that the default web client hits on datacenter IPs (Render etc.)
const YT_CLIENT_ARGS = ['--extractor-args', 'youtube:player_client=android,ios,web'];

function friendlyYtError(err) {
  const raw = String((err && (err.stderr || err.message)) || err || '');
  if (/sign in to confirm|not a bot/i.test(raw)) return 'YouTube blocked this download (bot/sign-in check). Try a different video, or use Spotify / file upload instead.';
  if (/private video|video unavailable/i.test(raw)) return 'This video is private or unavailable.';
  if (/age[- ]restrict/i.test(raw)) return 'This video is age-restricted and cannot be downloaded here.';
  if (/copyright/i.test(raw)) return 'This video is blocked due to a copyright claim.';
  if (/match-filter|does not pass filter/i.test(raw)) return 'Video duration must be between 30 seconds and 8 minutes.';
  return 'Failed to fetch this YouTube video. Try a different video, or use Spotify / file upload instead.';
}

async function fetchYoutubeMeta(url) {
  try {
    const { stdout } = await execFileAsync('python3', ['-m', 'yt_dlp', ...YT_CLIENT_ARGS, '--dump-json', '--no-warnings', '--no-playlist', url], { timeout: 20000, maxBuffer: 20 * 1024 * 1024, env: pyEnv() });
    const firstLine = stdout.trim().split('\n')[0];
    const info = JSON.parse(firstLine);
    return { id: info.id, title: info.title || 'Untitled', thumbnail: info.thumbnail || null, duration: info.duration || 0 };
  } catch (err) {
    throw new Error(friendlyYtError(err));
  }
}

async function downloadYoutubeAudio(url, id) {
  const outTemplate = path.join(TEMP_DIR, `beatgame_${id}.%(ext)s`);
  try {
    await execFileAsync('python3', [
      '-m', 'yt_dlp', ...YT_CLIENT_ARGS,
      '-x', '--audio-format', 'wav', '--audio-quality', '0', '--no-playlist',
      '--match-filter', 'duration >= 30 & duration <= 480',
      '-o', outTemplate, url,
    ], { timeout: 120000, maxBuffer: 20 * 1024 * 1024, env: pyEnv() });
  } catch (err) {
    throw new Error(friendlyYtError(err));
  }
  const wavPath = path.join(TEMP_DIR, `beatgame_${id}.wav`);
  if (!fs.existsSync(wavPath)) throw new Error('yt-dlp did not produce an audio file (video may be unavailable, private, or age-restricted)');
  return wavPath;
}

// ── Spotify ──────────────────────────────────────────────────────────
let spotifyToken = null, spotifyTokenExpiry = 0;
async function getSpotifyToken() {
  if (spotifyToken && Date.now() < spotifyTokenExpiry) return spotifyToken;
  const id = process.env.SPOTIFY_CLIENT_ID, secret = process.env.SPOTIFY_CLIENT_SECRET;
  if (!id || !secret) throw new Error('Spotify is not configured on this server');
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Authorization': 'Basic ' + Buffer.from(id + ':' + secret).toString('base64') },
    body: 'grant_type=client_credentials',
  });
  if (!res.ok) throw new Error('Spotify authentication failed');
  const data = await res.json();
  spotifyToken = data.access_token;
  spotifyTokenExpiry = Date.now() + (data.expires_in - 60) * 1000;
  return spotifyToken;
}

function extractSpotifyTrackId(url) {
  const m = String(url || '').match(/track[/:]([a-zA-Z0-9]+)/);
  return m ? m[1] : null;
}

async function fetchSpotifyTrack(url) {
  const trackId = extractSpotifyTrackId(url);
  if (!trackId) throw new Error('Invalid Spotify track URL');
  const token = await getSpotifyToken();
  const res = await fetch(`https://api.spotify.com/v1/tracks/${trackId}`, { headers: { Authorization: 'Bearer ' + token } });
  if (!res.ok) throw new Error('Spotify track lookup failed');
  const track = await res.json();
  if (!track.preview_url) throw new Error('No 30-second preview available — try YouTube or upload instead');
  return {
    title: track.name,
    artist: (track.artists || []).map(a => a.name).join(', '),
    thumbnail: track.album?.images?.[0]?.url || null,
    previewUrl: track.preview_url,
    duration: 30,
  };
}

async function downloadSpotifyPreview(previewUrl, sessionSeed) {
  const res = await fetch(previewUrl);
  if (!res.ok) throw new Error('Failed to download Spotify preview audio');
  const buf = Buffer.from(await res.arrayBuffer());
  const mp3Path = path.join(TEMP_DIR, `beatgame_${sessionSeed}.mp3`);
  fs.writeFileSync(mp3Path, buf);
  return mp3Path;
}

// ── Upload ───────────────────────────────────────────────────────────
function saveUploadedAudio(dataBase64, filename, sessionSeed) {
  const ext = (path.extname(filename || '').toLowerCase() || '.mp3');
  if (!['.mp3', '.wav', '.ogg'].includes(ext)) throw new Error('Unsupported file type — use MP3, WAV, or OGG');
  if (!dataBase64 || typeof dataBase64 !== 'string') throw new Error('No file data received');
  const buf = Buffer.from(dataBase64, 'base64');
  if (buf.length > 20 * 1024 * 1024) throw new Error('File too large — max 20MB');
  if (buf.length < 1000) throw new Error('File too small or corrupt');
  const filePath = path.join(TEMP_DIR, `beatgame_upload_${sessionSeed}${ext}`);
  fs.writeFileSync(filePath, buf);
  return filePath;
}

// ── ffmpeg normalization + WAV parsing ──────────────────────────────
async function normalizeForAnalysis(inputPath, sessionSeed) {
  const outPath = path.join(TEMP_DIR, `beatgame_analysis_${sessionSeed}.wav`);
  await execFileAsync('ffmpeg', ['-y', '-i', inputPath, '-ar', '22050', '-ac', '1', '-acodec', 'pcm_s16le', outPath], { timeout: 60000 });
  return outPath;
}

function parseWavMono16(filePath) {
  const buf = fs.readFileSync(filePath);
  if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid WAV file produced during analysis');
  let offset = 12, fmt = null, dataOffset = -1, dataLen = 0;
  while (offset + 8 <= buf.length) {
    const chunkId = buf.toString('ascii', offset, offset + 4);
    const chunkSize = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (chunkId === 'fmt ') {
      fmt = { audioFormat: buf.readUInt16LE(body), numChannels: buf.readUInt16LE(body + 2), sampleRate: buf.readUInt32LE(body + 4), bitsPerSample: buf.readUInt16LE(body + 14) };
    } else if (chunkId === 'data') {
      dataOffset = body; dataLen = Math.min(chunkSize, buf.length - body);
    }
    offset = body + chunkSize + (chunkSize % 2);
  }
  if (!fmt || dataOffset < 0) throw new Error('WAV file missing fmt or data chunk');
  const numSamples = Math.floor(dataLen / 2); // 16-bit mono
  const samples = new Float32Array(numSamples);
  for (let i = 0; i < numSamples; i++) samples[i] = buf.readInt16LE(dataOffset + i * 2) / 32768;
  return { sampleRate: fmt.sampleRate, samples, duration: numSamples / fmt.sampleRate };
}

// ── Beat / onset detection (pure JS, no external DSP lib) ───────────
function detectBeats(samples, sampleRate) {
  const hop = Math.round(sampleRate * 0.02322); // ~512 samples @ 22050Hz
  const winSize = hop * 2;
  const numFrames = Math.max(0, Math.floor((samples.length - winSize) / hop));
  const energies = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    const start = f * hop;
    let sum = 0;
    for (let i = 0; i < winSize; i++) { const s = samples[start + i]; sum += s * s; }
    energies[f] = Math.sqrt(sum / winSize);
  }
  const onset = new Float32Array(energies.length);
  for (let i = 1; i < energies.length; i++) onset[i] = Math.max(0, energies[i] - energies[i - 1]);
  const smooth = new Float32Array(onset.length);
  for (let i = 0; i < onset.length; i++) {
    let s = 0, c = 0;
    for (let k = -2; k <= 2; k++) { const idx = i + k; if (idx >= 0 && idx < onset.length) { s += onset[idx]; c++; } }
    smooth[i] = c ? s / c : 0;
  }
  const mean = smooth.length ? smooth.reduce((a, b) => a + b, 0) / smooth.length : 0;
  let variance = 0; for (const v of smooth) variance += (v - mean) ** 2;
  variance = smooth.length ? variance / smooth.length : 0;
  const std = Math.sqrt(variance);
  const threshold = mean + std * 1.2;
  const frameTime = hop / sampleRate;
  const minGapFrames = Math.max(1, Math.round(0.2 / frameTime)); // beats >=200ms apart

  const peaks = [];
  let lastPeak = -minGapFrames;
  for (let i = 1; i < smooth.length - 1; i++) {
    if (smooth[i] > threshold && smooth[i] >= smooth[i - 1] && smooth[i] >= smooth[i + 1] && (i - lastPeak) >= minGapFrames) {
      peaks.push(i);
      lastPeak = i;
    }
  }

  const beats = peaks.map(p => parseFloat((p * frameTime).toFixed(4)));
  const maxEnergy = energies.length ? energies.reduce((a, b) => Math.max(a, b), 0.0001) : 0.0001;
  const energyList = peaks.map(p => Math.min(1, energies[p] / maxEnergy));

  let bpm = 120;
  if (beats.length > 4) {
    const intervals = [];
    for (let i = 1; i < beats.length; i++) intervals.push(beats[i] - beats[i - 1]);
    intervals.sort((a, b) => a - b);
    const median = intervals[Math.floor(intervals.length / 2)] || 0.5;
    let est = 60 / median;
    while (est > 180) est /= 2;
    while (est < 70) est *= 2;
    bpm = Math.round(est);
  }
  return { bpm, beats, energies: energyList };
}

function fallbackGrid(duration) {
  const beats = [], energies = [];
  let t = 0.5;
  while (t < duration - 0.5) { beats.push(parseFloat(t.toFixed(4))); energies.push(0.5); t += 0.5; }
  return { bpm: 120, beats, energies };
}

// ── Deterministic note-map generation ────────────────────────────────
function strHash(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (Math.imul(31, h) + str.charCodeAt(i)) | 0;
  return h >>> 0;
}
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DIRECTIONS_8 = ['up', 'down', 'left', 'right', 'up-left', 'up-right', 'down-left', 'down-right'];
const DIRECTIONS_4 = ['up', 'down', 'left', 'right'];
const MIRROR = { left: 'right', right: 'left', 'up-left': 'up-right', 'up-right': 'up-left', 'down-left': 'down-right', 'down-right': 'down-left', up: 'up', down: 'down' };

function last3Same(arr, lane) { return arr.length >= 3 && arr.every(l => l === lane); }

function buildDifficultyMap(beats, energies, rng, opts) {
  const { minEnergy, directions, allowBombs, allowDouble, minGap } = opts;
  const notes = [];
  const lastLanes = [];
  let lastNoteTime = -Infinity;
  for (let i = 0; i < beats.length; i++) {
    if (beats[i] - lastNoteTime < minGap) continue; // keep note groups spaced apart so hit windows don't overlap
    const e = energies[i];
    let count = 0;
    if (e > 0.7) count = 2;
    else if (e >= 0.4 && e >= minEnergy) count = 1;
    else if (e >= minEnergy && rng() < 0.4) count = 1;
    if (e < minEnergy) count = 0;
    if (count === 0) continue;
    lastNoteTime = beats[i];

    for (let n = 0; n < count; n++) {
      let lane, attempts = 0;
      do { lane = Math.floor(rng() * 4); attempts++; } while (last3Same(lastLanes, lane) && attempts < 10);
      lastLanes.push(lane); if (lastLanes.length > 3) lastLanes.shift();

      let type = 'normal';
      const roll = rng();
      if (allowBombs && roll < 0.10) type = 'bomb';
      else if (allowDouble && roll < 0.15) type = 'double';

      let direction = directions[Math.floor(rng() * directions.length)];
      if (type !== 'bomb' && rng() < 0.12) direction = 'dot';

      notes.push({ time: beats[i], lane, direction, type });
      if (type === 'double') {
        let lane2; do { lane2 = Math.floor(rng() * 4); } while (lane2 === lane);
        notes.push({ time: beats[i], lane: lane2, direction: MIRROR[direction] || direction, type: 'normal' });
      }
    }
  }
  return notes;
}

function generateNoteMaps(beats, energies, seedStr) {
  const rng = mulberry32(strHash(seedStr));
  return {
    easy: { notes: buildDifficultyMap(beats, energies, rng, { minEnergy: 0.7, directions: DIRECTIONS_4, allowBombs: false, allowDouble: false, minGap: 0.5 }), timingWindow: 0.15 },
    normal: { notes: buildDifficultyMap(beats, energies, rng, { minEnergy: 0.4, directions: DIRECTIONS_8, allowBombs: true, allowDouble: true, minGap: 0.35 }), timingWindow: 0.10 },
    hard: { notes: buildDifficultyMap(beats, energies, rng, { minEnergy: 0, directions: DIRECTIONS_8, allowBombs: true, allowDouble: true, minGap: 0.25 }), timingWindow: 0.07 },
  };
}

async function analyzeAudioFile(playbackFilePath, sessionSeed, seedStr) {
  const analysisPath = await normalizeForAnalysis(playbackFilePath, sessionSeed);
  try {
    const { sampleRate, samples, duration } = parseWavMono16(analysisPath);
    if (duration < 30) throw new Error('Audio too short for gameplay (minimum 30 seconds)');
    if (duration > 480) throw new Error('Please use audio under 8 minutes');
    let { bpm, beats, energies } = detectBeats(samples, sampleRate);
    if (beats.length < 8) ({ bpm, beats, energies } = fallbackGrid(duration));
    const noteMaps = generateNoteMaps(beats, energies, seedStr);
    return { bpm, duration, noteMaps };
  } finally {
    fs.unlink(analysisPath, () => {});
  }
}

// ── Public entry point ───────────────────────────────────────────────
async function prepareSong(payload) {
  const type = payload && payload.type;
  if (!['youtube', 'spotify', 'upload'].includes(type)) throw new Error('Invalid source type');
  if (toolsCheckPromise) await toolsCheckPromise; // don't race the one-time yt-dlp self-install
  if (!ffmpegAvailable) throw new Error('Audio processing is unavailable on this server (ffmpeg missing)');
  if (activeJobs >= MAX_CONCURRENT_JOBS) throw new Error('Server is busy processing other songs — try again shortly');

  activeJobs++;
  const sessionSeed = crypto.randomUUID();
  let playbackFilePath = null;
  try {
    if (type === 'youtube') {
      const url = String(payload.url || '').trim();
      if (!YT_URL_RE.test(url)) throw new Error('Please paste a valid YouTube URL');
      if (!ytDlpAvailable) throw new Error('YouTube support is disabled on this server (yt-dlp not installed)');
      const cached = getCached('youtube', url);
      const meta = await fetchYoutubeMeta(url);
      if (meta.duration && (meta.duration < 30 || meta.duration > 480)) {
        throw new Error(meta.duration < 30 ? 'Audio too short for gameplay' : 'Please use videos under 8 minutes');
      }
      playbackFilePath = await downloadYoutubeAudio(url, meta.id + '_' + sessionSeed);
      const sessionId = registerSession(playbackFilePath);
      let analysis = cached;
      if (!analysis) {
        analysis = await analyzeAudioFile(playbackFilePath, sessionSeed, meta.title + '|' + meta.id);
        setCached('youtube', url, analysis);
      }
      return { title: meta.title, artist: null, thumbnail: meta.thumbnail, bpm: analysis.bpm, duration: analysis.duration, noteMaps: analysis.noteMaps, sessionId };
    }

    if (type === 'spotify') {
      const url = String(payload.url || '').trim();
      const cached = getCached('spotify', url);
      const track = await fetchSpotifyTrack(url);
      playbackFilePath = await downloadSpotifyPreview(track.previewUrl, sessionSeed);
      const sessionId = registerSession(playbackFilePath);
      let analysis = cached;
      if (!analysis) {
        analysis = await analyzeAudioFile(playbackFilePath, sessionSeed, track.title + '|' + track.artist);
        setCached('spotify', url, analysis);
      }
      return { title: track.title, artist: track.artist, thumbnail: track.thumbnail, bpm: analysis.bpm, duration: analysis.duration, noteMaps: analysis.noteMaps, sessionId };
    }

    // upload
    playbackFilePath = saveUploadedAudio(payload.dataBase64, payload.filename, sessionSeed);
    const sessionId = registerSession(playbackFilePath);
    const title = (payload.filename || 'Uploaded Track').replace(/\.[^.]+$/, '');
    const analysis = await analyzeAudioFile(playbackFilePath, sessionSeed, title + '|' + sessionSeed);
    return { title, artist: null, thumbnail: null, bpm: analysis.bpm, duration: analysis.duration, noteMaps: analysis.noteMaps, sessionId };
  } catch (err) {
    if (playbackFilePath) fs.unlink(playbackFilePath, () => {});
    throw err;
  } finally {
    activeJobs--;
  }
}

module.exports = {
  checkTools,
  prepareSong,
  consumeSessionAudio,
  cleanupSession,
  get ytDlpAvailable() { return ytDlpAvailable; },
  get ffmpegAvailable() { return ffmpegAvailable; },
};

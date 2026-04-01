(() => {
'use strict';
const $ = s => document.getElementById(s);
const joinScreen = $('joinScreen'), lobbyScreen = $('lobbyScreen');
const nameInput = $('nameInput'), btnJoin = $('btnJoin');
const roomNameInput = $('roomNameInput'), gameTypeSelect = $('gameTypeSelect');
const maxPlayersSelect = $('maxPlayersSelect'), btnCreate = $('btnCreate');
const roomGrid = $('roomGrid'), emptyState = $('emptyState');
const userBadge = $('userBadge');

let ws = null, myName = '';

function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function connect() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'lobby', name: myName }));
  ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch {} };
  ws.onclose = () => {};
}
function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

function handleMsg(msg) {
  switch (msg.type) {
    case 'room-list': renderRooms(msg.rooms); break;
    case 'room-created':
      // Room created — navigate to the game page (join happens there)
      sessionStorage.setItem('arena-name', myName);
      window.location.href = `/${msg.roomType}?room=${msg.roomId}`;
      break;
    case 'error':
      alert(msg.msg);
      break;
  }
}

function renderRooms(rooms) {
  // Remove old room cards (but keep emptyState)
  roomGrid.querySelectorAll('.room-card').forEach(el => el.remove());
  emptyState.style.display = rooms.length === 0 ? '' : 'none';

  for (const r of rooms) {
    const card = document.createElement('div');
    card.className = 'room-card';
    const icon = r.type === 'tetris' ? '🎮' : '🏁';
    const statusCls = r.status === 'playing' ? 'playing' : 'waiting';
    const full = r.players >= r.maxPlayers;
    card.innerHTML = `
      <div class="room-card-header">
        <span class="room-type-icon">${icon}</span>
        <span class="room-name">${escapeHtml(r.name)}</span>
        <span class="room-status ${statusCls}">${r.status}</span>
      </div>
      <div class="room-meta">
        <span class="room-players"><span>${r.players}</span> / ${r.maxPlayers} players</span>
        <span class="room-id">${r.id}</span>
      </div>
      <div style="margin-top:.8rem;text-align:right">
        <button class="btn btn-join-room" ${full ? 'disabled' : ''}>${full ? 'Full' : 'Join'}</button>
      </div>
    `;
    card.querySelector('.btn-join-room').addEventListener('click', () => {
      // Navigate directly — game page will join via its own WS
      sessionStorage.setItem('arena-name', myName);
      window.location.href = `/${r.type}?room=${r.id}`;
    });
    roomGrid.appendChild(card);
  }
}

// ── Events ──
btnJoin.addEventListener('click', join);
nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') join(); });

function join() {
  const name = nameInput.value.trim();
  if (!name) { nameInput.focus(); return; }
  myName = name;
  joinScreen.style.display = 'none';
  lobbyScreen.style.display = '';
  userBadge.textContent = myName;
  roomNameInput.value = myName + "'s Room";
  connect();
}

btnCreate.addEventListener('click', () => {
  const roomName = roomNameInput.value.trim() || myName + "'s Room";
  const gameType = gameTypeSelect.value;
  const maxPlayers = parseInt(maxPlayersSelect.value);
  wsSend({ type: 'create-room', roomName, gameType, maxPlayers });
});

nameInput.focus();
})();

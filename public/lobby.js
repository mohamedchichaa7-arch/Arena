(() => {
  'use strict';
  const $ = s => document.getElementById(s);
  const joinScreen = $('joinScreen'), lobbyScreen = $('lobbyScreen');
  const nameInput = $('nameInput'), btnJoin = $('btnJoin');
  const roomNameInput = $('roomNameInput'), gameTypeSelect = $('gameTypeSelect');
  const maxPlayersSelect = $('maxPlayersSelect'), btnCreate = $('btnCreate');
  const roomPasswordInput = $('roomPasswordInput');
  const roomGrid = $('roomGrid'), emptyState = $('emptyState');
  const userBadge = $('userBadge');
  const pwModal = $('pwModal'), pwInput = $('pwInput');
  const pwConfirm = $('pwConfirm'), pwCancel = $('pwCancel'), pwError = $('pwError');

  let ws = null, myName = '';
  let pendingRoom = null; // { id, type } for the room being password-entered
  let pendingCreatePassword = null; // password used when creating a room

  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}`);
    ws.onopen = () => ws.send(JSON.stringify({ type: 'lobby', name: myName }));
    ws.onmessage = e => { try { handleMsg(JSON.parse(e.data)); } catch { } };
    ws.onclose = () => { };
  }
  function wsSend(msg) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(msg)); }

  function handleMsg(msg) {
    switch (msg.type) {
      case 'room-list': renderRooms(msg.rooms); break;
      case 'room-created':
        sessionStorage.setItem('arena-name', myName);
        if (pendingCreatePassword) {
          sessionStorage.setItem('arena-room-password', pendingCreatePassword);
          pendingCreatePassword = null;
        }
        window.location.href = `/${msg.roomType}?room=${msg.roomId}`;
        break;
      case 'error':
        alert(msg.msg);
        break;
    }
  }

  function navigateToRoom(room, password) {
    sessionStorage.setItem('arena-name', myName);
    if (password) sessionStorage.setItem('arena-room-password', password);
    else sessionStorage.removeItem('arena-room-password');
    window.location.href = `/${room.type}?room=${room.id}`;
  }

  function openPwModal(room) {
    pendingRoom = room;
    pwInput.value = '';
    pwError.textContent = '';
    pwModal.style.display = 'flex';
    pwInput.focus();
  }

  function closePwModal() {
    pwModal.style.display = 'none';
    pendingRoom = null;
  }

  pwConfirm.addEventListener('click', confirmPassword);
  pwInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmPassword(); if (e.key === 'Escape') closePwModal(); });
  pwCancel.addEventListener('click', closePwModal);
  pwModal.addEventListener('click', e => { if (e.target === pwModal) closePwModal(); });

  function confirmPassword() {
    const pw = pwInput.value.trim();
    if (!pw) { pwError.textContent = 'Please enter a password.'; return; }
    if (!pendingRoom) return;
    navigateToRoom(pendingRoom, pw);
  }

  function renderRooms(rooms) {
    roomGrid.querySelectorAll('.room-card').forEach(el => el.remove());
    emptyState.style.display = rooms.length === 0 ? '' : 'none';

    for (const r of rooms) {
      const card = document.createElement('div');
      card.className = 'room-card';
      const icon = r.type === 'tetris' ? '🎮' : r.type === 'tictactoe' ? '⭕' : r.type === 'bluffrummy' ? '🃏' : '🏁';
      const statusCls = r.status === 'playing' ? 'playing' : 'waiting';
      const full = r.players >= r.maxPlayers;
      const lockBadge = r.locked ? '<span class="room-lock">🔒</span>' : '';
      card.innerHTML = `
      <div class="room-card-header">
        <span class="room-type-icon">${icon}</span>
        <span class="room-name">${escapeHtml(r.name)}</span>
        ${lockBadge}
        <span class="room-status ${statusCls}">${r.status}</span>
      </div>
      <div class="room-meta">
        <span class="room-players"><span>${r.players}</span> / ${r.maxPlayers} players</span>
        <span class="room-id">${r.id}</span>
      </div>
      <div style="margin-top:.8rem;text-align:right">
        <button class="btn btn-join-room" ${full ? 'disabled' : ''}>${full ? 'Full' : r.locked ? '🔒 Join' : 'Join'}</button>
      </div>
    `;
      card.querySelector('.btn-join-room').addEventListener('click', () => {
        sessionStorage.setItem('arena-name', myName);
        if (r.locked) {
          openPwModal(r);
        } else {
          navigateToRoom(r, null);
        }
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
    const password = roomPasswordInput.value.trim() || null;
    pendingCreatePassword = password;
    wsSend({ type: 'create-room', roomName, gameType, maxPlayers, password });
  });

  // Auto-rejoin lobby if name is already known (e.g. returning from a game)
  const savedName = sessionStorage.getItem('arena-name');
  if (savedName) {
    nameInput.value = savedName;
    join();
  } else {
    nameInput.focus();
  }
})();

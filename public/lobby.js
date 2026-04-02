(() => {
  'use strict';
  const $ = s => document.getElementById(s);

  //  DOM refs 
  const authScreen   = $('authScreen');
  const lobbyScreen  = $('lobbyScreen');
  const loginEmail   = $('loginEmail');
  const loginPassword = $('loginPassword');
  const btnEmailLogin = $('btnEmailLogin');
  const btnGoogleLogin = $('btnGoogleLogin');
  const registerName  = $('registerName');
  const registerEmail = $('registerEmail');
  const registerPassword = $('registerPassword');
  const btnRegister   = $('btnRegister');
  const btnGoogleRegister = $('btnGoogleRegister');
  const tabLogin      = $('tabLogin');
  const tabRegister   = $('tabRegister');
  const loginForm     = $('loginForm');
  const registerForm  = $('registerForm');
  const authError     = $('authError');
  const roomNameInput = $('roomNameInput');
  const gameTypeSelect = $('gameTypeSelect');
  const maxPlayersSelect = $('maxPlayersSelect');
  const btnCreate     = $('btnCreate');
  const roomPasswordInput = $('roomPasswordInput');
  const roomGrid      = $('roomGrid');
  const emptyState    = $('emptyState');
  const userBadge     = $('userBadge');
  const btnSignOut    = $('btnSignOut');
  const btnLeaderboard = $('btnLeaderboard');
  const pwModal       = $('pwModal');
  const pwInput       = $('pwInput');
  const pwConfirm     = $('pwConfirm');
  const pwCancel      = $('pwCancel');
  const pwError       = $('pwError');
  const lbModal       = $('lbModal');
  const lbClose       = $('lbClose');
  const lbList        = $('lbList');
  const lbSubtitle    = $('lbSubtitle');

  let ws = null, myName = '', myToken = null;
  let pendingRoom = null;
  let pendingCreatePassword = null;
  let currentLbGame = 'maze';

  function escapeHtml(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  //  Firebase Auth 
  fbAuth.onAuthStateChanged(async user => {
    if (user) {
      myToken = await user.getIdToken();
      sessionStorage.setItem('arena-token', myToken);
      sessionStorage.setItem('arena-uid', user.uid);
      myName = user.displayName || user.email.split('@')[0] || 'Player';
      sessionStorage.setItem('arena-name', myName);
      sessionStorage.setItem('arena-display-name', myName);
      showLobby();
    } else {
      showAuth();
    }
  });

  function showAuth() {
    authScreen.style.display = '';
    lobbyScreen.style.display = 'none';
    if (ws) { ws.close(); ws = null; }
  }

  function showLobby() {
    authScreen.style.display = 'none';
    lobbyScreen.style.display = '';
    userBadge.textContent = myName;
    roomNameInput.value = myName + "'s Room";
    connect();
  }

  function setAuthError(msg) { authError.textContent = msg; }

  //  Auth: Login tab 
  tabLogin.addEventListener('click', () => {
    tabLogin.classList.add('active'); tabRegister.classList.remove('active');
    loginForm.style.display = ''; registerForm.style.display = 'none';
    setAuthError('');
  });
  tabRegister.addEventListener('click', () => {
    tabRegister.classList.add('active'); tabLogin.classList.remove('active');
    registerForm.style.display = ''; loginForm.style.display = 'none';
    setAuthError('');
  });

  function googleSignIn() {
    setAuthError('');
    const provider = new firebase.auth.GoogleAuthProvider();
    fbAuth.signInWithPopup(provider).catch(e => setAuthError(e.message));
  }

  btnEmailLogin.addEventListener('click', () => {
    setAuthError('');
    const email = loginEmail.value.trim();
    const pw = loginPassword.value;
    if (!email || !pw) { setAuthError('Please fill in all fields.'); return; }
    fbAuth.signInWithEmailAndPassword(email, pw).catch(e => setAuthError(e.message));
  });

  loginPassword.addEventListener('keydown', e => { if (e.key === 'Enter') btnEmailLogin.click(); });
  btnGoogleLogin.addEventListener('click', googleSignIn);
  btnGoogleRegister.addEventListener('click', googleSignIn);

  btnRegister.addEventListener('click', async () => {
    setAuthError('');
    const name = registerName.value.trim();
    const email = registerEmail.value.trim();
    const pw = registerPassword.value;
    if (!name || !email || !pw) { setAuthError('Please fill in all fields.'); return; }
    if (pw.length < 6) { setAuthError('Password must be at least 6 characters.'); return; }
    try {
      const cred = await fbAuth.createUserWithEmailAndPassword(email, pw);
      await cred.user.updateProfile({ displayName: name });
    } catch (e) { setAuthError(e.message); }
  });

  btnSignOut.addEventListener('click', () => {
    sessionStorage.clear();
    fbAuth.signOut();
  });

  //  WebSocket 
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
        sessionStorage.setItem('arena-name', myName);
        if (pendingCreatePassword) {
          sessionStorage.setItem('arena-room-password', pendingCreatePassword);
          pendingCreatePassword = null;
        }
        window.location.href = '/' + msg.roomType + '?room=' + msg.roomId;
        break;
      case 'error': alert(msg.msg); break;
    }
  }

  function navigateToRoom(room, password) {
    sessionStorage.setItem('arena-name', myName);
    if (password) sessionStorage.setItem('arena-room-password', password);
    else sessionStorage.removeItem('arena-room-password');
    window.location.href = '/' + room.type + '?room=' + room.id;
  }

  //  Password modal 
  function openPwModal(room) {
    pendingRoom = room; pwInput.value = ''; pwError.textContent = '';
    pwModal.style.display = 'flex'; pwInput.focus();
  }
  function closePwModal() { pwModal.style.display = 'none'; pendingRoom = null; }
  function confirmPassword() {
    const pw = pwInput.value.trim();
    if (!pw) { pwError.textContent = 'Please enter a password.'; return; }
    if (!pendingRoom) return;
    navigateToRoom(pendingRoom, pw);
  }
  pwConfirm.addEventListener('click', confirmPassword);
  pwInput.addEventListener('keydown', e => { if (e.key === 'Enter') confirmPassword(); if (e.key === 'Escape') closePwModal(); });
  pwCancel.addEventListener('click', closePwModal);
  pwModal.addEventListener('click', e => { if (e.target === pwModal) closePwModal(); });

  //  Room list 
  function renderRooms(rooms) {
    roomGrid.querySelectorAll('.room-card').forEach(el => el.remove());
    emptyState.style.display = rooms.length === 0 ? '' : 'none';
    for (const r of rooms) {
      const card = document.createElement('div');
      card.className = 'room-card';
      const icon = r.type === 'tetris' ? '\u{1F3AE}' : r.type === 'tictactoe' ? '\u2B55' : r.type === 'bluffrummy' ? '\u{1F0CF}' : '\u{1F3C1}';
      const statusCls = r.status === 'playing' ? 'playing' : 'waiting';
      const full = r.players >= r.maxPlayers;
      const lockBadge = r.locked ? '<span class="room-lock">\uD83D\uDD12</span>' : '';
      card.innerHTML = '<div class="room-card-header"><span class="room-type-icon">' + icon + '</span><span class="room-name">' + escapeHtml(r.name) + '</span>' + lockBadge + '<span class="room-status ' + statusCls + '">' + r.status + '</span></div><div class="room-meta"><span class="room-players"><span>' + r.players + '</span> / ' + r.maxPlayers + ' players</span><span class="room-id">' + r.id + '</span></div><div style="margin-top:.8rem;text-align:right"><button class="btn btn-join-room" ' + (full ? 'disabled' : '') + '>' + (full ? 'Full' : r.locked ? '\uD83D\uDD12 Join' : 'Join') + '</button></div>';
      card.querySelector('.btn-join-room').addEventListener('click', () => {
        if (r.locked) openPwModal(r); else navigateToRoom(r, null);
      });
      roomGrid.appendChild(card);
    }
  }

  btnCreate.addEventListener('click', () => {
    const roomName = roomNameInput.value.trim() || myName + "'s Room";
    const gameType = gameTypeSelect.value;
    const maxPlayers = parseInt(maxPlayersSelect.value);
    const password = roomPasswordInput.value.trim() || null;
    pendingCreatePassword = password;
    wsSend({ type: 'create-room', roomName, gameType, maxPlayers, password });
  });

  //  Leaderboard 
  const LB_SUBTITLES = {
    maze: 'Fastest race finish (seconds - lower is better)',
    tetris: 'Highest single-game score',
    tictactoe: 'Total wins',
    bluffrummy: 'Total wins',
  };

  function openLeaderboard(game) {
    game = game || 'maze';
    currentLbGame = game;
    lbModal.style.display = 'flex';
    document.querySelectorAll('.lb-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.game === game);
    });
    lbSubtitle.textContent = LB_SUBTITLES[game] || '';
    loadLeaderboard(game);
  }

  function loadLeaderboard(game) {
    lbList.innerHTML = '<div class="lb-loading">Loading...</div>';
    fetch('/api/leaderboard?game=' + game)
      .then(r => r.json())
      .then(entries => {
        lbList.innerHTML = '';
        if (!entries.length) {
          lbList.innerHTML = '<div class="lb-empty">No scores yet. Be the first!</div>';
          return;
        }
        const myUid = sessionStorage.getItem('arena-uid') || '';
        entries.forEach(e => {
          const rankClass = e.rank === 1 ? 'gold' : e.rank === 2 ? 'silver' : e.rank === 3 ? 'bronze' : 'other';
          const isMe = e.uid === myUid;
          let scoreText = '';
          if (game === 'maze') {
            const s = Math.round(e.score);
            scoreText = Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
          } else {
            scoreText = e.score.toLocaleString();
          }
          const row = document.createElement('div');
          row.className = 'lb-row' + (isMe ? ' lb-row-me' : '');
          row.innerHTML = '<span class="lb-rank ' + rankClass + '">' + (e.rank === 1 ? '\uD83E\uDD47' : e.rank === 2 ? '\uD83E\uDD48' : e.rank === 3 ? '\uD83E\uDD49' : '#' + e.rank) + '</span><span class="lb-name' + (isMe ? ' is-me' : '') + '">' + escapeHtml(e.displayName || 'Player') + (isMe ? ' \u2605' : '') + '</span><span class="lb-score">' + scoreText + '</span>';
          lbList.appendChild(row);
        });
      })
      .catch(() => { lbList.innerHTML = '<div class="lb-empty">Could not load scores.</div>'; });
  }

  btnLeaderboard.addEventListener('click', () => openLeaderboard(currentLbGame));
  lbClose.addEventListener('click', () => { lbModal.style.display = 'none'; });
  lbModal.addEventListener('click', e => { if (e.target === lbModal) lbModal.style.display = 'none'; });
  document.querySelectorAll('.lb-tab').forEach(tab => {
    tab.addEventListener('click', () => openLeaderboard(tab.dataset.game));
  });
})();

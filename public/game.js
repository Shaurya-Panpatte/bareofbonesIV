const socket = io();

const el = id => document.getElementById(id);
const homeView = el('homeView');
const lobbyView = el('lobbyView');
const gameView = el('gameView');
const canvas = el('gameCanvas');
const ctx = canvas.getContext('2d');

let state = null;
let myId = null;
let selected = null;
let hovered = null;
let lastBattleResult = null;

const TILE = 40;
const WATER = '#07152a';

socket.on('connect', () => {
  myId = socket.id;
  el('connectionBadge').textContent = 'Online';
  el('connectionBadge').classList.add('online');
});

socket.on('disconnect', () => {
  el('connectionBadge').textContent = 'Disconnected';
  el('connectionBadge').classList.remove('online');
});

socket.on('roomState', next => {
  state = next;
  selected = null;
  renderState();
});

socket.on('battleResult', result => {
  lastBattleResult = result;
  showBattleResult(result);
});

el('createBtn').addEventListener('click', () => {
  const name = el('playerName').value;
  socket.emit('createRoom', { name }, result => {
    if (!result?.ok) el('homeError').textContent = result?.error || 'Could not create room.';
  });
});

el('joinBtn').addEventListener('click', () => {
  const name = el('playerName').value;
  const code = el('roomCodeInput').value;
  socket.emit('joinRoom', { name, code }, result => {
    el('homeError').textContent = result?.ok ? '' : result?.error || 'Could not join room.';
  });
});

el('roomCodeInput').addEventListener('input', e => {
  e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

el('copyCodeBtn').addEventListener('click', async () => {
  if (!state) return;
  await navigator.clipboard.writeText(state.code);
  el('copyCodeBtn').textContent = 'Copied';
  setTimeout(() => el('copyCodeBtn').textContent = 'Copy', 1100);
});

el('startBtn').addEventListener('click', () => {
  socket.emit('startGame', {}, result => {
    el('lobbyError').textContent = result?.ok ? '' : result?.error || 'Could not start.';
  });
});

el('endTurnBtn').addEventListener('click', () => {
  socket.emit('endTurn', {}, result => {
    if (!result?.ok) setSelectionMessage(result?.error || 'Could not end turn.', true);
  });
});

document.querySelectorAll('[data-upgrade]').forEach(button => {
  button.addEventListener('click', () => {
    socket.emit('buyUpgrade', { type: button.dataset.upgrade }, result => {
      if (!result?.ok) setSelectionMessage(result?.error || 'Upgrade failed.', true);
    });
  });
});

el('armyCommit').addEventListener('input', e => {
  el('armyCommitValue').textContent = e.target.value;
});

el('closeBattleBtn').addEventListener('click', () => {
  el('battleModal').classList.add('hidden');
});

canvas.addEventListener('mousemove', event => {
  hovered = canvasToTile(event);
  drawMap();
});
canvas.addEventListener('mouseleave', () => { hovered = null; drawMap(); });
canvas.addEventListener('click', handleCanvasClick);

function renderState() {
  homeView.classList.toggle('hidden', !!state);
  lobbyView.classList.toggle('hidden', !state || state.status !== 'lobby');
  gameView.classList.toggle('hidden', !state || !['playing', 'finished'].includes(state.status));

  if (!state) return;
  if (state.status === 'lobby') renderLobby();
  if (state.status === 'playing' || state.status === 'finished') renderGame();
}

function renderLobby() {
  el('roomCode').textContent = state.code;
  const isHost = state.hostId === myId;
  el('startBtn').classList.toggle('hidden', !isHost);
  el('playerList').innerHTML = state.players.map((player, index) => `
    <div class="player-card">
      <span class="player-dot" style="background:${player.color};color:${player.color}"></span>
      <div>
        <strong>${escapeHtml(player.name)}${player.id === myId ? ' (You)' : ''}</strong>
        <small>${player.id === state.hostId ? 'Host' : `Player ${index + 1}`}</small>
      </div>
    </div>
  `).join('');
}

function renderGame() {
  const meIndex = getMyIndex();
  const me = state.players[meIndex];
  const current = state.players[state.turnIndex];
  const myTurn = current?.id === myId && state.status === 'playing';

  el('roundLabel').textContent = state.round;
  el('turnLabel').textContent = current ? `${current.name}'s turn${myTurn ? ' — you' : ''}` : 'Game over';
  el('endTurnBtn').disabled = !myTurn || !!state.pendingBattle;

  if (me) {
    el('statsPanel').innerHTML = [
      ['Money', `$${me.stats.money}`],
      ['Army', me.stats.army],
      ['Efficiency', `${me.stats.efficiency}%`],
      ['Technology', `Lv. ${me.stats.technology}`],
      ['Armor', me.stats.armor],
      ['Territory', `${me.tileCount} tiles`]
    ].map(([name, value]) => `<div class="stat-row"><span>${name}</span><strong>${value}</strong></div>`).join('');
    el('armyCommit').max = Math.max(5, me.stats.army);
    if (+el('armyCommit').value > me.stats.army) el('armyCommit').value = Math.max(5, me.stats.army);
    el('armyCommitValue').textContent = el('armyCommit').value;
  }

  document.querySelectorAll('[data-upgrade]').forEach(button => button.disabled = !myTurn || !!state.pendingBattle);
  renderLog();
  drawMap();

  if (state.pendingBattle?.armorChallenge && state.pendingBattle.attackerId === myId) {
    openArmorModal();
  } else {
    el('armorModal').classList.add('hidden');
  }

  if (state.status === 'finished') {
    const winner = state.players.find(p => p.tileCount > 0 && !p.defeated);
    el('gameOverOverlay').classList.remove('hidden');
    el('gameOverOverlay').innerHTML = `<div>${winner ? `${escapeHtml(winner.name)} wins 👑` : 'Game over'}</div>`;
  } else {
    el('gameOverOverlay').classList.add('hidden');
  }

  if (!myTurn) setSelectionMessage(`Waiting for ${current?.name || 'the next player'}…`);
  else if (!selected) setSelectionMessage('Select your border tile');
}

function renderLog() {
  el('battleLog').innerHTML = [...state.log].reverse().map(entry => `<div class="log-entry">${escapeHtml(entry)}</div>`).join('');
}

function getMyIndex() {
  return state?.players.findIndex(player => player.id === myId) ?? -1;
}

function isMyTurn() {
  return state?.players[state.turnIndex]?.id === myId && state.status === 'playing';
}

function setSelectionMessage(title, error = false) {
  el('selectionTitle').textContent = title;
  el('selectionTitle').style.color = error ? '#ff90a3' : '';
  el('selectionHelp').textContent = selected ? 'Now choose an adjacent enemy tile.' : 'Then choose an adjacent enemy tile.';
}

function canvasToTile(event) {
  const rect = canvas.getBoundingClientRect();
  const x = Math.floor(((event.clientX - rect.left) / rect.width) * canvas.width / TILE);
  const y = Math.floor(((event.clientY - rect.top) / rect.height) * canvas.height / TILE);
  return { x, y };
}

function handleCanvasClick(event) {
  if (!state || !isMyTurn() || state.pendingBattle) return;
  const tile = canvasToTile(event);
  if (!inBounds(tile) || state.map[tile.y][tile.x] === null) return;
  const meIndex = getMyIndex();
  const owner = state.map[tile.y][tile.x];

  if (owner === meIndex) {
    selected = tile;
    setSelectionMessage('Border tile selected');
    drawMap();
    return;
  }

  if (!selected) {
    setSelectionMessage('Select one of your tiles first.', true);
    return;
  }
  if (!isAdjacent(selected, tile)) {
    setSelectionMessage('That enemy tile is not adjacent.', true);
    return;
  }

  const committed = +el('armyCommit').value;
  socket.emit('attack', { from: selected, target: tile, committed }, result => {
    if (!result?.ok) setSelectionMessage(result?.error || 'Attack failed.', true);
    else selected = null;
  });
}

function inBounds(tile) {
  return tile.x >= 0 && tile.x < state.width && tile.y >= 0 && tile.y < state.height;
}

function isAdjacent(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

function drawMap() {
  if (!state?.map?.length) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const waterGradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  waterGradient.addColorStop(0, '#0b2442');
  waterGradient.addColorStop(1, WATER);
  ctx.fillStyle = waterGradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Water texture.
  ctx.globalAlpha = .14;
  ctx.strokeStyle = '#65a7e8';
  ctx.lineWidth = 1;
  for (let y = 12; y < canvas.height; y += 22) {
    ctx.beginPath();
    for (let x = 0; x <= canvas.width; x += 24) {
      const waveY = y + Math.sin((x + y) * .035) * 2.5;
      if (x === 0) ctx.moveTo(x, waveY); else ctx.lineTo(x, waveY);
    }
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  for (let y = 0; y < state.height; y++) {
    for (let x = 0; x < state.width; x++) {
      const owner = state.map[y][x];
      if (owner === null) continue;
      const player = state.players[owner];
      const px = x * TILE;
      const py = y * TILE;

      ctx.fillStyle = player.color;
      ctx.globalAlpha = player.defeated ? .35 : .88;
      ctx.fillRect(px + 1, py + 1, TILE - 2, TILE - 2);
      ctx.globalAlpha = 1;

      // Country texture.
      ctx.fillStyle = 'rgba(255,255,255,.045)';
      ctx.fillRect(px + 5, py + 5, TILE - 10, 4);

      // Borders only where owner changes.
      ctx.strokeStyle = 'rgba(5,8,15,.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + .5, py + .5, TILE - 1, TILE - 1);
      drawCountryBorders(x, y, owner);
    }
  }

  highlightAttackables();

  if (selected) {
    ctx.strokeStyle = '#ffffff';
    ctx.lineWidth = 4;
    ctx.strokeRect(selected.x * TILE + 3, selected.y * TILE + 3, TILE - 6, TILE - 6);
  }

  if (hovered && inBounds(hovered) && state.map[hovered.y][hovered.x] !== null) {
    ctx.fillStyle = 'rgba(255,255,255,.11)';
    ctx.fillRect(hovered.x * TILE + 2, hovered.y * TILE + 2, TILE - 4, TILE - 4);
  }

  drawCountryLabels();
}

function drawCountryBorders(x, y, owner) {
  const px = x * TILE;
  const py = y * TILE;
  ctx.strokeStyle = 'rgba(255,255,255,.38)';
  ctx.lineWidth = 2;
  const checks = [
    [0,-1, px,py, px+TILE,py],
    [1,0, px+TILE,py, px+TILE,py+TILE],
    [0,1, px,py+TILE, px+TILE,py+TILE],
    [-1,0, px,py, px,py+TILE]
  ];
  for (const [dx,dy,x1,y1,x2,y2] of checks) {
    const nx = x + dx;
    const ny = y + dy;
    const neighbor = nx >= 0 && nx < state.width && ny >= 0 && ny < state.height ? state.map[ny][nx] : null;
    if (neighbor !== owner) {
      ctx.beginPath(); ctx.moveTo(x1,y1); ctx.lineTo(x2,y2); ctx.stroke();
    }
  }
}

function highlightAttackables() {
  if (!selected) return;
  const meIndex = getMyIndex();
  const dirs = [[1,0],[-1,0],[0,1],[0,-1]];
  for (const [dx,dy] of dirs) {
    const x = selected.x + dx;
    const y = selected.y + dy;
    if (x < 0 || x >= state.width || y < 0 || y >= state.height) continue;
    const owner = state.map[y][x];
    if (owner !== null && owner !== meIndex) {
      ctx.fillStyle = 'rgba(255,93,122,.25)';
      ctx.fillRect(x*TILE+2, y*TILE+2, TILE-4, TILE-4);
      ctx.strokeStyle = '#ff5d7a';
      ctx.lineWidth = 3;
      ctx.strokeRect(x*TILE+3, y*TILE+3, TILE-6, TILE-6);
    }
  }
}

function drawCountryLabels() {
  state.players.forEach((player, index) => {
    const cells = [];
    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) if (state.map[y][x] === index) cells.push({x,y});
    }
    if (!cells.length) return;
    const cx = cells.reduce((sum,c) => sum+c.x, 0) / cells.length;
    const cy = cells.reduce((sum,c) => sum+c.y, 0) / cells.length;
    ctx.font = '700 13px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(5,8,15,.7)';
    ctx.strokeText(player.name, cx*TILE + TILE/2, cy*TILE + TILE/2);
    ctx.fillStyle = '#fff';
    ctx.fillText(player.name, cx*TILE + TILE/2, cy*TILE + TILE/2);
  });
}

function openArmorModal() {
  el('armorModal').classList.remove('hidden');
  el('armorStatus').textContent = 'Choose one sector. You get one shot.';
  el('armorGrid').innerHTML = Array.from({ length: 6 }, (_, i) => `<button data-cell="${i}">${String.fromCharCode(65+i)}</button>`).join('');
  el('armorGrid').querySelectorAll('button').forEach(button => {
    button.addEventListener('click', () => {
      el('armorStatus').textContent = 'Target locked…';
      el('armorGrid').querySelectorAll('button').forEach(b => b.disabled = true);
      socket.emit('armorPick', { cell: +button.dataset.cell }, result => {
        if (!result?.ok) el('armorStatus').textContent = result?.error || 'Could not resolve armor challenge.';
      });
    });
  });
}

function showBattleResult(result) {
  el('armorModal').classList.add('hidden');
  el('battleModal').classList.remove('hidden');
  el('battleHeadline').textContent = result.attackerWins
    ? `${result.attackerName} destroyed ${result.defenderName}'s armored vehicles`
    : `${result.defenderName} kept their armored tanks and held you off`;
  el('battleRounds').innerHTML = result.rounds.map(round => `
    <div class="battle-round">
      <strong>Round ${round.round}</strong>
      <span>Attacker: -${round.atkLoss}<br>${round.atkRemaining} left</span>
      <span>Defender: -${round.defLoss}<br>${round.defRemaining} left</span>
    </div>
  `).join('') + (result.armorDestroyed ? `<div class="battle-round"><strong>Armor hit</strong><span>${result.armorDestroyed} destroyed</span><span>Before combat</span></div>` : '');
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', "'":'&#039;', '"':'&quot;' }[char]));
}

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
let armorChallengeKey = null;

const TILE = 40;
const WATER = '#07152a';
const TERRAIN_META = {
  plains: { name: 'Plains', defense: 1 },
  forest: { name: 'Forest', defense: 1.14 },
  mountain: { name: 'Mountain', defense: 1.28 },
  bridge: { name: 'Bridge', defense: 1.2 }
};

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
  const previous = state;
  const roomChanged = previous?.code !== next.code;
  const turnChanged = previous && previous.turnIndex !== next.turnIndex;
  const mapChanged = previous && previous.map !== next.map && previous.round !== next.round;

  state = next;
  if (!previous || roomChanged || turnChanged || mapChanged || next.pendingBattle) selected = null;
  renderState();
});

socket.on('battleResult', result => {
  armorChallengeKey = null;
  showBattleResult(result);
});

el('createBtn').addEventListener('click', () => {
  clearHomeError();
  socket.emit('createRoom', { name: el('playerName').value }, result => {
    if (!result?.ok) el('homeError').textContent = result?.error || 'Could not create room.';
  });
});

el('joinBtn').addEventListener('click', () => {
  clearHomeError();
  socket.emit('joinRoom', {
    name: el('playerName').value,
    code: el('roomCodeInput').value
  }, result => {
    el('homeError').textContent = result?.ok ? '' : result?.error || 'Could not join room.';
  });
});

el('playerName').addEventListener('keydown', event => {
  if (event.key === 'Enter') el('createBtn').click();
});

el('roomCodeInput').addEventListener('input', event => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '');
});

el('roomCodeInput').addEventListener('keydown', event => {
  if (event.key === 'Enter') el('joinBtn').click();
});

el('copyCodeBtn').addEventListener('click', async () => {
  if (!state) return;
  try {
    await navigator.clipboard.writeText(state.code);
    el('copyCodeBtn').textContent = 'Copied';
  } catch {
    el('copyCodeBtn').textContent = state.code;
  }
  setTimeout(() => { el('copyCodeBtn').textContent = 'Copy'; }, 1200);
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

el('drawBtn').addEventListener('click', () => {
  if (!state) return;
  const hasVoted = (state.drawVotes || []).includes(myId);
  const prompt = hasVoted
    ? 'Withdraw your vote for a draw?'
    : 'Offer or accept a draw? The game ends only when every active connected player accepts.';
  if (!window.confirm(prompt)) return;

  el('gameActionStatus').textContent = '';
  socket.emit('toggleDrawVote', {}, result => {
    if (!result?.ok) {
      el('gameActionStatus').textContent = result?.error || 'Could not update the draw vote.';
    }
  });
});

el('resignBtn').addEventListener('click', () => {
  if (!window.confirm('Resign from this game? You will be eliminated immediately and this cannot be undone.')) return;

  el('gameActionStatus').textContent = '';
  socket.emit('resignGame', {}, result => {
    if (!result?.ok) {
      el('gameActionStatus').textContent = result?.error || 'Could not resign.';
    }
  });
});

document.querySelectorAll('[data-upgrade]').forEach(button => {
  button.addEventListener('click', () => {
    socket.emit('buyUpgrade', { type: button.dataset.upgrade }, result => {
      if (!result?.ok) setSelectionMessage(result?.error || 'Upgrade failed.', true);
    });
  });
});

el('armyCommit').addEventListener('input', event => {
  el('armyCommitValue').textContent = event.target.value;
  updateOddsPreview(hovered);
});

el('closeBattleBtn').addEventListener('click', () => {
  el('battleModal').classList.add('hidden');
});

el('chatForm').addEventListener('submit', event => {
  event.preventDefault();
  const input = el('chatInput');
  const text = input.value.trim();
  if (!text) return;

  el('chatSendBtn').disabled = true;
  socket.emit('sendChatMessage', { text }, result => {
    el('chatSendBtn').disabled = false;
    if (!result?.ok) {
      el('chatError').textContent = result?.error || 'Could not send message.';
      return;
    }
    input.value = '';
    el('chatError').textContent = '';
    input.focus();
  });
});

canvas.addEventListener('mousemove', event => {
  hovered = canvasToTile(event);
  drawMap();
  updateOddsPreview(hovered);
});

canvas.addEventListener('mouseleave', () => {
  hovered = null;
  drawMap();
  updateOddsPreview(null);
});

canvas.addEventListener('click', handleCanvasClick);

function clearHomeError() {
  el('homeError').textContent = '';
}

function renderState() {
  homeView.classList.toggle('hidden', Boolean(state));
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
  el('turnLabel').textContent = state.status === 'finished'
    ? 'Game over'
    : current
      ? `${current.name}'s turn${myTurn ? ' — you' : ''}${current.connected ? '' : ' — disconnected'}`
      : 'Waiting…';
  el('endTurnBtn').disabled = !myTurn || Boolean(state.pendingBattle);

  const activeDrawPlayers = state.players.filter(player =>
    player.connected && !player.defeated && player.tileCount > 0
  );
  const drawVotes = state.drawVotes || [];
  const hasDrawVote = drawVotes.includes(myId);
  const meIsActive = Boolean(me && !me.defeated && me.tileCount > 0);
  const drawButton = el('drawBtn');
  drawButton.disabled = state.status !== 'playing' || !meIsActive || Boolean(state.pendingBattle) || activeDrawPlayers.length < 2;
  drawButton.textContent = hasDrawVote
    ? `Withdraw draw (${drawVotes.length}/${activeDrawPlayers.length})`
    : drawVotes.length > 0
      ? `Accept draw (${drawVotes.length}/${activeDrawPlayers.length})`
      : 'Offer draw';
  el('resignBtn').disabled = state.status !== 'playing' || !meIsActive || Boolean(state.pendingBattle);

  if (me) {
    renderStats(me);
    renderUpgradeShop(me, myTurn);

    const armySlider = el('armyCommit');
    const availableArmy = Math.max(0, me.stats.army);
    armySlider.max = Math.max(5, availableArmy);
    armySlider.disabled = availableArmy < 5 || !myTurn || Boolean(state.pendingBattle);
    if (+armySlider.value > availableArmy) armySlider.value = Math.max(5, availableArmy);
    if (+armySlider.value < 5) armySlider.value = 5;
    el('armyCommitValue').textContent = armySlider.value;
  }

  renderLog();
  renderChat();
  drawMap();
  updateOddsPreview(hovered);

  if (state.pendingBattle?.armorChallenge && state.pendingBattle.attackerId === myId) {
    const key = `${state.pendingBattle.attackerId}:${state.pendingBattle.target.x},${state.pendingBattle.target.y}`;
    if (armorChallengeKey !== key) {
      armorChallengeKey = key;
      openArmorModal();
    }
  } else {
    armorChallengeKey = null;
    el('armorModal').classList.add('hidden');
  }

  if (state.status === 'finished') {
    const result = state.gameResult;
    const winner = result?.winnerId
      ? state.players.find(player => player.id === result.winnerId)
      : state.players.find(player => player.tileCount > 0 && !player.defeated);
    const headline = result?.type === 'draw'
      ? 'Game drawn 🤝'
      : winner
        ? `${escapeHtml(winner.name)} wins 👑`
        : 'Game over';
    const detail = result?.message ? `<small>${escapeHtml(result.message)}</small>` : '';
    el('gameOverOverlay').classList.remove('hidden');
    el('gameOverOverlay').innerHTML = `<div>${headline}${detail}</div>`;
  } else {
    el('gameOverOverlay').classList.add('hidden');
  }

  if (state.status === 'finished') {
    setSelectionMessage(state.gameResult?.type === 'draw' ? 'The game ended in a draw.' : 'The game is over.');
  } else if (me?.defeated) {
    setSelectionMessage(me.resigned ? 'You resigned. You can still watch and chat.' : 'You have been eliminated. You can still watch and chat.');
  } else if (!myTurn) {
    setSelectionMessage(`Waiting for ${current?.name || 'the next player'}…`);
  } else if (!selected) {
    setSelectionMessage('Select one of your border tiles');
  }
}

function renderStats(me) {
  const moraleState = me.stats.morale >= 105 ? 'High' : me.stats.morale < 80 ? 'Low' : 'Stable';
  el('statsPanel').innerHTML = [
    ['Money', `$${me.stats.money}`],
    ['Army', me.stats.army],
    ['Armor', me.stats.armor],
    ['Technology', `Lv. ${me.stats.technology}`],
    ['Efficiency', `${me.stats.efficiency}%`],
    ['Logistics', `Lv. ${me.stats.logistics}`],
    ['Fortification', `Lv. ${me.stats.fortification}`],
    ['Morale', `${me.stats.morale} · ${moraleState}`],
    ['War exhaustion', `${me.stats.warExhaustion}%`],
    ['Territory', `${me.tileCount} tiles`]
  ].map(([name, value]) => `
    <div class="stat-row"><span>${name}</span><strong>${value}</strong></div>
  `).join('');
}

function renderUpgradeShop(me, myTurn) {
  const labels = {
    army: offer => `+${offer.gain} Army`,
    efficiency: offer => `+${offer.gain} Efficiency`,
    technology: offer => `+${offer.gain} Technology`,
    armor: offer => `+${offer.gain} Armor`,
    logistics: offer => `+${offer.gain} Logistics`,
    fortification: offer => `+${offer.gain} Fortification`
  };

  document.querySelectorAll('[data-upgrade]').forEach(button => {
    const type = button.dataset.upgrade;
    const offer = me.upgradeOffers[type];
    if (!offer) return;

    button.querySelector('.upgrade-name').textContent = labels[type](offer);
    button.querySelector('.upgrade-cost').textContent = `$${offer.cost}`;

    const atMaximum =
      (type === 'efficiency' && me.stats.efficiency >= 120) ||
      (type === 'technology' && me.stats.technology >= 10) ||
      (type === 'logistics' && me.stats.logistics >= 8) ||
      (type === 'fortification' && me.stats.fortification >= 8);

    button.disabled = !myTurn || Boolean(state.pendingBattle) || atMaximum || me.stats.money < offer.cost;
    button.title = atMaximum ? 'Maximum level reached' : '';
  });
}

function renderLog() {
  const container = el('battleLog');
  const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 50;
  container.innerHTML = state.log.map(entry => `<div class="log-entry">${escapeHtml(entry)}</div>`).join('');
  if (wasNearBottom || !container.dataset.rendered) container.scrollTop = container.scrollHeight;
  container.dataset.rendered = 'true';
}

function renderChat() {
  const container = el('chatMessages');
  const wasNearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 70;

  container.innerHTML = (state.chat || []).map(message => {
    const time = new Date(message.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    if (message.type === 'system') {
      return `
        <div class="chat-message system-message">
          <span class="chat-time">${escapeHtml(time)}</span>
          <span>${escapeHtml(message.text)}</span>
        </div>
      `;
    }

    return `
      <div class="chat-message">
        <div class="chat-meta">
          <strong style="color:${safeColor(message.color)}">${escapeHtml(message.name)}</strong>
          <span class="chat-time">${escapeHtml(time)}</span>
        </div>
        <p>${escapeHtml(message.text)}</p>
      </div>
    `;
  }).join('');

  if (wasNearBottom || !container.dataset.rendered) container.scrollTop = container.scrollHeight;
  container.dataset.rendered = 'true';
}

function getMyIndex() {
  return state?.players.findIndex(player => player.id === myId) ?? -1;
}

function isMyTurn() {
  return state?.players[state.turnIndex]?.id === myId && state.status === 'playing';
}

function setSelectionMessage(title, error = false) {
  el('selectionTitle').textContent = title;
  el('selectionTitle').classList.toggle('selection-error', error);
  el('selectionHelp').textContent = selected
    ? 'Hover an adjacent enemy tile to inspect the terrain and estimated odds.'
    : 'Then choose an adjacent enemy tile.';
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
    if (!hasEnemyNeighbor(tile, meIndex)) {
      selected = null;
      setSelectionMessage('Choose a border tile next to an enemy.', true);
      drawMap();
      return;
    }

    selected = tile;
    setSelectionMessage('Border tile selected');
    drawMap();
    updateOddsPreview(hovered);
    return;
  }

  if (!selected) {
    setSelectionMessage('Select one of your border tiles first.', true);
    return;
  }

  if (!isAdjacent(selected, tile)) {
    setSelectionMessage('That enemy tile is not adjacent.', true);
    return;
  }

  const committed = +el('armyCommit').value;
  socket.emit('attack', { from: selected, target: tile, committed }, result => {
    if (!result?.ok) {
      setSelectionMessage(result?.error || 'Attack failed.', true);
      return;
    }
    selected = null;
    updateOddsPreview(null);
  });
}

function hasEnemyNeighbor(tile, playerIndex) {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => {
    const x = tile.x + dx;
    const y = tile.y + dy;
    if (x < 0 || x >= state.width || y < 0 || y >= state.height) return false;
    const owner = state.map[y][x];
    return owner !== null && owner !== playerIndex;
  });
}

function inBounds(tile) {
  return tile && tile.x >= 0 && tile.x < state.width && tile.y >= 0 && tile.y < state.height;
}

function isAdjacent(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

function updateOddsPreview(target) {
  const preview = el('oddsPreview');
  if (!state || !selected || !target || !inBounds(target) || !isAdjacent(selected, target)) {
    preview.innerHTML = '<span>Battle estimate</span><strong>Hover an enemy tile</strong>';
    preview.className = 'odds-preview';
    return;
  }

  const attackerIndex = getMyIndex();
  const defenderIndex = state.map[target.y][target.x];
  if (defenderIndex === null || defenderIndex === attackerIndex) {
    preview.innerHTML = '<span>Battle estimate</span><strong>Hover an enemy tile</strong>';
    preview.className = 'odds-preview';
    return;
  }

  const attacker = state.players[attackerIndex];
  const defender = state.players[defenderIndex];
  const committed = Math.min(+el('armyCommit').value, attacker.stats.army);
  const terrainKey = state.terrain?.[target.y]?.[target.x] || 'plains';
  const terrain = TERRAIN_META[terrainKey] || TERRAIN_META.plains;
  const support = friendlyNeighborCount(selected, attackerIndex);
  const isDefenderCapital = state.capitals?.[defenderIndex]?.x === target.x &&
    state.capitals?.[defenderIndex]?.y === target.y;

  const attackerFactor =
    (1 + attacker.stats.technology * 0.055) *
    (0.72 + attacker.stats.efficiency / 280) *
    (0.84 + attacker.stats.morale / 500) *
    (1 - attacker.stats.warExhaustion * 0.003) *
    clamp(0.86 + support * 0.045 + attacker.stats.logistics * 0.022, 0.86, 1.14) *
    (terrainKey === 'bridge' ? 0.92 : 1);

  const defenderForce = Math.min(
    defender.stats.army,
    Math.max(1, Math.round(defender.stats.army * clamp(
      0.16 + defender.tileCount / 900 + defender.stats.logistics * 0.012,
      0.17,
      0.34
    )))
  );
  const defenderFactor =
    (1 + defender.stats.technology * 0.055) *
    (0.72 + defender.stats.efficiency / 280) *
    (0.84 + defender.stats.morale / 500) *
    (1 - defender.stats.warExhaustion * 0.003) *
    terrain.defense *
    1.08 *
    (1 + Math.min(0.3, defender.stats.fortification * 0.045)) *
    (1 + Math.min(0.32, Math.sqrt(Math.max(0, defender.stats.armor)) * 0.075)) *
    (isDefenderCapital ? 1.18 : 1);

  const attackScore = committed * attackerFactor;
  const defenseScore = defenderForce * defenderFactor;
  const odds = Math.round(clamp((attackScore / Math.max(1, attackScore + defenseScore)) * 100, 12, 88));
  const rating = odds >= 62 ? 'Favorable' : odds >= 45 ? 'Risky' : 'Unfavorable';

  preview.innerHTML = `
    <span>${escapeHtml(terrain.name)}${isDefenderCapital ? ' · Capital' : ''}</span>
    <strong>${odds}% · ${rating}</strong>
  `;
  preview.className = `odds-preview ${odds >= 62 ? 'good' : odds >= 45 ? 'risky' : 'bad'}`;
}

function friendlyNeighborCount(tile, playerIndex) {
  return [[1, 0], [-1, 0], [0, 1], [0, -1]].reduce((count, [dx, dy]) => {
    const x = tile.x + dx;
    const y = tile.y + dy;
    if (x < 0 || x >= state.width || y < 0 || y >= state.height) return count;
    return count + (state.map[y][x] === playerIndex ? 1 : 0);
  }, 0);
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function drawMap() {
  if (!state?.map?.length) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const waterGradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  waterGradient.addColorStop(0, '#0b2442');
  waterGradient.addColorStop(1, WATER);
  ctx.fillStyle = waterGradient;
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.globalAlpha = 0.14;
  ctx.strokeStyle = '#65a7e8';
  ctx.lineWidth = 1;
  for (let y = 12; y < canvas.height; y += 22) {
    ctx.beginPath();
    for (let x = 0; x <= canvas.width; x += 24) {
      const waveY = y + Math.sin((x + y) * 0.035) * 2.5;
      if (x === 0) ctx.moveTo(x, waveY);
      else ctx.lineTo(x, waveY);
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
      const terrain = state.terrain?.[y]?.[x] || 'plains';

      ctx.fillStyle = player.color;
      ctx.globalAlpha = player.defeated ? 0.35 : 0.88;
      ctx.fillRect(px + 1, py + 1, TILE - 2, TILE - 2);
      ctx.globalAlpha = 1;

      drawTerrainTexture(px, py, terrain);

      ctx.strokeStyle = 'rgba(5,8,15,.45)';
      ctx.lineWidth = 1;
      ctx.strokeRect(px + 0.5, py + 0.5, TILE - 1, TILE - 1);
      drawCountryBorders(x, y, owner);
    }
  }

  drawCapitals();
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

function drawTerrainTexture(px, py, terrain) {
  if (terrain === 'forest') {
    ctx.fillStyle = 'rgba(6,35,24,.35)';
    for (const [ox, oy] of [[10, 13], [24, 10], [30, 26], [15, 29]]) {
      ctx.beginPath();
      ctx.arc(px + ox, py + oy, 3.2, 0, Math.PI * 2);
      ctx.fill();
    }
  } else if (terrain === 'mountain') {
    ctx.fillStyle = 'rgba(20,24,34,.38)';
    for (const [ox, oy] of [[7, 29], [20, 25]]) {
      ctx.beginPath();
      ctx.moveTo(px + ox, py + oy);
      ctx.lineTo(px + ox + 8, py + oy - 14);
      ctx.lineTo(px + ox + 16, py + oy);
      ctx.closePath();
      ctx.fill();
    }
  } else if (terrain === 'bridge') {
    ctx.fillStyle = 'rgba(238,196,126,.32)';
    ctx.fillRect(px + 4, py + 8, TILE - 8, TILE - 16);
    ctx.strokeStyle = 'rgba(52,31,12,.38)';
    ctx.lineWidth = 2;
    for (let x = 8; x < TILE - 4; x += 7) {
      ctx.beginPath();
      ctx.moveTo(px + x, py + 9);
      ctx.lineTo(px + x, py + TILE - 9);
      ctx.stroke();
    }
  } else {
    ctx.fillStyle = 'rgba(255,255,255,.045)';
    ctx.fillRect(px + 5, py + 5, TILE - 10, 4);
  }
}

function drawCountryBorders(x, y, owner) {
  const px = x * TILE;
  const py = y * TILE;
  ctx.strokeStyle = 'rgba(255,255,255,.38)';
  ctx.lineWidth = 2;
  const checks = [
    [0, -1, px, py, px + TILE, py],
    [1, 0, px + TILE, py, px + TILE, py + TILE],
    [0, 1, px, py + TILE, px + TILE, py + TILE],
    [-1, 0, px, py, px, py + TILE]
  ];

  for (const [dx, dy, x1, y1, x2, y2] of checks) {
    const nx = x + dx;
    const ny = y + dy;
    const neighbor = nx >= 0 && nx < state.width && ny >= 0 && ny < state.height
      ? state.map[ny][nx]
      : null;
    if (neighbor !== owner) {
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
    }
  }
}

function drawCapitals() {
  (state.capitals || []).forEach((capital, originalOwner) => {
    if (!capital || state.map[capital.y]?.[capital.x] === null) return;
    const x = capital.x * TILE + TILE / 2;
    const y = capital.y * TILE + TILE / 2;
    const currentOwner = state.map[capital.y][capital.x];

    ctx.save();
    ctx.translate(x, y);
    ctx.beginPath();
    for (let point = 0; point < 10; point++) {
      const radius = point % 2 === 0 ? 8 : 3.8;
      const angle = -Math.PI / 2 + point * Math.PI / 5;
      const px = Math.cos(angle) * radius;
      const py = Math.sin(angle) * radius;
      if (point === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    }
    ctx.closePath();
    ctx.fillStyle = currentOwner === originalOwner ? '#fff4b0' : '#ffffff';
    ctx.strokeStyle = 'rgba(5,8,15,.8)';
    ctx.lineWidth = 3;
    ctx.stroke();
    ctx.fill();
    ctx.restore();
  });
}

function highlightAttackables() {
  if (!selected) return;
  const meIndex = getMyIndex();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const x = selected.x + dx;
    const y = selected.y + dy;
    if (x < 0 || x >= state.width || y < 0 || y >= state.height) continue;
    const owner = state.map[y][x];
    if (owner !== null && owner !== meIndex) {
      ctx.fillStyle = 'rgba(255,93,122,.25)';
      ctx.fillRect(x * TILE + 2, y * TILE + 2, TILE - 4, TILE - 4);
      ctx.strokeStyle = '#ff5d7a';
      ctx.lineWidth = 3;
      ctx.strokeRect(x * TILE + 3, y * TILE + 3, TILE - 6, TILE - 6);
    }
  }
}

function drawCountryLabels() {
  state.players.forEach((player, index) => {
    const cells = [];
    for (let y = 0; y < state.height; y++) {
      for (let x = 0; x < state.width; x++) {
        if (state.map[y][x] === index) cells.push({ x, y });
      }
    }
    if (!cells.length) return;

    const cx = cells.reduce((sum, cell) => sum + cell.x, 0) / cells.length;
    const cy = cells.reduce((sum, cell) => sum + cell.y, 0) / cells.length;
    ctx.font = '700 13px system-ui';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 4;
    ctx.strokeStyle = 'rgba(5,8,15,.7)';
    ctx.strokeText(player.name, cx * TILE + TILE / 2, cy * TILE + TILE / 2);
    ctx.fillStyle = '#fff';
    ctx.fillText(player.name, cx * TILE + TILE / 2, cy * TILE + TILE / 2);
  });
}

function openArmorModal() {
  el('armorModal').classList.remove('hidden');
  el('armorStatus').textContent = 'Choose one sector. A direct hit destroys 40–60% of the defender’s armor.';
  el('armorGrid').innerHTML = Array.from({ length: 6 }, (_, index) => `
    <button data-cell="${index}">${String.fromCharCode(65 + index)}</button>
  `).join('');

  el('armorGrid').querySelectorAll('button').forEach(button => {
    button.addEventListener('click', () => {
      el('armorStatus').textContent = 'Target locked…';
      el('armorGrid').querySelectorAll('button').forEach(candidate => { candidate.disabled = true; });
      socket.emit('armorPick', { cell: +button.dataset.cell }, result => {
        if (!result?.ok) {
          el('armorStatus').textContent = result?.error || 'Could not resolve armor challenge.';
          el('armorGrid').querySelectorAll('button').forEach(candidate => { candidate.disabled = false; });
        }
      });
    });
  });
}

function showBattleResult(result) {
  el('armorModal').classList.add('hidden');
  el('battleModal').classList.remove('hidden');
  el('battleHeadline').textContent = `${result.outcome}: ${result.attackerName} vs ${result.defenderName}`;

  const summary = `
    <div class="battle-summary ${result.attackerWins ? 'victory' : 'defeat'}">
      <strong>${result.attackerWins ? 'Territory captured' : 'Defender held the territory'}</strong>
      <span>${escapeHtml(result.terrainName)} · Pre-battle estimate ${result.estimatedOdds}%</span>
    </div>
    <div class="battle-metrics">
      <div><span>Attacker losses</span><strong>${result.attackerLosses}</strong></div>
      <div><span>Defender losses</span><strong>${result.defenderLosses}</strong></div>
      <div><span>Armor destroyed</span><strong>${result.armorDestroyed}</strong></div>
      <div><span>Occupation losses</span><strong>${result.occupationLoss}</strong></div>
    </div>
  `;

  const rounds = result.rounds.map(round => `
    <div class="battle-round">
      <strong>Round ${round.round}</strong>
      <span>Attacker: -${round.atkLoss}<br>${round.atkRemaining} left</span>
      <span>Defender: -${round.defLoss}<br>${round.defRemaining} left</span>
    </div>
  `).join('');

  const modifiers = `
    <div class="modifier-row">
      <span>Supply ${result.modifiers.attackerSupply}%</span>
      <span>Terrain defense ${result.modifiers.terrainDefense}%</span>
      <span>Fortification ${result.modifiers.fortification}%</span>
      <span>Armor defense ${result.modifiers.armorDefense}%</span>
    </div>
  `;

  el('battleRounds').innerHTML = summary + rounds + modifiers +
    (result.capturedCapital ? '<div class="capital-captured">Capital captured: bonus loot and morale gained.</div>' : '');
}

function safeColor(value) {
  return /^#[0-9a-f]{6}$/i.test(String(value || '')) ? value : '#ffffff';
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    "'": '&#039;',
    '"': '&quot;'
  }[char]));
}

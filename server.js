const path = require('path');
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const COLORS = ['#4f8cff', '#ff5d7a', '#40c98b', '#f6b94b', '#a97cff', '#35c2d6'];
const WIDTH = 24;
const HEIGHT = 16;

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function makeRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 7).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function sanitizeName(name) {
  const cleaned = String(name || 'Player').replace(/[<>]/g, '').trim().slice(0, 18);
  return cleaned || 'Player';
}

function createRoom(hostSocket, hostName) {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: hostSocket.id,
    status: 'lobby',
    players: [],
    map: [],
    width: WIDTH,
    height: HEIGHT,
    turnIndex: 0,
    round: 1,
    pendingBattle: null,
    log: []
  };
  room.players.push(makePlayer(hostSocket.id, hostName, 0));
  rooms.set(code, room);
  return room;
}

function makePlayer(socketId, name, index) {
  return {
    id: socketId,
    name: sanitizeName(name),
    color: COLORS[index % COLORS.length],
    connected: true,
    defeated: false,
    stats: {
      money: randomInt(500, 850),
      army: randomInt(95, 145),
      efficiency: randomInt(70, 100),
      technology: randomInt(1, 5),
      armor: randomInt(1, 5)
    }
  };
}

function emptyGrid() {
  return Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(null));
}

function carveEllipse(grid, cx, cy, rx, ry) {
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      const nx = (x - cx) / rx;
      const ny = (y - cy) / ry;
      const wobble = Math.sin(x * 1.17 + y * 0.71) * 0.08 + Math.cos(y * 1.41) * 0.05;
      if (nx * nx + ny * ny < 1 + wobble) grid[y][x] = -1;
    }
  }
}

function carveBridge(grid, x1, y1, x2, y2) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const x = Math.round(x1 + (x2 - x1) * t);
    const y = Math.round(y1 + (y2 - y1) * t);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const px = x + ox;
        const py = y + oy;
        if (px >= 0 && px < WIDTH && py >= 0 && py < HEIGHT && Math.abs(ox) + Math.abs(oy) <= 1) {
          grid[py][px] = -1;
        }
      }
    }
  }
}

function generateLandMask() {
  const grid = emptyGrid();
  const twoIslands = Math.random() < 0.38;

  if (!twoIslands) {
    carveEllipse(grid, randomInt(10, 13), randomInt(7, 9), randomInt(9, 11), randomInt(6, 7));
    carveEllipse(grid, randomInt(8, 16), randomInt(5, 11), randomInt(4, 6), randomInt(3, 5));
  } else {
    const left = { x: randomInt(6, 8), y: randomInt(6, 9) };
    const right = { x: randomInt(16, 18), y: randomInt(6, 9) };
    carveEllipse(grid, left.x, left.y, randomInt(5, 7), randomInt(5, 6));
    carveEllipse(grid, right.x, right.y, randomInt(5, 7), randomInt(5, 6));
    carveBridge(grid, left.x + 4, left.y, right.x - 4, right.y);
  }

  // Smooth isolated notches and remove tiny spikes.
  const copy = grid.map(row => row.slice());
  for (let y = 1; y < HEIGHT - 1; y++) {
    for (let x = 1; x < WIDTH - 1; x++) {
      const neighbors = [[1,0],[-1,0],[0,1],[0,-1]].filter(([dx,dy]) => copy[y+dy][x+dx] !== null).length;
      if (copy[y][x] === null && neighbors >= 3) grid[y][x] = -1;
      if (copy[y][x] !== null && neighbors <= 1) grid[y][x] = null;
    }
  }
  return grid;
}

function landCells(grid) {
  const cells = [];
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (grid[y][x] !== null) cells.push({ x, y });
    }
  }
  return cells;
}

function manhattan(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

function pickSpreadSeeds(cells, count) {
  const seeds = [cells[randomInt(0, cells.length - 1)]];
  while (seeds.length < count) {
    let best = null;
    let bestDistance = -1;
    for (const cell of cells) {
      const minDistance = Math.min(...seeds.map(seed => manhattan(cell, seed)));
      if (minDistance > bestDistance) {
        bestDistance = minDistance;
        best = cell;
      }
    }
    seeds.push(best);
  }
  return seeds;
}

function partitionMap(mask, playerCount) {
  const cells = landCells(mask);
  const seeds = pickSpreadSeeds(cells, playerCount);
  const owner = Array.from({ length: HEIGHT }, () => Array(WIDTH).fill(null));
  const queues = seeds.map((seed, index) => [{ ...seed, owner: index }]);
  seeds.forEach((seed, index) => { owner[seed.y][seed.x] = index; });
  let active = true;

  while (active) {
    active = false;
    for (let i = 0; i < queues.length; i++) {
      const current = queues[i].shift();
      if (!current) continue;
      active = true;
      const dirs = [[1,0],[-1,0],[0,1],[0,-1]].sort(() => Math.random() - 0.5);
      for (const [dx, dy] of dirs) {
        const nx = current.x + dx;
        const ny = current.y + dy;
        if (nx < 0 || nx >= WIDTH || ny < 0 || ny >= HEIGHT) continue;
        if (mask[ny][nx] === null || owner[ny][nx] !== null) continue;
        owner[ny][nx] = i;
        queues[i].push({ x: nx, y: ny, owner: i });
      }
    }
  }

  // Any unclaimed cells are assigned to the nearest seed.
  for (const cell of cells) {
    if (owner[cell.y][cell.x] === null) {
      let nearest = 0;
      let dist = Infinity;
      seeds.forEach((seed, i) => {
        const d = manhattan(cell, seed);
        if (d < dist) { dist = d; nearest = i; }
      });
      owner[cell.y][cell.x] = nearest;
    }
  }

  return owner;
}

function initializeGame(room) {
  const mask = generateLandMask();
  room.map = partitionMap(mask, room.players.length);
  room.status = 'playing';
  room.turnIndex = 0;
  room.round = 1;
  room.pendingBattle = null;
  room.log = [`Round 1 begins. ${room.players[0].name} moves first.`];
}

function countTiles(room, playerIndex) {
  let count = 0;
  room.map.forEach(row => row.forEach(owner => { if (owner === playerIndex) count++; }));
  return count;
}

function currentPlayer(room) {
  return room.players[room.turnIndex];
}

function isAdjacent(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

function validTile(room, tile) {
  return tile && Number.isInteger(tile.x) && Number.isInteger(tile.y) && tile.x >= 0 && tile.x < WIDTH && tile.y >= 0 && tile.y < HEIGHT;
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    players: room.players.map((p, index) => ({ ...p, tileCount: room.status === 'playing' ? countTiles(room, index) : 0 })),
    map: room.map,
    width: room.width,
    height: room.height,
    turnIndex: room.turnIndex,
    round: room.round,
    pendingBattle: room.pendingBattle ? {
      attackerId: room.pendingBattle.attackerId,
      defenderIndex: room.pendingBattle.defenderIndex,
      target: room.pendingBattle.target,
      armorChallenge: room.pendingBattle.armorChallenge,
      armorResolved: room.pendingBattle.armorResolved
    } : null,
    log: room.log.slice(-12)
  };
}

function emitRoom(room) {
  io.to(room.code).emit('roomState', publicRoom(room));
}

function addLog(room, text) {
  room.log.push(text);
  if (room.log.length > 80) room.log.shift();
}

function nextTurn(room) {
  if (room.status !== 'playing') return;
  room.pendingBattle = null;
  const living = room.players.map((p, i) => ({ p, i })).filter(({ p, i }) => !p.defeated && countTiles(room, i) > 0);
  if (living.length <= 1) {
    room.status = 'finished';
    const winner = living[0];
    addLog(room, winner ? `${winner.p.name} wins the game!` : 'The game ends with no winner.');
    return;
  }

  let wrapped = false;
  for (let attempts = 0; attempts < room.players.length; attempts++) {
    room.turnIndex++;
    if (room.turnIndex >= room.players.length) {
      room.turnIndex = 0;
      wrapped = true;
    }
    const p = room.players[room.turnIndex];
    if (!p.defeated && countTiles(room, room.turnIndex) > 0) break;
  }

  if (wrapped) {
    room.round++;
    room.players.forEach((p, i) => {
      if (p.defeated) return;
      const tiles = countTiles(room, i);
      const income = Math.round(tiles * (4 + p.stats.efficiency / 30));
      const recruits = Math.max(4, Math.round(tiles * (0.12 + p.stats.technology * 0.012)));
      p.stats.money += income;
      p.stats.army += recruits;
    });
    addLog(room, `Round ${room.round} begins. Income and recruits have been added.`);
  }
}

function resolveBattle(room, battle, selectedCell) {
  const attacker = room.players[battle.attackerIndex];
  const defender = room.players[battle.defenderIndex];
  let armorDestroyed = 0;

  if (battle.armorChallenge) {
    if (selectedCell === battle.armorCell) {
      armorDestroyed = Math.max(1, Math.ceil(defender.stats.armor * (0.25 + Math.random() * 0.25)));
      defender.stats.armor = Math.max(0, defender.stats.armor - armorDestroyed);
      addLog(room, `${attacker.name} found the armored column and destroyed ${armorDestroyed} vehicle${armorDestroyed === 1 ? '' : 's'}.`);
    } else {
      addLog(room, `${attacker.name} missed the armored column. The vehicles remain active.`);
    }
  }

  const committed = clamp(battle.committed, 1, attacker.stats.army);
  attacker.stats.army -= committed;

  const atkTech = 1 + attacker.stats.technology * 0.07;
  const defTech = 1 + defender.stats.technology * 0.07;
  const atkEff = 0.75 + attacker.stats.efficiency / 200;
  const defEff = 0.75 + defender.stats.efficiency / 200;
  const armorBonus = 1 + defender.stats.armor * 0.055;

  let atkForce = committed;
  let defForce = Math.max(8, Math.round(defender.stats.army * Math.min(0.45, 0.14 + countTiles(room, battle.defenderIndex) / 500)));
  defForce = Math.min(defForce, defender.stats.army);
  defender.stats.army -= defForce;

  const rounds = [];
  for (let r = 1; r <= 3 && atkForce > 0 && defForce > 0; r++) {
    const atkRoll = 0.88 + Math.random() * 0.24;
    const defRoll = 0.88 + Math.random() * 0.24;
    const atkPower = atkForce * atkTech * atkEff * atkRoll;
    const defPower = defForce * defTech * defEff * armorBonus * defRoll;

    const atkLoss = Math.max(1, Math.round((defPower / Math.max(atkPower + defPower, 1)) * defForce * 0.65));
    const defLoss = Math.max(1, Math.round((atkPower / Math.max(atkPower + defPower, 1)) * atkForce * 0.72));
    atkForce = Math.max(0, atkForce - atkLoss);
    defForce = Math.max(0, defForce - defLoss);
    rounds.push({ round: r, atkLoss, defLoss, atkRemaining: atkForce, defRemaining: defForce });
  }

  const attackerWins = atkForce > defForce;
  if (attackerWins) {
    room.map[battle.target.y][battle.target.x] = battle.attackerIndex;
    const occupationLoss = Math.ceil(atkForce * 0.35);
    const survivors = Math.max(0, atkForce - occupationLoss);
    attacker.stats.army += survivors;
    defender.stats.army += Math.max(0, defForce);
    attacker.stats.money += 45 + defender.stats.technology * 10;
    defender.stats.money = Math.max(0, defender.stats.money - 35);
    addLog(room, `${attacker.name} captured a tile from ${defender.name}. ${survivors} troops returned after occupation losses.`);
  } else {
    attacker.stats.army += Math.max(0, atkForce);
    defender.stats.army += Math.max(0, defForce);
    addLog(room, `${defender.name} defended successfully against ${attacker.name}.`);
  }

  if (countTiles(room, battle.defenderIndex) === 0) {
    defender.defeated = true;
    addLog(room, `${defender.name} has been eliminated.`);
  }

  room.pendingBattle = null;
  nextTurn(room);
  io.to(room.code).emit('battleResult', {
    attackerWins,
    armorDestroyed,
    rounds,
    attackerName: attacker.name,
    defenderName: defender.name
  });
  emitRoom(room);
}

function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code || !rooms.has(code)) return;
  const room = rooms.get(code);
  const player = room.players.find(p => p.id === socket.id);
  if (player) player.connected = false;

  if (room.status === 'lobby') {
    room.players = room.players.filter(p => p.id !== socket.id);
    room.players.forEach((p, i) => { p.color = COLORS[i]; });
    if (room.players.length === 0) {
      rooms.delete(code);
      return;
    }
    if (room.hostId === socket.id) room.hostId = room.players[0].id;
  } else if (player) {
    addLog(room, `${player.name} disconnected.`);
  }
  emitRoom(room);
}

io.on('connection', socket => {
  socket.on('createRoom', ({ name }, callback) => {
    leaveRoom(socket);
    const room = createRoom(socket, name);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    callback?.({ ok: true, code: room.code });
    emitRoom(room);
  });

  socket.on('joinRoom', ({ code, name }, callback) => {
    leaveRoom(socket);
    const normalized = String(code || '').trim().toUpperCase();
    const room = rooms.get(normalized);
    if (!room) return callback?.({ ok: false, error: 'Room not found.' });
    if (room.status !== 'lobby') return callback?.({ ok: false, error: 'This game has already started.' });
    if (room.players.length >= 6) return callback?.({ ok: false, error: 'Room is full.' });

    room.players.push(makePlayer(socket.id, name, room.players.length));
    socket.join(room.code);
    socket.data.roomCode = room.code;
    callback?.({ ok: true, code: room.code });
    emitRoom(room);
  });

  socket.on('startGame', (_, callback) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return callback?.({ ok: false, error: 'Only the host can start.' });
    if (room.players.length < 2) return callback?.({ ok: false, error: 'At least 2 players are required.' });
    initializeGame(room);
    emitRoom(room);
    callback?.({ ok: true });
  });

  socket.on('attack', ({ from, target, committed }, callback) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return;
    const attackerIndex = room.players.findIndex(p => p.id === socket.id);
    if (attackerIndex !== room.turnIndex) return callback?.({ ok: false, error: 'It is not your turn.' });
    if (room.pendingBattle) return callback?.({ ok: false, error: 'Finish the current battle first.' });
    if (!validTile(room, from) || !validTile(room, target)) return callback?.({ ok: false, error: 'Invalid tile.' });
    if (!isAdjacent(from, target)) return callback?.({ ok: false, error: 'You can only attack an adjacent tile.' });
    if (room.map[from.y][from.x] !== attackerIndex) return callback?.({ ok: false, error: 'Choose one of your own border tiles.' });
    const defenderIndex = room.map[target.y][target.x];
    if (defenderIndex === null || defenderIndex === attackerIndex) return callback?.({ ok: false, error: 'Choose an adjacent enemy tile.' });

    const attacker = room.players[attackerIndex];
    const amount = clamp(Math.floor(Number(committed) || 0), 1, attacker.stats.army);
    if (amount < 5) return callback?.({ ok: false, error: 'Commit at least 5 troops.' });

    const defender = room.players[defenderIndex];
    const armorChallenge = defender.stats.armor > 0;
    room.pendingBattle = {
      attackerId: socket.id,
      attackerIndex,
      defenderIndex,
      from,
      target,
      committed: amount,
      armorChallenge,
      armorCell: armorChallenge ? randomInt(0, 5) : null,
      armorResolved: !armorChallenge
    };

    addLog(room, `${attacker.name} attacks ${defender.name} with ${amount} troops.`);
    if (!armorChallenge) resolveBattle(room, room.pendingBattle, null);
    else emitRoom(room);
    callback?.({ ok: true, armorChallenge });
  });

  socket.on('armorPick', ({ cell }, callback) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || !room.pendingBattle) return;
    const battle = room.pendingBattle;
    if (battle.attackerId !== socket.id) return callback?.({ ok: false, error: 'Only the attacker can choose.' });
    const pick = clamp(Math.floor(Number(cell)), 0, 5);
    resolveBattle(room, battle, pick);
    callback?.({ ok: true });
  });

  socket.on('endTurn', (_, callback) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return;
    if (currentPlayer(room)?.id !== socket.id) return callback?.({ ok: false, error: 'It is not your turn.' });
    if (room.pendingBattle) return callback?.({ ok: false, error: 'Resolve the battle first.' });
    addLog(room, `${currentPlayer(room).name} ended their turn.`);
    nextTurn(room);
    emitRoom(room);
    callback?.({ ok: true });
  });

  socket.on('buyUpgrade', ({ type }, callback) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return;
    const playerIndex = room.players.findIndex(p => p.id === socket.id);
    if (playerIndex !== room.turnIndex) return callback?.({ ok: false, error: 'Buy upgrades on your turn.' });
    const player = room.players[playerIndex];
    const costs = { army: 120, efficiency: 180, technology: 250, armor: 220 };
    if (!costs[type]) return;
    if (player.stats.money < costs[type]) return callback?.({ ok: false, error: 'Not enough money.' });
    player.stats.money -= costs[type];
    if (type === 'army') player.stats.army += 25;
    if (type === 'efficiency') player.stats.efficiency = Math.min(130, player.stats.efficiency + 6);
    if (type === 'technology') player.stats.technology = Math.min(10, player.stats.technology + 1);
    if (type === 'armor') player.stats.armor += 1;
    addLog(room, `${player.name} purchased a ${type} upgrade.`);
    emitRoom(room);
    callback?.({ ok: true });
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});

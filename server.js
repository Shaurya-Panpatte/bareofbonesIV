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
const MAX_CHAT_MESSAGES = 100;

const BASE_STARTING_STATS = {
  money: 680,
  army: 116,
  efficiency: 86,
  technology: 2,
  armor: 3,
  logistics: 1,
  fortification: 1,
  morale: 100,
  warExhaustion: 0
};

const STARTING_DOCTRINES = [
  {
    id: 'mass-mobilization',
    name: 'Mass Mobilization',
    summary: 'A large opening army, paid for with weaker industry and lighter armor.',
    stats: { money: 620, army: 142, efficiency: 80, technology: 2, armor: 2, logistics: 1, fortification: 1 },
    effects: ['+26 starting troops', '−6 efficiency', '−1 armor', '−$60 starting money']
  },
  {
    id: 'industrial-engine',
    name: 'Industrial Engine',
    summary: 'Superior efficiency and starting money, but fewer troops and armored vehicles.',
    stats: { money: 760, army: 108, efficiency: 100, technology: 2, armor: 2, logistics: 1, fortification: 1 },
    effects: ['+14 efficiency', '+$80 starting money', '−8 starting troops', '−1 armor']
  },
  {
    id: 'logistics-network',
    name: 'Logistics Network',
    summary: 'Stronger supply, attack coordination, recruitment, and local defensive response.',
    stats: { money: 680, army: 108, efficiency: 84, technology: 2, armor: 2, logistics: 3, fortification: 1 },
    effects: ['Logistics starts at level 3', '−8 starting troops', '−2 efficiency', '−1 armor']
  },
  {
    id: 'fortress-state',
    name: 'Fortress State',
    summary: 'Powerful permanent defenses in exchange for a smaller, less efficient field army.',
    stats: { money: 650, army: 104, efficiency: 82, technology: 2, armor: 3, logistics: 1, fortification: 3 },
    effects: ['Fortification starts at level 3', '−12 starting troops', '−4 efficiency', '−$30 starting money']
  },
  {
    id: 'armored-command',
    name: 'Armored Command',
    summary: 'Heavy armor sharply improves defense and reduces casualties until intercepted.',
    stats: { money: 640, army: 108, efficiency: 82, technology: 2, armor: 6, logistics: 1, fortification: 1 },
    effects: ['6 starting armor', '−8 starting troops', '−4 efficiency', '−$40 starting money']
  },
  {
    id: 'technical-directorate',
    name: 'Technical Directorate',
    summary: 'Advanced technology and improved logistics create a flexible combined-arms force.',
    stats: { money: 650, army: 106, efficiency: 88, technology: 3, armor: 2, logistics: 2, fortification: 1 },
    effects: ['Technology starts at level 3', 'Logistics starts at level 2', '+2 efficiency', '−10 starting troops']
  }
];

const TERRAIN = {
  plains: { name: 'Plains', defense: 1, occupationLoss: 0.1 },
  forest: { name: 'Forest', defense: 1.06, occupationLoss: 0.13 },
  mountain: { name: 'Mountain', defense: 1.12, occupationLoss: 0.17 },
  bridge: { name: 'Bridge', defense: 1.08, occupationLoss: 0.15 }
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomBetween(min, max) {
  return min + Math.random() * (max - min);
}

function makeRoomCode() {
  let code;
  do {
    code = Math.random().toString(36).slice(2, 7).toUpperCase();
  } while (rooms.has(code));
  return code;
}

function sanitizeName(name) {
  const cleaned = String(name || 'Player')
    .replace(/[<>\r\n\t]/g, '')
    .trim()
    .slice(0, 18);
  return cleaned || 'Player';
}

function sanitizeChat(text) {
  return String(text || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

function createRoom(hostSocket, hostName) {
  const code = makeRoomCode();
  const room = {
    code,
    hostId: hostSocket.id,
    status: 'lobby',
    players: [],
    map: [],
    terrain: [],
    capitals: [],
    width: WIDTH,
    height: HEIGHT,
    turnIndex: 0,
    round: 1,
    pendingBattle: null,
    log: [],
    chat: [],
    drawVotes: [],
    gameResult: null,
    startingBalance: null
  };

  room.players.push(makePlayer(hostSocket.id, hostName, 0));
  addSystemMessage(room, `${room.players[0].name} created the room.`);
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
    resigned: false,
    doctrine: null,
    stats: { ...BASE_STARTING_STATS },
    upgradeLevels: {
      army: 0,
      efficiency: 0,
      technology: 0,
      armor: 0,
      logistics: 0,
      fortification: 0
    }
  };
}

function shuffled(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = randomInt(0, i);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function assignStartingDoctrines(room) {
  const available = shuffled(STARTING_DOCTRINES);
  room.players.forEach((player, index) => {
    const doctrine = available[index];
    player.doctrine = {
      id: doctrine.id,
      name: doctrine.name,
      summary: doctrine.summary,
      effects: [...doctrine.effects]
    };
    player.stats = {
      ...BASE_STARTING_STATS,
      ...doctrine.stats,
      morale: 100,
      warExhaustion: 0
    };
    player.upgradeLevels = {
      army: 0,
      efficiency: 0,
      technology: 0,
      armor: 0,
      logistics: 0,
      fortification: 0
    };
  });
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

function carveBridge(grid, x1, y1, x2, y2, bridgeCells) {
  const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1));
  for (let i = 0; i <= steps; i++) {
    const t = steps === 0 ? 0 : i / steps;
    const x = Math.round(x1 + (x2 - x1) * t);
    const y = Math.round(y1 + (y2 - y1) * t);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const px = x + ox;
        const py = y + oy;
        if (
          px >= 0 && px < WIDTH && py >= 0 && py < HEIGHT &&
          Math.abs(ox) + Math.abs(oy) <= 1
        ) {
          grid[py][px] = -1;
          bridgeCells.add(`${px},${py}`);
        }
      }
    }
  }
}

function generateLandMask() {
  const grid = emptyGrid();
  const bridgeCells = new Set();
  const twoIslands = Math.random() < 0.38;

  if (!twoIslands) {
    carveEllipse(grid, randomInt(10, 13), randomInt(7, 9), randomInt(9, 11), randomInt(6, 7));
    carveEllipse(grid, randomInt(8, 16), randomInt(5, 11), randomInt(4, 6), randomInt(3, 5));
  } else {
    const left = { x: randomInt(6, 8), y: randomInt(6, 9) };
    const right = { x: randomInt(16, 18), y: randomInt(6, 9) };
    carveEllipse(grid, left.x, left.y, randomInt(5, 7), randomInt(5, 6));
    carveEllipse(grid, right.x, right.y, randomInt(5, 7), randomInt(5, 6));
    carveBridge(grid, left.x + 4, left.y, right.x - 4, right.y, bridgeCells);
  }

  const copy = grid.map(row => row.slice());
  for (let y = 1; y < HEIGHT - 1; y++) {
    for (let x = 1; x < WIDTH - 1; x++) {
      const neighbors = [[1, 0], [-1, 0], [0, 1], [0, -1]]
        .filter(([dx, dy]) => copy[y + dy][x + dx] !== null).length;
      if (copy[y][x] === null && neighbors >= 3) grid[y][x] = -1;
      if (copy[y][x] !== null && neighbors <= 1 && !bridgeCells.has(`${x},${y}`)) grid[y][x] = null;
    }
  }

  return { grid, bridgeCells };
}

function generateTerrain(mask, bridgeCells) {
  const terrain = emptyGrid();
  for (let y = 0; y < HEIGHT; y++) {
    for (let x = 0; x < WIDTH; x++) {
      if (mask[y][x] === null) continue;
      if (bridgeCells.has(`${x},${y}`)) {
        terrain[y][x] = 'bridge';
        continue;
      }
      const roll = Math.random();
      terrain[y][x] = roll < 0.62 ? 'plains' : roll < 0.86 ? 'forest' : 'mountain';
    }
  }
  return terrain;
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
      const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]].sort(() => Math.random() - 0.5);
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

  for (const cell of cells) {
    if (owner[cell.y][cell.x] !== null) continue;
    let nearest = 0;
    let distance = Infinity;
    seeds.forEach((seed, index) => {
      const candidate = manhattan(cell, seed);
      if (candidate < distance) {
        distance = candidate;
        nearest = index;
      }
    });
    owner[cell.y][cell.x] = nearest;
  }

  return { owner, seeds };
}

function initializeGame(room) {
  assignStartingDoctrines(room);
  const { grid: mask, bridgeCells } = generateLandMask();
  const partition = partitionMap(mask, room.players.length);
  room.map = partition.owner;
  room.capitals = partition.seeds;
  room.terrain = generateTerrain(mask, bridgeCells);
  room.status = 'playing';
  room.turnIndex = 0;
  room.round = 1;
  room.pendingBattle = null;
  room.drawVotes = [];
  room.gameResult = null;
  room.startingBalance = buildStartingBalance(room);
  const doctrineSummary = room.players
    .map(player => `${player.name}: ${player.doctrine.name}`)
    .join(' · ');
  room.log = [
    `Unique starting doctrines assigned — ${doctrineSummary}.`,
    `Round 1 begins. ${room.players[0].name} moves first.`
  ];
  addSystemMessage(room, `Unique starting doctrines: ${doctrineSummary}.`);
  addSystemMessage(room, `The war has begun. ${room.players[0].name} moves first.`);
}

function countTiles(room, playerIndex) {
  let count = 0;
  room.map.forEach(row => row.forEach(owner => {
    if (owner === playerIndex) count++;
  }));
  return count;
}

function currentPlayer(room) {
  return room.players[room.turnIndex];
}

function terrainBreakdownForPlayer(room, playerIndex) {
  const counts = { plains: 0, forest: 0, mountain: 0, bridge: 0 };
  let totalDefenseBonus = 0;

  for (let y = 0; y < room.height; y++) {
    for (let x = 0; x < room.width; x++) {
      if (room.map[y][x] !== playerIndex) continue;
      const terrainKey = room.terrain[y][x] || 'plains';
      counts[terrainKey] = (counts[terrainKey] || 0) + 1;
      totalDefenseBonus += ((TERRAIN[terrainKey] || TERRAIN.plains).defense - 1) * 100;
    }
  }

  const tiles = Object.values(counts).reduce((sum, value) => sum + value, 0);
  return {
    ...counts,
    averageDefenseBonus: tiles > 0 ? Math.round((totalDefenseBonus / tiles) * 10) / 10 : 0
  };
}

function buildStartingBalance(room) {
  const trackedStats = ['army', 'efficiency', 'logistics', 'fortification', 'technology', 'armor'];
  const playerSnapshots = room.players.map((player, index) => {
    const terrain = terrainBreakdownForPlayer(room, index);
    const capital = room.capitals[index];
    const capitalTerrain = capital ? room.terrain[capital.y][capital.x] || 'plains' : 'plains';

    return {
      id: player.id,
      name: player.name,
      color: player.color,
      turnOrder: index + 1,
      doctrine: player.doctrine ? { ...player.doctrine, effects: [...player.doctrine.effects] } : null,
      stats: Object.fromEntries(trackedStats.map(stat => [stat, player.stats[stat]])),
      derivedEffects: getPlayerEffects(player),
      upgradeLevels: { ...player.upgradeLevels },
      tileCount: countTiles(room, index),
      terrain,
      capitalTerrain
    };
  });

  const averages = {};
  for (const stat of trackedStats) {
    averages[stat] = playerSnapshots.reduce((sum, player) => sum + player.stats[stat], 0) /
      Math.max(1, playerSnapshots.length);
  }
  averages.tileCount = playerSnapshots.reduce((sum, player) => sum + player.tileCount, 0) /
    Math.max(1, playerSnapshots.length);
  averages.averageTerrainDefense = playerSnapshots.reduce(
    (sum, player) => sum + player.terrain.averageDefenseBonus,
    0
  ) / Math.max(1, playerSnapshots.length);

  for (const snapshot of playerSnapshots) {
    snapshot.deviations = Object.fromEntries(
      trackedStats.map(stat => [stat, Math.round((snapshot.stats[stat] - averages[stat]) * 10) / 10])
    );
    snapshot.deviations.tileCount = Math.round((snapshot.tileCount - averages.tileCount) * 10) / 10;
    snapshot.deviations.averageTerrainDefense = Math.round(
      (snapshot.terrain.averageDefenseBonus - averages.averageTerrainDefense) * 10
    ) / 10;
  }

  const allCoreStatsEqual = trackedStats.every(stat =>
    playerSnapshots.every(player => player.stats[stat] === playerSnapshots[0]?.stats[stat])
  );
  const allUpgradeLevelsEqual = playerSnapshots.every(player =>
    Object.values(player.upgradeLevels).every(level => level === 0)
  );
  const doctrineIds = playerSnapshots.map(player => player.doctrine?.id).filter(Boolean);
  const allDoctrinesUnique = doctrineIds.length === playerSnapshots.length && new Set(doctrineIds).size === doctrineIds.length;

  return {
    generatedAt: Date.now(),
    allCoreStatsEqual,
    allUpgradeLevelsEqual,
    allDoctrinesUnique,
    averages: Object.fromEntries(
      Object.entries(averages).map(([key, value]) => [key, Math.round(value * 10) / 10])
    ),
    players: playerSnapshots,
    notes: [
      allDoctrinesUnique
        ? 'Every player received a different starting doctrine; doctrines are shuffled so player order does not choose the buff.'
        : 'A duplicate or missing doctrine was detected.',
      'Starting combat stats intentionally differ because each doctrine has clear strengths and trade-offs.',
      allUpgradeLevelsEqual
        ? 'Every purchased-upgrade level starts at 0; doctrine levels are starting stats, not purchased upgrades.'
        : 'One or more players started with a purchased-upgrade level above 0.',
      'Procedural maps can still create small differences in tile count, terrain mix, capital terrain, and turn order.'
    ]
  };
}

function isAdjacent(a, b) {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y) === 1;
}

function validTile(room, tile) {
  return tile && Number.isInteger(tile.x) && Number.isInteger(tile.y) &&
    tile.x >= 0 && tile.x < room.width && tile.y >= 0 && tile.y < room.height;
}

function isCapital(room, tile, playerIndex) {
  const capital = room.capitals[playerIndex];
  return Boolean(capital && capital.x === tile.x && capital.y === tile.y);
}

function friendlySupport(room, tile, playerIndex) {
  const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  return dirs.reduce((support, [dx, dy]) => {
    const x = tile.x + dx;
    const y = tile.y + dy;
    if (x < 0 || x >= room.width || y < 0 || y >= room.height) return support;
    return support + (room.map[y][x] === playerIndex ? 1 : 0);
  }, 0);
}

function getPlayerEffects(player) {
  const efficiencyCombat = (player.stats.efficiency - 85) * 0.0045;
  const efficiencyIncomeMultiplier = clamp(0.55 + player.stats.efficiency * 0.0055, 0.88, 1.22);
  const logisticsLevels = Math.max(0, player.stats.logistics - 1);
  const logisticsAttack = logisticsLevels * 0.03;
  const localDefenseShare = clamp(0.22 + logisticsLevels * 0.02, 0.22, 0.34);
  const logisticsRecruitBonus = player.stats.logistics * 4;
  const supplyCapacityBonus = player.stats.logistics * 40;
  const upkeepDiscount = Math.min(0.35, logisticsLevels * 0.08);
  const armorDefense = Math.min(0.18, Math.max(0, player.stats.armor) * 0.03);
  const armorCasualtyReduction = Math.min(0.12, Math.max(0, player.stats.armor) * 0.018);
  const fortificationDefense = Math.max(0, player.stats.fortification - 1) * 0.03;

  return {
    efficiencyCombat,
    efficiencyIncomeMultiplier,
    logisticsAttack,
    localDefenseShare,
    logisticsRecruitBonus,
    supplyCapacityBonus,
    upkeepDiscount,
    armorDefense,
    armorCasualtyReduction,
    fortificationDefense
  };
}

function getUpgradeOffers(player) {
  const levels = player.upgradeLevels;
  const offers = {
    army: {
      cost: 140 + levels.army * 80,
      gain: Math.max(12, 24 - levels.army * 2),
      label: 'Army'
    },
    efficiency: {
      cost: 170 + levels.efficiency * 90,
      gain: 5,
      label: 'Efficiency',
      maximum: 120,
      current: player.stats.efficiency
    },
    technology: {
      cost: 260 + levels.technology * 165,
      gain: 1,
      label: 'Technology',
      maximum: 10,
      current: player.stats.technology
    },
    armor: {
      cost: 220 + levels.armor * 125,
      gain: 1,
      label: 'Armor'
    },
    logistics: {
      cost: 200 + levels.logistics * 135,
      gain: 1,
      label: 'Logistics',
      maximum: 8,
      current: player.stats.logistics
    },
    fortification: {
      cost: 170 + levels.fortification * 100,
      gain: 1,
      label: 'Fortification',
      maximum: 8,
      current: player.stats.fortification
    }
  };

  for (const offer of Object.values(offers)) {
    offer.maxed = Number.isFinite(offer.maximum) && offer.current >= offer.maximum;
  }
  return offers;
}

function publicPlayer(player, index, room) {
  return {
    id: player.id,
    name: player.name,
    color: player.color,
    connected: player.connected,
    defeated: player.defeated,
    resigned: player.resigned,
    doctrine: player.doctrine ? { ...player.doctrine, effects: [...player.doctrine.effects] } : null,
    stats: { ...player.stats },
    effects: getPlayerEffects(player),
    upgradeLevels: { ...player.upgradeLevels },
    tileCount: room.status === 'playing' || room.status === 'finished' ? countTiles(room, index) : 0,
    upgradeOffers: getUpgradeOffers(player)
  };
}

function publicRoom(room) {
  return {
    code: room.code,
    hostId: room.hostId,
    status: room.status,
    players: room.players.map((player, index) => publicPlayer(player, index, room)),
    map: room.map,
    terrain: room.terrain,
    capitals: room.capitals,
    width: room.width,
    height: room.height,
    turnIndex: room.turnIndex,
    round: room.round,
    pendingBattle: room.pendingBattle ? {
      attackerId: room.pendingBattle.attackerId,
      defenderIndex: room.pendingBattle.defenderIndex,
      target: room.pendingBattle.target,
      terrain: room.pendingBattle.terrain,
      armorChallenge: room.pendingBattle.armorChallenge,
      armorResolved: room.pendingBattle.armorResolved
    } : null,
    log: room.log.slice(-20),
    chat: room.chat.slice(-MAX_CHAT_MESSAGES),
    drawVotes: [...room.drawVotes],
    gameResult: room.gameResult ? { ...room.gameResult } : null,
    startingBalance: room.startingBalance ? JSON.parse(JSON.stringify(room.startingBalance)) : null
  };
}

function emitRoom(room) {
  io.to(room.code).emit('roomState', publicRoom(room));
}

function addLog(room, text) {
  room.log.push(text);
  if (room.log.length > 100) room.log.shift();
}

function addSystemMessage(room, text) {
  room.chat.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'system',
    text,
    timestamp: Date.now()
  });
  if (room.chat.length > MAX_CHAT_MESSAGES) room.chat.shift();
}

function addPlayerMessage(room, player, text) {
  room.chat.push({
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    type: 'player',
    playerId: player.id,
    name: player.name,
    color: player.color,
    text,
    timestamp: Date.now()
  });
  if (room.chat.length > MAX_CHAT_MESSAGES) room.chat.shift();
}

function applyRoundEconomy(room) {
  const livingIndexes = room.players
    .map((player, index) => ({ player, index }))
    .filter(({ player, index }) => !player.defeated && countTiles(room, index) > 0);

  const tileCounts = livingIndexes.map(({ index }) => countTiles(room, index));
  const leaderTiles = Math.max(...tileCounts, 1);
  const averageArmy = livingIndexes.reduce((sum, { player }) => sum + player.stats.army, 0) /
    Math.max(livingIndexes.length, 1);

  for (const { player, index } of livingIndexes) {
    const tiles = countTiles(room, index);
    const effects = getPlayerEffects(player);
    const baseIncome = tiles * 6.2 * effects.efficiencyIncomeMultiplier;
    const catchUpIncome = Math.max(0, leaderTiles - tiles) * 2.4;
    const rawArmyUpkeep = Math.max(0, player.stats.army - (90 + tiles * 1.5)) * 0.42;
    const armyUpkeep = rawArmyUpkeep * (1 - effects.upkeepDiscount);
    const armorUpkeep = player.stats.armor * 7;
    const netIncome = Math.max(24, Math.round(baseIncome + catchUpIncome - armyUpkeep - armorUpkeep));

    const armyCatchUp = Math.max(0, averageArmy - player.stats.army) * 0.05;
    const recruits = Math.max(4, Math.round(
      tiles * 0.075 + effects.logisticsRecruitBonus + player.stats.technology * 0.8 + armyCatchUp
    ));

    player.stats.money += netIncome;
    player.stats.army += recruits;
    player.stats.morale = clamp(player.stats.morale + 4, 55, 120);
    player.stats.warExhaustion = clamp(player.stats.warExhaustion - 8, 0, 80);

    const sustainableArmy = tiles * 7 + effects.supplyCapacityBonus + 70;
    if (player.stats.army > sustainableArmy) {
      const attrition = Math.max(1, Math.round((player.stats.army - sustainableArmy) * 0.07));
      player.stats.army = Math.max(1, player.stats.army - attrition);
      addLog(room, `${player.name} lost ${attrition} troops to supply shortages.`);
    }
  }
}

function getLivingPlayers(room, connectedOnly = false) {
  return room.players
    .map((player, index) => ({ player, index }))
    .filter(({ player, index }) =>
      !player.defeated &&
      countTiles(room, index) > 0 &&
      (!connectedOnly || player.connected)
    );
}

function finishGame(room, result) {
  if (room.status === 'finished') return false;
  room.status = 'finished';
  room.pendingBattle = null;
  room.drawVotes = [];
  room.gameResult = result;
  addLog(room, result.message);
  addSystemMessage(room, result.message);
  return true;
}

function finishGameIfDecided(room) {
  const living = getLivingPlayers(room);
  if (living.length > 1) return false;

  const winner = living[0];
  if (winner) {
    return finishGame(room, {
      type: 'victory',
      winnerId: winner.player.id,
      message: `${winner.player.name} wins the game!`
    });
  }

  return finishGame(room, {
    type: 'draw',
    reason: 'no-contestants',
    message: 'The game ends with no remaining contestants.'
  });
}

function eligibleDrawPlayers(room) {
  return getLivingPlayers(room, true);
}

function pruneDrawVotes(room) {
  const eligibleIds = new Set(eligibleDrawPlayers(room).map(({ player }) => player.id));
  room.drawVotes = room.drawVotes.filter(playerId => eligibleIds.has(playerId));
}

function finishDrawIfAccepted(room) {
  pruneDrawVotes(room);
  const eligible = eligibleDrawPlayers(room);
  if (eligible.length < 2) return false;

  const allAccepted = eligible.every(({ player }) => room.drawVotes.includes(player.id));
  if (!allAccepted) return false;

  return finishGame(room, {
    type: 'draw',
    reason: 'unanimous',
    message: 'All active players accepted the draw. The game ends in a draw.'
  });
}

function nextTurn(room) {
  if (room.status !== 'playing') return;
  room.pendingBattle = null;

  if (finishGameIfDecided(room)) return;

  let wrapped = false;
  let foundNext = false;
  for (let attempts = 0; attempts < room.players.length; attempts++) {
    room.turnIndex++;
    if (room.turnIndex >= room.players.length) {
      room.turnIndex = 0;
      wrapped = true;
    }
    const player = room.players[room.turnIndex];
    if (!player.defeated && player.connected && countTiles(room, room.turnIndex) > 0) {
      foundNext = true;
      break;
    }
  }

  if (wrapped) {
    room.round++;
    applyRoundEconomy(room);
    addLog(room, `Round ${room.round} begins. Income, upkeep, and recruits have been calculated.`);
    addSystemMessage(room, `Round ${room.round} has begun.`);
  }

  if (!foundNext) {
    addLog(room, 'No connected player is available to take the next turn.');
  }
}

function sharedCombatBonuses(player) {
  const effects = getPlayerEffects(player);
  return {
    technology: (player.stats.technology - 2) * 0.035,
    efficiency: effects.efficiencyCombat,
    morale: (player.stats.morale - 100) * 0.003,
    exhaustion: -player.stats.warExhaustion * 0.0015
  };
}

function sumBonuses(bonuses) {
  return Object.values(bonuses).reduce((sum, value) => sum + value, 0);
}

function defenderLocalShare(defender) {
  return getPlayerEffects(defender).localDefenseShare;
}

function combatFactors(room, attackerIndex, defenderIndex, from, target) {
  const attacker = room.players[attackerIndex];
  const defender = room.players[defenderIndex];
  const terrainKey = room.terrain[target.y][target.x] || 'plains';
  const terrain = TERRAIN[terrainKey] || TERRAIN.plains;
  const support = friendlySupport(room, from, attackerIndex);
  const capitalBonus = isCapital(room, target, defenderIndex) ? 0.08 : 0;

  const attackerEffects = getPlayerEffects(attacker);
  const defenderEffects = getPlayerEffects(defender);

  const attackerBonuses = {
    ...sharedCombatBonuses(attacker),
    support: support * 0.012,
    logistics: attackerEffects.logisticsAttack,
    bridge: terrainKey === 'bridge' ? -0.04 : 0
  };

  const defenderBonuses = {
    ...sharedCombatBonuses(defender),
    terrain: terrain.defense - 1,
    home: 0.03,
    fortification: defenderEffects.fortificationDefense,
    capital: capitalBonus,
    armor: defenderEffects.armorDefense
  };

  const attackerMultiplier = clamp(1 + sumBonuses(attackerBonuses), 0.78, 1.38);
  const defenderMultiplier = clamp(1 + sumBonuses(defenderBonuses), 0.78, 1.48);

  return {
    terrainKey,
    terrain,
    support,
    attackerBonuses,
    defenderBonuses,
    attackerEffects,
    defenderEffects,
    attackerMultiplier,
    defenderMultiplier
  };
}

function estimateBattleOdds(room, battle) {
  const defender = room.players[battle.defenderIndex];
  const factors = combatFactors(
    room,
    battle.attackerIndex,
    battle.defenderIndex,
    battle.from,
    battle.target
  );
  const defenderForce = Math.min(
    defender.stats.army,
    Math.max(defender.stats.army > 0 ? 1 : 0, Math.round(defender.stats.army * defenderLocalShare(defender)))
  );
  const attackScore = battle.committed * factors.attackerMultiplier;
  const defenseScore = defenderForce * factors.defenderMultiplier;
  return Math.round(clamp((attackScore / Math.max(1, attackScore + defenseScore)) * 100, 15, 85));
}

function resolveBattle(room, battle, selectedCell) {
  const attacker = room.players[battle.attackerIndex];
  const defender = room.players[battle.defenderIndex];
  let armorDestroyed = 0;
  let armorHit = false;

  if (battle.armorChallenge) {
    if (selectedCell === battle.armorCell) {
      armorHit = true;
      armorDestroyed = Math.max(1, Math.ceil(defender.stats.armor * randomBetween(0.4, 0.6)));
    } else if (Math.random() < 0.12 && defender.stats.armor > 0) {
      armorDestroyed = 1;
    }

    if (armorDestroyed > 0) {
      armorDestroyed = Math.min(armorDestroyed, defender.stats.armor);
      defender.stats.armor -= armorDestroyed;
      addLog(
        room,
        armorHit
          ? `${attacker.name} located the armored column and destroyed ${armorDestroyed} vehicle${armorDestroyed === 1 ? '' : 's'}.`
          : `${attacker.name} missed the convoy but scored a glancing hit, destroying 1 vehicle.`
      );
    } else {
      addLog(room, `${attacker.name} missed the armored column. The vehicles remain active.`);
    }
  }

  const estimatedOdds = estimateBattleOdds(room, battle);
  const committed = clamp(battle.committed, 1, attacker.stats.army);
  attacker.stats.army -= committed;

  const localShare = defenderLocalShare(defender);
  let attackerForce = committed;
  let defenderForce = Math.min(
    defender.stats.army,
    Math.max(defender.stats.army > 0 ? 1 : 0, Math.round(defender.stats.army * localShare))
  );
  defender.stats.army -= defenderForce;

  const initialAttackerForce = attackerForce;
  const initialDefenderForce = defenderForce;
  const factors = combatFactors(
    room,
    battle.attackerIndex,
    battle.defenderIndex,
    battle.from,
    battle.target
  );
  const attackerBase = factors.attackerMultiplier;
  const defenderBase = factors.defenderMultiplier;
  const rounds = [];

  for (let roundNumber = 1; roundNumber <= 3 && attackerForce > 0 && defenderForce > 0; roundNumber++) {
    const attackerRoll = randomBetween(0.92, 1.08);
    const defenderRoll = randomBetween(0.92, 1.08);
    const attackerPower = attackerForce * attackerBase * attackerRoll;
    const defenderPower = defenderForce * defenderBase * defenderRoll;
    const powerRatio = attackerPower / Math.max(defenderPower, 1);

    const attackerLossRate = clamp(0.11 + (1 / Math.max(powerRatio, 0.2)) * 0.09, 0.08, 0.34);
    const defenderLossRate = clamp(
      (0.12 + powerRatio * 0.1) * (1 - factors.defenderEffects.armorCasualtyReduction),
      0.07,
      0.39
    );
    const attackerLoss = Math.min(
      attackerForce,
      Math.max(1, Math.round(attackerForce * attackerLossRate * randomBetween(0.93, 1.07)))
    );
    const defenderLoss = Math.min(
      defenderForce,
      Math.max(1, Math.round(defenderForce * defenderLossRate * randomBetween(0.93, 1.07)))
    );

    attackerForce = Math.max(0, attackerForce - attackerLoss);
    defenderForce = Math.max(0, defenderForce - defenderLoss);
    rounds.push({
      round: roundNumber,
      atkLoss: attackerLoss,
      defLoss: defenderLoss,
      atkRemaining: attackerForce,
      defRemaining: defenderForce,
      atkPower: Math.round(attackerPower),
      defPower: Math.round(defenderPower)
    });
  }

  const finalAttackScore = attackerForce * attackerBase * randomBetween(0.95, 1.05);
  const finalDefenseScore = defenderForce * defenderBase * randomBetween(0.95, 1.05);
  const scoreRatio = finalAttackScore / Math.max(finalDefenseScore, 1);
  const attackerWins = attackerForce >= 3 && (defenderForce === 0 || scoreRatio > 1.03);
  let outcome = 'Failed assault';
  let capturedCapital = false;
  let occupationLoss = 0;

  if (attackerWins) {
    capturedCapital = isCapital(room, battle.target, battle.defenderIndex);
    room.map[battle.target.y][battle.target.x] = battle.attackerIndex;
    occupationLoss = Math.min(
      attackerForce,
      Math.max(1, Math.round(attackerForce * factors.terrain.occupationLoss))
    );
    attackerForce = Math.max(0, attackerForce - occupationLoss);
    attacker.stats.army += attackerForce;
    defender.stats.army += defenderForce;

    const loot = 28 + defender.stats.technology * 7 + (capturedCapital ? 90 : 0);
    attacker.stats.money += loot;
    defender.stats.money = Math.max(0, defender.stats.money - Math.round(loot * 0.55));
    attacker.stats.morale = clamp(attacker.stats.morale + (capturedCapital ? 9 : 4), 55, 120);
    defender.stats.morale = clamp(defender.stats.morale - (capturedCapital ? 12 : 6), 55, 120);
    attacker.stats.warExhaustion = clamp(attacker.stats.warExhaustion + 8, 0, 80);
    defender.stats.warExhaustion = clamp(defender.stats.warExhaustion + 5, 0, 80);

    outcome = scoreRatio > 1.75 || defenderForce === 0 ? 'Decisive victory' : 'Minor victory';
    addLog(
      room,
      `${attacker.name} captured ${TERRAIN[factors.terrainKey].name.toLowerCase()} territory from ${defender.name}${capturedCapital ? ' and seized the capital' : ''}.`
    );
    addSystemMessage(
      room,
      `${attacker.name} captured territory from ${defender.name}${capturedCapital ? ' and seized a capital!' : '.'}`
    );
  } else {
    attacker.stats.army += attackerForce;
    defender.stats.army += defenderForce;
    attacker.stats.morale = clamp(attacker.stats.morale - 5, 55, 120);
    defender.stats.morale = clamp(defender.stats.morale + 3, 55, 120);
    attacker.stats.warExhaustion = clamp(attacker.stats.warExhaustion + 10, 0, 80);
    defender.stats.warExhaustion = clamp(defender.stats.warExhaustion + 4, 0, 80);

    outcome = defenderForce > 0 && scoreRatio >= 0.92 ? 'Stalemate' : 'Failed assault';
    addLog(
      room,
      outcome === 'Stalemate'
        ? `${attacker.name} and ${defender.name} fought to a stalemate. The defender keeps the territory.`
        : `${defender.name} repelled ${attacker.name}'s assault.`
    );
  }

  if (countTiles(room, battle.defenderIndex) === 0) {
    defender.defeated = true;
    addLog(room, `${defender.name} has been eliminated.`);
    addSystemMessage(room, `${defender.name} has been eliminated.`);
  }

  const attackerLosses = initialAttackerForce - attackerForce;
  const defenderLosses = initialDefenderForce - defenderForce;
  room.pendingBattle = null;
  pruneDrawVotes(room);
  nextTurn(room);

  io.to(room.code).emit('battleResult', {
    attackerWins,
    outcome,
    capturedCapital,
    armorHit,
    armorDestroyed,
    occupationLoss,
    terrain: factors.terrainKey,
    terrainName: factors.terrain.name,
    estimatedOdds,
    rounds,
    attackerLosses,
    defenderLosses,
    attackerName: attacker.name,
    defenderName: defender.name,
    modifiers: {
      attackerTotal: Math.round((factors.attackerMultiplier - 1) * 100),
      defenderTotal: Math.round((factors.defenderMultiplier - 1) * 100),
      attackerEfficiency: Math.round(factors.attackerBonuses.efficiency * 100),
      defenderEfficiency: Math.round(factors.defenderBonuses.efficiency * 100),
      attackerLogistics: Math.round(factors.attackerBonuses.logistics * 100),
      attackerSupport: Math.round((factors.attackerBonuses.support + factors.attackerBonuses.bridge) * 100),
      defenderLocalShare: Math.round(factors.defenderEffects.localDefenseShare * 100),
      terrainDefense: Math.round(factors.defenderBonuses.terrain * 100),
      fortification: Math.round(factors.defenderBonuses.fortification * 100),
      armorDefense: Math.round(factors.defenderBonuses.armor * 100),
      armorCasualtyReduction: Math.round(factors.defenderEffects.armorCasualtyReduction * 100),
      capitalDefense: Math.round(factors.defenderBonuses.capital * 100)
    }
  });
  emitRoom(room);
}

function leaveRoom(socket) {
  const code = socket.data.roomCode;
  if (!code || !rooms.has(code)) return;
  const room = rooms.get(code);
  socket.leave(code);
  socket.data.roomCode = null;
  const playerIndex = room.players.findIndex(player => player.id === socket.id);
  const player = room.players[playerIndex];

  if (player) {
    player.connected = false;
    room.drawVotes = room.drawVotes.filter(playerId => playerId !== player.id);
  }

  if (room.status === 'lobby') {
    room.players = room.players.filter(candidate => candidate.id !== socket.id);
    room.players.forEach((candidate, index) => { candidate.color = COLORS[index]; });
    if (room.players.length === 0) {
      rooms.delete(code);
      return;
    }
    if (room.hostId === socket.id) room.hostId = room.players[0].id;
    addSystemMessage(room, `${player?.name || 'A player'} left the room.`);
  } else if (player) {
    addLog(room, `${player.name} disconnected.`);
    addSystemMessage(room, `${player.name} disconnected.`);

    if (room.hostId === socket.id) {
      const nextHost = room.players.find(candidate => candidate.connected && !candidate.defeated);
      if (nextHost) room.hostId = nextHost.id;
    }

    if (room.pendingBattle?.attackerId === socket.id) {
      room.pendingBattle = null;
      addLog(room, 'The pending battle was cancelled because the attacker disconnected.');
    }

    if (room.status === 'playing' && room.turnIndex === playerIndex) {
      nextTurn(room);
    }
  }

  if (room.status === 'playing') finishDrawIfAccepted(room);
  emitRoom(room);
}

io.on('connection', socket => {
  socket.data.lastChatAt = 0;

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

    const player = makePlayer(socket.id, name, room.players.length);
    room.players.push(player);
    socket.join(room.code);
    socket.data.roomCode = room.code;
    addSystemMessage(room, `${player.name} joined the room.`);
    callback?.({ ok: true, code: room.code });
    emitRoom(room);
  });

  socket.on('startGame', (_, callback) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return callback?.({ ok: false, error: 'Room not found.' });
    if (room.hostId !== socket.id) return callback?.({ ok: false, error: 'Only the host can start.' });
    if (room.players.length < 2) return callback?.({ ok: false, error: 'At least 2 players are required.' });
    initializeGame(room);
    emitRoom(room);
    callback?.({ ok: true });
  });

  socket.on('attack', ({ from, target, committed }, callback) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return callback?.({ ok: false, error: 'Game not available.' });
    const attackerIndex = room.players.findIndex(player => player.id === socket.id);
    if (attackerIndex !== room.turnIndex) return callback?.({ ok: false, error: 'It is not your turn.' });
    if (room.pendingBattle) return callback?.({ ok: false, error: 'Finish the current battle first.' });
    if (!validTile(room, from) || !validTile(room, target)) return callback?.({ ok: false, error: 'Invalid tile.' });
    if (!isAdjacent(from, target)) return callback?.({ ok: false, error: 'You can only attack an adjacent tile.' });
    if (room.map[from.y][from.x] !== attackerIndex) return callback?.({ ok: false, error: 'Choose one of your own border tiles.' });

    const defenderIndex = room.map[target.y][target.x];
    if (defenderIndex === null || defenderIndex === attackerIndex) {
      return callback?.({ ok: false, error: 'Choose an adjacent enemy tile.' });
    }

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
      terrain: room.terrain[target.y][target.x] || 'plains',
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
    if (!room || !room.pendingBattle) return callback?.({ ok: false, error: 'No armor challenge is active.' });
    const battle = room.pendingBattle;
    if (battle.attackerId !== socket.id) return callback?.({ ok: false, error: 'Only the attacker can choose.' });
    const pick = clamp(Math.floor(Number(cell)), 0, 5);
    resolveBattle(room, battle, pick);
    callback?.({ ok: true });
  });

  socket.on('endTurn', (_, callback) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return callback?.({ ok: false, error: 'Game not available.' });
    if (currentPlayer(room)?.id !== socket.id) return callback?.({ ok: false, error: 'It is not your turn.' });
    if (room.pendingBattle) return callback?.({ ok: false, error: 'Resolve the battle first.' });
    addLog(room, `${currentPlayer(room).name} ended their turn.`);
    nextTurn(room);
    emitRoom(room);
    callback?.({ ok: true });
  });

  socket.on('toggleDrawVote', (_, callback) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return callback?.({ ok: false, error: 'Game not available.' });
    if (room.pendingBattle) return callback?.({ ok: false, error: 'Resolve the current battle first.' });

    const playerIndex = room.players.findIndex(player => player.id === socket.id);
    const player = room.players[playerIndex];
    if (!player || player.defeated || countTiles(room, playerIndex) === 0) {
      return callback?.({ ok: false, error: 'Only active players can vote for a draw.' });
    }

    pruneDrawVotes(room);
    const eligible = eligibleDrawPlayers(room);
    if (eligible.length < 2) {
      return callback?.({ ok: false, error: 'At least two active connected players are required.' });
    }

    const alreadyVoted = room.drawVotes.includes(socket.id);
    if (alreadyVoted) {
      room.drawVotes = room.drawVotes.filter(playerId => playerId !== socket.id);
      addSystemMessage(room, `${player.name} withdrew their draw vote.`);
    } else {
      room.drawVotes.push(socket.id);
      addSystemMessage(room, `${player.name} voted to end the game in a draw.`);
    }

    const nowVoting = !alreadyVoted;
    const completed = finishDrawIfAccepted(room);
    emitRoom(room);
    callback?.({ ok: true, voted: nowVoting, completed });
  });

  socket.on('resignGame', (_, callback) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return callback?.({ ok: false, error: 'Game not available.' });
    if (room.pendingBattle) return callback?.({ ok: false, error: 'Resolve the current battle before resigning.' });

    const playerIndex = room.players.findIndex(player => player.id === socket.id);
    const player = room.players[playerIndex];
    if (!player || player.defeated || countTiles(room, playerIndex) === 0) {
      return callback?.({ ok: false, error: 'You are no longer an active player.' });
    }

    player.resigned = true;
    player.defeated = true;
    player.stats.army = 0;
    player.stats.armor = 0;
    player.stats.morale = 55;
    room.drawVotes = room.drawVotes.filter(playerId => playerId !== player.id);

    addLog(room, `${player.name} resigned. Their remaining territory is now abandoned.`);
    addSystemMessage(room, `${player.name} resigned from the game.`);

    if (room.hostId === player.id) {
      const nextHost = room.players.find(candidate => candidate.connected && !candidate.defeated);
      if (nextHost) room.hostId = nextHost.id;
    }

    if (!finishGameIfDecided(room) && room.status === 'playing') {
      if (room.turnIndex === playerIndex) nextTurn(room);
      if (room.status === 'playing') finishDrawIfAccepted(room);
    }

    emitRoom(room);
    callback?.({ ok: true });
  });

  socket.on('buyUpgrade', ({ type }, callback) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room || room.status !== 'playing') return callback?.({ ok: false, error: 'Game not available.' });
    if (room.pendingBattle) return callback?.({ ok: false, error: 'Finish the current battle before buying upgrades.' });

    const playerIndex = room.players.findIndex(player => player.id === socket.id);
    const player = room.players[playerIndex];
    if (!player || player.defeated || countTiles(room, playerIndex) === 0) {
      return callback?.({ ok: false, error: 'Only active players can buy upgrades.' });
    }

    const offers = getUpgradeOffers(player);
    const offer = offers[type];
    if (!offer) return callback?.({ ok: false, error: 'Unknown upgrade.' });
    if (offer.maxed) return callback?.({ ok: false, error: `${offer.label} is already at maximum level.` });
    if (player.stats.money < offer.cost) {
      return callback?.({
        ok: false,
        error: `You need $${offer.cost - player.stats.money} more for ${offer.label.toLowerCase()}.`
      });
    }

    player.stats.money -= offer.cost;
    player.upgradeLevels[type] += 1;
    if (type === 'army') player.stats.army += offer.gain;
    if (type === 'efficiency') player.stats.efficiency = Math.min(120, player.stats.efficiency + offer.gain);
    if (type === 'technology') player.stats.technology = Math.min(10, player.stats.technology + offer.gain);
    if (type === 'armor') player.stats.armor += offer.gain;
    if (type === 'logistics') player.stats.logistics = Math.min(8, player.stats.logistics + offer.gain);
    if (type === 'fortification') player.stats.fortification = Math.min(8, player.stats.fortification + offer.gain);

    addLog(room, `${player.name} purchased a ${offer.label.toLowerCase()} upgrade for $${offer.cost}.`);
    emitRoom(room);
    callback?.({ ok: true, label: offer.label, cost: offer.cost, gain: offer.gain });
  });

  socket.on('sendChatMessage', ({ text }, callback) => {
    const room = rooms.get(socket.data.roomCode);
    if (!room) return callback?.({ ok: false, error: 'Join a room first.' });
    const player = room.players.find(candidate => candidate.id === socket.id);
    if (!player) return callback?.({ ok: false, error: 'Player not found.' });

    const now = Date.now();
    if (now - socket.data.lastChatAt < 650) {
      return callback?.({ ok: false, error: 'Please wait a moment before sending again.' });
    }

    const message = sanitizeChat(text);
    if (!message) return callback?.({ ok: false, error: 'Message cannot be empty.' });

    socket.data.lastChatAt = now;
    addPlayerMessage(room, player, message);
    emitRoom(room);
    callback?.({ ok: true });
  });

  socket.on('disconnect', () => leaveRoom(socket));
});

server.listen(PORT, () => {
  console.log(`Conquest Grid running at http://localhost:${PORT}`);
});

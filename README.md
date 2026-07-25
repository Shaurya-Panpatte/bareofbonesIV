# Conquest Grid

A browser-based, turn-based multiplayer territory game built with HTML Canvas, JavaScript, Node.js, Express, and Socket.IO.

## Features

- 2–6 real players using room codes
- Procedural one-island or two-island maps with bridges
- Contiguous starting territory for every player
- Random money, army, efficiency, technology, and armor stats
- Border-tile targeting and territory capture
- Three-round battle resolution influenced by technology, efficiency, army size, and armor
- 2×3 armored convoy interception minigame
- Turn order, round income, reinforcements, upgrades, elimination, and victory

## Run locally

1. Install Node.js 18 or newer.
2. Open a terminal in this folder.
3. Run:

```bash
npm install
npm start
```

4. Open `http://localhost:3000`.
5. Create a room, then join from other tabs, browsers, or devices on the same network.

For another device on the same Wi-Fi, use the host computer's local IP, for example `http://192.168.1.20:3000`.

## Controls

1. On your turn, select one of your tiles.
2. Select an adjacent enemy tile.
3. Choose how many troops to commit using the slider.
4. If the defender has armor, pick one of six sectors.
5. Read the battle report, buy upgrades, or end your turn.

## Notes

This is a polished prototype rather than a production-hardened game. Before public hosting, add authentication, persistent storage, reconnection handling, rate limiting, and anti-cheat validation.

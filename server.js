
const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/health', (req, res) => res.json({ ok: true, game: 'SEEK' }));

const PORT = process.env.PORT || 3000;
const MATCH_SIZE = 5;
const BLIND_SECONDS = 20;
const rooms = new Map();
const queues = new Map();
const matches = new Map();
const playerMatch = new Map();
const playerRoom = new Map();

const cleanName = value =>
  String(value || 'PLAYER').trim().slice(0, 12) || 'PLAYER';

const cleanMap = value =>
  ['bedroom', 'kitchen'].includes(value) ? value : 'bedroom';

const randomSpawn = () => ({
  x: 5 + Math.random() * 20,
  z: 5 + Math.random() * 20
});

function makeCode() {
  let code;
  do {
    code = String(Math.floor(1000 + Math.random() * 9000));
  } while (rooms.has(code));
  return code;
}

function roomUpdate(room) {
  for (const id of room.players) {
    const s = io.sockets.sockets.get(id);
    if (s) {
      s.emit('seek:room-update', {
        code: room.code,
        count: room.players.length,
        maxPlayers: room.maxPlayers,
        isHost: id === room.host
      });
    }
  }
}

function removeRoom(room) {
  rooms.delete(room.code);
  for (const id of room.players) {
    playerRoom.delete(id);
  }
}

function stopMatch(match) {
  if (match.timer) clearInterval(match.timer);
  matches.delete(match.id);

  for (const id of match.players.keys()) {
    if (!id.startsWith('bot-')) playerMatch.delete(id);
  }
}

function finishMatch(match, winner) {
  if (!matches.has(match.id)) return;
  io.to(match.id).emit('seek:round-end', { winner });
  stopMatch(match);
}

function startMatch({ sockets, map, minutes, bots = 0 }) {
  const id =
    `seek-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const players = [];

  for (const socket of sockets) {
    const spawn = randomSpawn();
    players.push({
      id: socket.id,
      name: socket.data.seekName || 'PLAYER',
      role: 'hider',
      spawn,
      x: spawn.x,
      z: spawn.z,
      found: false,
      bot: false
    });
  }

  for (let i = 0; i < bots; i++) {
    const spawn = randomSpawn();
    players.push({
      id: `bot-${id}-${i + 1}`,
      name: ['MILO', 'NOVA', 'PATCH', 'ECHO', 'RUST', 'JUNO', 'BYTE'][i % 7],
      role: 'hider',
      spawn,
      x: spawn.x,
      z: spawn.z,
      found: false,
      bot: true,
      botTarget: randomSpawn(),
      botThink: Math.random() * 2
    });
  }

  const seekerIndex = Math.floor(Math.random() * players.length);
  players[seekerIndex].role = 'seeker';

  const match = {
    id,
    map: cleanMap(map),
    players: new Map(players.map(p => [p.id, p])),
    phase: 'blind',
    blindEndsAt: Date.now() + BLIND_SECONDS * 1000,
    endsAt: Date.now() + (BLIND_SECONDS + Math.max(1, minutes) * 60) * 1000,
    timer: null
  };

  matches.set(id, match);

  for (const socket of sockets) {
    playerMatch.set(socket.id, id);
    socket.join(id);
  }

  io.to(id).emit('seek:match', {
    matchId: id,
    map: match.map,
    phase: match.phase,
    blindT: BLIND_SECONDS,
    timeLeft: Math.max(1, minutes) * 60,
    players: players.map(p => ({
      id: p.id,
      name: p.name,
      role: p.role,
      spawn: p.spawn
    }))
  });

  match.timer = setInterval(() => tickMatch(match), 250);
}

function tickMatch(match) {
  if (!matches.has(match.id)) return;

  const now = Date.now();

  if (match.phase === 'blind' && now >= match.blindEndsAt) {
    match.phase = 'hunt';
  }

  const all = [...match.players.values()];
  const seeker = all.find(p => p.role === 'seeker');

  // Bot movement.
  for (const bot of all.filter(p => p.bot && !p.found)) {
    bot.botThink -= 0.25;
    let target = bot.botTarget || randomSpawn();

    if (bot.role === 'seeker' && match.phase === 'hunt') {
      const hiders = all.filter(p => p.role === 'hider' && !p.found);
      hiders.sort((a, b) =>
        Math.hypot(a.x - bot.x, a.z - bot.z) -
        Math.hypot(b.x - bot.x, b.z - bot.z)
      );

      if (hiders[0]) {
        target = { x: hiders[0].x, z: hiders[0].z };
      }
    } else if (
      bot.botThink <= 0 ||
      Math.hypot(target.x - bot.x, target.z - bot.z) < 1.5
    ) {
      bot.botTarget = randomSpawn();
      bot.botThink = 2 + Math.random() * 4;
      target = bot.botTarget;
    }

    const dx = target.x - bot.x;
    const dz = target.z - bot.z;
    const dist = Math.hypot(dx, dz);

    if (dist > 0.1) {
      const speed = bot.role === 'seeker' ? 2.5 : 1.6;
      bot.x += (dx / dist) * speed * 0.25;
      bot.z += (dz / dist) * speed * 0.25;
    }

    io.to(match.id).emit('seek:state', {
      id: bot.id,
      x: bot.x,
      z: bot.z,
      yaw: Math.atan2(dx, dz),
      pitch: 0,
      jy: 0,
      eye: 1.6,
      moving: dist > 0.5,
      crouch: false,
      prone: false
    });
  }

  // Bot Seeker catches nearby human Hiders.
  if (match.phase === 'hunt' && seeker && seeker.bot && !seeker.found) {
    for (const hider of all) {
      if (hider.role !== 'hider' || hider.found || hider.bot) continue;

      if (Math.hypot(seeker.x - hider.x, seeker.z - hider.z) < 1.8) {
        hider.found = true;
        io.to(match.id).emit('seek:caught', { id: hider.id });
      }
    }
  }

  const livingHiders = all.filter(p => p.role === 'hider' && !p.found);

  if (!livingHiders.length) {
    return finishMatch(match, 'seeker');
  }

  if (now >= match.endsAt) {
    return finishMatch(match, 'hiders');
  }

  const blindT = Math.max(
    0,
    Math.ceil((match.blindEndsAt - now) / 1000)
  );

  const timeLeft = Math.max(
    0,
    Math.ceil((match.endsAt - Math.max(now, match.blindEndsAt)) / 1000)
  );

  io.to(match.id).emit('seek:phase', {
    phase: match.phase,
    blindT,
    timeLeft
  });
}

function startRoom(room) {
  if (!room || room.players.length < 2) return;

  const sockets = room.players
    .map(id => io.sockets.sockets.get(id))
    .filter(Boolean);

  if (sockets.length < 2) return;

  removeRoom(room);

  startMatch({
    sockets,
    map: room.map,
    minutes: room.minutes
  });
}

io.on('connection', socket => {

  // PUBLIC MATCHMAKING: EXACTLY FIVE REAL PLAYERS.
  socket.on('seek:join', data => {
    if (playerMatch.has(socket.id) || playerRoom.has(socket.id)) return;

    socket.data.seekName = cleanName(data && data.name);
    const map = cleanMap(data && data.map);

    if (!queues.has(map)) queues.set(map, []);
    const queue = queues.get(map);

    if (!queue.some(s => s.id === socket.id)) {
      queue.push(socket);
    }

    const update = () => {
      const waiting = queue.filter(s => s.connected);

      waiting.forEach(s => s.emit('seek:queue', {
        count: waiting.length,
        needed: MATCH_SIZE,
        matchId: null
      }));
    };

    update();

    while (queue.filter(s => s.connected).length >= MATCH_SIZE) {
      const group = [];

      while (queue.length && group.length < MATCH_SIZE) {
        const next = queue.shift();

        if (next.connected && !playerMatch.has(next.id)) {
          group.push(next);
        }
      }

      if (group.length === MATCH_SIZE) {
        startMatch({ sockets: group, map, minutes: 5 });
      } else {
        queue.unshift(...group);
        break;
      }
    }

    update();
  });

  // HOST A CUSTOM ROOM.
  socket.on('seek:create-room', data => {
    if (playerMatch.has(socket.id) || playerRoom.has(socket.id)) {
      socket.emit('seek:error', {
        message: 'You are already in a match or room.'
      });
      return;
    }

    socket.data.seekName = cleanName(data && data.name);

    const room = {
      code: makeCode(),
      host: socket.id,
      players: [socket.id],
      maxPlayers: Math.max(2, Math.min(8, Number(data && data.maxPlayers) || 5)),
      minutes: Math.max(1, Math.min(30, Number(data && data.minutes) || 5)),
      map: cleanMap(data && data.map)
    };

    rooms.set(room.code, room);
    playerRoom.set(socket.id, room.code);
    socket.join(`room-${room.code}`);

    socket.emit('seek:room-created', {
      code: room.code,
      count: 1,
      maxPlayers: room.maxPlayers
    });

    roomUpdate(room);
  });

  // JOIN A CUSTOM ROOM USING ITS FOUR-DIGIT CODE.
  socket.on('seek:join-room', data => {
    const code = String(data && data.code || '')
      .replace(/\D/g, '')
      .slice(0, 4);

    const room = rooms.get(code);

    if (!room) {
      return socket.emit('seek:error', {
        message: 'Room code not found.'
      });
    }

    if (playerMatch.has(socket.id) || playerRoom.has(socket.id)) {
      return socket.emit('seek:error', {
        message: 'Leave your current room or match first.'
      });
    }

    if (room.players.length >= room.maxPlayers) {
      return socket.emit('seek:error', {
        message: 'That room is full.'
      });
    }

    socket.data.seekName = cleanName(data && data.name);
    room.players.push(socket.id);
    playerRoom.set(socket.id, code);
    socket.join(`room-${code}`);

    socket.emit('seek:room-joined', {
      code,
      count: room.players.length,
      maxPlayers: room.maxPlayers
    });

    roomUpdate(room);
  });

  // ONLY THE HOST CAN START. TWO OR MORE PLAYERS REQUIRED.
  socket.on('seek:start-room', () => {
    const code = playerRoom.get(socket.id);
    const room = code && rooms.get(code);

    if (!room) {
      return socket.emit('seek:error', {
        message: 'You are not in a custom room.'
      });
    }

    if (room.host !== socket.id) {
      return socket.emit('seek:error', {
        message: 'Only the host can start the match.'
      });
    }

    if (room.players.length < 2) {
      return socket.emit('seek:error', {
        message: 'At least 2 players are needed.'
      });
    }

    startRoom(room);
  });

  // SOLO BOTS: ONE HUMAN PLUS FOUR COMPUTER PLAYERS.
  socket.on('seek:bot-match', data => {
    if (playerMatch.has(socket.id) || playerRoom.has(socket.id)) return;

    socket.data.seekName = cleanName(data && data.name);

    startMatch({
      sockets: [socket],
      bots: 4,
      map: cleanMap(data && data.map),
      minutes: Math.max(1, Math.min(30, Number(data && data.minutes) || 5))
    });
  });

  socket.on('seek:ready', () => {});

  // HUMAN PLAYER MOVEMENT.
  socket.on('seek:state', data => {
    const matchId = playerMatch.get(socket.id);
    const match = matchId && matches.get(matchId);
    const player = match && match.players.get(socket.id);

    if (!player || !data || data.matchId !== match.id) return;

    player.x = Number(data.x) || 0;
    player.z = Number(data.z) || 0;

    io.to(match.id).emit('seek:state', {
      id: socket.id,
      x: player.x,
      z: player.z,
      yaw: Number(data.yaw) || 0,
      pitch: Number(data.pitch) || 0,
      jy: Number(data.jy) || 0,
      eye: Number(data.eye) || 1.6,
      moving: !!data.moving,
      crouch: !!data.crouch,
      prone: !!data.prone
    });
  });

  // SEEKER CATCHES A HIDER.
  socket.on('seek:catch', data => {
    const matchId = playerMatch.get(socket.id);
    const match = matchId && matches.get(matchId);
    const seeker = match && match.players.get(socket.id);
    const target = match && match.players.get(data && data.targetId);

    if (
      !match ||
      match.phase !== 'hunt' ||
      !seeker ||
      seeker.role !== 'seeker' ||
      !target ||
      target.role !== 'hider' ||
      target.found ||
      data.matchId !== match.id
    ) return;

    if (Math.hypot(seeker.x - target.x, seeker.z - target.z) > 6) return;

    target.found = true;
    io.to(match.id).emit('seek:caught', { id: target.id });

    if (![...match.players.values()].some(
      p => p.role === 'hider' && !p.found
    )) {
      finishMatch(match, 'seeker');
    }
  });

  // DISCONNECT CLEANUP.
  socket.on('disconnect', () => {
    for (const queue of queues.values()) {
      const i = queue.findIndex(s => s.id === socket.id);
      if (i !== -1) queue.splice(i, 1);
    }

    const code = playerRoom.get(socket.id);
    const room = code && rooms.get(code);

    if (room) {
      room.players = room.players.filter(id => id !== socket.id);
      playerRoom.delete(socket.id);

      if (!room.players.length) {
        removeRoom(room);
      } else {
        if (room.host === socket.id) {
          room.host = room.players[0];
        }
        roomUpdate(room);
      }
    }

    const matchId = playerMatch.get(socket.id);
    const match = matchId && matches.get(matchId);

    if (!match) return;

    const leaving = match.players.get(socket.id);
    match.players.delete(socket.id);
    playerMatch.delete(socket.id);

    socket.to(match.id).emit('seek:player-left', {
      id: socket.id,
      name: leaving ? leaving.name : 'PLAYER'
    });

    const remaining = [...match.players.values()];

    if (!remaining.some(p => p.role === 'hider' && !p.found)) {
      finishMatch(match, 'seeker');
    } else if (!remaining.some(p => p.role === 'seeker')) {
      finishMatch(match, 'hiders');
    }
  });
});

server.listen(PORT, () => {
  console.log(`SEEK server listening on ${PORT}`);
});

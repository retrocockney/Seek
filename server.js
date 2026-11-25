
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: { origin: '*' },
  transports: ['websocket', 'polling']
});

app.use(express.static(__dirname));
app.get('/', (req, res) =>
  res.sendFile(path.join(__dirname, 'index.html'))
);

app.get('/health', (req, res) => {
  res.json({ ok: true, game: 'SEEK', playersPerMatch: 5 });
});

const MATCH_SIZE = 5;
const BLIND_SECONDS = 20;
const ROUND_SECONDS = 300;

const matches = new Map();
const queues = new Map();
const playerMatch = new Map();

function spawnPoint() {
  const angle = Math.random() * Math.PI * 2;
  const radius = 8 + Math.random() * 18;

  return {
    x: Math.cos(angle) * radius,
    z: Math.sin(angle) * radius
  };
}

function publicPlayer(player) {
  return {
    id: player.id,
    name: player.name,
    role: player.role,
    spawn: player.spawn
  };
}

function stopMatch(match) {
  if (match.timer) clearInterval(match.timer);

  matches.delete(match.id);

  for (const id of match.players.keys()) {
    playerMatch.delete(id);
  }
}

function finishMatch(match, winner) {
  if (!matches.has(match.id)) return;

  io.to(match.id).emit('seek:round-end', { winner });
  stopMatch(match);
}

function startMatch(map, sockets) {
  const id =
    `seek-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const players = sockets.map(socket => ({
    id: socket.id,
    name: socket.data.seekName || 'PLAYER',
    role: 'hider',
    spawn: spawnPoint(),
    x: 0,
    z: 0,
    found: false
  }));

  // Randomly select exactly ONE Seeker.
  const seekerIndex = Math.floor(Math.random() * MATCH_SIZE);
  players[seekerIndex].role = 'seeker';

  const match = {
    id,
    map,
    players: new Map(players.map(p => [p.id, p])),
    phase: 'blind',
    blindEndsAt: Date.now() + BLIND_SECONDS * 1000,
    endsAt: Date.now() + (BLIND_SECONDS + ROUND_SECONDS) * 1000,
    timer: null
  };

  matches.set(id, match);

  for (const socket of sockets) {
    playerMatch.set(socket.id, id);
    socket.join(id);
  }

  io.to(id).emit('seek:match', {
    matchId: id,
    map,
    phase: 'blind',
    blindT: BLIND_SECONDS,
    timeLeft: ROUND_SECONDS,
    players: players.map(publicPlayer)
  });

  match.timer = setInterval(() => {
    if (!matches.has(id)) return;

    const now = Date.now();

    if (match.phase === 'blind' && now >= match.blindEndsAt) {
      match.phase = 'hunt';
    }

    const blindT = Math.max(
      0,
      Math.ceil((match.blindEndsAt - now) / 1000)
    );

    const timeLeft = Math.max(
      0,
      Math.ceil(
        (match.endsAt - Math.max(now, match.blindEndsAt)) / 1000
      )
    );

    io.to(id).emit('seek:phase', {
      phase: match.phase,
      blindT,
      timeLeft
    });

    if (now >= match.endsAt) {
      finishMatch(match, 'hiders');
    }
  }, 1000);
}

io.on('connection', socket => {

  // JOIN MATCHMAKING
  socket.on('seek:join', ({ name, map } = {}) => {
    if (playerMatch.has(socket.id)) return;

    socket.data.seekName =
      String(name || 'PLAYER').trim().slice(0, 12) || 'PLAYER';

    const mapKey = String(map || 'bedroom').slice(0, 32);

    if (!queues.has(mapKey)) {
      queues.set(mapKey, []);
    }

    const queue = queues.get(mapKey);

    if (!queue.some(s => s.id === socket.id)) {
      queue.push(socket);
    }

    const updateQueue = () => {
      const active = queue.filter(s => s.connected);

      for (const s of active) {
        s.emit('seek:queue', {
          matchId: null,
          count: active.length,
          needed: MATCH_SIZE
        });
      }
    };

    updateQueue();

    // NEVER start until exactly five connected players are available.
    while (queue.filter(s => s.connected).length >= MATCH_SIZE) {
      const group = [];

      while (queue.length && group.length < MATCH_SIZE) {
        const next = queue.shift();

        if (next.connected && !playerMatch.has(next.id)) {
          group.push(next);
        }
      }

      if (group.length === MATCH_SIZE) {
        startMatch(mapKey, group);
      } else {
        queue.unshift(...group);
        break;
      }
    }

    updateQueue();
  });

  socket.on('seek:ready', () => {
    // The fifth player joining starts the match for everyone.
  });

  // PLAYER MOVEMENT
  socket.on('seek:state', data => {
    const matchId = playerMatch.get(socket.id);
    const match = matchId && matches.get(matchId);
    const player = match && match.players.get(socket.id);

    if (!player || !data || data.matchId !== match.id) return;

    player.x = Number(data.x) || 0;
    player.z = Number(data.z) || 0;

    socket.to(match.id).emit('seek:state', {
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

  // SEEKER CATCHES A HIDER
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
      target.found
    ) return;

    const distance = Math.hypot(
      seeker.x - target.x,
      seeker.z - target.z
    );

    if (distance > 5.5) return;

    target.found = true;

    io.to(match.id).emit('seek:caught', {
      id: target.id
    });

    const remaining = [...match.players.values()].some(
      p => p.role === 'hider' && !p.found
    );

    if (!remaining) {
      finishMatch(match, 'seeker');
    }
  });

  // PLAYER DISCONNECTS
  socket.on('disconnect', () => {
    for (const queue of queues.values()) {
      const index = queue.findIndex(s => s.id === socket.id);

      if (index !== -1) {
        queue.splice(index, 1);
      }
    }

    const matchId = playerMatch.get(socket.id);
    const match = matchId && matches.get(matchId);

    if (!match) return;

    const player = match.players.get(socket.id);

    match.players.delete(socket.id);
    playerMatch.delete(socket.id);

    socket.to(match.id).emit('seek:player-left', {
      id: socket.id,
      name: player ? player.name : 'PLAYER'
    });

    const active = [...match.players.values()];

    if (!active.some(p => p.role === 'hider' && !p.found)) {
      finishMatch(match, 'seeker');
    } else if (!active.some(p => p.role === 'seeker')) {
      finishMatch(match, 'hiders');
    }
  });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
  console.log(
    `SEEK server running on port ${PORT}. Matches require ${MATCH_SIZE} players.`
  );
});


const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  maxHttpBufferSize: 1e6
});

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

app.get('/', (_req, res) =>
  res.sendFile(path.join(__dirname, 'index.html'))
);

app.get('/health', (_req, res) =>
  res.json({
    ok: true,
    game: 'SEEK',
    online: io.engine.clientsCount
  })
);

// ONLINE-ONLY MATCHMAKING
const queues = new Map();
const matches = new Map();
const playerMatch = new Map();

const MAX_PLAYERS = 8;
const BLIND_SECONDS = 20;
const ROUND_SECONDS = 300;

function publicPlayer(p) {
  return {
    id: p.id,
    name: p.name,
    role: p.role,
    spawn: p.spawn,
    x: p.x,
    z: p.z
  };
}

function queueFor(map) {
  if (!queues.has(map)) queues.set(map, []);
  return queues.get(map);
}

function makeSpawn(index, map) {
  const bedroom = [
    {x:26,z:18}, {x:10,z:20},
    {x:38,z:15}, {x:55,z:16},
    {x:8,z:42}, {x:30,z:36},
    {x:48,z:38}, {x:25,z:42}
  ];

  const kitchen = [
    {x:8,z:20}, {x:15,z:38},
    {x:38,z:15}, {x:45,z:36},
    {x:8,z:42}, {x:30,z:36},
    {x:48,z:38}, {x:40,z:8}
  ];

  const points = map === 'kitchen' ? kitchen : bedroom;
  return points[index % points.length];
}

function emitPhase(match) {
  const now = Date.now();

  io.to(match.id).emit('seek:phase', {
    phase: match.phase,
    blindT: Math.max(
      0,
      Math.ceil((match.blindEnds - now) / 1000)
    ),
    timeLeft: Math.max(
      0,
      Math.ceil(
        (match.endsAt - Math.max(now, match.blindEnds)) / 1000
      )
    )
  });
}

function finishMatch(match, winner) {
  if (!match || match.finished) return;

  match.finished = true;

  io.to(match.id).emit('seek:round-end', { winner });

  clearInterval(match.timer);

  setTimeout(() => {
    for (const p of match.players.values()) {
      playerMatch.delete(p.id);
    }
    matches.delete(match.id);
  }, 12000).unref?.();
}

function startMatch(map, sockets) {
  const id =
    `seek-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

  const list = sockets.map((socket, i) => ({
    id: socket.id,
    name: socket.data.seekName || 'PLAYER',
    role: 'hider',
    spawn: makeSpawn(i, map),
    x: 0,
    z: 0,
    yaw: 0,
    pitch: 0,
    jy: 0,
    eye: 0.25,
    found: false
  }));

  list.forEach(p => {
    p.x = p.spawn.x;
    p.z = p.spawn.z;
  });

  list[Math.floor(Math.random() * list.length)].role = 'seeker';

  const now = Date.now();

  const match = {
    id,
    map,
    players: new Map(list.map(p => [p.id, p])),
    phase: 'blind',
    blindEnds: now + BLIND_SECONDS * 1000,
    endsAt: now + (BLIND_SECONDS + ROUND_SECONDS) * 1000,
    finished: false,
    timer: null
  };

  matches.set(id, match);

  for (const socket of sockets) {
    socket.join(id);
    playerMatch.set(socket.id, id);

    socket.emit('seek:match', {
      matchId: id,
      map,
      phase: match.phase,
      blindT: BLIND_SECONDS,
      timeLeft: ROUND_SECONDS,
      players: list.map(p => ({
        ...publicPlayer(p),
        spawn: p.spawn
      }))
    });
  }

  match.timer = setInterval(() => {
    if (match.finished) return;

    const now = Date.now();

    if (match.phase === 'blind' && now >= match.blindEnds) {
      match.phase = 'hunt';
    }

    if (now >= match.endsAt) {
      finishMatch(match, 'hiders');
      return;
    }

    const alive = [...match.players.values()].filter(
      p => p.role !== 'seeker' && !p.found
    );

    if (!alive.length) {
      finishMatch(match, 'seeker');
      return;
    }

    emitPhase(match);
  }, 250);
}

function tryMatch(map) {
  const q = queueFor(map);

  for (let i = q.length - 1; i >= 0; i--) {
    if (!q[i].connected || playerMatch.has(q[i].id)) {
      q.splice(i, 1);
    }
  }

  while (q.length >= 2) {
    const group = q.splice(0, Math.min(MAX_PLAYERS, q.length));
    startMatch(map, group);
  }

  for (const s of q) {
    s.emit('seek:queue', {
      count: q.length,
      matchId: null
    });
  }
}

io.on('connection', socket => {

  // JOIN ONLINE MATCHMAKING
  socket.on('seek:join', data => {
    if (playerMatch.has(socket.id)) {
      return socket.emit('seek:error', {
        message: 'You are already in a match.'
      });
    }

    const name = String(data?.name || 'PLAYER')
      .replace(/[^a-zA-Z0-9 _-]/g, '')
      .trim()
      .slice(0, 12) || 'PLAYER';

    const map = data?.map === 'kitchen'
      ? 'kitchen'
      : 'bedroom';

    socket.data.seekName = name;

    const q = queueFor(map);

    if (!q.some(s => s.id === socket.id)) {
      q.push(socket);
    }

    socket.emit('seek:queue', {
      count: q.length,
      matchId: null
    });

    tryMatch(map);
  });

  // PLAYER MOVEMENT
  socket.on('seek:state', data => {
    const matchId = playerMatch.get(socket.id);
    const match = matches.get(matchId);
    const p = match?.players.get(socket.id);

    if (!p || match.finished || data?.matchId !== matchId) return;

    const n = (v, fallback = 0) =>
      Number.isFinite(Number(v)) ? Number(v) : fallback;

    p.x = Math.max(0.5, Math.min(59.5, n(data.x)));
    p.z = Math.max(0.5, Math.min(47.5, n(data.z)));

    p.yaw = n(data.yaw);
    p.pitch = n(data.pitch);
    p.jy = n(data.jy);
    p.eye = n(data.eye, 0.25);

    p.moving = !!data.moving;
    p.crouch = !!data.crouch;
    p.prone = !!data.prone;

    socket.to(matchId).volatile.emit('seek:state', {
      id: p.id,
      x: p.x,
      z: p.z,
      yaw: p.yaw,
      pitch: p.pitch,
      jy: p.jy,
      eye: p.eye,
      moving: p.moving,
      crouch: p.crouch,
      prone: p.prone
    });
  });

  // SEEKER CATCHING
  socket.on('seek:catch', data => {
    const matchId = playerMatch.get(socket.id);
    const match = matches.get(matchId);

    const hunter = match?.players.get(socket.id);
    const target = match?.players.get(
      String(data?.targetId || '')
    );

    if (
      !match ||
      match.finished ||
      match.phase !== 'hunt' ||
      !hunter ||
      hunter.role !== 'seeker' ||
      !target ||
      target.role === 'seeker' ||
      target.found
    ) return;

    const distance = Math.hypot(
      hunter.x - target.x,
      hunter.z - target.z
    );

    if (distance > 18.5) return;

    target.found = true;

    io.to(matchId).emit('seek:caught', {
      id: target.id
    });

    if (
      [...match.players.values()].every(
        p => p.role === 'seeker' || p.found
      )
    ) {
      finishMatch(match, 'seeker');
    }
  });

  // PLAYER DISCONNECT
  socket.on('disconnect', () => {
    for (const [map, q] of queues) {
      const i = q.findIndex(s => s.id === socket.id);

      if (i >= 0) q.splice(i, 1);

      if (q.length) {
        for (const s of q) {
          s.emit('seek:queue', {
            count: q.length,
            matchId: null
          });
        }
      }
    }

    const matchId = playerMatch.get(socket.id);
    const match = matches.get(matchId);

    if (match) {
      const p = match.players.get(socket.id);

      match.players.delete(socket.id);
      playerMatch.delete(socket.id);

      socket.to(matchId).emit('seek:player-left', {
        id: socket.id,
        name: p?.name || 'PLAYER'
      });

      if (match.players.size < 2) {
        finishMatch(match, 'hiders');
      } else if (
        [...match.players.values()].every(
          x => x.role === 'seeker' || x.found
        )
      ) {
        finishMatch(match, 'seeker');
      }
    }
  });
});

server.listen(PORT, () => {
  console.log(`SEEK online server listening on ${PORT}`);
});

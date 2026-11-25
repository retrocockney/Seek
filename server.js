const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: '*' } });
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

const rooms = new Map();
const CAP = 20, DEFAULT_MAX = 10, MIN_PLAYERS = 2;
const ROUND_MS = 5 * 60 * 1000;

function makeCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c));
  return c;
}
function roomView(r) {
  return { code: r.code, max: r.max, host: r.host, started: r.started,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name, seeker: p.seeker, caught: p.caught })) };
}
function findRoom(socket) {
  for (const r of rooms.values()) if (r.players.has(socket.id)) return r;
  return null;
}
function join(socket, room, name) {
  socket.join(room.code);
  room.players.set(socket.id, { id: socket.id, name: String(name || 'PLAYER').slice(0, 12), seeker: false, caught: false, x: 0, z: 0, yaw: 0 });
  io.to(room.code).emit('roomUpdate', roomView(room));
}
function leave(socket) {
  const room = findRoom(socket);
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(room.code);
  if (room.players.size === 0) { clearTimeout(room.timer); rooms.delete(room.code); return; }
  if (room.host === socket.id) room.host = [...room.players.keys()][0];
  io.to(room.code).emit('roomUpdate', roomView(room));
  io.to(room.code).emit('playerLeft', { id: socket.id });
  if (room.started) checkWin(room);
}

function startRound(room) {
  room.started = true;
  for (const p of room.players.values()) { p.caught = false; p.seeker = false; }
  const ids = [...room.players.keys()];
  const seekerId = ids[Math.floor(Math.random() * ids.length)];
  room.players.get(seekerId).seeker = true;
  room.endAt = Date.now() + ROUND_MS;
  clearTimeout(room.timer);
  room.timer = setTimeout(() => endRound(room, 'hiders'), ROUND_MS);
  io.to(room.code).emit('roundStart', { endAt: room.endAt, seekerId, room: roomView(room) });
}

function endRound(room, winner) {
  if (!room.started) return;
  room.started = false;
  clearTimeout(room.timer);
  io.to(room.code).emit('roundEnd', { winner, room: roomView(room) });
}

function checkWin(room) {
  const seekers = [...room.players.values()].filter(p => p.seeker);
  const hiders = [...room.players.values()].filter(p => !p.seeker && !p.caught);
  if (seekers.length === 0 || room.players.size < MIN_PLAYERS) return endRound(room, 'none');
  if (hiders.length === 0) endRound(room, 'seeker');
}

io.on('connection', socket => {
  socket.on('createRoom', ({ name, max }, cb) => {
    const m = Math.max(2, Math.min(CAP, parseInt(max, 10) || DEFAULT_MAX));
    const code = makeCode();
    const room = { code, max: m, host: socket.id, started: false, endAt: 0, timer: null, players: new Map() };
    rooms.set(code, room);
    join(socket, room, name);
    cb({ ok: true, room: roomView(room) });
  });

  socket.on('joinRoom', ({ code, name }, cb) => {
    const room = rooms.get(String(code));
    if (!room) return cb({ ok: false, error: 'No room with that code' });
    if (room.started) return cb({ ok: false, error: 'Game already started' });
    if (room.players.size >= room.max) return cb({ ok: false, error: 'Room is full' });
    join(socket, room, name);
    cb({ ok: true, room: roomView(room) });
  });

  socket.on('startGame', cb => {
    const room = findRoom(socket);
    if (!room || room.host !== socket.id) return cb({ ok: false, error: 'Only the host can start' });
    if (room.started) return cb({ ok: false, error: 'Round already running' });
    if (room.players.size < MIN_PLAYERS) return cb({ ok: false, error: 'Need at least 2 players' });
    startRound(room);
    cb({ ok: true });
  });

  socket.on('move', state => {
    const room = findRoom(socket);
    if (!room || !room.started) return;
    const p = room.players.get(socket.id);
    if (!p) return;
    p.x = Number(state.x) || 0; p.z = Number(state.z) || 0; p.yaw = Number(state.yaw) || 0;
    socket.to(room.code).emit('playerMoved', { id: socket.id, x: p.x, z: p.z, yaw: p.yaw, seeker: p.seeker, caught: p.caught });
  });

  socket.on('caught', ({ targetId }, cb) => {
    const room = findRoom(socket);
    if (!room || !room.started) return cb && cb({ ok: false });
    const seeker = room.players.get(socket.id), target = room.players.get(targetId);
    if (!seeker || !target || !seeker.seeker || target.seeker || target.caught || targetId === socket.id) {
      return cb && cb({ ok: false });
    }
    target.caught = true;
    io.to(room.code).emit('playerCaught', { id: targetId, by: socket.id });
    checkWin(room);
    cb && cb({ ok: true });
  });

  socket.on('leaveRoom', () => leave(socket));
  socket.on('disconnect', () => leave(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('listening on ' + PORT));

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
const CAP = 20, DEFAULT_MAX = 10;

function makeCode() {
  let c;
  do { c = String(Math.floor(1000 + Math.random() * 9000)); } while (rooms.has(c));
  return c;
}
function roomView(r) {
  return { code: r.code, max: r.max, host: r.host, started: r.started,
    players: [...r.players.values()].map(p => ({ id: p.id, name: p.name })) };
}
function findRoom(socket) {
  for (const r of rooms.values()) if (r.players.has(socket.id)) return r;
  return null;
}
function join(socket, room, name) {
  socket.join(room.code);
  room.players.set(socket.id, { id: socket.id, name: String(name || 'PLAYER').slice(0, 12) });
  io.to(room.code).emit('roomUpdate', roomView(room));
}
function leave(socket) {
  const room = findRoom(socket);
  if (!room) return;
  room.players.delete(socket.id);
  socket.leave(room.code);
  if (room.players.size === 0) { rooms.delete(room.code); return; }
  if (room.host === socket.id) room.host = [...room.players.keys()][0];
  io.to(room.code).emit('roomUpdate', roomView(room));
  io.to(room.code).emit('playerLeft', { id: socket.id });
}

io.on('connection', socket => {
  socket.on('createRoom', ({ name, max }, cb) => {
    const m = Math.max(2, Math.min(CAP, parseInt(max, 10) || DEFAULT_MAX));
    const code = makeCode();
    const room = { code, max: m, host: socket.id, started: false, players: new Map() };
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
    if (room.players.size < 2) return cb({ ok: false, error: 'Need at least 2 players' });
    room.started = true;
    io.to(room.code).emit('gameStarted', roomView(room));
    cb({ ok: true });
  });

  socket.on('move', state => {
    const room = findRoom(socket);
    if (!room || !room.started) return;
    socket.to(room.code).emit('playerMoved', { id: socket.id, ...state });
  });

  socket.on('leaveRoom', () => leave(socket));
  socket.on('disconnect', () => leave(socket));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('listening on ' + PORT));

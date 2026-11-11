const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;

app.use(express.static(__dirname));

const rooms = {};

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return rooms[c] ? genCode() : c;
}

function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function won(hand, N) {
  const c = {};
  for (const x of hand) c[x] = (c[x] || 0) + 1;
  for (const k in c) if (c[k] >= N) return true;
  return false;
}

function derive(room) {
  const N = room.order.length;
  const hands = {}, taken = {};
  const S = { N, hands, taken, stage: 'table', pickTurn: null, cur: null, next: null, winner: null };
  for (const u of room.order) hands[u] = [];
  if (room.phase === 'table') return S;
  for (const p of room.picks) {
    if (hands[p.uid] && !taken[p.chit]) {
      hands[p.uid].push(room.layout[p.chit]);
      taken[p.chit] = 1;
    }
  }
  if (room.picks.length < N * N) {
    S.stage = 'pick';
    S.pickTurn = room.order[room.picks.length % N];
    return S;
  }
  S.stage = 'play';
  for (let i = 0; i < N; i++) {
    if (won(hands[room.order[i]], N)) {
      S.winner = room.order[i]; S.stage = 'done'; return S;
    }
  }
  let t = room.starter;
  for (const m of room.moves) {
    const f = room.order[t], to = room.order[(t + 1) % N];
    const ix = hands[f].indexOf(m.v);
    if (ix < 0) continue;
    hands[f].splice(ix, 1);
    hands[to].push(m.v);
    t = (t + 1) % N;
    if (won(hands[to], N)) { S.winner = to; S.stage = 'done'; return S; }
  }
  S.cur = room.order[t];
  S.next = room.order[(t + 1) % N];
  return S;
}

function state(room) {
  const S = derive(room);
  return {
    code: room.code, host: room.host, phase: room.phase,
    order: room.order, names: room.names, players: room.players,
    starter: room.starter, seed: room.seed, layout: room.layout,
    stage: S.stage, pickTurn: S.pickTurn, cur: S.cur,
    turnNext: S.next, winner: S.winner, hands: S.hands, taken: S.taken
  };
}

function broadcast(room) { io.to(room.code).emit('state', state(room)); }

io.on('connection', (socket) => {

  socket.on('create', ({ uid, name }, cb) => {
    const code = genCode();
    const room = {
      code, host: uid, phase: 'lobby',
      order: [uid], names: [], players: {},
      picks: [], moves: [], layout: [],
      starter: 0, seed: 0
    };
    room.players[uid] = { name: String(name).trim(), t: Date.now() };
    rooms[code] = room;
    socket.join(code);
    cb({ ok: true, code });
    broadcast(room);
  });

  socket.on('join', ({ uid, name, code }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: 'Ye code nahi mila' });
    if (!room.players[uid] && room.phase !== 'lobby')
      return cb({ ok: false, error: 'Game shuru ho chuka hai' });

    if (!room.players[uid]) {
      const trimmed = String(name).trim();
      const lower = trimmed.toLowerCase();
      const taken = Object.values(room.players).some(
        p => String(p.name).trim().toLowerCase() === lower
      );
      if (taken) return cb({ ok: false, error: 'Ye naam already taken hai. Doosra naam chuno.' });
      if (room.order.length >= 6) return cb({ ok: false, error: 'Game full hai (max 6)' });
      room.players[uid] = { name: trimmed, t: Date.now() };
      room.order.push(uid);
    }

    socket.join(code);
    cb({ ok: true, code });
    broadcast(room);
  });

  socket.on('start', ({ uid, code }) => {
    const room = rooms[code];
    if (!room || room.host !== uid || room.phase !== 'lobby') return;
    const n = room.order.length;
    if (n < 2) return;

    const seen = {};
    const finalNames = room.order.map(u => {
      const nm = room.players[u].name;
      if (!seen[nm]) { seen[nm] = 1; return nm; }
      seen[nm]++;
      return nm + ' ' + seen[nm];
    });

    const vals = [];
    for (let v = 0; v < n; v++) for (let k = 0; k < n; k++) vals.push(v);

    room.phase = 'table';
    room.order = shuffle(room.order);
    room.names = finalNames;
    room.layout = shuffle(vals);
    room.starter = Math.floor(Math.random() * n);
    room.seed = Math.floor(Math.random() * 2147483647);
    broadcast(room);
  });

  socket.on('scatter', ({ uid, code }) => {
    const room = rooms[code];
    if (!room || room.host !== uid || room.phase !== 'table') return;
    room.phase = 'scatter';
    broadcast(room);
  });

  socket.on('pick', ({ uid, code, chit }) => {
    const room = rooms[code];
    if (!room || room.phase === 'table') return;
    const S = derive(room);
    if (S.stage !== 'pick' || S.pickTurn !== uid || S.taken[chit]) return;
    room.picks.push({ uid, chit });
    broadcast(room);
  });

  socket.on('pass', ({ uid, code, v }) => {
    const room = rooms[code];
    if (!room) return;
    const S = derive(room);
    if (S.stage !== 'play' || S.cur !== uid) return;
    room.moves.push({ uid, v });
    broadcast(room);
  });

  socket.on('rematch', ({ uid, code }) => {
    const room = rooms[code];
    if (!room || room.host !== uid) return;
    room.phase = 'lobby';
    room.picks = []; room.moves = []; room.layout = [];
    room.names = []; room.starter = 0; room.seed = 0;
    room.order = Object.keys(room.players)
      .sort((a, b) => room.players[a].t - room.players[b].t);
    broadcast(room);
  });

});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Sola Chitthi running on port ${PORT}`);
});

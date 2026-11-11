const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
app.use(express.static(__dirname));

const rooms = {};

const POINTS_TABLE = {
  4:  [1000, 800, 600, 400],
  5:  [1000, 800, 600, 400, 200],
  6:  [1000, 850, 700, 550, 400, 250],
  7:  [1000, 850, 700, 550, 400, 250, 100],
  8:  [1000, 875, 750, 625, 500, 375, 250, 125],
  9:  [1000, 900, 800, 700, 600, 500, 400, 300, 200],
  10: [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100]
};

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

function won(hand, needed) {
  const c = {};
  for (const x of hand) c[x] = (c[x] || 0) + 1;
  for (const k in c) if (c[k] >= needed) return true;
  return false;
}

function winNeed(N) {
  if (N <= 5) return 4;
  if (N === 6) return 5;
  if (N <= 8) return 6;
  return 7;
}

function computeState(room) {
  const N = room.order.length;
  const M = room.winNeed || 4;
  const totalCards = N * M;
  const hands = {}, taken = {};
  const S = {
    N, M, hands, taken,
    stage: 'table',
    pickTurn: null, cur: null, next: null, winner: null,
    remainingInTurn: 0,
    rankings: room.rankings || [],
    rankingDeadline: room.rankingDeadline || 0,
    winningType: null
  };

  for (const u of room.order) hands[u] = [];
  if (room.phase === 'table' || room.phase === 'lobby') return S;

  for (const p of room.picks) {
    if (hands[p.uid] && !taken[p.chit]) {
      hands[p.uid].push(room.layout[p.chit]);
      taken[p.chit] = 1;
    }
  }

  // If already in ranking/scored phase, return current hands + stage
  if (room.phase === 'ranking' || room.phase === 'scored') {
    S.stage = room.phase === 'scored' ? 'scored' : 'ranking';
    S.winner = room.rankings[0] || null;
    if (S.winner) S.winningType = findWinningType(hands[S.winner], M);
    return S;
  }

  // Still picking
  if (room.picks.length < totalCards) {
    S.stage = 'pick';
    S.pickTurn = room.order[Math.floor(room.picks.length / M)];
    S.remainingInTurn = M - (room.picks.length % M);
    return S;
  }

  // Check win from picks
  for (let i = 0; i < N; i++) {
    if (won(hands[room.order[i]], M)) {
      S.winner = room.order[i];
      S.winningType = findWinningType(hands[S.winner], M);
      S.stage = 'gameover';
      return S;
    }
  }

  // Play phase
  let t = room.starter;
  for (const m of room.moves) {
    const f = room.order[t], to = room.order[(t + 1) % N];
    const ix = hands[f].indexOf(m.v);
    if (ix < 0) continue;
    hands[f].splice(ix, 1);
    hands[to].push(m.v);
    t = (t + 1) % N;
    if (won(hands[to], M)) {
      S.winner = to;
      S.winningType = findWinningType(hands[to], M);
      S.stage = 'gameover';
      return S;
    }
  }

  S.stage = 'play';
  S.cur = room.order[t];
  S.next = room.order[(t + 1) % N];
  return S;
}

function findWinningType(hand, M) {
  const c = {};
  for (const x of hand) c[x] = (c[x] || 0) + 1;
  for (const k in c) if (c[k] >= M) return parseInt(k);
  return -1;
}

function state(room) {
  const S = computeState(room);
  return {
    code: room.code, host: room.host, phase: room.phase,
    order: room.order, names: room.names, players: room.players,
    starter: room.starter, seed: room.seed, layout: room.layout,
    stage: S.stage, pickTurn: S.pickTurn, cur: S.cur, turnNext: S.next,
    winner: S.winner, winningType: S.winningType,
    hands: S.hands, taken: S.taken,
    winNeed: room.winNeed || 4, remainingInTurn: S.remainingInTurn,
    rankings: room.rankings || [], rankingDeadline: room.rankingDeadline || 0,
    roundNumber: room.roundNumber || 1,
    lastRoundPoints: room.lastRoundPoints || null
  };
}

function broadcast(room) { io.to(room.code).emit('state', state(room)); }

function enterRanking(room, winner) {
  room.phase = 'ranking';
  room.rankings = [winner];
  room.rankingDeadline = Date.now() + 30000;
  setTimeout(() => autoFillRanks(room), 30000);
  broadcast(room);
}

function autoFillRanks(room) {
  if (room.phase !== 'ranking') return;
  const remaining = room.order
    .filter(u => !room.rankings.includes(u))
    .sort((a, b) => room.players[b].t - room.players[a].t);
  room.rankings.push(...remaining);
  finishScoring(room);
}

function finishScoring(room) {
  if (room.phase === 'scored') return;
  room.phase = 'scored';
  const N = room.order.length;
  const points = POINTS_TABLE[N] || [];
  const earned = {};
  room.rankings.forEach((uid, i) => {
    const p = points[i] || 0;
    earned[uid] = p;
    room.players[uid].points = (room.players[uid].points || 0) + p;
    room.players[uid].rounds = (room.players[uid].rounds || 0) + 1;
  });
  room.lastRoundPoints = earned;
  broadcast(room);
}

io.on('connection', (socket) => {

  socket.on('create', ({ uid, name, chit }, cb) => {
    const code = genCode();
    const room = {
      code, host: uid, phase: 'lobby',
      order: [uid], names: [], players: {},
      picks: [], moves: [], layout: [],
      starter: 0, seed: 0, winNeed: 0,
      rankings: [], rankingDeadline: 0,
      roundNumber: 1, lastRoundPoints: null
    };
    room.players[uid] = {
      name: String(name).trim(),
      chit: String(chit).trim(),
      t: Date.now(),
      points: 0,
      rounds: 0
    };
    rooms[code] = room;
    socket.join(code);
    cb({ ok: true, code });
    broadcast(room);
  });

  socket.on('join', ({ uid, name, chit, code }, cb) => {
    const room = rooms[code];
    if (!room) return cb({ ok: false, error: 'Room not found' });
    if (!room.players[uid] && room.phase !== 'lobby')
      return cb({ ok: false, error: 'Game has already started' });

    if (!room.players[uid]) {
      const trimmedName = String(name).trim();
      const trimmedChit = String(chit).trim();
      if (!trimmedName) return cb({ ok: false, error: 'Name cannot be empty' });
      if (!trimmedChit) return cb({ ok: false, error: 'Card label cannot be empty' });

      const lowerName = trimmedName.toLowerCase();
      const lowerChit = trimmedChit.toLowerCase();
      const players = Object.values(room.players);

      if (players.some(p => String(p.name).trim().toLowerCase() === lowerName))
        return cb({ ok: false, error: 'That player name is taken. Try another.' });
      if (players.some(p => String(p.chit).trim().toLowerCase() === lowerChit))
        return cb({ ok: false, error: 'That card label is taken. Try another.' });

      if (room.order.length >= 10) return cb({ ok: false, error: 'Room is full (max 10 players)' });

      room.players[uid] = {
        name: trimmedName,
        chit: trimmedChit,
        t: Date.now(),
        points: 0,
        rounds: 0
      };
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

    const M = winNeed(n);
    room.order = shuffle(room.order);
    room.names = room.order.map(u => room.players[u].chit);

    const vals = [];
    for (let v = 0; v < n; v++) for (let k = 0; k < M; k++) vals.push(v);

    room.phase = 'table';
    room.layout = shuffle(vals);
    room.winNeed = M;
    room.starter = Math.floor(Math.random() * n);
    room.seed = Math.floor(Math.random() * 2147483647);
    room.picks = [];
    room.moves = [];
    room.rankings = [];
    room.rankingDeadline = 0;
    room.lastRoundPoints = null;
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
    if (!room || room.phase !== 'scatter') return;
    const S = computeState(room);
    if (S.stage !== 'pick' || S.pickTurn !== uid || S.taken[chit]) return;
    room.picks.push({ uid, chit });
    const newS = computeState(room);
    if (newS.stage === 'gameover') {
      enterRanking(room, newS.winner);
    } else {
      broadcast(room);
    }
  });

  socket.on('pass', ({ uid, code, v }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'scatter') return;
    const S = computeState(room);
    if (S.stage !== 'play' || S.cur !== uid) return;
    room.moves.push({ uid, v });
    const newS = computeState(room);
    if (newS.stage === 'gameover') {
      enterRanking(room, newS.winner);
    } else {
      broadcast(room);
    }
  });

  socket.on('claim', ({ uid, code }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'ranking') return;
    if (room.rankings.includes(uid)) return;
    room.rankings.push(uid);
    if (room.rankings.length >= room.order.length) {
      finishScoring(room);
    } else {
      broadcast(room);
    }
  });

  socket.on('nextRound', ({ uid, code }) => {
    const room = rooms[code];
    if (!room || room.host !== uid || room.phase !== 'scored') return;
    room.phase = 'lobby';
    room.picks = [];
    room.moves = [];
    room.layout = [];
    room.names = [];
    room.rankings = [];
    room.rankingDeadline = 0;
    room.winNeed = 0;
    room.roundNumber = (room.roundNumber || 1) + 1;
    room.lastRoundPoints = null;
    room.order = Object.keys(room.players).sort((a, b) => room.players[a].t - room.players[b].t);
    broadcast(room);
  });

});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Sola Chitthi running on port ${PORT}`);
});

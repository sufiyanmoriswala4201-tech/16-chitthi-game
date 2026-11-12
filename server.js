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
  4: [1000, 800, 600, 400],
  5: [1000, 800, 600, 400, 200],
  6: [1000, 850, 700, 550, 400, 250],
  7: [1000, 850, 700, 550, 400, 250, 100],
  8: [1000, 875, 750, 625, 500, 375, 250, 125],
  9: [1000, 900, 800, 700, 600, 500, 400, 300, 200],
  10: [1000, 900, 800, 700, 600, 500, 400, 300, 200, 100]
};

function winNeed(N) {
  if (N <= 5) return 4;
  if (N === 6) return 5;
  if (N <= 8) return 6;
  return 7;
}

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

function findWinningType(hand, M) {
  const c = {};
  for (const x of hand) c[x] = (c[x] || 0) + 1;
  for (const k in c) if (c[k] >= M) return parseInt(k);
  return -1;
}

function computeState(room) {
  const N = room.order.length;
  const M = room.winNeed || 4;
  const totalCards = N * N;
  const hands = {}, taken = {};
  const S = {
    N, M, hands, taken, stage: 'table',
    pickTurn: null, cur: null, next: null, winner: null,
    remainingInTurn: 0, winningType: null
  };
  for (const u of room.order) hands[u] = [];
  if (room.phase === 'table' || room.phase === 'lobby') return S;

  for (const p of room.picks) {
    if (hands[p.uid] && !taken[p.chit]) {
      hands[p.uid].push(room.layout[p.chit]);
      taken[p.chit] = 1;
    }
  }

  if (room.phase === 'ranking' || room.phase === 'scored') {
    S.stage = room.phase === 'scored' ? 'scored' : 'ranking';
    S.winner = room.rankings[0] || null;
    if (S.winner) S.winningType = findWinningType(hands[S.winner], M);
    return S;
  }

  if (room.picks.length < totalCards) {
    S.stage = 'pick';
    S.pickTurn = room.order[Math.floor(room.picks.length / N)];
    S.remainingInTurn = N - (room.picks.length % N);
    return S;
  }

  for (let i = 0; i < N; i++) {
    if (won(hands[room.order[i]], M)) {
      S.winner = room.order[i];
      S.winningType = findWinningType(hands[S.winner], M);
      S.stage = 'gameover';
      return S;
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
    rankings: Array.isArray(room.rankings) ? room.rankings : [],
    rankingDeadline: room.rankingDeadline || 0,
    roundNumber: room.roundNumber || 1,
    lastRoundPoints: room.lastRoundPoints || null,
    serverNow: Date.now(),
    turnDeadline: room.turnDeadline || 0,
    turnDuration: room.turnDuration || 0,
    botCount: room.order.filter(u => room.players[u] && room.players[u].isBot).length
  };
}

function broadcast(room) { io.to(room.code).emit('state', state(room)); }

function clearPassTimer(room) {
  if (room._passTimer) { clearTimeout(room._passTimer); room._passTimer = null; }
  room.turnDeadline = 0; room.turnDuration = 0;
}

function startPassTimer(room, precomputed) {
  clearPassTimer(room);
  const S = precomputed || computeState(room);
  if (S.stage !== 'play') return;
  const N = room.order.length;
  const cycle = Math.floor(room.moves.length / N);
  const duration = Math.max(3, 10 - cycle);
  room.turnDuration = duration;
  room.turnDeadline = Date.now() + duration * 1000;
  room._passTimer = setTimeout(() => autoPass(room), duration * 1000);
}

function autoPass(room) {
  const S = computeState(room);
  if (S.stage !== 'play' || !S.cur) return;
  const uid = S.cur;
  const hand = S.hands[uid] || [];
  if (hand.length === 0) return;
  const v = hand[Math.floor(Math.random() * hand.length)];
  room.moves.push({ uid, v, auto: true });
  io.to(room.code).emit('autoPassed', { name: room.players[uid].name });
  const newS = computeState(room);
  if (newS.stage === 'gameover') {
    enterRanking(room, newS.winner);
  } else {
    startPassTimer(room, newS);
    broadcast(room);
    scheduleBotIfNeeded(room);
  }
}

/* ===== BOT LOGIC ===== */

function clearBotTimers(room) {
  if (room._botTimer) { clearTimeout(room._botTimer); room._botTimer = null; }
  if (room._botClaimTimers) {
    Object.values(room._botClaimTimers).forEach(t => clearTimeout(t));
    room._botClaimTimers = {};
  }
}

function scheduleBotIfNeeded(room) {
  if (!room) return;
  if (room._botTimer) return;
  const S = computeState(room);
  const target = (S.stage === 'pick' && S.pickTurn) || (S.stage === 'play' && S.cur);
  if (!target) return;
  if (!room.players[target] || !room.players[target].isBot) return;

  const delay = 700 + Math.random() * 900;
  room._botTimer = setTimeout(() => {
    room._botTimer = null;
    executeBotMove(room);
  }, delay);
}

function executeBotMove(room) {
  if (!rooms[room.code] || rooms[room.code] !== room) return;
  const S = computeState(room);

  if (S.stage === 'pick' && S.pickTurn && room.players[S.pickTurn] && room.players[S.pickTurn].isBot) {
    const avail = [];
    for (let i = 0; i < room.layout.length; i++) if (!S.taken[i]) avail.push(i);
    if (avail.length === 0) return;
    const chit = avail[Math.floor(Math.random() * avail.length)];
    room.picks.push({ uid: S.pickTurn, chit });
    const newS = computeState(room);
    if (newS.stage === 'gameover') {
      enterRanking(room, newS.winner);
    } else if (newS.stage === 'play') {
      startPassTimer(room, newS);
      broadcast(room);
      scheduleBotIfNeeded(room);
    } else {
      broadcast(room);
      scheduleBotIfNeeded(room);
    }
  } else if (S.stage === 'play' && S.cur && room.players[S.cur] && room.players[S.cur].isBot) {
    const hand = S.hands[S.cur];
    if (hand.length === 0) return;
    const counts = {};
    hand.forEach(v => counts[v] = (counts[v] || 0) + 1);
    let best = hand[0], bestCount = counts[hand[0]];
    for (const v of hand) if (counts[v] < bestCount) { best = v; bestCount = counts[v]; }
    clearPassTimer(room);
    room.moves.push({ uid: S.cur, v: best });
    const newS = computeState(room);
    if (newS.stage === 'gameover') {
      enterRanking(room, newS.winner);
    } else {
      startPassTimer(room, newS);
      broadcast(room);
      scheduleBotIfNeeded(room);
    }
  }
}

function scheduleBotClaims(room) {
  if (!room || room.phase !== 'ranking') return;
  if (!room._botClaimTimers) room._botClaimTimers = {};
  room.order.forEach(botId => {
    if (!room.players[botId] || !room.players[botId].isBot) return;
    if (room.rankings.includes(botId)) return;
    if (room._botClaimTimers[botId]) return;
    const delay = 1200 + Math.random() * 2200;
    room._botClaimTimers[botId] = setTimeout(() => {
      delete room._botClaimTimers[botId];
      if (rooms[room.code] !== room) return;
      if (room.phase !== 'ranking') return;
      if (room.rankings.includes(botId)) return;
      room.rankings.push(botId);
      if (room.rankings.length >= room.order.length) {
        finishScoring(room);
      } else {
        broadcast(room);
      }
    }, delay);
  });
}

/* ===== RANKING ===== */

function enterRanking(room, winner) {
  clearPassTimer(room);
  clearBotTimers(room);
  room.phase = 'ranking';
  room.rankings = [winner];
  room.rankingDeadline = Date.now() + 30000;
  setTimeout(() => autoFillRanks(room), 30000);
  scheduleBotClaims(room);
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
  clearBotTimers(room);
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

/* ===== SOCKETS ===== */

io.on('connection', (socket) => {

  socket.on('create', ({ uid, name, chit }, cb) => {
    const code = genCode();
    const room = {
      code, host: uid, phase: 'lobby',
      order: [uid], names: [], players: {},
      picks: [], moves: [], layout: [],
      starter: 0, seed: 0, winNeed: 0,
      rankings: [], rankingDeadline: 0,
      roundNumber: 1, lastRoundPoints: null,
      _botTimer: null, _botClaimTimers: {}, _passTimer: null
    };
    room.players[uid] = {
      name: String(name).trim(),
      chit: String(chit).trim(),
      t: Date.now(), points: 0, rounds: 0, isBot: false
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
        name: trimmedName, chit: trimmedChit,
        t: Date.now(), points: 0, rounds: 0, isBot: false
      };
      room.order.push(uid);
    }

    socket.join(code);
    cb({ ok: true, code });
    broadcast(room);
  });

  socket.on('addBot', ({ uid, code }, cb) => {
    const room = rooms[code];
    if (!room || room.host !== uid || room.phase !== 'lobby') return cb && cb({ ok: false });
    if (room.order.length >= 10) return cb && cb({ ok: false, error: 'Room is full' });
    const botCount = room.order.filter(u => room.players[u] && room.players[u].isBot).length;
    if (botCount >= 3) return cb && cb({ ok: false, error: 'Max 3 bots' });

    let num = botCount + 1;
    let botName = 'Bot ' + num;
    const names = Object.values(room.players).map(p => p.name.toLowerCase());
    while (names.includes(botName.toLowerCase())) { num++; botName = 'Bot ' + num; }

    let cNum = num;
    let botChit = '🤖' + cNum;
    const chits = Object.values(room.players).map(p => p.chit.toLowerCase());
    while (chits.includes(botChit.toLowerCase())) { cNum++; botChit = '🤖' + cNum; }

    const botId = 'bot_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    room.players[botId] = {
      name: botName, chit: botChit,
      t: Date.now(), points: 0, rounds: 0, isBot: true
    };
    room.order.push(botId);
    cb && cb({ ok: true });
    broadcast(room);
  });

  socket.on('removeBot', ({ uid, code }, cb) => {
    const room = rooms[code];
    if (!room || room.host !== uid || room.phase !== 'lobby') return cb && cb({ ok: false });
    const bots = room.order.filter(u => room.players[u] && room.players[u].isBot);
    if (bots.length === 0) return cb && cb({ ok: false });
    const botId = bots[bots.length - 1];
    delete room.players[botId];
    room.order = room.order.filter(u => u !== botId);
    cb && cb({ ok: true });
    broadcast(room);
  });

  socket.on('start', ({ uid, code }) => {
    const room = rooms[code];
    if (!room || room.host !== uid || room.phase !== 'lobby') return;
    const n = room.order.length;
    if (n < 4) return;

    clearBotTimers(room);
    clearPassTimer(room);
    const M = winNeed(n);
    room.order = shuffle(room.order);
    room.names = room.order.map(u => room.players[u].chit);

    const vals = [];
    for (let v = 0; v < n; v++) for (let k = 0; k < n; k++) vals.push(v);

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
    scheduleBotIfNeeded(room);
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
    } else if (newS.stage === 'play') {
      startPassTimer(room, newS);
      broadcast(room);
      scheduleBotIfNeeded(room);
    } else {
      broadcast(room);
      scheduleBotIfNeeded(room);
    }
  });

  socket.on('pass', ({ uid, code, v }) => {
    const room = rooms[code];
    if (!room || room.phase !== 'scatter') return;
    const S = computeState(room);
    if (S.stage !== 'play' || S.cur !== uid) return;
    clearPassTimer(room);
    room.moves.push({ uid, v });
    const newS = computeState(room);
    if (newS.stage === 'gameover') {
      enterRanking(room, newS.winner);
    } else {
      startPassTimer(room, newS);
      broadcast(room);
      scheduleBotIfNeeded(room);
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
    clearBotTimers(room);
    clearPassTimer(room);
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

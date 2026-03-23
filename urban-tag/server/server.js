// server.js — HTTP + WebSocket server

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const cors       = require("cors");
const path       = require("path");

const {
  createGame, startGame, tagRunner,
  setGoal, checkGoalReached,
  startTransport, stopTransport, getTransportCost,
  getChallenges, completeChallenge, vetoChallenge, resolveVeto,
  getPlayer, getCurrentRunner, serializeState,
  VETO_DURATION_MS, JAIL_DURATION_MS, JAIL_RADIUS_METERS,
} = require("./game");

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
  allowEIO3: true,
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(cors());
app.use(express.json());

const CLIENT_DIR = path.join(__dirname, "..", "client");
app.use(express.static(CLIENT_DIR));

// ─── State ────────────────────────────────────────────────────────────────────

let gameState    = null;
let vetoTimeout  = null;   // server-side setTimeout for veto resolution
let jailTimeout  = null;   // server-side setTimeout for jail expiry

const playerSockets = {};  // { [playerId]: socketId }

// ─── Helpers ──────────────────────────────────────────────────────────────────

function broadcastState() {
  io.emit("state:update", serializeState(gameState));
}

function requireGame(res) {
  if (!gameState) {
    res.status(400).json({ error: "No game in progress." });
    return false;
  }
  return true;
}

// ─── Veto timer management ────────────────────────────────────────────────────

function startVetoTimeout() {
  clearTimeout(vetoTimeout);
  vetoTimeout = setTimeout(() => {
    if (!gameState) return;
    gameState = resolveVeto(gameState);
    broadcastState();
    io.emit("veto:resolved", { challenge: gameState.activeChallenge });
  }, VETO_DURATION_MS);
}

function clearVetoTimeout() {
  clearTimeout(vetoTimeout);
  vetoTimeout = null;
}

// ─── Jail timer management ────────────────────────────────────────────────────

function startJailTimeout() {
  clearTimeout(jailTimeout);
  jailTimeout = setTimeout(() => {
    if (!gameState) return;
    gameState.jailTimer = null;
    broadcastState();
    io.emit("jail:released");
  }, JAIL_DURATION_MS);
}

function clearJailTimeout() {
  clearTimeout(jailTimeout);
  jailTimeout = null;
}

// ─── REST — Game lifecycle ─────────────────────────────────────────────────────

// POST /api/game/create  { players: string[] }
app.post("/api/game/create", (req, res) => {
  try {
    clearVetoTimeout();
    clearJailTimeout();
    gameState = createGame(req.body.players);
    broadcastState();
    res.json({ ok: true, state: serializeState(gameState) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/game/start
app.post("/api/game/start", (req, res) => {
  if (!requireGame(res)) return;
  try {
    gameState = startGame(gameState);
    broadcastState();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/game/state
app.get("/api/game/state", (req, res) => {
  if (!gameState) return res.json(null);
  res.json(serializeState(gameState));
});

// DELETE /api/game  (Gamemaster reset)
app.delete("/api/game", (req, res) => {
  clearVetoTimeout();
  clearJailTimeout();
  gameState = null;
  io.emit("game:reset");
  res.json({ ok: true });
});

// ─── REST — Goals ─────────────────────────────────────────────────────────────

// POST /api/goal/set  { playerId, lat, lng, label }
app.post("/api/goal/set", (req, res) => {
  if (!requireGame(res)) return;
  try {
    const { playerId, lat, lng, label } = req.body;
    gameState = setGoal(gameState, playerId, { lat, lng, label });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/goal/check  { playerId, lat, lng }
app.post("/api/goal/check", (req, res) => {
  if (!requireGame(res)) return;
  try {
    const { playerId, lat, lng } = req.body;
    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat and lng must be numbers." });
    }
    const result = checkGoalReached(gameState, playerId, { lat, lng });
    if (result.reached) {
      io.emit("goal:reached", {
        playerId,
        playerName: getPlayer(gameState, playerId)?.name,
      });
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── REST — Tagging ───────────────────────────────────────────────────────────

// POST /api/tag  { lat, lng }  (chaser provides their location at time of tag)
app.post("/api/tag", (req, res) => {
  if (!requireGame(res)) return;
  try {
    clearVetoTimeout();
    const tagLocation = (req.body.lat && req.body.lng)
      ? { lat: req.body.lat, lng: req.body.lng }
      : null;

    const outgoingRunner = getCurrentRunner(gameState);
    const { state, finished, newRunner } = tagRunner(gameState, tagLocation);
    gameState = state;

    broadcastState();

    if (finished) {
      clearJailTimeout();
      io.emit("game:finished", { players: gameState.players });
    } else {
      startJailTimeout();
      io.emit("runner:tagged", { taggedPlayer: outgoingRunner, newRunner });
    }

    res.json({ ok: true, finished, newRunner });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── REST — Transport ─────────────────────────────────────────────────────────

app.post("/api/transport/start", (req, res) => {
  if (!requireGame(res)) return;
  try {
    const { playerId, mode } = req.body;
    gameState = startTransport(gameState, playerId, mode);
    broadcastState();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post("/api/transport/stop", (req, res) => {
  if (!requireGame(res)) return;
  try {
    const { playerId } = req.body;
    const { state, cost } = stopTransport(gameState, playerId);
    gameState = state;
    broadcastState();
    io.emit("transport:stopped", { playerId, cost });
    res.json({ ok: true, cost });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get("/api/transport/cost/:playerId", (req, res) => {
  if (!requireGame(res)) return;
  const result = getTransportCost(gameState, req.params.playerId);
  res.json(result || { estimatedCost: 0, elapsedMinutes: 0, mode: null });
});

// ─── REST — Challenges ────────────────────────────────────────────────────────

app.get("/api/challenges", (req, res) => {
  res.json(getChallenges());
});

// POST /api/challenges/complete  { playerId }
app.post("/api/challenges/complete", (req, res) => {
  if (!requireGame(res)) return;
  try {
    const { playerId } = req.body;
    gameState = completeChallenge(gameState, playerId);
    broadcastState();
    const player = getPlayer(gameState, playerId);
    io.emit("challenge:completed", {
      playerId,
      newBalance:       player.currency,
      nextChallenge:    gameState.activeChallenge,
    });
    res.json({ ok: true, newBalance: player.currency, nextChallenge: gameState.activeChallenge });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/challenges/veto  { playerId }
app.post("/api/challenges/veto", (req, res) => {
  if (!requireGame(res)) return;
  try {
    gameState = vetoChallenge(gameState);
    broadcastState();
    startVetoTimeout();
    io.emit("challenge:vetoed", { remainingMs: VETO_DURATION_MS });
    res.json({ ok: true, remainingMs: VETO_DURATION_MS });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── REST — Jail GPS ping ──────────────────────────────────────────────────────

// POST /api/jail/ping  { playerId, lat, lng }
// Chasers call this periodically during jail time; server checks distance.
app.post("/api/jail/ping", (req, res) => {
  if (!requireGame(res)) return;
  const { playerId, lat, lng } = req.body;
  const jail = gameState.jailTimer;

  if (!jail) return res.json({ jailed: false });
  if (!jail.tagLocation) return res.json({ jailed: true, warning: false });

  const dist = haversineDistanceLocal(jail.tagLocation, { lat, lng });
  const warning = dist > JAIL_RADIUS_METERS;

  if (warning) {
    // Notify everyone so teammates can see the warning too
    const player = getPlayer(gameState, playerId);
    io.emit("jail:movement_warning", {
      playerId,
      playerName: player?.name,
      distanceMeters: Math.round(dist),
    });
  }

  res.json({ jailed: true, warning, distanceMeters: Math.round(dist) });
});

// Inline haversine for server-only use in jail ping
function haversineDistanceLocal(a, b) {
  const R     = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat  = toRad(b.lat - a.lat);
  const dLng  = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// ─── Socket.IO ────────────────────────────────────────────────────────────────

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);
  if (gameState) socket.emit("state:update", serializeState(gameState));

  socket.on("identify", ({ playerId }) => {
    playerSockets[playerId] = socket.id;
  });

  socket.on("disconnect", () => {
    for (const [pid, sid] of Object.entries(playerSockets)) {
      if (sid === socket.id) { delete playerSockets[pid]; break; }
    }
  });
});

// ─── Periodic transport cost broadcast ────────────────────────────────────────

setInterval(() => {
  if (!gameState) return;
  for (const player of gameState.players) {
    const cost = getTransportCost(gameState, player.id);
    if (cost) io.emit("transport:tick", { playerId: player.id, ...cost });
  }
}, 5000);

// ─── Catch-all ────────────────────────────────────────────────────────────────

app.get("*", (_req, res) => {
  res.sendFile(path.join(CLIENT_DIR, "index.html"));
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Urban Tag server running on port ${PORT}`);
  if (PORT === 3000) console.log(`  → http://localhost:${PORT}`);
});

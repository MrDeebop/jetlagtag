// server.js — HTTP + WebSocket server
// Compatible with Render, Railway, Fly.io, and any Node PaaS.
//
// Project layout expected:
//   /
//   ├── package.json
//   ├── server/
//   │   ├── server.js   ← this file
//   │   └── game.js
//   └── client/
//       ├── index.html
//       ├── app.js
//       └── style.css
//
// Run locally:  npm start   (or: node server/server.js)
// PORT is injected automatically by Render/Railway; defaults to 3000 locally.

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const cors       = require("cors");
const path       = require("path");

const {
  createGame, startGame, tagRunner,
  setGoal, checkGoalReached,
  startTransport, stopTransport, getTransportCost,
  getChallenges, completeChallenge,
  getPlayer, getCurrentRunner, serializeState,
} = require("./game");

// ─── App setup ────────────────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);

const io = new Server(server, {
  allowEIO3: true,
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(cors());
app.use(express.json());

// ── Static files ──────────────────────────────────────────────────────────────
// __dirname is /…/server/, so client is one level up then into client/
const CLIENT_DIR = path.join(__dirname, "..", "client");
app.use(express.static(CLIENT_DIR));

// ─── In-memory state ──────────────────────────────────────────────────────────

let gameState = null;   // single active game

// ─── Broadcast helper ─────────────────────────────────────────────────────────

function broadcastState() {
  io.emit("state:update", serializeState(gameState));
}

// ─── Error helper for routes ──────────────────────────────────────────────────

function requireGame(res) {
  if (!gameState) {
    res.status(400).json({ error: "No game in progress. Create one first." });
    return false;
  }
  return true;
}

// ─── REST — Lobby / Game lifecycle ────────────────────────────────────────────

// POST /api/game/create
// Body: { players: ["Alice", "Bob", ...] }
app.post("/api/game/create", (req, res) => {
  try {
    const { players } = req.body;
    gameState = createGame(players);
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

// DELETE /api/game
app.delete("/api/game", (req, res) => {
  gameState = null;
  io.emit("game:reset");
  res.json({ ok: true });
});

// ─── REST — Goals ─────────────────────────────────────────────────────────────

// POST /api/goal/set
// Body: { playerId, lat, lng, label }
app.post("/api/goal/set", (req, res) => {
  if (!requireGame(res)) return;
  try {
    const { playerId, lat, lng, label } = req.body;
    gameState = setGoal(gameState, playerId, { lat, lng, label });

    // Send the hint only to the runner's socket (not lat/lng)
    const runnerSocketId = playerSockets[playerId];
    if (runnerSocketId) {
      io.to(runnerSocketId).emit("goal:assigned", { label });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/goal/check
// Body: { playerId, lat, lng }
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

// POST /api/tag
app.post("/api/tag", (req, res) => {
  if (!requireGame(res)) return;
  try {
    const outgoingRunner = getCurrentRunner(gameState);
    const { state, finished, newRunner } = tagRunner(gameState);
    gameState = state;

    broadcastState();

    if (finished) {
      io.emit("game:finished", { players: gameState.players });
    } else {
      io.emit("runner:tagged", { taggedPlayer: outgoingRunner, newRunner });
    }

    res.json({ ok: true, finished, newRunner });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── REST — Transport ─────────────────────────────────────────────────────────

// POST /api/transport/start
// Body: { playerId, mode }
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

// POST /api/transport/stop
// Body: { playerId }
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

// GET /api/transport/cost/:playerId
app.get("/api/transport/cost/:playerId", (req, res) => {
  if (!requireGame(res)) return;
  const result = getTransportCost(gameState, req.params.playerId);
  res.json(result || { estimatedCost: 0, elapsedMinutes: 0, mode: null });
});

// ─── REST — Challenges ────────────────────────────────────────────────────────

// GET /api/challenges
app.get("/api/challenges", (req, res) => {
  res.json(getChallenges());
});

// POST /api/challenges/complete
// Body: { playerId, challengeId }
app.post("/api/challenges/complete", (req, res) => {
  if (!requireGame(res)) return;
  try {
    const { playerId, challengeId } = req.body;
    gameState = completeChallenge(gameState, playerId, challengeId);
    broadcastState();
    const player = getPlayer(gameState, playerId);
    io.emit("challenge:completed", { playerId, challengeId, newBalance: player.currency });
    res.json({ ok: true, newBalance: player.currency });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Socket.IO ────────────────────────────────────────────────────────────────

// Track socket ↔ player mapping for targeted goal events
const playerSockets = {};

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Send current state immediately so page-reloads / late-joiners sync up
  if (gameState) {
    socket.emit("state:update", serializeState(gameState));
  }

  socket.on("identify", ({ playerId }) => {
    playerSockets[playerId] = socket.id;
    console.log(`Player ${playerId} → socket ${socket.id}`);
  });

  socket.on("disconnect", () => {
    for (const [pid, sid] of Object.entries(playerSockets)) {
      if (sid === socket.id) {
        delete playerSockets[pid];
        console.log(`Player ${pid} disconnected`);
        break;
      }
    }
  });
});

// ─── Periodic transport cost broadcast ────────────────────────────────────────
// Pushes live cost ticks every 5 s so all screens stay roughly in sync.

setInterval(() => {
  if (!gameState) return;
  for (const player of gameState.players) {
    const cost = getTransportCost(gameState, player.id);
    if (cost) {
      io.emit("transport:tick", { playerId: player.id, ...cost });
    }
  }
}, 5000);

// ─── Catch-all — serve index.html for any unmatched GET ───────────────────────
// Required so a hard page-reload on any URL still loads the SPA.
app.get("*", (_req, res) => {
  res.sendFile(path.join(CLIENT_DIR, "index.html"));
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Urban Tag server running on port ${PORT}`);
  if (PORT === 3000) console.log(`  → http://localhost:${PORT}`);
});

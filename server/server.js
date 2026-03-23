// server.js — HTTP + WebSocket server
// Deployable to Railway (or any Node host) out of the box.
//
// Dependencies (add to package.json):
//   express, socket.io, cors
//
// Run locally:  node server.js
// PORT is set automatically by Railway; defaults to 3000 locally.

const express  = require("express");
const http     = require("http");
const { Server } = require("socket.io");
const cors     = require("cors");
const path     = require("path");

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

// Socket.IO — allowEIO3 keeps compatibility with older browsers.
// The cors origin "*" is fine here because this is a private game server,
// not handling sensitive user accounts.
const io = new Server(server, {
  allowEIO3: true,
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(cors());
app.use(express.json());

// Serve the client folder as static files
app.use(express.static(path.join(__dirname, "../client")));

// ─── In-memory state ──────────────────────────────────────────────────────────

let gameState = null;   // single active game

// ─── Broadcast helper ─────────────────────────────────────────────────────────

/**
 * Sends the full serialized state to every connected client.
 * Called after every mutation so all phones stay in sync instantly.
 */
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
// Creates a brand-new game. Replaces any existing game.
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
// Moves from lobby → running. Call after the first goal has been set.
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
// Returns current state. Useful when a phone reconnects / reloads the page.
app.get("/api/game/state", (req, res) => {
  if (!gameState) return res.json(null);
  res.json(serializeState(gameState));
});

// DELETE /api/game
// Resets everything. Useful at end of game or to start fresh.
app.delete("/api/game", (req, res) => {
  gameState = null;
  io.emit("game:reset");
  res.json({ ok: true });
});

// ─── REST — Goals ─────────────────────────────────────────────────────────────

// POST /api/goal/set
// Body: { playerId, lat, lng, label }
// The host secretly sets the goal for the upcoming (or current) runner.
app.post("/api/goal/set", (req, res) => {
  if (!requireGame(res)) return;
  try {
    const { playerId, lat, lng, label } = req.body;
    gameState = setGoal(gameState, playerId, { lat, lng, label });
    // We do NOT broadcast the goal to everyone — only the runner should see their goal.
    // The runner's client will fetch it via GET /api/game/state after the host confirms.
    // Emit a targeted event to the runner's socket if we're tracking socket<->player mapping.
    const runnerSocketId = playerSockets[playerId];
    if (runnerSocketId) {
      io.to(runnerSocketId).emit("goal:assigned", {
        label,
        // Do NOT send lat/lng to runner — they find it by GPS proximity.
      });
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/goal/check
// Body: { playerId, lat, lng }
// A runner's phone posts their GPS coordinates; server checks proximity to goal.
app.post("/api/goal/check", (req, res) => {
  if (!requireGame(res)) return;
  try {
    const { playerId, lat, lng } = req.body;

    if (typeof lat !== "number" || typeof lng !== "number") {
      return res.status(400).json({ error: "lat and lng must be numbers." });
    }

    const result = checkGoalReached(gameState, playerId, { lat, lng });

    if (result.reached) {
      // Broadcast to everyone that the runner reached their goal
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
// Body: {} (no body needed — server knows who the current runner is)
// Any chaser presses "I tagged the runner" on their phone.
app.post("/api/tag", (req, res) => {
  if (!requireGame(res)) return;
  try {
    const outgoingRunner = getCurrentRunner(gameState);
    const { state, finished, newRunner } = tagRunner(gameState);
    gameState = state;

    broadcastState();

    if (finished) {
      io.emit("game:finished", {
        players: gameState.players,
      });
    } else {
      io.emit("runner:tagged", {
        taggedPlayer: outgoingRunner,
        newRunner,
      });
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
// Live non-mutating cost peek. Client polls this while timer is running.
app.get("/api/transport/cost/:playerId", (req, res) => {
  if (!requireGame(res)) return;
  const result = getTransportCost(gameState, req.params.playerId);
  res.json(result || { estimatedCost: 0, elapsedMinutes: 0, mode: null });
});

// ─── REST — Challenges ────────────────────────────────────────────────────────

// GET /api/challenges
// Returns the full static challenge pool.
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

// Track which socket belongs to which player so we can send targeted events.
// { [playerId]: socketId }
const playerSockets = {};

io.on("connection", (socket) => {
  console.log("Client connected:", socket.id);

  // Send current state immediately on connect so late-joiners / page-reloads
  // get the game state right away without a separate REST call.
  if (gameState) {
    socket.emit("state:update", serializeState(gameState));
  }

  // Client tells us who they are (called from app.js after player is selected)
  socket.on("identify", ({ playerId }) => {
    playerSockets[playerId] = socket.id;
    console.log(`Player ${playerId} identified on socket ${socket.id}`);
  });

  socket.on("disconnect", () => {
    // Clean up socket mapping
    for (const [pid, sid] of Object.entries(playerSockets)) {
      if (sid === socket.id) {
        delete playerSockets[pid];
        console.log(`Player ${pid} disconnected`);
        break;
      }
    }
    console.log("Client disconnected:", socket.id);
  });
});

// ─── Periodic transport cost broadcast ───────────────────────────────────────
// Every 5 seconds, push live transport costs for all active sessions.
// This keeps everyone's displayed balances roughly up to date.

setInterval(() => {
  if (!gameState) return;
  for (const player of gameState.players) {
    const cost = getTransportCost(gameState, player.id);
    if (cost) {
      io.emit("transport:tick", { playerId: player.id, ...cost });
    }
  }
}, 5000);

// ─── Catch-all: serve index.html for any unmatched route ─────────────────────
// This allows the client to do a hard page reload on any URL and still get the app.

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "../client/index.html"));
});

// ─── Start ────────────────────────────────────────────────────────────────────

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Urban Tag server running on port ${PORT}`);
  if (PORT === 3000) {
    console.log(`Local: http://localhost:${PORT}`);
  }
});

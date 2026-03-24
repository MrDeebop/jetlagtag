// server.js — HTTP + WebSocket server

const express    = require("express");
const http       = require("http");
const { Server } = require("socket.io");
const cors       = require("cors");
const path       = require("path");

const {
  createGame, startGame, tagRunner, finishGame,
  setGoal, checkGoalReached,
  startTransport, stopTransport, getTransportCost,
  getChallenges, completeChallenge, vetoChallenge, resolveVeto,
  purchaseShopItem, getShopItems,
  adjustPlayerCurrency,
  getPlayer, getCurrentRunner, serializeState,
  VETO_DURATION_MS, JAIL_DURATION_MS, JAIL_RADIUS_METERS, JAIL_RADIUS_FEET,
  TRACKER_OFF_DURATION_MS, STANDSTILL_DURATION_MS,
  STARTING_CURRENCY, RUNNER_BONUS, GOAL_RADIUS_METERS,
  TRANSPORT_RATES, TRANSPORT_RATE_WALK, TRANSPORT_RATE_BIKE, TRANSPORT_RATE_BUS,
  TRANSPORT_RATE_TRAIN, TRANSPORT_RATE_TAXI,
  SHOP_ITEMS, AVG_CHALLENGE_REWARD,
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
let trackerOffTimeout  = null;  // setTimeout for tracker-off expiry
let standstillTimeout  = null;  // setTimeout for standstill expiry
let gameTimerTimeout   = null;  // setTimeout for timed game expiry

const playerSockets = {};  // { [playerId]: socketId }

// ─── Runner location store ────────────────────────────────────────────────────
// { lat, lng, accuracy, heading, speed, timestamp }
let runnerLocation = null;

// ─── Coarse player location store ────────────────────────────────────────────
// { [playerId]: { lat, lng, playerName, timestamp } }
// Updated by POST /api/location/coarse (all players, low-frequency pings).
// Broadcast to all clients via "players:locations" socket event.
let playerLocations = {};

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
  const doubled  = !!(gameState && gameState.vetoTimer && gameState.vetoTimer.doubled);
  const duration = doubled ? VETO_DURATION_MS * 2 : VETO_DURATION_MS;
  vetoTimeout = setTimeout(() => {
    if (!gameState) return;
    gameState = resolveVeto(gameState);
    broadcastState();
    io.emit("veto:resolved", { challenge: gameState.activeChallenge });
  }, duration);
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

// ─── Tracker-off timer ────────────────────────────────────────────────────────

function startTrackerOffTimeout() {
  clearTimeout(trackerOffTimeout);
  trackerOffTimeout = setTimeout(() => {
    if (!gameState) return;
    gameState.trackerOffTimer = null;
    broadcastState();
    io.emit("shop:tracker_restored");
  }, TRACKER_OFF_DURATION_MS);
}

function clearTrackerOffTimeout() {
  clearTimeout(trackerOffTimeout);
  trackerOffTimeout = null;
}

// ─── Standstill timer ─────────────────────────────────────────────────────────

function startStandstillTimeout() {
  clearTimeout(standstillTimeout);
  standstillTimeout = setTimeout(() => {
    if (!gameState) return;
    gameState.standstillTimer = null;
    broadcastState();
    io.emit("shop:standstill_over");
  }, STANDSTILL_DURATION_MS);
}

function clearStandstillTimeout() {
  clearTimeout(standstillTimeout);
  standstillTimeout = null;
}

// ─── Game timer management ─────────────────────────────────────────────────────

function startGameTimer(durationMs) {
  clearTimeout(gameTimerTimeout);
  gameTimerTimeout = setTimeout(() => {
    if (!gameState) return;
    gameState = finishGame(gameState);
    broadcastState();
    io.emit("game:finished", { players: gameState.players });
  }, durationMs);
}

function clearGameTimer() {
  clearTimeout(gameTimerTimeout);
  gameTimerTimeout = null;
}

// ─── REST — Game lifecycle ─────────────────────────────────────────────────────

// GET /api/game/constants  — all tunable rule values, fetched once on page load
app.get("/api/game/constants", (req, res) => {
  res.json({
    STARTING_CURRENCY,
    RUNNER_BONUS,
    GOAL_RADIUS_METERS,
    VETO_DURATION_MS,
    JAIL_DURATION_MS,
    JAIL_RADIUS_FEET,
    JAIL_RADIUS_METERS,
    TRACKER_OFF_DURATION_MS,
    STANDSTILL_DURATION_MS,
    TRANSPORT_RATES,
    TRANSPORT_RATE_WALK,
    TRANSPORT_RATE_BIKE,
    TRANSPORT_RATE_BUS,
    TRANSPORT_RATE_TRAIN,
    TRANSPORT_RATE_TAXI,
    SHOP_ITEMS,
    AVG_CHALLENGE_REWARD,
  });
});

// POST /api/game/create  { players: string[], gameDurationMs?: number | null }
app.post("/api/game/create", (req, res) => {
  try {
    clearVetoTimeout();
    clearJailTimeout();
    clearTrackerOffTimeout();
    clearStandstillTimeout();
    clearGameTimer();
    runnerLocation = null;
    playerLocations = {};
    const { players, gameDurationMs } = req.body;
    gameState = createGame(players, { gameDurationMs: gameDurationMs || null });
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
    // Start the game timer if this is a timed game
    if (gameState.gameDurationMs) {
      startGameTimer(gameState.gameDurationMs);
    }
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
  clearTrackerOffTimeout();
  clearStandstillTimeout();
  clearGameTimer();
  runnerLocation = null;
  playerLocations = {};
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
      const player = getPlayer(gameState, playerId);
      io.emit("goal:reached", { playerId, playerName: player?.name });

      // Award goal bonus and rotate to next runner (same as a tag)
      clearVetoTimeout();
      clearTrackerOffTimeout();
      clearStandstillTimeout();
      const { state, newRunner } = tagRunner(gameState, null);
      gameState = state;
      runnerLocation = null;
      io.emit("runner:location", null);
      broadcastState();
      startJailTimeout();
      io.emit("runner:tagged", { taggedPlayer: player, newRunner });
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
    clearTrackerOffTimeout();
    clearStandstillTimeout();
    const tagLocation = (req.body.lat && req.body.lng)
      ? { lat: req.body.lat, lng: req.body.lng }
      : null;

    const outgoingRunner = getCurrentRunner(gameState);
    const { state, newRunner } = tagRunner(gameState, tagLocation);
    gameState = state;

    // Clear runner location when runner rotates
    runnerLocation = null;
    io.emit("runner:location", null);

    broadcastState();

    // Game no longer ends on tag — runs until timer or gamemaster ends it
    startJailTimeout();
    io.emit("runner:tagged", { taggedPlayer: outgoingRunner, newRunner });
    res.json({ ok: true, finished: false, newRunner });
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

// ─── REST — Shop ──────────────────────────────────────────────────────────────

// GET /api/shop
app.get("/api/shop", (req, res) => {
  res.json(getShopItems());
});

// POST /api/shop/buy  { playerId, itemId }
app.post("/api/shop/buy", (req, res) => {
  if (!requireGame(res)) return;
  try {
    const { playerId, itemId } = req.body;
    const { state, item } = purchaseShopItem(gameState, playerId, itemId);
    gameState = state;

    // ── Side-effects per item ──────────────────────────────────────────────
    if (itemId === "location_ping") {
      // Ask all chasers to report their GPS position immediately.
      // Clients handle 'shop:location_ping_request' by getting their own
      // position and POSTing it back to /api/shop/location_report.
      io.emit("shop:location_ping_request", { requestedBy: playerId });
    } else if (itemId === "tracker_off") {
      startTrackerOffTimeout();
      io.emit("shop:tracker_off", { remainingMs: TRACKER_OFF_DURATION_MS });
    } else if (itemId === "chasers_standstill") {
      startStandstillTimeout();
      io.emit("shop:standstill", { remainingMs: STANDSTILL_DURATION_MS });
    } else if (itemId === "double_skip") {
      io.emit("shop:double_skip", { playerId });
    }

    broadcastState();
    res.json({ ok: true, item, newBalance: getPlayer(gameState, playerId)?.currency });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/shop/location_report  { playerId, lat, lng }
// Called by each chaser after receiving a location_ping_request.
app.post("/api/shop/location_report", (req, res) => {
  if (!requireGame(res)) return;
  const { playerId, lat, lng } = req.body;
  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat and lng must be numbers." });
  }
  const player = getPlayer(gameState, playerId);
  if (!player) return res.status(400).json({ error: "Player not found." });

  // Forward this chaser's position only to the runner (broadcast to all;
  // client filters by role so only the runner renders it).
  io.emit("shop:chaser_location", {
    playerId,
    playerName: player.name,
    lat,
    lng,
  });

  res.json({ ok: true });
});

// ─── REST — Gamemaster tools ───────────────────────────────────────────────────

// POST /api/gamemaster/set-coins  { playerId, amount }
app.post("/api/gamemaster/set-coins", (req, res) => {
  if (!requireGame(res)) return;
  try {
    const { playerId, amount } = req.body;
    gameState = adjustPlayerCurrency(gameState, playerId, amount);
    broadcastState();
    res.json({ ok: true, newBalance: getPlayer(gameState, playerId)?.currency });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// POST /api/gamemaster/end-game  — force-end the game immediately
app.post("/api/gamemaster/end-game", (req, res) => {
  if (!requireGame(res)) return;
  try {
    clearGameTimer();
    clearJailTimeout();
    clearVetoTimeout();
    clearTrackerOffTimeout();
    clearStandstillTimeout();
    gameState = finishGame(gameState);
    broadcastState();
    io.emit("game:finished", { players: gameState.players });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ─── REST — Jail GPS ping ──────────────────────────────────────────────────────

// POST /api/jail/ping  { playerId, lat, lng }
app.post("/api/jail/ping", (req, res) => {
  if (!requireGame(res)) return;
  const { playerId, lat, lng } = req.body;
  const jail = gameState.jailTimer;

  if (!jail) return res.json({ jailed: false });
  if (!jail.tagLocation) return res.json({ jailed: true, warning: false });

  const dist = haversineDistanceLocal(jail.tagLocation, { lat, lng });
  const warning = dist > JAIL_RADIUS_METERS;

  if (warning) {
    const player = getPlayer(gameState, playerId);
    io.emit("jail:movement_warning", {
      playerId,
      playerName: player?.name,
      distanceMeters: Math.round(dist),
    });
  }

  res.json({ jailed: true, warning, distanceMeters: Math.round(dist) });
});

// ─── REST — Runner location ───────────────────────────────────────────────────

/**
 * POST /api/location/update
 * Body: { playerId, lat, lng, accuracy?, heading?, speed? }
 *
 * Only accepted when the game is running and the sending player is
 * the current runner. Stores the location and broadcasts it to all
 * connected chasers via Socket.IO so they don't need to poll.
 */
app.post("/api/location/update", (req, res) => {
  if (!requireGame(res)) return;
  if (gameState.phase !== "running") {
    return res.status(400).json({ error: "Game is not running." });
  }

  const { playerId, lat, lng, accuracy, heading, speed } = req.body;

  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat and lng must be numbers." });
  }

  const runner = getCurrentRunner(gameState);
  if (!runner || runner.id !== playerId) {
    // Silently ignore — the player may have just been tagged and the
    // last in-flight request is still arriving.
    return res.json({ ok: true, ignored: true });
  }

  runnerLocation = {
    lat,
    lng,
    accuracy:  typeof accuracy === "number" ? Math.round(accuracy) : null,
    heading:   typeof heading  === "number" ? Math.round(heading)  : null,
    speed:     typeof speed    === "number" ? speed                : null,
    timestamp: Date.now(),
    runnerName: runner.name,
    runnerId:   runner.id,
  };

  // Push to all chasers — suppressed while tracker-off power-up is active.
  if (!gameState.trackerOffTimer) {
    io.emit("runner:location", runnerLocation);
  }

  res.json({ ok: true });
});

/**
 * GET /api/location/runner
 * Returns the most recent runner location (for clients that connect
 * mid-game and missed the last Socket.IO push).
 */
app.get("/api/location/runner", (req, res) => {
  res.json(runnerLocation);
});

/**
 * POST /api/location/coarse
 * Any player can report their own coarse GPS position here (runner + chasers).
 * Stored in playerLocations and broadcast to all clients as "players:locations".
 * Called every ~30 s by each device.
 */
app.post("/api/location/coarse", (req, res) => {
  const { playerId, lat, lng } = req.body;
  if (!playerId || lat == null || lng == null) {
    return res.status(400).json({ error: "playerId, lat, lng required" });
  }
  if (!gameState) return res.status(400).json({ error: "No active game" });

  const player = gameState.players.find((p) => p.id === playerId);
  if (!player) return res.status(404).json({ error: "Player not found" });

  playerLocations[playerId] = {
    lat,
    lng,
    playerName: player.name,
    timestamp:  Date.now(),
  };

  // Broadcast updated locations map to all clients
  io.emit("players:locations", playerLocations);
  res.json({ ok: true });
});

/**
 * GET /api/location/players
 * Returns all known coarse player locations (for clients that connect mid-game).
 */
app.get("/api/location/players", (req, res) => {
  res.json(playerLocations);
});

// ─── Inline haversine for server-only use ─────────────────────────────────────

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

  // Send the latest known runner location immediately on connect
  // so the map populates without waiting for the next GPS push.
  if (runnerLocation) socket.emit("runner:location", runnerLocation);

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

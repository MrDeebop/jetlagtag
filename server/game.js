// game.js — Core game state and logic (pure data, no I/O)
// All functions take state and return NEW state (immutable pattern).

// ─── Constants ────────────────────────────────────────────────────────────────

const STARTING_CURRENCY  = 100;
const RUNNER_BONUS       = 50;
const GOAL_RADIUS_METERS = 30;

const TRANSPORT_RATES = {   // coins per minute
  walk:  0,
  bike:  2,
  bus:   5,
  train: 10,
  taxi:  15,
};

const CHALLENGE_POOL = [
  { id: "c1",  text: "Take a selfie at a fountain",               reward: 20 },
  { id: "c2",  text: "Buy something from a vending machine",      reward: 15 },
  { id: "c3",  text: "Find a red mailbox",                        reward: 10 },
  { id: "c4",  text: "Climb a full set of stairs",                reward: 10 },
  { id: "c5",  text: "Find a piece of public art",                reward: 25 },
  { id: "c6",  text: "Get a stranger to wave at the camera",      reward: 30 },
  { id: "c7",  text: "Find a bench and sit on it for 30 seconds", reward: 10 },
  { id: "c8",  text: "Take a photo next to a statue",             reward: 20 },
  { id: "c9",  text: "Find a coffee shop and read the menu",      reward: 10 },
  { id: "c10", text: "Cross a bridge on foot",                    reward: 25 },
  { id: "c11", text: "Find a street musician",                    reward: 20 },
  { id: "c12", text: "Spot a dog being walked",                   reward: 10 },
];

// ─── Private helpers ──────────────────────────────────────────────────────────

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function makeId() {
  return Math.random().toString(36).slice(2, 8);
}

function haversineDistance(a, b) {
  const R    = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat  = toRad(b.lat - a.lat);
  const dLng  = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Internal stop-transport that works on an already-cloned state object.
function _applyStopTransport(s, playerId) {
  const timer = s.transportTimers[playerId];
  if (!timer) return { state: s, cost: 0 };

  const elapsedMinutes = (Date.now() - timer.startedAt) / 60000;
  const cost = Math.round(elapsedMinutes * (TRANSPORT_RATES[timer.mode] || 0));

  const player = s.players.find((p) => p.id === playerId);
  if (player) player.currency = Math.max(0, player.currency - cost);

  delete s.transportTimers[playerId];
  return { state: s, cost };
}

// ─── createGame ───────────────────────────────────────────────────────────────

/**
 * createGame(playerNames: string[]) → GameState
 *
 * Validates 2–5 names, assigns Player[0] as first runner with RUNNER_BONUS,
 * all others start as chasers with STARTING_CURRENCY.
 */
function createGame(playerNames) {
  if (!Array.isArray(playerNames) || playerNames.length < 2 || playerNames.length > 5) {
    throw new Error("Need between 2 and 5 player names.");
  }

  const trimmed = playerNames.map((n) => (n || "").trim());
  if (trimmed.some((n) => !n)) throw new Error("All player names must be non-empty.");

  const players = trimmed.map((name, i) => ({
    id:       makeId(),
    name,
    role:     i === 0 ? "runner" : "chaser",
    currency: i === 0 ? STARTING_CURRENCY + RUNNER_BONUS : STARTING_CURRENCY,
    tagged:   false,
  }));

  return {
    phase:               "lobby",    // "lobby" | "running" | "finished"
    players,
    runnerIndex:         0,
    goals:               {},         // { [playerId]: { lat, lng, label } }
    completedChallenges: {},         // { [playerId]: string[] }
    transportTimers:     {},         // { [playerId]: { mode, startedAt } }
  };
}

// ─── startGame ────────────────────────────────────────────────────────────────

/**
 * startGame(state) → GameState
 * lobby → running.
 */
function startGame(state) {
  if (state.phase !== "lobby") throw new Error("Game is not in lobby phase.");
  const s = clone(state);
  s.phase = "running";
  return s;
}

// ─── tagRunner ────────────────────────────────────────────────────────────────

/**
 * tagRunner(state) → { state: GameState, finished: boolean, newRunner: Player|null }
 *
 * - Stops + charges any active transport for the outgoing runner
 * - Marks them tagged, demotes to chaser
 * - Advances runnerIndex; if we've wrapped back to 0 → game finished
 * - Awards RUNNER_BONUS to new runner, promotes to runner role
 */
function tagRunner(state) {
  if (state.phase !== "running") throw new Error("Game is not running.");

  let s = clone(state);

  // Stop outgoing runner's transport
  const outgoing = s.players[s.runnerIndex];
  if (s.transportTimers[outgoing.id]) {
    ({ state: s } = _applyStopTransport(s, outgoing.id));
  }

  s.players[s.runnerIndex].tagged = true;
  s.players[s.runnerIndex].role   = "chaser";

  const nextIndex = (s.runnerIndex + 1) % s.players.length;

  // If we've looped all the way around, the game is over
  if (nextIndex === 0) {
    s.phase = "finished";
    return { state: s, finished: true, newRunner: null };
  }

  s.runnerIndex = nextIndex;
  const newRunner = s.players[nextIndex];
  newRunner.role      = "runner";
  newRunner.currency += RUNNER_BONUS;

  return { state: s, finished: false, newRunner: clone(newRunner) };
}

// ─── Goals ────────────────────────────────────────────────────────────────────

/**
 * setGoal(state, playerId, { lat, lng, label }) → GameState
 */
function setGoal(state, playerId, goal) {
  if (typeof goal.lat !== "number" || typeof goal.lng !== "number") {
    throw new Error("lat and lng must be numbers.");
  }
  if (!state.players.find((p) => p.id === playerId)) {
    throw new Error(`Player ${playerId} not found.`);
  }
  const s = clone(state);
  s.goals[playerId] = { lat: goal.lat, lng: goal.lng, label: goal.label || "" };
  return s;
}

/**
 * checkGoalReached(state, playerId, { lat, lng })
 * → { reached: boolean, distance: number }
 */
function checkGoalReached(state, playerId, position) {
  const goal = state.goals[playerId];
  if (!goal) return { reached: false, distance: null };

  const distance = haversineDistance(goal, position);
  return {
    reached:  distance <= GOAL_RADIUS_METERS,
    distance: Math.round(distance),
  };
}

// ─── Transport ────────────────────────────────────────────────────────────────

/**
 * startTransport(state, playerId, mode) → GameState
 */
function startTransport(state, playerId, mode) {
  if (!Object.prototype.hasOwnProperty.call(TRANSPORT_RATES, mode)) {
    throw new Error(`Unknown transport mode: "${mode}". Valid: ${Object.keys(TRANSPORT_RATES).join(", ")}`);
  }
  if (!state.players.find((p) => p.id === playerId)) {
    throw new Error(`Player ${playerId} not found.`);
  }
  if (state.transportTimers[playerId]) {
    throw new Error("A transport session is already active for this player.");
  }
  const s = clone(state);
  s.transportTimers[playerId] = { mode, startedAt: Date.now() };
  return s;
}

/**
 * stopTransport(state, playerId) → { state: GameState, cost: number }
 */
function stopTransport(state, playerId) {
  if (!state.transportTimers[playerId]) {
    throw new Error("No active transport session for this player.");
  }
  const s = clone(state);
  return _applyStopTransport(s, playerId);
}

/**
 * getTransportCost(state, playerId)
 * → { mode, elapsedMinutes, estimatedCost } | null
 * Non-mutating peek — used for live cost broadcasts.
 */
function getTransportCost(state, playerId) {
  const timer = state.transportTimers[playerId];
  if (!timer) return null;

  const elapsedMinutes = (Date.now() - timer.startedAt) / 60000;
  return {
    mode:           timer.mode,
    elapsedMinutes: Math.round(elapsedMinutes * 10) / 10,
    estimatedCost:  Math.round(elapsedMinutes * (TRANSPORT_RATES[timer.mode] || 0)),
  };
}

// ─── Challenges ───────────────────────────────────────────────────────────────

function getChallenges() {
  return clone(CHALLENGE_POOL);
}

/**
 * completeChallenge(state, playerId, challengeId) → GameState
 * Idempotent.
 */
function completeChallenge(state, playerId, challengeId) {
  const challenge = CHALLENGE_POOL.find((c) => c.id === challengeId);
  if (!challenge) throw new Error(`Unknown challenge id: ${challengeId}`);

  const done = (state.completedChallenges[playerId] || []).includes(challengeId);
  if (done) return state; // already completed — no-op

  const s = clone(state);
  if (!s.completedChallenges[playerId]) s.completedChallenges[playerId] = [];
  s.completedChallenges[playerId].push(challengeId);

  const player = s.players.find((p) => p.id === playerId);
  if (player) player.currency += challenge.reward;

  return s;
}

// ─── Read helpers ─────────────────────────────────────────────────────────────

function getPlayer(state, playerId) {
  return state.players.find((p) => p.id === playerId) || null;
}

function getCurrentRunner(state) {
  return state.players[state.runnerIndex];
}

/**
 * serializeState(state) → plain object safe to send over the wire.
 *
 * Replaces raw startedAt epoch with elapsedSeconds + ratePerMinute so
 * clients can reconstruct a live timer without trusting the server clock.
 */
function serializeState(state) {
  const s = clone(state);

  for (const playerId of Object.keys(s.transportTimers)) {
    const timer = s.transportTimers[playerId];
    if (timer && timer.startedAt) {
      s.transportTimers[playerId] = {
        mode:           timer.mode,
        elapsedSeconds: Math.floor((Date.now() - timer.startedAt) / 1000),
        ratePerMinute:  TRANSPORT_RATES[timer.mode] || 0,
      };
    }
  }

  return s;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  // constants
  TRANSPORT_RATES,
  CHALLENGE_POOL,
  GOAL_RADIUS_METERS,
  STARTING_CURRENCY,
  RUNNER_BONUS,

  // lifecycle
  createGame,
  startGame,
  tagRunner,

  // goals
  setGoal,
  checkGoalReached,

  // transport
  startTransport,
  stopTransport,
  getTransportCost,

  // challenges
  getChallenges,
  completeChallenge,

  // helpers
  getPlayer,
  getCurrentRunner,
  serializeState,
};

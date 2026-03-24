// game.js — Core game state and logic (pure data, no I/O)

// ─── Constants ────────────────────────────────────────────────────────────────

const STARTING_CURRENCY  = 100;
const RUNNER_BONUS       = 50;
const GOAL_RADIUS_METERS = 30;
const VETO_DURATION_MS   = 5 * 60 * 1000;   // 5 minutes
const JAIL_DURATION_MS   = 5 * 60 * 1000;   // 5 minutes
const JAIL_RADIUS_FEET   = 100;
const JAIL_RADIUS_METERS = JAIL_RADIUS_FEET * 0.3048;

const TRANSPORT_RATES = {
  walk:  0,
  bike:  2,
  bus:   5,
  train: 10,
  taxi:  15,
};

// ─── Shop ─────────────────────────────────────────────────────────────────────

const SHOP_ITEMS = [
  {
    id:          "double_skip",
    label:       "Double Value + Double Skip Penalty",
    description: "Next challenge reward is doubled AND veto cooldown is doubled (10 min) if skipped.",
    cost:        25,
    emoji:       "⚡",
  },
  {
    id:          "location_ping",
    label:       "Location Ping",
    description: "Ping all chasers' GPS and reveal their locations to you.",
    cost:        100,
    emoji:       "📡",
  },
  {
    id:          "tracker_off",
    label:       "Tracker Off — 10 min",
    description: "Disables the chasers' live tracker for 10 minutes.",
    cost:        150,
    emoji:       "🚫",
  },
  {
    id:          "chasers_standstill",
    label:       "Chasers Stand Still — 10 min",
    description: "All chasers must stand still for 10 minutes.",
    cost:        200,
    emoji:       "🧊",
  },
];

const TRACKER_OFF_DURATION_MS    = 10 * 60 * 1000;
const STANDSTILL_DURATION_MS     = 10 * 60 * 1000;

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
  { id: "c13", text: "Find a clock tower or public clock",        reward: 15 },
  { id: "c14", text: "Take a photo of a reflection in water",     reward: 20 },
  { id: "c15", text: "Find a building with a green roof",         reward: 15 },
  { id: "c16", text: "Spot someone walking a cat",                reward: 25 },
  { id: "c17", text: "Find a mural or graffiti artwork",          reward: 15 },
  { id: "c18", text: "Stand next to a fire hydrant",              reward: 10 },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

function makeId() {
  return Math.random().toString(36).slice(2, 8);
}

function haversineDistance(a, b) {
  const R     = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat  = toRad(b.lat - a.lat);
  const dLng  = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

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

/**
 * Pick a random challenge that hasn't been used this game.
 */
function _pickChallenge(s) {
  const used      = s.usedChallenges || [];
  const available = CHALLENGE_POOL.filter((c) => !used.includes(c.id));
  if (!available.length) return null;
  return clone(available[Math.floor(Math.random() * available.length)]);
}

// ─── createGame ───────────────────────────────────────────────────────────────

function createGame(playerNames) {
  if (!Array.isArray(playerNames) || playerNames.length < 2 || playerNames.length > 5) {
    throw new Error("Need between 2 and 5 player names.");
  }
  const trimmed = playerNames.map((n) => (n || "").trim());
  if (trimmed.some((n) => !n)) throw new Error("All player names must be non-empty.");

  const players = trimmed.map((name, i) => ({
    id:               makeId(),
    name:             i === 0 ? `${name} (Gamemaster)` : name,
    isGamemaster:     i === 0,
    role:             i === 0 ? "runner" : "chaser",
    // All players start with the same pot; runner bonus applied at startGame
    currency:         STARTING_CURRENCY,
    currencyRevealed: false,  // hidden until player finishes their runner turn
    tagged:           false,
  }));

  return {
    phase:               "lobby",
    players,
    runnerIndex:         0,
    goals:               {},    // { [playerId]: { lat, lng, label } }
    activeChallenge:     null,  // { id, text, reward } — current runner only
    usedChallenges:      [],    // ids removed from pool permanently
    vetoTimer:           null,  // { startedAt } | null
    jailTimer:           null,  // { startedAt, tagLocation } | null
    transportTimers:     {},
    completedChallenges: {},    // { [playerId]: string[] }
    // Shop state
    doubleNextChallenge: false, // runner's next challenge reward is doubled
    doubleVetoPending:   false, // if true, next veto cooldown is 2× duration
    trackerOffTimer:     null,  // { startedAt } | null — tracker disabled for chasers
    standstillTimer:     null,  // { startedAt } | null — chasers must stand still
    shopPurchases:       [],    // log: { playerId, itemId, ts }
  };
}

// ─── startGame ────────────────────────────────────────────────────────────────

function startGame(state) {
  if (state.phase !== "lobby") throw new Error("Game is not in lobby phase.");
  const s = clone(state);
  s.phase = "running";

  // Give runner their starting bonus
  s.players[s.runnerIndex].currency += RUNNER_BONUS;

  // Deal first challenge
  const ch = _pickChallenge(s);
  s.activeChallenge = ch;
  if (ch) s.usedChallenges.push(ch.id);

  return s;
}

// ─── Goals ────────────────────────────────────────────────────────────────────

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

function checkGoalReached(state, playerId, position) {
  const goal = state.goals[playerId];
  if (!goal) return { reached: false, distance: null };
  const distance = haversineDistance(goal, position);
  return {
    reached:  distance <= GOAL_RADIUS_METERS,
    distance: Math.round(distance),
  };
}

// ─── tagRunner ────────────────────────────────────────────────────────────────

/**
 * tagRunner(state, tagLocation: {lat, lng} | null)
 * Rotates runner, starts jail for chasers, deals new challenge.
 */
function tagRunner(state, tagLocation) {
  if (state.phase !== "running") throw new Error("Game is not running.");

  let s = clone(state);

  // Stop runner's transport, reveal score
  const outgoing = s.players[s.runnerIndex];
  if (s.transportTimers[outgoing.id]) {
    ({ state: s } = _applyStopTransport(s, outgoing.id));
  }
  s.players[s.runnerIndex].tagged           = true;
  s.players[s.runnerIndex].role             = "chaser";
  s.players[s.runnerIndex].currencyRevealed = true;

  // Clear veto
  s.vetoTimer = null;

  const nextIndex = (s.runnerIndex + 1) % s.players.length;

  if (nextIndex === 0) {
    // Reveal everyone, end game
    s.players.forEach((p) => { p.currencyRevealed = true; });
    s.phase = "finished";
    return { state: s, finished: true, newRunner: null };
  }

  s.runnerIndex = nextIndex;
  const newRunner              = s.players[nextIndex];
  newRunner.role               = "runner";
  newRunner.currency          += RUNNER_BONUS;
  newRunner.currencyRevealed   = false;  // hide score while running

  // Jail all current chasers
  s.jailTimer = {
    startedAt:   Date.now(),
    tagLocation: tagLocation || null,
  };

  // Deal next challenge
  const ch = _pickChallenge(s);
  s.activeChallenge = ch;
  if (ch) s.usedChallenges.push(ch.id);

  return { state: s, finished: false, newRunner: clone(newRunner) };
}

// ─── Challenges ───────────────────────────────────────────────────────────────

/**
 * vetoChallenge — starts veto timer, clears active challenge.
 * The challenge is already in usedChallenges so it won't come back.
 */
function vetoChallenge(state) {
  if (!state.activeChallenge) throw new Error("No active challenge to veto.");
  const s           = clone(state);
  const doubled     = !!s.doubleVetoPending;
  s.vetoTimer       = { startedAt: Date.now(), doubled };
  s.activeChallenge = null;
  s.doubleVetoPending = false;
  return s;
}

/**
 * resolveVeto — called by server after VETO_DURATION_MS. Deals new challenge.
 */
function resolveVeto(state) {
  const s           = clone(state);
  s.vetoTimer       = null;
  const ch          = _pickChallenge(s);
  s.activeChallenge = ch;
  if (ch) s.usedChallenges.push(ch.id);
  return s;
}

/**
 * completeChallenge — awards reward, deals next challenge.
 */
function completeChallenge(state, playerId) {
  if (!state.activeChallenge) throw new Error("No active challenge.");
  const s      = clone(state);
  const ch     = s.activeChallenge;
  const player = s.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`Player ${playerId} not found.`);

  player.currency += ch.reward * (s.doubleNextChallenge ? 2 : 1);
  s.doubleNextChallenge = false;
  if (!s.completedChallenges[playerId]) s.completedChallenges[playerId] = [];
  s.completedChallenges[playerId].push(ch.id);

  const next = _pickChallenge(s);
  s.activeChallenge = next;
  if (next) s.usedChallenges.push(next.id);

  return s;
}

// ─── Transport ────────────────────────────────────────────────────────────────

function startTransport(state, playerId, mode) {
  if (!Object.prototype.hasOwnProperty.call(TRANSPORT_RATES, mode)) {
    throw new Error(`Unknown transport mode: "${mode}".`);
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

function stopTransport(state, playerId) {
  if (!state.transportTimers[playerId]) {
    throw new Error("No active transport session for this player.");
  }
  const s = clone(state);
  return _applyStopTransport(s, playerId);
}

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

// ─── Shop ─────────────────────────────────────────────────────────────────────

/**
 * purchaseShopItem(state, playerId, itemId)
 * Deducts cost, applies immediate state effects.
 * Server handles timer side-effects (setTimeout) after calling this.
 */
function purchaseShopItem(state, playerId, itemId) {
  const item = SHOP_ITEMS.find((i) => i.id === itemId);
  if (!item) throw new Error(`Unknown shop item: "${itemId}".`);

  const s      = clone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`Player ${playerId} not found.`);
  if (player.role !== "runner") throw new Error("Only the runner can use the shop.");
  if (player.currency < item.cost) throw new Error(`Not enough coins. Need ${item.cost} 🪙.`);

  player.currency -= item.cost;
  s.shopPurchases.push({ playerId, itemId, ts: Date.now() });

  if (itemId === "double_skip") {
    s.doubleNextChallenge = true;
    s.doubleVetoPending   = true;
  } else if (itemId === "tracker_off") {
    s.trackerOffTimer = { startedAt: Date.now() };
  } else if (itemId === "chasers_standstill") {
    s.standstillTimer = { startedAt: Date.now() };
  }
  // location_ping and double_skip: server broadcasts/handles the rest

  return { state: s, item: clone(item) };
}

function getShopItems() {
  return clone(SHOP_ITEMS);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function getChallenges() {
  return clone(CHALLENGE_POOL);
}

function getPlayer(state, playerId) {
  return state.players.find((p) => p.id === playerId) || null;
}

function getCurrentRunner(state) {
  return state.players[state.runnerIndex];
}

/**
 * serializeState — converts epoch timestamps to remaining/elapsed values
 * so clients don't need the server clock.
 */
function serializeState(state) {
  const s = clone(state);

  // Transport timers → elapsedSeconds
  for (const pid of Object.keys(s.transportTimers)) {
    const t = s.transportTimers[pid];
    if (t && t.startedAt) {
      s.transportTimers[pid] = {
        mode:           t.mode,
        elapsedSeconds: Math.floor((Date.now() - t.startedAt) / 1000),
        ratePerMinute:  TRANSPORT_RATES[t.mode] || 0,
      };
    }
  }

  // Veto timer → remainingMs
  if (s.vetoTimer && s.vetoTimer.startedAt) {
    const duration = s.vetoTimer.doubled ? VETO_DURATION_MS * 2 : VETO_DURATION_MS;
    s.vetoTimer = {
      remainingMs: Math.max(0, duration - (Date.now() - s.vetoTimer.startedAt)),
      doubled: !!s.vetoTimer.doubled,
    };
  }

  // Jail timer → remainingMs + tagLocation
  if (s.jailTimer && s.jailTimer.startedAt) {
    s.jailTimer = {
      remainingMs:  Math.max(0, JAIL_DURATION_MS - (Date.now() - s.jailTimer.startedAt)),
      tagLocation:  s.jailTimer.tagLocation,
    };
  }

  // Tracker-off timer → remainingMs
  if (s.trackerOffTimer && s.trackerOffTimer.startedAt) {
    s.trackerOffTimer = {
      remainingMs: Math.max(0, TRACKER_OFF_DURATION_MS - (Date.now() - s.trackerOffTimer.startedAt)),
    };
  }

  // Standstill timer → remainingMs
  if (s.standstillTimer && s.standstillTimer.startedAt) {
    s.standstillTimer = {
      remainingMs: Math.max(0, STANDSTILL_DURATION_MS - (Date.now() - s.standstillTimer.startedAt)),
    };
  }

  return s;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  TRANSPORT_RATES, CHALLENGE_POOL, SHOP_ITEMS,
  GOAL_RADIUS_METERS, STARTING_CURRENCY, RUNNER_BONUS,
  VETO_DURATION_MS, JAIL_DURATION_MS, JAIL_RADIUS_METERS, JAIL_RADIUS_FEET,
  TRACKER_OFF_DURATION_MS, STANDSTILL_DURATION_MS,

  createGame, startGame, tagRunner,
  setGoal, checkGoalReached,
  startTransport, stopTransport, getTransportCost,
  getChallenges, completeChallenge, vetoChallenge, resolveVeto,
  purchaseShopItem, getShopItems,
  getPlayer, getCurrentRunner, serializeState,
};

// game.js — Core game state and logic (pure data, no I/O)

// ─── Constants ────────────────────────────────────────────────────────────────

const STARTING_CURRENCY  = 50;
const RUNNER_BONUS       = 25;
const GOAL_RADIUS_METERS = 30;
const VETO_DURATION_MS   = 5 * 60 * 1000;   // 5 minutes
const JAIL_DURATION_MS   = 5 * 60 * 1000;   // 5 minutes
const JAIL_RADIUS_FEET   = 100;
const JAIL_RADIUS_METERS = JAIL_RADIUS_FEET * 0.3048;

const TRANSPORT_RATE_WALK         = 0;
const TRANSPORT_RATE_BIKE         = 6;
const TRANSPORT_RATE_BUS          = 15;
const TRANSPORT_RATE_TRAIN        = 30;
const TRANSPORT_RATE_TAXI         = 45;
const TRANSPORT_RATE_CAR          = 20;   // base rate per minute
const TRANSPORT_RATE_CAR_HIGHWAY  = 15;   // extra surcharge per minute on highways

const TRANSPORT_RATES = {
  walk:  TRANSPORT_RATE_WALK,
  bike:  TRANSPORT_RATE_BIKE,
  bus:   TRANSPORT_RATE_BUS,
  train: TRANSPORT_RATE_TRAIN,
  taxi:  TRANSPORT_RATE_TAXI,
  car:   TRANSPORT_RATE_CAR,
};

// ─── Challenges ───────────────────────────────────────────────────────────────

const CHALLENGE_POOL = [
  { id: "c1",  text: "Say hello to a police officer",                                                    reward: 15 },
  { id: "c2",  text: "Read a physical page of a book aloud",                                             reward: 10 },
  { id: "c3",  text: "Find out the name and career of a stranger",                                       reward: 25 },
  { id: "c4",  text: "Perform a random act of kindness",                                                 reward: 20 },
  { id: "c5",  text: "Attempt 3 cartwheels",                                                             reward: 15 },
  { id: "c6",  text: "Circumnavigate a bench",                                                           reward: 25 },
  { id: "c7",  text: "Donate to a homeless person",                                                      reward: 15 },
  { id: "c8",  text: "Climb something (not stairs)",                                                     reward: 20 },
  { id: "c9",  text: "Go to the top floor of the nearest hotel",                                         reward: 20 },
  { id: "c10", text: "Throw something at someone",                                                       reward: 10 },
  { id: "c11", text: "Find a flag from South America",                                                   reward: 15 },
  { id: "c12", text: "Run around a city block",                                                          reward: 15 },
  { id: "c13", text: "Find a revolving door and rotate it multiple times",                              reward: 20 },
  { id: "c14", text: "Find the nearest roadblock or concrete barrier",                                  reward: 10 },
  { id: "c15", text: "Find two empty parking spots next to each other",                                 reward: 15 },
  { id: "c16", text: "Find a spot where two companies owned by the same parent company are visible",    reward: 30 },
  { id: "c17", text: "Find a copy of the Bible",                                                        reward: 10 },
  { id: "c18", text: "Find a cosplayer",                                                                reward: 30 },
  { id: "c19", text: "Navigate from a random Wikipedia page to the nearest building with a Wikipedia page", reward: 25 },
  { id: "c20", text: "Start a Chicago-only Geoguessr Map. Go to place given on streetview. Resets allowed.", reward: 30 },
  { id: "c21", text: "Find a Brita Filter",                                                             reward: 30 },
  { id: "c22", text: "Take off your shoes",                                                             reward: 10 },
  { id: "c23", text: "Take off your shirt",                                                             reward: 15 },
  { id: "c24", text: "Put a non-hat item on your head for 15 minutes",                                  reward: 15 },
  { id: "c25", text: "Find something you can do a muscle-up on",                                        reward: 25 },

  //CURSES
  { id: "c26", text: "Cursed! Only use one hand for the next 15 minutes",                                       reward: 25 },
  { id: "c27", text: "Cursed! Only travel in cardinal directions",                                              reward: 30 },
  { id: "c28", text: "Cursed! Do not use a credit card",                                                        reward: 20 },
  { id: "c29", text: "Cursed! Do not use your native language",                                                 reward: 30 },
  { id: "c30", text: "Cursed! Do not talk",                                                                     reward: 30 },
  { id: "c31", text: "Cursed! Only use your left shoulder for interactions",                                    reward: 25 },
  { id: "c32", text: "Cursed! Only travel on the left side of the road",                                        reward: 30 },
  { id: "c33", text: "Cursed! Communicate only using phone images",                                             reward: 30 }
];

// Average challenge reward — used to price the Double Skip shop item so it always
// costs exactly one "average challenge" worth of coins.
const AVG_CHALLENGE_REWARD = Math.round(
  CHALLENGE_POOL.reduce((sum, c) => sum + c.reward, 0) / CHALLENGE_POOL.length
);

// ─── Shop ─────────────────────────────────────────────────────────────────────

const SHOP_COST_DOUBLE_SKIP        = AVG_CHALLENGE_REWARD;  // = avg challenge reward
const SHOP_COST_LOCATION_PING      = 50;
const SHOP_COST_TRACKER_OFF        = 100;
const SHOP_COST_CHASERS_STANDSTILL = 150;

const SHOP_ITEMS = [
  {
    id:          "double_skip",
    label:       "Double Value + Double Skip Penalty",
    description: `Next challenge reward is doubled AND veto cooldown is doubled if skipped. Costs the average challenge reward (${AVG_CHALLENGE_REWARD} 🪙).`,
    cost:        SHOP_COST_DOUBLE_SKIP,
    emoji:       "⚡",
  },
  {
    id:          "location_ping",
    label:       "Location Ping",
    description: "Ping all chasers' GPS and reveal their locations to you.",
    cost:        SHOP_COST_LOCATION_PING,
    emoji:       "📡",
  },
  {
    id:          "tracker_off",
    label:       "Tracker Off — 10 min",
    description: "Disables the chasers' live tracker for 10 minutes.",
    cost:        SHOP_COST_TRACKER_OFF,
    emoji:       "🚫",
  },
  {
    id:          "chasers_standstill",
    label:       "Chasers Stand Still — 10 min",
    description: "All chasers must stand still for 10 minutes.",
    cost:        SHOP_COST_CHASERS_STANDSTILL,
    emoji:       "🧊",
  },
];

const TRACKER_OFF_DURATION_MS    = 10 * 60 * 1000;
const STANDSTILL_DURATION_MS     = 10 * 60 * 1000;

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
  const baseRate = TRANSPORT_RATES[timer.mode] || 0;
  let cost = Math.round(elapsedMinutes * baseRate);
  // Car highway surcharge: charged for minutes spent on highway
  if (timer.mode === "car" && timer.highwayMinutes > 0) {
    cost += Math.round(timer.highwayMinutes * TRANSPORT_RATE_CAR_HIGHWAY);
  }
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

/**
 * createGame(playerNames, options)
 * options.gameDurationMs: number | null
 *   null  = infinite (game ends only when gamemaster resets)
 *   > 0   = timed mode; server ends the game when elapsed time exceeds this value
 */
function createGame(playerNames, options = {}) {
  if (!Array.isArray(playerNames) || playerNames.length < 2 || playerNames.length > 5) {
    throw new Error("Need between 2 and 5 player names.");
  }
  const trimmed = playerNames.map((n) => (n || "").trim());
  if (trimmed.some((n) => !n)) throw new Error("All player names must be non-empty.");

  const gameDurationMs = (typeof options.gameDurationMs === "number" && options.gameDurationMs > 0)
    ? options.gameDurationMs
    : null;

  const players = trimmed.map((name, i) => ({
    id:               makeId(),
    name:             i === 0 ? `${name} (Gamemaster)` : name,
    isGamemaster:     i === 0,
    role:             i === 0 ? "runner" : "chaser",
    // All players start with the same pot; runner bonus applied at startGame
    currency:         STARTING_CURRENCY,
    currencyRevealed: false,  // hidden until player finishes their runner turn
    tagged:           false,
    goalsReached:     0,       // how many times this player reached their goal as runner
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
    // Game timer (timed mode)
    gameDurationMs,             // null = infinite, number = timed mode duration in ms
    gameStartedAt:       null,  // set when phase → running
  };
}

// ─── startGame ────────────────────────────────────────────────────────────────

function startGame(state) {
  if (state.phase !== "lobby") throw new Error("Game is not in lobby phase.");
  const s = clone(state);
  s.phase = "running";
  s.gameStartedAt = Date.now();

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
 * The game NEVER ends here — it only ends via finishGame() (timer) or
 * when the gamemaster manually resets, or when a player reaches their goal.
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

  // Advance to next player (wrapping around — continuous rotation)
  const nextIndex = (s.runnerIndex + 1) % s.players.length;
  s.runnerIndex = nextIndex;
  const newRunner              = s.players[nextIndex];
  newRunner.role               = "runner";
  newRunner.currency          += RUNNER_BONUS;
  newRunner.currencyRevealed   = false;  // hide score while running
  newRunner.tagged             = false;  // reset tag flag for next turn

  // Jail all current chasers
  s.jailTimer = {
    startedAt:   Date.now(),
    tagLocation: tagLocation || null,
  };

  // Replenish challenge pool when all used
  if (s.usedChallenges.length >= CHALLENGE_POOL.length) {
    s.usedChallenges = [];
  }

  // Deal next challenge
  const ch = _pickChallenge(s);
  s.activeChallenge = ch;
  if (ch) s.usedChallenges.push(ch.id);

  return { state: s, finished: false, newRunner: clone(newRunner) };
}

/**
 * finishGame(state) — called by server when the game timer expires.
 * Reveals all scores and marks game as finished.
 */
function finishGame(state) {
  const s = clone(state);
  // Stop any active transport timers
  for (const pid of Object.keys(s.transportTimers)) {
    ({ state: s } = _applyStopTransport(s, pid));
  }
  s.players.forEach((p) => { p.currencyRevealed = true; });
  s.phase = "finished";
  return s;
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
  s.transportTimers[playerId] = {
    mode,
    startedAt: Date.now(),
    // Car-only fields
    highwayMinutes:    mode === "car" ? 0 : undefined,
    lastHighwayCheck:  mode === "car" ? Date.now() : undefined,
    onHighway:         mode === "car" ? false : undefined,
  };
  return s;
}

function stopTransport(state, playerId) {
  if (!state.transportTimers[playerId]) {
    throw new Error("No active transport session for this player.");
  }
  const s = clone(state);
  return _applyStopTransport(s, playerId);
}

/**
 * updateCarHighway(state, playerId, onHighway)
 * Called periodically by the server when the runner is using a car.
 * Accumulates highway minutes since the last check.
 */
function updateCarHighway(state, playerId, onHighway) {
  const timer = state.transportTimers[playerId];
  if (!timer || timer.mode !== "car") return state;
  const s   = clone(state);
  const t   = s.transportTimers[playerId];
  const now = Date.now();
  // If we were on the highway since the last check, accumulate those minutes
  if (t.onHighway && t.lastHighwayCheck) {
    t.highwayMinutes += (now - t.lastHighwayCheck) / 60000;
  }
  t.onHighway        = onHighway;
  t.lastHighwayCheck = now;
  return s;
}

function getTransportCost(state, playerId) {
  const timer = state.transportTimers[playerId];
  if (!timer) return null;
  const elapsedMinutes = (Date.now() - timer.startedAt) / 60000;
  const baseRate = TRANSPORT_RATES[timer.mode] || 0;
  let estimatedCost = Math.round(elapsedMinutes * baseRate);
  const highwayMinutes = timer.highwayMinutes || 0;
  if (timer.mode === "car" && highwayMinutes > 0) {
    estimatedCost += Math.round(highwayMinutes * TRANSPORT_RATE_CAR_HIGHWAY);
  }
  return {
    mode:             timer.mode,
    elapsedMinutes:   Math.round(elapsedMinutes * 10) / 10,
    estimatedCost,
    onHighway:        timer.onHighway || false,
    highwayMinutes:   Math.round(highwayMinutes * 10) / 10,
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

function adjustPlayerCurrency(state, playerId, newAmount) {
  if (typeof newAmount !== "number" || newAmount < 0) {
    throw new Error("Amount must be a non-negative number.");
  }
  const s = clone(state);
  const player = s.players.find((p) => p.id === playerId);
  if (!player) throw new Error(`Player ${playerId} not found.`);
  player.currency = Math.round(newAmount);
  return s;
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
        mode:            t.mode,
        elapsedSeconds:  Math.floor((Date.now() - t.startedAt) / 1000),
        ratePerMinute:   TRANSPORT_RATES[t.mode] || 0,
        onHighway:       t.onHighway || false,
        highwayMinutes:  t.highwayMinutes || 0,
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

  // Game timer → remainingMs / elapsedMs
  if (s.gameStartedAt) {
    const elapsedMs = Date.now() - s.gameStartedAt;
    s.gameElapsedMs = elapsedMs;
    if (s.gameDurationMs) {
      s.gameRemainingMs = Math.max(0, s.gameDurationMs - elapsedMs);
    }
  }

  return s;
}

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  TRANSPORT_RATES, TRANSPORT_RATE_WALK, TRANSPORT_RATE_BIKE, TRANSPORT_RATE_BUS,
  TRANSPORT_RATE_TRAIN, TRANSPORT_RATE_TAXI, TRANSPORT_RATE_CAR, TRANSPORT_RATE_CAR_HIGHWAY,
  CHALLENGE_POOL, AVG_CHALLENGE_REWARD, SHOP_ITEMS,
  GOAL_RADIUS_METERS, STARTING_CURRENCY, RUNNER_BONUS,
  VETO_DURATION_MS, JAIL_DURATION_MS, JAIL_RADIUS_METERS, JAIL_RADIUS_FEET,
  TRACKER_OFF_DURATION_MS, STANDSTILL_DURATION_MS,
  SHOP_COST_DOUBLE_SKIP, SHOP_COST_LOCATION_PING,
  SHOP_COST_TRACKER_OFF, SHOP_COST_CHASERS_STANDSTILL,

  createGame, startGame, tagRunner, finishGame,
  setGoal, checkGoalReached,
  startTransport, stopTransport, updateCarHighway, getTransportCost,
  getChallenges, completeChallenge, vetoChallenge, resolveVeto,
  purchaseShopItem, getShopItems,
  adjustPlayerCurrency,
  getPlayer, getCurrentRunner, serializeState,
};

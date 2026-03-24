// app.js — Urban Tag client

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const TRANSPORT_MODES = [
  { mode: "walk",  icon: "🚶", label: "Walk",  rate: 0  },
  { mode: "bike",  icon: "🚲", label: "Bike",  rate: 2  },
  { mode: "bus",   icon: "🚌", label: "Bus",   rate: 5  },
  { mode: "train", icon: "🚆", label: "Train", rate: 10 },
  { mode: "taxi",  icon: "🚕", label: "Taxi",  rate: 15 },
];

const VETO_DURATION_MS  = 5 * 60 * 1000;
const JAIL_DURATION_MS  = 5 * 60 * 1000;
const JAIL_PING_INTERVAL_MS = 15 * 1000;  // ping GPS every 15 s during jail

// Runner GPS polling: how often the runner's device reports its position.
// watchPosition fires on movement anyway; this is only the fallback max age.
const RUNNER_MAX_POSITION_AGE_MS = 4000;   // accept cached fix up to 4 s old
const RUNNER_LOCATION_TIMEOUT_MS = 8000;   // give up waiting for a fix after 8 s
// After this many ms without a server push, the tracker shows "stale" state.
const TRACKER_STALE_THRESHOLD_MS = 20000;

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

let state        = null;
let myPlayerId   = null;
let selectedMode = "walk";
let gameConstants = null;  // fetched from /api/game/constants on load

// Transport timer (client-side for responsiveness)
let transportTimerInterval = null;
let transportTimerStart    = null;
let transportTimerRate     = 0;

// Veto countdown (client-side)
let vetoCountdownInterval  = null;
let vetoEndsAt             = null;

// Game timer countdown (client-side)
let gameTimerInterval      = null;

// Jail countdown (client-side)
let jailCountdownInterval  = null;
let jailEndsAt             = null;
let jailPingInterval       = null;

// Shop — standstill countdown (client-side)
let standstillCountdownInterval = null;
let standstillEndsAt            = null;

// Shop — tracker-off countdown (shown in tracker card)
let trackerOffCountdownInterval = null;
let trackerOffEndsAt            = null;

// ─── Runner location broadcasting (runner's device only) ──────────────────
// We use watchPosition for continuous high-accuracy updates. The watch ID
// is stored so we can clear it when the player is no longer the runner.
let runnerWatchId          = null;  // navigator.geolocation.watchPosition id
let runnerLocationSending  = false; // guard against overlapping fetches

// ─── Chaser tracker (Leaflet map) ────────────────────────────────────────
let trackerMap        = null;   // Leaflet map instance
let trackerMarker     = null;   // Leaflet circle marker for the runner
let trackerAccCircle  = null;   // Leaflet circle for accuracy radius
let trackerAgeTimer   = null;   // setInterval updating the "X s ago" label
let lastLocationTs    = null;   // timestamp of the last received location

// ─── Runner ping map (runner only, for location_ping results) ─────────────
let runnerPingMap     = null;   // Leaflet map for the runner's chaser-ping view

// ─── Goals map (all players) ──────────────────────────────────────────────
let goalsMap          = null;   // Leaflet map showing all goal pins

// ═══════════════════════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════════

const socket = io();

socket.on("connect", () => {
  if (myPlayerId) socket.emit("identify", { playerId: myPlayerId });
});

socket.on("state:update", (newState) => {
  state = newState;
  // Sync the local game timer to the server's remaining time
  if (state.gameRemainingMs != null) {
    window._gameTimerSyncedAt = Date.now();
    // Patch gameRemainingMs so tickGameTimer uses the fresh value
    state._syncedRemainingMs = state.gameRemainingMs;
  }
  renderAll();
});

socket.on("runner:tagged", ({ taggedPlayer, newRunner }) => {
  toast(`${taggedPlayer.name} was tagged! ${newRunner.name} is now the runner.`);
});

socket.on("goal:reached", ({ playerName }) => {
  toast(`🎯 ${playerName} reached their goal!`, "success");
});

socket.on("challenge:completed", () => {
  // state:update handles re-render
});

socket.on("challenge:vetoed", ({ remainingMs }) => {
  startVetoCountdown(remainingMs);
});

socket.on("veto:resolved", ({ challenge }) => {
  clearVetoCountdown();
  if (challenge) toast(`New challenge ready!`, "success");
});

socket.on("jail:released", () => {
  clearJailCountdown();
  clearJailPing();
  toast("⛓ Jail time over — you're free!", "success");
});

socket.on("jail:movement_warning", ({ playerName, distanceMeters }) => {
  toast(`⚠️ ${playerName} moved ${distanceMeters}m from the tag spot!`, "danger");
});

socket.on("transport:stopped", ({ playerId, cost }) => {
  if (playerId === myPlayerId) {
    stopLocalTimer();
    toast(`Transport ended. Cost: ${cost} 🪙`, "danger");
  }
});

socket.on("game:finished", () => {
  showScreen("screen-gameover");
  renderFinalScores();
});

socket.on("game:reset", () => {
  state = null; myPlayerId = null;
  clearAll();
  showScreen("screen-lobby");
  toast("Game was reset.");
});

// ── Shop events ───────────────────────────────────────────────────────────────

socket.on("shop:double_skip", () => {
  toast("⚡ Runner activated DOUBLE VALUE + DOUBLE SKIP PENALTY!", "warning", 5000);
});

// Chasers receive this and immediately report their GPS back
socket.on("shop:location_ping_request", async () => {
  const me = myPlayer();
  if (!me || me.role !== "chaser") return;
  if (!navigator.geolocation) return;
  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      await api("POST", "/api/shop/location_report", {
        playerId: me.id,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      });
    } catch (_) {}
  }, () => {}, { enableHighAccuracy: true, timeout: 8000, maximumAge: 0 });
});

// Runner receives each chaser's reported location
socket.on("shop:chaser_location", ({ playerId, playerName, lat, lng }) => {
  const me = myPlayer();
  if (!me || me.role !== "runner") return;
  showChaserPingOnMap(playerId, playerName, lat, lng);
  toast(`📡 ${playerName} is nearby — location pinged!`, "warning", 6000);
});

socket.on("shop:tracker_off", ({ remainingMs }) => {
  const me = myPlayer();
  toast("🚫 TRACKER OFF — runner bought 10 min blackout!", "danger", 6000);
  if (me?.role === "chaser") {
    startTrackerOffCountdown(remainingMs);
  }
});

socket.on("shop:tracker_restored", () => {
  clearTrackerOffCountdown();
  toast("✅ Tracker is back online!", "success");
  renderTrackerCard();
});

socket.on("shop:standstill", ({ remainingMs }) => {
  const me = myPlayer();
  toast("🧊 CHASERS STAND STILL — runner bought 10 min freeze!", "danger", 6000);
  if (me?.role === "chaser") {
    startStandstillCountdown(remainingMs);
  }
});

socket.on("shop:standstill_over", () => {
  clearStandstillCountdown();
  toast("✅ Stand-still order lifted!", "success");
});

// ── Runner location push from server ───────────────────────────────────────
// The server re-emits every POST /api/location/update to all clients.
// Chasers use this to update the Leaflet map in real time.
socket.on("runner:location", (loc) => {
  const me = myPlayer();
  // Only chasers render the tracker map.
  if (!me || me.role !== "chaser") return;
  if (!loc) {
    // Runner rotated — clear the map
    clearTrackerLocation();
    return;
  }
  updateTrackerMap(loc);
});

// ═══════════════════════════════════════════════════════════════════════════
// FETCH HELPER
// ═══════════════════════════════════════════════════════════════════════════

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json" } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res  = await fetch(path, opts);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════
// SCREEN ROUTING
// ═══════════════════════════════════════════════════════════════════════════

function showScreen(id) {
  document.querySelectorAll(".screen").forEach((s) => s.classList.remove("active"));
  document.getElementById(id).classList.add("active");
}

// ═══════════════════════════════════════════════════════════════════════════
// TOAST
// ═══════════════════════════════════════════════════════════════════════════

function toast(message, type = "default", duration = 3500) {
  const container = document.getElementById("toast-container");
  const el        = document.createElement("div");
  el.className    = `toast${type !== "default" ? " " + type : ""}`;
  el.style.setProperty("--toast-delay", `${(duration - 300) / 1000}s`);
  el.textContent  = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), duration + 100);
}

// ═══════════════════════════════════════════════════════════════════════════
// MASTER RENDER
// ═══════════════════════════════════════════════════════════════════════════

function renderAll() {
  if (!state) return;

  if (state.phase === "finished") {
    showScreen("screen-gameover");
    renderFinalScores();
    return;
  }

  if (state.phase === "running") {
    showScreen("screen-game");
    renderPlayerSelector();
    renderTopBar();
    renderGameTimer();
    renderGoalBanner();
    renderJailBanner();
    renderGoalsMap();
    renderTransportCard();
    renderRoleCards();
    renderChallengeCard();
    renderTrackerCard();
    renderScoreboard();
    renderGamemasterCard();
    renderShopCard();
    renderStandstillBanner();
    return;
  }

  // lobby — stay put
}

// ═══════════════════════════════════════════════════════════════════════════
// LOBBY
// ═══════════════════════════════════════════════════════════════════════════

function buildLobby() {
  const container = document.getElementById("player-inputs");
  container.innerHTML = "";
  addPlayerRow(); addPlayerRow();

  document.getElementById("btn-add-player").addEventListener("click", () => {
    if (container.querySelectorAll(".player-row").length >= 5) {
      toast("Maximum 5 players.", "danger"); return;
    }
    addPlayerRow();
  });

  document.getElementById("btn-create-game").addEventListener("click", createGame);

  // ── Game mode toggle ──────────────────────────────────────────────────────
  const modeToggle = document.getElementById("game-mode-toggle");
  const timedOptions = document.getElementById("timed-options");
  let selectedGameMode = "infinite";
  let selectedPresetMin = 60;

  modeToggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".mode-toggle-btn");
    if (!btn) return;
    selectedGameMode = btn.dataset.mode;
    modeToggle.querySelectorAll(".mode-toggle-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    timedOptions.classList.toggle("hidden", selectedGameMode !== "timed");
  });

  // Preset time buttons
  const presetBtns = document.querySelectorAll(".preset-btn");
  presetBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      presetBtns.forEach((b) => b.classList.remove("active"));
      btn.classList.add("active");
      selectedPresetMin = parseInt(btn.dataset.minutes, 10);
      document.getElementById("custom-minutes").value = "";
    });
  });

  // Custom time input
  document.getElementById("custom-minutes").addEventListener("input", () => {
    presetBtns.forEach((b) => b.classList.remove("active"));
  });

  // Store on window so createGame() can read it
  window._getGameDurationMs = () => {
    if (selectedGameMode !== "timed") return null;
    const customVal = parseInt(document.getElementById("custom-minutes").value, 10);
    const minutes = (!isNaN(customVal) && customVal >= 1) ? customVal : selectedPresetMin;
    return minutes * 60 * 1000;
  };
}

function addPlayerRow() {
  const container = document.getElementById("player-inputs");
  const n   = container.querySelectorAll(".player-row").length + 1;
  const row = document.createElement("div");
  row.className = "player-row";
  row.innerHTML = `
    <span class="player-num">${n}</span>
    <input class="player-name" type="text" placeholder="Player ${n} name" maxlength="20" autocomplete="off" />
  `;
  container.appendChild(row);
  row.querySelector("input").focus();
}

async function createGame() {
  const inputs = document.querySelectorAll(".player-name");
  const names  = Array.from(inputs).map((i) => i.value.trim()).filter(Boolean);
  if (names.length < 2) { toast("Enter at least 2 player names.", "danger"); return; }

  const gameDurationMs = window._getGameDurationMs ? window._getGameDurationMs() : null;

  const btn = document.getElementById("btn-create-game");
  btn.textContent = "CREATING…"; btn.disabled = true;

  try {
    const data = await api("POST", "/api/game/create", { players: names, gameDurationMs });
    state = data.state;
    showGoalSetup();
  } catch (err) {
    toast(err.message, "danger");
    btn.textContent = "CREATE GAME"; btn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GOAL SETUP — All goals set upfront by Gamemaster
// ═══════════════════════════════════════════════════════════════════════════

function showGoalSetup() {
  if (!state) return;
  const container = document.getElementById("goal-forms-container");
  container.innerHTML = "";

  for (const player of state.players) {
    const card = document.createElement("div");
    card.className = "card";
    card.dataset.playerId = player.id;
    card.innerHTML = `
      <p class="card-label">GOAL FOR <span class="accent-text">${player.name.toUpperCase()}</span></p>
      <div class="coord-row">
        <label>LAT<input class="goal-lat" type="number" step="any" placeholder="e.g. 40.7128" /></label>
        <label>LNG<input class="goal-lng" type="number" step="any" placeholder="e.g. -74.0060" /></label>
      </div>
      <label>HINT FOR RUNNER
        <input class="goal-label" type="text" placeholder="e.g. The old clock tower" />
      </label>
    `;
    container.appendChild(card);
  }

  document.getElementById("goal-setup-hint").textContent = "";
  showScreen("screen-goal-setup");
}

async function submitAllGoals() {
  const cards = document.querySelectorAll("#goal-forms-container .card");
  const goals = [];

  for (const card of cards) {
    const playerId = card.dataset.playerId;
    const lat      = parseFloat(card.querySelector(".goal-lat").value);
    const lng      = parseFloat(card.querySelector(".goal-lng").value);
    const label    = card.querySelector(".goal-label").value.trim();
    const player   = state.players.find((p) => p.id === playerId);

    if (isNaN(lat) || isNaN(lng)) {
      toast(`Enter valid coordinates for ${player?.name}.`, "danger"); return;
    }
    if (!label) {
      toast(`Enter a hint for ${player?.name}.`, "danger"); return;
    }
    goals.push({ playerId, lat, lng, label });
  }

  const btn = document.getElementById("btn-start-game");
  btn.textContent = "SAVING…"; btn.disabled = true;

  try {
    for (const g of goals) {
      await api("POST", "/api/goal/set", g);
    }
    await api("POST", "/api/game/start");
    toast("Game started! Good luck!", "success");
  } catch (err) {
    toast(err.message, "danger");
    btn.textContent = "START GAME"; btn.disabled = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — PLAYER SELECTOR
// ═══════════════════════════════════════════════════════════════════════════

function renderPlayerSelector() {
  const select = document.getElementById("select-player");
  const prev   = select.value;
  select.innerHTML = "";

  for (const p of state.players) {
    const opt = document.createElement("option");
    opt.value = p.id; opt.textContent = p.name;
    select.appendChild(opt);
  }

  if (myPlayerId && state.players.find((p) => p.id === myPlayerId)) {
    select.value = myPlayerId;
  } else if (prev && state.players.find((p) => p.id === prev)) {
    select.value = prev; myPlayerId = prev;
  } else {
    myPlayerId = select.value = state.players[0].id;
    socket.emit("identify", { playerId: myPlayerId });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — GAME TIMER
// ═══════════════════════════════════════════════════════════════════════════

function renderGameTimer() {
  const el = document.getElementById("game-timer-display");
  if (!el || !state) return;

  // Infinite mode — hide timer
  if (!state.gameDurationMs) {
    el.classList.add("hidden");
    clearInterval(gameTimerInterval);
    gameTimerInterval = null;
    return;
  }

  el.classList.remove("hidden");

  // Start ticking if not already
  if (!gameTimerInterval) {
    gameTimerInterval = setInterval(tickGameTimer, 1000);
  }
  tickGameTimer();
}

function tickGameTimer() {
  const el = document.getElementById("game-timer-display");
  if (!el || !state || !state.gameDurationMs) return;

  // state.gameRemainingMs is set fresh on each server push.
  // window._gameTimerSyncedAt records when that push arrived.
  // We subtract elapsed local time since the sync to stay accurate.
  const syncedMs   = state.gameRemainingMs || 0;
  const syncedAt   = window._gameTimerSyncedAt || Date.now();
  const remaining  = Math.max(0, syncedMs - (Date.now() - syncedAt));

  const totalSec = Math.floor(remaining / 1000);
  const hrs  = Math.floor(totalSec / 3600);
  const mins = Math.floor((totalSec % 3600) / 60);
  const secs = totalSec % 60;

  let label;
  if (hrs > 0) {
    label = `⏱ ${hrs}:${String(mins).padStart(2, "0")}:${String(secs).padStart(2, "0")}`;
  } else {
    label = `⏱ ${mins}:${String(secs).padStart(2, "0")}`;
  }
  el.textContent = label;

  // Turn red and pulse in last 5 minutes
  el.classList.toggle("urgent", remaining < 5 * 60 * 1000 && remaining > 0);

  if (remaining <= 0) {
    el.textContent = "⏱ 0:00";
    clearInterval(gameTimerInterval);
    gameTimerInterval = null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — TOP BAR
// ═══════════════════════════════════════════════════════════════════════════

function renderTopBar() {
  const me = myPlayer();
  if (!me) return;
  const badge = document.getElementById("role-badge");
  badge.textContent = me.role === "runner" ? "RUNNER 🏃" : "CHASER 🕵";
  badge.className   = `role-badge ${me.role}`;
  document.getElementById("coin-display").textContent = `🪙 ${me.currency}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — GOAL BANNER
// ═══════════════════════════════════════════════════════════════════════════

function renderGoalBanner() {
  const me     = myPlayer();
  const banner = document.getElementById("goal-banner");
  if (!me || me.role !== "runner") { banner.classList.add("hidden"); return; }
  const goal = state.goals?.[me.id];
  if (goal?.label) {
    document.getElementById("goal-hint-text").textContent = goal.label;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — JAIL BANNER
// ═══════════════════════════════════════════════════════════════════════════

function renderJailBanner() {
  const me     = myPlayer();
  const banner = document.getElementById("jail-banner");

  if (!me || me.role !== "chaser" || !state.jailTimer) {
    banner.classList.add("hidden");
    clearJailCountdown();
    clearJailPing();
    return;
  }

  banner.classList.remove("hidden");

  const remainingMs = state.jailTimer.remainingMs;
  if (remainingMs > 0) {
    jailEndsAt = Date.now() + remainingMs;
    if (!jailCountdownInterval) {
      jailCountdownInterval = setInterval(tickJailCountdown, 1000);
      tickJailCountdown();
    }
    if (!jailPingInterval) {
      jailPingInterval = setInterval(pingJailLocation, JAIL_PING_INTERVAL_MS);
      pingJailLocation();
    }
  }
}

function tickJailCountdown() {
  if (!jailEndsAt) return;
  const remaining = Math.max(0, jailEndsAt - Date.now());
  const mins = String(Math.floor(remaining / 60000)).padStart(1, "0");
  const secs = String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0");
  const el = document.getElementById("jail-timer-text");
  if (el) el.textContent = `${mins}:${secs}`;
  if (remaining <= 0) {
    clearJailCountdown();
    clearJailPing();
    const banner = document.getElementById("jail-banner");
    if (banner) banner.classList.add("hidden");
  }
}

function clearJailCountdown() {
  clearInterval(jailCountdownInterval);
  jailCountdownInterval = null;
  jailEndsAt            = null;
}

async function pingJailLocation() {
  const me = myPlayer();
  if (!me || me.role !== "chaser" || !state?.jailTimer) {
    clearJailPing(); return;
  }
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(async (pos) => {
    try {
      await api("POST", "/api/jail/ping", {
        playerId: me.id,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      });
    } catch (_) {}
  }, () => {}, { enableHighAccuracy: true, timeout: 8000 });
}

function clearJailPing() {
  clearInterval(jailPingInterval);
  jailPingInterval = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — TRANSPORT
// ═══════════════════════════════════════════════════════════════════════════

function buildTransportModes() {
  const container = document.getElementById("transport-modes");
  container.innerHTML = "";
  for (const { mode, icon, label, rate } of TRANSPORT_MODES) {
    const btn = document.createElement("button");
    btn.className    = "mode-btn";
    btn.dataset.mode = mode;
    btn.dataset.rate = rate;
    btn.innerHTML    = `<span class="mode-icon">${icon}</span>${label}`;
    btn.addEventListener("click", () => selectMode(mode));
    container.appendChild(btn);
  }
}

function selectMode(mode) {
  selectedMode = mode;
  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === mode);
  });
}

function renderTransportCard() {
  const me    = myPlayer();
  const card  = document.getElementById("transport-card");

  // Chasers don't spend coins on transport — hide the whole card
  if (!me || me.role === "chaser") {
    card.classList.add("hidden");
    if (transportTimerInterval) stopLocalTimer();
    return;
  }
  card.classList.remove("hidden");

  const active = document.getElementById("transport-active");
  const timer  = state.transportTimers?.[me.id];
  const inVeto = !!state.vetoTimer;

  document.querySelectorAll(".mode-btn").forEach((b) => { b.disabled = inVeto; });

  if (timer) {
    active.classList.remove("hidden");
    document.getElementById("transport-mode-label").textContent =
      TRANSPORT_MODES.find((m) => m.mode === timer.mode)?.label || timer.mode;

    if (!transportTimerInterval && me) {
      const elapsed       = timer.elapsedSeconds || 0;
      transportTimerStart = Date.now() - elapsed * 1000;
      transportTimerRate  = timer.ratePerMinute || 0;
      startLocalTimer();
    }
  } else {
    active.classList.add("hidden");
    if (transportTimerInterval) stopLocalTimer();
  }

  document.querySelectorAll(".mode-btn").forEach((b) => {
    b.classList.toggle("active", b.dataset.mode === selectedMode);
  });
}

async function startTransport() {
  const me = myPlayer();
  if (!me) return;
  if (state.vetoTimer) { toast("Cannot use transport during veto cooldown.", "danger"); return; }
  if (me.role === "chaser" && state.jailTimer) { toast("Cannot use transport while in jail.", "danger"); return; }
  if (state.transportTimers?.[me.id]) { toast("Stop your current transport first.", "danger"); return; }

  try {
    await api("POST", "/api/transport/start", { playerId: me.id, mode: selectedMode });
    const modeInfo      = TRANSPORT_MODES.find((m) => m.mode === selectedMode);
    transportTimerStart = Date.now();
    transportTimerRate  = modeInfo?.rate || 0;
    startLocalTimer();
    document.getElementById("transport-active").classList.remove("hidden");
    document.getElementById("transport-mode-label").textContent = modeInfo?.label || selectedMode;
    toast(`${modeInfo?.label} timer started (${modeInfo?.rate} 🪙/min)`);
  } catch (err) {
    toast(err.message, "danger");
  }
}

async function stopTransport() {
  const me = myPlayer();
  if (!me) return;
  try {
    const { cost } = await api("POST", "/api/transport/stop", { playerId: me.id });
    stopLocalTimer();
    document.getElementById("transport-active").classList.add("hidden");
    toast(`Transport stopped. Cost: ${cost} 🪙`, "danger");
  } catch (err) {
    toast(err.message, "danger");
  }
}

function startLocalTimer() {
  if (transportTimerInterval) return;
  transportTimerInterval = setInterval(tickLocalTimer, 1000);
  tickLocalTimer();
}

function stopLocalTimer() {
  clearInterval(transportTimerInterval);
  transportTimerInterval = null; transportTimerStart = null; transportTimerRate = 0;
  document.getElementById("transport-elapsed").textContent  = "00:00";
  document.getElementById("transport-est-cost").textContent = "≈ 0 🪙";
}

function tickLocalTimer() {
  if (!transportTimerStart) return;
  const elapsedMs      = Date.now() - transportTimerStart;
  const elapsedSec     = Math.floor(elapsedMs / 1000);
  const cost           = Math.round((elapsedMs / 60000) * transportTimerRate);
  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");
  document.getElementById("transport-elapsed").textContent  = `${mm}:${ss}`;
  document.getElementById("transport-est-cost").textContent = `≈ ${cost} 🪙`;
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — ROLE CARDS
// ═══════════════════════════════════════════════════════════════════════════

function renderRoleCards() {
  const me         = myPlayer();
  const runnerCard = document.getElementById("runner-card");
  const chaserCard = document.getElementById("chaser-card");
  if (!me) { runnerCard.classList.add("hidden"); chaserCard.classList.add("hidden"); return; }
  if (me.role === "runner") {
    runnerCard.classList.remove("hidden"); chaserCard.classList.add("hidden");
  } else {
    runnerCard.classList.add("hidden"); chaserCard.classList.remove("hidden");
    document.getElementById("btn-tag-runner").disabled = !!state.jailTimer;
  }
}

async function checkGoal() {
  const me = myPlayer();
  if (!me) return;
  if (!navigator.geolocation) { toast("Geolocation not available.", "danger"); return; }

  const btn = document.getElementById("btn-check-goal");
  btn.textContent = "GETTING LOCATION…"; btn.disabled = true;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      try {
        const { reached, distance } = await api("POST", "/api/goal/check", {
          playerId: me.id, lat: pos.coords.latitude, lng: pos.coords.longitude,
        });
        const distEl = document.getElementById("goal-distance-text");
        if (reached) {
          distEl.textContent = "✅ YOU REACHED YOUR GOAL!";
          distEl.className   = "distance-text close";
          toast("🎯 Goal reached!", "success");
        } else {
          distEl.textContent = distance != null ? `You are ${distance} m away.` : "No goal set yet.";
          distEl.className   = "distance-text";
        }
      } catch (err) { toast(err.message, "danger"); }
      finally {
        btn.textContent = "📍 CHECK IF I REACHED MY GOAL"; btn.disabled = false;
      }
    },
    (err) => {
      toast(`Location error: ${err.message}`, "danger");
      btn.textContent = "📍 CHECK IF I REACHED MY GOAL"; btn.disabled = false;
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

async function tagRunner() {
  const confirmed = window.confirm(
    `Confirm: you physically tagged ${state.players[state.runnerIndex].name}?`
  );
  if (!confirmed) return;

  let tagLat = null, tagLng = null;
  if (navigator.geolocation) {
    try {
      const pos = await new Promise((res, rej) =>
        navigator.geolocation.getCurrentPosition(res, rej, { timeout: 5000 })
      );
      tagLat = pos.coords.latitude;
      tagLng = pos.coords.longitude;
    } catch (_) { /* location optional */ }
  }

  try {
    const { finished, newRunner } = await api("POST", "/api/tag", { lat: tagLat, lng: tagLng });
    if (finished) {
      toast("Game over! Final scores incoming.", "success");
    } else {
      toast(`Runner tagged! ${newRunner.name} is next.`, "success");
    }
  } catch (err) {
    toast(err.message, "danger");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — CHALLENGE CARD (runner only)
// ═══════════════════════════════════════════════════════════════════════════

function renderChallengeCard() {
  const me   = myPlayer();
  const card = document.getElementById("challenge-card");

  if (!me || me.role !== "runner") { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");

  const vetoEl    = document.getElementById("veto-active");
  const activeEl  = document.getElementById("challenge-active");
  const emptyEl   = document.getElementById("challenge-empty");

  if (state.vetoTimer) {
    vetoEl.classList.remove("hidden");
    activeEl.classList.add("hidden");
    emptyEl.classList.add("hidden");

    const remainingMs = state.vetoTimer.remainingMs;
    vetoEndsAt = Date.now() + remainingMs;
    if (!vetoCountdownInterval) {
      vetoCountdownInterval = setInterval(tickVetoCountdown, 1000);
      tickVetoCountdown();
    }
    document.querySelectorAll(".mode-btn").forEach((b) => { b.disabled = true; });

  } else if (state.activeChallenge) {
    clearVetoCountdown();
    vetoEl.classList.add("hidden");
    activeEl.classList.remove("hidden");
    emptyEl.classList.add("hidden");

    document.getElementById("active-challenge-text").textContent   = state.activeChallenge.text;
    document.getElementById("active-challenge-reward").textContent = `+${state.activeChallenge.reward} 🪙${state.doubleNextChallenge ? " (×2 ACTIVE ⚡)" : ""}`;

    // Show/hide the double-penalty warning
    let warnEl = document.getElementById("double-penalty-warn");
    if (state.doubleVetoPending) {
      if (!warnEl) {
        warnEl = document.createElement("p");
        warnEl.id        = "double-penalty-warn";
        warnEl.className = "hint double-penalty-warn";
        warnEl.textContent = "⚡ Double Skip Penalty active — veto costs 10 min cooldown!";
        document.getElementById("challenge-active").appendChild(warnEl);
      }
    } else if (warnEl) {
      warnEl.remove();
    }

  } else {
    clearVetoCountdown();
    vetoEl.classList.add("hidden");
    activeEl.classList.add("hidden");
    emptyEl.classList.remove("hidden");
  }
}

function tickVetoCountdown() {
  if (!vetoEndsAt) return;
  const remaining = Math.max(0, vetoEndsAt - Date.now());
  const mins = String(Math.floor(remaining / 60000)).padStart(1, "0");
  const secs = String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0");
  const el = document.getElementById("veto-timer-text");
  if (el) el.textContent = `${mins}:${secs}`;
  if (remaining <= 0) clearVetoCountdown();
}

function clearVetoCountdown() {
  clearInterval(vetoCountdownInterval);
  vetoCountdownInterval = null;
  vetoEndsAt            = null;
}

async function doneChallenge() {
  const me = myPlayer();
  if (!me || !state.activeChallenge) return;
  try {
    await api("POST", "/api/challenges/complete", { playerId: me.id });
    toast(`Challenge complete! +${state.activeChallenge?.reward || "?"} 🪙`, "success");
  } catch (err) { toast(err.message, "danger"); }
}

async function vetoChallenge() {
  const me = myPlayer();
  if (!me) return;
  const doubled    = !!state.doubleVetoPending;
  const cooldownMin = doubled ? 10 : 5;
  const warningNote = doubled ? "\n⚡ WARNING: Double Skip Penalty is active — cooldown will be 10 minutes!" : "";
  const confirmed = window.confirm(
    `Veto this challenge? You'll have a ${cooldownMin}-minute cooldown with no transport or challenges.${warningNote}`
  );
  if (!confirmed) return;
  try {
    await api("POST", "/api/challenges/veto", { playerId: me.id });
    toast(`Challenge vetoed. ${cooldownMin}-min cooldown started.`, "danger");
  } catch (err) { toast(err.message, "danger"); }
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — SCOREBOARD
// ═══════════════════════════════════════════════════════════════════════════

function renderScoreboard() {
  const list = document.getElementById("scoreboard-list");
  if (!list || !state) return;

  const sorted = [...state.players].sort((a, b) => {
    if (!a.currencyRevealed && !b.currencyRevealed) return 0;
    if (!a.currencyRevealed) return 1;
    if (!b.currencyRevealed) return -1;
    return b.currency - a.currency;
  });

  list.innerHTML = "";
  let rank = 1;
  sorted.forEach((p) => {
    const li     = document.createElement("li");
    li.className = "score-item";
    const isMe   = p.id === myPlayerId;

    const isCurrentRunner = p.role === "runner";
    const showScore = p.currencyRevealed || isMe;

    li.innerHTML = `
      <span class="score-rank${rank === 1 && p.currencyRevealed ? " top" : ""}">${showScore ? rank : "—"}</span>
      <span class="score-name">${p.name}${isMe ? " ◀" : ""}</span>
      <span class="score-role ${p.role}">${p.role.toUpperCase()}</span>
      <span class="score-coins">${showScore ? `🪙 ${p.currency}` : isCurrentRunner ? "🏃 ???" : "—"}</span>
    `;
    if (showScore) rank++;
    list.appendChild(li);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — GAMEMASTER CARD
// ═══════════════════════════════════════════════════════════════════════════

function renderGamemasterCard() {
  const me   = myPlayer();
  const card = document.getElementById("gamemaster-card");
  if (!me?.isGamemaster) { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");

  // ── Edit Coins ────────────────────────────────────────────────────────────
  const list = document.getElementById("gm-coins-list");
  list.innerHTML = "";

  for (const player of state.players) {
    const row = document.createElement("div");
    row.className = "gm-coin-row";
    const displayName = player.name.replace(" (Gamemaster)", "");
    row.innerHTML = `
      <span class="gm-coin-name">${displayName}</span>
      <input class="gm-coin-input" type="number" min="0" max="9999"
             value="${player.currency}" data-player-id="${player.id}" />
      <button class="gm-coin-save" data-player-id="${player.id}">SAVE</button>
    `;
    list.appendChild(row);
  }

  list.querySelectorAll(".gm-coin-save").forEach((btn) => {
    btn.addEventListener("click", () => {
      const pid   = btn.dataset.playerId;
      const input = list.querySelector(`.gm-coin-input[data-player-id="${pid}"]`);
      const val   = parseInt(input.value, 10);
      if (isNaN(val) || val < 0) { toast("Enter a valid coin amount.", "danger"); return; }
      setPlayerCoins(pid, val);
    });
  });

  // Allow Enter key on inputs to save
  list.querySelectorAll(".gm-coin-input").forEach((input) => {
    input.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const pid = input.dataset.playerId;
      const val = parseInt(input.value, 10);
      if (isNaN(val) || val < 0) { toast("Enter a valid coin amount.", "danger"); return; }
      setPlayerCoins(pid, val);
    });
  });
}

async function setPlayerCoins(playerId, amount) {
  try {
    await api("POST", "/api/gamemaster/set-coins", { playerId, amount });
    const p = state.players.find((p) => p.id === playerId);
    const name = (p?.name || "Player").replace(" (Gamemaster)", "");
    toast(`✏️ ${name}'s coins set to ${amount} 🪙`, "success");
  } catch (err) {
    toast(err.message, "danger");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RUNNER GPS BROADCASTING
// ═══════════════════════════════════════════════════════════════════════════
//
// When myPlayer is the runner, we use watchPosition (high accuracy) to
// stream their location to the server continuously.  watchPosition fires:
//   • Immediately on first fix
//   • Whenever the device detects the position has changed
//   • At minimum once per RUNNER_MAX_POSITION_AGE_MS (via maximumAge)
//
// We DON'T use setInterval + getCurrentPosition because:
//   1. watchPosition is more battery-efficient (OS manages the sensor).
//   2. It fires faster on movement, giving chasers sub-second updates.
//   3. Overlapping getCurrentPosition calls cause race conditions on some
//      browsers; watchPosition serialises them automatically.

function startRunnerTracking() {
  if (runnerWatchId !== null) return;   // already watching
  if (!navigator.geolocation) {
    toast("⚠️ Geolocation unavailable — chasers won't see your location.", "warning");
    return;
  }

  runnerWatchId = navigator.geolocation.watchPosition(
    onRunnerPosition,
    onRunnerPositionError,
    {
      enableHighAccuracy: true,
      maximumAge:         RUNNER_MAX_POSITION_AGE_MS,
      timeout:            RUNNER_LOCATION_TIMEOUT_MS,
    }
  );
}

function stopRunnerTracking() {
  if (runnerWatchId === null) return;
  navigator.geolocation.clearWatch(runnerWatchId);
  runnerWatchId = null;
}

async function onRunnerPosition(pos) {
  // Guard: only send if we are still the runner
  const me = myPlayer();
  if (!me || me.role !== "runner") { stopRunnerTracking(); return; }

  // Debounce concurrent sends (watchPosition can fire faster than the
  // network round-trip on very fast movement)
  if (runnerLocationSending) return;
  runnerLocationSending = true;

  try {
    await api("POST", "/api/location/update", {
      playerId: me.id,
      lat:      pos.coords.latitude,
      lng:      pos.coords.longitude,
      accuracy: pos.coords.accuracy,
      heading:  pos.coords.heading,
      speed:    pos.coords.speed,
    });
  } catch (_) {
    // Network hiccup — silent, we'll retry on the next watchPosition event
  } finally {
    runnerLocationSending = false;
  }
}

function onRunnerPositionError(err) {
  // PERMISSION_DENIED (1) — user blocked location
  if (err.code === 1) {
    toast("📍 Location access denied. Chasers can't see you.", "danger", 6000);
    stopRunnerTracking();
  }
  // POSITION_UNAVAILABLE (2) or TIMEOUT (3) — transient, watchPosition retries
}

// ═══════════════════════════════════════════════════════════════════════════
// CHASER TRACKER CARD — Leaflet map
// ═══════════════════════════════════════════════════════════════════════════

function renderTrackerCard() {
  const me   = myPlayer();
  const card = document.getElementById("tracker-card");

  if (!me || me.role !== "chaser") {
    // Runner or no player selected — hide completely and stop runner tracking
    card.classList.add("hidden");
    destroyTrackerMap();
    stopRunnerTracking();

    // If this player is the runner, start broadcasting their location
    if (me && me.role === "runner") {
      startRunnerTracking();
    }
    return;
  }

  // Player is a chaser — ensure runner is NOT broadcasting (role just changed)
  stopRunnerTracking();

  card.classList.remove("hidden");
  ensureTrackerMap();

  // ── Tracker-off power-up active ────────────────────────────────────────
  const blackoutEl = document.getElementById("tracker-blackout");
  if (state.trackerOffTimer) {
    if (blackoutEl) blackoutEl.classList.remove("hidden");
    setTrackerStatus("searching");
    const remainingMs = state.trackerOffTimer.remainingMs;
    if (remainingMs > 0 && !trackerOffCountdownInterval) {
      startTrackerOffCountdown(remainingMs);
    }
  } else {
    if (blackoutEl) blackoutEl.classList.add("hidden");
    clearTrackerOffCountdown();
  }

  // Seed map with last known location in case we missed the Socket.IO push
  if (!lastLocationTs) {
    api("GET", "/api/location/runner").then((loc) => {
      if (loc && loc.lat) updateTrackerMap(loc);
    }).catch(() => {});
  }
}

/**
 * Initialise Leaflet map once, inside #tracker-map.
 * Subsequent calls are no-ops.
 */
function ensureTrackerMap() {
  if (trackerMap) return;

  trackerMap = L.map("tracker-map", {
    zoomControl:       true,
    attributionControl: true,
    // Start centred on a sane default; it'll pan to runner on first fix.
    center: [0, 0],
    zoom:   2,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(trackerMap);

  // Custom runner icon — bright orange dot
  // (We don't use a PNG so there are no asset dependencies)
}

function ensureRunnerPingMap() {
  const card = document.getElementById("ping-map-card");
  if (runnerPingMap) { card.classList.remove("hidden"); return; }

  card.classList.remove("hidden");
  runnerPingMap = L.map("runner-ping-map", {
    zoomControl:        true,
    attributionControl: true,
    center: [0, 0],
    zoom:   2,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(runnerPingMap);
}

function destroyTrackerMap() {
  clearInterval(trackerAgeTimer);
  trackerAgeTimer = null;
  lastLocationTs  = null;

  if (trackerMap) {
    trackerMap.remove();
    trackerMap       = null;
    trackerMarker    = null;
    trackerAccCircle = null;
  }
}

/**
 * showChaserPingOnMap — runner only.
 * Drops a temporary marker for a chaser's one-time pinged location.
 * Marker fades after 30 seconds.
 */
function showChaserPingOnMap(playerId, playerName, lat, lng) {
  // Lazily init a simple map for the runner if it doesn't exist yet
  ensureRunnerPingMap();

  const latlng = L.latLng(lat, lng);
  const marker = L.circleMarker(latlng, {
    radius:      10,
    color:       "#4da6ff",
    fillColor:   "#4da6ff",
    fillOpacity: 0.85,
    weight:      3,
  }).addTo(runnerPingMap);

  marker.bindTooltip(playerName, {
    permanent:  true,
    direction:  "top",
    offset:     [0, -14],
    className:  "tracker-tooltip",
  });

  runnerPingMap.setView(latlng, Math.max(runnerPingMap.getZoom(), 15), { animate: true });

  // Auto-remove marker after 30 s
  setTimeout(() => { try { marker.remove(); } catch (_) {} }, 30000);
}

/**
 * updateTrackerMap(loc)
 * Called every time the server pushes a runner:location event.
 *
 * loc: { lat, lng, accuracy, heading, speed, timestamp, runnerName }
 */
function updateTrackerMap(loc) {
  ensureTrackerMap();

  const latlng = L.latLng(loc.lat, loc.lng);
  lastLocationTs = loc.timestamp || Date.now();

  // ── Marker ──────────────────────────────────────────────────────────────
  if (!trackerMarker) {
    // Create a custom circle marker styled with the app's orange accent
    trackerMarker = L.circleMarker(latlng, {
      radius:      10,
      color:       "#ff5500",
      fillColor:   "#ff5500",
      fillOpacity: 0.9,
      weight:      3,
    }).addTo(trackerMap);

    // Pulse ring — a larger, fading circle marker
    trackerMarker.bindTooltip(loc.runnerName || "Runner", {
      permanent:  true,
      direction:  "top",
      offset:     [0, -14],
      className:  "tracker-tooltip",
    });
  } else {
    trackerMarker.setLatLng(latlng);
    if (loc.runnerName) {
      trackerMarker.setTooltipContent(loc.runnerName);
    }
  }

  // ── Accuracy circle ──────────────────────────────────────────────────────
  const accMeters = typeof loc.accuracy === "number" && loc.accuracy > 0
    ? loc.accuracy
    : null;

  if (accMeters) {
    if (!trackerAccCircle) {
      trackerAccCircle = L.circle(latlng, {
        radius:      accMeters,
        color:       "#ff5500",
        fillColor:   "#ff5500",
        fillOpacity: 0.08,
        weight:      1,
        dashArray:   "4 4",
      }).addTo(trackerMap);
    } else {
      trackerAccCircle.setLatLng(latlng);
      trackerAccCircle.setRadius(accMeters);
    }
  }

  // ── Pan/zoom to runner (keep zoom if user has manually adjusted) ──────────
  if (!trackerMap._userPanned) {
    trackerMap.setView(latlng, Math.max(trackerMap.getZoom(), 16), { animate: true });
  }

  // ── Status badge ─────────────────────────────────────────────────────────
  setTrackerStatus("live");
  document.getElementById("tracker-waiting-hint").classList.add("hidden");
  document.getElementById("tracker-meta").classList.remove("hidden");

  const nameEl = document.getElementById("tracker-runner-name");
  if (nameEl) nameEl.textContent = (loc.runnerName || "Runner").toUpperCase();

  const accEl = document.getElementById("tracker-accuracy");
  if (accEl) accEl.textContent = accMeters ? `±${accMeters}m` : "";

  // Start/restart the "X s ago" ticker
  clearInterval(trackerAgeTimer);
  tickTrackerAge();
  trackerAgeTimer = setInterval(tickTrackerAge, 5000);
}

function clearTrackerLocation() {
  // Called when runner rotates (server sends null)
  lastLocationTs = null;
  setTrackerStatus("searching");
  document.getElementById("tracker-waiting-hint").classList.remove("hidden");
  document.getElementById("tracker-meta").classList.add("hidden");

  if (trackerMarker) { trackerMarker.remove(); trackerMarker = null; }
  if (trackerAccCircle) { trackerAccCircle.remove(); trackerAccCircle = null; }
  clearInterval(trackerAgeTimer);
  trackerAgeTimer = null;

  // Reset map view
  if (trackerMap) trackerMap.setView([0, 0], 2);
}

function tickTrackerAge() {
  const el = document.getElementById("tracker-age");
  if (!el || !lastLocationTs) return;

  const ageMs = Date.now() - lastLocationTs;
  const ageSec = Math.round(ageMs / 1000);

  let label;
  if (ageSec < 5)        label = "just now";
  else if (ageSec < 60)  label = `${ageSec}s ago`;
  else                   label = `${Math.round(ageSec / 60)}m ago`;

  el.textContent = label;

  // Switch to stale if we haven't heard from the runner in a while
  const isStale = ageMs > TRACKER_STALE_THRESHOLD_MS;
  setTrackerStatus(isStale ? "stale" : "live");
}

function setTrackerStatus(status) {
  // status: "searching" | "live" | "stale"
  const el = document.getElementById("tracker-status");
  if (!el) return;
  el.className = `tracker-status tracker-status--${status}`;
  el.textContent = status === "live"
    ? "LIVE"
    : status === "stale"
    ? "STALE"
    : "SEARCHING…";
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — SHOP CARD (runner only)
// ═══════════════════════════════════════════════════════════════════════════

const SHOP_ITEMS_CLIENT = [
  { id: "double_skip",        emoji: "⚡", label: "Double Value + Double Skip Penalty", description: "Next challenge reward ×2. If vetoed, cooldown is 10 min instead of 5.",  cost: 25  },
  { id: "location_ping",      emoji: "📡", label: "Location Ping",                      description: "Ping all chasers' GPS — their locations appear on your map.",            cost: 100 },
  { id: "tracker_off",        emoji: "🚫", label: "Tracker Off — 10 min",               description: "Disables the chasers' live tracker.",                                    cost: 150 },
  { id: "chasers_standstill", emoji: "🧊", label: "Chasers Stand Still — 10 min",       description: "All chasers must freeze for 10 minutes.",                                cost: 200 },
];

function renderShopCard() {
  const me   = myPlayer();
  const card = document.getElementById("shop-card");
  if (!me || me.role !== "runner") { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");

  const list = document.getElementById("shop-items-list");
  list.innerHTML = "";

  const trackerOffActive = !!state.trackerOffTimer;
  const standstillActive = !!state.standstillTimer;
  const doubleActive     = !!state.doubleNextChallenge;

  for (const item of SHOP_ITEMS_CLIENT) {
    const canAfford = me.currency >= item.cost;

    // Disable if already active
    let alreadyActive = false;
    if (item.id === "tracker_off"        && trackerOffActive) alreadyActive = true;
    if (item.id === "chasers_standstill" && standstillActive) alreadyActive = true;
    if (item.id === "double_skip"        && doubleActive)     alreadyActive = true;

    const row = document.createElement("div");
    row.className = "shop-item";
    row.innerHTML = `
      <div class="shop-item-info">
        <span class="shop-item-emoji">${item.emoji}</span>
        <div class="shop-item-text">
          <span class="shop-item-label">${item.label}</span>
          <span class="shop-item-desc">${item.description}</span>
        </div>
      </div>
      <button class="shop-buy-btn${canAfford && !alreadyActive ? "" : " disabled"}"
              data-item-id="${item.id}"
              ${(!canAfford || alreadyActive) ? "disabled" : ""}>
        ${alreadyActive ? "ACTIVE" : `${item.cost} 🪙`}
      </button>
    `;
    list.appendChild(row);
  }

  // Wire buy buttons
  list.querySelectorAll(".shop-buy-btn:not([disabled])").forEach((btn) => {
    btn.addEventListener("click", () => buyShopItem(btn.dataset.itemId));
  });
}

async function buyShopItem(itemId) {
  const me = myPlayer();
  if (!me) return;

  const item = SHOP_ITEMS_CLIENT.find((i) => i.id === itemId);
  if (!item) return;

  const confirmed = window.confirm(`Buy "${item.label}" for ${item.cost} 🪙?`);
  if (!confirmed) return;

  try {
    const { newBalance } = await api("POST", "/api/shop/buy", { playerId: me.id, itemId });
    toast(`${item.emoji} ${item.label} activated!`, "success", 4000);
    // State broadcast will re-render; update coin display immediately
    document.getElementById("coin-display").textContent = `🪙 ${newBalance}`;
  } catch (err) {
    toast(err.message, "danger");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — STANDSTILL BANNER (chasers only)
// ═══════════════════════════════════════════════════════════════════════════

function renderStandstillBanner() {
  const me     = myPlayer();
  const banner = document.getElementById("standstill-banner");
  if (!me || me.role !== "chaser" || !state.standstillTimer) {
    banner.classList.add("hidden");
    return;
  }
  banner.classList.remove("hidden");
  const remainingMs = state.standstillTimer.remainingMs;
  if (remainingMs > 0 && !standstillCountdownInterval) {
    startStandstillCountdown(remainingMs);
  }
}

function startStandstillCountdown(remainingMs) {
  standstillEndsAt = Date.now() + remainingMs;
  clearInterval(standstillCountdownInterval);
  standstillCountdownInterval = setInterval(tickStandstillCountdown, 1000);
  tickStandstillCountdown();
}

function tickStandstillCountdown() {
  if (!standstillEndsAt) return;
  const remaining = Math.max(0, standstillEndsAt - Date.now());
  const mins = String(Math.floor(remaining / 60000)).padStart(1, "0");
  const secs = String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0");
  const el = document.getElementById("standstill-timer-text");
  if (el) el.textContent = `${mins}:${secs}`;
  if (remaining <= 0) {
    clearStandstillCountdown();
    const banner = document.getElementById("standstill-banner");
    if (banner) banner.classList.add("hidden");
  }
}

function clearStandstillCountdown() {
  clearInterval(standstillCountdownInterval);
  standstillCountdownInterval = null;
  standstillEndsAt            = null;
}

// ─── Tracker-off countdown (shown in tracker card header) ─────────────────

function startTrackerOffCountdown(remainingMs) {
  trackerOffEndsAt = Date.now() + remainingMs;
  clearInterval(trackerOffCountdownInterval);
  trackerOffCountdownInterval = setInterval(tickTrackerOffCountdown, 1000);
  tickTrackerOffCountdown();
}

function tickTrackerOffCountdown() {
  if (!trackerOffEndsAt) return;
  const remaining = Math.max(0, trackerOffEndsAt - Date.now());
  const mins = String(Math.floor(remaining / 60000)).padStart(1, "0");
  const secs = String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0");
  const el = document.getElementById("tracker-blackout-timer");
  if (el) el.textContent = `${mins}:${secs}`;
  if (remaining <= 0) clearTrackerOffCountdown();
}

function clearTrackerOffCountdown() {
  clearInterval(trackerOffCountdownInterval);
  trackerOffCountdownInterval = null;
  trackerOffEndsAt            = null;
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — GOALS MAP (all players)
// ═══════════════════════════════════════════════════════════════════════════

function renderGoalsMap() {
  const card = document.getElementById("goals-map-card");
  const goals = state.goals;
  if (!goals || Object.keys(goals).length === 0) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");

  // Init map once
  if (!goalsMap) {
    goalsMap = L.map("goals-map", {
      zoomControl:        true,
      attributionControl: true,
      center: [0, 0],
      zoom:   2,
    });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      attribution: "© OpenStreetMap contributors",
      maxZoom: 19,
    }).addTo(goalsMap);
  }

  // Clear existing markers each render and re-drop them
  goalsMap.eachLayer((layer) => {
    if (layer instanceof L.CircleMarker || layer instanceof L.Marker) {
      layer.remove();
    }
  });

  const bounds = [];
  for (const player of state.players) {
    const goal = goals[player.id];
    if (!goal) continue;
    const latlng = L.latLng(goal.lat, goal.lng);
    bounds.push(latlng);

    const marker = L.circleMarker(latlng, {
      radius:      9,
      color:       player.role === "runner" ? "#ff5500" : "#4da6ff",
      fillColor:   player.role === "runner" ? "#ff5500" : "#4da6ff",
      fillOpacity: 0.9,
      weight:      3,
    }).addTo(goalsMap);

    const displayName = player.name.replace(" (Gamemaster)", "");
    marker.bindTooltip(
      `<span style="font-family:monospace;font-size:11px">${displayName}${goal.label ? `<br><em>${goal.label}</em>` : ""}</span>`,
      { permanent: true, direction: "top", offset: [0, -12] }
    );
  }

  if (bounds.length > 0) {
    if (bounds.length === 1) {
      goalsMap.setView(bounds[0], 15);
    } else {
      goalsMap.fitBounds(L.latLngBounds(bounds), { padding: [32, 32] });
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME OVER
// ═══════════════════════════════════════════════════════════════════════════

function renderFinalScores() {
  const list = document.getElementById("final-scores-list");
  if (!list || !state) return;
  const sorted = [...state.players].sort((a, b) => b.currency - a.currency);
  list.innerHTML = "";
  sorted.forEach((p, i) => {
    const li = document.createElement("li");
    li.className = "score-item";
    li.innerHTML = `
      <span class="score-rank${i === 0 ? " top" : ""}">${i + 1}</span>
      <span class="score-name">${p.name}</span>
      <span class="score-coins">🪙 ${p.currency}</span>
    `;
    list.appendChild(li);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function myPlayer() {
  if (!state || !myPlayerId) return null;
  return state.players.find((p) => p.id === myPlayerId) || null;
}

function clearAll() {
  stopLocalTimer();
  clearVetoCountdown();
  clearJailCountdown();
  clearJailPing();
  stopRunnerTracking();
  destroyTrackerMap();
  clearStandstillCountdown();
  clearTrackerOffCountdown();
  clearInterval(gameTimerInterval);
  gameTimerInterval = null;
  if (runnerPingMap) {
    runnerPingMap.remove();
    runnerPingMap = null;
    document.getElementById("ping-map-card")?.classList.add("hidden");
  }
  if (goalsMap) {
    goalsMap.remove();
    goalsMap = null;
    document.getElementById("goals-map-card")?.classList.add("hidden");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT WIRING
// ═══════════════════════════════════════════════════════════════════════════

function wireEvents() {
  // Rules modal
  document.getElementById("btn-rules").addEventListener("click", () => {
    document.getElementById("rules-modal").classList.remove("hidden");
  });
  document.getElementById("btn-rules-close").addEventListener("click", () => {
    document.getElementById("rules-modal").classList.add("hidden");
  });
  document.getElementById("rules-modal").addEventListener("click", (e) => {
    // Close when tapping the backdrop (outside the inner panel)
    if (e.target === e.currentTarget) {
      e.currentTarget.classList.add("hidden");
    }
  });

  // Goal setup
  document.getElementById("btn-start-game").addEventListener("click", submitAllGoals);

  // Transport
  document.getElementById("transport-modes").addEventListener("click", (e) => {
    const btn = e.target.closest(".mode-btn");
    if (!btn || btn.disabled) return;
    selectMode(btn.dataset.mode);
    const me = myPlayer();
    if (me && !state?.transportTimers?.[me.id]) {
      selectedMode = btn.dataset.mode;
      startTransport();
    }
  });
  document.getElementById("btn-transport-stop").addEventListener("click", stopTransport);

  // Runner
  document.getElementById("btn-check-goal").addEventListener("click", checkGoal);

  // Chaser
  document.getElementById("btn-tag-runner").addEventListener("click", tagRunner);

  // Challenges
  document.getElementById("btn-veto-challenge").addEventListener("click", vetoChallenge);
  document.getElementById("btn-done-challenge").addEventListener("click", doneChallenge);

  // Player selector
  document.getElementById("select-player").addEventListener("change", (e) => {
    myPlayerId = e.target.value;
    socket.emit("identify", { playerId: myPlayerId });
    renderTopBar();
    renderGameTimer();
    renderGoalBanner();
    renderJailBanner();
    renderTransportCard();
    renderRoleCards();
    renderChallengeCard();
    renderTrackerCard();
    renderScoreboard();
    renderGamemasterCard();
    renderShopCard();
    renderStandstillBanner();
    renderGoalsMap();
  });

  // Gamemaster reset
  document.getElementById("btn-reset-game").addEventListener("click", async () => {
    if (!window.confirm("Reset the entire game? This cannot be undone.")) return;
    try { await api("DELETE", "/api/game"); } catch (_) {}
    clearAll();
    location.reload();
  });

  // Gamemaster end game now
  document.getElementById("btn-end-game").addEventListener("click", async () => {
    if (!window.confirm("End the game now and reveal final scores?")) return;
    try { await api("POST", "/api/gamemaster/end-game"); } catch (err) {
      toast(err.message, "danger");
    }
  });

  // New game
  document.getElementById("btn-new-game").addEventListener("click", async () => {
    try { await api("DELETE", "/api/game"); } catch (_) {}
    clearAll();
    location.reload();
  });

  // Detect manual map pan so we stop auto-following
  // (the map may not exist yet; we attach the listener in ensureTrackerMap instead)
  document.getElementById("tracker-map").addEventListener("mousedown", () => {
    if (trackerMap) trackerMap._userPanned = true;
  });
  document.getElementById("tracker-map").addEventListener("touchstart", () => {
    if (trackerMap) trackerMap._userPanned = true;
  }, { passive: true });
}

// ═══════════════════════════════════════════════════════════════════════════
// RULES MODAL — built dynamically from server constants
// ═══════════════════════════════════════════════════════════════════════════

function buildRulesModal(c) {
  // Helper: format ms as "X minutes"
  const mins = (ms) => `${Math.round(ms / 60000)} minutes`;
  const coin = (n) => `${n} 🪙`;

  // Transport rates string e.g. "Walk free · Bike 2/min · Bus 5/min · Train 10/min · Taxi 15/min"
  const transportStr = c
    ? Object.entries(c.TRANSPORT_RATES)
        .map(([mode, rate]) => `${mode.charAt(0).toUpperCase() + mode.slice(1)} ${rate === 0 ? "free" : coin(rate) + "/min"}`)
        .join(" · ")
    : "Walk free · Bike 2 🪙/min · Bus 5 🪙/min · Train 10 🪙/min · Taxi 15 🪙/min";

  // Shop items string
  const shopStr = c
    ? c.SHOP_ITEMS.map((i) => `${i.emoji} ${i.label} — ${coin(i.cost)}`).join("<br>")
    : "See shop card in game";

  const sections = [
    {
      icon: "🎯",
      title: "OBJECTIVE",
      html: `Reach your goal location before the Chasers can physically tag you. Each player takes a turn as the Runner. Whoever reaches their goal wins their round — coins track your performance across the game.`,
    },
    {
      icon: "🏃",
      title: "THE RUNNER",
      html: `You start each turn with a ${c ? coin(c.RUNNER_BONUS) : "50 🪙"} bonus (everyone starts with ${c ? coin(c.STARTING_CURRENCY) : "100 🪙"}). Your goal is shown on the Goals Map — navigate there without being tagged.
             <br><br>
             <strong>Transport</strong> costs coins per minute — only the Runner pays. ${transportStr}. Stop the timer when you exit or you'll keep getting charged.
             <br><br>
             <strong>Challenges</strong> appear while you run — complete them for coin rewards. Veto a challenge to skip it, but you'll be locked out of transport and new challenges for ${c ? mins(c.VETO_DURATION_MS) : "5 minutes"}.
             <br><br>
             <strong>Shop power-ups</strong> (spend your coins):<br>${shopStr}`,
    },
    {
      icon: "🕵",
      title: "THE CHASERS",
      html: `Use the live tracker map to find the Runner's GPS location in real time. When you physically tag them, confirm it in the app to end their turn.
             <br><br>
             <strong>Jail:</strong> after tagging the Runner, all Chasers must stay within ${c ? Math.round(c.JAIL_RADIUS_FEET) : 100} ft of the tag location for ${c ? mins(c.JAIL_DURATION_MS) : "5 minutes"}. Moving away sends a warning to all players. You cannot tag anyone while jailed.
             <br><br>
             Chasers do not pay for transport — move however you like at no cost.`,
    },
    {
      icon: "🔄",
      title: "TURN ROTATION",
      html: `Players rotate as Runner in the order they were entered at the start. When all players have had a turn as Runner, the game ends and final scores are revealed.`,
    },
  ];

  const body = document.getElementById("rules-modal-body");
  if (!body) return;

  body.innerHTML = sections.map((s) => `
    <div class="rules-section">
      <p class="rules-section-title">${s.icon} ${s.title}</p>
      <p class="rules-text">${s.html}</p>
    </div>
  `).join("");
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════

async function init() {
  buildLobby();
  buildTransportModes();
  wireEvents();

  // ── Fetch server constants (rule values) ─────────────────────────────────
  try {
    gameConstants = await api("GET", "/api/game/constants");
    buildRulesModal(gameConstants);
  } catch (_) {
    // Fallback: rules modal will use placeholder text
    buildRulesModal(null);
  }

  // ── Request location permission immediately on page load ─────────────────
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition(
      () => {},
      (err) => {
        if (err.code === 1) {
          toast("📍 Location access denied. GPS features won't work.", "danger", 6000);
        }
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  }

  try {
    const existing = await api("GET", "/api/game/state");
    if (existing && existing.phase !== null) {
      state = existing;
      renderAll();
    } else {
      showScreen("screen-lobby");
    }
  } catch (_) {
    showScreen("screen-lobby");
  }
}

init();

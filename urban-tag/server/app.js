// app.js — Urban Tag client

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const TRANSPORT_MODES = [
  { mode: "walk",  icon: "🚶", label: "Walk"  },
  { mode: "bike",  icon: "🚲", label: "Bike"  },
  { mode: "bus",   icon: "🚌", label: "Bus"   },
  { mode: "train", icon: "🚆", label: "Train" },
  { mode: "taxi",  icon: "🚕", label: "Taxi"  },
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
let trackerMap        = null;   // LEGACY - kept for compat, now points to unifiedMap
let trackerMarker     = null;   // Leaflet circle marker for the runner (high-accuracy)
let trackerAccCircle  = null;   // Leaflet circle for accuracy radius
let trackerAgeTimer   = null;   // setInterval updating the "X s ago" label
let lastLocationTs    = null;   // timestamp of the last received location

// ─── Unified map ─────────────────────────────────────────────────────────────
let unifiedMap        = null;   // Single Leaflet map for all roles
let unifiedMarkers    = {};     // { [playerId]: L.CircleMarker } — coarse player dots
let unifiedGoalMarkers = {};    // { [playerId]: L.CircleMarker } — goal pins
let unifiedRunnerMarker = null; // High-accuracy runner dot (chasers only)
let unifiedRunnerAccCircle = null;
let unifiedPingMarkers = [];    // Temporary chaser ping markers (runner's purchased ping)
let myCoarseLocation  = null;   // { lat, lng } - own coarse location
let coarseLocationInterval = null; // setInterval for infrequent self-location
let goalDistanceInterval = null;   // setInterval for updating distance-to-goal

// ─── Runner ping map (runner only, for location_ping results) ─────────────
let runnerPingMap     = null;   // LEGACY - no longer used (merged into unified map)

// ─── Goals map (all players) ──────────────────────────────────────────────
let goalsMap          = null;   // LEGACY - no longer used (merged into unified map)

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
  renderUnifiedMap();
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
// Chasers use this to update the high-accuracy runner dot on the unified map.
socket.on("runner:location", (loc) => {
  const me = myPlayer();
  // Only chasers render the high-accuracy runner tracker overlay.
  if (!me || me.role !== "chaser") return;
  if (!loc) {
    clearTrackerLocation();
    return;
  }
  updateRunnerOnMap(loc);
});

// ── All-player coarse locations ────────────────────────────────────────────
socket.on("players:locations", (locations) => {
  updatePlayerDotsOnMap(locations);
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
    renderUnifiedMap();
    renderTransportCard();
    renderRoleCards();
    renderChallengeCard();
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
// GAME SCREEN — GOAL BANNER (runner AND chasers)
// ═══════════════════════════════════════════════════════════════════════════

function renderGoalBanner() {
  const me     = myPlayer();
  const banner = document.getElementById("goal-banner");
  if (!me) { banner.classList.add("hidden"); return; }

  const goal = state.goals?.[me.id];
  if (goal?.label) {
    document.getElementById("goal-hint-text").textContent = goal.label;
    banner.classList.remove("hidden");
    // Start distance polling if not already running
    startGoalDistancePolling();
  } else {
    banner.classList.add("hidden");
  }
}

function startGoalDistancePolling() {
  if (goalDistanceInterval) return;
  // Update distance immediately, then every 15 s
  updateGoalDistanceBadge();
  goalDistanceInterval = setInterval(updateGoalDistanceBadge, 15000);
}

function stopGoalDistancePolling() {
  clearInterval(goalDistanceInterval);
  goalDistanceInterval = null;
}

function updateGoalDistanceBadge() {
  const me = myPlayer();
  if (!me) { stopGoalDistancePolling(); return; }
  const goal = state?.goals?.[me.id];
  if (!goal) { stopGoalDistancePolling(); return; }

  const badge   = document.getElementById("goal-distance-badge");
  const distEl  = document.getElementById("goal-distance-live");

  if (!navigator.geolocation) { if (badge) badge.classList.add("hidden"); return; }

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      const dist = haversineClient(
        { lat: pos.coords.latitude, lng: pos.coords.longitude },
        { lat: goal.lat, lng: goal.lng }
      );
      if (badge) badge.classList.remove("hidden");
      if (distEl) {
        if (dist < 1000) {
          distEl.textContent = `${Math.round(dist)} m`;
        } else {
          distEl.textContent = `${(dist / 1000).toFixed(1)} km`;
        }
      }
      // Also store as own coarse location for the map
      myCoarseLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
    },
    () => { if (badge) badge.classList.add("hidden"); },
    { enableHighAccuracy: false, timeout: 6000, maximumAge: 20000 }
  );
}

function haversineClient(a, b) {
  const R     = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat  = toRad(b.lat - a.lat);
  const dLng  = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
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
  for (const { mode, icon, label } of TRANSPORT_MODES) {
    const rate    = gameConstants?.TRANSPORT_RATES?.[mode] ?? null;
    const rateStr = rate == null ? "" : rate === 0 ? " (Free)" : ` (${rate}/min)`;
    const btn = document.createElement("button");
    btn.className    = "mode-btn";
    btn.dataset.mode = mode;
    btn.dataset.rate = rate ?? 0;
    btn.innerHTML    = `<span class="mode-icon">${icon}</span>${label}${rateStr}`;
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
      (() => {
        const m    = TRANSPORT_MODES.find((m) => m.mode === timer.mode);
        const rate = gameConstants?.TRANSPORT_RATES?.[timer.mode] ?? timer.ratePerMinute ?? 0;
        const rateStr = rate === 0 ? " (Free)" : ` (${rate}/min)`;
        return m ? `${m.icon} ${m.label}${rateStr}` : timer.mode;
      })();

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
    const rate          = gameConstants?.TRANSPORT_RATES?.[selectedMode] ?? 0;
    const rateStr       = rate === 0 ? " (Free)" : ` (${rate}/min)`;
    transportTimerStart = Date.now();
    transportTimerRate  = rate;
    startLocalTimer();
    document.getElementById("transport-active").classList.remove("hidden");
    document.getElementById("transport-mode-label").textContent =
      modeInfo ? `${modeInfo.icon} ${modeInfo.label}${rateStr}` : selectedMode;
    toast(`${modeInfo?.label ?? selectedMode} timer started${rate > 0 ? ` (${rate} 🪙/min)` : " (free)"}`);
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

    // Veto penalty reminder — always shown, references the live constant
    let vetoHintEl = document.getElementById("veto-penalty-hint");
    if (!vetoHintEl) {
      vetoHintEl = document.createElement("p");
      vetoHintEl.id        = "veto-penalty-hint";
      vetoHintEl.className = "hint muted-center";
      document.getElementById("challenge-actions") || document.querySelector(".challenge-actions")
        ? document.querySelector(".challenge-actions").insertAdjacentElement("afterend", vetoHintEl)
        : document.getElementById("challenge-active").appendChild(vetoHintEl);
    }
    const vetoDurationMin = gameConstants ? Math.round(gameConstants.VETO_DURATION_MS / 60000) : 5;
    vetoHintEl.textContent = `⚠️ Veto = ${vetoDurationMin}-min cooldown — no transport or new challenges`;

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
  const vetoDurationMin = gameConstants ? Math.round(gameConstants.VETO_DURATION_MS / 60000) : 5;
  const doubled    = !!state.doubleVetoPending;
  const cooldownMin = doubled ? vetoDurationMin * 2 : vetoDurationMin;
  const warningNote = doubled ? `\n⚡ WARNING: Double Skip Penalty is active — cooldown will be ${vetoDurationMin * 2} minutes!` : "";
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
// COARSE SELF-LOCATION (all roles)
// ═══════════════════════════════════════════════════════════════════════════
//
// Every player (runner AND chasers) pings their own GPS infrequently so their
// own dot shows on the "My Location & Goals" map and so the goal-banner can
// display a live distance estimate.  We use a 30-second interval — accurate
// enough for the map without hammering the battery.
//
// For the runner, this runs alongside the high-accuracy watchPosition stream
// (which is used for the chasers' tracker).  The coarse ping is only for the
// runner's own map dot and distance badge; it does NOT replace watchPosition.

const COARSE_INTERVAL_MS = 30 * 1000;  // 30 s between self-location pings

function startCoarseLocationReporting() {
  if (coarseLocationInterval) return;   // already running
  if (!navigator.geolocation) return;
  // Fire immediately, then on a repeating interval
  reportCoarseLocation();
  coarseLocationInterval = setInterval(reportCoarseLocation, COARSE_INTERVAL_MS);
}

function stopCoarseLocationReporting() {
  clearInterval(coarseLocationInterval);
  coarseLocationInterval = null;
}

function reportCoarseLocation() {
  const me = myPlayer();
  if (!me) { stopCoarseLocationReporting(); return; }
  if (!navigator.geolocation) return;

  navigator.geolocation.getCurrentPosition(
    (pos) => {
      myCoarseLocation = { lat: pos.coords.latitude, lng: pos.coords.longitude };
      updateOwnDotOnMap(pos.coords.latitude, pos.coords.longitude);
      // Also report to server so all players see each other's dots
      api("POST", "/api/location/coarse", {
        playerId: me.id,
        lat: pos.coords.latitude,
        lng: pos.coords.longitude,
      }).catch(() => {});
    },
    () => {},
    { enableHighAccuracy: false, timeout: 8000, maximumAge: COARSE_INTERVAL_MS }
  );
}

// Update (or create) the current player's own dot on the unified map.
// Called both from reportCoarseLocation and from updateGoalDistanceBadge so
// the dot appears as soon as we have any position fix.
function updateOwnDotOnMap(lat, lng) {
  if (!unifiedMap || !myPlayerId) return;
  const me          = myPlayer();
  if (!me) return;
  const latlng      = L.latLng(lat, lng);
  const displayName = me.name.replace(" (Gamemaster)", "");
  const label       = `${displayName} (you)`;

  if (unifiedMarkers[myPlayerId]) {
    unifiedMarkers[myPlayerId].setLatLng(latlng);
  } else {
    const m = L.circleMarker(latlng, {
      radius:      8,
      color:       "#22cc66",
      fillColor:   "#22cc66",
      fillOpacity: 0.9,
      weight:      3,
    }).addTo(unifiedMap);
    m.bindTooltip(label, { permanent: true, direction: "top", offset: [0, -11], className: "tracker-tooltip" });
    unifiedMarkers[myPlayerId] = m;
  }

  // On first own-location fix, centre the map there (unless already fitted to goals)
  if (!unifiedMap._everFitted) {
    unifiedMap._everFitted = true;
    unifiedMap.setView(latlng, 15);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// UNIFIED MAP — single Leaflet map for all roles
// ═══════════════════════════════════════════════════════════════════════════
//
// Runner view:  own dot (green) · goal pins · chaser ping dots (purchased)
// Chaser view:  own dot (green) · all other player dots · goal pins
//               · high-accuracy runner dot (orange) · tracker-off blackout overlay

function renderUnifiedMap() {
  const me   = myPlayer();
  const card = document.getElementById("unified-map-card");
  if (!me) { card.classList.add("hidden"); return; }

  const isRunner = me.role === "runner";
  const isChaser = me.role === "chaser";

  // Start / stop location broadcasting based on role
  if (isRunner) {
    startRunnerTracking();
    // Runner still needs coarse location for their own dot on the map
    startCoarseLocationReporting();
  } else {
    stopRunnerTracking();
    startCoarseLocationReporting();
  }

  card.classList.remove("hidden");
  ensureUnifiedMap();

  // Title
  const titleEl = document.getElementById("unified-map-title");
  if (titleEl) titleEl.textContent = isChaser ? "📍 MY LOCATION & GOALS  📡 LIVE TRACKER" : "📍 MY LOCATION & GOALS";

  // ── Tracker-off blackout (chasers only — hides the high-accuracy runner dot) ──
  const blackoutEl = document.getElementById("tracker-blackout");
  if (isChaser && state.trackerOffTimer) {
    if (blackoutEl) blackoutEl.classList.remove("hidden");
    setTrackerStatus("searching");
    const remainingMs = state.trackerOffTimer.remainingMs;
    if (remainingMs > 0 && !trackerOffCountdownInterval) {
      startTrackerOffCountdown(remainingMs);
    }
  } else {
    if (blackoutEl) blackoutEl.classList.add("hidden");
    if (!state.trackerOffTimer) clearTrackerOffCountdown();
  }

  // ── Runner meta row (chasers only) ────────────────────────────────────────
  const metaEl = document.getElementById("tracker-meta");
  if (metaEl) metaEl.classList.toggle("hidden", !isChaser);

  // ── Hint lines ────────────────────────────────────────────────────────────
  const waitHint = document.getElementById("tracker-waiting-hint");
  if (waitHint) waitHint.style.display = (isChaser && !lastLocationTs) ? "" : "none";

  // Show the "ping expires" note only for runners who have purchased a ping
  const pingHint = document.getElementById("ping-expire-hint");
  if (pingHint) pingHint.style.display = (isRunner && unifiedPingMarkers.length > 0) ? "" : "none";

  // ── Status badge ──────────────────────────────────────────────────────────
  const statusEl = document.getElementById("unified-map-status");
  if (statusEl) {
    if (isChaser) {
      statusEl.classList.remove("hidden");
      // status is managed by setTrackerStatus / tickTrackerAge
      if (!lastLocationTs && !state.trackerOffTimer) setTrackerStatus("searching");
    } else {
      statusEl.classList.add("hidden");
    }
  }

  // ── Drop goal pins ─────────────────────────────────────────────────────────
  refreshGoalPins();

  // ── Seed runner location for chasers joining mid-game ─────────────────────
  if (isChaser && !lastLocationTs) {
    api("GET", "/api/location/runner").then((loc) => {
      if (loc && loc.lat) updateRunnerOnMap(loc);
    }).catch(() => {});
  }

  // ── Seed all player dots ───────────────────────────────────────────────────
  api("GET", "/api/location/players").then((locs) => {
    if (locs) updatePlayerDotsOnMap(locs);
  }).catch(() => {});
}

function ensureUnifiedMap() {
  if (unifiedMap) return;

  unifiedMap = L.map("unified-map", {
    zoomControl:        true,
    attributionControl: true,
    center: [0, 0],
    zoom:   2,
  });

  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: "© OpenStreetMap contributors",
    maxZoom: 19,
  }).addTo(unifiedMap);

  // Stop auto-follow when user pans
  unifiedMap.on("dragstart", () => { unifiedMap._userPanned = true; });
}

function destroyUnifiedMap() {
  clearInterval(trackerAgeTimer);
  trackerAgeTimer = null;
  lastLocationTs  = null;

  if (unifiedMap) {
    unifiedMap.remove();
    unifiedMap             = null;
    unifiedMarkers         = {};
    unifiedGoalMarkers     = {};
    unifiedRunnerMarker    = null;
    unifiedRunnerAccCircle = null;
    unifiedPingMarkers     = [];
  }
}

// ── Goal pins ──────────────────────────────────────────────────────────────

function refreshGoalPins() {
  if (!unifiedMap || !state) return;
  const goals = state.goals || {};

  // Remove stale markers for players no longer in goals
  for (const pid of Object.keys(unifiedGoalMarkers)) {
    if (!goals[pid]) {
      try { unifiedGoalMarkers[pid].remove(); } catch (_) {}
      delete unifiedGoalMarkers[pid];
    }
  }

  const bounds = [];
  for (const player of state.players) {
    const goal = goals[player.id];
    if (!goal) continue;

    const latlng = L.latLng(goal.lat, goal.lng);
    bounds.push(latlng);
    const isRunner  = player.role === "runner";
    const color     = isRunner ? "#ff5500" : "#4da6ff";
    const displayName = player.name.replace(" (Gamemaster)", "");
    const tooltipHtml = `<span style="font-family:monospace;font-size:11px">🎯 ${displayName}${goal.label ? `<br><em>${goal.label}</em>` : ""}</span>`;

    if (unifiedGoalMarkers[player.id]) {
      // Update tooltip in case label changed
      unifiedGoalMarkers[player.id].setTooltipContent(tooltipHtml);
    } else {
      const marker = L.circleMarker(latlng, {
        radius:      10,
        color,
        fillColor:   color,
        fillOpacity: 0.85,
        weight:      3,
      }).addTo(unifiedMap);
      marker.bindTooltip(tooltipHtml, { permanent: true, direction: "top", offset: [0, -13] });
      unifiedGoalMarkers[player.id] = marker;
    }
  }

  // If map has never been centred, fit to goal bounds
  if (!unifiedMap._everFitted && bounds.length > 0) {
    unifiedMap._everFitted = true;
    if (bounds.length === 1) {
      unifiedMap.setView(bounds[0], 15);
    } else {
      unifiedMap.fitBounds(L.latLngBounds(bounds), { padding: [40, 40] });
    }
  }
}

// ── Player coarse dots (all players) ─────────────────────────────────────

function updatePlayerDotsOnMap(locations) {
  if (!unifiedMap) return;
  const me = myPlayer();

  for (const [pid, loc] of Object.entries(locations)) {
    const player      = state?.players?.find((p) => p.id === pid);
    const isMe        = pid === myPlayerId;
    const isRunner    = player?.role === "runner";
    const meIsRunner  = me?.role === "runner";

    // Runner's view: only show their own dot from server broadcasts.
    // Chasers are only revealed via the purchased location ping (showChaserPingOnMap).
    // Own dot is handled by updateOwnDotOnMap which is more responsive.
    if (meIsRunner && !isMe) continue;
    // Skip own dot from server broadcast — updateOwnDotOnMap handles it
    // with a fresher local fix, so we only use server data for other players.
    if (isMe) continue;

    const latlng      = L.latLng(loc.lat, loc.lng);
    const displayName = (loc.playerName || "").replace(" (Gamemaster)", "");

    // Color: runner = orange, chaser = blue
    const color = isRunner ? "#ff5500" : "#4da6ff";
    const label = displayName;

    if (unifiedMarkers[pid]) {
      unifiedMarkers[pid].setLatLng(latlng);
      unifiedMarkers[pid].setTooltipContent(label);
    } else {
      const m = L.circleMarker(latlng, {
        radius:      8,
        color,
        fillColor:   color,
        fillOpacity: 0.9,
        weight:      3,
      }).addTo(unifiedMap);
      m.bindTooltip(label, { permanent: true, direction: "top", offset: [0, -11], className: "tracker-tooltip" });
      unifiedMarkers[pid] = m;
    }
  }
}

// ── High-accuracy runner dot (chasers only) ────────────────────────────────

function updateRunnerOnMap(loc) {
  // This is the high-accuracy runner position pushed via watchPosition.
  // Only rendered for chasers; runners don't see themselves on a tracker.
  ensureUnifiedMap();

  const latlng = L.latLng(loc.lat, loc.lng);
  lastLocationTs = loc.timestamp || Date.now();

  if (!unifiedRunnerMarker) {
    unifiedRunnerMarker = L.circleMarker(latlng, {
      radius:      11,
      color:       "#ff5500",
      fillColor:   "#ff5500",
      fillOpacity: 0.95,
      weight:      3,
    }).addTo(unifiedMap);
    unifiedRunnerMarker.bindTooltip(loc.runnerName || "Runner", {
      permanent: true, direction: "top", offset: [0, -15], className: "tracker-tooltip",
    });
  } else {
    unifiedRunnerMarker.setLatLng(latlng);
    if (loc.runnerName) unifiedRunnerMarker.setTooltipContent(loc.runnerName);
  }

  // Accuracy ring
  const accMeters = typeof loc.accuracy === "number" && loc.accuracy > 0 ? loc.accuracy : null;
  if (accMeters) {
    if (!unifiedRunnerAccCircle) {
      unifiedRunnerAccCircle = L.circle(latlng, {
        radius:      accMeters,
        color:       "#ff5500",
        fillColor:   "#ff5500",
        fillOpacity: 0.07,
        weight:      1,
        dashArray:   "4 4",
      }).addTo(unifiedMap);
    } else {
      unifiedRunnerAccCircle.setLatLng(latlng);
      unifiedRunnerAccCircle.setRadius(accMeters);
    }
  }

  // Auto-pan only if user hasn't manually moved the map
  if (!unifiedMap._userPanned) {
    unifiedMap.setView(latlng, Math.max(unifiedMap.getZoom(), 16), { animate: true });
  }

  setTrackerStatus("live");
  const waitHint = document.getElementById("tracker-waiting-hint");
  if (waitHint) waitHint.style.display = "none";
  const metaEl = document.getElementById("tracker-meta");
  if (metaEl) metaEl.classList.remove("hidden");

  const nameEl = document.getElementById("tracker-runner-name");
  if (nameEl) nameEl.textContent = (loc.runnerName || "Runner").toUpperCase();
  const accEl  = document.getElementById("tracker-accuracy");
  if (accEl)  accEl.textContent  = accMeters ? `±${accMeters}m` : "";

  clearInterval(trackerAgeTimer);
  tickTrackerAge();
  trackerAgeTimer = setInterval(tickTrackerAge, 5000);
}

function clearTrackerLocation() {
  lastLocationTs = null;
  setTrackerStatus("searching");

  const waitHint = document.getElementById("tracker-waiting-hint");
  if (waitHint) waitHint.style.display = "";
  const metaEl = document.getElementById("tracker-meta");
  if (metaEl) metaEl.classList.add("hidden");

  if (unifiedRunnerMarker)    { unifiedRunnerMarker.remove();    unifiedRunnerMarker    = null; }
  if (unifiedRunnerAccCircle) { unifiedRunnerAccCircle.remove(); unifiedRunnerAccCircle = null; }
  clearInterval(trackerAgeTimer);
  trackerAgeTimer = null;
}

function tickTrackerAge() {
  const el = document.getElementById("tracker-age");
  if (!el || !lastLocationTs) return;
  const ageMs  = Date.now() - lastLocationTs;
  const ageSec = Math.round(ageMs / 1000);
  el.textContent = ageSec < 5 ? "just now" : ageSec < 60 ? `${ageSec}s ago` : `${Math.round(ageSec / 60)}m ago`;
  setTrackerStatus(ageMs > TRACKER_STALE_THRESHOLD_MS ? "stale" : "live");
}

function setTrackerStatus(status) {
  const el = document.getElementById("unified-map-status");
  if (!el) return;
  el.className   = `tracker-status tracker-status--${status}`;
  el.textContent = status === "live" ? "LIVE" : status === "stale" ? "STALE" : "SEARCHING…";
}

// ── Chaser ping markers (runner's purchased location_ping) ─────────────────

function showChaserPingOnMap(playerId, playerName, lat, lng) {
  ensureUnifiedMap();

  const latlng = L.latLng(lat, lng);
  const marker = L.circleMarker(latlng, {
    radius:      10,
    color:       "#f0c040",
    fillColor:   "#f0c040",
    fillOpacity: 0.9,
    weight:      3,
  }).addTo(unifiedMap);

  marker.bindTooltip(`📡 ${playerName}`, {
    permanent: true, direction: "top", offset: [0, -14], className: "tracker-tooltip",
  });

  unifiedPingMarkers.push(marker);
  unifiedMap.setView(latlng, Math.max(unifiedMap.getZoom(), 15), { animate: true });

  // Show "ping expires" hint
  const pingHint = document.getElementById("ping-expire-hint");
  if (pingHint) pingHint.style.display = "";

  setTimeout(() => {
    try { marker.remove(); } catch (_) {}
    const idx = unifiedPingMarkers.indexOf(marker);
    if (idx !== -1) unifiedPingMarkers.splice(idx, 1);
    if (unifiedPingMarkers.length === 0) {
      const h = document.getElementById("ping-expire-hint");
      if (h) h.style.display = "none";
    }
  }, 30000);
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — SHOP CARD (runner only)
// ═══════════════════════════════════════════════════════════════════════════

// Shop items are fetched from the server via gameConstants so costs stay in sync with game.js.
// Falls back to an empty array before constants load (shop card won't render until game starts).
function getShopItemsClient() {
  return gameConstants?.SHOP_ITEMS ?? [];
}

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

  for (const item of getShopItemsClient()) {
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

  const item = getShopItemsClient().find((i) => i.id === itemId);
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
  stopCoarseLocationReporting();
  stopGoalDistancePolling();
  destroyUnifiedMap();
  clearStandstillCountdown();
  clearTrackerOffCountdown();
  clearInterval(gameTimerInterval);
  gameTimerInterval = null;
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
    renderUnifiedMap();
    renderScoreboard();
    renderGamemasterCard();
    renderShopCard();
    renderStandstillBanner();
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

  // Detect manual map pan so we stop auto-following the runner
  document.getElementById("unified-map").addEventListener("mousedown", () => {
    if (unifiedMap) unifiedMap._userPanned = true;
  });
  document.getElementById("unified-map").addEventListener("touchstart", () => {
    if (unifiedMap) unifiedMap._userPanned = true;
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
             <strong>Challenges</strong> appear while you run — complete them for coin rewards. VIDEO PROOF! Veto a challenge to skip it, but you'll be locked out of transport and new challenges for ${c ? mins(c.VETO_DURATION_MS) : "5 minutes"}.
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
  wireEvents();

  // ── Fetch server constants (rule values) ─────────────────────────────────
  try {
    gameConstants = await api("GET", "/api/game/constants");
    buildRulesModal(gameConstants);
  } catch (_) {
    // Fallback: rules modal will use placeholder text
    buildRulesModal(null);
  }

  // Build transport buttons after constants are loaded so rates show correctly
  buildTransportModes();

  // Patch static HTML text that references game constants
  if (gameConstants) {
    const fmtTimer = (ms) => {
      const totalSec = Math.round(ms / 1000);
      const m = Math.floor(totalSec / 60);
      const s = String(totalSec % 60).padStart(2, "0");
      return `${m}:${s}`;
    };
    const jailHint = document.querySelector("#jail-banner .hint");
    if (jailHint) {
      jailHint.textContent = `Stay within ${Math.round(gameConstants.JAIL_RADIUS_FEET)} ft of the tag location. Don't move!`;
    }
    const jailTimer = document.getElementById("jail-timer-text");
    if (jailTimer) jailTimer.textContent = fmtTimer(gameConstants.JAIL_DURATION_MS);

    const standstillTimer = document.getElementById("standstill-timer-text");
    if (standstillTimer) standstillTimer.textContent = fmtTimer(gameConstants.STANDSTILL_DURATION_MS);

    const vetoTimer = document.getElementById("veto-timer-text");
    if (vetoTimer) vetoTimer.textContent = fmtTimer(gameConstants.VETO_DURATION_MS);

    document.querySelectorAll("#tracker-blackout-timer").forEach((el) => {
      el.textContent = fmtTimer(gameConstants.TRACKER_OFF_DURATION_MS);
    });
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

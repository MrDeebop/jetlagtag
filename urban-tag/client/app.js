// app.js — Urban Tag client
// Talks to server.js via fetch (REST) and Socket.IO (real-time).
// Single-page app: all screens live in index.html, shown/hidden here.
//
// Works both locally (http://localhost:3000) and on any cloud host
// (Render, Railway, Fly.io …) — no hardcoded URLs needed because the
// server serves this file, so window.location.origin IS the server.

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS  (must match game.js on the server)
// ═══════════════════════════════════════════════════════════════════════════

const TRANSPORT_MODES = [
  { mode: "walk",  icon: "🚶", label: "Walk",  rate: 0  },
  { mode: "bike",  icon: "🚲", label: "Bike",  rate: 2  },
  { mode: "bus",   icon: "🚌", label: "Bus",   rate: 5  },
  { mode: "train", icon: "🚆", label: "Train", rate: 10 },
  { mode: "taxi",  icon: "🚕", label: "Taxi",  rate: 15 },
];

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

let state          = null;   // latest GameState from server
let myPlayerId     = null;   // which player this device is acting as
let challenges     = [];     // static challenge pool (fetched once)
let selectedMode   = "walk"; // currently highlighted transport mode

// Client-side transport timer (for responsive UI — server is authoritative on stop)
let transportTimerInterval = null;
let transportTimerStart    = null;  // Date.now() when session started
let transportTimerRate     = 0;     // coins per minute for current mode

// ═══════════════════════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════════

// io() with no arguments connects back to the origin that served this page,
// which works correctly both locally and on any cloud host.
const socket = io();

socket.on("connect", () => {
  // Re-identify after reconnect (e.g. phone woke from sleep)
  if (myPlayerId) socket.emit("identify", { playerId: myPlayerId });
});

socket.on("state:update", (newState) => {
  state = newState;
  renderAll();
});

socket.on("runner:tagged", ({ taggedPlayer, newRunner }) => {
  toast(`${taggedPlayer.name} was tagged! ${newRunner.name} is now the runner.`, "default");
});

socket.on("goal:reached", ({ playerName }) => {
  toast(`🎯 ${playerName} reached their goal!`, "success");
});

socket.on("goal:assigned", ({ label }) => {
  toast(`🗺 Your goal: "${label}"`, "success");
});

socket.on("challenge:completed", ({ playerId, challengeId }) => {
  const p = state?.players.find((p) => p.id === playerId);
  if (p && playerId !== myPlayerId) {
    toast(`${p.name} completed a challenge!`);
  }
  renderChallengeList(); // refresh ticks
});

socket.on("transport:tick", ({ playerId, estimatedCost }) => {
  // Server pushes every 5s — update display for other players if desired
  // (this player's timer is handled by the local interval)
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
  state      = null;
  myPlayerId = null;
  showScreen("screen-lobby");
  toast("Game was reset.");
});

// ═══════════════════════════════════════════════════════════════════════════
// FETCH HELPER
// ═══════════════════════════════════════════════════════════════════════════

async function api(method, path, body) {
  const opts = {
    method,
    headers: { "Content-Type": "application/json" },
  };
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

function toast(message, type = "default", duration = 3000) {
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
    renderGoalBanner();
    renderTransportCard();
    renderRoleCards();
    renderChallengeList();
    renderScoreboard();
    return;
  }

  // lobby — stay on lobby screen
}

// ═══════════════════════════════════════════════════════════════════════════
// LOBBY SCREEN
// ═══════════════════════════════════════════════════════════════════════════

function buildLobby() {
  const container = document.getElementById("player-inputs");
  container.innerHTML = "";
  // Start with 2 rows
  addPlayerRow();
  addPlayerRow();

  document.getElementById("btn-add-player").addEventListener("click", () => {
    const rows = container.querySelectorAll(".player-row").length;
    if (rows >= 5) {
      toast("Maximum 5 players.", "danger");
      return;
    }
    addPlayerRow();
  });

  document.getElementById("btn-create-game").addEventListener("click", createGame);
}

function addPlayerRow() {
  const container = document.getElementById("player-inputs");
  const n         = container.querySelectorAll(".player-row").length + 1;
  const row       = document.createElement("div");
  row.className   = "player-row";
  row.innerHTML   = `
    <span class="player-num">${n}</span>
    <input class="player-name" type="text" placeholder="Player ${n} name" maxlength="20" autocomplete="off" />
  `;
  container.appendChild(row);
  row.querySelector("input").focus();
}

async function createGame() {
  const inputs = document.querySelectorAll(".player-name");
  const names  = Array.from(inputs).map((i) => i.value.trim()).filter(Boolean);

  if (names.length < 2) {
    toast("Enter at least 2 player names.", "danger");
    return;
  }

  const btn       = document.getElementById("btn-create-game");
  btn.textContent = "CREATING…";
  btn.disabled    = true;

  try {
    const data = await api("POST", "/api/game/create", { players: names });
    state      = data.state;
    showGoalSetup();
  } catch (err) {
    toast(err.message, "danger");
    btn.textContent = "CREATE GAME";
    btn.disabled    = false;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GOAL SETUP SCREEN
// ═══════════════════════════════════════════════════════════════════════════

function showGoalSetup() {
  if (!state) return;
  const runner = state.players[state.runnerIndex];
  document.getElementById("goal-runner-name").textContent = runner.name.toUpperCase();
  document.getElementById("goal-lat").value               = "";
  document.getElementById("goal-lng").value               = "";
  document.getElementById("goal-label").value             = "";
  document.getElementById("goal-hint").textContent        = "";
  showScreen("screen-goal-setup");
}

async function submitGoal() {
  const lat   = parseFloat(document.getElementById("goal-lat").value);
  const lng   = parseFloat(document.getElementById("goal-lng").value);
  const label = document.getElementById("goal-label").value.trim();

  if (isNaN(lat) || isNaN(lng)) {
    toast("Enter valid lat and lng coordinates.", "danger");
    return;
  }
  if (!label) {
    toast("Enter a hint for the runner.", "danger");
    return;
  }

  const runner    = state.players[state.runnerIndex];
  const btn       = document.getElementById("btn-set-goal");
  btn.textContent = "SAVING…";
  btn.disabled    = true;

  try {
    await api("POST", "/api/goal/set", { playerId: runner.id, lat, lng, label });

    // First round: also transition lobby → running
    if (state.phase === "lobby") {
      await api("POST", "/api/game/start");
    }

    toast(`Goal set for ${runner.name}!`, "success");
    // state:update from socket will trigger renderAll() and switch screen
  } catch (err) {
    toast(err.message, "danger");
  } finally {
    btn.textContent = "SET GOAL & START ROUND";
    btn.disabled    = false;
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
    const opt       = document.createElement("option");
    opt.value       = p.id;
    opt.textContent = p.name;
    select.appendChild(opt);
  }

  // Restore selection or default to first player
  if (myPlayerId && state.players.find((p) => p.id === myPlayerId)) {
    select.value = myPlayerId;
  } else if (prev && state.players.find((p) => p.id === prev)) {
    select.value = prev;
    myPlayerId   = prev;
  } else {
    myPlayerId   = select.value = state.players[0].id;
    socket.emit("identify", { playerId: myPlayerId });
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — TOP BAR
// ═══════════════════════════════════════════════════════════════════════════

function renderTopBar() {
  const me = myPlayer();
  if (!me) return;

  const badge       = document.getElementById("role-badge");
  badge.textContent = me.role === "runner" ? "RUNNER 🏃" : "CHASER 🕵";
  badge.className   = `role-badge ${me.role}`;

  document.getElementById("coin-display").textContent = `🪙 ${me.currency}`;
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — GOAL BANNER (runner only)
// ═══════════════════════════════════════════════════════════════════════════

function renderGoalBanner() {
  const me     = myPlayer();
  const banner = document.getElementById("goal-banner");

  if (!me || me.role !== "runner") {
    banner.classList.add("hidden");
    return;
  }

  const goal = state.goals?.[me.id];
  if (goal?.label) {
    document.getElementById("goal-hint-text").textContent = goal.label;
    banner.classList.remove("hidden");
  } else {
    banner.classList.add("hidden");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — TRANSPORT
// ═══════════════════════════════════════════════════════════════════════════

function buildTransportModes() {
  const container = document.getElementById("transport-modes");
  container.innerHTML = "";

  for (const { mode, icon, label, rate } of TRANSPORT_MODES) {
    const btn          = document.createElement("button");
    btn.className      = "mode-btn";
    btn.dataset.mode   = mode;
    btn.dataset.rate   = rate;
    btn.innerHTML      = `<span class="mode-icon">${icon}</span>${label}`;
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
  const me     = myPlayer();
  const active = document.getElementById("transport-active");
  const timer  = me ? state.transportTimers?.[me.id] : null;

  if (timer) {
    active.classList.remove("hidden");
    document.getElementById("transport-mode-label").textContent =
      TRANSPORT_MODES.find((m) => m.mode === timer.mode)?.label || timer.mode;

    // Resume local timer from server-reported elapsed time (handles page reload)
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

  if (state.transportTimers?.[me.id]) {
    toast("Stop your current transport first.", "danger");
    return;
  }

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
  tickLocalTimer(); // run immediately
}

function stopLocalTimer() {
  clearInterval(transportTimerInterval);
  transportTimerInterval = null;
  transportTimerStart    = null;
  transportTimerRate     = 0;
  document.getElementById("transport-elapsed").textContent  = "00:00";
  document.getElementById("transport-est-cost").textContent = "≈ 0 🪙";
}

function tickLocalTimer() {
  if (!transportTimerStart) return;
  const elapsedMs      = Date.now() - transportTimerStart;
  const elapsedSec     = Math.floor(elapsedMs / 1000);
  const elapsedMinutes = elapsedMs / 60000;
  const cost           = Math.round(elapsedMinutes * transportTimerRate);

  const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const ss = String(elapsedSec % 60).padStart(2, "0");

  document.getElementById("transport-elapsed").textContent  = `${mm}:${ss}`;
  document.getElementById("transport-est-cost").textContent = `≈ ${cost} 🪙`;
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — ROLE CARDS (runner / chaser)
// ═══════════════════════════════════════════════════════════════════════════

function renderRoleCards() {
  const me         = myPlayer();
  const runnerCard = document.getElementById("runner-card");
  const chaserCard = document.getElementById("chaser-card");

  if (!me) {
    runnerCard.classList.add("hidden");
    chaserCard.classList.add("hidden");
    return;
  }

  if (me.role === "runner") {
    runnerCard.classList.remove("hidden");
    chaserCard.classList.add("hidden");
  } else {
    runnerCard.classList.add("hidden");
    chaserCard.classList.remove("hidden");
  }
}

async function checkGoal() {
  const me = myPlayer();
  if (!me) return;

  if (!navigator.geolocation) {
    toast("Geolocation not available on this device.", "danger");
    return;
  }

  const btn       = document.getElementById("btn-check-goal");
  btn.textContent = "GETTING LOCATION…";
  btn.disabled    = true;

  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const lat = pos.coords.latitude;
      const lng = pos.coords.longitude;

      try {
        const { reached, distance } = await api("POST", "/api/goal/check", {
          playerId: me.id, lat, lng,
        });

        const distEl = document.getElementById("goal-distance-text");
        if (reached) {
          distEl.textContent = "✅ YOU REACHED YOUR GOAL!";
          distEl.className   = "distance-text close";
          toast("🎯 Goal reached!", "success");
        } else {
          distEl.textContent = distance != null
            ? `You are ${distance} m away from your goal.`
            : "No goal set yet.";
          distEl.className = "distance-text";
        }
      } catch (err) {
        toast(err.message, "danger");
      } finally {
        btn.textContent = "📍 CHECK IF I REACHED MY GOAL";
        btn.disabled    = false;
      }
    },
    (err) => {
      toast(`Location error: ${err.message}`, "danger");
      btn.textContent = "📍 CHECK IF I REACHED MY GOAL";
      btn.disabled    = false;
    },
    { enableHighAccuracy: true, timeout: 10000 }
  );
}

async function tagRunner() {
  const confirmed = window.confirm(
    `Confirm: you physically tagged ${state.players[state.runnerIndex].name}?`
  );
  if (!confirmed) return;

  try {
    const { finished, newRunner } = await api("POST", "/api/tag");
    if (finished) {
      toast("Game over! Final scores incoming.", "success");
    } else {
      toast(`Runner tagged! ${newRunner.name} is next.`, "success");
      // Host sees goal-setup for the next runner
      showGoalSetup();
    }
  } catch (err) {
    toast(err.message, "danger");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — CHALLENGES
// ═══════════════════════════════════════════════════════════════════════════

async function loadChallenges() {
  try {
    challenges = await api("GET", "/api/challenges");
    renderChallengeList();
  } catch (err) {
    console.warn("Could not load challenges:", err);
  }
}

function renderChallengeList() {
  const me   = myPlayer();
  const list = document.getElementById("challenge-list");
  if (!list || !challenges.length) return;

  const done    = me ? (state?.completedChallenges?.[me.id] || []) : [];
  list.innerHTML = "";

  for (const c of challenges) {
    const isDone = done.includes(c.id);
    const li     = document.createElement("li");
    li.className = `challenge-item${isDone ? " done" : ""}`;
    li.innerHTML = `
      <span class="challenge-text">${c.text}</span>
      <span class="challenge-reward">+${c.reward} 🪙</span>
      <button class="btn-complete" data-id="${c.id}" ${isDone ? "disabled" : ""}>
        ${isDone ? "DONE" : "DONE?"}
      </button>
    `;
    list.appendChild(li);
  }
}

async function completeChallenge(challengeId) {
  const me = myPlayer();
  if (!me) return;

  try {
    await api("POST", "/api/challenges/complete", { playerId: me.id, challengeId });
    toast("Challenge complete! Coins awarded. 🎉", "success");
    // state:update from server will re-render
  } catch (err) {
    toast(err.message, "danger");
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — SCOREBOARD
// ═══════════════════════════════════════════════════════════════════════════

function renderScoreboard() {
  const list = document.getElementById("scoreboard-list");
  if (!list || !state) return;

  const sorted = [...state.players].sort((a, b) => b.currency - a.currency);
  list.innerHTML = "";

  sorted.forEach((p, i) => {
    const li     = document.createElement("li");
    li.className = "score-item";
    li.innerHTML = `
      <span class="score-rank${i === 0 ? " top" : ""}">${i + 1}</span>
      <span class="score-name">${p.name}</span>
      <span class="score-role ${p.role}">${p.role.toUpperCase()}</span>
      <span class="score-coins">🪙 ${p.currency}</span>
    `;
    list.appendChild(li);
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME OVER SCREEN
// ═══════════════════════════════════════════════════════════════════════════

function renderFinalScores() {
  const list = document.getElementById("final-scores-list");
  if (!list || !state) return;

  const sorted = [...state.players].sort((a, b) => b.currency - a.currency);
  list.innerHTML = "";

  sorted.forEach((p, i) => {
    const li     = document.createElement("li");
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

// ═══════════════════════════════════════════════════════════════════════════
// EVENT WIRING
// ═══════════════════════════════════════════════════════════════════════════

function wireEvents() {
  // Goal setup
  document.getElementById("btn-set-goal").addEventListener("click", submitGoal);

  // Transport mode buttons + immediate start on click
  document.getElementById("transport-modes").addEventListener("click", (e) => {
    const btn = e.target.closest(".mode-btn");
    if (!btn) return;
    const mode = btn.dataset.mode;
    selectMode(mode);
    const me = myPlayer();
    if (me && !state?.transportTimers?.[me.id]) {
      selectedMode = mode;
      startTransport();
    }
  });

  document.getElementById("btn-transport-stop").addEventListener("click", stopTransport);

  // Runner
  document.getElementById("btn-check-goal").addEventListener("click", checkGoal);

  // Chaser
  document.getElementById("btn-tag-runner").addEventListener("click", tagRunner);

  // Challenge list (event delegation)
  document.getElementById("challenge-list").addEventListener("click", (e) => {
    const btn = e.target.closest(".btn-complete");
    if (!btn || btn.disabled) return;
    completeChallenge(btn.dataset.id);
  });

  // Player selector
  document.getElementById("select-player").addEventListener("change", (e) => {
    myPlayerId = e.target.value;
    socket.emit("identify", { playerId: myPlayerId });
    renderTopBar();
    renderGoalBanner();
    renderTransportCard();
    renderRoleCards();
    renderChallengeList();
  });

  // New game / play again
  document.getElementById("btn-new-game").addEventListener("click", async () => {
    try { await api("DELETE", "/api/game"); } catch (_) {}
    location.reload();
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// BOOT
// ═══════════════════════════════════════════════════════════════════════════

async function init() {
  buildLobby();
  buildTransportModes();
  wireEvents();

  // Try to resume an in-progress game (handles page reload mid-game)
  try {
    const existing = await api("GET", "/api/game/state");
    if (existing && existing.phase !== null) {
      state = existing;
      await loadChallenges();
      renderAll();
    } else {
      showScreen("screen-lobby");
    }
  } catch (_) {
    showScreen("screen-lobby");
  }
}

init();

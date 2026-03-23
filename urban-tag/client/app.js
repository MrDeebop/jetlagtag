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

const VETO_DURATION_MS = 5 * 60 * 1000;
const JAIL_DURATION_MS = 5 * 60 * 1000;
const JAIL_PING_INTERVAL_MS = 15 * 1000;  // ping GPS every 15 s during jail

// ═══════════════════════════════════════════════════════════════════════════
// STATE
// ═══════════════════════════════════════════════════════════════════════════

let state        = null;
let myPlayerId   = null;
let selectedMode = "walk";

// Transport timer (client-side for responsiveness)
let transportTimerInterval = null;
let transportTimerStart    = null;
let transportTimerRate     = 0;

// Veto countdown (client-side)
let vetoCountdownInterval  = null;
let vetoEndsAt             = null;

// Jail countdown (client-side)
let jailCountdownInterval  = null;
let jailEndsAt             = null;
let jailPingInterval       = null;

// ═══════════════════════════════════════════════════════════════════════════
// SOCKET.IO
// ═══════════════════════════════════════════════════════════════════════════

const socket = io();

socket.on("connect", () => {
  if (myPlayerId) socket.emit("identify", { playerId: myPlayerId });
});

socket.on("state:update", (newState) => {
  state = newState;
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
    renderGoalBanner();
    renderJailBanner();
    renderTransportCard();
    renderRoleCards();
    renderChallengeCard();
    renderScoreboard();
    renderGamemasterCard();
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

  const btn = document.getElementById("btn-create-game");
  btn.textContent = "CREATING…"; btn.disabled = true;

  try {
    const data = await api("POST", "/api/game/create", { players: names });
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
    // Set all goals
    for (const g of goals) {
      await api("POST", "/api/goal/set", g);
    }
    // Start the game
    await api("POST", "/api/game/start");
    // state:update from socket will trigger renderAll()
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
    // Start GPS ping if not already running
    if (!jailPingInterval) {
      jailPingInterval = setInterval(pingJailLocation, JAIL_PING_INTERVAL_MS);
      pingJailLocation(); // immediate first ping
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
  const active = document.getElementById("transport-active");
  const timer  = me ? state.transportTimers?.[me.id] : null;
  const inVeto = !!state.vetoTimer;
  const inJail = me?.role === "chaser" && !!state.jailTimer;

  // Disable transport buttons during veto or jail
  const blocked = inVeto || inJail;
  document.querySelectorAll(".mode-btn").forEach((b) => { b.disabled = blocked; });

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
    // Disable tag button during jail
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

  // Try to get location for jail anchor
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

  // Only runners see the challenge card
  if (!me || me.role !== "runner") { card.classList.add("hidden"); return; }
  card.classList.remove("hidden");

  const vetoEl    = document.getElementById("veto-active");
  const activeEl  = document.getElementById("challenge-active");
  const emptyEl   = document.getElementById("challenge-empty");

  if (state.vetoTimer) {
    // Veto cooldown running
    vetoEl.classList.remove("hidden");
    activeEl.classList.add("hidden");
    emptyEl.classList.add("hidden");

    const remainingMs = state.vetoTimer.remainingMs;
    vetoEndsAt = Date.now() + remainingMs;
    if (!vetoCountdownInterval) {
      vetoCountdownInterval = setInterval(tickVetoCountdown, 1000);
      tickVetoCountdown();
    }
    // Block transport during veto
    document.querySelectorAll(".mode-btn").forEach((b) => { b.disabled = true; });

  } else if (state.activeChallenge) {
    clearVetoCountdown();
    vetoEl.classList.add("hidden");
    activeEl.classList.remove("hidden");
    emptyEl.classList.add("hidden");

    document.getElementById("active-challenge-text").textContent   = state.activeChallenge.text;
    document.getElementById("active-challenge-reward").textContent = `+${state.activeChallenge.reward} 🪙`;

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
  const confirmed = window.confirm(
    `Veto this challenge? You'll have a ${VETO_DURATION_MS / 60000}-minute cooldown with no transport or challenges.`
  );
  if (!confirmed) return;
  try {
    await api("POST", "/api/challenges/veto", { playerId: me.id });
    toast("Challenge vetoed. Cooldown started.", "danger");
  } catch (err) { toast(err.message, "danger"); }
}

// ═══════════════════════════════════════════════════════════════════════════
// GAME SCREEN — SCOREBOARD
// ═══════════════════════════════════════════════════════════════════════════

function renderScoreboard() {
  const list = document.getElementById("scoreboard-list");
  if (!list || !state) return;

  // Sort: revealed scores descending, hidden scores at bottom
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

    // Hide runner's score from chasers; the runner themselves can see it
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
  if (me?.isGamemaster) {
    card.classList.remove("hidden");
  } else {
    card.classList.add("hidden");
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
}

// ═══════════════════════════════════════════════════════════════════════════
// EVENT WIRING
// ═══════════════════════════════════════════════════════════════════════════

function wireEvents() {
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
    renderGoalBanner();
    renderJailBanner();
    renderTransportCard();
    renderRoleCards();
    renderChallengeCard();
    renderScoreboard();
    renderGamemasterCard();
  });

  // Gamemaster reset
  document.getElementById("btn-reset-game").addEventListener("click", async () => {
    if (!window.confirm("Reset the entire game? This cannot be undone.")) return;
    try { await api("DELETE", "/api/game"); } catch (_) {}
    clearAll();
    location.reload();
  });

  // New game
  document.getElementById("btn-new-game").addEventListener("click", async () => {
    try { await api("DELETE", "/api/game"); } catch (_) {}
    clearAll();
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

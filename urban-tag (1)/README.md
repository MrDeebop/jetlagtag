# Urban Tag

City-scale tag game — all players connect via their phones to one shared server.

## Project Structure

```
urban-tag/
├── package.json          ← dependencies + start script
├── server/
│   ├── server.js         ← Express + Socket.IO server
│   └── game.js           ← pure game logic (no I/O)
└── client/
    ├── index.html
    ├── app.js
    └── style.css
```

---

## Running Locally

```bash
npm install
npm start
# → http://localhost:3000
```

All players on the same Wi-Fi network can open `http://<your-local-IP>:3000` on their phones.
Find your local IP with `ipconfig` (Windows) or `ifconfig` / `ip addr` (Mac/Linux).

For dev with auto-reload:
```bash
npm run dev
```

---

## Deploying to Render (free tier)

1. Push this repo to GitHub.
2. Go to [render.com](https://render.com) → **New → Web Service**.
3. Connect your GitHub repo.
4. Set these fields:
   - **Environment:** `Node`
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Root Directory:** *(leave blank — package.json is at repo root)*
5. Click **Deploy**.
6. Render gives you a public URL like `https://urban-tag-xxxx.onrender.com`.
   Share that URL with all players.

> **Note:** Render's free tier spins down after 15 min of inactivity.
> The first request after sleep takes ~30 s. Upgrade to a paid plan for always-on.

---

## Deploying to Railway

1. Push to GitHub.
2. New project → **Deploy from GitHub repo**.
3. Railway auto-detects Node and runs `npm start`. Done.

---

## Deploying to Fly.io

```bash
npm install -g flyctl
fly launch          # follow prompts, select region
fly deploy
```

---

## How to Play

1. **One person (host)** opens the URL and enters all player names. Player order = runner order.
2. Host secretly sets a **goal location** for the first runner (lat/lng from Google Maps + a hint).
3. Everyone opens the URL on their phone and picks their name from the **I AM** selector at the bottom.
4. **Runner** tries to reach their goal. **Chasers** try to physically tag them.
5. Using transport costs coins per minute — tap a mode to start the timer, tap STOP & PAY when done.
6. Complete **challenges** from the list to earn bonus coins.
7. When tagged, the runner rotates to the next player. Host sets a new goal. Repeat.
8. After all players have been runner once, the game ends. Highest coin balance wins.

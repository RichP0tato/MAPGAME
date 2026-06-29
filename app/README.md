# WAYPOINT — Halo Campaign Map Game

A grid-accurate Halo star map (modeled on your reference chart) with a real backend:
account login, **server-enforced fog of war** (Covenant players only see what they've
discovered), an admin console, and per-system game state you can edit live.

There are two things in this package:

1. **`preview.html`** — open it in a browser right now. No setup. Shows the full map
   with every system visible (spectator/admin view). Use it to check the layout.
2. **`app/`** — the real multiplayer server. This is what enforces fog of war and
   logins. You run it locally, then deploy to Railway for a shareable URL.

---

## Why fog of war needs a server (the important part)

A single HTML file **cannot** hide systems from a player — anything the browser
downloads can be read in dev tools. So the master map lives on the server. When a
player loads the map, the server sends back **only the systems their faction has
discovered**. Undiscovered systems never reach that player's browser at all.

- **UNSC** players start seeing all UNSC + neutral space.
- **Covenant** players start almost blind — only their own worlds and the UNSC
  frontier near Enemy Space. They reveal more as the game's discovery events fire.
- **Admins** and **Spectators** see everything.

Verified: a fresh Covenant account cannot see SOL or the UNSC core.

---

## Run it locally

Requires **Node.js 18+** (https://nodejs.org).

```bash
cd app
npm install
npm start
```

Open **http://localhost:3000**.

On first run the server creates a database and an **admin account**:

```
username: admin
password: admin     ← change this immediately (see below)
```

Set a real admin password before first run:

```bash
ADMIN_PASSWORD="your-strong-password" SESSION_SECRET="some-long-random-string" npm start
```

(The admin password only applies when the database is first created. To reset later,
delete `app/data/game.db*` and restart — this wipes accounts and discoveries but not
the map.)

---

## Using it

**As a player:** click *Enlist*, pick a faction, and you're in. You only see your
faction's known space. The left panel lists known systems; click a marker for its
detail panel (population, region, glassing, sector resources, slipspace corridors).

**As admin:** sign in as `admin`. You get an **ADMIN** button (top right) and an
edit form at the bottom of every system's detail panel. You can:

- Change a system's controlling faction, glassing %, population, notes (live).
- Reveal / hide a single system to a faction (the discovery mechanic).
- Bulk reveal or hide an entire faction's map.
- Change any player's faction or promote them to admin.

All edits write to the server and every player's next map load reflects them.

---

## Deploy to Railway (public URL)

1. Push the `app/` folder to a GitHub repo.
2. On https://railway.app → **New Project → Deploy from GitHub repo**.
3. Railway auto-detects Node and runs `npm start`.
4. In the service **Variables**, set:
   - `SESSION_SECRET` — a long random string
   - `ADMIN_PASSWORD` — your admin password
5. Railway gives you a public URL. Share it with your players.

Note: the SQLite database is a file on disk. On Railway, add a **Volume** mounted at
`/app/data` so accounts and discoveries persist across redeploys. Without a volume,
a redeploy resets the game state.

---

## The data

- **133 systems**: 115 from your spreadsheet (all population + glassed worlds) placed
  on the 20×20 lettered grid (A–T, 1–20), plus Covenant Enemy Space and Forerunner sites.
- Systems with a label readable on your reference map are placed at that spot; the rest
  are distributed within their sector's region band.
- **Sectors** (Outremer, Laconia, Aquarius, Cygnidia, Coral Edge, Hades, Pacific Rim,
  Bolivar, Vishnu, Andalus, Corvus Cluster, Solar Core, Solar Reach) are labeled on the
  map and carry the spreadsheet's metal / mineral / uranium totals.
- `app/data/master.json` is the source of truth. Edit it to add/move systems, then
  restart the server.

### Adjusting positions

Each system has `"grid": "H18"` and pixel `"coords": [x, y]` (cell = 100px,
`x = (col)·100 + 50`, `y = (row−1)·100 + 50`, col A=0). To move a system, edit its
`coords` (or `grid` and recompute coords) in `master.json`.

---

---

## Fleets

Fleets are mobile faction assets placed at systems, shown as faction-colored
chevron markers offset from their system (with the fleet's combat strength on the
badge). Click one for its panel: faction, commander, total strength, total ships,
full ship composition, and orders.

**Fleet fog of war (sensor range).** Like systems, fleets are filtered server-side:
- You always see **your own** fleets.
- You see an **enemy** fleet only if you control a system, or have a fleet, in the
  **same or an adjacent grid cell** (a 3×3 sensor window). Otherwise that fleet's
  data never reaches your browser.

This means an enemy fleet can move through deep space unseen and only appears on
your map once it enters sensor range of your territory — exactly the hidden-movement
tension you want. (Verified: a Covenant player cannot see UNSC fleets at Sol/Reach;
move a fleet adjacent to enemy space and it becomes visible to them.)

**Moving fleets (admin).** Open any fleet's panel as admin → *Relocate to system* →
pick any system → **Move Fleet**. Free placement, no corridor or turn restriction.
The **Fleet Manager** (admin console → ⚓ Fleet Manager) lists all fleets, lets you
create new ones, and jump to each to move/edit/delete.

### Ship roster — drop in your real data

Fleet composition references a **ship catalog** in `app/data/ships.json`. It ships
with a **placeholder catalog** (generic UNSC/Covenant classes). To use your
spreadsheet's real ships:

1. Open `app/data/ships.json`.
2. Replace the `ships` array. Each entry needs: `id` (unique slug), `name`,
   `class`, `faction`, `strength` (combat value — fleet totals sum these), `crew`.
3. Optionally edit the seed `fleets` array (each fleet's `composition` is
   `{ shipId: count }` using ids from your catalog).
4. Delete `app/data/game.db*` and restart so the seed fleets reload (or just edit
   fleets live in the Fleet Manager).

Nothing else changes — the server, fog of war, and map rendering all read from
this one file.

---

## What's next (easy additions)

- **Turn tracker** with a global turn counter and per-faction action log.
- **Scouting / adjacency reveal** — auto-discover neighbors of a controlled system.
- **Resource economy** — tally each faction's metal/mineral/uranium from held sectors.
- **Combat resolver** — flag contested systems and log outcomes.

Ask and these can be layered onto the existing server.

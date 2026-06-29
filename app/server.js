// WAYPOINT — Halo campaign map game server
// Server-enforced fog of war: the master map lives here. Each player only ever
// receives the systems their faction has discovered. The browser never sees
// undiscovered data, so it cannot be revealed with dev tools.

import express from 'express';
import session from 'express-session';
import bcrypt from 'bcryptjs';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;
const SESSION_SECRET = process.env.SESSION_SECRET || 'change-me-in-production';

// ---------- load master map ----------
const MASTER = JSON.parse(readFileSync(join(__dirname, 'data', 'master.json'), 'utf8'));
const SYS_BY_ID = Object.fromEntries(MASTER.systems.map(s => [s.id, s]));

// ---------- load ship catalog + seed fleets ----------
const SHIPDATA = JSON.parse(readFileSync(join(__dirname, 'data', 'ships.json'), 'utf8'));
const SHIP_BY_ID = Object.fromEntries((SHIPDATA.ships||[]).map(s => [s.id, s]));
function fleetStrength(comp){
  let total = 0;
  for (const [id,n] of Object.entries(comp||{})) total += (SHIP_BY_ID[id]?.strength||0) * n;
  return total;
}
function fleetShipCount(comp){
  let total = 0; for (const n of Object.values(comp||{})) total += n; return total;
}

// ---------- database ----------
const db = new Database(join(__dirname, 'data', 'game.db'));
db.pragma('journal_mode = WAL');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT UNIQUE NOT NULL,
  pass_hash TEXT NOT NULL,
  faction TEXT NOT NULL DEFAULT 'UNSC',   -- UNSC | Covenant | Spectator
  role TEXT NOT NULL DEFAULT 'player',     -- player | admin
  created_at INTEGER
);
CREATE TABLE IF NOT EXISTS discoveries (
  faction TEXT NOT NULL,
  system_id TEXT NOT NULL,
  discovered_at INTEGER,
  PRIMARY KEY (faction, system_id)
);
-- per-system live game state overlay (control, glassing, notes) editable by admins
CREATE TABLE IF NOT EXISTS system_state (
  system_id TEXT PRIMARY KEY,
  faction TEXT,
  glassed INTEGER,
  glassing INTEGER,
  population INTEGER,
  notes TEXT,
  updated_at INTEGER
);
-- fleets: mobile faction assets placed at systems (admin-moved free placement)
CREATE TABLE IF NOT EXISTS fleets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  faction TEXT NOT NULL,
  owner TEXT,
  system_id TEXT,        -- the system the fleet currently occupies
  composition TEXT,      -- JSON: { shipId: count }
  notes TEXT,
  updated_at INTEGER
);
`);

// seed an admin on first run
const userCount = db.prepare('SELECT COUNT(*) c FROM users').get().c;
if (userCount === 0) {
  const adminPass = process.env.ADMIN_PASSWORD || 'admin';
  db.prepare('INSERT INTO users (username,pass_hash,faction,role,created_at) VALUES (?,?,?,?,?)')
    .run('admin', bcrypt.hashSync(adminPass, 10), 'UNSC', 'admin', Date.now());
  console.log(`[seed] created admin account  user: admin  pass: ${adminPass}  (change this!)`);
  // By default, UNSC discovers all its own + neutral systems; Covenant starts blind except its homeworlds.
  const ins = db.prepare('INSERT OR IGNORE INTO discoveries (faction,system_id,discovered_at) VALUES (?,?,?)');
  const now = Date.now();
  for (const s of MASTER.systems) {
    if (s.faction === 'UNSC' || s.faction === 'Forerunner') ins.run('UNSC', s.id, now);
    if (s.faction === 'Covenant') { ins.run('Covenant', s.id, now); ins.run('UNSC', s.id, now); }
  }
  // Covenant also starts knowing the very edge of UNSC space near Enemy Space (rows 3-4)
  for (const s of MASTER.systems) {
    if (s.faction === 'UNSC') {
      const row = parseInt((s.grid||'').replace(/[A-Z]/gi,''),10);
      if (row && row <= 4) ins.run('Covenant', s.id, now);
    }
  }
}

// seed fleets on first run
const fleetCount = db.prepare('SELECT COUNT(*) c FROM fleets').get().c;
if (fleetCount === 0) {
  const fins = db.prepare('INSERT INTO fleets (id,name,faction,owner,system_id,composition,notes,updated_at) VALUES (@id,@name,@faction,@owner,@system,@comp,@notes,@t)');
  for (const f of (SHIPDATA.fleets||[])) {
    fins.run({ id:f.id, name:f.name, faction:f.faction, owner:f.owner||null,
      system:f.system||null, comp:JSON.stringify(f.composition||{}), notes:f.notes||'', t:Date.now() });
  }
  console.log(`[seed] created ${(SHIPDATA.fleets||[]).length} fleets`);
}

// ---------- helpers ----------
function currentState(s) {
  const st = db.prepare('SELECT * FROM system_state WHERE system_id=?').get(s.id);
  if (!st) return s;
  return {
    ...s,
    faction: st.faction ?? s.faction,
    glassed: st.glassed != null ? !!st.glassed : s.glassed,
    glassing: st.glassing != null ? st.glassing : s.glassing,
    population: st.population != null ? st.population : s.population,
    notes: st.notes != null ? st.notes : s.notes,
  };
}
function discoveredIds(faction) {
  const rows = db.prepare('SELECT system_id FROM discoveries WHERE faction=?').all(faction);
  return new Set(rows.map(r => r.system_id));
}
function visibleSystems(user) {
  // admins and spectators see everything; players see only their faction's discoveries
  const all = MASTER.systems.map(currentState);
  if (user && (user.role === 'admin' || user.faction === 'Spectator')) return { systems: all, fog:false };
  const faction = user ? user.faction : 'UNSC';
  const disc = discoveredIds(faction);
  return { systems: all.filter(s => disc.has(s.id)), fog:true };
}

// ---- fleet helpers ----
function gridOf(systemId){
  const s = SYS_BY_ID[systemId]; if(!s||!s.grid) return null;
  const m = s.grid.match(/^([A-Z]+)(\d+)$/i); if(!m) return null;
  return { col: m[1].toUpperCase().charCodeAt(0)-65, row: parseInt(m[2],10) };
}
function gridAdjacent(aId,bId){
  const a=gridOf(aId), b=gridOf(bId);
  if(!a||!b) return false;
  return Math.abs(a.col-b.col)<=1 && Math.abs(a.row-b.row)<=1; // same or adjacent cell
}
function allFleets(){
  return db.prepare('SELECT * FROM fleets').all().map(f=>{
    const comp = JSON.parse(f.composition||'{}');
    return { id:f.id, name:f.name, faction:f.faction, owner:f.owner,
      system:f.system_id, composition:comp, notes:f.notes,
      strength:fleetStrength(comp), ships:fleetShipCount(comp),
      coords: SYS_BY_ID[f.system_id]?.coords || null,
      grid: SYS_BY_ID[f.system_id]?.grid || null };
  });
}
function visibleFleets(user){
  const fleets = allFleets();
  if (user && (user.role==='admin' || user.faction==='Spectator')) return fleets;
  const faction = user ? user.faction : 'UNSC';
  // systems where this faction has presence: controlled systems + own fleet locations
  const ownFleetSystems = fleets.filter(f=>f.faction===faction).map(f=>f.system).filter(Boolean);
  const controlled = MASTER.systems.map(currentState)
    .filter(s=>s.faction===faction).map(s=>s.id);
  const sensorSystems = new Set([...ownFleetSystems, ...controlled]);
  return fleets.filter(f=>{
    if (f.faction===faction) return true;              // always see own
    if (!f.system) return false;
    // visible if any sensor system is the same or adjacent grid cell to the enemy fleet
    for (const ss of sensorSystems){ if (ss===f.system || gridAdjacent(ss,f.system)) return true; }
    return false;
  });
}

// ---------- app ----------
const app = express();
app.use(express.json());
app.use(session({
  secret: SESSION_SECRET, resave:false, saveUninitialized:false,
  cookie:{ httpOnly:true, sameSite:'lax', maxAge: 1000*60*60*24*7 }
}));
app.use(express.static(join(__dirname, 'public')));

function getUser(req){ return req.session.userId ? db.prepare('SELECT * FROM users WHERE id=?').get(req.session.userId) : null; }
function requireAuth(req,res,next){ const u=getUser(req); if(!u) return res.status(401).json({error:'auth required'}); req.user=u; next(); }
function requireAdmin(req,res,next){ const u=getUser(req); if(!u||u.role!=='admin') return res.status(403).json({error:'admin only'}); req.user=u; next(); }

// ---- auth ----
app.post('/api/register', (req,res)=>{
  const { username, password, faction } = req.body||{};
  if(!username||!password) return res.status(400).json({error:'username and password required'});
  const f = ['UNSC','Covenant','Spectator'].includes(faction) ? faction : 'UNSC';
  try {
    const info = db.prepare('INSERT INTO users (username,pass_hash,faction,role,created_at) VALUES (?,?,?,?,?)')
      .run(username, bcrypt.hashSync(password,10), f, 'player', Date.now());
    req.session.userId = info.lastInsertRowid;
    res.json({ ok:true });
  } catch(e){ res.status(409).json({error:'username taken'}); }
});
app.post('/api/login', (req,res)=>{
  const { username, password } = req.body||{};
  const u = db.prepare('SELECT * FROM users WHERE username=?').get(username||'');
  if(!u || !bcrypt.compareSync(password||'', u.pass_hash)) return res.status(401).json({error:'invalid credentials'});
  req.session.userId = u.id;
  res.json({ ok:true });
});
app.post('/api/logout', (req,res)=>{ req.session.destroy(()=>res.json({ok:true})); });
app.get('/api/me', (req,res)=>{
  const u=getUser(req);
  if(!u) return res.json({ user:null });
  res.json({ user:{ username:u.username, faction:u.faction, role:u.role }});
});

// ---- map data (fog-of-war enforced) ----
app.get('/api/map', (req,res)=>{
  const u=getUser(req);
  const { systems, fog } = visibleSystems(u);
  // routes: only include a route if at least 2 endpoints are visible
  const visIds=new Set(systems.map(s=>s.id));
  const routes = MASTER.routes
    .map(r=>({ ...r, systems:r.systems.filter(id=>visIds.has(id)) }))
    .filter(r=>r.systems.length>=2);
  res.json({
    grid: MASTER.grid,
    systems, routes,
    sectors: MASTER.sectors, grand: MASTER.grand, sectorRegions: MASTER.sectorRegions,
    fleets: visibleFleets(u),
    ships: SHIPDATA.ships,
    fog, total: MASTER.systems.length,
    me: u ? { username:u.username, faction:u.faction, role:u.role } : null
  });
});

// ---- discovery: a player reveals a system (e.g., scouting). Adjacent reveal model. ----
app.post('/api/discover', requireAuth, (req,res)=>{
  const { systemId } = req.body||{};
  const s = SYS_BY_ID[systemId];
  if(!s) return res.status(404).json({error:'no such system'});
  db.prepare('INSERT OR IGNORE INTO discoveries (faction,system_id,discovered_at) VALUES (?,?,?)')
    .run(req.user.faction, systemId, Date.now());
  res.json({ ok:true });
});

// ---- admin: full roster, edit state, grant/revoke discovery, manage users ----
app.get('/api/admin/all', requireAdmin, (req,res)=>{
  res.json({ systems: MASTER.systems.map(currentState),
             users: db.prepare('SELECT id,username,faction,role FROM users').all() });
});
app.post('/api/admin/system', requireAdmin, (req,res)=>{
  const { systemId, faction, glassed, glassing, population, notes } = req.body||{};
  if(!SYS_BY_ID[systemId]) return res.status(404).json({error:'no such system'});
  db.prepare(`INSERT INTO system_state (system_id,faction,glassed,glassing,population,notes,updated_at)
    VALUES (@id,@faction,@glassed,@glassing,@population,@notes,@t)
    ON CONFLICT(system_id) DO UPDATE SET
      faction=COALESCE(@faction,faction), glassed=COALESCE(@glassed,glassed),
      glassing=COALESCE(@glassing,glassing), population=COALESCE(@population,population),
      notes=COALESCE(@notes,notes), updated_at=@t`)
    .run({ id:systemId, faction:faction??null,
           glassed:glassed==null?null:(glassed?1:0), glassing:glassing??null,
           population:population??null, notes:notes??null, t:Date.now() });
  res.json({ ok:true });
});
app.post('/api/admin/reveal', requireAdmin, (req,res)=>{
  const { faction, systemId, all } = req.body||{};
  const ins=db.prepare('INSERT OR IGNORE INTO discoveries (faction,system_id,discovered_at) VALUES (?,?,?)');
  if(all){ for(const s of MASTER.systems) ins.run(faction,s.id,Date.now()); }
  else if(SYS_BY_ID[systemId]) ins.run(faction,systemId,Date.now());
  res.json({ ok:true });
});
app.post('/api/admin/hide', requireAdmin, (req,res)=>{
  const { faction, systemId, all } = req.body||{};
  if(all) db.prepare('DELETE FROM discoveries WHERE faction=?').run(faction);
  else db.prepare('DELETE FROM discoveries WHERE faction=? AND system_id=?').run(faction,systemId);
  res.json({ ok:true });
});
app.post('/api/admin/user', requireAdmin, (req,res)=>{
  const { userId, faction, role } = req.body||{};
  db.prepare('UPDATE users SET faction=COALESCE(?,faction), role=COALESCE(?,role) WHERE id=?')
    .run(faction??null, role??null, userId);
  res.json({ ok:true });
});

// ---- fleets (admin manages: create / move / edit composition / delete) ----
app.get('/api/admin/fleets', requireAdmin, (req,res)=>{
  res.json({ fleets: allFleets(), ships: SHIPDATA.ships });
});
app.post('/api/admin/fleet', requireAdmin, (req,res)=>{
  const { id, name, faction, owner, system, composition, notes } = req.body||{};
  const fid = id || ('fleet_'+Math.random().toString(36).slice(2,9));
  const exists = db.prepare('SELECT id FROM fleets WHERE id=?').get(fid);
  if (exists){
    db.prepare(`UPDATE fleets SET name=COALESCE(@name,name), faction=COALESCE(@faction,faction),
      owner=COALESCE(@owner,owner), system_id=COALESCE(@system,system_id),
      composition=COALESCE(@comp,composition), notes=COALESCE(@notes,notes), updated_at=@t WHERE id=@id`)
      .run({ id:fid, name:name??null, faction:faction??null, owner:owner??null,
        system:system??null, comp:composition?JSON.stringify(composition):null, notes:notes??null, t:Date.now() });
  } else {
    db.prepare(`INSERT INTO fleets (id,name,faction,owner,system_id,composition,notes,updated_at)
      VALUES (@id,@name,@faction,@owner,@system,@comp,@notes,@t)`)
      .run({ id:fid, name:name||'New Fleet', faction:faction||'UNSC', owner:owner||null,
        system:system||null, comp:JSON.stringify(composition||{}), notes:notes||'', t:Date.now() });
  }
  res.json({ ok:true, id:fid });
});
app.post('/api/admin/fleet/move', requireAdmin, (req,res)=>{
  const { id, system } = req.body||{};
  db.prepare('UPDATE fleets SET system_id=?, updated_at=? WHERE id=?').run(system||null, Date.now(), id);
  res.json({ ok:true });
});
app.post('/api/admin/fleet/delete', requireAdmin, (req,res)=>{
  db.prepare('DELETE FROM fleets WHERE id=?').run(req.body?.id);
  res.json({ ok:true });
});

app.listen(PORT, ()=>console.log(`WAYPOINT server running on http://localhost:${PORT}`));

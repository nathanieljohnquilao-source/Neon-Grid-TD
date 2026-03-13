'use strict';
// ═══════════════════════════════════════════════════════════════════════════════
// NEON GRID  ·  Tower Defense  ·  game.js  v4
// Performance: offscreen layers, sprite cache, Set-based lookups, no per-frame
//              shadowBlur, object-pool particles capped at 240.
// New features: animated title canvas, boss bar, wave-progress bar, kill streak
//               toasts, shockwave rings, muzzle flash, placement range preview.
// ═══════════════════════════════════════════════════════════════════════════════

/* ── Grid ───────────────────────────────────────────────────────────────────── */
const COLS = 18, ROWS = 22;
let CELL = 32;

/* ── Tower catalogue ────────────────────────────────────────────────────────── */
const TDEFS = {
  gun:    {name:'GUN',    cost:50,  color:'#00dcff',range:3.5,dmg:18, rate:1.1, proj:'bullet',splash:0,  slow:0,   chain:0, desc:'Fast single shots. Great all-rounder.'},
  laser:  {name:'LASER',  cost:80,  color:'#ff2d78',range:4.5,dmg:9,  rate:4.0, proj:'beam',  splash:0,  slow:0,   chain:0, desc:'Continuous beam, very high DPS.'},
  slow:   {name:'SLOW',   cost:60,  color:'#c060ff',range:3.0,dmg:6,  rate:0.9, proj:'orb',   splash:0,  slow:0.5, chain:0, desc:'Slows enemies hit by 50%.'},
  missile:{name:'MISSILE',cost:120, color:'#ff8c2d',range:5.0,dmg:90, rate:0.4, proj:'rocket',splash:1.6,slow:0,   chain:0, desc:'Slow rocket with large splash.'},
  tesla:  {name:'TESLA',  cost:150, color:'#ffed47',range:2.8,dmg:45, rate:0.7, proj:'arc',   splash:0,  slow:0.3, chain:3, desc:'Chains lightning to 3 enemies.'},
};
const UPG_DMG  = [1, 1.6, 2.5];
const UPG_RNG  = [1, 1.2, 1.45];
const UPG_RATE = [1, 1.35, 1.8];
const UPG_COST = [0, 65, 110];

/* ── Enemy catalogue ────────────────────────────────────────────────────────── */
const EDEFS = [
  {name:'DRONE',  hp:60,   spd:1.2, reward:8,  color:'#00dcff',r:.34,armor:0,  shape:'circle'},
  {name:'RUNNER', hp:40,   spd:2.3, reward:10, color:'#39ff6e',r:.29,armor:0,  shape:'tri'},
  {name:'TANK',   hp:300,  spd:0.7, reward:22, color:'#ff8c2d',r:.47,armor:.22,shape:'square'},
  {name:'GHOST',  hp:130,  spd:1.6, reward:18, color:'#c060ff',r:.36,armor:0,  shape:'diamond'},
  {name:'BOSS',   hp:1400, spd:0.6, reward:80, color:'#ff2d78',r:.60,armor:.3, shape:'hex'},
];

/* ── Canvas ─────────────────────────────────────────────────────────────────── */
const canvas = document.getElementById('gameCanvas');
const ctx    = canvas.getContext('2d');

// Offscreen layers — rebuilt once on start/resize
let bgLayer = null, pathLayer = null;

// Sprite cache — keyed "type_level", rebuilt on start/resize
let spriteCache = {};

const HH = () => 52;   // HUD height px (matches CSS --hh)
const BH = () => document.getElementById('boss-bar').classList.contains('hidden') ? 0 : 24;
const SH = () => 88;   // shop height px

function resize() {
  const avW = window.innerWidth;
  const avH = window.innerHeight - HH() - BH() - SH();
  CELL = Math.max(20, Math.floor(Math.min(avW / COLS, avH / ROWS)));
  canvas.width  = COLS * CELL;
  canvas.height = ROWS * CELL;
  canvas.style.left = Math.floor((avW - canvas.width) / 2) + 'px';
  canvas.style.top  = (HH() + BH()) + 'px';
  if (G && G.path.length) { buildBgLayer(); buildPathLayer(); rebuildAllSprites(); }
}
window.addEventListener('resize', resize);

/* ── State ──────────────────────────────────────────────────────────────────── */
let G = null;
function freshState() {
  return {
    lives: 20, credits: 150, score: 0, wave: 0,
    speed: 1, phase: 'prep',
    towers: [], enemies: [], projs: [], particles: [], floats: [], shocks: [],
    grid: [], path: [], waypoints: [],
    enemySet: new Set(),   // O(1) enemy lookup for projectiles
    selectedType: 'gun', selectedTower: null,
    spawnQueue: [], spawnTimer: 0, waveActive: false,
    killStreak: 0, streakTimer: 0,
    totalWaveEnemies: 0,
    killedThisWave: 0,
  };
}
let animId = null, lastTs = 0, eid = 0;

/* ── DOM ────────────────────────────────────────────────────────────────────── */
const $ = id => document.getElementById(id);
const hudLives   = $('hud-lives');
const hudCredits = $('hud-credits');
const hudWave    = $('hud-wave');
const hudScore   = $('hud-score');
const waveProg   = $('wave-prog');
const bossBar    = $('boss-bar');
const bossBarFill= $('boss-bar-fill');
const bossHpText = $('boss-hp-text');
const btnWave    = $('btn-wave');
const btnSpeed   = $('btn-speed');
const wbMain     = $('wb-main');
const waveBanner = $('wave-banner');
const streakToast= $('streak-toast');
const towerPopup = $('tower-popup');

/* ── Screens ────────────────────────────────────────────────────────────────── */
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  $(id).classList.add('active');
}
$('btn-play').onclick    = startGame;
$('btn-restart').onclick = startGame;
$('btn-menu').onclick    = () => { stopLoop(); titleCanvas.start(); showScreen('screen-title'); };

/* ── High score ─────────────────────────────────────────────────────────────── */
const getBest  = () => parseInt(localStorage.getItem('ng_best') || '0');
const saveBest = s  => { if (s > getBest()) localStorage.setItem('ng_best', s); };
function updateTitleBest() {
  const b = getBest();
  $('title-best').textContent = b > 0 ? `BEST: ${b.toLocaleString()} PTS` : '';
}
updateTitleBest();

/* ── Speed ──────────────────────────────────────────────────────────────────── */
const SPEEDS = [1, 2, 3];
let speedIdx = 0;
btnSpeed.onclick = () => {
  speedIdx = (speedIdx + 1) % SPEEDS.length;
  G.speed = SPEEDS[speedIdx];
  btnSpeed.textContent = `${G.speed}×`;
  btnSpeed.classList.toggle('fast', G.speed > 1);
};

/* ── Wave button ────────────────────────────────────────────────────────────── */
btnWave.onclick = () => { if (G && !G.waveActive) sendWave(); };
function sendWave() {
  G.wave++;
  G.credits += 25;
  const q = buildWave(G.wave);
  G.spawnQueue = q;
  G.totalWaveEnemies = q.length;
  G.killedThisWave = 0;
  G.spawnTimer = 0;
  G.waveActive = true;
  G.phase = 'spawning';
  hudFlash('hud-credits', '#39ff6e');
  updateHUD();
  showBanner(`WAVE  ${G.wave}`);
  wbMain.textContent = 'INCOMING...';
  btnWave.disabled = true;
  waveProg.style.width = '0%';
}

/* ── Wave factory ───────────────────────────────────────────────────────────── */
function buildWave(n) {
  const q = [], count = 8 + n * 3, isBoss = n % 5 === 0;
  for (let i = 0; i < count; i++) {
    let def;
    if (isBoss && i === count - 1) { def = EDEFS[4]; }
    else {
      const pool = EDEFS.slice(0, Math.min(1 + Math.floor(n / 2), 4));
      def = pool[Math.floor(Math.random() * pool.length)];
    }
    const hpM = 1 + n * 0.2, sM = 1 + n * 0.035;
    q.push({
      ...def,
      hp: Math.round(def.hp * hpM), maxHp: Math.round(def.hp * hpM),
      spd: def.spd * sM,
      delay: i === 0 ? 0 : Math.max(0.3, 0.85 - n * 0.018),
    });
  }
  return q;
}

/* ── Shop ───────────────────────────────────────────────────────────────────── */
document.querySelectorAll('.shop-item').forEach(item => {
  item.addEventListener('click', () => {
    document.querySelectorAll('.shop-item').forEach(i => i.classList.remove('selected'));
    item.classList.add('selected');
    G.selectedType  = item.dataset.tower;
    G.selectedTower = null;
    closePopup();
  });
});

/* ── Input ──────────────────────────────────────────────────────────────────── */
function gridXY(cx, cy) {
  const r = canvas.getBoundingClientRect();
  return { col: Math.floor((cx - r.left) / CELL), row: Math.floor((cy - r.top) / CELL) };
}
function handleTap(cx, cy) {
  const { col, row } = gridXY(cx, cy);
  if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return;
  const hit = G.towers.find(t => t.col === col && t.row === row);
  if (hit) { G.selectedTower = hit; openPopup(hit); return; }
  if (G.selectedTower) { closePopup(); return; }
  placeTower(col, row);
}
canvas.addEventListener('click', e => { e.preventDefault(); handleTap(e.clientX, e.clientY); });
canvas.addEventListener('touchend', e => {
  e.preventDefault();
  const t = e.changedTouches[0];
  handleTap(t.clientX, t.clientY);
}, { passive: false });

let mouseCell = null;
canvas.addEventListener('mousemove', e => {
  const p = gridXY(e.clientX, e.clientY);
  mouseCell = (p.col >= 0 && p.col < COLS && p.row >= 0 && p.row < ROWS) ? p : null;
});
canvas.addEventListener('mouseleave', () => { mouseCell = null; });

/* ── Tower placement ────────────────────────────────────────────────────────── */
function placeTower(col, row) {
  if (G.grid[row][col] !== 0) return;
  const def = TDEFS[G.selectedType];
  if (G.credits < def.cost) { hudFlash('hud-credits', '#ff3344'); return; }
  G.credits -= def.cost;
  G.grid[row][col] = 2;
  const t = { col, row, type: G.selectedType, level: 1, cooldown: 0,
               beamTarget: null, beamClear: 0, target: null, muzzleFlash: 0 };
  G.towers.push(t);
  ensureSprite(t);
  burst(col * CELL + CELL/2, row * CELL + CELL/2, def.color, 9);
  updateHUD(); updateAffordability();
}

/* ── Popup ──────────────────────────────────────────────────────────────────── */
function openPopup(t) {
  const def = TDEFS[t.type], li = t.level - 1;
  const upCost  = t.level < 3 ? UPG_COST[t.level] : null;
  const sellVal = Math.floor(def.cost * 0.6 + UPG_COST.slice(1, t.level).reduce((a,b)=>a+b,0) * 0.5);

  $('pop-title').textContent = def.name;
  $('pop-lvl').textContent   = `LV ${t.level}`;
  $('pop-stats').innerHTML   =
    `<div class="stat-row">` +
    `DMG&nbsp;<b>${Math.round(def.dmg * UPG_DMG[li])}</b>&emsp;` +
    `RNG&nbsp;<b>${(def.range * UPG_RNG[li]).toFixed(1)}</b>&emsp;` +
    `SPD&nbsp;<b>${(def.rate * UPG_RATE[li]).toFixed(1)}/s</b>` +
    `</div><div style="font-size:10px;color:var(--txt);margin-top:4px">${def.desc}</div>`;

  const ub = $('pop-upgrade');
  if (upCost) {
    ub.textContent = `⬆ UPGRADE  ⬡${upCost}`;
    ub.disabled    = G.credits < upCost;
    ub.onclick     = () => upgradeTower(t);
  } else {
    ub.textContent = '⬆ MAX LEVEL';
    ub.disabled = true;
  }
  $('pop-sell').textContent = `⬡ SELL  ⬡${sellVal}`;
  $('pop-sell').onclick     = () => sellTower(t, sellVal);
  towerPopup.classList.remove('hidden');
}
function closePopup() { G.selectedTower = null; towerPopup.classList.add('hidden'); }
$('pop-close').addEventListener('click', closePopup);

function upgradeTower(t) {
  const cost = UPG_COST[t.level];
  if (!cost || t.level >= 3 || G.credits < cost) return;
  G.credits -= cost; t.level++;
  ensureSprite(t);
  burst(t.col*CELL+CELL/2, t.row*CELL+CELL/2, '#39ff6e', 16);
  updateHUD(); updateAffordability(); openPopup(t);
}
function sellTower(t, val) {
  G.credits += val;
  G.grid[t.row][t.col] = 0;
  G.towers = G.towers.filter(x => x !== t);
  closePopup(); updateHUD(); updateAffordability();
}

/* ── HUD ────────────────────────────────────────────────────────────────────── */
function updateHUD() {
  hudLives.textContent   = G.lives;
  hudCredits.textContent = G.credits;
  hudWave.textContent    = G.wave || '—';
  hudScore.textContent   = G.score.toLocaleString();
  updateAffordability();
}
function hudFlash(id, color) {
  const el = $(id);
  const orig = el.style.color;
  el.style.color = color;
  el.style.transition = 'none';
  el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump');
  setTimeout(() => { el.style.color = orig; el.style.transition = ''; }, 420);
}
function updateAffordability() {
  document.querySelectorAll('.shop-item').forEach(item => {
    item.classList.toggle('cant-afford', G.credits < TDEFS[item.dataset.tower].cost);
  });
}
function updateBossBar(boss) {
  if (!boss) { bossBar.classList.add('hidden'); return; }
  bossBar.classList.remove('hidden');
  bossBarFill.style.width = Math.max(0, boss.hp / boss.maxHp * 100) + '%';
  bossHpText.textContent = `${Math.max(0,Math.round(boss.hp))} / ${boss.maxHp}`;
  canvas.style.top = (HH() + 24) + 'px';
}

/* ── Banners ────────────────────────────────────────────────────────────────── */
function showBanner(txt) {
  waveBanner.textContent = txt;
  waveBanner.classList.remove('hidden');
  clearTimeout(waveBanner._t);
  waveBanner._t = setTimeout(() => waveBanner.classList.add('hidden'), 2200);
}
function showStreak(n) {
  const msgs = {3:'TRIPLE KILL!',5:'PENTA KILL!',10:'UNSTOPPABLE!',15:'GODLIKE!',20:'LEGENDARY!'};
  const msg = msgs[n] || (n > 20 ? 'RAMPAGE!' : null);
  if (!msg) return;
  streakToast.textContent = `${msg}  ×${n}`;
  streakToast.classList.remove('hidden');
  clearTimeout(streakToast._t);
  streakToast._t = setTimeout(() => streakToast.classList.add('hidden'), 1600);
}

/* ── Path generation ────────────────────────────────────────────────────────── */
function buildGrid() {
  G.grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(0));
}
function buildPath() {
  const wps = [
    [Math.floor(COLS/2), 0],
    [Math.floor(COLS/2), 3],
    [2,3],[2,7],
    [COLS-3,7],[COLS-3,11],
    [4,11],[4,15],
    [COLS-4,15],[COLS-4,18],
    [Math.floor(COLS/2),18],
    [Math.floor(COLS/2),ROWS-1],
  ];
  G.waypoints = wps.map(([col,row]) => ({col,row}));
  G.path = [];
  for (let w = 0; w < wps.length - 1; w++) {
    let [c,r] = wps[w]; const [c2,r2] = wps[w+1];
    while (c !== c2 || r !== r2) {
      if (!G.path.find(p => p.col===c && p.row===r)) G.path.push({col:c,row:r});
      G.grid[r][c] = 1;
      if (c !== c2) c += c2>c?1:-1; else r += r2>r?1:-1;
    }
  }
  const [lc,lr] = wps[wps.length-1];
  G.path.push({col:lc,row:lr}); G.grid[lr][lc] = 1;
}

/* ── Offscreen layers ───────────────────────────────────────────────────────── */
function buildBgLayer() {
  bgLayer = document.createElement('canvas');
  bgLayer.width = COLS*CELL; bgLayer.height = ROWS*CELL;
  const g = bgLayer.getContext('2d');
  g.fillStyle = '#04060f'; g.fillRect(0, 0, bgLayer.width, bgLayer.height);
  // Grid lines
  g.strokeStyle = 'rgba(0,220,255,.045)'; g.lineWidth = .5;
  for (let c=0;c<=COLS;c++){g.beginPath();g.moveTo(c*CELL,0);g.lineTo(c*CELL,bgLayer.height);g.stroke();}
  for (let r=0;r<=ROWS;r++){g.beginPath();g.moveTo(0,r*CELL);g.lineTo(bgLayer.width,r*CELL);g.stroke();}
  // Corner dots at intersections for extra neon feel
  g.fillStyle = 'rgba(0,220,255,.07)';
  for (let c=0;c<=COLS;c++) for(let r=0;r<=ROWS;r++){
    g.beginPath();g.arc(c*CELL,r*CELL,1,0,Math.PI*2);g.fill();
  }
}
function buildPathLayer() {
  pathLayer = document.createElement('canvas');
  pathLayer.width = COLS*CELL; pathLayer.height = ROWS*CELL;
  const g = pathLayer.getContext('2d');
  // Path floor with subtle gradient
  for (const {col,row} of G.path) {
    const x=col*CELL, y=row*CELL;
    g.fillStyle = '#060d1c'; g.fillRect(x,y,CELL,CELL);
  }
  // Path border (only cells adjacent to non-path)
  g.strokeStyle='rgba(0,220,255,.14)'; g.lineWidth=.5;
  for (const {col,row} of G.path) g.strokeRect(col*CELL+.5,row*CELL+.5,CELL-1,CELL-1);
  // Direction arrows along path every 4 cells
  g.fillStyle = 'rgba(0,220,255,.18)';
  g.font = `bold ${Math.round(CELL*.4)}px sans-serif`;
  g.textAlign='center'; g.textBaseline='middle';
  for (let i=2; i<G.path.length-1; i+=4) {
    const a=G.path[i], b=G.path[i+1];
    const dc=b.col-a.col, dr=b.row-a.row;
    const arrow = dc>0?'›':dc<0?'‹':dr>0?'∨':'∧';
    g.fillText(arrow, a.col*CELL+CELL/2, a.row*CELL+CELL/2);
  }
  // Entry / Exit markers
  const en=G.waypoints[0], ex=G.waypoints[G.waypoints.length-1];
  g.fillStyle='rgba(57,255,110,.7)';g.font=`bold ${Math.round(CELL*.6)}px sans-serif`;
  g.fillText('▼',en.col*CELL+CELL/2,en.row*CELL+CELL/2);
  g.fillStyle='rgba(255,45,120,.75)';
  g.fillText('⬡',ex.col*CELL+CELL/2,ex.row*CELL+CELL/2);
}

/* ── Sprite cache ───────────────────────────────────────────────────────────── */
function ensureSprite(t) {
  const key=`${t.type}_${t.level}`;
  if (!spriteCache[key]) spriteCache[key] = buildSprite(t.type, t.level);
}
function rebuildAllSprites() {
  spriteCache = {};
  for (const t of (G ? G.towers : [])) ensureSprite(t);
}
function buildSprite(type, level) {
  const S=CELL, oc=document.createElement('canvas');
  oc.width=S; oc.height=S;
  const g=oc.getContext('2d');
  const def=TDEFS[type], col=def.color, s=S*.36, cx=S/2, cy=S/2;
  // Base plate
  g.fillStyle='#0b1122';
  rrg(g,cx-s*1.15,cy-s*1.15,s*2.3,s*2.3,3); g.fill();
  g.strokeStyle=col+'44'; g.lineWidth=1;
  rrg(g,cx-s*1.15,cy-s*1.15,s*2.3,s*2.3,3); g.stroke();
  // Level glow on plate
  if (level>1){
    g.strokeStyle=col+'88'; g.lineWidth=level;
    rrg(g,cx-s*1.15,cy-s*1.15,s*2.3,s*2.3,3); g.stroke();
  }
  // Body — points right, rotated at draw time
  g.fillStyle=col;
  if (def.proj==='beam') {
    // Laser — diamond
    g.beginPath();g.moveTo(cx,cy-s*.72);g.lineTo(cx+s*.5,cy);
    g.lineTo(cx,cy+s*.72);g.lineTo(cx-s*.5,cy);g.closePath();g.fill();
    g.fillRect(cx+s*.28,cy-s*.09,s*.85,s*.18);
  } else if (def.proj==='rocket') {
    // Missile — chunky square
    g.fillRect(cx-s*.48,cy-s*.48,s*.96,s*.96);
    g.fillStyle='#ff6600'; g.fillRect(cx+s*.22,cy-s*.1,s*.92,s*.2);
  } else if (def.proj==='arc') {
    // Tesla — circle
    g.beginPath();g.arc(cx,cy,s*.56,0,Math.PI*2);g.fill();
    g.fillStyle='rgba(255,255,255,.45)';g.beginPath();g.arc(cx,cy,s*.22,0,Math.PI*2);g.fill();
  } else if (def.proj==='orb') {
    // Slow — ring
    g.beginPath();g.arc(cx,cy,s*.52,0,Math.PI*2);
    g.strokeStyle=col; g.lineWidth=3; g.stroke();
    g.fillStyle=col+'33'; g.fill();
    g.fillStyle=col; g.fillRect(cx+s*.28,cy-s*.1,s*.86,s*.2);
  } else {
    // Gun — square body + barrel
    g.fillRect(cx-s*.42,cy-s*.42,s*.84,s*.84);
    g.fillStyle='rgba(255,255,255,.22)'; g.fillRect(cx+s*.24,cy-s*.1,s*.88,s*.2);
  }
  // Level pips
  for(let l=0;l<level;l++){
    g.fillStyle='#ffed47';
    g.beginPath();g.arc(cx-s*.38+l*s*.38,cy+s*1.05,2.5,0,Math.PI*2);g.fill();
  }
  return oc;
}
function rrg(g,x,y,w,h,r){
  g.beginPath();g.moveTo(x+r,y);
  g.lineTo(x+w-r,y);g.arcTo(x+w,y,x+w,y+r,r);
  g.lineTo(x+w,y+h-r);g.arcTo(x+w,y+h,x+w-r,y+h,r);
  g.lineTo(x+r,y+h);g.arcTo(x,y+h,x,y+h-r,r);
  g.lineTo(x,y+r);g.arcTo(x,y,x+r,y,r);
  g.closePath();
}

/* ── Start / Stop ───────────────────────────────────────────────────────────── */
function startGame() {
  stopLoop(); titleCanvas.stop();
  G = freshState();
  speedIdx=0; G.speed=1;
  btnSpeed.textContent='1×'; btnSpeed.classList.remove('fast');
  btnWave.disabled=false; wbMain.textContent='SEND WAVE';
  bossBar.classList.add('hidden');
  waveProg.style.width='0%';
  buildGrid(); buildPath();
  resize();
  buildBgLayer(); buildPathLayer(); rebuildAllSprites();
  showScreen('screen-game');
  closePopup();
  waveBanner.classList.add('hidden');
  streakToast.classList.add('hidden');
  updateHUD();
  lastTs = performance.now();
  animId = requestAnimationFrame(loop);
}
function stopLoop() {
  if (animId) { cancelAnimationFrame(animId); animId=null; }
}

/* ═══════════════════════════════════════════════════════════════════════════════
   MAIN LOOP
═══════════════════════════════════════════════════════════════════════════════ */
function loop(ts) {
  animId = requestAnimationFrame(loop);
  const raw = Math.min((ts - lastTs) / 1000, 0.05);
  lastTs = ts;
  const dt = raw * G.speed;
  update(dt, ts);
  draw(ts);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   UPDATE
═══════════════════════════════════════════════════════════════════════════════ */
function update(dt, ts) {
  spawnStep(dt);
  moveEnemies(dt);
  towersFire(dt, ts);
  moveProjectiles(dt);
  tickShocks(dt);
  tickParticles(dt);
  tickFloats(dt);
  tickStreak(dt);
  updateBossUI();
  checkWaveDone();
}

function spawnStep(dt) {
  if (G.phase !== 'spawning' || !G.spawnQueue.length) return;
  G.spawnTimer -= dt;
  if (G.spawnTimer > 0) return;
  const def = G.spawnQueue.shift();
  G.spawnTimer = def.delay;
  const wp = G.waypoints[0];
  const e = { ...def, x: wp.col*CELL+CELL/2, y: wp.row*CELL+CELL/2,
               wpIdx: 1, slowTimer: 0, slowFactor: 1, id: ++eid };
  G.enemies.push(e);
  G.enemySet.add(e);
}

function moveEnemies(dt) {
  for (let i = G.enemies.length-1; i >= 0; i--) {
    const e = G.enemies[i];
    if (e.slowTimer > 0) { e.slowTimer -= dt; if (e.slowTimer <= 0) e.slowFactor = 1; }
    if (e.wpIdx >= G.waypoints.length) {
      G.lives = Math.max(0, G.lives - 1);
      G.enemySet.delete(e);
      G.enemies.splice(i, 1);
      hudFlash('hud-lives', '#ff3344');
      updateHUD();
      if (G.lives <= 0) { gameOver(); return; }
      continue;
    }
    const wp = G.waypoints[e.wpIdx];
    const tx=wp.col*CELL+CELL/2, ty=wp.row*CELL+CELL/2;
    const dx=tx-e.x, dy=ty-e.y, dist=Math.hypot(dx,dy);
    const step = e.spd * CELL * e.slowFactor * dt;
    if (dist <= step + .5) { e.x=tx; e.y=ty; e.wpIdx++; }
    else { e.x += dx/dist*step; e.y += dy/dist*step; }
  }
}

function towersFire(dt, ts) {
  for (const t of G.towers) {
    const def=TDEFS[t.type], li=t.level-1;
    const range=def.range*UPG_RNG[li]*CELL;
    const rate=def.rate*UPG_RATE[li];
    const dmg=def.dmg*UPG_DMG[li];
    const tx=t.col*CELL+CELL/2, ty=t.row*CELL+CELL/2;

    t.cooldown -= dt;
    if (t.beamClear > 0) { t.beamClear -= dt; if(t.beamClear<=0) t.beamTarget=null; }
    if (t.muzzleFlash > 0) t.muzzleFlash -= dt;

    // Find furthest-along in range
    let best=null, bestWp=-1;
    for (const e of G.enemies) {
      if (Math.hypot(e.x-tx, e.y-ty) <= range && e.wpIdx > bestWp) {
        bestWp=e.wpIdx; best=e;
      }
    }
    t.target = best;
    if (!best) continue;
    if (t.cooldown > 0) continue;
    t.cooldown = 1/rate;
    t.muzzleFlash = 0.08;

    if (def.proj==='beam') {
      applyDmg(best, dmg, 0, 0);
      t.beamTarget = best; t.beamClear = 0.11;
      smBurst(best.x, best.y, def.color, 3);
    } else if (def.proj==='arc') {
      applyDmg(best, dmg, def.slow, 1.2);
      addArc(tx, ty, best, def.color);
      let prev=best;
      for (let c=0; c<def.chain; c++) {
        let nx=null, bd=range*.75;
        for (const e of G.enemies) {
          if (e===prev) continue;
          const d=Math.hypot(e.x-prev.x, e.y-prev.y);
          if (d<bd) { bd=d; nx=e; }
        }
        if (!nx) break;
        applyDmg(nx, dmg*.55, def.slow, .8);
        addArc(prev.x, prev.y, nx, def.color);
        prev=nx;
      }
    } else {
      G.projs.push({
        x:tx, y:ty, target:best,
        type:def.proj, color:def.color,
        spd: def.proj==='rocket' ? 3.5*CELL : 5.5*CELL,
        dmg, slow:def.slow, splash:def.splash,
        r: def.proj==='rocket' ? 5 : 3.5,
      });
    }
  }
}

function applyDmg(e, dmg, slowAmt, slowDur) {
  const actual = Math.round(dmg * (1 - e.armor));
  e.hp -= actual;
  if (slowAmt>0 && slowDur>0) { e.slowFactor=1-slowAmt; e.slowTimer=slowDur; }
  addFloat(e.x, e.y - CELL*.32, `-${actual}`, '#ff5588');
  if (e.hp <= 0) killEnemy(e);
}

function killEnemy(e) {
  G.score   += e.reward * 10;
  G.credits += e.reward;
  G.killedThisWave++;
  G.killStreak++; G.streakTimer = 3.5;
  showStreak(G.killStreak);
  G.enemySet.delete(e);
  G.enemies = G.enemies.filter(x => x !== e);
  bigBurst(e.x, e.y, e.color, e.name==='BOSS' ? 32 : 15);
  addFloat(e.x, e.y - CELL*.55, `+${e.reward}⬡`, '#ffed47');
  hudFlash('hud-score', '#ffed47');
  hudFlash('hud-credits', '#39ff6e');
  updateHUD();
  // Wave progress
  if (G.totalWaveEnemies > 0)
    waveProg.style.width = Math.min(100, G.killedThisWave / G.totalWaveEnemies * 100) + '%';
}

function addArc(x1,y1,target,color) {
  G.particles.push({type:'arc',x1,y1,x2:target.x,y2:target.y,color,life:.13,maxLife:.13});
}

function moveProjectiles(dt) {
  for (let i=G.projs.length-1; i>=0; i--) {
    const p=G.projs[i];
    if (!G.enemySet.has(p.target)) { G.projs.splice(i,1); continue; }  // O(1) check
    const dx=p.target.x-p.x, dy=p.target.y-p.y, dist=Math.hypot(dx,dy);
    const step=p.spd*dt;
    if (dist <= step+2) {
      if (p.splash>0) {
        const sr=p.splash*CELL, px=p.target.x, py=p.target.y;
        for (const e of [...G.enemies])
          if (Math.hypot(e.x-px, e.y-py) <= sr) applyDmg(e, p.dmg, p.slow, .8);
        addShock(px, py, sr, p.color);
        bigBurst(px, py, p.color, 22);
      } else {
        if (G.enemySet.has(p.target)) applyDmg(p.target, p.dmg, p.slow, 1.5);
        smBurst(p.x, p.y, p.color, 7);
      }
      G.projs.splice(i,1);
    } else {
      p.x += dx/dist*step; p.y += dy/dist*step;
    }
  }
}

/* ── Shockwaves ─────────────────────────────────────────────────────────────── */
function addShock(x,y,maxR,color) {
  G.shocks.push({x,y,r:0,maxR,color,life:.45,maxLife:.45});
}
function tickShocks(dt) {
  for (let i=G.shocks.length-1;i>=0;i--) {
    const s=G.shocks[i]; s.life-=dt;
    if (s.life<=0) { G.shocks.splice(i,1); continue; }
    s.r = s.maxR * (1 - s.life/s.maxLife);
  }
}

/* ── Particles ──────────────────────────────────────────────────────────────── */
const MAX_PARTICLES = 240;
function bigBurst(x,y,color,n) { _burst(x,y,color,n,true); }
function smBurst(x,y,color,n)  { _burst(x,y,color,n,false); }
function _burst(x,y,color,n,big) {
  const room = MAX_PARTICLES - G.particles.length;
  for (let i=0; i<Math.min(n,room); i++) {
    const a=Math.random()*Math.PI*2;
    const s=(big?.7:0.4)*(1+Math.random()*2)*CELL*.06;
    G.particles.push({
      type:'dot',x,y,vx:Math.cos(a)*s,vy:Math.sin(a)*s,
      color: Math.random()<.25?'#ffffff':color,
      r:1+Math.random()*(big?2.2:1.5),
      life:.2+Math.random()*.4, maxLife:.6,
    });
  }
}
function tickParticles(dt) {
  for (let i=G.particles.length-1;i>=0;i--) {
    const p=G.particles[i]; p.life-=dt;
    if (p.life<=0) { G.particles.splice(i,1); continue; }
    if (p.type==='dot') { p.x+=p.vx; p.y+=p.vy; p.vy+=.055; }
  }
}

/* ── Float texts ────────────────────────────────────────────────────────────── */
function addFloat(x,y,text,color) {
  if (G.floats.length<90) G.floats.push({x,y,text,color,life:.72,maxLife:.72,vy:-26});
}
function tickFloats(dt) {
  for (let i=G.floats.length-1;i>=0;i--) {
    const f=G.floats[i]; f.life-=dt; f.y+=f.vy*dt;
    if (f.life<=0) G.floats.splice(i,1);
  }
}

/* ── Streak ─────────────────────────────────────────────────────────────────── */
function tickStreak(dt) {
  if (G.killStreak>0) {
    G.streakTimer-=dt;
    if (G.streakTimer<=0) G.killStreak=0;
  }
}

/* ── Boss UI ────────────────────────────────────────────────────────────────── */
function updateBossUI() {
  const boss = G.enemies.find(e=>e.name==='BOSS');
  if (boss) {
    updateBossBar(boss);
  } else if (!bossBar.classList.contains('hidden')) {
    updateBossBar(null);
    canvas.style.top = HH() + 'px';
  }
}

/* ── Wave done ──────────────────────────────────────────────────────────────── */
function checkWaveDone() {
  if (!G.waveActive) return;
  if (G.spawnQueue.length===0 && G.enemies.length===0 && G.phase!=='prep') {
    G.waveActive=false; G.phase='prep';
    wbMain.textContent='SEND WAVE'; btnWave.disabled=false;
    waveProg.style.width='100%';
    setTimeout(()=>waveProg.style.width='0%',600);
    const bonus=20+G.wave*5; G.credits+=bonus; updateHUD();
    addFloat(canvas.width/2, canvas.height/2-20, `CLEAR! +${bonus}⬡`, '#39ff6e');
  }
}

/* ── Game over ──────────────────────────────────────────────────────────────── */
function gameOver() {
  stopLoop(); saveBest(G.score); updateTitleBest();
  $('over-grid').innerHTML=[
    {v:G.wave,             l:'WAVES'},
    {v:G.score.toLocaleString(),l:'SCORE'},
    {v:G.towers.length,    l:'TOWERS'},
    {v:Math.max(0,G.lives),l:'LIVES LEFT'},
  ].map(s=>`<div class="og-box"><div class="og-val">${s.v}</div><div class="og-lbl">${s.l}</div></div>`).join('');
  $('over-hs').textContent = `BEST: ${getBest().toLocaleString()} PTS`;
  setTimeout(()=>showScreen('screen-over'), 520);
}

/* ═══════════════════════════════════════════════════════════════════════════════
   DRAW
   Performance rules:
   - No shadowBlur in the main loop. All glow is pre-baked into sprites or
     achieved via a second transparent wide line stroke.
   - bgLayer & pathLayer are blitted as single drawImage calls.
   - Enemies: two-pass (fill then details) to batch state changes.
   - Particles: single save/restore wrapping the whole loop.
═══════════════════════════════════════════════════════════════════════════════ */
function draw(ts) {
  // 1. Static layers
  if (bgLayer)   ctx.drawImage(bgLayer,0,0);
  else { ctx.fillStyle='#04060f'; ctx.fillRect(0,0,canvas.width,canvas.height); }
  if (pathLayer) ctx.drawImage(pathLayer,0,0);

  // 2. Range ring (selected tower or placement preview)
  if (G.selectedTower) drawRangeRing(G.selectedTower);
  else if (mouseCell)   drawPlacementPreview(mouseCell);

  // 3. Shockwave rings
  drawShocks();

  // 4. Towers
  drawTowers(ts);

  // 5. Enemies
  drawEnemies(ts);

  // 6. Projectiles
  drawProjectiles();

  // 7. Beams
  drawBeams();

  // 8. Particles & arcs
  drawParticles();

  // 9. Float texts
  drawFloats();
}

function drawRangeRing(t) {
  const def=TDEFS[t.type], range=def.range*UPG_RNG[t.level-1]*CELL;
  const cx=t.col*CELL+CELL/2, cy=t.row*CELL+CELL/2;
  ctx.beginPath();ctx.arc(cx,cy,range,0,Math.PI*2);
  ctx.strokeStyle=def.color+'50'; ctx.lineWidth=1;
  ctx.setLineDash([4,4]); ctx.stroke(); ctx.setLineDash([]);
  ctx.fillStyle=def.color+'09'; ctx.fill();
}

function drawPlacementPreview(mc) {
  if (G.grid[mc.row][mc.col]!==0) return;
  const def=TDEFS[G.selectedType];
  ctx.fillStyle='rgba(0,220,255,.06)';
  ctx.fillRect(mc.col*CELL,mc.row*CELL,CELL,CELL);
  ctx.strokeStyle='rgba(0,220,255,.3)';ctx.lineWidth=1;
  ctx.strokeRect(mc.col*CELL+.5,mc.row*CELL+.5,CELL-1,CELL-1);
  // Range
  const range=def.range*CELL;
  const cx=mc.col*CELL+CELL/2, cy=mc.row*CELL+CELL/2;
  ctx.beginPath();ctx.arc(cx,cy,range,0,Math.PI*2);
  ctx.strokeStyle=def.color+'28';ctx.lineWidth=1;
  ctx.setLineDash([3,3]);ctx.stroke();ctx.setLineDash([]);
}

function drawShocks() {
  for (const s of G.shocks) {
    const a=s.life/s.maxLife;
    ctx.beginPath();ctx.arc(s.x,s.y,s.r,0,Math.PI*2);
    ctx.strokeStyle=s.color;ctx.lineWidth=2;ctx.globalAlpha=a*.7;ctx.stroke();
    ctx.strokeStyle=s.color;ctx.lineWidth=6;ctx.globalAlpha=a*.15;ctx.stroke();
    ctx.globalAlpha=1;
  }
}

function drawTowers(ts) {
  for (const t of G.towers) {
    const key=`${t.type}_${t.level}`;
    const spr=spriteCache[key];
    const cx=t.col*CELL+CELL/2, cy=t.row*CELL+CELL/2;
    let angle=-Math.PI/2;
    if (t.target) angle=Math.atan2(t.target.y-cy, t.target.x-cx);

    ctx.save();
    ctx.translate(cx,cy);
    ctx.rotate(angle);
    // Muzzle flash
    if (t.muzzleFlash>0 && spr) {
      ctx.globalAlpha=t.muzzleFlash/0.08;
      ctx.fillStyle='#fff';
      ctx.fillRect(CELL*.3,-CELL*.08,CELL*.2,CELL*.16);
      ctx.globalAlpha=1;
    }
    if (spr) ctx.drawImage(spr,-CELL/2,-CELL/2,CELL,CELL);
    ctx.restore();

    // Selection outline
    if (G.selectedTower===t) {
      ctx.strokeStyle='rgba(255,255,255,.55)';ctx.lineWidth=1.5;
      ctx.setLineDash([3,3]);
      rrg(ctx,cx-CELL*.5,cy-CELL*.5,CELL,CELL,3);ctx.stroke();
      ctx.setLineDash([]);
    }
  }
}

function drawEnemies(ts) {
  // Pass 1: bodies (batch by similar styles)
  for (const e of G.enemies) {
    const r=e.r*CELL;
    ctx.fillStyle=e.color;
    ctx.beginPath();
    switch(e.shape) {
      case 'circle':
        ctx.arc(e.x,e.y,r,0,Math.PI*2); break;
      case 'tri': {
        const {x,y}=e;
        ctx.moveTo(x,y-r);ctx.lineTo(x+r*.87,y+r*.5);ctx.lineTo(x-r*.87,y+r*.5);ctx.closePath();
        break;
      }
      case 'square':
        ctx.rect(e.x-r,e.y-r,r*2,r*2); break;
      case 'diamond':
        ctx.moveTo(e.x,e.y-r);ctx.lineTo(e.x+r,e.y);
        ctx.lineTo(e.x,e.y+r);ctx.lineTo(e.x-r,e.y);ctx.closePath(); break;
      case 'hex':
        for(let i=0;i<6;i++){const a=i/6*Math.PI*2-Math.PI/6;
          ctx.lineTo(e.x+Math.cos(a)*r,e.y+Math.sin(a)*r);}
        ctx.closePath(); break;
    }
    ctx.fill();
  }
  // Pass 2: inner detail, HP bar, slow ring
  for (const e of G.enemies) {
    const r=e.r*CELL;
    // Dark inner circle
    ctx.fillStyle='rgba(0,0,0,.38)';
    ctx.beginPath();ctx.arc(e.x,e.y,r*.4,0,Math.PI*2);ctx.fill();
    // Slow ring
    if (e.slowFactor<1) {
      ctx.strokeStyle='rgba(192,96,255,.65)';ctx.lineWidth=2;
      ctx.beginPath();ctx.arc(e.x,e.y,r+3,0,Math.PI*2);ctx.stroke();
    }
    // HP bar
    const bw=r*2.5, bh=Math.max(2,CELL*.055);
    const bx=e.x-bw/2, by=e.y-r-7;
    ctx.fillStyle='#111';ctx.fillRect(bx,by,bw,bh);
    const pct=Math.max(0,e.hp/e.maxHp);
    ctx.fillStyle=pct>.5?'#39ff6e':pct>.25?'#ffed47':'#ff2d78';
    ctx.fillRect(bx,by,bw*pct,bh);
    // Armour tick mark for armoured enemies (no emoji — perf)
    if (e.armor>0) {
      ctx.fillStyle='rgba(255,237,71,.55)';
      ctx.fillRect(e.x+r*.45, e.y-r*.95, Math.max(2,CELL*.06), Math.max(6,CELL*.2));
    }
  }
}

function drawProjectiles() {
  for (const p of G.projs) {
    ctx.fillStyle=p.color;
    if (p.type==='rocket') {
      if (p.target) {
        const angle=Math.atan2(p.target.y-p.y, p.target.x-p.x);
        ctx.save();ctx.translate(p.x,p.y);ctx.rotate(angle);
        ctx.fillStyle=p.color;ctx.fillRect(-7,-2.5,14,5);
        ctx.fillStyle='#ff4000';ctx.fillRect(-10,-2,4,4);
        ctx.restore();
      }
    } else {
      ctx.beginPath();ctx.arc(p.x,p.y,p.r,0,Math.PI*2);ctx.fill();
      ctx.globalAlpha=.35;
      ctx.beginPath();ctx.arc(p.x-1.5,p.y-1.5,p.r*.5,0,Math.PI*2);ctx.fill();
      ctx.globalAlpha=1;
    }
  }
}

function drawBeams() {
  for (const t of G.towers) {
    if (!t.beamTarget || !G.enemySet.has(t.beamTarget)) continue;
    const cx=t.col*CELL+CELL/2, cy=t.row*CELL+CELL/2;
    const {color}=TDEFS[t.type];
    // Glow line (wide transparent)
    ctx.strokeStyle=color; ctx.lineWidth=7; ctx.globalAlpha=.12;
    ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(t.beamTarget.x,t.beamTarget.y);ctx.stroke();
    // Core beam
    ctx.lineWidth=2; ctx.globalAlpha=.9;
    ctx.beginPath();ctx.moveTo(cx,cy);ctx.lineTo(t.beamTarget.x,t.beamTarget.y);ctx.stroke();
    ctx.globalAlpha=1;
  }
}

function drawParticles() {
  ctx.save();
  for (const p of G.particles) {
    const a=Math.max(0,p.life/p.maxLife);
    if (p.type==='arc') {
      ctx.globalAlpha=a*.85; ctx.strokeStyle=p.color; ctx.lineWidth=2;
      ctx.beginPath(); ctx.moveTo(p.x1,p.y1);
      for(let s=1;s<5;s++){
        const f=s/5;
        ctx.lineTo(p.x1+(p.x2-p.x1)*f+(Math.random()-.5)*18,
                   p.y1+(p.y2-p.y1)*f+(Math.random()-.5)*18);
      }
      ctx.lineTo(p.x2,p.y2);ctx.stroke();
    } else {
      ctx.globalAlpha=a;ctx.fillStyle=p.color;
      ctx.beginPath();ctx.arc(p.x,p.y,Math.max(.5,p.r*a),0,Math.PI*2);ctx.fill();
    }
  }
  ctx.restore();
}

function drawFloats() {
  ctx.save();
  ctx.textAlign='center';ctx.textBaseline='middle';
  ctx.font=`bold ${Math.round(CELL*.32)}px 'Share Tech Mono',monospace`;
  for (const f of G.floats) {
    ctx.globalAlpha=Math.min(1,f.life/f.maxLife*2);
    ctx.fillStyle=f.color;
    ctx.fillText(f.text,f.x,f.y);
  }
  ctx.restore();
}

/* ═══════════════════════════════════════════════════════════════════════════════
   ANIMATED TITLE CANVAS
   Draws a field of moving glowing particles + random grid flashes.
═══════════════════════════════════════════════════════════════════════════════ */
const titleCanvas = (() => {
  const tc = document.getElementById('title-canvas');
  const tCtx = tc.getContext('2d');
  let rafId = null;
  const nodes = [];
  const NCOUNT = 55;

  function init() {
    tc.width  = window.innerWidth;
    tc.height = window.innerHeight;
    nodes.length = 0;
    for (let i=0;i<NCOUNT;i++) nodes.push(mkNode());
  }

  function mkNode() {
    const cols_t=['#00dcff','#ff2d78','#ffed47','#c060ff','#39ff6e'];
    return {
      x: Math.random()*tc.width, y: Math.random()*tc.height,
      vx:(Math.random()-.5)*.4, vy:(Math.random()-.5)*.4,
      r: 1+Math.random()*2.5,
      color:cols_t[Math.floor(Math.random()*cols_t.length)],
      alpha:0.2+Math.random()*.5,
    };
  }

  let last=0, gridFlashes=[];
  function frame(ts) {
    rafId = requestAnimationFrame(frame);
    const dt=Math.min((ts-last)/1000,.05); last=ts;
    const W=tc.width, H=tc.height;
    tCtx.clearRect(0,0,W,H);

    // Dark tinted bg
    tCtx.fillStyle='rgba(4,6,15,.7)';tCtx.fillRect(0,0,W,H);

    // Grid
    tCtx.strokeStyle='rgba(0,220,255,.04)';tCtx.lineWidth=.5;
    const GS=48;
    for(let x=0;x<W+GS;x+=GS){tCtx.beginPath();tCtx.moveTo(x,0);tCtx.lineTo(x,H);tCtx.stroke();}
    for(let y=0;y<H+GS;y+=GS){tCtx.beginPath();tCtx.moveTo(0,y);tCtx.lineTo(W,y);tCtx.stroke();}

    // Random cell flashes
    if (Math.random()<.04) {
      const fc=Math.floor(Math.random()*Math.floor(W/GS));
      const fr=Math.floor(Math.random()*Math.floor(H/GS));
      gridFlashes.push({x:fc*GS,y:fr*GS,s:GS,life:.4,maxLife:.4,
        color:['#00dcff22','#ff2d7818','#c060ff18'][Math.floor(Math.random()*3)]});
    }
    gridFlashes=gridFlashes.filter(f=>{f.life-=dt;if(f.life<=0)return false;
      tCtx.fillStyle=f.color;tCtx.globalAlpha=f.life/f.maxLife;
      tCtx.fillRect(f.x,f.y,f.s,f.s);tCtx.globalAlpha=1;return true;});

    // Nodes
    for (const n of nodes) {
      n.x+=n.vx; n.y+=n.vy;
      if(n.x<0||n.x>W)n.vx*=-1;
      if(n.y<0||n.y>H)n.vy*=-1;
      tCtx.globalAlpha=n.alpha;
      tCtx.fillStyle=n.color;
      tCtx.beginPath();tCtx.arc(n.x,n.y,n.r,0,Math.PI*2);tCtx.fill();
    }
    // Connections between close nodes
    tCtx.globalAlpha=1;
    for (let i=0;i<nodes.length;i++) for(let j=i+1;j<nodes.length;j++){
      const d=Math.hypot(nodes[i].x-nodes[j].x,nodes[i].y-nodes[j].y);
      if(d<90){
        tCtx.strokeStyle=nodes[i].color;
        tCtx.lineWidth=.5;tCtx.globalAlpha=(1-d/90)*.18;
        tCtx.beginPath();tCtx.moveTo(nodes[i].x,nodes[i].y);
        tCtx.lineTo(nodes[j].x,nodes[j].y);tCtx.stroke();
      }
    }
    tCtx.globalAlpha=1;
  }

  return {
    start() { init(); if(!rafId) rafId=requestAnimationFrame(frame); },
    stop()  { if(rafId){cancelAnimationFrame(rafId);rafId=null;} },
  };
})();

// Start the title animation on load
window.addEventListener('load', () => titleCanvas.start());

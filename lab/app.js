/* Shalev Driving Lab — one browser page, six driving modes, real actuator request. */
const $ = (id) => document.getElementById(id);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wrap = (a) => { while (a > Math.PI) a -= 2 * Math.PI; while (a < -Math.PI) a += 2 * Math.PI; return a; };

const state = {
  mode: 'pp', playing: true, loaded: false,
  path: [], track: null, length: 0,
  car: { x: 0, y: 0, yaw: 0, v: 0 }, steer: 0, prevSteer: 0,
  targetSpeed: 6, horizon: 0.6, nTents: 15,
  weights: { track: 6, head: 2.5, soft: 4 },
  trail: [], history: [], tentacles: [], selected: -1,
  manual: { throttle: 0, brake: 0, left: 0, right: 0 },
  last: { throttle: 0, brake: 0, gear: 4, drs: 0 },
  f1: null, fly: null, raf: null, t: 0, lastAct: null,
};

const scene = $('scene'), sctx = scene.getContext('2d');
const graph = $('graph'), gctx = graph.getContext('2d');

function resize() {
  const r = scene.getBoundingClientRect(), d = window.devicePixelRatio || 1;
  scene.width = r.width * d; scene.height = r.height * d;
  scene.dataset.dpr = d;
  const gr = graph.getBoundingClientRect();
  graph.width = gr.width * d; graph.height = gr.height * d;
}
window.addEventListener('resize', resize);

function bounds() {
  const pts = state.track.raceline;
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  return { minx: Math.min(...xs), maxx: Math.max(...xs), miny: Math.min(...ys), maxy: Math.max(...ys) };
}
let B = null;
function project(p) {
  const r = scene.getBoundingClientRect(), pad = 30;
  const w = r.width - pad * 2, h = r.height - pad * 2;
  const sx = w / Math.max(1e-6, B.maxx - B.minx), sy = h / Math.max(1e-6, B.maxy - B.miny);
  const s = Math.min(sx, sy);
  const ox = (r.width - (B.maxx - B.minx) * s) / 2;
  const oy = (r.height - (B.maxy - B.miny) * s) / 2;
  return [ox + (p[0] - B.minx) * s, oy + (B.maxy - p[1]) * s, s];
}

function nearest(x, y, hint = -1) {
  const n = state.path.length;
  let best = hint >= 0 ? hint : 0, bd = Infinity;
  if (hint < 0) {
    for (let i = 0; i < n; i++) {
      const dx = state.path[i][0] - x, dy = state.path[i][1] - y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
  } else {
    for (let k = -18; k <= 18; k++) {
      const i = (hint + k + n) % n, dx = state.path[i][0] - x, dy = state.path[i][1] - y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
  }
  return best;
}

function pathYaw(i) {
  const n = state.path.length, a = state.path[(i - 1 + n) % n], b = state.path[(i + 1) % n];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}
function curvature(i) {
  const n = state.path.length, a = state.path[(i - 1 + n) % n], b = state.path[i], c = state.path[(i + 1) % n];
  const ab = [b[0] - a[0], b[1] - a[1]], bc = [c[0] - b[0], c[1] - b[1]];
  const la = Math.hypot(...ab), lb = Math.hypot(...bc), lc = Math.hypot(c[0] - a[0], c[1] - a[1]);
  return la * lb * lc < 1e-9 ? 0 : 2 * Math.abs(ab[0] * bc[1] - ab[1] * bc[0]) / (la * lb * lc);
}

// ---------------------------------------------------------------- controllers
function ppSteer(idx) {
  const x = state.car.x, y = state.car.y;
  const step = Math.max(4, Math.round(1.5 / Math.max(0.03, state.length / state.path.length)));
  const t = state.path[(idx + step) % state.path.length];
  const alpha = wrap(Math.atan2(t[1] - y, t[0] - x) - state.car.yaw);
  return clamp(Math.atan2(2 * 1.53 * Math.sin(alpha), 1.5), -0.42, 0.42);
}
function stanleySteer(idx) {
  const n = state.path.length, p = state.path[idx], a = state.path[(idx - 1 + n) % n], b = state.path[(idx + 1) % n];
  let tx = b[0] - a[0], ty = b[1] - a[1];
  const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
  const cte = tx * (state.car.y - p[1]) - ty * (state.car.x - p[0]);
  const he = wrap(Math.atan2(ty, tx) - state.car.yaw);
  return clamp(he - Math.atan2(0.9 * cte, Math.max(0.2, state.car.v) + 0.5), -0.42, 0.42);
}

function evaluateArc(steer, dt = 0.1) {
  const steps = Math.max(4, Math.round(state.horizon / dt));
  let x = state.car.x, y = state.car.y, yaw = state.car.yaw, idx = nearest(x, y);
  let ct = 0, ch = 0, cs = 0, heLast = 0, cteLast = 0;
  const pts = [];
  for (let j = 0; j < steps; j++) {
    yaw += state.car.v / 1.53 * Math.tan(steer) * dt;
    x += state.car.v * Math.cos(yaw) * dt;
    y += state.car.v * Math.sin(yaw) * dt;
    pts.push([x, y]);
    idx = nearest(x, y, idx);
    const n = state.path.length, a = state.path[(idx - 1 + n) % n], b = state.path[(idx + 1) % n];
    let tx = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
    const cte = tx * (y - state.path[idx][1]) - ty * (x - state.path[idx][0]);
    const he = wrap(Math.atan2(ty, tx) - yaw);
    ct += cte * cte; ch += he * he;
    cs += Math.max(0, Math.abs(cte) - 0.72 * 1.8) ** 2;
    cteLast = cte; heLast = he;
  }
  const comfort = steer * steer + 0.5 * (steer - state.prevSteer) ** 2;
  const total = state.weights.track * ct / steps + state.weights.head * ch / steps + 0.2 * comfort + state.weights.soft * cs / steps;
  return { steer, pts, total, cte: cteLast, he: heLast, parts: { track: state.weights.track * ct / steps, head: state.weights.head * ch / steps, comfort: 0.2 * comfort, soft: state.weights.soft * cs / steps } };
}

function mpcSteer() {
  const n = state.nTents, max = 0.42, arcs = [];
  for (let k = 0; k < n; k++) arcs.push(evaluateArc(-max + 2 * max * k / (n - 1)));
  let best = 0;
  for (let k = 1; k < arcs.length; k++) if (arcs[k].total < arcs[best].total) best = k;
  state.tentacles = arcs; state.selected = best; state.parts = arcs[best].parts;
  return arcs[best].steer;
}

function sigmoid(x) { return 1 / (1 + Math.exp(-x)); }
function f1Policy(idx, accel) {
  if (!state.f1) return { a: 0, steer: ppSteer(idx) };
  const p = state.path[idx], b = state.path[(idx + 1) % state.path.length];
  const yaw = Math.atan2(b[1] - p[1], b[0] - p[0]);
  const he = wrap(yaw - state.car.yaw);
  const k = curvature(idx);
  const f = [
    state.car.v / 350, accel / 50, k * 20, state.car.v * state.car.v * k / 50,
    state.car.v * k * 10, state.last.throttle / 100, state.last.brake / 100,
    state.last.gear / 8, state.last.drs,
  ];
  const z = f.map((v, i) => (v - state.f1.mu[i]) / state.f1.sd[i]);
  // W1 is stored as [input][hidden].
  const h = state.f1.b1.map((b, i) =>
    Math.tanh(b + state.f1.W1.reduce((s, row, j) => s + row[i] * z[j], 0)));
  const out = state.f1.W2.map((row, i) => row.reduce((s, w, j) => s + w * h[j], 0) + state.f1.b2[i]);
  const throttle = sigmoid(out[0]) * 100, brake = sigmoid(out[1]) * 100;
  const f1steer = Math.tanh(out[2]) * 0.5;
  state.last.throttle = throttle; state.last.brake = brake;
  // The public F1 telemetry has no steering-wheel channel; we use the learned
  // longitudinal command and a PP steering stabiliser, shown in the UI.
  return { a: clamp(throttle / 100 * 4.5 - brake / 100 * 10, -10, 4.5), steer: clamp(0.35 * f1steer + 0.65 * ppSteer(idx), -0.42, 0.42) };
}

function flySteer(idx) {
  if (!state.fly) return ppSteer(idx);
  const n = state.path.length, p = state.path[idx], a = state.path[(idx - 1 + n) % n], b = state.path[(idx + 1) % n];
  let tx = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
  const cte = tx * (state.car.y - p[1]) - ty * (state.car.x - p[0]);
  const he = wrap(Math.atan2(ty, tx) - state.car.yaw);
  const s = [cte / 1.5, he / 0.5, 0, he / 2 * 5, state.prevSteer / 0.4, 1];
  const k = state.fly.W.map((row, i) => Math.tanh(row.reduce((z, w, j) => z + w * s[j], 0) + state.fly.b[i]));
  let y = state.fly.Wout[state.fly.Wout.length - 1];
  for (let i = 0; i < k.length; i++) y += state.fly.Wout[i] * k[i];
  for (let i = 0; i < 6; i++) y += state.fly.Wout[k.length + i] * s[i];
  // PP stabiliser keeps the biological readout on the car's line.
  return clamp(0.65 * y + 0.35 * ppSteer(idx), -0.42, 0.42);
}

// ---------------------------------------------------------------- actuator
function actuator(speedCmd, accel, steerReq) {
  const steerDeg = clamp(steerReq * 180 / Math.PI, -24, 24);
  let torque = 0, rpm = -1, brake = 0, mode = 'NEUTRAL';
  if (speedCmd > 0) {
    rpm = Math.min(4000, speedCmd * 60 / (2 * Math.PI * 0.253));
    torque = 50; brake = 0; mode = 'SPEED';
  } else if (accel > 0) {
    torque = clamp(300 * 0.253 * Math.abs(accel + 0.5) / 2, 0, 195); mode = 'TORQUE';
  } else if (accel === 0) {
    mode = 'NEUTRAL';
  } else if (accel > -5) {
    mode = 'ENGINE BRAKE';
  } else {
    brake = clamp(-accel / 10 * 100, 0, 100); mode = 'BRAKE';
  }
  return { speedCmd, accel, steerDeg, torque, rpm, brake, mode };
}

// ---------------------------------------------------------------- step
function step(dt) {
  const idx = nearest(state.car.x, state.car.y);
  const k = curvature(idx);
  const vlim = Math.min(state.targetSpeed, Math.sqrt(1.4 * 9.81 / Math.max(k, 1e-4)));
  let target = vlim, steerCmd = 0, accel = 0, throttle = 0, brake = 0, speedCmd = target;

  if (state.mode === 'manual') {
    speedCmd = 0;
    throttle = state.manual.throttle; brake = state.manual.brake;
    accel = throttle * 4.5 - brake * 10;
    steerCmd = (state.manual.left ? 1 : 0) * 0.35 - (state.manual.right ? 1 : 0) * 0.35;
    state.last.throttle = throttle * 100; state.last.brake = brake * 100;
  } else {
    accel = clamp(8.8 * (target - state.car.v), -10, 4.5);
    if (state.mode === 'pp') steerCmd = ppSteer(idx);
    else if (state.mode === 'stanley') steerCmd = stanleySteer(idx);
    else if (state.mode === 'mpc') steerCmd = mpcSteer();
    else if (state.mode === 'f1') { const f = f1Policy(idx, accel); accel = f.a; steerCmd = f.steer; }
    else if (state.mode === 'fly') steerCmd = flySteer(idx);
    if (state.mode !== 'f1') {
      throttle = accel > 0 ? accel / 4.5 : 0;
      brake = accel < 0 ? -accel / 10 : 0;
      state.last.throttle = throttle * 100; state.last.brake = brake * 100;
    }
  }

  // steering slew 0.6 rad/s and 24 deg limit
  const maxStep = 0.6 * dt;
  state.steer += clamp(steerCmd - state.steer, -maxStep, maxStep);
  state.steer = clamp(state.steer, -24 * Math.PI / 180, 24 * Math.PI / 180);
  state.prevSteer = state.steer;

  const act = actuator(speedCmd, accel, state.steer);
  state.lastAct = act;
  // Use the actuator request for the vehicle motion: speed mode follows the
  // wheel-rpm target through the speed PID; torque/brake map back to accel.
  let aEff = accel;
  if (act.mode === 'SPEED') aEff = clamp(8.8 * (act.rpm * 2 * Math.PI * 0.253 / 60 - state.car.v), -10, 4.5);
  else if (act.mode === 'TORQUE') aEff = 2 * act.torque / (300 * 0.253) - 0.5;
  else if (act.mode === 'BRAKE') aEff = -act.brake / 100 * 10;
  else if (act.mode === 'NEUTRAL') aEff = 0;

  state.car.v = Math.max(0, Math.min(18, state.car.v + aEff * dt));
  state.car.x += state.car.v * Math.cos(state.car.yaw) * dt;
  state.car.y += state.car.v * Math.sin(state.car.yaw) * dt;
  state.car.yaw += state.car.v / 1.53 * Math.tan(state.steer) * dt;
  state.car.yaw = wrap(state.car.yaw);
  state.t += dt;

  const p = state.path[idx];
  const n = state.path.length, a = state.path[(idx - 1 + n) % n], b = state.path[(idx + 1) % n];
  let tx = b[0] - a[0], ty = b[1] - a[1]; const l = Math.hypot(tx, ty) || 1; tx /= l; ty /= l;
  const cte = tx * (state.car.y - p[1]) - ty * (state.car.x - p[0]);
  const he = wrap(Math.atan2(ty, tx) - state.car.yaw);
  state.cte = cte; state.he = he; state.idx = idx;

  state.trail.push([state.car.x, state.car.y]);
  if (state.trail.length > 900) state.trail.shift();
  state.history.push({ t: state.t, cte, v: state.car.v, brake: act.brake, torque: act.torque });
  if (state.history.length > 360) state.history.shift();
}

// ---------------------------------------------------------------- drawing
function draw() {
  const r = scene.getBoundingClientRect(), d = +scene.dataset.dpr || 1;
  sctx.setTransform(d, 0, 0, d, 0, 0);
  sctx.clearRect(0, 0, r.width, r.height);
  sctx.fillStyle = '#080b12'; sctx.fillRect(0, 0, r.width, r.height);
  if (!state.track) return;

  // grid
  sctx.strokeStyle = 'rgba(40,60,90,.35)'; sctx.lineWidth = 1;
  for (let x = 0; x < r.width; x += 40) { sctx.beginPath(); sctx.moveTo(x, 0); sctx.lineTo(x, r.height); sctx.stroke(); }
  for (let y = 0; y < r.height; y += 40) { sctx.beginPath(); sctx.moveTo(0, y); sctx.lineTo(r.width, y); sctx.stroke(); }

  const line = (pts, color, width, dash = []) => {
    if (!pts || pts.length < 2) return;
    sctx.save(); sctx.setLineDash(dash); sctx.strokeStyle = color; sctx.lineWidth = width;
    sctx.beginPath();
    pts.forEach((p, i) => { const q = project(p); i ? sctx.lineTo(q[0], q[1]) : sctx.moveTo(q[0], q[1]); });
    sctx.stroke(); sctx.restore();
  };
  const close = (pts) => pts && pts.length ? [...pts, pts[0]] : pts;
  line(state.track.boundaries.blue, '#2c6bff', 1.2);
  line(state.track.boundaries.yellow, '#e0b000', 1.2);
  line(state.track.centerline, 'rgba(150,160,185,.5)', 1, [5, 5]);
  line(close(state.track.raceline), '#22e0ff', 2);

  // gates
  sctx.strokeStyle = 'rgba(70,200,110,.55)'; sctx.lineWidth = 1;
  for (const g of state.track.gates || []) {
    const a = project([g[0], g[1]]), b = project([g[2], g[3]]);
    sctx.beginPath(); sctx.moveTo(a[0], a[1]); sctx.lineTo(b[0], b[1]); sctx.stroke();
  }
  // cones
  for (const c of state.track.cones || []) {
    if (c[0] === 'car_start' || c[0] === 'orange' || c[0] === 'big_orange') continue;
    const p = project([c[1], c[2]]);
    sctx.fillStyle = c[0] === 'blue' ? '#2c6bff' : '#e0b000';
    sctx.beginPath(); sctx.arc(p[0], p[1], 1.8, 0, Math.PI * 2); sctx.fill();
  }

  // tentacles
  if (state.mode === 'mpc' && state.tentacles.length) {
    for (let i = 0; i < state.tentacles.length; i++) {
      const t = state.tentacles[i];
      sctx.strokeStyle = i === state.selected ? '#ff3ea5' : 'rgba(139,147,167,.28)';
      sctx.lineWidth = i === state.selected ? 3 : 1;
      sctx.beginPath();
      t.pts.forEach((p, j) => { const q = project(p); j ? sctx.lineTo(q[0], q[1]) : sctx.moveTo(q[0], q[1]); });
      sctx.stroke();
    }
  }

  // trail
  if (state.trail.length > 2) line(state.trail, '#d62728', 1.4);

  // car
  const p = project([state.car.x, state.car.y]), scale = p[2] || 1;
  sctx.save(); sctx.translate(p[0], p[1]); sctx.rotate(-state.car.yaw);
  sctx.fillStyle = '#ff6a00'; sctx.strokeStyle = '#fff'; sctx.lineWidth = 1.5;
  sctx.beginPath(); sctx.moveTo(12, 0); sctx.lineTo(-8, -6); sctx.lineTo(-8, 6); sctx.closePath(); sctx.fill(); sctx.stroke();
  sctx.restore();

  // graph
  drawGraph();
}

function drawGraph() {
  const r = graph.getBoundingClientRect(), d = +graph.dataset.dpr || 1;
  gctx.setTransform(d, 0, 0, d, 0, 0);
  gctx.clearRect(0, 0, r.width, r.height);
  const h = state.history; if (h.length < 2) return;
  const pad = 22, w = r.width - pad * 2, ht = r.height - pad * 2;
  gctx.strokeStyle = 'rgba(120,140,170,.15)'; gctx.lineWidth = 1;
  for (let i = 0; i <= 4; i++) { const y = pad + ht * i / 4; gctx.beginPath(); gctx.moveTo(pad, y); gctx.lineTo(pad + w, y); gctx.stroke(); }
  const maxCte = Math.max(0.4, Math.max(...h.map(x => Math.abs(x.cte))) * 1.2);
  const maxV = Math.max(8, Math.max(...h.map(x => x.v)) * 1.15);
  const n = h.length;
  const plot = (key, color, scale, off = 0) => {
    gctx.strokeStyle = color; gctx.lineWidth = 1.5; gctx.beginPath();
    h.forEach((x, i) => { const X = pad + w * i / (n - 1), Y = pad + ht - (off + x[key] * scale) / (maxV * scale) * ht; i ? gctx.lineTo(X, Y) : gctx.moveTo(X, Y); });
    gctx.stroke();
  };
  plot('v', '#22e0ff', 1);
  gctx.strokeStyle = '#d62728'; gctx.lineWidth = 1.2; gctx.beginPath();
  h.forEach((x, i) => { const X = pad + w * i / (n - 1), Y = pad + ht / 2 - x.cte / (2 * maxCte) * ht; i ? gctx.lineTo(X, Y) : gctx.moveTo(X, Y); }); gctx.stroke();
  gctx.strokeStyle = '#b6ff5c'; gctx.beginPath();
  h.forEach((x, i) => { const X = pad + w * i / (n - 1), Y = pad + ht - x.brake / 100 * ht; i ? gctx.lineTo(X, Y) : gctx.moveTo(X, Y); }); gctx.stroke();
  gctx.fillStyle = '#94a0ba'; gctx.font = '9px Inter';
  gctx.fillText('speed / CTE / brake', pad, 12);
}

// ---------------------------------------------------------------- UI
function setMode(m) {
  state.mode = m;
  document.querySelectorAll('.modes button').forEach(b => b.classList.toggle('active', b.dataset.mode === m));
  $('mode-label').textContent = { manual: 'MANUAL', pp: 'PID · PP', stanley: 'PID · STANLEY', mpc: 'MPC', f1: 'F1 IMITATION', fly: 'FLYWIRE' }[m];
  $('mode-hint').textContent = {
    manual: 'Keyboard drive: W throttle, S brake, A/D steer. Uses torque/brake actuator values.',
    pp: 'PID pure pursuit on the real FSUK line. Speed PID + physical actuator request.',
    stanley: 'PID Stanley: heading error plus cross-track term.',
    mpc: 'Sampling MPC: tentacle fan, tracking/heading/comfort/soft cost, hard corridor check.',
    f1: 'OpenF1 behaviour-cloning model for throttle/brake + PP steering stabiliser.',
    fly: 'FlyWire Kenyon/CX-inspired readout on the FSUK line.',
  }[m];
  state.tentacles = [];
}

function bindSlider(id, key, fmt) {
  const el = $(id), out = $('v-' + id);
  const sync = () => { const v = +el.value; out.textContent = fmt(v); if (key === 'speed') state.targetSpeed = v; else if (key === 'horizon') state.horizon = v; else if (key === 'tents') state.nTents = Math.round(v); else if (key === 'wt') state.weights.track = v; else if (key === 'wh') state.weights.head = v; else if (key === 'ws') state.weights.soft = v; };
  el.addEventListener('input', sync); sync();
}

document.querySelectorAll('.modes button').forEach(b => b.addEventListener('click', () => setMode(b.dataset.mode)));
$('play').addEventListener('click', e => { state.playing = !state.playing; e.target.textContent = state.playing ? 'Pause' : 'Play'; });
$('reset').addEventListener('click', resetCar);
window.addEventListener('keydown', e => {
  if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp') state.manual.throttle = 1;
  if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown' || e.key === ' ') state.manual.brake = 1;
  if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft') state.manual.left = 1;
  if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') state.manual.right = 1;
});
window.addEventListener('keyup', e => {
  if (e.key === 'w' || e.key === 'W' || e.key === 'ArrowUp') state.manual.throttle = 0;
  if (e.key === 's' || e.key === 'S' || e.key === 'ArrowDown' || e.key === ' ') state.manual.brake = 0;
  if (e.key === 'a' || e.key === 'A' || e.key === 'ArrowLeft') state.manual.left = 0;
  if (e.key === 'd' || e.key === 'D' || e.key === 'ArrowRight') state.manual.right = 0;
});

function resetCar() {
  const p = state.path[0], b = state.path[1];
  state.car = { x: p[0], y: p[1], yaw: Math.atan2(b[1] - p[1], b[0] - p[0]), v: 0 };
  state.steer = 0; state.trail = []; state.history = []; state.t = 0; state.lastAct = null;
}

function updateHud() {
  const a = state.lastAct; if (!a) return;
  $('a-speed').textContent = a.speedCmd.toFixed(1);
  $('a-accel').textContent = a.accel.toFixed(1);
  $('a-steer').textContent = a.steerDeg.toFixed(1);
  $('a-torque').textContent = a.torque.toFixed(0);
  $('a-rpm').textContent = a.rpm > 0 ? a.rpm.toFixed(0) : '—';
  $('a-brake').textContent = a.brake.toFixed(0);
  $('act-mode').textContent = a.mode;
  $('s-cte').textContent = (state.cte || 0).toFixed(2);
  $('s-he').textContent = (state.he || 0).toFixed(2);
  $('s-v').textContent = state.car.v.toFixed(1);
  const lap = Math.floor(state.t / 40);
  $('s-lap').textContent = lap + ' / ' + (state.idx || 0);
}

async function load() {
  const [track, f1, fly] = await Promise.all([
    fetch('track.json').then(r => r.json()),
    fetch('f1_model.json').then(r => r.json()),
    fetch('fly_model.json').then(r => r.json()),
  ]);
  state.track = track; state.path = track.raceline; state.f1 = f1; state.fly = fly;
  state.length = state.path.reduce((s, p, i) => s + Math.hypot(state.path[(i + 1) % state.path.length][0] - p[0], state.path[(i + 1) % state.path.length][1] - p[1]), 0);
  B = bounds(); resize(); resetCar();
  bindSlider('speed', 'speed', v => v.toFixed(1));
  bindSlider('horizon', 'horizon', v => v.toFixed(2));
  bindSlider('tents', 'tents', v => Math.round(v));
  bindSlider('wt', 'wt', v => v.toFixed(1));
  bindSlider('wh', 'wh', v => v.toFixed(1));
  bindSlider('ws', 'ws', v => v.toFixed(1));
  setMode('pp');
  state.loaded = true;
  $('status').textContent = 'real FSUK track · models loaded';
  let last = performance.now();
  const loop = (now) => {
    const dt = Math.min(0.05, Math.max(0.001, (now - last) / 1000)); last = now;
    if (state.playing && state.loaded) { step(dt); updateHud(); }
    draw();
    state.raf = requestAnimationFrame(loop);
  };
  state.raf = requestAnimationFrame(loop);
}

load().catch(e => { $('status').textContent = 'load failed: ' + e.message; console.error(e); });

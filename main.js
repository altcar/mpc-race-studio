import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

const $ = (id) => document.getElementById(id);
const state = {
  playing: true,
  t: 0,
  speed: 6,
  horizon: 1.6,
  nTents: 15,
  weights: { track: 6, head: 2.5, comfort: 0.35, soft: 4 },
  path: [], track: null, trackLength: 0,
  car: { x: 0, y: 0, yaw: 0 },
  selected: 0,
  lastSteer: 0,
  showAll: true,
};

// ---------------------------------------------------------------- geometry
function smoother(points, n) {
  if (points.length <= n) return points;
  return Array.from({ length: n }, (_, i) =>
    points[Math.round(i * (points.length - 1) / (n - 1))]);
}

function toWorld(p, scale, cx, cy) {
  return new THREE.Vector3((p[0] - cx) * scale, 0.05, (p[1] - cy) * scale);
}

function nearest(path, x, y, hint = -1) {
  const n = path.length;
  let best = hint >= 0 ? hint : 0, bd = Infinity;
  if (hint < 0) {
    for (let i = 0; i < n; i++) {
      const dx = path[i][0] - x, dy = path[i][1] - y;
      const d = dx * dx + dy * dy;
      if (d < bd) { bd = d; best = i; }
    }
    return best;
  }
  for (let k = -20; k <= 20; k++) {
    const i = (hint + k + n) % n;
    const dx = path[i][0] - x, dy = path[i][1] - y;
    const d = dx * dx + dy * dy;
    if (d < bd) { bd = d; best = i; }
  }
  return best;
}

function pathYaw(path, i) {
  const n = path.length;
  const a = path[(i - 1 + n) % n], b = path[(i + 1) % n];
  return Math.atan2(b[1] - a[1], b[0] - a[0]);
}

function wrap(a) {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
}

// ---------------------------------------------------------------- three.js
const container = $('three');
const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(container.clientWidth, container.clientHeight);
container.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.fog = new THREE.FogExp2(0x07090f, 0.035);

const camera = new THREE.PerspectiveCamera(42, container.clientWidth / container.clientHeight, 0.1, 200);
camera.position.set(0, 11, 14);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.target.set(0, 0, 0);
controls.maxPolarAngle = Math.PI * 0.47;

scene.add(new THREE.AmbientLight(0x9fb4ff, 0.65));
const key = new THREE.DirectionalLight(0xffffff, 1.4);
key.position.set(8, 16, 6);
scene.add(key);
const rim = new THREE.PointLight(0x22e0ff, 25, 30);
rim.position.set(-8, 4, -6);
scene.add(rim);
const magenta = new THREE.PointLight(0xff3ea5, 18, 24);
magenta.position.set(6, 3, 8);
scene.add(magenta);

const grid = new THREE.GridHelper(34, 34, 0x223047, 0x121a28);
grid.position.y = -0.02;
scene.add(grid);

const tentacleGroup = new THREE.Group();
scene.add(tentacleGroup);

const carGroup = new THREE.Group();
scene.add(carGroup);

function makeCar() {
  const body = new THREE.Mesh(
    new THREE.BoxGeometry(0.42, 0.16, 0.72),
    new THREE.MeshStandardMaterial({ color: 0xff6a00, metalness: 0.4, roughness: 0.3,
      emissive: 0x351000, emissiveIntensity: 0.8 }));
  body.position.y = 0.18;
  carGroup.add(body);
  const nose = new THREE.Mesh(
    new THREE.ConeGeometry(0.14, 0.34, 4),
    new THREE.MeshStandardMaterial({ color: 0xffd166, emissive: 0x442200 }));
  nose.rotation.x = Math.PI / 2;
  nose.position.set(0, 0.18, 0.5);
  carGroup.add(nose);
  const glow = new THREE.PointLight(0xff7a00, 7, 4);
  glow.position.y = 0.4;
  carGroup.add(glow);
}

// ---------------------------------------------------------------- load track
const scale = 0.095;
let cx = 0, cy = 0;

async function load() {
  const data = await (await fetch('track.json')).json();
  state.track = data;
  const all = [...data.raceline, ...(data.cones || []).map(c => [c[1], c[2]])];
  const xs = all.map(p => p[0]), ys = all.map(p => p[1]);
  cx = (Math.min(...xs) + Math.max(...xs)) / 2;
  cy = (Math.min(...ys) + Math.max(...ys)) / 2;
  const raw = smoother(data.raceline, 340);
  state.path = raw;
  state.trackLength = raw.reduce((acc, p, i) => {
    const q = raw[(i + 1) % raw.length];
    return acc + Math.hypot(q[0] - p[0], q[1] - p[1]);
  }, 0);

  const pts = raw.map(p => toWorld(p, scale, cx, cy));
  const curve = new THREE.CatmullRomCurve3(pts, true, 'catmullrom', 0.1);
  const tube = new THREE.Mesh(
    new THREE.TubeGeometry(curve, 500, 0.075, 8, true),
    new THREE.MeshStandardMaterial({ color: 0x0a3340, emissive: 0x22e0ff,
      emissiveIntensity: 0.55, metalness: 0.2, roughness: 0.5 }));
  tube.position.y = 0.02;
  scene.add(tube);

  const centre = new THREE.Line(
    new THREE.BufferGeometry().setFromPoints(
      smoother(data.centerline, 200).map(p => toWorld(p, scale, cx, cy))),
    new THREE.LineDashedMaterial({ color: 0x7a86a0, dashSize: 0.18, gapSize: 0.14,
      transparent: true, opacity: 0.55 }));
  centre.computeLineDistances();
  scene.add(centre);

  for (const [key, col] of [['blue', 0x2c6bff], ['yellow', 0xe0b000]]) {
    const arr = data.boundaries?.[key] || [];
    if (arr.length > 2) {
      const line = new THREE.Line(
        new THREE.BufferGeometry().setFromPoints(
          smoother(arr, 220).map(p => toWorld(p, scale, cx, cy))),
        new THREE.LineBasicMaterial({ color: col, transparent: true, opacity: 0.55 }));
      scene.add(line);
    }
  }

  // cones as instanced spheres, drawn only if the payload has them
  const cones = data.cones || [];
  if (cones.length) {
    const geo = new THREE.SphereGeometry(0.07, 8, 8);
    for (const c of cones) {
      const col = c[0] === 'blue' ? 0x2c6bff : c[0] === 'yellow' ? 0xe0b000 : 0xff6a00;
      const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: col,
        emissive: col, emissiveIntensity: 0.35 }));
      m.position.copy(toWorld([c[1], c[2]], scale, cx, cy));
      scene.add(m);
    }
  }

  makeCar();
  carAt(0);
  updateAll();
  animate();
}

function carAt(t) {
  const p = state.path;
  const n = p.length;
  const f = (t % 1 + 1) % 1;
  const pos = f * n;
  const i = Math.floor(pos) % n, j = (i + 1) % n;
  const u = pos - Math.floor(pos);
  const x = p[i][0] + (p[j][0] - p[i][0]) * u;
  const y = p[i][1] + (p[j][1] - p[i][1]) * u;
  const yaw = Math.atan2(p[j][1] - p[i][1], p[j][0] - p[i][0]);
  state.car = { x, y, yaw };
  const w = toWorld([x, y], scale, cx, cy);
  carGroup.position.set(w.x, 0.02, w.z);
  carGroup.rotation.y = -yaw + Math.PI / 2;
}

// ---------------------------------------------------------------- MPC fan
function evaluateArc(steer) {
  const path = state.path;
  const n = path.length;
  const dt = 0.1;
  const steps = Math.max(4, Math.round(state.horizon / dt));
  let x = state.car.x, y = state.car.y, yaw = state.car.yaw;
  let idx = nearest(path, x, y);
  let cTrack = 0, cHead = 0, cSoft = 0, cComfort = 0, progress = 0;
  const pts = [];
  const speed = state.speed;
  for (let k = 0; k < steps; k++) {
    yaw += speed / 1.55 * Math.tan(steer) * dt;
    x += speed * Math.cos(yaw) * dt;
    y += speed * Math.sin(yaw) * dt;
    pts.push([x, y]);
    idx = nearest(path, x, y, idx);
    const tx = Math.cos(pathYaw(path, idx)), ty = Math.sin(pathYaw(path, idx));
    const cte = tx * (y - path[idx][1]) - ty * (x - path[idx][0]);
    const he = wrap(pathYaw(path, idx) - yaw);
    cTrack += cte * cte;
    cHead += he * he;
    const soft = Math.max(0, Math.abs(cte) - 0.72 * 1.6);
    cSoft += soft * soft;
    progress = idx;
  }
  cComfort = steer * steer + 0.5 * (steer - state.lastSteer) ** 2;
  const cc = cTrack / steps, ch = cHead / steps, cs = cSoft / steps;
  return {
    steer, pts,
    cost: state.weights.track * cc + state.weights.head * ch +
          state.weights.comfort * cComfort + state.weights.soft * cs,
    cTrack: cc, cHead: ch, cSoft: cs, cComfort, progress,
  };
}

function drawTentacles() {
  tentacleGroup.clear();
  const n = state.nTents;
  const maxSteer = 0.44;
  const arcs = [];
  for (let k = 0; k < n; k++) {
    const steer = -maxSteer + 2 * maxSteer * k / (n - 1);
    arcs.push(evaluateArc(steer));
  }
  let best = 0;
  for (let k = 1; k < arcs.length; k++) if (arcs[k].cost < arcs[best].cost) best = k;
  state.selected = best;
  state.lastSteer = arcs[best].steer;

  for (let k = 0; k < arcs.length; k++) {
    if (!state.showAll && k !== best) continue;
    const pts = arcs[k].pts.map(p => {
      const w = toWorld(p, scale, cx, cy);
      return new THREE.Vector3(w.x, 0.13, w.z);
    });
    if (pts.length < 2) continue;
    const geo = new THREE.BufferGeometry().setFromPoints(pts);
    const mat = k === best
      ? new THREE.LineBasicMaterial({ color: 0xff3ea5, linewidth: 3 })
      : new THREE.LineBasicMaterial({ color: 0x8b93a7, transparent: true, opacity: 0.32 });
    tentacleGroup.add(new THREE.Line(geo, mat));
    if (k === best) {
      const end = new THREE.Mesh(new THREE.SphereGeometry(0.09, 10, 10),
        new THREE.MeshBasicMaterial({ color: 0xff3ea5 }));
      end.position.copy(pts[pts.length - 1]);
      tentacleGroup.add(end);
    }
  }
  updateEquation(arcs[best]);
}

function updateEquation(sel) {
  const w = state.weights;
  const fmt = (x) => (Math.abs(x) < 1e-4 ? x.toExponential(1) : x.toFixed(3));
  const tex = `\\begin{aligned}
J &= ${w.track.toFixed(1)}\\cdot ${fmt(sel.cTrack)}
   + ${w.head.toFixed(1)}\\cdot ${fmt(sel.cHead)}\\\\
  &\\quad + ${w.comfort.toFixed(2)}\\cdot ${fmt(sel.cComfort)}
   + ${w.soft.toFixed(1)}\\cdot ${fmt(sel.cSoft)}\\\\
  &= ${sel.cost.toFixed(3)}
\\end{aligned}`;
  if (window.katex) katex.render(tex, $('equation'), { throwOnError: false, displayMode: true });
  $('selected-chip').textContent = `arc ${state.selected + 1}`;

  const comps = [
    ['tracking', w.track * sel.cTrack, ''],
    ['heading', w.head * sel.cHead, ''],
    ['comfort', w.comfort * sel.cComfort, ''],
    ['soft', w.soft * sel.cSoft, ''],
    ['total', sel.cost, 'total'],
  ];
  const max = Math.max(...comps.map(c => Math.abs(c[1])), 1e-6);
  $('cost-bars').innerHTML = comps.map(([name, val, cls]) =>
    `<div class="bar ${cls}"><span>${name}</span>
      <div class="track"><div class="fill" style="width:${Math.max(1, 100 * Math.abs(val) / max)}%"></div></div>
      <span>${val.toFixed(3)}</span></div>`).join('');
}

// ---------------------------------------------------------------- UI
function bindRange(id, key, fmt) {
  const el = $(id);
  const out = $('v-' + id.replace('w-', ''));
  const sync = () => {
    const v = parseFloat(el.value);
    if (key === 'track') state.weights.track = v;
    if (key === 'head') state.weights.head = v;
    if (key === 'comfort') state.weights.comfort = v;
    if (key === 'soft') state.weights.soft = v;
    if (key === 'tents') state.nTents = Math.round(v);
    if (key === 'speed') state.speed = v;
    if (key === 'horizon') state.horizon = v;
    if (out) out.textContent = fmt(v);
    if (key === 'tents') $('stat-tents').textContent = Math.round(v);
    if (key === 'speed') $('stat-speed').textContent = v.toFixed(1);
    if (key === 'horizon') $('stat-horizon').textContent = v.toFixed(1);
    if (key === 'tents') $('v-tents').textContent = Math.round(v);
    updateAll();
  };
  el.addEventListener('input', sync);
  sync();
}

function updateAll() {
  if (!state.path.length) return;
  drawTentacles();
}

function animate() {
  requestAnimationFrame(animate);
  if (state.playing && state.path.length) {
    state.t += (state.speed / state.trackLength) * 0.016;
    carAt(state.t);
    if (Math.random() < 0.25) drawTentacles();
  }
  controls.update();
  renderer.render(scene, camera);
}

window.addEventListener('resize', () => {
  const w = container.clientWidth, h = container.clientHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  renderer.setSize(w, h);
});

$('play').addEventListener('click', (e) => {
  state.playing = !state.playing;
  e.target.textContent = state.playing ? 'Pause' : 'Play';
});
$('reset').addEventListener('click', () => {
  controls.target.set(0, 0, 0);
  camera.position.set(0, 11, 14);
});
$('show-all').addEventListener('change', (e) => {
  state.showAll = e.target.checked;
  drawTentacles();
});

// Slider bindings: ids and keys are explicit so labels stay readable.
bindRange('w-track', 'track', v => v.toFixed(1));
bindRange('w-head', 'head', v => v.toFixed(1));
bindRange('w-comfort', 'comfort', v => v.toFixed(2));
bindRange('w-soft', 'soft', v => v.toFixed(1));
bindRange('n-tents', 'tents', v => Math.round(v));
bindRange('speed', 'speed', v => v.toFixed(1));
bindRange('horizon', 'horizon', v => v.toFixed(1));

load().catch(err => {
  console.error(err);
  container.innerHTML = `<div style="padding:40px;color:#ff6a8a">
    Could not load track.json: ${err.message}</div>`;
});

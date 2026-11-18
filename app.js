// 360 home walk-through: equirectangular panoramas, floor-ring hotspots, eased "move-in" transitions.
// World frame = floor-plan frame: yaw 0 looks north (-Z), +90 looks east (+X). Each panorama carries
// `rot`, the plan heading of its own image centre, so a panorama's local yaw = world yaw - rot.
import * as THREE from 'three';

const DEG = Math.PI / 180;
const ROOMS = {
  living:  { name: 'Living room',      src: 'pano/living.jpg',  rot: 127.8, plan: [0, 0],        size: [5.0, 4.2], floor: -1.5,  box: [5.0, 4.0, 1.3] },
  kitchen: { name: 'Kitchen & dining', src: 'pano/kitchen.jpg', rot: 115.2, plan: [6, 0],        size: [4.4, 4.0], floor: -1.45, box: [3.8, 3.4, 1.5] },
  bedroom: { name: 'Bedroom suite',    src: 'pano/bedroom.jpg', rot: -61.2, plan: [6.57, -5.97], size: [4.4, 3.8], floor: -1.45, box: [3.4, 3.0, 1.25] },
};
const ORDER = ['living', 'kitchen', 'bedroom'];
const LINKS = { living: ['kitchen'], kitchen: ['living', 'bedroom'], bedroom: ['kitchen'] };
const START = { room: 'living', yaw: 127.8 - (innerHeight > innerWidth ? 36 : 28), pitch: -6 };   // doorway + long view in frame
const RING_DIST = 2.6;                                           // metres from the camera to a floor ring
const FOV_MIN = 30, FOV_MAX = 100;

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);   // easeInOutCubic
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrap180 = a => ((((a + 180) % 360) + 360) % 360) - 180;
const heading = (a, b) => { const [ax, az] = ROOMS[a].plan, [bx, bz] = ROOMS[b].plan; return Math.atan2(bx - ax, -(bz - az)) / DEG; };
const dirOf = deg => new THREE.Vector3(Math.sin(deg * DEG), 0, -Math.cos(deg * DEG));
const isPortrait = () => innerHeight > innerWidth;

// ---------- renderer ----------
const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(75, 1, 0.05, 100);
camera.rotation.order = 'YXZ';

const state = {
  ready: false, busy: false, room: START.room, yaw: START.yaw, pitch: START.pitch,
  fov: isPortrait() ? 90 : 72, mode: 'sphere', transitions: [], lastTransition: null, renderer: '',
};

// ---------- panorama material: samples the equirect by direction from the panorama's own centre ----------
const VS = /* glsl */`
varying vec3 vWorld;
void main() {
  vec4 w = modelMatrix * vec4(position, 1.0);
  vWorld = w.xyz;
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FS = /* glsl */`
uniform sampler2D map;
uniform vec3 center;
uniform float rot;
uniform float opacity;
varying vec3 vWorld;
const float PI = 3.141592653589793;
void main() {
  vec3 d = normalize(vWorld - center);
  float psi = atan(d.x, -d.z) - rot;
  float u = fract(0.5 + psi / (2.0 * PI));
  float v = 0.5 + asin(clamp(d.y, -1.0, 1.0)) / PI;
  gl_FragColor = vec4(texture2D(map, vec2(u, v)).rgb, opacity);
}`;
const panoMaterial = () => new THREE.ShaderMaterial({
  uniforms: { map: { value: null }, center: { value: new THREE.Vector3() }, rot: { value: 0 }, opacity: { value: 1 } },
  vertexShader: VS, fragmentShader: FS, side: THREE.BackSide, depthTest: false, depthWrite: false, transparent: true,
});
const sphereGeo = new THREE.SphereGeometry(10, 64, 32);
const boxGeos = {};
// Room proxy: a box around the camera with the room's rough extents. With real assets this is the FBX.
function boxGeo(id) {
  if (!boxGeos[id]) {
    const r = ROOMS[id], [hx, hz, ceil] = r.box;
    const g = new THREE.BoxGeometry(hx * 2, ceil - r.floor, hz * 2);
    g.translate(0, (ceil + r.floor) / 2, 0);
    boxGeos[id] = g;
  }
  return boxGeos[id];
}
const meshA = new THREE.Mesh(sphereGeo, panoMaterial());
const meshB = new THREE.Mesh(sphereGeo, panoMaterial());
meshA.renderOrder = 0; meshB.renderOrder = 1; meshB.visible = false;
meshA.frustumCulled = meshB.frustumCulled = false;
scene.add(meshA, meshB);

function placePano(mesh, id, center) {
  const r = ROOMS[id];
  mesh.geometry = state.mode === 'proxy' ? boxGeo(id) : sphereGeo;
  mesh.position.copy(center);
  mesh.rotation.y = -r.rot * DEG;
  const u = mesh.material.uniforms;
  u.map.value = textures[id];
  u.center.value.copy(center);
  u.rot.value = r.rot * DEG;
}

// ---------- textures: decoded off the main thread and uploaded to the GPU before they are needed ----------
const loader = new THREE.TextureLoader();
const textures = {}, loading = {};
function loadTex(id) {
  if (!loading[id]) {
    loading[id] = loader.loadAsync(ROOMS[id].src).then(async t => {
      if (t.image && t.image.decode) { try { await t.image.decode(); } catch (e) { /* already decoded */ } }
      t.generateMipmaps = false;
      t.minFilter = THREE.LinearFilter;
      t.magFilter = THREE.LinearFilter;
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.ClampToEdgeWrapping;
      t.needsUpdate = true;
      renderer.initTexture(t);
      textures[id] = t;
      return t;
    });
  }
  return loading[id];
}
const preloadNeighbours = id => LINKS[id].reduce((p, n) => p.then(() => loadTex(n)), Promise.resolve());

// ---------- hotspots: glowing floor rings + a label ----------
const ringGeo = new THREE.PlaneGeometry(1.1, 1.1);
const RING_FS = /* glsl */`
uniform float time; uniform float alpha; uniform float hover;
varying vec2 vUv;
void main() {
  vec2 p = vUv * 2.0 - 1.0; float r = length(p);
  float ring = smoothstep(0.075, 0.025, abs(r - 0.52));
  float glow = exp(-pow((r - 0.52) / 0.2, 2.0)) * (0.38 + 0.25 * hover);
  float ph = fract(time * 0.55);
  float pulse = smoothstep(0.05, 0.0, abs(r - (0.52 + ph * 0.42))) * (1.0 - ph) * 0.55;
  float core = smoothstep(0.17, 0.11, r) * 0.85;
  float a = clamp(ring + glow + pulse + core, 0.0, 1.0) * alpha;
  gl_FragColor = vec4(mix(vec3(1.0), vec3(1.0, 0.86, 0.66), 0.35 + 0.4 * hover), a);
}`;
const RING_VS = 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }';
let hotspots = [];
const hsLayer = document.getElementById('hotspots');
const ARROW = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14M13 6l6 6-6 6"/></svg>';
function buildHotspots(id) {
  for (const h of hotspots) { scene.remove(h.mesh); h.mesh.material.dispose(); h.el.remove(); }
  hotspots = LINKS[id].map(to => {
    const d = dirOf(heading(id, to)).multiplyScalar(RING_DIST);
    const mat = new THREE.ShaderMaterial({
      uniforms: { time: { value: 0 }, alpha: { value: 0 }, hover: { value: 0 } },
      vertexShader: RING_VS, fragmentShader: RING_FS, transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide,
    });
    const mesh = new THREE.Mesh(ringGeo, mat);
    mesh.position.set(d.x, ROOMS[id].floor, d.z);
    mesh.rotation.x = -Math.PI / 2;
    mesh.renderOrder = 2;
    mesh.userData.to = to;
    scene.add(mesh);
    const el = document.createElement('button');
    el.className = 'hs'; el.dataset.to = to;
    el.innerHTML = `<span>${ROOMS[to].name}</span>${ARROW}`;
    el.addEventListener('click', e => { e.stopPropagation(); goTo(to); });
    el.addEventListener('pointerenter', () => { h.hover = 1; });
    el.addEventListener('pointerleave', () => { h.hover = 0; });
    hsLayer.appendChild(el);
    const h = { mesh, el, to, hover: 0, born: performance.now() };
    return h;
  });
}
const tmpV = new THREE.Vector3();
function updateHotspots(now, fadeOut) {
  const W = innerWidth, H = innerHeight;
  for (const h of hotspots) {
    const a = Math.min(1, (now - h.born) / 350) * (1 - fadeOut);
    const u = h.mesh.material.uniforms;
    u.time.value = now / 1000; u.alpha.value = a; u.hover.value += (h.hover - u.hover.value) * 0.2;
    tmpV.copy(h.mesh.position).applyMatrix4(camera.matrixWorldInverse);
    const behind = tmpV.z > -0.2;
    tmpV.copy(h.mesh.position).project(camera);
    const x = (tmpV.x * 0.5 + 0.5) * W, y = (-tmpV.y * 0.5 + 0.5) * H;
    const off = behind || x < -80 || x > W + 80 || y < -40 || y > H + 60;
    h.el.style.transform = `translate(${x.toFixed(1)}px, ${(y - 26).toFixed(1)}px) translate(-50%, -100%)`;
    h.el.style.opacity = off ? 0 : a;
    h.el.style.pointerEvents = off || a < 0.5 ? 'none' : 'auto';
    h.el.classList.toggle('hot', h.hover > 0.5);
  }
}

// ---------- floor plan ----------
const plan = document.getElementById('plan');
const SVGNS = 'http://www.w3.org/2000/svg';
const svgEl = (tag, attrs, parent) => { const e = document.createElementNS(SVGNS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (parent) parent.appendChild(e); return e; };
plan.setAttribute('viewBox', '-3.2 -8.6 12.6 11.4');
const planRects = {};
for (const [a, list] of Object.entries(LINKS)) for (const b of list) if (a < b) {
  svgEl('line', { class: 'lk', x1: ROOMS[a].plan[0], y1: ROOMS[a].plan[1], x2: ROOMS[b].plan[0], y2: ROOMS[b].plan[1] }, plan);
}
for (const id of ORDER) {
  const r = ROOMS[id], [x, z] = r.plan, [w, d] = r.size;
  const rect = svgEl('rect', { class: 'rm', x: x - w / 2, y: z - d / 2, width: w, height: d, rx: 0.35 }, plan);
  rect.addEventListener('click', () => goTo(id));
  planRects[id] = rect;
  svgEl('text', { x: x - w / 2 + 0.3, y: z - d / 2 + 0.95 }, plan).textContent = r.name.split(' ')[0];
  svgEl('circle', { class: 'st', cx: x, cy: z, r: 0.16 }, plan);
}
const defs = svgEl('defs', {}, plan);
const grad = svgEl('radialGradient', { id: 'cone', cx: 0, cy: 0, r: 3, gradientUnits: 'userSpaceOnUse' }, defs);
svgEl('stop', { offset: 0, 'stop-color': '#f1c789', 'stop-opacity': 0.75 }, grad);
svgEl('stop', { offset: 1, 'stop-color': '#f1c789', 'stop-opacity': 0 }, grad);
const marker = svgEl('g', {}, plan);
const cone = svgEl('path', { fill: 'url(#cone)' }, marker);
svgEl('circle', { r: 0.42, fill: '#fff', stroke: '#f1c789', 'stroke-width': 0.14 }, marker);
let markerPos = [...ROOMS[START.room].plan];
function updatePlan() {
  // cone width follows the horizontal field of view
  const hf = 2 * Math.atan(Math.tan(camera.fov * DEG / 2) * camera.aspect) / 2, R = 3;
  cone.setAttribute('d', `M0,0 L${(-Math.sin(hf) * R).toFixed(3)},${(-Math.cos(hf) * R).toFixed(3)} A${R},${R} 0 0 1 ${(Math.sin(hf) * R).toFixed(3)},${(-Math.cos(hf) * R).toFixed(3)} Z`);
  marker.setAttribute('transform', `translate(${markerPos[0].toFixed(3)},${markerPos[1].toFixed(3)}) rotate(${state.yaw.toFixed(2)})`);
}
function markCurrent(id) { for (const k of ORDER) planRects[k].classList.toggle('cur', k === id); }

// ---------- room label ----------
const roomName = document.getElementById('roomName'), roomIdx = document.getElementById('roomIdx');
function setRoomLabel(id) {
  roomName.classList.add('swap');
  setTimeout(() => { roomName.textContent = ROOMS[id].name; roomIdx.textContent = `${ORDER.indexOf(id) + 1} of ${ORDER.length}`; roomName.classList.remove('swap'); }, 180);
}

// ---------- the move-in transition ----------
let trans = null;
function startTransition(to) {
  const from = state.room, psi = heading(from, to), dir = dirOf(psi);
  const D = state.mode === 'proxy' ? 2.4 : 2.0;                // dolly distance inside the current panorama
  const dyaw = wrap180(psi - state.yaw);
  trans = {
    from, to, dir, D, yaw0: state.yaw, yaw1: state.yaw + dyaw, pitch0: state.pitch, pitch1: -6, fov0: state.fov,
    t0: performance.now(), dur: 1200 + Math.min(400, Math.abs(dyaw) * 2.5), deltas: [], labelSwapped: false, fixedT: undefined,
  };
  placePano(meshB, to, dir.clone().multiplyScalar(D));      // next panorama sits at the end of the move
  meshB.material.uniforms.opacity.value = 0;
  meshB.visible = true;
  return new Promise(res => { trans.done = res; });
}
function applyTransition(t) {
  const T = trans;
  const turn = ease(clamp(t / 0.5, 0, 1));
  state.yaw = lerp(T.yaw0, T.yaw1, turn);
  state.pitch = lerp(T.pitch0, T.pitch1, turn);
  const move = ease(clamp((t - 0.1) / 0.9, 0, 1));
  camera.position.copy(T.dir).multiplyScalar(T.D * move);
  camera.fov = T.fov0 - Math.min(16, T.fov0 * 0.2) * Math.sin(Math.PI * ease(t));   // narrow, then settle back
  meshB.material.uniforms.opacity.value = smooth(0.26, 0.82, t);
  const a = ROOMS[T.from].plan, b = ROOMS[T.to].plan;
  markerPos = [lerp(a[0], b[0], move), lerp(a[1], b[1], move)];
  if (!T.labelSwapped && t > 0.45) { T.labelSwapped = true; setRoomLabel(T.to); markCurrent(T.to); }
  return smooth(0, 0.18, t);
}
function endTransition() {
  const T = trans, to = T.to;
  state.room = to;
  placePano(meshA, to, new THREE.Vector3());
  meshA.material.uniforms.opacity.value = 1;
  meshB.visible = false;
  camera.position.set(0, 0, 0);
  state.yaw = ((T.yaw1 % 360) + 360) % 360;
  state.pitch = T.pitch1;
  camera.fov = state.fov;
  markerPos = [...ROOMS[to].plan];
  buildHotspots(to);
  const d = T.deltas.slice(1);
  const rec = { from: T.from, to, mode: state.mode, ms: Math.round(performance.now() - T.t0), frames: d.length, deltas: d };
  state.lastTransition = rec; state.transitions.push(rec);
  trans = null; state.busy = false;
  if (gyro) gyro.a0 = null;
  preloadNeighbours(to);
  T.done(rec);
}
function route(from, to) {   // breadth-first path through linked rooms
  const prev = { [from]: null }, q = [from];
  while (q.length) { const c = q.shift(); if (c === to) break; for (const n of LINKS[c]) if (!(n in prev)) { prev[n] = c; q.push(n); } }
  const path = []; for (let c = to; c && c !== from; c = prev[c]) path.unshift(c);
  return path;
}
let queue = Promise.resolve();
function goTo(target) {
  if (state.busy || target === state.room || !state.ready) return queue;
  state.busy = true;
  hideHint();
  queue = (async () => {
    for (const hop of route(state.room, target)) {
      const h = hotspots.find(x => x.to === hop);
      if (!textures[hop]) { h && h.el.classList.add('wait'); await loadTex(hop); }
      await startTransition(hop);
      state.busy = true;
    }
    state.busy = false;
  })();
  return queue;
}

// ---------- look controls: drag, inertia, wheel / pinch zoom, tap-to-walk, optional motion ----------
const pointers = new Map();
let drag = null, pinch = null, moved = 0, lastMoveT = 0, vel = { y: 0, p: 0 };
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
function pickHotspot(x, y) {
  ndc.set((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const hit = ray.intersectObjects(hotspots.map(h => h.mesh), false)[0];
  return hit ? hotspots.find(h => h.mesh === hit.object) : null;
}
canvas.addEventListener('pointerdown', e => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  hideHint();
  if (pointers.size === 1) { drag = { x: e.clientX, y: e.clientY }; moved = 0; vel = { y: 0, p: 0 }; }
  else if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), fov: state.fov }; drag = null; moved = 99; }
  canvas.classList.add('grabbing');
});
canvas.addEventListener('pointermove', e => {
  if (!pointers.has(e.pointerId)) {
    if (e.pointerType === 'mouse') { const h = pickHotspot(e.clientX, e.clientY); for (const x of hotspots) x.hover = x === h ? 1 : 0; canvas.classList.toggle('over-hs', !!h); }
    return;
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pinch && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    state.fov = clamp(pinch.fov * pinch.d / Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)), FOV_MIN, FOV_MAX);
    return;
  }
  if (drag && !trans) {
    const k = state.fov / innerHeight, dx = e.clientX - drag.x, dy = e.clientY - drag.y, now = performance.now();
    moved += Math.abs(dx) + Math.abs(dy);
    state.yaw -= dx * k; state.pitch = clamp(state.pitch + dy * k, -85, 85);
    const dt = Math.max(8, now - lastMoveT);
    vel = { y: (-dx * k) / dt, p: (dy * k) / dt }; lastMoveT = now;
    drag.x = e.clientX; drag.y = e.clientY;
  }
});
const endPointer = e => {
  if (!pointers.has(e.pointerId)) return;
  pointers.delete(e.pointerId);
  if (pointers.size < 2) pinch = null;
  if (pointers.size === 0) {
    if (drag && moved < 6 && e.type === 'pointerup') { const h = pickHotspot(e.clientX, e.clientY); if (h) goTo(h.to); }
    if (performance.now() - lastMoveT > 90) vel = { y: 0, p: 0 };
    drag = null; canvas.classList.remove('grabbing');
  } else if (pointers.size === 1) { const p = [...pointers.values()][0]; drag = { x: p.x, y: p.y }; }
};
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('wheel', e => { e.preventDefault(); state.fov = clamp(state.fov + e.deltaY * 0.04, FOV_MIN, FOV_MAX); hideHint(); }, { passive: false });
addEventListener('keydown', e => {
  if (e.key === 'ArrowLeft') state.yaw -= 6; else if (e.key === 'ArrowRight') state.yaw += 6;
  else if (e.key === 'ArrowUp') state.pitch = clamp(state.pitch + 5, -85, 85); else if (e.key === 'ArrowDown') state.pitch = clamp(state.pitch - 5, -85, 85);
});

let gyro = null;
const btnGyro = document.getElementById('btnGyro');
function onOrient(e) {
  if (!gyro || e.alpha == null || trans) return;
  if (gyro.a0 == null) { gyro.a0 = e.alpha; gyro.yaw0 = state.yaw; }
  state.yaw = gyro.yaw0 - wrap180(e.alpha - gyro.a0);
  state.pitch = clamp(e.beta - 90, -85, 85);
}
if ('DeviceOrientationEvent' in window && matchMedia('(pointer: coarse)').matches) {
  btnGyro.hidden = false;
  btnGyro.addEventListener('click', async () => {
    if (gyro) { gyro = null; btnGyro.classList.remove('on'); return; }
    if (typeof DeviceOrientationEvent.requestPermission === 'function') {
      const r = await DeviceOrientationEvent.requestPermission().catch(() => 'denied');
      if (r !== 'granted') return;
    }
    gyro = { a0: null, yaw0: state.yaw };
    addEventListener('deviceorientation', onOrient);
    btnGyro.classList.add('on');
  });
}
const btnFull = document.getElementById('btnFull');
if (!document.documentElement.requestFullscreen) btnFull.hidden = true;
btnFull.addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen().catch(() => {}); });

// projection toggle: sphere vs room-proxy (parallax) transitions
for (const b of document.querySelectorAll('.seg button')) b.addEventListener('click', () => {
  if (trans) return;
  state.mode = b.dataset.mode;
  for (const x of document.querySelectorAll('.seg button')) x.classList.toggle('on', x === b);
  placePano(meshA, state.room, new THREE.Vector3());
});

const hint = document.getElementById('hint');
let hintTimer = setTimeout(hideHint, 7000);
function hideHint() { hint.classList.add('gone'); clearTimeout(hintTimer); }

// ---------- resize + loop ----------
function resize() {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);

let last = performance.now();
function frame(now) {
  const dt = Math.min(100, now - last); last = now;
  let fadeOut = 0;
  if (trans) {
    trans.deltas.push(dt);
    const t = trans.fixedT ?? clamp((now - trans.t0) / trans.dur, 0, 1);
    fadeOut = applyTransition(t);
    if (t >= 1 && trans.fixedT === undefined) { endTransition(); fadeOut = 0; }
  } else {
    if (!drag && (Math.abs(vel.y) + Math.abs(vel.p)) > 1e-4) {
      state.yaw += vel.y * dt; state.pitch = clamp(state.pitch + vel.p * dt, -85, 85);
      const f = Math.pow(0.9, dt / 16.7); vel.y *= f; vel.p *= f;
    }
    camera.fov += (state.fov - camera.fov) * Math.min(1, dt / 90);
  }
  camera.rotation.set(state.pitch * DEG, -state.yaw * DEG, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld();
  updateHotspots(now, fadeOut);
  updatePlan();
  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// ---------- boot ----------
(async () => {
  resize();
  const gl = renderer.getContext(), dbg = gl.getExtension('WEBGL_debug_renderer_info');
  state.renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  await loadTex(START.room);
  placePano(meshA, START.room, new THREE.Vector3());
  camera.fov = state.fov;
  buildHotspots(START.room);
  markCurrent(START.room);
  requestAnimationFrame(t => { last = t; frame(t); });
  state.ready = true;
  requestAnimationFrame(() => document.getElementById('loader').classList.add('done'));
  preloadNeighbours(START.room).then(() => loadTex('bedroom'));
})();

// Hooks used by the automated checks (frame timing, deterministic filmstrip frames).
window.__tour = {
  state, goTo, rooms: ROOMS,
  face(to) { state.yaw = heading(state.room, to); state.pitch = -12; vel = { y: 0, p: 0 }; },
  preview(to, t) { if (!trans) { state.busy = true; startTransition(to); } trans.fixedT = t; },
  finishPreview() { if (trans) { trans.fixedT = undefined; trans.t0 = performance.now() - trans.dur; } },
  texturesReady: () => ORDER.every(id => !!textures[id]),
};

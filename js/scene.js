// The 3D stage: a straight 8-lane track, the sprinters (bones and muscle paths from the recordings), cameras and labels.
// Simulator coordinates are kept: x = running direction (m from the start line), y = up, z = sideways; each runner is
// moved sideways into its lane.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { frameAt } from './data.js?v=20261122042038';

export const LANE_W = 1.22;
export const laneZ = (lane) => (lane - 4.5) * LANE_W;
export const MAX_RUNNERS = 6;
const MAX_PRINTS = 600;
const TRACK_W = 8 * LANE_W;
const X_TREADMILL = 50;
const BONE = new THREE.Color().setRGB(0.93, 0.9, 0.83, THREE.SRGBColorSpace);
const ACT_STOPS = [[0.2, 0.42, 0.86], [0.62, 0.3, 0.7], [0.9, 0.16, 0.14]];

export function activationColor(a, out) {
  const x = Math.min(Math.max(a, 0), 1) * 2;
  const i = Math.min(Math.floor(x), 1), w = x - i;
  const p = ACT_STOPS[i], q = ACT_STOPS[i + 1];
  return out.setRGB(p[0] + (q[0] - p[0]) * w, p[1] + (q[1] - p[1]) * w, p[2] + (q[2] - p[2]) * w, THREE.SRGBColorSpace);
}

function canvasTexture(w, h, draw, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function textPlane(text, height, { color = '#ffffff', stroke = 'rgba(20,30,20,0.55)', weight = 800 } = {}) {
  const fs = 160;
  const probe = document.createElement('canvas').getContext('2d');
  probe.font = `${weight} ${fs}px "Segoe UI", system-ui, sans-serif`;
  const w = Math.ceil(probe.measureText(text).width + fs * 0.4);
  const tex = canvasTexture(w, Math.ceil(fs * 1.3), (g, W, H) => {
    g.font = `${weight} ${fs}px "Segoe UI", system-ui, sans-serif`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.lineWidth = fs * 0.08; g.strokeStyle = stroke; g.strokeText(text, W / 2, H / 2);
    g.fillStyle = color; g.fillText(text, W / 2, H / 2);
  });
  tex.anisotropy = 8;
  const aspect = tex.image.width / tex.image.height;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(height * aspect, height),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false }));
  return m;
}

// scratch objects of update(): allocated once, so drawing a frame creates no garbage
const _m4 = new THREE.Matrix4(), _q = new THREE.Quaternion(), _q1 = new THREE.Quaternion();
const _pos = new THREE.Vector3(), _sc = new THREE.Vector3(), _up = new THREE.Vector3(0, 1, 0), _d = new THREE.Vector3();
const _col = new THREE.Color(), _grey = new THREE.Color().setRGB(0.78, 0.78, 0.8, THREE.SRGBColorSpace);
const _vA = new THREE.Vector3(), _vB = new THREE.Vector3();

// Marks the first n instances of an instanced attribute for upload. Without a range three.js sends the whole
// buffer (every instance the mesh has room for) on every frame, also when few or none are drawn.
function upload(attr, n) {
  if (!attr) return;
  attr.clearUpdateRanges();
  if (n <= 0) return;
  attr.addUpdateRange(0, n * attr.itemSize);
  attr.needsUpdate = true;
}

export class Stage {
  constructor(container, bones) {
    this.container = container;
    const canvas = document.createElement('canvas');
    canvas.className = 'gl';
    container.prepend(canvas);
    const r = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
    // at most 1.5 device pixels per CSS pixel; lowered further (to 1) by lowerQuality() when frames are slow
    this.lowered = 0;
    r.setPixelRatio(this.pixelRatio());
    r.shadowMap.enabled = true;
    r.shadowMap.type = THREE.PCFShadowMap;
    // Refreshed on every drawn frame. Refreshing every other frame made the bones lag one frame behind the muscles in
    // motion: three.js r186 uploads instance matrices once per frame, keyed by a frame counter it advances after
    // projecting the scene, so a shadow caster updated by the previous frame's shadow pass is skipped by the next
    // frame's projection and, without a shadow pass, drawn with last frame's matrices (the muscles cast no shadow and
    // were always current).
    r.shadowMap.autoUpdate = true;
    this.onWake = null;              // set by the app: asks for frames to be drawn for a short while
    r.toneMapping = THREE.NeutralToneMapping;
    r.toneMappingExposure = 1.0;
    this.maxAniso = r.capabilities.getMaxAnisotropy();

    const s = this.scene = new THREE.Scene();
    s.background = canvasTexture(4, 512, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, '#7fb2e5'); gr.addColorStop(0.55, '#c4ddf2'); gr.addColorStop(1, '#e8eff3');
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    });
    s.fog = new THREE.Fog(new THREE.Color('#e3ecf1'), 70, 240);

    this.camera = new THREE.PerspectiveCamera(36, 1, 0.05, 700);
    this.controls = new OrbitControls(this.camera, canvas);
    this.controls.enabled = false;
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI * 0.495;
    this.controls.minDistance = 1.2;
    this.controls.maxDistance = 120;
    this.controls.addEventListener('change', () => this.onWake && this.onWake(800));
    // OrbitControls switches touch scrolling off on the canvas for good; a phone must be able to scroll the page by
    // swiping over the stage unless the Free view is on (setView)
    canvas.style.touchAction = 'pan-y';

    s.add(new THREE.HemisphereLight(new THREE.Color('#eef5ff'), new THREE.Color('#7d8f5c'), 1.5));
    const sun = this.sun = new THREE.DirectionalLight(new THREE.Color('#fff4e2'), 2.6);
    sun.castShadow = true;
    sun.shadow.mapSize.set(1024, 1024);
    const sc = sun.shadow.camera;
    sc.left = -16; sc.right = 16; sc.top = 12; sc.bottom = -12; sc.near = 1; sc.far = 90;
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.025; sun.shadow.radius = 3;
    s.add(sun, sun.target);

    this.buildGround();
    this.buildBones(bones);
    this.buildMuscles();
    this.buildMarkers();

    this.runners = [];
    this.opts = { muscles: true, bones: true, labels: true, footprints: true, tint: false, thickness: 1, highlight: null,
      mode: 'race', shadows: true };
    this.view = 'broadcast';
    this.selected = 0;
    this.focus = new THREE.Vector3(0, 0.95, 0);
    this.spread = 0;
    this.camFrom = null;
    this.camBlend = 1;
    this.lastFocusX = null;
    this.labels = container.querySelector('.labels');
    new ResizeObserver(() => this.resize()).observe(container);
    // a window moved to a monitor with another pixel ratio keeps its size, so the observer above does not fire
    const watchRatio = () => matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      .addEventListener('change', () => { this.resize(); watchRatio(); }, { once: true });
    watchRatio();
    this.resize();
  }

  // device pixels per CSS pixel to draw at: the screen's own, at most 1.5, less the steps taken by lowerQuality()
  pixelRatio() { return Math.max(1, Math.min(window.devicePixelRatio || 1, 1.5) - this.lowered); }

  resize() {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.W = w; this.H = h;   // cached so that per-frame code never reads layout
    // the screen's pixel ratio changes with browser zoom and when the window moves to another monitor
    const pr = this.pixelRatio();
    if (Math.abs(pr - this.renderer.getPixelRatio()) > 1e-3) this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, false);
    if (this.onWake) this.onWake();
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  buildGround() {
    const s = this.scene;
    const grassTex = canvasTexture(256, 256, (g, w, h) => {
      g.fillStyle = '#5d8c3d'; g.fillRect(0, 0, w, h);
      g.fillStyle = '#679a44'; g.fillRect(0, 0, w / 2, h);
      for (let i = 0; i < 1400; i++) {
        g.fillStyle = `rgba(${30 + Math.random() * 40},${70 + Math.random() * 50},${20 + Math.random() * 30},0.18)`;
        g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
    });
    grassTex.wrapS = grassTex.wrapT = THREE.RepeatWrapping;
    grassTex.repeat.set(600 / 10, 300 / 10);
    grassTex.anisotropy = this.maxAniso;
    const grass = new THREE.Mesh(new THREE.PlaneGeometry(600, 300),
      new THREE.MeshStandardMaterial({ map: grassTex, roughness: 1 }));
    grass.rotation.x = -Math.PI / 2;
    grass.position.set(60, 0, 0);
    grass.receiveShadow = true;
    s.add(grass);

    // track: a 10 m tile repeated along x, lane lines along x
    const margin = 0.6, W = TRACK_W + 2 * margin;
    const tex = canvasTexture(1024, 1024, (g, w, h) => {
      g.fillStyle = '#b4513d'; g.fillRect(0, 0, w, h);
      for (let i = 0; i < 9000; i++) {
        const v = Math.random();
        g.fillStyle = v < 0.5 ? 'rgba(90,30,20,0.16)' : 'rgba(230,140,110,0.12)';
        g.fillRect(Math.random() * w, Math.random() * h, 2, 2);
      }
      g.fillStyle = '#f4f1ea';
      const px = h / W;
      for (let k = 0; k <= 8; k++) {
        const z = margin + k * LANE_W;
        g.fillRect(0, z * px - 0.025 * px, w, 0.05 * px);
      }
    });
    tex.wrapS = THREE.RepeatWrapping;
    tex.anisotropy = this.maxAniso;
    const L = 190;
    tex.repeat.set(L / 10, 1);
    const track = new THREE.Mesh(new THREE.PlaneGeometry(L, W), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92 }));
    track.rotation.x = -Math.PI / 2;
    track.position.set(-30 + L / 2, 0.004, 0);
    track.receiveShadow = true;
    s.add(track);

    const lineMat = new THREE.MeshBasicMaterial({ color: new THREE.Color('#f4f1ea'), toneMapped: false });
    const faint = new THREE.MeshBasicMaterial({ color: new THREE.Color('#f4f1ea'), transparent: true, opacity: 0.45, toneMapped: false });
    for (let x = 0; x <= 120; x += 10) {
      const main = x === 0 || x === 100;
      const m = new THREE.Mesh(new THREE.PlaneGeometry(main ? 0.08 : 0.035, TRACK_W), main ? lineMat : faint);
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.008, 0);
      s.add(m);
      if (x > 0 && x <= 110) {
        const lab = textPlane(`${x} m`, 1.15);
        lab.position.set(x, 0.62, -TRACK_W / 2 - 3.2);
        s.add(lab);
        const flat = textPlane(`${x}`, 0.55, { color: 'rgba(255,255,255,0.85)', stroke: 'rgba(0,0,0,0)' });
        flat.rotation.x = -Math.PI / 2;
        flat.position.set(x + 0.55, 0.01, TRACK_W / 2 + 0.45);
        s.add(flat);
      }
    }
    const fin = textPlane('FINISH', 0.9, { color: '#ffffff' });
    fin.position.set(100, 2.25, -TRACK_W / 2 - 3.2);
    s.add(fin);
    for (let k = 1; k <= 8; k++) {
      const n = textPlane(String(k), 0.7, { color: 'rgba(255,255,255,0.9)', stroke: 'rgba(0,0,0,0)' });
      n.rotation.x = -Math.PI / 2; n.rotation.z = -Math.PI / 2;
      n.position.set(-1.0, 0.01, laneZ(k));
      s.add(n);
    }
    // a low wall and stands on the camera side, a fence on the far side, for depth
    const wall = new THREE.Mesh(new THREE.BoxGeometry(L, 1.0, 0.3), new THREE.MeshStandardMaterial({ color: new THREE.Color('#2c4a6e'), roughness: 0.7 }));
    wall.position.set(-30 + L / 2, 0.5, TRACK_W / 2 + 7.5);
    wall.receiveShadow = true;
    s.add(wall);
    const stand = new THREE.Mesh(new THREE.BoxGeometry(L, 9, 14), new THREE.MeshStandardMaterial({ color: new THREE.Color('#8d99a6'), roughness: 0.9 }));
    stand.position.set(-30 + L / 2, 3.5, TRACK_W / 2 + 22);
    stand.rotation.x = 0.55;
    s.add(stand);
  }

  buildBones(bones) {
    this.boneMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.6, metalness: 0 });
    this.boneIM = {};
    for (const [name, m] of Object.entries(bones)) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(m.pos, 3));
      g.setIndex(new THREE.BufferAttribute(m.idx, 1));
      g.computeVertexNormals();
      const im = new THREE.InstancedMesh(g, this.boneMat, MAX_RUNNERS);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.castShadow = true;
      im.receiveShadow = true;
      for (let i = 0; i < MAX_RUNNERS; i++) im.setColorAt(i, BONE);
      im.count = 0;
      this.scene.add(im);
      this.boneIM[name] = im;
    }
    this.boneList = Object.values(this.boneIM);
  }

  // room for `segs` muscle segments and `pts` path points (a cylinder and a sphere each); called again by setRunners
  // when the recordings on stage need more than there is
  buildMuscles(segs = 2600, pts = 3400) {
    if (this.segIM) {
      for (const im of [this.segIM, this.ptIM]) { this.scene.remove(im); im.geometry.dispose(); im.dispose(); }
    }
    this.muscleMat = this.muscleMat || new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.42, metalness: 0 });
    this.segIM = new THREE.InstancedMesh(new THREE.CylinderGeometry(1, 1, 1, 10, 1, true), this.muscleMat, segs);
    this.ptIM = new THREE.InstancedMesh(new THREE.SphereGeometry(1, 8, 5), this.muscleMat, pts);
    for (const im of [this.segIM, this.ptIM]) {
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.frustumCulled = false;
      im.castShadow = false;   // the bones' shadow is enough; muscle shadows doubled the most expensive pass
      im.setColorAt(0, BONE);
      im.count = 0;
      this.scene.add(im);
    }
  }

  buildMarkers() {
    this.prints = new THREE.InstancedMesh(new THREE.CircleGeometry(1, 20).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false }), MAX_PRINTS);
    this.prints.frustumCulled = false;
    this.prints.setColorAt(0, BONE);
    this.prints.count = 0;
    this.scene.add(this.prints);
    this.rings = new THREE.InstancedMesh(new THREE.RingGeometry(0.3, 0.42, 40).rotateX(-Math.PI / 2),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false, toneMapped: false }), MAX_RUNNERS);
    this.rings.frustumCulled = false;
    this.rings.setColorAt(0, BONE);
    this.rings.count = 0;
    this.scene.add(this.rings);
    // worn devices: a band at the hips, or at the ankles
    this.gear = new THREE.InstancedMesh(new THREE.TorusGeometry(1, 0.16, 10, 36).rotateX(Math.PI / 2),
      new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.35, metalness: 0.2, emissive: new THREE.Color('#3a2a00'), emissiveIntensity: 0.4 }), 3 * MAX_RUNNERS);
    this.gear.frustumCulled = false;
    this.gear.castShadow = true;
    this.gear.setColorAt(0, BONE);
    this.gear.count = 0;
    this.scene.add(this.gear);
    this.arrows = [];
    for (let i = 0; i < MAX_RUNNERS; i++) {
      const a = new THREE.ArrowHelper(new THREE.Vector3(1, 0, 0), new THREE.Vector3(), 1, 0xff5a1f, 0.22, 0.13);
      a.visible = false;
      a.line.material.toneMapped = false; a.cone.material.toneMapped = false;
      this.scene.add(a);
      this.arrows.push(a);
    }
  }

  // runners: [{run, lane, color, short, gear}]
  setRunners(runners) {
    // the stage has room for MAX_RUNNERS (bones, rings, arrows); more are not drawn
    let segs = 0, pts = 0;
    this.runners = runners.slice(0, MAX_RUNNERS).map((r, i) => {
      const run = r.run;
      // muscle layout: segment and point offsets for this recording
      const npts = run.head.muscles.npts, fmax = run.head.muscles.fmax;
      const start = []; let p = 0;
      for (const n of npts) { start.push(p); p += n; segs += Math.max(n - 1, 0); }
      pts += p;
      const mesh = (name) => run.head.meshes.indexOf(name);
      return { ...r, i, color: new THREE.Color(r.color), gearColor: r.gear ? new THREE.Color(r.gear.color) : null, start, npts, fmax,
        iHip: mesh('pelvis'), iTalusL: mesh('talus_lv'), iTalusR: mesh('talus_rv') };
    });
    if (segs > this.segIM.instanceMatrix.count || pts > this.ptIM.instanceMatrix.count) this.buildMuscles(segs, pts);
    this.lastFocusX = null;
    this.labels.innerHTML = '';
    for (const r of this.runners) {
      const el = document.createElement('div');
      el.className = 'tag';
      el.style.setProperty('--c', r.color.getStyle(THREE.SRGBColorSpace));
      el.innerHTML = `<span class="num">${r.num}</span><span class="nm">${r.short}</span><span class="d"></span>`;
      this.labels.appendChild(el);
      r.tag = el;
    }
    const n = this.runners.length;
    _m4.makeScale(0, 0, 0);
    for (const [name, im] of Object.entries(this.boneIM)) {
      im.count = n;
      for (let i = 0; i < n; i++) {
        im.setColorAt(i, BONE);
        // a bone this recording does not list is never written by update(): without this its place would keep
        // the pose of whoever stood there in the scene before
        if (!this.runners[i].run.head.meshes.includes(name)) im.setMatrixAt(i, _m4);
      }
      im.instanceColor.needsUpdate = true;
    }
    this.applyTint();
  }

  applyTint() {
    for (const r of this.runners) {
      const c = this.opts.mode === 'overlay' ? BONE.clone().lerp(r.color, 0.8) : this.opts.tint ? BONE.clone().lerp(r.color, 0.55) : BONE;
      for (const im of this.boneList) if (r.i < im.count) im.setColorAt(r.i, c);
    }
    for (const im of this.boneList) if (im.instanceColor) im.instanceColor.needsUpdate = true;
  }

  // the runner the Close view shows: the selected one, or the first one on show when the selected one is hidden
  soloRunner() {
    const s = this.runners[this.selected];
    return s && s.visible !== false ? s : this.runners.find((r) => r.visible !== false);
  }

  // show or hide one runner (by its place on stage)
  setVisible(i, on) {
    if (this.runners[i]) this.runners[i].visible = on;
    this.lastFocusX = null;
  }

  centerLane() {
    const l = this.runners.map((r) => r.lane);
    return l.length ? (Math.min(...l) + Math.max(...l)) / 2 : 4.5;
  }

  update(time) {
    const m4 = _m4, q = _q, q1 = _q1, pos = _pos, sc = _sc, up = _up, d = _d, col = _col, grey = _grey, vA = _vA, vB = _vB;
    let nSeg = 0, nPt = 0, nPrint = 0, nGear = 0;
    const thick = this.opts.thickness;
    const hl = this.opts.highlight;
    const showMus = this.opts.muscles, showBones = this.opts.bones;
    for (const im of this.boneList) im.visible = showBones;
    const solo = this.view === 'gait' && this.opts.mode !== 'overlay';
    const race = this.opts.mode === 'race';
    const overlayZ = this.opts.mode === 'overlay' ? laneZ(this.centerLane()) : null;
    const printsEach = Math.floor(MAX_PRINTS / Math.max(this.runners.length, 1));
    const alone = solo ? this.soloRunner() : null;
    for (const r of this.runners) {
      const run = r.run, V = run.V;
      r.visible = r.visible !== false;
      r.shown = r.visible && (!solo || r === alone);
      const fi = frameAt(run, time);
      const f0 = Math.floor(fi), f1 = Math.min(f0 + 1, run.F - 1), w = fi - f0;
      const px = interp(run.pelvis, 3, 0, fi), py = interp(run.pelvis, 3, 1, fi), pz = interp(run.pelvis, 3, 2, fi);
      // sideways and forward offsets for the display mode: lanes, or forward travel removed, or all in one lane
      const dx = race ? 0 : X_TREADMILL - px;
      const dz = overlayZ === null ? laneZ(r.lane) : overlayZ;
      r.x = px + dx; r.z = pz + dz; r.px = px;
      r.fi = fi;
      // bones
      const meshes = run.head.meshes, mscale = run.head.mesh_scale;
      for (let b = 0; b < V; b++) {
        const im = this.boneIM[meshes[b]];
        if (!im) continue;
        if (!r.shown) { m4.makeScale(0, 0, 0); im.setMatrixAt(r.i, m4); continue; }
        const k0 = 3 * (f0 * V + b), k1 = 3 * (f1 * V + b);
        pos.set(px + dx + lerp(run.bonePos[k0], run.bonePos[k1], w), py + lerp(run.bonePos[k0 + 1], run.bonePos[k1 + 1], w),
          pz + dz + lerp(run.bonePos[k0 + 2], run.bonePos[k1 + 2], w));
        const j0 = 4 * (f0 * V + b), j1 = 4 * (f1 * V + b);
        q.set(run.boneRot[j0], run.boneRot[j0 + 1], run.boneRot[j0 + 2], run.boneRot[j0 + 3]);
        q1.set(run.boneRot[j1], run.boneRot[j1 + 1], run.boneRot[j1 + 2], run.boneRot[j1 + 3]);
        q.set(lerp(q.x, q1.x, w), lerp(q.y, q1.y, w), lerp(q.z, q1.z, w), lerp(q.w, q1.w, w)).normalize();
        sc.fromArray(mscale[b]);
        m4.compose(pos, q, sc);
        im.setMatrixAt(r.i, m4);
      }
      // muscles: a cylinder per path segment, a sphere at every path point
      if (showMus && r.shown && this.opts.mode !== 'overlay') {
        const P = run.P, M = run.M;
        for (let j = 0; j < M; j++) {
          const a = lerp(run.act[f0 * M + j], run.act[f1 * M + j], w) / 255;
          const inHl = !hl || hl.has(run.head.muscles.names[j]);
          const rad = thick * (0.0032 + 0.00022 * Math.sqrt(r.fmax[j])) * (inHl ? 1 : 0.55);
          if (inHl) activationColor(a, col); else col.copy(grey);
          let prev = null;
          for (let p = 0; p < r.npts[j]; p++) {
            const k0 = 3 * (f0 * P + r.start[j] + p), k1 = 3 * (f1 * P + r.start[j] + p);
            const cur = p % 2 ? vB : vA;
            cur.set(px + dx + lerp(run.musclePts[k0], run.musclePts[k1], w), py + lerp(run.musclePts[k0 + 1], run.musclePts[k1 + 1], w),
              pz + dz + lerp(run.musclePts[k0 + 2], run.musclePts[k1 + 2], w));
            m4.compose(cur, q.identity(), sc.set(rad, rad, rad));
            this.ptIM.setMatrixAt(nPt, m4); this.ptIM.setColorAt(nPt, col); nPt++;
            if (prev) {
              d.subVectors(cur, prev);
              const len = d.length();
              if (len > 1e-5) {
                q.setFromUnitVectors(up, d.multiplyScalar(1 / len));
                pos.addVectors(prev, cur).multiplyScalar(0.5);
                m4.compose(pos, q, sc.set(rad, len, rad));
                this.segIM.setMatrixAt(nSeg, m4); this.segIM.setColorAt(nSeg, col); nSeg++;
              }
            }
            prev = cur;
          }
        }
      }
      // footprints of the latest strikes (an equal share of the room for each runner, so that on a long recording
      // the first lane does not use it all), and a ring under the runner
      if (this.opts.footprints && r.shown && race) {
        const S = run.strikes, tNow = time + run.t[0] + 1e-6;
        let lo = 0, hi = S.length;                       // number of strikes up to now
        while (lo < hi) { const mid = (lo + hi) >> 1; if (S[mid].t <= tNow) lo = mid + 1; else hi = mid; }
        for (let k = Math.max(0, lo - printsEach); k < lo; k++) {
          m4.compose(pos.set(S[k].x + dx + 0.06, 0.011, S[k].z + dz), q.identity(), sc.set(0.14, 1, 0.055));
          this.prints.setMatrixAt(nPrint, m4); this.prints.setColorAt(nPrint, r.color); nPrint++;
        }
      }
      m4.compose(pos.set(r.x, 0.012, r.z), q.identity(), sc.set(r.shown ? 1 : 0, 1, r.shown ? 1 : 0));
      this.rings.setMatrixAt(r.i, m4); this.rings.setColorAt(r.i, r.color);
      // worn devices
      if (r.gear && r.shown) {
        const gc = r.gearColor;
        if (r.gear.at === 'hip' && r.iHip >= 0) {
          const k0 = 3 * (f0 * V + r.iHip), k1 = 3 * (f1 * V + r.iHip);
          pos.set(px + dx + lerp(run.bonePos[k0], run.bonePos[k1], w), py + lerp(run.bonePos[k0 + 1], run.bonePos[k1 + 1], w) - 0.04,
            pz + dz + lerp(run.bonePos[k0 + 2], run.bonePos[k1 + 2], w));
          m4.compose(pos, q.identity(), sc.set(0.19, 0.19, 0.19));
          this.gear.setMatrixAt(nGear, m4); this.gear.setColorAt(nGear, gc); nGear++;
        } else if (r.gear.at === 'ankle') {
          for (const b of [r.iTalusL, r.iTalusR]) {
            if (b < 0) continue;
            const k0 = 3 * (f0 * V + b), k1 = 3 * (f1 * V + b);
            pos.set(px + dx + lerp(run.bonePos[k0], run.bonePos[k1], w), py + lerp(run.bonePos[k0 + 1], run.bonePos[k1 + 1], w),
              pz + dz + lerp(run.bonePos[k0 + 2], run.bonePos[k1 + 2], w));
            m4.compose(pos, q.identity(), sc.set(0.06, 0.06, 0.06));
            this.gear.setMatrixAt(nGear, m4); this.gear.setColorAt(nGear, gc); nGear++;
          }
        }
      }
      // external pushes (forces above the air drag)
      const ar = this.arrows[r.i];
      ar.visible = false;
      if (run.force && r.shown && r.showForce) {
        const n = run.force.n;
        for (let a = 0; a < n; a++) {
          const fxv = interp(run.force.dir, 3 * n, 3 * a, fi), fyv = interp(run.force.dir, 3 * n, 3 * a + 1, fi), fzv = interp(run.force.dir, 3 * n, 3 * a + 2, fi);
          const mag = Math.hypot(fxv, fyv, fzv);
          if (mag > 60) {
            const sx = interp(run.force.start, 3 * n, 3 * a, fi), sy = interp(run.force.start, 3 * n, 3 * a + 1, fi), sz = interp(run.force.start, 3 * n, 3 * a + 2, fi);
            d.set(fxv / mag, fyv / mag, fzv / mag);
            ar.position.set(px + dx + sx - d.x * mag / 260, py + sy - d.y * mag / 260, pz + dz + sz - d.z * mag / 260);
            ar.setDirection(d);
            ar.setLength(mag / 260, 0.2, 0.12);
            ar.visible = true;
            break;
          }
        }
      }
    }
    const nRun = this.runners.length;
    for (const im of this.boneList) upload(im.instanceMatrix, showBones ? nRun : 0);
    this.segIM.count = nSeg; this.ptIM.count = nPt;
    upload(this.segIM.instanceMatrix, nSeg); upload(this.segIM.instanceColor, nSeg);
    upload(this.ptIM.instanceMatrix, nPt); upload(this.ptIM.instanceColor, nPt);
    this.prints.count = nPrint;
    upload(this.prints.instanceMatrix, nPrint); upload(this.prints.instanceColor, nPrint);
    this.rings.count = nRun;
    upload(this.rings.instanceMatrix, nRun); upload(this.rings.instanceColor, nRun);
    this.gear.count = nGear;
    upload(this.gear.instanceMatrix, nGear); upload(this.gear.instanceColor, nGear);
  }

  // camera: follows the group (or the selected runner); presets blend over about 0.7 s
  setView(v) {
    if (v === this.view) return;
    this.camFrom = { pos: this.camera.position.clone(), look: this.lookCur ? this.lookCur.clone() : this.focus.clone(), up: this.camera.up.clone() };
    // the Free view starts from where the camera is: nothing to blend, and busy() must not keep the page drawing
    this.camBlend = v === 'free' ? 1 : 0;
    this.view = v;
    this.controls.enabled = v === 'free';
    this.renderer.domElement.style.touchAction = v === 'free' ? 'none' : 'pan-y';
    if (v === 'free') {
      this.controls.target.copy(this.lookCur || this.focus);
    }
  }

  frameCamera(dt) {
    const vis = this.runners.filter((r) => r.visible !== false);
    if (!vis.length) return;
    const xs = vis.map((r) => r.x);
    const hi = Math.max(...xs), lo = Math.min(...xs);
    const zs = vis.map((r) => r.z);
    const zMid = (Math.max(...zs) + Math.min(...zs)) / 2;
    const sel = this.soloRunner() || vis[0];
    const target = (hi + lo) / 2;
    const k = 1 - Math.exp(-dt * 5);
    // The focus moves with the runners exactly and eases out only an offset left by a change of who is framed (runners
    // shown or hidden, another selection), so the camera no longer trails a sprinter by speed / 5 (2.4 m at 12 m/s).
    const key = vis.map((r) => r.i).join(',') + '|' + this.selected;
    if (this.lastFocusX === null || Math.abs(target - this.focus.x) > 8) { this.focusOff = 0; this.spread = hi - lo; }
    else {
      this.focusOff = key !== this.focusKey ? this.focus.x - target : (this.focusOff || 0) * (1 - k);
      this.spread += ((hi - lo) - this.spread) * k;
    }
    this.focusKey = key;
    this.focus.x = target + this.focusOff;
    const prevX = this.lastFocusX;
    this.lastFocusX = this.focus.x;
    this.focus.z += (zMid - this.focus.z) * (this.lastZ === undefined ? 1 : k);
    this.lastZ = this.focus.z;
    const F = this.focus, s = this.spread;
    let pos, look, up = new THREE.Vector3(0, 1, 0), fov = 36;
    switch (this.view) {
      case 'gait': {
        // the close view rides with the selected sprinter; a new selection eases over from the previous framing
        if (this.gaitX === undefined || Math.abs(sel.x - this.gaitX) > 8) this.gaitOff = 0;
        else this.gaitOff = sel !== this.gaitSel ? this.gaitX - sel.x : (this.gaitOff || 0) * (1 - k);
        this.gaitSel = sel;
        this.gaitX = sel.x + this.gaitOff;
        pos = new THREE.Vector3(this.gaitX + 0.25, 1.05, sel.z + 4.4);
        look = new THREE.Vector3(this.gaitX + 0.25, 0.9, sel.z);
        fov = 34;
        break;
      }
      case 'behind':
        pos = new THREE.Vector3(F.x - 7.5 - 0.5 * s, 2.3, F.z);
        look = new THREE.Vector3(F.x + 6, 0.85, F.z);
        fov = 40;
        break;
      case 'front':
        pos = new THREE.Vector3(hi + 8.5, 1.45, F.z);
        look = new THREE.Vector3(hi - 1.5, 0.95, F.z);
        fov = 40;
        break;
      case 'overhead':
        pos = new THREE.Vector3(F.x, 13 + 0.95 * s, F.z + 0.01);
        look = new THREE.Vector3(F.x, 0, F.z);
        up = new THREE.Vector3(0, 0, -1);
        fov = 40;
        break;
      case 'free': {
        if (prevX !== null) {
          const dxF = this.focus.x - prevX;
          this.camera.position.x += dxF;
          this.controls.target.x += dxF;
        }
        this.controls.update();
        this.lookCur = this.controls.target.clone();
        return;
      }
      default: {
        if (this.opts.mode === 'inplace') {
          // sprinters side by side at one spot: a steeper view from the stand keeps every lane apart
          pos = new THREE.Vector3(F.x + 0.8, 7.2, F.z + 7.6);
          look = new THREE.Vector3(F.x + 0.2, 0.55, F.z);
          break;
        }
        const dist = 9 + 0.8 * s;
        pos = new THREE.Vector3(F.x + 0.1 * dist, 1.3 + 0.42 * dist, F.z + dist);
        look = new THREE.Vector3(F.x + 0.06 * dist, 0.75, F.z);
      }
    }
    if (this.camBlend < 1 && this.camFrom) {
      this.camBlend = Math.min(1, this.camBlend + dt / 0.7);
      const e = this.camBlend * this.camBlend * (3 - 2 * this.camBlend);
      pos = this.camFrom.pos.clone().lerp(pos, e);
      look = this.camFrom.look.clone().lerp(look, e);
      up = this.camFrom.up.clone().lerp(up, e).normalize();
    }
    this.camera.position.copy(pos);
    this.camera.up.copy(up);
    this.camera.lookAt(look);
    this.lookCur = look;
    if (Math.abs(this.camera.fov - fov) > 0.01) { this.camera.fov += (fov - this.camera.fov) * Math.min(1, dt * 6); this.camera.updateProjectionMatrix(); }
  }

  updateLabels(info) {
    // place each tag above its sprinter, then push overlapping tags upward (the lowest tag keeps its place).
    // Sizes are measured only after a tag's text changes, all in one pass after the writes, so drawing a frame never
    // forces a layout per tag.
    const w = this.W || this.container.clientWidth, h = this.H || this.container.clientHeight;
    const v = new THREE.Vector3();
    const placed = [], measure = [];
    for (const r of this.runners) {
      const el = r.tag;
      const hide = () => { if (el.style.display !== 'none') el.style.display = 'none'; };
      if (!this.opts.labels || r.visible === false || r.shown === false) { hide(); continue; }
      v.set(r.x, 2.0, r.z).project(this.camera);
      if (v.z > 1 || v.z < -1) { hide(); continue; }
      if (el.style.display === 'none') { el.style.display = ''; r.tagW = 0; }
      // The distance digits have equal widths (tabular figures), so a tag's size changes only when its text gets
      // longer or shorter: it is measured again only then, not at every change of a digit.
      const t = info && info[r.i];
      if (t && t !== r.tagText) {
        r.tagText = t;
        (r.tagD || (r.tagD = el.querySelector('.d'))).textContent = t;
        if (t.length !== r.tagLen) { r.tagLen = t.length; r.tagW = 0; }
      }
      if (!r.tagW) measure.push(r);
      placed.push({ r, el, x: (v.x + 1) / 2 * w, y: (1 - v.y) / 2 * h });
    }
    for (const r of measure) { r.tagW = r.tag.offsetWidth || 120; r.tagH = r.tag.offsetHeight || 22; }
    for (const p of placed) { p.wd = p.r.tagW; p.ht = p.r.tagH; }
    placed.sort((a, b) => b.y - a.y);
    const done = [];
    for (const p of placed) {
      let moved = true, guard = 0;
      while (moved && guard++ < 20) {
        moved = false;
        for (const q of done) {
          if (Math.abs(p.x - q.x) < (p.wd + q.wd) / 2 + 4 && p.y > q.y - q.ht - 3) { p.y = q.y - q.ht - 3; moved = true; }
        }
      }
      done.push(p);
      const tr = `translate(${p.x.toFixed(1)}px, ${p.y.toFixed(1)}px) translate(-50%, -100%)`;
      if (p.r.tagTr !== tr) { p.r.tagTr = tr; p.el.style.transform = tr; }
    }
  }

  // true while a camera transition is still running, so the app keeps drawing until it ends
  busy() { return this.camBlend < 1; }

  // slower frames: one step down in resolution (1.5 -> 1.25 -> 1 device pixels per CSS pixel); false when at the floor
  lowerQuality() {
    if (this.renderer.getPixelRatio() <= 1.0001) return false;
    this.lowered += 0.25;
    this.resize();
    return true;
  }

  render(dt) {
    const F = this.focus;
    this.sun.target.position.set(F.x + 1, 0, F.z);
    this.sun.position.set(F.x - 9, 26, F.z + 15);
    this.sun.castShadow = this.opts.shadows;
    this.frameCamera(dt);
    this.renderer.render(this.scene, this.camera);
  }
}

function lerp(a, b, w) { return a + (b - a) * w; }
function interp(arr, stride, k, fi) {
  const f0 = Math.floor(fi), n = arr.length / stride, f1 = Math.min(f0 + 1, n - 1), w = fi - f0;
  return arr[f0 * stride + k] * (1 - w) + arr[f1 * stride + k] * w;
}

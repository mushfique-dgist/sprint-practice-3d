// Loads the packed recordings (SPR1) and bone meshes (BON1) and derives what the page shows from them:
// distance (forward travel of the pelvis, as in the evaluation), 1 s speed, foot strikes, step length and rate.

const TYPES = { f4: Float32Array, i2: Int16Array, u1: Uint8Array, u2: Uint16Array, u4: Uint32Array };

async function fetchBytes(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const buf = await res.arrayBuffer();
  const b = new Uint8Array(buf, 0, 2);
  if (b[0] !== 0x1f || b[1] !== 0x8b) return buf; // already decompressed by the server
  const stream = new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'));
  try { return await new Response(stream).arrayBuffer(); }
  catch (e) { throw new Error(`${url}: the file is cut short or damaged`); }
}

function header(buf, magic) {
  if (buf.byteLength < 8) throw new Error(`not a ${magic} file (${buf.byteLength} bytes)`);
  const tag = String.fromCharCode(...new Uint8Array(buf, 0, 4));
  if (tag !== magic) throw new Error(`not a ${magic} file`);
  const n = new DataView(buf).getUint32(4, true);
  if (8 + n > buf.byteLength) throw new Error(`${magic} file is cut short (header)`);
  let head;
  try { head = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 8, n))); }
  catch (e) { throw new Error(`${magic} file has an unreadable header`); }
  return { head, base: 8 + n };
}

const REQUIRED = ['time', 'pelvis', 'com', 'bone_pos', 'bone_rot', 'muscle_pts', 'activation', 'foot_force'];

// int16 channel-major frame differences -> (frames x channels) float32, times unit
function undelta(src, frames, channels, unit) {
  const out = new Float32Array(frames * channels);
  for (let c = 0; c < channels; c++) {
    let acc = 0;
    const row = c * frames;
    for (let f = 0; f < frames; f++) {
      acc = ((acc + src[row + f]) << 16) >> 16;
      out[f * channels + c] = acc * unit;
    }
  }
  return out;
}

export async function loadBones(url) {
  const buf = await fetchBytes(url);
  const { head, base } = header(buf, 'BON1');
  const meshes = {};
  for (const m of head.meshes) {
    const pos = new Float32Array(buf, base + m.pos, m.vertices * 3);
    const idx = new TYPES[m.index_type](buf, base + m.idx, m.triangles * 3);
    meshes[m.name] = { pos, idx };
  }
  return meshes;
}

export async function loadRun(url) {
  const buf = await fetchBytes(url);
  const { head, base } = header(buf, 'SPR1');
  // A file that is cut short, empty or incomplete is refused here with a plain message, so that the page can say
  // which recording is unusable instead of failing later with numbers that are not numbers.
  const A = {};
  for (const a of head.arrays || []) {
    const count = a.shape.reduce((p, q) => p * q, 1);
    const T = TYPES[a.dtype];
    if (!T || base + a.offset + count * T.BYTES_PER_ELEMENT > buf.byteLength) throw new Error(`recording is cut short (${a.name})`);
    A[a.name] = { v: new T(buf, base + a.offset, count), shape: a.shape, delta: a.delta };
  }
  const missing = REQUIRED.filter((k) => !A[k]);
  if (missing.length) throw new Error(`recording lacks ${missing.join(', ')}`);
  const F = head.frames;
  if (!(F >= 1)) throw new Error('recording has no frames');
  const V = head.meshes.length;
  const P = A.muscle_pts.shape[1];
  const M = head.muscles.names.length;
  for (const [k, n] of [['time', F], ['pelvis', 3 * F], ['bone_pos', 3 * F * V], ['bone_rot', 4 * F * V], ['muscle_pts', 3 * F * P], ['activation', F * M], ['foot_force', 2 * F]]) {
    if (A[k].v.length !== n) throw new Error(`recording's ${k} does not fit its ${F} frames`);
  }
  for (let f = 0; f < F; f++) {
    if (!Number.isFinite(A.time.v[f]) || !Number.isFinite(A.pelvis.v[3 * f]) || !Number.isFinite(A.pelvis.v[3 * f + 1]) || !Number.isFinite(A.pelvis.v[3 * f + 2])) {
      throw new Error(`recording has a value that is not a number (frame ${f})`);
    }
  }
  // The small arrays are copied out of the file's buffer (slice), so the buffer, half of it frame differences that
  // are decoded just below, can be freed: about a third less memory held per recording.
  const run = {
    url, head, F, V, P, M, fps: head.fps,
    t: A.time.v.slice(), pelvis: A.pelvis.v.slice(), com: A.com.v.slice(),
    bonePos: undelta(A.bone_pos.v, F, V * 3, head.pos_unit),
    boneRot: undelta(A.bone_rot.v, F, V * 4, 1 / 32767),
    musclePts: undelta(A.muscle_pts.v, F, P * 3, head.pos_unit),
    act: A.activation.v.slice(), foot: A.foot_force.v.slice(),
    force: null,
  };
  run.bytes = ['t', 'pelvis', 'com', 'bonePos', 'boneRot', 'musclePts', 'act', 'foot'].reduce((n, k) => n + run[k].byteLength, 0);
  if (A.force_dir) {
    const n = head.force_arrows.length;
    run.force = { n, start: undelta(A.force_start.v, F, n * 3, head.pos_unit), dir: undelta(A.force_dir.v, F, n * 3, head.force_unit) };
  }
  derive(run);
  return run;
}

function derive(run) {
  const { F, t, pelvis } = run;
  const x0 = pelvis[0];
  run.dist = new Float32Array(F);
  for (let f = 0; f < F; f++) run.dist[f] = pelvis[3 * f] - x0;
  run.duration = t[F - 1] - t[0];
  run.fell = run.duration < 9.9;
  // speed: forward pelvis travel over the last second (from the start during the first second)
  run.speed = new Float32Array(F);
  for (let f = 1; f < F; f++) {
    let g = f;
    while (g > 0 && t[f] - t[g - 1] <= 1.0 + 1e-6) g--;
    run.speed[f] = (run.dist[f] - run.dist[g]) / Math.max(t[f] - t[g], 1e-6);
  }
  run.speed[0] = 0;
  // foot strikes: contact force rising through 100 N, at least 0.15 s after that foot's last strike
  // a recording without a foot bone marks its strikes under the pelvis
  const iFoot = { l: run.head.meshes.indexOf('l_foot'), r: run.head.meshes.indexOf('foot') };
  const strikes = [];
  for (const [s, col] of [['l', 0], ['r', 1]]) {
    let last = -1e9;
    for (let f = 1; f < F; f++) {
      const a = run.foot[2 * (f - 1) + col], b = run.foot[2 * f + col];
      if (a < 100 && b >= 100 && t[f] - last > 0.15) {
        const k = 3 * (f * run.V + iFoot[s]), has = iFoot[s] >= 0;
        strikes.push({ f, t: t[f], side: s, x: pelvis[3 * f] + (has ? run.bonePos[k] : 0), z: pelvis[3 * f + 2] + (has ? run.bonePos[k + 2] : 0) });
        last = t[f];
      }
    }
  }
  strikes.sort((p, q) => p.t - q.t);
  for (let i = 1; i < strikes.length; i++) {
    const p = strikes[i - 1], q = strikes[i];
    if (p.side !== q.side) { q.stepLen = q.x - p.x; q.stepTime = q.t - p.t; }
  }
  run.strikes = strikes;
}

// values at a fractional frame index, linearly interpolated
export function at(arr, stride, k, fi) {
  const f0 = Math.floor(fi), f1 = Math.min(f0 + 1, (arr.length / stride) - 1), w = fi - f0;
  return arr[f0 * stride + k] * (1 - w) + arr[f1 * stride + k] * w;
}

export function frameAt(run, time) {
  // fractional frame index for a time (s) since the start; clamped to the recording
  const t = run.t, F = run.F;
  const tt = Math.min(Math.max(time + t[0], t[0]), t[F - 1]);
  let lo = 0, hi = F - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (t[mid] <= tt) lo = mid; else hi = mid; }
  const span = t[hi] - t[lo];
  return lo + (span > 0 ? (tt - t[lo]) / span : 0);
}

// recent step length (m) and step rate (steps/s): mean of the last n steps before time
export function recentSteps(run, time, n = 4) {
  const s = run.strikes.filter((q) => q.stepLen !== undefined && q.t - run.t[0] <= time + 1e-9).slice(-n);
  if (!s.length) return null;
  const len = s.reduce((a, q) => a + q.stepLen, 0) / s.length;
  const dt = s.reduce((a, q) => a + q.stepTime, 0) / s.length;
  return { len, rate: 1 / dt };
}

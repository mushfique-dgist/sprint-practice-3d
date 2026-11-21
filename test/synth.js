// Synthetic recordings for the test pages: the SPR1 format of the exporter (see js/data.js), written in the browser, so
// that the viewer can be fed files that no real export would produce (cut short, empty, without muscles, very long).

const DTYPE = { f4: Float32Array, i2: Int16Array, u1: Uint8Array, u2: Uint16Array };
const POS_UNIT = 1e-4;

async function gzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
export async function gunzip(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// (frames x channels) values -> int16 channel-major frame differences, as the exporter stores them
function delta(vals, F, C, unit) {
  const out = new Int16Array(F * C);
  for (let c = 0; c < C; c++) {
    let prev = 0;
    for (let f = 0; f < F; f++) {
      const v = Math.round(vals[f * C + c] / unit);
      out[c * F + f] = v - prev;
      prev = v;
    }
  }
  return out;
}

// header + arrays -> the bytes of an SPR1 file (not yet gzip-compressed)
export function pack(head, arrays) {
  const layout = [], blocks = [];
  let off = 0;
  for (const a of arrays) {
    const bytes = new Uint8Array(a.data.buffer, a.data.byteOffset, a.data.byteLength);
    layout.push({ name: a.name, dtype: a.dtype, shape: a.shape, offset: off, delta: !!a.delta });
    const padded = new Uint8Array(bytes.length + ((4 - (bytes.length % 4)) % 4));
    padded.set(bytes);
    blocks.push(padded);
    off += padded.length;
  }
  let hj = new TextEncoder().encode(JSON.stringify({ ...head, arrays: layout }));
  const pad = (4 - ((hj.length + 8) % 4)) % 4;
  const out = new Uint8Array(8 + hj.length + pad + off);
  out.set([0x53, 0x50, 0x52, 0x31]);   // "SPR1"
  new DataView(out.buffer).setUint32(4, hj.length + pad, true);
  out.set(hj, 8);
  out.fill(0x20, 8 + hj.length, 8 + hj.length + pad);
  let p = 8 + hj.length + pad;
  for (const b of blocks) { out.set(b, p); p += b.length; }
  return out;
}

const BONES = ['sacrum', 'pelvis', 'femur_r', 'tibia_r', 'talus_rv', 'foot', 'femur_l', 'tibia_l', 'talus_lv', 'l_foot', 'torso'];
const MUSCLES = [['rect_fem_r', 3], ['rect_fem_l', 3], ['soleus_r', 2], ['soleus_l', 2], ['glut_max1_r', 2], ['glut_max1_l', 2]];

// A plain stick runner moving at `speed` m/s. Options change what a well-formed export always has.
//   frames, fps, speed, seconds (overrides frames), muscles (false: none), bones (list), drop (array name left out),
//   nanAt (frame index whose pelvis is NaN), raw (true: return the unpacked bytes)
export async function makeRun(o = {}) {
  const fps = o.fps || 30;
  const F = o.seconds !== undefined ? Math.round(o.seconds * fps) + 1 : (o.frames !== undefined ? o.frames : 301);
  const speed = o.speed !== undefined ? o.speed : 9;
  const bones = o.bones || BONES;
  const mus = o.muscles === false ? [] : MUSCLES;
  const V = bones.length, M = mus.length, P = mus.reduce((s, m) => s + m[1], 0);
  const t = new Float32Array(F), pelvis = new Float32Array(F * 3), com = new Float32Array(F * 3);
  const bpos = new Float32Array(F * V * 3), brot = new Float32Array(F * V * 4), mpts = new Float32Array(F * P * 3);
  const act = new Uint8Array(F * M), foot = new Uint16Array(F * 2);
  const stride = 0.5;   // s per stride: each foot strikes twice a second
  for (let f = 0; f < F; f++) {
    const time = f / fps, ph = (time / stride) * 2 * Math.PI;
    t[f] = time;
    pelvis[3 * f] = speed * time; pelvis[3 * f + 1] = 0.95 + 0.02 * Math.sin(2 * ph); pelvis[3 * f + 2] = 0;
    if (o.nanAt === f) pelvis[3 * f] = NaN;
    for (let b = 0; b < V; b++) {
      const side = bones[b].endsWith('_l') || bones[b].startsWith('l_') ? -1 : 1;
      const k = 3 * (f * V + b);
      const leg = /foot|tibia|talus/.test(bones[b]);
      bpos[k] = leg ? 0.35 * Math.sin(ph) * side : 0;
      bpos[k + 1] = /foot/.test(bones[b]) ? -0.9 : /tibia|talus/.test(bones[b]) ? -0.5 : /torso/.test(bones[b]) ? 0.1 : 0;
      bpos[k + 2] = /torso|pelvis|sacrum/.test(bones[b]) ? 0 : 0.09 * side;
      brot[4 * (f * V + b) + 3] = 1;
    }
    let p = 0;
    for (let j = 0; j < M; j++) {
      const side = mus[j][0].endsWith('_l') ? -1 : 1;
      for (let i = 0; i < mus[j][1]; i++, p++) {
        const k = 3 * (f * P + p);
        mpts[k] = 0.05 * i * Math.sin(ph) * side; mpts[k + 1] = -0.2 - 0.3 * i; mpts[k + 2] = 0.1 * side;
      }
      act[f * M + j] = Math.round(127.5 * (1 + Math.sin(ph + j)));
    }
    foot[2 * f] = Math.sin(ph) > 0.6 ? 1800 : 0;
    foot[2 * f + 1] = Math.sin(ph + Math.PI) > 0.6 ? 1800 : 0;
  }
  const arrays = [
    { name: 'time', dtype: 'f4', shape: [F], data: t },
    { name: 'pelvis', dtype: 'f4', shape: [F, 3], data: pelvis },
    { name: 'com', dtype: 'f4', shape: [F, 3], data: com },
    { name: 'bone_pos', dtype: 'i2', shape: [F, V, 3], delta: true, data: delta(bpos, F, V * 3, POS_UNIT) },
    { name: 'bone_rot', dtype: 'i2', shape: [F, V, 4], delta: true, data: delta(brot, F, V * 4, 1 / 32767) },
    { name: 'muscle_pts', dtype: 'i2', shape: [F, P, 3], delta: true, data: delta(mpts, F, P * 3, POS_UNIT) },
    { name: 'activation', dtype: 'u1', shape: [F, M], data: act },
    { name: 'foot_force', dtype: 'u2', shape: [F, 2], data: foot },
  ].filter((a) => a.name !== o.drop);
  const head = { format: 'SPR1', frames: F, fps, pos_unit: POS_UNIT, force_unit: 0.1, meshes: bones,
    mesh_scale: bones.map(() => [1, 1, 1]), muscles: { names: mus.map((m) => m[0]), npts: mus.map((m) => m[1]), fmax: mus.map(() => 3000) },
    force_arrows: [], summary: {}, synthetic: true };
  const raw = pack(head, arrays);
  return o.raw ? raw : gzip(raw);
}

// A real recording repeated `times` times end to end (time and distance carry on), as a very long recording of real
// size: every array of the real file is tiled, so the decoder and the stage see real bone and muscle counts.
export async function tileRun(url, times) {
  const src = await (await fetch(url)).arrayBuffer();
  const raw = await gunzip(new Uint8Array(src));
  const n = new DataView(raw.buffer).getUint32(4, true);
  const head = JSON.parse(new TextDecoder().decode(raw.subarray(8, 8 + n)));
  const base = 8 + n, F = head.frames, G = F * times;
  const arrays = head.arrays.map((a) => {
    const count = a.shape.reduce((p, q) => p * q, 1), per = count / F;
    const src = new DTYPE[a.dtype](raw.buffer.slice(base + a.offset, base + a.offset + count * DTYPE[a.dtype].BYTES_PER_ELEMENT));
    const out = new DTYPE[a.dtype](per * G);
    if (a.delta) {
      // channel-major: each channel's row is repeated; the first difference of a repeat goes back from the last value
      for (let c = 0; c < per; c++) {
        let last = 0;
        for (let f = 0; f < F; f++) last += src[c * F + f];
        for (let r = 0; r < times; r++) {
          out.set(src.subarray(c * F, (c + 1) * F), c * G + r * F);
          if (r) out[c * G + r * F] = src[c * F] - last;
        }
      }
    } else {
      for (let r = 0; r < times; r++) out.set(src, r * count);
      if (a.name === 'time') {
        const dt = src[1] - src[0], span = src[F - 1] - src[0] + dt;
        for (let r = 1; r < times; r++) for (let f = 0; f < F; f++) out[r * F + f] += r * span;
      }
      if (a.name === 'pelvis') {
        const span = src[3 * (F - 1)] - src[0] + (src[3 * (F - 1)] - src[3 * (F - 2)]);
        for (let r = 1; r < times; r++) for (let f = 0; f < F; f++) out[3 * (r * F + f)] += r * span;
      }
    }
    return { name: a.name, dtype: a.dtype, shape: [G, ...a.shape.slice(1)], delta: a.delta, data: out };
  });
  const h = { ...head, frames: G, synthetic: true };
  delete h.arrays;
  return gzip(pack(h, arrays));
}

export const blobUrl = (bytes) => URL.createObjectURL(new Blob([bytes]));

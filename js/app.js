// Page logic: scenario picking, playback, the race table, charts, muscle activity, and the results, films and about pages.
// Every number shown comes from data/catalog.json (built from the analysis outputs) or from the recordings themselves.

import { loadBones, loadRun, frameAt, recentSteps } from './data.js?v=202610300247';
import { Stage, activationColor } from './scene.js?v=202610300247';
import { Color, SRGBColorSpace } from 'three';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const MINUS = '−';
const f2 = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x)) ? '–' : (x < 0 ? MINUS : '') + Math.abs(x).toFixed(d);
const sg = (x, d = 2) => (x === null || x === undefined || Number.isNaN(x)) ? '–' : (x > 0 ? '+' : x < 0 ? MINUS : '±') + Math.abs(x).toFixed(d);
const ci = (c, d = 2) => `<span class="num">${sg(c.m, d)} m</span> <span class="ci">[${f2(c.lo, d)}, ${f2(c.hi, d)}]</span>`;

const GROUPS = [
  ['Hip flexors', /^(iliacus|psoas|rect_fem|sar|tfl|pect)_[rl]$/],
  ['Hip extensors', /^(glut_max\d|semimem|semiten|bifemlh|add_mag\d)_[rl]$/],
  ['Hip abductors', /^(glut_med\d|glut_min\d)_[rl]$/],
  ['Knee extensors', /^(rect_fem|vas_med|vas_int|vas_lat)_[rl]$/],
  ['Hamstrings', /^(semimem|semiten|bifemlh|bifemsh)_[rl]$/],
  ['Calf', /^(med_gas|lat_gas|soleus|tib_post|flex_dig|flex_hal|per_brev|per_long)_[rl]$/],
  ['Shin', /^(tib_ant|ext_dig|ext_hal|per_tert)_[rl]$/],
];
const ARM_LANES = { base: 2, twin: 3, mix: 4, brake: 5, dev: 6 };

let CAT, stage;
const state = { tab: 'main', pair: 1, deviceOn: false, showBase: true, cond: null, oct: null, time: 0, playing: false, speed: 1,
  loop: false, chart: 'gap', sel: 1, hidden: new Set(), dur: 10 };
let runners = [];
let loadToken = 0;
const cache = new Map();
const getRun = (file) => { if (!cache.has(file)) cache.set(file, loadRun(`data/${file}`)); return cache.get(file); };

// ---------------------------------------------------------------------------------------------------------------
async function init() {
  try {
    CAT = await (await fetch('data/catalog.json', { cache: 'no-cache' })).json();
  } catch (e) {
    $('#loading span').textContent = 'Could not load the catalogue: ' + e.message;
    return;
  }
  $('#built').textContent = `Built ${CAT.built}`;
  state.cond = CAT.conditions.groups.flatMap((g) => g.items).find((c) => c.available)?.key || null;
  state.oct = CAT.oct23[0]?.key || null;
  readHash();
  const bones = await loadBones('data/bones.bin.gz');
  stage = new Stage($('#stage'), bones);
  wireControls();
  buildResults();
  buildFilms();
  buildAbout();
  await showTab(state.tab, true);
  setupIntro();
  setInterval(checkUpdate, 5 * 60 * 1000);
  requestAnimationFrame(loop);
}

function readHash() {
  const p = location.hash.replace(/^#/, '').split('/').filter(Boolean);
  if (!p.length) return;
  if (['main', 'cond', 'oct', 'results', 'films', 'about'].includes(p[0])) state.tab = p[0];
  if (state.tab === 'main') {
    for (const x of p.slice(1)) {
      if (/^p\d+$/.test(x)) state.pair = Math.min(Math.max(parseInt(x.slice(1), 10), 1), CAT.main.pairs.length);
      if (x === 'on') state.deviceOn = true;
    }
  }
  if (state.tab === 'cond' && p[1]) state.cond = p[1];
  if (state.tab === 'oct' && p[1]) state.oct = p[1];
}

function writeHash() {
  let h = state.tab;
  if (state.tab === 'main') h += `/p${state.pair}${state.deviceOn ? '/on' : ''}`;
  if (state.tab === 'cond' && state.cond) h += `/${state.cond}`;
  if (state.tab === 'oct' && state.oct) h += `/${state.oct}`;
  history.replaceState(null, '', `#${h}`);
}

// ---------------------------------------------------------------------------------------------------------------
function condItem(key) { return CAT.conditions.groups.flatMap((g) => g.items).find((c) => c.key === key); }

function specs() {
  const out = [];
  if (state.tab === 'main') {
    const P = CAT.main.pairs.find((p) => p.k === state.pair);
    for (const arm of ['base', 'twin', 'mix', 'brake', 'dev']) {
      if (arm === 'base' && !state.showBase) continue;
      const on = state.deviceOn && P.on && P.on[arm];
      const file = on ? P.on[arm] : P.off[arm];
      if (!file) continue;
      const A = CAT.arms[arm];
      out.push({ key: arm, file, lane: ARM_LANES[arm], color: A.color, label: A.label, short: A.short, about: A.about,
        gear: on ? CAT.gear[arm === 'brake' ? 'brake_on' : 'device_on'] : null, on: !!on });
    }
  } else if (state.tab === 'cond') {
    const C = condItem(state.cond);
    if (C) {
      for (const arm of ['twin', 'mix', 'brake', 'dev']) {
        const file = C.runs[arm];
        if (!file) continue;
        const A = CAT.arms[arm];
        out.push({ key: arm, file, lane: ARM_LANES[arm], color: A.color, label: A.label, short: A.short, about: A.about,
          gear: C.gear ? CAT.gear[C.gear] : null, showForce: !!C.force, unregistered: (C.unregistered || []).includes(arm) });
      }
    }
  } else if (state.tab === 'oct') {
    const R = CAT.oct23.find((r) => r.key === state.oct);
    if (R) R.runners.forEach((x, i) => out.push({ key: `o${i}`, file: x.file, lane: 3 + i, color: x.color, label: x.label, short: x.short, about: x.about,
      gear: x.gear ? CAT.gear[x.gear] : null, on: !!x.gear }));
  }
  out.forEach((s, i) => { s.num = i + 1; });
  return out;
}

function pairsOf(b) { return CAT.main.pairs.filter((p) => p.base === b).map((p) => p.k); }
function listAnd(a) { return a.length < 2 ? a.join('') : `${a.slice(0, -1).join(', ')} and ${a[a.length - 1]}`; }
function minutes(steps) { return Math.round(steps / CAT.main.control_hz / 60); }

function refIndex() {
  const i = runners.findIndex((r) => r.key === 'twin');
  return i >= 0 ? i : 0;
}

async function loadScenario() {
  const token = ++loadToken;
  const sp = specs();
  $('#loading').hidden = false;
  try {
    const runs = await Promise.all(sp.map((s) => getRun(s.file)));
    if (token !== loadToken) return;
    runners = sp.map((s, i) => ({ ...s, run: runs[i], visible: !state.hidden.has(s.key) }));
  } catch (e) {
    $('#loading span').textContent = 'Could not load a recording: ' + e.message;
    return;
  }
  const R = state.tab === 'oct' ? CAT.oct23.find((r) => r.key === state.oct) : null;
  // a race from the 23 Oct slides is shown up to its shortest recording, as in the 23 Oct video
  state.dur = R && R.clip ? Math.min(...runners.map((r) => r.run.duration)) : Math.max(...runners.map((r) => r.run.duration));
  state.time = Math.min(state.time, state.dur);
  if (state.sel >= runners.length) state.sel = 0;
  if (state.tab === 'main' && runners[state.sel]?.key === 'base') state.sel = refIndex();
  stage.setRunners(runners);
  stage.selected = state.sel;
  $('#time').max = state.dur.toFixed(3);
  buildTicks();
  buildPick();
  buildBoard();
  buildChart();
  buildExplain();
  buildHud();
  $('#loading').hidden = true;
  writeHash();
}

// ---------------------------------------------------------------------------------------------------------------
async function showTab(tab, first = false) {
  state.tab = tab;
  for (const b of $$('.tabs button')) b.setAttribute('aria-selected', String(b.dataset.tab === tab));
  const viewer = ['main', 'cond', 'oct'].includes(tab);
  $('#viewer').hidden = !viewer;
  for (const id of ['results', 'films', 'about']) $(`#${id}`).hidden = id !== tab;
  if (!viewer) {
    state.playing = false;
    for (const v of $$('video')) if (tab !== 'films') v.pause();
    writeHash();
    return;
  }
  if (!first) state.time = 0;
  state.playing = false;
  updatePlayUI();
  stage.resize();
  await loadScenario();
}

function wireControls() {
  for (const b of $$('.tabs button')) b.addEventListener('click', () => showTab(b.dataset.tab));
  $('#updateReload').addEventListener('click', () => location.reload());
  for (const b of $$('#views button')) b.addEventListener('click', () => setView(b.dataset.view));
  $('#play').addEventListener('click', togglePlay);
  $('#bigplay').addEventListener('click', togglePlay);
  $('#back').addEventListener('click', () => step(-1));
  $('#fwd').addEventListener('click', () => step(1));
  const tl = $('#time');
  tl.addEventListener('input', () => { state.time = parseFloat(tl.value); state.playing = false; updatePlayUI(); });
  $('#stage').addEventListener('dblclick', togglePlay);
  $('#speed').addEventListener('change', (e) => { state.speed = parseFloat(e.target.value); });
  $('#loop').addEventListener('change', (e) => { state.loop = e.target.checked; });
  for (const c of $$('[data-opt]')) {
    c.addEventListener('change', () => {
      stage.opts[c.dataset.opt] = c.checked;
      if (c.dataset.opt === 'tint') stage.applyTint();
      if (c.dataset.opt === 'muscles') $('#actLegend').hidden = !c.checked;
    });
  }
  const hl = $('#highlight');
  hl.innerHTML = '<option value="">All muscles</option>' + GROUPS.map((g, i) => `<option value="${i}">${g[0]}</option>`).join('');
  hl.addEventListener('change', () => {
    if (hl.value === '') { stage.opts.highlight = null; return; }
    const re = GROUPS[+hl.value][1];
    const names = runners[0]?.run.head.muscles.names || [];
    stage.opts.highlight = new Set(names.filter((n) => re.test(n)));
  });
  $('#thick').addEventListener('input', (e) => { stage.opts.thickness = parseFloat(e.target.value); });
  for (const b of $$('[data-mode]')) {
    b.addEventListener('click', () => {
      stage.opts.mode = b.dataset.mode;
      for (const x of $$('[data-mode]')) x.classList.toggle('on', x === b);
      stage.applyTint();
      stage.lastFocusX = null;
      toast(b.dataset.mode === 'race' ? 'Race layout' : b.dataset.mode === 'inplace' ? 'Forward travel removed: sprinters stay in place, side by side' :
        'Forward travel removed, all in one lane, bones coloured by sprinter');
    });
  }
  for (const b of $$('[data-chart]')) {
    b.addEventListener('click', () => {
      state.chart = b.dataset.chart;
      for (const x of $$('[data-chart]')) x.classList.toggle('on', x === b);
      buildChart();
    });
  }
  const cv = $('#chart');
  cv.addEventListener('click', (e) => {
    const r = cv.getBoundingClientRect();
    const t = chartT((e.clientX - r.left) * (cv.width / r.width) / (window.devicePixelRatio || 1));
    if (t !== null) { state.time = Math.min(Math.max(t, 0), state.dur); state.playing = false; updatePlayUI(); }
  });
  window.addEventListener('keydown', (e) => {
    if (['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) && e.key !== ' ') return;
    if ($('#viewer').hidden) return;
    if (e.key === ' ') { e.preventDefault(); togglePlay(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(-1); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(1); }
    else if (e.key === 'Home') { state.time = 0; }
    else if (/^[1-6]$/.test(e.key)) setView(['broadcast', 'gait', 'behind', 'front', 'overhead', 'free'][+e.key - 1]);
    else if (e.key === 'm' || e.key === 'M') { const c = $('[data-opt="muscles"]'); c.checked = !c.checked; c.dispatchEvent(new Event('change')); }
  });
}

async function checkUpdate() {
  try {
    const c = await (await fetch('data/catalog.json', { cache: 'no-cache' })).json();
    if (c.built && c.built !== CAT.built) $('#update').hidden = false;
  } catch (e) { /* offline: try again later */ }
}

function setupIntro() {
  const el = $('#intro');
  let seen = false;
  try { seen = localStorage.getItem('sp3d-intro') === '1'; } catch (e) { /* storage may be blocked */ }
  if (seen || state.tab !== 'main') { el.hidden = true; return; }
  el.hidden = false;
  $('#bigplay').hidden = true;
  const close = (play) => {
    el.hidden = true;
    try { localStorage.setItem('sp3d-intro', '1'); } catch (e) { /* ignore */ }
    if (play) togglePlay(); else updatePlayUI();
  };
  $('#introPlay').addEventListener('click', () => close(true));
  $('#introClose').addEventListener('click', () => close(false));
}

function setView(v) {
  stage.setView(v);
  for (const b of $$('#views button')) b.classList.toggle('on', b.dataset.view === v);
  if (v === 'gait') toast(`Close view of ${runners[state.sel]?.label || 'the selected sprinter'} alone; choose another in the race table`);
  if (v === 'free') toast('Drag to orbit, right-drag to pan, scroll to zoom; the view keeps following the race');
}

function togglePlay() {
  if (!runners.length) return;
  if (!state.playing && state.time >= state.dur - 1e-6) state.time = 0;
  state.playing = !state.playing;
  updatePlayUI();
}

function step(n) {
  state.playing = false;
  state.time = Math.min(Math.max(state.time + n / 30, 0), state.dur);
  updatePlayUI();
}

function updatePlayUI() {
  const ico = state.playing ? '<path d="M6 5h4v14H6zm8 0h4v14h-4z"/>' : '<path d="M8 5v14l11-7z"/>';
  $('#play svg').innerHTML = ico;
  $('#bigplay').hidden = state.playing || (state.time > 0.01 && state.time < state.dur - 1e-6) || !$('#intro').hidden;
  $('#bigplay').setAttribute('aria-label', state.time >= state.dur - 1e-6 ? 'Replay' : 'Play');
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('on'), 2600);
}

function buildTicks() {
  const el = $('#ticks');
  el.innerHTML = '';
  for (let s = 0; s <= Math.floor(state.dur); s += 2) {
    const i = document.createElement('i');
    i.style.left = `${(s / state.dur) * 100}%`;
    i.textContent = `${s} s`;
    el.appendChild(i);
  }
}

// ---------------------------------------------------------------------------------------------------------------
function buildPick() {
  const el = $('#pick');
  const who = runners.map((r, i) => `<li style="--c:${r.color}" title="${r.about || ''}"><span class="sw">${r.num}</span><span><b>${r.short}</b>${r.on ? ' · <i>on</i>' : ''}${r.unregistered ? ' · <i>not registered</i>' : ''}</span>` +
    `<input type="checkbox" data-vis="${i}" ${r.visible ? 'checked' : ''} title="Show or hide" aria-label="Show ${r.label}"></li>`).join('');
  if (state.tab === 'main') {
    const pairs = CAT.main.pairs.map((p) => `<button data-pair="${p.k}" class="${p.k === state.pair ? 'on' : ''} fam${p.base}" ${p.off.twin ? '' : 'disabled'} title="Pair ${p.k}: copies of trained sprinter ${p.base}">${p.k}<i></i></button>`).join('');
    const P = CAT.main.pairs.find((p) => p.k === state.pair);
    const canOn = P.on && Object.keys(P.on).length > 0;
    const fam = [...new Set(CAT.main.pairs.map((p) => p.base))].sort();
    el.innerHTML = `<div class="pick-h"><h2>Pair ${state.pair} of ${CAT.main.pairs.length}</h2><span class="hint">copies of trained sprinter ${P.base}</span></div>
      <p class="pick-note">A pair is one repeat of the whole experiment: one trained sprinter, copied, the copies practising in different ways, then racing. ${fam.map((b, i) => `${i ? 'pairs' : 'Pairs'} ${listAnd(pairsOf(b))} are copies of trained sprinter ${b}`).join('; ')} (the coloured mark under each number).</p>
      <div class="pairs" role="group" aria-label="Pair">${pairs}</div>
      <label class="switch"><span><b>Switch the device on</b> for this race<br><span class="hint">Off by default: the study measures what each copy can do once the device is taken off. On shows them wearing it, as in practice.</span></span><input type="checkbox" id="devOn" ${state.deviceOn ? 'checked' : ''} ${canOn ? '' : 'disabled'}></label>
      <label class="switch"><span>Show the sprinter <b>before practice</b> (the original the copies were made from)</span><input type="checkbox" id="showBase" ${state.showBase ? 'checked' : ''}></label>
      <ul class="who">${who}</ul>`;
    for (const b of $$('[data-pair]', el)) b.addEventListener('click', () => { state.pair = +b.dataset.pair; state.time = 0; state.playing = false; updatePlayUI(); loadScenario(); });
    $('#devOn', el).addEventListener('change', (e) => { state.deviceOn = e.target.checked; state.time = 0; state.playing = false; updatePlayUI(); loadScenario(); });
    $('#showBase', el).addEventListener('change', (e) => { state.showBase = e.target.checked; loadScenario(); });
  } else if (state.tab === 'cond') {
    const groups = CAT.conditions.groups.map((g) => `<div class="grp">${g.title}</div>` + g.items.map((c) =>
      `<button data-cond="${c.key}" class="${c.key === state.cond ? 'on' : ''}" ${c.available ? '' : 'disabled'}><span>${c.label}</span><span class="g" title="Registered gain of the device-in-half sprinter over its twin">${c.reg ? sg(c.reg.mix.m) : ''}</span></button>`).join('')).join('');
    el.innerHTML = `<div class="pick-h"><h2>Pair 1, under changed conditions</h2></div>
      <p class="pick-note">Pick a condition the sprinters never met in practice. The number on the right is the official gain of the half-device copies over their twins under that condition (all ${CAT.main.n_pairs} pairs).</p>
      <div class="conds">${groups}</div><ul class="who">${who}</ul>`;
    for (const b of $$('[data-cond]', el)) b.addEventListener('click', () => { state.cond = b.dataset.cond; state.time = 0; state.playing = false; updatePlayUI(); loadScenario(); });
  } else if (state.tab === 'oct') {
    const races = CAT.oct23.map((r) => `<button data-oct="${r.key}" class="${r.key === state.oct ? 'on' : ''}"><b>${r.title}</b><span>${r.sub}</span></button>`).join('');
    el.innerHTML = `<div class="pick-h"><h2>Races from the 23 Oct slides</h2></div><div class="races">${races}</div><ul class="who">${who}</ul>`;
    for (const b of $$('[data-oct]', el)) b.addEventListener('click', () => { state.oct = b.dataset.oct; state.time = 0; state.playing = false; updatePlayUI(); loadScenario(); });
  }
  for (const c of $$('[data-vis]', el)) {
    c.addEventListener('change', () => {
      const r = runners[+c.dataset.vis];
      r.visible = c.checked;
      if (c.checked) state.hidden.delete(r.key); else state.hidden.add(r.key);
      stage.lastFocusX = null;
    });
  }
}

function buildHud() {
  let t = '';
  if (state.tab === 'main') {
    const P = CAT.main.pairs.find((p) => p.k === state.pair);
    t = `<b>Pair ${state.pair}: copies of trained sprinter ${P.base}, racing with the device ${state.deviceOn ? '<u>switched on</u>' : 'taken off'}</b><br><span class="k">They started identical and practised equally long; only the kind of practice differed</span>`;
  }
  if (state.tab === 'cond') { const C = condItem(state.cond); t = `<b>Pair 1 under a changed condition: ${C ? C.label.toLowerCase() : ''}</b><br><span class="k">Device taken off; none of them met this condition in practice</span>`; }
  if (state.tab === 'oct') { const R = CAT.oct23.find((r) => r.key === state.oct); t = `<b>${R.title}</b> · 23 Oct slides<br><span class="k">Recorded 22 Oct, before the 25 Oct simulator corrections</span>`; }
  $('#hudTitle').innerHTML = t;
}

// ---------------------------------------------------------------------------------------------------------------
function buildBoard() {
  const tb = $('#board tbody');
  const ref = runners[refIndex()];
  $('#gapHead').textContent = `Gap to ${ref ? ref.short : ''}`;
  tb.innerHTML = runners.map((r, i) => `<tr data-i="${i}" class="${i === state.sel ? 'sel' : ''}" style="--c:${r.color}"><td><span class="sw">${r.num}</span></td><td>${r.short}</td><td class="dist"></td><td class="gap"></td><td class="spd"></td><td class="opt stp"></td><td class="opt rate"></td></tr>`).join('');
  for (const tr of $$('tr', tb)) {
    tr.addEventListener('click', () => {
      state.sel = +tr.dataset.i;
      stage.selected = state.sel;
      for (const x of $$('tr', tb)) x.classList.toggle('sel', x === tr);
      if (stage.view === 'gait') toast(`Close view of ${runners[state.sel].label}`);
    });
  }
  $('#boardHint').textContent = runners.some((r) => r.on) ? 'device on' : '';
  $('#boardNote').textContent = 'One recorded start per sprinter. Registered numbers (see the text below and Results) average 256 starts.';
}

let lastBoard = 0;
function updateBoard(now) {
  if (now - lastBoard < 90) return;
  lastBoard = now;
  const rows = $$('#board tbody tr');
  const ref = runners[refIndex()];
  const refD = ref ? distAt(ref, state.time) : 0;
  let lead = -1, best = -Infinity;
  runners.forEach((r, i) => { const d = distAt(r, state.time); if (r.visible && d > best) { best = d; lead = i; } });
  runners.forEach((r, i) => {
    const tr = rows[i];
    if (!tr) return;
    const d = distAt(r, state.time);
    const fi = frameAt(r.run, state.time);
    const sp = r.run.speed[Math.round(fi)];
    const st = recentSteps(r.run, state.time);
    const ended = r.run.fell && r.run.duration < state.dur - 1e-6 && state.time >= r.run.duration - 1e-6;
    tr.querySelector('.dist').innerHTML = `<span class="${i === lead ? 'lead' : ''}">${d.toFixed(2)} m</span>`;
    const g = d - refD;
    tr.querySelector('.gap').innerHTML = r === ref ? '<span class="hint">ref.</span>' : `<span class="${g > 0.005 ? 'pos' : g < -0.005 ? 'neg' : ''}">${sg(g)}</span>`;
    tr.querySelector('.spd').innerHTML = ended ? `<span class="fell" title="The simulator ended this run early">ended ${r.run.duration.toFixed(1)} s</span>` : `${sp.toFixed(1)} m/s`;
    tr.querySelector('.stp').textContent = st ? `${st.len.toFixed(2)} m` : '–';
    tr.querySelector('.rate').textContent = st ? `${st.rate.toFixed(2)}/s` : '–';
    tr.style.opacity = r.visible ? 1 : 0.45;
  });
}

function distAt(r, time) {
  const fi = frameAt(r.run, time);
  const f0 = Math.floor(fi), f1 = Math.min(f0 + 1, r.run.F - 1), w = fi - f0;
  return r.run.dist[f0] * (1 - w) + r.run.dist[f1] * w;
}

function labelTexts() {
  return runners.map((r) => {
    const d = distAt(r, state.time);
    const ended = r.run.fell && r.run.duration < state.dur - 1e-6 && state.time >= r.run.duration - 1e-6;
    return ended ? `${d.toFixed(1)} m · run ended` : `${d.toFixed(1)} m`;
  });
}

// ---------------------------------------------------------------------------------------------------------------
const chart = { series: [], x0: 38, x1: 0, y0: 0, y1: 0, ymin: 0, ymax: 1, img: null };

function chartRegs() {
  if (state.tab !== 'main' || state.chart !== 'gap') return [];
  const P = CAT.main.pairs.find((p) => p.k === state.pair);
  const vals = state.deviceOn ? P.reg_on : P.reg;
  return runners.filter((r) => r.visible && vals[r.key] !== undefined).map((r) => ({ color: r.color, v: vals[r.key] }));
}

function buildChart() {
  const cv = $('#chart');
  const dpr = window.devicePixelRatio || 1;
  const W = cv.clientWidth || 360, H = 170;
  cv.width = W * dpr; cv.height = H * dpr;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  const ref = runners[refIndex()];
  const isGap = state.chart === 'gap';
  $('#chartTitle').textContent = isGap ? `Gap to ${ref ? ref.short : ''} over time` : 'Speed over time (1 s average)';
  chart.series = runners.map((r) => {
    const n = isGap ? Math.min(r.run.F, ref.run.F) : r.run.F;
    const y = new Float32Array(n);
    for (let f = 0; f < n; f++) y[f] = isGap ? r.run.dist[f] - ref.run.dist[f] : r.run.speed[f];
    return { r, t: r.run.t, y, n };
  });
  let lo = isGap ? -0.2 : 0, hi = isGap ? 0.2 : 1;
  const regs = chartRegs();
  for (const g of regs) { lo = Math.min(lo, g.v); hi = Math.max(hi, g.v); }
  for (const s of chart.series) {
    if (!s.r.visible) continue;
    for (let f = 0; f < s.n; f++) { lo = Math.min(lo, s.y[f]); hi = Math.max(hi, s.y[f]); }
  }
  const pad = (hi - lo) * 0.08;
  chart.ymin = lo - pad; chart.ymax = hi + pad;
  Object.assign(chart, { x0: 38, x1: W - (regs.length ? 12 + 8 * regs.length : 10), y0: 10, y1: H - 22, W, H, dpr });
  // static part, drawn once and cached
  g.clearRect(0, 0, W, H);
  g.font = '11px "Segoe UI", system-ui, sans-serif';
  g.fillStyle = '#8a96a3'; g.strokeStyle = '#eef2f6'; g.lineWidth = 1;
  const yT = niceTicks(chart.ymin, chart.ymax, 4);
  for (const v of yT) {
    const y = cy(v);
    g.beginPath(); g.moveTo(chart.x0, y); g.lineTo(chart.x1, y); g.stroke();
    g.textAlign = 'right'; g.textBaseline = 'middle'; g.fillText(v.toFixed(Math.abs(yT[1] - yT[0]) < 1 ? 1 : 0), chart.x0 - 5, y);
  }
  if (isGap) { g.strokeStyle = '#b8c3cf'; g.beginPath(); g.moveTo(chart.x0, cy(0)); g.lineTo(chart.x1, cy(0)); g.stroke(); }
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (let s = 0; s <= Math.ceil(state.dur); s += 2) g.fillText(`${s} s`, cx(s), chart.y1 + 6);
  g.save(); g.translate(10, (chart.y0 + chart.y1) / 2); g.rotate(-Math.PI / 2); g.textAlign = 'center'; g.textBaseline = 'top';
  g.fillText(isGap ? 'm' : 'm/s', 0, -2); g.restore();
  for (const s of chart.series) {
    if (!s.r.visible) continue;
    g.strokeStyle = s.r.color; g.lineWidth = s.r === ref ? 1.2 : 2; g.globalAlpha = s.r === ref && isGap ? 0.6 : 1;
    g.beginPath();
    for (let f = 0; f < s.n; f++) { const x = cx(s.t[f] - s.t[0]), y = cy(s.y[f]); if (f) g.lineTo(x, y); else g.moveTo(x, y); }
    g.stroke(); g.globalAlpha = 1;
  }
  regs.forEach((r, k) => {
    const x = chart.x1 + 8 + 8 * k, y = cy(r.v);
    g.fillStyle = r.color; g.strokeStyle = '#fff'; g.lineWidth = 1.5;
    g.beginPath(); g.moveTo(x, y - 6); g.lineTo(x + 4.5, y); g.lineTo(x, y + 6); g.lineTo(x - 4.5, y); g.closePath(); g.fill(); g.stroke();
  });
  $('#chartNote').textContent = regs.length
    ? `◆ right edge: this pair's registered gain over its twin (${CAT.main.n_starts} starts, two repeats). Click the chart to jump to a moment.`
    : 'Click the chart to jump to that moment.';
  chart.img = g.getImageData(0, 0, cv.width, cv.height);
}

function cx(t) { return chart.x0 + (t / Math.max(state.dur, 1e-6)) * (chart.x1 - chart.x0); }
function cy(v) { return chart.y1 - ((v - chart.ymin) / (chart.ymax - chart.ymin)) * (chart.y1 - chart.y0); }
function chartT(px) { if (px < chart.x0 - 4 || px > chart.x1 + 4) return null; return ((px - chart.x0) / (chart.x1 - chart.x0)) * state.dur; }
function niceTicks(lo, hi, n) {
  const span = hi - lo, raw = span / n, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const stepv = [1, 2, 2.5, 5, 10].map((k) => k * mag).find((k) => span / k <= n + 1) || 10 * mag;
  const out = [];
  for (let v = Math.ceil(lo / stepv) * stepv; v <= hi + 1e-9; v += stepv) out.push(Math.abs(v) < 1e-9 ? 0 : v);
  return out;
}

function drawChart() {
  const cv = $('#chart');
  if (!chart.img) return;
  const g = cv.getContext('2d', { willReadFrequently: true });
  g.putImageData(chart.img, 0, 0);
  g.setTransform(chart.dpr, 0, 0, chart.dpr, 0, 0);
  const x = cx(state.time);
  g.strokeStyle = '#1b2531'; g.lineWidth = 1; g.setLineDash([3, 3]);
  g.beginPath(); g.moveTo(x, chart.y0); g.lineTo(x, chart.y1); g.stroke(); g.setLineDash([]);
  for (const s of chart.series) {
    if (!s.r.visible) continue;
    const fi = frameAt(s.r.run, state.time);
    const f = Math.min(Math.round(fi), s.n - 1);
    if (f < 0) continue;
    g.fillStyle = s.r.color;
    g.beginPath(); g.arc(cx(s.t[f] - s.t[0]), cy(s.y[f]), 3.5, 0, Math.PI * 2); g.fill();
  }
}

// ---------------------------------------------------------------------------------------------------------------
let groupIdx = null, lastGroups = 0;
function updateMuscles(now) {
  if (now - lastGroups < 90) return;
  lastGroups = now;
  const r = runners[state.sel];
  const el = $('#groups');
  if (!r) return;
  const names = r.run.head.muscles.names;
  if (!groupIdx || groupIdx.names !== names) {
    groupIdx = { names, g: GROUPS.map(([lab, re]) => ({ lab, r: names.map((n, j) => (re.test(n) && n.endsWith('_r') ? j : -1)).filter((j) => j >= 0),
      l: names.map((n, j) => (re.test(n) && n.endsWith('_l') ? j : -1)).filter((j) => j >= 0) })) };
    el.innerHTML = '<div class="g hd"><span></span><span>right leg</span><span>left leg</span></div>' +
      groupIdx.g.map((g) => `<div class="g"><span>${g.lab}</span><div class="b"><i></i></div><div class="b"><i></i></div></div>`).join('');
  }
  $('#muscleWho').innerHTML = `<span style="color:${r.color};font-weight:650">${r.num} · ${r.short}</span>`;
  const fi = frameAt(r.run, state.time), M = r.run.M;
  const f0 = Math.floor(fi), f1 = Math.min(f0 + 1, r.run.F - 1), w = fi - f0;
  const a = (j) => (r.run.act[f0 * M + j] * (1 - w) + r.run.act[f1 * M + j] * w) / 255;
  const bars = $$('.g .b i', el);
  const c = new Color();
  groupIdx.g.forEach((g, k) => {
    for (const [side, list] of [[0, g.r], [1, g.l]]) {
      const v = list.length ? list.reduce((s, j) => s + a(j), 0) / list.length : 0;
      const bar = bars[2 * k + side];
      bar.style.width = `${(v * 100).toFixed(1)}%`;
      bar.style.background = activationColor(v, c).getStyle(SRGBColorSpace);
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------
function raceLine() {
  // final distances of this recording against the reference sprinter
  const ref = runners[refIndex()];
  if (!ref) return '';
  return runners.filter((r) => r !== ref && r.key !== 'base').map((r) => {
    const g = distAt(r, state.dur) - distAt(ref, state.dur);
    return `${r.short} <span class="num">${sg(g)} m</span>`;
  }).join(', ');
}

function buildExplain() {
  const el = $('#explain');
  const M = CAT.main;
  if (state.tab === 'main') {
    const P = M.pairs.find((p) => p.k === state.pair);
    const reg = (arm) => `<li style="list-style:none;margin-left:-18px"><span style="color:${CAT.arms[arm].color}">●</span> ${CAT.arms[arm].label}: ${ci(M.reg[arm])}, ahead in ${M.reg[arm].pos} of ${M.n_pairs} pairs</li>`;
    let on = '';
    if (state.deviceOn) {
      on = `<div class="note"><b>Device switched on for this race.</b> The device copies now wear it as in practice: the yellow band at the hips is the device pushing, the orange band the brake resisting (the twin and the original still have nothing). This shows help while worn, which is not what the study asks. Official averages with the device on, against the twin without it: ${['dev', 'mix', 'brake'].map((a) => `${CAT.arms[a].label.toLowerCase()} <span class="num">${sg(M.reg_on[a])} m</span>`).join(', ')}; for this pair ${['dev', 'mix', 'brake'].map((a) => `${CAT.arms[a].short.toLowerCase()} ${sg(P.reg_on[a])} m`).join(', ')}.</div>`;
    }
    const A = CAT.arms, b = P.base, fam = [...new Set(M.pairs.map((p) => p.base))].sort();
    const sw = M.arm_swing, rb = M.reg_base;
    // each trained sprinter's arm style in words, from its measured arm motion (rules: less than half the other arm's swing,
    // or less than half the elbow bend of the first half of the race)
    const armDesc = (f) => {
      const x = sw[f], parts = [];
      if (x.l_swing_2 < 0.5 * x.r_swing_2) parts.push('hardly swings its left arm');
      else if (x.r_swing_2 < 0.5 * x.l_swing_2) parts.push('hardly swings its right arm');
      const lS = x.l_elbow_2 < 0.5 * x.l_elbow_1, rS = x.r_elbow_2 < 0.5 * x.r_elbow_1;
      if (lS && rS) parts.push(`keeps both elbows almost straight once it reaches top speed, the ${x.l_elbow_2 <= x.r_elbow_2 ? 'left' : 'right'} one most`);
      else if (lS) parts.push('keeps its left elbow almost straight once it reaches top speed');
      else if (rS) parts.push('keeps its right elbow almost straight once it reaches top speed');
      return parts.length ? parts.join(', and ') : 'swings and bends both arms throughout the race';
    };
    const minMix = fam.reduce((x, f) => (rb.mix[f] < rb.mix[x] ? f : x), fam[0]);
    const minBrake = fam.reduce((x, f) => (rb.brake[f] < rb.brake[x] ? f : x), fam[0]);
    const armRows = fam.map((f) => `<tr><td>Trained sprinter ${f}<br><span class="hint">pairs ${listAnd(pairsOf(f))}</span></td>` +
      ['l', 'r'].map((s) => `<td>${sw[f][s + '_swing_2']}°<br><span class="hint">elbow ${sw[f][s + '_elbow_1']}° → ${sw[f][s + '_elbow_2']}°</span></td>`).join('') + '</tr>').join('');
    const dot = (a) => `<span style="color:${A[a].color}">●</span>`;
    el.innerHTML = `<h2>What you are watching</h2>
      <p class="big">Five copies of one sprinter race each other. They started out identical and practised for exactly as long; the only thing that differed was <b>how they practised</b>. So whoever pulls ahead shows which kind of practice worked better.</p>
      <h3>How this race was made</h3>
      <ol class="steps">
        <li><b>One trained sprinter.</b> A simulated sprinter (${M.n_muscles} muscles, moved by a neural network) was trained until it ran well: ${M.base_steps.toLocaleString('en')} training rounds. ${dot('base')} <b>${A.base.label}</b> (lane 2) is that sprinter as it was.</li>
        <li><b>Four copies practise for the same time, in different ways.</b> Each copy got ${CAT.practice_steps.toLocaleString('en')} more training rounds, about ${minutes(CAT.practice_steps)} minutes of running:
          <ul class="how">
            <li>${dot('twin')} <b>${A.twin.label}</b> (lane 3): normal practice, nothing attached. It is the yardstick for the others.</li>
            <li>${dot('mix')} <b>${A.mix.label}</b> (lane 4): a hip device that adds push at both hips, switched on in a random half of its practice runs.</li>
            <li>${dot('brake')} <b>${A.brake.label}</b> (lane 5): a brake that resists the hips, in a random half of its practice runs.</li>
            <li>${dot('dev')} <b>${A.dev.label}</b> (lane 6): the hip device on in every practice run.</li>
          </ul></li>
        <li><b>The race: device taken off.</b> All five run for 10 s with nothing attached, from the same running start (${M.start_speed} m/s). The device was only a practice tool; what counts is what each copy can now do on its own.</li>
      </ol>
      ${on}
      <h3>What to look for</h3>
      <p>Compare every lane with the twin (lane 3). In most pairs the half-device and half-brake copies pull ahead over the 10 s, and the always-device copy falls behind: it got used to the help and runs worse without it. The race table above gives every gap live, and the chart shows the gap growing; the diamonds at the chart's right edge are this pair's official averages.</p>
      <h3>Why there are ${M.n_pairs} pairs</h3>
      <p>One race could be luck, so the whole experiment was repeated ${M.n_pairs} times, each time with its own random practice. And so that it is not one sprinter's quirk, the copies come from ${M.n_bases} sprinters trained separately: ${fam.map((f) => `pairs ${listAnd(pairsOf(f))} from trained sprinter ${f}`).join('; ')}. This is pair ${state.pair}, from trained sprinter ${b}.</p>
      <h3>The result over all ${M.n_pairs} pairs</h3>
      <ul class="res">
        <li>${dot('mix')} <b>${A.mix.label}:</b> ${ci(M.reg.mix)} ahead of its twin on average; ahead in ${M.reg.mix.pos} of ${M.n_pairs} pairs.</li>
        <li>${dot('brake')} <b>${A.brake.label}:</b> ${ci(M.reg.brake)}; ahead in ${M.reg.brake.pos} of ${M.n_pairs} pairs.</li>
        <li>${dot('dev')} <b>${A.dev.label}:</b> ${ci(M.reg.dev)}; behind in ${M.n_pairs - M.reg.dev.pos} of ${M.n_pairs} pairs.</li>
      </ul>
      <p class="fine">Distances after 10 s; brackets: the 95% range of the average. Each copy raced from ${M.n_starts} slightly different starts, twice, and these are the official, pre-registered averages. For comparison, the twins themselves improved by <span class="num">${sg(M.twin_gain)} m</span> from their practice, so practising with the device in half the runs roughly doubled what the same practice gave.</p>
      <h3>This pair</h3>
      <p>Official averages for pair ${state.pair} (${M.n_starts} starts): ${['mix', 'brake', 'dev'].map((a) => `${A[a].short.toLowerCase()} <span class="num">${sg(P.reg[a])} m</span>`).join(', ')}. In the single race shown here, at the end: ${raceLine()}.</p>
      <p>Average of the ${pairsOf(b).length} pairs from trained sprinter ${b}: half device <span class="num">${sg(rb.mix[b])} m</span>, half brake <span class="num">${sg(rb.brake[b])} m</span>, always device <span class="num">${sg(rb.dev[b])} m</span>.</p>
      <h3>Things you may notice</h3>
      <ul class="how">
        <li><b>The arms.</b> Each trained sprinter learned its own way of moving its arms, and every copy of it inherits that style, with or without the device.${fam.map((f) => ` Trained sprinter ${f} (pairs ${listAnd(pairsOf(f))}) ${armDesc(f)}.`).join('')} Training rewards only forward speed, staying in the lane and avoiding joint limits; the arms hardly change the speed, so nothing pushes them toward a human-like swing. The gain still appears for all ${M.n_bases} trained sprinters, ${minMix === minBrake ? `smallest for trained sprinter ${minMix} (half device ${sg(rb.mix[minMix])} m, half brake ${sg(rb.brake[minBrake])} m)` : `smallest for trained sprinter ${minMix} with the device in half the runs (${sg(rb.mix[minMix])} m) and for trained sprinter ${minBrake} with the brake (${sg(rb.brake[minBrake])} m)`}.
          <table class="arms"><thead><tr><th></th><th>left arm</th><th>right arm</th></tr></thead><tbody>${armRows}</tbody></table>
          <span class="fine">Shoulder swing at top speed (second half of the race), and how far the elbow bends in the first half → the second half; degrees, median over all of that sprinter's recordings.</span></li>
        <li><b>The start.</b> The race begins at a run (${M.start_speed} m/s), not from blocks, as in the study.</li>
        <li><b>Footprints</b> mark every foot strike, so step lengths can be compared; the table gives step length and steps per second.</li>
      </ul>`;
  } else if (state.tab === 'cond') {
    const C = condItem(state.cond);
    if (!C) { el.innerHTML = ''; return; }
    const R = CAT.conditions.ref;
    el.innerHTML = `<h2>What you are watching</h2>
      <p class="big">The four practised copies of pair 1 race again with the device taken off, but now the race itself is changed: <b>${C.label.toLowerCase()}</b>. None of them ever met this in practice. If what they gained in practice is real skill, it should carry over to a situation they never trained for.</p>
      <h3>What is changed</h3>
      <p>${C.desc}</p>
      <h3>Who is racing</h3>
      <ul class="how">${['twin', 'mix', 'brake', 'dev'].map((a) => `<li><span style="color:${CAT.arms[a].color}">●</span> <b>${CAT.arms[a].label}:</b> ${CAT.arms[a].about}</li>`).join('')}</ul>
      <h3>What to look for</h3>
      <p>As in the main test, compare each lane with the twin. The official number for this condition (below) is the average over all ${M.n_pairs} pairs and ${M.n_starts} starts; the race shown is one start of pair 1.</p>
      ${C.reg ? `<h3>Registered gain over the twin under this condition (${M.n_pairs} pairs)</h3>
      <ul><li>${CAT.arms.mix.label}: ${ci(C.reg.mix)}</li><li>${CAT.arms.brake.label}: ${ci(C.reg.brake)}</li></ul>
      <p class="fine">Main test, measured again with the same evaluator: device in half ${ci(R.mix)}, brake in half ${ci(R.brake)}.</p>` : ''}
      ${(C.notes || []).map((n) => `<div class="note">${n}</div>`).join('')}
      <p>In the single start shown here, at the end: ${raceLine()}.</p>`;
  } else if (state.tab === 'oct') {
    const R = CAT.oct23.find((r) => r.key === state.oct);
    el.innerHTML = `<h2>What you are watching</h2>
      <p class="big">${R.title}: one of the three races shown at the 23 Oct meeting, the same recordings, now in 3D.</p>
      <p>${R.desc}</p>
      <h3>Who is racing</h3>
      <ul class="how">${R.runners.map((x) => `<li><span style="color:${x.color}">●</span> <b>${x.label}</b>${x.gear ? ' (device on: yellow band at the hips)' : ''}</li>`).join('')}</ul>
      <div class="note">${CAT.oct23_note}</div>
      <p>At the end of this recording: ${raceLine()}.</p>`;
  }
}

// ---------------------------------------------------------------------------------------------------------------
function svgForest(rows, { xmin, xmax, w = 1060, rowH = 24, left = 330, onClick } = {}) {
  const right = 70, top = 26, H = top + rows.length * rowH + 30;
  const X = (v) => left + ((v - xmin) / (xmax - xmin)) * (w - left - right);
  const ticks = niceTicks(xmin, xmax, 8);
  let s = `<svg class="plot" viewBox="0 0 ${w} ${H}" role="img">`;
  for (const t of ticks) s += `<line class="grid" x1="${X(t)}" x2="${X(t)}" y1="${top - 6}" y2="${H - 26}"/><text class="lab" x="${X(t)}" y="${H - 10}" text-anchor="middle">${f2(t, 1)}</text>`;
  s += `<line class="ax" x1="${X(0)}" x2="${X(0)}" y1="${top - 10}" y2="${H - 26}" stroke-width="1.5"/>`;
  rows.forEach((r, i) => {
    const y = top + i * rowH + rowH / 2;
    if (r.head) { s += `<text x="8" y="${y + 4}" font-weight="650">${r.head}</text>`; return; }
    const clk = r.click ? ` class="clk" data-click="${r.click}"` : '';
    s += `<g${clk}><rect class="hov" x="0" y="${y - rowH / 2}" width="${w}" height="${rowH}" fill="transparent"/>`;
    s += `<text x="20" y="${y + 4}">${r.label}${r.click ? ' <tspan fill="#1a4f8a">▸</tspan>' : ''}</text>`;
    for (const [k, c] of r.items) {
      const dy = r.items.length > 1 ? (k === 0 ? -4 : 4) : 0;
      s += `<line x1="${X(c.lo)}" x2="${X(c.hi)}" y1="${y + dy}" y2="${y + dy}" stroke="${c.color}" stroke-width="2.4"/>`;
      s += `<circle cx="${X(c.m)}" cy="${y + dy}" r="4.2" fill="${c.color}"/>`;
    }
    s += `<text class="lab" x="${w - 8}" y="${y + 4}" text-anchor="end">${r.items.map(([, c]) => sg(c.m)).join(' / ')}</text></g>`;
  });
  s += '</svg>';
  return s;
}

function buildResults() {
  const el = $('#results');
  const M = CAT.main, A = CAT.arms;
  const big = ['mix', 'brake', 'dev'].map((a) => `<div class="card" style="--c:${A[a].color}"><div class="l">${A[a].label}</div>
    <div class="v">${sg(M.reg[a].m)} m</div><div class="s">95% interval ${f2(M.reg[a].lo)} to ${f2(M.reg[a].hi)} m · ahead of its twin in ${M.reg[a].pos} of ${M.n_pairs} pairs</div></div>`).join('');
  // per-pair dots
  const w = 1060, left = 230, right = 30, top = 24, rowH = 64;
  const all = M.pairs.flatMap((p) => ['mix', 'brake', 'dev'].map((a) => p.reg[a]));
  const xmin = Math.floor(Math.min(...all, M.reg.dev.lo) - 0.3), xmax = Math.ceil(Math.max(...all, M.reg.mix.hi) + 0.3);
  const X = (v) => left + ((v - xmin) / (xmax - xmin)) * (w - left - right);
  const H = top + 3 * rowH + 36;
  let s = `<svg class="plot" viewBox="0 0 ${w} ${H}">`;
  for (const t of niceTicks(xmin, xmax, 10)) s += `<line class="grid" x1="${X(t)}" x2="${X(t)}" y1="${top - 8}" y2="${H - 30}"/><text class="lab" x="${X(t)}" y="${H - 12}" text-anchor="middle">${f2(t, 1)} m</text>`;
  s += `<line class="ax" x1="${X(0)}" x2="${X(0)}" y1="${top - 12}" y2="${H - 30}" stroke-width="1.5"/><text class="lab" x="${X(0) + 4}" y="${top - 12}">twin</text>`;
  ['mix', 'brake', 'dev'].forEach((a, i) => {
    const y = top + i * rowH + rowH / 2, c = M.reg[a];
    s += `<text x="8" y="${y + 4}" font-weight="650">${A[a].label}</text>`;
    s += `<rect x="${X(c.lo)}" y="${y - 13}" width="${X(c.hi) - X(c.lo)}" height="26" rx="5" fill="${A[a].color}" opacity="0.13"/>`;
    s += `<line x1="${X(c.m)}" x2="${X(c.m)}" y1="${y - 16}" y2="${y + 16}" stroke="${A[a].color}" stroke-width="3"/>`;
    M.pairs.forEach((p, j) => {
      const jit = ((j % 4) - 1.5) * 5;
      s += `<g class="clk" data-click="main/p${p.k}"><circle cx="${X(p.reg[a])}" cy="${y + jit}" r="6.5" fill="#fff" stroke="${A[a].color}" stroke-width="2"/><text x="${X(p.reg[a])}" y="${y + jit + 3.5}" text-anchor="middle" font-size="8.5" fill="${A[a].color}">${p.k}</text><title>Pair ${p.k}: ${sg(p.reg[a])} m (open in 3D)</title></g>`;
    });
  });
  s += '</svg>';
  // conditions forest
  const rows = [];
  for (const g of CAT.conditions.forest) {
    rows.push({ head: g.title });
    for (const r of g.rows) rows.push({ label: r.label, click: r.key && condItem(r.key)?.available ? `cond/${r.key}` : (r.key === 'again' ? 'main/p1' : null),
      items: [[0, { ...r.mix, color: A.mix.color }], [1, { ...r.brake, color: A.brake.color }]] });
  }
  const lo = Math.min(...rows.filter((r) => r.items).flatMap((r) => r.items.map(([, c]) => c.lo)));
  const hi = Math.max(...rows.filter((r) => r.items).flatMap((r) => r.items.map(([, c]) => c.hi)));
  const forest = svgForest(rows, { xmin: Math.floor(Math.min(lo, 0) * 2) / 2, xmax: Math.ceil(hi * 2) / 2 });
  // tuned twins
  const B = CAT.b0;
  let b0 = '';
  if (B && B.recipes.length) {
    const bw = 1060, bl = 330, br = 70, bt = 20, bh = 26, bH = bt + B.recipes.length * bh + 40;
    const bmin = Math.min(-0.5, ...B.recipes.map((r) => r.G)) - 0.2, bmax = Math.max(B.ref.m, ...B.recipes.map((r) => r.G)) + 0.2;
    const BX = (v) => bl + ((v - bmin) / (bmax - bmin)) * (bw - bl - br);
    b0 = `<svg class="plot" viewBox="0 0 ${bw} ${bH}">`;
    for (const t of niceTicks(bmin, bmax, 8)) b0 += `<line class="grid" x1="${BX(t)}" x2="${BX(t)}" y1="${bt - 6}" y2="${bH - 30}"/><text class="lab" x="${BX(t)}" y="${bH - 12}" text-anchor="middle">${f2(t, 1)}</text>`;
    b0 += `<line class="ax" x1="${BX(0)}" x2="${BX(0)}" y1="${bt - 10}" y2="${bH - 30}" stroke-width="1.5"/>`;
    b0 += `<line x1="${BX(B.ref.m)}" x2="${BX(B.ref.m)}" y1="${bt - 10}" y2="${bH - 30}" stroke="${A.mix.color}" stroke-dasharray="4 3"/><text class="lab" x="${BX(B.ref.m) - 4}" y="${bt - 10}" text-anchor="end" fill="${A.mix.color}">device in half: ${sg(B.ref.m)} m</text>`;
    B.recipes.forEach((r, i) => {
      const y = bt + i * bh + bh / 2;
      const x0 = BX(Math.min(0, r.G)), x1 = BX(Math.max(0, r.G));
      b0 += `<text x="8" y="${y + 4}">${r.label}</text><rect x="${x0}" y="${y - 8}" width="${x1 - x0}" height="16" rx="3" fill="${r.G >= 0 ? '#0f766e' : '#9aa5b1'}"/><text class="lab" x="${bw - 8}" y="${y + 4}" text-anchor="end">${sg(r.G)} m</text>`;
    });
    b0 += '</svg>';
  }
  el.innerHTML = `<div class="wrap">
    <div><h2>Registered results of this week</h2><p class="lead">Main test: every practised sprinter against its own twin, the device removed, ${M.n_pairs} pairs (${M.n_starts} starts per sprinter, two evaluation repeats). Points and rows marked ▸ open the matching race in 3D.</p></div>
    <div class="bign">${big}</div>
    <div class="card"><h2>Each pair's gain over its twin</h2><p class="fine" style="margin-top:2px">Circles: the ${M.n_pairs} pairs (numbers); band: 95% interval; line: mean. Click a circle to watch that pair.</p>${s}</div>
    <div class="card"><h2>Checks of the main result</h2><p class="fine" style="margin-top:2px">Gain over the twin under each check (${M.n_pairs} pairs; 95% interval). <span style="color:${A.mix.color}">●</span> ${A.mix.label} <span style="color:${A.brake.color}">●</span> ${A.brake.label}.</p>${forest}</div>
    ${b0 ? `<div class="card"><h2>Could a better-trained twin close the gap?</h2><p class="fine" style="margin-top:2px">${B.caption}</p>${b0}</div>` : ''}
    <div class="card prose"><h2>How to read these numbers</h2>${CAT.reading.map((p) => `<p>${p}</p>`).join('')}</div>
  </div>`;
  for (const g of $$('[data-click]', el)) {
    g.addEventListener('click', () => {
      const [tab, arg] = g.dataset.click.split('/');
      if (tab === 'main') { state.pair = parseInt(arg.slice(1), 10); state.deviceOn = false; }
      if (tab === 'cond') state.cond = arg;
      showTab(tab);
    });
  }
}

function buildFilms() {
  const el = $('#films');
  el.innerHTML = `<div class="wrap"><div><h2>Race videos</h2><p class="lead">${CAT.films_lead}</p></div>
    <div class="films">${CAT.films.map((f) => `<div class="card"><video controls preload="metadata" playsinline poster="${f.poster}" src="${f.file}"></video><h3>${f.title}</h3><p>${f.desc}</p></div>`).join('')}</div></div>`;
}

function buildAbout() {
  $('#about').innerHTML = `<div class="wrap"><div class="card prose">${CAT.about.map((p) => p.startsWith('<h') ? p : `<p>${p}</p>`).join('')}
    <h3>Controls</h3><p><span class="kbd">Space</span> play or pause · <span class="kbd">←</span> <span class="kbd">→</span> one frame · <span class="kbd">1</span>–<span class="kbd">6</span> cameras · <span class="kbd">M</span> muscles on or off · drag in the Free view to orbit.</p>
    <p class="fine">Links keep the view: for example <code>#main/p5/on</code> opens pair 5 with the device on, <code>#cond/f1</code> the headwind test.</p></div></div>`;
}

// ---------------------------------------------------------------------------------------------------------------
let last = performance.now();
function loop(now) {
  const dt = Math.min((now - last) / 1000, 0.1);
  last = now;
  if (!$('#viewer').hidden && runners.length) {
    if (state.playing) {
      state.time += dt * state.speed;
      if (state.time >= state.dur) {
        if (state.loop) state.time = 0;
        else { state.time = state.dur; state.playing = false; updatePlayUI(); }
      }
    }
    stage.update(state.time);
    stage.render(dt);
    stage.updateLabels(labelTexts());
    $('#time').value = state.time.toFixed(3);
    $('#clock').textContent = `${state.time.toFixed(2)} s`;
    updateBoard(now);
    drawChart();
    updateMuscles(now);
  }
  requestAnimationFrame(loop);
}

window.addEventListener('resize', () => { if (runners.length) buildChart(); });
init();

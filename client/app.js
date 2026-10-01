import {
  PRESETS, add, brickBox, bricksOnPlane, indexToWorld, lookAt, multiply, perspective, planeBasis,
  planePolygon, scale, sliceLayoutCost, volumeBox, volumeCenter, volumeDiagonal, worldToIndexMatrix,
} from "./geometry.js";
import { BrickLoader, Stats, planRuns } from "./loader.js";
import { Renderer } from "./renderer.js";

const $ = (id) => document.getElementById(id);
const COARSE_LEVEL = 2;
const kb = (b) => (b < 1024 * 1024 ? `${(b / 1024).toFixed(1)} KB` : `${(b / 1024 / 1024).toFixed(2)} MB`);

// 한 캔버스(= WebGL 컨텍스트 하나)를 두 화면으로 나눈다 — 텍스처를 공유하기 위해서다
const MPR_W = 640, VIEW3D_W = 400, H = 640;
const canvas = $("view");
const dpr = Math.min(window.devicePixelRatio || 1, 2);
canvas.width = Math.round((MPR_W + VIEW3D_W) * dpr);
canvas.height = Math.round(H * dpr);
const renderer = new Renderer(canvas);
const stats = new Stats();

let m = null; // manifest
let loader = null;
let frames = []; // 시점별 { fine, mask, coarse, loaded:Set }
const view = { preset: "coronal", yaw: 0, pitch: 0, offset: 0, t: 0, lo: 0, hi: 1, showCoarse: true };
const cam = { az: 35, el: 20, dist: 2.6 }; // 3D 화면 카메라 (dist 는 볼륨 대각선 배수)
let brickLines = { key: "", points: [] };
let timing = {};
let needed = [];
let compare = null;
let playing = null;
let dirty = true;

async function openDataset(name) {
  for (const f of frames) for (const tex of [f.fine, f.mask, f.coarse]) renderer.deleteVolume(tex);
  renderer.bytes = 0;
  stats.reset();
  const base = `/data/out/${name}/`;
  const t0 = performance.now();
  m = await (await fetch(base + "manifest.json")).json();
  loader = new BrickLoader(base, stats);
  frames = Array.from({ length: m.timepoints }, () => ({ fine: null, mask: null, coarse: null, loaded: new Set() }));
  timing = { start: t0, manifest: performance.now() - t0, firstImage: null, plane: null, planeDone: null };
  Object.assign(view, { t: 0, yaw: 0, pitch: 0, offset: 0, preset: "coronal" }, initial);
  initial = {};
  $("time").max = m.timepoints - 1;
  $("timeRow").hidden = m.timepoints < 2;
  const half = volumeDiagonal(m) / 2;
  $("offset").min = -half;
  $("offset").max = half;
  $("info").textContent =
    `${m.source.seriesDescription} — ${m.dims.join("×")} × ${m.timepoints}시점, ` +
    `간격 ${m.spacing.map((s) => s.toFixed(2)).join("×")}mm, 블록 ${m.brick}³ ` +
    `(${m.levels[0].brickGrid.join("×")}), DICOM ${m.source.dicomFiles}장 ${kb(m.source.dicomBytes)}`;
  syncControls();
  update();
}

/** 저해상도(L2) 시점 하나를 통째로 받는다 — 첫 화면용 */
function requestCoarse(t, front) {
  const f = frames[t];
  if (f.coarse || f.coarsePending) return;
  f.coarsePending = true;
  const L = m.levels[COARSE_LEVEL];
  const shard = L.shards[t];
  const vol = new Float32Array(L.dims[0] * L.dims[1] * L.dims[2]);
  let remaining = shard.bricks.length;
  loader.request(shard, shard.bricks.map((_, i) => i), (id, voxels) => {
    copyBrick(vol, L.dims, L.brickGrid, id, voxels);
    if (--remaining) return;
    f.coarse = renderer.createVolume(L.dims);
    renderer.upload(f.coarse, [0, 0, 0], L.dims, vol);
    if (t === 0 && !m.autoWindow) autoWindow(vol);
    if (timing.firstImage == null) timing.firstImage = performance.now() - timing.start;
    dirty = true;
  }, { front });
}

function copyBrick(vol, dims, grid, id, voxels) {
  const B = m.brick;
  const [gx, gy] = grid;
  const bz = Math.floor(id / (gx * gy)), by = Math.floor((id % (gx * gy)) / gx), bx = id % gx;
  const w = Math.min(B, dims[0] - bx * B), h = Math.min(B, dims[1] - by * B), d = Math.min(B, dims[2] - bz * B);
  for (let z = 0; z < d; z++)
    for (let y = 0; y < h; y++) {
      const src = (z * h + y) * w;
      const dst = ((bz * B + z) * dims[1] + by * B + y) * dims[0] + bx * B;
      for (let x = 0; x < w; x++) vol[dst + x] = voxels[src + x];
    }
}

/** 첫 시점의 저해상도 볼륨으로 window 를 정한다 (1% ~ 99.5% 분위) */
function autoWindow(vol) {
  const sorted = Float32Array.from(vol).sort();
  view.lo = sorted[Math.floor(sorted.length * 0.01)];
  view.hi = sorted[Math.floor(sorted.length * 0.995)];
  m.autoWindow = true;
}

/** L0 블록을 받아 해당 영역만 텍스처에 올린다 */
function requestFine(t, ids, front) {
  const f = frames[t];
  const L = m.levels[0];
  loader.request(L.shards[t], ids, (id, voxels) => {
    if (!f.fine) {
      f.fine = renderer.createVolume(m.dims);
      f.mask = renderer.createVolume(L.brickGrid, "R8");
    }
    const B = m.brick;
    const [gx, gy] = L.brickGrid;
    const bz = Math.floor(id / (gx * gy)), by = Math.floor((id % (gx * gy)) / gx), bx = id % gx;
    const size = [
      Math.min(B, m.dims[0] - bx * B), Math.min(B, m.dims[1] - by * B), Math.min(B, m.dims[2] - bz * B),
    ];
    renderer.upload(f.fine, [bx * B, by * B, bz * B], size, Float32Array.from(voxels));
    renderer.upload(f.mask, [bx, by, bz], [1, 1, 1], new Uint8Array([255]));
    f.loaded.add(id);
    if (t === view.t && timing.planeDone == null && needed.every((n) => f.loaded.has(n)))
      timing.planeDone = performance.now() - timing.plane;
    dirty = true;
  }, { front });
}

function plane() {
  const { u, v, n } = planeBasis(view.preset, view.yaw, view.pitch);
  const center = add(volumeCenter(m), scale(n, view.offset));
  // 단면이 상자와 만나는 다각형에 화면을 맞춘다 — 잘린 면이 화면을 채우도록
  const polygon = planePolygon(m, center, u, v, n);
  let viewCenter = center, fov = volumeDiagonal(m);
  if (polygon.st.length >= 3) {
    const s = polygon.st.map((q) => q[0]), t = polygon.st.map((q) => q[1]);
    const [s0, s1, t0, t1] = [Math.min(...s), Math.max(...s), Math.min(...t), Math.max(...t)];
    viewCenter = add(center, add(scale(u, (s0 + s1) / 2), scale(v, (t0 + t1) / 2)));
    fov = Math.max(s1 - s0, t1 - t0) * 1.04;
  }
  return { u, v, n, center, viewCenter, fov, polygon: polygon.points };
}

let compareTimer = 0;
function update() {
  if (!m) return;
  const p = plane();
  needed = bricksOnPlane(m, p.center, p.n);
  loader.clearQueue();
  requestCoarse(view.t, true);
  const f = frames[view.t];
  timing.plane = performance.now();
  timing.planeDone = needed.every((id) => f.loaded.has(id)) ? 0 : null;
  requestFine(view.t, needed);
  if (playing) {
    // 재생 중에는 다음 시점을 미리 받아둔다
    const next = (view.t + 1) % m.timepoints;
    requestCoarse(next, false);
    requestFine(next, needed);
  }
  clearTimeout(compareTimer);
  compareTimer = setTimeout(() => {
    const q = plane();
    compare = sliceLayoutCost(m, q.viewCenter, q.u, q.v, q.fov);
    const shard = m.levels[0].shards[view.t];
    compare.brickBytes = needed.reduce((s, id) => s + shard.bricks[id][1], 0);
    compare.brickRequests = planRuns(needed, shard.bricks).length;
    dirty = true;
  }, 120);
  dirty = true;
}

function frame() {
  if (dirty && m) {
    dirty = false;
    const p = plane();
    const f = frames[view.t];
    const L0 = m.levels[0], LC = m.levels[COARSE_LEVEL];
    const vol = {
      fine: f.fine, mask: f.mask, coarse: f.coarse,
      w2i: worldToIndexMatrix(m), origin: m.origin, dims: m.dims,
      grid: L0.brickGrid, brick: m.brick,
      coarseScale: LC.dims.map((d) => d * 2 ** COARSE_LEVEL),
      lo: view.lo, hi: view.hi, showCoarse: view.showCoarse,
    };
    renderer.drawMPR([0, 0, MPR_W * dpr, H * dpr], vol, { center: p.viewCenter, u: p.u, v: p.v, fov: p.fov });
    renderer.draw3D([MPR_W * dpr, 0, VIEW3D_W * dpr, H * dpr], vol, scene3D(p, f));
    renderStats();
  }
  requestAnimationFrame(frame);
}

/** 3D 위치 화면: 볼륨 상자, 받은 블록, 단면, 환자 방향 축 */
function scene3D(p, f) {
  const diag = volumeDiagonal(m);
  const target = volumeCenter(m);
  const az = (cam.az * Math.PI) / 180, el = (cam.el * Math.PI) / 180;
  // az = 0 이면 환자 앞(A, −y)에서 본다. 위쪽 = 머리(S, +z)
  const dir = [Math.sin(az) * Math.cos(el), -Math.cos(az) * Math.cos(el), Math.sin(el)];
  const eye = add(target, scale(dir, cam.dist * diag));
  const mvp = multiply(perspective(35, VIEW3D_W / H, diag * 0.05, diag * 10), lookAt(eye, target, [0, 0, 1]));

  const key = `${m.name}|${view.t}|${f.loaded.size}`;
  if (brickLines.key !== key) brickLines = { key, points: [...f.loaded].flatMap((id) => brickBox(m, id)) };

  const o = indexToWorld(m, [-0.5, -0.5, -0.5]), a = diag * 0.18;
  const axes = [
    [[o, add(o, [a, 0, 0])], [0.95, 0.35, 0.35, 1]], // L (+x)
    [[o, add(o, [0, a, 0])], [0.4, 0.85, 0.4, 1]], // P (+y)
    [[o, add(o, [0, 0, a])], [0.4, 0.6, 1.0, 1]], // S (+z)
  ];
  return { mvp, polygon: p.polygon, box: volumeBox(m), bricks: brickLines.points, axes };
}

function renderStats() {
  const f = frames[view.t];
  const total = m.levels[0].shards[0].bricks.length;
  const loadedHere = needed.filter((id) => f.loaded.has(id)).length;
  const rawPerT = m.dims[0] * m.dims[1] * m.dims[2] * 2;
  const ms = (v) => (v == null ? "…" : `${v.toFixed(0)} ms`);
  const c = compare;
  $("stats").innerHTML = `
    <table>
      <tr><th colspan=2>현재 단면 (시점 ${view.t + 1}/${m.timepoints})</th></tr>
      <tr><td>필요한 블록</td><td>${needed.length} / ${total} (${((needed.length / total) * 100).toFixed(0)}%)</td></tr>
      <tr><td>고해상도 도착</td><td>${loadedHere} / ${needed.length}</td></tr>
      <tr><td>첫 화면 (저해상도)</td><td>${ms(timing.firstImage)}</td></tr>
      <tr><td>이 단면 고해상도 완료</td><td>${ms(timing.planeDone)}</td></tr>
      <tr><th colspan=2>누적 전송</th></tr>
      <tr><td>요청 수</td><td>${stats.requests}</td></tr>
      <tr><td>전송량 (압축)</td><td>${kb(stats.bytes)}</td></tr>
      <tr><td>복원한 복셀</td><td>${kb(stats.decoded)}</td></tr>
      <tr><td>GPU 텍스처</td><td>${kb(renderer.bytes)}</td></tr>
    </table>
    <table class="compare">
      <tr><th>이 단면을 처음부터 받는다면</th><th>요청</th><th>전송량</th></tr>
      <tr><td>블록 + Range (이 PoC)</td><td>${c ? c.brickRequests : "…"}</td><td>${c ? kb(c.brickBytes) : "…"}</td></tr>
      <tr><td>슬라이스 순서 + Range</td><td>${c ? c.requests.toLocaleString() : "…"}</td><td>${c ? kb(c.bytes) : "…"}</td></tr>
      <tr><td>볼륨 전체 (비압축)</td><td>1</td><td>${kb(rawPerT)}</td></tr>
      <tr><td>DICOM 전체 (이 시점)</td><td>${m.dims[2]}</td><td>${kb(m.source.dicomBytes / m.timepoints)}</td></tr>
    </table>`;
  $("log").textContent = stats.log.join("\n");
}

// ── 조작 ───────────────────────────────────────────
function syncControls() {
  $("offset").value = view.offset;
  $("offsetLabel").textContent = `${view.offset.toFixed(1)} mm`;
  $("yawLabel").textContent = `${view.yaw.toFixed(0)}°`;
  $("pitchLabel").textContent = `${view.pitch.toFixed(0)}°`;
  $("yaw").value = view.yaw;
  $("pitch").value = view.pitch;
  $("time").value = view.t;
  $("timeLabel").textContent = `${view.t + 1} / ${m.timepoints}`;
  for (const b of document.querySelectorAll("[data-preset]"))
    b.classList.toggle("on", b.dataset.preset === view.preset);
}

for (const b of document.querySelectorAll("[data-preset]"))
  b.onclick = () => {
    Object.assign(view, { preset: b.dataset.preset, yaw: 0, pitch: 0, offset: 0 });
    syncControls();
    update();
  };
for (const id of ["offset", "yaw", "pitch"])
  $(id).oninput = (e) => {
    view[id] = Number(e.target.value);
    update();
  };
$("time").oninput = (e) => {
  view.t = Number(e.target.value);
  syncControls();
  update();
};
$("showCoarse").onchange = (e) => {
  view.showCoarse = e.target.checked;
  dirty = true;
};
$("play").onclick = () => {
  if (playing) {
    clearInterval(playing);
    playing = null;
    $("play").textContent = "▶ 재생";
    return;
  }
  $("play").textContent = "■ 정지";
  playing = setInterval(() => {
    view.t = (view.t + 1) % m.timepoints;
    syncControls();
    update();
  }, 250);
};
$("dataset").onchange = (e) => openDataset(e.target.value);

const in3D = (e) => e.offsetX > MPR_W * (canvas.clientWidth / (MPR_W + VIEW3D_W));

canvas.addEventListener("wheel", (e) => {
  e.preventDefault();
  if (in3D(e)) {
    cam.dist = Math.max(0.6, Math.min(5, cam.dist * (1 + Math.sign(e.deltaY) * 0.1)));
    dirty = true;
    return;
  }
  view.offset += Math.sign(e.deltaY) * Math.min(...m.spacing);
  syncControls();
  update();
}, { passive: false });

let drag = null;
canvas.addEventListener("pointerdown", (e) => {
  drag = { x: e.clientX, y: e.clientY, window: e.shiftKey || e.button === 2, orbit: in3D(e) };
  canvas.setPointerCapture(e.pointerId);
});
canvas.addEventListener("pointermove", (e) => {
  if (!drag) return;
  const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (drag.orbit) {
    cam.az -= dx * 0.4;
    cam.el = Math.max(-85, Math.min(85, cam.el + dy * 0.4));
    dirty = true;
    return;
  }
  if (drag.window) {
    // 가로 = 폭, 세로 = 중심
    const width = view.hi - view.lo, center = (view.hi + view.lo) / 2;
    const w = Math.max(1, width * (1 + dx * 0.005)), c = center - dy * width * 0.003;
    view.lo = c - w / 2;
    view.hi = c + w / 2;
    dirty = true;
    return;
  }
  view.yaw = Math.max(-80, Math.min(80, view.yaw + dx * 0.3));
  view.pitch = Math.max(-80, Math.min(80, view.pitch + dy * 0.3));
  syncControls();
  update();
});
canvas.addEventListener("pointerup", () => (drag = null));
canvas.addEventListener("contextmenu", (e) => e.preventDefault());

// URL 로 상태 지정: ?ds=abd_mra&preset=axial&yaw=30&pitch=20&offset=10&t=0
const params = new URLSearchParams(location.search);
let initial = {};
for (const k of ["yaw", "pitch", "offset", "t"]) if (params.has(k)) initial[k] = Number(params.get(k));
if (params.has("preset") && PRESETS[params.get("preset")]) initial.preset = params.get("preset");
if (params.has("ds")) {
  // 목록에 없는 변형(예: 블록 크기 비교용 abd_mra_b16)도 열 수 있게 옵션을 추가한다
  const ds = params.get("ds");
  if (![...$("dataset").options].some((o) => o.value === ds)) $("dataset").add(new Option(ds, ds));
  $("dataset").value = ds;
}

window.poc = { view, cam, stats, timing: () => timing, needed: () => needed, compare: () => compare };
openDataset($("dataset").value);
requestAnimationFrame(frame);

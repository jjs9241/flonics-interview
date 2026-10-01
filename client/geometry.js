// 좌표계 계산. 환자 좌표(LPS, mm) ↔ 볼륨 인덱스(i, j, k).
//
//   world = origin + D · (spacing ⊙ ijk)        D 의 열 = manifest.direction[0..2]
//   ijk   = (Dᵀ · (world − origin)) / spacing   D 는 직교 행렬

export const add = (a, b) => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a, s) => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const len = (a) => Math.hypot(a[0], a[1], a[2]);

export function indexToWorld(m, ijk) {
  let p = m.origin;
  for (let r = 0; r < 3; r++) p = add(p, scale(m.direction[r], m.spacing[r] * ijk[r]));
  return p;
}

export function worldToIndex(m, p) {
  const d = sub(p, m.origin);
  return [0, 1, 2].map((r) => dot(m.direction[r], d) / m.spacing[r]);
}

/** GLSL mat3(열 우선) — ijk = M · (p − origin) */
export function worldToIndexMatrix(m) {
  const out = new Float32Array(9);
  for (let c = 0; c < 3; c++)
    for (let r = 0; r < 3; r++) out[c * 3 + r] = m.direction[r][c] / m.spacing[r];
  return out;
}

export function volumeCenter(m) {
  return indexToWorld(m, m.dims.map((d) => (d - 1) / 2));
}

/** 어떤 방향으로 잘라도 볼륨 전체가 들어오는 시야(mm) */
export function volumeDiagonal(m) {
  return len(m.dims.map((d, i) => (d - 1) * m.spacing[i]));
}

// 화면 기준 축: u = 화면 오른쪽, v = 화면 아래, n = 단면 법선 (LPS)
// 영상의학 관례 — axial/coronal 은 환자 오른쪽이 화면 왼쪽, sagittal 은 앞쪽이 화면 왼쪽
export const PRESETS = {
  axial: { u: [1, 0, 0], v: [0, 1, 0], n: [0, 0, 1] },
  coronal: { u: [1, 0, 0], v: [0, 0, -1], n: [0, 1, 0] },
  sagittal: { u: [0, 1, 0], v: [0, 0, -1], n: [1, 0, 0] },
};

function rotate(vec, axis, deg) {
  // 로드리게스 회전
  const a = (deg * Math.PI) / 180;
  const c = Math.cos(a), s = Math.sin(a);
  const k = scale(axis, 1 / len(axis));
  const cross = [k[1] * vec[2] - k[2] * vec[1], k[2] * vec[0] - k[0] * vec[2], k[0] * vec[1] - k[1] * vec[0]];
  return add(add(scale(vec, c), scale(cross, s)), scale(k, dot(k, vec) * (1 - c)));
}

/** 프리셋 + 기울기(yaw: 화면 세로축 기준, pitch: 화면 가로축 기준) → 단면 */
export function planeBasis(preset, yaw, pitch) {
  let { u, v, n } = PRESETS[preset];
  const turn = (x) => rotate(rotate(x, PRESETS[preset].u, pitch), PRESETS[preset].v, yaw);
  return { u: turn(u), v: turn(v), n: turn(n) };
}

/**
 * 단면과 겹치는 L0 블록 id 목록.
 * 블록 경계에서 trilinear 보간이 이웃 블록을 읽으므로 1 복셀 여유를 둔다.
 */
export function bricksOnPlane(m, center, n) {
  const B = m.brick;
  const [gx, gy, gz] = m.levels[0].brickGrid;
  const ids = [];
  for (let bz = 0; bz < gz; bz++)
    for (let by = 0; by < gy; by++)
      for (let bx = 0; bx < gx; bx++) {
        const lo = [bx * B - 1, by * B - 1, bz * B - 1];
        const hi = [
          Math.min((bx + 1) * B, m.dims[0]),
          Math.min((by + 1) * B, m.dims[1]),
          Math.min((bz + 1) * B, m.dims[2]),
        ];
        let min = Infinity, max = -Infinity;
        for (let c = 0; c < 8; c++) {
          const ijk = [c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]];
          const d = dot(n, sub(indexToWorld(m, ijk), center));
          min = Math.min(min, d);
          max = Math.max(max, d);
        }
        if (min <= 0 && max >= 0) ids.push(bz * gx * gy + by * gx + bx);
      }
  return ids;
}

/**
 * 비교용: 같은 단면을 '슬라이스 순서 비압축 파일'에서 Range 로 읽는다면?
 *
 * 화면 픽셀마다 trilinear 보간에 필요한 복셀(2×2×2)을 모은 뒤, 행(z, y)마다
 * 필요한 x 구간을 바이트 구간으로 바꾸고, 파일에서 맞닿은 구간은 합친다.
 * S3 는 요청 하나에 Range 하나만 받으므로 합친 뒤의 구간 수 = 요청 수다.
 */
export function sliceLayoutCost(m, center, u, v, fov, samples = 512) {
  const [nx, ny, nz] = m.dims;
  const rows = new Map(); // key = z * ny + y → [minX, maxX]
  for (let py = 0; py < samples; py++) {
    for (let px = 0; px < samples; px++) {
      const s = ((px + 0.5) / samples - 0.5) * fov;
      const t = ((py + 0.5) / samples - 0.5) * fov;
      const p = add(add(center, scale(u, s)), scale(v, t));
      const [x, y, z] = worldToIndex(m, p);
      if (x < -0.5 || y < -0.5 || z < -0.5 || x > nx - 0.5 || y > ny - 0.5 || z > nz - 0.5) continue;
      const x0 = Math.max(0, Math.floor(x)), x1 = Math.min(nx - 1, x0 + 1);
      const y0 = Math.max(0, Math.floor(y)), z0 = Math.max(0, Math.floor(z));
      for (const zz of [z0, Math.min(nz - 1, z0 + 1)])
        for (const yy of [y0, Math.min(ny - 1, y0 + 1)]) {
          const key = zz * ny + yy;
          const r = rows.get(key);
          if (r) {
            if (x0 < r[0]) r[0] = x0;
            if (x1 > r[1]) r[1] = x1;
          } else rows.set(key, [x0, x1]);
        }
    }
  }
  const runs = [...rows.entries()]
    .map(([key, [a, b]]) => [(key * nx + a) * 2, (key * nx + b) * 2 + 1])
    .sort((p, q) => p[0] - q[0]);
  let requests = 0, bytes = 0, end = -2;
  for (const [a, b] of runs) {
    if (a !== end + 1) requests++;
    bytes += b - a + 1;
    end = b;
  }
  return { requests, bytes };
}

// ── 3D 위치 화면용 ───────────────────────────────────

/** 인덱스 공간 상자 [lo, hi] 의 모서리 12개 → 환자 좌표 선분 쌍 */
export function boxEdges(m, lo, hi) {
  const corner = (c) => indexToWorld(m, [c & 1 ? hi[0] : lo[0], c & 2 ? hi[1] : lo[1], c & 4 ? hi[2] : lo[2]]);
  const pairs = [[0, 1], [2, 3], [4, 5], [6, 7], [0, 2], [1, 3], [4, 6], [5, 7], [0, 4], [1, 5], [2, 6], [3, 7]];
  return pairs.flatMap(([a, b]) => [corner(a), corner(b)]);
}

/** 볼륨 전체 상자 (복셀 가장자리 기준) */
export function volumeBox(m) {
  return boxEdges(m, [-0.5, -0.5, -0.5], m.dims.map((d) => d - 0.5));
}

/** L0 블록 id 의 상자 */
export function brickBox(m, id) {
  const B = m.brick;
  const [gx, gy] = m.levels[0].brickGrid;
  const bz = Math.floor(id / (gx * gy)), by = Math.floor((id % (gx * gy)) / gx), bx = id % gx;
  const lo = [bx * B - 0.5, by * B - 0.5, bz * B - 0.5];
  const hi = [0, 1, 2].map((a) => Math.min(([bx, by, bz][a] + 1) * B, m.dims[a]) - 0.5);
  return boxEdges(m, lo, hi);
}

/**
 * 단면과 볼륨 상자가 만나는 볼록 다각형.
 * 상자 모서리 12개와 평면의 교점을 구해 단면 위 각도 순으로 정렬한다.
 * @returns { points: 환자 좌표[], st: 단면 좌표 [s, t][] (u, v 기준, center 원점) }
 */
export function planePolygon(m, center, u, v, n) {
  const edges = volumeBox(m);
  const pts = [];
  for (let i = 0; i < edges.length; i += 2) {
    const a = edges[i], b = edges[i + 1];
    const da = dot(n, sub(a, center)), db = dot(n, sub(b, center));
    if ((da < 0) === (db < 0) && da !== 0) continue;
    const t = da / (da - db || 1);
    pts.push(add(a, scale(sub(b, a), t)));
  }
  if (pts.length < 3) return { points: [], st: [] };
  const st = pts.map((p) => [dot(u, sub(p, center)), dot(v, sub(p, center))]);
  const cs = st.reduce((s, q) => s + q[0], 0) / st.length, ct = st.reduce((s, q) => s + q[1], 0) / st.length;
  const order = st.map((q, i) => [Math.atan2(q[1] - ct, q[0] - cs), i]).sort((x, y) => x[0] - y[0]).map((x) => x[1]);
  return { points: order.map((i) => pts[i]), st: order.map((i) => st[i]) };
}

/** 열 우선 4×4 행렬 */
export function perspective(fovyDeg, aspect, near, far) {
  const f = 1 / Math.tan((fovyDeg * Math.PI) / 360);
  return [f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) / (near - far), -1, 0, 0, (2 * far * near) / (near - far), 0];
}

export function lookAt(eye, target, up) {
  const zAxis = scale(sub(eye, target), 1 / len(sub(eye, target)));
  const xRaw = [up[1] * zAxis[2] - up[2] * zAxis[1], up[2] * zAxis[0] - up[0] * zAxis[2], up[0] * zAxis[1] - up[1] * zAxis[0]];
  const xAxis = scale(xRaw, 1 / len(xRaw));
  const yAxis = [zAxis[1] * xAxis[2] - zAxis[2] * xAxis[1], zAxis[2] * xAxis[0] - zAxis[0] * xAxis[2], zAxis[0] * xAxis[1] - zAxis[1] * xAxis[0]];
  return [
    xAxis[0], yAxis[0], zAxis[0], 0,
    xAxis[1], yAxis[1], zAxis[1], 0,
    xAxis[2], yAxis[2], zAxis[2], 0,
    -dot(xAxis, eye), -dot(yAxis, eye), -dot(zAxis, eye), 1,
  ];
}

export function multiply(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c++)
    for (let r = 0; r < 4; r++)
      for (let k = 0; k < 4; k++) out[c * 4 + r] += a[k * 4 + r] * b[c * 4 + k];
  return out;
}

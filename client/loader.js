// 블록 로더. 필요한 블록만 Range 요청으로 받아 압축을 풀고 콜백으로 넘긴다.
//
// - shard 안에서 id 가 연속인 블록은 파일에서도 맞닿아 있으므로 Range 하나로 합친다
// - 동시 요청 수를 제한하고, 단면이 바뀌면 아직 시작 안 한 요청은 버리고 다시 짠다

const MAX_RUN = 64; // Range 하나로 합칠 최대 블록 수
const CONCURRENCY = 6; // HTTP/1.1 브라우저의 호스트당 연결 수와 맞춤

export async function inflate(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate"));
  return new Int16Array(await new Response(stream).arrayBuffer());
}

export class Stats {
  constructor() {
    this.reset();
  }
  reset() {
    this.requests = 0;
    this.bytes = 0;
    this.decoded = 0;
    this.log = [];
  }
  record(url, start, end, bricks) {
    this.requests++;
    this.bytes += end - start + 1;
    this.log.unshift(`${url}  ${start}-${end}  (${bricks}블록, ${((end - start + 1) / 1024).toFixed(1)}KB)`);
    this.log.length = Math.min(this.log.length, 8);
  }
}

/** 연속 id 를 Range 구간으로 묶는다 */
export function planRuns(ids, index) {
  const sorted = [...ids].sort((a, b) => a - b);
  const runs = [];
  for (const id of sorted) {
    const last = runs.at(-1);
    if (last && id === last.ids.at(-1) + 1 && last.ids.length < MAX_RUN) last.ids.push(id);
    else runs.push({ ids: [id] });
  }
  for (const run of runs) {
    const first = index[run.ids[0]], tail = index[run.ids.at(-1)];
    run.start = first[0];
    run.end = tail[0] + tail[1] - 1;
  }
  return runs;
}

export class BrickLoader {
  constructor(baseUrl, stats) {
    this.baseUrl = baseUrl;
    this.stats = stats;
    this.queue = [];
    this.active = 0;
    this.requested = new Set(); // `${shardUrl}#${id}` — 받았거나 받는 중
  }

  /** 아직 시작 안 한 요청을 버린다 (단면이 바뀌었을 때) */
  clearQueue() {
    for (const job of this.queue) for (const id of job.run.ids) this.requested.delete(`${job.url}#${id}`);
    this.queue = [];
  }

  /**
   * @param shard  manifest 의 { url, bricks: [[offset, length], ...] }
   * @param ids    받을 블록 id
   * @param onBrick (id, Int16Array) => void
   */
  request(shard, ids, onBrick, { front = false } = {}) {
    const todo = ids.filter((id) => !this.requested.has(`${shard.url}#${id}`));
    if (!todo.length) return 0;
    for (const id of todo) this.requested.add(`${shard.url}#${id}`);
    const jobs = planRuns(todo, shard.bricks).map((run) => ({ url: shard.url, index: shard.bricks, run, onBrick }));
    this.queue = front ? [...jobs, ...this.queue] : [...this.queue, ...jobs];
    this.pump();
    return todo.length;
  }

  pump() {
    while (this.active < CONCURRENCY && this.queue.length) {
      const job = this.queue.shift();
      this.active++;
      this.fetchRun(job)
        .catch((e) => {
          console.error(e);
          for (const id of job.run.ids) this.requested.delete(`${job.url}#${id}`);
        })
        .finally(() => {
          this.active--;
          this.pump();
        });
    }
  }

  async fetchRun({ url, index, run, onBrick }) {
    const res = await fetch(this.baseUrl + url, { headers: { Range: `bytes=${run.start}-${run.end}` } });
    if (res.status !== 206) throw new Error(`Range 미지원 응답: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    this.stats.record(url, run.start, run.end, run.ids.length);
    for (const id of run.ids) {
      const [offset, length] = index[id];
      const voxels = await inflate(buf.subarray(offset - run.start, offset - run.start + length));
      this.stats.decoded += voxels.byteLength;
      onBrick(id, voxels);
    }
  }
}

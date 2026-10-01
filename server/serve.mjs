// S3 + CloudFront 를 흉내 내는 정적 파일 서버. 의존성 없음.
//
// - 단일 Range 요청(bytes=a-b)에 206 으로 응답한다. S3 와 같은 동작이다
//   (S3 는 요청 하나에 여러 Range 를 받지 않는다).
// - LATENCY_MS 로 요청마다 지연을 넣어 CDN 왕복 시간을 흉내 낸다.
//   로컬은 비현실적으로 빨라서, 요청 수의 비용이 드러나지 않기 때문이다.
//
// 사용: node server/serve.mjs            (기본 포트 8080, 지연 0)
//       LATENCY_MS=30 node server/serve.mjs

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize, resolve } from "node:path";

const ROOT = resolve(import.meta.dirname, "..");
const PORT = Number(process.env.PORT ?? 8080);
const LATENCY_MS = Number(process.env.LATENCY_MS ?? 0);
const QUIET = process.env.QUIET === "1";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
};

// 공개 경로만 서빙한다 — 원본 DICOM(data/raw)은 내보내지 않는다.
const PUBLIC = ["client/", "data/out/"];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");
  let path = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  if (path === "") path = "client/index.html";
  const file = normalize(join(ROOT, path));

  if (!file.startsWith(ROOT) || !PUBLIC.some((p) => path.startsWith(p))) {
    res.writeHead(404).end();
    return;
  }

  let info;
  try {
    info = await stat(file);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    res.writeHead(404).end();
    return;
  }

  if (LATENCY_MS) await sleep(LATENCY_MS);

  const headers = {
    "Content-Type": TYPES[extname(file)] ?? "application/octet-stream",
    "Accept-Ranges": "bytes",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Expose-Headers": "Content-Range, Content-Length",
    "Cache-Control": "no-store",
  };

  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = m ? Number(m[1]) : NaN;
    const end = m && m[2] ? Math.min(Number(m[2]), info.size - 1) : info.size - 1;
    if (!m || start > end || start >= info.size) {
      res.writeHead(416, { "Content-Range": `bytes */${info.size}` }).end();
      return;
    }
    const length = end - start + 1;
    res.writeHead(206, {
      ...headers,
      "Content-Length": length,
      "Content-Range": `bytes ${start}-${end}/${info.size}`,
    });
    createReadStream(file, { start, end }).pipe(res);
    if (!QUIET) console.log(`206 ${path} ${start}-${end} (${length} B)`);
    return;
  }

  res.writeHead(200, { ...headers, "Content-Length": info.size });
  createReadStream(file).pipe(res);
  if (!QUIET) console.log(`200 ${path} (${info.size} B)`);
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}  (latency ${LATENCY_MS}ms)`);
});

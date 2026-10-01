# 4D Flow 정적 서빙 PoC

서버 사이드 렌더링(픽셀 스트리밍) 없이 **S3 + CDN + 클라이언트 렌더링**만으로
대용량 3D/4D 의료 영상을 다룰 수 있는지 검증한다.

## 가설

- 업로드 시 1회 배치로 DICOM을 **3D 블록 + 해상도 피라미드**로 변환해 정적 파일로 둔다
- 브라우저는 필요한 블록만 **HTTP Range 요청**으로 받아 직접 렌더링한다
- 보는 동안 서버 GPU 비용이 없다

## 데이터

`data/`는 git에 포함하지 않는다. 출처와 받는 방법은 `scripts/`를 참고.

| 이름 | 출처 | 구성 | 용도 |
|---|---|---|---|
| `abd_mra` | IDC `tcga_kirc` / TCGA-DV-A4VX, CC BY 3.0 | coronal 3D MRA, 512×512×56 (0.78×0.78×1.6mm) × **2 phase** (동맥기 / 정맥기) | 대동맥 MPR·MIP, 방향 행렬, 시간축 2개 |
| `tof` | IDC `tcga_kich` / TCGA-KM-8476, CC BY 3.0 | 이름은 "3D TOF"지만 실제로는 coronal 동적 조영, 256×256×12 (7mm) × **22 시점** | 시간축 청크·prefetch 검증 |

```bash
uv venv --python 3.12 .venv && uv pip install --python .venv idc-index pydicom numpy pillow
.venv/bin/python scripts/fetch_idc.py
```

### 실제 데이터에서 확인한 함정

- 두 시리즈 모두 **한 시리즈 안에 여러 볼륨이 섞여 있다** (같은 위치에 슬라이스가 2장, 23장씩).
  위치만으로 정렬하면 볼륨이 깨진다 → `TriggerTime` / `AcquisitionNumber`로 먼저 나눠야 한다
- `InstanceNumber` 순서 ≠ 공간 순서 → 법선 방향 내적으로 정렬해야 한다
- `SliceThickness`(3.2mm) ≠ 슬라이스 간격(1.6mm, 겹쳐서 촬영)
- `SeriesDescription`을 믿을 수 없다 (`3D TOF`가 실제로는 동적 조영 시리즈)

## 실행

```bash
.venv/bin/python scripts/convert.py                    # data/out/ 생성 (블록 32³)
node server/serve.mjs                                  # http://localhost:8080
LATENCY_MS=30 node server/serve.mjs                    # CDN 왕복 지연 흉내
```

URL로 단면 지정: `/client/?ds=abd_mra&preset=sagittal&yaw=30&pitch=20&offset=0&t=0`

## 구조

| 경로 | 역할 |
|---|---|
| `scripts/convert.py` | DICOM → 시점 분리 → 32³ 블록 × 3단계 피라미드, 블록별 zlib → shard + 인덱스(manifest) |
| `server/serve.mjs` | S3/CloudFront 흉내. 단일 Range → 206, 원본 DICOM 비공개, 지연 옵션 |
| `client/` | WebGL2 MPR. 저해상도(L2) 먼저 → 단면에 걸친 L0 블록만 Range로 받아 `texSubImage3D` |

- 블록은 shard 안에 z→y→x 순서 → x 방향 이웃 블록이 파일에서도 이웃 → **Range 하나로 합침**
- 고해상도 블록 도착 여부는 블록 격자 크기의 mask 텍스처로 셰이더에 전달 → 블록 단위로 점진적 교체
- 재생 중에는 다음 시점의 블록을 미리 받음 (prefetch)

## 측정 (복부 MRA 512×512×56, 처음부터 단면 하나를 볼 때, 지연 30ms)

| 단면 | 블록 32³: 요청 / 전송 / 고해상도 완료 | 슬라이스 순서 + Range: 요청 / 전송 |
|---|---|---|
| coronal (촬영 방향) | 4 / 8.5MB / 0.48s | **1 / 1.0MB** |
| axial | **2** / 1.8MB / 0.37s | 56 / 112KB |
| sagittal | **32** / 2.0MB / 1.3s | 28,672 / 112KB |
| 비스듬한 단면 (30°, 20°) | **31** / 4.7MB / 1.1s | 28,402 / 460KB |

- 첫 화면(저해상도 L2, 263KB): 약 0.15~0.2s. DICOM 원본 한 시점은 28MB
- 무손실 압축: MRA 52%, 동적 조영 22% (블록 왕복 시 원본과 비트 단위 일치 확인)

### 블록 크기 트레이드오프 (같은 조건)

| 블록 | sagittal 요청 / 전송 / 완료 | 비스듬한 단면 요청 / 전송 / 완료 |
|---|---|---|
| 16³ | 128 / 1.0MB / 4.6s | 128 / 2.6MB / 4.5s |
| 32³ | 32 / 2.0MB / 1.3s | 31 / 4.7MB / 1.1s |
| 64³ | 8 / 3.9MB / 0.4s | 8 / 8.8MB / 0.35s |

## 결론

1. **슬라이스 순서 저장은 촬영 방향 외에는 불가능하다.** 비스듬한 단면에 요청 2.8만 번 →
   지연 30ms, 동시 6개면 2분 이상. 블록이면 31번
2. **블록은 요청 수를 줄이는 대신 데이터를 더 받는다(over-fetch).** 두께 32 블록에서 한 장만 쓰기 때문.
   다만 스크롤하면 이웃 단면이 같은 블록을 재사용하므로 연속 탐색에서는 상쇄된다
3. **블록 크기는 지연과 대역폭 사이의 트레이드오프다.** 로컬은 대역폭이 사실상 무한이라 큰 블록이
   유리하게 나왔다. 실제 회선에서는 대역폭 제한까지 넣어 다시 정해야 한다
4. **촬영 방향 단면은 슬라이스 저장이 압도적이다** → 두 레이아웃을 함께 두고 단면 방향에 따라
   고르는 방식이 다음 개선 후보. S3 저장 비용은 낮아서 두 벌 저장의 부담이 작다

### 측정의 한계

- 로컬 서버(HTTP/1.1, 동시 6개). CloudFront는 HTTP/2·3이라 요청 수의 비용이 이보다 낮다
- 대역폭 제한 없음 → over-fetch 비용이 과소평가됨
- 헤드리스 Chrome 측정, 각 단면을 캐시 없이 처음부터 받는 조건

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

"""DICOM 시리즈를 '블록 + 해상도 피라미드' 정적 파일로 변환한다.

업로드 시 1회 실행되는 배치 단계를 흉내 낸다. 결과물은 S3에 그대로 올려
CloudFront Range 요청으로 서빙할 수 있는 형태다.

출력 (data/out/<name>/):
  manifest.json          기하 정보, 레벨별 블록 격자, shard 인덱스(블록별 offset/length)
  t{T}/L{L}.bin          시점 T, 레벨 L 의 블록들을 이어 붙인 shard. 블록마다 zlib 압축
  t{T}/slices.raw        비교용: 같은 볼륨을 슬라이스 순서([z][y][x], int16) 그대로 저장

사용: .venv/bin/python scripts/convert.py [--brick 32]
"""
from __future__ import annotations

import argparse
import json
import zlib
from collections import defaultdict
from pathlib import Path

import numpy as np
import pydicom

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "out"

LEVELS = 3  # L0(원본), L1(1/2), L2(1/4)


def _float(value, default=0.0) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def load_series(directory: Path):
    """시리즈를 읽어 시점별 볼륨과 기하 정보를 만든다.

    실제 데이터에서 확인한 함정을 처리한다:
      - 한 시리즈에 여러 볼륨이 섞여 있다 → 위치별로 묶은 뒤, 각 위치 안에서
        (TriggerTime, AcquisitionTime, InstanceNumber) 순으로 k 번째 = 시점 k
      - InstanceNumber 순서 ≠ 공간 순서 → 법선 방향 내적으로 정렬
      - SliceThickness ≠ 간격 → 간격은 위치 차이로 계산
    """
    files = sorted(directory.rglob("*.dcm"))
    datasets = [pydicom.dcmread(f) for f in files]
    first = datasets[0]

    iop = np.array(first.ImageOrientationPatient, dtype=float)
    row_dir, col_dir = iop[:3], iop[3:]
    normal = np.cross(row_dir, col_dir)
    for ds in datasets:
        if not np.allclose(np.array(ds.ImageOrientationPatient, dtype=float), iop, atol=1e-4):
            raise SystemExit(f"{directory.name}: 방향이 다른 슬라이스가 섞여 있음 (볼륨 불가)")

    by_position: dict[float, list] = defaultdict(list)
    for ds in datasets:
        d = float(np.dot(np.array(ds.ImagePositionPatient, dtype=float), normal))
        by_position[round(d, 2)].append(ds)

    counts = {len(v) for v in by_position.values()}
    if len(counts) != 1:
        raise SystemExit(f"{directory.name}: 위치마다 슬라이스 수가 다름 {counts}")
    timepoints = counts.pop()

    positions = sorted(by_position)
    gaps = np.diff(positions)
    if len(gaps) and not np.allclose(gaps, gaps[0], atol=1e-2):
        raise SystemExit(f"{directory.name}: 슬라이스 간격이 불규칙함 (리샘플링 필요)")
    slice_spacing = float(gaps[0]) if len(gaps) else _float(first.SliceThickness, 1.0)

    def time_key(ds):
        return (_float(ds.get("TriggerTime")), str(ds.get("AcquisitionTime", "")), int(ds.InstanceNumber))

    volumes = []
    for t in range(timepoints):
        slices = []
        for p in positions:
            ds = sorted(by_position[p], key=time_key)[t]
            pixels = ds.pixel_array.astype(np.float64)
            pixels = pixels * _float(ds.get("RescaleSlope"), 1.0) + _float(ds.get("RescaleIntercept"))
            slices.append(pixels)
        vol = np.stack(slices)  # [z][y][x] — x 가 가장 빠르게 증가
        if np.any(vol != np.round(vol)) or vol.min() < -32768 or vol.max() > 32767:
            raise SystemExit(f"{directory.name}: int16 로 무손실 저장할 수 없는 값")
        volumes.append(vol.astype(np.int16))

    origin_ds = sorted(by_position[positions[0]], key=time_key)[0]
    pixel_spacing = [float(v) for v in first.PixelSpacing]  # [행 간격, 열 간격]

    def first_number(value, default):
        if value is None:
            return default
        return _float(value[0] if isinstance(value, pydicom.multival.MultiValue) else value, default)

    geometry = {
        "dims": [int(first.Columns), int(first.Rows), len(positions)],  # [x, y, z]
        # x 는 행 방향(열 인덱스 증가), y 는 열 방향(행 인덱스 증가)
        "spacing": [pixel_spacing[1], pixel_spacing[0], slice_spacing],
        "origin": [float(v) for v in origin_ds.ImagePositionPatient],
        # 열 벡터 3개: index 축 x, y, z 가 환자 좌표(LPS)에서 향하는 방향
        "direction": [row_dir.tolist(), col_dir.tolist(), normal.tolist()],
        "window": {
            "center": first_number(first.get("WindowCenter"), float(volumes[0].mean())),
            "width": first_number(first.get("WindowWidth"), float(np.ptp(volumes[0]))),
        },
    }
    meta = {
        "seriesDescription": str(first.get("SeriesDescription", "")),
        "sliceThickness": _float(first.get("SliceThickness")),
        "dicomFiles": len(files),
        "dicomBytes": sum(f.stat().st_size for f in files),
    }
    return volumes, geometry, meta


def downsample(vol: np.ndarray) -> np.ndarray:
    """각 축 1/2 (평균). 홀수 길이는 마지막 칸을 복제해 맞춘다."""
    pad = [(0, s % 2) for s in vol.shape]
    v = np.pad(vol.astype(np.float32), pad, mode="edge")
    z, y, x = v.shape
    v = v.reshape(z // 2, 2, y // 2, 2, x // 2, 2).mean(axis=(1, 3, 5))
    return np.round(v).astype(np.int16)


def write_shard(vol: np.ndarray, brick: int, path: Path):
    """블록을 z→y→x 순서로 이어 붙인다. x 방향 이웃 블록이 파일에서도 이웃이라
    클라이언트가 인접 Range 를 하나로 합칠 수 있다."""
    nz, ny, nx = vol.shape
    grid = [-(-nx // brick), -(-ny // brick), -(-nz // brick)]  # [gx, gy, gz]
    index, offset, raw_bytes = [], 0, 0
    with open(path, "wb") as f:
        for bz in range(grid[2]):
            for by in range(grid[1]):
                for bx in range(grid[0]):
                    block = vol[bz * brick:(bz + 1) * brick,
                                by * brick:(by + 1) * brick,
                                bx * brick:(bx + 1) * brick]
                    data = np.ascontiguousarray(block).astype("<i2").tobytes()
                    packed = zlib.compress(data, 6)
                    f.write(packed)
                    index.append([offset, len(packed)])
                    offset += len(packed)
                    raw_bytes += len(data)
    return grid, index, offset, raw_bytes


def convert(name: str, brick: int) -> None:
    volumes, geometry, meta = load_series(RAW / name)
    out = OUT / name
    out.mkdir(parents=True, exist_ok=True)

    levels = []
    level_vols = [volumes]
    for _ in range(1, LEVELS):
        level_vols.append([downsample(v) for v in level_vols[-1]])

    for level, vols in enumerate(level_vols):
        nz, ny, nx = vols[0].shape
        scale = 2 ** level
        levels.append({
            "level": level,
            "dims": [nx, ny, nz],
            "spacing": [s * scale for s in geometry["spacing"]],
            "shards": [],
        })

    totals = {"raw": 0, "packed": 0}
    for t in range(len(volumes)):
        tdir = out / f"t{t}"
        tdir.mkdir(exist_ok=True)
        volumes[t].astype("<i2").tofile(tdir / "slices.raw")
        for level, vols in enumerate(level_vols):
            grid, index, packed, raw = write_shard(vols[t], brick, tdir / f"L{level}.bin")
            levels[level]["brickGrid"] = grid
            levels[level]["shards"].append({"url": f"t{t}/L{level}.bin", "bricks": index})
            if level == 0:
                totals["raw"] += raw
                totals["packed"] += packed

    manifest = {
        "name": name,
        "source": meta,
        "brick": brick,
        "dtype": "int16",
        "compression": "zlib",
        "timepoints": len(volumes),
        **geometry,
        "levels": levels,
        "sliceLayout": [f"t{t}/slices.raw" for t in range(len(volumes))],
    }
    (out / "manifest.json").write_text(json.dumps(manifest))

    dims = geometry["dims"]
    print(f"{name}: {dims} × {len(volumes)} 시점, 간격 {np.round(geometry['spacing'], 3).tolist()} mm")
    print(f"  L0 블록 {levels[0]['brickGrid']} = {len(levels[0]['shards'][0]['bricks'])}개/시점, "
          f"원본 {totals['raw'] / 1e6:.1f}MB → 압축 {totals['packed'] / 1e6:.1f}MB "
          f"({totals['packed'] / totals['raw']:.0%}), DICOM {meta['dicomBytes'] / 1e6:.1f}MB")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--brick", type=int, default=32)
    parser.add_argument("names", nargs="*", default=["abd_mra", "tof"])
    args = parser.parse_args()
    for name in args.names:
        convert(name, args.brick)


if __name__ == "__main__":
    main()

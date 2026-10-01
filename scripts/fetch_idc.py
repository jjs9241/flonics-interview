"""IDC(NCI Imaging Data Commons) 공개 버킷에서 PoC용 MRI DICOM 시리즈를 받는다.

인증 불필요. 라이선스는 시리즈별 license_short_name 을 따른다 (둘 다 CC BY 3.0).
사용: .venv/bin/python scripts/fetch_idc.py
"""
from pathlib import Path

from idc_index import IDCClient

SERIES = {
    # 복부 MRA (coronal 3D) — 대동맥·신동맥. 방향 행렬이 단위행렬이 아닌 케이스
    "abd_mra": ("tcga_kirc", "COR  MRA  EFGRE3D", "TCGA-DV-A4VX"),
    # 3D TOF — 얇은 슬라이스 혈관 영상
    "tof": ("tcga_kich", "3D TOF", "TCGA-KM-8476"),
}

OUT = Path(__file__).resolve().parent.parent / "data" / "raw"


def main() -> None:
    client = IDCClient()
    for name, (collection, description, patient) in SERIES.items():
        rows = client.sql_query(f"""
            SELECT SeriesInstanceUID, instanceCount, series_size_MB, license_short_name
            FROM index
            WHERE collection_id = '{collection}' AND SeriesDescription = '{description}'
              AND PatientID = '{patient}' AND Modality = 'MR'
        """)
        if rows.empty:
            raise SystemExit(f"{name}: 시리즈를 찾지 못함")
        row = rows.iloc[0]
        target = OUT / name
        target.mkdir(parents=True, exist_ok=True)
        print(f"{name}: {row.instanceCount}장, {row.series_size_MB:.1f}MB, {row.license_short_name}")
        client.download_from_selection(
            seriesInstanceUID=[row.SeriesInstanceUID],
            downloadDir=str(target),
            dirTemplate="",
            show_progress_bar=False,
        )


if __name__ == "__main__":
    main()

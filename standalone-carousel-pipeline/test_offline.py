from __future__ import annotations

import json
import tempfile
import zipfile
from pathlib import Path

from PIL import Image

from carousel_pipeline import run_pipeline


def build_sample_zip(root: Path, bad: bool = False) -> tuple[Path, Path]:
    source_dir = root / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    sizes = [(1080, 1920), (1080, 1920), (1000, 1000) if bad else (1080, 1920)]
    for index, size in enumerate(sizes, start=1):
        Image.new("RGB", size, color=(120, 80, 200)).save(source_dir / f"{index:02d}.jpg")
    (source_dir / "caption.txt").write_text("Radhe Krishna caption", encoding="utf8")

    zip_path = root / "post.zip"
    with zipfile.ZipFile(zip_path, "w") as archive:
        for item in source_dir.iterdir():
            archive.write(item, item.name)

    config_path = root / "config.json"
    config_path.write_text(
        json.dumps(
            {
                "mode": "private_music",
                "music_track": "Calm Vibes",
                "instagram_location_pk": 212988663,
                "user_tags": [{"username": "exampleuser", "x": 0.5, "y": 0.5}],
                "schedule_utc": None,
                "credentials": {
                    "instagram_username": "demo",
                    "instagram_password": "demo",
                    "instagram_session_file": str((root / ".instagrapi-session.json").resolve()),
                },
            },
            indent=2,
        ),
        encoding="utf8",
    )
    return zip_path, config_path


def main() -> None:
    root = Path(tempfile.mkdtemp(prefix="carousel-pipeline-test-"))

    zip_path, config_path = build_sample_zip(root, bad=False)
    manifest, manifest_path = run_pipeline(zip_path, config_path, root / "run-good", dry_run=True)
    assert manifest["status"] == "validated"
    assert manifest["image_count"] == 3
    assert manifest_path.exists()

    bad_zip, bad_config = build_sample_zip(root / "bad", bad=True)
    try:
      run_pipeline(bad_zip, bad_config, root / "run-bad", dry_run=True)
      raise AssertionError("Expected bad 9:16 input to fail")
    except Exception as exc:
      assert "expected exact 9:16" in str(exc).lower()

    print("offline_ok")


if __name__ == "__main__":
    main()

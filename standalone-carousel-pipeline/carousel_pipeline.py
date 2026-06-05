from __future__ import annotations

import argparse
import dataclasses
import json
import math
import os
import shutil
import sys
import tempfile
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

VENDOR_DIR = Path(__file__).resolve().parent / "vendor"
if VENDOR_DIR.exists():
    sys.path.insert(0, str(VENDOR_DIR))

try:
    import requests
except ImportError as exc:  # pragma: no cover
    raise SystemExit("Missing dependency: requests. Run pip install -r requirements.txt") from exc

try:
    from PIL import Image
except ImportError as exc:  # pragma: no cover
    raise SystemExit("Missing dependency: Pillow. Run pip install -r requirements.txt") from exc

try:
    from instagrapi import Client
    from instagrapi.types import Location, Usertag
except ImportError:  # optional for official no-music mode
    Client = None
    Location = None
    Usertag = None

GRAPH_BASE_URL = "https://graph.facebook.com/v25.0"
TARGET_RATIO = 9 / 16
RATIO_TOLERANCE = 0.0025
MAX_CAROUSEL_ITEMS = 10
ACCEPTED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp"}


class PipelineError(RuntimeError):
    pass


@dataclasses.dataclass
class Credentials:
    graph_ig_user_id: str | None = None
    graph_access_token: str | None = None
    cloudinary_cloud_name: str | None = None
    cloudinary_upload_preset: str | None = None
    cloudinary_folder: str | None = None
    instagram_username: str | None = None
    instagram_password: str | None = None
    instagram_session_file: str | None = None
    instagram_sessionid: str | None = None


@dataclasses.dataclass
class UserTagSpec:
    username: str
    x: float = 0.5
    y: float = 0.5


@dataclasses.dataclass
class PipelineConfig:
    mode: str
    music_track: str | None
    location_id: str | None
    instagram_location_pk: int | None
    user_tags: list[UserTagSpec]
    schedule_utc: str | None
    credentials: Credentials
    caption_file_name: str = "caption.txt"
    dry_run: bool = False


@dataclasses.dataclass
class ImageInfo:
    file_name: str
    path: Path
    width: int
    height: int
    size_bytes: int

    @property
    def ratio(self) -> float:
        return self.width / self.height


def read_json(file_path: Path) -> dict[str, Any]:
    try:
        return json.loads(file_path.read_text(encoding="utf8"))
    except FileNotFoundError as exc:
        raise PipelineError(f"Config file not found: {file_path}") from exc
    except json.JSONDecodeError as exc:
        raise PipelineError(f"Config file is not valid JSON: {file_path}") from exc


def load_dotenv_file(config_path: Path) -> None:
    env_path = config_path.parent / ".env"
    if not env_path.exists():
        return

    for raw_line in env_path.read_text(encoding="utf8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key or key in os.environ:
            continue
        value = value.strip().strip('"').strip("'")
        os.environ[key] = value


def load_config(config_path: Path, dry_run: bool) -> PipelineConfig:
    load_dotenv_file(config_path)
    raw = read_json(config_path)
    raw_credentials = raw.get("credentials") or {}
    env = os.environ

    def env_or_value(key: str, fallback: str | None = None) -> str | None:
        value = raw_credentials.get(key)
        if value not in (None, ""):
            return str(value)
        env_value = env.get(key.upper())
        if env_value:
            return env_value
        return fallback

    raw_tags = raw.get("user_tags") or []
    tags: list[UserTagSpec] = []
    for item in raw_tags:
        if isinstance(item, str):
            tags.append(UserTagSpec(username=item.lstrip("@").strip()))
        elif isinstance(item, dict) and item.get("username"):
            tags.append(
                UserTagSpec(
                    username=str(item["username"]).lstrip("@").strip(),
                    x=float(item.get("x", 0.5)),
                    y=float(item.get("y", 0.5)),
                )
            )

    session_file_raw = env_or_value("instagram_session_file", str((config_path.parent / ".instagrapi-session.json").resolve()))
    if session_file_raw and not os.path.isabs(session_file_raw):
        session_file_raw = str((config_path.parent / session_file_raw).resolve())

    credentials = Credentials(
        graph_ig_user_id=env_or_value("graph_ig_user_id"),
        graph_access_token=env_or_value("graph_access_token"),
        cloudinary_cloud_name=env_or_value("cloudinary_cloud_name"),
        cloudinary_upload_preset=env_or_value("cloudinary_upload_preset"),
        cloudinary_folder=env_or_value("cloudinary_folder", "sanatan-dharma-ai/carousel"),
        instagram_username=env_or_value("instagram_username"),
        instagram_password=env_or_value("instagram_password"),
        instagram_session_file=session_file_raw,
        instagram_sessionid=env_or_value("instagram_sessionid"),
    )

    return PipelineConfig(
        mode=str(raw.get("mode") or ("private_music" if raw.get("music_track") else "official_graph")).strip(),
        music_track=str(raw.get("music_track")).strip() if raw.get("music_track") else None,
        location_id=str(raw.get("location_id")).strip() if raw.get("location_id") else None,
        instagram_location_pk=int(raw["instagram_location_pk"]) if raw.get("instagram_location_pk") else None,
        user_tags=tags,
        schedule_utc=str(raw.get("schedule_utc")).strip() if raw.get("schedule_utc") else None,
        credentials=credentials,
        caption_file_name=str(raw.get("caption_file_name") or "caption.txt"),
        dry_run=dry_run,
    )


def extract_zip(zip_path: Path) -> Path:
    if not zip_path.exists():
        raise PipelineError(f"Zip file not found: {zip_path}")
    work_dir = Path(tempfile.mkdtemp(prefix="carousel-pipeline-"))
    with zipfile.ZipFile(zip_path) as archive:
        archive.extractall(work_dir)
    return work_dir


def read_caption(extracted_dir: Path, caption_file_name: str) -> str:
    caption_path = extracted_dir / caption_file_name
    if not caption_path.exists():
        raise PipelineError(f"Caption file not found inside zip: {caption_file_name}")
    caption = caption_path.read_text(encoding="utf8").strip()
    if not caption:
        raise PipelineError("Caption file is empty.")
    return caption


def collect_images(extracted_dir: Path) -> list[ImageInfo]:
    images: list[ImageInfo] = []
    for item in sorted(extracted_dir.iterdir(), key=lambda path: path.name.lower()):
        if item.is_file() and item.suffix.lower() in ACCEPTED_SUFFIXES:
            with Image.open(item) as image:
                width, height = image.size
            images.append(
                ImageInfo(
                    file_name=item.name,
                    path=item,
                    width=width,
                    height=height,
                    size_bytes=item.stat().st_size,
                )
            )
    if len(images) < 2:
        raise PipelineError("At least 2 images are required for a carousel post.")
    if len(images) > MAX_CAROUSEL_ITEMS:
        raise PipelineError(f"Instagram carousel publishing is limited to {MAX_CAROUSEL_ITEMS} images; found {len(images)}.")
    return images


def validate_images(images: list[ImageInfo]) -> None:
    base_width = images[0].width
    base_height = images[0].height
    for image in images:
        if abs(image.ratio - TARGET_RATIO) > RATIO_TOLERANCE:
            raise PipelineError(
                f"{image.file_name} is {image.width}x{image.height}; expected exact 9:16 originals. Aborting."
            )
        if image.width != base_width or image.height != base_height:
            raise PipelineError(
                f"{image.file_name} does not match the first image dimensions ({base_width}x{base_height}). Aborting."
            )


def ensure_no_schedule_in_current_modes(config: PipelineConfig) -> None:
    if not config.schedule_utc:
        return
    try:
        due_at = datetime.fromisoformat(config.schedule_utc.replace("Z", "+00:00"))
    except ValueError as exc:
        raise PipelineError(f"schedule_utc is not a valid ISO timestamp: {config.schedule_utc}") from exc

    if due_at <= datetime.now(timezone.utc):
        raise PipelineError("schedule_utc must be in the future.")

    raise PipelineError(
        "This standalone carousel pipeline does not schedule future posts. "
        "Run it at publish time or trigger it from an external scheduler."
    )


def build_manifest(config: PipelineConfig, zip_path: Path, extracted_dir: Path, caption: str, images: list[ImageInfo]) -> dict[str, Any]:
    return {
        "ok": True,
        "mode": config.mode,
        "dry_run": config.dry_run,
        "zip_path": str(zip_path),
        "caption": caption,
        "location_id": config.location_id,
        "instagram_location_pk": config.instagram_location_pk,
        "music_track": config.music_track,
        "image_count": len(images),
        "images": [
            {
                "file_name": image.file_name,
                "width": image.width,
                "height": image.height,
                "size_bytes": image.size_bytes,
            }
            for image in images
        ],
        "extracted_dir": str(extracted_dir),
    }


def upload_to_cloudinary(image_path: Path, credentials: Credentials) -> str:
    if not credentials.cloudinary_cloud_name or not credentials.cloudinary_upload_preset:
        raise PipelineError("Cloudinary credentials are required for official Graph API mode.")

    endpoint = f"https://api.cloudinary.com/v1_1/{credentials.cloudinary_cloud_name}/image/upload"
    with image_path.open("rb") as image_file:
        response = requests.post(
            endpoint,
            data={
                "upload_preset": credentials.cloudinary_upload_preset,
                "folder": credentials.cloudinary_folder or "sanatan-dharma-ai/carousel",
            },
            files={"file": (image_path.name, image_file, "application/octet-stream")},
            timeout=120,
        )
    payload = response.json()
    if response.status_code >= 400:
        raise PipelineError(payload.get("error", {}).get("message") or f"Cloudinary upload failed for {image_path.name}")
    secure_url = payload.get("secure_url")
    if not secure_url:
        raise PipelineError(f"Cloudinary did not return secure_url for {image_path.name}")
    return secure_url


def graph_post(path: str, params: dict[str, Any]) -> dict[str, Any]:
    response = requests.post(path, data=params, timeout=120)
    payload = response.json()
    if response.status_code >= 400:
        message = payload.get("error", {}).get("message") or f"Graph request failed with status {response.status_code}"
        raise PipelineError(message)
    return payload


def graph_get(path: str, params: dict[str, Any]) -> dict[str, Any]:
    response = requests.get(path, params=params, timeout=60)
    payload = response.json()
    if response.status_code >= 400:
        message = payload.get("error", {}).get("message") or f"Graph request failed with status {response.status_code}"
        raise PipelineError(message)
    return payload


def create_official_carousel(config: PipelineConfig, image_urls: list[str], caption: str) -> dict[str, Any]:
    credentials = config.credentials
    if not credentials.graph_ig_user_id or not credentials.graph_access_token:
        raise PipelineError("graph_ig_user_id and graph_access_token are required for official Graph API mode.")
    if config.music_track:
        raise PipelineError("Official Graph API mode cannot attach Instagram carousel music automatically.")

    child_ids: list[str] = []
    for image_url in image_urls:
        params: dict[str, Any] = {
            "image_url": image_url,
            "is_carousel_item": "true",
            "access_token": credentials.graph_access_token,
        }
        if config.user_tags:
            params["user_tags"] = json.dumps(
                [{"username": tag.username, "x": tag.x, "y": tag.y} for tag in config.user_tags]
            )
        payload = graph_post(
            f"{GRAPH_BASE_URL}/{credentials.graph_ig_user_id}/media",
            params,
        )
        child_ids.append(payload["id"])

    params = {
        "media_type": "CAROUSEL",
        "children": ",".join(child_ids),
        "caption": caption,
        "access_token": credentials.graph_access_token,
    }
    if config.location_id:
        params["location_id"] = config.location_id

    parent = graph_post(f"{GRAPH_BASE_URL}/{credentials.graph_ig_user_id}/media", params)
    published = graph_post(
        f"{GRAPH_BASE_URL}/{credentials.graph_ig_user_id}/media_publish",
        {
            "creation_id": parent["id"],
            "access_token": credentials.graph_access_token,
        },
    )

    media = graph_get(
        f"{GRAPH_BASE_URL}/{published['id']}",
        {
            "fields": "id,permalink,media_product_type",
            "access_token": credentials.graph_access_token,
        },
    )
    return {
        "provider": "graph_api",
        "container_id": parent["id"],
        "media_id": published["id"],
        "permalink": media.get("permalink"),
    }


def login_private_client(credentials: Credentials) -> Client:
    if Client is None:
        raise PipelineError("instagrapi is not installed. Install requirements.txt first.")
    if not credentials.instagram_sessionid and (not credentials.instagram_username or not credentials.instagram_password):
        raise PipelineError("Provide instagram_sessionid or instagram_username / instagram_password for private music mode.")

    client = Client()
    session_file = Path(credentials.instagram_session_file or ".instagrapi-session.json")
    if credentials.instagram_sessionid:
        try:
            client.login_by_sessionid(credentials.instagram_sessionid)
            client.get_timeline_feed()
            session_file.parent.mkdir(parents=True, exist_ok=True)
            client.dump_settings(session_file)
            return client
        except Exception:
            pass

    loaded_settings = False
    if session_file.exists():
        client.load_settings(session_file)
        loaded_settings = True

    if loaded_settings:
        try:
            client.get_timeline_feed()
            return client
        except Exception:
            pass

    if not credentials.instagram_username or not credentials.instagram_password:
        raise PipelineError("Session is invalid and username/password were not provided for fallback login.")

    client.login(credentials.instagram_username, credentials.instagram_password)
    session_file.parent.mkdir(parents=True, exist_ok=True)
    client.dump_settings(session_file)
    return client


def resolve_private_location(client: Client, config: PipelineConfig):
    if not config.instagram_location_pk:
        return None
    return client.location_search_pk(config.instagram_location_pk)


def build_private_usertags(client: Client, config: PipelineConfig, image_count: int):
    if not config.user_tags:
        return []
    tags_for_all_images = []
    for tag in config.user_tags:
        user = client.user_info_by_username(tag.username)
        tags_for_all_images.append(Usertag(user=user, x=tag.x, y=tag.y))
    return [tags_for_all_images for _ in range(image_count)]


def resolve_private_track(client: Client, config: PipelineConfig):
    if not config.music_track:
        raise PipelineError("music_track is required for private music mode.")
    try:
        results = client.search_music(config.music_track)
    except Exception:
        client.get_timeline_feed()
        results = client.search_music(config.music_track)
    if not results:
        raise PipelineError(f"No Instagram music track matched: {config.music_track}")
    return results[0]


def create_private_music_carousel(config: PipelineConfig, images: list[ImageInfo], caption: str) -> dict[str, Any]:
    ensure_no_schedule_in_current_modes(config)
    client = login_private_client(config.credentials)
    track = resolve_private_track(client, config)
    location = resolve_private_location(client, config)
    usertags = build_private_usertags(client, config, len(images))
    media = client.album_upload_with_music(
        paths=[image.path for image in images],
        caption=caption,
        track=track,
        usertags=usertags,
        location=location,
    )
    return {
        "provider": "instagrapi_private_api",
        "media_id": getattr(media, "id", None),
        "pk": getattr(media, "pk", None),
        "code": getattr(media, "code", None),
        "permalink": f"https://www.instagram.com/p/{media.code}/" if getattr(media, "code", None) else None,
        "track_title": getattr(track, "title", None),
    }


def write_manifest(out_dir: Path, name: str, payload: dict[str, Any]) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = out_dir / name
    manifest_path.write_text(f"{json.dumps(payload, indent=2)}\n", encoding="utf8")
    return manifest_path


def build_manual_music_handoff(
    config: PipelineConfig,
    images: list[ImageInfo],
    caption: str,
    reason: str,
) -> dict[str, Any]:
    return {
        "provider": "manual_instagram_music_handoff",
        "reason": reason,
        "music_track": config.music_track,
        "slide_order": [image.file_name for image in images],
        "caption": caption,
        "steps": [
            "Open Instagram app and create a new carousel post.",
            "Select slides in the listed order.",
            "Paste the prepared caption.",
            "Use Instagram music search and add the requested track.",
            "Publish from the app.",
        ],
    }


def run_pipeline(zip_path: Path, config_path: Path, out_dir: Path, dry_run: bool) -> tuple[dict[str, Any], Path]:
    config = load_config(config_path, dry_run=dry_run)
    extracted_dir = extract_zip(zip_path)
    try:
        caption = read_caption(extracted_dir, config.caption_file_name)
        images = collect_images(extracted_dir)
        validate_images(images)
        manifest = build_manifest(config, zip_path, extracted_dir, caption, images)

        if dry_run:
            manifest["status"] = "validated"
            manifest["next_step"] = "Run again without --dry-run to publish."
            manifest_path = write_manifest(out_dir, "result.json", manifest)
            return manifest, manifest_path

        if config.mode == "private_music":
            try:
                result = create_private_music_carousel(config, images, caption)
                manifest["status"] = "published"
            except Exception as exc:
                error_text = f"{type(exc).__name__}: {exc}"
                lower_error = error_text.lower()
                if "login_required" in lower_error or "challenge" in lower_error:
                    manifest["status"] = "manual_music_required"
                    result = build_manual_music_handoff(config, images, caption, error_text)
                else:
                    raise PipelineError(error_text) from exc
        elif config.mode == "official_graph":
            ensure_no_schedule_in_current_modes(config)
            image_urls = [upload_to_cloudinary(image.path, config.credentials) for image in images]
            result = create_official_carousel(config, image_urls, caption)
            manifest["hosted_image_urls"] = image_urls
            manifest["status"] = "published"
        else:
            raise PipelineError(f"Unsupported mode: {config.mode}")

        manifest["publish_result"] = result
        manifest_path = write_manifest(out_dir, "result.json", manifest)
        return manifest, manifest_path
    finally:
        # keep extracted files for audit/debug, but move into out_dir
        extracted_target = out_dir / "extracted"
        if extracted_dir.exists():
            if extracted_target.exists():
                shutil.rmtree(extracted_target, ignore_errors=True)
            out_dir.mkdir(parents=True, exist_ok=True)
            shutil.move(str(extracted_dir), str(extracted_target))


def main() -> int:
    parser = argparse.ArgumentParser(description="Standalone Instagram carousel pipeline.")
    parser.add_argument("--zip", required=True, type=Path, help="Zip file containing carousel images and caption.txt")
    parser.add_argument("--config", required=True, type=Path, help="JSON config file for credentials and publish options")
    parser.add_argument("--out", type=Path, default=Path("standalone-carousel-pipeline") / "runs" / datetime.now().strftime("%Y-%m-%d-%H%M%S"))
    parser.add_argument("--dry-run", action="store_true", help="Validate and build the manifest without publishing")
    args = parser.parse_args()

    try:
        manifest, manifest_path = run_pipeline(args.zip.resolve(), args.config.resolve(), args.out.resolve(), args.dry_run)
        print(json.dumps({
            "ok": True,
            "status": manifest.get("status"),
            "mode": manifest.get("mode"),
            "manifest_path": str(manifest_path),
            "permalink": manifest.get("publish_result", {}).get("permalink"),
        }, indent=2))
        return 0
    except PipelineError as error:
        print(json.dumps({
            "ok": False,
            "error": str(error),
        }, indent=2))
        return 2


if __name__ == "__main__":
    raise SystemExit(main())

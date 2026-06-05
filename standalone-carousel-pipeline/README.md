# Standalone Carousel Pipeline

This folder is isolated from the main WhatsApp/Buffer app.

It is a corrected standalone Instagram carousel pipeline for:

- `zip` input containing the original images
- `caption.txt` inside the zip
- `config.json` beside it

It enforces:

- all images must already be exact `9:16`
- all images must share the same dimensions
- no cropping is done by the pipeline
- carousel item count must stay within Instagram API-safe limits

## Modes

### 1. `private_music`

Uses `instagrapi` and uploads the carousel directly with music via:

- `album_upload_with_music(...)`

This is the only mode here that supports automated carousel music.

It also supports:

- location through `instagram_location_pk`
- user tags

Important:

- this is a private/mobile API path
- it posts immediately
- it does **not** schedule future posts

### 2. `official_graph`

Uses the official Instagram Graph API for carousel publishing.

It supports:

- carousel upload
- caption
- user tags
- `location_id`

It does **not** support carousel music.

It uploads originals to Cloudinary first because the Graph API requires public image URLs.

## Files

- [carousel_pipeline.py](E:\VScode\insta automation\standalone-carousel-pipeline\carousel_pipeline.py)
- [config.example.json](E:\VScode\insta automation\standalone-carousel-pipeline\config.example.json)
- [.env.example](E:\VScode\insta automation\standalone-carousel-pipeline\.env.example)
- [requirements.txt](E:\VScode\insta automation\standalone-carousel-pipeline\requirements.txt)

## Expected zip contents

```text
post_001.zip
  ├── 01.jpg
  ├── 02.jpg
  ├── 03.jpg
  └── caption.txt
```

Filenames determine slide order.

## Example config

```json
{
  "mode": "private_music",
  "music_track": "Calm Vibes",
  "instagram_location_pk": 212988663,
  "user_tags": [
    {
      "username": "exampleuser",
      "x": 0.5,
      "y": 0.5
    }
  ],
  "schedule_utc": null,
  "credentials": {
    "instagram_username": "your_handle",
    "instagram_password": "your_password",
    "instagram_session_file": "./.instagrapi-session.json",
    "graph_ig_user_id": "YOUR_IG_USER_ID",
    "graph_access_token": "YOUR_LONG_LIVED_TOKEN",
    "cloudinary_cloud_name": "YOUR_CLOUD_NAME",
    "cloudinary_upload_preset": "YOUR_UNSIGNED_UPLOAD_PRESET",
    "cloudinary_folder": "sanatan-dharma-ai/carousel"
  }
}
```

## Environment placeholders

You can also keep secrets outside `config.json`.

Copy:

```powershell
Copy-Item .\standalone-carousel-pipeline\.env.example .\standalone-carousel-pipeline\.env
```

Then fill the placeholders in:

- [.env.example](E:\VScode\insta automation\standalone-carousel-pipeline\.env.example)

The script reads these credential keys when the matching `credentials` field in `config.json` is empty:

- `INSTAGRAM_USERNAME`
- `INSTAGRAM_PASSWORD`
- `INSTAGRAM_SESSION_FILE`
- `GRAPH_IG_USER_ID`
- `GRAPH_ACCESS_TOKEN`
- `CLOUDINARY_CLOUD_NAME`
- `CLOUDINARY_UPLOAD_PRESET`
- `CLOUDINARY_FOLDER`

Keep using `config.json` for non-secret content such as:

- `mode`
- `music_track`
- `instagram_location_pk`
- `location_id`
- `user_tags`

## Install

If you want a local Python environment, use:

```powershell
python -m pip install -r .\standalone-carousel-pipeline\requirements.txt
```

In this workspace, dependencies were also installed into:

```text
standalone-carousel-pipeline/vendor
```

so the script can run with the bundled runtime too.

## Dry-run validation

This validates the package without publishing anything:

```powershell
& 'C:\Users\milan\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' `
  .\standalone-carousel-pipeline\carousel_pipeline.py `
  --zip "C:\path\to\post_001.zip" `
  --config "C:\path\to\config.json" `
  --dry-run
```

## Real publish

### Private music mode

```powershell
& 'C:\Users\milan\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' `
  .\standalone-carousel-pipeline\carousel_pipeline.py `
  --zip "C:\path\to\post_001.zip" `
  --config "C:\path\to\config.json"
```

### Official Graph mode

Set:

```json
"mode": "official_graph",
"music_track": null,
"location_id": "YOUR_FACEBOOK_PAGE_LOCATION_ID"
```

and run the same command.

## Output

Each run writes:

- `result.json`
- `extracted/` with the original files used for the run

## Tested locally

The following were tested in this workspace:

- Python syntax
- dependency imports from the vendored folder
- zip extraction
- caption loading
- sorted image discovery
- exact 9:16 validation
- failure on non-9:16 images

Live posting to Instagram was **not** tested here because no real credentials/session were available in this environment.

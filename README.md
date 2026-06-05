# WhatsApp to Instagram Automation

This project now runs two WhatsApp-driven workflows:

1. You send either an **image/video document** or a **zip carousel package** to the configured WhatsApp chat.
2. The server ingests it through **WhatsApp Web automation**.
3. Reel/image intakes keep the existing caption, music, render, and Buffer flow.
4. Zip carousel packages use the bundled `caption.txt` and publish through the official Instagram Graph API without music or location.
5. The scheduler now reserves overnight devotional placeholders between **2:00 a.m. and 3:00 a.m. IST**.
6. After a scheduled carousel is published, the app sends a WhatsApp notification back to your configured chat.

The dashboard is now for monitoring, QR login, logs, intake history, and queue status. Posting is triggered by WhatsApp, not manual upload forms.

## Current publishing model

- Instagram video posts through Buffer are treated as Reels.
- Buffer cannot attach trending Instagram music automatically.
- This app therefore **bakes the chosen track into the MP4** before Buffer sees it.
- The app can now host reel MP4s in **Cloudinary** before Buffer receives them.
- If Cloudinary is not configured, the fallback is your app's `PUBLIC_BASE_URL`.
- Carousel zip posts bypass Buffer and use the official Instagram Graph API directly.

## Caption model

- Captions are now generated from a deterministic local template bank.
- The generator uses image cues when available, then your WhatsApp text, then fills a short devotional caption.
- Hashtags stay capped at 5.
- The old long-paragraph caption flow is no longer the primary path.

## Sources used for the scheduler

- Encoded 2026 devotional placeholders for major Hindu festivals and deity/story themes
- Operator rule: publish daily in the **2-3 a.m. IST** window
- Buffer Instagram help: [Using Instagram with Buffer](https://support.buffer.com/article/554-using-instagram-with-buffer)
- Buffer API help: [Does Buffer have an API?](https://support.buffer.com/article/859-does-buffer-have-an-api)
- whatsapp-web.js docs: [docs.wwebjs.dev](https://docs.wwebjs.dev/)
- whatsapp-web.js repo and disclaimer: [GitHub](https://github.com/pedroslopez/whatsapp-web.js)

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment

Copy `.env.example` to `.env` and set:

- `BUFFER_API_KEY`
- `BUFFER_DEFAULT_CHANNEL_ID`
- either `CLOUDINARY_CLOUD_NAME` + `CLOUDINARY_UPLOAD_PRESET`, or a public `PUBLIC_BASE_URL`
- `GRAPH_IG_USER_ID`
- `GRAPH_ACCESS_TOKEN`
- optional Supabase queue store for GitHub Actions publishing while your PC is offline:
  - `QUEUE_STORE_PROVIDER=supabase`
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `SUPABASE_JOBS_TABLE=automation_jobs`
  - `SUPABASE_INTAKES_TABLE=automation_intakes`
- optional Cloudflare Workers AI caption settings if you want the LLM caption writer:
  - `CLOUDFLARE_ACCOUNT_ID`
  - `CLOUDFLARE_API_TOKEN`
  - optional `CLOUDFLARE_CAPTION_MODEL`
- `WHATSAPP_ALLOWED_CHAT_NAME` or `WHATSAPP_ALLOWED_CHAT_ID`
- optional `WHATSAPP_NOTIFICATION_CHAT_NAME` or `WHATSAPP_NOTIFICATION_CHAT_ID`
- auth secrets if you want the dashboard protected

### 3. Add music files

Put your fixed Hindi tracks in:

```text
data/music/
```

The manifest lives at:

```text
data/music-library.json
```

Match the filenames in that manifest. The repo seeds the manifest with:

- Anuv Jain - Baarishein
- Prateek Kuhad - Kasoor
- Arijit Singh - Phir Le Aaya Dil (Reprise)
- Mitraz - Apna Bana Le
- Achint - Kuch To Hai
- Sachet-Parampara - Ram Siya Ram
- Shreya Ghoshal - Teri Ore
- Jasleen Royal - Heeriye

### 4. Configure reel hosting

Recommended:

- create a Cloudinary account
- create an **unsigned upload preset** that allows video uploads
- set:
  - `CLOUDINARY_CLOUD_NAME`
  - `CLOUDINARY_UPLOAD_PRESET`
  - optional `CLOUDINARY_UPLOAD_FOLDER`

With Cloudinary configured, rendered reel MP4s are uploaded automatically and Buffer receives the returned public video URL.

### 5. Optional Supabase queue store for cloud worker

Use this if GitHub Actions should publish scheduled carousel posts while this PC is offline. Cloudinary stores the images, but Supabase stores the required queue metadata: job id, intake id, caption, Cloudinary slide URLs, schedule time, and publish status.

1. Create a Supabase project.
2. Open Supabase SQL Editor and run [`supabase/queue-store.sql`](./supabase/queue-store.sql).
3. Add these values to local `.env` and to GitHub Actions Secrets:
   - `QUEUE_STORE_PROVIDER=supabase`
   - `SUPABASE_URL`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_JOBS_TABLE=automation_jobs`
   - `SUPABASE_INTAKES_TABLE=automation_intakes`
   - `GRAPH_IG_USER_ID`
   - `GRAPH_ACCESS_TOKEN`
   - `CLOUDINARY_CLOUD_NAME`
   - `CLOUDINARY_UPLOAD_PRESET`
4. Sync existing local queued jobs/intakes once:

```bash
npm run supabase:sync
```

After this, WhatsApp intake on the local app writes queue records to Supabase, and GitHub Actions reads the same queue during the 11 p.m. and 2-3 a.m. IST windows.

Fallback:

- if Cloudinary is not configured, `PUBLIC_BASE_URL` must still be a real public URL
- this means a deployed server, reverse proxy, or public tunnel

### 6. Optional Blender sidecar test

If you want to test a Blender-only image-to-video proof of concept without changing the live app flow, use:

- [`scripts/blender-image-to-video-test.py`](./scripts/blender-image-to-video-test.py)
- [`scripts/test-blender-image-to-video.ps1`](./scripts/test-blender-image-to-video.ps1)

The sidecar test renders `dashboard-test.png` into a short MP4 using Blender background rendering.

Example:

```powershell
.\scripts\test-blender-image-to-video.ps1
```

### 7. Start the app

```bash
npm start
```

Open `http://localhost:3000`, scan the WhatsApp QR code if needed, then send an **image document** to the configured WhatsApp chat.

## Notes

- `whatsapp-web.js` is an unofficial WhatsApp Web automation library. Its own repo explicitly notes there is no guarantee against account blocks. Use it with that risk in mind.
- The caption engine now uses local templates, optional image assist, and local keyword tightening for SEO-style devotional discovery terms.
- Hashtags are capped at 5 by design.
- Sundays are skipped by default in scheduling because the current research baseline marks them as the weakest day.
- Cloudinary upload behavior is based on the official Upload API and upload preset docs:
  - [Programmatically uploading images, videos, and other files](https://cloudinary.com/documentation/image_video_and_file_upload)
  - [Upload presets](https://cloudinary.com/documentation/upload_presets)

## Tests

```bash
npm test
```

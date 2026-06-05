import fs from 'node:fs/promises';
import path from 'node:path';
import { hostImageAsset } from '../src/services/media-hosting.js';
import { publishPinterestImageViaZernio, getZernioStatus } from '../src/services/zernio.js';

function parseArgs(argv) {
  const args = {
    image: null,
    imageUrl: null,
    caption: 'Pinterest upload test',
    title: 'Pinterest upload test',
    link: null
  };

  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--image') {
      args.image = argv[++index] || null;
    } else if (value === '--image-url') {
      args.imageUrl = argv[++index] || null;
    } else if (value === '--caption') {
      args.caption = argv[++index] || '';
    } else if (value === '--title') {
      args.title = argv[++index] || '';
    } else if (value === '--link') {
      args.link = argv[++index] || null;
    }
  }

  return args;
}

async function resolveImageUrl(input) {
  if (!input) {
    throw new Error('Provide --image <path> or --image-url <url>.');
  }

  if (/^https?:\/\//i.test(input)) {
    return input;
  }

  const stats = await fs.stat(input);
  if (!stats.isFile()) {
    throw new Error(`Image path is not a file: ${input}`);
  }

  const hosted = await hostImageAsset(path.resolve(input));
  return hosted.publicUrl;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const status = getZernioStatus();
  console.log(JSON.stringify({ zernio: status }, null, 2));

  if (!status.configured) {
    throw new Error('Zernio is not configured. Set ZERNIO_API_KEY and ZERNIO_ACCOUNT_ID first.');
  }

  const imageUrl = await resolveImageUrl(args.imageUrl || args.image);
  const result = await publishPinterestImageViaZernio({
    imageUrl,
    caption: args.caption,
    title: args.title,
    link: args.link
  });

  console.log(JSON.stringify({
    ok: true,
    provider: result.provider,
    post: result.post,
    raw: result.raw
  }, null, 2));
}

await main();

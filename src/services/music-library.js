import fs from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const DEFAULT_LIBRARY = [
  {
    id: 'krishna-flute-ringtone-download-cartoon',
    title: 'Krishna Flute Ringtone Download Cartoon',
    artist: 'Unknown',
    filename: 'Krishna Flute Ringtone Download Cartoon.mp3',
    moods: ['soft', 'playful', 'peaceful', 'flute'],
    deityTags: ['krishna', 'radha'],
    themeTags: ['peace', 'love', 'playful', 'bhakti'],
    clipStartSeconds: 0,
    reelDurationSeconds: 11
  },
  {
    id: 'mahadev-shiva-shiva',
    title: 'Mahadev Shiva Shiva',
    artist: 'Unknown',
    filename: 'Mahadev Shiva Shiva.mp3',
    moods: ['devotional', 'energetic', 'powerful', 'chant'],
    deityTags: ['shiva', 'mahadev'],
    themeTags: ['strength', 'bhakti', 'faith', 'devotion'],
    clipStartSeconds: 10,
    reelDurationSeconds: 11
  },
  {
    id: 'namah-parvati-pataye-har-har-mahadev',
    title: 'Namah Parvati Pataye Har Har Mahadev',
    artist: 'Unknown',
    filename: 'Namah Parvati Pataye Har Har Mahadev.mp3',
    moods: ['devotional', 'intense', 'traditional', 'reverent'],
    deityTags: ['shiva', 'parvati', 'mahadev'],
    themeTags: ['bhakti', 'strength', 'faith', 'surrender'],
    clipStartSeconds: 12,
    reelDurationSeconds: 11
  },
  {
    id: 'sanatani-phonk',
    title: 'Sanatani Phonk',
    artist: 'Unknown',
    filename: 'Sanatani Phonk.mp3',
    moods: ['bold', 'modern', 'phonk', 'high-energy'],
    deityTags: ['sanatan', 'shiva', 'hanuman'],
    themeTags: ['power', 'identity', 'attitude', 'youth'],
    clipStartSeconds: 16,
    reelDurationSeconds: 11
  },
  {
    id: 'shree-hanuman-chalisa-lofi-slowed-reverb',
    title: 'Shree Hanuman Chalisa - Lofi Slowed Reverb',
    artist: 'Unknown',
    filename: 'Shree Hanuman Chalisa - Lofi _ Slowed Reverb.mp3',
    moods: ['lofi', 'devotional', 'soft', 'protective'],
    deityTags: ['hanuman', 'rama'],
    themeTags: ['protection', 'faith', 'peace', 'bhakti'],
    clipStartSeconds: 24,
    reelDurationSeconds: 11
  },
  {
    id: 'shubh-sanatani',
    title: 'Shubh Sanatani',
    artist: 'Unknown',
    filename: 'Shubh Sanatani.mp3',
    moods: ['anthemic', 'confident', 'identity', 'uplifting'],
    deityTags: ['sanatan', 'rama', 'shiva'],
    themeTags: ['identity', 'strength', 'belief', 'community'],
    clipStartSeconds: 14,
    reelDurationSeconds: 11
  }
];

async function ensureDefaultLibraryFile() {
  try {
    await fs.access(config.music.libraryFile);
  } catch {
    await fs.mkdir(path.dirname(config.music.libraryFile), { recursive: true });
    await fs.writeFile(config.music.libraryFile, `${JSON.stringify(DEFAULT_LIBRARY, null, 2)}\n`, 'utf8');
  }
}

export async function loadMusicLibrary() {
  await ensureDefaultLibraryFile();
  const raw = await fs.readFile(config.music.libraryFile, 'utf8');
  const items = JSON.parse(raw);

  return items.map((item) => ({
    ...item,
    filePath: path.join(config.music.directory, item.filename),
    available: false
  }));
}

export async function getMusicLibraryStatus() {
  const library = await loadMusicLibrary();
  const items = await Promise.all(library.map(async (track) => {
    try {
      await fs.access(track.filePath);
      return { ...track, available: true };
    } catch {
      return track;
    }
  }));

  return {
    configuredTracks: items.length,
    availableTracks: items.filter((item) => item.available).length,
    items
  };
}

function scoreTrack(track, context) {
  let score = 0;

  if (track.deityTags?.includes(context.deity)) {
    score += 5;
  }

  if (track.themeTags?.includes(context.theme)) {
    score += 4;
  }

  if (context.deity === 'default' && track.themeTags?.includes('peace')) {
    score += 1;
  }

  return score;
}

function normalizeForMatch(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function scoreRequestedTrack(track, requestedText) {
  const query = normalizeForMatch(requestedText);
  if (!query) {
    return 0;
  }

  const haystack = normalizeForMatch([
    track.title,
    track.artist,
    track.filename,
    track.id,
    ...(track.moods || []),
    ...(track.themeTags || []),
    ...(track.deityTags || [])
  ].join(' '));

  if (!haystack) {
    return 0;
  }

  let score = 0;
  if (haystack.includes(query)) {
    score += 20;
  }

  for (const token of query.split(' ').filter((part) => part.length >= 3)) {
    if (haystack.includes(token)) {
      score += 4;
    }
  }

  return score;
}

export async function chooseMusicTrack({ context, requestedText = '' }) {
  const status = await getMusicLibraryStatus();
  const available = status.items.filter((item) => item.available);
  if (available.length === 0) {
    throw new Error(
      `No music files were found in ${config.music.directory}. Add your fixed Hindi tracks there so reels can be rendered with audio.`
    );
  }

  const directRanked = available
    .map((track) => ({ track, score: scoreRequestedTrack(track, requestedText) }))
    .sort((left, right) => right.score - left.score || left.track.title.localeCompare(right.track.title));

  const directWinner = directRanked[0];
  if (directWinner?.score >= 8) {
    return {
      track: directWinner.track,
      strategy: 'direct_keyword',
      preserveAudio: true,
      reasoning: [
        `Matched your text to ${directWinner.track.artist} - ${directWinner.track.title}.`,
        'Direct keyword match takes priority over theme matching when you clearly ask for a specific song.',
        'The reel will use the track without clip trimming or fade edits so it stays as close as possible to your MP3.'
      ]
    };
  }

  const ranked = available
    .map((track) => ({ track, score: scoreTrack(track, context) }))
    .sort((left, right) => right.score - left.score || left.track.title.localeCompare(right.track.title));

  const winner = ranked[0]?.track;
  if (!winner) {
    throw new Error('Music selection failed.');
  }

  return {
    track: winner,
    strategy: 'theme_match',
    preserveAudio: false,
    reasoning: [
      `Picked ${winner.artist} - ${winner.title} because it best matched the detected ${context.deity} / ${context.theme} theme.`,
      'Track selection is intentionally fixed-library only so the account keeps a repeatable sonic identity.',
      `The chosen clip starts at ${winner.clipStartSeconds}s to avoid long intros and get to the emotional center faster.`
    ]
  };
}

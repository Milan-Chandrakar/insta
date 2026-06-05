const state = {
  session: null,
  jobs: [],
  intakes: [],
  logs: [],
  scheduler: null,
  scheduleDrafts: new Map()
};

const els = {
  status: document.getElementById('systemStatus'),
  intakes: document.getElementById('intakeList'),
  destinations: document.getElementById('destinationList'),
  logs: document.getElementById('logList'),
  refresh: document.getElementById('refreshButton'),
  schedulerMode: document.getElementById('schedulerMode'),
  schedulerModeSave: document.getElementById('schedulerModeSave'),
  toast: document.getElementById('toast'),
  factoryReset: document.getElementById('factoryResetButton')
};

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 3200);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {})
    },
    ...options
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || `Request failed: ${response.status}`);
  }
  return payload;
}

function formatTime(value) {
  if (!value) {
    return 'Publish now';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return 'No time';
  }
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

function formatExactDueAt(value) {
  if (!value) {
    return null;
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZoneName: 'short'
  }).format(date);
}

function joinMeta(parts) {
  return parts.filter(Boolean).join(' - ');
}

function getJobTime(job) {
  return job?.runAt
    || job?.result?.published?.dueAt
    || job?.result?.scheduledFor
    || job?.payload?.dueAt
    || null;
}

function getIntakeForJob(job) {
  const intakeId = job?.payload?.intakeId || job?.result?.intake?.id || null;
  if (!intakeId) {
    return null;
  }
  return state.intakes.find((intake) => intake.id === intakeId) || null;
}

function getJobForIntake(intake) {
  return state.jobs.find((job) => job?.payload?.intakeId === intake?.id) || null;
}

function firstLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

function normalizeFilenameStem(filename) {
  const raw = String(filename || '').trim();
  if (!raw) {
    return '';
  }
  const noExt = raw.replace(/\.[a-z0-9]+$/i, '');
  return noExt
    .replace(/[_-]+/g, ' ')
    .replace(/\bimg\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const ENTITY_HINTS = [
  { key: 'krishna', label: 'Krishna', patterns: [/krishna/i, /\bradhe\b/i, /\bradha\b/i, /\bvrindavan\b/i, /\byamuna\b/i] },
  { key: 'shiva', label: 'Shiv', patterns: [/shiv/i, /shiva/i, /mahadev/i, /parvati/i, /shakti/i] },
  { key: 'hanuman', label: 'Hanuman', patterns: [/hanuman/i, /bajrang/i, /sankat/i, /jaishriram/i] },
  { key: 'ganesha', label: 'Ganesha', patterns: [/ganesh/i, /ganesha/i, /vinayak/i] },
  { key: 'durga', label: 'Durga', patterns: [/durga/i, /\bmaa\b/i, /navratri/i, /kali/i] }
];

function deriveEntityLabel(intake, job) {
  const contextDeity = intake?.captionPlan?.context?.deity;
  if (contextDeity) {
    const deity = String(contextDeity).toLowerCase();
    const match = ENTITY_HINTS.find((item) => item.key === deity);
    if (match) {
      return match.label;
    }
    return deity.slice(0, 1).toUpperCase() + deity.slice(1);
  }

  const hashtags = Array.isArray(intake?.captionPlan?.hashtags) ? intake.captionPlan.hashtags : [];
  const pool = [
    intake?.captionPlan?.titleHint,
    intake?.distributionPlan?.instagram?.caption,
    intake?.captionOverride,
    intake?.body,
    ...hashtags.map((tag) => `#${tag}`)
  ].filter(Boolean).join('\n');

  for (const hint of ENTITY_HINTS) {
    if (hint.patterns.some((pattern) => pattern.test(pool))) {
      return hint.label;
    }
  }

  const filename = intake?.originalFilename || intake?.filename || '';
  const stem = normalizeFilenameStem(filename);
  if (stem && !/^img\s*\d+$/i.test(stem)) {
    return stem.split(' ').slice(0, 2).join(' ');
  }

  return intake?.distributionPlan?.instagram?.location ? 'Devotional' : 'Post';
}

function captionFor(intake, job) {
  return firstLine(
    intake?.captionPlan?.caption
    || intake?.distributionPlan?.instagram?.caption
    || intake?.caption
    || job?.result?.captionPlan?.caption
    || job?.payload?.captionHint
    || ''
  );
}

function formatBadgeFor(intake, job) {
  if (job?.kind === 'publish-carousel-intake' || intake?.sourceFormat === 'zip_carousel' || intake?.publishStrategy === 'graph_carousel') {
    return 'carousel';
  }
  if (intake?.route?.mediaKind === 'video' || /\.mp4$/i.test(intake?.originalFilename || intake?.filename || '')) {
    return 'video';
  }
  const instagram = intake?.route?.instagramFormat || intake?.routingPlan?.instagramFormat || intake?.distributionPlan?.instagram?.type || null;
  if (instagram) {
    return String(instagram).toLowerCase();
  }
  return intake?.mediaKind || 'post';
}

function titleFor(intake, job) {
  const entity = deriveEntityLabel(intake, job);
  const badge = formatBadgeFor(intake, job);
  const hint = firstLine(intake?.captionPlan?.titleHint) || '';
  if (hint && hint.length <= 48 && !/^img[_\s-]?\d+/i.test(hint)) {
    return hint;
  }
  return `${entity} - ${badge}`;
}

function isCarousel(intake, job) {
  return job?.kind === 'publish-carousel-intake'
    || intake?.publishStrategy === 'graph_carousel'
    || intake?.sourceFormat === 'zip_carousel';
}

function isVideo(intake) {
  return intake?.route?.mediaKind === 'video'
    || /\.(mp4)$/i.test(intake?.originalFilename || intake?.filename || '');
}

function destinationsFor(intake, job) {
  const targets = Array.isArray(job?.result?.publishedTargets)
    ? job.result.publishedTargets.map((target) => target.platform || target.type).filter(Boolean)
    : [];
  if (targets.length) {
    return [...new Set(targets)].join(' + ');
  }
  if (isCarousel(intake, job)) {
    return 'Instagram Carousel + Pinterest Pins';
  }
  if (isVideo(intake)) {
    return 'Instagram Reels + YouTube Shorts';
  }
  return 'Instagram Post + Pinterest Pin';
}

function statusClass(status) {
  const value = String(status || '').toLowerCase();
  if (['completed', 'published', 'scheduled', 'queued'].includes(value)) {
    return 'good';
  }
  if (['failed', 'cancelled'].includes(value)) {
    return 'bad';
  }
  return '';
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function titleCase(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .trim()
    .replace(/\w\S*/g, (word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase());
}

function formatTimestamp(value) {
  if (!value) {
    return '';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return '';
  }
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric',
    month: 'short',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  }).format(date);
}

function scheduleKey(job) {
  return job?.id || job?.payload?.intakeId || crypto.randomUUID();
}

function renderScheduleControls(job, intake) {
  const locked = !['queued', 'scheduled'].includes(String(job.status || '').toLowerCase());
  const key = scheduleKey(job);
  const draft = state.scheduleDrafts.get(key) || {
    mode: 'auto',
    scheduledFor: ''
  };
  const customHidden = draft.mode !== 'custom' ? 'hidden' : '';
  return `
    <div class="controls" data-key="${escapeHtml(key)}" data-job-id="${escapeHtml(job.id)}" data-intake-id="${escapeHtml(intake?.id || job?.payload?.intakeId || '')}" data-carousel="${isCarousel(intake, job) ? 'true' : 'false'}">
      <select class="schedule-mode" ${locked ? 'disabled' : ''}>
        <option value="auto" ${draft.mode === 'auto' ? 'selected' : ''}>Auto schedule</option>
        <option value="now" ${draft.mode === 'now' ? 'selected' : ''}>Publish now</option>
        <option value="custom" ${draft.mode === 'custom' ? 'selected' : ''}>Custom time</option>
      </select>
      <input class="schedule-custom" type="datetime-local" value="${escapeHtml(draft.scheduledFor)}" ${customHidden} ${locked ? 'disabled' : ''}>
      <button class="primary schedule-apply" type="button" ${locked ? 'disabled' : ''}>Apply</button>
    </div>
  `;
}

function renderIntakes() {
  const intakes = state.intakes.slice(0, 14);
  if (!intakes.length) {
    els.intakes.innerHTML = '<div class="empty">No WhatsApp intakes yet.</div>';
    return;
  }

  els.intakes.innerHTML = intakes.map((intake) => {
    const job = getJobForIntake(intake);
    const status = String(intake.status || '').toLowerCase();
    const dueAt = getJobTime(job) || intake?.schedule?.dueAt || intake?.scheduledFor || null;
    const exactDue = formatExactDueAt(dueAt);
    const badge = formatBadgeFor(intake, job);
    const caption = captionFor(intake, job) || firstLine(intake?.captionOverride) || '';

    return `
      <section class="item">
        <div class="item-top">
          <div class="title">${escapeHtml(titleFor(intake, job))}</div>
          <span class="pill ${statusClass(intake.status)}">${escapeHtml(intake.status || 'new')}</span>
        </div>
        <p class="meta">${escapeHtml(joinMeta([badge, exactDue || formatTime(intake.createdAt), intake.chatName || 'Insta Automation']))}</p>
        <p class="copy">${escapeHtml(caption || intake.currentStageLabel || 'Waiting for processing')}</p>
      </section>
    `;
  }).join('');
}

function renderDestinations() {
  const items = state.jobs
    .filter((job) => ['queued', 'scheduled', 'running'].includes(String(job.status || '').toLowerCase()))
    .sort((left, right) => {
      const leftTime = new Date(getJobTime(left) || left.createdAt || 0).getTime();
      const rightTime = new Date(getJobTime(right) || right.createdAt || 0).getTime();
      return leftTime - rightTime;
    })
    .slice(0, 14);
  if (!items.length) {
    els.destinations.innerHTML = '<div class="empty">No upcoming publishes queued.</div>';
    return;
  }

  els.destinations.innerHTML = items.map((job) => {
    const intake = getIntakeForJob(job);
    const dueAt = getJobTime(job) || intake?.schedule?.dueAt || null;
    const exactDue = formatExactDueAt(dueAt);
    const caption = captionFor(intake, job);
    const badge = formatBadgeFor(intake, job);
    const scheduleIntent = isCarousel(intake, job) ? 'Carousel slot' : badge === 'reel' || badge === 'video' ? 'Reel slot' : 'Post slot';
    return `
      <section class="item">
        <div class="item-top">
          <div>
            <div class="title">${escapeHtml(titleFor(intake, job))}</div>
            <p class="meta">${escapeHtml(joinMeta([scheduleIntent, exactDue || formatTime(dueAt)]))}</p>
          </div>
          <span class="pill ${statusClass(job.status)}">${escapeHtml(job.status || 'queued')}</span>
        </div>
        <p class="destinations">${escapeHtml(destinationsFor(intake, job))}</p>
        <p class="copy">Caption: ${escapeHtml(caption || 'Pending caption')}</p>
        ${renderScheduleControls(job, intake)}
      </section>
    `;
  }).join('');
}

function renderLogs() {
  const logs = state.logs.slice(0, 30);
  if (!logs.length) {
    els.logs.innerHTML = '<div class="empty">No logs yet.</div>';
    return;
  }

  els.logs.innerHTML = logs.map((log) => {
    const title = log.service === 'workflow'
      ? `${titleCase(log.service)} · ${titleCase(log.stage || log.operation)}`
      : `${titleCase(log.service || 'log')} · ${titleCase(log.operation || 'event')}`;
    const time = formatTimestamp(log.timestamp || log.createdAt);
    const summary = log.summary || log.error || log.details?.message || '—';

    return `
      <section class="item">
        <div class="item-top">
          <div class="title">${escapeHtml(title)}</div>
          <span class="meta">${escapeHtml(time)}</span>
        </div>
        <p class="copy">${escapeHtml(summary)}</p>
      </section>
    `;
  }).join('');
}

function renderStatus() {
  const whatsapp = state.session?.whatsapp?.ready ? 'WhatsApp ready' : 'WhatsApp not ready';
  const buffer = state.session?.bufferConfigured ? 'Buffer connected' : 'Buffer missing';
  const mode = state.session?.scheduler?.executionMode === 'github_actions_window'
    ? 'GitHub Actions windows only'
    : 'Local worker always on';
  const worker = state.session?.process?.paused ? 'Worker paused' : mode;
  els.status.textContent = joinMeta([whatsapp, buffer, worker]);
}

function renderSchedulerMode() {
  if (!els.schedulerMode) {
    return;
  }

  const executionMode = state.session?.scheduler?.executionMode || 'local_worker';
  state.scheduler = state.session?.scheduler || null;
  els.schedulerMode.value = executionMode;
  if (els.schedulerModeSave) {
    els.schedulerModeSave.textContent = executionMode === 'github_actions_window'
      ? 'GitHub Actions mode'
      : 'Local worker mode';
  }
}

function renderAll() {
  renderStatus();
  renderIntakes();
  renderDestinations();
  renderLogs();
}

async function refresh() {
  const [session, jobs, intakes, logs] = await Promise.all([
    requestJson('/api/session'),
    requestJson('/api/jobs?limit=80'),
    requestJson('/api/intakes'),
    requestJson('/api/logs')
  ]);
  state.session = session;
  state.jobs = jobs.jobs || [];
  state.intakes = intakes.intakes || [];
  state.logs = logs.logs || [];
  renderSchedulerMode();
  renderAll();
}

async function saveSchedulerMode() {
  if (!els.schedulerMode) {
    return;
  }

  const executionMode = els.schedulerMode.value;
  await requestJson('/api/scheduler/mode', {
    method: 'POST',
    body: JSON.stringify({ executionMode })
  });
  showToast(executionMode === 'github_actions_window'
    ? 'GitHub Actions windows only mode saved.'
    : 'Local worker mode saved.');
  await refresh();
}

async function applySchedule(control) {
  const key = control.dataset.key;
  const intakeId = control.dataset.intakeId;
  const mode = control.querySelector('.schedule-mode').value;
  const scheduledFor = control.querySelector('.schedule-custom').value;
  if (!intakeId) {
    showToast('Missing intake id for this queued item.');
    return;
  }
  if (mode === 'custom' && !scheduledFor) {
    showToast('Pick a custom time first.');
    return;
  }

  state.scheduleDrafts.set(key, { mode, scheduledFor });
  const endpoint = control.dataset.carousel === 'true'
    ? `/api/carousel/${encodeURIComponent(intakeId)}/schedule`
    : `/api/intakes/${encodeURIComponent(intakeId)}/requeue`;
  await requestJson(endpoint, {
    method: 'POST',
    body: JSON.stringify({
      scheduleMode: mode,
      scheduledFor: mode === 'custom' ? new Date(scheduledFor).toISOString() : undefined
    })
  });
  showToast(mode === 'now' ? 'Queued for publish now.' : 'Schedule updated.');
  await refresh();
}

document.addEventListener('change', (event) => {
  if (!event.target.matches('.schedule-mode')) {
    return;
  }
  const control = event.target.closest('.controls');
  const input = control.querySelector('.schedule-custom');
  const mode = event.target.value;
  const key = control.dataset.key;
  const current = state.scheduleDrafts.get(key) || {};
  state.scheduleDrafts.set(key, {
    mode,
    scheduledFor: input.value || current.scheduledFor || ''
  });
  input.hidden = mode !== 'custom';
});

document.addEventListener('input', (event) => {
  if (!event.target.matches('.schedule-custom')) {
    return;
  }
  const control = event.target.closest('.controls');
  const key = control.dataset.key;
  const mode = control.querySelector('.schedule-mode').value;
  state.scheduleDrafts.set(key, {
    mode,
    scheduledFor: event.target.value
  });
});

document.addEventListener('click', async (event) => {
  if (!event.target.matches('.schedule-apply')) {
    return;
  }
  const button = event.target;
  const control = button.closest('.controls');
  button.disabled = true;
  try {
    await applySchedule(control);
  } catch (error) {
    showToast(error.message);
  } finally {
    button.disabled = false;
  }
});

els.refresh.addEventListener('click', () => {
  refresh().catch((error) => showToast(error.message));
});

els.factoryReset?.addEventListener('click', async () => {
  if (!window.confirm('Are you sure you want to delete ALL queue data and logs? This will wipe the dashboard clean. This action cannot be undone.')) {
    return;
  }
  els.factoryReset.disabled = true;
  try {
    const result = await requestJson('/api/system/reset', { method: 'POST' });
    showToast(result.message || 'System reset successful');
    await refresh();
  } catch (error) {
    showToast(`Reset failed: ${error.message}`);
  } finally {
    els.factoryReset.disabled = false;
  }
});

els.schedulerModeSave?.addEventListener('click', () => {
  saveSchedulerMode().catch((error) => showToast(error.message));
});

refresh().catch((error) => {
  els.status.textContent = 'Dashboard failed to load';
  showToast(error.message);
});

window.setInterval(() => {
  refresh().catch(() => {});
}, 10000);

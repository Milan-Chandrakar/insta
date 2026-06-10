const state = {
  session: null,
  jobs: [],
  intakes: [],
  logs: [],
  scheduleDrafts: new Map()
};

const els = {
  status: document.getElementById('systemStatus'),
  intakes: document.getElementById('intakeList'),
  destinations: document.getElementById('destinationList'),
  logs: document.getElementById('logList'),
  refresh: document.getElementById('refreshButton'),
  toast: document.getElementById('toast'),
  factoryReset: document.getElementById('factoryResetButton')
};

// ─── Toast ────────────────────────────────────────────────────────────────────

function showToast(message) {
  els.toast.textContent = message;
  els.toast.hidden = false;
  window.clearTimeout(showToast.timer);
  showToast.timer = window.setTimeout(() => {
    els.toast.hidden = true;
  }, 3200);
}

// ─── API ──────────────────────────────────────────────────────────────────────

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

// ─── Formatters ───────────────────────────────────────────────────────────────

function formatTime(value) {
  if (!value) return 'Publish now';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'No time';
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(date);
}

function formatExactDueAt(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat('en-IN', {
    weekday: 'short', day: '2-digit', month: 'short', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short'
  }).format(date);
}

function formatTimestamp(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-IN', {
    day: 'numeric', month: 'short',
    hour: 'numeric', minute: '2-digit', hour12: true
  }).format(date);
}

function joinMeta(parts) {
  return parts.filter(Boolean).join(' · ');
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
    .replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());
}

function firstLine(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) || '';
}

function normalizeFilenameStem(filename) {
  const raw = String(filename || '').trim();
  if (!raw) return '';
  const noExt = raw.replace(/\.[a-z0-9]+$/i, '');
  return noExt.replace(/[_-]+/g, ' ').replace(/\bimg\b/gi, '').replace(/\s+/g, ' ').trim();
}

// ─── Content helpers ──────────────────────────────────────────────────────────

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
    const match = ENTITY_HINTS.find((h) => h.key === deity);
    if (match) return match.label;
    return deity.slice(0, 1).toUpperCase() + deity.slice(1);
  }
  const hashtags = Array.isArray(intake?.captionPlan?.hashtags) ? intake.captionPlan.hashtags : [];
  const pool = [
    intake?.captionPlan?.titleHint,
    intake?.distributionPlan?.instagram?.caption,
    intake?.captionOverride,
    intake?.body,
    ...hashtags.map((t) => `#${t}`)
  ].filter(Boolean).join('\n');
  for (const hint of ENTITY_HINTS) {
    if (hint.patterns.some((p) => p.test(pool))) return hint.label;
  }
  const stem = normalizeFilenameStem(intake?.originalFilename || intake?.filename || '');
  if (stem && !/^img\s*\d+$/i.test(stem)) return stem.split(' ').slice(0, 2).join(' ');
  return 'Post';
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

function formatBadgeFor(intake, job) {
  if (isCarousel(intake, job)) return 'carousel';
  if (isVideo(intake)) return 'video';
  const instagram = intake?.route?.instagramFormat || intake?.distributionPlan?.instagram?.type || null;
  if (instagram) return String(instagram).toLowerCase();
  return intake?.mediaKind || 'post';
}

function titleFor(intake, job) {
  const entity = deriveEntityLabel(intake, job);
  const badge = formatBadgeFor(intake, job);
  const hint = firstLine(intake?.captionPlan?.titleHint) || '';
  if (hint && hint.length <= 48 && !/^img[_\s-]?\d+/i.test(hint)) return hint;
  return `${entity} — ${badge}`;
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

function destinationsFor(intake, job) {
  const targets = Array.isArray(job?.result?.publishedTargets)
    ? job.result.publishedTargets.map((t) => t.platform || t.type).filter(Boolean)
    : [];
  if (targets.length) return [...new Set(targets)].join(' + ');
  if (isCarousel(intake, job)) return 'Instagram Carousel → GitHub Actions';
  if (isVideo(intake)) return 'Instagram Reels → Buffer';
  return 'Instagram Post → Buffer';
}

function getJobTime(job) {
  return job?.runAt || job?.result?.published?.dueAt || job?.result?.scheduledFor || job?.payload?.dueAt || null;
}

function getIntakeForJob(job) {
  const intakeId = job?.payload?.intakeId || job?.result?.intake?.id || null;
  if (!intakeId) return null;
  return state.intakes.find((i) => i.id === intakeId) || null;
}

function getJobForIntake(intake) {
  return state.jobs.find((j) => j?.payload?.intakeId === intake?.id) || null;
}

function statusClass(status) {
  const v = String(status || '').toLowerCase();
  if (['completed', 'published', 'scheduled', 'queued', 'holding'].includes(v)) return 'good';
  if (['failed', 'cancelled', 'skipped'].includes(v)) return 'bad';
  return '';
}

// ─── Pipeline step resolver ───────────────────────────────────────────────────
// Maps raw log entries to human-readable named steps

const STEP_RULES = [
  {
    match: (l) => l.service === 'whatsapp' && l.operation === 'message' && l.status === 'success',
    step: 'Received', color: 'step-received'
  },
  {
    match: (l) => l.service === 'whatsapp' && l.operation === 'session' && l.status === 'running',
    step: 'WhatsApp Starting', color: 'step-running'
  },
  {
    match: (l) => l.service === 'whatsapp' && l.operation === 'session' && l.status === 'success',
    step: 'WhatsApp Ready', color: 'step-done'
  },
  {
    match: (l) => l.service === 'workflow' && l.stage === 'upload',
    step: 'Uploading', color: 'step-running'
  },
  {
    match: (l) => l.service === 'cloudinary' && l.status === 'success',
    step: 'Uploaded', color: 'step-done'
  },
  {
    match: (l) => l.service === 'workflow' && l.stage === 'caption',
    step: 'Captioning', color: 'step-running'
  },
  {
    match: (l) => l.service === 'workflow' && l.stage === 'schedule',
    step: 'Scheduling', color: 'step-running'
  },
  {
    match: (l) => l.service === 'workflow' && l.stage === 'publish',
    step: 'Publishing', color: 'step-running'
  },
  {
    match: (l) => l.service === 'workflow' && l.status === 'success' && /publish|posted/i.test(l.summary || ''),
    step: 'Published', color: 'step-done'
  },
  {
    match: (l) => l.service === 'workflow' && l.status === 'error',
    step: 'Failed', color: 'step-error'
  },
  {
    match: (l) => l.service === 'buffer' && l.status === 'success',
    step: 'Sent to Buffer', color: 'step-done'
  },
  {
    match: (l) => l.service === 'instagram-graph' && l.status === 'success',
    step: 'Published to Instagram', color: 'step-done'
  },
  {
    match: (l) => l.status === 'error' || l.status === 'failed',
    step: 'Error', color: 'step-error'
  }
];

function resolveStep(logEntry) {
  for (const rule of STEP_RULES) {
    if (rule.match(logEntry)) {
      return { step: rule.step, color: rule.color };
    }
  }
  return null; // skip unrecognised entries
}

// ─── Render: Intakes ──────────────────────────────────────────────────────────

function scheduleKey(job) {
  return job?.id || job?.payload?.intakeId || crypto.randomUUID();
}

function renderScheduleControls(job, intake) {
  const locked = !['queued', 'scheduled'].includes(String(job.status || '').toLowerCase());
  const key = scheduleKey(job);
  const draft = state.scheduleDrafts.get(key) || { mode: 'auto', scheduledFor: '' };
  const isCar = isCarousel(intake, job);
  const customHidden = draft.mode !== 'custom' ? 'hidden' : '';
  const inputType = 'datetime-local';
  const customLabel = 'Custom time';

  let draftVal = draft.scheduledFor || '';
  if (draftVal.endsWith('Z')) {
    // If it's an ISO string from the backend, we should format it to local time for the input
    const d = new Date(draftVal);
    if (!Number.isNaN(d.getTime())) {
      draftVal = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    }
  }

  return `
    <div class="controls" data-key="${escapeHtml(key)}" data-job-id="${escapeHtml(job.id)}" data-intake-id="${escapeHtml(intake?.id || job?.payload?.intakeId || '')}" data-carousel="${isCar ? 'true' : 'false'}">
      <select class="schedule-mode" ${locked ? 'disabled' : ''}>
        <option value="auto" ${draft.mode === 'auto' ? 'selected' : ''}>Auto schedule</option>
        <option value="now" ${draft.mode === 'now' ? 'selected' : ''}>Publish now</option>
        <option value="custom" ${draft.mode === 'custom' ? 'selected' : ''}>${customLabel}</option>
      </select>
      <input class="schedule-custom" type="${inputType}" value="${escapeHtml(draftVal)}" ${customHidden} ${locked ? 'disabled' : ''}>
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

// ─── Render: Destinations ─────────────────────────────────────────────────────

function renderDestinations() {
  const items = state.jobs
    .filter((j) => ['queued', 'scheduled', 'running'].includes(String(j.status || '').toLowerCase()))
    .sort((a, b) => {
      const at = new Date(getJobTime(a) || a.createdAt || 0).getTime();
      const bt = new Date(getJobTime(b) || b.createdAt || 0).getTime();
      return at - bt;
    })
    .slice(0, 14);

  if (!items.length) {
    els.destinations.innerHTML = '<div class="empty">No upcoming posts queued.</div>';
    return;
  }

  els.destinations.innerHTML = items.map((job) => {
    const intake = getIntakeForJob(job);
    const dueAt = getJobTime(job) || intake?.schedule?.dueAt || null;
    const exactDue = formatExactDueAt(dueAt);
    const caption = captionFor(intake, job);
    const badge = formatBadgeFor(intake, job);
    const canDelete = job.status === 'queued';

    return `
      <section class="item">
        <div class="item-top">
          <div>
            <div class="title">${escapeHtml(titleFor(intake, job))}</div>
            <p class="meta">${escapeHtml(joinMeta([badge, exactDue || formatTime(dueAt)]))}</p>
          </div>
          <div style="display:flex;align-items:center;gap:8px;flex-shrink:0">
            <span class="pill ${statusClass(job.status)}">${escapeHtml(job.status || 'queued')}</span>
            ${canDelete ? `<button class="queue-delete" data-job-id="${escapeHtml(job.id)}" title="Remove from queue" type="button" style="background:none;border:1px solid #c0392b;color:#c0392b;border-radius:6px;padding:3px 8px;cursor:pointer;font-size:13px;line-height:1" aria-label="Delete job">✕</button>` : ''}
          </div>
        </div>
        <p class="destinations">${escapeHtml(destinationsFor(intake, job))}</p>
        <p class="copy">${escapeHtml(caption || 'Caption pending')}</p>
        ${renderScheduleControls(job, intake)}
      </section>
    `;
  }).join('');
}

// ─── Render: Pipeline Log ─────────────────────────────────────────────────────

function renderLogs() {
  const entries = state.logs.slice(0, 60);

  const meaningful = [];
  for (const log of entries) {
    const resolved = resolveStep(log);
    if (!resolved) continue;
    meaningful.push({ log, resolved });
    if (meaningful.length >= 12) break;
  }

  if (!meaningful.length) {
    els.logs.innerHTML = '<div class="empty">No pipeline events yet.</div>';
    return;
  }

  els.logs.innerHTML = meaningful.map(({ log, resolved }) => {
    const time = formatTimestamp(log.timestamp || log.createdAt);
    const summary = log.summary || log.error || '—';
    const detail = log.details?.filename || log.details?.intakeId
      ? (log.details.filename || `intake ${String(log.details.intakeId || '').slice(0, 8)}`)
      : null;

    return `
      <div class="log-entry">
        <span class="log-step ${resolved.color}">${escapeHtml(resolved.step)}</span>
        <span class="log-body">
          <span class="log-summary">${escapeHtml(summary)}</span>
          ${detail ? `<span class="log-detail">${escapeHtml(detail)}</span>` : ''}
        </span>
        <span class="log-time">${escapeHtml(time)}</span>
      </div>
    `;
  }).join('');
}

// ─── Render: Status bar ───────────────────────────────────────────────────────

function renderStatus() {
  const whatsapp = state.session?.whatsapp?.ready ? '✓ WhatsApp' : '✗ WhatsApp offline';
  const buffer = state.session?.bufferConfigured ? '✓ Buffer' : '✗ Buffer missing';
  const worker = state.session?.process?.paused ? '⏸ Worker paused' : '✓ Worker running';
  els.status.textContent = joinMeta([whatsapp, buffer, worker]);
}

// ─── Render: All ─────────────────────────────────────────────────────────────

function renderAll() {
  renderStatus();
  renderIntakes();
  renderDestinations();
  renderLogs();
}

// ─── Data fetch ───────────────────────────────────────────────────────────────

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
  renderAll();
}

// ─── Schedule apply ───────────────────────────────────────────────────────────

async function applySchedule(control) {
  const key = control.dataset.key;
  const intakeId = control.dataset.intakeId;
  const mode = control.querySelector('.schedule-mode').value;
  const scheduledFor = control.querySelector('.schedule-custom').value;
  const isCar = control.dataset.carousel === 'true';

  if (!intakeId) { showToast('Missing intake id.'); return; }
  if (mode === 'custom' && !scheduledFor) {
    showToast('Pick a date and time first.');
    return;
  }

  state.scheduleDrafts.set(key, { mode, scheduledFor });

  let scheduledForISO = undefined;
  if (mode === 'custom') {
    scheduledForISO = new Date(scheduledFor).toISOString();
  }

  const endpoint = isCar
    ? `/api/carousel/${encodeURIComponent(intakeId)}/schedule`
    : `/api/intakes/${encodeURIComponent(intakeId)}/requeue`;

  await requestJson(endpoint, {
    method: 'POST',
    body: JSON.stringify({ scheduleMode: mode, scheduledFor: scheduledForISO })
  });

  showToast(mode === 'now' ? 'Queued for immediate publish.' : 'Schedule updated.');
  await refresh();
}

// ─── Events ───────────────────────────────────────────────────────────────────

document.addEventListener('change', (event) => {
  if (!event.target.matches('.schedule-mode')) return;
  const control = event.target.closest('.controls');
  const input = control.querySelector('.schedule-custom');
  const mode = event.target.value;
  const key = control.dataset.key;
  const current = state.scheduleDrafts.get(key) || {};
  state.scheduleDrafts.set(key, { mode, scheduledFor: input.value || current.scheduledFor || '' });
  input.hidden = mode !== 'custom';
});

document.addEventListener('input', (event) => {
  if (!event.target.matches('.schedule-custom')) return;
  const control = event.target.closest('.controls');
  const key = control.dataset.key;
  const mode = control.querySelector('.schedule-mode').value;
  state.scheduleDrafts.set(key, { mode, scheduledFor: event.target.value });
});

document.addEventListener('click', async (event) => {
  if (event.target.matches('.schedule-apply')) {
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
    return;
  }

  if (event.target.matches('.queue-delete')) {
    const button = event.target;
    const jobId = button.dataset.jobId;
    if (!jobId) return;
    if (!window.confirm('Remove this post from the queue? This cannot be undone.')) return;
    button.disabled = true;
    try {
      await requestJson(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
      showToast('Post removed from queue.');
      await refresh();
    } catch (error) {
      showToast(`Delete failed: ${error.message}`);
      button.disabled = false;
    }
  }
});


els.refresh.addEventListener('click', () => {
  refresh().catch((e) => showToast(e.message));
});

els.factoryReset?.addEventListener('click', async () => {
  if (!window.confirm('Delete ALL queue data and logs? This cannot be undone.')) return;
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

const uploadMediaButton = document.getElementById('uploadMediaButton');
const directUploadInput = document.getElementById('directUploadInput');
const restartWhatsappButton = document.getElementById('restartWhatsappButton');

if (restartWhatsappButton) {
  restartWhatsappButton.addEventListener('click', async () => {
    restartWhatsappButton.disabled = true;
    showToast('Restarting WhatsApp...');
    try {
      const result = await requestJson('/api/whatsapp/restart', { method: 'POST' });
      showToast(result.message || 'WhatsApp restarted');
      await refresh();
    } catch (error) {
      showToast(`Restart failed: ${error.message}`);
    } finally {
      restartWhatsappButton.disabled = false;
    }
  });
}

if (uploadMediaButton && directUploadInput) {
  uploadMediaButton.addEventListener('click', () => {
    directUploadInput.click();
  });

  directUploadInput.addEventListener('change', async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    uploadMediaButton.disabled = true;
    uploadMediaButton.textContent = 'Uploading...';
    showToast('Uploading file to dashboard...');

    try {
      const formData = new FormData();
      formData.append('file', file);

      const response = await fetch('/api/intakes/upload', {
        method: 'POST',
        body: formData
      });

      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload.error || 'Upload failed');
      }

      showToast('File successfully uploaded into queue!');
      await refresh();
    } catch (error) {
      showToast(`Upload Error: ${error.message}`);
    } finally {
      uploadMediaButton.disabled = false;
      uploadMediaButton.textContent = 'Upload Media';
      directUploadInput.value = ''; // Reset input
    }
  });
}

// ─── Init ─────────────────────────────────────────────────────────────────────

refresh().catch((error) => {
  els.status.textContent = 'Dashboard failed to load';
  showToast(error.message);
});

window.setInterval(() => {
  refresh().catch(() => {});
}, 10000);

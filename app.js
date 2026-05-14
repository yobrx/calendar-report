// ── Constantes ────────────────────────────────────────────────────────────────

const SCOPES         = 'https://www.googleapis.com/auth/calendar.readonly';
const DEFAULT_WEEKS  = 9;
const WORKING_HOURS  = 7;

// Mapping par défaut (pré-remplit la config à la première ouverture)
const DEFAULT_COLOR_MAP = {
  '1':  { label: 'KaraFun Business',   excluded: false },
  '3':  { label: 'VK',                 excluded: false },
  '5':  { label: 'Perso',              excluded: true  },
  '7':  { label: 'KaraFun Retail',     excluded: false },
  '8':  { label: 'All Products',       excluded: false },
  '9':  { label: 'KaraFun Standard',   excluded: false },
  '10': { label: 'Autre (à préciser)', excluded: false },
  '11': { label: 'Jamzone',            excluded: false },
};
const DEFAULT_OOF_LABEL = 'Autre (à préciser)';

// ── LocalStorage ──────────────────────────────────────────────────────────────

const store = {
  get:     k     => localStorage.getItem(k),
  set:     (k,v) => localStorage.setItem(k, v),
  rm:      k     => localStorage.removeItem(k),
  getJSON: k     => { try { return JSON.parse(localStorage.getItem(k)); } catch { return null; } },
  setJSON: (k,v) => localStorage.setItem(k, JSON.stringify(v)),
};

const getClientId   = () => store.get('gcal_client_id')   || '';
const getCalendarId = () => store.get('gcal_calendar_id') || 'primary';
const getApiColors  = () => store.getJSON('gcal_api_colors') || {};
const getOofLabel   = () => store.get('gcal_oof_label') ?? DEFAULT_OOF_LABEL;
const getWeeksCount = () => parseInt(store.get('gcal_weeks') || DEFAULT_WEEKS, 10) || DEFAULT_WEEKS;
const getColorOrder = () => store.getJSON('gcal_color_order') || [];
const hasColorMap   = () => store.get('gcal_color_map') !== null;
const getColorMap   = () => {
  const m = store.getJSON('gcal_color_map');
  return m !== null ? m : DEFAULT_COLOR_MAP;
};

// ── État ─────────────────────────────────────────────────────────────────────

let gapiInited  = false;
let gisInited   = false;
let tokenClient = null;
let accessToken = null;
let lastReport  = null;

// ── DOM ───────────────────────────────────────────────────────────────────────

const $ = id => document.getElementById(id);

const SCREENS = {
  setup:  $('setup-screen'),
  auth:   $('auth-screen'),
  config: $('config-screen'),
  report: $('report-screen'),
};

function showScreen(name) {
  Object.values(SCREENS).forEach(s => s.classList.add('hidden'));
  SCREENS[name]?.classList.remove('hidden');
}

// ── Init Google APIs ──────────────────────────────────────────────────────────

function gapiLoaded() {
  gapi.load('client', async () => {
    await gapi.client.init({
      discoveryDocs: ['https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest'],
    });
    gapiInited = true;
    checkReady();
  });
}

function gisLoaded() {
  const clientId = getClientId();
  if (!clientId) { gisInited = true; checkReady(); return; }
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: clientId,
    scope: SCOPES,
    callback: handleTokenResponse,
  });
  gisInited = true;
  checkReady();
}

function checkReady() {
  if (!gapiInited || !gisInited) return;
  if (!getClientId()) {
    showScreen('setup');
    return;
  }
  // Tentative de reconnexion silencieuse (sans prompt)
  showScreen('auth');
  tokenClient.requestAccessToken({ prompt: '' });
}

// ── Auth ──────────────────────────────────────────────────────────────────────

function handleTokenResponse(resp) {
  if (resp.error) {
    // Reconnexion silencieuse impossible → affiche le bouton de connexion manuelle
    $('sign-in-btn').disabled = false;
    return;
  }
  accessToken = resp.access_token;
  $('user-email').textContent = getCalendarId();
  if (!hasColorMap()) {
    showScreen('config');
    loadColorConfig();
  } else {
    showScreen('report');
    loadReport();
  }
}

// ── Écouteurs ─────────────────────────────────────────────────────────────────

$('save-setup-btn').addEventListener('click', () => {
  const id = $('client-id-input').value.trim();
  if (!id) { alert('Veuillez entrer un Client ID.'); return; }
  store.set('gcal_client_id', id);
  window.location.reload();
});

$('sign-in-btn').addEventListener('click', () => {
  tokenClient.requestAccessToken({ prompt: 'select_account' });
});

$('reset-config-btn').addEventListener('click', () => {
  if (accessToken) {
    showScreen('config');
    loadColorConfig();
  } else {
    showScreen('setup');
  }
});

$('save-color-map-btn').addEventListener('click', () => {
  const calId = $('config-calendar-input').value.trim() || 'primary';
  store.set('gcal_calendar_id', calId);
  $('user-email').textContent = calId;

  const weeks = parseInt($('config-weeks-input').value, 10);
  store.set('gcal_weeks', isNaN(weeks) || weeks < 1 ? DEFAULT_WEEKS : weeks);

  const rows = [...document.querySelectorAll('.color-row[data-cid]')];
  store.setJSON('gcal_color_order', rows.map(r => r.dataset.cid));
  const map = {};
  rows.forEach(row => {
    const cid      = row.dataset.cid;
    const label    = row.querySelector('.label-input').value.trim();
    const excluded = row.querySelector('.exclude-check').checked;
    if (label) map[cid] = { label, excluded };
  });
  store.setJSON('gcal_color_map', map);
  store.set('gcal_oof_label', $('oof-label-input').value.trim());

  showScreen('report');
  loadReport();
});

$('back-to-report-btn').addEventListener('click', () => showScreen('report'));

$('settings-btn').addEventListener('click', () => {
  showScreen('config');
  loadColorConfig();
});

$('refresh-btn').addEventListener('click', loadReport);

$('export-btn').addEventListener('click', () => { if (lastReport) exportCSV(lastReport); });

$('sign-out-btn').addEventListener('click', () => {
  if (accessToken) google.accounts.oauth2.revoke(accessToken);
  accessToken = null;
  lastReport  = null;
  $('report-container').innerHTML = '';
  showScreen('auth');
});

// ── Config : chargement et rendu ──────────────────────────────────────────────

async function loadColorConfig() {
  $('config-loading').classList.remove('hidden');
  $('config-form').classList.add('hidden');
  $('config-calendar-input').value = getCalendarId();
  $('config-weeks-input').value    = getWeeksCount();
  $('oof-label-input').value       = getOofLabel();
  $('back-to-report-btn').classList.toggle('hidden', !lastReport);

  try {
    const { from, to } = completeWeeksBounds(getWeeksCount());
    const [colorsRes, eventsRes, calListRes] = await Promise.all([
      gapi.client.calendar.colors.get(),
      gapi.client.calendar.events.list({
        calendarId:   getCalendarId(),
        timeMin:      from.toISOString(),
        timeMax:      to.toISOString(),
        singleEvents: true,
        maxResults:   2500,
        fields:       'items(colorId)',
      }),
      gapi.client.calendar.calendarList.list({ fields: 'items(id,summary)' }),
    ]);

    const datalist = $('calendar-list');
    datalist.innerHTML = (calListRes.result.items || [])
      .map(c => `<option value="${esc(c.id)}">${esc(c.summary)}</option>`)
      .join('');

    const apiColors = colorsRes.result.event || {};
    store.setJSON('gcal_api_colors', apiColors);

    const usage = {};
    for (const ev of (eventsRes.result.items || [])) {
      if (ev.colorId) usage[ev.colorId] = (usage[ev.colorId] || 0) + 1;
    }

    renderColorConfig(apiColors, usage);
    $('config-loading').classList.add('hidden');
    $('config-form').classList.remove('hidden');

  } catch (err) {
    console.error(err);
    $('config-loading').innerHTML = `<p class="msg error">Erreur : ${esc(err.message || err)}</p>`;
  }
}

function renderColorConfig(apiColors, usage) {
  const currentMap  = getColorMap();
  const savedOrder  = getColorOrder();

  const sorted = Object.entries(apiColors).sort(([a], [b]) => {
    const ia = savedOrder.indexOf(a), ib = savedOrder.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    const diff = (usage[b] || 0) - (usage[a] || 0);
    return diff !== 0 ? diff : Number(a) - Number(b);
  });

  const rows = sorted.map(([cid, { background }]) => {
    const n       = usage[cid] || 0;
    const entry   = currentMap[cid] || { label: '', excluded: false };
    const checked = entry.excluded ? ' checked' : '';
    return `<div class="color-row" data-cid="${cid}" draggable="true">
      <span class="drag-handle" title="Réordonner">⠿</span>
      <span class="color-swatch" style="background:${background}"></span>
      <div class="color-meta">
        <span class="color-label">Couleur ${cid}</span>
        <span class="usage-badge${n === 0 ? ' zero' : ''}">${n > 0 ? n + ' évt' : 'non utilisé'}</span>
      </div>
      <input class="label-input" type="text"
             placeholder="Libellé (vide = ignorer)"
             value="${esc(entry.label || '')}">
      <label class="exclude-wrap">
        <input type="checkbox" class="exclude-check"${checked}> Exclure
      </label>
    </div>`;
  }).join('');

  const container = $('color-rows-container');
  container.innerHTML = rows;
  initDraggable(container);
}

function initDraggable(container) {
  let dragSrc = null;

  container.addEventListener('dragstart', e => {
    dragSrc = e.target.closest('.color-row');
    if (!dragSrc) return;
    e.dataTransfer.effectAllowed = 'move';
    requestAnimationFrame(() => dragSrc.classList.add('dragging'));
  });

  container.addEventListener('dragend', () => {
    dragSrc?.classList.remove('dragging');
    dragSrc = null;
    container.querySelectorAll('.color-row').forEach(r => r.classList.remove('drag-over'));
  });

  container.addEventListener('dragover', e => {
    e.preventDefault();
    const target = e.target.closest('.color-row');
    if (!target || target === dragSrc) return;
    container.querySelectorAll('.color-row').forEach(r => r.classList.remove('drag-over'));
    target.classList.add('drag-over');
    const rect  = target.getBoundingClientRect();
    const after = e.clientY > rect.top + rect.height / 2;
    container.insertBefore(dragSrc, after ? target.nextSibling : target);
  });

  container.addEventListener('drop', e => {
    e.preventDefault();
    container.querySelectorAll('.color-row').forEach(r => r.classList.remove('drag-over'));
  });
}

// ── Calcul de la plage "N semaines complètes" ─────────────────────────────────

function completeWeeksBounds(n) {
  const now     = new Date();
  const dow     = now.getDay() || 7;       // 1=lun … 7=dim
  const thisMon = new Date(now);
  thisMon.setDate(now.getDate() - (dow - 1));
  thisMon.setHours(0, 0, 0, 0);
  const from = new Date(thisMon);
  from.setDate(thisMon.getDate() - n * 7);
  const to = new Date(thisMon);
  to.setDate(thisMon.getDate() + 7);      // lundi suivant → couvre toute la semaine en cours
  return { from, to };
}

// ── Fetch événements ──────────────────────────────────────────────────────────

async function fetchAllEvents(calendarId, timeMin, timeMax) {
  const events = [];
  let pageToken;
  do {
    const res = await gapi.client.calendar.events.list({
      calendarId, singleEvents: true, orderBy: 'startTime', maxResults: 250,
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      eventTypes: ['default', 'outOfOffice'],
      pageToken,
    });
    events.push(...(res.result.items || []));
    pageToken = res.result.nextPageToken;
  } while (pageToken);
  return events;
}

// ── Traitement ────────────────────────────────────────────────────────────────

function isFullDay(ev) { return !!(ev.start?.date && !ev.start?.dateTime); }

function getDuration(ev) {
  const s = ev.start?.dateTime, e = ev.end?.dateTime;
  if (!s || !e) return 0;
  return Math.max(0, (new Date(e) - new Date(s)) / 3_600_000);
}

function* workingDays(sd, ed) {
  const d   = new Date(sd); d.setHours(0, 0, 0, 0);
  const end = new Date(ed); end.setHours(0, 0, 0, 0);
  while (d < end) {
    if (d.getDay() >= 1 && d.getDay() <= 5) yield new Date(d);
    d.setDate(d.getDate() + 1);
  }
}

function getWeekInfo(date) {
  const d   = new Date(date); d.setHours(0, 0, 0, 0);
  const dow = d.getDay() || 7;
  const mon = new Date(d); mon.setDate(d.getDate() - (dow - 1));
  const sun = new Date(mon); sun.setDate(mon.getDate() + 6);
  const tmp = new Date(Date.UTC(mon.getFullYear(), mon.getMonth(), mon.getDate()));
  tmp.setUTCDate(tmp.getUTCDate() + 4 - (tmp.getUTCDay() || 7));
  const ys  = new Date(Date.UTC(tmp.getUTCFullYear(), 0, 1));
  const wn  = Math.ceil(((tmp - ys) / 86_400_000 + 1) / 7);
  const p   = n  => String(n).padStart(2, '0');
  const fd  = dt => `${p(dt.getDate())}/${p(dt.getMonth() + 1)}`;
  return {
    sortKey: mon.getTime(),
    label: `S${p(wn)} · ${fd(mon)}–${fd(sun)}/${sun.getFullYear()}`,
  };
}

function buildReport(events, from, to) {
  const weeks = new Map();

  // weeks: Map< sortKey, { label, types: Map< typeName, { hours, events[] } > } >
  const add = (date, typeName, hours, info) => {
    const { sortKey, label } = getWeekInfo(date);
    if (!weeks.has(sortKey)) weeks.set(sortKey, { label, types: new Map() });
    const types = weeks.get(sortKey).types;
    if (!types.has(typeName)) types.set(typeName, { hours: 0, events: [] });
    const entry = types.get(typeName);
    entry.hours += hours;
    entry.events.push(info);
  };

  const colorMap = getColorMap();
  const oofLabel = getOofLabel();

  for (const ev of events) {

    // Absence outOfOffice → 7h par jour ouvré dans le libellé OOF configuré
    if (ev.eventType === 'outOfOffice') {
      if (!oofLabel) continue;
      const sd = ev.start?.dateTime ? new Date(ev.start.dateTime) : new Date(ev.start.date + 'T00:00:00');
      const ed = ev.end?.dateTime   ? new Date(ev.end.dateTime)   : new Date(ev.end.date   + 'T00:00:00');
      for (const d of workingDays(sd, ed)) {
        if (d >= from && d < to)
          add(d, oofLabel, WORKING_HOURS, {
            summary: ev.summary || 'Absence',
            date: new Date(d),
            hours: WORKING_HOURS,
            isOof: true,
          });
      }
      continue;
    }

    // Journée entière non-OOF → ignorée
    if (isFullDay(ev)) continue;

    // Événement chronométré
    const cid   = ev.colorId;
    if (!cid) continue;
    const entry = colorMap[cid];
    if (!entry || !entry.label || entry.excluded) continue;

    const hours = getDuration(ev);
    if (hours <= 0) continue;

    const start = ev.start?.dateTime ? new Date(ev.start.dateTime) : null;
    if (!start || start < from || start >= to) continue;

    add(start, entry.label, hours, {
      summary: ev.summary || '(sans titre)',
      date: start,
      hours,
      isOof: false,
    });
  }

  return new Map([...weeks.entries()].sort((a, b) => b[0] - a[0]));
}

// ── Rendu ─────────────────────────────────────────────────────────────────────

function typeOrder(typeName) {
  const order = getColorOrder();
  const map   = getColorMap();
  for (let i = 0; i < order.length; i++) {
    const entry = map[order[i]];
    if (entry && entry.label === typeName) return i;
  }
  return Infinity;
}

function colorForType(typeName) {
  const map  = getColorMap();
  const cols = getApiColors();
  for (const [cid, entry] of Object.entries(map)) {
    if (entry.label === typeName && cols[cid]) return cols[cid].background;
  }
  return '#aaa';
}

function formatHours(h) {
  const total = Math.round(h * 60);
  const hrs   = Math.floor(total / 60);
  const mins  = total % 60;
  if (hrs === 0) return `${mins}min`;
  if (mins === 0) return `${hrs}h`;
  return `${hrs}h ${mins}min`;
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/"/g,'&quot;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;');
}

function renderSummary(data) {
  const totals = new Map();
  for (const { types } of data.values()) {
    for (const [t, { hours }] of types) {
      totals.set(t, (totals.get(t) || 0) + hours);
    }
  }
  const grand = [...totals.values()].reduce((a, b) => a + b, 0);
  if (!grand) return '';

  const pills = [...totals.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([t, h]) => `<div class="pill">
      <span class="pill-dot" style="background:${colorForType(t)}"></span>
      <span>${esc(t)}</span>
      <span class="pill-pct">${(h / grand * 100).toFixed(1)}%</span>
      <span class="pill-hours">${h.toFixed(1)}h</span>
    </div>`).join('');

  return `<div class="card summary-card">
    <h3>Total sur la période · ${grand.toFixed(1)}h</h3>
    <div class="summary-pills">${pills}</div>
  </div>`;
}

function renderWeeks(data) {
  let html = '';
  for (const [sortKey, { label, types }] of data) {
    const total = [...types.values()].reduce((s, v) => s + v.hours, 0);
    if (!total) continue;

    const ordered = [...types.entries()].sort((a, b) => {
      const oa = typeOrder(a[0]), ob = typeOrder(b[0]);
      if (oa !== ob) return oa - ob;
      return b[1].hours - a[1].hours; // à ordre égal, par heures décroissantes
    });

    const bars = ordered.map(([typeName, { hours, events }]) => {
      const pct = (hours / total * 100).toFixed(1);
      const col = colorForType(typeName);
      const key = `${sortKey}_${typeName.replace(/\W+/g,'_')}`;

      // Regroupe les événements identiques (même titre)
      const grouped = new Map();
      for (const e of events.slice().sort((a, b) => new Date(a.date) - new Date(b.date))) {
        if (!grouped.has(e.summary)) {
          grouped.set(e.summary, { ...e, count: 1 });
        } else {
          const g = grouped.get(e.summary);
          g.hours += e.hours;
          g.count++;
        }
      }

      const evRows = [...grouped.values()].map(e => {
        const d   = new Date(e.date);
        const fmt = `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}`;
        const dateCell = e.count > 1 ? `<span class="ev-count">×${e.count}</span>` : fmt;
        const title    = e.isOof ? `<em>${esc(e.summary)}</em>` : esc(e.summary);
        return `<div class="detail-row">
          <span class="detail-date">${dateCell}</span>
          <span class="detail-title">${title}</span>
          <span class="detail-dur">${formatHours(e.hours)}</span>
        </div>`;
      }).join('');

      return `<div class="bar-group">
        <div class="bar-row">
          <div class="type-name">
            <span class="dot" style="background:${col}"></span>
            <span>${esc(typeName)}</span>
          </div>
          <div class="bar-track">
            <div class="bar-fill" style="background:${col}" data-pct="${pct}"></div>
          </div>
          <span class="bar-pct">${pct}%</span>
          <span class="bar-hours">${hours.toFixed(1)}h</span>
          <button class="detail-btn" data-key="${key}" title="Voir le détail">▶</button>
        </div>
        <div class="detail-panel hidden" id="dp_${key}">
          <div class="detail-header">
            <span>Date</span><span>Événement</span><span style="text-align:right">Durée</span>
          </div>
          ${evRows || '<div class="detail-row"><span></span><span style="color:var(--muted)">Aucun événement</span><span></span></div>'}
        </div>
      </div>`;
    }).join('');

    html += `<div class="card week-card">
      <div class="week-header">
        <span class="week-label">${label}</span>
        <span class="week-total">${total.toFixed(1)}h</span>
      </div>
      <div class="week-bars">${bars}</div>
    </div>`;
  }
  return html || '<p class="msg">Aucun événement comptabilisé sur la période.</p>';
}

// Délégation unique pour les boutons "▶" (évite les onclick inline)
document.addEventListener('click', e => {
  const btn = e.target.closest('.detail-btn');
  if (!btn) return;
  const key   = btn.dataset.key;
  const panel = document.getElementById('dp_' + key);
  if (!panel) return;
  const isOpen = !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', isOpen);
  btn.classList.toggle('open', !isOpen);
  btn.textContent = isOpen ? '▶' : '▼';
});

function animateBars() {
  requestAnimationFrame(() => {
    document.querySelectorAll('.bar-fill[data-pct]').forEach(el => {
      el.style.width = el.dataset.pct + '%';
      requestAnimationFrame(() => { el.style.transform = 'scaleX(1)'; });
    });
  });
}

// ── Export CSV ────────────────────────────────────────────────────────────────

function exportCSV(data) {
  const rows = [['Semaine','Type','Heures','Pourcentage']];
  for (const [, { label, types }] of data) {
    const total = [...types.values()].reduce((s, v) => s + v.hours, 0);
    if (!total) continue;
    for (const [t, { hours }] of [...types.entries()].sort((a,b) => b[1].hours - a[1].hours)) {
      rows.push([label, t, hours.toFixed(2), (hours / total * 100).toFixed(2)]);
    }
  }
  const csv  = rows.map(r => r.map(c => `"${c}"`).join(',')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' });
  const a    = Object.assign(document.createElement('a'), {
    href: URL.createObjectURL(blob),
    download: `rapport-${new Date().toISOString().slice(0,10)}.csv`,
  });
  a.click();
}

// ── Chargement du rapport ─────────────────────────────────────────────────────

async function loadReport() {
  const loading   = $('loading');
  const container = $('report-container');
  loading.classList.remove('hidden');
  container.innerHTML = '';

  try {
    const { from, to } = completeWeeksBounds(getWeeksCount());

    const events = await fetchAllEvents(getCalendarId(), from, to);
    const data   = buildReport(events, from, to);
    lastReport   = data;

    const fmt = d => d.toLocaleDateString('fr-FR', { day:'2-digit', month:'2-digit', year:'numeric' });
    container.innerHTML =
      `<p class="period-info"><strong>${fmt(from)}</strong> → <strong>${fmt(to)}</strong> · ${events.length} événements récupérés</p>` +
      renderSummary(data) +
      renderWeeks(data);

    animateBars();
  } catch (err) {
    console.error(err);
    container.innerHTML = `<p class="msg error">Erreur : ${esc(err.message || err)}</p>`;
  } finally {
    loading.classList.add('hidden');
  }
}

// ── Démarrage ─────────────────────────────────────────────────────────────────

(function boot() {
  if (!getClientId()) showScreen('setup');
})();

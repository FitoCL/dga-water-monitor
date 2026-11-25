'use strict';

/* ==========================================================================
   DGA Water Monitor - cliente
   Seguridad: todo dato externo se inserta con textContent / nodos DOM (nunca
   innerHTML con datos), sin handlers inline (compatible con CSP estricta).
   ========================================================================== */

const CSRF_TOKEN = document.querySelector('meta[name="csrf-token"]').content;
const ADMIN_REQUIRED = document.querySelector('meta[name="admin-required"]').content === 'true';
const POLL_MS = 15000;
const POLL_LOADING_MS = 5000;

const State = {
  map: null,
  layer: null,
  baseLayers: {},
  activeBaseLayer: null,
  markers: new Map(),          // "estacion:05710001" -> marker
  estaciones: [],
  embalses: [],
  alertas: [],
  umbrales: { embalses: {}, estaciones: {} },
  lastSummary: null,
  filter: 'rios',
  search: '',
  region: 'all',
  soundEnabled: true,
  browserNotifyEnabled: false,
  audioCtx: null,
  knownAlertIds: null,
  pollTimer: null,
  loadingRegion: false,
  requestSeq: 0,
  currentModalItem: null,
  pinnedItem: null,
  historyPeriod: '24h',
  historyLevel: 'ALL',
  historyStation: '__ALL__',
  historyData: null,
  riverLayer: null,
  criticalRivers: [],
};

const REGION_VIEW = {
  '1': [-20.2, -69.5, 7], '2': [-23.65, -69.0, 6], '3': [-27.4, -70.0, 7], '4': [-30.3, -71.1, 8],
  '5': [-32.8, -71.2, 8], '6': [-34.4, -71.1, 8], '7': [-35.43, -71.65, 8], '8': [-37.1, -72.6, 8],
  '9': [-38.7, -72.2, 8], '10': [-41.5, -72.8, 7], '11': [-46.0, -73.0, 6], '12': [-52.0, -72.0, 6],
  '13': [-33.45, -70.66, 9], '14': [-39.85, -72.6, 8], '15': [-18.5, -69.8, 7], '16': [-36.7, -72.0, 8],
  'all': [-35.5, -71.0, 5],
};

const LEVEL_LABEL = {
  CRITICO: 'CRÍTICO', ADVERTENCIA: 'ADVERTENCIA', PREVENTIVA: 'PREVENTIVA',
  NORMAL: 'NORMAL', SIN_DATOS: 'SIN REGISTRO', INACTIVA: 'INACTIVA',
};

/* ----------------------------------------------------------------- utilidades */
const $ = (id) => document.getElementById(id);

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('data-')) node.setAttribute(k, v);
    else node.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function icon(cls) { return el('i', { class: cls, 'aria-hidden': 'true' }); }

function fmt(n, dec = 2) {
  if (n === null || n === undefined || n === '' || isNaN(Number(n))) return '--';
  return Number(n).toLocaleString('es-CL', { maximumFractionDigits: dec, minimumFractionDigits: 0 });
}

function levelClass(estado) { return String(estado || 'NORMAL').toLowerCase(); }

function badge(estado) {
  return el('span', { class: `badge badge-${levelClass(estado)}`, text: LEVEL_LABEL[estado] || estado });
}

function toast(msg, type = 'info') {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast toast-${type}`;
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => t.classList.add('hidden'), 4500);
}

function validCoords(lat, lng) {
  return Number.isFinite(lat) && Number.isFinite(lng) && lat < -15 && lat > -57 && lng < -65 && lng > -77;
}

function formatSensorTime(fechaStr, refNow = null) {
  if (!fechaStr) return { shortText: '--', relText: 'sin fecha', fullText: '--' };
  const s = String(fechaStr).trim();
  const hasTime = s.includes(' ');
  const dt = new Date(hasTime ? s.replace(' ', 'T') : `${s}T00:00:00`);
  if (Number.isNaN(dt.getTime())) return { shortText: s, relText: '', fullText: s };

  const pad = (n) => String(n).padStart(2, '0');
  const nowDate = refNow || new Date();
  const sameDay = dt.getFullYear() === nowDate.getFullYear()
    && dt.getMonth() === nowDate.getMonth()
    && dt.getDate() === nowDate.getDate();

  let shortText;
  if (!hasTime) {
    shortText = `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)}/${dt.getFullYear()}`;
  } else if (sameDay) {
    shortText = `Hoy ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  } else {
    shortText = `${pad(dt.getDate())}/${pad(dt.getMonth() + 1)} ${pad(dt.getHours())}:${pad(dt.getMinutes())}`;
  }

  const diffMin = Math.max(0, Math.round((nowDate.getTime() - dt.getTime()) / 60000));
  let relText;
  if (diffMin <= 1) relText = 'ahora';
  else if (diffMin < 120) relText = `hace ${diffMin} min`;
  else if (diffMin < 2880) relText = `hace ${Math.round(diffMin / 60)} h`;
  else relText = `hace ${Math.round(diffMin / 1440)} días`;

  return { shortText, relText, fullText: s };
}

/* ----------------------------------------------------------------- API */
async function api(path, options = {}) {
  const opts = { credentials: 'same-origin', headers: { Accept: 'application/json' }, ...options };
  if (opts.method && opts.method !== 'GET') {
    opts.headers['X-CSRF-Token'] = CSRF_TOKEN;
    if (ADMIN_REQUIRED) {
      let token = sessionStorage.getItem('dgaAdminToken');
      if (!token) {
        token = window.prompt('Esta acción requiere el token de administrador:') || '';
        if (token) sessionStorage.setItem('dgaAdminToken', token);
      }
      opts.headers['X-Admin-Token'] = token;
    }
    if (opts.body && typeof opts.body !== 'string') {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(opts.body);
    }
  }
  const res = await fetch(path, opts);
  let data = null;
  try { data = await res.json(); } catch (_) { /* respuesta vacía */ }
  if (res.status === 401) sessionStorage.removeItem('dgaAdminToken');
  if (!res.ok) {
    const err = new Error((data && data.mensaje) || `Error HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

/* ----------------------------------------------------------------- reloj chile */
function startChileClock() {
  const timeEl = $('chile-clock-time');
  const dateEl = $('chile-clock-date');
  if (!timeEl || !dateEl) return;
  const timeFmt = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const dateFmt = new Intl.DateTimeFormat('es-CL', {
    timeZone: 'America/Santiago',
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
  const formatChileDate = (dt) => {
    const parts = {};
    dateFmt.formatToParts(dt).forEach((p) => { parts[p.type] = p.value.replace(/\./g, '').trim(); });
    return `${parts.weekday || ''}, ${parts.day || ''} de ${parts.month || ''} ${parts.year || ''}`.toLowerCase();
  };
  const tick = () => {
    const nowDt = new Date();
    timeEl.textContent = timeFmt.format(nowDt);
    dateEl.textContent = formatChileDate(nowDt);
  };
  tick();
  setInterval(tick, 1000);
}

/* ----------------------------------------------------------------- init */
document.addEventListener('DOMContentLoaded', () => {
  startChileClock();
  initBrowserNotifications();
  initMap();
  bindEvents();
  refresh(true);
  schedulePoll();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refresh(false);
    schedulePoll();
  });
  const unlockAudio = () => {
    if (!State.soundEnabled) return;
    try {
      State.audioCtx = State.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      if (State.audioCtx.state === 'suspended') State.audioCtx.resume();
    } catch (_) { /* ignorar */ }
  };
  document.addEventListener('click', unlockAudio, { once: true });
  document.addEventListener('keydown', unlockAudio, { once: true });
});

function initMap() {
  State.map = L.map('map', { zoomControl: false }).setView([-35.5, -71.0], 5);
  L.control.zoom({ position: 'bottomleft' }).addTo(State.map);

  const dark = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap | Datos: DGA - MOP Chile',
    maxZoom: 19,
    className: 'map-tiles-dark',
  }).addTo(State.map);

  const topo_dark = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri | Datos: DGA - MOP Chile',
    maxNativeZoom: 18,
    maxZoom: 19,
    className: 'map-tiles-dark',
  });

  const esri_dark = L.layerGroup([
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}', {
      attribution: 'Tiles &copy; Esri | Datos: DGA - MOP Chile',
      maxNativeZoom: 16,
      maxZoom: 19,
    }),
    L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}', {
      maxNativeZoom: 16,
      maxZoom: 19,
    }),
  ]);

  const light = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    attribution: '&copy; OpenStreetMap | Datos: DGA - MOP Chile',
    maxZoom: 19,
  });

  const topo = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Topo_Map/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri | Datos: DGA - MOP Chile',
    maxNativeZoom: 18,
    maxZoom: 19,
  });

  const sat = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', {
    attribution: 'Tiles &copy; Esri | Datos: DGA - MOP Chile',
    maxNativeZoom: 18,
    maxZoom: 19,
  });

  State.baseLayers = { dark, topo_dark, esri_dark, light, topo, sat };
  State.activeBaseLayer = dark;

  L.control.layers(
    {
      'Oscuro (Dark)': dark,
      'Topográfico Oscuro (Ríos)': topo_dark,
      'Gris Oscuro (Esri)': esri_dark,
      'Claro (OSM)': light,
      'Topográfico Claro (Esri)': topo,
      'Satelital (Esri)': sat,
    },
    null,
    { position: 'bottomleft' },
  ).addTo(State.map);

  State.map.on('baselayerchange', (e) => {
    State.activeBaseLayer = e.layer;
    const entry = Object.entries(State.baseLayers).find(([, layer]) => layer === e.layer);
    const select = $('select-basemap');
    if (entry && select) select.value = entry[0];
  });

  State.riverLayer = L.layerGroup().addTo(State.map);
  State.layer = L.layerGroup().addTo(State.map);
  setTimeout(() => State.map && State.map.invalidateSize(), 150);
  window.addEventListener('resize', () => State.map && State.map.invalidateSize());
}

function switchBaseLayer(key) {
  const next = State.baseLayers[key];
  if (!next || !State.map) return;
  Object.values(State.baseLayers).forEach((layer) => {
    if (State.map.hasLayer(layer) && layer !== next) {
      State.map.removeLayer(layer);
    }
  });
  if (!State.map.hasLayer(next)) {
    next.addTo(State.map);
  }
  State.activeBaseLayer = next;
  const select = $('select-basemap');
  if (select && select.value !== key) select.value = key;
}

function bindEvents() {
  $('select-basemap').addEventListener('change', (e) => {
    switchBaseLayer(e.target.value);
  });

  $('select-region').addEventListener('change', (e) => {
    State.region = e.target.value;
    State.pinnedItem = null;
    const v = REGION_VIEW[State.region] || REGION_VIEW['13'];
    State.map.setView([v[0], v[1]], v[2]);
    State.estaciones = [];
    setFilter('all', false, false);
    refresh(true);
  });

  document.querySelectorAll('.pill').forEach((btn) => btn.addEventListener('click', () => {
    setFilter(btn.dataset.filter, false, false);
  }));

  document.querySelectorAll('.kpi-card[data-kpi-filter]').forEach((card) => {
    const activate = () => {
      const target = card.dataset.kpiFilter;
      const next = (State.filter === target && target !== 'all') ? 'all' : target;
      setFilter(next, true, true);
    };
    card.addEventListener('click', activate);
    card.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        activate();
      }
    });
  });

  let searchTimer;
  $('search-input').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      State.search = e.target.value.toLowerCase().trim().slice(0, 60);
      updateDynamicKPIs(State.lastSummary);
      renderAlerts();
      const items = render();
      renderSearchSuggestions(items);
    }, 150);
  });

  $('search-input').addEventListener('focus', () => {
    if (State.search) renderSearchSuggestions(visibleItems());
  });

  $('search-input').addEventListener('keydown', (e) => {
    const box = $('search-suggestions');
    const items = box ? Array.from(box.querySelectorAll('.search-sugg-item')) : [];
    if (e.key === 'Escape') {
      hideSearchSuggestions();
    } else if (e.key === 'ArrowDown' && items.length > 0) {
      e.preventDefault();
      if (box.classList.contains('hidden')) box.classList.remove('hidden');
      const cur = items.findIndex((elItem) => elItem.classList.contains('is-selected'));
      const next = cur < items.length - 1 ? cur + 1 : 0;
      items.forEach((elItem, idx) => elItem.classList.toggle('is-selected', idx === next));
      items[next].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp' && items.length > 0) {
      e.preventDefault();
      if (box.classList.contains('hidden')) box.classList.remove('hidden');
      const cur = items.findIndex((elItem) => elItem.classList.contains('is-selected'));
      const prev = cur > 0 ? cur - 1 : items.length - 1;
      items.forEach((elItem, idx) => elItem.classList.toggle('is-selected', idx === prev));
      items[prev].scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' && items.length > 0) {
      e.preventDefault();
      const target = items.find((elItem) => elItem.classList.contains('is-selected')) || items[0];
      target.click();
    }
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('.search-group')) hideSearchSuggestions();
  });

  const suggBox = $('search-suggestions');
  if (suggBox && window.L && L.DomEvent) {
    L.DomEvent.disableScrollPropagation(suggBox);
    L.DomEvent.disableClickPropagation(suggBox);
  }
  if (suggBox) {
    suggBox.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
  }

  document.querySelectorAll('.tab-btn').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    $(btn.dataset.tab).classList.add('active');
  }));

  $('btn-sync').addEventListener('click', forceSync);
  $('btn-sound').addEventListener('click', toggleSound);
  initSoundGallery();
  $('btn-notify').addEventListener('click', toggleBrowserNotifications);
  $('btn-history').addEventListener('click', () => openHistoryModal());
  $('modal-close').addEventListener('click', closeModal);
  $('modal-station').addEventListener('click', (e) => { if (e.target.id === 'modal-station') closeModal(); });
  $('history-close').addEventListener('click', closeHistoryModal);
  $('modal-history').addEventListener('click', (e) => { if (e.target.id === 'modal-history') closeHistoryModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      closeHistoryModal();
      closeSoundGallery();
    }
  });
  $('form-threshold').addEventListener('submit', saveThreshold);

  $('modal-btn-fly').addEventListener('click', () => {
    flyToItem(State.currentModalItem);
  });

  $('modal-btn-sat').addEventListener('click', () => {
    openGoogleMapsSatellite(State.currentModalItem);
  });

  $('modal-btn-thresh').addEventListener('click', () => {
    const wrap = $('modal-thresh-wrap');
    const opening = wrap.classList.contains('hidden');
    wrap.classList.toggle('hidden', !opening);
    $('modal-btn-thresh').setAttribute('aria-expanded', String(opening));
    if (opening) $('input-thresh-min').focus();
  });

  $('modal-btn-history').addEventListener('click', () => {
    const item = State.currentModalItem;
    closeModal();
    openHistoryModal(item ? item.codigo : null);
  });

  document.querySelectorAll('#history-periods [data-period]').forEach((btn) => {
    btn.addEventListener('click', () => {
      State.historyPeriod = btn.dataset.period;
      document.querySelectorAll('#history-periods [data-period]').forEach((b) => b.classList.toggle('active', b === btn));
      loadAndRenderHistory();
    });
  });

  document.querySelectorAll('#history-level-filter [data-level]').forEach((btn) => {
    btn.addEventListener('click', () => {
      State.historyLevel = btn.dataset.level;
      document.querySelectorAll('#history-level-filter [data-level]').forEach((b) => b.classList.toggle('active', b === btn));
      loadAndRenderHistory();
    });
  });

  $('history-station-select').addEventListener('change', (e) => {
    State.historyStation = e.target.value;
    renderHistoryView();
  });

  // Delegación para listas (sin onclick inline)
  $('alertas-list').addEventListener('click', (e) => {
    const card = e.target.closest('[data-codigo]');
    if (card) focusItem(card.dataset.categoria, card.dataset.codigo, Number(card.dataset.lat), Number(card.dataset.lng));
  });
  $('station-list').addEventListener('click', (e) => {
    const item = e.target.closest('[data-codigo]');
    if (item) focusItem(item.dataset.categoria, item.dataset.codigo);
  });
}

/* ----------------------------------------------------------------- datos */
function schedulePoll() {
  clearTimeout(State.pollTimer);
  if (document.hidden) return;
  State.pollTimer = setTimeout(async () => {
    await refresh(false);
    schedulePoll();
  }, State.loadingRegion ? POLL_LOADING_MS : POLL_MS);
}

async function refresh(showSpinner) {
  const seq = ++State.requestSeq;
  if (showSpinner) $('sync-spinner').classList.add('fa-spin');
  try {
    const [summary, embalses, estaciones, alertas, umbrales, cauces] = await Promise.all([
      api('/api/summary'),
      api('/api/embalses'),
      api(`/api/estaciones?region=${encodeURIComponent(State.region)}`),
      api('/api/alertas'),
      api('/api/umbrales').catch(() => null),
      api('/api/alertas/cauces').catch(() => []),
    ]);
    if (seq !== State.requestSeq) return;      // respuesta obsoleta (cambió la región)

    const estList = Array.isArray(estaciones) ? estaciones : (Array.isArray(estaciones && estaciones.items) ? estaciones.items : []);
    State.embalses = Array.isArray(embalses) ? embalses : [];
    State.estaciones = estList;
    State.alertas = Array.isArray(alertas) ? alertas : [];
    State.criticalRivers = Array.isArray(cauces) ? cauces : [];
    if (umbrales && typeof umbrales === 'object') State.umbrales = umbrales;
    State.lastSummary = summary;
    State.loadingRegion = Boolean(estaciones && estaciones.cargando) || Boolean(summary.cargando);

    $('map-loading').classList.toggle('hidden', !(State.loadingRegion && State.estaciones.length === 0));
    updateDynamicKPIs(summary);
    renderAlerts();
    render();
    checkNewAlerts();
    setLive(true, summary);
  } catch (err) {
    console.error(err);
    setLive(false);
  } finally {
    if (seq === State.requestSeq) $('sync-spinner').classList.remove('fa-spin');
  }
}

function setLive(ok, summary) {
  const pill = $('live-pill');
  pill.classList.toggle('offline', !ok);
  if (!ok) { $('sync-status').textContent = 'Sin conexión'; return; }
  if (summary && summary.cargando) $('sync-status').textContent = 'Sincronizando...';
  else if (summary && summary.last_error) $('sync-status').textContent = 'En línea (fuente parcial)';
  else $('sync-status').textContent = 'En línea';
  pill.title = summary && summary.last_error ? `Errores en la última sincronización: ${summary.last_error}` : '';
}

function matchesSearch(item) {
  if (!State.search) return true;
  const q = State.search;
  return [item.nombre, item.codigo, item.comuna, item.region_nombre]
    .some((v) => v && String(v).toLowerCase().includes(q));
}

function embalseMatchesRegion(emb) {
  if (State.region === 'all') return true;
  const reg = String(parseInt(String((emb && emb.codigo) || '').slice(0, 2), 10));
  return reg === State.region;
}

function alertsInCurrentRegion(stationSet = null, embSet = null) {
  if (State.region === 'all') return State.alertas;
  const stCodes = stationSet || new Set(State.estaciones.map((e) => e.codigo));
  const emCodes = embSet || new Set(State.embalses.filter(embalseMatchesRegion).map((e) => e.codigo));
  return State.alertas.filter((a) => (a.tipo_elemento === 'embalse' ? emCodes.has(a.codigo) : stCodes.has(a.codigo)));
}

function updateDynamicKPIs(s) {
  const ests = State.estaciones.filter(matchesSearch);
  const regionEmbs = State.embalses.filter(embalseMatchesRegion);
  const embs = regionEmbs.filter(matchesSearch);
  const regionAlts = alertsInCurrentRegion(
    new Set(State.estaciones.map((e) => e.codigo)),
    new Set(regionEmbs.map((e) => e.codigo))
  );
  const alts = regionAlts.filter(matchesSearch);

  const activasConDato = ests.filter((e) => e.activa !== false && !e.sin_registro).length;
  const inactivasCount = ests.filter((e) => e.activa === false).length;
  const sinRegCount = ests.filter((e) => e.activa !== false && e.sin_registro).length;
  const inactivasOSinReg = inactivasCount + sinRegCount;

  const criticas = regionAlts.filter((a) => a.nivel_alerta === 'CRITICO').length;
  const advertencias = regionAlts.filter((a) => a.nivel_alerta === 'ADVERTENCIA').length;
  const preventivas = regionAlts.filter((a) => a.nivel_alerta === 'PREVENTIVA').length;

  $('kpi-estaciones').textContent = activasConDato;
  $('kpi-estaciones-sub').textContent = `${ests.length} totales en vista`;
  $('kpi-inactivas').textContent = inactivasOSinReg;
  $('kpi-inactivas-sub').textContent = `${inactivasCount} inactivas · ${sinRegCount} sin caudal`;
  $('kpi-embalses').textContent = embs.length;
  $('kpi-criticas').textContent = criticas;
  $('kpi-advertencias').textContent = advertencias;
  $('kpi-preventivas').textContent = preventivas;
  $('alert-counter').textContent = State.alertas.length;
  $('kpi-card-critico').classList.toggle('has-alerts', criticas > 0);

  if (s) {
    $('kpi-time').textContent = s.last_sync ? s.last_sync.split(' ')[1] : 'Pendiente';
    $('kpi-time').title = s.last_sync || '';
    const histBadge = $('history-badge');
    if (histBadge) {
      const cnt = typeof s.total_historial_estaciones === 'number' ? s.total_historial_estaciones : alts.length;
      histBadge.textContent = cnt;
    }
    const subEl = $('kpi-time-sub');
    if (subEl) {
      subEl.textContent = s.last_sync
        ? `Sinc. ${formatSensorTime(s.last_sync).relText} · auto 60s`
        : 'Sincronizando...';
    }
  }
}

function activateSidebarTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-content').forEach((c) => c.classList.toggle('active', c.id === tabId));
}

function setFilter(filter, fitMap = false, switchTab = false) {
  State.filter = filter || 'all';
  State.pinnedItem = null;
  document.querySelectorAll('.kpi-card[data-kpi-filter]').forEach((c) => {
    c.classList.toggle('active-kpi', State.filter !== 'all' && c.dataset.kpiFilter === State.filter);
  });
  const pillMatch = ['criticas', 'advertencias', 'preventivas'].includes(State.filter) ? 'alertas' : State.filter;
  document.querySelectorAll('.pill').forEach((p) => {
    p.classList.toggle('active', p.dataset.filter === pillMatch);
  });
  if (switchTab) {
    if (['criticas', 'advertencias', 'preventivas', 'alertas', 'rios', 'inactivas', 'embalses'].includes(State.filter)) {
      activateSidebarTab('tab-alertas');
    }
  }
  renderAlerts();
  const items = render();
  if (fitMap && items.length > 0 && State.map) {
    const bounds = L.latLngBounds(items.map((i) => [i.lat, i.lng]));
    State.map.fitBounds(bounds, { padding: [45, 45], maxZoom: 12, animate: true });
  }
}

/* ----------------------------------------------------------------- render */
const ALERT_FILTER_LEVELS = {
  alertas: ['CRITICO', 'ADVERTENCIA', 'PREVENTIVA'],
  criticas: ['CRITICO'],
  advertencias: ['ADVERTENCIA'],
  preventivas: ['PREVENTIVA'],
};

function alertAsMapItem(a) {
  const isEmb = a.tipo_elemento === 'embalse';
  const stMatch = !isEmb ? State.estaciones.find((s) => s.codigo === a.codigo) : null;
  return {
    codigo: a.codigo,
    nombre: a.nombre,
    tipo: isEmb ? 'Embalse / Lago' : 'Fluviométrica (Río)',
    categoria: isEmb ? 'embalse' : 'estacion',
    region: stMatch ? stMatch.region : String(parseInt(String(a.codigo || '').slice(0, 2), 10) || '0'),
    altitud: stMatch ? stMatch.altitud : null,
    lat: Number(a.lat),
    lng: Number(a.lng),
    estado: a.nivel_alerta,
    alerta: a,
    activa: true,
    estado_estacion: 'Activa',
    ultimo_caudal: a.unidad === 'm³/s' ? { valor: a.valor_actual, fecha: a.fecha } : null,
  };
}

function visibleItems() {
  const f = State.filter;
  const searching = Boolean(State.search);
  const items = [];
  const seen = new Set();
  const push = (item) => {
    const key = `${item.categoria}:${item.codigo}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  if (searching || f === 'all' || f === 'embalses') {
    State.embalses.forEach((e) => {
      if (!searching && !embalseMatchesRegion(e)) return;
      const lat = Number(e.lat), lng = Number(e.lng);
      if (validCoords(lat, lng)) push({ ...e, lat, lng, categoria: 'embalse' });
    });
  }

  if (searching || f === 'all' || f === 'rios' || f === 'inactivas') {
    State.estaciones.forEach((e) => {
      const lat = Number(e.lat), lng = Number(e.lng);
      if (!validCoords(lat, lng)) return;
      if (!searching) {
        const inactOrNoReg = e.activa === false || Boolean(e.sin_registro);
        if (f === 'rios' && inactOrNoReg) return;
        if (f === 'inactivas' && !inactOrNoReg) return;
      }
      push({ ...e, lat, lng, categoria: 'estacion' });
    });
  }

  if (searching || ALERT_FILTER_LEVELS[f]) {
    const targetLevels = searching ? null : ALERT_FILTER_LEVELS[f];
    State.embalses.forEach((e) => {
      if (!searching && !embalseMatchesRegion(e)) return;
      const lat = Number(e.lat), lng = Number(e.lng);
      if (validCoords(lat, lng) && (!targetLevels || targetLevels.includes(e.estado))) push({ ...e, lat, lng, categoria: 'embalse' });
    });
    State.estaciones.forEach((e) => {
      const lat = Number(e.lat), lng = Number(e.lng);
      if (validCoords(lat, lng) && (!targetLevels || targetLevels.includes(e.estado))) push({ ...e, lat, lng, categoria: 'estacion' });
    });
    const alertSource = searching ? State.alertas : alertsInCurrentRegion();
    alertSource.forEach((a) => {
      const lat = Number(a.lat), lng = Number(a.lng);
      if (validCoords(lat, lng) && (!targetLevels || targetLevels.includes(a.nivel_alerta))) push(alertAsMapItem(a));
    });
  }

  const filtered = items.filter(matchesSearch);
  if (State.pinnedItem) {
    const pKey = `${State.pinnedItem.categoria}:${State.pinnedItem.codigo}`;
    const alreadyIn = filtered.some((x) => `${x.categoria}:${x.codigo}` === pKey);
    if (!alreadyIn) {
      const pool = State.pinnedItem.categoria === 'embalse' ? State.embalses : State.estaciones;
      const fresh = pool.find((x) => x.codigo === State.pinnedItem.codigo);
      const src = fresh
        ? { ...fresh, lat: Number(fresh.lat), lng: Number(fresh.lng), categoria: State.pinnedItem.categoria }
        : { ...State.pinnedItem, lat: Number(State.pinnedItem.lat), lng: Number(State.pinnedItem.lng) };
      if (validCoords(src.lat, src.lng)) filtered.push(src);
    }
  }
  return filtered;
}

function allMonitorItems() {
  const onlyActiveRivers = !State.search && State.filter === 'rios';
  const items = [];
  const seen = new Set();
  const push = (item) => {
    const key = `${item.categoria}:${item.codigo}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };
  if (!onlyActiveRivers) {
    State.embalses.forEach((e) => {
      if (!embalseMatchesRegion(e)) return;
      const lat = Number(e.lat), lng = Number(e.lng);
      if (validCoords(lat, lng)) push({ ...e, lat, lng, categoria: 'embalse' });
    });
  }
  State.estaciones.forEach((e) => {
    const lat = Number(e.lat), lng = Number(e.lng);
    if (!validCoords(lat, lng)) return;
    if (onlyActiveRivers && (e.activa === false || Boolean(e.sin_registro))) return;
    push({ ...e, lat, lng, categoria: 'estacion' });
  });
  return items.filter(matchesSearch);
}

function render() {
  if (State.map) State.map.invalidateSize();
  State.layer.clearLayers();
  State.markers.clear();
  const items = visibleItems();
  items.forEach((item) => {
    const m = createMarker(item);
    m.addTo(State.layer);
    State.markers.set(`${item.categoria}:${item.codigo}`, m);
  });
  renderCriticalRiverReaches(items);
  renderList(allMonitorItems());
  return items;
}

function createMarker(item) {
  const isEmb = item.categoria === 'embalse';
  const estado = item.estado || 'NORMAL';
  const pinClass = estado === 'NORMAL' ? (isEmb ? 'pin-normal-dam' : 'pin-normal') : `pin-${levelClass(estado)}`;
  const iconHtml = `<div class="custom-map-pin ${pinClass}"><i class="fa-solid ${isEmb ? 'fa-mountain' : 'fa-droplet'}"></i></div>`;
  const marker = L.marker([item.lat, item.lng], {
    icon: L.divIcon({ html: iconHtml, className: 'custom-leaflet-pin', iconSize: [30, 30], iconAnchor: [15, 30], popupAnchor: [0, -30] }),
    title: item.nombre,
    riseOnHover: true,
    zIndexOffset: (SEVERITY_Z[estado] || 0),
  });
  marker.bindPopup(() => buildPopup(item), {
    maxWidth: 330,
    autoPanPaddingTopLeft: [16, 120],
    autoPanPaddingBottomRight: [16, 28],
  });
  return marker;
}
const SEVERITY_Z = { CRITICO: 3000, ADVERTENCIA: 2000, PREVENTIVA: 1000 };

/* ----------------------------------------------------------------- destacado de ríos en alerta crítica */
function normRiverText(str) {
  return String(str || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function extractRiverName(fullName) {
  if (!fullName) return '';
  const clean = String(fullName).trim();
  const parts = clean.split(/\s+(?:en|antes|despues|después|bajo|aguas|junta|desague|desagüe|sobre)\s+/i);
  return (parts[0] || clean).trim();
}

function orderStationsAlongRiver(points) {
  if (points.length <= 2) return points;
  const remaining = points.slice();
  // Empezar desde la estación más alta válida (altitud > 0) o la más oriental (cordillera)
  let startIdx = 0;
  let bestScore = -Infinity;
  remaining.forEach((p, idx) => {
    const score = p.altitud > 0 ? p.altitud : (-10000 + p.lng * 100);
    if (score > bestScore) {
      bestScore = score;
      startIdx = idx;
    }
  });
  const ordered = [remaining.splice(startIdx, 1)[0]];
  while (remaining.length > 0) {
    const last = ordered[ordered.length - 1];
    let bestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = haversineKm(last.lat, last.lng, remaining[i].lat, remaining[i].lng);
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }
    ordered.push(remaining.splice(bestIdx, 1)[0]);
  }
  return ordered;
}

const RIVER_ALERT_STYLE = {
  CRITICO: {
    label: 'Cauce en Alerta Roja',
    icon: 'fa-triangle-exclamation',
    glowColor: '#ff1a40',
    glowWeight: 6,
    glowOpacity: 0.42,
    glowClass: 'river-critical-glow',
    coreColor: '#ff3358',
    coreWeight: 2.5,
    coreClass: 'river-critical-core',
    waveClass: 'critical-station-wave',
    tooltipClass: '',
    zOffset: 2500,
  },
  ADVERTENCIA: {
    label: 'Cauce en Advertencia',
    icon: 'fa-circle-exclamation',
    glowColor: '#f59e0b',
    glowWeight: 5.5,
    glowOpacity: 0.36,
    glowClass: 'river-advertencia-glow',
    coreColor: '#fbbf24',
    coreWeight: 2.3,
    coreClass: 'river-advertencia-core',
    waveClass: 'alert-station-wave alert-wave-advertencia',
    tooltipClass: 'river-advertencia-tooltip',
    zOffset: 2200,
  },
  PREVENTIVA: {
    label: 'Cauce en Alerta Preventiva',
    icon: 'fa-circle-info',
    glowColor: '#0ea5e9',
    glowWeight: 5,
    glowOpacity: 0.34,
    glowClass: 'river-preventiva-glow',
    coreColor: '#38bdf8',
    coreWeight: 2.2,
    coreClass: 'river-preventiva-core',
    waveClass: 'alert-station-wave alert-wave-preventiva',
    tooltipClass: 'river-preventiva-tooltip',
    zOffset: 1900,
  },
};

function drawStyledRiverReach(paths, estado, displayRiverName, tooltipDetail) {
  const style = RIVER_ALERT_STYLE[estado];
  if (!style || !paths || !paths.length) return;

  const glowLine = L.polyline(paths, {
    color: style.glowColor,
    weight: style.glowWeight,
    opacity: style.glowOpacity,
    className: style.glowClass,
    lineCap: 'round',
    lineJoin: 'round',
    interactive: false,
  });
  glowLine.addTo(State.riverLayer);

  const coreLine = L.polyline(paths, {
    color: style.coreColor,
    weight: style.coreWeight,
    opacity: 0.95,
    className: style.coreClass,
    lineCap: 'round',
    lineJoin: 'round',
  });

  const tooltipNode = el('div', { class: `river-critical-tooltip ${style.tooltipClass}`.trim() },
    icon(`fa-solid ${style.icon}`),
    el('span', {},
      `${style.label}: `,
      el('strong', { text: displayRiverName }),
      tooltipDetail ? ` ${tooltipDetail}` : ''));

  coreLine.bindTooltip(tooltipNode, {
    sticky: true,
    direction: 'top',
    offset: [0, -6],
    className: 'river-critical-leaflet-tooltip',
  });

  coreLine.on('click', () => {
    State.map.fitBounds(coreLine.getBounds(), { padding: [55, 55], maxZoom: 14 });
  });

  coreLine.addTo(State.riverLayer);
}

function splitRiverPathsByDownstreamAlerts(rawLatlngs, timelineStations) {
  const paths = Array.isArray(rawLatlngs[0] && rawLatlngs[0][0]) ? rawLatlngs : [rawLatlngs];
  const uniqueStates = new Set(timelineStations.map((a) => a.estado));
  if (uniqueStates.size <= 1) {
    const onlyEstado = timelineStations[0] && timelineStations[0].estado;
    return RIVER_ALERT_STYLE[onlyEstado] ? [{ estado: onlyEstado, paths }] : [];
  }

  // Ordenar estaciones monitoreadas (alertas + normales) de aguas arriba hacia aguas abajo
  const withAlt = timelineStations.every((a) => Number(a.altitud) > 0);
  const ordered = [...timelineStations].sort((a, b) => (
    withAlt
      ? (Number(b.altitud) - Number(a.altitud))
      : (Number(b.lng) - Number(a.lng))
  ));

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  const oLat = Number(first.lat);
  const oLng = Number(first.lng);
  const dLat = Number(last.lat) - oLat;
  const dLng = Number(last.lng) - oLng;
  if (Math.hypot(dLat, dLng) < 1e-6) {
    const firstAlert = ordered.find((a) => RIVER_ALERT_STYLE[a.estado]);
    return firstAlert ? [{ estado: firstAlert.estado, paths }] : [];
  }

  const flowT = (pt) => (pt[0] - oLat) * dLat + (pt[1] - oLng) * dLng;
  const thresholds = ordered.slice(1).map((st) => ({
    t: flowT([Number(st.lat), Number(st.lng)]),
    estado: st.estado,
  })).sort((a, b) => a.t - b.t);

  const estadoAtT = (t) => {
    let cur = ordered[0].estado;
    for (let i = 0; i < thresholds.length; i += 1) {
      if (t >= thresholds[i].t) cur = thresholds[i].estado;
      else break;
    }
    return cur;
  };

  const buckets = new Map();
  const pushSeg = (estado, seg) => {
    // No destacar tramos cuya estación aguas abajo volvió a estado NORMAL
    if (!RIVER_ALERT_STYLE[estado] || seg.length < 2) return;
    if (!buckets.has(estado)) buckets.set(estado, []);
    buckets.get(estado).push(seg);
  };

  paths.forEach((path) => {
    if (path.length < 2) return;
    let curEstado = estadoAtT(flowT(path[0]));
    let curSeg = [path[0]];

    for (let i = 1; i < path.length; i += 1) {
      const a = path[i - 1];
      const b = path[i];
      const ta = flowT(a);
      const tb = flowT(b);

      if (Math.abs(tb - ta) < 1e-12) {
        curSeg.push(b);
        continue;
      }

      // Buscar todos los umbrales cruzados entre ta y tb en orden de recorrido
      const crossed = thresholds
        .filter((th) => (ta < th.t && th.t <= tb) || (ta > th.t && th.t >= tb))
        .sort((x, y) => (tb > ta ? x.t - y.t : y.t - x.t));

      crossed.forEach((th) => {
        const ratio = (th.t - ta) / (tb - ta);
        const mid = [a[0] + (b[0] - a[0]) * ratio, a[1] + (b[1] - a[1]) * ratio];
        curSeg.push(mid);
        pushSeg(curEstado, curSeg);
        const nextEstado = tb > ta ? th.estado : estadoAtT(th.t - 1e-9);
        curEstado = nextEstado;
        curSeg = [mid];
      });

      curSeg.push(b);
      curEstado = estadoAtT(tb);
    }
    pushSeg(curEstado, curSeg);
  });

  return Array.from(buckets.entries())
    .map(([estado, segs]) => ({ estado, paths: segs }))
    .sort((a, b) => (SEVERITY_Z[a.estado] || 0) - (SEVERITY_Z[b.estado] || 0));
}

function renderCriticalRiverReaches(visible = null) {
  if (!State.map) return;
  if (!State.riverLayer) {
    State.riverLayer = L.layerGroup().addTo(State.map);
  }
  State.riverLayer.clearLayers();

  if (State.filter === 'embalses' || State.filter === 'sin_datos' || State.filter === 'inactivas') return;

  const sourceItems = Array.isArray(visible) ? visible : visibleItems();
  const targetLevels = !State.search ? (ALERT_FILTER_LEVELS[State.filter] || null) : null;

  // Mostrar únicamente los cauces y halos de las alertas visibles según el filtro activo
  const alertItems = sourceItems
    .filter((it) => RIVER_ALERT_STYLE[it.estado]
      && (!targetLevels || targetLevels.includes(it.estado))
      && validCoords(it.lat, it.lng))
    .sort((a, b) => (SEVERITY_Z[b.estado] || 0) - (SEVERITY_Z[a.estado] || 0));

  if (!alertItems.length) return;

  const basinAlerts = new Map();

  alertItems.forEach((alertItem) => {
    const style = RIVER_ALERT_STYLE[alertItem.estado];
    const lat = Number(alertItem.lat);
    const lng = Number(alertItem.lng);

    // 1. Agregar halo/onda expansiva en cada estación con alerta
    const waveIcon = L.divIcon({
      html: `<div class="${style.waveClass}"></div>`,
      className: 'critical-wave-icon',
      iconSize: [50, 50],
      iconAnchor: [25, 25],
    });
    L.marker([lat, lng], { icon: waveIcon, interactive: false, zIndexOffset: style.zOffset }).addTo(State.riverLayer);

    if (alertItem.categoria === 'embalse') return;

    // 2. Agrupar alertas por río y región para permitir transición de color aguas abajo
    const riverName = extractRiverName(alertItem.nombre);
    const normRiver = normRiverText(riverName);
    const basinKey = `${alertItem.region || '0'}:${normRiver}`;
    if (!basinAlerts.has(basinKey)) {
      basinAlerts.set(basinKey, { riverName, normRiver, region: alertItem.region, alerts: [] });
    }
    basinAlerts.get(basinKey).alerts.push(alertItem);
  });

  basinAlerts.forEach(({ riverName, normRiver, region, alerts }) => {
    const primary = alerts[0];
    // 3. Buscar trazado geométrico oficial MOP (Red Hidrográfica 1:250k)
    const official = (State.criticalRivers || []).find((r) => (
      alerts.some((a) => r.codigo === a.codigo)
      || (normRiverText(r.river_name) === normRiver && (!region || !r.region || r.region === region))
    ));

    let latlngs = null;
    let displayRiverName = riverName;
    let tooltipDetail = '';

    if (official && Array.isArray(official.paths) && official.paths.length > 0) {
      latlngs = official.paths;
      displayRiverName = official.official_name || riverName;
      tooltipDetail = official.source ? `(${official.source})` : '(Red Hidrográfica MOP)';
    } else {
      const basinStations = (State.estaciones || []).filter((st) => {
        if (!validCoords(st.lat, st.lng)) return false;
        if (st.region && region && st.region !== region) return false;
        return normRiverText(extractRiverName(st.nombre)) === normRiver;
      });
      if (basinStations.length >= 2) {
        const ordered = orderStationsAlongRiver(basinStations.map((st) => ({
          lat: Number(st.lat),
          lng: Number(st.lng),
          nombre: st.nombre,
          altitud: Number(st.altitud) || 0,
        })));
        latlngs = ordered.map((p) => [p.lat, p.lng]);
        tooltipDetail = `(${ordered.length} puntos de monitoreo)`;
      }
    }

    if (latlngs && latlngs.length > 0) {
      // Incorporar estaciones activas en estado NORMAL del mismo río para cortar el destacado aguas abajo
      const timelineMap = new Map();
      (State.estaciones || []).forEach((st) => {
        if (!validCoords(st.lat, st.lng)) return;
        if (st.region && region && st.region !== region) return;
        if (normRiverText(extractRiverName(st.nombre)) !== normRiver) return;
        if (['CRITICO', 'ADVERTENCIA', 'PREVENTIVA', 'NORMAL'].includes(st.estado)) {
          timelineMap.set(st.codigo, st);
        }
      });
      alerts.forEach((a) => timelineMap.set(a.codigo, a));
      const timelineStations = Array.from(timelineMap.values());

      const reaches = splitRiverPathsByDownstreamAlerts(latlngs, timelineStations);
      reaches
        .filter(({ estado }) => !targetLevels || targetLevels.includes(estado))
        .forEach(({ estado, paths }) => {
          drawStyledRiverReach(paths, estado, displayRiverName, tooltipDetail);
        });
    }
  });
}


function haversineKm(lat1, lng1, lat2, lng2) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 6371 * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function findNearbyItems(item, limit = 3) {
  const lat = Number(item.lat);
  const lng = Number(item.lng);
  if (!validCoords(lat, lng)) return { total: 0, items: [] };
  const selfKey = `${item.categoria}:${item.codigo}`;
  const candidates = [];
  const pushPool = (arr, categoria, fallbackTipo) => {
    arr.forEach((entry) => {
      const key = `${categoria}:${entry.codigo}`;
      if (key === selfKey) return;
      const clat = Number(entry.lat);
      const clng = Number(entry.lng);
      if (!validCoords(clat, clng)) return;
      const distKm = haversineKm(lat, lng, clat, clng);
      candidates.push({
        ...entry,
        lat: clat,
        lng: clng,
        categoria,
        tipo: entry.tipo || fallbackTipo,
        distKm,
      });
    });
  };
  pushPool(State.estaciones, 'estacion', 'Fluviométrica (Río)');
  pushPool(State.embalses, 'embalse', 'Embalse / Lago');
  candidates.sort((a, b) => a.distKm - b.distKm);
  const withinRadius = candidates.filter((c) => c.distKm <= 80);
  const items = candidates.slice(0, limit);
  const total = withinRadius.length > 0 ? withinRadius.length : items.length;
  return { total, items };
}

function primaryMetric(item) {
  if (item.categoria === 'embalse') {
    if (item.volumen !== null && item.volumen !== undefined) {
      const valueText = fmt(item.volumen, 1);
      return { valueText, unitText: 'Mm³', fullText: `${valueText} Mm³` };
    }
    if (item.nivel !== null && item.nivel !== undefined) {
      const valueText = fmt(item.nivel, 1);
      return { valueText, unitText: 'm', fullText: `${valueText} m` };
    }
    return { valueText: '--', unitText: '', fullText: '--' };
  }
  const c = item.ultimo_caudal;
  if (c && c.valor !== null && c.valor !== undefined) {
    const valueText = fmt(c.valor, 2);
    return { valueText, unitText: 'm³/s', fullText: `${valueText} m³/s` };
  }
  if (item.alerta && item.alerta.valor_actual !== null && item.alerta.valor_actual !== undefined) {
    const valueText = fmt(item.alerta.valor_actual, 2);
    const unitText = item.alerta.unidad || 'm';
    return { valueText, unitText, fullText: `${valueText} ${unitText}` };
  }
  if (item.activa === false) return { valueText: 'Inactiva', unitText: '', fullText: 'Inactiva' };
  return { valueText: '--', unitText: '', fullText: '--' };
}

function openGoogleMapsSatellite(item) {
  if (!item || !validCoords(item.lat, item.lng)) {
    toast('Coordenadas no disponibles para esta estación.', 'error');
    return;
  }
  const coords = `${Number(item.lat).toFixed(6)},${Number(item.lng).toFixed(6)}`;
  const url = `https://www.google.com/maps?q=${encodeURIComponent(coords)}&t=k&z=16`;
  window.open(url, '_blank', 'noopener,noreferrer');
}

function hideSearchSuggestions() {
  const box = $('search-suggestions');
  if (box) {
    box.classList.add('hidden');
    box.replaceChildren();
  }
}

function renderSearchSuggestions() {
  const box = $('search-suggestions');
  if (!box) return;
  const q = State.search;
  if (!q) {
    hideSearchSuggestions();
    return;
  }
  const pool = [];
  const seen = new Set();
  const pushItem = (entry) => {
    const key = `${entry.categoria}:${entry.codigo}`;
    if (seen.has(key) || !matchesSearch(entry)) return;
    seen.add(key);
    pool.push(entry);
  };
  State.embalses.forEach((e) => {
    const lat = Number(e.lat), lng = Number(e.lng);
    if (validCoords(lat, lng)) pushItem({ ...e, lat, lng, categoria: 'embalse' });
  });
  State.estaciones.forEach((e) => {
    const lat = Number(e.lat), lng = Number(e.lng);
    if (validCoords(lat, lng)) pushItem({ ...e, lat, lng, categoria: 'estacion' });
  });
  State.alertas.forEach((a) => {
    const lat = Number(a.lat), lng = Number(a.lng);
    if (validCoords(lat, lng)) pushItem(alertAsMapItem(a));
  });

  const sorted = pool.sort((a, b) => {
    const an = String(a.nombre || '').toLowerCase();
    const bn = String(b.nombre || '').toLowerCase();
    const aStarts = an.startsWith(q) ? 0 : 1;
    const bStarts = bn.startsWith(q) ? 0 : 1;
    if (aStarts !== bStarts) return aStarts - bStarts;
    const sev = (ALERT_SEVERITY[b.estado] || 0) - (ALERT_SEVERITY[a.estado] || 0);
    if (sev !== 0) return sev;
    return an.localeCompare(bn, 'es');
  });

  box.classList.remove('hidden');
  if (sorted.length === 0) {
    box.replaceChildren(el('div', { class: 'search-sugg-empty', text: 'Sin coincidencias para esta búsqueda.' }));
    return;
  }

  const frag = document.createDocumentFragment();
  sorted.slice(0, 40).forEach((item) => {
    const lvlCls = levelClass(item.estado);
    const isEmb = item.categoria === 'embalse';
    const dotCls = lvlCls === 'normal' && isEmb ? 'embalse' : lvlCls;
    const pm = primaryMetric(item);
    const sub = [item.tipo || (isEmb ? 'Embalse' : 'Río'), item.comuna || item.region_nombre, item.codigo].filter(Boolean).join(' · ');
    const btn = el('button', {
      class: `search-sugg-item accent-${lvlCls}`,
      type: 'button',
      role: 'option',
    },
    el('div', { class: 'search-sugg-left' },
      el('div', { class: 'search-sugg-name', text: item.nombre }),
      el('div', { class: 'search-sugg-sub' },
        el('span', { class: `type-dot dot-${dotCls}` }),
        el('span', { text: sub }))),
    el('div', { class: 'search-sugg-right', text: pm.fullText }));
    btn.addEventListener('click', () => {
      hideSearchSuggestions();
      flyToItem(item);
    });
    frag.append(btn);
  });
  box.replaceChildren(frag);
}

function flyToItem(item) {
  if (!item || !State.map || !validCoords(item.lat, item.lng)) return;
  closeModal();
  const lat = Number(item.lat);
  const lng = Number(item.lng);
  const key = `${item.categoria}:${item.codigo}`;
  if (!State.markers.has(key)) {
    State.pinnedItem = { ...item, lat, lng };
    render();
    toast(`Mostrando en el mapa: ${item.nombre}`, 'info');
  }
  const targetZoom = Math.max(State.map.getZoom(), 13);
  const openTargetPopup = () => {
    const marker = State.markers.get(key);
    if (marker) {
      marker.openPopup();
    } else {
      L.popup({
        maxWidth: 330,
        autoPanPaddingTopLeft: [16, 120],
        autoPanPaddingBottomRight: [16, 28],
      }).setLatLng([lat, lng]).setContent(buildPopup(item)).openOn(State.map);
    }
  };
  const center = State.map.getCenter();
  const nearSamePoint = Math.abs(center.lat - lat) < 0.0002
    && Math.abs(center.lng - lng) < 0.0002
    && State.map.getZoom() >= targetZoom;
  if (nearSamePoint) {
    openTargetPopup();
  } else {
    State.map.once('moveend', openTargetPopup);
    State.map.flyTo([lat, lng], targetZoom, { animate: true, duration: 0.85 });
  }
}

function buildPopup(item) {
  const isEmb = item.categoria === 'embalse';
  const lvlCls = levelClass(item.estado);
  const pm = primaryMetric(item);
  const dotCls = lvlCls === 'normal' && isEmb ? 'embalse' : lvlCls;

  const isOfficial = item.alerta && item.alerta.fuente === 'DGA oficial';
  const sourceCls = isOfficial
    ? (lvlCls === 'critico' ? 'source-tag source-alert' : (lvlCls === 'advertencia' ? 'source-tag source-warn' : 'source-tag'))
    : 'source-tag';
  const sourceLabel = isOfficial ? 'DGA OFICIAL' : (item.alerta ? 'UMBRAL ACTIVO' : 'SENSOR BNA');

  const specs = el('div', { class: 'popup-specs' });
  const addRow = (k, v) => specs.append(
    el('div', { class: 'popup-spec-k', text: k }),
    el('div', { class: 'popup-spec-v', text: v }),
  );
  const addEstadoRow = () => specs.append(
    el('div', { class: 'popup-spec-k', text: 'Estado' }),
    el('div', { class: 'popup-spec-v popup-spec-estado' },
      el('span', {
        class: `popup-estado-pill estado-${lvlCls}`,
        text: LEVEL_LABEL[item.estado] || item.estado || 'Normal',
      })),
  );
  addRow('Código BNA', item.codigo || '--');
  if (isEmb) {
    addRow('Nivel / Vol.', `${fmt(item.nivel)} m · ${fmt(item.volumen)} Mm³`);
    addEstadoRow();
    addRow('Medición', item.fecha || '--');
  } else {
    const c = item.ultimo_caudal;
    addRow('Comuna', item.comuna || '--');
    addEstadoRow();
    addRow('Último caudal', c ? `${fmt(c.valor, 2)} m³/s` : 'Sin registro');
    if (isOfficial) {
      addRow('Alerta DGA', `${fmt(item.alerta.valor_actual, 2)} / ${fmt(item.alerta.umbral, 2)}`);
    }
  }

  const btnDetail = el('button', { class: 'hud-pill', type: 'button' },
    icon('fa-solid fa-sliders'), ' Detalle');
  btnDetail.addEventListener('click', () => openModal(item));

  const btnSat = el('button', {
    class: 'hud-pill hud-pill-subtle',
    type: 'button',
    title: 'Abrir ubicación satelital en Google Maps',
  }, icon('fa-solid fa-globe'), ' Satelital');
  btnSat.addEventListener('click', () => {
    openGoogleMapsSatellite(item);
  });

  const isActiva = item.activa !== false && String(item.estado_estacion || 'Activa').toLowerCase() === 'activa';
  const stationStateText = item.estado_estacion || (isActiva ? 'Activa' : 'Inactiva');

  return el('div', { class: `popup-card accent-${lvlCls}` },
    el('div', { class: 'popup-head' },
      el('div', { class: 'popup-title', text: item.nombre }),
      el('div', { class: 'popup-metric', text: pm.fullText })),
    el('div', { class: 'popup-type-line' },
      el('div', { class: 'popup-type-left' },
        el('span', { class: `type-dot dot-${dotCls}` }),
        el('span', { text: item.tipo || (isEmb ? 'Embalse / Lago' : 'Fluviométrica (Río)') })),
      el('span', { class: `popup-station-status ${isActiva ? 'is-active' : 'is-inactive'}` },
        el('span', { class: 'status-mini-dot' }),
        el('span', { text: stationStateText }))),
    el('div', { class: sourceCls },
      el('span', { class: 'source-dot' }),
      el('span', { text: sourceLabel })),
    specs,
    el('div', { class: 'popup-actions' }, btnDetail, btnSat));
}

const ALERT_SEVERITY = { CRITICO: 3, ADVERTENCIA: 2, PREVENTIVA: 1 };

function parseAlertTimestamp(fechaStr) {
  if (!fechaStr) return 0;
  const s = String(fechaStr).trim();
  const iso = s.includes(' ') ? s.replace(' ', 'T') : `${s}T00:00:00`;
  const ts = Date.parse(iso);
  return Number.isNaN(ts) ? 0 : ts;
}

function renderAlerts() {
  const box = $('alertas-list');
  box.replaceChildren();
  const list = [...State.alertas].sort((a, b) => {
    const sevDiff = (ALERT_SEVERITY[b.nivel_alerta] || 0) - (ALERT_SEVERITY[a.nivel_alerta] || 0);
    if (sevDiff !== 0) return sevDiff;
    const timeDiff = parseAlertTimestamp(b.fecha) - parseAlertTimestamp(a.fecha);
    if (timeDiff !== 0) return timeDiff;
    return String(a.nombre || '').localeCompare(String(b.nombre || ''), 'es');
  });
  if (list.length === 0) {
    box.append(el('div', { class: 'empty-state' }, icon('fa-solid fa-circle-check ok-icon'),
      el('p', { text: 'No hay alertas activas. Todas las estaciones monitoreadas están dentro de sus umbrales.' })));
    return;
  }
  list.forEach((a) => {
    const t = formatSensorTime(a.fecha);
    const sincTime = a.sincronizado ? a.sincronizado.split(' ')[1] : '--';
    const meta = el('div', {
      class: 'alert-footer',
      title: `Medición sensor: ${a.fecha || '--'} · Verificado con DGA: ${a.sincronizado || '--'}`,
    },
    el('span', {}, icon('fa-solid fa-ruler'), ` Umbral: ${fmt(a.umbral, 3)} ${a.unidad}`),
    el('span', {}, `📡 Medición: ${t.shortText} (${t.relText})`));
    const srcText = `${a.fuente} · Sinc: ${sincTime}${a.dato_antiguo ? ' · dato antiguo' : ''}`;
    const card = el('div', {
      class: `alert-card ${a.nivel_alerta}`, tabindex: '0',
      'data-codigo': a.codigo, 'data-categoria': a.tipo_elemento,
      'data-lat': a.lat ?? '', 'data-lng': a.lng ?? '',
    },
    el('div', { class: 'alert-top' }, el('span', { class: 'alert-title', text: a.nombre }), badge(a.nivel_alerta)),
    el('div', { class: 'alert-source', text: srcText }),
    el('div', { class: 'alert-msg', text: a.mensaje }),
    meta);
    box.append(card);
  });
}

function formatItemThreshold(item) {
  if (item.alerta && item.alerta.umbral !== null && item.alerta.umbral !== undefined) {
    return {
      text: `Umbral: ${fmt(item.alerta.umbral, 3)}${item.alerta.unidad ? ' ' + item.alerta.unidad : ''}`,
      hasRule: true,
    };
  }
  const umbrales = State.umbrales || {};
  const isEmb = item.categoria === 'embalse';
  const rule = isEmb
    ? (umbrales.embalses && umbrales.embalses[item.codigo])
    : (umbrales.estaciones && umbrales.estaciones[item.codigo]);
  if (rule) {
    const min = isEmb ? rule.volumen_min : rule.caudal_min;
    const max = isEmb ? rule.volumen_max : rule.caudal_max;
    const unit = isEmb ? 'Mm³' : 'm³/s';
    if (min !== null && min !== undefined && max !== null && max !== undefined) {
      return { text: `Umbral: ${fmt(min, 2)}–${fmt(max, 2)} ${unit}`, hasRule: true };
    }
    if (min !== null && min !== undefined) {
      return { text: `Mín: ${fmt(min, 2)} ${unit}`, hasRule: true };
    }
    if (max !== null && max !== undefined) {
      return { text: `Máx: ${fmt(max, 2)} ${unit}`, hasRule: true };
    }
  }
  return { text: 'Sin umbral', hasRule: false };
}

function renderList(items) {
  const box = $('station-list');
  $('filtered-count').textContent = `${items.length} elementos`;
  box.replaceChildren();
  if (items.length === 0) {
    box.append(el('div', { class: 'empty-state' }, el('p', {
      text: State.loadingRegion ? 'Cargando estaciones desde la DGA...' : 'No hay elementos con los filtros actuales.',
    })));
    return;
  }
  const frag = document.createDocumentFragment();
  const nowRef = new Date();
  const defaultSinc = State.lastSummary && State.lastSummary.last_sync ? State.lastSummary.last_sync : null;
  const itemFecha = (x) => (x.alerta && x.alerta.fecha)
    || (x.categoria === 'embalse' ? x.fecha : (x.ultimo_caudal && x.ultimo_caudal.fecha))
    || null;
  [...items]
    .sort((a, b) => {
      const timeDiff = parseAlertTimestamp(itemFecha(b)) - parseAlertTimestamp(itemFecha(a));
      if (timeDiff !== 0) return timeDiff;
      const sevDiff = (SEVERITY_Z[b.estado] || 0) - (SEVERITY_Z[a.estado] || 0);
      if (sevDiff !== 0) return sevDiff;
      return a.nombre.localeCompare(b.nombre, 'es');
    })
    .forEach((i) => {
      const estado = i.estado || 'NORMAL';
      const sub = i.categoria === 'embalse'
        ? `${i.tipo} · Vol: ${fmt(i.volumen)} Mm³`
        : `${i.comuna || i.tipo} · ${i.activa === false ? 'Inactiva' : (i.ultimo_caudal ? fmt(i.ultimo_caudal.valor, 2) + ' m³/s' : 'Sin registro')}`;
      const umbral = formatItemThreshold(i);
      const rawFecha = (i.alerta && i.alerta.fecha)
        || (i.categoria === 'embalse' ? i.fecha : (i.ultimo_caudal && i.ultimo_caudal.fecha))
        || null;
      const sincFull = (i.alerta && i.alerta.sincronizado) || defaultSinc;
      const sincTime = sincFull ? sincFull.split(' ')[1] : '--';
      let medicionText = '📡 Medición: Sin registro';
      if (rawFecha) {
        const t = formatSensorTime(rawFecha, nowRef);
        medicionText = `📡 Medición: ${t.shortText} (${t.relText})`;
      }
      const meta = el('div', {
        class: 'station-item-meta',
        title: `Medición sensor: ${rawFecha || '--'} · Verificado con DGA: ${sincFull || '--'}`,
      },
      el('span', {}, icon('fa-regular fa-clock'), ` Sinc: ${sincTime}`),
      el('span', {}, medicionText));
      const umbralEl = el('div', {
        class: `station-item-umbral${umbral.hasRule ? ' has-rule' : ''}`,
      },
      umbral.hasRule ? icon('fa-solid fa-ruler') : null,
      umbral.text);
      frag.append(el('div', {
        class: `station-item estado-${levelClass(estado)}`,
        tabindex: '0',
        'data-codigo': i.codigo,
        'data-categoria': i.categoria,
      },
      el('div', { class: 'station-item-top' },
        el('div', { class: 'station-item-name', text: i.nombre }),
        badge(estado)),
      el('div', { class: 'station-item-mid' },
        el('div', { class: 'station-item-sub', text: `${sub} · ${i.codigo}` }),
        umbralEl),
      meta));
    });
  box.append(frag);
}

function focusItem(categoria, codigo, lat, lng) {
  const key = `${categoria}:${codigo}`;
  let marker = State.markers.get(key);
  if (!marker) {
    const pool = categoria === 'embalse' ? State.embalses : State.estaciones;
    let target = pool.find((x) => x.codigo === codigo);
    if (target) {
      target = { ...target, categoria, lat: Number(target.lat), lng: Number(target.lng) };
    } else {
      const a = State.alertas.find((x) => x.codigo === codigo);
      if (a && validCoords(Number(a.lat), Number(a.lng))) target = alertAsMapItem(a);
    }
    if (target && validCoords(target.lat, target.lng)) {
      State.pinnedItem = target;
      render();
      marker = State.markers.get(key);
    }
  }
  if (marker) {
    State.map.setView(marker.getLatLng(), Math.max(State.map.getZoom(), 12), { animate: false });
    marker.openPopup();
    return;
  }
  // Alerta oficial de una estación fuera de la región cargada: centrar en sus coordenadas
  if (validCoords(lat, lng)) {
    State.map.setView([lat, lng], 11, { animate: false });
    const a = State.alertas.find((x) => x.codigo === codigo);
    if (a) {
      const lvlCls = levelClass(a.nivel_alerta);
      const sourceCls = lvlCls === 'critico' ? 'source-tag source-alert' : (lvlCls === 'advertencia' ? 'source-tag source-warn' : 'source-tag');
      const card = el('div', { class: `popup-card accent-${lvlCls}` },
        el('div', { class: 'popup-head' },
          el('div', { class: 'popup-title', text: a.nombre }),
          el('div', { class: 'popup-metric', text: a.valor_actual != null ? `${fmt(a.valor_actual, 2)} ${a.unidad || ''}`.trim() : '--' })),
        el('div', { class: sourceCls },
          el('span', { class: 'source-dot' }),
          el('span', { text: a.fuente || 'DGA OFICIAL' })),
        el('div', { class: 'popup-type-line' },
          el('span', { class: `type-dot dot-${lvlCls}` }),
          el('span', { text: a.mensaje })));
      L.popup({
        maxWidth: 330,
        autoPanPaddingTopLeft: [16, 120],
        autoPanPaddingBottomRight: [16, 28],
      }).setLatLng([lat, lng]).setContent(card).openOn(State.map);
    }
    toast('La estación pertenece a otra región. Cambia el filtro de región para ver su detalle.');
  } else {
    toast('La estación no está visible con los filtros actuales.');
  }
}

/* ----------------------------------------------------------------- modal */
async function openModal(item) {
  const isEmb = item.categoria === 'embalse';
  State.currentModalItem = item;
  if (State.map) State.map.closePopup();

  $('modal-nombre').textContent = item.nombre || '--';
  $('modal-badge-tipo').textContent = item.tipo || (isEmb ? 'Embalse / Lago' : 'Fluviométrica (Río)');
  $('form-tipo').value = item.categoria;
  $('form-codigo').value = item.codigo;
  $('form-nombre').value = item.nombre;
  $('save-feedback').textContent = '';
  $('save-feedback').className = 'feedback-msg';
  $('modal-stale').classList.add('hidden');
  $('modal-alerta-banner').className = 'crimson-notice inspector-alert-callout hidden';
  $('modal-thresh-wrap').classList.add('hidden');
  $('modal-btn-thresh').setAttribute('aria-expanded', 'false');
  $('modal-btn-sat').disabled = !validCoords(item.lat, item.lng);
  $('modal-btn-fly').disabled = !validCoords(item.lat, item.lng);

  let rule = {};
  let gen = {};
  let detail = item;
  try {
    const [cfg, det] = await Promise.all([
      api('/api/umbrales'),
      isEmb ? Promise.resolve(null) : api(`/api/estaciones/${encodeURIComponent(item.codigo)}`),
    ]);
    rule = (isEmb ? cfg.embalses : cfg.estaciones)[item.codigo] || {};
    gen = cfg.general || {};
    if (det) detail = { ...item, ...det, alerta: det.alerta, estado: det.estado };
  } catch (err) {
    toast(`No se pudo cargar el detalle: ${err.message}`, 'error');
  }
  State.currentModalItem = detail;

  const estado = detail.estado || 'NORMAL';
  const lvlCls = levelClass(estado);
  const statusLabel = (LEVEL_LABEL[estado] || estado).toLowerCase();

  $('modal-inspector-main').className = `inspector-main accent-${lvlCls}`;
  $('modal-type-dot').className = `type-dot dot-${lvlCls === 'normal' && isEmb ? 'embalse' : lvlCls}`;
  $('modal-status-paren').textContent = `(${statusLabel})`;
  $('modal-status-paren').className = `status-paren estado-${lvlCls}`;
  const showHistBtn = ['CRITICO', 'ADVERTENCIA', 'PREVENTIVA'].includes(estado);
  const histBtn = $('modal-btn-history');
  histBtn.classList.toggle('hidden', !showHistBtn);
  histBtn.hidden = !showHistBtn;

  const pm = primaryMetric(detail);
  $('modal-hero-val').textContent = pm.valueText;
  $('modal-hero-unit').textContent = pm.unitText;

  const srcBox = $('modal-source-box');
  if (detail.alerta && detail.alerta.fuente === 'DGA oficial') {
    srcBox.className = lvlCls === 'critico' ? 'source-tag source-alert' : (lvlCls === 'advertencia' ? 'source-tag source-warn' : 'source-tag');
    $('modal-source-text').textContent = 'DGA OFICIAL · ALERTA';
  } else if (detail.alerta) {
    srcBox.className = 'source-tag source-warn';
    $('modal-source-text').textContent = 'UMBRAL PERSONALIZADO';
  } else {
    srcBox.className = 'source-tag';
    $('modal-source-text').textContent = isEmb ? 'DGA CHILE · EMBALSES' : 'DGA CHILE · RED BNA';
  }

  const specs = $('modal-specs');
  const specRows = [];
  const addSpec = (label, value, mono = false) => {
    specRows.push(
      el('div', { class: 'spec-label', text: label }),
      el('div', { class: mono ? 'spec-value mono' : 'spec-value', text: value }),
    );
  };
  const addSpecNode = (label, node) => {
    specRows.push(
      el('div', { class: 'spec-label', text: label }),
      el('div', { class: 'spec-value' }, node),
    );
  };
  const isActiva = detail.activa !== false && String(detail.estado_estacion || 'Activa').toLowerCase() === 'activa';
  const estadoRedText = detail.estado_estacion || (isActiva ? 'Activa' : 'Inactiva');
  const makeEstadoRedNode = () => el('span', {
    class: `popup-station-status ${isActiva ? 'is-active' : 'is-inactive'}`,
  }, el('span', { class: 'status-mini-dot' }), el('span', { text: estadoRedText }));

  addSpec('Entidad', 'DGA · MOP Chile');
  addSpec('Código BNA', detail.codigo || '--', true);
  addSpec('Ubicación', [detail.comuna, detail.region_nombre].filter(Boolean).join(' · ') || 'Chile');

  const thresholdParts = [];
  if (isEmb) {
    addSpec('Nivel de agua', detail.nivel !== null && detail.nivel !== undefined ? `${fmt(detail.nivel)} m` : '--', true);
    addSpec('Volumen', detail.volumen !== null && detail.volumen !== undefined ? `${fmt(detail.volumen)} Mm³` : '--', true);
    addSpecNode('Estado red', makeEstadoRedNode());
    addSpec('Último registro', detail.fecha || 'Sin registro', true);
    $('lbl-thresh-min').textContent = 'Volumen mínimo (déficit):';
    $('lbl-thresh-max').textContent = 'Volumen máximo (cota vertedero):';
    $('unit-addon-min').textContent = $('unit-addon-max').textContent = 'Mm³';
    $('input-thresh-min').value = rule.volumen_min ?? '';
    $('input-thresh-max').value = rule.volumen_max ?? '';
    $('input-thresh-min').placeholder = gen ? `Ej: ${gen.volumen_min_default ?? 20}` : '';
    $('input-thresh-max').placeholder = '';
    if (rule.volumen_min != null) thresholdParts.push(`Mín ${fmt(rule.volumen_min)} Mm³`);
    if (rule.volumen_max != null) thresholdParts.push(`Máx ${fmt(rule.volumen_max)} Mm³`);
    if (detail.dias_desde_medicion === null || detail.dias_desde_medicion > 365) {
      $('modal-stale-texto').textContent = `La DGA no publica mediciones recientes para este embalse (última: ${detail.fecha || 'desconocida'}). No se generan alertas de umbral con datos de más de un año.`;
      $('modal-stale').classList.remove('hidden');
    }
  } else {
    const c = detail.ultimo_caudal;
    const of = detail.alerta_oficial;
    addSpec('Último caudal', c ? `${fmt(c.valor, 3)} m³/s (${c.fecha})` : 'Sin dato publicado', true);
    if (of) {
      addSpec('Alerta DGA', `${fmt(of.valor, 3)} / umbral ${fmt(of.umbral, 3)}`, true);
    }
    addSpecNode('Estado red', makeEstadoRedNode());
    $('lbl-thresh-min').textContent = 'Caudal mínimo (estiaje):';
    $('lbl-thresh-max').textContent = 'Caudal máximo (crecida):';
    $('unit-addon-min').textContent = $('unit-addon-max').textContent = 'm³/s';
    $('input-thresh-min').value = rule.caudal_min ?? '';
    $('input-thresh-max').value = rule.caudal_max ?? '';
    $('input-thresh-min').placeholder = gen ? `Ej: ${gen.caudal_min_default ?? 0.5}` : '';
    $('input-thresh-max').placeholder = gen ? `Ej: ${gen.caudal_max_default ?? 60}` : '';
    if (rule.caudal_min != null) thresholdParts.push(`Mín ${fmt(rule.caudal_min)} m³/s`);
    if (rule.caudal_max != null) thresholdParts.push(`Máx ${fmt(rule.caudal_max)} m³/s`);
    if (c) {
      const dias = Math.floor((Date.now() - new Date(`${c.fecha}T00:00:00`).getTime()) / 86400000);
      if (dias > 7) {
        $('modal-stale-texto').textContent = `El último caudal diario validado por la DGA es del ${c.fecha} (hace ${dias} días). Los umbrales personalizados se evalúan sobre ese dato; las alertas DGA oficiales sí son en tiempo real.`;
        $('modal-stale').classList.remove('hidden');
      }
    }
  }

  if (detail.alerta_oficial && detail.alerta_oficial.umbral != null) {
    thresholdParts.push(`Oficial DGA: ${fmt(detail.alerta_oficial.umbral, 2)}`);
  }
  const threshBtnHasRule = thresholdParts.length > 0;
  $('modal-btn-thresh').classList.toggle('active', threshBtnHasRule);
  addSpec('Umbrales', threshBtnHasRule ? thresholdParts.join(' · ') : 'Sin regla configurada', true);
  specs.replaceChildren(...specRows);

  const rawFecha = (detail.alerta && detail.alerta.fecha)
    || (isEmb ? detail.fecha : (detail.ultimo_caudal && detail.ultimo_caudal.fecha))
    || null;
  const sincFull = (detail.alerta && detail.alerta.sincronizado)
    || (State.lastSummary && State.lastSummary.last_sync)
    || null;
  const sincTime = sincFull ? sincFull.split(' ')[1] : '--';
  $('modal-sinc').replaceChildren(icon('fa-regular fa-clock'), ` Sinc: ${sincTime}`);
  if (rawFecha) {
    const t = formatSensorTime(rawFecha);
    $('modal-medicion').textContent = `📡 Medición: ${t.shortText} (${t.relText})`;
  } else {
    $('modal-medicion').textContent = '📡 Medición: Sin registro';
  }
  $('modal-sync-meta').title = `Medición sensor: ${rawFecha || '--'} · Verificado con DGA: ${sincFull || '--'}`;

  const banner = $('modal-alerta-banner');
  if (detail.alerta) {
    $('modal-alerta-texto').textContent = detail.alerta.mensaje;
    const toneCls = lvlCls === 'advertencia' ? ' alert-warn' : (lvlCls === 'preventiva' ? ' alert-info' : '');
    banner.className = `crimson-notice inspector-alert-callout${toneCls}`;
  } else {
    banner.className = 'crimson-notice inspector-alert-callout hidden';
  }

  const nearby = findNearbyItems(detail, 3);
  const nearbySection = $('modal-nearby-section');
  const nearbyList = $('modal-nearby-list');
  if (!nearby.items.length) {
    nearbySection.classList.add('hidden');
    nearbyList.replaceChildren();
  } else {
    nearbySection.classList.remove('hidden');
    $('modal-nearby-title').textContent = `ESTACIONES CERCANAS (${nearby.total} TOTAL)`;
    const nodes = nearby.items.map((nb) => {
      const nbCls = levelClass(nb.estado);
      const nbEmb = nb.categoria === 'embalse';
      const nbDot = nbCls === 'normal' && nbEmb ? 'embalse' : nbCls;
      const nbPm = primaryMetric(nb);
      const row = el('button', {
        class: `nearby-item accent-${nbCls}`,
        type: 'button',
        title: 'Volar a esta estación en el mapa',
      },
      el('div', { class: 'nearby-left' },
        el('div', { class: 'nearby-name', text: nb.nombre }),
        el('div', { class: 'nearby-sub' },
          el('span', { class: `type-dot dot-${nbDot}` }),
          el('span', { text: `${nb.tipo} · ${nb.distKm.toFixed(1)} km` }))),
      el('div', { class: 'nearby-right', text: nbPm.fullText }));
      row.addEventListener('click', () => flyToItem(nb));
      return row;
    });
    nearbyList.replaceChildren(...nodes);
  }

  $('modal-station').classList.remove('hidden');
  $('modal-close').focus();
}

function closeModal() { $('modal-station').classList.add('hidden'); }

async function saveThreshold(e) {
  e.preventDefault();
  const tipo = $('form-tipo').value;
  const rawMin = $('input-thresh-min').value.trim();
  const rawMax = $('input-thresh-max').value.trim();
  const vmin = rawMin === '' ? null : Number(rawMin);
  const vmax = rawMax === '' ? null : Number(rawMax);
  const fb = $('save-feedback');
  fb.className = 'feedback-msg';

  if ((vmin !== null && (!Number.isFinite(vmin) || vmin < 0)) || (vmax !== null && (!Number.isFinite(vmax) || vmax < 0))) {
    fb.textContent = 'Ingresa números válidos (≥ 0).'; fb.classList.add('error'); return;
  }
  if (vmin !== null && vmax !== null && vmin >= vmax) {
    fb.textContent = 'El mínimo debe ser menor que el máximo.'; fb.classList.add('error'); return;
  }
  const body = { tipo, codigo: $('form-codigo').value, nombre: $('form-nombre').value };
  body[tipo === 'embalse' ? 'volumen_min' : 'caudal_min'] = vmin;
  body[tipo === 'embalse' ? 'volumen_max' : 'caudal_max'] = vmax;

  $('btn-save').disabled = true;
  fb.textContent = 'Guardando...';
  try {
    await api('/api/umbrales', { method: 'POST', body });
    fb.textContent = vmin === null && vmax === null ? '✓ Regla eliminada' : '✓ Umbrales guardados';
    fb.classList.add('ok');
    refresh(false);
  } catch (err) {
    fb.textContent = err.message; fb.classList.add('error');
  } finally {
    $('btn-save').disabled = false;
  }
}

/* ----------------------------------------------------------------- sync y sonido */
async function forceSync() {
  $('sync-spinner').classList.add('fa-spin');
  $('btn-sync').disabled = true;
  $('sync-status').textContent = 'Sincronizando...';
  try {
    const r = await api('/api/sync', { method: 'POST', body: { region: State.region } });
    toast(r.mensaje, 'info');
    State.loadingRegion = true;
    for (let i = 0; i < 15; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      const summary = await api('/api/summary');
      if (!summary.cargando) {
        await refresh(false);
        if (summary.last_error) {
          toast(`Sincronización parcial: ${summary.last_error}`, 'error');
        } else {
          toast(`✓ Sincronización completada (${summary.last_sync || ''})`, 'ok');
        }
        return;
      }
    }
    await refresh(false);
  } catch (err) {
    toast(err.message, err.status === 429 ? 'info' : 'error');
  } finally {
    $('btn-sync').disabled = false;
    $('sync-spinner').classList.remove('fa-spin');
  }
}

function toggleSound() {
  State.soundEnabled = !State.soundEnabled;
  const btn = $('btn-sound');
  btn.classList.toggle('active', State.soundEnabled);
  btn.setAttribute('aria-pressed', String(State.soundEnabled));
  btn.title = State.soundEnabled ? 'Silenciar alertas' : 'Activar sonido de alerta';
  btn.replaceChildren(icon(State.soundEnabled ? 'fa-solid fa-bell' : 'fa-solid fa-bell-slash'));
  if (State.soundEnabled) beep(660, 0.12);
}

function syncNotifyButton() {
  const btn = $('btn-notify');
  if (!btn) return;
  const supported = 'Notification' in window;
  const perm = supported ? Notification.permission : 'unsupported';
  const active = supported && perm === 'granted' && State.browserNotifyEnabled;
  btn.classList.toggle('active', active);
  btn.classList.toggle('denied', perm === 'denied');
  btn.classList.remove('notify-critico', 'notify-advertencia', 'notify-preventiva');
  if (active && State.alertas.length > 0) {
    const top = [...State.alertas].sort((a, b) => (ALERT_SEVERITY[b.nivel_alerta] || 0) - (ALERT_SEVERITY[a.nivel_alerta] || 0))[0];
    if (top && ['CRITICO', 'ADVERTENCIA', 'PREVENTIVA'].includes(top.nivel_alerta)) {
      btn.classList.add(`notify-${top.nivel_alerta.toLowerCase()}`);
    }
  }
  btn.setAttribute('aria-pressed', String(active));
  if (!supported) {
    btn.title = 'Notificaciones no soportadas en este navegador';
  } else if (perm === 'denied') {
    btn.title = 'Notificaciones bloqueadas: habilítalas en la configuración del navegador';
  } else if (active) {
    btn.title = 'Notificaciones del navegador activadas (clic para pausar)';
  } else {
    btn.title = 'Activar notificaciones del navegador';
  }
}

async function initBrowserNotifications() {
  if (!('Notification' in window)) {
    State.browserNotifyEnabled = false;
    syncNotifyButton();
    return;
  }
  let saved = null;
  let asked = null;
  try {
    saved = localStorage.getItem('dga_browser_notify');
    asked = localStorage.getItem('dga_browser_notify_asked');
  } catch (_) { /* ignorar */ }

  State.browserNotifyEnabled = saved !== '0';
  if (Notification.permission === 'default' && asked !== '1' && State.browserNotifyEnabled) {
    try { localStorage.setItem('dga_browser_notify_asked', '1'); } catch (_) { /* ignorar */ }
    try {
      const res = await Notification.requestPermission();
      if (res === 'granted') {
        try { localStorage.setItem('dga_browser_notify', '1'); } catch (_) { /* ignorar */ }
        toast('✓ Notificaciones del navegador activadas', 'ok');
      } else {
        State.browserNotifyEnabled = false;
      }
    } catch (_) {
      State.browserNotifyEnabled = false;
    }
  } else if (Notification.permission !== 'granted') {
    State.browserNotifyEnabled = false;
  }
  syncNotifyButton();
}

async function toggleBrowserNotifications() {
  if (!('Notification' in window)) {
    toast('Tu navegador no soporta notificaciones de escritorio.', 'info');
    return;
  }
  if (Notification.permission === 'denied') {
    toast('Notificaciones bloqueadas. Habilítalas desde el ícono de candado junto a la URL.', 'error');
    syncNotifyButton();
    return;
  }
  if (Notification.permission === 'default') {
    try {
      const res = await Notification.requestPermission();
      if (res === 'granted') {
        State.browserNotifyEnabled = true;
        try { localStorage.setItem('dga_browser_notify', '1'); } catch (_) { /* ignorar */ }
        syncNotifyButton();
        toast('✓ Notificaciones del navegador activadas', 'ok');
        try {
          new Notification('DGA Water Monitor', {
            body: 'Recibirás alertas Críticas, Advertencias y Preventivas en tiempo real.',
            tag: 'dga-notify-ready',
          });
        } catch (_) { /* ignorar */ }
      } else {
        State.browserNotifyEnabled = false;
        syncNotifyButton();
        toast('Permiso de notificaciones no concedido.', 'info');
      }
    } catch (err) {
      toast(`No se pudo solicitar permiso: ${err.message}`, 'error');
    }
    return;
  }

  State.browserNotifyEnabled = !State.browserNotifyEnabled;
  try { localStorage.setItem('dga_browser_notify', State.browserNotifyEnabled ? '1' : '0'); } catch (_) { /* ignorar */ }
  syncNotifyButton();
  toast(
    State.browserNotifyEnabled ? '✓ Notificaciones del navegador activadas' : 'Notificaciones del navegador pausadas',
    State.browserNotifyEnabled ? 'ok' : 'info',
  );
}

function alertNotifIcon(nivel) {
  const palette = {
    CRITICO: { fill: '#f43f5e', ring: '#fda4af' },
    ADVERTENCIA: { fill: '#f59e0b', ring: '#fde68a' },
    PREVENTIVA: { fill: '#38bdf8', ring: '#bae6fd' },
  };
  const p = palette[nivel] || { fill: '#00e5ff', ring: '#67e8f9' };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#060a10"/><circle cx="32" cy="32" r="22" fill="${p.fill}" stroke="${p.ring}" stroke-width="4"/><path d="M32 18v18M32 43v4" stroke="#ffffff" stroke-width="5" stroke-linecap="round"/></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function sendBrowserAlertNotification(nuevas) {
  if (!State.browserNotifyEnabled || !('Notification' in window) || Notification.permission !== 'granted') return;
  const ordenadas = [...nuevas].sort((a, b) => (ALERT_SEVERITY[b.nivel_alerta] || 0) - (ALERT_SEVERITY[a.nivel_alerta] || 0));
  const primera = ordenadas[0];
  if (!primera) return;
  const iconTag = { CRITICO: '🔴', ADVERTENCIA: '🟡', PREVENTIVA: '🔵' };
  const nivel = LEVEL_LABEL[primera.nivel_alerta] || primera.nivel_alerta;
  const prefix = iconTag[primera.nivel_alerta] || '⚠️';
  const title = ordenadas.length > 1
    ? `${prefix} DGA Water Monitor · ${ordenadas.length} alertas (${nivel})`
    : `${prefix} Alerta ${nivel}: ${primera.nombre}`;
  const topLines = ordenadas.slice(0, 3).map((a) => {
    const t = iconTag[a.nivel_alerta] || '•';
    const lbl = LEVEL_LABEL[a.nivel_alerta] || a.nivel_alerta;
    return `${t} [${lbl}] ${a.nombre}: ${a.valor_actual ?? '--'} ${a.unidad || ''}`.trim();
  });
  const body = ordenadas.length > 1
    ? `${topLines.join('\n')}${ordenadas.length > 3 ? `\n(+${ordenadas.length - 3} más)` : ''}`
    : primera.mensaje;
  try {
    const notif = new Notification(title, {
      body,
      icon: alertNotifIcon(primera.nivel_alerta),
      tag: `dga-alerta-${primera.codigo}`,
      renotify: true,
      requireInteraction: primera.nivel_alerta === 'CRITICO',
    });
    notif.onclick = () => {
      window.focus();
      focusItem(primera.tipo_elemento || 'estacion', primera.codigo, Number(primera.lat), Number(primera.lng));
      notif.close();
    };
  } catch (err) {
    console.warn('No se pudo mostrar notificación del navegador', err);
  }
}

const SOUND_DEFAULT_PRESETS = {
  CRITICO: 'siren',
  ADVERTENCIA: 'amber_dual',
  PREVENTIVA: 'chime',
};

const SOUND_GALLERY = {
  CRITICO: {
    // Sirena nuclear/radioactiva exagerada con barrido ascendente/descendente y doble oscilador desafinado
    siren: [
      { delay: 0.00, freq: 310, peakFreq: 1120, peakAt: 0.52, endFreq: 290, dur: 1.18, type: 'sawtooth', vol: 0.14, detune: 22, hold: 0.85 },
      { delay: 0.00, freq: 155, peakFreq: 380, peakAt: 0.52, endFreq: 145, dur: 1.18, type: 'square', vol: 0.06, hold: 0.85 },
      { delay: 1.24, freq: 320, peakFreq: 1180, peakAt: 0.52, endFreq: 270, dur: 1.24, type: 'sawtooth', vol: 0.15, detune: 24, hold: 0.85 },
      { delay: 1.24, freq: 160, peakFreq: 400, peakAt: 0.52, endFreq: 140, dur: 1.24, type: 'square', vol: 0.06, hold: 0.85 },
    ],
    // Klaxon pesado de búnker / submarino
    alarm: [
      { delay: 0.00, freq: 480, endFreq: 510, dur: 0.24, type: 'sawtooth', vol: 0.15, detune: 28, hold: 0.82 },
      { delay: 0.29, freq: 720, endFreq: 750, dur: 0.24, type: 'sawtooth', vol: 0.15, detune: 28, hold: 0.82 },
      { delay: 0.58, freq: 480, endFreq: 510, dur: 0.24, type: 'sawtooth', vol: 0.15, detune: 28, hold: 0.82 },
      { delay: 0.87, freq: 720, endFreq: 780, dur: 0.36, type: 'sawtooth', vol: 0.16, detune: 30, hold: 0.84 },
    ],
    // Pulsos rápidos estilo Geiger / radiación aguda
    radar: [
      { delay: 0.00, freq: 1480, endFreq: 780, dur: 0.14, type: 'sawtooth', vol: 0.13, detune: 18 },
      { delay: 0.16, freq: 1480, endFreq: 780, dur: 0.14, type: 'sawtooth', vol: 0.13, detune: 18 },
      { delay: 0.32, freq: 1620, endFreq: 840, dur: 0.14, type: 'sawtooth', vol: 0.14, detune: 18 },
      { delay: 0.50, freq: 1620, endFreq: 680, dur: 0.30, type: 'sawtooth', vol: 0.15, detune: 22 },
    ],
  },
  ADVERTENCIA: {
    amber_dual: [
      { delay: 0.00, freq: 660, dur: 0.16, type: 'triangle', vol: 0.13 },
      { delay: 0.20, freq: 520, dur: 0.24, type: 'triangle', vol: 0.12 },
    ],
    bell_warn: [
      { delay: 0.00, freq: 740, dur: 0.18, type: 'sine', vol: 0.13 },
      { delay: 0.22, freq: 740, dur: 0.24, type: 'sine', vol: 0.12 },
    ],
    pulse_mid: [
      { delay: 0.00, freq: 587, endFreq: 698, dur: 0.16, type: 'triangle', vol: 0.12 },
      { delay: 0.20, freq: 698, endFreq: 587, dur: 0.20, type: 'triangle', vol: 0.11 },
    ],
  },
  PREVENTIVA: {
    chime: [
      { delay: 0.00, freq: 523.25, dur: 0.16, type: 'sine', vol: 0.10 },
      { delay: 0.16, freq: 659.25, dur: 0.26, type: 'sine', vol: 0.10 },
    ],
    crystal: [
      { delay: 0.00, freq: 659.25, dur: 0.14, type: 'sine', vol: 0.09 },
      { delay: 0.14, freq: 783.99, dur: 0.26, type: 'sine', vol: 0.09 },
    ],
    ping: [
      { delay: 0.00, freq: 587.33, dur: 0.28, type: 'sine', vol: 0.10 },
    ],
  },
};

function getSoundPreset(level) {
  const lvl = SOUND_GALLERY[level] ? level : 'PREVENTIVA';
  try {
    const saved = localStorage.getItem(`dga_sound_preset_${lvl}`);
    if (saved && SOUND_GALLERY[lvl][saved]) return saved;
  } catch (_) {}
  return SOUND_DEFAULT_PRESETS[lvl];
}

function setSoundPreset(level, preset) {
  if (!SOUND_GALLERY[level] || !SOUND_GALLERY[level][preset]) return;
  try {
    localStorage.setItem(`dga_sound_preset_${level}`, preset);
  } catch (_) {}
}

function playToneSequence(steps) {
  try {
    State.audioCtx = State.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = State.audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const base = ctx.currentTime + 0.01;
    steps.forEach((s) => {
      const start = base + (s.delay || 0);
      const dur = s.dur || 0.18;
      const vol = s.vol || 0.12;
      const holdPoint = start + dur * (s.hold || 0.35);

      const gain = ctx.createGain();
      gain.gain.setValueAtTime(0.001, start);
      gain.gain.linearRampToValueAtTime(vol, start + 0.02);
      if (s.hold) {
        gain.gain.setValueAtTime(vol, holdPoint);
      }
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
      gain.connect(ctx.destination);

      const detunes = s.detune ? [-s.detune, s.detune] : [0];
      detunes.forEach((dt) => {
        const osc = ctx.createOscillator();
        osc.type = s.type || 'sine';
        osc.detune.setValueAtTime(dt, start);
        osc.frequency.setValueAtTime(s.freq, start);
        if (s.peakFreq) {
          const peakTime = start + dur * (s.peakAt || 0.5);
          osc.frequency.exponentialRampToValueAtTime(s.peakFreq, peakTime);
          if (s.endFreq) {
            osc.frequency.exponentialRampToValueAtTime(s.endFreq, start + dur);
          }
        } else if (s.endFreq) {
          osc.frequency.linearRampToValueAtTime(s.endFreq, start + dur);
        }
        osc.connect(gain);
        osc.start(start);
        osc.stop(start + dur + 0.02);
      });
    });
  } catch (err) {
    console.warn('Audio no disponible', err);
  }
}

function playAlertSound(level, overridePreset = null) {
  const lvl = SOUND_GALLERY[level] ? level : 'PREVENTIVA';
  const preset = overridePreset && SOUND_GALLERY[lvl][overridePreset]
    ? overridePreset
    : getSoundPreset(lvl);
  playToneSequence(SOUND_GALLERY[lvl][preset]);
}

function beep(freq, duration) {
  playToneSequence([{ delay: 0, freq, dur: duration, type: 'sine', vol: 0.11 }]);
}

function closeSoundGallery() {
  const pop = $('sound-gallery-popover');
  const btn = $('btn-sound-gallery');
  if (pop) pop.classList.add('hidden');
  if (btn) btn.setAttribute('aria-expanded', 'false');
}

function initSoundGallery() {
  const btn = $('btn-sound-gallery');
  const pop = $('sound-gallery-popover');
  const wrap = $('sound-control-wrap');
  if (!btn || !pop || !wrap) return;

  pop.querySelectorAll('.sound-preset-select').forEach((sel) => {
    const lvl = sel.dataset.soundLevel;
    sel.value = getSoundPreset(lvl);
    sel.addEventListener('change', () => {
      setSoundPreset(lvl, sel.value);
      playAlertSound(lvl, sel.value);
    });
  });

  pop.querySelectorAll('.btn-sound-test').forEach((testBtn) => {
    testBtn.addEventListener('click', () => {
      const lvl = testBtn.dataset.testSound;
      playAlertSound(lvl);
      testBtn.classList.add('playing');
      setTimeout(() => testBtn.classList.remove('playing'), 550);
    });
  });

  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const opening = pop.classList.contains('hidden');
    pop.classList.toggle('hidden', !opening);
    btn.setAttribute('aria-expanded', String(opening));
  });

  document.addEventListener('click', (e) => {
    if (!wrap.contains(e.target)) closeSoundGallery();
  });
}

function checkNewAlerts() {
  syncNotifyButton();
  const ids = new Set(State.alertas.map((a) => a.id));
  if (State.knownAlertIds) {
    const nuevas = State.alertas.filter((a) => !State.knownAlertIds.has(a.id));
    if (nuevas.length) {
      toast(`Nueva alerta: ${nuevas[0].nombre}${nuevas.length > 1 ? ` (+${nuevas.length - 1})` : ''}`, 'error');
      sendBrowserAlertNotification(nuevas);
      if (State.soundEnabled) {
        const topLevel = nuevas.some((a) => a.nivel_alerta === 'CRITICO')
          ? 'CRITICO'
          : (nuevas.some((a) => a.nivel_alerta === 'ADVERTENCIA') ? 'ADVERTENCIA' : 'PREVENTIVA');
        playAlertSound(topLevel);
      }
    }
  }
  State.knownAlertIds = ids;
}

/* ----------------------------------------------------------------- historial temporal (30 días) */
const HIST_SVG_NS = 'http://www.w3.org/2000/svg';
const HIST_LEVEL_COLOR = { CRITICO: '#f43f5e', ADVERTENCIA: '#f59e0b', PREVENTIVA: '#38bdf8' };
const HIST_SERIES_COLORS = ['#22d3ee', '#f43f5e', '#f59e0b', '#38bdf8', '#10b981', '#a78bfa', '#fb7185', '#fde047'];
const HIST_PERIOD_LABEL = { '24h': '24 h', '7d': '7 días', '30d': '30 días' };

function svgEl(tag, attrs = {}, ...children) {
  const node = document.createElementNS(HIST_SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined) continue;
    node.setAttribute(k, String(v));
  }
  for (const c of children) {
    if (c === null || c === undefined) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

function formatAxisTime(ms, period) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  if (period === '24h') return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return `${d.getDate()}/${d.getMonth() + 1}`;
}

function formatReadoutTime(fechaStr, ms) {
  const d = fechaStr ? new Date(String(fechaStr).trim().replace(' ', 'T')) : new Date(ms);
  if (Number.isNaN(d.getTime())) return String(fechaStr || '--');
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function openHistoryModal(preselectCode = null) {
  State.historyPeriod = '24h';
  State.historyStation = preselectCode ? String(preselectCode) : '__ALL__';
  document.querySelectorAll('#history-periods [data-period]').forEach((b) => {
    b.classList.toggle('active', b.dataset.period === State.historyPeriod);
  });
  document.querySelectorAll('#history-level-filter [data-level]').forEach((b) => {
    b.classList.toggle('active', b.dataset.level === State.historyLevel);
  });
  $('modal-history').classList.remove('hidden');
  $('history-close').focus();
  loadAndRenderHistory();
}

function closeHistoryModal() {
  $('modal-history').classList.add('hidden');
}

async function loadAndRenderHistory() {
  const chartBox = $('history-chart-box');
  chartBox.replaceChildren(el('div', { class: 'history-empty' }, icon('fa-solid fa-spinner fa-spin'), 'Cargando historial de alertas...'));
  try {
    const url = `/api/alertas/historial?periodo=${encodeURIComponent(State.historyPeriod)}&nivel=${encodeURIComponent(State.historyLevel)}`;
    const data = await api(url);
    State.historyData = data;
    renderHistoryView();
  } catch (err) {
    chartBox.replaceChildren(el('div', { class: 'history-empty' }, icon('fa-solid fa-circle-exclamation'), `No se pudo cargar el historial: ${err.message}`));
  }
}

function renderHistoryView() {
  const data = State.historyData || {};
  const stations = Array.isArray(data.stations) ? data.stations : [];
  if (State.historyLevel === 'ALL') {
    const hb = $('history-badge');
    if (hb) hb.textContent = stations.length;
  }

  const select = $('history-station-select');
  select.replaceChildren();
  select.append(el('option', { value: '__ALL__', text: `Todas las estaciones (${stations.length})` }));
  stations.forEach((st) => {
    const lvlTxt = LEVEL_LABEL[st.last_nivel] || st.last_nivel;
    select.append(el('option', {
      value: st.codigo,
      text: `[${lvlTxt}] ${st.nombre} (${st.stats ? st.stats.count : 0} reg.)`,
    }));
  });

  const hasCurrent = State.historyStation === '__ALL__' || stations.some((s) => s.codigo === State.historyStation);
  if (!hasCurrent) {
    State.historyStation = '__ALL__';
  }
  select.value = State.historyStation;

  const chipsBox = $('history-station-chips');
  chipsBox.replaceChildren();
  if (stations.length > 0) {
    chipsBox.classList.remove('hidden');
    const allChip = el('button', {
      class: `history-chip${State.historyStation === '__ALL__' ? ' active' : ''}`,
      type: 'button',
    }, el('span', { class: 'type-dot' }), el('span', { text: `Todas (${stations.length})` }));
    allChip.addEventListener('click', () => { State.historyStation = '__ALL__'; renderHistoryView(); });
    chipsBox.append(allChip);

    stations.slice(0, 14).forEach((st) => {
      const dotCls = levelClass(st.last_nivel);
      const chip = el('button', {
        class: `history-chip${State.historyStation === st.codigo ? ' active' : ''}`,
        type: 'button',
        title: `${st.nombre} · Último: ${fmt(st.last_valor, 3)} ${st.unidad}`,
      },
      el('span', { class: `type-dot dot-${dotCls}` }),
      el('span', { text: st.nombre }));
      chip.addEventListener('click', () => { State.historyStation = st.codigo; renderHistoryView(); });
      chipsBox.append(chip);
    });
  } else {
    chipsBox.classList.add('hidden');
  }

  const periodLabel = HIST_PERIOD_LABEL[State.historyPeriod] || State.historyPeriod;
  const winEndMs = parseAlertTimestamp(data.window_end) || Date.now();
  const winDays = State.historyPeriod === '24h' ? 1 : (State.historyPeriod === '7d' ? 7 : 30);
  const winStartMs = parseAlertTimestamp(data.window_start) || (winEndMs - winDays * 86400000);

  if (stations.length === 0) {
    $('history-panel').className = 'history-panel accent-normal';
    $('history-title').textContent = 'Registro histórico de alertas';
    $('history-level-badge').className = 'badge hidden';
    $('history-level-badge').textContent = '';
    $('history-subtitle').textContent = `Sin alertas Críticas, Advertencia o Preventiva guardadas en los últimos ${periodLabel}.`;
    $('history-stats').replaceChildren();
    $('history-chart-box').replaceChildren(el('div', { class: 'history-empty' },
      icon('fa-solid fa-chart-area'),
      `Aún no hay mediciones guardadas para este filtro en ${periodLabel}. Se almacenarán automáticamente cada vez que la DGA reporte alertas.`));
    $('history-hover-readout').textContent = '--';
    $('history-legend').replaceChildren();
    $('history-log-list').replaceChildren(el('div', { class: 'history-stats-muted', text: 'Sin eventos registrados en este rango.' }));
    return;
  }

  if (State.historyStation === '__ALL__') {
    renderMultiStationHistory(stations, winStartMs, winEndMs, periodLabel);
  } else {
    const st = stations.find((s) => s.codigo === State.historyStation) || stations[0];
    renderSingleStationHistory(st, winStartMs, winEndMs, periodLabel);
  }
}

function renderSingleStationHistory(st, winStartMs, winEndMs, periodLabel) {
  const lvlCls = levelClass(st.last_nivel);
  $('history-panel').className = `history-panel accent-${lvlCls}`;
  $('history-title').textContent = st.nombre;
  const lvlBadge = $('history-level-badge');
  lvlBadge.className = `badge badge-${lvlCls}`;
  lvlBadge.textContent = LEVEL_LABEL[st.last_nivel] || st.last_nivel;
  $('history-subtitle').textContent = [
    `Código ${st.codigo}`,
    st.comuna,
    st.region_nombre,
    st.fuente,
  ].filter(Boolean).join(' · ');

  const stats = st.stats || {};
  const unit = st.unidad || '';
  const statsBox = $('history-stats');
  if (stats.count > 0) {
    statsBox.replaceChildren(
      el('div', {},
        `Mín ${fmt(stats.min, 3)} · Máx ${fmt(stats.max, 3)} · Último ${fmt(stats.last, 3)} ${unit}`),
      el('div', {
        class: 'history-stats-muted',
        text: `${stats.count} reg. en ${periodLabel} (${stats.count_30d} en 30d)`,
      }),
    );
  } else {
    statsBox.replaceChildren(
      el('div', { class: 'history-stats-muted', text: `0 registros en las últimas ${periodLabel} (${stats.count_30d || 0} en 30d)` }),
    );
  }

  const pts = (st.points || []).filter((p) => typeof p.valor === 'number' && Number.isFinite(p.valor));
  const chartBox = $('history-chart-box');
  const legendBox = $('history-legend');
  const readoutEl = $('history-hover-readout');
  legendBox.replaceChildren();

  if (pts.length === 0) {
    chartBox.replaceChildren(el('div', { class: 'history-empty' },
      icon('fa-regular fa-clock'),
      `Esta estación no registró alertas en ${periodLabel}. Prueba cambiar a "7 días" o "30 días".`));
    readoutEl.textContent = st.last_fecha ? `Último registrado: ${formatReadoutTime(st.last_fecha)} · ${fmt(st.last_valor, 3)} ${unit}` : '--';
    renderHistoryLog([st]);
    return;
  }

  const umb = st.umbrales || {};
  const threshLines = [];
  if (typeof umb.CRITICO === 'number') threshLines.push({ val: umb.CRITICO, label: `Alerta roja (${fmt(umb.CRITICO, 2)})`, color: '#f43f5e' });
  if (typeof umb.ADVERTENCIA === 'number') threshLines.push({ val: umb.ADVERTENCIA, label: `Alerta amarilla (${fmt(umb.ADVERTENCIA, 2)})`, color: '#f59e0b' });
  if (typeof umb.PREVENTIVA === 'number') threshLines.push({ val: umb.PREVENTIVA, label: `Alerta azul (${fmt(umb.PREVENTIVA, 2)})`, color: '#38bdf8' });

  const allVals = pts.map((p) => p.valor).concat(threshLines.map((t) => t.val));
  const rawMin = Math.min(...allVals);
  const rawMax = Math.max(...allVals);
  const span = Math.max(0.2, rawMax - rawMin);
  const yMin = rawMin >= 0 ? Math.max(0, rawMin - span * 0.25) : rawMin - span * 0.2;
  const yMax = rawMax + span * 0.22;

  const W = 720;
  const H = 248;
  const padL = 52;
  const padR = 16;
  const padT = 16;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const tSpan = Math.max(60000, winEndMs - winStartMs);
  const xFor = (ms) => padL + Math.max(0, Math.min(1, (ms - winStartMs) / tSpan)) * plotW;
  const yFor = (val) => padT + (1 - (val - yMin) / Math.max(0.0001, yMax - yMin)) * plotH;

  const svg = svgEl('svg', { class: 'history-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': `Evolución de ${st.nombre}` });
  const defs = svgEl('defs');
  const grad = svgEl('linearGradient', { id: 'histAreaGrad', x1: '0', y1: '0', x2: '0', y2: '1' },
    svgEl('stop', { offset: '0%', 'stop-color': '#22d3ee', 'stop-opacity': '0.32' }),
    svgEl('stop', { offset: '100%', 'stop-color': '#22d3ee', 'stop-opacity': '0.02' }));
  const tankGradFront = svgEl('linearGradient', { id: 'histTankGradFront', x1: '0', y1: '0', x2: '0', y2: '1' },
    svgEl('stop', { offset: '0%', 'stop-color': '#00e5ff', 'stop-opacity': '0.28' }),
    svgEl('stop', { offset: '100%', 'stop-color': '#0284c7', 'stop-opacity': '0.08' }));
  const tankGradBack = svgEl('linearGradient', { id: 'histTankGradBack', x1: '0', y1: '0', x2: '0', y2: '1' },
    svgEl('stop', { offset: '0%', 'stop-color': '#38bdf8', 'stop-opacity': '0.18' }),
    svgEl('stop', { offset: '100%', 'stop-color': '#0369a1', 'stop-opacity': '0.04' }));
  const tankClip = svgEl('clipPath', { id: 'histTankClip' },
    svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH }));
  defs.append(grad, tankGradFront, tankGradBack, tankClip);
  svg.append(defs);

  const coords = pts.map((p) => {
    const ms = Number(p.ts) * 1000 || parseAlertTimestamp(p.fecha) || winEndMs;
    return { ...p, ms, x: xFor(ms), y: yFor(p.valor) };
  });
  const lastC = coords[coords.length - 1];

  // Animación de nivel de agua tipo estanque hasta el último valor medido
  const buildWavePath = (baseY, amp, cycles) => {
    const totalW = plotW * 2;
    const step = totalW / (cycles * 2);
    let d = `M ${padL} ${baseY.toFixed(1)}`;
    for (let i = 0; i < cycles * 2; i += 1) {
      const x1 = padL + i * step + step * 0.5;
      const x2 = padL + (i + 1) * step;
      const cy = i % 2 === 0 ? baseY - amp : baseY + amp;
      d += ` Q ${x1.toFixed(1)} ${cy.toFixed(1)}, ${x2.toFixed(1)} ${baseY.toFixed(1)}`;
    }
    d += ` L ${(padL + totalW).toFixed(1)} ${(H - padB).toFixed(1)} L ${padL} ${(H - padB).toFixed(1)} Z`;
    return d;
  };
  const tankGroup = svgEl('g', { 'clip-path': 'url(#histTankClip)' },
    svgEl('path', { class: 'water-wave-back', d: buildWavePath(lastC.y + 1.5, 5, 4), fill: 'url(#histTankGradBack)' }),
    svgEl('path', { class: 'water-wave-front', d: buildWavePath(lastC.y, 4, 4), fill: 'url(#histTankGradFront)' }));
  svg.append(tankGroup);

  // Horizontal grid + Y ticks
  for (let i = 0; i <= 4; i += 1) {
    const val = yMin + ((yMax - yMin) * i) / 4;
    const y = yFor(val);
    svg.append(
      svgEl('line', { class: 'chart-grid-line', x1: padL, y1: y, x2: W - padR, y2: y }),
      svgEl('text', { class: 'chart-axis-text', x: padL - 7, y: y + 3, 'text-anchor': 'end' }, fmt(val, 2)),
    );
  }

  // Vertical time grid + X ticks
  const ticks = 5;
  for (let i = 0; i <= ticks; i += 1) {
    const ms = winStartMs + (tSpan * i) / ticks;
    const x = xFor(ms);
    svg.append(
      svgEl('line', { class: 'chart-grid-line', x1: x, y1: padT, x2: x, y2: H - padB }),
      svgEl('text', { class: 'chart-axis-text', x, y: H - 10, 'text-anchor': i === 0 ? 'start' : (i === ticks ? 'end' : 'middle') }, formatAxisTime(ms, State.historyPeriod)),
    );
  }

  // Threshold dashed lines with anti-overlap label placement
  const sortedThresh = [...threshLines].sort((a, b) => b.val - a.val);
  let lastLabelY = -999;
  sortedThresh.forEach((t) => {
    const y = yFor(t.val);
    let labelY = y - 4;
    if (Math.abs(labelY - lastLabelY) < 12) labelY = lastLabelY + 12;
    lastLabelY = labelY;
    svg.append(
      svgEl('line', { class: 'chart-thresh-line', x1: padL, y1: y, x2: W - padR, y2: y, stroke: t.color }),
      svgEl('text', { class: 'chart-thresh-label', x: W - padR - 2, y: Math.max(padT + 10, labelY), fill: t.color, 'text-anchor': 'end' }, t.label),
    );
  });

  if (coords.length >= 2) {
    const lineD = coords.map((c, idx) => `${idx === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
    const areaD = `${lineD} L ${coords[coords.length - 1].x.toFixed(1)} ${(H - padB).toFixed(1)} L ${coords[0].x.toFixed(1)} ${(H - padB).toFixed(1)} Z`;
    svg.append(
      svgEl('path', { d: areaD, fill: 'url(#histAreaGrad)' }),
      svgEl('path', { d: lineD, fill: 'none', stroke: '#22d3ee', 'stroke-width': '2.4', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }),
    );
  } else {
    const only = coords[0];
    svg.append(
      svgEl('line', { x1: padL, y1: only.y, x2: W - padR, y2: only.y, stroke: 'rgba(34, 211, 238, 0.25)', 'stroke-dasharray': '2 4' }),
      svgEl('circle', { cx: only.x, cy: only.y, r: 9, fill: 'rgba(34, 211, 238, 0.2)' }),
    );
  }

  coords.forEach((c) => {
    const col = HIST_LEVEL_COLOR[c.nivel] || '#22d3ee';
    svg.append(svgEl('circle', { class: 'chart-point-dot', cx: c.x, cy: c.y, r: coords.length > 40 ? 2.5 : 4, fill: col, stroke: '#060a10', 'stroke-width': '1.2' }));
  });

  const crosshair = svgEl('line', { class: 'chart-crosshair', x1: lastC.x, y1: padT, x2: lastC.x, y2: H - padB });
  const focusRing = svgEl('circle', { cx: lastC.x, cy: lastC.y, r: 6.5, fill: 'none', stroke: '#f8fafc', 'stroke-width': '2' });
  const focusDot = svgEl('circle', { cx: lastC.x, cy: lastC.y, r: 4, fill: HIST_LEVEL_COLOR[lastC.nivel] || '#22d3ee' });
  svg.append(crosshair, focusRing, focusDot);

  const showPoint = (c) => {
    crosshair.setAttribute('x1', c.x);
    crosshair.setAttribute('x2', c.x);
    focusRing.setAttribute('cx', c.x);
    focusRing.setAttribute('cy', c.y);
    focusDot.setAttribute('cx', c.x);
    focusDot.setAttribute('cy', c.y);
    focusDot.setAttribute('fill', HIST_LEVEL_COLOR[c.nivel] || '#22d3ee');
    const lvlTxt = LEVEL_LABEL[c.nivel] || c.nivel;
    readoutEl.textContent = `${formatReadoutTime(c.fecha, c.ms)} · ${fmt(c.valor, 3)} ${c.unidad || unit} · ${lvlTxt}${c.umbral != null ? ` (umbral ${fmt(c.umbral, 2)})` : ''}`;
  };
  showPoint(lastC);

  const hit = svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent' });
  const onPointer = (ev) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const vx = ((ev.clientX - rect.left) / rect.width) * W;
    let best = coords[0];
    let bestDist = Infinity;
    coords.forEach((c) => {
      const d = Math.abs(c.x - vx);
      if (d < bestDist) { bestDist = d; best = c; }
    });
    showPoint(best);
  };
  hit.addEventListener('pointermove', onPointer);
  hit.addEventListener('pointerdown', onPointer);
  hit.addEventListener('pointerleave', () => showPoint(lastC));
  svg.append(hit);

  chartBox.replaceChildren(svg);
  threshLines.forEach((t) => {
    legendBox.append(el('span', { class: 'legend-chip' },
      el('span', { class: 'legend-swatch', style: `background:${t.color}` }),
      t.label));
  });
  renderHistoryLog([st]);
}

function appendWaterTankWaves(svg, { padL, padT, plotW, plotH, H, padB, surfaceY, idPrefix }) {
  const defs = svgEl('defs');
  const frontId = `${idPrefix}TankFront`;
  const backId = `${idPrefix}TankBack`;
  const clipId = `${idPrefix}TankClip`;
  defs.append(
    svgEl('linearGradient', { id: frontId, x1: '0', y1: '0', x2: '0', y2: '1' },
      svgEl('stop', { offset: '0%', 'stop-color': '#00e5ff', 'stop-opacity': '0.26' }),
      svgEl('stop', { offset: '100%', 'stop-color': '#0284c7', 'stop-opacity': '0.07' })),
    svgEl('linearGradient', { id: backId, x1: '0', y1: '0', x2: '0', y2: '1' },
      svgEl('stop', { offset: '0%', 'stop-color': '#38bdf8', 'stop-opacity': '0.16' }),
      svgEl('stop', { offset: '100%', 'stop-color': '#0369a1', 'stop-opacity': '0.03' })),
    svgEl('clipPath', { id: clipId },
      svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH })),
  );
  svg.append(defs);

  const buildWavePath = (baseY, amp, cycles) => {
    const totalW = plotW * 2;
    const step = totalW / (cycles * 2);
    let d = `M ${padL} ${baseY.toFixed(1)}`;
    for (let i = 0; i < cycles * 2; i += 1) {
      const x1 = padL + i * step + step * 0.5;
      const x2 = padL + (i + 1) * step;
      const cy = i % 2 === 0 ? baseY - amp : baseY + amp;
      d += ` Q ${x1.toFixed(1)} ${cy.toFixed(1)}, ${x2.toFixed(1)} ${baseY.toFixed(1)}`;
    }
    d += ` L ${(padL + totalW).toFixed(1)} ${(H - padB).toFixed(1)} L ${padL} ${(H - padB).toFixed(1)} Z`;
    return d;
  };
  svg.append(svgEl('g', { 'clip-path': `url(#${clipId})` },
    svgEl('path', { class: 'water-wave-back', d: buildWavePath(surfaceY + 1.5, 5, 4), fill: `url(#${backId})` }),
    svgEl('path', { class: 'water-wave-front', d: buildWavePath(surfaceY, 4, 4), fill: `url(#${frontId})` })));
}

function renderMultiStationHistory(stations, winStartMs, winEndMs, periodLabel) {
  $('history-panel').className = 'history-panel accent-normal';
  $('history-title').textContent = 'Evolución comparativa de estaciones';
  $('history-level-badge').className = 'badge hidden';
  $('history-level-badge').textContent = '';
  $('history-subtitle').textContent = `${stations.length} estaciones en el registro · últimos ${periodLabel}`;

  const active = stations.filter((s) => s.points && s.points.some((p) => typeof p.valor === 'number'));
  const totPts = active.reduce((acc, s) => acc + s.points.length, 0);
  const totCrit = active.reduce((acc, s) => acc + ((s.stats && s.stats.critico_count) || 0), 0);
  const totWarn = active.reduce((acc, s) => acc + ((s.stats && s.stats.advertencia_count) || 0), 0);
  const totPrev = active.reduce((acc, s) => acc + ((s.stats && s.stats.preventiva_count) || 0), 0);

  $('history-stats').replaceChildren(
    el('div', {}, `Estaciones con alertas: ${active.length}/${stations.length} · Críticas: ${totCrit} · Advertencias: ${totWarn} · Preventivas: ${totPrev}`),
    el('div', { class: 'history-stats-muted', text: `${totPts} registros en ${periodLabel}` }),
  );

  const chartBox = $('history-chart-box');
  const legendBox = $('history-legend');
  const readoutEl = $('history-hover-readout');
  legendBox.replaceChildren();

  if (active.length === 0) {
    chartBox.replaceChildren(el('div', { class: 'history-empty' },
      icon('fa-regular fa-clock'),
      `Sin lecturas en las últimas ${periodLabel}. Prueba ampliar a 7 días o 30 días.`));
    readoutEl.textContent = '--';
    renderHistoryLog(stations);
    return;
  }

  const shown = active.slice(0, 8);
  const units = new Set(shown.map((s) => s.unidad || 'm'));
  const mixedUnits = units.size > 1;
  const commonUnit = mixedUnits ? '%' : Array.from(units)[0];

  const getYVal = (s, p) => {
    if (!mixedUnits) return p.valor;
    const u = p.umbral || s.last_umbral || 1;
    return u > 0 ? (p.valor / u) * 100 : p.valor;
  };

  const allY = [];
  shown.forEach((s) => s.points.forEach((p) => {
    if (typeof p.valor === 'number') allY.push(getYVal(s, p));
  }));
  if (mixedUnits) allY.push(100);
  const rawMin = Math.min(...allY);
  const rawMax = Math.max(...allY);
  const span = Math.max(0.2, rawMax - rawMin);
  const yMin = rawMin >= 0 ? Math.max(0, rawMin - span * 0.2) : rawMin - span * 0.15;
  const yMax = rawMax + span * 0.2;

  const W = 720;
  const H = 248;
  const padL = 52;
  const padR = 16;
  const padT = 16;
  const padB = 30;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const tSpan = Math.max(60000, winEndMs - winStartMs);
  const xFor = (ms) => padL + Math.max(0, Math.min(1, (ms - winStartMs) / tSpan)) * plotW;
  const yFor = (val) => padT + (1 - (val - yMin) / Math.max(0.0001, yMax - yMin)) * plotH;

  const svg = svgEl('svg', { class: 'history-svg', viewBox: `0 0 ${W} ${H}`, role: 'img', 'aria-label': 'Evolución comparativa de estaciones' });
  const latestVals = shown
    .map((s) => {
      const validPts = s.points.filter((p) => typeof p.valor === 'number');
      return validPts.length ? getYVal(s, validPts[validPts.length - 1]) : null;
    })
    .filter((v) => v !== null);
  const avgLatest = latestVals.length
    ? latestVals.reduce((acc, v) => acc + v, 0) / latestVals.length
    : (yMin + yMax) / 2;
  appendWaterTankWaves(svg, {
    padL,
    padT,
    plotW,
    plotH,
    H,
    padB,
    surfaceY: yFor(avgLatest),
    idPrefix: 'histMulti',
  });
  for (let i = 0; i <= 4; i += 1) {
    const val = yMin + ((yMax - yMin) * i) / 4;
    const y = yFor(val);
    svg.append(
      svgEl('line', { class: 'chart-grid-line', x1: padL, y1: y, x2: W - padR, y2: y }),
      svgEl('text', { class: 'chart-axis-text', x: padL - 7, y: y + 3, 'text-anchor': 'end' }, mixedUnits ? `${Math.round(val)}%` : fmt(val, 2)),
    );
  }
  for (let i = 0; i <= 5; i += 1) {
    const ms = winStartMs + (tSpan * i) / 5;
    const x = xFor(ms);
    svg.append(
      svgEl('line', { class: 'chart-grid-line', x1: x, y1: padT, x2: x, y2: H - padB }),
      svgEl('text', { class: 'chart-axis-text', x, y: H - 10, 'text-anchor': i === 0 ? 'start' : (i === 5 ? 'end' : 'middle') }, formatAxisTime(ms, State.historyPeriod)),
    );
  }
  if (mixedUnits) {
    const y100 = yFor(100);
    svg.append(
      svgEl('line', { class: 'chart-thresh-line', x1: padL, y1: y100, x2: W - padR, y2: y100, stroke: '#f59e0b' }),
      svgEl('text', { class: 'chart-thresh-label', x: W - padR - 2, y: y100 - 4, fill: '#f59e0b', 'text-anchor': 'end' }, '100% umbral'),
    );
  }

  const flatPoints = [];
  shown.forEach((s, idx) => {
    const color = HIST_SERIES_COLORS[idx % HIST_SERIES_COLORS.length];
    const pts = s.points
      .filter((p) => typeof p.valor === 'number')
      .map((p) => {
        const ms = Number(p.ts) * 1000 || parseAlertTimestamp(p.fecha) || winEndMs;
        return { ...p, station: s, color, ms, x: xFor(ms), y: yFor(getYVal(s, p)) };
      });
    if (pts.length >= 2) {
      const d = pts.map((c, j) => `${j === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`).join(' ');
      svg.append(svgEl('path', { d, fill: 'none', stroke: color, 'stroke-width': '2', 'stroke-linecap': 'round' }));
    }
    pts.forEach((c) => {
      svg.append(svgEl('circle', { cx: c.x, cy: c.y, r: 4, fill: color, stroke: '#060a10', 'stroke-width': '1.2' }));
      flatPoints.push(c);
    });

    const chip = el('button', { class: 'legend-chip', type: 'button', title: `Ver detalle de ${s.nombre}` },
      el('span', { class: 'legend-swatch', style: `background:${color}` }),
      s.nombre);
    chip.addEventListener('click', () => { State.historyStation = s.codigo; renderHistoryView(); });
    legendBox.append(chip);
  });

  const lastPt = flatPoints[flatPoints.length - 1];
  const crosshair = svgEl('line', { class: 'chart-crosshair', x1: lastPt.x, y1: padT, x2: lastPt.x, y2: H - padB });
  const focusRing = svgEl('circle', { cx: lastPt.x, cy: lastPt.y, r: 7, fill: 'none', stroke: '#f8fafc', 'stroke-width': '2' });
  svg.append(crosshair, focusRing);

  const showPt = (c) => {
    crosshair.setAttribute('x1', c.x);
    crosshair.setAttribute('x2', c.x);
    focusRing.setAttribute('cx', c.x);
    focusRing.setAttribute('cy', c.y);
    readoutEl.textContent = `${c.station.nombre} · ${formatReadoutTime(c.fecha, c.ms)} · ${fmt(c.valor, 3)} ${c.unidad || c.station.unidad || commonUnit} · ${LEVEL_LABEL[c.nivel] || c.nivel}`;
  };
  showPt(lastPt);

  const hit = svgEl('rect', { x: padL, y: padT, width: plotW, height: plotH, fill: 'transparent' });
  const onPointer = (ev) => {
    const rect = svg.getBoundingClientRect();
    if (!rect.width) return;
    const vx = ((ev.clientX - rect.left) / rect.width) * W;
    const vy = ((ev.clientY - rect.top) / rect.height) * H;
    let best = flatPoints[0];
    let bestDist = Infinity;
    flatPoints.forEach((c) => {
      const d = Math.hypot(c.x - vx, (c.y - vy) * 0.45);
      if (d < bestDist) { bestDist = d; best = c; }
    });
    showPt(best);
  };
  hit.addEventListener('pointermove', onPointer);
  hit.addEventListener('pointerdown', onPointer);
  hit.addEventListener('pointerleave', () => showPt(lastPt));
  svg.append(hit);

  chartBox.replaceChildren(svg);
  renderHistoryLog(stations);
}

function renderHistoryLog(stations) {
  const list = $('history-log-list');
  const rows = [];
  stations.forEach((st) => {
    (st.points || []).forEach((p) => {
      rows.push({
        ts: Number(p.ts) || 0,
        fecha: p.fecha,
        nombre: st.nombre,
        nivel: p.nivel,
        valor: p.valor,
        umbral: p.umbral,
        unidad: p.unidad || st.unidad || '',
        fuente: p.fuente || st.fuente || '',
      });
    });
  });
  rows.sort((a, b) => (b.ts - a.ts) || ((ALERT_SEVERITY[b.nivel] || 0) - (ALERT_SEVERITY[a.nivel] || 0)));

  if (rows.length === 0) {
    list.replaceChildren(el('div', { class: 'history-stats-muted', text: 'Sin eventos registrados en esta ventana de tiempo.' }));
    return;
  }

  const frag = document.createDocumentFragment();
  rows.slice(0, 60).forEach((r) => {
    const rightTxt = `${LEVEL_LABEL[r.nivel] || r.nivel} · ${fmt(r.valor, 3)} ${r.unidad}${r.umbral != null ? ` / ${fmt(r.umbral, 2)}` : ''}`;
    frag.append(el('div', { class: `history-log-row ${r.nivel}` },
      el('div', { class: 'history-log-left' },
        el('span', { class: 'history-log-date', text: formatReadoutTime(r.fecha, r.ts * 1000) }),
        el('span', { class: 'history-log-name', text: r.nombre })),
      el('div', { class: 'history-log-right', text: rightTxt })));
  });
  list.replaceChildren(frag);
}

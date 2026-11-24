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
  audioCtx: null,
  knownAlertIds: null,
  pollTimer: null,
  loadingRegion: false,
  requestSeq: 0,
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

/* ----------------------------------------------------------------- init */
document.addEventListener('DOMContentLoaded', () => {
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
    const v = REGION_VIEW[State.region] || REGION_VIEW['13'];
    State.map.setView([v[0], v[1]], v[2]);
    State.estaciones = [];
    render();
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
      render();
    }, 200);
  });

  document.querySelectorAll('.tab-btn').forEach((btn) => btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach((c) => c.classList.remove('active'));
    btn.classList.add('active');
    $(btn.dataset.tab).classList.add('active');
  }));

  $('btn-sync').addEventListener('click', forceSync);
  $('btn-sound').addEventListener('click', toggleSound);
  $('modal-close').addEventListener('click', closeModal);
  $('modal-station').addEventListener('click', (e) => { if (e.target.id === 'modal-station') closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
  $('form-threshold').addEventListener('submit', saveThreshold);

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
    const [summary, embalses, estaciones, alertas, umbrales] = await Promise.all([
      api('/api/summary'),
      api('/api/embalses'),
      api(`/api/estaciones?region=${encodeURIComponent(State.region)}`),
      api('/api/alertas'),
      api('/api/umbrales').catch(() => null),
    ]);
    if (seq !== State.requestSeq) return;      // respuesta obsoleta (cambió la región)

    const estList = Array.isArray(estaciones) ? estaciones : (Array.isArray(estaciones && estaciones.items) ? estaciones.items : []);
    State.embalses = Array.isArray(embalses) ? embalses : [];
    State.estaciones = estList;
    State.alertas = Array.isArray(alertas) ? alertas : [];
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

function updateDynamicKPIs(s) {
  const ests = State.estaciones.filter(matchesSearch);
  const embs = State.embalses.filter(matchesSearch);
  const alts = State.alertas.filter(matchesSearch);

  const activasConDato = ests.filter((e) => e.activa !== false && !e.sin_registro).length;
  const inactivasCount = ests.filter((e) => e.activa === false).length;
  const sinRegCount = ests.filter((e) => e.activa !== false && e.sin_registro).length;
  const inactivasOSinReg = inactivasCount + sinRegCount;

  const criticas = alts.filter((a) => a.nivel_alerta === 'CRITICO').length;
  const advertencias = alts.filter((a) => a.nivel_alerta === 'ADVERTENCIA').length;
  const preventivas = alts.filter((a) => a.nivel_alerta === 'PREVENTIVA').length;

  $('kpi-estaciones').textContent = activasConDato;
  $('kpi-estaciones-sub').textContent = `${ests.length} totales en vista`;
  $('kpi-inactivas').textContent = inactivasOSinReg;
  $('kpi-inactivas-sub').textContent = `${inactivasCount} inactivas · ${sinRegCount} sin caudal`;
  $('kpi-embalses').textContent = embs.length;
  $('kpi-criticas').textContent = criticas;
  $('kpi-advertencias').textContent = advertencias;
  $('kpi-preventivas').textContent = preventivas;
  $('alert-counter').textContent = alts.length;
  $('kpi-card-critico').classList.toggle('has-alerts', criticas > 0);

  if (s) {
    $('kpi-time').textContent = s.last_sync ? s.last_sync.split(' ')[1] : 'Pendiente';
    $('kpi-time').title = s.last_sync || '';
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
  document.querySelectorAll('.kpi-card[data-kpi-filter]').forEach((c) => {
    c.classList.toggle('active-kpi', State.filter !== 'all' && c.dataset.kpiFilter === State.filter);
  });
  const pillMatch = ['criticas', 'advertencias', 'preventivas'].includes(State.filter) ? 'alertas' : State.filter;
  document.querySelectorAll('.pill').forEach((p) => {
    p.classList.toggle('active', p.dataset.filter === pillMatch);
  });
  if (switchTab) {
    if (['criticas', 'advertencias', 'preventivas', 'alertas'].includes(State.filter)) activateSidebarTab('tab-alertas');
    else if (['rios', 'inactivas', 'embalses'].includes(State.filter)) activateSidebarTab('tab-estaciones');
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
  return {
    codigo: a.codigo,
    nombre: a.nombre,
    tipo: isEmb ? 'Embalse / Lago' : 'Fluviométrica (Río)',
    categoria: isEmb ? 'embalse' : 'estacion',
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
  const items = [];
  const seen = new Set();
  const push = (item) => {
    const key = `${item.categoria}:${item.codigo}`;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(item);
  };

  if (f === 'all' || f === 'embalses') {
    State.embalses.forEach((e) => {
      const lat = Number(e.lat), lng = Number(e.lng);
      if (validCoords(lat, lng)) push({ ...e, lat, lng, categoria: 'embalse' });
    });
  }

  if (f === 'all' || f === 'rios' || f === 'inactivas') {
    State.estaciones.forEach((e) => {
      const lat = Number(e.lat), lng = Number(e.lng);
      if (!validCoords(lat, lng)) return;
      const inactOrNoReg = e.activa === false || Boolean(e.sin_registro);
      if (f === 'rios' && inactOrNoReg) return;
      if (f === 'inactivas' && !inactOrNoReg) return;
      push({ ...e, lat, lng, categoria: 'estacion' });
    });
  }

  if (ALERT_FILTER_LEVELS[f]) {
    const targetLevels = ALERT_FILTER_LEVELS[f];
    State.embalses.forEach((e) => {
      const lat = Number(e.lat), lng = Number(e.lng);
      if (validCoords(lat, lng) && targetLevels.includes(e.estado)) push({ ...e, lat, lng, categoria: 'embalse' });
    });
    State.estaciones.forEach((e) => {
      const lat = Number(e.lat), lng = Number(e.lng);
      if (validCoords(lat, lng) && targetLevels.includes(e.estado)) push({ ...e, lat, lng, categoria: 'estacion' });
    });
    State.alertas.forEach((a) => {
      const lat = Number(a.lat), lng = Number(a.lng);
      if (validCoords(lat, lng) && targetLevels.includes(a.nivel_alerta)) push(alertAsMapItem(a));
    });
  }

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
  renderList(items);
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
  marker.bindPopup(() => buildPopup(item), { maxWidth: 280 });
  return marker;
}
const SEVERITY_Z = { CRITICO: 3000, ADVERTENCIA: 2000, PREVENTIVA: 1000 };

function buildPopup(item) {
  const isEmb = item.categoria === 'embalse';
  const details = el('div', { class: 'popup-details' });
  if (isEmb) {
    details.append(
      el('div', {}, el('strong', { text: 'Nivel: ' }), `${fmt(item.nivel)} m`),
      el('div', {}, el('strong', { text: 'Volumen: ' }), `${fmt(item.volumen)} Mm³`),
      el('div', {}, el('strong', { text: 'Medición: ' }), item.fecha || '--'),
    );
  } else {
    const c = item.ultimo_caudal;
    details.append(
      el('div', {}, el('strong', { text: 'Comuna: ' }), item.comuna || '--'),
      el('div', {}, el('strong', { text: 'Estado DGA: ' }), item.estado_estacion || 'Activa'),
      el('div', {}, el('strong', { text: 'Último caudal: ' }), c ? `${fmt(c.valor, 3)} m³/s (${c.fecha})` : 'Sin registro'),
    );
    if (item.alerta && item.alerta.fuente === 'DGA oficial') {
      details.append(el('div', { class: 'popup-alert' }, el('strong', { text: 'Alerta DGA: ' }),
        `valor ${fmt(item.alerta.valor_actual, 3)} / umbral ${fmt(item.alerta.umbral, 3)}`));
    }
  }
  const btn = el('button', { class: 'btn btn-primary popup-btn', type: 'button' }, 'Ver detalle y umbrales');
  btn.addEventListener('click', () => openModal(item));
  return el('div', { class: 'popup-box' },
    el('div', { class: `popup-badge ${levelClass(item.estado)}`, text: LEVEL_LABEL[item.estado] || item.estado }),
    el('h4', { text: item.nombre }),
    el('div', { class: 'popup-sub', text: `Código BNA: ${item.codigo}` }),
    details, btn);
}

function renderAlerts() {
  const box = $('alertas-list');
  box.replaceChildren();
  const targetLevels = ALERT_FILTER_LEVELS[State.filter] || null;
  const list = State.alertas.filter((a) => matchesSearch(a) && (!targetLevels || targetLevels.includes(a.nivel_alerta)));
  if (list.length === 0) {
    box.append(el('div', { class: 'empty-state' }, icon('fa-solid fa-circle-check ok-icon'),
      el('p', { text: State.alertas.length === 0 ? 'No hay alertas activas. Todas las estaciones monitoreadas están dentro de sus umbrales.' : 'No hay alertas que coincidan con el filtro seleccionado.' })));
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
  items
    .sort((a, b) => (SEVERITY_Z[b.estado] || 0) - (SEVERITY_Z[a.estado] || 0) || a.nombre.localeCompare(b.nombre, 'es'))
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
  const marker = State.markers.get(`${categoria}:${codigo}`);
  if (marker) {
    State.map.setView(marker.getLatLng(), Math.max(State.map.getZoom(), 11), { animate: true });
    marker.openPopup();
    return;
  }
  // Alerta oficial de una estación fuera de la región cargada: centrar en sus coordenadas
  if (validCoords(lat, lng)) {
    State.map.setView([lat, lng], 11, { animate: true });
    const a = State.alertas.find((x) => x.codigo === codigo);
    if (a) {
      L.popup().setLatLng([lat, lng]).setContent(el('div', { class: 'popup-box' },
        el('div', { class: `popup-badge ${levelClass(a.nivel_alerta)}`, text: LEVEL_LABEL[a.nivel_alerta] }),
        el('h4', { text: a.nombre }), el('div', { class: 'popup-sub', text: a.mensaje }))).openOn(State.map);
    }
    toast('La estación pertenece a otra región. Cambia el filtro de región para ver su detalle.');
  } else {
    toast('La estación no está visible con los filtros actuales.');
  }
}

/* ----------------------------------------------------------------- modal */
function setMetric(n, label, value, unit) {
  $(`lbl-val-${n}`).textContent = label;
  $(`val-met-${n}`).textContent = value;
  $(`unit-met-${n}`).textContent = unit;
}

async function openModal(item) {
  const isEmb = item.categoria === 'embalse';
  State.map.closePopup();
  $('modal-nombre').textContent = item.nombre;
  $('modal-codigo').textContent = `Código BNA: ${item.codigo} · ${item.comuna || item.region_nombre || 'Chile'}`;
  $('modal-badge-tipo').textContent = item.tipo;
  $('form-tipo').value = item.categoria;
  $('form-codigo').value = item.codigo;
  $('form-nombre').value = item.nombre;
  $('save-feedback').textContent = '';
  $('modal-stale').classList.add('hidden');

  let rule = {};
  let detail = item;
  try {
    const [cfg, det] = await Promise.all([
      api('/api/umbrales'),
      isEmb ? Promise.resolve(null) : api(`/api/estaciones/${encodeURIComponent(item.codigo)}`),
    ]);
    rule = (isEmb ? cfg.embalses : cfg.estaciones)[item.codigo] || {};
    if (det) detail = { ...item, ...det, alerta: det.alerta, estado: det.estado };
    var gen = cfg.general || {};
  } catch (err) {
    toast(`No se pudo cargar el detalle: ${err.message}`, 'error');
  }

  if (isEmb) {
    setMetric(1, 'Nivel de agua', fmt(item.nivel), 'metros');
    setMetric(2, 'Volumen almacenado', fmt(item.volumen), 'millones de m³');
    $('lbl-thresh-min').textContent = 'Volumen mínimo (déficit):';
    $('lbl-thresh-max').textContent = 'Volumen máximo (cota vertedero):';
    $('unit-addon-min').textContent = $('unit-addon-max').textContent = 'Mm³';
    $('input-thresh-min').value = rule.volumen_min ?? '';
    $('input-thresh-max').value = rule.volumen_max ?? '';
    $('input-thresh-min').placeholder = gen ? `Ej: ${gen.volumen_min_default ?? 20}` : '';
    $('input-thresh-max').placeholder = '';
    if (item.dias_desde_medicion === null || item.dias_desde_medicion > 365) {
      $('modal-stale-texto').textContent = `La DGA no publica mediciones recientes para este embalse (última: ${item.fecha || 'desconocida'}). No se generan alertas de umbral con datos de más de un año.`;
      $('modal-stale').classList.remove('hidden');
    }
  } else {
    const c = detail.ultimo_caudal;
    setMetric(1, 'Último caudal diario', c ? fmt(c.valor, 3) : '--', c ? `m³/s · ${c.fecha}` : 'sin dato publicado');
    const of = detail.alerta_oficial;
    setMetric(2, 'Valor alerta DGA', of ? fmt(of.valor, 3) : '--', of ? `umbral oficial ${fmt(of.umbral, 3)}` : 'sin alerta oficial activa');
    $('lbl-thresh-min').textContent = 'Caudal mínimo (estiaje):';
    $('lbl-thresh-max').textContent = 'Caudal máximo (crecida):';
    $('unit-addon-min').textContent = $('unit-addon-max').textContent = 'm³/s';
    $('input-thresh-min').value = rule.caudal_min ?? '';
    $('input-thresh-max').value = rule.caudal_max ?? '';
    $('input-thresh-min').placeholder = gen ? `Ej: ${gen.caudal_min_default ?? 0.5}` : '';
    $('input-thresh-max').placeholder = gen ? `Ej: ${gen.caudal_max_default ?? 60}` : '';
    if (c) {
      const dias = Math.floor((Date.now() - new Date(`${c.fecha}T00:00:00`).getTime()) / 86400000);
      if (dias > 7) {
        $('modal-stale-texto').textContent = `El último caudal diario validado por la DGA es del ${c.fecha} (hace ${dias} días). Los umbrales personalizados se evalúan sobre ese dato; las alertas DGA oficiales sí son en tiempo real.`;
        $('modal-stale').classList.remove('hidden');
      }
    }
  }

  const estado = detail.estado || 'NORMAL';
  $('val-estado').textContent = LEVEL_LABEL[estado] || estado;
  $('val-estado').className = `metric-num estado-${levelClass(estado)}`;
  $('val-subestado').textContent = detail.alerta ? detail.alerta.fuente : 'Dentro de umbrales';
  if (detail.alerta) {
    $('modal-alerta-texto').textContent = detail.alerta.mensaje;
    $('modal-alerta-banner').classList.remove('hidden');
  } else {
    $('modal-alerta-banner').classList.add('hidden');
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
        toast(`✓ Sincronización completada (${summary.last_sync || ''})`, 'ok');
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

function checkNewAlerts() {
  const ids = new Set(State.alertas.map((a) => a.id));
  if (State.knownAlertIds) {
    const nuevas = State.alertas.filter((a) => !State.knownAlertIds.has(a.id));
    if (nuevas.length) {
      toast(`Nueva alerta: ${nuevas[0].nombre}${nuevas.length > 1 ? ` (+${nuevas.length - 1})` : ''}`, 'error');
      if (State.soundEnabled) {
        const critica = nuevas.some((a) => a.nivel_alerta === 'CRITICO');
        beep(critica ? 880 : 620, 0.25);
        if (critica) setTimeout(() => beep(880, 0.25), 350);
      }
    }
  }
  State.knownAlertIds = ids;
}

function beep(freq, duration) {
  try {
    State.audioCtx = State.audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    const ctx = State.audioCtx;
    if (ctx.state === 'suspended') ctx.resume();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.12, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.connect(gain).connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + duration);
  } catch (err) {
    console.warn('Audio no disponible', err);
  }
}

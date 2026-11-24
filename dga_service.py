"""
Servicio de datos DGA Water Monitor.

Fuentes (obtenidas por ingeniería inversa / servicios públicos del MOP):
  * Catálogo de estaciones fluviométricas ... mapas2.mop.gob.cl /AplicarFiltros
  * Último caudal diario por estación ...... mapas2.mop.gob.cl caudal_diario_historico_<region>.zip
  * Alertas oficiales DGA en tiempo real ... rest-sit.mop.gob.cl  DGA/ALERTAS/MapServer/0
  * Embalses (nivel y volumen) ............. rest-sit.mop.gob.cl  DGA/ESTACION_EMBALSE/MapServer/0

Diseño:
  * Las peticiones HTTP del navegador NUNCA esperan a la DGA: sólo leen la caché en memoria.
    Un hilo programador sincroniza en segundo plano.
  * Toda escritura a disco es atómica (archivo temporal + os.replace) para evitar archivos corruptos.
  * La configuración de umbrales se valida al cargar y al guardar.
"""

import csv
import io
import json
import logging
import math
import os
import re
import shutil
import tempfile
import threading
import time
import zipfile
from datetime import datetime, timedelta, timezone

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

log = logging.getLogger("dga_service")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
CONFIG_PATH = os.path.join(DATA_DIR, "alerts_config.json")
CACHE_PATH = os.path.join(DATA_DIR, "cache.json")

MAPAS2_URL = "https://mapas2.mop.gob.cl"
ARCGIS_DGA = "https://rest-sit.mop.gob.cl/arcgis/rest/services/DGA"

CACHE_VERSION = 4
ARCGIS_TIMEOUT = (5, 12)                # (conexión, lectura) en segundos
MAPAS2_TIMEOUT = (5, 12)
ZIP_TIMEOUT = (5, 25)
MAX_ZIP_BYTES = 80 * 1024 * 1024        # límite de descarga de ZIP históricos
ALERTAS_TTL = timedelta(seconds=60)
CATALOG_TTL = timedelta(hours=24)
CAUDAL_TTL = timedelta(hours=12)
EMBALSE_TTL = timedelta(minutes=30)
MAX_DATA_AGE_DAYS = 365                 # datos más antiguos no generan alertas de umbral
OLD_DATA_DAYS = 7                       # sobre esto se marca como "dato antiguo"
SYNC_COOLDOWN_S = 10

REGIONES = {
    "1": "Tarapacá", "2": "Antofagasta", "3": "Atacama", "4": "Coquimbo",
    "5": "Valparaíso", "6": "O'Higgins", "7": "Maule", "8": "Biobío",
    "9": "La Araucanía", "10": "Los Lagos", "11": "Aysén", "12": "Magallanes",
    "13": "Metropolitana", "14": "Los Ríos", "15": "Arica y Parinacota", "16": "Ñuble",
}

# Niveles de alerta oficiales DGA (campo mod_indale)
DGA_LEVELS = {1: ("PREVENTIVA", "Azul"), 2: ("ADVERTENCIA", "Amarilla"), 3: ("CRITICO", "Roja")}
SEVERITY = {"CRITICO": 3, "ADVERTENCIA": 2, "PREVENTIVA": 1, "NORMAL": 0, "SIN_DATOS": -1, "INACTIVA": -1}

CODE_RE = re.compile(r"^\d{8}(-[\dkK])?$")

DEFAULT_CONFIG = {
    "general": {"caudal_max_default": 60.0, "caudal_min_default": 0.5, "volumen_min_default": 20.0},
    "embalses": {},
    "estaciones": {},
}


# ----------------------------------------------------------------------------- utilidades
def base_code(code):
    """'05710001-K' -> '05710001'."""
    return str(code or "").split("-")[0].strip()


def now():
    return datetime.now()


def iso(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S") if dt else None


def parse_iso(s):
    try:
        return datetime.strptime(s, "%Y-%m-%d %H:%M:%S")
    except (TypeError, ValueError):
        return None


def arcgis_dt(ms):
    """ArcGIS del MOP codifica fechas locales de Chile (Oracle DATE) como epoch UTC."""
    if not isinstance(ms, (int, float)):
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc).replace(tzinfo=None)


def round_num(v, dec=3):
    if v is None:
        return None
    try:
        f = float(v)
        return round(f, dec) if math.isfinite(f) else v
    except (TypeError, ValueError):
        return v


def is_stale(ts_str, ttl):
    ts = parse_iso(ts_str)
    return ts is None or now() - ts > ttl


def finite_number(value, lo=0.0, hi=1_000_000.0):
    """Convierte a float validando que sea finito y esté en rango. None si viene vacío."""
    if value is None or value == "":
        return None
    v = float(value)  # puede lanzar ValueError/TypeError -> lo captura quien llama
    if not math.isfinite(v) or v < lo or v > hi:
        raise ValueError(f"Valor fuera de rango ({lo} - {hi})")
    return round(v, 3)


def atomic_write_json(path, data, keep_backup=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp_", suffix=".json")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        if keep_backup and os.path.exists(path):
            shutil.copy2(path, path + ".bak")
        os.replace(tmp, path)
    except Exception:
        if os.path.exists(tmp):
            os.remove(tmp)
        raise


def load_json(path):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def sanitize_config(raw):
    """Devuelve una configuración limpia; descarta entradas inválidas en vez de fallar."""
    cfg = json.loads(json.dumps(DEFAULT_CONFIG))
    if not isinstance(raw, dict):
        return cfg
    gen = raw.get("general") or {}
    for k in cfg["general"]:
        try:
            v = finite_number(gen.get(k))
            if v is not None:
                cfg["general"][k] = v
        except (TypeError, ValueError):
            pass
    for section, keys in (("embalses", ("volumen_min", "volumen_max")), ("estaciones", ("caudal_min", "caudal_max"))):
        for code, rule in (raw.get(section) or {}).items():
            if not CODE_RE.match(str(code)) or not isinstance(rule, dict):
                continue
            clean = {"nombre": str(rule.get("nombre", code))[:120]}
            try:
                for k in keys:
                    clean[k] = finite_number(rule.get(k))
            except (TypeError, ValueError):
                continue
            if clean[keys[0]] is not None and clean[keys[1]] is not None and clean[keys[0]] >= clean[keys[1]]:
                continue
            cfg[section][str(code)] = clean
    return cfg


# ----------------------------------------------------------------------------- servicio
class ArcGISUnavailableError(RuntimeError):
    """El servicio ArcGIS del MOP está en mantenimiento o no responde temporalmente."""


class DGAService:
    def __init__(self):
        self.session = requests.Session()
        retry = Retry(total=2, connect=1, read=0, status=2, backoff_factor=0.5,
                      status_forcelist=(429, 500, 502, 503, 504),
                      allowed_methods=frozenset(["GET", "POST"]))
        self.session.mount("https://", HTTPAdapter(max_retries=retry))
        self.session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
                          "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 DGA-Water-Monitor/2.0",
        })
        # Certificados verificados (antes estaba deshabilitado: riesgo MITM)
        self.session.verify = True

        self._lock = threading.RLock()        # protege cache/config/alertas
        self._sync_lock = threading.Lock()    # evita sincronizaciones simultáneas
        self._csrf_lock = threading.Lock()
        self._pending = set()                 # tareas en background en curso
        self._csrf_token = None
        self._last_sync_request = 0.0
        self._last_realtime_attempt = 0.0
        self._stop = threading.Event()

        self.cache = self._load_cache()
        self.config = self._load_config()
        self._alertas = []
        self._estado_por_codigo = {}
        self.recompute_alerts()

    # ------------------------------------------------------------------ persistencia
    def _load_cache(self):
        empty = {"version": CACHE_VERSION, "last_sync": None, "last_error": None,
                 "embalses": [], "embalses_updated": None,
                 "alertas_oficiales": [], "alertas_oficiales_updated": None,
                 "estaciones_by_region": {}, "caudales_by_region": {}}
        if os.path.exists(CACHE_PATH):
            try:
                data = load_json(CACHE_PATH)
                if isinstance(data, dict) and data.get("version") == CACHE_VERSION:
                    empty.update(data)
                elif isinstance(data, dict) and data.get("version") == 3:
                    empty["estaciones_by_region"] = data.get("estaciones_by_region") or {}
                    empty["caudales_by_region"] = data.get("caudales_by_region") or {}
                    log.info("Migrando caché v3 -> v%d (conservando catálogos y caudales; re-sincronizando ArcGIS).", CACHE_VERSION)
                else:
                    log.info("Caché con formato antiguo: se regenerará.")
            except Exception as e:
                log.warning("cache.json corrupto, se regenerará: %s", e)
        return empty

    def _save_cache(self):
        with self._lock:
            snapshot = json.loads(json.dumps(self.cache))
        try:
            atomic_write_json(CACHE_PATH, snapshot)
        except Exception as e:
            log.error("No se pudo guardar cache.json: %s", e)

    def _load_config(self):
        for path in (CONFIG_PATH, CONFIG_PATH + ".bak"):
            if os.path.exists(path):
                try:
                    return sanitize_config(load_json(path))
                except Exception as e:
                    log.warning("Config inválida en %s: %s", path, e)
        return sanitize_config(DEFAULT_CONFIG)

    def _save_config(self):
        atomic_write_json(CONFIG_PATH, self.config, keep_backup=True)

    # ------------------------------------------------------------------ mapas2 (CSRF)
    def _refresh_csrf(self):
        r = self.session.get(f"{MAPAS2_URL}/", timeout=MAPAS2_TIMEOUT)
        r.raise_for_status()
        m = re.search(r'csrf_token\s*[:=]\s*["\']([^"\']{20,200})["\']', r.text)
        if not m:
            raise RuntimeError("No se encontró csrf_token en mapas2.mop.gob.cl")
        self._csrf_token = m.group(1)

    def _post_mapas2(self, path, data):
        with self._csrf_lock:
            if not self._csrf_token:
                self._refresh_csrf()
            token = self._csrf_token
        for attempt in range(2):
            headers = {
                "X-Requested-With": "XMLHttpRequest",
                "X-CSRF-TOKEN": token,
                "Referer": f"{MAPAS2_URL}/",
                "Origin": MAPAS2_URL,
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            }
            r = self.session.post(f"{MAPAS2_URL}{path}", data={**data, "csrf_token": token},
                                  headers=headers, timeout=MAPAS2_TIMEOUT)
            if r.status_code in (400, 403, 419) and attempt == 0:
                with self._csrf_lock:          # token expirado -> renovar y reintentar
                    self._refresh_csrf()
                    token = self._csrf_token
                continue
            r.raise_for_status()
            try:
                return json.loads(r.text)
            except ValueError:
                raise RuntimeError(f"Respuesta no JSON desde {path}")
        raise RuntimeError(f"No fue posible consultar {path}")

    # ------------------------------------------------------------------ fuentes
    def fetch_estaciones_region(self, region):
        data = self._post_mapas2("/AplicarFiltros", {
            "esactiva": "2", "region": region, "selecciona_tipo": "1", "fluviometricas": "1",
            "meteorologicas": "0", "sedimentometricas": "0", "calidad_agua": "0", "control_pozo": "0",
        })
        items = []
        for e in data if isinstance(data, list) else []:
            try:
                lat, lng = float(e.get("val_latitud")), float(e.get("val_longitud"))
            except (TypeError, ValueError):
                continue
            if not (-56.5 <= lat <= -17 and -76.5 <= lng <= -66):
                continue
            code = base_code(e.get("cod_estacion"))
            if not CODE_RE.match(code):
                continue
            estado_estacion = "Activa" if str(e.get("estado_estacion") or "").strip().lower() == "activa" else "Inactiva"
            items.append({
                "codigo": code,
                "nombre": str(e.get("gls_estacion") or code).title()[:150],
                "region": region,
                "region_nombre": REGIONES.get(region, ""),
                "comuna": str(e.get("glosa_comuna") or "").title()[:80],
                "lat": lat, "lng": lng,
                "altitud": e.get("val_altitud"),
                "tipo": "Fluviométrica (Río)",
                "estado_estacion": estado_estacion,
                "activa": estado_estacion == "Activa",
            })
        with self._lock:
            self.cache["estaciones_by_region"][region] = {"updated": iso(now()), "items": items}
        log.info("Región %s: %d estaciones fluviométricas", region, len(items))
        return items

    def fetch_caudales_region(self, region):
        """Descarga el ZIP de caudal diario histórico y conserva el último valor por estación."""
        url = f"{MAPAS2_URL}/caudal_diario_historico_{region}.zip"
        with self.session.get(url, timeout=ZIP_TIMEOUT, stream=True) as r:
            r.raise_for_status()
            buf = io.BytesIO()
            for chunk in r.iter_content(65536):
                buf.write(chunk)
                if buf.tell() > MAX_ZIP_BYTES:
                    raise RuntimeError("ZIP excede el tamaño máximo permitido")
        ultimos = {}
        with zipfile.ZipFile(buf) as z:
            name = next((n for n in z.namelist() if n.lower().endswith((".txt", ".csv"))), None)
            if not name:
                raise RuntimeError("ZIP sin archivo de datos")
            with z.open(name) as fh:
                reader = csv.DictReader(io.TextIOWrapper(fh, encoding="utf-8", errors="ignore"))
                for row in reader:
                    code = base_code(row.get("CODIGO ESTACION"))
                    try:
                        fecha = datetime.strptime((row.get("FECHA") or "").strip(), "%d/%m/%Y")
                        valor = float(row.get("Caudal_diario"))
                    except (TypeError, ValueError):
                        continue
                    if not math.isfinite(valor):
                        continue
                    prev = ultimos.get(code)
                    if prev is None or fecha >= prev[0]:
                        ultimos[code] = (fecha, valor)
        items = {c: {"valor": round(v, 3), "fecha": f.strftime("%Y-%m-%d")} for c, (f, v) in ultimos.items()}
        with self._lock:
            self.cache["caudales_by_region"][region] = {"updated": iso(now()), "items": items}
        log.info("Región %s: último caudal diario para %d estaciones", region, len(items))
        return items

    def _arcgis_query(self, service, where="1=1"):
        url = f"{ARCGIS_DGA}/{service}/MapServer/0/query"
        try:
            r = self.session.get(url, params={"where": where, "outFields": "*", "f": "json", "outSR": 4326},
                                 timeout=ARCGIS_TIMEOUT)
            r.raise_for_status()
        except requests.exceptions.RequestException as e:
            raise ArcGISUnavailableError(f"Servicio ArcGIS ({service}) sin respuesta temporal") from e
        if r.text.lstrip().startswith("<"):
            raise ArcGISUnavailableError(f"Servicio ArcGIS ({service}) devolvió HTML de mantenimiento")
        try:
            data = r.json()
        except ValueError as e:
            raise ArcGISUnavailableError(f"Respuesta inválida de ArcGIS ({service})") from e
        if "error" in data:
            raise RuntimeError(f"ArcGIS {service}: {data['error'].get('message')}")
        out = []
        for f in data.get("features", []):
            attrs = {k.split(".")[-1]: v for k, v in (f.get("attributes") or {}).items()}
            geom = f.get("geometry") or {}
            attrs["_lat"], attrs["_lng"] = geom.get("y"), geom.get("x")
            out.append(attrs)
        return out

    def fetch_embalses(self):
        rows = self._arcgis_query("ESTACION_EMBALSE")
        items = []
        for a in rows:
            code = str(a.get("CODBNA") or "")
            if not CODE_RE.match(code):
                continue
            fec = a.get("fecmed")
            fecha = arcgis_dt(fec)
            items.append({
                "codigo": code,
                "nombre": str(a.get("NOMBRERED") or code).title()[:150],
                "tipo": "Embalse / Lago",
                "nivel": a.get("nivel"),
                "volumen": a.get("volumen"),
                "fecha": iso(fecha),
                "lat": a.get("_lat"), "lng": a.get("_lng"),
            })
        with self._lock:
            self.cache["embalses"] = items
            self.cache["embalses_updated"] = iso(now())
        return items

    def fetch_alertas_oficiales(self):
        try:
            rows = self._arcgis_query("ALERTAS", "SITMOP_PROD.SDE.V_DGA_GIS_ALERTAS.mod_indale > 0")
        except ArcGISUnavailableError:
            raise
        except Exception as e:
            log.info("Filtro remoto de alertas no disponible (%s); filtrando localmente.", e)
            rows = [a for a in self._arcgis_query("ALERTAS") if (a.get("mod_indale") or 0) > 0]
        latest = {}
        for a in rows:
            try:
                nivel = int(a.get("mod_indale") or 0)
            except (TypeError, ValueError):
                continue
            if nivel not in DGA_LEVELS:
                continue
            code = base_code(a.get("CODBNA"))
            fec = a.get("mod_fechra") or 0
            if code not in latest or fec >= latest[code]["_ts"]:
                latest[code] = {
                    "_ts": fec,
                    "codigo": code,
                    "codigo_bna": a.get("CODBNA"),
                    "nombre": str(a.get("NOMBRERED") or code).title()[:150],
                    "medicion": a.get("MEDICION"),
                    "nivel_dga": nivel,
                    "valor": round_num(a.get("mod_valor"), 3),
                    "umbral": round_num(a.get("mod_alerta"), 3),
                    "fecha": iso(arcgis_dt(fec)) if fec else None,
                    "lat": a.get("_lat"), "lng": a.get("_lng"),
                }
        items = sorted(latest.values(), key=lambda x: -x["nivel_dga"])
        for i in items:
            i.pop("_ts", None)
        with self._lock:
            self.cache["alertas_oficiales"] = items
            self.cache["alertas_oficiales_updated"] = iso(now())
        log.info("Alertas oficiales DGA activas: %d", len(items))
        return items

    # ------------------------------------------------------------------ sincronización
    def _run_bg(self, key, fn, *args):
        """Ejecuta fn en segundo plano evitando duplicados por clave."""
        with self._lock:
            if key in self._pending:
                return
            self._pending.add(key)

        def runner():
            try:
                fn(*args)
                self.recompute_alerts()
                self._save_cache()
            except Exception as e:
                log.warning("Tarea %s falló: %s", key, e)
            finally:
                with self._lock:
                    self._pending.discard(key)

        threading.Thread(target=runner, name=f"bg-{key}", daemon=True).start()

    def is_loading(self):
        with self._lock:
            return bool(self._pending) or self._sync_lock.locked()

    def ensure_region(self, region):
        """Garantiza catálogo (síncrono, rápido) y programa la descarga de caudales (background)."""
        with self._lock:
            entry = self.cache["estaciones_by_region"].get(region)
        if not entry or is_stale(entry.get("updated"), CATALOG_TTL):
            try:
                self.fetch_estaciones_region(region)
                self._save_cache()
            except Exception as e:
                log.warning("No se pudo cargar catálogo región %s: %s", region, e)
        with self._lock:
            cau = self.cache["caudales_by_region"].get(region)
        if not cau or is_stale(cau.get("updated"), CAUDAL_TTL):
            self._run_bg(f"caudal-{region}", self.fetch_caudales_region, region)

    def ensure_all_regions(self):
        def load_caudales_all():
            for reg in REGIONES:
                if self._stop.is_set():
                    return
                with self._lock:
                    cau = self.cache["caudales_by_region"].get(reg)
                if not cau or is_stale(cau.get("updated"), CAUDAL_TTL):
                    try:
                        self.fetch_caudales_region(reg)
                        self._save_cache()
                    except Exception as e:
                        log.warning("Caudal región %s: %s", reg, e)
                    time.sleep(0.8)

        def load_all():
            updated = False
            for reg in REGIONES:
                if self._stop.is_set():
                    return
                with self._lock:
                    entry = self.cache["estaciones_by_region"].get(reg)
                if not entry or is_stale(entry.get("updated"), CATALOG_TTL):
                    try:
                        self.fetch_estaciones_region(reg)
                        updated = True
                    except Exception as e:
                        log.warning("Región %s: %s", reg, e)
                    time.sleep(0.15)    # cortesía con el servidor de la DGA
            if updated:
                self._save_cache()
            self._run_bg("all-caudales", load_caudales_all)
        self._run_bg("all-regions", load_all)

    def sync_realtime(self, force_embalses=False):
        """Sincronización ligera (< 2s) de alertas oficiales DGA y embalses."""
        if not self._sync_lock.acquire(blocking=False):
            return False
        errors = []
        try:
            self._last_realtime_attempt = time.time()
            arcgis_ok = True
            try:
                self.fetch_alertas_oficiales()
            except ArcGISUnavailableError as e:
                arcgis_ok = False
                with self._lock:
                    cached_alerts = len(self.cache.get("alertas_oficiales") or [])
                if cached_alerts:
                    log.info("ArcGIS ALERTAS en mantenimiento (%s); usando %d alertas en caché.", e, cached_alerts)
                else:
                    errors.append(str(e))
            except Exception as e:
                errors.append(f"alertas oficiales: {e}")

            with self._lock:
                emb_stale = force_embalses or is_stale(self.cache.get("embalses_updated"), EMBALSE_TTL) or not self.cache.get("embalses")
            if arcgis_ok and emb_stale:
                try:
                    self.fetch_embalses()
                except ArcGISUnavailableError as e:
                    with self._lock:
                        cached_emb = len(self.cache.get("embalses") or [])
                    if cached_emb:
                        log.info("ArcGIS EMBALSES en mantenimiento (%s); usando %d embalses en caché.", e, cached_emb)
                    else:
                        errors.append(str(e))
                except Exception as e:
                    errors.append(f"embalses: {e}")

            with self._lock:
                self.cache["last_sync"] = iso(now())
                self.cache["last_error"] = "; ".join(errors)[:500] if errors else None
            self.recompute_alerts()
            self._save_cache()
            log.info("Sincronización en vivo completa%s", f" con errores: {errors}" if errors else "")
            return True
        finally:
            self._sync_lock.release()

    def ensure_realtime_fresh(self):
        with self._lock:
            stale = is_stale(self.cache.get("alertas_oficiales_updated"), ALERTAS_TTL)
        if stale and (time.time() - self._last_realtime_attempt > 15):
            self._run_bg("realtime", self.sync_realtime)

    def sync_all(self, target_region=None):
        if not self._sync_lock.acquire(blocking=False):
            return False
        errors = []
        try:
            self._last_realtime_attempt = time.time()
            arcgis_ok = True
            try:
                self.fetch_alertas_oficiales()
            except ArcGISUnavailableError as e:
                arcgis_ok = False
                with self._lock:
                    cached_alerts = len(self.cache.get("alertas_oficiales") or [])
                if cached_alerts:
                    log.info("ArcGIS ALERTAS en mantenimiento (%s); usando %d alertas en caché.", e, cached_alerts)
                else:
                    errors.append(str(e))
            except Exception as e:
                errors.append(f"alertas oficiales: {e}")

            with self._lock:
                emb_stale = is_stale(self.cache.get("embalses_updated"), EMBALSE_TTL) or not self.cache.get("embalses")
            if arcgis_ok and emb_stale:
                try:
                    self.fetch_embalses()
                except ArcGISUnavailableError as e:
                    with self._lock:
                        cached_emb = len(self.cache.get("embalses") or [])
                    if cached_emb:
                        log.info("ArcGIS EMBALSES en mantenimiento (%s); usando %d embalses en caché.", e, cached_emb)
                    else:
                        errors.append(str(e))
                except Exception as e:
                    errors.append(f"embalses: {e}")

            if target_region and target_region != "all" and target_region in REGIONES:
                try:
                    self.fetch_estaciones_region(target_region)
                    with self._lock:
                        cau = self.cache["caudales_by_region"].get(target_region)
                    if not cau or is_stale(cau.get("updated"), CAUDAL_TTL):
                        self.fetch_caudales_region(target_region)
                except Exception as e:
                    errors.append(f"región {target_region}: {e}")

            for reg in list(REGIONES.keys()):
                if reg == target_region:
                    continue
                with self._lock:
                    cat = self.cache["estaciones_by_region"].get(reg)
                    cau = self.cache["caudales_by_region"].get(reg)
                try:
                    if not cat or is_stale(cat.get("updated"), CATALOG_TTL):
                        self.fetch_estaciones_region(reg)
                    if not cau or is_stale(cau.get("updated"), CAUDAL_TTL):
                        self.fetch_caudales_region(reg)
                        time.sleep(0.5)
                except Exception as e:
                    errors.append(f"región {reg}: {e}")

            with self._lock:
                self.cache["last_sync"] = iso(now())
                self.cache["last_error"] = "; ".join(errors)[:500] if errors else None
            self.recompute_alerts()
            self._save_cache()
            log.info("Sincronización completa%s", f" con errores: {errors}" if errors else "")
            return True
        finally:
            self._sync_lock.release()

    def request_sync(self, region=None):
        """Sincronización manual con enfriamiento para evitar abuso. Devuelve (ok, mensaje)."""
        with self._lock:
            elapsed = time.time() - self._last_sync_request
            if elapsed < SYNC_COOLDOWN_S:
                return False, f"Espera {int(SYNC_COOLDOWN_S - elapsed)} s antes de volver a sincronizar."
            if self._sync_lock.locked():
                return False, "Ya hay una sincronización en curso."
            self._last_sync_request = time.time()
        with self._lock:                       # forzar refresco de embalses en sync manual
            self.cache["embalses_updated"] = None
        threading.Thread(target=self.sync_all, args=(region,), name="manual-sync", daemon=True).start()
        return True, "Sincronización con la DGA iniciada."

    def start_scheduler(self, interval_s=60):
        def loop():
            self.sync_all()
            while not self._stop.wait(interval_s):
                try:
                    self.sync_realtime()
                    with self._lock:
                        need_regions = any(
                            not self.cache["estaciones_by_region"].get(r)
                            or is_stale(self.cache["estaciones_by_region"][r].get("updated"), CATALOG_TTL)
                            or not self.cache["caudales_by_region"].get(r)
                            or is_stale(self.cache["caudales_by_region"][r].get("updated"), CAUDAL_TTL)
                            for r in REGIONES
                        )
                    if need_regions:
                        self.ensure_all_regions()
                except Exception as e:
                    log.error("Error en sincronización programada: %s", e)
        threading.Thread(target=loop, name="scheduler", daemon=True).start()

    # ------------------------------------------------------------------ alertas
    def _station_name(self, code):
        with self._lock:
            for reg in self.cache["estaciones_by_region"].values():
                for e in reg.get("items", []):
                    if e["codigo"] == code:
                        return e["nombre"], e
        return None, None

    def recompute_alerts(self):
        with self._lock:
            cfg = json.loads(json.dumps(self.config))
            oficiales = list(self.cache.get("alertas_oficiales", []))
            embalses = list(self.cache.get("embalses", []))
            sinc_oficial = self.cache.get("alertas_oficiales_updated") or self.cache.get("last_sync")
            last_sync = self.cache.get("last_sync")
            caudales = {}
            for reg in self.cache["caudales_by_region"].values():
                caudales.update(reg.get("items", {}))

        alertas = []
        hoy = now()

        # 1) Alertas oficiales DGA (tiempo real)
        for o in oficiales:
            nivel, color = DGA_LEVELS[o["nivel_dga"]]
            val = round_num(o.get("valor"), 3)
            umb = round_num(o.get("umbral"), 3)
            alertas.append({
                "id": f"dga-{o['codigo']}", "fuente": "DGA oficial", "tipo_elemento": "estacion",
                "codigo": o["codigo"], "nombre": o["nombre"], "nivel_alerta": nivel,
                "mensaje": f"Alerta {color} DGA: valor medido {val} supera el umbral oficial {umb}.",
                "valor_actual": val, "umbral": umb, "unidad": "m",
                "fecha": o["fecha"], "sincronizado": sinc_oficial,
                "lat": o.get("lat"), "lng": o.get("lng"), "dato_antiguo": False,
            })

        # 2) Umbrales del usuario sobre último caudal diario (solo estaciones configuradas)
        for code, rule in cfg["estaciones"].items():
            dato = caudales.get(base_code(code))
            if not dato:
                continue
            fecha = datetime.strptime(dato["fecha"], "%Y-%m-%d")
            edad = (hoy - fecha).days
            if edad > MAX_DATA_AGE_DAYS:
                continue
            v = round_num(dato["valor"], 3)
            nombre = self._station_name(base_code(code))[0] or rule.get("nombre", code)
            base = {"fuente": "Umbral usuario", "tipo_elemento": "estacion", "codigo": base_code(code),
                    "nombre": nombre, "valor_actual": v, "unidad": "m³/s", "fecha": dato["fecha"],
                    "sincronizado": last_sync, "dato_antiguo": edad > OLD_DATA_DAYS}
            if rule.get("caudal_max") is not None and v > rule["caudal_max"]:
                umb = round_num(rule["caudal_max"], 3)
                alertas.append({**base, "id": f"usr-max-{code}", "nivel_alerta": "CRITICO", "umbral": umb,
                                "mensaje": f"Caudal {v} m³/s sobre el máximo configurado ({umb} m³/s): posible crecida."})
            elif rule.get("caudal_min") is not None and v < rule["caudal_min"]:
                umb = round_num(rule["caudal_min"], 3)
                alertas.append({**base, "id": f"usr-min-{code}", "nivel_alerta": "ADVERTENCIA", "umbral": umb,
                                "mensaje": f"Caudal {v} m³/s bajo el mínimo configurado ({umb} m³/s): estiaje."})

        # 3) Umbrales del usuario sobre embalses (solo con dato reciente)
        for emb in embalses:
            rule = cfg["embalses"].get(emb["codigo"])
            fecha = parse_iso(emb.get("fecha"))
            if not rule or emb.get("volumen") is None or not fecha or (hoy - fecha).days > MAX_DATA_AGE_DAYS:
                continue
            vol = round(float(emb["volumen"]), 2)
            base = {"fuente": "Umbral usuario", "tipo_elemento": "embalse", "codigo": emb["codigo"],
                    "nombre": emb["nombre"], "valor_actual": vol, "unidad": "Mm³", "fecha": emb.get("fecha"),
                    "sincronizado": last_sync, "lat": emb.get("lat"), "lng": emb.get("lng"),
                    "dato_antiguo": (hoy - fecha).days > OLD_DATA_DAYS}
            if rule.get("volumen_min") is not None and vol < rule["volumen_min"]:
                umb = round_num(rule["volumen_min"], 3)
                alertas.append({**base, "id": f"emb-min-{emb['codigo']}", "nivel_alerta": "CRITICO", "umbral": umb,
                                "mensaje": f"Volumen {vol} Mm³ bajo el mínimo configurado ({umb} Mm³): déficit hídrico."})
            elif rule.get("volumen_max") is not None and vol > rule["volumen_max"]:
                umb = round_num(rule["volumen_max"], 3)
                alertas.append({**base, "id": f"emb-max-{emb['codigo']}", "nivel_alerta": "ADVERTENCIA", "umbral": umb,
                                "mensaje": f"Volumen {vol} Mm³ sobre el máximo configurado ({umb} Mm³)."})

        alertas.sort(key=lambda a: -SEVERITY.get(a["nivel_alerta"], 0))
        estado = {}
        for a in alertas:
            prev = estado.get(a["codigo"])
            if prev is None or SEVERITY[a["nivel_alerta"]] > SEVERITY[prev["nivel_alerta"]]:
                estado[a["codigo"]] = a
        with self._lock:
            self._alertas = alertas
            self._estado_por_codigo = estado
        return alertas

    # ------------------------------------------------------------------ lecturas para la API
    def get_alertas(self):
        self.ensure_realtime_fresh()
        with self._lock:
            return list(self._alertas)

    def get_estaciones(self, region):
        with self._lock:
            if region == "all":
                regs = list(self.cache["estaciones_by_region"].values())
            else:
                regs = [self.cache["estaciones_by_region"].get(region, {})]
            caudales = {}
            for reg in self.cache["caudales_by_region"].values():
                caudales.update(reg.get("items", {}))
            estado = dict(self._estado_por_codigo)
            items = [dict(e) for r in regs for e in r.get("items", [])]
        for e in items:
            caudal = caudales.get(e["codigo"])
            activa = bool(e.get("activa", e.get("estado_estacion", "Activa") == "Activa"))
            e["activa"] = activa
            e["estado_estacion"] = "Activa" if activa else "Inactiva"
            e["ultimo_caudal"] = caudal
            e["sin_registro"] = caudal is None
            e["inactiva_o_sin_registro"] = (not activa) or (caudal is None)
            alerta = estado.get(e["codigo"])
            e["alerta"] = alerta
            if alerta:
                e["estado"] = alerta["nivel_alerta"]
            elif not activa:
                e["estado"] = "INACTIVA"
            elif caudal is None:
                e["estado"] = "SIN_DATOS"
            else:
                e["estado"] = "NORMAL"
        return items

    def get_embalses(self):
        hoy = now()
        with self._lock:
            items = [dict(e) for e in self.cache.get("embalses", [])]
            estado = dict(self._estado_por_codigo)
        for e in items:
            fecha = parse_iso(e.get("fecha"))
            e["dias_desde_medicion"] = (hoy - fecha).days if fecha else None
            alerta = estado.get(e["codigo"])
            e["alerta"] = alerta
            if alerta:
                e["estado"] = alerta["nivel_alerta"]
            elif not fecha or (hoy - fecha).days > MAX_DATA_AGE_DAYS:
                e["estado"] = "SIN_DATOS"
            else:
                e["estado"] = "NORMAL"
        return items

    def get_estacion_detalle(self, code):
        code = base_code(code)
        _, est = self._station_name(code)
        with self._lock:
            caudal = None
            for reg in self.cache["caudales_by_region"].values():
                caudal = reg.get("items", {}).get(code) or caudal
            oficial = next((o for o in self.cache.get("alertas_oficiales", []) if o["codigo"] == code), None)
            rule = self.config["estaciones"].get(code)
            alerta = self._estado_por_codigo.get(code)
        activa = bool(est.get("activa", est.get("estado_estacion", "Activa") == "Activa")) if est else True
        if alerta:
            estado = alerta["nivel_alerta"]
        elif not activa:
            estado = "INACTIVA"
        elif caudal is None:
            estado = "SIN_DATOS"
        else:
            estado = "NORMAL"
        return {"codigo": code, "estacion": est, "ultimo_caudal": caudal, "alerta_oficial": oficial,
                "umbral": rule, "alerta": alerta, "estado": estado}

    def known_code(self, tipo, code):
        with self._lock:
            if tipo == "embalse":
                return any(e["codigo"] == code for e in self.cache.get("embalses", []))
        return self._station_name(base_code(code))[1] is not None

    def update_threshold(self, tipo, code, vmin, vmax, nombre):
        section, kmin, kmax = (("embalses", "volumen_min", "volumen_max") if tipo == "embalse"
                               else ("estaciones", "caudal_min", "caudal_max"))
        if tipo == "estacion":
            code = base_code(code)
        with self._lock:
            if vmin is None and vmax is None:
                self.config[section].pop(code, None)          # sin umbrales = eliminar regla
            else:
                self.config[section][code] = {"nombre": nombre[:120], kmin: vmin, kmax: vmax}
            self._save_config()
        self.recompute_alerts()
        with self._lock:
            return self.config[section].get(code)

    def get_config(self):
        with self._lock:
            return json.loads(json.dumps(self.config))

    def summary(self):
        self.ensure_realtime_fresh()
        with self._lock:
            alertas = list(self._alertas)
            all_est = [e for r in self.cache["estaciones_by_region"].values() for e in r.get("items", [])]
            total_est = len(all_est)
            total_activas = sum(1 for e in all_est if e.get("activa", e.get("estado_estacion", "Activa") == "Activa"))
            return {
                "last_sync": self.cache.get("last_sync"),
                "last_error": self.cache.get("last_error"),
                "alertas_oficiales_updated": self.cache.get("alertas_oficiales_updated"),
                "total_embalses": len(self.cache.get("embalses", [])),
                "total_estaciones": total_est,
                "total_estaciones_activas": total_activas,
                "total_estaciones_inactivas": total_est - total_activas,
                "regiones_cargadas": sorted(self.cache["estaciones_by_region"].keys(), key=int),
                "total_alertas": len(alertas),
                "alertas_criticas": sum(a["nivel_alerta"] == "CRITICO" for a in alertas),
                "alertas_advertencia": sum(a["nivel_alerta"] == "ADVERTENCIA" for a in alertas),
                "alertas_preventivas": sum(a["nivel_alerta"] == "PREVENTIVA" for a in alertas),
                "cargando": bool(self._pending) or self._sync_lock.locked(),
            }


service = DGAService()

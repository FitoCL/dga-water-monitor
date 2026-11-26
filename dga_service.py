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
import unicodedata
import xml.etree.ElementTree as ET
import zipfile
from datetime import datetime, timedelta, timezone
from xml.sax.saxutils import escape as xml_escape

import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

log = logging.getLogger("dga_service")

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
DATA_DIR = os.path.join(BASE_DIR, "data")
CONFIG_PATH = os.path.join(DATA_DIR, "alerts_config.json")
CACHE_PATH = os.path.join(DATA_DIR, "cache.json")
HISTORY_PATH = os.path.join(DATA_DIR, "alerts_history.json")
HISTORY_ARCHIVE_DIR = os.path.join(DATA_DIR, "history_archives")
RIVERS_CACHE_PATH = os.path.join(DATA_DIR, "rivers_cache.json")
HISTORY_VERSION = 1
RIVERS_CACHE_VERSION = 1
HISTORY_RETENTION_DAYS = 365
MAX_HISTORY_POINTS_PER_STATION = 20000

MAPAS2_URL = "https://mapas2.mop.gob.cl"
ARCGIS_DGA = "https://rest-sit.mop.gob.cl/arcgis/rest/services/DGA"
ARCGIS_RED_HIDROGRAFICA = "https://rest-sit.mop.gob.cl/arcgis/rest/services/MAPA_BASE/RED_HIDROGRAFICA/MapServer/16/query"

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
def _xlsx_col_ref(col_idx):
    """Convierte índice 1-based de columna Excel a letra (1->A, 27->AA)."""
    out = []
    n = col_idx
    while n > 0:
        n, rem = divmod(n - 1, 26)
        out.append(chr(65 + rem))
    return "".join(reversed(out))


def _xlsx_clean_text(val):
    s = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", "", str(val if val is not None else ""))
    if s and s[0] in ("=", "+", "-", "@"):
        s = "'" + s
    return s


def _build_xlsx_workbook(sheets):
    """Genera un libro Excel (.xlsx) válido en memoria usando solo librería estándar."""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        sheet_overrides = "".join(
            f'<Override PartName="/xl/worksheets/sheet{i}.xml" '
            f'ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
            for i in range(1, len(sheets) + 1)
        )
        content_types = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
            '<Default Extension="xml" ContentType="application/xml"/>'
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
            '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>'
            f'{sheet_overrides}</Types>'
        )
        zf.writestr("[Content_Types].xml", content_types)

        rels_root = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
            '</Relationships>'
        )
        zf.writestr("_rels/.rels", rels_root)

        wb_sheets = []
        wb_rels = []
        for idx, (raw_name, _) in enumerate(sheets, start=1):
            safe_name = re.sub(r"[\[\]:*?/\\]", " ", str(raw_name)).strip()[:31] or f"Hoja{idx}"
            wb_sheets.append(f'<sheet name="{xml_escape(safe_name)}" sheetId="{idx}" r:id="rId{idx}"/>')
            wb_rels.append(
                f'<Relationship Id="rId{idx}" '
                f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" '
                f'Target="worksheets/sheet{idx}.xml"/>'
            )
        style_rid = len(sheets) + 1
        wb_rels.append(
            f'<Relationship Id="rId{style_rid}" '
            f'Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" '
            f'Target="styles.xml"/>'
        )

        workbook_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
            'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
            f'<sheets>{"".join(wb_sheets)}</sheets></workbook>'
        )
        zf.writestr("xl/workbook.xml", workbook_xml)

        wb_rels_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
            f'{"".join(wb_rels)}</Relationships>'
        )
        zf.writestr("xl/_rels/workbook.xml.rels", wb_rels_xml)

        styles_xml = (
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
            '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<fonts count="2">'
            '<font><sz val="11"/><color rgb="FF0F172A"/><name val="Calibri"/></font>'
            '<font><b/><sz val="11"/><color rgb="FFF8FAFC"/><name val="Calibri"/></font>'
            '</fonts>'
            '<fills count="3">'
            '<fill><patternFill patternType="none"/></fill>'
            '<fill><patternFill patternType="gray125"/></fill>'
            '<fill><patternFill patternType="solid"><fgColor rgb="FF0F172A"/></patternFill></fill>'
            '</fills>'
            '<borders count="2">'
            '<border><left/><right/><top/><bottom/><diagonal/></border>'
            '<border><left style="thin"><color rgb="FFCBD5E1"/></left>'
            '<right style="thin"><color rgb="FFCBD5E1"/></right>'
            '<top style="thin"><color rgb="FFCBD5E1"/></top>'
            '<bottom style="thin"><color rgb="FFCBD5E1"/></bottom></border>'
            '</borders>'
            '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
            '<cellXfs count="3">'
            '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0"/>'
            '<xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1"/>'
            '<xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyBorder="1"/>'
            '</cellXfs>'
            '</styleSheet>'
        )
        zf.writestr("xl/styles.xml", styles_xml)

        for idx, (_, rows) in enumerate(sheets, start=1):
            num_cols = max((len(r) for r in rows), default=1)
            widths = [12] * num_cols
            for r in rows[:500]:
                for c_i, v in enumerate(r):
                    widths[c_i] = max(widths[c_i], min(len(str(v if v is not None else "")) + 4, 42))
            cols_xml = "".join(
                f'<col min="{c_i + 1}" max="{c_i + 1}" width="{w}" customWidth="1"/>'
                for c_i, w in enumerate(widths)
            )

            row_xmls = []
            for r_i, row in enumerate(rows, start=1):
                is_header = r_i == 1
                cells = []
                for c_i, val in enumerate(row, start=1):
                    ref = f"{_xlsx_col_ref(c_i)}{r_i}"
                    if is_header:
                        txt = xml_escape(_xlsx_clean_text(val))
                        cells.append(f'<c r="{ref}" t="inlineStr" s="1"><is><t>{txt}</t></is></c>')
                    elif isinstance(val, (int, float)) and not isinstance(val, bool) and math.isfinite(float(val)):
                        cells.append(f'<c r="{ref}" s="2"><v>{val}</v></c>')
                    else:
                        txt = xml_escape(_xlsx_clean_text(val))
                        cells.append(f'<c r="{ref}" t="inlineStr" s="0"><is><t>{txt}</t></is></c>')
                row_xmls.append(f'<row r="{r_i}">{"".join(cells)}</row>')

            last_col = _xlsx_col_ref(num_cols)
            last_row = max(len(rows), 1)
            sheet_xml = (
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
                '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                '<sheetViews><sheetView workbookViewId="0">'
                '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>'
                '</sheetView></sheetViews>'
                f'<cols>{cols_xml}</cols>'
                f'<sheetData>{"".join(row_xmls)}</sheetData>'
                f'<autoFilter ref="A1:{last_col}{last_row}"/>'
                '</worksheet>'
            )
            zf.writestr(f"xl/worksheets/sheet{idx}.xml", sheet_xml)
    return buf.getvalue()


def base_code(code):
    """'05710001-K' -> '05710001'."""
    return str(code or "").split("-")[0].strip()


def _norm_text(s):
    """Normaliza texto eliminando tildes y mayúsculas para comparar nombres de ríos."""
    txt = unicodedata.normalize("NFKD", str(s or ""))
    txt = "".join(c for c in txt if not unicodedata.combining(c))
    return re.sub(r"\s+", " ", txt).lower().strip()


def _extract_river_name(station_name):
    """Extrae el nombre base del río o estero desde el nombre completo de una estación."""
    clean = re.sub(r"\s+", " ", str(station_name or "")).strip()
    if not clean:
        return ""
    parts = re.split(r"\s+(?:en|antes|despues|después|bajo|aguas|junta|desague|desagüe|sobre)\s+", clean, maxsplit=1, flags=re.IGNORECASE)
    return (parts[0] or clean).strip()


def _stitch_paths(raw_paths, tol=0.0005):
    """Une segmentos contiguos [lat, lng] de ArcGIS en polilíneas continuas."""
    paths = [
        [[round(float(pt[1]), 5), round(float(pt[0]), 5)] for pt in path if len(pt) >= 2]
        for path in raw_paths
        if len(path) >= 2
    ]
    if not paths:
        return []
    stitched = []
    used = [False] * len(paths)
    for i in range(len(paths)):
        if used[i]:
            continue
        used[i] = True
        cur = list(paths[i])
        changed = True
        while changed:
            changed = False
            for j in range(len(paths)):
                if used[j]:
                    continue
                pj = paths[j]
                if math.hypot(cur[-1][0] - pj[0][0], cur[-1][1] - pj[0][1]) <= tol:
                    cur.extend(pj[1:])
                    used[j] = True
                    changed = True
                elif math.hypot(cur[-1][0] - pj[-1][0], cur[-1][1] - pj[-1][1]) <= tol:
                    cur.extend(reversed(pj[:-1]))
                    used[j] = True
                    changed = True
                elif math.hypot(cur[0][0] - pj[-1][0], cur[0][1] - pj[-1][1]) <= tol:
                    cur = list(pj[:-1]) + cur
                    used[j] = True
                    changed = True
                elif math.hypot(cur[0][0] - pj[0][0], cur[0][1] - pj[0][1]) <= tol:
                    cur = list(reversed(pj[1:])) + cur
                    used[j] = True
                    changed = True
        if len(cur) >= 2:
            thinned = [cur[0]]
            for pt in cur[1:-1]:
                if math.hypot(pt[0] - thinned[-1][0], pt[1] - thinned[-1][1]) >= 0.0002:
                    thinned.append(pt)
            thinned.append(cur[-1])
            stitched.append(thinned)
    return stitched


def now():
    return datetime.now()


def iso(dt):
    return dt.strftime("%Y-%m-%d %H:%M:%S") if dt else None


def _alert_fecha_ts(fecha_str):
    """Convierte la fecha/hora de medición de una alerta a timestamp numérico para ordenar."""
    if not fecha_str:
        return 0.0
    s = str(fecha_str).strip()
    for fmt_str in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d"):
        try:
            return datetime.strptime(s, fmt_str).timestamp()
        except ValueError:
            continue
    return 0.0


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


_FILE_WRITE_LOCK = threading.Lock()


def atomic_write_json(path, data, keep_backup=False):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with _FILE_WRITE_LOCK:
        fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), prefix=".tmp_", suffix=".json")
        try:
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                json.dump(data, f, indent=2, ensure_ascii=False)
                f.flush()
                os.fsync(f.fileno())
            if keep_backup and os.path.exists(path):
                shutil.copy2(path, path + ".bak")
            for attempt in range(5):
                try:
                    os.replace(tmp, path)
                    break
                except PermissionError:
                    if attempt == 4:
                        raise
                    time.sleep(0.04 * (attempt + 1))
        except Exception:
            if os.path.exists(tmp):
                try:
                    os.remove(tmp)
                except OSError:
                    pass
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
        self.history = self._load_history()
        self.rivers_cache = self._load_rivers_cache()
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

    def _load_history(self):
        empty = {"version": HISTORY_VERSION, "retention_days": HISTORY_RETENTION_DAYS, "updated": None, "stations": {}}
        if not os.path.exists(HISTORY_PATH):
            return empty
        try:
            raw = load_json(HISTORY_PATH)
            if not isinstance(raw, dict) or raw.get("version") != HISTORY_VERSION:
                return empty
            stations = raw.get("stations")
            if not isinstance(stations, dict):
                return empty
            cutoff = now().timestamp() - HISTORY_RETENTION_DAYS * 86400
            clean_stations = {}
            expired_by_year = {}
            for skey, st in stations.items():
                if not isinstance(st, dict):
                    continue
                valid_pts = [
                    p for p in (st.get("points") or [])
                    if isinstance(p, dict) and isinstance(p.get("ts"), (int, float))
                    and p.get("nivel") in ("CRITICO", "ADVERTENCIA", "PREVENTIVA")
                ]
                expired = [p for p in valid_pts if p["ts"] < cutoff]
                if expired:
                    self._collect_expired_points(expired_by_year, str(skey), st, expired)
                pts = [p for p in valid_pts if p["ts"] >= cutoff]
                if not pts:
                    continue
                pts.sort(key=lambda p: p["ts"])
                st_clean = dict(st)
                st_clean["points"] = pts[-MAX_HISTORY_POINTS_PER_STATION:]
                clean_stations[str(skey)] = st_clean
            if expired_by_year:
                self._archive_expired_history(expired_by_year)
            empty["updated"] = raw.get("updated")
            empty["stations"] = clean_stations
        except Exception as e:
            log.warning("alerts_history.json corrupto, se regenerará: %s", e)
        return empty

    def _save_history(self):
        with self._lock:
            snapshot = json.loads(json.dumps(self.history))
        try:
            atomic_write_json(HISTORY_PATH, snapshot)
        except Exception as e:
            log.error("No se pudo guardar alerts_history.json: %s", e)

    @staticmethod
    def _collect_expired_points(expired_by_year, skey, st, expired_pts):
        """Agrupa registros históricos expirados (> 1 año) por año calendario para archivarlos."""
        for p in expired_pts:
            ts = p.get("ts") or 0
            try:
                yr = datetime.fromtimestamp(ts).year
            except (OSError, OverflowError, ValueError):
                yr = now().year
            yr_map = expired_by_year.setdefault(yr, {})
            entry = yr_map.get(skey)
            if entry is None:
                entry = {
                    "key": st.get("key") or skey,
                    "codigo": st.get("codigo"),
                    "nombre": st.get("nombre"),
                    "tipo_elemento": st.get("tipo_elemento") or "estacion",
                    "comuna": st.get("comuna") or "",
                    "region_nombre": st.get("region_nombre") or "",
                    "unidad": st.get("unidad") or "",
                    "fuente": st.get("fuente") or "DGA oficial",
                    "umbrales": dict(st.get("umbrales") or {}),
                    "points": [],
                }
                yr_map[skey] = entry
            entry["points"].append(dict(p))

    @staticmethod
    def _read_archived_xlsx_stations(zip_path, inner_xlsx):
        """Lee la hoja 'Registros de Alertas' de un .xlsx archivado para fusionar nuevos puntos."""
        stations = {}
        with zipfile.ZipFile(zip_path, "r") as zin:
            if inner_xlsx not in zin.namelist():
                return stations
            xlsx_bytes = zin.read(inner_xlsx)
        with zipfile.ZipFile(io.BytesIO(xlsx_bytes), "r") as xz:
            if "xl/worksheets/sheet1.xml" not in xz.namelist():
                return stations
            root = ET.fromstring(xz.read("xl/worksheets/sheet1.xml"))
        ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
        rows = root.findall(".//m:sheetData/m:row", ns)
        for row_el in rows[1:]:
            vals = []
            for c_el in row_el.findall("m:c", ns):
                t_attr = c_el.attrib.get("t")
                if t_attr == "inlineStr":
                    t_el = c_el.find("m:is/m:t", ns)
                    vals.append(t_el.text if (t_el is not None and t_el.text is not None) else "")
                else:
                    v_el = c_el.find("m:v", ns)
                    if v_el is not None and v_el.text is not None:
                        try:
                            vals.append(float(v_el.text))
                        except ValueError:
                            vals.append(v_el.text)
                    else:
                        vals.append("")
            if len(vals) < 13:
                continue
            fecha, codigo, nombre, tipo_txt, comuna, region_nombre, nivel, val, umb, _diff, unidad, fuente, sinc = vals[:13]
            tipo_el = "embalse" if "embalse" in str(tipo_txt).lower() else "estacion"
            skey = f"{tipo_el}:{codigo}"
            st = stations.get(skey)
            if st is None:
                st = {
                    "key": skey,
                    "codigo": str(codigo),
                    "nombre": str(nombre),
                    "tipo_elemento": tipo_el,
                    "comuna": str(comuna),
                    "region_nombre": str(region_nombre),
                    "unidad": str(unidad),
                    "fuente": str(fuente),
                    "points": [],
                }
                stations[skey] = st
            st["points"].append({
                "ts": _alert_fecha_ts(fecha),
                "fecha": str(fecha),
                "sinc": str(sinc),
                "valor": val if isinstance(val, (int, float)) else None,
                "umbral": umb if isinstance(umb, (int, float)) else None,
                "nivel": str(nivel),
                "fuente": str(fuente),
                "unidad": str(unidad),
            })
        return stations

    def _archive_expired_history(self, expired_by_year):
        """Archiva registros que superan 1 año en formato .xlsx comprimido dentro de ZIP por año."""
        if not expired_by_year:
            return
        os.makedirs(HISTORY_ARCHIVE_DIR, exist_ok=True)
        for yr, new_stations in expired_by_year.items():
            zip_path = os.path.join(HISTORY_ARCHIVE_DIR, f"alerts_history_{yr}.zip")
            inner_xlsx = f"alerts_history_{yr}.xlsx"
            with _FILE_WRITE_LOCK:
                dst_stations = {}
                if os.path.exists(zip_path):
                    try:
                        dst_stations = self._read_archived_xlsx_stations(zip_path, inner_xlsx)
                    except Exception as e:
                        log.warning("No se pudo leer respaldo previo %s (%s); se creará nuevo.", zip_path, e)

                for skey, st_new in new_stations.items():
                    dst = dst_stations.get(skey)
                    if dst is None:
                        dst = {**st_new, "points": []}
                        dst_stations[skey] = dst
                    pts = dst.setdefault("points", [])
                    seen_keys = {
                        (p.get("fecha"), p.get("nivel"), p.get("valor"), p.get("fuente"))
                        for p in pts
                    }
                    for p in st_new.get("points") or []:
                        k = (p.get("fecha"), p.get("nivel"), p.get("valor"), p.get("fuente"))
                        if k not in seen_keys:
                            seen_keys.add(k)
                            pts.append(p)
                    pts.sort(key=lambda p: p.get("ts") or 0)

                stations_list = []
                for st in dst_stations.values():
                    pts = st.get("points") or []
                    if not pts:
                        continue
                    vals = [p["valor"] for p in pts if isinstance(p.get("valor"), (int, float))]
                    last_pt = pts[-1]
                    stations_list.append({
                        **st,
                        "last_nivel": last_pt.get("nivel") or "PREVENTIVA",
                        "max_nivel": max((p.get("nivel") for p in pts), key=lambda n: SEVERITY.get(n, 0)),
                        "last_valor": last_pt.get("valor"),
                        "last_umbral": last_pt.get("umbral"),
                        "last_fecha": last_pt.get("fecha") or "",
                        "stats": {
                            "min": round_num(min(vals), 3) if vals else None,
                            "max": round_num(max(vals), 3) if vals else None,
                            "count": len(pts),
                            "count_total": len(pts),
                            "critico_count": sum(1 for p in pts if p.get("nivel") == "CRITICO"),
                            "advertencia_count": sum(1 for p in pts if p.get("nivel") == "ADVERTENCIA"),
                            "preventiva_count": sum(1 for p in pts if p.get("nivel") == "PREVENTIVA"),
                        },
                    })
                stations_list.sort(key=lambda s: (-SEVERITY.get(s["last_nivel"], 0), -_alert_fecha_ts(s.get("last_fecha")), str(s.get("nombre") or "").lower()))

                xlsx_bytes = self._format_history_xlsx_bytes(stations_list)
                fd, tmp_zip = tempfile.mkstemp(dir=HISTORY_ARCHIVE_DIR, prefix=f".tmp_{yr}_", suffix=".zip")
                os.close(fd)
                try:
                    with zipfile.ZipFile(tmp_zip, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=9) as zout:
                        zout.writestr(inner_xlsx, xlsx_bytes)
                    for attempt in range(5):
                        try:
                            os.replace(tmp_zip, zip_path)
                            break
                        except PermissionError:
                            if attempt == 4:
                                raise
                            time.sleep(0.04 * (attempt + 1))
                    log.info("Historial anual %d archivado (.xlsx en ZIP): %s (%d estaciones)", yr, zip_path, len(stations_list))
                except Exception as e:
                    log.error("Error archivando historial anual %d en %s: %s", yr, zip_path, e)
                    if os.path.exists(tmp_zip):
                        try:
                            os.remove(tmp_zip)
                        except OSError:
                            pass

    def _load_rivers_cache(self):
        empty = {"version": RIVERS_CACHE_VERSION, "rivers": {}}
        if not os.path.exists(RIVERS_CACHE_PATH):
            return empty
        try:
            raw = load_json(RIVERS_CACHE_PATH)
            if isinstance(raw, dict) and raw.get("version") == RIVERS_CACHE_VERSION and isinstance(raw.get("rivers"), dict):
                return raw
        except Exception as e:
            log.warning("rivers_cache.json corrupto, se regenerará: %s", e)
        return empty

    def _save_rivers_cache(self):
        with self._lock:
            snapshot = json.loads(json.dumps(self.rivers_cache))
        try:
            atomic_write_json(RIVERS_CACHE_PATH, snapshot)
        except Exception as e:
            log.error("No se pudo guardar rivers_cache.json: %s", e)

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
            updated = False
            for reg in REGIONES:
                if self._stop.is_set():
                    return
                with self._lock:
                    cau = self.cache["caudales_by_region"].get(reg)
                if not cau or is_stale(cau.get("updated"), CAUDAL_TTL):
                    try:
                        self.fetch_caudales_region(reg)
                        updated = True
                        self.recompute_alerts()
                        self._save_cache()
                    except Exception as e:
                        log.warning("Caudal región %s: %s", reg, e)
                    time.sleep(0.8)
            if updated:
                self.recompute_alerts()
                self._save_cache()

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

    def _sync_arcgis_sources(self, force_embalses=False):
        """Sincroniza alertas oficiales y embalses DGA sin ocultar fallos reales de red."""
        errors = []
        arcgis_ok = True
        try:
            self.fetch_alertas_oficiales()
        except ArcGISUnavailableError as e:
            arcgis_ok = False
            with self._lock:
                cached_alerts = len(self.cache.get("alertas_oficiales") or [])
            log.warning("ArcGIS ALERTAS no disponible (%s); usando %d alertas en caché.", e, cached_alerts)
            errors.append(str(e))
        except Exception as e:
            arcgis_ok = False
            log.warning("Error sincronizando alertas oficiales: %s", e)
            errors.append(f"alertas oficiales: {e}")

        with self._lock:
            emb_stale = force_embalses or is_stale(self.cache.get("embalses_updated"), EMBALSE_TTL) or not self.cache.get("embalses")
        if arcgis_ok and emb_stale:
            try:
                self.fetch_embalses()
            except ArcGISUnavailableError as e:
                with self._lock:
                    cached_emb = len(self.cache.get("embalses") or [])
                log.warning("ArcGIS EMBALSES no disponible (%s); usando %d embalses en caché.", e, cached_emb)
                errors.append(str(e))
            except Exception as e:
                log.warning("Error sincronizando embalses: %s", e)
                errors.append(f"embalses: {e}")
        return arcgis_ok, errors

    def sync_realtime(self, force_embalses=False):
        """Sincronización ligera (< 2s) de alertas oficiales DGA y embalses."""
        if not self._sync_lock.acquire(blocking=False):
            return False
        try:
            self._last_realtime_attempt = time.time()
            arcgis_ok, errors = self._sync_arcgis_sources(force_embalses=force_embalses)
            with self._lock:
                if arcgis_ok:
                    self.cache["last_sync"] = iso(now())
                self.cache["last_error"] = "; ".join(errors)[:500] if errors else None
            self.recompute_alerts()
            self._save_cache()
            if arcgis_ok:
                self._run_bg("rivers", self.ensure_critical_river_geometries)
            log.info("Sincronización en vivo completa%s", f" con errores: {errors}" if errors else "")
            return arcgis_ok
        finally:
            self._sync_lock.release()

    def ensure_realtime_fresh(self):
        with self._lock:
            stale = is_stale(self.cache.get("alertas_oficiales_updated"), ALERTAS_TTL)
        if stale and (time.time() - self._last_realtime_attempt > 15):
            self._run_bg("realtime", self.sync_realtime)

    def sync_all(self, target_region=None, force_region=False):
        if not self._sync_lock.acquire(blocking=False):
            return False
        try:
            self._last_realtime_attempt = time.time()
            arcgis_ok, errors = self._sync_arcgis_sources(force_embalses=force_region)
            region_synced = False

            if target_region and target_region != "all" and target_region in REGIONES:
                try:
                    self.fetch_estaciones_region(target_region)
                    with self._lock:
                        cau = self.cache["caudales_by_region"].get(target_region)
                    if force_region or not cau or is_stale(cau.get("updated"), CAUDAL_TTL):
                        self.fetch_caudales_region(target_region)
                    region_synced = True
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
                        region_synced = True
                    if not cau or is_stale(cau.get("updated"), CAUDAL_TTL):
                        self.fetch_caudales_region(reg)
                        region_synced = True
                        time.sleep(0.5)
                except Exception as e:
                    errors.append(f"región {reg}: {e}")

            with self._lock:
                if arcgis_ok or region_synced:
                    self.cache["last_sync"] = iso(now())
                self.cache["last_error"] = "; ".join(errors)[:500] if errors else None
            self.recompute_alerts()
            self._save_cache()
            if arcgis_ok:
                self._run_bg("rivers", self.ensure_critical_river_geometries)
            log.info("Sincronización completa%s", f" con errores: {errors}" if errors else "")
            return arcgis_ok or region_synced
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
        with self._lock:                       # forzar refresco de embalses y alertas en sync manual
            self.cache["embalses_updated"] = None
            self.cache["alertas_oficiales_updated"] = None
        threading.Thread(target=self.sync_all, args=(region, True), name="manual-sync", daemon=True).start()
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

        alertas.sort(key=lambda a: (
            -SEVERITY.get(a["nivel_alerta"], 0),
            -_alert_fecha_ts(a.get("fecha")),
            str(a.get("nombre") or "").lower(),
        ))
        estado = {}
        for a in alertas:
            prev = estado.get(a["codigo"])
            if prev is None or SEVERITY[a["nivel_alerta"]] > SEVERITY[prev["nivel_alerta"]]:
                estado[a["codigo"]] = a
        with self._lock:
            self._alertas = alertas
            self._estado_por_codigo = estado
        self.record_alerts_history(alertas)
        return alertas

    def record_alerts_history(self, alertas):
        """Guarda temporalmente (30 días) alertas Críticas, Advertencia y Preventiva por estación."""
        now_dt = now()
        now_ts = now_dt.timestamp()
        now_iso = iso(now_dt)
        cutoff = now_ts - HISTORY_RETENTION_DAYS * 86400
        dirty = False

        expired_by_year = {}
        with self._lock:
            stations = self.history.setdefault("stations", {})
            station_meta = {}
            for reg in self.cache.get("estaciones_by_region", {}).values():
                for e in reg.get("items", []):
                    station_meta[e["codigo"]] = (e.get("comuna") or "", e.get("region_nombre") or "")

            for a in alertas:
                nivel = a.get("nivel_alerta")
                if nivel not in ("CRITICO", "ADVERTENCIA", "PREVENTIVA"):
                    continue
                tipo_el = a.get("tipo_elemento") or "estacion"
                codigo = base_code(a.get("codigo")) if tipo_el == "estacion" else str(a.get("codigo") or "").strip()
                if not codigo:
                    continue
                skey = f"{tipo_el}:{codigo}"
                pt_ts = _alert_fecha_ts(a.get("fecha"))
                if pt_ts <= 0:
                    pt_ts = now_ts
                if pt_ts < cutoff:
                    continue

                comuna, region_nombre = station_meta.get(codigo, ("", ""))
                st = stations.get(skey)
                if st is None:
                    st = {
                        "key": skey,
                        "codigo": codigo,
                        "nombre": a.get("nombre") or codigo,
                        "tipo_elemento": tipo_el,
                        "comuna": comuna,
                        "region_nombre": region_nombre,
                        "unidad": a.get("unidad") or "",
                        "fuente": a.get("fuente") or "DGA oficial",
                        "umbrales": {},
                        "points": [],
                    }
                    stations[skey] = st
                    dirty = True
                else:
                    if a.get("nombre") and st.get("nombre") != a.get("nombre"):
                        st["nombre"] = a["nombre"]
                        dirty = True
                    if comuna and not st.get("comuna"):
                        st["comuna"] = comuna
                    if region_nombre and not st.get("region_nombre"):
                        st["region_nombre"] = region_nombre
                    if a.get("unidad") and st.get("unidad") != a.get("unidad"):
                        st["unidad"] = a["unidad"]

                if a.get("umbral") is not None:
                    umbrales = st.setdefault("umbrales", {})
                    if umbrales.get(nivel) != a["umbral"]:
                        umbrales[nivel] = a["umbral"]
                        dirty = True

                pt = {
                    "ts": round(pt_ts, 3),
                    "fecha": a.get("fecha") or now_iso,
                    "sinc": a.get("sincronizado") or now_iso,
                    "valor": a.get("valor_actual"),
                    "umbral": a.get("umbral"),
                    "nivel": nivel,
                    "fuente": a.get("fuente") or "DGA oficial",
                    "unidad": a.get("unidad") or "",
                }
                pts = st.setdefault("points", [])
                dup = any(
                    p.get("fecha") == pt["fecha"]
                    and p.get("nivel") == pt["nivel"]
                    and p.get("valor") == pt["valor"]
                    and p.get("fuente") == pt["fuente"]
                    for p in pts
                )
                if not dup:
                    pts.append(pt)
                    pts.sort(key=lambda p: p.get("ts") or 0)
                    if len(pts) > MAX_HISTORY_POINTS_PER_STATION:
                        st["points"] = pts[-MAX_HISTORY_POINTS_PER_STATION:]
                    dirty = True

            for skey in list(stations.keys()):
                st = stations[skey]
                pts = st.get("points") or []
                expired = [p for p in pts if (p.get("ts") or 0) < cutoff]
                if expired:
                    self._collect_expired_points(expired_by_year, skey, st, expired)
                pruned = [p for p in pts if (p.get("ts") or 0) >= cutoff]
                if len(pruned) != len(pts):
                    dirty = True
                if not pruned:
                    stations.pop(skey, None)
                    dirty = True
                    continue
                st["points"] = pruned
                last_pt = pruned[-1]
                st["last_nivel"] = last_pt.get("nivel")
                st["last_valor"] = last_pt.get("valor")
                st["last_umbral"] = last_pt.get("umbral")
                st["last_fecha"] = last_pt.get("fecha")
                st["last_sincronizado"] = last_pt.get("sinc")
                st["max_nivel"] = max((p.get("nivel") for p in pruned), key=lambda n: SEVERITY.get(n, 0))

            if dirty:
                self.history["updated"] = now_iso

        if expired_by_year:
            self._archive_expired_history(expired_by_year)
        if dirty:
            self._save_history()

    def get_alerts_history(self, periodo="30d", codigo=None, nivel=None):
        """Retorna historial temporal (24h, 7d, 30d, 60d, 90d, 365d) de alertas por estación."""
        period_days = {"24h": 1, "7d": 7, "30d": 30, "60d": 60, "90d": 90, "365d": 365}
        if periodo not in period_days:
            periodo = "30d"
        days = period_days[periodo]
        self.ensure_realtime_fresh()

        now_dt = now()
        end_ts = now_dt.timestamp()
        start_ts = end_ts - days * 86400
        cutoff_max = end_ts - HISTORY_RETENTION_DAYS * 86400
        cutoff_30 = end_ts - 30 * 86400
        filter_nivel = nivel if nivel in ("CRITICO", "ADVERTENCIA", "PREVENTIVA") else None
        filter_code = base_code(codigo) if codigo else None

        stations_out = []
        with self._lock:
            cfg = self.config
            history_updated = self.history.get("updated")
            raw_stations = list((self.history.get("stations") or {}).values())
            for st in raw_stations:
                pts_max = [p for p in (st.get("points") or []) if (p.get("ts") or 0) >= cutoff_max]
                if not pts_max:
                    continue
                if filter_nivel and not any(p.get("nivel") == filter_nivel for p in pts_max):
                    continue

                win_pts = [p for p in pts_max if start_ts <= (p.get("ts") or 0) <= end_ts + 3600]
                pts_30 = [p for p in pts_max if (p.get("ts") or 0) >= cutoff_30]
                vals = [p["valor"] for p in win_pts if isinstance(p.get("valor"), (int, float))]
                umbrales = dict(st.get("umbrales") or {})
                unit = st.get("unidad") or ""
                if st.get("tipo_elemento") == "embalse" and unit == "Mm³":
                    rule = (cfg.get("embalses") or {}).get(st.get("codigo")) or {}
                    if rule.get("volumen_min") is not None:
                        umbrales.setdefault("CRITICO", rule["volumen_min"])
                    if rule.get("volumen_max") is not None:
                        umbrales.setdefault("ADVERTENCIA", rule["volumen_max"])
                elif st.get("tipo_elemento") == "estacion" and unit == "m³/s":
                    rule = (cfg.get("estaciones") or {}).get(base_code(st.get("codigo"))) or {}
                    if rule.get("caudal_max") is not None:
                        umbrales.setdefault("CRITICO", rule["caudal_max"])
                    if rule.get("caudal_min") is not None:
                        umbrales.setdefault("ADVERTENCIA", rule["caudal_min"])

                last_pt = win_pts[-1] if win_pts else pts_max[-1]
                last_nivel = last_pt.get("nivel") or st.get("last_nivel") or "PREVENTIVA"
                last_fecha = last_pt.get("fecha") or st.get("last_fecha")
                max_nivel = max(
                    (p.get("nivel") for p in (win_pts or pts_max)),
                    key=lambda n: SEVERITY.get(n, 0),
                )
                code_match = (filter_code is None) or (base_code(st.get("codigo")) == filter_code)
                stations_out.append({
                    "key": st.get("key") or f"{st.get('tipo_elemento', 'estacion')}:{st.get('codigo')}",
                    "codigo": st.get("codigo"),
                    "nombre": st.get("nombre") or st.get("codigo"),
                    "tipo_elemento": st.get("tipo_elemento") or "estacion",
                    "comuna": st.get("comuna") or "",
                    "region_nombre": st.get("region_nombre") or "",
                    "unidad": unit,
                    "fuente": st.get("fuente") or "DGA oficial",
                    "last_nivel": last_nivel,
                    "max_nivel": max_nivel,
                    "last_valor": last_pt.get("valor"),
                    "last_umbral": last_pt.get("umbral"),
                    "last_fecha": last_fecha,
                    "umbrales": umbrales,
                    "stats": {
                        "min": round_num(min(vals), 3) if vals else None,
                        "max": round_num(max(vals), 3) if vals else None,
                        "last": round_num(vals[-1], 3) if vals else None,
                        "count": len(win_pts),
                        "count_30d": len(pts_30),
                        "count_total": len(pts_max),
                        "critico_count": sum(1 for p in win_pts if p.get("nivel") == "CRITICO"),
                        "advertencia_count": sum(1 for p in win_pts if p.get("nivel") == "ADVERTENCIA"),
                        "preventiva_count": sum(1 for p in win_pts if p.get("nivel") == "PREVENTIVA"),
                    },
                    "points": win_pts if code_match else [],
                })

        stations_out.sort(key=lambda s: (
            0 if s["stats"]["count"] > 0 else 1,
            -SEVERITY.get(s["last_nivel"], 0),
            -_alert_fecha_ts(s.get("last_fecha")),
            str(s.get("nombre") or "").lower(),
        ))
        return {
            "retention_days": HISTORY_RETENTION_DAYS,
            "periodo": periodo,
            "window_start": iso(now_dt - timedelta(days=days)),
            "window_end": iso(now_dt),
            "updated": history_updated,
            "total_stations": len(stations_out),
            "stations": stations_out,
        }

    def _format_history_xlsx_bytes(self, stations_list, filter_code=None, filter_nivel=None):
        """Formatea la lista de estaciones y puntos históricos como libro Excel (.xlsx)."""
        detail_rows = [[
            "Fecha/Hora Medición", "Código BNA", "Estación / Río", "Tipo", "Comuna", "Región",
            "Nivel Alerta", "Valor Medido", "Umbral", "Diferencia", "Unidad", "Fuente", "Sincronizado",
        ]]
        raw_events = []
        for st in stations_list:
            if filter_code and base_code(st.get("codigo")) != filter_code:
                continue
            for p in st.get("points", []):
                if filter_nivel and p.get("nivel") != filter_nivel:
                    continue
                val = p.get("valor")
                umb = p.get("umbral")
                diff = round_num(val - umb, 3) if isinstance(val, (int, float)) and isinstance(umb, (int, float)) else None
                raw_events.append((
                    p.get("ts") or 0,
                    [
                        p.get("fecha") or "",
                        st.get("codigo") or "",
                        st.get("nombre") or "",
                        "Embalse" if st.get("tipo_elemento") == "embalse" else "Estación Fluviométrica",
                        st.get("comuna") or "",
                        st.get("region_nombre") or "",
                        p.get("nivel") or "",
                        val,
                        umb,
                        diff,
                        p.get("unidad") or st.get("unidad") or "",
                        p.get("fuente") or st.get("fuente") or "",
                        p.get("sinc") or "",
                    ],
                ))

        raw_events.sort(key=lambda item: -item[0])
        detail_rows.extend(row for _, row in raw_events)

        summary_rows = [[
            "Código BNA", "Estación / Río", "Tipo", "Comuna", "Región",
            "Último Nivel", "Máx Nivel", "Último Valor", "Último Umbral", "Unidad",
            "Mínimo Período", "Máximo Período", "Reg. Período", "Reg. 1 Año",
            "Críticas", "Advertencias", "Preventivas", "Última Medición",
        ]]
        for st in stations_list:
            if filter_code and base_code(st.get("codigo")) != filter_code:
                continue
            stats = st.get("stats") or {}
            summary_rows.append([
                st.get("codigo") or "",
                st.get("nombre") or "",
                "Embalse" if st.get("tipo_elemento") == "embalse" else "Estación Fluviométrica",
                st.get("comuna") or "",
                st.get("region_nombre") or "",
                st.get("last_nivel") or "",
                st.get("max_nivel") or "",
                st.get("last_valor"),
                st.get("last_umbral"),
                st.get("unidad") or "",
                stats.get("min"),
                stats.get("max"),
                stats.get("count", 0),
                stats.get("count_total", stats.get("count_30d", 0)),
                stats.get("critico_count", 0),
                stats.get("advertencia_count", 0),
                stats.get("preventiva_count", 0),
                st.get("last_fecha") or "",
            ])

        return _build_xlsx_workbook([
            ("Registros de Alertas", detail_rows),
            ("Resumen Estaciones", summary_rows),
        ])

    def build_alerts_history_xlsx(self, periodo="24h", codigo=None, nivel=None):
        """Genera planilla Excel (.xlsx) con los eventos y resumen del historial de alertas."""
        data = self.get_alerts_history(periodo=periodo, codigo=codigo, nivel=nivel)
        filter_nivel = nivel if nivel in ("CRITICO", "ADVERTENCIA", "PREVENTIVA") else None
        filter_code = base_code(codigo) if codigo else None
        return self._format_history_xlsx_bytes(data.get("stations", []), filter_code=filter_code, filter_nivel=filter_nivel)

    # ------------------------------------------------------------------ red hidrográfica MOP
    def _river_bbox_and_key(self, station_code, station_name, lat, lng):
        river_name = _extract_river_name(station_name)
        norm_river = _norm_text(river_name)
        _, est_meta = self._station_name(base_code(station_code))
        region = str((est_meta or {}).get("region") or "0")

        pts = [(float(lat), float(lng))]
        with self._lock:
            regs = [self.cache["estaciones_by_region"].get(region, {})] if region != "0" else list(self.cache["estaciones_by_region"].values())
            for r in regs:
                for st in r.get("items", []):
                    slat, slng = st.get("lat"), st.get("lng")
                    if slat is None or slng is None:
                        continue
                    if _norm_text(_extract_river_name(st.get("nombre"))) == norm_river:
                        pts.append((float(slat), float(slng)))

        min_lat = min(p[0] for p in pts) - 0.25
        max_lat = max(p[0] for p in pts) + 0.25
        min_lng = min(p[1] for p in pts) - 0.30
        max_lng = max(p[1] for p in pts) + 0.30
        if len(pts) == 1:
            min_lat, max_lat = float(lat) - 0.40, float(lat) + 0.40
            min_lng, max_lng = float(lng) - 0.45, float(lng) + 0.45

        key = f"{region}:{norm_river}"
        return key, river_name, norm_river, region, (min_lng, min_lat, max_lng, max_lat)

    def fetch_river_geometry(self, river_name, norm_river, lat, lng, bbox):
        """Consulta el trazado oficial del río en MAPA_BASE/RED_HIDROGRAFICA (1:250k)."""
        tokens = [re.sub(r"[^a-zA-Z0-9]", "", t) for t in norm_river.split()]
        tokens = [t for t in tokens if len(t) >= 3 and t not in ("rio", "estero", "quebrada", "arroyo", "canal", "lago", "laguna")]
        kw = max(tokens, key=len) if tokens else ""

        params_base = {
            "geometry": f"{bbox[0]:.4f},{bbox[1]:.4f},{bbox[2]:.4f},{bbox[3]:.4f}",
            "geometryType": "esriGeometryEnvelope",
            "inSR": 4326,
            "spatialRel": "esriSpatialRelIntersects",
            "outFields": "OBJECTID,NOMBRE,region",
            "outSR": 4326,
            "f": "json",
        }
        feats = []
        if kw:
            p = {**params_base, "where": f"UPPER(NOMBRE) LIKE '%{kw.upper()}%'"}
            r = self.session.get(ARCGIS_RED_HIDROGRAFICA, params=p, timeout=ARCGIS_TIMEOUT)
            r.raise_for_status()
            data = r.json()
            feats = [f for f in (data.get("features") or []) if _norm_text((f.get("attributes") or {}).get("NOMBRE")) == norm_river]
            if not feats:
                feats = [f for f in (data.get("features") or []) if kw in _norm_text((f.get("attributes") or {}).get("NOMBRE"))]

        if not feats:
            tight = f"{lng - 0.10:.4f},{lat - 0.10:.4f},{lng + 0.10:.4f},{lat + 0.10:.4f}"
            p = {**params_base, "geometry": tight}
            r = self.session.get(ARCGIS_RED_HIDROGRAFICA, params=p, timeout=ARCGIS_TIMEOUT)
            r.raise_for_status()
            data = r.json()
            best_name = None
            best_dist = 1e9
            all_feats = data.get("features") or []
            for f in all_feats:
                nm = _norm_text((f.get("attributes") or {}).get("NOMBRE"))
                if not nm:
                    continue
                for path in ((f.get("geometry") or {}).get("paths") or []):
                    for pt in path:
                        if len(pt) >= 2:
                            d = math.hypot(pt[1] - lat, pt[0] - lng)
                            if d < best_dist:
                                best_dist = d
                                best_name = nm
            if best_name and best_dist <= 0.025:
                feats = [f for f in all_feats if _norm_text((f.get("attributes") or {}).get("NOMBRE")) == best_name]

        raw_paths = []
        official_name = river_name
        for f in feats:
            nm = (f.get("attributes") or {}).get("NOMBRE")
            if nm:
                official_name = str(nm).strip()
            for path in ((f.get("geometry") or {}).get("paths") or []):
                if len(path) >= 2:
                    raw_paths.append(path)

        stitched = _stitch_paths(raw_paths)
        return official_name, stitched

    def ensure_critical_river_geometries(self):
        """Obtiene y cachea la geometría oficial de todos los ríos con alerta activa (Crítica, Advertencia, Preventiva)."""
        with self._lock:
            active_alerts = [
                dict(a) for a in self._alertas
                if a.get("nivel_alerta") in ("CRITICO", "ADVERTENCIA", "PREVENTIVA")
                and a.get("tipo_elemento") == "estacion"
                and a.get("lat") is not None and a.get("lng") is not None
            ]
        if not active_alerts:
            return

        dirty = False
        for a in active_alerts:
            key, river_name, norm_river, region, bbox = self._river_bbox_and_key(
                a.get("codigo"), a.get("nombre"), a["lat"], a["lng"]
            )
            if not norm_river:
                continue
            with self._lock:
                existing = (self.rivers_cache.get("rivers") or {}).get(key)
            if existing and existing.get("paths"):
                continue
            if existing and not is_stale(existing.get("updated"), timedelta(hours=6)):
                continue
            try:
                official_name, paths = self.fetch_river_geometry(river_name, norm_river, float(a["lat"]), float(a["lng"]), bbox)
                with self._lock:
                    self.rivers_cache.setdefault("rivers", {})[key] = {
                        "river_name": river_name,
                        "official_name": official_name,
                        "region": region,
                        "updated": iso(now()),
                        "paths": paths,
                    }
                dirty = True
                log.info("Geometría fluvial cacheada para %s (%d tramos)", official_name, len(paths))
            except Exception as e:
                log.info("No se pudo obtener geometría fluvial para %s: %s", river_name, e)
        if dirty:
            self._save_rivers_cache()

    def get_critical_river_geometries(self):
        with self._lock:
            active_alerts = [
                dict(a) for a in self._alertas
                if a.get("nivel_alerta") in ("CRITICO", "ADVERTENCIA", "PREVENTIVA")
                and a.get("tipo_elemento") == "estacion"
                and a.get("lat") is not None and a.get("lng") is not None
            ]
            rivers_map = dict(self.rivers_cache.get("rivers") or {})

        active_alerts.sort(key=lambda a: -SEVERITY.get(a.get("nivel_alerta"), 0))

        out = []
        missing = False
        seen = set()
        for a in active_alerts:
            key, river_name, norm_river, region, _ = self._river_bbox_and_key(
                a.get("codigo"), a.get("nombre"), a["lat"], a["lng"]
            )
            if key in seen:
                continue
            seen.add(key)
            entry = rivers_map.get(key)
            if entry and entry.get("paths"):
                out.append({
                    "key": key,
                    "codigo": a.get("codigo"),
                    "nivel_alerta": a.get("nivel_alerta"),
                    "river_name": river_name,
                    "official_name": entry.get("official_name") or river_name,
                    "region": region,
                    "paths": entry["paths"],
                    "source": "MOP Red Hidrográfica 1:250k",
                })
            elif not entry or is_stale(entry.get("updated"), timedelta(hours=6)):
                missing = True

        if missing:
            self._run_bg("rivers", self.ensure_critical_river_geometries)
        return out

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
                "total_historial_estaciones": len(self.history.get("stations") or {}),
                "cargando": bool(self._pending) or self._sync_lock.locked(),
            }


service = DGAService()

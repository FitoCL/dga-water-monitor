"""
DGA Water Monitor - servidor web.

Seguridad:
  * Por defecto escucha sólo en 127.0.0.1 (variable DGA_HOST para exponerlo en red).
  * Endpoints de escritura protegidos con token CSRF + verificación de Origin.
  * Token de administrador opcional (DGA_ADMIN_TOKEN) para modificar umbrales / sincronizar.
  * Validación estricta de entradas, límite de tamaño de petición y enfriamiento en /api/sync.
  * Cabeceras de seguridad (CSP sin scripts inline, anti-clickjacking, nosniff, etc.).
  * Servidor WSGI de producción (waitress) si está instalado.
"""

import hmac
import logging
import os
import re
import secrets
from urllib.parse import urlparse

from flask import Flask, abort, jsonify, render_template, request
from werkzeug.exceptions import HTTPException

from dga_service import CODE_RE, DATA_DIR, REGIONES, finite_number, service

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
log = logging.getLogger("app")

app = Flask(__name__)
app.config.update(
    MAX_CONTENT_LENGTH=8 * 1024,          # 8 KB: suficiente para cualquier petición legítima
    JSON_SORT_KEYS=False,
    TEMPLATES_AUTO_RELOAD=True,
)


def _load_or_create_csrf():
    path = os.path.join(DATA_DIR, ".csrf_token")
    os.makedirs(DATA_DIR, exist_ok=True)
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                tok = f.read().strip()
            if len(tok) >= 32:
                return tok
        except OSError:
            pass
    tok = secrets.token_urlsafe(32)
    with open(path, "w", encoding="utf-8") as f:
        f.write(tok)
    return tok


CSRF_TOKEN = _load_or_create_csrf()              # persiste entre reinicios del servidor
ADMIN_TOKEN = os.environ.get("DGA_ADMIN_TOKEN", "").strip() or None
SYNC_INTERVAL = max(30, int(os.environ.get("DGA_SYNC_INTERVAL", "60")))
REGION_PARAM = set(REGIONES) | {"all"}

CSP = "; ".join([
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",       # Leaflet aplica estilos inline a los marcadores
    "img-src 'self' data: blob: https: http:",
    "font-src 'self'",
    "connect-src 'self' https: http:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
])


# ----------------------------------------------------------------------------- seguridad
@app.after_request
def security_headers(resp):
    resp.headers["Content-Security-Policy"] = CSP
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    resp.headers["Permissions-Policy"] = "geolocation=(), camera=(), microphone=(), payment=()"
    resp.headers["Cache-Control"] = "no-store, no-cache, must-revalidate, max-age=0"
    resp.headers.pop("Server", None)
    return resp


def _same_origin():
    origin = request.headers.get("Origin") or request.headers.get("Referer")
    if not origin:
        return False
    o = urlparse(origin)
    return o.scheme in ("http", "https") and o.netloc == request.host


def require_write_access():
    """Protección para endpoints que modifican estado."""
    if not _same_origin():
        abort(403, description="Origen no permitido.")
    sent = request.headers.get("X-CSRF-Token", "")
    if not hmac.compare_digest(sent, CSRF_TOKEN):
        abort(403, description="Token CSRF inválido. Recarga la página.")
    if ADMIN_TOKEN:
        admin = request.headers.get("X-Admin-Token", "")
        if not hmac.compare_digest(admin, ADMIN_TOKEN):
            abort(401, description="Se requiere token de administrador.")


@app.errorhandler(HTTPException)
def http_error(e):
    return jsonify({"error": e.name, "mensaje": e.description}), e.code


@app.errorhandler(Exception)
def unhandled(e):
    log.exception("Error no controlado")
    return jsonify({"error": "Error interno", "mensaje": "Ocurrió un error inesperado."}), 500


# ----------------------------------------------------------------------------- vistas
@app.route("/")
def index():
    return render_template("index.html", csrf_token=CSRF_TOKEN, admin_required=bool(ADMIN_TOKEN),
                           regiones=sorted(REGIONES.items(), key=lambda kv: int(kv[0])))


@app.route("/api/health")
def health():
    return jsonify({"status": "ok"})


@app.route("/api/summary")
def get_summary():
    return jsonify(service.summary())


@app.route("/api/embalses")
def get_embalses():
    return jsonify(service.get_embalses())


@app.route("/api/estaciones")
def get_estaciones():
    region = request.args.get("region", "all")
    if region not in REGION_PARAM:
        abort(400, description="Región inválida.")
    if region == "all":
        service.ensure_all_regions()
    else:
        service.ensure_region(region)
    resp = jsonify(service.get_estaciones(region))
    resp.headers["X-DGA-Loading"] = "true" if service.is_loading() else "false"
    return resp


@app.route("/api/estaciones/<codigo>")
def get_estacion_detalle(codigo):
    if not CODE_RE.match(codigo):
        abort(400, description="Código de estación inválido.")
    return jsonify(service.get_estacion_detalle(codigo))


@app.route("/api/alertas")
def get_alertas():
    return jsonify(service.get_alertas())


@app.route("/api/alertas/historial")
def get_alertas_historial():
    periodo = request.args.get("periodo", "30d").strip()
    if periodo not in ("24h", "7d", "30d"):
        abort(400, description="Periodo inválido. Usa 24h, 7d o 30d.")
    codigo = request.args.get("codigo", "").strip() or None
    if codigo and not CODE_RE.match(codigo):
        abort(400, description="Código de estación inválido.")
    nivel = request.args.get("nivel", "ALL").strip().upper()
    if nivel not in ("ALL", "CRITICO", "ADVERTENCIA", "PREVENTIVA"):
        abort(400, description="Nivel inválido.")
    return jsonify(service.get_alerts_history(periodo=periodo, codigo=codigo, nivel=None if nivel == "ALL" else nivel))


@app.route("/api/umbrales", methods=["GET"])
def get_umbrales():
    return jsonify(service.get_config())


@app.route("/api/umbrales", methods=["POST"])
def post_umbrales():
    require_write_access()
    data = request.get_json(silent=True)
    if not isinstance(data, dict):
        abort(400, description="Se esperaba un cuerpo JSON.")

    tipo = data.get("tipo")
    codigo = str(data.get("codigo", "")).strip()
    if tipo not in ("embalse", "estacion"):
        abort(400, description="Tipo inválido.")
    if not CODE_RE.match(codigo):
        abort(400, description="Código inválido.")
    if not service.known_code(tipo, codigo):
        abort(404, description="La estación o embalse no existe en el catálogo cargado.")

    kmin, kmax = ("volumen_min", "volumen_max") if tipo == "embalse" else ("caudal_min", "caudal_max")
    try:
        vmin = finite_number(data.get(kmin))
        vmax = finite_number(data.get(kmax))
    except (TypeError, ValueError):
        abort(400, description="Los umbrales deben ser números entre 0 y 1.000.000.")
    if vmin is not None and vmax is not None and vmin >= vmax:
        abort(400, description="El umbral mínimo debe ser menor que el máximo.")

    nombre = re.sub(r"[<>\"'`]", "", str(data.get("nombre", codigo)))[:120]
    regla = service.update_threshold(tipo, codigo, vmin, vmax, nombre)
    return jsonify({"status": "ok", "regla": regla})


@app.route("/api/sync", methods=["POST"])
def force_sync():
    require_write_access()
    data = request.get_json(silent=True) or {}
    region = data.get("region") if isinstance(data, dict) else None
    if region not in REGION_PARAM:
        region = None
    ok, msg = service.request_sync(region=region)
    return jsonify({"status": "ok" if ok else "rechazado", "mensaje": msg}), (202 if ok else 429)


# ----------------------------------------------------------------------------- arranque
def main():
    host = os.environ.get("DGA_HOST", "127.0.0.1")
    port = int(os.environ.get("DGA_PORT", "5000"))
    if host not in ("127.0.0.1", "localhost") and not ADMIN_TOKEN:
        log.warning("El servidor se expone en %s SIN DGA_ADMIN_TOKEN: cualquiera en la red podrá "
                    "modificar umbrales. Define DGA_ADMIN_TOKEN para protegerlo.", host)
    service.start_scheduler(SYNC_INTERVAL)
    log.info("DGA Water Monitor en http://%s:%d (sincronización cada %d s)", host, port, SYNC_INTERVAL)
    try:
        from waitress import serve
        serve(app, host=host, port=port, threads=8, ident=None)
    except ImportError:
        log.warning("waitress no instalado; usando servidor de desarrollo de Flask.")
        app.run(host=host, port=port, debug=False)


if __name__ == "__main__":
    main()

"""
DGA Water Monitor Client
Cliente para monitorear caudales, niveles de ríos y embalses de la DGA - MOP Chile.
Obtenido mediante ingeniería inversa a https://mapas2.mop.gob.cl y servicios SIT MOP.
"""

import requests
import re
import urllib3
import json
import zipfile
import io
from datetime import datetime

urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


class DGAClient:
    def __init__(self):
        self.session = requests.Session()
        self.session.verify = False
        self.base_url = "https://mapas2.mop.gob.cl"
        self.arcgis_base = "https://rest-sit.mop.gob.cl/arcgis/rest/services/DGA"
        self.headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": f"{self.base_url}/",
            "Origin": self.base_url,
            "X-Requested-With": "XMLHttpRequest"
        }
        self.csrf_token = None

    def refresh_csrf_token(self):
        """Obtiene un nuevo token CSRF de la página principal de mapas2."""
        r = self.session.get(f"{self.base_url}/", headers={"User-Agent": self.headers["User-Agent"]}, timeout=15)
        r.raise_for_status()
        match = re.search(r'csrf_token\s*[:=]\s*["\']([^"\']+)["\']', r.text)
        if not match:
            raise ValueError("No se pudo extraer el CSRF token de mapas2.mop.gob.cl")
        self.csrf_token = match.group(1)
        return self.csrf_token

    def _ensure_csrf(self):
        if not self.csrf_token:
            self.refresh_csrf_token()

    def get_estaciones(self, region="13", fluviometricas=True, meteorologicas=False, activas=1):
        """
        Obtiene el listado de estaciones según región y tipo.
        region: '0' para todas, o ID de región ('13' para Metropolitana, '5' Valparaíso, etc.)
        activas: 1 (Activas), 0 (Inactivas), 2 (Ambas)
        """
        self._ensure_csrf()
        payload = {
            "esactiva": str(activas),
            "region": str(region),
            "selecciona_tipo": "1" if (fluviometricas or meteorologicas) else "0",
            "fluviometricas": "1" if fluviometricas else "0",
            "meteorologicas": "1" if meteorologicas else "0",
            "sedimentometricas": "0",
            "calidad_agua": "0",
            "control_pozo": "0",
            "csrf_token": self.csrf_token
        }
        post_headers = self.headers.copy()
        post_headers["X-CSRF-TOKEN"] = self.csrf_token
        post_headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"

        resp = self.session.post(f"{self.base_url}/AplicarFiltros", data=payload, headers=post_headers, timeout=20)
        resp.raise_for_status()
        return resp.json()

    def get_estacion_detalle(self, cod_estacion):
        """
        Consulta las mediciones puntuales de caudal, nivel y precipitaciones para una estación.
        """
        self._ensure_csrf()
        payload = {
            "id_estacion": str(cod_estacion),
            "csrf_token": self.csrf_token
        }
        post_headers = self.headers.copy()
        post_headers["X-CSRF-TOKEN"] = self.csrf_token
        post_headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8"

        resp = self.session.post(f"{self.base_url}/BuscaPunto", data=payload, headers=post_headers, timeout=15)
        resp.raise_for_status()
        data = resp.json()
        return data[0] if data else {}

    def get_embalses(self):
        """
        Consulta el servicio oficial ArcGIS DGA para todos los embalses de Chile.
        Retorna niveles de agua y volúmenes almacenados en millones de m³.
        """
        query_url = f"{self.arcgis_base}/ESTACION_EMBALSE/MapServer/0/query"
        params = {
            "where": "1=1",
            "outFields": "*",
            "f": "json",
            "returnGeometry": "true"
        }
        resp = self.session.get(query_url, params=params, timeout=15)
        resp.raise_for_status()
        data = resp.json()

        embalses = []
        for feature in data.get("features", []):
            attrs = feature.get("attributes", {})
            geom = feature.get("geometry", {})
            
            # Formatear fecha
            fecmed = attrs.get("SITMOP_PROD.SITMOP_DESA.TI_DGA_EMBALSE.fecmed")
            fecha_str = datetime.fromtimestamp(fecmed / 1000).strftime('%Y-%m-%d %H:%M') if fecmed else None

            embalses.append({
                "codigo": attrs.get("SITMOP_PROD.SITMOP_DESA.TG_RED_HIDROMETEO.CODBNA"),
                "nombre": attrs.get("SITMOP_PROD.SITMOP_DESA.TG_RED_HIDROMETEO.NOMBRERED"),
                "tipo_medicion": attrs.get("SITMOP_PROD.SITMOP_DESA.TG_RED_HIDROMETEO.MEDICION"),
                "nivel_metros": attrs.get("SITMOP_PROD.SITMOP_DESA.TI_DGA_EMBALSE.nivel"),
                "volumen_millones_m3": attrs.get("SITMOP_PROD.SITMOP_DESA.TI_DGA_EMBALSE.volumen"),
                "porcentaje": attrs.get("SITMOP_PROD.SITMOP_DESA.TI_DGA_EMBALSE.porcentaje"),
                "fecha_medicion": fecha_str,
                "x": geom.get("x"),
                "y": geom.get("y")
            })
        return embalses

    def download_historico_caudal(self, region="13", diario=True):
        """
        Descarga el reporte masivo de caudales históricos (.zip) de una región (o 0 para todo el país).
        diario=True -> caudal_diario_historico
        diario=False -> caudal_medio_mensual_historico
        """
        tipo = "caudal_diario_historico" if diario else "caudal_medio_mensual_historico"
        url = f"{self.base_url}/{tipo}_{region}.zip" if str(region) != "0" else f"{self.base_url}/{tipo}.zip"

        resp = self.session.get(url, timeout=30)
        resp.raise_for_status()

        z = zipfile.ZipFile(io.BytesIO(resp.content))
        filename = z.namelist()[0]
        content = z.read(filename).decode("utf-8", errors="ignore")
        return content


if __name__ == "__main__":
    client = DGAClient()

    print("=== 1. EMBALSES (DGA / MOP) ===")
    embalses = client.get_embalses()
    print(f"Total embalses registrados: {len(embalses)}")
    for emb in embalses[:5]:
        print(f" • {emb['nombre'].title()} ({emb['codigo']}): Nivel = {emb['nivel_metros']} m, Volumen = {emb['volumen_millones_m3']} Mm³ [Fecha: {emb['fecha_medicion']}]")

    print("\n=== 2. ESTACIONES FLUVIOMÉTRICAS (Ríos y Caudales en RM) ===")
    estaciones = client.get_estaciones(region="13", fluviometricas=True)
    print(f"Total estaciones fluviométricas encontradas: {len(estaciones)}")
    for est in estaciones[:5]:
        print(f" • [{est['cod_estacion']}] {est['gls_estacion']} ({est['glosa_comuna']})")
        # Obtener detalle de la estación
        detalle = client.get_estacion_detalle(est['cod_estacion'])
        cmm = detalle.get('caudal_medio_mensual')
        cd = detalle.get('caudal_diario')
        nep = detalle.get('nivel_nep')
        print(f"    - Caudal mensual: {cmm} m³/s | Caudal diario: {cd} m³/s | Nivel: {nep} m")

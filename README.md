# DGA Water Monitor

Aplicación web en Python (Flask + Waitress) y Leaflet para monitorear en tiempo real estaciones fluviométricas (ríos y caudales), embalses y alertas oficiales de la Dirección General de Aguas (DGA - MOP Chile).

## Características

- **Mapa interactivo en Dark Mode por defecto** con selector de estilos gratuitos (OSM Oscuro, Topográfico Oscuro, Gris Oscuro Esri, OSM Claro, Topográfico Claro y Satelital).
- **Alertas oficiales DGA en tiempo real** (`rest-sit.mop.gob.cl`, servicio `DGA/ALERTAS`) con niveles *Preventiva (Azul)*, *Advertencia (Amarilla)* y *Crítica (Roja)*, sonido de alerta configurable y actualización automática cada 60 segundos.
- **Catálogo nacional de estaciones (16 regiones)** activas, inactivas y sin registro, junto con el último caudal diario (`mapas2.mop.gob.cl`) y monitoreo de embalses (`DGA/ESTACION_EMBALSE`).
- **Tarjetas KPI dinámicas** que segmentan el mapa y las listas al hacer clic.
- **Umbrales personalizables** por estación o embalse con persistencia atómica en `data/alerts_config.json`.
- **Seguridad:** verificación TLS habilitada, protección CSRF + `Origin`, validación de entradas, cabeceras CSP y assets de Leaflet/FontAwesome servidos localmente.
- **Diseño responsivo** para escritorio, tablet y móvil.

## Instalación y uso

```bash
pip install -r requirements.txt
python app.py
```

Abre en tu navegador: `http://127.0.0.1:5000`

### Variables de entorno opcionales

| Variable | Por defecto | Descripción |
| --- | --- | --- |
| `DGA_HOST` | `127.0.0.1` | Interfaz de escucha (`0.0.0.0` para red local) |
| `DGA_PORT` | `5000` | Puerto HTTP |
| `DGA_SYNC_INTERVAL` | `60` | Intervalo de sincronización automática en segundos (mínimo `30`) |
| `DGA_ADMIN_TOKEN` | *(vacío)* | Token opcional para proteger `POST /api/umbrales` y `POST /api/sync` |

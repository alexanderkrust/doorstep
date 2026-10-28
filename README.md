# doorstep

Self-hosted Adress-Autosuggest-API auf Basis von OpenStreetMap.
Ein Docker-Image, keine externen Dienste: der Index ist eine SQLite-Datei (FTS5 + R\*Tree) unter `/data`.

> Status: Phase 1 (Projekt-Setup). Siehe [ROADMAP.md](ROADMAP.md).

## Entwicklung

Voraussetzung: Node.js ≥ 22.

```bash
npm install
npm run dev        # API mit Auto-Reload auf Port 2322
npm test           # Vitest
npm run lint       # ESLint + Prettier-Check
npm run build      # TypeScript nach dist/
npm run ci         # lint, typecheck, test, build
```

Healthcheck: `curl http://localhost:2322/health`

## Konfiguration (Umgebungsvariablen)

| Variable       | Default                                                       | Beschreibung                                                 |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------------ |
| `REGION_URL`   | `https://download.geofabrik.de/europe/germany-latest.osm.pbf` | Geofabrik-Extrakt für den Import                             |
| `HOST`         | `0.0.0.0`                                                     | Bind-Adresse der API                                         |
| `PORT`         | `2322`                                                        | Port der API                                                 |
| `DATA_DIR`     | `/data`                                                       | Verzeichnis für Extrakt und Index (absoluter Pfad)           |
| `DEFAULT_LANG` | `de`                                                          | Standardsprache (zweistelliger Code)                         |
| `RATE_LIMIT`   | `60`                                                          | Anfragen pro Minute und IP, `0` = aus                        |
| `CORS_ORIGINS` | `*`                                                           | Kommagetrennte Liste erlaubter Origins                       |
| `LOG_LEVEL`    | `info`                                                        | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent` |

Ungültige Werte führen beim Start zu einer Fehlermeldung mit allen betroffenen Variablen.

## Lizenz der Daten

Die Daten stammen von OpenStreetMap: © OpenStreetMap contributors, verfügbar unter der
[Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).

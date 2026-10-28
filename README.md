# doorstep

Self-hosted Adress-Autosuggest-API auf Basis von OpenStreetMap.
Ein Docker-Image, keine externen Dienste: der Index ist eine SQLite-Datei (FTS5 + R\*Tree) unter `/data`.

> Status: Phase 3 (Such-API). Siehe [ROADMAP.md](ROADMAP.md).

## Entwicklung

Voraussetzung: Node.js ≥ 24 (eingebautes `node:sqlite` mit FTS5 und R\*Tree) und für den Import
[`osmium-tool`](https://osmcode.org/osmium-tool/) (macOS: `brew install osmium-tool`, Debian: `apt install osmium-tool`).

```bash
npm install
npm run dev        # API mit Auto-Reload auf Port 2322
npm test           # Vitest
npm run lint       # ESLint + Prettier-Check
npm run build      # TypeScript nach dist/
npm run ci         # lint, typecheck, test, build
```

Healthcheck: `curl http://localhost:2322/health`

## Import

```bash
DATA_DIR=$PWD/data npm run import -- --region https://download.geofabrik.de/europe/germany/bremen-latest.osm.pbf
DATA_DIR=$PWD/data npm run import -- --input ./mein-extrakt.osm.pbf   # lokale Datei, ohne Download
```

Ohne `--region` gilt `REGION_URL`. Ablauf:

1. Download nach `$DATA_DIR/extract.osm.pbf`. Abgebrochene Downloads werden fortgesetzt
   (`extract.osm.pbf.part`), die Geofabrik-`.md5` wird geprüft. Passt eine vorhandene Datei
   zur `.md5`, wird nicht neu geladen.
2. `osmium tags-filter` auf Adressen, Orte (`place=*`), Straßen (`highway` mit Namen) und
   benannte `amenity`-Objekte.
3. `osmium export` als GeoJSON-Sequenz, die zeilenweise gelesen wird (konstanter Speicherbedarf).
4. Aufbau von `index.next.sqlite` (Tabelle `places`, FTS5-Tabelle `places_fts` mit Präfix-Index,
   R\*Tree `places_rtree`, Tabelle `meta`) und atomarer Austausch gegen `index.sqlite`.

Richtwert: Der Bremen-Extrakt (21 MB) ergibt rund 177.000 Einträge in etwa 5 Sekunden.

## API

Alle Antworten sind GeoJSON-`FeatureCollection`s und enthalten das Feld
`attribution` ("© OpenStreetMap contributors"). Erfolgreiche Antworten tragen
`Cache-Control: public, max-age=3600`, Fehler `no-store`.

### `GET /api` – Autosuggest

| Parameter    | Pflicht | Beschreibung                                                        |
| ------------ | ------- | ------------------------------------------------------------------- |
| `q`          | ja      | Suchtext, mindestens 2 Zeichen                                      |
| `limit`      | nein    | 1–10, Default 5                                                     |
| `lat`, `lon` | nein    | Nur gemeinsam; bei gleichem Typ werden nahe Treffer bevorzugt       |
| `lang`       | nein    | Zweistelliger Sprachcode, Default `DEFAULT_LANG` (wirkt ab Phase 4) |

Das letzte Wort wird als Präfix gesucht, alle anderen exakt. Findet die Anfrage nichts, wird das
letzte Wort um bis zu zwei Zeichen gekürzt (Tippfehler am Wortende).

```bash
curl 'http://localhost:2322/api?q=K%C3%B6nigsall&limit=3'
```

### `GET /reverse` – nächstes Objekt zu einem Punkt

| Parameter    | Pflicht | Beschreibung                            |
| ------------ | ------- | --------------------------------------- |
| `lat`, `lon` | ja      | Koordinate in WGS84                     |
| `limit`      | nein    | 1–10, Default 1                         |
| `radius`     | nein    | Suchradius in km, > 0 bis 10, Default 1 |

Ungültige Parameter liefern `400` mit einer Meldung wie `q: muss mindestens 2 Zeichen lang sein`.
Solange noch kein Index unter `$DATA_DIR/index.sqlite` liegt, antworten beide Endpunkte mit `503`.

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

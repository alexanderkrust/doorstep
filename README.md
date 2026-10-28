# doorstep

Self-hosted Adress-Autosuggest-API auf Basis von OpenStreetMap.
Ein Docker-Image, keine externen Dienste: der Index ist eine SQLite-Datei (FTS5 + R\*Tree) unter `/data`.

> Status: Phase 5 (Docker). Siehe [ROADMAP.md](ROADMAP.md).

## Schnellstart mit Docker

```bash
docker build -t meine-api .
docker run -p 2322:2322 -v data:/data meine-api
```

Beim ersten Start liegt noch kein Index im Volume. Die API startet trotzdem sofort und lädt im
Hintergrund den Extrakt aus `REGION_URL` (Default: Deutschland, rund 4,5 GB) und baut den Index.
Bis dahin antwortet `/api` mit `503`, `/health` zeigt den Stand (`"index": false, "importing": true`).
Danach liefert die API Vorschläge:

```bash
curl 'http://localhost:2322/api?q=K%C3%B6nigsall&limit=3'
```

Für einen schnellen Test eine kleinere Region wählen (Bremen: 21 MB, Import in Sekunden):

```bash
docker run -p 2322:2322 -v data:/data \
  -e REGION_URL=https://download.geofabrik.de/europe/germany/bremen-latest.osm.pbf \
  meine-api
```

Der Import läuft nur, solange das Volume keinen Index enthält. Für eine andere Region daher ein
neues Volume nehmen oder `import --region <url>` ausführen.

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

Healthcheck: `curl http://localhost:2322/health` liefert `status`, `version`, `uptime`,
`index` (nutzbarer Index vorhanden), `importing` (Import läuft im Hintergrund) und `attribution`.

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
| `lat`, `lon` | nein    | Nur gemeinsam; Treffer in der Nähe werden angehoben (Location Bias) |
| `lang`       | nein    | Zweistelliger Sprachcode, Default `DEFAULT_LANG`                    |

Das letzte Wort wird als Präfix gesucht, alle anderen exakt. Findet die Anfrage nichts, wird das
letzte Wort um bis zu zwei Zeichen gekürzt (Tippfehler am Wortende). Gibt es die gesuchte
Hausnummer nicht, kommt die Straße zurück.

**Normalisierung** (Import und Suche gleich, `src/search/normalize.ts`): Kleinschreibung,
`ä` ↔ `ae`, `ß` ↔ `ss`, andere Akzente entfernt, `Str.` ↔ `Straße`, `60 d` → `60d`. Zusätzlich
wird die Schreibweise ohne Umlaut-e indexiert, sodass auch `Dusseldorf` Düsseldorf findet.

**Ranking** (`src/search/ranking.ts`): Aus bis zu 100 Kandidaten (bei `lat/lon` zusätzlich bis zu
100 im Umkreis von 25 km) wird ein Score aus FTS-Relevanz (`bm25`), Übereinstimmung mit dem Namen,
`importance` (Stadt vor Ortsteil vor Straße vor Hausnummer) und – falls angegeben – der Nähe zum
Standort berechnet. Gleichnamige Treffer im Abstand bis 2 km (z. B. die Abschnitte einer Straße)
werden zu einem zusammengefasst.

**Sprachen:** `name:de` und `name:en` werden beim Import getrennt gespeichert und alle Varianten
durchsucht. `lang=de|en` wählt den angezeigten Namen, sonst gilt `name`.

Die Suchdauer steht im Antwort-Header `Server-Timing` (z. B. `search;dur=1.84`).

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
Das gilt auch für einen Index mit altem Schema (vor Phase 4): dann bitte neu importieren.

## Qualität und Latenz

- **Golden-Queries:** `test/golden/duesseldorf.json` enthält Suchanfragen mit erwarteten
  Top-Treffern gegen einen Ausschnitt aus Düsseldorf und Neuss. Sie laufen mit `npm test`.
- **Benchmark:** misst die Suchdauer direkt auf einem Index (Golden-Queries plus jedes
  Tipp-Präfix typischer Eingaben, mit und ohne Standort). Ziel: p95 unter 50 ms.

```bash
npm run bench -- --index $PWD/data/index.sqlite
```

Messung (MacBook, Node 24, Regierungsbezirk Düsseldorf: 217 MB PBF → 1,4 Mio. Einträge, 389 MB
Index, Import 45 s): p50 2,0 ms, p95 10,1 ms, p99 16,6 ms. Auf dem Deutschland-Index ist die
Messung noch offen. Bekannte Kosten, die mit der Datenmenge wachsen: `bm25` zählt für jedes
Suchwort alle Dokumente (sehr häufige Wörter wie „straße“), und Präfixe über 4 Zeichen
häufiger Wörter („stras…“) werden komplett zusammengeführt.

## Konfiguration (Umgebungsvariablen)

| Variable       | Default                                                       | Beschreibung                                                  |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| `REGION_URL`   | `https://download.geofabrik.de/europe/germany-latest.osm.pbf` | Geofabrik-Extrakt für den Import                              |
| `HOST`         | `0.0.0.0`                                                     | Bind-Adresse der API                                          |
| `PORT`         | `2322`                                                        | Port der API                                                  |
| `DATA_DIR`     | `/data`                                                       | Verzeichnis für Extrakt und Index (absoluter Pfad)            |
| `DEFAULT_LANG` | `de`                                                          | Standardsprache (zweistelliger Code)                          |
| `RATE_LIMIT`   | `60`                                                          | Anfragen pro Minute und IP, `0` = aus                         |
| `CORS_ORIGINS` | `*`                                                           | Kommagetrennte Liste erlaubter Origins                        |
| `LOG_LEVEL`    | `info`                                                        | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`  |
| `AUTO_IMPORT`  | `false` (im Docker-Image `true`)                              | `serve` importiert im Hintergrund, falls kein Index existiert |

Ungültige Werte führen beim Start zu einer Fehlermeldung mit allen betroffenen Variablen.

Beispiel für den Container:

```bash
docker run -d --restart unless-stopped -p 8080:8080 -v data:/data \
  -e PORT=8080 \
  -e REGION_URL=https://download.geofabrik.de/europe/germany/nordrhein-westfalen-latest.osm.pbf \
  -e CORS_ORIGINS=https://www.example.com,https://shop.example.com \
  -e DEFAULT_LANG=en -e LOG_LEVEL=warn \
  meine-api
```

`RATE_LIMIT` wird bereits validiert, greift aber erst ab Phase 6.

## Docker

Das `Dockerfile` baut in mehreren Stufen: TypeScript-Build, Produktions-Abhängigkeiten und ein
schlankes Laufzeit-Image auf `node:24.22.1-trixie-slim` (Debian 13) mit `osmium-tool`. SQLite ist
als `node:sqlite` in Node enthalten (mit FTS5 und R\*Tree); native Module werden nicht gebaut.

- Läuft als Nutzer `node` (uid 1000), nicht als root.
- `/data` ist ein `VOLUME` und enthält `extract.osm.pbf` und `index.sqlite`. Bei einem
  Bind-Mount (`-v $PWD/data:/data`) muss das Verzeichnis für uid 1000 beschreibbar sein.
- Port `2322`, `HEALTHCHECK` gegen `/health` (alle 30 s). `/health` antwortet, sobald die API
  läuft, auch während des ersten Imports.
- Schlägt der automatische Import fehl, beendet sich der Container mit Exit-Code 1. Mit
  `--restart unless-stopped` startet Docker ihn neu, und der Import wird wiederholt; ein
  abgebrochener Download wird dabei fortgesetzt.

### Kommandos

| Kommando                                    | Beschreibung                                                                                      |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `serve` (Standard)                          | API starten; ohne Index läuft der Import im Hintergrund (`AUTO_IMPORT`)                           |
| `import [--region <url>] [--input <datei>]` | Index bauen (Download, Filter, Import) und atomar austauschen                                     |
| `update`                                    | Extrakt neu laden (nur wenn die Geofabrik-MD5 sich geändert hat), Index neu bauen und austauschen |

```bash
# Import vorab, ohne die API zu starten
docker run --rm -v data:/data meine-api import --region https://download.geofabrik.de/europe/germany/bremen-latest.osm.pbf

# Update im laufenden Container
docker exec <container> doorstep update
docker restart <container>
```

Nach `update` nutzt eine laufende API den neuen Index erst nach einem Neustart. Das Neuladen ohne
Neustart folgt in Phase 6.

### Smoke-Test

```bash
npm run smoke
```

Baut das Image, startet es mit leerem Volume und dem Mini-Extrakt aus `test/fixtures/`
(automatischer Import über `REGION_URL`, ausgeliefert von einem Hilfscontainer), fragt `/health`,
`/api` und `/reverse` ab, prüft den `HEALTHCHECK`, führt `update` aus und startet neu. Braucht
nur Docker und `curl`, keinen Internetzugriff außer für den Image-Build.

## Lizenz der Daten

Die Daten stammen von OpenStreetMap: © OpenStreetMap contributors, verfügbar unter der
[Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).

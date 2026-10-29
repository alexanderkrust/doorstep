# doorstep

Self-hosted Adress-Autosuggest-API auf Basis von OpenStreetMap.
Ein Docker-Image, keine externen Dienste: der Index ist eine SQLite-Datei (FTS5 + R\*Tree) unter `/data`.

Daten: © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/).
Jede API-Antwort enthält diesen Hinweis im Feld `attribution`.

> Status: Phase 6 (Updates und Betrieb). Siehe [ROADMAP.md](ROADMAP.md).

## Schnellstart

Voraussetzung: Docker. Sonst nichts, auch kein docker-compose.

```bash
docker build -t meine-api .
docker run -d --name doorstep --restart unless-stopped \
  -p 2322:2322 -v data:/data meine-api
```

Beim ersten Start liegt noch kein Index im Volume. Die API startet trotzdem sofort, lädt im
Hintergrund den Extrakt aus `REGION_URL` (Default: Deutschland, rund 4,5 GB) und baut den Index.
Bis dahin antwortet `/api` mit `503`. Den Fortschritt zeigen `docker logs -f doorstep` und
`/health` (`"index": false, "importing": true`). Danach liefert die API Vorschläge:

```bash
curl 'http://localhost:2322/api?q=K%C3%B6nigsall&limit=3'
```

Für einen schnellen Test eine kleinere Region wählen (Bremen: 21 MB, Import in Sekunden):

```bash
docker run -d --name doorstep -p 2322:2322 -v data-bremen:/data \
  -e REGION_URL=https://download.geofabrik.de/europe/germany/bremen-latest.osm.pbf \
  meine-api
```

Der automatische Import läuft nur, solange das Volume keinen Index enthält. Für eine andere
Region daher ein neues Volume nehmen oder `import --region <url>` ausführen (siehe
[Kommandos](#kommandos)).

Ein typischer Produktivstart mit täglichem Update um 3 Uhr (UTC), API-Key für das eigene
Frontend und Betrieb hinter einem Reverse-Proxy:

```bash
docker run -d --name doorstep --restart unless-stopped \
  -p 127.0.0.1:2322:2322 -v data:/data \
  -e UPDATE_CRON='0 3 * * *' \
  -e TRUST_PROXY=true \
  -e RATE_LIMIT=60 \
  -e API_KEYS=ein-langer-zufaelliger-key \
  -e RATE_LIMIT_API_KEY=1200 \
  -e CORS_ORIGINS=https://www.example.com \
  meine-api
```

## Systemanforderungen

Richtwerte für den Deutschland-Extrakt. Gemessen ist nur der Regierungsbezirk Düsseldorf
(217 MB PBF → 389 MB Index); die Werte für Deutschland sind daraus hochgerechnet.

| Ressource        | Deutschland (Schätzung)                | Hinweis                                                                                                                                                               |
| ---------------- | -------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Platte (Volume)  | **mind. 30 GB frei**                   | Extrakt ca. 4,5 GB, Index ca. 8 GB. Während eines Updates liegen zusätzlich die gefilterte Zwischendatei, `index.next.sqlite` und dessen Staging-Datei auf dem Volume |
| RAM, API         | 1 GB für den Prozess, **besser 8 GB+** | Der Prozess selbst braucht wenig, SQLite liest den Index von der Platte. Für Antwortzeiten unter 50 ms sollte der Index in den Page-Cache des Systems passen          |
| RAM, Import      | **4–8 GB**                             | `osmium export` hält die Knotenkoordinaten im Speicher; der Import läuft als eigener Prozess neben der API                                                            |
| CPU              | 2 Kerne                                | Die API nutzt einen Kern; der zweite hält Import und Update von der API fern                                                                                          |
| Dauer Erstimport | ca. 15–30 min plus Download            | Regierungsbezirk Düsseldorf: 45 s für 1,4 Mio. Einträge                                                                                                               |

## Betrieb

### Updates ohne Ausfall

Ein Update lädt den Extrakt neu (nur wenn sich die Geofabrik-MD5 geändert hat), baut
`index.next.sqlite` neben dem laufenden Index und ersetzt `index.sqlite` per atomarem `rename`.
Die API liest bis dahin unverändert den alten Index. Sie prüft alle 5 Sekunden, ob unter
`index.sqlite` eine neue Datei liegt, öffnet sie, wechselt um und leert den Cache. Kein Neustart,
keine fehlgeschlagenen Anfragen. Ist die neue Datei unbrauchbar, bleibt der alte Index aktiv und
im Log steht ein Fehler.

Zwei Wege, ein Update auszulösen:

```bash
# Automatisch nach Zeitplan (Cron-Format, Zeitzone des Containers, Default UTC)
docker run … -e UPDATE_CRON='0 3 * * *' meine-api

# Von Hand im laufenden Container
docker exec doorstep doorstep update
```

- `UPDATE_CRON` versteht fünf Felder (Minute, Stunde, Tag, Monat, Wochentag) mit `*`, Zahlen,
  Listen (`1,15`), Bereichen (`1-5`) und Schritten (`*/15`). Namen wie `mon` gehen nicht.
  Andere Zeitzone: `-e TZ=Europe/Berlin`.
- Es läuft nie mehr als ein Import gleichzeitig: Eine Dateisperre auf `/data/import.lock.sqlite`
  verhindert, dass sich ein geplantes und ein manuelles Update in die Quere kommen. Das zweite
  bricht mit Exit-Code 75 und einer Meldung ab. Endet der importierende Prozess, gibt das
  Betriebssystem die Sperre sofort frei, auch wenn der Container mitten im Import ersetzt wird.
  Die Datei selbst bleibt liegen und muss nie gelöscht werden. Eine `import.lock` älterer
  Versionen wird beim nächsten Import entfernt. Das Volume muss POSIX-Dateisperren
  unterstützen (lokales Docker-Volume oder Bind-Mount, kein NFS).
- Sofort neu laden statt bis zu 5 Sekunden zu warten: `docker kill -s HUP doorstep`.
- Kontrolle: `/health` zeigt in `importedAt`, wann der aktive Index gebaut wurde; `/metrics`
  zählt `doorstep_index_reloads_total` und `doorstep_updates_total`.

Geofabrik aktualisiert die Extrakte täglich; ein tägliches oder wöchentliches Update reicht.

### Rate-Limiting und API-Keys

- Ohne API-Key: höchstens `RATE_LIMIT` Anfragen pro Minute und IP auf `/api` und `/reverse`.
- Mit gültigem API-Key (Header `X-API-Key: <key>` oder Parameter `api_key=<key>`): höchstens
  `RATE_LIMIT_API_KEY` Anfragen pro Minute und Key, unabhängig von der IP. Unbekannte Keys
  zählen wie Anfragen ohne Key.
- Darüber antwortet die API mit `429` und `Retry-After`. Jede Antwort trägt
  `X-RateLimit-Limit`, `X-RateLimit-Remaining` und `X-RateLimit-Reset`.
- `/health` und `/metrics` zählen nicht mit.
- Abschalten: `RATE_LIMIT_ENABLED=false` (oder `RATE_LIMIT=0`).
- **Hinter einem Reverse-Proxy** (nginx, Traefik, Caddy) `TRUST_PROXY=true` setzen, sonst
  zählen alle Anfragen für die IP des Proxys. Ohne Proxy `TRUST_PROXY` aus lassen, sonst kann
  jeder Client über `X-Forwarded-For` eine beliebige IP angeben.

Die Zähler liegen im Speicher des Prozesses und beginnen nach einem Neustart neu.

### Cache

Ergebnisse von Suchanfragen hält ein LRU-Cache im Speicher (`CACHE_SIZE` Einträge, Default 10.000,
grob 20–50 MB). Schlüssel sind die normalisierte Anfrage, `limit`, `lang` und der Standort. Kurze
Präfixe („Ha“, „Kö“) kommen beim Tippen am häufigsten wieder und bleiben deshalb im Cache; lange
Anfragen mit Standort sind auf großen Indizes am teuersten und werden ebenfalls gecacht. Der Header
`X-Cache` zeigt `HIT` oder `MISS`. Nach einem Update wird der Cache geleert.

### Logs

Alle Logs sind JSON-Zeilen im pino-Format auf stdout (`level`, `time`, `pid`, `hostname`,
`msg`), auch die von `import` und `update` (mit `component`). Pro Anfrage gibt es eine Zeile
mit `method`, `route`, `status`, `durationMs` und `cache`. Suchtexte und IP-Adressen werden
nicht geloggt, da Adresseingaben personenbezogen sein können. `LOG_LEVEL=warn` schaltet die
Zeilen pro Anfrage ab.

### Metrics

`GET /metrics` liefert Kennzahlen im Prometheus-Format:

| Metrik                                                                                  | Typ       | Inhalt                                                   |
| --------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------- |
| `doorstep_http_requests_total`                                                          | counter   | Anfragen nach `method`, `route`, `status`                |
| `doorstep_http_request_duration_seconds`                                                | histogram | Antwortzeit nach `route`                                 |
| `doorstep_search_cache_hits_total`, `…misses_total`                                     | counter   | Cache-Treffer und -Fehlschläge                           |
| `doorstep_rate_limited_total`                                                           | counter   | Mit `429` abgewiesene Anfragen                           |
| `doorstep_index_available`                                                              | gauge     | 1, wenn ein nutzbarer Index geladen ist                  |
| `doorstep_index_places`                                                                 | gauge     | Einträge im aktiven Index                                |
| `doorstep_index_imported_timestamp_seconds`                                             | gauge     | Bauzeitpunkt des aktiven Index (Alarm, wenn zu alt)      |
| `doorstep_index_reloads_total`, `…reload_errors_total`                                  | counter   | Index-Wechsel ohne Neustart und gescheiterte             |
| `doorstep_updates_total`                                                                | counter   | Geplante Updates nach `result` (success/failure/skipped) |
| `process_resident_memory_bytes`, `nodejs_heap_used_bytes`, `process_start_time_seconds` | gauge     | Prozess                                                  |

`/metrics` ist nicht geschützt. Soll es nicht öffentlich erreichbar sein, im Reverse-Proxy
sperren.

### Healthcheck

`GET /health` antwortet mit `200`, sobald die API läuft, auch während des ersten Imports:
`status`, `version`, `uptime`, `index` (nutzbarer Index vorhanden), `importing` (Import oder
Update läuft), `importedAt` (Bauzeitpunkt des aktiven Index) und `attribution`. Das Image nutzt
das für seinen `HEALTHCHECK`.

## Konfiguration (Umgebungsvariablen)

Die Konfiguration erfolgt ausschließlich über Umgebungsvariablen. Ungültige Werte führen beim
Start zu einer Fehlermeldung mit allen betroffenen Variablen.

| Variable             | Default                                                       | Beschreibung                                                                |
| -------------------- | ------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `REGION_URL`         | `https://download.geofabrik.de/europe/germany-latest.osm.pbf` | Geofabrik-Extrakt für Import und Update                                     |
| `HOST`               | `0.0.0.0`                                                     | Bind-Adresse der API                                                        |
| `PORT`               | `2322`                                                        | Port der API                                                                |
| `DATA_DIR`           | `/data`                                                       | Verzeichnis für Extrakt und Index (absoluter Pfad)                          |
| `DEFAULT_LANG`       | `de`                                                          | Standardsprache (zweistelliger Code)                                        |
| `AUTO_IMPORT`        | `false` (im Docker-Image `true`)                              | `serve` importiert im Hintergrund, falls kein Index existiert               |
| `UPDATE_CRON`        | – (keine Updates)                                             | Zeitplan für automatische Updates im Cron-Format, z. B. `0 3 * * *`         |
| `RATE_LIMIT_ENABLED` | `true`                                                        | Rate-Limiting an oder aus                                                   |
| `RATE_LIMIT`         | `60`                                                          | Anfragen pro Minute und IP, `0` = aus                                       |
| `API_KEYS`           | –                                                             | Kommagetrennte API-Keys                                                     |
| `RATE_LIMIT_API_KEY` | `600`                                                         | Anfragen pro Minute und API-Key                                             |
| `TRUST_PROXY`        | `false`                                                       | Client-IP aus `X-Forwarded-For` übernehmen (nur hinter einem Reverse-Proxy) |
| `CACHE_SIZE`         | `10000`                                                       | Einträge im Cache für Suchanfragen, `0` = aus                               |
| `CORS_ORIGINS`       | `*`                                                           | Kommagetrennte Liste erlaubter Origins                                      |
| `LOG_LEVEL`          | `info`                                                        | `fatal`, `error`, `warn`, `info`, `debug`, `trace`, `silent`                |
| `TZ`                 | `UTC` (Container)                                             | Zeitzone für `UPDATE_CRON`                                                  |

Schalter (`AUTO_IMPORT`, `RATE_LIMIT_ENABLED`, `TRUST_PROXY`) akzeptieren `true`/`false`,
`1`/`0` und `yes`/`no`.

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
| `api_key`    | nein    | API-Key (alternativ Header `X-API-Key`)                             |

Das letzte Wort wird als Präfix gesucht, alle anderen exakt. Findet die Anfrage nichts, wird
der Reihe nach versucht: ohne einzelne Buchstaben (`Frankfurt a.M.`, `Mülheim a.d. Ruhr`), die
Straße ohne Hausnummer (gibt es die Hausnummer nicht, kommt die Straße zurück) und erst dann das
letzte Wort um bis zu zwei Zeichen gekürzt (Tippfehler am Wortende). Fehlt eine Hausnummer, kommt
so die Straße im genannten Ort vor einer Hausnummer in einem ähnlich geschriebenen Ort
(`… 1 Bonn` liefert nicht `… 1 Bönen`).

**Felder je Treffer:** `name`, `street`, `housenumber`, `postcode`, `city`, `district`, `state`,
`country`, `osm_id`, `osm_type`, `type`; fehlende Werte werden weggelassen. `district` ist der
Ortsteil (`addr:suburb`, sonst `addr:hamlet`), `city` oft die Gemeinde: `Strandstraße 1
Westerland` findet die Adresse mit `city: "Sylt"`, `district: "Westerland"`. Adressen ohne
Straße (`addr:place`) tragen den Ortsnamen in `street`. Straßen übernehmen Ort, Ortsteil und PLZ
von der nächsten Adresse an derselben Straße. `country` (ISO-Code, z. B. `DE`) und `state`
(Bundesland, z. B. `Nordrhein-Westfalen`) kommen aus den OSM-Verwaltungsgrenzen, siehe unten.

**Normalisierung** (Import und Suche gleich, `src/search/normalize.ts`): Kleinschreibung,
`ä` ↔ `ae`, `ß` ↔ `ss`, andere Akzente entfernt, `Str.` ↔ `Straße`, `Schlosstr.` ↔
`Schloßstraße`, `St.` ↔ `Sankt`, `60 d` und `60d` gleichwertig, `Hauptstraße12` →
`Hauptstraße 12`. Zusätzlich
wird die Schreibweise ohne Umlaut-e indexiert, sodass auch `Dusseldorf` Düsseldorf findet.
Namen mit den Grundwörtern `Straße`, `Allee`, `Platz`, `Gasse`, `Damm`, `Ring` und `Weg` werden
außerdem getrennt und zusammengeschrieben indexiert: `Friedrich Straße` findet die Friedrichstraße,
`Konrad-Adenauerstraße` die Konrad-Adenauer-Straße.

**Ranking** (`src/search/ranking.ts`): Aus bis zu 200 Kandidaten (bei `lat/lon` zusätzlich bis zu
200 im Umkreis von 25 km, gefunden über eine Rasterzelle je Eintrag im FTS-Index) wird ein Score aus FTS-Relevanz (`bm25`), Übereinstimmung mit dem Namen,
`importance` (Stadt vor Ortsteil vor Straße vor Hausnummer) und – falls angegeben – der Nähe zum
Standort berechnet. Gleichnamige Treffer im Abstand bis 2 km (z. B. die Abschnitte einer Straße)
werden zu einem zusammengefasst.

**Sprachen:** `name:de` und `name:en` werden beim Import getrennt gespeichert und alle Varianten
durchsucht. `lang=de|en` wählt den angezeigten Namen, sonst gilt `name`.

Die Suchdauer steht im Antwort-Header `Server-Timing` (z. B. `search;dur=1.84`).

```bash
curl 'http://localhost:2322/api?q=K%C3%B6nigsall&limit=3'
```

**Grenzen bei der Prüfung von Lieferadressen** (gemessen am Deutschland-Extrakt):

- **Land und Bundesland kommen aus den Verwaltungsgrenzen**, nicht aus `addr:country`/`addr:state`
  (fehlen bei 29 % bzw. fast allen Adressen, teils falsch: Riezlern und Jungholz sind oft als
  `DE` getaggt). Der Import lädt die Grenzen (`boundary=administrative`, `admin_level=2` und `4`)
  und ordnet jedem Eintrag, auch Straßen ohne Adressen, Land und Bundesland per Punkt-in-Polygon
  zu. Ein Shop prüft also `country == "DE"` und bei Bedarf `state`.
  - Der Geofabrik-Extrakt enthält Adressen aus den Nachbarländern (Kerkrade, Zgorzelec,
    Straßburg, Kreuzlingen …), deren Grenzen aber nur angeschnitten. Liegt ein Punkt außerhalb
    Deutschlands, bestimmt der nächste Grenzweg das Nachbarland; `state` bleibt dann leer
    (außer das Land stimmt mit `addr:country` überein, dann gilt `addr:state`).
  - Unsicher nur nahe einem Dreiländereck (z. B. Vaals/Aachen/Kelmis): Dort kann ein Punkt im
    Nachbarland dem falschen Nachbarn zugeordnet werden. Deutsche Adressen sind davon nicht
    betroffen, sie liegen in der vollständigen Fläche Deutschlands.
  - Mit einem Extrakt, der kein Land vollständig enthält (z. B. ein Regierungsbezirk), gibt es
    keine Flächen; dann gelten wie früher `addr:country`/`addr:state`.
  - Am Deutschland-Extrakt geprüft: Alle Abweichungen von einem vorhandenen `addr:country` sind
    Korrekturen; bei Adressen ohne `addr:country` passt das PLZ-Format immer zum ermittelten Land.
- **Sonderfälle mit deutscher PLZ:** Büsingen am Hochrhein (78266, Schweizer Zollgebiet),
  Helgoland (27498, außerhalb des EU-Zollgebiets), Kleinwalsertal (87567–87569) und Jungholz
  (87491) gehören zu Österreich. Solche Regeln prüft der Shop am besten über die PLZ.
- **Tippfehler mitten im Wort** (`Friedrichstrase`, `Kastanineallee`) werden nicht erkannt, nur am
  Wortende.

### `GET /reverse` – nächstes Objekt zu einem Punkt

| Parameter    | Pflicht | Beschreibung                            |
| ------------ | ------- | --------------------------------------- |
| `lat`, `lon` | ja      | Koordinate in WGS84                     |
| `limit`      | nein    | 1–10, Default 1                         |
| `radius`     | nein    | Suchradius in km, > 0 bis 10, Default 1 |
| `lang`       | nein    | Wie bei `/api`                          |

Ungültige Parameter liefern `400` mit einer Meldung wie `q: muss mindestens 2 Zeichen lang sein`.
Solange noch kein Index unter `$DATA_DIR/index.sqlite` liegt, antworten beide Endpunkte mit `503`.
Das gilt auch für einen Index mit altem Schema (aktuell Version 7, seit getrennt und
zusammengeschriebenen Straßennamen; Version 6 brachte die Wortstatistik für bm25, Version 5 Land
und Bundesland aus Verwaltungsgrenzen): dann bitte neu importieren bzw. das nächste Update
abwarten.

### Weitere Endpunkte

- `GET /health` – Status, siehe [Healthcheck](#healthcheck)
- `GET /metrics` – Prometheus-Kennzahlen, siehe [Metrics](#metrics)

## Docker

Das `Dockerfile` baut in mehreren Stufen: TypeScript-Build, Produktions-Abhängigkeiten und ein
schlankes Laufzeit-Image auf `node:24.22.1-trixie-slim` (Debian 13) mit `osmium-tool`. SQLite ist
als `node:sqlite` in Node enthalten (mit FTS5 und R\*Tree); native Module werden nicht gebaut.

- Läuft als Nutzer `node` (uid 1000), nicht als root.
- `/data` ist ein `VOLUME` und enthält `extract.osm.pbf`, `index.sqlite` und während eines
  Updates `index.next.sqlite`; dazu die Sperrdatei `import.lock.sqlite` (mit `import.lock.sqlite.json`, solange ein Import läuft). Bei einem Bind-Mount (`-v $PWD/data:/data`)
  muss das Verzeichnis für uid 1000 beschreibbar sein.
- Port `2322`, `HEALTHCHECK` gegen `/health` (alle 30 s).
- Schlägt der automatische Erstimport fehl, beendet sich der Container mit Exit-Code 1. Mit
  `--restart unless-stopped` startet Docker ihn neu, und der Import wird wiederholt; ein
  abgebrochener Download wird dabei fortgesetzt. Ein gescheitertes geplantes Update beendet den
  Container nicht, der bisherige Index bleibt aktiv.

### Kommandos

| Kommando                                    | Beschreibung                                                                                        |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `serve` (Standard)                          | API starten; ohne Index läuft der Import im Hintergrund (`AUTO_IMPORT`), Updates nach `UPDATE_CRON` |
| `import [--region <url>] [--input <datei>]` | Index bauen (Download, Filter, Import) und atomar austauschen                                       |
| `update`                                    | Extrakt neu laden (nur wenn die Geofabrik-MD5 sich geändert hat), Index neu bauen und austauschen   |

```bash
# Import vorab, ohne die API zu starten
docker run --rm -v data:/data meine-api import --region https://download.geofabrik.de/europe/germany/bremen-latest.osm.pbf

# Update im laufenden Container; die API wechselt von selbst auf den neuen Index
docker exec doorstep doorstep update
```

### Smoke-Test

```bash
npm run smoke
```

Baut das Image, startet es mit leerem Volume und dem Mini-Extrakt aus `test/fixtures/`
(automatischer Import über `REGION_URL`, ausgeliefert von einem Hilfscontainer), fragt `/health`,
`/api`, `/reverse` und `/metrics` ab, prüft den `HEALTHCHECK`, führt `update` im laufenden
Container unter ständigen Anfragen aus und prüft, dass keine fehlschlägt und die API den neuen
Index ohne Neustart lädt. Braucht nur Docker und `curl`, keinen Internetzugriff außer für den
Image-Build.

## Lasttest

```bash
npm run loadtest -- --url http://127.0.0.1:2322 --duration 20 --connections 50 [--location]
```

Schickt mit [autocannon](https://github.com/mcollina/autocannon) jedes Tipp-Präfix typischer
Eingaben („Kö“, „Kön“, „Köni“, …), reihum über alle Verbindungen. Endet mit Exit-Code 1, wenn
eine Anfrage fehlschlägt. Am Server dafür `RATE_LIMIT_ENABLED=false` setzen oder mit
`--api-key` einen Key mit hohem Limit verwenden.

Ergebnisse (Apple M3, Node 24, ein API-Prozess, Index aus
`test/fixtures/duesseldorf.geojsonseq` mit 17.618 Einträgen, 50 Verbindungen, 234 verschiedene
Anfragen, `LOG_LEVEL=info`):

| Szenario                                          | Anfragen/s | p50   | p90   | p99    | Fehler |
| ------------------------------------------------- | ---------- | ----- | ----- | ------ | ------ |
| Ohne Cache (`CACHE_SIZE=0`), ohne Standort        | 1.200      | 40 ms | 69 ms | 96 ms  | 0      |
| Ohne Cache, mit Standort                          | 1.033      | 50 ms | 84 ms | 128 ms | 0      |
| Mit Cache, mit Standort                           | 4.090      | 2 ms  | 45 ms | 71 ms  | 0      |
| Mit Cache, `update` läuft währenddessen (20 s)    | 6.628      | 2 ms  | 23 ms | 67 ms  | 0      |
| Ohne Cache, zwei Updates per `UPDATE_CRON` (75 s) | 2.072      | 6 ms  | 75 ms | 93 ms  | 0      |

So lesen: Die API bearbeitet Anfragen auf einem Kern nacheinander. Bei 50 gleichzeitigen
Verbindungen ist die Latenz daher vor allem Wartezeit; eine einzelne Suche dauert ohne Cache
im Mittel unter 1 ms (siehe `Server-Timing`). Der Cache-Anteil liegt bei nur 234 verschiedenen
Anfragen höher als im echten Betrieb. In beiden Update-Szenarien schlug keine einzige von
132.549 bzw. 155.411 Anfragen fehl.

**Deutschland-Index** (Schema 7, 25,6 Mio. Einträge, 9,3 GB, sonst wie oben, warmer Page-Cache):

| Szenario                                   | Anfragen/s | p50    | p90    | p99    | Fehler |
| ------------------------------------------ | ---------- | ------ | ------ | ------ | ------ |
| Ohne Cache (`CACHE_SIZE=0`), ohne Standort | 411        | 81 ms  | 258 ms | 584 ms | 0      |
| Ohne Cache, mit Standort                   | 221        | 169 ms | 429 ms | 927 ms | 0      |
| Mit Cache, ohne Standort                   | 40.163     | 1 ms   | 1 ms   | 2 ms   | 0      |
| Mit Cache, mit Standort                    | 31.397     | 1 ms   | 1 ms   | 4 ms   | 0      |

Eine Suche dauert hier im Mittel 2,4 ms ohne und 4,5 ms mit Standort; bei 50 Verbindungen
warten die Anfragen ohne Cache vor allem aufeinander. Die Werte mit Cache sind eine Obergrenze:
Der Test wiederholt 234 Anfragen, 99,98 % kommen aus dem Cache (Prozess danach 264 MB RSS). Im
echten Betrieb sind lange Anfragen meist einmalig, dort liegt der Durchsatz zwischen beiden
Zeilen. Bis zum 28.10.2026 nahm der Cache nur Anfragen bis 10 Zeichen auf; damit kam der Test
mit Standort auf 545 Anfragen/s. Für mehr Durchsatz ohne Cache siehe ROADMAP („Durchsatz auf
großen Indizes“).

## Qualität und Latenz der Suche

- **Golden-Queries:** `test/golden/duesseldorf.json` enthält Suchanfragen mit erwarteten
  Top-Treffern gegen einen Ausschnitt aus Düsseldorf und Neuss. Sie laufen mit `npm test`.
- **Benchmark:** misst die Suchdauer direkt auf einem Index ohne HTTP (Golden-Queries plus jedes
  Tipp-Präfix typischer Eingaben, mit und ohne Standort). Ziel: p95 unter 50 ms.

```bash
npm run bench -- --index $PWD/data/index.sqlite
```

Messung (MacBook, Node 24, 5 Runden). **Deutschland** (Geofabrik-Extrakt vom 27.10.2026, 4,9 GB
PBF → 25,6 Mio. Einträge, gemessen mit Schema 5 ohne Grenzen: 8,5 GB Index, Import 30 min, max. 5,4 GB RAM; mit Grenzen 8,8 GB, 39 min, max. 4,2 GB RAM; Schema 7 mit Grenzen und Schreibvarianten 9,3 GB, 28 min, max. 4,2 GB RAM, Suche p50 2,5 ms, p95 16,9 ms, max. 56 ms bei warmem Cache): **p50 2,8 ms, p95 16,5 ms,
p99 29 ms**, max. 41–91 ms. Vorher (bis Schema 4) p95 194 ms. Am langsamsten ist die Suche mit
Standort bei sehr häufigen Wörtern (`Am Markt 1` 41 ms, `Friedrichstraße 3` 20–90 ms). Regierungsbezirk
Düsseldorf (217 MB PBF → 1,4 Mio. Einträge, 389 MB Index, Import 45 s), gemessen mit Schema 4: p50 2,0 ms,
p95 10,1 ms, p99 16,6 ms.

Was die Suche schnell hält: Die Trefferliste in FTS5 ist nach Wichtigkeit sortiert, und je Anfrage
werden nur die ersten 200 Kandidaten gelesen. `bm25` rechnet in JS mit einer beim Import
vorberechneten Wortstatistik (Tabellen `terms` und `prefixes`), statt bei jeder Anfrage alle
Dokumente jedes Suchworts zu zählen. Lange Präfixe mit einem sehr häufigen Wort („stras…“ →
„strasse“) werden in das exakte Wort und längere Teilpräfixe zerlegt, weil FTS5 Präfixe über
4 Zeichen sonst vorab komplett zusammenführt. Die Standort-Suche liest über die Rasterzellen nur
Treffer im Umkreis.

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

## Import

```bash
DATA_DIR=$PWD/data npm run import -- --region https://download.geofabrik.de/europe/germany/bremen-latest.osm.pbf
DATA_DIR=$PWD/data npm run import -- --input ./mein-extrakt.osm.pbf   # lokale Datei, ohne Download
```

Ohne `--region` gilt `REGION_URL`. Ablauf:

1. Sperre `$DATA_DIR/import.lock.sqlite` setzen (nie zwei Imports gleichzeitig).
2. Download nach `$DATA_DIR/extract.osm.pbf`. Abgebrochene Downloads werden fortgesetzt
   (`extract.osm.pbf.part`), die Geofabrik-`.md5` wird geprüft. Passt eine vorhandene Datei
   zur `.md5`, wird nicht neu geladen.
3. Verwaltungsgrenzen laden: `osmium tags-filter` auf `admin_level=2,4`, dann Flächen und
   Grenzwege per `osmium export`, Relationsmitglieder per `osmium cat` (OPL). Länder und
   Bundesländer liegen danach im Speicher (Deutschland: ca. 300 MB, 30 s).
4. `osmium tags-filter` auf Adressen, Orte (`place=*`), Straßen (`highway` mit Namen) und
   benannte `amenity`-Objekte.
5. `osmium export` als GeoJSON-Sequenz, die zeilenweise gelesen wird (konstanter Speicherbedarf).
   Jeder Eintrag bekommt beim Einfügen Land und Bundesland aus den Grenzen.
6. Aufbau von `index.next.sqlite` (Tabelle `places`, FTS5-Tabelle `places_fts` mit Präfix-Index
   und Rasterzelle (0,25°) je Eintrag, R\*Tree `places_rtree`, Tabelle `meta`) und atomarer Austausch gegen `index.sqlite`.

Richtwert: Der Bremen-Extrakt (21 MB) ergibt rund 177.000 Einträge in etwa 5 Sekunden.

## Lizenz der Daten

Die Daten stammen von OpenStreetMap: © OpenStreetMap contributors, verfügbar unter der
[Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/). Wer die API
öffentlich anbietet oder Ergebnisse anzeigt, muss diesen Hinweis sichtbar machen; das Feld
`attribution` in jeder Antwort liefert ihn mit.

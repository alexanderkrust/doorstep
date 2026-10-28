# Roadmap: Self-hosted Autosuggest-API

Oct 28, 2026 · @Alex

## Ziel und Rahmenbedingungen

Ziel ist eine Adress-Autosuggest-API auf OSM-Basis, die als ein einziges Docker-Image läuft und per `docker run` gestartet wird, ohne docker-compose und ohne externe Dienste.

Daraus folgt eine Änderung gegenüber der ersten Empfehlung (Typesense/OpenSearch als eigener Server): Ein separater Suchserver bräuchte einen zweiten Container. Deshalb wird der Index in die Anwendung eingebettet.

| Entscheidung        | Wahl                                                                         | Grund                                                              |
| ------------------- | ---------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Deployment          | Ein Multi-Stage-`Dockerfile`, Start per `docker run`, Daten auf einem Volume | Vorgabe: kein docker-compose                                       |
| Sprache / Framework | TypeScript, Fastify                                                          | Passt zum vorhandenen Stack (NestJS, Next.js), schnell und schlank |
| Index               | SQLite mit FTS5 (Prefix-Suche) und R\*Tree (Geo)                             | Eingebettet, eine Datei, keine zweite Prozessverwaltung            |
| OSM-Aufbereitung    | `osmium-tool` im Image, Import-Skript in TypeScript                          | Bewährtes Filtern, Import bleibt im Projekt                        |
| Datenquelle         | Geofabrik-Extrakt, per ENV konfigurierbar                                    | Start mit Deutschland, später Europa möglich                       |
| Ausgabeformat       | GeoJSON                                                                      | Bestehende Clients lassen sich später umstellen                    |

## Architektur im einen Container

Der Container enthält die API, den Importer und `osmium-tool`; der Index liegt als SQLite-Datei auf einem gemounteten Volume.

- **Ein Image, zwei Kommandos:** `serve` startet die API, `import` lädt den Extrakt und baut den Index. Der Standardstart führt beim ersten Mal automatisch `import` aus, falls auf dem Volume noch kein Index liegt.
- **Volume `/data`:** enthält `extract.osm.pbf`, `index.sqlite` und beim Update die neue Datei `index.next.sqlite`.
- **Konfiguration per ENV:** `REGION_URL` (Geofabrik-Link), `PORT`, `DEFAULT_LANG`, `RATE_LIMIT`, `CORS_ORIGINS`.
- **Start:** `docker run -p 2322:2322 -v data:/data meine-api`
- **Ein Prozess:** Die API liest den Index nur lesend; Updates bauen eine neue Datei und tauschen sie atomar aus (Phase 6).

## Phase 1: Projekt-Setup

**Ziel:** Ein lauffähiges Grundgerüst mit Tests, an dem Claude Code jede spätere Phase sauber ansetzen kann.

- [ ] Repository anlegen mit TypeScript (strict), Fastify, ESLint, Prettier und Vitest
- [ ] Ordnerstruktur: `src/api`, `src/import`, `src/search`, `src/config`, `test/`, `docker/`
- [ ] Konfigurationsmodul, das alle ENV-Variablen validiert (z. B. mit zod) und Defaults setzt
- [ ] `GET /health` liefert `200` mit Status
- [ ] `CLAUDE.md` mit Architekturregeln und Befehlen (Vorlage weiter unten)
- [ ] CI-Skript: `npm run lint`, `npm run test`, `npm run build`

**Fertig, wenn:** `npm test` und `npm run build` laufen grün und `/health` antwortet lokal.

## Phase 2: Import-Pipeline

**Ziel:** Aus einem OSM-Extrakt entsteht eine durchsuchbare SQLite-Datei mit Adressen, Straßen und Orten.

- [ ] Download des Extrakts von `REGION_URL` nach `/data` (mit Fortschritt, Wiederaufnahme und Prüfsumme, falls Geofabrik eine `.md5` bereitstellt)
- [ ] `osmium tags-filter` auf relevante Objekte: `addr:housenumber`, `addr:street`, `place=*`, `highway` mit Namen, optional `amenity`
- [ ] Export per `osmium export` als GeoJSON-Sequenz und Streaming-Import, damit der Speicherbedarf konstant bleibt
- [ ] Datenmodell einer Zeile: `id`, `osm_type`, `osm_id`, `type`, `name`, `street`, `housenumber`, `postcode`, `city`, `state`, `country`, `lat`, `lon`, `importance`
- [ ] Tabelle `places` plus FTS5-Tabelle mit Präfix-Index (`prefix='2 3 4'`) und R\*Tree-Tabelle für Koordinaten
- [ ] `importance` aus dem `place`-Typ ableiten (Stadt vor Dorf vor Straße vor Hausnummer)
- [ ] CLI: `npm run import -- --region <url>` und das Docker-Kommando `import`
- [ ] Tests mit einem kleinen Beispiel-Extrakt (z. B. ein Stadtteil), der im Repo liegt

**Fertig, wenn:** Der Import eines kleinen Extrakts läuft in Tests durch und erzeugt eine Datei, in der Stichproben-Adressen per SQL auffindbar sind.

## Phase 3: Such-API

**Ziel:** Autosuggest und Reverse-Geocoding über HTTP, als GeoJSON.

- [ ] `GET /api?q=&lat=&lon=&limit=&lang=` liefert eine GeoJSON-`FeatureCollection`
- [ ] Jedes Feature hat `geometry` (Point) und `properties` mit `name`, `street`, `housenumber`, `postcode`, `city`, `state`, `country`, `osm_id`, `osm_type`
- [ ] Die Suchanfrage wird in eine FTS5-Query übersetzt: letztes Token als Präfix, vorherige Token exakt
- [ ] `GET /reverse?lat=&lon=` findet das nächste Objekt über den R\*Tree
- [ ] Validierung der Parameter (Mindestlänge von `q`, `limit` höchstens 10) mit klaren `400`-Fehlern
- [ ] CORS per ENV, Antwort-Header `Cache-Control` für identische Queries
- [ ] OpenAPI-Beschreibung unter `/docs` (optional)
- [ ] Tests: Suche nach Straße, Straße mit Hausnummer, Ort, Tippfehler am Wortende

**Fertig, wenn:** Gegen den Test-Index liefert `/api?q=Königsall` die Königsallee als Treffer in den ersten Ergebnissen und `/reverse` einen plausiblen Treffer.

## Phase 4: Ranking und Qualität

**Ziel:** Die Vorschläge fühlen sich wie bei einer guten Autosuggest-API an: richtige Reihenfolge, tolerant bei Schreibweisen, nahe Treffer zuerst.

- [ ] Normalisierung beim Import und bei der Suche: Kleinschreibung, Umlaute (ä ↔ ae), `ß` ↔ `ss`, "str." ↔ "straße"
- [ ] Ranking-Formel aus FTS-Score (`bm25`), `importance` und Entfernung zu `lat/lon`, als reine Funktion mit Unit-Tests
- [ ] Location Bias: Treffer im Umkreis des mitgegebenen Punkts werden angehoben
- [ ] Fallback: Hausnummer fehlt in OSM → Treffer auf Straßenebene zurückgeben
- [ ] Mehrsprachigkeit: `name:de`, `name:en` getrennt speichern und nach `lang` auswählen
- [ ] Golden-Queries: eine Datei mit 30 bis 50 Suchanfragen und erwarteten Top-Treffern, die in der Test-Suite läuft
- [ ] Messung der Antwortzeit pro Anfrage, Ziel unter 50 ms bei einem Deutschland-Index

**Fertig, wenn:** Alle Golden-Queries bestehen und die Latenz auf dem vollen Deutschland-Index im Zielbereich liegt.

### Offene Punkte aus Phase 4

- [ ] **Latenz auf dem Deutschland-Index messen** (`npm run bench -- --index <datei>`). Bisher nur auf dem Regierungsbezirk Düsseldorf gemessen (1,4 Mio. Einträge): p50 2,0 ms, p95 10,1 ms.
- [ ] **Kosten, die mit der Datenmenge wachsen:** `bm25` zählt für jedes Suchwort alle Dokumente (bei „strasse“ ca. 4 ms auf dem Regierungsbezirk), und Präfixe über 4 Zeichen häufiger Wörter („stras…“) werden komplett zusammengeführt (ca. 14 ms). Hochgerechnet auf Deutschland drohen 60–220 ms für Anfragen mit „Straße“. Mögliche Lösung: bm25 in JS mit einer beim Import vorberechneten Wortstatistik rechnen und lange Präfixe häufiger Wörter gesondert behandeln. Das weicht von „FTS-Score (`bm25`)“ ab und braucht eine Entscheidung.
- [ ] **Bekanntheitssignal für `importance`:** Bisher zählt nur der Typ. Mit `wikidata`/`wikipedia` oder Einwohnerzahl ließen sich bekannte Objekte nach vorn holen (z. B. „Kö“ → Königsallee; die Golden-Query ist deshalb auf Top 5 gelockert).
- [ ] **Sehenswürdigkeiten fehlen im Index:** `tourism`, `man_made` u. Ä. sind nicht im Import-Filter (Phase 2), z. B. findet „Rheinturm“ nichts.
- [ ] **Straßenabschnitte beim Import zusammenfassen:** Gleichnamige Abschnitte werden bisher erst bei der Suche zusammengefasst (Umkreis 2 km). Beim Import wäre der Index kleiner und die Kandidatenmenge aussagekräftiger.

## Phase 5: Docker

**Ziel:** Ein einziges `Dockerfile`, das ein schlankes, sofort startbares Image baut. Kein docker-compose, weder im Repo noch in der README.

- [ ] Multi-Stage-Build: Stage 1 baut TypeScript (`npm ci`, `npm run build`), Stage 2 enthält nur Produktions-Abhängigkeiten, das Build-Ergebnis und `osmium-tool`
- [ ] Basis-Image mit Debian oder Alpine, je nachdem, was das native SQLite-Modul (`better-sqlite3`) problemlos baut; SQLite muss mit FTS5 kompiliert sein
- [ ] Lauf als Nicht-Root-Nutzer, `/data` als `VOLUME`
- [ ] `ENTRYPOINT` mit Kommandos `serve` (Standard), `import` und `update`; beim ersten `serve` ohne Index wird automatisch importiert
- [ ] `HEALTHCHECK` gegen `/health`; `/health` meldet auch, ob ein Index vorhanden ist
- [ ] `.dockerignore`, feste Versionen der Basis-Images, `EXPOSE 2322`
- [ ] Konfiguration ausschließlich per ENV, Beispiele in der README
- [ ] Smoke-Test-Skript: Image bauen, mit Mini-Extrakt starten, `/api` abfragen

**Fertig, wenn:** `docker build -t meine-api .` und `docker run -p 2322:2322 -v data:/data meine-api` auf einer frischen Maschine zu funktionierenden Vorschlägen führen.

## Phase 6: Updates und Betrieb

**Ziel:** Die API läuft dauerhaft, aktualisiert ihre Daten ohne Ausfall und ist für den öffentlichen Betrieb abgesichert.

- [ ] Update-Kommando: baut `index.next.sqlite` neben dem laufenden Index und tauscht beide per atomarem `rename` aus
- [ ] Die API öffnet den Index nach dem Tausch neu, ohne Neustart (Signal oder interner Zeitplan per `UPDATE_CRON`)
- [ ] Rate-Limiting pro IP, optional pro API-Key (`@fastify/rate-limit`), steuerbar über ENV ob aktiv oder nicht
- [ ] In-Memory-Cache (LRU) für häufige kurze Prefix-Queries
- [ ] Strukturierte Logs und ein `/metrics`-Endpoint im Prometheus-Format
- [ ] Attribution: Antworten und README nennen "© OpenStreetMap contributors" (ODbL)
- [ ] README mit Schnellstart, ENV-Tabelle, Hinweisen zu RAM und Plattenbedarf (Deutschland ca. 4 GB PBF)
- [ ] Lasttest (z. B. mit `autocannon`) und dokumentierte Ergebnisse

**Fertig, wenn:** Ein Update läuft im Betrieb durch, ohne dass währenddessen Anfragen fehlschlagen, und die README reicht für eine Installation ohne Rückfragen.

### Offene Punkte aus dem Code-Review (28.10.2026)

- [ ] **Standort-Suche bei sehr häufigen Wörtern:** Mit `lat`/`lon` prüft die Suche jetzt alle Treffer auf den Umkreis (vorher nur die ersten 20.000, dadurch fehlten nahe Adressen). Synthetisch gemessen mit 1 Mio. gleichnamigen Straßen: ca. 120 ms für „Hauptstr“, 80 ms für „Ha“. Auf dem Deutschland-Index messen; falls zu langsam, die Kandidaten vom R\*Tree aus suchen (kleiner Umkreis zuerst, dann erweitern).
- [ ] **Ort für Straßen ohne Adressen:** Straßen übernehmen Ort und PLZ von der nächsten Adresse an derselben Straße (im Düsseldorf-Test 87 % bzw. 90 %). Straßen ganz ohne Hausnummern bleiben ohne Ort; dafür bräuchte es Verwaltungsgrenzen (`boundary=administrative`).

### Offene Punkte aus Phase 6

- [ ] **Messungen auf dem Deutschland-Index:** Lasttest und Speicher-/Plattenbedarf sind nur auf Testindizes gemessen (17.618 Einträge: ca. 1.100 Anfragen/s ohne Cache auf einem Kern, 0 Fehler bei Updates unter Last). Die README-Angaben für Deutschland (ca. 8 GB Index, mind. 30 GB Platte, 4–8 GB RAM beim Import) sind Hochrechnungen.
- [ ] **Browser- und CDN-Cache nach Updates:** Antworten tragen `Cache-Control: max-age=3600`. Nach einem Update können Clients bis zu einer Stunde alte Vorschläge sehen. Akzeptabel bei täglichen Updates, sonst `max-age` per ENV steuerbar machen.
- [ ] **Update ohne neue Daten:** `update` baut den Index auch dann neu, wenn sich der Extrakt (MD5) nicht geändert hat. Ließe sich überspringen, um Rechenzeit zu sparen.
- [ ] **`/metrics` ist öffentlich:** Schutz bisher nur über den Reverse-Proxy. Bei Bedarf eigene Variable (z. B. `METRICS_TOKEN`).
- [ ] **Docker-Smoke-Test nicht in `npm run ci`:** braucht Docker und läuft deshalb separat (`npm run smoke`).

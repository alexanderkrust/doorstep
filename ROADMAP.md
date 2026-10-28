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

**Fertig, wenn:** Alle Golden-Queries bestehen und die Latenz auf dem vollen Deutschland-Index im Zielbereich liegt. (Latenz erreicht am 28.10.2026: p95 16,5 ms, siehe unten.)

### Offene Punkte aus Phase 4

- [x] **Latenz auf dem Deutschland-Index senken** (28.10.2026, 25,6 Mio. Einträge, `npm run bench`, 5 Runden, MacBook): vorher (Schema 4) p50 22 ms, p95 194 ms, p99 548 ms; jetzt (Schema 5 im Branch, auf main Schema 6) **p50 2,8 ms, p95 16,5 ms, p99 29 ms**, max. 41–91 ms. Profil der langsamsten Anfragen: Ohne `bm25()` dauerte „breite strasse*“ 170 statt 400 ms, „am markt 1*“ 2 statt 240 ms; exakt „strasse“ statt Präfix „strasse*“ 0,3 statt 170 ms. Beide vermuteten Ursachen bestätigt, beide behoben:
  - **Entscheidung: bm25 in JS statt `bm25()` von FTS5** (weicht von „FTS-Score (`bm25`)“ oben ab, die Formel bleibt dieselbe). FTS5 zählt für `bm25()` bei jeder Anfrage alle Dokumente jedes Suchworts. Der Import legt jetzt eine Wortstatistik an (`terms`: Dokumente je Wort, `prefixes`: je Präfix bis 4 Zeichen, Meta `fts_tokens`; 826.000 Wörter, ca. 12 s beim Import). `src/search/bm25.ts` rechnet damit dieselbe Formel (k1 = 1,2, b = 0,75, Spaltengewichte 4/2/1/1/1); die Treffer im Dokument kommen aus dessen Spalten, die wie beim Import erzeugt werden. Ein Test vergleicht das Ergebnis mit `bm25()` von FTS5. Abweichung: Für Präfixe ist die Dokumentzahl die Summe über die passenden Wörter (ein Dokument mit „koelner“ und „kolner“ zählt doppelt).
  - **Lange Präfixe häufiger Wörter werden zerlegt** (`expandPrefix`): FTS5 führt die Trefferlisten aller Wörter eines Präfixes über 4 Zeichen vorab vollständig zusammen. Hat ein Präfix mehr als 50.000 Dokumente, wird es zeichenweise in ODER-verknüpfte Teile zerlegt: das häufige Wort exakt („strasse“), der Rest als längere Präfixe („strassen“*, …). Die Teile decken genau dieselben Wörter ab (Test: gleiche Treffer mit und ohne Zerlegung). „breite strasse*“ 169 → 0,5 ms, „graf adolf strasse*“ 180 → 3 ms.
- [ ] **Umkreissuche mit sehr häufigen Wörtern** ist jetzt der langsamste Fall (alle langsamsten zehn Anfragen haben einen Standort): „Am Markt 1“ 41 ms, „Friedrichstraße 3“ 20–90 ms, „Berliner A“ 27 ms. FTS5 muss die ganze Trefferliste des seltensten Worts („markt“, 47.000 Dokumente) mit „am“ und den Rasterzellen verschneiden, wenn es im Umkreis weniger als 200 Treffer gibt. Verbesserung nur mit räumlich aufgeteiltem Index (z. B. Wort + Zelle als Token, deutlich größerer Index); bei p95 16,5 ms vorerst nicht nötig.
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

- [x] **Standort-Suche bei sehr häufigen Wörtern:** Jeder Eintrag trägt seine Rasterzelle (0,25°) als Token in der FTS-Spalte `cell` (Schema-Version 3). Die Umkreissuche verlangt eine der Zellen der Box, FTS5 verschneidet die Trefferlisten; liegen schon unter den 200 globalen Kandidaten mindestens 10 im Umkreis, wird ohne Zellen gesucht (beide Wege liefern dieselben Zeilen). Synthetisch (1 Mio. ferne Treffer, 500.000 Adressen im Umkreis), ganze Suche mit Standort: „Ha“ 108 → 51 ms, „Hauptstr“ 76 → 38 ms, „Hafen“ 68 → 18 ms; dichte Anfragen („Be“, „Hasenheide 12“) unverändert. Die Dauer hängt jetzt von der Dichte im Umkreis ab, nicht mehr von der Trefferzahl im ganzen Index. Verworfen: Suche vom R\*Tree aus (1–20 s, FTS5 startet die Anfrage pro Zeile neu und bm25 zählt jedes Mal alle Treffer), schmale Koordinatentabelle (ca. 15 %). Der größte verbleibende Anteil war das Zählen der Treffer je Phrase für bm25 (8–20 ms bei häufigen Präfixen, auch ohne Standort); seit Schema 5 rechnet bm25 in JS (siehe Phase 4).
- [ ] **Ort für Straßen ohne Adressen:** Straßen übernehmen Ort und PLZ von der nächsten Adresse an derselben Straße (im Düsseldorf-Test 87 % bzw. 90 %). Straßen ganz ohne Hausnummern bleiben ohne Ort; dafür bräuchte es Verwaltungsgrenzen (`boundary=administrative`).

### Offene Punkte aus Phase 6

- [ ] **Messungen auf dem Deutschland-Index:** Import gemessen (28.10.2026): Schema 4 30 min, max. 5,4 GB RAM, Index 8,5 GB; Schema 5 (mit Grenzen) 39 min, max. 4,2 GB RAM, Index 8,8 GB. Lasttest noch offen (bisher 17.618 Einträge: ca. 1.100 Anfragen/s ohne Cache auf einem Kern, 0 Fehler bei Updates unter Last).

### Offene Punkte aus dem Test mit Deutschland-Daten (28.10.2026)

Behoben: Ortsteile (`addr:suburb`/`addr:hamlet` → `district`, 4,8 Mio. Adressen), Adressen ohne Straße (`addr:place`, 226.000), „Schlosstr“ = „Schloßstraße“, „St.“ = „Sankt“, „Hauptstraße12“, Hausnummer „12 a“ = „12a“ (71.000), „Frankfurt a.M.“, Straße im genannten Ort vor Tippfehler-Treffer in anderem Ort, Heap-Überlauf beim Aufbau des FTS-Index (Import auf Deutschland brach mit Schema 3 ab).

- [x] **Land und Bundesland für Lieferprüfungen:** `addr:country` fehlt bei 29 % der Adressen, `addr:state` fast immer. Der Extrakt enthält Adressen aus allen Nachbarländern (ca. 28.000 mit fremdem `addr:country`, dazu viele ohne). Gelöst (Schema 5, `src/import/boundaries.ts`): Der Import lädt die Grenzen (`boundary=administrative`, `admin_level=2` und `4`) und weist jedem Eintrag Land und Bundesland per Punkt-in-Polygon zu (Raster je Fläche: kantenfreie Zellen sind ganz innen oder außen, sonst Strahl nur bis zur nächsten solchen Zelle). Im Deutschland-Extrakt sind nur Deutschland und die 16 Länder vollständig; außerhalb entscheidet der nächste Grenzweg mit genau einem Nachbarland (Mosel: deutsche und luxemburgische Grenze an verschiedenen Ufern). Grenzen laden 34 s, ca. 300 MB. Voller Import Deutschland: 39 min statt 30 min, max. 4,2 GB RAM (vorher 5,4 GB), Index 8,8 GB; 25,5 Mio. Einträge in DE (alle mit Bundesland), 73.000 in Nachbarländern (CH 16.305, NL 14.208, AT 10.470, CZ 9.633, FR 8.800, PL 6.381, LU 3.426, BE 1.272, DK 1.209), 10 ohne Land. Geprüft an 2,1 Mio. Einträgen: Abweichungen von `addr:country` sind nur Korrekturen (Riezlern/Jungholz `DE` → `AT`, Raeren → `BE`), bei Adressen ohne `addr:country` passt das PLZ-Format immer zum Land. Rest: nahe Dreiländerecken kann ein Punkt im Nachbarland dem falschen Nachbarn zufallen. „Ort für Straßen ohne Adressen“ löst das nicht (dafür bräuchte es `admin_level=8`).
- [x] **Schreibvarianten:** Getrennt geschrieben („Friedrich Straße“) und anders verbunden („Konrad-Adenauerstraße“) werden gefunden (Schema 7): Namen mit Grundwort (Straße, Allee, Platz, Gasse, Damm, Ring, Weg) stehen auch getrennt und zusammengeschrieben im Index.
- [ ] **Tippfehler mitten im Wort** („Friedrichstrase“) werden nicht gefunden, nur am Wortende. Bräuchte eine unscharfe Suche (z. B. Trigramme), die den Index deutlich vergrößert.
- [ ] **Browser- und CDN-Cache nach Updates:** Antworten tragen `Cache-Control: max-age=3600`. Nach einem Update können Clients bis zu einer Stunde alte Vorschläge sehen. Akzeptabel bei täglichen Updates, sonst `max-age` per ENV steuerbar machen.
- [ ] **Update ohne neue Daten:** `update` baut den Index auch dann neu, wenn sich der Extrakt (MD5) nicht geändert hat. Ließe sich überspringen, um Rechenzeit zu sparen.
- [ ] **`/metrics` ist öffentlich:** Schutz bisher nur über den Reverse-Proxy. Bei Bedarf eigene Variable (z. B. `METRICS_TOKEN`).
- [ ] **Docker-Smoke-Test nicht in `npm run ci`:** braucht Docker und läuft deshalb separat (`npm run smoke`).

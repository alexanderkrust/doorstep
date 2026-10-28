# Test-Fixtures

`koenigsallee.osm.pbf` ist ein kleiner Ausschnitt aus OpenStreetMap rund um die Königsallee in
Düsseldorf (Bounding Box 6.7760,51.2190 – 6.7830,51.2290), bereits mit dem Tag-Filter des
Imports (`src/import/osmium.ts`, `TAG_FILTERS`) reduziert.

`koenigsallee.geojsonseq` ist dieselbe Datei als GeoJSON-Sequenz. Sie wird für Tests genutzt,
die ohne `osmium` laufen sollen.

`duesseldorf.geojsonseq` ist größer und dient den Golden-Queries (`test/golden/`) für das
Ranking: Innenstadt Düsseldorf (6.765,51.210 – 6.800,51.235), Innenstadt Neuss
(6.680,51.190 – 6.705,51.205) und alle Ortsknoten (`place=city,town,village,suburb,borough,quarter`)
des Regierungsbezirks Düsseldorf. Zur Verkleinerung enthält jedes Feature nur die vom Import
gelesenen Tags und als Geometrie den repräsentativen Punkt (`scripts/slim-fixture.ts`).
Stand: Geofabrik-Extrakt vom 2026-10-27.

Daten: © OpenStreetMap contributors, verfügbar unter der
[Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).

## Neu erzeugen

```bash
curl -A 'doorstep-dev' -o map.osm 'https://api.openstreetmap.org/api/0.6/map?bbox=6.7760,51.2190,6.7830,51.2290'
osmium tags-filter map.osm nwr/addr:housenumber nwr/addr:street nwr/place w/highway nwr/amenity \
  -o test/fixtures/koenigsallee.osm.pbf --overwrite
osmium export test/fixtures/koenigsallee.osm.pbf -f geojsonseq -a type,id \
  -o test/fixtures/koenigsallee.geojsonseq --overwrite
```

### `duesseldorf.geojsonseq`

```bash
curl -O https://download.geofabrik.de/europe/germany/nordrhein-westfalen/duesseldorf-regbez-latest.osm.pbf
SRC=duesseldorf-regbez-latest.osm.pbf
osmium extract -b 6.765,51.210,6.800,51.235 -s smart $SRC -o dus.pbf
osmium extract -b 6.680,51.190,6.705,51.205 -s smart $SRC -o neuss.pbf
osmium tags-filter $SRC n/place=city,town,village,suburb,borough,quarter -o places.pbf
osmium merge dus.pbf neuss.pbf places.pbf -o merged.pbf
osmium tags-filter merged.pbf nwr/addr:housenumber nwr/addr:street nwr/place w/highway nwr/amenity \
  -o filtered.pbf
osmium export filtered.pbf -f geojsonseq --attributes=type,id -x print_record_separator=false \
  -o full.geojsonseq
npx tsx scripts/slim-fixture.ts full.geojsonseq test/fixtures/duesseldorf.geojsonseq
```

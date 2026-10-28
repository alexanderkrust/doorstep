# Test-Fixtures

`koenigsallee.osm.pbf` ist ein kleiner Ausschnitt aus OpenStreetMap rund um die Königsallee in
Düsseldorf (Bounding Box 6.7760,51.2190 – 6.7830,51.2290), bereits mit dem Tag-Filter des
Imports (`src/import/osmium.ts`, `TAG_FILTERS`) reduziert.

`koenigsallee.geojsonseq` ist dieselbe Datei als GeoJSON-Sequenz. Sie wird für Tests genutzt,
die ohne `osmium` laufen sollen.

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

# Test fixtures

`koenigsallee.osm.pbf` is a small excerpt from OpenStreetMap around the Königsallee in
Düsseldorf (bounding box 6.7760,51.2190 – 6.7830,51.2290), already reduced with the import's
tag filter (`src/import/osmium.ts`, `TAG_FILTERS`).

`koenigsallee.geojsonseq` is the same file as a GeoJSON sequence. It is used by tests that should
run without `osmium`.

`duesseldorf.geojsonseq` is larger and serves the golden queries (`test/golden/`) for the
ranking: Düsseldorf city center including the Rheinturm (6.755,51.210 – 6.800,51.235), Neuss city center
(6.680,51.190 – 6.705,51.205) and all place nodes (`place=city,town,village,suburb,borough,quarter`)
of the Düsseldorf administrative region. To keep it small, every feature contains only the tags
the import reads (`IMPORTED_TAGS` in `src/import/place.ts` and `addr:*`) and the representative
point as geometry (`scripts/slim-fixture.ts`).
As of: Geofabrik extract from 2026-11-05.

`boundaries.geojsonseq` and `boundaries.opl` are administrative boundaries (`admin_level=2` and
`4`) from the Geofabrik Germany extract from 2026-10-27, clipped to four test regions:
Aachen/Kerkrade/Vaals, Kleinwalsertal/Oberstdorf, Büsingen/Schaffhausen and the Moselle
(Schengen–Wasserbillig). Areas (only Germany and its states are complete in the extract) are
clipped to the regions; boundary ways and relations are reduced to the ways located there
(`scripts/boundary-fixture.ts`).

Data: © OpenStreetMap contributors, available under the
[Open Database License (ODbL)](https://opendatacommons.org/licenses/odbl/).

## Regenerating

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
osmium extract -b 6.755,51.210,6.800,51.235 -s smart $SRC -o dus.pbf
osmium extract -b 6.680,51.190,6.705,51.205 -s smart $SRC -o neuss.pbf
osmium tags-filter $SRC n/place=city,town,village,suburb,borough,quarter -o places.pbf
osmium merge dus.pbf neuss.pbf places.pbf -o merged.pbf
# The import's tag filters (bash/sh: $FILTERS is split into words; in zsh use ${=FILTERS})
FILTERS=$(npx tsx -e "import('./src/import/osmium.ts').then((m) => console.log(m.TAG_FILTERS.join(' ')))")
osmium tags-filter merged.pbf $FILTERS -o filtered.pbf
osmium export filtered.pbf -f geojsonseq --attributes=type,id -x print_record_separator=false \
  -o full.geojsonseq
npx tsx scripts/slim-fixture.ts full.geojsonseq test/fixtures/duesseldorf.geojsonseq
```

### `boundaries.geojsonseq`, `boundaries.opl`

```bash
osmium tags-filter germany-latest.osm.pbf r/admin_level=2,4 -o admin.pbf
osmium export admin.pbf -f geojsonseq --geometry-types=polygon,linestring --keep-untagged \
  --attributes=type,id -x print_record_separator=false -o boundaries-full.geojsonseq
osmium cat admin.pbf -t relation -f opl,add_metadata=false -o relations.opl
npx tsx scripts/boundary-fixture.ts boundaries-full.geojsonseq relations.opl test/fixtures/boundaries
```

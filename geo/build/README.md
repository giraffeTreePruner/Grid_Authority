# Geometry pipeline

Run by hand, rarely. The output — `geo/zones.pmtiles` and `geo/src/zones.simplified.geojson`
— is committed, so nothing here runs at build or deploy time.

## Source

**electricitymaps-contrib `geo/world.geojson`**, AGPL-3.0.

This project is AGPL-3.0, so reuse is permitted. Attribution is recorded in
`config/sources.yaml` under the `emaps_geo` entry and on `/about/data`.

Its zone keys already follow the convention this project uses (`US-CAL-CISO`), so the
join is by key with no fuzzy matching.

**HIFLD Open "Control Areas" was the first choice and is not usable.** It is public
domain, which would have avoided the AGPL attribution entirely, but its ArcGIS feature
services now reject anonymous queries — `/FeatureServer/0?f=json` returns
`{"error":{"code":400,"message":"Invalid URL"}}` and the dataset is absent from the
public Hub search. Revisit if HIFLD restores open access: it is the authoritative source
for US balancing authority territories and would cover the zones listed below.

## Steps

```sh
pnpm install                                  # once, for mapshaper
brew install tippecanoe                       # once

node geo/build/fetch-source.js                # 1. download world.geojson (not committed)
node geo/build/prepare-zones.js               # 2. select, join, derive
pnpm --filter @grid-authority/geo-build exec \
  mapshaper geo/src/zones.raw.geojson -clean -simplify 50% keep-shapes \
  -o precision=0.00001 format=geojson geo/src/zones.simplified.geojson   # 3. simplify

tippecanoe -o geo/zones.pmtiles -l zones -Z3 -z8 \
  --drop-densest-as-needed --extend-zooms-if-still-dropping --force \
  geo/src/zones.simplified.geojson            # 4. build tiles

node geo/build/validate.js                    # 5. gate
```

Step 2 exits non-zero and names any `in_map: true` zone with no polygon. Step 5 exits
non-zero unless every mapped zone has exactly one feature, every feature matches a mapped
zone, and the artifact is a PMTiles v3 archive within budget.

## Simplification

The spec targets 300–600 KB gzipped. The source is already generalised, so the artifact
lands far below that: **169.5 KB**, against a 600 KB ceiling.

Because there is so much headroom, simplification is deliberately light — 50%, shapes
preserved. Simplifying harder would only degrade the coastlines and state borders for a
saving nobody needs. `-clean` runs first to fix topology; it removed one sliver.

Each feature carries only `zone_key`. Everything else comes from the API at runtime, so
the two cannot drift apart.

## Derived geometry

**`US-NW-SWPW` = `US-NW-WACM` ∪ `US-NW-WAUW`.**

The Southwest Power Pool's West balancing authority area has no polygon of its own. It
was created when SPP absorbed the two Western Area Power Administration balancing
authorities, and two independent lines of evidence support the union: the source dataset
still carries WACM and WAUW, and this project's own ingest shows both stopped publishing
at 2026-04-02T18 with SWPW beginning at the same moment.

The feature is labelled `derived_from` in the intermediate GeoJSON so it is not mistaken
for source data.

## Zones with no geometry

These are `in_map: false` with the reason recorded inline in `config/zones.yaml`. They
still have data, and still appear in `/zones` and in national totals; they simply have no
polygon to draw.

| Zone           | Why                                                                                  |
| -------------- | ------------------------------------------------------------------------------------ |
| `US-NW-AVRN`   | Generator-only balancing authority, no service territory                             |
| `US-NW-BHBA`   | Absent from the source; became its own balancing authority after it was last updated |
| `US-SW-DEAA`   | A single generating station                                                          |
| `US-NW-GRID`   | Generator-only balancing authority, no service territory                             |
| `US-NW-GWA`    | Wind generation balancing authority, no service territory                            |
| `US-SE-SEPA`   | Markets federal hydropower rather than serving load                                  |
| `US-MIDW-SIKE` | A single municipal generating station                                                |
| `US-NW-WWA`    | Wind generation balancing authority, no service territory                            |
| `US-CAR-YAD`   | Hydro generation balancing authority, no service territory                           |

Eight of the nine have no territory to draw at any source: they are individual power
plants, wind farms, or federal power marketers. Only `US-NW-BHBA` is a real territory the
source happens to lack, and it is the one to revisit if HIFLD reopens.

## Re-running after a registry change

Adding a zone with `in_map: true` will fail step 2 until geometry exists for it. That is
deliberate: it forces a decision between finding a polygon and documenting why there
isn't one.

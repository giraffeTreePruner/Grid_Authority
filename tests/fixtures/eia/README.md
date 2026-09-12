# EIA fixtures

Recorded responses from `https://api.eia.gov/v2/`, captured on 2026-09-12. No test makes
a network call; these files are the only EIA data the suite ever sees.

Every file is a real response. Values, field names and the response envelope are exactly
as the API returned them. Two transformations were applied, both mechanical:

- **Minified.** Whitespace only.
- **Row-filtered**, where noted below. Rows were filtered to a subset and `total` was set
  to match, so each file is exactly what the API would have returned for the narrower
  query. The pagination pair is unfiltered, because its size is the point.

The API key is sent as a query parameter and the API echoes request parameters back, so
every response had the key replaced with `REDACTED` before it was written. Confirm with:

```sh
grep -r REDACTED tests/fixtures/eia | wc -l     # every file
grep -rnoE '[A-Za-z0-9]{20,}' tests/fixtures/eia | grep -v REDACTED   # must be empty
```

## Files

| Path                                        | Request                                                | Rows       | Filter                 |
| ------------------------------------------- | ------------------------------------------------------ | ---------- | ---------------------- |
| `facets/region-respondent.json`             | `region-data/facet/respondent`                         | 83         | none                   |
| `facets/region-type.json`                   | `region-data/facet/type`                               | 4          | none                   |
| `facets/fueltype.json`                      | `fuel-type-data/facet/fueltype`                        | 20         | none                   |
| `facets/interchange-fromba.json`            | `interchange-data/facet/fromba`                        | 83         | none                   |
| `routes/*.json`                             | route metadata for the three datasets                  | —          | none                   |
| `pagination/fuel-type-page-00{0,1}.json`    | `fuel-type-data/data`, 2026-09-10T18→2026-09-11T06     | 5000 + 418 | none                   |
| `category-change/fuel-type-2024-06-15.json` | `fuel-type-data/data`, 2024-06-15T00→T06               | 389        | period `2024-06-15T00` |
| `category-change/fuel-type-2024-12-15.json` | `fuel-type-data/data`, 2024-12-15T00→T06               | 407        | period `2024-12-15T00` |
| `missing-hour/region-gvl-demand.json`       | `region-data/data` type D, 2026-08-27T02→2026-09-10T02 | 308        | respondent `GVL`       |
| `poll/region-d-ng-ti.json`                  | `region-data/data` types D,NG,TI, 12h                  | 803        | none                   |
| `poll/region-df.json`                       | `region-data/data` type DF, forward 48h                | 1158       | none                   |
| `poll/interchange.json`                     | `interchange-data/data`, 12h                           | 674        | first two periods      |

## What each one is for

**`facets/`** — the authoritative code lists. §5.2 makes an unrecognised respondent or
fuel type a fatal startup error; these are what that check runs against, and what fails
when EIA adds a code.

**`pagination/`** — `total` is 5418 across two pages, so a client that assumes one request
is enough loses 418 rows. Committed at full size deliberately: the 5000-row cap is the
thing being tested, and a trimmed page would not exercise it.

**`category-change/`** — the 2024 H2 fuel-category expansion, shown rather than asserted.
June returns 8 codes (`COL NG NUC OIL OTH SUN WAT WND`), exactly the set hardcoded in the
build spec. December returns 12, adding `BAT PS SNB UES`. The facet endpoint now lists 16.

**`missing-hour/`** — GVL demand with a genuine 19-hour interior gap, 2026-08-27T18
through 2026-08-28T12. Found in real data, not manufactured. Missing hours must stay
missing: no interpolation, no forward-fill, no zero.

**`poll/`** — one cycle's worth of each route group, for the end-to-end ingest tests.

## Re-recording

`Planning/eia-discovery/` holds the fetch script and its raw output. It is gitignored:
it needs an API key, and these committed fixtures are derived from it.

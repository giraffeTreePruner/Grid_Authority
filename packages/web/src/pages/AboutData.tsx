/**
 * /about/data — every source, with its licence and attribution.
 *
 * Generated from what the API serves, not from a copy kept here, so the page cannot
 * drift from the registry the ingest actually uses.
 *
 * Inactive entries are shown too. `emaps_method` in particular must appear with its
 * label verbatim: any figure computed with that methodology has to carry it, and the
 * registry is where the exact wording lives.
 */
import { useQuery } from '@tanstack/react-query';
import { ApiError, fetchSources } from '../api/client.ts';
import { formatAge } from '../lib/format.ts';
import type { Source } from '../api/types.ts';

const describeLatency = (source: Source): string | null => {
  if (source.observed_latency.length === 0) return null;
  const parts = source.observed_latency.map((reading) => {
    const hours = reading.lag_minutes === null ? null : (reading.lag_minutes / 60).toFixed(1);
    return `${reading.dataset}: ${hours === null ? 'unknown' : `${hours}h behind`}`;
  });
  return parts.join(' · ');
};

export const AboutData = (): JSX.Element => {
  const sources = useQuery({
    queryKey: ['sources'],
    queryFn: ({ signal }) => fetchSources(signal),
    staleTime: 60 * 60 * 1000,
  });

  return (
    <article className="mx-auto max-w-3xl px-4 py-10 sm:px-6" data-testid="about-data">
      <h1 className="text-lg font-semibold text-zinc-100">About the data</h1>

      <p className="mt-3 text-sm leading-relaxed text-zinc-400">
        Every figure on this site comes from the sources below following the license terms they
        published. You may have noticed gaps in the data, that's intentional. Nothing is
        interpolated, forward-filled, or substituted with zero. EIA data, which is the backbone of
        most grid viewers including this one, often contains holes. An hour a source did not publish
        is shown as missing, and is not an issue with Grid Authority.
      </p>

      <p className="mt-3 text-sm leading-relaxed text-zinc-400">
        All timestamps are UTC and label the start of the hour. An hour labelled 14:00:00Z covers
        14:00:00 to 14:59:59.
      </p>

      {sources.isPending && (
        <p className="mt-6 text-sm text-zinc-500" data-testid="about-loading">
          Loading sources…
        </p>
      )}

      {sources.isError && (
        <p role="alert" className="mt-6 text-sm text-red-300" data-testid="about-error">
          {sources.error instanceof ApiError
            ? sources.error.message
            : 'The source registry could not be loaded.'}
        </p>
      )}

      {sources.data !== undefined && (
        <div className="mt-8 flex flex-col gap-6">
          {sources.data.sources.map((source) => {
            const latency = describeLatency(source);
            return (
              <section
                key={source.id}
                className="rounded border border-zinc-800 p-4"
                data-testid={`source-${source.id}`}
              >
                <header className="flex flex-wrap items-baseline justify-between gap-2">
                  <h2 className="text-sm font-medium text-zinc-100">{source.label}</h2>
                  <span
                    className={[
                      'rounded px-1.5 py-0.5 text-[10px]',
                      source.active
                        ? 'bg-emerald-900/60 text-emerald-200'
                        : 'bg-zinc-800 text-zinc-400',
                    ].join(' ')}
                  >
                    {source.active ? 'in use' : 'not in this version... yet'}
                  </span>
                </header>

                {/*
                  Two columns from `sm` up, plain flow below it.

                  It was a grid at every width, and `1fr` is `minmax(auto, 1fr)` — the
                  `auto` floor is the track's min-content width, so a value with nothing
                  to break on held the column open. A source URL is one long token, so on
                  a 375px screen the page laid out 100px wider than the viewport and the
                  whole article scrolled sideways. `minmax(0, 1fr)` lets the track shrink;
                  `break-words` gives the URL somewhere to break once it has to.

                  On a phone a fixed 8rem label column also spent 43% of the width on the
                  labels, so below `sm` the pair simply stacks and the value gets all of
                  it.
                */}
                <dl className="mt-3 text-xs sm:grid sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-x-4 sm:gap-y-1.5">
                  <dt className="mt-2 text-zinc-500 sm:mt-0">Attribution</dt>
                  <dd className="break-words text-zinc-300">{source.attribution}</dd>

                  <dt className="mt-2 text-zinc-500 sm:mt-0">Licence</dt>
                  <dd className="break-words text-zinc-300">{source.license}</dd>

                  <dt className="mt-2 text-zinc-500 sm:mt-0">Independent</dt>
                  <dd className="break-words text-zinc-300">
                    {source.independent ? 'Yes' : 'No, this is derived from other sources'}
                  </dd>

                  <dt className="mt-2 text-zinc-500 sm:mt-0">Link</dt>
                  <dd>
                    <a
                      className="break-all text-zinc-300 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-100"
                      href={source.url}
                    >
                      {source.url}
                    </a>
                  </dd>

                  {latency !== null && (
                    <>
                      <dt className="mt-2 text-zinc-500 sm:mt-0">Measured lag</dt>
                      <dd
                        className="break-words text-zinc-300"
                        data-testid={`latency-${source.id}`}
                      >
                        {latency}
                      </dd>
                    </>
                  )}

                  {source.jobs.length > 0 && (
                    <>
                      <dt className="mt-2 text-zinc-500 sm:mt-0">Last collected</dt>
                      <dd className="break-words text-zinc-300">
                        {source.jobs.map((job) => (
                          <span key={job.job} className="mr-3 inline-block">
                            {job.job}: {formatAge(job.last_success_at)}
                          </span>
                        ))}
                      </dd>
                    </>
                  )}
                </dl>

                {source.notes !== '' && (
                  <p className="mt-3 whitespace-pre-line text-xs leading-relaxed text-zinc-400">
                    {source.notes}
                  </p>
                )}
              </section>
            );
          })}
        </div>
      )}

      <footer className="mt-10 border-t border-zinc-800 pt-4 text-xs text-zinc-500">
        <p>
          Copyright &copy; 2026 Drew Meyers. Licensed under the GNU Affero General Public License,
          version 3. Section 13 of that licence entitles you, as a user of this server, to its
          complete source, which is at{' '}
          <a
            className="underline decoration-zinc-700 underline-offset-2 hover:text-zinc-300"
            href="https://github.com/giraffeTreePruner/Grid_Authority"
          >
            github.com/giraffeTreePruner/Grid_Authority
          </a>
          .
        </p>
        <p className="mt-2">
          <a
            className="underline decoration-zinc-700 underline-offset-2 hover:text-zinc-300"
            href="/"
          >
            Back to the map
          </a>
        </p>
      </footer>
    </article>
  );
};

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
    <article className="mx-auto max-w-3xl px-6 py-10" data-testid="about-data">
      <h1 className="text-lg font-semibold text-zinc-100">About the data</h1>

      <p className="mt-3 text-sm leading-relaxed text-zinc-400">
        Every figure on this site comes from the sources below. Nothing is interpolated,
        forward-filled, or substituted with zero: an hour a source did not publish is shown as
        missing, because a grid at zero demand and a grid we know nothing about are not the same
        thing.
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
                    {source.active ? 'in use' : 'registered, not in use'}
                  </span>
                </header>

                <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1.5 text-xs">
                  <dt className="text-zinc-500">Attribution</dt>
                  <dd className="text-zinc-300">{source.attribution}</dd>

                  <dt className="text-zinc-500">Licence</dt>
                  <dd className="text-zinc-300">{source.license}</dd>

                  <dt className="text-zinc-500">Independent</dt>
                  <dd className="text-zinc-300">
                    {source.independent ? 'Yes' : 'No — derived from another source'}
                  </dd>

                  <dt className="text-zinc-500">Link</dt>
                  <dd>
                    <a
                      className="text-zinc-300 underline decoration-zinc-700 underline-offset-2 hover:text-zinc-100"
                      href={source.url}
                    >
                      {source.url}
                    </a>
                  </dd>

                  {latency !== null && (
                    <>
                      <dt className="text-zinc-500">Measured lag</dt>
                      <dd className="text-zinc-300" data-testid={`latency-${source.id}`}>
                        {latency}
                      </dd>
                    </>
                  )}

                  {source.jobs.length > 0 && (
                    <>
                      <dt className="text-zinc-500">Last collected</dt>
                      <dd className="text-zinc-300">
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

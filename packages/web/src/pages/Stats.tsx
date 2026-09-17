/**
 * The unlisted usage page.
 *
 * Not linked from anywhere and disallowed in robots.txt. Unlisted is not private — the
 * path is guessable and the endpoint behind it is public — so nothing sensitive belongs
 * here, and nothing here is: these are counts of page views, and identities that expire
 * daily.
 *
 * One source: the beacon, which counts what reached this app. A reader whose browser
 * dropped the beacon is not counted, so these are a floor rather than a total, and the
 * page does not pretend otherwise.
 */
import { useQuery } from '@tanstack/react-query';
import { ApiError, fetchStats } from '../api/client.ts';

const NUMBER = new Intl.NumberFormat();

interface CellProps {
  label: string;
  value: number | null;
  testId: string;
}

const Figure = ({ label, value, testId }: CellProps): JSX.Element => (
  <div className="flex flex-col gap-0.5">
    <dt className="text-[11px] uppercase tracking-wide text-zinc-500">{label}</dt>
    <dd className="text-lg font-semibold tabular-nums text-zinc-100" data-testid={testId}>
      {value === null ? '—' : NUMBER.format(value)}
    </dd>
  </div>
);

export const Stats = (): JSX.Element => {
  const stats = useQuery({ queryKey: ['stats'], queryFn: ({ signal }) => fetchStats(signal) });

  return (
    <main className="mx-auto max-w-3xl px-4 py-8">
      <header className="mb-6">
        <h1 className="text-lg font-semibold text-zinc-100">Usage</h1>
        <p className="mt-1 text-xs text-zinc-400">
          Unlisted, not secret. Counted by this site, from a beacon the browser may drop, so these
          are a floor rather than a total.
        </p>
      </header>

      {stats.isPending && (
        <p className="text-xs text-zinc-500" data-testid="stats-loading">
          Loading…
        </p>
      )}

      {stats.isError && (
        <p role="alert" className="text-xs text-red-300" data-testid="stats-error">
          {stats.error instanceof ApiError ? stats.error.message : 'Could not load usage.'}
        </p>
      )}

      {stats.data !== undefined && (
        <>
          <section className="mb-6 rounded border border-zinc-800 p-4" data-testid="own-counts">
            <h2 className="mb-3 text-sm font-medium text-zinc-200">Totals</h2>

            <dl className="grid grid-cols-3 gap-4">
              <Figure label="Views today" value={stats.data.views.today} testId="views-today" />
              <Figure label="Views, 7 days" value={stats.data.views.week} testId="views-week" />
              <Figure label="Views, all time" value={stats.data.views.all} testId="views-all" />
              <Figure
                label="Visitors today"
                value={stats.data.visitors.today}
                testId="visitors-today"
              />
              <Figure
                label="Visitors, 7 days"
                value={stats.data.visitors.week}
                testId="visitors-week"
              />
              <Figure
                label="Visitors, all time"
                value={stats.data.visitors.all}
                testId="visitors-all"
              />
            </dl>

            <p className="mt-3 text-[11px] text-zinc-500" data-testid="visitors-note">
              {stats.data.visitors_note}
            </p>
          </section>

          <section data-testid="daily-table">
            <h2 className="mb-2 text-sm font-medium text-zinc-200">Last 30 days</h2>
            {stats.data.daily.length === 0 ? (
              <p className="text-xs text-zinc-500">Nothing recorded yet.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-zinc-800 text-left text-zinc-500">
                      <th className="py-1 font-normal">Day</th>
                      <th className="py-1 text-right font-normal">Views</th>
                      <th className="py-1 text-right font-normal">Visitors</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stats.data.daily.map((row) => (
                      <tr key={row.day} className="border-b border-zinc-900">
                        <td className="py-1 tabular-nums text-zinc-300">{row.day}</td>
                        <td className="py-1 text-right tabular-nums text-zinc-100">
                          {NUMBER.format(row.views)}
                        </td>
                        <td className="py-1 text-right tabular-nums text-zinc-100">
                          {NUMBER.format(row.visitors)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        </>
      )}

      <footer className="mt-8 border-t border-zinc-800 pt-3 text-[11px] text-zinc-600">
        <a
          className="underline decoration-zinc-700 underline-offset-2 hover:text-zinc-400"
          href="/"
        >
          Back to the map
        </a>
      </footer>
    </main>
  );
};

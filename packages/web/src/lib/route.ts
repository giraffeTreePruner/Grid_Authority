/**
 * Routing, such as it is.
 *
 * Three pages and no router dependency: §3's list does not include one, and two path
 * tests are not worth a library.
 */
export type Route = 'map' | 'about-data' | 'stats';

/** The canonical path for each route, which is also what the beacon reports. */
export const PATH_FOR: Record<Route, string> = {
  map: '/',
  'about-data': '/about/data',
  stats: '/stats',
};

export const routeFor = (pathname: string): Route => {
  const trimmed = pathname.replace(/\/+$/, '');
  if (trimmed === '/about/data') return 'about-data';
  if (trimmed === '/stats') return 'stats';
  return 'map';
};

/**
 * Routing, such as it is.
 *
 * Two pages and no router dependency: §3's list does not include one, and one path test
 * is not worth a library.
 */
export type Route = 'map' | 'about-data';

export const routeFor = (pathname: string): Route =>
  pathname.replace(/\/+$/, '') === '/about/data' ? 'about-data' : 'map';

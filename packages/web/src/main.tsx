import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { AboutData } from './pages/AboutData.tsx';
import { Stats } from './pages/Stats.tsx';
import { PATH_FOR, routeFor } from './lib/route.ts';
import { reportPageView } from './lib/beacon.ts';
import './index.css';

const client = new QueryClient({
  defaultOptions: {
    queries: {
      // Zone detail is cached for five minutes, as the spec asks; the map window is
      // refetched on its own schedule.
      staleTime: 5 * 60 * 1000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});

const container = document.getElementById('root');
if (container === null) throw new Error('#root is missing from index.html');

const route = routeFor(window.location.pathname);

// Reported as the canonical path for the route, not as the URL typed. A query string or
// a trailing slash is not a different page, and echoing back whatever was in the address
// bar would store whatever a visitor happened to be carrying in it.
reportPageView(PATH_FOR[route]);

const page = route === 'about-data' ? <AboutData /> : route === 'stats' ? <Stats /> : <App />;

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={client}>{page}</QueryClientProvider>
  </StrictMode>,
);

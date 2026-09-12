import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App.tsx';
import { AboutData } from './pages/AboutData.tsx';
import { routeFor } from './lib/route.ts';
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

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={client}>
      {routeFor(window.location.pathname) === 'about-data' ? <AboutData /> : <App />}
    </QueryClientProvider>
  </StrictMode>,
);

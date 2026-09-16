import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// uPlot calls bare `matchMedia` at import time, to watch for a change of device pixel
// ratio. jsdom puts it on `window` and not on the global scope, so the bare call throws
// while the module is still evaluating and takes the whole test file with it. A stub
// that reports "no match" is honest here: there is no screen to change ratio on.
if (typeof globalThis.matchMedia !== 'function') {
  globalThis.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as typeof globalThis.matchMedia;
}

// Auto-cleanup only fires when vitest globals are enabled, which they are not here.
// Without this, renders accumulate and queries find several copies of the same control.
afterEach(() => {
  cleanup();
});

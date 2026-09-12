import '@testing-library/jest-dom/vitest';
import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';

// Auto-cleanup only fires when vitest globals are enabled, which they are not here.
// Without this, renders accumulate and queries find several copies of the same control.
afterEach(() => {
  cleanup();
});

import '@testing-library/jest-dom/vitest';
import { setupI18n } from './lib/i18n-setup';

// jsdom has no layout engine and therefore no `matchMedia` — stub it so anything using
// `prefers-color-scheme` (the dark-mode default in `useTheme.ts`) can run under it.
if (typeof window.matchMedia !== 'function') {
  window.matchMedia = (query: string): MediaQueryList =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => undefined,
      removeListener: () => undefined,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      dispatchEvent: () => false,
    }) as MediaQueryList;
}

// Initialize i18n for frontend tests
setupI18n();

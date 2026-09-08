/**
 * i18n setup and initialization.
 * Loads all translation files and initializes the i18n manager.
 *
 * This module must be imported and initialized in your main app file before any i18n hooks are used.
 */

import { initializeI18n, type Translations } from './i18n';
import en from '../translations/en.json';
import de from '../translations/de.json';

/**
 * Initialize i18n with all available translations.
 * Call this once in your app's root component or entry point.
 *
 * Usage:
 *   // In App.tsx or main.tsx
 *   import { setupI18n } from './lib/i18n-setup';
 *
 *   export function App() {
 *     useEffect(() => {
 *       setupI18n();
 *     }, []);
 *     return <YourApp />;
 *   }
 */
export function setupI18n(): void {
  const translations: Translations = {
    en,
    de,
  };

  // Detect browser language if available
  let preferredLanguage: 'en' | 'de' = 'en';
  if (typeof navigator !== 'undefined' && navigator.language?.length) {
    const browserLang = navigator.language.split('-')[0]?.toLowerCase() ?? '';
    if (browserLang === 'de') {
      preferredLanguage = 'de';
    }
  }

  initializeI18n(translations, preferredLanguage);
}

/**
 * List of available languages for dynamic selection.
 */
export const AVAILABLE_LANGUAGES = [
  { code: 'en' as const, name: 'English', nativeName: 'English' },
  { code: 'de' as const, name: 'Deutsch', nativeName: 'Deutsch' },
] as const;

/**
 * Internationalization (i18n) system for TNC Network Bridge UI.
 *
 * Provides:
 * - Translation key-value lookups
 * - Language switching with persistence
 * - Type-safe translation keys
 * - Nested namespace support
 *
 * Usage:
 *   const t = useTranslation('dashboard');
 *   <span>{t('title')}</span>
 */

export type LanguageCode = 'en' | 'de';

export interface TranslationNamespace {
  [key: string]: string | TranslationNamespace;
}

export type Translations = Record<LanguageCode, Record<string, TranslationNamespace>>;

/**
 * Get nested value from object using dot notation.
 * @example getNestedValue({ a: { b: 'value' } }, 'a.b') => 'value'
 */
function getNestedValue(obj: unknown, path: string): string | undefined {
  if (typeof obj !== 'object' || obj === null) return undefined;

  const keys = path.split('.');
  let current: unknown = obj;

  for (const key of keys) {
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[key];
  }

  return typeof current === 'string' ? current : undefined;
}

/**
 * Parse HTML-safe translation strings with variable substitution.
 * @example parseTranslation('Hello {name}!', { name: 'World' }) => 'Hello World!'
 */
export function parseTranslation(
  text: string,
  variables?: Record<string, string | number>,
): string {
  if (!variables) return text;

  let result = text;
  for (const [key, value] of Object.entries(variables)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
  }
  return result;
}

/**
 * I18nManager: Core translation management.
 */
export class I18nManager {
  private currentLanguage: LanguageCode;
  private translations: Translations;
  private storageKey = 'tnc-bridge:language';

  constructor(translations: Translations, initialLanguage?: LanguageCode) {
    this.translations = translations;

    // Load from localStorage if available, otherwise use initial or 'en'
    const stored = this.loadFromStorage();
    this.currentLanguage = stored ?? initialLanguage ?? 'en';

    if (!this.translations[this.currentLanguage]) {
      this.currentLanguage = 'en';
    }
  }

  /**
   * Get current language code
   */
  getLanguage(): LanguageCode {
    return this.currentLanguage;
  }

  /**
   * Set language and persist to localStorage
   */
  setLanguage(lang: LanguageCode): void {
    if (this.translations[lang]) {
      this.currentLanguage = lang;
      this.saveToStorage(lang);
    }
  }

  /**
   * Get available languages
   */
  getAvailableLanguages(): LanguageCode[] {
    return Object.keys(this.translations) as LanguageCode[];
  }

  /**
   * Translate a key in a namespace with optional variable substitution.
   * @example t('dashboard', 'title') or t('dashboard', 'welcome', { name: 'John' })
   */
  translate(namespace: string, key: string, variables?: Record<string, string | number>): string {
    const ns = this.translations[this.currentLanguage]?.[namespace];
    if (!ns) {
      return `[${namespace}:${key}]`; // Fallback for missing namespace
    }

    const text = getNestedValue(ns, key);
    if (!text) {
      return `[${namespace}:${key}]`; // Fallback for missing key
    }

    return parseTranslation(text, variables ?? {});
  }

  /**
   * Load language preference from localStorage
   */
  private loadFromStorage(): LanguageCode | null {
    if (typeof window === 'undefined') return null;
    const stored = window.localStorage?.getItem(this.storageKey);
    return (stored as LanguageCode) || null;
  }

  /**
   * Persist language preference to localStorage
   */
  private saveToStorage(lang: LanguageCode): void {
    if (typeof window === 'undefined') return;
    window.localStorage?.setItem(this.storageKey, lang);
  }
}

// Global singleton instance (initialized by app)
let globalI18n: I18nManager | null = null;

/**
 * Initialize global i18n manager. Must be called once at app startup.
 */
export function initializeI18n(translations: Translations, lang?: LanguageCode): I18nManager {
  globalI18n = new I18nManager(translations, lang);
  return globalI18n;
}

/**
 * Get the global i18n manager instance
 */
export function getI18n(): I18nManager {
  if (!globalI18n) {
    throw new Error('i18n not initialized. Call initializeI18n() first.');
  }
  return globalI18n;
}

import { useCallback, useEffect, useState } from 'react';
import { getI18n, type LanguageCode } from '../lib/i18n';

export interface UseTranslationOptions {
  readonly namespace: string;
}

/**
 * Hook for translation support in React components.
 *
 * Usage:
 *   const t = useTranslation('dashboard');
 *   <h1>{t('title')}</h1>
 *   <p>{t('welcome', { name: 'John' })}</p>
 */
export function useTranslation(namespace: string) {
  const i18n = getI18n();

  // Force re-render when language changes
  const [, setRenderTrigger] = useState(0);

  useEffect(() => {
    // Listen to language changes via storage events
    const handleStorageChange = () => {
      setRenderTrigger((prev) => prev + 1);
    };

    window.addEventListener('storage', handleStorageChange);
    return () => window.removeEventListener('storage', handleStorageChange);
  }, []);

  return useCallback(
    (key: string, variables?: Record<string, string | number>): string => {
      return i18n.translate(namespace, key, variables);
    },
    [namespace],
  );
}

/**
 * Hook for language switching and detection.
 *
 * Usage:
 *   const { language, setLanguage, availableLanguages } = useLanguage();
 */
export interface UseLanguageResult {
  readonly language: LanguageCode;
  readonly setLanguage: (lang: LanguageCode) => void;
  readonly availableLanguages: LanguageCode[];
}

export function useLanguage(): UseLanguageResult {
  const i18n = getI18n();
  const [language, setLanguageState] = useState<LanguageCode>(i18n.getLanguage());

  const setLanguage = useCallback((lang: LanguageCode) => {
    i18n.setLanguage(lang);
    setLanguageState(lang);
    // Trigger re-render of all components using translations
    window.dispatchEvent(new Event('storage'));
  }, []);

  return {
    language,
    setLanguage,
    availableLanguages: i18n.getAvailableLanguages(),
  };
}

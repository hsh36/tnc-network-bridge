import { useLanguage, useTranslation } from '../hooks/useTranslation';
import { type LanguageCode } from '../lib/i18n';

export interface LanguagePickerProps {
  readonly className?: string;
}

/**
 * Language picker dropdown component.
 * Allows users to switch between available languages (EN, DE).
 *
 * Usage:
 *   <LanguagePicker className="absolute top-4 right-4" />
 */
export function LanguagePicker({ className = '' }: LanguagePickerProps): JSX.Element {
  const { language, setLanguage, availableLanguages } = useLanguage();
  const t = useTranslation('common');

  const getLanguageLabel = (lang: LanguageCode): string => {
    return lang === 'en' ? t('english') : t('deutsch');
  };

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <label
        htmlFor="language-select"
        className="text-sm font-medium text-slate-700 dark:text-slate-300"
      >
        {t('language')}:
      </label>
      <select
        id="language-select"
        value={language}
        onChange={(e) => setLanguage(e.target.value as LanguageCode)}
        className="rounded border border-slate-300 bg-white px-2 py-1 text-sm text-slate-900 dark:border-slate-600 dark:bg-slate-800 dark:text-slate-100"
      >
        {availableLanguages.map((lang) => (
          <option key={lang} value={lang}>
            {getLanguageLabel(lang)}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Minimal language picker (just buttons, no label).
 * Useful for header/navbar integration.
 */
export function LanguagePickerButtons({ className = '' }: LanguagePickerProps): JSX.Element {
  const { language, setLanguage, availableLanguages } = useLanguage();

  return (
    <div className={`flex gap-1 ${className}`}>
      {availableLanguages.map((lang) => (
        <button
          key={lang}
          onClick={() => setLanguage(lang)}
          className={`rounded px-2 py-1 text-xs font-medium transition-colors ${
            language === lang
              ? 'bg-accent text-white'
              : 'bg-slate-200 text-slate-700 hover:bg-slate-300 dark:bg-slate-700 dark:text-slate-300 dark:hover:bg-slate-600'
          }`}
        >
          {lang.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

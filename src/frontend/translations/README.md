# Internationalization (i18n) System

This directory contains all translation files for the TNC Network Bridge UI.

## Supported Languages

- **English (en)** - Default language
- **Deutsch (de)** - German translation

## Adding a New Language

Follow these steps to add a new language (e.g., French):

### 1. Create a new translation file

Copy `en.json` to `fr.json` and translate all strings:

```bash
cp en.json fr.json
```

Then edit `fr.json` and translate all values while keeping the keys unchanged.

### 2. Update the i18n setup

Edit `src/frontend/lib/i18n-setup.ts` and add the new language:

```typescript
import en from '../translations/en.json';
import de from '../translations/de.json';
import fr from '../translations/fr.json';  // Add this

export function setupI18n(): void {
  const translations: Translations = {
    en: en as never,
    de: de as never,
    fr: fr as never,  // Add this
  };
  // ... rest of function
}

export const AVAILABLE_LANGUAGES = [
  { code: 'en' as const, name: 'English', nativeName: 'English' },
  { code: 'de' as const, name: 'Deutsch', nativeName: 'Deutsch' },
  { code: 'fr' as const, name: 'Français', nativeName: 'Français' },  // Add this
] as const;
```

### 3. Update i18n types (optional)

If you want type-safe language codes, update `src/frontend/lib/i18n.ts`:

```typescript
export type LanguageCode = 'en' | 'de' | 'fr';  // Add 'fr'
```

## Using Translations in Components

### Basic Usage

```typescript
import { useTranslation } from '../hooks/useTranslation';

export function MyComponent() {
  const t = useTranslation('dashboard');
  
  return (
    <div>
      <h1>{t('title')}</h1>
      <p>{t('subtitle')}</p>
    </div>
  );
}
```

### With Variable Substitution

```typescript
const t = useTranslation('auth');

return (
  <p>{t('welcome_message', { name: 'John', day: 'Monday' })}</p>
);
```

The translation string would be:
```json
{
  "welcome_message": "Hello {name}, welcome back on {day}!"
}
```

### Language Switching

```typescript
import { useLanguage } from '../hooks/useTranslation';
import { LanguagePicker } from '../components/LanguagePicker';

export function Header() {
  const { language } = useLanguage();
  
  return (
    <>
      <h1>Current language: {language}</h1>
      <LanguagePicker />
    </>
  );
}
```

## Initializing i18n in Your App

Call `setupI18n()` once in your app's root component:

```typescript
// App.tsx
import { useEffect } from 'react';
import { setupI18n } from './lib/i18n-setup';

export function App() {
  useEffect(() => {
    setupI18n();
  }, []);

  return <YourAppContent />;
}
```

## Translation File Structure

Each JSON file is organized by namespaces:

```json
{
  "common": {
    "app_name": "...",
    "yes": "...",
    "no": "..."
  },
  "dashboard": {
    "title": "...",
    "subtitle": "..."
  },
  "config": {
    "network": "...",
    "dhcp": "..."
  }
}
```

### Supported Namespaces

- **common**: Shared UI terms (buttons, labels, etc.)
- **navigation**: Menu items and navigation labels
- **dashboard**: Dashboard page content
- **config**: Configuration page content
- **locks**: File locks page content
- **versions**: File versions page content
- **machines**: TNC machines page content
- **monitoring**: Monitoring/metrics page content
- **logs**: Logs page content
- **auth**: Authentication/login content
- **errors**: Error messages
- **validation**: Form validation messages

## Storage and Persistence

Language preference is automatically saved to `localStorage` with key `tnc-bridge:language`. The selected language persists across browser sessions.

## Fallback Behavior

If a translation key is not found:
- The app returns `[namespace:key]` as a fallback
- This helps identify missing translations during development

## Best Practices

1. **Keep keys descriptive**: Use `password_too_short` not `pw_short`
2. **Avoid HTML in translations**: Use variable substitution instead
3. **Group related strings**: Use dot notation for nested namespaces
4. **Use consistent terminology**: Define a glossary for domain-specific terms
5. **Test all languages**: Ensure layout works with longer translations (German, French)

## Adding Nested Namespaces

For complex pages, you can use nested keys:

```json
{
  "config": {
    "network": {
      "lan_interface": "LAN Interface",
      "tnc_interface": "TNC Interface"
    }
  }
}
```

Access with dot notation:
```typescript
const t = useTranslation('config');
t('network.lan_interface');  // Returns "LAN Interface"
```

## Browser Language Auto-Detection

The system automatically detects the user's browser language and sets it as the initial language (if supported). This can be overridden in `i18n-setup.ts`:

```typescript
export function setupI18n(): void {
  // ... 
  initializeI18n(translations, 'de');  // Force German
}
```

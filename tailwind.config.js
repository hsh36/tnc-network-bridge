/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: ['./src/frontend/**/*.{ts,tsx,html}'],
  theme: {
    extend: {
      colors: {
        // A neutral, brand-agnostic palette (see the dataviz/artifact-design convention):
        // one accent plus semantic status colors, each with a light/dark pair driven by
        // the `class` strategy above (`Layout.tsx` toggles `.dark` on `<html>`).
        accent: {
          DEFAULT: '#2563eb',
          fg: '#ffffff',
        },
        surface: {
          DEFAULT: '#ffffff',
          subtle: '#f8fafc',
          dark: '#0f172a',
          'dark-subtle': '#1e293b',
        },
        border: {
          DEFAULT: '#e2e8f0',
          dark: '#334155',
        },
        status: {
          ok: '#16a34a',
          warn: '#d97706',
          error: '#dc2626',
          idle: '#64748b',
        },
      },
      fontFamily: {
        sans: [
          'Inter',
          'ui-sans-serif',
          'system-ui',
          '-apple-system',
          'Segoe UI',
          'Roboto',
          'Helvetica Neue',
          'Arial',
          'sans-serif',
        ],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
    },
  },
  plugins: [],
};

import type { Config } from 'tailwindcss';

export default {
  content: [
    './app/**/*.{ts,tsx}',
    './components/**/*.{ts,tsx}',
    // Include lib/ so Tailwind picks up utility classes embedded in runtime
    // config strings (e.g. SweetAlert's customClass in lib/dialog.ts).
    './lib/**/*.{ts,tsx}',
  ],
  theme: {
    extend: {
      colors: {
        ink: {
          DEFAULT: '#2b2a28',
          soft: '#5c5a55',
          mute: '#8b8883',
        },
        paper: {
          DEFAULT: '#fdfcf8',
          alt: '#f4f1ea',
        },
        accent: {
          DEFAULT: '#4f46e5',
          soft: '#e0defb',
        },
        live: {
          DEFAULT: '#dc2626',
          soft: '#fde1e1',
        },
        ok: {
          DEFAULT: '#15803d',
          soft: '#d6ead9',
        },
        warn: {
          DEFAULT: '#b45309',
          soft: '#f3e3c9',
        },
      },
      fontFamily: {
        sans: ['ui-sans-serif', 'system-ui', '-apple-system', 'Segoe UI', 'Roboto', 'Inter', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
    },
  },
  plugins: [],
} satisfies Config;

/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // "Strawberry & Cream": pale-yellow surfaces with plum ink and pink accents.
        base: {
          950: '#F3E3C3',
          900: '#FBF3DE',
          850: '#F6E8CB',
          800: '#FFFDF6',
          700: '#F3E4C4',
          600: '#E8D3AF',
          500: '#D9BE94',
        },
        ink: {
          DEFAULT: '#41283B',
          muted: '#7C5568',
          faint: '#8A6376',
        },
        added: '#047857',
        removed: '#BE123C',
        churn: {
          DEFAULT: '#C2255C',
          deep: '#A61E4D',
        },
        growth: '#B45309',
        violet: '#A21CAF',
      },
      fontFamily: {
        sans: ['"Inter Variable"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      boxShadow: {
        panel: '0 1px 2px rgba(150, 90, 60, 0.07), 0 2px 8px rgba(194, 37, 92, 0.06)',
      },
    },
  },
  plugins: [],
}

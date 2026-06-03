/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        status: {
          liberado:         '#6B7280',
          em_separacao:     '#3B82F6',
          separado:         '#93C5FD',
          em_conferencia:   '#F59E0B',
          divergencia:      '#EF4444',
          aguard_tratativa: '#DC2626',
          conferido:        '#86EFAC',
          aguard_faturamento: '#8B5CF6',
          faturado:         '#6366F1',
          aguard_coleta:    '#14B8A6',
          coletado:         '#22C55E',
          expedido:         '#15803D',
          bloqueado:        '#7F1D1D',
          cancelado:        '#374151',
        },
      },
    },
  },
  plugins: [],
}

import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Quando este bundle foi gerado. Existe por um motivo concreto: mais de uma vez
// perdemos rodadas inteiras discutindo um bug que já estava corrigido — o
// navegador servia um build antigo e não havia como saber olhando a tela. Agora
// há: o rodapé do menu mostra esta data.
const BUILD = new Date().toISOString()

export default defineConfig({
  define: {
    __BUILD__: JSON.stringify(BUILD),
  },
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://localhost:8000',
    },
  },
})

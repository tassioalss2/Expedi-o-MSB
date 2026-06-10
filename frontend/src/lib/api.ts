import axios from 'axios'

const BASE = import.meta.env.VITE_API_URL || '/api/v1'

const api = axios.create({ baseURL: BASE })

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('ace_token') || 'dev-token'
  config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (r) => r,
  (err) => {
    // Não redireciona para login em erros de API (modo dev sem autenticação)
    return Promise.reject(err)
  }
)

export default api

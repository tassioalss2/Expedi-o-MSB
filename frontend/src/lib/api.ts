import axios from 'axios'

const BASE = import.meta.env.VITE_API_URL || '/api/v1'

const api = axios.create({ baseURL: BASE })

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('ace_token')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

api.interceptors.response.use(
  (r) => r,
  (err) => {
    // Sessão expirada / token inválido → limpa e volta para o login.
    if (err?.response?.status === 401) {
      localStorage.removeItem('ace_token')
      localStorage.removeItem('ace_usuario')
      if (!window.location.pathname.startsWith('/login')) {
        window.location.href = '/login'
      }
    }
    return Promise.reject(err)
  }
)

export default api

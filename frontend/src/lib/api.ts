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
    // O 422 do FastAPI responde `detail` como LISTA de objetos. Quase toda tela
    // faz `toast.error(e.response.data.detail || '...')`, e passar um objeto
    // para o toast o manda como filho de JSX — o React lanca em render e a
    // pagina inteira fica BRANCA. Foi o que aconteceu ao clicar em "marcar como
    // enviado": um 422 derrubou a Expedicao inteira.
    //
    // Converte so LISTA. `detail` objeto fica intacto de proposito: varios 409
    // nossos mandam {tipo, analise, ...} e as telas de estoque leem esses
    // campos — transformar em texto quebraria o fluxo de falta de material.
    // A lista crua continua em `detail_bruto`.
    const d = err?.response?.data?.detail
    if (Array.isArray(d)) {
      err.response.data.detail_bruto = d
      const partes = d.map((x: any) => {
        const campo = (x?.loc || []).filter((l: any) => l !== 'body').pop()
        const msg = x?.msg || 'valor invalido'
        return campo ? `${campo}: ${msg}` : msg
      }).filter(Boolean)
      err.response.data.detail = partes.length ? partes.join(' · ') : 'Dados invalidos.'
    }

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

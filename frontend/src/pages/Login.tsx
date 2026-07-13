import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff, LogIn } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import api from '../lib/api'
import toast from 'react-hot-toast'

export function Login() {
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [verSenha, setVerSenha] = useState(false)
  const [loading, setLoading] = useState(false)
  const { setAuth, isAuthenticated } = useAuthStore()
  const navigate = useNavigate()

  // Se já está logado, não mostra a tela de login.
  useEffect(() => {
    if (isAuthenticated()) navigate('/', { replace: true })
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setLoading(true)
    try {
      const { data } = await api.post('/auth/login', { email: email.trim(), senha })
      setAuth(data.usuario, data.access_token)
      toast.success(`Bem-vindo, ${data.usuario?.nome?.split(' ')[0] || ''}`.trim())
      navigate('/', { replace: true })
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || 'Email ou senha inválidos')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen bg-gray-900 flex items-center justify-center p-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="text-center mb-8">
          <img
            src="/msb-logo.png"
            alt="MSB — Medical System do Brasil"
            className="h-12 w-auto object-contain mx-auto mb-4 brightness-0 invert"
          />
          <h1 className="text-white text-2xl font-bold">ACE-MSB</h1>
          <p className="text-gray-400 text-sm mt-1">Gestão Comercial &amp; Logística</p>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="bg-gray-800 rounded-2xl p-6 space-y-4 shadow-xl">
          <div>
            <label className="block text-sm text-gray-300 mb-1.5">Email</label>
            <input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoFocus
              autoComplete="username"
              className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="seu@email.com"
            />
          </div>
          <div>
            <label className="block text-sm text-gray-300 mb-1.5">Senha</label>
            <div className="relative">
              <input
                type={verSenha ? 'text' : 'password'}
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                required
                autoComplete="current-password"
                className="w-full bg-gray-700 text-white rounded-lg px-4 py-3 pr-11 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="••••••••"
              />
              <button
                type="button"
                onClick={() => setVerSenha((v) => !v)}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-200"
                tabIndex={-1}
                aria-label={verSenha ? 'Ocultar senha' : 'Mostrar senha'}
              >
                {verSenha ? <EyeOff size={18} /> : <Eye size={18} />}
              </button>
            </div>
          </div>
          <button
            type="submit"
            disabled={loading}
            className="w-full bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-semibold py-3 rounded-lg transition-colors mt-2 flex items-center justify-center gap-2"
          >
            {loading ? 'Entrando...' : (<><LogIn size={18} /> Entrar</>)}
          </button>
        </form>

        <p className="text-center text-gray-500 text-xs mt-6">
          MSB Biomedical — Gestão Comercial &amp; Logística
        </p>
      </div>
    </div>
  )
}

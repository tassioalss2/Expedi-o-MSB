/**
 * Primeiro acesso: a pessoa define a própria senha.
 *
 * A provisória é a mesma para todo o grupo que entra junto, então ela circula
 * por WhatsApp e e-mail até todo mundo entrar. Aqui ela vale uma vez: enquanto
 * a senha não for trocada, nenhuma tela do app abre.
 */
import { useState } from 'react'
import { KeyRound } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'
import { useAuthStore } from '../store/authStore'

export default function TrocarSenha() {
  const usuario = useAuthStore((s) => s.usuario)
  const senhaTrocada = useAuthStore((s) => s.senhaTrocada)
  const [nova, setNova] = useState('')
  const [repetida, setRepetida] = useState('')
  const [salvando, setSalvando] = useState(false)

  const curta = nova.length > 0 && nova.length < 6
  const diferentes = repetida.length > 0 && nova !== repetida
  const podeSalvar = nova.length >= 6 && nova === repetida && !salvando

  async function salvar(e: React.FormEvent) {
    e.preventDefault()
    if (!podeSalvar) return
    setSalvando(true)
    try {
      await api.post('/auth/minha-senha', { nova_senha: nova })
      senhaTrocada()
      toast.success('Senha definida — bom trabalho!')
    } catch (err: any) {
      toast.error(err?.response?.data?.detail || 'Não consegui trocar a senha')
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-900 px-4">
      <form onSubmit={salvar} className="w-full max-w-sm bg-white rounded-2xl p-6 shadow-xl">
        <div className="flex items-center gap-2 text-gray-900">
          <KeyRound size={18} className="text-blue-600" />
          <h1 className="text-lg font-bold">Crie a sua senha</h1>
        </div>
        <p className="text-sm text-gray-500 mt-1">
          Olá, {usuario?.nome?.split(' ')[0]}. A senha que você recebeu é provisória e vale
          só para esta primeira entrada.
        </p>

        <label className="block mt-4 text-sm font-medium text-gray-700">
          Nova senha
          <input
            type="password" value={nova} onChange={(e) => setNova(e.target.value)}
            autoFocus placeholder="mínimo 6 caracteres"
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm"
          />
        </label>
        {curta && <p className="text-xs text-amber-700 mt-1">Use ao menos 6 caracteres.</p>}

        <label className="block mt-3 text-sm font-medium text-gray-700">
          Repita a nova senha
          <input
            type="password" value={repetida} onChange={(e) => setRepetida(e.target.value)}
            className="mt-1 w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm"
          />
        </label>
        {diferentes && <p className="text-xs text-amber-700 mt-1">As duas não estão iguais.</p>}

        <button type="submit" disabled={!podeSalvar}
          className="mt-5 w-full bg-blue-600 text-white rounded-lg py-2.5 text-sm font-medium
                     hover:bg-blue-500 disabled:opacity-50">
          {salvando ? 'Salvando…' : 'Salvar e entrar'}
        </button>
      </form>
    </div>
  )
}

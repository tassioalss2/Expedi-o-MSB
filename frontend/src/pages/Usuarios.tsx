import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { UserPlus, KeyRound, X, ShieldCheck, ShieldOff, Pencil } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'
import { PERFIL_LABELS } from '../types'
import type { Usuario, PerfilUsuario } from '../types'
import { useAuthStore } from '../store/authStore'

const PERFIS: PerfilUsuario[] = ['LOGISTICA', 'OPERACOES_VENDAS', 'COMERCIAL', 'DIRETORIA', 'ADMIN', 'CONSELHO']

const PERFIL_COR: Record<PerfilUsuario, string> = {
  LOGISTICA: 'bg-blue-100 text-blue-700',
  OPERACOES_VENDAS: 'bg-amber-100 text-amber-700',
  COMERCIAL: 'bg-emerald-100 text-emerald-700',
  DIRETORIA: 'bg-purple-100 text-purple-700',
  ADMIN: 'bg-gray-800 text-white',
  // Cinza claro de proposito: e um acesso de leitura, nao um cargo operacional.
  CONSELHO: 'bg-slate-100 text-slate-700',
}

// Extrai SEMPRE uma string do erro — nunca passar array/objeto ao toast
// (o detail de validação 422 do FastAPI é uma lista de objetos e quebraria o render).
function msgErro(e: any, fallback: string): string {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d)) return d[0]?.msg || fallback
  if (d && typeof d === 'object') return d.msg || d.message || fallback
  return fallback
}

export function Usuarios() {
  const qc = useQueryClient()
  const { usuario: eu } = useAuthStore()
  const [modalNovo, setModalNovo] = useState(false)
  const [editando, setEditando] = useState<Usuario | null>(null)
  const [senhaDe, setSenhaDe] = useState<Usuario | null>(null)

  const { data: usuarios, isLoading } = useQuery<Usuario[]>({
    queryKey: ['usuarios'],
    queryFn: () => api.get('/auth/usuarios').then(r => r.data),
  })

  const invalidar = () => qc.invalidateQueries({ queryKey: ['usuarios'] })

  const toggleAtivo = useMutation({
    mutationFn: (u: Usuario) => api.patch(`/auth/usuarios/${u.id}`, { ativo: !u.ativo }),
    onSuccess: () => { invalidar(); toast.success('Status atualizado') },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao atualizar')),
  })

  return (
    <div className="p-4 lg:p-6 max-w-4xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-800">Gestão de Usuários</h1>
          <p className="text-sm text-gray-400">Acesso restrito ao Admin · {usuarios?.length ?? 0} usuário(s)</p>
        </div>
        <button
          onClick={() => setModalNovo(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg"
        >
          <UserPlus size={16} /> Novo usuário
        </button>
      </div>

      <div className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
        {isLoading ? (
          <p className="text-center text-gray-400 py-10 text-sm">Carregando...</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50">
              <tr>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500">Nome</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500">Email</th>
                <th className="text-left px-4 py-3 text-xs font-semibold text-gray-500">Perfil</th>
                <th className="text-center px-4 py-3 text-xs font-semibold text-gray-500">Status</th>
                <th className="text-right px-4 py-3 text-xs font-semibold text-gray-500">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {usuarios?.map((u) => {
                const souEu = eu?.id === u.id
                return (
                  <tr key={u.id} className={u.ativo ? '' : 'bg-gray-50 text-gray-400'}>
                    <td className="px-4 py-3 font-medium text-gray-800">
                      {u.nome}{souEu && <span className="ml-1.5 text-[11px] text-gray-400">(você)</span>}
                    </td>
                    <td className="px-4 py-3 text-gray-500">{u.email}</td>
                    <td className="px-4 py-3">
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${PERFIL_COR[u.perfil as PerfilUsuario]}`}>
                        {PERFIL_LABELS[u.perfil as PerfilUsuario] || u.perfil}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-center">
                      <span className={`text-xs font-medium ${u.ativo ? 'text-emerald-600' : 'text-gray-400'}`}>
                        {u.ativo ? 'Ativo' : 'Inativo'}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <button onClick={() => setEditando(u)} title="Editar"
                          className="p-1.5 text-gray-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg">
                          <Pencil size={15} />
                        </button>
                        <button onClick={() => setSenhaDe(u)} title="Redefinir senha"
                          className="p-1.5 text-gray-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg">
                          <KeyRound size={15} />
                        </button>
                        <button
                          onClick={() => !souEu && toggleAtivo.mutate(u)}
                          disabled={souEu}
                          title={souEu ? 'Não é possível desativar a si mesmo' : (u.ativo ? 'Desativar' : 'Ativar')}
                          className="p-1.5 text-gray-400 hover:bg-gray-100 rounded-lg disabled:opacity-30 disabled:cursor-not-allowed enabled:hover:text-red-600">
                          {u.ativo ? <ShieldOff size={15} /> : <ShieldCheck size={15} />}
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>

      {modalNovo && <ModalNovo onClose={() => setModalNovo(false)} onSaved={invalidar} />}
      {editando && <ModalEditar usuario={editando} souEu={eu?.id === editando.id} onClose={() => setEditando(null)} onSaved={invalidar} />}
      {senhaDe && <ModalSenha usuario={senhaDe} onClose={() => setSenhaDe(null)} />}
    </div>
  )
}

function CampoPerfil({ value, onChange }: { value: PerfilUsuario; onChange: (p: PerfilUsuario) => void }) {
  return (
    <select value={value} onChange={(e) => onChange(e.target.value as PerfilUsuario)}
      className="w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500">
      {PERFIS.map((p) => <option key={p} value={p}>{PERFIL_LABELS[p]}</option>)}
    </select>
  )
}

function ModalBase({ titulo, onClose, children }: { titulo: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="p-5 border-b flex items-center justify-between">
          <h2 className="text-lg font-bold">{titulo}</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

function ModalNovo({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [nome, setNome] = useState('')
  const [email, setEmail] = useState('')
  const [senha, setSenha] = useState('')
  const [perfil, setPerfil] = useState<PerfilUsuario>('LOGISTICA')

  const criar = useMutation({
    mutationFn: () => api.post('/auth/usuarios', { nome: nome.trim(), email: email.trim(), senha, perfil }),
    onSuccess: () => { toast.success('Usuário criado'); onSaved(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao criar')),
  })

  const valido = nome.trim() && email.trim() && senha.length >= 6

  return (
    <ModalBase titulo="Novo usuário" onClose={onClose}>
      <div className="p-5 space-y-3">
        <Campo label="Nome"><input value={nome} onChange={(e) => setNome(e.target.value)} className={inputCls} /></Campo>
        <Campo label="Email"><input type="email" value={email} onChange={(e) => setEmail(e.target.value)} className={inputCls} /></Campo>
        <Campo label="Senha (mín. 6)"><input type="text" value={senha} onChange={(e) => setSenha(e.target.value)} className={inputCls} placeholder="senha temporária" /></Campo>
        <Campo label="Perfil"><CampoPerfil value={perfil} onChange={setPerfil} /></Campo>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
        <button onClick={() => criar.mutate()} disabled={!valido || criar.isPending}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {criar.isPending ? 'Criando...' : 'Criar'}
        </button>
      </div>
    </ModalBase>
  )
}

function ModalEditar({ usuario, souEu, onClose, onSaved }: { usuario: Usuario; souEu: boolean; onClose: () => void; onSaved: () => void }) {
  const [nome, setNome] = useState(usuario.nome)
  const [perfil, setPerfil] = useState<PerfilUsuario>(usuario.perfil as PerfilUsuario)

  const salvar = useMutation({
    mutationFn: () => api.patch(`/auth/usuarios/${usuario.id}`, { nome: nome.trim(), perfil }),
    onSuccess: () => { toast.success('Usuário atualizado'); onSaved(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao salvar')),
  })

  return (
    <ModalBase titulo="Editar usuário" onClose={onClose}>
      <div className="p-5 space-y-3">
        <Campo label="Nome"><input value={nome} onChange={(e) => setNome(e.target.value)} className={inputCls} /></Campo>
        <Campo label="Email"><input value={usuario.email} disabled className={`${inputCls} bg-gray-50 text-gray-400`} /></Campo>
        <Campo label="Perfil"><CampoPerfil value={perfil} onChange={setPerfil} /></Campo>
        {souEu && perfil !== 'ADMIN' && (
          <p className="text-xs text-amber-600">Você não pode remover o próprio acesso de Admin.</p>
        )}
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
        <button onClick={() => salvar.mutate()} disabled={!nome.trim() || salvar.isPending}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {salvar.isPending ? 'Salvando...' : 'Salvar'}
        </button>
      </div>
    </ModalBase>
  )
}

function ModalSenha({ usuario, onClose }: { usuario: Usuario; onClose: () => void }) {
  const [senha, setSenha] = useState('')
  const reset = useMutation({
    mutationFn: () => api.post(`/auth/usuarios/${usuario.id}/senha`, { nova_senha: senha }),
    onSuccess: () => { toast.success('Senha redefinida'); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao redefinir')),
  })

  return (
    <ModalBase titulo={`Redefinir senha · ${usuario.nome}`} onClose={onClose}>
      <div className="p-5 space-y-3">
        <Campo label="Nova senha (mín. 6)">
          <input type="text" value={senha} onChange={(e) => setSenha(e.target.value)} className={inputCls} autoFocus />
        </Campo>
        <p className="text-xs text-gray-400">Informe a nova senha ao usuário — ela vale como temporária.</p>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
        <button onClick={() => reset.mutate()} disabled={senha.length < 6 || reset.isPending}
          className="px-4 py-2 text-sm bg-amber-600 hover:bg-amber-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {reset.isPending ? 'Salvando...' : 'Redefinir'}
        </button>
      </div>
    </ModalBase>
  )
}

const inputCls = 'w-full border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 mb-1">{label}</label>
      {children}
    </div>
  )
}

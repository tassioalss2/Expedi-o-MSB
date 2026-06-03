import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Trash2 } from 'lucide-react'
import api from '../lib/api'
import type { Cliente, Transportadora, Produto } from '../types'
import toast from 'react-hot-toast'

type Tab = 'clientes' | 'transportadoras' | 'produtos' | 'motivos'

export function Cadastros() {
  const [tab, setTab] = useState<Tab>('clientes')
  const [modal, setModal] = useState(false)
  const [form, setForm] = useState<Record<string, string>>({})
  const qc = useQueryClient()

  const { data: clientes = [] } = useQuery<Cliente[]>({
    queryKey: ['clientes'], queryFn: () => api.get('/clientes').then((r) => r.data), enabled: tab === 'clientes',
  })
  const { data: transportadoras = [] } = useQuery<Transportadora[]>({
    queryKey: ['transportadoras'], queryFn: () => api.get('/transportadoras').then((r) => r.data), enabled: tab === 'transportadoras',
  })
  const { data: motivos = [] } = useQuery({
    queryKey: ['motivos'], queryFn: () => api.get('/motivos-ocorrencia').then((r) => r.data), enabled: tab === 'motivos',
  })

  const deletarMotivo = useMutation({
    mutationFn: (id: string) => api.delete(`/motivos-ocorrencia/${id}`),
    onSuccess: () => { toast.success('Motivo removido'); qc.invalidateQueries({ queryKey: ['motivos'] }) },
    onError: () => toast.error('Erro ao remover'),
  })
  const { data: produtos = [] } = useQuery<Produto[]>({
    queryKey: ['produtos'], queryFn: () => api.get('/produtos').then((r) => r.data), enabled: tab === 'produtos',
  })

  const CAMPOS: Record<Exclude<Tab, 'motivos'>, { key: string; label: string; required?: boolean; type?: string }[]> = {
    clientes: [
      { key: 'codigo', label: 'Código', required: true },
      { key: 'nome', label: 'Nome', required: true },
      { key: 'cnpj', label: 'CNPJ' },
      { key: 'contato', label: 'Contato' },
    ],
    transportadoras: [
      { key: 'nome', label: 'Nome', required: true },
      { key: 'cnpj', label: 'CNPJ' },
      { key: 'contato', label: 'Contato' },
      { key: 'sla_horas', label: 'SLA (horas)', type: 'number' },
    ],
    produtos: [
      { key: 'codigo', label: 'Código', required: true },
      { key: 'descricao', label: 'Descrição', required: true },
      { key: 'familia', label: 'Família' },
      { key: 'unidade', label: 'Unidade' },
    ],
  }

  const saveMutation = useMutation({
    mutationFn: () => tab === 'motivos'
      ? api.post('/motivos-ocorrencia', { tipo: form.tipo || 'TRANSPORTADORA', descricao: form.descricao })
      : api.post(`/${tab}`, form),
    onSuccess: () => {
      toast.success('Cadastro salvo!')
      qc.invalidateQueries({ queryKey: [tab] })
      setModal(false)
      setForm({})
    },
    onError: () => toast.error('Erro ao salvar'),
  })

  const abrirModal = () => {
    setForm({})
    setModal(true)
  }

  const TABS = [
    { key: 'clientes', label: 'Clientes' },
    { key: 'transportadoras', label: 'Transportadoras' },
    { key: 'produtos', label: 'Produtos' },
    { key: 'motivos', label: '📋 Motivos de Correção' },
  ] as const

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Cadastros</h1>
        <button onClick={abrirModal} className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500">
          + Novo
        </button>
      </div>

      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg w-fit">
        {TABS.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={`px-4 py-2 rounded-md text-sm font-medium transition-colors ${
              tab === t.key ? 'bg-white shadow text-gray-900' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {tab === 'motivos' ? (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-4 py-3 bg-gray-50 border-b text-xs text-gray-500">
            Motivos padronizados usados na correção de transportadora. Operadores escolhem da lista — sem risco de erros de digitação.
          </div>
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100">
              <tr>
                <th className="text-left px-4 py-3 text-gray-600 font-semibold">Descrição do Motivo</th>
                <th className="text-left px-4 py-3 text-gray-600 font-semibold">Tipo</th>
                <th className="px-4 py-3 w-12"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {(motivos as any[]).map((m: any) => (
                <tr key={m.id} className="hover:bg-gray-50">
                  <td className="px-4 py-3 text-gray-700">{m.descricao}</td>
                  <td className="px-4 py-3">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    m.tipo === 'COMERCIAL'      ? 'bg-blue-100 text-blue-700' :
                    m.tipo === 'LOGISTICA'      ? 'bg-green-100 text-green-700' :
                    m.tipo === 'CLIENTE'        ? 'bg-purple-100 text-purple-700' :
                    m.tipo === 'TRANSPORTADORA' ? 'bg-orange-100 text-orange-700' :
                    'bg-gray-100 text-gray-600'
                  }`}>{m.tipo}</span>
                  </td>
                  <td className="px-4 py-3 text-center">
                    <button onClick={() => {
                      if (confirm('Remover este motivo?')) deletarMotivo.mutate(m.id)
                    }} className="text-gray-300 hover:text-red-500">
                      <Trash2 size={15} />
                    </button>
                  </td>
                </tr>
              ))}
              {(motivos as any[]).length === 0 && (
                <tr><td colSpan={3} className="px-4 py-8 text-center text-gray-400">Nenhum motivo cadastrado</td></tr>
              )}
            </tbody>
          </table>
        </div>
      ) : (
      <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-gray-50 border-b border-gray-100">
            <tr>
              {CAMPOS[tab as Exclude<Tab, 'motivos'>].map((c) => (
                <th key={c.key} className="text-left px-4 py-3 text-gray-600 font-semibold capitalize">
                  {c.label}
                </th>
              ))}
              <th className="px-4 py-3 text-gray-600 font-semibold">Ativo</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-50">
            {(tab === 'clientes' ? clientes : tab === 'transportadoras' ? transportadoras : produtos).map((item: any) => (
              <tr key={item.id} className="hover:bg-gray-50">
                {CAMPOS[tab as Exclude<Tab, 'motivos'>].map((c) => (
                  <td key={c.key} className="px-4 py-3 text-gray-700">{item[c.key] ?? '—'}</td>
                ))}
                <td className="px-4 py-3">
                  <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${item.ativo ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-500'}`}>
                    {item.ativo ? 'Ativo' : 'Inativo'}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      )}

      {modal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md">
            <div className="p-5 border-b">
              <h2 className="text-lg font-bold">Novo cadastro — {TABS.find((t) => t.key === tab)?.label}</h2>
            </div>
            <div className="p-5 space-y-4">
              {tab === 'motivos' ? (
                <>
                  <div>
                    <label className="text-sm text-gray-600">Tipo *</label>
                    <select value={form.tipo || 'TRANSPORTADORA'} onChange={e => setForm({...form, tipo: e.target.value})}
                      className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1">
                      <option value="TRANSPORTADORA">Correção de Transportadora</option>
                      <option value="COMERCIAL">Comercial</option>
                      <option value="LOGISTICA">Logística</option>
                      <option value="CLIENTE">Cliente</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-sm text-gray-600">Descrição do motivo *</label>
                    <input type="text" value={form.descricao || ''} onChange={e => setForm({...form, descricao: e.target.value})}
                      className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1"
                      placeholder="Ex: Transportadora indisponível na data acordada" />
                  </div>
                </>
              ) : CAMPOS[tab as Exclude<Tab, 'motivos'>].map((c) => (
                <div key={c.key}>
                  <label className="text-sm text-gray-600">{c.label}{c.required ? ' *' : ''}</label>
                  <input
                    type={c.type || 'text'}
                    value={form[c.key] || ''}
                    onChange={(e) => setForm({ ...form, [c.key]: e.target.value })}
                    className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1"
                  />
                </div>
              ))}
            </div>
            <div className="p-5 border-t flex gap-2 justify-end">
              <button onClick={() => setModal(false)} className="px-4 py-2 border rounded-lg text-sm">Cancelar</button>
              <button
                onClick={() => saveMutation.mutate()}
                disabled={saveMutation.isPending}
                className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {saveMutation.isPending ? 'Salvando...' : 'Salvar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

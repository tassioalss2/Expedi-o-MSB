import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Search, Mail, Phone, Pencil, Trash2, User } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import { ClienteAutocomplete } from '../NovoPedido'
import { CANAL_LABEL } from '../../lib/statusConfig'
import { msgErro } from '../../lib/crm'
import { ModalBase, Campo, inputCls } from './CrmShared'

const CANAIS = ['URO', 'VASCULAR', 'REALCLOSURE', 'LICITACAO_URO', 'LICITACAO_VASCULAR']

export function CrmContatos() {
  const qc = useQueryClient()
  const [busca, setBusca] = useState('')
  const [modal, setModal] = useState<any | 'novo' | null>(null)

  const { data: contatos = [], isLoading } = useQuery<any[]>({
    queryKey: ['crm-contatos-todos'],
    queryFn: () => api.get('/crm/contatos').then(r => r.data),
  })

  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ['crm-contatos-todos'] })
    qc.invalidateQueries({ queryKey: ['crm-contatos'] })
  }

  const filtrados = useMemo(() => {
    const b = busca.trim().toLowerCase()
    if (!b) return contatos
    return contatos.filter(c => `${c.nome} ${c.cliente || ''} ${c.email || ''} ${c.cargo || ''}`.toLowerCase().includes(b))
  }, [contatos, busca])

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar contato, cliente, e-mail…"
            className="w-full border rounded-lg pl-9 pr-3 py-2 text-sm" />
        </div>
        <span className="text-xs text-gray-400 flex-1 hidden md:block">{filtrados.length} contato(s)</span>
        <button onClick={() => setModal('novo')}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg">
          <Plus size={16} /> Novo contato
        </button>
      </div>

      {isLoading ? (
        <p className="text-center text-gray-400 py-10 text-sm">Carregando…</p>
      ) : filtrados.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-10 text-center text-gray-400 text-sm">
          Nenhum contato ainda. Clique em <strong>Novo contato</strong>.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {filtrados.map(c => (
            <div key={c.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 group">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="w-9 h-9 rounded-full bg-blue-100 text-blue-700 flex items-center justify-center font-bold text-sm flex-shrink-0">
                    {(c.nome || '?').charAt(0).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-gray-800 truncate">{c.nome}</p>
                    {c.cargo && <p className="text-xs text-gray-500 truncate">{c.cargo}</p>}
                  </div>
                </div>
                <button onClick={() => setModal(c)} className="text-gray-300 hover:text-blue-600 opacity-0 group-hover:opacity-100 transition"><Pencil size={15} /></button>
              </div>
              {c.cliente && <p className="text-xs text-gray-600 mt-2 flex items-center gap-1"><User size={12} className="text-gray-400" /> {c.cliente}</p>}
              {c.email && <p className="text-xs text-gray-500 mt-1 flex items-center gap-1 truncate"><Mail size={12} className="text-gray-400" /> {c.email}</p>}
              {c.telefone && <p className="text-xs text-gray-500 mt-1 flex items-center gap-1"><Phone size={12} className="text-gray-400" /> {c.telefone}</p>}
              {c.canal && <span className="inline-block mt-2 text-[11px] bg-gray-100 text-gray-500 rounded-full px-2 py-0.5">{CANAL_LABEL[c.canal] || c.canal}</span>}
            </div>
          ))}
        </div>
      )}

      {modal && <ModalContato contato={modal === 'novo' ? undefined : modal} onClose={() => setModal(null)} onSaved={invalidar} />}
    </div>
  )
}

function ModalContato({ contato, onClose, onSaved }: { contato?: any; onClose: () => void; onSaved: () => void }) {
  const qc = useQueryClient()
  const edicao = !!contato
  const [nome, setNome] = useState(contato?.nome || '')
  const [cargo, setCargo] = useState(contato?.cargo || '')
  const [email, setEmail] = useState(contato?.email || '')
  const [telefone, setTelefone] = useState(contato?.telefone || '')
  const [clienteId, setClienteId] = useState(contato?.cliente_id || '')
  const [clienteNome, setClienteNome] = useState(contato?.cliente || '')
  const [canal, setCanal] = useState(contato?.canal || '')
  const [observacao, setObservacao] = useState(contato?.observacao || '')

  const salvar = useMutation({
    mutationFn: () => {
      const body = {
        nome: nome.trim(), cargo: cargo || null, email: email || null, telefone: telefone || null,
        cliente_id: clienteId || null, canal: canal || null, observacao: observacao || null,
      }
      return edicao ? api.patch(`/crm/contatos/${contato.id}`, body) : api.post('/crm/contatos', body)
    },
    onSuccess: () => { toast.success(edicao ? 'Contato atualizado' : 'Contato criado'); onSaved(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao salvar'), { duration: 5000 }),
  })

  const excluir = useMutation({
    mutationFn: () => api.delete(`/crm/contatos/${contato.id}`),
    onSuccess: () => { toast.success('Contato removido'); qc.invalidateQueries({ queryKey: ['crm-contatos-todos'] }); onSaved(); onClose() },
  })

  return (
    <ModalBase titulo={edicao ? 'Editar contato' : 'Novo contato'} onClose={onClose} max="max-w-lg">
      <div className="p-5 space-y-3 overflow-y-auto">
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Nome *"><input value={nome} onChange={e => setNome(e.target.value)} className={inputCls} autoFocus /></Campo>
          <Campo label="Cargo"><input value={cargo} onChange={e => setCargo(e.target.value)} className={inputCls} placeholder="Ex: Comprador" /></Campo>
          <Campo label="E-mail"><input type="email" value={email} onChange={e => setEmail(e.target.value)} className={inputCls} /></Campo>
          <Campo label="Telefone"><input value={telefone} onChange={e => setTelefone(e.target.value)} className={inputCls} /></Campo>
        </div>
        <Campo label="Cliente / Órgão">
          <ClienteAutocomplete value={clienteId} onChange={(id, nome) => { setClienteId(id); setClienteNome(nome) }} />
          {clienteId && <p className="text-xs text-green-600 mt-1">✅ {clienteNome}</p>}
        </Campo>
        <Campo label="Canal">
          <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
            <option value="">—</option>
            {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
          </select>
        </Campo>
        <Campo label="Observação"><textarea rows={2} value={observacao} onChange={e => setObservacao(e.target.value)} className={inputCls} /></Campo>
      </div>
      <div className="p-4 border-t flex items-center justify-between">
        {edicao ? (
          <button onClick={() => { if (confirm('Remover contato?')) excluir.mutate() }} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-red-600"><Trash2 size={15} /> Remover</button>
        ) : <span />}
        <div className="flex gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
          <button onClick={() => salvar.mutate()} disabled={!nome.trim() || salvar.isPending}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
            {salvar.isPending ? 'Salvando…' : 'Salvar'}
          </button>
        </div>
      </div>
    </ModalBase>
  )
}

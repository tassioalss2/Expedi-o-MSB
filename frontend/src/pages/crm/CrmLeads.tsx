import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, Trash2, Pencil, ArrowRightCircle, Star } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import { ClienteAutocomplete } from '../NovoPedido'
import { CANAL_LABEL } from '../../lib/statusConfig'
import { ORIGENS, fmtBRL, msgErro } from '../../lib/crm'
import { ModalBase, Campo, inputCls } from './CrmShared'

const CANAIS = ['URO', 'VASCULAR', 'REALCLOSURE', 'LICITACAO_URO', 'LICITACAO_VASCULAR']

const STATUS: { key: string; label: string; cor: string }[] = [
  { key: 'NOVO', label: 'Novo', cor: 'bg-blue-100 text-blue-700' },
  { key: 'CONTATADO', label: 'Contatado', cor: 'bg-violet-100 text-violet-700' },
  { key: 'QUALIFICADO', label: 'Qualificado', cor: 'bg-amber-100 text-amber-700' },
  { key: 'CONVERTIDO', label: 'Convertido', cor: 'bg-emerald-100 text-emerald-700' },
  { key: 'DESCARTADO', label: 'Descartado', cor: 'bg-gray-100 text-gray-500' },
]
const STATUS_MAP = Object.fromEntries(STATUS.map(s => [s.key, s]))

const TEMP: Record<string, { label: string; cor: string; icone: string }> = {
  QUENTE: { label: 'Quente', cor: 'text-red-600 bg-red-50', icone: '🔥' },
  MORNO: { label: 'Morno', cor: 'text-amber-600 bg-amber-50', icone: '🌡️' },
  FRIO: { label: 'Frio', cor: 'text-sky-600 bg-sky-50', icone: '❄️' },
}

export function CrmLeads() {
  const qc = useQueryClient()
  const [filtro, setFiltro] = useState('')
  const [modal, setModal] = useState<any | 'novo' | null>(null)

  const { data: leads = [], isLoading } = useQuery<any[]>({
    queryKey: ['crm-leads', filtro],
    queryFn: () => api.get('/crm/leads', { params: filtro ? { status: filtro } : {} }).then(r => r.data),
  })

  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ['crm-leads'] })
    qc.invalidateQueries({ queryKey: ['crm-opps'] })
  }

  const converter = useMutation({
    mutationFn: (id: string) => api.post(`/crm/leads/${id}/converter`),
    onSuccess: () => { toast.success('Lead convertido em oportunidade! 🎯'); invalidar() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao converter'), { duration: 5000 }),
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 flex-1 flex-wrap">
          <button onClick={() => setFiltro('')} className={`text-sm px-3 py-1.5 rounded-lg ${!filtro ? 'bg-blue-600 text-white' : 'bg-white border text-gray-600'}`}>Todos</button>
          {STATUS.map(s => (
            <button key={s.key} onClick={() => setFiltro(s.key)} className={`text-sm px-3 py-1.5 rounded-lg ${filtro === s.key ? 'bg-blue-600 text-white' : 'bg-white border text-gray-600'}`}>{s.label}</button>
          ))}
        </div>
        <button onClick={() => setModal('novo')} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg">
          <Plus size={16} /> Novo lead
        </button>
      </div>

      {isLoading ? (
        <p className="text-center text-gray-400 py-10 text-sm">Carregando…</p>
      ) : leads.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-10 text-center text-gray-400 text-sm">
          Nenhum lead nesta visão. Capte leads manualmente ou gere pela aba <strong>Inteligência</strong>.
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {leads.map(l => {
            const st = STATUS_MAP[l.status] || STATUS[0]
            const t = TEMP[l.temperatura] || TEMP.FRIO
            const convertido = l.status === 'CONVERTIDO'
            return (
              <div key={l.id} className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 group">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-medium text-gray-800 truncate">{l.empresa}</p>
                    {l.contato_nome && <p className="text-xs text-gray-500 truncate">{l.contato_nome}</p>}
                  </div>
                  <span className={`text-[11px] px-2 py-0.5 rounded-full whitespace-nowrap ${t.cor}`}>{t.icone} {t.label}</span>
                </div>

                {/* Score */}
                <div className="mt-2">
                  <div className="flex items-center justify-between text-[11px] text-gray-400 mb-0.5">
                    <span className="flex items-center gap-1"><Star size={11} /> Score</span>
                    <span className="font-semibold text-gray-600">{l.score}/100</span>
                  </div>
                  <div className="h-1.5 rounded-full bg-gray-100 overflow-hidden">
                    <div className={`h-full rounded-full ${l.score >= 70 ? 'bg-red-500' : l.score >= 40 ? 'bg-amber-500' : 'bg-sky-500'}`} style={{ width: `${l.score}%` }} />
                  </div>
                </div>

                <div className="flex items-center justify-between mt-2 text-xs">
                  <span className={`px-2 py-0.5 rounded-full ${st.cor}`}>{st.label}</span>
                  <span className="font-semibold text-gray-700">{fmtBRL(l.valor_potencial)}</span>
                </div>
                <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1.5 text-[11px] text-gray-400">
                  {l.canal && <span>{CANAL_LABEL[l.canal] || l.canal}</span>}
                  {l.origem && <span>{l.origem}</span>}
                  {l.cliente && <span>cliente da base</span>}
                </div>

                <div className="flex items-center gap-2 mt-3 pt-2 border-t border-gray-50">
                  {!convertido ? (
                    <button onClick={() => converter.mutate(l.id)} disabled={converter.isPending}
                      className="flex-1 flex items-center justify-center gap-1.5 text-xs bg-emerald-600 hover:bg-emerald-500 text-white py-1.5 rounded-lg">
                      <ArrowRightCircle size={14} /> Converter
                    </button>
                  ) : (
                    <span className="flex-1 text-xs text-emerald-600 text-center">✅ Convertido</span>
                  )}
                  <button onClick={() => setModal(l)} className="p-1.5 text-gray-400 hover:text-blue-600 border rounded-lg"><Pencil size={14} /></button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {modal && <ModalLead lead={modal === 'novo' ? undefined : modal} onClose={() => setModal(null)} onSaved={invalidar} />}
    </div>
  )
}

function ModalLead({ lead, onClose, onSaved }: { lead?: any; onClose: () => void; onSaved: () => void }) {
  const edicao = !!lead
  const [empresa, setEmpresa] = useState(lead?.empresa || '')
  const [contatoNome, setContatoNome] = useState(lead?.contato_nome || '')
  const [email, setEmail] = useState(lead?.email || '')
  const [telefone, setTelefone] = useState(lead?.telefone || '')
  const [canal, setCanal] = useState(lead?.canal || '')
  const [origem, setOrigem] = useState(lead?.origem || '')
  const [valor, setValor] = useState(lead?.valor_potencial ? String(lead.valor_potencial) : '')
  const [status, setStatus] = useState(lead?.status || 'NOVO')
  const [clienteId, setClienteId] = useState(lead?.cliente_id || '')
  const [clienteNome, setClienteNome] = useState(lead?.cliente || '')
  const [observacao, setObservacao] = useState(lead?.observacao || '')

  const salvar = useMutation({
    mutationFn: () => {
      const body = {
        empresa: empresa.trim(), contato_nome: contatoNome || null, email: email || null, telefone: telefone || null,
        canal: canal || null, origem: origem || null, valor_potencial: valor ? Number(valor) : 0,
        cliente_id: clienteId || null, observacao: observacao || null,
        ...(edicao ? { status } : {}),
      }
      return edicao ? api.patch(`/crm/leads/${lead.id}`, body) : api.post('/crm/leads', body)
    },
    onSuccess: () => { toast.success(edicao ? 'Lead atualizado' : 'Lead criado'); onSaved(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao salvar'), { duration: 5000 }),
  })
  const excluir = useMutation({
    mutationFn: () => api.delete(`/crm/leads/${lead.id}`),
    onSuccess: () => { toast.success('Lead removido'); onSaved(); onClose() },
  })

  return (
    <ModalBase titulo={edicao ? 'Editar lead' : 'Novo lead'} onClose={onClose} max="max-w-lg">
      <div className="p-5 space-y-3 overflow-y-auto">
        <Campo label="Empresa / Órgão *"><input value={empresa} onChange={e => setEmpresa(e.target.value)} className={inputCls} autoFocus /></Campo>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Contato"><input value={contatoNome} onChange={e => setContatoNome(e.target.value)} className={inputCls} /></Campo>
          <Campo label="Telefone"><input value={telefone} onChange={e => setTelefone(e.target.value)} className={inputCls} /></Campo>
          <Campo label="E-mail"><input type="email" value={email} onChange={e => setEmail(e.target.value)} className={inputCls} /></Campo>
          <Campo label="Valor potencial (R$)"><input type="number" step="0.01" value={valor} onChange={e => setValor(e.target.value)} className={inputCls} placeholder="0,00" /></Campo>
          <Campo label="Canal">
            <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
              <option value="">—</option>{CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
            </select>
          </Campo>
          <Campo label="Origem">
            <select value={origem} onChange={e => setOrigem(e.target.value)} className={inputCls}>
              <option value="">—</option>{ORIGENS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Campo>
        </div>
        <Campo label="Cliente da base (se já existe)">
          <ClienteAutocomplete value={clienteId} onChange={(id, nome) => { setClienteId(id); setClienteNome(nome) }} />
          {clienteId && <p className="text-xs text-green-600 mt-1">✅ {clienteNome}</p>}
        </Campo>
        {edicao && (
          <Campo label="Status">
            <select value={status} onChange={e => setStatus(e.target.value)} className={inputCls}>
              {STATUS.filter(s => s.key !== 'CONVERTIDO').map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
            </select>
          </Campo>
        )}
        <Campo label="Observação"><textarea rows={2} value={observacao} onChange={e => setObservacao(e.target.value)} className={inputCls} /></Campo>
        <div className="bg-blue-50 rounded-lg p-2 text-[11px] text-blue-600">
          💡 O <strong>score</strong> é calculado automaticamente a partir do valor potencial, dados de contato, canal, origem e se já é cliente.
        </div>
      </div>
      <div className="p-4 border-t flex items-center justify-between">
        {edicao ? <button onClick={() => { if (confirm('Remover lead?')) excluir.mutate() }} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-red-600"><Trash2 size={15} /> Remover</button> : <span />}
        <div className="flex gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
          <button onClick={() => salvar.mutate()} disabled={!empresa.trim() || salvar.isPending}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">Salvar</button>
        </div>
      </div>
    </ModalBase>
  )
}

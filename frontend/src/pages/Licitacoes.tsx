import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, X, Gavel, FileText, AlertTriangle, Trash2 } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'
import { ClienteAutocomplete } from './NovoPedido'
import { ItensPedido, type ItemLinha } from '../components/ItensPedido'

const fmtBRL = (v: number) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const fmtData = (d?: string | null) => d ? new Date(d + 'T12:00:00').toLocaleDateString('pt-BR') : '—'

const STATUS_CFG: Record<string, { label: string; cor: string }> = {
  ABERTO: { label: 'Aberto', cor: 'bg-blue-100 text-blue-700' },
  PARCIAL: { label: 'Parcial', cor: 'bg-amber-100 text-amber-700' },
  CONCLUIDO: { label: 'Concluído', cor: 'bg-emerald-100 text-emerald-700' },
  VENCIDO: { label: 'Vencido', cor: 'bg-red-100 text-red-700' },
}

function msgErro(e: any, fb: string) {
  const d = e?.response?.data?.detail
  return typeof d === 'string' ? d : Array.isArray(d) ? (d[0]?.msg || fb) : fb
}

// Vigência próxima do fim (≤ 15 dias) e ainda com saldo → risco de perder faturamento
function vigenciaEmRisco(vigencia?: string | null, saldoUn?: number) {
  if (!vigencia || !saldoUn || saldoUn <= 0) return false
  const dias = Math.ceil((new Date(vigencia + 'T12:00:00').getTime() - Date.now()) / 86400000)
  return dias >= 0 && dias <= 15
}

export function Licitacoes() {
  const qc = useQueryClient()
  const [modalNovo, setModalNovo] = useState(false)
  const [abertoId, setAbertoId] = useState<string | null>(null)

  const { data: empenhos = [], isLoading } = useQuery<any[]>({
    queryKey: ['empenhos'],
    queryFn: () => api.get('/licitacoes/empenhos').then(r => r.data),
  })

  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ['empenhos'] })
    if (abertoId) qc.invalidateQueries({ queryKey: ['empenho', abertoId] })
  }

  return (
    <div className="p-4 lg:p-6 max-w-5xl mx-auto space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2"><Gavel size={20} /> Licitações</h1>
          <p className="text-sm text-gray-400">Empenhos consignados · o comunicado de uso baixa o saldo · {empenhos.length} empenho(s)</p>
        </div>
        <button onClick={() => setModalNovo(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg">
          <Plus size={16} /> Novo empenho
        </button>
      </div>

      {isLoading ? (
        <p className="text-center text-gray-400 py-10 text-sm">Carregando...</p>
      ) : empenhos.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-10 text-center text-gray-400 text-sm">
          Nenhum empenho cadastrado. Clique em <strong>Novo empenho</strong> para começar.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {empenhos.map((e) => {
            const cfg = STATUS_CFG[e.status] || STATUS_CFG.ABERTO
            const risco = vigenciaEmRisco(e.vigencia, e.saldo_un)
            return (
              <button key={e.id} onClick={() => setAbertoId(e.id)}
                className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 text-left hover:border-blue-300 hover:shadow transition">
                <div className="flex items-start justify-between mb-1">
                  <div>
                    <p className="font-mono font-bold text-gray-800">{e.numero}</p>
                    <p className="text-sm text-gray-600 truncate max-w-[240px]">{e.cliente}</p>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.cor}`}>{cfg.label}</span>
                </div>
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden my-2">
                  <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.min(e.percentual, 100)}%` }} />
                </div>
                <div className="flex justify-between text-xs text-gray-500">
                  <span>Faturado {fmtBRL(e.faturado_valor)} · {e.percentual}%</span>
                  <span className="font-semibold text-gray-700">Saldo {fmtBRL(e.saldo_valor)}</span>
                </div>
                <div className="flex justify-between items-center text-[11px] text-gray-400 mt-1.5">
                  <span>Vigência: {fmtData(e.vigencia)}</span>
                  {risco && <span className="flex items-center gap-1 text-red-500 font-medium"><AlertTriangle size={12} /> vence em breve com saldo</span>}
                </div>
              </button>
            )
          })}
        </div>
      )}

      {modalNovo && <ModalNovoEmpenho onClose={() => setModalNovo(false)} onSaved={invalidar} />}
      {abertoId && <ModalEmpenho id={abertoId} onClose={() => setAbertoId(null)} onChanged={invalidar} />}
    </div>
  )
}

function ModalBase({ titulo, onClose, children, max = 'max-w-2xl' }: { titulo: React.ReactNode; onClose: () => void; children: React.ReactNode; max?: string }) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className={`bg-white rounded-2xl w-full ${max} max-h-[88vh] flex flex-col`} onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b flex items-center justify-between">
          <h2 className="text-lg font-bold">{titulo}</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

const inputCls = 'w-full border rounded-lg px-3 py-2.5 text-sm'
function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="text-sm text-gray-600">{label}</label>{children}</div>
}

function ModalNovoEmpenho({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const hoje = new Date().toISOString().slice(0, 10)
  const [numero, setNumero] = useState('')
  const [clienteId, setClienteId] = useState('')
  const [clienteNome, setClienteNome] = useState('')
  const [dataEmpenho, setDataEmpenho] = useState(hoje)
  const [vigencia, setVigencia] = useState('')
  const [observacao, setObservacao] = useState('')
  const [itens, setItens] = useState<ItemLinha[]>([])

  const criar = useMutation({
    mutationFn: () => api.post('/licitacoes/empenhos', {
      numero: numero.trim(),
      cliente_id: clienteId,
      data_empenho: dataEmpenho || null,
      vigencia: vigencia || null,
      observacao: observacao || null,
      itens: itens.map(i => ({ produto_id: i.produto_id, qtd_empenhada: i.qtd, valor_unitario: i.valor || 0 })),
    }),
    onSuccess: () => { toast.success('Empenho cadastrado'); onSaved(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao cadastrar empenho')),
  })

  const valido = numero.trim() && clienteId && itens.length > 0

  return (
    <ModalBase titulo="Novo empenho" onClose={onClose}>
      <div className="p-5 space-y-3 overflow-y-auto">
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Número do empenho *"><input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: NE 2026/0123" /></Campo>
          <Campo label="Data do empenho"><input type="date" value={dataEmpenho} onChange={e => setDataEmpenho(e.target.value)} className={inputCls} /></Campo>
        </div>
        <Campo label="Cliente / Órgão *">
          <ClienteAutocomplete value={clienteId} onChange={(id, nome) => { setClienteId(id); setClienteNome(nome) }} />
          {clienteId && <p className="text-xs text-green-600 mt-1">✅ {clienteNome}</p>}
        </Campo>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Vigência (até)"><input type="date" value={vigencia} onChange={e => setVigencia(e.target.value)} className={inputCls} /></Campo>
        </div>
        <Campo label="Observação"><input value={observacao} onChange={e => setObservacao(e.target.value)} className={inputCls} placeholder="Opcional" /></Campo>
        <div>
          <label className="text-sm text-gray-600">Itens do empenho *</label>
          <p className="text-xs text-gray-400 mb-1.5">Produto, quantidade empenhada e valor unitário.</p>
          <ItensPedido value={itens} onChange={setItens} comValor />
        </div>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => criar.mutate()} disabled={!valido || criar.isPending}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {criar.isPending ? 'Salvando...' : 'Cadastrar empenho'}
        </button>
      </div>
    </ModalBase>
  )
}

function ModalEmpenho({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient()
  const [consumo, setConsumo] = useState(false)
  const { data: emp } = useQuery<any>({
    queryKey: ['empenho', id],
    queryFn: () => api.get(`/licitacoes/empenhos/${id}`).then(r => r.data),
  })

  const excluir = useMutation({
    mutationFn: () => api.delete(`/licitacoes/empenhos/${id}`),
    onSuccess: () => { toast.success('Empenho excluído'); onChanged(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao excluir')),
  })

  if (!emp) {
    return <ModalBase titulo="Empenho" onClose={onClose}><p className="p-8 text-center text-gray-400 text-sm">Carregando...</p></ModalBase>
  }

  const cfg = STATUS_CFG[emp.status] || STATUS_CFG.ABERTO

  return (
    <ModalBase titulo={<span className="flex items-center gap-2 font-mono">{emp.numero} <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.cor}`}>{cfg.label}</span></span>} onClose={onClose} max="max-w-3xl">
      <div className="flex-1 overflow-y-auto">
        <div className="px-5 py-4 bg-gray-50 border-b">
          <p className="text-sm text-gray-700 font-medium">{emp.cliente}</p>
          <p className="text-xs text-gray-400">Empenhado {fmtData(emp.data_empenho)} · Vigência {fmtData(emp.vigencia)}</p>
          <div className="grid grid-cols-3 gap-3 mt-3">
            <div><p className="text-[11px] text-gray-400 uppercase">Empenhado</p><p className="text-base font-bold text-gray-800">{fmtBRL(emp.empenhado_valor)}</p></div>
            <div><p className="text-[11px] text-gray-400 uppercase">Faturado</p><p className="text-base font-bold text-emerald-600">{fmtBRL(emp.faturado_valor)}</p></div>
            <div><p className="text-[11px] text-gray-400 uppercase">Saldo</p><p className="text-base font-bold text-blue-600">{fmtBRL(emp.saldo_valor)}</p></div>
          </div>
          <div className="h-2 rounded-full bg-gray-200 overflow-hidden mt-2">
            <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(emp.percentual, 100)}%` }} />
          </div>
          <p className="text-[11px] text-gray-400 mt-1">{emp.percentual}% consumido</p>
        </div>

        {/* Itens com saldo */}
        <div className="p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Itens · saldo por produto</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-gray-500 border-b">
                <th className="pb-2 pr-3">Código</th><th className="pb-2 pr-3">Descrição</th>
                <th className="pb-2 pr-3 text-right">Empenhado</th><th className="pb-2 pr-3 text-right">Faturado</th>
                <th className="pb-2 text-right">Saldo</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-50">
                {emp.itens.map((it: any) => (
                  <tr key={it.produto_id}>
                    <td className="py-2 pr-3 font-mono">{it.codigo}</td>
                    <td className="py-2 pr-3 text-gray-600 max-w-[200px] truncate">{it.descricao}</td>
                    <td className="py-2 pr-3 text-right tabular-nums">{it.qtd_empenhada}</td>
                    <td className="py-2 pr-3 text-right tabular-nums text-emerald-600">{it.qtd_faturada}</td>
                    <td className="py-2 text-right tabular-nums font-semibold">{it.qtd_saldo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Consumos (comunicados) */}
        <div className="px-5 pb-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Comunicados de uso lançados ({emp.consumos.length})</h3>
          {emp.consumos.length === 0 ? (
            <p className="text-xs text-gray-400">Nenhum comunicado de uso ainda.</p>
          ) : (
            <div className="border border-gray-100 rounded-lg divide-y divide-gray-50">
              {emp.consumos.map((c: any) => (
                <div key={c.id} className="flex justify-between px-3 py-2 text-sm">
                  <span className="font-mono text-gray-700">{c.numero_pedido}</span>
                  <span className="text-gray-500">NF {c.numero_nf} · {fmtData(c.data)}</span>
                  <span className="font-medium text-gray-700">{fmtBRL(c.valor_nf)}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="p-4 border-t flex items-center justify-between">
        <button onClick={() => { if (confirm('Excluir este empenho? (só é possível se não houver comunicados lançados)')) excluir.mutate() }}
          className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-red-600">
          <Trash2 size={15} /> Excluir
        </button>
        <button onClick={() => setConsumo(true)} disabled={emp.saldo_un <= 0}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-medium rounded-lg">
          <FileText size={16} /> Registrar comunicado de uso
        </button>
      </div>

      {consumo && <ModalConsumo emp={emp} onClose={() => setConsumo(false)} onSaved={() => { qc.invalidateQueries({ queryKey: ['empenho', id] }); onChanged() }} />}
    </ModalBase>
  )
}

function ModalConsumo({ emp, onClose, onSaved }: { emp: any; onClose: () => void; onSaved: () => void }) {
  const hoje = new Date().toISOString().slice(0, 10)
  const comSaldo = emp.itens.filter((i: any) => i.qtd_saldo > 0)
  const [numero, setNumero] = useState('')
  const [nf, setNf] = useState('')
  const [valor, setValor] = useState('')
  const [data, setData] = useState(hoje)
  const [canal, setCanal] = useState('LICITACAO_URO')
  const [qtds, setQtds] = useState<Record<string, string>>({})

  const registrar = useMutation({
    mutationFn: () => api.post(`/licitacoes/empenhos/${emp.id}/consumo`, {
      numero_pedido: numero.trim(),
      numero_nf: nf.trim(),
      valor_nf: Number(valor),
      data_faturamento: data || null,
      canal,
      itens: comSaldo
        .filter((i: any) => Number(qtds[i.produto_id]) > 0)
        .map((i: any) => ({ produto_id: i.produto_id, qtd_solicitada: Number(qtds[i.produto_id]) })),
    }),
    onSuccess: () => { toast.success('Comunicado de uso lançado — saldo atualizado'); onSaved(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao lançar comunicado')),
  })

  const algumItem = comSaldo.some((i: any) => Number(qtds[i.produto_id]) > 0)
  const valido = numero.trim() && nf.trim() && Number(valor) > 0 && algumItem

  return (
    <ModalBase titulo={`Comunicado de uso · ${emp.numero}`} onClose={onClose}>
      <div className="p-5 space-y-3 overflow-y-auto">
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Nº do lançamento *"><input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: CU000123" /></Campo>
          <Campo label="Data do faturamento *"><input type="date" value={data} onChange={e => setData(e.target.value)} className={inputCls} /></Campo>
          <Campo label="Número da NF *"><input value={nf} onChange={e => setNf(e.target.value)} className={`${inputCls} font-mono`} placeholder="Ex: 20045" /></Campo>
          <Campo label="Valor da NF (R$) *"><input type="number" step="0.01" value={valor} onChange={e => setValor(e.target.value)} className={inputCls} placeholder="0,00" /></Campo>
        </div>
        <Campo label="Canal">
          <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
            <option value="LICITACAO_URO">Licitação - Uro</option>
            <option value="LICITACAO_VASCULAR">Licitação - Vascular</option>
            <option value="URO">Uro</option>
            <option value="VASCULAR">Vascular</option>
          </select>
        </Campo>
        <div>
          <label className="text-sm text-gray-600">Quantidades consumidas *</label>
          <p className="text-xs text-gray-400 mb-1.5">Informe quanto foi usado de cada item (limitado ao saldo).</p>
          <div className="border border-gray-100 rounded-lg divide-y divide-gray-50">
            {comSaldo.length === 0 ? (
              <p className="px-3 py-3 text-xs text-gray-400">Sem saldo disponível neste empenho.</p>
            ) : comSaldo.map((i: any) => (
              <div key={i.produto_id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <div className="flex-1 min-w-0">
                  <span className="font-mono font-medium text-gray-800">{i.codigo}</span>
                  <span className="text-gray-500 ml-2">{i.descricao}</span>
                  <span className="block text-[11px] text-gray-400">saldo {i.qtd_saldo}</span>
                </div>
                <input type="number" min="0" max={i.qtd_saldo} step="1"
                  value={qtds[i.produto_id] || ''}
                  onChange={e => setQtds(q => ({ ...q, [i.produto_id]: e.target.value }))}
                  placeholder="0" className="w-24 border rounded-lg px-2 py-1 text-sm text-right" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => registrar.mutate()} disabled={!valido || registrar.isPending}
          className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {registrar.isPending ? 'Lançando...' : 'Lançar comunicado'}
        </button>
      </div>
    </ModalBase>
  )
}

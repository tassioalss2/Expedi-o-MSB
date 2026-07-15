import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus, X, Gavel, FileText, AlertTriangle, Trash2, ShoppingCart, Boxes,
  LayoutGrid, Layers, ChevronDown, ChevronRight, ExternalLink, Flag, Clock, Search,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'
import { ClienteAutocomplete } from './NovoPedido'
import { ItensPedido, type ItemLinha } from '../components/ItensPedido'
import { CANAL_LABEL } from '../lib/statusConfig'

const CANAIS = ['LICITACAO_URO', 'LICITACAO_VASCULAR', 'URO', 'VASCULAR', 'REALCLOSURE']

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
  if (typeof d === 'string') return d
  if (Array.isArray(d)) return d[0]?.msg || fb
  if (d?.msg) return d.msg
  return fb
}

function vigenciaEmRisco(vigencia?: string | null, saldoUn?: number) {
  if (!vigencia || !saldoUn || saldoUn <= 0) return false
  const dias = Math.ceil((new Date(vigencia + 'T12:00:00').getTime() - Date.now()) / 86400000)
  return dias >= 0 && dias <= 15
}

// ── Config dos 3 tipos de operação (ordem de importância) ───────────────────────
type TipoKey = 'VENDA_DIRETA' | 'COMUNICADO_USO' | 'CONSIGNACAO'
const TIPOS: {
  key: TipoKey; label: string; icone: any; desc: string
  header: string; borda: string; chip: string; ponto: string
}[] = [
  {
    key: 'VENDA_DIRETA', label: 'Venda direta', icone: ShoppingCart,
    desc: 'Ganhamos o pregão e o cliente pediu o material (parcial ou total). Vai para o fluxo logístico como OV.',
    header: 'bg-blue-600', borda: 'border-l-blue-500', chip: 'bg-blue-100 text-blue-700', ponto: 'bg-blue-500',
  },
  {
    key: 'COMUNICADO_USO', label: 'Comunicado de uso', icone: FileText,
    desc: 'O cliente utilizou o material consignado — faturamos o que foi usado.',
    header: 'bg-emerald-600', borda: 'border-l-emerald-500', chip: 'bg-emerald-100 text-emerald-700', ponto: 'bg-emerald-500',
  },
  {
    key: 'CONSIGNACAO', label: 'Consignação', icone: Boxes,
    desc: 'Enviamos o material em consignado; o comunicado de uso baixa o saldo conforme o cliente usa.',
    header: 'bg-amber-500', borda: 'border-l-amber-500', chip: 'bg-amber-100 text-amber-700', ponto: 'bg-amber-500',
  },
]
const TIPO_MAP = Object.fromEntries(TIPOS.map(t => [t.key, t]))

const ETAPAS: { key: string; label: string }[] = [
  { key: 'NOVO', label: 'Novo' },
  { key: 'ANALISE', label: 'Em análise' },
  { key: 'PROCESSANDO', label: 'Processando' },
  { key: 'CONCLUIDO', label: 'Concluído' },
]

const PRIO_CFG: Record<string, { label: string; cor: string }> = {
  CRITICA: { label: '🔴 Crítica', cor: 'bg-red-100 text-red-700' },
  ALTA: { label: '⚡ Alta', cor: 'bg-amber-100 text-amber-700' },
  NORMAL: { label: 'Normal', cor: 'bg-gray-100 text-gray-500' },
}

// Prazo: vencido (vermelho) ou ≤ 3 dias (âmbar)
function prazoCor(prazo?: string | null): string {
  if (!prazo) return 'text-gray-400'
  const dias = Math.ceil((new Date(prazo + 'T12:00:00').getTime() - Date.now()) / 86400000)
  if (dias < 0) return 'text-red-600 font-semibold'
  if (dias <= 3) return 'text-amber-600 font-medium'
  return 'text-gray-500'
}

const toItemLinhas = (itens: any[]): ItemLinha[] =>
  (itens || []).filter(i => i.produto_id).map(i => ({
    produto_id: i.produto_id, codigo: i.codigo || '', descricao: i.descricao || '',
    qtd: Number(i.qtd) || 0, valor: Number(i.valor) || 0,
  }))

// ════════════════════════════════════════════════════════════════════════════════
export function Licitacoes() {
  const [aba, setAba] = useState<'painel' | 'empenhos'>('painel')

  return (
    <div className="p-4 lg:p-6 max-w-[1400px] mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2"><Gavel size={20} /> Licitações</h1>
        <p className="text-sm text-gray-400">Painel de triagem das demandas do dia e controle dos empenhos consignados.</p>
      </div>

      <div className="flex gap-1 border-b">
        {([['painel', 'Painel de demandas', LayoutGrid], ['empenhos', 'Empenhos (consignação)', Layers]] as const).map(([k, label, Icone]) => (
          <button key={k} onClick={() => setAba(k)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition ${
              aba === k ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            <Icone size={16} /> {label}
          </button>
        ))}
      </div>

      {aba === 'painel' ? <PainelDemandas /> : <AbaEmpenhos />}
    </div>
  )
}

// ── Painel Kanban de demandas ────────────────────────────────────────────────────
function PainelDemandas() {
  const qc = useQueryClient()
  const [modalNovo, setModalNovo] = useState<TipoKey | null>(null)
  const [detalheId, setDetalheId] = useState<string | null>(null)
  const [concluir, setConcluir] = useState<any | null>(null)
  const [arrastando, setArrastando] = useState<string | null>(null)
  const [busca, setBusca] = useState('')
  const [canalFiltro, setCanalFiltro] = useState('')
  const [colapsadas, setColapsadas] = useState<Record<string, boolean>>({})

  const { data: demandas = [], isLoading } = useQuery<any[]>({
    queryKey: ['demandas'],
    queryFn: () => api.get('/licitacoes/demandas').then(r => r.data),
    refetchInterval: 20000,
  })

  const invalidar = () => qc.invalidateQueries({ queryKey: ['demandas'] })

  const mover = useMutation({
    mutationFn: ({ id, etapa }: { id: string; etapa: string }) => api.patch(`/licitacoes/demandas/${id}`, { etapa }),
    onSuccess: invalidar,
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao mover demanda')),
  })

  const filtradas = useMemo(() => {
    const b = busca.trim().toLowerCase()
    return demandas.filter(d => {
      if (canalFiltro && d.canal !== canalFiltro) return false
      if (b) {
        const alvo = `${d.cliente || ''} ${d.numero || ''} ${d.gerado_ref || ''}`.toLowerCase()
        if (!alvo.includes(b)) return false
      }
      return true
    })
  }, [demandas, busca, canalFiltro])

  const porTipoEtapa = (tipo: string, etapa: string) => filtradas.filter(d => d.tipo_operacao === tipo && d.etapa === etapa)

  const onDrop = (tipo: TipoKey, etapa: string) => {
    const id = arrastando
    setArrastando(null)
    if (!id) return
    const d = demandas.find(x => x.id === id)
    if (!d || d.etapa === etapa) return
    if (d.tipo_operacao !== tipo) return // não muda o tipo ao arrastar entre raias
    if (etapa === 'CONCLUIDO') { setConcluir(d); return }
    mover.mutate({ id, etapa })
  }

  const total = filtradas.length
  const pendentes = filtradas.filter(d => d.etapa !== 'CONCLUIDO').length

  return (
    <div className="space-y-4">
      {/* Barra de ações + filtros */}
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="flex items-center gap-2 flex-1">
          <div className="relative flex-1 max-w-xs">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar cliente ou número…"
              className="w-full border rounded-lg pl-9 pr-3 py-2 text-sm" />
          </div>
          <select value={canalFiltro} onChange={e => setCanalFiltro(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
            <option value="">Todos os canais</option>
            {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
          </select>
          <span className="text-xs text-gray-400 hidden lg:block">{pendentes} pendente(s) · {total} no total</span>
        </div>
        <div className="flex items-center gap-2">
          {TIPOS.map(t => (
            <button key={t.key} onClick={() => setModalNovo(t.key)}
              className={`flex items-center gap-1.5 text-white text-sm font-medium px-3 py-2 rounded-lg ${t.header} hover:opacity-90`}>
              <Plus size={15} /> {t.label}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <p className="text-center text-gray-400 py-10 text-sm">Carregando painel…</p>
      ) : (
        <div className="space-y-4">
          {TIPOS.map(tipo => {
            const Icone = tipo.icone
            const colaps = colapsadas[tipo.key]
            const totalTipo = filtradas.filter(d => d.tipo_operacao === tipo.key).length
            return (
              <div key={tipo.key} className="bg-white rounded-xl border border-gray-100 shadow-sm overflow-hidden">
                <button onClick={() => setColapsadas(c => ({ ...c, [tipo.key]: !c[tipo.key] }))}
                  className={`w-full flex items-center gap-2 px-4 py-2.5 text-white ${tipo.header}`}>
                  {colaps ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
                  <Icone size={17} />
                  <span className="font-semibold text-sm">{tipo.label}</span>
                  <span className="text-xs bg-white/25 rounded-full px-2 py-0.5">{totalTipo}</span>
                  <span className="text-[11px] text-white/70 ml-2 hidden md:block truncate">{tipo.desc}</span>
                </button>

                {!colaps && (
                  <div className="grid grid-cols-2 lg:grid-cols-4 gap-px bg-gray-100">
                    {ETAPAS.map(etapa => {
                      const cards = porTipoEtapa(tipo.key, etapa.key)
                      return (
                        <div key={etapa.key}
                          onDragOver={e => { e.preventDefault() }}
                          onDrop={() => onDrop(tipo.key, etapa.key)}
                          className="bg-gray-50 min-h-[90px] p-2">
                          <div className="flex items-center justify-between mb-2 px-1">
                            <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{etapa.label}</span>
                            <span className="text-[11px] text-gray-400">{cards.length}</span>
                          </div>
                          <div className="space-y-2">
                            {cards.map(d => (
                              <CardDemanda key={d.id} d={d} tipo={tipo}
                                onDragStart={() => setArrastando(d.id)}
                                onClick={() => setDetalheId(d.id)} />
                            ))}
                            {cards.length === 0 && (
                              <div className="text-[11px] text-gray-300 text-center py-3 border-2 border-dashed border-gray-200 rounded-lg">
                                arraste aqui
                              </div>
                            )}
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {modalNovo && <ModalNovaDemanda tipoInicial={modalNovo} onClose={() => setModalNovo(null)} onSaved={invalidar} />}
      {detalheId && (
        <ModalDetalheDemanda id={detalheId} onClose={() => setDetalheId(null)} onChanged={invalidar}
          onConcluir={(d) => { setDetalheId(null); setConcluir(d) }} />
      )}
      {concluir && <ModalConcluir demanda={concluir} onClose={() => setConcluir(null)} onSaved={invalidar} />}
    </div>
  )
}

// ── Card de demanda (arrastável) ─────────────────────────────────────────────────
function CardDemanda({ d, tipo, onDragStart, onClick }: { d: any; tipo: any; onDragStart: () => void; onClick: () => void }) {
  const prio = PRIO_CFG[d.prioridade] || PRIO_CFG.NORMAL
  const nItens = (d.itens || []).length
  return (
    <div
      draggable
      onDragStart={onDragStart}
      onClick={onClick}
      className={`bg-white rounded-lg border border-gray-200 border-l-4 ${tipo.borda} shadow-sm p-2.5 cursor-pointer hover:shadow-md hover:border-l-8 transition-all`}>
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-medium text-gray-800 leading-tight line-clamp-2">{d.cliente || 'Cliente não informado'}</p>
        {d.prioridade !== 'NORMAL' && <span className={`text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${prio.cor}`}>{prio.label}</span>}
      </div>
      {d.numero && <p className="text-xs font-mono text-gray-500 mt-0.5">{d.numero}</p>}
      <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5 text-[11px]">
        {d.canal && <span className="text-gray-400">{CANAL_LABEL[d.canal] || d.canal}</span>}
        {nItens > 0 && <span className="text-gray-400">{nItens} item(ns)</span>}
        {d.prazo && <span className={`flex items-center gap-1 ${prazoCor(d.prazo)}`}><Clock size={11} /> {fmtData(d.prazo)}</span>}
      </div>
      {d.etapa === 'CONCLUIDO' && d.gerado_ref && (
        <p className="text-[11px] text-emerald-600 mt-1.5 flex items-center gap-1"><ExternalLink size={11} /> Gerou: {d.gerado_ref}</p>
      )}
    </div>
  )
}

// ── Modal: Nova demanda (cadastro rápido) ────────────────────────────────────────
function ModalNovaDemanda({ tipoInicial, onClose, onSaved }: { tipoInicial: TipoKey; onClose: () => void; onSaved: () => void }) {
  const [tipo, setTipo] = useState<TipoKey>(tipoInicial)
  const [clienteId, setClienteId] = useState('')
  const [clienteNome, setClienteNome] = useState('')
  const [numero, setNumero] = useState('')
  const [canal, setCanal] = useState('')
  const [prazo, setPrazo] = useState('')
  const [prioridade, setPrioridade] = useState('NORMAL')
  const [observacao, setObservacao] = useState('')
  const [itens, setItens] = useState<ItemLinha[]>([])

  const cfg = TIPO_MAP[tipo]
  const comValor = tipo === 'CONSIGNACAO'

  const criar = useMutation({
    mutationFn: () => api.post('/licitacoes/demandas', {
      tipo_operacao: tipo,
      cliente_id: clienteId,
      numero: numero.trim() || null,
      canal: canal || null,
      prazo: prazo || null,
      prioridade,
      observacao: observacao || null,
      itens: itens.map(i => ({ produto_id: i.produto_id, codigo: i.codigo, descricao: i.descricao, qtd: i.qtd, valor: i.valor || 0 })),
    }),
    onSuccess: () => { toast.success('Demanda adicionada ao painel'); onSaved(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao adicionar demanda')),
  })

  return (
    <ModalBase titulo="Nova demanda de licitação" onClose={onClose}>
      <div className="p-5 space-y-3 overflow-y-auto">
        {/* Seletor de tipo */}
        <div className="grid grid-cols-3 gap-2">
          {TIPOS.map(t => {
            const Icone = t.icone
            const ativo = tipo === t.key
            return (
              <button key={t.key} onClick={() => setTipo(t.key)}
                className={`flex flex-col items-center gap-1 py-2.5 rounded-lg border-2 text-xs font-medium transition ${
                  ativo ? `${t.chip} border-current` : 'border-gray-200 text-gray-500 hover:border-gray-300'
                }`}>
                <Icone size={18} /> {t.label}
              </button>
            )
          })}
        </div>
        <p className="text-[11px] text-gray-400 -mt-1">{cfg.desc}</p>

        <Campo label="Cliente / Órgão *">
          <ClienteAutocomplete value={clienteId} onChange={(id, nome) => { setClienteId(id); setClienteNome(nome) }} />
          {clienteId && <p className="text-xs text-green-600 mt-1">✅ {clienteNome}</p>}
        </Campo>

        <div className="grid grid-cols-2 gap-3">
          <Campo label={tipo === 'CONSIGNACAO' ? 'Nº do empenho' : tipo === 'VENDA_DIRETA' ? 'Nº do pregão / OV' : 'Referência'}>
            <input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Opcional" />
          </Campo>
          <Campo label="Canal">
            <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
              <option value="">A definir…</option>
              {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
            </select>
          </Campo>
          <Campo label="Prazo / vigência">
            <input type="date" value={prazo} onChange={e => setPrazo(e.target.value)} className={inputCls} />
          </Campo>
          <Campo label="Prioridade">
            <select value={prioridade} onChange={e => setPrioridade(e.target.value)} className={inputCls}>
              <option value="NORMAL">Normal</option>
              <option value="ALTA">⚡ Alta</option>
              <option value="CRITICA">🔴 Crítica</option>
            </select>
          </Campo>
        </div>

        <Campo label="Observação">
          <input value={observacao} onChange={e => setObservacao(e.target.value)} className={inputCls} placeholder="Ex: aguardando confirmação de estoque" />
        </Campo>

        <div>
          <label className="text-sm text-gray-600">Itens {tipo === 'CONSIGNACAO' && '(com valor)'}</label>
          <p className="text-xs text-gray-400 mb-1.5">Opcional agora — você pode completar ao processar. Ajuda a adiantar o trabalho.</p>
          <ItensPedido value={itens} onChange={setItens} comValor={comValor} />
        </div>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => criar.mutate()} disabled={!clienteId || criar.isPending}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {criar.isPending ? 'Salvando…' : 'Adicionar ao painel'}
        </button>
      </div>
    </ModalBase>
  )
}

// ── Modal: Detalhe da demanda ────────────────────────────────────────────────────
function ModalDetalheDemanda({ id, onClose, onChanged, onConcluir }: {
  id: string; onClose: () => void; onChanged: () => void; onConcluir: (d: any) => void
}) {
  const navigate = useNavigate()
  const { data: d } = useQuery<any>({
    queryKey: ['demanda', id],
    queryFn: () => api.get(`/licitacoes/demandas/${id}`).then(r => r.data),
  })

  const mover = useMutation({
    mutationFn: (etapa: string) => api.patch(`/licitacoes/demandas/${id}`, { etapa }),
    onSuccess: () => { onChanged(); toast.success('Etapa atualizada') },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao mover')),
  })
  const prioMut = useMutation({
    mutationFn: (prioridade: string) => api.patch(`/licitacoes/demandas/${id}`, { prioridade }),
    onSuccess: onChanged,
  })
  const excluir = useMutation({
    mutationFn: () => api.delete(`/licitacoes/demandas/${id}`),
    onSuccess: () => { toast.success('Demanda removida'); onChanged(); onClose() },
  })

  if (!d) return <ModalBase titulo="Demanda" onClose={onClose}><p className="p-8 text-center text-gray-400 text-sm">Carregando…</p></ModalBase>

  const cfg = TIPO_MAP[d.tipo_operacao] || TIPOS[0]
  const Icone = cfg.icone
  const concluida = d.etapa === 'CONCLUIDO'

  return (
    <ModalBase titulo={<span className="flex items-center gap-2"><Icone size={18} /> {cfg.label}</span>} onClose={onClose}>
      <div className="p-5 space-y-4 overflow-y-auto">
        <div>
          <p className="text-base font-semibold text-gray-800">{d.cliente}</p>
          <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 mt-1">
            {d.numero && <span className="font-mono">{d.numero}</span>}
            {d.canal && <span>Canal: {CANAL_LABEL[d.canal] || d.canal}</span>}
            {d.prazo && <span className={prazoCor(d.prazo)}>Prazo: {fmtData(d.prazo)}</span>}
          </div>
          {d.observacao && <p className="text-sm text-gray-600 mt-2 bg-gray-50 rounded-lg p-2">{d.observacao}</p>}
        </div>

        {/* Prioridade */}
        <div>
          <label className="text-xs font-medium text-gray-500">Prioridade</label>
          <div className="flex gap-2 mt-1">
            {['NORMAL', 'ALTA', 'CRITICA'].map(p => (
              <button key={p} onClick={() => prioMut.mutate(p)} disabled={concluida}
                className={`text-xs px-2.5 py-1 rounded-full disabled:opacity-50 ${d.prioridade === p ? PRIO_CFG[p].cor + ' ring-1 ring-current' : 'bg-gray-100 text-gray-500'}`}>
                {PRIO_CFG[p].label}
              </button>
            ))}
          </div>
        </div>

        {/* Itens */}
        {(d.itens || []).length > 0 && (
          <div>
            <label className="text-xs font-medium text-gray-500">Itens capturados ({d.itens.length})</label>
            <div className="border border-gray-100 rounded-lg divide-y divide-gray-50 mt-1">
              {d.itens.map((it: any, idx: number) => (
                <div key={idx} className="flex justify-between px-3 py-1.5 text-sm">
                  <span><span className="font-mono text-gray-700">{it.codigo || '—'}</span> <span className="text-gray-500">{it.descricao}</span></span>
                  <span className="text-gray-600 tabular-nums">{it.qtd} un{it.valor ? ` · ${fmtBRL(it.valor)}` : ''}</span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Etapas */}
        {!concluida && (
          <div>
            <label className="text-xs font-medium text-gray-500">Mover para</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {ETAPAS.filter(e => e.key !== 'CONCLUIDO').map(e => (
                <button key={e.key} onClick={() => mover.mutate(e.key)}
                  className={`text-sm px-3 py-1.5 rounded-lg border ${d.etapa === e.key ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                  {e.label}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Gerado */}
        {concluida && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
            <p className="text-sm text-emerald-700 font-medium">✅ Concluída — gerou {d.gerado_ref}</p>
            {d.gerado_tipo === 'PEDIDO' || (d.gerado_tipo === 'COMUNICADO' && d.gerado_id && d.gerado_id.length === 36 && d.gerado_tipo !== 'EMPENHO') ? (
              <button onClick={() => navigate(`/expedicao/${d.gerado_id}`)}
                className="text-xs text-emerald-700 underline mt-1 flex items-center gap-1"><ExternalLink size={12} /> Abrir OV/lançamento</button>
            ) : null}
          </div>
        )}
      </div>

      <div className="p-4 border-t flex items-center justify-between">
        <button onClick={() => { if (confirm('Remover esta demanda do painel?')) excluir.mutate() }}
          className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-red-600"><Trash2 size={15} /> Remover</button>
        {!concluida && (
          <button onClick={() => onConcluir(d)}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 text-white font-medium rounded-lg">
            <Flag size={16} /> Concluir e gerar
          </button>
        )}
      </div>
    </ModalBase>
  )
}

// ── Modal: Concluir (gera o artefato conforme o tipo) ────────────────────────────
function ModalConcluir({ demanda, onClose, onSaved }: { demanda: any; onClose: () => void; onSaved: () => void }) {
  const navigate = useNavigate()
  const cfg = TIPO_MAP[demanda.tipo_operacao] || TIPOS[0]
  const hoje = new Date().toISOString().slice(0, 10)
  const tipo: TipoKey = demanda.tipo_operacao

  const [numero, setNumero] = useState(demanda.numero || '')
  const [tipoFrete, setTipoFrete] = useState('FOB')
  const [canal, setCanal] = useState(demanda.canal || '')
  const [dataEntrega, setDataEntrega] = useState(demanda.prazo || '')
  const [localEntrega, setLocalEntrega] = useState('')
  const [dataEmpenho, setDataEmpenho] = useState(hoje)
  const [vigencia, setVigencia] = useState(demanda.prazo || '')
  const [nf, setNf] = useState('')
  const [valorNf, setValorNf] = useState('')
  const [dataFat, setDataFat] = useState(hoje)
  const [empenhoId, setEmpenhoId] = useState('')
  const [itens, setItens] = useState<ItemLinha[]>(toItemLinhas(demanda.itens))

  // Empenhos do mesmo cliente, para vincular comunicado de uso (baixa de saldo)
  const { data: empenhos = [] } = useQuery<any[]>({
    queryKey: ['empenhos'],
    queryFn: () => api.get('/licitacoes/empenhos').then(r => r.data),
    enabled: tipo === 'COMUNICADO_USO',
  })
  const empenhosCliente = empenhos.filter(e => e.cliente_id === demanda.cliente_id && e.saldo_un > 0)

  const concluir = useMutation({
    mutationFn: () => {
      const body: any = {
        canal: canal || null,
        itens: itens.map(i => ({ produto_id: i.produto_id, codigo: i.codigo, descricao: i.descricao, qtd: i.qtd, valor: i.valor || 0 })),
      }
      if (tipo === 'VENDA_DIRETA') {
        body.numero_pedido = numero.trim()
        body.tipo_frete = tipoFrete
        body.data_prevista_entrega = dataEntrega || null
        body.local_entrega = localEntrega || null
      } else if (tipo === 'CONSIGNACAO') {
        body.numero = numero.trim()
        body.data_empenho = dataEmpenho || null
        body.vigencia = vigencia || null
      } else {
        body.numero_pedido = numero.trim()
        body.numero_nf = nf.trim()
        body.valor_nf = Number(valorNf)
        body.data_faturamento = dataFat || null
        body.empenho_id = empenhoId || null
      }
      return api.post(`/licitacoes/demandas/${demanda.id}/concluir`, body)
    },
    onSuccess: (res) => {
      toast.success('Demanda concluída — registro gerado!')
      onSaved(); onClose()
      const g = res.data
      if (g?.gerado_tipo === 'PEDIDO' && g?.gerado_id) {
        setTimeout(() => navigate(`/expedicao/${g.gerado_id}`), 300)
      }
    },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao concluir demanda'), { duration: 6000 }),
  })

  // Validação por tipo
  const itensOk = itens.length > 0 && itens.every(i => i.qtd > 0)
  let valido = false
  if (tipo === 'VENDA_DIRETA') valido = !!numero.trim() && !!dataEntrega && itensOk
  else if (tipo === 'CONSIGNACAO') valido = !!numero.trim() && itens.length > 0 && itens.every(i => i.qtd > 0)
  else valido = !!numero.trim() && !!nf.trim() && Number(valorNf) > 0 && itensOk

  return (
    <ModalBase titulo={<span className="flex items-center gap-2"><Flag size={17} /> Concluir · {cfg.label}</span>} onClose={onClose}>
      <div className="p-5 space-y-3 overflow-y-auto">
        <div className="bg-gray-50 rounded-lg p-3 text-sm">
          <p className="font-medium text-gray-700">{demanda.cliente}</p>
          <p className="text-xs text-gray-400">Ao confirmar, o app gera o registro definitivo automaticamente.</p>
        </div>

        {tipo === 'VENDA_DIRETA' && (
          <>
            <div className="grid grid-cols-2 gap-3">
              <Campo label="Número da OV *"><input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: OV015500" /></Campo>
              <Campo label="Data prevista de entrega *"><input type="date" value={dataEntrega} onChange={e => setDataEntrega(e.target.value)} className={inputCls} /></Campo>
              <Campo label="Tipo de frete">
                <select value={tipoFrete} onChange={e => setTipoFrete(e.target.value)} className={inputCls}>
                  <option value="FOB">FOB</option>
                  <option value="CIF_COM_VALOR">CIF com Valor NF</option>
                  <option value="CIF_SEM_VALOR">CIF sem Valor NF</option>
                </select>
              </Campo>
              <Campo label="Canal">
                <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
                  <option value="">A definir…</option>
                  {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
                </select>
              </Campo>
            </div>
            <Campo label="Local de entrega"><input value={localEntrega} onChange={e => setLocalEntrega(e.target.value)} className={inputCls} placeholder="Ex: São Paulo SP" /></Campo>
          </>
        )}

        {tipo === 'CONSIGNACAO' && (
          <div className="grid grid-cols-2 gap-3">
            <Campo label="Número do empenho *"><input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: NE 2026/0123" /></Campo>
            <Campo label="Canal">
              <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
                <option value="">A definir…</option>
                {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
              </select>
            </Campo>
            <Campo label="Data do empenho"><input type="date" value={dataEmpenho} onChange={e => setDataEmpenho(e.target.value)} className={inputCls} /></Campo>
            <Campo label="Vigência (até)"><input type="date" value={vigencia} onChange={e => setVigencia(e.target.value)} className={inputCls} /></Campo>
          </div>
        )}

        {tipo === 'COMUNICADO_USO' && (
          <>
            {empenhosCliente.length > 0 && (
              <Campo label="Baixar de um empenho consignado (opcional)">
                <select value={empenhoId} onChange={e => setEmpenhoId(e.target.value)} className={inputCls}>
                  <option value="">Comunicado avulso (sem empenho)</option>
                  {empenhosCliente.map(e => <option key={e.id} value={e.id}>{e.numero} · saldo {fmtBRL(e.saldo_valor)}</option>)}
                </select>
              </Campo>
            )}
            <div className="grid grid-cols-2 gap-3">
              <Campo label="Nº do lançamento *"><input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: CU000123" /></Campo>
              <Campo label="Data do faturamento"><input type="date" value={dataFat} onChange={e => setDataFat(e.target.value)} className={inputCls} /></Campo>
              <Campo label="Número da NF *"><input value={nf} onChange={e => setNf(e.target.value)} className={`${inputCls} font-mono`} placeholder="Ex: 20045" /></Campo>
              <Campo label="Valor da NF (R$) *"><input type="number" step="0.01" value={valorNf} onChange={e => setValorNf(e.target.value)} className={inputCls} placeholder="0,00" /></Campo>
            </div>
            <Campo label="Canal">
              <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
                <option value="">A definir…</option>
                {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
              </select>
            </Campo>
          </>
        )}

        <div>
          <label className="text-sm text-gray-600">Itens {tipo === 'CONSIGNACAO' ? '(produto, qtd e valor) *' : '*'}</label>
          <ItensPedido value={itens} onChange={setItens} comValor={tipo === 'CONSIGNACAO'} />
        </div>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => concluir.mutate()} disabled={!valido || concluir.isPending}
          className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {concluir.isPending ? 'Gerando…' : 'Concluir e gerar'}
        </button>
      </div>
    </ModalBase>
  )
}

// ════════════════════════════════════════════════════════════════════════════════
// ── Aba Empenhos (consignação) — controle de saldo ───────────────────────────────
function AbaEmpenhos() {
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
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">Empenhos consignados · o comunicado de uso baixa o saldo · {empenhos.length} empenho(s)</p>
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
                    {e.canal && <p className="text-xs text-gray-400 mt-0.5">Canal: {CANAL_LABEL[e.canal] || e.canal}</p>}
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
  const [canal, setCanal] = useState('LICITACAO_URO')
  const [dataEmpenho, setDataEmpenho] = useState(hoje)
  const [vigencia, setVigencia] = useState('')
  const [observacao, setObservacao] = useState('')
  const [itens, setItens] = useState<ItemLinha[]>([])

  const criar = useMutation({
    mutationFn: () => api.post('/licitacoes/empenhos', {
      numero: numero.trim(),
      cliente_id: clienteId,
      canal,
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
          <Campo label="Canal de venda *">
            <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
              {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
            </select>
          </Campo>
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
          <p className="text-xs text-gray-400">
            {emp.canal && <>Canal: {CANAL_LABEL[emp.canal] || emp.canal} · </>}
            Empenhado {fmtData(emp.data_empenho)} · Vigência {fmtData(emp.vigencia)}
          </p>
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
  const [canal, setCanal] = useState(emp.canal || 'LICITACAO_URO')
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

import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus, X, Gavel, FileText, AlertTriangle, Trash2, ShoppingCart, Boxes,
  LayoutGrid, Layers, ChevronDown, ChevronRight, ExternalLink, Flag, Clock, Search,
  ChevronRight as Arrow, Truck, Send,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'
import { ClienteAutocomplete } from './NovoPedido'
import { ItensPedido, type ItemLinha } from '../components/ItensPedido'
import { CANAL_LABEL, STATUS_CONFIG } from '../lib/statusConfig'

const CANAIS = ['LICITACAO_URO', 'LICITACAO_VASCULAR', 'URO', 'VASCULAR', 'REALCLOSURE']

const fmtBRL = (v: number) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const fmtData = (d?: string | null) => d ? new Date(d + 'T12:00:00').toLocaleDateString('pt-BR') : '—'

const STATUS_CFG: Record<string, { label: string; cor: string }> = {
  ABERTO: { label: 'Aberto', cor: 'bg-blue-100 text-blue-700' },
  PARCIAL: { label: 'Parcial', cor: 'bg-amber-100 text-amber-700' },
  CONCLUIDO: { label: 'Concluído', cor: 'bg-emerald-100 text-emerald-700' },
  VENCIDO: { label: 'Vencido', cor: 'bg-red-100 text-red-700' },
}

// Tipo de contrato (empenho)
const CONTRATO_TIPO: Record<string, { label: string; cor: string; icone: any }> = {
  VENDA_DIRETA: { label: 'Venda direta', cor: 'bg-blue-100 text-blue-700', icone: ShoppingCart },
  CONSIGNACAO: { label: 'Consignação', cor: 'bg-amber-100 text-amber-700', icone: Boxes },
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

// ── Config dos 3 tipos de demanda (ordem de importância) ────────────────────────
type TipoKey = 'VENDA_DIRETA' | 'COMUNICADO_USO' | 'CONSIGNACAO'
const TIPOS: {
  key: TipoKey; label: string; icone: any; desc: string
  header: string; borda: string; chip: string
}[] = [
  {
    key: 'VENDA_DIRETA', label: 'Venda direta', icone: ShoppingCart,
    desc: 'Ganhou o pregão. Vira um contrato com as quantidades totais; as entregas parciais geram OVs que baixam o saldo.',
    header: 'bg-blue-600', borda: 'border-l-blue-500', chip: 'bg-blue-100 text-blue-700',
  },
  {
    key: 'COMUNICADO_USO', label: 'Comunicado de uso', icone: FileText,
    desc: 'O cliente usou o material consignado — faturamos o que foi usado (baixa o saldo de um contrato de consignação).',
    header: 'bg-emerald-600', borda: 'border-l-emerald-500', chip: 'bg-emerald-100 text-emerald-700',
  },
  {
    key: 'CONSIGNACAO', label: 'Consignação', icone: Boxes,
    desc: 'Envio de material em consignado. Vira um contrato; o comunicado de uso baixa o saldo conforme o cliente usa.',
    header: 'bg-amber-500', borda: 'border-l-amber-500', chip: 'bg-amber-100 text-amber-700',
  },
]
const TIPO_MAP = Object.fromEntries(TIPOS.map(t => [t.key, t]))

const ETAPA_LABEL: Record<string, string> = {
  RECEBIDO: 'Recebido',
  PROCESSANDO: 'Em processamento (D365)',
  COTACAO_FRETE: 'Cotação de frete',
  OV_GERADA: 'OV gerada',
  NF_ENVIADA: 'NF enviada',
  CONCLUIDO: 'Concluído',
}
// Venda direta e consignação: fluxo completo (cota frete, gera OV, envia NF).
// Comunicado de uso: fluxo curto (recebe, processa no D365, conclui).
const FLUXO_LICITACAO = ['RECEBIDO', 'PROCESSANDO', 'COTACAO_FRETE', 'OV_GERADA', 'NF_ENVIADA']
const FLUXO_COMUNICADO = ['RECEBIDO', 'PROCESSANDO', 'CONCLUIDO']
const etapasDoTipo = (tipo: string) => tipo === 'COMUNICADO_USO' ? FLUXO_COMUNICADO : FLUXO_LICITACAO
const ETAPAS_FINAIS = ['NF_ENVIADA', 'CONCLUIDO']
// Compatibilidade com etapas antigas
const normEtapa = (e?: string) => (e === 'NOVO' || e === 'ANALISE') ? 'RECEBIDO' : (e || 'RECEBIDO')
const temOV = (d: any) => (d.ovs || []).length > 0 || d.gerado_tipo === 'PEDIDO'
// Coluna onde o card aparece. Legado: VD/consignação concluída no fluxo antigo
// (gerava OV sem passar por frete/NF) volta para "OV gerada".
function etapaColuna(d: any): string {
  const e = normEtapa(d.etapa)
  if (e === 'CONCLUIDO' && d.tipo_operacao !== 'COMUNICADO_USO') return temOV(d) ? 'OV_GERADA' : 'PROCESSANDO'
  return e
}
const ehFinal = (d: any) => ETAPAS_FINAIS.includes(etapaColuna(d))
// Próxima ação do card conforme a etapa/tipo
function acaoDaEtapa(d: any): { kind: string; to?: string; label: string } | null {
  const e = etapaColuna(d)
  const licitacao = d.tipo_operacao !== 'COMUNICADO_USO'
  if (e === 'RECEBIDO') return { kind: 'avancar', to: 'PROCESSANDO', label: 'Avançar' }
  if (e === 'PROCESSANDO') return licitacao ? { kind: 'avancar', to: 'COTACAO_FRETE', label: 'Avançar' } : { kind: 'concluir', label: 'Concluir' }
  if (e === 'COTACAO_FRETE') {
    if (temOV(d)) return { kind: 'enviarNf', label: 'Enviar NF' }   // OV já existe (legado): pula geração
    return d.frete ? { kind: 'gerarOv', label: 'Gerar OV' } : { kind: 'frete', label: 'Cotar frete' }
  }
  if (e === 'OV_GERADA') return { kind: 'enviarNf', label: 'Enviar NF' }
  return null
}
const diasParado = (iso?: string) => iso ? Math.floor((Date.now() - new Date(iso).getTime()) / 86400000) : 0
const ovStatusLabel = (s?: string) => s ? (STATUS_CONFIG[s as keyof typeof STATUS_CONFIG]?.label || s) : ''

// Une itens da triagem (previsto) com os da OV (realizado) por produto, calculando o saldo.
function mesclarItens(triagem: any[], ov: any[]) {
  const mapa = new Map<string, { produto_id: string; codigo?: string; descricao?: string; triagem: number; ov: number; saldo: number }>()
  const chave = (it: any, i: number) => String(it.produto_id || it.codigo || i)
  triagem.forEach((it, i) => {
    const k = chave(it, i)
    mapa.set(k, { produto_id: it.produto_id, codigo: it.codigo, descricao: it.descricao, triagem: Number(it.qtd) || 0, ov: 0, saldo: 0 })
  })
  ov.forEach((it, i) => {
    const k = chave(it, i)
    const cur = mapa.get(k)
    if (cur) { cur.ov += Number(it.qtd) || 0; cur.codigo = cur.codigo || it.codigo; cur.descricao = cur.descricao || it.descricao }
    else mapa.set(k, { produto_id: it.produto_id, codigo: it.codigo, descricao: it.descricao, triagem: 0, ov: Number(it.qtd) || 0, saldo: 0 })
  })
  const linhas = Array.from(mapa.values())
  linhas.forEach(l => { l.saldo = Math.max(0, l.triagem - l.ov) })
  return linhas
}

const PRIO_CFG: Record<string, { label: string; cor: string }> = {
  CRITICA: { label: '🔴 Crítica', cor: 'bg-red-100 text-red-700' },
  ALTA: { label: '⚡ Alta', cor: 'bg-amber-100 text-amber-700' },
  NORMAL: { label: 'Normal', cor: 'bg-gray-100 text-gray-500' },
}

function prazoCor(prazo?: string | null): string {
  if (!prazo) return 'text-gray-400'
  const dias = Math.ceil((new Date(prazo + 'T12:00:00').getTime() - Date.now()) / 86400000)
  if (dias < 0) return 'text-red-600 font-semibold'
  if (dias <= 3) return 'text-amber-600 font-medium'
  return 'text-gray-500'
}

// ════════════════════════════════════════════════════════════════════════════════
export function Licitacoes() {
  const [aba, setAba] = useState<'painel' | 'contratos'>('painel')

  return (
    <div className="p-4 lg:p-6 max-w-[1400px] mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2"><Gavel size={20} /> Licitações</h1>
        <p className="text-sm text-gray-400">Triagem das demandas do dia e contratos (com saldo) de venda direta e consignação.</p>
      </div>

      <div className="flex gap-1 border-b">
        {([['painel', 'Painel de demandas', LayoutGrid], ['contratos', 'Contratos', Layers]] as const).map(([k, label, Icone]) => (
          <button key={k} onClick={() => setAba(k)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition ${
              aba === k ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            <Icone size={16} /> {label}
          </button>
        ))}
      </div>

      {aba === 'painel' ? <PainelDemandas /> : <AbaContratos />}
    </div>
  )
}

// ── Painel de demandas (triagem, sem arrastar) ───────────────────────────────────
function PainelDemandas() {
  const qc = useQueryClient()
  const [modalNovo, setModalNovo] = useState<TipoKey | null>(null)
  const [detalheId, setDetalheId] = useState<string | null>(null)
  const [concluirManual, setConcluirManual] = useState<any | null>(null)
  const [gerar, setGerar] = useState<any | null>(null)
  const [gerarOv, setGerarOv] = useState<any | null>(null)
  const [cotarFrete, setCotarFrete] = useState<any | null>(null)
  const [enviarNf, setEnviarNf] = useState<any | null>(null)
  const [historico, setHistorico] = useState(false)
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

  const porTipoEtapa = (tipo: string, etapa: string) => filtradas.filter(d => d.tipo_operacao === tipo && etapaColuna(d) === etapa)

  // Executa a ação primária do card conforme a etapa atual.
  const executarAcao = (d: any) => {
    const a = acaoDaEtapa(d)
    if (!a) return
    if (a.kind === 'avancar' && a.to) mover.mutate({ id: d.id, etapa: a.to })
    else if (a.kind === 'frete') setCotarFrete(d)
    else if (a.kind === 'gerarOv') setGerarOv({ demanda: d })
    else if (a.kind === 'enviarNf') setEnviarNf(d)
    else if (a.kind === 'concluir') setConcluirManual(d)
  }

  const pendentes = filtradas.filter(d => !ehFinal(d)).length

  return (
    <div className="space-y-4">
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
          <span className="text-xs text-gray-400 hidden lg:block">{pendentes} pendente(s)</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setHistorico(true)}
            className="flex items-center gap-1.5 text-gray-600 text-sm font-medium px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50">
            <Clock size={15} /> Histórico
          </button>
          {TIPOS.map(t => (
            <button key={t.key} onClick={() => setModalNovo(t.key)}
              className={`flex items-center gap-1.5 text-white text-sm font-medium px-3 py-2 rounded-lg ${t.header} hover:opacity-90`}>
              <Plus size={15} /> {t.label}
            </button>
          ))}
        </div>
      </div>

      <div className="bg-blue-50 border border-blue-100 rounded-lg px-3 py-2 text-xs text-blue-700">
        💡 Cada card anda pelas etapas com o botão da vez: D365 → <strong>Cotar frete</strong> → <strong>Gerar OV</strong> → <strong>Enviar NF</strong>. As finalizadas (NF enviada / concluídas) <strong>saem do painel no dia seguinte</strong> — consulte-as em <strong>Histórico</strong>.
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

                {!colaps && (() => {
                  const cols = etapasDoTipo(tipo.key)
                  return (
                    <div className="grid grid-cols-1 gap-px bg-gray-100" style={{ gridTemplateColumns: `repeat(${cols.length}, minmax(0, 1fr))` }}>
                      {cols.map(etapaKey => {
                        const cards = porTipoEtapa(tipo.key, etapaKey)
                        return (
                          <div key={etapaKey} className="bg-gray-50 min-h-[90px] p-2">
                            <div className="flex items-center justify-between mb-2 px-1">
                              <span className="text-[11px] font-semibold uppercase tracking-wide text-gray-500">{ETAPA_LABEL[etapaKey]}</span>
                              <span className="text-[11px] text-gray-400">{cards.length}</span>
                            </div>
                            <div className="space-y-2">
                              {cards.map(d => (
                                <CardDemanda key={d.id} d={d} tipo={tipo}
                                  onClick={() => setDetalheId(d.id)}
                                  onAcao={() => executarAcao(d)}
                                  onGerarOv={() => setGerarOv({ demanda: d })} />
                              ))}
                              {cards.length === 0 && (
                                <div className="text-[11px] text-gray-300 text-center py-3">—</div>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })()}
              </div>
            )
          })}
        </div>
      )}

      {modalNovo && <ModalNovaDemanda tipoInicial={modalNovo} onClose={() => setModalNovo(null)} onSaved={invalidar} />}
      {detalheId && (
        <ModalDetalheDemanda id={detalheId} onClose={() => setDetalheId(null)} onChanged={invalidar}
          onAcao={(d) => { setDetalheId(null); executarAcao(d) }}
          onGerar={(d) => { setDetalheId(null); setGerar(d) }}
          onGerarOv={(d) => { setDetalheId(null); setGerarOv({ demanda: d }) }}
          onCotarFrete={(d) => { setDetalheId(null); setCotarFrete(d) }} />
      )}
      {concluirManual && <ModalConcluirManual demanda={concluirManual} onClose={() => setConcluirManual(null)} onSaved={invalidar} />}
      {gerar && <ModalConcluir demanda={gerar} onClose={() => setGerar(null)} onSaved={invalidar} />}
      {gerarOv && <ModalGerarOVSaldo demanda={gerarOv.demanda} onClose={() => setGerarOv(null)} onSaved={invalidar} />}
      {cotarFrete && <ModalFrete demanda={cotarFrete} onClose={() => setCotarFrete(null)} onSaved={invalidar} />}
      {enviarNf && <ModalEnviarNF demanda={enviarNf} onClose={() => setEnviarNf(null)} onSaved={invalidar} />}
      {historico && <ModalHistorico onClose={() => setHistorico(false)} />}
    </div>
  )
}

function CardDemanda({ d, tipo, onClick, onAcao, onGerarOv }: {
  d: any; tipo: any; onClick: () => void; onAcao: () => void; onGerarOv?: () => void
}) {
  const prio = PRIO_CFG[d.prioridade] || PRIO_CFG.NORMAL
  const nItens = (d.itens || []).length
  const final = ehFinal(d)
  const etapaCol = etapaColuna(d)
  const parado = diasParado(d.criado_em)
  const refFeito = d.ref_externa || d.gerado_ref
  const acao = acaoDaEtapa(d)
  // Follow-up: OV já gerada e ainda sobra saldo (entrega parcial de venda direta).
  const temSaldoFollowup = d.tipo_operacao === 'VENDA_DIRETA' && etapaCol === 'OV_GERADA' && (d.ov_itens || []).length > 0 &&
    mesclarItens(d.itens || [], d.ov_itens).some(l => l.saldo > 0)
  const iconeAcao = acao?.kind === 'frete' ? <Truck size={11} /> : acao?.kind === 'gerarOv' ? <ShoppingCart size={11} />
    : acao?.kind === 'enviarNf' ? <Send size={11} /> : acao?.kind === 'concluir' ? <Flag size={11} /> : <Arrow size={11} />
  const acaoCor = acao?.kind === 'avancar' ? 'border text-gray-600 hover:bg-gray-50' : 'bg-blue-600 hover:bg-blue-500 text-white'
  return (
    <div className={`bg-white rounded-lg border border-gray-200 border-l-4 ${tipo.borda} shadow-sm p-2.5`}>
      <div onClick={onClick} className="cursor-pointer">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-gray-800 leading-tight line-clamp-2">{d.cliente || 'Cliente não informado'}</p>
          {d.prioridade !== 'NORMAL' && <span className={`text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${prio.cor}`}>{prio.label}</span>}
        </div>
        {d.numero && <p className="text-xs font-mono text-gray-500 mt-0.5">{d.numero}</p>}
        <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5 text-[11px]">
          {d.canal && <span className="text-gray-400">{CANAL_LABEL[d.canal] || d.canal}</span>}
          {nItens > 0 && <span className="text-gray-400">{nItens} item(ns)</span>}
          {d.prazo && <span className={`flex items-center gap-1 ${prazoCor(d.prazo)}`}><Clock size={11} /> {fmtData(d.prazo)}</span>}
          {!final && parado >= 2 && <span className={`flex items-center gap-1 ${parado >= 4 ? 'text-red-500 font-medium' : 'text-amber-500'}`}>⏳ há {parado}d</span>}
        </div>
        {d.frete && (d.frete.transportadora_nome || d.frete.valor) && (
          <p className="text-[11px] text-gray-400 mt-1 flex items-center gap-1"><Truck size={11} /> {d.frete.transportadora_nome || 'Frete'}{d.frete.valor ? ` · ${fmtBRL(d.frete.valor)}` : ''}</p>
        )}
        {d.ov_status && (
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            <span className="inline-flex items-center gap-1 text-[11px] bg-indigo-50 text-indigo-700 rounded-full px-2 py-0.5">
              🔗 {d.gerado_ref} · {ovStatusLabel(d.ov_status)}
            </span>
            {temSaldoFollowup && (
              <span className="inline-flex items-center gap-1 text-[11px] bg-amber-50 text-amber-700 rounded-full px-2 py-0.5">⚠️ saldo a faturar</span>
            )}
          </div>
        )}
        {d.nf && (d.nf.numero || d.nf.enviada_em) && (
          <p className="text-[11px] text-emerald-600 mt-1 flex items-center gap-1"><Send size={11} /> NF {d.nf.numero || ''} enviada{d.nf.enviada_em ? ` · ${fmtData(d.nf.enviada_em)}` : ''}</p>
        )}
      </div>
      {final ? (
        (!d.nf && refFeito) ? <p className="text-[11px] text-emerald-600 mt-2 flex items-center gap-1"><ExternalLink size={11} /> D365: {refFeito}</p> : null
      ) : (
        <div className="flex items-center gap-1.5 mt-2 pt-2 border-t border-gray-50">
          {temSaldoFollowup && onGerarOv && (
            <button onClick={(e) => { e.stopPropagation(); onGerarOv() }}
              className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-blue-200 text-blue-600 hover:bg-blue-50">
              <ShoppingCart size={11} /> OV do saldo
            </button>
          )}
          {acao && (
            <button onClick={(e) => { e.stopPropagation(); onAcao() }}
              className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-md ml-auto ${acaoCor}`}>
              {iconeAcao} {acao.label}
            </button>
          )}
        </div>
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
  const comValor = tipo !== 'COMUNICADO_USO'

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
          <Campo label={tipo === 'COMUNICADO_USO' ? 'Referência' : 'Nº do pregão / contrato'}>
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
          <label className="text-sm text-gray-600">
            Itens {tipo === 'COMUNICADO_USO' ? '(o que foi usado)' : '(quantidades TOTAIS do contrato, com valor)'}
          </label>
          <p className="text-xs text-gray-400 mb-1.5">
            {tipo === 'VENDA_DIRETA'
              ? 'Coloque o total ganho no pregão. As entregas parciais você lança depois, na aba Contratos.'
              : 'Opcional agora — pode completar ao processar.'}
          </p>
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
function ModalDetalheDemanda({ id, onClose, onChanged, onAcao, onGerar, onGerarOv, onCotarFrete }: {
  id: string; onClose: () => void; onChanged: () => void; onAcao: (d: any) => void; onGerar: (d: any) => void; onGerarOv: (d: any) => void; onCotarFrete: (d: any) => void
}) {
  const navigate = useNavigate()
  const qcDet = useQueryClient()
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
  const [ovNum, setOvNum] = useState('')
  const vincular = useMutation({
    mutationFn: () => api.post(`/licitacoes/demandas/${id}/vincular-ov`, { numero_pedido: ovNum.trim() }),
    onSuccess: () => { setOvNum(''); qcDet.invalidateQueries({ queryKey: ['demanda', id] }); onChanged(); toast.success('OV vinculada — o card vai espelhar o status dela') },
    onError: (e: any) => toast.error(msgErro(e, 'OV não encontrada'), { duration: 5000 }),
  })

  if (!d) return <ModalBase titulo="Demanda" onClose={onClose}><p className="p-8 text-center text-gray-400 text-sm">Carregando…</p></ModalBase>

  const cfg = TIPO_MAP[d.tipo_operacao] || TIPOS[0]
  const Icone = cfg.icone
  const etapaAtual = etapaColuna(d)
  const concluida = ehFinal(d)
  const acao = acaoDaEtapa(d)
  const temSaldoFollowup = d.tipo_operacao === 'VENDA_DIRETA' && etapaAtual === 'OV_GERADA' && (d.ov_itens || []).length > 0 &&
    mesclarItens(d.itens || [], d.ov_itens).some((l: any) => l.saldo > 0)

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

        {(d.itens || []).length > 0 && !d.ov_itens && (
          <div>
            <label className="text-xs font-medium text-gray-500">Itens ({d.itens.length})</label>
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

        {/* Comparativo triagem (previsto) × OVs (realizado) — mostra o saldo que ainda não saiu */}
        {d.ov_itens && (() => {
          const linhas = mesclarItens(d.itens || [], d.ov_itens || [])
          const temSaldo = linhas.some(l => l.saldo > 0)
          const ehVendaDireta = d.tipo_operacao === 'VENDA_DIRETA'
          return (
            <div>
              <label className="text-xs font-medium text-gray-500">Pedido (triagem) × OVs (faturado)</label>
              <div className="border border-gray-100 rounded-lg overflow-hidden mt-1">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-[11px] uppercase text-gray-400">
                      <th className="text-left font-medium px-3 py-1.5">Item</th>
                      <th className="text-right font-medium px-2 py-1.5">Pedido</th>
                      <th className="text-right font-medium px-2 py-1.5">OVs</th>
                      <th className="text-right font-medium px-3 py-1.5">Saldo</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {linhas.map((l, idx) => (
                      <tr key={idx}>
                        <td className="px-3 py-1.5"><span className="font-mono text-gray-700">{l.codigo || '—'}</span> <span className="text-gray-500 text-xs">{l.descricao}</span></td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-gray-600">{l.triagem}</td>
                        <td className="px-2 py-1.5 text-right tabular-nums text-indigo-600">{l.ov}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums font-semibold ${l.saldo > 0 ? 'text-amber-600' : 'text-emerald-600'}`}>{l.saldo}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {temSaldo ? (
                <div className="flex items-center justify-between gap-2 mt-1.5">
                  <p className="text-xs text-amber-600">⚠️ Entrega parcial — ainda há saldo a faturar.</p>
                  {ehVendaDireta && (
                    <button onClick={() => onGerarOv(d)}
                      className="flex items-center gap-1 text-xs bg-blue-600 hover:bg-blue-500 text-white px-3 py-1.5 rounded-lg whitespace-nowrap">
                      <Truck size={13} /> Gerar OV do saldo
                    </button>
                  )}
                </div>
              ) : <p className="text-xs text-emerald-600 mt-1.5">✔ As OVs cobriram todo o pedido.</p>}
            </div>
          )
        })()}

        {/* OVs vinculadas (espelham o status do fluxo logístico ao vivo) */}
        <div className="border border-indigo-100 bg-indigo-50/50 rounded-lg p-3 space-y-2">
          {(d.ovs_detalhe || []).length > 0 && (
            <div className="space-y-1.5">
              <p className="text-xs font-medium text-indigo-700">OV(s) no fluxo logístico</p>
              {d.ovs_detalhe.map((o: any) => (
                <div key={o.id} className="flex items-center justify-between gap-2">
                  <p className="text-sm text-indigo-800">🔗 {o.numero} · <span className="text-xs text-indigo-600">{ovStatusLabel(o.status)}</span></p>
                  <button onClick={() => o.id && navigate(`/expedicao/${o.id}`)}
                    className="flex items-center gap-1 text-xs bg-indigo-600 hover:bg-indigo-500 text-white px-2.5 py-1 rounded-lg">
                    <ExternalLink size={12} /> Abrir
                  </button>
                </div>
              ))}
            </div>
          )}
          <div>
            <p className="text-[11px] text-indigo-500 mb-1.5">Vincular outra OV já existente (o card espelha o status dela).</p>
            <div className="flex gap-2">
              <input value={ovNum} onChange={e => setOvNum(e.target.value.toUpperCase())} placeholder="Nº da OV (ex: OV015500)"
                className={`${inputCls} font-mono flex-1`} />
              <button onClick={() => vincular.mutate()} disabled={!ovNum.trim() || vincular.isPending}
                className="px-3 py-2 text-sm bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white rounded-lg whitespace-nowrap">
                {vincular.isPending ? 'Vinculando…' : 'Vincular'}
              </button>
            </div>
          </div>
        </div>

        {/* Frete (CIF sem valor) — cotar/editar a qualquer momento em VD/consignação */}
        {d.tipo_operacao !== 'COMUNICADO_USO' && (
          <div className="border border-gray-100 rounded-lg p-3 text-sm">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs font-medium text-gray-500 flex items-center gap-1"><Truck size={13} /> Frete cotado (CIF sem valor)</p>
              {!concluida && (
                <button onClick={() => onCotarFrete(d)} className="text-xs text-blue-600 hover:underline">
                  {d.frete && (d.frete.transportadora_nome || d.frete.valor) ? 'Editar' : 'Cotar frete'}
                </button>
              )}
            </div>
            {d.frete && (d.frete.transportadora_nome || d.frete.valor)
              ? <p className="text-gray-700 mt-1">{d.frete.transportadora_nome || '—'}{d.frete.valor ? ` · ${fmtBRL(d.frete.valor)}` : ''}{d.frete.prazo_dias ? ` · ${d.frete.prazo_dias} dia(s)` : ''}</p>
              : <p className="text-gray-400 mt-1">Ainda não cotado.</p>}
          </div>
        )}

        {d.nf && (
          <div className="border border-emerald-100 bg-emerald-50 rounded-lg p-3 text-sm">
            <p className="text-xs font-medium text-emerald-700 mb-1 flex items-center gap-1"><Send size={13} /> NF enviada ao cliente</p>
            <p className="text-emerald-800">NF {d.nf.numero || '—'}{d.nf.enviada_em ? ` · ${fmtData(d.nf.enviada_em)}` : ''}{d.nf.enviada_por ? ` · por ${d.nf.enviada_por}` : ''}</p>
          </div>
        )}

        {!concluida && (
          <div>
            <label className="text-xs font-medium text-gray-500">Mover para (manual)</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {(d.tipo_operacao === 'COMUNICADO_USO' ? ['RECEBIDO', 'PROCESSANDO'] : ['RECEBIDO', 'PROCESSANDO', 'COTACAO_FRETE']).map(k => (
                <button key={k} onClick={() => mover.mutate(k)}
                  className={`text-sm px-3 py-1.5 rounded-lg border ${etapaAtual === k ? 'bg-blue-600 text-white border-blue-600' : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
                  {ETAPA_LABEL[k]}
                </button>
              ))}
            </div>
          </div>
        )}

        {concluida && (
          <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3">
            <p className="text-sm text-emerald-700 font-medium">✅ {etapaAtual === 'NF_ENVIADA' ? 'NF enviada — ciclo fechado' : 'Concluída'}{(!d.nf && (d.ref_externa || d.gerado_ref)) ? ` — D365: ${d.ref_externa || d.gerado_ref}` : ''}</p>
            {d.gerado_tipo === 'COMUNICADO' && d.gerado_id && (
              <button onClick={() => navigate(`/expedicao/${d.gerado_id}`)}
                className="text-xs text-emerald-700 underline mt-1 flex items-center gap-1"><ExternalLink size={12} /> Abrir lançamento</button>
            )}
            <button onClick={() => mover.mutate('RECEBIDO')} className="text-xs text-gray-500 underline mt-2">Reabrir</button>
          </div>
        )}
      </div>

      <div className="p-4 border-t flex items-center justify-between gap-2">
        <button onClick={() => { if (confirm('Remover esta demanda do painel?')) excluir.mutate() }}
          className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-red-600"><Trash2 size={15} /> Remover</button>
        {!concluida && (
          <div className="flex gap-2">
            {d.tipo_operacao === 'COMUNICADO_USO' && (
              <button onClick={() => onGerar(d)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm border rounded-lg text-gray-600 hover:bg-gray-50" title="Cria o comunicado dentro do app (opcional)">
                Gerar registro
              </button>
            )}
            {temSaldoFollowup && (
              <button onClick={() => onGerarOv(d)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm border border-blue-200 text-blue-600 rounded-lg hover:bg-blue-50">
                <ShoppingCart size={16} /> OV do saldo
              </button>
            )}
            {acao && (
              <button onClick={() => onAcao(d)}
                className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white font-medium rounded-lg">
                {acao.label}
              </button>
            )}
          </div>
        )}
      </div>
    </ModalBase>
  )
}

// ── Modal: Concluir (só marcar feito, com o nº do doc do D365) ───────────────────
function ModalConcluirManual({ demanda, onClose, onSaved }: { demanda: any; onClose: () => void; onSaved: () => void }) {
  const [ref, setRef] = useState(demanda.ref_externa || '')
  const m = useMutation({
    mutationFn: () => api.patch(`/licitacoes/demandas/${demanda.id}`, { etapa: 'CONCLUIDO', ref_externa: ref.trim() || null }),
    onSuccess: () => { toast.success('Concluído! Continua no painel, na coluna Concluído.'); onSaved(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao concluir'), { duration: 5000 }),
  })
  return (
    <ModalBase titulo="Concluir demanda" onClose={onClose} max="max-w-md">
      <div className="p-5 space-y-3">
        <div className="bg-gray-50 rounded-lg p-3 text-sm">
          <p className="font-medium text-gray-700">{demanda.cliente}</p>
          <p className="text-xs text-gray-400">{TIPO_MAP[demanda.tipo_operacao]?.label}{demanda.numero ? ` · ${demanda.numero}` : ''}</p>
        </div>
        <Campo label="Nº do documento no D365 (opcional)">
          <input value={ref} onChange={e => setRef(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: OV015500 / NF 20045" autoFocus />
        </Campo>
        <p className="text-xs text-gray-400">Anote a OV/NF/lançamento gerado no D365 pra rastreabilidade. Pode deixar em branco e preencher depois.</p>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => m.mutate()} disabled={m.isPending}
          className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {m.isPending ? 'Concluindo…' : 'Marcar como concluído'}
        </button>
      </div>
    </ModalBase>
  )
}

// ── Modal: Processar (gera contrato ou comunicado) ───────────────────────────────
function ModalConcluir({ demanda, onClose, onSaved }: { demanda: any; onClose: () => void; onSaved: () => void }) {
  const cfg = TIPO_MAP[demanda.tipo_operacao] || TIPOS[0]
  const hoje = new Date().toISOString().slice(0, 10)
  const tipo: TipoKey = demanda.tipo_operacao

  const [numero, setNumero] = useState(demanda.numero || '')
  const [canal, setCanal] = useState(demanda.canal || '')
  const [dataEmpenho, setDataEmpenho] = useState(hoje)
  const [vigencia, setVigencia] = useState(demanda.prazo || '')
  const [nf, setNf] = useState('')
  const [valorNf, setValorNf] = useState('')
  const [dataFat, setDataFat] = useState(hoje)
  const [empenhoId, setEmpenhoId] = useState('')
  const [itens, setItens] = useState<ItemLinha[]>(
    (demanda.itens || []).filter((i: any) => i.produto_id).map((i: any) => ({
      produto_id: i.produto_id, codigo: i.codigo || '', descricao: i.descricao || '',
      qtd: Number(i.qtd) || 0, valor: Number(i.valor) || 0,
    }))
  )

  const ehContrato = tipo === 'VENDA_DIRETA' || tipo === 'CONSIGNACAO'

  const { data: empenhos = [] } = useQuery<any[]>({
    queryKey: ['empenhos'],
    queryFn: () => api.get('/licitacoes/empenhos').then(r => r.data),
    enabled: tipo === 'COMUNICADO_USO',
  })
  const empenhosCliente = empenhos.filter(e => e.cliente_id === demanda.cliente_id && e.saldo_un > 0 && (e.tipo || 'CONSIGNACAO') === 'CONSIGNACAO')

  const concluir = useMutation({
    mutationFn: () => {
      const body: any = {
        canal: canal || null,
        itens: itens.map(i => ({ produto_id: i.produto_id, codigo: i.codigo, descricao: i.descricao, qtd: i.qtd, valor: i.valor || 0 })),
      }
      if (ehContrato) {
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
    onSuccess: () => {
      toast.success(ehContrato ? 'Contrato criado — lance as entregas na aba Contratos' : 'Comunicado de uso lançado')
      onSaved(); onClose()
    },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao processar'), { duration: 6000 }),
  })

  const itensOk = itens.length > 0 && itens.every(i => i.qtd > 0)
  let valido = false
  if (ehContrato) valido = !!numero.trim() && itensOk
  else valido = !!numero.trim() && !!nf.trim() && Number(valorNf) > 0 && itensOk

  return (
    <ModalBase titulo={<span className="flex items-center gap-2"><Flag size={17} /> Processar · {cfg.label}</span>} onClose={onClose}>
      <div className="p-5 space-y-3 overflow-y-auto">
        <div className="bg-gray-50 rounded-lg p-3 text-sm">
          <p className="font-medium text-gray-700">{demanda.cliente}</p>
          <p className="text-xs text-gray-400">
            {ehContrato
              ? 'Cria o contrato com as quantidades totais. As entregas/consumos baixam o saldo depois.'
              : 'Lança o faturamento do material consignado usado.'}
          </p>
        </div>

        {ehContrato && (
          <div className="grid grid-cols-2 gap-3">
            <Campo label={tipo === 'VENDA_DIRETA' ? 'Nº do contrato/pregão *' : 'Nº do empenho *'}>
              <input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: PE 042/2026" />
            </Campo>
            <Campo label="Canal">
              <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
                <option value="">A definir…</option>
                {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
              </select>
            </Campo>
            <Campo label="Data"><input type="date" value={dataEmpenho} onChange={e => setDataEmpenho(e.target.value)} className={inputCls} /></Campo>
            <Campo label="Vigência (até)"><input type="date" value={vigencia} onChange={e => setVigencia(e.target.value)} className={inputCls} /></Campo>
          </div>
        )}

        {tipo === 'COMUNICADO_USO' && (
          <>
            {empenhosCliente.length > 0 && (
              <Campo label="Baixar de um contrato de consignação (opcional)">
                <select value={empenhoId} onChange={e => setEmpenhoId(e.target.value)} className={inputCls}>
                  <option value="">Comunicado avulso (sem contrato)</option>
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
          <label className="text-sm text-gray-600">
            Itens {ehContrato ? '(totais do contrato, com valor) *' : '(o que foi usado) *'}
          </label>
          <ItensPedido value={itens} onChange={setItens} comValor={ehContrato} />
        </div>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => concluir.mutate()} disabled={!valido || concluir.isPending}
          className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {concluir.isPending ? 'Processando…' : ehContrato ? 'Criar contrato' : 'Lançar comunicado'}
        </button>
      </div>
    </ModalBase>
  )
}

// ════════════════════════════════════════════════════════════════════════════════
// ── Aba Contratos (venda direta + consignação, com saldo) ────────────────────────
function AbaContratos() {
  const qc = useQueryClient()
  const [modalNovo, setModalNovo] = useState(false)
  const [abertoId, setAbertoId] = useState<string | null>(null)
  const [tipoFiltro, setTipoFiltro] = useState('')

  const { data: contratos = [], isLoading } = useQuery<any[]>({
    queryKey: ['empenhos'],
    queryFn: () => api.get('/licitacoes/empenhos').then(r => r.data),
  })

  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ['empenhos'] })
    if (abertoId) qc.invalidateQueries({ queryKey: ['empenho', abertoId] })
  }

  const filtrados = tipoFiltro ? contratos.filter(c => (c.tipo || 'CONSIGNACAO') === tipoFiltro) : contratos

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          <button onClick={() => setTipoFiltro('')} className={`text-sm px-3 py-1.5 rounded-lg ${!tipoFiltro ? 'bg-blue-600 text-white' : 'bg-white border text-gray-600'}`}>Todos</button>
          {Object.entries(CONTRATO_TIPO).map(([k, v]) => (
            <button key={k} onClick={() => setTipoFiltro(k)} className={`text-sm px-3 py-1.5 rounded-lg ${tipoFiltro === k ? 'bg-blue-600 text-white' : 'bg-white border text-gray-600'}`}>{v.label}</button>
          ))}
        </div>
        <button onClick={() => setModalNovo(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg">
          <Plus size={16} /> Novo contrato
        </button>
      </div>

      {isLoading ? (
        <p className="text-center text-gray-400 py-10 text-sm">Carregando...</p>
      ) : filtrados.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-10 text-center text-gray-400 text-sm">
          Nenhum contrato. Clique em <strong>Novo contrato</strong> (ou processe uma venda direta/consignação no painel).
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {filtrados.map((e) => {
            const cfg = STATUS_CFG[e.status] || STATUS_CFG.ABERTO
            const tp = CONTRATO_TIPO[e.tipo || 'CONSIGNACAO'] || CONTRATO_TIPO.CONSIGNACAO
            const risco = vigenciaEmRisco(e.vigencia, e.saldo_un)
            return (
              <button key={e.id} onClick={() => setAbertoId(e.id)}
                className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 text-left hover:border-blue-300 hover:shadow transition">
                <div className="flex items-start justify-between mb-1">
                  <div>
                    <p className="font-mono font-bold text-gray-800">{e.numero}</p>
                    <p className="text-sm text-gray-600 truncate max-w-[240px]">{e.cliente}</p>
                    <div className="flex items-center gap-2 mt-1">
                      <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${tp.cor}`}>{tp.label}</span>
                      {e.canal && <span className="text-xs text-gray-400">{CANAL_LABEL[e.canal] || e.canal}</span>}
                    </div>
                  </div>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.cor}`}>{cfg.label}</span>
                </div>
                <div className="h-2 rounded-full bg-gray-100 overflow-hidden my-2">
                  <div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${Math.min(e.percentual, 100)}%` }} />
                </div>
                <div className="flex justify-between text-xs text-gray-500">
                  <span>{e.tipo === 'VENDA_DIRETA' ? 'Entregue' : 'Faturado'} {fmtBRL(e.faturado_valor)} · {e.percentual}%</span>
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

      {modalNovo && <ModalNovoContrato onClose={() => setModalNovo(false)} onSaved={invalidar} />}
      {abertoId && <ModalContrato id={abertoId} onClose={() => setAbertoId(null)} onChanged={invalidar} />}
    </div>
  )
}

function ModalNovoContrato({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const hoje = new Date().toISOString().slice(0, 10)
  const [tipo, setTipo] = useState<'VENDA_DIRETA' | 'CONSIGNACAO'>('VENDA_DIRETA')
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
      numero: numero.trim(), cliente_id: clienteId, tipo, canal,
      data_empenho: dataEmpenho || null, vigencia: vigencia || null, observacao: observacao || null,
      itens: itens.map(i => ({ produto_id: i.produto_id, qtd_empenhada: i.qtd, valor_unitario: i.valor || 0 })),
    }),
    onSuccess: () => { toast.success('Contrato cadastrado'); onSaved(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao cadastrar')),
  })

  const valido = numero.trim() && clienteId && itens.length > 0

  return (
    <ModalBase titulo="Novo contrato de licitação" onClose={onClose}>
      <div className="p-5 space-y-3 overflow-y-auto">
        <div className="grid grid-cols-2 gap-2">
          {(['VENDA_DIRETA', 'CONSIGNACAO'] as const).map(k => {
            const v = CONTRATO_TIPO[k]; const Icone = v.icone; const ativo = tipo === k
            return (
              <button key={k} onClick={() => setTipo(k)}
                className={`flex items-center justify-center gap-2 py-2.5 rounded-lg border-2 text-sm font-medium ${ativo ? `${v.cor} border-current` : 'border-gray-200 text-gray-500'}`}>
                <Icone size={16} /> {v.label}
              </button>
            )
          })}
        </div>
        <p className="text-[11px] text-gray-400 -mt-1">
          {tipo === 'VENDA_DIRETA'
            ? 'Contrato de pregão ganho. As entregas parciais geram OVs que baixam o saldo.'
            : 'Material consignado. O comunicado de uso baixa o saldo conforme o cliente usa.'}
        </p>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Número do contrato *"><input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: PE 042/2026" /></Campo>
          <Campo label="Data"><input type="date" value={dataEmpenho} onChange={e => setDataEmpenho(e.target.value)} className={inputCls} /></Campo>
        </div>
        <Campo label="Cliente / Órgão *">
          <ClienteAutocomplete value={clienteId} onChange={(id, nome) => { setClienteId(id); setClienteNome(nome) }} />
          {clienteId && <p className="text-xs text-green-600 mt-1">✅ {clienteNome}</p>}
        </Campo>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Canal *">
            <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
              {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
            </select>
          </Campo>
          <Campo label="Vigência (até)"><input type="date" value={vigencia} onChange={e => setVigencia(e.target.value)} className={inputCls} /></Campo>
        </div>
        <Campo label="Observação"><input value={observacao} onChange={e => setObservacao(e.target.value)} className={inputCls} placeholder="Opcional" /></Campo>
        <div>
          <label className="text-sm text-gray-600">Itens do contrato *</label>
          <p className="text-xs text-gray-400 mb-1.5">Produto, quantidade TOTAL e valor unitário.</p>
          <ItensPedido value={itens} onChange={setItens} comValor />
        </div>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => criar.mutate()} disabled={!valido || criar.isPending}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {criar.isPending ? 'Salvando...' : 'Cadastrar contrato'}
        </button>
      </div>
    </ModalBase>
  )
}

function ModalContrato({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient()
  const [acao, setAcao] = useState<'consumo' | 'entrega' | null>(null)
  const { data: emp } = useQuery<any>({
    queryKey: ['empenho', id],
    queryFn: () => api.get(`/licitacoes/empenhos/${id}`).then(r => r.data),
  })

  const excluir = useMutation({
    mutationFn: () => api.delete(`/licitacoes/empenhos/${id}`),
    onSuccess: () => { toast.success('Contrato excluído'); onChanged(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao excluir')),
  })

  if (!emp) {
    return <ModalBase titulo="Contrato" onClose={onClose}><p className="p-8 text-center text-gray-400 text-sm">Carregando...</p></ModalBase>
  }

  const cfg = STATUS_CFG[emp.status] || STATUS_CFG.ABERTO
  const tp = CONTRATO_TIPO[emp.tipo || 'CONSIGNACAO'] || CONTRATO_TIPO.CONSIGNACAO
  const ehVendaDireta = (emp.tipo || 'CONSIGNACAO') === 'VENDA_DIRETA'

  return (
    <ModalBase titulo={<span className="flex items-center gap-2 font-mono">{emp.numero} <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.cor}`}>{cfg.label}</span></span>} onClose={onClose} max="max-w-3xl">
      <div className="flex-1 overflow-y-auto">
        <div className="px-5 py-4 bg-gray-50 border-b">
          <div className="flex items-center gap-2">
            <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${tp.cor}`}>{tp.label}</span>
            <p className="text-sm text-gray-700 font-medium">{emp.cliente}</p>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            {emp.canal && <>Canal: {CANAL_LABEL[emp.canal] || emp.canal} · </>}
            {fmtData(emp.data_empenho)} · Vigência {fmtData(emp.vigencia)}
          </p>
          <div className="grid grid-cols-3 gap-3 mt-3">
            <div><p className="text-[11px] text-gray-400 uppercase">Total</p><p className="text-base font-bold text-gray-800">{fmtBRL(emp.empenhado_valor)}</p></div>
            <div><p className="text-[11px] text-gray-400 uppercase">{ehVendaDireta ? 'Entregue' : 'Faturado'}</p><p className="text-base font-bold text-emerald-600">{fmtBRL(emp.faturado_valor)}</p></div>
            <div><p className="text-[11px] text-gray-400 uppercase">Saldo</p><p className="text-base font-bold text-blue-600">{fmtBRL(emp.saldo_valor)}</p></div>
          </div>
          <div className="h-2 rounded-full bg-gray-200 overflow-hidden mt-2">
            <div className="h-full rounded-full bg-emerald-500" style={{ width: `${Math.min(emp.percentual, 100)}%` }} />
          </div>
          <p className="text-[11px] text-gray-400 mt-1">{emp.percentual}% {ehVendaDireta ? 'entregue' : 'consumido'}</p>
        </div>

        <div className="p-5">
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Itens · saldo por produto</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead><tr className="text-left text-gray-500 border-b">
                <th className="pb-2 pr-3">Código</th><th className="pb-2 pr-3">Descrição</th>
                <th className="pb-2 pr-3 text-right">Total</th><th className="pb-2 pr-3 text-right">{ehVendaDireta ? 'Entregue' : 'Faturado'}</th>
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
          <h3 className="text-sm font-semibold text-gray-700 mb-2">
            {ehVendaDireta ? 'Entregas (OVs)' : 'Comunicados de uso'} lançados ({emp.consumos.length})
          </h3>
          {emp.consumos.length === 0 ? (
            <p className="text-xs text-gray-400">Nenhum lançamento ainda.</p>
          ) : (
            <div className="border border-gray-100 rounded-lg divide-y divide-gray-50">
              {emp.consumos.map((c: any) => (
                <div key={c.id} className="flex justify-between px-3 py-2 text-sm">
                  <span className="font-mono text-gray-700">{c.numero_pedido}</span>
                  <span className="text-gray-500">{c.numero_nf ? `NF ${c.numero_nf} · ` : ''}{fmtData(c.data)}</span>
                  <span className="font-medium text-gray-700">{c.valor_nf ? fmtBRL(c.valor_nf) : '—'}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="p-4 border-t flex items-center justify-between">
        <button onClick={() => { if (confirm('Excluir este contrato? (só se não houver lançamentos)')) excluir.mutate() }}
          className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-red-600">
          <Trash2 size={15} /> Excluir
        </button>
        {ehVendaDireta ? (
          <button onClick={() => setAcao('entrega')} disabled={emp.saldo_un <= 0}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white font-medium rounded-lg">
            <Truck size={16} /> Registrar entrega (gera OV)
          </button>
        ) : (
          <button onClick={() => setAcao('consumo')} disabled={emp.saldo_un <= 0}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-medium rounded-lg">
            <FileText size={16} /> Registrar comunicado de uso
          </button>
        )}
      </div>

      {acao === 'consumo' && <ModalConsumo emp={emp} onClose={() => setAcao(null)} onSaved={() => { qc.invalidateQueries({ queryKey: ['empenho', id] }); onChanged() }} />}
      {acao === 'entrega' && <ModalEntrega emp={emp} onClose={() => setAcao(null)} onSaved={() => { qc.invalidateQueries({ queryKey: ['empenho', id] }); onChanged() }} />}
    </ModalBase>
  )
}

// ── Gerar OV de uma venda direta / consignação (a partir da demanda) ─────────────
function ModalGerarOVSaldo({ demanda, onClose, onSaved }: { demanda: any; onClose: () => void; onSaved: () => void }) {
  const navigate = useNavigate()
  const hoje = new Date().toISOString().slice(0, 10)
  const saldoLinhas = mesclarItens(demanda.itens || [], demanda.ov_itens || []).filter(l => l.saldo > 0)
  const consignacao = demanda.tipo_operacao === 'CONSIGNACAO'
  const frete = demanda.frete || {}
  const [numero, setNumero] = useState('')
  const [tipoFrete, setTipoFrete] = useState(frete.tipo_frete || 'CIF_SEM_VALOR')
  const [canal, setCanal] = useState(demanda.canal || '')
  const [dataEntrega, setDataEntrega] = useState('')
  const [local, setLocal] = useState('')
  const [qtds, setQtds] = useState<Record<string, string>>(
    () => Object.fromEntries(saldoLinhas.map(l => [l.produto_id, String(l.saldo)])))

  const gerar = useMutation({
    mutationFn: () => api.post(`/licitacoes/demandas/${demanda.id}/gerar-ov`, {
      numero_pedido: numero.trim(),
      tipo_frete: tipoFrete,
      canal: canal || null,
      data_prevista_entrega: dataEntrega || null,
      local_entrega: local || null,
      transportadora_id: frete.transportadora_id || null,
      valor_frete: frete.valor ?? null,
      itens: saldoLinhas.filter(l => Number(qtds[l.produto_id]) > 0)
        .map(l => ({ produto_id: l.produto_id, qtd_solicitada: Number(qtds[l.produto_id]) })),
    }),
    onSuccess: (res) => {
      toast.success('OV gerada no fluxo logístico')
      onSaved(); onClose()
      const ov = res.data?.ov_gerada_id
      if (ov) setTimeout(() => navigate(`/expedicao/${ov}`), 300)
    },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao gerar OV'), { duration: 6000 }),
  })

  const algum = saldoLinhas.some(l => Number(qtds[l.produto_id]) > 0)
  const valido = numero.trim() && dataEntrega && algum

  return (
    <ModalBase titulo={`Gerar OV · ${demanda.cliente || ''}`} onClose={onClose}>
      <div className="p-5 space-y-3 overflow-y-auto">
        <div className="bg-blue-50 rounded-lg p-2.5 text-xs text-blue-700">
          Gera a <strong>OV</strong> {consignacao ? 'de consignação (não fatura até o comunicado de uso)' : 'de venda'} no fluxo logístico com estas quantidades.
        </div>
        {(frete.transportadora_nome || frete.valor) && (
          <div className="bg-gray-50 rounded-lg p-2.5 text-xs text-gray-600 flex items-center gap-1.5">
            <Truck size={13} /> Frete cotado vai para a OV: <strong>{frete.transportadora_nome || 'transportadora'}</strong>{frete.valor ? ` · ${fmtBRL(frete.valor)}` : ''}
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Número da OV *"><input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: OV015500" /></Campo>
          <Campo label="Data prevista de entrega *"><input type="date" value={dataEntrega} min={hoje} onChange={e => setDataEntrega(e.target.value)} className={inputCls} /></Campo>
          <Campo label="Tipo de frete">
            <select value={tipoFrete} onChange={e => setTipoFrete(e.target.value)} className={inputCls}>
              <option value="FOB">FOB</option><option value="CIF_COM_VALOR">CIF com Valor NF</option><option value="CIF_SEM_VALOR">CIF sem Valor NF</option>
            </select>
          </Campo>
          <Campo label="Canal">
            <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
              <option value="">A definir…</option>
              {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
            </select>
          </Campo>
        </div>
        <Campo label="Local de entrega"><input value={local} onChange={e => setLocal(e.target.value)} className={inputCls} placeholder="Opcional" /></Campo>
        <div>
          <label className="text-sm text-gray-600">Quantidades desta OV *</label>
          <p className="text-xs text-gray-400 mb-1.5">Pré-preenchido com o saldo — ajuste se a entrega for menor.</p>
          <div className="border border-gray-100 rounded-lg divide-y divide-gray-50">
            {saldoLinhas.length === 0 ? (
              <p className="px-3 py-3 text-xs text-gray-400">Sem saldo a faturar nesta demanda.</p>
            ) : saldoLinhas.map(l => (
              <div key={l.produto_id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <div className="flex-1 min-w-0">
                  <span className="font-mono font-medium text-gray-800">{l.codigo}</span>
                  <span className="text-gray-500 ml-2">{l.descricao}</span>
                  <span className="block text-[11px] text-gray-400">saldo {l.saldo}</span>
                </div>
                <input type="number" min="0" max={l.saldo} step="1"
                  value={qtds[l.produto_id] || ''}
                  onChange={e => setQtds(q => ({ ...q, [l.produto_id]: e.target.value }))}
                  placeholder="0" className="w-24 border rounded-lg px-2 py-1 text-sm text-right" />
              </div>
            ))}
          </div>
        </div>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => gerar.mutate()} disabled={!valido || gerar.isPending}
          className="px-4 py-2 text-sm disabled:opacity-50 text-white font-medium rounded-lg bg-blue-600 hover:bg-blue-500">
          {gerar.isPending ? 'Gerando OV...' : 'Gerar OV'}
        </button>
      </div>
    </ModalBase>
  )
}

// ── Histórico de demandas concluídas (por dia) ───────────────────────────────────
function ModalHistorico({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate()
  const { data: datas = [] } = useQuery<any[]>({
    queryKey: ['demandas-historico-datas'],
    queryFn: () => api.get('/licitacoes/demandas/historico/datas').then(r => r.data),
  })
  const [sel, setSel] = useState('')
  useEffect(() => { if (!sel && datas.length) setSel(datas[0].data) }, [datas, sel])

  const { data: itens = [], isLoading } = useQuery<any[]>({
    queryKey: ['demandas-historico', sel],
    queryFn: () => api.get(`/licitacoes/demandas/historico?data=${sel}`).then(r => r.data),
    enabled: !!sel,
  })

  return (
    <ModalBase titulo="Histórico de concluídas" onClose={onClose}>
      <div className="p-5 space-y-3 overflow-y-auto">
        {datas.length === 0 ? (
          <p className="text-sm text-gray-400 text-center py-6">Nenhuma demanda concluída ainda.</p>
        ) : (
          <>
            <Campo label="Dia">
              <select value={sel} onChange={e => setSel(e.target.value)} className={inputCls}>
                {datas.map((d: any) => <option key={d.data} value={d.data}>{fmtData(d.data)} · {d.total} concluída(s)</option>)}
              </select>
            </Campo>
            {isLoading ? (
              <p className="text-sm text-gray-400 text-center py-4">Carregando…</p>
            ) : (
              <div className="space-y-2">
                {itens.map((d: any) => {
                  const cfg = TIPO_MAP[d.tipo_operacao] || TIPOS[0]
                  const Icone = cfg.icone
                  const ref = d.ref_externa || d.gerado_ref
                  return (
                    <div key={d.id} className={`bg-white rounded-lg border border-gray-200 border-l-4 ${cfg.borda} p-2.5`}>
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="text-sm font-medium text-gray-800 flex items-center gap-1.5"><Icone size={14} /> {d.cliente || 'Cliente não informado'}</p>
                          <div className="flex flex-wrap gap-x-3 text-[11px] text-gray-400 mt-0.5">
                            {d.numero && <span className="font-mono">{d.numero}</span>}
                            {d.canal && <span>{CANAL_LABEL[d.canal] || d.canal}</span>}
                            {ref && <span className="text-emerald-600">D365: {ref}</span>}
                          </div>
                        </div>
                        {(d.ovs_detalhe || []).length > 0 && (
                          <button onClick={() => navigate(`/expedicao/${d.ovs_detalhe[0].id}`)}
                            className="flex items-center gap-1 text-xs text-indigo-600 hover:underline whitespace-nowrap">
                            <ExternalLink size={12} /> OV
                          </button>
                        )}
                      </div>
                    </div>
                  )
                })}
                {itens.length === 0 && <p className="text-sm text-gray-400 text-center py-4">Sem concluídas neste dia.</p>}
              </div>
            )}
          </>
        )}
      </div>
      <div className="p-4 border-t flex justify-end">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Fechar</button>
      </div>
    </ModalBase>
  )
}

// ── Cotação de frete (CIF sem valor) — vai para a OV ao gerar ────────────────────
function ModalFrete({ demanda, onClose, onSaved }: { demanda: any; onClose: () => void; onSaved: () => void }) {
  const { data: transportadoras = [] } = useQuery<any[]>({
    queryKey: ['transportadoras'],
    queryFn: () => api.get('/transportadoras').then(r => r.data),
  })
  const f = demanda.frete || {}
  const [transpId, setTranspId] = useState(f.transportadora_id || '')
  const [valor, setValor] = useState(f.valor != null ? String(f.valor) : '')
  const [prazo, setPrazo] = useState(f.prazo_dias != null ? String(f.prazo_dias) : '')
  const [obs, setObs] = useState(f.observacao || '')

  const salvar = useMutation({
    mutationFn: () => {
      const t = transportadoras.find((x: any) => x.id === transpId)
      return api.post(`/licitacoes/demandas/${demanda.id}/frete`, {
        transportadora_id: transpId || null,
        transportadora_nome: t?.nome || null,
        valor: valor ? Number(valor) : null,
        prazo_dias: prazo ? Number(prazo) : null,
        tipo_frete: 'CIF_SEM_VALOR',
        observacao: obs || null,
      })
    },
    onSuccess: () => { toast.success('Frete cotado — vai para a OV ao gerar'); onSaved(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao salvar frete')),
  })
  const valido = !!transpId || !!valor

  return (
    <ModalBase titulo={`Cotação de frete · ${demanda.cliente || ''}`} onClose={onClose} max="max-w-md">
      <div className="p-5 space-y-3">
        <div className="bg-blue-50 rounded-lg p-2.5 text-xs text-blue-700">
          Licitação é <strong>CIF sem valor</strong>. A transportadora e o valor cotados <strong>vão para a OV</strong> ao gerá-la (sem redigitar).
        </div>
        <Campo label="Transportadora">
          <select value={transpId} onChange={e => setTranspId(e.target.value)} className={inputCls}>
            <option value="">Selecione…</option>
            {transportadoras.map((t: any) => <option key={t.id} value={t.id}>{t.nome}</option>)}
          </select>
        </Campo>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Valor do frete (R$)"><input type="number" step="0.01" value={valor} onChange={e => setValor(e.target.value)} className={inputCls} placeholder="0,00" /></Campo>
          <Campo label="Prazo (dias)"><input type="number" value={prazo} onChange={e => setPrazo(e.target.value)} className={inputCls} placeholder="Ex: 5" /></Campo>
        </div>
        <Campo label="Observação"><input value={obs} onChange={e => setObs(e.target.value)} className={inputCls} placeholder="Opcional" /></Campo>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => salvar.mutate()} disabled={!valido || salvar.isPending}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {salvar.isPending ? 'Salvando…' : 'Salvar frete'}
        </button>
      </div>
    </ModalBase>
  )
}

// ── Enviar NF ao cliente (fechamento) ────────────────────────────────────────────
function ModalEnviarNF({ demanda, onClose, onSaved }: { demanda: any; onClose: () => void; onSaved: () => void }) {
  const hoje = new Date().toISOString().slice(0, 10)
  const [numero, setNumero] = useState(demanda.nf?.numero || '')
  const [data, setData] = useState(demanda.nf?.enviada_em || hoje)
  const [obs, setObs] = useState('')

  const salvar = useMutation({
    mutationFn: () => api.post(`/licitacoes/demandas/${demanda.id}/enviar-nf`, {
      numero: numero.trim() || null,
      enviada_em: data || null,
      observacao: obs || null,
    }),
    onSuccess: () => { toast.success('NF marcada como enviada — ciclo fechado'); onSaved(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao registrar envio da NF')),
  })

  return (
    <ModalBase titulo={`Enviar NF ao cliente · ${demanda.cliente || ''}`} onClose={onClose} max="max-w-md">
      <div className="p-5 space-y-3">
        <div className="bg-emerald-50 rounded-lg p-2.5 text-xs text-emerald-700">
          Registra que a <strong>NF foi enviada ao cliente</strong> — último passo. A demanda vai para <strong>NF enviada</strong> e sai do painel amanhã (fica no histórico).
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Número da NF"><input value={numero} onChange={e => setNumero(e.target.value)} className={`${inputCls} font-mono`} placeholder="Ex: 20045" /></Campo>
          <Campo label="Enviada em"><input type="date" value={data} onChange={e => setData(e.target.value)} className={inputCls} /></Campo>
        </div>
        <Campo label="Observação"><input value={obs} onChange={e => setObs(e.target.value)} className={inputCls} placeholder="Ex: enviada por e-mail ao setor de compras" /></Campo>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => salvar.mutate()} disabled={salvar.isPending}
          className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {salvar.isPending ? 'Registrando…' : 'Marcar NF enviada'}
        </button>
      </div>
    </ModalBase>
  )
}

// ── Entrega parcial de venda direta (gera OV) ────────────────────────────────────
function ModalEntrega({ emp, onClose, onSaved }: { emp: any; onClose: () => void; onSaved: () => void }) {
  const navigate = useNavigate()
  const hoje = new Date().toISOString().slice(0, 10)
  const comSaldo = emp.itens.filter((i: any) => i.qtd_saldo > 0)
  const [numero, setNumero] = useState('')
  const [tipoFrete, setTipoFrete] = useState('FOB')
  const [canal, setCanal] = useState(emp.canal || '')
  const [dataEntrega, setDataEntrega] = useState('')
  const [local, setLocal] = useState('')
  const [qtds, setQtds] = useState<Record<string, string>>({})

  const registrar = useMutation({
    mutationFn: () => api.post(`/licitacoes/empenhos/${emp.id}/entrega`, {
      numero_pedido: numero.trim(),
      tipo_frete: tipoFrete,
      canal: canal || null,
      data_prevista_entrega: dataEntrega || null,
      local_entrega: local || null,
      itens: comSaldo
        .filter((i: any) => Number(qtds[i.produto_id]) > 0)
        .map((i: any) => ({ produto_id: i.produto_id, qtd_solicitada: Number(qtds[i.produto_id]) })),
    }),
    onSuccess: (res) => {
      toast.success('Entrega registrada — OV criada e saldo atualizado')
      onSaved(); onClose()
      const ov = res.data?.ov_gerada_id
      if (ov) setTimeout(() => navigate(`/expedicao/${ov}`), 300)
    },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao registrar entrega'), { duration: 6000 }),
  })

  const algumItem = comSaldo.some((i: any) => Number(qtds[i.produto_id]) > 0)
  const valido = numero.trim() && dataEntrega && algumItem

  return (
    <ModalBase titulo={`Entrega parcial · ${emp.numero}`} onClose={onClose}>
      <div className="p-5 space-y-3 overflow-y-auto">
        <div className="bg-blue-50 rounded-lg p-2.5 text-xs text-blue-700">
          Gera uma <strong>OV</strong> no fluxo logístico com as quantidades desta entrega e baixa o saldo do contrato.
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Número da OV *"><input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: OV015500" /></Campo>
          <Campo label="Data prevista de entrega *"><input type="date" value={dataEntrega} min={hoje} onChange={e => setDataEntrega(e.target.value)} className={inputCls} /></Campo>
          <Campo label="Tipo de frete">
            <select value={tipoFrete} onChange={e => setTipoFrete(e.target.value)} className={inputCls}>
              <option value="FOB">FOB</option><option value="CIF_COM_VALOR">CIF com Valor NF</option><option value="CIF_SEM_VALOR">CIF sem Valor NF</option>
            </select>
          </Campo>
          <Campo label="Canal">
            <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
              <option value="">A definir…</option>
              {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
            </select>
          </Campo>
        </div>
        <Campo label="Local de entrega"><input value={local} onChange={e => setLocal(e.target.value)} className={inputCls} placeholder="Opcional" /></Campo>
        <div>
          <label className="text-sm text-gray-600">Quantidades desta entrega *</label>
          <p className="text-xs text-gray-400 mb-1.5">Informe quanto entregar de cada item (limitado ao saldo).</p>
          <div className="border border-gray-100 rounded-lg divide-y divide-gray-50">
            {comSaldo.length === 0 ? (
              <p className="px-3 py-3 text-xs text-gray-400">Sem saldo disponível neste contrato.</p>
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
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {registrar.isPending ? 'Gerando OV...' : 'Registrar entrega'}
        </button>
      </div>
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
              <p className="px-3 py-3 text-xs text-gray-400">Sem saldo disponível neste contrato.</p>
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

// ── Base ─────────────────────────────────────────────────────────────────────────
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

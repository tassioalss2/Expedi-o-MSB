import { useState, useMemo, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus, X, Gavel, FileText, AlertTriangle, Trash2, ShoppingCart, Boxes,
  LayoutGrid, Layers, ChevronDown, ChevronRight, ExternalLink, Flag, Clock, Search,
  ChevronRight as Arrow, Truck, Send, Package, PackageCheck, BarChart3, Download, Pencil,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'
import { ClienteAutocomplete } from './NovoPedido'
import { ItensPedido, type ItemLinha } from '../components/ItensPedido'
import { LocalEntregaInput } from '../components/LocalEntregaInput'
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
  AGUARDANDO_ESTOQUE: '🚩 Aguardando estoque (PCP)',
  COTACAO_FRETE: 'Cotação de frete',
  OV_GERADA: 'OV gerada',
  NF_ENVIADA: 'NF enviada',
  CONCLUIDO: 'Concluído',
}
// Venda direta e consignação: fluxo completo (cota frete, gera OV, envia NF).
// "Aguardando estoque" é uma parada quando o pedido não tem estoque — o PCP dá a
// previsão e o card fica visível até o material chegar (nunca some do painel).
// Comunicado de uso: fluxo curto (recebe, processa no D365, conclui) — o material
// já foi usado pelo cliente, então não passa por estoque.
const FLUXO_LICITACAO = ['AGUARDANDO_ESTOQUE', 'RECEBIDO', 'PROCESSANDO', 'OV_GERADA', 'COTACAO_FRETE', 'NF_ENVIADA']
const FLUXO_COMUNICADO = ['RECEBIDO', 'PROCESSANDO', 'CONCLUIDO']
const etapasDoTipo = (tipo: string) => tipo === 'COMUNICADO_USO' ? FLUXO_COMUNICADO : FLUXO_LICITACAO
const ETAPAS_FINAIS = ['NF_ENVIADA', 'CONCLUIDO']
// Compatibilidade com etapas antigas
const normEtapa = (e?: string) => (e === 'NOVO' || e === 'ANALISE') ? 'RECEBIDO' : (e || 'RECEBIDO')
const temOV = (d: any) => (d.ovs || []).length > 0 || d.gerado_tipo === 'PEDIDO'
// OV já faturada (NF emitida) — daqui pra frente o operador precisa ENVIAR a NF
// ao cliente por e-mail. Faturado e além (no pallet, expedido) contam.
const FATURADO_STATES = ['FATURADO', 'AGUARD_COLETA', 'EXPEDIDO']
const ovFaturada = (d: any) => FATURADO_STATES.includes(d.ov_status)
// Coluna onde o card aparece.
function etapaColuna(d: any): string {
  const e = normEtapa(d.etapa)
  const ehComunicado = d.tipo_operacao === 'COMUNICADO_USO'
  // Card de ENTREGA (vinculado a uma OV): espelha o ciclo real da OV no kanban.
  if (!ehComunicado && temOV(d)) {
    if (e === 'NF_ENVIADA') return 'NF_ENVIADA'        // operador confirmou o envio da NF
    if (ovFaturada(d)) return 'COTACAO_FRETE'          // faturou → aguarda envio da NF ao cliente
    if (e === 'COTACAO_FRETE') return 'COTACAO_FRETE'  // frete cotado
    return 'OV_GERADA'
  }
  // Venda direta/consignação concluída que virou contrato → final (sai do painel).
  if (e === 'CONCLUIDO' && !ehComunicado) return 'CONCLUIDO'
  return e
}
const ehFinal = (d: any) => ETAPAS_FINAIS.includes(etapaColuna(d))
// Próxima ação do card conforme a etapa/tipo
function acaoDaEtapa(d: any): { kind: string; to?: string; label: string } | null {
  const e = etapaColuna(d)
  const licitacao = d.tipo_operacao !== 'COMUNICADO_USO'
  if (e === 'AGUARDANDO_ESTOQUE') return { kind: 'liberarEstoque', label: 'Estoque chegou' }
  if (e === 'RECEBIDO') return { kind: 'avancar', to: 'PROCESSANDO', label: 'Avançar' }
  // Venda direta: Gerar OV já cria o contrato automático e mantém o card no kanban.
  // Consignação: cria o contrato (baixa por comunicado de uso). Comunicado: fatura.
  if (e === 'PROCESSANDO') {
    if (d.tipo_operacao === 'VENDA_DIRETA') return { kind: 'gerarOv', label: 'Gerar OV' }
    if (d.tipo_operacao === 'CONSIGNACAO') return { kind: 'faturar', label: 'Criar contrato' }
    return { kind: 'faturar', label: 'Concluir e faturar' }
  }
  if (e === 'OV_GERADA') return { kind: 'frete', label: 'Cotar frete' }
  if (e === 'COTACAO_FRETE') return { kind: 'enviarNf', label: 'Enviar NF' }
  return null
}
// Card sem estoque? (na coluna de espera do PCP)
const semEstoque = (d: any) => etapaColuna(d) === 'AGUARDANDO_ESTOQUE'
// Pode sinalizar falta de estoque? (venda direta/consignação ainda no início)
const podeMarcarSemEstoque = (d: any) =>
  d.tipo_operacao !== 'COMUNICADO_USO' && ['RECEBIDO', 'PROCESSANDO'].includes(etapaColuna(d))
// Risco de multa: aguardando estoque e a previsão do PCP estoura o prazo do
// contrato (ou o prazo já venceu enquanto o material não chega).
function riscoMulta(d: any): boolean {
  if (!semEstoque(d) || !d.prazo) return false
  const prev = d.estoque?.previsao_pcp
  const hoje = new Date().toISOString().slice(0, 10)
  return (!!prev && prev > d.prazo) || d.prazo < hoje
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
  const [aba, setAba] = useState<'painel' | 'contratos' | 'relatorio'>('painel')

  return (
    <div className="p-4 lg:p-6 max-w-[1400px] mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2"><Gavel size={20} /> Licitações</h1>
        <p className="text-sm text-gray-400">Triagem das demandas do dia, contratos (com saldo) e relatório completo do que já foi feito.</p>
      </div>

      <div className="flex gap-1 border-b">
        {([['painel', 'Painel de demandas', LayoutGrid], ['contratos', 'Contratos', Layers], ['relatorio', 'Relatório', BarChart3]] as const).map(([k, label, Icone]) => (
          <button key={k} onClick={() => setAba(k)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition ${
              aba === k ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            <Icone size={16} /> {label}
          </button>
        ))}
      </div>

      {aba === 'painel' ? <PainelDemandas /> : aba === 'contratos' ? <AbaContratos /> : <AbaRelatorio />}
    </div>
  )
}

// ── Painel de demandas (triagem, sem arrastar) ───────────────────────────────────
function PainelDemandas() {
  const qc = useQueryClient()
  // Deep-link (ex: /licitacoes?novo=COMUNICADO_USO) — outras telas mandam direto
  // para cá em vez de ter um formulário próprio de comunicado de uso.
  const novoParam = new URLSearchParams(window.location.search).get('novo') as TipoKey | null
  const [modalNovo, setModalNovo] = useState<TipoKey | null>(novoParam && TIPOS.some(t => t.key === novoParam) ? novoParam : null)
  const [detalheId, setDetalheId] = useState<string | null>(null)
  const [concluirManual, setConcluirManual] = useState<any | null>(null)
  const [gerar, setGerar] = useState<any | null>(null)
  const [gerarOv, setGerarOv] = useState<any | null>(null)
  const [cotarFrete, setCotarFrete] = useState<any | null>(null)
  const [enviarNf, setEnviarNf] = useState<any | null>(null)
  const [semEstoqueModal, setSemEstoqueModal] = useState<any | null>(null)
  const [historico, setHistorico] = useState(false)
  const [busca, setBusca] = useState('')
  const [canalFiltro, setCanalFiltro] = useState('')
  const [alerta, setAlerta] = useState<'' | 'PARADAS' | 'PRAZO' | 'NF' | 'ESTOQUE'>('')
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

  const liberarEstoque = useMutation({
    mutationFn: (id: string) => api.post(`/licitacoes/demandas/${id}/estoque-ok`, {}),
    onSuccess: () => { invalidar(); toast.success('Estoque liberado — card voltou ao fluxo') },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao liberar estoque')),
  })

  const resumoTeams = useMutation({
    mutationFn: () => api.post('/pedidos/resumo-diario'),
    onSuccess: () => toast.success('Resumo do dia enviado ao canal do Teams'),
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao enviar resumo'), { duration: 5000 }),
  })

  // Data de hoje no fuso local (para comparar prazos)
  const hojeISO = useMemo(() => {
    const d = new Date()
    return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10)
  }, [])

  // KPIs de controle — calculados sobre TODAS as demandas do painel.
  // "Parado" = sem movimento (mede pelo último update, não pela criação).
  const kpis = useMemo(() => {
    const pendentes = demandas.filter(d => !ehFinal(d))
    const semEst = pendentes.filter(semEstoque)
    return {
      pendentes: pendentes.length,
      // "Parado" ignora quem está aguardando estoque de propósito (esperando o PCP).
      paradas: pendentes.filter(d => !semEstoque(d) && diasParado(d.atualizado_em || d.criado_em) >= 2).length,
      prazoVencido: pendentes.filter(d => d.prazo && d.prazo < hojeISO).length,
      // "NF a enviar" = OV já faturada (NF emitida) e ainda não confirmada como enviada ao cliente.
      nfPendente: demandas.filter(d => ovFaturada(d) && etapaColuna(d) !== 'NF_ENVIADA' && !d.nf).length,
      semEstoque: semEst.length,
      semEstoqueRisco: semEst.filter(riscoMulta).length,
      concluidasHoje: demandas.filter(d => ehFinal(d)).length,
    }
  }, [demandas, hojeISO])

  // Números repetidos entre demandas ativas — sinaliza duplicatas já existentes
  // (o cadastro novo já é bloqueado; aqui pegamos o que entrou antes).
  const numerosDuplicados = useMemo(() => {
    const cont: Record<string, number> = {}
    // Cards de entrega (OVs de um mesmo contrato) compartilham o nº do contrato de
    // propósito — não são duplicidade, então ficam de fora da checagem.
    demandas.forEach(d => { if (d.gerado_tipo === 'PEDIDO') return; const n = (d.numero || '').trim(); if (n) cont[n] = (cont[n] || 0) + 1 })
    return new Set(Object.entries(cont).filter(([, c]) => c > 1).map(([n]) => n))
  }, [demandas])

  const filtradas = useMemo(() => {
    const b = busca.trim().toLowerCase()
    return demandas.filter(d => {
      if (canalFiltro && d.canal !== canalFiltro) return false
      if (alerta === 'PARADAS' && (ehFinal(d) || semEstoque(d) || diasParado(d.atualizado_em || d.criado_em) < 2)) return false
      if (alerta === 'PRAZO' && (ehFinal(d) || !d.prazo || d.prazo >= hojeISO)) return false
      if (alerta === 'NF' && !(ovFaturada(d) && etapaColuna(d) !== 'NF_ENVIADA' && !d.nf)) return false
      if (alerta === 'ESTOQUE' && !semEstoque(d)) return false
      if (b) {
        const alvo = `${d.cliente || ''} ${d.numero || ''} ${d.gerado_ref || ''}`.toLowerCase()
        if (!alvo.includes(b)) return false
      }
      return true
    })
  }, [demandas, busca, canalFiltro, alerta, hojeISO])

  const porTipoEtapa = (tipo: string, etapa: string) => filtradas.filter(d => d.tipo_operacao === tipo && etapaColuna(d) === etapa)

  // Executa a ação primária do card conforme a etapa atual.
  const executarAcao = (d: any) => {
    const a = acaoDaEtapa(d)
    if (!a) return
    if (a.kind === 'avancar' && a.to) mover.mutate({ id: d.id, etapa: a.to })
    else if (a.kind === 'frete') setCotarFrete(d)
    else if (a.kind === 'gerarOv') setGerarOv({ demanda: d })
    else if (a.kind === 'enviarNf') setEnviarNf(d)
    else if (a.kind === 'faturar') setGerar(d)
    else if (a.kind === 'concluir') setConcluirManual(d)
    else if (a.kind === 'liberarEstoque') liberarEstoque.mutate(d.id)
  }

  return (
    <div className="space-y-4">
      {/* Faixa de controle — clique num indicador para filtrar o painel */}
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        {([
          { key: '', label: 'Pendentes', valor: kpis.pendentes, cor: 'text-blue-700', borda: 'ring-blue-400', desc: 'tudo que ainda não fechou', sub: '' },
          { key: 'PARADAS', label: '⏳ Paradas 2+ dias', valor: kpis.paradas, cor: kpis.paradas > 0 ? 'text-amber-600' : 'text-gray-400', borda: 'ring-amber-400', desc: 'sem movimento (não conta as sem estoque)', sub: '' },
          { key: 'ESTOQUE', label: '🏭 Sem estoque', valor: kpis.semEstoque, cor: kpis.semEstoqueRisco > 0 ? 'text-red-600' : kpis.semEstoque > 0 ? 'text-orange-600' : 'text-gray-400', borda: 'ring-orange-400', desc: 'aguardando previsão do PCP — não esquecer!', sub: kpis.semEstoqueRisco > 0 ? `🔴 ${kpis.semEstoqueRisco} c/ risco de multa` : '' },
          { key: 'PRAZO', label: '🔴 Prazo vencido', valor: kpis.prazoVencido, cor: kpis.prazoVencido > 0 ? 'text-red-600' : 'text-gray-400', borda: 'ring-red-400', desc: 'prazo do cliente estourado', sub: '' },
          { key: 'NF', label: '📄 NF a enviar', valor: kpis.nfPendente, cor: kpis.nfPendente > 0 ? 'text-indigo-600' : 'text-gray-400', borda: 'ring-indigo-400', desc: 'OV pronta, falta NF ao cliente', sub: '' },
        ] as const).map(k => (
          <button key={k.label} onClick={() => setAlerta(alerta === k.key ? '' : k.key as any)}
            title={k.desc}
            className={`bg-white rounded-xl border border-gray-100 shadow-sm px-3 py-2 text-left transition hover:border-gray-300 ${alerta === k.key && k.key !== '' ? `ring-2 ${k.borda}` : ''}`}>
            <p className={`text-xl font-bold leading-tight tabular-nums ${k.cor}`}>{k.valor}</p>
            <p className="text-[11px] text-gray-500">{k.label}</p>
            {k.sub && <p className="text-[10px] text-red-600 font-medium leading-tight mt-0.5">{k.sub}</p>}
          </button>
        ))}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-3 py-2">
          <p className="text-xl font-bold leading-tight tabular-nums text-emerald-600">{kpis.concluidasHoje}</p>
          <p className="text-[11px] text-gray-500">✅ Concluídas hoje</p>
        </div>
      </div>
      {alerta && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-700 flex items-center justify-between">
          <span>Mostrando só <strong>{alerta === 'PARADAS' ? 'paradas há 2+ dias' : alerta === 'PRAZO' ? 'com prazo vencido' : alerta === 'ESTOQUE' ? 'aguardando estoque (PCP)' : 'com NF a enviar'}</strong>.</span>
          <button onClick={() => setAlerta('')} className="underline">Ver tudo</button>
        </div>
      )}

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
          <span className="text-xs text-gray-400 hidden lg:block">{filtradas.filter(d => !ehFinal(d)).length} no filtro</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => resumoTeams.mutate()} disabled={resumoTeams.isPending}
            className="flex items-center gap-1.5 text-gray-600 text-sm font-medium px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50 disabled:opacity-50"
            title="Envia agora o resumo de pendências ao canal do Teams (também sai automático às 08h)">
            📣 {resumoTeams.isPending ? 'Enviando…' : 'Resumo Teams'}
          </button>
          <button onClick={() => setHistorico(true)}
            title="Busque por pregão, NE, AF, paciente, prontuário, OV ou cliente — mesmo o que ainda está em andamento, antes de criar de novo"
            className="flex items-center gap-1.5 text-gray-600 text-sm font-medium px-3 py-2 rounded-lg border border-gray-200 hover:bg-gray-50">
            <Search size={15} /> Pesquisar / Histórico
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
        💡 <strong>Venda direta</strong>: D365 → <strong>Gerar OV</strong> (cria o contrato automático e segue no kanban) → <strong>Cotar frete</strong> → <strong>Enviar NF</strong>. <strong>Consignação</strong>: cria o contrato (baixa por comunicado de uso). <strong>Comunicado de uso</strong>: regido pela <strong>AF + paciente + prontuário</strong> — confira em <strong>Pesquisar / Histórico</strong> antes de lançar, evita processar o mesmo caso duas vezes. Sem estoque? Use <strong>🏭 Sem estoque</strong> — o card fica na coluna do PCP e <strong>não some</strong> até o material chegar. As finalizadas <strong>saem do painel no dia seguinte</strong> — veja em <strong>Pesquisar / Histórico</strong>.
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
                        const ehEstoque = etapaKey === 'AGUARDANDO_ESTOQUE'
                        return (
                          <div key={etapaKey} className={`min-h-[90px] p-2 ${ehEstoque ? 'bg-red-50 ring-1 ring-inset ring-red-200' : 'bg-gray-50'}`}>
                            <div className="flex items-center justify-between mb-2 px-1">
                              <span className={`text-[11px] font-semibold uppercase tracking-wide ${ehEstoque ? 'text-red-600' : 'text-gray-500'}`}>{ETAPA_LABEL[etapaKey]}</span>
                              <span className={`text-[11px] ${ehEstoque && cards.length > 0 ? 'text-red-500 font-bold' : 'text-gray-400'}`}>{cards.length}</span>
                            </div>
                            <div className="space-y-2 max-h-[420px] overflow-y-auto pr-0.5">
                              {cards.map(d => (
                                <CardDemanda key={d.id} d={d} tipo={tipo}
                                  duplicado={!!d.numero && numerosDuplicados.has(d.numero.trim())}
                                  onClick={() => setDetalheId(d.id)}
                                  onAcao={() => executarAcao(d)}
                                  onGerarOv={() => setGerarOv({ demanda: d })}
                                  onSemEstoque={() => setSemEstoqueModal(d)} />
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
          onGerarOv={(d) => { setDetalheId(null); setGerarOv({ demanda: d }) }}
          onCotarFrete={(d) => { setDetalheId(null); setCotarFrete(d) }}
          onSemEstoque={(d) => { setDetalheId(null); setSemEstoqueModal(d) }}
          onMarcarFeito={(d) => { setDetalheId(null); setConcluirManual(d) }} />
      )}
      {concluirManual && <ModalConcluirManual demanda={concluirManual} onClose={() => setConcluirManual(null)} onSaved={invalidar} />}
      {gerar && <ModalConcluir demanda={gerar} onClose={() => setGerar(null)} onSaved={invalidar} />}
      {gerarOv && <ModalGerarOVSaldo demanda={gerarOv.demanda} onClose={() => setGerarOv(null)} onSaved={invalidar} />}
      {cotarFrete && <ModalFrete demanda={cotarFrete} onClose={() => setCotarFrete(null)} onSaved={invalidar} />}
      {enviarNf && <ModalEnviarNF demanda={enviarNf} onClose={() => setEnviarNf(null)} onSaved={invalidar} />}
      {semEstoqueModal && <ModalSemEstoque demanda={semEstoqueModal} onClose={() => setSemEstoqueModal(null)} onSaved={invalidar} />}
      {historico && <ModalHistorico onClose={() => setHistorico(false)} />}
    </div>
  )
}

function CardDemanda({ d, tipo, onClick, onAcao, onGerarOv, onSemEstoque, duplicado }: {
  d: any; tipo: any; onClick: () => void; onAcao: () => void; onGerarOv?: () => void; onSemEstoque?: () => void; duplicado?: boolean
}) {
  const prio = PRIO_CFG[d.prioridade] || PRIO_CFG.NORMAL
  const nItens = (d.itens || []).length
  const final = ehFinal(d)
  const etapaCol = etapaColuna(d)
  const emEstoque = etapaCol === 'AGUARDANDO_ESTOQUE'
  const risco = riscoMulta(d)
  // OV faturada e NF ainda não enviada ao cliente → lembrar o operador do e-mail.
  const faturadoAviso = ovFaturada(d) && etapaCol !== 'NF_ENVIADA' && !d.nf
  const parado = diasParado(d.atualizado_em || d.criado_em)
  const refFeito = d.ref_externa || d.gerado_ref
  const acao = acaoDaEtapa(d)
  // Follow-up: OV já gerada e ainda sobra saldo (entrega parcial de venda direta).
  const temSaldoFollowup = d.tipo_operacao === 'VENDA_DIRETA' && etapaCol === 'OV_GERADA' && (d.ov_itens || []).length > 0 &&
    mesclarItens(d.itens || [], d.ov_itens).some(l => l.saldo > 0)
  const iconeAcao = acao?.kind === 'frete' ? <Truck size={11} /> : acao?.kind === 'gerarOv' ? <ShoppingCart size={11} />
    : acao?.kind === 'enviarNf' ? <Send size={11} /> : acao?.kind === 'concluir' ? <Flag size={11} />
    : acao?.kind === 'faturar' ? <Flag size={11} />
    : acao?.kind === 'liberarEstoque' ? <PackageCheck size={11} /> : <Arrow size={11} />
  const acaoCor = acao?.kind === 'avancar' ? 'border text-gray-600 hover:bg-gray-50'
    : acao?.kind === 'liberarEstoque' ? 'bg-emerald-600 hover:bg-emerald-500 text-white'
    : 'bg-blue-600 hover:bg-blue-500 text-white'
  return (
    <div className={`bg-white rounded-lg border border-gray-200 border-l-4 ${tipo.borda} shadow-sm p-2.5`}>
      <div onClick={onClick} className="cursor-pointer">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm font-medium text-gray-800 leading-tight line-clamp-2">{d.cliente || 'Cliente não informado'}</p>
          {d.prioridade !== 'NORMAL' && <span className={`text-[10px] px-1.5 py-0.5 rounded-full whitespace-nowrap ${prio.cor}`}>{prio.label}</span>}
        </div>
        <div className="flex items-center gap-1.5 mt-0.5 flex-wrap">
          {d.numero_pregao && <p className="text-xs font-mono text-gray-700 font-medium">Pregão {d.numero_pregao}</p>}
          {d.numero && <p className="text-xs font-mono text-gray-400">{d.tipo_operacao === 'COMUNICADO_USO' ? `AF ${d.numero}` : `NE ${d.numero}`}</p>}
          {duplicado && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700 whitespace-nowrap" title="Outra demanda ativa tem este mesmo número — confira se não é duplicidade">⚠️ nº duplicado</span>}
        </div>
        {d.tipo_operacao === 'COMUNICADO_USO' && (d.nome_paciente || d.prontuario) && (
          <p className="text-[11px] text-gray-400 mt-0.5 truncate">
            {d.nome_paciente && <>👤 {d.nome_paciente}</>}{d.nome_paciente && d.prontuario && ' · '}{d.prontuario && <>Prontuário {d.prontuario}</>}
          </p>
        )}
        <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5 text-[11px]">
          {d.canal && <span className="text-gray-400">{CANAL_LABEL[d.canal] || d.canal}</span>}
          {nItens > 0 && <span className="text-gray-400">{nItens} {nItens === 1 ? 'item' : 'itens'}</span>}
          {d.prazo && <span className={`flex items-center gap-1 ${prazoCor(d.prazo)}`}><Clock size={11} /> Prazo {fmtData(d.prazo)}</span>}
          {!final && !emEstoque && parado >= 2 && <span className={`flex items-center gap-1 ${parado >= 4 ? 'text-red-500 font-medium' : 'text-amber-500'}`} title="Dias sem movimento">⏳ parado {parado}d</span>}
        </div>
        {emEstoque && (
          <div className={`mt-1.5 rounded-md px-2 py-1 text-[11px] flex items-start gap-1 ${risco ? 'bg-red-50 text-red-700 font-medium' : 'bg-orange-50 text-orange-700'}`}
            title={risco ? 'A previsão do PCP passa do prazo do contrato — risco de multa' : 'Aguardando o material do PCP'}>
            <Package size={12} className="mt-px shrink-0" />
            <span>
              {risco ? '🔴 Risco de multa · ' : ''}
              {d.estoque?.previsao_pcp ? `PCP prevê ${fmtData(d.estoque.previsao_pcp)}` : 'Sem previsão do PCP'}
              {(d.estoque?.itens_faltantes || []).length > 0 ? ` · faltam: ${d.estoque.itens_faltantes.slice(0, 3).join(', ')}` : ''}
            </span>
          </div>
        )}
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
        {faturadoAviso && (
          <div className="mt-1.5 rounded-md px-2 py-1 text-[11px] bg-red-50 text-red-700 font-medium flex items-start gap-1"
            title="A OV já foi faturada (NF emitida) — envie a NF ao cliente por e-mail e depois clique em Enviar NF">
            <Send size={12} className="mt-px shrink-0" /> 📧 Faturado — envie a NF ao cliente por e-mail
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
          {podeMarcarSemEstoque(d) && onSemEstoque && (
            <button onClick={(e) => { e.stopPropagation(); onSemEstoque() }}
              className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border border-orange-200 text-orange-600 hover:bg-orange-50"
              title="Sinalizar que não há estoque — vai para a coluna Aguardando estoque (PCP) e não some do painel">
              <Package size={11} /> Sem estoque
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
  const [numeroPregao, setNumeroPregao] = useState('')
  const [numero, setNumero] = useState('')
  const [nomePaciente, setNomePaciente] = useState('')
  const [prontuario, setProntuario] = useState('')
  const [numeroNf, setNumeroNf] = useState('')
  const [dataProcedimento, setDataProcedimento] = useState('')
  const [canal, setCanal] = useState('')
  const [prazo, setPrazo] = useState('')
  const [prioridade, setPrioridade] = useState('NORMAL')
  const [observacao, setObservacao] = useState('')
  const [itens, setItens] = useState<ItemLinha[]>([])

  const cfg = TIPO_MAP[tipo]
  const ehComunicado = tipo === 'COMUNICADO_USO'
  const comValor = true

  // Sinaliza se o pregão digitado já existe — a demanda vira mais uma NE
  // (linha) desse contrato, não um contrato novo.
  const { data: pregoesExistentes = [] } = useQuery<any[]>({
    queryKey: ['pregoes'],
    queryFn: () => api.get('/licitacoes/pregoes').then(r => r.data),
    enabled: !ehComunicado,
    staleTime: 60000,
  })
  const pregaoEncontrado = !ehComunicado && numeroPregao.trim()
    ? pregoesExistentes.find(p => p.numero.trim().toLowerCase() === numeroPregao.trim().toLowerCase())
    : null
  // Venda direta / consignação viram contrato regido pelo PREGÃO + NE → ambos obrigatórios.
  const pregaoObrigatorio = !ehComunicado
  const pregaoOk = !pregaoObrigatorio || (!!numeroPregao.trim() && !!numero.trim())
  // Comunicado de uso é regido pela AF + paciente + prontuário + NF + data do procedimento + itens com valor.
  const itensComunicadoOk = itens.length > 0 && itens.every(i => i.qtd > 0 && (i.valor || 0) > 0)
  const comunicadoOk = !ehComunicado || (!!numero.trim() && !!nomePaciente.trim() && !!prontuario.trim() && !!numeroNf.trim() && !!dataProcedimento && itensComunicadoOk)

  const criar = useMutation({
    mutationFn: () => api.post('/licitacoes/demandas', {
      tipo_operacao: tipo,
      cliente_id: clienteId,
      numero_pregao: numeroPregao.trim() || null,
      numero: numero.trim() || null,
      nome_paciente: nomePaciente.trim() || null,
      prontuario: prontuario.trim() || null,
      numero_nf: ehComunicado ? (numeroNf.trim() || null) : null,
      data_procedimento: ehComunicado ? (dataProcedimento || null) : null,
      canal: canal || null,
      prazo: ehComunicado ? null : (prazo || null),
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

        {tipo !== 'COMUNICADO_USO' ? (
          <div className="grid grid-cols-2 gap-3">
            <Campo label="Nº do Pregão *">
              <input value={numeroPregao} onChange={e => setNumeroPregao(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: 90051/2025" />
              {!numeroPregao.trim() && <p className="text-xs text-red-500 mt-1">Obrigatório — o pregão é o que rege o contrato.</p>}
            </Campo>
            <Campo label="Nota de empenho (NE) *">
              <input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: 2026NE001246" />
              {!numero.trim() && <p className="text-xs text-red-500 mt-1">Obrigatório — sem ela o contrato fica sem NE (rege a rastreabilidade).</p>}
            </Campo>
            {pregaoEncontrado && (
              <div className="col-span-2 bg-blue-50 border border-blue-200 rounded-lg p-2.5 text-xs text-blue-700">
                ✅ Pregão <strong>{pregaoEncontrado.numero}</strong> já cadastrado — {pregaoEncontrado.cliente} · {pregaoEncontrado.qtd_nes} NE(s) já lançada(s) · saldo a empenhar {fmtBRL(pregaoEncontrado.saldo_valor)}.
                Esta demanda vai virar <strong>mais uma NE (linha)</strong> desse contrato, consumindo o saldo — não um contrato novo.
              </div>
            )}
          </div>
        ) : (
          <>
            <div className="grid grid-cols-3 gap-3">
              <Campo label="AF (Autorização de Fornecimento) *">
                <input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: AF123456" />
                {!numero.trim() && <p className="text-xs text-red-500 mt-1">Obrigatório — rege o comunicado e evita duplicidade.</p>}
              </Campo>
              <Campo label="Nome do paciente *">
                <input value={nomePaciente} onChange={e => setNomePaciente(e.target.value)} className={inputCls} placeholder="Nome completo" />
              </Campo>
              <Campo label="Prontuário *">
                <input value={prontuario} onChange={e => setProntuario(e.target.value)} className={`${inputCls} font-mono`} placeholder="Ex: 000123" />
              </Campo>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Campo label="Número da NF *">
                <input value={numeroNf} onChange={e => setNumeroNf(e.target.value)} className={`${inputCls} font-mono`} placeholder="Ex: 20045" />
              </Campo>
              <Campo label="Data do procedimento *">
                <input type="date" value={dataProcedimento} onChange={e => setDataProcedimento(e.target.value)} className={inputCls} />
              </Campo>
            </div>
          </>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Canal">
            <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
              <option value="">A definir…</option>
              {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
            </select>
          </Campo>
          {!ehComunicado && (
            <Campo label="Prazo / vigência">
              <input type="date" value={prazo} onChange={e => setPrazo(e.target.value)} className={inputCls} />
            </Campo>
          )}
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
            Itens {ehComunicado ? '(o que foi usado, com valor unitário) *' : '(quantidades TOTAIS do contrato, com valor)'}
          </label>
          <p className="text-xs text-gray-400 mb-1.5">
            {tipo === 'VENDA_DIRETA'
              ? 'Coloque o total ganho no pregão. As entregas parciais você lança depois, na aba Contratos.'
              : ehComunicado ? 'Informe o que foi usado com o valor unitário — o valor da NF é calculado ao concluir.' : 'Opcional agora — pode completar ao processar.'}
          </p>
          <ItensPedido value={itens} onChange={setItens} comValor={comValor} />
        </div>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => criar.mutate()} disabled={!clienteId || !pregaoOk || !comunicadoOk || criar.isPending}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {criar.isPending ? 'Salvando…' : 'Adicionar ao painel'}
        </button>
      </div>
    </ModalBase>
  )
}

// ── Modal: Detalhe da demanda ────────────────────────────────────────────────────
function ModalDetalheDemanda({ id, onClose, onChanged, onAcao, onGerarOv, onCotarFrete, onSemEstoque, onMarcarFeito }: {
  id: string; onClose: () => void; onChanged: () => void; onAcao: (d: any) => void; onGerarOv: (d: any) => void; onCotarFrete: (d: any) => void; onSemEstoque: (d: any) => void; onMarcarFeito: (d: any) => void
}) {
  const navigate = useNavigate()
  const qcDet = useQueryClient()
  const { data: d } = useQuery<any>({
    queryKey: ['demanda', id],
    queryFn: () => api.get(`/licitacoes/demandas/${id}`).then(r => r.data),
  })

  const [editandoItens, setEditandoItens] = useState(false)
  const [itensEdit, setItensEdit] = useState<ItemLinha[]>([])
  const salvarItens = useMutation({
    mutationFn: () => api.patch(`/licitacoes/demandas/${id}`, {
      itens: itensEdit.map(i => ({ produto_id: i.produto_id, codigo: i.codigo, descricao: i.descricao, qtd: i.qtd, valor: i.valor || 0 })),
    }),
    onSuccess: () => {
      toast.success('Itens corrigidos')
      setEditandoItens(false)
      qcDet.invalidateQueries({ queryKey: ['demanda', id] })
      onChanged()
    },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao salvar')),
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
            {d.numero_pregao && <span className="font-mono text-gray-700 font-medium">Pregão {d.numero_pregao}</span>}
            {d.numero && <span className="font-mono">{d.tipo_operacao === 'COMUNICADO_USO' ? `AF ${d.numero}` : `NE ${d.numero}`}</span>}
            {d.canal && <span>Canal: {CANAL_LABEL[d.canal] || d.canal}</span>}
            {d.prazo && <span className={prazoCor(d.prazo)}>Prazo: {fmtData(d.prazo)}</span>}
          </div>
          {d.tipo_operacao === 'COMUNICADO_USO' && (d.nome_paciente || d.prontuario || d.numero_nf || d.data_procedimento) && (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-gray-500 mt-1">
              {d.nome_paciente && <span>👤 Paciente: <strong className="text-gray-700">{d.nome_paciente}</strong></span>}
              {d.prontuario && <span>Prontuário: <strong className="font-mono text-gray-700">{d.prontuario}</strong></span>}
              {d.numero_nf && <span>NF: <strong className="font-mono text-gray-700">{d.numero_nf}</strong></span>}
              {d.data_procedimento && <span>Procedimento: <strong className="text-gray-700">{fmtData(d.data_procedimento)}</strong></span>}
            </div>
          )}
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
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-gray-500">Itens ({d.itens.length})</label>
              {!concluida && !editandoItens && (
                <button onClick={() => {
                  setItensEdit(d.itens.map((it: any) => ({
                    produto_id: it.produto_id, codigo: it.codigo || '', descricao: it.descricao || '',
                    qtd: Number(it.qtd) || 0, valor: Number(it.valor) || 0,
                  })))
                  setEditandoItens(true)
                }} className="text-xs text-indigo-600 hover:underline flex items-center gap-1">
                  <Pencil size={12} /> Corrigir
                </button>
              )}
            </div>
            {editandoItens ? (
              <div className="mt-1 space-y-2">
                <ItensPedido value={itensEdit} onChange={setItensEdit} comValor />
                <div className="flex justify-end gap-2">
                  <button onClick={() => setEditandoItens(false)} className="px-3 py-1.5 text-xs border rounded-lg text-gray-600">Cancelar</button>
                  <button onClick={() => salvarItens.mutate()} disabled={salvarItens.isPending || itensEdit.length === 0}
                    className="px-3 py-1.5 text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white font-medium rounded-lg">
                    {salvarItens.isPending ? 'Salvando…' : 'Salvar correção'}
                  </button>
                </div>
              </div>
            ) : (
              <div className="border border-gray-100 rounded-lg divide-y divide-gray-50 mt-1">
                {d.itens.map((it: any, idx: number) => (
                  <div key={idx} className="flex justify-between px-3 py-1.5 text-sm">
                    <span><span className="font-mono text-gray-700">{it.codigo || '—'}</span> <span className="text-gray-500">{it.descricao}</span></span>
                    <span className="text-gray-600 tabular-nums">{it.qtd} un{it.valor ? ` · ${fmtBRL(it.valor)}` : ''}</span>
                  </div>
                ))}
              </div>
            )}
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

        {etapaAtual === 'AGUARDANDO_ESTOQUE' && (
          <div className={`rounded-lg p-3 text-sm border ${riscoMulta(d) ? 'bg-red-50 border-red-200' : 'bg-orange-50 border-orange-200'}`}>
            <div className="flex items-center justify-between gap-2">
              <p className={`text-xs font-medium flex items-center gap-1 ${riscoMulta(d) ? 'text-red-700' : 'text-orange-700'}`}>
                <Package size={13} /> Aguardando estoque (PCP)
              </p>
              <button onClick={() => onSemEstoque(d)} className="text-xs text-orange-700 hover:underline">Editar previsão</button>
            </div>
            <p className={`mt-1 ${riscoMulta(d) ? 'text-red-800' : 'text-orange-800'}`}>
              {riscoMulta(d) ? '🔴 Risco de multa · ' : ''}
              {d.estoque?.previsao_pcp ? `PCP prevê ${fmtData(d.estoque.previsao_pcp)}` : 'Sem previsão informada'}
            </p>
            {(d.estoque?.itens_faltantes || []).length > 0 && (
              <p className="text-xs text-gray-600 mt-1">Faltam: {d.estoque.itens_faltantes.join(', ')}</p>
            )}
            {d.estoque?.observacao && <p className="text-xs text-gray-500 mt-1">{d.estoque.observacao}</p>}
            <button onClick={() => onAcao(d)}
              className="mt-2 flex items-center gap-1.5 px-3 py-1.5 text-sm bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg">
              <PackageCheck size={15} /> Estoque chegou
            </button>
          </div>
        )}

        {!concluida && (
          <div>
            <label className="text-xs font-medium text-gray-500">Mover para (manual)</label>
            <div className="flex flex-wrap gap-2 mt-1">
              {['RECEBIDO', 'PROCESSANDO'].map(k => (
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
            <p className="text-sm text-emerald-700 font-medium">✅ {d.gerado_tipo === 'CONTRATO' ? `Contrato criado — veja na aba Contratos${d.gerado_ref ? `: ${d.gerado_ref}` : ''}` : etapaAtual === 'NF_ENVIADA' ? 'NF enviada — ciclo fechado' : 'Concluída'}{(d.gerado_tipo !== 'CONTRATO' && !d.nf && (d.ref_externa || d.gerado_ref)) ? ` — D365: ${d.ref_externa || d.gerado_ref}` : ''}</p>
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
              <button onClick={() => onMarcarFeito(d)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm border rounded-lg text-gray-600 hover:bg-gray-50" title="Só marca como concluído, sem lançar o faturamento no app">
                Só marcar feito
              </button>
            )}
            {temSaldoFollowup && (
              <button onClick={() => onGerarOv(d)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm border border-blue-200 text-blue-600 rounded-lg hover:bg-blue-50">
                <ShoppingCart size={16} /> OV do saldo
              </button>
            )}
            {podeMarcarSemEstoque(d) && (
              <button onClick={() => onSemEstoque(d)}
                className="flex items-center gap-1.5 px-3 py-2 text-sm border border-orange-200 text-orange-600 rounded-lg hover:bg-orange-50"
                title="Sinalizar falta de estoque — vai para Aguardando estoque (PCP) e não some do painel">
                <Package size={16} /> Sem estoque
              </button>
            )}
            {acao && etapaAtual !== 'AGUARDANDO_ESTOQUE' && (
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

  const ehComunicadoTipo = demanda.tipo_operacao === 'COMUNICADO_USO'
  const [numero, setNumero] = useState(ehComunicadoTipo ? '' : (demanda.numero || ''))
  const [af, setAf] = useState(demanda.numero || '')
  const [nomePaciente, setNomePaciente] = useState(demanda.nome_paciente || '')
  const [prontuario, setProntuario] = useState(demanda.prontuario || '')
  const [numeroPregao, setNumeroPregao] = useState(demanda.numero_pregao || '')
  const [gerarOvJunto, setGerarOvJunto] = useState(false)
  const [ovNumero, setOvNumero] = useState('')
  const [dataEntregaOv, setDataEntregaOv] = useState(new Date().toISOString().slice(0, 10))
  const [clienteId, setClienteId] = useState(demanda.cliente_id || '')
  const [clienteNome, setClienteNome] = useState(demanda.cliente || '')
  const [canal, setCanal] = useState(demanda.canal || '')
  const [dataEmpenho, setDataEmpenho] = useState(hoje)
  const [vigencia, setVigencia] = useState(demanda.prazo || '')
  const [nf, setNf] = useState(demanda.numero_nf || '')
  const [dataProcedimento, setDataProcedimento] = useState(demanda.data_procedimento || '')
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

  // Sinaliza se o pregão digitado já existe — vira mais uma NE (linha) desse
  // contrato, não um contrato novo.
  const { data: pregoesExistentes = [] } = useQuery<any[]>({
    queryKey: ['pregoes'],
    queryFn: () => api.get('/licitacoes/pregoes').then(r => r.data),
    enabled: ehContrato,
    staleTime: 60000,
  })
  const pregaoEncontrado = ehContrato && numeroPregao.trim()
    ? pregoesExistentes.find(p => p.numero.trim().toLowerCase() === numeroPregao.trim().toLowerCase())
    : null

  const { data: empenhos = [] } = useQuery<any[]>({
    queryKey: ['empenhos'],
    queryFn: () => api.get('/licitacoes/empenhos').then(r => r.data),
    enabled: tipo === 'COMUNICADO_USO',
  })
  const empenhosCliente = empenhos.filter(e => e.cliente_id === clienteId && e.saldo_un > 0 && (e.tipo || 'CONSIGNACAO') === 'CONSIGNACAO')

  // Com contrato selecionado, o valor da NF é calculado pelos preços dele
  // (Σ qtd × valor unitário) — editável, o D365 é a palavra final.
  const { data: empSel } = useQuery<any>({
    queryKey: ['empenho', empenhoId],
    queryFn: () => api.get(`/licitacoes/empenhos/${empenhoId}`).then(r => r.data),
    enabled: tipo === 'COMUNICADO_USO' && !!empenhoId,
  })
  const [valorNfManual, setValorNfManual] = useState(false)
  const precoEmp: Record<string, number> = Object.fromEntries(
    (empSel?.itens || []).map((i: any) => [i.produto_id, Number(i.valor_unitario) || 0]))
  const itensComQtd = itens.filter(i => i.produto_id && i.qtd > 0)
  const sugestaoNf = tipo !== 'COMUNICADO_USO' || itensComQtd.length === 0 ? null
    : empenhoId && empSel && itensComQtd.every(i => precoEmp[i.produto_id] > 0)
    ? itensComQtd.reduce((s, i) => s + i.qtd * precoEmp[i.produto_id], 0)
    // Sem contrato selecionado: usa o valor unitário já informado na triagem.
    : !empenhoId && itensComQtd.every(i => (i.valor || 0) > 0)
    ? itensComQtd.reduce((s, i) => s + i.qtd * (i.valor || 0), 0)
    : null
  useEffect(() => {
    if (!valorNfManual && sugestaoNf != null) setValorNf(sugestaoNf.toFixed(2))
  }, [sugestaoNf, valorNfManual])

  const concluir = useMutation({
    mutationFn: () => {
      const body: any = {
        canal: canal || null,
        cliente_id: clienteId || null,
        itens: itens.map(i => ({ produto_id: i.produto_id, codigo: i.codigo, descricao: i.descricao, qtd: i.qtd, valor: i.valor || 0 })),
      }
      if (ehContrato) {
        body.numero = numero.trim()
        body.numero_pregao = numeroPregao.trim() || null
        body.data_empenho = dataEmpenho || null
        body.vigencia = vigencia || null
        if (tipo === 'VENDA_DIRETA' && gerarOvJunto) {
          body.gerar_ov = true
          body.numero_pedido = ovNumero.trim()
          body.data_prevista_entrega = dataEntregaOv || null
          body.tipo_frete = 'CIF_SEM_VALOR'
        }
      } else {
        body.numero_pedido = numero.trim()
        body.numero_nf = nf.trim()
        body.valor_nf = Number(valorNf)
        body.data_faturamento = dataFat || null
        body.empenho_id = empenhoId || null
        body.numero = af.trim()
        body.nome_paciente = nomePaciente.trim()
        body.prontuario = prontuario.trim()
        body.data_procedimento = dataProcedimento || null
      }
      return api.post(`/licitacoes/demandas/${demanda.id}/concluir`, body)
    },
    onSuccess: () => {
      const msg = !ehContrato ? 'Comunicado de uso lançado'
        : (tipo === 'VENDA_DIRETA' && gerarOvJunto) ? 'Contrato criado e OV gerada! Agora cote o frete e envie a NF no painel.'
        : 'Contrato criado! Está na aba Contratos — as entregas baixam o saldo lá.'
      toast.success(msg, ehContrato ? { duration: 5000 } : undefined)
      onSaved(); onClose()
    },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao processar'), { duration: 6000 }),
  })

  const itensOk = itens.length > 0 && itens.every(i => i.qtd > 0)
  // Comunicado: se já existe lançamento com esse número, o backend vincula e conclui
  // (não exige NF/valor). Para um comunicado novo, o backend cobra NF/valor.
  let valido = false
  if (ehContrato) valido = !!numeroPregao.trim() && !!numero.trim() && itensOk && (!(tipo === 'VENDA_DIRETA' && gerarOvJunto) || !!ovNumero.trim())
  else valido = !!numero.trim() && itensOk && !!clienteId && !!af.trim() && !!nomePaciente.trim() && !!prontuario.trim() && !!dataProcedimento

  return (
    <ModalBase titulo={<span className="flex items-center gap-2"><Flag size={17} /> Processar · {cfg.label}</span>} onClose={onClose}>
      <div className="p-5 space-y-3 overflow-y-auto">
        <div className="bg-gray-50 rounded-lg p-3 text-sm">
          <p className="font-medium text-gray-700">{demanda.cliente}</p>
          <p className="text-xs text-gray-400">
            {ehContrato
              ? 'Cria o contrato com as quantidades totais. As entregas/consumos baixam o saldo depois.'
              : 'Os itens já vieram da triagem — confira e informe só a NF e o valor (do D365). Ao lançar, a demanda é concluída e o faturamento entra no sistema.'}
          </p>
        </div>

        {ehContrato && (
          <div className="grid grid-cols-2 gap-3">
            <Campo label="Nº do Pregão *">
              <input value={numeroPregao} onChange={e => setNumeroPregao(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: 90051/2025" />
              {!numeroPregao.trim() && <p className="text-xs text-red-500 mt-1">Obrigatório — rege o contrato.</p>}
            </Campo>
            <Campo label="Nota de empenho (NE) *">
              <input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: 2026NE001246" />
            </Campo>
            {pregaoEncontrado && (
              <div className="col-span-2 bg-blue-50 border border-blue-200 rounded-lg p-2.5 text-xs text-blue-700">
                ✅ Pregão <strong>{pregaoEncontrado.numero}</strong> já cadastrado — {pregaoEncontrado.cliente} · {pregaoEncontrado.qtd_nes} NE(s) já lançada(s) · saldo a empenhar {fmtBRL(pregaoEncontrado.saldo_valor)}.
                Esta demanda vai virar <strong>mais uma NE (linha)</strong> desse contrato, consumindo o saldo — não um contrato novo.
              </div>
            )}
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

        {tipo === 'VENDA_DIRETA' && (
          <div className="border border-blue-100 bg-blue-50/40 rounded-lg p-3">
            <label className="flex items-center gap-2 text-sm text-gray-700 cursor-pointer">
              <input type="checkbox" checked={gerarOvJunto} onChange={e => setGerarOvJunto(e.target.checked)} className="rounded" />
              <span><strong>Entrega única</strong> — já gerar a OV cheia agora (baixa todo o saldo)</span>
            </label>
            {gerarOvJunto ? (
              <div className="grid grid-cols-2 gap-3 mt-2.5">
                <Campo label="Nº da OV *"><input value={ovNumero} onChange={e => setOvNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: OV016000" /></Campo>
                <Campo label="Entrega prevista"><input type="date" value={dataEntregaOv} onChange={e => setDataEntregaOv(e.target.value)} className={inputCls} /></Campo>
                <p className="col-span-2 text-[11px] text-gray-500">Cria o contrato <strong>e</strong> a OV com o total de uma vez. Depois é só <strong>cotar o frete</strong> e <strong>enviar a NF</strong> no painel.</p>
              </div>
            ) : (
              <p className="text-[11px] text-gray-400 mt-1">Se você entrega em partes, deixe desmarcado — as OVs você gera depois na aba <strong>Contratos</strong>, baixando o saldo aos poucos.</p>
            )}
          </div>
        )}

        {tipo === 'COMUNICADO_USO' && (
          <>
            <Campo label="Cliente / Órgão *">
              <ClienteAutocomplete value={clienteId} initialNome={clienteNome}
                onChange={(id, nome) => { setClienteId(id); setClienteNome(nome); setEmpenhoId('') }} />
              {clienteId
                ? <p className="text-xs text-green-600 mt-1">✅ {clienteNome}</p>
                : <p className="text-xs text-red-500 mt-1">Obrigatório — o faturamento entra no sistema com este cliente.</p>}
            </Campo>
            {empenhosCliente.length > 0 && (
              <Campo label="Baixar de um contrato de consignação (opcional)">
                <select value={empenhoId} onChange={e => setEmpenhoId(e.target.value)} className={inputCls}>
                  <option value="">Comunicado avulso (sem contrato)</option>
                  {empenhosCliente.map(e => <option key={e.id} value={e.id}>{e.numero} · saldo {fmtBRL(e.saldo_valor)}</option>)}
                </select>
              </Campo>
            )}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <Campo label="AF (Autorização de Fornecimento) *">
                <input value={af} onChange={e => setAf(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: AF123456" />
              </Campo>
              <Campo label="Nome do paciente *">
                <input value={nomePaciente} onChange={e => setNomePaciente(e.target.value)} className={inputCls} placeholder="Nome completo" />
              </Campo>
              <Campo label="Prontuário *">
                <input value={prontuario} onChange={e => setProntuario(e.target.value)} className={`${inputCls} font-mono`} placeholder="Ex: 000123" />
              </Campo>
              <Campo label="Data do procedimento *">
                <input type="date" value={dataProcedimento} onChange={e => setDataProcedimento(e.target.value)} className={inputCls} />
              </Campo>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Campo label="Nº do lançamento *"><input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: CU000123" /></Campo>
              <Campo label="Data do faturamento"><input type="date" value={dataFat} onChange={e => setDataFat(e.target.value)} className={inputCls} /></Campo>
              <Campo label="Número da NF *"><input value={nf} onChange={e => setNf(e.target.value)} className={`${inputCls} font-mono`} placeholder="Ex: 20045" /></Campo>
              <Campo label="Valor da NF (R$) *">
                <input type="number" step="0.01" value={valorNf} onChange={e => { setValorNf(e.target.value); setValorNfManual(true) }} className={inputCls} placeholder="0,00" />
                {sugestaoNf != null && (
                  <p className="text-xs text-blue-500 mt-1">💡 Calculado pelos preços do contrato: {fmtBRL(sugestaoNf)} — confira com a NF do D365.</p>
                )}
              </Campo>
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
          {concluir.isPending ? 'Processando…' : !ehContrato ? 'Concluir e faturar' : (tipo === 'VENDA_DIRETA' && gerarOvJunto) ? 'Criar contrato + gerar OV' : 'Criar contrato'}
        </button>
      </div>
    </ModalBase>
  )
}

// ════════════════════════════════════════════════════════════════════════════════
// ── Aba Relatório (tudo que já foi feito — VD, comunicado de uso, consignação) ───
function AbaRelatorio() {
  const navigate = useNavigate()
  const [tipo, setTipo] = useState('')
  const [canal, setCanal] = useState('')
  const [dataInicio, setDataInicio] = useState('')
  const [dataFim, setDataFim] = useState('')
  const [busca, setBusca] = useState('')

  const { data: itens = [], isLoading } = useQuery<any[]>({
    queryKey: ['relatorio-licitacoes', tipo, canal, dataInicio, dataFim],
    queryFn: () => api.get('/licitacoes/demandas/relatorio', {
      params: { tipo: tipo || undefined, canal: canal || undefined, data_inicio: dataInicio || undefined, data_fim: dataFim || undefined },
    }).then(r => r.data),
  })

  const filtrados = useMemo(() => {
    const b = busca.trim().toLowerCase()
    if (!b) return itens
    return itens.filter(d => {
      const alvo = `${d.cliente || ''} ${d.numero || ''} ${d.numero_pregao || ''} ${d.nome_paciente || ''} ${d.prontuario || ''} ${d.numero_nf || ''} ${d.gerado_ref || ''}`.toLowerCase()
      return alvo.includes(b)
    })
  }, [itens, busca])

  const totais = useMemo(() => {
    const porTipo: Record<string, { count: number; valor: number }> = {}
    let valorGeral = 0
    for (const d of filtrados) {
      const t = d.tipo_operacao
      if (!porTipo[t]) porTipo[t] = { count: 0, valor: 0 }
      porTipo[t].count++
      porTipo[t].valor += d.valor_total || 0
      valorGeral += d.valor_total || 0
    }
    return { porTipo, valorGeral }
  }, [filtrados])

  const exportarCsv = () => {
    const cols = ['Tipo', 'Data', 'Cliente', 'Pregão', 'NE/AF', 'Paciente', 'Prontuário', 'NF', 'Valor', 'Canal', 'Situação']
    const linhas = filtrados.map(d => [
      TIPO_MAP[d.tipo_operacao]?.label || d.tipo_operacao,
      fmtData(d.data_ref),
      d.cliente || '',
      d.numero_pregao || '',
      d.numero || '',
      d.nome_paciente || '',
      d.prontuario || '',
      d.numero_nf || '',
      d.valor_total ? d.valor_total.toFixed(2) : '',
      d.canal ? (CANAL_LABEL[d.canal] || d.canal) : '',
      ETAPA_LABEL[normEtapa(d.etapa)] || d.etapa,
    ])
    const csv = [cols, ...linhas].map(row => row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `relatorio-licitacoes-${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {TIPOS.map(t => (
          <div key={t.key} className="bg-white rounded-xl border border-gray-100 shadow-sm px-3 py-2">
            <p className="text-xl font-bold tabular-nums text-gray-800">{totais.porTipo[t.key]?.count || 0}</p>
            <p className="text-[11px] text-gray-500">{t.label}</p>
            <p className="text-[11px] text-gray-400">{fmtBRL(totais.porTipo[t.key]?.valor || 0)}</p>
          </div>
        ))}
        <div className="bg-blue-50 rounded-xl border border-blue-100 px-3 py-2">
          <p className="text-xl font-bold tabular-nums text-blue-700">{filtrados.length}</p>
          <p className="text-[11px] text-blue-600">Total no filtro</p>
          <p className="text-[11px] text-blue-500">{fmtBRL(totais.valorGeral)}</p>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[220px] max-w-xs">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={busca} onChange={e => setBusca(e.target.value)}
            placeholder="Buscar cliente, pregão, AF, paciente, prontuário, NF…"
            className="w-full border rounded-lg pl-9 pr-3 py-2 text-sm" />
        </div>
        <select value={tipo} onChange={e => setTipo(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
          <option value="">Todos os tipos</option>
          {TIPOS.map(t => <option key={t.key} value={t.key}>{t.label}</option>)}
        </select>
        <select value={canal} onChange={e => setCanal(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
          <option value="">Todos os canais</option>
          {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
        </select>
        <input type="date" value={dataInicio} onChange={e => setDataInicio(e.target.value)} title="De" className="border rounded-lg px-3 py-2 text-sm" />
        <input type="date" value={dataFim} onChange={e => setDataFim(e.target.value)} title="Até" className="border rounded-lg px-3 py-2 text-sm" />
        <button onClick={exportarCsv}
          className="flex items-center gap-1.5 text-sm border rounded-lg px-3 py-2 text-gray-600 hover:bg-gray-50">
          <Download size={15} /> Exportar CSV
        </button>
      </div>

      {isLoading ? (
        <p className="text-center text-gray-400 py-10 text-sm">Carregando...</p>
      ) : filtrados.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-10 text-center text-gray-400 text-sm">Nada encontrado com esses filtros.</div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-gray-50 text-[11px] uppercase text-gray-400 text-left border-b">
                <th className="px-3 py-2 font-medium">Tipo</th>
                <th className="px-3 py-2 font-medium">Data</th>
                <th className="px-3 py-2 font-medium">Cliente</th>
                <th className="px-3 py-2 font-medium">Pregão / AF-NE</th>
                <th className="px-3 py-2 font-medium">Paciente / Prontuário</th>
                <th className="px-3 py-2 font-medium">NF</th>
                <th className="px-3 py-2 font-medium">Canal</th>
                <th className="px-3 py-2 font-medium">Situação</th>
                <th className="px-3 py-2 font-medium text-right">Valor</th>
                <th className="px-3 py-2 font-medium text-right">Ação</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {filtrados.map(d => {
                const cfg = TIPO_MAP[d.tipo_operacao] || TIPOS[0]
                const Icone = cfg.icone
                const ovId = (d.ovs_detalhe || [])[0]?.id || (d.gerado_tipo === 'COMUNICADO' ? d.gerado_id : null)
                return (
                  <tr key={d.id} className="hover:bg-gray-50/60">
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${cfg.chip}`}><Icone size={12} /> {cfg.label}</span>
                    </td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{fmtData(d.data_ref)}</td>
                    <td className="px-3 py-2 font-medium text-gray-800 max-w-[180px] truncate">{d.cliente || '—'}</td>
                    <td className="px-3 py-2 font-mono text-gray-600 whitespace-nowrap">
                      {d.numero_pregao && <span className="block">{d.numero_pregao}</span>}
                      {d.numero && <span className="block text-gray-400">{d.tipo_operacao === 'COMUNICADO_USO' ? `AF ${d.numero}` : d.numero}</span>}
                      {!d.numero_pregao && !d.numero && '—'}
                    </td>
                    <td className="px-3 py-2 text-gray-500">
                      {d.tipo_operacao === 'COMUNICADO_USO' ? (
                        <>
                          {d.nome_paciente && <span className="block text-gray-700">{d.nome_paciente}</span>}
                          {d.prontuario && <span className="block font-mono text-[11px]">{d.prontuario}</span>}
                          {!d.nome_paciente && !d.prontuario && '—'}
                        </>
                      ) : '—'}
                    </td>
                    <td className="px-3 py-2 font-mono text-gray-600 whitespace-nowrap">{d.numero_nf || '—'}</td>
                    <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{d.canal ? (CANAL_LABEL[d.canal] || d.canal) : '—'}</td>
                    <td className="px-3 py-2 whitespace-nowrap">
                      <span className={`text-xs ${ehFinal(d) ? 'text-emerald-600' : 'text-amber-600'}`}>{ehFinal(d) ? '✓ ' : '⏳ '}{ETAPA_LABEL[normEtapa(d.etapa)] || d.etapa}</span>
                    </td>
                    <td className="px-3 py-2 text-right font-medium tabular-nums text-gray-800">{d.valor_total ? fmtBRL(d.valor_total) : '—'}</td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {ovId ? (
                        <button onClick={() => navigate(`/expedicao/${ovId}`)} className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline">
                          <ExternalLink size={12} /> Abrir
                        </button>
                      ) : <span className="text-gray-300">—</span>}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ════════════════════════════════════════════════════════════════════════════════
// ── Aba Contratos (venda direta + consignação, com saldo) ────────────────────────
function AbaContratos() {
  const qc = useQueryClient()
  const [novoPregao, setNovoPregao] = useState(false)
  const [abertoId, setAbertoId] = useState<string | null>(null)
  const [pregaoMestreId, setPregaoMestreId] = useState<string | null>(null)
  const [tipoFiltro, setTipoFiltro] = useState('')

  const { data: pregoes = [], isLoading } = useQuery<any[]>({
    queryKey: ['pregoes'],
    queryFn: () => api.get('/licitacoes/pregoes').then(r => r.data),
  })

  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ['pregoes'] })
    qc.invalidateQueries({ queryKey: ['empenhos'] })
    if (abertoId) qc.invalidateQueries({ queryKey: ['empenho', abertoId] })
  }

  const pregoesFiltrados = tipoFiltro ? pregoes.filter(p => (p.tipo || 'VENDA_DIRETA') === tipoFiltro) : pregoes
  const pregaoMestreAberto = pregoes.find(p => p.id === pregaoMestreId) || null

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex gap-1">
          <button onClick={() => setTipoFiltro('')} className={`text-sm px-3 py-1.5 rounded-lg ${!tipoFiltro ? 'bg-blue-600 text-white' : 'bg-white border text-gray-600'}`}>Todos</button>
          {Object.entries(CONTRATO_TIPO).map(([k, v]) => (
            <button key={k} onClick={() => setTipoFiltro(k)} className={`text-sm px-3 py-1.5 rounded-lg ${tipoFiltro === k ? 'bg-blue-600 text-white' : 'bg-white border text-gray-600'}`}>{v.label}</button>
          ))}
        </div>
        <button onClick={() => setNovoPregao(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg">
          <Plus size={16} /> Novo pregão
        </button>
      </div>

      {isLoading ? (
        <p className="text-center text-gray-400 py-10 text-sm">Carregando...</p>
      ) : pregoesFiltrados.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-10 text-center text-gray-400 text-sm">
          Nenhum pregão. Clique em <strong>Novo pregão</strong> para cadastrar um contrato ganho e depois lançar as notas de empenho.
        </div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {pregoesFiltrados.map((p) => {
                const tp = CONTRATO_TIPO[p.tipo || 'VENDA_DIRETA'] || CONTRATO_TIPO.VENDA_DIRETA
                const concluido = p.empenhado_valor > 0 && p.saldo_valor <= 0.005
                return (
                  <button key={p.id} onClick={() => setPregaoMestreId(p.id)}
                    className="bg-white rounded-xl border border-gray-100 shadow-sm p-4 text-left hover:border-blue-300 hover:shadow transition">
                    <div className="flex items-start justify-between mb-1">
                      <div>
                        <p className="font-mono font-bold text-gray-800">Pregão {p.numero}</p>
                        <p className="text-[11px] font-mono text-gray-400">
                          {p.qtd_nes} NE{p.qtd_nes === 1 ? '' : 's'}{p.qtd_nes ? `: ${p.nes.map((n: any) => n.numero).join(' · ')}` : ' — nenhuma ainda'}
                        </p>
                        <p className="text-sm text-gray-600 truncate max-w-[240px]">{p.cliente}</p>
                        <div className="flex items-center gap-2 mt-1">
                          <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${tp.cor}`}>{tp.label}</span>
                          {p.canal && <span className="text-xs text-gray-400">{CANAL_LABEL[p.canal] || p.canal}</span>}
                        </div>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${concluido ? 'bg-emerald-100 text-emerald-700' : 'bg-blue-100 text-blue-700'}`}>
                        {concluido ? 'Empenhado 100%' : 'Aberto'}
                      </span>
                    </div>
                    <div className="h-2 rounded-full bg-gray-100 overflow-hidden my-2">
                      <div className="h-full rounded-full bg-indigo-500 transition-all" style={{ width: `${Math.min(p.percentual_empenhado, 100)}%` }} />
                    </div>
                    <div className="flex justify-between text-xs text-gray-500">
                      <span>Empenhado {fmtBRL(p.empenhado_valor)} · {p.percentual_empenhado}%</span>
                      <span className="font-semibold text-gray-700">A empenhar {fmtBRL(p.saldo_valor)}</span>
                    </div>
                    <div className="flex justify-between items-center text-[11px] text-gray-400 mt-1.5">
                      <span>Total {fmtBRL(p.total_valor)} · entregue {fmtBRL(p.entregue_valor)}</span>
                      <span>Vigência: {fmtData(p.vigencia)}</span>
                    </div>
                  </button>
                )
          })}
        </div>
      )}

      {pregaoMestreAberto && (
        <ModalPregaoMestre
          pregao={pregaoMestreAberto}
          onClose={() => setPregaoMestreId(null)}
          onAbrirNE={(neId: string) => setAbertoId(neId)}
          onChanged={invalidar}
        />
      )}
      {novoPregao && <ModalNovoPregao onClose={() => setNovoPregao(false)} onSaved={invalidar} />}
      {abertoId && <ModalContrato id={abertoId} onClose={() => setAbertoId(null)} onChanged={invalidar} />}
    </div>
  )
}

// ── Novo / Editar Pregão (mestre, com o total ganho) ─────────────────────────────
function ModalNovoPregao({ onClose, onSaved, pregao }: { onClose: () => void; onSaved: () => void; pregao?: any }) {
  const hoje = new Date().toISOString().slice(0, 10)
  const edicao = !!pregao?.id
  const [tipo, setTipo] = useState<'VENDA_DIRETA' | 'CONSIGNACAO'>(pregao?.tipo === 'CONSIGNACAO' ? 'CONSIGNACAO' : 'VENDA_DIRETA')
  const [numero, setNumero] = useState(pregao?.numero || '')
  const [clienteId, setClienteId] = useState(pregao?.cliente_id || '')
  const [clienteNome, setClienteNome] = useState(pregao?.cliente || '')
  const [canal, setCanal] = useState(pregao?.canal || 'LICITACAO_URO')
  const [data, setData] = useState(pregao?.data || hoje)
  const [vigencia, setVigencia] = useState(pregao?.vigencia || '')
  const [observacao, setObservacao] = useState(pregao?.observacao || '')
  const [itens, setItens] = useState<ItemLinha[]>(
    (pregao?.itens || []).map((i: any) => ({
      produto_id: i.produto_id, codigo: i.codigo || '', descricao: i.descricao || '',
      qtd: Number(i.qtd_total) || 0, valor: Number(i.valor_unitario) || 0,
    }))
  )

  const criar = useMutation({
    mutationFn: () => {
      const body = {
        numero: numero.trim(), cliente_id: clienteId, tipo, canal,
        data: data || null, vigencia: vigencia || null, observacao: observacao || null,
        itens: itens.map(i => ({ produto_id: i.produto_id, qtd_total: i.qtd, valor_unitario: i.valor || 0 })),
      }
      return edicao ? api.put(`/licitacoes/pregoes/${pregao.id}`, body) : api.post('/licitacoes/pregoes', body)
    },
    onSuccess: () => { toast.success(edicao ? 'Pregão atualizado' : 'Pregão cadastrado'); onSaved(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao salvar pregão')),
  })
  const valido = numero.trim() && clienteId && itens.length > 0

  return (
    <ModalBase titulo={edicao ? 'Editar pregão' : 'Novo pregão (contrato ganho)'} onClose={onClose}>
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
        <p className="text-[11px] text-gray-400 -mt-1">Cadastre o TOTAL ganho no pregão. Depois lance as notas de empenho (NE) — cada uma consome parte desse total.</p>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Nº do Pregão *"><input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: 90051/2025" /></Campo>
          <Campo label="Canal *">
            <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
              {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
            </select>
          </Campo>
          <Campo label="Data"><input type="date" value={data} onChange={e => setData(e.target.value)} className={inputCls} /></Campo>
          <Campo label="Vigência (até)"><input type="date" value={vigencia} onChange={e => setVigencia(e.target.value)} className={inputCls} /></Campo>
        </div>
        <Campo label="Cliente / Órgão *">
          <ClienteAutocomplete value={clienteId} initialNome={clienteNome} onChange={(id, nome) => { setClienteId(id); setClienteNome(nome) }} />
          {clienteId && <p className="text-xs text-green-600 mt-1">✅ {clienteNome}</p>}
        </Campo>
        <Campo label="Observação"><input value={observacao} onChange={e => setObservacao(e.target.value)} className={inputCls} placeholder="Opcional" /></Campo>
        <div>
          <label className="text-sm text-gray-600">Itens do pregão (total ganho) *</label>
          <p className="text-xs text-gray-400 mb-1.5">Produto, quantidade TOTAL do pregão e valor unitário.</p>
          <ItensPedido value={itens} onChange={setItens} comValor />
        </div>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => criar.mutate()} disabled={!valido || criar.isPending}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {criar.isPending ? 'Salvando...' : edicao ? 'Salvar alterações' : 'Cadastrar pregão'}
        </button>
      </div>
    </ModalBase>
  )
}

// ── Modal do Pregão mestre — total/empenhado/saldo + NEs + Nova NE ────────────────
function ModalPregaoMestre({ pregao, onClose, onAbrirNE, onChanged }: {
  pregao: any; onClose: () => void; onAbrirNE: (neId: string) => void; onChanged: () => void
}) {
  const [novaNE, setNovaNE] = useState(false)
  const [editar, setEditar] = useState(false)
  const semNes = pregao.nes.length === 0
  const excluir = useMutation({
    mutationFn: () => api.delete(`/licitacoes/pregoes/${pregao.id}`),
    onSuccess: () => { toast.success('Pregão excluído'); onChanged(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao excluir')),
  })
  return (
    <ModalBase titulo={<span className="font-mono">Pregão {pregao.numero}</span>} onClose={onClose} max="max-w-3xl">
      <div className="p-5 space-y-4 overflow-y-auto">
        <div className="flex items-start justify-between gap-3">
          <div>
            <p className="text-sm text-gray-700 font-medium">{pregao.cliente}</p>
            <p className="text-xs text-gray-400">{pregao.canal ? (CANAL_LABEL[pregao.canal] || pregao.canal) : ''} · Vigência {fmtData(pregao.vigencia)}</p>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={() => setEditar(true)} className="text-xs px-2.5 py-1.5 border rounded-lg text-gray-600 hover:bg-gray-50">✏️ Corrigir</button>
            {semNes && (
              <button onClick={() => { if (confirm('Excluir este pregão? Só é possível porque ainda não há NEs lançadas.')) excluir.mutate() }}
                className="text-xs px-2.5 py-1.5 border border-red-200 rounded-lg text-red-600 hover:bg-red-50">🗑 Excluir</button>
            )}
          </div>
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="bg-gray-50 rounded-xl p-3"><p className="text-[11px] text-gray-400 uppercase">Total ganho</p><p className="text-base font-bold text-gray-800 tabular-nums">{fmtBRL(pregao.total_valor)}</p></div>
          <div className="bg-gray-50 rounded-xl p-3"><p className="text-[11px] text-gray-400 uppercase">Empenhado</p><p className="text-base font-bold text-indigo-600 tabular-nums">{fmtBRL(pregao.empenhado_valor)}</p></div>
          <div className="bg-gray-50 rounded-xl p-3"><p className="text-[11px] text-gray-400 uppercase">A empenhar</p><p className="text-base font-bold text-blue-600 tabular-nums">{fmtBRL(pregao.saldo_valor)}</p></div>
          <div className="bg-gray-50 rounded-xl p-3"><p className="text-[11px] text-gray-400 uppercase">Entregue</p><p className="text-base font-bold text-emerald-600 tabular-nums">{fmtBRL(pregao.entregue_valor)}</p></div>
        </div>

        {/* Itens do pregão */}
        <div>
          <h3 className="text-sm font-semibold text-gray-700 mb-2">Itens do pregão · saldo a empenhar</h3>
          <div className="overflow-x-auto border border-gray-100 rounded-lg">
            <table className="w-full text-sm">
              <thead><tr className="text-[11px] uppercase text-gray-400 text-left border-b bg-gray-50">
                <th className="py-2 px-3">Código</th><th className="py-2 px-3">Descrição</th>
                <th className="py-2 px-3 text-right">Total</th><th className="py-2 px-3 text-right">Empenhado</th><th className="py-2 px-3 text-right">Saldo</th>
              </tr></thead>
              <tbody className="divide-y divide-gray-50">
                {pregao.itens.map((i: any) => (
                  <tr key={i.produto_id}>
                    <td className="py-2 px-3 font-mono text-gray-700">{i.codigo}</td>
                    <td className="py-2 px-3 text-gray-600 truncate max-w-[240px]">{i.descricao}</td>
                    <td className="py-2 px-3 text-right tabular-nums">{i.qtd_total}</td>
                    <td className="py-2 px-3 text-right tabular-nums text-indigo-600">{i.qtd_empenhada}</td>
                    <td className="py-2 px-3 text-right tabular-nums font-medium text-gray-800">{i.qtd_saldo}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* NEs */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-semibold text-gray-700">Notas de empenho ({pregao.nes.length})</h3>
            <button onClick={() => setNovaNE(true)} disabled={pregao.saldo_un <= 0}
              className="flex items-center gap-1 text-sm text-blue-600 hover:text-blue-500 font-medium disabled:opacity-40">
              <Plus size={15} /> Nova NE
            </button>
          </div>
          {pregao.nes.length === 0 ? (
            <p className="text-sm text-gray-400 py-2">Nenhuma NE lançada ainda. Clique em "Nova NE" conforme forem chegando.</p>
          ) : (
            <div className="space-y-2">
              {pregao.nes.map((n: any) => (
                <button key={n.id} onClick={() => onAbrirNE(n.id)}
                  className="w-full text-left border border-gray-100 rounded-xl p-3 hover:border-blue-300 hover:shadow-sm transition">
                  <div className="flex items-center justify-between">
                    <div>
                      <p className="font-mono font-semibold text-gray-800">NE {n.numero}</p>
                      <span className="text-[11px] text-gray-400">Vigência {fmtData(n.vigencia)}</span>
                    </div>
                    <div className="text-right">
                      <p className="text-sm font-semibold text-gray-700 tabular-nums">Saldo {fmtBRL(n.saldo_valor)}</p>
                      <p className="text-[11px] text-gray-400 tabular-nums">empenhado {fmtBRL(n.empenhado_valor)} · entregue {fmtBRL(n.faturado_valor)}</p>
                    </div>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      {novaNE && <ModalNovaNE pregao={pregao} onClose={() => setNovaNE(false)} onSaved={() => { setNovaNE(false); onChanged() }} />}
      {editar && <ModalNovoPregao pregao={pregao} onClose={() => setEditar(false)} onSaved={() => { setEditar(false); onChanged() }} />}
    </ModalBase>
  )
}

// ── Nova NE dentro do pregão (consome o saldo por item) ──────────────────────────
function ModalNovaNE({ pregao, onClose, onSaved }: { pregao: any; onClose: () => void; onSaved: () => void }) {
  const [numero, setNumero] = useState('')
  const [data, setData] = useState(new Date().toISOString().slice(0, 10))
  const [vigencia, setVigencia] = useState('')
  const disponiveis = pregao.itens.filter((i: any) => i.qtd_saldo > 0)
  const [qtds, setQtds] = useState<Record<string, string>>({})

  const criar = useMutation({
    mutationFn: () => api.post(`/licitacoes/pregoes/${pregao.id}/nes`, {
      numero: numero.trim(), data_empenho: data || null, vigencia: vigencia || null,
      itens: disponiveis
        .filter((i: any) => Number(qtds[i.produto_id]) > 0)
        .map((i: any) => ({ produto_id: i.produto_id, qtd: Number(qtds[i.produto_id]) })),
    }),
    onSuccess: () => { toast.success('NE lançada'); onSaved() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao lançar NE')),
  })
  const algumItem = disponiveis.some((i: any) => Number(qtds[i.produto_id]) > 0)
  const valido = numero.trim() && algumItem

  return (
    <ModalBase titulo={<span className="font-mono">Nova NE · Pregão {pregao.numero}</span>} onClose={onClose} max="max-w-lg">
      <div className="p-5 space-y-3 overflow-y-auto">
        <div className="grid grid-cols-3 gap-3">
          <Campo label="Nota de empenho (NE) *"><input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: 2026NE001246" /></Campo>
          <Campo label="Data"><input type="date" value={data} onChange={e => setData(e.target.value)} className={inputCls} /></Campo>
          <Campo label="Vigência"><input type="date" value={vigencia} onChange={e => setVigencia(e.target.value)} className={inputCls} /></Campo>
        </div>
        <div>
          <label className="text-sm text-gray-600">Quantidades desta NE *</label>
          <p className="text-xs text-gray-400 mb-1.5">Informe quanto desta NE por item (limitado ao saldo do pregão).</p>
          {disponiveis.length === 0 ? (
            <p className="text-sm text-gray-400 py-2">Pregão sem saldo a empenhar.</p>
          ) : (
            <div className="border border-gray-100 rounded-lg divide-y divide-gray-50">
              {disponiveis.map((i: any) => (
                <div key={i.produto_id} className="flex items-center gap-2 px-3 py-2 text-sm">
                  <div className="flex-1 min-w-0">
                    <span className="font-mono text-gray-700">{i.codigo}</span>
                    <span className="text-gray-500 ml-2 truncate">{i.descricao}</span>
                    <span className="text-[11px] text-gray-400 ml-1">(saldo {i.qtd_saldo})</span>
                  </div>
                  <input type="number" min="0" max={i.qtd_saldo} value={qtds[i.produto_id] || ''}
                    onChange={e => setQtds(q => ({ ...q, [i.produto_id]: e.target.value }))}
                    className="w-24 border rounded-lg px-2 py-1 text-sm text-right" placeholder="0" />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => criar.mutate()} disabled={!valido || criar.isPending}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {criar.isPending ? 'Lançando...' : 'Lançar NE'}
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
    <ModalBase titulo={<span className="flex items-center gap-2 font-mono">{emp.numero_pregao ? `Pregão ${emp.numero_pregao}` : emp.numero} <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${cfg.cor}`}>{cfg.label}</span></span>} onClose={onClose} max="max-w-3xl">
      <div className="flex-1 overflow-y-auto">
        <div className="px-5 py-4 bg-gray-50 border-b">
          <div className="flex items-center gap-2">
            <span className={`text-[11px] px-1.5 py-0.5 rounded-full ${tp.cor}`}>{tp.label}</span>
            <p className="text-sm text-gray-700 font-medium">{emp.cliente}</p>
          </div>
          <p className="text-xs text-gray-400 mt-0.5">
            <>NE: <span className="font-mono">{emp.numero}</span> · </>
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
          <Campo label="Data esperada pelo cliente *"><input type="date" value={dataEntrega} min={hoje} onChange={e => setDataEntrega(e.target.value)} className={inputCls} /></Campo>
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
        <Campo label="Local de entrega"><LocalEntregaInput value={local} onChange={setLocal} /></Campo>
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

  // Busca por texto (pregão / NE / cliente / OV) varre TODAS as concluídas.
  const [busca, setBusca] = useState('')
  const [termo, setTermo] = useState('')
  useEffect(() => { const t = setTimeout(() => setTermo(busca.trim()), 300); return () => clearTimeout(t) }, [busca])
  const buscando = termo.length >= 2

  const { data: itensDia = [], isLoading: loadingDia } = useQuery<any[]>({
    queryKey: ['demandas-historico', sel],
    queryFn: () => api.get(`/licitacoes/demandas/historico?data=${sel}`).then(r => r.data),
    enabled: !!sel && !buscando,
  })
  const { data: itensBusca = [], isLoading: loadingBusca } = useQuery<any[]>({
    queryKey: ['demandas-historico-busca', termo],
    queryFn: () => api.get(`/licitacoes/demandas/historico/buscar?q=${encodeURIComponent(termo)}`).then(r => r.data),
    enabled: buscando,
  })
  const itens = buscando ? itensBusca : itensDia
  const isLoading = buscando ? loadingBusca : loadingDia

  const situacaoLabel = (d: any) => ETAPA_LABEL[normEtapa(d.etapa)] || d.etapa

  return (
    <ModalBase titulo="Pesquisar tudo (evita retrabalho)" onClose={onClose} max="max-w-5xl">
      <div className="p-5 space-y-3 overflow-y-auto">
        <div className="relative">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            value={busca}
            onChange={e => setBusca(e.target.value)}
            placeholder="Buscar por pregão, NE, AF, paciente, prontuário, OV ou cliente — mesmo o que ainda está em andamento…"
            className={`${inputCls} pl-9`}
            autoFocus
          />
          {busca && (
            <button onClick={() => setBusca('')} className="absolute right-3 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 text-xs">limpar</button>
          )}
        </div>
        <p className="text-[11px] text-gray-400 -mt-1">Confira aqui antes de criar uma demanda nova — a busca cobre tudo, concluído ou não, para você nunca processar o mesmo caso duas vezes.</p>
        {datas.length === 0 && !buscando ? (
          <p className="text-sm text-gray-400 text-center py-6">Nenhuma demanda concluída ainda. Use a busca acima para achar algo em andamento.</p>
        ) : (
          <>
            <div className="flex items-end justify-between gap-3 flex-wrap">
              <div className={`flex-1 min-w-[220px] ${buscando ? 'opacity-40 pointer-events-none' : ''}`}>
                <Campo label="Dia">
                  <select value={sel} onChange={e => setSel(e.target.value)} className={inputCls} disabled={buscando}>
                    {datas.map((d: any) => <option key={d.data} value={d.data}>{fmtData(d.data)} · {d.total} concluída(s)</option>)}
                  </select>
                </Campo>
              </div>
              <p className="text-xs text-gray-400 pb-2.5">
                {buscando ? `${itens.length} resultado(s) para "${termo}"` : `${itens.length} registro(s) em ${fmtData(sel)}`}
              </p>
            </div>
            {isLoading ? (
              <p className="text-sm text-gray-400 text-center py-4">{buscando ? 'Buscando…' : 'Carregando…'}</p>
            ) : itens.length === 0 ? (
              <p className="text-sm text-gray-400 text-center py-4">{buscando ? `Nada encontrado para "${termo}".` : 'Sem concluídas neste dia.'}</p>
            ) : (
              <div className="border border-gray-100 rounded-lg overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="bg-gray-50 text-[11px] uppercase text-gray-400 text-left">
                      <th className="font-medium px-3 py-2">Tipo</th>
                      <th className="font-medium px-3 py-2">Cliente / Órgão</th>
                      <th className="font-medium px-3 py-2">Nº</th>
                      <th className="font-medium px-3 py-2">Canal</th>
                      <th className="font-medium px-3 py-2">Situação</th>
                      <th className="font-medium px-3 py-2">D365 / OV</th>
                      <th className="font-medium px-3 py-2 text-right">Ação</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {itens.map((d: any) => {
                      const cfg = TIPO_MAP[d.tipo_operacao] || TIPOS[0]
                      const Icone = cfg.icone
                      const ref = d.ref_externa || d.gerado_ref
                      return (
                        <tr key={d.id} className="hover:bg-gray-50/60">
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span className={`inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full ${cfg.chip}`}><Icone size={12} /> {cfg.label}</span>
                          </td>
                          <td className="px-3 py-2 font-medium text-gray-800">{d.cliente || 'Cliente não informado'}</td>
                          <td className="px-3 py-2 font-mono text-gray-600 whitespace-nowrap">
                            {d.numero || '—'}
                            {d.tipo_operacao === 'COMUNICADO_USO' && (d.nome_paciente || d.prontuario) && (
                              <span className="block text-[11px] text-gray-400 font-sans">{d.nome_paciente}{d.nome_paciente && d.prontuario ? ' · ' : ''}{d.prontuario && `Pront. ${d.prontuario}`}</span>
                            )}
                          </td>
                          <td className="px-3 py-2 text-gray-500 whitespace-nowrap">{d.canal ? (CANAL_LABEL[d.canal] || d.canal) : '—'}</td>
                          <td className="px-3 py-2 whitespace-nowrap">
                            <span className={`text-xs ${ehFinal(d) ? 'text-emerald-600' : 'text-amber-600'}`}>{ehFinal(d) ? '✓ ' : '⏳ '}{situacaoLabel(d)}</span>
                            {buscando && d.concluido_em && <span className="block text-[11px] text-gray-400">{fmtData(d.concluido_em)}</span>}
                          </td>
                          <td className="px-3 py-2 font-mono text-emerald-700 whitespace-nowrap">{ref || '—'}</td>
                          <td className="px-3 py-2 text-right whitespace-nowrap">
                            {(d.ovs_detalhe || []).length > 0 || (d.gerado_tipo === 'COMUNICADO' && d.gerado_id) ? (
                              <button onClick={() => navigate(`/expedicao/${(d.ovs_detalhe || [])[0]?.id || d.gerado_id}`)}
                                className="inline-flex items-center gap-1 text-xs text-indigo-600 hover:underline">
                                <ExternalLink size={12} /> Abrir
                              </button>
                            ) : <span className="text-gray-300">—</span>}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
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
// ── Sem estoque (aguardando PCP) ─────────────────────────────────────────────────
function ModalSemEstoque({ demanda, onClose, onSaved }: { demanda: any; onClose: () => void; onSaved: () => void }) {
  const est = demanda.estoque || {}
  const [previsao, setPrevisao] = useState(est.previsao_pcp || '')
  const [prazo, setPrazo] = useState(demanda.prazo || '')
  const [obs, setObs] = useState(est.observacao || '')
  // Itens da triagem viram chips selecionáveis (o que está faltando).
  const itens: string[] = (demanda.itens || [])
    .map((i: any) => (i.codigo || i.descricao || '').toString().trim())
    .filter(Boolean)
  const [faltantes, setFaltantes] = useState<string[]>(est.itens_faltantes || [])
  const toggle = (c: string) => setFaltantes(f => f.includes(c) ? f.filter(x => x !== c) : [...f, c])

  // Risco de multa: previsão do PCP depois do prazo do contrato.
  const risco = !!prazo && !!previsao && previsao > prazo

  const salvar = useMutation({
    mutationFn: () => api.post(`/licitacoes/demandas/${demanda.id}/sem-estoque`, {
      previsao_pcp: previsao || null,
      prazo: prazo || null,
      itens_faltantes: faltantes,
      observacao: obs || null,
    }),
    onSuccess: () => { toast.success('Marcado como sem estoque — fica visível até o material chegar'); onSaved(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao marcar sem estoque')),
  })

  return (
    <ModalBase titulo={`Sem estoque · ${demanda.cliente || ''}`} onClose={onClose} max="max-w-md">
      <div className="p-5 space-y-3">
        <div className="bg-orange-50 rounded-lg p-2.5 text-xs text-orange-700">
          🏭 Este pedido vai para a coluna <strong>Aguardando estoque (PCP)</strong> e <strong>não sai do painel</strong> até o estoque chegar — assim ninguém esquece. Informe a <strong>previsão do PCP</strong> e o <strong>prazo do contrato</strong> para o app alertar risco de multa.
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Previsão do PCP">
            <input type="date" value={previsao} onChange={e => setPrevisao(e.target.value)} className={inputCls} />
          </Campo>
          <Campo label="Prazo de entrega (contrato)">
            <input type="date" value={prazo} onChange={e => setPrazo(e.target.value)} className={inputCls} />
          </Campo>
        </div>
        {risco && (
          <div className="bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-xs text-red-700 flex items-center gap-1.5">
            <AlertTriangle size={14} /> A previsão do PCP <strong>passa do prazo do contrato</strong> — risco de multa. Priorize com o PCP.
          </div>
        )}
        {itens.length > 0 && (
          <div>
            <label className="text-sm text-gray-600">Itens em falta (opcional)</label>
            <div className="flex flex-wrap gap-1.5 mt-1.5">
              {itens.map(c => (
                <button key={c} type="button" onClick={() => toggle(c)}
                  className={`text-xs px-2.5 py-1 rounded-full border transition ${faltantes.includes(c) ? 'bg-orange-100 border-orange-300 text-orange-700 font-medium' : 'border-gray-200 text-gray-500 hover:border-gray-300'}`}>
                  {faltantes.includes(c) ? '✓ ' : ''}{c}
                </button>
              ))}
            </div>
          </div>
        )}
        <Campo label="Observação (opcional)">
          <input value={obs} onChange={e => setObs(e.target.value)} className={inputCls} placeholder="Ex: PCP confirmou produção para a semana que vem" />
        </Campo>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => salvar.mutate()} disabled={salvar.isPending}
          className="px-4 py-2 text-sm bg-orange-600 hover:bg-orange-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {salvar.isPending ? 'Salvando…' : 'Marcar sem estoque'}
        </button>
      </div>
    </ModalBase>
  )
}

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
  // NF já registrada no faturamento da OV vinculada → pré-preenche (sem redigitar)
  const nfDaOv = (demanda.ovs_detalhe || []).map((o: any) => o.nf).find(Boolean) || ''
  const [numero, setNumero] = useState(demanda.nf?.numero || nfDaOv)
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
          <Campo label="Data esperada pelo cliente *"><input type="date" value={dataEntrega} min={hoje} onChange={e => setDataEntrega(e.target.value)} className={inputCls} /></Campo>
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
        <Campo label="Local de entrega"><LocalEntregaInput value={local} onChange={setLocal} /></Campo>
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
  const [valorManual, setValorManual] = useState(false)
  const [data, setData] = useState(hoje)
  const [canal, setCanal] = useState(emp.canal || 'LICITACAO_URO')
  const [qtds, setQtds] = useState<Record<string, string>>({})

  // Valor da NF calculado pelos preços do contrato (Σ qtd × valor unitário).
  // Atualiza sozinho conforme as quantidades, até o usuário editar manualmente.
  const selecionados = comSaldo.filter((i: any) => Number(qtds[i.produto_id]) > 0)
  const sugestaoNf = selecionados.length > 0 && selecionados.every((i: any) => Number(i.valor_unitario) > 0)
    ? selecionados.reduce((s: number, i: any) => s + Number(qtds[i.produto_id]) * Number(i.valor_unitario), 0)
    : null
  useEffect(() => {
    if (!valorManual && sugestaoNf != null) setValor(sugestaoNf.toFixed(2))
  }, [sugestaoNf, valorManual])

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
          <Campo label="Valor da NF (R$) *">
            <input type="number" step="0.01" value={valor} onChange={e => { setValor(e.target.value); setValorManual(true) }} className={inputCls} placeholder="0,00" />
            {sugestaoNf != null && (
              <p className="text-xs text-blue-500 mt-1">💡 Calculado pelos preços do contrato: {fmtBRL(sugestaoNf)} — confira com a NF do D365.</p>
            )}
          </Campo>
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
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className={`bg-white rounded-2xl w-full ${max} max-h-[88vh] flex flex-col`}>
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

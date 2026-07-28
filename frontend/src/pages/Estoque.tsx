import { useMemo, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Boxes, Search, X, RefreshCw, AlertTriangle, Download, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import api from '../lib/api'
import { msgErro } from '../lib/crm'
import { STATUS_CONFIG } from '../lib/statusConfig'

interface ItemEstoque {
  codigo: string
  descricao?: string
  familia?: string
  linha?: string
  estoque_pcp: number
  estoque_sa: number
  comprometido: number
  disponivel: number
  consumo_medio: number
  cobertura_pcp: number | null
  cobertura_disponivel: number | null
  status: string
  vendido_mes_atual: number
  tendencia_pct: number | null
  media_3m: number | null
  media_3m_anterior: number | null
}
interface Resposta {
  itens: ItemEstoque[]
  data_ref: string | null
  sincronizado_em: string | null
  desatualizado: boolean
  mes_atual: string
  ultimo_mes_fechado: string
  integracao: boolean
  sync?: { sincronizou: boolean; motivo: string | null; itens: number } | null
}
interface OvComprometida {
  pedido_id: string
  numero_pedido: string
  status: string
  cliente: string | null
  qtd: number
  criado_em: string | null
  faturada_depois_da_foto: boolean
}
interface HistoricoVendas {
  codigo: string
  descricao: string | null
  meses: { mes: string; qtd: number }[]
  total_fechado: number
  consumo_medio: number | null
  cobertura_atual: number | null
  tendencia_pct: number | null
  media_3m: number | null
  media_3m_anterior: number | null
  vendido_mes_atual: number
  mes_atual: string
}

function fmtMes(mes: string) {
  const [ano, m] = mes.split('-')
  const nomes = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
  return `${nomes[Number(m) - 1]}/${ano.slice(2)}`
}

// Tendência vem do histórico do PCP: média dos 3 últimos meses fechados contra
// os 3 anteriores. ±5% é ruído de mês, não movimento — fica cinza.
function Tendencia({ pct }: { pct: number | null }) {
  if (pct == null) return <span className="text-gray-300" title="Sem base de comparação no histórico do PCP">—</span>
  const Icone = pct > 5 ? TrendingUp : pct < -5 ? TrendingDown : Minus
  const cor = pct > 5 ? 'text-emerald-600' : pct < -5 ? 'text-red-600' : 'text-gray-400'
  return (
    <span className={`inline-flex items-center gap-1 tabular-nums ${cor}`}>
      <Icone size={13} /> {pct > 0 ? '+' : ''}{pct}%
    </span>
  )
}

const STATUS_CFG: Record<string, { label: string; cor: string; ponto: string }> = {
  CRITICO: { label: 'Crítico', cor: 'bg-red-50 text-red-700', ponto: 'bg-red-500' },
  ATENCAO: { label: 'Atenção', cor: 'bg-amber-50 text-amber-700', ponto: 'bg-amber-500' },
  ADEQUADO: { label: 'Adequado', cor: 'bg-emerald-50 text-emerald-700', ponto: 'bg-emerald-500' },
  ALTO: { label: 'Alto', cor: 'bg-blue-50 text-blue-700', ponto: 'bg-blue-500' },
  EXCESSIVO: { label: 'Excessivo', cor: 'bg-purple-50 text-purple-700', ponto: 'bg-purple-500' },
  SEM_GIRO: { label: 'Sem giro', cor: 'bg-gray-100 text-gray-500', ponto: 'bg-gray-400' },
}
const ORDEM_STATUS = ['CRITICO', 'ATENCAO', 'ADEQUADO', 'ALTO', 'EXCESSIVO', 'SEM_GIRO']

// Piso de volume para o ranking de tendência (un/mês na maior das duas janelas).
const VOLUME_MINIMO = 10

const fmtCob = (v: number | null) => (v == null ? '—' : `${v.toFixed(1).replace('.', ',')} m`)
const fmtNum = (v: number) => v.toLocaleString('pt-BR')

function fmtQuando(iso: string | null) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
}

export function Estoque() {
  const qc = useQueryClient()
  const [busca, setBusca] = useState('')
  const [statusFiltro, setStatusFiltro] = useState('')
  const [familia, setFamilia] = useState('')
  const [linha, setLinha] = useState('')
  const [ordem, setOrdem] = useState<'' | 'alta' | 'baixa'>('')
  const [detalheCodigo, setDetalheCodigo] = useState<string | null>(null)
  const [historicoCodigo, setHistoricoCodigo] = useState<string | null>(null)

  const { data, isLoading } = useQuery<Resposta>({
    queryKey: ['estoque'],
    queryFn: () => api.get('/estoque').then(r => r.data),
  })

  const { data: detalhe, isLoading: carregandoDetalhe } = useQuery<{ codigo: string; ovs: OvComprometida[] }>({
    queryKey: ['estoque-comprometido', detalheCodigo],
    queryFn: () => api.get(`/estoque/${encodeURIComponent(detalheCodigo!)}/comprometido`).then(r => r.data),
    enabled: !!detalheCodigo,
  })

  const { data: historico, isLoading: carregandoHistorico } = useQuery<HistoricoVendas>({
    queryKey: ['estoque-historico-vendas', historicoCodigo],
    queryFn: () => api.get(`/estoque/${encodeURIComponent(historicoCodigo!)}/historico-vendas`).then(r => r.data),
    enabled: !!historicoCodigo,
  })

  const sincronizar = useMutation({
    mutationFn: () => api.post('/estoque/sincronizar').then(r => r.data),
    onSuccess: (res: any) => {
      if (res?.sincronizou) toast.success(`Estoque sincronizado com o PCP (${res.itens} itens)`)
      else if (res?.motivo === 'pcp_indisponivel') toast.error('App do PCP indisponível — mantida a última foto')
      else if (res?.motivo === 'tabela_ausente') toast.error('Rode a migration v19 no Supabase antes de sincronizar')
      else if (res?.motivo === 'integracao_desligada') toast.error('Integração com o PCP não configurada')
      else toast.success('Estoque já estava sincronizado')
      qc.invalidateQueries({ queryKey: ['estoque'] })
    },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao sincronizar')),
  })

  const itens = data?.itens || []
  const linhas = useMemo(
    () => [...new Set(itens.map(i => i.linha).filter(Boolean))].sort() as string[],
    [itens]
  )
  // Famílias do filtro seguem a linha escolhida — evita listar família de
  // Urologia quando o usuário já filtrou por Vascular.
  const familias = useMemo(
    () => [...new Set(itens.filter(i => !linha || i.linha === linha).map(i => i.familia).filter(Boolean))].sort() as string[],
    [itens, linha]
  )

  const filtrados = useMemo(() => {
    const t = busca.trim().toLowerCase()
    const base = itens.filter(i => {
      if (statusFiltro && i.status !== statusFiltro) return false
      if (linha && i.linha !== linha) return false
      if (familia && i.familia !== familia) return false
      if (!t) return true
      return `${i.codigo} ${i.descricao || ''} ${i.familia || ''}`.toLowerCase().includes(t)
    })
    if (!ordem) return base
    // Ordenar por tendência: itens sem base de comparação saem fora (a pergunta
    // é "o que subiu/caiu"), e também os de volume irrelevante — em cima de 2
    // un/mês qualquer oscilação vira ±100% e enterraria o que importa. Com o
    // piso, as quedas do topo passaram de itens de ~2 un/mês para os de 80.
    return base
      .filter(i => i.tendencia_pct != null && Math.max(i.media_3m || 0, i.media_3m_anterior || 0) >= VOLUME_MINIMO)
      .sort((a, b) => ordem === 'alta'
        ? (b.tendencia_pct! - a.tendencia_pct!)
        : (a.tendencia_pct! - b.tendencia_pct!))
  }, [itens, busca, statusFiltro, familia, linha, ordem])

  const kpis = useMemo(() => {
    const porStatus: Record<string, number> = {}
    let negativos = 0
    let comprometidoTotal = 0
    let vendidoMes = 0
    for (const i of itens) {
      porStatus[i.status] = (porStatus[i.status] || 0) + 1
      if (i.disponivel < 0) negativos++
      comprometidoTotal += i.comprometido
      vendidoMes += i.vendido_mes_atual
    }
    return { porStatus, negativos, comprometidoTotal, vendidoMes }
  }, [itens])

  const exportar = () => {
    const cols = ['Código', 'Descrição', 'Linha', 'Família', 'Estoque PA', 'Estoque SA', 'Comprometido', 'Disponível', 'Consumo médio', 'Cobertura PCP', 'Cobertura disponível', 'Vendido no mês', 'Tendência (%)', 'Média 3m', 'Média 3m anterior', 'Status']
    const linhasCsv = filtrados.map(i => [
      i.codigo, i.descricao || '', i.linha || '', i.familia || '', i.estoque_pcp, i.estoque_sa,
      i.comprometido, i.disponivel, i.consumo_medio,
      i.cobertura_pcp ?? '', i.cobertura_disponivel ?? '',
      i.vendido_mes_atual, i.tendencia_pct ?? '', i.media_3m ?? '', i.media_3m_anterior ?? '',
      STATUS_CFG[i.status]?.label || i.status,
    ])
    const csv = [cols, ...linhasCsv].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(';')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `estoque-${data?.data_ref || 'hoje'}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  if (isLoading) return <div className="p-6 text-gray-400 text-sm">Carregando estoque…</div>

  return (
    <div className="p-4 sm:p-6 space-y-4 max-w-7xl mx-auto">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2">
          <Boxes className="text-blue-600" size={22} />
          <div>
            <h1 className="text-xl font-bold text-gray-800">Estoque disponível</h1>
            <p className="text-sm text-gray-500">
              Foto do PCP de {data?.data_ref ? data.data_ref.split('-').reverse().join('/') : '—'}
              {data?.sincronizado_em && <> às {fmtQuando(data.sincronizado_em).split(' ')[1]}</>}
              {' '}· menos as OVs já comprometidas no app
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={exportar} disabled={filtrados.length === 0}
            className="flex items-center gap-1.5 text-sm border rounded-lg px-3 py-2 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
            <Download size={15} /> CSV
          </button>
          <button onClick={() => sincronizar.mutate()} disabled={sincronizar.isPending}
            className="flex items-center gap-1.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-60 text-white text-sm font-medium px-4 py-2 rounded-lg">
            <RefreshCw size={15} className={sincronizar.isPending ? 'animate-spin' : ''} />
            {sincronizar.isPending ? 'Sincronizando…' : 'Sincronizar agora'}
          </button>
        </div>
      </div>

      {!data?.integracao && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
          Integração com o app do PCP não configurada — sem as variáveis <strong>PCP_SUPABASE_URL</strong> e
          <strong> PCP_SUPABASE_KEY</strong> não há de onde puxar o estoque.
        </div>
      )}
      {data?.integracao && itens.length === 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800">
          Nenhuma foto de estoque gravada ainda.
          {data?.sync?.motivo === 'tabela_ausente'
            ? <> Rode as <strong>migrations v19 e v20</strong> no Supabase e clique em "Sincronizar agora".</>
            : <> Clique em <strong>Sincronizar agora</strong> para puxar do PCP.</>}
        </div>
      )}
      {data?.desatualizado && itens.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-800 flex items-center gap-2">
          <AlertTriangle size={16} />
          Esta foto não é de hoje — o PCP pode não ter publicado a planilha ainda. Use "Sincronizar agora" quando publicar.
        </div>
      )}

      {itens.length > 0 && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            {ORDEM_STATUS.map(s => {
              const cfg = STATUS_CFG[s]
              const n = kpis.porStatus[s] || 0
              const ativo = statusFiltro === s
              return (
                <button key={s} onClick={() => setStatusFiltro(ativo ? '' : s)}
                  className={`bg-white rounded-xl border shadow-sm px-3 py-2 text-left transition ${ativo ? 'border-blue-400 ring-2 ring-blue-100' : 'border-gray-100 hover:border-gray-300'}`}>
                  <p className="text-xl font-bold tabular-nums text-gray-800">{n}</p>
                  <p className="text-[11px] text-gray-500 flex items-center gap-1">
                    <span className={`inline-block w-2 h-2 rounded-full ${cfg.ponto}`} /> {cfg.label}
                  </p>
                </button>
              )
            })}
          </div>

          {kpis.negativos > 0 && (
            <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-800 flex items-start gap-2">
              <AlertTriangle size={16} className="mt-0.5 flex-shrink-0" />
              <span>
                <strong>{kpis.negativos} {kpis.negativos === 1 ? 'item está' : 'itens estão'} com disponível negativo</strong> —
                há mais quantidade comprometida em OVs do que material no estoque.
                <button onClick={() => { setStatusFiltro(''); setFamilia(''); setLinha(''); setBusca(''); setOrdem('') }} className="ml-1 underline">
                  ver na lista
                </button> (aparecem no topo).
              </span>
            </div>
          )}
        </>
      )}

      {itens.length > 0 && (
        <div className="flex flex-col lg:flex-row lg:items-center gap-3">
          <div className="relative flex-1 max-w-sm">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={busca} onChange={e => setBusca(e.target.value)}
              placeholder="Buscar código, descrição ou família…"
              className="w-full border rounded-lg pl-9 pr-8 py-2 text-sm" />
            {busca && (
              <button onClick={() => setBusca('')} className="absolute right-2 top-1/2 -translate-y-1/2 p-0.5 text-gray-400 hover:text-gray-600">
                <X size={14} />
              </button>
            )}
          </div>
          <select value={linha} onChange={e => { setLinha(e.target.value); setFamilia('') }} className="border rounded-lg px-3 py-2 text-sm">
            <option value="">Todas as linhas</option>
            {linhas.map(l => <option key={l} value={l}>{l}</option>)}
          </select>
          <select value={familia} onChange={e => setFamilia(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
            <option value="">Todas as famílias</option>
            {familias.map(f => <option key={f} value={f}>{f}</option>)}
          </select>
          <select value={ordem} onChange={e => setOrdem(e.target.value as '' | 'alta' | 'baixa')}
            className="border rounded-lg px-3 py-2 text-sm">
            <option value="">Ordem: mais crítico</option>
            <option value="alta">Tendência: maiores altas</option>
            <option value="baixa">Tendência: maiores quedas</option>
          </select>
          <span className="text-xs text-gray-400 lg:ml-auto">
            {filtrados.length} de {itens.length} itens
            {ordem
              ? <> · com tendência e acima de {VOLUME_MINIMO} un/mês</>
              : <>
                  {kpis.comprometidoTotal > 0 && <> · {fmtNum(Math.round(kpis.comprometidoTotal))} un. comprometidas</>}
                  {kpis.vendidoMes > 0 && data?.mes_atual && <> · {fmtNum(kpis.vendidoMes)} un. faturadas em {fmtMes(data.mes_atual)}</>}
                </>}
          </span>
        </div>
      )}

      {itens.length > 0 && (
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                {/* Dois níveis: os números só fazem sentido agrupados — o que o PCP
                    manda, o que o nosso app tirou, e o que sobrou. */}
                <tr className="text-[10px] uppercase tracking-wide text-gray-400 border-b bg-gray-50/60">
                  <th className="px-3 pt-2 pb-1 font-semibold text-left" colSpan={2}>Item</th>
                  <th className="px-3 pt-2 pb-1 font-semibold text-center border-l border-gray-200" colSpan={2}>Foto do PCP</th>
                  <th className="px-3 pt-2 pb-1 font-semibold text-center border-l border-gray-200">Nosso app</th>
                  <th className="px-3 pt-2 pb-1 font-semibold text-center border-l border-gray-200" colSpan={2}>Situação</th>
                  <th className="px-3 pt-2 pb-1 font-semibold text-center border-l border-gray-200" colSpan={3}>Vendas</th>
                </tr>
                <tr className="text-[11px] uppercase text-gray-400 text-left border-b bg-gray-50/60">
                  <th className="px-3 pb-2 font-medium">Código</th>
                  <th className="px-3 pb-2 font-medium">Descrição</th>
                  <th className="px-3 pb-2 font-medium text-right border-l border-gray-200">PA</th>
                  <th className="px-3 pb-2 font-medium text-right">SA</th>
                  <th className="px-3 pb-2 font-medium text-right border-l border-gray-200">Compromet.</th>
                  <th className="px-3 pb-2 font-medium text-right border-l border-gray-200">Disponível</th>
                  <th className="px-3 pb-2 font-medium text-right">Cobertura</th>
                  <th className="px-3 pb-2 font-medium text-right border-l border-gray-200">Média/mês</th>
                  <th className="px-3 pb-2 font-medium text-right">No mês</th>
                  <th className="px-3 pb-2 font-medium text-right">Tendência</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {filtrados.length === 0 ? (
                  <tr><td colSpan={10} className="px-3 py-10 text-center text-gray-400">Nenhum item encontrado.</td></tr>
                ) : filtrados.map(i => {
                  const cfg = STATUS_CFG[i.status] || STATUS_CFG.SEM_GIRO
                  const negativo = i.disponivel < 0
                  return (
                    <tr key={i.codigo} className={`hover:bg-gray-50/60 ${negativo ? 'bg-red-50/40' : ''}`}>
                      <td className="px-3 py-2 align-top whitespace-nowrap">
                        <span className="font-mono font-medium text-gray-800">{i.codigo}</span>
                        <span className={`block mt-0.5 text-[11px] px-1.5 py-px rounded w-fit ${cfg.cor}`}>{cfg.label}</span>
                      </td>
                      <td className="px-3 py-2 align-top max-w-[260px]">
                        <button onClick={() => setHistoricoCodigo(i.codigo)}
                          className="text-left text-gray-700 hover:text-blue-600 hover:underline decoration-dotted block truncate w-full"
                          title={`${i.descricao} — ver histórico de vendas`}>
                          {i.descricao || '—'}
                        </button>
                        <span className="block text-[11px] text-gray-400 truncate">
                          {i.linha}{i.familia ? ` · ${i.familia}` : ''}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-gray-700 whitespace-nowrap border-l border-gray-100">
                        {fmtNum(i.estoque_pcp)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                        {i.estoque_sa > 0 ? <span className="text-indigo-600">{fmtNum(i.estoque_sa)}</span> : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap border-l border-gray-100">
                        {i.comprometido > 0 ? (
                          <button onClick={() => setDetalheCodigo(i.codigo)}
                            className="text-amber-600 underline decoration-dotted hover:text-amber-700"
                            title="Ver as OVs que comprometem este item">
                            −{fmtNum(i.comprometido)}
                          </button>
                        ) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className={`px-3 py-2 text-right tabular-nums font-bold whitespace-nowrap border-l border-gray-100 ${negativo ? 'text-red-600' : 'text-gray-900'}`}>
                        {fmtNum(i.disponivel)}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                        <span className={negativo ? 'text-red-600 font-medium' : 'text-gray-700'}>{fmtCob(i.cobertura_disponivel)}</span>
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap border-l border-gray-100">
                        {i.consumo_medio > 0 ? (
                          // Mesma affordance do app do PCP: é aqui que se clica
                          // para ver o histórico mês a mês.
                          <button onClick={() => setHistoricoCodigo(i.codigo)}
                            className="text-gray-600 underline decoration-dotted hover:text-blue-600"
                            title="Ver histórico de vendas mês a mês">
                            {fmtNum(Math.round(i.consumo_medio))}
                          </button>
                        ) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums whitespace-nowrap">
                        {i.vendido_mes_atual > 0
                          ? <span className="text-gray-800 font-medium">{fmtNum(i.vendido_mes_atual)}</span>
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-3 py-2 text-right whitespace-nowrap">
                        <Tendencia pct={i.tendencia_pct} />
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {itens.length > 0 && (
        <p className="text-[11px] text-gray-400">
          <strong>Estoque PCP</strong> é o produto acabado pronto pra faturar, na foto da manhã.
          <strong> SA (a liberar)</strong> é o semi-acabado — ainda depende da produção, não entra no disponível.
          <strong> Comprometido</strong> são as OVs deste app que ainda não faturaram, mais as que faturaram depois da foto.
          <strong> Cobertura</strong> é o disponível ÷ consumo médio dos últimos 6 meses.
          <strong> No mês</strong> é o acumulado faturado das OVs daqui{data?.mes_atual ? ` em ${fmtMes(data.mes_atual)}` : ''}.
          <strong> Tendência</strong> vem do histórico do PCP: média dos 3 últimos meses fechados
          {data?.ultimo_mes_fechado ? ` (até ${fmtMes(data.ultimo_mes_fechado)})` : ''} contra os 3 anteriores.
          Clique na <strong>média/mês</strong> (ou na descrição) pra ver o histórico mês a mês.
        </p>
      )}

      {detalheCodigo && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4"
          onClick={() => setDetalheCodigo(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[80vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b sticky top-0 bg-white rounded-t-xl">
              <div>
                <h3 className="font-semibold text-gray-800">OVs comprometendo o item</h3>
                <p className="text-xs text-gray-400 font-mono">{detalheCodigo}</p>
              </div>
              <button onClick={() => setDetalheCodigo(null)} className="p-1 text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-4">
              {carregandoDetalhe ? (
                <p className="text-sm text-gray-400 py-6 text-center">Carregando…</p>
              ) : !detalhe?.ovs.length ? (
                <p className="text-sm text-gray-400 py-6 text-center">Nenhuma OV encontrada.</p>
              ) : (
                <div className="space-y-2">
                  {detalhe.ovs.map(ov => {
                    const cfg = STATUS_CONFIG[ov.status as keyof typeof STATUS_CONFIG]
                    return (
                      <div key={ov.pedido_id} className="border rounded-lg px-3 py-2 flex items-center justify-between gap-3">
                        <div className="min-w-0">
                          <div className="font-mono font-medium text-gray-800 text-sm">{ov.numero_pedido}</div>
                          <div className="text-xs text-gray-500 truncate">{ov.cliente || '—'}</div>
                          <div className="flex items-center gap-1 mt-1">
                            <span className="text-[11px] px-2 py-0.5 rounded-full"
                              style={{ background: cfg?.cor, color: cfg?.corTexto }}>
                              {cfg?.label || ov.status}
                            </span>
                            {ov.faturada_depois_da_foto && (
                              <span className="text-[11px] px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">
                                faturou hoje
                              </span>
                            )}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="font-bold text-amber-600 tabular-nums">{fmtNum(ov.qtd)}</div>
                          <div className="text-[11px] text-gray-400">{fmtQuando(ov.criado_em)}</div>
                        </div>
                      </div>
                    )
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {historicoCodigo && (
        <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50 p-4"
          onClick={() => setHistoricoCodigo(null)}>
          <div className="bg-white rounded-xl shadow-xl max-w-lg w-full max-h-[80vh] overflow-y-auto"
            onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-4 py-3 border-b sticky top-0 bg-white rounded-t-xl">
              <div>
                <h3 className="font-semibold text-gray-800">Histórico de vendas</h3>
                <p className="text-xs text-gray-400 font-mono">{historicoCodigo}</p>
              </div>
              <button onClick={() => setHistoricoCodigo(null)} className="p-1 text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="p-4">
              {carregandoHistorico || !historico ? (
                <p className="text-sm text-gray-400 py-6 text-center">Carregando…</p>
              ) : (
                <>
                  <p className="text-sm text-gray-700 mb-4">{historico.descricao}</p>
                  <div className="space-y-1.5">
                    {(() => {
                      const max = Math.max(1, historico.vendido_mes_atual, ...historico.meses.map(m => m.qtd))
                      const barra = (chave: string, rotulo: string, qtd: number, parcial: boolean) => (
                        <div key={chave} className="flex items-center gap-3">
                          <span className={`w-14 text-xs shrink-0 ${parcial ? 'text-blue-600 font-medium' : 'text-gray-400'}`}>{rotulo}</span>
                          <div className="flex-1 bg-gray-100 rounded h-4 overflow-hidden">
                            <div className={`h-full rounded ${parcial ? 'bg-blue-600' : 'bg-blue-300'}`}
                              style={{ width: `${(qtd / max) * 100}%` }} />
                          </div>
                          <span className={`w-12 text-right text-xs tabular-nums shrink-0 ${parcial ? 'text-blue-700 font-semibold' : 'text-gray-600'}`}>
                            {fmtNum(qtd)}
                          </span>
                        </div>
                      )
                      return [
                        ...historico.meses.map(m => barra(m.mes, fmtMes(m.mes), m.qtd, false)),
                        barra(historico.mes_atual, fmtMes(historico.mes_atual), historico.vendido_mes_atual, true),
                      ]
                    })()}
                  </div>
                  <p className="text-[11px] text-gray-400 mt-2">
                    Meses fechados vêm do app do PCP (D365). {fmtMes(historico.mes_atual)} é o acumulado
                    parcial, calculado das OVs já faturadas aqui.
                  </p>

                  <div className="grid grid-cols-2 gap-x-6 gap-y-2 mt-4 pt-3 border-t text-sm">
                    <div className="flex justify-between">
                      <span className="text-gray-400">Total 6 meses</span>
                      <span className="font-semibold text-gray-800">{fmtNum(historico.total_fechado)} un.</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Consumo médio</span>
                      <span className="font-semibold text-gray-800">
                        {historico.consumo_medio != null ? `${fmtNum(Math.round(historico.consumo_medio))} un/mês` : '—'}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-gray-400">Cobertura atual</span>
                      <span className="font-semibold text-gray-800">{fmtCob(historico.cobertura_atual)}</span>
                    </div>
                    <div className="flex justify-between items-center">
                      <span className="text-gray-400">Tendência</span>
                      <Tendencia pct={historico.tendencia_pct} />
                    </div>
                  </div>
                  {historico.media_3m != null && historico.media_3m_anterior != null && (
                    <p className="text-[11px] text-gray-400 mt-2">
                      Tendência = média dos 3 últimos meses fechados ({fmtNum(historico.media_3m)}/mês) contra
                      os 3 anteriores ({fmtNum(historico.media_3m_anterior)}/mês).
                    </p>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

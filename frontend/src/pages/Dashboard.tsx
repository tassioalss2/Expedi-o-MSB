import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { Package, AlertTriangle, CheckCircle, Clock, Plus, FileText, Timer, X } from 'lucide-react'
import { calcHorasComerciais, formatarTempo, corSLA, bgSLA } from '../lib/horasComerciais'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, ComposedChart, Line, CartesianGrid } from 'recharts'
import api from '../lib/api'
import type { DashboardOperacional, Indicadores } from '../types'
import { STATUS_CONFIG } from '../lib/statusConfig'

function KpiCard({ titulo, valor, sub, cor, icone: Icone, onClick }: {
  titulo: string; valor: string | number; sub?: string; cor: string; icone: any; onClick?: () => void
}) {
  const conteudo = (
    <div className="flex items-start justify-between">
      <div>
        <p className="text-sm text-gray-500 flex items-center gap-1">
          {titulo}
          {onClick && <span className="text-[10px] text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity">ver →</span>}
        </p>
        <p className={`text-3xl font-bold mt-1 ${cor}`}>{valor}</p>
        {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
      </div>
      <div className={`p-2.5 rounded-lg bg-gray-50`}>
        <Icone size={22} className={cor} />
      </div>
    </div>
  )
  if (!onClick) return <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">{conteudo}</div>
  return (
    <button onClick={onClick}
      className="group text-left bg-white rounded-xl p-5 shadow-sm border border-gray-100 hover:border-blue-300 hover:shadow-md transition-all">
      {conteudo}
    </button>
  )
}

function DetalheModal({ metrica, dataInicio, dataFim, onClose }: {
  metrica: string; dataInicio: string; dataFim: string; onClose: () => void
}) {
  const { data, isLoading } = useQuery<any[]>({
    queryKey: ['indicadores-detalhes', metrica, dataInicio, dataFim],
    queryFn: () =>
      api.get('/pedidos/dashboard/indicadores/detalhes', {
        params: { metrica, data_inicio: dataInicio, data_fim: dataFim },
      }).then(r => r.data),
  })

  const titulos: Record<string, string> = {
    otif_atrasados: 'OVs Expedidas com Atraso',
    divergencias: 'Ocorrências de Divergência',
    backlog: 'Backlog — OVs em Aberto',
    retrabalhos: 'Ocorrências de Retrabalho',
  }

  const STATUS_LABEL: Record<string, string> = {
    AGUARD_CREDITO: 'Ger. Crédito', LIBERADO: 'Liberado', EM_INVENTARIO: 'Em Inventário',
    AGUARD_VERIFICACAO: 'Aguard. Verificação', DIVERGENCIA: 'Divergência',
    AGUARD_TRATATIVA: 'Aguard. Tratativa', EM_PROCESSO_SISTEMICO: 'Proc. Sistêmico',
    AGUARD_FATURAMENTO: 'Aguard. Faturamento', FATURADO: 'Faturado',
    AGUARD_COLETA: 'No Pallet', BLOQUEADO: 'Bloqueado',
  }

  const fmtDate = (d?: string) => d ? d.split('-').reverse().join('/') : '—'

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-3xl max-h-[80vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b">
          <h2 className="text-lg font-bold text-gray-900">{titulos[metrica] || metrica}</h2>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-gray-100">
            <X size={18} className="text-gray-500" />
          </button>
        </div>
        <div className="overflow-auto flex-1 p-4">
          {isLoading ? (
            <p className="text-center text-gray-400 py-8">Carregando...</p>
          ) : !data?.length ? (
            <p className="text-center text-gray-400 py-8">Nenhum registro encontrado no período</p>
          ) : metrica === 'otif_atrasados' ? (
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-gray-500 border-b bg-gray-50">
                <th className="text-left py-2 px-3">OV</th>
                <th className="text-left py-2 px-3">Cliente</th>
                <th className="text-left py-2 px-3">Previsto</th>
                <th className="text-left py-2 px-3">Expedido</th>
                <th className="text-right py-2 px-3">Atraso</th>
              </tr></thead>
              <tbody>
                {data.map((r: any) => (
                  <tr key={r.numero_pedido} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-2 px-3 font-mono font-bold text-gray-800">{r.numero_pedido}</td>
                    <td className="py-2 px-3 text-gray-600 max-w-[200px] truncate">{r.cliente}</td>
                    <td className="py-2 px-3 text-gray-500">{fmtDate(r.data_prevista)}</td>
                    <td className="py-2 px-3 text-gray-500">{fmtDate(r.data_real)}</td>
                    <td className="py-2 px-3 text-right font-bold text-red-600">{r.dias_atraso}d</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : metrica === 'divergencias' ? (
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-gray-500 border-b bg-gray-50">
                <th className="text-left py-2 px-3">OV</th>
                <th className="text-left py-2 px-3">Cliente</th>
                <th className="text-left py-2 px-3">Data</th>
                <th className="text-left py-2 px-3">Descrição</th>
                <th className="text-right py-2 px-3">Status</th>
              </tr></thead>
              <tbody>
                {data.map((r: any, i: number) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-2 px-3 font-mono font-bold text-gray-800">{r.numero_pedido}</td>
                    <td className="py-2 px-3 text-gray-600 max-w-[140px] truncate">{r.cliente}</td>
                    <td className="py-2 px-3 text-gray-500 whitespace-nowrap">{fmtDate(r.data)}</td>
                    <td className="py-2 px-3 text-gray-500 text-xs max-w-[200px] truncate">{r.descricao}</td>
                    <td className="py-2 px-3 text-right text-xs">{r.status_ocorrencia}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : metrica === 'backlog' ? (
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-gray-500 border-b bg-gray-50">
                <th className="text-left py-2 px-3">OV</th>
                <th className="text-left py-2 px-3">Cliente</th>
                <th className="text-left py-2 px-3">Etapa</th>
                <th className="text-left py-2 px-3">Prioridade</th>
                <th className="text-right py-2 px-3">Previsto</th>
              </tr></thead>
              <tbody>
                {data.map((r: any) => (
                  <tr key={r.numero_pedido} className={`border-b border-gray-50 hover:bg-gray-50 ${r.atrasado ? 'bg-red-50' : ''}`}>
                    <td className="py-2 px-3 font-mono font-bold text-gray-800">{r.numero_pedido}</td>
                    <td className="py-2 px-3 text-gray-600 max-w-[160px] truncate">{r.cliente}</td>
                    <td className="py-2 px-3 text-xs text-gray-500">{STATUS_LABEL[r.status] || r.status}</td>
                    <td className="py-2 px-3">
                      <span className={`text-xs font-medium px-1.5 py-0.5 rounded ${
                        r.prioridade === 'CRITICA' ? 'bg-red-100 text-red-700' :
                        r.prioridade === 'ALTA' ? 'bg-orange-100 text-orange-700' : 'bg-gray-100 text-gray-500'
                      }`}>{r.prioridade}</span>
                    </td>
                    <td className={`py-2 px-3 text-right font-semibold text-xs ${r.atrasado ? 'text-red-600' : 'text-gray-500'}`}>
                      {r.atrasado && '⚠ '}{fmtDate(r.data_prevista)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : metrica === 'retrabalhos' ? (
            <table className="w-full text-sm">
              <thead><tr className="text-xs text-gray-500 border-b bg-gray-50">
                <th className="text-left py-2 px-3">OV</th>
                <th className="text-left py-2 px-3">Cliente</th>
                <th className="text-left py-2 px-3">Tipo</th>
                <th className="text-left py-2 px-3">Data</th>
                <th className="text-right py-2 px-3">Status</th>
              </tr></thead>
              <tbody>
                {data.map((r: any, i: number) => (
                  <tr key={i} className="border-b border-gray-50 hover:bg-gray-50">
                    <td className="py-2 px-3 font-mono font-bold text-gray-800">{r.numero_pedido}</td>
                    <td className="py-2 px-3 text-gray-600 max-w-[160px] truncate">{r.cliente}</td>
                    <td className="py-2 px-3 text-xs text-gray-600">{r.tipo}</td>
                    <td className="py-2 px-3 text-gray-500 whitespace-nowrap">{fmtDate(r.data)}</td>
                    <td className="py-2 px-3 text-right text-xs">{r.status_ocorrencia}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : null}
        </div>
        <div className="px-6 py-3 border-t text-xs text-gray-400 text-right">
          {data?.length ?? 0} registro(s)
        </div>
      </div>
    </div>
  )
}

export function Dashboard() {
  const navigate = useNavigate()
  const hoje = new Date()
  const inicioMes = format(new Date(hoje.getFullYear(), hoje.getMonth(), 1), 'yyyy-MM-dd')
  const fimMes = format(hoje, 'yyyy-MM-dd')

  const { data: dash } = useQuery<DashboardOperacional>({
    queryKey: ['dashboard'],
    queryFn: () => api.get('/pedidos/dashboard/operacional').then((r) => r.data),
    refetchInterval: 30000,
  })

  const { data: tempoSep } = useQuery({
    queryKey: ['tempo-separacao'],
    queryFn: () => api.get('/pedidos/dashboard/tempo-separacao').then(r => r.data),
    refetchInterval: 60000,
  })

  // Calcula métricas de tempo de separação
  const SLA_HORAS = 2
  const agora = new Date()
  const tempos = ((tempoSep as any[]) || []).map((ov: any) => ({
    ...ov,
    horas: calcHorasComerciais(
      new Date(ov.inicio),
      ov.fim ? new Date(ov.fim) : agora
    ),
  }))
  const concluidas = tempos.filter(t => t.concluido)
  const emAndamento = tempos.filter(t => !t.concluido)
  const mediaHoras = concluidas.length > 0
    ? concluidas.reduce((a, t) => a + t.horas, 0) / concluidas.length
    : null
  const acimaSLA = tempos.filter(t => t.horas > SLA_HORAS).length

  const { data: indicadores } = useQuery<Indicadores>({
    queryKey: ['indicadores', inicioMes, fimMes],
    queryFn: () =>
      api.get(`/pedidos/dashboard/indicadores?data_inicio=${inicioMes}&data_fim=${fimMes}`).then((r) => r.data),
    refetchInterval: 60000,
  })

  const chartData = dash?.por_status
    .filter((s) => !['EXPEDIDO', 'CANCELADO'].includes(s.status))
    .map((s) => ({
      name: STATUS_CONFIG[s.status as keyof typeof STATUS_CONFIG]?.label || s.status,
      quantidade: s.quantidade,
      atrasados: s.atrasados,
    })) || []

  const otifValor = indicadores?.otif ?? null
  const otifColor = otifValor === null ? '#D1D5DB' : otifValor >= 95 ? '#22C55E' : otifValor >= 90 ? '#F59E0B' : '#EF4444'
  const [detalheAberto, setDetalheAberto] = useState<string | null>(null)
  const [periodoHorario, setPeriodoHorario] = useState(30)
  const [horaClicada, setHoraClicada] = useState<number | null>(null)

  // Drill-down dos KPIs do topo: lista as OVs por trás de cada número
  const hojeStr = format(hoje, 'yyyy-MM-dd')
  const [kpiAberto, setKpiAberto] = useState<{ tipo: 'ativos' | 'expedidos_hoje' | 'atrasados'; titulo: string } | null>(null)
  const { data: kpiPedidos = [], isFetching: carregandoKpi } = useQuery<any[]>({
    queryKey: ['kpi-drill', kpiAberto?.tipo],
    queryFn: () => {
      const params = kpiAberto?.tipo === 'atrasados' ? { atrasados: true }
        : kpiAberto?.tipo === 'expedidos_hoje' ? { status: 'EXPEDIDO' }
        : {}
      return api.get('/pedidos', { params }).then(r => r.data)
    },
    enabled: kpiAberto !== null,
  })
  const kpiLista = (kpiPedidos as any[]).filter((p) => {
    if (kpiAberto?.tipo === 'ativos') return !['EXPEDIDO', 'CANCELADO'].includes(p.status)
    if (kpiAberto?.tipo === 'expedidos_hoje') return (p.atualizado_em || '').slice(0, 10) === hojeStr
    return true // atrasados já vem filtrado do backend
  })

  const inicioHorario = (() => {
    const d = new Date(hoje)
    d.setDate(d.getDate() - (periodoHorario - 1))
    return format(d, 'yyyy-MM-dd')
  })()

  const { data: horarioData = [] } = useQuery<any[]>({
    queryKey: ['horario-criacao', periodoHorario],
    queryFn: () => api.get('/pedidos/dashboard/horario-criacao', {
      params: { data_inicio: inicioHorario, data_fim: fimMes },
    }).then(r => r.data),
    refetchInterval: 120000,
  })

  const { data: ovsHora = [], isFetching: carregandoOvs } = useQuery<any[]>({
    queryKey: ['horario-criacao-detalhe', horaClicada, periodoHorario],
    queryFn: () => api.get('/pedidos/dashboard/horario-criacao/detalhe', {
      params: { hora: horaClicada, data_inicio: inicioHorario, data_fim: fimMes },
    }).then(r => r.data),
    enabled: horaClicada !== null,
  })

  // Esforço do time (volume + complexidade) — por mês, default mês corrente
  const [mesEsforco, setMesEsforco] = useState(() => new Date(hoje.getFullYear(), hoje.getMonth(), 1))
  const ehMesAtualEsf = mesEsforco.getFullYear() === hoje.getFullYear() && mesEsforco.getMonth() === hoje.getMonth()
  const inicioEsforco = format(new Date(mesEsforco.getFullYear(), mesEsforco.getMonth(), 1), 'yyyy-MM-dd')
  const fimEsforco = ehMesAtualEsf ? fimMes : format(new Date(mesEsforco.getFullYear(), mesEsforco.getMonth() + 1, 0), 'yyyy-MM-dd')
  const mesesEsforco = Array.from({ length: 12 }, (_, i) => new Date(hoje.getFullYear(), hoje.getMonth() - i, 1))

  const { data: esforcoData } = useQuery<{ complexidade: any[]; por_dia: any[] }>({
    queryKey: ['esforco-time', inicioEsforco, fimEsforco],
    queryFn: () => api.get('/pedidos/dashboard/esforco', {
      params: { data_inicio: inicioEsforco, data_fim: fimEsforco },
    }).then(r => r.data),
    refetchInterval: 120000,
  })

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Painel Operacional</h1>
          <p className="text-gray-500 text-sm mt-0.5">
            {format(hoje, "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => navigate('/relatorio/coleta')}
            className="flex items-center gap-2 px-4 py-2.5 border border-gray-300 bg-white text-gray-700 rounded-lg font-medium hover:bg-gray-50 shadow-sm text-sm"
          >
            <FileText size={16} />
            Coletas Pendentes
          </button>
          <button
            onClick={() => navigate('/relatorio/coletas-realizadas')}
            className="flex items-center gap-2 px-4 py-2.5 border border-gray-300 bg-white text-gray-700 rounded-lg font-medium hover:bg-gray-50 shadow-sm text-sm"
          >
            <FileText size={16} />
            Coletas Realizadas
          </button>
          <button
            onClick={() => navigate('/expedicao/novo')}
            className="flex items-center gap-2 px-5 py-2.5 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-500 shadow-sm"
          >
            <Plus size={18} />
            Nova OV
          </button>
        </div>
      </div>

      {/* KPIs principais */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <KpiCard
          titulo="Em Expedição (total)"
          valor={dash?.total_pedidos || 0}
          sub="pedidos ativos"
          cor="text-blue-600"
          icone={Package}
          onClick={() => setKpiAberto({ tipo: 'ativos', titulo: 'Em Expedição — pedidos ativos' })}
        />
        <KpiCard
          titulo="Expedidos Hoje"
          valor={dash?.expedidos_hoje || 0}
          sub="pedidos finalizados"
          cor="text-green-600"
          icone={CheckCircle}
          onClick={() => setKpiAberto({ tipo: 'expedidos_hoje', titulo: 'Expedidos hoje' })}
        />
        <KpiCard
          titulo="Atrasados"
          valor={dash?.atrasados || 0}
          sub="requerem atenção"
          cor={dash?.atrasados ? 'text-red-600' : 'text-gray-400'}
          icone={AlertTriangle}
          onClick={() => setKpiAberto({ tipo: 'atrasados', titulo: 'OVs atrasadas' })}
        />
        <KpiCard
          titulo="Ocorrências Abertas"
          valor={dash?.ocorrencias_abertas || 0}
          sub="sem resolução"
          cor={dash?.ocorrencias_abertas ? 'text-orange-600' : 'text-gray-400'}
          icone={Clock}
          onClick={() => navigate('/ocorrencias')}
        />
      </div>

      {/* Card Tempo de Separação */}
      <div className={`rounded-xl p-5 border-2 ${acimaSLA > 0 ? bgSLA(SLA_HORAS + 1) : 'bg-green-50 border-green-200'}`}>
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <Timer size={18} className={acimaSLA > 0 ? 'text-red-500' : 'text-green-500'} />
              <p className="text-sm font-semibold text-gray-700">⏱ Tempo de Separação</p>
              <span className="text-xs text-gray-400">SLA: {SLA_HORAS}h comerciais</span>
            </div>
            <div className="flex items-end gap-6 mt-2">
              <div>
                <p className="text-xs text-gray-500">Tempo médio hoje</p>
                <p className={`text-2xl font-bold ${mediaHoras !== null ? corSLA(mediaHoras, SLA_HORAS) : 'text-gray-400'}`}>
                  {mediaHoras !== null ? formatarTempo(mediaHoras) : '—'}
                </p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Em andamento</p>
                <p className="text-2xl font-bold text-blue-600">{emAndamento.length}</p>
              </div>
              <div>
                <p className="text-xs text-gray-500">Acima do SLA</p>
                <p className={`text-2xl font-bold ${acimaSLA > 0 ? 'text-red-600' : 'text-gray-400'}`}>
                  {acimaSLA}
                </p>
              </div>
            </div>
          </div>

          {/* OVs em andamento com tempo */}
          {emAndamento.length > 0 && (
            <div className="hidden md:block min-w-[220px] max-w-[260px]">
              <p className="text-xs text-gray-500 mb-1.5 font-medium">OVs em processo agora</p>
              <div className="space-y-1 max-h-28 overflow-y-auto">
                {emAndamento.map((ov: any) => (
                  <div key={ov.numero_pedido} className="flex items-center justify-between text-xs bg-white rounded px-2 py-1 border border-gray-100">
                    <span className="font-medium text-gray-700">{ov.numero_pedido}</span>
                    <span className={`font-bold ${corSLA(ov.horas, SLA_HORAS)}`}>
                      {formatarTempo(ov.horas)}
                      {ov.horas > SLA_HORAS && ' ⚠'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Indicadores do mês */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {/* OTIF */}
        <button onClick={() => setDetalheAberto('otif_atrasados')}
          className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 text-left hover:border-blue-300 hover:shadow-md transition-all group">
          <p className="text-sm text-gray-500 mb-2 flex items-center gap-1">
            OTIF — {format(hoje, 'MMMM', { locale: ptBR })}
            <span className="text-[10px] text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity ml-1">ver →</span>
          </p>
          <div className="flex items-end gap-2">
            <span className="text-4xl font-bold" style={{ color: otifColor }}>
              {otifValor !== null ? otifValor.toFixed(1) : '—'}
            </span>
            {otifValor !== null && <span className="text-lg text-gray-400 mb-0.5">%</span>}
          </div>
          <div className="mt-3 bg-gray-100 rounded-full h-2">
            <div className="h-2 rounded-full transition-all"
              style={{ width: `${Math.min(otifValor || 0, 100)}%`, backgroundColor: otifColor }} />
          </div>
          <p className="text-xs text-gray-400 mt-1.5">
            {otifValor === null ? 'Sem OVs expedidas' : `Meta: 95% · ${indicadores?.pedidos_expedidos} exp.`}
          </p>
        </button>

        {/* Taxa de divergência */}
        <button onClick={() => setDetalheAberto('divergencias')}
          className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 text-left hover:border-orange-300 hover:shadow-md transition-all group">
          <p className="text-sm text-gray-500 mb-2 flex items-center gap-1">
            Taxa de Divergência
            <span className="text-[10px] text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity ml-1">ver →</span>
          </p>
          <span className="text-4xl font-bold text-orange-500">
            {indicadores?.taxa_divergencia?.toFixed(1) || '0'}%
          </span>
          <p className="text-xs text-gray-400 mt-1">Meta: ≤ 1%</p>
          <p className="text-sm text-gray-600 mt-3">
            <span className="font-medium">{indicadores?.pedidos_expedidos || 0}</span> exp. no período
          </p>
        </button>

        {/* Backlog */}
        <button onClick={() => setDetalheAberto('backlog')}
          className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 text-left hover:border-purple-300 hover:shadow-md transition-all group">
          <p className="text-sm text-gray-500 mb-2 flex items-center gap-1">
            Backlog Total
            <span className="text-[10px] text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity ml-1">ver →</span>
          </p>
          <span className="text-4xl font-bold text-purple-600">
            {indicadores?.backlog || 0}
          </span>
          <p className="text-xs text-gray-400 mt-1">pedidos em aberto</p>
          <p className="text-sm text-gray-600 mt-3">Clique para ver detalhes</p>
        </button>

        {/* Taxa de retrabalho */}
        <button onClick={() => setDetalheAberto('retrabalhos')}
          className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 text-left hover:border-red-300 hover:shadow-md transition-all group">
          <p className="text-sm text-gray-500 mb-2 flex items-center gap-1">
            Taxa de Retrabalho
            <span className="text-[10px] text-blue-400 opacity-0 group-hover:opacity-100 transition-opacity ml-1">ver →</span>
          </p>
          <span className="text-4xl font-bold text-red-500">
            {indicadores?.taxa_retrabalho?.toFixed(1) || '0'}%
          </span>
          <p className="text-xs text-gray-400 mt-1">Meta: ≤ 5%</p>
          <p className="text-sm text-gray-600 mt-3">OVs c/ retrabalho no período</p>
        </button>
      </div>

      {detalheAberto && (
        <DetalheModal
          metrica={detalheAberto}
          dataInicio={inicioMes}
          dataFim={fimMes}
          onClose={() => setDetalheAberto(null)}
        />
      )}

      {/* Gráficos */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Pedidos por status */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Pedidos por Etapa</h2>
          <ResponsiveContainer width="100%" height={220}>
            <BarChart data={chartData} margin={{ left: -20 }}>
              <XAxis dataKey="name" tick={{ fontSize: 11 }} />
              <YAxis tick={{ fontSize: 11 }} />
              <Tooltip />
              <Bar dataKey="quantidade" name="Total" fill="#3B82F6" radius={[4, 4, 0, 0]} />
              <Bar dataKey="atrasados" name="Atrasados" fill="#EF4444" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        {/* Status rápido */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">Situação por Etapa</h2>
          <div className="space-y-2.5">
            {dash?.por_status
              .filter((s) => s.quantidade > 0 && !['EXPEDIDO', 'CANCELADO'].includes(s.status))
              .sort((a, b) => b.quantidade - a.quantidade)
              .slice(0, 8)
              .map((s) => {
                const cfg = STATUS_CONFIG[s.status as keyof typeof STATUS_CONFIG]
                return (
                  <div key={s.status} className="flex items-center gap-3">
                    <span className="text-base w-5">{cfg?.icone}</span>
                    <span className="text-sm text-gray-600 flex-1 truncate">{cfg?.label || s.status}</span>
                    <span className="text-sm font-semibold text-gray-800">{s.quantidade}</span>
                    {s.atrasados > 0 && (
                      <span className="text-xs text-red-600 font-medium">⚠ {s.atrasados}</span>
                    )}
                  </div>
                )
              })}
          </div>
        </div>
      </div>

      {/* Horário de Criação das OVs */}
      {(() => {
        const dadosFiltrados = horarioData.filter((h: any) => h.hora >= 6)
        const totalOvs = dadosFiltrados.reduce((a: number, h: any) => a + h.total, 0)
        const picoEntry = dadosFiltrados.reduce((max: any, h: any) => h.total > max.total ? h : max, { hora: 6, label: '06h', total: 0 })
        const maxTotal = picoEntry.total
        return (
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <div className="flex items-center justify-between mb-1">
              <div>
                <h2 className="text-sm font-semibold text-gray-700">Horário de Criação das OVs</h2>
                <p className="text-xs text-gray-400 mt-0.5">Distribuição por hora do dia (Horário de Brasília)</p>
              </div>
              <div className="flex gap-1">
                {[7, 30, 90].map(d => (
                  <button key={d} onClick={() => setPeriodoHorario(d)}
                    className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                      periodoHorario === d ? 'bg-indigo-600 text-white' : 'bg-gray-100 text-gray-600 hover:bg-gray-200'
                    }`}>
                    {d}d
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-5 mb-4 text-xs text-gray-500">
              <span>Total no período: <strong className="text-gray-800">{totalOvs} OVs</strong></span>
              {maxTotal > 0 && (
                <span>Pico: <strong className="text-amber-600">{picoEntry.label} — {maxTotal} OVs</strong></span>
              )}
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={dadosFiltrados} margin={{ left: -20, bottom: 0 }}>
                <XAxis dataKey="label" tick={{ fontSize: 10 }} interval={1} />
                <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip formatter={(v: any) => [`${v} OVs`, 'Criadas']} />
                <Bar dataKey="total" radius={[3, 3, 0, 0]} style={{ cursor: 'pointer' }}
                  onClick={(data: any) => data?.total > 0 && setHoraClicada(data.hora)}>
                  {dadosFiltrados.map((entry: any, index: number) => (
                    <Cell key={index}
                      fill={horaClicada === entry.hora ? '#1D4ED8' : entry.total === maxTotal && maxTotal > 0 ? '#F59E0B' : '#6366F1'}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        )
      })()}

      {/* Esforço do Time */}
      {esforcoData && (() => {
        const totalUn = esforcoData.por_dia.reduce((a: number, d: any) => a + (d.total_unidades || 0), 0)
        const totalOvs = esforcoData.por_dia.reduce((a: number, d: any) => a + (d.num_ovs || 0), 0)
        const nDias = esforcoData.por_dia.length
        const fmtInt = (n: number) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 0 })
        return (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-semibold text-gray-700">Esforço do Time</h2>
            <select
              value={inicioEsforco}
              onChange={(e) => { const [y, m] = e.target.value.split('-').map(Number); setMesEsforco(new Date(y, m - 1, 1)) }}
              className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 cursor-pointer"
            >
              {mesesEsforco.map((d) => {
                const val = format(d, 'yyyy-MM-dd')
                return <option key={val} value={val}>{format(d, "MMMM 'de' yyyy", { locale: ptBR })}</option>
              })}
            </select>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Volume por dia */}
          <div className="lg:col-span-2 bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <div className="flex items-start justify-between mb-4">
              <div>
                <h3 className="text-sm font-semibold text-gray-700">Volume por Dia</h3>
                <p className="text-xs text-gray-400 mt-0.5">Unidades separadas por dia · {format(mesEsforco, "MMMM 'de' yyyy", { locale: ptBR })}</p>
              </div>
              <div className="flex gap-5 text-right">
                <div>
                  <p className="text-[11px] text-gray-400 uppercase tracking-wide">Unidades</p>
                  <p className="text-lg font-bold text-indigo-600 tabular-nums">{fmtInt(totalUn)}</p>
                </div>
                <div>
                  <p className="text-[11px] text-gray-400 uppercase tracking-wide">OVs</p>
                  <p className="text-lg font-bold text-gray-700 tabular-nums">{fmtInt(totalOvs)}</p>
                </div>
              </div>
            </div>
            {totalUn === 0 ? (
              <div className="h-56 flex items-center justify-center text-sm text-gray-400">Sem volume no período</div>
            ) : (
              <ResponsiveContainer width="100%" height={224}>
                <BarChart data={esforcoData.por_dia} margin={{ top: 8, right: 8, left: -8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="#f1f5f9" />
                  <XAxis dataKey="label" tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={{ stroke: '#e5e7eb' }}
                    tickLine={false} interval={nDias > 20 ? 2 : nDias > 10 ? 1 : 0} minTickGap={4} />
                  <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false}
                    allowDecimals={false} width={40}
                    tickFormatter={(v: number) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)} />
                  <Tooltip cursor={{ fill: 'rgba(99,102,241,0.06)' }}
                    content={({ active, payload }: any) => {
                      if (!active || !payload?.length) return null
                      const p = payload[0].payload
                      return (
                        <div className="bg-white border border-gray-200 rounded-lg shadow-sm px-3 py-2 text-xs">
                          <p className="font-semibold text-gray-700 mb-0.5">{p.label}</p>
                          <p className="text-indigo-600 font-bold text-sm">{fmtInt(p.total_unidades)} un</p>
                          <p className="text-gray-400">{p.num_ovs} OV{p.num_ovs === 1 ? '' : 's'}</p>
                        </div>
                      )
                    }} />
                  <Bar dataKey="total_unidades" fill="#6366F1" radius={[3, 3, 0, 0]} maxBarSize={26} />
                </BarChart>
              </ResponsiveContainer>
            )}
          </div>

          {/* Complexidade das OVs */}
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 flex flex-col">
            <div className="mb-4">
              <h3 className="text-sm font-semibold text-gray-700">Perfil das OVs</h3>
              <p className="text-xs text-gray-400 mt-0.5">Complexidade pelo total de unidades · {esforcoData.complexidade.reduce((a: number, c: any) => a + c.total, 0)} OVs</p>
            </div>
            <div className="flex-1 space-y-4">
              {esforcoData.complexidade.map((c: any) => (
                <div key={c.categoria}>
                  <div className="flex justify-between items-baseline mb-1.5">
                    <span className="text-sm font-medium text-gray-700">{c.categoria}</span>
                    <span className="text-xs text-gray-500">{c.total} OVs · {c.percentual}%</span>
                  </div>
                  <div className="h-2 rounded-full bg-gray-100 overflow-hidden">
                    <div className="h-full rounded-full transition-all duration-500"
                      style={{ width: `${c.percentual}%`, background: c.cor }} />
                  </div>
                </div>
              ))}
            </div>
            <div className="mt-5 pt-4 border-t border-gray-100 text-xs text-gray-400 space-y-0.5">
              <p>Simples: ≤ 20 unidades</p>
              <p>Média: 21 – 100 unidades</p>
              <p>Complexa: &gt; 100 unidades</p>
            </div>
          </div>
          </div>
        </div>
        )
      })()}

      {/* Modal drill-down dos KPIs do topo */}
      {kpiAberto && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={() => setKpiAberto(null)}>
          <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[80vh] flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold">{kpiAberto.titulo}</h2>
                <p className="text-xs text-gray-400 mt-0.5">{kpiLista.length} OV(s)</p>
              </div>
              <button onClick={() => setKpiAberto(null)} className="p-1.5 hover:bg-gray-100 rounded-lg">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {carregandoKpi ? (
                <p className="text-center text-gray-400 py-8 text-sm">Carregando...</p>
              ) : kpiLista.length === 0 ? (
                <p className="text-center text-gray-400 py-8 text-sm">Nenhuma OV</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">OV</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Cliente</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Etapa</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">
                        {kpiAberto.tipo === 'expedidos_hoje' ? 'Expedido em' : 'Previsto'}
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {kpiLista.map((p: any) => {
                      const cfg = STATUS_CONFIG[p.status as keyof typeof STATUS_CONFIG]
                      const dataDir = kpiAberto.tipo === 'expedidos_hoje'
                        ? (p.atualizado_em ? new Date(p.atualizado_em).toLocaleDateString('pt-BR') : '—')
                        : (p.data_prevista_entrega ? new Date(p.data_prevista_entrega + 'T12:00:00').toLocaleDateString('pt-BR') : '—')
                      return (
                        <tr key={p.id}
                          onClick={() => { setKpiAberto(null); navigate(`/expedicao/${p.id}`) }}
                          className={`hover:bg-gray-50 cursor-pointer ${p.atrasado ? 'bg-red-50' : ''}`}>
                          <td className="px-4 py-2.5 font-mono font-semibold text-indigo-700 whitespace-nowrap">{p.numero_pedido}</td>
                          <td className="px-4 py-2.5 text-gray-700 max-w-[220px] truncate">{p.cliente_nome || p.cliente?.nome || '—'}</td>
                          <td className="px-4 py-2.5">
                            <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                              style={{ background: cfg?.cor || '#E5E7EB', color: cfg?.corTexto || '#374151' }}>
                              {cfg?.icone} {cfg?.label || p.status}
                            </span>
                          </td>
                          <td className={`px-4 py-2.5 text-right text-xs whitespace-nowrap ${p.atrasado ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
                            {p.atrasado && kpiAberto.tipo !== 'expedidos_hoje' ? '⚠ ' : ''}{dataDir}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className="p-3 border-t text-xs text-gray-400 text-right">{kpiLista.length} OV(s)</div>
          </div>
        </div>
      )}

      {/* Modal drill-down por hora */}
      {horaClicada !== null && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-lg max-h-[80vh] flex flex-col">
            <div className="p-5 border-b flex items-center justify-between">
              <div>
                <h2 className="text-lg font-bold">OVs criadas às {String(horaClicada).padStart(2, '0')}h</h2>
                <p className="text-xs text-gray-400 mt-0.5">Últimos {periodoHorario} dias</p>
              </div>
              <button onClick={() => setHoraClicada(null)} className="p-1.5 hover:bg-gray-100 rounded-lg">
                <X size={18} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto">
              {carregandoOvs ? (
                <p className="text-center text-gray-400 py-8 text-sm">Carregando...</p>
              ) : ovsHora.length === 0 ? (
                <p className="text-center text-gray-400 py-8 text-sm">Nenhuma OV neste horário</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 sticky top-0">
                    <tr>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">OV</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Cliente</th>
                      <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Status</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Horário</th>
                      <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Data</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {ovsHora.map((ov: any) => {
                      const cfg = STATUS_CONFIG[ov.status as keyof typeof STATUS_CONFIG]
                      return (
                        <tr key={ov.numero_pedido + ov.data}
                          onClick={() => { setHoraClicada(null); navigate(`/expedicao/${ov.id}`) }}
                          className="hover:bg-gray-50 cursor-pointer">
                          <td className="px-4 py-2.5 font-mono font-semibold text-indigo-700">{ov.numero_pedido}</td>
                          <td className="px-4 py-2.5 text-gray-700 max-w-[160px] truncate">{ov.cliente}</td>
                          <td className="px-4 py-2.5">
                            <span className="text-xs px-2 py-0.5 rounded-full font-medium"
                              style={{ background: cfg?.cor || '#E5E7EB', color: cfg?.corTexto || '#374151' }}>
                              {cfg?.icone} {cfg?.label || ov.status}
                            </span>
                          </td>
                          <td className="px-4 py-2.5 text-right font-mono text-gray-600">{ov.horario}</td>
                          <td className="px-4 py-2.5 text-right text-gray-400 text-xs">
                            {new Date(ov.data + 'T12:00:00').toLocaleDateString('pt-BR')}
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className="p-3 border-t text-xs text-gray-400 text-right">
              {ovsHora.length} OV(s) neste horário
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

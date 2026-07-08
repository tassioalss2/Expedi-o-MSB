import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { Package, AlertTriangle, CheckCircle, Clock, Plus, FileText, Timer, DollarSign, Truck, X } from 'lucide-react'
import { calcHorasComerciais, formatarTempo, corSLA, bgSLA } from '../lib/horasComerciais'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell, ComposedChart, Line } from 'recharts'
import api from '../lib/api'
import type { DashboardOperacional, Indicadores } from '../types'
import { STATUS_CONFIG } from '../lib/statusConfig'

function KpiCard({ titulo, valor, sub, cor, icone: Icone }: {
  titulo: string; valor: string | number; sub?: string; cor: string; icone: any
}) {
  return (
    <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm text-gray-500">{titulo}</p>
          <p className={`text-3xl font-bold mt-1 ${cor}`}>{valor}</p>
          {sub && <p className="text-xs text-gray-400 mt-1">{sub}</p>}
        </div>
        <div className={`p-2.5 rounded-lg bg-gray-50`}>
          <Icone size={22} className={cor} />
        </div>
      </div>
    </div>
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

  // Mês de referência dos cards financeiros (default: mês corrente)
  const [mesFinanceiro, setMesFinanceiro] = useState(() => new Date(hoje.getFullYear(), hoje.getMonth(), 1))
  const ehMesAtual = mesFinanceiro.getFullYear() === hoje.getFullYear() && mesFinanceiro.getMonth() === hoje.getMonth()
  const inicioFinanceiro = format(new Date(mesFinanceiro.getFullYear(), mesFinanceiro.getMonth(), 1), 'yyyy-MM-dd')
  const fimFinanceiro = ehMesAtual
    ? format(hoje, 'yyyy-MM-dd')
    : format(new Date(mesFinanceiro.getFullYear(), mesFinanceiro.getMonth() + 1, 0), 'yyyy-MM-dd')
  const mesesDisponiveis = Array.from({ length: 12 }, (_, i) =>
    new Date(hoje.getFullYear(), hoje.getMonth() - i, 1)
  )

  const { data: dash } = useQuery<DashboardOperacional>({
    queryKey: ['dashboard'],
    queryFn: () => api.get('/pedidos/dashboard/operacional').then((r) => r.data),
    refetchInterval: 30000,
  })

  const { data: financeiro } = useQuery({
    queryKey: ['financeiro', inicioFinanceiro],
    queryFn: () => api.get('/pedidos/dashboard/financeiro', {
      params: {
        data_inicio: inicioFinanceiro,
        data_fim: fimFinanceiro,
      }
    }).then(r => r.data),
    refetchInterval: 60000,
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

  const { data: esforcoData } = useQuery<{ complexidade: any[]; por_dia: any[] }>({
    queryKey: ['esforco-time', periodoHorario],
    queryFn: () => api.get('/pedidos/dashboard/esforco', {
      params: { data_inicio: inicioHorario, data_fim: fimMes },
    }).then(r => r.data),
    refetchInterval: 120000,
  })

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
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
        />
        <KpiCard
          titulo="Expedidos Hoje"
          valor={dash?.expedidos_hoje || 0}
          sub="pedidos finalizados"
          cor="text-green-600"
          icone={CheckCircle}
        />
        <KpiCard
          titulo="Atrasados"
          valor={dash?.atrasados || 0}
          sub="requerem atenção"
          cor={dash?.atrasados ? 'text-red-600' : 'text-gray-400'}
          icone={AlertTriangle}
        />
        <KpiCard
          titulo="Ocorrências Abertas"
          valor={dash?.ocorrencias_abertas || 0}
          sub="sem resolução"
          cor={dash?.ocorrencias_abertas ? 'text-orange-600' : 'text-gray-400'}
          icone={Clock}
        />
      </div>

      {/* Cards Financeiros */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Financeiro — Notas faturadas no mês</h2>
        <select
          value={inicioFinanceiro}
          onChange={(e) => {
            const [y, m] = e.target.value.split('-').map(Number)
            setMesFinanceiro(new Date(y, m - 1, 1))
          }}
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500 cursor-pointer"
        >
          {mesesDisponiveis.map((d) => {
            const val = format(d, 'yyyy-MM-dd')
            return (
              <option key={val} value={val}>
                {format(d, "MMMM 'de' yyyy", { locale: ptBR })}
              </option>
            )
          })}
        </select>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Faturamento NF */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-green-50 rounded-lg">
                <DollarSign size={18} className="text-green-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-700">Faturamento NF</p>
                <p className="text-xs text-gray-400">{format(mesFinanceiro, 'MMMM/yyyy', { locale: ptBR })}</p>
              </div>
            </div>
            <span className="text-xs text-gray-400">{financeiro?.qtd_nfs || 0} NF(s)</span>
          </div>
          <p className="text-2xl font-bold text-green-600">
            {financeiro?.total_nf
              ? `R$ ${Number(financeiro.total_nf).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
              : 'R$ 0,00'}
          </p>
          {financeiro?.total_produtos > 0 && (
            <p className="text-xs text-gray-400 mt-1">
              Produtos: R$ {Number(financeiro.total_produtos).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
            </p>
          )}
          {financeiro && (
            <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs text-gray-500">
                  <span className="w-2 h-2 rounded-full bg-purple-500 inline-block" />
                  Transfer Price (Biomedical)
                  <span className="text-gray-300">· {financeiro.transfer_price?.qtd_nfs || 0} NF</span>
                </span>
                <span className="text-sm font-semibold text-purple-700">
                  R$ {Number(financeiro.transfer_price?.total_nf || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="flex items-center gap-1.5 text-xs text-gray-500">
                  <span className="w-2 h-2 rounded-full bg-green-500 inline-block" />
                  Outras Vendas
                  <span className="text-gray-300">· {financeiro.outras_vendas?.qtd_nfs || 0} NF</span>
                </span>
                <span className="text-sm font-semibold text-green-700">
                  R$ {Number(financeiro.outras_vendas?.total_nf || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          )}
        </div>

        {/* Custo de Frete */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-orange-50 rounded-lg">
                <Truck size={18} className="text-orange-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-700">Custo com Frete</p>
                <p className="text-xs text-gray-400">{format(mesFinanceiro, 'MMMM/yyyy', { locale: ptBR })}</p>
              </div>
            </div>
            <span className="text-xs text-gray-400">{financeiro?.qtd_com_frete || 0} OV(s)</span>
          </div>
          <p className="text-2xl font-bold text-orange-600">
            {financeiro?.total_frete
              ? `R$ ${Number(financeiro.total_frete).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
              : 'R$ 0,00'}
          </p>
          {financeiro?.total_nf > 0 && financeiro?.total_frete > 0 && (
            <p className="text-xs text-gray-400 mt-1">
              {((financeiro.total_frete / financeiro.total_nf) * 100).toFixed(1)}% do faturamento total
            </p>
          )}
        </div>

        {/* Ticket Médio */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-3">
            <div className="p-2 bg-blue-50 rounded-lg">
              <FileText size={18} className="text-blue-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-700">Ticket Médio por NF</p>
              <p className="text-xs text-gray-400">{format(mesFinanceiro, 'MMMM/yyyy', { locale: ptBR })}</p>
            </div>
          </div>
          <p className="text-2xl font-bold text-blue-600">
            {financeiro?.qtd_nfs > 0
              ? `R$ ${(Number(financeiro.total_nf) / financeiro.qtd_nfs).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
              : 'R$ 0,00'}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            Frete médio: {financeiro?.qtd_com_frete > 0
              ? `R$ ${(Number(financeiro.total_frete) / financeiro.qtd_com_frete).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
              : '—'}
          </p>
        </div>
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
      {esforcoData && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
          {/* Volume por dia */}
          <div className="lg:col-span-2 bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <div className="mb-1">
              <h2 className="text-sm font-semibold text-gray-700">Volume por Dia</h2>
              <p className="text-xs text-gray-400 mt-0.5">Unidades expedidas e nº de OVs — últimos {periodoHorario} dias</p>
            </div>
            <div className="flex gap-5 mb-4 text-xs text-gray-500">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded-sm bg-indigo-500 inline-block" />
                Unidades (barra)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-1 rounded bg-amber-400 inline-block" />
                OVs (linha)
              </span>
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <ComposedChart data={esforcoData.por_dia} margin={{ left: -20, bottom: 0 }}>
                <XAxis dataKey="label" tick={{ fontSize: 10 }}
                  interval={periodoHorario > 30 ? 6 : periodoHorario > 14 ? 2 : 0} />
                <YAxis yAxisId="un" orientation="left" tick={{ fontSize: 11 }} allowDecimals={false} />
                <YAxis yAxisId="ov" orientation="right" tick={{ fontSize: 11 }} allowDecimals={false} />
                <Tooltip
                  formatter={(value: any, name: string) =>
                    name === 'total_unidades' ? [`${value} un`, 'Unidades'] : [`${value} OVs`, 'OVs']
                  }
                />
                <Bar yAxisId="un" dataKey="total_unidades" fill="#6366F1" radius={[3, 3, 0, 0]} />
                <Line yAxisId="ov" type="monotone" dataKey="num_ovs" stroke="#F59E0B"
                  strokeWidth={2} dot={false} />
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Complexidade das OVs */}
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 flex flex-col">
            <div className="mb-4">
              <h2 className="text-sm font-semibold text-gray-700">Perfil das OVs</h2>
              <p className="text-xs text-gray-400 mt-0.5">Complexidade pelo total de unidades</p>
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

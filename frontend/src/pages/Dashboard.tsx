import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { Package, AlertTriangle, CheckCircle, Clock, Plus, FileText, Timer, DollarSign, Truck } from 'lucide-react'
import { calcHorasComerciais, formatarTempo, corSLA, bgSLA } from '../lib/horasComerciais'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, PieChart, Pie, Cell } from 'recharts'
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

  const { data: financeiro } = useQuery({
    queryKey: ['financeiro', format(new Date(hoje.getFullYear(), hoje.getMonth(), 1), 'yyyy-MM-dd')],
    queryFn: () => api.get('/pedidos/dashboard/financeiro', {
      params: {
        data_inicio: format(new Date(hoje.getFullYear(), hoje.getMonth(), 1), 'yyyy-MM-dd'),
        data_fim: format(hoje, 'yyyy-MM-dd'),
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

  const otifColor = (indicadores?.otif || 0) >= 95 ? '#22C55E' : (indicadores?.otif || 0) >= 90 ? '#F59E0B' : '#EF4444'

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
                <p className="text-xs text-gray-400">{format(new Date(hoje.getFullYear(), hoje.getMonth(), 1), 'MMMM/yyyy', { locale: ptBR })}</p>
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
                <p className="text-xs text-gray-400">{format(new Date(hoje.getFullYear(), hoje.getMonth(), 1), 'MMMM/yyyy', { locale: ptBR })}</p>
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
              <p className="text-xs text-gray-400">{format(new Date(hoje.getFullYear(), hoje.getMonth(), 1), 'MMMM/yyyy', { locale: ptBR })}</p>
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
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* OTIF */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <p className="text-sm text-gray-500 mb-2">OTIF — {format(hoje, 'MMMM', { locale: ptBR })}</p>
          <div className="flex items-end gap-3">
            <span className="text-5xl font-bold" style={{ color: otifColor }}>
              {indicadores?.otif?.toFixed(1) || '—'}
            </span>
            <span className="text-xl text-gray-400 mb-1">%</span>
          </div>
          <div className="mt-3 bg-gray-100 rounded-full h-2.5">
            <div
              className="h-2.5 rounded-full transition-all"
              style={{ width: `${Math.min(indicadores?.otif || 0, 100)}%`, backgroundColor: otifColor }}
            />
          </div>
          <p className="text-xs text-gray-400 mt-1.5">Meta: 95%</p>
        </div>

        {/* Taxa de divergência */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <p className="text-sm text-gray-500 mb-2">Taxa de Divergência</p>
          <span className="text-4xl font-bold text-orange-500">
            {indicadores?.taxa_divergencia?.toFixed(1) || '0'}%
          </span>
          <p className="text-xs text-gray-400 mt-1">Meta: ≤ 1%</p>
          <p className="text-sm text-gray-600 mt-3">
            <span className="font-medium">{indicadores?.pedidos_expedidos || 0}</span> pedidos expedidos no período
          </p>
        </div>

        {/* Backlog */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <p className="text-sm text-gray-500 mb-2">Backlog Total</p>
          <span className="text-4xl font-bold text-purple-600">
            {indicadores?.backlog || 0}
          </span>
          <p className="text-xs text-gray-400 mt-1">pedidos em aberto</p>
          <p className="text-sm text-gray-600 mt-3">
            Taxa de retrabalho: <span className="font-medium">{indicadores?.taxa_retrabalho?.toFixed(1) || '0'}%</span>
          </p>
        </div>
      </div>

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
    </div>
  )
}

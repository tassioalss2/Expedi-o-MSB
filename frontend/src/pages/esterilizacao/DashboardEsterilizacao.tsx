import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Package, Clock, DollarSign, TrendingUp, AlertTriangle,
  CheckCircle, Send, RotateCcw, Lock, XCircle,
} from 'lucide-react'
import { clsx } from 'clsx'
import { obterDashboard } from '../../lib/esterilizacaoApi'
import { formatarTempo, formatarMoeda } from '../../types/esterilizacao'

const MESES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho',
               'Julho','Agosto','Setembro','Outubro','Novembro','Dezembro']

function CardKPI({
  label, valor, icone, cor, sublabel,
}: {
  label: string
  valor: string | number
  icone: React.ReactNode
  cor: string
  sublabel?: string
}) {
  return (
    <div className={clsx('rounded-2xl border p-4', cor)}>
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-current opacity-70 uppercase tracking-wide mb-1">{label}</p>
          <p className="text-2xl font-extrabold">{valor}</p>
          {sublabel && <p className="text-xs opacity-60 mt-0.5">{sublabel}</p>}
        </div>
        <div className="opacity-50">{icone}</div>
      </div>
    </div>
  )
}

function BarraProgresso({ label, valor, total, cor }: { label: string; valor: number; total: number; cor: string }) {
  const pct = total > 0 ? Math.round((valor / total) * 100) : 0
  return (
    <div>
      <div className="flex items-center justify-between text-sm mb-1.5">
        <span className="text-gray-700 font-medium">{label}</span>
        <span className="text-gray-500">{valor} ({pct}%)</span>
      </div>
      <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
        <div className={clsx('h-full rounded-full transition-all', cor)} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

export function DashboardEsterilizacao() {
  const [mes, setMes] = useState(new Date().getMonth() + 1)
  const [ano, setAno] = useState(new Date().getFullYear())

  const { data: dash, isLoading } = useQuery({
    queryKey: ['dash-esterilizacao', mes, ano],
    queryFn: () => obterDashboard(mes, ano),
  })

  if (isLoading || !dash) return (
    <div className="flex items-center justify-center h-64 text-gray-400">Carregando dashboard...</div>
  )

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Dashboard — Esterilização</h1>
          <p className="text-sm text-gray-500 mt-0.5">{MESES[mes - 1]} de {ano}</p>
        </div>
        <div className="flex gap-3">
          <select
            value={mes}
            onChange={(e) => setMes(Number(e.target.value))}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {MESES.map((m, i) => <option key={i} value={i + 1}>{m}</option>)}
          </select>
          <select
            value={ano}
            onChange={(e) => setAno(Number(e.target.value))}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {[2025, 2026, 2027].map((a) => <option key={a} value={a}>{a}</option>)}
          </select>
        </div>
      </div>

      {/* KPIs principais */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <CardKPI
          label="Total de cargas"
          valor={dash.total_cargas}
          icone={<Package size={24} />}
          cor="border-blue-200 bg-blue-50 text-blue-900"
        />
        <CardKPI
          label="Cargas enviadas"
          valor={dash.enviadas + dash.retornadas}
          icone={<Send size={24} />}
          cor="border-violet-200 bg-violet-50 text-violet-900"
          sublabel={`${dash.retornadas} retornadas`}
        />
        <CardKPI
          label="Atrasadas"
          valor={dash.atrasadas}
          icone={<AlertTriangle size={24} />}
          cor={dash.atrasadas > 0 ? "border-red-300 bg-red-50 text-red-900" : "border-gray-200 bg-gray-50 text-gray-600"}
        />
        <CardKPI
          label="Aderência ao plano"
          valor={`${dash.aderencia_plan}%`}
          icone={<TrendingUp size={24} />}
          cor={dash.aderencia_plan >= 80 ? "border-green-200 bg-green-50 text-green-900" : "border-yellow-200 bg-yellow-50 text-yellow-900"}
        />
      </div>

      {/* Segunda linha */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <CardKPI
          label="Total de peças"
          valor={dash.total_pecas_mes.toLocaleString('pt-BR')}
          icone={<Package size={24} />}
          cor="border-gray-200 bg-white text-gray-900"
          sublabel={`${dash.total_caixas_mes.toLocaleString()} caixas`}
        />
        <CardKPI
          label="Valor total do mês"
          valor={formatarMoeda(dash.valor_total_mes)}
          icone={<DollarSign size={24} />}
          cor="border-gray-200 bg-white text-gray-900"
        />
        {dash.tempo_medio_ciclo_min && (
          <CardKPI
            label="Ciclo médio (criação → envio)"
            valor={formatarTempo(dash.tempo_medio_ciclo_min)}
            icone={<Clock size={24} />}
            cor="border-gray-200 bg-white text-gray-900"
          />
        )}
      </div>

      {/* Distribuição por status */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <div className="bg-white rounded-2xl border border-gray-200 p-5">
          <h2 className="font-semibold text-gray-800 mb-4">Distribuição por status</h2>
          <div className="space-y-3">
            <BarraProgresso label="Planejadas"     valor={dash.planejadas}     total={dash.total_cargas} cor="bg-gray-400" />
            <BarraProgresso label="Liberadas"      valor={dash.liberadas}      total={dash.total_cargas} cor="bg-blue-500" />
            <BarraProgresso label="Em produção"    valor={dash.em_producao}    total={dash.total_cargas} cor="bg-yellow-400" />
            <BarraProgresso label="Em separação"   valor={dash.em_separacao}   total={dash.total_cargas} cor="bg-orange-500" />
            <BarraProgresso label="Em conferência" valor={dash.em_conferencia} total={dash.total_cargas} cor="bg-purple-500" />
            <BarraProgresso label="Prontas"        valor={dash.prontas}        total={dash.total_cargas} cor="bg-green-500" />
            <BarraProgresso label="Enviadas"       valor={dash.enviadas}       total={dash.total_cargas} cor="bg-violet-500" />
            <BarraProgresso label="Retornadas"     valor={dash.retornadas}     total={dash.total_cargas} cor="bg-teal-500" />
          </div>
        </div>

        {/* Cards de status simplificados */}
        <div>
          <h2 className="font-semibold text-gray-800 mb-4">Status atual</h2>
          <div className="grid grid-cols-2 gap-3">
            {[
              { label: 'Planejada',    val: dash.planejadas,     icone: <Package size={16} />,      cor: 'border-gray-200 bg-gray-50 text-gray-700' },
              { label: 'Liberada',     val: dash.liberadas,      icone: <Package size={16} />,      cor: 'border-blue-200 bg-blue-50 text-blue-700' },
              { label: 'Em produção',  val: dash.em_producao,    icone: <Clock size={16} />,        cor: 'border-yellow-200 bg-yellow-50 text-yellow-700' },
              { label: 'Em separação', val: dash.em_separacao,   icone: <Package size={16} />,      cor: 'border-orange-200 bg-orange-50 text-orange-700' },
              { label: 'Conferência',  val: dash.em_conferencia, icone: <CheckCircle size={16} />,  cor: 'border-purple-200 bg-purple-50 text-purple-700' },
              { label: 'Pronta',       val: dash.prontas,        icone: <CheckCircle size={16} />,  cor: 'border-green-200 bg-green-50 text-green-700' },
              { label: 'Enviada',      val: dash.enviadas,       icone: <Send size={16} />,         cor: 'border-violet-200 bg-violet-50 text-violet-700' },
              { label: 'Retornada',    val: dash.retornadas,     icone: <RotateCcw size={16} />,    cor: 'border-teal-200 bg-teal-50 text-teal-700' },
              { label: 'Atrasada',     val: dash.atrasadas,      icone: <AlertTriangle size={16} />,cor: 'border-red-200 bg-red-50 text-red-700' },
              { label: 'Bloqueada',    val: dash.bloqueadas,     icone: <Lock size={16} />,         cor: 'border-red-300 bg-red-100 text-red-800' },
            ].map(({ label, val, icone, cor }) => (
              <div key={label} className={clsx('rounded-xl border p-3 flex items-center justify-between', cor)}>
                <div className="flex items-center gap-2">
                  {icone}
                  <span className="text-xs font-medium">{label}</span>
                </div>
                <span className="text-lg font-bold">{val}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

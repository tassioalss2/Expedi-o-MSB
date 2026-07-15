import { useQuery } from '@tanstack/react-query'
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, Cell } from 'recharts'
import { TrendingUp, Target, Trophy, AlertTriangle, CalendarClock, Percent } from 'lucide-react'
import api from '../../lib/api'
import { ESTAGIO_MAP, fmtBRL, fmtBRLcurto } from '../../lib/crm'
import { KPI } from './CrmShared'

const CORES: Record<string, string> = {
  LEAD: '#94a3b8', QUALIFICACAO: '#0ea5e9', PROPOSTA: '#8b5cf6', NEGOCIACAO: '#f59e0b',
}

export function CrmDashboard() {
  const { data: d, isLoading } = useQuery<any>({
    queryKey: ['crm-dashboard'],
    queryFn: () => api.get('/crm/dashboard').then(r => r.data),
    refetchInterval: 30000,
  })

  if (isLoading || !d) return <p className="text-center text-gray-400 py-10 text-sm">Carregando indicadores…</p>

  const funil = (d.por_estagio || []).map((e: any) => ({ ...e, label: ESTAGIO_MAP[e.estagio]?.label || e.label }))

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPI label="Pipeline aberto" valor={fmtBRL(d.pipeline_total)} sub={`${d.abertas_qtd} oportunidade(s)`} />
        <KPI label="Previsão ponderada" valor={fmtBRL(d.pipeline_ponderado)} sub="valor × probabilidade" cor="text-emerald-600" />
        <KPI label="Ganho no mês" valor={fmtBRL(d.ganho_mes_valor)} cor="text-emerald-600" />
        <KPI label="Taxa de ganho (90d)" valor={`${d.taxa_ganho_90d}%`} sub={`${d.ganhas_90d} ganhas · ${d.perdidas_90d} perdidas`} cor="text-blue-600" />
      </div>

      <div className="grid lg:grid-cols-3 gap-4">
        {/* Funil */}
        <div className="lg:col-span-2 bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2"><Target size={16} /> Funil de vendas (valor por estágio)</h3>
          {funil.every((f: any) => f.valor === 0) ? (
            <p className="text-sm text-gray-400 py-10 text-center">Sem oportunidades abertas ainda.</p>
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={funil} layout="vertical" margin={{ left: 10, right: 20 }}>
                <XAxis type="number" tickFormatter={(v) => fmtBRLcurto(v)} tick={{ fontSize: 11 }} />
                <YAxis type="category" dataKey="label" width={90} tick={{ fontSize: 12 }} />
                <Tooltip formatter={(v: any) => fmtBRL(Number(v))} labelStyle={{ fontSize: 12 }} />
                <Bar dataKey="valor" radius={[0, 6, 6, 0]}>
                  {funil.map((f: any) => <Cell key={f.estagio} fill={CORES[f.estagio] || '#94a3b8'} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
          <div className="grid grid-cols-4 gap-2 mt-3">
            {funil.map((f: any) => (
              <div key={f.estagio} className="text-center">
                <p className="text-[11px] text-gray-400">{f.label}</p>
                <p className="text-sm font-semibold text-gray-700">{f.qtd}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Atividades + resumo */}
        <div className="space-y-3">
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2"><CalendarClock size={16} /> Atividades</h3>
            <div className="flex items-center justify-between py-2 border-b border-gray-50">
              <span className="text-sm text-gray-600 flex items-center gap-2"><AlertTriangle size={15} className="text-red-500" /> Atrasadas</span>
              <span className={`text-lg font-bold ${d.atividades_atrasadas > 0 ? 'text-red-600' : 'text-gray-400'}`}>{d.atividades_atrasadas}</span>
            </div>
            <div className="flex items-center justify-between py-2">
              <span className="text-sm text-gray-600 flex items-center gap-2"><CalendarClock size={15} className="text-blue-500" /> Para hoje</span>
              <span className="text-lg font-bold text-blue-600">{d.atividades_hoje}</span>
            </div>
          </div>
          <div className="bg-gradient-to-br from-blue-600 to-blue-700 rounded-xl shadow-sm p-4 text-white">
            <div className="flex items-center gap-2 text-blue-100 text-xs"><Percent size={14} /> Conversão (90 dias)</div>
            <p className="text-3xl font-bold mt-1">{d.taxa_ganho_90d}%</p>
            <div className="flex items-center gap-3 mt-2 text-xs text-blue-100">
              <span className="flex items-center gap-1"><Trophy size={13} /> {d.ganhas_90d} ganhas</span>
              <span>·</span>
              <span>{d.perdidas_90d} perdidas</span>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
            <div className="flex items-center gap-2 text-gray-500 text-xs"><TrendingUp size={14} /> Previsão ponderada do pipeline</div>
            <p className="text-2xl font-bold text-emerald-600 mt-1">{fmtBRL(d.pipeline_ponderado)}</p>
            <p className="text-[11px] text-gray-400 mt-0.5">de {fmtBRL(d.pipeline_total)} em aberto</p>
          </div>
        </div>
      </div>
    </div>
  )
}

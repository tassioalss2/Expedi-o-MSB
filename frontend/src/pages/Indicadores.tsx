import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format, subDays } from 'date-fns'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, BarChart, Bar, Legend } from 'recharts'
import api from '../lib/api'
import type { Indicadores as IIndicadores } from '../types'

function MetaBar({ valor, meta, label, unidade = '%' }: {
  valor: number; meta: number; label: string; unidade?: string
}) {
  const ok = valor >= meta
  const pct = Math.min((valor / meta) * 100, 100)
  return (
    <div>
      <div className="flex justify-between items-center mb-1">
        <span className="text-sm text-gray-600">{label}</span>
        <span className={`text-sm font-bold ${ok ? 'text-green-600' : 'text-red-600'}`}>
          {valor.toFixed(1)}{unidade} {ok ? '✅' : '⚠'}
        </span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full">
        <div
          className={`h-2 rounded-full transition-all ${ok ? 'bg-green-500' : 'bg-red-500'}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <p className="text-xs text-gray-400 mt-0.5">Meta: {meta}{unidade}</p>
    </div>
  )
}

export function Indicadores() {
  const hoje = new Date()
  const [dataInicio, setDataInicio] = useState(format(subDays(hoje, 30), 'yyyy-MM-dd'))
  const [dataFim, setDataFim] = useState(format(hoje, 'yyyy-MM-dd'))

  const { data: indicadores } = useQuery<IIndicadores>({
    queryKey: ['indicadores', dataInicio, dataFim],
    queryFn: () =>
      api.get(`/pedidos/dashboard/indicadores?data_inicio=${dataInicio}&data_fim=${dataFim}`).then((r) => r.data),
  })

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-gray-900">Indicadores</h1>
        <div className="flex items-center gap-2">
          <input type="date" value={dataInicio} onChange={(e) => setDataInicio(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm" />
          <span className="text-gray-400">até</span>
          <input type="date" value={dataFim} onChange={(e) => setDataFim(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm" />
        </div>
      </div>

      {/* Metas vs Realizado */}
      <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
        <h2 className="font-semibold text-gray-800 mb-5">Performance vs Metas</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <MetaBar valor={indicadores?.otif || 0} meta={95} label="OTIF" />
          <MetaBar valor={100 - (indicadores?.taxa_divergencia || 0)} meta={99} label="Acuracidade da Expedição" />
          <MetaBar valor={100 - (indicadores?.taxa_retrabalho || 0)} meta={99.5} label="Pedidos sem Retrabalho" />
          {indicadores?.aderencia_cutoff != null && (
            <MetaBar valor={indicadores.aderencia_cutoff} meta={90} label="Aderência ao Cut-off" />
          )}
        </div>
      </div>

      {/* Números absolutos */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[
          { label: 'Pedidos Expedidos', valor: indicadores?.pedidos_expedidos || 0, sub: 'no período', cor: 'text-blue-600' },
          { label: 'Backlog Atual', valor: indicadores?.backlog || 0, sub: 'pedidos em aberto', cor: 'text-purple-600' },
          { label: 'Taxa de Divergência', valor: `${(indicadores?.taxa_divergencia || 0).toFixed(1)}%`, sub: 'meta ≤ 1%', cor: (indicadores?.taxa_divergencia || 0) <= 1 ? 'text-green-600' : 'text-red-600' },
          { label: 'Lead Time Médio', valor: `${(indicadores?.lead_time_medio_horas || 0).toFixed(1)}h`, sub: 'separação → expedição', cor: 'text-gray-700' },
        ].map((item) => (
          <div key={item.label} className="bg-white rounded-xl p-4 shadow-sm border border-gray-100">
            <p className="text-xs text-gray-500">{item.label}</p>
            <p className={`text-3xl font-bold mt-1 ${item.cor}`}>{item.valor}</p>
            <p className="text-xs text-gray-400 mt-0.5">{item.sub}</p>
          </div>
        ))}
      </div>

      {/* Guia de indicadores */}
      <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
        <h2 className="font-semibold text-gray-800 mb-4">Glossário de Indicadores</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-gray-100">
              <tr className="text-left text-gray-500">
                <th className="pb-2 pr-4">Indicador</th>
                <th className="pb-2 pr-4">Fórmula</th>
                <th className="pb-2 pr-4">Meta</th>
                <th className="pb-2">Frequência</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {[
                { nome: 'OTIF', formula: '(Entregues no prazo e completos / Total) × 100', meta: '≥ 95%', freq: 'Diária' },
                { nome: 'Acuracidade', formula: '(Pedidos sem divergência / Total) × 100', meta: '≥ 99%', freq: 'Diária' },
                { nome: 'Taxa de Divergência', formula: '(Pedidos com div. / Total conferidos) × 100', meta: '≤ 1%', freq: 'Diária' },
                { nome: 'Taxa de Retrabalho', formula: '(Pedidos com retrabalho / Total separados) × 100', meta: '≤ 0,5%', freq: 'Diária' },
                { nome: 'Aderência ao Cut-off', formula: '(Faturados antes do cut-off / Total a faturar) × 100', meta: '≥ 90%', freq: 'Diária' },
                { nome: 'Lead Time Separação', formula: 'Hora fim separação − Hora início separação', meta: '≤ 4h', freq: 'Por pedido' },
                { nome: 'Backlog', formula: 'Pedidos ativos ≠ EXPEDIDO ou CANCELADO', meta: 'Tendência ↓', freq: 'Tempo real' },
              ].map((r) => (
                <tr key={r.nome}>
                  <td className="py-2.5 pr-4 font-medium text-gray-800">{r.nome}</td>
                  <td className="py-2.5 pr-4 text-gray-500 font-mono text-xs">{r.formula}</td>
                  <td className="py-2.5 pr-4 font-semibold text-blue-700">{r.meta}</td>
                  <td className="py-2.5 text-gray-400">{r.freq}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

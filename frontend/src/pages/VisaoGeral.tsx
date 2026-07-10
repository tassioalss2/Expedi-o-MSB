import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Link, useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import {
  DollarSign, CalendarDays, Package, Truck, AlertTriangle, Clock,
  Plus, FileText, ArrowRight, X,
} from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import api from '../lib/api'
import { STATUS_CONFIG } from '../lib/statusConfig'
import type { StatusPedido } from '../types'

const fmtR$ = (v: number) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`

export function VisaoGeral() {
  const navigate = useNavigate()
  const hoje = new Date()
  const inicioMes = format(new Date(hoje.getFullYear(), hoje.getMonth(), 1), 'yyyy-MM-dd')
  const hojeStr = format(hoje, 'yyyy-MM-dd')
  const competencia = format(hoje, 'yyyy-MM')

  const { data: financeiro } = useQuery({
    queryKey: ['vg-financeiro', inicioMes],
    queryFn: () => api.get('/pedidos/dashboard/financeiro', {
      params: { data_inicio: inicioMes, data_fim: hojeStr },
    }).then(r => r.data),
    refetchInterval: 60000,
  })

  const { data: meta } = useQuery<{ valor: number | null }>({
    queryKey: ['vg-meta', competencia],
    queryFn: () => api.get(`/pedidos/meta?competencia=${competencia}`).then(r => r.data),
  })

  const { data: fatDiario } = useQuery<{ dias: Array<{ dia: string; valor: number; qtd: number }>; total: number }>({
    queryKey: ['vg-fat-diario', inicioMes],
    queryFn: () => api.get('/pedidos/dashboard/faturamento-diario', {
      params: { data_inicio: inicioMes, data_fim: hojeStr },
    }).then(r => r.data),
    refetchInterval: 60000,
  })

  const { data: fatHoje } = useQuery<{ dias: Array<{ dia: string; valor: number; qtd: number }>; total: number }>({
    queryKey: ['vg-fat-hoje', hojeStr],
    queryFn: () => api.get('/pedidos/dashboard/faturamento-diario', {
      params: { data_inicio: hojeStr, data_fim: hojeStr },
    }).then(r => r.data),
    refetchInterval: 60000,
  })

  const { data: op } = useQuery<{
    total_pedidos: number; expedidos_hoje: number; atrasados: number
    ocorrencias_abertas: number; por_status: Array<{ status: string; quantidade: number; atrasados: number }>
  }>({
    queryKey: ['vg-operacional'],
    queryFn: () => api.get('/pedidos/dashboard/operacional').then(r => r.data),
    refetchInterval: 30000,
  })

  // Drill-down: clicar em qualquer número abre a lista de NFs por trás dele.
  // dia = null -> mês inteiro; dia = 'YYYY-MM-DD' -> só aquele dia.
  const [drill, setDrill] = useState<{ titulo: string; dia: string | null } | null>(null)
  const { data: detalheMes = [], isFetching: carregandoDetalhe } = useQuery<any[]>({
    queryKey: ['vg-detalhe', inicioMes],
    queryFn: () => api.get('/pedidos/dashboard/financeiro/detalhe', {
      params: { data_inicio: inicioMes, data_fim: hojeStr },
    }).then(r => r.data),
    enabled: drill !== null,
  })
  // Escopo "Vendas": faturamento, sem Transfer Price (Biomedical) nem Esterilize.
  const linhasDrill = drill
    ? detalheMes
        .filter(r => r.eh_faturamento && !r.eh_biomedical && !/ESTERILIZE/i.test(r.cliente || ''))
        .filter(r => (drill.dia ? r.data === drill.dia : true))
        .sort((a, b) => (b.data || '').localeCompare(a.data || ''))
    : []
  const totalDrill = linhasDrill.reduce((s, r) => s + (r.valor_sem_frete || 0), 0)

  // Drill-down da logística: clicar numa etapa mostra as OVs naquele status.
  const [drillStatus, setDrillStatus] = useState<{ status: string; label: string } | null>(null)
  const { data: pedidosStatus = [], isFetching: carregandoStatus } = useQuery<any[]>({
    queryKey: ['vg-pedidos-status', drillStatus?.status],
    queryFn: () => api.get('/pedidos', { params: { status: drillStatus!.status } }).then(r => r.data),
    enabled: drillStatus !== null,
  })

  const vendas = financeiro?.outras_vendas?.faturamento_sem_frete || 0
  const metaValor = meta?.valor ?? null
  const pctMeta = metaValor && metaValor > 0 ? (vendas / metaValor) * 100 : 0
  const faltaMeta = metaValor ? metaValor - vendas : 0
  const vendasHoje = fatHoje?.total ?? 0
  const qtdHoje = fatHoje?.dias?.[0]?.qtd ?? 0

  // Saudação por horário (hora local do navegador)
  const h = hoje.getHours()
  const saudacao = h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite'

  const atalhos = [
    { label: 'Nova OV', desc: 'Cadastrar pedido', icone: Plus, to: '/expedicao/novo', cor: 'text-blue-600 bg-blue-50' },
    { label: 'Comunicado de Uso', desc: 'Faturar consignado', icone: FileText, to: '/comercial/comunicado-uso', cor: 'text-emerald-600 bg-emerald-50' },
    { label: 'Painel Comercial', desc: 'Faturamento e metas', icone: DollarSign, to: '/comercial', cor: 'text-green-600 bg-green-50' },
    { label: 'Painel Operacional', desc: 'Fluxo de expedição', icone: Package, to: '/dashboard', cor: 'text-indigo-600 bg-indigo-50' },
  ]

  const tilesLog = [
    { label: 'Pedidos em aberto', valor: op?.total_pedidos ?? 0, icone: Package, cor: 'text-indigo-600 bg-indigo-50', to: '/dashboard' },
    { label: 'Expedidos hoje', valor: op?.expedidos_hoje ?? 0, icone: Truck, cor: 'text-green-600 bg-green-50', to: '/expedicao' },
    { label: 'OVs atrasadas', valor: op?.atrasados ?? 0, icone: Clock, cor: 'text-amber-600 bg-amber-50', to: '/dashboard', alerta: (op?.atrasados ?? 0) > 0 },
    { label: 'Ocorrências abertas', valor: op?.ocorrencias_abertas ?? 0, icone: AlertTriangle, cor: 'text-red-600 bg-red-50', to: '/ocorrencias', alerta: (op?.ocorrencias_abertas ?? 0) > 0 },
  ]

  // Top status em aberto (exclui finalizados) para o mini-resumo do fluxo
  const statusAbertos = (op?.por_status ?? [])
    .filter(s => !['EXPEDIDO', 'CANCELADO'].includes(s.status))
    .sort((a, b) => b.quantidade - a.quantidade)

  return (
    <div className="p-6 space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">{saudacao}! 👋</h1>
        <p className="text-gray-500 text-sm mt-0.5 capitalize">
          {format(hoje, "EEEE, dd 'de' MMMM 'de' yyyy", { locale: ptBR })}
        </p>
      </div>

      {/* Atalhos rápidos */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        {atalhos.map((a) => (
          <Link
            key={a.to}
            to={a.to}
            className="group bg-white rounded-xl p-4 shadow-sm border border-gray-100 hover:border-gray-300 hover:shadow transition-all flex items-center gap-3"
          >
            <div className={`p-2.5 rounded-lg ${a.cor}`}><a.icone size={20} /></div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-gray-800 truncate">{a.label}</p>
              <p className="text-xs text-gray-400 truncate">{a.desc}</p>
            </div>
            <ArrowRight size={16} className="text-gray-300 group-hover:text-gray-500 transition-colors" />
          </Link>
        ))}
      </div>

      {/* ---- COMERCIAL ---- */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400">Comercial · {format(hoje, 'MMMM/yyyy', { locale: ptBR })}</h2>
          <Link to="/comercial" className="text-xs text-green-600 hover:text-green-700 font-medium flex items-center gap-1">
            Ver painel <ArrowRight size={13} />
          </Link>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Vendas do mês + meta */}
          <div
            onClick={() => setDrill({ titulo: `Vendas · ${format(hoje, 'MMMM/yyyy', { locale: ptBR })}`, dia: null })}
            className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 lg:col-span-2 flex flex-col cursor-pointer hover:border-gray-300 hover:shadow transition-all"
            title="Ver as NFs de vendas do mês"
          >
            <div className="flex items-center gap-2 mb-3">
              <div className="p-2 bg-green-50 rounded-lg"><DollarSign size={18} className="text-green-600" /></div>
              <div>
                <p className="text-sm font-semibold text-gray-700">Vendas do mês</p>
                <p className="text-xs text-gray-400">Sem frete · sem transfer price</p>
              </div>
            </div>
            <p className="text-4xl font-bold text-green-600 leading-tight">{fmtR$(vendas)}</p>
            {metaValor === null ? (
              <p className="text-xs text-gray-400 mt-2">Nenhuma meta definida para o mês.</p>
            ) : (
              <div className="mt-4">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-semibold text-gray-600">{pctMeta.toFixed(1)}% da meta</span>
                  <span className="text-gray-400">Meta {fmtR$(metaValor)}</span>
                </div>
                <div className="bg-gray-100 rounded-full h-2.5 overflow-hidden">
                  <div className={`h-2.5 rounded-full transition-all ${pctMeta >= 100 ? 'bg-green-500' : pctMeta < 70 ? 'bg-amber-500' : 'bg-green-500'}`}
                    style={{ width: `${Math.min(pctMeta, 100)}%` }} />
                </div>
                {faltaMeta > 0 && <p className="text-xs text-gray-400 mt-1.5">Faltam {fmtR$(faltaMeta)} para bater a meta</p>}
              </div>
            )}
          </div>

          {/* Faturamento de hoje */}
          <div
            onClick={() => setDrill({ titulo: `Faturamento de hoje · ${format(hoje, "dd 'de' MMMM", { locale: ptBR })}`, dia: hojeStr })}
            className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 flex flex-col cursor-pointer hover:border-gray-300 hover:shadow transition-all"
            title="Ver as NFs faturadas hoje"
          >
            <div className="flex items-center gap-2 mb-3">
              <div className="p-2 bg-green-50 rounded-lg"><CalendarDays size={18} className="text-green-600" /></div>
              <div>
                <p className="text-sm font-semibold text-gray-700">Faturamento de hoje</p>
                <p className="text-xs text-gray-400">{format(hoje, "dd 'de' MMMM", { locale: ptBR })}</p>
              </div>
            </div>
            <p className="text-3xl font-bold text-green-600 leading-tight">{fmtR$(vendasHoje)}</p>
            <p className="text-xs text-gray-400 mt-0.5">{qtdHoje} NF · Vendas sem frete</p>
          </div>
        </div>

        {/* Gráfico faturamento por dia */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 mt-4">
          <div className="flex items-baseline justify-between mb-3">
            <div>
              <h3 className="text-sm font-semibold text-gray-700">Faturamento por dia</h3>
              <p className="text-xs text-gray-400 mt-0.5">Clique numa barra para ver as NFs do dia</p>
            </div>
            <span className="text-sm font-semibold text-gray-700 tabular-nums">Total {fmtR$(fatDiario?.total ?? 0)}</span>
          </div>
          {(fatDiario?.dias?.length ?? 0) === 0 ? (
            <div className="h-48 flex items-center justify-center text-sm text-gray-400">Sem faturamento no mês</div>
          ) : (
            <ResponsiveContainer width="100%" height={200}>
              <BarChart data={fatDiario!.dias} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#f1f5f9" />
                <XAxis dataKey="dia" tickFormatter={(v: string) => v.slice(8, 10)}
                  tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={{ stroke: '#e5e7eb' }} tickLine={false}
                  interval="preserveStartEnd" minTickGap={8} />
                <YAxis tickFormatter={(v: number) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)}
                  tick={{ fontSize: 11, fill: '#94a3b8' }} axisLine={false} tickLine={false} width={44} />
                <Tooltip cursor={{ fill: 'rgba(34,197,94,0.06)' }}
                  content={({ active, payload }: any) => {
                    if (!active || !payload?.length) return null
                    const p = payload[0].payload
                    return (
                      <div className="bg-white border border-gray-200 rounded-lg shadow-sm px-3 py-2 text-xs">
                        <p className="font-semibold text-gray-700 mb-0.5 capitalize">
                          {format(new Date(p.dia + 'T00:00:00'), "EEEE, dd 'de' MMM", { locale: ptBR })}
                        </p>
                        <p className="text-green-600 font-bold text-sm">{fmtR$(p.valor)}</p>
                        <p className="text-gray-400">{p.qtd} NF</p>
                      </div>
                    )
                  }} />
                <Bar dataKey="valor" radius={[4, 4, 0, 0]} maxBarSize={28} className="cursor-pointer"
                  onClick={(d: any) => {
                    if (!d?.payload?.dia) return
                    setDrill({
                      titulo: `Faturamento · ${format(new Date(d.payload.dia + 'T00:00:00'), "dd 'de' MMMM", { locale: ptBR })}`,
                      dia: d.payload.dia,
                    })
                  }}>
                  {fatDiario!.dias.map((d) => (
                    <Cell key={d.dia} fill={d.dia === hojeStr ? '#15803d' : '#22c55e'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* ---- LOGÍSTICA ---- */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-gray-400">Logística · agora</h2>
          <Link to="/dashboard" className="text-xs text-indigo-600 hover:text-indigo-700 font-medium flex items-center gap-1">
            Ver painel <ArrowRight size={13} />
          </Link>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {tilesLog.map((t) => (
            <button key={t.label} onClick={() => navigate(t.to)}
              className={`text-left bg-white rounded-xl p-4 shadow-sm border transition-all hover:shadow ${t.alerta ? 'border-amber-200' : 'border-gray-100 hover:border-gray-300'}`}>
              <div className="flex items-center gap-2 mb-2">
                <div className={`p-2 rounded-lg ${t.cor}`}><t.icone size={18} /></div>
                <span className="text-xs text-gray-500 leading-tight">{t.label}</span>
              </div>
              <p className="text-2xl font-bold text-gray-800 tabular-nums">{t.valor}</p>
            </button>
          ))}
        </div>

        {/* Mini-resumo do fluxo por status */}
        {statusAbertos.length > 0 && (
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 mt-4">
            <p className="text-sm font-semibold text-gray-700 mb-3">Fluxo por etapa</p>
            <div className="flex flex-wrap gap-2">
              {statusAbertos.map((s) => {
                const cfg = STATUS_CONFIG[s.status as StatusPedido]
                return (
                  <button key={s.status}
                    onClick={() => setDrillStatus({ status: s.status, label: cfg?.label || s.status })}
                    className="flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm cursor-pointer hover:ring-2 hover:ring-black/10 transition-all"
                    style={{ backgroundColor: cfg?.cor || '#F3F4F6', color: cfg?.corTexto || '#374151' }}
                    title={`${cfg?.descricao || ''} — clique para ver as OVs`}>
                    <span>{cfg?.icone}</span>
                    <span className="font-medium">{cfg?.label || s.status}</span>
                    <span className="font-bold tabular-nums">{s.quantidade}</span>
                    {s.atrasados > 0 && (
                      <span className="text-[11px] font-semibold bg-white/50 rounded px-1">{s.atrasados} atras.</span>
                    )}
                  </button>
                )
              })}
            </div>
          </div>
        )}
      </div>

      {/* Drill-down: NFs por trás do número clicado */}
      {drill && (
        <div className="fixed inset-0 bg-black/40 z-40 flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setDrill(null)}>
          <div className="bg-white w-full sm:max-w-2xl sm:rounded-xl rounded-t-2xl shadow-xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h3 className="text-sm font-bold text-gray-800">{drill.titulo}</h3>
                <p className="text-xs text-gray-400 mt-0.5">
                  {linhasDrill.length} NF · Total {fmtR$(totalDrill)} · Vendas sem frete
                </p>
              </div>
              <button onClick={() => setDrill(null)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="overflow-y-auto flex-1">
              {carregandoDetalhe ? (
                <p className="text-sm text-gray-400 text-center py-10">Carregando…</p>
              ) : linhasDrill.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-10">Nenhuma NF neste período.</p>
              ) : (
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-gray-50 text-gray-500 text-xs">
                    <tr>
                      <th className="text-left font-medium px-5 py-2">OV / NF</th>
                      <th className="text-left font-medium px-2 py-2">Cliente</th>
                      <th className="text-right font-medium px-5 py-2">Valor s/ frete</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {linhasDrill.map((r) => (
                      <tr key={r.id} className="hover:bg-gray-50">
                        <td className="px-5 py-2.5 whitespace-nowrap">
                          <span className="font-mono text-gray-700">{r.numero_pedido || '—'}</span>
                          <span className="block text-xs text-gray-400">NF {r.numero_nf || '—'} · {format(new Date(r.data + 'T00:00:00'), 'dd/MM')}</span>
                        </td>
                        <td className="px-2 py-2.5 text-gray-600">{r.cliente}</td>
                        <td className="px-5 py-2.5 text-right font-semibold text-gray-800 tabular-nums whitespace-nowrap">{fmtR$(r.valor_sem_frete)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Drill-down da logística: OVs em uma etapa/status */}
      {drillStatus && (
        <div className="fixed inset-0 bg-black/40 z-40 flex items-end sm:items-center justify-center p-0 sm:p-4"
          onClick={() => setDrillStatus(null)}>
          <div className="bg-white w-full sm:max-w-2xl sm:rounded-xl rounded-t-2xl shadow-xl max-h-[85vh] flex flex-col"
            onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-gray-100">
              <div>
                <h3 className="text-sm font-bold text-gray-800">Etapa · {drillStatus.label}</h3>
                <p className="text-xs text-gray-400 mt-0.5">{pedidosStatus.length} OV(s)</p>
              </div>
              <button onClick={() => setDrillStatus(null)} className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600">
                <X size={18} />
              </button>
            </div>
            <div className="overflow-y-auto flex-1">
              {carregandoStatus ? (
                <p className="text-sm text-gray-400 text-center py-10">Carregando…</p>
              ) : pedidosStatus.length === 0 ? (
                <p className="text-sm text-gray-400 text-center py-10">Nenhuma OV nesta etapa.</p>
              ) : (
                <div className="divide-y divide-gray-50">
                  {pedidosStatus.map((p) => (
                    <button key={p.id}
                      onClick={() => { setDrillStatus(null); navigate(`/expedicao/${p.id}`) }}
                      className="w-full text-left px-5 py-2.5 hover:bg-gray-50 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <span className="font-mono text-sm text-gray-700">{p.numero_pedido || '—'}</span>
                        <span className="block text-xs text-gray-500 truncate">{p.cliente_nome || '—'}</span>
                      </div>
                      <div className="text-right shrink-0">
                        {p.atrasado && (
                          <span className="text-[11px] font-semibold text-amber-700 bg-amber-100 rounded px-1.5 py-0.5">atrasado</span>
                        )}
                        <span className="block text-xs text-gray-400 mt-0.5">
                          {p.data_prevista_entrega ? format(new Date(p.data_prevista_entrega + 'T00:00:00'), 'dd/MM') : '—'}
                        </span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

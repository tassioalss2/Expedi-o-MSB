import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { format, subDays } from 'date-fns'
import { X, Info } from 'lucide-react'
import api from '../lib/api'
import type { Indicadores as IIndicadores } from '../types'

type Drill = {
  titulo: string
  valorTexto: string
  fonte: string
  formula: string
  metrica?: string
  listaLabel?: string
}

// Colunas de cada detalhamento (chave no objeto → rótulo exibido)
const DETALHE_COLS: Record<string, { key: string; label: string; tipo?: 'bool_prazo' | 'bool_atraso' | 'horas' }[]> = {
  otif_atrasados: [
    { key: 'numero_pedido', label: 'OV' }, { key: 'cliente', label: 'Cliente' },
    { key: 'data_prevista', label: 'Previsto' }, { key: 'data_real', label: 'Expedido' },
    { key: 'dias_atraso', label: 'Atraso (dias)' },
  ],
  otif_falhas: [
    { key: 'numero_pedido', label: 'OV' }, { key: 'cliente', label: 'Cliente' },
    { key: 'motivo', label: 'Motivo' }, { key: 'data_prevista', label: 'Previsto' },
    { key: 'data_real', label: 'Expedido' }, { key: 'pedido_un', label: 'Pedido (un)' },
    { key: 'separado_un', label: 'Separado (un)' },
  ],
  divergencias: [
    { key: 'numero_pedido', label: 'OV' }, { key: 'cliente', label: 'Cliente' },
    { key: 'data', label: 'Data' }, { key: 'descricao', label: 'Descrição' },
    { key: 'status_ocorrencia', label: 'Status' },
  ],
  retrabalhos: [
    { key: 'numero_pedido', label: 'OV' }, { key: 'cliente', label: 'Cliente' },
    { key: 'tipo', label: 'Tipo' }, { key: 'data', label: 'Data' },
    { key: 'status_ocorrencia', label: 'Status' },
  ],
  backlog: [
    { key: 'numero_pedido', label: 'OV' }, { key: 'cliente', label: 'Cliente' },
    { key: 'status', label: 'Status' }, { key: 'prioridade', label: 'Prioridade' },
    { key: 'data_prevista', label: 'Previsto' }, { key: 'atrasado', label: 'Situação', tipo: 'bool_atraso' },
  ],
  expedidos: [
    { key: 'numero_pedido', label: 'OV' }, { key: 'cliente', label: 'Cliente' },
    { key: 'data_expedicao', label: 'Expedido' }, { key: 'data_prevista', label: 'Previsto' },
    { key: 'no_prazo', label: 'No prazo?', tipo: 'bool_prazo' },
  ],
  lead_time: [
    { key: 'numero_pedido', label: 'OV' }, { key: 'cliente', label: 'Cliente' },
    { key: 'entrada', label: 'Entrada' }, { key: 'expedido', label: 'Expedido' },
    { key: 'horas', label: 'Horas', tipo: 'horas' },
  ],
}

function MetaBar({ valor, meta, label, unidade = '%', onClick }: {
  valor: number; meta: number; label: string; unidade?: string; onClick?: () => void
}) {
  const ok = valor >= meta
  const pct = Math.min((valor / meta) * 100, 100)
  return (
    <button type="button" onClick={onClick} className="w-full text-left group">
      <div className="flex justify-between items-center mb-1">
        <span className="text-sm text-gray-600 group-hover:text-blue-600">{label}</span>
        <span className={`text-sm font-bold ${ok ? 'text-green-600' : 'text-red-600'}`}>
          {valor.toFixed(1)}{unidade} {ok ? '✅' : '⚠'}
        </span>
      </div>
      <div className="h-2 bg-gray-100 rounded-full">
        <div className={`h-2 rounded-full transition-all ${ok ? 'bg-green-500' : 'bg-red-500'}`}
          style={{ width: `${pct}%` }} />
      </div>
      <p className="text-xs text-gray-400 mt-0.5">Meta: {meta}{unidade} · <span className="text-blue-500 group-hover:underline">ver detalhes</span></p>
    </button>
  )
}

export function Indicadores() {
  const hoje = new Date()
  const [dataInicio, setDataInicio] = useState(format(subDays(hoje, 30), 'yyyy-MM-dd'))
  const [dataFim, setDataFim] = useState(format(hoje, 'yyyy-MM-dd'))
  const [drill, setDrill] = useState<Drill | null>(null)

  const { data: indicadores } = useQuery<IIndicadores>({
    queryKey: ['indicadores', dataInicio, dataFim],
    queryFn: () =>
      api.get(`/pedidos/dashboard/indicadores?data_inicio=${dataInicio}&data_fim=${dataFim}`).then((r) => r.data),
  })

  const { data: detalhes = [], isFetching: carregandoDet } = useQuery<any[]>({
    queryKey: ['indicadores-detalhes', drill?.metrica, dataInicio, dataFim],
    queryFn: () => api.get('/pedidos/dashboard/indicadores/detalhes', {
      params: { metrica: drill!.metrica, data_inicio: dataInicio, data_fim: dataFim },
    }).then((r) => r.data),
    enabled: !!drill?.metrica,
  })

  const { data: financeiro } = useQuery<any>({
    queryKey: ['financeiro-ind', dataInicio, dataFim],
    queryFn: () => api.get('/pedidos/dashboard/financeiro', {
      params: { data_inicio: dataInicio, data_fim: dataFim },
    }).then((r) => r.data),
  })

  const div = indicadores?.taxa_divergencia || 0
  const retr = indicadores?.taxa_retrabalho || 0
  const fatSemFrete = financeiro?.faturamento_sem_frete || 0
  const freteProprio = financeiro?.frete_proprio || 0
  const fretePct = fatSemFrete > 0 ? (freteProprio / fatSemFrete) * 100 : 0
  const brl = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

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
          <MetaBar valor={indicadores?.otif || 0} meta={95} label="OTIF"
            onClick={() => setDrill({
              titulo: 'OTIF (On Time In Full)', valorTexto: `${(indicadores?.otif || 0).toFixed(1)}%`,
              fonte: `OVs com status EXPEDIDO no período. On Time = ${(indicadores?.otif_on_time ?? 0).toFixed(1)}% · In Full = ${(indicadores?.otif_in_full ?? 0).toFixed(1)}%.`,
              formula: 'OTIF = (OVs expedidas no prazo E completas ÷ total expedidas) × 100. On Time: expedida até a data prevista. In Full: unidades separadas ≥ unidades pedidas na OV (OVs sem itens cadastrados não são penalizadas).',
              metrica: 'otif_falhas', listaLabel: 'OVs que furaram o OTIF (atraso e/ou incompletas)',
            })} />
          <MetaBar valor={100 - div} meta={99} label="Acuracidade da Expedição"
            onClick={() => setDrill({
              titulo: 'Acuracidade da Expedição', valorTexto: `${(100 - div).toFixed(1)}%`,
              fonte: 'Ocorrências do tipo "Divergência de Estoque" abertas no período vs OVs expedidas.',
              formula: 'Acuracidade = 100 − Taxa de Divergência. Taxa de Divergência = (ocorrências de divergência ÷ OVs expedidas) × 100.',
              metrica: 'divergencias', listaLabel: 'Ocorrências de divergência de estoque',
            })} />
          <MetaBar valor={100 - retr} meta={99.1} label="Pedidos sem Retrabalho"
            onClick={() => setDrill({
              titulo: 'Pedidos sem Retrabalho', valorTexto: `${(100 - retr).toFixed(1)}%`,
              fonte: 'Ocorrências marcadas como retrabalho no período vs OVs expedidas.',
              formula: 'Sem Retrabalho = 100 − Taxa de Retrabalho. Taxa de Retrabalho = (OVs com ≥1 ocorrência de retrabalho ÷ OVs expedidas) × 100.',
              metrica: 'retrabalhos', listaLabel: 'Ocorrências de retrabalho',
            })} />
          {indicadores?.aderencia_cutoff != null && (
            <MetaBar valor={indicadores.aderencia_cutoff} meta={90} label="Aderência ao Cut-off" />
          )}
        </div>
      </div>

      {/* Números absolutos */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-4">
        {[
          {
            label: 'Pedidos Expedidos', valor: `${indicadores?.pedidos_expedidos || 0}`, sub: 'no período', cor: 'text-blue-600',
            drill: {
              titulo: 'Pedidos Expedidos', valorTexto: `${indicadores?.pedidos_expedidos || 0}`,
              fonte: 'OVs com status EXPEDIDO e atualizado_em dentro do período.',
              formula: 'Contagem simples dessas OVs.', metrica: 'expedidos', listaLabel: 'OVs expedidas no período',
            } as Drill,
          },
          {
            label: 'Backlog Atual', valor: `${indicadores?.backlog || 0}`, sub: 'pedidos em aberto', cor: 'text-purple-600',
            drill: {
              titulo: 'Backlog Atual', valorTexto: `${indicadores?.backlog || 0}`,
              fonte: 'OVs em qualquer status ativo (tudo que não é EXPEDIDO nem CANCELADO). É tempo real — não depende do período.',
              formula: 'Contagem das OVs ativas.', metrica: 'backlog', listaLabel: 'OVs em aberto',
            } as Drill,
          },
          {
            label: 'Taxa de Divergência', valor: `${div.toFixed(1)}%`, sub: 'meta ≤ 1%', cor: div <= 1 ? 'text-green-600' : 'text-red-600',
            drill: {
              titulo: 'Taxa de Divergência', valorTexto: `${div.toFixed(1)}%`,
              fonte: 'Ocorrências do tipo "Divergência de Estoque" abertas no período vs OVs expedidas.',
              formula: 'Taxa de Divergência = (ocorrências de divergência ÷ OVs expedidas) × 100.',
              metrica: 'divergencias', listaLabel: 'Ocorrências de divergência de estoque',
            } as Drill,
          },
          {
            label: 'Lead Time Médio', valor: `${(indicadores?.lead_time_medio_horas || 0).toFixed(1)}h`, sub: 'separação → expedição', cor: 'text-gray-700',
            drill: {
              titulo: 'Lead Time Médio', valorTexto: `${(indicadores?.lead_time_medio_horas || 0).toFixed(1)}h`,
              fonte: 'OVs expedidas no período. O horário de expedição vem da movimentação EXPEDIDO (ou, na falta, do atualizado_em).',
              formula: 'Média de (expedição − criação da OV), em horas. Cada OV aparece com suas horas abaixo — a média delas é o número exibido.',
              metrica: 'lead_time', listaLabel: 'Lead time por OV (maiores primeiro)',
            } as Drill,
          },
          {
            label: '% Frete / Venda', valor: `${fretePct.toFixed(1)}%`, sub: 'meta ≤ 1,6%', cor: fretePct <= 1.6 ? 'text-green-600' : 'text-red-600',
            drill: {
              titulo: '% Frete / Venda', valorTexto: `${fretePct.toFixed(1)}%`,
              fonte: 'Frete próprio (CIF sem valor na NF — o frete que a empresa absorve, não ressarcido pelo cliente) das notas faturadas no período.',
              formula: `% Frete/Venda = frete próprio ÷ faturamento (sem frete) × 100. No período: R$ ${brl(freteProprio)} ÷ R$ ${brl(fatSemFrete)}.`,
            } as Drill,
          },
        ].map((item) => (
          <button key={item.label} type="button" onClick={() => setDrill(item.drill)}
            className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 text-left hover:border-blue-300 hover:shadow transition">
            <p className="text-xs text-gray-500 flex items-center gap-1">{item.label} <Info size={11} className="text-gray-300" /></p>
            <p className={`text-3xl font-bold mt-1 ${item.cor}`}>{item.valor}</p>
            <p className="text-xs text-gray-400 mt-0.5">{item.sub}</p>
          </button>
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
                { nome: 'Taxa de Retrabalho', formula: '(Pedidos com retrabalho / Total separados) × 100', meta: '≤ 0,9%', freq: 'Diária' },
                { nome: '% Frete / Venda', formula: '(Frete próprio / Faturamento sem frete) × 100', meta: '≤ 1,6%', freq: 'Mensal' },
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

      {/* Modal drill-down */}
      {drill && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={() => setDrill(null)}>
          <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b flex items-start justify-between">
              <div>
                <h2 className="text-lg font-bold text-gray-800">{drill.titulo}</h2>
                <p className="text-2xl font-bold text-blue-600 mt-0.5">{drill.valorTexto}</p>
              </div>
              <button onClick={() => setDrill(null)} className="p-1.5 hover:bg-gray-100 rounded-lg"><X size={18} /></button>
            </div>

            {/* Explicação: fonte + fórmula */}
            <div className="px-5 py-4 bg-gray-50 border-b space-y-2">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">De onde vem</p>
                <p className="text-sm text-gray-700">{drill.fonte}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-gray-400">Como é calculado</p>
                <p className="text-sm text-gray-700">{drill.formula}</p>
              </div>
            </div>

            {/* Lista de registros */}
            <div className="flex-1 overflow-y-auto">
              {!drill.metrica ? (
                <p className="text-center text-gray-400 py-8 text-sm">Sem detalhamento por registro para este indicador.</p>
              ) : carregandoDet ? (
                <p className="text-center text-gray-400 py-8 text-sm">Carregando...</p>
              ) : detalhes.length === 0 ? (
                <p className="text-center text-gray-400 py-8 text-sm">Nenhum registro no período.</p>
              ) : (
                <>
                  {drill.listaLabel && (
                    <p className="px-5 pt-3 text-xs text-gray-400">{drill.listaLabel} · {detalhes.length} registro(s)</p>
                  )}
                  <table className="w-full text-sm mt-1">
                    <thead className="bg-white sticky top-0">
                      <tr className="text-left text-gray-500 border-b">
                        {DETALHE_COLS[drill.metrica]?.map((c) => (
                          <th key={c.key} className="px-4 py-2 text-xs font-semibold">{c.label}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-50">
                      {detalhes.map((row, i) => (
                        <tr key={i} className="hover:bg-gray-50">
                          {DETALHE_COLS[drill.metrica!]?.map((c) => (
                            <td key={c.key} className="px-4 py-2 text-gray-700">
                              {c.tipo === 'bool_prazo' ? (row[c.key] ? '✅ Sim' : '⚠ Não')
                                : c.tipo === 'bool_atraso' ? (row[c.key] ? '⚠ Atrasado' : 'No prazo')
                                : c.tipo === 'horas' ? (row[c.key] == null ? '—' : `${row[c.key]}h`)
                                : (row[c.key] ?? '—')}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

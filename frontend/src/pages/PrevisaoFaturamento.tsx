import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { TrendingUp, CalendarDays, Plus, Trash2, Check, X, CircleDollarSign, Package, Handshake, Target, Info } from 'lucide-react'
import api from '../lib/api'
import { fmtBRL, fmtData, msgErro } from '../lib/crm'

interface Negocio {
  id: string
  cliente?: string
  cliente_nome?: string
  descricao?: string
  valor: number
  probabilidade: number
  valor_ponderado: number
  previsao_fechamento?: string | null
  canal?: string | null
  status: string
}
interface PipelineItem {
  id: string; numero_pedido: string; status: string; cliente?: string
  canal?: string; data_prevista_entrega?: string; valor_estimado: number; quase_nf: boolean
}
interface Resumo {
  competencia: string; hoje: string
  mes: {
    realizado: number; em_processo: number; saldo_contratos: number; garantido: number
    negociacao_bruto: number; negociacao_ponderado: number; previsao: number
    meta: number | null; atingimento_previsto_pct: number | null
  }
  dia: {
    sai_hoje: number; no_kanban: number; ovs_kanban: number; quase_nf: number; negociacao_hoje: number
    dias_uteis_restantes: number; falta_meta: number | null; ritmo_necessario: number | null
    no_ritmo: boolean | null
  }
  pipeline: PipelineItem[]
  negocios: Negocio[]
  realizado_itens: RealizadoItem[]
  contratos: ContratoItem[]
}
interface RealizadoItem {
  numero_pedido: string; cliente?: string; numero_nf?: string; data?: string; valor: number
}
interface ContratoItem {
  numero?: string; numero_pregao?: string; total: number; faturado: number; saldo: number
}

const STATUS_OV: Record<string, string> = {
  AGUARD_CREDITO: 'Ger. Crédito', LIBERADO: 'Liberado', EM_INVENTARIO: 'Inventário',
  AGUARD_VERIFICACAO: 'Verificação', DIVERGENCIA: 'Divergência', AGUARD_TRATATIVA: 'Tratativa',
  EM_PROCESSO_SISTEMICO: 'Proc. Sistêmico', EM_COTACAO_FRETE: 'Cotação de Frete',
  AGUARD_TRANSPORTADORA: 'Aguard. Transportadora', AGUARD_FATURAMENTO: 'Aguard. Faturamento',
}

export function PrevisaoFaturamento() {
  const qc = useQueryClient()
  const [detalhe, setDetalhe] = useState<DetalheTipo | null>(null)
  const { data, isLoading } = useQuery<Resumo>({
    queryKey: ['previsao-resumo'],
    queryFn: () => api.get('/previsao/resumo').then(r => r.data),
  })
  const recarregar = () => qc.invalidateQueries({ queryKey: ['previsao-resumo'] })

  if (isLoading || !data) {
    return <div className="p-6 text-gray-400 text-sm">Carregando previsão…</div>
  }

  const { mes, dia, pipeline, negocios } = data

  return (
    <div className="p-4 sm:p-6 space-y-5 max-w-6xl mx-auto">
      <div className="flex items-center gap-2">
        <TrendingUp className="text-indigo-600" size={22} />
        <div>
          <h1 className="text-xl font-bold text-gray-800">Previsão de Faturamento</h1>
          <p className="text-sm text-gray-500">Competência {mes_label(data.competencia)} · fechamento do mês e do dia</p>
        </div>
      </div>

      {/* ── Previsão do MÊS ─────────────────────────────────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold text-gray-700 flex items-center gap-2"><CalendarDays size={16} /> Previsão do mês</h2>
            {mes.meta != null && (
              <span className="text-xs text-gray-500">Meta {fmtBRL(mes.meta)} · previsto {mes.atingimento_previsto_pct}%</span>
            )}
          </div>
          <button onClick={() => setDetalhe('previsao_mes')} className="text-left group">
            <p className="text-3xl font-bold text-indigo-600 tabular-nums group-hover:underline decoration-indigo-300 underline-offset-4">{fmtBRL(mes.previsao)}</p>
          </button>
          {mes.meta != null && (
            <div className="mt-3 h-2.5 rounded-full bg-gray-100 overflow-hidden">
              <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${Math.min(100, mes.atingimento_previsto_pct || 0)}%` }} />
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4">
            <Mini titulo="Realizado" icone={<CircleDollarSign size={14} />} valor={mes.realizado} cor="text-emerald-600" onClick={() => setDetalhe('realizado')} />
            <Mini titulo="Em processo (OVs)" icone={<Package size={14} />} valor={mes.em_processo} cor="text-blue-600" onClick={() => setDetalhe('em_processo')} />
            <Mini titulo="Saldo de contratos" icone={<Handshake size={14} />} valor={mes.saldo_contratos} cor="text-teal-600" onClick={() => setDetalhe('saldo_contratos')} />
          </div>
          <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-2 gap-3">
            <button onClick={() => setDetalhe('garantido')} className="bg-emerald-50 rounded-xl p-3 text-left hover:ring-2 hover:ring-emerald-200">
              <p className="text-[11px] text-emerald-700 font-semibold uppercase flex items-center gap-1">Garantido <Info size={11} className="opacity-50" /></p>
              <p className="text-lg font-bold text-emerald-700 tabular-nums">{fmtBRL(mes.garantido)}</p>
              <p className="text-[11px] text-emerald-600/70">realizado + processo + contratos</p>
            </button>
            <button onClick={() => setDetalhe('negociacao')} className="bg-amber-50 rounded-xl p-3 text-left hover:ring-2 hover:ring-amber-200">
              <p className="text-[11px] text-amber-700 font-semibold uppercase flex items-center gap-1">Em negociação (ponderado) <Info size={11} className="opacity-50" /></p>
              <p className="text-lg font-bold text-amber-700 tabular-nums">{fmtBRL(mes.negociacao_ponderado)}</p>
              <p className="text-[11px] text-amber-600/70">bruto {fmtBRL(mes.negociacao_bruto)} × chance</p>
            </button>
          </div>
        </div>

        {/* ── Previsão do DIA ───────────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <h2 className="font-semibold text-gray-700 flex items-center gap-2 mb-3"><Target size={16} /> Previsão do dia</h2>
          <button onClick={() => setDetalhe('sai_hoje')} className="text-left group w-full">
            <p className="text-[11px] text-gray-400 uppercase font-semibold flex items-center gap-1">Sai hoje (prestes a faturar) <Info size={11} className="opacity-40" /></p>
            <p className="text-2xl font-bold text-indigo-600 tabular-nums group-hover:underline decoration-indigo-300 underline-offset-4">{fmtBRL(dia.sai_hoje)}</p>
            <p className="text-[11px] text-gray-400 mt-0.5">
              OVs prestes a faturar {fmtBRL(dia.quase_nf)} + negócios de hoje {fmtBRL(dia.negociacao_hoje)}
            </p>
          </button>
          <button onClick={() => setDetalhe('no_kanban')} className="text-left group w-full mt-2">
            <p className="text-[11px] text-gray-400 uppercase font-semibold flex items-center gap-1">No kanban (potencial) <Info size={11} className="opacity-40" /></p>
            <p className="text-lg font-bold text-gray-700 tabular-nums group-hover:underline decoration-gray-300 underline-offset-4">{fmtBRL(dia.no_kanban)}</p>
            <p className="text-[11px] text-gray-400 mt-0.5">todas as OVs do kanban + negócios de hoje</p>
          </button>
          <div className="mt-4 pt-3 border-t border-gray-100">
            {dia.ritmo_necessario != null ? (
              <button onClick={() => setDetalhe('ritmo')} className="text-left group w-full">
                <p className="text-[11px] text-gray-400 uppercase font-semibold flex items-center gap-1">Ritmo p/ bater a meta <Info size={11} className="opacity-40" /></p>
                <p className="text-2xl font-bold text-gray-800 tabular-nums group-hover:underline decoration-gray-300 underline-offset-4">{fmtBRL(dia.ritmo_necessario)}<span className="text-sm font-normal text-gray-400">/dia útil</span></p>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  faltam {fmtBRL(dia.falta_meta || 0)} em {dia.dias_uteis_restantes} dia(s) útil(eis)
                </p>
              </button>
            ) : (
              <>
                <p className="text-[11px] text-gray-400 uppercase font-semibold">Ritmo p/ bater a meta</p>
                <p className="text-sm text-gray-400 mt-1">Defina a meta do mês no Painel Comercial para calcular o ritmo.</p>
              </>
            )}
          </div>

          {/* Sinal: volume no kanban x ritmo necessário */}
          {dia.no_ritmo != null && dia.ritmo_necessario != null && (
            <div className={`mt-4 rounded-xl p-3 border ${dia.no_ritmo ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
              <p className={`text-sm font-bold flex items-center gap-1.5 ${dia.no_ritmo ? 'text-emerald-700' : 'text-red-700'}`}>
                {dia.no_ritmo ? '✅ Volume dentro do ritmo' : '⚠️ Volume abaixo do ritmo'}
              </p>
              <p className={`text-[11px] mt-0.5 ${dia.no_ritmo ? 'text-emerald-600/80' : 'text-red-600/80'}`}>
                {dia.no_ritmo
                  ? `O kanban tem ${fmtBRL(dia.no_kanban)}, cobrindo o ritmo de ${fmtBRL(dia.ritmo_necessario)}/dia (folga de ${fmtBRL(dia.no_kanban - dia.ritmo_necessario)}).`
                  : `O kanban tem ${fmtBRL(dia.no_kanban)}, ${fmtBRL(dia.ritmo_necessario - dia.no_kanban)} abaixo do ritmo de ${fmtBRL(dia.ritmo_necessario)}/dia — precisa entrar mais OV.`}
              </p>
            </div>
          )}
        </div>
      </div>

      {/* ── Em negociação (entrada rápida) ──────────────────────────── */}
      <SecaoNegocios negocios={negocios} onChange={recarregar} />

      {/* ── Em processo (não faturado) ──────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
        <h2 className="font-semibold text-gray-700 flex items-center gap-2 mb-1"><Package size={16} /> Em processo — vai faturar</h2>
        <p className="text-xs text-gray-400 mb-3">OVs no pipeline ainda não faturadas · valor estimado pelos itens</p>
        {pipeline.length === 0 ? (
          <p className="text-sm text-gray-400 py-3 text-center">Nenhuma OV em processo.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-[11px] uppercase text-gray-400 text-left border-b">
                  <th className="py-2 font-medium">OV</th>
                  <th className="py-2 font-medium">Cliente</th>
                  <th className="py-2 font-medium">Etapa</th>
                  <th className="py-2 font-medium">Entrega</th>
                  <th className="py-2 font-medium text-right">Valor estimado</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {pipeline.map(p => (
                  <tr key={p.id} className="hover:bg-gray-50/60">
                    <td className="py-2 font-mono text-gray-700">{p.numero_pedido}</td>
                    <td className="py-2 text-gray-700 truncate max-w-[200px]">{p.cliente || '—'}</td>
                    <td className="py-2">
                      <span className={`text-[11px] px-2 py-0.5 rounded-full ${p.quase_nf ? 'bg-indigo-100 text-indigo-700' : 'bg-gray-100 text-gray-600'}`}>
                        {STATUS_OV[p.status] || p.status}
                      </span>
                    </td>
                    <td className="py-2 text-gray-500 whitespace-nowrap">{fmtData(p.data_prevista_entrega)}</td>
                    <td className="py-2 text-right font-medium tabular-nums text-gray-800">{p.valor_estimado ? fmtBRL(p.valor_estimado) : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {detalhe && <DetalheModal tipo={detalhe} data={data} onClose={() => setDetalhe(null)} />}
    </div>
  )
}

function Mini({ titulo, valor, cor, icone, onClick }: { titulo: string; valor: number; cor: string; icone: React.ReactNode; onClick?: () => void }) {
  return (
    <button onClick={onClick} disabled={!onClick} className="bg-gray-50 rounded-xl p-3 text-left w-full enabled:hover:ring-2 enabled:hover:ring-gray-200 enabled:cursor-pointer">
      <p className="text-[11px] text-gray-400 font-medium flex items-center gap-1">{icone} {titulo} {onClick && <Info size={10} className="opacity-40" />}</p>
      <p className={`text-base font-bold tabular-nums ${cor}`}>{fmtBRL(valor)}</p>
    </button>
  )
}

// ── Modal de detalhe: mostra o que gera cada número ──────────────────────────────
type DetalheTipo = 'previsao_mes' | 'realizado' | 'em_processo' | 'saldo_contratos' | 'garantido' | 'negociacao' | 'sai_hoje' | 'no_kanban' | 'ritmo'

function DetalheModal({ tipo, data, onClose }: { tipo: DetalheTipo; data: Resumo; onClose: () => void }) {
  const { mes, dia, pipeline, negocios, realizado_itens, contratos } = data
  const quaseNf = pipeline.filter(p => p.quase_nf)
  const negHoje = negocios.filter(n => n.previsao_fechamento === data.hoje)

  const TITULOS: Record<DetalheTipo, string> = {
    previsao_mes: 'Previsão do mês', realizado: 'Realizado no mês', em_processo: 'Em processo (OVs)',
    saldo_contratos: 'Saldo de contratos', garantido: 'Garantido', negociacao: 'Em negociação',
    sai_hoje: 'Sai hoje (prestes a faturar)', no_kanban: 'No kanban (potencial)', ritmo: 'Ritmo p/ bater a meta',
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[85vh] flex flex-col" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-800">{TITULOS[tipo]}</h2>
            <p className="text-xs text-gray-400">De onde vem o número</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><X size={18} /></button>
        </div>
        <div className="p-5 overflow-y-auto">
          {tipo === 'previsao_mes' && (
            <Composicao linhas={[
              { rotulo: 'Garantido (realizado + processo + contratos)', valor: mes.garantido },
              { rotulo: 'Em negociação (ponderado pela chance)', valor: mes.negociacao_ponderado },
            ]} total={mes.previsao} />
          )}
          {tipo === 'garantido' && (
            <Composicao linhas={[
              { rotulo: 'Realizado (NFs já faturadas no mês)', valor: mes.realizado },
              { rotulo: 'Em processo (OVs no pipeline)', valor: mes.em_processo },
              { rotulo: 'Saldo de contratos ganhos', valor: mes.saldo_contratos },
            ]} total={mes.garantido} />
          )}
          {tipo === 'ritmo' && (
            <div className="text-sm">
              <div className="flex justify-between py-2 border-b border-gray-50 text-gray-700"><span>Meta do mês</span><span className="tabular-nums font-medium">{fmtBRL(mes.meta || 0)}</span></div>
              <div className="flex justify-between py-2 border-b border-gray-50 text-gray-700"><span>Já realizado</span><span className="tabular-nums font-medium">− {fmtBRL(mes.realizado)}</span></div>
              <div className="flex justify-between py-2 border-b border-gray-50 text-gray-700"><span>Falta para a meta</span><span className="tabular-nums font-medium">{fmtBRL(dia.falta_meta || 0)}</span></div>
              <div className="flex justify-between py-2 border-b border-gray-50 text-gray-500"><span>Dias úteis restantes</span><span className="tabular-nums font-medium">{dia.dias_uteis_restantes}</span></div>
              <div className="flex justify-between pt-3 mt-1">
                <span className="font-semibold text-gray-800">Ritmo necessário / dia útil</span>
                <span className="tabular-nums font-bold text-lg text-gray-800">{fmtBRL(dia.ritmo_necessario || 0)}</span>
              </div>
              <p className="text-[11px] text-gray-400 mt-2">Falta ÷ dias úteis restantes = ritmo necessário por dia.</p>
            </div>
          )}
          {tipo === 'sai_hoje' && (
            <div className="space-y-4">
              <p className="text-xs text-gray-500">O que realisticamente deve faturar hoje: OVs já prestes a sair (cotação de frete, aguardando transportadora ou aguardando NF) mais os negócios com fechamento previsto para hoje.</p>
              <Composicao linhas={[
                { rotulo: 'OVs prestes a faturar', valor: dia.quase_nf },
                { rotulo: 'Negócios com fechamento previsto para hoje', valor: dia.negociacao_hoje },
              ]} total={dia.sai_hoje} />
              {quaseNf.length > 0 && (
                <div>
                  <p className="text-[11px] uppercase text-gray-400 font-semibold mb-1">OVs prestes a faturar</p>
                  <Tabela cols={['OV', 'Cliente', 'Etapa', 'Valor est.']} total={dia.quase_nf}
                    linhas={quaseNf.map(p => [p.numero_pedido, p.cliente || '—', STATUS_OV[p.status] || p.status, fmtBRL(p.valor_estimado)])} />
                </div>
              )}
              {negHoje.length > 0 && (
                <div>
                  <p className="text-[11px] uppercase text-gray-400 font-semibold mb-1">Negócios de hoje</p>
                  <Tabela cols={['Cliente', 'Chance', 'Ponderado']}
                    linhas={negHoje.map(n => [n.cliente || n.cliente_nome || '—', `${n.probabilidade}%`, fmtBRL(n.valor_ponderado)])} />
                </div>
              )}
            </div>
          )}
          {tipo === 'no_kanban' && (
            <div className="space-y-4">
              <p className="text-xs text-gray-500">Volume total em aberto no kanban (todas as etapas antes do faturamento) mais os negócios de hoje. Serve para ver se há material suficiente para cobrir o ritmo do dia.</p>
              <Composicao linhas={[
                { rotulo: 'Todas as OVs no kanban', valor: dia.ovs_kanban },
                { rotulo: 'Negócios com fechamento previsto para hoje', valor: dia.negociacao_hoje },
              ]} total={dia.no_kanban} />
              {pipeline.length > 0 && (
                <div>
                  <p className="text-[11px] uppercase text-gray-400 font-semibold mb-1">OVs no kanban</p>
                  <Tabela cols={['OV', 'Cliente', 'Etapa', 'Valor est.']} total={dia.ovs_kanban}
                    linhas={pipeline.map(p => [p.numero_pedido, p.cliente || '—', STATUS_OV[p.status] || p.status, fmtBRL(p.valor_estimado)])} />
                </div>
              )}
            </div>
          )}
          {tipo === 'realizado' && (
            realizado_itens.length === 0
              ? <Vazio texto="Nenhuma NF faturada no mês ainda." />
              : <Tabela cols={['OV', 'Cliente', 'NF', 'Data', 'Valor']} total={mes.realizado}
                  linhas={realizado_itens.map(r => [r.numero_pedido, r.cliente || '—', r.numero_nf || '—', fmtData(r.data), fmtBRL(r.valor)])} />
          )}
          {tipo === 'em_processo' && (
            pipeline.length === 0
              ? <Vazio texto="Nenhuma OV em processo." />
              : <Tabela cols={['OV', 'Cliente', 'Etapa', 'Entrega', 'Valor est.']} total={mes.em_processo}
                  linhas={pipeline.map(p => [p.numero_pedido, p.cliente || '—', STATUS_OV[p.status] || p.status, fmtData(p.data_prevista_entrega), fmtBRL(p.valor_estimado)])} />
          )}
          {tipo === 'saldo_contratos' && (
            contratos.length === 0
              ? <Vazio texto="Nenhum contrato com saldo a faturar." />
              : <Tabela cols={['Contrato / Pregão', 'Total', 'Faturado', 'Saldo']} total={mes.saldo_contratos}
                  linhas={contratos.map(c => [c.numero_pregao || c.numero || '—', fmtBRL(c.total), fmtBRL(c.faturado), fmtBRL(c.saldo)])} />
          )}
          {tipo === 'negociacao' && (
            negocios.length === 0
              ? <Vazio texto="Nenhum negócio em negociação." />
              : <Tabela cols={['Cliente', 'Previsão', 'Chance', 'Valor', 'Ponderado']} total={mes.negociacao_ponderado} totalCol={4}
                  linhas={negocios.map(n => [n.cliente || n.cliente_nome || '—', fmtData(n.previsao_fechamento), `${n.probabilidade}%`, fmtBRL(n.valor), fmtBRL(n.valor_ponderado)])} />
          )}
        </div>
      </div>
    </div>
  )
}

function Composicao({ linhas, total, totalRotulo = 'Total', totalCor = 'text-indigo-600' }: {
  linhas: { rotulo: string; valor: number; sub?: boolean }[]; total: number; totalRotulo?: string; totalCor?: string
}) {
  return (
    <div className="text-sm">
      {linhas.map((l, i) => (
        <div key={i} className={`flex justify-between py-2 border-b border-gray-50 ${l.sub ? 'text-gray-500' : 'text-gray-700'}`}>
          <span>{l.rotulo}</span>
          <span className="tabular-nums font-medium">{fmtBRL(l.valor)}</span>
        </div>
      ))}
      <div className="flex justify-between pt-3 mt-1">
        <span className="font-semibold text-gray-800">{totalRotulo}</span>
        <span className={`tabular-nums font-bold text-lg ${totalCor}`}>{fmtBRL(total)}</span>
      </div>
    </div>
  )
}

function Tabela({ cols, linhas, total, totalCol }: { cols: string[]; linhas: (string | number)[][]; total?: number; totalCol?: number }) {
  const ultima = cols.length - 1
  const colTotal = totalCol ?? ultima
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase text-gray-400 text-left border-b">
            {cols.map((c, i) => <th key={i} className={`py-2 font-medium ${i >= 1 && i === ultima ? 'text-right' : ''}`}>{c}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {linhas.map((row, i) => (
            <tr key={i} className="hover:bg-gray-50/60">
              {row.map((cell, j) => (
                <td key={j} className={`py-2 ${j === 0 ? 'font-mono text-gray-700' : 'text-gray-700'} ${j === ultima ? 'text-right tabular-nums font-medium' : ''}`}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
        {total != null && (
          <tfoot>
            <tr className="border-t">
              <td className="pt-2 text-xs text-gray-400" colSpan={colTotal}>{linhas.length} item(ns)</td>
              <td className="pt-2 text-right tabular-nums font-bold text-gray-800" colSpan={cols.length - colTotal}>{fmtBRL(total)}</td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  )
}

function Vazio({ texto }: { texto: string }) {
  return <p className="text-sm text-gray-400 py-6 text-center">{texto}</p>
}

// ── Seção de negócios em negociação (entrada rápida) ─────────────────────────────
function SecaoNegocios({ negocios, onChange }: { negocios: Negocio[]; onChange: () => void }) {
  const [novo, setNovo] = useState(false)

  const remover = useMutation({
    mutationFn: (id: string) => api.delete(`/previsao/negocios/${id}`),
    onSuccess: () => { toast.success('Removido'); onChange() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao remover')),
  })
  const mudarStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.put(`/previsao/negocios/${id}`, { status }),
    onSuccess: () => { onChange() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao atualizar')),
  })

  const totalBruto = negocios.reduce((s, n) => s + n.valor, 0)
  const totalPond = negocios.reduce((s, n) => s + n.valor_ponderado, 0)

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
      <div className="flex items-center justify-between mb-1">
        <h2 className="font-semibold text-gray-700 flex items-center gap-2"><Handshake size={16} /> Em negociação — falta só fechar</h2>
        <button onClick={() => setNovo(v => !v)} className="text-sm flex items-center gap-1 text-indigo-600 hover:text-indigo-500 font-medium">
          <Plus size={15} /> Novo negócio
        </button>
      </div>
      <p className="text-xs text-gray-400 mb-3">
        {negocios.length} em aberto · bruto {fmtBRL(totalBruto)} · ponderado {fmtBRL(totalPond)}
      </p>

      {novo && <FormNovo onDone={() => { setNovo(false); onChange() }} onCancel={() => setNovo(false)} />}

      {negocios.length === 0 && !novo ? (
        <p className="text-sm text-gray-400 py-3 text-center">Nenhum negócio em negociação. Clique em "Novo negócio".</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase text-gray-400 text-left border-b">
                <th className="py-2 font-medium">Cliente / negócio</th>
                <th className="py-2 font-medium">Previsão</th>
                <th className="py-2 font-medium text-center">Chance</th>
                <th className="py-2 font-medium text-right">Valor</th>
                <th className="py-2 font-medium text-right">Ponderado</th>
                <th className="py-2 font-medium text-right">Ações</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {negocios.map(n => (
                <tr key={n.id} className="hover:bg-gray-50/60">
                  <td className="py-2">
                    <p className="font-medium text-gray-800">{n.cliente || n.cliente_nome || 'Sem cliente'}</p>
                    {n.descricao && <p className="text-[11px] text-gray-400">{n.descricao}</p>}
                  </td>
                  <td className="py-2 text-gray-500 whitespace-nowrap">{fmtData(n.previsao_fechamento)}</td>
                  <td className="py-2 text-center"><span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">{n.probabilidade}%</span></td>
                  <td className="py-2 text-right tabular-nums text-gray-700">{fmtBRL(n.valor)}</td>
                  <td className="py-2 text-right tabular-nums font-medium text-amber-700">{fmtBRL(n.valor_ponderado)}</td>
                  <td className="py-2">
                    <div className="flex items-center justify-end gap-1">
                      <button title="Marcar como ganho" onClick={() => mudarStatus.mutate({ id: n.id, status: 'GANHO' })}
                        className="p-1.5 rounded-lg text-emerald-600 hover:bg-emerald-50"><Check size={15} /></button>
                      <button title="Marcar como perdido" onClick={() => mudarStatus.mutate({ id: n.id, status: 'PERDIDO' })}
                        className="p-1.5 rounded-lg text-gray-400 hover:bg-gray-100"><X size={15} /></button>
                      <button title="Remover" onClick={() => remover.mutate(n.id)}
                        className="p-1.5 rounded-lg text-red-500 hover:bg-red-50"><Trash2 size={15} /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function FormNovo({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [cliente, setCliente] = useState('')
  const [descricao, setDescricao] = useState('')
  const [valor, setValor] = useState('')
  const [prob, setProb] = useState('50')
  const [data, setData] = useState('')
  const valido = Number(valor) > 0 && cliente.trim().length > 0

  const criar = useMutation({
    mutationFn: () => api.post('/previsao/negocios', {
      cliente_nome: cliente.trim(),
      descricao: descricao.trim() || null,
      valor: Number(valor),
      probabilidade: Math.max(0, Math.min(100, Number(prob) || 0)),
      previsao_fechamento: data || null,
    }),
    onSuccess: () => { toast.success('Negócio adicionado'); onDone() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao adicionar')),
  })

  const inp = 'border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500'
  return (
    <div className="bg-indigo-50/50 border border-indigo-100 rounded-xl p-3 mb-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-6 gap-2">
        <input className={`${inp} lg:col-span-2`} placeholder="Cliente *" value={cliente} onChange={e => setCliente(e.target.value)} autoFocus />
        <input className={`${inp} lg:col-span-1`} placeholder="Valor (R$) *" type="number" step="0.01" min="0" value={valor} onChange={e => setValor(e.target.value)} />
        <input className={`${inp} lg:col-span-1`} placeholder="Chance %" type="number" min="0" max="100" value={prob} onChange={e => setProb(e.target.value)} />
        <input className={`${inp} lg:col-span-2`} type="date" value={data} onChange={e => setData(e.target.value)} />
        <input className={`${inp} lg:col-span-4`} placeholder="Descrição (opcional)" value={descricao} onChange={e => setDescricao(e.target.value)} />
        <div className="lg:col-span-2 flex gap-2">
          <button onClick={onCancel} className="flex-1 py-2 border rounded-lg text-sm text-gray-600">Cancelar</button>
          <button onClick={() => criar.mutate()} disabled={!valido || criar.isPending}
            className="flex-1 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium hover:bg-indigo-500 disabled:opacity-50">
            {criar.isPending ? 'Salvando…' : 'Adicionar'}
          </button>
        </div>
      </div>
    </div>
  )
}

function mes_label(comp: string): string {
  const [a, m] = comp.split('-')
  const meses = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez']
  return `${meses[Number(m) - 1] || m}/${a}`
}

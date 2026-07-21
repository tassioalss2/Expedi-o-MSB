import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { TrendingUp, CalendarDays, Plus, Trash2, Check, X, CircleDollarSign, Package, Handshake, Target } from 'lucide-react'
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
    previsto_hoje: number; quase_nf: number; negociacao_hoje: number
    dias_uteis_restantes: number; falta_meta: number | null; ritmo_necessario: number | null
  }
  pipeline: PipelineItem[]
  negocios: Negocio[]
}

const STATUS_OV: Record<string, string> = {
  AGUARD_CREDITO: 'Ger. Crédito', LIBERADO: 'Liberado', EM_INVENTARIO: 'Inventário',
  AGUARD_VERIFICACAO: 'Verificação', DIVERGENCIA: 'Divergência', AGUARD_TRATATIVA: 'Tratativa',
  EM_PROCESSO_SISTEMICO: 'Proc. Sistêmico', EM_COTACAO_FRETE: 'Cotação de Frete',
  AGUARD_FATURAMENTO: 'Aguard. Faturamento',
}

export function PrevisaoFaturamento() {
  const qc = useQueryClient()
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
          <p className="text-3xl font-bold text-indigo-600 tabular-nums">{fmtBRL(mes.previsao)}</p>
          {mes.meta != null && (
            <div className="mt-3 h-2.5 rounded-full bg-gray-100 overflow-hidden">
              <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${Math.min(100, mes.atingimento_previsto_pct || 0)}%` }} />
            </div>
          )}
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mt-4">
            <Mini titulo="Realizado" icone={<CircleDollarSign size={14} />} valor={mes.realizado} cor="text-emerald-600" />
            <Mini titulo="Em processo (OVs)" icone={<Package size={14} />} valor={mes.em_processo} cor="text-blue-600" />
            <Mini titulo="Saldo de contratos" icone={<Handshake size={14} />} valor={mes.saldo_contratos} cor="text-teal-600" />
          </div>
          <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-2 gap-3">
            <div className="bg-emerald-50 rounded-xl p-3">
              <p className="text-[11px] text-emerald-700 font-semibold uppercase">Garantido</p>
              <p className="text-lg font-bold text-emerald-700 tabular-nums">{fmtBRL(mes.garantido)}</p>
              <p className="text-[11px] text-emerald-600/70">realizado + processo + contratos</p>
            </div>
            <div className="bg-amber-50 rounded-xl p-3">
              <p className="text-[11px] text-amber-700 font-semibold uppercase">Em negociação (ponderado)</p>
              <p className="text-lg font-bold text-amber-700 tabular-nums">{fmtBRL(mes.negociacao_ponderado)}</p>
              <p className="text-[11px] text-amber-600/70">bruto {fmtBRL(mes.negociacao_bruto)} × chance</p>
            </div>
          </div>
        </div>

        {/* ── Previsão do DIA ───────────────────────────────────────── */}
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-5">
          <h2 className="font-semibold text-gray-700 flex items-center gap-2 mb-3"><Target size={16} /> Previsão do dia</h2>
          <p className="text-[11px] text-gray-400 uppercase font-semibold">Deve faturar hoje</p>
          <p className="text-2xl font-bold text-indigo-600 tabular-nums">{fmtBRL(dia.previsto_hoje)}</p>
          <p className="text-[11px] text-gray-400 mt-0.5">
            OVs prestes a faturar {fmtBRL(dia.quase_nf)} + negócios de hoje {fmtBRL(dia.negociacao_hoje)}
          </p>
          <div className="mt-4 pt-3 border-t border-gray-100">
            <p className="text-[11px] text-gray-400 uppercase font-semibold">Ritmo p/ bater a meta</p>
            {dia.ritmo_necessario != null ? (
              <>
                <p className="text-2xl font-bold text-gray-800 tabular-nums">{fmtBRL(dia.ritmo_necessario)}<span className="text-sm font-normal text-gray-400">/dia útil</span></p>
                <p className="text-[11px] text-gray-400 mt-0.5">
                  faltam {fmtBRL(dia.falta_meta || 0)} em {dia.dias_uteis_restantes} dia(s) útil(eis)
                </p>
              </>
            ) : (
              <p className="text-sm text-gray-400 mt-1">Defina a meta do mês no Painel Comercial para calcular o ritmo.</p>
            )}
          </div>
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
    </div>
  )
}

function Mini({ titulo, valor, cor, icone }: { titulo: string; valor: number; cor: string; icone: React.ReactNode }) {
  return (
    <div className="bg-gray-50 rounded-xl p-3">
      <p className="text-[11px] text-gray-400 font-medium flex items-center gap-1">{icone} {titulo}</p>
      <p className={`text-base font-bold tabular-nums ${cor}`}>{fmtBRL(valor)}</p>
    </div>
  )
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

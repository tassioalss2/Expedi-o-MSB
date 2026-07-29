import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RefreshCw, TrendingDown, Trophy, Boxes, Sparkles, PlusCircle } from 'lucide-react'
import api from '../../lib/api'
import { CANAL_LABEL } from '../../lib/statusConfig'
import { fmtBRL, fmtData } from '../../lib/crm'
import { KPI } from './CrmShared'
import { ModalOportunidadeForm } from './CrmPipeline'

export function CrmInteligencia() {
  const [prefill, setPrefill] = useState<any | null>(null)

  const { data: d, isLoading, refetch, isFetching } = useQuery<any>({
    queryKey: ['crm-inteligencia'],
    queryFn: () => api.get('/crm/inteligencia').then(r => r.data),
  })

  if (isLoading || !d) return <p className="text-center text-gray-400 py-10 text-sm">Analisando seus dados de venda…</p>

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-gray-400 flex items-center gap-1.5">
          <Sparkles size={13} className="text-blue-500" />
          Oportunidades geradas a partir dos seus próprios dados de venda ({d.base_pedidos} pedidos analisados{d.amostra_limitada ? ', amostra recente' : ''}).
        </p>
        <button onClick={() => refetch()} className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-blue-600">
          <RefreshCw size={14} className={isFetching ? 'animate-spin' : ''} /> Atualizar
        </button>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <KPI label="Clientes ativos" valor={String(d.resumo.clientes_ativos)} sub="compraram nos últimos 180 dias" />
        <KPI label="Clientes inativos" valor={String(d.resumo.clientes_inativos)} sub={`sem comprar há ${d.dias_inatividade}+ dias`} cor="text-amber-600" />
        <KPI label="Faturamento em risco" valor={fmtBRL(d.resumo.valor_em_risco)} sub="histórico dos inativos" cor="text-red-600" />
        <KPI label="Sugestões cross-sell" valor={String((d.cross_sell || []).length)} sub="clientes com potencial" cor="text-emerald-600" />
      </div>

      <div className="grid lg:grid-cols-2 gap-4">
        {/* Win-back */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2"><TrendingDown size={16} className="text-amber-600" /> Recuperar (win-back)</h3>
          {(d.win_back || []).length === 0 ? <p className="text-sm text-gray-400">Nenhum cliente inativo relevante. 🎉</p> : (
            <div className="space-y-2 max-h-[420px] overflow-y-auto">
              {d.win_back.map((w: any) => (
                <div key={w.cliente_id} className="flex items-center gap-2 p-2 rounded-lg border border-gray-100">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium text-gray-800 truncate">{w.cliente}</p>
                    <p className="text-[11px] text-gray-400">
                      {w.dias_inativo} dias inativo · {w.pedidos} pedido(s) · última {fmtData(w.ultima_compra)}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="text-sm font-semibold text-gray-700">{fmtBRL(w.valor_historico)}</p>
                    <button onClick={() => setPrefill({
                      titulo: `Recompra — ${w.cliente}`, cliente_id: w.cliente_id, cliente: w.cliente,
                      canal: w.canal, valor_estimado: w.valor_historico, estagio: 'QUALIFICACAO', origem: 'Cliente recorrente',
                    })} className="text-[11px] text-blue-600 hover:underline flex items-center gap-1 ml-auto"><PlusCircle size={12} /> oportunidade</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Cross-sell */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2"><Sparkles size={16} className="text-emerald-600" /> Cross-sell (venda cruzada)</h3>
          {(d.cross_sell || []).length === 0 ? <p className="text-sm text-gray-400">Sem sugestões (precisa de mais histórico de itens).</p> : (
            <div className="space-y-2 max-h-[420px] overflow-y-auto">
              {d.cross_sell.map((cs: any) => (
                <div key={cs.cliente_id} className="p-2 rounded-lg border border-gray-100">
                  <div className="flex items-center justify-between">
                    <p className="text-sm font-medium text-gray-800 truncate">{cs.cliente}</p>
                    <button onClick={() => setPrefill({
                      titulo: `Cross-sell — ${cs.cliente}`, cliente_id: cs.cliente_id, cliente: cs.cliente,
                      canal: cs.canal, estagio: 'QUALIFICACAO', origem: 'Prospecção ativa',
                      itens: cs.sugestoes.map((s: any) => ({ produto_id: s.produto_id, codigo: s.codigo, descricao: s.descricao, qtd: 1, valor_unitario: 0 })),
                    })} className="text-[11px] text-blue-600 hover:underline flex items-center gap-1"><PlusCircle size={12} /> oportunidade</button>
                  </div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {cs.sugestoes.map((s: any) => (
                      <span key={s.produto_id} className="text-[11px] bg-emerald-50 text-emerald-700 rounded px-1.5 py-0.5">{s.codigo || s.descricao}</span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Top clientes */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2"><Trophy size={16} className="text-blue-600" /> Top clientes</h3>
          <div className="space-y-1.5 max-h-[360px] overflow-y-auto">
            {(d.top_clientes || []).map((t: any, i: number) => (
              <div key={t.cliente_id} className="flex items-center gap-2 text-sm">
                <span className="w-5 text-gray-300 font-semibold text-xs">{i + 1}</span>
                <span className="flex-1 truncate text-gray-700">{t.cliente}</span>
                <span className="text-[11px] text-gray-400">{t.pedidos}p</span>
                <span className="font-semibold text-gray-700 tabular-nums">{fmtBRL(t.valor)}</span>
              </div>
            ))}
          </div>
        </div>

        {/* Produtos por canal */}
        <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
          <h3 className="text-sm font-semibold text-gray-700 mb-3 flex items-center gap-2"><Boxes size={16} className="text-violet-600" /> Produtos mais vendidos por canal</h3>
          <div className="space-y-3 max-h-[360px] overflow-y-auto">
            {(d.produtos_por_canal || []).map((pc: any) => (
              <div key={pc.canal}>
                <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">{CANAL_LABEL[pc.canal] || pc.canal}</p>
                <div className="space-y-1">
                  {pc.produtos.slice(0, 5).map((p: any) => (
                    <div key={p.produto_id} className="flex justify-between text-xs">
                      <span className="text-gray-600 truncate"><span className="font-mono">{p.codigo}</span> {p.descricao}</span>
                      <span className="text-gray-400 tabular-nums flex-shrink-0 ml-2">{p.qtd}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
            {(d.produtos_por_canal || []).length === 0 && <p className="text-sm text-gray-400">Sem histórico de itens suficiente.</p>}
          </div>
        </div>
      </div>

      {prefill && <ModalOportunidadeForm prefill={prefill} onClose={() => setPrefill(null)} onSaved={() => setPrefill(null)} />}
    </div>
  )
}

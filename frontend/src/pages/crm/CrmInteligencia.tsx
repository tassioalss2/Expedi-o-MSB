// Inteligência de mercado sobre o faturamento REAL.
//
// A versão anterior mostrava 4 KPIs zerados e três painéis vazios: dependia de
// 90 dias de inatividade numa base que começa em 29/05/2026 (impossível), e
// somava transfer price, bonificação e amostra como se fossem venda. Aqui cada
// bloco ou mostra número com ação, ou explica exatamente o que falta para
// existir — painel vazio sem explicação é o que fazia a aba "não dizer nada".
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import {
  Sparkles, TrendingUp, TrendingDown, AlertTriangle, PackageX, Package,
  UserMinus, UserPlus, DollarSign, Info, Trophy, Boxes, PlusCircle, RefreshCw,
  Percent, MapPin, Users,
} from 'lucide-react'
import api from '../../lib/api'
import { CANAL_LABEL } from '../../lib/statusConfig'
import { fmtBRL, fmtBRLcurto, fmtData, msgErro } from '../../lib/crm'
import { ModalOportunidadeForm } from './CrmPipeline'

const JANELAS = [30, 60, 90]

/** Milhões: fmtBRLcurto só sabe abreviar em "k", e "R$ 31.727,1k" não se lê. */
const fmtMi = (v: number) =>
  Math.abs(v) >= 1_000_000
    ? `R$ ${(v / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} mi`
    : fmtBRLcurto(v)

/** O D365 exporta o tipo em caixa alta com acento; aqui fica legível. */
const TIPO_LABEL: Record<string, string> = {
  DISTRIBUIDOR: 'Distribuidor',
  ORGAO_PUBLICO: 'Órgão público',
  VENDA_DIRETA: 'Venda direta',
}

/** Cor por tipo de prejuízo: vermelho = venda se perdendo agora,
 *  âmbar = capital parado, verde = oportunidade de crescer. */
const GRUPO_ESTILO: Record<string, { cor: string; borda: string; icone: any }> = {
  RUPTURA: { cor: 'bg-red-50 text-red-800', borda: 'border-red-200', icone: PackageX },
  EM_ALTA: { cor: 'bg-emerald-50 text-emerald-800', borda: 'border-emerald-200', icone: TrendingUp },
  EM_QUEDA: { cor: 'bg-orange-50 text-orange-800', borda: 'border-orange-200', icone: TrendingDown },
  PARADO: { cor: 'bg-amber-50 text-amber-800', borda: 'border-amber-200', icone: Boxes },
}

function Vazio({ motivo }: { motivo?: string }) {
  return (
    <div className="flex items-start gap-2 text-xs text-gray-500 bg-gray-50 rounded-lg p-3">
      <Info size={14} className="mt-px shrink-0 text-gray-400" />
      <span>{motivo || 'Sem dados suficientes ainda.'}</span>
    </div>
  )
}

function Card({ titulo, icone: Icone, children, acao }: {
  titulo: string; icone: any; children: any; acao?: string
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 p-5">
      <div className="flex items-start justify-between gap-3 mb-3">
        <h3 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
          <Icone size={15} /> {titulo}
        </h3>
        {acao && <span className="text-[11px] text-gray-400 text-right max-w-[45%]">{acao}</span>}
      </div>
      {children}
    </div>
  )
}

export function CrmInteligencia() {
  const [janela, setJanela] = useState(30)
  const [prefill, setPrefill] = useState<any | null>(null)

  const { data: d, isLoading, isError, error, refetch, isFetching } = useQuery<any>({
    queryKey: ['crm-inteligencia', janela],
    queryFn: () => api.get('/crm/inteligencia', { params: { janela_dias: janela } }).then(r => r.data),
  })

  if (isError) {
    return (
      <div className="bg-white rounded-xl border border-red-200 p-6">
        <p className="text-sm font-medium text-red-700 flex items-center gap-2">
          <AlertTriangle size={16} /> Não foi possível carregar a inteligência
        </p>
        <p className="text-xs text-red-600 mt-1">{msgErro(error, 'Erro inesperado')}</p>
        <button onClick={() => refetch()} className="mt-3 text-xs text-blue-600 hover:underline">Tentar de novo</button>
      </div>
    )
  }
  if (isLoading || !d) return <p className="text-center text-gray-400 py-12 text-sm">Analisando o faturamento…</p>

  const p = d.periodo
  const cresceu = (p.variacao_pct ?? 0) >= 0
  const abc = d.abc || {}
  const conc = abc.concentracao || {}
  const carteira = d.carteira || {}
  const produtos = d.produtos || {}
  const rent = d.rentabilidade || {}
  const precos = d.precos || {}
  const perdas = d.perdas || {}
  const canais = d.canais || []
  const semCanal = canais.find((c: any) => c.canal === 'SEM_CANAL')
  const totalCanais = canais.reduce((a: number, x: any) => a + x.valor, 0)

  return (
    <div className="space-y-4">
      {/* Escopo + janela — deixa explícito o que está sendo contado. */}
      <div className="bg-white rounded-xl border border-gray-100 p-5">
        <div className="flex items-start justify-between gap-4 flex-wrap">
          <div className="min-w-0">
            <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
              <Sparkles size={16} className="text-blue-500" /> Inteligência de mercado
            </h2>
            <p className="text-xs text-gray-400 mt-0.5">{d.escopo}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="flex border border-gray-200 rounded-lg overflow-hidden">
              {JANELAS.map(j => (
                <button key={j} onClick={() => setJanela(j)}
                  className={`px-3 py-1.5 text-xs ${janela === j ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}>
                  {j}d
                </button>
              ))}
            </div>
            <button onClick={() => refetch()} className="p-1.5 text-gray-400 hover:text-blue-600" title="Atualizar">
              <RefreshCw size={15} className={isFetching ? 'animate-spin' : ''} />
            </button>
          </div>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4">
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-[11px] text-gray-400">Faturamento · {janela}d</p>
            <p className="text-lg font-bold text-gray-800 tabular-nums">{fmtBRL(p.atual.faturamento)}</p>
            {p.variacao_pct != null && (
              <p className={`text-[11px] flex items-center gap-1 ${cresceu ? 'text-emerald-600' : 'text-red-600'}`}>
                {cresceu ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                {cresceu ? '+' : ''}{p.variacao_pct}% vs {janela}d anteriores
              </p>
            )}
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-[11px] text-gray-400">Ticket médio</p>
            <p className="text-lg font-bold text-gray-800 tabular-nums">{fmtBRL(d.ticket_medio)}</p>
            <p className="text-[11px] text-gray-400">{p.atual.nfs} NF(s) faturada(s)</p>
          </div>
          <div className="bg-gray-50 rounded-lg p-3">
            <p className="text-[11px] text-gray-400">Clientes que compraram</p>
            <p className="text-lg font-bold text-gray-800 tabular-nums">{p.atual.clientes}</p>
            <p className="text-[11px] text-gray-400">{p.anterior.clientes} no período anterior</p>
          </div>
          <div className={`rounded-lg p-3 ${conc.risco === 'ALTO' ? 'bg-red-50' : conc.risco === 'MEDIO' ? 'bg-amber-50' : 'bg-gray-50'}`}>
            <p className="text-[11px] text-gray-400">Maior cliente</p>
            <p className="text-lg font-bold text-gray-800 tabular-nums">{conc.top1_pct ?? '—'}%</p>
            <p className="text-[11px] text-gray-400">top 5 = {conc.top5_pct ?? '—'}% do total</p>
          </div>
        </div>

        {/* Qualidade do dado: canal vazio cega toda a análise por linha. */}
        {semCanal && semCanal.nfs > 0 && (
          <div className="mt-3 text-xs bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-amber-800">
            <strong>{semCanal.nfs} NF(s)</strong> sem canal preenchido ({fmtBRL(semCanal.valor)}) — não entram
            em nenhuma análise por linha de negócio. Preencher o canal na OV resolve.
          </div>
        )}
      </div>

      {/* ── RADAR DE PRODUTOS: o bloco com mais sinal ─────────────────────── */}
      <Card titulo="Radar de produtos" icone={Package}
        acao={produtos.disponivel
          ? `${produtos.base_produtos} produtos · venda real do D365 até ${produtos.ultimo_mes_fechado} × estoque de ${fmtData(produtos.data_ref)}`
          : undefined}>
        {!produtos.disponivel ? <Vazio motivo={produtos.motivo} /> : (
          <div className="grid md:grid-cols-2 gap-3">
            {(produtos.grupos || []).map((g: any) => {
              const st = GRUPO_ESTILO[g.chave] || GRUPO_ESTILO.PARADO
              const Icone = st.icone
              return (
                <div key={g.chave} className={`rounded-lg border ${st.borda} overflow-hidden`}>
                  <div className={`px-3 py-2 ${st.cor}`}>
                    <p className="text-sm font-semibold flex items-center gap-1.5">
                      <Icone size={14} /> {g.label}
                      <span className="ml-auto text-xs font-bold bg-white/60 rounded-full px-2">{g.total}</span>
                    </p>
                    <p className="text-[11px] opacity-80 mt-0.5">{g.acao}</p>
                  </div>
                  {g.total === 0 ? (
                    <p className="text-xs text-gray-400 text-center py-4">Nenhum item nesta situação 🎉</p>
                  ) : (
                    <div className="divide-y divide-gray-50">
                      {g.itens.map((i: any) => (
                        <div key={i.codigo} className="px-3 py-2">
                          <div className="flex items-baseline justify-between gap-2">
                            <span className="font-mono text-xs text-gray-700">{i.codigo}</span>
                            {i.tendencia_pct != null && (
                              <span className={`text-[11px] tabular-nums ${i.tendencia_pct >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                {i.tendencia_pct >= 0 ? '+' : ''}{i.tendencia_pct}%
                              </span>
                            )}
                          </div>
                          <p className="text-[11px] text-gray-500 truncate" title={i.descricao}>{i.descricao}</p>
                          <p className="text-[11px] text-gray-400 tabular-nums">
                            disponível <strong className={i.disponivel <= 0 ? 'text-red-600' : 'text-gray-600'}>{i.disponivel}</strong>
                            {' · '}consumo {i.consumo_medio}/mês
                            {i.cobertura != null && <> · cobre {String(i.cobertura).replace('.', ',')} mês(es)</>}
                          </p>
                        </div>
                      ))}
                      {g.total > g.itens.length && (
                        <p className="text-[11px] text-gray-400 px-3 py-1.5">+ {g.total - g.itens.length} outros</p>
                      )}
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        )}
      </Card>

      {/* ── RENTABILIDADE: 19 meses com custo ─────────────────────────────── */}
      {rent.disponivel ? (
        <>
          <Card titulo="Rentabilidade" icone={Percent}
            acao={`${rent.periodo.meses} meses (${rent.periodo.de} a ${rent.periodo.ate}) · ${rent.linhas} itens de fatura do D365`}>
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
              {/* fmtBRLcurto só abrevia em "k" — em milhões viraria "31.727,1k". */}
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-[11px] text-gray-400">Receita no período</p>
                <p className="text-lg font-bold text-gray-800 tabular-nums">{fmtMi(rent.receita)}</p>
              </div>
              <div className="bg-gray-50 rounded-lg p-3">
                <p className="text-[11px] text-gray-400">Custo</p>
                <p className="text-lg font-bold text-gray-800 tabular-nums">{fmtMi(rent.custo)}</p>
              </div>
              <div className="bg-emerald-50 rounded-lg p-3">
                <p className="text-[11px] text-gray-400">Margem bruta</p>
                <p className="text-lg font-bold text-emerald-700 tabular-nums">{rent.margem_pct}%</p>
              </div>
              {rent.tendencia && (
                <div className={`rounded-lg p-3 ${rent.tendencia.delta_pp < 0 ? 'bg-red-50' : 'bg-emerald-50'}`}>
                  <p className="text-[11px] text-gray-400">Margem · 3 meses</p>
                  <p className={`text-lg font-bold tabular-nums ${rent.tendencia.delta_pp < 0 ? 'text-red-700' : 'text-emerald-700'}`}>
                    {rent.tendencia.margem_3m}%
                  </p>
                  <p className="text-[11px] text-gray-500">
                    {rent.tendencia.delta_pp > 0 ? '+' : ''}{rent.tendencia.delta_pp} p.p. vs 3m antes
                  </p>
                </div>
              )}
            </div>

            {/* Queda de margem em reais/mês: p.p. sozinho não comunica tamanho. */}
            {rent.tendencia && rent.tendencia.delta_pp < 0 && (
              <p className="mt-3 text-xs bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-red-800">
                A margem caiu <strong>{Math.abs(rent.tendencia.delta_pp)} pontos</strong> nos últimos 3 meses
                ({rent.tendencia.margem_3m_anterior}% → {rent.tendencia.margem_3m}%). No faturamento médio do
                período isso equivale a <strong>{fmtBRL(Math.abs(rent.tendencia.impacto_mes))} por mês</strong>.
              </p>
            )}

            {/* Série mensal: receita em barra, margem em número. */}
            <div className="mt-4">
              <p className="text-xs font-medium text-gray-500 mb-2">Receita e margem por mês</p>
              <div className="space-y-1">
                {rent.meses.map((m: any) => {
                  const maxRec = Math.max(...rent.meses.map((x: any) => x.receita))
                  return (
                    <div key={m.chave} className="flex items-center gap-2">
                      <span className="text-[11px] text-gray-400 font-mono w-16 shrink-0">{m.chave}</span>
                      <div className="flex-1 h-4 bg-gray-100 rounded overflow-hidden">
                        <div className="h-full bg-blue-500 rounded" style={{ width: `${(m.receita / maxRec) * 100}%` }} />
                      </div>
                      <span className="text-[11px] text-gray-500 tabular-nums w-20 text-right shrink-0">{fmtBRLcurto(m.receita)}</span>
                      <span className={`text-[11px] font-semibold tabular-nums w-12 text-right shrink-0 ${
                        (m.margem_pct ?? 0) < 62 ? 'text-red-600' : 'text-gray-600'
                      }`}>{m.margem_pct}%</span>
                    </div>
                  )
                })}
              </div>
            </div>
          </Card>

          <div className="grid lg:grid-cols-3 gap-4">
            <Card titulo="Margem por segmento" icone={Users}
              acao="segmento que a tabela de clientes nunca teve">
              <div className="space-y-2">
                {rent.por_tipo_cliente.map((t: any) => (
                  <div key={t.chave}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="text-gray-700">{TIPO_LABEL[t.chave] || t.chave}</span>
                      <span className={`font-semibold tabular-nums ${(t.margem_pct ?? 0) < 60 ? 'text-red-600' : 'text-emerald-700'}`}>
                        {t.margem_pct}%
                      </span>
                    </div>
                    <p className="text-[11px] text-gray-400 tabular-nums">{fmtBRL(t.receita)}</p>
                  </div>
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-3 pt-2 border-t border-gray-100">
                Vertical: {rent.por_vertical.map((v: any) => `${v.chave} ${v.margem_pct}%`).join(' · ')}
              </p>
            </Card>

            <Card titulo="Produtos que sangram margem" icone={TrendingDown}
              acao={`receita acima de ${fmtBRLcurto(rent.min_receita_ranking)}`}>
              <div className="space-y-1.5">
                {rent.produtos_piores.map((p: any) => (
                  <div key={p.chave}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="font-mono text-xs text-gray-700 truncate" title={p.descricao}>{p.chave}</span>
                      <span className="text-red-600 font-semibold tabular-nums text-xs shrink-0">{p.margem_pct}%</span>
                    </div>
                    <p className="text-[11px] text-gray-400 tabular-nums">{fmtBRLcurto(p.receita)}</p>
                  </div>
                ))}
              </div>
            </Card>

            <Card titulo="Clientes de baixa margem" icone={UserMinus}
              acao="faturam bem, entregam pouco resultado">
              <div className="space-y-1.5">
                {rent.clientes_piores.map((c: any) => (
                  <div key={c.chave}>
                    <div className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="text-gray-700 truncate" title={c.chave}>{c.chave}</span>
                      <span className="text-red-600 font-semibold tabular-nums text-xs shrink-0">{c.margem_pct}%</span>
                    </div>
                    <p className="text-[11px] text-gray-400 tabular-nums">{fmtBRLcurto(c.receita)}</p>
                  </div>
                ))}
              </div>
            </Card>
          </div>

          <Card titulo="Receita e margem por estado" icone={MapPin} acao="top 12 estados por receita">
            <div className="grid sm:grid-cols-2 gap-x-6 gap-y-1.5">
              {rent.por_uf.map((u: any) => {
                const maxRec = Math.max(...rent.por_uf.map((x: any) => x.receita))
                return (
                  <div key={u.chave} className="flex items-center gap-2">
                    <span className="text-xs font-semibold text-gray-600 w-7 shrink-0">{u.chave}</span>
                    <div className="flex-1 h-3 bg-gray-100 rounded overflow-hidden">
                      <div className="h-full bg-teal-500 rounded" style={{ width: `${(u.receita / maxRec) * 100}%` }} />
                    </div>
                    <span className="text-[11px] text-gray-500 tabular-nums w-20 text-right shrink-0">{fmtBRLcurto(u.receita)}</span>
                    <span className={`text-[11px] tabular-nums w-11 text-right shrink-0 ${
                      (u.margem_pct ?? 0) < 62 ? 'text-red-600 font-medium' : 'text-gray-500'
                    }`}>{u.margem_pct}%</span>
                  </div>
                )
              })}
            </div>
          </Card>
        </>
      ) : (
        <Card titulo="Rentabilidade" icone={Percent}>
          <Vazio motivo={rent.motivo} />
        </Card>
      )}

      {/* ── PREÇO: privado abaixo do que ganha licitação ──────────────────── */}
      <Card titulo="Preço praticado vs preço que ganha licitação" icone={DollarSign}
        acao="preço público é disputa vencida — vender abaixo dele no privado costuma ser margem entregue sem precisar">
        {!precos.disponivel ? <Vazio motivo={precos.motivo} /> : (
          <>
            {precos.abaixo_do_publico > 0 && (
              <p className="text-xs bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-red-800 mb-2">
                <strong>{precos.abaixo_do_publico} produto(s)</strong> vendidos na iniciativa privada mais
                barato do que o preço que já venceu licitação.
              </p>
            )}
            <div className="border border-gray-100 rounded-lg divide-y divide-gray-50">
              {precos.itens.map((i: any) => (
                <div key={i.codigo} className="flex items-baseline gap-3 px-3 py-2 text-sm">
                  <div className="min-w-0 flex-1">
                    <span className="font-mono text-xs text-gray-700">{i.codigo}</span>
                    <p className="text-[11px] text-gray-400 truncate" title={i.descricao}>{i.descricao}</p>
                  </div>
                  <span className="text-xs text-gray-500 tabular-nums whitespace-nowrap hidden sm:inline">
                    privado {fmtBRL(i.preco_privado)}
                  </span>
                  <span className="text-xs text-gray-500 tabular-nums whitespace-nowrap hidden sm:inline">
                    público {fmtBRL(i.preco_publico)}
                  </span>
                  <span className={`text-xs font-semibold tabular-nums w-16 text-right ${
                    i.diferenca_pct < -5 ? 'text-red-600' : i.diferenca_pct > 5 ? 'text-emerald-600' : 'text-gray-400'
                  }`}>
                    {i.diferenca_pct > 0 ? '+' : ''}{i.diferenca_pct}%
                  </span>
                </div>
              ))}
            </div>
            <p className="text-[11px] text-gray-400 mt-1.5">
              Média do preço unitário lançado nas OVs privadas contra a média em empenhos. Amostra pequena
              por produto — use como pista para revisar tabela, não como regra.
            </p>
          </>
        )}
      </Card>

      {/* ── MOVIMENTO DA CARTEIRA ─────────────────────────────────────────── */}
      <div className="grid lg:grid-cols-3 gap-4">
        <Card titulo="Pararam de comprar" icone={UserMinus}
          acao={`compraram nos ${janela}d anteriores e não agora`}>
          {(carteira.pararam || []).length === 0 ? (
            <Vazio motivo="Ninguém que comprava deixou de comprar nesta janela. 🎉" />
          ) : (
            <>
              <p className="text-xs text-red-700 bg-red-50 rounded-lg px-2.5 py-1.5 mb-2">
                {fmtBRL(carteira.pararam_total)} que entravam e não entraram
              </p>
              <div className="space-y-1.5 max-h-80 overflow-y-auto">
                {carteira.pararam.map((c: any) => (
                  <div key={c.cliente_id || c.cliente} className="group flex items-baseline justify-between gap-2 text-sm">
                    <span className="text-gray-700 truncate" title={c.cliente}>{c.cliente}</span>
                    <span className="flex items-center gap-1.5 shrink-0">
                      <span className="text-gray-600 tabular-nums text-xs">{fmtBRLcurto(c.valor_anterior)}</span>
                      {/* Transformar o insight em trabalho: cria a oportunidade já preenchida. */}
                      <button title="Criar oportunidade de recompra"
                        onClick={() => setPrefill({
                          titulo: `Recompra — ${c.cliente}`, cliente_id: c.cliente_id, cliente: c.cliente,
                          canal: c.canal, valor_estimado: c.valor_anterior,
                          estagio: 'QUALIFICACAO', origem: 'Cliente recorrente',
                        })}
                        className="text-blue-600 opacity-0 group-hover:opacity-100 transition-opacity">
                        <PlusCircle size={13} />
                      </button>
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>

        <Card titulo="Caindo forte" icone={TrendingDown} acao="queda de 30% ou mais no período">
          {(carteira.caindo || []).length === 0 ? (
            <Vazio motivo="Nenhum cliente com queda relevante." />
          ) : (
            <div className="space-y-1.5 max-h-80 overflow-y-auto">
              {carteira.caindo.map((c: any) => (
                <div key={c.cliente_id || c.cliente} className="text-sm">
                  <div className="flex items-baseline justify-between gap-2">
                    <span className="text-gray-700 truncate" title={c.cliente}>{c.cliente}</span>
                    <span className="text-red-600 tabular-nums text-xs font-medium shrink-0">{c.variacao_pct}%</span>
                  </div>
                  <p className="text-[11px] text-gray-400 tabular-nums">
                    {fmtBRLcurto(c.valor_anterior)} → {fmtBRLcurto(c.valor_atual)}
                  </p>
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card titulo="Clientes novos" icone={UserPlus} acao={`compraram agora e não nos ${janela}d anteriores`}>
          {(carteira.novos || []).length === 0 ? (
            <Vazio motivo="Nenhum cliente novo nesta janela." />
          ) : (
            <>
              <p className="text-xs text-emerald-700 bg-emerald-50 rounded-lg px-2.5 py-1.5 mb-2">
                {fmtBRL(carteira.novos_total)} de receita nova
              </p>
              <div className="space-y-1.5 max-h-80 overflow-y-auto">
                {carteira.novos.map((c: any) => (
                  <div key={c.cliente_id || c.cliente} className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="text-gray-700 truncate" title={c.cliente}>{c.cliente}</span>
                    <span className="text-gray-600 tabular-nums text-xs shrink-0">{fmtBRLcurto(c.valor)}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </Card>
      </div>

      {/* ── CURVA ABC ─────────────────────────────────────────────────────── */}
      <Card titulo="Curva ABC de clientes" icone={Trophy}
        acao="classe A = 80% do faturamento · são os que não se pode perder">
        {!abc.disponivel ? <Vazio motivo={abc.motivo} /> : (
          <>
            <div className="grid grid-cols-3 gap-3 mb-3">
              {abc.classes.map((c: any) => (
                <div key={c.classe} className="bg-gray-50 rounded-lg p-3">
                  <p className="text-xs font-bold text-gray-700">Classe {c.classe}</p>
                  <p className="text-sm text-gray-800 tabular-nums">{c.clientes} cliente(s)</p>
                  <p className="text-[11px] text-gray-400 tabular-nums">{c.pct}% · {fmtBRLcurto(c.valor)}</p>
                </div>
              ))}
            </div>
            {conc.risco === 'ALTO' && (
              <p className="text-xs bg-red-50 border border-red-200 rounded-lg px-3 py-2 text-red-800 mb-2">
                ⚠️ {conc.top1_cliente} é {conc.top1_pct}% do faturamento — a carteira depende dele.
              </p>
            )}
            <div className="border border-gray-100 rounded-lg divide-y divide-gray-50 max-h-72 overflow-y-auto">
              {abc.clientes.slice(0, 40).map((c: any) => (
                <div key={c.cliente_id || c.cliente} className="flex items-baseline gap-2 px-3 py-1.5 text-sm">
                  <span className={`text-[10px] font-bold w-3 ${
                    c.classe === 'A' ? 'text-emerald-600' : c.classe === 'B' ? 'text-blue-500' : 'text-gray-300'
                  }`}>{c.classe}</span>
                  <span className="text-gray-700 truncate flex-1" title={c.cliente}>{c.cliente}</span>
                  <span className="text-[11px] text-gray-400 tabular-nums">{c.pct}%</span>
                  <span className="text-gray-600 tabular-nums text-xs w-24 text-right">{fmtBRL(c.valor)}</span>
                </div>
              ))}
            </div>
          </>
        )}
      </Card>

      {/* ── PERDAS NO FUNIL ───────────────────────────────────────────────── */}
      <Card titulo="Por que perdemos" icone={AlertTriangle}
        acao="alimentado pelo motivo registrado ao marcar uma oportunidade como perdida">
        {!perdas.disponivel ? <Vazio motivo={perdas.motivo} /> : (
          <div className="grid md:grid-cols-2 gap-4">
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1.5">Motivo ({perdas.total} perda(s))</p>
              <div className="space-y-1.5">
                {perdas.por_motivo.map((m: any) => (
                  <div key={m.codigo} className="flex items-baseline justify-between gap-2 text-sm">
                    <span className="text-gray-700 truncate">{m.label}</span>
                    <span className="text-gray-500 text-xs tabular-nums shrink-0">
                      {m.qtd}× · {fmtBRLcurto(m.valor)}
                    </span>
                  </div>
                ))}
              </div>
            </div>
            <div>
              <p className="text-xs font-medium text-gray-500 mb-1.5">Para quem perdemos</p>
              {perdas.concorrentes.length === 0 ? (
                <p className="text-xs text-gray-400">Concorrente não informado nas perdas registradas.</p>
              ) : (
                <div className="space-y-1.5">
                  {perdas.concorrentes.map((c: any) => (
                    <div key={c.nome} className="flex items-baseline justify-between gap-2 text-sm">
                      <span className="text-gray-700 truncate">{c.nome}</span>
                      <span className="text-gray-500 text-xs tabular-nums shrink-0">
                        {c.qtd}×{c.gap_medio_pct != null ? ` · ${c.gap_medio_pct}% abaixo` : ''}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Card>

      {/* ── CANAIS ────────────────────────────────────────────────────────── */}
      <Card titulo="Por linha de negócio" icone={Sparkles} acao={`as duas janelas de ${janela}d somadas`}>
        <div className="space-y-2">
          {canais.map((c: any) => (
            <div key={c.canal}>
              <div className="flex items-baseline justify-between gap-2 text-sm mb-1">
                <span className={c.canal === 'SEM_CANAL' ? 'text-amber-700' : 'text-gray-700'}>
                  {c.canal === 'SEM_CANAL' ? '⚠️ Sem canal' : (CANAL_LABEL[c.canal] || c.canal)}
                </span>
                <span className="text-[11px] text-gray-400 tabular-nums ml-auto">{c.nfs} NF</span>
                <span className="text-gray-700 font-medium tabular-nums text-sm w-28 text-right">{fmtBRL(c.valor)}</span>
              </div>
              <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                <div className={`h-full rounded-full ${c.canal === 'SEM_CANAL' ? 'bg-amber-400' : 'bg-blue-500'}`}
                  style={{ width: `${totalCanais > 0 ? (c.valor / totalCanais) * 100 : 0}%` }} />
              </div>
              {c.licitacao > 0 && (
                <p className="text-[11px] text-gray-400 mt-0.5">dos quais {fmtBRL(c.licitacao)} via licitação</p>
              )}
            </div>
          ))}
        </div>
      </Card>

      {prefill && <ModalOportunidadeForm prefill={prefill} onClose={() => setPrefill(null)} onSaved={() => setPrefill(null)} />}
    </div>
  )
}

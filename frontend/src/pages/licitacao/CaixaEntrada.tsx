/**
 * Caixa de entrada da licitação — a triagem que saiu do Excel.
 *
 * Três telas, três perguntas diferentes:
 *
 *   Acompanhamento  "o setor está dando conta?"  — é o que o conselho olha
 *   Caixa de entrada "o que eu faço agora?"      — é o que a operação usa
 *   Órgãos           "de quem é este pedido?"    — o de-para que destrava tudo
 *
 * O motor lê o Outlook duas vezes por dia, extrai do anexo do pedido o produto,
 * a quantidade e o valor, e grava aqui. Nada nesta tela sobrescreve o que o
 * motor traz, e o motor não sobrescreve o que se decide aqui.
 */
import { useState, useMemo } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, Check, CircleDot, Clock, Inbox, Link2, Loader2, Mail,
  MinusCircle, Paperclip, Package, Search, ShieldQuestion, X, CalendarClock, Hand,
  ExternalLink,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import { msgErro } from '../../lib/crm'
import { ClienteAutocomplete } from '../NovoPedido'

const fmtBRL = (v: number) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const fmtDia = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) : '—'

/**
 * As faixas de atraso são uma escala de severidade ORDENADA, não séries
 * independentes — por isso as cores vão de verde a vermelho escuro e nunca
 * saem dessa ordem.
 *
 * As cores foram validadas, não escolhidas a olho. A primeira tentativa usava
 * amarelo e laranja em faixas vizinhas e reprovou: ΔE 13,6 em visão normal,
 * abaixo do piso de 15 — ou seja, indistinguíveis até para quem vê todas as
 * cores. Esta escala passa em separação para daltonismo (ΔE 11,3) e em visão
 * normal (18,7). O amarelo fica abaixo de 3:1 de contraste com o fundo, e a
 * compensação obrigatória é o RÓTULO: nenhuma faixa aqui é identificada só
 * pela cor.
 */
const FAIXAS = [
  { chave: 'ate_2', label: 'Até 2 dias', cor: '#0ca30c' },
  { chave: 'de_3_a_7', label: '3 a 7 dias', cor: '#fab219' },
  { chave: 'de_8_a_15', label: '8 a 15 dias', cor: '#d03b3b' },
  { chave: 'mais_de_15', label: 'Mais de 15 dias', cor: '#7f1d1d' },
] as const

const PRIORIDADE = [
  null,
  { label: 'Crítica', cor: 'bg-red-100 text-red-800 border-red-200' },
  { label: 'Alta', cor: 'bg-orange-100 text-orange-800 border-orange-200' },
  { label: 'Média', cor: 'bg-sky-100 text-sky-800 border-sky-200' },
  { label: 'Baixa', cor: 'bg-gray-100 text-gray-700 border-gray-200' },
  { label: 'Info', cor: 'bg-gray-50 text-gray-500 border-gray-200' },
]

const TIPO_LABEL: Record<string, string> = {
  VENDA_DIRETA: 'Venda direta',
  CONSIGNACAO: 'Consignação',
  COMUNICADO_USO: 'Comunicado de uso',
  AMOSTRA: 'Amostra',
  OUTRO: 'A classificar',
}

const TIPO_PONTO: Record<string, string> = {
  VENDA_DIRETA: 'bg-blue-500',
  CONSIGNACAO: 'bg-amber-500',
  COMUNICADO_USO: 'bg-emerald-500',
  AMOSTRA: 'bg-violet-500',
  OUTRO: 'bg-gray-400',
}

// Nome curto da etapa da demanda. O enum do banco em caixa alta no meio de um
// card fica ilegivel, e "AGUARDANDO_ESTOQUE" nao cabe.
const ETAPA_CURTA: Record<string, string> = {
  RECEBIDO: 'recebida',
  PROCESSANDO: 'em processamento',
  AGUARDANDO_ESTOQUE: 'aguardando estoque',
  COTACAO_FRETE: 'cotando frete',
  OV_GERADA: 'OV gerada',
  NF_ENVIADA: 'NF enviada',
  CONCLUIDO: 'concluída',
}

const SITUACAO = {
  NAO: { label: 'Em aberto', cor: 'bg-white border-gray-200', ponto: 'text-gray-400' },
  PARCIAL: { label: 'Parcial', cor: 'bg-amber-50 border-amber-200', ponto: 'text-amber-500' },
  SIM: { label: 'Resolvido', cor: 'bg-emerald-50 border-emerald-200', ponto: 'text-emerald-600' },
} as const

type Card = {
  chave: string
  empenho: string | null
  documento: string | null
  em_tratativa: boolean
  tratativa_por: string | null
  tratativa_nome: string | null
  assunto: string
  recebido_em: string
  ultimo_em: string
  dias_parados: number
  prioridade: number
  motivo: string | null
  tipo: string | null
  contrato: string | null
  contrato_titulo: string | null
  contrato_desconhecido: boolean
  pregao: string | null
  cliente_id: string | null
  cliente_nome: string | null
  orgao_texto: string | null
  cnpj_orgao: string | null
  demanda_id: string | null
  entrega_prevista: string | null
  demanda: { etapa: string; ovs: any[] | null; numero_nf: string | null
             gerado_ref: string | null; tipo_operacao: string } | null
  situacao: 'NAO' | 'PARCIAL' | 'SIM'
  itens: any[]
  valor_total: number
  notas: { id: string; texto: string; autor: string | null; quando: string | null }[]
  sugestoes: string[]
  anexos_com_problema: any[]
  anexos: any[]
  emails: any[]
}


// ── De onde vem o número ─────────────────────────────────────────────────────

/**
 * O painel inteiro é clicável, e cada número abre isto: a conta que o produziu,
 * a origem do dado e a lista de casos que entraram nele.
 *
 * Existe por uma lição cara. Quando o faturamento do app não batia com o D365,
 * semanas se foram discutindo QUAL número estava certo, porque nenhum dos dois
 * dizia de onde vinha. Um painel que o conselho acompanha não pode ter esse
 * defeito: se alguém perguntar "de onde saiu esse valor?", a resposta tem que
 * ser um clique, não uma investigação.
 */
function DetalheNumero({ metrica, dias, onFechar }: {
  metrica: string; dias: number; onFechar: () => void
}) {
  const { data, isLoading } = useQuery({
    queryKey: ['licitacao-detalhe', metrica, dias],
    queryFn: () => api.get(`/licitacoes/entrada/detalhe?metrica=${encodeURIComponent(metrica)}&dias=${dias}`)
      .then(r => r.data),
  })

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4 sm:p-8"
      onClick={onFechar}>
      <div className="w-full max-w-3xl rounded-xl bg-white shadow-xl" onClick={e => e.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-gray-100 p-4">
          <div>
            <h3 className="text-base font-semibold text-gray-900">
              {isLoading ? 'Carregando…' : data?.titulo}
            </h3>
            {data && (
              <p className="mt-0.5 text-sm text-gray-500">
                {data.quantidade} caso{data.quantidade === 1 ? '' : 's'}
                {data.valor > 0 && <> · {fmtBRL(data.valor)}</>}
                {' · '}últimos {data.periodo_dias} dias
              </p>
            )}
          </div>
          <button onClick={onFechar} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        {isLoading ? (
          <div className="py-16 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-gray-400" /></div>
        ) : !data ? null : (
          <>
            <div className="space-y-2 border-b border-gray-100 bg-gray-50 p-4 text-xs leading-relaxed text-gray-700">
              <p><b className="text-gray-900">Como este número é calculado.</b> {data.conta}</p>
              <p><b className="text-gray-900">De onde vem o dado.</b> {data.origem}</p>
            </div>
            <div className="max-h-[55vh] divide-y divide-gray-100 overflow-y-auto">
              {data.casos.length === 0 && (
                <p className="p-6 text-center text-sm text-gray-500">Nenhum caso compõe este número.</p>
              )}
              {data.casos.map((c: Card) => (
                <div key={c.chave} className="p-3 hover:bg-gray-50">
                  <div className="flex flex-wrap items-center gap-1.5">
                    {c.empenho ? (
                      <span className="rounded bg-gray-900 px-1.5 py-0.5 font-mono text-[11px] text-white">
                        {c.empenho}
                      </span>
                    ) : c.documento ? (
                      <span className="rounded bg-gray-200 px-1.5 py-0.5 font-mono text-[11px] text-gray-700">
                        doc {c.documento}
                      </span>
                    ) : null}
                    <span className="text-[11px] text-gray-500">{TIPO_LABEL[c.tipo || 'OUTRO']}</span>
            {c.em_tratativa && (
              <span className="flex items-center gap-1 rounded border border-violet-200 bg-violet-100 px-1.5 py-0.5 text-[11px] font-semibold text-violet-800">
                <Hand className="h-3 w-3" />
                {c.tratativa_nome ? `em tratativa · ${c.tratativa_nome.split(' ')[0]}` : 'em tratativa'}
              </span>
            )}
                    <span className={`text-[11px] ${c.dias_parados > 15 ? 'font-semibold text-red-700' : 'text-gray-500'}`}>
                      {c.dias_parados} d
                    </span>
                    {c.valor_total > 0 && (
                      <span className="text-[11px] font-medium text-gray-900">{fmtBRL(c.valor_total)}</span>
                    )}
                  </div>
                  <div className="mt-0.5 truncate text-sm text-gray-900">{c.assunto}</div>
                  <div className="text-xs text-gray-500">
                    {c.cliente_nome || c.orgao_texto || 'sem cliente definido'}
                    {c.itens.length > 0 && <> · {c.itens.length} item(ns) do anexo</>}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}

/** Envolve qualquer número do painel e o torna clicável. */
function Abrivel({ metrica, onAbrir, children }: {
  metrica: string; onAbrir: (m: string) => void; children: any
}) {
  return (
    <button onClick={() => onAbrir(metrica)}
      className="w-full rounded-xl text-left transition hover:ring-2 hover:ring-blue-300 focus:outline-none focus:ring-2 focus:ring-blue-500"
      title="ver de onde vem este número">
      {children}
    </button>
  )
}

// ── Acompanhamento (a tela do conselho) ──────────────────────────────────────

/** Número grande com rótulo. Um número não precisa de gráfico. */
function Tile({ titulo, valor, sub, alerta }: {
  titulo: string; valor: string; sub?: string; alerta?: boolean
}) {
  return (
    <div className={`rounded-xl border p-4 ${alerta ? 'border-red-200 bg-red-50' : 'border-gray-200 bg-white'}`}>
      <div className="text-xs font-medium uppercase tracking-wide text-gray-500">{titulo}</div>
      <div className={`mt-1 text-3xl font-semibold tabular-nums ${alerta ? 'text-red-700' : 'text-gray-900'}`}>
        {valor}
      </div>
      {sub && <div className="mt-1 text-xs text-gray-500">{sub}</div>}
    </div>
  )
}

export function AbaAcompanhamento() {
  const [dias, setDias] = useState(30)
  // Qual número o usuário abriu. null = nenhum.
  const [aberto, setAberto] = useState<string | null>(null)
  const { data, isLoading } = useQuery({
    queryKey: ['licitacao-painel', dias],
    queryFn: () => api.get(`/licitacoes/entrada/painel?dias=${dias}`).then(r => r.data),
  })

  if (isLoading) return <div className="py-16 text-center text-gray-400">
    <Loader2 className="mx-auto h-6 w-6 animate-spin" />
  </div>
  if (!data) return null

  const faixas = data.parados_por_faixa || {}
  const totalFaixas = FAIXAS.reduce((s, f) => s + (faixas[f.chave] || 0), 0)
  const maxDia = Math.max(1, ...(data.entrada_por_dia || []).map((d: any) => d.emails))
  const etapas = Object.entries(data.demandas_por_etapa || {}) as [string, number][]
  const maxEtapa = Math.max(1, ...etapas.map(([, n]) => n))
  const cob = data.cobertura || {}

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold text-gray-900">Acompanhamento da licitação</h2>
          <p className="text-sm text-gray-500">
            Tudo que chegou por e-mail da licitação nos últimos {dias} dias, e em que pé está.
          </p>
        </div>
        {/* Filtro em uma linha, acima dos gráficos. */}
        <div className="flex rounded-lg border border-gray-200 bg-white p-0.5">
          {[7, 30, 90].map(d => (
            <button key={d} onClick={() => setDias(d)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                dias === d ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
              {d} dias
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Abrivel metrica="abertos" onAbrir={setAberto}>
          <Tile titulo="Em aberto" valor={String(data.abertos)}
            sub={`de ${data.casos} casos no período`} />
        </Abrivel>
        <Abrivel metrica="criticos" onAbrir={setAberto}>
          <Tile titulo="Críticos" valor={String(data.criticos)}
            sub="prioridade máxima, em aberto" alerta={data.criticos > 0} />
        </Abrivel>
        <Abrivel metrica="mais_antigo" onAbrir={setAberto}>
          <Tile titulo="Espera mais longa" valor={`${data.mais_antigo_dias} d`}
            sub="o caso aberto mais antigo" alerta={data.mais_antigo_dias > 15} />
        </Abrivel>
        <Abrivel metrica="valor_parado" onAbrir={setAberto}>
          <Tile titulo="Valor em aberto" valor={fmtBRL(data.valor_parado)}
            sub={`piso — lido em ${cob.casos_com_valor} de ${cob.casos_abertos} casos`} />
        </Abrivel>
      </div>

      {/* Demanda por tipo de solicitação. Venda direta, consignação e comunicado
          de uso são operações diferentes, com esforço diferente: 50 comunicados
          e 5 vendas diretas não é o mesmo mês que o inverso, ainda que o total
          de casos seja parecido. */}
      <div>
        <h3 className="text-sm font-semibold text-gray-900">Em aberto por tipo de solicitação</h3>
        <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
          {(data.por_tipo || []).map((t: any) => (
            <Abrivel key={t.tipo} metrica={`tipo:${t.tipo}`} onAbrir={setAberto}>
              <div className="h-full rounded-xl border border-gray-200 bg-white p-3">
                <div className="flex items-center gap-1.5">
                  <span className={`h-2 w-2 rounded-full ${TIPO_PONTO[t.tipo] || 'bg-gray-300'}`} />
                  <span className="truncate text-xs font-medium text-gray-700">
                    {TIPO_LABEL[t.tipo] || t.tipo}
                  </span>
                </div>
                <div className="mt-1 text-2xl font-semibold tabular-nums text-gray-900">{t.casos}</div>
                <div className="mt-0.5 text-[11px] text-gray-500">
                  {t.valor > 0 ? fmtBRL(t.valor) : 'sem valor lido'}
                </div>
                <div className="mt-1 flex flex-wrap gap-x-2 text-[11px]">
                  {t.criticos > 0 && <span className="font-medium text-red-700">{t.criticos} crítico(s)</span>}
                  {t.mais_antigo > 0 && (
                    <span className={t.mais_antigo > 15 ? 'font-medium text-red-700' : 'text-gray-500'}>
                      espera {t.mais_antigo} d
                    </span>
                  )}
                </div>
              </div>
            </Abrivel>
          ))}
        </div>
      </div>

      {/* Composição por tempo de espera. É a resposta a "está dando conta?":
          uma barra que pende para a direita significa fila envelhecendo. */}
      <div className="rounded-xl border border-gray-200 bg-white p-4">
        <div className="flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-gray-900">Há quanto tempo os casos abertos esperam</h3>
          <span className="text-xs text-gray-500">{totalFaixas} casos</span>
        </div>
        {totalFaixas === 0 ? (
          <p className="mt-4 text-sm text-gray-500">Nada em aberto no período.</p>
        ) : (
          <>
            {/* gap-[2px]: o espaçador entre segmentos vizinhos, para as faixas
                não se fundirem numa mancha só. */}
            <div className="mt-4 flex h-9 gap-[2px] overflow-hidden rounded">
              {FAIXAS.map(f => {
                const n = faixas[f.chave] || 0
                if (!n) return null
                const pct = (n / totalFaixas) * 100
                return (
                  <button key={f.chave} style={{ width: `${pct}%`, background: f.cor }}
                    onClick={() => setAberto(`faixa:${f.chave}`)}
                    title={`${f.label}: ${n} caso(s) — clique para ver de onde vem`}
                    className="flex items-center justify-center transition first:rounded-l last:rounded-r hover:brightness-110">
                    {pct > 8 && (
                      <span className={`text-xs font-semibold tabular-nums ${
                        f.chave === 'de_3_a_7' ? 'text-amber-950' : 'text-white'}`}>{n}</span>
                    )}
                  </button>
                )
              })}
            </div>
            {/* A legenda existe sempre: a cor nunca identifica a faixa sozinha
                — o amarelo tem contraste baixo com o fundo branco. */}
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5">
              {FAIXAS.map(f => (
                <span key={f.chave} className="flex items-center gap-1.5 text-xs text-gray-600">
                  <span className="h-2.5 w-2.5 rounded-sm" style={{ background: f.cor }} />
                  {f.label}
                  <b className="tabular-nums text-gray-900">{faixas[f.chave] || 0}</b>
                </span>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        {/* Volume que chega na mesa do time. Série única: o título já a nomeia,
            então não há legenda. */}
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-gray-900">E-mails recebidos por dia</h3>
          <p className="mt-0.5 text-xs text-gray-500">{data.emails_recebidos} no período</p>
          <div className="mt-4 flex h-28 items-end gap-[2px]">
            {(data.entrada_por_dia || []).map((d: any) => (
              <div key={d.dia} className="group relative flex-1" title={`${fmtDia(d.dia)}: ${d.emails} e-mail(s)`}>
                <div className="w-full rounded-t bg-blue-500 transition group-hover:bg-blue-600"
                  style={{ height: `${Math.max(3, (d.emails / maxDia) * 100)}%` }} />
              </div>
            ))}
          </div>
          <div className="mt-1.5 flex justify-between text-[11px] text-gray-400">
            <span>{fmtDia(data.entrada_por_dia?.[0]?.dia)}</span>
            <span>{fmtDia(data.entrada_por_dia?.[data.entrada_por_dia.length - 1]?.dia)}</span>
          </div>
        </div>

        {/* Onde as demandas estão paradas — mostra o gargalo da operação. */}
        <div className="rounded-xl border border-gray-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-gray-900">Demandas por etapa</h3>
          <p className="mt-0.5 text-xs text-gray-500">o que já virou trabalho no painel</p>
          <div className="mt-3 space-y-1.5">
            {etapas.length === 0 && <p className="text-sm text-gray-500">Nenhuma demanda ativa.</p>}
            {etapas.map(([etapa, n]) => (
              <div key={etapa} className="flex items-center gap-2">
                <span className="w-40 shrink-0 truncate text-xs text-gray-600">
                  {etapa.replace(/_/g, ' ').toLowerCase()}
                </span>
                <div className="h-4 flex-1 rounded-sm bg-gray-100">
                  <div className="h-4 rounded-sm bg-blue-500" style={{ width: `${(n / maxEtapa) * 100}%` }} />
                </div>
                <span className="w-8 text-right text-xs font-semibold tabular-nums text-gray-900">{n}</span>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Identidade + duas medidas = tabela. Um gráfico aqui só atrapalharia. */}
      <div className="rounded-xl border border-gray-200 bg-white">
        <div className="border-b border-gray-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-gray-900">Onde está a espera, por órgão</h3>
        </div>
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
              <th className="px-4 py-2 font-medium">Órgão</th>
              <th className="px-4 py-2 text-right font-medium">Casos</th>
              <th className="px-4 py-2 text-right font-medium">Valor em aberto</th>
              <th className="px-4 py-2 text-right font-medium">Espera mais longa</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {(data.por_cliente || []).map((c: any) => (
              <tr key={c.cliente} onClick={() => setAberto(`cliente:${c.cliente}`)}
                className="cursor-pointer hover:bg-gray-50" title="ver de onde vem este número">
                <td className="px-4 py-2.5 text-gray-900">{c.cliente}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-gray-700">{c.casos}</td>
                <td className="px-4 py-2.5 text-right tabular-nums text-gray-700">
                  {c.valor > 0 ? fmtBRL(c.valor) : '—'}
                </td>
                <td className={`px-4 py-2.5 text-right tabular-nums ${
                  c.mais_antigo > 15 ? 'font-semibold text-red-700' : 'text-gray-700'}`}>
                  {c.mais_antigo} d
                </td>
              </tr>
            ))}
            {(data.por_cliente || []).length === 0 && (
              <tr><td colSpan={4} className="px-4 py-6 text-center text-gray-500">Nada em aberto.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* O rodapé honesto. Sem ele, alguém trata o piso como se fosse o total. */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-xs leading-relaxed text-gray-600">
        <b className="text-gray-800">Sobre o valor em aberto.</b>{' '}
        Sai dos itens extraídos do anexo do pedido — nunca da nota fiscal. É um{' '}
        <b>piso, não o total</b>: {cob.casos_sem_valor_lido} dos {cob.casos_abertos} casos
        abertos não têm valor lido, quase sempre porque o órgão mandou o pedido escaneado
        (foto, sem texto) e nenhum extrator lê isso.
        {data.sem_cliente > 0 && (
          <> {' '}<b className="text-gray-800">{data.sem_cliente} casos ainda sem cliente definido</b> —
          eles não podem virar demanda até alguém preencher o de-para na aba Órgãos.</>
        )}
      </div>

      {aberto && <DetalheNumero metrica={aberto} dias={dias} onFechar={() => setAberto(null)} />}
    </div>
  )
}

// ── Caixa de entrada (a tela da operação) ────────────────────────────────────

function ItensDoPedido({ itens }: { itens: any[] }) {
  if (!itens.length) return null
  return (
    <div className="mt-2 space-y-1">
      {itens.map((i, n) => (
        <div key={n} className="flex items-start gap-2 rounded bg-gray-50 px-2 py-1.5 text-xs">
          <Package className="mt-0.5 h-3.5 w-3.5 shrink-0 text-gray-400" />
          <div className="min-w-0 flex-1">
            <span className="font-medium tabular-nums text-gray-900">
              {i.qtd} un{i.valor_unitario ? ` × ${fmtBRL(i.valor_unitario)}` : ''}
            </span>
            {i.codigo_msb && (
              <span className="ml-1.5 rounded bg-blue-50 px-1.5 py-0.5 font-mono text-[11px] text-blue-700">
                {i.codigo_msb}
              </span>
            )}
            <div className="truncate text-gray-600">{i.descricao || '(descrição não identificada)'}</div>
            {i.conta_nao_fecha && (
              <div className="mt-0.5 flex items-center gap-1 text-[11px] font-medium text-amber-700">
                <AlertTriangle className="h-3 w-3" /> a conta não fecha no documento — confira o anexo
              </div>
            )}
          </div>
          {i.valor_total ? (
            <span className="shrink-0 tabular-nums font-medium text-gray-900">{fmtBRL(i.valor_total)}</span>
          ) : null}
        </div>
      ))}
    </div>
  )
}

// ── A solicitação inteira ────────────────────────────────────────────────────

function Linha({ rotulo, children }: { rotulo: string; children: any }) {
  if (children === null || children === undefined || children === '') return null
  return (
    <div className="flex gap-2 py-1 text-sm">
      <span className="w-40 shrink-0 text-gray-500">{rotulo}</span>
      <span className="min-w-0 flex-1 text-gray-900">{children}</span>
    </div>
  )
}

function Secao({ titulo, children }: { titulo: string; children: any }) {
  return (
    <div className="border-t border-gray-100 px-5 py-3">
      <h4 className="mb-1 text-xs font-semibold uppercase tracking-wide text-gray-500">{titulo}</h4>
      {children}
    </div>
  )
}

/**
 * Tudo o que se sabe sobre uma solicitação, num lugar só.
 *
 * O card mostra o que decide a próxima ação; isto mostra o resto — o texto
 * completo de cada e-mail, os anexos com o que saiu (ou não saiu) de cada um,
 * a demanda ligada e o que o time anotou. Sem esta tela, responder "por que
 * este caso está aberto há 30 dias?" exigia abrir o Outlook.
 */
function DetalheSolicitacao({ c, onFechar, onTriar, onNota, onTratativa, onApagarNota, onPromover, salvando }: {
  c: Card
  onFechar: () => void
  onTriar: (situacao: string) => void
  onNota: (texto: string) => void
  onTratativa: (v: boolean) => void
  onApagarNota: (id: string) => void
  onPromover: () => void
  salvando: boolean
}) {
  const [nota, setNota] = useState('')
  const prio = PRIORIDADE[c.prioridade] || PRIORIDADE[5]!
  const hoje = new Date().toISOString().slice(0, 10)

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-3 sm:p-8"
      onClick={onFechar}>
      <div className="w-full max-w-3xl rounded-xl bg-white shadow-xl" onClick={e => e.stopPropagation()}>
        {/* Cabeçalho: identidade e estado. */}
        <div className="flex items-start justify-between gap-4 p-5 pb-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className={`rounded border px-1.5 py-0.5 text-[11px] font-semibold ${prio.cor}`}>
                {prio.label}
              </span>
              {c.empenho ? (
                <span className="rounded bg-gray-900 px-2 py-0.5 font-mono text-[11px] text-white">{c.empenho}</span>
              ) : c.documento ? (
                <span className="rounded bg-gray-200 px-2 py-0.5 font-mono text-[11px] text-gray-700">doc {c.documento}</span>
              ) : null}
              <span className="text-xs text-gray-500">{TIPO_LABEL[c.tipo || 'OUTRO']}</span>
              <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${
                c.situacao === 'SIM' ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                  : c.situacao === 'PARCIAL' ? 'border-amber-200 bg-amber-50 text-amber-700'
                  : 'border-gray-200 bg-gray-50 text-gray-600'}`}>
                {SITUACAO[c.situacao].label}
              </span>
              {c.em_tratativa && (
                <span className="flex items-center gap-1 rounded border border-violet-200 bg-violet-100 px-1.5 py-0.5 text-[11px] font-semibold text-violet-800">
                  <Hand className="h-3 w-3" />
                  {c.tratativa_nome ? `em tratativa · ${c.tratativa_nome}` : 'em tratativa'}
                </span>
              )}
            </div>
            <h3 className="mt-2 text-base font-semibold leading-snug text-gray-900">{c.assunto}</h3>
          </div>
          <button onClick={onFechar} className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <Secao titulo="Quem pediu">
          <Linha rotulo="Cliente">{c.cliente_nome}</Linha>
          {!c.cliente_nome && (
            <Linha rotulo="Órgão no documento">
              <span className="text-amber-700">
                {c.orgao_texto || '(o documento não trouxe o nome)'} — sem cliente definido
              </span>
            </Linha>
          )}
          <Linha rotulo="CNPJ do órgão">
            {c.cnpj_orgao ? <span className="font-mono text-xs">{c.cnpj_orgao}</span> : null}
          </Linha>
          <Linha rotulo="Contrato MSB">
            {c.contrato ? (
              <>
                <span className="font-mono text-xs">{c.contrato}</span>
                {c.contrato_titulo && <span className="ml-2 text-gray-600">{c.contrato_titulo}</span>}
                {c.contrato_desconhecido && (
                  <span className="ml-2 text-xs font-medium text-amber-700">
                    não existe no export do D365 — confira o número
                  </span>
                )}
              </>
            ) : null}
          </Linha>
          <Linha rotulo="Pregão">{c.pregao}</Linha>
        </Secao>

        <Secao titulo="Prazos">
          <Linha rotulo="Primeiro e-mail">{fmtDia(c.recebido_em)}</Linha>
          {c.emails.length > 1 && <Linha rotulo="Último e-mail">{fmtDia(c.ultimo_em)}</Linha>}
          <Linha rotulo="Esperando">
            <span className={c.dias_parados > 15 ? 'font-semibold text-red-700' : ''}>
              {c.dias_parados === 0 ? 'chegou hoje' : `${c.dias_parados} dias`}
            </span>
          </Linha>
          {c.entrega_prevista && (
            <Linha rotulo="Entrega exigida">
              <span className={c.entrega_prevista < hoje ? 'font-semibold text-red-700' : ''}>
                {new Date(c.entrega_prevista + 'T12:00:00').toLocaleDateString('pt-BR')}
                {c.entrega_prevista < hoje && ' — venceu'}
              </span>
            </Linha>
          )}
          <Linha rotulo="Por que a prioridade">{c.motivo}</Linha>
        </Secao>

        <Secao titulo={`O que estão pedindo${c.valor_total > 0 ? ` · ${fmtBRL(c.valor_total)}` : ''}`}>
          {c.itens.length === 0 ? (
            <p className="text-sm text-gray-500">
              Nenhum item foi extraído dos anexos.
              {c.anexos_com_problema.length > 0 && ' O anexo veio escaneado — abra o e-mail original.'}
            </p>
          ) : (
            <div className="space-y-1.5">
              {c.itens.map((i, n) => (
                <div key={n} className="rounded-lg bg-gray-50 p-2 text-sm">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium tabular-nums text-gray-900">
                      {i.qtd} un{i.valor_unitario ? ` × ${fmtBRL(i.valor_unitario)}` : ''}
                    </span>
                    {i.valor_total ? <span className="tabular-nums text-gray-700">= {fmtBRL(i.valor_total)}</span> : null}
                    {i.codigo_msb && (
                      <span className="rounded bg-blue-50 px-1.5 py-0.5 font-mono text-[11px] text-blue-700">
                        {i.codigo_msb}
                      </span>
                    )}
                    {i.via_ocr && (
                      <span className="rounded bg-gray-200 px-1.5 py-0.5 text-[11px] text-gray-700"
                        title="o anexo era imagem; estes números foram lidos por OCR">
                        lido por OCR
                      </span>
                    )}
                  </div>
                  <p className="mt-0.5 text-xs leading-relaxed text-gray-600">
                    {i.descricao || '(descrição não identificada no documento)'}
                  </p>
                  {i.conta_nao_fecha && (
                    <p className="mt-1 flex items-center gap-1 text-xs font-medium text-amber-700">
                      <AlertTriangle className="h-3 w-3" /> a conta não fecha no documento — confira o anexo
                    </p>
                  )}
                  {i.fonte && <p className="text-[11px] text-gray-400">de {i.fonte}</p>}
                </div>
              ))}
            </div>
          )}
        </Secao>

        {c.anexos.length > 0 && (
          <Secao titulo={`Anexos lidos (${c.anexos.length})`}>
            <div className="space-y-1">
              {c.anexos.map((a: any, n: number) => (
                <div key={n} className="flex items-start gap-2 text-xs">
                  <Paperclip className="mt-0.5 h-3 w-3 shrink-0 text-gray-400" />
                  <span className="min-w-0 flex-1 break-all text-gray-800">{a.arquivo}</span>
                  <span className="shrink-0 text-gray-500">
                    {a.escaneado ? 'imagem (OCR)' : a.erro ? 'não lido' : `${a.itens || 0} item(ns)`}
                  </span>
                </div>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-gray-400">
              Nota fiscal não é lida aqui — só o documento do pedido.
            </p>
          </Secao>
        )}

        {c.demanda && (
          <Secao titulo="Já virou trabalho">
            <Linha rotulo="Etapa">{ETAPA_CURTA[c.demanda.etapa] || c.demanda.etapa}</Linha>
            <Linha rotulo="OV">
              {c.demanda.ovs?.length
                ? <span className="font-mono">{c.demanda.ovs.map((o: any) => o.numero).filter(Boolean).join(' · ')}</span>
                : null}
            </Linha>
            <Linha rotulo="Nota fiscal">{c.demanda.numero_nf}</Linha>
            <a href={`/licitacoes?demanda=${c.demanda_id}`}
              className="mt-1 inline-flex items-center gap-1 text-sm font-medium text-blue-600 hover:underline">
              <Link2 className="h-3.5 w-3.5" /> abrir a demanda no painel
            </a>
          </Secao>
        )}

        {(c.notas.length > 0 || c.sugestoes.length > 0) && (
          <Secao titulo={`Anotações${c.notas.length > 1 ? ` (${c.notas.length})` : ''}`}>
            {c.sugestoes.map((s, n) => (
              <p key={`s${n}`} className="mb-1 rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-xs text-sky-900">
                {s}
              </p>
            ))}
            {/* Histórico, da mais nova para a mais antiga. Nota nova não apaga a
                anterior — antes apagava, e num caso que passa por mais de uma
                pessoa era o histórico que explicava por que ele estava parado. */}
            {c.notas.map((n, i) => (
              <div key={n.id} className="group mb-1 flex items-start gap-2 rounded-lg bg-gray-50 px-2.5 py-1.5">
                <div className="min-w-0 flex-1">
                <p className="text-sm italic text-gray-700">“{n.texto}”</p>
                {(n.autor || n.quando) && (
                  <p className="mt-0.5 text-[11px] text-gray-400">
                    {n.autor || 'autor não registrado'}
                    {n.quando && ` · ${new Date(n.quando).toLocaleString('pt-BR',
                      { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}`}
                  </p>
                )}
                </div>
                {/* Apagar existe porque anotacao repetida por engano viraria
                    permanente — e foi exatamente o que a falta de aviso na tela
                    causou. */}
                <button onClick={() => onApagarNota(n.id)} disabled={salvando}
                  className="opacity-0 transition group-hover:opacity-100 disabled:opacity-30"
                  title="apagar esta anotação">
                  <X className="h-3.5 w-3.5 text-gray-400 hover:text-red-600" />
                </button>
              </div>
            ))}
          </Secao>
        )}

        <Secao titulo={`Histórico — ${c.emails.length} e-mail${c.emails.length > 1 ? 's' : ''}`}>
          <div className="space-y-2">
            {c.emails.map(e => (
              <div key={e.id} className="rounded-lg border border-gray-100 p-2.5">
                <div className="flex flex-wrap items-center gap-2 text-xs text-gray-500">
                  <span className="font-medium tabular-nums text-gray-700">{fmtDia(e.recebido_em)}</span>
                  {e.pasta && <span className="rounded bg-gray-100 px-1.5 py-0.5">{e.pasta}</span>}
                  {(e.anexos || []).length > 0 && <span>{e.anexos.length} anexo(s)</span>}
                  {/* Abre o item no Outlook pelo esquema `outlook:<EntryID>`.
                      O EntryID MUDA quando o e-mail é movido de pasta — e mover
                      de pasta é o que o time faz ao resolver um assunto. O motor
                      reescreve o id a cada rodada, então o link fica no máximo
                      meio dia velho; quando ele falhar, o "buscar" ao lado acha
                      pelo assunto e nunca envelhece. */}
                  {/* `ace-email:` e não `outlook:`. O esquema `outlook:` NÃO está
                      registrado no Windows desta instalação do Office — só o
                      `mailto:` —, então o link não fazia nada ao ser clicado.
                      `ace-email:` é um handler próprio (Licitacao/_motor/
                      abre_email.py) que resolve o EntryID pelo COM e manda o
                      Outlook mostrar o item; testado ponta a ponta.

                      A saída é copiar o assunto, e não um link de busca do
                      Outlook web: aquele link ignorava a consulta e abria a
                      caixa de entrada, o que é pior que não ter saída — parece
                      que funcionou e não levou a lugar nenhum. */}
                  <span className="ml-auto flex items-center gap-2">
                    {e.entry_id && (
                      <a href={`ace-email:${e.entry_id}`}
                        className="flex items-center gap-1 rounded border border-blue-200 bg-blue-50 px-2 py-0.5 font-medium text-blue-700 hover:bg-blue-100"
                        title="abrir este e-mail no Outlook do computador">
                        <ExternalLink className="h-3 w-3" /> abrir no Outlook
                      </a>
                    )}
                    <button
                      onClick={() => {
                        navigator.clipboard.writeText(e.assunto || '')
                          .then(() => toast.success('Assunto copiado — cole na busca do Outlook'))
                          .catch(() => toast.error('Não consegui copiar'))
                      }}
                      className="text-gray-500 hover:text-blue-600 hover:underline"
                      title="copiar o assunto para colar na busca do Outlook">
                      copiar assunto
                    </button>
                  </span>
                </div>
                {e.assunto !== c.assunto && (
                  <p className="mt-1 text-xs font-medium text-gray-800">{e.assunto}</p>
                )}
                <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-gray-600">
                  {e.corpo || '(sem texto no corpo)'}
                </p>
              </div>
            ))}
          </div>
          <p className="mt-1.5 text-[11px] text-gray-400">
            Se “abrir no Outlook” não fizer nada, o atalho não está registrado nesta
            máquina: rode uma vez{' '}
            <code className="rounded bg-gray-100 px-1">instala_protocolo.py</code> na pasta
            do motor.
          </p>
        </Secao>

        {/* Ações: as mesmas do card, para não obrigar a fechar e voltar. */}
        <div className="sticky bottom-0 space-y-2 border-t border-gray-200 bg-white p-4">
          <div className="flex flex-wrap items-center gap-2">
            {([['NAO', 'Em aberto', MinusCircle], ['PARCIAL', 'Parcial', CircleDot],
               ['SIM', 'Resolvido', Check]] as const).map(([valor, label, Icone]) => (
              <button key={valor} onClick={() => onTriar(valor)} disabled={salvando}
                className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                  c.situacao === valor
                    ? 'border-gray-900 bg-gray-900 text-white'
                    : 'border-gray-200 bg-white text-gray-600 hover:border-gray-400'}`}>
                <Icone className="h-3.5 w-3.5" /> {label}
              </button>
            ))}
            <button onClick={() => onTratativa(!c.em_tratativa)} disabled={salvando}
              className={`flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs font-medium transition disabled:opacity-50 ${
                c.em_tratativa
                  ? 'border-violet-300 bg-violet-100 text-violet-800 hover:bg-violet-200'
                  : 'border-gray-200 bg-white text-gray-600 hover:border-violet-400'}`}>
              <Hand className="h-3.5 w-3.5" /> {c.em_tratativa ? 'liberar' : 'assumir'}
            </button>
            {!c.demanda_id && (
              <button onClick={onPromover} disabled={salvando}
                className="ml-auto rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
                Gerar demanda
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <input value={nota} onChange={e => setNota(e.target.value)}
              placeholder="anotar algo sobre este caso…"
              className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs" />
            <button disabled={!nota.trim() || salvando}
              onClick={() => { onNota(nota.trim()); setNota('') }}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40">
              salvar nota
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

function CardEntrada({ c, onTriar, onNota, onTratativa, onAbrir, onPromover, salvando }: {
  c: Card
  onTriar: (situacao: string) => void
  onNota: (texto: string) => void
  onTratativa: (v: boolean) => void
  onAbrir: () => void
  onPromover: () => void
  salvando: boolean
}) {
  const sit = SITUACAO[c.situacao]
  const prio = PRIORIDADE[c.prioridade] || PRIORIDADE[5]!

  return (
    <div className={`rounded-xl border p-4 transition ${sit.cor}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`rounded border px-1.5 py-0.5 text-[11px] font-semibold ${prio.cor}`}>
              {prio.label}
            </span>
            {c.empenho && (
              <span className="rounded bg-gray-900 px-2 py-0.5 font-mono text-[11px] text-white">
                {c.empenho}
              </span>
            )}
            {/* Sem nota de empenho, o numero do documento e o que identifica o
                caso. Quatro cards escritos "Ordem de fornecimento - MSB" sao
                indistinguiveis sem isto. */}
            {!c.empenho && c.documento && (
              <span className="rounded bg-gray-200 px-2 py-0.5 font-mono text-[11px] text-gray-700"
                title="numero do documento citado no anexo ou no assunto">
                doc {c.documento}
              </span>
            )}
            <span className="text-[11px] text-gray-500">{TIPO_LABEL[c.tipo || 'OUTRO']}</span>
            {c.emails.length > 1 && (
              <span className="flex items-center gap-1 text-[11px] text-gray-500">
                <Mail className="h-3 w-3" />{c.emails.length} e-mails
              </span>
            )}
          </div>
          {/* O assunto e o alvo natural do clique: e o que identifica o caso.
              O antigo "historico e nota" expandia so os e-mails no proprio
              card; a tela de detalhe mostra tudo o que se sabe. */}
          <button onClick={onAbrir}
            className="mt-1.5 block w-full truncate text-left text-sm font-medium text-gray-900 hover:text-blue-700 hover:underline">
            {c.assunto}
          </button>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
            {/* Data E dias parados juntos: a planilha tinha as duas colunas, e
                elas respondem coisas diferentes — "quando chegou" e "ha quanto
                tempo espera". Num caso agrupado a data e a do PRIMEIRO e-mail. */}
            <span className="tabular-nums">{fmtDia(c.recebido_em)}</span>
            <span className={`flex items-center gap-1 ${c.dias_parados > 15 ? 'font-semibold text-red-700' : ''}`}>
              <Clock className="h-3 w-3" />
              {c.dias_parados === 0 ? 'hoje' : `${c.dias_parados} dia${c.dias_parados > 1 ? 's' : ''}`}
            </span>
            {c.contrato && (
              /* O codigo interno sozinho ("MSB-000238") nao diz nada; o titulo
                 do contrato diz de que pregao e de que familia de produto o
                 caso e. Fica no title para nao competir com o resto da linha. */
              <span title={c.contrato_titulo
                ? `contrato MSB — ${c.contrato_titulo}`
                : 'contrato MSB citado no e-mail'}>
                contrato <span className="font-medium text-gray-900">{c.contrato}</span>
                {c.contrato_desconhecido && (
                  <span className="ml-1 text-amber-700" title="este contrato não existe no export do D365 — pode ser erro de digitação">!</span>
                )}
              </span>
            )}
            {c.pregao && (
              <span title="pregão citado no documento">
                pregão <span className="font-medium text-gray-900">{c.pregao}</span>
              </span>
            )}
            {c.cliente_nome ? (
              <span>{c.cliente_nome}</span>
            ) : (
              <span className="flex items-center gap-1 font-medium text-amber-700">
                <ShieldQuestion className="h-3 w-3" />
                {c.orgao_texto ? `${c.orgao_texto.slice(0, 40)} — sem cliente` : 'sem cliente'}
              </span>
            )}
            {c.valor_total > 0 && <span className="font-medium text-gray-900">{fmtBRL(c.valor_total)}</span>}
            {/* O prazo que o ORGAO exige, lido do anexo. Diferente de "dias
                parados": um e idade, o outro e compromisso. */}
            {c.entrega_prevista && (() => {
              const hoje = new Date().toISOString().slice(0, 10)
              const vencido = c.entrega_prevista < hoje
              return (
                <span className={`flex items-center gap-1 ${
                  vencido ? 'font-semibold text-red-700' : 'text-gray-600'}`}>
                  <CalendarClock className="h-3 w-3" />
                  {vencido ? 'entrega venceu ' : 'entregar até '}
                  {new Date(c.entrega_prevista + 'T12:00:00').toLocaleDateString('pt-BR')}
                </span>
              )
            })()}
          </div>
        </div>
        {c.demanda_id ? (
          /* Ja virou trabalho: o card mostra ONDE esta, e nao so que existe.
             E esta informacao — "isto ja e a OV016058, NF enviada" — que faz
             alguem nao refazer o pedido. Foi um quase-duplicado que originou
             todo este processo. */
          <a href={`/licitacoes?demanda=${c.demanda_id}`}
            className="shrink-0 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-right text-xs text-emerald-800 hover:bg-emerald-100">
            <span className="flex items-center gap-1 font-medium">
              <Link2 className="h-3.5 w-3.5" />
              {c.demanda ? ETAPA_CURTA[c.demanda.etapa] || c.demanda.etapa.toLowerCase() : 'ver demanda'}
            </span>
            {c.demanda?.ovs?.length ? (
              <span className="mt-0.5 block font-mono text-[11px]">
                {c.demanda.ovs.map((o: any) => o.numero).filter(Boolean).join(' · ')}
              </span>
            ) : null}
            {c.demanda?.numero_nf && (
              <span className="mt-0.5 block text-[11px]">NF {c.demanda.numero_nf}</span>
            )}
          </a>
        ) : (
          <button onClick={onPromover} disabled={salvando}
            className="shrink-0 rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-700 disabled:opacity-50">
            Gerar demanda
          </button>
        )}
      </div>

      {c.sugestoes.map((s, n) => (
        <div key={n} className="mt-2 flex items-start gap-1.5 rounded-lg border border-sky-200 bg-sky-50 px-2.5 py-1.5 text-xs text-sky-900">
          <CircleDot className="mt-0.5 h-3 w-3 shrink-0" /> {s}
        </div>
      ))}

      <ItensDoPedido itens={c.itens} />

      {c.itens.length === 0 && c.anexos_com_problema.length > 0 && (
        <div className="mt-2 flex items-start gap-1.5 rounded-lg bg-gray-100 px-2.5 py-1.5 text-xs text-gray-600">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" />
          O anexo veio escaneado (foto, sem texto) — abra o e-mail para ver o que foi pedido.
        </div>
      )}

      {/* No card, so a nota mais recente: o resto fica no detalhe. Empilhar
          cinco anotacoes aqui afogaria o que decide a proxima acao. */}
      {c.notas.length > 0 && (
        <p className="mt-2 rounded bg-white/70 px-2 py-1 text-xs italic text-gray-600">
          “{c.notas[0].texto}”
          {c.notas.length > 1 && (
            <span className="ml-1 not-italic text-gray-400">+{c.notas.length - 1} anterior(es)</span>
          )}
        </p>
      )}

      {/* Os três estados. PARCIAL está aqui porque o time precisou dele: na
          triagem de 03/09 escreveram "Parcial" à mão numa planilha que só
          oferecia Sim/Nao. */}
      <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-black/5 pt-3">
        {([['NAO', 'Em aberto', MinusCircle], ['PARCIAL', 'Parcial', CircleDot],
           ['SIM', 'Resolvido', Check]] as const).map(([valor, label, Icone]) => (
          <button key={valor} onClick={() => onTriar(valor)} disabled={salvando}
            className={`flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50 ${
              c.situacao === valor
                ? 'border-gray-900 bg-gray-900 text-white'
                : 'border-gray-200 bg-white text-gray-600 hover:border-gray-400'}`}>
            <Icone className="h-3.5 w-3.5" /> {label}
          </button>
        ))}
        {/* Eixo separado da situacao: um caso que voce assumiu continua em
            aberto ate ser atendido. Marcar PARCIAL para dizer "estou nisso"
            mentiria sobre o atendimento.
            
            O rotulo diz o que o CLIQUE faz, nunca o estado. A primeira versao
            escrevia "tratando" quando assumido, e o Tassio perguntou se era ali
            que se aperta — sinal claro de que um botao rotulado com o estado
            nao diz se o clique confirma ou desfaz. Quem mostra o estado e o
            selo violeta no topo do card. */}
        <button onClick={() => onTratativa(!c.em_tratativa)} disabled={salvando}
          title={c.em_tratativa ? 'devolver o caso para ninguém' : 'marcar que você está cuidando deste caso'}
          className={`flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs font-medium transition disabled:opacity-50 ${
            c.em_tratativa
              ? 'border-violet-300 bg-violet-100 text-violet-800 hover:bg-violet-200'
              : 'border-gray-200 bg-white text-gray-600 hover:border-violet-400'}`}>
          <Hand className="h-3.5 w-3.5" /> {c.em_tratativa ? 'liberar' : 'assumir'}
        </button>
        <button onClick={onAbrir}
          className="ml-auto text-xs font-medium text-blue-600 hover:underline">
          ver tudo{c.emails.length > 1 ? ` (${c.emails.length} e-mails)` : ''}
        </button>
      </div>

    </div>
  )
}

export function AbaCaixaEntrada() {
  const qc = useQueryClient()
  const [filtro, setFiltro] = useState<'NAO' | 'PARCIAL' | 'SIM' | ''>('NAO')
  const [tipo, setTipo] = useState('')
  const [soTratativa, setSoTratativa] = useState(false)
  // Qual solicitacao esta com o detalhe aberto (a chave do caso).
  const [detalhe, setDetalhe] = useState<string | null>(null)
  const [busca, setBusca] = useState('')

  const { data: cards = [], isLoading } = useQuery<Card[]>({
    queryKey: ['licitacao-entrada', filtro, tipo],
    queryFn: () => {
      const p = new URLSearchParams()
      if (filtro) p.set('situacao', filtro)
      if (tipo) p.set('tipo', tipo)
      const q = p.toString()
      return api.get(`/licitacoes/entrada${q ? `?${q}` : ''}`).then(r => r.data)
    },
  })

  const triar = useMutation({
    mutationFn: ({ chave, situacao, observacao, em_tratativa }:
      { chave: string; situacao?: string; observacao?: string; em_tratativa?: boolean }) =>
      api.post(`/licitacoes/entrada/grupo/triar?chave=${encodeURIComponent(chave)}`,
        { situacao: situacao || undefined, observacao, em_tratativa }),
    onSuccess: (_r, vars) => {
      // Sem aviso, salvar uma nota nao dava sinal nenhum na tela: o Tassio
      // clicou tres vezes e gravou a mesma anotacao tres vezes. Retorno
      // explicito e mais importante aqui do que em qualquer outra acao, porque
      // a nota aparece numa secao que pode estar fora da area visivel.
      if (vars.observacao) toast.success('Anotação salva')
      qc.invalidateQueries({ queryKey: ['licitacao-entrada'] })
      qc.invalidateQueries({ queryKey: ['licitacao-painel'] })
    },
    onError: (e: any) => toast.error(msgErro(e, 'Não consegui salvar a triagem')),
  })

  const apagarNota = useMutation({
    mutationFn: (id: string) => api.delete(`/licitacoes/entrada/notas/${id}`),
    onSuccess: () => {
      toast.success('Anotação apagada')
      qc.invalidateQueries({ queryKey: ['licitacao-entrada'] })
    },
    onError: (e: any) => toast.error(msgErro(e, 'Não consegui apagar a anotação')),
  })

  const promover = useMutation({
    mutationFn: (chave: string) =>
      api.post(`/licitacoes/entrada/grupo/promover?chave=${encodeURIComponent(chave)}`, {}),
    onSuccess: () => {
      toast.success('Demanda criada — o card já está no painel')
      qc.invalidateQueries({ queryKey: ['licitacao-entrada'] })
      qc.invalidateQueries({ queryKey: ['demandas'] })
    },
    onError: (e: any) => toast.error(msgErro(e, 'Não consegui gerar a demanda')),
  })

  const filtrados = useMemo(() => {
    const q = busca.trim().toLowerCase()
    const base = soTratativa ? cards.filter(c => c.em_tratativa) : cards
    if (!q) return base
    return base.filter(c =>
      [c.assunto, c.empenho, c.cliente_nome, c.orgao_texto, c.contrato]
        .some(v => (v || '').toLowerCase().includes(q)))
  }, [cards, busca, soTratativa])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex rounded-lg border border-gray-200 bg-white p-0.5">
          {([['NAO', 'Em aberto'], ['PARCIAL', 'Parcial'], ['SIM', 'Resolvidos'], ['', 'Todos']] as const)
            .map(([v, label]) => (
              <button key={v} onClick={() => setFiltro(v)}
                className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
                  filtro === v ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
                {label}
              </button>
            ))}
        </div>
        {/* Tipo de solicitação. São operações diferentes: quem está tratando
            comunicado de uso não quer venda direta no meio. */}
        <select value={tipo} onChange={e => setTipo(e.target.value)}
          className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700">
          <option value="">Todos os tipos</option>
          {['VENDA_DIRETA', 'CONSIGNACAO', 'COMUNICADO_USO', 'AMOSTRA', 'OUTRO'].map(t => (
            <option key={t} value={t}>{TIPO_LABEL[t]}</option>
          ))}
        </select>
        <div className="relative min-w-[200px] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <input value={busca} onChange={e => setBusca(e.target.value)}
            placeholder="nota de empenho, órgão, assunto…"
            className="w-full rounded-lg border border-gray-200 py-2 pl-9 pr-3 text-sm" />
        </div>
        <button onClick={() => setSoTratativa(v => !v)}
          className={`flex items-center gap-1.5 rounded-lg border px-3 py-2 text-sm font-medium transition ${
            soTratativa
              ? 'border-violet-300 bg-violet-100 text-violet-800'
              : 'border-gray-200 bg-white text-gray-600 hover:border-violet-400'}`}>
          <Hand className="h-4 w-4" /> em tratativa
        </button>
        <span className="text-sm text-gray-500">{filtrados.length} casos</span>
      </div>

      {isLoading ? (
        <div className="py-16 text-center"><Loader2 className="mx-auto h-6 w-6 animate-spin text-gray-400" /></div>
      ) : filtrados.length === 0 ? (
        <div className="rounded-xl border border-dashed border-gray-300 py-16 text-center">
          <Inbox className="mx-auto h-8 w-8 text-gray-300" />
          <p className="mt-2 text-sm text-gray-500">
            {busca ? 'Nada encontrado com esse texto.' : 'Nada aqui — a caixa de entrada está limpa.'}
          </p>
        </div>
      ) : (
        <div className="grid gap-3 xl:grid-cols-2">
          {filtrados.map(c => (
            <CardEntrada key={c.chave} c={c}
              salvando={triar.isPending || promover.isPending}
              onTriar={s => triar.mutate({ chave: c.chave, situacao: s })}
              onNota={t => triar.mutate({ chave: c.chave, observacao: t })}
              onTratativa={v => triar.mutate({ chave: c.chave, em_tratativa: v })}
              onAbrir={() => setDetalhe(c.chave)}
              onPromover={() => promover.mutate(c.chave)} />
          ))}
        </div>
      )}

      {/* O detalhe le do MESMO array ja carregado: abrir uma solicitacao nao
          dispara consulta nova, e o card e o detalhe nunca mostram estados
          diferentes do mesmo caso. Se a solicitacao sair do filtro depois de
          uma acao (marcar Resolvido com o filtro em "Em aberto"), o detalhe
          fecha sozinho — e o que a lista faria. */}
      {detalhe && (() => {
        const c = cards.find(x => x.chave === detalhe)
        if (!c) return null
        return (
          <DetalheSolicitacao c={c} salvando={triar.isPending || promover.isPending}
            onFechar={() => setDetalhe(null)}
            onTriar={sit => triar.mutate({ chave: c.chave, situacao: sit })}
            onNota={t => triar.mutate({ chave: c.chave, observacao: t })}
            onTratativa={v => triar.mutate({ chave: c.chave, em_tratativa: v })}
            onApagarNota={id => apagarNota.mutate(id)}
            onPromover={() => promover.mutate(c.chave)} />
        )
      })()}
    </div>
  )
}

// ── Órgãos (o de-para que destrava a ingestão) ───────────────────────────────

export function AbaOrgaos() {
  const qc = useQueryClient()
  const { data: pendentes = [], isLoading } = useQuery({
    queryKey: ['licitacao-orgaos-pendentes'],
    queryFn: () => api.get('/licitacoes/entrada/orgaos/pendentes').then(r => r.data),
  })
  const { data: mapeados = [] } = useQuery({
    queryKey: ['licitacao-orgaos'],
    queryFn: () => api.get('/licitacoes/entrada/orgaos').then(r => r.data),
  })
  const [escolha, setEscolha] = useState<Record<string, { id: string; nome: string } | null>>({})

  const mapear = useMutation({
    mutationFn: ({ cnpj, cliente_id, nome }: { cnpj: string; cliente_id: string; nome?: string }) =>
      api.post('/licitacoes/entrada/orgaos', { cnpj, cliente_id, nome_documento: nome }),
    onSuccess: (r) => {
      toast.success(`Órgão ligado — ${r.data.entradas_atualizadas} pedido(s) destravado(s)`)
      qc.invalidateQueries({ queryKey: ['licitacao-orgaos-pendentes'] })
      qc.invalidateQueries({ queryKey: ['licitacao-orgaos'] })
      qc.invalidateQueries({ queryKey: ['licitacao-entrada'] })
      qc.invalidateQueries({ queryKey: ['licitacao-painel'] })
    },
    onError: (e: any) => toast.error(msgErro(e, 'Não consegui ligar o órgão ao cliente')),
  })

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-sky-200 bg-sky-50 p-3 text-sm leading-relaxed text-sky-900">
        <b>Por que esta tela existe.</b> A demanda precisa saber de qual cliente é a venda, e
        o e-mail do órgão não diz isso de forma utilizável — dos 3.853 clientes do cadastro,
        48 têm CNPJ, e nenhum hospital de licitação está entre eles. Casar por nome erra
        feio. O que resolve é o tamanho: são cerca de <b>37 órgãos</b> em toda a licitação.
        Confirme cada um uma vez e a entrada passa a ser automática — o CNPJ vem no anexo e
        é chave exata.
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-900">
          Aguardando confirmação {pendentes.length > 0 && <span className="text-red-600">({pendentes.length})</span>}
        </h3>
        <p className="text-xs text-gray-500">
          Enquanto o órgão está aqui, os pedidos dele não podem virar demanda.
        </p>
        {isLoading ? (
          <div className="py-10 text-center"><Loader2 className="mx-auto h-5 w-5 animate-spin text-gray-400" /></div>
        ) : pendentes.length === 0 ? (
          <div className="mt-3 rounded-xl border border-dashed border-emerald-300 bg-emerald-50 py-10 text-center">
            <Check className="mx-auto h-7 w-7 text-emerald-500" />
            <p className="mt-2 text-sm text-emerald-800">Todos os órgãos que apareceram já têm cliente.</p>
          </div>
        ) : (
          <div className="mt-3 space-y-3">
            {pendentes.map((o: any) => (
              <div key={o.cnpj} className="rounded-xl border border-amber-200 bg-amber-50 p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-mono text-xs text-gray-600">{o.cnpj}</div>
                    <div className="mt-0.5 font-medium text-gray-900">
                      {o.nome_documento || '(o documento não trouxe o nome)'}
                    </div>
                    <div className="mt-1 text-xs text-gray-600">
                      {o.quantidade} e-mail(s) esperando · último: {o.ultimo_assunto?.slice(0, 60)}
                    </div>
                  </div>
                </div>

                {/* Candidatos por semelhança de nome. São SUGESTÃO: o casamento
                    automático ligou "Hosp. Univ. Lauro Wanderley" a uma pessoa
                    física chamada Wanderley. Quem confirma é gente. */}
                {o.candidatos?.length > 0 && (
                  <div className="mt-3">
                    <div className="text-xs font-medium text-gray-600">Parecidos no cadastro:</div>
                    <div className="mt-1.5 flex flex-wrap gap-2">
                      {o.candidatos.map((c: any) => (
                        <button key={c.id}
                          onClick={() => mapear.mutate({ cnpj: o.cnpj, cliente_id: c.id, nome: o.nome_documento })}
                          disabled={mapear.isPending}
                          className="rounded-lg border border-gray-300 bg-white px-2.5 py-1.5 text-xs text-gray-800 hover:border-blue-500 hover:bg-blue-50 disabled:opacity-50">
                          {c.nome}
                          <span className="ml-1.5 text-gray-400">{c.codigo}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                <div className="mt-3 flex flex-wrap items-end gap-2">
                  <div className="min-w-[260px] flex-1">
                    <label className="text-xs font-medium text-gray-600">Ou busque o cliente certo</label>
                    <ClienteAutocomplete
                      value={escolha[o.cnpj]?.id || ''}
                      initialNome={escolha[o.cnpj]?.nome}
                      onChange={(id, nome) => setEscolha(s => ({ ...s, [o.cnpj]: { id, nome } }))}
                    />
                  </div>
                  <button
                    disabled={!escolha[o.cnpj]?.id || mapear.isPending}
                    onClick={() => mapear.mutate({
                      cnpj: o.cnpj, cliente_id: escolha[o.cnpj]!.id, nome: o.nome_documento,
                    })}
                    className="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-700 disabled:opacity-40">
                    Ligar ao cliente
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div>
        <h3 className="text-sm font-semibold text-gray-900">Já confirmados ({mapeados.length})</h3>
        <div className="mt-2 overflow-hidden rounded-xl border border-gray-200 bg-white">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs uppercase tracking-wide text-gray-500">
                <th className="px-4 py-2 font-medium">CNPJ</th>
                <th className="px-4 py-2 font-medium">Como aparece no documento</th>
                <th className="px-4 py-2 font-medium">Cliente</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {mapeados.map((o: any) => (
                <tr key={o.cnpj}>
                  <td className="px-4 py-2 font-mono text-xs text-gray-600">{o.cnpj}</td>
                  <td className="px-4 py-2 text-gray-700">{o.nome_documento || '—'}</td>
                  <td className="px-4 py-2 text-gray-900">
                    {o.clientes?.nome} <span className="text-gray-400">{o.clientes?.codigo}</span>
                  </td>
                </tr>
              ))}
              {mapeados.length === 0 && (
                <tr><td colSpan={3} className="px-4 py-6 text-center text-gray-500">
                  Nenhum órgão confirmado ainda.
                </td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  )
}

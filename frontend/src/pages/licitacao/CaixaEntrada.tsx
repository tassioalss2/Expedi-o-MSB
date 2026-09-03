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
  MinusCircle, Package, Search, ShieldQuestion, X,
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

const SITUACAO = {
  NAO: { label: 'Em aberto', cor: 'bg-white border-gray-200', ponto: 'text-gray-400' },
  PARCIAL: { label: 'Parcial', cor: 'bg-amber-50 border-amber-200', ponto: 'text-amber-500' },
  SIM: { label: 'Resolvido', cor: 'bg-emerald-50 border-emerald-200', ponto: 'text-emerald-600' },
} as const

type Card = {
  chave: string
  empenho: string | null
  assunto: string
  recebido_em: string
  ultimo_em: string
  dias_parados: number
  prioridade: number
  motivo: string | null
  tipo: string | null
  contrato: string | null
  pregao: string | null
  cliente_id: string | null
  cliente_nome: string | null
  orgao_texto: string | null
  cnpj_orgao: string | null
  demanda_id: string | null
  situacao: 'NAO' | 'PARCIAL' | 'SIM'
  itens: any[]
  valor_total: number
  observacoes: string[]
  sugestoes: string[]
  anexos_com_problema: any[]
  emails: any[]
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
        <Tile titulo="Em aberto" valor={String(data.abertos)}
          sub={`de ${data.casos} casos no período`} />
        <Tile titulo="Críticos" valor={String(data.criticos)}
          sub="prioridade máxima, em aberto" alerta={data.criticos > 0} />
        <Tile titulo="Espera mais longa" valor={`${data.mais_antigo_dias} d`}
          sub="o caso aberto mais antigo" alerta={data.mais_antigo_dias > 15} />
        <Tile titulo="Valor em aberto" valor={fmtBRL(data.valor_parado)}
          sub={`piso — lido em ${cob.casos_com_valor} de ${cob.casos_abertos} casos`} />
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
                  <div key={f.chave} style={{ width: `${pct}%`, background: f.cor }}
                    title={`${f.label}: ${n} caso(s)`}
                    className="flex items-center justify-center first:rounded-l last:rounded-r">
                    {pct > 8 && (
                      <span className={`text-xs font-semibold tabular-nums ${
                        f.chave === 'de_3_a_7' ? 'text-amber-950' : 'text-white'}`}>{n}</span>
                    )}
                  </div>
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
              <tr key={c.cliente}>
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

function CardEntrada({ c, onTriar, onNota, onPromover, salvando }: {
  c: Card
  onTriar: (situacao: string) => void
  onNota: (texto: string) => void
  onPromover: () => void
  salvando: boolean
}) {
  const [aberto, setAberto] = useState(false)
  const [nota, setNota] = useState('')
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
            <span className="text-[11px] text-gray-500">{TIPO_LABEL[c.tipo || 'OUTRO']}</span>
            {c.emails.length > 1 && (
              <span className="flex items-center gap-1 text-[11px] text-gray-500">
                <Mail className="h-3 w-3" />{c.emails.length} e-mails
              </span>
            )}
          </div>
          <h4 className="mt-1.5 truncate text-sm font-medium text-gray-900">{c.assunto}</h4>
          <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-gray-600">
            <span className={`flex items-center gap-1 ${c.dias_parados > 15 ? 'font-semibold text-red-700' : ''}`}>
              <Clock className="h-3 w-3" />
              {c.dias_parados === 0 ? 'hoje' : `${c.dias_parados} dia${c.dias_parados > 1 ? 's' : ''}`}
            </span>
            {c.cliente_nome ? (
              <span>{c.cliente_nome}</span>
            ) : (
              <span className="flex items-center gap-1 font-medium text-amber-700">
                <ShieldQuestion className="h-3 w-3" />
                {c.orgao_texto ? `${c.orgao_texto.slice(0, 40)} — sem cliente` : 'sem cliente'}
              </span>
            )}
            {c.valor_total > 0 && <span className="font-medium text-gray-900">{fmtBRL(c.valor_total)}</span>}
          </div>
        </div>
        {c.demanda_id ? (
          <a href={`/licitacoes?demanda=${c.demanda_id}`}
            className="flex shrink-0 items-center gap-1 rounded-lg border border-emerald-200 bg-emerald-50 px-2.5 py-1.5 text-xs font-medium text-emerald-700 hover:bg-emerald-100">
            <Link2 className="h-3.5 w-3.5" /> ver demanda
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

      {c.observacoes.map((o, n) => (
        <p key={n} className="mt-2 rounded bg-white/70 px-2 py-1 text-xs italic text-gray-600">“{o}”</p>
      ))}

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
        <button onClick={() => setAberto(v => !v)}
          className="ml-auto text-xs font-medium text-blue-600 hover:underline">
          {aberto ? 'esconder' : `histórico e nota${c.emails.length > 1 ? ` (${c.emails.length})` : ''}`}
        </button>
      </div>

      {aberto && (
        <div className="mt-3 space-y-2 border-t border-black/5 pt-3">
          {c.emails.map(e => (
            <div key={e.id} className="rounded-lg bg-white/60 p-2 text-xs">
              <div className="flex items-center gap-2 text-gray-500">
                <span className="tabular-nums">{fmtDia(e.recebido_em)}</span>
                {e.pasta && <span className="rounded bg-gray-100 px-1.5">{e.pasta}</span>}
              </div>
              <p className="mt-1 whitespace-pre-wrap text-gray-700">
                {(e.corpo || '').slice(0, 400) || e.assunto}
              </p>
            </div>
          ))}
          <div className="flex gap-2">
            <input value={nota} onChange={ev => setNota(ev.target.value)}
              placeholder="anotar algo sobre este caso…"
              className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs" />
            <button
              disabled={!nota.trim() || salvando}
              onClick={() => { onNota(nota.trim()); setNota('') }}
              className="rounded-lg border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-40">
              salvar nota
            </button>
          </div>
        </div>
      )}
    </div>
  )
}

export function AbaCaixaEntrada() {
  const qc = useQueryClient()
  const [filtro, setFiltro] = useState<'NAO' | 'PARCIAL' | 'SIM' | ''>('NAO')
  const [busca, setBusca] = useState('')

  const { data: cards = [], isLoading } = useQuery<Card[]>({
    queryKey: ['licitacao-entrada', filtro],
    queryFn: () => api.get(`/licitacoes/entrada${filtro ? `?situacao=${filtro}` : ''}`).then(r => r.data),
  })

  const triar = useMutation({
    mutationFn: ({ chave, situacao, observacao }: { chave: string; situacao?: string; observacao?: string }) =>
      api.post(`/licitacoes/entrada/grupo/triar?chave=${encodeURIComponent(chave)}`,
        { situacao: situacao || undefined, observacao }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['licitacao-entrada'] })
      qc.invalidateQueries({ queryKey: ['licitacao-painel'] })
    },
    onError: (e: any) => toast.error(msgErro(e, 'Não consegui salvar a triagem')),
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
    if (!q) return cards
    return cards.filter(c =>
      [c.assunto, c.empenho, c.cliente_nome, c.orgao_texto, c.contrato]
        .some(v => (v || '').toLowerCase().includes(q)))
  }, [cards, busca])

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
        <div className="relative min-w-[220px] flex-1">
          <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-gray-400" />
          <input value={busca} onChange={e => setBusca(e.target.value)}
            placeholder="nota de empenho, órgão, assunto…"
            className="w-full rounded-lg border border-gray-200 py-2 pl-9 pr-3 text-sm" />
        </div>
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
              onPromover={() => promover.mutate(c.chave)} />
          ))}
        </div>
      )}
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

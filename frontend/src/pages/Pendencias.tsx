/**
 * Tratamento de pendências de OV — venda fechada esperando material.
 *
 * Antes isto era uma tabela dentro do Painel Comercial: dava para VER o que
 * estava parado, não para TRATAR. Quem cobrava o PCP toda semana não tinha onde
 * anotar a resposta, e a próxima pessoa recomeçava do zero.
 *
 * A tela é organizada pelo que fazer AGORA, não por cliente nem por data:
 *
 *   1. Chegou tudo      → liberar, e o dinheiro volta a andar
 *   2. Chegou parte     → liberar o que dá, o resto continua pendente
 *   3. Sem material     → cobrar o PCP e anotar a resposta
 *   4. Bloqueada        → tem impedimento; o motivo está no card
 *
 * A ordem não é escolha estética: as duas primeiras filas são dinheiro que sai
 * hoje. Uma lista única ordenada por data enterra elas no meio de pendências que
 * ninguém pode resolver ainda.
 */
import { useMemo, useState, Fragment } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import {
  AlertTriangle, CalendarClock, CheckCircle2, ChevronDown, ChevronRight,
  ArrowDown, ArrowUp, ChevronsUp, Clock, History, ListOrdered, PackageCheck,
  Check, PackageX, PencilLine, Plus, RotateCcw, Search, Send, Trash2, X,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'
import { fmtBRL, msgErro, type Pendencia, type PendenciasResp } from '../lib/crm'
import { ModalLiberarPendencia } from '../components/EstoqueVenda'
import { ModalAjusteEstoque } from '../components/AjusteEstoque'
import { LINHA_DO_CANAL } from '../lib/statusConfig'
import { hojeLocal } from '../lib/dataLocal'

/** Dias parada a partir dos quais a espera deixa de ser normal. */
// Quantidade sem casas decimais quando é inteira — 100 un, não 100,000.
const n = (v?: number | null) =>
  (Number(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })

const DIAS_ATENCAO = 7
const DIAS_CRITICO = 15

const dataBR = (iso?: string | null) =>
  iso ? format(new Date(String(iso).slice(0, 10) + 'T12:00:00'), 'dd/MM/yyyy') : '—'

type FilaKey = 'COMPLETO' | 'PARCIAL' | 'NENHUM' | 'BLOQUEADA'

const FILAS: Array<{
  key: FilaKey; titulo: string; explica: string; icone: any
  cor: string; borda: string; fundo: string
}> = [
  {
    key: 'COMPLETO', titulo: 'Chegou tudo', icone: PackageCheck,
    explica: 'O material está em estoque. Liberar aqui manda a venda para a expedição.',
    cor: 'text-emerald-700', borda: 'border-emerald-200', fundo: 'bg-emerald-50/60',
  },
  {
    key: 'PARCIAL', titulo: 'Chegou parte', icone: PackageCheck,
    explica: 'Dá para liberar o que já existe; o saldo continua pendente nesta mesma venda.',
    cor: 'text-amber-700', borda: 'border-amber-200', fundo: 'bg-amber-50/60',
  },
  {
    key: 'NENHUM', titulo: 'Sem material', icone: PackageX,
    explica: 'Nada em estoque ainda. O que dá para fazer é cobrar o PCP e anotar a resposta.',
    cor: 'text-gray-600', borda: 'border-gray-200', fundo: 'bg-white',
  },
  {
    key: 'BLOQUEADA', titulo: 'Bloqueada', icone: AlertTriangle,
    explica: 'Tem impedimento antes do estoque — o motivo está em cada card.',
    cor: 'text-red-700', borda: 'border-red-200', fundo: 'bg-red-50/50',
  },
]

function filaDe(p: Pendencia): FilaKey {
  if (!p.pode_liberar) return 'BLOQUEADA'
  return (p.estoque_agora?.status as FilaKey) || 'NENHUM'
}

export default function Pendencias() {
  const qc = useQueryClient()
  const [busca, setBusca] = useState('')
  const [linha, setLinha] = useState('')
  const [verHistorico, setVerHistorico] = useState(false)
  const [liberando, setLiberando] = useState<Pendencia | null>(null)
  const [acompanhando, setAcompanhando] = useState<Pendencia | null>(null)
  const [verFila, setVerFila] = useState(false)

  const { data, isLoading } = useQuery<PendenciasResp>({
    queryKey: ['crm-pendencias', verHistorico],
    queryFn: () => api.get('/crm/pendencias', { params: { incluir_resolvidas: verHistorico } })
      .then(r => r.data),
    refetchInterval: 60000,
  })

  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ['crm-pendencias'] })
    qc.invalidateQueries({ queryKey: ['crm-opps'] })
    qc.invalidateQueries({ queryKey: ['pedidos'] })
    qc.invalidateQueries({ queryKey: ['home-pendencias'] })
  }

  const [aba, setAba] = useState<'ov' | 'produto'>('ov')
  const todas = data?.pendencias || []

  const { abertas, resolvidas } = useMemo(() => {
    const b = busca.trim().toLowerCase()
    const passa = (p: Pendencia) => {
      if (linha && LINHA_DO_CANAL[p.canal || ''] !== LINHA_DO_CANAL[linha]) return false
      if (!b) return true
      const itens = (p.itens || []).map(i => `${i.codigo || ''} ${i.descricao || ''}`).join(' ')
      return `${p.cliente || ''} ${p.titulo || ''} ${p.origem || ''} ${p.ov_ref || ''} ${itens}`
        .toLowerCase().includes(b)
    }
    const f = todas.filter(passa)
    return {
      abertas: f.filter(p => !p.resolvido_em),
      resolvidas: f.filter(p => !!p.resolvido_em),
    }
  }, [todas, busca, linha])

  // Dentro de cada fila, a mais parada primeiro: a espera longa é o que vira
  // reclamação de cliente.
  const porFila = useMemo(() => {
    const m: Record<FilaKey, Pendencia[]> = { COMPLETO: [], PARCIAL: [], NENHUM: [], BLOQUEADA: [] }
    for (const p of abertas) m[filaDe(p)].push(p)
    for (const k of Object.keys(m) as FilaKey[]) {
      m[k].sort((a, b) => (b.dias_parada || 0) - (a.dias_parada || 0))
    }
    return m
  }, [abertas])

  const liberavelAgora = porFila.COMPLETO.concat(porFila.PARCIAL)
    .reduce((a, p) => a + (p.estoque_agora?.valor_disponivel || 0), 0)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-gray-800">Pendências de OV</h1>
        <p className="text-sm text-gray-500">
          Venda fechada com saldo a entregar. Organizado pelo que dá para fazer agora —
          o que está só esperando material e o que já existe e foi deixado livre.
        </p>
      </div>

      {/* Duas perguntas diferentes sobre o mesmo saldo: "o que faço com esta
          venda" (por OV) e "qual item está segurando mais dinheiro" (por
          produto) — a segunda é a de quem produz e de quem prioriza. */}
      <div className="flex items-center gap-1 border-b border-gray-200">
        {([['ov', 'Por OV'], ['produto', 'Por produto']] as const).map(([k, rot]) => (
          <button key={k} onClick={() => setAba(k)}
            className={`px-4 py-2 text-sm font-medium -mb-px border-b-2 transition ${aba === k
              ? 'border-indigo-600 text-indigo-700'
              : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            {rot}
          </button>
        ))}
      </div>

      {aba === 'produto' ? <PorProduto /> : <>

      {/* Os três números que decidem o dia */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Kpi
          rotulo="Parado esperando material"
          valor={fmtBRL(abertas.reduce((a, p) => a + (p.valor || 0), 0))}
          detalhe={`${abertas.length} pendência(s)`}
          cor="text-red-700"
        />
        <Kpi
          rotulo="Dá para liberar agora"
          valor={fmtBRL(liberavelAgora)}
          detalhe={`${porFila.COMPLETO.length} completa(s) · ${porFila.PARCIAL.length} parcial(is)`}
          cor="text-emerald-700"
        />
        <Kpi
          rotulo="Espera mais longa"
          valor={abertas.length
            ? `${Math.max(...abertas.map(p => p.dias_parada || 0))} dias`
            : '—'}
          detalhe={`${abertas.filter(p => (p.dias_parada || 0) >= DIAS_CRITICO).length} acima de ${DIAS_CRITICO} dias`}
          cor="text-gray-800"
        />
      </div>

      {data?.estoque_desatualizado && (
        <p className="text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
          O estoque mostrado é a última foto do PCP
          {data.estoque_data_ref ? ` (${dataBR(data.estoque_data_ref)})` : ''} — a liberação
          reconfere antes de mandar qualquer coisa para a expedição.
        </p>
      )}

      {/* Filtros */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[240px] max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={busca} onChange={e => setBusca(e.target.value)}
            placeholder="Cliente, OV ou código do item…"
            className="w-full border rounded-lg pl-9 pr-3 py-2 text-sm" />
        </div>
        <select value={linha} onChange={e => setLinha(e.target.value)}
          className="border rounded-lg px-3 py-2 text-sm">
          <option value="">Todas as linhas</option>
          {['URO', 'VASCULAR', 'REALCLOSURE'].map(l => (
            <option key={l} value={l}>{LINHA_DO_CANAL[l]}</option>
          ))}
        </select>
        <button onClick={() => setVerFila(v => !v)}
          title="Quem recebe o material primeiro quando o estoque não dá para todos"
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border ${verFila
            ? 'bg-indigo-600 text-white border-indigo-600' : 'text-gray-600 hover:bg-gray-50'}`}>
          <ListOrdered size={14} /> Ordem da fila
          {(data?.priorizadas_a_mao || 0) > 0 && (
            <span className={`text-[10px] px-1 rounded ${verFila ? 'bg-indigo-500' : 'bg-indigo-100 text-indigo-700'}`}>
              {data?.priorizadas_a_mao} à mão
            </span>
          )}
        </button>
        <button onClick={() => setVerHistorico(v => !v)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border ${verHistorico
            ? 'bg-gray-800 text-white border-gray-800' : 'text-gray-600 hover:bg-gray-50'}`}>
          <History size={14} /> Já resolvidas
        </button>
      </div>

      {verFila && (
        <PainelFila abertas={abertas} priorizadas={data?.priorizadas_a_mao || 0}
          onMudou={invalidar} />
      )}

      {isLoading ? (
        <p className="text-sm text-gray-400 py-8 text-center">Carregando…</p>
      ) : abertas.length === 0 ? (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-8 text-center">
          <CheckCircle2 size={28} className="mx-auto text-emerald-600 mb-2" />
          <p className="text-sm font-medium text-emerald-800">Nenhuma venda esperando material.</p>
          <p className="text-xs text-emerald-700 mt-0.5">
            {busca || linha ? 'Nenhuma pendência com esse filtro.' : 'Tudo que foi vendido tem estoque.'}
          </p>
        </div>
      ) : (
        FILAS.map(f => {
          const lista = porFila[f.key]
          if (lista.length === 0) return null
          const total = lista.reduce((a, p) => a + (p.valor || 0), 0)
          const Icone = f.icone
          return (
            <section key={f.key} className={`rounded-xl border ${f.borda} ${f.fundo} p-4`}>
              <div className="flex items-baseline justify-between gap-2 mb-1">
                <h2 className={`text-sm font-semibold flex items-center gap-1.5 ${f.cor}`}>
                  <Icone size={16} /> {f.titulo}
                  <span className="text-xs font-normal text-gray-400">
                    {lista.length} {lista.length === 1 ? 'venda' : 'vendas'}
                  </span>
                </h2>
                <span className={`text-sm font-semibold tabular-nums ${f.cor}`}>{fmtBRL(total)}</span>
              </div>
              <p className="text-xs text-gray-500 mb-3">{f.explica}</p>
              <div className="space-y-2">
                {lista.map(p => (
                  <Card key={`${p.fonte}-${p.id}`} p={p}
                    onLiberar={() => setLiberando(p)}
                    onAcompanhar={() => setAcompanhando(p)} />
                ))}
              </div>
            </section>
          )
        })
      )}

      {verHistorico && (
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5 mb-3">
            <History size={16} /> Já resolvidas
            <span className="text-xs font-normal text-gray-400">{resolvidas.length}</span>
          </h2>
          {resolvidas.length === 0 ? (
            <p className="text-xs text-gray-400">Nenhuma pendência resolvida no histórico.</p>
          ) : (
            <div className="space-y-1.5">
              {resolvidas.map(p => (
                <div key={`${p.fonte}-${p.id}`}
                  className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-sm py-1.5 border-b border-gray-50 last:border-0">
                  <CheckCircle2 size={13} className="text-emerald-600 shrink-0" />
                  <span className="font-medium text-gray-700">{p.cliente || '—'}</span>
                  {p.ov_ref && <span className="font-mono text-xs text-gray-500">{p.ov_ref}</span>}
                  <span className="text-xs text-gray-400">
                    resolvida em {dataBR(p.resolvido_em)}
                    {p.dias_parada != null && ` · esperou ${p.dias_parada} dia(s)`}
                  </span>
                  <span className="ml-auto text-xs tabular-nums text-gray-500">{fmtBRL(p.valor)}</span>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      </>}

      {liberando && (
        <ModalLiberarPendencia
          pendencia={liberando}
          onClose={() => setLiberando(null)}
          onLiberado={invalidar}
        />
      )}
      {acompanhando && (
        <ModalAcompanhar
          p={acompanhando}
          onClose={() => setAcompanhando(null)}
          onSalvo={invalidar}
        />
      )}
    </div>
  )
}

interface OvDoProduto {
  pendencia_id: string; ov_ref: string | null; cliente: string | null
  qtd: number; valor: number; coberta_agora: number; dias_parada: number
  posicao_fila: number | null; natureza?: string | null
}
interface ProdutoPendente {
  codigo: string; descricao: string | null
  qtd_pendente: number; valor_pendente: number
  qtd_coberta_agora: number; qtd_a_produzir: number
  disponivel: number | null; estoque_sa: number | null; cobre_com_sa: boolean
  dias_maior_espera: number; previsao_pcp: string | null
  qtd_ovs: number; qtd_clientes: number; ovs: OvDoProduto[]
}

/** O saldo virado do avesso: por produto, não por OV.
 *
 *  Responde a pergunta de quem produz e de quem prioriza — qual item segura
 *  mais dinheiro e quantos clientes esperam pela mesma coisa. Na visão por OV
 *  isso fica espalhado: o mesmo código aparece em cinco cartões e ninguém soma.
 *
 *  Os números vêm do MESMO rateio da outra aba (o servidor reaproveita `listar`),
 *  senão "dá para liberar" diria uma coisa aqui e outra lá. */
function PorProduto() {
  const [aberto, setAberto] = useState<string | null>(null)
  const { data, isLoading } = useQuery<{
    produtos: ProdutoPendente[]; total_valor: number; total_itens: number
    valor_coberto_agora: number
  }>({
    queryKey: ['pendencias-por-produto'],
    queryFn: () => api.get('/crm/pendencias/por-produto').then(r => r.data),
    staleTime: 30000,
  })

  const produtos = data?.produtos || []

  if (isLoading) return <p className="text-sm text-gray-400 py-8 text-center">Carregando…</p>
  if (!produtos.length) {
    return (
      <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-8 text-center">
        <CheckCircle2 size={28} className="mx-auto text-emerald-600 mb-2" />
        <p className="text-sm font-medium text-emerald-800">Nenhum item com saldo a entregar.</p>
      </div>
    )
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <Kpi rotulo="Itens com saldo" valor={String(data?.total_itens ?? 0)}
          detalhe="códigos distintos esperando" cor="text-gray-800" />
        <Kpi rotulo="Valor parado" valor={fmtBRL(data?.total_valor || 0)}
          detalhe="somando todas as OVs" cor="text-red-700" />
        <Kpi rotulo="Já coberto pelo estoque" valor={fmtBRL(data?.valor_coberto_agora || 0)}
          detalhe="dá para liberar sem esperar produção" cor="text-emerald-700" />
      </div>

      <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-[11px] uppercase text-gray-400 text-left bg-gray-50">
                <th className="py-2 px-3 font-medium">Item</th>
                <th className="py-2 px-2 font-medium text-right">Falta</th>
                <th className="py-2 px-2 font-medium text-right">Temos</th>
                <th className="py-2 px-2 font-medium text-right">A produzir</th>
                <th className="py-2 px-2 font-medium text-right">Valor parado</th>
                <th className="py-2 px-2 font-medium text-center">Esperando</th>
                <th className="py-2 px-2 font-medium text-right">Espera</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {produtos.map(pr => {
                const coberto = pr.qtd_a_produzir <= 0.001
                const expandido = aberto === pr.codigo
                return (
                  <Fragment key={pr.codigo}>
                    <tr
                      onClick={() => setAberto(expandido ? null : pr.codigo)}
                      className={`cursor-pointer hover:bg-gray-50 ${coberto ? 'bg-emerald-50/40' : ''}`}>
                      <td className="py-2 px-3">
                        <span className="font-mono font-medium text-gray-800">{pr.codigo}</span>
                        {pr.descricao && (
                          <span className="block text-[11px] text-gray-400 truncate max-w-[280px]">
                            {pr.descricao}
                          </span>
                        )}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-gray-700">{n(pr.qtd_pendente)}</td>
                      <td className={`py-2 px-2 text-right tabular-nums font-medium ${
                        pr.qtd_coberta_agora > 0 ? 'text-emerald-700' : 'text-gray-300'}`}>
                        {n(pr.qtd_coberta_agora)}
                      </td>
                      <td className={`py-2 px-2 text-right tabular-nums font-medium ${
                        coberto ? 'text-emerald-700' : 'text-red-600'}`}>
                        {coberto ? '—' : n(pr.qtd_a_produzir)}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums font-semibold text-gray-800">
                        {fmtBRL(pr.valor_pendente)}
                      </td>
                      <td className="py-2 px-2 text-center text-[11px] text-gray-600">
                        {pr.qtd_ovs} OV{pr.qtd_ovs > 1 ? 's' : ''}
                        <span className="text-gray-400"> · {pr.qtd_clientes} cliente{pr.qtd_clientes > 1 ? 's' : ''}</span>
                      </td>
                      <td className="py-2 px-2 text-right text-[11px] text-gray-500">
                        {pr.dias_maior_espera > 0 ? `${pr.dias_maior_espera}d` : 'hoje'}
                      </td>
                    </tr>
                    {expandido && (
                      <tr className="bg-gray-50/60">
                        <td colSpan={7} className="px-3 py-2">
                          <p className="text-[11px] text-gray-500 mb-1.5">
                            Quem espera por este item, na ordem da fila — o mesmo rateio que a aba
                            Por OV usa, então as duas contam a mesma verdade:
                          </p>
                          <div className="rounded-lg border border-gray-200 bg-white divide-y divide-gray-100">
                            {pr.ovs.map(o => (
                              <div key={o.pendencia_id + (o.ov_ref || '')}
                                className="flex items-center justify-between gap-3 px-3 py-1.5 text-xs">
                                <div className="min-w-0">
                                  <span className="font-mono text-indigo-700">{o.ov_ref || '—'}</span>
                                  <span className="text-gray-500 ml-2 truncate">{o.cliente || '—'}</span>
                                </div>
                                <div className="flex items-center gap-3 shrink-0 tabular-nums">
                                  <span className="text-gray-600">{n(o.qtd)} un</span>
                                  {o.coberta_agora > 0 && (
                                    <span className="text-emerald-700" title="Já reservado para esta OV pelo rateio">
                                      {n(o.coberta_agora)} pronta(s)
                                    </span>
                                  )}
                                  <span className="text-gray-400">{o.dias_parada}d</span>
                                </div>
                              </div>
                            ))}
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-gray-400">
        <strong>Temos</strong> é o que o rateio já separou para este item respeitando a fila —
        a mesma unidade não é prometida a duas OVs. <strong>A produzir</strong> é o que sobra
        para o PCP entregar de fato.
      </p>
    </div>
  )
}

function Kpi({ rotulo, valor, detalhe, cor }: {
  rotulo: string; valor: string; detalhe: string; cor: string
}) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm px-4 py-3">
      <p className="text-xs text-gray-400">{rotulo}</p>
      <p className={`text-lg font-bold tabular-nums ${cor}`}>{valor}</p>
      <p className="text-[11px] text-gray-400">{detalhe}</p>
    </div>
  )
}

/** Uma venda parada. Fechado mostra o essencial; aberto, item a item e o que já
 *  foi cobrado do PCP. */
type ProdutoBusca = { id: string; codigo: string; descricao: string }

/** Escolha do item que faltou no lançamento: produto do cadastro, quantidade e
 *  preço. O produto vem da busca e não do texto digitado — código e descrição
 *  são relidos do cadastro no servidor, então aqui só o id importa. */
function IncluirItemPendencia({ onIncluir, onCancelar, salvando }: {
  onIncluir: (item: { produto_id: string; qtd: number; valor_unitario: number }) => void
  onCancelar: () => void
  salvando: boolean
}) {
  const [busca, setBusca] = useState('')
  const [sel, setSel] = useState<ProdutoBusca | null>(null)
  const [qtd, setQtd] = useState('')
  const [valor, setValor] = useState('')

  const { data: produtos = [] } = useQuery<ProdutoBusca[]>({
    queryKey: ['produtos-busca', busca],
    queryFn: () => api.get('/produtos/busca', { params: { q: busca } }).then(r => r.data),
    enabled: busca.length >= 2 && !sel,
  })

  const qtdN = Number(String(qtd).replace(',', '.')) || 0
  const valorN = Number(String(valor).replace(',', '.')) || 0
  const pode = !!sel && qtdN > 0

  return (
    <div className="mt-2 p-2 rounded-lg border border-violet-200 bg-violet-50/50 space-y-2">
      {sel ? (
        <div className="flex items-center gap-2 text-xs">
          <span className="font-mono text-gray-700">{sel.codigo}</span>
          <span className="text-gray-500 truncate flex-1">{sel.descricao}</span>
          <button onClick={() => { setSel(null); setBusca('') }}
            className="text-[11px] text-violet-700 hover:underline">trocar</button>
        </div>
      ) : (
        <div className="relative">
          <input autoFocus value={busca} onChange={e => setBusca(e.target.value)}
            placeholder="Código ou descrição do item (2+ letras)"
            className="w-full px-2 py-1 text-xs border border-gray-200 rounded-md
                       focus:ring-1 focus:ring-violet-400 focus:border-violet-400" />
          {produtos.length > 0 && (
            <ul className="absolute z-20 mt-0.5 w-full max-h-40 overflow-auto bg-white
                           border border-gray-200 rounded-md shadow-lg">
              {produtos.slice(0, 8).map(pr => (
                <li key={pr.id}>
                  <button onClick={() => { setSel(pr); setBusca('') }}
                    className="w-full text-left px-2 py-1 text-xs hover:bg-violet-50">
                    <span className="font-mono text-gray-700">{pr.codigo}</span>
                    <span className="text-gray-500 ml-1.5">{pr.descricao}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      <div className="flex items-center gap-2">
        <input value={qtd} onChange={e => setQtd(e.target.value)} placeholder="Qtd"
          className="w-16 px-2 py-1 text-xs border border-gray-200 rounded-md text-right
                     focus:ring-1 focus:ring-violet-400 focus:border-violet-400" />
        <input value={valor} onChange={e => setValor(e.target.value)} placeholder="Valor un."
          className="w-24 px-2 py-1 text-xs border border-gray-200 rounded-md text-right
                     focus:ring-1 focus:ring-violet-400 focus:border-violet-400" />
        <span className="text-[11px] text-gray-500 flex-1">
          {pode ? fmtBRL(qtdN * valorN) : 'escolha o item e a quantidade'}
        </span>
        <button onClick={onCancelar}
          className="px-2 py-1 text-[11px] text-gray-500 hover:text-gray-700">cancelar</button>
        <button disabled={!pode || salvando}
          onClick={() => sel && onIncluir({ produto_id: sel.id, qtd: qtdN, valor_unitario: valorN })}
          className="px-2.5 py-1 rounded-md bg-violet-600 text-white text-[11px] font-medium
                     hover:bg-violet-700 disabled:opacity-40">
          {salvando ? 'incluindo...' : 'incluir'}
        </button>
      </div>
    </div>
  )
}


function Card({ p, onLiberar, onAcompanhar }: {
  p: Pendencia; onLiberar: () => void; onAcompanhar: () => void
}) {
  const [aberto, setAberto] = useState(false)
  const [ajustando, setAjustando] = useState<{ codigo: string; descricao?: string | null } | null>(null)
  const [incluindo, setIncluindo] = useState(false)
  // Remoção mexe no valor da venda, então pede dois cliques: o primeiro abre a
  // confirmação na própria linha, o segundo remove.
  const [confirmaRemover, setConfirmaRemover] = useState<string | null>(null)
  // Correção de quantidade e preço do item que já está na pendência. O comercial
  // manda planilha revisada todo mês, e preço é POR CLIENTE — corrigir aqui não
  // toca nenhum outro cliente.
  const [editando, setEditando] = useState<string | null>(null)
  const [edit, setEdit] = useState<{ qtd: string; vu: string }>({ qtd: '', vu: '' })
  const qcCard = useQueryClient()

  const ajustarItens = useMutation({
    mutationFn: (corpo: any) =>
      api.post(`/crm/pendencias/${p.fonte}/${p.id}/itens`, corpo).then(r => r.data),
    onSuccess: (_d, corpo: any) => {
      toast.success(corpo?.remover?.length ? 'Item removido da venda.'
        : corpo?.atualizar?.length ? 'Item corrigido.' : 'Item incluído na venda.')
      setIncluindo(false)
      setConfirmaRemover(null)
      setEditando(null)
      qcCard.invalidateQueries({ queryKey: ['crm-pendencias'] })
      qcCard.invalidateQueries({ queryKey: ['crm-opps'] })
      qcCard.invalidateQueries({ queryKey: ['pedidos'] })
      qcCard.invalidateQueries({ queryKey: ['home-pendencias'] })
    },
    onError: (e: any) => toast.error(msgErro(e, 'Não foi possível ajustar os itens.'), { duration: 7000 }),
  })
  const dias = p.dias_parada || 0
  const corDias = dias >= DIAS_CRITICO ? 'text-red-600 font-semibold'
    : dias >= DIAS_ATENCAO ? 'text-amber-700' : 'text-gray-500'
  const acomp = p.acompanhamentos || []
  // Previsão furada é a informação mais útil da tela: a data prometida já passou
  // e o material não chegou.
  const atrasada = !!p.previsao_pcp && String(p.previsao_pcp).slice(0, 10) < hojeLocal()

  return (
    <div className="bg-white rounded-lg border border-gray-200">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
        <button onClick={() => setAberto(a => !a)}
          className="text-gray-400 hover:text-gray-600 shrink-0" title="Ver os itens">
          {aberto ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-800 truncate">{p.cliente || '—'}</span>
            {p.canal && (
              <span className="text-[11px] text-gray-400">{LINHA_DO_CANAL[p.canal] || p.canal}</span>
            )}
            {p.prioridade_fila != null && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-indigo-100 text-indigo-700 font-medium"
                title={`Posição escolhida à mão${p.prioridade_por_nome ? ` por ${p.prioridade_por_nome}` : ''}`}>
                {p.posicao_fila}º na fila · à mão
              </span>
            )}
            {p.decisao === 'AGUARDAR' ? (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600"
                title="O comercial escolheu esperar a produção: nada desceu para a expedição">
                sem OV aberta
              </span>
            ) : p.ov_provisoria ? (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700"
                title="A OV existe no app, mas ainda não tem o número do D365">
                sem nº D365
              </span>
            ) : p.ov_ref ? (
              <Link to={p.ov_id ? `/expedicao/${p.ov_id}` : '#'}
                className="font-mono text-xs text-indigo-700 hover:underline">{p.ov_ref}</Link>
            ) : null}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5">
            <span className="text-[11px] text-gray-400 truncate">{p.titulo}</span>
            {/* Saldo que existe fisicamente e foi solto de propósito não se
                cobra do PCP — sem isto o operador cobra produção de material
                que está na prateleira. */}
            {p.natureza === 'LIBERADO' && (
              <span className="text-[11px] px-1.5 py-0.5 rounded bg-sky-50 text-sky-700 shrink-0"
                title="O material existe: alguém escolheu não prendê-lo nesta OV. Não depende da produção — dá para liberar assim que quiser.">
                material existe
              </span>
            )}
          </div>
        </div>

        <div className="text-xs text-gray-500 whitespace-nowrap">
          {(p.itens || []).length} item(ns) · {Number(p.qtd_total) || 0} un
        </div>

        <div className="text-xs whitespace-nowrap">
          {p.previsao_pcp ? (
            <span className={atrasada ? 'text-red-600 font-medium' : 'text-gray-600'}
              title={atrasada ? 'A data prometida pelo PCP já passou' : 'Previsão informada pelo PCP'}>
              <CalendarClock size={12} className="inline mr-1 -mt-0.5" />
              PCP {dataBR(p.previsao_pcp)}{atrasada && ' (venceu)'}
            </span>
          ) : p.cobre_com_sa && p.previsao_sa ? (
            <span className="text-gray-500" title="Há semiacabado que cobre a falta">
              SA ~{dataBR(p.previsao_sa)}
            </span>
          ) : (
            <span className="text-gray-300">sem previsão</span>
          )}
        </div>

        <div className={`text-xs whitespace-nowrap tabular-nums ${corDias}`}
          title="Dias desde a decisão de estoque">
          <Clock size={12} className="inline mr-1 -mt-0.5" />{dias}d
        </div>

        <div className="text-sm font-semibold text-red-700 tabular-nums w-28 text-right">
          {fmtBRL(p.valor)}
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          <button onClick={onAcompanhar}
            className="text-[11px] font-medium px-2 py-1 rounded-lg border text-gray-600 hover:bg-gray-50 whitespace-nowrap"
            title="Anotar o que o PCP respondeu e para quando">
            <Send size={11} className="inline mr-1 -mt-0.5" />
            Cobrar{acomp.length > 0 && ` (${acomp.length})`}
          </button>
          <button onClick={onLiberar} disabled={!p.pode_liberar}
            title={p.motivo_bloqueio || undefined}
            className={`text-[11px] font-medium px-2 py-1 rounded-lg text-white disabled:bg-gray-100 disabled:text-gray-400 whitespace-nowrap ${
              p.estoque_agora?.status === 'NENHUM'
                ? 'bg-gray-400 hover:bg-gray-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}>
            {p.pode_liberar ? 'Liberar' : 'Bloqueada'}
          </button>
        </div>
      </div>

      {p.motivo_bloqueio && (
        <p className="px-3 pb-2 text-[11px] text-red-700">{p.motivo_bloqueio}</p>
      )}

      {aberto && (
        <div className="border-t border-gray-100 px-3 py-2.5 space-y-3">
          <div>
            <p className="text-[11px] uppercase text-gray-400 font-medium mb-1">
              {p.nada_entregue
                ? 'A venda inteira está parada — nada desceu para a expedição'
                : 'O que falta desta venda'}
            </p>
            <table className="w-full text-xs">
              <thead>
                <tr className="text-gray-400 text-left">
                  <th className="font-medium py-1">Item</th>
                  <th className="font-medium py-1 text-right">Pedido</th>
                  <th className="font-medium py-1 text-right">Já entregue</th>
                  <th className="font-medium py-1 text-right">Falta</th>
                  <th className="font-medium py-1 text-right">Em estoque hoje</th>
                  <th className="font-medium py-1 text-right">Valor un.</th>
                  <th className="font-medium py-1 text-right">Valor</th>
                  <th className="w-5" />
                </tr>
              </thead>
              <tbody>
                {(p.itens || []).map((i, idx) => {
                  const agora = (p.estoque_agora?.itens || [])
                    .find(x => (x.codigo || '') === (i.codigo || ''))
                  const temTudo = agora && agora.qtd_atendida >= (i.qtd_pendente || 0) - 0.001
                  // O caso que parecia bug: a tela de Estoque mostra 12, aqui dá 0.
                  // O estoque existe, mas a fila levou — quem está na frente é o
                  // que fecha a conta.
                  const naFila = (agora?.reservado_para || [])
                  return (
                    <tr key={idx} className="border-t border-gray-50 align-top">
                      <td className="py-1 pr-2">
                        <span className="font-mono text-gray-700">{i.codigo || '—'}</span>
                        <span className="text-gray-400 ml-1.5">{i.descricao}</span>
                        {naFila.length > 0 && (
                          <span className="block text-[11px] text-amber-700">
                            {agora?.disponivel} un existem, reservadas para{' '}
                            {naFila.map(d => `${d.ov || d.cliente || 'outra venda'} (${d.qtd})`).join(', ')}
                            {' '}— espera desde antes desta
                          </span>
                        )}
                      </td>
                      <td className="py-1 text-right tabular-nums text-gray-400">
                        {n(i.qtd_pedida)}
                      </td>
                      <td className="py-1 text-right tabular-nums">
                        {Number(i.qtd_atendida) > 0 ? (
                          <span className="text-emerald-700">{n(i.qtd_atendida)}</span>
                        ) : (
                          <span className="text-gray-300">—</span>
                        )}
                      </td>
                      <td className="py-1 text-right tabular-nums text-gray-700 font-medium">
                        {editando === i.produto_id ? (
                          <input autoFocus value={edit.qtd}
                            onChange={e => setEdit({ ...edit, qtd: e.target.value })}
                            className="w-16 px-1 py-0.5 border border-violet-300 rounded text-right
                                       text-xs focus:ring-1 focus:ring-violet-400" />
                        ) : n(i.qtd_pendente)}
                      </td>
                      <td className="py-1 text-right tabular-nums whitespace-nowrap">
                        {!agora ? (
                          <span className="text-gray-300">—</span>
                        ) : temTudo ? (
                          <span className="text-emerald-700 font-medium">✓ {agora.qtd_atendida}</span>
                        ) : agora.qtd_atendida > 0 ? (
                          <span className="text-amber-700">{agora.qtd_atendida}</span>
                        ) : (
                          <span className="text-gray-400">0</span>
                        )}
                        {i.codigo && (
                          <button onClick={() => setAjustando({ codigo: i.codigo!, descricao: i.descricao })}
                            title="O estoque na prateleira está diferente? Corrija aqui para destravar a OV"
                            className="ml-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md
                                       border border-violet-200 text-[10px] font-medium text-violet-700
                                       bg-violet-50 hover:bg-violet-100 hover:border-violet-300 align-middle">
                            <PencilLine size={10} /> corrigir
                          </button>
                        )}
                      </td>
                      <td className="py-1 text-right tabular-nums text-gray-500">
                        {editando === i.produto_id ? (
                          <input value={edit.vu}
                            onChange={e => setEdit({ ...edit, vu: e.target.value })}
                            className="w-20 px-1 py-0.5 border border-violet-300 rounded text-right
                                       text-xs focus:ring-1 focus:ring-violet-400" />
                        ) : fmtBRL(i.valor_unitario)}
                      </td>
                      <td className="py-1 text-right tabular-nums text-gray-600">
                        {fmtBRL(i.valor_pendente)}
                      </td>
                      <td className="py-1 pl-1 text-right whitespace-nowrap">
                        {editando === i.produto_id ? (
                          <span className="inline-flex items-center gap-1">
                            <button
                              disabled={ajustarItens.isPending}
                              title="Salvar a correção"
                              onClick={() => {
                                const q = Number(String(edit.qtd).replace(',', '.'))
                                const v = Number(String(edit.vu).replace(',', '.'))
                                if (!(q > 0)) { toast.error('Quantidade tem de ser maior que zero — para zerar, remova o item.'); return }
                                if (!(v >= 0)) { toast.error('Preço inválido.'); return }
                                ajustarItens.mutate({ atualizar: [{ produto_id: i.produto_id, qtd: q, valor_unitario: v }] })
                              }}
                              className="p-0.5 rounded text-emerald-600 hover:bg-emerald-50 disabled:opacity-40">
                              <Check size={13} />
                            </button>
                            <button onClick={() => setEditando(null)}
                              className="p-0.5 rounded text-gray-400 hover:text-gray-600">
                              <X size={12} />
                            </button>
                          </span>
                        ) : confirmaRemover === i.produto_id ? (
                          <span className="inline-flex items-center gap-1">
                            <button
                              disabled={ajustarItens.isPending}
                              onClick={() => ajustarItens.mutate({ remover: [i.produto_id] })}
                              className="px-1.5 py-0.5 rounded-md bg-red-600 text-white text-[10px]
                                         font-medium hover:bg-red-700 disabled:opacity-50">
                              remover
                            </button>
                            <button onClick={() => setConfirmaRemover(null)}
                              className="px-1 py-0.5 text-[10px] text-gray-500 hover:text-gray-700">
                              não
                            </button>
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-0.5">
                            <button
                              onClick={() => {
                                setConfirmaRemover(null)
                                setEditando(i.produto_id || null)
                                setEdit({ qtd: String(Number(i.qtd_pendente) || 0),
                                          vu: String(Number(i.valor_unitario) || 0) })
                              }}
                              title="Corrigir a quantidade que falta ou o preço deste item"
                              className="p-0.5 rounded text-gray-300 hover:text-violet-700 hover:bg-violet-50">
                              <PencilLine size={12} />
                            </button>
                            <button
                              onClick={() => { setEditando(null); setConfirmaRemover(i.produto_id || null) }}
                              title="Tirar este item da venda — o valor da venda diminui"
                              className="p-0.5 rounded text-gray-300 hover:text-red-600 hover:bg-red-50">
                              <Trash2 size={12} />
                            </button>
                          </span>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            <p className="text-[11px] text-gray-400 mt-1">
              "Em estoque hoje" é o que sobrou para ESTA venda depois da fila: quando
              duas vendas querem o mesmo item, quem espera há mais tempo recebe primeiro.
              O botão <strong>corrigir</strong> ajusta o estoque quando a prateleira não bate
              com a foto do PCP — vale só para hoje.
            </p>

            {incluindo ? (
              <IncluirItemPendencia
                onCancelar={() => setIncluindo(false)}
                salvando={ajustarItens.isPending}
                onIncluir={(item) => ajustarItens.mutate({ adicionar: [item] })} />
            ) : (
              <button onClick={() => setIncluindo(true)}
                className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium
                           text-violet-700 hover:text-violet-900">
                <Plus size={12} /> incluir item que faltou nesta venda
              </button>
            )}
            <p className="text-[11px] text-gray-400 mt-1">
              Incluir ou remover item aqui muda a <strong>venda</strong>: o valor
              acompanha os itens. Item que já teve entrega parcial não sai por aqui —
              nesse caso a correção é na OV. O lápis corrige a quantidade que falta e
              o preço; <strong>preço é por cliente</strong>, então a correção vale só
              para esta venda.
            </p>
          </div>

          <div>
            <p className="text-[11px] uppercase text-gray-400 font-medium mb-1">
              Cobranças ao PCP
            </p>
            {acomp.length === 0 ? (
              <p className="text-xs text-gray-400">
                Ninguém anotou nada ainda.
                {p.observacao && <> Observação da decisão: <em>{p.observacao}</em></>}
              </p>
            ) : (
              <ol className="space-y-1">
                {acomp.slice().reverse().map((a, idx) => (
                  <li key={idx} className="text-xs text-gray-600 flex gap-2">
                    <span className="text-gray-400 whitespace-nowrap tabular-nums">
                      {dataBR(a.em)}
                    </span>
                    <span className="min-w-0">
                      {a.observacao}
                      {a.previsao_pcp && (
                        <span className="text-gray-500">
                          {a.observacao ? ' · ' : ''}
                          previsão {dataBR(a.previsao_pcp)}
                          {a.previsao_anterior && (
                            <span className="text-red-600"> (era {dataBR(a.previsao_anterior)})</span>
                          )}
                        </span>
                      )}
                      {a.por_nome && <span className="text-gray-400"> — {a.por_nome}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      )}

      {ajustando && (
        <ModalAjusteEstoque codigo={ajustando.codigo} descricao={ajustando.descricao}
          onClose={() => setAjustando(null)} />
      )}
    </div>
  )
}

/** Anota o que o PCP respondeu. Não libera nada — só registra o que se sabe da
 *  espera, para a próxima pessoa não cobrar de novo o que já tem resposta. */
function ModalAcompanhar({ p, onClose, onSalvo }: {
  p: Pendencia; onClose: () => void; onSalvo: () => void
}) {
  const [previsao, setPrevisao] = useState(String(p.previsao_pcp || '').slice(0, 10))
  const [nota, setNota] = useState('')
  const [limpar, setLimpar] = useState(false)
  const acomp = p.acompanhamentos || []

  const salvar = useMutation({
    mutationFn: () => api.patch(`/crm/pendencias/${p.fonte}/${p.id}`, {
      previsao_pcp: limpar ? null : (previsao || null),
      observacao: nota.trim() || null,
      limpar_previsao: limpar,
    }).then(r => r.data),
    onSuccess: () => {
      toast.success('Cobrança registrada.')
      onSalvo()
      onClose()
    },
    onError: (e: any) => toast.error(msgErro(e, 'Não foi possível registrar.')),
  })

  const podeSalvar = !!nota.trim() || (!limpar && previsao !== String(p.previsao_pcp || '').slice(0, 10)) || limpar

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="p-5 border-b flex items-start justify-between gap-3">
          <div>
            <h2 className="text-lg font-bold">Cobrar o PCP</h2>
            <p className="text-xs text-gray-400 mt-0.5">
              {p.cliente} · {p.ov_ref || 'sem OV'} · {fmtBRL(p.valor)} parado há {p.dias_parada || 0} dia(s)
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><X size={18} /></button>
        </div>

        <div className="p-5 space-y-4 overflow-auto">
          <p className="text-xs text-gray-500">
            O que ficar aqui aparece para quem abrir esta pendência depois — inclusive
            para você, na semana que vem. Não libera material: para isso, o botão Liberar.
          </p>

          <div>
            <label className="text-sm font-medium text-gray-700">Previsão do PCP</label>
            <div className="flex items-center gap-2 mt-1">
              <input type="date" value={previsao} disabled={limpar}
                onChange={e => setPrevisao(e.target.value)}
                className="border rounded-lg px-3 py-2 text-sm disabled:bg-gray-50 disabled:text-gray-400" />
              {p.previsao_pcp && (
                <label className="flex items-center gap-1.5 text-xs text-gray-500">
                  <input type="checkbox" checked={limpar} onChange={e => setLimpar(e.target.checked)} />
                  não tem data
                </label>
              )}
            </div>
            {p.previsao_pcp && !limpar && previsao !== String(p.previsao_pcp).slice(0, 10) && (
              <p className="text-[11px] text-amber-700 mt-1">
                A data anterior ({dataBR(p.previsao_pcp)}) fica registrada no histórico.
              </p>
            )}
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">O que responderam</label>
            <textarea value={nota} onChange={e => setNota(e.target.value)} rows={3}
              placeholder="Ex.: PCP confirmou que a extrusão entra na semana do dia 25."
              className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
          </div>

          {acomp.length > 0 && (
            <div>
              <p className="text-[11px] uppercase text-gray-400 font-medium mb-1">
                {acomp.length} cobrança(s) antes desta
              </p>
              <ol className="space-y-1 max-h-40 overflow-auto">
                {acomp.slice().reverse().map((a, idx) => (
                  <li key={idx} className="text-xs text-gray-600">
                    <span className="text-gray-400 tabular-nums mr-1.5">{dataBR(a.em)}</span>
                    {a.observacao}
                    {a.previsao_pcp && <span className="text-gray-500"> · previsão {dataBR(a.previsao_pcp)}</span>}
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        <div className="p-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">
            Cancelar
          </button>
          <button onClick={() => salvar.mutate()} disabled={!podeSalvar || salvar.isPending}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
            {salvar.isPending ? 'Registrando…' : 'Registrar cobrança'}
          </button>
        </div>
      </div>
    </div>
  )
}

/** A fila do material: quem recebe primeiro quando o estoque não dá para todos.
 *
 *  Precisa ser uma lista única, e não botões dentro de cada grupo da tela: o
 *  rateio é global (uma unidade vai para UMA venda), então a ordem só faz sentido
 *  vista de ponta a ponta.
 *
 *  O padrão é tempo de espera — regra que funciona sem ninguém e não gera
 *  discussão. A prioridade manual existe para o que o padrão não sabe: multa por
 *  atraso, o pedido que fecha o mês, o cliente que avisou que pode esperar.
 */
function PainelFila({ abertas, priorizadas, onMudou }: {
  abertas: Pendencia[]; priorizadas: number; onMudou: () => void
}) {
  // Ordem local para o operador arrumar tudo e salvar uma vez — cada clique
  // gravando geraria uma linha de histórico por clique em cada OV mexida.
  const [ordem, setOrdem] = useState<Pendencia[] | null>(null)
  const daTela = useMemo(
    () => abertas.slice().sort((a, b) => (a.posicao_fila || 0) - (b.posicao_fila || 0)),
    [abertas])
  const lista = ordem ?? daTela
  const mexeu = ordem !== null &&
    ordem.map(p => `${p.fonte}${p.id}`).join('|') !== daTela.map(p => `${p.fonte}${p.id}`).join('|')

  const mover = (de: number, para: number) => {
    if (para < 0 || para >= lista.length) return
    const nova = lista.slice()
    const [item] = nova.splice(de, 1)
    nova.splice(para, 0, item)
    setOrdem(nova)
  }

  const salvar = useMutation({
    mutationFn: () => api.post('/crm/pendencias/ordem', {
      ordem: lista.map(p => ({ fonte: p.fonte, id: p.id })),
    }).then(r => r.data),
    onSuccess: (r: any) => {
      toast.success(`Fila salva — ${r?.alterados?.length || 0} pendência(s) mudaram de posição.`)
      setOrdem(null)
      onMudou()
    },
    onError: (e: any) => toast.error(msgErro(e, 'Não foi possível salvar a fila.')),
  })

  const automatica = useMutation({
    mutationFn: () => api.post('/crm/pendencias/ordem/automatica').then(r => r.data),
    onSuccess: () => {
      toast.success('Fila de volta ao automático: quem espera há mais tempo primeiro.')
      setOrdem(null)
      onMudou()
    },
    onError: (e: any) => toast.error(msgErro(e, 'Não foi possível voltar ao automático.')),
  })

  return (
    <section className="rounded-xl border border-indigo-200 bg-indigo-50/40 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2 mb-1">
        <h2 className="text-sm font-semibold text-indigo-800 flex items-center gap-1.5">
          <ListOrdered size={16} /> Ordem da fila de material
        </h2>
        <div className="flex items-center gap-2">
          {priorizadas > 0 && (
            <button onClick={() => automatica.mutate()} disabled={automatica.isPending}
              title="Apaga todas as prioridades manuais e volta ao critério de tempo de espera"
              className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-gray-300 text-gray-600 hover:bg-white disabled:opacity-50">
              <RotateCcw size={12} /> Voltar ao automático
            </button>
          )}
          {mexeu && (
            <button onClick={() => salvar.mutate()} disabled={salvar.isPending}
              className="text-xs px-3 py-1 rounded-lg bg-indigo-600 hover:bg-indigo-500 text-white font-medium disabled:opacity-50">
              {salvar.isPending ? 'Salvando…' : 'Salvar esta ordem'}
            </button>
          )}
        </div>
      </div>
      <p className="text-xs text-gray-600 mb-3">
        Quando duas vendas querem o mesmo item e o material não dá para as duas, quem
        está mais alto recebe primeiro. Sem prioridade manual, a ordem é por tempo de
        espera — e salvar <strong>fixa a fila inteira</strong> como está aqui, até alguém
        voltar ao automático.
        {mexeu && <strong className="text-indigo-700"> Você mexeu na ordem — salve para valer.</strong>}
      </p>

      <ol className="space-y-1">
        {lista.map((p, idx) => (
          <li key={`${p.fonte}-${p.id}`}
            className="flex items-center gap-2 bg-white rounded-lg border border-gray-200 px-2.5 py-1.5">
            <span className="w-6 text-xs font-semibold text-gray-500 tabular-nums text-right">
              {idx + 1}º
            </span>
            <div className="min-w-0 flex-1">
              <span className="text-sm font-medium text-gray-800 truncate">{p.cliente || '—'}</span>
              {p.ov_ref && <span className="font-mono text-[11px] text-gray-500 ml-1.5">{p.ov_ref}</span>}
              <span className="block text-[11px] text-gray-400">
                {(p.itens || []).map(i => i.codigo).filter(Boolean).join(', ') || '—'}
                {' · '}esperando há {p.dias_parada || 0} dia(s)
                {p.prioridade_fila != null && p.prioridade_por_nome && (
                  <span className="text-indigo-600"> · posicionada por {p.prioridade_por_nome}</span>
                )}
              </span>
            </div>
            <span className="text-xs tabular-nums text-red-700 font-medium">{fmtBRL(p.valor)}</span>
            <span className="flex items-center gap-0.5">
              <button onClick={() => mover(idx, 0)} disabled={idx === 0}
                title="Mandar para o topo da fila"
                className="p-1 rounded text-gray-400 hover:text-indigo-700 hover:bg-indigo-50 disabled:opacity-20">
                <ChevronsUp size={14} />
              </button>
              <button onClick={() => mover(idx, idx - 1)} disabled={idx === 0}
                title="Subir uma posição"
                className="p-1 rounded text-gray-400 hover:text-indigo-700 hover:bg-indigo-50 disabled:opacity-20">
                <ArrowUp size={14} />
              </button>
              <button onClick={() => mover(idx, idx + 1)} disabled={idx === lista.length - 1}
                title="Descer uma posição"
                className="p-1 rounded text-gray-400 hover:text-indigo-700 hover:bg-indigo-50 disabled:opacity-20">
                <ArrowDown size={14} />
              </button>
            </span>
          </li>
        ))}
      </ol>

      {lista.length < 2 && (
        <p className="text-xs text-gray-400 mt-2">
          Com uma pendência só não há fila para ordenar.
        </p>
      )}
    </section>
  )
}

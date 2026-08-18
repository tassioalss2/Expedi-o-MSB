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
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import { format } from 'date-fns'
import {
  AlertTriangle, CalendarClock, CheckCircle2, ChevronDown, ChevronRight,
  Clock, History, PackageCheck, PackageX, PencilLine, Search, Send, X,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'
import { fmtBRL, msgErro, type Pendencia, type PendenciasResp } from '../lib/crm'
import { ModalLiberarPendencia } from '../components/EstoqueVenda'
import { ModalAjusteEstoque } from '../components/AjusteEstoque'
import { LINHA_DO_CANAL } from '../lib/statusConfig'
import { hojeLocal } from '../lib/dataLocal'

/** Dias parada a partir dos quais a espera deixa de ser normal. */
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

  const todas = data?.pendencias || []

  const { abertas, resolvidas } = useMemo(() => {
    const b = busca.trim().toLowerCase()
    const passa = (p: Pendencia) => {
      if (linha && LINHA_DO_CANAL[p.canal || ''] !== LINHA_DO_CANAL[linha]) return false
      if (!b) return true
      const itens = (p.itens || []).map(i => `${i.codigo || ''} ${i.descricao || ''}`).join(' ')
      return `${p.cliente || ''} ${p.titulo || ''} ${p.ov_ref || ''} ${itens}`
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
          Venda fechada esperando material. Organizado pelo que dá para fazer agora.
        </p>
      </div>

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
        <button onClick={() => setVerHistorico(v => !v)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border ${verHistorico
            ? 'bg-gray-800 text-white border-gray-800' : 'text-gray-600 hover:bg-gray-50'}`}>
          <History size={14} /> Já resolvidas
        </button>
      </div>

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
function Card({ p, onLiberar, onAcompanhar }: {
  p: Pendencia; onLiberar: () => void; onAcompanhar: () => void
}) {
  const [aberto, setAberto] = useState(false)
  const [ajustando, setAjustando] = useState<{ codigo: string; descricao?: string | null } | null>(null)
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
          <p className="text-[11px] text-gray-400 truncate">{p.titulo}</p>
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
                  <th className="font-medium py-1 text-right">Falta</th>
                  <th className="font-medium py-1 text-right">Em estoque hoje</th>
                  <th className="font-medium py-1 text-right">Valor</th>
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
                      <td className="py-1 text-right tabular-nums text-gray-700">
                        {Number(i.qtd_pendente) || 0}
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
                      <td className="py-1 text-right tabular-nums text-gray-600">
                        {fmtBRL(i.valor_pendente)}
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

import { useState, useRef } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Upload, FileSpreadsheet, CheckCircle2, ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import toast from 'react-hot-toast'
import api from '../lib/api'
import { hojeLocal } from '../lib/dataLocal'

/** Conciliação do faturamento: o que o D365 emitiu × o que o app registrou.
 *
 *  Existe porque o faturamento do app é derivado da operação — uma OV do kanban
 *  recebe NF e vira faturamento. Isso só fecha enquanto tudo o que a MSB fatura
 *  passa pela nossa operação. Com a licitação indo para a Bio, o comunicado de
 *  uso sai por quem não usa o app: a nota continua sendo da MSB, e o número que
 *  o app mostra fica curto. Aqui o faturamento passa a ser o que o D365 emitiu.
 */

const fmtBRL = (v?: number | null) =>
  (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

const dataBR = (iso?: string | null) =>
  iso ? new Date(String(iso).slice(0, 10) + 'T12:00:00').toLocaleDateString('pt-BR') : '—'

const TIPO_LABEL: Record<string, string> = {
  VENDA_NORMAL: 'Venda',
  COMUNICADO_USO: 'Comunicado de uso',
  EXPORTACAO: 'Exportação',
  DEVOLUCAO: 'Devolução',
  REMESSA: 'Remessa',
  BONIFICACAO: 'Bonificação',
  AMOSTRA: 'Amostra',
  'A CLASSIFICAR': 'A classificar',
}

type Conciliacao = {
  periodo: { ini: string; fim: string }
  d365: { qtd: number; valor: number }
  app: { qtd: number; valor: number }
  diferenca: number
  casam: number
  sem_espelho: boolean
  so_d365: Array<{ id: string; nf: string; data: string | null; cliente: string | null
                   valor: number; operacao: string | null; tipo_operacao: string | null
                   origem_venda: string | null; linha: string | null; linha_ajustada?: boolean }>
  so_app: Array<{ nf: string | null; ov: string | null; pedido_id: string; data: string
                  valor: number; cliente: string | null }>
  divergentes: Array<{ nf: string; ov: string | null; pedido_id: string
                       valor_app: number; valor_d365: number
                       data_app: string; data_d365: string; cliente: string | null }>
  por_tipo: Array<{ tipo: string; qtd: number; valor: number }>
  por_origem: Array<{ chave: string; qtd: number; valor: number }>
  transfer: {
    d365_qtd: number; d365_valor: number; app_qtd: number; app_valor: number
    notas: Array<{ id: string; nf: string; data: string | null; cliente: string | null
                   valor: number; no_app: boolean }>
  }
  linha_sem_ov: Array<{ chave: string; qtd: number; valor: number }>
}

/** Competência corrente, no formato AAAA-MM. */
function mesCorrente() {
  return hojeLocal().slice(0, 7)
}

export default function FaturamentoD365() {
  const [competencia, setCompetencia] = useState(mesCorrente())
  const arquivoRef = useRef<HTMLInputElement>(null)

  const { data, isLoading, refetch } = useQuery<Conciliacao>({
    queryKey: ['notas-d365', competencia],
    queryFn: () => api.get(`/notas-d365/competencia/${competencia}`).then(r => r.data),
  })

  const importar = useMutation({
    mutationFn: (arquivo: File) => {
      const fd = new FormData()
      fd.append('arquivo', arquivo)
      return api.post('/notas-d365/importar', fd,
        { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
    },
    onSuccess: (r: any) => {
      if (r?.erro) { toast.error(r.erro, { duration: 9000 }); return }
      toast.success(
        `${r.importadas} nota(s) importada(s) — ${dataBR(r.periodo_ini)} a ${dataBR(r.periodo_fim)}.`,
        { duration: 7000 })
      if (r.operacoes_sem_classificacao?.length) {
        toast(`${r.operacoes_sem_classificacao.length} operação(ões) do D365 que eu não sei `
          + 'classificar — me diga o que são e eu ensino o app.', { duration: 11000, icon: '⚠️' })
      }
      refetch()
    },
    onError: (e: any) => toast.error(
      e?.response?.data?.detail || 'Não consegui importar o arquivo.', { duration: 8000 }),
  })

  const corrigirLinha = useMutation({
    mutationFn: ({ id, linha }: { id: string; linha: string }) =>
      api.patch(`/notas-d365/${id}/linha`, { linha: linha || null }).then(r => r.data),
    onSuccess: () => { toast.success('Linha corrigida nesta nota.'); refetch() },
    onError: () => toast.error('Não consegui corrigir a linha.'),
  })

  const dif = data?.diferenca || 0

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-800">Faturamento conferido (D365)</h1>
          <p className="text-sm text-gray-500 max-w-3xl">
            O que o D365 emitiu no mês, ao lado do que o app registrou. Nota que saiu pela MSB
            mas não passou pela nossa operação — comunicado de uso da licitação, por exemplo —
            aparece aqui como diferença, e é essa a conta que vale.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input type="month" value={competencia} onChange={e => setCompetencia(e.target.value)}
            className="border rounded-lg px-3 py-2 text-sm" />
          <input ref={arquivoRef} type="file" accept=".xlsx,.xls,.csv" className="hidden"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) importar.mutate(f)
              e.target.value = ''
            }} />
          <button onClick={() => arquivoRef.current?.click()} disabled={importar.isPending}
            className="flex items-center gap-1.5 px-4 py-2 text-sm bg-indigo-600 hover:bg-indigo-500
                       disabled:opacity-50 text-white font-medium rounded-lg">
            <Upload size={15} /> {importar.isPending ? 'Importando…' : 'Importar export do D365'}
          </button>
        </div>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-400 py-8 text-center">Carregando…</p>
      ) : data?.sem_espelho ? (
        <div className="bg-white border border-gray-200 rounded-xl px-4 py-10 text-center">
          <FileSpreadsheet size={28} className="mx-auto text-gray-300 mb-2" />
          <p className="text-sm font-medium text-gray-700">
            Nenhuma nota do D365 importada neste mês.
          </p>
          <p className="text-xs text-gray-500 mt-1 max-w-md mx-auto">
            Exporte as notas fiscais do mês no D365 (a lista de NFs, com Número, Data do
            documento, Conta, Valor total e Descrição da operação) e suba o arquivo aqui.
            Reimportar o mesmo período não duplica nada.
          </p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Cartao rotulo="Faturado no D365" valor={fmtBRL(data?.d365.valor)}
              detalhe={`${data?.d365.qtd} nota(s) de saída`} cor="text-gray-900" />
            <Cartao rotulo="Registrado no app" valor={fmtBRL(data?.app.valor)}
              detalhe={`${data?.app.qtd} OV(s) faturada(s) · ${data?.casam} casam`}
              cor="text-gray-700" />
            <Cartao
              rotulo={dif >= 0 ? 'Faturamento que o app não vê' : 'App acima do D365'}
              valor={fmtBRL(Math.abs(dif))}
              detalhe={dif === 0 ? 'as duas pontas batem'
                : `${data?.so_d365.length} nota(s) fora do app`}
              cor={Math.abs(dif) < 0.01 ? 'text-emerald-700' : 'text-amber-700'} />
          </div>

          {!!data?.por_tipo?.length && (
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-2">
                O que o D365 emitiu, por natureza
              </p>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {data.por_tipo.map(t => (
                  <div key={t.tipo}>
                    <p className="text-sm font-semibold text-gray-800 tabular-nums">
                      {fmtBRL(t.valor)}
                    </p>
                    <p className="text-[11px] text-gray-500">
                      {TIPO_LABEL[t.tipo] || t.tipo} · {t.qtd} NF(s)
                    </p>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Transfer price (Biomedical) sai das duas pontas ao mesmo tempo: se
              saísse só de uma, a diferença entre D365 e app passaria a ser o
              próprio transfer price. Fica aqui, inteiro, e fora da conta. */}
          {!!data?.transfer?.d365_qtd && (
            <div className="rounded-xl border border-slate-300 bg-slate-50 px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-sm font-semibold text-slate-800">
                  Fora da conta: transfer price (Biomedical)
                </p>
                <p className="text-sm font-semibold tabular-nums text-slate-600">
                  {fmtBRL(data.transfer.d365_valor)} · {data.transfer.d365_qtd} NF(s)
                </p>
              </div>
              <p className="text-[11px] text-slate-600 mt-0.5">
                Repasse dentro do grupo, não receita da MSB — não entra em nenhum número acima.
                No app estão {data.transfer.app_qtd} dessas notas ({fmtBRL(data.transfer.app_valor)}).
              </p>
              <p className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-700">
                {data.transfer.notas.map(n => (
                  <span key={n.id}>
                    <span className="font-mono font-medium">{n.nf}</span>{' '}
                    {dataBR(n.data)} · {fmtBRL(n.valor)}
                    {!n.no_app && <span className="text-amber-700"> · fora do app</span>}
                  </span>
                ))}
              </p>
            </div>
          )}

          {!!data?.por_origem?.length && (
            <div className="bg-white border border-gray-200 rounded-xl p-4">
              <p className="text-xs font-semibold text-gray-500 uppercase mb-2">
                Licitação × comercial, pela própria operação fiscal
              </p>
              <div className="flex flex-wrap gap-x-6 gap-y-2">
                {data.por_origem.map(o => (
                  <div key={o.chave}>
                    <p className="text-sm font-semibold text-gray-800 tabular-nums">
                      {fmtBRL(o.valor)}
                    </p>
                    <p className="text-[11px] text-gray-500">
                      {o.chave === 'LICITACAO' ? 'Licitação' : 'Comercial'} · {o.qtd} NF(s)
                    </p>
                  </div>
                ))}
                {data.linha_sem_ov?.length > 0 && (
                  <div className="border-l pl-6">
                    <p className="text-[11px] text-gray-500 mb-0.5">
                      das notas que não passaram pelo app, por linha:
                    </p>
                    <p className="text-xs text-gray-700">
                      {data.linha_sem_ov.map(l => (
                        <span key={l.chave} className="mr-3">
                          <strong>{l.chave === 'SEM LINHA' ? 'sem linha' : l.chave}</strong>{' '}
                          {fmtBRL(l.valor)}
                        </span>
                      ))}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}

          <Secao
            titulo="No D365, fora do app"
            explicacao="Nota que a MSB emitiu e que a nossa operação não registrou. É o comunicado
                        de uso de quem fatura fora do app — ou uma OV que alguém esqueceu de faturar aqui."
            vazio="Tudo o que o D365 emitiu está no app."
            linhas={data?.so_d365 || []}
            cor="amber"
            render={(n: any) => (
              <>
                <td className="py-1.5 px-3 font-mono text-gray-800">{n.nf}</td>
                <td className="py-1.5 px-2 text-gray-500 whitespace-nowrap">{dataBR(n.data)}</td>
                <td className="py-1.5 px-2 text-gray-700 truncate max-w-[260px]">{n.cliente}</td>
                <td className="py-1.5 px-2 text-[11px] text-gray-500 truncate max-w-[220px]"
                  title={n.operacao || ''}>
                  {TIPO_LABEL[n.tipo_operacao || 'A CLASSIFICAR'] || n.tipo_operacao}
                  {n.origem_venda === 'LICITACAO' && (
                    <span className="ml-1 px-1 py-0.5 rounded bg-violet-100 text-violet-700">
                      licitação
                    </span>
                  )}
                </td>
                <td className="py-1.5 px-2">
                  {/* Licitação nasce vascular; a exceção se conserta aqui, nota
                      a nota, e a correção sobrevive à próxima importação. */}
                  <select value={n.linha || ''} disabled={corrigirLinha.isPending}
                    onChange={e => corrigirLinha.mutate({ id: n.id, linha: e.target.value })}
                    title={n.linha_ajustada ? 'Linha corrigida à mão' : 'Linha sugerida pela operação'}
                    className={`text-[11px] border rounded px-1 py-0.5 ${
                      n.linha_ajustada ? 'border-indigo-300 text-indigo-700' : 'text-gray-600'}`}>
                    <option value="">sem linha</option>
                    <option value="URO">URO</option>
                    <option value="VASCULAR">VASCULAR</option>
                    <option value="REALCLOSURE">REALCLOSURE</option>
                  </select>
                </td>
                <td className="py-1.5 px-3 text-right tabular-nums font-medium text-gray-800">
                  {fmtBRL(n.valor)}
                </td>
              </>
            )} />

          <Secao
            titulo="No app, fora do D365"
            explicacao="OV marcada como faturada aqui sem nota correspondente no D365 no período.
                        Costuma ser número de NF digitado errado — ou faturamento que não aconteceu."
            vazio="Nenhuma OV faturada no app sem nota no D365."
            linhas={data?.so_app || []}
            cor="rose"
            render={(p: any) => (
              <>
                <td className="py-1.5 px-3 font-mono text-gray-800">{p.nf}</td>
                <td className="py-1.5 px-2 text-gray-500 whitespace-nowrap">{dataBR(p.data)}</td>
                <td className="py-1.5 px-2 text-gray-700 truncate max-w-[260px]">{p.cliente}</td>
                <td className="py-1.5 px-2">
                  <Link to={`/expedicao/${p.pedido_id}`}
                    className="font-mono text-xs text-indigo-700 hover:underline">{p.ov}</Link>
                </td>
                <td className="py-1.5 px-3 text-right tabular-nums font-medium text-gray-800">
                  {fmtBRL(p.valor)}
                </td>
              </>
            )} />

          <Secao
            titulo="Mesma nota, número diferente"
            explicacao="A NF existe dos dois lados, mas o valor ou a data não batem. A do D365 é a
                        que vale — corrigir aqui conserta o mês."
            vazio="Nenhuma divergência de valor ou data."
            linhas={data?.divergentes || []}
            cor="indigo"
            render={(d: any) => (
              <>
                <td className="py-1.5 px-3 font-mono text-gray-800">{d.nf}</td>
                <td className="py-1.5 px-2">
                  <Link to={`/expedicao/${d.pedido_id}`}
                    className="font-mono text-xs text-indigo-700 hover:underline">{d.ov}</Link>
                </td>
                <td className="py-1.5 px-2 text-gray-700 truncate max-w-[220px]">{d.cliente}</td>
                <td className="py-1.5 px-2 text-xs text-gray-600 whitespace-nowrap">
                  app {fmtBRL(d.valor_app)} · {dataBR(d.data_app)}
                </td>
                <td className="py-1.5 px-3 text-right text-xs whitespace-nowrap">
                  <ArrowRight size={11} className="inline mx-1 text-gray-300" />
                  <span className="font-medium text-gray-800">
                    D365 {fmtBRL(d.valor_d365)} · {dataBR(d.data_d365)}
                  </span>
                </td>
              </>
            )} />
        </>
      )}
    </div>
  )
}

function Cartao({ rotulo, valor, detalhe, cor }: {
  rotulo: string; valor: string; detalhe?: string; cor: string
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-xl p-4">
      <p className="text-xs text-gray-500">{rotulo}</p>
      <p className={`text-2xl font-bold tabular-nums ${cor}`}>{valor}</p>
      {detalhe && <p className="text-[11px] text-gray-400 mt-0.5">{detalhe}</p>}
    </div>
  )
}

const CORES: Record<string, string> = {
  amber: 'border-amber-200 bg-amber-50',
  rose: 'border-rose-200 bg-rose-50',
  indigo: 'border-indigo-200 bg-indigo-50',
}

function Secao({ titulo, explicacao, vazio, linhas, cor, render }: {
  titulo: string; explicacao: string; vazio: string
  linhas: any[]; cor: string; render: (l: any) => any
}) {
  const total = linhas.reduce((a, l) => a + (Number(l.valor) || 0), 0)
  return (
    <div className="bg-white border border-gray-200 rounded-xl overflow-hidden">
      <div className={`px-4 py-2.5 border-b ${CORES[cor] || ''}`}>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-gray-800">
            {titulo} <span className="font-normal text-gray-500">· {linhas.length}</span>
          </p>
          {total > 0 && (
            <p className="text-sm font-semibold tabular-nums text-gray-800">{fmtBRL(total)}</p>
          )}
        </div>
        <p className="text-[11px] text-gray-600 mt-0.5">{explicacao}</p>
      </div>
      {linhas.length === 0 ? (
        <p className="px-4 py-4 text-xs text-emerald-700 flex items-center gap-1.5">
          <CheckCircle2 size={14} /> {vazio}
        </p>
      ) : (
        <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
          <table className="w-full text-sm">
            <tbody className="divide-y divide-gray-100">
              {linhas.map((l, i) => <tr key={i} className="hover:bg-gray-50">{render(l)}</tr>)}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

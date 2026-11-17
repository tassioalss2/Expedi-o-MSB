/**
 * Base de Notas Fiscais do BI — o faturamento item a item.
 *
 * O espelho do D365 resolve a NOTA: número, valor, data, cliente. Esta base
 * resolve o ITEM — quanto saiu de cada produto, a que preço, para quem, em
 * que vertical. É a informação que o app perde à medida que as OVs deixam de
 * nascer aqui.
 *
 * Não é uma segunda fonte de receita. O faturamento continua vindo de onde
 * vem; esta tela responde "de que foi feito" esse faturamento.
 */
import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, BarChart3, Check, FileSpreadsheet, Loader2, Tag, Upload, Undo2,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'

type Conferencia = {
  tem_total: boolean; bate: boolean | null
  soma_valor: number; soma_quantidade: number
  total_valor?: number; total_quantidade?: number; aviso?: string | null
}
type Relatorio = {
  gravou: boolean; arquivo: string; linhas: number; notas: number; produtos: number
  competencias: string[]; de?: string; ate?: string
  conferencia: Conferencia
  devolucoes: { linhas: number; valor: number }
  produtos_sem_cadastro: string[]
  notas_sem_vertical: string[]
  linhas_pelo_produto?: number
  notas_sem_linha?: string[]
  vendedor_informado: number
  classificacao?: Classificacao | null
}
/** O que a mesma planilha resolveu no espelho fiscal: a linha comercial das
 *  notas que o D365 não sabe classificar sozinho. */
type Classificacao = {
  atualizadas: number; por_numero?: number; por_valor?: number
  notas_na_planilha?: number; ja_tinham_linha?: number
  devolucoes_sem_resposta?: { nf: string; cliente: string; valor: number }[]
  erro?: string
}
type Grupo = { chave: string; rotulo?: string; valor: number; qtd: number; notas: number }
type Resumo = {
  competencia?: string; competencias: string[]
  linhas: number; notas: number; valor: number; quantidade: number
  devolucoes: { linhas: number; valor: number }
  por_linha: Grupo[]; por_vertical: Grupo[]; por_tipo_cliente: Grupo[]
  por_produto: Grupo[]; por_familia: Grupo[]; por_cliente: Grupo[]; por_uf: Grupo[]
}

const brl = (v?: number | null) =>
  (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const qtd = (v?: number | null) =>
  (Number(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 })
const dia = (iso?: string | null) =>
  iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—'
const comp = (c?: string) =>
  c && c.length === 6 ? `${c.slice(4)}/${c.slice(0, 4)}` : c || '—'

function Painel({ titulo, grupos, unidade }: {
  titulo: string; grupos: Grupo[]; unidade?: boolean
}) {
  if (!grupos?.length) return null
  const topo = Math.max(...grupos.map(g => Math.abs(g.valor))) || 1
  return (
    <div className="bg-white rounded-xl border border-gray-200 p-4">
      <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">{titulo}</p>
      <div className="space-y-1.5">
        {grupos.map(g => (
          <div key={g.chave}>
            <div className="flex items-baseline justify-between gap-2 text-[11px]">
              <span className="text-gray-700 truncate" title={g.rotulo || g.chave}>
                {g.rotulo || g.chave}
              </span>
              <span className="tabular-nums shrink-0 font-medium text-gray-800">
                {brl(g.valor)}
                {unidade && <span className="ml-1.5 text-gray-400">{qtd(g.qtd)} un</span>}
              </span>
            </div>
            <div className="h-1.5 bg-gray-100 rounded mt-0.5 overflow-hidden">
              <div className={`h-full rounded ${g.valor < 0 ? 'bg-red-400' : 'bg-blue-500'}`}
                style={{ width: `${Math.max(2, (Math.abs(g.valor) / topo) * 100)}%` }} />
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export default function FaturamentoBI() {
  const qc = useQueryClient()
  const [relatorio, setRelatorio] = useState<Relatorio | null>(null)
  const [competencia, setCompetencia] = useState<string>('')
  const campo = useRef<HTMLInputElement>(null)

  const { data: resumo } = useQuery<Resumo>({
    queryKey: ['notas-bi-resumo', competencia],
    queryFn: () => api.get('/notas-bi/resumo', {
      params: competencia ? { competencia } : {},
    }).then(r => r.data),
  })

  const enviar = useMutation({
    mutationFn: ({ f, gravar }: { f: File; gravar: boolean }) => {
      const fd = new FormData()
      fd.append('arquivo', f)
      return api.post(gravar ? '/notas-bi/importar' : '/notas-bi/previa', fd)
        .then(r => r.data as Relatorio)
    },
    onSuccess: r => {
      setRelatorio(r)
      if (r.gravou) {
        toast.success(`${r.linhas} itens de ${r.notas} notas atualizados.`)
        qc.invalidateQueries({ queryKey: ['notas-bi-resumo'] })
      } else {
        toast(`Prévia: ${r.linhas} itens entrariam. Nada foi gravado.`, { icon: '👀' })
      }
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.detail || 'Não consegui ler a planilha.'),
  })

  const escolher = (gravar: boolean) => {
    const f = campo.current?.files?.[0]
    if (!f) { toast.error('Escolha o arquivo primeiro.'); return }
    enviar.mutate({ f, gravar })
  }

  const c = relatorio?.conferencia

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start gap-3">
        <BarChart3 className="text-blue-600 mt-0.5" size={24} />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Faturamento por Item (BI)</h1>
          <p className="text-sm text-gray-500 max-w-3xl">
            A Base de Notas Fiscais do BI, item a item: produto, quantidade, preço,
            vertical e tipo de cliente. Complementa o espelho do D365, que resolve a
            nota mas não o item — <strong>não é uma segunda fonte de receita</strong>.
          </p>
        </div>
      </div>

      {/* ── Importação ───────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200 p-4">
        <div className="flex flex-wrap items-center gap-3">
          <input ref={campo} type="file" accept=".xlsx,.xlsm"
            className="text-sm file:mr-3 file:rounded-lg file:border-0 file:bg-gray-100
                       file:px-3 file:py-1.5 file:text-sm file:text-gray-700" />
          <button onClick={() => escolher(false)} disabled={enviar.isPending}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700
                       hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2">
            <FileSpreadsheet size={15} /> Ver prévia
          </button>
          <button onClick={() => escolher(true)} disabled={enviar.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold
                       hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2">
            {enviar.isPending ? <Loader2 size={15} className="animate-spin" />
              : <Upload size={15} />} Importar
          </button>
        </div>
        <p className="text-[11px] text-gray-400 mt-2">
          O arquivo do BI traz uma linha de <strong>TOTAL DO FILTRO</strong> no fim.
          Ela não é importada — é usada para conferir se o arquivo veio inteiro. Se a
          soma não bater com ela, nada é gravado.
        </p>
      </div>

      {/* ── Relatório da leitura ─────────────────────────────────────── */}
      {relatorio && (
        <div className={`rounded-xl border p-4 ${relatorio.gravou
          ? 'border-blue-200 bg-blue-50/40' : 'border-gray-200 bg-gray-50'}`}>
          <p className="text-sm font-semibold text-gray-800">
            {relatorio.gravou ? 'Importado' : 'Prévia — nada foi gravado'}
            <span className="font-normal text-gray-500 text-xs ml-2">
              {relatorio.arquivo} · {comp(relatorio.competencias[0])} ·{' '}
              {dia(relatorio.de)} a {dia(relatorio.ate)}
            </span>
          </p>

          <div className="mt-3 grid grid-cols-2 sm:grid-cols-4 gap-2 text-[11px]">
            {[['Itens', relatorio.linhas], ['Notas', relatorio.notas],
              ['Produtos', relatorio.produtos],
              ['Com vendedor', relatorio.vendedor_informado]].map(([r, v]) => (
              <div key={String(r)} className="rounded-lg bg-white border border-gray-200 px-2 py-1.5">
                <p className="text-gray-500">{r}</p>
                <p className="font-bold text-gray-900 text-base tabular-nums">{v as number}</p>
              </div>
            ))}
          </div>

          {c?.tem_total && (
            <p className={`mt-2 text-[11px] flex items-start gap-1.5 ${
              c.bate ? 'text-emerald-800' : 'text-red-800'}`}>
              {c.bate ? <Check size={13} className="mt-0.5 shrink-0" />
                : <AlertTriangle size={13} className="mt-0.5 shrink-0" />}
              {c.bate
                ? `Confere com o TOTAL do arquivo: ${brl(c.soma_valor)} e ${qtd(c.soma_quantidade)} unidades.`
                : c.aviso}
            </p>
          )}
          {c && !c.tem_total && (
            <p className="mt-2 text-[11px] text-amber-800 flex items-start gap-1.5">
              <AlertTriangle size={13} className="mt-0.5 shrink-0" />{c.aviso}
            </p>
          )}

          {!!relatorio.devolucoes.linhas && (
            <p className="mt-2 text-[11px] text-gray-600 flex items-start gap-1.5">
              <Undo2 size={13} className="mt-0.5 shrink-0 text-gray-400" />
              {relatorio.devolucoes.linhas} linha(s) de devolução, {brl(relatorio.devolucoes.valor)}.
              Entram com o sinal negativo, como vieram — os totais já são líquidos.
            </p>
          )}
          {!!relatorio.produtos_sem_cadastro?.length && (
            <p className="mt-2 text-[11px] text-amber-800">
              Produtos que o app não tem no cadastro:{' '}
              <span className="font-mono">{relatorio.produtos_sem_cadastro.join(', ')}</span>.
              A venda foi importada mesmo assim — esconder isso seria pior que um
              cadastro incompleto.
            </p>
          )}
          {!!relatorio.notas_sem_vertical?.length && (
            <p className="mt-2 text-[11px] text-gray-600">
              {relatorio.notas_sem_vertical.length} nota(s) sem Sales Vertical no BI
              (<span className="font-mono">{relatorio.notas_sem_vertical.slice(0, 5).join(', ')}</span>)
              {!!relatorio.linhas_pelo_produto && (
                <> — a linha saiu do <strong>código do produto</strong>,
                em {relatorio.linhas_pelo_produto} linha(s)</>
              )}.
            </p>
          )}
          {/* O que sobrou mesmo. Separado do aviso acima de propósito: nota sem
              Sales Vertical deixou de significar nota sem linha, e misturar os
              dois faria parecer problema o que já foi resolvido. */}
          {!!relatorio.notas_sem_linha?.length && (
            <p className="mt-2 text-[11px] text-amber-800">
              {relatorio.notas_sem_linha.length} nota(s) continuam sem linha
              (<span className="font-mono">{relatorio.notas_sem_linha.slice(0, 5).join(', ')}</span>):
              nem a vertical do BI nem o cadastro do produto responderam.
            </p>
          )}

          {/* A classificação do espelho fiscal. Só aparece depois de gravar:
              na prévia nada foi classificado, e anunciar número aqui seria
              prometer o que ainda não aconteceu. */}
          {relatorio.gravou && relatorio.classificacao && (
            relatorio.classificacao.erro ? (
              <p className="mt-2 text-[11px] text-amber-800 flex items-start gap-1.5">
                <AlertTriangle size={13} className="mt-0.5 shrink-0" />
                A base entrou, mas não consegui classificar as notas do espelho:{' '}
                {relatorio.classificacao.erro}
              </p>
            ) : (
              <p className="mt-2 text-[11px] text-emerald-800 flex items-start gap-1.5">
                <Tag size={13} className="mt-0.5 shrink-0 text-emerald-600" />
                <span>
                  <strong>{relatorio.classificacao.atualizadas} nota(s)</strong> do espelho
                  do D365 ganharam a linha comercial a partir desta base
                  {!!relatorio.classificacao.por_valor && (
                    <> ({relatorio.classificacao.por_numero} pelo número da nota,{' '}
                    {relatorio.classificacao.por_valor} por cliente e valor)</>
                  )}. Nota que já tinha linha não foi tocada.
                  {!!relatorio.classificacao.devolucoes_sem_resposta?.length && (
                    <> {relatorio.classificacao.devolucoes_sem_resposta.length} devolução(ões)
                    continuam sem resposta — a base não traz nota com esse número nem
                    um único crédito do mesmo cliente e valor.</>
                  )}
                </span>
              </p>
            )
          )}
        </div>
      )}

      {/* ── O que a base responde ────────────────────────────────────── */}
      {resumo && resumo.linhas > 0 && (
        <>
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm font-semibold text-gray-800">
              {resumo.notas} notas · {resumo.linhas} itens ·{' '}
              <span className="tabular-nums">{brl(resumo.valor)}</span> ·{' '}
              <span className="tabular-nums">{qtd(resumo.quantidade)} un</span>
            </p>
            {resumo.competencias.length > 1 && (
              <select value={competencia} onChange={e => setCompetencia(e.target.value)}
                className="border rounded-lg px-2 py-1 text-xs">
                <option value="">todas as competências</option>
                {resumo.competencias.map(k => <option key={k} value={k}>{comp(k)}</option>)}
              </select>
            )}
            {!!resumo.devolucoes.linhas && (
              <span className="text-[11px] text-gray-500">
                líquido de {brl(Math.abs(resumo.devolucoes.valor))} em devoluções
              </span>
            )}
          </div>

          <div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
            <Painel titulo="Por linha" grupos={resumo.por_linha} unidade />
            <Painel titulo="Por vertical do BI" grupos={resumo.por_vertical} unidade />
            <Painel titulo="Por tipo de cliente" grupos={resumo.por_tipo_cliente} unidade />
            <Painel titulo="Por família" grupos={resumo.por_familia} unidade />
            <Painel titulo="Por UF" grupos={resumo.por_uf} />
            <Painel titulo="Maiores clientes" grupos={resumo.por_cliente} />
          </div>

          <div className="bg-white rounded-xl border border-gray-200 p-4">
            <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">
              Produtos mais faturados
            </p>
            <table className="w-full text-[11px]">
              <thead>
                <tr className="text-gray-500 text-left">
                  <th className="py-1">Código</th><th className="py-1">Produto</th>
                  <th className="py-1 text-right">Unidades</th>
                  <th className="py-1 text-right">Faturamento</th>
                  <th className="py-1 text-right">Preço médio</th>
                  <th className="py-1 text-right">Notas</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {resumo.por_produto.map(p => (
                  <tr key={p.chave} className="hover:bg-gray-50">
                    <td className="py-1.5 font-mono text-gray-700">{p.chave}</td>
                    <td className="py-1.5 text-gray-700 max-w-[320px] truncate"
                      title={p.rotulo || ''}>{p.rotulo}</td>
                    <td className="py-1.5 text-right tabular-nums">{qtd(p.qtd)}</td>
                    <td className="py-1.5 text-right tabular-nums font-medium">{brl(p.valor)}</td>
                    <td className="py-1.5 text-right tabular-nums text-gray-500">
                      {p.qtd ? brl(p.valor / p.qtd) : '—'}
                    </td>
                    <td className="py-1.5 text-right tabular-nums text-gray-400">{p.notas}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[10px] text-gray-400 mt-2">
              O preço médio é o faturado dividido pelas unidades — e varia por cliente,
              que é como a MSB vende. Não é divergência.
            </p>
          </div>
        </>
      )}
    </div>
  )
}

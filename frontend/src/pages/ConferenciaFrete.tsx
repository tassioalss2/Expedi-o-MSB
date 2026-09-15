/**
 * Conferência da fatura de frete.
 *
 * A transportadora manda a cada 15 dias um zip com os CT-e do período e o
 * boleto. Até aqui a operadora abria DACTE por DACTE, somava à mão e comparava
 * — procurando CT-e repetido e CT-e que não é da MSB.
 *
 * A tela roda cinco testes, e os dois últimos são os que a conferência manual
 * não consegue fazer porque não tem o frete previsto da OV do lado:
 *
 *   1 a soma dos CT-e bate com os boletos?
 *   2 algum CT-e repetido? (pela CHAVE de 44 dígitos, não pelo número)
 *   3 algum CT-e sem a MSB nas pontas?
 *   4 o frete cobrado bate com o previsto na OV daquela NF?
 *   5 saiu NF pela transportadora no período e não tem CT-e?
 *
 * Medido no pacote real de 16 a 31/08 da RR: a soma fecha exata, zero duplicado,
 * zero de terceiro — e ainda assim 16 cobranças diferentes do previsto
 * (R$ 1.826,39 a mais) e 7 CT-e de NF que o app não conhece (R$ 11.277,39, um
 * deles de R$ 8.304,20). A soma fechar não quer dizer que está certo, e é por
 * isso que a tela mostra os cinco e não só o total.
 */
import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, Check, FileText, Loader2, MessageSquare, Truck, Upload, X,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'

const fmtBRL = (v: any) =>
  (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const fmtDia = (d?: string | null) =>
  d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—'

/** Cada situação com a cor e o texto que explicam o achado sem abrir nada. */
const SITUACAO: Record<string, { rotulo: string; cor: string; ajuda: string }> = {
  DUPLICADO: {
    rotulo: 'repetido', cor: 'bg-red-100 text-red-800 border-red-200',
    ajuda: 'o mesmo CT-e aparece duas vezes no pacote',
  },
  NAO_E_NOSSO: {
    rotulo: 'não é da MSB', cor: 'bg-red-100 text-red-800 border-red-200',
    ajuda: 'a MSB não é remetente nem destinatário deste frete',
  },
  NF_DESCONHECIDA: {
    rotulo: 'NF não está no app', cor: 'bg-amber-100 text-amber-900 border-amber-200',
    ajuda: 'o CT-e cobra uma nota que não existe no sistema — confira se é venda nossa',
  },
  VALOR_DIFERENTE: {
    rotulo: 'valor diferente', cor: 'bg-sky-100 text-sky-900 border-sky-200',
    ajuda: 'o frete cobrado não bate com o previsto na OV',
  },
  OK: {
    rotulo: 'confere', cor: 'bg-emerald-50 text-emerald-800 border-emerald-200',
    ajuda: 'o frete cobrado é igual ao previsto na OV',
  },
}

export default function ConferenciaFrete() {
  const qc = useQueryClient()
  const [resultado, setResultado] = useState<any | null>(null)
  const [filtro, setFiltro] = useState<string>('')
  // A conversa do WhatsApp onde o frete e cotado. Opcional de proposito: sem
  // ela a conferencia roda igual, so nao consegue dizer se a cobranca a mais
  // foi combinada — e essa e a diferenca entre acusar e contestar com razao.
  const [conversa, setConversa] = useState<File | null>(null)

  const { data: historico = [] } = useQuery<any[]>({
    queryKey: ['frete-conferencias'],
    queryFn: () => api.get('/frete/conferencias').then(r => r.data),
  })

  const conferir = useMutation({
    mutationFn: (arquivo: File) => {
      const fd = new FormData()
      fd.append('arquivo', arquivo)
      if (conversa) fd.append('conversa', conversa)
      return api.post('/frete/conferencia', fd,
        { headers: { 'Content-Type': 'multipart/form-data' } }).then(r => r.data)
    },
    onSuccess: (r: any) => {
      setResultado(r)
      setFiltro('')
      qc.invalidateQueries({ queryKey: ['frete-conferencias'] })
      toast.success(`${r.qtd_ctes} CT-e conferidos`)
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.detail || 'Não consegui ler o pacote'),
  })

  const abrir = useMutation({
    mutationFn: (id: string) => api.get(`/frete/conferencias/${id}`).then(r => r.data),
    onSuccess: (r: any) => { setResultado(r); setFiltro('') },
  })

  const a = resultado?.achados || {}
  const bate = Math.abs(Number(a.diferenca_soma) || 0) < 0.01
  const ctes: any[] = resultado?.ctes || []
  const visiveis = filtro ? ctes.filter(c => c.situacao === filtro) : ctes
  const contagem = (s: string) => ctes.filter(c => c.situacao === s).length

  return (
    <div className="space-y-5">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold text-gray-900">
          <Truck className="h-6 w-6 text-gray-400" /> Conferência de frete
        </h1>
        <p className="mt-1 text-sm text-gray-500">
          Sobe o pacote que a transportadora enviou — o zip inteiro, sem descompactar.
          A conferência lê o XML dos CT-e e a linha digitável do boleto.
        </p>
      </div>

      {/* A conversa entra ANTES do pacote: e escolhida uma vez e vale para a
          conferencia que vem em seguida. O zip e que dispara o trabalho. */}
      <label className="flex cursor-pointer items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 text-sm transition hover:border-gray-400">
        <MessageSquare className="h-4 w-4 shrink-0 text-gray-400" />
        {conversa ? (
          <>
            <span className="min-w-0 flex-1 truncate text-gray-800">{conversa.name}</span>
            <button type="button" onClick={e => { e.preventDefault(); setConversa(null) }}
              className="text-xs text-gray-500 hover:text-red-600">tirar</button>
          </>
        ) : (
          <span className="flex-1 text-gray-600">
            conversa do WhatsApp com a transportadora <span className="text-gray-400">(opcional — .txt ou .zip da exportação)</span>
          </span>
        )}
        <input type="file" accept=".txt,.zip" className="hidden"
          onChange={e => { setConversa(e.target.files?.[0] || null); e.target.value = '' }} />
      </label>

      {/* Subir o pacote */}
      <label className={`flex cursor-pointer items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 transition ${
        conferir.isPending
          ? 'border-gray-200 bg-gray-50'
          : 'border-gray-300 bg-white hover:border-blue-400 hover:bg-blue-50/40'}`}>
        {conferir.isPending ? (
          <><Loader2 className="h-5 w-5 animate-spin text-gray-400" />
            <span className="text-sm text-gray-600">lendo os documentos…</span></>
        ) : (
          <><Upload className="h-5 w-5 text-gray-400" />
            <span className="text-sm font-medium text-gray-700">
              escolher o zip da transportadora
            </span></>
        )}
        <input type="file" accept=".zip" className="hidden" disabled={conferir.isPending}
          onChange={e => {
            const f = e.target.files?.[0]
            if (f) conferir.mutate(f)
            e.target.value = ''
          }} />
      </label>

      {resultado && (
        <div className="space-y-4">
          {/* 1 · a soma, que é a pergunta que abre o trabalho */}
          <div className={`rounded-xl border p-4 ${
            bate ? 'border-emerald-200 bg-emerald-50' : 'border-red-200 bg-red-50'}`}>
            <div className="flex flex-wrap items-center gap-3">
              {bate ? <Check className="h-5 w-5 text-emerald-600" />
                    : <AlertTriangle className="h-5 w-5 text-red-600" />}
              <span className={`text-lg font-semibold ${
                bate ? 'text-emerald-900' : 'text-red-900'}`}>
                {bate ? 'A soma bate' : `Diferença de ${fmtBRL(a.diferenca_soma)}`}
              </span>
              <span className="text-sm text-gray-600">
                {resultado.qtd_ctes} CT-e somam <b>{fmtBRL(resultado.total_ctes)}</b>
                {' · '}{resultado.qtd_boletos} boleto(s) somam <b>{fmtBRL(resultado.total_boletos)}</b>
              </span>
            </div>
            <p className="mt-1 text-xs text-gray-600">
              {resultado.transportadora} · período {fmtDia(resultado.periodo_de)} a{' '}
              {fmtDia(resultado.periodo_ate)}
              {resultado.vencimento && <> · vence {fmtDia(resultado.vencimento)}</>}
            </p>
          </div>

          {/* 2 a 5 · os achados. Cada um é clicável e filtra a lista. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Achado titulo="Repetidos" n={contagem('DUPLICADO')} grave
              sub="mesmo CT-e duas vezes"
              ativo={filtro === 'DUPLICADO'} onClick={() => setFiltro(f => f === 'DUPLICADO' ? '' : 'DUPLICADO')} />
            <Achado titulo="Não são da MSB" n={contagem('NAO_E_NOSSO')} grave
              sub="frete de outro cliente"
              ativo={filtro === 'NAO_E_NOSSO'} onClick={() => setFiltro(f => f === 'NAO_E_NOSSO' ? '' : 'NAO_E_NOSSO')} />
            <Achado titulo="NF não está no app" n={contagem('NF_DESCONHECIDA')}
              sub={fmtBRL(a.valor_nf_desconhecida)}
              ativo={filtro === 'NF_DESCONHECIDA'} onClick={() => setFiltro(f => f === 'NF_DESCONHECIDA' ? '' : 'NF_DESCONHECIDA')} />
            <Achado titulo="Valor diferente do previsto" n={contagem('VALOR_DIFERENTE')}
              sub={`${Number(a.soma_das_diferencas) >= 0 ? '+' : ''}${fmtBRL(a.soma_das_diferencas)}`}
              ativo={filtro === 'VALOR_DIFERENTE'} onClick={() => setFiltro(f => f === 'VALOR_DIFERENTE' ? '' : 'VALOR_DIFERENTE')} />
          </div>

          {/* O que a conversa respondeu. Sem ela, "cobrou a mais" e acusacao;
              com ela, separa o que foi combinado do que nao foi — e so o
              segundo grupo se contesta com a transportadora. */}
          {a.conversa && (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <p className="flex flex-wrap items-center gap-2 text-sm font-semibold text-gray-800">
                <MessageSquare className="h-4 w-4 text-gray-400" />
                A conversa explica {a.conversa.cobrado_confirmado} das {a.valor_diferente} cobranças diferentes do previsto
              </p>
              <p className="mt-1 text-xs text-gray-600">
                {a.conversa.valores_citados} valores citados pela transportadora em{' '}
                {a.conversa.mensagens} mensagens, de {fmtDia(a.conversa.de)} a {fmtDia(a.conversa.ate)}.
                Nesses casos o cobrado foi cotado — o desatualizado é o frete previsto na OV.
              </p>
              {a.conversa.cobrado_sem_cotacao > 0 && (
                <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-900">
                  <b>{a.conversa.cobrado_sem_cotacao} cobrança(s) sem cotação em lugar nenhum</b>
                  {' — '}{fmtBRL(a.conversa.valor_sem_cotacao)} a mais. É o que vale contestar.
                </p>
              )}
              <p className="mt-2 text-[11px] text-gray-400">
                O cruzamento é por VALOR: o número cobrado aparece entre os que a
                transportadora citou. É indício forte, não prova — dois fretes
                podem ter o mesmo valor.
              </p>
            </div>
          )}

          {/* 5 · o outro lado: nota nossa que a transportadora não cobrou */}
          {a.sem_cte?.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-4">
              <p className="flex items-center gap-2 text-sm font-semibold text-amber-900">
                <AlertTriangle className="h-4 w-4" />
                {a.sem_cte.length} nota(s) saíram no período e não têm CT-e neste pacote
              </p>
              <p className="mt-0.5 text-xs text-amber-800">
                Ou entram no próximo boleto, ou a transportadora não cobrou.
              </p>
              <div className="mt-2 flex flex-wrap gap-2">
                {a.sem_cte.map((s: any) => (
                  <span key={s.ov} className="rounded-lg border border-amber-300 bg-white px-2 py-1 text-xs">
                    <b className="font-mono">{s.ov}</b> · NF {s.nf} · previsto {fmtBRL(s.previsto)}
                  </span>
                ))}
              </div>
            </div>
          )}

          {/* A lista, com o porquê de cada linha */}
          <div className="overflow-hidden rounded-xl border border-gray-200 bg-white">
            <div className="flex items-center justify-between border-b border-gray-100 px-4 py-2.5">
              <span className="text-sm font-semibold text-gray-700">
                {visiveis.length} CT-e{filtro && ` · ${SITUACAO[filtro]?.rotulo}`}
              </span>
              {filtro && (
                <button onClick={() => setFiltro('')}
                  className="flex items-center gap-1 text-xs text-blue-600 hover:underline">
                  <X className="h-3 w-3" /> ver todos
                </button>
              )}
            </div>
            <div className="max-h-[32rem] overflow-y-auto">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-gray-50 text-xs uppercase tracking-wide text-gray-500">
                  <tr>
                    <th className="px-3 py-2 text-left">CT-e</th>
                    <th className="px-3 py-2 text-left">Emissão</th>
                    <th className="px-3 py-2 text-left">NF</th>
                    <th className="px-3 py-2 text-left">Destinatário</th>
                    <th className="px-3 py-2 text-right">Previsto</th>
                    <th className="px-3 py-2 text-right">Cobrado</th>
                    <th className="px-3 py-2 text-right">Diferença</th>
                    <th className="px-3 py-2 text-left">Cotação</th>
                    <th className="px-3 py-2 text-left">Situação</th>
                  </tr>
                </thead>
                <tbody>
                  {visiveis.map((c: any) => {
                    const s = SITUACAO[c.situacao] || SITUACAO.OK
                    const dif = c.previsto == null ? null : Number(c.valor) - Number(c.previsto)
                    return (
                      <tr key={c.chave || c.numero} className="border-t border-gray-100 hover:bg-gray-50">
                        <td className="px-3 py-2 font-mono text-xs">{c.numero}</td>
                        <td className="px-3 py-2 text-xs text-gray-600">{fmtDia(c.emissao)}</td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {(c.notas || []).join(', ') || '—'}
                          {c.ov && <span className="ml-1 text-gray-400">({c.ov})</span>}
                        </td>
                        <td className="max-w-[16rem] truncate px-3 py-2 text-xs text-gray-600">
                          {c.destinatario}
                        </td>
                        <td className="px-3 py-2 text-right tabular-nums text-gray-500">
                          {c.previsto == null ? '—' : fmtBRL(c.previsto)}
                        </td>
                        <td className="px-3 py-2 text-right font-medium tabular-nums">
                          {fmtBRL(c.valor)}
                        </td>
                        <td className={`px-3 py-2 text-right tabular-nums ${
                          dif == null ? 'text-gray-400'
                            : dif > 0 ? 'font-semibold text-red-700'
                            : dif < 0 ? 'text-emerald-700' : 'text-gray-400'}`}>
                          {dif == null ? '—' : `${dif > 0 ? '+' : ''}${fmtBRL(dif)}`}
                        </td>
                        <td className="px-3 py-2 text-xs">
                          {c.cotado === undefined || c.cotado === null ? (
                            <span className="text-gray-300">—</span>
                          ) : c.cotado ? (
                            <span className="text-emerald-700"
                              title={`valor cotado em ${(c.cotado_em || []).join(', ')}`}>
                              cotado{c.cotado_emergencial ? ' (emerg.)' : ''}
                            </span>
                          ) : (
                            <span className="font-medium text-red-700"
                              title="este valor não aparece na conversa">
                              sem cotação
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`rounded border px-1.5 py-0.5 text-[11px] font-medium ${s.cor}`}
                            title={s.ajuda}>
                            {s.rotulo}
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Histórico — 3 meses, como o Tássio pediu, para o app não pesar */}
      {historico.length > 0 && (
        <div className="rounded-xl border border-gray-200 bg-white">
          <div className="border-b border-gray-100 px-4 py-2.5">
            <span className="text-sm font-semibold text-gray-700">
              Conferências anteriores
            </span>
            <span className="ml-2 text-xs text-gray-500">últimos 3 meses</span>
          </div>
          <div className="divide-y divide-gray-100">
            {historico.map((h: any) => {
              const ok = Math.abs(Number(h.achados?.diferenca_soma) || 0) < 0.01
              return (
                <button key={h.id} onClick={() => abrir.mutate(h.id)}
                  className="flex w-full flex-wrap items-center gap-3 px-4 py-2.5 text-left text-sm hover:bg-gray-50">
                  <FileText className="h-4 w-4 shrink-0 text-gray-400" />
                  <span className="font-medium text-gray-900">
                    {fmtDia(h.periodo_de)} a {fmtDia(h.periodo_ate)}
                  </span>
                  <span className="text-xs text-gray-500">{h.transportadora}</span>
                  <span className="tabular-nums text-gray-700">{fmtBRL(h.total_ctes)}</span>
                  <span className="text-xs text-gray-500">{h.qtd_ctes} CT-e</span>
                  <span className={`ml-auto rounded px-1.5 py-0.5 text-[11px] font-medium ${
                    ok ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                    {ok ? 'soma bate' : `dif ${fmtBRL(h.achados?.diferenca_soma)}`}
                  </span>
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

/** Um achado. Clica e a lista abaixo filtra — é como se vai do número ao caso. */
function Achado({ titulo, n, sub, grave, ativo, onClick }: {
  titulo: string; n: number; sub?: string; grave?: boolean
  ativo: boolean; onClick: () => void
}) {
  const vazio = n === 0
  return (
    <button onClick={onClick} disabled={vazio}
      className={`rounded-xl border p-3 text-left transition ${
        vazio ? 'border-gray-200 bg-white opacity-60'
          : ativo ? 'border-blue-500 bg-blue-50 ring-2 ring-blue-200'
          : grave ? 'border-red-200 bg-red-50 hover:border-red-400'
          : 'border-gray-200 bg-white hover:border-gray-400'}`}>
      <p className="text-xs font-medium text-gray-600">{titulo}</p>
      <p className={`mt-0.5 text-2xl font-bold tabular-nums ${
        vazio ? 'text-gray-400' : grave ? 'text-red-700' : 'text-gray-900'}`}>
        {n}
      </p>
      {sub && <p className="text-[11px] text-gray-500">{sub}</p>}
    </button>
  )
}

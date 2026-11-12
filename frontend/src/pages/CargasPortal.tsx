/**
 * Cargas do Portal MSB.
 *
 * O Kanban está saindo do ACE para o Portal. A conferência da fatura da
 * transportadora só consegue dizer "esta cobrança está acima do previsto"
 * porque tem a NOSSA carga do lado do CT-e — sem as cargas aqui, ela morre
 * junto com o Kanban. Esta tela é o que traz as cargas de volta.
 *
 * É ESPELHO: nada do que entra aqui sobrescreve o que a operação registrou.
 * Quando o Portal discorda do app — tipo de frete, destino — a tela mostra a
 * divergência e deixa a decisão com quem sabe o caso.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, CloudDownload, Loader2, Package, RefreshCw, Search, Scale,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'

type Divergencia = {
  so_no_portal: Array<{ ov: string; cliente: string; valor: number; etapa: string }>
  frete: Array<{ ov: string; portal: string; portal_bruto: string; app: string }>
  destino: Array<{ ov: string; portal: string; app: string }>
}

type Relatorio = {
  gravou: boolean
  lido_em?: string
  ovs_no_portal: number
  cargas: number
  com_peso: number
  sem_peso: number
  com_nf: number
  ovs_so_no_portal: number
  divergencias: Divergencia
  avisos_do_portal: string[]
}

type Carga = {
  carga_id: string; numero_ov?: string; cliente_nome?: string
  cidade?: string; uf?: string; numero_nf?: string; valor_nf?: number
  itens?: number; peso_kg?: number; status?: string; fase?: string
  etapa_ov?: string; deposito?: string; transportadora?: string
  tipo_frete?: string; tipo_frete_portal?: string
  envio_em?: string; expedido_em?: string; importado_em?: string
}

const brl = (v?: number | null) =>
  (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const dia = (iso?: string | null) =>
  iso ? String(iso).slice(0, 10).split('-').reverse().join('/') : '—'
const hora = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'

/** Os status de carga do D365, em português e com cor. */
const STATUS: Record<string, { rotulo: string; cor: string }> = {
  Waved: { rotulo: 'onda criada', cor: 'bg-gray-100 text-gray-700 border-gray-200' },
  InProcess: { rotulo: 'em separação', cor: 'bg-blue-50 text-blue-700 border-blue-200' },
  Loaded: { rotulo: 'carregado', cor: 'bg-amber-50 text-amber-800 border-amber-200' },
  Shipped: { rotulo: 'expedido', cor: 'bg-green-50 text-green-700 border-green-200' },
}

const FRETE: Record<string, string> = {
  FOB: 'FOB · cliente paga',
  CIF_SEM_VALOR: 'CIF sem valor · custo nosso',
  CIF_COM_VALOR: 'CIF com valor · na NF',
}

export default function CargasPortal() {
  const qc = useQueryClient()
  const [relatorio, setRelatorio] = useState<Relatorio | null>(null)
  const [busca, setBusca] = useState('')
  /** Qual dos dois botões está rodando. Guardado à parte de propósito: dá
   *  para deduzir de `mutation.variables`, mas aí o spinner passaria a
   *  depender de `false` ser falsy — funciona hoje e quebra calado amanhã. */
  const [rodando, setRodando] = useState<'previa' | 'importar' | null>(null)

  const { data: cargas = [], isLoading } = useQuery<Carga[]>({
    queryKey: ['cargas-portal', busca],
    queryFn: () => api.get('/portal/cargas', {
      params: busca.trim() ? { busca: busca.trim() } : {},
    }).then(r => r.data),
  })

  const ler = useMutation({
    mutationFn: (gravar: boolean) =>
      (gravar ? api.post('/portal/importar') : api.get('/portal/previa'))
        .then(r => r.data as Relatorio),
    onSuccess: (r) => {
      setRelatorio(r)
      if (r.gravou) {
        toast.success(`${r.cargas} carga(s) atualizada(s) no espelho.`)
        qc.invalidateQueries({ queryKey: ['cargas-portal'] })
      } else {
        toast(`Prévia: ${r.cargas} carga(s) entrariam. Nada foi gravado.`, { icon: '👀' })
      }
    },
    onError: (e: any) =>
      toast.error(e?.response?.data?.detail || 'Não consegui ler o Portal.'),
    onSettled: () => setRodando(null),
  })

  const d = relatorio?.divergencias

  return (
    <div className="p-6 max-w-7xl mx-auto space-y-5">
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <CloudDownload className="text-blue-600 mt-0.5" size={24} />
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Cargas do Portal</h1>
            <p className="text-sm text-gray-500 max-w-2xl">
              Espelho das cargas que o Portal MSB lê do Dynamics. Mantém a conferência
              da fatura de frete viva depois que o Kanban sair daqui — nada nesta tela
              sobrescreve o que a operação registrou.
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <button onClick={() => { setRodando('previa'); ler.mutate(false) }}
            disabled={ler.isPending}
            className="px-3 py-2 border border-gray-300 rounded-lg text-sm text-gray-700
                       hover:bg-gray-50 disabled:opacity-50 flex items-center gap-2">
            {rodando === 'previa' ? <Loader2 size={15} className="animate-spin" />
              : <Search size={15} />} Ver prévia
          </button>
          <button onClick={() => { setRodando('importar'); ler.mutate(true) }}
            disabled={ler.isPending}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-semibold
                       hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2">
            {rodando === 'importar' ? <Loader2 size={15} className="animate-spin" />
              : <RefreshCw size={15} />} Importar do Portal
          </button>
        </div>
      </div>

      {ler.isPending && (
        <p className="text-xs text-gray-400">
          A função do Portal hiberna — a primeira leitura do dia costuma levar uns 20
          segundos. É sono, não queda.
        </p>
      )}

      {/* ── Relatório da leitura ─────────────────────────────────────── */}
      {relatorio && (
        <div className={`rounded-xl border p-4 ${relatorio.gravou
          ? 'border-blue-200 bg-blue-50/40' : 'border-gray-200 bg-gray-50'}`}>
          <p className="text-sm font-semibold text-gray-800">
            {relatorio.gravou ? 'Importado' : 'Prévia — nada foi gravado'}
            <span className="font-normal text-gray-500 text-xs ml-2">
              Portal gerado às {hora(relatorio.lido_em)}
            </span>
          </p>

          <div className="mt-3 grid grid-cols-2 sm:grid-cols-5 gap-2 text-[11px]">
            {[
              ['OVs no Portal', relatorio.ovs_no_portal],
              ['Cargas', relatorio.cargas],
              ['Com peso', relatorio.com_peso],
              ['Com NF', relatorio.com_nf],
              ['Só no Portal', relatorio.ovs_so_no_portal],
            ].map(([r, v]) => (
              <div key={String(r)} className="rounded-lg bg-white border border-gray-200 px-2 py-1.5">
                <p className="text-gray-500">{r}</p>
                <p className="font-bold text-gray-900 text-base tabular-nums">{v as number}</p>
              </div>
            ))}
          </div>

          {!!relatorio.sem_peso && (
            <p className="mt-2 text-[11px] text-gray-600 flex items-start gap-1.5">
              <Scale size={13} className="mt-0.5 shrink-0 text-gray-400" />
              {relatorio.sem_peso} carga(s) ainda sem peso: o Dynamics só informa o peso
              depois que a carga é criada. Nulo aqui é “ainda não se sabe”, não zero.
            </p>
          )}

          {!!d?.so_no_portal.length && (
            <div className="mt-3 rounded-lg bg-amber-50 border border-amber-200 px-3 py-2">
              <p className="text-[11px] font-semibold text-amber-900">
                {d.so_no_portal.length} OV(s) existem no Portal e não no ACE
              </p>
              <p className="text-[11px] text-amber-800 mt-0.5">
                São as que nasceram direto no Dynamics. A carga delas foi guardada mesmo
                assim — é para isso que o espelho não depende da OV existir aqui.
              </p>
              <p className="text-[11px] text-amber-700 mt-1 font-mono">
                {d.so_no_portal.slice(0, 10).map(x => x.ov).join(', ')}
                {d.so_no_portal.length > 10 && ` e mais ${d.so_no_portal.length - 10}`}
              </p>
            </div>
          )}

          {!!d?.frete.length && (
            <div className="mt-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2">
              <p className="text-[11px] font-semibold text-red-900 flex items-center gap-1.5">
                <AlertTriangle size={13} /> Tipo de frete diferente em {d.frete.length} OV(s)
              </p>
              <p className="text-[11px] text-red-800 mt-0.5">
                Não corrigi nenhuma: isso decide quem paga o frete, e quem registrou a OV
                teve um motivo. Confira caso a caso.
              </p>
              <ul className="mt-1 space-y-0.5">
                {d.frete.slice(0, 8).map(x => (
                  <li key={x.ov} className="text-[11px] text-red-800 font-mono">
                    {x.ov}: Portal {x.portal} ({x.portal_bruto}) · ACE {x.app}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!!d?.destino.length && (
            <div className="mt-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2">
              <p className="text-[11px] font-semibold text-red-900">
                Destino diferente em {d.destino.length} OV(s)
              </p>
              <ul className="mt-1 space-y-0.5">
                {d.destino.slice(0, 8).map(x => (
                  <li key={x.ov} className="text-[11px] text-red-800 font-mono">
                    {x.ov}: Portal {x.portal} · ACE {x.app}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!!relatorio.avisos_do_portal?.length && (
            <details className="mt-3 text-[11px] text-gray-600">
              <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
                {relatorio.avisos_do_portal.length} aviso(s) do próprio Portal sobre a
                leitura dele do Dynamics
              </summary>
              <ul className="mt-1.5 space-y-1 pl-3 list-disc marker:text-gray-300">
                {relatorio.avisos_do_portal.map((a, i) => <li key={i}>{a}</li>)}
              </ul>
            </details>
          )}
        </div>
      )}

      {/* ── Espelho ──────────────────────────────────────────────────── */}
      <div className="bg-white rounded-xl border border-gray-200">
        <div className="p-4 border-b flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-gray-800">
            Espelho {cargas.length ? `· ${cargas.length} carga(s)` : ''}
          </p>
          <input value={busca} onChange={e => setBusca(e.target.value)}
            placeholder="OV, NF, carga ou cliente…"
            className="border rounded-lg px-3 py-1.5 text-sm w-64" />
        </div>

        {isLoading ? (
          <p className="text-center text-gray-400 py-10 text-sm">Carregando…</p>
        ) : !cargas.length ? (
          <div className="text-center py-12">
            <Package className="mx-auto text-gray-300 mb-2" size={32} />
            <p className="text-sm text-gray-500">O espelho está vazio.</p>
            <p className="text-[11px] text-gray-400 mt-1">
              Clique em <strong>Importar do Portal</strong> para trazer as cargas.
            </p>
          </div>
        ) : (
          <div className="overflow-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50">
                <tr className="text-left text-xs font-semibold text-gray-500">
                  <th className="px-4 py-2.5">Carga</th>
                  <th className="px-4 py-2.5">OV</th>
                  <th className="px-4 py-2.5">Cliente</th>
                  <th className="px-4 py-2.5">Destino</th>
                  <th className="px-4 py-2.5">NF</th>
                  <th className="px-4 py-2.5 text-right">Peso</th>
                  <th className="px-4 py-2.5 text-right">Valor</th>
                  <th className="px-4 py-2.5">Frete</th>
                  <th className="px-4 py-2.5">Status</th>
                  <th className="px-4 py-2.5">Envio</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {cargas.map(c => {
                  const st = STATUS[c.status || ''] || {
                    rotulo: c.status || '—', cor: 'bg-gray-100 text-gray-600 border-gray-200',
                  }
                  return (
                    <tr key={c.carga_id} className="hover:bg-gray-50">
                      <td className="px-4 py-2.5 font-mono text-xs text-gray-700">{c.carga_id}</td>
                      <td className="px-4 py-2.5 font-mono font-semibold text-indigo-700">
                        {c.numero_ov || '—'}
                      </td>
                      <td className="px-4 py-2.5 text-gray-700 max-w-[200px] truncate"
                        title={c.cliente_nome}>{c.cliente_nome || '—'}</td>
                      <td className="px-4 py-2.5 text-gray-600 text-xs whitespace-nowrap">
                        {c.cidade ? `${c.cidade}/${c.uf}` : '—'}
                      </td>
                      <td className="px-4 py-2.5 font-mono text-xs text-gray-600">
                        {c.numero_nf || '—'}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-gray-700">
                        {c.peso_kg != null
                          ? `${Number(c.peso_kg).toLocaleString('pt-BR')} kg`
                          : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-2.5 text-right tabular-nums text-gray-700">
                        {brl(c.valor_nf)}
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-600"
                        title={c.tipo_frete_portal || ''}>
                        {c.tipo_frete ? FRETE[c.tipo_frete] || c.tipo_frete
                          : <span className="text-gray-300">não definido</span>}
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded border ${st.cor}`}>
                          {st.rotulo}
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-xs text-gray-500 whitespace-nowrap">
                        {dia(c.envio_em)}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * Rastreio das entregas CIF.
 *
 * O acompanhamento vive hoje no portal da BRIX e no grupo de WhatsApp da RR: o
 * que a transportadora responde some na conversa, e some junto a resposta para
 * "essa carga chegou?". Aqui cada consulta vira um lançamento preso à OV.
 *
 * Tela deliberadamente curta: um corte de data, três grupos, uma lista. A
 * primeira versão tinha quatro abas, filtro de período e cartões por
 * transportadora, e a resposta foi direta — "está MUITO CONFUSO".
 *
 * Tudo que classifica uma carga é clicável: o corte, cada grupo, cada alerta e
 * cada data trazem do backend a regra e os números que os geraram. Nenhum
 * número aparece aqui sem poder dizer de onde veio.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, HelpCircle, Plus, Search, Trash2, X } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'
import { msgErro } from '../lib/crm'

type Evento = {
  id: string
  situacao: string
  ocorrido_em: string
  fonte: string | null
  descricao: string | null
  recebedor: string | null
  documento_recebedor: string | null
  nova_previsao: string | null
  usuarios?: { nome?: string } | null
}

type Linha = {
  pedido_id: string
  numero_pedido: string | null
  numero_nf: string | null
  cliente: string | null
  transportadora: string | null
  destino: string | null
  prioridade: string | null
  situacao: string
  situacao_rotulo: string
  sem_lancamento: boolean
  grupo: 'aberto' | 'canhoto' | 'concluidas'
  atencao: boolean
  alertas: Array<{ texto: string; porque: string }>
  explicacao: { grupo: string; saida: string; previsao: string; situacao: string }
  previsao: string | null
  saida: string | null
  dias_sem_noticia: number | null
  entregue_em: string | null
  recebedor: string | null
  eventos: Evento[]
}

type Painel = {
  desde: string
  hoje: string
  linhas: Linha[]
  contagem: { aberto: number; canhoto: number; concluidas: number; atencao: number }
  transportadoras: string[]
  situacoes: Array<{ valor: string; rotulo: string; atencao: boolean }>
  regras: Record<string, string>
}

const GRUPOS = [
  { chave: 'aberto', rotulo: 'Em aberto' },
  { chave: 'canhoto', rotulo: 'Falta canhoto' },
  { chave: 'concluidas', rotulo: 'Concluídas' },
] as const

const FONTES = [
  { valor: 'BRIX_SISTEMA', rotulo: 'Portal da BRIX' },
  { valor: 'RR_WHATSAPP', rotulo: 'WhatsApp da RR' },
  { valor: 'CLIENTE', rotulo: 'Cliente' },
  { valor: 'OUTRO', rotulo: 'Outro' },
]

const dia = (d?: string | null) =>
  d ? new Date(d.length <= 10 ? `${d}T12:00:00` : d).toLocaleDateString('pt-BR',
    { day: '2-digit', month: '2-digit' }) : '—'
const diaHora = (d?: string | null) =>
  d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'

/** Texto que explica de onde veio a informação, aberto no clique. */
function Porque({ children, texto, className = '' }: {
  children: React.ReactNode; texto: string; className?: string
}) {
  const [aberto, setAberto] = useState(false)
  return (
    <span className="relative inline-block">
      <button
        type="button"
        onClick={() => setAberto(!aberto)}
        className={`underline decoration-dotted decoration-gray-300 underline-offset-2
                    hover:decoration-gray-500 text-left ${className}`}
      >
        {children}
      </button>
      {aberto && (
        <>
          <span className="fixed inset-0 z-10" onClick={() => setAberto(false)} />
          <span className="absolute z-20 left-0 top-full mt-1 w-72 rounded-lg border border-gray-200
                           bg-white shadow-lg p-2.5 text-[11px] leading-relaxed text-gray-700
                           font-normal normal-case block">
            {texto}
          </span>
        </>
      )}
    </span>
  )
}

export default function Rastreio() {
  const qc = useQueryClient()
  const [grupo, setGrupo] = useState<(typeof GRUPOS)[number]['chave']>('aberto')
  const [soAtencao, setSoAtencao] = useState(false)
  const [transportadora, setTransportadora] = useState('')
  const [busca, setBusca] = useState('')
  const [lancando, setLancando] = useState<Linha | null>(null)

  const { data, isLoading } = useQuery<Painel>({
    queryKey: ['rastreio', transportadora],
    queryFn: async () =>
      (await api.get('/rastreio', { params: { transportadora: transportadora || undefined } })).data,
  })

  const linhas = useMemo(() => {
    const t = busca.trim().toLowerCase()
    return (data?.linhas || [])
      .filter((l) => l.grupo === grupo)
      .filter((l) => !soAtencao || l.atencao)
      .filter((l) => !t || [l.numero_pedido, l.numero_nf, l.cliente, l.destino]
        .some((c) => (c || '').toLowerCase().includes(t)))
  }, [data, grupo, soAtencao, busca])

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <h1 className="text-xl font-bold text-gray-900">Rastreio de entregas</h1>
      <p className="text-xs text-gray-500 mt-1">
        <Porque texto={data?.regras?.corte || ''}>
          Controlando o que saiu daqui desde {dia(data?.desde)}
        </Porque>
        {' · '}
        <Porque texto={data?.regras?.cif || ''}>só frete CIF</Porque>
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {GRUPOS.map((g) => (
          <button
            key={g.chave}
            onClick={() => { setGrupo(g.chave); setSoAtencao(false) }}
            className={`px-3 py-2 rounded-lg border text-sm flex items-baseline gap-2
              ${grupo === g.chave
                ? 'border-gray-900 bg-gray-900 text-white'
                : 'border-gray-200 bg-white text-gray-700 hover:border-gray-300'}`}
          >
            <span>{g.rotulo}</span>
            <span className={grupo === g.chave ? 'text-white/70' : 'text-gray-400'}>
              {data?.contagem?.[g.chave] ?? 0}
            </span>
          </button>
        ))}
        <HelpCircle className="w-4 h-4 text-gray-300" />
        <span className="text-[11px] text-gray-500">
          <Porque texto={data?.regras?.aberto || ''}>em aberto</Porque>{' · '}
          <Porque texto={data?.regras?.canhoto || ''}>falta canhoto</Porque>{' · '}
          <Porque texto={data?.regras?.concluidas || ''}>concluídas</Porque>
        </span>
      </div>

      {grupo === 'aberto' && (data?.contagem?.atencao ?? 0) > 0 && (
        <button
          onClick={() => setSoAtencao(!soAtencao)}
          className={`mt-2 flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border
            ${soAtencao ? 'border-red-300 bg-red-50 text-red-800'
              : 'border-gray-200 bg-white text-gray-700 hover:border-red-200'}`}
        >
          <AlertTriangle className="w-4 h-4 text-red-500" />
          {data?.contagem.atencao} exigem atenção
          <span className="text-gray-400 text-xs">{soAtencao ? '(mostrando só elas)' : '(clique para filtrar)'}</span>
        </button>
      )}
      {grupo === 'aberto' && (
        <p className="mt-1 text-[11px] text-gray-400">
          <Porque texto={data?.regras?.atencao || ''}>o que conta como atenção</Porque>
        </p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-2.5" />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="OV, NF, cliente ou destino"
            className="w-full pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg
                       focus:outline-none focus:ring-2 focus:ring-gray-200"
          />
        </div>
        <select
          value={transportadora}
          onChange={(e) => setTransportadora(e.target.value)}
          className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white"
        >
          <option value="">Todas</option>
          {(data?.transportadoras || []).map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {isLoading ? (
        <p className="mt-6 text-sm text-gray-500">Carregando…</p>
      ) : linhas.length === 0 ? (
        <p className="mt-6 text-sm text-gray-500">Nada por aqui.</p>
      ) : (
        <div className="mt-3 divide-y divide-gray-100 border border-gray-200 rounded-xl bg-white">
          {linhas.map((l) => (
            <Carga key={l.pedido_id} linha={l} onLancar={() => setLancando(l)}
              onMudou={() => qc.invalidateQueries({ queryKey: ['rastreio'] })} />
          ))}
        </div>
      )}

      {lancando && (
        <ModalLancamento
          linha={lancando}
          situacoes={data?.situacoes || []}
          onFechar={() => setLancando(null)}
          onSalvo={() => {
            setLancando(null)
            qc.invalidateQueries({ queryKey: ['rastreio'] })
          }}
        />
      )}
    </div>
  )
}

function Carga({ linha: l, onLancar, onMudou }: {
  linha: Linha; onLancar: () => void; onMudou: () => void
}) {
  const [verHistorico, setVerHistorico] = useState(false)

  const apagar = useMutation({
    mutationFn: (id: string) => api.delete(`/rastreio/evento/${id}`),
    onSuccess: () => { toast.success('Lançamento removido'); onMudou() },
    onError: (e) => toast.error(msgErro(e, 'Não consegui remover')),
  })

  return (
    <div className={`px-3 py-2.5 ${l.atencao ? 'bg-red-50/40' : ''}`}>
      <div className="flex items-start gap-3 justify-between">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-gray-900">
            {l.numero_pedido || '—'}
            {l.numero_nf && <span className="font-normal text-gray-400"> · NF {l.numero_nf}</span>}
            {l.prioridade === 'URGENTE' && (
              <span className="ml-2 text-[10px] font-bold text-red-700 bg-red-100 px-1.5 py-0.5 rounded">
                URGENTE
              </span>
            )}
          </p>
          <p className="text-xs text-gray-600 truncate">
            {l.cliente || '—'} · {l.destino || '—'} · {l.transportadora || 'sem transportadora'}
          </p>
          <p className="mt-0.5 text-[11px] text-gray-500">
            <Porque texto={l.explicacao.saida}>saiu {dia(l.saida)}</Porque>
            {' · '}
            <Porque texto={l.explicacao.previsao}>previsão {dia(l.previsao)}</Porque>
            {' · '}
            <Porque texto={l.explicacao.situacao} className={l.sem_lancamento ? 'text-gray-400' : ''}>
              {l.sem_lancamento ? 'sem acompanhamento' : l.situacao_rotulo.toLowerCase()}
            </Porque>
            {l.eventos.length > 0 && (
              <>
                {' · '}
                <button onClick={() => setVerHistorico(!verHistorico)}
                  className="underline decoration-dotted decoration-gray-300 underline-offset-2">
                  {l.eventos.length} lançamento{l.eventos.length > 1 ? 's' : ''}
                </button>
              </>
            )}
          </p>
        </div>

        <button
          onClick={onLancar}
          className="shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-gray-900 text-white
                     hover:bg-gray-800 flex items-center gap-1"
        >
          <Plus className="w-3.5 h-3.5" /> Lançar
        </button>
      </div>

      {l.alertas.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {l.alertas.map((a, i) => (
            <span key={i} className="text-[11px] text-red-800 bg-red-100 rounded px-1.5 py-0.5">
              <Porque texto={a.porque} className="decoration-red-300 hover:decoration-red-500">
                {a.texto}
              </Porque>
            </span>
          ))}
        </div>
      )}

      {verHistorico && (
        <ul className="mt-2 space-y-1 border-t border-gray-100 pt-2">
          {[...l.eventos].reverse().map((e) => (
            <li key={e.id} className="flex items-start gap-2 text-[11px]">
              <div className="min-w-0 flex-1">
                <p className="text-gray-800">
                  <span className="font-medium">{rotuloSituacao(e.situacao)}</span>
                  <span className="text-gray-400"> · {diaHora(e.ocorrido_em)}</span>
                  {e.fonte && <span className="text-gray-400"> · {rotuloFonte(e.fonte)}</span>}
                </p>
                {e.descricao && <p className="text-gray-600">{e.descricao}</p>}
                {(e.recebedor || e.nova_previsao) && (
                  <p className="text-gray-500">
                    {e.recebedor && `Recebido por ${e.recebedor}`}
                    {e.documento_recebedor && ` (${e.documento_recebedor})`}
                    {e.nova_previsao && `Nova previsão: ${dia(e.nova_previsao)}`}
                  </p>
                )}
              </div>
              <button onClick={() => apagar.mutate(e.id)} title="Remover lançamento"
                className="text-gray-300 hover:text-red-600 shrink-0">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

const ROTULOS: Record<string, string> = {
  EM_TRANSITO: 'Em trânsito',
  SAIU_PARA_ENTREGA: 'Saiu para entrega',
  ENTREGUE: 'Entregue',
  COMPROVANTE_RECEBIDO: 'Entregue, canhoto recebido',
  PROBLEMA: 'Problema na entrega',
  SEM_RESPOSTA: 'Transportadora não respondeu',
}
const rotuloSituacao = (s: string) => ROTULOS[s] || s
const rotuloFonte = (f: string) => FONTES.find((x) => x.valor === f)?.rotulo || f

function ModalLancamento({ linha, situacoes, onFechar, onSalvo }: {
  linha: Linha
  situacoes: Painel['situacoes']
  onFechar: () => void
  onSalvo: () => void
}) {
  const [situacao, setSituacao] = useState('EM_TRANSITO')
  const [descricao, setDescricao] = useState('')
  const [recebedor, setRecebedor] = useState('')
  const [novaPrevisao, setNovaPrevisao] = useState('')

  const entrega = situacao === 'ENTREGUE' || situacao === 'COMPROVANTE_RECEBIDO'
  const fonte = (linha.transportadora || '').toUpperCase().includes('BRIX')
    ? 'BRIX_SISTEMA' : 'RR_WHATSAPP'

  const salvar = useMutation({
    mutationFn: () => api.post(`/rastreio/${linha.pedido_id}`, {
      situacao,
      fonte,
      descricao: descricao || null,
      recebedor: recebedor || null,
      nova_previsao: novaPrevisao || null,
    }),
    onSuccess: () => { toast.success('Lançado'); onSalvo() },
    onError: (e) => toast.error(msgErro(e, 'Não consegui lançar')),
  })

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 sm:p-4"
      onClick={onFechar}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-4 py-3 border-b border-gray-100">
          <div>
            <h2 className="text-sm font-bold text-gray-900">
              {linha.numero_pedido}{linha.numero_nf ? ` · NF ${linha.numero_nf}` : ''}
            </h2>
            <p className="text-xs text-gray-500">
              {linha.cliente} — {rotuloFonte(fonte)}
            </p>
          </div>
          <button onClick={onFechar} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="grid grid-cols-2 gap-1.5">
            {situacoes.map((s) => (
              <button
                key={s.valor}
                type="button"
                onClick={() => setSituacao(s.valor)}
                className={`text-xs px-2 py-2 rounded-lg border text-left
                  ${situacao === s.valor
                    ? 'border-gray-900 bg-gray-900 text-white'
                    : s.atencao
                      ? 'border-red-200 text-red-700 hover:bg-red-50'
                      : 'border-gray-200 text-gray-700 hover:bg-gray-50'}`}
              >
                {s.rotulo}
              </button>
            ))}
          </div>

          {entrega && (
            <input
              value={recebedor}
              onChange={(e) => setRecebedor(e.target.value)}
              placeholder="Quem recebeu (nome no canhoto)"
              className="w-full px-2.5 py-2 text-sm border border-gray-200 rounded-lg"
            />
          )}

          {!entrega && (
            <label className="block text-xs text-gray-600">
              Nova previsão, se a transportadora repactuou
              <input
                type="date"
                value={novaPrevisao}
                onChange={(e) => setNovaPrevisao(e.target.value)}
                className="mt-1 w-full px-2.5 py-2 text-sm border border-gray-200 rounded-lg"
              />
            </label>
          )}

          <textarea
            value={descricao}
            onChange={(e) => setDescricao(e.target.value)}
            rows={2}
            placeholder="O que a transportadora informou (opcional)"
            className="w-full px-2.5 py-2 text-sm border border-gray-200 rounded-lg"
          />
        </div>

        <div className="px-4 py-3 border-t border-gray-100 flex justify-end gap-2">
          <button onClick={onFechar} className="px-3 py-2 text-sm text-gray-600">Cancelar</button>
          <button
            onClick={() => salvar.mutate()}
            disabled={salvar.isPending}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-gray-900 text-white
                       hover:bg-gray-800 disabled:opacity-50"
          >
            {salvar.isPending ? 'Salvando…' : 'Lançar'}
          </button>
        </div>
      </div>
    </div>
  )
}

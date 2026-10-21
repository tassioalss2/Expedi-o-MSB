/**
 * Rastreio das entregas CIF.
 *
 * Hoje o acompanhamento vive em dois lugares que o app não enxerga: o portal da
 * BRIX e o grupo de WhatsApp da RR, onde a equipe cobra comprovante NF por NF.
 * O que a transportadora responde some na conversa — e some junto a resposta
 * para "essa carga chegou?".
 *
 * Aqui cada consulta vira um lançamento preso à OV. A tela abre no que exige
 * ação, não na lista inteira: carga atrasada, com ocorrência ou calada há dias.
 * Nada é importado de arquivo: quem sabe é quem olhou o portal e quem falou com
 * a transportadora.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Clock, FileCheck,
  MapPin, Plus, Search, Trash2, Truck, X,
} from 'lucide-react'
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
  endereco: string | null
  prioridade: string | null
  valor_nf: number | null
  codigo_rastreio: string | null
  situacao: string
  situacao_rotulo: string
  sem_lancamento: boolean
  aba: 'atencao' | 'transito' | 'sem_comprovante' | 'encerradas'
  atencao: boolean
  motivos: string[]
  previsao: string | null
  previsao_repactuada: boolean
  saida: string | null
  dias_desde_saida: number | null
  dias_sem_noticia: number | null
  entregue_em: string | null
  recebedor: string | null
  comprovante_em: string | null
  ultimo_evento: Evento | null
  eventos: Evento[]
}

type Painel = {
  linhas: Linha[]
  contagem: Record<string, number>
  por_transportadora: Record<string, { total: number; atencao: number; em_aberto: number }>
  situacoes: Array<{ valor: string; rotulo: string; atencao: boolean; fim: boolean }>
}

const ABAS = [
  { chave: 'atencao', rotulo: 'Exige atenção', icone: AlertTriangle },
  { chave: 'transito', rotulo: 'Em trânsito', icone: Truck },
  { chave: 'sem_comprovante', rotulo: 'Falta comprovante', icone: FileCheck },
  { chave: 'encerradas', rotulo: 'Encerradas', icone: CheckCircle2 },
] as const

const FONTES = [
  { valor: 'BRIX_SISTEMA', rotulo: 'Portal da BRIX' },
  { valor: 'RR_WHATSAPP', rotulo: 'WhatsApp da RR' },
  { valor: 'TRANSPORTADORA', rotulo: 'Transportadora (outro contato)' },
  { valor: 'CLIENTE', rotulo: 'Cliente' },
  { valor: 'OUTRO', rotulo: 'Outro' },
]

const dia = (d?: string | null) =>
  d ? new Date(d.length <= 10 ? `${d}T12:00:00` : d).toLocaleDateString('pt-BR') : '—'
const diaHora = (d?: string | null) =>
  d ? new Date(d).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'
const brl = (v?: number | null) =>
  (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

/** Primeiro dia do mês passado: o período que ainda pode ter carga viva. */
function inicioPadrao() {
  const d = new Date()
  d.setMonth(d.getMonth() - 1, 1)
  return d.toISOString().slice(0, 10)
}

export default function Rastreio() {
  const qc = useQueryClient()
  const [aba, setAba] = useState<(typeof ABAS)[number]['chave']>('atencao')
  const [transportadora, setTransportadora] = useState('')
  const [desde, setDesde] = useState(inicioPadrao())
  const [busca, setBusca] = useState('')
  const [lancando, setLancando] = useState<Linha | null>(null)
  const [aberta, setAberta] = useState<string | null>(null)

  const { data, isLoading } = useQuery<Painel>({
    queryKey: ['rastreio', desde, transportadora],
    queryFn: async () =>
      (await api.get('/rastreio', { params: { desde, transportadora: transportadora || undefined } })).data,
  })

  const linhas = useMemo(() => {
    const t = busca.trim().toLowerCase()
    return (data?.linhas || [])
      .filter((l) => l.aba === aba)
      .filter((l) =>
        !t ||
        [l.numero_pedido, l.numero_nf, l.cliente, l.destino, l.transportadora]
          .some((c) => (c || '').toLowerCase().includes(t)))
  }, [data, aba, busca])

  const apagar = useMutation({
    mutationFn: (id: string) => api.delete(`/rastreio/evento/${id}`),
    onSuccess: () => {
      toast.success('Lançamento removido')
      qc.invalidateQueries({ queryKey: ['rastreio'] })
    },
    onError: (e) => toast.error(msgErro(e, 'Não consegui remover o lançamento')),
  })

  return (
    <div className="p-4 sm:p-6 max-w-[1400px] mx-auto">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div>
          <h1 className="text-xl font-bold text-gray-900 flex items-center gap-2">
            <MapPin className="w-5 h-5 text-gray-400" /> Rastreio das entregas
          </h1>
          <p className="text-xs text-gray-500 mt-0.5">
            Só CIF — no FOB o frete é do cliente. O que a transportadora informar entra aqui.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative">
            <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-2.5" />
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="OV, NF, cliente ou destino"
              className="pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg w-60
                         focus:outline-none focus:ring-2 focus:ring-gray-200"
            />
          </div>
          <select
            value={transportadora}
            onChange={(e) => setTransportadora(e.target.value)}
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white"
          >
            <option value="">Todas as transportadoras</option>
            {Object.keys(data?.por_transportadora || {}).sort().map((t) => (
              <option key={t} value={t}>{t}</option>
            ))}
          </select>
          <input
            type="date"
            value={desde}
            onChange={(e) => setDesde(e.target.value)}
            title="Cargas que saíram a partir desta data"
            className="px-3 py-2 text-sm border border-gray-200 rounded-lg bg-white"
          />
        </div>
      </div>

      {data?.por_transportadora && Object.keys(data.por_transportadora).length > 0 && (
        <div className="mt-4 flex flex-wrap gap-2">
          {Object.entries(data.por_transportadora)
            .sort((a, b) => b[1].em_aberto - a[1].em_aberto)
            .map(([nome, n]) => (
              <div key={nome} className="rounded-xl border border-gray-200 bg-white px-3 py-2">
                <p className="text-xs font-semibold text-gray-800">{nome}</p>
                <p className="text-[11px] text-gray-500">
                  {n.em_aberto} em aberto
                  {n.atencao > 0 && <span className="text-red-600"> · {n.atencao} exigem atenção</span>}
                </p>
              </div>
            ))}
        </div>
      )}

      <div className="mt-4 flex flex-wrap gap-1 border-b border-gray-200">
        {ABAS.map(({ chave, rotulo, icone: Icone }) => (
          <button
            key={chave}
            onClick={() => setAba(chave)}
            className={`px-3 py-2 text-sm font-medium flex items-center gap-1.5 border-b-2 -mb-px
              ${aba === chave
                ? 'border-gray-900 text-gray-900'
                : 'border-transparent text-gray-500 hover:text-gray-700'}`}
          >
            <Icone className={`w-4 h-4 ${chave === 'atencao' && (data?.contagem?.atencao || 0) > 0
              ? 'text-red-500' : ''}`} />
            {rotulo}
            <span className="text-xs text-gray-400">{data?.contagem?.[chave] ?? 0}</span>
          </button>
        ))}
      </div>

      {isLoading ? (
        <p className="mt-6 text-sm text-gray-500">Carregando…</p>
      ) : linhas.length === 0 ? (
        <p className="mt-6 text-sm text-gray-500">
          {aba === 'atencao'
            ? 'Nenhuma carga exigindo atenção neste período.'
            : 'Nada por aqui neste período.'}
        </p>
      ) : (
        <div className="mt-3 space-y-2">
          {linhas.map((l) => (
            <CardCarga
              key={l.pedido_id}
              linha={l}
              aberta={aberta === l.pedido_id}
              onAbrir={() => setAberta(aberta === l.pedido_id ? null : l.pedido_id)}
              onLancar={() => setLancando(l)}
              onApagar={(id) => apagar.mutate(id)}
            />
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

function CardCarga({ linha: l, aberta, onAbrir, onLancar, onApagar }: {
  linha: Linha
  aberta: boolean
  onAbrir: () => void
  onLancar: () => void
  onApagar: (id: string) => void
}) {
  const cor = l.aba === 'atencao' ? 'border-red-200 bg-red-50/40'
    : l.aba === 'encerradas' ? 'border-gray-200 bg-gray-50/60'
      : 'border-gray-200 bg-white'

  return (
    <div className={`rounded-xl border ${cor} px-3 py-2.5`}>
      <div className="flex flex-wrap items-start gap-3 justify-between">
        <button onClick={onAbrir} className="flex items-start gap-2 text-left min-w-0">
          {aberta ? <ChevronDown className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />
            : <ChevronRight className="w-4 h-4 text-gray-400 mt-0.5 shrink-0" />}
          <div className="min-w-0">
            <p className="text-sm font-semibold text-gray-900 truncate">
              {l.numero_pedido || '—'}
              {l.numero_nf && <span className="text-gray-400 font-normal"> · NF {l.numero_nf}</span>}
              {l.prioridade === 'URGENTE' && (
                <span className="ml-2 text-[10px] font-bold text-red-700 bg-red-100 px-1.5 py-0.5 rounded">
                  URGENTE
                </span>
              )}
            </p>
            <p className="text-xs text-gray-600 truncate">{l.cliente || '—'}</p>
            <p className="text-[11px] text-gray-500 truncate">
              {l.destino || '—'} · {l.transportadora || 'sem transportadora'}
              {l.codigo_rastreio && ` · ${l.codigo_rastreio}`}
            </p>
          </div>
        </button>

        <div className="text-right text-[11px] text-gray-600 shrink-0">
          <p className={l.sem_lancamento ? 'text-gray-400 italic' : 'font-semibold text-gray-800'}>
            {l.sem_lancamento ? 'Sem acompanhamento' : l.situacao_rotulo}
          </p>
          <p>Saiu {dia(l.saida)} · previsão {dia(l.previsao)}
            {l.previsao_repactuada && <span title="prazo repactuado pela transportadora"> *</span>}
          </p>
          {l.entregue_em && (
            <p className="text-green-700">
              Entregue {diaHora(l.entregue_em)}{l.recebedor ? ` · ${l.recebedor}` : ''}
            </p>
          )}
        </div>

        <button
          onClick={onLancar}
          className="shrink-0 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-gray-900 text-white
                     hover:bg-gray-800 flex items-center gap-1"
        >
          <Plus className="w-3.5 h-3.5" /> Lançar
        </button>
      </div>

      {l.motivos.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1 pl-6">
          {l.motivos.map((m, i) => (
            <span key={i} className="text-[11px] text-red-800 bg-red-100 rounded px-1.5 py-0.5">
              {m}
            </span>
          ))}
        </div>
      )}

      {aberta && (
        <div className="mt-2.5 pl-6 border-t border-gray-100 pt-2">
          <p className="text-[11px] text-gray-500 mb-1.5">
            {l.endereco ? `${l.endereco} · ` : ''}{brl(l.valor_nf)}
            {l.dias_sem_noticia != null && ` · última notícia há ${l.dias_sem_noticia} dia(s)`}
          </p>
          {l.eventos.length === 0 ? (
            <p className="text-xs text-gray-400 italic">
              Nenhum acompanhamento lançado nesta carga.
            </p>
          ) : (
            <ul className="space-y-1.5">
              {[...l.eventos].reverse().map((e) => (
                <li key={e.id} className="flex items-start gap-2 text-xs">
                  <Clock className="w-3.5 h-3.5 text-gray-300 mt-0.5 shrink-0" />
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
                  <button
                    onClick={() => onApagar(e.id)}
                    title="Remover lançamento"
                    className="text-gray-300 hover:text-red-600 shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

const ROTULOS: Record<string, string> = {
  EM_TRANSITO: 'Em trânsito',
  SAIU_PARA_ENTREGA: 'Saiu para entrega',
  AGENDADA: 'Entrega agendada',
  ENTREGUE: 'Entregue',
  COMPROVANTE_RECEBIDO: 'Comprovante recebido',
  OCORRENCIA: 'Ocorrência',
  RECUSADA: 'Recusada pelo cliente',
  EXTRAVIO: 'Extravio',
  DEVOLUCAO: 'Em devolução',
  SEM_INFORMACAO: 'Transportadora não informou',
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
  const [quando, setQuando] = useState(() => {
    const d = new Date()
    d.setMinutes(d.getMinutes() - d.getTimezoneOffset())
    return d.toISOString().slice(0, 16)
  })
  const [fonte, setFonte] = useState(
    (linha.transportadora || '').toUpperCase().includes('BRIX') ? 'BRIX_SISTEMA' : 'RR_WHATSAPP')
  const [descricao, setDescricao] = useState('')
  const [recebedor, setRecebedor] = useState('')
  const [documento, setDocumento] = useState('')
  const [novaPrevisao, setNovaPrevisao] = useState('')

  const entrega = situacao === 'ENTREGUE' || situacao === 'COMPROVANTE_RECEBIDO'

  const salvar = useMutation({
    mutationFn: () => api.post(`/rastreio/${linha.pedido_id}`, {
      situacao,
      ocorrido_em: new Date(quando).toISOString(),
      fonte,
      descricao: descricao || null,
      recebedor: recebedor || null,
      documento_recebedor: documento || null,
      nova_previsao: novaPrevisao || null,
    }),
    onSuccess: () => {
      toast.success('Acompanhamento lançado')
      onSalvo()
    },
    onError: (e) => toast.error(msgErro(e, 'Não consegui lançar o acompanhamento')),
  })

  return (
    <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4"
      onClick={onFechar}>
      <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-lg max-h-[92vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-start justify-between px-4 py-3 border-b border-gray-100 sticky top-0 bg-white">
          <div>
            <h2 className="text-sm font-bold text-gray-900">Lançar acompanhamento</h2>
            <p className="text-xs text-gray-500">
              {linha.numero_pedido}{linha.numero_nf ? ` · NF ${linha.numero_nf}` : ''} — {linha.cliente}
            </p>
          </div>
          <button onClick={onFechar} className="text-gray-400 hover:text-gray-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div>
            <label className="text-xs font-medium text-gray-600">Situação</label>
            <div className="mt-1 grid grid-cols-2 gap-1.5">
              {situacoes.map((s) => (
                <button
                  key={s.valor}
                  type="button"
                  onClick={() => setSituacao(s.valor)}
                  className={`text-xs px-2 py-1.5 rounded-lg border text-left
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
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-xs font-medium text-gray-600">Quando aconteceu</label>
              <input
                type="datetime-local"
                value={quando}
                onChange={(e) => setQuando(e.target.value)}
                className="mt-1 w-full px-2.5 py-2 text-sm border border-gray-200 rounded-lg"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-gray-600">Onde você viu</label>
              <select
                value={fonte}
                onChange={(e) => setFonte(e.target.value)}
                className="mt-1 w-full px-2.5 py-2 text-sm border border-gray-200 rounded-lg bg-white"
              >
                {FONTES.map((f) => <option key={f.valor} value={f.valor}>{f.rotulo}</option>)}
              </select>
            </div>
          </div>

          {entrega && (
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="text-xs font-medium text-gray-600">Quem recebeu</label>
                <input
                  value={recebedor}
                  onChange={(e) => setRecebedor(e.target.value)}
                  placeholder="nome no canhoto"
                  className="mt-1 w-full px-2.5 py-2 text-sm border border-gray-200 rounded-lg"
                />
              </div>
              <div>
                <label className="text-xs font-medium text-gray-600">Documento / matrícula</label>
                <input
                  value={documento}
                  onChange={(e) => setDocumento(e.target.value)}
                  className="mt-1 w-full px-2.5 py-2 text-sm border border-gray-200 rounded-lg"
                />
              </div>
            </div>
          )}

          {!entrega && (
            <div>
              <label className="text-xs font-medium text-gray-600">
                Nova previsão de entrega <span className="text-gray-400">(se a transportadora repactuou)</span>
              </label>
              <input
                type="date"
                value={novaPrevisao}
                onChange={(e) => setNovaPrevisao(e.target.value)}
                className="mt-1 w-full px-2.5 py-2 text-sm border border-gray-200 rounded-lg"
              />
            </div>
          )}

          <div>
            <label className="text-xs font-medium text-gray-600">
              O que a transportadora informou
            </label>
            <textarea
              value={descricao}
              onChange={(e) => setDescricao(e.target.value)}
              rows={3}
              placeholder="ex.: carga em Guarulhos, sai para entrega amanhã"
              className="mt-1 w-full px-2.5 py-2 text-sm border border-gray-200 rounded-lg"
            />
          </div>
        </div>

        <div className="px-4 py-3 border-t border-gray-100 flex justify-end gap-2 sticky bottom-0 bg-white">
          <button onClick={onFechar} className="px-3 py-2 text-sm text-gray-600 hover:text-gray-800">
            Cancelar
          </button>
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

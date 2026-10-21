/**
 * Rastreio das entregas CIF.
 *
 * O acompanhamento vive no portal da BRIX e no grupo de WhatsApp da RR: o que a
 * transportadora responde some na conversa, e some junto a resposta para "essa
 * carga chegou?". Aqui cada informação vira um lançamento preso à OV.
 *
 * A tela é organizada por TRANSPORTADORA porque a cobrança é por transportadora:
 * o portal da BRIX de manhã, o grupo da RR durante o dia. Dentro de cada uma,
 * três grupos e uma lista em colunas alinhadas.
 *
 * Tudo que classifica uma carga é clicável e diz de onde veio: o corte de data,
 * cada grupo, cada alerta, a saída, a previsão e a situação trazem do backend a
 * regra e os números que os geraram.
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, Plus, Search, Trash2, X } from 'lucide-react'
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
  entregue_em: string | null
  recebedor: string | null
  eventos: Evento[]
}

type Contador = { total: number; aberto: number; canhoto: number; concluidas: number; atencao: number }

type Painel = {
  desde: string
  linhas: Linha[]
  contagem: { aberto: number; canhoto: number; concluidas: number; atencao: number }
  transportadoras: string[]
  por_transportadora: Record<string, Contador>
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
  const [transportadora, setTransportadora] = useState('')
  const [grupo, setGrupo] = useState<(typeof GRUPOS)[number]['chave']>('aberto')
  const [soAtencao, setSoAtencao] = useState(false)
  const [busca, setBusca] = useState('')
  const [lancando, setLancando] = useState<Linha | null>(null)

  const { data, isLoading } = useQuery<Painel>({
    queryKey: ['rastreio'],
    queryFn: async () => (await api.get('/rastreio')).data,
  })

  const daTransportadora = useMemo(
    () => (data?.linhas || []).filter((l) => !transportadora || l.transportadora === transportadora),
    [data, transportadora])

  const contagem: Contador = useMemo(() => {
    const c: Contador = { total: 0, aberto: 0, canhoto: 0, concluidas: 0, atencao: 0 }
    daTransportadora.forEach((l) => {
      c.total += 1
      c[l.grupo] += 1
      if (l.atencao) c.atencao += 1
    })
    return c
  }, [daTransportadora])

  const linhas = useMemo(() => {
    const t = busca.trim().toLowerCase()
    return daTransportadora
      .filter((l) => l.grupo === grupo)
      .filter((l) => !soAtencao || l.atencao)
      .filter((l) => !t || [l.numero_pedido, l.numero_nf, l.cliente, l.destino]
        .some((c) => (c || '').toLowerCase().includes(t)))
  }, [daTransportadora, grupo, soAtencao, busca])

  const todas: Contador = useMemo(() => {
    const c: Contador = { total: 0, aberto: 0, canhoto: 0, concluidas: 0, atencao: 0 }
    Object.values(data?.por_transportadora || {}).forEach((t) => {
      c.total += t.total; c.aberto += t.aberto; c.canhoto += t.canhoto
      c.concluidas += t.concluidas; c.atencao += t.atencao
    })
    return c
  }, [data])

  return (
    <div className="p-4 sm:p-6 max-w-6xl mx-auto">
      <h1 className="text-xl font-bold text-gray-900">Rastreio de entregas</h1>
      <p className="text-xs text-gray-500 mt-1">
        <Porque texto={data?.regras?.corte || ''}>
          O que saiu daqui desde {dia(data?.desde)}
        </Porque>
        {' · '}
        <Porque texto={data?.regras?.cif || ''}>só frete CIF</Porque>
      </p>

      <div className="mt-4 grid grid-cols-2 sm:grid-cols-4 gap-2">
        <CardTransportadora
          nome="Todas" dados={todas} ativo={!transportadora}
          onClick={() => setTransportadora('')} />
        {Object.entries(data?.por_transportadora || {})
          .sort((a, b) => b[1].aberto - a[1].aberto)
          .map(([nome, c]) => (
            <CardTransportadora
              key={nome} nome={nome} dados={c} ativo={transportadora === nome}
              onClick={() => setTransportadora(transportadora === nome ? '' : nome)} />
          ))}
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <div className="inline-flex p-0.5 bg-gray-100 rounded-lg">
          {GRUPOS.map((g) => (
            <button
              key={g.chave}
              onClick={() => { setGrupo(g.chave); setSoAtencao(false) }}
              className={`px-3 py-1.5 rounded-md text-sm transition
                ${grupo === g.chave ? 'bg-white shadow-sm text-gray-900 font-medium'
                  : 'text-gray-500 hover:text-gray-700'}`}
            >
              {g.rotulo} <span className="text-gray-400">{contagem[g.chave]}</span>
            </button>
          ))}
        </div>

        {grupo === 'aberto' && contagem.atencao > 0 && (
          <button
            onClick={() => setSoAtencao(!soAtencao)}
            className={`flex items-center gap-1.5 text-sm px-2.5 py-1.5 rounded-lg border
              ${soAtencao ? 'border-red-300 bg-red-50 text-red-800'
                : 'border-gray-200 text-gray-700 hover:border-red-200'}`}
          >
            <AlertTriangle className="w-4 h-4 text-red-500" />
            {contagem.atencao} exigem atenção
          </button>
        )}

        <span className="text-[11px] text-gray-400">
          <Porque texto={data?.regras?.[grupo] || ''}>o que entra neste grupo</Porque>
          {grupo === 'aberto' && (
            <>{' · '}<Porque texto={data?.regras?.atencao || ''}>o que é atenção</Porque></>
          )}
        </span>

        <div className="relative ml-auto">
          <Search className="w-4 h-4 text-gray-400 absolute left-2.5 top-2.5" />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="NF, OV, cliente"
            className="pl-8 pr-3 py-2 text-sm border border-gray-200 rounded-lg w-full sm:w-56
                       focus:outline-none focus:ring-2 focus:ring-gray-200"
          />
        </div>
      </div>

      {isLoading ? (
        <p className="mt-6 text-sm text-gray-500">Carregando…</p>
      ) : linhas.length === 0 ? (
        <p className="mt-6 text-sm text-gray-500">Nada por aqui.</p>
      ) : (
        <div className="mt-3 border border-gray-200 rounded-xl bg-white overflow-hidden">
          <div className="hidden sm:grid grid-cols-12 gap-3 px-3 py-2 bg-gray-50 border-b
                          border-gray-200 text-[10px] uppercase tracking-wide text-gray-500">
            <div className="col-span-2">NF · OV</div>
            <div className="col-span-3">Cliente</div>
            <div className="col-span-2">Destino</div>
            <div className="col-span-2">Saída · previsão</div>
            <div className="col-span-2">Situação</div>
            <div className="col-span-1" />
          </div>
          <div className="divide-y divide-gray-100">
            {linhas.map((l) => (
              <Carga key={l.pedido_id} linha={l} onLancar={() => setLancando(l)}
                onMudou={() => qc.invalidateQueries({ queryKey: ['rastreio'] })} />
            ))}
          </div>
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

function CardTransportadora({ nome, dados, ativo, onClick }: {
  nome: string; dados: Contador; ativo: boolean; onClick: () => void
}) {
  return (
    <button
      onClick={onClick}
      className={`rounded-xl border px-3 py-2 text-left transition
        ${ativo ? 'border-gray-900 bg-gray-900 text-white'
          : 'border-gray-200 bg-white hover:border-gray-300'}`}
    >
      <p className={`text-xs font-semibold truncate ${ativo ? 'text-white' : 'text-gray-800'}`}>
        {nome}
      </p>
      <p className={`text-lg font-bold leading-tight ${ativo ? 'text-white' : 'text-gray-900'}`}>
        {dados.aberto}
        <span className={`text-[11px] font-normal ml-1 ${ativo ? 'text-white/70' : 'text-gray-400'}`}>
          em aberto
        </span>
      </p>
      <p className="text-[11px]">
        {dados.atencao > 0 && (
          <span className={ativo ? 'text-red-200' : 'text-red-600'}>{dados.atencao} atenção</span>
        )}
        {dados.canhoto > 0 && (
          <span className={ativo ? 'text-white/70' : 'text-gray-500'}>
            {dados.atencao > 0 ? ' · ' : ''}{dados.canhoto} sem canhoto
          </span>
        )}
        {dados.atencao === 0 && dados.canhoto === 0 && (
          <span className={ativo ? 'text-white/70' : 'text-gray-400'}>tudo em dia</span>
        )}
      </p>
    </button>
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
    <div className={l.atencao ? 'bg-red-50/40' : ''}>
      <div className="grid grid-cols-12 gap-3 px-3 py-2.5 items-start text-xs">
        <div className="col-span-8 sm:col-span-2">
          <p className="font-semibold text-gray-900">
            {l.numero_nf ? `NF ${l.numero_nf}` : 'sem NF'}
            {l.prioridade === 'URGENTE' && (
              <span className="ml-1.5 text-[9px] font-bold text-red-700 bg-red-100 px-1 py-0.5 rounded">
                URGENTE
              </span>
            )}
          </p>
          <p className="text-gray-400">{l.numero_pedido}</p>
        </div>

        <div className="col-span-12 sm:col-span-3 order-last sm:order-none">
          <p className="text-gray-800 truncate" title={l.cliente || ''}>{l.cliente || '—'}</p>
          <p className="text-gray-400 sm:hidden">{l.destino}</p>
        </div>

        <div className="hidden sm:block sm:col-span-2 text-gray-600 truncate">{l.destino || '—'}</div>

        <div className="col-span-6 sm:col-span-2 text-gray-600">
          <Porque texto={l.explicacao.saida}>{dia(l.saida)}</Porque>
          {' → '}
          <Porque texto={l.explicacao.previsao}>{dia(l.previsao)}</Porque>
        </div>

        <div className="col-span-6 sm:col-span-2">
          <Porque texto={l.explicacao.situacao}
            className={l.sem_lancamento ? 'text-gray-400' : 'text-gray-800'}>
            {l.sem_lancamento ? 'sem acompanhamento' : l.situacao_rotulo}
          </Porque>
          {l.eventos.length > 0 && (
            <button onClick={() => setVerHistorico(!verHistorico)}
              className="block text-[10px] text-gray-400 hover:text-gray-600 underline
                         decoration-dotted underline-offset-2">
              {l.eventos.length} lançamento{l.eventos.length > 1 ? 's' : ''}
            </button>
          )}
        </div>

        <div className="col-span-4 sm:col-span-1 flex justify-end">
          <button
            onClick={onLancar}
            className="px-2 py-1.5 text-[11px] font-medium rounded-lg bg-gray-900 text-white
                       hover:bg-gray-800 flex items-center gap-1"
          >
            <Plus className="w-3 h-3" /> Lançar
          </button>
        </div>
      </div>

      {l.alertas.length > 0 && (
        <div className="px-3 pb-2 flex flex-wrap gap-1">
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
        <ul className="px-3 pb-2.5 space-y-1 border-t border-gray-100 pt-2">
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
              {linha.numero_nf ? `NF ${linha.numero_nf}` : linha.numero_pedido}
              <span className="font-normal text-gray-400"> · {linha.numero_pedido}</span>
            </h2>
            <p className="text-xs text-gray-500">{linha.cliente} — {rotuloFonte(fonte)}</p>
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

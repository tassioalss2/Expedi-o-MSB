import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { FileText, ExternalLink, FileSpreadsheet } from 'lucide-react'
import api from '../lib/api'
import { errMsg } from '../lib/errMsg'
import { resolveNomeTransportadora } from '../lib/statusConfig'
import toast from 'react-hot-toast'

const CORES: Record<string, string> = {
  'BRIX':     'bg-blue-600',
  'RR CARGO': 'bg-orange-600',
  'CORREIOS': 'bg-yellow-500',
  'OUTROS':   'bg-gray-500',
}

function calcDias(dt?: string): number {
  if (!dt) return 0
  try {
    return Math.floor((Date.now() - new Date(dt).getTime()) / 86400000)
  } catch {
    return 0
  }
}

type Passagens = {
  hoje: string
  transportadoras: Record<string, {
    passou_hoje: boolean
    aguardando_agora: number
    aguardando_desde: string | null
    falhas: number
    dias: Array<{
      dia: string; passou: boolean; primeira: string | null; ultima: string | null
      coletadas: number; entraram_depois: number; esperando: number
      falha: boolean; hoje: boolean
    }>
  }>
}

export function Pallets() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [modal, setModal] = useState<string | null>(null)
  const [ovInput, setOvInput] = useState('')
  const [modoColeta, setModoColeta] = useState<string | null>(null) // pallet_id em modo coleta
  const [selecionadas, setSelecionadas] = useState<Set<string>>(new Set())

  // Quem passou aqui nos últimos dias. Sai das coletas que o operador já
  // registra: registrar a coleta de uma carga é dizer que o carro esteve aqui.
  const { data: passagens } = useQuery<Passagens>({
    queryKey: ['coletas-passagens'],
    queryFn: async () => (await api.get('/coletas/passagens', { params: { dias: 10 } })).data,
    refetchInterval: 5 * 60 * 1000,
  })

  const { data, isLoading } = useQuery({
    queryKey: ['pallets'],
    queryFn: () => api.get('/pallets').then(r => r.data),
    refetchInterval: 30000,
  })

  const pallets: any[] = Array.isArray(data) ? data : []
  const FIXOS = ['PLT-BRIX', 'PLT-RR CARGO', 'PLT-CORREIOS', 'PLT-OUTROS']
  // Pallets fixos SEMPRE aparecem (mesmo se COLETADO — voltam vazios)
  const fixos = FIXOS.map(cod => pallets.find(p => p.codigo === cod)).filter(Boolean)
  // Pallets extras só aparecem se ativos (não coletados)
  const extras = pallets.filter(p => p && !FIXOS.includes(p.codigo) && p.status !== 'COLETADO')
  const todos: any[] = [...fixos, ...extras]

  const adicionar = useMutation({
    mutationFn: (palletId: string) =>
      api.post(`/pallets/${palletId}/pedidos`, {
        pedido_id: ovInput,
      }),
    onSuccess: () => {
      toast.success('OV adicionada!')
      qc.invalidateQueries({ queryKey: ['pallets'] })
      qc.invalidateQueries({ queryKey: ['pedidos'] })
      setModal(null)
      setOvInput('')
    },
    onError: (e: any) => toast.error(errMsg(e, 'Erro ao adicionar OV')),
  })

  const coletar = useMutation({
    mutationFn: ({ palletId, pedidoIds }: { palletId: string; pedidoIds: string[] }) =>
      api.post(`/pallets/${palletId}/coletar`, { pedido_ids: pedidoIds }),
    onSuccess: (res) => {
      toast.success(`✅ ${res.data?.pedidos_expedidos || 0} OV(s) expedida(s)!`)
      qc.invalidateQueries({ queryKey: ['pallets'] })
      qc.invalidateQueries({ queryKey: ['pedidos'] })
      setModoColeta(null)
      setSelecionadas(new Set())
    },
    onError: (e: any) => toast.error(errMsg(e, 'Erro ao confirmar coleta')),
  })

  const toggleSelecao = (pedidoId: string) => {
    setSelecionadas(prev => {
      const novo = new Set(prev)
      novo.has(pedidoId) ? novo.delete(pedidoId) : novo.add(pedidoId)
      return novo
    })
  }

  const iniciarModoColeta = (palletId: string, pedidos: any[]) => {
    setModoColeta(palletId)
    // Seleciona todas por padrão
    setSelecionadas(new Set(pedidos.map((pp: any) => pp.id)))
  }

  const confirmarColeta = (palletId: string) => {
    if (selecionadas.size === 0) {
      toast.error('Selecione ao menos uma OV para coletar')
      return
    }
    coletar.mutate({ palletId, pedidoIds: Array.from(selecionadas) })
  }

  if (isLoading) {
    return <div className="p-8 text-center text-gray-400">Carregando pallets...</div>
  }

  return (
    <div className="p-6 space-y-5">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Pallets — Aguardando Coleta</h1>
          <p className="text-sm text-gray-500">{todos.reduce((a, p) => a + (p?.pedidos?.length || 0), 0)} OV(s) aguardando</p>
        </div>
        <div className="flex items-center gap-2">
          {/* O que sai hoje, no modelo que a transportadora usa para montar o
              carro. Baixa e vai para o grupo — substitui o aviso carga a carga. */}
          <button
            onClick={async () => {
              try {
                const r = await api.get('/programacao-coleta/planilha',
                  { responseType: 'blob' })
                const url = URL.createObjectURL(new Blob([r.data]))
                const a = document.createElement('a')
                a.href = url
                a.download = `Programacao de coleta ${new Date()
                  .toLocaleDateString('pt-BR').replace(/\//g, '-')} - BRIX.xlsx`
                a.click()
                URL.revokeObjectURL(url)
                toast.success('Programação baixada — mande no grupo da transportadora.')
              } catch {
                toast.error('Não consegui gerar a programação.')
              }
            }}
            className="flex items-center gap-2 px-4 py-2.5 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg text-sm font-medium shadow-sm"
          >
            <FileSpreadsheet size={16} />
            Programação de coleta
          </button>
          <button
            onClick={() => navigate('/relatorio/coleta')}
            className="flex items-center gap-2 px-4 py-2.5 border border-gray-300 bg-white text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 shadow-sm"
          >
            <FileText size={16} />
            Coletas Pendentes
          </button>
          <button
            onClick={() => navigate('/relatorio/coletas-realizadas')}
            className="flex items-center gap-2 px-4 py-2.5 border border-gray-300 bg-white text-gray-700 rounded-lg text-sm font-medium hover:bg-gray-50 shadow-sm"
          >
            <FileText size={16} />
            Coletas Realizadas
          </button>
        </div>
      </div>

      {/* Passagem das transportadoras com coleta diária combinada. Carga que
          entra depois do carro não é falha delas — é carga que não estava
          pronta na hora. */}
      {passagens && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {Object.entries(passagens.transportadoras).map(([nome, t]) => (
            <div key={nome} className="bg-white border border-gray-200 rounded-xl px-4 py-3">
              <div className="flex items-baseline justify-between gap-2">
                <p className="font-semibold text-gray-800">{nome}</p>
                <span className={`text-xs font-medium px-2 py-0.5 rounded-full ${
                  t.passou_hoje ? 'bg-emerald-100 text-emerald-800' : 'bg-gray-100 text-gray-600'}`}>
                  {t.passou_hoje ? 'passou hoje' : 'ainda não passou hoje'}
                </span>
              </div>
              <p className="text-xs text-gray-500 mt-0.5">
                {t.aguardando_agora > 0
                  ? `${t.aguardando_agora} carga(s) no pallet${t.aguardando_desde
                    ? ', a mais antiga de ' + t.aguardando_desde.split('-').reverse().slice(0, 2).join('/')
                    : ''}`
                  : 'nada esperando'}
              </p>
              <div className="mt-2 flex gap-1">
                {[...t.dias].reverse().map((d) => (
                  <span key={d.dia}
                    title={`${d.dia.split('-').reverse().join('/')} — ${
                      d.passou ? `passou ${d.primeira}${d.ultima !== d.primeira ? '–' + d.ultima : ''}, ${d.coletadas} carga(s)`
                        : d.falha ? `não passou, ${d.esperando} carga(s) esperando`
                          : 'não passou, nada esperando'}${
                      d.entraram_depois ? ` · ${d.entraram_depois} entrou depois do carro` : ''}`}
                    className={`h-6 flex-1 rounded ${
                      d.falha ? 'bg-red-400'
                        : d.passou ? 'bg-emerald-400'
                          : d.hoje ? 'bg-gray-200' : 'bg-gray-100'}`} />
                ))}
              </div>
              <p className="text-[11px] text-gray-400 mt-1">
                últimos dias úteis · {t.falhas === 0
                  ? 'sem falha de coleta'
                  : `${t.falhas} dia(s) sem passar tendo carga`}
              </p>
            </div>
          ))}
        </div>
      )}


      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {todos.map((pallet: any) => {
          if (!pallet) return null
          const nome = pallet.transportadora_nome || ''
          const isTemp = pallet.pallet_temp === true
          const cor = CORES[nome] || (isTemp ? 'bg-indigo-600' : 'bg-gray-500')
          const pedidos: any[] = pallet.pedidos || []

          return (
            <div key={pallet.id} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className={`${cor} px-4 py-3 flex justify-between items-center`}>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <p className="font-bold text-white text-sm truncate">{nome || pallet.codigo}</p>
                    {isTemp && (
                      <span className="flex-shrink-0 text-[10px] font-semibold bg-white bg-opacity-25 text-white px-1.5 py-0.5 rounded-full">
                        TEMP
                      </span>
                    )}
                  </div>
                  <p className="text-white text-xs opacity-75">{pallet.codigo}</p>
                </div>
                <span className="text-white font-bold text-2xl ml-2 flex-shrink-0">{pedidos.length}</span>
              </div>

              {modoColeta === pallet.id && (
                <div className="px-3 pt-2 pb-1 bg-green-50 border-b border-green-200">
                  <p className="text-xs font-semibold text-green-700">
                    ✅ Selecione as OVs coletadas ({selecionadas.size}/{pedidos.length})
                  </p>
                  <div className="flex gap-2 mt-1">
                    <button onClick={() => setSelecionadas(new Set(pedidos.map((pp: any) => pp.id)))}
                      className="text-xs text-green-600 hover:underline">Todas</button>
                    <button onClick={() => setSelecionadas(new Set())}
                      className="text-xs text-gray-500 hover:underline">Nenhuma</button>
                  </div>
                </div>
              )}

              <div className="p-3 space-y-2 min-h-[100px] max-h-[280px] overflow-y-auto">
                {pedidos.length === 0 && (
                  <p className="text-center text-gray-300 text-sm py-4">Nenhuma OV</p>
                )}
                {pedidos.map((pp: any, i: number) => {
                  const dias = calcDias(pp?.adicionado_em)
                  const corDias = dias === 0 ? 'text-green-600' : dias <= 2 ? 'text-yellow-600' : 'text-red-600'
                  const emModoColeta = modoColeta === pallet.id
                  const selecionada = selecionadas.has(pp?.id)

                  return (
                    <div
                      key={pp?.id || i}
                      onClick={() => {
                        if (emModoColeta && pp?.id) { toggleSelecao(pp.id); return }
                        if (!emModoColeta && pp?.pedido_id) navigate(`/expedicao/${pp.pedido_id}`)
                      }}
                      className={`p-2 rounded border text-sm transition-colors group
                        ${emModoColeta ? 'cursor-pointer' : 'cursor-pointer hover:shadow-md hover:border-blue-300'}
                        ${emModoColeta && selecionada ? 'bg-green-50 border-green-300' : ''}
                        ${emModoColeta && !selecionada ? 'bg-gray-50 border-gray-100 opacity-50' : ''}
                        ${!emModoColeta && dias > 3 ? 'bg-red-50 border-red-200' : ''}
                        ${!emModoColeta && dias <= 3 ? 'bg-gray-50 border-gray-100' : ''}
                      `}
                    >
                      <div className="flex justify-between items-start gap-2">
                        {emModoColeta && (
                          <input
                            type="checkbox"
                            checked={selecionada}
                            onChange={() => pp?.id && toggleSelecao(pp.id)}
                            className="mt-0.5 accent-green-600 w-4 h-4 flex-shrink-0"
                            onClick={e => e.stopPropagation()}
                          />
                        )}
                        <div className="flex-1 min-w-0">
                          <div className="flex justify-between items-center">
                            <div className="flex items-center gap-1">
                              <span className="font-bold">{pp?.pedidos?.numero_pedido || '—'}</span>
                              {!emModoColeta && <ExternalLink size={10} className="text-gray-300 group-hover:text-blue-400 flex-shrink-0" />}
                            </div>
                            <span className={`text-xs font-bold ${corDias}`}>
                              {dias === 0 ? 'Hoje' : `${dias}d`}
                            </span>
                          </div>

                          <p className="text-xs text-gray-500 truncate">{pp?.pedidos?.clientes?.nome || '—'}</p>
                          <div className="flex items-center gap-2 mt-0.5">
                            {pp?.pedidos?.numero_nf && (
                              <span className="text-xs font-semibold text-indigo-600">NF {pp.pedidos.numero_nf}</span>
                            )}
                            {pp?.num_caixas && <p className="text-xs text-gray-400">{pp.num_caixas} cx</p>}
                            {pallet.codigo === 'PLT-OUTROS' && pp?.pedidos?.transportadora_nome && (() => {
                              const nomeReal = resolveNomeTransportadora(pp.pedidos.transportadora_nome, pp.pedidos.observacoes)
                              return (
                                <span className="text-xs bg-gray-200 text-gray-700 px-1.5 py-0.5 rounded font-medium">
                                  🚚 {nomeReal}
                                </span>
                              )
                            })()}
                          </div>
                        </div>
                      </div>
                    </div>
                  )
                })}
              </div>

              <div className="p-3 border-t bg-gray-50 flex gap-2">
                {modoColeta === pallet.id ? (
                  <>
                    <button
                      onClick={() => { setModoColeta(null); setSelecionadas(new Set()) }}
                      className="flex-1 text-xs py-2 border border-gray-300 bg-white text-gray-600 rounded-lg hover:bg-gray-50"
                    >
                      Cancelar
                    </button>
                    <button
                      onClick={() => confirmarColeta(pallet.id)}
                      disabled={coletar.isPending || selecionadas.size === 0}
                      className="flex-1 text-xs py-2 bg-green-600 text-white rounded-lg hover:bg-green-500 disabled:opacity-50 font-medium"
                    >
                      {coletar.isPending ? '...' : `✅ Confirmar (${selecionadas.size})`}
                    </button>
                  </>
                ) : (
                  <>
                    <button
                      onClick={() => { setModal(pallet.id); setOvInput('') }}
                      className="flex-1 text-xs py-2 bg-white border border-gray-200 rounded-lg hover:bg-gray-50"
                    >
                      + Adicionar OV
                    </button>
                    {pedidos.length > 0 && (
                      <button
                        onClick={() => iniciarModoColeta(pallet.id, pedidos)}
                        className="flex-1 text-xs py-2 bg-green-600 text-white rounded-lg hover:bg-green-500"
                      >
                        ✅ Registrar Coleta
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          )
        })}
      </div>

      {modal && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-sm">
            <div className="p-5 border-b">
              <h2 className="text-lg font-bold">Adicionar OV ao Pallet</h2>
              <p className="text-sm text-gray-500">OV precisa estar com status <strong>FATURADO</strong> · nº de caixas preenchido automaticamente da cubagem</p>
            </div>
            <div className="p-5">
              <label className="text-sm font-medium text-gray-700">Número da OV *</label>
              <input
                type="text"
                value={ovInput}
                onChange={e => setOvInput(e.target.value.toUpperCase())}
                className="w-full border rounded-lg px-3 py-3 text-lg mt-1 font-mono"
                placeholder="OV015374"
                autoFocus
              />
            </div>
            <div className="p-5 border-t flex gap-2">
              <button onClick={() => setModal(null)} className="flex-1 py-2.5 border rounded-lg text-sm">
                Cancelar
              </button>
              <button
                onClick={() => adicionar.mutate(modal)}
                disabled={adicionar.isPending || !ovInput}
                className="flex-1 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50"
              >
                {adicionar.isPending ? 'Adicionando...' : 'Adicionar'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

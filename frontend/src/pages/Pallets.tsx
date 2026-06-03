import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { FileText, ExternalLink } from 'lucide-react'
import api from '../lib/api'
import { errMsg } from '../lib/errMsg'
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

export function Pallets() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [modal, setModal] = useState<string | null>(null)
  const [ovInput, setOvInput] = useState('')
  const [numCaixas, setNumCaixas] = useState('')
  const [modoColeta, setModoColeta] = useState<string | null>(null) // pallet_id em modo coleta
  const [selecionadas, setSelecionadas] = useState<Set<string>>(new Set())

  const { data, isLoading } = useQuery({
    queryKey: ['pallets'],
    queryFn: () => api.get('/pallets').then(r => r.data),
    refetchInterval: 30000,
  })

  const pallets: any[] = Array.isArray(data) ? data : []
  const FIXOS = ['PLT-BRIX', 'PLT-RR CARGO', 'PLT-CORREIOS', 'PLT-OUTROS']
  const ativos = pallets.filter(p => p && p.status !== 'COLETADO')
  const fixos = FIXOS.map(cod => ativos.find(p => p.codigo === cod)).filter(Boolean)
  const extras = ativos.filter(p => !FIXOS.includes(p.codigo))
  const todos: any[] = [...fixos, ...extras]

  const adicionar = useMutation({
    mutationFn: (palletId: string) =>
      api.post(`/pallets/${palletId}/pedidos`, {
        pedido_id: ovInput,
        num_caixas: numCaixas ? Number(numCaixas) : null,
      }),
    onSuccess: () => {
      toast.success('OV adicionada!')
      qc.invalidateQueries({ queryKey: ['pallets'] })
      qc.invalidateQueries({ queryKey: ['pedidos'] })
      setModal(null)
      setOvInput('')
      setNumCaixas('')
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

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4">
        {todos.map((pallet: any) => {
          if (!pallet) return null
          const nome = pallet.transportadora_nome || ''
          const cor = CORES[nome] || 'bg-gray-500'
          const pedidos: any[] = pallet.pedidos || []

          return (
            <div key={pallet.id} className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
              <div className={`${cor} px-4 py-3 flex justify-between items-center`}>
                <div>
                  <p className="font-bold text-white text-sm">{nome || pallet.codigo}</p>
                  <p className="text-white text-xs opacity-75">{pallet.codigo}</p>
                </div>
                <span className="text-white font-bold text-2xl">{pedidos.length}</span>
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
                            {pp?.num_caixas && <p className="text-xs text-gray-400">{pp.num_caixas} cx</p>}
                            {pallet.codigo === 'PLT-OUTROS' && pp?.pedidos?.transportadora_nome && (
                              <span className="text-xs bg-gray-200 text-gray-600 px-1.5 py-0.5 rounded font-medium">
                                {pp.pedidos.transportadora_nome}
                              </span>
                            )}
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
                      onClick={() => { setModal(pallet.id); setOvInput(''); setNumCaixas('') }}
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
              <p className="text-sm text-gray-500">OV precisa estar com status <strong>FATURADO</strong></p>
            </div>
            <div className="p-5 space-y-4">
              <div>
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
              <div>
                <label className="text-sm font-medium text-gray-700">Nº de Caixas</label>
                <input
                  type="number"
                  value={numCaixas}
                  onChange={e => setNumCaixas(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1"
                  placeholder="Ex: 2"
                />
              </div>
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

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  ArrowLeft, Plus, Trash2, Search, AlertTriangle,
  Clock, Package, Box, DollarSign, Info,
} from 'lucide-react'
import { clsx } from 'clsx'
import { criarCarga, listarProdutos, simularCarga } from '../../lib/esterilizacaoApi'
import type { ProdutoEsteril, TipoCaixa, SimulacaoCarga } from '../../types/esterilizacao'
import { formatarTempo, formatarMoeda } from '../../types/esterilizacao'

interface ItemForm {
  codigo_sa: string
  produto?: ProdutoEsteril
  quantidade: number
  tipo_caixa?: TipoCaixa
  modelo_carga?: string
  observacao?: string
}

const TIPOS_CAIXA: TipoCaixa[] = ['VERDE', 'BRANCA', 'AMARELA', 'VERMELHA']

function PainelSimulacao({ simulacao, carregando }: { simulacao: SimulacaoCarga | null; carregando: boolean }) {
  if (carregando) return (
    <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 flex items-center justify-center h-48">
      <p className="text-blue-500 text-sm">Calculando...</p>
    </div>
  )
  if (!simulacao) return (
    <div className="bg-gray-50 border border-dashed border-gray-300 rounded-2xl p-5 flex flex-col items-center justify-center h-48 text-gray-400">
      <Package size={32} className="mb-2 opacity-30" />
      <p className="text-sm">Adicione produtos para ver a simulação</p>
    </div>
  )

  return (
    <div className="bg-blue-50 border border-blue-200 rounded-2xl p-5 space-y-4">
      <h3 className="font-bold text-blue-900 text-sm uppercase tracking-wide">Simulação da Carga</h3>

      <div className="grid grid-cols-2 gap-3">
        <div className="bg-white rounded-xl p-3">
          <p className="text-xs text-gray-500 flex items-center gap-1"><Package size={11} /> Total de peças</p>
          <p className="text-xl font-bold text-gray-900">{simulacao.total_pecas.toLocaleString()}</p>
        </div>
        <div className="bg-white rounded-xl p-3">
          <p className="text-xs text-gray-500 flex items-center gap-1"><Box size={11} /> Total de caixas</p>
          <p className="text-xl font-bold text-gray-900">{simulacao.total_caixas}</p>
        </div>
        <div className="bg-white rounded-xl p-3">
          <p className="text-xs text-gray-500 flex items-center gap-1"><Clock size={11} /> Tempo total</p>
          <p className="text-xl font-bold text-gray-900">{formatarTempo(simulacao.total_tempo_min)}</p>
          <p className="text-xs text-gray-400 mt-0.5">
            prod. {formatarTempo(simulacao.total_tempo_producao_min)} · sep. {formatarTempo(simulacao.total_tempo_separacao_min)}
          </p>
        </div>
        <div className="bg-white rounded-xl p-3">
          <p className="text-xs text-gray-500 flex items-center gap-1"><DollarSign size={11} /> Valor total</p>
          <p className="text-xl font-bold text-gray-900">{formatarMoeda(simulacao.total_valor)}</p>
        </div>
      </div>

      <div className="bg-white rounded-xl p-3">
        <p className="text-xs text-gray-500 mb-1">Dias necessários (jornada de 8h)</p>
        <p className="text-lg font-bold text-gray-900">{simulacao.dias_necessarios} dia{simulacao.dias_necessarios !== 1 ? 's' : ''}</p>
      </div>

      {simulacao.alertas.length > 0 && (
        <div className="space-y-1.5">
          {simulacao.alertas.map((a, i) => (
            <div key={i} className="flex items-start gap-2 bg-yellow-50 border border-yellow-200 rounded-lg p-2">
              <AlertTriangle size={13} className="text-yellow-600 mt-0.5 flex-shrink-0" />
              <p className="text-xs text-yellow-800">{a}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

export function NovaCarga() {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [itens, setItens] = useState<ItemForm[]>([])
  const [busca, setBusca] = useState('')
  const [dataSaida, setDataSaida] = useState('')
  const [dataInicio, setDataInicio] = useState('')
  const [dataRetorno, setDataRetorno] = useState('')
  const [horaInicio, setHoraInicio] = useState('')
  const [prioridade, setPrioridade] = useState<'ALTA' | 'NORMAL' | 'BAIXA'>('NORMAL')
  const [respPlanejamento, setRespPlanejamento] = useState('')
  const [respOperacao, setRespOperacao] = useState('')
  const [observacao, setObservacao] = useState('')
  const [simulacao, setSimulacao] = useState<SimulacaoCarga | null>(null)
  const [simCarregando, setSimCarregando] = useState(false)

  const { data: produtos = [] } = useQuery({
    queryKey: ['produtos-estereis', busca],
    queryFn: () => listarProdutos({ busca: busca || undefined }),
  })

  const mutCriar = useMutation({
    mutationFn: criarCarga,
    onSuccess: (carga) => {
      toast.success(`Carga ${carga.numero_carga} criada com sucesso!`)
      qc.invalidateQueries({ queryKey: ['cargas-planejamento'] })
      navigate(`/esterilizacao/cargas/${carga.id}`)
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao criar carga'),
  })

  // Simula a carga toda vez que os itens mudam
  useEffect(() => {
    if (itens.length === 0) { setSimulacao(null); return }
    const timer = setTimeout(async () => {
      setSimCarregando(true)
      try {
        const sim = await simularCarga(
          itens.map((i) => ({ codigo_sa: i.codigo_sa, quantidade: i.quantidade, tipo_caixa: i.tipo_caixa }))
        )
        setSimulacao(sim)
      } catch {
        // silencia erro de simulação
      } finally {
        setSimCarregando(false)
      }
    }, 600)
    return () => clearTimeout(timer)
  }, [itens])

  function adicionarProduto(produto: ProdutoEsteril) {
    if (itens.some((i) => i.codigo_sa === produto.codigo_sa)) {
      toast.error('Este produto já está na carga')
      return
    }
    setItens([...itens, {
      codigo_sa: produto.codigo_sa,
      produto,
      quantidade: 0,
      tipo_caixa: produto.tipo_caixa_padrao,
    }])
    setBusca('')
  }

  function atualizarItem(index: number, campo: keyof ItemForm, valor: any) {
    const novos = [...itens]
    novos[index] = { ...novos[index], [campo]: valor }
    setItens(novos)
  }

  function removerItem(index: number) {
    setItens(itens.filter((_, i) => i !== index))
  }

  function salvar(liberar: boolean) {
    if (!dataSaida) { toast.error('Data de saída é obrigatória'); return }
    if (itens.length === 0) { toast.error('Adicione pelo menos um produto'); return }
    const itensInvalidos = itens.filter((i) => !i.quantidade || i.quantidade <= 0)
    if (itensInvalidos.length > 0) { toast.error('Informe a quantidade de todos os produtos'); return }

    mutCriar.mutate({
      data_saida_prevista: dataSaida,
      data_inicio_planejada: dataInicio || undefined,
      hora_inicio_planejada: horaInicio || undefined,
      data_retorno_prevista: dataRetorno || undefined,
      prioridade,
      responsavel_planejamento: respPlanejamento || undefined,
      responsavel_operacao: respOperacao || undefined,
      observacao: observacao || undefined,
      itens: itens.map((i) => ({
        codigo_sa: i.codigo_sa,
        quantidade: i.quantidade,
        tipo_caixa: i.tipo_caixa,
        modelo_carga: i.modelo_carga,
        observacao: i.observacao,
      })),
    })
  }

  const produtosFiltrados = produtos.filter(
    (p) => !itens.some((i) => i.codigo_sa === p.codigo_sa)
  )

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 bg-white flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <button onClick={() => navigate(-1)} className="text-gray-500 hover:text-gray-800 transition-colors">
            <ArrowLeft size={20} />
          </button>
          <h1 className="text-xl font-bold text-gray-900">Nova Carga</h1>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => salvar(false)}
            disabled={mutCriar.isPending}
            className="px-4 py-2 rounded-xl border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50 transition-colors disabled:opacity-50"
          >
            Salvar como planejada
          </button>
          <button
            onClick={() => salvar(true)}
            disabled={mutCriar.isPending}
            className="px-4 py-2 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 transition-colors disabled:opacity-50"
          >
            {mutCriar.isPending ? 'Salvando...' : 'Salvar e liberar'}
          </button>
        </div>
      </div>

      {/* Conteúdo */}
      <div className="flex-1 overflow-auto">
        <div className="max-w-6xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-3 gap-6">

          {/* Coluna esquerda — formulário */}
          <div className="lg:col-span-2 space-y-5">

            {/* Datas e responsáveis */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5">
              <h2 className="font-semibold text-gray-800 mb-4">Dados da carga</h2>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Saída prevista para Esterilize *
                  </label>
                  <input
                    type="date"
                    value={dataSaida}
                    onChange={(e) => setDataSaida(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">
                    Retorno previsto da Esterilize
                  </label>
                  <input
                    type="date"
                    value={dataRetorno}
                    onChange={(e) => setDataRetorno(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Início da produção</label>
                  <input
                    type="date"
                    value={dataInicio}
                    onChange={(e) => setDataInicio(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Hora de início</label>
                  <input
                    type="time"
                    value={horaInicio}
                    onChange={(e) => setHoraInicio(e.target.value)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Prioridade</label>
                  <select
                    value={prioridade}
                    onChange={(e) => setPrioridade(e.target.value as any)}
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    <option value="NORMAL">Normal</option>
                    <option value="ALTA">Alta</option>
                    <option value="BAIXA">Baixa</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Responsável pelo planejamento</label>
                  <input
                    value={respPlanejamento}
                    onChange={(e) => setRespPlanejamento(e.target.value)}
                    placeholder="Nome"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Responsável pela operação</label>
                  <input
                    value={respOperacao}
                    onChange={(e) => setRespOperacao(e.target.value)}
                    placeholder="Nome"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div className="sm:col-span-2">
                  <label className="block text-sm font-medium text-gray-700 mb-1.5">Observações</label>
                  <textarea
                    value={observacao}
                    onChange={(e) => setObservacao(e.target.value)}
                    rows={2}
                    placeholder="Observações gerais da carga"
                    className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                  />
                </div>
              </div>
            </div>

            {/* Busca de produtos */}
            <div className="bg-white rounded-2xl border border-gray-200 p-5">
              <h2 className="font-semibold text-gray-800 mb-4">
                Produtos da carga
                {itens.length > 0 && <span className="ml-2 text-sm font-normal text-gray-500">({itens.length} adicionado{itens.length !== 1 ? 's' : ''})</span>}
              </h2>

              {/* Busca */}
              <div className="relative mb-4">
                <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
                <input
                  value={busca}
                  onChange={(e) => setBusca(e.target.value)}
                  placeholder="Buscar por código SA, PA ou descrição..."
                  className="w-full pl-8 pr-3 py-2.5 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Resultados da busca */}
              {busca && produtosFiltrados.length > 0 && (
                <div className="mb-4 border border-gray-200 rounded-xl overflow-hidden max-h-52 overflow-y-auto">
                  {produtosFiltrados.slice(0, 8).map((p) => (
                    <button
                      key={p.codigo_sa}
                      onClick={() => adicionarProduto(p)}
                      className="w-full text-left px-4 py-2.5 hover:bg-blue-50 border-b border-gray-100 last:border-0 transition-colors flex items-center justify-between gap-2"
                    >
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium text-gray-900 truncate">{p.descricao}</p>
                        <p className="text-xs text-gray-500">{p.codigo_sa} · {p.familia}</p>
                      </div>
                      <Plus size={14} className="text-blue-500 flex-shrink-0" />
                    </button>
                  ))}
                </div>
              )}

              {busca && produtosFiltrados.length === 0 && (
                <div className="mb-4 flex items-center gap-2 text-sm text-gray-500 bg-gray-50 rounded-xl p-3">
                  <Info size={14} />
                  Nenhum produto encontrado. Verifique o cadastro de produtos estéreis.
                </div>
              )}

              {/* Lista de itens adicionados */}
              {itens.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-24 text-gray-400 border border-dashed border-gray-200 rounded-xl">
                  <p className="text-sm">Nenhum produto adicionado</p>
                  <p className="text-xs mt-1">Use a busca acima para adicionar</p>
                </div>
              ) : (
                <div className="space-y-3">
                  {itens.map((item, idx) => (
                    <div key={idx} className="bg-gray-50 rounded-xl border border-gray-200 p-4">
                      <div className="flex items-start justify-between gap-2 mb-3">
                        <div>
                          <p className="font-semibold text-gray-900 text-sm">{item.produto?.descricao || item.codigo_sa}</p>
                          <p className="text-xs text-gray-500">{item.codigo_sa} · {item.produto?.familia}</p>
                        </div>
                        <button onClick={() => removerItem(idx)} className="text-gray-400 hover:text-red-500 transition-colors p-1">
                          <Trash2 size={14} />
                        </button>
                      </div>
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Quantidade *</label>
                          <input
                            type="number"
                            min={1}
                            value={item.quantidade || ''}
                            onChange={(e) => atualizarItem(idx, 'quantidade', Number(e.target.value))}
                            className="w-full border border-gray-300 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Tipo de caixa</label>
                          <select
                            value={item.tipo_caixa || ''}
                            onChange={(e) => atualizarItem(idx, 'tipo_caixa', e.target.value || undefined)}
                            className="w-full border border-gray-300 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          >
                            <option value="">Padrão</option>
                            {TIPOS_CAIXA.map((t) => <option key={t} value={t}>{t}</option>)}
                          </select>
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Modelo de carga</label>
                          <input
                            value={item.modelo_carga || ''}
                            onChange={(e) => atualizarItem(idx, 'modelo_carga', e.target.value)}
                            placeholder="Ex: C1, C2..."
                            className="w-full border border-gray-300 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                        <div>
                          <label className="block text-xs text-gray-500 mb-1">Observação</label>
                          <input
                            value={item.observacao || ''}
                            onChange={(e) => atualizarItem(idx, 'observacao', e.target.value)}
                            className="w-full border border-gray-300 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                          />
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Coluna direita — simulação */}
          <div className="space-y-4">
            <PainelSimulacao simulacao={simulacao} carregando={simCarregando} />

            {simulacao && simulacao.itens.length > 0 && (
              <div className="bg-white rounded-2xl border border-gray-200 p-4">
                <h3 className="text-sm font-semibold text-gray-700 mb-3">Detalhamento por produto</h3>
                <div className="space-y-2">
                  {simulacao.itens.map((item) => (
                    <div key={item.codigo_sa} className="flex items-center justify-between text-xs">
                      <div className="flex-1 min-w-0">
                        <p className="font-medium text-gray-800 truncate">{item.descricao || item.codigo_sa}</p>
                        <p className="text-gray-500">{item.quantidade_caixas} cx {item.tipo_caixa}</p>
                      </div>
                      <p className="text-gray-600 ml-2">{formatarTempo(item.tempo_total_min)}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>

        </div>
      </div>
    </div>
  )
}

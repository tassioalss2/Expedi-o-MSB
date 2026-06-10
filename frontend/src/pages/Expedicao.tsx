import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Search, Plus, Upload, RefreshCw, Info, X } from 'lucide-react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import api from '../lib/api'
import type { Pedido, StatusPedido } from '../types'
import { StatusBadge } from '../components/StatusBadge'
import { PrioridadeBadge } from '../components/PrioridadeBadge'
import { ORDEM_KANBAN, STATUS_CONFIG } from '../lib/statusConfig'
import toast from 'react-hot-toast'

type View = 'lista' | 'kanban'

// ── Busca com autocomplete ────────────────────────────────────────────────────
function BuscaAutocomplete({ busca, setBusca, pedidos, onSelecionar }: {
  busca: string
  setBusca: (v: string) => void
  pedidos: Pedido[]
  onSelecionar: (id: string) => void
}) {
  const [aberto, setAberto] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    function click(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false)
    }
    document.addEventListener('mousedown', click)
    return () => document.removeEventListener('mousedown', click)
  }, [])

  const sugestoes = busca.length >= 1
    ? pedidos
        .filter(p => {
          const q = busca.toLowerCase()
          return (
            p.numero_pedido.toLowerCase().includes(q) ||
            (p.cliente_nome || p.cliente?.nome || '').toLowerCase().includes(q)
          )
        })
        .slice(0, 8)
    : []

  const STATUS_COR: Record<string, string> = {
    LIBERADO: 'bg-gray-100 text-gray-600',
    EM_INVENTARIO: 'bg-blue-100 text-blue-700',
    AGUARD_VERIFICACAO: 'bg-yellow-100 text-yellow-700',
    DIVERGENCIA: 'bg-red-100 text-red-700',
    EM_PROCESSO_SISTEMICO: 'bg-purple-100 text-purple-700',
    AGUARD_FATURAMENTO: 'bg-indigo-100 text-indigo-700',
    FATURADO: 'bg-indigo-100 text-indigo-700',
    AGUARD_COLETA: 'bg-teal-100 text-teal-700',
    EXPEDIDO: 'bg-green-100 text-green-700',
    CANCELADO: 'bg-gray-100 text-gray-400',
    BLOQUEADO: 'bg-red-900 text-red-200',
  }

  const STATUS_LABEL: Record<string, string> = {
    LIBERADO: 'Liberado', EM_INVENTARIO: 'Em Inventário',
    AGUARD_VERIFICACAO: 'Aguard. Verificação', DIVERGENCIA: 'Divergência',
    AGUARD_TRATATIVA: 'Aguard. Tratativa', EM_PROCESSO_SISTEMICO: 'Proc. Sistêmico',
    AGUARD_FATURAMENTO: 'Aguard. Faturamento', FATURADO: 'Faturado',
    AGUARD_COLETA: 'No Pallet', EXPEDIDO: 'Expedido',
    CANCELADO: 'Cancelado', BLOQUEADO: 'Bloqueado',
  }

  return (
    <div ref={ref} className="relative flex-1 max-w-sm">
      <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400 z-10" />
      <input
        type="text"
        placeholder="Buscar OV ou cliente..."
        value={busca}
        onChange={e => { setBusca(e.target.value); setAberto(true) }}
        onFocus={() => busca.length >= 1 && setAberto(true)}
        className="w-full pl-9 pr-4 py-2 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
      {aberto && sugestoes.length > 0 && (
        <div className="absolute z-50 w-full bg-white border border-gray-200 rounded-xl shadow-xl mt-1 overflow-hidden">
          {sugestoes.map(p => (
            <button
              key={p.id}
              onClick={() => { setAberto(false); setBusca(''); onSelecionar(p.id) }}
              className={`w-full text-left px-4 py-2.5 hover:bg-blue-50 border-b border-gray-50 last:border-0 ${
                p.atrasado ? 'bg-red-50' : ''
              }`}
            >
              <div className="flex items-center justify-between gap-2">
                <div className="flex items-center gap-2 min-w-0">
                  <span className="font-bold text-gray-900 text-sm flex-shrink-0">{p.numero_pedido}</span>
                  {p.atrasado && <span className="text-xs text-red-600 font-medium flex-shrink-0">⚠ Atrasado</span>}
                  <span className="text-xs text-gray-500 truncate">{p.cliente_nome || p.cliente?.nome}</span>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full flex-shrink-0 font-medium ${STATUS_COR[p.status] || 'bg-gray-100 text-gray-600'}`}>
                  {STATUS_LABEL[p.status] || p.status}
                </span>
              </div>
            </button>
          ))}
          {busca.length >= 1 && (
            <div className="px-4 py-2 text-xs text-gray-400 bg-gray-50">
              {sugestoes.length} resultado(s) — clique para abrir
            </div>
          )}
        </div>
      )}
      {aberto && busca.length >= 1 && sugestoes.length === 0 && (
        <div className="absolute z-50 w-full bg-white border border-gray-200 rounded-xl shadow-xl mt-1 px-4 py-3 text-sm text-gray-400">
          Nenhuma OV encontrada para "{busca}"
        </div>
      )}
    </div>
  )
}

function CardPedido({ pedido, onClick }: { pedido: Pedido; onClick: () => void }) {
  const atrasado = pedido.atrasado
  return (
    <div
      onClick={onClick}
      className={`bg-white rounded-lg p-3.5 shadow-sm border cursor-pointer hover:shadow-md transition-shadow ${
        atrasado ? 'border-red-300 bg-red-50' : 'border-gray-200'
      }`}
    >
      <div className="flex items-start justify-between gap-2 mb-2">
        <span className="font-bold text-gray-900 text-sm">{pedido.numero_pedido}</span>
        <PrioridadeBadge prioridade={pedido.prioridade} />
      </div>
      <p className="text-sm text-gray-600 truncate mb-1">{pedido.cliente_nome || pedido.cliente?.nome}</p>
      {pedido.numero_nf && (
        <p className="text-xs text-blue-600 font-medium mb-1">📄 NF {pedido.numero_nf}</p>
      )}
      <div className="flex items-center justify-between">
        <span className={`text-xs ${atrasado ? 'text-red-600 font-semibold' : 'text-gray-400'}`}>
          {atrasado ? '⚠ ATRASADO' : `Entrega: ${new Date(pedido.data_prevista_entrega + 'T12:00:00').toLocaleDateString('pt-BR')}`}
        </span>
        <span className="text-xs text-gray-400">
          {formatDistanceToNow(parseISO(pedido.atualizado_em), { locale: ptBR, addSuffix: true })}
        </span>
      </div>
    </div>
  )
}

// ── Informações de cada etapa ─────────────────────────────────────────────────
const INFO_ETAPAS: Record<string, {
  responsavel: string
  objetivo: string
  inputs: string[]
  criterio: string
}> = {
  LIBERADO: {
    responsavel: 'Operador 1',
    objetivo: 'OV recebida via Teams — aguardando início da separação',
    inputs: ['Número da OV', 'Cliente', 'Tipo de frete (FOB/CIF)', 'Data prevista de entrega'],
    criterio: 'Clicar em "Iniciar Inventário Contínuo" para avançar',
  },
  EM_INVENTARIO: {
    responsavel: 'Operador 1',
    objetivo: 'Registrar todos os itens do pedido com código, lote e quantidades',
    inputs: ['Código do item', 'Nº do lote', 'Qtd no sistema', 'Qtd físico (opcional)', 'Qtd vendida'],
    criterio: 'Todos os itens preenchidos → clicar em "Salvar e Enviar para Verificação"',
  },
  AGUARD_VERIFICACAO: {
    responsavel: 'Operador 2',
    objetivo: 'Conferir fisicamente se o estoque restante (Sistema − Venda) bate com o físico',
    inputs: ['Validade de cada lote', 'Quantidade física encontrada', 'Status: OK ou Divergência'],
    criterio: 'Todos os itens verificados → clicar em "Confirmar Verificação"',
  },
  DIVERGENCIA: {
    responsavel: 'Supervisor de Logística',
    objetivo: 'Resolver divergência identificada na verificação física',
    inputs: ['Decisão: corrigir inventário ou resolver', 'Justificativa da tratativa'],
    criterio: 'Supervisor acessa a OV e clica em "Tratar Divergência"',
  },
  EM_PROCESSO_SISTEMICO: {
    responsavel: 'Operador 1',
    objetivo: 'Processar a OV no D365 e registrar a cubagem das caixas',
    inputs: ['Tipo(s) de caixa', 'Quantidade por tipo', 'Peso total (kg)'],
    criterio: 'Após D365 e cubagem registrada → mensagem enviada ao Teams para faturamento',
  },
  AGUARD_FATURAMENTO: {
    responsavel: 'Operações de Vendas',
    objetivo: 'Emitir a nota fiscal após receber a mensagem de cubagem',
    inputs: ['Número da NF', 'Valor dos produtos (R$)', 'Custo do frete (R$) — se CIF'],
    criterio: 'NF emitida → registrar no app clicando em "Registrar NF Recebida"',
  },
  FATURADO: {
    responsavel: 'Expedição',
    objetivo: 'Alocar as caixas no pallet da transportadora correta',
    inputs: ['Transportadora (BRIX / RR CARGO / CORREIOS / OUTROS)', 'Nº de caixas no pallet'],
    criterio: 'Caixas no pallet → status muda para "No Pallet"',
  },
  AGUARD_COLETA: {
    responsavel: 'Expedição / Transportadora',
    objetivo: 'Aguardar a transportadora retirar o pallet',
    inputs: ['Confirmação da coleta quando a transportadora chegar'],
    criterio: 'Transportadora coletou → confirmar no app → OV marcada como Expedida',
  },
  EXPEDIDO: {
    responsavel: '—',
    objetivo: 'OV finalizada com sucesso',
    inputs: [],
    criterio: 'Nenhuma ação necessária',
  },
}

function InfoEtapaModal({ status, cfg, onClose }: { status: string; cfg: any; onClose: () => void }) {
  const info = INFO_ETAPAS[status]
  if (!info) return null
  return (
    <div className="fixed inset-0 bg-black bg-opacity-40 flex items-center justify-center z-50 p-4"
      onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md shadow-2xl"
        onClick={e => e.stopPropagation()}>
        <div className="rounded-t-2xl px-5 py-4 flex items-center justify-between"
          style={{ backgroundColor: cfg.cor, color: cfg.corTexto }}>
          <div>
            <p className="text-lg font-bold">{cfg.icone} {cfg.label}</p>
            <p className="text-xs opacity-75">Responsável: {info.responsavel}</p>
          </div>
          <button onClick={onClose} className="opacity-70 hover:opacity-100">
            <X size={20} />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <p className="text-xs font-semibold text-gray-400 uppercase mb-1">Objetivo</p>
            <p className="text-sm text-gray-700">{info.objetivo}</p>
          </div>
          {info.inputs.length > 0 && (
            <div>
              <p className="text-xs font-semibold text-gray-400 uppercase mb-2">Informações necessárias</p>
              <ul className="space-y-1">
                {info.inputs.map((inp, i) => (
                  <li key={i} className="flex items-start gap-2 text-sm text-gray-700">
                    <span className="text-blue-500 flex-shrink-0 mt-0.5">•</span>
                    {inp}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="bg-green-50 border border-green-200 rounded-lg p-3">
            <p className="text-xs font-semibold text-green-700 mb-1">✅ Critério para avançar</p>
            <p className="text-sm text-green-700">{info.criterio}</p>
          </div>
        </div>
      </div>
    </div>
  )
}

function KanbanView({ pedidos, onClickPedido }: { pedidos: Pedido[]; onClickPedido: (p: Pedido) => void }) {
  const [infoAberta, setInfoAberta] = useState<string | null>(null)
  const hoje = new Date().toISOString().slice(0, 10) // 'YYYY-MM-DD'
  const agrupado = ORDEM_KANBAN.reduce<Record<string, Pedido[]>>((acc, status) => {
    let lista = pedidos.filter((p) => p.status === status)
    // Expedido: só mostra coletas do dia atual
    if (status === 'EXPEDIDO') {
      lista = lista.filter((p) => p.atualizado_em?.slice(0, 10) === hoje)
    }
    acc[status] = lista
    return acc
  }, {})

  return (
    <div className="flex gap-4 overflow-x-auto pb-4 min-h-0">
      {ORDEM_KANBAN.map((status) => {
        const cfg = STATUS_CONFIG[status]
        const lista = agrupado[status] || []
        return (
          <div key={status} className="flex-shrink-0 w-64">
            <div
              className="rounded-t-lg px-3 py-2 flex items-center justify-between cursor-pointer group"
              style={{ backgroundColor: cfg.cor, color: cfg.corTexto }}
              onClick={() => setInfoAberta(status)}
              title="Clique para ver detalhes desta etapa"
            >
              <span className="text-sm font-semibold flex items-center gap-1.5">
                {cfg.icone} {cfg.label}
                <Info size={13} className="opacity-50 group-hover:opacity-100 transition-opacity" />
              </span>
              <span className="text-xs font-bold bg-white bg-opacity-40 rounded-full px-2 py-0.5">
                {lista.length}
              </span>
            </div>
            <div className="bg-gray-100 rounded-b-lg p-2 space-y-2 min-h-[200px] max-h-[calc(100vh-280px)] overflow-y-auto">
              {lista.length === 0 && (
                <p className="text-xs text-gray-400 text-center py-4">Nenhum pedido</p>
              )}
              {lista.map((p) => (
                <CardPedido key={p.id} pedido={p} onClick={() => onClickPedido(p)} />
              ))}
            </div>
          </div>
        )
      })}
      {infoAberta && (
        <InfoEtapaModal
          status={infoAberta}
          cfg={STATUS_CONFIG[infoAberta as keyof typeof STATUS_CONFIG]}
          onClose={() => setInfoAberta(null)}
        />
      )}
    </div>
  )
}

function ListaView({ pedidos, onClickPedido }: { pedidos: Pedido[]; onClickPedido: (p: Pedido) => void }) {
  return (
    <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-gray-50 border-b border-gray-100">
          <tr>
            <th className="text-left px-4 py-3 text-gray-600 font-semibold">Pedido</th>
            <th className="text-left px-4 py-3 text-gray-600 font-semibold">Cliente</th>
            <th className="text-left px-4 py-3 text-gray-600 font-semibold">Status</th>
            <th className="text-left px-4 py-3 text-gray-600 font-semibold">Prioridade</th>
            <th className="text-left px-4 py-3 text-gray-600 font-semibold">Entrega Prev.</th>
            <th className="text-left px-4 py-3 text-gray-600 font-semibold">Transportadora</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-50">
          {pedidos.map((p) => (
            <tr
              key={p.id}
              onClick={() => onClickPedido(p)}
              className={`cursor-pointer hover:bg-blue-50 transition-colors ${p.atrasado ? 'bg-red-50' : ''}`}
            >
              <td className="px-4 py-3 font-bold text-gray-900">{p.numero_pedido}</td>
              <td className="px-4 py-3 text-gray-600">{p.cliente_nome || p.cliente?.nome}</td>
              <td className="px-4 py-3"><StatusBadge status={p.status} size="sm" /></td>
              <td className="px-4 py-3"><PrioridadeBadge prioridade={p.prioridade} /></td>
              <td className={`px-4 py-3 ${p.atrasado ? 'text-red-600 font-semibold' : 'text-gray-600'}`}>
                {p.atrasado ? '⚠ ' : ''}{new Date(p.data_prevista_entrega + 'T12:00:00').toLocaleDateString('pt-BR')}
              </td>
              <td className="px-4 py-3 text-gray-500">{p.transportadora_nome || '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {pedidos.length === 0 && (
        <div className="py-16 text-center text-gray-400">Nenhum pedido encontrado</div>
      )}
    </div>
  )
}

export function Expedicao() {
  const navigate = useNavigate()
  const [view, setView] = useState<View>('kanban')
  const [busca, setBusca] = useState('')
  const [statusFiltro, setStatusFiltro] = useState<string>('')
  const qc = useQueryClient()

  const { data: pedidos = [], isLoading, refetch } = useQuery<Pedido[]>({
    queryKey: ['pedidos', statusFiltro],
    queryFn: () =>
      api.get('/pedidos', { params: statusFiltro ? { status: statusFiltro } : {} }).then((r) => r.data),
    refetchInterval: 30000,
  })

  const pedidosFiltrados = pedidos.filter((p) => {
    if (!busca) return true
    const q = busca.toLowerCase()
    return (
      p.numero_pedido.toLowerCase().includes(q) ||
      (p.cliente_nome || '').toLowerCase().includes(q) ||
      (p.cliente?.nome || '').toLowerCase().includes(q)
    )
  })

  const importarMutation = useMutation({
    mutationFn: async (arquivo: File) => {
      const form = new FormData()
      form.append('arquivo', arquivo)
      return api.post('/pedidos/importar', form)
    },
    onSuccess: (res) => {
      const r = res.data
      toast.success(`${r.importados} pedido(s) importado(s)${r.erros.length ? ` · ${r.erros.length} erro(s)` : ''}`)
      qc.invalidateQueries({ queryKey: ['pedidos'] })
    },
    onError: () => toast.error('Erro ao importar arquivo'),
  })

  const handleImport = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.csv,.xlsx,.xls'
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0]
      if (file) importarMutation.mutate(file)
    }
    input.click()
  }

  return (
    <div className="flex flex-col h-full p-6 gap-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Expedição</h1>
          <p className="text-gray-500 text-sm">{pedidos.length} pedido(s) ativos</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => refetch()}
            className="p-2 text-gray-500 hover:bg-gray-100 rounded-lg"
            title="Atualizar"
          >
            <RefreshCw size={18} />
          </button>
          <button
            onClick={handleImport}
            className="flex items-center gap-2 px-3 py-2 border border-gray-300 rounded-lg text-sm hover:bg-gray-50"
          >
            <Upload size={16} />
            Importar CSV
          </button>
          <button
            onClick={() => navigate('/expedicao/novo')}
            className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-500"
          >
            <Plus size={16} />
            Novo Pedido
          </button>
        </div>
      </div>

      {/* Filtros */}
      <div className="flex items-center gap-3">
        <BuscaAutocomplete
          busca={busca}
          setBusca={setBusca}
          pedidos={pedidos}
          onSelecionar={(id) => navigate(`/expedicao/${id}`)}
        />

        <select
          value={statusFiltro}
          onChange={(e) => setStatusFiltro(e.target.value)}
          className="border border-gray-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
        >
          <option value="">Todos os status</option>
          {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
            <option key={key} value={key}>{cfg.icone} {cfg.label}</option>
          ))}
        </select>

        <div className="flex border border-gray-200 rounded-lg overflow-hidden">
          <button
            onClick={() => setView('kanban')}
            className={`px-3 py-2 text-sm ${view === 'kanban' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
          >
            Kanban
          </button>
          <button
            onClick={() => setView('lista')}
            className={`px-3 py-2 text-sm ${view === 'lista' ? 'bg-blue-600 text-white' : 'bg-white text-gray-600 hover:bg-gray-50'}`}
          >
            Lista
          </button>
        </div>
      </div>

      {/* Conteúdo */}
      {isLoading ? (
        <div className="flex-1 flex items-center justify-center text-gray-400">Carregando...</div>
      ) : view === 'kanban' ? (
        <div className="flex-1 overflow-hidden">
          <KanbanView pedidos={pedidosFiltrados} onClickPedido={(p) => navigate(`/expedicao/${p.id}`)} />
        </div>
      ) : (
        <ListaView pedidos={pedidosFiltrados} onClickPedido={(p) => navigate(`/expedicao/${p.id}`)} />
      )}
    </div>
  )
}

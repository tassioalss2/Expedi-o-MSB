import { useState, useRef, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { Search, Plus, Upload, RefreshCw, Info, X, FileText, Send } from 'lucide-react'
import { formatDistanceToNow, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import api from '../lib/api'
import type { Pedido, StatusPedido } from '../types'
import { StatusBadge } from '../components/StatusBadge'
import { PrioridadeBadge } from '../components/PrioridadeBadge'
import { ORDEM_KANBAN, STATUS_CONFIG, resolveNomeTransportadora } from '../lib/statusConfig'
import toast from 'react-hot-toast'

type View = 'lista' | 'kanban'

// O card de ponte "Repasse CRM → OV" que existia aqui foi removido: desde que
// ganhar_oportunidade passou a criar a OV direto no kanban (coluna
// "AGUARD_DADOS_OV"), esse card sempre aparecia vazio no caminho normal — só
// acendia quando a criação automática falhava, o que é raro e confundia mais
// do que ajudava (o usuário via dois cards de "OV vinda do CRM" ao mesmo
// tempo). O mecanismo de repasse continua existindo nos bastidores como rede
// de segurança para esse caso raro — só não tem mais vitrine na Expedição. A
// aba "Repasse" no CRM segue disponível para quem precisar checar.

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
    AGUARD_CREDITO: 'bg-yellow-100 text-yellow-800',
    LIBERADO: 'bg-gray-100 text-gray-600',
    EM_INVENTARIO: 'bg-blue-100 text-blue-700',
    AGUARD_VERIFICACAO: 'bg-yellow-100 text-yellow-700',
    DIVERGENCIA: 'bg-red-100 text-red-700',
    EM_PROCESSO_SISTEMICO: 'bg-purple-100 text-purple-700',
    EM_COTACAO_FRETE: 'bg-amber-100 text-amber-700',
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
    EM_COTACAO_FRETE: 'Cotação de Frete',
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
        <div className="flex items-center gap-1.5 min-w-0">
          <span className="font-bold text-gray-900 text-sm truncate">{pedido.numero_pedido}</span>
          {(pedido.remessa_numero ?? 1) > 1 && (
            <span className="flex-shrink-0 text-xs font-bold text-purple-700 bg-purple-100 px-1.5 py-0.5 rounded">
              R{pedido.remessa_numero}
            </span>
          )}
        </div>
        <PrioridadeBadge prioridade={pedido.prioridade} />
      </div>
      <p className="text-sm text-gray-600 truncate mb-1">{pedido.cliente_nome || pedido.cliente?.nome}</p>
      {pedido.numero_nf && (
        <p className="text-xs text-blue-600 font-medium mb-1">📄 NF {pedido.numero_nf}</p>
      )}
      {pedido.transportadora_nome && (
        <p className="text-xs text-gray-500 font-medium mb-1">🚚 {resolveNomeTransportadora(pedido.transportadora_nome, pedido.observacoes)}</p>
      )}
      {pedido.tipo_frete && <div className="mb-1.5"><FreteBadge tipo={pedido.tipo_frete} /></div>}
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

function EntradaOV({ pedido, onClick }: { pedido: Pedido; onClick: () => void }) {
  const atrasado = pedido.atrasado
  const critica = pedido.prioridade === 'CRITICA'
  const alta = pedido.prioridade === 'ALTA'
  const entrega = new Date(pedido.data_prevista_entrega + 'T12:00:00')
    .toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
  // Quando a OV já foi faturada, mostra a data do faturamento (não a entrega prevista)
  const dataFat = pedido.data_faturamento
    ? new Date(pedido.data_faturamento + 'T12:00:00').toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })
    : null
  const transp = resolveNomeTransportadora(pedido.transportadora_nome, pedido.observacoes)
  // "OUTROS (Jamef)" → "Jamef", "BRIX" → "BRIX"
  const transpLabel = transp ? (transp.match(/\(([^)]+)\)/)?.[1] ?? transp) : ''
  const tempo = formatDistanceToNow(parseISO(pedido.atualizado_em), { locale: ptBR, addSuffix: false })
  const clienteAbrev = (pedido.cliente_nome || pedido.cliente?.nome || '').split(' ').slice(0, 2).join(' ')

  return (
    <button
      onClick={onClick}
      title={[
        pedido.numero_pedido,
        pedido.cliente_nome || pedido.cliente?.nome,
        pedido.numero_nf ? `NF ${pedido.numero_nf}` : '',
        transp,
        dataFat ? `Faturado ${dataFat}` : `Entrega ${entrega}`,
        atrasado ? '⚠ ATRASADO' : '',
        tempo,
      ].filter(Boolean).join(' · ')}
      className={`w-full flex items-center gap-1.5 px-2 py-[5px] rounded border text-left
        transition-all hover:shadow-sm hover:brightness-95 active:scale-[0.99] ${
        atrasado        ? 'bg-red-100 border-red-200' :
        critica         ? 'bg-orange-50 border-orange-200' :
        alta            ? 'bg-amber-50 border-amber-100' :
                          'bg-white border-gray-200'
      }`}
    >
      {/* Indicador de prioridade / atraso */}
      <span className={`flex-shrink-0 w-1.5 h-1.5 rounded-full ${
        atrasado  ? 'bg-red-500' :
        critica   ? 'bg-orange-500' :
        alta      ? 'bg-amber-400' :
                    'bg-gray-200'
      }`} />

      {/* OV# */}
      <span className={`font-bold text-xs flex-shrink-0 ${atrasado ? 'text-red-800' : 'text-gray-900'}`}>
        {pedido.numero_pedido}
        {(pedido.remessa_numero ?? 1) > 1 && (
          <span className="text-purple-600 text-[10px] ml-0.5">R{pedido.remessa_numero}</span>
        )}
      </span>

      {/* Cliente — ocupa o espaço restante */}
      <span className="text-[10px] text-gray-500 truncate flex-1 min-w-0">{clienteAbrev}</span>

      {/* NF */}
      {pedido.numero_nf && (
        <span className="text-[10px] text-blue-600 flex-shrink-0 font-medium bg-blue-50 px-1 rounded">
          NF{pedido.numero_nf}
        </span>
      )}

      {/* Transportadora */}
      {transpLabel && (
        <span className="text-[10px] text-gray-500 flex-shrink-0 max-w-[52px] truncate bg-gray-100 px-1 rounded"
          title={transp}>
          {transpLabel}
        </span>
      )}

      {/* Data — faturamento (se já faturado) ou entrega prevista */}
      <span className={`text-[10px] flex-shrink-0 font-semibold ${dataFat ? 'text-gray-500' : atrasado ? 'text-red-600' : 'text-gray-400'}`}>
        {dataFat ? dataFat : `${atrasado ? '⚠ ' : ''}${entrega}`}
      </span>

      {/* Tempo */}
      <span className="text-[10px] text-gray-300 flex-shrink-0 hidden xl:inline">{tempo}</span>
    </button>
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
  EM_COTACAO_FRETE: {
    responsavel: 'Logística',
    objetivo: 'Cotar o frete das OVs CIF (com/sem valor) antes de liberar pra faturamento. FOB não passa por aqui.',
    inputs: ['Valor cotado do frete (R$)', 'Observação (transportadora, prazo — opcional)'],
    criterio: 'Frete cotado → clicar em "Registrar cotação de frete" para liberar o faturamento',
  },
  AGUARD_TRANSPORTADORA: {
    responsavel: 'Operações de Vendas',
    objetivo: 'OV FOB: aguardar o cliente informar qual transportadora vai coletar. A transportadora vai na NF, então só faturamos depois disso. CIF não passa por aqui.',
    inputs: ['Transportadora informada pelo cliente', 'Nome real (se OUTROS)', 'Observação (opcional)'],
    criterio: 'Transportadora informada → clicar em "Registrar transportadora do cliente" para liberar o faturamento',
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

// Grid uniforme de 4 colunas — ORDEM_KANBAN (11 etapas) flui em 4/4/3, tudo
// alinhado na vertical. Linha 1: recebimento/inventário; linha 2: sistêmico →
// frete/transportadora → faturamento; linha 3: pós-faturamento.
const KANBAN_COLS = 4

function KanbanView({ pedidos, onClickPedido }: { pedidos: Pedido[]; onClickPedido: (p: Pedido) => void }) {
  const [infoAberta, setInfoAberta] = useState<string | null>(null)
  const hoje = new Date().toISOString().slice(0, 10)
  const agrupado = ORDEM_KANBAN.reduce<Record<string, Pedido[]>>((acc, status) => {
    let lista = pedidos.filter((p) => p.status === status)
    if (status === 'EXPEDIDO') {
      lista = lista.filter((p) => p.atualizado_em?.slice(0, 10) === hoje)
    }
    acc[status] = lista
    return acc
  }, {})

  return (
    <div className="h-full">
      <div
        className="grid gap-2 h-full"
        style={{ gridTemplateColumns: `repeat(${KANBAN_COLS}, minmax(0, 1fr))`, gridAutoRows: 'minmax(0, 1fr)' }}
      >
        {ORDEM_KANBAN.map((status) => {
              const cfg = STATUS_CONFIG[status]
              const lista = agrupado[status] || []
              const valorEtapa = lista.reduce((a, p) => a + (Number((p as any).valor_ov) || 0), 0)
              const valorFmt = valorEtapa >= 1000
                ? `R$ ${(valorEtapa / 1000).toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 1 })} mil`
                : `R$ ${valorEtapa.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 0 })}`
              return (
                <div key={status} className="flex flex-col min-h-0 min-w-0">
                    <div
                      className="rounded-t-lg px-3 pt-2 pb-1.5 flex flex-col gap-0.5 cursor-pointer group flex-shrink-0"
                      style={{ backgroundColor: cfg.cor, color: cfg.corTexto }}
                      onClick={() => setInfoAberta(status)}
                      title="Clique para ver detalhes desta etapa"
                    >
                      <div className="flex items-center justify-between">
                        <span className="text-sm font-semibold flex items-center gap-1 min-w-0">
                          <span className="flex-shrink-0">{cfg.icone}</span>
                          <span className="truncate">{cfg.label}</span>
                          <Info size={12} className="opacity-50 group-hover:opacity-100 transition-opacity flex-shrink-0" />
                        </span>
                        <span className="text-xs font-bold bg-white bg-opacity-40 rounded-full px-2 py-0.5 flex-shrink-0 ml-1">
                          {lista.length}
                        </span>
                      </div>
                      <span className="text-[11px] font-bold tabular-nums opacity-90" title={`R$ ${valorEtapa.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} parados nesta etapa`}>
                        {valorEtapa > 0 ? `💰 ${valorFmt}` : ' '}
                      </span>
                    </div>
                    <div className="bg-gray-100 rounded-b-lg p-1.5 flex flex-col gap-0.5 overflow-y-auto flex-1">
                      {lista.length === 0 && (
                        <p className="text-xs text-gray-400 text-center py-3">—</p>
                      )}
                      {lista.map((p) => (
                        <EntradaOV key={p.id} pedido={p} onClick={() => onClickPedido(p)} />
                      ))}
                    </div>
              </div>
              )
            })}
      </div>
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

const ORDEM_LISTA: StatusPedido[] = [
  'AGUARD_CREDITO', 'LIBERADO', 'EM_INVENTARIO', 'AGUARD_VERIFICACAO',
  'DIVERGENCIA', 'AGUARD_TRATATIVA', 'EM_PROCESSO_SISTEMICO',
  'EM_COTACAO_FRETE', 'AGUARD_TRANSPORTADORA',
  'AGUARD_FATURAMENTO', 'FATURADO', 'AGUARD_COLETA', 'EXPEDIDO',
  'BLOQUEADO', 'CANCELADO',
]

const FRETE_BADGE: Record<string, { label: string; classe: string }> = {
  FOB:           { label: 'FOB',          classe: 'bg-gray-100 text-gray-600' },
  CIF_COM_VALOR: { label: 'CIF c/ valor', classe: 'bg-blue-50 text-blue-700' },
  CIF_SEM_VALOR: { label: 'CIF s/ valor', classe: 'bg-amber-50 text-amber-700' },
}

function FreteBadge({ tipo }: { tipo?: string }) {
  if (!tipo) return <span className="text-gray-300">—</span>
  const cfg = FRETE_BADGE[tipo] || { label: tipo, classe: 'bg-gray-100 text-gray-600' }
  return <span className={`text-[11px] font-medium px-2 py-0.5 rounded-full ${cfg.classe}`}>{cfg.label}</span>
}

function ListaView({ pedidos, onClickPedido }: { pedidos: Pedido[]; onClickPedido: (p: Pedido) => void }) {
  if (pedidos.length === 0) return (
    <div className="py-16 text-center text-gray-400">Nenhum pedido encontrado</div>
  )

  const agrupado = ORDEM_LISTA.reduce<Record<string, Pedido[]>>((acc, status) => {
    const lista = pedidos
      .filter(p => p.status === status)
      .sort((a, b) => Number(b.atrasado) - Number(a.atrasado) || a.data_prevista_entrega.localeCompare(b.data_prevista_entrega))
    if (lista.length > 0) acc[status] = lista
    return acc
  }, {})

  // statuses fora da ordem padrão
  pedidos.forEach(p => {
    if (!ORDEM_LISTA.includes(p.status as StatusPedido) && !agrupado[p.status]) {
      agrupado[p.status] = pedidos.filter(x => x.status === p.status)
    }
  })

  return (
    <div className="space-y-3">
      {Object.entries(agrupado).map(([status, lista]) => {
        const cfg = STATUS_CONFIG[status as keyof typeof STATUS_CONFIG]
        const atrasados = lista.filter(p => p.atrasado).length
        return (
          <div key={status} className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
            <div className="flex items-center justify-between px-4 py-2.5 flex-shrink-0"
              style={{ backgroundColor: cfg?.cor || '#F3F4F6', color: cfg?.corTexto || '#374151' }}>
              <span className="font-bold text-sm flex items-center gap-1.5">
                <span>{cfg?.icone}</span>
                <span>{cfg?.label || status}</span>
              </span>
              <div className="flex items-center gap-2">
                {atrasados > 0 && (
                  <span className="text-[11px] font-bold bg-red-500 text-white px-2 py-0.5 rounded-full">
                    ⚠ {atrasados} atrasada{atrasados > 1 ? 's' : ''}
                  </span>
                )}
                <span className="text-xs font-bold bg-black bg-opacity-10 rounded-full px-2 py-0.5">
                  {lista.length} OV{lista.length > 1 ? 's' : ''}
                </span>
              </div>
            </div>
            <table className="w-full text-sm">
              <tbody className="divide-y divide-gray-50">
                {lista.map(p => (
                  <tr key={p.id} onClick={() => onClickPedido(p)}
                    className={`cursor-pointer hover:bg-blue-50 transition-colors ${p.atrasado ? 'bg-red-50' : ''}`}>
                    <td className="px-4 py-2.5 font-bold text-gray-900 w-28">
                      {p.numero_pedido}
                      {(p.remessa_numero ?? 1) > 1 && (
                        <span className="ml-1 text-[10px] font-bold text-purple-700 bg-purple-100 px-1 rounded">R{p.remessa_numero}</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-gray-600">{p.cliente_nome || p.cliente?.nome}</td>
                    <td className="px-4 py-2.5 w-24"><PrioridadeBadge prioridade={p.prioridade} /></td>
                    <td className={`px-4 py-2.5 w-32 font-medium text-sm ${p.atrasado ? 'text-red-600 font-semibold' : 'text-gray-500'}`}>
                      {p.atrasado ? '⚠ ' : ''}{new Date(p.data_prevista_entrega + 'T12:00:00').toLocaleDateString('pt-BR')}
                    </td>
                    <td className="px-4 py-2.5 w-28"><FreteBadge tipo={p.tipo_frete} /></td>
                    <td className="px-4 py-2.5 text-gray-400 text-sm w-36 truncate">
                      {resolveNomeTransportadora(p.transportadora_nome, p.observacoes) || '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      })}
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
            onClick={() => navigate('/licitacoes?novo=COMUNICADO_USO')}
            className="flex items-center gap-2 px-3 py-2 border border-emerald-300 text-emerald-700 rounded-lg text-sm hover:bg-emerald-50"
          >
            <FileText size={16} />
            Comunicado de Uso
          </button>
          <button
            onClick={() => navigate('/expedicao/outbound')}
            className="flex items-center gap-2 px-3 py-2 border border-blue-300 text-blue-700 rounded-lg text-sm hover:bg-blue-50"
          >
            <Send size={16} />
            Venda Outbound
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
        <div className="flex-1 overflow-hidden min-h-0">
          <KanbanView pedidos={pedidosFiltrados} onClickPedido={(p) => navigate(`/expedicao/${p.id}`)} />
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto min-h-0">
          <ListaView pedidos={pedidosFiltrados} onClickPedido={(p) => navigate(`/expedicao/${p.id}`)} />
        </div>
      )}
    </div>
  )
}

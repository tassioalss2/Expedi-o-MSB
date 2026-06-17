import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  Plus, Search, Filter, ChevronRight, AlertTriangle,
  Clock, Package, TrendingUp, MoreVertical,
} from 'lucide-react'
import { clsx } from 'clsx'
import { listarCargas, liberarCarga, bloquearCarga } from '../../lib/esterilizacaoApi'
import type { Carga, StatusCarga } from '../../types/esterilizacao'
import { STATUS_CARGA_CONFIG, PRIORIDADE_CONFIG, formatarTempo, formatarMoeda } from '../../types/esterilizacao'

const MESES = ['Jan','Fev','Mar','Abr','Mai','Jun','Jul','Ago','Set','Out','Nov','Dez']

const STATUS_TODOS: { value: string; label: string }[] = [
  { value: '', label: 'Todos os status' },
  { value: 'PLANEJADA', label: 'Planejada' },
  { value: 'LIBERADA', label: 'Liberada' },
  { value: 'EM_PRODUCAO', label: 'Em produção' },
  { value: 'EM_SEPARACAO', label: 'Em separação' },
  { value: 'EM_CONFERENCIA', label: 'Em conferência' },
  { value: 'PRONTA', label: 'Pronta p/ envio' },
  { value: 'ENVIADA', label: 'Enviada' },
  { value: 'RETORNADA', label: 'Retornada' },
  { value: 'ATRASADA', label: 'Atrasada' },
  { value: 'BLOQUEADA', label: 'Bloqueada' },
]

function ModalLiberarCarga({
  carga, onConfirmar, onCancelar,
}: { carga: Carga; onConfirmar: (resp: string) => void; onCancelar: () => void }) {
  const [responsavel, setResponsavel] = useState('')
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
        <h3 className="font-bold text-gray-900 text-lg mb-1">Liberar carga para produção</h3>
        <p className="text-sm text-gray-500 mb-4">{carga.numero_carga} · {carga.quantidade_total_pecas.toLocaleString()} peças</p>
        <label className="block text-sm font-medium text-gray-700 mb-1.5">Responsável pela liberação *</label>
        <input
          value={responsavel}
          onChange={(e) => setResponsavel(e.target.value)}
          placeholder="Nome do responsável"
          className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
          autoFocus
        />
        <div className="flex gap-3">
          <button onClick={onCancelar} className="flex-1 py-2.5 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50">
            Cancelar
          </button>
          <button
            onClick={() => {
              if (!responsavel.trim()) { toast.error('Nome do responsável é obrigatório'); return }
              onConfirmar(responsavel.trim())
            }}
            className="flex-1 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
          >
            Liberar
          </button>
        </div>
      </div>
    </div>
  )
}

function MenuAcoes({ carga, onLiberar, onBloquear }: {
  carga: Carga
  onLiberar: () => void
  onBloquear: () => void
}) {
  const [aberto, setAberto] = useState(false)
  return (
    <div className="relative">
      <button
        onClick={(e) => { e.stopPropagation(); setAberto(!aberto) }}
        className="p-1.5 rounded hover:bg-gray-100 transition-colors"
      >
        <MoreVertical size={15} className="text-gray-500" />
      </button>
      {aberto && (
        <>
          <div className="fixed inset-0 z-10" onClick={() => setAberto(false)} />
          <div className="absolute right-0 top-8 z-20 bg-white border border-gray-200 rounded-xl shadow-lg py-1 w-44">
            {carga.status === 'PLANEJADA' && (
              <button
                onClick={(e) => { e.stopPropagation(); setAberto(false); onLiberar() }}
                className="w-full text-left px-4 py-2 text-sm text-blue-700 hover:bg-blue-50"
              >
                Liberar para produção
              </button>
            )}
            {!['CANCELADA', 'RETORNADA', 'BLOQUEADA'].includes(carga.status) && (
              <button
                onClick={(e) => { e.stopPropagation(); setAberto(false); onBloquear() }}
                className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50"
              >
                Bloquear
              </button>
            )}
          </div>
        </>
      )}
    </div>
  )
}

export function Planejamento() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [busca, setBusca] = useState('')
  const [statusFiltro, setStatusFiltro] = useState('')
  const [mesFiltro, setMesFiltro] = useState<number>(new Date().getMonth() + 1)
  const [anoFiltro, setAnoFiltro] = useState<number>(new Date().getFullYear())
  const [modalCarga, setModalCarga] = useState<Carga | null>(null)
  const [modalBloquear, setModalBloquear] = useState<Carga | null>(null)
  const [motivoBloqueio, setMotivoBloqueio] = useState('')

  const { data: cargas = [], isLoading } = useQuery({
    queryKey: ['cargas-planejamento', statusFiltro, mesFiltro, anoFiltro],
    queryFn: () => listarCargas({
      status: statusFiltro || undefined,
      mes: mesFiltro,
      ano: anoFiltro,
    }),
  })

  const mutLiberar = useMutation({
    mutationFn: (args: { id: string; resp: string }) => liberarCarga(args.id, args.resp),
    onSuccess: () => { toast.success('Carga liberada para produção'); qc.invalidateQueries({ queryKey: ['cargas-planejamento'] }) },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao liberar'),
  })

  const mutBloquear = useMutation({
    mutationFn: (args: { id: string; motivo: string }) => bloquearCarga(args.id, args.motivo),
    onSuccess: () => { toast.success('Carga bloqueada'); qc.invalidateQueries({ queryKey: ['cargas-planejamento'] }) },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro'),
  })

  const cargasFiltradas = cargas.filter((c) => {
    if (!busca.trim()) return true
    const q = busca.toLowerCase()
    return (
      c.numero_carga.toLowerCase().includes(q) ||
      (c.familia_principal || '').toLowerCase().includes(q) ||
      (c.responsavel_operacao || '').toLowerCase().includes(q)
    )
  })

  const totalPecas = cargasFiltradas.reduce((s, c) => s + c.quantidade_total_pecas, 0)
  const totalValor = cargasFiltradas.reduce((s, c) => s + c.valor_total, 0)
  const totalAtrasadas = cargasFiltradas.filter((c) => c.atrasada).length

  return (
    <div className="flex flex-col h-full">
      {/* Modais */}
      {modalCarga && (
        <ModalLiberarCarga
          carga={modalCarga}
          onConfirmar={(resp) => {
            mutLiberar.mutate({ id: modalCarga.id, resp })
            setModalCarga(null)
          }}
          onCancelar={() => setModalCarga(null)}
        />
      )}
      {modalBloquear && (
        <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
            <h3 className="font-bold text-gray-900 mb-4">Motivo do bloqueio</h3>
            <input
              value={motivoBloqueio}
              onChange={(e) => setMotivoBloqueio(e.target.value)}
              placeholder="Informe o motivo (obrigatório)"
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-red-400 mb-4"
              autoFocus
            />
            <div className="flex gap-3">
              <button onClick={() => setModalBloquear(null)} className="flex-1 py-2.5 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium">Cancelar</button>
              <button
                onClick={() => {
                  if (!motivoBloqueio.trim()) { toast.error('Motivo obrigatório'); return }
                  mutBloquear.mutate({ id: modalBloquear.id, motivo: motivoBloqueio })
                  setModalBloquear(null)
                  setMotivoBloqueio('')
                }}
                className="flex-1 py-2.5 rounded-lg bg-red-600 text-white text-sm font-medium hover:bg-red-700"
              >
                Bloquear
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 bg-white">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Planejamento de Cargas</h1>
            <p className="text-sm text-gray-500 mt-0.5">
              {cargasFiltradas.length} carga{cargasFiltradas.length !== 1 ? 's' : ''}
              {totalAtrasadas > 0 && <span className="ml-2 text-red-600 font-medium">· {totalAtrasadas} atrasada{totalAtrasadas !== 1 ? 's' : ''}</span>}
            </p>
          </div>
          <button
            onClick={() => navigate('/esterilizacao/nova-carga')}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
          >
            <Plus size={16} /> Nova carga
          </button>
        </div>

        {/* Filtros */}
        <div className="flex flex-wrap gap-3">
          <div className="relative flex-1 min-w-[160px]">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar carga, família..."
              className="w-full pl-8 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          <select
            value={mesFiltro}
            onChange={(e) => setMesFiltro(Number(e.target.value))}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {MESES.map((m, i) => (
              <option key={i} value={i + 1}>{m}</option>
            ))}
          </select>

          <select
            value={anoFiltro}
            onChange={(e) => setAnoFiltro(Number(e.target.value))}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {[2025, 2026, 2027].map((a) => <option key={a} value={a}>{a}</option>)}
          </select>

          <select
            value={statusFiltro}
            onChange={(e) => setStatusFiltro(e.target.value)}
            className="text-sm border border-gray-300 rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-blue-500"
          >
            {STATUS_TODOS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </div>

        {/* Resumo */}
        <div className="flex gap-4 mt-3 text-sm text-gray-600">
          <span><strong className="text-gray-900">{totalPecas.toLocaleString()}</strong> peças</span>
          <span><strong className="text-gray-900">{formatarMoeda(totalValor)}</strong> em valor</span>
        </div>
      </div>

      {/* Tabela */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-48 text-gray-400">Carregando...</div>
        ) : cargasFiltradas.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-gray-400">
            <Package size={36} className="mb-2 opacity-30" />
            <p>Nenhuma carga encontrada</p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
              <tr>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Carga</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Status</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Prioridade</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Saída prevista</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Família</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">Peças</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">Caixas</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">Tempo</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">Valor</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {cargasFiltradas.map((c) => {
                const cfg = STATUS_CARGA_CONFIG[c.status]
                const pri = PRIORIDADE_CONFIG[c.prioridade]
                return (
                  <tr
                    key={c.id}
                    onClick={() => navigate(`/esterilizacao/cargas/${c.id}`)}
                    className={clsx('cursor-pointer hover:bg-gray-50 transition-colors', {
                      'bg-red-50': c.atrasada,
                    })}
                  >
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        {c.atrasada && <AlertTriangle size={13} className="text-red-500 flex-shrink-0" />}
                        <span className="font-semibold text-gray-900">{c.numero_carga}</span>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={clsx('text-xs font-bold uppercase px-2 py-0.5 rounded-full', cfg.corTexto, cfg.corFundo)}>
                        {cfg.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <span className={clsx('text-xs font-semibold px-2 py-0.5 rounded-full', pri.classe)}>
                        {pri.label}
                      </span>
                    </td>
                    <td className="px-4 py-3">
                      <div>
                        <p className={clsx({ 'text-red-600 font-medium': c.atrasada })}>
                          {new Date(c.data_saida_prevista + 'T00:00:00').toLocaleDateString('pt-BR')}
                        </p>
                        {c.dias_para_saida !== undefined && (
                          <p className={clsx('text-xs', {
                            'text-red-500': c.atrasada,
                            'text-orange-500': !c.atrasada && c.dias_para_saida <= 1,
                            'text-gray-400': !c.atrasada && c.dias_para_saida > 1,
                          })}>
                            {c.atrasada ? `${Math.abs(c.dias_para_saida)}d atrasada` : `em ${c.dias_para_saida}d`}
                          </p>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-gray-600 max-w-[120px]">
                      <p className="truncate">{c.familia_principal || '—'}</p>
                    </td>
                    <td className="px-4 py-3 text-right font-medium">{c.quantidade_total_pecas.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right">{c.quantidade_total_caixas}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{formatarTempo(c.tempo_total_estimado_min)}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{formatarMoeda(c.valor_total)}</td>
                    <td className="px-4 py-3" onClick={(e) => e.stopPropagation()}>
                      <MenuAcoes
                        carga={c}
                        onLiberar={() => setModalCarga(c)}
                        onBloquear={() => setModalBloquear(c)}
                      />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import {
  ArrowLeft, Play, CheckCircle, AlertTriangle, Lock,
  Unlock, Clock, Package, Box, TrendingUp, Send,
  RotateCcw, History, ChevronDown, ChevronUp,
} from 'lucide-react'
import { clsx } from 'clsx'
import {
  obterCarga, alterarStatusCarga, bloquearCarga,
  registrarEnvio, registrarRetorno, iniciarEtapa,
  listarHistorico, listarApontamentos,
} from '../../lib/esterilizacaoApi'
import type { StatusCarga, EtapaApontamento } from '../../types/esterilizacao'
import {
  STATUS_CARGA_CONFIG, PRIORIDADE_CONFIG,
  formatarTempo, formatarMoeda,
} from '../../types/esterilizacao'
import { useAuthStore } from '../../store/authStore'

// Modal genérico de confirmação com campo de texto
function ModalTexto({
  titulo, placeholder, onConfirmar, onCancelar, obrigatorio = false, tipo = 'text',
}: {
  titulo: string
  placeholder: string
  onConfirmar: (valor: string) => void
  onCancelar: () => void
  obrigatorio?: boolean
  tipo?: string
}) {
  const [valor, setValor] = useState('')
  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6">
        <h3 className="font-bold text-gray-900 text-lg mb-4">{titulo}</h3>
        <input
          type={tipo}
          value={valor}
          onChange={(e) => setValor(e.target.value)}
          placeholder={placeholder}
          className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 mb-4"
          autoFocus
        />
        <div className="flex gap-3">
          <button onClick={onCancelar} className="flex-1 py-2.5 rounded-lg border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50">
            Cancelar
          </button>
          <button
            onClick={() => {
              if (obrigatorio && !valor.trim()) { toast.error('Campo obrigatório'); return }
              onConfirmar(valor.trim())
            }}
            className="flex-1 py-2.5 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
          >
            Confirmar
          </button>
        </div>
      </div>
    </div>
  )
}

function BadgeStatus({ status }: { status: StatusCarga }) {
  const cfg = STATUS_CARGA_CONFIG[status]
  return (
    <span className={clsx('text-xs font-bold uppercase tracking-wide px-2.5 py-1 rounded-full border', cfg.corBorda, cfg.corTexto, cfg.corFundo)}>
      {cfg.label}
    </span>
  )
}

export function CargaDetalhe() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { usuario } = useAuthStore()
  const [modalAberto, setModalAberto] = useState<string | null>(null)
  const [verHistorico, setVerHistorico] = useState(false)

  const { data: carga, isLoading } = useQuery({
    queryKey: ['carga', id],
    queryFn: () => obterCarga(id!),
    enabled: !!id,
  })

  const { data: historico = [] } = useQuery({
    queryKey: ['historico', id],
    queryFn: () => listarHistorico(id!),
    enabled: !!id && verHistorico,
  })

  const { data: apontamentos = [] } = useQuery({
    queryKey: ['apontamentos', id],
    queryFn: () => listarApontamentos(id!),
    enabled: !!id,
  })

  const invalidar = () => qc.invalidateQueries({ queryKey: ['carga', id] })

  const mutAlterarStatus = useMutation({
    mutationFn: (args: { status: StatusCarga; obs?: string }) =>
      alterarStatusCarga(id!, args.status, args.obs),
    onSuccess: () => { toast.success('Status atualizado'); invalidar() },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao alterar status'),
  })

  const mutBloquear = useMutation({
    mutationFn: (motivo: string) => bloquearCarga(id!, motivo),
    onSuccess: () => { toast.success('Carga bloqueada'); invalidar() },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro'),
  })

  const mutEnviar = useMutation({
    mutationFn: (data: string) => registrarEnvio(id!, data),
    onSuccess: () => { toast.success('Envio registrado'); invalidar() },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro'),
  })

  const mutRetorno = useMutation({
    mutationFn: (data: string) => registrarRetorno(id!, data),
    onSuccess: () => { toast.success('Retorno registrado'); invalidar() },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro'),
  })

  const mutIniciarEtapa = useMutation({
    mutationFn: (etapa: EtapaApontamento) =>
      iniciarEtapa(id!, etapa, usuario?.nome || 'Operador'),
    onSuccess: () => {
      toast.success('Etapa iniciada')
      invalidar()
      qc.invalidateQueries({ queryKey: ['apontamentos', id] })
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro'),
  })

  if (isLoading) return (
    <div className="flex items-center justify-center h-64 text-gray-400">Carregando...</div>
  )
  if (!carga) return (
    <div className="flex flex-col items-center justify-center h-64 gap-2">
      <p className="text-gray-500">Carga não encontrada</p>
      <button onClick={() => navigate(-1)} className="text-blue-600 text-sm">Voltar</button>
    </div>
  )

  const cfg = STATUS_CARGA_CONFIG[carga.status]
  const priCfg = PRIORIDADE_CONFIG[carga.prioridade]
  const apontamentoAtivo = apontamentos.find((a) => a.status === 'INICIADO')

  // Botões de ação contextual
  const acoes: { label: string; icone: React.ReactNode; onClick: () => void; cor: string }[] = []

  if (carga.status === 'LIBERADA') {
    acoes.push({
      label: 'Iniciar Produção', icone: <Play size={16} />,
      onClick: () => mutIniciarEtapa.mutate('PRODUCAO'),
      cor: 'bg-yellow-500 hover:bg-yellow-600 text-white',
    })
  }
  if (carga.status === 'EM_PRODUCAO' && !apontamentoAtivo) {
    acoes.push({
      label: 'Iniciar Separação', icone: <Package size={16} />,
      onClick: () => mutIniciarEtapa.mutate('SEPARACAO'),
      cor: 'bg-orange-500 hover:bg-orange-600 text-white',
    })
  }
  if (carga.status === 'EM_SEPARACAO') {
    acoes.push({
      label: 'Ir para Conferência', icone: <CheckCircle size={16} />,
      onClick: () => mutAlterarStatus.mutate({ status: 'EM_CONFERENCIA' }),
      cor: 'bg-purple-600 hover:bg-purple-700 text-white',
    })
  }
  if (carga.status === 'EM_CONFERENCIA') {
    acoes.push({
      label: 'Marcar como Pronta', icone: <CheckCircle size={16} />,
      onClick: () => mutAlterarStatus.mutate({ status: 'PRONTA' }),
      cor: 'bg-green-600 hover:bg-green-700 text-white',
    })
  }
  if (carga.status === 'PRONTA') {
    acoes.push({
      label: 'Registrar Envio', icone: <Send size={16} />,
      onClick: () => setModalAberto('envio'),
      cor: 'bg-violet-600 hover:bg-violet-700 text-white',
    })
  }
  if (carga.status === 'ENVIADA') {
    acoes.push({
      label: 'Registrar Retorno', icone: <RotateCcw size={16} />,
      onClick: () => setModalAberto('retorno'),
      cor: 'bg-teal-600 hover:bg-teal-700 text-white',
    })
  }
  if (!['CANCELADA', 'RETORNADA', 'BLOQUEADA'].includes(carga.status)) {
    acoes.push({
      label: 'Bloquear', icone: <Lock size={16} />,
      onClick: () => setModalAberto('bloquear'),
      cor: 'bg-red-100 hover:bg-red-200 text-red-700 border border-red-300',
    })
  }

  return (
    <div className="max-w-4xl mx-auto p-4 space-y-4">
      {/* Modais */}
      {modalAberto === 'bloquear' && (
        <ModalTexto
          titulo="Motivo do bloqueio"
          placeholder="Informe o motivo (obrigatório)"
          obrigatorio
          onConfirmar={(v) => { mutBloquear.mutate(v); setModalAberto(null) }}
          onCancelar={() => setModalAberto(null)}
        />
      )}
      {modalAberto === 'envio' && (
        <ModalTexto
          titulo="Data real de envio"
          placeholder="DD/MM/AAAA"
          tipo="date"
          onConfirmar={(v) => { mutEnviar.mutate(v); setModalAberto(null) }}
          onCancelar={() => setModalAberto(null)}
        />
      )}
      {modalAberto === 'retorno' && (
        <ModalTexto
          titulo="Data real de retorno"
          placeholder="DD/MM/AAAA"
          tipo="date"
          onConfirmar={(v) => { mutRetorno.mutate(v); setModalAberto(null) }}
          onCancelar={() => setModalAberto(null)}
        />
      )}

      {/* Nav */}
      <button
        onClick={() => navigate(-1)}
        className="flex items-center gap-1.5 text-sm text-gray-500 hover:text-gray-800 transition-colors"
      >
        <ArrowLeft size={15} /> Voltar ao painel
      </button>

      {/* Cabeçalho da carga */}
      <div className={clsx('rounded-2xl border-2 p-5', cfg.corBorda, cfg.corFundo)}>
        <div className="flex flex-wrap items-start justify-between gap-3 mb-4">
          <div>
            <p className="text-xs text-gray-500 font-medium uppercase tracking-wide mb-1">Carga</p>
            <h1 className="text-2xl font-extrabold text-gray-900">{carga.numero_carga}</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <BadgeStatus status={carga.status} />
            <span className={clsx('text-xs font-semibold px-2.5 py-1 rounded-full', priCfg.classe)}>
              {priCfg.label}
            </span>
          </div>
        </div>

        {/* Grid de dados */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
          <div className="bg-white/70 rounded-xl p-3">
            <p className="text-xs text-gray-500">Saída prevista</p>
            <p className="font-bold text-gray-900">
              {new Date(carga.data_saida_prevista + 'T00:00:00').toLocaleDateString('pt-BR')}
            </p>
            {carga.atrasada && (
              <p className="text-xs text-red-600 font-medium mt-0.5">ATRASADA</p>
            )}
          </div>
          {carga.data_retorno_prevista && (
            <div className="bg-white/70 rounded-xl p-3">
              <p className="text-xs text-gray-500">Retorno previsto</p>
              <p className="font-bold text-gray-900">
                {new Date(carga.data_retorno_prevista + 'T00:00:00').toLocaleDateString('pt-BR')}
              </p>
            </div>
          )}
          <div className="bg-white/70 rounded-xl p-3">
            <p className="text-xs text-gray-500">Peças / Caixas</p>
            <p className="font-bold text-gray-900">
              {carga.quantidade_total_pecas.toLocaleString()} / {carga.quantidade_total_caixas}
            </p>
          </div>
          <div className="bg-white/70 rounded-xl p-3">
            <p className="text-xs text-gray-500">Tempo estimado</p>
            <p className="font-bold text-gray-900">{formatarTempo(carga.tempo_total_estimado_min)}</p>
          </div>
          <div className="bg-white/70 rounded-xl p-3">
            <p className="text-xs text-gray-500">Valor total</p>
            <p className="font-bold text-gray-900">{formatarMoeda(carga.valor_total)}</p>
          </div>
          {carga.responsavel_operacao && (
            <div className="bg-white/70 rounded-xl p-3">
              <p className="text-xs text-gray-500">Responsável</p>
              <p className="font-bold text-gray-900 truncate">{carga.responsavel_operacao}</p>
            </div>
          )}
          {carga.familia_principal && (
            <div className="bg-white/70 rounded-xl p-3">
              <p className="text-xs text-gray-500">Família principal</p>
              <p className="font-bold text-gray-900 truncate">{carga.familia_principal}</p>
            </div>
          )}
        </div>

        {carga.motivo_bloqueio && (
          <div className="mt-3 flex items-start gap-2 bg-red-100 border border-red-300 rounded-lg p-3">
            <AlertTriangle size={15} className="text-red-600 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-xs font-bold text-red-700">Motivo do bloqueio</p>
              <p className="text-sm text-red-700">{carga.motivo_bloqueio}</p>
            </div>
          </div>
        )}
        {carga.observacao && (
          <p className="mt-3 text-sm text-gray-600 italic">{carga.observacao}</p>
        )}
      </div>

      {/* Botões de ação */}
      {acoes.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-gray-700 mb-2">Ações disponíveis</h2>
          <div className="flex flex-wrap gap-2">
            {acoes.map((a) => (
              <button
                key={a.label}
                onClick={a.onClick}
                className={clsx('flex items-center gap-2 px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors', a.cor)}
              >
                {a.icone}
                {a.label}
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Itens */}
      <div>
        <h2 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
          <Box size={16} /> Itens da carga
          <span className="text-sm text-gray-500 font-normal">({carga.itens.length} produto{carga.itens.length !== 1 ? 's' : ''})</span>
        </h2>
        <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-200">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Código SA</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Produto</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Família</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">Qtd</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">Caixas</th>
                  <th className="text-left px-4 py-3 font-semibold text-gray-600">Tipo cx.</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">Tempo</th>
                  <th className="text-right px-4 py-3 font-semibold text-gray-600">Valor</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {carga.itens.map((item) => (
                  <tr key={item.id} className="hover:bg-gray-50 transition-colors">
                    <td className="px-4 py-3 font-mono text-xs text-gray-700">{item.codigo_sa}</td>
                    <td className="px-4 py-3 text-gray-900 max-w-[180px]">
                      <p className="truncate">{item.descricao_produto || '—'}</p>
                      {item.modelo_carga && (
                        <p className="text-xs text-gray-400 truncate">{item.modelo_carga}</p>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-600">{item.familia || '—'}</td>
                    <td className="px-4 py-3 text-right font-medium">{item.quantidade.toLocaleString()}</td>
                    <td className="px-4 py-3 text-right font-medium">{item.quantidade_caixas ?? '—'}</td>
                    <td className="px-4 py-3">
                      {item.tipo_caixa && (
                        <span className={clsx('text-xs font-semibold px-2 py-0.5 rounded', {
                          'bg-green-100 text-green-800':  item.tipo_caixa === 'VERDE',
                          'bg-gray-100 text-gray-800':    item.tipo_caixa === 'BRANCA',
                          'bg-yellow-100 text-yellow-800':item.tipo_caixa === 'AMARELA',
                          'bg-red-100 text-red-800':      item.tipo_caixa === 'VERMELHA',
                        })}>
                          {item.tipo_caixa}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">{formatarTempo(item.tempo_total_min)}</td>
                    <td className="px-4 py-3 text-right text-gray-700">{formatarMoeda(item.valor_total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* Apontamentos ativos */}
      {apontamentos.length > 0 && (
        <div>
          <h2 className="font-semibold text-gray-800 mb-3 flex items-center gap-2">
            <TrendingUp size={16} /> Apontamentos
          </h2>
          <div className="space-y-2">
            {apontamentos.slice(0, 5).map((a) => (
              <div key={a.id} className={clsx('rounded-xl border p-3 flex items-center justify-between gap-3', {
                'border-yellow-300 bg-yellow-50': a.status === 'INICIADO',
                'border-green-300 bg-green-50':  a.status === 'CONCLUIDO',
                'border-gray-200 bg-gray-50':    a.status === 'PAUSADO',
              })}>
                <div>
                  <p className="text-sm font-semibold text-gray-800">{a.etapa}</p>
                  <p className="text-xs text-gray-500">{a.operador}</p>
                </div>
                <div className="text-right">
                  <p className="text-xs text-gray-500">
                    {new Date(a.data_inicio).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
                    {a.data_fim && ` → ${new Date(a.data_fim).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`}
                  </p>
                  {a.duracao_real_min && (
                    <p className="text-xs font-medium text-gray-700">{formatarTempo(a.duracao_real_min)}</p>
                  )}
                  <span className={clsx('text-[10px] font-bold uppercase', {
                    'text-yellow-600': a.status === 'INICIADO',
                    'text-green-600':  a.status === 'CONCLUIDO',
                    'text-gray-500':   a.status === 'PAUSADO',
                  })}>{a.status}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Histórico */}
      <div>
        <button
          onClick={() => setVerHistorico(!verHistorico)}
          className="flex items-center gap-2 text-sm font-semibold text-gray-700 hover:text-gray-900 transition-colors"
        >
          <History size={16} />
          Histórico de alterações
          {verHistorico ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </button>
        {verHistorico && (
          <div className="mt-3 space-y-2">
            {historico.length === 0 ? (
              <p className="text-sm text-gray-400">Nenhuma alteração registrada</p>
            ) : historico.map((h) => (
              <div key={h.id} className="flex items-start gap-3 text-sm">
                <div className="w-2 h-2 rounded-full bg-blue-400 mt-1.5 flex-shrink-0" />
                <div>
                  <span className="text-gray-500 text-xs">
                    {new Date(h.criado_em).toLocaleString('pt-BR')} · <strong>{h.usuario}</strong>
                  </span>
                  <p className="text-gray-700">
                    <strong>{h.campo_alterado}</strong>:
                    {h.valor_anterior && <span className="text-red-500 line-through mx-1">{h.valor_anterior}</span>}
                    <span className="text-green-600 mx-1">{h.valor_novo}</span>
                  </p>
                  {h.motivo && <p className="text-xs text-gray-400 italic">{h.motivo}</p>}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import {
  AlertTriangle, Clock, Package, Box, ChevronRight,
  RefreshCw, Filter,
} from 'lucide-react'
import { clsx } from 'clsx'
import { listarCargas } from '../../lib/esterilizacaoApi'
import type { Carga, StatusCarga } from '../../types/esterilizacao'
import { STATUS_CARGA_CONFIG, PRIORIDADE_CONFIG, formatarTempo } from '../../types/esterilizacao'

type Filtro = 'TODOS' | 'HOJE' | 'AMANHA' | 'SEMANA' | 'ATRASADAS' | 'PRONTA' | 'EM_PRODUCAO' | 'ALTA'

const STATUS_OPERACIONAIS: StatusCarga[] = [
  'LIBERADA', 'EM_PRODUCAO', 'EM_SEPARACAO', 'EM_CONFERENCIA', 'PRONTA', 'ATRASADA', 'BLOQUEADA',
]

function contadorRegressivo(diasParaSaida: number | undefined, atrasada: boolean): {
  texto: string
  classe: string
} {
  if (diasParaSaida === undefined) return { texto: '—', classe: 'text-gray-400' }
  if (atrasada || diasParaSaida < 0) {
    const d = Math.abs(diasParaSaida)
    return { texto: `-${d}d`, classe: 'text-red-600 font-bold' }
  }
  if (diasParaSaida === 0) return { texto: 'Hoje!', classe: 'text-orange-600 font-bold' }
  if (diasParaSaida === 1) return { texto: 'Amanhã', classe: 'text-yellow-600 font-bold' }
  return { texto: `${diasParaSaida}d`, classe: 'text-gray-600' }
}

function CardCarga({ carga }: { carga: Carga }) {
  const navigate = useNavigate()
  const cfg = STATUS_CARGA_CONFIG[carga.status]
  const priCfg = PRIORIDADE_CONFIG[carga.prioridade]
  const contador = contadorRegressivo(carga.dias_para_saida, carga.atrasada)

  return (
    <div
      onClick={() => navigate(`/esterilizacao/cargas/${carga.id}`)}
      className={clsx(
        'relative rounded-xl border-2 p-4 cursor-pointer transition-all hover:shadow-md hover:-translate-y-0.5 select-none',
        cfg.corBorda, cfg.corFundo,
      )}
    >
      {/* Prioridade alta — badge no canto */}
      {carga.prioridade === 'ALTA' && (
        <span className="absolute top-2 right-2 text-[10px] font-bold uppercase bg-red-500 text-white px-1.5 py-0.5 rounded">
          URGENTE
        </span>
      )}

      {/* Header */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div>
          <p className="text-xs text-gray-500 font-medium">Carga</p>
          <p className="text-lg font-bold text-gray-900">{carga.numero_carga}</p>
        </div>
        <span className={clsx('text-xs font-semibold px-2 py-1 rounded-full', priCfg.classe)}>
          {priCfg.label}
        </span>
      </div>

      {/* Status badge */}
      <div className="mb-3">
        <span className={clsx('text-xs font-bold uppercase tracking-wide', cfg.corTexto)}>
          {cfg.label}
        </span>
      </div>

      {/* Data de saída + contador */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-1.5">
          <Clock size={13} className="text-gray-400" />
          <span className="text-xs text-gray-600">
            {new Date(carga.data_saida_prevista + 'T00:00:00').toLocaleDateString('pt-BR')}
          </span>
        </div>
        <span className={clsx('text-sm font-bold', contador.classe)}>
          {contador.texto}
        </span>
      </div>

      {/* Família */}
      {carga.familia_principal && (
        <p className="text-xs font-medium text-gray-700 mb-3 truncate">
          {carga.familia_principal}
        </p>
      )}

      {/* Métricas */}
      <div className="grid grid-cols-3 gap-1 mb-3">
        <div className="text-center bg-white/60 rounded p-1.5">
          <p className="text-xs text-gray-500">Peças</p>
          <p className="text-sm font-bold text-gray-800">
            {carga.quantidade_total_pecas.toLocaleString('pt-BR')}
          </p>
        </div>
        <div className="text-center bg-white/60 rounded p-1.5">
          <p className="text-xs text-gray-500">Caixas</p>
          <p className="text-sm font-bold text-gray-800">{carga.quantidade_total_caixas}</p>
        </div>
        <div className="text-center bg-white/60 rounded p-1.5">
          <p className="text-xs text-gray-500">Tempo</p>
          <p className="text-sm font-bold text-gray-800">{formatarTempo(carga.tempo_total_estimado_min)}</p>
        </div>
      </div>

      {/* Alerta de atraso */}
      {carga.atrasada && (
        <div className="flex items-center gap-1.5 bg-red-100 border border-red-300 rounded p-2 mb-2">
          <AlertTriangle size={13} className="text-red-600 flex-shrink-0" />
          <span className="text-xs text-red-700 font-medium">Carga atrasada</span>
        </div>
      )}

      {/* Botão ver detalhes */}
      <div className="flex items-center justify-end gap-1 text-xs text-gray-500 hover:text-gray-800 transition-colors">
        <span>Ver detalhes</span>
        <ChevronRight size={13} />
      </div>
    </div>
  )
}

const FILTROS: { id: Filtro; label: string }[] = [
  { id: 'TODOS',      label: 'Todos' },
  { id: 'HOJE',       label: 'Hoje' },
  { id: 'AMANHA',     label: 'Amanhã' },
  { id: 'SEMANA',     label: 'Esta semana' },
  { id: 'ATRASADAS',  label: 'Atrasadas' },
  { id: 'PRONTA',     label: 'Prontas p/ envio' },
  { id: 'EM_PRODUCAO',label: 'Em produção' },
  { id: 'ALTA',       label: 'Alta prioridade' },
]

function aplicarFiltro(cargas: Carga[], filtro: Filtro): Carga[] {
  const hoje = new Date()
  hoje.setHours(0, 0, 0, 0)
  const amanha = new Date(hoje)
  amanha.setDate(amanha.getDate() + 1)
  const fimSemana = new Date(hoje)
  fimSemana.setDate(fimSemana.getDate() + 7)

  return cargas.filter((c) => {
    const saida = new Date(c.data_saida_prevista + 'T00:00:00')
    switch (filtro) {
      case 'HOJE':       return saida.getTime() === hoje.getTime()
      case 'AMANHA':     return saida.getTime() === amanha.getTime()
      case 'SEMANA':     return saida >= hoje && saida <= fimSemana
      case 'ATRASADAS':  return c.atrasada
      case 'PRONTA':     return c.status === 'PRONTA'
      case 'EM_PRODUCAO':return c.status === 'EM_PRODUCAO'
      case 'ALTA':       return c.prioridade === 'ALTA'
      default:           return true
    }
  })
}

export function PainelOperador() {
  const [filtro, setFiltro] = useState<Filtro>('TODOS')
  const [autoRefresh, setAutoRefresh] = useState(true)

  const { data: cargas = [], isLoading, refetch } = useQuery({
    queryKey: ['cargas-operador'],
    queryFn: () => listarCargas(),
    refetchInterval: autoRefresh ? 30_000 : false,
    select: (data) => data.filter((c) => STATUS_OPERACIONAIS.includes(c.status)),
  })

  const cargasFiltradas = aplicarFiltro(cargas, filtro)

  // Agrupa por status para a visão kanban
  const grupos: Partial<Record<StatusCarga, Carga[]>> = {}
  for (const c of cargasFiltradas) {
    if (!grupos[c.status]) grupos[c.status] = []
    grupos[c.status]!.push(c)
  }

  const totalAtrasadas = cargas.filter((c) => c.atrasada).length

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="bg-gray-900 text-white px-6 py-4">
        <div className="flex items-center justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold tracking-tight">Painel de Esterilização</h1>
            <p className="text-sm text-gray-400 mt-0.5">
              {cargas.length} carga{cargas.length !== 1 ? 's' : ''} ativa{cargas.length !== 1 ? 's' : ''}
              {totalAtrasadas > 0 && (
                <span className="ml-2 text-red-400 font-medium">
                  · {totalAtrasadas} atrasada{totalAtrasadas !== 1 ? 's' : ''}
                </span>
              )}
            </p>
          </div>
          <button
            onClick={() => refetch()}
            className="flex items-center gap-2 text-sm text-gray-400 hover:text-white transition-colors"
          >
            <RefreshCw size={15} />
            Atualizar
          </button>
        </div>

        {/* Filtros */}
        <div className="flex gap-2 mt-4 flex-wrap">
          {FILTROS.map((f) => (
            <button
              key={f.id}
              onClick={() => setFiltro(f.id)}
              className={clsx(
                'px-3 py-1.5 rounded-full text-sm font-medium transition-colors',
                filtro === f.id
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-800 text-gray-300 hover:bg-gray-700'
              )}
            >
              {f.id === 'ATRASADAS' && totalAtrasadas > 0 && (
                <span className="inline-flex items-center justify-center w-4 h-4 mr-1.5 bg-red-500 text-white text-[10px] rounded-full">
                  {totalAtrasadas}
                </span>
              )}
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {/* Conteúdo */}
      <div className="flex-1 overflow-auto p-4">
        {isLoading ? (
          <div className="flex items-center justify-center h-48 text-gray-400">
            <RefreshCw className="animate-spin mr-2" size={18} />
            Carregando...
          </div>
        ) : cargasFiltradas.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-48 text-gray-400">
            <Package size={40} className="mb-3 opacity-30" />
            <p className="font-medium">Nenhuma carga encontrada</p>
            <p className="text-sm mt-1">Tente outro filtro</p>
          </div>
        ) : (
          <div className="space-y-6">
            {STATUS_OPERACIONAIS.map((status) => {
              const grupo = grupos[status]
              if (!grupo || grupo.length === 0) return null
              const cfg = STATUS_CARGA_CONFIG[status]
              return (
                <div key={status}>
                  <div className="flex items-center gap-2 mb-3">
                    <div className={clsx('w-3 h-3 rounded-full', {
                      'bg-red-500':    status === 'ATRASADA' || status === 'BLOQUEADA',
                      'bg-blue-500':   status === 'LIBERADA',
                      'bg-yellow-400': status === 'EM_PRODUCAO',
                      'bg-orange-500': status === 'EM_SEPARACAO',
                      'bg-purple-500': status === 'EM_CONFERENCIA',
                      'bg-green-500':  status === 'PRONTA',
                    })} />
                    <h2 className="font-semibold text-gray-800">{cfg.label}</h2>
                    <span className="text-sm text-gray-500">({grupo.length})</span>
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
                    {grupo.map((c) => <CardCarga key={c.id} carga={c} />)}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

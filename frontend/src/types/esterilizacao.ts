export type StatusCarga =
  | 'PLANEJADA' | 'LIBERADA' | 'EM_PRODUCAO' | 'EM_SEPARACAO'
  | 'EM_CONFERENCIA' | 'PRONTA' | 'ENVIADA' | 'RETORNADA'
  | 'ATRASADA' | 'BLOQUEADA' | 'CANCELADA'

export type PrioridadeCarga = 'ALTA' | 'NORMAL' | 'BAIXA'

export type TipoCaixa = 'VERDE' | 'BRANCA' | 'AMARELA' | 'VERMELHA'

export type EtapaApontamento = 'PRODUCAO' | 'SEPARACAO' | 'CONFERENCIA' | 'EMBALAGEM'

export interface ProdutoEsteril {
  codigo_sa: string
  codigo_pa?: string
  descricao: string
  familia?: string
  tipo_produto?: string
  qtd_padrao_cx_verde?: number
  qtd_padrao_cx_branca?: number
  qtd_padrao_cx_amarela?: number
  qtd_padrao_cx_vermelha?: number
  tipo_caixa_padrao?: TipoCaixa
  valor_unitario: number
  tempo_producao_seg: number
  tempo_separacao_seg: number
  requer_esterilizacao: boolean
  ativo: boolean
}

export interface ItemCarga {
  id: string
  id_carga: string
  codigo_sa: string
  codigo_pa?: string
  descricao_produto?: string
  familia?: string
  quantidade: number
  quantidade_por_caixa?: number
  tipo_caixa?: string
  quantidade_caixas?: number
  modelo_carga?: string
  valor_unitario: number
  valor_total: number
  tempo_producao_unitario_seg: number
  tempo_separacao_unitario_seg: number
  tempo_producao_total_min: number
  tempo_separacao_total_min: number
  tempo_total_min: number
  observacao?: string
}

export interface Carga {
  id: string
  numero_carga: string
  mes_referencia?: number
  semana_referencia?: number
  ano_referencia: number
  data_inicio_planejada?: string
  hora_inicio_planejada?: string
  data_saida_prevista: string
  data_saida_real?: string
  data_retorno_prevista?: string
  data_retorno_real?: string
  status: StatusCarga
  prioridade: PrioridadeCarga
  responsavel_planejamento?: string
  responsavel_operacao?: string
  observacao?: string
  valor_total: number
  tempo_total_estimado_min: number
  tempo_total_real_min?: number
  quantidade_total_pecas: number
  quantidade_total_caixas: number
  motivo_bloqueio?: string
  motivo_replanejamento?: string
  atrasada: boolean
  dias_para_saida?: number
  familia_principal?: string
  criado_em: string
  atualizado_em: string
  itens: ItemCarga[]
}

export interface Apontamento {
  id: string
  id_carga: string
  etapa: EtapaApontamento
  operador: string
  data_inicio: string
  data_fim?: string
  duracao_real_min?: number
  status: 'INICIADO' | 'PAUSADO' | 'CONCLUIDO'
  problema_reportado?: string
  observacao?: string
}

export interface HistoricoCarga {
  id: string
  id_carga: string
  campo_alterado: string
  valor_anterior?: string
  valor_novo?: string
  usuario: string
  motivo?: string
  criado_em: string
}

export interface SimulacaoItem {
  codigo_sa: string
  descricao?: string
  quantidade: number
  quantidade_por_caixa: number
  tipo_caixa: string
  quantidade_caixas: number
  tempo_producao_total_min: number
  tempo_separacao_total_min: number
  tempo_total_min: number
  valor_total: number
}

export interface SimulacaoCarga {
  itens: SimulacaoItem[]
  total_pecas: number
  total_caixas: number
  total_tempo_producao_min: number
  total_tempo_separacao_min: number
  total_tempo_min: number
  total_valor: number
  dias_necessarios: number
  alertas: string[]
}

export interface DashboardEsterilizacao {
  mes_referencia: number
  ano_referencia: number
  total_cargas: number
  planejadas: number
  liberadas: number
  em_producao: number
  em_separacao: number
  em_conferencia: number
  prontas: number
  enviadas: number
  retornadas: number
  atrasadas: number
  bloqueadas: number
  canceladas: number
  total_pecas_mes: number
  total_caixas_mes: number
  valor_total_mes: number
  aderencia_plan: number
  tempo_medio_ciclo_min?: number
}

// Config visual por status
export const STATUS_CARGA_CONFIG: Record<StatusCarga, {
  label: string
  cor: string
  corTexto: string
  corBorda: string
  corFundo: string
}> = {
  PLANEJADA:      { label: 'Planejada',           cor: 'gray',   corTexto: 'text-gray-700',   corBorda: 'border-gray-400',  corFundo: 'bg-gray-50' },
  LIBERADA:       { label: 'Liberada',             cor: 'blue',   corTexto: 'text-blue-700',   corBorda: 'border-blue-500',  corFundo: 'bg-blue-50' },
  EM_PRODUCAO:    { label: 'Em Produção',          cor: 'yellow', corTexto: 'text-yellow-800', corBorda: 'border-yellow-500',corFundo: 'bg-yellow-50' },
  EM_SEPARACAO:   { label: 'Em Separação',         cor: 'orange', corTexto: 'text-orange-700', corBorda: 'border-orange-500',corFundo: 'bg-orange-50' },
  EM_CONFERENCIA: { label: 'Em Conferência',       cor: 'purple', corTexto: 'text-purple-700', corBorda: 'border-purple-400',corFundo: 'bg-purple-50' },
  PRONTA:         { label: 'Pronta para Envio',    cor: 'green',  corTexto: 'text-green-700',  corBorda: 'border-green-500', corFundo: 'bg-green-50' },
  ENVIADA:        { label: 'Enviada',              cor: 'violet', corTexto: 'text-violet-700', corBorda: 'border-violet-500',corFundo: 'bg-violet-50' },
  RETORNADA:      { label: 'Retornada',            cor: 'teal',   corTexto: 'text-teal-700',   corBorda: 'border-teal-500',  corFundo: 'bg-teal-50' },
  ATRASADA:       { label: 'Atrasada',             cor: 'red',    corTexto: 'text-red-700',    corBorda: 'border-red-500',   corFundo: 'bg-red-50' },
  BLOQUEADA:      { label: 'Bloqueada',            cor: 'red',    corTexto: 'text-red-800',    corBorda: 'border-red-700',   corFundo: 'bg-red-100' },
  CANCELADA:      { label: 'Cancelada',            cor: 'gray',   corTexto: 'text-gray-500',   corBorda: 'border-gray-300',  corFundo: 'bg-gray-100' },
}

export const PRIORIDADE_CONFIG: Record<PrioridadeCarga, { label: string; classe: string }> = {
  ALTA:   { label: 'Alta',   classe: 'bg-red-100 text-red-800' },
  NORMAL: { label: 'Normal', classe: 'bg-blue-100 text-blue-800' },
  BAIXA:  { label: 'Baixa',  classe: 'bg-gray-100 text-gray-600' },
}

export function formatarTempo(minutos: number): string {
  if (!minutos) return '—'
  const h = Math.floor(minutos / 60)
  const m = minutos % 60
  if (h === 0) return `${m}min`
  if (m === 0) return `${h}h`
  return `${h}h${m}min`
}

export function formatarMoeda(valor: number): string {
  return valor.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
}

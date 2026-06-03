export type StatusPedido =
  | 'LIBERADO' | 'EM_INVENTARIO' | 'AGUARD_VERIFICACAO'
  | 'DIVERGENCIA' | 'AGUARD_TRATATIVA' | 'EM_PROCESSO_SISTEMICO'
  | 'AGUARD_FATURAMENTO' | 'FATURADO' | 'AGUARD_COLETA'
  | 'COLETADO' | 'EXPEDIDO' | 'BLOQUEADO' | 'CANCELADO'

export type TipoFrete = 'FOB' | 'CIF_COM_VALOR' | 'CIF_SEM_VALOR'

export type Prioridade = 'NORMAL' | 'ALTA' | 'CRITICA'

export type PerfilUsuario =
  | 'OPERADOR' | 'CONFERENTE' | 'LIDER' | 'SUPERVISOR'
  | 'FATURAMENTO' | 'QUALIDADE' | 'GERENCIA' | 'ADMIN'

export interface Usuario {
  id: string
  nome: string
  email: string
  perfil: PerfilUsuario
  ativo: boolean
}

export interface Cliente {
  id: string
  codigo: string
  nome: string
  cnpj?: string
  contato?: string
  prioridade: number
  ativo: boolean
}

export interface Transportadora {
  id: string
  nome: string
  cnpj?: string
  contato?: string
  sla_horas: number
  ativo: boolean
}

export interface Produto {
  id: string
  codigo: string
  descricao: string
  familia?: string
  unidade: string
  ativo: boolean
}

export interface Lote {
  id: string
  produto_id: string
  numero_lote: string
  validade?: string
  quantidade_disp: number
}

export interface ItemPedido {
  id: string
  produto_id: string
  lote_id?: string
  qtd_solicitada: number
  qtd_separada?: number
  qtd_conferida?: number
  qtd_divergente?: number
  status_item: string
  produto?: Produto
  lote?: Lote
}

export interface Pedido {
  id: string
  numero_pedido: string
  cliente_id: string
  transportadora_id?: string
  status: StatusPedido
  prioridade: Prioridade
  tipo_frete?: TipoFrete
  local_entrega?: string
  data_prevista_entrega: string
  data_prevista_coleta?: string
  data_real_coleta?: string
  numero_nf?: string
  valor_nf?: number
  observacoes?: string
  atrasado: boolean
  criado_em: string
  atualizado_em: string
  cliente?: Cliente
  transportadora?: Transportadora
  itens?: ItemPedido[]
  cliente_nome?: string
  transportadora_nome?: string
}

export interface InventarioItem {
  id: string
  pedido_id: string
  codigo_item: string
  lote: string
  qtd_sistemico: number
  qtd_fisico?: number
  qtd_venda: number
  qtd_estoque?: number
  status_item: 'PENDENTE' | 'OK' | 'DIVERGENCIA'
  observacao?: string
}

export interface Cubagem {
  id: string
  pedido_id: string
  peso_kg?: number
  altura_cm?: number
  largura_cm?: number
  comprimento_cm?: number
  num_caixas?: number
  observacao?: string
  criado_em: string
}

export interface Pallet {
  id: string
  codigo: string
  transportadora_id?: string
  transportadora_nome?: string
  status: 'ABERTO' | 'FECHADO' | 'COLETADO'
  data_prevista_coleta?: string
  data_real_coleta?: string
  observacao?: string
  criado_em: string
  pedidos: any[]
  total_caixas: number
}

export interface Ocorrencia {
  id: string
  pedido_id: string
  tipo: string
  descricao: string
  responsavel_id: string
  status: 'ABERTA' | 'EM_TRATATIVA' | 'FECHADA'
  resolucao?: string
  criado_em: string
  resolvido_em?: string
}

export interface Movimentacao {
  id: string
  pedido_id: string
  status_anterior?: string
  status_novo: string
  usuario_id: string
  observacao?: string
  criado_em: string
}

export interface ResumoStatus {
  status: string
  quantidade: number
  atrasados: number
}

export interface DashboardOperacional {
  data: string
  total_pedidos: number
  expedidos_hoje: number
  atrasados: number
  por_status: ResumoStatus[]
  ocorrencias_abertas: number
}

export interface Indicadores {
  otif: number
  taxa_divergencia: number
  taxa_retrabalho: number
  lead_time_medio_horas: number
  pedidos_expedidos: number
  backlog: number
  aderencia_cutoff?: number
}

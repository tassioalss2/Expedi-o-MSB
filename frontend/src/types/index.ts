export type StatusPedido =
  | 'AGUARD_DADOS_OV'
  | 'AGUARD_PRODUCAO'
  | 'AGUARD_CREDITO'
  | 'LIBERADO' | 'EM_INVENTARIO' | 'AGUARD_VERIFICACAO'
  | 'DIVERGENCIA' | 'AGUARD_TRATATIVA' | 'EM_PROCESSO_SISTEMICO'
  | 'EM_COTACAO_FRETE' | 'AGUARD_TRANSPORTADORA'
  | 'AGUARD_FATURAMENTO' | 'FATURADO' | 'AGUARD_COLETA'
  | 'COLETADO' | 'EXPEDIDO' | 'BLOQUEADO' | 'CANCELADO'

export type TipoFrete = 'FOB' | 'CIF_COM_VALOR' | 'CIF_SEM_VALOR'

export type Prioridade = 'NORMAL' | 'ALTA' | 'CRITICA'

export type PerfilUsuario =
  | 'LOGISTICA' | 'OPERACOES_VENDAS' | 'COMERCIAL' | 'DIRETORIA' | 'ADMIN'

export const PERFIL_LABELS: Record<PerfilUsuario, string> = {
  LOGISTICA: 'Logística',
  OPERACOES_VENDAS: 'Operações de Vendas',
  COMERCIAL: 'Comercial',
  DIRETORIA: 'Diretoria',
  ADMIN: 'Admin / TI',
}

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

export type LinhaComercial = 'URO' | 'VASCULAR' | 'REALCLOSURE'

export interface Produto {
  id: string
  codigo: string
  descricao: string
  familia?: string
  /** Linha comercial. Vazio = deduzida pela família (fallback do backend). */
  linha?: LinhaComercial | null
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

/** Oportunidade do CRM que gerou a OV. Presente só quando a OV nasceu do funil —
 *  é o que habilita "Voltar para o CRM" na tela da OV. */
export interface OrigemCrm {
  oportunidade_id: string
  titulo: string | null
  estagio: string | null
  tem_pendencia: boolean
  pode_voltar: boolean
  motivo_bloqueio: string | null
}

export interface Pedido {
  id: string
  numero_pedido: string
  crm?: OrigemCrm | null
  cliente_id: string
  transportadora_id?: string
  status: StatusPedido
  prioridade: Prioridade
  tipo_frete?: TipoFrete
  valor_frete?: number
  tipo_operacao?: string
  canal?: string
  /** DIRETA | LICITACAO — a linha da meta vem dos itens, não daqui. */
  forma_venda?: string
  local_entrega?: string
  condicao_pagamento?: string
  data_prevista_entrega: string
  data_esperada_cliente?: string
  data_prevista_coleta?: string
  data_real_coleta?: string
  numero_nf?: string
  valor_nf?: number
  data_faturamento?: string
  codigo_rastreio?: string
  observacoes?: string
  atrasado: boolean
  criado_em: string
  atualizado_em: string
  /** Quando a OV foi expedida de fato (movimentação para EXPEDIDO). Não confundir
   *  com `atualizado_em`, que muda a cada toque na linha. */
  expedido_em?: string | null
  cliente?: Cliente
  transportadora?: Transportadora
  itens?: ItemPedido[]
  cliente_nome?: string
  transportadora_nome?: string
  pedido_pai_id?: string
  remessa_numero?: number
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
  otif_on_time?: number
  otif_in_full?: number
  taxa_divergencia: number
  taxa_retrabalho: number
  lead_time_medio_horas: number
  pedidos_expedidos: number
  backlog: number
  aderencia_cutoff?: number
}

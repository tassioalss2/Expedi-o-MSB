import type { StatusPedido } from '../types'

export interface StatusConfig {
  label: string
  cor: string
  corTexto: string
  icone: string
  descricao: string
  responsavel?: string
}

export const STATUS_CONFIG: Record<StatusPedido, StatusConfig> = {
  LIBERADO:               { label: 'Liberado',             cor: '#E5E7EB', corTexto: '#374151', icone: '📋', descricao: 'OV recebida via Teams — aguardando inventário', responsavel: 'Operador 1' },
  EM_INVENTARIO:          { label: 'Em Inventário',        cor: '#DBEAFE', corTexto: '#1D4ED8', icone: '📦', descricao: 'Operador 1 preenchendo inventário contínuo', responsavel: 'Operador 1' },
  AGUARD_VERIFICACAO:     { label: 'Aguard. Verificação',  cor: '#FEF3C7', corTexto: '#92400E', icone: '🔍', descricao: 'Operador 2 verifica estoque físico', responsavel: 'Operador 2' },
  DIVERGENCIA:            { label: 'Divergência',          cor: '#FEE2E2', corTexto: '#991B1B', icone: '⚠️', descricao: 'Estoque físico divergente — acionar supervisor', responsavel: 'Supervisor' },
  AGUARD_TRATATIVA:       { label: 'Aguard. Tratativa',    cor: '#FECACA', corTexto: '#7F1D1D', icone: '🔴', descricao: 'Supervisor resolvendo divergência', responsavel: 'Supervisor' },
  EM_PROCESSO_SISTEMICO:  { label: 'Proc. Sistêmico',      cor: '#F3E8FF', corTexto: '#6B21A8', icone: '💻', descricao: 'Operador 1 processando no D365 + registrar cubagem', responsavel: 'Operador 1' },
  AGUARD_FATURAMENTO:     { label: 'Aguard. Faturamento',  cor: '#EDE9FE', corTexto: '#4C1D95', icone: '🧾', descricao: 'Cubagem enviada — aguardando NF de Op. Vendas', responsavel: 'Op. Vendas' },
  FATURADO:               { label: 'Faturado',             cor: '#E0E7FF', corTexto: '#3730A3', icone: '📄', descricao: 'NF recebida — alocar no pallet', responsavel: 'Expedição' },
  AGUARD_COLETA:          { label: 'No Pallet',            cor: '#CCFBF1', corTexto: '#134E4A', icone: '🚛', descricao: 'Caixas no pallet — aguardando transportadora', responsavel: 'Expedição' },
  COLETADO:               { label: 'Coletado',             cor: '#DCFCE7', corTexto: '#166534', icone: '🏁', descricao: 'Transportadora coletou' },
  EXPEDIDO:               { label: 'Expedido',             cor: '#BBF7D0', corTexto: '#14532D', icone: '✅', descricao: 'Expedição finalizada com sucesso' },
  BLOQUEADO:              { label: 'Bloqueado',            cor: '#450A0A', corTexto: '#FECACA', icone: '🔒', descricao: 'Pedido travado — aguardando resolução' },
  CANCELADO:              { label: 'Cancelado',            cor: '#D1D5DB', corTexto: '#374151', icone: '❌', descricao: 'Pedido encerrado sem expedição' },
}

export const ORDEM_KANBAN: StatusPedido[] = [
  'LIBERADO',
  'EM_INVENTARIO',
  'AGUARD_VERIFICACAO',
  'DIVERGENCIA',
  'EM_PROCESSO_SISTEMICO',
  'AGUARD_FATURAMENTO',
  'FATURADO',
  'AGUARD_COLETA',
  'EXPEDIDO',
]

export const TIPO_FRETE_LABEL: Record<string, string> = {
  FOB: 'FOB',
  CIF_COM_VALOR: 'CIF com Valor NF',
  CIF_SEM_VALOR: 'CIF sem Valor NF',
}

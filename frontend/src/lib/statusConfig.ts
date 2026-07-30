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
  AGUARD_DADOS_OV:        { label: 'Dados da OV',          cor: '#DBEAFE', corTexto: '#1E3A8A', icone: '🆕', descricao: 'Venda ganha no CRM — falta o número real da OV (D365) e a data de entrega', responsavel: 'Op. Vendas' },
  AGUARD_CREDITO:         { label: 'Ger. Crédito',         cor: '#FEF9C3', corTexto: '#713F12', icone: '💳', descricao: 'OV aguardando aprovação de crédito no D365 — separação bloqueada', responsavel: 'Op. Vendas' },
  LIBERADO:               { label: 'Liberado',             cor: '#E5E7EB', corTexto: '#374151', icone: '📋', descricao: 'OV recebida via Teams — aguardando inventário', responsavel: 'Operador 1' },
  EM_INVENTARIO:          { label: 'Em Inventário',        cor: '#DBEAFE', corTexto: '#1D4ED8', icone: '📦', descricao: 'Operador 1 preenchendo inventário contínuo', responsavel: 'Operador 1' },
  AGUARD_VERIFICACAO:     { label: 'Aguard. Verificação',  cor: '#FEF3C7', corTexto: '#92400E', icone: '🔍', descricao: 'Operador 2 verifica estoque físico', responsavel: 'Operador 2' },
  DIVERGENCIA:            { label: 'Divergência',          cor: '#FEE2E2', corTexto: '#991B1B', icone: '⚠️', descricao: 'Estoque físico divergente — acionar supervisor', responsavel: 'Supervisor' },
  AGUARD_TRATATIVA:       { label: 'Aguard. Tratativa',    cor: '#FECACA', corTexto: '#7F1D1D', icone: '🔴', descricao: 'Supervisor resolvendo divergência', responsavel: 'Supervisor' },
  EM_PROCESSO_SISTEMICO:  { label: 'Proc. Sistêmico',      cor: '#F3E8FF', corTexto: '#6B21A8', icone: '💻', descricao: 'Operador 1 processando no D365 + registrar cubagem', responsavel: 'Operador 1' },
  EM_COTACAO_FRETE:       { label: 'Cotação de Frete',     cor: '#FEF3C7', corTexto: '#92400E', icone: '🚚', descricao: 'OV CIF aguardando cotação do frete antes de faturar', responsavel: 'Logística' },
  AGUARD_TRANSPORTADORA:  { label: 'Aguard. Transportadora', cor: '#FFEDD5', corTexto: '#9A3412', icone: '📥', descricao: 'OV FOB aguardando o cliente informar a transportadora (vai na NF)', responsavel: 'Op. Vendas' },
  AGUARD_FATURAMENTO:     { label: 'Aguard. Faturamento',  cor: '#EDE9FE', corTexto: '#4C1D95', icone: '🧾', descricao: 'Cubagem enviada — aguardando NF de Op. Vendas', responsavel: 'Op. Vendas' },
  FATURADO:               { label: 'Faturado',             cor: '#E0E7FF', corTexto: '#3730A3', icone: '📄', descricao: 'NF recebida — alocar no pallet', responsavel: 'Expedição' },
  AGUARD_COLETA:          { label: 'No Pallet',            cor: '#CCFBF1', corTexto: '#134E4A', icone: '🚛', descricao: 'Caixas no pallet — aguardando transportadora', responsavel: 'Expedição' },
  COLETADO:               { label: 'Coletado',             cor: '#DCFCE7', corTexto: '#166534', icone: '🏁', descricao: 'Transportadora coletou' },
  EXPEDIDO:               { label: 'Expedido',             cor: '#BBF7D0', corTexto: '#14532D', icone: '✅', descricao: 'Expedição finalizada com sucesso' },
  BLOQUEADO:              { label: 'Bloqueado',            cor: '#450A0A', corTexto: '#FECACA', icone: '🔒', descricao: 'Pedido travado — aguardando resolução' },
  CANCELADO:              { label: 'Cancelado',            cor: '#D1D5DB', corTexto: '#374151', icone: '❌', descricao: 'Pedido encerrado sem expedição' },
}

export const ORDEM_KANBAN: StatusPedido[] = [
  'AGUARD_DADOS_OV',
  'AGUARD_CREDITO',
  'LIBERADO',
  'EM_INVENTARIO',
  'AGUARD_VERIFICACAO',
  'EM_PROCESSO_SISTEMICO',
  'EM_COTACAO_FRETE',
  'AGUARD_TRANSPORTADORA',
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

export const OPERACAO_LABEL: Record<string, string> = {
  VENDA_NORMAL: 'Venda normal',
  COMUNICADO_USO: 'Comunicado de uso',
  BONIFICACAO_DOACAO: 'Bonificação/Doação',
  AMOSTRA: 'Amostra',
  CONSIGNADO: 'Consignado',
}

export const CANAL_LABEL: Record<string, string> = {
  URO: 'Uro',
  VASCULAR: 'Vascular',
  REALCLOSURE: 'Realclosure',
  LICITACAO_URO: 'Licitação - Uro',
  LICITACAO_VASCULAR: 'Licitação - Vascular',
  LICITACAO: 'Licitação',
}

/** Retorna o nome da transportadora, incluindo o nome real quando "OUTROS" foi selecionado. */
export function resolveNomeTransportadora(nome?: string, observacoes?: string): string {
  if (!nome) return ''
  if (nome.toUpperCase().includes('OUTROS') && observacoes) {
    const match = observacoes.match(/\[Transp\. real: ([^\]]+)\]/)
    if (match) return `OUTROS (${match[1]})`
  }
  return nome
}

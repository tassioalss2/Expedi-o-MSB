// Config compartilhada do CRM — estágios do funil, cores e helpers de formato.

export type EstagioKey = 'QUALIFICACAO' | 'DESAFIOS' | 'NEGOCIACAO' | 'PROPOSTA' | 'GANHO' | 'PERDIDO'

export interface EstagioCfg {
  key: EstagioKey
  label: string
  prob: number
  // classes Tailwind
  coluna: string   // faixa do topo da coluna
  chip: string     // badge
  ponto: string    // bolinha/cor sólida
}

// A ordem segue o processo real: negocia-se volume/preço/condições e a PROPOSTA
// formaliza o acordo — é ela que decide ganho/perda. (Antes estava o contrário.)
//
// DESAFIOS é etapa opcional: dá visibilidade a negócio parado esperando cadastro
// de fornecedor, registro ANVISA, amostra com o médico. O que trava o avanço não é
// "passar por lá", é ter desafio bloqueante aberto.
//
// As probabilidades aqui são só o valor BASE; o servidor devolve `probabilidade`
// já ajustada por dias parado, ausência de próximo passo e concorrente conhecido.
export const ESTAGIOS: EstagioCfg[] = [
  { key: 'QUALIFICACAO', label: 'Qualificada',  prob: 25,  coluna: 'bg-sky-500',      chip: 'bg-sky-100 text-sky-700',       ponto: 'bg-sky-500' },
  { key: 'DESAFIOS',     label: 'Desafios',     prob: 30,  coluna: 'bg-orange-500',   chip: 'bg-orange-100 text-orange-700', ponto: 'bg-orange-500' },
  { key: 'NEGOCIACAO',   label: 'Negociação',   prob: 50,  coluna: 'bg-amber-500',    chip: 'bg-amber-100 text-amber-700',   ponto: 'bg-amber-500' },
  { key: 'PROPOSTA',     label: 'Proposta',     prob: 75,  coluna: 'bg-violet-500',   chip: 'bg-violet-100 text-violet-700', ponto: 'bg-violet-500' },
  { key: 'GANHO',        label: 'Ganho',        prob: 100, coluna: 'bg-emerald-600',  chip: 'bg-emerald-100 text-emerald-700', ponto: 'bg-emerald-600' },
  { key: 'PERDIDO',      label: 'Perdido',      prob: 0,   coluna: 'bg-red-500',      chip: 'bg-red-100 text-red-700',       ponto: 'bg-red-500' },
]

// Colunas exibidas no funil (abertas + ganho). Perdido é acessível pelo card.
export const ESTAGIOS_PIPELINE: EstagioKey[] = ['QUALIFICACAO', 'DESAFIOS', 'NEGOCIACAO', 'PROPOSTA', 'GANHO']

export const ESTAGIO_MAP: Record<string, EstagioCfg> = Object.fromEntries(ESTAGIOS.map(e => [e.key, e])) as any

// ── Pendência de estoque ──────────────────────────────────────────────────────
// Coluna VIRTUAL do funil: não é um estágio, é um recorte de "tem pendência de
// material em aberto". A oportunidade continua no estágio dela — só aparece aqui
// em vez de na coluna de origem, para o comercial ver o que está travado.
export const COLUNA_PENDENCIA = 'PENDENCIA_ESTOQUE'

export interface ItemDisponibilidade {
  ref?: number
  produto_id?: string | null
  codigo?: string | null
  descricao?: string | null
  qtd_pedida: number
  disponivel: number | null
  estoque_sa: number | null
  qtd_atendida: number
  qtd_pendente: number
  valor_unitario: number
  valor_pendente: number
  sem_dado: boolean
  cobre_com_sa: boolean | null
  status: 'OK' | 'SA' | 'FALTA' | 'SEM_DADO'
}

export interface Disponibilidade {
  itens: ItemDisponibilidade[]
  tem_falta: boolean
  tudo_disponivel: boolean
  valor_pendente: number
  qtd_pendente_total: number
  cobre_com_sa: boolean
  previsao_sa: string | null
  data_ref: string | null
  desatualizado: boolean
  sem_dado: string[]
}

export type FontePendencia = 'oportunidade' | 'pedido'

export interface Pendencia {
  fonte: FontePendencia
  id: string
  titulo: string | null
  cliente: string | null
  cliente_id: string | null
  canal: string | null
  ov_id: string | null
  ov_ref: string | null
  ov_status: string | null
  ov_provisoria: boolean
  decisao: 'PARCIAL' | 'AGUARDAR' | null
  origem: string | null
  valor: number
  qtd_total: number
  itens: ItemDisponibilidade[]
  previsao_sa: string | null
  previsao_pcp: string | null
  cobre_com_sa: boolean | null
  observacao: string | null
  /** Cada cobrança feita ao PCP, em ordem. Mostra promessa furada sem ninguém
   *  ter que lembrar: "prometeram dia 10, empurraram para 20". */
  acompanhamentos?: AcompanhamentoPendencia[]
  /** Posição escolhida à mão na fila do material (menor = primeiro).
   *  null = a fila decide sozinha, por tempo de espera. */
  prioridade_fila?: number | null
  prioridade_por_nome?: string | null
  prioridade_em?: string | null
  /** Posição atual na fila, contando de 1 — já com a prioridade manual aplicada. */
  posicao_fila?: number
  decidido_em: string | null
  dias_parada: number | null
  resolvido_em: string | null
  resolucao: string | null
  /** "Aguardar produção" sem OV: nada saiu, então o que falta é a venda inteira
   *  e o `qtd_atendida` gravado no item é o estoque do dia da decisão — nunca
   *  uma entrega. */
  nada_entregue?: boolean
  acao_liberar: 'GERAR_OV' | 'SOMAR_R1' | 'REMESSA_2' | null
  pode_liberar: boolean
  motivo_bloqueio: string | null
  estagio?: string | null
  oportunidade_id?: string | null
  /** Quanto do que falta JÁ existe em estoque hoje — calculado no servidor, com
   *  rateio entre as pendências (a mesma unidade não é prometida duas vezes). */
  estoque_agora?: EstoqueAgora | null
}

export interface AcompanhamentoPendencia {
  em: string
  por?: string | null
  por_nome?: string | null
  observacao?: string | null
  previsao_pcp?: string | null
  /** Data que a previsão tinha antes desta cobrança — é o que revela atraso. */
  previsao_anterior?: string | null
}

export interface EstoqueAgora {
  status: 'COMPLETO' | 'PARCIAL' | 'NENHUM'
  qtd_disponivel: number
  valor_disponivel: number
  itens_prontos: number
  itens_total: number
  itens: Array<{
    codigo: string | null
    qtd_atendida: number
    qtd_pendente: number
    /** Estoque do código como um todo, antes do rateio da fila. */
    disponivel?: number | null
    /** Quanto a fila levou antes desta pendência. */
    reservado_antes?: number
    /** Quem está na frente segurando este código — é o que explica um zero
     *  quando a tela de Estoque mostra saldo. */
    reservado_para?: Array<{ ov: string | null; cliente: string | null; qtd: number }>
  }>
}

export interface PendenciasResp {
  pendencias: Pendencia[]
  total: number
  quantidade: number
  aguardando: number
  parciais: number
  com_estoque: number
  com_estoque_parcial: number
  valor_liberavel: number
  estoque_desatualizado: boolean
  estoque_data_ref: string | null
  /** Quantas pendências foram posicionadas à mão. Zero = fila 100% automática. */
  priorizadas_a_mao?: number
}

// O que acontece ao liberar, em português — o comercial precisa saber se vai sair
// uma nota nova ou se entra na mesma.
export const ACAO_LIBERAR_LABEL: Record<string, string> = {
  GERAR_OV: 'Abre a OV agora',
  SOMAR_R1: 'Soma na OV atual (nota única)',
  REMESSA_2: '2ª remessa — mesma OV, NF nova',
}

export const STATUS_ITEM_COR: Record<string, string> = {
  OK: 'text-emerald-700 bg-emerald-50 border-emerald-200',
  SA: 'text-amber-700 bg-amber-50 border-amber-200',
  FALTA: 'text-red-700 bg-red-50 border-red-200',
  SEM_DADO: 'text-slate-600 bg-slate-50 border-slate-200',
}

// "Licitação" saiu: licitação vive no módulo próprio, não no CRM.
export const ORIGENS = ['Indicação', 'Prospecção ativa', 'Cliente recorrente', 'Evento/Congresso', 'Inbound', 'Outro']

export const TIPOS_ATIVIDADE: { key: string; label: string; icone: string }[] = [
  { key: 'LIGACAO', label: 'Ligação', icone: '📞' },
  { key: 'REUNIAO', label: 'Reunião', icone: '🤝' },
  { key: 'EMAIL', label: 'E-mail', icone: '✉️' },
  { key: 'VISITA', label: 'Visita', icone: '🚗' },
  { key: 'TAREFA', label: 'Tarefa', icone: '✅' },
]
export const TIPO_ATIV_MAP: Record<string, { label: string; icone: string }> =
  Object.fromEntries(TIPOS_ATIVIDADE.map(t => [t.key, { label: t.label, icone: t.icone }]))

export const fmtBRL = (v: number) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
export const fmtBRLcurto = (v: number) => {
  const n = Number(v) || 0
  if (Math.abs(n) >= 1000) return 'R$ ' + (n / 1000).toLocaleString('pt-BR', { maximumFractionDigits: 1 }) + 'k'
  return fmtBRL(n)
}
export const fmtData = (d?: string | null) => d ? new Date((d.length <= 10 ? d + 'T12:00:00' : d)).toLocaleDateString('pt-BR') : '—'
export const fmtDataHora = (d?: string | null) => d ? new Date(d).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'

// Nome do campo em português, para o erro de validação dizer o que falta em vez
// do "Field required" cru que o FastAPI devolve.
const CAMPO_LABEL: Record<string, string> = {
  condicao_pagamento: 'Condição de pagamento',
  numero_pedido: 'Número da OV',
  data_prevista_entrega: 'Data esperada pelo cliente',
  cliente_id: 'Cliente',
  cliente_cnpj: 'CNPJ do cliente',
  tipo_operacao: 'Tipo de operação',
  canal: 'Canal',
  forma_venda: 'Forma de venda',
  itens: 'Itens',
  numero_nf: 'Número da NF',
  valor_nf: 'Valor da NF',
  qtd: 'Quantidade',
  prazo: 'Prazo',
  numero: 'Número',
}

export function msgErro(e: any, fb: string) {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  // 422 do FastAPI: lista de erros com o caminho do campo em `loc`. Sem traduzir,
  // a tela mostrava só "Field required" e ninguém sabia qual campo faltava — foi o
  // que aconteceu quando a condição de pagamento virou obrigatória e um formulário
  // ficou sem o campo.
  if (Array.isArray(d)) {
    const faltando = d
      .filter((x: any) => (x?.type || '').includes('missing') || /required/i.test(x?.msg || ''))
      .map((x: any) => {
        const campo = (x?.loc || []).filter((l: any) => l !== 'body').pop()
        return CAMPO_LABEL[campo] || campo
      })
      .filter(Boolean)
    if (faltando.length) {
      return `Falta preencher: ${[...new Set(faltando)].join(', ')}.`
    }
    const x = d[0]
    const campo = (x?.loc || []).filter((l: any) => l !== 'body').pop()
    const nome = CAMPO_LABEL[campo] || campo
    return nome ? `${nome}: ${x?.msg || fb}` : (x?.msg || fb)
  }
  if (d?.msg) return d.msg
  return fb
}

// Cor do prazo/previsão: vencido (vermelho), ≤3 dias (âmbar)
export function prazoCor(d?: string | null): string {
  if (!d) return 'text-gray-400'
  const dias = Math.ceil((new Date((d.length <= 10 ? d + 'T12:00:00' : d)).getTime() - Date.now()) / 86400000)
  if (dias < 0) return 'text-red-600 font-semibold'
  if (dias <= 3) return 'text-amber-600 font-medium'
  return 'text-gray-500'
}

// Config compartilhada do CRM — estágios do funil, cores e helpers de formato.

export type EstagioKey = 'LEAD' | 'QUALIFICACAO' | 'PROPOSTA' | 'NEGOCIACAO' | 'GANHO' | 'PERDIDO'

export interface EstagioCfg {
  key: EstagioKey
  label: string
  prob: number
  // classes Tailwind
  coluna: string   // faixa do topo da coluna
  chip: string     // badge
  ponto: string    // bolinha/cor sólida
}

export const ESTAGIOS: EstagioCfg[] = [
  { key: 'LEAD',         label: 'Lead',         prob: 10,  coluna: 'bg-slate-400',   chip: 'bg-slate-100 text-slate-700',   ponto: 'bg-slate-400' },
  { key: 'QUALIFICACAO', label: 'Qualificação', prob: 25,  coluna: 'bg-sky-500',      chip: 'bg-sky-100 text-sky-700',       ponto: 'bg-sky-500' },
  { key: 'PROPOSTA',     label: 'Proposta',     prob: 50,  coluna: 'bg-violet-500',   chip: 'bg-violet-100 text-violet-700', ponto: 'bg-violet-500' },
  { key: 'NEGOCIACAO',   label: 'Negociação',   prob: 75,  coluna: 'bg-amber-500',    chip: 'bg-amber-100 text-amber-700',   ponto: 'bg-amber-500' },
  { key: 'GANHO',        label: 'Ganho',        prob: 100, coluna: 'bg-emerald-600',  chip: 'bg-emerald-100 text-emerald-700', ponto: 'bg-emerald-600' },
  { key: 'PERDIDO',      label: 'Perdido',      prob: 0,   coluna: 'bg-red-500',      chip: 'bg-red-100 text-red-700',       ponto: 'bg-red-500' },
]

// Colunas exibidas no funil (abertas + ganho). Perdido é acessível pelo card.
export const ESTAGIOS_PIPELINE: EstagioKey[] = ['LEAD', 'QUALIFICACAO', 'PROPOSTA', 'NEGOCIACAO', 'GANHO']

export const ESTAGIO_MAP: Record<string, EstagioCfg> = Object.fromEntries(ESTAGIOS.map(e => [e.key, e])) as any

export const ORIGENS = ['Licitação', 'Indicação', 'Prospecção ativa', 'Cliente recorrente', 'Evento/Congresso', 'Inbound', 'Outro']

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

export function msgErro(e: any, fb: string) {
  const d = e?.response?.data?.detail
  if (typeof d === 'string') return d
  if (Array.isArray(d)) return d[0]?.msg || fb
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

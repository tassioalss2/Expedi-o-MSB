import { X } from 'lucide-react'
import { LINHA_DO_CANAL } from '../../lib/statusConfig'

/** As linhas de produto, pelo ROTULO — que e o valor do filtro em todas as abas
 *  do CRM. Rotulo e nao canal porque a mesma linha tem dois canais (URO e
 *  LICITACAO_URO): filtrar por canal deixaria a metade de licitacao de fora. */
export const LINHAS_ROTULO = [...new Set(
  ['URO', 'VASCULAR', 'REALCLOSURE'].map(c => LINHA_DO_CANAL[c] || c))]

export const inputCls = 'w-full border rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-400'

export function Campo({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><label className="text-sm text-gray-600">{label}</label>{children}</div>
}

export function ModalBase({ titulo, onClose, children, max = 'max-w-2xl' }: {
  titulo: React.ReactNode; onClose: () => void; children: React.ReactNode; max?: string
}) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div className={`bg-white rounded-2xl w-full ${max} max-h-[90vh] flex flex-col`} onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b flex items-center justify-between">
          <h2 className="text-lg font-bold">{titulo}</h2>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><X size={18} /></button>
        </div>
        {children}
      </div>
    </div>
  )
}

/** Input de moeda: digita só números, formata como "120.000,00" em tempo real
 *  (padrão de caixa eletrônico — os últimos 2 dígitos são sempre centavos).
 *  `value`/`onChange` trafegam o número puro (ex.: 120000), não a string
 *  formatada — quem consome não precisa saber que existe máscara aqui. */
export function InputMoeda({ value, onChange, placeholder, className }: {
  value: number | null; onChange: (v: number | null) => void; placeholder?: string; className?: string
}) {
  const centavos = value == null ? '' : String(Math.round(value * 100))

  const formatar = (digitos: string) => {
    if (!digitos) return ''
    const n = Number(digitos) / 100
    return n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
  }

  const handle = (e: React.ChangeEvent<HTMLInputElement>) => {
    const digitos = e.target.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '')
    onChange(digitos ? Number(digitos) / 100 : null)
  }

  return (
    <div className="relative">
      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400 pointer-events-none">R$</span>
      <input
        inputMode="numeric"
        value={formatar(centavos)}
        onChange={handle}
        placeholder={placeholder || '0,00'}
        className={`${className || inputCls} pl-9 text-right tabular-nums`}
      />
    </div>
  )
}

export function KPI({ label, valor, sub, cor = 'text-gray-800' }: { label: string; valor: string; sub?: string; cor?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
      <p className="text-[11px] uppercase tracking-wide text-gray-400">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${cor}`}>{valor}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

/** Filtro de linha, em BOTOES e nao em lista suspensa.
 *
 * Pedido do Tassio, e ele tem razao: sao TRES linhas (Uro, Vascular,
 * Realclosure). Lista suspensa esconde as opcoes atras de um clique e nao
 * mostra qual esta ativa sem abrir — para tres valores, botao diz tudo de uma
 * vez e troca em um clique em vez de dois.
 *
 * `semLinha` existe para a tela ser honesta: registro sem linha (cotacao sem
 * canal, atividade sem oportunidade) NAO aparece quando uma linha e escolhida, e
 * some sem explicacao se ninguem disser. Hoje sao 16 das 93 cotacoes.
 */
export function FiltroLinha({ valor, onMudar, linhas, semLinha }: {
  valor: string
  onMudar: (linha: string) => void
  /** As linhas que existem nos dados desta aba, na ordem de exibicao. */
  linhas: string[]
  semLinha?: number
}) {
  return (
    <div>
      <div className="flex rounded-lg border border-gray-200 bg-white p-0.5">
        {([['', 'Todas'], ...linhas.map(l => [l, l] as const)] as const).map(([v, label]) => (
          <button key={v} onClick={() => onMudar(v)}
            className={`rounded-md px-3 py-1.5 text-sm font-medium transition ${
              valor === v ? 'bg-blue-600 text-white' : 'text-gray-600 hover:bg-gray-50'}`}>
            {label}
          </button>
        ))}
      </div>
      {valor && !!semLinha && (
        <p className="mt-1 text-[11px] text-gray-500">
          {semLinha} sem linha definida {semLinha === 1 ? 'não aparece' : 'não aparecem'} neste filtro
        </p>
      )}
    </div>
  )
}

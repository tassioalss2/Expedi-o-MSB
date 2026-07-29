import { X } from 'lucide-react'

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

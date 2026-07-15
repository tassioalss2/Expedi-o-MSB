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

export function KPI({ label, valor, sub, cor = 'text-gray-800' }: { label: string; valor: string; sub?: string; cor?: string }) {
  return (
    <div className="bg-white rounded-xl border border-gray-100 shadow-sm p-4">
      <p className="text-[11px] uppercase tracking-wide text-gray-400">{label}</p>
      <p className={`text-2xl font-bold mt-1 ${cor}`}>{valor}</p>
      {sub && <p className="text-xs text-gray-400 mt-0.5">{sub}</p>}
    </div>
  )
}

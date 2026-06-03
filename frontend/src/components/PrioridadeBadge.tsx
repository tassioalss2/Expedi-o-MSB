import type { Prioridade } from '../types'

const CONFIG: Record<Prioridade, { label: string; cor: string }> = {
  NORMAL:  { label: 'Normal',  cor: 'bg-gray-100 text-gray-600' },
  ALTA:    { label: 'Alta',    cor: 'bg-yellow-100 text-yellow-800' },
  CRITICA: { label: 'Crítica', cor: 'bg-red-100 text-red-800 font-bold' },
}

export function PrioridadeBadge({ prioridade }: { prioridade: Prioridade }) {
  const cfg = CONFIG[prioridade]
  return (
    <span className={`px-2 py-0.5 rounded text-xs ${cfg.cor}`}>
      {prioridade === 'CRITICA' && '🔴 '}{cfg.label}
    </span>
  )
}

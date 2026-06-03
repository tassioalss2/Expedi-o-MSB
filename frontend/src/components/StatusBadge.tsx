import type { StatusPedido } from '../types'
import { STATUS_CONFIG } from '../lib/statusConfig'

interface Props {
  status: StatusPedido
  size?: 'sm' | 'md' | 'lg'
}

export function StatusBadge({ status, size = 'md' }: Props) {
  const cfg = STATUS_CONFIG[status]
  const padding = size === 'sm' ? 'px-2 py-0.5 text-xs' : size === 'lg' ? 'px-4 py-2 text-base' : 'px-3 py-1 text-sm'

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full font-semibold ${padding}`}
      style={{ backgroundColor: cfg.cor, color: cfg.corTexto }}
    >
      <span>{cfg.icone}</span>
      {cfg.label}
    </span>
  )
}

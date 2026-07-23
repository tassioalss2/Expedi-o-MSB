import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search } from 'lucide-react'
import api from '../lib/api'

// Substitui o texto livre por autocompletar de cidade/UF (IBGE) para o "Local
// de Entrega" — o operador digita e o app recomenda, sem cada um escrever o
// mesmo lugar de um jeito diferente.
export function LocalEntregaInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [busca, setBusca] = useState(value || '')
  const [aberto, setAberto] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => { setBusca(value || '') }, [value])

  const { data: sugestoes = [] } = useQuery<string[]>({
    queryKey: ['localidades-busca', busca],
    queryFn: () => api.get('/localidades/buscar', { params: { q: busca } }).then(r => r.data),
    enabled: busca.trim().length >= 2,
  })

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const selecionar = (cidade: string) => {
    setBusca(cidade)
    setAberto(false)
    onChange(cidade)
  }

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={busca}
          onChange={e => { setBusca(e.target.value); setAberto(true); onChange(e.target.value) }}
          onFocus={() => { if (busca.trim().length >= 2) setAberto(true) }}
          placeholder="Digite a cidade…"
          className="w-full border rounded-lg pl-9 pr-3 py-2.5 text-sm"
        />
      </div>
      {aberto && busca.trim().length >= 2 && sugestoes.length > 0 && (
        <div className="absolute z-50 w-full bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-60 overflow-y-auto">
          {sugestoes.map(s => (
            <button key={s} onClick={() => selecionar(s)}
              className="w-full text-left px-4 py-2 hover:bg-blue-50 text-sm border-b border-gray-50 last:border-0">
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

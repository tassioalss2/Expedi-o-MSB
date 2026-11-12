import { useEffect, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'

/** Escolhe um tipo de caixa do cadastro.
 *
 *  Vive aqui, e não dentro de uma tela, porque duas telas medem a mesma caixa:
 *  a cubagem da OV e a cotação avulsa. Duas cópias deste campo acabariam
 *  divergindo — e aí a mesma caixa teria dois volumes.
 *
 *  A medida mora na DESCRIÇÃO do cadastro, entre parênteses; é de lá que o
 *  backend tira o m³. Por isso `onSelect` devolve a descrição junto: quem
 *  chama precisa dela para mostrar o volume sem ter de consultar de novo.
 */
export function TipoCaixaAutocomplete({ value, onSelect }: {
  value: string
  onSelect: (id: string, codigo: string, descricao: string) => void
}) {
  const [busca, setBusca] = useState(value)
  const [aberto, setAberto] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const { data: tipos = [] } = useQuery({
    queryKey: ['tipos-caixa', busca],
    queryFn: () => api.get('/tipos-caixa', { params: busca ? { search: busca } : {} }).then(r => r.data),
  })

  useEffect(() => {
    function click(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false)
    }
    document.addEventListener('mousedown', click)
    return () => document.removeEventListener('mousedown', click)
  }, [])

  return (
    <div ref={ref} className="relative">
      <input type="text" value={busca}
        onChange={e => { setBusca(e.target.value); setAberto(true) }}
        onFocus={() => setAberto(true)}
        placeholder="Digite ou role para escolher..."
        className="w-full border rounded-lg px-3 py-2 text-sm"
      />
      {aberto && (
        <div className="absolute z-50 w-full bg-white border border-gray-200 rounded-lg shadow-xl mt-1 max-h-48 overflow-y-auto">
          {(tipos as any[]).length === 0 && <p className="px-3 py-2 text-xs text-gray-400">Nenhum tipo encontrado</p>}
          {(tipos as any[]).map((t: any) => (
            <button key={t.id} onClick={() => { setBusca(t.codigo); setAberto(false); onSelect(t.id, t.codigo, t.descricao || '') }}
              className="w-full text-left px-3 py-2 hover:bg-blue-50 border-b border-gray-50 last:border-0">
              <p className="text-sm font-medium text-gray-800">{t.codigo}</p>
              <p className="text-xs text-gray-400">{t.descricao}</p>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export default TipoCaixaAutocomplete

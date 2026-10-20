import { useState, useRef, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'

interface Pais { sigla: string; nome: string; regiao?: string | null }

/** "Buenos Aires — Argentina" → { cidade, pais }. O travessão separa porque a
 *  barra já significa UF brasileira no resto do app, e sigla de país colide com
 *  sigla de estado: PA é Pará e Panamá, PR é Paraná e Porto Rico. */
function parseExterior(v: string): { cidade: string; pais: string } {
  const m = /^(.*?)\s*[—–-]\s*([^—–-]+)$/.exec((v || '').trim())
  if (m) return { cidade: m[1].trim(), pais: m[2].trim() }
  return { cidade: '', pais: (v || '').trim() }
}

const limpa = (t: string) =>
  t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()

/** Local de entrega quando a OV é de EXPORTAÇÃO: país (lista do IBGE) e cidade
 *  digitada. A cidade é livre de propósito — não existe cadastro de municípios
 *  do mundo inteiro, e inventar um seria pior do que deixar o operador escrever
 *  o que está no documento de embarque. */
export function LocalEntregaExportacao({ value, onChange }: {
  value: string; onChange: (v: string) => void
}) {
  const inicial = parseExterior(value)
  const [pais, setPais] = useState(inicial.pais)
  const [cidade, setCidade] = useState(inicial.cidade)
  const [busca, setBusca] = useState('')
  const [aberto, setAberto] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const { data: paises = [] } = useQuery<Pais[]>({
    queryKey: ['localidades-paises'],
    queryFn: () => api.get('/localidades/paises').then(r => r.data),
    staleTime: Infinity,
  })

  const sugestoes = useMemo(() => {
    const q = limpa(busca)
    if (!q) return paises.slice(0, 40)
    return paises.filter(p => limpa(p.nome).includes(q)
      || p.sigla.toLowerCase() === q).slice(0, 40)
  }, [paises, busca])

  useEffect(() => {
    function fora(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false)
    }
    document.addEventListener('mousedown', fora)
    return () => document.removeEventListener('mousedown', fora)
  }, [])

  const emitir = (novaCidade: string, novoPais: string) => {
    onChange(novaCidade && novoPais ? `${novaCidade} — ${novoPais}`
      : (novoPais || novaCidade || ''))
  }

  return (
    <div className="grid grid-cols-2 gap-2">
      <div ref={ref} className="relative">
        <input type="text" value={pais || busca}
          onChange={e => {
            setBusca(e.target.value)
            setPais('')
            setAberto(true)
            emitir(cidade, e.target.value)
          }}
          onFocus={() => setAberto(true)}
          placeholder="País de destino…"
          className="w-full border rounded-lg px-3 py-2.5 text-sm" />
        {aberto && sugestoes.length > 0 && (
          <div className="absolute z-50 w-full bg-white border border-gray-200 rounded-lg
                          shadow-lg mt-1 max-h-60 overflow-y-auto">
            {sugestoes.map(p => (
              <button key={p.sigla} type="button"
                onClick={() => {
                  setPais(p.nome)
                  setBusca('')
                  setAberto(false)
                  emitir(cidade, p.nome)
                }}
                className="w-full text-left px-4 py-2 hover:bg-blue-50 text-sm
                           border-b border-gray-50 last:border-0">
                <span className="font-mono text-xs text-gray-400 mr-2">{p.sigla}</span>
                {p.nome}
                {p.regiao && <span className="text-[11px] text-gray-400 ml-2">{p.regiao}</span>}
              </button>
            ))}
          </div>
        )}
      </div>
      <input type="text" value={cidade}
        onChange={e => { setCidade(e.target.value); emitir(e.target.value, pais) }}
        placeholder="Cidade de entrega…"
        className="w-full border rounded-lg px-3 py-2.5 text-sm" />
    </div>
  )
}

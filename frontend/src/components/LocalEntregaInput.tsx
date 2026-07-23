import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'

interface Estado { uf: string; nome: string }

function parseLocal(v: string): { cidade: string; uf: string } {
  const m = /^(.*)\/([A-Za-z]{2})$/.exec((v || '').trim())
  if (m) return { cidade: m[1].trim(), uf: m[2].toUpperCase() }
  return { cidade: (v || '').trim(), uf: '' }
}

// Substitui o texto livre por UF + Cidade (lista oficial do IBGE) para o
// "Local de Entrega" sair sempre no mesmo formato ("Cidade/UF"), evitando que
// cada operador grave o mesmo lugar de um jeito diferente.
export function LocalEntregaInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parsedInit = parseLocal(value)
  const [uf, setUf] = useState(parsedInit.uf)
  const [cidade, setCidade] = useState(parsedInit.cidade)

  const { data: estados = [] } = useQuery<Estado[]>({
    queryKey: ['localidades-estados'],
    queryFn: () => api.get('/localidades/estados').then(r => r.data),
    staleTime: Infinity,
  })
  const { data: municipios = [], isFetching } = useQuery<string[]>({
    queryKey: ['localidades-municipios', uf],
    queryFn: () => api.get('/localidades/municipios', { params: { uf } }).then(r => r.data),
    enabled: !!uf,
    staleTime: Infinity,
  })

  const emitir = (novaCidade: string, novaUf: string) => {
    onChange(novaCidade && novaUf ? `${novaCidade}/${novaUf}` : (novaCidade || novaUf || ''))
  }
  const mudarUf = (v: string) => { setUf(v); setCidade(''); emitir('', v) }
  const mudarCidade = (v: string) => { setCidade(v); emitir(v, uf) }

  return (
    <div className="grid grid-cols-3 gap-2">
      <select value={uf} onChange={e => mudarUf(e.target.value)}
        className="col-span-1 border rounded-lg px-3 py-2.5 text-sm">
        <option value="">UF…</option>
        {estados.map(e => <option key={e.uf} value={e.uf}>{e.uf}</option>)}
      </select>
      <select value={cidade} onChange={e => mudarCidade(e.target.value)} disabled={!uf}
        className="col-span-2 border rounded-lg px-3 py-2.5 text-sm disabled:bg-gray-50 disabled:text-gray-400">
        <option value="">{!uf ? 'Selecione a UF primeiro' : isFetching ? 'Carregando…' : 'Cidade…'}</option>
        {municipios.map(m => <option key={m} value={m}>{m}</option>)}
        {cidade && !municipios.includes(cidade) && <option value={cidade}>{cidade}</option>}
      </select>
    </div>
  )
}

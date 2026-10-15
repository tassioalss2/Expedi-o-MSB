import { useState, useRef, useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'

interface Estado { uf: string; nome: string }

function parseLocal(v: string): { cidade: string; uf: string } {
  const m = /^(.*)\/([A-Za-z]{2})$/.exec((v || '').trim())
  if (m) return { cidade: m[1].trim(), uf: m[2].toUpperCase() }
  return { cidade: (v || '').trim(), uf: '' }
}

// Substitui o texto livre por UF + cidade (lista oficial do IBGE) — o operador
// escolhe a UF e digita a cidade, que o app recomenda com autocompletar (a
// lista de cada UF já vem em cache, então o filtro é local e instantâneo).
export function LocalEntregaInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const parsedInit = parseLocal(value)
  const [uf, setUf] = useState(parsedInit.uf)
  const [cidade, setCidade] = useState(parsedInit.cidade)
  const [aberto, setAberto] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

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

  // Sem acento dos dois lados: ninguém digita "São José do Rio Preto" com os
  // acentos certos no meio de um cadastro, e "sao jose" tem de achar a cidade.
  const sugestoes = useMemo(() => {
    const limpa = (t: string) =>
      t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim()
    const q = limpa(cidade)
    if (!q) return municipios.slice(0, 30)
    return municipios.filter(m => limpa(m).includes(q)).slice(0, 30)
  }, [municipios, cidade])

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const emitir = (novaCidade: string, novaUf: string) => {
    onChange(novaCidade && novaUf ? `${novaCidade}/${novaUf}` : (novaCidade || novaUf || ''))
  }
  const mudarUf = (v: string) => { setUf(v); setCidade(''); emitir('', v) }
  const digitarCidade = (v: string) => { setCidade(v); setAberto(true); emitir(v, uf) }
  const selecionarCidade = (c: string) => { setCidade(c); setAberto(false); emitir(c, uf) }

  return (
    <div className="grid grid-cols-3 gap-2">
      <select value={uf} onChange={e => mudarUf(e.target.value)}
        className="col-span-1 border rounded-lg px-3 py-2.5 text-sm">
        <option value="">UF…</option>
        {estados.map(e => <option key={e.uf} value={e.uf}>{e.uf}</option>)}
      </select>
      <div ref={ref} className="relative col-span-2">
        <input type="text" value={cidade} disabled={!uf}
          onChange={e => digitarCidade(e.target.value)}
          onFocus={() => { if (uf) setAberto(true) }}
          placeholder={!uf ? 'Selecione a UF primeiro' : isFetching ? 'Carregando cidades…' : 'Digite a cidade…'}
          className="w-full border rounded-lg px-3 py-2.5 text-sm disabled:bg-gray-50 disabled:text-gray-400" />
        {/* Lista vazia tem dois motivos muito diferentes: a cidade digitada
            não existe naquela UF, ou a lista não carregou. Ficar mudo fazia o
            operador achar que o campo estava quebrado. */}
        {uf && !isFetching && municipios.length === 0 && (
          <p className="mt-1 text-[11px] text-amber-700">
            Não consegui carregar as cidades de {uf}. Recarregue a página; se continuar,
            me avise.
          </p>
        )}
        {uf && municipios.length > 0 && cidade.trim() && sugestoes.length === 0 && (
          <p className="mt-1 text-[11px] text-gray-500">
            Nenhuma cidade de {uf} com esse nome.
          </p>
        )}
        {aberto && uf && sugestoes.length > 0 && (
          <div className="absolute z-50 w-full bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-60 overflow-y-auto">
            {sugestoes.map(c => (
              <button key={c} type="button" onClick={() => selecionarCidade(c)}
                className="w-full text-left px-4 py-2 hover:bg-blue-50 text-sm border-b border-gray-50 last:border-0">
                {c}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

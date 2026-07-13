import { useState, useRef, useEffect } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, Plus, Trash2, Package } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'
import type { Produto } from '../types'

export type ItemLinha = { produto_id: string; codigo: string; descricao: string; qtd: number }

export function ItensPedido({ value, onChange }: { value: ItemLinha[]; onChange: (itens: ItemLinha[]) => void }) {
  const [busca, setBusca] = useState('')
  const [aberto, setAberto] = useState(false)
  const [selecionado, setSelecionado] = useState<Produto | null>(null)
  const [qtd, setQtd] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const qtdRef = useRef<HTMLInputElement>(null)

  const { data: produtos = [] } = useQuery<Produto[]>({
    queryKey: ['produtos-busca', busca],
    queryFn: () => api.get('/produtos/busca', { params: { q: busca } }).then(r => r.data),
    enabled: busca.length >= 2 && !selecionado,
  })

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const escolher = (p: Produto) => {
    setSelecionado(p)
    setBusca(`${p.codigo} — ${p.descricao}`)
    setAberto(false)
    setTimeout(() => qtdRef.current?.focus(), 0)
  }

  const limpar = () => {
    setSelecionado(null)
    setBusca('')
    setQtd('')
  }

  const adicionar = () => {
    if (!selecionado) return
    const q = Number(qtd)
    if (!q || q <= 0) { toast.error('Informe uma quantidade válida'); return }
    if (value.some(i => i.produto_id === selecionado.id)) {
      toast.error('Este item já foi adicionado'); return
    }
    onChange([...value, { produto_id: selecionado.id, codigo: selecionado.codigo, descricao: selecionado.descricao, qtd: q }])
    limpar()
  }

  const remover = (produto_id: string) => onChange(value.filter(i => i.produto_id !== produto_id))

  const atualizarQtd = (produto_id: string, novaQtd: number) =>
    onChange(value.map(i => i.produto_id === produto_id ? { ...i, qtd: novaQtd } : i))

  return (
    <div className="space-y-2">
      {/* Linha de adição: autocomplete + quantidade */}
      <div className="flex gap-2 items-start">
        <div ref={ref} className="relative flex-1">
          <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input
            type="text"
            value={busca}
            onChange={e => {
              setBusca(e.target.value)
              setSelecionado(null)
              setAberto(true)
            }}
            onFocus={() => { if (busca.length >= 2 && !selecionado) setAberto(true) }}
            placeholder="Digite o código ou nome do item…"
            className="w-full border rounded-lg pl-9 pr-4 py-2.5 text-sm"
          />
          {aberto && busca.length >= 2 && !selecionado && (
            <div className="absolute z-50 w-full bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-60 overflow-y-auto">
              {produtos.length === 0 ? (
                <div className="px-4 py-3 text-sm text-gray-400">Nenhum item encontrado</div>
              ) : produtos.map(p => (
                <button key={p.id} type="button" onClick={() => escolher(p)}
                  className="w-full text-left px-4 py-2.5 hover:bg-blue-50 text-sm border-b border-gray-50 last:border-0">
                  <span className="font-mono font-medium text-gray-800">{p.codigo}</span>
                  <span className="text-gray-500 ml-2">{p.descricao}</span>
                </button>
              ))}
            </div>
          )}
        </div>
        <input
          ref={qtdRef}
          type="number"
          min="0"
          step="1"
          value={qtd}
          onChange={e => setQtd(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); adicionar() } }}
          placeholder="Qtd"
          className="w-24 border rounded-lg px-3 py-2.5 text-sm"
        />
        <button type="button" onClick={adicionar} disabled={!selecionado}
          className="flex items-center gap-1 px-3 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-40 text-white rounded-lg text-sm font-medium whitespace-nowrap">
          <Plus size={16} /> Add
        </button>
      </div>

      {/* Lista de itens adicionados */}
      {value.length === 0 ? (
        <div className="flex items-center gap-2 text-xs text-gray-400 px-1 py-2">
          <Package size={14} /> Nenhum item adicionado ainda.
        </div>
      ) : (
        <div className="border border-gray-100 rounded-lg divide-y divide-gray-100 overflow-hidden">
          {value.map(i => (
            <div key={i.produto_id} className="flex items-center gap-2 px-3 py-2 text-sm">
              <div className="flex-1 min-w-0">
                <span className="font-mono font-medium text-gray-800">{i.codigo}</span>
                <span className="text-gray-500 ml-2">{i.descricao}</span>
              </div>
              <input
                type="number"
                min="0"
                step="1"
                value={i.qtd}
                onChange={e => atualizarQtd(i.produto_id, Number(e.target.value))}
                className="w-20 border rounded-lg px-2 py-1 text-sm text-right"
              />
              <button type="button" onClick={() => remover(i.produto_id)}
                className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded-lg">
                <Trash2 size={15} />
              </button>
            </div>
          ))}
          <div className="flex justify-between px-3 py-2 bg-gray-50 text-xs text-gray-500">
            <span>{value.length} item(ns)</span>
            <span>Total: <strong className="text-gray-700">{value.reduce((a, i) => a + (i.qtd || 0), 0)}</strong> un</span>
          </div>
        </div>
      )}
    </div>
  )
}

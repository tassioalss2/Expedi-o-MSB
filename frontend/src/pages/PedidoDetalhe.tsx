import { useState, useRef, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, Trash2, CheckCircle, XCircle, Copy, Package, FileText, Truck } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import api from '../lib/api'
import type { InventarioItem, Pedido, Cubagem } from '../types'
import { StatusBadge } from '../components/StatusBadge'
import { PrioridadeBadge } from '../components/PrioridadeBadge'
import { TIPO_FRETE_LABEL } from '../lib/statusConfig'
import { calcHorasComerciais, formatarTempo, corSLA, bgSLA } from '../lib/horasComerciais'
import { imprimirEtiqueta, verificarZebraConectado, ZEBRA_DOWNLOAD_URL } from '../lib/zebraPrint'
import { useAuthStore } from '../store/authStore'
import toast from 'react-hot-toast'

// ── Linha de info ─────────────────────────────────────────────────────────────
function Linha({ label, valor }: { label: string; valor?: string | number | null }) {
  return (
    <div className="flex justify-between py-2 border-b border-gray-50 last:border-0">
      <span className="text-sm text-gray-500">{label}</span>
      <span className="text-sm text-gray-900 font-medium">{valor ?? '—'}</span>
    </div>
  )
}

// ── Autocomplete de Produto ───────────────────────────────────────────────────
function ProdutoAutocomplete({ value, onChange }: {
  value: string
  onChange: (codigo: string, descricao: string) => void
}) {
  const [busca, setBusca] = useState(value)
  const [aberto, setAberto] = useState(false)
  const ref = useRef<HTMLDivElement>(null)

  const { data: produtos = [] } = useQuery({
    queryKey: ['produtos-busca', busca],
    queryFn: () => api.get('/produtos/busca', { params: { q: busca } }).then(r => r.data),
    enabled: busca.length >= 2,
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
      <input
        type="text"
        value={busca}
        onChange={e => { setBusca(e.target.value); setAberto(true); onChange(e.target.value, '') }}
        onFocus={() => busca.length >= 2 && setAberto(true)}
        placeholder="Código ou descrição..."
        className="w-full border rounded px-2 py-1.5 text-sm"
      />
      {aberto && busca.length >= 2 && (produtos as any[]).length > 0 && (
        <div className="absolute z-50 w-80 bg-white border border-gray-200 rounded-lg shadow-xl mt-1 max-h-52 overflow-y-auto">
          {(produtos as any[]).map((p: any) => (
            <button key={p.id} onClick={() => { setBusca(p.codigo); setAberto(false); onChange(p.codigo, p.descricao) }}
              className="w-full text-left px-3 py-2 hover:bg-blue-50 text-xs border-b border-gray-50 last:border-0">
              <span className="font-bold text-gray-800">{p.codigo}</span>
              <span className="text-gray-400 ml-2 block truncate">{p.descricao}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Modal Inventário Contínuo ─────────────────────────────────────────────────
function ModalInventario({ pedido, onClose }: { pedido: Pedido; onClose: () => void }) {
  const qc = useQueryClient()
  const [itens, setItens] = useState<Omit<InventarioItem, 'id' | 'pedido_id' | 'qtd_estoque' | 'status_item'>[]>([
    { codigo_item: '', lote: '', qtd_sistemico: 0, qtd_fisico: undefined, qtd_venda: 0, observacao: '' }
  ])

  const addLinha = () => setItens([...itens, { codigo_item: '', lote: '', qtd_sistemico: 0, qtd_fisico: undefined, qtd_venda: 0, observacao: '' }])
  const removeLinha = (i: number) => setItens(itens.filter((_, idx) => idx !== i))

  const update = (i: number, campo: string, valor: any) => {
    const novo = [...itens]
    ;(novo[i] as any)[campo] = valor
    setItens(novo)
  }

  const mutation = useMutation({
    mutationFn: () => api.post(`/pedidos/${pedido.id}/inventario`, { itens }),
    onSuccess: () => {
      toast.success('Inventário salvo! Aguardando verificação física.')
      qc.invalidateQueries({ queryKey: ['pedido', pedido.id] })
      onClose()
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || 'Erro ao salvar inventário'),
  })

  const podeEnviar = itens.every(i => i.codigo_item && i.lote)

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl w-full max-w-4xl my-4">
        <div className="p-5 border-b flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">📦 Inventário Contínuo — {pedido.numero_pedido}</h2>
            <p className="text-sm text-gray-500 mt-0.5">Preencha código, lote e quantidades de cada item</p>
          </div>
          <button onClick={addLinha} className="flex items-center gap-1 text-sm text-blue-600 hover:underline">
            <Plus size={16} /> Adicionar item
          </button>
        </div>

        <div className="p-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b">
                <th className="pb-2 pr-3">Código *</th>
                <th className="pb-2 pr-3">Lote *</th>
                <th className="pb-2 pr-3 text-right">Qtd Sistema</th>
                <th className="pb-2 pr-3 text-right">Qtd Físico</th>
                <th className="pb-2 pr-3 text-right">Qtd Venda</th>
                <th className="pb-2 pr-3 text-right text-blue-600">Estoque</th>
                <th className="pb-2 pr-3">Obs.</th>
                <th className="pb-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-50">
              {itens.map((item, i) => {
                const estoque = ((item.qtd_fisico ?? item.qtd_sistemico) - item.qtd_venda)
                const divergente = item.qtd_fisico !== undefined && item.qtd_fisico !== item.qtd_sistemico
                return (
                  <tr key={i} className={divergente ? 'bg-red-50' : ''}>
                    <td className="py-2 pr-3">
                      <ProdutoAutocomplete
                        value={item.codigo_item}
                        onChange={(codigo, descricao) => {
                          update(i, 'codigo_item', codigo)
                          if (descricao) update(i, 'observacao', descricao)
                        }}
                      />
                    </td>
                    <td className="py-2 pr-3">
                      <input type="text" value={item.lote}
                        onChange={e => update(i, 'lote', e.target.value)}
                        className="w-32 border rounded px-2 py-1 text-sm"
                        placeholder="Ex: 000049-26-01" />
                    </td>
                    <td className="py-2 pr-3">
                      <input type="number" value={item.qtd_sistemico} min={0}
                        onChange={e => update(i, 'qtd_sistemico', Number(e.target.value))}
                        className="w-20 border rounded px-2 py-1 text-sm text-right" />
                    </td>
                    <td className="py-2 pr-3">
                      <input type="number" value={item.qtd_fisico ?? ''} min={0}
                        onChange={e => update(i, 'qtd_fisico', e.target.value ? Number(e.target.value) : undefined)}
                        className={`w-20 border rounded px-2 py-1 text-sm text-right ${divergente ? 'border-red-400 bg-red-50' : ''}`}
                        placeholder="—" />
                    </td>
                    <td className="py-2 pr-3">
                      <input type="number" value={item.qtd_venda} min={0}
                        onChange={e => update(i, 'qtd_venda', Number(e.target.value))}
                        className="w-20 border rounded px-2 py-1 text-sm text-right" />
                    </td>
                    <td className={`py-2 pr-3 text-right font-bold ${estoque < 0 ? 'text-red-600' : 'text-blue-600'}`}>
                      {estoque}
                    </td>
                    <td className="py-2 pr-3">
                      <input type="text" value={item.observacao || ''}
                        onChange={e => update(i, 'observacao', e.target.value)}
                        className="w-32 border rounded px-2 py-1 text-sm"
                        placeholder="Opcional" />
                    </td>
                    <td className="py-2">
                      {itens.length > 1 && (
                        <button onClick={() => removeLinha(i)} className="text-red-400 hover:text-red-600">
                          <Trash2 size={16} />
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div className="p-5 border-t flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Cancelar</button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !podeEnviar}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
            {mutation.isPending ? 'Salvando...' : 'Salvar e Enviar para Verificação'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Modal Verificação Física (Operador 2) ─────────────────────────────────────
function ModalVerificacao({ pedido, onClose }: { pedido: Pedido; onClose: () => void }) {
  const qc = useQueryClient()
  const { usuario } = useAuthStore()
  const { data: inv } = useQuery({
    queryKey: ['inventario', pedido.id],
    queryFn: () => api.get(`/pedidos/${pedido.id}/inventario`).then(r => r.data),
  })

  const [itensVerif, setItensVerif] = useState<Record<string, { qtd_fisico: number; status_item: string; observacao: string }>>({})
  const [conferidos, setConferidos] = useState<Set<string>>(new Set())
  const [validadeMap, setValidadeMap] = useState<Record<string, string>>({})
  const [zebraConectado, setZebraConectado] = useState<boolean | null>(null)
  const [imprimindo, setImprimindo] = useState<string | null>(null)
  const [nomeOperador, setNomeOperador] = useState(usuario?.nome || '')

  // Verifica Zebra ao abrir
  useEffect(() => {
    verificarZebraConectado().then(ok => setZebraConectado(ok))
  }, [])

  const itens: InventarioItem[] = inv?.itens || []
  const totalItens = itens.length
  const totalConferidos = conferidos.size
  const todosConferidos = totalItens > 0 && totalConferidos === totalItens

  const updateItem = (id: string, campo: string, valor: any) => {
    setItensVerif(prev => ({ ...prev, [id]: { ...prev[id], [campo]: valor } }))
  }

  const toggleConferido = async (id: string, item: InventarioItem) => {
    const jaConferido = conferidos.has(id)
    setConferidos(prev => {
      const novo = new Set(prev)
      jaConferido ? novo.delete(id) : novo.add(id)
      return novo
    })

    // Imprime etiqueta ao marcar como conferido (se Zebra conectada)
    if (!jaConferido && zebraConectado) {
      setImprimindo(id)
      const verif = itensVerif[id] || {}
      const estoqueRestante = item.qtd_sistemico - item.qtd_venda
      const resultado = await imprimirEtiqueta({
        codigo: item.codigo_item,
        lote: item.lote,
        validade: validadeMap[id] || '',
        quantidade: estoqueRestante,
        ov: pedido.numero_pedido,
        dataInventario: new Date().toISOString(),
        operador: nomeOperador || usuario?.nome || '',
      })
      setImprimindo(null)
      if (!resultado.ok) {
        toast.error(`Impressão: ${resultado.erro}`)
      } else if (resultado.metodo === 'navegador') {
        toast.success(`🖨 Abrindo etiqueta — selecione TLP 2844 e imprima`)
      } else if (resultado.metodo === 'print_agent') {
        toast.success(`🖨 Impresso automaticamente — ${item.codigo_item}`)
      } else {
        toast.success(`🖨 Etiqueta enviada — ${item.codigo_item}`)
      }
    }
  }

  const marcarTodos = () => {
    if (todosConferidos) {
      setConferidos(new Set())
    } else {
      setConferidos(new Set(itens.map(i => i.id)))
    }
  }

  const mutation = useMutation({
    mutationFn: () => {
      const itens_verificados = itens.map((item: InventarioItem) => ({
        id: item.id,
        qtd_fisico: itensVerif[item.id]?.qtd_fisico ?? item.qtd_fisico ?? item.qtd_sistemico,
        status_item: itensVerif[item.id]?.status_item ?? 'OK',
        observacao: itensVerif[item.id]?.observacao,
      }))
      return api.post(`/pedidos/${pedido.id}/inventario/verificar`, { itens_verificados })
    },
    onSuccess: () => {
      toast.success('Verificação registrada!')
      qc.invalidateQueries({ queryKey: ['pedido', pedido.id] })
      onClose()
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || 'Erro'),
  })

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl w-full max-w-4xl my-4">
        <div className="p-5 border-b space-y-3">
          {/* Nome do operador */}
          <div className="flex items-center gap-3 bg-blue-50 border border-blue-200 rounded-xl px-4 py-3">
            <span className="text-blue-600 text-lg">👤</span>
            <label className="text-sm font-semibold text-blue-800 whitespace-nowrap">Operador:</label>
            <input
              type="text"
              value={nomeOperador}
              onChange={e => setNomeOperador(e.target.value)}
              placeholder="Digite seu nome antes de conferir..."
              className="flex-1 bg-white border border-blue-300 rounded-lg px-3 py-1.5 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-blue-400"
              autoFocus
            />
            {nomeOperador && (
              <span className="text-xs bg-green-100 text-green-700 px-2 py-1 rounded-full font-medium whitespace-nowrap">
                ✓ Sairá na etiqueta
              </span>
            )}
          </div>

          <div className="flex items-start justify-between">
            <div>
              <h2 className="text-lg font-bold">🔍 Verificação Física — {pedido.numero_pedido}</h2>
              <div className="flex items-center gap-2 mt-0.5 flex-wrap">
                <p className="text-sm text-gray-500">Confira se o estoque restante (Sistema − Venda) bate com o físico</p>
                {zebraConectado === true && (
                  <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">🖨 Zebra conectada — imprime ao check</span>
                )}
                {zebraConectado === false && (
                  <a href={ZEBRA_DOWNLOAD_URL} target="_blank" rel="noreferrer"
                    className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-medium hover:underline">
                    ⚠ Zebra offline — clique para instalar Browser Print
                  </a>
                )}
              </div>
            </div>
            {/* Progresso de conferência */}
            <div className="text-right flex-shrink-0 ml-4">
              <p className="text-sm font-semibold text-gray-700">{totalConferidos}/{totalItens} conferidos</p>
              <div className="w-32 h-2 bg-gray-100 rounded-full mt-1">
                <div className="h-2 bg-green-500 rounded-full transition-all"
                  style={{ width: `${totalItens > 0 ? (totalConferidos / totalItens) * 100 : 0}%` }} />
              </div>
              <button onClick={marcarTodos}
                className={`text-xs mt-1.5 font-medium px-3 py-1 rounded-full transition-colors ${
                  todosConferidos
                    ? 'bg-gray-100 text-gray-500 hover:bg-gray-200'
                    : 'bg-green-100 text-green-700 hover:bg-green-200'
                }`}>
                {todosConferidos ? 'Desmarcar todos' : '✓ Marcar todos'}
              </button>
            </div>
          </div>
        </div>
        <div className="p-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-gray-500 border-b bg-gray-50">
                <th className="pb-2 px-2 w-8">✓</th>
                <th className="pb-2 pr-3">Código</th>
                <th className="pb-2 pr-3">Lote</th>
                <th className="pb-2 pr-3">Validade</th>
                <th className="pb-2 pr-3 text-right">Sistema</th>
                <th className="pb-2 pr-3 text-right">Venda</th>
                <th className="pb-2 pr-3 text-right font-semibold text-blue-600">Restante</th>
                <th className="pb-2 pr-3 text-right">Físico</th>
                <th className="pb-2 pr-3">Status</th>
                <th className="pb-2">Obs.</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {itens.map((item: InventarioItem) => {
                const verif = itensVerif[item.id] || {}
                const status = verif.status_item || 'OK'
                const conferido = conferidos.has(item.id)
                const estoqueRestante = item.qtd_sistemico - item.qtd_venda
                const qtdFisicoAtual = verif.qtd_fisico ?? item.qtd_fisico ?? item.qtd_sistemico
                const divergente = status === 'DIVERGENCIA'

                return (
                  <tr key={item.id} className={`transition-colors ${
                    conferido ? 'bg-green-50' :
                    divergente ? 'bg-red-50' : 'hover:bg-gray-50'
                  }`}>
                    {/* Checkbox conferido */}
                    <td className="py-2 px-2">
                      <button
                        onClick={() => toggleConferido(item.id, item)}
                        disabled={imprimindo === item.id}
                        className={`w-6 h-6 rounded border-2 flex items-center justify-center transition-colors ${
                          imprimindo === item.id ? 'bg-blue-200 border-blue-300 animate-pulse' :
                          conferido ? 'bg-green-500 border-green-500 text-white' : 'border-gray-300 hover:border-green-400'
                        }`}>
                        {imprimindo === item.id ? <span className="text-xs">🖨</span> : conferido && <span className="text-xs font-bold">✓</span>}
                      </button>
                    </td>
                    <td className={`py-2 pr-3 font-medium ${conferido ? 'text-green-700' : ''}`}>
                      {item.codigo_item}
                    </td>
                    <td className="py-2 pr-3 text-gray-400 text-xs">{item.lote}</td>
                    {/* Validade */}
                    <td className="py-2 pr-3">
                      <input type="text" value={validadeMap[item.id] || ''}
                        onChange={e => setValidadeMap(prev => ({ ...prev, [item.id]: e.target.value }))}
                        placeholder="MM/AAAA"
                        className="w-24 border rounded px-2 py-1 text-xs text-center" />
                    </td>
                    <td className="py-2 pr-3 text-right text-gray-500">{item.qtd_sistemico}</td>
                    <td className="py-2 pr-3 text-right text-gray-500">{item.qtd_venda}</td>
                    {/* Estoque restante esperado */}
                    <td className={`py-2 pr-3 text-right font-bold text-base ${
                      estoqueRestante < 0 ? 'text-red-600' : 'text-blue-600'
                    }`}>
                      {estoqueRestante}
                    </td>
                    {/* Qtd físico verificado */}
                    <td className="py-2 pr-3">
                      <input type="number"
                        defaultValue={item.qtd_fisico ?? item.qtd_sistemico}
                        onChange={e => {
                          const val = Number(e.target.value)
                          updateItem(item.id, 'qtd_fisico', val)
                          // Auto-detecta divergência se físico ≠ restante esperado
                          updateItem(item.id, 'status_item', val === estoqueRestante ? 'OK' : 'DIVERGENCIA')
                        }}
                        className={`w-20 border rounded px-2 py-1 text-sm text-right ${
                          divergente ? 'border-red-400 bg-red-50' : 'border-gray-200'
                        }`} />
                    </td>
                    <td className="py-2 pr-3">
                      <div className="flex gap-1">
                        <button onClick={() => updateItem(item.id, 'status_item', 'OK')}
                          className={`px-2 py-1 rounded text-xs font-medium ${status === 'OK' ? 'bg-green-100 text-green-700' : 'bg-gray-100 text-gray-400'}`}>
                          ✅ OK
                        </button>
                        <button onClick={() => updateItem(item.id, 'status_item', 'DIVERGENCIA')}
                          className={`px-2 py-1 rounded text-xs font-medium ${divergente ? 'bg-red-100 text-red-700' : 'bg-gray-100 text-gray-400'}`}>
                          ⚠ Div.
                        </button>
                      </div>
                    </td>
                    <td className="py-2">
                      <input type="text" placeholder="Obs..."
                        onChange={e => updateItem(item.id, 'observacao', e.target.value)}
                        className="w-24 border rounded px-2 py-1 text-xs" />
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
        <div className="p-5 border-t flex items-center justify-between">
          <p className="text-xs text-gray-400">
            💡 A coluna <strong>Restante</strong> = Sistema − Venda. O físico deve bater com esse valor.
          </p>
          <div className="flex gap-2">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Cancelar</button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending}
            className="px-4 py-2 bg-yellow-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
            {mutation.isPending ? 'Salvando...' : 'Confirmar Verificação'}
          </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Autocomplete de Tipo de Caixa ─────────────────────────────────────────────
function TipoCaixaAutocomplete({ value, onSelect }: {
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

// ── Modal Cubagem ─────────────────────────────────────────────────────────────
interface ItemCubagem {
  tipo_caixa_id: string
  tipo_caixa_nome: string
  tipo_caixa_desc: string
  quantidade: number
}

function ModalCubagem({ pedido, onClose }: { pedido: Pedido; onClose: () => void }) {
  const qc = useQueryClient()
  const [pesoTotal, setPesoTotal] = useState('')
  const [observacao, setObservacao] = useState('')
  const [mensagemTeams, setMensagemTeams] = useState('')
  const [itens, setItens] = useState<ItemCubagem[]>([
    { tipo_caixa_id: '', tipo_caixa_nome: '', tipo_caixa_desc: '', quantidade: 1 }
  ])

  const addItem = () => setItens([...itens, { tipo_caixa_id: '', tipo_caixa_nome: '', tipo_caixa_desc: '', quantidade: 1 }])
  const removeItem = (i: number) => setItens(itens.filter((_, idx) => idx !== i))
  const updateItem = (i: number, campo: keyof ItemCubagem, valor: any) => {
    const novo = [...itens]; (novo[i] as any)[campo] = valor; setItens(novo)
  }
  const totalCaixas = itens.reduce((a, i) => a + (i.quantidade || 0), 0)

  const mutation = useMutation({
    mutationFn: async () => {
      const cubRes = await api.post(`/pedidos/${pedido.id}/cubagem`, {
        peso_kg: pesoTotal ? Number(pesoTotal) : null,
        num_caixas: totalCaixas,
        observacao: observacao || null,
        itens: itens.filter(i => i.tipo_caixa_nome).map(i => ({
          tipo_caixa_id: i.tipo_caixa_id || null,
          tipo_caixa_nome: i.tipo_caixa_nome,
          quantidade: i.quantidade,
        })),
      })
      return cubRes
    },
    onSuccess: (res) => {
      toast.success('Cubagem registrada!')
      setMensagemTeams(res.data.mensagem_teams || '')
      qc.invalidateQueries({ queryKey: ['pedido', pedido.id] })
      qc.invalidateQueries({ queryKey: ['cubagem', pedido.id] })
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro'),
  })

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl w-full max-w-2xl my-4">
        <div className="p-5 border-b">
          <h2 className="text-lg font-bold">💻 Cubagem + D365 — {pedido.numero_pedido}</h2>
          <p className="text-sm text-gray-500 mt-0.5">Selecione os tipos de caixa usados neste pedido</p>
        </div>
        <div className="p-5 space-y-4">

          {/* Itens */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-semibold text-gray-700">Tipos de Caixa *</label>
              <button onClick={addItem} className="text-xs text-blue-600 hover:underline font-medium">+ Adicionar tipo</button>
            </div>
            <div className="space-y-2">
              {itens.map((item, i) => (
                <div key={i} className="flex gap-2 items-start p-3 bg-gray-50 rounded-lg border border-gray-100">
                  <div className="flex-1">
                    <TipoCaixaAutocomplete value={item.tipo_caixa_nome}
                      onSelect={(id, codigo, desc) => {
                        updateItem(i, 'tipo_caixa_id', id)
                        updateItem(i, 'tipo_caixa_nome', codigo)
                        updateItem(i, 'tipo_caixa_desc', desc)
                      }} />
                    {item.tipo_caixa_desc && <p className="text-xs text-gray-400 mt-1 ml-1">{item.tipo_caixa_desc}</p>}
                  </div>
                  <div className="w-24 flex-shrink-0">
                    <p className="text-xs text-gray-500 mb-0.5">Qtd</p>
                    <input type="number" min={1} value={item.quantidade}
                      onChange={e => updateItem(i, 'quantidade', Number(e.target.value))}
                      className="w-full border rounded-lg px-2 py-2 text-sm text-center" />
                  </div>
                  {itens.length > 1 && (
                    <button onClick={() => removeItem(i)} className="text-gray-300 hover:text-red-500 mt-6 flex-shrink-0">✕</button>
                  )}
                </div>
              ))}
            </div>
            <p className="text-xs text-gray-400 text-right mt-1">Total: <strong>{totalCaixas} caixa(s)</strong></p>
          </div>

          {/* Peso total */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-semibold text-gray-700">Peso Total (kg)</label>
              <input type="number" step="0.001" value={pesoTotal} onChange={e => setPesoTotal(e.target.value)}
                className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" placeholder="Ex: 12.5" />
            </div>
            <div>
              <label className="text-sm text-gray-600">Observação</label>
              <input type="text" value={observacao} onChange={e => setObservacao(e.target.value)}
                className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" placeholder="Opcional" />
            </div>
          </div>

          {mensagemTeams && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-3">
              <div className="flex items-center justify-between mb-2">
                <p className="text-sm font-medium text-blue-800">📋 Mensagem para Teams</p>
                <button onClick={() => { navigator.clipboard.writeText(mensagemTeams); toast.success('Copiado!') }}
                  className="flex items-center gap-1 text-xs text-blue-600 hover:underline">
                  <Copy size={14} /> Copiar
                </button>
              </div>
              <pre className="text-xs text-blue-700 whitespace-pre-wrap font-mono">{mensagemTeams}</pre>
            </div>
          )}
        </div>
        <div className="p-5 border-t flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Fechar</button>
          {!mensagemTeams && (
            <button onClick={() => mutation.mutate()}
              disabled={mutation.isPending || !itens.some(i => i.tipo_caixa_nome)}
              className="px-4 py-2 bg-purple-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-purple-500">
              {mutation.isPending ? 'Salvando...' : 'Registrar Cubagem'}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Modal Confirmar Coleta (direto na OV) ────────────────────────────────────
function ModalConfirmarColeta({ pedido, onClose }: { pedido: Pedido; onClose: () => void }) {
  const qc = useQueryClient()
  const [motorista, setMotorista] = useState('')
  const [placa, setPlaca] = useState('')
  const [protocolo, setProtocolo] = useState('')

  const mutation = useMutation({
    mutationFn: () => api.post(`/pedidos/${pedido.id}/coleta/confirmar`, {
      data_real_coleta: new Date().toISOString(),
      motorista: motorista || null,
      placa: placa || null,
      protocolo: protocolo || null,
    }),
    onSuccess: () => {
      toast.success('✅ Coleta registrada! OV expedida.')
      qc.invalidateQueries({ queryKey: ['pedido', pedido.id] })
      qc.invalidateQueries({ queryKey: ['pedidos'] })
      qc.invalidateQueries({ queryKey: ['pallets'] })
      onClose()
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao registrar coleta'),
  })

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md">
        <div className="p-5 border-b bg-green-50 rounded-t-2xl">
          <h2 className="text-lg font-bold text-green-800">✅ Registrar Coleta — {pedido.numero_pedido}</h2>
          <p className="text-sm text-green-600 mt-0.5">Confirme os dados da coleta</p>
        </div>
        <div className="p-5 space-y-4">
          <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
            <p><span className="text-gray-500">Cliente:</span> <strong>{pedido.cliente?.nome || pedido.cliente_nome}</strong></p>
            <p><span className="text-gray-500">Transportadora:</span> <strong>{pedido.transportadora?.nome || pedido.transportadora_nome || '—'}</strong></p>
            <p><span className="text-gray-500">NF:</span> <strong>{pedido.numero_nf || '—'}</strong></p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm text-gray-600">Motorista</label>
              <input type="text" value={motorista} onChange={e => setMotorista(e.target.value)}
                className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" placeholder="Opcional" />
            </div>
            <div>
              <label className="text-sm text-gray-600">Placa</label>
              <input type="text" value={placa} onChange={e => setPlaca(e.target.value.toUpperCase())}
                className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" placeholder="Ex: ABC-1234" />
            </div>
          </div>
          <div>
            <label className="text-sm text-gray-600">Protocolo / Recibo</label>
            <input type="text" value={protocolo} onChange={e => setProtocolo(e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" placeholder="Opcional" />
          </div>
          <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-xs text-green-700">
            📅 Data/hora da coleta será registrada automaticamente como agora.
          </div>
        </div>
        <div className="p-5 border-t flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Cancelar</button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending}
            className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-green-500">
            {mutation.isPending ? 'Registrando...' : '✅ Confirmar Coleta'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Modal Retornar Etapa ──────────────────────────────────────────────────────
const RETORNOS: Record<string, { label: string; destinos: { status: string; label: string }[] }> = {
  EM_INVENTARIO:         { label: 'Em Inventário',        destinos: [{ status: 'LIBERADO', label: 'OV Recebida (início)' }] },
  AGUARD_VERIFICACAO:    { label: 'Aguard. Verificação',  destinos: [{ status: 'EM_INVENTARIO', label: 'Em Inventário' }, { status: 'LIBERADO', label: 'OV Recebida (início)' }] },
  DIVERGENCIA:           { label: 'Divergência',          destinos: [{ status: 'EM_INVENTARIO', label: 'Em Inventário (reprocessar)' }, { status: 'LIBERADO', label: 'OV Recebida (início)' }] },
  AGUARD_TRATATIVA:      { label: 'Aguard. Tratativa',    destinos: [{ status: 'EM_INVENTARIO', label: 'Em Inventário' }, { status: 'LIBERADO', label: 'OV Recebida (início)' }] },
  EM_PROCESSO_SISTEMICO: { label: 'D365 + Cubagem',       destinos: [{ status: 'AGUARD_VERIFICACAO', label: 'Aguard. Verificação' }, { status: 'EM_INVENTARIO', label: 'Em Inventário' }, { status: 'LIBERADO', label: 'OV Recebida (início)' }] },
  AGUARD_FATURAMENTO:    { label: 'Aguard. Faturamento',  destinos: [{ status: 'EM_PROCESSO_SISTEMICO', label: 'D365 + Cubagem' }, { status: 'EM_INVENTARIO', label: 'Em Inventário' }, { status: 'LIBERADO', label: 'OV Recebida (início)' }] },
  FATURADO:              { label: 'Faturado',             destinos: [{ status: 'AGUARD_FATURAMENTO', label: 'Aguard. Faturamento' }, { status: 'EM_PROCESSO_SISTEMICO', label: 'D365 + Cubagem' }, { status: 'LIBERADO', label: 'OV Recebida (início)' }] },
  AGUARD_COLETA:         { label: 'No Pallet',            destinos: [{ status: 'FATURADO', label: 'Faturado (remover do pallet)' }, { status: 'LIBERADO', label: 'OV Recebida (início)' }] },
}

const MOTIVOS_RETORNO = [
  'Retornou a OV',
  'Dados incorretos — necessário corrigir',
  'Solicitação do cliente',
  'Erro operacional',
  'Divergência identificada após avanço',
  'Pedido de revisão pelo supervisor',
  'Outro motivo',
]

function ModalRetornarEtapa({ pedido, onClose }: { pedido: Pedido; onClose: () => void }) {
  const qc = useQueryClient()
  const config = RETORNOS[pedido.status]
  const [destinoStatus, setDestinoStatus] = useState(config?.destinos[0]?.status || '')
  const [motivo, setMotivo] = useState(MOTIVOS_RETORNO[0])
  const [motivoOutro, setMotivoOutro] = useState('')
  const [registrarOcorrencia, setRegistrarOcorrencia] = useState(true)

  const motivoFinal = motivo === 'Outro motivo' ? motivoOutro : motivo

  const mutation = useMutation({
    mutationFn: () => api.post(`/pedidos/${pedido.id}/retornar-etapa`, {
      status_destino: destinoStatus,
      motivo: registrarOcorrencia ? (motivoFinal || 'Retorno sem motivo') : 'Retorno sem ocorrência',
      registrar_ocorrencia: registrarOcorrencia,
    }),
    onSuccess: () => {
      toast.success('OV retornada à etapa anterior. Ocorrência registrada.')
      qc.invalidateQueries({ queryKey: ['pedido', pedido.id] })
      qc.invalidateQueries({ queryKey: ['pedidos'] })
      qc.invalidateQueries({ queryKey: ['ocorrencias'] })
      onClose()
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao retornar etapa'),
  })

  if (!config) return null

  const destinoLabel = config.destinos.find(d => d.status === destinoStatus)?.label || ''

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md">
        <div className="p-5 border-b bg-amber-50 rounded-t-2xl">
          <h2 className="text-lg font-bold text-amber-800">↩ Retornar Etapa — {pedido.numero_pedido}</h2>
          <p className="text-sm text-amber-600 mt-0.5">
            Etapa atual: <strong>{config.label}</strong>
          </p>
        </div>
        <div className="p-5 space-y-4">

          {/* Destino */}
          <div>
            <label className="text-sm font-medium text-gray-700">Retornar para *</label>
            <div className="space-y-2 mt-2">
              {config.destinos.map(d => (
                <label key={d.status}
                  className={`flex items-center gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
                    destinoStatus === d.status ? 'border-amber-500 bg-amber-50' : 'border-gray-200 hover:border-gray-300'
                  }`}>
                  <input type="radio" name="destino" value={d.status} checked={destinoStatus === d.status}
                    onChange={() => setDestinoStatus(d.status)} className="accent-amber-500" />
                  <span className="text-sm font-medium text-gray-800">{d.label}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Toggle ocorrência */}
          <label className="flex items-center gap-3 p-3 bg-gray-50 rounded-lg cursor-pointer">
            <input type="checkbox" checked={registrarOcorrencia}
              onChange={e => setRegistrarOcorrencia(e.target.checked)}
              className="w-4 h-4 accent-amber-600" />
            <div>
              <p className="text-sm font-medium text-gray-700">Registrar ocorrência</p>
              <p className="text-xs text-gray-400">Desmarque para retornar sem gerar ocorrência</p>
            </div>
          </label>

          {/* Motivo — só aparece se registrar ocorrência */}
          {registrarOcorrencia && (
            <div>
              <label className="text-sm font-medium text-gray-700">Motivo *</label>
              <select value={motivo} onChange={e => setMotivo(e.target.value)}
                className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1">
                {MOTIVOS_RETORNO.map(m => <option key={m}>{m}</option>)}
              </select>
              {motivo === 'Outro motivo' && (
                <textarea rows={2} value={motivoOutro} onChange={e => setMotivoOutro(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2 text-sm mt-2"
                  placeholder="Descreva o motivo..." autoFocus />
              )}
            </div>
          )}

          {/* Aviso */}
          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-700">
            ⚠️ A OV voltará para <strong>{destinoLabel}</strong>
            {registrarOcorrencia ? ' e uma ocorrência será registrada automaticamente.' : ' sem registrar ocorrência.'}
            {pedido.status === 'AGUARD_COLETA' && <span className="block mt-1">📦 A OV será removida do pallet.</span>}
          </div>
        </div>
        <div className="p-5 border-t flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Cancelar</button>
          <button onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !destinoStatus || (registrarOcorrencia && !motivoFinal.trim())}
            className="px-4 py-2 bg-amber-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-amber-500">
            {mutation.isPending ? 'Retornando...' : '↩ Confirmar Retorno'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Modal Cancelar OV ────────────────────────────────────────────────────────
const MOTIVOS_CANCELAMENTO = [
  'Cliente desistiu do pedido',
  'Pedido duplicado',
  'Produto sem estoque — pedido encerrado',
  'Erro no pedido — será reaberto corretamente',
  'Cliente solicitou alteração — novo pedido será emitido',
  'Prazo não atendido — cliente cancelou',
  'Outro motivo',
]

function ModalCancelarOV({ pedido, onClose }: { pedido: Pedido; onClose: () => void }) {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [motivo, setMotivo] = useState('')
  const [motivoOutro, setMotivoOutro] = useState('')

  const motivoFinal = motivo === 'Outro motivo' ? motivoOutro : motivo

  const mutation = useMutation({
    mutationFn: () => api.post(`/pedidos/${pedido.id}/cancelar`, { motivo: motivoFinal }),
    onSuccess: () => {
      toast.success('OV cancelada e ocorrência registrada.')
      qc.invalidateQueries({ queryKey: ['pedido', pedido.id] })
      qc.invalidateQueries({ queryKey: ['pedidos'] })
      qc.invalidateQueries({ queryKey: ['ocorrencias'] })
      onClose()
      navigate('/expedicao')
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao cancelar OV'),
  })

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md">
        <div className="p-5 border-b bg-red-50 rounded-t-2xl">
          <h2 className="text-lg font-bold text-red-700">❌ Cancelar OV — {pedido.numero_pedido}</h2>
          <p className="text-sm text-red-500 mt-0.5">Esta ação não pode ser desfeita. Uma ocorrência será registrada.</p>
        </div>
        <div className="p-5 space-y-4">

          {/* Info do pedido */}
          <div className="bg-gray-50 rounded-lg p-3 text-sm space-y-1">
            <p><span className="text-gray-500">Cliente:</span> <strong>{pedido.cliente?.nome || pedido.cliente_nome}</strong></p>
            <p><span className="text-gray-500">Status atual:</span> <strong>{pedido.status}</strong></p>
            {pedido.numero_nf && <p><span className="text-gray-500">NF:</span> <strong>{pedido.numero_nf}</strong></p>}
          </div>

          {/* Motivo */}
          <div>
            <label className="text-sm font-medium text-gray-700">Motivo do cancelamento *</label>
            <select value={motivo} onChange={e => setMotivo(e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1">
              <option value="">Selecione o motivo...</option>
              {MOTIVOS_CANCELAMENTO.map(m => (
                <option key={m} value={m}>{m}</option>
              ))}
            </select>
            {motivo === 'Outro motivo' && (
              <textarea rows={2} value={motivoOutro} onChange={e => setMotivoOutro(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm mt-2"
                placeholder="Descreva o motivo do cancelamento..." autoFocus />
            )}
          </div>

          <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-xs text-red-600">
            ⚠️ A OV será marcada como <strong>CANCELADA</strong> e não poderá mais ser movimentada no sistema.
          </div>
        </div>
        <div className="p-5 border-t flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">
            Voltar
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !motivoFinal.trim()}
            className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-red-700"
          >
            {mutation.isPending ? 'Cancelando...' : 'Confirmar Cancelamento'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Modal Alterar Transportadora ─────────────────────────────────────────────
function ModalAlterarTransportadora({ pedido, onClose }: { pedido: Pedido; onClose: () => void }) {
  const qc = useQueryClient()
  const [transportadoraId, setTransportadoraId] = useState('')
  const [motivo, setMotivo] = useState('')

  const [motivoOutro, setMotivoOutro] = useState('')

  const { data: transportadoras = [] } = useQuery({
    queryKey: ['transportadoras'],
    queryFn: () => api.get('/transportadoras').then(r => r.data),
  })

  const { data: motivos = [] } = useQuery({
    queryKey: ['motivos-transportadora'],
    queryFn: () => api.get('/motivos-ocorrencia?tipo=TRANSPORTADORA').then(r => r.data),
  })

  const motivoFinal = motivo === '__outro__' ? motivoOutro : motivo

  const mutation = useMutation({
    mutationFn: () => api.post(`/pedidos/${pedido.id}/alterar-transportadora`, {
      transportadora_id: transportadoraId,
      motivo: motivoFinal,
    }),
    onSuccess: (res) => {
      const d = res.data
      toast.success(`✅ Transportadora alterada: ${d.transportadora_anterior} → ${d.transportadora_nova}`)
      qc.invalidateQueries({ queryKey: ['pedido', pedido.id] })
      qc.invalidateQueries({ queryKey: ['pallets'] })
      qc.invalidateQueries({ queryKey: ['ocorrencias'] })
      onClose()
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao alterar transportadora'),
  })

  const transpAtual = pedido.transportadora?.nome || pedido.transportadora_nome || '—'

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md">
        <div className="p-5 border-b">
          <h2 className="text-lg font-bold text-orange-700">🔄 Corrigir Transportadora</h2>
          <p className="text-sm text-gray-500 mt-0.5">
            A ocorrência será registrada automaticamente
          </p>
        </div>
        <div className="p-5 space-y-4">

          {/* Transportadora atual */}
          <div className="bg-gray-50 rounded-lg p-3 text-sm">
            <p className="text-gray-500 text-xs mb-1">Transportadora atual</p>
            <p className="font-bold text-gray-800 text-base">{transpAtual}</p>
          </div>

          {/* Nova transportadora */}
          <div>
            <label className="text-sm font-medium text-gray-700">Nova Transportadora *</label>
            <select value={transportadoraId} onChange={e => setTransportadoraId(e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1">
              <option value="">Selecione a transportadora correta...</option>
              {(transportadoras as any[]).map((t: any) => (
                <option key={t.id} value={t.id}>{t.nome}</option>
              ))}
            </select>
          </div>

          {/* Motivo padronizado */}
          <div>
            <label className="text-sm font-medium text-gray-700">Motivo da correção *</label>
            <select value={motivo} onChange={e => setMotivo(e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1">
              <option value="">Selecione o motivo...</option>
              {(motivos as any[]).map((m: any) => (
                <option key={m.id} value={m.descricao}>{m.descricao}</option>
              ))}
              <option value="__outro__">✏️ Outro motivo (digitar)</option>
            </select>
            {motivo === '__outro__' && (
              <textarea rows={2} value={motivoOutro} onChange={e => setMotivoOutro(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm mt-2"
                placeholder="Descreva o motivo..." autoFocus />
            )}
          </div>

          <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-xs text-orange-700">
            <p className="font-semibold">O que será feito automaticamente:</p>
            <ul className="mt-1 space-y-0.5 list-disc list-inside">
              <li>Transportadora atualizada no pedido</li>
              <li>OV movida para o pallet correto (se necessário)</li>
              <li>Ocorrência registrada com motivo e histórico</li>
            </ul>
          </div>
        </div>
        <div className="p-5 border-t flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Cancelar</button>
          <button onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !transportadoraId || !motivoFinal.trim()}
            className="px-4 py-2 bg-orange-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-orange-500">
            {mutation.isPending ? 'Salvando...' : '✅ Confirmar Correção'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Modal Escolher Pallet ────────────────────────────────────────────────────
function ModalEscolherPallet({ pedido, onClose }: { pedido: Pedido; onClose: () => void }) {
  const qc = useQueryClient()
  const [palletId, setPalletId] = useState('')
  const [numCaixas, setNumCaixas] = useState('')

  const { data: pallets = [] } = useQuery({
    queryKey: ['pallets-ativos'],
    queryFn: () => api.get('/pallets').then(r =>
      Array.isArray(r.data) ? r.data.filter((p: any) => p.status !== 'COLETADO') : []
    ),
  })

  const CORES: Record<string, string> = {
    'BRIX': 'bg-blue-600', 'RR CARGO': 'bg-orange-600',
    'CORREIOS': 'bg-yellow-500', 'OUTROS': 'bg-gray-500',
  }

  const mutation = useMutation({
    mutationFn: () => api.post(`/pallets/${palletId}/pedidos`, {
      pedido_id: pedido.numero_pedido,
      num_caixas: numCaixas ? Number(numCaixas) : null,
    }),
    onSuccess: () => {
      toast.success('OV alocada no pallet!')
      qc.invalidateQueries({ queryKey: ['pedido', pedido.id] })
      qc.invalidateQueries({ queryKey: ['pallets'] })
      qc.invalidateQueries({ queryKey: ['pallets-ativos'] })
      onClose()
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao alocar no pallet'),
  })

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md">
        <div className="p-5 border-b">
          <h2 className="text-lg font-bold">📦 Alocar no Pallet — {pedido.numero_pedido}</h2>
          <p className="text-sm text-gray-500 mt-0.5">Escolha o pallet da transportadora</p>
        </div>
        <div className="p-5 space-y-4">
          {/* Grid de pallets */}
          <div className="grid grid-cols-2 gap-3">
            {(pallets as any[]).map((p: any) => {
              const nome = p.transportadora_nome || p.codigo
              const cor = CORES[nome] || 'bg-gray-500'
              const selecionado = palletId === p.id
              return (
                <button key={p.id} onClick={() => setPalletId(p.id)}
                  className={`rounded-xl border-2 p-3 text-left transition-all ${
                    selecionado ? 'border-blue-500 ring-2 ring-blue-200' : 'border-gray-200 hover:border-gray-300'
                  }`}>
                  <div className={`${cor} rounded-lg px-2 py-1 text-white text-xs font-bold mb-2 inline-block`}>
                    {nome}
                  </div>
                  <p className="text-xs text-gray-500">{p.codigo}</p>
                  <p className="text-xs text-gray-400 mt-1">
                    {p.pedidos?.length || 0} OV(s) no pallet
                  </p>
                  {selecionado && <p className="text-xs text-blue-600 font-semibold mt-1">✓ Selecionado</p>}
                </button>
              )
            })}
          </div>

          {palletId && (
            <div>
              <label className="text-sm font-medium text-gray-700">Nº de Caixas desta OV</label>
              <input type="number" value={numCaixas} onChange={e => setNumCaixas(e.target.value)}
                className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1"
                placeholder="Ex: 2" />
            </div>
          )}
        </div>
        <div className="p-5 border-t flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Cancelar</button>
          <button onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !palletId}
            className="px-4 py-2 bg-teal-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-teal-500">
            {mutation.isPending ? 'Alocando...' : '📦 Confirmar Alocação'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Modal Tratativa de Divergência ───────────────────────────────────────────
function ModalTratativaDivergencia({ pedido, onClose }: { pedido: Pedido; onClose: () => void }) {
  const qc = useQueryClient()
  const [acao, setAcao] = useState<'corrigir_inventario' | 'resolver'>('corrigir_inventario')
  const [justificativa, setJustificativa] = useState('')

  const mutation = useMutation({
    mutationFn: () => api.post(`/pedidos/${pedido.id}/divergencia/tratar`, { acao, justificativa }),
    onSuccess: (res) => {
      toast.success(res.data.mensagem || 'Divergência tratada!')
      qc.invalidateQueries({ queryKey: ['pedido', pedido.id] })
      qc.invalidateQueries({ queryKey: ['ocorrencias'] })
      onClose()
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao tratar divergência'),
  })

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md">
        <div className="p-5 border-b">
          <h2 className="text-lg font-bold text-red-700">🔧 Tratar Divergência — {pedido.numero_pedido}</h2>
          <p className="text-sm text-gray-500 mt-0.5">Escolha como resolver a divergência identificada</p>
        </div>
        <div className="p-5 space-y-4">
          {/* Opção 1 */}
          <label className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
            acao === 'corrigir_inventario' ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-gray-300'
          }`}>
            <input type="radio" name="acao" value="corrigir_inventario"
              checked={acao === 'corrigir_inventario'}
              onChange={() => setAcao('corrigir_inventario')}
              className="mt-0.5" />
            <div>
              <p className="font-semibold text-sm">📝 Corrigir o inventário</p>
              <p className="text-xs text-gray-500 mt-0.5">O dado foi inserido errado no app. Reabre o inventário para corrigir.</p>
            </div>
          </label>

          {/* Opção 2 */}
          <label className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-colors ${
            acao === 'resolver' ? 'border-green-500 bg-green-50' : 'border-gray-200 hover:border-gray-300'
          }`}>
            <input type="radio" name="acao" value="resolver"
              checked={acao === 'resolver'}
              onChange={() => setAcao('resolver')}
              className="mt-0.5" />
            <div>
              <p className="font-semibold text-sm">✅ Divergência resolvida</p>
              <p className="text-xs text-gray-500 mt-0.5">O problema foi identificado e tratado. Avançar para D365.</p>
            </div>
          </label>

          <div>
            <label className="text-sm font-medium text-gray-700">Justificativa / Descrição *</label>
            <textarea rows={3} value={justificativa}
              onChange={e => setJustificativa(e.target.value)}
              placeholder="Descreva o que foi verificado ou corrigido..."
              className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
          </div>
        </div>
        <div className="p-5 border-t flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Cancelar</button>
          <button onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !justificativa.trim()}
            className={`px-4 py-2 text-white rounded-lg text-sm font-medium disabled:opacity-50 ${
              acao === 'corrigir_inventario' ? 'bg-blue-600 hover:bg-blue-500' : 'bg-green-600 hover:bg-green-500'
            }`}>
            {mutation.isPending ? 'Salvando...' : acao === 'corrigir_inventario' ? 'Reabrir Inventário' : 'Confirmar Resolução'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Página Principal ──────────────────────────────────────────────────────────
export function PedidoDetalhe() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [modal, setModal] = useState<'inventario' | 'verificacao' | 'cubagem' | 'faturamento' | 'divergencia' | 'pallet' | 'transportadora' | 'cancelar' | 'retornar' | 'confirmar_coleta' | null>(null)
  const [nf, setNf] = useState('')
  const [valorNf, setValorNf] = useState('')
  const [valorProdutos, setValorProdutos] = useState('')
  const [valorFrete, setValorFrete] = useState('')
  const [novaDataEntrega, setNovaDataEntrega] = useState('')

  const { data: pedido, isLoading } = useQuery<Pedido>({
    queryKey: ['pedido', id],
    queryFn: () => api.get(`/pedidos/${id}`).then(r => r.data),
    refetchInterval: 20000,
  })

  const { data: inventario } = useQuery({
    queryKey: ['inventario', id],
    queryFn: () => api.get(`/pedidos/${id}/inventario`).then(r => r.data),
    enabled: !!id && !!pedido && !['LIBERADO'].includes(pedido?.status || ''),
  })

  const { data: cubagem } = useQuery<Cubagem>({
    queryKey: ['cubagem', id],
    queryFn: () => api.get(`/pedidos/${id}/cubagem`).then(r => r.data),
    enabled: !!id && !!pedido && ['AGUARD_FATURAMENTO', 'FATURADO', 'AGUARD_COLETA', 'EXPEDIDO'].includes(pedido?.status || ''),
  })

  const isCIF = pedido?.tipo_frete === 'CIF_COM_VALOR' || pedido?.tipo_frete === 'CIF_SEM_VALOR'

  // Para CIF: valor_nf = valor_produtos + valor_frete
  const valorNfCalculado = isCIF
    ? ((Number(valorProdutos) || 0) + (Number(valorFrete) || 0))
    : (valorNf ? Number(valorNf) : null)

  const faturarMutation = useMutation({
    mutationFn: () => api.post(`/pedidos/${id}/faturamento`, {
      numero_nf: nf,
      valor_nf: valorNfCalculado || null,
      valor_produtos: isCIF && valorProdutos ? Number(valorProdutos) : null,
      valor_frete: isCIF && valorFrete ? Number(valorFrete) : null,
      data_prevista_entrega: novaDataEntrega || null,
    }),
    onSuccess: () => {
      toast.success('NF registrada!')
      qc.invalidateQueries({ queryKey: ['pedido', id] })
      setModal(null)
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || 'Erro'),
  })

  if (isLoading) return <div className="p-8 text-center text-gray-400">Carregando...</div>
  if (!pedido) return <div className="p-8 text-center text-gray-400">Pedido não encontrado</div>

  const status = pedido.status
  const SLA_HORAS = 2
  const STATUSES_SEPARACAO = ['LIBERADO','EM_INVENTARIO','AGUARD_VERIFICACAO','DIVERGENCIA','AGUARD_TRATATIVA','EM_PROCESSO_SISTEMICO']
  const emSeparacao = STATUSES_SEPARACAO.includes(status)
  const chegouFaturamento = !STATUSES_SEPARACAO.includes(status) && status !== 'CANCELADO'

  // Calcula tempo de separação
  const inicioSep = pedido.criado_em ? new Date(pedido.criado_em) : null
  const fimSep = chegouFaturamento && pedido.atualizado_em ? new Date(pedido.atualizado_em) : new Date()
  const horasSep = inicioSep ? calcHorasComerciais(inicioSep, fimSep) : 0

  // Linha do tempo das etapas
  const ETAPAS = [
    { key: 'LIBERADO', label: 'OV Recebida', icone: '📋' },
    { key: 'EM_INVENTARIO', label: 'Inventário', icone: '📦' },
    { key: 'AGUARD_VERIFICACAO', label: 'Verificação Física', icone: '🔍' },
    { key: 'EM_PROCESSO_SISTEMICO', label: 'D365 + Cubagem', icone: '💻' },
    { key: 'AGUARD_FATURAMENTO', label: 'Faturamento', icone: '🧾' },
    { key: 'FATURADO', label: 'Pallet', icone: '📦' },
    { key: 'EXPEDIDO', label: 'Expedido', icone: '✅' },
  ]
  const ORDEM = ETAPAS.map(e => e.key)
  const idxAtual = ORDEM.indexOf(status)

  return (
    <div className="p-6 max-w-4xl mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate(-1)} className="p-2 hover:bg-gray-100 rounded-lg">
          <ArrowLeft size={20} />
        </button>
        <div className="flex-1">
          <div className="flex items-center gap-3 flex-wrap">
            <h1 className="text-2xl font-bold text-gray-900">Pedido {pedido.numero_pedido}</h1>
            {pedido.atrasado && <span className="bg-red-100 text-red-700 text-xs font-bold px-2 py-1 rounded-full">⚠ ATRASADO</span>}
            <span className="text-sm text-gray-500">{TIPO_FRETE_LABEL[pedido.tipo_frete || 'FOB']}</span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <StatusBadge status={pedido.status} />
            <PrioridadeBadge prioridade={pedido.prioridade} />
          </div>
        </div>
      </div>

      {/* Linha do tempo */}
      <div className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 mb-5 overflow-x-auto">
        <div className="flex items-center gap-1 min-w-max">
          {ETAPAS.map((etapa, i) => {
            const concluido = i < idxAtual
            const atual = ORDEM[idxAtual] === etapa.key || (status === 'DIVERGENCIA' && i === 2) || (status === 'AGUARD_TRATATIVA' && i === 2)
            return (
              <div key={etapa.key} className="flex items-center">
                <div className={`flex flex-col items-center ${i < ETAPAS.length - 1 ? 'mr-1' : ''}`}>
                  <div className={`w-8 h-8 rounded-full flex items-center justify-center text-base ${
                    concluido ? 'bg-green-500 text-white' : atual ? 'bg-blue-600 text-white ring-2 ring-blue-300' : 'bg-gray-100 text-gray-400'
                  }`}>
                    {concluido ? '✓' : etapa.icone}
                  </div>
                  <span className={`text-xs mt-1 text-center w-16 ${atual ? 'text-blue-700 font-semibold' : concluido ? 'text-green-600' : 'text-gray-400'}`}>
                    {etapa.label}
                  </span>
                </div>
                {i < ETAPAS.length - 1 && (
                  <div className={`w-8 h-0.5 mb-4 ${concluido ? 'bg-green-400' : 'bg-gray-200'}`} />
                )}
              </div>
            )
          })}
        </div>
      </div>

      {/* Card tempo de separação */}
      {status !== 'CANCELADO' && inicioSep && (
        <div className={`rounded-xl p-4 border-2 flex items-center gap-4 ${
          chegouFaturamento ? (horasSep <= SLA_HORAS ? 'bg-green-50 border-green-300' : 'bg-orange-50 border-orange-300')
          : bgSLA(horasSep, SLA_HORAS)
        }`}>
          <div className="text-3xl">⏱</div>
          <div className="flex-1">
            <p className="text-sm font-medium text-gray-600">
              {chegouFaturamento ? 'Tempo de separação (concluído)' : 'Tempo em separação (em andamento)'}
            </p>
            <p className={`text-2xl font-bold mt-0.5 ${corSLA(horasSep, SLA_HORAS)}`}>
              {formatarTempo(horasSep)}
              {horasSep > SLA_HORAS && <span className="text-sm ml-2 font-normal">⚠ acima do SLA de {SLA_HORAS}h</span>}
              {horasSep <= SLA_HORAS && chegouFaturamento && <span className="text-sm ml-2 font-normal text-green-600">✅ dentro do SLA</span>}
            </p>
          </div>
          <div className="text-right text-xs text-gray-400">
            <p>SLA: {SLA_HORAS}h comerciais</p>
            <p>Abertura: {format(inicioSep, 'dd/MM HH:mm', { locale: ptBR })}</p>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        {/* Info */}
        <div className="lg:col-span-2 space-y-5">
          {/* Dados do pedido */}
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <h2 className="font-semibold text-gray-800 mb-3">Dados da OV</h2>
            <Linha label="Cliente" valor={pedido.cliente?.nome || pedido.cliente_nome} />
            <Linha label="Tipo de Frete" valor={TIPO_FRETE_LABEL[pedido.tipo_frete || 'FOB']} />
            <Linha label="Local de Entrega" valor={pedido.local_entrega} />
            <Linha label="Entrega Prevista" valor={
              pedido.data_prevista_entrega
                ? new Date(pedido.data_prevista_entrega + 'T12:00:00').toLocaleDateString('pt-BR')
                : null
            } />
            <Linha label="Transportadora" valor={pedido.transportadora?.nome || pedido.transportadora_nome} />
            <Linha label="NF" valor={pedido.numero_nf} />
            {(pedido as any).valor_produtos != null && (
              <Linha label="💰 Valor Produtos" valor={`R$ ${Number((pedido as any).valor_produtos).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`} />
            )}
            {(pedido as any).valor_frete != null && (
              <Linha label="🚛 Custo Frete" valor={`R$ ${Number((pedido as any).valor_frete).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`} />
            )}
            {pedido.valor_nf && (
              <Linha label={`Total NF${(pedido as any).valor_produtos != null ? ' (Prod. + Frete)' : ''}`}
                valor={`R$ ${pedido.valor_nf.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`} />
            )}
            {pedido.data_real_coleta && (
              <Linha label="Data Coleta" valor={format(new Date(pedido.data_real_coleta), 'dd/MM/yyyy HH:mm', { locale: ptBR })} />
            )}
            {pedido.observacoes && <Linha label="Obs." valor={pedido.observacoes} />}
          </div>

          {/* Cubagem */}
          {!['LIBERADO','EM_INVENTARIO','AGUARD_VERIFICACAO','DIVERGENCIA','AGUARD_TRATATIVA','CANCELADO'].includes(status) && (
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <div className="flex items-center justify-between mb-3">
                <h2 className="font-semibold text-gray-800">📐 Cubagem</h2>
                {!cubagem && (
                  <button onClick={() => setModal('cubagem')}
                    className="text-xs text-blue-600 hover:underline">
                    + Registrar
                  </button>
                )}
              </div>
              {cubagem ? (
                <div className="grid grid-cols-2 gap-x-6">
                  {cubagem.num_caixas != null && <Linha label="Volumes" valor={`${cubagem.num_caixas} caixa(s)`} />}
                  {cubagem.peso_kg != null && <Linha label="Peso total" valor={`${cubagem.peso_kg} kg`} />}
                  {cubagem.altura_cm != null && <Linha label="Altura" valor={`${cubagem.altura_cm} cm`} />}
                  {cubagem.largura_cm != null && <Linha label="Largura" valor={`${cubagem.largura_cm} cm`} />}
                  {cubagem.comprimento_cm != null && <Linha label="Comprimento" valor={`${cubagem.comprimento_cm} cm`} />}
                </div>
              ) : (
                <p className="text-sm text-gray-400 italic">Cubagem não registrada</p>
              )}
            </div>
          )}

          {/* Inventário Contínuo (se existir) */}
          {inventario?.itens?.length > 0 && (
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <h2 className="font-semibold text-gray-800 mb-3">📦 Inventário Contínuo</h2>
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-gray-500 border-b">
                      <th className="pb-2 pr-3">Código</th>
                      <th className="pb-2 pr-3">Lote</th>
                      <th className="pb-2 pr-3 text-right">Sistema</th>
                      <th className="pb-2 pr-3 text-right">Físico</th>
                      <th className="pb-2 pr-3 text-right">Venda</th>
                      <th className="pb-2 pr-3 text-right">Estoque</th>
                      <th className="pb-2">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {inventario.itens.map((item: InventarioItem) => (
                      <tr key={item.id} className={item.status_item === 'DIVERGENCIA' ? 'bg-red-50' : ''}>
                        <td className="py-1.5 pr-3 font-medium">{item.codigo_item}</td>
                        <td className="py-1.5 pr-3 text-gray-500">{item.lote}</td>
                        <td className="py-1.5 pr-3 text-right">{item.qtd_sistemico}</td>
                        <td className="py-1.5 pr-3 text-right">{item.qtd_fisico ?? '—'}</td>
                        <td className="py-1.5 pr-3 text-right">{item.qtd_venda}</td>
                        <td className={`py-1.5 pr-3 text-right font-bold ${(item.qtd_estoque ?? 0) < 0 ? 'text-red-600' : 'text-blue-600'}`}>
                          {item.qtd_estoque ?? '—'}
                        </td>
                        <td className="py-1.5">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                            item.status_item === 'OK' ? 'bg-green-100 text-green-700' :
                            item.status_item === 'DIVERGENCIA' ? 'bg-red-100 text-red-700' :
                            'bg-gray-100 text-gray-500'
                          }`}>{item.status_item}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Cubagem (se existir) */}
          {cubagem && (
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <h2 className="font-semibold text-gray-800 mb-3">📐 Cubagem</h2>
              <div className="grid grid-cols-2 gap-3 text-sm">
                {cubagem.num_caixas && <div><span className="text-gray-500">Volumes:</span> <strong>{cubagem.num_caixas} caixa(s)</strong></div>}
                {cubagem.peso_kg && <div><span className="text-gray-500">Peso:</span> <strong>{cubagem.peso_kg} kg</strong></div>}
                {cubagem.altura_cm && <div><span className="text-gray-500">Altura:</span> <strong>{cubagem.altura_cm} cm</strong></div>}
                {cubagem.largura_cm && <div><span className="text-gray-500">Largura:</span> <strong>{cubagem.largura_cm} cm</strong></div>}
                {cubagem.comprimento_cm && <div><span className="text-gray-500">Comprimento:</span> <strong>{cubagem.comprimento_cm} cm</strong></div>}
              </div>
            </div>
          )}
        </div>

        {/* Ações */}
        <div className="space-y-4">
          <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
            <h2 className="font-semibold text-gray-800 mb-4">Próxima Ação</h2>
            <div className="space-y-2">

              {/* Retornar etapa */}
              {!['LIBERADO','EXPEDIDO','CANCELADO'].includes(status) && (
                <button onClick={() => setModal('retornar')}
                  className="w-full flex items-center gap-2 justify-center py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50">
                  ↩ Retornar Etapa
                </button>
              )}

              {/* Corrigir transportadora — visível após faturamento */}
              {['AGUARD_FATURAMENTO','FATURADO','AGUARD_COLETA','COLETADO'].includes(status) && (
                <button onClick={() => setModal('transportadora')}
                  className="w-full flex items-center gap-2 justify-center py-2 border border-orange-300 text-orange-600 rounded-lg text-sm hover:bg-orange-50">
                  🔄 Corrigir Transportadora
                </button>
              )}

              {status === 'LIBERADO' && (
                <button onClick={() => setModal('inventario')}
                  className="w-full flex items-center gap-2 justify-center py-3 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-500">
                  <Package size={16} /> Iniciar Inventário Contínuo
                </button>
              )}

              {status === 'EM_INVENTARIO' && (
                <button onClick={() => setModal('inventario')}
                  className="w-full flex items-center gap-2 justify-center py-3 bg-blue-500 text-white rounded-lg font-medium hover:bg-blue-400">
                  <Package size={16} /> Editar Inventário
                </button>
              )}

              {status === 'AGUARD_VERIFICACAO' && (
                <button onClick={() => setModal('verificacao')}
                  className="w-full flex items-center gap-2 justify-center py-3 bg-yellow-600 text-white rounded-lg font-medium hover:bg-yellow-500">
                  <CheckCircle size={16} /> Verificar Estoque Físico
                </button>
              )}

              {status === 'DIVERGENCIA' && (
                <div className="space-y-2">
                  <div className="bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-700">
                    <p className="font-semibold">⚠ Divergência no Inventário</p>
                    <p className="mt-1 text-xs">Uma ocorrência foi gerada automaticamente.</p>
                  </div>
                  <button onClick={() => setModal('divergencia')}
                    className="w-full py-3 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-500">
                    🔧 Tratar Divergência
                  </button>
                </div>
              )}

              {status === 'AGUARD_TRATATIVA' && (
                <div className="bg-orange-50 border border-orange-200 rounded-lg p-3 text-sm text-orange-700">
                  <p className="font-semibold">🔴 Aguardando Tratativa</p>
                  <p className="mt-1">Supervisor em ação.</p>
                </div>
              )}

              {status === 'EM_PROCESSO_SISTEMICO' && (
                <button onClick={() => setModal('cubagem')}
                  className="w-full flex items-center gap-2 justify-center py-3 bg-purple-600 text-white rounded-lg font-medium hover:bg-purple-500">
                  <FileText size={16} /> Registrar Cubagem (após D365)
                </button>
              )}

              {status === 'AGUARD_FATURAMENTO' && (
                <button onClick={() => setModal('faturamento')}
                  className="w-full flex items-center gap-2 justify-center py-3 bg-indigo-600 text-white rounded-lg font-medium hover:bg-indigo-500">
                  <FileText size={16} /> Registrar NF Recebida
                </button>
              )}

              {status === 'FATURADO' && (
                <button onClick={() => setModal('pallet')}
                  className="w-full flex items-center gap-2 justify-center py-3 bg-teal-600 text-white rounded-lg font-medium hover:bg-teal-500">
                  <Truck size={16} /> Alocar no Pallet
                </button>
              )}

              {status === 'AGUARD_COLETA' && (
                <>
                  <div className="bg-teal-50 border border-teal-200 rounded-lg p-3 text-sm text-teal-700">
                    <p className="font-semibold">📦 No pallet aguardando coleta</p>
                  </div>
                  <button onClick={() => setModal('confirmar_coleta')}
                    className="w-full flex items-center gap-2 justify-center py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-500">
                    ✅ Registrar Coleta
                  </button>
                </>
              )}

              {['COLETADO', 'EXPEDIDO'].includes(status) && (
                <div className="bg-green-50 border border-green-200 rounded-lg p-3 text-sm text-green-700">
                  <p className="font-semibold">✅ {status === 'EXPEDIDO' ? 'Expedido!' : 'Coletado!'}</p>
                </div>
              )}

              {/* Registrar cubagem retroativamente */}
              {['AGUARD_COLETA', 'FATURADO'].includes(status) && !cubagem && (
                <button onClick={() => setModal('cubagem')}
                  className="w-full flex items-center gap-2 justify-center py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50">
                  📐 Registrar Cubagem
                </button>
              )}
            </div>
          </div>

          <div className="bg-gray-50 rounded-xl p-4 text-xs text-gray-500 space-y-1">
            <p>Criado: {pedido.criado_em ? format(parseISO(pedido.criado_em), "dd/MM/yyyy HH:mm", { locale: ptBR }) : '—'}</p>
            <p>Atualizado: {pedido.atualizado_em ? format(parseISO(pedido.atualizado_em), "dd/MM/yyyy HH:mm", { locale: ptBR }) : '—'}</p>
          </div>

          {/* Cancelar OV — disponível em qualquer status antes de expedir */}
          {!['EXPEDIDO', 'CANCELADO'].includes(status) && (
            <button
              onClick={() => setModal('cancelar')}
              className="w-full py-2.5 border-2 border-red-200 text-red-600 rounded-lg text-sm font-medium hover:bg-red-50 hover:border-red-400 transition-colors"
            >
              ❌ Cancelar OV
            </button>
          )}

          {status === 'CANCELADO' && (
            <div className="bg-gray-100 rounded-xl p-3 text-center text-sm text-gray-500">
              ❌ OV Cancelada
            </div>
          )}
        </div>
      </div>

      {/* Modais */}
      {modal === 'inventario' && <ModalInventario pedido={pedido} onClose={() => setModal(null)} />}
      {modal === 'verificacao' && <ModalVerificacao pedido={pedido} onClose={() => setModal(null)} />}
      {modal === 'cubagem' && <ModalCubagem pedido={pedido} onClose={() => setModal(null)} />}
      {modal === 'divergencia' && <ModalTratativaDivergencia pedido={pedido} onClose={() => setModal(null)} />}
      {modal === 'pallet' && <ModalEscolherPallet pedido={pedido} onClose={() => setModal(null)} />}
      {modal === 'transportadora' && <ModalAlterarTransportadora pedido={pedido} onClose={() => setModal(null)} />}
      {modal === 'cancelar' && <ModalCancelarOV pedido={pedido} onClose={() => setModal(null)} />}
      {modal === 'retornar' && <ModalRetornarEtapa pedido={pedido} onClose={() => setModal(null)} />}
      {modal === 'confirmar_coleta' && <ModalConfirmarColeta pedido={pedido} onClose={() => setModal(null)} />}
      {modal === 'faturamento' && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md">
            <div className="p-5 border-b">
              <div className="flex items-center justify-between">
                <h2 className="text-lg font-bold">🧾 Registrar NF — {pedido.numero_pedido}</h2>
                <span className={`text-xs font-bold px-2 py-1 rounded-full ${
                  isCIF ? 'bg-purple-100 text-purple-700' : 'bg-gray-100 text-gray-600'
                }`}>
                  {TIPO_FRETE_LABEL[pedido.tipo_frete || 'FOB']}
                </span>
              </div>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-sm font-medium text-gray-700">Número da NF *</label>
                <input type="text" value={nf} onChange={e => setNf(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1 font-mono" placeholder="000001" />
              </div>

              {/* FOB — campo único */}
              {!isCIF && (
                <div>
                  <label className="text-sm text-gray-600">Valor da NF (R$)</label>
                  <input type="number" step="0.01" value={valorNf} onChange={e => setValorNf(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" placeholder="0,00" />
                </div>
              )}

              {/* CIF — separado por produto e frete */}
              {isCIF && (
                <>
                  <div className="bg-purple-50 border border-purple-200 rounded-lg p-3 text-xs text-purple-700">
                    📦 Frete <strong>{TIPO_FRETE_LABEL[pedido.tipo_frete || 'FOB']}</strong> — informe o valor do produto e do frete separadamente.
                    {pedido.tipo_frete === 'CIF_SEM_VALOR' && <span className="block mt-1">⚠ CIF sem valor NF: o valor do frete <strong>não entra</strong> na NF.</span>}
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">💰 Valor dos Produtos (R$)</label>
                    <input type="number" step="0.01" value={valorProdutos} onChange={e => setValorProdutos(e.target.value)}
                      className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" placeholder="0,00" />
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">🚛 Custo do Frete (R$)</label>
                    <input type="number" step="0.01" value={valorFrete} onChange={e => setValorFrete(e.target.value)}
                      className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" placeholder="0,00" />
                    {pedido.tipo_frete === 'CIF_SEM_VALOR' && (
                      <p className="text-xs text-gray-400 mt-1">Valor de controle interno — não consta na NF.</p>
                    )}
                  </div>
                  {(valorProdutos || valorFrete) && (
                    <div className="bg-gray-50 rounded-lg p-3 text-sm">
                      <div className="flex justify-between text-gray-500">
                        <span>Produtos</span>
                        <span>R$ {(Number(valorProdutos) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                      </div>
                      <div className="flex justify-between text-gray-500 mt-1">
                        <span>Frete</span>
                        <span>R$ {(Number(valorFrete) || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                      </div>
                      <div className="flex justify-between font-bold text-gray-800 border-t pt-2 mt-2">
                        <span>Total NF</span>
                        <span>R$ {valorNfCalculado?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                      </div>
                    </div>
                  )}
                </>
              )}
              {/* Corrigir data de entrega */}
              <div className="border-t pt-4">
                <label className="text-sm font-medium text-gray-700 flex items-center gap-1">
                  📅 Corrigir data de entrega
                  <span className="text-xs text-gray-400 font-normal ml-1">
                    (atual: {pedido.data_prevista_entrega
                      ? new Date(pedido.data_prevista_entrega + 'T12:00:00').toLocaleDateString('pt-BR')
                      : '—'})
                  </span>
                </label>
                <input
                  type="date"
                  value={novaDataEntrega}
                  onChange={e => setNovaDataEntrega(e.target.value)}
                  className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1"
                />
                {!novaDataEntrega && (
                  <p className="text-xs text-gray-400 mt-1">Deixe em branco para manter a data atual</p>
                )}
              </div>
            </div>
            <div className="p-5 border-t flex gap-2 justify-end">
              <button onClick={() => setModal(null)} className="px-4 py-2 border rounded-lg text-sm">Cancelar</button>
              <button onClick={() => faturarMutation.mutate()} disabled={faturarMutation.isPending || !nf}
                className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {faturarMutation.isPending ? 'Salvando...' : 'Confirmar NF'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

import { useState, useRef, useEffect } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Plus, Trash2, CheckCircle, XCircle, Copy, Package, FileText, Truck, Pencil } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import api from '../lib/api'
import type { InventarioItem, Pedido, Cubagem, Transportadora } from '../types'
import { ClienteAutocomplete } from './NovoPedido'
import { ItensPedido, type ItemLinha } from '../components/ItensPedido'
import { StatusBadge } from '../components/StatusBadge'
import { PrioridadeBadge } from '../components/PrioridadeBadge'
import { LocalEntregaInput } from '../components/LocalEntregaInput'
import { TIPO_FRETE_LABEL, OPERACAO_LABEL, CANAL_LABEL, STATUS_CONFIG } from '../lib/statusConfig'
import { calcHorasComerciais, formatarTempo, corSLA, bgSLA } from '../lib/horasComerciais'
import { imprimirEtiquetaNavegador } from '../lib/zebraPrint'
import { useAuthStore } from '../store/authStore'
import toast from 'react-hot-toast'

function formatarCnpjExibicao(v: string) {
  const d = (v || '').replace(/\D/g, '')
  if (d.length !== 14) return v
  return d.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5')
}

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
  const linhaVazia = { codigo_item: '', lote: '', qtd_sistemico: 0, qtd_fisico: undefined as number | undefined, qtd_venda: 0, observacao: '' }
  // Pré-carrega os itens cadastrados na criação da OV (código + quantidade → Qtd Venda).
  const [itens, setItens] = useState<Omit<InventarioItem, 'id' | 'pedido_id' | 'qtd_estoque' | 'status_item'>[]>(() => {
    const doPedido = ((pedido.itens || []) as any[]).filter(it => (it.produtos?.codigo || it.produto?.codigo))
    if (doPedido.length === 0) return [{ ...linhaVazia }]
    return doPedido.map(it => ({
      codigo_item: it.produtos?.codigo || it.produto?.codigo || '',
      lote: '',
      qtd_sistemico: 0,
      qtd_fisico: undefined,
      qtd_venda: Number(it.qtd_solicitada) || 0,
      observacao: it.produtos?.descricao || it.produto?.descricao || '',
    }))
  })
  const preCarregado = ((pedido.itens || []) as any[]).some(it => (it.produtos?.codigo || it.produto?.codigo))

  const addLinha = () => setItens([...itens, { ...linhaVazia }])
  const removeLinha = (i: number) => setItens(itens.filter((_, idx) => idx !== i))

  const update = (i: number, campo: string, valor: any) => {
    const novo = [...itens]
    ;(novo[i] as any)[campo] = valor
    setItens(novo)
  }

  // Ao preencher o lote, puxa o estoque que sobrou no último inventário desse
  // (código, lote) e usa como Qtd Sistema (inventário contínuo).
  const puxarEstoqueLote = async (i: number) => {
    const it = itens[i]
    if (!it.codigo_item || !it.lote?.trim()) return
    try {
      const { data } = await api.get('/inventario/ultimo-lote', {
        params: { codigo: it.codigo_item, lote: it.lote.trim() },
      })
      if (data && data.estoque != null) {
        setItens(prev => prev.map((row, idx) => idx === i ? { ...row, qtd_sistemico: data.estoque } : row))
        const quando = data.criado_em ? new Date(data.criado_em).toLocaleDateString('pt-BR') : ''
        toast.success(`Estoque do último inventário (${quando}) puxado: ${data.estoque}`, { duration: 3000 })
      }
    } catch { /* silencioso — lote ainda não inventariado */ }
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

  const podeEnviar = itens.every(i => i.codigo_item && i.lote && i.qtd_venda > 0)

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-start justify-center z-50 p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl w-full max-w-4xl my-4">
        <div className="p-5 border-b flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold">📦 Inventário Contínuo — {pedido.numero_pedido}</h2>
            <p className="text-sm text-gray-500 mt-0.5">
              {preCarregado
                ? 'Itens da OV pré-carregados (código e Qtd Venda). Informe o lote — a Qtd Sistema vem do último inventário.'
                : 'Preencha código, lote e quantidades de cada item'}
            </p>
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
                <th className="pb-2 pr-3 text-right">Qtd Venda *</th>
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
                        onBlur={() => puxarEstoqueLote(i)}
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
                      <input type="number" value={item.qtd_venda || ''} min={1}
                        onChange={e => update(i, 'qtd_venda', Number(e.target.value))}
                        placeholder="obrigatório"
                        className={`w-20 border rounded px-2 py-1 text-sm text-right ${item.qtd_venda > 0 ? '' : 'border-amber-400 bg-amber-50'}`} />
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

        <div className="p-5 border-t flex items-center justify-end gap-3">
          {!podeEnviar && (
            <span className="text-xs text-amber-600">Preencha código, lote e <strong>Qtd Venda &gt; 0</strong> em todos os itens.</span>
          )}
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
  const [imprimindo, setImprimindo] = useState<string | null>(null)
  const [nomeOperador, setNomeOperador] = useState(usuario?.nome || '')
  const [porCaixaMap, setPorCaixaMap] = useState<Record<string, number>>({})

  // Ref síncrono para bloquear duplo-clique antes do React re-renderizar
  const emProcessamentoRef = useRef<Set<string>>(new Set())

  const itens: InventarioItem[] = inv?.itens || []

  // Se o lote já foi inventariado antes, a validade vem preenchida (do backend).
  useEffect(() => {
    if (!itens.length) return
    setValidadeMap(prev => {
      const novo = { ...prev }
      let mudou = false
      for (const it of itens) {
        const conhecida = (it as any).validade_conhecida
        if (conhecida && !novo[it.id]) { novo[it.id] = conhecida; mudou = true }
      }
      return mudou ? novo : prev
    })
  }, [inv])

  const totalItens = itens.length
  const totalConferidos = conferidos.size
  const todosConferidos = totalItens > 0 && totalConferidos === totalItens

  const updateItem = (id: string, campo: string, valor: any) => {
    setItensVerif(prev => ({ ...prev, [id]: { ...prev[id], [campo]: valor } }))
  }

  const toggleConferido = async (id: string, item: InventarioItem) => {
    // Bloqueia duplo-clique: ref é síncrono, não depende de re-render
    if (emProcessamentoRef.current.has(id)) return

    const jaConferido = conferidos.has(id)
    setConferidos(prev => {
      const novo = new Set(prev)
      jaConferido ? novo.delete(id) : novo.add(id)
      return novo
    })

    // Imprime etiqueta(s) ao marcar como conferido — envia para fila no backend
    if (!jaConferido) {
      emProcessamentoRef.current.add(id)   // bloqueia imediatamente (síncrono)
      setImprimindo(id)
      const estoqueRestante = item.qtd_sistemico - item.qtd_venda
      const porCaixa = porCaixaMap[id]
      try {
        if (porCaixa && porCaixa > 0) {
          // Imprime apenas a caixa aberta (restante da divisão)
          const caixaAberta = estoqueRestante % porCaixa
          if (caixaAberta > 0) {
            await api.post('/impressao', {
              codigo:          item.codigo_item,
              lote:            item.lote,
              validade:        validadeMap[id] || undefined,
              quantidade:      caixaAberta,
              operador:        nomeOperador || usuario?.nome || '',
              data_inventario: new Date().toISOString(),
            })
            toast.success(`🖨 Caixa aberta (${caixaAberta} un) — ${item.codigo_item}`)
          } else {
            // Todas as caixas fechadas — não imprime
            toast(`📦 Todas as caixas fechadas — sem etiqueta para ${item.codigo_item}`)
          }
        } else {
          // Sem "por caixa" configurado — etiqueta única com total
          await api.post('/impressao', {
            codigo:          item.codigo_item,
            lote:            item.lote,
            validade:        validadeMap[id] || undefined,
            quantidade:      estoqueRestante,
            operador:        nomeOperador || usuario?.nome || '',
            data_inventario: new Date().toISOString(),
          })
          toast.success(`🖨 Etiqueta enviada — ${item.codigo_item}`)
        }
      } catch (err: any) {
        const msg = err?.response?.data?.detail || err?.message || String(err)
        console.error('[Impressao] Erro ao enviar job:', msg, err)
        toast.error(`❌ Erro ao enviar etiqueta: ${msg}`)
      } finally {
        emProcessamentoRef.current.delete(id)  // libera após concluir (ou erro)
        setImprimindo(null)
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
                <span className="text-xs bg-green-100 text-green-700 px-2 py-0.5 rounded-full font-medium">🖨 Imprime automaticamente ao conferir</span>
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
                <th className="pb-2 pr-3 text-center text-orange-600" title="Quantas unidades cabem em cada caixa">Por caixa</th>
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
                    {/* Por caixa — qtd por caixa para gerar múltiplas etiquetas */}
                    <td className="py-2 pr-3">
                      <div className="flex flex-col items-center gap-0.5">
                        <input
                          type="number"
                          min={1}
                          placeholder="—"
                          value={porCaixaMap[item.id] || ''}
                          onChange={e => {
                            const v = parseInt(e.target.value)
                            setPorCaixaMap(prev => ({ ...prev, [item.id]: v || 0 }))
                          }}
                          className="w-16 border border-orange-200 rounded px-2 py-1 text-xs text-center focus:border-orange-400 focus:outline-none"
                        />
                        {porCaixaMap[item.id] > 0 && estoqueRestante > 0 && (
                          <span className="text-[10px] font-medium">
                            {estoqueRestante % porCaixaMap[item.id] === 0
                              ? <span className="text-gray-400">todas fechadas</span>
                              : <span className="text-orange-600">aberta: {estoqueRestante % porCaixaMap[item.id]} un</span>
                            }
                          </span>
                        )}
                      </div>
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
  EM_COTACAO_FRETE:      { label: 'Cotação de Frete',     destinos: [{ status: 'EM_PROCESSO_SISTEMICO', label: 'D365 + Cubagem' }, { status: 'EM_INVENTARIO', label: 'Em Inventário' }, { status: 'LIBERADO', label: 'OV Recebida (início)' }] },
  AGUARD_TRANSPORTADORA: { label: 'Aguard. Transportadora', destinos: [{ status: 'EM_PROCESSO_SISTEMICO', label: 'D365 + Cubagem' }, { status: 'EM_INVENTARIO', label: 'Em Inventário' }, { status: 'LIBERADO', label: 'OV Recebida (início)' }] },
  AGUARD_FATURAMENTO:    { label: 'Aguard. Faturamento',  destinos: [{ status: 'EM_COTACAO_FRETE', label: 'Cotação de Frete' }, { status: 'AGUARD_TRANSPORTADORA', label: 'Aguard. Transportadora' }, { status: 'EM_PROCESSO_SISTEMICO', label: 'D365 + Cubagem' }, { status: 'EM_INVENTARIO', label: 'Em Inventário' }, { status: 'LIBERADO', label: 'OV Recebida (início)' }] },
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

function ModalReativarOV({ pedido, onClose }: { pedido: Pedido; onClose: () => void }) {
  const qc = useQueryClient()
  const [motivo, setMotivo] = useState('')
  const [editar, setEditar] = useState(false)

  const [form, setForm] = useState({
    numero_pedido: pedido.numero_pedido || '',
    cliente_id: pedido.cliente_id || '',
    cliente_nome: pedido.cliente?.nome || pedido.cliente_nome || '',
    transportadora_id: pedido.transportadora_id || '',
    tipo_frete: (pedido.tipo_frete || 'FOB') as string,
    tipo_operacao: pedido.tipo_operacao || '',
    canal: pedido.canal || '',
    prioridade: (pedido.prioridade || 'NORMAL') as string,
    data_prevista_entrega: pedido.data_prevista_entrega || '',
    local_entrega: pedido.local_entrega || '',
    observacoes: pedido.observacoes || '',
  })

  const { data: transportadoras = [] } = useQuery<Transportadora[]>({
    queryKey: ['transportadoras'],
    queryFn: () => api.get('/transportadoras').then(r => r.data),
    enabled: editar,
  })

  const mutation = useMutation({
    mutationFn: () => {
      const dados = editar
        ? {
            numero_pedido: form.numero_pedido,
            cliente_id: form.cliente_id,
            transportadora_id: form.transportadora_id || null,
            tipo_frete: form.tipo_frete,
            tipo_operacao: form.tipo_operacao,
            canal: form.canal || null,
            prioridade: form.prioridade,
            data_prevista_entrega: form.data_prevista_entrega,
            local_entrega: form.local_entrega,
            observacoes: form.observacoes,
          }
        : undefined
      return api.post(`/pedidos/${pedido.id}/reativar`, { motivo: motivo.trim(), dados })
    },
    onSuccess: () => {
      toast.success('OV reativada — voltou para o início do fluxo e a ocorrência foi registrada.')
      qc.invalidateQueries({ queryKey: ['pedido', pedido.id] })
      qc.invalidateQueries({ queryKey: ['pedidos'] })
      qc.invalidateQueries({ queryKey: ['ocorrencias'] })
      qc.invalidateQueries({ queryKey: ['movimentacoes', pedido.id] })
      onClose()
    },
    onError: (e: any) => {
      const d = e?.response?.data?.detail
      toast.error(typeof d === 'string' ? d : 'Erro ao reativar OV')
    },
  })

  const dadosOk = !editar || (!!form.numero_pedido.trim() && !!form.cliente_id
    && !!form.data_prevista_entrega && !!form.tipo_operacao)

  return (
    <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="p-5 border-b bg-blue-50 rounded-t-2xl sticky top-0">
          <h2 className="text-lg font-bold text-blue-700">↩️ Reativar OV — {pedido.numero_pedido}</h2>
          <p className="text-sm text-blue-600 mt-0.5">A OV cancelada voltará para o início do fluxo (OV Recebida).</p>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-700">Motivo da reativação *</label>
            <textarea rows={2} value={motivo} onChange={e => setMotivo(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm mt-1 focus:outline-none focus:ring-2 focus:ring-blue-400"
              placeholder="Ex: cancelamento indevido — vendas confirmou que o pedido segue" autoFocus />
            {motivo.trim().length > 0 && motivo.trim().length < 5 && (
              <p className="text-xs text-red-500 mt-1">Descreva o motivo com mais detalhes (mín. 5 caracteres)</p>
            )}
          </div>

          {/* Toggle: editar dados da OV */}
          <label className={`flex items-start gap-3 p-3 rounded-xl border-2 cursor-pointer transition-colors ${
            editar ? 'border-blue-500 bg-blue-50' : 'border-gray-200 hover:border-blue-300'
          }`}>
            <input type="checkbox" checked={editar} onChange={e => setEditar(e.target.checked)}
              className="mt-0.5 w-4 h-4 accent-blue-600 flex-shrink-0" />
            <div>
              <p className="text-sm font-medium text-gray-800">✏️ Alterar dados da OV ao reativar</p>
              <p className="text-xs text-gray-500 mt-0.5">Marque para corrigir data, cliente, canal e demais informações antes de reativar.</p>
            </div>
          </label>

          {editar && (
            <div className="grid grid-cols-2 gap-3 border-t pt-4">
              <div className="col-span-2">
                <label className="text-xs font-medium text-gray-600">Número da OV *</label>
                <input type="text" value={form.numero_pedido}
                  onChange={e => setForm({ ...form, numero_pedido: e.target.value.toUpperCase() })}
                  className="w-full border rounded-lg px-3 py-2 text-sm mt-1 font-mono" />
              </div>

              <div className="col-span-2">
                <label className="text-xs font-medium text-gray-600">Cliente *</label>
                <ClienteAutocomplete value={form.cliente_id}
                  onChange={(id, nome) => setForm({ ...form, cliente_id: id, cliente_nome: nome })} />
                <p className="text-xs text-gray-500 mt-1">
                  Atual: <strong>{form.cliente_nome || '—'}</strong>
                </p>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-600">Tipo de Frete</label>
                <select value={form.tipo_frete} onChange={e => setForm({ ...form, tipo_frete: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2 text-sm mt-1">
                  <option value="FOB">FOB</option>
                  <option value="CIF_COM_VALOR">CIF com Valor NF</option>
                  <option value="CIF_SEM_VALOR">CIF sem Valor NF</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-600">Prioridade</label>
                <select value={form.prioridade} onChange={e => setForm({ ...form, prioridade: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2 text-sm mt-1">
                  <option value="NORMAL">Normal</option>
                  <option value="ALTA">Alta</option>
                  <option value="CRITICA">🔴 Crítica</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-600">Tipo de Operação *</label>
                <select value={form.tipo_operacao} onChange={e => setForm({ ...form, tipo_operacao: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2 text-sm mt-1">
                  <option value="" disabled>Selecione…</option>
                  <option value="VENDA_NORMAL">Venda normal</option>
                  <option value="COMUNICADO_USO">Comunicado de uso</option>
                  <option value="BONIFICACAO_DOACAO">Bonificação/Doação</option>
                  <option value="AMOSTRA">Amostra</option>
                  <option value="CONSIGNADO">Consignado</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-600">Canal de Venda</label>
                <select value={form.canal} onChange={e => setForm({ ...form, canal: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2 text-sm mt-1">
                  <option value="">—</option>
                  <option value="URO">Uro</option>
                  <option value="VASCULAR">Vascular</option>
                  <option value="REALCLOSURE">Realclosure</option>
                  <option value="LICITACAO_URO">Licitação - Uro</option>
                  <option value="LICITACAO_VASCULAR">Licitação - Vascular</option>
                </select>
              </div>

              <div>
                <label className="text-xs font-medium text-gray-600">Data Prevista de Entrega *</label>
                <input type="date" value={form.data_prevista_entrega}
                  onChange={e => setForm({ ...form, data_prevista_entrega: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
              </div>

              <div>
                <label className="text-xs font-medium text-gray-600">Transportadora</label>
                <select value={form.transportadora_id} onChange={e => setForm({ ...form, transportadora_id: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2 text-sm mt-1">
                  <option value="">A definir...</option>
                  {transportadoras.map(t => <option key={t.id} value={t.id}>{t.nome}</option>)}
                </select>
              </div>

              <div className="col-span-2">
                <label className="text-xs font-medium text-gray-600">Local de Entrega</label>
                <div className="mt-1">
                  <LocalEntregaInput value={form.local_entrega} onChange={v => setForm({ ...form, local_entrega: v })} />
                </div>
              </div>

              <div className="col-span-2">
                <label className="text-xs font-medium text-gray-600">Observações</label>
                <textarea rows={2} value={form.observacoes}
                  onChange={e => setForm({ ...form, observacoes: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
              </div>
            </div>
          )}

          <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-xs text-blue-600">
            {(editar ? form.tipo_operacao : pedido.tipo_operacao) === 'COMUNICADO_USO' ? (
              <>📋 Como é um <strong>Comunicado de Uso</strong>, a OV volta direto para <strong>Faturado</strong> (sem passar pelo processo logístico). Uma ocorrência será registrada{editar ? ' com as alterações aplicadas' : ''}.</>
            ) : (
              <>📋 Uma <strong>ocorrência</strong> será registrada com o motivo{editar ? ' e todas as alterações aplicadas' : ''}, e a movimentação (Cancelado → OV Recebida) fica no histórico.</>
            )}
          </div>
        </div>
        <div className="p-5 border-t flex gap-2 justify-end sticky bottom-0 bg-white">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Voltar</button>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || motivo.trim().length < 5 || !dadosOk}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-blue-700"
          >
            {mutation.isPending ? 'Reativando...' : 'Confirmar Reativação'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Modal Cotação de Frete (CIF — antes do faturamento) ──────────────────────
function ModalCotacaoFrete({ pedido, onClose }: { pedido: Pedido; onClose: () => void }) {
  const qc = useQueryClient()
  const [valorFrete, setValorFrete] = useState(pedido.valor_frete ? String(pedido.valor_frete) : '')
  const [obs, setObs] = useState('')
  const esperadaCliente = (pedido as any).data_esperada_cliente || pedido.data_prevista_entrega
  const [dataEntrega, setDataEntrega] = useState(esperadaCliente || '')
  const semValor = pedido.tipo_frete === 'CIF_SEM_VALOR'
  const valorOk = Number(valorFrete) > 0

  const mutation = useMutation({
    mutationFn: () => api.post(`/pedidos/${pedido.id}/cotacao-frete`, {
      valor_frete: valorOk ? Number(valorFrete) : null,
      observacao: obs.trim() || null,
      data_prevista_entrega: dataEntrega || null,
    }),
    onSuccess: () => {
      toast.success('Frete cotado — OV liberada para faturamento')
      qc.invalidateQueries({ queryKey: ['pedido', pedido.id] })
      qc.invalidateQueries({ queryKey: ['pedidos'] })
      onClose()
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao registrar cotação de frete'),
  })

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md">
        <div className="p-5 border-b bg-amber-50 rounded-t-2xl flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-amber-800">🚚 Cotação de Frete — {pedido.numero_pedido}</h2>
            <p className="text-sm text-amber-700 mt-0.5">{TIPO_FRETE_LABEL[pedido.tipo_frete || 'FOB']}</p>
          </div>
          <button onClick={onClose} className="text-amber-700 hover:text-amber-900"><XCircle size={20} /></button>
        </div>
        <div className="p-5 space-y-4">
          {esperadaCliente && (
            <div className="bg-blue-50 border border-blue-100 rounded-lg p-2.5 text-sm text-blue-800">
              📅 Data esperada pelo cliente: <strong>{new Date(esperadaCliente + 'T12:00:00').toLocaleDateString('pt-BR')}</strong>
            </div>
          )}
          <div>
            <label className="text-sm font-medium text-gray-700">Data prevista de entrega *</label>
            <input type="date" value={dataEntrega} onChange={e => setDataEntrega(e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" />
            <p className="text-[11px] text-gray-400 mt-1">Confirme a data real de entrega com base no prazo do frete cotado.</p>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700">Valor cotado do frete (R$)</label>
            <input type="number" step="0.01" min="0" value={valorFrete}
              onChange={e => setValorFrete(e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" placeholder="0,00" />
            <p className="text-[11px] text-gray-400 mt-1">
              {semValor
                ? 'CIF sem valor: o frete não entra na NF — é custo nosso e sai do faturamento.'
                : 'CIF com valor: o frete fica embutido na NF e é ressarcido pelo cliente.'}
            </p>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700">Observação (opcional)</label>
            <input value={obs} onChange={e => setObs(e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" placeholder="Transportadora cotada, prazo, etc." />
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className="flex-1 py-2.5 border rounded-lg text-sm text-gray-600">Cancelar</button>
            <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !dataEntrega}
              className="flex-1 py-2.5 bg-amber-600 text-white rounded-lg text-sm font-medium hover:bg-amber-500 disabled:opacity-50">
              {mutation.isPending ? 'Salvando…' : 'Liberar para faturamento'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Modal Transportadora do Cliente (FOB) ────────────────────────────────────
function ModalTransportadoraCliente({ pedido, onClose }: { pedido: Pedido; onClose: () => void }) {
  const qc = useQueryClient()
  const [transportadoraId, setTransportadoraId] = useState(pedido.transportadora_id || '')
  const [nomeReal, setNomeReal] = useState('')
  const [obs, setObs] = useState('')
  const esperadaCliente = (pedido as any).data_esperada_cliente || pedido.data_prevista_entrega
  const [dataEntrega, setDataEntrega] = useState(esperadaCliente || '')

  const { data: transportadoras = [] } = useQuery<Transportadora[]>({
    queryKey: ['transportadoras'],
    queryFn: () => api.get('/transportadoras').then(r => r.data),
  })
  const transpSel = (transportadoras as any[]).find((t: any) => t.id === transportadoraId)
  const isOutros = (transpSel?.nome || '').toUpperCase().includes('OUTROS')
  const podeSalvar = !!transportadoraId && !!dataEntrega && (!isOutros || nomeReal.trim().length > 0)

  const mutation = useMutation({
    mutationFn: () => api.post(`/pedidos/${pedido.id}/transportadora-cliente`, {
      transportadora_id: transportadoraId,
      transportadora_nome_real: isOutros && nomeReal.trim() ? nomeReal.trim() : null,
      observacao: obs.trim() || null,
      data_prevista_entrega: dataEntrega || null,
    }),
    onSuccess: () => {
      toast.success('Transportadora registrada — OV liberada para faturamento')
      qc.invalidateQueries({ queryKey: ['pedido', pedido.id] })
      qc.invalidateQueries({ queryKey: ['pedidos'] })
      onClose()
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao registrar transportadora'),
  })

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md">
        <div className="p-5 border-b bg-orange-50 rounded-t-2xl flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-orange-800">📥 Transportadora do Cliente — {pedido.numero_pedido}</h2>
            <p className="text-sm text-orange-700 mt-0.5">FOB · a transportadora vai na NF</p>
          </div>
          <button onClick={onClose} className="text-orange-700 hover:text-orange-900"><XCircle size={20} /></button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-[13px] text-gray-500">O cliente informou qual transportadora vai coletar. Registre para liberar o faturamento.</p>
          {esperadaCliente && (
            <div className="bg-blue-50 border border-blue-100 rounded-lg p-2.5 text-sm text-blue-800">
              📅 Data esperada pelo cliente: <strong>{new Date(esperadaCliente + 'T12:00:00').toLocaleDateString('pt-BR')}</strong>
            </div>
          )}
          <div>
            <label className="text-sm font-medium text-gray-700">Transportadora *</label>
            <select value={transportadoraId} onChange={e => setTransportadoraId(e.target.value)} autoFocus
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1">
              <option value="">Selecione a transportadora informada…</option>
              {(transportadoras as any[]).map((t: any) => <option key={t.id} value={t.id}>{t.nome}</option>)}
            </select>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700">Data prevista de entrega *</label>
            <input type="date" value={dataEntrega} onChange={e => setDataEntrega(e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" />
            <p className="text-[11px] text-gray-400 mt-1">Confirme a data real com base no prazo da transportadora.</p>
          </div>
          {isOutros && (
            <div>
              <label className="text-sm font-medium text-gray-700">Nome real da transportadora *</label>
              <input value={nomeReal} onChange={e => setNomeReal(e.target.value)}
                className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" placeholder="Ex: Jamef, Braspress…" />
            </div>
          )}
          <div>
            <label className="text-sm font-medium text-gray-700">Observação (opcional)</label>
            <input value={obs} onChange={e => setObs(e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" placeholder="Prazo, contato, etc." />
          </div>
          <div className="flex gap-2 pt-1">
            <button onClick={onClose} className="flex-1 py-2.5 border rounded-lg text-sm text-gray-600">Cancelar</button>
            <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !podeSalvar}
              className="flex-1 py-2.5 bg-orange-600 text-white rounded-lg text-sm font-medium hover:bg-orange-500 disabled:opacity-50">
              {mutation.isPending ? 'Salvando…' : 'Liberar para faturamento'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ── Modal Alterar Tipo de Frete ──────────────────────────────────────────────
const TIPOS_FRETE = ['FOB', 'CIF_COM_VALOR', 'CIF_SEM_VALOR'] as const

function ModalAlterarTipoFrete({ pedido, onClose }: { pedido: Pedido; onClose: () => void }) {
  const qc = useQueryClient()
  const tipoAtual = pedido.tipo_frete || 'FOB'
  const [tipoFrete, setTipoFrete] = useState(tipoAtual)
  const [motivo, setMotivo] = useState('')
  const [valorFrete, setValorFrete] = useState(pedido.valor_frete ? String(pedido.valor_frete) : '')
  const novoEhCif = tipoFrete === 'CIF_COM_VALOR' || tipoFrete === 'CIF_SEM_VALOR'
  const valorFreteOk = !novoEhCif || Number(valorFrete) > 0
  const mesmoTipo = tipoFrete === tipoAtual
  const valorMudou = Number(valorFrete) !== Number(pedido.valor_frete || 0)
  const mudouAlgo = !mesmoTipo || (novoEhCif && valorMudou)

  const mutation = useMutation({
    mutationFn: () => api.post(`/pedidos/${pedido.id}/alterar-tipo-frete`, {
      tipo_frete: tipoFrete,
      motivo: motivo.trim(),
      valor_frete: novoEhCif ? Number(valorFrete) : null,
    }),
    onSuccess: (res) => {
      const d = res.data
      toast.success(d.tipo_frete_anterior === d.tipo_frete_novo
        ? `Valor do frete corrigido (${TIPO_FRETE_LABEL[d.tipo_frete_novo]})`
        : `Tipo de frete alterado: ${TIPO_FRETE_LABEL[d.tipo_frete_anterior]} → ${TIPO_FRETE_LABEL[d.tipo_frete_novo]}`)
      qc.invalidateQueries({ queryKey: ['pedido', pedido.id] })
      qc.invalidateQueries({ queryKey: ['pedidos'] })
      qc.invalidateQueries({ queryKey: ['ocorrencias'] })
      onClose()
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao alterar tipo de frete'),
  })

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md">
        <div className="p-5 border-b bg-blue-50 rounded-t-2xl">
          <h2 className="text-lg font-bold text-blue-800">Alterar Tipo de Frete</h2>
          <p className="text-sm text-blue-600 mt-0.5">A alteração será registrada como ocorrência.</p>
        </div>
        <div className="p-5 space-y-4">
          <div className="bg-gray-50 rounded-lg p-3 text-sm">
            <p className="text-gray-500 text-xs mb-1">Tipo de frete atual</p>
            <p className="font-bold text-gray-800 text-base">{TIPO_FRETE_LABEL[tipoAtual]}</p>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">Novo tipo de frete *</label>
            <select value={tipoFrete} onChange={e => setTipoFrete(e.target.value as (typeof TIPOS_FRETE)[number])}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1">
              {TIPOS_FRETE.map(tipo => (
                <option key={tipo} value={tipo}>
                  {TIPO_FRETE_LABEL[tipo]}{tipo === tipoAtual ? ' (atual)' : ''}
                </option>
              ))}
            </select>
          </div>

          {novoEhCif && (
            <div>
              <label className="text-sm font-medium text-gray-700">Valor do frete (R$) *</label>
              <input type="number" step="0.01" min="0" value={valorFrete}
                onChange={e => setValorFrete(e.target.value)}
                className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" placeholder="0,00" />
              <p className="text-[11px] text-gray-400 mt-1">
                {tipoFrete === 'CIF_COM_VALOR'
                  ? 'CIF com valor: o frete está embutido na NF e é ressarcido pelo cliente.'
                  : 'CIF sem valor: o frete não está na NF — é custo nosso e sai do faturamento.'}
              </p>
            </div>
          )}

          <div>
            <label className="text-sm font-medium text-gray-700">Motivo da alteração *</label>
            <textarea rows={3} value={motivo} onChange={e => setMotivo(e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1"
              placeholder="Ex.: Tipo de frete informado incorretamente na OV..." autoFocus />
          </div>

          <div className="bg-amber-50 border border-amber-200 rounded-lg p-3 text-xs text-amber-700">
            {mesmoTipo
              ? 'Uma ocorrência aberta será criada registrando a correção do valor do frete.'
              : 'Uma ocorrência aberta será criada com o tipo anterior, o novo tipo e o motivo informado.'}
          </div>
        </div>
        <div className="p-5 border-t flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Cancelar</button>
          <button onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !mudouAlgo || !motivo.trim() || !valorFreteOk}
            className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium disabled:opacity-50 hover:bg-blue-500">
            {mutation.isPending ? 'Salvando...' : 'Confirmar Alteração'}
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
  const [registrarOcorrencia, setRegistrarOcorrencia] = useState(false)
  const [nomeRealOutros, setNomeRealOutros] = useState('')

  const { data: transportadoras = [] } = useQuery({
    queryKey: ['transportadoras'],
    queryFn: () => api.get('/transportadoras').then(r => r.data),
  })

  const { data: motivos = [] } = useQuery({
    queryKey: ['motivos-transportadora'],
    queryFn: () => api.get('/motivos-ocorrencia?tipo=TRANSPORTADORA').then(r => r.data),
    enabled: registrarOcorrencia,
  })

  const motivoFinal = motivo === '__outro__' ? motivoOutro : motivo

  const transpSelecionada = (transportadoras as any[]).find((t: any) => t.id === transportadoraId)
  const isOutros = transpSelecionada?.nome?.toUpperCase().includes('OUTROS')

  const mutation = useMutation({
    mutationFn: () => api.post(`/pedidos/${pedido.id}/alterar-transportadora`, {
      transportadora_id: transportadoraId,
      motivo: registrarOcorrencia ? motivoFinal : undefined,
      registrar_ocorrencia: registrarOcorrencia,
      transportadora_nome_real: isOutros && nomeRealOutros.trim() ? nomeRealOutros.trim() : undefined,
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
            <select
              value={transportadoraId}
              onChange={e => { setTransportadoraId(e.target.value); setNomeRealOutros('') }}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1"
            >
              <option value="">Selecione a transportadora correta...</option>
              {(transportadoras as any[]).map((t: any) => (
                <option key={t.id} value={t.id}>{t.nome}</option>
              ))}
            </select>
          </div>

          {/* Campo extra quando OUTROS é selecionado */}
          {isOutros && (
            <div>
              <label className="text-sm font-medium text-gray-700">
                Nome real da transportadora *
              </label>
              <input
                type="text"
                value={nomeRealOutros}
                onChange={e => setNomeRealOutros(e.target.value)}
                placeholder="Ex: Jadlog, Azul Cargo, Sequoia..."
                className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1 focus:outline-none focus:ring-2 focus:ring-orange-400"
                autoFocus
              />
              <p className="text-xs text-gray-400 mt-1">
                Será registrado nas observações da OV e no histórico.
              </p>
            </div>
          )}

          {/* Checkbox registrar ocorrência */}
          <label className={`flex items-start gap-3 p-3 rounded-xl border-2 cursor-pointer transition-colors ${
            registrarOcorrencia ? 'border-orange-400 bg-orange-50' : 'border-gray-200 hover:border-orange-300'
          }`}>
            <input
              type="checkbox"
              checked={registrarOcorrencia}
              onChange={e => { setRegistrarOcorrencia(e.target.checked); setMotivo(''); setMotivoOutro('') }}
              className="mt-0.5 w-4 h-4 accent-orange-600 flex-shrink-0"
            />
            <div>
              <p className="text-sm font-medium text-gray-800">Registrar ocorrência</p>
              <p className="text-xs text-gray-500 mt-0.5">Marque para documentar o motivo da troca e abrir uma ocorrência.</p>
            </div>
          </label>

          {/* Motivo — só aparece se registrar ocorrência */}
          {registrarOcorrencia && (
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
          )}
        </div>
        <div className="p-5 border-t flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Cancelar</button>
          <button onClick={() => mutation.mutate()}
            disabled={
            mutation.isPending ||
            !transportadoraId ||
            (isOutros && !nomeRealOutros.trim()) ||
            (registrarOcorrencia && !motivoFinal.trim())
          }
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
  const [transportadoraOutros, setTransportadoraOutros] = useState('')
  const [conferidoNF, setConferidoNF] = useState(false)

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

  // Verifica se o pallet selecionado é PLT-OUTROS
  const palletSelecionado = (pallets as any[]).find((p: any) => p.id === palletId)
  const isOutros = palletSelecionado?.codigo === 'PLT-OUTROS'

  const mutation = useMutation({
    mutationFn: () => api.post(`/pallets/${palletId}/pedidos`, {
      // Usa o UUID da remessa específica — evita pegar outra remessa da família (ex: R1 já expedida)
      pedido_id: pedido.id,
      observacao: isOutros && transportadoraOutros.trim() ? transportadoraOutros.trim() : undefined,
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
                <button key={p.id} onClick={() => { setPalletId(p.id); setTransportadoraOutros('') }}
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

          {/* Campo transportadora — só aparece para PLT-OUTROS */}
          {isOutros && (
            <div className="bg-gray-50 border border-gray-200 rounded-xl p-4 space-y-1">
              <label className="text-sm font-semibold text-gray-700">
                🚚 Qual transportadora vai coletar? *
              </label>
              <input
                type="text"
                value={transportadoraOutros}
                onChange={e => setTransportadoraOutros(e.target.value.toUpperCase())}
                className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm mt-1 font-medium focus:outline-none focus:ring-2 focus:ring-gray-400"
                placeholder="Ex: JADLOG, TNT, TOTAL..."
                autoFocus
              />
              <p className="text-xs text-gray-400">Aparecerá no card do pallet para identificação</p>
            </div>
          )}

          {/* Conferência físico vs NF */}
          <button
            type="button"
            onClick={() => setConferidoNF(v => !v)}
            className={`w-full flex items-center gap-3 p-4 rounded-xl border-2 text-left transition-all ${
              conferidoNF
                ? 'border-green-500 bg-green-50'
                : 'border-dashed border-gray-300 hover:border-gray-400 bg-gray-50'
            }`}
          >
            <div className={`w-6 h-6 rounded-full border-2 flex items-center justify-center flex-shrink-0 transition-all ${
              conferidoNF ? 'bg-green-500 border-green-500' : 'border-gray-400'
            }`}>
              {conferidoNF && <span className="text-white text-xs font-bold">✓</span>}
            </div>
            <div>
              <p className={`text-sm font-semibold ${conferidoNF ? 'text-green-800' : 'text-gray-600'}`}>
                Físico confere com a Nota Fiscal *
              </p>
              <p className="text-xs text-gray-400 mt-0.5">
                Verifiquei que os itens da caixa estão de acordo com o q consta na NF
              </p>
            </div>
          </button>

        </div>
        <div className="p-5 border-t flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Cancelar</button>
          <button onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !palletId || (isOutros && !transportadoraOutros.trim()) || !conferidoNF}
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
// ── Editar itens da OV ────────────────────────────────────────────────────────
/** Substitui os itens da OV inteira — o caso concreto que motivou isto: um item
 *  sem estoque que o comercial trocou por outro. Mostra o estoque disponível
 *  de cada linha (mesma fonte do Radar de produtos da Inteligência) para o
 *  operador ver ANTES de fechar se o item novo também não vai faltar. */
function ModalEditarItens({ pedido, onClose }: { pedido: Pedido; onClose: () => void }) {
  const qc = useQueryClient()
  const itensIniciais: ItemLinha[] = ((pedido as any).itens || [])
    .filter((it: any) => it.produto_id)
    .map((it: any) => ({
      produto_id: it.produto_id,
      codigo: it.produtos?.codigo || it.produto?.codigo || '',
      descricao: it.produtos?.descricao || it.produto?.descricao || '',
      qtd: Number(it.qtd_solicitada) || 0,
      valor: Number(it.valor_unitario) || 0,
    }))
  const [itens, setItens] = useState<ItemLinha[]>(itensIniciais)

  // Estoque disponível por código — mesma fonte do Radar de produtos (Inteligência).
  const { data: estoque } = useQuery<any>({
    queryKey: ['estoque-listar'],
    queryFn: () => api.get('/estoque').then(r => r.data),
    staleTime: 60000,
  })
  const estoquePorCodigo: Record<string, any> = {}
  for (const i of (estoque?.itens || [])) estoquePorCodigo[i.codigo] = i

  const mutation = useMutation({
    mutationFn: () => api.patch(`/pedidos/${pedido.id}/itens`, {
      itens: itens.map(i => ({ produto_id: i.produto_id, qtd_solicitada: i.qtd, valor_unitario: i.valor || null })),
    }),
    onSuccess: () => {
      toast.success('Itens atualizados')
      qc.invalidateQueries({ queryKey: ['pedido', pedido.id] })
      onClose()
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao editar itens'),
  })

  const semEstoque = itens.filter(i => {
    const e = estoquePorCodigo[i.codigo]
    return e && Number(e.disponivel) < i.qtd
  })

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-2xl max-h-[90vh] flex flex-col">
        <div className="p-5 border-b flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-800">Editar itens — {pedido.numero_pedido}</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><XCircle size={20} /></button>
        </div>
        <div className="p-5 space-y-3 overflow-y-auto">
          <ItensPedido value={itens} onChange={setItens} comValor />

          {itens.length > 0 && (
            <div className="border border-gray-100 rounded-lg divide-y divide-gray-50">
              {itens.map(i => {
                const e = estoquePorCodigo[i.codigo]
                const falta = e && Number(e.disponivel) < i.qtd
                if (!e) return null
                return (
                  <div key={i.produto_id} className={`px-3 py-1.5 text-xs flex items-center justify-between gap-2 ${falta ? 'bg-red-50' : ''}`}>
                    <span className="font-mono text-gray-600">{i.codigo}</span>
                    <span className={falta ? 'text-red-700 font-medium' : 'text-gray-500'}>
                      {falta ? `⚠ estoque insuficiente — ` : ''}disponível {e.disponivel} · pedido {i.qtd}
                    </span>
                  </div>
                )
              })}
            </div>
          )}
          {semEstoque.length > 0 && (
            <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {semEstoque.length} item(ns) com estoque insuficiente para a quantidade pedida.
              Dá para salvar assim mesmo (o estoque pode chegar), mas confira antes.
            </p>
          )}
        </div>
        <div className="p-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
          <button onClick={() => mutation.mutate()} disabled={itens.length === 0 || mutation.isPending}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
            {mutation.isPending ? 'Salvando…' : 'Salvar itens'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── OV vinda do CRM: completar número real e data ────────────────────────────
/** Banner fixo (não modal) para o único passo que falta numa OV que nasceu de
 *  oportunidade ganha no CRM: cliente e valor já vieram prontos, falta o
 *  número real do D365 e a data prevista — quem tem essa informação é a
 *  operadora, não o comercial. Fica sempre visível porque é a primeira coisa
 *  que precisa acontecer nesta OV, não algo atrás de um clique a mais. */
function FormCompletarDadosOV({ pedido, onCompletado }: { pedido: Pedido; onCompletado: () => void }) {
  // Venda outbound (lançada direto pelo comercial) já vem com frete, data e
  // local preenchidos — só falta o número real da OV. Vinda do CRM não tem
  // nada disso ainda. Pré-carrega o que já existe em vez de pedir de novo.
  const ehOutbound = pedido.numero_pedido?.startsWith('OUT-')
  const [numero, setNumero] = useState('')
  const [data, setData] = useState(pedido.data_prevista_entrega || '')
  const [tipoFrete, setTipoFrete] = useState<'FOB' | 'CIF_COM_VALOR' | 'CIF_SEM_VALOR'>(
    (pedido.tipo_frete as any) || 'FOB'
  )
  const [local, setLocal] = useState(pedido.local_entrega || '')
  const hoje = new Date().toISOString().slice(0, 10)

  const mutation = useMutation({
    mutationFn: () => api.patch(`/pedidos/${pedido.id}/completar-dados-crm`, {
      numero_pedido: numero.trim().toUpperCase(),
      data_prevista_entrega: data,
      tipo_frete: tipoFrete,
      local_entrega: local || null,
    }),
    onSuccess: () => {
      toast.success(`OV ${numero.trim().toUpperCase()} liberada`)
      onCompletado()
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao completar a OV'),
  })

  const valido = numero.trim() && data

  return (
    <div className="bg-blue-50 border-2 border-blue-200 rounded-xl p-5 mb-5">
      <p className="text-sm font-bold text-blue-900 flex items-center gap-1.5">
        🆕 {ehOutbound ? 'Venda outbound lançada pelo comercial — complete a OV' : 'Venda ganha no CRM — complete a OV'}
      </p>
      <p className="text-xs text-blue-700 mt-0.5">
        {ehOutbound
          ? 'Cliente, frete, data e local já vieram preenchidos pelo comercial (confira e ajuste se precisar). Só falta emitir a OV no D365 e informar o número real para liberar esta venda no fluxo normal da Expedição.'
          : 'Cliente e valor já vieram do CRM. Emita a OV no D365 e informe o número real e a data de entrega para liberar esta venda no fluxo normal da Expedição.'}
      </p>
      <div className="grid grid-cols-2 gap-3 mt-3">
        <div>
          <label className="text-sm font-medium text-gray-700">Número da OV (D365) *</label>
          <input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} autoFocus
            className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1 font-mono" placeholder="Ex: OV015500" />
        </div>
        <div>
          <label className="text-sm font-medium text-gray-700">Data prevista de entrega *</label>
          <input type="date" value={data} min={hoje} onChange={e => setData(e.target.value)}
            className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" />
        </div>
        <div>
          <label className="text-sm font-medium text-gray-700">Tipo de frete</label>
          <select value={tipoFrete} onChange={e => setTipoFrete(e.target.value as any)}
            className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1">
            <option value="FOB">FOB</option>
            <option value="CIF_COM_VALOR">CIF com Valor NF</option>
            <option value="CIF_SEM_VALOR">CIF sem Valor NF</option>
          </select>
        </div>
        <div>
          <label className="text-sm font-medium text-gray-700">Local de entrega</label>
          <LocalEntregaInput value={local} onChange={setLocal} />
        </div>
      </div>
      <button onClick={() => mutation.mutate()} disabled={!valido || mutation.isPending}
        className="mt-3 px-4 py-2.5 bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white text-sm font-medium rounded-lg">
        {mutation.isPending ? 'Liberando…' : 'Liberar OV'}
      </button>
    </div>
  )
}

function BotaoGerarOrcamento({ pedido }: { pedido: Pedido }) {
  const itensOV = ((pedido.itens || []) as any[]).filter(it => (it.produtos?.codigo || it.produto?.codigo))

  const mutation = useMutation({
    mutationFn: () => api.post('/crm/cotacoes', {
      cliente_id: pedido.cliente_id,
      cliente_cnpj: pedido.cliente?.cnpj || null,
      canal: pedido.canal || null,
      itens: itensOV.map((it: any) => ({
        produto_id: it.produto_id,
        codigo: it.produtos?.codigo || it.produto?.codigo,
        descricao: it.produtos?.descricao || it.produto?.descricao,
        qtd: Number(it.qtd_solicitada) || 0,
        valor_unitario: Number(it.valor_unitario) || 0,
      })),
    }),
    onSuccess: (res) => {
      toast.success(`Orçamento ${res.data?.numero} gerado`)
      if (res.data?.id) window.open(`/crm/cotacao/${res.data.id}/imprimir`, '_blank')
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao gerar orçamento'),
  })

  return (
    <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !pedido.cliente_id || itensOV.length === 0}
      className="flex items-center gap-1 text-xs text-blue-600 hover:underline disabled:opacity-50 disabled:no-underline"
      title="Gera um orçamento imprimível com o cliente e os itens desta OV">
      <FileText size={12} /> {mutation.isPending ? 'Gerando…' : 'Gerar orçamento'}
    </button>
  )
}

export function PedidoDetalhe() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const qc = useQueryClient()
  const [modal, setModal] = useState<'inventario' | 'verificacao' | 'cubagem' | 'cotacao_frete' | 'transportadora_cliente' | 'faturamento' | 'divergencia' | 'pallet' | 'transportadora' | 'tipo_frete' | 'cancelar' | 'reativar' | 'retornar' | 'confirmar_coleta' | 'editar_itens' | null>(null)
  const [nf, setNf] = useState('')
  const [valorNf, setValorNf] = useState('')
  const [valorProdutos, setValorProdutos] = useState('')
  const [valorFrete, setValorFrete] = useState('')
  const [novaDataEntrega, setNovaDataEntrega] = useState('')
  const [codigoRastreio, setCodigoRastreio] = useState('')
  const [reimprimindoEspelho, setReimprimindoEspelho] = useState(false)

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
    enabled: !!id && !!pedido && ['EM_PROCESSO_SISTEMICO', 'EM_COTACAO_FRETE', 'AGUARD_TRANSPORTADORA', 'AGUARD_FATURAMENTO', 'FATURADO', 'AGUARD_COLETA', 'EXPEDIDO'].includes(pedido?.status || ''),
  })

  const { data: movimentacoes = [] } = useQuery<Array<{ status_anterior: string | null; status_novo: string; observacao: string | null; criado_em: string }>>({
    queryKey: ['movimentacoes', id],
    queryFn: () => api.get(`/pedidos/${id}/movimentacoes`).then(r => r.data),
    enabled: !!id && !!pedido,
  })

  // Família de remessas (original + derivadas) — carrega se houver remessa_numero ou pedido_pai_id
  const temFamilia = !!(pedido?.pedido_pai_id || (pedido?.remessa_numero && pedido.remessa_numero > 1))
  const { data: familia = [] } = useQuery<any[]>({
    queryKey: ['familia', pedido?.numero_pedido],
    queryFn: () => api.get(`/pedidos/familia/${pedido!.numero_pedido}`).then(r => r.data),
    enabled: !!pedido && (temFamilia || false),
  })

  // Referência histórica de NF do cliente — base do alerta anti-erro de digitação
  const { data: refNf } = useQuery<{ qtd: number; mediana: number | null; media: number | null; maximo: number | null }>({
    queryKey: ['ref-nf', pedido?.cliente_id],
    queryFn: () => api.get('/pedidos/faturamento/referencia', { params: { cliente_id: pedido!.cliente_id } }).then(r => r.data),
    enabled: !!pedido?.cliente_id && modal === 'faturamento',
  })

  const isCIF = pedido?.tipo_frete === 'CIF_COM_VALOR' || pedido?.tipo_frete === 'CIF_SEM_VALOR'

  // Para CIF: valor_nf = valor_produtos + valor_frete
  const valorNfCalculado = isCIF
    ? ((Number(valorProdutos) || 0) + (Number(valorFrete) || 0))
    : (valorNf ? Number(valorNf) : null)

  const isCorreios = pedido?.transportadora?.nome === 'CORREIOS'

  // Alerta anti-erro: valor da NF muito acima do padrão do cliente (>=5x a mediana)
  const alertaValorNf = (valorNfCalculado && refNf && refNf.qtd >= 3 && refNf.mediana
    && valorNfCalculado >= refNf.mediana * 5) ? refNf : null

  // Sugestão automática do valor: Σ qtd × preço herdado da origem (cotação/
  // oportunidade/contrato). Só quando TODOS os itens têm preço — senão fica nulo.
  const itensPedido: any[] = (pedido as any)?.itens || []
  const sugestaoProdutos = itensPedido.length > 0
    && itensPedido.every(i => Number(i.valor_unitario) > 0 && Number(i.qtd_solicitada) > 0)
    ? itensPedido.reduce((s, i) => s + Number(i.qtd_solicitada) * Number(i.valor_unitario), 0)
    : null

  // Ao abrir o faturamento, pré-preenche valores conhecidos (sempre editáveis).
  useEffect(() => {
    if (modal !== 'faturamento' || !pedido) return
    if (isCIF) {
      if (!valorProdutos && sugestaoProdutos) setValorProdutos(sugestaoProdutos.toFixed(2))
      if (!valorFrete && (pedido as any).valor_frete) setValorFrete(String((pedido as any).valor_frete))
    } else if (!valorNf && sugestaoProdutos) {
      setValorNf(sugestaoProdutos.toFixed(2))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [modal, pedido?.id])

  const faturarMutation = useMutation({
    mutationFn: () => api.post(`/pedidos/${id}/faturamento`, {
      numero_nf: nf,
      valor_nf: valorNfCalculado || null,
      valor_produtos: isCIF && valorProdutos ? Number(valorProdutos) : null,
      valor_frete: isCIF && valorFrete ? Number(valorFrete) : null,
      data_prevista_entrega: novaDataEntrega || null,
      codigo_rastreio: isCorreios && codigoRastreio.trim() ? codigoRastreio.trim() : undefined,
    }),
    onSuccess: async () => {
      toast.success('NF registrada!')
      qc.invalidateQueries({ queryKey: ['pedido', id] })
      // Imprime espelhos de carga — quantidade vem da cubagem (1 por caixa)
      const qtdEspelhos = cubagem?.num_caixas ?? 1
      try {
        await api.post('/impressao', {
          tipo:          'espelho',
          numero_nf:     nf,
          numero_pedido: pedido?.numero_pedido || '',
          caixa:         1,
          total_caixas:  qtdEspelhos,
          data:          new Date().toISOString(),
        })
        toast.success(`🖨 ${qtdEspelhos} espelho(s) enviados para impressão`)
      } catch (err: any) {
        console.error('[Impressao espelho] Erro:', err)
        toast.error('Erro ao enviar para impressão — verifique o Print Agent')
      }
      setModal(null)
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || 'Erro'),
  })

  const alterarStatusMutation = useMutation({
    mutationFn: ({ novo_status, observacao }: { novo_status: string; observacao?: string }) =>
      api.patch(`/pedidos/${id}/status`, { novo_status, observacao }),
    onSuccess: () => {
      toast.success('Status atualizado!')
      qc.invalidateQueries({ queryKey: ['pedido', id] })
      qc.invalidateQueries({ queryKey: ['pedidos'] })
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || 'Erro ao alterar status'),
  })

  if (isLoading) return <div className="p-8 text-center text-gray-400">Carregando...</div>
  if (!pedido) return <div className="p-8 text-center text-gray-400">Pedido não encontrado</div>

  const status = pedido.status
  const SLA_HORAS = 2
  const STATUSES_SEPARACAO = ['AGUARD_CREDITO','LIBERADO','EM_INVENTARIO','AGUARD_VERIFICACAO','DIVERGENCIA','AGUARD_TRATATIVA','EM_PROCESSO_SISTEMICO']
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
    // CIF passa por Cotação de frete; FOB fica aguardando a transportadora do cliente.
    ...(isCIF
      ? [{ key: 'EM_COTACAO_FRETE', label: 'Cotação de Frete', icone: '🚚' }]
      : [{ key: 'AGUARD_TRANSPORTADORA', label: 'Transportadora', icone: '📥' }]),
    { key: 'AGUARD_FATURAMENTO', label: 'Faturamento', icone: '🧾' },
    { key: 'FATURADO', label: 'Pallet', icone: '📦' },
    { key: 'EXPEDIDO', label: 'Expedido', icone: '✅' },
  ]
  const ORDEM = ETAPAS.map(e => e.key)
  const idxAtual = ORDEM.indexOf(status)

  // Timestamp da 1ª vez que cada status foi atingido (movimentacoes vem ordenado asc)
  const primeiraOcorrencia: Record<string, string> = {}
  for (const m of movimentacoes) {
    if (m.status_novo && !(m.status_novo in primeiraOcorrencia)) primeiraOcorrencia[m.status_novo] = m.criado_em
  }
  const tsEtapa = (key: string): Date | null => {
    const t = key === 'LIBERADO' ? (primeiraOcorrencia['LIBERADO'] || pedido.criado_em) : primeiraOcorrencia[key]
    return t ? new Date(t) : null
  }
  const fmtDuracao = (ms: number): string => {
    const min = Math.round(ms / 60000)
    if (min < 1) return '<1min'
    if (min < 60) return `${min}min`
    const h = Math.floor(min / 60), rm = min % 60
    if (h < 24) return rm ? `${h}h ${rm}min` : `${h}h`
    const d = Math.floor(h / 24), rh = h % 24
    return rh ? `${d}d ${rh}h` : `${d}d`
  }
  // Duração da transição entre a etapa i e a i+1 (null se alguma não tiver timestamp)
  const duracaoEntre = (i: number): string | null => {
    const a = tsEtapa(ORDEM[i]), b = tsEtapa(ORDEM[i + 1])
    if (!a || !b) return null
    const ms = b.getTime() - a.getTime()
    return ms >= 0 ? fmtDuracao(ms) : null
  }

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
            {(pedido.remessa_numero ?? 1) > 1 && (
              <span className="bg-purple-100 text-purple-700 text-sm font-bold px-2.5 py-1 rounded-full">
                Remessa R{pedido.remessa_numero}
              </span>
            )}
            {pedido.atrasado && <span className="bg-red-100 text-red-700 text-xs font-bold px-2 py-1 rounded-full">⚠ ATRASADO</span>}
            <span className="text-sm text-gray-500">{TIPO_FRETE_LABEL[pedido.tipo_frete || 'FOB']}</span>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <StatusBadge status={pedido.status} />
            <PrioridadeBadge prioridade={pedido.prioridade} />
          </div>
        </div>
      </div>

      {/* OV vinda de oportunidade ganha no CRM: falta o número real (D365) e a
          data — sem isso a OV não avança nenhuma etapa. Fica sempre visível, não
          atrás de um clique, porque é o primeiro coisa que precisa acontecer. */}
      {status === 'AGUARD_DADOS_OV' && (
        <FormCompletarDadosOV pedido={pedido} onCompletado={() => qc.invalidateQueries({ queryKey: ['pedido', id] })} />
      )}

      {/* Família de remessas */}
      {temFamilia && familia.length > 1 && (
        <div className="bg-purple-50 border border-purple-200 rounded-xl p-4 mb-5">
          <p className="text-xs font-bold text-purple-700 uppercase tracking-wide mb-2">📦 Remessas desta OV</p>
          <div className="flex flex-wrap gap-2">
            {familia.map((r: any) => {
              const isAtual = r.id === id
              const label = (r.remessa_numero ?? 1) === 1 ? 'Original' : `R${r.remessa_numero}`
              const statusColors: Record<string, string> = {
                LIBERADO: 'text-blue-700', EXPEDIDO: 'text-green-700', CANCELADO: 'text-gray-400',
                FATURADO: 'text-indigo-700', AGUARD_COLETA: 'text-amber-700',
              }
              const cor = statusColors[r.status] || 'text-gray-600'
              return (
                <button
                  key={r.id}
                  onClick={() => !isAtual && navigate(`/expedicao/${r.id}`)}
                  disabled={isAtual}
                  className={`flex items-center gap-2 px-3 py-2 rounded-lg border text-sm transition-colors ${
                    isAtual
                      ? 'bg-purple-100 border-purple-400 font-bold text-purple-800 cursor-default'
                      : 'bg-white border-purple-200 hover:border-purple-400 cursor-pointer'
                  }`}
                >
                  <span className="font-semibold">{label}</span>
                  {r.numero_nf && <span className="text-xs text-gray-500">NF {r.numero_nf}</span>}
                  <span className={`text-xs font-medium ${cor}`}>{r.status}</span>
                  {isAtual && <span className="text-xs text-purple-500">← você está aqui</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}

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
                {i < ETAPAS.length - 1 && (() => {
                  const dur = duracaoEntre(i)
                  return (
                    <div className="relative w-16 mb-4">
                      <div className={`h-0.5 w-full ${concluido ? 'bg-green-400' : 'bg-gray-200'}`} />
                      {dur && (
                        <span className={`absolute -top-4 left-1/2 -translate-x-1/2 text-[10px] leading-none whitespace-nowrap ${
                          concluido ? 'text-gray-500' : 'text-blue-600 font-medium'
                        }`}>
                          {dur}
                        </span>
                      )}
                    </div>
                  )
                })()}
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
            {pedido.cliente?.cnpj && <Linha label="CNPJ" valor={formatarCnpjExibicao(pedido.cliente.cnpj)} />}
            <Linha label="Tipo de Operação" valor={pedido.tipo_operacao ? (OPERACAO_LABEL[pedido.tipo_operacao] || pedido.tipo_operacao) : null} />
            <Linha label="Canal de Venda" valor={pedido.canal ? (CANAL_LABEL[pedido.canal] || pedido.canal) : null} />
            <div className="flex justify-between items-center py-2 border-b border-gray-50">
              <span className="text-sm text-gray-500">Tipo de Frete</span>
              <button onClick={() => setModal('tipo_frete')}
                className="flex items-center gap-1.5 text-sm text-gray-900 font-medium hover:text-blue-600 group"
                title="Alterar tipo de frete">
                {TIPO_FRETE_LABEL[pedido.tipo_frete || 'FOB']}
                <Pencil size={14} className="text-gray-400 group-hover:text-blue-500" />
              </button>
            </div>
            <Linha label="Local de Entrega" valor={pedido.local_entrega} />
            <Linha label="Entrega Prevista" valor={
              pedido.data_prevista_entrega
                ? new Date(pedido.data_prevista_entrega + 'T12:00:00').toLocaleDateString('pt-BR')
                : null
            } />
            <Linha label="Transportadora" valor={pedido.transportadora?.nome || pedido.transportadora_nome} />
            <Linha label="NF" valor={pedido.numero_nf} />
            {pedido.codigo_rastreio && (
              <Linha label="📮 Rastreio" valor={pedido.codigo_rastreio} />
            )}
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
            {(() => {
              const lic = (pedido as any).licitacao
              if (!lic || (!lic.numero_pregao && !lic.numero_empenho)) return null
              return (
                <div className="mt-3 pt-3 border-t border-gray-100">
                  <p className="text-xs font-semibold text-gray-500 uppercase tracking-wide mb-1.5">🏛️ Licitação — para localizar no e-mail</p>
                  {lic.numero_pregao && (
                    <div className="flex justify-between items-center py-1.5 border-b border-gray-50">
                      <span className="text-sm text-gray-500">Pregão</span>
                      <button onClick={() => { navigator.clipboard.writeText(lic.numero_pregao); toast.success('Pregão copiado!') }}
                        className="text-sm font-mono font-semibold text-gray-900 hover:text-blue-600" title="Copiar nº do pregão">
                        {lic.numero_pregao}
                      </button>
                    </div>
                  )}
                  {lic.numero_empenho && (
                    <div className="flex justify-between items-center py-1.5">
                      <span className="text-sm text-gray-500">Empenho / NE</span>
                      <button onClick={() => { navigator.clipboard.writeText(lic.numero_empenho); toast.success('Empenho copiado!') }}
                        className="text-sm font-mono font-semibold text-gray-900 hover:text-blue-600" title="Copiar nº do empenho/NE">
                        {lic.numero_empenho}
                      </button>
                    </div>
                  )}
                </div>
              )
            })()}
          </div>

          {/* Itens da OV — editável até faturar (depois disso o item é o que
              está na NF). Caso concreto que motivou isto: item sem estoque
              trocado por outro antes de faturar. */}
          {(() => {
            const itensOV = ((pedido.itens || []) as any[]).filter(it => (it.produtos?.codigo || it.produto?.codigo))
            const totalUn = itensOV.reduce((a, it) => a + (Number(it.qtd_solicitada) || 0), 0)
            const comValor = itensOV.some(it => Number(it.valor_unitario) > 0)
            const totalValor = itensOV.reduce((a, it) => a + (Number(it.qtd_solicitada) || 0) * (Number(it.valor_unitario) || 0), 0)
            const brl = (n: number) => n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
            const STATUS_ITENS_TRAVADOS = ['FATURADO', 'AGUARD_COLETA', 'COLETADO', 'EXPEDIDO', 'CANCELADO']
            const editavel = !STATUS_ITENS_TRAVADOS.includes(status)
            return (
              <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
                <div className="flex items-center justify-between mb-3">
                  <h2 className="font-semibold text-gray-800">Itens da OV</h2>
                  <div className="flex items-center gap-3">
                    <BotaoGerarOrcamento pedido={pedido} />
                    {editavel ? (
                      <button onClick={() => setModal('editar_itens')}
                        className="flex items-center gap-1 text-xs text-blue-600 hover:underline">
                        <Pencil size={12} /> Editar itens
                      </button>
                    ) : (
                      <span className="text-[11px] text-gray-400" title="Depois de faturada, o item é o que está na NF">
                        🔒 travado (faturada)
                      </span>
                    )}
                  </div>
                </div>
                {itensOV.length === 0 ? (
                  <p className="text-sm text-gray-400">Nenhum item cadastrado ainda.</p>
                ) : (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead>
                        <tr className="text-left text-gray-500 border-b">
                          <th className="pb-2 pr-3">Código</th>
                          <th className="pb-2 pr-3">Descrição</th>
                          <th className="pb-2 text-right">Qtd</th>
                          {comValor && <th className="pb-2 pl-3 text-right">Valor un.</th>}
                          {comValor && <th className="pb-2 pl-3 text-right">Total</th>}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-50">
                        {itensOV.map((it, i) => (
                          <tr key={i}>
                            <td className="py-2 pr-3 font-mono font-medium text-gray-800">{it.produtos?.codigo || it.produto?.codigo}</td>
                            <td className="py-2 pr-3 text-gray-600">{it.produtos?.descricao || it.produto?.descricao || '—'}</td>
                            <td className="py-2 text-right tabular-nums text-gray-800">{Number(it.qtd_solicitada) || 0}</td>
                            {comValor && <td className="py-2 pl-3 text-right tabular-nums text-gray-600">{Number(it.valor_unitario) > 0 ? brl(Number(it.valor_unitario)) : '—'}</td>}
                            {comValor && <td className="py-2 pl-3 text-right tabular-nums text-gray-800 font-medium">{Number(it.valor_unitario) > 0 ? brl((Number(it.qtd_solicitada) || 0) * Number(it.valor_unitario)) : '—'}</td>}
                          </tr>
                        ))}
                      </tbody>
                      <tfoot>
                        <tr className="border-t">
                          <td className="pt-2 text-xs text-gray-400" colSpan={2}>{itensOV.length} item(ns)</td>
                          <td className="pt-2 text-right text-xs text-gray-500">Total: <strong className="text-gray-700">{totalUn}</strong> un</td>
                          {comValor && <td className="pt-2" />}
                          {comValor && <td className="pt-2 text-right text-xs text-gray-500">Total: <strong className="text-gray-700">{brl(totalValor)}</strong></td>}
                        </tr>
                      </tfoot>
                    </table>
                  </div>
                )}
              </div>
            )
          })()}

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
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-x-6">
                    {cubagem.num_caixas != null && <Linha label="Volumes" valor={`${cubagem.num_caixas} caixa(s)`} />}
                    {cubagem.peso_kg != null && <Linha label="Peso total" valor={`${cubagem.peso_kg} kg`} />}
                    {cubagem.altura_cm != null && <Linha label="Altura" valor={`${cubagem.altura_cm} cm`} />}
                    {cubagem.largura_cm != null && <Linha label="Largura" valor={`${cubagem.largura_cm} cm`} />}
                    {cubagem.comprimento_cm != null && <Linha label="Comprimento" valor={`${cubagem.comprimento_cm} cm`} />}
                  </div>
                  {(cubagem as any).mensagem_teams && (
                    <div className="mt-2">
                      <div className="flex items-center justify-between mb-1">
                        <p className="text-xs font-medium text-gray-500 uppercase tracking-wide">Mensagem para o Teams</p>
                        <button
                          onClick={() => {
                            navigator.clipboard.writeText((cubagem as any).mensagem_teams)
                            toast.success('Copiado!')
                          }}
                          className="text-xs text-blue-600 hover:underline"
                        >
                          Copiar
                        </button>
                      </div>
                      <pre className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-gray-700 whitespace-pre-wrap font-sans">
                        {(cubagem as any).mensagem_teams}
                      </pre>
                    </div>
                  )}
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

          {/* Histórico da OV — cada mudança de status com a observação registrada
              no momento (ex.: tudo que o comercial preencheu ao lançar a venda),
              não só os campos atuais (que podem ter sido editados depois). */}
          {movimentacoes.length > 0 && (
            <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
              <h2 className="font-semibold text-gray-800 mb-3">Histórico da OV</h2>
              <div className="space-y-3">
                {movimentacoes.map((m, i) => (
                  <div key={i} className="pb-3 border-b border-gray-50 last:border-0 last:pb-0">
                    <div className="flex items-center justify-between">
                      <p className="text-sm font-medium text-gray-800">
                        {m.status_anterior ? `${STATUS_CONFIG[m.status_anterior as keyof typeof STATUS_CONFIG]?.label || m.status_anterior} → ` : ''}
                        {STATUS_CONFIG[m.status_novo as keyof typeof STATUS_CONFIG]?.label || m.status_novo}
                      </p>
                      <span className="text-xs text-gray-400 whitespace-nowrap ml-3">
                        {format(new Date(m.criado_em), 'dd/MM/yyyy HH:mm', { locale: ptBR })}
                      </span>
                    </div>
                    {m.observacao && (
                      <p className="text-xs text-gray-500 mt-1 whitespace-pre-line">{m.observacao}</p>
                    )}
                  </div>
                ))}
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

              {/* Corrigir tipo de frete — registra ocorrência */}
              {!['CANCELADO'].includes(status) && (
                <button onClick={() => setModal('tipo_frete')}
                  className="w-full flex items-center gap-2 justify-center py-2 border border-blue-300 text-blue-600 rounded-lg text-sm hover:bg-blue-50">
                  🚚 Corrigir Frete
                </button>
              )}

              {status === 'AGUARD_CREDITO' && (
                <button
                  onClick={() => alterarStatusMutation.mutate({ novo_status: 'LIBERADO', observacao: 'Crédito aprovado — OV liberada para separação' })}
                  disabled={alterarStatusMutation.isPending}
                  className="w-full flex items-center gap-2 justify-center py-3 bg-yellow-600 text-white rounded-lg font-medium hover:bg-yellow-500 disabled:opacity-50"
                >
                  ✅ Crédito Aprovado — Liberar para Separação
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

              {status === 'EM_COTACAO_FRETE' && (
                <button onClick={() => setModal('cotacao_frete')}
                  className="w-full flex items-center gap-2 justify-center py-3 bg-amber-600 text-white rounded-lg font-medium hover:bg-amber-500">
                  <Truck size={16} /> Registrar cotação de frete
                </button>
              )}

              {status === 'AGUARD_TRANSPORTADORA' && (
                <button onClick={() => setModal('transportadora_cliente')}
                  className="w-full flex items-center gap-2 justify-center py-3 bg-orange-600 text-white rounded-lg font-medium hover:bg-orange-500">
                  <Truck size={16} /> Registrar transportadora do cliente
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

              {/* Reimprimir espelhos — fallback quando a impressão falhou na hora do registro */}
              {['FATURADO', 'AGUARD_COLETA', 'EXPEDIDO'].includes(status) && pedido.numero_nf && (
                <button
                  onClick={async () => {
                    try {
                      setReimprimindoEspelho(true)
                      const qtd = cubagem?.num_caixas ?? 1
                      await api.post('/impressao', {
                        tipo:          'espelho',
                        numero_nf:     pedido.numero_nf,
                        numero_pedido: pedido.numero_pedido,
                        caixa:         1,
                        total_caixas:  qtd,
                        data:          new Date().toISOString(),
                      })
                      toast.success(`🖨 ${qtd} espelho(s) enviados para reimpressão`)
                    } catch {
                      toast.error('Erro ao reimprimir — verifique o Print Agent')
                    } finally {
                      setReimprimindoEspelho(false)
                    }
                  }}
                  disabled={reimprimindoEspelho}
                  className="w-full flex items-center gap-2 justify-center py-2 border border-gray-300 text-gray-600 rounded-lg text-sm hover:bg-gray-50 disabled:opacity-50"
                >
                  🖨 Reimprimir Espelhos{cubagem?.num_caixas ? ` (${cubagem.num_caixas} cx)` : ''}
                </button>
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
            <div className="space-y-2">
              <div className="bg-gray-100 rounded-xl p-3 text-center text-sm text-gray-500">
                ❌ OV Cancelada
              </div>
              <button
                onClick={() => setModal('reativar')}
                className="w-full py-2.5 border-2 border-blue-200 text-blue-600 rounded-lg text-sm font-medium hover:bg-blue-50 hover:border-blue-400 transition-colors"
              >
                ↩️ Reativar OV
              </button>
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
      {modal === 'tipo_frete' && <ModalAlterarTipoFrete pedido={pedido} onClose={() => setModal(null)} />}
      {modal === 'cancelar' && <ModalCancelarOV pedido={pedido} onClose={() => setModal(null)} />}
      {modal === 'reativar' && <ModalReativarOV pedido={pedido} onClose={() => setModal(null)} />}
      {modal === 'retornar' && <ModalRetornarEtapa pedido={pedido} onClose={() => setModal(null)} />}
      {modal === 'confirmar_coleta' && <ModalConfirmarColeta pedido={pedido} onClose={() => setModal(null)} />}
      {modal === 'editar_itens' && <ModalEditarItens pedido={pedido} onClose={() => setModal(null)} />}
      {modal === 'cotacao_frete' && <ModalCotacaoFrete pedido={pedido} onClose={() => setModal(null)} />}
      {modal === 'transportadora_cliente' && <ModalTransportadoraCliente pedido={pedido} onClose={() => setModal(null)} />}
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

              {/* Código de rastreio — só Correios */}
              {isCorreios && (
                <div className="bg-yellow-50 border border-yellow-200 rounded-xl p-4 space-y-1">
                  <label className="text-sm font-semibold text-yellow-800">
                    📮 Código de Rastreio (Correios)
                  </label>
                  <input
                    type="text"
                    value={codigoRastreio}
                    onChange={e => setCodigoRastreio(e.target.value.toUpperCase())}
                    className="w-full border border-yellow-300 rounded-lg px-3 py-2.5 text-sm mt-1 font-mono focus:outline-none focus:ring-2 focus:ring-yellow-400"
                    placeholder="AA000000000BR"
                  />
                  <p className="text-xs text-yellow-600">Cartão de postagem para rastreamento</p>
                </div>
              )}

              {/* FOB — campo único */}
              {!isCIF && (
                <div>
                  <label className="text-sm text-gray-600">Valor da NF (R$)</label>
                  <input type="number" step="0.01" value={valorNf} onChange={e => setValorNf(e.target.value)}
                    className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" placeholder="0,00" />
                  {sugestaoProdutos != null && (
                    <p className="text-xs text-blue-500 mt-1">💡 Sugerido pelos preços da origem (cotação/contrato): R$ {sugestaoProdutos.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} — confirme com a NF do D365.</p>
                  )}
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
                    {sugestaoProdutos != null && (
                      <p className="text-xs text-blue-500 mt-1">💡 Sugerido pelos preços da origem: R$ {sugestaoProdutos.toLocaleString('pt-BR', { minimumFractionDigits: 2 })} — confirme com a NF do D365.</p>
                    )}
                  </div>
                  <div>
                    <label className="text-sm font-medium text-gray-700">🚛 Custo do Frete (R$)</label>
                    <input type="number" step="0.01" value={valorFrete} onChange={e => setValorFrete(e.target.value)}
                      className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" placeholder="0,00" />
                    {(pedido as any).valor_frete != null && (
                      <p className="text-xs text-blue-500 mt-1">💡 Frete já informado antes (cotação/alteração): R$ {Number((pedido as any).valor_frete).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.</p>
                    )}
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
              {/* Alerta anti-erro de digitação */}
              {alertaValorNf && (
                <div className="bg-amber-50 border-2 border-amber-300 rounded-xl p-3">
                  <p className="text-sm font-semibold text-amber-800">⚠️ Valor bem acima do padrão deste cliente</p>
                  <p className="text-xs text-amber-700 mt-1">
                    Mediana das NFs deste cliente: <strong>R$ {Number(alertaValorNf.mediana).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</strong>
                    {' '}· máx: R$ {Number(alertaValorNf.maximo).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}.
                    Você digitou <strong>R$ {valorNfCalculado?.toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</strong>.
                    Confira se não há um dígito a mais.
                  </p>
                </div>
              )}

              {/* Espelhos de carga — automático pela cubagem */}
              <div className="border-t pt-4">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium text-gray-700">
                    🖨 Espelhos de carga
                    <span className="text-xs text-gray-400 font-normal ml-1">(1 por caixa)</span>
                  </p>
                  <span className={`text-sm font-bold ${cubagem?.num_caixas ? 'text-indigo-600' : 'text-gray-400'}`}>
                    {cubagem?.num_caixas ?? 1} etiqueta(s)
                  </span>
                </div>
                {cubagem?.num_caixas ? (
                  <p className="text-xs text-gray-400 mt-1">
                    Quantidade conforme cubagem registrada ({cubagem.num_caixas} caixa(s)).
                  </p>
                ) : (
                  <p className="text-xs text-amber-500 mt-1">
                    ⚠ Cubagem não registrada — será impressa 1 etiqueta. Registre a cubagem para imprimir o número correto.
                  </p>
                )}
              </div>
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

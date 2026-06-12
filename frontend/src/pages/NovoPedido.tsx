import { useState, useRef, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Search } from 'lucide-react'
import api from '../lib/api'
import type { Cliente, Transportadora } from '../types'
import toast from 'react-hot-toast'

function ClienteAutocomplete({ value, onChange }: { value: string; onChange: (id: string, nome: string) => void }) {
  const [busca, setBusca] = useState('')
  const [aberto, setAberto] = useState(false)
  const [nomeSelecionado, setNomeSelecionado] = useState(value ? '' : '')
  const ref = useRef<HTMLDivElement>(null)

  const { data: clientes = [] } = useQuery<Cliente[]>({
    queryKey: ['clientes-busca', busca],
    queryFn: () => api.get('/clientes', { params: busca ? { search: busca } : {} }).then(r => r.data),
    enabled: busca.length >= 2,
  })

  const clientesFiltrados = clientes
    .filter(c => c.nome.toLowerCase().includes(busca.toLowerCase()) || c.codigo.toLowerCase().includes(busca.toLowerCase()))
    .slice(0, 10)

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setAberto(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  const selecionar = (cliente: Cliente) => {
    setNomeSelecionado(cliente.nome)
    setBusca('')
    setAberto(false)
    onChange(cliente.id, cliente.nome)
  }

  return (
    <div ref={ref} className="relative">
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={nomeSelecionado || busca}
          onChange={e => {
            setBusca(e.target.value)
            setNomeSelecionado('')
            setAberto(true)
            if (!e.target.value) onChange('', '')
          }}
          onFocus={() => { if (busca.length >= 2) setAberto(true) }}
          placeholder="Digite o nome ou código do cliente..."
          className="w-full border rounded-lg pl-9 pr-4 py-2.5 text-sm mt-1"
        />
      </div>
      {aberto && busca.length >= 2 && (
        <div className="absolute z-50 w-full bg-white border border-gray-200 rounded-lg shadow-lg mt-1 max-h-60 overflow-y-auto">
          {clientesFiltrados.length === 0 ? (
            <div className="px-4 py-3 text-sm text-gray-400">Nenhum cliente encontrado</div>
          ) : clientesFiltrados.map(c => (
            <button key={c.id} onClick={() => selecionar(c)}
              className="w-full text-left px-4 py-2.5 hover:bg-blue-50 text-sm border-b border-gray-50 last:border-0">
              <span className="font-medium text-gray-800">{c.nome}</span>
              <span className="text-gray-400 text-xs ml-2">{c.codigo}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

export function NovoPedido() {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [form, setForm] = useState({
    numero_pedido: '',
    cliente_id: '',
    cliente_nome: '',
    transportadora_id: '',
    tipo_frete: 'FOB',
    local_entrega: '',
    data_prevista_entrega: '',
    prioridade: 'NORMAL',
    observacoes: '',
  })

  // Estado do modal de recriação de OV cancelada
  const [modalRecriar, setModalRecriar] = useState({
    visivel: false,
    motivo: '',
    confirmado: false,
  })

  const { data: transportadoras = [] } = useQuery<Transportadora[]>({
    queryKey: ['transportadoras'],
    queryFn: () => api.get('/transportadoras').then(r => r.data),
  })

  /** Monta o body base da requisição */
  const buildBody = (extra?: Record<string, unknown>) => ({
    ...form,
    transportadora_id: form.transportadora_id || null,
    itens: [],
    ...extra,
  })

  /** Criação normal */
  const mutation = useMutation({
    mutationFn: () => api.post('/pedidos', buildBody()),
    onSuccess: (res) => {
      toast.success('OV cadastrada!')
      qc.invalidateQueries({ queryKey: ['pedidos'] })
      navigate(`/expedicao/${res.data.id}`)
    },
    onError: (e: any) => {
      const status = e.response?.status
      const detail = e.response?.data?.detail

      // 409 + pode_recriar → OV foi cancelada; mostrar modal de confirmação
      if (status === 409 && detail?.pode_recriar) {
        setModalRecriar({ visivel: true, motivo: '', confirmado: false })
        return
      }

      // 409 sem pode_recriar → OV ainda ativa, não pode recriar
      if (status === 409) {
        toast.error(
          `OV ${form.numero_pedido} já existe (status: "${detail?.status_existente || 'ativo'}"). Não é possível recriar uma OV ativa.`
        )
        return
      }

      toast.error(typeof detail === 'string' ? detail : detail?.msg || 'Erro ao cadastrar OV')
    },
  })

  /** Recriação de OV cancelada — disparada após confirmação no modal */
  const mutationRecriar = useMutation({
    mutationFn: () => api.post('/pedidos', buildBody({
      forcar_duplicata: true,
      motivo_duplicata: modalRecriar.motivo.trim(),
    })),
    onSuccess: (res) => {
      toast.success(`✅ OV ${form.numero_pedido} recriada com sucesso!`)
      qc.invalidateQueries({ queryKey: ['pedidos'] })
      setModalRecriar({ visivel: false, motivo: '', confirmado: false })
      navigate(`/expedicao/${res.data.id}`)
    },
    onError: (e: any) => {
      const detail = e.response?.data?.detail
      toast.error(typeof detail === 'string' ? detail : 'Erro ao recriar OV')
    },
  })

  const podeEnviar = form.numero_pedido && form.cliente_id && form.data_prevista_entrega
  const podeConfirmarRecriar =
    modalRecriar.motivo.trim().length >= 5 && modalRecriar.confirmado

  const handleClienteChange = (id: string, nome: string) => {
    setForm(f => ({ ...f, cliente_id: id, cliente_nome: nome }))
  }

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <div className="flex items-center gap-3 mb-6">
        <button onClick={() => navigate(-1)} className="p-2 hover:bg-gray-100 rounded-lg">
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Nova OV</h1>
          <p className="text-sm text-gray-500">Registre a OV recebida via Teams</p>
        </div>
      </div>

      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 space-y-5">

        {/* Dica Teams */}
        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-700">
          💬 <strong>Dica:</strong> Copie o número da OV e o cliente da mensagem do Teams antes de preencher.
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="text-sm font-medium text-gray-700">Número da OV *</label>
            <input type="text" value={form.numero_pedido} onChange={e => setForm({...form, numero_pedido: e.target.value.toUpperCase()})}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1 font-mono"
              placeholder="Ex: OV015437" />
          </div>

          <div className="col-span-2">
            <label className="text-sm font-medium text-gray-700">Cliente *</label>
            <ClienteAutocomplete value={form.cliente_id} onChange={handleClienteChange} />
            {form.cliente_id && (
              <p className="text-xs text-green-600 mt-1">✅ {form.cliente_nome}</p>
            )}
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">Tipo de Frete *</label>
            <select value={form.tipo_frete} onChange={e => setForm({...form, tipo_frete: e.target.value})}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1">
              <option value="FOB">FOB</option>
              <option value="CIF_COM_VALOR">CIF com Valor NF</option>
              <option value="CIF_SEM_VALOR">CIF sem Valor NF</option>
            </select>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">Prioridade</label>
            <select value={form.prioridade} onChange={e => setForm({...form, prioridade: e.target.value})}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1">
              <option value="NORMAL">Normal</option>
              <option value="ALTA">Alta</option>
              <option value="CRITICA">🔴 Crítica</option>
            </select>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">Transportadora</label>
            <select value={form.transportadora_id} onChange={e => setForm({...form, transportadora_id: e.target.value})}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1">
              <option value="">A definir...</option>
              {transportadoras.map(t => <option key={t.id} value={t.id}>{t.nome}</option>)}
            </select>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">Data Prevista de Entrega *</label>
            <input type="date" value={form.data_prevista_entrega} onChange={e => setForm({...form, data_prevista_entrega: e.target.value})}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" />
          </div>

          <div className="col-span-2">
            <label className="text-sm font-medium text-gray-700">Local de Entrega</label>
            <input type="text" value={form.local_entrega} onChange={e => setForm({...form, local_entrega: e.target.value})}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1"
              placeholder="Ex: São Paulo SP" />
          </div>

          <div className="col-span-2">
            <label className="text-sm font-medium text-gray-700">Observações</label>
            <textarea rows={2} value={form.observacoes} onChange={e => setForm({...form, observacoes: e.target.value})}
              className="w-full border rounded-lg px-3 py-2 text-sm mt-1"
              placeholder="Ex: fazer cotação e faturar" />
          </div>
        </div>

        <div className="flex gap-3 pt-2">
          <button onClick={() => navigate(-1)} className="flex-1 py-3 border rounded-lg text-sm text-gray-600 hover:bg-gray-50">
            Cancelar
          </button>
          <button onClick={() => mutation.mutate()} disabled={mutation.isPending || !podeEnviar}
            className="flex-1 py-3 bg-blue-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-blue-500">
            {mutation.isPending ? 'Cadastrando...' : '✅ Cadastrar OV'}
          </button>
        </div>
      </div>

      {/* ── Modal: OV cancelada — confirmar recriação ── */}
      {modalRecriar.visivel && (
        <div className="fixed inset-0 bg-black bg-opacity-60 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md shadow-xl">

            {/* Header */}
            <div className="p-5 border-b bg-amber-50 rounded-t-2xl">
              <h2 className="text-lg font-bold text-amber-800">⚠ OV já cadastrada — Recriar?</h2>
              <p className="text-sm text-amber-700 mt-1">
                A OV <strong className="font-mono">{form.numero_pedido}</strong> foi{' '}
                <strong>cancelada anteriormente</strong>. Para reativá-la com os dados
                preenchidos, informe o motivo e confirme abaixo.
              </p>
            </div>

            {/* Body */}
            <div className="p-5 space-y-4">

              {/* Aviso de auditoria */}
              <div className="bg-gray-50 border border-gray-200 rounded-lg p-3 text-xs text-gray-600 space-y-1">
                <p>📋 <strong>O que acontecerá:</strong></p>
                <ul className="list-disc list-inside space-y-0.5 ml-1">
                  <li>A OV cancelada será <strong>reativada</strong> com os dados preenchidos</li>
                  <li>Uma <strong>ocorrência será registrada</strong> automaticamente com o motivo informado</li>
                  <li>O histórico de cancelamento será preservado</li>
                </ul>
              </div>

              {/* Motivo */}
              <div>
                <label className="text-sm font-semibold text-gray-700">
                  Motivo da recriação *
                </label>
                <textarea
                  rows={3}
                  value={modalRecriar.motivo}
                  onChange={e => setModalRecriar(prev => ({ ...prev, motivo: e.target.value }))}
                  placeholder="Ex: OV cancelada por engano — vendas confirmou que o pedido continua e deve ser reativado"
                  className="w-full border rounded-lg px-3 py-2 text-sm mt-1 focus:outline-none focus:ring-2 focus:ring-amber-400"
                  autoFocus
                />
                {modalRecriar.motivo.trim().length > 0 && modalRecriar.motivo.trim().length < 5 && (
                  <p className="text-xs text-red-500 mt-1">Descreva o motivo com mais detalhes (mín. 5 caracteres)</p>
                )}
              </div>

              {/* Checkbox de confirmação */}
              <label className={`flex items-start gap-3 p-3 rounded-xl border-2 cursor-pointer transition-colors ${
                modalRecriar.confirmado
                  ? 'border-amber-500 bg-amber-50'
                  : 'border-gray-200 hover:border-amber-300'
              }`}>
                <input
                  type="checkbox"
                  checked={modalRecriar.confirmado}
                  onChange={e => setModalRecriar(prev => ({ ...prev, confirmado: e.target.checked }))}
                  className="mt-0.5 w-4 h-4 accent-amber-600 flex-shrink-0"
                />
                <span className="text-sm text-gray-700">
                  Confirmo que a OV <strong className="font-mono">{form.numero_pedido}</strong> foi
                  cancelada por engano e que a recriação é <strong>intencional e autorizada</strong>
                </span>
              </label>
            </div>

            {/* Botões */}
            <div className="p-5 border-t flex gap-3">
              <button
                onClick={() => setModalRecriar({ visivel: false, motivo: '', confirmado: false })}
                className="flex-1 py-2.5 border rounded-lg text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancelar
              </button>
              <button
                onClick={() => mutationRecriar.mutate()}
                disabled={mutationRecriar.isPending || !podeConfirmarRecriar}
                className="flex-1 py-2.5 bg-amber-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50 hover:bg-amber-500 transition-colors"
              >
                {mutationRecriar.isPending ? 'Recriando...' : '✅ Confirmar Recriação'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

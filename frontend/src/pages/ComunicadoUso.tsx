import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, FileText } from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import { ClienteAutocomplete } from './NovoPedido'

export function ComunicadoUso() {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const hoje = new Date().toISOString().slice(0, 10)
  const [form, setForm] = useState({
    numero_pedido: '',
    cliente_id: '',
    cliente_nome: '',
    numero_nf: '',
    valor_nf: '',
    valor_produtos: '',
    canal: '',
    data_faturamento: hoje,
    observacoes: '',
  })

  const mutation = useMutation({
    mutationFn: () => api.post('/pedidos/comunicado-uso', {
      numero_pedido: form.numero_pedido.trim(),
      cliente_id: form.cliente_id,
      numero_nf: form.numero_nf.trim(),
      valor_nf: Number(form.valor_nf),
      canal: form.canal || null,
      valor_produtos: form.valor_produtos ? Number(form.valor_produtos) : null,
      data_faturamento: form.data_faturamento || null,
      observacoes: form.observacoes || null,
    }),
    onSuccess: () => {
      toast.success('Comunicado de uso faturado!')
      qc.invalidateQueries({ queryKey: ['pedidos'] })
      qc.invalidateQueries({ queryKey: ['financeiro'] })
      navigate('/dashboard')
    },
    onError: (e: any) => {
      const detail = e.response?.data?.detail
      toast.error(typeof detail === 'string' ? detail : 'Erro ao lançar comunicado de uso')
    },
  })

  const valido = form.numero_pedido.trim() && form.cliente_id && form.numero_nf.trim() && Number(form.valor_nf) > 0 && form.canal

  return (
    <div className="p-6 max-w-2xl mx-auto">
      <button onClick={() => navigate(-1)} className="flex items-center gap-1 text-sm text-gray-500 hover:text-gray-700 mb-4">
        <ArrowLeft size={16} /> Voltar
      </button>

      <div className="bg-white rounded-xl shadow-sm border border-gray-100 p-6">
        <div className="flex items-center gap-2 mb-1">
          <div className="p-2 bg-emerald-50 rounded-lg"><FileText size={18} className="text-emerald-600" /></div>
          <h1 className="text-lg font-bold text-gray-900">Comunicado de Uso</h1>
        </div>
        <p className="text-sm text-gray-500 mb-5">
          Faturamento de estoque consignado já utilizado pelo cliente. <strong>Não</strong> passa pela logística nem
          movimenta estoque — entra direto como faturado.
        </p>

        <div className="grid grid-cols-2 gap-4">
          <div>
            <label className="text-sm font-medium text-gray-700">Nº do Lançamento / OV *</label>
            <input type="text" value={form.numero_pedido}
              onChange={e => setForm({ ...form, numero_pedido: e.target.value.toUpperCase() })}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1 font-mono" placeholder="Ex: CU000123" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700">Data do Faturamento *</label>
            <input type="date" value={form.data_faturamento}
              onChange={e => setForm({ ...form, data_faturamento: e.target.value })}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" />
          </div>

          <div className="col-span-2">
            <label className="text-sm font-medium text-gray-700">Cliente *</label>
            <ClienteAutocomplete value={form.cliente_id}
              onChange={(id, nome) => setForm({ ...form, cliente_id: id, cliente_nome: nome })} />
            {form.cliente_id && <p className="text-xs text-green-600 mt-1">✅ {form.cliente_nome}</p>}
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">Número da NF *</label>
            <input type="text" value={form.numero_nf}
              onChange={e => setForm({ ...form, numero_nf: e.target.value })}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1 font-mono" placeholder="Ex: 20045" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700">Valor da NF (R$) *</label>
            <input type="number" step="0.01" value={form.valor_nf}
              onChange={e => setForm({ ...form, valor_nf: e.target.value })}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" placeholder="0,00" />
          </div>

          <div className="col-span-2">
            <label className="text-sm font-medium text-gray-700">Canal de Venda *</label>
            <select value={form.canal} onChange={e => setForm({ ...form, canal: e.target.value })}
              className={`w-full border rounded-lg px-3 py-2.5 text-sm mt-1 ${form.canal ? '' : 'border-amber-400 text-gray-400'}`}>
              <option value="" disabled>Selecione o canal…</option>
              <option value="URO">Uro</option>
              <option value="VASCULAR">Vascular</option>
              <option value="REALCLOSURE">Realclosure</option>
              <option value="LICITACAO_URO">Licitação - Uro</option>
              <option value="LICITACAO_VASCULAR">Licitação - Vascular</option>
            </select>
          </div>

          <div className="col-span-2">
            <label className="text-sm font-medium text-gray-700">Observações</label>
            <textarea rows={2} value={form.observacoes}
              onChange={e => setForm({ ...form, observacoes: e.target.value })}
              className="w-full border rounded-lg px-3 py-2 text-sm mt-1"
              placeholder="Ex: consumo referente ao consignado da OV..." />
          </div>
        </div>

        <button
          disabled={!valido || mutation.isPending}
          onClick={() => mutation.mutate()}
          className={`w-full mt-6 py-2.5 rounded-lg text-sm font-medium text-white transition-colors ${
            valido && !mutation.isPending ? 'bg-emerald-600 hover:bg-emerald-500' : 'bg-gray-300 cursor-not-allowed'
          }`}
        >
          {mutation.isPending ? 'Lançando...' : '✅ Faturar Comunicado de Uso'}
        </button>
      </div>
    </div>
  )
}

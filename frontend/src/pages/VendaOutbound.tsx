import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft } from 'lucide-react'
import api from '../lib/api'
import type { Transportadora } from '../types'
import toast from 'react-hot-toast'
import { ItensPedido, type ItemLinha } from '../components/ItensPedido'
import { LocalEntregaInput } from '../components/LocalEntregaInput'
import { ClienteAutocomplete } from './NovoPedido'

function formatarCnpj(v: string) {
  const d = v.replace(/\D/g, '').slice(0, 14)
  return d
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/\.(\d{3})(\d)/, '.$1/$2')
    .replace(/(\d{4})(\d)/, '$1-$2')
}

export function VendaOutbound() {
  const navigate = useNavigate()
  const qc = useQueryClient()

  const [form, setForm] = useState({
    cliente_id: '',
    cliente_nome: '',
    cliente_cnpj: '',
    transportadora_id: '',
    tipo_frete: 'FOB',
    tipo_operacao: '',
    canal: '',
    local_entrega: '',
    data_prevista_entrega: '',
    prioridade: 'NORMAL',
    observacoes: '',
  })

  const [itens, setItens] = useState<ItemLinha[]>([])

  const { data: transportadoras = [] } = useQuery<Transportadora[]>({
    queryKey: ['transportadoras'],
    queryFn: () => api.get('/transportadoras').then(r => r.data),
  })

  const mutation = useMutation({
    mutationFn: () => api.post('/pedidos/outbound', {
      ...form,
      transportadora_id: form.transportadora_id || null,
      canal: form.canal || null,
      itens: itens.map(i => ({ produto_id: i.produto_id, qtd_solicitada: i.qtd, valor_unitario: i.valor ?? null })),
    }),
    onSuccess: (res) => {
      toast.success('Venda outbound lançada! Aguardando operações completar o número da OV.')
      qc.invalidateQueries({ queryKey: ['pedidos'] })
      navigate(`/expedicao/${res.data.id}`)
    },
    onError: (e: any) => {
      const detail = e.response?.data?.detail
      const msg = typeof detail === 'string' ? detail
        : Array.isArray(detail) ? (detail[0]?.msg || JSON.stringify(detail[0]))
        : detail?.msg || 'Erro ao lançar a venda'
      toast.error(msg, { duration: 6000 })
    },
  })

  const cnpjValido = form.cliente_cnpj.replace(/\D/g, '').length === 14
  const podeEnviar = form.cliente_id && cnpjValido && form.data_prevista_entrega
    && form.tipo_operacao && form.canal && itens.length > 0

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
          <h1 className="text-2xl font-bold text-gray-900">Venda Outbound</h1>
          <p className="text-sm text-gray-500">Venda fechada direto pelo comercial, sem passar pelo CRM</p>
        </div>
      </div>

      <div className="bg-white rounded-xl p-6 shadow-sm border border-gray-100 space-y-5">

        <div className="bg-blue-50 border border-blue-200 rounded-lg p-3 text-sm text-blue-700">
          📦 <strong>Como funciona:</strong> essa OV entra direto no kanban da Expedição.
          Operações de vendas completa o <strong>número real da OV (D365)</strong> depois — por isso ele não aparece aqui.
        </div>

        <div className="grid grid-cols-2 gap-4">
          <div className="col-span-2">
            <label className="text-sm font-medium text-gray-700">Cliente *</label>
            <ClienteAutocomplete value={form.cliente_id} onChange={handleClienteChange} />
            {form.cliente_id && (
              <p className="text-xs text-green-600 mt-1">✅ {form.cliente_nome}</p>
            )}
          </div>

          <div className="col-span-2">
            <label className="text-sm font-medium text-gray-700">CNPJ do Cliente *</label>
            <input type="text" value={form.cliente_cnpj}
              onChange={e => setForm({ ...form, cliente_cnpj: formatarCnpj(e.target.value) })}
              className={`w-full border rounded-lg px-3 py-2.5 text-sm mt-1 font-mono ${
                form.cliente_cnpj && !cnpjValido ? 'border-red-400' : ''
              }`}
              placeholder="00.000.000/0000-00" maxLength={18} />
            {form.cliente_cnpj && !cnpjValido && (
              <p className="text-xs text-red-500 mt-1">CNPJ incompleto — precisa ter 14 dígitos.</p>
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

          <div className="col-span-2">
            <label className="text-sm font-medium text-gray-700">Tipo de Operação *</label>
            <select value={form.tipo_operacao} onChange={e => setForm({...form, tipo_operacao: e.target.value})}
              className={`w-full border rounded-lg px-3 py-2.5 text-sm mt-1 ${form.tipo_operacao ? '' : 'border-amber-400 text-gray-400'}`}>
              <option value="" disabled>Selecione o tipo de operação…</option>
              <option value="VENDA_NORMAL">Venda normal</option>
              <option value="COMUNICADO_USO">Comunicado de uso (consignado usado)</option>
              <option value="BONIFICACAO_DOACAO">Bonificação/Doação</option>
              <option value="AMOSTRA">Amostra</option>
              <option value="CONSIGNADO">Consignado</option>
            </select>
            {['BONIFICACAO_DOACAO', 'AMOSTRA', 'CONSIGNADO'].includes(form.tipo_operacao) && (
              <p className="text-xs text-amber-600 mt-1">
                ⚠️ Esta operação gera NF e passa pelo fluxo, mas <strong>não entra no faturamento</strong>.
              </p>
            )}
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">Canal de Venda *</label>
            <select value={form.canal} onChange={e => setForm({...form, canal: e.target.value})}
              className={`w-full border rounded-lg px-3 py-2.5 text-sm mt-1 ${form.canal ? '' : 'border-amber-400 text-gray-400'}`}>
              <option value="" disabled>Selecione o canal…</option>
              <option value="URO">Uro</option>
              <option value="VASCULAR">Vascular</option>
              <option value="REALCLOSURE">Realclosure</option>
              <option value="LICITACAO_URO">Licitação - Uro</option>
              <option value="LICITACAO_VASCULAR">Licitação - Vascular</option>
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
            <div className="mt-1">
              <LocalEntregaInput value={form.local_entrega} onChange={v => setForm({ ...form, local_entrega: v })} />
            </div>
          </div>

          <div className="col-span-2">
            <label className="text-sm font-medium text-gray-700">Itens *</label>
            <p className="text-xs text-gray-400 mb-1.5">Informe o código do item (o sistema recomenda enquanto você digita) e a quantidade. Adicione ao menos um item.</p>
            <ItensPedido value={itens} onChange={setItens} comValor />
            {itens.length === 0 && (
              <p className="text-xs text-amber-600 mt-1">Adicione pelo menos um item para lançar a venda.</p>
            )}
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
            className="flex-1 py-3 text-white rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors bg-blue-600 hover:bg-blue-500">
            {mutation.isPending ? 'Lançando...' : '✅ Lançar Venda Outbound'}
          </button>
        </div>
      </div>
    </div>
  )
}

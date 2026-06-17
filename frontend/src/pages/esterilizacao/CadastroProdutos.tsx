import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { Plus, Search, Edit2, X, Save } from 'lucide-react'
import { clsx } from 'clsx'
import { listarProdutos, criarProduto, atualizarProduto } from '../../lib/esterilizacaoApi'
import type { ProdutoEsteril, TipoCaixa } from '../../types/esterilizacao'

const TIPOS_CAIXA: TipoCaixa[] = ['VERDE', 'BRANCA', 'AMARELA', 'VERMELHA']

const FORM_VAZIO: Partial<ProdutoEsteril> = {
  codigo_sa: '', codigo_pa: '', descricao: '', familia: '',
  tipo_caixa_padrao: 'VERDE',
  qtd_padrao_cx_verde: undefined, qtd_padrao_cx_branca: undefined,
  qtd_padrao_cx_amarela: undefined, qtd_padrao_cx_vermelha: undefined,
  valor_unitario: 0, tempo_producao_seg: 0, tempo_separacao_seg: 0,
  requer_esterilizacao: true, ativo: true,
}

function FormProduto({
  inicial, onSalvar, onCancelar, modo,
}: {
  inicial: Partial<ProdutoEsteril>
  onSalvar: (data: Partial<ProdutoEsteril>) => void
  onCancelar: () => void
  modo: 'criar' | 'editar'
}) {
  const [form, setForm] = useState<Partial<ProdutoEsteril>>(inicial)

  const set = (campo: keyof ProdutoEsteril, valor: any) => setForm((f) => ({ ...f, [campo]: valor }))

  return (
    <div className="fixed inset-0 bg-black/60 z-50 flex items-start justify-center p-4 overflow-y-auto">
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl my-8 p-6">
        <div className="flex items-center justify-between mb-5">
          <h2 className="text-lg font-bold text-gray-900">
            {modo === 'criar' ? 'Novo Produto Estéril' : 'Editar Produto'}
          </h2>
          <button onClick={onCancelar} className="text-gray-400 hover:text-gray-700 p-1">
            <X size={18} />
          </button>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Código SA *</label>
            <input
              value={form.codigo_sa || ''}
              onChange={(e) => set('codigo_sa', e.target.value)}
              disabled={modo === 'editar'}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-gray-50 disabled:text-gray-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Código PA</label>
            <input
              value={form.codigo_pa || ''}
              onChange={(e) => set('codigo_pa', e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="sm:col-span-2">
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Descrição *</label>
            <input
              value={form.descricao || ''}
              onChange={(e) => set('descricao', e.target.value)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Família</label>
            <input
              value={form.familia || ''}
              onChange={(e) => set('familia', e.target.value)}
              placeholder="Ex: LUVA CIRÚRGICA"
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Caixa padrão</label>
            <select
              value={form.tipo_caixa_padrao || ''}
              onChange={(e) => set('tipo_caixa_padrao', e.target.value as TipoCaixa)}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {TIPOS_CAIXA.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>

          <div className="sm:col-span-2">
            <p className="text-sm font-medium text-gray-700 mb-2">Qtd por caixa (por tipo)</p>
            <div className="grid grid-cols-4 gap-2">
              {[
                { label: 'Verde',    campo: 'qtd_padrao_cx_verde' as keyof ProdutoEsteril },
                { label: 'Branca',   campo: 'qtd_padrao_cx_branca' as keyof ProdutoEsteril },
                { label: 'Amarela',  campo: 'qtd_padrao_cx_amarela' as keyof ProdutoEsteril },
                { label: 'Vermelha', campo: 'qtd_padrao_cx_vermelha' as keyof ProdutoEsteril },
              ].map(({ label, campo }) => (
                <div key={campo}>
                  <label className="block text-xs text-gray-500 mb-1">{label}</label>
                  <input
                    type="number" min={0}
                    value={(form[campo] as number) || ''}
                    onChange={(e) => set(campo, e.target.value ? Number(e.target.value) : undefined)}
                    className="w-full border border-gray-300 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              ))}
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Valor unitário (R$)</label>
            <input
              type="number" min={0} step={0.0001}
              value={form.valor_unitario || ''}
              onChange={(e) => set('valor_unitario', Number(e.target.value))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Tempo produção (seg/un)</label>
            <input
              type="number" min={0}
              value={form.tempo_producao_seg || ''}
              onChange={(e) => set('tempo_producao_seg', Number(e.target.value))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1.5">Tempo separação (seg/un)</label>
            <input
              type="number" min={0}
              value={form.tempo_separacao_seg || ''}
              onChange={(e) => set('tempo_separacao_seg', Number(e.target.value))}
              className="w-full border border-gray-300 rounded-lg px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-center gap-3">
            <input
              type="checkbox"
              id="requer"
              checked={form.requer_esterilizacao ?? true}
              onChange={(e) => set('requer_esterilizacao', e.target.checked)}
              className="w-4 h-4 text-blue-600 rounded"
            />
            <label htmlFor="requer" className="text-sm text-gray-700">Requer esterilização</label>
          </div>
          {modo === 'editar' && (
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                id="ativo"
                checked={form.ativo ?? true}
                onChange={(e) => set('ativo', e.target.checked)}
                className="w-4 h-4 text-blue-600 rounded"
              />
              <label htmlFor="ativo" className="text-sm text-gray-700">Ativo</label>
            </div>
          )}
        </div>

        <div className="flex gap-3 mt-6">
          <button onClick={onCancelar} className="flex-1 py-2.5 rounded-xl border border-gray-300 text-gray-700 text-sm font-medium hover:bg-gray-50">
            Cancelar
          </button>
          <button
            onClick={() => onSalvar(form)}
            className="flex-1 py-2.5 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 flex items-center justify-center gap-2"
          >
            <Save size={15} /> Salvar
          </button>
        </div>
      </div>
    </div>
  )
}

export function CadastroProdutos() {
  const qc = useQueryClient()
  const [busca, setBusca] = useState('')
  const [apenasAtivos, setApenasAtivos] = useState(true)
  const [modalAberto, setModalAberto] = useState<'criar' | 'editar' | null>(null)
  const [produtoEditando, setProdutoEditando] = useState<ProdutoEsteril | null>(null)

  const { data: produtos = [], isLoading } = useQuery({
    queryKey: ['produtos-estereis-cadastro', busca, apenasAtivos],
    queryFn: () => listarProdutos({ busca: busca || undefined, ativo_only: apenasAtivos }),
  })

  const mutCriar = useMutation({
    mutationFn: criarProduto,
    onSuccess: () => { toast.success('Produto cadastrado'); qc.invalidateQueries({ queryKey: ['produtos-estereis-cadastro'] }); setModalAberto(null) },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao cadastrar'),
  })

  const mutAtualizar = useMutation({
    mutationFn: (args: { codigo_sa: string; data: Partial<ProdutoEsteril> }) => atualizarProduto(args.codigo_sa, args.data),
    onSuccess: () => { toast.success('Produto atualizado'); qc.invalidateQueries({ queryKey: ['produtos-estereis-cadastro'] }); setModalAberto(null) },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao atualizar'),
  })

  return (
    <div className="flex flex-col h-full">
      {modalAberto === 'criar' && (
        <FormProduto
          inicial={FORM_VAZIO}
          modo="criar"
          onSalvar={(data) => mutCriar.mutate(data as any)}
          onCancelar={() => setModalAberto(null)}
        />
      )}
      {modalAberto === 'editar' && produtoEditando && (
        <FormProduto
          inicial={produtoEditando}
          modo="editar"
          onSalvar={(data) => mutAtualizar.mutate({ codigo_sa: produtoEditando.codigo_sa, data })}
          onCancelar={() => setModalAberto(null)}
        />
      )}

      {/* Header */}
      <div className="px-6 py-4 border-b border-gray-200 bg-white">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div>
            <h1 className="text-xl font-bold text-gray-900">Produtos Estéreis</h1>
            <p className="text-sm text-gray-500">{produtos.length} produto{produtos.length !== 1 ? 's' : ''}</p>
          </div>
          <button
            onClick={() => setModalAberto('criar')}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2.5 rounded-xl text-sm font-semibold transition-colors"
          >
            <Plus size={15} /> Novo produto
          </button>
        </div>
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input
              value={busca}
              onChange={(e) => setBusca(e.target.value)}
              placeholder="Buscar por SA, PA ou descrição..."
              className="w-full pl-8 pr-3 py-2 text-sm border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
            <input type="checkbox" checked={apenasAtivos} onChange={(e) => setApenasAtivos(e.target.checked)} className="rounded" />
            Apenas ativos
          </label>
        </div>
      </div>

      {/* Tabela */}
      <div className="flex-1 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-48 text-gray-400">Carregando...</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="bg-gray-50 border-b border-gray-200 sticky top-0">
              <tr>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Código SA</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Código PA</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Descrição</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Família</th>
                <th className="text-left px-4 py-3 font-semibold text-gray-600">Cx padrão</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">Qtd/cx</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">Valor unit.</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">T. prod.(s)</th>
                <th className="text-right px-4 py-3 font-semibold text-gray-600">T. sep.(s)</th>
                <th className="px-4 py-3" />
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {produtos.map((p) => {
                const qtdPadrao = {
                  VERDE: p.qtd_padrao_cx_verde, BRANCA: p.qtd_padrao_cx_branca,
                  AMARELA: p.qtd_padrao_cx_amarela, VERMELHA: p.qtd_padrao_cx_vermelha,
                }[p.tipo_caixa_padrao || 'VERDE']
                return (
                  <tr key={p.codigo_sa} className={clsx('hover:bg-gray-50 transition-colors', { 'opacity-50': !p.ativo })}>
                    <td className="px-4 py-3 font-mono text-xs font-medium text-gray-700">{p.codigo_sa}</td>
                    <td className="px-4 py-3 font-mono text-xs text-gray-500">{p.codigo_pa || '—'}</td>
                    <td className="px-4 py-3 text-gray-900 max-w-[200px]"><p className="truncate">{p.descricao}</p></td>
                    <td className="px-4 py-3 text-gray-600">{p.familia || '—'}</td>
                    <td className="px-4 py-3">
                      {p.tipo_caixa_padrao && (
                        <span className={clsx('text-xs font-semibold px-2 py-0.5 rounded', {
                          'bg-green-100 text-green-800':  p.tipo_caixa_padrao === 'VERDE',
                          'bg-gray-100 text-gray-800':    p.tipo_caixa_padrao === 'BRANCA',
                          'bg-yellow-100 text-yellow-800':p.tipo_caixa_padrao === 'AMARELA',
                          'bg-red-100 text-red-800':      p.tipo_caixa_padrao === 'VERMELHA',
                        })}>
                          {p.tipo_caixa_padrao}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-700">{qtdPadrao ?? '—'}</td>
                    <td className="px-4 py-3 text-right text-gray-700">
                      {p.valor_unitario ? `R$ ${p.valor_unitario.toFixed(4)}` : '—'}
                    </td>
                    <td className="px-4 py-3 text-right text-gray-600">{p.tempo_producao_seg || '—'}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{p.tempo_separacao_seg || '—'}</td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => { setProdutoEditando(p); setModalAberto('editar') }}
                        className="p-1.5 rounded hover:bg-blue-50 text-gray-400 hover:text-blue-600 transition-colors"
                      >
                        <Edit2 size={14} />
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}

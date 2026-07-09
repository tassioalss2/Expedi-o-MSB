import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { DollarSign, Truck, FileText, X, Pencil } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'

export function PainelComercial() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const hoje = new Date()

  // Mês de referência dos cards financeiros (default: mês corrente)
  const [mesFinanceiro, setMesFinanceiro] = useState(() => new Date(hoje.getFullYear(), hoje.getMonth(), 1))
  const ehMesAtual = mesFinanceiro.getFullYear() === hoje.getFullYear() && mesFinanceiro.getMonth() === hoje.getMonth()
  const inicioFinanceiro = format(new Date(mesFinanceiro.getFullYear(), mesFinanceiro.getMonth(), 1), 'yyyy-MM-dd')
  const fimFinanceiro = ehMesAtual
    ? format(hoje, 'yyyy-MM-dd')
    : format(new Date(mesFinanceiro.getFullYear(), mesFinanceiro.getMonth() + 1, 0), 'yyyy-MM-dd')
  const mesesDisponiveis = Array.from({ length: 12 }, (_, i) =>
    new Date(hoje.getFullYear(), hoje.getMonth() - i, 1)
  )

  const { data: financeiro } = useQuery({
    queryKey: ['financeiro', inicioFinanceiro],
    queryFn: () => api.get('/pedidos/dashboard/financeiro', {
      params: {
        data_inicio: inicioFinanceiro,
        data_fim: fimFinanceiro,
      }
    }).then(r => r.data),
    refetchInterval: 60000,
  })

  // Meta do mês
  const competenciaStr = format(mesFinanceiro, 'yyyy-MM')
  const { data: meta } = useQuery<{ competencia: string; valor: number | null }>({
    queryKey: ['meta', competenciaStr],
    queryFn: () => api.get(`/pedidos/meta?competencia=${competenciaStr}`).then(r => r.data),
  })

  const [editandoMeta, setEditandoMeta] = useState(false)
  const [valorMeta, setValorMeta] = useState('')

  const salvarMeta = useMutation({
    mutationFn: (valor: number) =>
      api.put('/pedidos/meta', { competencia: competenciaStr, valor }).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['meta', competenciaStr] })
      setEditandoMeta(false)
      toast.success('Meta salva')
    },
    onError: () => toast.error('Erro ao salvar meta'),
  })

  const metaValor = meta?.valor ?? null
  // Meta é sobre Vendas (exclui Transfer Price / Biomedical)
  const realizado = financeiro?.outras_vendas?.faturamento_sem_frete || 0
  const percentualMeta = metaValor && metaValor > 0 ? (realizado / metaValor) * 100 : 0
  const faltaMeta = metaValor ? metaValor - realizado : 0
  const corBarra = percentualMeta >= 100 ? 'bg-green-500' : percentualMeta < 70 ? 'bg-amber-500' : 'bg-green-500'
  const fmtR$ = (v: number) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`

  // Drill-down do card financeiro: qual grupo de NFs está sendo detalhado
  const [detalheFin, setDetalheFin] = useState<{ categoria: string; titulo: string } | null>(null)
  const { data: detalheFinLista = [], isFetching: carregandoDetalheFin } = useQuery<any[]>({
    queryKey: ['financeiro-detalhe', inicioFinanceiro, fimFinanceiro],
    queryFn: () => api.get('/pedidos/dashboard/financeiro/detalhe', {
      params: { data_inicio: inicioFinanceiro, data_fim: fimFinanceiro },
    }).then(r => r.data),
    enabled: detalheFin !== null,
  })

  const filtrarDetalheFin = (rows: any[], categoria: string) => {
    if (categoria === 'sem_faturamento') return rows.filter(r => !r.eh_faturamento)
    // Demais categorias refletem só o que é faturamento (bate com os totais do card)
    const fat = rows.filter(r => r.eh_faturamento)
    switch (categoria) {
      case 'transfer': return fat.filter(r => r.eh_biomedical)
      case 'outras': return fat.filter(r => !r.eh_biomedical)
      case 'frete_todos': return fat.filter(r => r.valor_frete > 0)
      case 'frete_ressarcido': return fat.filter(r => r.tipo_frete === 'CIF_COM_VALOR' && r.valor_frete > 0)
      case 'frete_proprio': return fat.filter(r => r.tipo_frete === 'CIF_SEM_VALOR' && r.valor_frete > 0)
      default: return fat
    }
  }
  const TIPO_FRETE_LABEL: Record<string, string> = {
    FOB: 'FOB', CIF_COM_VALOR: 'CIF c/ valor', CIF_SEM_VALOR: 'CIF s/ valor',
  }
  const fmtMoeda = (v: number) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Painel Comercial</h1>
        <p className="text-gray-500 text-sm mt-0.5">
          {format(mesFinanceiro, "MMMM 'de' yyyy", { locale: ptBR })}
        </p>
      </div>

      {/* Meta do mês */}
      <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
        <div className="flex items-center justify-between mb-3">
          <div className="flex items-center gap-2">
            <div className="p-2 bg-green-50 rounded-lg">
              <DollarSign size={18} className="text-green-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-700">Meta do mês</p>
              <p className="text-xs text-gray-400">{format(mesFinanceiro, 'MMMM/yyyy', { locale: ptBR })}</p>
            </div>
          </div>
          {!editandoMeta && (
            <button
              onClick={() => { setValorMeta(metaValor != null ? String(metaValor) : ''); setEditandoMeta(true) }}
              className="p-1.5 rounded-lg hover:bg-gray-100 text-gray-400 hover:text-gray-600"
              title="Editar meta"
            >
              <Pencil size={15} />
            </button>
          )}
        </div>

        {editandoMeta ? (
          <div className="flex items-center gap-2 mb-3">
            <span className="text-sm text-gray-500">R$</span>
            <input
              type="number"
              step="0.01"
              value={valorMeta}
              onChange={(e) => setValorMeta(e.target.value)}
              placeholder="0,00"
              className="flex-1 text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500"
            />
            <button
              onClick={() => salvarMeta.mutate(Number(valorMeta))}
              disabled={salvarMeta.isPending}
              className="px-4 py-1.5 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-500 disabled:opacity-60"
            >
              Salvar
            </button>
            <button
              onClick={() => setEditandoMeta(false)}
              className="px-3 py-1.5 border border-gray-200 text-gray-600 rounded-lg text-sm font-medium hover:bg-gray-50"
            >
              Cancelar
            </button>
          </div>
        ) : metaValor === null ? (
          <div className="mb-3">
            <button
              onClick={() => { setValorMeta(''); setEditandoMeta(true) }}
              className="px-4 py-2 border border-dashed border-gray-300 text-gray-500 rounded-lg text-sm font-medium hover:bg-gray-50"
            >
              Definir meta
            </button>
          </div>
        ) : (
          <div className="flex items-end justify-between mb-3">
            <div>
              <p className="text-xs text-gray-400">Meta</p>
              <p className="text-2xl font-bold text-gray-800">{fmtR$(metaValor)}</p>
            </div>
            <div className="text-right">
              <p className="text-xs text-gray-400">Vendas</p>
              <p className="text-xl font-bold text-green-600">{fmtR$(realizado)}</p>
            </div>
          </div>
        )}

        {metaValor !== null && !editandoMeta && (
          <>
            <div className="bg-gray-100 rounded-full h-2 overflow-hidden">
              <div
                className={`h-2 rounded-full transition-all ${corBarra}`}
                style={{ width: `${Math.min(percentualMeta, 100)}%` }}
              />
            </div>
            <div className="flex items-center justify-between mt-1.5 text-xs text-gray-400">
              <span className="font-semibold text-gray-600">{percentualMeta.toFixed(1)}% da meta</span>
              {faltaMeta > 0 && <span>Faltam {fmtR$(faltaMeta)}</span>}
            </div>
          </>
        )}
      </div>

      {/* Cards Financeiros */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-gray-700">Financeiro — Notas faturadas no mês</h2>
        <select
          value={inicioFinanceiro}
          onChange={(e) => {
            const [y, m] = e.target.value.split('-').map(Number)
            setMesFinanceiro(new Date(y, m - 1, 1))
          }}
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white text-gray-700 focus:outline-none focus:ring-2 focus:ring-green-500 focus:border-green-500 cursor-pointer"
        >
          {mesesDisponiveis.map((d) => {
            const val = format(d, 'yyyy-MM-dd')
            return (
              <option key={val} value={val}>
                {format(d, "MMMM 'de' yyyy", { locale: ptBR })}
              </option>
            )
          })}
        </select>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* Faturamento NF */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-green-50 rounded-lg">
                <DollarSign size={18} className="text-green-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-700">Faturamento NF</p>
                <p className="text-xs text-gray-400">{format(mesFinanceiro, 'MMMM/yyyy', { locale: ptBR })}</p>
              </div>
            </div>
            <span className="text-xs text-gray-400">{financeiro?.qtd_nfs || 0} NF(s)</span>
          </div>
          <div
            onClick={() => setDetalheFin({ categoria: 'outras', titulo: 'Vendas' })}
            className="cursor-pointer rounded-lg -mx-1 px-1 py-0.5 hover:bg-gray-50 transition-colors"
            title="Ver as NFs de vendas"
          >
            <p className="text-xs text-gray-400 uppercase tracking-wide font-semibold">Vendas · sem frete</p>
            <p className="text-3xl font-bold text-green-600 leading-tight">
              R$ {Number(financeiro?.outras_vendas?.faturamento_sem_frete || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">
              c/ frete: R$ {Number(financeiro?.outras_vendas?.total_nf || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
              <span className="text-gray-300"> · {financeiro?.outras_vendas?.qtd_nfs || 0} NF</span>
            </p>
          </div>
          {financeiro && (
            <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
              <div
                onClick={() => setDetalheFin({ categoria: 'transfer', titulo: 'Transfer Price (Biomedical)' })}
                className="flex items-start justify-between cursor-pointer rounded-lg -mx-1 px-1 py-1 hover:bg-gray-50 transition-colors"
              >
                <span className="flex items-center gap-1.5 text-xs text-gray-500 pt-0.5">
                  <span className="w-2 h-2 rounded-full bg-purple-500 inline-block" />
                  Transfer Price (Biomedical)
                  <span className="text-gray-300">· {financeiro.transfer_price?.qtd_nfs || 0} NF</span>
                </span>
                <span className="text-right">
                  <span className="block text-sm font-semibold text-purple-700">
                    R$ {Number(financeiro.transfer_price?.faturamento_sem_frete || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </span>
                  <span className="block text-[11px] text-gray-400">não entra na meta</span>
                </span>
              </div>
              <div
                onClick={() => setDetalheFin({ categoria: 'todos', titulo: 'Faturamento — todas as NFs' })}
                className="flex items-center justify-between cursor-pointer rounded-lg -mx-1 px-1 py-1 hover:bg-gray-50 transition-colors"
              >
                <span className="text-xs text-gray-400">Total faturado (Vendas + Transfer)</span>
                <span className="text-sm font-medium text-gray-500">
                  R$ {Number(financeiro.faturamento_sem_frete || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                </span>
              </div>
            </div>
          )}
          {financeiro?.sem_faturamento?.length > 0 && (
            <div
              onClick={() => setDetalheFin({ categoria: 'sem_faturamento', titulo: 'Operações sem faturamento' })}
              className="mt-3 pt-3 border-t border-dashed border-gray-200 cursor-pointer rounded-lg -mx-1 px-1 py-1 hover:bg-gray-50 transition-colors"
              title="NFs que passam pelo fluxo mas não são faturamento"
            >
              <p className="text-[11px] text-gray-400 mb-1">Não entra no faturamento (bonif./amostra/consignado)</p>
              {financeiro.sem_faturamento.map((o: any) => (
                <div key={o.tipo} className="flex items-center justify-between text-xs text-gray-500">
                  <span>{o.label} <span className="text-gray-300">· {o.qtd} NF</span></span>
                  <span className="text-gray-500">R$ {Number(o.valor_nf || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}</span>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Custo de Frete */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="p-2 bg-orange-50 rounded-lg">
                <Truck size={18} className="text-orange-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-700">Frete Pago</p>
                <p className="text-xs text-gray-400">{format(mesFinanceiro, 'MMMM/yyyy', { locale: ptBR })}</p>
              </div>
            </div>
            <span className="text-xs text-gray-400">{financeiro?.qtd_com_frete || 0} OV(s)</span>
          </div>
          <div
            onClick={() => setDetalheFin({ categoria: 'frete_todos', titulo: 'Frete Pago — todas as OVs' })}
            className="cursor-pointer rounded-lg -mx-1 px-1 py-0.5 hover:bg-gray-50 transition-colors"
            title="Ver as OVs deste total"
          >
            <p className="text-2xl font-bold text-orange-600">
              {financeiro?.total_frete
                ? `R$ ${Number(financeiro.total_frete).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
                : 'R$ 0,00'}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">total pago às transportadoras</p>
          </div>
          {financeiro && (
            <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
              <div
                onClick={() => setDetalheFin({ categoria: 'frete_ressarcido', titulo: 'Frete ressarcido (CIF c/ valor)' })}
                className="flex items-center justify-between cursor-pointer rounded-lg -mx-1 px-1 py-1 hover:bg-gray-50 transition-colors"
              >
                <span className="flex items-center gap-1.5 text-xs text-gray-500">
                  <span className="w-2 h-2 rounded-full bg-gray-300 inline-block" />
                  Ressarcido (CIF c/ valor)
                </span>
                <span className="text-sm font-medium text-gray-500">
                  R$ {Number(financeiro.frete_ressarcido || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                </span>
              </div>
              <div
                onClick={() => setDetalheFin({ categoria: 'frete_proprio', titulo: 'Custo líquido de frete (CIF s/ valor)' })}
                className="flex items-center justify-between cursor-pointer rounded-lg -mx-1 px-1 py-1 hover:bg-gray-50 transition-colors"
              >
                <span className="flex items-center gap-1.5 text-xs text-gray-600 font-medium">
                  <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
                  Custo líquido (CIF s/ valor)
                </span>
                <span className="text-sm font-bold text-red-600">
                  R$ {Number(financeiro.frete_proprio || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                </span>
              </div>
              <p className="text-[11px] text-gray-400 leading-snug pt-0.5">
                O frete ressarcido já está no faturamento bruto e o cliente devolve — neutro no resultado. Só o custo líquido impacta a margem.
              </p>
            </div>
          )}
        </div>

        {/* Ticket Médio */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <div className="flex items-center gap-2 mb-3">
            <div className="p-2 bg-blue-50 rounded-lg">
              <FileText size={18} className="text-blue-600" />
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-700">Ticket Médio por NF</p>
              <p className="text-xs text-gray-400">{format(mesFinanceiro, 'MMMM/yyyy', { locale: ptBR })}</p>
            </div>
          </div>
          <p className="text-2xl font-bold text-blue-600">
            {financeiro?.qtd_nfs > 0
              ? `R$ ${(Number(financeiro.total_nf) / financeiro.qtd_nfs).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
              : 'R$ 0,00'}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            Frete médio: {financeiro?.qtd_com_frete > 0
              ? `R$ ${(Number(financeiro.total_frete) / financeiro.qtd_com_frete).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}`
              : '—'}
          </p>
        </div>
      </div>

      {/* Modal drill-down do card financeiro */}
      {detalheFin !== null && (() => {
        const linhas = filtrarDetalheFin(detalheFinLista, detalheFin.categoria)
        const ehFrete = detalheFin.categoria.startsWith('frete')
        const somaNf = linhas.reduce((a, r) => a + (r.valor_nf || 0), 0)
        const somaSemFrete = linhas.reduce((a, r) => a + (r.valor_sem_frete || 0), 0)
        const somaFrete = linhas.reduce((a, r) => a + (r.valor_frete || 0), 0)
        return (
          <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
            <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col">
              <div className="p-5 border-b flex items-center justify-between">
                <div>
                  <h2 className="text-lg font-bold">{detalheFin.titulo}</h2>
                  <p className="text-xs text-gray-400 mt-0.5">
                    {format(mesFinanceiro, "MMMM 'de' yyyy", { locale: ptBR })} · notas faturadas no mês
                  </p>
                </div>
                <button onClick={() => setDetalheFin(null)} className="p-1.5 hover:bg-gray-100 rounded-lg">
                  <X size={18} />
                </button>
              </div>
              <div className="flex-1 overflow-auto">
                {carregandoDetalheFin ? (
                  <p className="text-center text-gray-400 py-8 text-sm">Carregando...</p>
                ) : linhas.length === 0 ? (
                  <p className="text-center text-gray-400 py-8 text-sm">Nenhuma NF neste grupo</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead className="bg-gray-50 sticky top-0">
                      <tr>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">OV</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">NF</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Cliente</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Frete</th>
                        <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Valor NF</th>
                        <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">
                          {ehFrete ? 'Frete R$' : 'Sem frete'}
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {linhas.map((r) => (
                        <tr key={r.id}
                          onClick={() => { setDetalheFin(null); navigate(`/expedicao/${r.id}`) }}
                          className="hover:bg-gray-50 cursor-pointer">
                          <td className="px-4 py-2.5 font-mono font-semibold text-indigo-700">{r.numero_pedido}</td>
                          <td className="px-4 py-2.5 font-mono text-gray-600">{r.numero_nf || '—'}</td>
                          <td className="px-4 py-2.5 text-gray-700 max-w-[220px] truncate">
                            {r.eh_biomedical && <span className="w-2 h-2 rounded-full bg-purple-500 inline-block mr-1.5 align-middle" />}
                            {r.cliente}
                          </td>
                          <td className="px-4 py-2.5 text-gray-500 text-xs">{TIPO_FRETE_LABEL[r.tipo_frete] || r.tipo_frete || '—'}</td>
                          <td className="px-4 py-2.5 text-right font-medium text-gray-800">{fmtMoeda(r.valor_nf)}</td>
                          <td className="px-4 py-2.5 text-right text-gray-600">
                            {fmtMoeda(ehFrete ? r.valor_frete : r.valor_sem_frete)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-gray-50 sticky bottom-0 border-t-2 border-gray-200">
                      <tr className="font-semibold text-gray-800">
                        <td className="px-4 py-3" colSpan={4}>{linhas.length} NF(s)</td>
                        <td className="px-4 py-3 text-right">{fmtMoeda(somaNf)}</td>
                        <td className="px-4 py-3 text-right">{fmtMoeda(ehFrete ? somaFrete : somaSemFrete)}</td>
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

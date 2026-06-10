import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { format, subDays } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { FileText, Truck, Download, Package, ChevronDown, ChevronUp } from 'lucide-react'
import api from '../lib/api'

const STATUS_LABEL: Record<string, string> = {
  LIBERADO: 'OV Recebida',
  EM_INVENTARIO: 'Em Inventário',
  AGUARD_VERIFICACAO: 'Aguard. Verificação',
  DIVERGENCIA: 'Divergência',
  AGUARD_TRATATIVA: 'Aguard. Tratativa',
  EM_PROCESSO_SISTEMICO: 'D365 + Cubagem',
  AGUARD_FATURAMENTO: 'Aguard. Faturamento',
  FATURADO: 'Faturado',
  AGUARD_COLETA: 'No Pallet',
  COLETADO: 'Coletado',
  EXPEDIDO: 'Expedido',
  CANCELADO: 'Cancelado',
}

const STATUS_COR: Record<string, string> = {
  EXPEDIDO: 'bg-green-100 text-green-700',
  CANCELADO: 'bg-gray-100 text-gray-500',
  FATURADO: 'bg-blue-100 text-blue-700',
  AGUARD_COLETA: 'bg-teal-100 text-teal-700',
  COLETADO: 'bg-purple-100 text-purple-700',
}

export function Relatorios() {
  const navigate = useNavigate()
  const hoje = new Date()
  const [dataInicio, setDataInicio] = useState(format(subDays(hoje, 30), 'yyyy-MM-dd'))
  const [dataFim, setDataFim] = useState(format(hoje, 'yyyy-MM-dd'))
  const [statusFiltro, setStatusFiltro] = useState('EXPEDIDO')
  const [expandido, setExpandido] = useState(true)

  const { data: pedidos = [], isLoading } = useQuery({
    queryKey: ['relatorio-historico', dataInicio, dataFim, statusFiltro],
    queryFn: () => api.get('/pedidos', {
      params: statusFiltro ? { status: statusFiltro } : {}
    }).then(r => r.data),
  })

  // Filtra por período de atualização
  const filtrados = (pedidos as any[]).filter(p => {
    const dt = p.atualizado_em?.slice(0, 10)
    return dt >= dataInicio && dt <= dataFim
  }).sort((a: any, b: any) =>
    new Date(b.atualizado_em).getTime() - new Date(a.atualizado_em).getTime()
  )

  const exportarCSV = () => {
    const header = ['OV', 'NF', 'Cliente', 'Transportadora', 'Status', 'Tipo Frete', 'Valor NF', 'Entrega Prevista', 'Atualizado Em']
    const linhas = filtrados.map(p => [
      p.numero_pedido,
      p.numero_nf || '',
      p.cliente_nome || p.cliente?.nome || '',
      p.transportadora_nome || '',
      STATUS_LABEL[p.status] || p.status,
      p.tipo_frete || '',
      p.valor_nf || '',
      p.data_prevista_entrega || '',
      p.atualizado_em ? format(new Date(p.atualizado_em), 'dd/MM/yyyy HH:mm') : '',
    ])
    const csv = [header, ...linhas].map(r => r.join(';')).join('\n')
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `relatorio_${statusFiltro.toLowerCase()}_${dataInicio}_${dataFim}.csv`
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6">

      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">📊 Relatórios</h1>
        <p className="text-gray-500 text-sm mt-1">Consulte e exporte dados históricos da expedição</p>
      </div>

      {/* Atalhos para relatórios existentes */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <button
          onClick={() => navigate('/relatorio/coleta')}
          className="flex items-center gap-4 p-5 bg-white rounded-xl border border-gray-200 hover:border-blue-300 hover:shadow-md transition-all text-left"
        >
          <div className="w-12 h-12 bg-orange-100 rounded-xl flex items-center justify-center flex-shrink-0">
            <Truck size={22} className="text-orange-600" />
          </div>
          <div>
            <p className="font-semibold text-gray-900">Coletas Pendentes</p>
            <p className="text-sm text-gray-500 mt-0.5">OVs aguardando coleta nos pallets</p>
          </div>
          <ChevronDown size={18} className="ml-auto text-gray-400 -rotate-90" />
        </button>

        <button
          onClick={() => navigate('/relatorio/coletas-realizadas')}
          className="flex items-center gap-4 p-5 bg-white rounded-xl border border-gray-200 hover:border-blue-300 hover:shadow-md transition-all text-left"
        >
          <div className="w-12 h-12 bg-green-100 rounded-xl flex items-center justify-center flex-shrink-0">
            <FileText size={22} className="text-green-600" />
          </div>
          <div>
            <p className="font-semibold text-gray-900">Coletas Realizadas</p>
            <p className="text-sm text-gray-500 mt-0.5">Histórico de coletas com análise por transportadora</p>
          </div>
          <ChevronDown size={18} className="ml-auto text-gray-400 -rotate-90" />
        </button>
      </div>

      {/* Histórico de OVs */}
      <div className="bg-white rounded-xl border border-gray-200 overflow-hidden">
        <div
          className="flex items-center justify-between p-5 cursor-pointer hover:bg-gray-50"
          onClick={() => setExpandido(!expandido)}
        >
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center">
              <Package size={20} className="text-blue-600" />
            </div>
            <div>
              <p className="font-semibold text-gray-900">Histórico de OVs</p>
              <p className="text-sm text-gray-500">Consulte e exporte OVs por período e status</p>
            </div>
          </div>
          {expandido ? <ChevronUp size={18} className="text-gray-400" /> : <ChevronDown size={18} className="text-gray-400" />}
        </div>

        {expandido && (
          <div className="border-t border-gray-100">
            {/* Filtros */}
            <div className="p-5 bg-gray-50 flex flex-wrap gap-3 items-end">
              <div>
                <label className="text-xs font-semibold text-gray-500 block mb-1">STATUS</label>
                <select value={statusFiltro} onChange={e => setStatusFiltro(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm bg-white">
                  <option value="">Todos</option>
                  {Object.entries(STATUS_LABEL).map(([k, v]) => (
                    <option key={k} value={k}>{v}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 block mb-1">DE</label>
                <input type="date" value={dataInicio} onChange={e => setDataInicio(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div>
                <label className="text-xs font-semibold text-gray-500 block mb-1">ATÉ</label>
                <input type="date" value={dataFim} onChange={e => setDataFim(e.target.value)}
                  className="border rounded-lg px-3 py-2 text-sm" />
              </div>
              <div className="flex items-center gap-2 ml-auto">
                <span className="text-sm text-gray-500">{filtrados.length} registro(s)</span>
                <button onClick={exportarCSV} disabled={filtrados.length === 0}
                  className="flex items-center gap-2 px-4 py-2 bg-gray-800 text-white rounded-lg text-sm font-medium hover:bg-gray-700 disabled:opacity-40">
                  <Download size={15} />
                  Exportar CSV
                </button>
              </div>
            </div>

            {/* Tabela */}
            {isLoading ? (
              <div className="p-8 text-center text-gray-400">Carregando...</div>
            ) : filtrados.length === 0 ? (
              <div className="p-8 text-center text-gray-400">Nenhum resultado encontrado</div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-gray-100 bg-gray-50">
                    <tr className="text-left text-gray-500">
                      <th className="px-4 py-3 font-semibold">OV</th>
                      <th className="px-4 py-3 font-semibold">NF</th>
                      <th className="px-4 py-3 font-semibold">Cliente</th>
                      <th className="px-4 py-3 font-semibold">Transportadora</th>
                      <th className="px-4 py-3 font-semibold">Status</th>
                      <th className="px-4 py-3 font-semibold">Valor NF</th>
                      <th className="px-4 py-3 font-semibold">Entrega Prevista</th>
                      <th className="px-4 py-3 font-semibold">Atualizado Em</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-50">
                    {filtrados.map((p: any) => (
                      <tr key={p.id} className="hover:bg-gray-50 cursor-pointer"
                        onClick={() => navigate(`/expedicao/${p.id}`)}>
                        <td className="px-4 py-3 font-bold text-gray-900">{p.numero_pedido}</td>
                        <td className="px-4 py-3 text-blue-600 font-medium">
                          {p.numero_nf ? `📄 ${p.numero_nf}` : '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-700 max-w-[200px] truncate">
                          {p.cliente_nome || p.cliente?.nome || '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-600">
                          {p.transportadora_nome || '—'}
                        </td>
                        <td className="px-4 py-3">
                          <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${STATUS_COR[p.status] || 'bg-gray-100 text-gray-600'}`}>
                            {STATUS_LABEL[p.status] || p.status}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-gray-700">
                          {p.valor_nf ? `R$ ${Number(p.valor_nf).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}` : '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-500">
                          {p.data_prevista_entrega ? format(new Date(p.data_prevista_entrega + 'T12:00:00'), 'dd/MM/yyyy') : '—'}
                        </td>
                        <td className="px-4 py-3 text-gray-500 text-xs">
                          {p.atualizado_em ? format(new Date(p.atualizado_em), 'dd/MM/yyyy HH:mm', { locale: ptBR }) : '—'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

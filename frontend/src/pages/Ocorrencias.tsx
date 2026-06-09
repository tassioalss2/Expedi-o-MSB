import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import { useNavigate } from 'react-router-dom'
import api from '../lib/api'
import type { Ocorrencia } from '../types'
import toast from 'react-hot-toast'

const TIPOS = [
  'Divergência de Estoque',
  'Produto trocado',
  'Embalagem danificada',
  'Erro de Transportadora na NF',
  'Cancelamento de OV',
  'Retornou a OV',
  'Atraso na coleta',
  'Erro no faturamento',
  'Outro',
]

const STATUS_COR: Record<string, string> = {
  ABERTA:       'bg-red-100 text-red-700 border-red-200',
  EM_TRATATIVA: 'bg-yellow-100 text-yellow-700 border-yellow-200',
  FECHADA:      'bg-green-100 text-green-700 border-green-200',
}

const TIPO_CORES = [
  '#EF4444','#F97316','#EAB308','#22C55E',
  '#3B82F6','#8B5CF6','#EC4899','#6B7280',
]

// ── Modal detalhe de ocorrência ───────────────────────────────────────────────
function ModalDetalhe({ oc, onClose }: { oc: any; onClose: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [resolucao, setResolucao] = useState('')
  const [modalExcluir, setModalExcluir] = useState(false)

  const excluir = useMutation({
    mutationFn: () => api.post(`/ocorrencias/${oc.id}/excluir`),
    onSuccess: () => {
      toast.success('Ocorrência excluída.')
      qc.invalidateQueries({ queryKey: ['ocorrencias'] })
      onClose()
    },
    onError: () => toast.error('Erro ao excluir ocorrência'),
  })

  const fechar = useMutation({
    mutationFn: () => api.patch(`/pedidos/ocorrencias/${oc.id}/fechar`, { resolucao }),
    onSuccess: () => {
      toast.success('Ocorrência fechada!')
      qc.invalidateQueries({ queryKey: ['ocorrencias'] })
      onClose()
    },
    onError: () => toast.error('Erro ao fechar ocorrência'),
  })

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg relative overflow-hidden">
        <div className="p-5 border-b flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1 flex-wrap">
              <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${STATUS_COR[oc.status]}`}>
                {oc.status.replace('_', ' ')}
              </span>
              <span className="text-xs text-gray-500">{oc.tipo}</span>
              <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-semibold">🔄 Retrabalho</span>
            </div>
            <h2 className="text-lg font-bold text-gray-900">Ocorrência — {oc.numero_pedido}</h2>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600 text-xl">✕</button>
        </div>

        <div className="p-5 space-y-4">
          {/* Info do pedido */}
          <div className="bg-gray-50 rounded-lg p-3 grid grid-cols-2 gap-2 text-sm">
            <div>
              <p className="text-xs text-gray-400">OV</p>
              <button onClick={() => { onClose(); navigate(`/expedicao/${oc.pedido_id}`) }}
                className="font-bold text-blue-600 hover:underline">{oc.numero_pedido}</button>
            </div>
            <div>
              <p className="text-xs text-gray-400">Cliente</p>
              <p className="font-medium text-gray-700 truncate">{oc.cliente_nome}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Aberta em</p>
              <p className="text-gray-600">{oc.criado_em ? format(parseISO(oc.criado_em), 'dd/MM/yyyy HH:mm', { locale: ptBR }) : '—'}</p>
            </div>
            <div>
              <p className="text-xs text-gray-400">Resolvida em</p>
              <p className="text-gray-600">{oc.resolvido_em ? format(parseISO(oc.resolvido_em), 'dd/MM/yyyy HH:mm', { locale: ptBR }) : '—'}</p>
            </div>
          </div>

          {/* Descrição */}
          <div>
            <p className="text-xs font-semibold text-gray-500 mb-1">DESCRIÇÃO</p>
            <div className="bg-red-50 border border-red-100 rounded-lg p-3 text-sm text-gray-700 whitespace-pre-line">
              {oc.descricao}
            </div>
          </div>

          {/* Resolução existente */}
          {oc.resolucao && (
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1">RESOLUÇÃO</p>
              <div className="bg-green-50 border border-green-100 rounded-lg p-3 text-sm text-gray-700">
                {oc.resolucao}
              </div>
            </div>
          )}

          {/* Campo de resolução se ainda aberta */}
          {oc.status !== 'FECHADA' && (
            <div>
              <p className="text-xs font-semibold text-gray-500 mb-1">REGISTRAR RESOLUÇÃO</p>
              <textarea rows={3} value={resolucao} onChange={e => setResolucao(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm"
                placeholder="Descreva o que foi feito para resolver..." />
            </div>
          )}
        </div>

        <div className="p-5 border-t flex items-center justify-between gap-2">
          <button onClick={() => setModalExcluir(true)}
            className="px-3 py-2 text-red-500 border border-red-200 rounded-lg text-sm hover:bg-red-50 flex items-center gap-1.5">
            🗑 Excluir
          </button>
          <div className="flex gap-2">
            <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Fechar</button>
            {oc.status !== 'FECHADA' && (
              <button onClick={() => fechar.mutate()} disabled={fechar.isPending || !resolucao.trim()}
                className="px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {fechar.isPending ? 'Fechando...' : '✅ Marcar como Resolvida'}
              </button>
            )}
          </div>
        </div>

        {/* Confirmação simples */}
        {modalExcluir && (
          <div className="absolute inset-0 bg-white bg-opacity-95 rounded-2xl flex flex-col items-center justify-center p-6 z-10">
            <p className="text-3xl mb-3">🗑</p>
            <h3 className="text-lg font-bold text-gray-900 mb-1">Excluir Ocorrência?</h3>
            <p className="text-sm text-gray-500 mb-6 text-center">Esta ação não pode ser desfeita.</p>
            <div className="flex gap-3 w-full max-w-xs">
              <button onClick={() => setModalExcluir(false)}
                className="flex-1 py-2.5 border rounded-lg text-sm">
                Cancelar
              </button>
              <button onClick={() => excluir.mutate()}
                disabled={excluir.isPending}
                className="flex-1 py-2.5 bg-red-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {excluir.isPending ? '...' : 'Excluir'}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

// ── Tela principal ────────────────────────────────────────────────────────────
export function Ocorrencias() {
  const qc = useQueryClient()
  const [filtroStatus, setFiltroStatus] = useState('')
  const [modalNova, setModalNova] = useState(false)
  const [ocSelecionada, setOcSelecionada] = useState<any | null>(null)
  const [form, setForm] = useState({ pedido_id: '', tipo: TIPOS[0], descricao: '' })

  const { data: ocorrencias = [] } = useQuery({
    queryKey: ['ocorrencias', filtroStatus],
    queryFn: () =>
      api.get('/ocorrencias', { params: filtroStatus ? { status: filtroStatus } : {} })
        .then(r => r.data).catch(() => []),
    refetchInterval: 30000,
  })

  const criarMutation = useMutation({
    mutationFn: () => api.post('/pedidos/ocorrencias', form),
    onSuccess: () => {
      toast.success('Ocorrência registrada!')
      qc.invalidateQueries({ queryKey: ['ocorrencias'] })
      setModalNova(false)
      setForm({ pedido_id: '', tipo: TIPOS[0], descricao: '' })
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao registrar ocorrência'),
  })

  // ── Dados para o gráfico ──────────────────────────────────────────────────
  const todosPorTipo = (ocorrencias as any[]).reduce((acc: Record<string, number>, oc: any) => {
    const t = oc.tipo || 'Outro'
    acc[t] = (acc[t] || 0) + 1
    return acc
  }, {})

  const dadosGrafico = Object.entries(todosPorTipo)
    .sort((a, b) => b[1] - a[1])
    .map(([name, value]) => ({ name, value }))

  const abertas = (ocorrencias as any[]).filter((o: any) => o.status === 'ABERTA').length
  const emTratativa = (ocorrencias as any[]).filter((o: any) => o.status === 'EM_TRATATIVA').length

  return (
    <div className="p-6 space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Ocorrências</h1>
          <p className="text-sm text-gray-500">
            {(ocorrencias as any[]).length} no total
            {abertas > 0 && <span className="text-red-600 font-medium"> · {abertas} aberta(s)</span>}
            {emTratativa > 0 && <span className="text-yellow-600 font-medium"> · {emTratativa} em tratativa</span>}
          </p>
        </div>
        <button onClick={() => setModalNova(true)}
          className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium hover:bg-red-500">
          + Nova Ocorrência
        </button>
      </div>

      {/* Gráfico por tipo */}
      {dadosGrafico.length > 0 && (
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h2 className="text-sm font-semibold text-gray-700 mb-4">📊 Ocorrências por Tipo</h2>
          <ResponsiveContainer width="100%" height={180}>
            <BarChart data={dadosGrafico} layout="vertical" margin={{ left: 10, right: 30 }}>
              <XAxis type="number" tick={{ fontSize: 11 }} allowDecimals={false} />
              <YAxis type="category" dataKey="name" tick={{ fontSize: 11 }} width={180} />
              <Tooltip formatter={(v: any) => [`${v} ocorrência(s)`, 'Qtd']} />
              <Bar dataKey="value" radius={[0, 4, 4, 0]}>
                {dadosGrafico.map((_, i) => (
                  <Cell key={i} fill={TIPO_CORES[i % TIPO_CORES.length]} />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Filtros */}
      <div className="flex gap-2">
        {['', 'ABERTA', 'EM_TRATATIVA', 'FECHADA'].map(s => (
          <button key={s} onClick={() => setFiltroStatus(s)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              filtroStatus === s ? 'bg-gray-900 text-white' : 'bg-white border border-gray-200 text-gray-600 hover:bg-gray-50'
            }`}>
            {s || 'Todas'}
          </button>
        ))}
      </div>

      {/* Lista */}
      <div className="space-y-3">
        {(ocorrencias as any[]).length === 0 && (
          <div className="bg-white rounded-xl p-12 text-center text-gray-400 border border-gray-100">
            <p className="text-lg">✅ Nenhuma ocorrência</p>
          </div>
        )}

        {(ocorrencias as any[]).map((oc: any) => (
          <div key={oc.id}
            onClick={() => setOcSelecionada(oc)}
            className="bg-white rounded-xl p-4 shadow-sm border border-gray-100 cursor-pointer hover:shadow-md hover:border-blue-200 transition-all">
            <div className="flex items-start justify-between gap-3">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 mb-1 flex-wrap">
                  <span className={`text-xs font-semibold px-2 py-0.5 rounded-full border ${STATUS_COR[oc.status]}`}>
                    {oc.status.replace('_', ' ')}
                  </span>
                  <span className="text-xs bg-gray-100 text-gray-600 px-2 py-0.5 rounded-full">{oc.tipo}</span>
                  <span className="text-xs font-bold text-blue-600">{oc.numero_pedido}</span>
                  <span className="text-xs bg-orange-100 text-orange-700 px-2 py-0.5 rounded-full font-semibold">🔄 Retrabalho</span>
                  {oc.cliente_nome && oc.cliente_nome !== '—' && (
                    <span className="text-xs text-gray-400 truncate max-w-[200px]">{oc.cliente_nome}</span>
                  )}
                </div>
                <p className="text-sm text-gray-700 line-clamp-2">{oc.descricao}</p>
                {oc.resolucao && (
                  <p className="text-xs text-green-600 mt-1 font-medium">✅ {oc.resolucao}</p>
                )}
              </div>
              <div className="text-right flex-shrink-0">
                <p className="text-xs text-gray-400">
                  {oc.criado_em ? format(parseISO(oc.criado_em), 'dd/MM HH:mm') : '—'}
                </p>
                <p className="text-xs text-blue-400 mt-1">Ver detalhes →</p>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Modal Nova Ocorrência */}
      {modalNova && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-2xl w-full max-w-md">
            <div className="p-5 border-b">
              <h2 className="text-lg font-bold">Nova Ocorrência</h2>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="text-sm font-medium text-gray-700">Número da OV *</label>
                <input type="text" value={form.pedido_id}
                  onChange={e => setForm({ ...form, pedido_id: e.target.value.toUpperCase() })}
                  className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1 font-mono"
                  placeholder="Ex: OV015406" />
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Tipo *</label>
                <select value={form.tipo} onChange={e => setForm({ ...form, tipo: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1">
                  {TIPOS.map(t => <option key={t}>{t}</option>)}
                </select>
              </div>
              <div>
                <label className="text-sm font-medium text-gray-700">Descrição detalhada *</label>
                <textarea rows={4} value={form.descricao}
                  onChange={e => setForm({ ...form, descricao: e.target.value })}
                  className="w-full border rounded-lg px-3 py-2 text-sm mt-1"
                  placeholder="Descreva o que aconteceu..." />
              </div>
            </div>
            <div className="p-5 border-t flex gap-2 justify-end">
              <button onClick={() => setModalNova(false)} className="px-4 py-2 border rounded-lg text-sm">Cancelar</button>
              <button onClick={() => criarMutation.mutate()}
                disabled={criarMutation.isPending || !form.pedido_id || !form.descricao}
                className="px-4 py-2 bg-red-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
                {criarMutation.isPending ? 'Registrando...' : 'Registrar'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Modal detalhe */}
      {ocSelecionada && (
        <ModalDetalhe oc={ocSelecionada} onClose={() => setOcSelecionada(null)} />
      )}
    </div>
  )
}

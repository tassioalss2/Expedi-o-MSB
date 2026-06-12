import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { format, parseISO } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { Plus, ClipboardCheck, AlertTriangle, CheckCircle, Clock, History, X, ChevronDown, ChevronUp } from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import { useAuthStore } from '../store/authStore'

// ── helpers ───────────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<string, { label: string; cor: string }> = {
  OK:              { label: '✅ OK',              cor: 'bg-green-100 text-green-800' },
  DIVERGENCIA:     { label: '⚠ Divergência',     cor: 'bg-yellow-100 text-yellow-800' },
  EM_ANALISE:      { label: '🔍 Em análise',      cor: 'bg-orange-100 text-orange-800' },
  AJUSTE_APROVADO: { label: '✔ Ajuste aprovado', cor: 'bg-blue-100 text-blue-800' },
  RECONTAGEM:      { label: '🔄 Recontagem',      cor: 'bg-purple-100 text-purple-800' },
}

function StatusBadge({ status }: { status: string }) {
  const cfg = STATUS_CONFIG[status] || { label: status, cor: 'bg-gray-100 text-gray-700' }
  return <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${cfg.cor}`}>{cfg.label}</span>
}

function fmt(v: number | null | undefined) {
  if (v === null || v === undefined) return '—'
  const abs = Math.abs(v)
  return `${v >= 0 ? '+' : '-'}${abs}`
}

// ── Modal: Abrir Ciclo ────────────────────────────────────────────────────────

function ModalAbrirCiclo({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient()
  const hoje = new Date().toISOString().slice(0, 10)
  const [nome, setNome] = useState(`Inventário ${format(new Date(), "dd/MM/yyyy", { locale: ptBR })}`)
  const [meta, setMeta] = useState('')

  const mutation = useMutation({
    mutationFn: () => api.post('/inventario-continuo/ciclos', {
      nome,
      data_abertura: hoje,
      meta_itens: meta ? Number(meta) : null,
    }),
    onSuccess: () => {
      toast.success('Ciclo aberto!')
      qc.invalidateQueries({ queryKey: ['inv-ciclo-aberto'] })
      qc.invalidateQueries({ queryKey: ['inv-ciclos'] })
      onClose()
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || 'Erro ao abrir ciclo'),
  })

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-xl">
        <div className="p-5 border-b">
          <h2 className="text-lg font-bold">📋 Abrir Ciclo de Inventário</h2>
          <p className="text-sm text-gray-500 mt-0.5">Um ciclo agrupa todas as contagens do turno/dia</p>
        </div>
        <div className="p-5 space-y-4">
          <div>
            <label className="text-sm font-medium text-gray-700">Nome do ciclo *</label>
            <input value={nome} onChange={e => setNome(e.target.value)}
              className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700">Meta de itens a contar</label>
            <input type="number" value={meta} onChange={e => setMeta(e.target.value)}
              placeholder="Ex: 60" className="w-full border rounded-lg px-3 py-2.5 text-sm mt-1" />
          </div>
        </div>
        <div className="p-5 border-t flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 border rounded-lg text-sm">Cancelar</button>
          <button onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !nome.trim()}
            className="flex-1 py-2.5 bg-teal-600 text-white rounded-lg text-sm font-semibold disabled:opacity-50">
            {mutation.isPending ? 'Abrindo...' : '✅ Abrir Ciclo'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Modal: Revisar Divergência ────────────────────────────────────────────────

function ModalRevisar({ contagem, onClose }: { contagem: any; onClose: () => void }) {
  const qc = useQueryClient()
  const [acao, setAcao] = useState<'APROVAR' | 'RECONTAGEM'>('APROVAR')
  const [instrucao, setInstrucao] = useState('')

  const mutation = useMutation({
    mutationFn: () => api.patch(`/inventario-continuo/contagens/${contagem.id}/revisar`, {
      acao,
      instrucao_recontagem: acao === 'RECONTAGEM' ? instrucao : null,
    }),
    onSuccess: () => {
      toast.success(acao === 'APROVAR' ? 'Ajuste aprovado!' : 'Recontagem solicitada!')
      qc.invalidateQueries({ queryKey: ['inv-ciclo-aberto'] })
      qc.invalidateQueries({ queryKey: ['inv-contagens'] })
      onClose()
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || 'Erro'),
  })

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-xl">
        <div className="p-5 border-b">
          <h2 className="text-lg font-bold">🔍 Revisar Divergência</h2>
          <div className="mt-2 bg-gray-50 rounded-lg p-3 text-sm space-y-1">
            <p><span className="text-gray-500">Produto:</span> <strong>{contagem.codigo_produto}</strong></p>
            <p><span className="text-gray-500">Lote:</span> {contagem.lote}</p>
            <p><span className="text-gray-500">Operador:</span> {contagem.operador_nome}</p>
            <p>
              <span className="text-gray-500">Divergência:</span>{' '}
              <strong className={contagem.qtd_divergencia > 0 ? 'text-blue-600' : 'text-red-600'}>
                {fmt(contagem.qtd_divergencia)} un ({contagem.pct_divergencia}%)
              </strong>
            </p>
            {contagem.inventario_motivos && (
              <p><span className="text-gray-500">Motivo:</span> {contagem.inventario_motivos.descricao}</p>
            )}
            {contagem.observacao && (
              <p><span className="text-gray-500">Obs:</span> {contagem.observacao}</p>
            )}
          </div>
        </div>
        <div className="p-5 space-y-4">
          <div className="flex gap-3">
            <label className={`flex-1 flex items-center gap-2 p-3 rounded-xl border-2 cursor-pointer transition-colors ${
              acao === 'APROVAR' ? 'border-green-500 bg-green-50' : 'border-gray-200'}`}>
              <input type="radio" name="acao" value="APROVAR" checked={acao === 'APROVAR'} onChange={() => setAcao('APROVAR')} className="accent-green-600" />
              <span className="text-sm font-medium">✅ Aprovar ajuste</span>
            </label>
            <label className={`flex-1 flex items-center gap-2 p-3 rounded-xl border-2 cursor-pointer transition-colors ${
              acao === 'RECONTAGEM' ? 'border-purple-500 bg-purple-50' : 'border-gray-200'}`}>
              <input type="radio" name="acao" value="RECONTAGEM" checked={acao === 'RECONTAGEM'} onChange={() => setAcao('RECONTAGEM')} className="accent-purple-600" />
              <span className="text-sm font-medium">🔄 Recontagem</span>
            </label>
          </div>
          {acao === 'RECONTAGEM' && (
            <div>
              <label className="text-sm font-medium text-gray-700">Instrução para recontagem *</label>
              <textarea rows={2} value={instrucao} onChange={e => setInstrucao(e.target.value)}
                placeholder="Ex: Recontar apenas o lote X, verificar prateleira B3"
                className="w-full border rounded-lg px-3 py-2 text-sm mt-1" autoFocus />
            </div>
          )}
        </div>
        <div className="p-5 border-t flex gap-2">
          <button onClick={onClose} className="flex-1 py-2.5 border rounded-lg text-sm">Cancelar</button>
          <button onClick={() => mutation.mutate()}
            disabled={mutation.isPending || (acao === 'RECONTAGEM' && !instrucao.trim())}
            className={`flex-1 py-2.5 text-white rounded-lg text-sm font-semibold disabled:opacity-50 ${
              acao === 'APROVAR' ? 'bg-green-600 hover:bg-green-500' : 'bg-purple-600 hover:bg-purple-500'}`}>
            {mutation.isPending ? 'Salvando...' : acao === 'APROVAR' ? 'Confirmar Aprovação' : 'Solicitar Recontagem'}
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Card de contagem ──────────────────────────────────────────────────────────

function CardContagem({ c, onRevisar, podeRevisar }: { c: any; onRevisar: () => void; podeRevisar: boolean }) {
  const [expand, setExpand] = useState(false)
  const diverg = c.qtd_divergencia ?? 0
  const temDiverg = diverg !== 0

  return (
    <div className={`bg-white rounded-xl border shadow-sm overflow-hidden ${
      temDiverg && ['DIVERGENCIA','EM_ANALISE'].includes(c.status) ? 'border-orange-300' : 'border-gray-200'
    }`}>
      <div className="px-4 py-3 flex items-center justify-between gap-3 cursor-pointer" onClick={() => setExpand(e => !e)}>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-bold text-gray-900 font-mono text-sm">{c.codigo_produto}</span>
            <span className="text-xs text-gray-400">Lote: {c.lote}</span>
            <StatusBadge status={c.status} />
          </div>
          <div className="flex gap-4 mt-1 text-xs text-gray-500">
            <span>👤 {c.operador_nome}</span>
            <span>Sist: <strong>{c.qtd_sistemica}</strong></span>
            <span>Físico: <strong>{c.qtd_fisica ?? '—'}</strong></span>
            {temDiverg && (
              <span className={`font-bold ${diverg > 0 ? 'text-blue-600' : 'text-red-600'}`}>
                Diverg: {fmt(diverg)} ({c.pct_divergencia}%)
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          {podeRevisar && ['DIVERGENCIA','EM_ANALISE'].includes(c.status) && (
            <button onClick={e => { e.stopPropagation(); onRevisar() }}
              className="text-xs px-3 py-1.5 bg-orange-600 text-white rounded-lg font-medium hover:bg-orange-500">
              Revisar
            </button>
          )}
          {expand ? <ChevronUp size={16} className="text-gray-400" /> : <ChevronDown size={16} className="text-gray-400" />}
        </div>
      </div>
      {expand && (
        <div className="border-t px-4 py-3 bg-gray-50 text-xs text-gray-600 space-y-1">
          <p><span className="text-gray-400">Venda/Mov.:</span> {c.qtd_venda || 0} un</p>
          {c.inventario_motivos && <p><span className="text-gray-400">Motivo:</span> {c.inventario_motivos.descricao}</p>}
          {c.observacao && <p><span className="text-gray-400">Obs:</span> {c.observacao}</p>}
          {c.instrucao_recontagem && <p className="text-purple-700"><span className="text-gray-400">Instrução:</span> {c.instrucao_recontagem}</p>}
          <p><span className="text-gray-400">Contado em:</span> {c.contado_em ? format(parseISO(c.contado_em), "dd/MM HH:mm", { locale: ptBR }) : '—'}</p>
        </div>
      )}
    </div>
  )
}

// ── Página principal ──────────────────────────────────────────────────────────

export function InventarioContinuo() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { usuario } = useAuthStore()
  const podeGerenciar = ['ADMIN','GERENCIA','LIDER','SUPERVISOR'].includes(usuario?.perfil || '')

  const [aba, setAba] = useState<'contagens' | 'historico'>('contagens')
  const [modalAbrir, setModalAbrir] = useState(false)
  const [contagemRevisa, setContagemRevisa] = useState<any>(null)
  const [filtroStatus, setFiltroStatus] = useState('')

  // Ciclo aberto
  const { data: cicloAberto, isLoading: loadingCiclo } = useQuery({
    queryKey: ['inv-ciclo-aberto'],
    queryFn: () => api.get('/inventario-continuo/ciclos/aberto').then(r => r.data),
    refetchInterval: 30000,
  })

  // Contagens do ciclo
  const { data: contagens = [], isLoading: loadingContagens } = useQuery({
    queryKey: ['inv-contagens', cicloAberto?.id, filtroStatus],
    queryFn: () => cicloAberto?.id
      ? api.get(`/inventario-continuo/ciclos/${cicloAberto.id}/contagens`, {
          params: filtroStatus ? { status: filtroStatus } : {},
        }).then(r => r.data)
      : [],
    enabled: !!cicloAberto?.id,
    refetchInterval: 20000,
  })

  // Histórico
  const [histCodigo, setHistCodigo] = useState('')
  const [histLote, setHistLote] = useState('')
  const { data: historico = [], isLoading: loadingHist, refetch: refetchHist } = useQuery({
    queryKey: ['inv-historico', histCodigo, histLote],
    queryFn: () => api.get('/inventario-continuo/historico', {
      params: { codigo: histCodigo || undefined, lote: histLote || undefined },
    }).then(r => r.data),
    enabled: false,
  })

  const fecharCiclo = useMutation({
    mutationFn: () => api.patch(`/inventario-continuo/ciclos/${cicloAberto?.id}/fechar`),
    onSuccess: () => {
      toast.success('Ciclo encerrado!')
      qc.invalidateQueries({ queryKey: ['inv-ciclo-aberto'] })
      qc.invalidateQueries({ queryKey: ['inv-ciclos'] })
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || 'Erro ao encerrar ciclo'),
  })

  // sem_ciclo: backend retorna {} quando não há ciclo → checar pelo campo id
  const semCiclo = !loadingCiclo && !cicloAberto?.id

  // Stats do ciclo aberto
  const stats = cicloAberto?.id ? {
    total: cicloAberto.total_contagens ?? (contagens as any[]).length,
    ok: cicloAberto.contagens_ok ?? (contagens as any[]).filter((c: any) => c.status === 'OK').length,
    emAnalise: cicloAberto.em_analise ?? (contagens as any[]).filter((c: any) => ['DIVERGENCIA','EM_ANALISE'].includes(c.status)).length,
    acuracidade: cicloAberto.acuracidade ?? 0,
  } : null

  return (
    <div className="p-6 space-y-5 max-w-4xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Inventário Contínuo</h1>
          <p className="text-sm text-gray-500">Contagem e controle de divergências de estoque</p>
        </div>
        <div className="flex gap-2">
          {cicloAberto?.id && (
            <button onClick={() => navigate('/inventario/contagem')}
              className="flex items-center gap-2 px-4 py-2.5 bg-teal-600 text-white rounded-lg text-sm font-semibold hover:bg-teal-500">
              <Plus size={16} /> Nova Contagem
            </button>
          )}
          {podeGerenciar && semCiclo && (
            <button onClick={() => setModalAbrir(true)}
              className="flex items-center gap-2 px-4 py-2.5 bg-blue-600 text-white rounded-lg text-sm font-semibold hover:bg-blue-500">
              <ClipboardCheck size={16} /> Abrir Ciclo
            </button>
          )}
        </div>
      </div>

      {/* Sem ciclo aberto */}
      {semCiclo && (
        <div className="bg-gray-50 border border-dashed border-gray-300 rounded-2xl p-10 text-center">
          <ClipboardCheck size={40} className="mx-auto text-gray-300 mb-3" />
          <p className="text-gray-500 font-medium">Nenhum ciclo de inventário aberto</p>
          <p className="text-sm text-gray-400 mt-1">
            {podeGerenciar ? 'Clique em "Abrir Ciclo" para iniciar as contagens do dia.' : 'Aguarde a liderança abrir o ciclo do dia.'}
          </p>
        </div>
      )}

      {/* Ciclo aberto — Stats */}
      {cicloAberto?.id && stats && (
        <>
          <div className="bg-white rounded-xl border border-gray-200 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
              <div>
                <h2 className="font-bold text-gray-800">{cicloAberto.nome}</h2>
                <p className="text-xs text-gray-400">
                  Aberto em {cicloAberto.data_abertura ? format(parseISO(cicloAberto.data_abertura + 'T12:00'), "dd/MM/yyyy", { locale: ptBR }) : '—'}
                  {cicloAberto.meta_itens ? ` · Meta: ${cicloAberto.meta_itens} itens` : ''}
                </p>
              </div>
              {podeGerenciar && (
                <button onClick={() => {
                  if (window.confirm('Encerrar o ciclo? Certifique-se que todas as divergências foram tratadas.')) {
                    fecharCiclo.mutate()
                  }
                }}
                  disabled={fecharCiclo.isPending}
                  className="text-xs px-3 py-1.5 border border-red-300 text-red-600 rounded-lg hover:bg-red-50">
                  Encerrar Ciclo
                </button>
              )}
            </div>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <div className="bg-gray-50 rounded-xl p-3 text-center">
                <p className="text-2xl font-bold text-gray-800">{stats.total}</p>
                <p className="text-xs text-gray-400 mt-0.5">Contagens</p>
              </div>
              <div className="bg-green-50 rounded-xl p-3 text-center">
                <p className="text-2xl font-bold text-green-700">{stats.ok}</p>
                <p className="text-xs text-gray-400 mt-0.5">Sem divergência</p>
              </div>
              <div className="bg-orange-50 rounded-xl p-3 text-center">
                <p className="text-2xl font-bold text-orange-700">{stats.emAnalise}</p>
                <p className="text-xs text-gray-400 mt-0.5">Em análise</p>
              </div>
              <div className={`rounded-xl p-3 text-center ${stats.acuracidade >= 98 ? 'bg-green-50' : stats.acuracidade >= 90 ? 'bg-yellow-50' : 'bg-red-50'}`}>
                <p className={`text-2xl font-bold ${stats.acuracidade >= 98 ? 'text-green-700' : stats.acuracidade >= 90 ? 'text-yellow-700' : 'text-red-700'}`}>
                  {stats.acuracidade}%
                </p>
                <p className="text-xs text-gray-400 mt-0.5">Acuracidade</p>
              </div>
            </div>
          </div>

          {/* Abas */}
          <div className="flex gap-1 bg-gray-100 p-1 rounded-xl w-fit">
            {(['contagens', 'historico'] as const).map(a => (
              <button key={a} onClick={() => setAba(a)}
                className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${
                  aba === a ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'}`}>
                {a === 'contagens' ? '📋 Contagens' : '🕓 Histórico'}
              </button>
            ))}
          </div>

          {/* Tab: Contagens */}
          {aba === 'contagens' && (
            <div className="space-y-3">
              {/* Filtro status */}
              <div className="flex gap-2 flex-wrap">
                {['', 'OK', 'EM_ANALISE', 'DIVERGENCIA', 'AJUSTE_APROVADO', 'RECONTAGEM'].map(s => (
                  <button key={s} onClick={() => setFiltroStatus(s)}
                    className={`text-xs px-3 py-1 rounded-full border transition-colors ${
                      filtroStatus === s ? 'bg-gray-800 text-white border-gray-800' : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400'}`}>
                    {s === '' ? 'Todos' : (STATUS_CONFIG[s]?.label ?? s)}
                  </button>
                ))}
              </div>

              {loadingContagens ? (
                <p className="text-center text-gray-400 py-8">Carregando...</p>
              ) : (contagens as any[]).length === 0 ? (
                <div className="text-center text-gray-400 py-12">
                  <ClipboardCheck size={32} className="mx-auto mb-2 text-gray-300" />
                  <p>Nenhuma contagem registrada ainda.</p>
                  <button onClick={() => navigate('/inventario/contagem')}
                    className="mt-3 text-sm text-teal-600 hover:underline">
                    + Registrar primeira contagem
                  </button>
                </div>
              ) : (
                (contagens as any[]).map((c: any) => (
                  <CardContagem key={c.id} c={c} podeRevisar={podeGerenciar}
                    onRevisar={() => setContagemRevisa(c)} />
                ))
              )}
            </div>
          )}

          {/* Tab: Histórico */}
          {aba === 'historico' && (
            <div className="space-y-4">
              <div className="flex gap-3 flex-wrap">
                <input value={histCodigo} onChange={e => setHistCodigo(e.target.value.toUpperCase())}
                  placeholder="Código do produto" className="border rounded-lg px-3 py-2 text-sm w-48" />
                <input value={histLote} onChange={e => setHistLote(e.target.value.toUpperCase())}
                  placeholder="Lote" className="border rounded-lg px-3 py-2 text-sm w-40" />
                <button onClick={() => refetchHist()}
                  className="px-4 py-2 bg-gray-800 text-white rounded-lg text-sm">🔎 Buscar</button>
              </div>
              {loadingHist ? (
                <p className="text-center text-gray-400 py-8">Buscando...</p>
              ) : (historico as any[]).length === 0 ? (
                <p className="text-center text-gray-400 py-8">Digite o código ou lote e clique em buscar.</p>
              ) : (
                (historico as any[]).map((c: any) => (
                  <div key={c.id} className="bg-white rounded-xl border border-gray-200 px-4 py-3 text-sm space-y-1">
                    <div className="flex items-center justify-between flex-wrap gap-2">
                      <span className="font-bold font-mono">{c.codigo_produto}</span>
                      <StatusBadge status={c.status} />
                    </div>
                    <div className="text-xs text-gray-500 flex gap-4 flex-wrap">
                      <span>Lote: {c.lote}</span>
                      <span>Sist: {c.qtd_sistemica} | Físico: {c.qtd_fisica ?? '—'}</span>
                      {c.qtd_divergencia !== 0 && c.qtd_divergencia != null && (
                        <span className={c.qtd_divergencia > 0 ? 'text-blue-600 font-bold' : 'text-red-600 font-bold'}>
                          Diverg: {fmt(c.qtd_divergencia)}
                        </span>
                      )}
                      <span>👤 {c.operador_nome}</span>
                      <span>{c.inventario_ciclos?.nome}</span>
                      <span>{c.contado_em ? format(parseISO(c.contado_em), "dd/MM/yy HH:mm") : '—'}</span>
                    </div>
                    {c.inventario_motivos && (
                      <p className="text-xs text-orange-600">⚠ {c.inventario_motivos.descricao}</p>
                    )}
                  </div>
                ))
              )}
            </div>
          )}
        </>
      )}

      {/* Modais */}
      {modalAbrir && <ModalAbrirCiclo onClose={() => setModalAbrir(false)} />}
      {contagemRevisa && <ModalRevisar contagem={contagemRevisa} onClose={() => setContagemRevisa(null)} />}
    </div>
  )
}

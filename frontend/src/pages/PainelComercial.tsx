import { useState, useEffect } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate, useLocation } from 'react-router-dom'
import { format } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { DollarSign, Truck, FileText, X, Pencil, CalendarDays, ChevronDown, ChevronUp, Undo2 } from 'lucide-react'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Cell } from 'recharts'
import toast from 'react-hot-toast'
import api from '../lib/api'
import { ClienteAutocomplete } from './NovoPedido'
import { hojeLocal } from '../lib/dataLocal'
import { ModalLiberarPendencia } from '../components/EstoqueVenda'
import type { Pendencia, PendenciasResp } from '../lib/crm'

export function PainelComercial() {
  const navigate = useNavigate()
  const location = useLocation()
  const qc = useQueryClient()
  const hoje = new Date()

  // Rola até a seção indicada pela âncora do menu (#faturamento, #canais, ...)
  useEffect(() => {
    if (!location.hash) return
    const el = document.getElementById(location.hash.slice(1))
    if (el) setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'start' }), 100)
  }, [location.hash])

  // Mês de referência dos cards financeiros (default: mês corrente)
  const [mesFinanceiro, setMesFinanceiro] = useState(() => new Date(hoje.getFullYear(), hoje.getMonth(), 1))
  const ehMesAtual = mesFinanceiro.getFullYear() === hoje.getFullYear() && mesFinanceiro.getMonth() === hoje.getMonth()
  const inicioFinanceiro = format(new Date(mesFinanceiro.getFullYear(), mesFinanceiro.getMonth(), 1), 'yyyy-MM-dd')
  const fimFinanceiro = ehMesAtual
    ? format(hoje, 'yyyy-MM-dd')
    : format(new Date(mesFinanceiro.getFullYear(), mesFinanceiro.getMonth() + 1, 0), 'yyyy-MM-dd')
  // Inclui os próximos 3 meses (para planejar metas) + o atual + meses passados
  const mesesDisponiveis = Array.from({ length: 15 }, (_, i) =>
    new Date(hoje.getFullYear(), hoje.getMonth() + 3 - i, 1)
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

  // Metas por canal (total = soma dos canais)
  const competenciaStr = format(mesFinanceiro, 'yyyy-MM')
  const { data: meta } = useQuery<{ competencia: string; valor: number | null; por_canal: Record<string, number | null> }>({
    queryKey: ['meta', competenciaStr],
    queryFn: () => api.get(`/pedidos/meta?competencia=${competenciaStr}`).then(r => r.data),
  })

  const [editandoCanal, setEditandoCanal] = useState<string | null>(null)
  const [valorMeta, setValorMeta] = useState('')

  const salvarMeta = useMutation({
    mutationFn: (vars: { canal: string; valor: number }) =>
      api.put('/pedidos/meta', { competencia: competenciaStr, canal: vars.canal, valor: vars.valor }).then(r => r.data),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['meta', competenciaStr] })
      setEditandoCanal(null)
      toast.success('Meta salva')
    },
    onError: () => toast.error('Erro ao salvar meta'),
  })

  const metaValor = meta?.valor ?? null
  // Meta é sobre Vendas (exclui Transfer Price / Biomedical)
  const realizado = financeiro?.outras_vendas?.faturamento_sem_frete || 0
  const percentualMeta = metaValor && metaValor > 0 ? (realizado / metaValor) * 100 : 0
  const faltaMeta = metaValor ? metaValor - realizado : 0
  const fmtR$ = (v: number) => `R$ ${Number(v).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  // Ritmo da meta: leva em conta os dias úteis (seg-sex) já decorridos no mês.
  // A cor reflete se as vendas estão acompanhando o esperado até hoje.
  const contaDiasUteis = (ini: Date, fim: Date) => {
    let n = 0
    const d = new Date(ini)
    while (d <= fim) { const w = d.getDay(); if (w !== 0 && w !== 6) n++; d.setDate(d.getDate() + 1) }
    return n
  }
  const mesIni = new Date(mesFinanceiro.getFullYear(), mesFinanceiro.getMonth(), 1)
  const mesFim = new Date(mesFinanceiro.getFullYear(), mesFinanceiro.getMonth() + 1, 0)
  const mesFuturo = mesFinanceiro > new Date(hoje.getFullYear(), hoje.getMonth(), 1)
  const totalUteis = contaDiasUteis(mesIni, mesFim)
  const uteisPassados = mesFuturo ? 0 : ehMesAtual ? contaDiasUteis(mesIni, hoje) : totalUteis
  const fracaoTempo = totalUteis > 0 ? uteisPassados / totalUteis : 0
  const ritmoMeta = (rz: number, mt: number | null) => {
    if (!mt || mt <= 0) return { barra: 'bg-gray-300', rotulo: '', cor: 'text-gray-400', esperado: 0 }
    const esperado = mt * fracaoTempo
    if (rz >= mt) return { barra: 'bg-emerald-500', rotulo: 'meta batida 🎉', cor: 'text-emerald-600', esperado }
    if (mesFuturo || fracaoTempo === 0) return { barra: 'bg-gray-300', rotulo: 'mês não começou', cor: 'text-gray-400', esperado }
    // Avaliação suave: cedo no mês as vendas naturalmente atrasam, então o
    // limiar é tolerante e a cor usa tons leves (verde/âmbar/laranja, sem vermelho).
    const ratio = esperado > 0 ? rz / esperado : 1
    if (ratio >= 0.85) return { barra: 'bg-emerald-400', rotulo: 'no ritmo', cor: 'text-emerald-600', esperado }
    if (ratio >= 0.55) return { barra: 'bg-amber-400', rotulo: 'um pouco atrás', cor: 'text-amber-600', esperado }
    return { barra: 'bg-orange-400', rotulo: 'atrás do ritmo', cor: 'text-orange-500', esperado }
  }
  const ritmoTotal = ritmoMeta(realizado, metaValor)

  // Projeção de fechamento: extrapola o realizado pelo ritmo de dias úteis.
  // Só faz sentido no mês corrente e em andamento (0 < fração < 1).
  const projecao = ehMesAtual && fracaoTempo > 0 && fracaoTempo < 1 ? realizado / fracaoTempo : null
  const projPct = projecao != null && metaValor && metaValor > 0 ? (projecao / metaValor) * 100 : null
  const projCor = projPct == null ? 'text-gray-600'
    : projPct >= 100 ? 'text-emerald-600'
    : projPct >= 80 ? 'text-emerald-500'
    : projPct >= 60 ? 'text-amber-600' : 'text-orange-500'

  // Vendas por cliente (fase 2)
  const { data: vendasCliente = [] } = useQuery<Array<{ cliente: string; qtd: number; valor: number }>>({
    queryKey: ['vendas-por-cliente', inicioFinanceiro, fimFinanceiro],
    queryFn: () => api.get('/pedidos/dashboard/vendas-por-cliente', {
      params: { data_inicio: inicioFinanceiro, data_fim: fimFinanceiro },
    }).then(r => r.data),
    refetchInterval: 60000,
  })

  // Vendas por produto (quantidade) — itens das OVs faturadas no período
  const { data: vendasProduto = [] } = useQuery<Array<{ codigo: string; descricao: string | null; qtd: number }>>({
    queryKey: ['vendas-por-produto', inicioFinanceiro, fimFinanceiro],
    queryFn: () => api.get('/pedidos/dashboard/vendas-por-produto', {
      params: { data_inicio: inicioFinanceiro, data_fim: fimFinanceiro },
    }).then(r => r.data),
    refetchInterval: 60000,
  })

  const { data: vendasCanalResp } = useQuery<{
    canais: Array<{ canal: string; label: string; qtd: number; valor: number }>
    licitacao: { qtd: number; valor: number }
  }>({
    queryKey: ['vendas-por-canal', inicioFinanceiro, fimFinanceiro],
    queryFn: () => api.get('/pedidos/dashboard/vendas-por-canal', {
      params: { data_inicio: inicioFinanceiro, data_fim: fimFinanceiro },
    }).then(r => r.data),
    refetchInterval: 60000,
  })
  const vendasCanal = vendasCanalResp?.canais ?? []
  const licitacaoInfo = vendasCanalResp?.licitacao ?? { qtd: 0, valor: 0 }

  // Faturamento diário (Vendas sem frete) do mês selecionado — para o gráfico
  const { data: fatDiario } = useQuery<{ dias: Array<{ dia: string; valor: number; qtd: number }>; total: number }>({
    queryKey: ['faturamento-diario', inicioFinanceiro, fimFinanceiro],
    queryFn: () => api.get('/pedidos/dashboard/faturamento-diario', {
      params: { data_inicio: inicioFinanceiro, data_fim: fimFinanceiro },
    }).then(r => r.data),
    refetchInterval: 60000,
  })

  // Faturamento de HOJE (indicador) — sempre o dia real, independe do mês do gráfico
  const hojeStr = format(hoje, 'yyyy-MM-dd')
  const { data: fatHoje } = useQuery<{ dias: Array<{ dia: string; valor: number; qtd: number }>; total: number }>({
    queryKey: ['faturamento-hoje', hojeStr],
    queryFn: () => api.get('/pedidos/dashboard/faturamento-diario', {
      params: { data_inicio: hojeStr, data_fim: hojeStr },
    }).then(r => r.data),
    refetchInterval: 60000,
  })
  const vendasHoje = fatHoje?.total ?? 0
  const qtdHoje = fatHoje?.dias?.[0]?.qtd ?? 0

  // Média diária e melhor dia do mês (só dias com venda contam na média)
  const diasComVenda = (fatDiario?.dias ?? []).filter(d => d.valor > 0)
  const mediaDia = diasComVenda.length ? (fatDiario!.total / diasComVenda.length) : 0
  const melhorDia = diasComVenda.reduce<{ dia: string; valor: number } | null>(
    (acc, d) => (!acc || d.valor > acc.valor ? d : acc), null)

  // Drill-down do card financeiro: qual grupo de NFs está sendo detalhado
  const [detalheFin, setDetalheFin] = useState<{ categoria: string; titulo: string } | null>(null)
  const [modalDevolucao, setModalDevolucao] = useState(false)
  const [expandirClientes, setExpandirClientes] = useState(false)
  const { data: detalheFinLista = [], isFetching: carregandoDetalheFin } = useQuery<any[]>({
    queryKey: ['financeiro-detalhe', inicioFinanceiro, fimFinanceiro],
    queryFn: () => api.get('/pedidos/dashboard/financeiro/detalhe', {
      params: { data_inicio: inicioFinanceiro, data_fim: fimFinanceiro },
    }).then(r => r.data),
    enabled: detalheFin !== null,
  })

  const filtrarDetalheFin = (rows: any[], categoria: string) => {
    // Devolução não é faturamento, mas também não é "operação sem faturamento"
    // (bonificação/amostra/consignado) — tem card próprio.
    if (categoria === 'sem_faturamento') return rows.filter(r => !r.eh_faturamento && !r.eh_devolucao)
    if (categoria === 'devolucoes') return rows.filter(r => r.eh_devolucao && !r.eh_biomedical)
    // Vendas por canal / cliente (escopo Vendas: faturamento, sem Biomedical/Esterilize)
    // Só as OVs de licitação que ainda não foram reclassificadas em Uro/Vascular
    // (canal 'LICITACAO' puro — legado). Diferente de canal:LICITACAO, que é
    // informativo e inclui também as já reclassificadas.
    if (categoria === 'canal:LICITACAO_LEGADO') {
      return rows.filter(r => r.eh_faturamento && !r.eh_biomedical && !/ESTERILIZE/i.test(r.cliente || '') && r.canal === 'LICITACAO')
    }
    if (categoria.startsWith('canal:')) {
      const k = categoria.slice(6)
      // Licitação é dobrada no canal base: canal:URO inclui LICITACAO_URO, etc.
      const base = (c?: string) => c === 'LICITACAO_URO' ? 'URO' : c === 'LICITACAO_VASCULAR' ? 'VASCULAR' : (c || 'SEM_CANAL')
      return rows.filter(r => r.eh_faturamento && !r.eh_biomedical && !/ESTERILIZE/i.test(r.cliente || '')
        && (k === 'LICITACAO' ? /^LICITACAO/.test(r.canal || '') : base(r.canal) === k))
    }
    if (categoria.startsWith('cliente:')) {
      const nome = categoria.slice(8)
      return rows.filter(r => r.eh_faturamento && !r.eh_biomedical && r.cliente === nome)
    }
    // Vendas de um dia específico (clique no gráfico / card "hoje")
    if (categoria.startsWith('dia:')) {
      const d = categoria.slice(4)
      return rows.filter(r => r.eh_faturamento && !r.eh_biomedical && !/ESTERILIZE/i.test(r.cliente || '') && r.data === d)
    }
    // Demais categorias refletem só o que é faturamento (bate com os totais do card).
    // Transfer/outras incluem as devoluções do grupo, porque os números
    // mostrados no card são líquidos — sem isso a lista não fecha com o total.
    const fat = rows.filter(r => r.eh_faturamento)
    const fatComDev = rows.filter(r => r.eh_faturamento || r.eh_devolucao)
    switch (categoria) {
      case 'transfer': return fatComDev.filter(r => r.eh_biomedical)
      case 'outras': return fatComDev.filter(r => !r.eh_biomedical)
      case 'frete_todos': return fat.filter(r => r.valor_frete > 0)
      case 'frete_ressarcido': return fat.filter(r => r.tipo_frete === 'CIF_COM_VALOR' && r.valor_frete > 0)
      case 'frete_proprio': return fat.filter(r => r.tipo_frete === 'CIF_SEM_VALOR' && r.valor_frete > 0)
      case 'todos': return fatComDev
      default: return fat
    }
  }
  const TIPO_FRETE_LABEL: Record<string, string> = {
    FOB: 'FOB', CIF_COM_VALOR: 'CIF c/ valor', CIF_SEM_VALOR: 'CIF s/ valor',
  }
  const fmtMoeda = (v: number) => `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

  // Reclassifica uma OV de licitação legado (sem base Uro/Vascular) direto no
  // drill-down — some da lista assim que reclassificada (canal deixa de bater
  // com o filtro 'LICITACAO' puro).
  const reclassificarCanal = useMutation({
    mutationFn: ({ id, canal }: { id: string; canal: string }) =>
      api.patch(`/pedidos/${id}/canal-licitacao`, { canal }),
    onSuccess: () => {
      toast.success('OV reclassificada')
      qc.invalidateQueries({ queryKey: ['financeiro-detalhe'] })
      qc.invalidateQueries({ queryKey: ['financeiro'] })
      qc.invalidateQueries({ queryKey: ['vendas-por-canal'] })
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao reclassificar'),
  })

  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Painel Comercial</h1>
        <p className="text-gray-500 text-sm mt-0.5">
          {format(mesFinanceiro, "MMMM 'de' yyyy", { locale: ptBR })}
        </p>
      </div>

      {/* Meta do mês (total = soma das metas por canal) */}
      <div id="meta" className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 scroll-mt-4">
        <div className="flex items-center gap-2 mb-3">
          <div className="p-2 bg-green-50 rounded-lg">
            <DollarSign size={18} className="text-green-600" />
          </div>
          <div>
            <p className="text-sm font-semibold text-gray-700">Meta do mês</p>
            <p className="text-xs text-gray-400">Soma das metas por canal · {format(mesFinanceiro, 'MMMM/yyyy', { locale: ptBR })}</p>
          </div>
        </div>

        {metaValor === null ? (
          <p className="text-sm text-gray-400 py-2">
            Nenhuma meta definida. Defina as metas por canal na seção <strong>Vendas por Canal</strong> abaixo.
          </p>
        ) : (
          <>
            <div className="flex items-end justify-between mb-3">
              <div>
                <p className="text-xs text-gray-400">Meta total</p>
                <p className="text-2xl font-bold text-gray-800">{fmtR$(metaValor)}</p>
              </div>
              <div className="text-right">
                <p className="text-xs text-gray-400">Vendas</p>
                <p className="text-xl font-bold text-green-600">{fmtR$(realizado)}</p>
              </div>
            </div>
            <div className="bg-gray-100 rounded-full h-2 overflow-hidden">
              <div
                className={`h-2 rounded-full transition-all ${ritmoTotal.barra}`}
                style={{ width: `${Math.min(percentualMeta, 100)}%` }}
              />
            </div>
            <div className="flex items-center justify-between mt-1.5 text-xs text-gray-400">
              <span className="font-semibold text-gray-600">
                {percentualMeta.toFixed(1)}% da meta
                {ritmoTotal.rotulo && <span className={`ml-2 font-semibold ${ritmoTotal.cor}`}>· {ritmoTotal.rotulo}</span>}
              </span>
              {faltaMeta > 0 && <span>Faltam {fmtR$(faltaMeta)}</span>}
            </div>
            {!mesFuturo && metaValor > 0 && ritmoTotal.esperado > 0 && (
              <p className="text-[11px] text-gray-400 mt-1">
                Esperado até hoje: {fmtR$(ritmoTotal.esperado)} · {uteisPassados} de {totalUteis} dias úteis
              </p>
            )}
            {projecao != null && (
              <div className="mt-3 pt-3 border-t border-gray-100 flex items-start justify-between gap-3">
                <div>
                  <p className="text-[11px] text-gray-400 uppercase tracking-wide">Projeção de fechamento</p>
                  <p className={`text-lg font-bold ${projCor}`}>
                    {fmtR$(projecao)}
                    {projPct != null && <span className="text-xs font-medium ml-1.5">({projPct.toFixed(0)}% da meta)</span>}
                  </p>
                </div>
                <p className="text-[11px] text-gray-400 text-right max-w-[48%] mt-0.5">
                  Estimativa pelo ritmo atual — proporcional aos dias úteis já decorridos.
                </p>
              </div>
            )}
          </>
        )}
      </div>

      {/* Cards Financeiros */}
      <div id="faturamento" className="flex items-center justify-between scroll-mt-4">
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
            title="Ver as NFs de vendas (líquido de devolução)"
          >
            <p className="text-xs text-gray-400 uppercase tracking-wide font-semibold">Vendas · sem frete · líquido</p>
            <p className="text-3xl font-bold text-green-600 leading-tight">
              R$ {Number(financeiro?.outras_vendas_liquido?.faturamento_sem_frete || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
            </p>
            <p className="text-xs text-gray-400 mt-0.5">
              bruto: R$ {Number(financeiro?.outras_vendas?.faturamento_sem_frete || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
              <span className="text-gray-300"> · {financeiro?.outras_vendas?.qtd_nfs || 0} NF</span>
            </p>
          </div>
          {financeiro && (
            <div className="mt-3 pt-3 border-t border-gray-100 space-y-2">
              {(financeiro.devolucoes?.qtd_nfs || 0) > 0 && (
                <div
                  onClick={() => setDetalheFin({ categoria: 'devolucoes', titulo: 'Devoluções' })}
                  className="flex items-start justify-between cursor-pointer rounded-lg -mx-1 px-1 py-1 hover:bg-gray-50 transition-colors"
                >
                  <span className="flex items-center gap-1.5 text-xs text-gray-500 pt-0.5">
                    <span className="w-2 h-2 rounded-full bg-red-500 inline-block" />
                    Devoluções
                    <span className="text-gray-300">· {financeiro.devolucoes?.qtd_nfs || 0} NF</span>
                  </span>
                  <span className="text-right">
                    <span className="block text-sm font-semibold text-red-600">
                      R$ {Number(financeiro.devolucoes?.faturamento_sem_frete || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                    </span>
                    <span className="block text-[11px] text-gray-400">já descontado do líquido</span>
                  </span>
                </div>
              )}
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
                    R$ {Number(financeiro.transfer_price_liquido?.faturamento_sem_frete || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                  </span>
                  <span className="block text-[11px] text-gray-400">
                    {(financeiro.devolucoes_transfer?.qtd_nfs || 0) > 0
                      ? `líquido de devolução · não entra na meta`
                      : 'não entra na meta'}
                  </span>
                </span>
              </div>
              <div
                onClick={() => setDetalheFin({ categoria: 'todos', titulo: 'Faturamento — todas as NFs' })}
                className="flex items-center justify-between cursor-pointer rounded-lg -mx-1 px-1 py-1 hover:bg-gray-50 transition-colors"
              >
                <span className="text-xs text-gray-400">Total líquido (Vendas + Transfer)</span>
                <span className="text-sm font-medium text-gray-500">
                  R$ {Number(financeiro.faturamento_liquido?.faturamento_sem_frete || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setModalDevolucao(true)}
                className="w-full flex items-center justify-center gap-1.5 text-xs text-red-600 border border-red-200 rounded-lg py-1.5 hover:bg-red-50 transition-colors"
              >
                <Undo2 size={13} /> Registrar devolução
              </button>
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
            {financeiro?.qtd_nfs > 0 ? fmtMoeda(Number(financeiro.total_nf) / financeiro.qtd_nfs) : 'R$ 0,00'}
          </p>
          <p className="text-xs text-gray-400 mt-1">
            Frete médio: {financeiro?.qtd_com_frete > 0
              ? fmtMoeda(Number(financeiro.total_frete) / financeiro.qtd_com_frete)
              : '—'}
          </p>
        </div>
      </div>

      {/* Faturamento diário: indicador de hoje + gráfico do mês */}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        {/* Indicador — Faturamento de hoje */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 lg:col-span-1 flex flex-col">
          <div
            onClick={() => setDetalheFin({ categoria: `dia:${hojeStr}`, titulo: `Faturamento de hoje · ${format(hoje, "dd 'de' MMMM", { locale: ptBR })}` })}
            className="cursor-pointer rounded-lg -mx-1 px-1 py-0.5 hover:bg-gray-50 transition-colors"
            title="Ver as NFs faturadas hoje"
          >
            <div className="flex items-center gap-2 mb-3">
              <div className="p-2 bg-green-50 rounded-lg">
                <CalendarDays size={18} className="text-green-600" />
              </div>
              <div>
                <p className="text-sm font-semibold text-gray-700">Faturamento de hoje</p>
                <p className="text-xs text-gray-400">{format(hoje, "dd 'de' MMMM", { locale: ptBR })}</p>
              </div>
            </div>
            <p className="text-3xl font-bold text-green-600 leading-tight">{fmtR$(vendasHoje)}</p>
            <p className="text-xs text-gray-400 mt-0.5">{qtdHoje} NF · Vendas sem frete</p>
          </div>
          <div className="mt-auto pt-3 border-t border-gray-100 space-y-1.5">
            <div className="flex items-baseline justify-between">
              <span className="text-xs text-gray-500">Média/dia c/ venda</span>
              <span className="text-sm font-semibold text-gray-700 tabular-nums">{fmtR$(mediaDia)}</span>
            </div>
            {melhorDia && (
              <div className="flex items-baseline justify-between">
                <span className="text-xs text-gray-500">Melhor dia</span>
                <span className="text-sm font-semibold text-gray-700 tabular-nums">
                  {format(new Date(melhorDia.dia + 'T00:00:00'), 'dd/MM')} · {fmtR$(melhorDia.valor)}
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Gráfico — Faturamento por dia do mês */}
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 lg:col-span-3">
          <div className="flex items-baseline justify-between mb-3">
            <div>
              <h2 className="text-sm font-semibold text-gray-700">Faturamento por dia</h2>
              <p className="text-xs text-gray-400 mt-0.5">Clique numa barra para ver as NFs do dia · {format(mesFinanceiro, "MMMM 'de' yyyy", { locale: ptBR })}</p>
            </div>
            <span className="text-sm font-semibold text-gray-700 tabular-nums">Total {fmtR$(fatDiario?.total ?? 0)}</span>
          </div>
          {(fatDiario?.dias?.length ?? 0) === 0 ? (
            <div className="h-64 flex items-center justify-center text-sm text-gray-400">Sem faturamento no período</div>
          ) : (
            <ResponsiveContainer width="100%" height={256}>
              <BarChart data={fatDiario!.dias} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="#f1f5f9" />
                <XAxis
                  dataKey="dia"
                  tickFormatter={(v: string) => v.slice(8, 10)}
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  axisLine={{ stroke: '#e5e7eb' }} tickLine={false} interval="preserveStartEnd" minTickGap={8}
                />
                <YAxis
                  tickFormatter={(v: number) => v >= 1000 ? `${Math.round(v / 1000)}k` : String(v)}
                  tick={{ fontSize: 11, fill: '#94a3b8' }}
                  axisLine={false} tickLine={false} width={44}
                />
                <Tooltip
                  cursor={{ fill: 'rgba(34,197,94,0.06)' }}
                  content={({ active, payload }: any) => {
                    if (!active || !payload?.length) return null
                    const p = payload[0].payload
                    return (
                      <div className="bg-white border border-gray-200 rounded-lg shadow-sm px-3 py-2 text-xs">
                        <p className="font-semibold text-gray-700 mb-0.5 capitalize">
                          {format(new Date(p.dia + 'T00:00:00'), "EEEE, dd 'de' MMM", { locale: ptBR })}
                        </p>
                        <p className="text-green-600 font-bold text-sm">{fmtR$(p.valor)}</p>
                        <p className="text-gray-400">{p.qtd} NF</p>
                      </div>
                    )
                  }}
                />
                <Bar dataKey="valor" radius={[4, 4, 0, 0]} maxBarSize={28} className="cursor-pointer"
                  onClick={(d: any) => {
                    if (!d?.payload?.dia) return
                    setDetalheFin({
                      categoria: `dia:${d.payload.dia}`,
                      titulo: `Faturamento · ${format(new Date(d.payload.dia + 'T00:00:00'), "dd 'de' MMMM", { locale: ptBR })}`,
                    })
                  }}>
                  {fatDiario!.dias.map((d) => (
                    <Cell key={d.dia} fill={d.dia === hojeStr ? '#15803d' : '#22c55e'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          )}
        </div>
      </div>

      {/* Vendas por Canal (realizado × meta) */}
      <SecaoPendencias />

      <div id="canais" className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 scroll-mt-4">
        <div className="mb-4">
          <h2 className="text-sm font-semibold text-gray-700">Vendas por Canal</h2>
          <p className="text-xs text-gray-400 mt-0.5">Realizado × meta · sem frete · {format(mesFinanceiro, 'MMMM/yyyy', { locale: ptBR })}</p>
        </div>
        {(() => {
          const CANAIS = [
            { key: 'URO', label: 'Uro', cor: 'bg-indigo-500' },
            { key: 'VASCULAR', label: 'Vascular', cor: 'bg-rose-500' },
            { key: 'REALCLOSURE', label: 'Realclosure', cor: 'bg-amber-500' },
          ]
          const de = (k: string) => vendasCanal.find(c => c.canal === k)
          const semCanal = de('SEM_CANAL')
          const licitLegado = de('LICITACAO')  // OVs antigas sem base Uro/Vascular
          return (
            <div className="space-y-4">
              {CANAIS.map((ch) => {
                const rz = de(ch.key)?.valor || 0
                const qtd = de(ch.key)?.qtd || 0
                const mt = meta?.por_canal?.[ch.key] ?? null
                const pct = mt && mt > 0 ? (rz / mt) * 100 : 0
                const ritmo = ritmoMeta(rz, mt)
                const editing = editandoCanal === ch.key
                return (
                  <div key={ch.key}
                    onClick={() => { if (!editing) setDetalheFin({ categoria: `canal:${ch.key}`, titulo: `Vendas · ${ch.label}` }) }}
                    className={editing ? '' : 'cursor-pointer rounded-lg -mx-1 px-1 py-0.5 hover:bg-gray-50 transition-colors'}
                    title={editing ? undefined : 'Ver as NFs deste canal'}
                  >
                    <div className="flex items-baseline justify-between gap-2 mb-1">
                      <span className="text-sm font-medium text-gray-700 flex-1">
                        {ch.label}<span className="text-xs text-gray-400 font-normal ml-1.5">{qtd} NF</span>
                      </span>
                      {!editing && (
                        <>
                          <span className="text-sm font-semibold text-gray-800 tabular-nums">{fmtR$(rz)}</span>
                          <span className="text-xs text-gray-400 tabular-nums">/ {mt != null ? fmtR$(mt) : 'sem meta'}</span>
                          <button
                            onClick={(e) => { e.stopPropagation(); setValorMeta(mt != null ? String(mt) : ''); setEditandoCanal(ch.key) }}
                            className="p-1 rounded hover:bg-gray-100 text-gray-400 hover:text-gray-600"
                            title="Editar meta do canal"
                          >
                            <Pencil size={13} />
                          </button>
                        </>
                      )}
                    </div>
                    {editing ? (
                      <div className="flex items-center gap-2 my-1">
                        <span className="text-xs text-gray-500">Meta R$</span>
                        <input
                          type="number" step="0.01" value={valorMeta} autoFocus
                          onChange={(e) => setValorMeta(e.target.value)}
                          className="flex-1 text-sm border border-gray-200 rounded-lg px-2.5 py-1 focus:outline-none focus:ring-2 focus:ring-green-500"
                        />
                        <button
                          onClick={() => salvarMeta.mutate({ canal: ch.key, valor: Number(valorMeta) })}
                          disabled={salvarMeta.isPending}
                          className="px-3 py-1 bg-green-600 text-white rounded-lg text-xs font-medium hover:bg-green-500 disabled:opacity-60"
                        >
                          Salvar
                        </button>
                        <button
                          onClick={() => setEditandoCanal(null)}
                          className="px-2 py-1 border border-gray-200 text-gray-600 rounded-lg text-xs hover:bg-gray-50"
                        >
                          Cancelar
                        </button>
                      </div>
                    ) : (
                      <>
                        <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                          <div className={`h-full rounded-full ${ritmo.barra}`} style={{ width: `${Math.min(pct, 100)}%` }} />
                        </div>
                        {mt != null && (
                          <div className="flex justify-between text-[11px] text-gray-400 mt-0.5">
                            <span>
                              {pct.toFixed(1)}% da meta
                              {ritmo.rotulo && <span className={`ml-1.5 font-semibold ${ritmo.cor}`}>· {ritmo.rotulo}</span>}
                            </span>
                            {rz < mt && <span>faltam {fmtR$(mt - rz)}</span>}
                          </div>
                        )}
                      </>
                    )}
                  </div>
                )
              })}
              {licitLegado && licitLegado.valor > 0 && (
                <div
                  onClick={() => setDetalheFin({ categoria: 'canal:LICITACAO_LEGADO', titulo: 'Licitação (legado) — reclassificar em Uro/Vascular' })}
                  className="pt-3 border-t border-dashed border-gray-200 flex items-baseline justify-between gap-2 text-gray-500 cursor-pointer hover:bg-gray-50 rounded-lg -mx-1 px-1 transition-colors"
                  title="Ver e reclassificar as NFs de licitação sem base Uro/Vascular"
                >
                  <span className="text-sm flex-1">Licitação <span className="text-xs text-amber-500">(legado — reclassificar em Uro/Vascular)</span></span>
                  <span className="text-xs text-gray-400 tabular-nums">{licitLegado.qtd} NF</span>
                  <span className="text-sm font-medium tabular-nums">{fmtR$(licitLegado.valor)}</span>
                </div>
              )}
              {semCanal && semCanal.valor > 0 && (
                <div
                  onClick={() => setDetalheFin({ categoria: 'canal:SEM_CANAL', titulo: 'Vendas · sem canal' })}
                  className="pt-3 border-t border-dashed border-gray-200 flex items-baseline justify-between gap-2 text-gray-500 cursor-pointer hover:bg-gray-50 rounded-lg -mx-1 px-1 transition-colors"
                  title="Ver as NFs sem canal"
                >
                  <span className="text-sm flex-1">Sem canal <span className="text-xs text-amber-500">(preencher na OV)</span></span>
                  <span className="text-xs text-gray-400 tabular-nums">{semCanal.qtd} NF</span>
                  <span className="text-sm font-medium tabular-nums">{fmtR$(semCanal.valor)}</span>
                </div>
              )}
              {licitacaoInfo.valor > 0 && (
                <div
                  onClick={() => setDetalheFin({ categoria: 'canal:LICITACAO', titulo: 'Vendas por licitação no mês' })}
                  className="mt-1 pt-3 border-t border-gray-100 flex items-baseline justify-between gap-2 cursor-pointer hover:bg-gray-50 rounded-lg -mx-1 px-1 transition-colors"
                  title="Total de licitação no mês (já contabilizado em Uro/Vascular) — informativo"
                >
                  <span className="text-xs text-gray-500 flex-1">
                    🏛️ Vendas por licitação no mês
                    <span className="block text-[11px] text-gray-400 font-normal">informativo · já somado em Uro/Vascular</span>
                  </span>
                  <span className="text-xs text-gray-400 tabular-nums">{licitacaoInfo.qtd} NF</span>
                  <span className="text-sm font-semibold text-teal-600 tabular-nums">{fmtR$(licitacaoInfo.valor)}</span>
                </div>
              )}
            </div>
          )
        })()}
      </div>

      {/* Vendas por Cliente */}
      <div id="clientes" className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 scroll-mt-4">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-sm font-semibold text-gray-700">Vendas por Cliente</h2>
            <p className="text-xs text-gray-400 mt-0.5">Sem frete · exclui Transfer Price · {format(mesFinanceiro, 'MMMM/yyyy', { locale: ptBR })}</p>
          </div>
          <span className="text-xs text-gray-400">{vendasCliente.length} cliente(s)</span>
        </div>
        {vendasCliente.length === 0 ? (
          <p className="text-center text-gray-400 py-6 text-sm">Nenhuma venda no período</p>
        ) : (() => {
          const total = vendasCliente.reduce((a, c) => a + (c.valor || 0), 0)
          const maxV = vendasCliente[0]?.valor || 1
          const topN = vendasCliente.slice(0, 10)
          const resto = vendasCliente.slice(10)
          const restoValor = resto.reduce((a, c) => a + c.valor, 0)
          const restoQtd = resto.reduce((a, c) => a + c.qtd, 0)
          return (
            <div className="space-y-2.5">
              {topN.map((c) => (
                <div key={c.cliente}
                  onClick={() => setDetalheFin({ categoria: `cliente:${c.cliente}`, titulo: c.cliente })}
                  className="cursor-pointer rounded-lg -mx-1 px-1 py-0.5 hover:bg-gray-50 transition-colors"
                  title="Ver as NFs deste cliente"
                >
                  <div className="flex items-baseline justify-between gap-3 mb-1">
                    <span className="text-sm text-gray-700 truncate flex-1">{c.cliente}</span>
                    <span className="text-xs text-gray-400 tabular-nums">{c.qtd} NF · {((c.valor / total) * 100).toFixed(1)}%</span>
                    <span className="text-sm font-semibold text-green-700 tabular-nums w-32 text-right">{fmtR$(c.valor)}</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-green-500 rounded-full" style={{ width: `${(c.valor / maxV) * 100}%` }} />
                  </div>
                </div>
              ))}
              {resto.length > 0 && (
                <div className="pt-2 mt-1 border-t border-gray-100">
                  <button onClick={() => setExpandirClientes(v => !v)}
                    className="w-full flex items-baseline justify-between gap-3 text-gray-400 hover:text-gray-600">
                    <span className="text-xs flex-1 flex items-center gap-1">
                      {expandirClientes ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
                      + {resto.length} outros clientes
                    </span>
                    <span className="text-xs tabular-nums">{restoQtd} NF</span>
                    <span className="text-sm font-medium tabular-nums w-32 text-right">{fmtR$(restoValor)}</span>
                  </button>
                  {expandirClientes && (
                    <div className="space-y-2.5 mt-2.5">
                      {resto.map((c) => (
                        <div key={c.cliente}
                          onClick={() => setDetalheFin({ categoria: `cliente:${c.cliente}`, titulo: c.cliente })}
                          className="cursor-pointer rounded-lg -mx-1 px-1 py-0.5 hover:bg-gray-50 transition-colors"
                          title="Ver as NFs deste cliente"
                        >
                          <div className="flex items-baseline justify-between gap-3 mb-1">
                            <span className="text-sm text-gray-700 truncate flex-1">{c.cliente}</span>
                            <span className="text-xs text-gray-400 tabular-nums">{c.qtd} NF · {((c.valor / total) * 100).toFixed(1)}%</span>
                            <span className="text-sm font-semibold text-green-700 tabular-nums w-32 text-right">{fmtR$(c.valor)}</span>
                          </div>
                          <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                            <div className="h-full bg-green-500 rounded-full" style={{ width: `${(c.valor / maxV) * 100}%` }} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-baseline justify-between gap-3 pt-2 mt-1 border-t border-gray-200">
                <span className="text-sm font-semibold text-gray-700 flex-1">Total de Vendas</span>
                <span className="text-sm font-bold text-green-700 tabular-nums w-32 text-right">{fmtR$(total)}</span>
              </div>
            </div>
          )
        })()}
      </div>

      {/* Vendas por Produto (quantidade) — itens das OVs faturadas */}
      <div id="produtos" className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 scroll-mt-4">
        <div className="flex items-center justify-between mb-1">
          <h2 className="text-sm font-semibold text-gray-700">Vendas por Produto</h2>
          <span className="text-xs text-gray-400">{vendasProduto.length} produto(s)</span>
        </div>
        <p className="text-xs text-gray-400 mb-4">
          Quantidade vendida (itens das OVs) · por data de faturamento · {format(mesFinanceiro, 'MMMM/yyyy', { locale: ptBR })}
        </p>
        {vendasProduto.length === 0 ? (
          <p className="text-center text-gray-400 py-6 text-sm">Nenhuma venda registrada no período</p>
        ) : (() => {
          const totalQtd = vendasProduto.reduce((a, p) => a + (p.qtd || 0), 0)
          const maxQ = vendasProduto[0]?.qtd || 1
          const topN = vendasProduto.slice(0, 10)
          const resto = vendasProduto.slice(10)
          const restoQtd = resto.reduce((a, p) => a + p.qtd, 0)
          const fmtQtd = (n: number) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 0 })
          return (
            <div className="space-y-2.5">
              {topN.map((p) => (
                <div key={p.codigo}>
                  <div className="flex items-baseline justify-between gap-3 mb-1">
                    <span className="text-sm text-gray-700 truncate flex-1">
                      <span className="font-mono text-xs text-gray-500">{p.codigo}</span>
                      {p.descricao && <span className="text-gray-500"> · {p.descricao}</span>}
                    </span>
                    <span className="text-xs text-gray-400 tabular-nums">{((p.qtd / totalQtd) * 100).toFixed(1)}%</span>
                    <span className="text-sm font-semibold text-indigo-700 tabular-nums w-24 text-right">{fmtQtd(p.qtd)} un</span>
                  </div>
                  <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
                    <div className="h-full bg-indigo-500 rounded-full" style={{ width: `${(p.qtd / maxQ) * 100}%` }} />
                  </div>
                </div>
              ))}
              {resto.length > 0 && (
                <div className="flex items-baseline justify-between gap-3 pt-2 mt-1 border-t border-gray-100 text-gray-400">
                  <span className="text-xs flex-1">+ {resto.length} outros produtos</span>
                  <span className="text-sm font-medium tabular-nums w-24 text-right">{fmtQtd(restoQtd)} un</span>
                </div>
              )}
              <div className="flex items-baseline justify-between gap-3 pt-2 mt-1 border-t border-gray-200">
                <span className="text-sm font-semibold text-gray-700 flex-1">Total de unidades</span>
                <span className="text-sm font-bold text-indigo-700 tabular-nums w-24 text-right">{fmtQtd(totalQtd)} un</span>
              </div>
            </div>
          )
        })()}
      </div>

      {/* Modal drill-down do card financeiro */}
      {detalheFin !== null && (() => {
        const linhas = filtrarDetalheFin(detalheFinLista, detalheFin.categoria)
        const ehFrete = detalheFin.categoria.startsWith('frete')
        const ehLegado = detalheFin.categoria === 'canal:LICITACAO_LEGADO'
        const ehSemCanal = detalheFin.categoria === 'canal:SEM_CANAL'
        const podeReclassificar = ehLegado || ehSemCanal
        const opcoesCanal = ehLegado
          ? [{ value: 'LICITACAO_URO', label: 'Licit. Uro' }, { value: 'LICITACAO_VASCULAR', label: 'Licit. Vascular' }]
          : [
              { value: 'URO', label: 'Uro' }, { value: 'VASCULAR', label: 'Vascular' }, { value: 'REALCLOSURE', label: 'Realclosure' },
              { value: 'LICITACAO_URO', label: 'Licit. Uro' }, { value: 'LICITACAO_VASCULAR', label: 'Licit. Vascular' },
            ]
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
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Faturado em</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Cliente</th>
                        <th className="text-left px-4 py-2.5 text-xs font-semibold text-gray-500">Frete</th>
                        <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Valor NF</th>
                        <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">
                          {ehFrete ? 'Frete R$' : 'Sem frete'}
                        </th>
                        {podeReclassificar && <th className="text-right px-4 py-2.5 text-xs font-semibold text-gray-500">Reclassificar</th>}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100">
                      {linhas.map((r) => (
                        <tr key={r.id}
                          onClick={() => { setDetalheFin(null); navigate(`/expedicao/${r.id}`) }}
                          className="hover:bg-gray-50 cursor-pointer">
                          <td className="px-4 py-2.5 font-mono font-semibold text-indigo-700">{r.numero_pedido}</td>
                          <td className="px-4 py-2.5 font-mono text-gray-600">{r.numero_nf || '—'}</td>
                          <td className="px-4 py-2.5 text-gray-500 text-xs whitespace-nowrap">
                            {r.data ? format(new Date(r.data + 'T00:00:00'), 'dd/MM/yyyy') : '—'}
                          </td>
                          <td className="px-4 py-2.5 text-gray-700 max-w-[220px] truncate">
                            {r.eh_biomedical && <span className="w-2 h-2 rounded-full bg-purple-500 inline-block mr-1.5 align-middle" />}
                            {r.cliente}
                          </td>
                          <td className="px-4 py-2.5 text-gray-500 text-xs">{TIPO_FRETE_LABEL[r.tipo_frete] || r.tipo_frete || '—'}</td>
                          <td className="px-4 py-2.5 text-right font-medium text-gray-800">{fmtMoeda(r.valor_nf)}</td>
                          <td className="px-4 py-2.5 text-right text-gray-600">
                            {fmtMoeda(ehFrete ? r.valor_frete : r.valor_sem_frete)}
                          </td>
                          {podeReclassificar && (
                            <td className="px-4 py-2.5 text-right" onClick={(e) => e.stopPropagation()}>
                              <select
                                defaultValue=""
                                disabled={reclassificarCanal.isPending}
                                onChange={(e) => {
                                  const canal = e.target.value
                                  if (canal) reclassificarCanal.mutate({ id: r.id, canal: canal as any })
                                }}
                                className="text-xs border border-gray-300 rounded-lg px-2 py-1 disabled:opacity-50"
                              >
                                <option value="" disabled>Definir canal…</option>
                                {opcoesCanal.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                              </select>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot className="bg-gray-50 sticky bottom-0 border-t-2 border-gray-200">
                      <tr className="font-semibold text-gray-800">
                        <td className="px-4 py-3" colSpan={5}>{linhas.length} NF(s)</td>
                        <td className="px-4 py-3 text-right">{fmtMoeda(somaNf)}</td>
                        <td className="px-4 py-3 text-right">{fmtMoeda(ehFrete ? somaFrete : somaSemFrete)}</td>
                        {ehLegado && <td className="px-4 py-3" />}
                      </tr>
                    </tfoot>
                  </table>
                )}
              </div>
            </div>
          </div>
        )
      })()}

      {modalDevolucao && (
        <ModalDevolucao onClose={() => setModalDevolucao(false)} onSaved={() => {
          setModalDevolucao(false)
          qc.invalidateQueries({ queryKey: ['financeiro'] })
          qc.invalidateQueries({ queryKey: ['financeiro-detalhe'] })
        }} />
      )}
    </div>
  )
}

/** Pendências de estoque — venda fechada esperando material.
 *
 *  A mesma fonte da coluna do kanban do CRM (/crm/pendencias), para as duas telas
 *  nunca discordarem. Aqui a leitura é de conjunto: quanto de dinheiro está
 *  parado, com quem, e há quantos dias. Some da tela quando não há pendência —
 *  seção vazia todo mês treina o olho a ignorá-la.
 */
function SecaoPendencias() {
  const qc = useQueryClient()
  const [liberando, setLiberando] = useState<Pendencia | null>(null)

  const { data } = useQuery<PendenciasResp>({
    queryKey: ['crm-pendencias'],
    queryFn: () => api.get('/crm/pendencias').then(r => r.data),
    refetchInterval: 60000,
  })

  const lista = data?.pendencias || []
  if (lista.length === 0) return null

  const fmt = (v: number) => (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })

  return (
    <div id="pendencias" className="bg-white rounded-xl p-5 shadow-sm border border-gray-100 scroll-mt-4">
      <div className="flex items-center justify-between mb-1">
        <h2 className="text-sm font-semibold text-gray-700">Pendências de estoque</h2>
        <span className="text-sm font-semibold text-red-700">{fmt(data?.total || 0)}</span>
      </div>
      <p className="text-xs text-gray-400 mb-2">
        Venda fechada esperando material · {data?.quantidade} pendência(s)
        {(data?.aguardando || 0) > 0 && ` · ${data?.aguardando} sem OV aberta`}
        {(data?.parciais || 0) > 0 && ` · ${data?.parciais} com OV parcial`}
      </p>
      {/* O material que já chegou é a única coisa acionável aqui — vem antes da
          tabela para não depender de o operador varrer linha por linha. */}
      {((data?.com_estoque || 0) > 0 || (data?.com_estoque_parcial || 0) > 0) && (
        <div className="mb-4 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2 text-xs text-emerald-800">
          ✓ <strong>{data?.com_estoque || 0}</strong> já com todo o material
          {(data?.com_estoque_parcial || 0) > 0 && <> · <strong>{data?.com_estoque_parcial}</strong> com parte</>}
          {' '}— dá para destravar <strong>{fmt(data?.valor_liberavel || 0)}</strong> agora.
          {data?.estoque_desatualizado && (
            <span className="text-amber-700"> (estoque da última foto do PCP)</span>
          )}
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-[11px] uppercase text-gray-400 text-left border-b">
              <th className="py-2 pr-3 font-medium">Cliente</th>
              <th className="py-2 px-3 font-medium">OV</th>
              <th className="py-2 px-3 font-medium">Itens pendentes</th>
              <th className="py-2 px-3 font-medium">Estoque hoje</th>
              <th className="py-2 px-3 font-medium text-right">Qtd</th>
              <th className="py-2 px-3 font-medium text-right">Valor</th>
              <th className="py-2 px-3 font-medium">Previsão</th>
              <th className="py-2 px-3 font-medium text-right">Parada</th>
              <th className="py-2 pl-3" />
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100">
            {lista.map(p => (
              <tr key={`${p.fonte}-${p.id}`}
                className={p.estoque_agora?.status === 'COMPLETO'
                  ? 'bg-emerald-50/70 hover:bg-emerald-50'
                  : 'hover:bg-gray-50'}>
                <td className="py-2 pr-3">
                  <span className="font-medium text-gray-800">{p.cliente || '—'}</span>
                  <span className="block text-[11px] text-gray-400 truncate max-w-[200px]">{p.titulo}</span>
                </td>
                <td className="py-2 px-3">
                  {p.decisao === 'AGUARDAR' ? (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">sem OV</span>
                  ) : p.ov_provisoria ? (
                    <span className="text-[11px] px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">sem nº D365</span>
                  ) : (
                    <span className="text-xs text-gray-700">{p.ov_ref || '—'}</span>
                  )}
                </td>
                <td className="py-2 px-3">
                  {p.itens.map((i, idx) => (
                    <span key={idx} className="block text-[11px] text-gray-600">
                      {i.codigo || '—'} · {Number(i.qtd_pendente) || 0} un
                    </span>
                  ))}
                </td>
                <td className="py-2 px-3">
                  {p.estoque_agora?.status === 'COMPLETO' ? (
                    <span className="text-[11px] font-semibold px-1.5 py-0.5 rounded bg-emerald-600 text-white whitespace-nowrap">
                      ✓ chegou tudo
                    </span>
                  ) : p.estoque_agora?.status === 'PARCIAL' ? (
                    <span className="text-[11px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 whitespace-nowrap">
                      parte · {fmt(p.estoque_agora.valor_disponivel)}
                    </span>
                  ) : (
                    <span className="text-[11px] text-gray-400">sem material</span>
                  )}
                </td>
                <td className="py-2 px-3 text-right tabular-nums text-gray-700">{Number(p.qtd_total) || 0}</td>
                <td className="py-2 px-3 text-right tabular-nums font-medium text-red-700">{fmt(p.valor)}</td>
                <td className="py-2 px-3 text-[11px] text-gray-500">
                  {p.previsao_pcp
                    ? `PCP ${format(new Date(p.previsao_pcp + 'T12:00:00'), 'dd/MM')}`
                    : p.cobre_com_sa && p.previsao_sa
                      ? `SA ~${format(new Date(p.previsao_sa + 'T12:00:00'), 'dd/MM')}`
                      : '—'}
                </td>
                <td className={`py-2 px-3 text-right tabular-nums text-xs ${(p.dias_parada || 0) >= 15 ? 'text-red-600 font-medium' : 'text-gray-500'}`}>
                  {p.dias_parada != null ? `${p.dias_parada}d` : '—'}
                </td>
                <td className="py-2 pl-3 text-right">
                  <button onClick={() => setLiberando(p)} disabled={!p.pode_liberar}
                    title={p.motivo_bloqueio || undefined}
                    className={`text-[11px] font-medium px-2 py-1 rounded-lg disabled:bg-gray-100 disabled:text-gray-400 text-white whitespace-nowrap ${
                      p.estoque_agora?.status === 'NENHUM'
                        ? 'bg-gray-400 hover:bg-gray-500' : 'bg-emerald-600 hover:bg-emerald-500'}`}>
                    {p.pode_liberar ? 'Liberar' : 'Bloqueada'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {liberando && (
        <ModalLiberarPendencia pendencia={liberando} onClose={() => setLiberando(null)}
          onLiberado={() => {
            qc.invalidateQueries({ queryKey: ['crm-pendencias'] })
            qc.invalidateQueries({ queryKey: ['pedidos'] })
          }} />
      )}
    </div>
  )
}

function ModalDevolucao({ onClose, onSaved }: { onClose: () => void; onSaved: () => void }) {
  const [clienteId, setClienteId] = useState('')
  const [clienteNome, setClienteNome] = useState('')
  const [numeroPedido, setNumeroPedido] = useState('')
  const [numeroNf, setNumeroNf] = useState('')
  const [valor, setValor] = useState('')
  const [canal, setCanal] = useState('')
  const [dataDevolucao, setDataDevolucao] = useState(hojeLocal())
  const [motivo, setMotivo] = useState('')

  const mutation = useMutation({
    mutationFn: () => api.post('/pedidos/devolucao', {
      numero_pedido: numeroPedido.trim().toUpperCase(),
      cliente_id: clienteId,
      numero_nf: numeroNf.trim(),
      valor: Number(valor),
      canal: canal || null,
      data_devolucao: dataDevolucao,
      motivo: motivo || null,
    }),
    onSuccess: () => {
      toast.success('Devolução registrada')
      onSaved()
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Erro ao registrar devolução'),
  })

  const podeSalvar = clienteId && numeroPedido.trim() && numeroNf.trim() && Number(valor) > 0

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-md shadow-xl">
        <div className="p-5 border-b flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold flex items-center gap-2"><Undo2 size={18} className="text-red-600" /> Registrar Devolução</h2>
            <p className="text-xs text-gray-400 mt-0.5">Não soma no faturamento bruto — desconta do líquido, igual ao D365.</p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="text-sm font-medium text-gray-700">Cliente *</label>
            <ClienteAutocomplete value={clienteId} onChange={(id, nome) => { setClienteId(id); setClienteNome(nome) }} />
            {clienteId && <p className="text-xs text-green-600 mt-1">✅ {clienteNome}</p>}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-gray-700">Identificador (interno) *</label>
              <input value={numeroPedido} onChange={e => setNumeroPedido(e.target.value)}
                placeholder="Ex: DEV20249" className="w-full border rounded-lg px-3 py-2 text-sm mt-1 font-mono" />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700">Nº da nota de devolução *</label>
              <input value={numeroNf} onChange={e => setNumeroNf(e.target.value)}
                placeholder="Ex: 20249" className="w-full border rounded-lg px-3 py-2 text-sm mt-1 font-mono" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-gray-700">Valor devolvido (R$) *</label>
              <input type="number" step="0.01" min="0" value={valor} onChange={e => setValor(e.target.value)}
                placeholder="0,00" className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
            </div>
            <div>
              <label className="text-sm font-medium text-gray-700">Data da devolução</label>
              <input type="date" value={dataDevolucao} onChange={e => setDataDevolucao(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
            </div>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700">Canal</label>
            <select value={canal} onChange={e => setCanal(e.target.value)} className="w-full border rounded-lg px-3 py-2 text-sm mt-1">
              <option value="">— nenhum —</option>
              <option value="URO">Uro</option>
              <option value="VASCULAR">Vascular</option>
              <option value="REALCLOSURE">Realclosure</option>
              <option value="LICITACAO_URO">Licitação - Uro</option>
              <option value="LICITACAO_VASCULAR">Licitação - Vascular</option>
            </select>
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700">Motivo</label>
            <textarea rows={2} value={motivo} onChange={e => setMotivo(e.target.value)}
              placeholder="Ex: mercadoria retornou ao estoque, será vendida a outro cliente"
              className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
          </div>
        </div>
        <div className="p-5 border-t flex gap-3">
          <button onClick={onClose} className="flex-1 py-2.5 border rounded-lg text-sm text-gray-600 hover:bg-gray-50">Cancelar</button>
          <button onClick={() => mutation.mutate()} disabled={!podeSalvar || mutation.isPending}
            className="flex-1 py-2.5 bg-red-600 hover:bg-red-500 text-white rounded-lg text-sm font-semibold disabled:opacity-50">
            {mutation.isPending ? 'Salvando...' : 'Registrar Devolução'}
          </button>
        </div>
      </div>
    </div>
  )
}

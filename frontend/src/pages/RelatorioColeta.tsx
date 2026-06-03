import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { format } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { ArrowLeft, Printer, AlertTriangle, CheckCircle, Clock, Truck } from 'lucide-react'
import api from '../lib/api'

function calcDias(dt?: string): number {
  if (!dt) return 0
  try { return Math.floor((Date.now() - new Date(dt).getTime()) / 86400000) }
  catch { return 0 }
}

interface OVColeta {
  numero_pedido: string
  cliente: string
  transportadora: string        // transportadora do pallet (BRIX, RR CARGO, etc.)
  transportadora_real: string   // transportadora real da OV (pode ser BRASPRESS, DHL, etc.)
  num_caixas?: number
  dias: number
  adicionado_em: string
  pallet_codigo: string
}

// ── Configuração visual por faixa de dias ─────────────────────
const FAIXAS = [
  { min: 0, max: 0, label: 'Coletado hoje',   cor: 'bg-green-50  border-green-300', badge: 'bg-green-100  text-green-700',  icone: '✅', prioridade: 0 },
  { min: 1, max: 2, label: '1 a 2 dias',      cor: 'bg-yellow-50 border-yellow-300',badge: 'bg-yellow-100 text-yellow-700', icone: '⚡', prioridade: 1 },
  { min: 3, max: 5, label: '3 a 5 dias',      cor: 'bg-orange-50 border-orange-300',badge: 'bg-orange-100 text-orange-700', icone: '⚠️', prioridade: 2 },
  { min: 6, max: 99,'label': '6+ dias ⛔ CRÍTICO', cor: 'bg-red-50 border-red-400',badge: 'bg-red-100 text-red-700 font-bold', icone: '🚨', prioridade: 3 },
]

function getFaixa(dias: number) {
  return FAIXAS.find(f => dias >= f.min && dias <= f.max) || FAIXAS[3]
}

function BadgeDias({ dias }: { dias: number }) {
  const f = getFaixa(dias)
  return (
    <span className={`text-sm font-bold px-3 py-1 rounded-full flex items-center gap-1.5 ${f.badge}`}>
      {f.icone}
      {dias === 0 ? 'Hoje' : `${dias} dia${dias > 1 ? 's' : ''}`}
    </span>
  )
}

export function RelatorioColeta() {
  const navigate = useNavigate()
  const hoje = format(new Date(), "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })

  const { data, isLoading } = useQuery({
    queryKey: ['relatorio-coleta'],
    queryFn: () => api.get('/pallets').then(r => r.data),
  })

  const pallets = Array.isArray(data) ? data.filter((p: any) => p?.status !== 'COLETADO') : []

  // Monta lista de OVs aguardando coleta
  const ovs: OVColeta[] = []
  for (const pallet of pallets) {
    for (const pp of (pallet.pedidos || [])) {
      if (!pp?.pedidos?.numero_pedido) continue
      const transpPallet = pallet.transportadora_nome || pallet.codigo
      const transpReal = pp.pedidos?.transportadora_nome || transpPallet
      ovs.push({
        numero_pedido: pp.pedidos.numero_pedido,
        cliente: pp.pedidos?.clientes?.nome || '—',
        transportadora: transpPallet,
        transportadora_real: transpReal,
        num_caixas: pp.num_caixas,
        dias: calcDias(pp.adicionado_em),
        adicionado_em: pp.adicionado_em,
        pallet_codigo: pallet.codigo,
      })
    }
  }

  // Ordena: mais dias primeiro
  ovs.sort((a, b) => b.dias - a.dias)

  // Agrupamentos para resumo
  const criticas = ovs.filter(o => o.dias >= 6)
  const alertas  = ovs.filter(o => o.dias >= 3 && o.dias <= 5)
  const normais  = ovs.filter(o => o.dias >= 1 && o.dias <= 2)
  const hoje_ovs = ovs.filter(o => o.dias === 0)

  // Agrupa por transportadora REAL
  const porTransp: Record<string, OVColeta[]> = {}
  for (const ov of ovs) {
    const key = ov.transportadora_real || ov.transportadora
    if (!porTransp[key]) porTransp[key] = []
    porTransp[key].push(ov)
  }

  const TRANSP_CORES: Record<string, string> = {
    'BRIX':     'bg-blue-600',
    'RR CARGO': 'bg-orange-600',
    'CORREIOS': 'bg-yellow-500',
    'OUTROS':   'bg-gray-500',
  }

  const handlePrint = () => window.print()

  if (isLoading) return <div className="p-8 text-center text-gray-400">Gerando relatório...</div>

  return (
    <div className="p-6 max-w-5xl mx-auto space-y-6 print:p-4">

      {/* Header — oculto na impressão */}
      <div className="flex items-center justify-between print:hidden">
        <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-gray-500 hover:text-gray-700">
          <ArrowLeft size={20} />
          Voltar
        </button>
        <button onClick={handlePrint}
          className="flex items-center gap-2 px-4 py-2 bg-gray-800 text-white rounded-lg text-sm font-medium hover:bg-gray-700">
          <Printer size={16} />
          Imprimir / Salvar PDF
        </button>
      </div>

      {/* Título do relatório */}
      <div className="border-b pb-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-gray-900">📦 Relatório de Coletas Pendentes</h1>
            <p className="text-gray-500 text-sm mt-0.5">Gerado em {hoje} · MSB Biomedical — Expedição</p>
          </div>
          <div className="text-right">
            <p className="text-3xl font-bold text-gray-900">{ovs.length}</p>
            <p className="text-sm text-gray-500">OVs aguardando</p>
          </div>
        </div>
      </div>

      {/* Resumo executivo */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className={`rounded-xl p-4 border-2 ${criticas.length > 0 ? 'bg-red-50 border-red-400' : 'bg-gray-50 border-gray-200'}`}>
          <p className="text-2xl font-bold text-red-700">{criticas.length}</p>
          <p className="text-sm font-semibold text-red-600">🚨 Crítico (+6 dias)</p>
          <p className="text-xs text-red-500 mt-1">Ação imediata necessária</p>
        </div>
        <div className={`rounded-xl p-4 border-2 ${alertas.length > 0 ? 'bg-orange-50 border-orange-400' : 'bg-gray-50 border-gray-200'}`}>
          <p className="text-2xl font-bold text-orange-700">{alertas.length}</p>
          <p className="text-sm font-semibold text-orange-600">⚠️ Alerta (3–5 dias)</p>
          <p className="text-xs text-orange-500 mt-1">Acionar transportadora</p>
        </div>
        <div className={`rounded-xl p-4 border-2 ${normais.length > 0 ? 'bg-yellow-50 border-yellow-400' : 'bg-gray-50 border-gray-200'}`}>
          <p className="text-2xl font-bold text-yellow-700">{normais.length}</p>
          <p className="text-sm font-semibold text-yellow-600">⚡ Atenção (1–2 dias)</p>
          <p className="text-xs text-yellow-600 mt-1">Monitorar</p>
        </div>
        <div className="rounded-xl p-4 border-2 bg-green-50 border-green-300">
          <p className="text-2xl font-bold text-green-700">{hoje_ovs.length}</p>
          <p className="text-sm font-semibold text-green-600">✅ Hoje</p>
          <p className="text-xs text-green-600 mt-1">Dentro do prazo</p>
        </div>
      </div>

      {/* Alerta principal se houver críticos */}
      {criticas.length > 0 && (
        <div className="bg-red-600 text-white rounded-xl p-4 flex items-start gap-3">
          <AlertTriangle size={22} className="flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-bold">⛔ {criticas.length} OV(s) com mais de 6 dias sem coleta!</p>
            <p className="text-sm text-red-100 mt-1">
              Transportadoras envolvidas: {[...new Set(criticas.map(o => o.transportadora))].join(', ')}
            </p>
            <p className="text-sm text-red-100">Acionar imediatamente o responsável pela transportadora.</p>
          </div>
        </div>
      )}

      {/* Tabela por transportadora */}
      {Object.entries(porTransp).map(([transp, lista], idx) => {
        const cor = TRANSP_CORES[transp] || 'bg-gray-500'
        const maxDias = Math.max(...lista.map(o => o.dias))
        const faixaMax = getFaixa(maxDias)

        return (
          <div key={transp} className={`bg-white rounded-xl shadow-sm border-2 overflow-hidden page-break-avoid ${idx > 0 ? 'mt-4' : ''} ${
            maxDias >= 6 ? 'border-red-400' : maxDias >= 3 ? 'border-orange-300' : 'border-gray-200'
          }`}>
            {/* Header transportadora */}
            <div className={`${cor} px-5 py-3 flex items-center justify-between`}>
              <div className="flex items-center gap-2">
                <Truck size={18} className="text-white" />
                <span className="text-white font-bold">{transp}</span>
                <span className="text-white text-opacity-75 text-sm">({lista.length} OV{lista.length > 1 ? 's' : ''})</span>
              </div>
              <span className={`text-xs font-bold px-2 py-1 rounded-full bg-white ${faixaMax.badge}`}>
                {faixaMax.icone} Máx: {maxDias === 0 ? 'Hoje' : `${maxDias}d`}
              </span>
            </div>

            {/* Tabela de OVs */}
            <table className="w-full text-sm">
              <thead className="bg-gray-50 border-b border-gray-100">
                <tr>
                  <th className="text-left px-4 py-2.5 text-gray-500 font-semibold">OV</th>
                  <th className="text-left px-4 py-2.5 text-gray-500 font-semibold">Cliente</th>
                  <th className="text-left px-4 py-2.5 text-gray-500 font-semibold">Transportadora</th>
                  <th className="text-center px-4 py-2.5 text-gray-500 font-semibold">Caixas</th>
                  <th className="text-center px-4 py-2.5 text-gray-500 font-semibold">No pallet desde</th>
                  <th className="text-center px-4 py-2.5 text-gray-500 font-semibold">Aguardando</th>
                  <th className="text-left px-4 py-2.5 text-gray-500 font-semibold">Ação recomendada</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {lista.map((ov, i) => {
                  const faixa = getFaixa(ov.dias)
                  const acao = ov.dias === 0 ? 'Aguardar coleta normal'
                    : ov.dias <= 2 ? 'Monitorar — contato se não vier hoje'
                    : ov.dias <= 5 ? '📞 Ligar para transportadora agora'
                    : '🚨 Escalar para supervisão — urgente'
                  const transpLabel = ov.transportadora_real !== ov.transportadora
                    ? ov.transportadora_real
                    : ov.transportadora

                  return (
                    <tr key={i} className={`${ov.dias >= 6 ? 'bg-red-50' : ov.dias >= 3 ? 'bg-orange-50' : ''}`}>
                      <td className="px-4 py-3 font-bold text-gray-900">{ov.numero_pedido}</td>
                      <td className="px-4 py-3 text-gray-700 max-w-[180px] truncate">{ov.cliente}</td>
                      <td className="px-4 py-3">
                        <span className="text-xs font-semibold text-gray-700">{transpLabel}</span>
                        {ov.transportadora === 'OUTROS' && ov.transportadora_real !== 'OUTROS' && (
                          <span className="text-xs text-gray-400 block">via OUTROS</span>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center text-gray-600">{ov.num_caixas ?? '—'}</td>
                      <td className="px-4 py-3 text-center text-gray-500 text-xs">
                        {ov.adicionado_em ? format(new Date(ov.adicionado_em), 'dd/MM HH:mm') : '—'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <BadgeDias dias={ov.dias} />
                      </td>
                      <td className="px-4 py-3 text-gray-600 text-xs font-medium">{acao}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )
      })}

      {ovs.length === 0 && (
        <div className="bg-green-50 border-2 border-green-300 rounded-xl p-12 text-center">
          <CheckCircle size={48} className="mx-auto text-green-400 mb-3" />
          <p className="text-xl font-bold text-green-700">Nenhuma OV aguardando coleta!</p>
          <p className="text-green-600 text-sm mt-1">Todos os pallets estão vazios ou já foram coletados.</p>
        </div>
      )}

      {/* Rodapé */}
      <div className="text-xs text-gray-400 text-center pt-4 border-t print:mt-8">
        ACE-MSB — Controle de Expedição · MSB Biomedical · Relatório gerado em {hoje}
      </div>

      {/* CSS de impressão */}
      <style>{`
        @media print {
          @page {
            size: A4 landscape;
            margin: 12mm 10mm;
          }
          body { font-size: 10px !important; }
          .print\\:hidden { display: none !important; }
          .print\\:p-4 { padding: 0.5rem !important; }
          .print\\:mt-8 { margin-top: 1rem !important; }

          /* Evita quebra de página no meio de uma seção */
          .page-break-avoid { page-break-inside: avoid; break-inside: avoid; }

          /* Tabela cabe na página */
          table { width: 100% !important; table-layout: fixed; }
          th, td { font-size: 9px !important; padding: 4px 6px !important; overflow: hidden; }

          /* Larguras fixas para cada coluna */
          th:nth-child(1), td:nth-child(1) { width: 72px; }  /* OV */
          th:nth-child(2), td:nth-child(2) { width: 160px; } /* Cliente */
          th:nth-child(3), td:nth-child(3) { width: 90px; }  /* Transportadora */
          th:nth-child(4), td:nth-child(4) { width: 42px; }  /* Caixas */
          th:nth-child(5), td:nth-child(5) { width: 68px; }  /* No pallet desde */
          th:nth-child(6), td:nth-child(6) { width: 72px; }  /* Aguardando */
          th:nth-child(7), td:nth-child(7) { width: auto; }  /* Ação */

          /* Sem overflow lateral */
          .max-w-5xl { max-width: 100% !important; }
          .overflow-hidden { overflow: visible !important; }

          /* Cabeçalho visível em cada tabela */
          thead { display: table-header-group; }
          tr { page-break-inside: avoid; }
        }
      `}</style>
    </div>
  )
}

import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from 'react-router-dom'
import { format, subDays, startOfWeek, startOfMonth } from 'date-fns'
import { ptBR } from 'date-fns/locale'
import { ArrowLeft, Printer, CheckCircle, Truck, Clock, TrendingUp } from 'lucide-react'
import api from '../lib/api'

function calcDias(inicio?: string, fim?: string): number {
  if (!inicio || !fim) return 0
  try { return Math.floor((new Date(fim).getTime() - new Date(inicio).getTime()) / 86400000) }
  catch { return 0 }
}

function calcHoras(inicio?: string, fim?: string): string {
  if (!inicio || !fim) return '—'
  try {
    const diff = new Date(fim).getTime() - new Date(inicio).getTime()
    const horas = Math.floor(diff / 3600000)
    const minutos = Math.floor((diff % 3600000) / 60000)
    if (horas === 0) return `${minutos}min`
    if (minutos === 0) return `${horas}h`
    return `${horas}h ${minutos}min`
  } catch { return '—' }
}

function BadgeTempoEspera({ dias }: { dias: number }) {
  const cfg = dias === 0
    ? { cor: 'bg-green-100 text-green-700',  label: 'Mesmo dia' }
    : dias <= 2
    ? { cor: 'bg-blue-100 text-blue-700',    label: `${dias}d` }
    : dias <= 5
    ? { cor: 'bg-yellow-100 text-yellow-700',label: `${dias}d` }
    : { cor: 'bg-red-100 text-red-700 font-bold', label: `${dias}d ⚠` }

  return (
    <span className={`text-xs px-2 py-0.5 rounded-full font-semibold ${cfg.cor}`}>
      {cfg.label}
    </span>
  )
}

const TRANSP_CORES: Record<string, string> = {
  'BRIX': 'bg-blue-600', 'RR CARGO': 'bg-orange-600',
  'CORREIOS': 'bg-yellow-500', 'OUTROS': 'bg-gray-500',
}

const ATALHOS = [
  { label: 'Hoje',         inicio: (h: Date) => h,                    fim: (h: Date) => h },
  { label: 'Esta semana',  inicio: (h: Date) => startOfWeek(h, { weekStartsOn: 1 }), fim: (h: Date) => h },
  { label: 'Este mês',     inicio: (h: Date) => startOfMonth(h),      fim: (h: Date) => h },
  { label: 'Últimos 7d',   inicio: (h: Date) => subDays(h, 7),        fim: (h: Date) => h },
  { label: 'Últimos 30d',  inicio: (h: Date) => subDays(h, 30),       fim: (h: Date) => h },
]

export function RelatorioColetasRealizadas() {
  const navigate = useNavigate()
  const hoje = new Date()
  const [dataInicio, setDataInicio] = useState(format(subDays(hoje, 30), 'yyyy-MM-dd'))
  const [dataFim,    setDataFim]    = useState(format(hoje, 'yyyy-MM-dd'))
  const [atalhoAtivo, setAtalhoAtivo] = useState('Últimos 30d')

  const aplicarAtalho = (a: typeof ATALHOS[0]) => {
    setDataInicio(format(a.inicio(hoje), 'yyyy-MM-dd'))
    setDataFim(format(a.fim(hoje), 'yyyy-MM-dd'))
    setAtalhoAtivo(a.label)
  }

  const { data, isLoading } = useQuery({
    queryKey: ['relatorio-coletas', dataInicio, dataFim],
    queryFn: () => api.get('/relatorio/coletas-realizadas', {
      params: { data_inicio: dataInicio, data_fim: dataFim }
    }).then(r => r.data),
  })

  interface RegistroColeta {
    numero_pedido: string
    cliente: string
    transportadora: string
    pallet_codigo: string
    adicionado_em: string
    coletado_em: string
    dias_espera: number
    tempo_formatado: string
    num_caixas?: number
    numero_nf?: string
  }

  const raw = Array.isArray(data) ? data : []
  const registros: RegistroColeta[] = raw.map((r: any) => ({
    ...r,
    dias_espera: calcDias(r.adicionado_em, r.coletado_em),
    tempo_formatado: calcHoras(r.adicionado_em, r.coletado_em),
  }))

  // Ordena por data de coleta desc
  registros.sort((a, b) => new Date(b.coletado_em).getTime() - new Date(a.coletado_em).getTime())

  // Métricas
  const totalOVs = registros.length
  const totalCaixas = registros.reduce((a, r) => a + (r.num_caixas || 0), 0)
  const mediaEspera = totalOVs > 0 ? (registros.reduce((a, r) => a + r.dias_espera, 0) / totalOVs).toFixed(1) : '—'
  const noMesmoDia = registros.filter(r => r.dias_espera === 0).length
  const acima3dias = registros.filter(r => r.dias_espera > 3).length

  // Por transportadora
  const porTransp: Record<string, RegistroColeta[]> = {}
  for (const r of registros) {
    if (!porTransp[r.transportadora]) porTransp[r.transportadora] = []
    porTransp[r.transportadora].push(r)
  }

  const agora = format(hoje, "dd/MM/yyyy 'às' HH:mm", { locale: ptBR })

  return (
    <div className="p-6 max-w-6xl mx-auto space-y-6 print:p-4">

      {/* Header */}
      <div className="flex items-center justify-between print:hidden">
        <button onClick={() => navigate(-1)} className="flex items-center gap-2 text-gray-500 hover:text-gray-700">
          <ArrowLeft size={20} /> Voltar
        </button>
        <button onClick={() => window.print()}
          className="flex items-center gap-2 px-4 py-2 bg-gray-800 text-white rounded-lg text-sm font-medium hover:bg-gray-700">
          <Printer size={16} /> Imprimir / PDF
        </button>
      </div>

      {/* Título */}
      <div className="border-b pb-4">
        <h1 className="text-2xl font-bold text-gray-900">🚛 Relatório de Coletas Realizadas</h1>
        <p className="text-gray-500 text-sm mt-0.5">Gerado em {agora} · MSB Biomedical — Expedição</p>
      </div>

      {/* Filtro de período */}
      <div className="bg-gray-50 rounded-xl p-4 print:hidden space-y-3">
        {/* Atalhos rápidos */}
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-xs font-medium text-gray-500 mr-1">Período rápido:</span>
          {ATALHOS.map(a => (
            <button
              key={a.label}
              onClick={() => aplicarAtalho(a)}
              className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border ${
                atalhoAtivo === a.label
                  ? a.label === 'Hoje'
                    ? 'bg-blue-600 text-white border-blue-600'
                    : 'bg-gray-800 text-white border-gray-800'
                  : 'bg-white text-gray-600 border-gray-300 hover:border-gray-400 hover:bg-gray-100'
              }`}
            >
              {a.label === 'Hoje' ? '📅 Hoje' : a.label}
            </button>
          ))}
        </div>

        {/* Filtro manual por data */}
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm font-medium text-gray-600">Ou defina o período:</span>
          <input
            type="date"
            value={dataInicio}
            onChange={e => { setDataInicio(e.target.value); setAtalhoAtivo('') }}
            className="border rounded-lg px-3 py-2 text-sm"
          />
          <span className="text-gray-400">até</span>
          <input
            type="date"
            value={dataFim}
            onChange={e => { setDataFim(e.target.value); setAtalhoAtivo('') }}
            className="border rounded-lg px-3 py-2 text-sm"
          />
          <span className="text-xs text-gray-400 ml-1">
            {isLoading ? 'Carregando...' : `${totalOVs} coleta(s) encontrada(s)`}
          </span>
        </div>
      </div>

      {/* Métricas */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {[
          { label: 'OVs Coletadas',    valor: totalOVs,      cor: 'text-blue-700',   bg: 'bg-blue-50',   icone: <CheckCircle size={18} className="text-blue-500" /> },
          { label: 'Total de Caixas',  valor: totalCaixas || '—', cor: 'text-gray-700', bg: 'bg-gray-50', icone: <Truck size={18} className="text-gray-400" /> },
          { label: 'Espera Média',     valor: mediaEspera === '0.0' ? 'Mesmo dia' : `${mediaEspera}d`, cor: 'text-purple-700', bg: 'bg-purple-50', icone: <Clock size={18} className="text-purple-400" /> },
          { label: 'Coletado no dia',  valor: noMesmoDia,    cor: 'text-green-700',  bg: 'bg-green-50',  icone: <TrendingUp size={18} className="text-green-500" /> },
          { label: 'Acima de 3 dias',  valor: acima3dias,    cor: acima3dias > 0 ? 'text-red-700' : 'text-gray-400', bg: acima3dias > 0 ? 'bg-red-50' : 'bg-gray-50', icone: <Clock size={18} className={acima3dias > 0 ? 'text-red-500' : 'text-gray-300'} /> },
        ].map((m, i) => (
          <div key={i} className={`rounded-xl p-4 ${m.bg} border border-gray-100`}>
            <div className="flex items-center gap-2 mb-1">{m.icone}<span className="text-xs text-gray-500">{m.label}</span></div>
            <p className={`text-2xl font-bold ${m.cor}`}>{m.valor}</p>
          </div>
        ))}
      </div>

      {/* Resumo por transportadora */}
      {Object.keys(porTransp).length > 1 && (
        <div className="bg-white rounded-xl p-5 shadow-sm border border-gray-100">
          <h2 className="font-semibold text-gray-700 mb-3">Performance por Transportadora</h2>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            {Object.entries(porTransp).map(([transp, lista]) => {
              const cor = TRANSP_CORES[transp] || 'bg-gray-500'
              const mediaT = (lista.reduce((a, r) => a + r.dias_espera, 0) / lista.length).toFixed(1)
              const maxT = Math.max(...lista.map(r => r.dias_espera))
              return (
                <div key={transp} className="rounded-lg border border-gray-200 overflow-hidden">
                  <div className={`${cor} px-3 py-2`}>
                    <p className="text-white font-bold text-sm">{transp}</p>
                  </div>
                  <div className="p-3 text-sm space-y-1">
                    <div className="flex justify-between"><span className="text-gray-500">OVs:</span><span className="font-semibold">{lista.length}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Espera média:</span><span className={`font-semibold ${Number(mediaT) > 3 ? 'text-red-600' : 'text-gray-700'}`}>{mediaT === '0.0' ? 'No dia' : `${mediaT}d`}</span></div>
                    <div className="flex justify-between"><span className="text-gray-500">Máx espera:</span><span className={`font-semibold ${maxT > 3 ? 'text-red-600' : 'text-gray-700'}`}>{maxT === 0 ? 'No dia' : `${maxT}d`}</span></div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Tabela detalhada */}
      {isLoading ? (
        <div className="text-center text-gray-400 py-8">Carregando...</div>
      ) : registros.length === 0 ? (
        <div className="bg-gray-50 border rounded-xl p-12 text-center text-gray-400">
          <Truck size={40} className="mx-auto mb-2 text-gray-200" />
          <p className="font-medium">Nenhuma coleta no período selecionado</p>
          <p className="text-sm mt-1">Tente ampliar o intervalo de datas</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-5 py-3 border-b bg-gray-50 flex items-center justify-between">
            <h2 className="font-semibold text-gray-700">Detalhamento das Coletas</h2>
            <span className="text-xs text-gray-400">{registros.length} registro(s)</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-100">
                <tr className="text-left text-gray-500">
                  <th className="px-4 py-3 font-semibold">OV</th>
                  <th className="px-4 py-3 font-semibold">NF</th>
                  <th className="px-4 py-3 font-semibold">Cliente</th>
                  <th className="px-4 py-3 font-semibold">Transportadora Real</th>
                  <th className="px-4 py-3 font-semibold text-center">Caixas</th>
                  <th className="px-4 py-3 font-semibold">Entrou no Pallet</th>
                  <th className="px-4 py-3 font-semibold">Data/Hora Coleta</th>
                  <th className="px-4 py-3 font-semibold text-center">Tempo no Pallet</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-50">
                {registros.map((r, i) => (
                  <tr key={i} className={r.dias_espera > 5 ? 'bg-red-50' : r.dias_espera > 3 ? 'bg-orange-50' : 'hover:bg-gray-50'}>
                    <td className="px-4 py-3 font-bold text-gray-900">{r.numero_pedido}</td>
                    <td className="px-4 py-3 text-blue-600 font-medium">{r.numero_nf ? `📄 ${r.numero_nf}` : '—'}</td>
                    <td className="px-4 py-3 text-gray-700 max-w-[200px]">
                      <p className="truncate">{r.cliente}</p>
                    </td>
                    <td className="px-4 py-3">
                      <p className="text-sm font-semibold text-gray-700">{r.transportadora}</p>
                      {(r as any).pallet && (r as any).pallet !== r.transportadora && (
                        <span className={`text-xs font-bold px-2 py-0.5 rounded text-white ${TRANSP_CORES[(r as any).pallet] || 'bg-gray-500'}`}>
                          Pallet: {(r as any).pallet}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-center text-gray-600">{r.num_caixas ?? '—'}</td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {r.adicionado_em ? format(new Date(r.adicionado_em), 'dd/MM/yyyy HH:mm') : '—'}
                    </td>
                    <td className="px-4 py-3 font-medium text-gray-800">
                      {r.coletado_em ? format(new Date(r.coletado_em), 'dd/MM/yyyy HH:mm') : '—'}
                    </td>
                    <td className="px-4 py-3 text-center">
                      <div className="flex flex-col items-center gap-1">
                        <BadgeTempoEspera dias={r.dias_espera} />
                        <span className="text-xs text-gray-400">{r.tempo_formatado}</span>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Rodapé */}
      <div className="text-xs text-gray-400 text-center pt-4 border-t print:mt-8">
        ACE-MSB — Controle de Expedição · MSB Biomedical · Gerado em {agora}
      </div>

      <style>{`
        @media print {
          @page {
            size: A4 landscape;
            margin: 12mm 10mm;
          }
          body { font-size: 10px !important; }
          .print\\:hidden { display: none !important; }
          .print\\:mt-8 { margin-top: 1rem !important; }
          .print\\:p-4 { padding: 0.5rem !important; }

          table { width: 100% !important; table-layout: fixed; }
          th, td { font-size: 9px !important; padding: 4px 6px !important; overflow: hidden; }

          th:nth-child(1), td:nth-child(1) { width: 72px; }  /* OV */
          th:nth-child(2), td:nth-child(2) { width: 160px; } /* Cliente */
          th:nth-child(3), td:nth-child(3) { width: 90px; }  /* Transportadora */
          th:nth-child(4), td:nth-child(4) { width: 42px; }  /* Caixas */
          th:nth-child(5), td:nth-child(5) { width: 90px; }  /* Entrou no Pallet */
          th:nth-child(6), td:nth-child(6) { width: 90px; }  /* Coleta */
          th:nth-child(7), td:nth-child(7) { width: 80px; }  /* Tempo */

          .max-w-6xl { max-width: 100% !important; }
          .overflow-hidden { overflow: visible !important; }
          .overflow-x-auto { overflow: visible !important; }
          thead { display: table-header-group; }
          tr { page-break-inside: avoid; }
        }
      `}</style>
    </div>
  )
}

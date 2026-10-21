import { useQuery } from '@tanstack/react-query'
import { Truck, AlertTriangle } from 'lucide-react'
import api from '../lib/api'

/** O frete que a transportadora deve cobrar nesta carga, pela tabela contratada.
 *
 *  Aparece depois da cubagem porque é ela que define o peso taxado: sem as
 *  medidas, a conta sairia só pelo peso real e a carga volumosa pareceria
 *  barata. O número é ESTIMATIVA — não entra pedágio, ICMS nem o trecho de
 *  redespacho — e serve para dois momentos: decidir se vale cotar fora da
 *  tabela e conferir a fatura depois.
 */

type Estimativa = {
  encontrado: boolean; motivo?: string; transportadora?: string; vigencia?: string
  destino?: string; aviso?: string | null; tem_cubagem?: boolean
  peso_real_kg?: number; peso_cubado_kg?: number; peso_taxado_kg?: number
  peso_cobrado_kg?: number; usou_peso_minimo?: boolean; fator_cubagem?: number
  tarifa_kg?: number; frete_peso?: number; ad_valorem?: number; ad_valorem_pct?: number
  gris?: number; gris_pct?: number; total?: number
  taxa_coleta?: number; taxa_entrega?: number; tipo_entrega?: string
  prazo_capital?: number; prazo_redespacho?: number; premissa_cubagem?: string
}

const brl = (v?: number | null) =>
  (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const kg = (v?: number | null) =>
  `${(Number(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} kg`

export function FreteEstimado({ pedidoId }: { pedidoId: string }) {
  const { data, isLoading } = useQuery<Estimativa>({
    queryKey: ['frete-estimado', pedidoId],
    queryFn: () => api.get(`/frete/estimativa/pedido/${pedidoId}`).then(r => r.data),
    enabled: !!pedidoId,
    staleTime: 60_000,
  })

  if (isLoading || !data) return null

  if (!data.encontrado) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 p-3">
        <p className="text-sm font-semibold text-amber-900 flex items-center gap-1.5">
          <AlertTriangle size={15} /> Frete fora da tabela — precisa cotar
        </p>
        <p className="text-[11px] text-amber-800 mt-0.5">
          {data.motivo} Peso taxado: {kg(data.peso_taxado_kg)}
          {data.peso_cubado_kg ? ` (cubado ${kg(data.peso_cubado_kg)})` : ''}.
        </p>
      </div>
    )
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
            <Truck size={15} className="text-gray-500" />
            Frete estimado — tabela {data.transportadora}
          </p>
          <p className="text-[11px] text-gray-500">
            {data.destino} · prazo {data.prazo_capital} dia(s) úteis
            {data.prazo_redespacho ? ` (interior: até ${data.prazo_redespacho})` : ''}
            {data.vigencia ? ` · tabela ${data.vigencia}` : ''}
          </p>
        </div>
        <p className="text-2xl font-bold text-gray-900 tabular-nums shrink-0">
          {brl(data.total)}
        </p>
      </div>

      <div className="mt-3 grid grid-cols-2 sm:grid-cols-3 gap-2 text-[11px]">
        <div className="rounded-lg bg-gray-50 px-2 py-1.5">
          <p className="text-gray-500">Peso cobrado</p>
          <p className="font-semibold text-gray-800">{kg(data.peso_cobrado_kg)}</p>
          <p className="text-gray-400">
            real {kg(data.peso_real_kg)} · cubado {kg(data.peso_cubado_kg)}
          </p>
        </div>
        <div className="rounded-lg bg-gray-50 px-2 py-1.5">
          <p className="text-gray-500">Frete-peso</p>
          <p className="font-semibold text-gray-800">{brl(data.frete_peso)}</p>
          <p className="text-gray-400">{brl(data.tarifa_kg)}/kg</p>
        </div>
        <div className="rounded-lg bg-gray-50 px-2 py-1.5">
          <p className="text-gray-500">Taxa de coleta</p>
          <p className="font-semibold text-gray-800">{brl(data.taxa_coleta)}</p>
          <p className="text-gray-400">por envio</p>
        </div>
        <div className="rounded-lg bg-gray-50 px-2 py-1.5">
          <p className="text-gray-500">Taxa de entrega</p>
          <p className="font-semibold text-gray-800">{brl(data.taxa_entrega)}</p>
          <p className="text-gray-400">
            {{
              CAPITAL: 'capital',
              GRANDE_CAPITAL: 'grande capital',
              INTERIOR_REDESPACHO: 'interior / redespacho',
              INTERIOR_NORTE: 'interior Norte',
            }[data.tipo_entrega || ''] || '—'}
          </p>
        </div>
        <div className="rounded-lg bg-gray-50 px-2 py-1.5">
          <p className="text-gray-500">Ad valorem</p>
          <p className="font-semibold text-gray-800">{brl(data.ad_valorem)}</p>
          <p className="text-gray-400">{data.ad_valorem_pct}% da NF</p>
        </div>
        <div className="rounded-lg bg-gray-50 px-2 py-1.5">
          <p className="text-gray-500">GRIS</p>
          <p className="font-semibold text-gray-800">{brl(data.gris)}</p>
          <p className="text-gray-400">{data.gris_pct}% da NF</p>
        </div>
      </div>

      {data.usou_peso_minimo && (
        <p className="mt-2 text-[11px] text-gray-500">
          Carga leve: cobrada pelo <strong>peso mínimo</strong> do destino
          ({kg(data.peso_cobrado_kg)}) — é a tarifa mínima da tabela.
        </p>
      )}
      {data.aviso && (
        <p className="mt-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200
                      rounded-lg px-2 py-1.5">{data.aviso}</p>
      )}
      {!data.tem_cubagem && (
        <p className="mt-2 text-[11px] text-amber-800">
          Sem cubagem registrada: a conta foi só pelo peso informado, sem volume. Carga
          volumosa vai sair mais cara do que isto.
        </p>
      )}
      <p className="mt-2 text-[10px] text-gray-400">
        Estimativa pela tabela contratada: não inclui pedágio, ICMS nem o trecho de
        redespacho. {data.premissa_cubagem}
      </p>
    </div>
  )
}

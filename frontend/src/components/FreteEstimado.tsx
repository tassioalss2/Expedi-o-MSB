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
  avisos?: string[]
  // A modalidade vem decidida do backend, pela data de entrega da OV.
  modalidade?: 'CONVENCIONAL' | 'EXPRESSO'; motivo_modalidade?: string | null
  data_entrega_alvo?: string | null; chegada_convencional?: string | null
  chegada_expresso?: string | null; nem_expresso_alcanca?: boolean
  diferenca_modalidade?: number | null
  alternativa?: { tabela?: string; total?: number } | null
  referencias?: {
    taxa_emergencia?: { ate_500kg?: number; ate_1000kg?: number }
    hora_parada?: number; reentrega_pct?: number; devolucao_pct?: number
    coleta_improdutiva_pct?: number; interior_dedicado_km?: number
    pagamento?: string; nao_incluido?: string
  }
}

const brl = (v?: number | null) =>
  (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
/** Data vem do backend como AAAA-MM-DD: fatiar evita o fuso jogar para o dia anterior. */
const dia = (iso?: string | null) =>
  iso ? `${iso.slice(8, 10)}/${iso.slice(5, 7)}` : '—'
const kg = (v?: number | null) =>
  `${(Number(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} kg`

/** `versao` carrega o que muda a conta: data de entrega, destino, valor e
 *  cubagem. Entra na chave da query para a estimativa ser refeita quando um
 *  desses muda — sem isso, corrigir a data da OV deixava na tela o cálculo da
 *  data antiga, com a modalidade errada junto. */
export function FreteEstimado({ pedidoId, versao }: {
  pedidoId: string; versao?: string
}) {
  const { data, isLoading } = useQuery<Estimativa>({
    queryKey: ['frete-estimado', pedidoId, versao || ''],
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

  const expresso = data.modalidade === 'EXPRESSO'

  return (
    <div className={`rounded-xl border p-4 ${expresso ? 'border-orange-300 bg-orange-50/40'
                                                      : 'border-gray-200 bg-white'}`}>
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-800 flex items-center gap-1.5">
            <Truck size={15} className={expresso ? 'text-orange-600' : 'text-gray-500'} />
            Frete estimado — tabela {data.transportadora}
            <span className={`text-[10px] font-bold uppercase px-1.5 py-0.5 rounded
                             ${expresso ? 'bg-orange-600 text-white'
                                        : 'bg-gray-200 text-gray-700'}`}>
              {expresso ? 'Expresso · próximo voo' : 'Convencional'}
            </span>
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

      {data.motivo_modalidade && (
        <div className={`mt-2 rounded-lg px-2.5 py-2 text-[11px] border
                        ${expresso ? 'bg-orange-100/70 border-orange-200 text-orange-900'
                                   : 'bg-gray-50 border-gray-200 text-gray-700'}`}>
          <p>
            <strong>Por que {expresso ? 'expresso' : 'convencional'}:</strong>{' '}
            {data.motivo_modalidade}
          </p>
          {expresso && data.alternativa?.total != null && (
            <p className="mt-1">
              Pelo convencional seriam {brl(data.alternativa.total)} com chegada em{' '}
              {dia(data.chegada_convencional)} — o expresso custa{' '}
              <strong>{brl(data.diferenca_modalidade)}</strong> a mais para ganhar o prazo.
            </p>
          )}
          {data.nem_expresso_alcanca && (
            <p className="mt-1 font-semibold">
              Atenção: nem o expresso alcança a data de {dia(data.data_entrega_alvo)}.
              Renegociar a data com o cliente ou cotar veículo dedicado.
            </p>
          )}
        </div>
      )}

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
      {(data.avisos?.length ? data.avisos : data.aviso ? [data.aviso] : []).map((a, i) => (
        <p key={i} className="mt-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200
                              rounded-lg px-2 py-1.5">{a}</p>
      ))}
      {!data.tem_cubagem && (
        <p className="mt-2 text-[11px] text-amber-800">
          Sem cubagem registrada: a conta foi só pelo peso informado, sem volume. Carga
          volumosa vai sair mais cara do que isto.
        </p>
      )}
      {data.referencias && (
        <details className="mt-2 text-[11px] text-gray-600">
          <summary className="cursor-pointer text-gray-500 hover:text-gray-700">
            Outras regras da tabela
          </summary>
          <ul className="mt-1.5 space-y-0.5 pl-3 list-disc marker:text-gray-300">
            {data.referencias.taxa_emergencia?.ate_500kg != null && (
              <li>
                Taxa de emergência (entrega expressa):{' '}
                {brl(data.referencias.taxa_emergencia?.ate_500kg)} até 500 kg ·{' '}
                {brl(data.referencias.taxa_emergencia?.ate_1000kg)} até 1.000 kg
              </li>
            )}
            <li>Hora parada: {brl(data.referencias.hora_parada)}/h depois da 1ª hora na coleta ou na entrega</li>
            <li>
              Reentrega {data.referencias.reentrega_pct}% · devolução{' '}
              {data.referencias.devolucao_pct}% · coleta improdutiva{' '}
              {data.referencias.coleta_improdutiva_pct}% do frete
            </li>
            <li>Veículo dedicado no interior: {brl(data.referencias.interior_dedicado_km)}/km rodado, ida e volta</li>
            <li>Pagamento: {data.referencias.pagamento?.toLowerCase()}</li>
          </ul>
        </details>
      )}
      <p className="mt-2 text-[10px] text-gray-400">
        Estimativa pela tabela contratada: não inclui{' '}
        {data.referencias?.nao_incluido?.replace(/\.$/, '') || 'pedágio, ICMS nem o trecho de redespacho'}.{' '}
        {data.premissa_cubagem}
      </p>
    </div>
  )
}

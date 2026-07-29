import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import api from '../lib/api'

interface Ritmo {
  pct_esperado: number
  status: 'BATIDA' | 'NO_RITMO' | 'POUCO_ATRAS' | 'ATRAS'
  rotulo: string
  dias_uteis_restantes: number
}
interface DiaMeta {
  data: string
  realizado: number
  nfs: number
  /** Ritmo p/ bater a meta: falta ÷ dias úteis restantes (mesmo número da
   *  Previsão de Faturamento). */
  alvo: number
  pct: number
  dias_uteis_restantes: number
  eh_dia_util: boolean
}
interface BarraMetaResp {
  competencia: string
  realizado: number
  meta: number | null
  pct: number
  falta: number
  ritmo: Ritmo | null
  dia: DiaMeta | null
}

const fmtR$ = (v: number) =>
  `R$ ${Number(v || 0).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`

const MESES = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

function fmtCompetencia(c: string) {
  const [ano, mes] = c.split('-')
  return `${MESES[Number(mes) - 1]}/${ano}`
}

const COR_RITMO: Record<Ritmo['status'], string> = {
  BATIDA: 'text-emerald-300',
  NO_RITMO: 'text-emerald-300',
  POUCO_ATRAS: 'text-amber-200',
  ATRAS: 'text-rose-200',
}
const COR_BARRA: Record<Ritmo['status'], string> = {
  BATIDA: 'bg-emerald-400',
  NO_RITMO: 'bg-emerald-400',
  POUCO_ATRAS: 'bg-amber-300',
  ATRAS: 'bg-rose-300',
}

// O dia é mais volátil que o mês (uma NF grande muda tudo), então a régua é
// frouxa de propósito: só fica vermelho quando o dia está claramente fraco.
const corDia = (pct: number) =>
  pct >= 100 ? 'bg-emerald-400' : pct >= 50 ? 'bg-amber-300' : 'bg-rose-300'
const corTextoDia = (pct: number) =>
  pct >= 100 ? 'text-emerald-300' : pct >= 50 ? 'text-amber-200' : 'text-rose-200'

/** Faturamento do mês e do dia vs meta, fixo no topo de todas as telas — para
 *  saber onde estamos sem precisar sair da tela em que se está trabalhando. */
export function BarraMeta() {
  const { data } = useQuery<BarraMetaResp>({
    queryKey: ['barra-meta'],
    queryFn: () => api.get('/home/barra-meta').then(r => r.data),
    refetchInterval: 120000,
    // Sem meta definida a barra não aparece; não vale piscar "carregando" numa
    // faixa que fica em todas as telas.
    staleTime: 60000,
  })

  if (!data || !data.meta) return null
  const cor = data.ritmo ? COR_BARRA[data.ritmo.status] : 'bg-emerald-400'

  return (
    <Link
      to="/comercial#meta"
      className="shrink-0 bg-cyan-900 text-white hover:bg-cyan-800 transition-colors"
      title="Ver o painel comercial"
    >
      {/* Uma linha só a partir de lg: abaixo disso mês + ritmo + hoje não cabem
          e empurravam a página para fora (scroll horizontal), então deixa quebrar. */}
      <div className="px-4 sm:px-6 py-2 flex items-center gap-3 sm:gap-4 flex-wrap lg:flex-nowrap">
        <span className="text-xs font-semibold whitespace-nowrap">
          Meta · {fmtCompetencia(data.competencia)}
        </span>

        {/* Barra: a marca do ritmo mostra onde deveríamos estar hoje — sem ela
            o percentual sozinho não diz se está bom ou ruim. */}
        <div className="relative flex-1 min-w-[100px] sm:min-w-[160px] h-2 bg-white/20 rounded-full overflow-hidden">
          <div className={`h-2 rounded-full transition-all ${cor}`}
            style={{ width: `${Math.min(data.pct, 100)}%` }} />
          {data.ritmo && data.ritmo.pct_esperado < 100 && (
            <span className="absolute top-0 h-2 w-0.5 bg-white/70"
              style={{ left: `${Math.min(data.ritmo.pct_esperado, 100)}%` }}
              title={`Ritmo esperado para hoje: ${data.ritmo.pct_esperado}%`} />
          )}
        </div>

        <span className="text-sm font-bold tabular-nums whitespace-nowrap">{data.pct.toFixed(1)}%</span>
        {/* Os valores absolutos do mês são o bloco mais largo e o mais
            redundante (o % já diz a posição), então são os primeiros a sair
            quando falta espaço. */}
        <span className="text-xs text-cyan-100/80 tabular-nums whitespace-nowrap hidden xl:inline">
          {fmtR$(data.realizado)} / {fmtR$(data.meta)}
        </span>

        {data.ritmo && (
          <span className={`text-xs font-semibold whitespace-nowrap ${COR_RITMO[data.ritmo.status]}`}>
            {data.ritmo.rotulo}
            {data.ritmo.status !== 'BATIDA' && data.ritmo.dias_uteis_restantes > 0 && (
              // Detalhe secundário: sai nas larguras médias para o bloco do dia
              // caber na mesma linha em vez de dobrar a altura da barra.
              <span className="text-cyan-100/70 font-normal hidden xl:inline">
                {' '}· {data.ritmo.dias_uteis_restantes} dia{data.ritmo.dias_uteis_restantes > 1 ? 's' : ''} úte{data.ritmo.dias_uteis_restantes > 1 ? 'is' : 'l'}
              </span>
            )}
          </span>
        )}

        {/* Hoje — encostado à direita, separado do bloco do mês para não virar
            uma fileira só de números sem hierarquia. */}
        {data.dia && (
          <span className="flex items-center gap-2 sm:ml-auto whitespace-nowrap"
            title={`Ritmo p/ bater a meta: ${fmtR$(data.dia.alvo)}/dia útil`
              + ` · faltam ${fmtR$(data.falta)} em ${data.dia.dias_uteis_restantes} dia(s) útil(eis)`}>
            <span className="w-px h-5 bg-white/25 hidden sm:inline-block" />
            <span className="text-xs font-semibold">Hoje</span>
            <span className="text-sm font-bold tabular-nums">{fmtR$(data.dia.realizado)}</span>
            {data.dia.eh_dia_util ? (
              <>
                <span className="relative w-10 h-2 bg-white/20 rounded-full overflow-hidden hidden sm:inline-block">
                  <span className={`absolute left-0 top-0 h-2 rounded-full ${corDia(data.dia.pct)}`}
                    style={{ width: `${Math.min(data.dia.pct, 100)}%` }} />
                </span>
                <span className={`text-xs font-semibold tabular-nums ${corTextoDia(data.dia.pct)}`}>
                  {data.dia.pct.toFixed(0)}%
                  {/* "de R$ X" em vez de só "%": sem o alvo à vista, 0% podia ser
                      lido como alvo pequeno em vez do ritmo real que falta. */}
                  <span className="text-cyan-100/70 font-normal"> de {fmtR$(data.dia.alvo)}</span>
                </span>
              </>
            ) : (
              // Fim de semana/feriado: comparar com a meta diária diria "0%" de
              // um dia em que ninguém deveria faturar.
              <span className="text-xs text-cyan-100/70">fora de dia útil</span>
            )}
          </span>
        )}
      </div>
    </Link>
  )
}

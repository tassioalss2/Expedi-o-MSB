/**
 * Solicitações da licitação — página própria.
 *
 * Nasceu dentro de "Licitações", como mais três abas, e saiu de lá a pedido do
 * Tassio. Faz sentido: aquela tela é do operador que executa a demanda — painel
 * de demandas, contratos, relatório. Esta é sobre o que CHEGA e ainda não virou
 * trabalho, e tem um público que não usa a outra: o conselho entra aqui e em
 * nenhum outro lugar.
 *
 * As três abas continuam vivendo em `licitacao/CaixaEntrada.tsx`; aqui só está
 * a casca que as organiza e guarda a aba na URL.
 */
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Activity, AlertTriangle, Building2, Inbox, RefreshCw } from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import api from '../lib/api'
import { AbaAcompanhamento, AbaCaixaEntrada, AbaOrgaos } from './licitacao/CaixaEntrada'

/** Quando o motor entregou dados por último.
 *
 * Está na tela porque uma rodada que não acontece falha EM SILÊNCIO: os mesmos
 * casos continuam ali, com a mesma cara, e quem olha conclui que nada chegou.
 * Aconteceu duas vezes por patch meu (01/09 e 08/09/2026) — nos dois casos a
 * planilha e o app pareciam atuais e não estavam. Com a hora à vista, dá para
 * desconfiar. */
function UltimaAtualizacao() {
  const { data } = useQuery({
    queryKey: ['licitacao-atualizacao'],
    queryFn: () => api.get('/licitacoes/entrada/atualizacao').then(r => r.data),
    // Um minuto: é informação de frescor, e informação de frescor velha é o
    // próprio problema que ela existe para denunciar.
    refetchInterval: 60000,
    staleTime: 30000,
  })
  if (!data?.atualizado_em) return null

  const d = new Date(data.atualizado_em)
  const quando = d.toLocaleString('pt-BR', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  })
  const horas = data.horas_atras
  const relativo = horas == null ? null
    : horas < 1 ? 'há poucos minutos'
    : horas < 24 ? `há ${Math.round(horas)}h`
    : `há ${Math.floor(horas / 24)}d`

  return (
    <div className={`flex flex-wrap items-center gap-1.5 text-xs ${
      data.atrasado ? 'font-medium text-amber-700' : 'text-gray-500'}`}
      title={`O motor lê o Outlook ${data.rodadas}. Esta é a hora da última entrega bem-sucedida.`}>
      {data.atrasado
        ? <AlertTriangle className="h-3.5 w-3.5" />
        : <RefreshCw className="h-3.5 w-3.5" />}
      <span>Atualizado em {quando}{relativo ? ` · ${relativo}` : ''}</span>
      {data.atrasado && <span>— passou de 24h: uma rodada pode ter falhado</span>}
    </div>
  )
}

type Aba = 'acompanhamento' | 'entrada' | 'orgaos'
const ABAS = [
  ['acompanhamento', 'Acompanhamento', Activity],
  ['entrada', 'Caixa de entrada', Inbox],
  ['orgaos', 'Órgãos', Building2],
] as const

export function Solicitacoes() {
  const [params, setParams] = useSearchParams()

  // O conselho só tem o acompanhamento. Ele não consegue escrever — o
  // middleware do backend recusa qualquer método que não seja leitura —, mas
  // ver telas de operação sem poder agir só gera dúvida sobre o que quebrou.
  const soAcompanha = useAuthStore((e: any) => e.usuario?.perfil) === 'CONSELHO'

  const daUrl = params.get('aba') as Aba | null
  const aba: Aba = soAcompanha
    ? 'acompanhamento'
    : (ABAS.some(([k]) => k === daUrl) ? (daUrl as Aba) : 'acompanhamento')

  const trocar = (k: Aba) => {
    const p = new URLSearchParams(params)
    if (k === 'acompanhamento') p.delete('aba')
    else p.set('aba', k)
    setParams(p, { replace: true })
  }

  return (
    <div className="p-4 sm:p-6">
      <div className="mb-1">
        <h1 className="text-xl font-semibold text-gray-900">Solicitações da licitação</h1>
        <p className="text-sm text-gray-500">
          Tudo que chega em licitacao@msbbrasil.com, lido duas vezes por dia, com o
          produto e o valor extraídos do anexo do pedido.
        </p>
        <div className="mt-1.5">
          <UltimaAtualizacao />
        </div>
      </div>

      <div className="mt-4 flex gap-1 border-b border-gray-200">
        {ABAS.filter(([k]) => !soAcompanha || k === 'acompanhamento').map(([k, label, Icone]) => (
          <button key={k} onClick={() => trocar(k)}
            className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm font-medium transition ${
              aba === k
                ? 'border-blue-600 text-blue-700'
                : 'border-transparent text-gray-500 hover:text-gray-700'}`}>
            <Icone className="h-4 w-4" />{label}
          </button>
        ))}
      </div>

      <div className="mt-5">
        {aba === 'entrada' ? <AbaCaixaEntrada />
          : aba === 'orgaos' ? <AbaOrgaos />
          : <AbaAcompanhamento />}
      </div>
    </div>
  )
}

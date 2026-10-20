import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Copy, CalendarClock, Check } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'
import type { Pedido, Cubagem } from '../types'

/** A carga indo para o grupo da transportadora.
 *
 *  Contrato com a BRIX (20/10/2026): a MSB fatura com o nome deles e manda a
 *  nota e os dados da carga no grupo do WhatsApp. São sempre os mesmos cinco
 *  dados — criticidade, prazo, origem da venda, agendamento e volumes — e todos
 *  já vivem na OV. Digitar de novo, carga a carga, é onde o dado se perde.
 */

const CRITICIDADE: Record<string, string> = {
  CRITICA: '🔴 CRÍTICA',
  ALTA: '🟠 ALTA',
  NORMAL: '🟢 Normal',
}

const dataBR = (iso?: string | null) =>
  iso ? new Date(String(iso).slice(0, 10) + 'T12:00:00').toLocaleDateString('pt-BR') : '—'

function dataHoraBR(iso?: string | null) {
  if (!iso) return ''
  const d = new Date(iso)
  return d.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric',
                                     hour: '2-digit', minute: '2-digit' })
}

/** O texto que vai no grupo. Linha que não tem dado não aparece — mensagem com
 *  "—" em metade dos campos treina todo mundo a não ler. */
export function montarMensagem(pedido: Pedido | any, cubagem?: Cubagem | any): string {
  const p = pedido || {}
  const cliente = p.cliente?.nome || p.cliente_nome || '—'
  const ehLicitacao = (p.forma_venda || '') === 'LICITACAO'
  const linhas: string[] = []

  linhas.push('📦 *CARGA MSB — COLETA*')
  linhas.push(`*NF ${p.numero_nf || '—'}* · OV ${p.numero_pedido || '—'}`)
  linhas.push(`Cliente: ${cliente}`)
  if (p.local_entrega) linhas.push(`Destino: ${p.local_entrega}`)
  linhas.push(`Tipo: ${ehLicitacao ? 'LICITAÇÃO' : 'Venda para distribuidor'}`)
  linhas.push(`Criticidade: ${CRITICIDADE[p.prioridade] || p.prioridade || 'Normal'}`)
  if (p.data_prevista_entrega) {
    linhas.push(`Prazo máximo de entrega: *${dataBR(p.data_prevista_entrega)}*`)
  }
  if (p.coleta_agendada_em) {
    linhas.push(`⏰ *ENTREGA AGENDADA: ${dataHoraBR(p.coleta_agendada_em)}*`)
    if (p.coleta_agendada_obs) linhas.push(`   ${p.coleta_agendada_obs}`)
  } else if (ehLicitacao) {
    linhas.push('Agendamento: sem hora marcada — entrega em horário comercial')
  }
  if (cubagem?.num_caixas) {
    const partes = [`${cubagem.num_caixas} volume(s)`]
    if (cubagem.peso_kg) partes.push(`${Number(cubagem.peso_kg).toLocaleString('pt-BR')} kg`)
    if (cubagem.comprimento_cm && cubagem.largura_cm && cubagem.altura_cm) {
      partes.push(`${cubagem.comprimento_cm}×${cubagem.largura_cm}×${cubagem.altura_cm} cm`)
    }
    linhas.push(`Volumes: ${partes.join(' · ')}`)
  }
  if (p.observacoes) linhas.push(`Obs.: ${p.observacoes}`)
  return linhas.join('\n')
}

export function MensagemTransportadora({ pedido, cubagem }: {
  pedido: Pedido | any; cubagem?: Cubagem | any
}) {
  const [copiado, setCopiado] = useState(false)
  const texto = montarMensagem(pedido, cubagem)

  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(texto)
      setCopiado(true)
      toast.success('Mensagem copiada — cole no grupo da transportadora.')
      setTimeout(() => setCopiado(false), 4000)
    } catch {
      toast.error('Não consegui copiar. Selecione o texto e copie à mão.')
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-3 mb-2">
        <div>
          <p className="text-sm font-semibold text-gray-800">Mensagem para a transportadora</p>
          <p className="text-[11px] text-gray-500">
            Os dados da carga como o grupo espera receber. Confira e cole no WhatsApp.
          </p>
        </div>
        <button onClick={copiar}
          className="shrink-0 flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg
                     bg-emerald-600 hover:bg-emerald-500 text-white font-medium">
          {copiado ? <Check size={15} /> : <Copy size={15} />}
          {copiado ? 'Copiado' : 'Copiar'}
        </button>
      </div>
      <pre className="whitespace-pre-wrap text-[12px] leading-relaxed text-gray-700
                      bg-gray-50 border border-gray-100 rounded-lg p-3 font-sans">
        {texto}
      </pre>
      {!cubagem?.num_caixas && (
        <p className="text-[11px] text-amber-700 mt-2">
          Sem cubagem registrada — a mensagem vai sem volumes e peso, que é o que a
          transportadora usa para conferir a carga.
        </p>
      )}
    </div>
  )
}

/** Hora marcada com o cliente ou com o órgão. Na licitação quase sempre existe,
 *  e perder a janela significa carga recusada com frete pago duas vezes. */
export function AgendamentoDaEntrega({ pedido }: { pedido: Pedido | any }) {
  const qc = useQueryClient()
  const atual = pedido?.coleta_agendada_em
    ? String(pedido.coleta_agendada_em).slice(0, 16) : ''
  const [quando, setQuando] = useState(atual)
  const [obs, setObs] = useState(pedido?.coleta_agendada_obs || '')
  const [editando, setEditando] = useState(false)

  // A data pode não existir: em muito órgão quem marca a visita é a própria
  // transportadora, e o que a MSB tem para passar são as INSTRUÇÕES — endereço
  // exato, portão, horário de recebimento, documentos que o motorista precisa
  // levar. Exigir data para salvar jogava essa informação fora.
  const salvar = useMutation({
    mutationFn: (limpar?: boolean) => api.patch(`/pedidos/${pedido.id}/agendamento`, {
      coleta_agendada_em: limpar ? null : (quando ? new Date(quando).toISOString() : null),
      observacao: limpar ? null : (obs || null),
    }),
    onSuccess: (_d, limpar) => {
      toast.success(limpar ? 'Agendamento removido.' : 'Agendamento salvo.')
      setEditando(false)
      qc.invalidateQueries({ queryKey: ['pedido', pedido.id] })
      qc.invalidateQueries({ queryKey: ['pedidos'] })
    },
    onError: (e: any) => toast.error(e?.response?.data?.detail || 'Não consegui salvar.'),
  })

  if (!editando) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2
                      border-gray-200 bg-white">
        <div className="min-w-0">
          <p className="text-xs text-gray-500">Entrega agendada · instruções</p>
          {pedido?.coleta_agendada_em ? (
            <p className="text-sm font-semibold text-indigo-700">
              {dataHoraBR(pedido.coleta_agendada_em)}
            </p>
          ) : pedido?.coleta_agendada_obs ? (
            <p className="text-sm font-semibold text-amber-700">
              a agendar pela transportadora
            </p>
          ) : (
            <p className="text-sm text-gray-400">sem hora marcada</p>
          )}
          {pedido?.coleta_agendada_obs && (
            <p className="text-[11px] text-gray-600 whitespace-pre-wrap mt-0.5">
              {pedido.coleta_agendada_obs}
            </p>
          )}
        </div>
        <button onClick={() => setEditando(true)}
          className="shrink-0 flex items-center gap-1.5 px-3 py-1.5 text-xs rounded-lg
                     border border-indigo-300 text-indigo-700 hover:bg-indigo-50">
          <CalendarClock size={14} />
          {pedido?.coleta_agendada_em || pedido?.coleta_agendada_obs ? 'Alterar' : 'Informar'}
        </button>
      </div>
    )
  }

  return (
    <div className="rounded-lg border border-indigo-300 bg-indigo-50/40 p-3 space-y-2">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <label className="text-[11px] text-gray-600">
            Data e hora <span className="text-gray-400">(se já estiver marcada)</span>
          </label>
          <input type="datetime-local" value={quando} onChange={e => setQuando(e.target.value)}
            className="w-full border rounded-lg px-2 py-1.5 text-sm mt-0.5" />
          <p className="text-[10px] text-gray-400 mt-0.5">
            Vazio = quem agenda é a transportadora, com as instruções ao lado.
          </p>
        </div>
        <div>
          <label className="text-[11px] text-gray-600">
            Instruções de entrega / o que o agendamento exige
          </label>
          <textarea value={obs} onChange={e => setObs(e.target.value)} rows={4}
            placeholder={'Endereço exato, portão, horário de recebimento, documentos '
              + 'que o motorista precisa levar, contato do órgão…'}
            className="w-full border rounded-lg px-2 py-1.5 text-sm mt-0.5" />
        </div>
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => salvar.mutate(false)}
          disabled={salvar.isPending || (!quando && !obs.trim())}
          className="px-3 py-1.5 text-xs rounded-lg bg-indigo-600 hover:bg-indigo-500
                     disabled:opacity-50 text-white font-medium">
          {salvar.isPending ? 'Salvando…' : 'Salvar agendamento'}
        </button>
        {pedido?.coleta_agendada_em && (
          <button onClick={() => salvar.mutate(true)} disabled={salvar.isPending}
            className="px-3 py-1.5 text-xs rounded-lg border border-gray-300 text-gray-600">
            Remover
          </button>
        )}
        <button onClick={() => setEditando(false)}
          className="px-3 py-1.5 text-xs rounded-lg text-gray-500">Cancelar</button>
      </div>
    </div>
  )
}

/**
 * "Já enviei este texto" — a marca que separa o montado do enviado.
 *
 * O app monta a mensagem; quem envia é a pessoa, do Outlook ou do WhatsApp.
 * Sem esta marca não havia como saber, olhando a coluna do kanban, o que já
 * tinha saído — e a dúvida custa um e-mail repetido ou, pior, um que nunca sai.
 *
 * Desmarcar existe porque clique errado acontece, e porque a mensagem muda: se
 * a cubagem for corrigida depois do envio, o texto de antes não vale mais.
 */
import { useState } from 'react'
import { Check, Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'

export type TipoAviso = 'cotacao_cif' | 'coleta_fob' | 'pendencia_nf'

export function MarcaEnviado({ pedidoId, tipo, enviado, onMudou }: {
  pedidoId: string
  tipo: TipoAviso
  /** {em, por, nome} quando já foi enviado; null/undefined quando não. */
  enviado?: { em?: string; nome?: string | null } | null
  onMudou: (novo: any) => void
}) {
  const [salvando, setSalvando] = useState(false)

  async function alternar() {
    setSalvando(true)
    try {
      const { data } = await api.patch(`/pedidos/${pedidoId}/aviso-enviado`, {
        tipo, enviado: !enviado,
      })
      onMudou(data?.avisos_enviados?.[tipo] ?? null)
      toast.success(enviado ? 'Desmarcado' : 'Marcado como enviado')
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Não consegui marcar')
    } finally {
      setSalvando(false)
    }
  }

  const quando = enviado?.em
    ? new Date(enviado.em).toLocaleString('pt-BR',
        { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
    : null

  return (
    <div className="flex items-center gap-2">
      <button onClick={alternar} disabled={salvando}
        className={`flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium transition ${
          enviado
            ? 'border border-emerald-300 bg-emerald-50 text-emerald-800 hover:bg-emerald-100'
            : 'border border-gray-300 text-gray-700 hover:bg-gray-50'}`}>
        {salvando ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
        {enviado ? 'Enviado' : 'Marcar como enviado'}
      </button>
      {enviado && (
        <span className="text-[11px] text-gray-500">
          {quando}{enviado.nome ? ` · ${enviado.nome}` : ''}
        </span>
      )}
    </div>
  )
}

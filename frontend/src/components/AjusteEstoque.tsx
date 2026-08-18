/**
 * Ajuste manual do estoque de um item.
 *
 * Existe porque a divergência é real: o PCP fotografa o estoque de manhã, o
 * material chega durante o dia, e a OV não pode ficar parada esperando a foto de
 * amanhã.
 *
 * O ajuste corrige a FOTO, não guarda um saldo — e vale só para hoje. Amanhã o
 * PCP volta a mandar. Isso está escrito na tela de propósito: quem ajusta precisa
 * saber que a correção não é permanente.
 */
import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertTriangle, PencilLine, X } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'
import { msgErro } from '../lib/crm'

export type AjusteEstoque = {
  estoque_pa: number
  pcp_dizia: number | null
  motivo: string | null
  por: string | null
  em: string | null
}

type AjusteHistorico = {
  data_ref: string
  estoque_pa: number
  pa_anterior: number | null
  motivo: string
  criado_em: string
}

const dataBR = (iso?: string | null) =>
  iso ? new Date(String(iso).slice(0, 10) + 'T12:00:00').toLocaleDateString('pt-BR') : '—'

/** Selo de "este número foi ajustado à mão", com o motivo no title. */
export function SeloAjustado({ ajuste, compacto }: { ajuste?: AjusteEstoque | null; compacto?: boolean }) {
  if (!ajuste) return null
  const detalhe = [
    ajuste.pcp_dizia != null ? `PCP dizia ${ajuste.pcp_dizia}` : null,
    ajuste.por ? `por ${ajuste.por}` : null,
    ajuste.motivo,
  ].filter(Boolean).join(' · ')
  return (
    <span title={`Ajustado à mão hoje. ${detalhe}`}
      className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 whitespace-nowrap">
      {compacto ? '✎' : '✎ ajustado'}
    </span>
  )
}

export function ModalAjusteEstoque({ codigo, descricao, paAtual, pcpDizia, onClose, onSalvo }: {
  codigo: string
  descricao?: string | null
  /** O PA em vigor agora (já com ajuste anterior, se houver). */
  paAtual?: number | null
  /** O que a foto do PCP trouxe, quando diferente do que está em vigor. */
  pcpDizia?: number | null
  onClose: () => void
  onSalvo?: () => void
}) {
  const qc = useQueryClient()
  const [qtd, setQtd] = useState(paAtual != null ? String(paAtual) : '')
  const [motivo, setMotivo] = useState('')

  const { data: historico = [] } = useQuery<AjusteHistorico[]>({
    queryKey: ['estoque-ajustes', codigo],
    queryFn: () => api.get(`/estoque/${encodeURIComponent(codigo)}/ajustes`).then(r => r.data),
  })

  const salvar = useMutation({
    mutationFn: () => api.post('/estoque/ajuste', {
      codigo, estoque_pa: Number(qtd), motivo: motivo.trim(),
    }).then(r => r.data),
    onSuccess: () => {
      toast.success('Estoque ajustado.')
      // Tudo que lê estoque tem que recarregar, senão a tela continua mostrando o
      // número antigo e quem ajustou acha que não funcionou.
      qc.invalidateQueries({ queryKey: ['estoque'] })
      qc.invalidateQueries({ queryKey: ['estoque-disponivel'] })
      qc.invalidateQueries({ queryKey: ['crm-pendencias'] })
      qc.invalidateQueries({ queryKey: ['estoque-ajustes', codigo] })
      onSalvo?.()
      onClose()
    },
    onError: (e: any) => toast.error(msgErro(e, 'Não foi possível ajustar o estoque.')),
  })

  const n = Number(qtd)
  const valido = qtd !== '' && !Number.isNaN(n) && n >= 0 && motivo.trim().length >= 5
  const diferenca = paAtual != null && qtd !== '' && !Number.isNaN(n) ? n - paAtual : null

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[85vh] flex flex-col">
        <div className="p-5 border-b flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 className="text-lg font-bold flex items-center gap-2">
              <PencilLine size={18} /> Ajustar estoque
            </h2>
            <p className="text-xs text-gray-500 mt-0.5">
              <span className="font-mono">{codigo}</span>
              {descricao && <span className="text-gray-400"> · {descricao}</span>}
            </p>
          </div>
          <button onClick={onClose} className="p-1.5 hover:bg-gray-100 rounded-lg shrink-0">
            <X size={18} />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-auto">
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-900 flex gap-2">
            <AlertTriangle size={14} className="shrink-0 mt-0.5" />
            <span>
              Isto corrige a <strong>foto de hoje</strong> e vale só hoje — amanhã o PCP
              volta a mandar. O comprometido pelas OVs continua sendo descontado por cima
              deste número, então informe o que existe <strong>na prateleira</strong>, não o
              que sobra para vender.
            </span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-sm font-medium text-gray-700">Em estoque agora (PA)</label>
              <input type="number" min="0" step="1" value={qtd} autoFocus
                onChange={e => setQtd(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
              {diferenca != null && diferenca !== 0 && (
                <p className={`text-[11px] mt-1 ${diferenca > 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                  {diferenca > 0 ? '+' : ''}{diferenca} em relação ao número atual
                </p>
              )}
            </div>
            <div className="text-xs text-gray-500 pt-7 space-y-0.5">
              {paAtual != null && <p>Número em vigor: <strong className="text-gray-700">{paAtual}</strong></p>}
              {pcpDizia != null && pcpDizia !== paAtual && <p>Foto do PCP: {pcpDizia}</p>}
            </div>
          </div>

          <div>
            <label className="text-sm font-medium text-gray-700">Motivo *</label>
            <textarea value={motivo} onChange={e => setMotivo(e.target.value)} rows={2}
              placeholder="Ex.: SA virou PA hoje e o PCP ainda não republicou a foto. Conferido na prateleira."
              className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
            <p className="text-[11px] text-gray-400 mt-0.5">
              Este número destrava OV — o motivo fica registrado com o seu nome.
            </p>
          </div>

          {historico.length > 0 && (
            <div>
              <p className="text-[11px] uppercase text-gray-400 font-medium mb-1">
                Ajustes anteriores neste item
              </p>
              <ol className="space-y-1 max-h-40 overflow-auto">
                {historico.map((h, idx) => (
                  <li key={idx} className="text-xs text-gray-600">
                    <span className="text-gray-400 tabular-nums mr-1.5">{dataBR(h.data_ref)}</span>
                    {h.pa_anterior != null && <span className="text-gray-400">{h.pa_anterior} → </span>}
                    <strong>{h.estoque_pa}</strong>
                    <span className="text-gray-500"> · {h.motivo}</span>
                  </li>
                ))}
              </ol>
            </div>
          )}
        </div>

        <div className="p-4 border-t flex justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">
            Cancelar
          </button>
          <button onClick={() => salvar.mutate()} disabled={!valido || salvar.isPending}
            title={!valido ? 'Informe a quantidade e um motivo com pelo menos 5 caracteres' : ''}
            className="px-4 py-2 text-sm bg-violet-600 hover:bg-violet-500 disabled:opacity-50 text-white font-medium rounded-lg">
            {salvar.isPending ? 'Ajustando…' : 'Ajustar estoque'}
          </button>
        </div>
      </div>
    </div>
  )
}

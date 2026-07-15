import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, CheckCircle2, Circle, Trash2, CalendarClock } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import { TIPO_ATIV_MAP, fmtDataHora, prazoCor, msgErro } from '../../lib/crm'
import { ModalNovaAtividade } from './CrmPipeline'

const ESCOPOS: { key: string; label: string }[] = [
  { key: 'atrasadas', label: 'Atrasadas' },
  { key: 'hoje', label: 'Hoje' },
  { key: 'semana', label: 'Próx. 7 dias' },
  { key: 'abertas', label: 'Todas abertas' },
  { key: 'todas', label: 'Histórico' },
]

export function CrmAtividades() {
  const qc = useQueryClient()
  const [escopo, setEscopo] = useState('abertas')
  const [nova, setNova] = useState(false)

  const { data: atividades = [], isLoading } = useQuery<any[]>({
    queryKey: ['crm-atividades', escopo],
    queryFn: () => api.get('/crm/atividades', { params: { escopo } }).then(r => r.data),
  })

  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ['crm-atividades'] })
    qc.invalidateQueries({ queryKey: ['crm-dashboard'] })
  }

  const concluir = useMutation({
    mutationFn: ({ id, c }: { id: string; c: boolean }) => api.post(`/crm/atividades/${id}/concluir?concluida=${c}`),
    onSuccess: invalidar,
  })
  const excluir = useMutation({
    mutationFn: (id: string) => api.delete(`/crm/atividades/${id}`),
    onSuccess: () => { toast.success('Atividade removida'); invalidar() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro'), { duration: 4000 }),
  })

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex gap-1 flex-1 flex-wrap">
          {ESCOPOS.map(e => (
            <button key={e.key} onClick={() => setEscopo(e.key)}
              className={`text-sm px-3 py-1.5 rounded-lg ${escopo === e.key ? 'bg-blue-600 text-white' : 'bg-white border text-gray-600 hover:bg-gray-50'}`}>
              {e.label}
            </button>
          ))}
        </div>
        <button onClick={() => setNova(true)}
          className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg">
          <Plus size={16} /> Nova atividade
        </button>
      </div>

      {isLoading ? (
        <p className="text-center text-gray-400 py-10 text-sm">Carregando…</p>
      ) : atividades.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-10 text-center text-gray-400 text-sm">
          <CalendarClock size={28} className="mx-auto mb-2 text-gray-300" />
          Nenhuma atividade nesta visão.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
          {atividades.map(a => (
            <div key={a.id} className="flex items-start gap-3 px-4 py-3 group">
              <button onClick={() => concluir.mutate({ id: a.id, c: !a.concluida })} className="mt-0.5">
                {a.concluida ? <CheckCircle2 size={18} className="text-emerald-500" /> : <Circle size={18} className="text-gray-300 hover:text-emerald-500" />}
              </button>
              <div className="flex-1 min-w-0">
                <p className={`text-sm ${a.concluida ? 'line-through text-gray-400' : 'text-gray-800'}`}>
                  <span className="mr-1">{TIPO_ATIV_MAP[a.tipo]?.icone}</span>{a.titulo}
                </p>
                <div className="flex flex-wrap gap-x-3 text-[11px] mt-0.5">
                  {a.data_hora && <span className={a.concluida ? 'text-gray-400' : prazoCor(a.data_hora)}>{fmtDataHora(a.data_hora)}</span>}
                  {a.oportunidade && <span className="text-gray-400">· {a.oportunidade}</span>}
                </div>
              </div>
              <button onClick={() => { if (confirm('Remover atividade?')) excluir.mutate(a.id) }}
                className="text-gray-300 hover:text-red-600 opacity-0 group-hover:opacity-100 transition mt-0.5"><Trash2 size={15} /></button>
            </div>
          ))}
        </div>
      )}

      {nova && <ModalNovaAtividade onClose={() => setNova(false)} onSaved={invalidar} />}
    </div>
  )
}

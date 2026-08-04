// Repasse: a ponte entre "comercial ganhou" e "OV existe no app".
//
// O passo do meio é externo — operações de vendas emite a OV no D365 e só depois
// cadastra aqui. Antes esse aviso ia por mensagem de Teams ou e-mail, então nada
// no app sabia que o pedido existia. Esta tela é a fila de trabalho de operações
// e, ao mesmo tempo, a visibilidade do comercial: os dois olham a mesma lista.
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Handshake, Package, Clock, ExternalLink, HandMetal, ArrowRight } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import { CANAL_LABEL } from '../../lib/statusConfig'
import { fmtBRL, fmtData, fmtDataHora, msgErro } from '../../lib/crm'
import { hojeLocal } from '../../lib/dataLocal'
import { ModalBase, Campo, inputCls } from './CrmShared'
import { LocalEntregaInput } from '../../components/LocalEntregaInput'

const STATUS: Record<string, { label: string; cor: string; ajuda: string }> = {
  AGUARDANDO: {
    label: 'Aguardando operações', cor: 'bg-amber-100 text-amber-800',
    ajuda: 'Ninguém assumiu ainda',
  },
  ASSUMIDO: {
    label: 'Em emissão no D365', cor: 'bg-blue-100 text-blue-700',
    ajuda: 'Operações está emitindo a OV',
  },
}

export function CrmRepasse() {
  const qc = useQueryClient()
  const [gerando, setGerando] = useState<any | null>(null)

  const { data: fila = [], isLoading } = useQuery<any[]>({
    queryKey: ['crm-repasses'],
    queryFn: () => api.get('/crm/repasses').then(r => r.data),
  })

  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ['crm-repasses'] })
    qc.invalidateQueries({ queryKey: ['crm-opps'] })
    qc.invalidateQueries({ queryKey: ['home-pendencias'] })
  }

  const assumir = useMutation({
    mutationFn: (id: string) => api.post(`/crm/oportunidades/${id}/assumir`),
    onSuccess: () => { toast.success('Repasse assumido — o comercial foi avisado'); invalidar() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao assumir'), { duration: 5000 }),
  })

  const semDono = fila.filter(f => f.repasse_status === 'AGUARDANDO')
  const total = fila.reduce((a, f) => a + (f.valor_estimado || 0), 0)

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-gray-100 p-4">
        <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5">
          <Handshake size={16} /> Do ganho à OV
        </h2>
        <p className="text-xs text-gray-400 mt-1">
          O comercial ganha a venda e ela cai aqui. Operações de vendas emite a OV no D365 e
          cadastra o número no app — daí em diante segue como OV normal na Expedição.
        </p>
        <div className="flex flex-wrap gap-x-6 gap-y-1 mt-3 text-xs">
          <span className="text-gray-500">Na fila: <strong className="text-gray-800">{fila.length}</strong></span>
          <span className="text-gray-500">Sem responsável: <strong className={semDono.length ? 'text-amber-700' : 'text-gray-800'}>{semDono.length}</strong></span>
          <span className="text-gray-500">Valor parado: <strong className="text-gray-800">{fmtBRL(total)}</strong></span>
        </div>
      </div>

      {isLoading ? (
        <p className="text-center text-gray-400 py-10 text-sm">Carregando…</p>
      ) : fila.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-10 text-center">
          <p className="text-sm text-gray-500">Nenhuma venda esperando OV.</p>
          <p className="text-xs text-gray-400 mt-1">
            Toda venda ganha aparece aqui até a OV ser cadastrada no app.
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {fila.map(f => {
            const st = STATUS[f.repasse_status] || STATUS.AGUARDANDO
            const atrasada = f.dias_esperando >= 1 && f.repasse_status === 'AGUARDANDO'
            return (
              <div key={f.id} className={`bg-white rounded-xl border p-4 ${atrasada ? 'border-amber-300' : 'border-gray-100'}`}>
                <div className="flex items-start justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-gray-800">{f.titulo}</p>
                    <p className="text-xs text-gray-500">{f.cliente || 'Sem cliente'}</p>
                    <div className="flex flex-wrap gap-x-3 gap-y-1 mt-1 text-[11px] text-gray-400">
                      {f.canal && <span>{CANAL_LABEL[f.canal] || f.canal}</span>}
                      <span className={atrasada ? 'text-amber-700 font-medium flex items-center gap-1' : 'flex items-center gap-1'}>
                        <Clock size={11} />
                        ganha {fmtData(f.ganho_em)}
                        {f.dias_esperando > 0 && ` · ${f.dias_esperando}d esperando`}
                      </span>
                    </div>
                  </div>
                  <div className="text-right">
                    <p className="text-base font-bold text-gray-800">{fmtBRL(f.valor_estimado)}</p>
                    <span className={`text-[11px] px-2 py-0.5 rounded-full ${st.cor}`}>{st.label}</span>
                  </div>
                </div>

                {/* O recado do comercial — substitui a mensagem de Teams. */}
                {f.repasse_nota && (
                  <p className="mt-2 text-xs text-gray-600 bg-gray-50 border border-gray-100 rounded-lg px-2.5 py-2">
                    <span className="text-gray-400">Recado do comercial: </span>{f.repasse_nota}
                  </p>
                )}
                {f.repasse_assumido_por_nome && (
                  <p className="mt-2 text-[11px] text-blue-700">
                    {f.repasse_assumido_por_nome} assumiu em {fmtDataHora(f.repasse_assumido_em)}
                  </p>
                )}

                <div className="mt-3 flex items-center gap-2 flex-wrap">
                  {f.repasse_status === 'AGUARDANDO' && (
                    <button onClick={() => assumir.mutate(f.id)} disabled={assumir.isPending}
                      className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-blue-300 text-blue-700 hover:bg-blue-50 disabled:opacity-50">
                      <HandMetal size={14} /> Assumir
                    </button>
                  )}
                  <button onClick={() => setGerando(f)}
                    className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-500 text-white">
                    <Package size={14} /> Cadastrar OV do D365 <ArrowRight size={13} />
                  </button>
                </div>
              </div>
            )
          })}
        </div>
      )}

      {gerando && <ModalCadastrarOV repasse={gerando} onClose={() => setGerando(null)} onSaved={invalidar} />}
    </div>
  )
}

/** Cadastra no app a OV já emitida no D365. O app não cria OV lá — ele registra
 *  o número que operações acabou de gerar, herdando cliente, canal e itens. */
function ModalCadastrarOV({ repasse, onClose, onSaved }: { repasse: any; onClose: () => void; onSaved: () => void }) {
  const navigate = useNavigate()
  const hoje = hojeLocal()
  const [numero, setNumero] = useState('')
  const [tipoFrete, setTipoFrete] = useState('FOB')
  const [dataEntrega, setDataEntrega] = useState('')
  const [local, setLocal] = useState('')

  const m = useMutation({
    mutationFn: () => api.post(`/crm/oportunidades/${repasse.id}/gerar-ov`, {
      numero_pedido: numero.trim(),
      tipo_frete: tipoFrete,
      data_prevista_entrega: dataEntrega,
      local_entrega: local || null,
    }),
    onSuccess: (res) => {
      toast.success('OV cadastrada — repasse concluído e comercial avisado')
      onSaved(); onClose()
      const ovId = res.data?.gerado_ov_id
      if (ovId) setTimeout(() => navigate(`/expedicao/${ovId}`), 300)
    },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao cadastrar OV'), { duration: 6000 }),
  })

  const valido = numero.trim() && dataEntrega

  return (
    <ModalBase titulo={`Cadastrar OV · ${repasse.titulo}`} onClose={onClose} max="max-w-md">
      <div className="p-5 space-y-3">
        <div className="bg-blue-50 rounded-lg p-2.5 text-xs text-blue-800">
          Emita a OV no <strong>D365</strong> primeiro e cole o número aqui. Cliente, canal e itens
          vêm da oportunidade — não precisa redigitar.
        </div>
        <Campo label="Número da OV (do D365) *">
          <input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())}
            className={`${inputCls} font-mono`} placeholder="Ex: OV015500" autoFocus />
        </Campo>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Data prevista de entrega *">
            <input type="date" value={dataEntrega} min={hoje} onChange={e => setDataEntrega(e.target.value)} className={inputCls} />
          </Campo>
          <Campo label="Tipo de frete">
            <select value={tipoFrete} onChange={e => setTipoFrete(e.target.value)} className={inputCls}>
              <option value="FOB">FOB</option>
              <option value="CIF_COM_VALOR">CIF com Valor NF</option>
              <option value="CIF_SEM_VALOR">CIF sem Valor NF</option>
            </select>
          </Campo>
        </div>
        <Campo label="Local de entrega"><LocalEntregaInput value={local} onChange={setLocal} /></Campo>
      </div>
      <div className="p-4 border-t flex justify-between items-center">
        <button onClick={() => window.open(`/crm`, '_self')} className="text-xs text-gray-400 hover:text-gray-600 flex items-center gap-1">
          <ExternalLink size={12} /> ver a oportunidade
        </button>
        <div className="flex gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
          <button onClick={() => m.mutate()} disabled={!valido || m.isPending}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
            {m.isPending ? 'Cadastrando…' : 'Cadastrar OV'}
          </button>
        </div>
      </div>
    </ModalBase>
  )
}

/**
 * Controle de devoluções.
 *
 * Os pedidos chegam por e-mail na caixa do Tassio, vindos do comercial e do
 * fiscal — não da licitação. Antes desta tela eles viviam só na conversa do
 * Outlook: quem não estava no e-mail não sabia que existiam, e ninguém
 * conseguia dizer quantos estavam abertos nem há quanto tempo.
 *
 * Duas coisas vêm da medição nos e-mails reais (150 dias, 23 e-mails):
 *
 *   Um card por CONVERSA, não por e-mail. Aqueles 23 e-mails são 10 casos.
 *
 *   O motor traz o caso PELA METADE de propósito: NF aparece em metade dos
 *   e-mails e cliente em um terço. Por isso cada card diz o que falta, em vez
 *   de fingir que está completo.
 *
 * Simples de propósito — "depois a gente vai melhorando".
 */
import { useMemo, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { format } from 'date-fns'
import {
  CheckCircle2, ChevronDown, ChevronRight, Clock, History, Mail, Plus,
  Search, Trash2, X,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'
import { msgErro } from '../lib/crm'

type Devolucao = {
  id: string
  origem: string
  assunto: string | null
  remetente: string | null
  recebido_em: string | null
  mensagens: number
  numeros_nf: string[] | null
  cliente_codigo: string | null
  cliente_cnpj: string | null
  cliente_id: string | null
  cliente_nome: string | null
  status: string
  status_label: string
  motivo: string | null
  observacao: string | null
  responsavel: string | null
  historico: Array<{ quando: string; quem: string; o_que: string }> | null
  resolvido_em: string | null
  dias_parada: number | null
  resolvida: boolean
  falta: string[]
}

type Resp = { devolucoes: Devolucao[]; abertas: number; status: Record<string, string> }

const COR_STATUS: Record<string, string> = {
  NOVA: 'bg-rose-100 text-rose-700',
  EM_ANALISE: 'bg-amber-100 text-amber-800',
  AGUARDANDO_CLIENTE: 'bg-blue-100 text-blue-700',
  AGUARDANDO_FISCAL: 'bg-violet-100 text-violet-700',
  NF_EMITIDA: 'bg-teal-100 text-teal-700',
  CONCLUIDA: 'bg-emerald-100 text-emerald-700',
  CANCELADA: 'bg-gray-200 text-gray-600',
}

const dataBR = (iso?: string | null) =>
  iso ? format(new Date(iso), 'dd/MM/yyyy') : '—'

export default function Devolucoes() {
  const qc = useQueryClient()
  const [busca, setBusca] = useState('')
  const [verResolvidas, setVerResolvidas] = useState(false)
  const [novo, setNovo] = useState(false)

  const { data, isLoading } = useQuery<Resp>({
    queryKey: ['devolucoes', verResolvidas],
    queryFn: () => api.get('/devolucoes', { params: { incluir_resolvidas: verResolvidas } })
      .then(r => r.data),
    refetchInterval: 60000,
  })

  const lista = useMemo(() => {
    const b = busca.trim().toLowerCase()
    const todas = data?.devolucoes || []
    if (!b) return todas
    return todas.filter(d =>
      `${d.assunto || ''} ${d.cliente_nome || ''} ${d.cliente_codigo || ''} ${(d.numeros_nf || []).join(' ')} ${d.remetente || ''}`
        .toLowerCase().includes(b))
  }, [data, busca])

  const abertas = lista.filter(d => !d.resolvida)
  const resolvidas = lista.filter(d => d.resolvida)

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-gray-800">Devoluções</h1>
        <p className="text-sm text-gray-500">
          Os pedidos que chegam por e-mail, um card por conversa. O motor traz o caso
          duas vezes por dia; o que o e-mail não disser, você completa aqui.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[240px] max-w-sm">
          <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
          <input value={busca} onChange={e => setBusca(e.target.value)}
            placeholder="Cliente, NF, assunto…"
            className="w-full border rounded-lg pl-9 pr-3 py-2 text-sm" />
        </div>
        <button onClick={() => setVerResolvidas(v => !v)}
          className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm border ${verResolvidas
            ? 'bg-gray-800 text-white border-gray-800' : 'text-gray-600 hover:bg-gray-50'}`}>
          <History size={14} /> Já resolvidas
        </button>
        <button onClick={() => setNovo(true)}
          className="flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm bg-indigo-600 text-white hover:bg-indigo-500">
          <Plus size={14} /> Nova devolução
        </button>
      </div>

      {isLoading ? (
        <p className="text-sm text-gray-400 py-8 text-center">Carregando…</p>
      ) : abertas.length === 0 ? (
        <div className="bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-8 text-center">
          <CheckCircle2 size={28} className="mx-auto text-emerald-600 mb-2" />
          <p className="text-sm font-medium text-emerald-800">Nenhuma devolução aberta.</p>
          <p className="text-xs text-emerald-700 mt-0.5">
            {busca ? 'Nenhuma com esse filtro.' : 'O motor varre a caixa duas vezes por dia.'}
          </p>
        </div>
      ) : (
        <div className="space-y-2">
          {abertas.map(d => <Card key={d.id} d={d} statusOpcoes={data?.status || {}} />)}
        </div>
      )}

      {verResolvidas && resolvidas.length > 0 && (
        <section className="rounded-xl border border-gray-200 bg-white p-4">
          <h2 className="text-sm font-semibold text-gray-700 flex items-center gap-1.5 mb-3">
            <History size={16} /> Já resolvidas
            <span className="text-xs font-normal text-gray-400">{resolvidas.length}</span>
          </h2>
          <div className="space-y-1.5">
            {resolvidas.map(d => (
              <div key={d.id} className="flex flex-wrap items-baseline gap-x-3 text-sm py-1.5 border-b border-gray-50 last:border-0">
                <CheckCircle2 size={13} className="text-emerald-600 shrink-0" />
                <span className="text-gray-700 truncate max-w-md">{d.assunto || '—'}</span>
                <span className={`text-[11px] px-1.5 py-0.5 rounded ${COR_STATUS[d.status] || 'bg-gray-100'}`}>
                  {d.status_label}
                </span>
                <span className="ml-auto text-xs text-gray-400">{dataBR(d.resolvido_em)}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {novo && <ModalNova onClose={() => setNovo(false)}
        onCriado={() => { qc.invalidateQueries({ queryKey: ['devolucoes'] }); setNovo(false) }} />}
    </div>
  )
}

function Card({ d, statusOpcoes }: { d: Devolucao; statusOpcoes: Record<string, string> }) {
  const qc = useQueryClient()
  const [aberto, setAberto] = useState(false)
  const [nf, setNf] = useState((d.numeros_nf || []).join(', '))
  const [motivo, setMotivo] = useState(d.motivo || '')
  const [observacao, setObservacao] = useState(d.observacao || '')

  const salvar = useMutation({
    mutationFn: (corpo: any) => api.patch(`/devolucoes/${d.id}`, corpo).then(r => r.data),
    onSuccess: () => {
      toast.success('Devolução atualizada.')
      qc.invalidateQueries({ queryKey: ['devolucoes'] })
    },
    onError: (e: any) => toast.error(msgErro(e, 'Não consegui salvar.')),
  })

  const remover = useMutation({
    mutationFn: (motivoTexto: string) =>
      api.post(`/devolucoes/${d.id}/remover`, { motivo: motivoTexto }).then(r => r.data),
    onSuccess: () => {
      toast.success('Tirado da lista.')
      qc.invalidateQueries({ queryKey: ['devolucoes'] })
    },
    onError: (e: any) => toast.error(msgErro(e, 'Não consegui remover.')),
  })

  const dias = d.dias_parada ?? 0

  return (
    <div className="bg-white rounded-lg border border-gray-200">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2.5">
        <button onClick={() => setAberto(a => !a)}
          className="text-gray-400 hover:text-gray-600 shrink-0" title="Abrir o caso">
          {aberto ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
        </button>

        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-medium text-gray-800 truncate max-w-lg">{d.assunto || '(sem assunto)'}</span>
            <span className={`text-[11px] px-1.5 py-0.5 rounded ${COR_STATUS[d.status] || 'bg-gray-100'}`}>
              {d.status_label}
            </span>
            {d.origem === 'EMAIL' && (
              <span className="text-[11px] text-gray-400 flex items-center gap-1">
                <Mail size={11} /> {d.mensagens} msg
              </span>
            )}
          </div>
          <div className="text-[11px] text-gray-500 mt-0.5 flex flex-wrap items-center gap-x-2">
            <span>{d.cliente_nome || d.cliente_codigo || 'cliente não identificado'}</span>
            {(d.numeros_nf || []).length > 0 && (
              <span className="font-mono">NF {(d.numeros_nf || []).join(', ')}</span>
            )}
            {d.remetente && <span className="text-gray-400">· {d.remetente}</span>}
          </div>
          {/* O que o e-mail não disse. É a razão de o motor poder entregar um
              caso pela metade sem inventar nada. */}
          {d.falta.length > 0 && (
            <p className="text-[11px] text-amber-700 mt-0.5">
              Falta preencher: <strong>{d.falta.join(', ')}</strong>
            </p>
          )}
        </div>

        <div className="text-xs whitespace-nowrap text-gray-500">{dataBR(d.recebido_em)}</div>
        <div className={`text-xs whitespace-nowrap tabular-nums ${dias >= 15 ? 'text-red-600 font-semibold'
          : dias >= 7 ? 'text-amber-700' : 'text-gray-500'}`}>
          <Clock size={12} className="inline mr-1 -mt-0.5" />{dias}d
        </div>

        <select value={d.status}
          onChange={e => salvar.mutate({ status: e.target.value })}
          className="text-xs border rounded-lg px-2 py-1 bg-white">
          {Object.entries(statusOpcoes).map(([k, v]) => (
            <option key={k} value={k}>{v}</option>
          ))}
        </select>
      </div>

      {aberto && (
        <div className="border-t border-gray-100 px-3 py-3 space-y-3 bg-gray-50/60">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] font-medium text-gray-500">Notas fiscais</label>
              <input value={nf} onChange={e => setNf(e.target.value)}
                placeholder="20911, 20586"
                className="w-full border rounded-lg px-2 py-1.5 text-sm mt-0.5 font-mono" />
            </div>
            <div>
              <label className="text-[11px] font-medium text-gray-500">Motivo</label>
              <input value={motivo} onChange={e => setMotivo(e.target.value)}
                placeholder="Ex.: valor da NF divergente do acordado"
                className="w-full border rounded-lg px-2 py-1.5 text-sm mt-0.5" />
            </div>
          </div>
          <div>
            <label className="text-[11px] font-medium text-gray-500">Observação</label>
            <textarea rows={2} value={observacao} onChange={e => setObservacao(e.target.value)}
              className="w-full border rounded-lg px-2 py-1.5 text-sm mt-0.5" />
          </div>

          <div className="flex flex-wrap gap-2 items-center">
            <button
              onClick={() => salvar.mutate({
                // Vírgula ou espaço, tanto faz: quem digita NF digita dos dois jeitos.
                numeros_nf: nf.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean),
                motivo: motivo.trim() || null,
                observacao: observacao.trim() || null,
              })}
              disabled={salvar.isPending}
              className="px-3 py-1.5 bg-indigo-600 text-white rounded-lg text-xs font-medium hover:bg-indigo-500 disabled:opacity-50">
              {salvar.isPending ? 'Salvando…' : 'Salvar'}
            </button>
            <button
              onClick={() => {
                const m = window.prompt('Por que este caso não é uma devolução?')
                if (m && m.trim().length >= 3) remover.mutate(m.trim())
              }}
              className="px-3 py-1.5 border border-gray-200 text-gray-500 rounded-lg text-xs hover:border-red-300 hover:text-red-600">
              <Trash2 size={11} className="inline mr-1 -mt-0.5" /> Não é devolução
            </button>
          </div>

          {(d.historico || []).length > 0 && (
            <div>
              <p className="text-[11px] font-medium text-gray-500 mb-1">Histórico</p>
              <div className="space-y-0.5">
                {(d.historico || []).slice().reverse().map((h, i) => (
                  <p key={i} className="text-[11px] text-gray-500">
                    <span className="text-gray-400">{dataBR(h.quando)}</span>
                    {' · '}<span className="font-medium">{h.quem}</span>
                    {' · '}{h.o_que}
                  </p>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/** Devolução combinada por telefone — nem toda nasce de e-mail. */
function ModalNova({ onClose, onCriado }: { onClose: () => void; onCriado: () => void }) {
  const [assunto, setAssunto] = useState('')
  const [nf, setNf] = useState('')
  const [motivo, setMotivo] = useState('')

  const criar = useMutation({
    mutationFn: () => api.post('/devolucoes', {
      assunto: assunto.trim(),
      numeros_nf: nf.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean),
      motivo: motivo.trim() || null,
    }).then(r => r.data),
    onSuccess: () => { toast.success('Devolução aberta.'); onCriado() },
    onError: (e: any) => toast.error(msgErro(e, 'Não consegui abrir.')),
  })

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md" onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b flex items-center justify-between">
          <h2 className="text-lg font-bold text-gray-800">Nova devolução</h2>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-600"><X size={18} /></button>
        </div>
        <div className="p-5 space-y-3">
          <div>
            <label className="text-sm font-medium text-gray-700">Do que se trata *</label>
            <input value={assunto} onChange={e => setAssunto(e.target.value)}
              placeholder="Ex.: Devolução NF 20911 — UROMED"
              className="w-full border rounded-lg px-3 py-2 text-sm mt-1" autoFocus />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700">Notas fiscais</label>
            <input value={nf} onChange={e => setNf(e.target.value)} placeholder="20911"
              className="w-full border rounded-lg px-3 py-2 text-sm mt-1 font-mono" />
          </div>
          <div>
            <label className="text-sm font-medium text-gray-700">Motivo</label>
            <input value={motivo} onChange={e => setMotivo(e.target.value)}
              className="w-full border rounded-lg px-3 py-2 text-sm mt-1" />
          </div>
        </div>
        <div className="p-5 border-t flex gap-2 justify-end">
          <button onClick={onClose} className="px-4 py-2 border rounded-lg text-sm">Cancelar</button>
          <button onClick={() => criar.mutate()}
            disabled={assunto.trim().length < 3 || criar.isPending}
            className="px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium disabled:opacity-50">
            {criar.isPending ? 'Abrindo…' : 'Abrir devolução'}
          </button>
        </div>
      </div>
    </div>
  )
}

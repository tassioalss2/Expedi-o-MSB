import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus, Trash2, Pencil, ArrowRightCircle, PhoneCall, CheckCircle2, Circle,
  AlertTriangle, XCircle, Info,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import { ClienteAutocomplete } from '../NovoPedido'
import { CANAL_LABEL } from '../../lib/statusConfig'
import { ORIGENS, fmtBRL, msgErro } from '../../lib/crm'
import { ModalBase, Campo, inputCls } from './CrmShared'

// Licitação não entra: nasce e vive no módulo de Licitações. Ter a mesma
// negociação nos dois lugares fazia os números divergirem.
const CANAIS = ['URO', 'VASCULAR', 'REALCLOSURE']

const STATUS: { key: string; label: string; cor: string }[] = [
  { key: 'NOVO', label: 'Novo', cor: 'bg-blue-100 text-blue-700' },
  { key: 'EM_CONTATO', label: 'Em contato', cor: 'bg-violet-100 text-violet-700' },
  { key: 'QUALIFICADO', label: 'Qualificado', cor: 'bg-amber-100 text-amber-700' },
  { key: 'CONVERTIDO', label: 'Convertido', cor: 'bg-emerald-100 text-emerald-700' },
  { key: 'DESCARTADO', label: 'Descartado', cor: 'bg-gray-100 text-gray-500' },
]
const STATUS_MAP = Object.fromEntries(STATUS.map(s => [s.key, s]))

const TEMP: Record<string, { label: string; cor: string; icone: string }> = {
  QUENTE: { label: 'Quente', cor: 'text-red-600 bg-red-50', icone: '🔥' },
  MORNO: { label: 'Morno', cor: 'text-amber-600 bg-amber-50', icone: '🌡️' },
  FRIO: { label: 'Frio', cor: 'text-sky-600 bg-sky-50', icone: '❄️' },
}

interface ChecklistItem { chave: string; label: string; ok: boolean; detalhe: string }

/** Checklist da qualificação — o coração da tela.
 *  Antes o vendedor não tinha como saber o que faltava para qualificar; o botão
 *  simplesmente funcionava (sem exigir nada) ou dava erro genérico. */
function Checklist({ itens, compacto = false }: { itens: ChecklistItem[]; compacto?: boolean }) {
  if (!itens?.length) return null
  return (
    <div className={compacto ? 'flex flex-wrap gap-1.5' : 'space-y-1.5'}>
      {itens.map(c => (
        <div key={c.chave}
          className={compacto
            ? `inline-flex items-center gap-1 text-[11px] px-2 py-0.5 rounded-full ${c.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-gray-100 text-gray-500'}`
            : 'flex items-start gap-2'}
          title={c.detalhe}>
          {c.ok
            ? <CheckCircle2 size={compacto ? 12 : 16} className="text-emerald-600 shrink-0 mt-0.5" />
            : <Circle size={compacto ? 12 : 16} className="text-gray-300 shrink-0 mt-0.5" />}
          {compacto ? c.label : (
            <div className="min-w-0">
              <p className={`text-sm ${c.ok ? 'text-gray-700 font-medium' : 'text-gray-500'}`}>{c.label}</p>
              <p className="text-xs text-gray-400">{c.detalhe}</p>
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

/** Score aberto: cada componente e quanto somou. Score que ninguém entende,
 *  ninguém usa para priorizar. */
function ScoreDetalhe({ detalhe }: { detalhe: any }) {
  if (!detalhe?.partes) return null
  return (
    <div className="space-y-1">
      {detalhe.partes.map((p: any) => (
        <div key={p.chave} className="flex items-baseline gap-2 text-xs">
          <span className={`tabular-nums font-semibold w-10 text-right ${p.pontos < 0 ? 'text-red-600' : 'text-gray-700'}`}>
            {p.pontos > 0 ? '+' : ''}{p.pontos}
          </span>
          <span className="text-gray-500 w-6">{p.max ? `/${p.max}` : ''}</span>
          <span className="text-gray-700 font-medium">{p.label}</span>
          <span className="text-gray-400 truncate">— {p.obs}</span>
        </div>
      ))}
    </div>
  )
}

export function CrmLeads() {
  const qc = useQueryClient()
  const [filtro, setFiltro] = useState('')
  const [modal, setModal] = useState<any | null>(null)
  const [contatoDe, setContatoDe] = useState<any | null>(null)
  const [descartarDe, setDescartarDe] = useState<any | null>(null)
  const [expandido, setExpandido] = useState<string | null>(null)

  const { data: leads = [], isLoading } = useQuery<any[]>({
    queryKey: ['crm-leads'],
    queryFn: () => api.get('/crm/leads').then(r => r.data),
  })
  const { data: opcoes } = useQuery<any>({
    queryKey: ['crm-leads-opcoes'],
    queryFn: () => api.get('/crm/leads/opcoes').then(r => r.data),
    staleTime: Infinity,
  })

  const recarregar = () => qc.invalidateQueries({ queryKey: ['crm-leads'] })

  const mudarStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.patch(`/crm/leads/${id}`, { status }).then(r => r.data),
    onSuccess: () => { toast.success('Status atualizado'); recarregar() },
    onError: (e: any) => toast.error(msgErro(e, 'Não foi possível mudar o status')),
  })

  const converter = useMutation({
    mutationFn: (id: string) => api.post(`/crm/leads/${id}/converter`).then(r => r.data),
    onSuccess: () => {
      toast.success('Lead convertido — o card está no funil')
      recarregar()
      qc.invalidateQueries({ queryKey: ['crm-oportunidades'] })
    },
    onError: (e: any) => toast.error(msgErro(e, 'Não foi possível converter')),
  })

  const excluir = useMutation({
    mutationFn: (id: string) => api.delete(`/crm/leads/${id}`).then(r => r.data),
    onSuccess: () => { toast.success('Lead removido'); recarregar() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao remover')),
  })

  const visiveis = leads.filter(l => !filtro || l.status === filtro)
  const porStatus = (k: string) => leads.filter(l => l.status === k).length
  const atrasados = leads.filter(l => l.proximo_passo_atrasado).length

  if (isLoading) return <p className="text-sm text-gray-400 p-4">Carregando leads…</p>

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-bold text-gray-800">Leads</h2>
          <p className="text-xs text-gray-400">
            Qualificar exige saber o que compra, quem decide e quando — o checklist mostra o que falta.
          </p>
        </div>
        <button onClick={() => setModal({})}
          className="inline-flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">
          <Plus size={16} /> Novo lead
        </button>
      </div>

      {atrasados > 0 && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-sm text-amber-800">
          <AlertTriangle size={16} className="shrink-0" />
          <span><strong>{atrasados}</strong> lead(s) com próximo passo atrasado.</span>
        </div>
      )}

      <div className="flex flex-wrap gap-1.5">
        <button onClick={() => setFiltro('')}
          className={`text-xs px-2.5 py-1 rounded-full ${!filtro ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600'}`}>
          Todos ({leads.length})
        </button>
        {STATUS.map(s => (
          <button key={s.key} onClick={() => setFiltro(s.key === filtro ? '' : s.key)}
            className={`text-xs px-2.5 py-1 rounded-full ${filtro === s.key ? 'bg-gray-800 text-white' : s.cor}`}>
            {s.label} ({porStatus(s.key)})
          </button>
        ))}
      </div>

      {visiveis.length === 0 ? (
        <p className="text-sm text-gray-400 py-10 text-center bg-white rounded-xl border border-gray-100">
          Nenhum lead {filtro ? 'nesse status' : 'cadastrado'}.
        </p>
      ) : (
        <div className="space-y-2">
          {visiveis.map(l => {
            const st = STATUS_MAP[l.status] || STATUS[0]
            const tp = TEMP[l.temperatura] || TEMP.FRIO
            const aberto = expandido === l.id
            const emAndamento = ['NOVO', 'EM_CONTATO', 'QUALIFICADO'].includes(l.status)
            return (
              <div key={l.id} className="bg-white rounded-xl border border-gray-100 shadow-sm">
                <div className="p-4 flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-gray-800">{l.empresa}</span>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full ${st.cor}`}>{st.label}</span>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full ${tp.cor}`}>
                        {tp.icone} {tp.label} · {l.score}
                      </span>
                      {l.proximo_passo_atrasado && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                          passo atrasado
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {[l.cliente || l.contato_nome, l.canal ? CANAL_LABEL[l.canal] || l.canal : null, l.origem]
                        .filter(Boolean).join(' · ') || '—'}
                    </p>
                    {emAndamento && (
                      <div className="mt-2">
                        <Checklist itens={l.checklist} compacto />
                      </div>
                    )}
                    {l.proximo_passo && (
                      <p className="text-xs text-gray-500 mt-1.5">
                        <span className="text-gray-400">Próximo passo:</span> {l.proximo_passo}
                        {l.proximo_passo_em && <span className="text-gray-400"> · {l.proximo_passo_em}</span>}
                      </p>
                    )}
                    {l.status === 'DESCARTADO' && l.motivo_descarte && (
                      <p className="text-xs text-gray-400 mt-1">Descartado: {l.motivo_descarte}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => setExpandido(aberto ? null : l.id)}
                      title="Por que esse score" className="p-2 rounded-lg hover:bg-gray-100 text-gray-400">
                      <Info size={15} />
                    </button>
                    {emAndamento && (
                      <button onClick={() => setContatoDe(l)} title="Registrar contato"
                        className="p-2 rounded-lg hover:bg-violet-50 text-violet-600">
                        <PhoneCall size={15} />
                      </button>
                    )}
                    <button onClick={() => setModal(l)} title="Editar / qualificar"
                      className="p-2 rounded-lg hover:bg-gray-100 text-gray-500">
                      <Pencil size={15} />
                    </button>
                    {emAndamento && l.status !== 'QUALIFICADO' && (
                      <button
                        onClick={() => l.pode_qualificar
                          ? mudarStatus.mutate({ id: l.id, status: 'QUALIFICADO' })
                          : setModal(l)}
                        title={l.pode_qualificar ? 'Qualificar' : `Falta: ${l.falta_para_qualificar.join('; ')}`}
                        className={`px-2.5 py-1.5 rounded-lg text-xs font-medium ${
                          l.pode_qualificar
                            ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                            : 'bg-gray-100 text-gray-400'}`}>
                        Qualificar
                      </button>
                    )}
                    {l.status === 'QUALIFICADO' && (
                      <button onClick={() => converter.mutate(l.id)} disabled={converter.isPending}
                        className="inline-flex items-center gap-1.5 bg-emerald-600 text-white px-2.5 py-1.5 rounded-lg text-xs font-medium hover:bg-emerald-700 disabled:opacity-50">
                        <ArrowRightCircle size={14} /> Converter
                      </button>
                    )}
                    {emAndamento && (
                      <button onClick={() => setDescartarDe(l)} title="Descartar"
                        className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600">
                        <XCircle size={15} />
                      </button>
                    )}
                    {!emAndamento && (
                      <button onClick={() => excluir.mutate(l.id)} title="Remover"
                        className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600">
                        <Trash2 size={15} />
                      </button>
                    )}
                  </div>
                </div>

                {aberto && (
                  <div className="border-t px-4 py-3 bg-gray-50/60 space-y-3">
                    <div>
                      <p className="text-xs font-semibold text-gray-600 mb-1.5">Qualificação</p>
                      <Checklist itens={l.checklist} />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-gray-600 mb-1.5">
                        Score {l.score}/100 — {TEMP[l.temperatura]?.label}
                      </p>
                      <ScoreDetalhe detalhe={l.score_detalhe} />
                    </div>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {modal && <ModalLead lead={modal.id ? modal : undefined} opcoes={opcoes}
        onClose={() => setModal(null)} onSaved={() => { setModal(null); recarregar() }} />}
      {contatoDe && <ModalContato lead={contatoDe}
        onClose={() => setContatoDe(null)} onSaved={() => { setContatoDe(null); recarregar() }} />}
      {descartarDe && <ModalDescarte lead={descartarDe} opcoes={opcoes}
        onClose={() => setDescartarDe(null)} onSaved={() => { setDescartarDe(null); recarregar() }} />}
    </div>
  )
}

// ── Modal principal: cadastro + qualificação no mesmo lugar ─────────────────────

function ModalLead({ lead, opcoes, onClose, onSaved }: {
  lead?: any; opcoes: any; onClose: () => void; onSaved: () => void
}) {
  const [empresa, setEmpresa] = useState(lead?.empresa || '')
  const [contatoNome, setContatoNome] = useState(lead?.contato_nome || '')
  const [email, setEmail] = useState(lead?.email || '')
  const [telefone, setTelefone] = useState(lead?.telefone || '')
  const [canal, setCanal] = useState(lead?.canal || '')
  const [origem, setOrigem] = useState(lead?.origem || '')
  const [clienteId, setClienteId] = useState<string | null>(lead?.cliente_id || null)
  const [observacao, setObservacao] = useState(lead?.observacao || '')

  // Qualificação
  const n = lead?.necessidade || {}
  const [familia, setFamilia] = useState(n.familia || '')
  const [codigos, setCodigos] = useState((n.codigos || []).join(', '))
  const [consumo, setConsumo] = useState(n.consumo_mes ? String(n.consumo_mes) : '')
  const [unidade, setUnidade] = useState(n.unidade || 'un')
  const d = lead?.decisor || {}
  const [decNome, setDecNome] = useState(d.nome || '')
  const [decPapel, setDecPapel] = useState(d.papel || '')
  const p = lead?.prazo || {}
  const [prazoTipo, setPrazoTipo] = useState(p.tipo || 'JANELA')
  const [prazoData, setPrazoData] = useState(p.data || '')
  const [prazoJanela, setPrazoJanela] = useState(p.janela || '')
  const v = lead?.verba || {}
  const [verbaConf, setVerbaConf] = useState<boolean | null>(
    v.confirmada === undefined ? null : v.confirmada)

  const salvar = useMutation({
    mutationFn: () => {
      const body: any = {
        empresa, contato_nome: contatoNome || null, email: email || null,
        telefone: telefone || null, canal: canal || null, origem: origem || null,
        cliente_id: clienteId, observacao: observacao || null,
        necessidade: {
          familia: familia || null,
          codigos: codigos.split(',').map((s: string) => s.trim()).filter(Boolean),
          consumo_mes: consumo ? Number(consumo) : null,
          unidade: unidade || null,
        },
        decisor: { nome: decNome || null, papel: decPapel || null },
        prazo: prazoTipo === 'DATA'
          ? { tipo: 'DATA', data: prazoData || null }
          : { tipo: 'JANELA', janela: prazoJanela || null },
        verba: verbaConf === null ? null : { confirmada: verbaConf },
      }
      return lead
        ? api.patch(`/crm/leads/${lead.id}`, body).then(r => r.data)
        : api.post('/crm/leads', body).then(r => r.data)
    },
    onSuccess: () => { toast.success(lead ? 'Lead atualizado' : 'Lead criado'); onSaved() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao salvar')),
  })

  const faltaAgora = [
    !(familia || codigos) || !consumo ? 'o que compra e quanto/mês' : null,
    !decNome || !decPapel ? 'quem decide' : null,
    prazoTipo === 'DATA' ? (!prazoData ? 'quando compra' : null) : (!prazoJanela ? 'quando compra' : null),
  ].filter(Boolean)

  return (
    <ModalBase titulo={lead ? `Lead · ${lead.empresa}` : 'Novo lead'} onClose={onClose}>
      <div className="p-5 space-y-4 overflow-y-auto">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Campo label="Empresa *">
            <input value={empresa} onChange={e => setEmpresa(e.target.value)} className={inputCls} />
          </Campo>
          <Campo label="Já é cliente da base?">
            <ClienteAutocomplete value={clienteId || ''} onChange={(id: string) => setClienteId(id || null)} />
          </Campo>
          <Campo label="Contato">
            <input value={contatoNome} onChange={e => setContatoNome(e.target.value)} className={inputCls} />
          </Campo>
          <Campo label="Telefone">
            <input value={telefone} onChange={e => setTelefone(e.target.value)} className={inputCls} />
          </Campo>
          <Campo label="E-mail">
            <input value={email} onChange={e => setEmail(e.target.value)} className={inputCls} />
          </Campo>
          <Campo label="Canal">
            <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
              <option value="">—</option>
              {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
            </select>
          </Campo>
          <Campo label="Origem">
            <select value={origem} onChange={e => setOrigem(e.target.value)} className={inputCls}>
              <option value="">—</option>
              {ORIGENS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Campo>
        </div>

        {/* Qualificação: o que decide se isso é venda ou intenção. */}
        <div className="border-t pt-4">
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm font-bold text-gray-800">Qualificação</p>
            {faltaAgora.length === 0
              ? <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">pronto para qualificar</span>
              : <span className="text-[11px] text-gray-400">falta: {faltaAgora.join(', ')}</span>}
          </div>
          <p className="text-xs text-gray-400 mb-3">
            Sem estas três respostas o lead não avança — é o que separa negociação de intenção.
          </p>

          <div className="space-y-3">
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-xs font-semibold text-gray-600 mb-2">1 · O que compra e quanto por mês</p>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                <div className="sm:col-span-2">
                  <input value={familia} onChange={e => setFamilia(e.target.value)}
                    placeholder="Família (ex.: SONDA BASKET)" className={inputCls} />
                </div>
                <input value={consumo} onChange={e => setConsumo(e.target.value)}
                  type="number" placeholder="Consumo/mês" className={inputCls} />
                <input value={unidade} onChange={e => setUnidade(e.target.value)}
                  placeholder="un" className={inputCls} />
                <div className="sm:col-span-4">
                  <input value={codigos} onChange={e => setCodigos(e.target.value)}
                    placeholder="Códigos separados por vírgula (opcional — usados para conferir portfólio e estimar valor)"
                    className={inputCls} />
                </div>
              </div>
            </div>

            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-xs font-semibold text-gray-600 mb-2">2 · Quem decide a compra</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input value={decNome} onChange={e => setDecNome(e.target.value)}
                  placeholder="Nome de quem assina" className={inputCls} />
                <select value={decPapel} onChange={e => setDecPapel(e.target.value)} className={inputCls}>
                  <option value="">Papel…</option>
                  {(opcoes?.papeis || []).map((x: any) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
              </div>
            </div>

            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-xs font-semibold text-gray-600 mb-2">3 · Quando pretende comprar</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <select value={prazoTipo} onChange={e => setPrazoTipo(e.target.value)} className={inputCls}>
                  <option value="JANELA">Janela aproximada</option>
                  <option value="DATA">Data definida</option>
                </select>
                {prazoTipo === 'DATA' ? (
                  <input type="date" value={prazoData} onChange={e => setPrazoData(e.target.value)} className={inputCls} />
                ) : (
                  <select value={prazoJanela} onChange={e => setPrazoJanela(e.target.value)} className={inputCls}>
                    <option value="">Quando…</option>
                    {(opcoes?.janelas || []).map((x: any) => <option key={x.key} value={x.key}>{x.label}</option>)}
                  </select>
                )}
              </div>
            </div>

            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-xs font-semibold text-gray-600 mb-2">
                Verba <span className="font-normal text-gray-400">— opcional, mas pesa no score</span>
              </p>
              <div className="flex gap-1.5">
                {[{ v: true, l: 'Confirmada' }, { v: false, l: 'Mencionada' }, { v: null, l: 'Não verificada' }].map(o => (
                  <button key={String(o.v)} type="button" onClick={() => setVerbaConf(o.v)}
                    className={`text-xs px-3 py-1.5 rounded-lg ${verbaConf === o.v ? 'bg-gray-800 text-white' : 'bg-white border text-gray-600'}`}>
                    {o.l}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>

        <Campo label="Observação">
          <textarea value={observacao} onChange={e => setObservacao(e.target.value)} rows={2} className={inputCls} />
        </Campo>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
        <button onClick={() => salvar.mutate()} disabled={!empresa.trim() || salvar.isPending}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
          {salvar.isPending ? 'Salvando…' : 'Salvar'}
        </button>
      </div>
    </ModalBase>
  )
}

// ── Registrar contato: destrava NOVO → Em contato ───────────────────────────────

function ModalContato({ lead, onClose, onSaved }: { lead: any; onClose: () => void; onSaved: () => void }) {
  const [tipo, setTipo] = useState('LIGACAO')
  const [descricao, setDescricao] = useState('')
  const [passo, setPasso] = useState(lead?.proximo_passo || '')
  const [passoEm, setPassoEm] = useState(lead?.proximo_passo_em || '')

  const salvar = useMutation({
    mutationFn: () => api.post(`/crm/leads/${lead.id}/contato`, {
      tipo, descricao: descricao || null,
      proximo_passo: passo || null, proximo_passo_em: passoEm || null,
    }).then(r => r.data),
    onSuccess: () => { toast.success('Contato registrado'); onSaved() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao registrar')),
  })

  return (
    <ModalBase titulo={`Registrar contato · ${lead.empresa}`} onClose={onClose} max="max-w-lg">
      <div className="p-5 space-y-3">
        <p className="text-xs text-gray-400">
          O contato registrado é o que move o lead para "Em contato" — e zera o relógio de inatividade
          que esfria o score.
        </p>
        <Campo label="Tipo">
          <select value={tipo} onChange={e => setTipo(e.target.value)} className={inputCls}>
            {['LIGACAO', 'EMAIL', 'WHATSAPP', 'VISITA', 'REUNIAO'].map(t =>
              <option key={t} value={t}>{t.charAt(0) + t.slice(1).toLowerCase()}</option>)}
          </select>
        </Campo>
        <Campo label="O que foi conversado">
          <textarea value={descricao} onChange={e => setDescricao(e.target.value)} rows={3} className={inputCls} />
        </Campo>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <Campo label="Próximo passo">
            <input value={passo} onChange={e => setPasso(e.target.value)}
              placeholder="Ex.: enviar cotação dos 3 itens" className={inputCls} />
          </Campo>
          <Campo label="Quando">
            <input type="date" value={passoEm} onChange={e => setPassoEm(e.target.value)} className={inputCls} />
          </Campo>
        </div>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
        <button onClick={() => salvar.mutate()} disabled={salvar.isPending}
          className="bg-violet-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-violet-700 disabled:opacity-50">
          Registrar
        </button>
      </div>
    </ModalBase>
  )
}

// ── Descarte com motivo codificado ──────────────────────────────────────────────

function ModalDescarte({ lead, opcoes, onClose, onSaved }: {
  lead: any; opcoes: any; onClose: () => void; onSaved: () => void
}) {
  const [codigo, setCodigo] = useState('')
  const [texto, setTexto] = useState('')

  const salvar = useMutation({
    mutationFn: () => api.patch(`/crm/leads/${lead.id}`, {
      status: 'DESCARTADO', motivo_descarte_codigo: codigo, motivo_descarte: texto || null,
    }).then(r => r.data),
    onSuccess: () => { toast.success('Lead descartado'); onSaved() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao descartar')),
  })

  return (
    <ModalBase titulo={`Descartar · ${lead.empresa}`} onClose={onClose} max="max-w-lg">
      <div className="p-5 space-y-3">
        <p className="text-xs text-gray-400">
          O motivo é obrigatório porque é o que permite saber, depois, por que os leads morrem.
        </p>
        <Campo label="Motivo *">
          <select value={codigo} onChange={e => setCodigo(e.target.value)} className={inputCls}>
            <option value="">Selecione…</option>
            {(opcoes?.motivos_descarte || []).map((m: any) =>
              <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </Campo>
        <Campo label="Detalhe (opcional)">
          <textarea value={texto} onChange={e => setTexto(e.target.value)} rows={2} className={inputCls} />
        </Campo>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
        <button onClick={() => salvar.mutate()} disabled={!codigo || salvar.isPending}
          className="bg-red-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-red-700 disabled:opacity-50">
          Descartar
        </button>
      </div>
    </ModalBase>
  )
}

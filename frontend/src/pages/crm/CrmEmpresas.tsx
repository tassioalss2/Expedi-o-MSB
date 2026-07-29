import { useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus, Trash2, Pencil, ArrowRightCircle, PhoneCall, CheckCircle2, Circle,
  AlertTriangle, XCircle, Info, RotateCcw, History,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import { ClienteAutocomplete } from '../NovoPedido'
import { CANAL_LABEL } from '../../lib/statusConfig'
import { msgErro } from '../../lib/crm'
import { ModalBase, Campo, inputCls } from './CrmShared'

// Licitação não entra: nasce e vive no módulo de Licitações.
const CANAIS = ['URO', 'VASCULAR', 'REALCLOSURE']

/** Os dois bancos do processo. "Cliente" e "Descartada" são saídas. */
const ESTADOS: { key: string; label: string; cor: string; desc: string }[] = [
  { key: 'PROSPECTADA', label: 'Prospectadas', cor: 'bg-slate-100 text-slate-700',
    desc: 'Mapeadas, aguardando qualificação' },
  { key: 'QUALIFICADA', label: 'Qualificadas', cor: 'bg-amber-100 text-amber-700',
    desc: 'Sabemos o que compra, quem decide e quando' },
  { key: 'CLIENTE', label: 'Clientes', cor: 'bg-emerald-100 text-emerald-700', desc: '' },
  { key: 'DESCARTADA', label: 'Descartadas', cor: 'bg-gray-100 text-gray-500', desc: '' },
]
const ESTADO_MAP = Object.fromEntries(ESTADOS.map(e => [e.key, e]))

const TEMP: Record<string, { label: string; cor: string; icone: string }> = {
  QUENTE: { label: 'Quente', cor: 'text-red-600 bg-red-50', icone: '🔥' },
  MORNO: { label: 'Morno', cor: 'text-amber-600 bg-amber-50', icone: '🌡️' },
  FRIO: { label: 'Frio', cor: 'text-sky-600 bg-sky-50', icone: '❄️' },
}

interface ChecklistItem { chave: string; label: string; ok: boolean; detalhe: string }

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

export function CrmEmpresas() {
  const qc = useQueryClient()
  const [filtro, setFiltro] = useState('PROSPECTADA')
  const [busca, setBusca] = useState('')
  const [modal, setModal] = useState<any | null>(null)
  const [contatoDe, setContatoDe] = useState<any | null>(null)
  const [descartarDe, setDescartarDe] = useState<any | null>(null)
  const [expandido, setExpandido] = useState<string | null>(null)

  const { data: empresas = [], isLoading } = useQuery<any[]>({
    queryKey: ['crm-empresas'],
    queryFn: () => api.get('/crm/empresas').then(r => r.data),
  })
  const { data: opcoes } = useQuery<any>({
    queryKey: ['crm-empresas-opcoes'],
    queryFn: () => api.get('/crm/empresas/opcoes').then(r => r.data),
    staleTime: Infinity,
  })

  const recarregar = () => qc.invalidateQueries({ queryKey: ['crm-empresas'] })

  const mudarEstado = useMutation({
    mutationFn: ({ id, estado }: { id: string; estado: string }) =>
      api.patch(`/crm/empresas/${id}`, { estado }).then(r => r.data),
    onSuccess: () => { toast.success('Empresa qualificada'); recarregar() },
    onError: (e: any) => toast.error(msgErro(e, 'Não foi possível mudar o estado'), { duration: 6000 }),
  })

  const gerarOpp = useMutation({
    mutationFn: (id: string) => api.post(`/crm/empresas/${id}/gerar-oportunidade`).then(r => r.data),
    onSuccess: () => {
      toast.success('Oportunidade criada — está no funil')
      recarregar()
      qc.invalidateQueries({ queryKey: ['crm-oportunidades'] })
    },
    onError: (e: any) => toast.error(msgErro(e, 'Não foi possível gerar'), { duration: 6000 }),
  })

  const excluir = useMutation({
    mutationFn: (id: string) => api.delete(`/crm/empresas/${id}`).then(r => r.data),
    onSuccess: () => { toast.success('Empresa removida'); recarregar() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao remover')),
  })

  const t = busca.trim().toLowerCase()
  const visiveis = empresas.filter(e =>
    (!filtro || e.estado === filtro) &&
    (!t || `${e.razao_social} ${e.nome_fantasia || ''} ${e.cnpj || ''} ${e.cidade || ''}`.toLowerCase().includes(t))
  )
  const porEstado = (k: string) => empresas.filter(e => e.estado === k).length
  const atrasados = empresas.filter(e => e.proximo_passo_atrasado).length
  // Aviso do ciclo: qualificadas a menos de 60 dias de voltar para prospecção.
  const perto = empresas.filter(e => e.dias_para_retorno != null && e.dias_para_retorno <= 60 && e.dias_para_retorno > 0)

  if (isLoading) return <p className="text-sm text-gray-400 p-4">Carregando empresas…</p>

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-bold text-gray-800">Empresas</h2>
          <p className="text-xs text-gray-400">
            Prospecção mapeia a empresa; a qualificação diz o que ela compra. Sem movimentação por{' '}
            {opcoes?.dias_ciclo_retorno ? Math.round(opcoes.dias_ciclo_retorno / 365) : 1} ano,
            a qualificada volta a prospectada — a informação antiga fica guardada.
          </p>
        </div>
        <button onClick={() => setModal({})}
          className="inline-flex items-center gap-2 bg-blue-600 text-white px-3 py-2 rounded-lg text-sm font-medium hover:bg-blue-700">
          <Plus size={16} /> Prospectar empresa
        </button>
      </div>

      {atrasados > 0 && (
        <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 text-sm text-amber-800">
          <AlertTriangle size={16} className="shrink-0" />
          <span><strong>{atrasados}</strong> empresa(s) com próximo passo atrasado.</span>
        </div>
      )}
      {perto.length > 0 && (
        <div className="flex items-center gap-2 bg-orange-50 border border-orange-200 rounded-xl px-3 py-2 text-sm text-orange-800">
          <RotateCcw size={16} className="shrink-0" />
          <span>
            <strong>{perto.length}</strong> qualificada(s) perto de voltar para prospecção por falta de
            movimentação — a mais próxima em {Math.min(...perto.map(e => e.dias_para_retorno))} dia(s).
          </span>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1.5">
        {ESTADOS.map(s => (
          <button key={s.key} onClick={() => setFiltro(s.key === filtro ? '' : s.key)}
            title={s.desc}
            className={`text-xs px-2.5 py-1 rounded-full ${filtro === s.key ? 'bg-gray-800 text-white' : s.cor}`}>
            {s.label} ({porEstado(s.key)})
          </button>
        ))}
        <button onClick={() => setFiltro('')}
          className={`text-xs px-2.5 py-1 rounded-full ${!filtro ? 'bg-gray-800 text-white' : 'bg-gray-100 text-gray-600'}`}>
          Todas ({empresas.length})
        </button>
        <input value={busca} onChange={e => setBusca(e.target.value)}
          placeholder="Buscar por nome, CNPJ ou cidade…"
          className="ml-auto border rounded-lg px-3 py-1.5 text-sm w-full sm:w-64" />
      </div>

      {visiveis.length === 0 ? (
        <p className="text-sm text-gray-400 py-10 text-center bg-white rounded-xl border border-gray-100">
          Nenhuma empresa {filtro ? `em ${(ESTADO_MAP[filtro]?.label || '').toLowerCase()}` : 'cadastrada'}.
        </p>
      ) : (
        <div className="space-y-2">
          {visiveis.map(e => {
            const st = ESTADO_MAP[e.estado] || ESTADOS[0]
            const tp = TEMP[e.temperatura] || TEMP.FRIO
            const aberto = expandido === e.id
            const ativa = ['PROSPECTADA', 'QUALIFICADA'].includes(e.estado)
            return (
              <div key={e.id} className="bg-white rounded-xl border border-gray-100 shadow-sm">
                <div className="p-4 flex flex-wrap items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-semibold text-gray-800">
                        {e.nome_fantasia || e.razao_social}
                      </span>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full ${st.cor}`}>{st.label.replace(/s$/, '')}</span>
                      <span className={`text-[11px] px-2 py-0.5 rounded-full ${tp.cor}`}>
                        {tp.icone} {tp.label} · {e.score}
                      </span>
                      {e.ciclos_retorno > 0 && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-orange-50 text-orange-700"
                          title={`Já voltou ${e.ciclos_retorno}x para prospecção por falta de movimentação`}>
                          {e.ciclos_retorno}º ciclo
                        </span>
                      )}
                      {e.proximo_passo_atrasado && (
                        <span className="text-[11px] px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                          passo atrasado
                        </span>
                      )}
                    </div>
                    <p className="text-xs text-gray-500 mt-0.5">
                      {[
                        e.tipo_label, e.porte_label,
                        e.cidade && e.uf ? `${e.cidade}/${e.uf}` : e.cidade || e.uf,
                        e.canal ? CANAL_LABEL[e.canal] || e.canal : null,
                        e.cnpj,
                      ].filter(Boolean).join(' · ') || '—'}
                    </p>
                    {ativa && (
                      <div className="mt-2"><Checklist itens={e.checklist} compacto /></div>
                    )}
                    {e.proximo_passo && (
                      <p className="text-xs text-gray-500 mt-1.5">
                        <span className="text-gray-400">Próximo passo:</span> {e.proximo_passo}
                        {e.proximo_passo_em && <span className="text-gray-400"> · {e.proximo_passo_em}</span>}
                      </p>
                    )}
                    {e.dias_para_retorno != null && e.dias_para_retorno <= 60 && e.dias_para_retorno > 0 && (
                      <p className="text-xs text-orange-600 mt-1">
                        volta para prospecção em {e.dias_para_retorno} dia(s) sem movimentação
                      </p>
                    )}
                    {e.estado === 'DESCARTADA' && e.motivo_descarte && (
                      <p className="text-xs text-gray-400 mt-1">Descartada: {e.motivo_descarte}</p>
                    )}
                  </div>

                  <div className="flex items-center gap-1 shrink-0">
                    <button onClick={() => setExpandido(aberto ? null : e.id)}
                      title="Por que esse score" className="p-2 rounded-lg hover:bg-gray-100 text-gray-400">
                      <Info size={15} />
                    </button>
                    {ativa && (
                      <button onClick={() => setContatoDe(e)} title="Registrar contato"
                        className="p-2 rounded-lg hover:bg-violet-50 text-violet-600">
                        <PhoneCall size={15} />
                      </button>
                    )}
                    <button onClick={() => setModal(e)} title="Editar / qualificar"
                      className="p-2 rounded-lg hover:bg-gray-100 text-gray-500">
                      <Pencil size={15} />
                    </button>
                    {e.estado === 'PROSPECTADA' && (
                      <button
                        onClick={() => e.pode_qualificar
                          ? mudarEstado.mutate({ id: e.id, estado: 'QUALIFICADA' })
                          : setModal(e)}
                        title={e.pode_qualificar ? 'Qualificar' : `Falta: ${e.falta_para_qualificar.join('; ')}`}
                        className={`px-2.5 py-1.5 rounded-lg text-xs font-medium ${
                          e.pode_qualificar
                            ? 'bg-amber-100 text-amber-700 hover:bg-amber-200'
                            : 'bg-gray-100 text-gray-400'}`}>
                        Qualificar
                      </button>
                    )}
                    {e.estado === 'QUALIFICADA' && (
                      <button onClick={() => gerarOpp.mutate(e.id)} disabled={gerarOpp.isPending}
                        title="Criar card no funil"
                        className="inline-flex items-center gap-1.5 bg-emerald-600 text-white px-2.5 py-1.5 rounded-lg text-xs font-medium hover:bg-emerald-700 disabled:opacity-50">
                        <ArrowRightCircle size={14} /> Oportunidade
                      </button>
                    )}
                    {ativa && (
                      <button onClick={() => setDescartarDe(e)} title="Descartar"
                        className="p-2 rounded-lg hover:bg-red-50 text-gray-400 hover:text-red-600">
                        <XCircle size={15} />
                      </button>
                    )}
                    {!ativa && (
                      <button onClick={() => excluir.mutate(e.id)} title="Remover"
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
                      <Checklist itens={e.checklist} />
                    </div>
                    <div>
                      <p className="text-xs font-semibold text-gray-600 mb-1.5">
                        Score {e.score}/100 — {TEMP[e.temperatura]?.label}
                      </p>
                      <ScoreDetalhe detalhe={e.score_detalhe} />
                    </div>
                    {e.dias_sem_movimentacao != null && (
                      <p className="text-xs text-gray-400">
                        Última movimentação há {e.dias_sem_movimentacao} dia(s).
                      </p>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {modal && <ModalEmpresa empresa={modal.id ? modal : undefined} opcoes={opcoes}
        onClose={() => setModal(null)} onSaved={() => { setModal(null); recarregar() }} />}
      {contatoDe && <ModalContato empresa={contatoDe}
        onClose={() => setContatoDe(null)} onSaved={() => { setContatoDe(null); recarregar() }} />}
      {descartarDe && <ModalDescarte empresa={descartarDe} opcoes={opcoes}
        onClose={() => setDescartarDe(null)} onSaved={() => { setDescartarDe(null); recarregar() }} />}
    </div>
  )
}

// ── Cadastro (prospecção) + qualificação no mesmo lugar ─────────────────────────

function ModalEmpresa({ empresa, opcoes, onClose, onSaved }: {
  empresa?: any; opcoes: any; onClose: () => void; onSaved: () => void
}) {
  const editando = !!empresa?.id
  // Busca o registro completo: `qualificacao_anterior` só vem em obter_empresa.
  const { data: cheia } = useQuery<any>({
    queryKey: ['crm-empresa', empresa?.id],
    queryFn: () => api.get(`/crm/empresas/${empresa.id}`).then(r => r.data),
    enabled: editando,
  })
  const e = cheia || empresa || {}

  const [razao, setRazao] = useState(e.razao_social || '')
  const [fantasia, setFantasia] = useState(e.nome_fantasia || '')
  const [cnpj, setCnpj] = useState(e.cnpj || '')
  const [cidade, setCidade] = useState(e.cidade || '')
  const [uf, setUf] = useState(e.uf || '')
  const [tipo, setTipo] = useState(e.tipo || '')
  const [porte, setPorte] = useState(e.porte || '')
  const [canal, setCanal] = useState(e.canal || '')
  const [fonte, setFonte] = useState(e.fonte || '')
  const [clienteId, setClienteId] = useState<string | null>(e.cliente_id || null)
  const [observacao, setObservacao] = useState(e.observacao || '')

  const q = e.qualificacao || {}
  const n = q.necessidade || {}
  const [familia, setFamilia] = useState(n.familia || '')
  const [codigos, setCodigos] = useState((n.codigos || []).join(', '))
  const [consumo, setConsumo] = useState(n.consumo_mes ? String(n.consumo_mes) : '')
  const [unidade, setUnidade] = useState(n.unidade || 'un')
  const d = q.decisor || {}
  const [decNome, setDecNome] = useState(d.nome || '')
  const [decPapel, setDecPapel] = useState(d.papel || '')
  const p = q.prazo || {}
  const [prazoTipo, setPrazoTipo] = useState(p.tipo || 'JANELA')
  const [prazoData, setPrazoData] = useState(p.data || '')
  const [prazoJanela, setPrazoJanela] = useState(p.janela || '')
  const v = q.verba || {}
  const [verbaConf, setVerbaConf] = useState<boolean | null>(
    v.confirmada === undefined ? null : v.confirmada)

  const anterior = cheia?.qualificacao_anterior

  /** Copia a qualificação anterior para os campos — o ganho real de guardar o
   *  histórico é não redigitar tudo na requalificação. */
  const usarAnterior = () => {
    const a = anterior?.dados || {}
    const an = a.necessidade || {}, ad = a.decisor || {}, ap = a.prazo || {}, av = a.verba || {}
    setFamilia(an.familia || ''); setCodigos((an.codigos || []).join(', '))
    setConsumo(an.consumo_mes ? String(an.consumo_mes) : ''); setUnidade(an.unidade || 'un')
    setDecNome(ad.nome || ''); setDecPapel(ad.papel || '')
    setPrazoTipo(ap.tipo || 'JANELA'); setPrazoData(ap.data || ''); setPrazoJanela(ap.janela || '')
    setVerbaConf(av.confirmada === undefined ? null : av.confirmada)
    toast.success('Dados do ano anterior copiados — confirme ou ajuste')
  }

  const salvar = useMutation({
    mutationFn: () => {
      const body: any = {
        razao_social: razao, nome_fantasia: fantasia || null, cnpj: cnpj || null,
        cidade: cidade || null, uf: uf || null, tipo: tipo || null, porte: porte || null,
        canal: canal || null, fonte: fonte || null, cliente_id: clienteId,
        observacao: observacao || null,
        qualificacao: {
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
        },
      }
      return editando
        ? api.patch(`/crm/empresas/${empresa.id}`, body).then(r => r.data)
        : api.post('/crm/empresas', body).then(r => r.data)
    },
    onSuccess: () => { toast.success(editando ? 'Empresa atualizada' : 'Empresa prospectada'); onSaved() },
    onError: (er: any) => toast.error(msgErro(er, 'Erro ao salvar'), { duration: 6000 }),
  })

  const falta = [
    !(familia || codigos) || !consumo ? 'o que compra e quanto/mês' : null,
    !decNome || !decPapel ? 'quem decide' : null,
    prazoTipo === 'DATA' ? (!prazoData ? 'quando compra' : null) : (!prazoJanela ? 'quando compra' : null),
  ].filter(Boolean)

  return (
    <ModalBase titulo={editando ? (e.nome_fantasia || e.razao_social) : 'Prospectar empresa'} onClose={onClose}>
      <div className="p-5 space-y-4 overflow-y-auto">
        {/* Prospecção: só identificação e porte. */}
        <div>
          <p className="text-sm font-bold text-gray-800 mb-1">Identificação</p>
          <p className="text-xs text-gray-400 mb-3">
            O suficiente para a empresa ficar mapeada e priorizável. O CNPJ evita que
            duas pessoas trabalhem a mesma empresa.
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Campo label="Razão social *">
              <input value={razao} onChange={ev => setRazao(ev.target.value)} className={inputCls} />
            </Campo>
            <Campo label="Nome fantasia">
              <input value={fantasia} onChange={ev => setFantasia(ev.target.value)} className={inputCls} />
            </Campo>
            <Campo label="CNPJ">
              <input value={cnpj} onChange={ev => setCnpj(ev.target.value)} className={inputCls}
                placeholder="só números" />
            </Campo>
            <Campo label="Já é cliente da base?">
              <ClienteAutocomplete value={clienteId || ''} onChange={(id: string) => setClienteId(id || null)} />
            </Campo>
            <div className="grid grid-cols-3 gap-2 sm:col-span-2">
              <Campo label="Cidade">
                <input value={cidade} onChange={ev => setCidade(ev.target.value)} className={inputCls} />
              </Campo>
              <Campo label="UF">
                <input value={uf} onChange={ev => setUf(ev.target.value.toUpperCase().slice(0, 2))}
                  className={inputCls} maxLength={2} />
              </Campo>
              <Campo label="Porte">
                <select value={porte} onChange={ev => setPorte(ev.target.value)} className={inputCls}>
                  <option value="">—</option>
                  {(opcoes?.portes || []).map((x: any) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
              </Campo>
            </div>
            <Campo label="Tipo">
              <select value={tipo} onChange={ev => setTipo(ev.target.value)} className={inputCls}>
                <option value="">—</option>
                {(opcoes?.tipos || []).map((x: any) => <option key={x.key} value={x.key}>{x.label}</option>)}
              </select>
            </Campo>
            <Campo label="Canal">
              <select value={canal} onChange={ev => setCanal(ev.target.value)} className={inputCls}>
                <option value="">—</option>
                {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
              </select>
            </Campo>
            <Campo label="Fonte da prospecção">
              <select value={fonte} onChange={ev => setFonte(ev.target.value)} className={inputCls}>
                <option value="">—</option>
                {(opcoes?.fontes || []).map((f: string) => <option key={f} value={f}>{f}</option>)}
              </select>
            </Campo>
          </div>
        </div>

        {/* Qualificação anterior, quando a empresa já ciclou. */}
        {anterior && (
          <div className="bg-orange-50 border border-orange-200 rounded-xl p-3">
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <p className="text-xs font-bold text-orange-800 flex items-center gap-1.5">
                  <History size={13} /> Qualificação anterior
                </p>
                <p className="text-[11px] text-orange-700 mt-0.5">
                  Encerrada em {String(anterior.encerrada_em || '').slice(0, 10)}
                  {anterior.motivo_encerramento === 'RETORNO_1_ANO' && ' — 1 ano sem movimentação'}
                  {anterior.score != null && ` · score ${anterior.score}`}
                </p>
                <p className="text-[11px] text-orange-900 mt-1">
                  {[
                    anterior.dados?.necessidade?.familia,
                    anterior.dados?.necessidade?.consumo_mes
                      ? `${anterior.dados.necessidade.consumo_mes} ${anterior.dados.necessidade.unidade || 'un'}/mês`
                      : null,
                    anterior.dados?.decisor?.nome,
                  ].filter(Boolean).join(' · ') || 'sem detalhes registrados'}
                </p>
              </div>
              <button type="button" onClick={usarAnterior}
                className="shrink-0 text-xs font-medium px-2.5 py-1.5 rounded-lg bg-white border border-orange-300 text-orange-800 hover:bg-orange-100">
                Usar como base
              </button>
            </div>
          </div>
        )}

        {/* Qualificação */}
        <div className="border-t pt-4">
          <div className="flex items-center justify-between mb-1">
            <p className="text-sm font-bold text-gray-800">Qualificação</p>
            {falta.length === 0
              ? <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">pronto para qualificar</span>
              : <span className="text-[11px] text-gray-400">falta: {falta.join(', ')}</span>}
          </div>
          <p className="text-xs text-gray-400 mb-3">
            Sem estas três respostas a empresa fica em prospecção — é o que separa negociação de intenção.
          </p>

          <div className="space-y-3">
            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-xs font-semibold text-gray-600 mb-2">1 · O que compra e quanto por mês</p>
              <div className="grid grid-cols-1 sm:grid-cols-4 gap-2">
                <div className="sm:col-span-2">
                  <input value={familia} onChange={ev => setFamilia(ev.target.value)}
                    placeholder="Família (ex.: SONDA BASKET)" className={inputCls} />
                </div>
                <input value={consumo} onChange={ev => setConsumo(ev.target.value)}
                  type="number" placeholder="Consumo/mês" className={inputCls} />
                <input value={unidade} onChange={ev => setUnidade(ev.target.value)}
                  placeholder="un" className={inputCls} />
                <div className="sm:col-span-4">
                  <input value={codigos} onChange={ev => setCodigos(ev.target.value)}
                    placeholder="Códigos separados por vírgula (opcional — conferem portfólio e estimam valor)"
                    className={inputCls} />
                </div>
              </div>
            </div>

            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-xs font-semibold text-gray-600 mb-2">2 · Quem decide a compra</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <input value={decNome} onChange={ev => setDecNome(ev.target.value)}
                  placeholder="Nome de quem assina" className={inputCls} />
                <select value={decPapel} onChange={ev => setDecPapel(ev.target.value)} className={inputCls}>
                  <option value="">Papel…</option>
                  {(opcoes?.papeis || []).map((x: any) => <option key={x.key} value={x.key}>{x.label}</option>)}
                </select>
              </div>
            </div>

            <div className="bg-gray-50 rounded-xl p-3">
              <p className="text-xs font-semibold text-gray-600 mb-2">3 · Quando pretende comprar</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <select value={prazoTipo} onChange={ev => setPrazoTipo(ev.target.value)} className={inputCls}>
                  <option value="JANELA">Janela aproximada</option>
                  <option value="DATA">Data definida</option>
                </select>
                {prazoTipo === 'DATA' ? (
                  <input type="date" value={prazoData} onChange={ev => setPrazoData(ev.target.value)} className={inputCls} />
                ) : (
                  <select value={prazoJanela} onChange={ev => setPrazoJanela(ev.target.value)} className={inputCls}>
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
          <textarea value={observacao} onChange={ev => setObservacao(ev.target.value)} rows={2} className={inputCls} />
        </Campo>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
        <button onClick={() => salvar.mutate()} disabled={!razao.trim() || salvar.isPending}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
          {salvar.isPending ? 'Salvando…' : 'Salvar'}
        </button>
      </div>
    </ModalBase>
  )
}

function ModalContato({ empresa, onClose, onSaved }: { empresa: any; onClose: () => void; onSaved: () => void }) {
  const [tipo, setTipo] = useState('LIGACAO')
  const [descricao, setDescricao] = useState('')
  const [passo, setPasso] = useState(empresa?.proximo_passo || '')
  const [passoEm, setPassoEm] = useState(empresa?.proximo_passo_em || '')

  const salvar = useMutation({
    mutationFn: () => api.post(`/crm/empresas/${empresa.id}/contato`, {
      tipo, descricao: descricao || null,
      proximo_passo: passo || null, proximo_passo_em: passoEm || null,
    }).then(r => r.data),
    onSuccess: () => { toast.success('Contato registrado'); onSaved() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao registrar')),
  })

  return (
    <ModalBase titulo={`Registrar contato · ${empresa.nome_fantasia || empresa.razao_social}`}
      onClose={onClose} max="max-w-lg">
      <div className="p-5 space-y-3">
        <p className="text-xs text-gray-400">
          Contato registrado é movimentação: zera o relógio do ciclo de 1 ano e o decaimento do score.
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

function ModalDescarte({ empresa, opcoes, onClose, onSaved }: {
  empresa: any; opcoes: any; onClose: () => void; onSaved: () => void
}) {
  const [codigo, setCodigo] = useState('')
  const [texto, setTexto] = useState('')

  const salvar = useMutation({
    mutationFn: () => api.patch(`/crm/empresas/${empresa.id}`, {
      estado: 'DESCARTADA', motivo_descarte_codigo: codigo, motivo_descarte: texto || null,
    }).then(r => r.data),
    onSuccess: () => { toast.success('Empresa descartada'); onSaved() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao descartar')),
  })

  return (
    <ModalBase titulo={`Descartar · ${empresa.nome_fantasia || empresa.razao_social}`}
      onClose={onClose} max="max-w-lg">
      <div className="p-5 space-y-3">
        <p className="text-xs text-gray-400">
          O motivo é obrigatório — é o que permite saber por que as empresas saem da base.
          A qualificação levantada até aqui fica guardada no histórico.
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

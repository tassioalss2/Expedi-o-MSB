import { useState, useMemo } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  Plus, Search, Target, Trophy, XCircle, Trash2, Pencil, Package,
  Clock, MessageSquare, CalendarPlus, CheckCircle2, ExternalLink,
  AlertTriangle, Circle, ArrowRight, Undo2, FileText, Printer, Send,
} from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import { ClienteAutocomplete } from '../NovoPedido'
import { ItensPedido, type ItemLinha } from '../../components/ItensPedido'
import { LocalEntregaInput } from '../../components/LocalEntregaInput'
import { CANAL_LABEL } from '../../lib/statusConfig'
import {
  ESTAGIOS, ESTAGIOS_PIPELINE, ESTAGIO_MAP, ORIGENS, TIPOS_ATIVIDADE, TIPO_ATIV_MAP,
  fmtBRL, fmtBRLcurto, fmtData, fmtDataHora, prazoCor, msgErro, type EstagioKey,
  type Disponibilidade, type Pendencia, type PendenciasResp,
} from '../../lib/crm'
import {
  BlocoDisponibilidade, CardPendencia, ModalDecisaoEstoque, ModalLiberarPendencia,
  type DecisaoEstoque,
} from '../../components/EstoqueVenda'
import { ModalBase, Campo, inputCls, InputMoeda } from './CrmShared'
import { hojeLocal } from '../../lib/dataLocal'

// CRM é do comercial — licitação NÃO entra aqui (tem módulo próprio).
const CANAIS = ['URO', 'VASCULAR', 'REALCLOSURE']

// Progressão linear real do funil. DESAFIOS fica de fora de propósito: não é um
// degrau que se avança clicando — é um desvio que o sistema entra sozinho quando
// alguém registra um problema, e sai sozinho quando o último bloqueante é
// resolvido (server-side, em criar_desafio/atualizar_desafio). "Avançar" pula
// direto para a etapa seguinte de negócio; quem quiser sinalizar um problema usa
// o botão "Registrar problema" do painel de Desafios, não um clique na etapa.
const ORDEM_AVANCO: EstagioKey[] = ['QUALIFICACAO', 'NEGOCIACAO', 'PROPOSTA']

function proximaEtapa(atual: string): EstagioKey | null {
  const i = ORDEM_AVANCO.indexOf(atual as EstagioKey)
  if (i === -1 || i === ORDEM_AVANCO.length - 1) return null
  return ORDEM_AVANCO[i + 1]
}
/** Todas as etapas anteriores à atual (não só a imediatamente anterior) — quem
 *  errou uma passagem duas etapas atrás não deveria precisar voltar um degrau
 *  de cada vez. */
function etapasAnteriores(atual: string): EstagioKey[] {
  const i = ORDEM_AVANCO.indexOf(atual as EstagioKey)
  return i > 0 ? ORDEM_AVANCO.slice(0, i) : []
}

export function CrmPipeline() {
  const qc = useQueryClient()
  const [novo, setNovo] = useState(false)
  const [detalheId, setDetalheId] = useState<string | null>(null)
  const [busca, setBusca] = useState('')
  const [canal, setCanal] = useState('')
  const [liberando, setLiberando] = useState<Pendencia | null>(null)

  const { data: opps = [], isLoading } = useQuery<any[]>({
    queryKey: ['crm-opps'],
    queryFn: () => api.get('/crm/oportunidades').then(r => r.data),
    refetchInterval: 20000,
  })

  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ['crm-opps'] })
    qc.invalidateQueries({ queryKey: ['crm-dashboard'] })
    qc.invalidateQueries({ queryKey: ['crm-pendencias'] })
    qc.invalidateQueries({ queryKey: ['crm-disp'] })
  }

  const filtradas = useMemo(() => {
    const b = busca.trim().toLowerCase()
    return opps.filter(o => {
      if (canal && o.canal !== canal) return false
      if (b && !`${o.titulo || ''} ${o.cliente || ''}`.toLowerCase().includes(b)) return false
      return true
    })
  }, [opps, busca, canal])

  // Pendência de estoque é coluna VIRTUAL: o card sai da coluna do estágio dele e
  // aparece aqui enquanto o material não chega. Sem isso, uma venda travada por
  // falta de material ficava indistinguível de uma venda andando normalmente.
  const { data: pend } = useQuery<PendenciasResp>({
    queryKey: ['crm-pendencias'],
    queryFn: () => api.get('/crm/pendencias').then(r => r.data),
    refetchInterval: 30000,
  })
  const pendencias = useMemo(() => {
    const b = busca.trim().toLowerCase()
    return (pend?.pendencias || []).filter(p => {
      if (canal && p.canal !== canal) return false
      if (b && !`${p.titulo || ''} ${p.cliente || ''}`.toLowerCase().includes(b)) return false
      return true
    })
  }, [pend, busca, canal])
  const idsPendentes = useMemo(
    () => new Set(pendencias.filter(p => p.fonte === 'oportunidade').map(p => p.id)),
    [pendencias])

  const porEstagio = (e: string) => filtradas.filter(o => o.estagio === e && !idsPendentes.has(o.id))

  const totalPonderado = filtradas.filter(o => o.estagio !== 'GANHO').reduce((a, o) => a + (o.valor_ponderado || 0), 0)
  const totalPipe = filtradas.filter(o => o.estagio !== 'GANHO').reduce((a, o) => a + (o.valor_estimado || 0), 0)
  const totalPendente = pendencias.reduce((a, p) => a + (p.valor || 0), 0)

  return (
    <div className="space-y-4">
      <div className="flex flex-col lg:flex-row lg:items-center gap-3">
        <div className="flex items-center gap-2 flex-1">
          <div className="relative flex-1 max-w-xs">
            <Search size={15} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
            <input value={busca} onChange={e => setBusca(e.target.value)} placeholder="Buscar oportunidade ou cliente…"
              className="w-full border rounded-lg pl-9 pr-3 py-2 text-sm" />
          </div>
          <select value={canal} onChange={e => setCanal(e.target.value)} className="border rounded-lg px-3 py-2 text-sm">
            <option value="">Todos os canais</option>
            {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right hidden md:block">
            <p className="text-xs text-gray-400">Pipeline aberto · previsão ponderada</p>
            <p className="text-sm font-semibold text-gray-700">{fmtBRL(totalPipe)} · <span className="text-emerald-600">{fmtBRL(totalPonderado)}</span></p>
          </div>
          <button onClick={() => setNovo(true)}
            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg whitespace-nowrap">
            <Plus size={16} /> Nova oportunidade
          </button>
        </div>
      </div>

      {isLoading ? (
        <p className="text-center text-gray-400 py-10 text-sm">Carregando funil…</p>
      ) : (
        <div className="overflow-x-auto lg:overflow-x-visible pb-2">
          <div className="kanban-grid gap-2"
            style={{ ['--kanban-cols' as any]: ESTAGIOS_PIPELINE.length + 1 }}>
            {/* Pendência de estoque vem PRIMEIRO: é venda fechada esperando
                material, o que trava dinheiro. Ficava no fim, fora da tela sem
                rolar — e o que não se vê não é cobrado. */}
            <div className="bg-red-50/40 rounded-xl border border-red-100 flex flex-col min-h-[400px]">
              <div className="h-1 rounded-t-xl bg-red-500" />
              {/* Cabeçalho empilhado: com 6 colunas na tela não há largura para
                  título e total na mesma linha sem cortar um dos dois. */}
              <div className="px-2.5 py-2">
                <span className="text-[13px] font-semibold text-gray-700 flex items-start gap-1.5 leading-tight">
                  <span className="w-2 h-2 rounded-full bg-red-500 mt-1 shrink-0" /> Pendência de estoque
                </span>
                <span className="text-[11px] text-gray-400 block mt-0.5">
                  {pendencias.length} · {fmtBRLcurto(totalPendente)}
                </span>
              </div>
              <div className="px-1.5 pb-2 space-y-2 flex-1 overflow-y-auto">
                {pendencias.map(p => (
                  <CardPendencia key={`${p.fonte}-${p.id}`} p={p}
                    onAbrir={() => { if (p.fonte === 'oportunidade') setDetalheId(p.id) }}
                    onLiberar={() => setLiberando(p)} />
                ))}
                {pendencias.length === 0 && (
                  <div className="text-[11px] text-gray-300 text-center py-6 rounded-lg">
                    nenhuma — tudo com material
                  </div>
                )}
              </div>
            </div>

            {ESTAGIOS_PIPELINE.map(ek => {
              const cfg = ESTAGIO_MAP[ek]
              const cards = porEstagio(ek)
              const soma = cards.reduce((a, o) => a + (o.valor_estimado || 0), 0)
              return (
                <div key={ek}
                  className="bg-gray-50 rounded-xl border border-gray-100 flex flex-col min-h-[400px]">
                  <div className={`h-1 rounded-t-xl ${cfg.coluna}`} />
                  <div className="px-2.5 py-2">
                    <span className="text-[13px] font-semibold text-gray-700 flex items-start gap-1.5 leading-tight">
                      <span className={`w-2 h-2 rounded-full mt-1 shrink-0 ${cfg.ponto}`} /> {cfg.label}
                    </span>
                    <span className="text-[11px] text-gray-400 block mt-0.5">{cards.length} · {fmtBRLcurto(soma)}</span>
                  </div>
                  <div className="px-1.5 pb-2 space-y-2 flex-1 overflow-y-auto">
                    {cards.map(o => (
                      <CardOpp key={o.id} o={o} onClick={() => setDetalheId(o.id)} />
                    ))}
                    {cards.length === 0 && (
                      <div className="text-[11px] text-gray-300 text-center py-6 rounded-lg">
                        nenhuma
                      </div>
                    )}
                  </div>
                </div>
              )
            })}

          </div>
        </div>
      )}

      {liberando && (
        <ModalLiberarPendencia pendencia={liberando} onClose={() => setLiberando(null)}
          onLiberado={invalidar} />
      )}
      {novo && <ModalOportunidadeForm onClose={() => setNovo(false)} onSaved={invalidar} />}
      {detalheId && <ModalDetalheOportunidade id={detalheId} onClose={() => setDetalheId(null)} onChanged={invalidar} />}
    </div>
  )
}

function CardOpp({ o, onClick }: { o: any; onClick: () => void }) {
  const cfg = ESTAGIO_MAP[o.estagio]
  return (
    <div onClick={onClick}
      className="bg-white rounded-lg border border-gray-200 shadow-sm p-2 cursor-pointer hover:shadow-md hover:border-blue-300 transition-all">
      <p className="text-[13px] font-medium text-gray-800 leading-tight line-clamp-2 break-words">{o.titulo}</p>
      {/* Nome de cliente é longo (razão social inteira) e a coluna é estreita:
          duas linhas com reticências em vez de uma linha cortada no meio. */}
      {o.cliente && <p className="text-[11px] text-gray-500 mt-0.5 leading-tight line-clamp-2">{o.cliente}</p>}
      <div className="flex items-center justify-between gap-1 flex-wrap mt-1.5">
        <span className="text-[13px] font-semibold text-gray-700">{fmtBRL(o.valor_estimado)}</span>
        {/* A probabilidade vem ajustada pelo servidor; quando difere da base do
            estágio, o título explica por quê. */}
        <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${cfg?.chip || ''}`}
          title={o.probabilidade_ajustes?.length
            ? `Base do estágio ${o.probabilidade_base}% · ${o.probabilidade_ajustes.join(', ')}`
            : undefined}>
          {o.probabilidade}%{o.probabilidade_ajustes?.length ? ' ↓' : ''}
        </span>
      </div>
      <div className="flex items-center flex-wrap gap-x-3 gap-y-1 mt-1.5 text-[11px]">
        {o.canal && <span className="text-gray-400">{CANAL_LABEL[o.canal] || o.canal}</span>}
        {o.previsao_fechamento && <span className={`flex items-center gap-1 ${prazoCor(o.previsao_fechamento)}`}><Clock size={11} /> {fmtData(o.previsao_fechamento)}</span>}
        {o.atividades_pendentes > 0 && <span className="flex items-center gap-1 text-blue-500"><CalendarPlus size={11} /> {o.atividades_pendentes}</span>}
      </div>
      {/* Sinais de funil abandonado — o que fazia o CRM morrer sem ninguém notar. */}
      {(o.sem_proximo_passo || o.proximo_passo_atrasado || o.parada) && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {o.sem_proximo_passo && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-500">sem próximo passo</span>
          )}
          {o.proximo_passo_atrasado && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-100 text-amber-700">passo atrasado</span>
          )}
          {o.parada && (
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-red-50 text-red-600">
              {o.dias_no_estagio}d parada
            </span>
          )}
        </div>
      )}
      {o.proximo_passo && !o.proximo_passo_atrasado && (
        <p className="text-[11px] text-gray-400 mt-1 truncate" title={o.proximo_passo}>→ {o.proximo_passo}</p>
      )}
    </div>
  )
}

/** Substitui a antiga régua de 4 caixinhas clicáveis por um único botão de
 *  avanço linear. Mostra também, ao lado do botão, o que o servidor exige para
 *  aquela passagem específica — é a resposta direta a "que informação preciso
 *  para passar de uma etapa para outra". */
function FluxoAvanco({ oportunidade: o, onMover, onEditar }: {
  oportunidade: any; onMover: (destino: string) => void; onEditar: () => void
}) {
  const proxima = proximaEtapa(o.estagio)

  const { data: req } = useQuery<any>({
    queryKey: ['crm-requisitos', o.id, proxima],
    queryFn: () => api.get(`/crm/oportunidades/${o.id}/requisitos`, { params: { destino: proxima } }).then(r => r.data),
    enabled: !!proxima,
  })

  if (o.estagio === 'DESAFIOS') {
    // Desvio automático: o servidor tira daqui sozinho quando o último
    // bloqueante é resolvido (ver PainelDesafios). Não há o que "avançar", mas
    // quem registrou por engano precisa conseguir voltar sem esperar isso.
    return (
      <div className="mt-3 bg-orange-50 border border-orange-200 rounded-lg px-3 py-2 text-xs text-orange-800 flex items-center justify-between gap-2 flex-wrap">
        <span className="flex items-center gap-2">
          <AlertTriangle size={14} className="shrink-0" />
          Negociação travada por desafio(s) aberto(s) — volta sozinha para {ESTAGIO_MAP.QUALIFICACAO.label} assim que forem resolvidos, mais abaixo.
        </span>
        <button onClick={() => onMover('QUALIFICACAO')} className="flex items-center gap-1 underline whitespace-nowrap">
          <Undo2 size={12} /> Voltar manualmente
        </button>
      </div>
    )
  }

  const anteriores = etapasAnteriores(o.estagio)

  if (!proxima) {
    return (
      <div className="mt-3 flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-gray-400">Última etapa do funil — use Ganhar ou Perder para fechar.</p>
        {anteriores.length > 0 && (
          <select onChange={e => { if (e.target.value) onMover(e.target.value) }} value=""
            className="text-xs text-gray-500 border border-gray-200 rounded-lg px-2 py-1.5 bg-white">
            <option value="">↩ Voltar para…</option>
            {anteriores.map(k => <option key={k} value={k}>{ESTAGIO_MAP[k].label}</option>)}
          </select>
        )}
      </div>
    )
  }

  const cfg = ESTAGIO_MAP[proxima]
  const falta: string[] = req?.falta || []
  const faltaItens = falta.some(f => f.startsWith('itens'))

  return (
    <div className="mt-3 space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <button onClick={() => onMover(proxima)}
          className={`flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-lg text-white ${cfg.coluna} hover:opacity-90`}>
          Avançar para {cfg.label} <ArrowRight size={14} />
        </button>
        {anteriores.length > 0 && (
          <select onChange={e => { if (e.target.value) onMover(e.target.value) }} value=""
            className="ml-auto text-xs text-gray-500 border border-gray-200 rounded-lg px-2 py-1.5 bg-white">
            <option value="">↩ Voltar para…</option>
            {anteriores.map(k => <option key={k} value={k}>{ESTAGIO_MAP[k].label}</option>)}
          </select>
        )}
      </div>
      {falta.length > 0 && (
        <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-xs text-amber-800 flex items-center justify-between gap-2 flex-wrap">
          <span>Falta para avançar: {falta.join(' · ')}</span>
          {faltaItens && (
            <button onClick={onEditar} className="text-amber-900 underline font-medium whitespace-nowrap">
              Adicionar itens
            </button>
          )}
        </div>
      )}
    </div>
  )
}

// ── Form (criar / editar) ────────────────────────────────────────────────────────
export function ModalOportunidadeForm({ oportunidade, prefill, onClose, onSaved }: {
  oportunidade?: any; prefill?: any; onClose: () => void; onSaved: (data?: any) => void
}) {
  const edicao = !!oportunidade?.id
  const base = oportunidade || prefill || {}
  const [titulo, setTitulo] = useState(base.titulo || '')
  const [clienteId, setClienteId] = useState(base.cliente_id || '')
  const [clienteNome, setClienteNome] = useState(base.cliente || '')
  const [contatoId, setContatoId] = useState(base.contato_id || '')
  const [canal, setCanal] = useState(base.canal || '')
  const [estagio, setEstagio] = useState<string>(base.estagio || 'QUALIFICACAO')
  const [valor, setValor] = useState<number | null>(base.valor_estimado ? Number(base.valor_estimado) : null)
  const [previsao, setPrevisao] = useState(base.previsao_fechamento || '')
  const [origem, setOrigem] = useState(base.origem || '')
  const [itens, setItens] = useState<ItemLinha[]>(
    (base.itens || []).filter((i: any) => i.produto_id).map((i: any) => ({
      produto_id: i.produto_id, codigo: i.codigo || '', descricao: i.descricao || '',
      qtd: Number(i.qtd) || 0, valor: Number(i.valor_unitario) || 0,
    }))
  )

  const [novoContato, setNovoContato] = useState(false)

  // Disponibilidade enquanto o comercial monta os itens. Consulta por POST porque
  // a oportunidade ainda não existe no banco — os itens só existem na tela.
  const itensValidos = itens.filter(i => i.produto_id && Number(i.qtd) > 0)
  const chaveItens = JSON.stringify(itensValidos.map(i => [i.produto_id, i.qtd]))
  const { data: analise, isLoading: analisando } = useQuery<Disponibilidade>({
    queryKey: ['crm-disp-form', chaveItens],
    queryFn: () => api.post('/crm/disponibilidade', {
      itens: itensValidos.map(i => ({
        produto_id: i.produto_id, codigo: i.codigo, descricao: i.descricao,
        qtd: i.qtd, valor_unitario: i.valor || 0,
      })),
    }).then(r => r.data),
    enabled: itensValidos.length > 0,
    staleTime: 30_000,
  })

  const { data: contatos = [], refetch: refetchContatos } = useQuery<any[]>({
    queryKey: ['crm-contatos', clienteId],
    queryFn: () => api.get('/crm/contatos', { params: { cliente_id: clienteId } }).then(r => r.data),
    enabled: !!clienteId,
  })

  // Cadastro rápido de cliente/prospect direto do CRM (pede confirmação).
  const criarClienteNovo = async (nome: string) => {
    if (!confirm(`"${nome}" não está cadastrado.\n\nConfirmar o cadastro de um NOVO cliente com esse nome?`)) return null
    try {
      const { data } = await api.post('/crm/clientes', { nome })
      setClienteNome(data.nome); setContatoId('')
      toast.success('Cliente cadastrado')
      return { id: data.id, nome: data.nome }
    } catch (e: any) {
      toast.error(msgErro(e, 'Erro ao cadastrar cliente'), { duration: 5000 })
      return null
    }
  }

  const totalItens = itens.reduce((a, i) => a + i.qtd * (i.valor || 0), 0)

  const salvar = useMutation({
    mutationFn: () => {
      const body: any = {
        titulo: titulo.trim(),
        cliente_id: clienteId || null,
        contato_id: contatoId || null,
        canal: canal || null,
        estagio,
        valor_estimado: totalItens > 0 ? totalItens : valor,
        previsao_fechamento: previsao || null,
        origem: origem || null,
        itens: itens.map(i => ({ produto_id: i.produto_id, codigo: i.codigo, descricao: i.descricao, qtd: i.qtd, valor_unitario: i.valor || 0 })),
      }
      return edicao
        ? api.patch(`/crm/oportunidades/${oportunidade.id}`, body)
        : api.post('/crm/oportunidades', body)
    },
    onSuccess: (res) => { toast.success(edicao ? 'Oportunidade atualizada' : 'Oportunidade criada'); onSaved(res.data); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao salvar'), { duration: 5000 }),
  })

  return (
    <ModalBase titulo={edicao ? 'Editar oportunidade' : 'Nova oportunidade'} onClose={onClose}>
      <div className="p-5 space-y-3 overflow-y-auto">
        <Campo label="Título *">
          <input value={titulo} onChange={e => setTitulo(e.target.value)} className={inputCls} placeholder="Ex: Reposição trimestral — cateteres vasculares" />
        </Campo>
        <Campo label="Cliente">
          <ClienteAutocomplete value={clienteId} onCriarNovo={criarClienteNovo}
            onChange={(id, nome) => { setClienteId(id); setClienteNome(nome); setContatoId('') }} />
          {clienteId && <p className="text-xs text-green-600 mt-1">✅ {clienteNome}</p>}
        </Campo>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Contato">
            <div className="flex gap-1.5">
              <select value={contatoId} onChange={e => setContatoId(e.target.value)} className={`${inputCls} flex-1`} disabled={!clienteId}>
                <option value="">{clienteId ? '— nenhum —' : 'selecione o cliente'}</option>
                {contatos.map(c => <option key={c.id} value={c.id}>{c.nome}{c.cargo ? ` (${c.cargo})` : ''}</option>)}
              </select>
              <button type="button" onClick={() => setNovoContato(true)} disabled={!clienteId}
                title="Cadastrar novo contato"
                className="px-2.5 rounded-lg border text-sm text-blue-600 hover:bg-blue-50 disabled:opacity-40 whitespace-nowrap">
                ➕ Novo
              </button>
            </div>
          </Campo>
          <Campo label="Canal *">
            <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
              <option value="">Selecione o canal…</option>
              {CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
            </select>
          </Campo>
          <Campo label="Estágio">
            {/* Ganho e Perdido ficam fora: são desfechos, e cada um tem portão
                próprio (Ganhar confere proposta e estoque e abre a OV; Perder
                exige motivo). Escolher "Ganho" aqui pulava os dois. */}
            <select value={estagio} onChange={e => setEstagio(e.target.value)} className={inputCls}>
              {ESTAGIOS.filter(e => e.key !== 'PERDIDO' && (edicao || e.key !== 'GANHO'))
                .map(e => <option key={e.key} value={e.key}>{e.label}</option>)}
            </select>
            {!edicao && (
              <p className="text-[11px] text-gray-400 mt-1">
                Para marcar ganho, crie a oportunidade e use o botão <strong>Ganhar</strong> —
                é ele que confere o estoque e abre a OV.
              </p>
            )}
          </Campo>
          <Campo label="Origem">
            <select value={origem} onChange={e => setOrigem(e.target.value)} className={inputCls}>
              <option value="">—</option>
              {ORIGENS.map(o => <option key={o} value={o}>{o}</option>)}
            </select>
          </Campo>
          <Campo label="Valor estimado">
            {/* Com itens lançados, o valor É a soma deles — deixar um campo
                editável ao lado da lista só produzia divergência (valor de
                50 mil com 52,5 mil em itens). Sem itens, vira palpite manual. */}
            {totalItens > 0 ? (
              <div className="border rounded-lg px-3 py-2 bg-gray-50">
                <p className="text-sm font-semibold text-gray-800 tabular-nums">{fmtBRL(totalItens)}</p>
                <p className="text-[11px] text-gray-400">soma dos {itens.length} item(ns)</p>
              </div>
            ) : (
              <InputMoeda value={valor} onChange={setValor} placeholder="0,00" />
            )}
          </Campo>
          <Campo label="Previsão de fechamento">
            <input type="date" value={previsao} onChange={e => setPrevisao(e.target.value)} className={inputCls} />
          </Campo>
        </div>
        <div>
          <label className="text-sm text-gray-600">Itens / produtos (opcional)</label>
          <p className="text-xs text-gray-400 mb-1.5">Se preencher com valor, o valor estimado é calculado automaticamente.</p>
          <ItensPedido value={itens} onChange={setItens} comValor />
          {/* Estoque já aqui, na criação: o comercial precisa saber se há material
              ANTES de prometer prazo ao cliente, não só ao fechar a venda. */}
          {itensValidos.length > 0 && (
            <div className="mt-2">
              <BlocoDisponibilidade analise={analise} carregando={analisando} />
            </div>
          )}
        </div>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => salvar.mutate()} disabled={!titulo.trim() || !canal || salvar.isPending}
          title={!canal ? 'Selecione o canal' : ''}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {salvar.isPending ? 'Salvando…' : edicao ? 'Salvar' : 'Criar oportunidade'}
        </button>
      </div>
      {novoContato && (
        <ModalNovoContato clienteId={clienteId} clienteNome={clienteNome}
          onClose={() => setNovoContato(false)}
          onSaved={async (novo) => { await refetchContatos(); setContatoId(novo.id); setNovoContato(false) }} />
      )}
    </ModalBase>
  )
}

// ── Cadastro rápido de contato (pelo comercial) ─────────────────────────────────────
function ModalNovoContato({ clienteId, clienteNome, onClose, onSaved }: {
  clienteId: string; clienteNome: string; onClose: () => void; onSaved: (novo: { id: string; nome: string }) => void
}) {
  const [nome, setNome] = useState('')
  const [cargo, setCargo] = useState('')
  const [email, setEmail] = useState('')
  const [telefone, setTelefone] = useState('')

  const m = useMutation({
    mutationFn: () => api.post('/crm/contatos', {
      nome: nome.trim(), cargo: cargo.trim() || null,
      email: email.trim() || null, telefone: telefone.trim() || null,
      cliente_id: clienteId || null,
    }),
    onSuccess: (res) => { toast.success('Contato cadastrado'); onSaved({ id: res.data.id, nome: res.data.nome }) },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao cadastrar contato'), { duration: 5000 }),
  })

  return (
    <ModalBase titulo="Novo contato" onClose={onClose} max="max-w-md">
      <div className="p-5 space-y-3">
        <p className="text-sm text-gray-500">Confirme o cadastro de um novo contato{clienteNome ? ` para ${clienteNome}` : ''}. E-mail e telefone são opcionais.</p>
        <Campo label="Nome *"><input value={nome} onChange={e => setNome(e.target.value)} className={inputCls} placeholder="Ex: Dra. Ana Souza" autoFocus /></Campo>
        <Campo label="Cargo"><input value={cargo} onChange={e => setCargo(e.target.value)} className={inputCls} placeholder="Opcional" /></Campo>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="E-mail (opcional)"><input type="email" value={email} onChange={e => setEmail(e.target.value)} className={inputCls} placeholder="nome@orgao.gov.br" /></Campo>
          <Campo label="Telefone (opcional)"><input value={telefone} onChange={e => setTelefone(e.target.value)} className={inputCls} placeholder="(00) 00000-0000" /></Campo>
        </div>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => m.mutate()} disabled={!nome.trim() || m.isPending}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {m.isPending ? 'Cadastrando…' : 'Cadastrar contato'}
        </button>
      </div>
    </ModalBase>
  )
}

/** Propostas geradas para esta oportunidade. Existe porque a proposta era
 *  invisível daqui: gerada automaticamente ao entrar em Proposta, ficava só na
 *  aba Cotações e quem fechava a aba de impressão não sabia como voltar. Cada
 *  proposta é persistida no momento em que nasce — reimprimir é sempre possível. */
function PainelPropostas({ oportunidadeId, onChanged }: { oportunidadeId: string; onChanged: () => void }) {
  const qc = useQueryClient()
  const { data: propostas = [] } = useQuery<any[]>({
    queryKey: ['crm-cotacoes-opp', oportunidadeId],
    queryFn: () => api.get('/crm/cotacoes', { params: { oportunidade_id: oportunidadeId } }).then(r => r.data),
  })

  const mudarStatus = useMutation({
    mutationFn: ({ pid, novo }: { pid: string; novo: string }) =>
      api.patch(`/crm/cotacoes/${pid}`, { status: novo }),
    onSuccess: (_r, { novo }) => {
      toast.success(novo === 'ENVIADA' ? 'Proposta marcada como enviada' : `Proposta ${novo.toLowerCase()}`)
      qc.invalidateQueries({ queryKey: ['crm-cotacoes-opp', oportunidadeId] })
      qc.invalidateQueries({ queryKey: ['crm-cotacoes'] })
      onChanged()
    },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao mudar status'), { duration: 5000 }),
  })

  if (propostas.length === 0) return null

  const alguremEnviada = propostas.some(p => p.enviada_em || ['ENVIADA', 'ACEITA'].includes(p.status))

  return (
    <div className="px-5 py-3 border-b">
      <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
        <FileText size={15} /> Propostas ({propostas.length})
      </h3>
      {/* Proposta enviada NÃO é mais exigida para ganhar (muita venda fecha por
          telefone e a proposta formal sai depois, ou nunca). O aviso continua como
          lembrete de registro, sem falar de travamento — que não existe mais. */}
      {!alguremEnviada && propostas.length > 0 && (
        <p className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded-lg px-2.5 py-2 mb-2">
          Nenhuma proposta marcada como enviada. Se já mandou ao cliente, clique em{' '}
          <strong>Marcar enviada</strong> abaixo para o histórico ficar correto.
        </p>
      )}
      <div className="space-y-1.5">
        {propostas.map(p => {
          const enviada = p.enviada_em || ['ENVIADA', 'ACEITA'].includes(p.status)
          return (
            <div key={p.id} className="flex items-center gap-2 text-sm border border-gray-100 rounded-lg px-3 py-1.5 flex-wrap">
              <span className="font-mono text-gray-700">{p.numero}</span>
              <span className="text-gray-600 tabular-nums">{fmtBRL(p.valor_total)}</span>
              {p.validade && <span className={`text-[11px] ${prazoCor(p.validade)}`}>val. {fmtData(p.validade)}</span>}
              <span className="text-[11px] px-2 py-0.5 rounded-full bg-gray-100 text-gray-600 ml-auto">{p.status}</span>
              <button onClick={() => window.open(`/crm/cotacao/${p.id}/imprimir`, '_blank')}
                className="flex items-center gap-1 text-xs text-blue-600 hover:underline whitespace-nowrap">
                <Printer size={12} /> Abrir
              </button>
              {!enviada && (
                <button onClick={() => mudarStatus.mutate({ pid: p.id, novo: 'ENVIADA' })}
                  disabled={mudarStatus.isPending}
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg bg-blue-600 text-white disabled:opacity-50 whitespace-nowrap">
                  <Send size={11} /> Marcar enviada
                </button>
              )}
              {p.status !== 'ACEITA' && (
                <button onClick={() => mudarStatus.mutate({ pid: p.id, novo: 'ACEITA' })}
                  disabled={mudarStatus.isPending}
                  title="Cliente aceitou — isso já marca a oportunidade como ganha"
                  className="flex items-center gap-1 text-xs px-2 py-1 rounded-lg border border-emerald-300 text-emerald-700 disabled:opacity-50 whitespace-nowrap">
                  <CheckCircle2 size={11} /> Aceita
                </button>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

/** Ganhar não é só mudar o status: é entregar o pedido para operações de vendas.
 *  O recado opcional aqui é o conteúdo da mensagem de Teams que o comercial
 *  mandava à mão — o que foi combinado e não cabe em campo estruturado. */
function ModalGanhar({ oportunidade: o, pendente, onClose, onConfirmar }: {
  oportunidade: any; pendente: boolean; onClose: () => void; onConfirmar: (nota: string) => void
}) {
  const [nota, setNota] = useState('')
  return (
    <ModalBase titulo="Marcar como ganha" onClose={onClose} max="max-w-md">
      <div className="p-5 space-y-3">
        <div className="bg-emerald-50 border border-emerald-200 rounded-lg p-3 text-xs text-emerald-900">
          <p className="font-semibold">{o.titulo}</p>
          <p className="mt-0.5">{o.cliente || 'Sem cliente'} · {fmtBRL(o.valor_estimado)}</p>
        </div>
        <div className="bg-blue-50 border border-blue-100 rounded-lg p-2.5 text-xs text-blue-800">
          Ao confirmar, o app confere o estoque. Tendo material, a OV já cai em{' '}
          <strong>Dados da OV</strong> no kanban da Expedição e operações de vendas é avisada
          no Teams. Faltando material, você escolhe entre seguir com o disponível ou aguardar
          a produção.
        </div>
        <Campo label="Recado para operações de vendas (opcional)">
          <textarea value={nota} onChange={e => setNota(e.target.value)} rows={3} className={inputCls}
            placeholder="Ex.: cliente precisa receber até dia 10, combinei frete CIF" autoFocus />
        </Campo>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => onConfirmar(nota)} disabled={pendente}
          className="flex items-center gap-1.5 px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium rounded-lg">
          <Trophy size={15} /> {pendente ? 'Marcando…' : 'Confirmar ganho'}
        </button>
      </div>
    </ModalBase>
  )
}

// ── Detalhe da oportunidade ────────────────────────────────────────────────────────
function ModalDetalheOportunidade({ id, onClose, onChanged }: { id: string; onClose: () => void; onChanged: () => void }) {
  const qc = useQueryClient()
  const navigate = useNavigate()
  const [editar, setEditar] = useState(false)
  const [perder, setPerder] = useState(false)
  const [ganhando, setGanhando] = useState(false)
  const [gerarOV, setGerarOV] = useState(false)
  const [nota, setNota] = useState('')
  const [novaAtiv, setNovaAtiv] = useState(false)
  const [moverPara, setMoverPara] = useState<string | null>(null)

  const { data: o } = useQuery<any>({
    queryKey: ['crm-opp', id],
    queryFn: () => api.get(`/crm/oportunidades/${id}`).then(r => r.data),
  })

  const refresh = () => { qc.invalidateQueries({ queryKey: ['crm-opp', id] }); onChanged() }

  // Guarda o recado enquanto o comercial decide o estoque, para não redigitar.
  const [notaGanho, setNotaGanho] = useState('')
  const [faltaEstoque, setFaltaEstoque] = useState<Disponibilidade | null>(null)

  const ganhar = useMutation({
    mutationFn: (v: { nota?: string; decisao?: DecisaoEstoque }) =>
      api.post(`/crm/oportunidades/${id}/ganhar`, {
        repasse_nota: v.nota?.trim() || null,
        decisao_estoque: v.decisao?.decisao || null,
        observacao_estoque: v.decisao?.observacao || null,
        previsao_pcp: v.decisao?.previsao_pcp || null,
      }),
    onSuccess: (_r, v) => {
      if (v.decisao?.decisao === 'AGUARDAR') {
        toast.success('Ganha e aguardando produção — nenhuma OV foi aberta ainda.', { duration: 7000 })
      } else if (v.decisao?.decisao === 'PARCIAL') {
        toast.success('Ganha! A OV saiu só com o que temos; o saldo ficou como pendência.', { duration: 7000 })
      } else {
        toast.success('🏆 Ganha! A OV já caiu em "Dados da OV" no kanban da Expedição.',
          { duration: 6000 })
      }
      setGanhando(false); setFaltaEstoque(null); refresh()
    },
    onError: (e: any) => {
      // 409 com a análise = falta material. Em vez de erro, abre a decisão.
      const d = e?.response?.data?.detail
      if (d?.tipo === 'ESTOQUE_INSUFICIENTE' && d.analise) {
        setGanhando(false)
        setFaltaEstoque(d.analise)
        return
      }
      toast.error(msgErro(e, 'Não foi possível marcar como ganha'), { duration: 6000 })
    },
  })
  const addNota = useMutation({
    mutationFn: () => api.post(`/crm/oportunidades/${id}/notas`, { texto: nota.trim() }),
    onSuccess: () => { setNota(''); refresh() },
  })
  const excluir = useMutation({
    mutationFn: () => api.delete(`/crm/oportunidades/${id}`),
    onSuccess: () => { toast.success('Oportunidade removida'); onChanged(); onClose() },
  })
  const concluirAtiv = useMutation({
    mutationFn: ({ aid, c }: { aid: string; c: boolean }) => api.post(`/crm/atividades/${aid}/concluir?concluida=${c}`),
    onSuccess: refresh,
  })

  if (!o) return <ModalBase titulo="Oportunidade" onClose={onClose}><p className="p-8 text-center text-gray-400 text-sm">Carregando…</p></ModalBase>

  const cfg = ESTAGIO_MAP[o.estagio]
  const fechada = o.estagio === 'GANHO' || o.estagio === 'PERDIDO'
  const timeline = [...(o.notas || [])]

  return (
    <ModalBase titulo={<span className="flex items-center gap-2"><Target size={17} /> {o.titulo}</span>} onClose={onClose} max="max-w-3xl">
      <div className="flex-1 overflow-y-auto">
        {/* Cabeçalho */}
        <div className="px-5 py-4 bg-gray-50 border-b">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm text-gray-700 font-medium">{o.cliente || 'Sem cliente'}</p>
              {o.contato && <p className="text-xs text-gray-500">{o.contato.nome}{o.contato.cargo ? ` · ${o.contato.cargo}` : ''}{o.contato.telefone ? ` · ${o.contato.telefone}` : ''}</p>}
              <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-gray-400 mt-1">
                {o.canal && <span>{CANAL_LABEL[o.canal] || o.canal}</span>}
                {o.origem && <span>Origem: {o.origem}</span>}
                {o.previsao_fechamento && <span className={prazoCor(o.previsao_fechamento)}>Previsão: {fmtData(o.previsao_fechamento)}</span>}
              </div>
            </div>
            <div className="text-right">
              <p className="text-xl font-bold text-gray-800">{fmtBRL(o.valor_estimado)}</p>
              <span className={`text-xs px-2 py-0.5 rounded-full ${cfg?.chip || ''}`}>{cfg?.label} · {o.probabilidade}%</span>
              <p className="text-[11px] text-gray-400 mt-0.5">ponderado {fmtBRL(o.valor_ponderado)}</p>
            </div>
          </div>

          {/* Fluxo linear, não seletor de etapa: um botão só, "Avançar". Desafios
              não é degrau — é desvio que o sistema entra/sai sozinho (ver
              PainelDesafios). Clicar não move direto: abre o modal que cobra a
              informação daquela passagem específica. */}
          {!fechada && <FluxoAvanco oportunidade={o} onMover={setMoverPara} onEditar={() => setEditar(true)} />}
          {o.estagio === 'PERDIDO' && o.motivo_perda && (
            <div className="mt-3 text-xs bg-red-50 text-red-700 rounded-lg p-2">Perdida — {o.motivo_perda}</div>
          )}
          {/* Ganha: mostra em que pé está o repasse para operações de vendas.
              Antes só havia o botão "Gerar OV" — o comercial não tinha como
              saber se alguém já tinha pegado o pedido sem perguntar no Teams. */}
          {o.estagio === 'GANHO' && (
            <div className="mt-3 space-y-2">
              <div className="text-xs bg-emerald-50 text-emerald-700 rounded-lg p-2 flex items-center justify-between gap-2 flex-wrap">
                <span>🏆 Ganha em {fmtData(o.ganho_em)}</span>
                {o.gerado_ov_ref
                  ? <button onClick={() => o.gerado_ov_id && navigate(`/expedicao/${o.gerado_ov_id}`)} className="underline flex items-center gap-1"><ExternalLink size={12} /> OV {o.gerado_ov_ref}</button>
                  : o.pendencia_aberta
                    // Com pendência aberta a OV NÃO nasce por aqui — nasce ao liberar
                    // o estoque, com a quantidade que existe. Deixar o botão aqui era
                    // oferecer um caminho que o servidor recusa.
                    ? <span className="text-emerald-800">OV sai ao liberar o estoque, abaixo</span>
                    : <button onClick={() => setGerarOV(true)} className="flex items-center gap-1 bg-emerald-600 text-white px-2 py-1 rounded"><Package size={12} /> Cadastrar OV do D365</button>}
              </div>
              {/* Ganha, sem pendência e SEM OV é anomalia — no fluxo normal a OV
                  nasce junto com o ganho. Avisa em vez de deixar a venda parada
                  em silêncio, que era o que a fila de repasse escondia. */}
              {!o.gerado_ov_ref && !o.pendencia_aberta && (
                <div className="text-xs rounded-lg p-2 border bg-amber-50 border-amber-200 text-amber-800">
                  Esta venda ficou <strong>sem OV</strong>, e não há pendência de estoque —
                  não é o esperado. Use <strong>Cadastrar OV do D365</strong> acima para
                  destravar.
                  {o.repasse_nota && <p className="mt-1 text-gray-600">Recado do comercial: {o.repasse_nota}</p>}
                </div>
              )}
            </div>
          )}
        </div>

        <PainelEstoqueDaVenda oportunidade={o} onChanged={refresh} />
        <PainelDesafios oportunidadeId={id} onChanged={refresh} />
        <PainelPropostas oportunidadeId={id} onChanged={refresh} />

        {/* Ações rápidas */}
        <div className="px-5 py-3 border-b flex flex-wrap gap-2">
          <button onClick={() => setEditar(true)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 border rounded-lg text-gray-600 hover:bg-gray-50"><Pencil size={14} /> Editar</button>
          {!fechada && <button onClick={() => setGanhando(true)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white"><Trophy size={14} /> Ganhar</button>}
          {!fechada && <button onClick={() => setPerder(true)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-red-200 text-red-600 hover:bg-red-50"><XCircle size={14} /> Perder</button>}
          <button onClick={() => setNovaAtiv(true)} className="flex items-center gap-1.5 text-sm px-3 py-1.5 border rounded-lg text-gray-600 hover:bg-gray-50"><CalendarPlus size={14} /> Atividade</button>
          <button onClick={() => { if (confirm('Remover esta oportunidade?')) excluir.mutate() }} className="flex items-center gap-1.5 text-sm px-3 py-1.5 text-gray-400 hover:text-red-600 ml-auto"><Trash2 size={14} /> Remover</button>
        </div>

        <div className="grid md:grid-cols-2 gap-0 divide-x divide-gray-100">
          {/* Coluna esquerda: itens + atividades */}
          <div className="p-5 space-y-4">
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1.5"><Package size={15} /> Itens</h3>
              {(o.itens || []).length === 0 ? (
                <div className="text-xs text-gray-400 bg-gray-50 rounded-lg p-2.5">
                  Nenhum item ainda. A proposta é gerada a partir deles — clique em{' '}
                  <button onClick={() => setEditar(true)} className="text-blue-600 underline">Editar</button>{' '}
                  para adicionar produto, quantidade e preço.
                </div>
              ) : (
                <div className="border border-gray-100 rounded-lg divide-y divide-gray-50">
                  {o.itens.map((it: any, i: number) => (
                    <div key={i} className="flex justify-between px-3 py-1.5 text-sm">
                      <span><span className="font-mono text-gray-700">{it.codigo || '—'}</span> <span className="text-gray-500">{it.descricao}</span></span>
                      <span className="text-gray-600 tabular-nums">{it.qtd} × {fmtBRL(it.valor_unitario)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1.5"><CalendarPlus size={15} /> Atividades</h3>
              {(o.atividades || []).length === 0 ? (
                <p className="text-xs text-gray-400">Nenhuma atividade agendada.</p>
              ) : (
                <div className="space-y-1.5">
                  {o.atividades.map((a: any) => (
                    <div key={a.id} className={`flex items-start gap-2 text-sm p-2 rounded-lg border ${a.concluida ? 'bg-gray-50 border-gray-100' : 'border-gray-200'}`}>
                      <button onClick={() => concluirAtiv.mutate({ aid: a.id, c: !a.concluida })} className="mt-0.5">
                        <CheckCircle2 size={16} className={a.concluida ? 'text-emerald-500' : 'text-gray-300 hover:text-emerald-500'} />
                      </button>
                      <div className="flex-1 min-w-0">
                        <p className={`${a.concluida ? 'line-through text-gray-400' : 'text-gray-700'}`}>
                          {TIPO_ATIV_MAP[a.tipo]?.icone} {a.titulo}
                        </p>
                        {a.data_hora && <p className={`text-[11px] ${!a.concluida ? prazoCor(a.data_hora) : 'text-gray-400'}`}>{fmtDataHora(a.data_hora)}</p>}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Coluna direita: timeline */}
          <div className="p-5">
            <h3 className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1.5"><MessageSquare size={15} /> Timeline</h3>
            <div className="flex gap-2 mb-3">
              <input value={nota} onChange={e => setNota(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter' && nota.trim()) addNota.mutate() }}
                placeholder="Escreva uma nota e Enter…" className="flex-1 border rounded-lg px-3 py-2 text-sm" />
              <button onClick={() => nota.trim() && addNota.mutate()} disabled={!nota.trim()}
                className="px-3 py-2 text-sm bg-blue-600 disabled:opacity-40 text-white rounded-lg">Add</button>
            </div>
            <div className="space-y-3">
              {timeline.length === 0 && <p className="text-xs text-gray-400">Sem registros ainda.</p>}
              {timeline.map((n: any) => (
                <div key={n.id} className="flex gap-2">
                  <div className={`w-1.5 h-1.5 rounded-full mt-1.5 flex-shrink-0 ${n.tipo === 'EVENTO' ? 'bg-blue-400' : 'bg-gray-300'}`} />
                  <div className="flex-1">
                    <p className={`text-sm ${n.tipo === 'EVENTO' ? 'text-gray-500 italic' : 'text-gray-700'}`}>{n.texto}</p>
                    <p className="text-[11px] text-gray-400">{fmtDataHora(n.criado_em)}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {moverPara && <ModalMover oportunidade={o} destino={moverPara}
        onClose={() => setMoverPara(null)} onSaved={refresh} />}
      {ganhando && <ModalGanhar oportunidade={o} pendente={ganhar.isPending}
        onClose={() => setGanhando(false)}
        onConfirmar={(nota) => { setNotaGanho(nota); ganhar.mutate({ nota }) }} />}
      {faltaEstoque && (
        <ModalDecisaoEstoque analise={faltaEstoque} pendente={ganhar.isPending}
          onClose={() => setFaltaEstoque(null)}
          onDecidir={(d) => ganhar.mutate({ nota: notaGanho, decisao: d })} />
      )}
      {editar && <ModalOportunidadeForm oportunidade={o} onClose={() => setEditar(false)} onSaved={refresh} />}
      {perder && <ModalPerder id={id} onClose={() => setPerder(false)} onSaved={refresh} />}
      {gerarOV && <ModalGerarOV opp={o} onClose={() => setGerarOV(false)} onSaved={refresh} />}
      {novaAtiv && <ModalNovaAtividade oportunidadeId={id} clienteId={o.cliente_id} onClose={() => setNovaAtiv(false)} onSaved={refresh} />}
    </ModalBase>
  )
}

/** Estoque da venda, dentro do detalhe da oportunidade.
 *
 *  Fica visível desde a criação, antes de qualquer decisão: o comercial não
 *  deveria descobrir que falta material só na hora de fechar. Quando já existe
 *  pendência registrada, mostra a pendência (o que foi prometido) em vez da
 *  disponibilidade de agora — são coisas diferentes e confundi-las apagaria o
 *  histórico da decisão. */
function PainelEstoqueDaVenda({ oportunidade: o, onChanged }: {
  oportunidade: any; onChanged: () => void
}) {
  const [liberando, setLiberando] = useState(false)
  const temItens = (o.itens || []).some((i: any) => i.produto_id && Number(i.qtd) > 0)
  const pend = o.pendencia_aberta ? o.pendencia : null

  // Consulta sempre que houver itens. Com pendência aberta ela é o que responde
  // "o que já dá para mandar para a expedição agora" — sem isso o comercial via
  // apenas o item em falta e não sabia que o resto da venda estava pronto.
  const { data: analise, isLoading } = useQuery<Disponibilidade>({
    queryKey: ['crm-disp', o.id],
    queryFn: () => api.get(`/crm/oportunidades/${o.id}/disponibilidade`).then(r => r.data),
    enabled: temItens,
    staleTime: 60_000,
  })
  const prontos = (analise?.itens || []).filter(i => (i.qtd_atendida || 0) > 0)
  const valorPronto = prontos.reduce(
    (a, i) => a + (i.qtd_atendida || 0) * (i.valor_unitario || 0), 0)
  // Só faz sentido oferecer liberação parcial quando NADA saiu ainda (decisão
  // "aguardar"); com a OV já aberta, o que sobrou é saldo e vira 2ª remessa.
  const podeLiberarParcial = !!pend && pend.decisao === 'AGUARDAR' && prontos.length > 0

  const { data: pendencias } = useQuery<PendenciasResp>({
    queryKey: ['crm-pendencias'],
    queryFn: () => api.get('/crm/pendencias').then(r => r.data),
    enabled: !!pend,
  })
  const registro = pendencias?.pendencias?.find(p => p.fonte === 'oportunidade' && p.id === o.id)

  if (!temItens) return null

  return (
    <div className="border-t pt-4 mt-4">
      <p className="text-sm font-semibold text-gray-700 mb-2 flex items-center gap-1.5">
        <Package size={15} /> Estoque da venda
      </p>

      {pend ? (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 space-y-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="text-sm font-semibold text-red-800">
                Pendência de estoque · {fmtBRL(pend.valor)}
              </p>
              <p className="text-xs text-red-700 mt-0.5">
                {pend.decisao === 'AGUARDAR'
                  ? 'Aguardando produção — nenhuma OV foi aberta para esta venda ainda.'
                  : 'A OV saiu só com o material disponível; o saldo entra como 2ª remessa.'}
              </p>
            </div>
            {registro?.pode_liberar && (
              <button onClick={() => setLiberando(true)}
                className="text-xs font-medium bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg px-3 py-1.5 whitespace-nowrap">
                {/* O rótulo diz o que o clique faz AGORA: com parte em estoque a
                    ação é liberar essa parte, não anunciar que o material chegou. */}
                {podeLiberarParcial ? 'Liberar o que tem em estoque' : 'Material chegou'}
              </button>
            )}
          </div>

          {/* O que já pode ir para operações de vendas. Antes o bloco listava só o
              item em falta, então um item COM estoque esperando junto ficava
              invisível — era o caso que expôs o problema. */}
          {prontos.length > 0 && (
            <div className="bg-emerald-50 border border-emerald-200 rounded-lg px-2.5 py-2">
              <p className="text-xs font-semibold text-emerald-800">
                Pronto para liberar agora · {fmtBRL(valorPronto)}
              </p>
              {prontos.map((i, idx) => (
                <div key={idx} className="flex items-center justify-between text-xs text-emerald-900 py-0.5">
                  <span>{i.codigo || '—'}</span>
                  <span>{i.qtd_atendida} de {i.qtd_pedida} un em estoque</span>
                </div>
              ))}
            </div>
          )}
          <div className="bg-white rounded-lg border border-red-100 px-2.5 py-1.5">
            {(pend.itens || []).map((i: any, idx: number) => (
              <div key={idx} className="flex items-center justify-between text-xs py-0.5">
                <span className="text-gray-700">{i.codigo || '—'}</span>
                <span className="text-gray-500">
                  entregue {Number(i.qtd_atendida) || 0} de {Number(i.qtd_pedida) || 0} ·{' '}
                  <strong className="text-red-600">faltam {Number(i.qtd_pendente) || 0}</strong>
                </span>
              </div>
            ))}
          </div>
          {pend.previsao_pcp && (
            <p className="text-[11px] text-red-700">Previsão do PCP: {fmtData(pend.previsao_pcp)}</p>
          )}
          {pend.observacao && <p className="text-[11px] text-gray-600">Obs.: {pend.observacao}</p>}
          {registro && !registro.pode_liberar && registro.motivo_bloqueio && (
            <p className="text-[11px] text-amber-800">{registro.motivo_bloqueio}</p>
          )}
        </div>
      ) : (
        <BlocoDisponibilidade analise={analise} carregando={isLoading} />
      )}

      {liberando && registro && (
        <ModalLiberarPendencia pendencia={registro}
          analise={podeLiberarParcial ? analise : null}
          onClose={() => setLiberando(false)}
          onLiberado={onChanged} />
      )}
    </div>
  )
}

/** Passagem de etapa: pede a informação e só então move.
 *
 *  Antes o card andava arrastando, sem registrar nada — ninguém sabia depois o
 *  que tinha acontecido naquela passagem. Agora cada etapa cobra o que faz
 *  sentido para ela, e o botão só libera com o que o servidor exige:
 *
 *    → Desafios     qual é o problema (registra o desafio)
 *    → Negociação   o que foi acordado + próximo passo
 *    → Proposta     itens conferidos + próximo passo
 *
 *  Os requisitos vêm do servidor (/requisitos), então a tela nunca discorda da
 *  regra — e mostra o que falta antes de tentar, em vez de dar erro depois.
 */
function ModalMover({ oportunidade, destino, onClose, onSaved }: {
  oportunidade: any; destino: string; onClose: () => void; onSaved: () => void
}) {
  const cfgDest = ESTAGIO_MAP[destino]
  const cfgAtual = ESTAGIO_MAP[oportunidade?.estagio]
  const id = oportunidade?.id

  const [passo, setPasso] = useState(oportunidade?.proximo_passo || '')
  const [passoEm, setPassoEm] = useState(oportunidade?.proximo_passo_em || '')
  const [nota, setNota] = useState('')
  // Só para → Desafios: o problema é a informação que justifica a passagem.
  const [problema, setProblema] = useState('')
  const [tipoId, setTipoId] = useState<string | null>(null)
  const [prazoDesafio, setPrazoDesafio] = useState('')
  // Vem marcado: o passo que não está na agenda é o passo que ninguém cobra.
  const [criarAtiv, setCriarAtiv] = useState(true)
  const [ativTipo, setAtivTipo] = useState('TAREFA')
  const [ativHora, setAtivHora] = useState('09:00')

  const paraDesafios = destino === 'DESAFIOS'
  // Voltar etapa é correção de rota: não se cobra nada além de saber por quê.
  const voltando = (ESTAGIOS_PIPELINE.indexOf(destino as EstagioKey)
    < ESTAGIOS_PIPELINE.indexOf(oportunidade?.estagio))

  const { data: req } = useQuery<any>({
    queryKey: ['crm-requisitos', id, destino],
    queryFn: () => api.get(`/crm/oportunidades/${id}/requisitos`, { params: { destino } }).then(r => r.data),
    enabled: !!id && !paraDesafios,
  })
  const { data: sugestoes = [] } = useQuery<any[]>({
    queryKey: ['crm-desafio-tipos', problema],
    queryFn: () => api.get('/crm/desafios/tipos', { params: problema ? { q: problema } : {} }).then(r => r.data),
    enabled: paraDesafios,
  })

  const mover = useMutation({
    mutationFn: async () => {
      let cotacaoGeradaId: string | null = null
      if (paraDesafios) {
        // Registrar o desafio JÁ move o card para Desafios no servidor.
        await api.post(`/crm/oportunidades/${id}/desafios`, {
          tipo_id: tipoId, tipo_texto: tipoId ? null : problema.trim() || null,
          prazo: prazoDesafio || null, bloqueia: true,
        })
      } else {
        const body: any = { estagio: destino }
        if (passo.trim()) body.proximo_passo = passo.trim()
        if (passoEm) body.proximo_passo_em = passoEm
        const res = await api.patch(`/crm/oportunidades/${id}`, body)
        cotacaoGeradaId = res.data?.cotacao_gerada_id || null
      }
      let agendou = false
      if (criarAtiv && !paraDesafios && !voltando && passo.trim()) {
        await api.post('/crm/atividades', {
          oportunidade_id: id, tipo: ativTipo, titulo: passo.trim(),
          data_hora: passoEm ? `${passoEm}T${ativHora || '09:00'}:00` : null,
        })
        agendou = true
      }
      if (nota.trim()) {
        await api.post(`/crm/oportunidades/${id}/notas`, { texto: nota.trim() })
      }
      return { cotacaoGeradaId, agendou }
    },
    onSuccess: ({ cotacaoGeradaId, agendou }) => {
      toast.success(`Movida para ${cfgDest?.label}${agendou ? ' · atividade agendada' : ''}`)
      if (cotacaoGeradaId) {
        toast.success('Proposta gerada automaticamente a partir dos itens negociados', { duration: 5000 })
        window.open(`/crm/cotacao/${cotacaoGeradaId}/imprimir`, '_blank')
      }
      onSaved(); onClose()
    },
    onError: (e: any) => toast.error(msgErro(e, 'Não foi possível mover'), { duration: 6000 }),
  })

  // O que o servidor ainda cobra, tirando o próximo passo (que este modal coleta).
  const bloqueios = (req?.falta || []).filter((f: string) => !f.startsWith('próximo passo'))
  const exigePasso = (req?.falta || []).some((f: string) => f.startsWith('próximo passo'))
  const pronto = paraDesafios
    ? !!problema.trim()
    : bloqueios.length === 0 && (voltando || !exigePasso || !!passo.trim())

  return (
    <ModalBase titulo={`${cfgAtual?.label || '—'} → ${cfgDest?.label}`} onClose={onClose} max="max-w-lg">
      <div className="p-5 space-y-3 overflow-y-auto">
        {/* Bloqueios que o modal não resolve: some fora daqui (itens, proposta...). */}
        {bloqueios.length > 0 && (
          <div className="bg-red-50 border border-red-200 rounded-xl p-3">
            <p className="text-xs font-bold text-red-800 flex items-center gap-1.5">
              <AlertTriangle size={13} /> Falta resolver antes
            </p>
            <ul className="mt-1.5 space-y-1">
              {bloqueios.map((f: string) => (
                <li key={f} className="text-xs text-red-700">• {f}</li>
              ))}
            </ul>
          </div>
        )}

        {paraDesafios ? (
          <>
            <p className="text-xs text-gray-400">
              Registre o problema que está travando. O card fica em Desafios e a negociação
              só volta a andar quando ele for resolvido.
            </p>
            <Campo label="Qual é o problema? *">
              <input value={problema} autoFocus
                onChange={e => { setProblema(e.target.value); setTipoId(null) }}
                placeholder="Ex.: hospital exige cadastro no portal de compras"
                className={inputCls} />
            </Campo>
            {problema.trim() && sugestoes.length > 0 && !tipoId && (
              <div className="flex flex-wrap gap-1">
                <span className="text-[11px] text-gray-400 self-center">já existe:</span>
                {sugestoes.slice(0, 4).map(s => (
                  <button key={s.id} type="button"
                    onClick={() => { setTipoId(s.id); setProblema(s.label) }}
                    className="text-[11px] px-2 py-0.5 rounded-full bg-white border border-orange-300 text-orange-800 hover:bg-orange-100">
                    {s.label}{s.usos > 0 ? ` · ${s.usos}` : ''}
                  </button>
                ))}
              </div>
            )}
            {tipoId && <p className="text-[11px] text-emerald-700">✓ usando tipo já cadastrado</p>}
            <Campo label="Prazo para resolver">
              <input type="date" value={prazoDesafio} onChange={e => setPrazoDesafio(e.target.value)} className={inputCls} />
            </Campo>
          </>
        ) : voltando ? (
          <p className="text-xs text-gray-500">
            Voltando etapa — correção de rota. Registre o motivo na nota abaixo para o
            histórico não ficar sem explicação.
          </p>
        ) : (
          <>
            <p className="text-xs text-gray-400">
              {destino === 'NEGOCIACAO' && 'O que ficou acordado e qual o próximo passo — sem isso o card para e ninguém sabe o que fazer.'}
              {destino === 'PROPOSTA' && 'A proposta é gerada dos itens da oportunidade. Confirme o próximo passo do envio.'}
              {destino === 'QUALIFICACAO' && 'Defina o próximo passo para a oportunidade não ficar parada.'}
            </p>
            <Campo label={`Próximo passo ${exigePasso ? '*' : ''}`}>
              <input value={passo} onChange={e => setPasso(e.target.value)} autoFocus
                placeholder={destino === 'PROPOSTA' ? 'Ex.: enviar proposta e confirmar recebimento'
                  : 'Ex.: retornar com desconto aprovado'}
                className={inputCls} />
            </Campo>
            <Campo label="Quando">
              <input type="date" value={passoEm} onChange={e => setPassoEm(e.target.value)} className={inputCls} />
            </Campo>
            {/* O próximo passo é só texto no card — não cobra ninguém. Virar
                atividade é o que faz aparecer na agenda e nos pendentes. */}
            <label className="flex items-start gap-2 bg-blue-50 border border-blue-100 rounded-lg p-2.5 cursor-pointer">
              <input type="checkbox" checked={criarAtiv} onChange={e => setCriarAtiv(e.target.checked)} className="mt-0.5" />
              <span className="text-xs text-blue-900">
                Agendar como atividade
                <span className="block text-blue-700/70">
                  Cria a tarefa na agenda com esse texto e essa data — sem isso o próximo passo
                  fica só escrito no card.
                </span>
              </span>
            </label>
            {criarAtiv && (
              <div className="grid grid-cols-2 gap-3">
                <Campo label="Tipo de atividade">
                  <select value={ativTipo} onChange={e => setAtivTipo(e.target.value)} className={inputCls}>
                    {TIPOS_ATIVIDADE.map(t => <option key={t.key} value={t.key}>{t.icone} {t.label}</option>)}
                  </select>
                </Campo>
                <Campo label="Hora">
                  <input type="time" value={ativHora} onChange={e => setAtivHora(e.target.value)} className={inputCls} />
                </Campo>
              </div>
            )}
          </>
        )}

        <Campo label={voltando ? 'Motivo *' : 'O que aconteceu (opcional)'}>
          <textarea value={nota} onChange={e => setNota(e.target.value)} rows={2} className={inputCls}
            placeholder={voltando ? 'Por que está voltando esta etapa' : 'Vai para a timeline da oportunidade'} />
        </Campo>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm text-gray-600 hover:bg-gray-100 rounded-lg">Cancelar</button>
        <button onClick={() => mover.mutate()}
          disabled={!pronto || (voltando && !nota.trim()) || mover.isPending}
          className="bg-blue-600 text-white px-4 py-2 rounded-lg text-sm font-medium hover:bg-blue-700 disabled:opacity-50">
          {mover.isPending ? 'Movendo…' : `Mover para ${cfgDest?.label}`}
        </button>
      </div>
    </ModalBase>
  )
}

/** Desafios/problemas que travam a negociação.
 *
 *  O tipo é um vocabulário que APRENDE: o operador escreve o problema com as
 *  palavras dele e o sistema cadastra como tipo reutilizável. O autocomplete
 *  (ordenado por uso) é o que faz a próxima pessoa escolher o tipo existente em
 *  vez de criar a 50ª variação do mesmo problema. */
function PainelDesafios({ oportunidadeId, onChanged }: { oportunidadeId: string; onChanged: () => void }) {
  const qc = useQueryClient()
  const [novo, setNovo] = useState(false)
  const [texto, setTexto] = useState('')
  const [tipoId, setTipoId] = useState<string | null>(null)
  const [descricao, setDescricao] = useState('')
  const [prazo, setPrazo] = useState('')
  const [bloqueia, setBloqueia] = useState(true)

  const { data: desafios = [] } = useQuery<any[]>({
    queryKey: ['crm-desafios', oportunidadeId],
    queryFn: () => api.get(`/crm/oportunidades/${oportunidadeId}/desafios`).then(r => r.data),
  })
  // Sugestões conforme digita — busca no servidor pelo texto normalizado.
  const { data: sugestoes = [] } = useQuery<any[]>({
    queryKey: ['crm-desafio-tipos', texto],
    queryFn: () => api.get('/crm/desafios/tipos', { params: texto ? { q: texto } : {} }).then(r => r.data),
    enabled: novo,
  })

  const recarregar = () => {
    qc.invalidateQueries({ queryKey: ['crm-desafios', oportunidadeId] })
    qc.invalidateQueries({ queryKey: ['crm-desafio-tipos'] })
    onChanged()
  }

  const criar = useMutation({
    mutationFn: () => api.post(`/crm/oportunidades/${oportunidadeId}/desafios`, {
      tipo_id: tipoId, tipo_texto: tipoId ? null : texto.trim() || null,
      descricao: descricao || null, prazo: prazo || null, bloqueia,
    }).then(r => r.data),
    onSuccess: () => {
      toast.success('Desafio registrado')
      setNovo(false); setTexto(''); setTipoId(null); setDescricao(''); setPrazo(''); setBloqueia(true)
      recarregar()
    },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao registrar'), { duration: 5000 }),
  })

  const mudar = useMutation({
    mutationFn: ({ id, body }: { id: string; body: any }) =>
      api.patch(`/crm/desafios/${id}`, body).then(r => r.data),
    onSuccess: () => { recarregar() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao atualizar')),
  })

  const abertos = desafios.filter(d => d.status === 'ABERTO')
  const bloqueantes = abertos.filter(d => d.bloqueia)

  return (
    <div className="border-t px-5 py-4">
      <div className="flex items-center justify-between mb-2">
        <div>
          <p className="text-sm font-bold text-gray-800 flex items-center gap-1.5">
            <AlertTriangle size={14} className={bloqueantes.length ? 'text-orange-500' : 'text-gray-300'} />
            Desafios
            {abertos.length > 0 && <span className="text-xs font-normal text-gray-400">({abertos.length} aberto)</span>}
          </p>
          {bloqueantes.length > 0 && (
            <p className="text-[11px] text-orange-600 mt-0.5">
              {bloqueantes.length} bloqueante(s) — a negociação não avança até resolver
            </p>
          )}
        </div>
        {!novo && (
          <button onClick={() => setNovo(true)}
            className="text-xs font-medium px-2.5 py-1.5 rounded-lg bg-orange-50 text-orange-700 hover:bg-orange-100">
            + Registrar problema
          </button>
        )}
      </div>

      {novo && (
        <div className="bg-orange-50/60 border border-orange-200 rounded-xl p-3 space-y-2 mb-3">
          <div>
            <label className="text-xs text-gray-600">Qual é o problema?</label>
            <input value={texto} autoFocus
              onChange={e => { setTexto(e.target.value); setTipoId(null) }}
              placeholder="Escreva com suas palavras — ex.: hospital exige cadastro no portal de compras"
              className={inputCls} />
            {/* Se já existe algo parecido, oferece antes de criar tipo novo. */}
            {texto.trim() && sugestoes.length > 0 && !tipoId && (
              <div className="mt-1.5 flex flex-wrap gap-1">
                <span className="text-[11px] text-gray-400 self-center">já existe:</span>
                {sugestoes.slice(0, 4).map(s => (
                  <button key={s.id} type="button"
                    onClick={() => { setTipoId(s.id); setTexto(s.label) }}
                    className="text-[11px] px-2 py-0.5 rounded-full bg-white border border-orange-300 text-orange-800 hover:bg-orange-100">
                    {s.label}{s.usos > 0 ? ` · ${s.usos}` : ''}
                  </button>
                ))}
              </div>
            )}
            {tipoId && <p className="text-[11px] text-emerald-700 mt-1">✓ usando tipo já cadastrado</p>}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input value={descricao} onChange={e => setDescricao(e.target.value)}
              placeholder="Detalhe do caso (opcional)" className={inputCls} />
            <input type="date" value={prazo} onChange={e => setPrazo(e.target.value)} className={inputCls} />
          </div>
          <label className="flex items-center gap-2 text-xs text-gray-600">
            <input type="checkbox" checked={bloqueia} onChange={e => setBloqueia(e.target.checked)} />
            Impede avançar para negociação
          </label>
          <div className="flex justify-end gap-2">
            <button onClick={() => { setNovo(false); setTexto(''); setTipoId(null) }}
              className="px-3 py-1.5 text-xs text-gray-600 hover:bg-white rounded-lg">Cancelar</button>
            <button onClick={() => criar.mutate()} disabled={!texto.trim() || criar.isPending}
              className="px-3 py-1.5 text-xs bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50">
              Registrar
            </button>
          </div>
        </div>
      )}

      {desafios.length === 0 ? (
        <p className="text-xs text-gray-400">Nenhum desafio registrado — o caminho está livre.</p>
      ) : (
        <div className="space-y-1.5">
          {desafios.map(d => (
            <div key={d.id}
              className={`flex items-start gap-2 rounded-lg px-2.5 py-2 ${
                d.status !== 'ABERTO' ? 'bg-gray-50' : d.bloqueia ? 'bg-orange-50' : 'bg-amber-50/50'}`}>
              <button onClick={() => mudar.mutate({
                id: d.id, body: { status: d.status === 'ABERTO' ? 'RESOLVIDO' : 'ABERTO' },
              })}
                title={d.status === 'ABERTO' ? 'Marcar como resolvido' : 'Reabrir'}
                className="mt-0.5 shrink-0">
                {d.status === 'ABERTO'
                  ? <Circle size={15} className="text-gray-400 hover:text-emerald-600" />
                  : <CheckCircle2 size={15} className="text-emerald-600" />}
              </button>
              <div className="min-w-0 flex-1">
                <p className={`text-xs font-medium ${d.status !== 'ABERTO' ? 'text-gray-400 line-through' : 'text-gray-800'}`}>
                  {d.tipo || d.descricao}
                </p>
                {d.tipo && d.descricao && <p className="text-[11px] text-gray-500">{d.descricao}</p>}
                <div className="flex flex-wrap gap-1.5 mt-1">
                  {d.status === 'ABERTO' && d.bloqueia && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-orange-200 text-orange-800">bloqueia</span>
                  )}
                  {d.prazo && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${d.atrasado ? 'bg-red-100 text-red-700' : 'bg-white text-gray-500'}`}>
                      {d.atrasado ? 'atrasado · ' : ''}{fmtData(d.prazo)}
                    </span>
                  )}
                  {d.status !== 'ABERTO' && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700">
                      {d.status === 'RESOLVIDO' ? 'resolvido' : 'cancelado'}
                    </span>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/** Perda com motivo CODIFICADO. O texto livre continua como detalhe, mas o código
 *  é o que permite responder depois "por que a gente perde?" — antes cada um
 *  escrevia de um jeito e não dava para agrupar nada. */
function ModalPerder({ id, onClose, onSaved }: { id: string; onClose: () => void; onSaved: () => void }) {
  const [codigo, setCodigo] = useState('')
  const [motivo, setMotivo] = useState('')
  const [concorrente, setConcorrente] = useState('')
  const [precoVencedor, setPrecoVencedor] = useState('')

  const { data: motivos = [] } = useQuery<any[]>({
    queryKey: ['crm-motivos-perda'],
    queryFn: () => api.get('/crm/motivos-perda').then(r => r.data),
    staleTime: Infinity,
  })

  const m = useMutation({
    mutationFn: () => api.post(`/crm/oportunidades/${id}/perder`, {
      codigo,
      motivo: motivo.trim() || null,
      concorrente: concorrente.trim() || null,
      preco_vencedor: precoVencedor ? Number(precoVencedor) : null,
    }),
    onSuccess: () => { toast.success('Oportunidade marcada como perdida'); onSaved(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro'), { duration: 5000 }),
  })

  // Concorrente/preço só fazem sentido quando perdemos para alguém.
  const pedeConcorrente = codigo === 'PRECO' || codigo === 'CONCORRENTE'

  return (
    <ModalBase titulo="Marcar como perdida" onClose={onClose} max="max-w-md">
      <div className="p-5 space-y-3">
        <p className="text-sm text-gray-500">
          O motivo alimenta a aba Inteligência — é o que mostra onde estamos perdendo e para quem.
        </p>
        <Campo label="Motivo da perda *">
          <select value={codigo} onChange={e => setCodigo(e.target.value)} className={inputCls} autoFocus>
            <option value="">Selecione…</option>
            {motivos.map(m => <option key={m.key} value={m.key}>{m.label}</option>)}
          </select>
        </Campo>
        {pedeConcorrente && (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Campo label="Concorrente">
              <input value={concorrente} onChange={e => setConcorrente(e.target.value)}
                className={inputCls} placeholder="Quem levou" />
            </Campo>
            <Campo label="Preço do vencedor">
              <input type="number" value={precoVencedor} onChange={e => setPrecoVencedor(e.target.value)}
                className={inputCls} placeholder="Se souber" />
            </Campo>
          </div>
        )}
        <Campo label="Detalhe (opcional)">
          <textarea rows={2} value={motivo} onChange={e => setMotivo(e.target.value)} className={inputCls} />
        </Campo>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => m.mutate()} disabled={!codigo || m.isPending}
          className="px-4 py-2 text-sm bg-red-600 hover:bg-red-500 disabled:opacity-50 text-white font-medium rounded-lg">Confirmar perda</button>
      </div>
    </ModalBase>
  )
}

function ModalGerarOV({ opp, onClose, onSaved }: { opp: any; onClose: () => void; onSaved: () => void }) {
  const navigate = useNavigate()
  const hoje = hojeLocal()
  const [numero, setNumero] = useState('')
  const [tipoFrete, setTipoFrete] = useState('FOB')
  const [dataEntrega, setDataEntrega] = useState('')
  const [local, setLocal] = useState('')
  const temItens = (opp.itens || []).some((i: any) => i.produto_id && i.qtd > 0)

  const m = useMutation({
    mutationFn: () => api.post(`/crm/oportunidades/${opp.id}/gerar-ov`, {
      numero_pedido: numero.trim(), tipo_frete: tipoFrete, data_prevista_entrega: dataEntrega || null, local_entrega: local || null,
    }),
    onSuccess: (res) => {
      toast.success('OV gerada no fluxo logístico!'); onSaved(); onClose()
      const ov = res.data?.gerado_ov_id
      if (ov) setTimeout(() => navigate(`/expedicao/${ov}`), 300)
    },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao gerar OV'), { duration: 6000 }),
  })

  return (
    <ModalBase titulo="Gerar OV a partir da oportunidade" onClose={onClose} max="max-w-md">
      <div className="p-5 space-y-3">
        {!temItens && <div className="text-xs bg-amber-50 text-amber-700 rounded-lg p-2">⚠️ A oportunidade não tem itens com produto/quantidade. Edite e adicione antes de gerar a OV.</div>}
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Número da OV *"><input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: OV015500" /></Campo>
          <Campo label="Data esperada pelo cliente *"><input type="date" value={dataEntrega} min={hoje} onChange={e => setDataEntrega(e.target.value)} className={inputCls} /></Campo>
          <Campo label="Tipo de frete">
            <select value={tipoFrete} onChange={e => setTipoFrete(e.target.value)} className={inputCls}>
              <option value="FOB">FOB</option><option value="CIF_COM_VALOR">CIF com Valor NF</option><option value="CIF_SEM_VALOR">CIF sem Valor NF</option>
            </select>
          </Campo>
          <Campo label="Local de entrega"><LocalEntregaInput value={local} onChange={setLocal} /></Campo>
        </div>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => m.mutate()} disabled={!numero.trim() || !dataEntrega || !temItens || m.isPending}
          className="px-4 py-2 text-sm bg-emerald-600 hover:bg-emerald-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {m.isPending ? 'Gerando…' : 'Gerar OV'}
        </button>
      </div>
    </ModalBase>
  )
}

export function ModalNovaAtividade({ oportunidadeId, clienteId, onClose, onSaved }: {
  oportunidadeId?: string; clienteId?: string; onClose: () => void; onSaved: () => void
}) {
  const [tipo, setTipo] = useState('LIGACAO')
  const [titulo, setTitulo] = useState('')
  const [dataHora, setDataHora] = useState('')
  const [descricao, setDescricao] = useState('')

  const m = useMutation({
    mutationFn: () => api.post('/crm/atividades', {
      oportunidade_id: oportunidadeId || null,
      cliente_id: clienteId || null,
      tipo, titulo: titulo.trim(),
      data_hora: dataHora ? new Date(dataHora).toISOString() : null,
      descricao: descricao || null,
    }),
    onSuccess: () => { toast.success('Atividade agendada'); onSaved(); onClose() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao agendar'), { duration: 5000 }),
  })

  return (
    <ModalBase titulo="Nova atividade" onClose={onClose} max="max-w-md">
      <div className="p-5 space-y-3">
        <div className="grid grid-cols-5 gap-1.5">
          {TIPOS_ATIVIDADE.map(t => (
            <button key={t.key} onClick={() => setTipo(t.key)}
              className={`flex flex-col items-center gap-0.5 py-2 rounded-lg border text-[11px] ${tipo === t.key ? 'bg-blue-50 border-blue-400 text-blue-700' : 'border-gray-200 text-gray-500'}`}>
              <span className="text-base">{t.icone}</span> {t.label}
            </button>
          ))}
        </div>
        <Campo label="Título *"><input value={titulo} onChange={e => setTitulo(e.target.value)} className={inputCls} placeholder="Ex: Ligar para confirmar proposta" autoFocus /></Campo>
        <Campo label="Data e hora"><input type="datetime-local" value={dataHora} onChange={e => setDataHora(e.target.value)} className={inputCls} /></Campo>
        <Campo label="Descrição"><textarea rows={2} value={descricao} onChange={e => setDescricao(e.target.value)} className={inputCls} /></Campo>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => m.mutate()} disabled={!titulo.trim() || m.isPending}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">Agendar</button>
      </div>
    </ModalBase>
  )
}

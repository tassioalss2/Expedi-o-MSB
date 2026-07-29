import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Plus, FileText, Printer, Trash2, Send, CheckCircle2, XCircle, Package, Copy } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import { ClienteAutocomplete } from '../NovoPedido'
import { ItensPedido, type ItemLinha } from '../../components/ItensPedido'
import { LocalEntregaInput } from '../../components/LocalEntregaInput'
import { CANAL_LABEL } from '../../lib/statusConfig'
import { fmtBRL, fmtData, msgErro } from '../../lib/crm'
import { ModalBase, Campo, inputCls } from './CrmShared'

const CANAIS = ['URO', 'VASCULAR', 'REALCLOSURE', 'LICITACAO_URO', 'LICITACAO_VASCULAR']
const STATUS: Record<string, { label: string; cor: string }> = {
  RASCUNHO: { label: 'Rascunho', cor: 'bg-gray-100 text-gray-600' },
  ENVIADA: { label: 'Enviada', cor: 'bg-blue-100 text-blue-700' },
  ACEITA: { label: 'Aceita', cor: 'bg-emerald-100 text-emerald-700' },
  RECUSADA: { label: 'Recusada', cor: 'bg-red-100 text-red-700' },
}

export function CrmCotacoes() {
  const qc = useQueryClient()
  const [modal, setModal] = useState<any | 'novo' | null>(null)

  const { data: cotacoes = [], isLoading } = useQuery<any[]>({
    queryKey: ['crm-cotacoes'],
    queryFn: () => api.get('/crm/cotacoes').then(r => r.data),
  })
  const invalidar = () => {
    qc.invalidateQueries({ queryKey: ['crm-cotacoes'] })
    qc.invalidateQueries({ queryKey: ['crm-opps'] })
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-sm text-gray-400">{cotacoes.length} cotação(ões) · gere propostas comerciais e acompanhe a resposta</p>
        <button onClick={() => setModal('novo')} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg">
          <Plus size={16} /> Nova cotação
        </button>
      </div>

      {isLoading ? (
        <p className="text-center text-gray-400 py-10 text-sm">Carregando…</p>
      ) : cotacoes.length === 0 ? (
        <div className="bg-white rounded-xl border border-gray-100 p-10 text-center text-gray-400 text-sm">
          Nenhuma cotação ainda. Clique em <strong>Nova cotação</strong> ou gere a partir de uma oportunidade.
        </div>
      ) : (
        <div className="bg-white rounded-xl border border-gray-100 divide-y divide-gray-50">
          {cotacoes.map(c => {
            const st = STATUS[c.status] || STATUS.RASCUNHO
            const vencida = c.validade && new Date(c.validade + 'T12:00:00') < new Date() && c.status !== 'ACEITA'
            return (
              <div key={c.id} className="flex items-center gap-3 px-4 py-3 hover:bg-gray-50 cursor-pointer" onClick={() => setModal(c)}>
                <FileText size={18} className="text-gray-300 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium text-gray-800 font-mono">{c.numero}</p>
                  <p className="text-xs text-gray-500 truncate">{c.cliente || 'Sem cliente'}</p>
                </div>
                <div className="text-right hidden sm:block">
                  <p className="text-sm font-semibold text-gray-700">{fmtBRL(c.valor_total)}</p>
                  {c.validade && <p className={`text-[11px] ${vencida ? 'text-red-500' : 'text-gray-400'}`}>val. {fmtData(c.validade)}</p>}
                </div>
                <span className={`text-[11px] px-2 py-0.5 rounded-full ${st.cor}`}>{st.label}</span>
                <button onClick={(e) => { e.stopPropagation(); window.open(`/crm/cotacao/${c.id}/imprimir`, '_blank') }}
                  className="p-1.5 text-gray-400 hover:text-blue-600" title="Imprimir proposta"><Printer size={16} /></button>
              </div>
            )
          })}
        </div>
      )}

      {modal && <ModalCotacao cotacao={modal === 'novo' ? undefined : modal}
        onClose={() => setModal(null)} onSaved={invalidar}
        onRevisada={(novaId) => setModal({ id: novaId })} />}
    </div>
  )
}

/** Busca a cotação completa antes de montar o form.
 *
 *  Existe porque a listagem devolve uma versão resumida (sem itens e sem o
 *  contato) — abrir o form com aquele objeto mostrava campos vazios como se o
 *  dado nunca tivesse sido salvo. Aqui basta um `{ id }` para o form nascer
 *  preenchido, de onde quer que ele seja aberto. */
export function ModalCotacao({ cotacao, prefill, onClose, onSaved, onRevisada }: {
  cotacao?: any; prefill?: any; onClose: () => void; onSaved: () => void
  onRevisada?: (novaId: string) => void
}) {
  const id = cotacao?.id
  const { data: completa, isLoading } = useQuery<any>({
    queryKey: ['crm-cotacao', id],
    queryFn: () => api.get(`/crm/cotacoes/${id}`).then(r => r.data),
    enabled: !!id,
  })

  if (id && (isLoading || !completa)) {
    return (
      <ModalBase titulo="Cotação" onClose={onClose} max="max-w-3xl">
        <p className="p-8 text-center text-gray-400 text-sm">Carregando cotação…</p>
      </ModalBase>
    )
  }
  // `key` obrigatória: ao revisar, o id muda com o modal já montado. Sem
  // remontar, o form manteria no state os valores da cotação anterior.
  return <FormCotacao key={id || 'nova'} cotacao={id ? completa : undefined} prefill={prefill}
    onClose={onClose} onSaved={onSaved} onRevisada={onRevisada} />
}

function FormCotacao({ cotacao, prefill, onClose, onSaved, onRevisada }: {
  cotacao?: any; prefill?: any; onClose: () => void; onSaved: () => void
  onRevisada?: (novaId: string) => void
}) {
  const edicao = !!cotacao?.id
  const base = cotacao || prefill || {}
  const [clienteId, setClienteId] = useState(base.cliente_id || '')
  const [clienteNome, setClienteNome] = useState(base.cliente || '')
  const [canal, setCanal] = useState(base.canal || '')
  // Validade já vem sugerida pelo servidor (recomendação, não regra) — o
  // comercial sobrescreve à vontade.
  const validadeSugerida: string = base.validade_sugerida || ''
  const [validade, setValidade] = useState(base.validade || validadeSugerida)
  const [condPagamento, setCondPagamento] = useState(base.condicao_pagamento || '')
  const [prazoEntrega, setPrazoEntrega] = useState(base.prazo_entrega || '')
  const [frete, setFrete] = useState(base.frete ? String(base.frete) : '')
  const [descPct, setDescPct] = useState(base.desconto_pct ? String(base.desconto_pct) : '')
  const [observacao, setObservacao] = useState(base.observacao || '')
  const [clienteCnpj, setClienteCnpj] = useState(base.cliente_cnpj || '')
  const [contatoNome, setContatoNome] = useState(base.contato?.nome || base.contato_nome || '')
  const [contatoEmail, setContatoEmail] = useState(base.contato?.email || base.contato_email || '')
  const [endereco, setEndereco] = useState(base.endereco || '')
  const [enderecoBairro, setEnderecoBairro] = useState(base.endereco_bairro || '')
  const [enderecoCidade, setEnderecoCidade] = useState(base.endereco_cidade || '')
  const [enderecoUf, setEnderecoUf] = useState(base.endereco_uf || '')
  const [enderecoCep, setEnderecoCep] = useState(base.endereco_cep || '')
  const [status, setStatus] = useState(base.status || 'RASCUNHO')
  const [itens, setItens] = useState<ItemLinha[]>(
    (base.itens || []).filter((i: any) => i.produto_id).map((i: any) => ({
      produto_id: i.produto_id, codigo: i.codigo || '', descricao: i.descricao || '',
      qtd: Number(i.qtd) || 0, valor: Number(i.valor_unitario) || 0,
    }))
  )

  const bruto = itens.reduce((a, i) => a + i.qtd * (i.valor || 0), 0)
  const total = bruto * (1 - (Number(descPct) || 0) / 100) + (Number(frete) || 0)

  const salvar = useMutation({
    mutationFn: () => {
      const body: any = {
        cliente_id: clienteId || null, canal: canal || null,
        validade: validade || null, condicao_pagamento: condPagamento || null, prazo_entrega: prazoEntrega || null,
        frete: Number(frete) || 0, desconto_pct: Number(descPct) || 0, observacao: observacao || null,
        cliente_cnpj: clienteCnpj || null,
        contato_nome: contatoNome || null, contato_email: contatoEmail || null,
        endereco: endereco || null, endereco_bairro: enderecoBairro || null,
        endereco_cidade: enderecoCidade || null, endereco_uf: enderecoUf || null, endereco_cep: enderecoCep || null,
        oportunidade_id: base.oportunidade_id || null,
        itens: itens.map(i => ({ produto_id: i.produto_id, codigo: i.codigo, descricao: i.descricao, qtd: i.qtd, valor_unitario: i.valor || 0 })),
        ...(edicao ? { status } : {}),
      }
      return edicao ? api.patch(`/crm/cotacoes/${cotacao.id}`, body) : api.post('/crm/cotacoes', body)
    },
    onSuccess: (res) => {
      toast.success(edicao ? 'Cotação atualizada' : 'Cotação criada'); onSaved()
      if (!edicao && res.data?.id) window.open(`/crm/cotacao/${res.data.id}/imprimir`, '_blank')
      onClose()
    },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao salvar'), { duration: 5000 }),
  })
  const mudarStatus = useMutation({
    mutationFn: (novo: string) => api.patch(`/crm/cotacoes/${cotacao.id}`, { status: novo }),
    onSuccess: (res) => { setStatus(res.data.status); toast.success('Status atualizado'); onSaved() },
    onError: (e: any) => toast.error(msgErro(e, 'Erro'), { duration: 4000 }),
  })
  const excluir = useMutation({
    mutationFn: () => api.delete(`/crm/cotacoes/${cotacao.id}`),
    onSuccess: () => { toast.success('Cotação removida'); onSaved(); onClose() },
  })
  // Revisão de preço é proposta NOVA, não edição da que o cliente já recebeu.
  // Abre direto no editor da nova: criar uma cópia idêntica e mandar o vendedor
  // procurá-la não revisa nada — o objetivo do botão é mexer nos valores.
  const duplicar = useMutation({
    mutationFn: () => api.post(`/crm/cotacoes/${cotacao.id}/duplicar`),
    onSuccess: (res) => {
      toast.success(`${res.data?.numero} criada a partir de ${cotacao.numero} — ajuste itens e valores`)
      onSaved()
      if (onRevisada) onRevisada(res.data.id)
      else { onClose(); window.open(`/crm/cotacao/${res.data.id}/imprimir`, '_blank') }
    },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao revisar proposta'), { duration: 5000 }),
  })
  const [gerarOv, setGerarOv] = useState(false)

  return (
    <ModalBase titulo={edicao ? `Cotação ${cotacao.numero}` : 'Nova cotação'} onClose={onClose} max="max-w-3xl">
      <div className="p-5 space-y-3 overflow-y-auto">
        {edicao && (
          <div className="flex flex-wrap items-center gap-2 pb-2 border-b">
            <span className={`text-xs px-2 py-1 rounded-full ${STATUS[status]?.cor}`}>{STATUS[status]?.label}</span>
            <div className="flex gap-1.5 flex-wrap">
              {status === 'RASCUNHO' && <button onClick={() => mudarStatus.mutate('ENVIADA')} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-blue-600 text-white"><Send size={12} /> Marcar enviada</button>}
              {status !== 'ACEITA' && <button onClick={() => mudarStatus.mutate('ACEITA')} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-emerald-600 text-white"><CheckCircle2 size={12} /> Aceita</button>}
              {status !== 'RECUSADA' && <button onClick={() => mudarStatus.mutate('RECUSADA')} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border border-red-200 text-red-600"><XCircle size={12} /> Recusada</button>}
              {status === 'ACEITA' && <button onClick={() => setGerarOv(true)} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-blue-600 text-white"><Package size={12} /> Gerar OV</button>}
              <button onClick={() => duplicar.mutate()} disabled={duplicar.isPending}
                title="Cria uma nova proposta com os mesmos dados, para revisar itens e valores"
                className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border text-gray-600"><Copy size={12} /> {duplicar.isPending ? 'Criando…' : 'Revisar valores'}</button>
              <button onClick={() => window.open(`/crm/cotacao/${cotacao.id}/imprimir`, '_blank')} className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border text-gray-600"><Printer size={12} /> Imprimir</button>
            </div>
          </div>
        )}

        {/* Tudo abaixo sai no orçamento. Nada é obrigatório — a proposta imprime
            incompleta e a tela de impressão avisa o que ficou em branco. */}
        <p className="text-xs text-gray-400">
          Estes dados vão impressos na proposta. Nenhum é obrigatório — o que faltar aparece
          como aviso na tela de impressão.
        </p>
        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3">
          <div className="col-span-2">
            <Campo label="Cliente / Órgão (razão social)">
              <ClienteAutocomplete value={clienteId} initialNome={clienteNome}
                onChange={(id, nome) => { setClienteId(id); setClienteNome(nome) }} />
              {clienteId && <p className="text-xs text-green-600 mt-1">✅ {clienteNome}</p>}
            </Campo>
          </div>
          <Campo label="CNPJ"><input value={clienteCnpj} onChange={e => setClienteCnpj(e.target.value)} className={inputCls} placeholder="00.000.000/0000-00" /></Campo>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Nome do contato (a quem se destina)"><input value={contatoNome} onChange={e => setContatoNome(e.target.value)} className={inputCls} placeholder="Ex: Dr. João Silva" /></Campo>
          <Campo label="E-mail do contato"><input type="email" value={contatoEmail} onChange={e => setContatoEmail(e.target.value)} className={inputCls} placeholder="contato@cliente.com.br" /></Campo>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
          <div className="col-span-2 lg:col-span-3">
            <Campo label="Endereço (rua, número, complemento)"><input value={endereco} onChange={e => setEndereco(e.target.value)} className={inputCls} placeholder="Ex: Av. Professor Magalhães Neto, 1541" /></Campo>
          </div>
          <Campo label="Bairro"><input value={enderecoBairro} onChange={e => setEnderecoBairro(e.target.value)} className={inputCls} /></Campo>
          <div className="grid grid-cols-3 gap-2 col-span-2 lg:col-span-1">
            <div className="col-span-1"><Campo label="UF"><input value={enderecoUf} maxLength={2} onChange={e => setEnderecoUf(e.target.value.toUpperCase())} className={inputCls} /></Campo></div>
            <div className="col-span-2"><Campo label="Cidade"><input value={enderecoCidade} onChange={e => setEnderecoCidade(e.target.value)} className={inputCls} /></Campo></div>
          </div>
        </div>
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          <Campo label="CEP"><input value={enderecoCep} onChange={e => setEnderecoCep(e.target.value)} className={inputCls} placeholder="00000-000" /></Campo>
          <Campo label="Canal">
            <select value={canal} onChange={e => setCanal(e.target.value)} className={inputCls}>
              <option value="">—</option>{CANAIS.map(c => <option key={c} value={c}>{CANAL_LABEL[c] || c}</option>)}
            </select>
          </Campo>
          <Campo label="Validade">
            <input type="date" value={validade} onChange={e => setValidade(e.target.value)} className={inputCls} />
            {validadeSugerida && validade !== validadeSugerida && (
              <button type="button" onClick={() => setValidade(validadeSugerida)}
                className="text-[11px] text-blue-600 hover:underline mt-1">
                usar recomendada ({fmtData(validadeSugerida)})
              </button>
            )}
            {validade && validade === validadeSugerida && (
              <p className="text-[11px] text-gray-400 mt-1">recomendada · 15 dias</p>
            )}
          </Campo>
          <Campo label="Cond. pagamento"><input value={condPagamento} onChange={e => setCondPagamento(e.target.value)} className={inputCls} placeholder="Ex: 30 dias" /></Campo>
          <Campo label="Prazo de entrega"><input value={prazoEntrega} onChange={e => setPrazoEntrega(e.target.value)} className={inputCls} placeholder="Ex: 5 dias úteis" /></Campo>
        </div>

        <div>
          <label className="text-sm text-gray-600">Itens da proposta *</label>
          <p className="text-xs text-gray-400 mb-1.5">Produto, quantidade e valor unitário.</p>
          <ItensPedido value={itens} onChange={setItens} comValor />
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-3 gap-3 items-end">
          <Campo label="Desconto geral (%)"><input type="number" step="0.1" value={descPct} onChange={e => setDescPct(e.target.value)} className={inputCls} placeholder="0" /></Campo>
          <Campo label="Frete (R$)"><input type="number" step="0.01" value={frete} onChange={e => setFrete(e.target.value)} className={inputCls} placeholder="0,00" /></Campo>
          <div className="bg-gray-50 rounded-lg p-3 text-right">
            <p className="text-[11px] text-gray-400">Total da proposta</p>
            <p className="text-lg font-bold text-gray-800">{fmtBRL(total)}</p>
          </div>
        </div>
        <Campo label="Observações"><textarea rows={2} value={observacao} onChange={e => setObservacao(e.target.value)} className={inputCls} placeholder="Condições comerciais, garantia, etc." /></Campo>
      </div>
      <div className="p-4 border-t flex items-center justify-between">
        {edicao ? <button onClick={() => { if (confirm('Remover cotação?')) excluir.mutate() }} className="flex items-center gap-1.5 text-sm text-gray-400 hover:text-red-600"><Trash2 size={15} /> Remover</button> : <span />}
        <div className="flex gap-2">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Fechar</button>
          <button onClick={() => salvar.mutate()} disabled={itens.length === 0 || salvar.isPending}
            className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
            {salvar.isPending ? 'Salvando…' : edicao ? 'Salvar' : 'Criar e imprimir'}
          </button>
        </div>
      </div>
      {gerarOv && <ModalGerarOVCotacao cotacao={cotacao} onClose={() => setGerarOv(false)} onSaved={onSaved} />}
    </ModalBase>
  )
}

// ── Gerar OV a partir da cotação aceita (herda cliente, itens e preços) ──────────
function ModalGerarOVCotacao({ cotacao, onClose, onSaved }: { cotacao: any; onClose: () => void; onSaved: () => void }) {
  const navigate = useNavigate()
  const hoje = new Date().toISOString().slice(0, 10)
  const [numero, setNumero] = useState('')
  const [tipoFrete, setTipoFrete] = useState('FOB')
  const [dataEntrega, setDataEntrega] = useState('')
  const [local, setLocal] = useState('')

  const gerar = useMutation({
    mutationFn: () => api.post(`/crm/cotacoes/${cotacao.id}/gerar-ov`, {
      numero_pedido: numero.trim(),
      tipo_frete: tipoFrete,
      data_prevista_entrega: dataEntrega,
      local_entrega: local || null,
    }),
    onSuccess: (res) => {
      toast.success('OV gerada — itens e preços herdados da cotação')
      onSaved(); onClose()
      const ov = res.data?.ov_gerada_id
      if (ov) setTimeout(() => navigate(`/expedicao/${ov}`), 300)
    },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao gerar OV'), { duration: 6000 }),
  })

  const valido = numero.trim() && dataEntrega

  return (
    <ModalBase titulo={`Gerar OV · ${cotacao.numero}`} onClose={onClose} max="max-w-md">
      <div className="p-5 space-y-3">
        <div className="bg-blue-50 rounded-lg p-2.5 text-xs text-blue-700">
          Cliente, canal, itens e <strong>preços</strong> (com desconto) vêm da cotação. O valor da NF será sugerido no faturamento automaticamente.
        </div>
        <Campo label="Número da OV *"><input value={numero} onChange={e => setNumero(e.target.value.toUpperCase())} className={`${inputCls} font-mono`} placeholder="Ex: OV015500" autoFocus /></Campo>
        <div className="grid grid-cols-2 gap-3">
          <Campo label="Data prevista de entrega *"><input type="date" value={dataEntrega} min={hoje} onChange={e => setDataEntrega(e.target.value)} className={inputCls} /></Campo>
          <Campo label="Tipo de frete">
            <select value={tipoFrete} onChange={e => setTipoFrete(e.target.value)} className={inputCls}>
              <option value="FOB">FOB</option><option value="CIF_COM_VALOR">CIF com Valor NF</option><option value="CIF_SEM_VALOR">CIF sem Valor NF</option>
            </select>
          </Campo>
        </div>
        <Campo label="Local de entrega"><LocalEntregaInput value={local} onChange={setLocal} /></Campo>
      </div>
      <div className="p-4 border-t flex justify-end gap-2">
        <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg text-gray-600">Cancelar</button>
        <button onClick={() => gerar.mutate()} disabled={!valido || gerar.isPending}
          className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 disabled:opacity-50 text-white font-medium rounded-lg">
          {gerar.isPending ? 'Gerando…' : 'Gerar OV'}
        </button>
      </div>
    </ModalBase>
  )
}

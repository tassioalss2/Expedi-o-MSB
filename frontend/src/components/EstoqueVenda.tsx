// Estoque da venda: o que temos, o que falta e a decisão do comercial.
//
// Mora num arquivo só porque a MESMA informação aparece em três telas — detalhe
// da oportunidade, modal de ganho e venda outbound. Se cada tela montasse a sua,
// elas divergiriam na primeira mudança de regra.
import { useState } from 'react'
import { useMutation } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { AlertTriangle, Check, Clock, PackageCheck, PackageX } from 'lucide-react'
import api from '../lib/api'
import {
  fmtBRL, fmtData, msgErro, ACAO_LIBERAR_LABEL, STATUS_ITEM_COR,
  type Disponibilidade, type ItemDisponibilidade, type Pendencia,
} from '../lib/crm'
import { ModalBase, inputCls } from '../pages/crm/CrmShared'

const n = (v: number) => (Number(v) || 0).toLocaleString('pt-BR', { maximumFractionDigits: 0 })

/** Tabela item a item: pedido · temos · falta. É o núcleo da tela — o comercial
 *  decide olhando esta linha, não um resumo. */
export function TabelaDisponibilidade({ analise, compacta }: {
  analise: Disponibilidade; compacta?: boolean
}) {
  if (!analise?.itens?.length) return null
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase text-gray-400 text-left">
            <th className="py-1.5 pr-2 font-medium">Item</th>
            <th className="py-1.5 px-2 font-medium text-right">Pedido</th>
            <th className="py-1.5 px-2 font-medium text-right">Temos</th>
            <th className="py-1.5 px-2 font-medium text-right">Falta</th>
            {!compacta && <th className="py-1.5 pl-2 font-medium">Situação</th>}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {analise.itens.map((i, idx) => (
            <tr key={i.ref ?? idx}>
              <td className="py-1.5 pr-2">
                <span className="font-medium text-gray-800">{i.codigo || '—'}</span>
                {i.descricao && (
                  <span className="block text-[11px] text-gray-400 truncate max-w-[220px]">{i.descricao}</span>
                )}
              </td>
              <td className="py-1.5 px-2 text-right tabular-nums text-gray-700">{n(i.qtd_pedida)}</td>
              <td className="py-1.5 px-2 text-right tabular-nums font-medium text-emerald-700">
                {n(i.qtd_atendida)}
              </td>
              <td className="py-1.5 px-2 text-right tabular-nums font-medium">
                {i.qtd_pendente > 0
                  ? <span className="text-red-600">{n(i.qtd_pendente)}</span>
                  : <span className="text-gray-300">—</span>}
              </td>
              {!compacta && (
                <td className="py-1.5 pl-2">
                  <SituacaoItem item={i} previsaoSa={analise.previsao_sa} />
                </td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function SituacaoItem({ item: i, previsaoSa }: { item: ItemDisponibilidade; previsaoSa: string | null }) {
  const cls = `text-[11px] px-1.5 py-0.5 rounded border ${STATUS_ITEM_COR[i.status] || ''}`
  if (i.status === 'OK') return <span className={cls}>completo</span>
  if (i.status === 'SEM_DADO') {
    return <span className={cls} title="O PCP não acompanha este código — o app não afirma que falta.">
      sem info de estoque
    </span>
  }
  if (i.status === 'SA') {
    // A distinção que muda a conversa com o cliente: "falta" com data é prazo,
    // "falta" sem data é problema.
    return <span className={cls} title={`Há ${n(i.estoque_sa || 0)} em semiacabado`}>
      semiacabado · ~{fmtData(previsaoSa)}
    </span>
  }
  return <span className={cls}>sem previsão</span>
}

/** Bloco informativo, para o formulário/detalhe. Aparece sempre, verde ou vermelho —
 *  o comercial não deveria ter que clicar em nada para saber se tem material. */
export function BlocoDisponibilidade({ analise, carregando }: {
  analise?: Disponibilidade | null; carregando?: boolean
}) {
  if (carregando) {
    return <p className="text-xs text-gray-400 py-2">Consultando estoque…</p>
  }
  if (!analise || !analise.itens?.length) return null

  const ok = analise.tudo_disponivel
  return (
    <div className={`rounded-xl border p-3 ${ok ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
      <div className="flex items-start justify-between gap-3 mb-2">
        <p className={`text-sm font-semibold flex items-center gap-1.5 ${ok ? 'text-emerald-800' : 'text-red-800'}`}>
          {ok ? <PackageCheck size={15} /> : <PackageX size={15} />}
          {ok ? 'Estoque suficiente para toda a venda'
            : `Faltam ${n(analise.qtd_pendente_total)} un · ${fmtBRL(analise.valor_pendente)}`}
        </p>
        {analise.data_ref && (
          <span className="text-[11px] text-gray-500 whitespace-nowrap"
            title="O PCP atualiza o estoque uma vez ao dia; o app desconta as OVs abertas em tempo real.">
            estoque de {fmtData(analise.data_ref)}
            {analise.desatualizado && ' ⚠'}
          </span>
        )}
      </div>
      <TabelaDisponibilidade analise={analise} />
      {!ok && analise.cobre_com_sa && (
        <p className="text-[11px] text-amber-800 mt-2 flex items-center gap-1">
          <Clock size={11} /> O semiacabado cobre o que falta — previsão de virar acabado em {fmtData(analise.previsao_sa)}.
        </p>
      )}
      {analise.desatualizado && (
        <p className="text-[11px] text-amber-700 mt-2">
          ⚠ Esta é a última foto do PCP, não a de hoje.
        </p>
      )}
      {analise.sem_dado?.length > 0 && (
        <p className="text-[11px] text-gray-500 mt-2">
          Sem informação de estoque para: {analise.sem_dado.join(', ')}.
        </p>
      )}
    </div>
  )
}

export interface DecisaoEstoque {
  decisao: 'PARCIAL' | 'AGUARDAR'
  observacao?: string
  previsao_pcp?: string
}

/** A decisão. Aparece quando o app respondeu 409 dizendo que falta material.
 *  Sem botão padrão destacado de propósito: as duas saídas são legítimas e a
 *  escolha é do comercial, não um "ok" para clicar no automático. */
export function ModalDecisaoEstoque({ analise, titulo, pendente, permiteAguardar = true, avisoAguardar, onClose, onDecidir }: {
  analise: Disponibilidade
  titulo?: string
  pendente?: boolean
  permiteAguardar?: boolean
  avisoAguardar?: string
  onClose: () => void
  onDecidir: (d: DecisaoEstoque) => void
}) {
  const [observacao, setObservacao] = useState('')
  const [previsao, setPrevisao] = useState('')

  const nadaDisponivel = analise.itens.every(i => (i.qtd_atendida || 0) <= 0)

  return (
    <ModalBase titulo={titulo || 'Não temos todo o material'} onClose={onClose} max="max-w-2xl">
      <div className="p-5 space-y-4 overflow-y-auto flex-1">
        <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl p-3">
          <AlertTriangle size={16} className="text-amber-600 mt-0.5 shrink-0" />
          <p className="text-sm text-amber-900">
            Faltam <strong>{n(analise.qtd_pendente_total)} unidades</strong> ({fmtBRL(analise.valor_pendente)}).
            Escolha como seguir — a OV só desce para operações de vendas com o que temos de fato.
          </p>
        </div>

        <TabelaDisponibilidade analise={analise} />

        {analise.cobre_com_sa && (
          <p className="text-xs text-amber-800 flex items-center gap-1.5">
            <Clock size={12} /> O que falta existe em semiacabado — previsão de virar acabado
            em <strong>{fmtData(analise.previsao_sa)}</strong> (cerca de 2 dias úteis).
          </p>
        )}

        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="text-sm text-gray-600">Previsão do PCP para o saldo (opcional)</label>
            <input type="date" value={previsao} onChange={e => setPrevisao(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className="text-sm text-gray-600">Observação (opcional)</label>
            <input value={observacao} onChange={e => setObservacao(e.target.value)}
              placeholder="o que foi combinado com o cliente" className={inputCls} />
          </div>
        </div>
      </div>

      <div className="p-5 border-t space-y-2 shrink-0">
        <button disabled={pendente || nadaDisponivel}
          onClick={() => onDecidir({ decisao: 'PARCIAL', observacao, previsao_pcp: previsao || undefined })}
          className="w-full flex items-start gap-3 text-left border-2 border-blue-200 hover:border-blue-400 bg-blue-50 rounded-xl px-4 py-3 disabled:opacity-40 disabled:cursor-not-allowed">
          <Check size={18} className="text-blue-600 mt-0.5 shrink-0" />
          <span>
            <span className="block text-sm font-semibold text-blue-900">Seguir com o que temos</span>
            <span className="block text-xs text-blue-700">
              {nadaDisponivel
                ? 'Indisponível: não há nenhuma unidade em estoque agora.'
                : 'A OV entra só com o disponível. O saldo vira pendência e entra depois como 2ª remessa, na mesma OV.'}
            </span>
          </span>
        </button>

        {permiteAguardar && (
          <button disabled={pendente}
            onClick={() => onDecidir({ decisao: 'AGUARDAR', observacao, previsao_pcp: previsao || undefined })}
            className="w-full flex items-start gap-3 text-left border-2 border-gray-200 hover:border-gray-400 rounded-xl px-4 py-3 disabled:opacity-40">
            <Clock size={18} className="text-gray-500 mt-0.5 shrink-0" />
            <span>
              <span className="block text-sm font-semibold text-gray-800">Aguardar a produção</span>
              <span className="block text-xs text-gray-500">
                {avisoAguardar || 'Nenhuma OV é aberta. A venda fica na coluna de pendência até o material chegar.'}
              </span>
            </span>
          </button>
        )}
      </div>
    </ModalBase>
  )
}

/** Liberação do saldo. Reconfere o estoque no servidor antes de mandar para a
 *  expedição — a pendência pode ter ficado dias parada e outra OV pode ter
 *  consumido a produção nesse meio tempo. Quando o material chegou só em parte,
 *  o servidor devolve 409 com a análise e a tela oferece liberar o que já tem. */
export function ModalLiberarPendencia({ pendencia: p, analise, onClose, onLiberado }: {
  pendencia: Pendencia
  /** Situação de agora, quando quem abriu o modal já a tem em mão. Com ela o modal
   *  mostra o que vai sair e oferece a liberação parcial de UMA vez, em vez de
   *  exigir uma tentativa recusada primeiro. */
  analise?: Disponibilidade | null
  onClose: () => void
  onLiberado: () => void
}) {
  const [observacao, setObservacao] = useState('')
  const [faltaAinda, setFaltaAinda] = useState<Disponibilidade | null>(null)

  const liberar = useMutation({
    mutationFn: (parcial: boolean) =>
      api.post(`/crm/pendencias/${p.fonte}/${p.id}/liberar`, { parcial, observacao })
        .then(r => r.data),
    onSuccess: (r: any) => {
      const acao = ACAO_LIBERAR_LABEL[r?.acao] || 'liberada'
      toast.success(`Pendência liberada — ${acao.toLowerCase()}.`)
      onLiberado()
      onClose()
    },
    onError: (e: any) => {
      const d = e?.response?.data?.detail
      if (d?.tipo === 'ESTOQUE_INSUFICIENTE' && d.analise) {
        setFaltaAinda(d.analise)
        return
      }
      toast.error(msgErro(e, 'Não foi possível liberar a pendência.'))
    },
  })

  const podeParcial = !!faltaAinda?.itens?.some(i => (i.qtd_atendida || 0) > 0)
  // Situação já conhecida: parte em estoque, parte faltando. Vai direto ao parcial.
  const situacao = faltaAinda || analise || null
  const parcialDireto = !faltaAinda && !!analise?.tem_falta
    && analise.itens.some(i => (i.qtd_atendida || 0) > 0)
  const prontos = (situacao?.itens || []).filter(i => (i.qtd_atendida || 0) > 0)

  return (
    <ModalBase titulo="Liberar pendência de estoque" onClose={onClose} max="max-w-2xl">
      <div className="p-5 space-y-4 overflow-y-auto flex-1">
        <div>
          <p className="text-sm font-semibold text-gray-800">{p.titulo}</p>
          <p className="text-xs text-gray-500">{p.cliente || '—'}</p>
        </div>

        {faltaAinda ? (
          <>
            <div className="flex items-start gap-2 bg-amber-50 border border-amber-200 rounded-xl p-3">
              <AlertTriangle size={16} className="text-amber-600 mt-0.5 shrink-0" />
              <p className="text-sm text-amber-900">
                O material ainda não chegou por completo. Ainda faltam{' '}
                <strong>{n(faltaAinda.qtd_pendente_total)} un</strong>.
              </p>
            </div>
            <TabelaDisponibilidade analise={faltaAinda} />
          </>
        ) : parcialDireto && analise ? (
          <>
            <div className="flex items-start gap-2 bg-emerald-50 border border-emerald-200 rounded-xl p-3">
              <Check size={16} className="text-emerald-600 mt-0.5 shrink-0" />
              <p className="text-sm text-emerald-900">
                Dá para liberar <strong>
                  {prontos.map(i => `${n(i.qtd_atendida)} un de ${i.codigo}`).join(', ')}
                </strong> agora. O que falta continua pendente e entra depois como 2ª remessa,
                na mesma OV.
              </p>
            </div>
            <TabelaDisponibilidade analise={analise} />
            <div>
              <label className="text-sm text-gray-600">Observação (opcional)</label>
              <input value={observacao} onChange={e => setObservacao(e.target.value)} className={inputCls} />
            </div>
          </>
        ) : (
          <>
            <div className="rounded-xl border border-gray-200 p-3">
              <p className="text-xs text-gray-400 mb-1.5">Saldo a liberar</p>
              <table className="w-full text-sm">
                <tbody className="divide-y divide-gray-100">
                  {p.itens.map((i, idx) => (
                    <tr key={idx}>
                      <td className="py-1.5">
                        <span className="font-medium text-gray-800">{i.codigo || '—'}</span>
                        {i.descricao && <span className="block text-[11px] text-gray-400">{i.descricao}</span>}
                      </td>
                      <td className="py-1.5 text-right tabular-nums text-gray-700">{n(i.qtd_pendente)} un</td>
                      <td className="py-1.5 text-right tabular-nums text-gray-500">{fmtBRL(i.valor_pendente)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="bg-blue-50 border border-blue-200 rounded-xl p-3">
              <p className="text-sm text-blue-900">
                <strong>{ACAO_LIBERAR_LABEL[p.acao_liberar || ''] || '—'}</strong>
              </p>
              <p className="text-xs text-blue-700 mt-0.5">
                {p.acao_liberar === 'REMESSA_2'
                  ? `A OV ${p.ov_ref} já faturou, então o saldo entra como remessa nova — mesmo número de OV, nota fiscal própria.`
                  : p.acao_liberar === 'SOMAR_R1'
                    ? 'A OV ainda não faturou, então o saldo é somado a ela e sai numa nota só.'
                    : 'A venda estava aguardando produção e não tinha OV — ela é aberta agora.'}
              </p>
            </div>
            <div>
              <label className="text-sm text-gray-600">Observação (opcional)</label>
              <input value={observacao} onChange={e => setObservacao(e.target.value)} className={inputCls} />
            </div>
          </>
        )}
      </div>

      <div className="p-5 border-t flex gap-2 shrink-0">
        <button onClick={onClose} className="flex-1 border rounded-xl py-2.5 text-sm">Fechar</button>
        {faltaAinda ? (
          <button disabled={!podeParcial || liberar.isPending} onClick={() => liberar.mutate(true)}
            className="flex-1 bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-200 disabled:text-gray-400 text-white rounded-xl py-2.5 text-sm font-medium">
            {podeParcial ? 'Liberar o que já tem' : 'Nada disponível ainda'}
          </button>
        ) : parcialDireto ? (
          <button disabled={liberar.isPending} onClick={() => liberar.mutate(true)}
            className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl py-2.5 text-sm font-medium">
            {liberar.isPending ? 'Liberando…' : 'Liberar o que tem em estoque'}
          </button>
        ) : (
          <button disabled={liberar.isPending} onClick={() => liberar.mutate(false)}
            className="flex-1 bg-emerald-600 hover:bg-emerald-500 text-white rounded-xl py-2.5 text-sm font-medium">
            {liberar.isPending ? 'Liberando…' : 'Confirmar liberação'}
          </button>
        )}
      </div>
    </ModalBase>
  )
}

/** Card da coluna "Pendência de estoque" do kanban. */
export function CardPendencia({ p, onAbrir, onLiberar }: {
  p: Pendencia; onAbrir: () => void; onLiberar: () => void
}) {
  return (
    <div className="bg-white rounded-lg border border-red-200 shadow-sm p-2">
      <div onClick={onAbrir} className="cursor-pointer">
        <p className="text-[13px] font-medium text-gray-800 leading-tight line-clamp-2 break-words">{p.titulo}</p>
        {p.cliente && <p className="text-[11px] text-gray-500 mt-0.5 leading-tight line-clamp-2">{p.cliente}</p>}
        <div className="flex items-center justify-between gap-1 flex-wrap mt-1.5">
          <span className="text-[13px] font-semibold text-red-700">{fmtBRL(p.valor)}</span>
          <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-red-100 text-red-700">
            {n(p.qtd_total)} un
          </span>
        </div>
        <div className="mt-1.5 space-y-0.5">
          {p.itens.slice(0, 3).map((i, idx) => (
            <p key={idx} className="text-[11px] text-gray-500 truncate">
              {i.codigo || '—'} · faltam {n(i.qtd_pendente)}
            </p>
          ))}
          {p.itens.length > 3 && (
            <p className="text-[11px] text-gray-400">+{p.itens.length - 3} item(ns)</p>
          )}
        </div>
        <div className="flex items-center flex-wrap gap-x-2 gap-y-1 mt-1.5 text-[10px]">
          {p.decisao === 'AGUARDAR' ? (
            <span className="px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">sem OV — aguardando</span>
          ) : (
            <span className="px-1.5 py-0.5 rounded bg-blue-50 text-blue-700">
              {p.ov_provisoria ? 'OV sem nº do D365' : `OV ${p.ov_ref || '—'}`}
            </span>
          )}
          {p.dias_parada != null && p.dias_parada > 0 && (
            <span className={`px-1.5 py-0.5 rounded ${p.dias_parada >= 15 ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-500'}`}>
              {p.dias_parada}d
            </span>
          )}
          {p.previsao_pcp && (
            <span className="px-1.5 py-0.5 rounded bg-amber-50 text-amber-700">PCP {fmtData(p.previsao_pcp)}</span>
          )}
        </div>
      </div>
      <button onClick={onLiberar} disabled={!p.pode_liberar}
        title={p.motivo_bloqueio || ACAO_LIBERAR_LABEL[p.acao_liberar || ''] || ''}
        className="mt-2 w-full text-xs font-medium bg-emerald-600 hover:bg-emerald-500 disabled:bg-gray-200 disabled:text-gray-400 text-white rounded-lg py-1.5">
        {p.pode_liberar ? 'Material chegou · liberar' : 'Bloqueada'}
      </button>
    </div>
  )
}

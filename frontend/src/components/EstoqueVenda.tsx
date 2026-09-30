// Estoque da venda: o que temos, o que falta e a decisão do comercial.
//
// Mora num arquivo só porque a MESMA informação aparece em três telas — detalhe
// da oportunidade, modal de ganho e venda outbound. Se cada tela montasse a sua,
// elas divergiriam na primeira mudança de regra.
import { useEffect, useMemo, useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import toast from 'react-hot-toast'
import { AlertTriangle, Check, Clock, PackageCheck, PackageX } from 'lucide-react'
import api from '../lib/api'
import {
  fmtBRL, fmtData, msgErro, ACAO_LIBERAR_LABEL, STATUS_ITEM_COR,
  type Disponibilidade, type ItemDisponibilidade, type Pendencia,
} from '../lib/crm'
import { ModalBase, inputCls } from '../pages/crm/CrmShared'
import { TIPO_FRETE_LABEL, STATUS_CONFIG } from '../lib/statusConfig'

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
  /** Quanto levar de cada item agora. Ausente = leva todo o disponível.
   *  O servidor limita ao disponível: a escolha reduz, nunca aumenta. */
  itens?: { produto_id: string; qtd: number }[]
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

  // Começa com o disponível de cada item — quem não mexer leva tudo o que temos,
  // que era o comportamento anterior. Reduzir manda o resto para a pendência.
  const [qtds, setQtds] = useState<Record<string, string>>(() =>
    Object.fromEntries(analise.itens
      .filter(i => i.produto_id && (i.qtd_atendida || 0) > 0)
      .map(i => [i.produto_id as string, String(i.qtd_atendida || 0)])))

  // MANDA OS ZEROS. O servidor trata produto AUSENTE da lista como "não mexeu,
  // leva todo o disponível" — filtrar os zeros aqui (como faz o modal de liberar
  // pendência, onde a regra é outra) fazia o item zerado voltar cheio para a OV:
  // o operador zerava o item, e ele entrava com o estoque todo.
  const escolha = analise.itens
    .filter(i => i.produto_id && (i.qtd_atendida || 0) > 0)
    .map(i => ({ produto_id: i.produto_id as string, qtd: Number(qtds[i.produto_id as string] || 0) }))
  const excedeuAlgum = analise.itens.some(i =>
    i.produto_id && Number(qtds[i.produto_id] ?? 0) > (i.qtd_atendida || 0) + 0.001)
  const totalEscolhido = escolha.reduce((a, i) => a + i.qtd, 0)
  const totalDisponivel = analise.itens.reduce((a, i) => a + (i.qtd_atendida || 0), 0)
  const segurouAlgo = totalEscolhido < totalDisponivel - 0.001
  // Item com estoque que o operador decidiu NÃO bloquear para esta OV.
  const temLivre = analise.itens.some(i =>
    i.produto_id && (i.qtd_atendida || 0) > 0 && !(Number(qtds[i.produto_id] ?? 0) > 0))

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

        <EscolhaDeLiberacao itens={analise.itens} qtds={qtds} mostrarSituacao comBloqueio
          previsaoSa={analise.previsao_sa}
          onQtd={(pid, v) => setQtds(q => ({ ...q, [pid]: v }))} />

        {excedeuAlgum && (
          <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
            Há item acima do disponível. A OV só desce com o que temos de fato — reduza para seguir.
          </p>
        )}
        {temLivre && (
          <p className="text-xs text-gray-600 bg-gray-50 border border-gray-200 rounded-lg px-3 py-2">
            Item <strong>deixado livre</strong>: o que temos dele NÃO fica preso nesta OV — segue
            disponível para outra venda, e a quantidade inteira do item vai para a pendência.
          </p>
        )}
        {segurouAlgo && !excedeuAlgum && (
          <p className="text-xs text-blue-800 bg-blue-50 border border-blue-200 rounded-lg px-3 py-2">
            Você está segurando material que temos em estoque. Ele vai para a pendência junto
            com o que falta — e essa parte fica liberável na hora, sem esperar produção.
          </p>
        )}

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
        <button disabled={pendente || nadaDisponivel || totalEscolhido <= 0 || excedeuAlgum}
          onClick={() => onDecidir({
            decisao: 'PARCIAL', observacao, previsao_pcp: previsao || undefined, itens: escolha,
          })}
          className="w-full flex items-start gap-3 text-left border-2 border-blue-200 hover:border-blue-400 bg-blue-50 rounded-xl px-4 py-3 disabled:opacity-40 disabled:cursor-not-allowed">
          <Check size={18} className="text-blue-600 mt-0.5 shrink-0" />
          <span>
            <span className="block text-sm font-semibold text-blue-900">
              {segurouAlgo ? 'Seguir com o que escolhi' : 'Seguir com o que temos'}
            </span>
            <span className="block text-xs text-blue-700">
              {nadaDisponivel
                ? 'Indisponível: não há nenhuma unidade em estoque agora.'
                : totalEscolhido <= 0
                ? 'Nenhuma quantidade escolhida — use a opção abaixo para jogar tudo na pendência.'
                : `A OV entra com ${n(totalEscolhido)} unidade(s). O saldo vira pendência e entra depois como 2ª remessa, na mesma OV.`}
            </span>
          </span>
        </button>

        {permiteAguardar && (
          <button disabled={pendente}
            onClick={() => onDecidir({ decisao: 'AGUARDAR', observacao, previsao_pcp: previsao || undefined })}
            className="w-full flex items-start gap-3 text-left border-2 border-gray-200 hover:border-gray-400 rounded-xl px-4 py-3 disabled:opacity-40">
            <Clock size={18} className="text-gray-500 mt-0.5 shrink-0" />
            <span>
              <span className="block text-sm font-semibold text-gray-800">Jogar tudo na pendência</span>
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
/** Escolha item a item de quanto liberar agora.
 *
 *  Antes era tudo ou nada: o botão soltava todo o estoque disponível. Quem decide
 *  isso é o comercial — pode querer segurar um item para mandar a entrega junta,
 *  ou soltar só o que o cliente precisa agora.
 *
 *  Os itens COM estoque ficam no topo: são os únicos em que há o que decidir, e a
 *  lista costuma ser longa o bastante para eles sumirem no meio dos que faltam. */
function EscolhaDeLiberacao({ itens, qtds, onQtd, previsaoSa, mostrarSituacao, comBloqueio,
                             tetoNaDivida }: {
  itens: ItemDisponibilidade[]
  qtds: Record<string, string>
  onQtd: (produtoId: string, valor: string) => void
  /** Data em que o semiacabado vira acabado — a situação de cada item depende dela. */
  previsaoSa?: string | null
  /** Mostra a coluna SITUAÇÃO (semiacabado com data, sem previsão). Vale na
   *  DECISÃO, onde o operador escolhe quanto levar sabendo o que acontece com o
   *  saldo; na liberação da pendência o material já chegou e a coluna só ocupa
   *  espaço. */
  mostrarSituacao?: boolean
  /** Oferece, por item, a escolha explícita de BLOQUEAR ou não o parcial para
   *  esta OV. Digitar 0 na quantidade sempre teve esse efeito, mas não dizia o
   *  que significava: quem lê "0" não pensa "vou deixar essas 5 livres para
   *  outro cliente". Vale na decisão; na liberação da pendência não faz sentido,
   *  porque ali o ato É pegar o material. */
  comBloqueio?: boolean
  /** Na LIBERAÇÃO de pendência o estoque só recomenda: o teto é a dívida e todo
   *  item é digitável, inclusive o que a foto do PCP mostra zerado. Quem abre o
   *  modal está com a peça na mão; o app conhece a última foto, não a
   *  prateleira. Na DECISÃO continua valendo o estoque como teto — lá o ato é
   *  justamente repartir o que existe. */
  tetoNaDivida?: boolean
}) {
  const ordenados = [...itens].sort((a, b) => {
    const da = (a.qtd_atendida || 0) > 0 ? 0 : 1
    const db_ = (b.qtd_atendida || 0) > 0 ? 0 : 1
    if (da !== db_) return da - db_
    return (b.qtd_atendida || 0) - (a.qtd_atendida || 0)
  })

  return (
    <div className="rounded-xl border border-gray-200 overflow-hidden">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-[11px] uppercase text-gray-400 text-left bg-gray-50">
            <th className="py-2 px-3 font-medium">Item</th>
            <th className="py-2 px-2 font-medium text-right">Pedido</th>
            <th className="py-2 px-2 font-medium text-right">Temos</th>
            {mostrarSituacao && <th className="py-2 px-2 font-medium">Situação</th>}
            {comBloqueio && <th className="py-2 px-2 font-medium text-center w-32">Bloquear p/ esta OV</th>}
            <th className="py-2 px-3 font-medium text-right w-28">Liberar agora</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-100">
          {ordenados.map((i, idx) => {
            const pid = i.produto_id || ''
            const disp = i.qtd_atendida || 0
            const tem = disp > 0
            const valor = qtds[pid] ?? ''
            const teto = tetoNaDivida ? (i.qtd_pedida || 0) : disp
            const excedeu = Number(valor) > teto
            const passouDaFoto = !!tetoNaDivida && Number(valor) > disp + 0.001
            const digitavel = tem || !!tetoNaDivida
            return (
              <tr key={pid || idx} className={tem ? 'bg-emerald-50/60' : ''}>
                <td className="py-2 px-3">
                  <span className={`font-medium ${tem ? 'text-emerald-900' : 'text-gray-500'}`}>
                    {i.codigo || '—'}
                  </span>
                  {i.descricao && (
                    <span className="block text-[11px] text-gray-400 truncate max-w-[230px]">{i.descricao}</span>
                  )}
                </td>
                <td className="py-2 px-2 text-right tabular-nums text-gray-600">{n(i.qtd_pedida)}</td>
                <td className={`py-2 px-2 text-right tabular-nums font-medium ${tem ? 'text-emerald-700' : 'text-gray-300'}`}>
                  {n(disp)}
                </td>
                {mostrarSituacao && (
                  <td className="py-2 px-2">
                    <SituacaoItem item={i} previsaoSa={previsaoSa ?? null} />
                  </td>
                )}
                {comBloqueio && (
                  <td className="py-2 px-2 text-center">
                    {tem ? (
                      <label className="inline-flex items-center gap-1.5 cursor-pointer"
                        title="Desmarcado, o parcial deste item fica livre para outra venda e o item inteiro vai para a pendência">
                        <input type="checkbox" checked={Number(valor) > 0}
                          onChange={e => onQtd(pid, e.target.checked ? String(disp) : '0')}
                          className="rounded border-gray-300" />
                        <span className={`text-[11px] ${Number(valor) > 0 ? 'text-emerald-700' : 'text-gray-400'}`}>
                          {Number(valor) > 0 ? 'bloquear' : 'deixar livre'}
                        </span>
                      </label>
                    ) : (
                      <span className="text-[11px] text-gray-300">—</span>
                    )}
                  </td>
                )}
                <td className="py-2 px-3 text-right">
                  {digitavel ? (
                    <>
                      <input type="number" min={0} max={teto} step="any" value={valor}
                        onChange={e => onQtd(pid, e.target.value)}
                        className={`w-24 border rounded-lg px-2 py-1 text-sm text-right tabular-nums ${
                          excedeu ? 'border-red-400 bg-red-50'
                            : passouDaFoto ? 'border-amber-400 bg-amber-50'
                            : tem ? 'border-emerald-300' : 'border-gray-200'}`} />
                      {passouDaFoto && (
                        <span className="block text-[11px] text-amber-700 mt-0.5">
                          acima da foto ({n(disp)})
                        </span>
                      )}
                    </>
                  ) : (
                    <span className="text-[11px] text-gray-400">sem estoque</span>
                  )}
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** O frete que uma remessa de pendencia costuma ter.
 *
 *  Regra do Tassio, e os dados concordam: das 13 remessas complementares
 *  nascidas de pendencia, 10 sao CIF sem valor. Faz sentido — o cliente ja
 *  pagou a entrega uma vez, e o segundo frete e nosso porque a falta foi nossa.
 *  E PADRAO, nao regra: os outros 23% existem. */
const SUGERIDO_PENDENCIA = 'CIF_SEM_VALOR'

export function ModalLiberarPendencia({ pendencia: p, analise, onClose, onLiberado }: {
  pendencia: Pendencia
  /** Situação de agora, quando quem abriu o modal já a tem em mão. */
  analise?: Disponibilidade | null
  onClose: () => void
  onLiberado: () => void
}) {
  const [observacao, setObservacao] = useState('')
  const [detalhes, setDetalhes] = useState(false)
  const [somarEm, setSomarEm] = useState<string>('')
  const [freteEscolhido, setFreteEscolhido] = useState<string>(SUGERIDO_PENDENCIA)
  const [transportadora, setTransportadora] = useState<string>('')

  const abertas: any[] = (p as any).remessas_abertas || []

  const { data: transportadoras = [] } = useQuery<any[]>({
    queryKey: ['transportadoras'],
    queryFn: () => api.get('/transportadoras').then(r => r.data),
    staleTime: 5 * 60 * 1000,
  })

  /** UMA lista de itens, e não três.
   *
   *  O modal tinha três caminhos — "voltou 409 do servidor", "a análise já veio
   *  com falta" e "o saldo inteiro" — cada um com sua tabela, seu botão e seu
   *  texto. Eles diferiam só em DE ONDE vinha a lista, e é por isso que a tela
   *  foi ficando incoerente: uma correção entrava num caminho e não nos outros.
   *
   *  Agora a fonte é a análise quando existe e o saldo da pendência quando não,
   *  e daí para baixo é tudo igual. */
  type Linha = {
    produto_id: string; codigo?: string | null; descricao?: string | null
    devido: number; naFoto: number; valor: number; reservado: any[]
  }
  const linhas: Linha[] = useMemo(() => {
    const daAnalise = analise?.itens || []
    if (daAnalise.length) {
      return daAnalise.filter(i => i.produto_id).map(i => ({
        produto_id: i.produto_id as string,
        codigo: i.codigo,
        descricao: i.descricao,
        devido: Number(i.qtd_pedida) || 0,
        naFoto: Number(i.qtd_atendida) || 0,
        valor: Number((i as any).valor_unitario) || 0,
        reservado: (i as any).reservado_para || [],
      }))
    }
    return (p.itens || []).filter(i => i.produto_id).map(i => {
      const linha = (p.estoque_agora?.itens || [])
        .find(x => (x.codigo || '') === (i.codigo || ''))
      const devido = Number(i.qtd_pendente) || 0
      return {
        produto_id: i.produto_id as string,
        codigo: i.codigo,
        descricao: i.descricao,
        devido,
        // Sem leitura do PCP não se afirma nada: a sugestão vira a dívida.
        naFoto: linha ? (Number(linha.qtd_atendida) || 0) : devido,
        valor: Number(i.valor_unitario) || 0,
        reservado: (linha as any)?.reservado_para || [],
      }
    })
  }, [analise, p])

  // Começa com o que a foto do PCP cobre — o caso comum é liberar isso. Nunca
  // com a dívida: pré-preencher 30 de um item com zero em estoque convida a
  // mandar material que não está lá.
  const [qtds, setQtds] = useState<Record<string, string>>(() =>
    Object.fromEntries(linhas.map(l => [l.produto_id, String(Math.min(l.devido, l.naFoto))])))

  const num = (v: any) => Number(String(v ?? '').replace(',', '.')) || 0
  const escolha = linhas
    .map(l => ({ produto_id: l.produto_id, qtd: num(qtds[l.produto_id]) }))
    .filter(i => i.qtd > 0)
  const total = escolha.reduce((a, i) => a + i.qtd, 0)
  // Teto é a DÍVIDA: o estoque só recomenda, mas entregar mais do que foi
  // vendido continua fora.
  const excedeu = linhas.filter(l => num(qtds[l.produto_id]) > l.devido + 0.001)
  const acimaDaFoto = linhas.filter(l => num(qtds[l.produto_id]) > l.naFoto + 0.001)

  const liberar = useMutation({
    mutationFn: () => api.post(`/crm/pendencias/${p.fonte}/${p.id}/liberar`, {
      parcial: true, observacao, itens: escolha,
      somar_em: somarEm || null,
      tipo_frete: freteEscolhido || null,
      transportadora_id: transportadora || null,
    }).then(r => r.data),
    onSuccess: (r: any) => {
      toast.success(`Pendência liberada — ${(ACAO_LIBERAR_LABEL[r?.acao] || 'liberada').toLowerCase()}.`)
      onLiberado()
      onClose()
    },
    onError: (e: any) => toast.error(msgErro(e, 'Não foi possível liberar a pendência.')),
  })

  return (
    <ModalBase titulo="Liberar pendência de estoque" onClose={onClose} max="max-w-2xl">
      <div className="p-5 space-y-4 overflow-y-auto flex-1">
        <div>
          <p className="text-sm font-semibold text-gray-800">{p.titulo}</p>
          <p className="text-xs text-gray-500">
            {p.cliente || '—'}
            {p.nada_entregue
              ? ' · nada foi entregue ainda'
              : p.ov_ref ? ` · saldo da ${p.ov_ref}` : ''}
          </p>
        </div>

        {/* 1. QUANTO VAI SAIR AGORA */}
        <div className="rounded-xl border border-gray-200">
          <p className="border-b border-gray-100 px-3 py-2 text-xs font-semibold text-gray-700">
            1. Quanto vai sair agora
          </p>
          <table className="w-full text-sm">
            <tbody className="divide-y divide-gray-50">
              {linhas.map(l => {
                const q = num(qtds[l.produto_id])
                return (
                  <tr key={l.produto_id}>
                    <td className="py-2 pl-3">
                      <span className="font-medium text-gray-800">{l.codigo || '—'}</span>
                      {l.descricao && (
                        <span className="block truncate text-[11px] text-gray-400 max-w-[280px]">
                          {l.descricao}
                        </span>
                      )}
                    </td>
                    <td className="py-2 pr-3 text-right whitespace-nowrap">
                      <input value={qtds[l.produto_id] ?? ''}
                        onChange={e => setQtds(v => ({ ...v, [l.produto_id]: e.target.value }))}
                        className={`w-20 rounded-lg border px-2 py-1 text-right tabular-nums
                          ${q > l.devido + 0.001 ? 'border-red-300'
                            : q > l.naFoto + 0.001 ? 'border-amber-300' : 'border-gray-200'}`} />
                      <span className="ml-1 text-xs text-gray-400">de {n(l.devido)}</span>
                    </td>
                    <td className="py-2 pr-3 text-right tabular-nums text-xs text-gray-500">
                      {fmtBRL(l.valor * q)}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
          {excedeu.length > 0 && (
            <p className="px-3 pb-2 text-[11px] text-red-600">
              {excedeu.map(l => l.codigo).join(', ')} acima do que esta venda deve.
            </p>
          )}
          <button onClick={() => setDetalhes(d => !d)}
            className="px-3 pb-2 text-[11px] text-blue-600 hover:underline">
            {detalhes ? 'esconder detalhes' : 'ver detalhes do estoque'}
          </button>
          {detalhes && (
            <div className="border-t border-gray-100 px-3 py-2 text-[11px] text-gray-500">
              <p className="mb-1">
                A foto do PCP é a última leitura, não a prateleira — ela recomenda, não trava.
              </p>
              {linhas.map(l => (
                <p key={l.produto_id}>
                  <span className="font-mono">{l.codigo}</span>: foto do PCP {n(l.naFoto)} un
                  {(l.reservado || []).length > 0 && (
                    <> · reservado para {(l.reservado as any[])
                      .map(d => `${d.ov || d.cliente || 'outra venda'} (${n(d.qtd)})`).join(', ')}</>
                  )}
                </p>
              ))}
            </div>
          )}
        </div>

        {/* 2. ONDE ENTRA */}
        <div className="rounded-xl border border-gray-200 p-3">
          <p className="text-xs font-semibold text-gray-700">2. Onde entra</p>
          {abertas.length > 0 ? (
            <>
              <label className="mt-1.5 flex items-start gap-2 text-sm cursor-pointer">
                <input type="radio" name="destino-saldo" checked={!somarEm}
                  onChange={() => setSomarEm('')} className="mt-0.5" />
                <span>Remessa nova
                  <span className="block text-[11px] text-gray-500">
                    mesmo número de OV, nota fiscal própria
                  </span>
                </span>
              </label>
              {abertas.map(r => (
                <label key={r.id} className="mt-1.5 flex items-start gap-2 text-sm cursor-pointer">
                  <input type="radio" name="destino-saldo" checked={somarEm === r.id}
                    onChange={() => { setSomarEm(r.id); setFreteEscolhido(r.tipo_frete || SUGERIDO_PENDENCIA) }}
                    className="mt-0.5" />
                  <span>Somar na remessa R{r.remessa_numero}
                    <span className="block text-[11px] text-gray-500">
                      em {(STATUS_CONFIG as any)[r.status]?.label || r.status} — sai numa nota só
                    </span>
                  </span>
                </label>
              ))}
            </>
          ) : (
            <p className="mt-1 text-[11px] text-gray-500">
              {p.acao_liberar === 'REMESSA_2'
                ? `A ${p.ov_ref} já faturou — sai como 2ª remessa, com nota própria.`
                : p.acao_liberar === 'SOMAR_R1'
                  ? `Somado na ${p.ov_ref}, que ainda não faturou — uma nota só.`
                  : 'A venda não tinha OV — ela é aberta agora.'}
            </p>
          )}
        </div>

        {/* 3. COMO SAI */}
        <div className="rounded-xl border border-gray-200 p-3">
          <p className="text-xs font-semibold text-gray-700">3. Como sai</p>
          <div className="mt-1.5 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <label className="text-[11px] text-gray-500">Frete</label>
              <select value={freteEscolhido} onChange={e => setFreteEscolhido(e.target.value)}
                className="mt-0.5 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm">
                {['CIF_SEM_VALOR', 'CIF_COM_VALOR', 'FOB'].map(t => (
                  <option key={t} value={t}>{TIPO_FRETE_LABEL[t] || t}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="text-[11px] text-gray-500">Transportadora</label>
              <select value={transportadora} onChange={e => setTransportadora(e.target.value)}
                className="mt-0.5 w-full rounded-lg border border-gray-200 px-2 py-1.5 text-sm">
                <option value="">definir depois</option>
                {(transportadoras || []).map((t: any) => (
                  <option key={t.id} value={t.id}>{t.nome}</option>
                ))}
              </select>
            </div>
          </div>
          {freteEscolhido === SUGERIDO_PENDENCIA && (
            <p className="mt-1 text-[11px] text-gray-400">
              CIF sem valor é o usual em pendência: o frete desta remessa é nosso.
            </p>
          )}
        </div>

        <div>
          <label className="text-xs text-gray-500">Observação (opcional)</label>
          <input value={observacao} onChange={e => setObservacao(e.target.value)} className={inputCls} />
        </div>
      </div>

      <div className="p-5 border-t flex gap-2 shrink-0">
        <button onClick={onClose} className="flex-1 border rounded-xl py-2.5 text-sm">Fechar</button>
        <button
          disabled={liberar.isPending || excedeu.length > 0 || escolha.length === 0}
          onClick={() => liberar.mutate()}
          title={acimaDaFoto.length
            ? 'Acima da foto do PCP — permitido, fica registrado' : undefined}
          className="flex-1 rounded-xl bg-emerald-600 py-2.5 text-sm font-medium text-white hover:bg-emerald-500 disabled:bg-gray-200 disabled:text-gray-400">
          {liberar.isPending ? 'Liberando…'
            : excedeu.length > 0 ? 'Quantidade acima do que foi vendido'
            : escolha.length === 0 ? 'Digite quanto vai agora'
            : `Liberar ${n(total)} un`}
        </button>
      </div>
    </ModalBase>
  )
}

/** Como o card se apresenta conforme o material JÁ existe em estoque ou não.
 *  A cor é a informação principal: a coluna se lê de relance, e o que mudou
 *  desde a decisão é justamente "o material chegou". */
const VISUAL_ESTOQUE = {
  COMPLETO: {
    card: 'bg-emerald-50 border-emerald-400 ring-1 ring-emerald-200',
    faixa: 'bg-emerald-600 text-white',
    valor: 'text-emerald-800',
    chip: 'bg-emerald-100 text-emerald-700',
    botao: 'bg-emerald-600 hover:bg-emerald-500 text-white',
  },
  PARCIAL: {
    card: 'bg-amber-50 border-amber-300',
    faixa: 'bg-amber-500 text-white',
    valor: 'text-amber-900',
    chip: 'bg-amber-100 text-amber-800',
    botao: 'bg-amber-600 hover:bg-amber-500 text-white',
  },
  NENHUM: {
    card: 'bg-white border-red-200',
    faixa: '',
    valor: 'text-red-700',
    chip: 'bg-red-100 text-red-700',
    botao: 'bg-emerald-600 hover:bg-emerald-500 text-white',
  },
} as const

/** Card da coluna "Pendência de estoque" do kanban. */
export function CardPendencia({ p, onAbrir, onLiberar }: {
  p: Pendencia; onAbrir: () => void; onLiberar: () => void
}) {
  const est = p.estoque_agora
  const status = est?.status || 'NENHUM'
  const v = VISUAL_ESTOQUE[status]
  // Item a item, o que já tem estoque — o operador confere sem abrir o card.
  const porCodigo = new Map((est?.itens || []).map(i => [i.codigo || '—', i]))

  return (
    <div className={`rounded-lg border shadow-sm overflow-hidden ${v.card}`}>
      {status !== 'NENHUM' && (
        <div className={`px-2 py-1 text-[11px] font-semibold flex items-center gap-1 ${v.faixa}`}>
          {status === 'COMPLETO' ? (
            <><Check size={12} className="shrink-0" /> Material chegou — dá para liberar tudo</>
          ) : (
            <><Clock size={12} className="shrink-0" /> Chegou parte · {fmtBRL(est?.valor_disponivel || 0)}</>
          )}
        </div>
      )}
      <div className="p-2">
      <div onClick={onAbrir} className="cursor-pointer">
        <p className="text-[13px] font-medium text-gray-800 leading-tight line-clamp-2 break-words">{p.titulo}</p>
        {p.cliente && <p className="text-[11px] text-gray-500 mt-0.5 leading-tight line-clamp-2">{p.cliente}</p>}
        <div className="flex items-center justify-between gap-1 flex-wrap mt-1.5">
          <span className={`text-[13px] font-semibold ${v.valor}`}>{fmtBRL(p.valor)}</span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full ${v.chip}`}>
            {n(p.qtd_total)} un
          </span>
        </div>
        <div className="mt-1.5 space-y-0.5">
          {p.itens.slice(0, 3).map((i, idx) => {
            const agora = porCodigo.get(i.codigo || '—')
            const temTudo = agora && agora.qtd_pendente <= 0
            const temParte = agora && agora.qtd_atendida > 0 && agora.qtd_pendente > 0
            return (
              <p key={idx} className="text-[11px] truncate">
                <span className="text-gray-500">{i.codigo || '—'} · </span>
                {temTudo ? (
                  <span className="text-emerald-700 font-medium">✓ {n(i.qtd_pendente)} em estoque</span>
                ) : temParte ? (
                  <span className="text-amber-700">{n(agora!.qtd_atendida)} de {n(i.qtd_pendente)} em estoque</span>
                ) : (
                  <span className="text-gray-500">faltam {n(i.qtd_pendente)}</span>
                )}
              </p>
            )
          })}
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
      {/* O botão continua ativo mesmo sem estoque na foto: quem libera reconfere
          com o PCP, e o operador pode saber de uma entrada que o app ainda não viu. */}
      <button onClick={onLiberar} disabled={!p.pode_liberar}
        title={p.motivo_bloqueio || ACAO_LIBERAR_LABEL[p.acao_liberar || ''] || ''}
        className={`mt-2 w-full text-xs font-medium rounded-lg py-1.5 disabled:bg-gray-200 disabled:text-gray-400 ${v.botao}`}>
        {!p.pode_liberar ? 'Bloqueada'
          : status === 'COMPLETO' ? 'Liberar agora'
          : status === 'PARCIAL' ? 'Liberar o que chegou'
          : 'Material chegou · liberar'}
      </button>
      </div>
    </div>
  )
}

import { useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery, useQueryClient, useMutation } from '@tanstack/react-query'
import { Printer, Pencil, Copy, AlertCircle } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../../lib/api'
import { fmtBRL, fmtData, msgErro } from '../../lib/crm'
import { ModalCotacao } from './CrmCotacoes'

// Todo produto da proposta é fabricação própria — não há por que pedir isso item
// a item ao vendedor.
const FABRICANTE = 'MSB Medical System do Brasil LTDA EPP - Brasil'
// Departamento de quem emite a proposta. É sempre Comercial: o canal (Uro,
// Vascular) é segmentação interna e não diz nada ao cliente.
const DEPARTAMENTO = 'Comercial'

export function CotacaoImprimir() {
  const { id } = useParams()
  const qc = useQueryClient()
  const [editar, setEditar] = useState(false)

  const { data: c, isLoading } = useQuery<any>({
    queryKey: ['crm-cotacao', id],
    queryFn: () => api.get(`/crm/cotacoes/${id}`).then(r => r.data),
    enabled: !!id,
  })

  const duplicar = useMutation({
    mutationFn: () => api.post(`/crm/cotacoes/${id}/duplicar`),
    onSuccess: (res) => {
      toast.success(`Nova proposta ${res.data?.numero} criada — ajuste itens e valores`)
      window.location.href = `/crm/cotacao/${res.data.id}/imprimir`
    },
    onError: (e: any) => toast.error(msgErro(e, 'Erro ao revisar proposta'), { duration: 5000 }),
  })

  if (isLoading || !c) return <div className="p-10 text-center text-gray-400">Carregando proposta…</div>

  const contatoNome = c.contato?.nome || c.contato_nome
  const contatoEmail = c.contato?.email || c.contato_email
  const enderecoCliente = [c.endereco, c.endereco_bairro].filter(Boolean).join(' - ')
  const cidadeUf = [c.endereco_cidade, c.endereco_uf].filter(Boolean).join('-')
  const pendencias: string[] = c.pendencias || []

  return (
    <div className="min-h-screen bg-gray-100 py-6 print:bg-white print:py-0">
      {/* Barra de ações e avisos — nada disso sai na impressão. */}
      <div className="max-w-[820px] mx-auto mb-4 px-4 space-y-3 print:hidden">
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <p className="text-xs text-gray-500">
            Proposta <strong className="font-mono">{c.numero}</strong> salva — pode reimprimir
            quando quiser pela aba <strong>Cotações</strong> do CRM.
          </p>
          <div className="flex gap-2">
            <button onClick={() => setEditar(true)}
              className="flex items-center gap-2 border border-gray-300 bg-white hover:bg-gray-50 text-gray-700 text-sm font-medium px-3 py-2 rounded-lg">
              <Pencil size={15} /> Completar / editar
            </button>
            <button onClick={() => duplicar.mutate()} disabled={duplicar.isPending}
              className="flex items-center gap-2 border border-gray-300 bg-white hover:bg-gray-50 disabled:opacity-50 text-gray-700 text-sm font-medium px-3 py-2 rounded-lg"
              title="Cria uma nova proposta com os mesmos dados, para revisar itens e valores">
              <Copy size={15} /> {duplicar.isPending ? 'Criando…' : 'Revisar valores'}
            </button>
            <button onClick={() => window.print()}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg">
              <Printer size={16} /> Imprimir / Salvar PDF
            </button>
          </div>
        </div>

        {/* Pedimos o que falta, sem bloquear: proposta incompleta ainda imprime. */}
        {pendencias.length > 0 && (
          <div className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2.5">
            <p className="text-xs font-semibold text-amber-900 flex items-center gap-1.5">
              <AlertCircle size={13} /> Faltam informações no orçamento (opcional — dá para imprimir assim)
            </p>
            <p className="text-xs text-amber-800 mt-1">{pendencias.join(' · ')}</p>
            <button onClick={() => setEditar(true)} className="text-xs text-amber-900 underline font-medium mt-1.5">
              Preencher agora
            </button>
          </div>
        )}
      </div>

      <div className="max-w-[820px] mx-auto bg-white shadow-sm print:shadow-none overflow-hidden">
        {/* Faixa superior (identidade MSB) */}
        <div className="h-2 bg-gradient-to-r from-sky-400 via-teal-500 to-cyan-600" />

        <div className="p-10 print:p-8">
          {/* Cabeçalho */}
          <div className="flex items-start justify-between">
            <div>
              <img src="/msb-logo.png" alt="MSB" className="h-10 w-auto object-contain" />
              <p className="text-[11px] text-gray-500 mt-1 tracking-widest uppercase">Medical System do Brasil</p>
            </div>
            <div className="text-right text-xs text-gray-500 space-y-0.5">
              <p><span className="text-gray-400">Data de criação </span>{fmtData(c.criado_em?.slice(0, 10))}</p>
              <p><span className="text-gray-400">Número de Proposta </span>{c.numero}</p>
              <p><span className="text-gray-400">Data de Validade </span>{c.validade ? fmtData(c.validade) : '—'}</p>
            </div>
          </div>

          <h1 className="text-xl font-bold text-gray-800 mt-4 tracking-wide">PROPOSTA COMERCIAL</h1>

          {/* Preparado por / Destinatário */}
          <div className="grid grid-cols-2 gap-6 mt-5 text-sm">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">Preparado por</p>
              <p className="text-gray-700">{c.responsavel || '—'}</p>
              <p className="text-gray-500 text-xs">{DEPARTAMENTO}</p>
              {c.responsavel_email && <p className="text-gray-500 text-xs">{c.responsavel_email}</p>}
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">Nome completo</p>
              <p className={contatoNome ? 'text-gray-700' : 'text-gray-300'}>{contatoNome || '—'}</p>
              <p className="text-[11px] uppercase tracking-wide text-gray-400 mt-2 mb-1">E-mail</p>
              <p className={contatoEmail ? 'text-gray-500 text-xs' : 'text-gray-300 text-xs'}>{contatoEmail || '—'}</p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-6 mt-5 text-sm">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">Razão Social</p>
              <p className="font-semibold text-gray-800">{c.cliente || '—'}</p>
              <p className="text-[11px] uppercase tracking-wide text-gray-400 mt-2 mb-1">CNPJ</p>
              <p className={c.cliente_cnpj ? 'text-gray-700 text-xs' : 'text-gray-300 text-xs'}>{c.cliente_cnpj || '—'}</p>
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">Endereço principal</p>
              {enderecoCliente
                ? <p className="text-gray-700 text-xs">{enderecoCliente}</p>
                : <p className="text-gray-300 text-xs">—</p>}
              {cidadeUf && <p className="text-gray-500 text-xs">{cidadeUf}</p>}
              {c.endereco_cep && <p className="text-gray-500 text-xs">{c.endereco_cep}</p>}
            </div>
          </div>

          {/* Itens */}
          <table className="w-full mt-6 text-xs">
            <thead>
              <tr className="bg-gray-800 text-white text-left">
                <th className="py-2 px-2 font-medium">Código</th>
                <th className="py-2 px-2 font-medium">Produto</th>
                <th className="py-2 px-2 font-medium">Fabricante</th>
                <th className="py-2 px-2 font-medium text-right">Qtd.</th>
                <th className="py-2 px-2 font-medium text-right">Vlr. Venda</th>
                <th className="py-2 px-2 font-medium text-right">Subtotal</th>
              </tr>
            </thead>
            <tbody>
              {(c.itens || []).map((it: any, i: number) => (
                <tr key={i} className="border-b border-gray-100 align-top">
                  <td className="py-2 px-2 font-mono text-gray-600">{it.codigo || '—'}</td>
                  <td className="py-2 px-2 text-gray-700">{it.descricao}</td>
                  <td className="py-2 px-2 text-gray-500">{FABRICANTE}</td>
                  <td className="py-2 px-2 text-right tabular-nums">{it.qtd} UN</td>
                  <td className="py-2 px-2 text-right tabular-nums">{fmtBRL(it.valor_unitario)}</td>
                  <td className="py-2 px-2 text-right tabular-nums font-medium">{fmtBRL(it.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          {/* Condições + total */}
          <div className="flex justify-between items-end mt-4 text-sm">
            <div className="text-xs text-gray-500 space-y-0.5">
              <p><span className="text-gray-400">Condição de Pagamento </span>{c.condicao_pagamento || '—'}</p>
              <p><span className="text-gray-400">Prazo de entrega </span>{c.prazo_entrega || '—'}</p>
            </div>
            <div className="w-64 space-y-1">
              <div className="flex justify-between text-gray-500 text-xs"><span>Subtotal</span><span className="tabular-nums">{fmtBRL(c.valor_bruto)}</span></div>
              {c.desconto_pct > 0 && <div className="flex justify-between text-gray-500 text-xs"><span>Desconto ({c.desconto_pct}%)</span><span className="tabular-nums">- {fmtBRL(c.valor_bruto * c.desconto_pct / 100)}</span></div>}
              {c.frete > 0 && <div className="flex justify-between text-gray-500 text-xs"><span>Frete</span><span className="tabular-nums">{fmtBRL(c.frete)}</span></div>}
              <div className="flex justify-between text-lg font-bold text-gray-800 border-t border-gray-300 pt-1 mt-1"><span>Valor Total</span><span className="tabular-nums">{fmtBRL(c.valor_total)}</span></div>
            </div>
          </div>

          {c.observacao && (
            <div className="mt-6 text-sm">
              <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1 bg-gray-50 px-2 py-1">Observações</p>
              <p className="text-gray-600 whitespace-pre-wrap px-2">{c.observacao}</p>
            </div>
          )}
        </div>

        {/* Rodapé (identidade MSB) */}
        <div className="h-1.5 bg-gradient-to-r from-sky-400 via-teal-500 to-cyan-600" />
        <div className="px-10 py-3 text-center text-[11px] text-gray-400">
          Esta proposta é válida {c.validade ? `até ${fmtData(c.validade)}` : 'conforme condições acima'} · MSB Medical System do Brasil · www.msbbrasil.com
        </div>
      </div>

      {editar && (
        <ModalCotacao cotacao={c} onClose={() => setEditar(false)}
          onSaved={() => qc.invalidateQueries({ queryKey: ['crm-cotacao', id] })} />
      )}
    </div>
  )
}

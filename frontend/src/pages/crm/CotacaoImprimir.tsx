import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Printer } from 'lucide-react'
import api from '../../lib/api'
import { CANAL_LABEL } from '../../lib/statusConfig'
import { fmtBRL, fmtData } from '../../lib/crm'

export function CotacaoImprimir() {
  const { id } = useParams()
  const { data: c, isLoading } = useQuery<any>({
    queryKey: ['crm-cotacao', id],
    queryFn: () => api.get(`/crm/cotacoes/${id}`).then(r => r.data),
    enabled: !!id,
  })

  if (isLoading || !c) return <div className="p-10 text-center text-gray-400">Carregando proposta…</div>

  const FABRICANTE = 'MSB Medical System do Brasil LTDA EPP - Brasil'
  const enderecoCliente = [c.endereco, c.endereco_bairro].filter(Boolean).join(' - ')
  const cidadeUf = [c.endereco_cidade, c.endereco_uf].filter(Boolean).join('-')

  return (
    <div className="min-h-screen bg-gray-100 py-6 print:bg-white print:py-0">
      {/* Barra de ações (some na impressão) */}
      <div className="max-w-[820px] mx-auto mb-4 flex justify-end px-4 print:hidden">
        <button onClick={() => window.print()} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg">
          <Printer size={16} /> Imprimir / Salvar PDF
        </button>
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

          {/* Preparado por / Cliente */}
          <div className="grid grid-cols-2 gap-6 mt-5 text-sm">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">Preparado por</p>
              <p className="text-gray-700">{c.responsavel || '—'}</p>
              <p className="text-gray-500 text-xs">{c.canal ? (CANAL_LABEL[c.canal] || c.canal) : ''}</p>
              {c.responsavel_email && <p className="text-gray-500 text-xs">{c.responsavel_email}</p>}
            </div>
            {c.contato && (
              <div>
                <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">Nome completo</p>
                <p className="text-gray-700">{c.contato.nome}</p>
                {c.contato.email && <p className="text-gray-500 text-xs">{c.contato.email}</p>}
              </div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-6 mt-5 text-sm">
            <div>
              <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">Razão Social</p>
              <p className="font-semibold text-gray-800">{c.cliente || '—'}</p>
              {c.cliente_cnpj && <p className="text-gray-500 text-xs mt-1">CNPJ: {c.cliente_cnpj}</p>}
            </div>
            <div>
              <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">Endereço principal</p>
              {enderecoCliente ? <p className="text-gray-700 text-xs">{enderecoCliente}</p> : <p className="text-gray-400 text-xs">—</p>}
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
    </div>
  )
}

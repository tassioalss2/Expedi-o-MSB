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

  return (
    <div className="min-h-screen bg-gray-100 py-6 print:bg-white print:py-0">
      {/* Barra de ações (some na impressão) */}
      <div className="max-w-[820px] mx-auto mb-4 flex justify-end px-4 print:hidden">
        <button onClick={() => window.print()} className="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white text-sm font-medium px-4 py-2 rounded-lg">
          <Printer size={16} /> Imprimir / Salvar PDF
        </button>
      </div>

      <div className="max-w-[820px] mx-auto bg-white shadow-sm print:shadow-none p-10 print:p-0">
        {/* Cabeçalho */}
        <div className="flex items-start justify-between border-b-2 border-gray-800 pb-4">
          <div>
            <img src="/msb-logo.png" alt="MSB" className="h-10 w-auto object-contain" />
            <p className="text-[11px] text-gray-500 mt-1 tracking-widest uppercase">Medical System do Brasil</p>
          </div>
          <div className="text-right">
            <h1 className="text-2xl font-bold text-gray-800">PROPOSTA COMERCIAL</h1>
            <p className="text-sm font-mono text-gray-600 mt-1">{c.numero}</p>
            <p className="text-xs text-gray-400">Emissão: {fmtData(c.criado_em?.slice(0, 10))}</p>
          </div>
        </div>

        {/* Cliente */}
        <div className="grid grid-cols-2 gap-6 mt-6 text-sm">
          <div>
            <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">Cliente</p>
            <p className="font-semibold text-gray-800">{c.cliente || '—'}</p>
            {c.cliente_cnpj && <p className="text-gray-500 text-xs">CNPJ: {c.cliente_cnpj}</p>}
            {c.contato && <p className="text-gray-500 text-xs mt-1">A/C: {c.contato.nome}{c.contato.email ? ` · ${c.contato.email}` : ''}</p>}
          </div>
          <div className="text-right">
            {c.canal && <p className="text-xs text-gray-500">Canal: {CANAL_LABEL[c.canal] || c.canal}</p>}
            {c.validade && <p className="text-xs text-gray-500">Validade: {fmtData(c.validade)}</p>}
            {c.prazo_entrega && <p className="text-xs text-gray-500">Entrega: {c.prazo_entrega}</p>}
            {c.condicao_pagamento && <p className="text-xs text-gray-500">Pagamento: {c.condicao_pagamento}</p>}
          </div>
        </div>

        {/* Itens */}
        <table className="w-full mt-6 text-sm">
          <thead>
            <tr className="bg-gray-800 text-white text-left">
              <th className="py-2 px-3 font-medium">Código</th>
              <th className="py-2 px-3 font-medium">Descrição</th>
              <th className="py-2 px-3 font-medium text-right">Qtd</th>
              <th className="py-2 px-3 font-medium text-right">Vlr. Unit.</th>
              <th className="py-2 px-3 font-medium text-right">Desc.</th>
              <th className="py-2 px-3 font-medium text-right">Total</th>
            </tr>
          </thead>
          <tbody>
            {(c.itens || []).map((it: any, i: number) => (
              <tr key={i} className="border-b border-gray-100">
                <td className="py-2 px-3 font-mono text-gray-600">{it.codigo || '—'}</td>
                <td className="py-2 px-3 text-gray-700">{it.descricao}</td>
                <td className="py-2 px-3 text-right tabular-nums">{it.qtd}</td>
                <td className="py-2 px-3 text-right tabular-nums">{fmtBRL(it.valor_unitario)}</td>
                <td className="py-2 px-3 text-right tabular-nums">{it.desconto_pct ? `${it.desconto_pct}%` : '—'}</td>
                <td className="py-2 px-3 text-right tabular-nums font-medium">{fmtBRL(it.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>

        {/* Totais */}
        <div className="flex justify-end mt-4">
          <div className="w-64 text-sm space-y-1">
            <div className="flex justify-between text-gray-500"><span>Subtotal</span><span className="tabular-nums">{fmtBRL(c.valor_bruto)}</span></div>
            {c.desconto_pct > 0 && <div className="flex justify-between text-gray-500"><span>Desconto ({c.desconto_pct}%)</span><span className="tabular-nums">- {fmtBRL(c.valor_bruto * c.desconto_pct / 100)}</span></div>}
            {c.frete > 0 && <div className="flex justify-between text-gray-500"><span>Frete</span><span className="tabular-nums">{fmtBRL(c.frete)}</span></div>}
            <div className="flex justify-between text-lg font-bold text-gray-800 border-t border-gray-300 pt-1 mt-1"><span>Total</span><span className="tabular-nums">{fmtBRL(c.valor_total)}</span></div>
          </div>
        </div>

        {c.observacao && (
          <div className="mt-6 text-sm">
            <p className="text-[11px] uppercase tracking-wide text-gray-400 mb-1">Observações</p>
            <p className="text-gray-600 whitespace-pre-wrap">{c.observacao}</p>
          </div>
        )}

        <div className="mt-10 pt-4 border-t border-gray-200 text-center text-xs text-gray-400">
          Esta proposta é válida {c.validade ? `até ${fmtData(c.validade)}` : 'conforme condições acima'}. · MSB — Medical System do Brasil
        </div>
      </div>
    </div>
  )
}

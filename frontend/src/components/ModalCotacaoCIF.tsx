/**
 * A mensagem de cotação de frete para a transportadora (CIF).
 *
 * É o texto que o time já manda pelo WhatsApp, montado pelo app. O endereço é o
 * único campo que o app não tem de graça: ele vem do D365 e era copiado à mão a
 * cada cotação. Aqui ele é colado uma vez e fica guardado — na OV e, por
 * padrão, no cliente, para a próxima OV dele já vir preenchida.
 */
import { useEffect, useState } from 'react'
import { Copy, Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'
import { MarcaEnviado } from './MarcaEnviado'

export function ModalCotacaoCIF({ pedidoId, dados, onFechar, onAtualizar }: {
  pedidoId: string
  dados: any
  onFechar: () => void
  onAtualizar: (novo: any) => void
}) {
  const [endereco, setEndereco] = useState(dados.endereco || '')
  const [lembrar, setLembrar] = useState(true)
  const [salvando, setSalvando] = useState(false)

  useEffect(() => { setEndereco(dados.endereco || '') }, [dados.endereco])

  const mudou = endereco.trim() !== (dados.endereco || '').trim()
  const faltaEndereco = !(dados.endereco || '').trim()

  async function salvar() {
    setSalvando(true)
    try {
      await api.patch(`/pedidos/${pedidoId}/endereco-entrega`, {
        endereco: endereco.trim(), lembrar_no_cliente: lembrar,
      })
      const { data } = await api.get(`/pedidos/${pedidoId}/cotacao-cif`)
      onAtualizar(data)
      toast.success(lembrar ? 'Endereço salvo — a próxima OV deste cliente já vem com ele'
                            : 'Endereço salvo nesta OV')
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Não consegui salvar o endereço')
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      onClick={onFechar}>
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b shrink-0">
          <h2 className="text-lg font-bold">Cotação de frete — {dados.ov}</h2>
          <p className="text-[13px] text-gray-500 mt-0.5">
            Mande para a transportadora. O endereço vem do D365 e fica guardado aqui.
          </p>
        </div>

        <div className="p-5 space-y-3 flex-1 overflow-y-auto">
          <div>
            <label className="text-xs font-medium text-gray-600">
              Endereço de entrega {faltaEndereco && <span className="text-amber-700">— falta preencher</span>}
            </label>
            <textarea value={endereco} onChange={e => setEndereco(e.target.value)} rows={3}
              placeholder="Cole aqui o endereço completo do D365 (logradouro, número, bairro, CEP, cidade/UF)"
              className={`w-full border rounded-lg p-2.5 text-sm mt-1 ${
                faltaEndereco ? 'border-amber-300 bg-amber-50/40' : 'border-gray-200'}`} />
            <div className="mt-1.5 flex flex-wrap items-center gap-3">
              <label className="flex items-center gap-1.5 text-xs text-gray-600">
                <input type="checkbox" checked={lembrar} onChange={e => setLembrar(e.target.checked)} />
                guardar no cadastro do cliente
              </label>
              <button onClick={salvar} disabled={salvando || !mudou}
                className="flex items-center gap-1.5 rounded-lg bg-gray-800 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40">
                {salvando && <Loader2 className="h-3 w-3 animate-spin" />}
                Salvar endereço
              </button>
              {dados.endereco_de === 'cliente' && !mudou && (
                <span className="text-[11px] text-gray-500">
                  veio de uma entrega anterior deste cliente — confira
                </span>
              )}
            </div>
          </div>

          <textarea readOnly value={dados.texto} rows={12}
            className="w-full border rounded-lg p-3 text-sm font-mono leading-relaxed bg-gray-50" />

          {dados.falta?.length > 0 && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900">
              A mensagem saiu <strong>sem {dados.falta.join(', ')}</strong> porque o app não tem esse
              dado. A transportadora cota com esses números — preencha antes de mandar.
            </div>
          )}
        </div>

        <div className="p-5 border-t flex flex-wrap gap-2 items-center justify-between shrink-0">
          <MarcaEnviado pedidoId={pedidoId} tipo="cotacao_cif" enviado={dados.enviado}
            onMudou={novo => onAtualizar({ ...dados, enviado: novo })} />
          <div className="flex gap-2">
          <button onClick={onFechar} className="px-4 py-2 border rounded-lg text-sm">Fechar</button>
          <button
            onClick={() => {
              navigator.clipboard.writeText(dados.texto)
                .then(() => toast.success('Mensagem copiada'))
                .catch(() => toast.error('Não consegui copiar'))
            }}
            className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium">
            <Copy size={14} /> Copiar mensagem
          </button>
          </div>
        </div>
      </div>
    </div>
  )
}

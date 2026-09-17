/**
 * A mensagem de cotação de frete para a transportadora (CIF).
 *
 * É o texto que o time já manda pelo WhatsApp, montado pelo app. O endereço é o
 * único campo que o app não tem de graça: ele vem do D365 e era copiado à mão a
 * cada cotação. Aqui ele é colado uma vez e fica guardado — na OV e, por
 * padrão, no cliente, para a próxima OV dele já vir preenchida.
 */
import { Copy } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'
import { MarcaEnviado } from './MarcaEnviado'
import { CampoEnderecoEntrega } from './CampoEnderecoEntrega'

export function ModalCotacaoCIF({ pedidoId, dados, onFechar, onAtualizar }: {
  pedidoId: string
  dados: any
  onFechar: () => void
  onAtualizar: (novo: any) => void
}) {
  async function recarregar() {
    const { data } = await api.get(`/pedidos/${pedidoId}/cotacao-cif`)
    onAtualizar(data)
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
          <CampoEnderecoEntrega pedidoId={pedidoId} endereco={dados.endereco}
            enderecoDe={dados.endereco_de} recarregar={recarregar} />

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

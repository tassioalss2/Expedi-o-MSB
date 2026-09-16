/**
 * Um texto pronto para o cliente, com botão de copiar.
 *
 * Existe porque o app não manda e-mail: quem manda é a pessoa, do Outlook. O
 * que o app pode fazer é montar o texto com os dados certos, para ninguém
 * redigitar cubagem e valor — que é onde nascem os erros que voltam do cliente.
 *
 * Mora em components/ porque é usado de dois lugares: do detalhe da OV e do
 * card no kanban da Expedição, que é onde a pessoa está quando manda o e-mail.
 */
import { Copy } from 'lucide-react'
import toast from 'react-hot-toast'

export function ModalTextoCliente({ titulo, subtitulo, texto, aviso, onFechar }: {
  titulo: string
  subtitulo: string
  texto: string
  /** Bloco âmbar opcional: o que o texto NÃO diz, e por quê. */
  aviso?: React.ReactNode
  onFechar: () => void
}) {
  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4"
      onClick={onFechar}>
      <div className="bg-white rounded-2xl w-full max-w-lg max-h-[90vh] flex flex-col"
        onClick={e => e.stopPropagation()}>
        <div className="p-5 border-b shrink-0">
          <h2 className="text-lg font-bold">{titulo}</h2>
          <p className="text-[13px] text-gray-500 mt-0.5">{subtitulo}</p>
        </div>
        <div className="p-5 space-y-3 flex-1 overflow-y-auto">
          <textarea readOnly value={texto} rows={14}
            className="w-full border rounded-lg p-3 text-sm font-mono leading-relaxed bg-gray-50" />
          {aviso}
        </div>
        <div className="p-5 border-t flex gap-2 justify-end shrink-0">
          <button onClick={onFechar} className="px-4 py-2 border rounded-lg text-sm">Fechar</button>
          <button
            onClick={() => {
              navigator.clipboard.writeText(texto)
                .then(() => toast.success('Texto copiado'))
                .catch(() => toast.error('Não consegui copiar'))
            }}
            className="flex items-center gap-1.5 px-4 py-2 bg-indigo-600 text-white rounded-lg text-sm font-medium">
            <Copy size={14} /> Copiar texto
          </button>
        </div>
      </div>
    </div>
  )
}

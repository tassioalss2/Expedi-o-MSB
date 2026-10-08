/** Documentos de uma OV: empenho, ordem de compra, comprovante, exigência do órgão.
 *
 *  Dois usos, e por isso dois componentes neste arquivo:
 *
 *  · `EscolherAnexos` roda ANTES de a OV existir (tela de Nova OV). Ali não há
 *    pedido_id para onde enviar, então os arquivos ficam em memória e sobem
 *    assim que a OV nasce, por `enviarAnexos`.
 *  · `AnexosDaOV` roda depois, na OV já criada: lista, adiciona e remove.
 *
 *  O arquivo em si vive num bucket PRIVADO. O download passa por uma URL
 *  assinada de 5 minutos que o backend gera na hora — documento de cliente não
 *  fica com link público.
 */
import { useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Paperclip, Download, Trash2, Upload, FileText, X, Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'

const TETO = 20 * 1024 * 1024
const ACEITOS = '.pdf,.png,.jpg,.jpeg,.webp,.xlsx,.xls,.doc,.docx,.txt,.csv,.xml,.zip'

export function tamanhoLegivel(bytes: number): string {
  if (!bytes) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** Sobe os arquivos escolhidos antes de a OV existir. Um por vez, de propósito:
 *  se o terceiro falhar, os dois primeiros já estão lá e a mensagem diz qual
 *  faltou — melhor que perder tudo. */
export async function enviarAnexos(pedidoId: string, arquivos: File[]): Promise<number> {
  let ok = 0
  for (const f of arquivos) {
    try {
      const fd = new FormData()
      fd.append('arquivo', f)
      await api.post(`/pedidos/${pedidoId}/anexos`, fd)
      ok++
    } catch (e: any) {
      toast.error(`${f.name}: ${e.response?.data?.detail || 'não consegui anexar'}`,
        { duration: 6000 })
    }
  }
  return ok
}

function validos(lista: File[]): File[] {
  return lista.filter(f => {
    if (f.size > TETO) {
      toast.error(`${f.name} tem ${tamanhoLegivel(f.size)} — o limite é 20 MB`)
      return false
    }
    return true
  })
}

/** Escolha dos documentos na criação da OV (ainda sem pedido_id). */
export function EscolherAnexos({ arquivos, onChange }: {
  arquivos: File[]; onChange: (f: File[]) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [sobre, setSobre] = useState(false)

  function adicionar(lista: FileList | null) {
    if (!lista?.length) return
    onChange([...arquivos, ...validos(Array.from(lista))])
  }

  return (
    <div>
      <label className="text-sm font-medium text-gray-700 flex items-center gap-1.5">
        <Paperclip size={14} /> Documentos
        <span className="text-xs font-normal text-gray-400">(opcional)</span>
      </label>
      <p className="text-xs text-gray-400 mt-0.5 mb-1.5">
        Empenho, ordem de compra, autorização de fornecimento, comprovante de pagamento —
        o que a expedição e o faturamento vão precisar ver sem pedir para ninguém.
      </p>
      <div
        onDragOver={e => { e.preventDefault(); setSobre(true) }}
        onDragLeave={() => setSobre(false)}
        onDrop={e => { e.preventDefault(); setSobre(false); adicionar(e.dataTransfer.files) }}
        onClick={() => input.current?.click()}
        className={`cursor-pointer rounded-lg border-2 border-dashed px-4 py-5 text-center transition ${
          sobre ? 'border-blue-400 bg-blue-50' : 'border-gray-200 hover:border-gray-300'}`}>
        <Upload size={18} className="mx-auto text-gray-400" />
        <p className="mt-1 text-sm text-gray-600">
          Arraste aqui ou <span className="text-blue-600 underline">escolha os arquivos</span>
        </p>
        <p className="text-[11px] text-gray-400 mt-0.5">PDF, imagem, Excel, Word · até 20 MB cada</p>
        <input ref={input} type="file" multiple accept={ACEITOS} className="hidden"
          onChange={e => { adicionar(e.target.files); e.target.value = '' }} />
      </div>
      {arquivos.length > 0 && (
        <div className="mt-2 space-y-1">
          {arquivos.map((f, i) => (
            <div key={i} className="flex items-center gap-2 rounded-lg border border-gray-100 bg-gray-50 px-3 py-1.5 text-sm">
              <FileText size={14} className="shrink-0 text-gray-400" />
              <span className="truncate text-gray-700">{f.name}</span>
              <span className="ml-auto shrink-0 text-xs text-gray-400">{tamanhoLegivel(f.size)}</span>
              <button type="button" onClick={() => onChange(arquivos.filter((_, j) => j !== i))}
                className="shrink-0 text-gray-400 hover:text-red-600" title="Tirar da lista">
                <X size={14} />
              </button>
            </div>
          ))}
          <p className="text-[11px] text-gray-400">
            Sobem junto com a OV — se algum falhar, a OV é criada do mesmo jeito e o aviso diz qual.
          </p>
        </div>
      )}
    </div>
  )
}

/** Os documentos de uma OV que já existe. */
export function AnexosDaOV({ pedidoId }: { pedidoId: string }) {
  const qc = useQueryClient()
  const input = useRef<HTMLInputElement>(null)
  const [subindo, setSubindo] = useState(false)

  const { data: anexos = [] } = useQuery<any[]>({
    queryKey: ['anexos', pedidoId],
    queryFn: () => api.get(`/pedidos/${pedidoId}/anexos`).then(r => r.data),
  })

  async function subir(lista: FileList | null) {
    const arquivos = validos(Array.from(lista || []))
    if (!arquivos.length) return
    setSubindo(true)
    const n = await enviarAnexos(pedidoId, arquivos)
    setSubindo(false)
    if (n) toast.success(n === 1 ? 'Documento anexado' : `${n} documentos anexados`)
    qc.invalidateQueries({ queryKey: ['anexos', pedidoId] })
  }

  const remover = useMutation({
    mutationFn: (id: string) => api.delete(`/pedidos/anexos/${id}`),
    onSuccess: () => {
      toast.success('Documento removido')
      qc.invalidateQueries({ queryKey: ['anexos', pedidoId] })
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || 'Não consegui remover'),
  })

  async function baixar(a: any) {
    try {
      const { data } = await api.get(`/pedidos/anexos/${a.id}/link`)
      window.open(data.url, '_blank', 'noopener')
    } catch (e: any) {
      toast.error(e.response?.data?.detail || 'Não consegui abrir o documento')
    }
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-sm font-semibold text-gray-700">
          <Paperclip size={15} /> Documentos
          {anexos.length > 0 && <span className="text-xs font-normal text-gray-400">({anexos.length})</span>}
        </h3>
        <button onClick={() => input.current?.click()} disabled={subindo}
          className="flex items-center gap-1 rounded-lg border px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50">
          {subindo ? <Loader2 size={12} className="animate-spin" /> : <Upload size={12} />}
          {subindo ? 'Enviando…' : 'Anexar'}
        </button>
        <input ref={input} type="file" multiple accept={ACEITOS} className="hidden"
          onChange={e => { subir(e.target.files); e.target.value = '' }} />
      </div>

      {anexos.length === 0 ? (
        <p className="mt-2 text-xs text-gray-400">
          Nenhum documento. Anexe aqui o empenho, a ordem de compra ou o que o órgão exigiu —
          fica junto da OV para quem pegar o caso depois.
        </p>
      ) : (
        <div className="mt-2 divide-y divide-gray-50">
          {anexos.map((a: any) => (
            <div key={a.id} className="flex items-center gap-2 py-1.5 text-sm">
              <FileText size={14} className="shrink-0 text-gray-400" />
              <button onClick={() => baixar(a)}
                className="truncate text-left text-blue-700 hover:underline" title={a.nome}>
                {a.nome}
              </button>
              <span className="ml-auto shrink-0 text-[11px] text-gray-400">
                {tamanhoLegivel(a.tamanho)}
                {a.criado_por_nome ? ` · ${a.criado_por_nome}` : ''}
                {a.criado_em ? ` · ${new Date(a.criado_em).toLocaleDateString('pt-BR')}` : ''}
              </span>
              <button onClick={() => baixar(a)} className="shrink-0 text-gray-400 hover:text-blue-600" title="Abrir">
                <Download size={14} />
              </button>
              <button onClick={() => { if (confirm(`Remover "${a.nome}"?`)) remover.mutate(a.id) }}
                className="shrink-0 text-gray-300 hover:text-red-600" title="Remover">
                <Trash2 size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

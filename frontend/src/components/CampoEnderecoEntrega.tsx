/**
 * O endereço de entrega, colado do D365 e guardado.
 *
 * O app só tem cidade/UF em `local_entrega` ("Belo Horizonte/MG"), e nem a
 * transportadora cota frete com isso nem o cliente confere recebimento por
 * isso. O endereço completo vem do D365 e era redigitado a cada mensagem.
 *
 * Aqui ele é colado uma vez e fica guardado na OV e, por padrão, no cadastro do
 * cliente — a próxima OV daquele cliente já vem preenchida. Desmarque quando a
 * entrega for pontual em outro lugar (uma filial, outro hospital da rede), para
 * não sobrescrever o endereço bom do cliente.
 *
 * Mora em components/ porque as duas mensagens que levam endereço usam o mesmo
 * campo e a mesma gravação: a cotação de frete e o aviso de NF.
 */
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'

export function CampoEnderecoEntrega({ pedidoId, endereco, enderecoDe, recarregar }: {
  pedidoId: string
  endereco?: string | null
  /** 'cliente' = veio de uma entrega anterior, não desta OV. */
  enderecoDe?: string | null
  /** Rebusca a mensagem depois de salvar, para o texto sair com o endereço. */
  recarregar: () => Promise<void>
}) {
  const [texto, setTexto] = useState(endereco || '')
  const [lembrar, setLembrar] = useState(true)
  const [salvando, setSalvando] = useState(false)

  useEffect(() => { setTexto(endereco || '') }, [endereco])

  const mudou = texto.trim() !== (endereco || '').trim()
  const vazio = !(endereco || '').trim()

  async function salvar() {
    setSalvando(true)
    try {
      await api.patch(`/pedidos/${pedidoId}/endereco-entrega`, {
        endereco: texto.trim(), lembrar_no_cliente: lembrar,
      })
      await recarregar()
      toast.success(lembrar
        ? 'Endereço salvo — a próxima OV deste cliente já vem com ele'
        : 'Endereço salvo nesta OV')
    } catch (e: any) {
      toast.error(e?.response?.data?.detail || 'Não consegui salvar o endereço')
    } finally {
      setSalvando(false)
    }
  }

  return (
    <div>
      <label className="text-xs font-medium text-gray-600">
        Endereço de entrega {vazio && <span className="text-amber-700">— falta preencher</span>}
      </label>
      <textarea value={texto} onChange={e => setTexto(e.target.value)} rows={3}
        placeholder="Cole aqui o endereço completo do D365 (logradouro, número, bairro, CEP, cidade/UF)"
        className={`w-full border rounded-lg p-2.5 text-sm mt-1 ${
          vazio ? 'border-amber-300 bg-amber-50/40' : 'border-gray-200'}`} />
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
        {enderecoDe === 'cliente' && !mudou && (
          <span className="text-[11px] text-gray-500">
            veio de uma entrega anterior deste cliente — confira
          </span>
        )}
      </div>
    </div>
  )
}

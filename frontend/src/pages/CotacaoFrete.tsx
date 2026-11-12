/**
 * Cotação de frete avulsa.
 *
 * O cálculo do frete nunca dependeu do Kanban: a conta é uma função de cinco
 * números — destino, peso, volume, valor da mercadoria e data de entrega. O
 * Kanban era apenas um dos jeitos de entregá-los. Esta tela é o outro, e o
 * único que não depende de a carga existir no app.
 *
 * Serve para:
 *   · cotar antes de existir OV, na conversa com o cliente;
 *   · calcular o frete de uma carga que vive em outro sistema;
 *   · conferir um preço que a transportadora mandou, antes de aceitar.
 *
 * A conta é exatamente a mesma da OV — mesma tabela, mesmo ICMS por dentro de
 * 12%, mesma escolha de modalidade pela data de entrega. Nada aqui é uma
 * segunda versão da regra: o backend chama a mesma função.
 */
import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Calculator, Copy, Loader2, Package, Plus, Trash2, Truck } from 'lucide-react'
import toast from 'react-hot-toast'
import api from '../lib/api'
import { PainelFrete, type Estimativa } from '../components/FreteEstimado'
import { TipoCaixaAutocomplete } from '../components/TipoCaixaAutocomplete'

type Caixa = {
  tipo_caixa_id: string
  codigo: string
  descricao: string
  quantidade: number
}

type Destino = { cidade: string; uf: string; prazo_capital?: number }

type Resultado = Estimativa & {
  m3?: number
  origem_m3?: string
  caixas?: Array<{ caixa: string; quantidade: number; m3_unitario: number; m3: number }>
  valor_mercadoria?: number
  local_entrega?: string | null
  saida?: string | null
}

const brl = (v?: number | null) =>
  (Number(v) || 0).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })
const hoje = () => new Date().toISOString().slice(0, 10)

const caixaVazia = (): Caixa => ({ tipo_caixa_id: '', codigo: '', descricao: '', quantidade: 1 })

export default function CotacaoFrete() {
  const [cidade, setCidade] = useState('')
  const [uf, setUf] = useState('')
  const [peso, setPeso] = useState('')
  const [valor, setValor] = useState('')
  const [saida, setSaida] = useState(hoje())
  const [entrega, setEntrega] = useState('')
  const [caixas, setCaixas] = useState<Caixa[]>([caixaVazia()])
  // Quem já tem o m³ pronto (vindo de outro sistema) não precisa montar a
  // caixaria: digita o volume e pronto.
  const [modoM3, setModoM3] = useState(false)
  const [m3, setM3] = useState('')
  const [resultado, setResultado] = useState<Resultado | null>(null)

  /** Qualquer mexida no formulário apaga o resultado.
   *
   *  Um preço velho ao lado de um formulário novo é pior que nenhum preço:
   *  é assim que alguém cota um valor que a conta não sustenta mais. */
  const mexeu = <T,>(set: (v: T) => void) => (v: T) => { setResultado(null); set(v) }

  const { data: tabela } = useQuery<{ destinos?: Destino[]; vigencia?: string }>({
    queryKey: ['frete-tabela'],
    queryFn: () => api.get('/frete/tabela').then(r => r.data),
    staleTime: 60 * 60_000,
  })
  const destinos = tabela?.destinos || []
  const ufs = Array.from(new Set(destinos.map(d => d.uf))).sort()

  const calcular = useMutation({
    mutationFn: async () => {
      const corpo = {
        cidade: cidade.trim() || null,
        uf: uf.trim().toUpperCase() || null,
        peso_kg: Number(String(peso).replace(',', '.')) || 0,
        m3: modoM3 ? (Number(String(m3).replace(',', '.')) || 0) : null,
        caixas: modoM3 ? [] : caixas
          .filter(c => c.quantidade > 0 && (c.tipo_caixa_id || c.descricao))
          .map(c => ({
            tipo_caixa_id: c.tipo_caixa_id || null,
            descricao: c.descricao || null,
            codigo: c.codigo || null,
            quantidade: c.quantidade,
          })),
        valor_mercadoria: Number(String(valor).replace(',', '.')) || 0,
        data_entrega: entrega || null,
        saida: saida || null,
      }
      return api.post('/frete/cotacao', corpo).then(r => r.data as Resultado)
    },
    onSuccess: r => setResultado(r),
    onError: (e: any) =>
      toast.error(e?.response?.data?.detail || 'Não consegui calcular esta cotação.'),
  })

  const podeCalcular = !!(cidade.trim() || uf.trim())

  /** O resumo em texto, para colar na conversa com o cliente ou no e-mail.
   *  A cotação só vira decisão quando sai da tela. */
  const copiar = () => {
    if (!resultado?.encontrado) return
    const l = [
      `Frete ${resultado.transportadora} — ${resultado.destino}`,
      `Modalidade: ${resultado.modalidade === 'EXPRESSO' ? 'Expresso (próximo voo)' : 'Convencional'}`,
      `Peso cobrado: ${(resultado.peso_cobrado_kg || 0).toLocaleString('pt-BR')} kg`
        + (resultado.m3 ? ` · volume ${resultado.m3} m³` : ''),
      `Frete-peso: ${brl(resultado.frete_peso)}`,
      `Taxa de coleta: ${brl(resultado.taxa_coleta)}`,
      `Taxa de entrega: ${brl(resultado.taxa_entrega)}`,
      `Ad valorem (${resultado.ad_valorem_pct}%): ${brl(resultado.ad_valorem)}`,
    ]
    if (resultado.gris) l.push(`GRIS (${resultado.gris_pct}%): ${brl(resultado.gris)}`)
    if (resultado.icms) l.push(`ICMS ${resultado.icms_pct}% por dentro: ${brl(resultado.icms)}`)
    l.push(`TOTAL: ${brl(resultado.total)}`)
    if (resultado.prazo_capital) l.push(`Prazo: ${resultado.prazo_capital} dia(s) úteis`)
    l.push('', 'Estimativa pela tabela contratada. Não inclui pedágio, hora parada,'
      + ' taxa de emergência nem trecho de redespacho de interior.')
    navigator.clipboard.writeText(l.join('\n'))
    toast.success('Resumo copiado.')
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-start gap-3 mb-1">
        <Truck className="text-blue-600 mt-0.5" size={24} />
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Cotação de Frete</h1>
          <p className="text-sm text-gray-500">
            A mesma conta da OV, sem precisar de OV — para cotar antes da venda,
            calcular carga de fora do app ou conferir um preço da transportadora.
          </p>
        </div>
      </div>
      {tabela?.vigencia && (
        <p className="text-[11px] text-gray-400 ml-9 mb-5">
          Tabela em vigor: {tabela.vigencia}
        </p>
      )}

      <div className="grid lg:grid-cols-2 gap-5">
        {/* ── Formulário ──────────────────────────────────────────────── */}
        <div className="bg-white rounded-xl border border-gray-200 p-5 space-y-4">
          <div>
            <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide mb-2">
              Destino
            </p>
            <div className="grid grid-cols-[1fr_90px] gap-2">
              <div>
                <label className="text-[11px] text-gray-500">Cidade</label>
                <input list="destinos-brix" value={cidade}
                  onChange={e => mexeu(setCidade)(e.target.value)}
                  placeholder="SALVADOR"
                  className="w-full border rounded-lg px-3 py-2 text-sm uppercase" />
                <datalist id="destinos-brix">
                  {destinos.map(d => <option key={`${d.cidade}-${d.uf}`} value={d.cidade} />)}
                </datalist>
              </div>
              <div>
                <label className="text-[11px] text-gray-500">UF</label>
                <select value={uf} onChange={e => mexeu(setUf)(e.target.value)}
                  className="w-full border rounded-lg px-2 py-2 text-sm">
                  <option value="">—</option>
                  {ufs.map(u => <option key={u} value={u}>{u}</option>)}
                </select>
              </div>
            </div>
            <p className="text-[11px] text-gray-400 mt-1">
              Cidade fora da tabela cota pela capital da UF, com entrega cobrada
              como interior/redespacho — a tela avisa quando isso acontecer.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-gray-500">Peso total da carga (kg)</label>
              <input value={peso} onChange={e => mexeu(setPeso)(e.target.value)}
                inputMode="decimal" placeholder="0,00"
                className="w-full border rounded-lg px-3 py-2 text-sm" />
            </div>
            <div>
              <label className="text-[11px] text-gray-500">Valor da mercadoria (R$)</label>
              <input value={valor} onChange={e => mexeu(setValor)(e.target.value)}
                inputMode="decimal" placeholder="0,00"
                className="w-full border rounded-lg px-3 py-2 text-sm" />
              <p className="text-[10px] text-gray-400 mt-0.5">base do ad valorem</p>
            </div>
          </div>

          {/* ── Cubagem ──────────────────────────────────────────────── */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <p className="text-xs font-semibold text-gray-700 uppercase tracking-wide">
                Cubagem
              </p>
              <button type="button"
                onClick={() => { setResultado(null); setModoM3(!modoM3) }}
                className="text-[11px] text-blue-600 hover:underline">
                {modoM3 ? 'escolher as caixas' : 'já tenho o m³'}
              </button>
            </div>

            {modoM3 ? (
              <div>
                <input value={m3} onChange={e => mexeu(setM3)(e.target.value)}
                  inputMode="decimal" placeholder="0,000"
                  className="w-full border rounded-lg px-3 py-2 text-sm" />
                <p className="text-[11px] text-gray-400 mt-1">
                  Volume total em m³. Use quando a cubagem vier calculada de outro
                  sistema — aqui o app confia no número e não consulta o cadastro.
                </p>
              </div>
            ) : (
              <div className="space-y-2">
                {caixas.map((c, i) => (
                  <div key={i} className="flex gap-2 items-start">
                    <div className="flex-1">
                      <TipoCaixaAutocomplete value={c.codigo}
                        onSelect={(id, codigo, descricao) => {
                          setResultado(null)
                          const novo = [...caixas]
                          novo[i] = { ...novo[i], tipo_caixa_id: id, codigo, descricao }
                          setCaixas(novo)
                        }} />
                      {c.descricao && (
                        <p className="text-[10px] text-gray-400 mt-0.5 truncate">{c.descricao}</p>
                      )}
                    </div>
                    <input type="number" min={1} value={c.quantidade}
                      onChange={e => {
                        setResultado(null)
                        const novo = [...caixas]
                        novo[i] = { ...novo[i], quantidade: Number(e.target.value) || 0 }
                        setCaixas(novo)
                      }}
                      className="w-20 border rounded-lg px-2 py-2 text-sm" />
                    <button type="button"
                      onClick={() => { setResultado(null); setCaixas(caixas.filter((_, x) => x !== i)) }}
                      disabled={caixas.length === 1}
                      className="p-2 text-gray-400 hover:text-red-600 disabled:opacity-30">
                      <Trash2 size={16} />
                    </button>
                  </div>
                ))}
                <button type="button"
                  onClick={() => { setResultado(null); setCaixas([...caixas, caixaVazia()]) }}
                  className="text-xs text-blue-600 hover:underline flex items-center gap-1">
                  <Plus size={13} /> outra caixa
                </button>
                <p className="text-[11px] text-gray-400">
                  O m³ sai da medida cadastrada em cada tipo de caixa — o mesmo
                  cadastro que a cubagem da OV usa.
                </p>
              </div>
            )}
          </div>

          {/* ── Datas ────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="text-[11px] text-gray-500">Saída da carga</label>
              <input type="date" value={saida}
                onChange={e => mexeu(setSaida)(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm" />
              <p className="text-[10px] text-gray-400 mt-0.5">o prazo corre daqui</p>
            </div>
            <div>
              <label className="text-[11px] text-gray-500">Entrega combinada</label>
              <input type="date" value={entrega}
                onChange={e => mexeu(setEntrega)(e.target.value)}
                className="w-full border rounded-lg px-3 py-2 text-sm" />
              <p className="text-[10px] text-gray-400 mt-0.5">
                sem data, cota convencional
              </p>
            </div>
          </div>

          <button onClick={() => calcular.mutate()}
            disabled={!podeCalcular || calcular.isPending}
            className="w-full bg-blue-600 text-white rounded-lg py-2.5 text-sm font-semibold
                       flex items-center justify-center gap-2 disabled:opacity-40">
            {calcular.isPending
              ? <><Loader2 size={16} className="animate-spin" /> Calculando...</>
              : <><Calculator size={16} /> Calcular frete</>}
          </button>
          {!podeCalcular && (
            <p className="text-[11px] text-gray-400 text-center -mt-2">
              Informe ao menos a cidade ou a UF do destino.
            </p>
          )}
        </div>

        {/* ── Resultado ───────────────────────────────────────────────── */}
        <div className="space-y-3">
          {!resultado && (
            <div className="rounded-xl border border-dashed border-gray-300 p-8 text-center">
              <Package className="mx-auto text-gray-300 mb-2" size={32} />
              <p className="text-sm text-gray-500">
                Preencha a carga e clique em <strong>Calcular frete</strong>.
              </p>
              <p className="text-[11px] text-gray-400 mt-1">
                A conta vem aberta: frete-peso, taxas, ad valorem e ICMS, com a
                comparação entre convencional e expresso quando houver data de entrega.
              </p>
            </div>
          )}

          {resultado && (
            <>
              <PainelFrete data={resultado} />

              {!!resultado.caixas?.length && resultado.origem_m3 === 'tipos de caixa' && (
                <div className="rounded-xl border border-gray-200 bg-white p-3">
                  <p className="text-[11px] font-semibold text-gray-600 mb-1.5">
                    Volume por caixa — total {resultado.m3} m³
                  </p>
                  <table className="w-full text-[11px]">
                    <tbody>
                      {resultado.caixas.map((c, i) => (
                        <tr key={i} className="border-t border-gray-50">
                          <td className="py-1 text-gray-700">{c.caixa}</td>
                          <td className="py-1 text-gray-400 text-right">{c.quantidade}×</td>
                          <td className="py-1 text-gray-400 text-right tabular-nums">
                            {c.m3_unitario ? `${c.m3_unitario} m³` : 'sem medida'}
                          </td>
                          <td className="py-1 text-gray-700 text-right tabular-nums font-medium">
                            {c.m3} m³
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {resultado.encontrado && (
                <button onClick={copiar}
                  className="w-full border border-gray-300 rounded-lg py-2 text-sm text-gray-700
                             hover:bg-gray-50 flex items-center justify-center gap-2">
                  <Copy size={14} /> Copiar resumo da cotação
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}

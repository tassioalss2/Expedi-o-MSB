/**
 * Tela de Contagem — Inventário Contínuo MSB
 * Operador registra quantidade física de um produto/lote.
 * Design: simples, campos grandes, mínimo de digitação.
 */
import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Check, AlertTriangle, Search } from 'lucide-react'
import api from '../lib/api'
import toast from 'react-hot-toast'
import { useAuthStore } from '../store/authStore'

// ── Autocomplete de produto ───────────────────────────────────────────────────

function ProdutoInput({
  value, onChange, onDescricao,
}: { value: string; onChange: (v: string) => void; onDescricao: (d: string) => void }) {
  const [busca, setBusca] = useState(value)
  const [open, setOpen] = useState(false)

  const { data: produtos = [] } = useQuery({
    queryKey: ['produtos-busca-inv', busca],
    queryFn: () => api.get('/produtos/busca', { params: { q: busca } }).then(r => r.data),
    enabled: busca.length >= 2,
  })

  const handleType = (v: string) => {
    const up = v.toUpperCase()
    setBusca(up)
    onChange(up)
    onDescricao('')
    setOpen(true)
  }

  const selecionar = (p: any) => {
    setBusca(p.codigo)
    onChange(p.codigo)
    onDescricao(p.descricao || '')
    setOpen(false)
  }

  return (
    <div className="relative">
      <div className="relative">
        <Search size={16} className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          value={busca}
          onChange={e => handleType(e.target.value)}
          onFocus={() => busca.length >= 2 && setOpen(true)}
          placeholder="Digite ou escaneie o código"
          className="w-full border rounded-xl pl-9 pr-4 py-3 text-sm font-mono"
          autoFocus
        />
      </div>
      {open && busca.length >= 2 && (produtos as any[]).length > 0 && (
        <div className="absolute z-50 w-full bg-white border border-gray-200 rounded-xl shadow-lg mt-1 max-h-52 overflow-y-auto">
          {(produtos as any[]).slice(0, 8).map((p: any) => (
            <button key={p.id || p.codigo} onClick={() => selecionar(p)}
              className="w-full text-left px-4 py-2.5 hover:bg-teal-50 text-sm border-b border-gray-50 last:border-0">
              <span className="font-bold text-gray-800 font-mono">{p.codigo}</span>
              <span className="text-gray-400 text-xs ml-2 block truncate">{p.descricao}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

// ── Campo numérico grande ─────────────────────────────────────────────────────

function CampoNumero({
  label, sublabel, value, onChange, disabled = false, destaque = false,
}: {
  label: string; sublabel?: string; value: string;
  onChange: (v: string) => void; disabled?: boolean; destaque?: boolean
}) {
  return (
    <div>
      <label className="text-sm font-semibold text-gray-700">{label}</label>
      {sublabel && <p className="text-xs text-gray-400">{sublabel}</p>}
      <input
        type="number"
        min={0}
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        className={`w-full border-2 rounded-xl px-4 py-3 text-2xl font-bold text-center mt-1 transition-colors ${
          disabled ? 'bg-gray-50 text-gray-400 border-gray-200' :
          destaque ? 'border-teal-400 focus:border-teal-500 bg-teal-50 focus:outline-none' :
          'border-gray-300 focus:border-teal-400 focus:outline-none'
        }`}
        placeholder="0"
      />
    </div>
  )
}

// ── Página ────────────────────────────────────────────────────────────────────

export function InventarioContagem() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const { usuario } = useAuthStore()

  const [codigo, setCodigo] = useState('')
  const [descricao, setDescricao] = useState('')
  const [lote, setLote] = useState('')
  const [qtdSistem, setQtdSistem] = useState('')
  const [qtdFisica, setQtdFisica] = useState('')
  const [qtdVenda, setQtdVenda] = useState('')
  const [motivoId, setMotivoId] = useState('')
  const [observacao, setObservacao] = useState('')

  // Ciclo aberto
  const { data: cicloAberto } = useQuery({
    queryKey: ['inv-ciclo-aberto'],
    queryFn: () => api.get('/inventario-continuo/ciclos/aberto').then(r => r.data),
  })

  // Motivos padronizados
  const { data: motivos = [] } = useQuery({
    queryKey: ['inv-motivos'],
    queryFn: () => api.get('/inventario-continuo/motivos').then(r => r.data),
  })

  // Cálculos em tempo real
  // Sistêmico = estoque antes da separação
  // Venda     = quantidade separada/vendida
  // Físico    = o que ficou após a separação
  // Divergência = Físico − (Sistêmico − Venda)
  // Se o físico bate com o esperado após separação → divergência zero
  const sist   = Number(qtdSistem) || 0
  const fis    = qtdFisica !== '' ? Number(qtdFisica) : null
  const venda  = Number(qtdVenda)  || 0
  const esperado = sist - venda
  const diverg   = fis !== null ? fis - esperado : null
  const pct      = diverg !== null && sist > 0 ? Math.abs(diverg) / sist * 100 : 0
  const temDiverg = diverg !== null && diverg !== 0

  // Motivo selecionado
  const motivoObj = (motivos as any[]).find((m: any) => m.id === motivoId)
  const precisaObs = motivoObj?.categoria === 'OUTRO'

  // Validação
  const cicloId = cicloAberto?.id
  const podeEnviar = cicloId && codigo.trim() && lote.trim() && qtdSistem !== '' && qtdFisica !== ''
    && (!temDiverg || motivoId)
    && (!precisaObs || observacao.trim().length >= 5)

  const mutation = useMutation({
    mutationFn: () => api.post(`/inventario-continuo/ciclos/${cicloId}/contagens`, {
      codigo_produto: codigo.trim(),
      descricao_produto: descricao || null,
      lote: lote.trim(),
      qtd_sistemica: sist,
      qtd_fisica: fis ?? 0,
      qtd_venda: venda,
      motivo_id: motivoId || null,
      observacao: observacao.trim() || null,
    }),
    onSuccess: () => {
      toast.success('✅ Contagem registrada!')
      qc.invalidateQueries({ queryKey: ['inv-contagens'] })
      qc.invalidateQueries({ queryKey: ['inv-ciclo-aberto'] })
      // Limpa para próxima contagem
      setCodigo(''); setDescricao(''); setLote('')
      setQtdSistem(''); setQtdFisica(''); setQtdVenda('')
      setMotivoId(''); setObservacao('')
    },
    onError: (e: any) => toast.error(e.response?.data?.detail || 'Erro ao salvar'),
  })

  if (!cicloAberto?.id) {
    return (
      <div className="p-6 max-w-lg mx-auto text-center py-20">
        <AlertTriangle size={40} className="mx-auto text-amber-400 mb-3" />
        <p className="font-semibold text-gray-700">Nenhum ciclo de inventário aberto</p>
        <p className="text-sm text-gray-400 mt-1">Aguarde a liderança abrir o ciclo do dia.</p>
        <button onClick={() => navigate('/inventario')} className="mt-4 text-teal-600 text-sm hover:underline">← Voltar</button>
      </div>
    )
  }

  return (
    <div className="p-4 max-w-lg mx-auto">
      {/* Header */}
      <div className="flex items-center gap-3 mb-5">
        <button onClick={() => navigate('/inventario')} className="p-2 hover:bg-gray-100 rounded-lg">
          <ArrowLeft size={20} />
        </button>
        <div>
          <h1 className="text-xl font-bold text-gray-900">Nova Contagem</h1>
          <p className="text-xs text-gray-400">{cicloAberto.nome} · 👤 {usuario?.nome}</p>
        </div>
      </div>

      <div className="space-y-4">

        {/* Produto */}
        <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-3">
          <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide">📦 Produto</h3>
          <div>
            <label className="text-sm font-semibold text-gray-700">Código *</label>
            <div className="mt-1">
              <ProdutoInput value={codigo} onChange={setCodigo} onDescricao={setDescricao} />
            </div>
            {descricao && <p className="text-xs text-teal-700 mt-1 font-medium">✓ {descricao}</p>}
          </div>
          <div>
            <label className="text-sm font-semibold text-gray-700">Lote *</label>
            <input
              type="text"
              value={lote}
              onChange={e => setLote(e.target.value.toUpperCase())}
              placeholder="Ex: 000051-26-01"
              className="w-full border rounded-xl px-4 py-2.5 text-sm font-mono mt-1"
            />
          </div>
        </div>

        {/* Quantidades */}
        <div className="bg-white rounded-2xl border border-gray-200 p-4 space-y-4">
          <h3 className="text-sm font-bold text-gray-700 uppercase tracking-wide">🔢 Quantidades</h3>

          <CampoNumero label="Qtd. Sistêmica (D365) *"
            sublabel="Quantidade que o sistema mostra"
            value={qtdSistem} onChange={setQtdSistem} />

          <CampoNumero label="Qtd. Física (após separação) *"
            sublabel="O que ficou fisicamente após separar a venda"
            value={qtdFisica} onChange={setQtdFisica} destaque />

          {/* Divergência em tempo real */}
          {diverg !== null && (
            <div className={`rounded-xl p-4 text-center ${
              diverg === 0 ? 'bg-green-50 border border-green-200' :
              'bg-orange-50 border border-orange-300'}`}>
              {diverg === 0 ? (
                <div className="flex items-center justify-center gap-2 text-green-700">
                  <Check size={20} />
                  <span className="font-bold">Sem divergência — estoque OK!</span>
                </div>
              ) : (
                <div>
                  <p className="text-sm text-orange-700 font-medium mb-1">⚠ Divergência detectada</p>
                  <p className={`text-3xl font-bold ${diverg > 0 ? 'text-blue-700' : 'text-red-700'}`}>
                    {diverg > 0 ? '+' : ''}{diverg} un
                  </p>
                  <p className="text-sm text-gray-500 mt-1">
                    {pct.toFixed(1)}% · {diverg > 0 ? 'Mais unidades que o sistema' : 'Menos unidades que o sistema'}
                  </p>
                </div>
              )}
            </div>
          )}

          {/* Campo de venda — só aparece se há divergência */}
          {temDiverg && (
            <CampoNumero label="Qtd. Vendida/Movimentada"
              sublabel="Saída registrada no D365 não computada ainda"
              value={qtdVenda} onChange={setQtdVenda} />
          )}
        </div>

        {/* Motivo — só aparece se há divergência */}
        {temDiverg && (
          <div className="bg-white rounded-2xl border border-orange-200 p-4 space-y-3">
            <h3 className="text-sm font-bold text-orange-700 uppercase tracking-wide">⚠ Motivo da Divergência *</h3>
            <div className="space-y-2">
              {(motivos as any[]).map((m: any) => (
                <label key={m.id}
                  className={`flex items-center gap-3 p-3 rounded-xl border-2 cursor-pointer transition-colors ${
                    motivoId === m.id ? 'border-orange-500 bg-orange-50' : 'border-gray-200 hover:border-orange-300'}`}>
                  <input type="radio" name="motivo" value={m.id} checked={motivoId === m.id}
                    onChange={() => setMotivoId(m.id)} className="accent-orange-600 w-4 h-4 flex-shrink-0" />
                  <span className="text-sm text-gray-700">{m.descricao}</span>
                </label>
              ))}
            </div>
            {precisaObs && (
              <div>
                <label className="text-sm font-semibold text-gray-700">Descrição do motivo *</label>
                <textarea rows={2} value={observacao} onChange={e => setObservacao(e.target.value)}
                  placeholder="Descreva o motivo com detalhes (mín. 5 caracteres)"
                  className="w-full border rounded-xl px-3 py-2 text-sm mt-1" autoFocus />
              </div>
            )}
            {motivoId && !precisaObs && (
              <div>
                <label className="text-sm font-medium text-gray-600">Observação adicional (opcional)</label>
                <textarea rows={2} value={observacao} onChange={e => setObservacao(e.target.value)}
                  placeholder="Ex: verificar com Erivaldo — produto pode estar no P-Acabado"
                  className="w-full border rounded-xl px-3 py-2 text-sm mt-1" />
              </div>
            )}
          </div>
        )}

        {/* Botões */}
        <div className="flex gap-3 pb-4">
          <button onClick={() => navigate('/inventario')}
            className="flex-1 py-3 border rounded-xl text-sm text-gray-600 hover:bg-gray-50">
            Cancelar
          </button>
          <button
            onClick={() => mutation.mutate()}
            disabled={mutation.isPending || !podeEnviar}
            className="flex-1 py-3 bg-teal-600 text-white rounded-xl text-sm font-bold disabled:opacity-40 hover:bg-teal-500 transition-colors">
            {mutation.isPending ? 'Salvando...' : '✅ Salvar Contagem'}
          </button>
        </div>

        {/* Alerta divergência crítica */}
        {temDiverg && pct > 15 && (
          <div className="bg-red-50 border border-red-300 rounded-xl p-3 text-sm text-red-700 text-center">
            🚨 <strong>Divergência crítica ({pct.toFixed(1)}%).</strong> Esta contagem precisará de aprovação da liderança.
          </div>
        )}
      </div>
    </div>
  )
}

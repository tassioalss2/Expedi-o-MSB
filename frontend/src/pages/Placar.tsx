/** Placar de parede — o resultado do mês numa tela que se lê de longe.
 *
 *  Nasceu de um pedido do Tássio: os números existem no Painel Comercial, mas
 *  quem passa pelo corredor não abre painel. Aqui eles ficam aparentes o dia
 *  inteiro, numa TV, sem ninguém operar nada.
 *
 *  Três decisões que mudam o que a tela é:
 *
 *  · NENHUM número novo é calculado aqui. Tudo vem dos mesmos endpoints do
 *    Painel Comercial e da barra de meta. Um placar que calcula por conta
 *    própria começa a divergir do painel, e aí ninguém confia em nenhum dos
 *    dois.
 *  · Sem interação: não tem filtro, não tem clique, não tem mês para escolher.
 *    É o mês corrente e pronto. Quem precisa investigar vai ao painel.
 *  · O ritmo tem mais peso que o total. "R$ 1,2 mi" não diz se está bom; "atrás
 *    do ritmo, faltam R$ 300 mil em 6 dias úteis" diz.
 *
 *  Fora do Layout de propósito (rota /placar): numa TV não há sidebar, nem
 *  alguém para navegar.
 */
import { useEffect, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'
import { ORDEM_KANBAN, STATUS_CONFIG } from '../lib/statusConfig'

const REFRESCO = 60_000

const CANAIS = [
  { key: 'URO', label: 'Uro', cor: '#38bdf8' },
  { key: 'VASCULAR', label: 'Vascular', cor: '#a78bfa' },
  { key: 'REALCLOSURE', label: 'Realclosure', cor: '#fbbf24' },
  { key: 'LICITACAO', label: 'Licitação', cor: '#34d399' },
]

const RITMO_COR: Record<string, string> = {
  BATIDA: '#34d399',
  NO_RITMO: '#34d399',
  POUCO_ATRAS: '#fbbf24',
  ATRAS: '#f87171',
}

function milhar(v: number): string {
  // Numa parede, centavos não se leem. Abaixo de mil o valor sai inteiro
  // porque "R$ 0,8 mil" é pior de ler que "R$ 840".
  const n = Math.round(Number(v) || 0)
  if (Math.abs(n) >= 1_000_000) return `R$ ${(n / 1_000_000).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} mi`
  if (Math.abs(n) >= 1_000) return `R$ ${(n / 1_000).toLocaleString('pt-BR', { maximumFractionDigits: 0 })} mil`
  return `R$ ${n.toLocaleString('pt-BR')}`
}

const MES_PT = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho',
  'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro']

function Barra({ pct, cor, altura = 14 }: { pct: number; cor: string; altura?: number }) {
  const largura = Math.max(0, Math.min(100, pct))
  return (
    <div className="w-full rounded-full bg-white/10 overflow-hidden" style={{ height: altura }}>
      <div className="h-full rounded-full transition-[width] duration-700"
        style={{ width: `${largura}%`, background: cor }} />
    </div>
  )
}

export default function Placar() {
  const [agora, setAgora] = useState(new Date())
  useEffect(() => {
    const t = setInterval(() => setAgora(new Date()), 30_000)
    return () => clearInterval(t)
  }, [])

  const hoje = new Date()
  const ini = new Date(hoje.getFullYear(), hoje.getMonth(), 1)
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
  const competencia = `${hoje.getFullYear()}-${String(hoje.getMonth() + 1).padStart(2, '0')}`

  const { data: barra } = useQuery<any>({
    queryKey: ['placar-barra'],
    queryFn: () => api.get('/home/barra-meta').then(r => r.data),
    refetchInterval: REFRESCO,
  })
  const { data: meta } = useQuery<any>({
    queryKey: ['placar-meta', competencia],
    queryFn: () => api.get(`/pedidos/meta?competencia=${competencia}`).then(r => r.data),
    refetchInterval: REFRESCO * 10,
  })
  const { data: canais } = useQuery<any>({
    queryKey: ['placar-canais', competencia],
    queryFn: () => api.get('/pedidos/dashboard/vendas-por-canal', {
      params: { data_inicio: iso(ini), data_fim: iso(hoje) },
    }).then(r => r.data),
    refetchInterval: REFRESCO,
  })
  // O quadro da logistica: quantas OVs em cada etapa, e quantas sairam hoje.
  // Mesma fonte do Painel Operacional — o placar nao recontata nada por conta
  // propria.
  // Previsão de faturamento: para onde o mês vai se nada mudar. Sem ela o
  // placar só diz onde estamos; com ela diz se o jeito que estamos andando
  // chega lá — que é a pergunta que o comercial faz olhando a parede.
  const { data: previsao } = useQuery<any>({
    queryKey: ['placar-previsao'],
    queryFn: () => api.get('/previsao/resumo').then(r => r.data),
    refetchInterval: REFRESCO * 5,
  })
  const { data: operacional } = useQuery<any>({
    queryKey: ['placar-operacional'],
    queryFn: () => api.get('/pedidos/dashboard/operacional').then(r => r.data),
    refetchInterval: REFRESCO,
  })
  const { data: clientes } = useQuery<any>({
    queryKey: ['placar-clientes', competencia],
    queryFn: () => api.get('/pedidos/dashboard/vendas-por-cliente', {
      params: { data_inicio: iso(ini), data_fim: iso(hoje) },
    }).then(r => r.data),
    refetchInterval: REFRESCO,
  })

  const realizado = Number(barra?.realizado || 0)
  const valorMeta = barra?.meta ? Number(barra.meta) : null
  const pct = Number(barra?.pct || 0)
  const ritmo = barra?.ritmo
  const dia = barra?.dia
  const corRitmo = RITMO_COR[ritmo?.status] || '#94a3b8'

  // Realizado por canal: a linha do produto manda, não o canal digitado — é a
  // mesma regra do Painel Comercial, e a licitação vem separada de lá.
  const porCanal: Record<string, number> = {}
  for (const c of (canais?.canais || [])) porCanal[c.canal] = Number(c.valor || 0)
  porCanal['LICITACAO'] = Number(canais?.licitacao?.valor || 0)

  const topClientes = (clientes?.clientes || clientes || []).slice?.(0, 6) || []

  return (
    <div className="min-h-screen bg-[#0b1220] text-white px-8 py-6 flex flex-col gap-6"
      style={{ fontFeatureSettings: '"tnum"' }}>

      {/* Cabeçalho */}
      <div className="flex items-end justify-between gap-6">
        <div>
          <p className="text-sky-400 text-sm font-semibold uppercase tracking-[0.2em]">MSB · Comercial</p>
          <h1 className="text-5xl font-black leading-none mt-1 capitalize">
            {MES_PT[hoje.getMonth()]} <span className="text-white/40">{hoje.getFullYear()}</span>
          </h1>
        </div>
        <div className="text-right">
          <p className="text-5xl font-black leading-none tabular-nums">
            {agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
          </p>
          <p className="text-white/40 text-sm mt-1">
            {ritmo ? `${ritmo.dias_uteis_restantes} dia(s) útil(eis) até o fim do mês` : ''}
          </p>
        </div>
      </div>

      {/* O número do mês */}
      <div className="rounded-3xl bg-white/5 border border-white/10 p-8">
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <p className="text-white/50 text-lg">Faturamento do mês</p>
            <p className="text-[5.5rem] font-black leading-[0.95] tracking-tight">{milhar(realizado)}</p>
            <p className="text-white/50 text-xl mt-1">
              {valorMeta ? <>meta {milhar(valorMeta)}</> : 'sem meta cadastrada para o mês'}
            </p>
          </div>
          {valorMeta && (
            <div className="text-right">
              <p className="text-[5.5rem] font-black leading-[0.95]" style={{ color: corRitmo }}>
                {pct.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%
              </p>
              <p className="text-2xl font-bold capitalize" style={{ color: corRitmo }}>{ritmo?.rotulo}</p>
              <p className="text-white/50 text-lg mt-0.5">
                {Number(barra?.falta || 0) > 0 ? <>faltam {milhar(barra.falta)}</> : 'meta batida 🎉'}
              </p>
            </div>
          )}
        </div>
        {valorMeta && (
          <div className="mt-6 relative">
            <Barra pct={pct} cor={corRitmo} altura={22} />
            {/* Onde deveríamos estar hoje. Sem esta marca, 60% não diz nada: pode
                ser ótimo no dia 12 e péssimo no dia 27. */}
            {ritmo?.pct_esperado != null && (
              <div className="absolute top-0 h-[22px] border-l-2 border-white/70"
                style={{ left: `${Math.min(100, ritmo.pct_esperado)}%` }}>
                <span className="absolute -top-6 -translate-x-1/2 text-xs text-white/60 whitespace-nowrap">
                  ritmo do dia {ritmo.pct_esperado.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 flex-1 min-h-0">
        {/* Hoje */}
        <div className="rounded-3xl bg-white/5 border border-white/10 p-6 flex flex-col">
          <p className="text-white/50 text-lg">Hoje</p>
          <p className="text-6xl font-black leading-none mt-1">{milhar(dia?.realizado || 0)}</p>
          <p className="text-white/50 text-lg mt-1">
            {dia?.nfs ? `${dia.nfs} nota(s) fiscal(is)` : 'nenhuma nota ainda'}
          </p>
          {dia?.alvo > 0 && (
            <div className="mt-5">
              <div className="flex justify-between text-base text-white/60 mb-1.5">
                <span>alvo do dia</span>
                <span className="font-bold text-white/80">{milhar(dia.alvo)}</span>
              </div>
              <Barra pct={Number(dia.pct || 0)} cor={Number(dia.pct || 0) >= 100 ? '#34d399' : '#38bdf8'} />
            </div>
          )}
          {dia && !dia.eh_dia_util && (
            <p className="text-white/40 text-sm mt-3">fim de semana — o alvo é dos dias úteis</p>
          )}
        </div>

        {/* Previsão do mês */}
        <div className="rounded-3xl bg-white/5 border border-white/10 p-6 flex flex-col">
          <p className="text-white/50 text-lg">Previsão do mês</p>
          {previsao?.mes?.previsao != null ? (
            <>
              <p className="text-6xl font-black leading-none mt-1">{milhar(previsao.mes.previsao)}</p>
              {previsao.mes.atingimento_previsto_pct != null && (
                <p className="text-xl font-bold mt-1"
                  style={{ color: previsao.mes.atingimento_previsto_pct >= 100 ? '#34d399'
                    : previsao.mes.atingimento_previsto_pct >= 90 ? '#fbbf24' : '#f87171' }}>
                  {previsao.mes.atingimento_previsto_pct.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}% da meta
                </p>
              )}
              {/* Garantido = o que já faturou + o que está no kanban. É o piso:
                  o resto da previsão depende de negócio que ainda pode não sair. */}
              {previsao.mes.garantido != null && (
                <p className="text-white/50 text-base mt-3">
                  garantido <strong className="text-white/80">{milhar(previsao.mes.garantido)}</strong>
                  <span className="block text-sm text-white/35 mt-0.5">faturado + o que está no quadro</span>
                </p>
              )}
            </>
          ) : (
            <p className="text-white/30 text-lg mt-2">sem dados de previsão</p>
          )}
        </div>

        {/* Por linha */}
        <div className="rounded-3xl bg-white/5 border border-white/10 p-6">
          <p className="text-white/50 text-lg mb-3">Por linha</p>
          <div className="space-y-3.5">
            {CANAIS.map(c => {
              const feito = porCanal[c.key] || 0
              const alvo = Number(meta?.por_canal?.[c.key] || 0)
              const p = alvo ? (feito / alvo) * 100 : 0
              return (
                <div key={c.key}>
                  <div className="flex items-baseline justify-between gap-3">
                    <span className="text-xl font-bold">{c.label}</span>
                    <span className="text-2xl font-black tabular-nums">{milhar(feito)}</span>
                    {alvo > 0 && (
                      <span className="text-lg tabular-nums w-20 text-right"
                        style={{ color: p >= 100 ? '#34d399' : p >= 70 ? '#fbbf24' : '#f87171' }}>
                        {p.toLocaleString('pt-BR', { maximumFractionDigits: 0 })}%
                      </span>
                    )}
                    {!alvo && <span className="text-sm text-white/30 w-20 text-right">sem meta</span>}
                  </div>
                  <div className="mt-1.5"><Barra pct={p} cor={c.cor} altura={10} /></div>
                  {alvo > 0 && (
                    <p className="text-sm text-white/40 mt-1">
                      meta {milhar(alvo)} · {feito >= alvo ? 'batida' : `faltam ${milhar(alvo - feito)}`}
                    </p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* A logística, em uma faixa. O comercial é o assunto do placar, mas quem
          passa no corredor também precisa ver onde o pedido está parado — e a
          etapa com fila é a conversa que o quadro provoca. */}
      {operacional && (
        <div className="rounded-3xl bg-white/5 border border-white/10 px-6 py-4">
          <div className="flex flex-wrap items-baseline gap-x-8 gap-y-2 mb-3">
            <p className="text-white/50 text-lg">No quadro da logística</p>
            <p className="text-3xl font-black tabular-nums">
              {operacional.total_pedidos} <span className="text-lg font-medium text-white/50">OVs em andamento</span>
            </p>
            <p className="text-3xl font-black tabular-nums text-emerald-400">
              {operacional.expedidos_hoje} <span className="text-lg font-medium text-white/50">expedidas hoje</span>
            </p>
            {operacional.atrasados > 0 && (
              <p className="text-3xl font-black tabular-nums text-red-400">
                {operacional.atrasados} <span className="text-lg font-medium text-white/50">atrasadas</span>
              </p>
            )}
          </div>
          {/* Etapa por etapa, na ordem do kanban. Etapa vazia fica visível e
              apagada: o buraco na fila é informação — some a etapa, some a
              noção de por onde o pedido passa. */}
          <div className="grid grid-cols-6 lg:grid-cols-11 gap-2">
            {ORDEM_KANBAN.filter(st => st !== 'EXPEDIDO').map(st => {
              const linha = (operacional.por_status || []).find((x: any) => x.status === st)
              const qtd = linha?.quantidade || 0
              const atraso = linha?.atrasados || 0
              const cfg: any = (STATUS_CONFIG as any)[st] || {}
              return (
                <div key={st} className={`rounded-xl px-2 py-2 text-center ${qtd ? 'bg-white/10' : 'bg-white/[0.03]'}`}
                  title={cfg.descricao}>
                  <p className={`text-3xl font-black leading-none tabular-nums ${qtd ? '' : 'text-white/20'}`}>{qtd}</p>
                  <p className={`text-[11px] leading-tight mt-1 ${qtd ? 'text-white/60' : 'text-white/20'}`}>{cfg.label || st}</p>
                  {atraso > 0 && (
                    <p className="text-[11px] font-bold text-red-400 mt-0.5">{atraso} atrasada(s)</p>
                  )}
                </div>
              )
            })}
          </div>
        </div>
      )}

      {/* Quem está comprando */}
      {topClientes.length > 0 && (
        <div className="rounded-3xl bg-white/5 border border-white/10 px-6 py-4">
          <p className="text-white/50 text-base mb-2">Maiores clientes do mês</p>
          <div className="flex flex-wrap gap-x-8 gap-y-2">
            {topClientes.map((c: any, i: number) => (
              <div key={i} className="flex items-baseline gap-2">
                <span className="text-white/30 font-bold">{i + 1}</span>
                <span className="text-lg font-medium truncate max-w-[22ch]">{c.cliente || c.nome}</span>
                <span className="text-lg font-black tabular-nums text-sky-300">{milhar(c.valor)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      <p className="text-center text-white/25 text-sm">
        Vendas sem frete, sem transfer price e sem Esterilize — o mesmo escopo do Painel Comercial.
        Atualiza sozinho a cada minuto · {agora.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}
      </p>
    </div>
  )
}

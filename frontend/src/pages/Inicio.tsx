import { useQuery } from '@tanstack/react-query'
import { Link } from 'react-router-dom'
import {
  Package, DollarSign, Gavel, ArrowRight, AlertTriangle, Clock,
  TrendingDown, Boxes, FileText, CheckCircle2,
} from 'lucide-react'
import api from '../lib/api'
import { useAuthStore } from '../store/authStore'

interface Pendencia {
  chave: string
  titulo: string
  detalhe: string
  qtd: number
  para: string
  acao: string
  gravidade: 'ALTA' | 'MEDIA' | 'BAIXA'
}

// Os setores são os que o app realmente tem hoje (conferido contra o sidebar e
// as rotas). Esterilização tem páginas no repo mas nenhuma rota, então não entra
// aqui — atalho para tela inacessível é pior que atalho ausente.
const SETORES = [
  {
    to: '/dashboard',
    titulo: 'Operações',
    desc: 'Expedição, pallets, inventário e ocorrências',
    icone: Package,
    cor: 'text-sky-600 bg-sky-50',
    borda: 'hover:border-sky-300',
    atalhos: [
      { to: '/dashboard', label: 'Painel Operacional' },
      { to: '/expedicao', label: 'Expedição' },
      { to: '/pallets', label: 'Pallets' },
      { to: '/inventario', label: 'Inventário' },
      { to: '/ocorrencias', label: 'Ocorrências' },
      { to: '/indicadores', label: 'Indicadores' },
    ],
  },
  {
    to: '/comercial',
    titulo: 'Comercial',
    desc: 'Faturamento, metas, CRM e estoque',
    icone: DollarSign,
    cor: 'text-emerald-600 bg-emerald-50',
    borda: 'hover:border-emerald-300',
    atalhos: [
      { to: '/comercial', label: 'Painel Comercial' },
      { to: '/previsao', label: 'Previsão' },
      { to: '/crm', label: 'CRM' },
      { to: '/estoque', label: 'Estoque' },
    ],
  },
  {
    to: '/licitacoes',
    titulo: 'Licitações',
    desc: 'Triagem de demandas e contratos',
    icone: Gavel,
    cor: 'text-amber-600 bg-amber-50',
    borda: 'hover:border-amber-300',
    atalhos: [
      { to: '/licitacoes', label: 'Painel de demandas' },
      { to: '/licitacoes?aba=contratos', label: 'Contratos' },
    ],
  },
]

// Ícone por tipo de pendência — a chave vem do backend, então o mapa é explícito
// e o fallback cobre qualquer pendência nova que o backend passe a mandar.
const ICONE_PENDENCIA: Record<string, any> = {
  ovs_atrasadas: Clock,
  estoque_risco_multa: AlertTriangle,
  estoque_aguardando: Boxes,
  demandas_paradas: FileText,
  ocorrencias: AlertTriangle,
  ovs_liberadas: Package,
}
const ESTILO_GRAVIDADE = {
  ALTA: { ic: 'text-red-600 bg-red-50', acao: 'text-red-600 hover:text-red-700' },
  MEDIA: { ic: 'text-amber-600 bg-amber-50', acao: 'text-amber-600 hover:text-amber-700' },
  BAIXA: { ic: 'text-sky-600 bg-sky-50', acao: 'text-sky-600 hover:text-sky-700' },
}

export function Inicio() {
  const { usuario } = useAuthStore()
  const primeiroNome = (usuario?.nome || '').trim().split(' ')[0]

  const { data, isLoading } = useQuery<{ itens: Pendencia[] }>({
    queryKey: ['home-pendencias'],
    queryFn: () => api.get('/home/pendencias').then(r => r.data),
    refetchInterval: 60000,
  })
  const pendencias = data?.itens || []

  return (
    <div className="p-4 sm:p-6 space-y-6 max-w-5xl mx-auto">
      <div className="text-center pt-2">
        <p className="text-xs font-semibold uppercase tracking-widest text-cyan-700">MSB · Gestão Integrada</p>
        <h1 className="text-2xl sm:text-3xl font-bold text-gray-900 mt-1">
          Para qual área você vai hoje{primeiroNome ? `, ${primeiroNome}` : ''}?
        </h1>
        <p className="text-gray-500 text-sm mt-1">Escolha seu setor para ir direto ao painel.</p>
      </div>

      {/* Setores primeiro: é a pergunta da tela. As pendências vêm depois, como
          resposta a "e o que preciso olhar antes de entrar". */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        {SETORES.map(s => (
          <div key={s.to}
            className={`bg-white rounded-2xl border border-gray-100 shadow-sm p-5 flex flex-col transition-all hover:shadow ${s.borda}`}>
            <div className={`p-3 rounded-xl w-fit ${s.cor}`}><s.icone size={22} /></div>
            <h2 className="text-lg font-bold text-gray-900 mt-3">{s.titulo}</h2>
            <p className="text-sm text-gray-500 mt-0.5 flex-1">{s.desc}</p>
            <div className="flex flex-wrap gap-1.5 mt-3">
              {s.atalhos.map(a => (
                <Link key={a.to + a.label} to={a.to}
                  className="text-[11px] px-2 py-1 rounded-lg bg-gray-50 text-gray-600 hover:bg-gray-100 hover:text-gray-800 transition-colors">
                  {a.label}
                </Link>
              ))}
            </div>
            <Link to={s.to}
              className="mt-4 inline-flex items-center gap-1.5 text-sm font-semibold text-gray-700 hover:text-gray-900">
              Entrar <ArrowRight size={15} />
            </Link>
          </div>
        ))}
      </div>

      <div>
        <h2 className="text-sm font-bold text-gray-800 mb-3">Isto precisa de você agora</h2>
        <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-3 sm:p-4">
          {isLoading ? (
            <p className="text-sm text-gray-400 text-center py-8">Verificando pendências…</p>
          ) : pendencias.length === 0 ? (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <CheckCircle2 size={24} className="text-emerald-500" />
              <p className="text-sm text-gray-500">Nada pendente — tudo em dia por aqui.</p>
            </div>
          ) : (
            <div className="space-y-2">
              {pendencias.map(p => {
                const Icone = ICONE_PENDENCIA[p.chave] || (p.chave.startsWith('canal_') ? TrendingDown : AlertTriangle)
                const est = ESTILO_GRAVIDADE[p.gravidade] || ESTILO_GRAVIDADE.MEDIA
                return (
                  <Link key={p.chave} to={p.para}
                    className="group flex items-center gap-3 rounded-xl px-3 py-2.5 bg-gray-50/70 hover:bg-gray-100/80 transition-colors">
                    <div className={`p-2 rounded-lg shrink-0 ${est.ic}`}><Icone size={16} /></div>
                    {/* Sem truncate: no celular o título cortava justamente no
                        fim ("...risco de mul"), perdendo a palavra que importa. */}
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-gray-800">{p.titulo}</p>
                      <p className="text-xs text-gray-500">{p.detalhe}</p>
                    </div>
                    <span className={`text-xs font-semibold shrink-0 inline-flex items-center gap-1 ${est.acao}`}>
                      {/* A linha inteira é clicável, então no celular o rótulo
                          da ação sai e sobra largura para o texto. */}
                      <span className="hidden sm:inline">{p.acao}</span>
                      <ArrowRight size={13} className="group-hover:translate-x-0.5 transition-transform" />
                    </span>
                  </Link>
                )
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

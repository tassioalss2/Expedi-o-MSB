import { NavLink, Link, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'
import {
  LayoutDashboard, Package, ClipboardList, AlertTriangle,
  LogOut, Activity, Layers, Menu, X, BarChart2, ScanLine,
  DollarSign, Home, Users, Gavel, Handshake, TrendingUp, Boxes,
} from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { PERFIL_LABELS, type PerfilUsuario } from '../types'
import { BarraMeta } from './BarraMeta'
import { clsx } from 'clsx'

type NavItem = {
  to: string; label: string; icone: any
  /** Âncoras para as seções da página. Só aparecem quando o item está ativo —
   *  assim a sidebar em repouso fica na lista plana do design, sem perder os
   *  atalhos de dentro do Painel Comercial. */
  subs?: Array<{ hash: string; label: string }>
  /** Chave do contador vermelho, quando o item tem um. */
  badge?: 'expedicao' | 'ocorrencias'
}

const navOperacoes: NavItem[] = [
  { to: '/dashboard',  label: 'Painel Operacional', icone: LayoutDashboard },
  { to: '/expedicao',  label: 'Expedição',          icone: Package, badge: 'expedicao' },
  { to: '/pallets',    label: 'Pallets',            icone: Layers },
  { to: '/inventario', label: 'Inventário Contínuo',icone: ScanLine },
  { to: '/ocorrencias',label: 'Ocorrências',        icone: AlertTriangle, badge: 'ocorrencias' },
  { to: '/indicadores',label: 'Indicadores',        icone: Activity },
  { to: '/relatorios', label: 'Relatórios',         icone: BarChart2 },
]

const navComercial: NavItem[] = [
  {
    to: '/comercial', label: 'Painel Comercial', icone: DollarSign,
    subs: [
      { hash: '#meta', label: 'Meta do mês' },
      { hash: '#faturamento', label: 'Faturamento' },
      { hash: '#canais', label: 'Vendas por Canal' },
      { hash: '#clientes', label: 'Vendas por Cliente' },
      { hash: '#produtos', label: 'Vendas por Produto' },
    ],
  },
  { to: '/previsao', label: 'Previsão de Faturamento', icone: TrendingUp },
  { to: '/crm',      label: 'CRM',                     icone: Handshake },
  { to: '/estoque',  label: 'Estoque',                 icone: Boxes },
]

const navLicitacoes: NavItem[] = [
  { to: '/licitacoes', label: 'Licitações', icone: Gavel },
]

const navGeral: NavItem[] = [
  { to: '/cadastros',  label: 'Cadastros',          icone: ClipboardList },
]

/** Iniciais para o avatar: primeiro + último nome (Marina Rocha -> MR). */
function iniciais(nome?: string): string {
  const partes = (nome || '').trim().split(/\s+/).filter(Boolean)
  if (!partes.length) return '?'
  const ini = partes[0][0] + (partes.length > 1 ? partes[partes.length - 1][0] : '')
  return ini.toUpperCase()
}

/** Cargo legível. Reusa PERFIL_LABELS (fonte única) em vez de repetir o mapa —
 *  o rodapé mostrava o enum cru ("COMERCIAL"). */
function cargo(perfil?: string): string {
  return PERFIL_LABELS[perfil as PerfilUsuario] || perfil || ''
}

// Paleta da sidebar (spec de design). Fica junta aqui em vez de espalhada em
// classes arbitrárias do Tailwind, para um ajuste de tom ser um lugar só.
const C = {
  borda: '#dbe6ea',
  ativoFundo: '#e3f0f4',
  ativoTexto: '#2c6679',
  icone: '#818286',
  label: '#51606b',
  grupo: '#a8b4ba',
  hover: '#f2f8fa',
  badge: '#c0584e',
  avatar: '#56A4BB',
  nome: '#2b3a42',
  bordaRodape: '#eaf1f3',
}

export function Layout() {
  const { usuario, logout } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [sidebarAberto, setSidebarAberto] = useState(false)

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const navGeralFiltrado: NavItem[] = [
    ...navGeral,
    ...(usuario?.perfil === 'ADMIN'
      ? [{ to: '/usuarios', label: 'Gestão de Usuários', icone: Users }]
      : []),
  ]

  const fecharSidebar = () => setSidebarAberto(false)

  // Badge: OVs novas em LIBERADO aguardando expedição
  const { data: ovsPendentes = [] } = useQuery({
    queryKey: ['ovs-liberado-count'],
    queryFn: () => api.get('/pedidos', { params: { status: 'LIBERADO' } }).then(r => r.data),
    refetchInterval: 30000,
  })
  // Badge: ocorrências ainda sem tratativa.
  const { data: ocorrenciasAbertas = [] } = useQuery({
    queryKey: ['ocorrencias-abertas-count'],
    queryFn: () => api.get('/ocorrencias', { params: { status: 'ABERTA' } }).then(r => r.data),
    refetchInterval: 60000,
  })
  const badges: Record<string, number> = {
    expedicao: (ovsPendentes as any[]).length,
    ocorrencias: (ocorrenciasAbertas as any[]).length,
  }

  /** Um item de menu. Estilo inline nos tokens da spec — o Tailwind não tem
   *  esses tons, e classes arbitrárias repetidas em 4 estados ficariam ilegíveis. */
  const Item = ({ item }: { item: NavItem }) => {
    const Icone = item.icone
    const qtd = item.badge ? badges[item.badge] : 0
    return (
      <div>
        <NavLink
          to={item.to}
          end={item.to !== '/expedicao'}
          onClick={fecharSidebar}
          style={({ isActive }) => ({
            backgroundColor: isActive ? C.ativoFundo : undefined,
            color: isActive ? C.ativoTexto : C.label,
            fontWeight: isActive ? 600 : 500,
          })}
          // O fundo do ativo vem por style (inline vence a classe), então o hover
          // só pinta os inativos — sem precisar de estado em JS.
          className="flex items-center gap-3 rounded-[10px] px-3 py-2.5 text-sm transition-colors hover:bg-[#f2f8fa]"
        >
          {({ isActive }: any) => (
            <>
              <Icone size={18} style={{ color: isActive ? C.ativoTexto : C.icone }} className="shrink-0" />
              <span className="flex-1 truncate">{item.label}</span>
              {qtd > 0 && (
                <span className="shrink-0 text-white font-bold rounded-full"
                  style={{ backgroundColor: C.badge, fontSize: '10.5px', padding: '2px 7px' }}>
                  {qtd > 99 ? '99+' : qtd}
                </span>
              )}
            </>
          )}
        </NavLink>

        {/* Âncoras da página, só com o item ativo (ver comentário em NavItem). */}
        {item.subs && location.pathname === item.to && (
          <div className="mt-0.5 mb-1 ml-[30px] space-y-0.5">
            {item.subs.map(s => {
              const ativo = location.hash === s.hash
              return (
                <Link
                  key={s.hash}
                  to={`${item.to}${s.hash}`}
                  onClick={fecharSidebar}
                  className="block rounded-lg px-3 py-1.5 text-[13px] transition-colors"
                  style={{ color: ativo ? C.ativoTexto : C.grupo, fontWeight: ativo ? 600 : 500 }}
                >
                  {s.label}
                </Link>
              )
            })}
          </div>
        )}
      </div>
    )
  }

  const Grupo = ({ titulo, itens }: { titulo: string; itens: NavItem[] }) => (
    <div style={{ marginTop: 18 }}>
      <p className="px-3 pb-1.5 uppercase"
        style={{ fontSize: '10.5px', letterSpacing: '0.09em', color: C.grupo, fontWeight: 600 }}>
        {titulo}
      </p>
      <div className="space-y-0.5">
        {itens.map(i => <Item key={i.to} item={i} />)}
      </div>
    </div>
  )

  return (
    <div className="flex h-screen bg-gray-50">

      {/* Overlay escuro no mobile quando sidebar aberto */}
      {sidebarAberto && (
        <div
          className="fixed inset-0 bg-black/50 z-20 lg:hidden"
          onClick={fecharSidebar}
        />
      )}

      {/* Sidebar */}
      <aside
        className={clsx(
          'fixed lg:static inset-y-0 left-0 z-30 w-64 bg-white flex flex-col transition-transform duration-300',
          sidebarAberto ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
        )}
        style={{ borderRight: `1px solid ${C.borda}` }}
      >
        {/* Logo + botão fechar no mobile */}
        <div className="px-4 py-3 flex items-center justify-between"
          style={{ borderBottom: `1px solid ${C.bordaRodape}` }}>
          <div className="flex flex-col gap-0.5">
            <img
              src="/msb-logo.png"
              alt="MSB — Medical System do Brasil"
              className="h-8 w-auto object-contain"
            />
            <p className="text-[10px] uppercase" style={{ letterSpacing: '0.09em', color: C.grupo, fontWeight: 600 }}>
              Gestão Comercial &amp; Logística
            </p>
          </div>
          <button
            onClick={fecharSidebar}
            className="lg:hidden p-1"
            style={{ color: C.grupo }}
          >
            <X size={20} />
          </button>
        </div>

        <nav className="flex-1 px-3 pb-3 overflow-y-auto">
          {/* Início: isolado no topo, sem label de grupo. */}
          <div style={{ marginTop: 12 }}>
            <Item item={{ to: '/', label: 'Início', icone: Home }} />
          </div>

          <Grupo titulo="Operações" itens={navOperacoes} />
          <Grupo titulo="Comercial" itens={navComercial} />
          <Grupo titulo="Licitações" itens={navLicitacoes} />
          {navGeralFiltrado.length > 0 && <Grupo titulo="Geral" itens={navGeralFiltrado} />}
        </nav>

        {/* Rodapé: identidade + sair. */}
        <div className="px-3 py-3" style={{ borderTop: `1px solid ${C.bordaRodape}` }}>
          <div className="flex items-center gap-3 px-1">
            <div className="w-9 h-9 rounded-full flex items-center justify-center text-white shrink-0"
              style={{ backgroundColor: C.avatar, fontSize: '12px', fontWeight: 700 }}>
              {iniciais(usuario?.nome)}
            </div>
            <div className="flex-1 min-w-0">
              <p className="truncate" style={{ fontSize: '13px', fontWeight: 600, color: C.nome }}>
                {usuario?.nome}
              </p>
              <p className="truncate" style={{ fontSize: '11px', color: C.icone }}>
                {cargo(usuario?.perfil)}
              </p>
            </div>
            <button
              onClick={handleLogout}
              title="Sair"
              aria-label="Sair"
              className="p-1.5 rounded-lg shrink-0 transition-colors hover:bg-[#f2f8fa]"
              style={{ color: C.grupo }}
            >
              <LogOut size={18} />
            </button>
          </div>
        </div>
      </aside>

      {/* Conteúdo principal. O overflow fica só no container da página (abaixo),
          para a barra de meta não rolar junto com o conteúdo. */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Topbar mobile com botão hamburguer */}
        <div className="lg:hidden flex items-center gap-3 px-4 py-3 bg-gray-900 text-white shrink-0">
          <button
            onClick={() => setSidebarAberto(true)}
            className="p-1 hover:bg-gray-700 rounded"
          >
            <Menu size={22} />
          </button>
          <img
            src="/msb-logo.png"
            alt="MSB"
            className="h-7 w-auto object-contain brightness-0 invert"
          />
        </div>

        {/* Meta do mês — fixa acima de qualquer tela: dá para saber como está o
            faturamento sem sair de onde se está trabalhando. */}
        <BarraMeta />

        {/* Página */}
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  )
}

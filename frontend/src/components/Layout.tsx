import { NavLink, Link, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'
import {
  LayoutDashboard, Package, ClipboardList, AlertTriangle,
  LogOut, Activity, Layers, Menu, X, BarChart2, ScanLine,
  DollarSign, Home, Users, Gavel, Handshake, TrendingUp,
} from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { clsx } from 'clsx'

type NavItem = {
  to: string; label: string; icone: any
  subs?: Array<{ hash: string; label: string }>
}

const navLogistica: NavItem[] = [
  { to: '/dashboard',  label: 'Painel Operacional', icone: LayoutDashboard },
  { to: '/expedicao',  label: 'Expedição',          icone: Package },
  { to: '/pallets',    label: 'Pallets',            icone: Layers },
  { to: '/inventario', label: 'Inventário Contínuo',icone: ScanLine },
  { to: '/ocorrencias',label: 'Ocorrências',        icone: AlertTriangle },
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
]

const navGeral = [
  { to: '/cadastros',  label: 'Cadastros',          icone: ClipboardList },
]

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
  const badgeExpedicao = (ovsPendentes as any[]).length

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
      <aside className={clsx(
        'fixed lg:static inset-y-0 left-0 z-30 w-64 bg-gray-900 text-white flex flex-col transition-transform duration-300',
        sidebarAberto ? 'translate-x-0' : '-translate-x-full lg:translate-x-0'
      )}>
        {/* Logo + botão fechar no mobile */}
        <div className="px-4 py-3 border-b border-gray-700 flex items-center justify-between">
          <div className="flex flex-col gap-0.5">
            <img
              src="/msb-logo.png"
              alt="MSB — Medical System do Brasil"
              className="h-8 w-auto object-contain brightness-0 invert"
            />
            <p className="text-gray-400 text-[10px] tracking-widest uppercase">Gestão Comercial & Logística</p>
          </div>
          <button
            onClick={fecharSidebar}
            className="lg:hidden text-gray-400 hover:text-white p-1"
          >
            <X size={20} />
          </button>
        </div>

        {/* Nav — seções Logística e Comercial */}
        <nav className="flex-1 p-3 overflow-y-auto">
          <div className="mb-4 space-y-1">
            <NavLink
              to="/"
              end
              onClick={fecharSidebar}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors',
                  isActive ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                )
              }
            >
              <Home size={18} />
              <span className="flex-1">Visão Geral</span>
            </NavLink>
          </div>
          {[{ titulo: 'Logística', itens: navLogistica }, { titulo: 'Comercial', itens: navComercial }].map((grupo) => (
            <div key={grupo.titulo} className="mb-4">
              <p className="px-3 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-widest text-gray-500">
                {grupo.titulo}
              </p>
              <div className="space-y-1">
                {grupo.itens.map(({ to, label, icone: Icone, subs }) => (
                  <div key={to}>
                    <NavLink
                      to={to}
                      end={to !== '/expedicao'}
                      onClick={fecharSidebar}
                      className={({ isActive }) =>
                        clsx(
                          'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors',
                          isActive
                            ? 'bg-blue-600 text-white'
                            : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                        )
                      }
                    >
                      <Icone size={18} />
                      <span className="flex-1">{label}</span>
                      {to === '/expedicao' && badgeExpedicao > 0 && (
                        <span className="bg-red-500 text-white text-xs font-bold px-1.5 py-0.5 rounded-full min-w-[20px] text-center">
                          {badgeExpedicao > 99 ? '99+' : badgeExpedicao}
                        </span>
                      )}
                    </NavLink>
                    {subs && (
                      <div className="mt-0.5 mb-1 ml-4 pl-3 border-l border-gray-700 space-y-0.5">
                        {subs.map((s) => {
                          const ativo = location.pathname === to && location.hash === s.hash
                          return (
                            <Link
                              key={s.hash}
                              to={`${to}${s.hash}`}
                              onClick={fecharSidebar}
                              className={clsx(
                                'block px-3 py-1.5 rounded-lg text-[13px] transition-colors',
                                ativo ? 'text-white bg-gray-800' : 'text-gray-400 hover:text-white hover:bg-gray-800'
                              )}
                            >
                              {s.label}
                            </Link>
                          )
                        })}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          ))}

          {/* Licitações + CRM — fora do Comercial, logo abaixo dele */}
          <div className="mb-4 space-y-1">
            <NavLink
              to="/licitacoes"
              end
              onClick={fecharSidebar}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors',
                  isActive ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                )
              }
            >
              <Gavel size={18} />
              <span className="flex-1">Licitações</span>
            </NavLink>
            <NavLink
              to="/crm"
              end
              onClick={fecharSidebar}
              className={({ isActive }) =>
                clsx(
                  'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors',
                  isActive ? 'bg-blue-600 text-white' : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                )
              }
            >
              <Handshake size={18} />
              <span className="flex-1">CRM</span>
            </NavLink>
          </div>

          {navGeralFiltrado.length > 0 && (
            <div className="pt-2 border-t border-gray-800">
              <div className="space-y-1 mt-2">
                {navGeralFiltrado.map(({ to, label, icone: Icone }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end
                    onClick={fecharSidebar}
                    className={({ isActive }) =>
                      clsx(
                        'flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors',
                        isActive
                          ? 'bg-blue-600 text-white'
                          : 'text-gray-300 hover:bg-gray-800 hover:text-white'
                      )
                    }
                  >
                    <Icone size={18} />
                    <span className="flex-1">{label}</span>
                  </NavLink>
                ))}
              </div>
            </div>
          )}
        </nav>

        {/* Usuário */}
        <div className="p-3 border-t border-gray-700">
          <div className="flex items-center gap-2 px-3 py-2 mb-1">
            <div className="w-8 h-8 bg-blue-600 rounded-full flex items-center justify-center text-xs font-bold">
              {usuario?.nome.charAt(0).toUpperCase()}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{usuario?.nome}</p>
              <p className="text-xs text-gray-400 truncate">{usuario?.perfil}</p>
            </div>
          </div>
          <button
            onClick={handleLogout}
            className="w-full flex items-center gap-2 px-3 py-2 text-sm text-gray-400 hover:text-red-400 hover:bg-gray-800 rounded-lg transition-colors"
          >
            <LogOut size={16} />
            Sair
          </button>
        </div>
      </aside>

      {/* Conteúdo principal */}
      <main className="flex-1 overflow-auto flex flex-col min-w-0">
        {/* Topbar mobile com botão hamburguer */}
        <div className="lg:hidden flex items-center gap-3 px-4 py-3 bg-gray-900 text-white sticky top-0 z-10">
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

        {/* Página */}
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  )
}

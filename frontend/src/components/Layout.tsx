import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom'
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import api from '../lib/api'
import {
  LayoutDashboard, Package, ClipboardList, AlertTriangle,
  Users, LogOut, Activity, Layers, Menu, X, BarChart2, ScanLine,
  FlaskConical, ChevronDown, ChevronRight,
} from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { clsx } from 'clsx'

const nav = [
  { to: '/dashboard',  label: 'Dashboard',         icone: LayoutDashboard },
  { to: '/expedicao',  label: 'Expedição',          icone: Package },
  { to: '/pallets',    label: 'Pallets',            icone: Layers },
  { to: '/inventario', label: 'Inventário Contínuo',icone: ScanLine },
  { to: '/ocorrencias',label: 'Ocorrências',        icone: AlertTriangle },
  { to: '/indicadores',label: 'Indicadores',        icone: Activity },
  { to: '/relatorios', label: 'Relatórios',         icone: BarChart2 },
  { to: '/cadastros',  label: 'Cadastros',          icone: ClipboardList },
  { to: '/admin',      label: 'Usuários',           icone: Users, perfis: ['ADMIN', 'GERENCIA'] },
]

const navEsterilizacao = [
  { to: '/esterilizacao',            label: 'Painel do Operador' },
  { to: '/esterilizacao/planejamento', label: 'Planejamento' },
  { to: '/esterilizacao/dashboard',  label: 'Dashboard' },
  { to: '/esterilizacao/produtos',   label: 'Produtos Estéreis' },
]

export function Layout() {
  const { usuario, logout } = useAuthStore()
  const navigate = useNavigate()
  const location = useLocation()
  const [sidebarAberto, setSidebarAberto] = useState(false)
  const [esterilizacaoAberto, setEsterilizacaoAberto] = useState(
    location.pathname.startsWith('/esterilizacao')
  )

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const navFiltrado = nav.filter(
    (item) => !item.perfis || item.perfis.includes(usuario?.perfil || '')
  )

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
            <p className="text-gray-400 text-[10px] tracking-widest uppercase">Controle de Expedição</p>
          </div>
          <button
            onClick={fecharSidebar}
            className="lg:hidden text-gray-400 hover:text-white p-1"
          >
            <X size={20} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {navFiltrado.map(({ to, label, icone: Icone }) => (
            <NavLink
              key={to}
              to={to}
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
          ))}

          {/* Módulo Esterilização — submenu */}
          <div>
            <button
              onClick={() => setEsterilizacaoAberto(!esterilizacaoAberto)}
              className={clsx(
                'w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm transition-colors',
                location.pathname.startsWith('/esterilizacao')
                  ? 'bg-blue-600 text-white'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white'
              )}
            >
              <FlaskConical size={18} />
              <span className="flex-1 text-left">Esterilização</span>
              {esterilizacaoAberto ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            </button>
            {esterilizacaoAberto && (
              <div className="ml-4 mt-1 space-y-0.5 border-l border-gray-700 pl-3">
                {navEsterilizacao.map(({ to, label }) => (
                  <NavLink
                    key={to}
                    to={to}
                    end
                    onClick={fecharSidebar}
                    className={({ isActive }) =>
                      clsx(
                        'flex items-center px-2 py-2 rounded-lg text-xs transition-colors',
                        isActive
                          ? 'bg-blue-500/40 text-white font-semibold'
                          : 'text-gray-400 hover:bg-gray-800 hover:text-white'
                      )
                    }
                  >
                    {label}
                  </NavLink>
                ))}
              </div>
            )}
          </div>
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

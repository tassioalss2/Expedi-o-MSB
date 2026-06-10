import { NavLink, Outlet, useNavigate } from 'react-router-dom'
import { useState } from 'react'
import {
  LayoutDashboard, Package, ClipboardList, AlertTriangle,
  Users, LogOut, Activity, Layers, Menu, X,
} from 'lucide-react'
import { useAuthStore } from '../store/authStore'
import { clsx } from 'clsx'

const nav = [
  { to: '/dashboard',  label: 'Dashboard',  icone: LayoutDashboard },
  { to: '/expedicao',  label: 'Expedição',  icone: Package },
  { to: '/pallets',    label: 'Pallets',    icone: Layers },
  { to: '/ocorrencias',label: 'Ocorrências',icone: AlertTriangle },
  { to: '/indicadores',label: 'Indicadores',icone: Activity },
  { to: '/cadastros',  label: 'Cadastros',  icone: ClipboardList },
  { to: '/admin',      label: 'Usuários',   icone: Users, perfis: ['ADMIN', 'GERENCIA'] },
]

export function Layout() {
  const { usuario, logout } = useAuthStore()
  const navigate = useNavigate()
  const [sidebarAberto, setSidebarAberto] = useState(false)

  const handleLogout = () => {
    logout()
    navigate('/login')
  }

  const navFiltrado = nav.filter(
    (item) => !item.perfis || item.perfis.includes(usuario?.perfil || '')
  )

  const fecharSidebar = () => setSidebarAberto(false)

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
        <div className="p-5 border-b border-gray-700 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-blue-500 rounded-lg flex items-center justify-center font-bold text-sm">
              ACE
            </div>
            <div>
              <p className="font-bold text-sm leading-tight">ACE-MSB</p>
              <p className="text-gray-400 text-xs">Controle de Expedição</p>
            </div>
          </div>
          <button
            onClick={fecharSidebar}
            className="lg:hidden text-gray-400 hover:text-white p-1"
          >
            <X size={20} />
          </button>
        </div>

        {/* Nav */}
        <nav className="flex-1 p-3 space-y-1">
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
              {label}
            </NavLink>
          ))}
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
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-blue-500 rounded flex items-center justify-center font-bold text-xs">
              ACE
            </div>
            <span className="font-semibold text-sm">ACE-MSB</span>
          </div>
        </div>

        {/* Página */}
        <div className="flex-1 overflow-auto">
          <Outlet />
        </div>
      </main>
    </div>
  )
}

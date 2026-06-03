import { create } from 'zustand'
import type { Usuario } from '../types'

interface AuthState {
  usuario: Usuario | null
  token: string | null
  setAuth: (usuario: Usuario, token: string) => void
  logout: () => void
  isAuthenticated: () => boolean
}

export const useAuthStore = create<AuthState>((set, get) => ({
  usuario: { id: '00000000-0000-0000-0000-000000000001', nome: 'Administrador', email: 'admin@msb.com.br', perfil: 'ADMIN' as any, ativo: true },
  token: 'dev-token',

  setAuth: (usuario, token) => {
    localStorage.setItem('ace_token', token)
    localStorage.setItem('ace_usuario', JSON.stringify(usuario))
    set({ usuario, token })
  },

  logout: () => {
    localStorage.removeItem('ace_token')
    localStorage.removeItem('ace_usuario')
    set({ usuario: null, token: null })
  },

  isAuthenticated: () => !!get().token && !!get().usuario,
}))

import { create } from 'zustand'
import type { Usuario } from '../types'

interface AuthState {
  usuario: Usuario | null
  token: string | null
  setAuth: (usuario: Usuario, token: string) => void
  logout: () => void
  isAuthenticated: () => boolean
}

// Hidrata a partir do localStorage (mantém a sessão ao recarregar a página).
function carregarUsuario(): Usuario | null {
  try {
    const raw = localStorage.getItem('ace_usuario')
    return raw ? (JSON.parse(raw) as Usuario) : null
  } catch {
    return null
  }
}

export const useAuthStore = create<AuthState>((set, get) => ({
  usuario: carregarUsuario(),
  token: localStorage.getItem('ace_token'),

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

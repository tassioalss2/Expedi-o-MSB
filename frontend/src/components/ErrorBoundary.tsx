import { Component, type ReactNode } from 'react'

interface Props { children: ReactNode }
interface State { erro: Error | null }

/** Evita "tela branca": captura erros de render e mostra um aviso com opção de recarregar. */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { erro: null }

  static getDerivedStateFromError(erro: Error): State {
    return { erro }
  }

  componentDidCatch(erro: Error, info: unknown) {
    console.error('[ErrorBoundary]', erro, info)
  }

  render() {
    if (this.state.erro) {
      return (
        <div className="min-h-screen flex items-center justify-center p-6 bg-gray-50">
          <div className="max-w-md w-full bg-white rounded-2xl shadow-sm border border-gray-100 p-6 text-center">
            <div className="text-4xl mb-3">⚠️</div>
            <h1 className="text-lg font-bold text-gray-800">Algo deu errado nesta tela</h1>
            <p className="text-sm text-gray-500 mt-1">
              Ocorreu um erro inesperado. Você pode recarregar a página e tentar novamente.
            </p>
            <pre className="mt-3 text-[11px] text-left text-gray-400 bg-gray-50 rounded-lg p-2 overflow-x-auto">
              {this.state.erro.message}
            </pre>
            <div className="mt-4 flex gap-2 justify-center">
              <button
                onClick={() => this.setState({ erro: null })}
                className="px-4 py-2 text-sm border rounded-lg text-gray-600 hover:bg-gray-50"
              >
                Tentar de novo
              </button>
              <button
                onClick={() => window.location.reload()}
                className="px-4 py-2 text-sm bg-blue-600 hover:bg-blue-500 text-white rounded-lg font-medium"
              >
                Recarregar
              </button>
            </div>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

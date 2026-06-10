import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { Toaster } from 'react-hot-toast'
import { Layout } from './components/Layout'
import { Login } from './pages/Login'
import { Dashboard } from './pages/Dashboard'
import { Expedicao } from './pages/Expedicao'
import { PedidoDetalhe } from './pages/PedidoDetalhe'
import { Ocorrencias } from './pages/Ocorrencias'
import { Indicadores } from './pages/Indicadores'
import { Cadastros } from './pages/Cadastros'
import { NovoPedido } from './pages/NovoPedido'
import { Pallets } from './pages/Pallets'
import { RelatorioColeta } from './pages/RelatorioColeta'
import { RelatorioColetasRealizadas } from './pages/RelatorioColetasRealizadas'
import { Relatorios } from './pages/Relatorios'
import { useAuthStore } from './store/authStore'

const qc = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 10_000 } },
})

function PrivateRoute({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

export default function App() {
  return (
    <QueryClientProvider client={qc}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<Login />} />

          {/* Relatórios — sem sidebar */}
          <Route path="/relatorio/coleta" element={<RelatorioColeta />} />
          <Route path="/relatorio/coletas-realizadas" element={<RelatorioColetasRealizadas />} />

          {/* App principal — com sidebar */}
          <Route
            path="/"
            element={
              <PrivateRoute>
                <Layout />
              </PrivateRoute>
            }
          >
            <Route index element={<Navigate to="/dashboard" replace />} />
            <Route path="dashboard" element={<Dashboard />} />
            <Route path="expedicao" element={<Expedicao />} />
            <Route path="expedicao/novo" element={<NovoPedido />} />
            <Route path="expedicao/:id" element={<PedidoDetalhe />} />
            <Route path="pallets" element={<Pallets />} />
            <Route path="ocorrencias" element={<Ocorrencias />} />
            <Route path="indicadores" element={<Indicadores />} />
            <Route path="relatorios" element={<Relatorios />} />
            <Route path="cadastros" element={<Cadastros />} />
          </Route>

          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster position="top-right" />
    </QueryClientProvider>
  )
}

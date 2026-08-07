import { useState } from 'react'
import { useSearchParams, useNavigate } from 'react-router-dom'
import { LayoutDashboard, Target, Users, CalendarClock, Handshake, Building2, FileText, Send } from 'lucide-react'
import { CrmDashboard } from './CrmDashboard'
import { CrmPipeline } from './CrmPipeline'
import { CrmContatos } from './CrmContatos'
import { CrmAtividades } from './CrmAtividades'
import { CrmEmpresas } from './CrmEmpresas'
import { CrmCotacoes } from './CrmCotacoes'

// A aba "Repasse p/ OV" saiu. Ela era uma fila intermediária entre o ganho e a OV,
// e mandava operações de vendas cadastrar a OV de vendas que sequer tinham material
// — 3 das 4 da fila estavam esperando PRODUÇÃO, não uma pessoa.
//
// Ganhar agora tem três saídas diretas, sem fila no meio:
//   estoque completo  → OV em "Dados da OV", no kanban da Expedição
//   falta + parcial   → OV em "Dados da OV" só com o disponível; saldo vira pendência
//   falta + aguardar  → nenhuma OV; a venda fica na coluna Pendência de estoque
type Aba = 'dashboard' | 'funil' | 'empresas' | 'cotacoes' | 'contatos' | 'atividades'

const ABAS: { key: Aba; label: string; icone: any }[] = [
  { key: 'dashboard', label: 'Dashboard', icone: LayoutDashboard },
  { key: 'funil', label: 'Funil de vendas', icone: Target },
  { key: 'empresas', label: 'Empresas', icone: Building2 },
  { key: 'cotacoes', label: 'Cotações', icone: FileText },
  { key: 'contatos', label: 'Contatos', icone: Users },
  { key: 'atividades', label: 'Atividades', icone: CalendarClock },
]

export function Crm() {
  const navigate = useNavigate()
  // `?aba=` continua deep-linkando (links antigos para `repasse` caem no funil,
  // que é onde a venda ganha aparece agora).
  const [params] = useSearchParams()
  const abaInicial = params.get('aba') as Aba | null
  const [aba, setAba] = useState<Aba>(abaInicial && ABAS.some(a => a.key === abaInicial) ? abaInicial : 'funil')

  return (
    <div className="p-4 lg:p-6 max-w-[1500px] mx-auto space-y-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2"><Handshake size={20} /> CRM</h1>
          <p className="text-sm text-gray-400">Gestão comercial de ponta a ponta — funil de oportunidades, contatos, atividades e previsão.</p>
        </div>
        <button
          onClick={() => navigate('/expedicao/outbound')}
          className="flex items-center gap-2 px-3 py-2 border border-blue-300 text-blue-700 rounded-lg text-sm hover:bg-blue-50 whitespace-nowrap"
        >
          <Send size={16} />
          Venda Outbound
        </button>
      </div>

      <div className="flex gap-1 border-b overflow-x-auto">
        {ABAS.map(({ key, label, icone: Icone }) => (
          <button key={key} onClick={() => setAba(key)}
            className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium border-b-2 -mb-px whitespace-nowrap transition ${
              aba === key ? 'border-blue-600 text-blue-700' : 'border-transparent text-gray-500 hover:text-gray-700'
            }`}>
            <Icone size={16} /> {label}
          </button>
        ))}
      </div>

      {aba === 'dashboard' && <CrmDashboard />}
      {aba === 'funil' && <CrmPipeline />}
      {aba === 'empresas' && <CrmEmpresas />}
      {aba === 'cotacoes' && <CrmCotacoes />}
      {aba === 'contatos' && <CrmContatos />}
      {aba === 'atividades' && <CrmAtividades />}
    </div>
  )
}

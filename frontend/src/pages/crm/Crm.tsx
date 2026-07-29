import { useState } from 'react'
import { LayoutDashboard, Target, Users, CalendarClock, Handshake, Sparkles, Building2, FileText } from 'lucide-react'
import { CrmDashboard } from './CrmDashboard'
import { CrmPipeline } from './CrmPipeline'
import { CrmContatos } from './CrmContatos'
import { CrmAtividades } from './CrmAtividades'
import { CrmEmpresas } from './CrmEmpresas'
import { CrmCotacoes } from './CrmCotacoes'
import { CrmInteligencia } from './CrmInteligencia'

type Aba = 'dashboard' | 'funil' | 'empresas' | 'cotacoes' | 'inteligencia' | 'contatos' | 'atividades'

const ABAS: { key: Aba; label: string; icone: any }[] = [
  { key: 'dashboard', label: 'Dashboard', icone: LayoutDashboard },
  { key: 'funil', label: 'Funil de vendas', icone: Target },
  { key: 'empresas', label: 'Empresas', icone: Building2 },
  { key: 'cotacoes', label: 'Cotações', icone: FileText },
  { key: 'inteligencia', label: 'Inteligência', icone: Sparkles },
  { key: 'contatos', label: 'Contatos', icone: Users },
  { key: 'atividades', label: 'Atividades', icone: CalendarClock },
]

export function Crm() {
  const [aba, setAba] = useState<Aba>('funil')

  return (
    <div className="p-4 lg:p-6 max-w-[1500px] mx-auto space-y-4">
      <div>
        <h1 className="text-xl font-bold text-gray-800 flex items-center gap-2"><Handshake size={20} /> CRM</h1>
        <p className="text-sm text-gray-400">Gestão comercial de ponta a ponta — funil de oportunidades, contatos, atividades e previsão.</p>
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
      {aba === 'inteligencia' && <CrmInteligencia />}
      {aba === 'contatos' && <CrmContatos />}
      {aba === 'atividades' && <CrmAtividades />}
    </div>
  )
}

import { useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { LayoutDashboard, Target, Users, CalendarClock, Handshake, Building2, FileText } from 'lucide-react'
import api from '../../lib/api'
import { CrmDashboard } from './CrmDashboard'
import { CrmPipeline } from './CrmPipeline'
import { CrmContatos } from './CrmContatos'
import { CrmAtividades } from './CrmAtividades'
import { CrmEmpresas } from './CrmEmpresas'
import { CrmCotacoes } from './CrmCotacoes'
import { CrmRepasse } from './CrmRepasse'

type Aba = 'dashboard' | 'funil' | 'empresas' | 'cotacoes' | 'repasse' | 'contatos' | 'atividades'

const ABAS: { key: Aba; label: string; icone: any }[] = [
  { key: 'dashboard', label: 'Dashboard', icone: LayoutDashboard },
  { key: 'funil', label: 'Funil de vendas', icone: Target },
  { key: 'empresas', label: 'Empresas', icone: Building2 },
  { key: 'cotacoes', label: 'Cotações', icone: FileText },
  // Fica logo depois de Cotações: é o passo seguinte do processo (ganhou → OV).
  { key: 'repasse', label: 'Repasse p/ OV', icone: Handshake },
  { key: 'contatos', label: 'Contatos', icone: Users },
  { key: 'atividades', label: 'Atividades', icone: CalendarClock },
]

export function Crm() {
  // `?aba=repasse` deep-linka aqui direto na fila — usado pelo card de ponte na
  // Expedição, para o clique não largar o usuário no Funil e obrigar a navegar.
  const [params] = useSearchParams()
  const abaInicial = params.get('aba') as Aba | null
  const [aba, setAba] = useState<Aba>(abaInicial && ABAS.some(a => a.key === abaInicial) ? abaInicial : 'funil')

  // Contador na aba: sem isso a fila de repasse fica escondida atrás de um
  // clique e volta a depender de alguém avisar por mensagem.
  const { data: repasses = [] } = useQuery<any[]>({
    queryKey: ['crm-repasses'],
    queryFn: () => api.get('/crm/repasses').then(r => r.data),
    refetchInterval: 120000,
  })
  const pendentes = repasses.filter(r => r.repasse_status === 'AGUARDANDO').length

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
            {key === 'repasse' && repasses.length > 0 && (
              <span className={`text-[10px] px-1.5 py-0.5 rounded-full font-semibold ${
                pendentes > 0 ? 'bg-amber-500 text-white' : 'bg-gray-200 text-gray-600'
              }`}>{repasses.length}</span>
            )}
          </button>
        ))}
      </div>

      {aba === 'dashboard' && <CrmDashboard />}
      {aba === 'funil' && <CrmPipeline />}
      {aba === 'empresas' && <CrmEmpresas />}
      {aba === 'cotacoes' && <CrmCotacoes />}
      {aba === 'repasse' && <CrmRepasse />}
      {aba === 'contatos' && <CrmContatos />}
      {aba === 'atividades' && <CrmAtividades />}
    </div>
  )
}

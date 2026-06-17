import api from './api'
import type {
  Carga,
  ProdutoEsteril,
  Apontamento,
  HistoricoCarga,
  SimulacaoCarga,
  DashboardEsterilizacao,
  TipoCaixa,
  StatusCarga,
  PrioridadeCarga,
  EtapaApontamento,
} from '../types/esterilizacao'

const BASE = '/esterilizacao'

// ── Produtos ─────────────────────────────────────────────────────────────────

export async function listarProdutos(params?: {
  familia?: string
  busca?: string
  ativo_only?: boolean
}): Promise<ProdutoEsteril[]> {
  const res = await api.get(`${BASE}/produtos`, { params })
  return res.data
}

export async function listarFamilias(): Promise<string[]> {
  const res = await api.get(`${BASE}/produtos/familias`)
  return res.data
}

export async function criarProduto(data: Partial<ProdutoEsteril>): Promise<ProdutoEsteril> {
  const res = await api.post(`${BASE}/produtos`, data)
  return res.data
}

export async function atualizarProduto(codigoSa: string, data: Partial<ProdutoEsteril>): Promise<ProdutoEsteril> {
  const res = await api.patch(`${BASE}/produtos/${codigoSa}`, data)
  return res.data
}

// ── Simulação ─────────────────────────────────────────────────────────────────

export async function simularCarga(itens: { codigo_sa: string; quantidade: number; tipo_caixa?: TipoCaixa }[]): Promise<SimulacaoCarga> {
  const res = await api.post(`${BASE}/simular`, { itens })
  return res.data
}

// ── Cargas ────────────────────────────────────────────────────────────────────

export interface FiltrosCargas {
  status?: string
  mes?: number
  ano?: number
  prioridade?: string
  atrasadas?: boolean
  data_saida_inicio?: string
  data_saida_fim?: string
}

export async function listarCargas(filtros?: FiltrosCargas): Promise<Carga[]> {
  const res = await api.get(`${BASE}/cargas`, { params: filtros })
  return res.data
}

export async function obterCarga(id: string): Promise<Carga> {
  const res = await api.get(`${BASE}/cargas/${id}`)
  return res.data
}

export interface CargaCreatePayload {
  data_saida_prevista: string
  prioridade: PrioridadeCarga
  data_inicio_planejada?: string
  hora_inicio_planejada?: string
  data_retorno_prevista?: string
  responsavel_planejamento?: string
  responsavel_operacao?: string
  observacao?: string
  itens: { codigo_sa: string; quantidade: number; tipo_caixa?: TipoCaixa; modelo_carga?: string; observacao?: string }[]
}

export async function criarCarga(data: CargaCreatePayload): Promise<Carga> {
  const res = await api.post(`${BASE}/cargas`, data)
  return res.data
}

export async function atualizarCarga(id: string, data: Partial<CargaCreatePayload> & { motivo_replanejamento?: string }): Promise<Carga> {
  const res = await api.patch(`${BASE}/cargas/${id}`, data)
  return res.data
}

export async function liberarCarga(id: string, responsavel: string): Promise<Carga> {
  const res = await api.post(`${BASE}/cargas/${id}/liberar`, { responsavel })
  return res.data
}

export async function alterarStatusCarga(id: string, novo_status: StatusCarga, observacao?: string): Promise<Carga> {
  const res = await api.patch(`${BASE}/cargas/${id}/status`, { novo_status, observacao })
  return res.data
}

export async function bloquearCarga(id: string, motivo: string): Promise<Carga> {
  const res = await api.post(`${BASE}/cargas/${id}/bloquear`, { motivo })
  return res.data
}

export async function registrarEnvio(id: string, data_saida_real: string, observacao?: string): Promise<Carga> {
  const res = await api.post(`${BASE}/cargas/${id}/enviar`, { data_saida_real, observacao })
  return res.data
}

export async function registrarRetorno(id: string, data_retorno_real: string, observacao?: string): Promise<Carga> {
  const res = await api.post(`${BASE}/cargas/${id}/retorno`, { data_retorno_real, observacao })
  return res.data
}

// ── Itens ─────────────────────────────────────────────────────────────────────

export async function adicionarItem(cargaId: string, item: { codigo_sa: string; quantidade: number; tipo_caixa?: TipoCaixa }): Promise<Carga> {
  const res = await api.post(`${BASE}/cargas/${cargaId}/itens`, item)
  return res.data
}

export async function removerItem(cargaId: string, itemId: string): Promise<Carga> {
  const res = await api.delete(`${BASE}/cargas/${cargaId}/itens/${itemId}`)
  return res.data
}

// ── Apontamentos ──────────────────────────────────────────────────────────────

export async function iniciarEtapa(cargaId: string, etapa: EtapaApontamento, operador: string): Promise<Apontamento> {
  const res = await api.post(`${BASE}/cargas/${cargaId}/apontamentos/iniciar`, { etapa, operador })
  return res.data
}

export async function concluirEtapa(cargaId: string, apontamentoId: string, data?: { observacao?: string; problema_reportado?: string }): Promise<Apontamento> {
  const res = await api.patch(`${BASE}/cargas/${cargaId}/apontamentos/${apontamentoId}/concluir`, data || {})
  return res.data
}

export async function listarApontamentos(cargaId: string): Promise<Apontamento[]> {
  const res = await api.get(`${BASE}/cargas/${cargaId}/apontamentos`)
  return res.data
}

// ── Histórico ─────────────────────────────────────────────────────────────────

export async function listarHistorico(cargaId: string): Promise<HistoricoCarga[]> {
  const res = await api.get(`${BASE}/cargas/${cargaId}/historico`)
  return res.data
}

// ── Dashboard ─────────────────────────────────────────────────────────────────

export async function obterDashboard(mes: number, ano: number): Promise<DashboardEsterilizacao> {
  const res = await api.get(`${BASE}/dashboard`, { params: { mes, ano } })
  return res.data
}

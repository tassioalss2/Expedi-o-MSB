from datetime import date, datetime, time
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, field_validator

from app.models.enums_esterilizacao import (
    EtapaApontamento,
    PrioridadeCarga,
    StatusCarga,
    TipoCaixa,
)


# ── Produto Estéril ───────────────────────────────────────────────────────────

class ProdutoEsterilCreate(BaseModel):
    codigo_sa: str
    codigo_pa: Optional[str] = None
    descricao: str
    familia: Optional[str] = None
    tipo_produto: Optional[str] = None
    qtd_padrao_cx_verde: Optional[int] = None
    qtd_padrao_cx_branca: Optional[int] = None
    qtd_padrao_cx_amarela: Optional[int] = None
    qtd_padrao_cx_vermelha: Optional[int] = None
    tipo_caixa_padrao: Optional[TipoCaixa] = None
    valor_unitario: float = 0
    tempo_producao_seg: int = 0
    tempo_separacao_seg: int = 0
    requer_esterilizacao: bool = True

    @field_validator("tempo_producao_seg", "tempo_separacao_seg")
    @classmethod
    def tempo_nao_negativo(cls, v: int) -> int:
        if v < 0:
            raise ValueError("Tempo não pode ser negativo")
        return v


class ProdutoEsterilOut(BaseModel):
    codigo_sa: str
    codigo_pa: Optional[str]
    descricao: str
    familia: Optional[str]
    tipo_produto: Optional[str]
    qtd_padrao_cx_verde: Optional[int]
    qtd_padrao_cx_branca: Optional[int]
    qtd_padrao_cx_amarela: Optional[int]
    qtd_padrao_cx_vermelha: Optional[int]
    tipo_caixa_padrao: Optional[str]
    valor_unitario: float
    tempo_producao_seg: int
    tempo_separacao_seg: int
    requer_esterilizacao: bool
    ativo: bool


class ProdutoEsterilUpdate(BaseModel):
    descricao: Optional[str] = None
    familia: Optional[str] = None
    tipo_produto: Optional[str] = None
    qtd_padrao_cx_verde: Optional[int] = None
    qtd_padrao_cx_branca: Optional[int] = None
    qtd_padrao_cx_amarela: Optional[int] = None
    qtd_padrao_cx_vermelha: Optional[int] = None
    tipo_caixa_padrao: Optional[TipoCaixa] = None
    valor_unitario: Optional[float] = None
    tempo_producao_seg: Optional[int] = None
    tempo_separacao_seg: Optional[int] = None
    ativo: Optional[bool] = None


# ── Item da Carga ─────────────────────────────────────────────────────────────

class ItemCargaCreate(BaseModel):
    codigo_sa: str
    quantidade: int
    tipo_caixa: Optional[TipoCaixa] = None
    modelo_carga: Optional[str] = None
    observacao: Optional[str] = None

    @field_validator("quantidade")
    @classmethod
    def qtd_positiva(cls, v: int) -> int:
        if v <= 0:
            raise ValueError("Quantidade deve ser maior que zero")
        return v


class ItemCargaOut(BaseModel):
    id: UUID
    id_carga: UUID
    codigo_sa: str
    codigo_pa: Optional[str]
    descricao_produto: Optional[str]
    familia: Optional[str]
    quantidade: int
    quantidade_por_caixa: Optional[int]
    tipo_caixa: Optional[str]
    quantidade_caixas: Optional[int]
    modelo_carga: Optional[str]
    valor_unitario: float
    valor_total: float
    tempo_producao_unitario_seg: int
    tempo_separacao_unitario_seg: int
    tempo_producao_total_min: int
    tempo_separacao_total_min: int
    tempo_total_min: int
    observacao: Optional[str]


# ── Carga ─────────────────────────────────────────────────────────────────────

class CargaCreate(BaseModel):
    data_saida_prevista: date
    prioridade: PrioridadeCarga = PrioridadeCarga.NORMAL
    data_inicio_planejada: Optional[date] = None
    hora_inicio_planejada: Optional[time] = None
    data_retorno_prevista: Optional[date] = None
    responsavel_planejamento: Optional[str] = None
    responsavel_operacao: Optional[str] = None
    observacao: Optional[str] = None
    itens: list[ItemCargaCreate] = []

    @field_validator("data_saida_prevista")
    @classmethod
    def data_saida_obrigatoria(cls, v: date) -> date:
        if v is None:
            raise ValueError("Data prevista de saída é obrigatória")
        return v

    @field_validator("itens")
    @classmethod
    def sem_itens_duplicados(cls, v: list) -> list:
        codigos = [i.codigo_sa for i in v]
        if len(codigos) != len(set(codigos)):
            raise ValueError("Não é permitido repetir o mesmo código SA na mesma carga")
        return v


class CargaUpdate(BaseModel):
    data_saida_prevista: Optional[date] = None
    data_inicio_planejada: Optional[date] = None
    hora_inicio_planejada: Optional[time] = None
    data_retorno_prevista: Optional[date] = None
    prioridade: Optional[PrioridadeCarga] = None
    responsavel_planejamento: Optional[str] = None
    responsavel_operacao: Optional[str] = None
    observacao: Optional[str] = None
    motivo_replanejamento: Optional[str] = None


class CargaOut(BaseModel):
    id: UUID
    numero_carga: str
    mes_referencia: Optional[int]
    semana_referencia: Optional[int]
    ano_referencia: int
    data_inicio_planejada: Optional[date]
    hora_inicio_planejada: Optional[str]
    data_saida_prevista: date
    data_saida_real: Optional[date]
    data_retorno_prevista: Optional[date]
    data_retorno_real: Optional[date]
    status: str
    prioridade: str
    responsavel_planejamento: Optional[str]
    responsavel_operacao: Optional[str]
    observacao: Optional[str]
    valor_total: float
    tempo_total_estimado_min: int
    tempo_total_real_min: Optional[int]
    quantidade_total_pecas: int
    quantidade_total_caixas: int
    motivo_bloqueio: Optional[str]
    motivo_replanejamento: Optional[str]
    atrasada: bool = False
    dias_para_saida: Optional[int] = None
    criado_em: datetime
    atualizado_em: datetime
    itens: list[ItemCargaOut] = []


class CargaListOut(BaseModel):
    id: UUID
    numero_carga: str
    status: str
    prioridade: str
    data_saida_prevista: date
    data_retorno_prevista: Optional[date]
    quantidade_total_pecas: int
    quantidade_total_caixas: int
    tempo_total_estimado_min: int
    valor_total: float
    responsavel_operacao: Optional[str]
    atrasada: bool
    dias_para_saida: Optional[int]
    familia_principal: Optional[str] = None
    criado_em: datetime


# ── Ações sobre a Carga ───────────────────────────────────────────────────────

class LiberarCargaRequest(BaseModel):
    responsavel: str


class AlterarStatusCargaRequest(BaseModel):
    novo_status: StatusCarga
    observacao: Optional[str] = None


class BloquearCargaRequest(BaseModel):
    motivo: str


class ReplanejamentoRequest(BaseModel):
    nova_data_saida: date
    justificativa: str
    nova_data_retorno: Optional[date] = None


class RegistrarEnvioRequest(BaseModel):
    data_saida_real: date
    observacao: Optional[str] = None


class RegistrarRetornoRequest(BaseModel):
    data_retorno_real: date
    observacao: Optional[str] = None


# ── Apontamento do Operador ───────────────────────────────────────────────────

class IniciarEtapaRequest(BaseModel):
    etapa: EtapaApontamento
    operador: str


class ConcluirEtapaRequest(BaseModel):
    observacao: Optional[str] = None
    problema_reportado: Optional[str] = None


class ApontamentoOut(BaseModel):
    id: UUID
    id_carga: UUID
    etapa: str
    operador: str
    data_inicio: datetime
    data_fim: Optional[datetime]
    duracao_real_min: Optional[int]
    status: str
    problema_reportado: Optional[str]
    observacao: Optional[str]


# ── Histórico ─────────────────────────────────────────────────────────────────

class HistoricoOut(BaseModel):
    id: UUID
    id_carga: UUID
    campo_alterado: str
    valor_anterior: Optional[str]
    valor_novo: Optional[str]
    usuario: str
    motivo: Optional[str]
    criado_em: datetime


# ── Simulação ─────────────────────────────────────────────────────────────────

class SimularItemRequest(BaseModel):
    codigo_sa: str
    quantidade: int
    tipo_caixa: Optional[TipoCaixa] = None


class SimulacaoItemOut(BaseModel):
    codigo_sa: str
    descricao: Optional[str]
    quantidade: int
    quantidade_por_caixa: int
    tipo_caixa: str
    quantidade_caixas: int
    tempo_producao_total_min: int
    tempo_separacao_total_min: int
    tempo_total_min: int
    valor_total: float


class SimularCargaRequest(BaseModel):
    itens: list[SimularItemRequest]


class SimulacaoCargaOut(BaseModel):
    itens: list[SimulacaoItemOut]
    total_pecas: int
    total_caixas: int
    total_tempo_producao_min: int
    total_tempo_separacao_min: int
    total_tempo_min: int
    total_valor: float
    dias_necessarios: float
    alertas: list[str] = []


# ── Dashboard ─────────────────────────────────────────────────────────────────

class DashboardEsterilizacaoOut(BaseModel):
    mes_referencia: int
    ano_referencia: int
    total_cargas: int
    planejadas: int
    liberadas: int
    em_producao: int
    em_separacao: int
    em_conferencia: int
    prontas: int
    enviadas: int
    retornadas: int
    atrasadas: int
    bloqueadas: int
    canceladas: int
    total_pecas_mes: int
    total_caixas_mes: int
    valor_total_mes: float
    aderencia_plan: float  # % cargas enviadas na data planejada
    tempo_medio_ciclo_min: Optional[float]

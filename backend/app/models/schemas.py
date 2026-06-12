from datetime import date, datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, EmailStr, field_validator

from app.models.enums import (
    DecisaoTratativa,
    PerfilUsuario,
    Prioridade,
    ResultadoConferencia,
    StatusOcorrencia,
    StatusPedido,
    TipoDivergencia,
    TipoFrete,
)


# ── Auth ──────────────────────────────────────────────────────────────────────

class LoginRequest(BaseModel):
    email: EmailStr
    senha: str


class TokenResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    usuario: "UsuarioOut"


# ── Usuário ───────────────────────────────────────────────────────────────────

class UsuarioCreate(BaseModel):
    nome: str
    email: EmailStr
    senha: str
    perfil: PerfilUsuario


class UsuarioOut(BaseModel):
    id: UUID
    nome: str
    email: str
    perfil: PerfilUsuario
    ativo: bool


class UsuarioUpdate(BaseModel):
    nome: Optional[str] = None
    perfil: Optional[PerfilUsuario] = None
    ativo: Optional[bool] = None


# ── Cliente ───────────────────────────────────────────────────────────────────

class ClienteCreate(BaseModel):
    codigo: str
    nome: str
    cnpj: Optional[str] = None
    contato: Optional[str] = None
    prioridade: int = 0


class ClienteOut(BaseModel):
    id: UUID
    codigo: str
    nome: str
    cnpj: Optional[str]
    contato: Optional[str]
    prioridade: int
    ativo: bool


# ── Transportadora ────────────────────────────────────────────────────────────

class TransportadoraCreate(BaseModel):
    nome: str
    cnpj: Optional[str] = None
    contato: Optional[str] = None
    sla_horas: int = 24


class TransportadoraOut(BaseModel):
    id: UUID
    nome: str
    cnpj: Optional[str]
    contato: Optional[str]
    sla_horas: int
    ativo: bool


# ── Produto / Lote ────────────────────────────────────────────────────────────

class ProdutoCreate(BaseModel):
    codigo: str
    descricao: str
    familia: Optional[str] = None
    unidade: str = "UN"


class ProdutoOut(BaseModel):
    id: UUID
    codigo: str
    descricao: str
    familia: Optional[str]
    unidade: str
    ativo: bool


class LoteCreate(BaseModel):
    produto_id: UUID
    numero_lote: str
    validade: Optional[date] = None
    quantidade_disp: float = 0


class LoteOut(BaseModel):
    id: UUID
    produto_id: UUID
    numero_lote: str
    validade: Optional[date]
    quantidade_disp: float


# ── Item do Pedido ────────────────────────────────────────────────────────────

class ItemPedidoCreate(BaseModel):
    produto_id: UUID
    lote_id: Optional[UUID] = None
    qtd_solicitada: float

    @field_validator("qtd_solicitada")
    @classmethod
    def qtd_positiva(cls, v: float) -> float:
        if v <= 0:
            raise ValueError("Quantidade deve ser maior que zero")
        return v


class ItemPedidoOut(BaseModel):
    id: UUID
    produto_id: UUID
    lote_id: Optional[UUID]
    qtd_solicitada: float
    qtd_separada: Optional[float]
    qtd_conferida: Optional[float]
    qtd_divergente: Optional[float]
    status_item: str
    produto: Optional[ProdutoOut] = None
    lote: Optional[LoteOut] = None


# ── Pedido ────────────────────────────────────────────────────────────────────

class PedidoCreate(BaseModel):
    numero_pedido: str
    cliente_id: UUID
    transportadora_id: Optional[UUID] = None
    tipo_frete: TipoFrete = TipoFrete.FOB
    local_entrega: Optional[str] = None
    data_prevista_entrega: date
    data_prevista_coleta: Optional[date] = None
    prioridade: Prioridade = Prioridade.NORMAL
    observacoes: Optional[str] = None
    itens: list[ItemPedidoCreate] = []


class PedidoOut(BaseModel):
    id: UUID
    numero_pedido: str
    cliente_id: UUID
    transportadora_id: Optional[UUID]
    status: StatusPedido
    prioridade: Prioridade
    data_prevista_entrega: date
    data_prevista_coleta: Optional[date]
    data_real_coleta: Optional[datetime]
    numero_nf: Optional[str]
    valor_nf: Optional[float]
    observacoes: Optional[str]
    criado_em: datetime
    atualizado_em: datetime
    atrasado: bool = False
    cliente: Optional[ClienteOut] = None
    transportadora: Optional[TransportadoraOut] = None
    itens: list[ItemPedidoOut] = []


class PedidoListOut(BaseModel):
    """Versão resumida para listagens — sem itens detalhados."""
    id: UUID
    numero_pedido: str
    status: StatusPedido
    prioridade: Prioridade
    data_prevista_entrega: date
    atrasado: bool
    cliente_nome: str
    transportadora_nome: Optional[str]


class AlterarStatusRequest(BaseModel):
    novo_status: StatusPedido
    observacao: Optional[str] = None


class BloquearPedidoRequest(BaseModel):
    motivo: str


# ── Separação ─────────────────────────────────────────────────────────────────

class IniciarSeparacaoRequest(BaseModel):
    pedido_id: UUID


class FinalizarSeparacaoRequest(BaseModel):
    itens: list[dict]  # [{item_id, qtd_separada, lote_id?}]
    observacao: Optional[str] = None


class SeparacaoOut(BaseModel):
    id: UUID
    pedido_id: UUID
    operador_id: UUID
    inicio: datetime
    fim: Optional[datetime]
    lead_time_min: Optional[float]
    observacao: Optional[str]


# ── Conferência ───────────────────────────────────────────────────────────────

class IniciarConferenciaRequest(BaseModel):
    pedido_id: UUID


class FinalizarConferenciaRequest(BaseModel):
    resultado: ResultadoConferencia
    itens_conferidos: list[dict]  # [{item_id, qtd_conferida, qtd_divergente?, tipo_divergencia?}]
    observacao: Optional[str] = None


class ConferenciaOut(BaseModel):
    id: UUID
    pedido_id: UUID
    conferente_id: UUID
    resultado: ResultadoConferencia
    inicio: datetime
    fim: Optional[datetime]
    lead_time_min: Optional[float]
    observacao: Optional[str]


# ── Tratativa de Divergência ──────────────────────────────────────────────────

class TratativaRequest(BaseModel):
    decisao: DecisaoTratativa
    justificativa: str
    retrabalho: bool = False
    tempo_retrabalho_min: Optional[int] = None


# ── Faturamento ───────────────────────────────────────────────────────────────

class FaturamentoRequest(BaseModel):
    numero_nf: str
    valor_nf: Optional[float] = None
    valor_produtos: Optional[float] = None  # CIF: valor só dos produtos
    valor_frete: Optional[float] = None     # CIF: custo do frete separado
    chave_nfe: Optional[str] = None
    data_prevista_entrega: Optional[date] = None  # permite corrigir a data ao registrar NF


# ── Coleta ────────────────────────────────────────────────────────────────────

class AgendarColetaRequest(BaseModel):
    transportadora_id: UUID
    data_prevista_coleta: date


class ConfirmarColetaRequest(BaseModel):
    data_real_coleta: datetime
    motorista: Optional[str] = None
    placa: Optional[str] = None
    protocolo: Optional[str] = None


# ── Ocorrência ────────────────────────────────────────────────────────────────

class OcorrenciaCreate(BaseModel):
    pedido_id: str  # Aceita UUID ou número da OV (ex: OV015406)
    tipo: str
    descricao: str


class OcorrenciaFechar(BaseModel):
    resolucao: str


class OcorrenciaOut(BaseModel):
    id: UUID
    pedido_id: UUID
    tipo: str
    descricao: str
    responsavel_id: UUID
    status: StatusOcorrencia
    resolucao: Optional[str]
    criado_em: datetime
    resolvido_em: Optional[datetime]


# ── Movimentação ──────────────────────────────────────────────────────────────

class MovimentacaoOut(BaseModel):
    id: UUID
    pedido_id: UUID
    status_anterior: Optional[str]
    status_novo: str
    usuario_id: UUID
    observacao: Optional[str]
    criado_em: datetime


# ── Dashboard ─────────────────────────────────────────────────────────────────

class ResumoStatusOut(BaseModel):
    status: str
    quantidade: int
    atrasados: int


class DashboardOperacionalOut(BaseModel):
    data: date
    total_pedidos: int
    expedidos_hoje: int
    atrasados: int
    por_status: list[ResumoStatusOut]
    ocorrencias_abertas: int


class IndicadoresOut(BaseModel):
    otif: float
    taxa_divergencia: float
    taxa_retrabalho: float
    lead_time_medio_horas: float
    pedidos_expedidos: int
    backlog: int
    aderencia_cutoff: Optional[float]


# ── Inventário Contínuo ───────────────────────────────────────

class InventarioItemCreate(BaseModel):
    codigo_item: str
    lote: str
    qtd_sistemico: float
    qtd_fisico: Optional[float] = None
    qtd_venda: float
    observacao: Optional[str] = None


class InventarioItemOut(BaseModel):
    id: UUID
    pedido_id: UUID
    codigo_item: str
    lote: str
    qtd_sistemico: float
    qtd_fisico: Optional[float]
    qtd_venda: float
    qtd_estoque: Optional[float]
    status_item: str
    observacao: Optional[str]


class InventarioSalvar(BaseModel):
    itens: list[InventarioItemCreate]


class VerificarFisicoRequest(BaseModel):
    itens_verificados: list[dict]  # [{id, qtd_fisico, status_item, observacao?}]


# ── Cubagem ───────────────────────────────────────────────────

class CubagemItemCreate(BaseModel):
    tipo_caixa_id: Optional[str] = None
    tipo_caixa_nome: str
    quantidade: int = 1


class CubagemCreate(BaseModel):
    peso_kg: Optional[float] = None
    altura_cm: Optional[float] = None
    largura_cm: Optional[float] = None
    comprimento_cm: Optional[float] = None
    num_caixas: Optional[int] = None
    observacao: Optional[str] = None
    itens: list[CubagemItemCreate] = []


class CubagemOut(BaseModel):
    id: UUID
    pedido_id: UUID
    peso_kg: Optional[float]
    altura_cm: Optional[float]
    largura_cm: Optional[float]
    comprimento_cm: Optional[float]
    num_caixas: Optional[int]
    observacao: Optional[str]
    criado_em: datetime


# ── Pallets ───────────────────────────────────────────────────

class PalletCreate(BaseModel):
    transportadora_id: UUID
    data_prevista_coleta: Optional[date] = None
    observacao: Optional[str] = None


class PalletOut(BaseModel):
    id: UUID
    codigo: str
    transportadora_id: Optional[UUID]
    status: str
    data_prevista_coleta: Optional[date]
    data_real_coleta: Optional[datetime]
    observacao: Optional[str]
    criado_em: datetime
    pedidos: list[dict] = []


class AdicionarPedidoPalletRequest(BaseModel):
    pedido_id: str  # Aceita número de OV (OV015374) ou UUID
    num_caixas: Optional[int] = None
    observacao: Optional[str] = None  # Transportadora para PLT-OUTROS


# ── Importação CSV ────────────────────────────────────────────────────────────

class ImportacaoResultado(BaseModel):
    total: int
    importados: int
    erros: list[dict]


TokenResponse.model_rebuild()

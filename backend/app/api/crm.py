from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from app.core.deps import get_current_user
from app.models.schemas import (
    AtividadeCreate,
    AtividadeUpdate,
    ContatoCreate,
    ContatoUpdate,
    ClienteRapidoCreate,
    CotacaoCreate,
    CotacaoUpdate,
    GerarOVRequest,
    LeadCreate,
    LeadUpdate,
    NotaCreate,
    OportunidadeCreate,
    OportunidadeUpdate,
    PerderRequest,
    UsuarioOut,
)
from app.services import (
    crm_cotacao_service,
    crm_inteligencia_service,
    crm_leads_service,
    crm_service,
)

router = APIRouter(prefix="/crm", tags=["crm"])


# ── Dashboard ────────────────────────────────────────────────────────────────────
@router.get("/dashboard")
def dashboard(_: UsuarioOut = Depends(get_current_user)):
    return crm_service.dashboard()


# ── Clientes (cadastro rápido pelo comercial) ──────────────────────────────────────
@router.post("/clientes", status_code=201)
def criar_cliente_rapido(payload: ClienteRapidoCreate, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.criar_cliente_rapido(payload.nome, payload.cnpj)


# ── Contatos ─────────────────────────────────────────────────────────────────────
@router.get("/contatos")
def listar_contatos(cliente_id: Optional[UUID] = Query(None), _: UsuarioOut = Depends(get_current_user)):
    return crm_service.listar_contatos(str(cliente_id) if cliente_id else None)


@router.post("/contatos", status_code=201)
def criar_contato(payload: ContatoCreate, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.criar_contato(payload)


@router.get("/contatos/{contato_id}")
def obter_contato(contato_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.obter_contato(str(contato_id))


@router.patch("/contatos/{contato_id}")
def atualizar_contato(contato_id: UUID, payload: ContatoUpdate, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.atualizar_contato(str(contato_id), payload)


@router.delete("/contatos/{contato_id}")
def excluir_contato(contato_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.excluir_contato(str(contato_id))


# ── Oportunidades ────────────────────────────────────────────────────────────────
@router.get("/oportunidades")
def listar_oportunidades(
    estagio: Optional[str] = Query(None),
    incluir_fechadas: bool = Query(False),
    _: UsuarioOut = Depends(get_current_user),
):
    return crm_service.listar_oportunidades(estagio, incluir_fechadas)


@router.post("/oportunidades", status_code=201)
def criar_oportunidade(payload: OportunidadeCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_service.criar_oportunidade(payload, usuario)


@router.get("/oportunidades/{oportunidade_id}")
def obter_oportunidade(oportunidade_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.obter_oportunidade(str(oportunidade_id))


@router.patch("/oportunidades/{oportunidade_id}")
def atualizar_oportunidade(
    oportunidade_id: UUID,
    payload: OportunidadeUpdate,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return crm_service.atualizar_oportunidade(str(oportunidade_id), payload, usuario)


@router.post("/oportunidades/{oportunidade_id}/ganhar")
def ganhar_oportunidade(oportunidade_id: UUID, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_service.ganhar_oportunidade(str(oportunidade_id), usuario)


@router.post("/oportunidades/{oportunidade_id}/perder")
def perder_oportunidade(oportunidade_id: UUID, payload: PerderRequest, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_service.perder_oportunidade(str(oportunidade_id), payload, usuario)


@router.post("/oportunidades/{oportunidade_id}/gerar-ov")
def gerar_ov(oportunidade_id: UUID, payload: GerarOVRequest, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_service.gerar_ov(str(oportunidade_id), payload, usuario)


@router.post("/oportunidades/{oportunidade_id}/notas")
def criar_nota(oportunidade_id: UUID, payload: NotaCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_service.criar_nota(str(oportunidade_id), payload, usuario)


@router.delete("/oportunidades/{oportunidade_id}")
def excluir_oportunidade(oportunidade_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.excluir_oportunidade(str(oportunidade_id))


# ── Atividades ───────────────────────────────────────────────────────────────────
@router.get("/atividades")
def listar_atividades(
    escopo: str = Query("abertas"),
    oportunidade_id: Optional[UUID] = Query(None),
    _: UsuarioOut = Depends(get_current_user),
):
    return crm_service.listar_atividades(escopo, str(oportunidade_id) if oportunidade_id else None)


@router.post("/atividades", status_code=201)
def criar_atividade(payload: AtividadeCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_service.criar_atividade(payload, usuario)


@router.patch("/atividades/{atividade_id}")
def atualizar_atividade(atividade_id: UUID, payload: AtividadeUpdate, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.atualizar_atividade(str(atividade_id), payload)


@router.post("/atividades/{atividade_id}/concluir")
def concluir_atividade(
    atividade_id: UUID,
    concluida: bool = Query(True),
    _: UsuarioOut = Depends(get_current_user),
):
    return crm_service.concluir_atividade(str(atividade_id), concluida)


@router.delete("/atividades/{atividade_id}")
def excluir_atividade(atividade_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_service.excluir_atividade(str(atividade_id))


# ── Leads ────────────────────────────────────────────────────────────────────────
@router.get("/leads")
def listar_leads(status: Optional[str] = Query(None), _: UsuarioOut = Depends(get_current_user)):
    return crm_leads_service.listar_leads(status)


@router.post("/leads", status_code=201)
def criar_lead(payload: LeadCreate, _: UsuarioOut = Depends(get_current_user)):
    return crm_leads_service.criar_lead(payload)


@router.get("/leads/{lead_id}")
def obter_lead(lead_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_leads_service.obter_lead(str(lead_id))


@router.patch("/leads/{lead_id}")
def atualizar_lead(lead_id: UUID, payload: LeadUpdate, _: UsuarioOut = Depends(get_current_user)):
    return crm_leads_service.atualizar_lead(str(lead_id), payload)


@router.post("/leads/{lead_id}/converter")
def converter_lead(lead_id: UUID, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_leads_service.converter_lead(str(lead_id), usuario)


@router.delete("/leads/{lead_id}")
def excluir_lead(lead_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_leads_service.excluir_lead(str(lead_id))


# ── Cotações ─────────────────────────────────────────────────────────────────────
@router.get("/cotacoes")
def listar_cotacoes(status: Optional[str] = Query(None), _: UsuarioOut = Depends(get_current_user)):
    return crm_cotacao_service.listar_cotacoes(status)


@router.post("/cotacoes", status_code=201)
def criar_cotacao(payload: CotacaoCreate, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_cotacao_service.criar_cotacao(payload, usuario)


@router.get("/cotacoes/{cotacao_id}")
def obter_cotacao(cotacao_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_cotacao_service.obter_cotacao(str(cotacao_id))


@router.patch("/cotacoes/{cotacao_id}")
def atualizar_cotacao(cotacao_id: UUID, payload: CotacaoUpdate, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_cotacao_service.atualizar_cotacao(str(cotacao_id), payload, usuario)


@router.post("/cotacoes/{cotacao_id}/gerar-ov", status_code=201)
def gerar_ov_cotacao(cotacao_id: UUID, payload: GerarOVRequest, usuario: UsuarioOut = Depends(get_current_user)):
    return crm_cotacao_service.gerar_ov(str(cotacao_id), payload, usuario)


@router.delete("/cotacoes/{cotacao_id}")
def excluir_cotacao(cotacao_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return crm_cotacao_service.excluir_cotacao(str(cotacao_id))


# ── Inteligência de mercado ──────────────────────────────────────────────────────
@router.get("/inteligencia")
def inteligencia(dias_inatividade: int = Query(90), _: UsuarioOut = Depends(get_current_user)):
    return crm_inteligencia_service.dashboard_inteligencia(dias_inatividade)

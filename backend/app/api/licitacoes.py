from uuid import UUID

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app.core.deps import get_current_user
from app.models.schemas import (
    ConsumoEmpenhoCreate,
    DemandaConcluir,
    DemandaCreate,
    DemandaUpdate,
    EmpenhoCreate,
    EntregaVendaDiretaCreate,
    UsuarioOut,
)
from app.services import licitacao_demanda_service, licitacao_service

router = APIRouter(prefix="/licitacoes", tags=["licitacoes"])


@router.get("/empenhos")
def listar_empenhos(_: UsuarioOut = Depends(get_current_user)):
    return licitacao_service.listar_empenhos()


@router.post("/empenhos", status_code=201)
def criar_empenho(payload: EmpenhoCreate, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_service.criar_empenho(payload)


@router.get("/empenhos/{empenho_id}")
def obter_empenho(empenho_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_service.obter_empenho(str(empenho_id))


@router.post("/empenhos/{empenho_id}/consumo", status_code=201)
def registrar_consumo(
    empenho_id: UUID,
    payload: ConsumoEmpenhoCreate,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return licitacao_service.registrar_consumo(str(empenho_id), payload, usuario)


@router.post("/empenhos/{empenho_id}/entrega", status_code=201)
def registrar_entrega(
    empenho_id: UUID,
    payload: EntregaVendaDiretaCreate,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return licitacao_service.registrar_entrega(str(empenho_id), payload, usuario)


@router.delete("/empenhos/{empenho_id}")
def excluir_empenho(empenho_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_service.excluir_empenho(str(empenho_id))


# ── Painel de demandas (triagem Kanban) ─────────────────────────────────────────

@router.get("/demandas")
def listar_demandas(_: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.listar_demandas()


@router.post("/demandas", status_code=201)
def criar_demanda(payload: DemandaCreate, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.criar_demanda(payload)


@router.get("/demandas/{demanda_id}")
def obter_demanda(demanda_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.obter_demanda(str(demanda_id))


@router.patch("/demandas/{demanda_id}")
def atualizar_demanda(demanda_id: UUID, payload: DemandaUpdate, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.atualizar_demanda(str(demanda_id), payload)


@router.post("/demandas/{demanda_id}/concluir")
def concluir_demanda(
    demanda_id: UUID,
    payload: DemandaConcluir,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return licitacao_demanda_service.concluir_demanda(str(demanda_id), payload, usuario)


class VincularOVRequest(BaseModel):
    numero_pedido: str


@router.post("/demandas/{demanda_id}/vincular-ov")
def vincular_ov(demanda_id: UUID, payload: VincularOVRequest, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.vincular_ov(str(demanda_id), payload.numero_pedido)


@router.delete("/demandas/{demanda_id}")
def excluir_demanda(demanda_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_demanda_service.excluir_demanda(str(demanda_id))

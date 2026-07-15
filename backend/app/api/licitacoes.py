from uuid import UUID

from fastapi import APIRouter, Depends

from app.core.deps import get_current_user
from app.models.schemas import ConsumoEmpenhoCreate, EmpenhoCreate, UsuarioOut
from app.services import licitacao_service

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


@router.delete("/empenhos/{empenho_id}")
def excluir_empenho(empenho_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return licitacao_service.excluir_empenho(str(empenho_id))

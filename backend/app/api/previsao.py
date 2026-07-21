from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query

from app.core.deps import get_current_user
from app.models.schemas import (
    PrevisaoNegocioCreate,
    PrevisaoNegocioUpdate,
    UsuarioOut,
)
from app.services import previsao_service

router = APIRouter(prefix="/previsao", tags=["previsao"])


@router.get("/resumo")
def resumo(_: UsuarioOut = Depends(get_current_user)):
    return previsao_service.resumo()


@router.get("/negocios")
def listar_negocios(status: Optional[str] = Query(None), _: UsuarioOut = Depends(get_current_user)):
    return previsao_service.listar_negocios(status)


@router.post("/negocios")
def criar_negocio(payload: PrevisaoNegocioCreate, _: UsuarioOut = Depends(get_current_user)):
    return previsao_service.criar_negocio(payload)


@router.put("/negocios/{negocio_id}")
def atualizar_negocio(negocio_id: UUID, payload: PrevisaoNegocioUpdate, _: UsuarioOut = Depends(get_current_user)):
    return previsao_service.atualizar_negocio(str(negocio_id), payload)


@router.delete("/negocios/{negocio_id}")
def remover_negocio(negocio_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return previsao_service.remover_negocio(str(negocio_id))

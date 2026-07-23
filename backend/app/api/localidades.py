from fastapi import APIRouter, Depends

from app.core.deps import get_current_user
from app.models.schemas import UsuarioOut
from app.services import localidades_service

router = APIRouter(prefix="/localidades", tags=["localidades"])


@router.get("/estados")
def estados(_: UsuarioOut = Depends(get_current_user)):
    return localidades_service.listar_estados()


@router.get("/municipios")
def municipios(uf: str, _: UsuarioOut = Depends(get_current_user)):
    return localidades_service.listar_municipios(uf)

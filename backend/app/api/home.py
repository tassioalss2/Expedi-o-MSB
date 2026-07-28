from fastapi import APIRouter, Depends

from app.core.deps import get_current_user
from app.models.schemas import UsuarioOut
from app.services import home_service

router = APIRouter(prefix="/home", tags=["home"])


@router.get("/barra-meta")
def barra_meta(_: UsuarioOut = Depends(get_current_user)):
    """Faturamento do mês vs meta, para a barra fixa no topo de todas as telas.

    Separado de /home/pendencias de propósito: esta roda em toda navegação, então
    é a consulta mais barata possível."""
    return home_service.barra_meta()


@router.get("/pendencias")
def pendencias(_: UsuarioOut = Depends(get_current_user)):
    """O que precisa de ação agora — só itens com contagem > 0."""
    return home_service.pendencias()

from fastapi import APIRouter, Depends

from app.core.deps import get_current_user
from app.models.schemas import UsuarioOut
from app.services import estoque_service

router = APIRouter(prefix="/estoque", tags=["estoque"])


@router.get("")
def listar(_: UsuarioOut = Depends(get_current_user)):
    """Estoque disponível por item (foto do PCP de hoje − OVs comprometidas).

    Sincroniza a foto do PCP se ainda não houver a de hoje — a primeira abertura
    do dia atualiza para todo mundo."""
    return estoque_service.listar()


@router.post("/sincronizar")
def sincronizar(_: UsuarioOut = Depends(get_current_user)):
    """Força a sincronização com o app do PCP (botão 'Sincronizar agora'), para
    quando o PCP publica a planilha depois de alguém já ter aberto a tela."""
    return estoque_service.sincronizar(forcar=True)


@router.get("/{codigo}/comprometido")
def comprometido_detalhe(codigo: str, _: UsuarioOut = Depends(get_current_user)):
    """As OVs por trás do número de 'comprometido' de um item — clicar na coluna
    do estoque abre isto, para auditar de onde vem a conta."""
    return estoque_service.comprometido_detalhe(codigo)

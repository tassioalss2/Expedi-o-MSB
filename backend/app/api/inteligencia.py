"""Inteligência de mercado e estratégia comercial.

Router próprio, fora do /crm: o conteúdo não depende do funil (depende do
faturamento faturado, do custo e do estoque) e o público é a diretoria.
"""
from fastapi import APIRouter, Depends, Query

from app.core.deps import get_current_user
from app.models.schemas import UsuarioOut
from app.services import inteligencia_service

router = APIRouter(prefix="/inteligencia", tags=["Inteligência"])


@router.get("")
def dashboard(janela_dias: int = Query(30, ge=7, le=180),
              _: UsuarioOut = Depends(get_current_user)):
    """Painel completo: estratégia por linha, rentabilidade, carteira e produtos.

    `janela_dias` é o tamanho dos DOIS períodos comparados nos blocos
    operacionais (atual x anterior). Não afeta os blocos históricos, que sempre
    usam os 19 meses da base do D365.
    """
    return inteligencia_service.dashboard_inteligencia(janela_dias)


@router.get("/estrategias")
def estrategias(_: UsuarioOut = Depends(get_current_user)):
    """Só o plano por linha — endpoint separado para quem quer apenas isso
    (resumo, e-mail para a diretoria) sem pagar o custo do painel inteiro."""
    from app.core.database import get_service_db
    return inteligencia_service.estrategias(get_service_db())

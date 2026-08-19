"""Endpoints da integração com o D365 — diagnóstico e descoberta.

Tudo aqui é SÓ LEITURA e restrito a ADMIN. Não são telas de operação: são as
ferramentas para descobrir o que este ambiente do D365 expõe e para responder
"por que não está funcionando" sem abrir log do Render.

O catálogo de entidades do F&O muda com a versão e com os módulos habilitados.
Em vez de chutar nomes no código e colher 404 que parece falta de permissão, a
gente pergunta ao ambiente.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.deps import require_perfil
from app.models.schemas import UsuarioOut
from app.services import d365_service

router = APIRouter(prefix="/d365", tags=["d365"])

# require_perfil() sem argumento = só ADMIN (a função já concede ADMIN sempre).
somente_admin = require_perfil()


@router.get("/status")
def status(_: UsuarioOut = Depends(somente_admin)):
    """Configuração presente, token do Entra ID e leitura no D365 — separados.

    Separados de propósito: cada um falha por um motivo diferente e se corrige em
    lugar diferente (variável de ambiente, registro no Entra ID, cadastro do app
    dentro do D365). Nenhum segredo é devolvido.
    """
    return d365_service.diagnostico()


@router.get("/entidades")
def entidades(busca: Optional[str] = Query(None, description="Filtra pelo nome, ex.: 'SalesOrder'"),
              _: UsuarioOut = Depends(somente_admin)):
    """Entidades OData que este ambiente expõe."""
    try:
        nomes = d365_service.entidades(busca)
    except d365_service.D365Indisponivel as e:
        raise HTTPException(status_code=503, detail=str(e))
    return {"busca": busca, "quantidade": len(nomes), "entidades": nomes}


@router.get("/entidades/{entidade}/campos")
def campos(entidade: str, _: UsuarioOut = Depends(somente_admin)):
    """Campos de uma entidade, com o tipo — do catálogo, não de amostra.

    Do catálogo porque campo nulo em todas as linhas da amostra simplesmente não
    apareceria, e a gente concluiria que não existe.
    """
    try:
        lista = d365_service.campos(entidade)
    except d365_service.D365Indisponivel as e:
        raise HTTPException(status_code=503, detail=str(e))
    if not lista:
        raise HTTPException(status_code=404,
                            detail=f"Entidade '{entidade}' não existe neste ambiente. "
                                   f"Use /d365/entidades?busca= para achar o nome certo.")
    return {"entidade": entidade, "quantidade": len(lista), "campos": lista}


@router.get("/amostra/{entidade}")
def amostra(entidade: str,
            top: int = Query(5, ge=1, le=100),
            select: Optional[str] = Query(None, description="Campos separados por vírgula"),
            filtro: Optional[str] = Query(None, description="$filter do OData"),
            cross_company: bool = Query(False),
            _: UsuarioOut = Depends(somente_admin)):
    """Algumas linhas de uma entidade, para conferir formato e conteúdo.

    Teto de 100 linhas: isto é para inspecionar, não para carregar dado. Carga de
    verdade vai em serviço próprio, com `$select` e filtro pensados.
    """
    try:
        linhas = d365_service.listar(
            entidade,
            select=[c.strip() for c in select.split(",") if c.strip()] if select else None,
            filtro=filtro, top=top, cross_company=cross_company)
    except d365_service.D365Indisponivel as e:
        raise HTTPException(status_code=503, detail=str(e))
    return {"entidade": entidade, "quantidade": len(linhas), "linhas": linhas}

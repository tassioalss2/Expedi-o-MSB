# -*- coding: utf-8 -*-
"""As cargas do Portal MSB, trazidas para o ACE.

O Kanban está migrando para o Portal. A conferência da fatura da
transportadora depende de ter a nossa carga do lado do CT-e — estas rotas são
o que mantém essa carga aqui depois que o Kanban sair.
"""
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.deps import get_current_user
from app.models.schemas import UsuarioOut
from app.services import portal_msb_service

router = APIRouter(prefix="/portal", tags=["Portal MSB"])


@router.get("/previa")
def previa(_: UsuarioOut = Depends(get_current_user)):
    """O que a importação traria, sem gravar nada.

    Existe para a primeira vez e para toda vez que o Portal mudar: ver antes
    de escrever é o que separa importar de sobrescrever.
    """
    try:
        return portal_msb_service.previa()
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.post("/importar")
def importar(usuario: UsuarioOut = Depends(get_current_user)):
    """Lê o Portal e atualiza o espelho das cargas."""
    try:
        return portal_msb_service.importar(usuario)
    except ValueError as e:
        raise HTTPException(status_code=502, detail=str(e))


@router.get("/cargas")
def cargas(
    busca: Optional[str] = None,
    status: Optional[str] = None,
    limite: int = Query(200, le=1000),
    _: UsuarioOut = Depends(get_current_user),
):
    """O espelho como ele está, mais recente primeiro."""
    from app.core.database import get_service_db
    db = get_service_db()
    q = db.table("cargas_portal").select(
        "carga_id, numero_ov, cliente_nome, cidade, uf, numero_nf, valor_nf, "
        "itens, peso_kg, status, fase, etapa_ov, deposito, transportadora, "
        "tipo_frete, tipo_frete_portal, envio_em, expedido_em, entrega_prevista, "
        "importado_em")
    if status:
        q = q.eq("status", status)
    if busca:
        alvo = busca.strip()
        # OV, NF, carga ou cliente — quem procura tem um desses na mão.
        q = q.or_("numero_ov.ilike.%{0}%,numero_nf.ilike.%{0}%,"
                  "carga_id.ilike.%{0}%,cliente_nome.ilike.%{0}%".format(alvo))
    return q.order("envio_em", desc=True).limit(limite).execute().data

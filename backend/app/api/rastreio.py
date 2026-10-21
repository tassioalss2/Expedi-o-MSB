# -*- coding: utf-8 -*-
"""Rastreio das entregas CIF: o que a equipe apura todo dia vira registro."""
from datetime import date
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel

from app.core.deps import get_current_user
from app.models.schemas import UsuarioOut
from app.services import rastreio_service

router = APIRouter(prefix="/rastreio", tags=["rastreio"])


class EventoIn(BaseModel):
    situacao: str
    ocorrido_em: Optional[str] = None
    fonte: Optional[str] = None
    descricao: Optional[str] = None
    recebedor: Optional[str] = None
    documento_recebedor: Optional[str] = None
    nova_previsao: Optional[date] = None


@router.get("")
def painel(
    desde: Optional[str] = None,
    ate: Optional[str] = None,
    transportadora: Optional[str] = None,
    _: UsuarioOut = Depends(get_current_user),
):
    """As cargas CIF em rota, separadas pelo que cada uma exige."""
    return rastreio_service.painel(
        desde=date.fromisoformat(desde) if desde else None,
        ate=date.fromisoformat(ate) if ate else None,
        transportadora=transportadora,
    )


@router.get("/{pedido_id}")
def historico(pedido_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    return {"eventos": rastreio_service.historico(str(pedido_id))}


@router.post("/{pedido_id}")
def lancar(pedido_id: UUID, dados: EventoIn, usuario: UsuarioOut = Depends(get_current_user)):
    try:
        evento = rastreio_service.lancar(
            str(pedido_id),
            {**dados.model_dump(),
             "nova_previsao": dados.nova_previsao.isoformat() if dados.nova_previsao else None},
            getattr(usuario, "id", None))
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc))
    return evento


@router.delete("/evento/{evento_id}")
def apagar(evento_id: UUID, _: UsuarioOut = Depends(get_current_user)):
    rastreio_service.apagar(str(evento_id))
    return {"ok": True}

# -*- coding: utf-8 -*-
"""Passagem das transportadoras na MSB, lida das coletas já registradas."""
from fastapi import APIRouter, Depends, Query

from app.core.deps import get_current_user
from app.models.schemas import UsuarioOut
from app.services import coleta_service

router = APIRouter(prefix="/coletas", tags=["coletas"])


@router.get("/passagens")
def passagens(dias: int = Query(14, ge=1, le=120),
              _: UsuarioOut = Depends(get_current_user)):
    """Quem passou em cada dia útil, e em qual dia ficou carga para trás."""
    return coleta_service.painel(dias)

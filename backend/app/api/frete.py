# -*- coding: utf-8 -*-
"""Conferência da fatura de frete — sobe o zip da transportadora e confere."""
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile

from app.core.deps import get_current_user
from app.models.schemas import UsuarioOut
from app.services import frete_service

router = APIRouter(tags=["frete"])

# 40 MB. O pacote de 16 a 31/08 tem 6 MB com 88 arquivos; o teto é folga para um
# período cheio, e existe para um upload errado não virar timeout.
TETO = 40 * 1024 * 1024


@router.post("/frete/conferencia")
async def conferir(
    arquivo: UploadFile = File(...),
    transportadora: Optional[str] = Form(None),
    gravar: bool = Form(True),
    usuario: UsuarioOut = Depends(get_current_user),
):
    """Confere o pacote da transportadora contra as nossas OVs."""
    conteudo = await arquivo.read()
    if not conteudo:
        raise HTTPException(422, "arquivo vazio")
    if len(conteudo) > TETO:
        raise HTTPException(413, "arquivo acima de 40 MB")
    return frete_service.conferir(
        conteudo, arquivo.filename or "pacote.zip",
        transportadora=transportadora, gravar=gravar, usuario=usuario)


@router.get("/frete/conferencias")
def listar(limite: int = 24, _: UsuarioOut = Depends(get_current_user)):
    """O histórico guardado — os últimos 3 meses."""
    return frete_service.listar(limite)


@router.get("/frete/conferencias/{conferencia_id}")
def detalhe(conferencia_id: str, _: UsuarioOut = Depends(get_current_user)):
    return frete_service.detalhe(conferencia_id)

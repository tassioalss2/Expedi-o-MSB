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
    # A conversa onde o frete e cotado. Opcional: sem ela a conferencia roda
    # igual, so nao consegue dizer se a cobranca a mais foi combinada.
    conversa: Optional[UploadFile] = File(None),
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
    bytes_conversa, nome_conversa = None, ""
    if conversa is not None:
        bytes_conversa = await conversa.read()
        nome_conversa = conversa.filename or ""
        if len(bytes_conversa) > TETO:
            raise HTTPException(413, "a conversa esta acima de 40 MB")
    return frete_service.conferir(
        conteudo, arquivo.filename or "pacote.zip",
        transportadora=transportadora, gravar=gravar, usuario=usuario,
        conversa=bytes_conversa, conversa_nome=nome_conversa)


@router.get("/frete/ov/{numero}")
def analise_ov(numero: str, _: UsuarioOut = Depends(get_current_user)):
    """O que a conferência sabe de uma OV, com o veredito escrito."""
    return frete_service.analise_ov(numero)


@router.get("/frete/conferencias")
def listar(limite: int = 24, _: UsuarioOut = Depends(get_current_user)):
    """O histórico guardado — os últimos 3 meses."""
    return frete_service.listar(limite)


@router.get("/frete/conferencias/{conferencia_id}")
def detalhe(conferencia_id: str, _: UsuarioOut = Depends(get_current_user)):
    return frete_service.detalhe(conferencia_id)

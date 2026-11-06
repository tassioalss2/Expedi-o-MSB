# -*- coding: utf-8 -*-
"""Espelho das notas do D365 e a conciliação com o que o app registrou.

A operação continua no kanban; o faturamento passa a ser o que o D365 emitiu.
Enquanto o acesso OData não é liberado, o caminho é o export que a área já
extrai — por isso a importação é por arquivo.
"""
from datetime import date, timedelta

from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, File, HTTPException, Query, UploadFile
from pydantic import BaseModel

from app.core.deps import get_current_user
from app.models.schemas import UsuarioOut
from app.services import notas_d365_service

router = APIRouter(prefix="/notas-d365", tags=["Faturamento (D365)"])


@router.post("/importar")
async def importar(arquivo: UploadFile = File(...),
                   usuario: UsuarioOut = Depends(get_current_user)):
    """Sobe o export de notas do D365. Reimportar o mesmo período não duplica."""
    conteudo = await arquivo.read()
    return notas_d365_service.importar(conteudo, arquivo.filename or "export.xlsx", usuario)


@router.post("/base-itens")
async def importar_base_itens(arquivo: UploadFile = File(...),
                              _: UsuarioOut = Depends(get_current_user)):
    """Sobe a base de notas item a item e preenche a LINHA das notas do espelho.

    Não substitui o export de notas: aquele diz o que foi faturado e atualiza o
    dia inteiro; este diz o que tinha dentro de cada nota. Pode subir quantas
    vezes quiser — nota que já tem linha não é tocada.
    """
    conteudo = await arquivo.read()
    return notas_d365_service.importar_base_itens(
        conteudo, arquivo.filename or "base_itens.xlsx")


class LinhaDaNota(BaseModel):
    """URO, VASCULAR ou REALCLOSURE — ou nulo para tirar a linha."""
    linha: Optional[str] = None


@router.patch("/{nota_id}/linha")
def ajustar_linha(nota_id: UUID, payload: LinhaDaNota,
                  _: UsuarioOut = Depends(get_current_user)):
    """Corrige a linha comercial de uma nota que não passou pelo app.

    Licitação nasce VASCULAR, que é onde ela cai quase sempre; a exceção se
    conserta nota a nota."""
    try:
        return notas_d365_service.ajustar_linha(str(nota_id), payload.linha)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


class OperacaoEnsinada(BaseModel):
    """O que é, de fato, uma operação fiscal que o app não reconheceu."""
    operacao: str
    tipo_operacao: str
    origem_venda: Optional[str] = None
    observacao: Optional[str] = None


@router.get("/operacoes-a-classificar")
def operacoes_a_classificar(ini: str = Query(..., description="AAAA-MM-DD"),
                            fim: str = Query(..., description="AAAA-MM-DD"),
                            _: UsuarioOut = Depends(get_current_user)):
    """Operações do espelho sem natureza, com exemplos de nota para identificar.

    Inclui entrada: devolução é nota de ENTRADA e abate a meta, então uma
    entrada desconhecida pode ser uma devolução que ninguém está descontando.
    """
    return {"operacoes": notas_d365_service.operacoes_a_classificar(ini, fim)}


@router.post("/operacoes")
def ensinar_operacao(payload: OperacaoEnsinada,
                     usuario: UsuarioOut = Depends(get_current_user)):
    """Ensina ao app o que é uma operação do D365 e reclassifica o espelho."""
    if payload.tipo_operacao not in notas_d365_service.TIPOS_ENSINAVEIS:
        raise HTTPException(
            status_code=400,
            detail="tipo_operacao deve ser um de: %s"
                   % ", ".join(notas_d365_service.TIPOS_ENSINAVEIS))
    try:
        return notas_d365_service.ensinar_operacao(
            payload.operacao, payload.tipo_operacao, payload.origem_venda,
            payload.observacao, str(usuario.id))
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/conciliacao")
def conciliacao(ini: str = Query(..., description="AAAA-MM-DD"),
                fim: str = Query(..., description="AAAA-MM-DD"),
                _: UsuarioOut = Depends(get_current_user)):
    """D365 × app no período: o que casa, o que só existe de um lado e o que
    diverge em valor ou data."""
    return notas_d365_service.conciliacao(ini, fim)


@router.get("/competencia/{competencia}")
def por_competencia(competencia: str,
                    _: UsuarioOut = Depends(get_current_user)):
    """Atalho da conciliação para um mês inteiro (AAAA-MM)."""
    ano, mes = (int(x) for x in competencia.split("-")[:2])
    ini = date(ano, mes, 1)
    # O ultimo dia do mes, nao o primeiro do seguinte: a conciliacao e
    # inclusiva nas duas pontas.
    fim = date(ano + (mes == 12), (mes % 12) + 1, 1) - timedelta(days=1)
    return notas_d365_service.conciliacao(ini.isoformat(), fim.isoformat())

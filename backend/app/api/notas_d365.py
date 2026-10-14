# -*- coding: utf-8 -*-
"""Espelho das notas do D365 e a conciliação com o que o app registrou.

A operação continua no kanban; o faturamento passa a ser o que o D365 emitiu.
Enquanto o acesso OData não é liberado, o caminho é o export que a área já
extrai — por isso a importação é por arquivo.
"""
from datetime import date, timedelta

from fastapi import APIRouter, Depends, File, Query, UploadFile

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

# -*- coding: utf-8 -*-
"""
Inventário Contínuo — Router
"""
from fastapi import APIRouter, Depends, Query
from typing import Optional

from app.core.deps import get_current_user, lider_ou_superior
from app.models.schemas import CicloCreate, ContagemCreate, RevisarContagemRequest, UsuarioOut
from app.services import inventario_continuo_service

router = APIRouter(prefix="/inventario-continuo", tags=["inventário-contínuo"])

# ── Ciclos ─────────────────────────────────────────────────────────────────────

@router.get("/ciclos")
def listar_ciclos(usuario: UsuarioOut = Depends(get_current_user)):
    return inventario_continuo_service.listar_ciclos()

@router.get("/ciclos/aberto")
def ciclo_aberto(usuario: UsuarioOut = Depends(get_current_user)):
    c = inventario_continuo_service.get_ciclo_aberto()
    return c or {}

@router.post("/ciclos", status_code=201)
def criar_ciclo(payload: CicloCreate, usuario: UsuarioOut = Depends(lider_ou_superior)):
    return inventario_continuo_service.criar_ciclo(payload, usuario)

@router.patch("/ciclos/{ciclo_id}/fechar")
def fechar_ciclo(ciclo_id: str, usuario: UsuarioOut = Depends(lider_ou_superior)):
    return inventario_continuo_service.fechar_ciclo(ciclo_id, usuario)

# ── Contagens ──────────────────────────────────────────────────────────────────

@router.get("/ciclos/{ciclo_id}/contagens")
def listar_contagens(
    ciclo_id: str,
    status: Optional[str] = Query(None),
    usuario: UsuarioOut = Depends(get_current_user),
):
    return inventario_continuo_service.listar_contagens(ciclo_id, status)

@router.post("/ciclos/{ciclo_id}/contagens", status_code=201)
def criar_contagem(
    ciclo_id: str,
    payload: ContagemCreate,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return inventario_continuo_service.criar_contagem(ciclo_id, payload, usuario)

@router.patch("/contagens/{contagem_id}/revisar")
def revisar_contagem(
    contagem_id: str,
    payload: RevisarContagemRequest,
    usuario: UsuarioOut = Depends(lider_ou_superior),
):
    return inventario_continuo_service.revisar_contagem(contagem_id, payload, usuario)

# ── Utilitários ────────────────────────────────────────────────────────────────

@router.get("/motivos")
def listar_motivos(usuario: UsuarioOut = Depends(get_current_user)):
    return inventario_continuo_service.listar_motivos()

@router.get("/dashboard")
def dashboard(
    ciclo_id: Optional[str] = Query(None),
    usuario: UsuarioOut = Depends(get_current_user),
):
    return inventario_continuo_service.get_dashboard(ciclo_id)

@router.get("/historico")
def historico(
    codigo:   Optional[str] = Query(None),
    lote:     Optional[str] = Query(None),
    operador: Optional[str] = Query(None),
    usuario:  UsuarioOut = Depends(get_current_user),
):
    return inventario_continuo_service.buscar_historico(codigo, lote, operador)

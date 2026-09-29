# -*- coding: utf-8 -*-
"""Controle de devoluções.

A rota de ingestão (`/do-email`) é o que o motor chama duas vezes por dia; as
outras são a tela.
"""
from typing import Optional
from uuid import UUID

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.core.deps import get_current_user
from app.models.schemas import UsuarioOut
from app.services import devolucao_service

router = APIRouter(prefix="/devolucoes", tags=["Devoluções"])


class DevolucaoDoEmail(BaseModel):
    """O que o motor leu de uma CONVERSA do Outlook.

    Tudo opcional menos a conversa: o e-mail real diz a NF em metade dos casos e
    o cliente em um terço. O que não veio fica vazio e a tela pede.
    """
    conversa_id: str
    assunto: Optional[str] = None
    remetente: Optional[str] = None
    recebido_em: Optional[str] = None
    mensagens: int = 1
    numeros_nf: Optional[list[str]] = None
    cliente_codigo: Optional[str] = None
    cliente_cnpj: Optional[str] = None
    produtos: Optional[list[str]] = None


class DevolucaoManual(BaseModel):
    assunto: str
    cliente_id: Optional[UUID] = None
    cliente_codigo: Optional[str] = None
    numeros_nf: Optional[list[str]] = None
    motivo: Optional[str] = None
    observacao: Optional[str] = None
    recebido_em: Optional[str] = None


class DevolucaoUpdate(BaseModel):
    numeros_nf: Optional[list[str]] = None
    cliente_id: Optional[UUID] = None
    cliente_codigo: Optional[str] = None
    motivo: Optional[str] = None
    observacao: Optional[str] = None
    responsavel: Optional[str] = None
    status: Optional[str] = None
    resolucao: Optional[str] = None

    def alteracoes(self) -> dict:
        # `exclude_unset`: mandar só o campo que mudou, e não o formulário
        # inteiro — senão limpar um campo sem querer vira histórico falso.
        d = self.model_dump(exclude_unset=True)
        if "cliente_id" in d and d["cliente_id"] is not None:
            d["cliente_id"] = str(d["cliente_id"])
        return d


class DevolucaoExcluir(BaseModel):
    motivo: str


@router.post("/do-email", status_code=201)
def registrar_do_email(payload: DevolucaoDoEmail,
                       _: UsuarioOut = Depends(get_current_user)):
    """Chamada pelo motor. Idempotente pela conversa: rodar de novo não duplica."""
    return devolucao_service.registrar_do_email(payload.model_dump())


@router.get("")
def listar(incluir_resolvidas: bool = Query(False),
           _: UsuarioOut = Depends(get_current_user)):
    return devolucao_service.listar(incluir_resolvidas=incluir_resolvidas)


@router.post("", status_code=201)
def criar_manual(payload: DevolucaoManual,
                 usuario: UsuarioOut = Depends(get_current_user)):
    """Devolução combinada por telefone — nem toda uma nasce de e-mail."""
    d = payload.model_dump()
    if d.get("cliente_id"):
        d["cliente_id"] = str(d["cliente_id"])
    return devolucao_service.criar_manual(d, usuario)


@router.patch("/{devolucao_id}")
def atualizar(devolucao_id: UUID, payload: DevolucaoUpdate,
              usuario: UsuarioOut = Depends(get_current_user)):
    return devolucao_service.atualizar(str(devolucao_id), payload.alteracoes(), usuario)


@router.post("/{devolucao_id}/remover")
def remover(devolucao_id: UUID, payload: DevolucaoExcluir,
            usuario: UsuarioOut = Depends(get_current_user)):
    """Tira da lista sem apagar: o rastro fica e o motor não a recria."""
    return devolucao_service.excluir(str(devolucao_id), payload.motivo, usuario)

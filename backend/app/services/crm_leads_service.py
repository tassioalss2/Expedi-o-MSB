"""CRM · Leads — captação, pontuação automática (lead scoring) e conversão em oportunidade."""
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.schemas import LeadCreate, LeadUpdate, OportunidadeCreate, UsuarioOut

_ORIGENS_QUENTES = {"Indicação", "Cliente recorrente", "Licitação"}
_STATUS = ["NOVO", "CONTATADO", "QUALIFICADO", "CONVERTIDO", "DESCARTADO"]


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def calcular_score(lead: dict) -> int:
    """Pontuação 0-100 explicável, a partir de sinais do lead."""
    score = 0
    # Valor potencial: até 40 pts (satura em R$ 200 mil)
    valor = float(lead.get("valor_potencial") or 0)
    score += min(40, round(valor / 200000 * 40))
    # Dados de contato completos: 15
    if lead.get("email"):
        score += 8
    if lead.get("telefone"):
        score += 7
    # Canal definido: 10
    if lead.get("canal"):
        score += 10
    # Origem quente: 20; qualquer origem informada: 10
    origem = lead.get("origem")
    if origem in _ORIGENS_QUENTES:
        score += 20
    elif origem:
        score += 10
    # Já é cliente da base: 15 (relacionamento existente)
    if lead.get("cliente_id"):
        score += 15
    return max(0, min(100, score))


def _temperatura(score: int) -> str:
    if score >= 70:
        return "QUENTE"
    if score >= 40:
        return "MORNO"
    return "FRIO"


def _serializar(l: dict) -> dict:
    return {
        "id": l["id"],
        "empresa": l.get("empresa"),
        "contato_nome": l.get("contato_nome"),
        "email": l.get("email"),
        "telefone": l.get("telefone"),
        "cnpj": l.get("cnpj"),
        "canal": l.get("canal"),
        "origem": l.get("origem"),
        "valor_potencial": float(l.get("valor_potencial") or 0),
        "status": l.get("status"),
        "score": l.get("score"),
        "temperatura": l.get("temperatura"),
        "observacao": l.get("observacao"),
        "cliente_id": l.get("cliente_id"),
        "cliente": (l.get("clientes") or {}).get("nome") if l.get("clientes") else None,
        "motivo_descarte": l.get("motivo_descarte"),
        "oportunidade_id": l.get("oportunidade_id"),
        "criado_em": l.get("criado_em"),
    }


def listar_leads(status: Optional[str] = None) -> list:
    db = get_service_db()
    q = db.table("crm_leads").select("*, clientes(nome)").eq("ativo", True)
    if status:
        q = q.eq("status", status)
    rows = q.order("score", desc=True).execute().data
    return [_serializar(r) for r in rows]


def obter_lead(lead_id: str) -> dict:
    db = get_service_db()
    r = db.table("crm_leads").select("*, clientes(nome)").eq("id", lead_id).single().execute().data
    if not r:
        raise HTTPException(status_code=404, detail="Lead não encontrado")
    return _serializar(r)


def criar_lead(payload: LeadCreate) -> dict:
    db = get_service_db()
    base = {
        "empresa": payload.empresa.strip(),
        "contato_nome": payload.contato_nome,
        "email": payload.email,
        "telefone": payload.telefone,
        "cnpj": payload.cnpj,
        "canal": payload.canal,
        "origem": payload.origem,
        "valor_potencial": float(payload.valor_potencial or 0),
        "observacao": payload.observacao,
        "cliente_id": str(payload.cliente_id) if payload.cliente_id else None,
    }
    score = calcular_score(base)
    row = db.table("crm_leads").insert({
        **base, "status": "NOVO", "score": score, "temperatura": _temperatura(score), "ativo": True,
    }).execute().data[0]
    return obter_lead(row["id"])


def atualizar_lead(lead_id: str, payload: LeadUpdate) -> dict:
    db = get_service_db()
    atual = db.table("crm_leads").select("*").eq("id", lead_id).single().execute().data
    if not atual:
        raise HTTPException(status_code=404, detail="Lead não encontrado")

    update: dict = {"atualizado_em": _agora()}
    for campo in ("empresa", "contato_nome", "email", "telefone", "cnpj", "canal", "origem", "observacao", "motivo_descarte"):
        val = getattr(payload, campo)
        if val is not None:
            update[campo] = val
    if payload.valor_potencial is not None:
        update["valor_potencial"] = float(payload.valor_potencial)
    if payload.cliente_id is not None:
        update["cliente_id"] = str(payload.cliente_id)
    if payload.status is not None:
        if payload.status not in _STATUS:
            raise HTTPException(status_code=422, detail="Status de lead inválido")
        update["status"] = payload.status

    # Recalcula score com o estado resultante
    resultante = {**atual, **update}
    score = calcular_score(resultante)
    update["score"] = score
    update["temperatura"] = _temperatura(score)

    db.table("crm_leads").update(update).eq("id", lead_id).execute()
    return obter_lead(lead_id)


def converter_lead(lead_id: str, usuario: UsuarioOut) -> dict:
    """Converte o lead em oportunidade no funil (estágio Qualificação)."""
    from app.services import crm_service

    db = get_service_db()
    lead = db.table("crm_leads").select("*").eq("id", lead_id).single().execute().data
    if not lead:
        raise HTTPException(status_code=404, detail="Lead não encontrado")
    if lead.get("oportunidade_id"):
        raise HTTPException(status_code=400, detail="Este lead já foi convertido em oportunidade.")

    opp = crm_service.criar_oportunidade(
        OportunidadeCreate(
            titulo=f"{lead.get('empresa')}",
            cliente_id=lead.get("cliente_id"),
            canal=lead.get("canal"),
            estagio="QUALIFICACAO",
            valor_estimado=float(lead.get("valor_potencial") or 0),
            origem=lead.get("origem") or "Lead",
        ),
        usuario,
    )
    db.table("crm_leads").update({
        "status": "CONVERTIDO", "oportunidade_id": opp["id"], "atualizado_em": _agora(),
    }).eq("id", lead_id).execute()
    return {"lead": obter_lead(lead_id), "oportunidade": opp}


def excluir_lead(lead_id: str) -> dict:
    db = get_service_db()
    db.table("crm_leads").update({"ativo": False, "atualizado_em": _agora()}).eq("id", lead_id).execute()
    return {"ok": True}

"""CRM · Cotações / Propostas comerciais.

Gera cotações a partir de uma oportunidade (ou avulsas), com itens, descontos,
frete e condições. Calcula totais no servidor. O status ACEITA pode marcar a
oportunidade vinculada como ganha.
"""
from datetime import datetime, timezone
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.schemas import CotacaoCreate, CotacaoUpdate, UsuarioOut

_STATUS = ["RASCUNHO", "ENVIADA", "ACEITA", "RECUSADA"]


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _gerar_numero(db) -> str:
    existentes = db.table("crm_cotacoes").select("id").execute().data
    return f"COT-{len(existentes) + 1:04d}"


def _totais(itens: list, frete: float, desconto_pct: float) -> tuple:
    bruto = 0.0
    for it in itens:
        q = float(it.get("qtd") or 0)
        vu = float(it.get("valor_unitario") or 0)
        dpct = float(it.get("desconto_pct") or 0)
        bruto += q * vu * (1 - dpct / 100)
    total = bruto * (1 - float(desconto_pct or 0) / 100) + float(frete or 0)
    return round(bruto, 2), round(total, 2)


def _itens_in(itens, cotacao_id: str) -> list:
    out = []
    for it in itens or []:
        out.append({
            "cotacao_id": cotacao_id,
            "produto_id": str(it.produto_id) if it.produto_id else None,
            "codigo": it.codigo,
            "descricao": it.descricao,
            "qtd": float(it.qtd or 0),
            "valor_unitario": float(it.valor_unitario or 0),
            "desconto_pct": float(it.desconto_pct or 0),
        })
    return out


def _serializar(c: dict, itens: Optional[list] = None) -> dict:
    return {
        "id": c["id"],
        "numero": c.get("numero"),
        "cliente_id": c.get("cliente_id"),
        "cliente": (c.get("clientes") or {}).get("nome") if c.get("clientes") else None,
        "cliente_cnpj": (c.get("clientes") or {}).get("cnpj") if c.get("clientes") else None,
        "contato_id": c.get("contato_id"),
        "oportunidade_id": c.get("oportunidade_id"),
        "canal": c.get("canal"),
        "status": c.get("status"),
        "validade": c.get("validade"),
        "condicao_pagamento": c.get("condicao_pagamento"),
        "prazo_entrega": c.get("prazo_entrega"),
        "frete": float(c.get("frete") or 0),
        "desconto_pct": float(c.get("desconto_pct") or 0),
        "observacao": c.get("observacao"),
        "endereco": c.get("endereco"),
        "endereco_bairro": c.get("endereco_bairro"),
        "endereco_cidade": c.get("endereco_cidade"),
        "endereco_uf": c.get("endereco_uf"),
        "endereco_cep": c.get("endereco_cep"),
        "valor_bruto": float(c.get("valor_bruto") or 0),
        "valor_total": float(c.get("valor_total") or 0),
        "criado_em": c.get("criado_em"),
        "enviada_em": c.get("enviada_em"),
        "responsavel": (c.get("usuarios") or {}).get("nome") if c.get("usuarios") else None,
        "responsavel_email": (c.get("usuarios") or {}).get("email") if c.get("usuarios") else None,
        "itens": itens if itens is not None else None,
    }


def listar_cotacoes(status: Optional[str] = None) -> list:
    db = get_service_db()
    q = db.table("crm_cotacoes").select("*, clientes(nome, cnpj), usuarios(nome, email)").eq("ativo", True)
    if status:
        q = q.eq("status", status)
    rows = q.order("criado_em", desc=True).execute().data
    return [_serializar(r) for r in rows]


def obter_cotacao(cotacao_id: str) -> dict:
    db = get_service_db()
    c = db.table("crm_cotacoes").select("*, clientes(nome, cnpj), usuarios(nome, email)").eq("id", cotacao_id).single().execute().data
    if not c:
        raise HTTPException(status_code=404, detail="Cotação não encontrada")
    itens = db.table("crm_cotacao_itens").select("*").eq("cotacao_id", cotacao_id).execute().data
    itens_out = [{
        "produto_id": it.get("produto_id"),
        "codigo": it.get("codigo"),
        "descricao": it.get("descricao"),
        "qtd": float(it.get("qtd") or 0),
        "valor_unitario": float(it.get("valor_unitario") or 0),
        "desconto_pct": float(it.get("desconto_pct") or 0),
        "total": round(float(it.get("qtd") or 0) * float(it.get("valor_unitario") or 0) * (1 - float(it.get("desconto_pct") or 0) / 100), 2),
    } for it in itens]

    contato = None
    if c.get("contato_id"):
        cc = db.table("crm_contatos").select("nome, cargo, email, telefone").eq("id", c["contato_id"]).execute().data
        contato = cc[0] if cc else None
    out = _serializar(c, itens_out)
    out["contato"] = contato
    return out


def criar_cotacao(payload: CotacaoCreate, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    itens_dict = [{"qtd": i.qtd, "valor_unitario": i.valor_unitario, "desconto_pct": i.desconto_pct} for i in payload.itens]
    bruto, total = _totais(itens_dict, payload.frete, payload.desconto_pct)

    row = db.table("crm_cotacoes").insert({
        "numero": (payload.numero or "").strip() or _gerar_numero(db),
        "cliente_id": str(payload.cliente_id) if payload.cliente_id else None,
        "contato_id": str(payload.contato_id) if payload.contato_id else None,
        "oportunidade_id": str(payload.oportunidade_id) if payload.oportunidade_id else None,
        "canal": payload.canal,
        "status": "RASCUNHO",
        "validade": payload.validade.isoformat() if payload.validade else None,
        "condicao_pagamento": payload.condicao_pagamento,
        "prazo_entrega": payload.prazo_entrega,
        "frete": float(payload.frete or 0),
        "desconto_pct": float(payload.desconto_pct or 0),
        "observacao": payload.observacao,
        "endereco": payload.endereco,
        "endereco_bairro": payload.endereco_bairro,
        "endereco_cidade": payload.endereco_cidade,
        "endereco_uf": payload.endereco_uf,
        "endereco_cep": payload.endereco_cep,
        "valor_bruto": bruto,
        "valor_total": total,
        "responsavel_id": str(usuario.id),
        "ativo": True,
    }).execute().data[0]

    if payload.itens:
        db.table("crm_cotacao_itens").insert(_itens_in(payload.itens, row["id"])).execute()
    return obter_cotacao(row["id"])


def atualizar_cotacao(cotacao_id: str, payload: CotacaoUpdate, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    atual = db.table("crm_cotacoes").select("*").eq("id", cotacao_id).single().execute().data
    if not atual:
        raise HTTPException(status_code=404, detail="Cotação não encontrada")

    update: dict = {"atualizado_em": _agora()}
    if payload.numero is not None:
        update["numero"] = payload.numero.strip()
    if payload.cliente_id is not None:
        update["cliente_id"] = str(payload.cliente_id)
    if payload.contato_id is not None:
        update["contato_id"] = str(payload.contato_id) if payload.contato_id else None
    for campo in ("canal", "condicao_pagamento", "prazo_entrega", "observacao",
                  "endereco", "endereco_bairro", "endereco_cidade", "endereco_uf", "endereco_cep"):
        val = getattr(payload, campo)
        if val is not None:
            update[campo] = val
    if payload.validade is not None:
        update["validade"] = payload.validade.isoformat()
    if payload.frete is not None:
        update["frete"] = float(payload.frete)
    if payload.desconto_pct is not None:
        update["desconto_pct"] = float(payload.desconto_pct)

    if payload.status is not None:
        if payload.status not in _STATUS:
            raise HTTPException(status_code=422, detail="Status de cotação inválido")
        update["status"] = payload.status
        if payload.status == "ENVIADA" and not atual.get("enviada_em"):
            update["enviada_em"] = _agora()
        if payload.status in ("ACEITA", "RECUSADA"):
            update["respondida_em"] = _agora()

    # Substitui itens se enviados
    if payload.itens is not None:
        db.table("crm_cotacao_itens").delete().eq("cotacao_id", cotacao_id).execute()
        if payload.itens:
            db.table("crm_cotacao_itens").insert(_itens_in(payload.itens, cotacao_id)).execute()

    # Recalcula totais com o estado resultante
    itens_rows = db.table("crm_cotacao_itens").select("qtd, valor_unitario, desconto_pct").eq("cotacao_id", cotacao_id).execute().data
    frete = update.get("frete", atual.get("frete") or 0)
    desc = update.get("desconto_pct", atual.get("desconto_pct") or 0)
    bruto, total = _totais(itens_rows, frete, desc)
    update["valor_bruto"] = bruto
    update["valor_total"] = total

    db.table("crm_cotacoes").update(update).eq("id", cotacao_id).execute()

    # Cotação aceita → marca a oportunidade vinculada como ganha
    if payload.status == "ACEITA" and atual.get("oportunidade_id"):
        try:
            from app.services import crm_service
            crm_service.ganhar_oportunidade(atual["oportunidade_id"], usuario)
        except Exception:
            pass

    return obter_cotacao(cotacao_id)


def gerar_ov(cotacao_id: str, payload, usuario: UsuarioOut) -> dict:
    """Converte uma cotação ACEITA em OV no fluxo logístico, herdando cliente,
    canal, itens e PREÇOS (com desconto por item aplicado) — sem redigitar nada."""
    from app.models.schemas import ItemPedidoCreate, PedidoCreate
    from app.services import crm_service, pedido_service

    db = get_service_db()
    c = db.table("crm_cotacoes").select("*").eq("id", cotacao_id).single().execute().data
    if not c:
        raise HTTPException(status_code=404, detail="Cotação não encontrada")
    if c.get("status") != "ACEITA":
        raise HTTPException(status_code=400, detail="Só cotações ACEITAS podem gerar OV.")
    if not c.get("cliente_id"):
        raise HTTPException(status_code=400, detail="A cotação precisa ter um cliente para gerar a OV.")

    itens = db.table("crm_cotacao_itens").select("*").eq("cotacao_id", cotacao_id).execute().data
    itens_validos = [i for i in itens if i.get("produto_id") and float(i.get("qtd") or 0) > 0]
    if not itens_validos:
        raise HTTPException(status_code=422, detail="A cotação precisa ter itens (produto e quantidade) para gerar a OV.")

    def _preco_liquido(i: dict):
        vu = float(i.get("valor_unitario") or 0)
        desc = float(i.get("desconto_pct") or 0)
        liq = round(vu * (1 - desc / 100), 4)
        return liq or None

    ov = pedido_service.criar_pedido(
        PedidoCreate(
            numero_pedido=payload.numero_pedido.strip().upper(),
            cliente_id=c["cliente_id"],
            tipo_frete=payload.tipo_frete or "FOB",
            tipo_operacao="VENDA_NORMAL",
            canal=c.get("canal"),
            local_entrega=payload.local_entrega,
            data_prevista_entrega=payload.data_prevista_entrega,
            valor_frete=float(c.get("frete") or 0) or None,
            itens=[ItemPedidoCreate(produto_id=i["produto_id"], qtd_solicitada=float(i["qtd"]),
                                    valor_unitario=_preco_liquido(i)) for i in itens_validos],
        ),
        usuario,
    )

    # Se há oportunidade vinculada, registra a OV nela também.
    opp_id = c.get("oportunidade_id")
    if opp_id:
        o = db.table("crm_oportunidades").select("gerado_ov_id").eq("id", opp_id).single().execute().data
        if o and not o.get("gerado_ov_id"):
            db.table("crm_oportunidades").update({
                "gerado_ov_id": ov.get("id"), "gerado_ov_ref": ov.get("numero_pedido"), "atualizado_em": _agora(),
            }).eq("id", opp_id).execute()
            crm_service._log_evento(db, opp_id, f"📦 OV gerada a partir da cotação {c.get('numero')}: {ov.get('numero_pedido')}", str(usuario.id))

    out = obter_cotacao(cotacao_id)
    out["ov_gerada_id"] = ov.get("id")
    out["ov_gerada_ref"] = ov.get("numero_pedido")
    return out


def excluir_cotacao(cotacao_id: str) -> dict:
    db = get_service_db()
    db.table("crm_cotacoes").update({"ativo": False, "atualizado_em": _agora()}).eq("id", cotacao_id).execute()
    return {"ok": True}

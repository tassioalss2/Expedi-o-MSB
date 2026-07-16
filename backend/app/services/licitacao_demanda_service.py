"""Painel de demandas de licitação — triagem visual (Kanban) das operações que
chegam por e-mail (venda direta, consignação, comunicado de uso).

Cada demanda é um card que anda pelas etapas NOVO → ANALISE → PROCESSANDO →
CONCLUIDO. Ao concluir, o app gera automaticamente o artefato correspondente:
- VENDA_DIRETA  → cria a OV no fluxo logístico
- CONSIGNACAO   → cria o empenho
- COMUNICADO_USO→ registra o comunicado de uso (baixando saldo de um empenho, se houver)
"""
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.schemas import (
    ComunicadoUsoCreate,
    ConsumoEmpenhoCreate,
    DemandaConcluir,
    DemandaCreate,
    DemandaUpdate,
    EmpenhoCreate,
    EmpenhoItemCreate,
    ItemPedidoCreate,
    PedidoCreate,
    UsuarioOut,
)

ETAPAS = ["NOVO", "ANALISE", "PROCESSANDO", "CONCLUIDO"]
TIPOS = ["VENDA_DIRETA", "CONSIGNACAO", "COMUNICADO_USO"]
_PRIORIDADE_PESO = {"CRITICA": 0, "ALTA": 1, "NORMAL": 2}


def _agora() -> str:
    from datetime import datetime, timezone
    return datetime.now(timezone.utc).isoformat()


def _itens_json(itens) -> list:
    """Serializa DemandaItem[] para gravar no jsonb."""
    out = []
    for it in itens or []:
        out.append({
            "produto_id": str(it.produto_id) if it.produto_id else None,
            "codigo": it.codigo,
            "descricao": it.descricao,
            "qtd": float(it.qtd or 0),
            "valor": float(it.valor or 0),
        })
    return out


def _serializar(d: dict) -> dict:
    return {
        "id": d["id"],
        "tipo_operacao": d.get("tipo_operacao"),
        "etapa": d.get("etapa"),
        "numero": d.get("numero"),
        "cliente_id": d.get("cliente_id"),
        "cliente": (d.get("clientes") or {}).get("nome") if d.get("clientes") else None,
        "canal": d.get("canal"),
        "prazo": d.get("prazo"),
        "prioridade": d.get("prioridade") or "NORMAL",
        "observacao": d.get("observacao"),
        "responsavel_id": d.get("responsavel_id"),
        "itens": d.get("itens") or [],
        "gerado_tipo": d.get("gerado_tipo"),
        "gerado_id": d.get("gerado_id"),
        "gerado_ref": d.get("gerado_ref"),
        "criado_em": d.get("criado_em"),
        "concluido_em": d.get("concluido_em"),
    }


def listar_demandas() -> list:
    db = get_service_db()
    rows = db.table("licitacao_demandas").select("*, clientes(nome)")\
        .eq("ativo", True).order("criado_em", desc=True).execute().data
    demandas = [_serializar(r) for r in rows]
    demandas.sort(key=lambda d: (_PRIORIDADE_PESO.get(d["prioridade"], 3), d.get("prazo") or "9999"))
    return demandas


def criar_demanda(payload: DemandaCreate) -> dict:
    if payload.tipo_operacao not in TIPOS:
        raise HTTPException(status_code=422, detail="Tipo de operação inválido")
    db = get_service_db()
    row = db.table("licitacao_demandas").insert({
        "tipo_operacao": payload.tipo_operacao,
        "etapa": "NOVO",
        "numero": (payload.numero or "").strip() or None,
        "cliente_id": str(payload.cliente_id),
        "canal": payload.canal,
        "prazo": payload.prazo.isoformat() if payload.prazo else None,
        "prioridade": payload.prioridade or "NORMAL",
        "observacao": payload.observacao,
        "itens": _itens_json(payload.itens),
        "ativo": True,
    }).execute().data[0]
    return obter_demanda(row["id"])


def obter_demanda(demanda_id: str) -> dict:
    db = get_service_db()
    r = db.table("licitacao_demandas").select("*, clientes(nome)").eq("id", demanda_id).single().execute().data
    if not r:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    return _serializar(r)


def atualizar_demanda(demanda_id: str, payload: DemandaUpdate) -> dict:
    db = get_service_db()
    atual = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not atual:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")

    update: dict = {"atualizado_em": _agora()}
    if payload.tipo_operacao is not None:
        if payload.tipo_operacao not in TIPOS:
            raise HTTPException(status_code=422, detail="Tipo de operação inválido")
        update["tipo_operacao"] = payload.tipo_operacao
    if payload.etapa is not None:
        if payload.etapa not in ETAPAS:
            raise HTTPException(status_code=422, detail="Etapa inválida")
        if payload.etapa == "CONCLUIDO" and not atual.get("gerado_id"):
            raise HTTPException(
                status_code=400,
                detail="Para concluir, use a ação 'Concluir e gerar' — ela cria a OV/empenho/comunicado.",
            )
        update["etapa"] = payload.etapa
    if payload.numero is not None:
        update["numero"] = payload.numero.strip() or None
    if payload.cliente_id is not None:
        update["cliente_id"] = str(payload.cliente_id)
    if payload.canal is not None:
        update["canal"] = payload.canal or None
    if payload.prazo is not None:
        update["prazo"] = payload.prazo.isoformat()
    if payload.prioridade is not None:
        update["prioridade"] = payload.prioridade
    if payload.observacao is not None:
        update["observacao"] = payload.observacao
    if payload.responsavel_id is not None:
        update["responsavel_id"] = str(payload.responsavel_id)
    if payload.itens is not None:
        update["itens"] = _itens_json(payload.itens)

    db.table("licitacao_demandas").update(update).eq("id", demanda_id).execute()
    return obter_demanda(demanda_id)


def excluir_demanda(demanda_id: str) -> dict:
    db = get_service_db()
    db.table("licitacao_demandas").update({"ativo": False, "atualizado_em": _agora()})\
        .eq("id", demanda_id).execute()
    return {"ok": True}


def _itens_pedido(itens, rotulo: str) -> list:
    """Converte os itens (produto_id + qtd) para ItemPedidoCreate, validando."""
    validos = [it for it in itens if it.produto_id and float(it.qtd or 0) > 0]
    if not validos:
        raise HTTPException(
            status_code=422,
            detail=f"Informe ao menos um item (produto e quantidade) para {rotulo}.",
        )
    return [ItemPedidoCreate(produto_id=it.produto_id, qtd_solicitada=float(it.qtd)) for it in validos]


def concluir_demanda(demanda_id: str, payload: DemandaConcluir, usuario: UsuarioOut) -> dict:
    from app.services import licitacao_service, pedido_service

    db = get_service_db()
    d = db.table("licitacao_demandas").select("*").eq("id", demanda_id).single().execute().data
    if not d:
        raise HTTPException(status_code=404, detail="Demanda não encontrada")
    if d.get("gerado_id"):
        raise HTTPException(status_code=400, detail="Esta demanda já foi concluída e gerou um registro.")

    tipo = d.get("tipo_operacao")
    cliente_id = d.get("cliente_id")
    canal = payload.canal or d.get("canal")

    # Itens: usa os informados na conclusão; se vazios, cai nos itens da triagem.
    itens_src = payload.itens
    if not itens_src and d.get("itens"):
        from app.models.schemas import DemandaItem
        itens_src = [DemandaItem(**it) for it in d["itens"]]

    gerado_tipo = gerado_id = gerado_ref = None

    if tipo in ("VENDA_DIRETA", "CONSIGNACAO"):
        # Ambos criam um CONTRATO (empenho) com as quantidades totais do pregão/ata.
        # Venda direta é baixada por OVs parciais; consignação por comunicado de uso.
        if not payload.numero or not payload.numero.strip():
            raise HTTPException(status_code=422, detail="Informe o número do contrato/empenho.")
        itens_emp = [it for it in itens_src if it.produto_id and float(it.qtd or 0) > 0]
        if not itens_emp:
            raise HTTPException(status_code=422, detail="Informe os itens do contrato (produto, quantidade e valor).")
        emp = licitacao_service.criar_empenho(
            EmpenhoCreate(
                numero=payload.numero.strip(),
                cliente_id=cliente_id,
                tipo=tipo,
                canal=canal,
                data_empenho=payload.data_empenho,
                vigencia=payload.vigencia,
                observacao=d.get("observacao"),
                itens=[EmpenhoItemCreate(produto_id=it.produto_id, qtd_empenhada=float(it.qtd),
                                         valor_unitario=float(it.valor or 0)) for it in itens_emp],
            )
        )
        gerado_tipo, gerado_id, gerado_ref = "CONTRATO", emp.get("id"), emp.get("numero")

    elif tipo == "COMUNICADO_USO":
        if not payload.numero_pedido or not payload.numero_pedido.strip():
            raise HTTPException(status_code=422, detail="Informe o número do lançamento (comunicado).")
        if not payload.numero_nf or not payload.numero_nf.strip():
            raise HTTPException(status_code=422, detail="Informe o número da NF.")
        if not payload.valor_nf or float(payload.valor_nf) <= 0:
            raise HTTPException(status_code=422, detail="Informe o valor da NF (maior que zero).")

        if payload.empenho_id:
            # Baixa saldo de um empenho consignado existente.
            licitacao_service.registrar_consumo(
                str(payload.empenho_id),
                ConsumoEmpenhoCreate(
                    numero_pedido=payload.numero_pedido.strip().upper(),
                    numero_nf=payload.numero_nf.strip(),
                    valor_nf=float(payload.valor_nf),
                    data_faturamento=payload.data_faturamento,
                    canal=canal,
                    itens=_itens_pedido(itens_src, "o comunicado de uso"),
                ),
                usuario,
            )
            gerado_tipo, gerado_id, gerado_ref = "COMUNICADO", str(payload.empenho_id), payload.numero_pedido.strip().upper()
        else:
            # Comunicado avulso (consignado não rastreado no painel).
            com = pedido_service.criar_comunicado_uso(
                ComunicadoUsoCreate(
                    numero_pedido=payload.numero_pedido.strip().upper(),
                    cliente_id=cliente_id,
                    numero_nf=payload.numero_nf.strip(),
                    valor_nf=float(payload.valor_nf),
                    canal=canal,
                    data_faturamento=payload.data_faturamento,
                    itens=[ItemPedidoCreate(produto_id=it.produto_id, qtd_solicitada=float(it.qtd))
                           for it in itens_src if it.produto_id and float(it.qtd or 0) > 0],
                ),
                usuario,
            )
            gerado_tipo, gerado_id, gerado_ref = "COMUNICADO", com.get("id"), com.get("numero_pedido")
    else:
        raise HTTPException(status_code=422, detail="Tipo de operação da demanda inválido.")

    db.table("licitacao_demandas").update({
        "etapa": "CONCLUIDO",
        "gerado_tipo": gerado_tipo,
        "gerado_id": gerado_id,
        "gerado_ref": gerado_ref,
        "canal": canal,
        "numero": payload.numero.strip() if payload.numero else d.get("numero"),
        "concluido_em": _agora(),
        "atualizado_em": _agora(),
    }).eq("id", demanda_id).execute()

    return obter_demanda(demanda_id)

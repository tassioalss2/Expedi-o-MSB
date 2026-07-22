"""CRM — funil de oportunidades, contatos, atividades e timeline.

Inspirado nas boas práticas dos grandes CRMs:
- Funil (pipeline) visual com estágios e previsão ponderada (valor × probabilidade) — Pipedrive.
- Modelo Conta (cliente) → Contato → Oportunidade — Salesforce.
- Timeline de atividades e notas por oportunidade — HubSpot.
- Taxa de ganho, motivo de perda e previsão de fechamento para forecast.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.schemas import (
    AtividadeCreate,
    AtividadeUpdate,
    ContatoCreate,
    ContatoUpdate,
    GerarOVRequest,
    NotaCreate,
    OportunidadeCreate,
    OportunidadeUpdate,
    PerderRequest,
    UsuarioOut,
)

# Estágios do funil e probabilidade padrão de cada um (%).
ESTAGIOS = [
    {"key": "LEAD", "label": "Lead", "prob": 10},
    {"key": "QUALIFICACAO", "label": "Qualificação", "prob": 25},
    {"key": "PROPOSTA", "label": "Proposta", "prob": 50},
    {"key": "NEGOCIACAO", "label": "Negociação", "prob": 75},
    {"key": "GANHO", "label": "Ganho", "prob": 100},
    {"key": "PERDIDO", "label": "Perdido", "prob": 0},
]
_PROB_POR_ESTAGIO = {e["key"]: e["prob"] for e in ESTAGIOS}
_ESTAGIOS_ABERTOS = ["LEAD", "QUALIFICACAO", "PROPOSTA", "NEGOCIACAO"]
_ESTAGIO_LABEL = {e["key"]: e["label"] for e in ESTAGIOS}


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


# ── Clientes (cadastro rápido pelo comercial) ──────────────────────────────────────
def criar_cliente_rapido(nome: str, cnpj: Optional[str] = None) -> dict:
    """Cadastra um cliente/prospect direto do CRM. Gera um código único com
    prefixo CRM- (marca que ainda não veio do D365). Se já existir um cliente
    ativo com o mesmo nome, reutiliza em vez de duplicar."""
    import uuid

    db = get_service_db()
    nome = (nome or "").strip()
    if not nome:
        raise HTTPException(status_code=422, detail="Informe o nome do cliente.")

    existe = db.table("clientes").select("*").eq("nome", nome).eq("ativo", True).limit(1).execute().data
    if existe:
        return existe[0]

    codigo = ""
    for _ in range(10):
        cand = "CRM-" + uuid.uuid4().hex[:6].upper()
        if not db.table("clientes").select("id").eq("codigo", cand).limit(1).execute().data:
            codigo = cand
            break
    if not codigo:
        raise HTTPException(status_code=500, detail="Não foi possível gerar o código do cliente.")

    return db.table("clientes").insert({
        "codigo": codigo,
        "nome": nome,
        "cnpj": (cnpj or "").strip() or None,
        "prioridade": 0,
        "ativo": True,
    }).execute().data[0]


# ── Contatos ─────────────────────────────────────────────────────────────────────
def _serializar_contato(c: dict) -> dict:
    return {
        "id": c["id"],
        "nome": c.get("nome"),
        "cargo": c.get("cargo"),
        "email": c.get("email"),
        "telefone": c.get("telefone"),
        "cliente_id": c.get("cliente_id"),
        "cliente": (c.get("clientes") or {}).get("nome") if c.get("clientes") else None,
        "canal": c.get("canal"),
        "observacao": c.get("observacao"),
        "criado_em": c.get("criado_em"),
    }


def listar_contatos(cliente_id: Optional[str] = None) -> list:
    db = get_service_db()
    q = db.table("crm_contatos").select("*, clientes(nome)").eq("ativo", True)
    if cliente_id:
        q = q.eq("cliente_id", cliente_id)
    rows = q.order("nome").execute().data
    return [_serializar_contato(c) for c in rows]


def obter_contato(contato_id: str) -> dict:
    db = get_service_db()
    c = db.table("crm_contatos").select("*, clientes(nome)").eq("id", contato_id).single().execute().data
    if not c:
        raise HTTPException(status_code=404, detail="Contato não encontrado")
    return _serializar_contato(c)


def criar_contato(payload: ContatoCreate) -> dict:
    db = get_service_db()
    row = db.table("crm_contatos").insert({
        "nome": payload.nome.strip(),
        "cargo": payload.cargo,
        "email": payload.email,
        "telefone": payload.telefone,
        "cliente_id": str(payload.cliente_id) if payload.cliente_id else None,
        "canal": payload.canal,
        "observacao": payload.observacao,
        "ativo": True,
    }).execute().data[0]
    return obter_contato(row["id"])


def atualizar_contato(contato_id: str, payload: ContatoUpdate) -> dict:
    db = get_service_db()
    update: dict = {"atualizado_em": _agora()}
    for campo in ("nome", "cargo", "email", "telefone", "canal", "observacao"):
        val = getattr(payload, campo)
        if val is not None:
            update[campo] = val
    if payload.cliente_id is not None:
        update["cliente_id"] = str(payload.cliente_id)
    db.table("crm_contatos").update(update).eq("id", contato_id).execute()
    return obter_contato(contato_id)


def excluir_contato(contato_id: str) -> dict:
    db = get_service_db()
    db.table("crm_contatos").update({"ativo": False, "atualizado_em": _agora()}).eq("id", contato_id).execute()
    return {"ok": True}


# ── Oportunidades ────────────────────────────────────────────────────────────────
def _valor_itens(itens: list) -> float:
    return sum(float(i.qtd or 0) * float(i.valor_unitario or 0) for i in itens)


def _itens_json(itens, oportunidade_id: str) -> list:
    out = []
    for it in itens or []:
        out.append({
            "oportunidade_id": oportunidade_id,
            "produto_id": str(it.produto_id) if it.produto_id else None,
            "codigo": it.codigo,
            "descricao": it.descricao,
            "qtd": float(it.qtd or 0),
            "valor_unitario": float(it.valor_unitario or 0),
        })
    return out


def _serializar_opp(o: dict, itens: Optional[list] = None) -> dict:
    valor = float(o.get("valor_estimado") or 0)
    prob = int(o.get("probabilidade") or 0)
    return {
        "id": o["id"],
        "titulo": o.get("titulo"),
        "cliente_id": o.get("cliente_id"),
        "cliente": (o.get("clientes") or {}).get("nome") if o.get("clientes") else None,
        "contato_id": o.get("contato_id"),
        "canal": o.get("canal"),
        "estagio": o.get("estagio"),
        "estagio_label": _ESTAGIO_LABEL.get(o.get("estagio"), o.get("estagio")),
        "valor_estimado": round(valor, 2),
        "probabilidade": prob,
        "valor_ponderado": round(valor * prob / 100, 2),
        "origem": o.get("origem"),
        "previsao_fechamento": o.get("previsao_fechamento"),
        "responsavel_id": o.get("responsavel_id"),
        "motivo_perda": o.get("motivo_perda"),
        "ganho_em": o.get("ganho_em"),
        "perdido_em": o.get("perdido_em"),
        "gerado_ov_id": o.get("gerado_ov_id"),
        "gerado_ov_ref": o.get("gerado_ov_ref"),
        "criado_em": o.get("criado_em"),
        "itens": itens if itens is not None else None,
    }


def listar_oportunidades(estagio: Optional[str] = None, incluir_fechadas: bool = False) -> list:
    db = get_service_db()
    q = db.table("crm_oportunidades").select("*, clientes(nome)").eq("ativo", True)
    if estagio:
        q = q.eq("estagio", estagio)
    rows = q.order("criado_em", desc=True).execute().data
    if not incluir_fechadas:
        rows = [r for r in rows if r.get("estagio") in _ESTAGIOS_ABERTOS or r.get("estagio") == "GANHO"]
    # contagem de itens/atividades pendentes por oportunidade (para o card)
    ids = [r["id"] for r in rows]
    pendentes = _atividades_pendentes_por_opp(db, ids)
    result = []
    for r in rows:
        s = _serializar_opp(r)
        s["atividades_pendentes"] = pendentes.get(r["id"], 0)
        result.append(s)
    return result


def _atividades_pendentes_por_opp(db, opp_ids: list) -> dict:
    if not opp_ids:
        return {}
    cont: dict = {}
    for i in range(0, len(opp_ids), 80):
        lote = opp_ids[i:i + 80]
        rows = db.table("crm_atividades").select("oportunidade_id")\
            .in_("oportunidade_id", lote).eq("concluida", False).execute().data
        for a in rows:
            oid = a.get("oportunidade_id")
            if oid:
                cont[oid] = cont.get(oid, 0) + 1
    return cont


def obter_oportunidade(oportunidade_id: str) -> dict:
    db = get_service_db()
    o = db.table("crm_oportunidades").select("*, clientes(nome)").eq("id", oportunidade_id).single().execute().data
    if not o:
        raise HTTPException(status_code=404, detail="Oportunidade não encontrada")

    itens = db.table("crm_oportunidade_itens").select("*").eq("oportunidade_id", oportunidade_id).execute().data
    itens_out = [{
        "produto_id": it.get("produto_id"),
        "codigo": it.get("codigo"),
        "descricao": it.get("descricao"),
        "qtd": float(it.get("qtd") or 0),
        "valor_unitario": float(it.get("valor_unitario") or 0),
        "total": round(float(it.get("qtd") or 0) * float(it.get("valor_unitario") or 0), 2),
    } for it in itens]

    atividades = db.table("crm_atividades").select("*").eq("oportunidade_id", oportunidade_id)\
        .order("data_hora", desc=False).execute().data
    notas = db.table("crm_notas").select("*").eq("oportunidade_id", oportunidade_id)\
        .order("criado_em", desc=True).execute().data

    contato = None
    if o.get("contato_id"):
        c = db.table("crm_contatos").select("nome, cargo, email, telefone").eq("id", o["contato_id"]).execute().data
        contato = c[0] if c else None

    out = _serializar_opp(o, itens_out)
    out["contato"] = contato
    out["atividades"] = atividades
    out["notas"] = notas
    return out


def _log_evento(db, oportunidade_id: str, texto: str, autor_id: Optional[str]) -> None:
    db.table("crm_notas").insert({
        "oportunidade_id": oportunidade_id,
        "tipo": "EVENTO",
        "texto": texto,
        "autor_id": autor_id,
        "criado_em": _agora(),
    }).execute()


def criar_oportunidade(payload: OportunidadeCreate, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    estagio = payload.estagio if payload.estagio in _PROB_POR_ESTAGIO else "LEAD"
    prob = payload.probabilidade if payload.probabilidade is not None else _PROB_POR_ESTAGIO[estagio]
    valor = payload.valor_estimado
    if valor is None:
        valor = _valor_itens(payload.itens)

    row = db.table("crm_oportunidades").insert({
        "titulo": payload.titulo.strip(),
        "cliente_id": str(payload.cliente_id) if payload.cliente_id else None,
        "contato_id": str(payload.contato_id) if payload.contato_id else None,
        "canal": payload.canal,
        "estagio": estagio,
        "valor_estimado": float(valor or 0),
        "probabilidade": int(prob),
        "origem": payload.origem,
        "previsao_fechamento": payload.previsao_fechamento.isoformat() if payload.previsao_fechamento else None,
        "responsavel_id": str(usuario.id),
        "ativo": True,
    }).execute().data[0]

    if payload.itens:
        db.table("crm_oportunidade_itens").insert(_itens_json(payload.itens, row["id"])).execute()
    _log_evento(db, row["id"], "Oportunidade criada", str(usuario.id))
    return obter_oportunidade(row["id"])


def atualizar_oportunidade(oportunidade_id: str, payload: OportunidadeUpdate, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    atual = db.table("crm_oportunidades").select("*").eq("id", oportunidade_id).single().execute().data
    if not atual:
        raise HTTPException(status_code=404, detail="Oportunidade não encontrada")

    update: dict = {"atualizado_em": _agora()}
    if payload.titulo is not None:
        update["titulo"] = payload.titulo.strip()
    if payload.cliente_id is not None:
        update["cliente_id"] = str(payload.cliente_id)
    if payload.contato_id is not None:
        update["contato_id"] = str(payload.contato_id) if payload.contato_id else None
    if payload.canal is not None:
        update["canal"] = payload.canal or None
    if payload.origem is not None:
        update["origem"] = payload.origem
    if payload.previsao_fechamento is not None:
        update["previsao_fechamento"] = payload.previsao_fechamento.isoformat()
    if payload.valor_estimado is not None:
        update["valor_estimado"] = float(payload.valor_estimado)

    # Mudança de estágio → ajusta probabilidade e registra evento na timeline
    if payload.estagio is not None and payload.estagio != atual.get("estagio"):
        if payload.estagio not in _PROB_POR_ESTAGIO:
            raise HTTPException(status_code=422, detail="Estágio inválido")
        if payload.estagio == "GANHO":
            return ganhar_oportunidade(oportunidade_id, usuario)
        if payload.estagio == "PERDIDO":
            raise HTTPException(status_code=400, detail="Para marcar como perdida, informe o motivo (use a ação Perder).")
        update["estagio"] = payload.estagio
        update["probabilidade"] = _PROB_POR_ESTAGIO[payload.estagio]
        # sai de um estado fechado → reabre
        update["ganho_em"] = None
        update["perdido_em"] = None
        update["motivo_perda"] = None
        _log_evento(db, oportunidade_id,
                    f"Estágio: {_ESTAGIO_LABEL.get(atual.get('estagio'), atual.get('estagio'))} → {_ESTAGIO_LABEL[payload.estagio]}",
                    str(usuario.id))

    if payload.probabilidade is not None:
        update["probabilidade"] = int(payload.probabilidade)

    db.table("crm_oportunidades").update(update).eq("id", oportunidade_id).execute()

    # Substitui itens se enviados
    if payload.itens is not None:
        db.table("crm_oportunidade_itens").delete().eq("oportunidade_id", oportunidade_id).execute()
        if payload.itens:
            db.table("crm_oportunidade_itens").insert(_itens_json(payload.itens, oportunidade_id)).execute()
        if payload.valor_estimado is None:
            novo_valor = _valor_itens(payload.itens)
            if novo_valor > 0:
                db.table("crm_oportunidades").update({"valor_estimado": novo_valor}).eq("id", oportunidade_id).execute()

    return obter_oportunidade(oportunidade_id)


def ganhar_oportunidade(oportunidade_id: str, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    agora = _agora()
    db.table("crm_oportunidades").update({
        "estagio": "GANHO", "probabilidade": 100, "ganho_em": agora,
        "perdido_em": None, "motivo_perda": None, "atualizado_em": agora,
    }).eq("id", oportunidade_id).execute()
    _log_evento(db, oportunidade_id, "🏆 Oportunidade marcada como GANHA", str(usuario.id))
    return obter_oportunidade(oportunidade_id)


def perder_oportunidade(oportunidade_id: str, payload: PerderRequest, usuario: UsuarioOut) -> dict:
    if not payload.motivo or len(payload.motivo.strip()) < 3:
        raise HTTPException(status_code=422, detail="Informe o motivo da perda.")
    db = get_service_db()
    agora = _agora()
    db.table("crm_oportunidades").update({
        "estagio": "PERDIDO", "probabilidade": 0, "perdido_em": agora,
        "motivo_perda": payload.motivo.strip(), "ganho_em": None, "atualizado_em": agora,
    }).eq("id", oportunidade_id).execute()
    _log_evento(db, oportunidade_id, f"❌ Oportunidade PERDIDA — {payload.motivo.strip()}", str(usuario.id))
    return obter_oportunidade(oportunidade_id)


def excluir_oportunidade(oportunidade_id: str) -> dict:
    db = get_service_db()
    db.table("crm_oportunidades").update({"ativo": False, "atualizado_em": _agora()}).eq("id", oportunidade_id).execute()
    return {"ok": True}


def gerar_ov(oportunidade_id: str, payload: GerarOVRequest, usuario: UsuarioOut) -> dict:
    """Converte uma oportunidade ganha em OV no fluxo logístico."""
    from app.services import pedido_service
    from app.models.schemas import ItemPedidoCreate, PedidoCreate

    db = get_service_db()
    o = db.table("crm_oportunidades").select("*").eq("id", oportunidade_id).single().execute().data
    if not o:
        raise HTTPException(status_code=404, detail="Oportunidade não encontrada")
    if o.get("gerado_ov_id"):
        raise HTTPException(status_code=400, detail="Esta oportunidade já gerou uma OV.")
    if not o.get("cliente_id"):
        raise HTTPException(status_code=400, detail="Defina o cliente da oportunidade antes de gerar a OV.")

    itens = db.table("crm_oportunidade_itens").select("*").eq("oportunidade_id", oportunidade_id).execute().data
    itens_validos = [i for i in itens if i.get("produto_id") and float(i.get("qtd") or 0) > 0]
    if not itens_validos:
        raise HTTPException(status_code=422, detail="A oportunidade precisa ter itens (produto e quantidade) para gerar a OV.")

    ov = pedido_service.criar_pedido(
        PedidoCreate(
            numero_pedido=payload.numero_pedido.strip().upper(),
            cliente_id=o["cliente_id"],
            tipo_frete=payload.tipo_frete or "FOB",
            tipo_operacao="VENDA_NORMAL",
            canal=o.get("canal"),
            local_entrega=payload.local_entrega,
            data_prevista_entrega=payload.data_prevista_entrega,
            itens=[ItemPedidoCreate(produto_id=i["produto_id"], qtd_solicitada=float(i["qtd"]),
                                    valor_unitario=float(i.get("valor_unitario") or 0) or None) for i in itens_validos],
        ),
        usuario,
    )
    db.table("crm_oportunidades").update({
        "gerado_ov_id": ov.get("id"), "gerado_ov_ref": ov.get("numero_pedido"), "atualizado_em": _agora(),
    }).eq("id", oportunidade_id).execute()
    _log_evento(db, oportunidade_id, f"📦 OV gerada no fluxo logístico: {ov.get('numero_pedido')}", str(usuario.id))
    return obter_oportunidade(oportunidade_id)


# ── Notas ────────────────────────────────────────────────────────────────────────
def criar_nota(oportunidade_id: str, payload: NotaCreate, usuario: UsuarioOut) -> dict:
    if not payload.texto or not payload.texto.strip():
        raise HTTPException(status_code=422, detail="A nota não pode ser vazia.")
    db = get_service_db()
    db.table("crm_notas").insert({
        "oportunidade_id": oportunidade_id,
        "tipo": "NOTA",
        "texto": payload.texto.strip(),
        "autor_id": str(usuario.id),
        "criado_em": _agora(),
    }).execute()
    return obter_oportunidade(oportunidade_id)


# ── Atividades ───────────────────────────────────────────────────────────────────
def _serializar_atividade(a: dict) -> dict:
    return {
        "id": a["id"],
        "oportunidade_id": a.get("oportunidade_id"),
        "oportunidade": (a.get("crm_oportunidades") or {}).get("titulo") if a.get("crm_oportunidades") else None,
        "contato_id": a.get("contato_id"),
        "cliente_id": a.get("cliente_id"),
        "tipo": a.get("tipo"),
        "titulo": a.get("titulo"),
        "descricao": a.get("descricao"),
        "data_hora": a.get("data_hora"),
        "concluida": a.get("concluida"),
        "concluida_em": a.get("concluida_em"),
        "responsavel_id": a.get("responsavel_id"),
        "criado_em": a.get("criado_em"),
    }


def listar_atividades(escopo: str = "abertas", oportunidade_id: Optional[str] = None) -> list:
    db = get_service_db()
    q = db.table("crm_atividades").select("*, crm_oportunidades(titulo)")
    if oportunidade_id:
        q = q.eq("oportunidade_id", oportunidade_id)
    rows = q.order("data_hora", desc=False).execute().data
    ativs = [_serializar_atividade(a) for a in rows]

    if escopo == "todas":
        return ativs

    hoje = datetime.now(timezone.utc).date()
    fim_semana = hoje + timedelta(days=7)

    def dia(a):
        if not a.get("data_hora"):
            return None
        try:
            return datetime.fromisoformat(a["data_hora"].replace("Z", "+00:00")).date()
        except Exception:
            return None

    if escopo == "atrasadas":
        return [a for a in ativs if not a["concluida"] and dia(a) and dia(a) < hoje]
    if escopo == "hoje":
        return [a for a in ativs if not a["concluida"] and dia(a) == hoje]
    if escopo == "semana":
        return [a for a in ativs if not a["concluida"] and dia(a) and hoje <= dia(a) <= fim_semana]
    # abertas (default): todas as não concluídas
    return [a for a in ativs if not a["concluida"]]


def criar_atividade(payload: AtividadeCreate, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    row = db.table("crm_atividades").insert({
        "oportunidade_id": str(payload.oportunidade_id) if payload.oportunidade_id else None,
        "contato_id": str(payload.contato_id) if payload.contato_id else None,
        "cliente_id": str(payload.cliente_id) if payload.cliente_id else None,
        "tipo": payload.tipo or "TAREFA",
        "titulo": payload.titulo.strip(),
        "descricao": payload.descricao,
        "data_hora": payload.data_hora.isoformat() if payload.data_hora else None,
        "concluida": False,
        "responsavel_id": str(usuario.id),
        "criado_em": _agora(),
    }).execute().data[0]
    if payload.oportunidade_id:
        _log_evento(db, str(payload.oportunidade_id), f"🗓️ Atividade agendada: {payload.titulo.strip()}", str(usuario.id))
    return _serializar_atividade(row)


def atualizar_atividade(atividade_id: str, payload: AtividadeUpdate) -> dict:
    db = get_service_db()
    update: dict = {}
    for campo in ("tipo", "titulo", "descricao"):
        val = getattr(payload, campo)
        if val is not None:
            update[campo] = val
    if payload.data_hora is not None:
        update["data_hora"] = payload.data_hora.isoformat()
    if payload.concluida is not None:
        update["concluida"] = payload.concluida
        update["concluida_em"] = _agora() if payload.concluida else None
    db.table("crm_atividades").update(update).eq("id", atividade_id).execute()
    r = db.table("crm_atividades").select("*, crm_oportunidades(titulo)").eq("id", atividade_id).single().execute().data
    return _serializar_atividade(r)


def concluir_atividade(atividade_id: str, concluida: bool = True) -> dict:
    db = get_service_db()
    db.table("crm_atividades").update({
        "concluida": concluida,
        "concluida_em": _agora() if concluida else None,
    }).eq("id", atividade_id).execute()
    r = db.table("crm_atividades").select("*, crm_oportunidades(titulo)").eq("id", atividade_id).single().execute().data
    return _serializar_atividade(r)


def excluir_atividade(atividade_id: str) -> dict:
    db = get_service_db()
    db.table("crm_atividades").delete().eq("id", atividade_id).execute()
    return {"ok": True}


# ── Dashboard ────────────────────────────────────────────────────────────────────
def dashboard() -> dict:
    db = get_service_db()
    opps = db.table("crm_oportunidades").select("*").eq("ativo", True).execute().data

    abertas = [o for o in opps if o.get("estagio") in _ESTAGIOS_ABERTOS]
    ganhas = [o for o in opps if o.get("estagio") == "GANHO"]
    perdidas = [o for o in opps if o.get("estagio") == "PERDIDO"]

    def v(o):
        return float(o.get("valor_estimado") or 0)

    def vp(o):
        return v(o) * int(o.get("probabilidade") or 0) / 100

    # Funil por estágio (aberto)
    por_estagio = []
    for e in ESTAGIOS:
        if e["key"] in ("GANHO", "PERDIDO"):
            continue
        no_estagio = [o for o in abertas if o.get("estagio") == e["key"]]
        por_estagio.append({
            "estagio": e["key"], "label": e["label"],
            "qtd": len(no_estagio),
            "valor": round(sum(v(o) for o in no_estagio), 2),
        })

    # Ganhos/perdidos nos últimos 90 dias → taxa de ganho
    limite = datetime.now(timezone.utc) - timedelta(days=90)

    def fechada_recente(o, campo):
        ts = o.get(campo)
        if not ts:
            return False
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")) >= limite
        except Exception:
            return False

    ganhas_90 = [o for o in ganhas if fechada_recente(o, "ganho_em")]
    perdidas_90 = [o for o in perdidas if fechada_recente(o, "perdido_em")]
    total_fechadas = len(ganhas_90) + len(perdidas_90)
    taxa_ganho = round(len(ganhas_90) / total_fechadas * 100, 1) if total_fechadas else 0

    # Ganhos no mês corrente
    inicio_mes = datetime.now(timezone.utc).replace(day=1, hour=0, minute=0, second=0, microsecond=0)

    def ganho_no_mes(o):
        ts = o.get("ganho_em")
        if not ts:
            return False
        try:
            return datetime.fromisoformat(ts.replace("Z", "+00:00")) >= inicio_mes
        except Exception:
            return False

    ganho_mes_valor = round(sum(v(o) for o in ganhas if ganho_no_mes(o)), 2)

    atrasadas = len(listar_atividades("atrasadas"))
    hoje = len(listar_atividades("hoje"))

    return {
        "pipeline_total": round(sum(v(o) for o in abertas), 2),
        "pipeline_ponderado": round(sum(vp(o) for o in abertas), 2),
        "abertas_qtd": len(abertas),
        "taxa_ganho_90d": taxa_ganho,
        "ganhas_90d": len(ganhas_90),
        "perdidas_90d": len(perdidas_90),
        "ganho_mes_valor": ganho_mes_valor,
        "por_estagio": por_estagio,
        "atividades_atrasadas": atrasadas,
        "atividades_hoje": hoje,
    }

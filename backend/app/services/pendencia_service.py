"""Saldo de material que a venda prometeu e o estoque não tinha.

Regra do processo: a OV só desce para operações de vendas com o que a MSB TEM.
O que faltou não vira OV — vira pendência, e o comercial passa a ver quanto,
de qual item, para quem e quanto vale. Quando o material sai da produção, a
pendência é liberada e entra como 2ª REMESSA: mesmo número de OV, nota fiscal
própria (`pedidos.remessa_numero`, que já existia para faturamento parcial).

Dois caminhos chegam aqui e cada um guarda a pendência onde ela existe:

    CRM       crm_oportunidades.pendencia — na decisão "aguardar produção" não
              existe OV alguma, então a oportunidade é o único registro possível.
    outbound  pedidos.pendencia — venda lançada direto pelo comercial, sem
              oportunidade; a OV é o registro.

O formato do jsonb é o mesmo nos dois, e é por isso que listar e liberar são um
código só em vez de dois quase iguais.

Como a pendência é liberada
---------------------------
Depende de onde a OV está, porque o certo comercialmente muda:

    sem OV ainda          → GERAR_OV   cria a OV agora, com a quantidade toda
    OV com nº provisório  → SOMAR_R1   o D365 ainda não emitiu nada; uma OV só
    OV aberta (não faturou) → SOMAR_R1 nada saiu, uma nota cobre tudo
    OV faturada/expedida  → REMESSA_2  a 1ª remessa já foi; o saldo é a 2ª
    OV cancelada          → bloqueado

Criar R2 de uma OV que ainda não faturou seria duas notas onde uma resolve — e o
app nem permite (`_STATUSES_PERMITE_DERIVAR` em pedido_service).
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.schemas import UsuarioOut
from app.services import disponibilidade_service

# Números que o app gera enquanto o D365 não emitiu o real. Ver
# criar_pedido_stub_crm e criar_pedido_outbound.
_PREFIXOS_PROVISORIOS = ("CRM-", "OUT-")

# Status em que a OV já saiu — o saldo tem de virar remessa nova.
_JA_SAIU = {"FATURADO", "AGUARD_COLETA", "COLETADO", "EXPEDIDO"}


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hoje_brt():
    return (datetime.now(timezone.utc) - timedelta(hours=3)).date()


def _provisorio(numero: Optional[str]) -> bool:
    n = (numero or "").upper()
    return any(n.startswith(p) for p in _PREFIXOS_PROVISORIOS)


# ── Montagem ──────────────────────────────────────────────────────────────────
def montar(analise: dict, decisao: str, usuario_id: str, origem: str,
           observacao: Optional[str] = None, previsao_pcp: Optional[str] = None) -> Optional[dict]:
    """O jsonb da pendência a partir da análise de disponibilidade.

    Devolve None quando não sobrou saldo — sem falta, sem pendência.

    Os itens ficam gravados com a quantidade e o preço do momento da decisão. É
    um retrato de propósito: quando o material chegar, o comercial precisa saber
    o que foi prometido, não o que o estoque diz hoje.
    """
    pendentes = disponibilidade_service.itens_pendentes(analise)
    if not pendentes:
        return None
    return {
        "decisao": decisao,
        "origem": origem,
        "decidido_em": _agora(),
        "decidido_por": usuario_id,
        "observacao": (observacao or "").strip() or None,
        "valor": round(sum(float(i.get("valor_pendente") or 0) for i in pendentes), 2),
        "itens": pendentes,
        "previsao_sa": analise.get("previsao_sa"),
        "cobre_com_sa": analise.get("cobre_com_sa"),
        "previsao_pcp": previsao_pcp,
        "resolvido_em": None,
        "resolucao": None,
    }


def _dias(iso: Optional[str]) -> Optional[int]:
    if not iso:
        return None
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
    except Exception:
        return None
    if d.tzinfo is None:
        d = d.replace(tzinfo=timezone.utc)
    return max(0, (datetime.now(timezone.utc) - d).days)


def _acao(ov: Optional[dict], fonte: str = "oportunidade") -> tuple:
    """(acao, motivo_bloqueio) para a pendência cuja OV é `ov` (None = sem OV)."""
    if not ov:
        return "GERAR_OV", None
    status = ov.get("status")
    if status == "CANCELADO":
        if fonte == "pedido":
            # Venda outbound: a pendência mora na própria OV, então OV cancelada
            # é venda cancelada — não há saldo a entregar.
            return None, (f"A OV {ov.get('numero_pedido')} foi cancelada — a venda não existe "
                          "mais, então não há saldo para liberar.")
        # Venda do CRM: a OV cancelada é história. A venda segue de pé e o saldo
        # merece uma OV nova. Bloquear aqui deixava a pendência presa para sempre
        # a uma OV que ninguém vai mais usar.
        return "GERAR_OV", None
    if _provisorio(ov.get("numero_pedido")):
        # Operações de vendas ainda não completou o número real. Somar na mesma
        # OV é melhor do que criar remessa: o D365 não emitiu nada ainda.
        return "SOMAR_R1", None
    if status in _JA_SAIU:
        return "REMESSA_2", None
    return "SOMAR_R1", None


# ── Listagem ──────────────────────────────────────────────────────────────────
def _ov_por_ids(db, ids: list) -> dict:
    ids = [i for i in ids if i]
    if not ids:
        return {}
    out: dict = {}
    for i in range(0, len(ids), 40):
        rows = db.table("pedidos").select("id, numero_pedido, status, remessa_numero, cliente_id")\
            .in_("id", ids[i:i + 40]).execute().data
        for r in rows:
            out[r["id"]] = r
    return out


def _nomes_clientes(db, ids: list) -> dict:
    ids = [i for i in set(ids) if i]
    if not ids:
        return {}
    out: dict = {}
    for i in range(0, len(ids), 40):
        rows = db.table("clientes").select("id, nome").in_("id", ids[i:i + 40]).execute().data
        for r in rows:
            out[r["id"]] = r.get("nome")
    return out


def listar(incluir_resolvidas: bool = False) -> dict:
    """Todas as pendências abertas, dos dois fluxos, num formato só.

    Alimenta a coluna "Pendência de estoque" do kanban do CRM e a aba Pendências
    do Painel Comercial — a mesma verdade nas duas telas.
    """
    db = get_service_db()

    try:
        opps = db.table("crm_oportunidades").select(
            "id, titulo, cliente_id, canal, estagio, pendencia, gerado_ov_id, gerado_ov_ref, criado_em"
        ).eq("ativo", True).not_is("pendencia", "null").execute().data
    except Exception:
        # Migration v29 pendente: sem a coluna não há pendência para listar, e
        # devolver vazio é melhor do que derrubar o painel inteiro com 400.
        opps = []
    try:
        peds = db.table("pedidos").select(
            "id, numero_pedido, status, cliente_id, canal, pendencia, remessa_numero, criado_em"
        ).not_is("pendencia", "null").execute().data
    except Exception:
        peds = []

    ov_ids = [o.get("gerado_ov_id") for o in opps]
    ovs = _ov_por_ids(db, ov_ids)
    clientes = _nomes_clientes(
        db, [o.get("cliente_id") for o in opps] + [p.get("cliente_id") for p in peds])

    saida = []

    for o in opps:
        pend = o.get("pendencia") or {}
        if not incluir_resolvidas and pend.get("resolvido_em"):
            continue
        ov = ovs.get(o.get("gerado_ov_id"))
        acao, bloqueio = _acao(ov, "oportunidade")
        saida.append(_serializar(
            fonte="oportunidade", registro_id=o["id"], titulo=o.get("titulo"),
            cliente=clientes.get(o.get("cliente_id")), cliente_id=o.get("cliente_id"),
            canal=o.get("canal"), ov=ov, pend=pend, acao=acao, bloqueio=bloqueio,
            extra={"estagio": o.get("estagio"), "oportunidade_id": o["id"]}))

    for p in peds:
        pend = p.get("pendencia") or {}
        if not incluir_resolvidas and pend.get("resolvido_em"):
            continue
        acao, bloqueio = _acao(p, "pedido")
        saida.append(_serializar(
            fonte="pedido", registro_id=p["id"],
            titulo=f"Venda outbound {p.get('numero_pedido')}",
            cliente=clientes.get(p.get("cliente_id")), cliente_id=p.get("cliente_id"),
            canal=p.get("canal"), ov=p, pend=pend, acao=acao, bloqueio=bloqueio,
            extra={"oportunidade_id": None}))

    # Maior valor primeiro: é onde o dinheiro parado está.
    saida.sort(key=lambda x: -(x.get("valor") or 0))
    return {
        "pendencias": saida,
        "total": round(sum(x.get("valor") or 0 for x in saida), 2),
        "quantidade": len(saida),
        "aguardando": sum(1 for x in saida if x.get("decisao") == "AGUARDAR"),
        "parciais": sum(1 for x in saida if x.get("decisao") == "PARCIAL"),
    }


def _serializar(fonte, registro_id, titulo, cliente, cliente_id, canal,
                ov, pend, acao, bloqueio, extra) -> dict:
    itens = pend.get("itens") or []
    return {
        "fonte": fonte,
        "id": registro_id,
        "titulo": titulo,
        "cliente": cliente,
        "cliente_id": cliente_id,
        "canal": canal,
        "ov_id": (ov or {}).get("id"),
        "ov_ref": (ov or {}).get("numero_pedido"),
        "ov_status": (ov or {}).get("status"),
        "ov_provisoria": _provisorio((ov or {}).get("numero_pedido")),
        "decisao": pend.get("decisao"),
        "origem": pend.get("origem"),
        "valor": round(float(pend.get("valor") or 0), 2),
        "qtd_total": round(sum(float(i.get("qtd_pendente") or 0) for i in itens), 3),
        "itens": itens,
        "previsao_sa": pend.get("previsao_sa"),
        "previsao_pcp": pend.get("previsao_pcp"),
        "cobre_com_sa": pend.get("cobre_com_sa"),
        "observacao": pend.get("observacao"),
        "decidido_em": pend.get("decidido_em"),
        "dias_parada": _dias(pend.get("decidido_em")),
        "resolvido_em": pend.get("resolvido_em"),
        "resolucao": pend.get("resolucao"),
        "acao_liberar": acao,
        "pode_liberar": bool(acao),
        "motivo_bloqueio": bloqueio,
        **(extra or {}),
    }


# ── Liberação ─────────────────────────────────────────────────────────────────
def _ler(db, fonte: str, registro_id: str) -> tuple:
    """(registro, pendencia). Erra alto se não houver pendência aberta."""
    tabela = "crm_oportunidades" if fonte == "oportunidade" else "pedidos"
    rows = db.table(tabela).select("*").eq("id", registro_id).execute().data
    if not rows:
        raise HTTPException(status_code=404, detail="Registro não encontrado.")
    reg = rows[0]
    pend = reg.get("pendencia") or None
    if not pend:
        raise HTTPException(status_code=404, detail="Este registro não tem pendência de estoque.")
    if pend.get("resolvido_em"):
        raise HTTPException(status_code=409, detail="Esta pendência já foi liberada.")
    return reg, pend


def liberar(fonte: str, registro_id: str, usuario: UsuarioOut,
            parcial: bool = False, observacao: Optional[str] = None) -> dict:
    """Manda o saldo para a expedição, agora que existe material.

    Confere o estoque OUTRA VEZ antes de liberar. Sem isso o app repetiria o erro
    que esta feature existe para evitar: prometer material que não está lá — a
    pendência pode ter ficado dias parada e outra OV pode ter consumido a
    produção nesse meio tempo.

    `parcial=True` libera só o que já dá e mantém o resto pendente.
    """
    from app.models.schemas import ItemPedidoCreate, PedidoCreate
    from app.services import pedido_service

    if fonte not in ("oportunidade", "pedido"):
        raise HTTPException(status_code=400, detail="Origem de pendência inválida.")

    db = get_service_db()
    reg, pend = _ler(db, fonte, registro_id)
    itens_pend = pend.get("itens") or []
    if not itens_pend:
        raise HTTPException(status_code=422, detail="A pendência não tem itens para liberar.")

    ov = None
    if fonte == "oportunidade":
        if reg.get("gerado_ov_id"):
            ov = (_ov_por_ids(db, [reg["gerado_ov_id"]]) or {}).get(reg["gerado_ov_id"])
    else:
        ov = reg
    acao, bloqueio = _acao(ov, fonte)
    if not acao:
        raise HTTPException(status_code=409, detail=bloqueio)
    # OV cancelada numa venda do CRM: abre uma nova em vez de tentar derivar dela.
    if acao == "GERAR_OV" and fonte == "oportunidade" and ov and ov.get("status") == "CANCELADO":
        ov = None

    # ── Reconfere o estoque ───────────────────────────────────────────────────
    analise = disponibilidade_service.analisar([{
        "ref": idx,
        "produto_id": i.get("produto_id"),
        "codigo": i.get("codigo"),
        "descricao": i.get("descricao"),
        "qtd": float(i.get("qtd_pendente") or 0),
        "valor_unitario": float(i.get("valor_unitario") or 0),
    } for idx, i in enumerate(itens_pend)], sincronizar=True)

    if analise.get("tem_falta") and not parcial:
        raise HTTPException(status_code=409, detail={
            "tipo": "ESTOQUE_INSUFICIENTE",
            "msg": "O material ainda não chegou por completo. Libere só o que já tem, "
                   "ou espere o restante.",
            "analise": analise,
        })

    a_liberar = disponibilidade_service.itens_atendidos(analise)
    if not a_liberar:
        raise HTTPException(status_code=409, detail={
            "tipo": "ESTOQUE_INSUFICIENTE",
            "msg": "Nenhuma unidade disponível ainda — não há o que liberar.",
            "analise": analise,
        })

    itens_ov = [ItemPedidoCreate(
        produto_id=i["produto_id"],
        qtd_solicitada=float(i["qtd_atendida"]),
        valor_unitario=float(i.get("valor_unitario") or 0) or None,
    ) for i in a_liberar if i.get("produto_id")]
    if not itens_ov:
        raise HTTPException(
            status_code=422,
            detail="Os itens da pendência não têm produto cadastrado — não dá para gerar a remessa.")

    resultado_ov = None
    if acao == "REMESSA_2":
        resultado_ov = pedido_service.criar_pedido(PedidoCreate(
            numero_pedido=ov["numero_pedido"],
            cliente_id=reg.get("cliente_id") or ov.get("cliente_id"),
            data_prevista_entrega=_hoje_brt() + timedelta(days=7),
            itens=itens_ov,
            criar_derivada=True,
            observacoes=f"Remessa do saldo que estava pendente de estoque. {observacao or ''}".strip(),
        ), usuario)
    elif acao == "SOMAR_R1":
        resultado_ov = _somar_na_ov(db, ov, a_liberar, usuario)
    else:  # GERAR_OV
        resultado_ov = _gerar_ov_do_saldo(db, reg, a_liberar, usuario)

    # ── Baixa (ou reduz) a pendência ──────────────────────────────────────────
    restante = disponibilidade_service.itens_pendentes(analise)
    agora = _agora()
    if restante:
        # Liberação parcial: o que ainda falta continua pendente, com o valor
        # recalculado. A pendência não pode "desaparecer" com saldo aberto.
        nova = {**pend,
                "itens": restante,
                "valor": round(sum(float(i.get("valor_pendente") or 0) for i in restante), 2),
                "liberado_parcial_em": agora}
    else:
        nova = {**pend, "resolvido_em": agora, "resolucao": acao,
                "resolvido_por": str(usuario.id)}

    tabela = "crm_oportunidades" if fonte == "oportunidade" else "pedidos"
    db.table(tabela).update({"pendencia": nova, "atualizado_em": agora}).eq("id", registro_id).execute()

    return {
        "ok": True,
        "acao": acao,
        "ov": resultado_ov,
        "liberados": a_liberar,
        "ainda_pendente": restante,
        "pendencia": nova,
    }


def _somar_na_ov(db, ov: dict, itens: list, usuario: UsuarioOut) -> dict:
    """Aumenta a quantidade na própria OV, que ainda não saiu.

    Nada foi expedido nem faturado, então uma nota cobre tudo — criar remessa
    aqui só geraria duas notas para uma entrega só.
    """
    from app.services import pedido_service

    atuais = db.table("itens_pedido").select("id, produto_id, qtd_solicitada")\
        .eq("pedido_id", ov["id"]).execute().data
    por_produto: dict = {}
    for it in atuais:
        por_produto.setdefault(it.get("produto_id"), []).append(it)

    somados = []
    for i in itens:
        pid = i.get("produto_id")
        add = float(i.get("qtd_atendida") or 0)
        if not pid or add <= 0:
            continue
        existentes = por_produto.get(pid) or []
        if existentes:
            linha = existentes[0]
            nova_qtd = float(linha.get("qtd_solicitada") or 0) + add
            db.table("itens_pedido").update({"qtd_solicitada": nova_qtd}).eq("id", linha["id"]).execute()
        else:
            db.table("itens_pedido").insert({
                "pedido_id": ov["id"], "produto_id": pid,
                "qtd_solicitada": add,
                "valor_unitario": float(i.get("valor_unitario") or 0) or None,
                "status_item": "PENDENTE",
            }).execute()
        somados.append(f"{i.get('codigo') or pid} +{add:g}")

    from app.services.inventario_service import _get_usuario_real
    uid = _get_usuario_real(str(usuario.id))
    pedido_service._registrar_movimentacao(
        ov["id"], ov.get("status"), ov.get("status"), uid,
        "Saldo que estava pendente de estoque somado a esta OV (a OV ainda não "
        f"faturou, então segue em uma nota só): {', '.join(somados)}")
    return {"id": ov["id"], "numero_pedido": ov.get("numero_pedido"),
            "somado": somados, "remessa_numero": ov.get("remessa_numero") or 1}


def _gerar_ov_do_saldo(db, oportunidade: dict, itens: list, usuario: UsuarioOut) -> dict:
    """Decisão foi "aguardar produção": não havia OV nenhuma. O material chegou,
    então a OV nasce agora — no mesmo card do kanban em que toda venda ganha do
    CRM entra (AGUARD_DADOS_OV, esperando o número real do D365)."""
    from app.services import pedido_service

    stub = pedido_service.criar_pedido_stub_crm(
        oportunidade,
        [{"produto_id": i.get("produto_id"), "qtd": float(i.get("qtd_atendida") or 0),
          "valor_unitario": i.get("valor_unitario")} for i in itens],
        str(usuario.id))
    db.table("crm_oportunidades").update({
        "gerado_ov_id": stub["id"], "gerado_ov_ref": stub["numero_pedido"],
        "atualizado_em": _agora(),
    }).eq("id", oportunidade["id"]).execute()
    return stub

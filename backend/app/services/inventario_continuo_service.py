# -*- coding: utf-8 -*-
"""
Inventário Contínuo — Service Layer
"""
from datetime import datetime, timezone
from fastapi import HTTPException
from app.core.database import get_service_db
from app.models.schemas import CicloCreate, ContagemCreate, RevisarContagemRequest, UsuarioOut


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _get_uid(usuario: UsuarioOut) -> str:
    """Resolve UUID real do usuario (compatível com proxy auth)."""
    try:
        from app.services.inventario_service import _get_usuario_real
        return _get_usuario_real(str(usuario.id))
    except Exception:
        return str(usuario.id)


# ── Ciclos ─────────────────────────────────────────────────────────────────────

def listar_ciclos() -> list:
    db = get_service_db()
    ciclos = (
        db.table("inventario_ciclos")
        .select("*")
        .order("criado_em", desc=True)
        .limit(50)
        .execute()
    )
    result = []
    for c in ciclos.data:
        stats = _stats_ciclo(c["id"])
        result.append({**c, **stats})
    return result


def _stats_ciclo(ciclo_id: str) -> dict:
    db = get_service_db()
    contagens = (
        db.table("inventario_contagens")
        .select("status")
        .eq("ciclo_id", ciclo_id)
        .execute()
    ).data
    total = len(contagens)
    ok = sum(1 for c in contagens if c["status"] == "OK")
    em_analise = sum(1 for c in contagens if c["status"] in ("DIVERGENCIA", "EM_ANALISE"))
    acuracidade = round(ok / total * 100, 1) if total > 0 else 0
    return {
        "total_contagens": total,
        "contagens_ok": ok,
        "em_analise": em_analise,
        "acuracidade": acuracidade,
    }


def criar_ciclo(payload: CicloCreate, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    aberto = (
        db.table("inventario_ciclos")
        .select("id,nome")
        .eq("status", "ABERTO")
        .execute()
    )
    if aberto.data:
        raise HTTPException(
            400,
            f"Já existe o ciclo '{aberto.data[0]['nome']}' aberto. "
            "Encerre-o antes de criar um novo.",
        )
    result = db.table("inventario_ciclos").insert({
        "nome":           payload.nome,
        "data_abertura":  payload.data_abertura.isoformat(),
        "meta_itens":     payload.meta_itens,
        "status":         "ABERTO",
        "criado_por":     _get_uid(usuario),
        "criado_em":      _agora(),
        "atualizado_em":  _agora(),
    }).execute()
    return result.data[0]


def fechar_ciclo(ciclo_id: str, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    pendentes = (
        db.table("inventario_contagens")
        .select("id")
        .eq("ciclo_id", ciclo_id)
        .in_("status", ["DIVERGENCIA", "EM_ANALISE"])
        .execute()
    )
    if pendentes.data:
        raise HTTPException(
            400,
            f"Existem {len(pendentes.data)} divergência(s) sem tratativa. "
            "Resolva antes de encerrar o ciclo.",
        )
    result = db.table("inventario_ciclos").update({
        "status":           "ENCERRADO",
        "data_fechamento":  datetime.now(timezone.utc).date().isoformat(),
        "atualizado_em":    _agora(),
    }).eq("id", ciclo_id).execute()
    if not result.data:
        raise HTTPException(404, "Ciclo não encontrado")
    return result.data[0]


def get_ciclo_aberto() -> dict | None:
    db = get_service_db()
    res = (
        db.table("inventario_ciclos")
        .select("*")
        .eq("status", "ABERTO")
        .execute()
    )
    if not res.data:
        return None
    c = res.data[0]
    return {**c, **_stats_ciclo(c["id"])}


# ── Contagens ──────────────────────────────────────────────────────────────────

def listar_contagens(ciclo_id: str, status: str | None = None) -> list:
    db = get_service_db()
    q = (
        db.table("inventario_contagens")
        .select("*,inventario_motivos(descricao,categoria)")
        .eq("ciclo_id", ciclo_id)
    )
    if status:
        q = q.eq("status", status)
    return q.order("contado_em", desc=True).execute().data


def criar_contagem(ciclo_id: str, payload: ContagemCreate, usuario: UsuarioOut) -> dict:
    db = get_service_db()

    # Valida ciclo
    ciclo = db.table("inventario_ciclos").select("id,status").eq("id", ciclo_id).execute()
    if not ciclo.data:
        raise HTTPException(404, "Ciclo não encontrado")
    if ciclo.data[0]["status"] != "ABERTO":
        raise HTTPException(400, "Ciclo está encerrado — não é possível registrar contagens.")

    # Validações básicas
    if payload.qtd_fisica < 0:
        raise HTTPException(422, "Quantidade física não pode ser negativa.")
    if payload.qtd_venda < 0:
        raise HTTPException(422, "Quantidade de venda não pode ser negativa.")
    if payload.qtd_sistemica < 0:
        raise HTTPException(422, "Quantidade sistêmica não pode ser negativa.")

    # Divergência = Físico - Sistêmico  (comparação direta do que foi contado vs sistema)
    # Venda é informação de contexto (saídas pendentes no ERP), NÃO corrige a fórmula.
    # Se físico == sistêmico, não há divergência — mesmo que haja venda pendente.
    qtd_divergencia = payload.qtd_fisica - payload.qtd_sistemica
    pct = round(abs(qtd_divergencia) / payload.qtd_sistemica * 100, 2) if payload.qtd_sistemica > 0 else 0.0

    # Determina status
    if qtd_divergencia == 0:
        status = "OK"
    else:
        if not payload.motivo_id:
            raise HTTPException(422, "Motivo é obrigatório quando há divergência.")
        status = "EM_ANALISE"

    uid = _get_uid(usuario)
    result = db.table("inventario_contagens").insert({
        "ciclo_id":          ciclo_id,
        "codigo_produto":    payload.codigo_produto.strip().upper(),
        "descricao_produto": payload.descricao_produto,
        "lote":              payload.lote.strip().upper(),
        "operador_id":       uid,
        "operador_nome":     usuario.nome,
        "qtd_sistemica":     payload.qtd_sistemica,
        "qtd_fisica":        payload.qtd_fisica,
        "qtd_venda":         payload.qtd_venda,
        "qtd_divergencia":   qtd_divergencia,
        "pct_divergencia":   pct,
        "status":            status,
        "motivo_id":         payload.motivo_id,
        "observacao":        payload.observacao,
        "contado_em":        _agora(),
        "criado_em":         _agora(),
        "atualizado_em":     _agora(),
    }).execute()
    return result.data[0]


def revisar_contagem(contagem_id: str, payload: RevisarContagemRequest, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    contagem = db.table("inventario_contagens").select("id,status").eq("id", contagem_id).execute()
    if not contagem.data:
        raise HTTPException(404, "Contagem não encontrada")
    if contagem.data[0]["status"] not in ("DIVERGENCIA", "EM_ANALISE"):
        raise HTTPException(400, "Contagem não está pendente de revisão.")
    if payload.acao not in ("APROVAR", "RECONTAGEM"):
        raise HTTPException(422, "Ação deve ser 'APROVAR' ou 'RECONTAGEM'.")
    if payload.acao == "RECONTAGEM" and not (payload.instrucao_recontagem or "").strip():
        raise HTTPException(422, "Informe a instrução de recontagem.")

    novo_status = "AJUSTE_APROVADO" if payload.acao == "APROVAR" else "RECONTAGEM"
    uid = _get_uid(usuario)
    result = db.table("inventario_contagens").update({
        "status":               novo_status,
        "revisado_por":         uid,
        "revisado_em":          _agora(),
        "instrucao_recontagem": payload.instrucao_recontagem if novo_status == "RECONTAGEM" else None,
        "atualizado_em":        _agora(),
    }).eq("id", contagem_id).execute()
    return result.data[0]


# ── Motivos ────────────────────────────────────────────────────────────────────

def listar_motivos() -> list:
    db = get_service_db()
    return db.table("inventario_motivos").select("*").eq("ativo", True).order("descricao").execute().data


# ── Dashboard ──────────────────────────────────────────────────────────────────

def get_dashboard(ciclo_id: str | None = None) -> dict:
    db = get_service_db()
    if not ciclo_id:
        ciclo_aberto = db.table("inventario_ciclos").select("id,nome,data_abertura,meta_itens").eq("status", "ABERTO").execute()
        if not ciclo_aberto.data:
            return {"sem_ciclo_aberto": True}
        ciclo_id = ciclo_aberto.data[0]["id"]
        ciclo_info = ciclo_aberto.data[0]
    else:
        ciclo_info = db.table("inventario_ciclos").select("id,nome,data_abertura,meta_itens").eq("id", ciclo_id).execute().data[0]

    contagens = db.table("inventario_contagens").select("status,qtd_divergencia,operador_nome,codigo_produto").eq("ciclo_id", ciclo_id).execute().data

    total      = len(contagens)
    ok         = sum(1 for c in contagens if c["status"] == "OK")
    em_analise = sum(1 for c in contagens if c["status"] in ("DIVERGENCIA", "EM_ANALISE"))
    aprovados  = sum(1 for c in contagens if c["status"] == "AJUSTE_APROVADO")
    acuracidade = round(ok / total * 100, 1) if total > 0 else 0

    # Por operador
    por_operador: dict = {}
    for c in contagens:
        nome = c["operador_nome"]
        por_operador[nome] = por_operador.get(nome, 0) + 1

    return {
        "ciclo_id":         ciclo_id,
        "ciclo_nome":       ciclo_info["nome"],
        "data_abertura":    ciclo_info["data_abertura"],
        "meta_itens":       ciclo_info.get("meta_itens"),
        "total_contagens":  total,
        "contagens_ok":     ok,
        "em_analise":       em_analise,
        "ajustes_aprovados": aprovados,
        "acuracidade":      acuracidade,
        "por_operador":     [{"nome": k, "total": v} for k, v in sorted(por_operador.items(), key=lambda x: -x[1])],
    }


# ── Histórico ──────────────────────────────────────────────────────────────────

def buscar_historico(codigo: str | None, lote: str | None, operador: str | None) -> list:
    db = get_service_db()
    q = db.table("inventario_contagens").select(
        "*,inventario_ciclos(nome,data_abertura),inventario_motivos(descricao,categoria)"
    )
    if codigo:
        q = q.ilike("codigo_produto", f"%{codigo.strip().upper()}%")
    if lote:
        q = q.ilike("lote", f"%{lote.strip().upper()}%")
    if operador:
        q = q.ilike("operador_nome", f"%{operador.strip()}%")
    return q.order("contado_em", desc=True).limit(200).execute().data

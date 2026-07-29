"""CRM · Empresas — prospecção, qualificação e o ciclo de 1 ano.

O processo real tem dois BANCOS de empresas, não um funil de leads:

  PROSPECTADA  empresa mapeada com o básico (CNPJ, cidade, tipo, porte), guardada
               para ser trabalhada um dia. Não precisa ter chance de compra ainda.
  QUALIFICADA  já sabemos o que compra, quem decide e quando — vira oportunidade.

E o ciclo: **1 ano sem movimentação e a empresa volta a PROSPECTADA**, porque as
informações provavelmente mudaram. A qualificação antiga NÃO se perde — vai para
`crm_qualificacao_historico`, e quem requalificar vê o que valia antes em vez de
começar de uma tela branca.

Por isso "empresa" e não "lead": lead é abstração de uso único (nasce, converte ou
morre), e aqui a mesma empresa é qualificada várias vezes ao longo dos anos.

O score tem um componente de PERFIL que já pontua na prospecção (tipo + porte) —
sem ele toda empresa prospectada teria score 0 e não haveria como priorizar quem
trabalhar primeiro, que é justamente o ponto de manter o banco mapeado.
"""
import re
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.schemas import EmpresaCreate, EmpresaUpdate, OportunidadeCreate, UsuarioOut

ESTADOS = ["PROSPECTADA", "QUALIFICADA", "CLIENTE", "DESCARTADA"]

TIPOS_EMPRESA = {
    "HOSPITAL": ("Hospital", 8),
    "DISTRIBUIDOR": ("Distribuidor", 8),
    "CLINICA": ("Clínica", 5),
    "LABORATORIO": ("Laboratório", 3),
    "OUTRO": ("Outro", 2),
}
PORTES = {
    "GRANDE": ("Grande", 7),
    "MEDIO": ("Médio", 4),
    "PEQUENO": ("Pequeno", 2),
}

PAPEIS = {
    "COMPRADOR": ("Comprador / Suprimentos", 10),
    "DIRETOR_TECNICO": ("Diretor técnico", 10),
    "CHEFE_SERVICO": ("Chefe de serviço", 10),
    "ADMINISTRADOR": ("Administrador / Diretoria", 10),
    "FARMACIA": ("Farmácia hospitalar", 6),
    "OUTRO": ("Outro", 4),
}

JANELAS = {
    "ATE_30D": ("Até 30 dias", 20),
    "30_60D": ("30 a 60 dias", 15),
    "60_90D": ("60 a 90 dias", 10),
    "ACIMA_90D": ("Acima de 90 dias", 5),
    "SEM_PREVISAO": ("Sem previsão", 0),
}

MOTIVOS_DESCARTE = {
    "SEM_PERFIL": "Não é perfil de cliente",
    "SEM_VERBA": "Sem verba / sem orçamento",
    "SEM_RESPOSTA": "Não responde há muito tempo",
    "JA_TEM_FORNECEDOR": "Já tem fornecedor fechado",
    "PRODUTO_NAO_ATENDE": "Nosso produto não atende",
    "DUPLICADO": "Empresa duplicada",
    "ENCERROU": "Empresa encerrou atividades",
    "OUTRO": "Outro",
}

FONTES = ["Prospecção fria", "Indicação", "Congresso/Evento", "CNES", "Inbound",
          "Cliente recorrente", "Lista pública", "Outro"]

_FAIXAS_VOLUME = [(50000, 15), (20000, 11), (5000, 7), (0.01, 3)]

# Ciclo de retorno: 1 ano sem movimentação real.
DIAS_CICLO_RETORNO = 365

# Inatividade no score. Teto alto de propósito: empresa qualificada e esquecida há
# meses não pode continuar aparecendo como quente.
_DIAS_TOLERANCIA = 14
_PENALIDADE_SEMANA = 5
_PENALIDADE_MAX = 45


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hoje() -> date:
    return (datetime.now(timezone.utc) - timedelta(hours=3)).date()


def _dt(valor) -> Optional[datetime]:
    if not valor:
        return None
    try:
        d = datetime.fromisoformat(str(valor).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def _so_digitos(v: Optional[str]) -> Optional[str]:
    d = re.sub(r"\D", "", v or "")
    return d or None


# ── Qualificação ────────────────────────────────────────────────────────────────

def _tem_necessidade(q: dict) -> bool:
    n = (q or {}).get("necessidade") or {}
    tem_item = bool((n.get("familia") or "").strip() or (n.get("codigos") or []))
    return tem_item and float(n.get("consumo_mes") or 0) > 0


def _tem_decisor(q: dict) -> bool:
    d = (q or {}).get("decisor") or {}
    return bool((d.get("nome") or "").strip()) and d.get("papel") in PAPEIS


def _tem_prazo(q: dict) -> bool:
    p = (q or {}).get("prazo") or {}
    if p.get("tipo") == "DATA":
        return bool(p.get("data"))
    if p.get("tipo") == "JANELA":
        return p.get("janela") in JANELAS
    return False


def checklist_qualificacao(qualificacao: Optional[dict]) -> list:
    """O que falta para qualificar. A tela cobra item por item em vez de dar erro
    genérico depois de tentar avançar."""
    q = qualificacao or {}
    n = q.get("necessidade") or {}
    d = q.get("decisor") or {}
    p = q.get("prazo") or {}
    consumo = float(n.get("consumo_mes") or 0)

    if p.get("tipo") == "DATA" and p.get("data"):
        det_prazo = f"prevista para {p['data']}"
    elif p.get("janela") in JANELAS:
        det_prazo = JANELAS[p["janela"]][0]
    else:
        det_prazo = "sem prazo informado"

    return [
        {"chave": "necessidade", "label": "O que compra e quanto por mês",
         "ok": _tem_necessidade(q),
         "detalhe": (f"{n.get('familia') or 'itens informados'} · {consumo:g} {n.get('unidade') or 'un'}/mês"
                     if _tem_necessidade(q) else "informe a família ou os códigos e o consumo mensal")},
        {"chave": "decisor", "label": "Quem decide a compra",
         "ok": _tem_decisor(q),
         "detalhe": (f"{d.get('nome')} — {PAPEIS[d['papel']][0]}"
                     if _tem_decisor(q) else "informe nome e papel de quem assina")},
        {"chave": "prazo", "label": "Quando pretende comprar",
         "ok": _tem_prazo(q), "detalhe": det_prazo},
    ]


def _faltando(qualificacao: Optional[dict]) -> list:
    return [c["label"] for c in checklist_qualificacao(qualificacao) if not c["ok"]]


# ── Score ───────────────────────────────────────────────────────────────────────

def _contexto(db) -> dict:
    """Dados compartilhados do scoring, carregados UMA vez (senão seria uma
    consulta por empresa na listagem)."""
    prods = db.table("produtos").select("id, codigo").eq("ativo", True).execute().data
    codigos = {(p.get("codigo") or "").strip().upper() for p in prods if p.get("codigo")}
    id_por_cod = {(p.get("codigo") or "").strip().upper(): p["id"] for p in prods if p.get("codigo")}
    cod_por_id = {v: k for k, v in id_por_cod.items()}

    # Preço de referência = média do que já vendemos. `produtos` não tem preço, e o
    # histórico é a referência mais honesta disponível.
    soma: dict = {}
    for it in db.table("itens_pedido").select("produto_id, valor_unitario").limit(20000).execute().data:
        v = float(it.get("valor_unitario") or 0)
        pid = it.get("produto_id")
        if pid and v > 0:
            s, q = soma.get(pid, (0.0, 0))
            soma[pid] = (s + v, q + 1)
    precos = {cod_por_id[pid]: s / q for pid, (s, q) in soma.items() if pid in cod_por_id and q}

    limite = (datetime.now(timezone.utc) - timedelta(days=365)).isoformat()
    peds = db.table("pedidos").select("cliente_id").gte("criado_em", limite)\
        .neq("status", "CANCELADO").limit(20000).execute().data
    ativos = {p["cliente_id"] for p in peds if p.get("cliente_id")}
    return {"codigos": codigos, "precos": precos, "clientes_ativos": ativos}


def _valor_mensal(q: dict, ctx: dict) -> float:
    n = (q or {}).get("necessidade") or {}
    consumo = float(n.get("consumo_mes") or 0)
    if consumo <= 0:
        return 0.0
    cods = [str(c).strip().upper() for c in (n.get("codigos") or []) if str(c).strip()]
    precos = [ctx["precos"][c] for c in cods if c in ctx["precos"]]
    if precos:
        return consumo * (sum(precos) / len(precos))
    return float(n.get("valor_mensal_estimado") or 0)


def calcular_score(emp: dict, ctx: dict) -> tuple:
    """(score 0-100, detalhe explicável).

    Perfil (15) pontua já na prospecção; o resto depende da qualificação. Assim uma
    empresa recém-mapeada tem como ser priorizada sem inventar dado que não temos.
    """
    q = emp.get("qualificacao") or {}
    partes = []

    # ── Perfil da empresa (15) — único componente disponível antes de qualificar.
    pt_tipo = TIPOS_EMPRESA.get(emp.get("tipo"), ("", 0))[1]
    pt_porte = PORTES.get(emp.get("porte"), ("", 0))[1]
    pts = min(15, pt_tipo + pt_porte)
    rot = " · ".join(x for x in [
        TIPOS_EMPRESA.get(emp.get("tipo"), ("",))[0] or None,
        PORTES.get(emp.get("porte"), ("",))[0] or None,
    ] if x) or "tipo/porte não informados"
    partes.append({"chave": "perfil", "label": "Perfil da empresa", "pontos": pts, "max": 15, "obs": rot})

    # ── Encaixe comercial (30)
    n = q.get("necessidade") or {}
    cods = [str(c).strip().upper() for c in (n.get("codigos") or []) if str(c).strip()]
    if cods:
        conhecidos = [c for c in cods if c in ctx["codigos"]]
        if len(conhecidos) == len(cods):
            pts, obs = 15, f"{len(cods)} item(ns) do nosso portfólio"
        elif conhecidos:
            pts, obs = 9, f"{len(conhecidos)} de {len(cods)} itens são nossos"
        else:
            pts, obs = 0, "nenhum dos códigos é do nosso portfólio"
    elif (n.get("familia") or "").strip():
        pts, obs = 7, "família informada, sem códigos"
    else:
        pts, obs = 0, "não sabemos o que ela compra"
    partes.append({"chave": "portfolio", "label": "Produto atende", "pontos": pts, "max": 15, "obs": obs})

    vm = _valor_mensal(q, ctx)
    pts, obs = 0, "volume não estimável"
    for piso, p in _FAIXAS_VOLUME:
        if vm >= piso:
            pts, obs = p, f"~R$ {vm:,.0f}/mês".replace(",", ".")
            break
    partes.append({"chave": "volume", "label": "Volume relevante", "pontos": pts, "max": 15, "obs": obs})

    # ── Intenção (40)
    p = q.get("prazo") or {}
    if p.get("tipo") == "DATA" and p.get("data"):
        try:
            dias = (date.fromisoformat(str(p["data"])[:10]) - _hoje()).days
        except Exception:
            dias = 999
        pts = 20 if dias <= 30 else 15 if dias <= 60 else 10 if dias <= 90 else 5
        obs = f"compra prevista em {max(dias, 0)} dia(s)"
    elif p.get("janela") in JANELAS:
        rotulo, pts = JANELAS[p["janela"]]
        obs = rotulo.lower()
    else:
        pts, obs = 0, "sem prazo definido"
    partes.append({"chave": "prazo", "label": "Prazo de compra", "pontos": pts, "max": 20, "obs": obs})

    d = q.get("decisor") or {}
    if d.get("papel") in PAPEIS and (d.get("nome") or "").strip():
        rotulo, pts = PAPEIS[d["papel"]]
        obs = f"{d['nome']} — {rotulo}"
    else:
        pts, obs = 0, "decisor não mapeado"
    partes.append({"chave": "decisor", "label": "Decisor mapeado", "pontos": pts, "max": 10, "obs": obs})

    v = q.get("verba") or {}
    if v.get("confirmada"):
        pts, obs = 10, "verba confirmada"
    elif v:
        pts, obs = 3, "verba mencionada, não confirmada"
    else:
        pts, obs = 0, "verba não verificada"
    partes.append({"chave": "verba", "label": "Verba", "pontos": pts, "max": 10, "obs": obs})

    # ── Relacionamento (15)
    cid = emp.get("cliente_id")
    if cid and cid in ctx["clientes_ativos"]:
        pts, obs = 15, "já compra da gente (últimos 12 meses)"
    elif cid:
        pts, obs = 8, "está na base, sem compra recente"
    else:
        pts, obs = 0, "empresa nova"
    partes.append({"chave": "relacionamento", "label": "Relacionamento", "pontos": pts, "max": 15, "obs": obs})

    bruto = sum(x["pontos"] for x in partes)

    # ── Inatividade
    penalidade, obs_inativo = 0, "movimentação recente"
    ref = _dt(emp.get("ultima_movimentacao_em") or emp.get("criado_em"))
    if ref:
        dias = (datetime.now(timezone.utc) - ref).days
        if dias > _DIAS_TOLERANCIA:
            semanas = (dias - _DIAS_TOLERANCIA) // 7 + 1
            penalidade = min(_PENALIDADE_MAX, semanas * _PENALIDADE_SEMANA)
            obs_inativo = f"{dias} dias sem movimentação"
    if penalidade:
        partes.append({"chave": "inatividade", "label": "Inatividade",
                       "pontos": -penalidade, "max": 0, "obs": obs_inativo})

    score = max(0, min(100, bruto - penalidade))
    return score, {"total": score, "bruto": bruto, "penalidade": penalidade, "partes": partes}


def _temperatura(score: int) -> str:
    return "QUENTE" if score >= 70 else "MORNO" if score >= 40 else "FRIO"


# ── Ciclo de 1 ano ──────────────────────────────────────────────────────────────

def _aplicar_ciclo_retorno(db, emp: dict, usuario_id: Optional[str] = None) -> dict:
    """1 ano sem movimentação: QUALIFICADA volta a PROSPECTADA.

    A qualificação vigente é arquivada em `crm_qualificacao_historico` antes de ser
    limpa — o processo exige que a informação não se perca, e quem requalificar
    compara com o que valia antes.

    Roda na leitura (não em job agendado) para o estado estar sempre correto sem
    depender de agendador de pé.
    """
    if emp.get("estado") != "QUALIFICADA":
        return emp
    ref = _dt(emp.get("ultima_movimentacao_em")) or _dt(emp.get("qualificada_em")) or _dt(emp.get("criado_em"))
    if not ref or (datetime.now(timezone.utc) - ref).days < DIAS_CICLO_RETORNO:
        return emp

    agora = _agora()
    if emp.get("qualificacao"):
        db.table("crm_qualificacao_historico").insert({
            "empresa_id": emp["id"],
            "dados": emp["qualificacao"],
            "score": emp.get("score"),
            "qualificada_em": emp.get("qualificada_em"),
            "encerrada_em": agora,
            "motivo_encerramento": "RETORNO_1_ANO",
            "responsavel_id": usuario_id or emp.get("responsavel_id"),
        }).execute()

    update = {
        "estado": "PROSPECTADA",
        "qualificacao": None,
        "qualificada_em": None,
        "ciclos_retorno": int(emp.get("ciclos_retorno") or 0) + 1,
        "retornou_em": agora,
        "atualizado_em": agora,
    }
    db.table("crm_empresas").update(update).eq("id", emp["id"]).execute()
    return {**emp, **update}


def qualificacao_anterior(db, empresa_id: str) -> Optional[dict]:
    """Última qualificação arquivada — mostrada na requalificação para comparar."""
    rows = db.table("crm_qualificacao_historico").select("*")\
        .eq("empresa_id", empresa_id).order("encerrada_em", desc=True).limit(1).execute().data
    return rows[0] if rows else None


def registrar_movimentacao(db, empresa_id: Optional[str]) -> None:
    """Zera o relógio do ciclo. Chamada nos eventos que são movimentação de
    verdade — contato, atividade, etapa, proposta — e não em qualquer edição de
    cadastro (corrigir um telefone não deveria reiniciar o ano)."""
    if not empresa_id:
        return
    db.table("crm_empresas").update({"ultima_movimentacao_em": _agora()}).eq("id", empresa_id).execute()


# ── Serialização ────────────────────────────────────────────────────────────────

def _serializar(e: dict, anterior: Optional[dict] = None) -> dict:
    checklist = checklist_qualificacao(e.get("qualificacao"))
    ref = _dt(e.get("ultima_movimentacao_em") or e.get("criado_em"))
    dias_sem_mov = (datetime.now(timezone.utc) - ref).days if ref else None
    dias_para_retorno = (DIAS_CICLO_RETORNO - dias_sem_mov
                         if e.get("estado") == "QUALIFICADA" and dias_sem_mov is not None else None)
    return {
        "id": e["id"],
        "cnpj": e.get("cnpj"),
        "razao_social": e.get("razao_social"),
        "nome_fantasia": e.get("nome_fantasia"),
        "cidade": e.get("cidade"),
        "uf": e.get("uf"),
        "tipo": e.get("tipo"),
        "tipo_label": TIPOS_EMPRESA.get(e.get("tipo"), ("",))[0] or None,
        "porte": e.get("porte"),
        "porte_label": PORTES.get(e.get("porte"), ("",))[0] or None,
        "canal": e.get("canal"),
        "fonte": e.get("fonte"),
        "estado": e.get("estado"),
        "qualificacao": e.get("qualificacao"),
        "qualificada_em": e.get("qualificada_em"),
        "checklist": checklist,
        "pode_qualificar": all(c["ok"] for c in checklist),
        "falta_para_qualificar": [c["label"] for c in checklist if not c["ok"]],
        "score": e.get("score"),
        "temperatura": e.get("temperatura"),
        "score_detalhe": e.get("score_detalhe"),
        "ultima_movimentacao_em": e.get("ultima_movimentacao_em"),
        "dias_sem_movimentacao": dias_sem_mov,
        # Aviso de que a empresa está perto de voltar para prospecção.
        "dias_para_retorno": dias_para_retorno,
        "ciclos_retorno": e.get("ciclos_retorno") or 0,
        "retornou_em": e.get("retornou_em"),
        # Preenchido em obter_empresa: a qualificação de antes do retorno.
        "qualificacao_anterior": anterior,
        "proximo_passo": e.get("proximo_passo"),
        "proximo_passo_em": e.get("proximo_passo_em"),
        "proximo_passo_atrasado": bool(
            e.get("proximo_passo_em") and str(e["proximo_passo_em"])[:10] < _hoje().isoformat()
            and e.get("estado") in ("PROSPECTADA", "QUALIFICADA")
        ),
        "cliente_id": e.get("cliente_id"),
        "cliente": (e.get("clientes") or {}).get("nome") if e.get("clientes") else None,
        "motivo_descarte_codigo": e.get("motivo_descarte_codigo"),
        "motivo_descarte": e.get("motivo_descarte"),
        "observacao": e.get("observacao"),
        "criado_em": e.get("criado_em"),
    }


# ── Consultas ───────────────────────────────────────────────────────────────────

def listar_empresas(estado: Optional[str] = None) -> list:
    """Empresas ativas, mais quentes primeiro.

    Aplica o ciclo de 1 ano e recalcula o score na leitura: os dois DECAEM com o
    tempo, e precisam refletir hoje sem depender de alguém ter editado o registro.
    """
    db = get_service_db()
    rows = db.table("crm_empresas").select("*, clientes(nome)").eq("ativo", True).execute().data
    if not rows:
        return []

    ctx = _contexto(db)
    saida = []
    for r in rows:
        r = _aplicar_ciclo_retorno(db, r)
        score, detalhe = calcular_score(r, ctx)
        if score != r.get("score"):
            db.table("crm_empresas").update({
                "score": score, "temperatura": _temperatura(score), "score_detalhe": detalhe,
            }).eq("id", r["id"]).execute()
        r = {**r, "score": score, "temperatura": _temperatura(score), "score_detalhe": detalhe}
        if estado and r.get("estado") != estado:
            continue
        saida.append(_serializar(r))
    saida.sort(key=lambda x: -(x["score"] or 0))
    return saida


def obter_empresa(empresa_id: str) -> dict:
    db = get_service_db()
    r = db.table("crm_empresas").select("*, clientes(nome)").eq("id", empresa_id).single().execute().data
    if not r:
        raise HTTPException(status_code=404, detail="Empresa não encontrada")
    r = _aplicar_ciclo_retorno(db, r)
    score, detalhe = calcular_score(r, _contexto(db))
    anterior = qualificacao_anterior(db, empresa_id)
    return _serializar({**r, "score": score, "temperatura": _temperatura(score),
                        "score_detalhe": detalhe}, anterior)


def opcoes() -> dict:
    """Vocabulário do fluxo — a tela não repete listas em código."""
    return {
        "estados": ESTADOS,
        "tipos": [{"key": k, "label": v[0]} for k, v in TIPOS_EMPRESA.items()],
        "portes": [{"key": k, "label": v[0]} for k, v in PORTES.items()],
        "papeis": [{"key": k, "label": v[0]} for k, v in PAPEIS.items()],
        "janelas": [{"key": k, "label": v[0]} for k, v in JANELAS.items()],
        "motivos_descarte": [{"key": k, "label": v} for k, v in MOTIVOS_DESCARTE.items()],
        "fontes": FONTES,
        "dias_ciclo_retorno": DIAS_CICLO_RETORNO,
    }


# ── Escrita ─────────────────────────────────────────────────────────────────────

def _qualificacao_payload(payload) -> Optional[dict]:
    q = getattr(payload, "qualificacao", None)
    if q is None:
        return None
    return q.model_dump(mode="json", exclude_none=True) if hasattr(q, "model_dump") else q


def criar_empresa(payload: EmpresaCreate, usuario: UsuarioOut) -> dict:
    """Cadastra uma empresa prospectada.

    Bloqueia CNPJ repetido: em prospecção ativa o erro mais comum e mais caro é dois
    vendedores mapearem a mesma empresa e trabalharem em paralelo.
    """
    db = get_service_db()
    cnpj = _so_digitos(payload.cnpj)
    if cnpj:
        ja = db.table("crm_empresas").select("id, razao_social, estado")\
            .eq("cnpj", cnpj).eq("ativo", True).limit(1).execute().data
        if ja:
            e = ja[0]
            raise HTTPException(
                status_code=409,
                detail=f"CNPJ já mapeado: {e.get('razao_social')} ({e.get('estado','').lower()}). "
                       "Abra o cadastro existente em vez de criar outro.",
            )

    agora = _agora()
    base = {
        "cnpj": cnpj,
        "razao_social": payload.razao_social.strip(),
        "nome_fantasia": payload.nome_fantasia,
        "cidade": payload.cidade,
        "uf": (payload.uf or "").upper()[:2] or None,
        "tipo": payload.tipo,
        "porte": payload.porte,
        "canal": payload.canal,
        "fonte": payload.fonte,
        "cliente_id": str(payload.cliente_id) if payload.cliente_id else None,
        "observacao": payload.observacao,
    }
    qual = _qualificacao_payload(payload)
    if qual:
        base["qualificacao"] = qual
    score, detalhe = calcular_score(base, _contexto(db))
    row = db.table("crm_empresas").insert({
        **base, "estado": "PROSPECTADA", "score": score, "temperatura": _temperatura(score),
        "score_detalhe": detalhe, "responsavel_id": str(usuario.id),
        "ultima_movimentacao_em": agora, "ativo": True,
    }).execute().data[0]
    return obter_empresa(row["id"])


def _validar_transicao(atual: dict, novo: str) -> None:
    de = atual.get("estado")
    if novo not in ESTADOS:
        raise HTTPException(status_code=422, detail="Estado inválido")
    if novo == "QUALIFICADA":
        falta = _faltando(atual.get("qualificacao"))
        if falta:
            raise HTTPException(status_code=422,
                                detail="Para qualificar, falta: " + "; ".join(falta) + ".")
    if novo == "DESCARTADA" and not atual.get("motivo_descarte_codigo"):
        raise HTTPException(status_code=422,
                            detail="Informe o motivo do descarte — é o que permite saber por que as "
                                   "empresas saem da base.")
    if novo == "CLIENTE" and de != "QUALIFICADA":
        raise HTTPException(status_code=422,
                            detail="Só uma empresa qualificada passa a cliente.")


def atualizar_empresa(empresa_id: str, payload: EmpresaUpdate, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    atual = db.table("crm_empresas").select("*").eq("id", empresa_id).single().execute().data
    if not atual:
        raise HTTPException(status_code=404, detail="Empresa não encontrada")
    atual = _aplicar_ciclo_retorno(db, atual, str(usuario.id))

    update: dict = {"atualizado_em": _agora()}
    for campo in ("razao_social", "nome_fantasia", "cidade", "tipo", "porte", "canal",
                  "fonte", "observacao", "motivo_descarte", "motivo_descarte_codigo",
                  "proximo_passo"):
        val = getattr(payload, campo, None)
        if val is not None:
            update[campo] = val
    if payload.uf is not None:
        update["uf"] = (payload.uf or "").upper()[:2] or None
    if payload.cnpj is not None:
        novo_cnpj = _so_digitos(payload.cnpj)
        if novo_cnpj and novo_cnpj != atual.get("cnpj"):
            ja = db.table("crm_empresas").select("id, razao_social").eq("cnpj", novo_cnpj)\
                .eq("ativo", True).neq("id", empresa_id).limit(1).execute().data
            if ja:
                raise HTTPException(status_code=409,
                                    detail=f"CNPJ já usado por {ja[0].get('razao_social')}.")
        update["cnpj"] = novo_cnpj
    if payload.proximo_passo_em is not None:
        update["proximo_passo_em"] = payload.proximo_passo_em.isoformat()
    if payload.cliente_id is not None:
        update["cliente_id"] = str(payload.cliente_id)
    if payload.motivo_descarte_codigo is not None and payload.motivo_descarte_codigo not in MOTIVOS_DESCARTE:
        raise HTTPException(status_code=422, detail="Motivo de descarte inválido")

    qual = _qualificacao_payload(payload)
    if qual is not None:
        update["qualificacao"] = qual

    # O portão avalia o ESTADO RESULTANTE: dá para preencher a qualificação e
    # qualificar na mesma chamada, que é como a tela funciona.
    resultante = {**atual, **update}
    if payload.estado is not None and payload.estado != atual.get("estado"):
        _validar_transicao(resultante, payload.estado)
        update["estado"] = payload.estado
        if payload.estado == "QUALIFICADA":
            update["qualificada_em"] = _agora()
            update["ultima_movimentacao_em"] = _agora()
        if payload.estado == "DESCARTADA" and resultante.get("qualificacao"):
            # Arquiva antes de sair da base, para o histórico não sumir com o descarte.
            db.table("crm_qualificacao_historico").insert({
                "empresa_id": empresa_id,
                "dados": resultante["qualificacao"],
                "score": resultante.get("score"),
                "qualificada_em": resultante.get("qualificada_em"),
                "motivo_encerramento": "DESCARTE",
                "responsavel_id": str(usuario.id),
            }).execute()

    score, detalhe = calcular_score({**atual, **update}, _contexto(db))
    update["score"] = score
    update["temperatura"] = _temperatura(score)
    update["score_detalhe"] = detalhe

    db.table("crm_empresas").update(update).eq("id", empresa_id).execute()
    return obter_empresa(empresa_id)


def registrar_contato(empresa_id: str, payload, usuario: UsuarioOut) -> dict:
    """Registra uma interação. É movimentação real: zera o relógio do ciclo de 1 ano."""
    db = get_service_db()
    atual = db.table("crm_empresas").select("*").eq("id", empresa_id).single().execute().data
    if not atual:
        raise HTTPException(status_code=404, detail="Empresa não encontrada")

    agora = _agora()
    update = {"ultima_movimentacao_em": agora, "atualizado_em": agora}
    if getattr(payload, "proximo_passo", None):
        update["proximo_passo"] = payload.proximo_passo
    if getattr(payload, "proximo_passo_em", None):
        update["proximo_passo_em"] = payload.proximo_passo_em.isoformat()
    db.table("crm_empresas").update(update).eq("id", empresa_id).execute()

    db.table("crm_atividades").insert({
        "tipo": getattr(payload, "tipo", None) or "LIGACAO",
        "assunto": f"Contato · {atual.get('razao_social')}",
        "descricao": getattr(payload, "descricao", None),
        "concluida": True,
        "concluida_em": agora,
        "cliente_id": atual.get("cliente_id"),
        "responsavel_id": str(usuario.id),
        "ativo": True,
    }).execute()
    return obter_empresa(empresa_id)


def gerar_oportunidade(empresa_id: str, usuario: UsuarioOut) -> dict:
    """Cria a oportunidade no funil a partir de uma empresa QUALIFICADA.

    Leva a qualificação junto — o funil precisa saber por que aquilo é uma
    oportunidade, senão a informação levantada na pré-venda se perde.
    """
    from app.services import crm_service

    db = get_service_db()
    emp = db.table("crm_empresas").select("*").eq("id", empresa_id).single().execute().data
    if not emp:
        raise HTTPException(status_code=404, detail="Empresa não encontrada")
    emp = _aplicar_ciclo_retorno(db, emp, str(usuario.id))
    if emp.get("estado") != "QUALIFICADA":
        falta = _faltando(emp.get("qualificacao"))
        detalhe = ("Falta: " + "; ".join(falta) + "." if falta
                   else "Qualifique a empresa antes de gerar a oportunidade.")
        raise HTTPException(status_code=422, detail=detalhe)

    q = emp.get("qualificacao") or {}
    d = q.get("decisor") or {}
    contato_id = None
    nome = (d.get("nome") or "").strip()
    if nome:
        existente = db.table("crm_contatos").select("id").eq("ativo", True)\
            .eq("nome", nome).limit(1).execute().data
        if existente:
            contato_id = existente[0]["id"]
        else:
            novo = db.table("crm_contatos").insert({
                "nome": nome,
                "email": d.get("email"),
                "telefone": d.get("telefone"),
                "cargo": PAPEIS.get(d.get("papel"), ("",))[0] or None,
                "cliente_id": emp.get("cliente_id"),
                "canal": emp.get("canal"),
                "observacao": f"Criado ao gerar oportunidade de '{emp.get('razao_social')}'",
                "ativo": True,
            }).execute().data
            contato_id = novo[0]["id"] if novo else None

    prazo = q.get("prazo") or {}
    opp = crm_service.criar_oportunidade(
        OportunidadeCreate(
            titulo=emp.get("nome_fantasia") or emp.get("razao_social"),
            cliente_id=emp.get("cliente_id"),
            contato_id=contato_id,
            canal=emp.get("canal"),
            estagio="QUALIFICACAO",
            valor_estimado=round(_valor_mensal(q, _contexto(db)), 2),
            previsao_fechamento=prazo.get("data") if prazo.get("tipo") == "DATA" else None,
            origem=emp.get("fonte") or "Prospecção",
        ),
        usuario,
        qualificacao={**q, "empresa_id": empresa_id, "score_na_geracao": emp.get("score")},
        empresa_id=empresa_id,
    )
    registrar_movimentacao(db, empresa_id)
    return {"empresa": obter_empresa(empresa_id), "oportunidade": opp}


def excluir_empresa(empresa_id: str) -> dict:
    db = get_service_db()
    db.table("crm_empresas").update({"ativo": False, "atualizado_em": _agora()})\
        .eq("id", empresa_id).execute()
    return {"ok": True}

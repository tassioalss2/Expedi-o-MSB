"""CRM · Leads — captação, qualificação com critério e conversão em oportunidade.

O que este módulo resolve (o desenho anterior não resolvia):

**Qualificar era um rótulo.** Qualquer status era aceito, então "QUALIFICADO" só
significava que alguém clicou. Agora há portão: o lead só passa quando as três
perguntas que decidem uma venda estão respondidas em campo estruturado —
o que ele compra (e quanto por mês), quem decide, e quando compra.
`checklist_qualificacao()` devolve exatamente o que falta, para a tela cobrar
item por item em vez de dar erro genérico.

**O score media preenchimento de formulário.** Somava pontos por ter e-mail,
telefone e canal informados — um lead com o cadastro completo e nenhuma chance de
compra pontuava mais que um lead real com dados faltando. Agora mede:

    encaixe comercial (40) + intenção de compra (40) + relacionamento (20)
    − decaimento por inatividade

E devolve `score_detalhe` explicando componente a componente. Score que ninguém
entende, ninguém usa para priorizar.

**Escopo:** venda privada. Licitação nasce e vive no módulo de Licitações — ter as
duas coisas aqui fazia a mesma negociação ser acompanhada em dois lugares.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.schemas import LeadCreate, LeadUpdate, OportunidadeCreate, UsuarioOut

STATUS = ["NOVO", "EM_CONTATO", "QUALIFICADO", "CONVERTIDO", "DESCARTADO"]

# Papéis com poder de decisão de compra. Falar com quem não decide é o erro mais
# comum e mais caro do funil, então o papel pesa no score.
PAPEIS = {
    "COMPRADOR": ("Comprador / Suprimentos", 10),
    "DIRETOR_TECNICO": ("Diretor técnico", 10),
    "CHEFE_SERVICO": ("Chefe de serviço", 10),
    "ADMINISTRADOR": ("Administrador / Diretoria", 10),
    "FARMACIA": ("Farmácia hospitalar", 6),
    "OUTRO": ("Outro", 4),
}

# Janela de compra -> pontos de intenção. Quanto mais perto, mais vale.
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
    "DUPLICADO": "Lead duplicado",
    "OUTRO": "Outro",
}

# Faixas de valor mensal estimado -> pontos de encaixe (volume).
_FAIXAS_VOLUME = [(50000, 20), (20000, 15), (5000, 10), (0.01, 5)]

# Inatividade: começa a pesar depois de duas semanas.
#
# O teto é alto de propósito. Com teto baixo (25) um lead de perfil ótimo
# esquecido há 4 meses continuava aparecendo QUENTE — e "quente" tem que
# significar "ligue hoje", não "era bom em abril". Com 60, o silêncio prolongado
# derruba para FRIO e o lead volta para a fila de requalificação:
#   20d -> -5 (quente)   35d -> -20 (quente)
#   60d -> -35 (morno)  120d -> -60 (frio)
_DIAS_TOLERANCIA_INATIVIDADE = 14
_PENALIDADE_POR_SEMANA = 5
_PENALIDADE_MAXIMA = 60


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hoje() -> date:
    return (datetime.now(timezone.utc) - timedelta(hours=3)).date()


# ── Qualificação ────────────────────────────────────────────────────────────────

def _tem_necessidade(lead: dict) -> bool:
    n = lead.get("necessidade") or {}
    tem_item = bool((n.get("familia") or "").strip() or (n.get("codigos") or []))
    return tem_item and float(n.get("consumo_mes") or 0) > 0


def _tem_decisor(lead: dict) -> bool:
    d = lead.get("decisor") or {}
    return bool((d.get("nome") or "").strip()) and d.get("papel") in PAPEIS


def _tem_prazo(lead: dict) -> bool:
    p = lead.get("prazo") or {}
    if p.get("tipo") == "DATA":
        return bool(p.get("data"))
    if p.get("tipo") == "JANELA":
        return p.get("janela") in JANELAS
    return False


def checklist_qualificacao(lead: dict) -> list:
    """O que falta para qualificar, item por item.

    A tela usa isto para mostrar o checklist e habilitar/bloquear o botão — assim
    o vendedor sabe o que buscar na próxima ligação, em vez de tomar um "campo
    obrigatório" na cara depois de tentar avançar.
    """
    n = lead.get("necessidade") or {}
    d = lead.get("decisor") or {}
    p = lead.get("prazo") or {}
    consumo = float(n.get("consumo_mes") or 0)

    def _detalhe_prazo() -> str:
        if p.get("tipo") == "DATA" and p.get("data"):
            return f"prevista para {p['data']}"
        if p.get("tipo") == "JANELA" and p.get("janela") in JANELAS:
            return JANELAS[p["janela"]][0]
        return "sem prazo informado"

    return [
        {
            "chave": "necessidade",
            "label": "O que compra e quanto por mês",
            "ok": _tem_necessidade(lead),
            "detalhe": (f"{(n.get('familia') or 'itens informados')} · {consumo:g} {n.get('unidade') or 'un'}/mês"
                        if _tem_necessidade(lead)
                        else "informe a família ou os códigos e o consumo mensal"),
        },
        {
            "chave": "decisor",
            "label": "Quem decide a compra",
            "ok": _tem_decisor(lead),
            "detalhe": (f"{d.get('nome')} — {PAPEIS[d['papel']][0]}"
                        if _tem_decisor(lead)
                        else "informe nome e papel de quem assina"),
        },
        {
            "chave": "prazo",
            "label": "Quando pretende comprar",
            "ok": _tem_prazo(lead),
            "detalhe": _detalhe_prazo(),
        },
    ]


def _faltando(lead: dict) -> list:
    return [c["label"] for c in checklist_qualificacao(lead) if not c["ok"]]


# ── Score ───────────────────────────────────────────────────────────────────────

def _contexto(db) -> dict:
    """Dados compartilhados do scoring, carregados UMA vez.

    Sem isto, pontuar uma lista de leads faria uma consulta por lead.
    """
    prods = db.table("produtos").select("id, codigo").eq("ativo", True).execute().data
    codigos = {(p.get("codigo") or "").strip().upper() for p in prods if p.get("codigo")}
    id_por_codigo = {(p.get("codigo") or "").strip().upper(): p["id"] for p in prods if p.get("codigo")}

    # Preço de referência = média do que já vendemos do item. `produtos` não tem
    # preço, e o histórico é a referência mais honesta que existe aqui.
    precos: dict = {}
    soma: dict = {}
    itens = db.table("itens_pedido").select("produto_id, valor_unitario").limit(20000).execute().data
    for it in itens:
        v = float(it.get("valor_unitario") or 0)
        pid = it.get("produto_id")
        if pid and v > 0:
            s, q = soma.get(pid, (0.0, 0))
            soma[pid] = (s + v, q + 1)
    cod_por_id = {v: k for k, v in id_por_codigo.items()}
    for pid, (s, q) in soma.items():
        cod = cod_por_id.get(pid)
        if cod and q:
            precos[cod] = s / q

    # Clientes com compra no último ano — relacionamento vivo, não só cadastro.
    limite = (datetime.now(timezone.utc) - timedelta(days=365)).isoformat()
    peds = db.table("pedidos").select("cliente_id, criado_em")\
        .gte("criado_em", limite).neq("status", "CANCELADO").limit(20000).execute().data
    ativos = {p["cliente_id"] for p in peds if p.get("cliente_id")}

    return {"codigos": codigos, "precos": precos, "clientes_ativos": ativos}


def _valor_mensal_estimado(lead: dict, ctx: dict) -> float:
    """Consumo/mês × preço de referência dos itens citados. 0 se não der para estimar."""
    n = lead.get("necessidade") or {}
    consumo = float(n.get("consumo_mes") or 0)
    if consumo <= 0:
        return 0.0
    cods = [str(c).strip().upper() for c in (n.get("codigos") or []) if str(c).strip()]
    precos = [ctx["precos"][c] for c in cods if c in ctx["precos"]]
    if precos:
        return consumo * (sum(precos) / len(precos))
    # Sem código reconhecido, o valor informado à mão serve de estimativa.
    return float(n.get("valor_mensal_estimado") or 0)


def calcular_score(lead: dict, ctx: dict) -> tuple:
    """(score 0-100, detalhe explicável). Ver docstring do módulo para o modelo."""
    partes = []

    # ── Encaixe comercial (40): isso é venda para a gente?
    n = lead.get("necessidade") or {}
    cods = [str(c).strip().upper() for c in (n.get("codigos") or []) if str(c).strip()]
    if cods:
        conhecidos = [c for c in cods if c in ctx["codigos"]]
        if len(conhecidos) == len(cods):
            pts, obs = 20, f"{len(cods)} item(ns) do nosso portfólio"
        elif conhecidos:
            pts, obs = 12, f"{len(conhecidos)} de {len(cods)} itens são nossos"
        else:
            pts, obs = 0, "nenhum dos códigos é do nosso portfólio"
    elif (n.get("familia") or "").strip():
        pts, obs = 10, "família informada, sem códigos"
    else:
        pts, obs = 0, "não sabemos o que ele compra"
    partes.append({"chave": "portfolio", "label": "Produto atende", "pontos": pts, "max": 20, "obs": obs})

    valor_mes = _valor_mensal_estimado(lead, ctx)
    pts, obs = 0, "volume não estimável"
    for piso, p in _FAIXAS_VOLUME:
        if valor_mes >= piso:
            pts = p
            obs = f"~R$ {valor_mes:,.0f}/mês".replace(",", ".")
            break
    partes.append({"chave": "volume", "label": "Volume relevante", "pontos": pts, "max": 20, "obs": obs})

    # ── Intenção (40): vai comprar, e quando?
    p_prazo = lead.get("prazo") or {}
    if p_prazo.get("tipo") == "DATA" and p_prazo.get("data"):
        try:
            dias = (date.fromisoformat(str(p_prazo["data"])[:10]) - _hoje()).days
        except Exception:
            dias = 999
        pts = 20 if dias <= 30 else 15 if dias <= 60 else 10 if dias <= 90 else 5
        obs = f"compra prevista em {max(dias, 0)} dia(s)"
    elif p_prazo.get("janela") in JANELAS:
        rot, pts = JANELAS[p_prazo["janela"]]
        obs = rot.lower()
    else:
        pts, obs = 0, "sem prazo definido"
    partes.append({"chave": "prazo", "label": "Prazo de compra", "pontos": pts, "max": 20, "obs": obs})

    d = lead.get("decisor") or {}
    if d.get("papel") in PAPEIS and (d.get("nome") or "").strip():
        rot, pts = PAPEIS[d["papel"]]
        obs = f"{d['nome']} — {rot}"
    else:
        pts, obs = 0, "decisor não mapeado"
    partes.append({"chave": "decisor", "label": "Decisor mapeado", "pontos": pts, "max": 10, "obs": obs})

    v = lead.get("verba") or {}
    if v.get("confirmada"):
        pts, obs = 10, "verba confirmada"
    elif v:
        pts, obs = 3, "verba mencionada, não confirmada"
    else:
        pts, obs = 0, "verba não verificada"
    partes.append({"chave": "verba", "label": "Verba", "pontos": pts, "max": 10, "obs": obs})

    # ── Relacionamento (20)
    cid = lead.get("cliente_id")
    if cid and cid in ctx["clientes_ativos"]:
        pts, obs = 20, "já compra da gente (últimos 12 meses)"
    elif cid:
        pts, obs = 10, "está na base, sem compra recente"
    else:
        pts, obs = 0, "cliente novo"
    partes.append({"chave": "relacionamento", "label": "Relacionamento", "pontos": pts, "max": 20, "obs": obs})

    bruto = sum(p["pontos"] for p in partes)

    # ── Decaimento por inatividade
    penalidade, obs_inativo = 0, "contato recente"
    ultimo = lead.get("ultimo_contato_em") or lead.get("criado_em")
    if ultimo:
        try:
            dt = datetime.fromisoformat(str(ultimo).replace("Z", "+00:00"))
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            dias = (datetime.now(timezone.utc) - dt).days
            if dias > _DIAS_TOLERANCIA_INATIVIDADE:
                semanas = (dias - _DIAS_TOLERANCIA_INATIVIDADE) // 7 + 1
                penalidade = min(_PENALIDADE_MAXIMA, semanas * _PENALIDADE_POR_SEMANA)
                obs_inativo = f"{dias} dias sem contato"
        except Exception:
            pass
    if penalidade:
        partes.append({"chave": "inatividade", "label": "Inatividade", "pontos": -penalidade,
                       "max": 0, "obs": obs_inativo})

    score = max(0, min(100, bruto - penalidade))
    return score, {"total": score, "bruto": bruto, "penalidade": penalidade, "partes": partes}


def _temperatura(score: int) -> str:
    return "QUENTE" if score >= 70 else "MORNO" if score >= 40 else "FRIO"


# ── Serialização ────────────────────────────────────────────────────────────────

def _serializar(l: dict) -> dict:
    checklist = checklist_qualificacao(l)
    return {
        "id": l["id"],
        "empresa": l.get("empresa"),
        "cnpj": l.get("cnpj"),
        "contato_nome": l.get("contato_nome"),
        "email": l.get("email"),
        "telefone": l.get("telefone"),
        "canal": l.get("canal"),
        "origem": l.get("origem"),
        "necessidade": l.get("necessidade"),
        "decisor": l.get("decisor"),
        "prazo": l.get("prazo"),
        "verba": l.get("verba"),
        "status": l.get("status"),
        "score": l.get("score"),
        "temperatura": l.get("temperatura"),
        "score_detalhe": l.get("score_detalhe"),
        "checklist": checklist,
        "pode_qualificar": all(c["ok"] for c in checklist),
        "falta_para_qualificar": [c["label"] for c in checklist if not c["ok"]],
        "ultimo_contato_em": l.get("ultimo_contato_em"),
        "proximo_passo": l.get("proximo_passo"),
        "proximo_passo_em": l.get("proximo_passo_em"),
        "proximo_passo_atrasado": bool(
            l.get("proximo_passo_em") and str(l["proximo_passo_em"])[:10] < _hoje().isoformat()
            and l.get("status") in ("NOVO", "EM_CONTATO", "QUALIFICADO")
        ),
        "observacao": l.get("observacao"),
        "cliente_id": l.get("cliente_id"),
        "cliente": (l.get("clientes") or {}).get("nome") if l.get("clientes") else None,
        "motivo_descarte_codigo": l.get("motivo_descarte_codigo"),
        "motivo_descarte": l.get("motivo_descarte"),
        "oportunidade_id": l.get("oportunidade_id"),
        "criado_em": l.get("criado_em"),
    }


def _repontuar(db, lead_id: str, lead: dict, ctx: Optional[dict] = None) -> None:
    ctx = ctx or _contexto(db)
    score, detalhe = calcular_score(lead, ctx)
    db.table("crm_leads").update({
        "score": score, "temperatura": _temperatura(score), "score_detalhe": detalhe,
    }).eq("id", lead_id).execute()


# ── Consultas ───────────────────────────────────────────────────────────────────

def listar_leads(status: Optional[str] = None) -> list:
    """Leads ativos, mais quentes primeiro.

    O score é recalculado na leitura porque ele DECAI com o tempo: um lead
    parado há três semanas precisa aparecer frio hoje, sem depender de alguém
    ter editado o registro.
    """
    db = get_service_db()
    q = db.table("crm_leads").select("*, clientes(nome)").eq("ativo", True)
    if status:
        q = q.eq("status", status)
    rows = q.execute().data
    if not rows:
        return []

    ctx = _contexto(db)
    saida = []
    for r in rows:
        score, detalhe = calcular_score(r, ctx)
        if score != r.get("score"):
            db.table("crm_leads").update({
                "score": score, "temperatura": _temperatura(score), "score_detalhe": detalhe,
            }).eq("id", r["id"]).execute()
        r = {**r, "score": score, "temperatura": _temperatura(score), "score_detalhe": detalhe}
        saida.append(_serializar(r))
    saida.sort(key=lambda x: -(x["score"] or 0))
    return saida


def obter_lead(lead_id: str) -> dict:
    db = get_service_db()
    r = db.table("crm_leads").select("*, clientes(nome)").eq("id", lead_id).single().execute().data
    if not r:
        raise HTTPException(status_code=404, detail="Lead não encontrado")
    score, detalhe = calcular_score(r, _contexto(db))
    return _serializar({**r, "score": score, "temperatura": _temperatura(score), "score_detalhe": detalhe})


def opcoes() -> dict:
    """Vocabulário do fluxo, para a tela não repetir listas em código."""
    return {
        "status": STATUS,
        "papeis": [{"key": k, "label": v[0]} for k, v in PAPEIS.items()],
        "janelas": [{"key": k, "label": v[0]} for k, v in JANELAS.items()],
        "motivos_descarte": [{"key": k, "label": v} for k, v in MOTIVOS_DESCARTE.items()],
    }


# ── Escrita ─────────────────────────────────────────────────────────────────────

def _campos_qualificacao(payload) -> dict:
    """necessidade/decisor/prazo/verba vêm como objeto; normaliza para jsonb."""
    out: dict = {}
    for campo in ("necessidade", "decisor", "prazo", "verba"):
        val = getattr(payload, campo, None)
        if val is not None:
            out[campo] = val.model_dump(mode="json", exclude_none=True) if hasattr(val, "model_dump") else val
    return out


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
        "observacao": payload.observacao,
        "cliente_id": str(payload.cliente_id) if payload.cliente_id else None,
        **_campos_qualificacao(payload),
    }
    score, detalhe = calcular_score(base, _contexto(db))
    row = db.table("crm_leads").insert({
        **base, "status": "NOVO", "score": score,
        "temperatura": _temperatura(score), "score_detalhe": detalhe, "ativo": True,
    }).execute().data[0]
    return obter_lead(row["id"])


def _validar_transicao(atual: dict, novo: str) -> None:
    """Portões do fluxo do lead. Ver docstring do módulo para o porquê."""
    de = atual.get("status")
    if novo not in STATUS:
        raise HTTPException(status_code=422, detail="Status de lead inválido")
    if de == "CONVERTIDO":
        raise HTTPException(status_code=400,
                            detail="Lead já convertido em oportunidade — acompanhe pelo funil.")

    if novo == "EM_CONTATO" and not atual.get("ultimo_contato_em"):
        raise HTTPException(
            status_code=422,
            detail="Registre o primeiro contato antes de mover para Em contato "
                   "(use a ação 'Registrar contato').",
        )
    if novo == "QUALIFICADO":
        falta = _faltando(atual)
        if falta:
            raise HTTPException(
                status_code=422,
                detail="Para qualificar, falta: " + "; ".join(falta) + ".",
            )
    if novo == "CONVERTIDO":
        raise HTTPException(status_code=400,
                            detail="Use a ação 'Converter em oportunidade' — ela cria o card no funil.")
    if novo == "DESCARTADO" and not atual.get("motivo_descarte_codigo"):
        raise HTTPException(status_code=422,
                            detail="Informe o motivo do descarte (é o que permite aprender por que os leads morrem).")


def atualizar_lead(lead_id: str, payload: LeadUpdate) -> dict:
    db = get_service_db()
    atual = db.table("crm_leads").select("*").eq("id", lead_id).single().execute().data
    if not atual:
        raise HTTPException(status_code=404, detail="Lead não encontrado")

    update: dict = {"atualizado_em": _agora()}
    for campo in ("empresa", "contato_nome", "email", "telefone", "cnpj", "canal",
                  "origem", "observacao", "motivo_descarte", "motivo_descarte_codigo",
                  "proximo_passo"):
        val = getattr(payload, campo, None)
        if val is not None:
            update[campo] = val
    if getattr(payload, "proximo_passo_em", None) is not None:
        update["proximo_passo_em"] = payload.proximo_passo_em.isoformat()
    if payload.cliente_id is not None:
        update["cliente_id"] = str(payload.cliente_id)
    update.update(_campos_qualificacao(payload))

    if payload.motivo_descarte_codigo is not None and payload.motivo_descarte_codigo not in MOTIVOS_DESCARTE:
        raise HTTPException(status_code=422, detail="Motivo de descarte inválido")

    # O portão avalia o ESTADO RESULTANTE: dá para preencher a qualificação e
    # qualificar na mesma chamada, o que é como a tela realmente funciona.
    resultante = {**atual, **update}
    if payload.status is not None and payload.status != atual.get("status"):
        _validar_transicao(resultante, payload.status)
        update["status"] = payload.status

    score, detalhe = calcular_score(resultante, _contexto(db))
    update["score"] = score
    update["temperatura"] = _temperatura(score)
    update["score_detalhe"] = detalhe

    db.table("crm_leads").update(update).eq("id", lead_id).execute()
    return obter_lead(lead_id)


def registrar_contato(lead_id: str, payload, usuario: UsuarioOut) -> dict:
    """Registra uma interação e move NOVO → EM_CONTATO.

    É o que destrava o primeiro portão: "em contato" passa a significar que existe
    contato registrado, não que alguém achou que falou com o cliente.
    """
    db = get_service_db()
    atual = db.table("crm_leads").select("*").eq("id", lead_id).single().execute().data
    if not atual:
        raise HTTPException(status_code=404, detail="Lead não encontrado")

    agora = _agora()
    update = {"ultimo_contato_em": agora, "atualizado_em": agora}
    if atual.get("status") == "NOVO":
        update["status"] = "EM_CONTATO"
    if getattr(payload, "proximo_passo", None):
        update["proximo_passo"] = payload.proximo_passo
    if getattr(payload, "proximo_passo_em", None):
        update["proximo_passo_em"] = payload.proximo_passo_em.isoformat()

    db.table("crm_leads").update(update).eq("id", lead_id).execute()

    db.table("crm_atividades").insert({
        "tipo": getattr(payload, "tipo", None) or "LIGACAO",
        "assunto": f"Contato · {atual.get('empresa')}",
        "descricao": getattr(payload, "descricao", None),
        "concluida": True,
        "concluida_em": agora,
        "responsavel_id": str(usuario.id),
        "ativo": True,
    }).execute()

    _repontuar(db, lead_id, {**atual, **update})
    return obter_lead(lead_id)


def converter_lead(lead_id: str, usuario: UsuarioOut) -> dict:
    """Cria a oportunidade no funil a partir de um lead QUALIFICADO.

    Leva a qualificação junto: o funil precisa saber por que aquilo é uma
    oportunidade, senão o card chega sem contexto e a informação levantada na
    pré-venda se perde.
    """
    from app.services import crm_service

    db = get_service_db()
    lead = db.table("crm_leads").select("*").eq("id", lead_id).single().execute().data
    if not lead:
        raise HTTPException(status_code=404, detail="Lead não encontrado")
    if lead.get("oportunidade_id"):
        raise HTTPException(status_code=400, detail="Este lead já foi convertido em oportunidade.")

    falta = _faltando(lead)
    if falta:
        raise HTTPException(status_code=422,
                            detail="Não é possível converter sem qualificar. Falta: " + "; ".join(falta) + ".")

    # Contato do CRM a partir dos dados do lead — sem recadastrar na mão. Prefere
    # o decisor, que é quem interessa no funil.
    d = lead.get("decisor") or {}
    nome_contato = (d.get("nome") or lead.get("contato_nome") or "").strip()
    contato_id = None
    if nome_contato:
        q = db.table("crm_contatos").select("id").eq("ativo", True).eq("nome", nome_contato)
        email = d.get("email") or lead.get("email")
        if email:
            q = q.eq("email", email)
        existente = q.limit(1).execute().data
        if existente:
            contato_id = existente[0]["id"]
        else:
            novo = db.table("crm_contatos").insert({
                "nome": nome_contato,
                "email": email,
                "telefone": d.get("telefone") or lead.get("telefone"),
                "cargo": PAPEIS.get(d.get("papel"), ("",))[0] or None,
                "cliente_id": lead.get("cliente_id"),
                "canal": lead.get("canal"),
                "observacao": f"Criado na conversão do lead '{lead.get('empresa')}'",
                "ativo": True,
            }).execute().data
            contato_id = novo[0]["id"] if novo else None

    ctx = _contexto(db)
    valor_mes = _valor_mensal_estimado(lead, ctx)
    prazo = lead.get("prazo") or {}
    previsao = prazo.get("data") if prazo.get("tipo") == "DATA" else None

    opp = crm_service.criar_oportunidade(
        OportunidadeCreate(
            titulo=lead.get("empresa"),
            cliente_id=lead.get("cliente_id"),
            contato_id=contato_id,
            canal=lead.get("canal"),
            estagio="QUALIFICACAO",
            # Primeiro mês como valor de entrada — o funil refina com a cotação.
            valor_estimado=round(valor_mes, 2),
            previsao_fechamento=previsao,
            origem=lead.get("origem") or "Lead",
        ),
        usuario,
        qualificacao={
            "necessidade": lead.get("necessidade"),
            "decisor": lead.get("decisor"),
            "prazo": lead.get("prazo"),
            "verba": lead.get("verba"),
            "score_na_conversao": lead.get("score"),
            "lead_id": lead_id,
        },
    )
    db.table("crm_leads").update({
        "status": "CONVERTIDO", "oportunidade_id": opp["id"], "atualizado_em": _agora(),
    }).eq("id", lead_id).execute()
    return {"lead": obter_lead(lead_id), "oportunidade": opp}


def excluir_lead(lead_id: str) -> dict:
    db = get_service_db()
    db.table("crm_leads").update({"ativo": False, "atualizado_em": _agora()}).eq("id", lead_id).execute()
    return {"ok": True}

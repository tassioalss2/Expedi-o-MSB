"""CRM — funil de oportunidades, contatos, atividades e timeline.

Inspirado nas boas práticas dos grandes CRMs:
- Funil (pipeline) visual com estágios e previsão ponderada (valor × probabilidade) — Pipedrive.
- Modelo Conta (cliente) → Contato → Oportunidade — Salesforce.
- Timeline de atividades e notas por oportunidade — HubSpot.
- Taxa de ganho, motivo de perda e previsão de fechamento para forecast.
"""
import re
import unicodedata
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

# Estágios do funil e probabilidade BASE de cada um (%).
#
# A ordem segue o processo real: alinha-se volume/preço/condições na NEGOCIAÇÃO e a
# PROPOSTA formaliza o acordo — é ela que decide ganho/perda. (Antes estava o
# contrário, proposta antes de negociar, o que não é como o time trabalha.)
#
# DESAFIOS é etapa OPCIONAL: existe para dar visibilidade a negócio parado
# esperando cadastro de fornecedor, registro ANVISA, amostra com o médico etc.
# O que trava o avanço não é "passar por Desafios" — é ter desafio bloqueante
# aberto, de qualquer etapa.
ESTAGIOS = [
    {"key": "QUALIFICACAO", "label": "Qualificada", "prob": 25},
    {"key": "DESAFIOS", "label": "Desafios", "prob": 30},
    {"key": "NEGOCIACAO", "label": "Negociação", "prob": 50},
    {"key": "PROPOSTA", "label": "Proposta", "prob": 75},
    {"key": "GANHO", "label": "Ganho", "prob": 100},
    {"key": "PERDIDO", "label": "Perdido", "prob": 0},
]
_PROB_POR_ESTAGIO = {e["key"]: e["prob"] for e in ESTAGIOS}
_ESTAGIOS_ABERTOS = ["QUALIFICACAO", "DESAFIOS", "NEGOCIACAO", "PROPOSTA"]
_ESTAGIO_LABEL = {e["key"]: e["label"] for e in ESTAGIOS}
# Ordem para não deixar pular etapa. DESAFIOS compartilha posição com
# QUALIFICACAO porque é um desvio, não um degrau: sair dela para NEGOCIACAO é o
# mesmo avanço que sair de QUALIFICACAO.
_ORDEM_ESTAGIO = {"QUALIFICACAO": 1, "DESAFIOS": 1, "NEGOCIACAO": 2, "PROPOSTA": 3}

MOTIVOS_PERDA = {
    "PRECO": "Preço acima do concorrente",
    "PRAZO_ENTREGA": "Prazo de entrega",
    "CONCORRENTE": "Concorrente já estabelecido",
    "SEM_VERBA": "Cliente sem verba",
    "PRODUTO_NAO_ATENDE": "Produto não atende",
    "SEM_RESPOSTA": "Cliente parou de responder",
    "TIMING": "Momento errado / adiou a compra",
    "OUTRO": "Outro",
}

# Card parado é o principal sintoma de funil abandonado. A partir daqui o painel
# sinaliza — e a probabilidade cai, porque previsão de negócio parado é ficção.
_DIAS_PARADO_ALERTA = 15
_DIAS_PARADO_GRAVE = 30


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


def _dias_no_estagio(o: dict) -> Optional[int]:
    ref = o.get("estagio_em") or o.get("criado_em")
    if not ref:
        return None
    try:
        dt = datetime.fromisoformat(str(ref).replace("Z", "+00:00"))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - dt).days
    except Exception:
        return None


def _probabilidade_ajustada(o: dict, dias_parado: Optional[int]) -> tuple:
    """Probabilidade = base do estágio, corrigida por sinais reais.

    Antes era fixa: toda proposta valia 50%, boa ou ruim, viva ou parada há dois
    meses. Isso inflava a previsão ponderada que alimenta o forecast. Aqui o
    número cai quando o negócio dá sinal de estar morrendo.
    """
    estagio = o.get("estagio")
    if estagio in ("GANHO", "PERDIDO"):
        return (100 if estagio == "GANHO" else 0), []

    base = _PROB_POR_ESTAGIO.get(estagio, 0)
    prob, motivos = base, []

    if dias_parado is not None and dias_parado >= _DIAS_PARADO_GRAVE:
        prob -= 20
        motivos.append(f"parada há {dias_parado} dias")
    elif dias_parado is not None and dias_parado >= _DIAS_PARADO_ALERTA:
        prob -= 10
        motivos.append(f"parada há {dias_parado} dias")

    # Sem próximo passo definido, ninguém está conduzindo o negócio.
    if not o.get("proximo_passo"):
        prob -= 10
        motivos.append("sem próximo passo")

    # Concorrente conhecido no jogo reduz a chance.
    if (o.get("concorrente") or "").strip():
        prob -= 5
        motivos.append("concorrente identificado")

    return max(5, min(95, prob)), motivos


def _serializar_opp(o: dict, itens: Optional[list] = None) -> dict:
    valor = float(o.get("valor_estimado") or 0)
    dias_parado = _dias_no_estagio(o)
    prob, ajustes = _probabilidade_ajustada(o, dias_parado)
    custo = o.get("custo_estimado")
    custo = float(custo) if custo is not None else None
    # Margem só é informativa (decisão do negócio: calcular, não julgar).
    margem_pct = round((valor - custo) / valor * 100, 1) if (custo is not None and valor > 0) else None
    hoje = (datetime.now(timezone.utc) - timedelta(hours=3)).date().isoformat()
    aberta = o.get("estagio") in _ESTAGIOS_ABERTOS
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
        "custo_estimado": custo,
        "margem_pct": margem_pct,
        "probabilidade": prob,
        "probabilidade_base": _PROB_POR_ESTAGIO.get(o.get("estagio"), 0),
        "probabilidade_ajustes": ajustes,
        "valor_ponderado": round(valor * prob / 100, 2),
        "origem": o.get("origem"),
        "previsao_fechamento": o.get("previsao_fechamento"),
        "responsavel_id": o.get("responsavel_id"),
        # Qualificação herdada do lead: o funil não perde o "por que isso existe".
        "qualificacao": o.get("qualificacao"),
        "proximo_passo": o.get("proximo_passo"),
        "proximo_passo_em": o.get("proximo_passo_em"),
        "proximo_passo_atrasado": bool(aberta and o.get("proximo_passo_em")
                                       and str(o["proximo_passo_em"])[:10] < hoje),
        "sem_proximo_passo": bool(aberta and not o.get("proximo_passo")),
        "dias_no_estagio": dias_parado,
        "parada": bool(aberta and dias_parado is not None and dias_parado >= _DIAS_PARADO_ALERTA),
        "motivo_perda": o.get("motivo_perda"),
        "motivo_perda_codigo": o.get("motivo_perda_codigo"),
        "motivo_perda_label": MOTIVOS_PERDA.get(o.get("motivo_perda_codigo")),
        "concorrente": o.get("concorrente"),
        "preco_vencedor": float(o["preco_vencedor"]) if o.get("preco_vencedor") is not None else None,
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


def requisitos_avanco(db, oportunidade_id: str, atual: dict, destino: str) -> list:
    """O que falta para a oportunidade entrar em `destino`.

    Mesma ideia do checklist do lead: em vez de aceitar qualquer pulo de etapa
    (dava para ir de Qualificada direto a Negociação), cada avanço exige a prova
    de que a etapa anterior aconteceu de verdade.
    """
    falta = []
    de = _ORDEM_ESTAGIO.get(atual.get("estagio"), 0)
    para = _ORDEM_ESTAGIO.get(destino, 0)

    # Desafios bloqueantes travam a saída para qualquer etapa adiante: é o
    # "resolver antes de negociar" do processo. Vale mesmo sem passar por DESAFIOS,
    # porque um problema pode aparecer com a negociação já em andamento.
    if destino not in ("DESAFIOS", "PERDIDO") and para > de:
        abertos = db.table("crm_desafios").select("id, descricao, crm_desafio_tipos(label)")\
            .eq("oportunidade_id", oportunidade_id).eq("status", "ABERTO")\
            .eq("bloqueia", True).execute().data
        if abertos:
            nomes = [((d.get("crm_desafio_tipos") or {}).get("label") or d.get("descricao") or "desafio")
                     for d in abertos[:3]]
            falta.append(f"resolver {len(abertos)} desafio(s) bloqueante(s): " + "; ".join(nomes))

    # Só cobra ao AVANÇAR. Voltar etapa é correção de rota e fica livre.
    if para <= de:
        return falta

    # Pular etapa não é permitido: a proposta formaliza o que foi negociado, então
    # ir de Qualificada direto a Proposta significaria propor sem ter negociado.
    if para - de > 1:
        intermediaria = next((k for k, v in _ORDEM_ESTAGIO.items() if v == de + 1), None)
        falta.append(f"passar por {_ESTAGIO_LABEL.get(intermediaria, intermediaria)} antes "
                     f"de {_ESTAGIO_LABEL.get(destino, destino)}")
        return falta

    if destino == "PROPOSTA":
        # A proposta é gerada a partir dos itens — sem eles não há o que gerar.
        itens = db.table("crm_oportunidade_itens").select("id, qtd, valor_unitario")\
            .eq("oportunidade_id", oportunidade_id).execute().data
        validos = [i for i in itens if float(i.get("qtd") or 0) > 0 and float(i.get("valor_unitario") or 0) > 0]
        if not validos:
            falta.append("itens com quantidade e preço — a proposta é gerada a partir deles")

    if destino in _ESTAGIOS_ABERTOS and not (atual.get("proximo_passo") or "").strip():
        falta.append("próximo passo definido (o que acontece agora e quando)")

    return falta


def requisitos_ganho(db, oportunidade_id: str) -> list:
    """O que falta para marcar como ganha.

    A proposta é o último passo do processo e é ela que decide o fechamento —
    então não se declara ganho sem proposta emitida."""
    cots = db.table("crm_cotacoes").select("id, status, enviada_em")\
        .eq("oportunidade_id", oportunidade_id).eq("ativo", True).execute().data
    emitida = [c for c in cots if c.get("enviada_em") or c.get("status") in ("ENVIADA", "ACEITA")]
    if not emitida:
        return ["proposta gerada e enviada ao cliente — é ela que fecha o negócio"]
    return []


def _validar_avanco(db, oportunidade_id: str, atual: dict, destino: str) -> None:
    falta = requisitos_avanco(db, oportunidade_id, atual, destino)
    if falta:
        raise HTTPException(
            status_code=422,
            detail=f"Para mover para {_ESTAGIO_LABEL.get(destino, destino)}, falta: " + "; ".join(falta) + ".",
        )


def criar_oportunidade(payload: OportunidadeCreate, usuario: UsuarioOut,
                       qualificacao: Optional[dict] = None,
                       empresa_id: Optional[str] = None) -> dict:
    """Cria a oportunidade no funil.

    `qualificacao` vem da conversão do lead (o que compra, quem decide, quando) —
    é o contexto que justifica o card existir.
    """
    db = get_service_db()
    estagio = payload.estagio if payload.estagio in _PROB_POR_ESTAGIO else "QUALIFICACAO"
    prob = payload.probabilidade if payload.probabilidade is not None else _PROB_POR_ESTAGIO[estagio]
    valor = payload.valor_estimado
    if valor is None:
        valor = _valor_itens(payload.itens)

    agora = _agora()
    row = db.table("crm_oportunidades").insert({
        "titulo": payload.titulo.strip(),
        "cliente_id": str(payload.cliente_id) if payload.cliente_id else None,
        "contato_id": str(payload.contato_id) if payload.contato_id else None,
        "canal": payload.canal,
        "estagio": estagio,
        "estagio_em": agora,
        "valor_estimado": float(valor or 0),
        "probabilidade": int(prob),
        "origem": payload.origem,
        "previsao_fechamento": payload.previsao_fechamento.isoformat() if payload.previsao_fechamento else None,
        "proximo_passo": payload.proximo_passo,
        "proximo_passo_em": payload.proximo_passo_em.isoformat() if payload.proximo_passo_em else None,
        "qualificacao": qualificacao,
        "empresa_id": empresa_id,
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
    if payload.custo_estimado is not None:
        update["custo_estimado"] = float(payload.custo_estimado)
    if payload.proximo_passo is not None:
        update["proximo_passo"] = payload.proximo_passo.strip() or None
    if payload.proximo_passo_em is not None:
        update["proximo_passo_em"] = payload.proximo_passo_em.isoformat()

    # Mudança de estágio → valida o portão, ajusta probabilidade e registra evento
    if payload.estagio is not None and payload.estagio != atual.get("estagio"):
        if payload.estagio not in _PROB_POR_ESTAGIO:
            raise HTTPException(status_code=422, detail="Estágio inválido")
        if payload.estagio == "GANHO":
            return ganhar_oportunidade(oportunidade_id, usuario)
        if payload.estagio == "PERDIDO":
            raise HTTPException(status_code=400, detail="Para marcar como perdida, informe o motivo (use a ação Perder).")
        # Estado RESULTANTE: permite definir o próximo passo e avançar na mesma
        # chamada, que é como a tela faz.
        _validar_avanco(db, oportunidade_id, {**atual, **update}, payload.estagio)
        update["estagio"] = payload.estagio
        update["estagio_em"] = _agora()
        update["probabilidade"] = _PROB_POR_ESTAGIO[payload.estagio]
        # sai de um estado fechado → reabre
        update["ganho_em"] = None
        update["perdido_em"] = None
        update["motivo_perda"] = None
        update["motivo_perda_codigo"] = None
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


# ── Desafios: vocabulário que aprende ───────────────────────────────────────────
#
# O operador escreve o problema com as palavras dele e o sistema cadastra como tipo
# reutilizável. Lista fixa nunca cobre a realidade; texto livre impede agrupar. O
# `slug` deduplica e `usos` ordena o autocomplete, para quem digita "cadastro"
# receber o tipo existente em vez de criar a 50ª variação do mesmo problema.

def _slug_desafio(texto: str) -> str:
    s = unicodedata.normalize("NFKD", texto or "").encode("ascii", "ignore").decode()
    s = re.sub(r"[^a-zA-Z0-9\s]", " ", s.lower())
    return re.sub(r"\s+", " ", s).strip()


def listar_tipos_desafio(busca: Optional[str] = None) -> list:
    db = get_service_db()
    rows = db.table("crm_desafio_tipos").select("*").eq("ativo", True).execute().data
    if busca:
        termos = [t for t in _slug_desafio(busca).split() if t]
        rows = [r for r in rows if all(t in (r.get("slug") or "") for t in termos)]
    rows.sort(key=lambda r: (-(r.get("usos") or 0), r.get("label") or ""))
    return [{"id": r["id"], "label": r["label"], "usos": r.get("usos") or 0} for r in rows]


def _resolver_tipo_desafio(db, tipo_id: Optional[str], tipo_texto: Optional[str],
                           usuario_id: str) -> Optional[str]:
    """Id do tipo, criando-o quando o operador escreveu algo que ainda não existe."""
    if tipo_id:
        atual = db.table("crm_desafio_tipos").select("usos").eq("id", tipo_id).single().execute().data
        if atual:
            db.table("crm_desafio_tipos").update({"usos": int(atual.get("usos") or 0) + 1})\
                .eq("id", tipo_id).execute()
        return tipo_id

    texto = (tipo_texto or "").strip()
    slug = _slug_desafio(texto)
    if not slug:
        return None
    ja = db.table("crm_desafio_tipos").select("id, usos").eq("slug", slug).limit(1).execute().data
    if ja:
        db.table("crm_desafio_tipos").update({"usos": int(ja[0].get("usos") or 0) + 1})\
            .eq("id", ja[0]["id"]).execute()
        return ja[0]["id"]
    novo = db.table("crm_desafio_tipos").insert({
        "label": texto, "slug": slug, "usos": 1, "criado_por": usuario_id, "ativo": True,
    }).execute().data
    return novo[0]["id"] if novo else None


def _serializar_desafio(d: dict) -> dict:
    hoje = (datetime.now(timezone.utc) - timedelta(hours=3)).date().isoformat()
    return {
        "id": d["id"],
        "oportunidade_id": d.get("oportunidade_id"),
        "tipo_id": d.get("tipo_id"),
        "tipo": (d.get("crm_desafio_tipos") or {}).get("label") if d.get("crm_desafio_tipos") else None,
        "descricao": d.get("descricao"),
        "bloqueia": bool(d.get("bloqueia")),
        "status": d.get("status"),
        "responsavel_id": d.get("responsavel_id"),
        "prazo": d.get("prazo"),
        "atrasado": bool(d.get("status") == "ABERTO" and d.get("prazo")
                         and str(d["prazo"])[:10] < hoje),
        "resolucao": d.get("resolucao"),
        "resolvido_em": d.get("resolvido_em"),
        "criado_em": d.get("criado_em"),
    }


def listar_desafios(oportunidade_id: str) -> list:
    db = get_service_db()
    rows = db.table("crm_desafios").select("*, crm_desafio_tipos(label)")\
        .eq("oportunidade_id", oportunidade_id).order("criado_em").execute().data
    return [_serializar_desafio(d) for d in rows]


def criar_desafio(oportunidade_id: str, payload, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    opp = db.table("crm_oportunidades").select("id, estagio, empresa_id")\
        .eq("id", oportunidade_id).single().execute().data
    if not opp:
        raise HTTPException(status_code=404, detail="Oportunidade não encontrada")

    tipo_id = _resolver_tipo_desafio(
        db, str(payload.tipo_id) if payload.tipo_id else None,
        payload.tipo_texto, str(usuario.id))
    if not tipo_id:
        raise HTTPException(status_code=422,
                            detail="Descreva o desafio (escolha um tipo existente ou escreva um novo).")

    db.table("crm_desafios").insert({
        "oportunidade_id": oportunidade_id,
        "tipo_id": tipo_id,
        "descricao": payload.descricao,
        "bloqueia": True if payload.bloqueia is None else bool(payload.bloqueia),
        "status": "ABERTO",
        "responsavel_id": str(payload.responsavel_id) if payload.responsavel_id else str(usuario.id),
        "prazo": payload.prazo.isoformat() if payload.prazo else None,
        "criado_por": str(usuario.id),
    }).execute()

    # Abrir desafio move o card para DESAFIOS — o negócio está de fato parado
    # esperando isso, e o funil precisa mostrar onde ele está.
    if opp.get("estagio") == "QUALIFICACAO":
        db.table("crm_oportunidades").update({
            "estagio": "DESAFIOS", "estagio_em": _agora(), "atualizado_em": _agora(),
        }).eq("id", oportunidade_id).execute()

    _log_evento(db, oportunidade_id, "⚠️ Desafio registrado", str(usuario.id))
    _marcar_movimentacao(db, opp.get("empresa_id"))
    return {"desafios": listar_desafios(oportunidade_id),
            "oportunidade": obter_oportunidade(oportunidade_id)}


def atualizar_desafio(desafio_id: str, payload, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    atual = db.table("crm_desafios").select("*").eq("id", desafio_id).single().execute().data
    if not atual:
        raise HTTPException(status_code=404, detail="Desafio não encontrado")

    update: dict = {"atualizado_em": _agora()}
    if payload.descricao is not None:
        update["descricao"] = payload.descricao
    if payload.bloqueia is not None:
        update["bloqueia"] = bool(payload.bloqueia)
    if payload.responsavel_id is not None:
        update["responsavel_id"] = str(payload.responsavel_id)
    if payload.prazo is not None:
        update["prazo"] = payload.prazo.isoformat()
    if payload.resolucao is not None:
        update["resolucao"] = payload.resolucao
    if payload.status is not None:
        if payload.status not in ("ABERTO", "RESOLVIDO", "CANCELADO"):
            raise HTTPException(status_code=422, detail="Status de desafio inválido")
        update["status"] = payload.status
        update["resolvido_em"] = _agora() if payload.status != "ABERTO" else None

    db.table("crm_desafios").update(update).eq("id", desafio_id).execute()

    oid = atual["oportunidade_id"]
    opp = db.table("crm_oportunidades").select("estagio, empresa_id").eq("id", oid).single().execute().data
    # Resolvido o último bloqueante, o card volta de DESAFIOS para Qualificada e
    # segue o fluxo normal — não faz sentido ficar parado numa etapa sem pendência.
    if update.get("status") in ("RESOLVIDO", "CANCELADO") and opp and opp.get("estagio") == "DESAFIOS":
        restam = db.table("crm_desafios").select("id").eq("oportunidade_id", oid)\
            .eq("status", "ABERTO").eq("bloqueia", True).execute().data
        if not restam:
            db.table("crm_oportunidades").update({
                "estagio": "QUALIFICACAO", "estagio_em": _agora(), "atualizado_em": _agora(),
            }).eq("id", oid).execute()
            _log_evento(db, oid, "✅ Desafios resolvidos — liberada para negociação", str(usuario.id))

    _marcar_movimentacao(db, (opp or {}).get("empresa_id"))
    return {"desafios": listar_desafios(oid), "oportunidade": obter_oportunidade(oid)}


def _marcar_movimentacao(db, empresa_id: Optional[str]) -> None:
    """Zera o relógio do ciclo de 1 ano da empresa. Import local para não fechar
    ciclo entre os dois serviços."""
    if not empresa_id:
        return
    try:
        from app.services import crm_empresas_service
        crm_empresas_service.registrar_movimentacao(db, empresa_id)
    except Exception:
        pass


def ganhar_oportunidade(oportunidade_id: str, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    falta = requisitos_ganho(db, oportunidade_id)
    if falta:
        raise HTTPException(status_code=422,
                            detail="Para marcar como ganha, falta: " + "; ".join(falta) + ".")
    agora = _agora()
    db.table("crm_oportunidades").update({
        "estagio": "GANHO", "probabilidade": 100, "ganho_em": agora,
        "estagio_em": agora,
        "perdido_em": None, "motivo_perda": None, "motivo_perda_codigo": None,
        "atualizado_em": agora,
    }).eq("id", oportunidade_id).execute()
    _log_evento(db, oportunidade_id, "🏆 Oportunidade marcada como GANHA", str(usuario.id))
    return obter_oportunidade(oportunidade_id)


def perder_oportunidade(oportunidade_id: str, payload: PerderRequest, usuario: UsuarioOut) -> dict:
    """Fecha como perdida, exigindo motivo CODIFICADO.

    Antes o motivo era texto livre, então não havia como responder "por que a
    gente perde?" — cada um escrevia de um jeito. Com o código, a aba Inteligência
    agrupa e o concorrente/preço do vencedor viram referência de mercado.
    """
    codigo = (payload.codigo or "").strip().upper()
    if codigo not in MOTIVOS_PERDA:
        raise HTTPException(
            status_code=422,
            detail="Informe o motivo da perda. Opções: " + ", ".join(MOTIVOS_PERDA),
        )
    db = get_service_db()
    agora = _agora()
    texto = (payload.motivo or "").strip() or MOTIVOS_PERDA[codigo]
    db.table("crm_oportunidades").update({
        "estagio": "PERDIDO", "probabilidade": 0, "perdido_em": agora,
        "estagio_em": agora,
        "motivo_perda_codigo": codigo,
        "motivo_perda": texto,
        "concorrente": (payload.concorrente or "").strip() or None,
        "preco_vencedor": float(payload.preco_vencedor) if payload.preco_vencedor is not None else None,
        "ganho_em": None, "atualizado_em": agora,
    }).eq("id", oportunidade_id).execute()
    detalhe = MOTIVOS_PERDA[codigo]
    if payload.concorrente:
        detalhe += f" · concorrente: {payload.concorrente.strip()}"
    _log_evento(db, oportunidade_id, f"❌ PERDIDA — {detalhe}", str(usuario.id))
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

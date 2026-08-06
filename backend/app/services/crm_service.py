"""CRM — funil de oportunidades, contatos, atividades e timeline.

Inspirado nas boas práticas dos grandes CRMs:
- Funil (pipeline) visual com estágios e previsão ponderada (valor × probabilidade) — Pipedrive.
- Modelo Conta (cliente) → Contato → Oportunidade — Salesforce.
- Timeline de atividades e notas por oportunidade — HubSpot.
- Taxa de ganho, motivo de perda e previsão de fechamento para forecast.
"""
import re
import unicodedata
from datetime import date, datetime, timedelta, timezone
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
from app.services import disponibilidade_service, pendencia_service

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
#
# GANHO e PERDIDO entram como 4 (acima de tudo) para que SAIR deles conte como
# volta, não como avanço. Sem eles no mapa, `_ORDEM_ESTAGIO.get("GANHO", 0)` dava
# 0 e reabrir uma oportunidade ganha era tratado como avanço para Qualificada —
# o app cobrava "próximo passo definido" para desfazer um ganho.
# Como destino, os dois são desviados antes do validador (ganhar/perder têm portão
# próprio), então o número só pesa como origem.
_ORDEM_ESTAGIO = {"QUALIFICACAO": 1, "DESAFIOS": 1, "NEGOCIACAO": 2, "PROPOSTA": 3,
                  "GANHO": 4, "PERDIDO": 4}

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
    # Pendência de estoque. `.get` devolve None quando a migration v29 ainda não
    # rodou, e aí o card simplesmente não tem pendência — nada quebra.
    pend = o.get("pendencia") or None
    pend_aberta = bool(pend and not pend.get("resolvido_em"))
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
        "repasse_status": o.get("repasse_status"),
        "repasse_em": o.get("repasse_em"),
        "repasse_nota": o.get("repasse_nota"),
        "repasse_assumido_em": o.get("repasse_assumido_em"),
        # Preenchido por quem tem o nome em mão (obter_oportunidade); o serializador
        # não faz lookup para não gerar uma query por card na listagem.
        "repasse_assumido_por_nome": o.get("_assumido_nome"),
        "criado_em": o.get("criado_em"),
        "itens": itens if itens is not None else None,
        # ── Pendência de estoque ───────────────────────────────────────────────
        # `pendencia_aberta` é o que joga o card na coluna "Pendência de estoque"
        # do kanban. É coluna VIRTUAL de propósito: a oportunidade não perde o
        # lugar dela no funil por estar esperando material.
        "pendencia": pend,
        "pendencia_aberta": pend_aberta,
        "pendencia_valor": round(float((pend or {}).get("valor") or 0), 2) if pend_aberta else 0.0,
        "pendencia_decisao": (pend or {}).get("decisao") if pend_aberta else None,
        "pendencia_itens": (pend or {}).get("itens") or [] if pend_aberta else [],
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
    if o.get("repasse_assumido_por"):
        o["_assumido_nome"] = _nomes_usuarios(db, [o["repasse_assumido_por"]]).get(o["repasse_assumido_por"])

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
        try:
            abertos = db.table("crm_desafios").select("id, descricao, crm_desafio_tipos(label)")\
                .eq("oportunidade_id", oportunidade_id).eq("status", "ABERTO")\
                .eq("bloqueia", True).execute().data
        except Exception:
            # Migration v22 ainda não rodou: sem a tabela não há desafio para
            # bloquear. Engolir aqui em vez de estourar 500 — o resto do portão
            # (próximo passo, itens) continua valendo e o usuário recebe uma
            # mensagem útil em vez de "erro ao mover".
            abertos = []
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

    Hoje: nada. A proposta enviada era exigida aqui, e o time pediu para tirar —
    boa parte das vendas fecha por telefone ou WhatsApp e a proposta formal sai
    depois (ou nunca), então a exigência travava ganho legítimo.

    A função continua existindo, e sendo chamada por `ganhar_oportunidade`, porque
    é o ponto único onde entram requisitos de ganho. A conferência de ESTOQUE não
    mora aqui: ela não é "requisito", é uma decisão que o comercial toma — está em
    `ganhar_oportunidade` e continua valendo.
    """
    return []


def _gerar_cotacao_proposta(db, oportunidade_id: str, usuario: UsuarioOut) -> Optional[dict]:
    """Gera a proposta (cotação) automaticamente ao entrar em PROPOSTA.

    A cotação é o formulário que vira PDF: puxa cliente/contato/canal da
    oportunidade, itens negociados e, quando a empresa tem cidade/UF mapeadas,
    já preenche o endereço. Se a oportunidade já tem cotação ativa (ex.: saiu
    de Proposta e voltou), não duplica — devolve a existente."""
    from app.models.schemas import CotacaoCreate, CotacaoItem
    from app.services import crm_cotacao_service

    existentes = db.table("crm_cotacoes").select("id, numero")\
        .eq("oportunidade_id", oportunidade_id).eq("ativo", True).execute().data
    if existentes:
        return {"id": existentes[0]["id"], "numero": existentes[0]["numero"], "nova": False}

    opp = db.table("crm_oportunidades").select("*").eq("id", oportunidade_id).single().execute().data
    if not opp:
        return None
    itens_rows = db.table("crm_oportunidade_itens").select("*").eq("oportunidade_id", oportunidade_id).execute().data
    validos = [i for i in itens_rows if float(i.get("qtd") or 0) > 0 and float(i.get("valor_unitario") or 0) > 0]
    if not validos:
        return None

    endereco_cidade = endereco_uf = None
    if opp.get("empresa_id"):
        emp = db.table("crm_empresas").select("cidade, uf").eq("id", opp["empresa_id"]).execute().data
        if emp:
            endereco_cidade = emp[0].get("cidade")
            endereco_uf = emp[0].get("uf")

    payload = CotacaoCreate(
        cliente_id=opp.get("cliente_id"),
        contato_id=opp.get("contato_id"),
        oportunidade_id=oportunidade_id,
        canal=opp.get("canal"),
        # Validade recomendada — o comercial altera na tela quando precisar.
        validade=date.fromisoformat(crm_cotacao_service.validade_sugerida()),
        endereco_cidade=endereco_cidade,
        endereco_uf=endereco_uf,
        itens=[CotacaoItem(
            produto_id=i.get("produto_id"), codigo=i.get("codigo"), descricao=i.get("descricao"),
            qtd=float(i.get("qtd") or 0), valor_unitario=float(i.get("valor_unitario") or 0),
        ) for i in validos],
    )
    cot = crm_cotacao_service.criar_cotacao(payload, usuario)
    _log_evento(db, oportunidade_id, f"📄 Proposta gerada automaticamente: {cot['numero']}", str(usuario.id))
    return {"id": cot["id"], "numero": cot["numero"], "nova": True}


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
    # GANHO e PERDIDO são DESFECHOS, não pontos de partida — e cada um tem um
    # portão próprio (`ganhar_oportunidade` confere estoque, abre a OV no kanban da
    # expedição e o repasse; `perder_oportunidade` exige motivo codificado).
    # Nascer já em GANHO furava os dois: dava oportunidade ganha sem OV, sem repasse
    # e — depois desta feature — sem a conferência de estoque.
    if payload.estagio in ("GANHO", "PERDIDO"):
        raise HTTPException(
            status_code=422,
            detail="Oportunidade não nasce ganha nem perdida. Crie no funil e use o botão "
                   "Ganhar/Perder, que é o que confere o estoque e abre a OV. "
                   "Se a venda já está fechada e não passou pelo funil, use Venda Outbound.")
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
    entrando_em_proposta = payload.estagio == "PROPOSTA" and atual.get("estagio") != "PROPOSTA"
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

    out = obter_oportunidade(oportunidade_id)
    if entrando_em_proposta:
        # A proposta é gerada automaticamente a partir do que foi negociado —
        # sem isso o vendedor teria que redigitar tudo na aba Cotações.
        try:
            cot = _gerar_cotacao_proposta(db, oportunidade_id, usuario)
        except Exception:
            cot = None
        if cot:
            out["cotacao_gerada_id"] = cot["id"]
            out["cotacao_gerada_numero"] = cot["numero"]
    return out


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
    try:
        rows = db.table("crm_desafios").select("*, crm_desafio_tipos(label)")\
            .eq("oportunidade_id", oportunidade_id).order("criado_em").execute().data
    except Exception:
        # Migration v22 pendente: a tela mostra "nenhum desafio" em vez de quebrar.
        return []
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


# ── Repasse: comercial ganhou → operações de vendas gera a OV ───────────────────
#
# O passo que faltava no app. O comercial ganha, alguém de operações precisa
# emitir a OV no D365 e só então cadastrá-la aqui. Esse aviso viajava por Teams
# ou e-mail, fora do sistema — então nada sabia que o pedido existia e ninguém
# conseguia responder "o que está pendente?" nem "alguém já pegou?".
#
# Estados: AGUARDANDO (ninguém pegou) → ASSUMIDO (operações está fazendo)
# → CONCLUIDO (OV cadastrada). O primeiro é derivável de ganho+sem OV; o segundo
# não é — e é exatamente a informação que a mensagem de Teams carregava.

REPASSE_STATUS = {
    "AGUARDANDO": "Aguardando operações",
    "ASSUMIDO": "Em emissão no D365",
    "CONCLUIDO": "OV cadastrada",
}


def _notificar_comercial(texto: str) -> None:
    """Avisa o canal do repasse. Cai no canal da Expedição quando o específico não
    está configurado — aviso no canal errado é menos ruim do que aviso nenhum."""
    from app.core.config import settings
    from app.services.pedido_service import _enviar_teams
    webhook = settings.teams_webhook_comercial
    if webhook:
        import requests as _req
        try:
            _req.post(webhook, json={"text": texto}, timeout=5)
        except Exception:
            pass
        return
    _enviar_teams(texto)


def ganhas_sem_ov(db) -> list:
    """Fila do repasse: ganhas que ainda não viraram OV no app.

    Fonte ÚNICA da definição — a tela de Início, o resumo do Teams, o badge da
    sidebar e o painel de repasse leem daqui. Mesmo motivo de
    `risco_multa_estoque` na licitação: duas definições paralelas acabam
    divergindo e um alerta passa a contradizer o outro.
    """
    try:
        rows = db.table("crm_oportunidades")\
            .select("id, titulo, valor_estimado, canal, ganho_em, repasse_status, repasse_em, "
                    "repasse_nota, repasse_assumido_em, repasse_assumido_por, clientes(nome)")\
            .eq("ativo", True).eq("estagio", "GANHO").is_("gerado_ov_id", "null")\
            .order("ganho_em", desc=False).execute().data
    except Exception:
        # Migration v25 pendente: sem as colunas de repasse a fila fica vazia em
        # vez de derrubar a tela de Início inteira.
        return []

    # Nome de quem assumiu resolvido à parte: crm_oportunidades tem mais de uma FK
    # para usuarios, então `usuarios(nome)` embutido sairia ambíguo.
    nomes = _nomes_usuarios(db, [r.get("repasse_assumido_por") for r in rows])

    agora = datetime.now(timezone.utc)
    out = []
    for r in rows:
        ref = _parse_dt(r.get("repasse_em") or r.get("ganho_em"))
        dias = (agora - ref).days if ref else 0
        out.append({
            "id": r["id"],
            "titulo": r.get("titulo"),
            "cliente": (r.get("clientes") or {}).get("nome"),
            "canal": r.get("canal"),
            "valor_estimado": float(r.get("valor_estimado") or 0),
            "ganho_em": r.get("ganho_em"),
            "repasse_em": r.get("repasse_em") or r.get("ganho_em"),
            "repasse_status": r.get("repasse_status") or "AGUARDANDO",
            "repasse_nota": r.get("repasse_nota"),
            "repasse_assumido_em": r.get("repasse_assumido_em"),
            "repasse_assumido_por_nome": nomes.get(r.get("repasse_assumido_por")),
            "dias_esperando": dias,
        })
    return out


def _nomes_usuarios(db, ids: list) -> dict:
    limpos = list({i for i in ids if i})
    if not limpos:
        return {}
    try:
        rows = db.table("usuarios").select("id, nome").in_("id", limpos).execute().data
        return {r["id"]: r.get("nome") for r in rows}
    except Exception:
        return {}


def _parse_dt(valor):
    if not valor:
        return None
    try:
        d = datetime.fromisoformat(str(valor).replace("Z", "+00:00"))
        return d if d.tzinfo else d.replace(tzinfo=timezone.utc)
    except Exception:
        return None


def listar_repasses() -> list:
    return ganhas_sem_ov(get_service_db())


def assumir_repasse(oportunidade_id: str, usuario: UsuarioOut) -> dict:
    """Operações de vendas declara que pegou o pedido.

    É o "deixa comigo" da mensagem de Teams. Sem isso, comercial não distingue
    "ninguém olhou" de "já está sendo emitido" — a dúvida que gerava a cobrança
    por mensagem."""
    db = get_service_db()
    o = db.table("crm_oportunidades").select("id, titulo, estagio, gerado_ov_id, repasse_status")\
        .eq("id", oportunidade_id).single().execute().data
    if not o:
        raise HTTPException(status_code=404, detail="Oportunidade não encontrada")
    if o.get("estagio") != "GANHO":
        raise HTTPException(status_code=422, detail="Só oportunidade ganha entra no repasse.")
    if o.get("gerado_ov_id"):
        raise HTTPException(status_code=400, detail="Esta oportunidade já tem OV cadastrada.")

    agora = _agora()
    db.table("crm_oportunidades").update({
        "repasse_status": "ASSUMIDO",
        "repasse_assumido_por": str(usuario.id),
        "repasse_assumido_em": agora,
        "atualizado_em": agora,
    }).eq("id", oportunidade_id).execute()
    _log_evento(db, oportunidade_id,
                f"🙋 {usuario.nome} assumiu o repasse — emitindo a OV no D365", str(usuario.id))
    _notificar_comercial(
        f"🙋 **Repasse assumido** — {o.get('titulo')}\n\n"
        f"{usuario.nome} está emitindo a OV no D365.")
    return obter_oportunidade(oportunidade_id)


def _itens_ov_parcial(itens_rows: list, analise: dict) -> list:
    """Os itens da OV com a quantidade que a MSB tem para entregar AGORA.

    O saldo não entra: se entrasse, o "comprometido" do estoque passaria a
    reservar material que não existe, e a tela Estoque começaria a mostrar
    disponível negativo por uma promessa que ninguém pode cumprir.
    """
    por_ref = {i.get("ref"): i for i in (analise.get("itens") or []) if i.get("ref") is not None}
    saida = []
    for idx, row in enumerate(itens_rows):
        a = por_ref.get(idx)
        # Item fora da análise (qtd zero) mantém o que estava — não é falta.
        qtd = float(row.get("qtd") or 0) if a is None else float(a.get("qtd_atendida") or 0)
        if qtd <= 0:
            continue
        saida.append({**row, "qtd": qtd})
    return saida


def disponibilidade(oportunidade_id: str, sincronizar: bool = False) -> dict:
    """Quanto do que esta oportunidade pede existe em estoque. Só informa."""
    return disponibilidade_service.analisar_oportunidade(oportunidade_id, sincronizar=sincronizar)


def ganhar_oportunidade(oportunidade_id: str, usuario: UsuarioOut,
                        repasse_nota: Optional[str] = None,
                        decisao_estoque: Optional[str] = None,
                        observacao_estoque: Optional[str] = None,
                        previsao_pcp: Optional[str] = None) -> dict:
    db = get_service_db()
    falta = requisitos_ganho(db, oportunidade_id)
    if falta:
        raise HTTPException(status_code=422,
                            detail="Para marcar como ganha, falta: " + "; ".join(falta) + ".")

    opp_atual = db.table("crm_oportunidades").select("*").eq("id", oportunidade_id).single().execute().data or {}
    itens_rows = db.table("crm_oportunidade_itens").select("*")\
        .eq("oportunidade_id", oportunidade_id).order("id").execute().data

    # ── Estoque: a OV só desce para a expedição com o que existe de fato ──────
    # A conferência é AQUI, no ganho, e não na criação da oportunidade: é este o
    # instante em que a quantidade vira compromisso com o cliente e reserva de
    # material. Sincroniza com o PCP porque decidir com a foto de ontem é a mesma
    # falha de não olhar o estoque.
    analise = disponibilidade_service.analisar(
        disponibilidade_service.entrada_de_itens_crm(itens_rows), sincronizar=True)
    pend_existente = opp_atual.get("pendencia") or {}
    decisao = (decisao_estoque or "").strip().upper() or pend_existente.get("decisao")

    if analise.get("tem_falta") and decisao not in ("PARCIAL", "AGUARDAR"):
        # 409 com a análise inteira: o front abre o modal de decisão mostrando
        # item a item o que tem, o que falta e quando o semiacabado vira PA.
        raise HTTPException(status_code=409, detail={
            "tipo": "ESTOQUE_INSUFICIENTE",
            "msg": "Não há material para toda a quantidade desta venda. Escolha seguir "
                   "com o que temos ou aguardar a produção.",
            "analise": analise,
        })

    atendidos = disponibilidade_service.itens_atendidos(analise)
    pendentes = disponibilidade_service.itens_pendentes(analise)
    # Sem nada disponível não há OV para abrir, qualquer que tenha sido a escolha:
    # "seguir com o disponível" quando o disponível é zero é aguardar.
    aguardar = bool(pendentes) and (decisao == "AGUARDAR" or not atendidos)
    pendencia = pendencia_service.montar(
        analise, decisao or "AGUARDAR", str(usuario.id), origem="GANHO",
        observacao=observacao_estoque, previsao_pcp=previsao_pcp) if pendentes else None

    agora = _agora()
    update = {
        "estagio": "GANHO", "probabilidade": 100, "ganho_em": agora,
        "estagio_em": agora,
        "perdido_em": None, "motivo_perda": None, "motivo_perda_codigo": None,
        "atualizado_em": agora,
    }
    nota = (repasse_nota or "").strip() or None

    # A OV já nasce no kanban da Expedição: cliente e valor conhecidos, número
    # real e data ficam para a operadora completar direto no card. Não depende
    # mais de alguém abrir o CRM e clicar em "gerar OV" — some passo manual.
    stub = None
    if not opp_atual.get("gerado_ov_id") and not aguardar:
        try:
            from app.services import pedido_service
            # Com pendência, a OV nasce só com o que dá para entregar. Sem
            # pendência, com tudo — é o caminho normal e não muda nada.
            itens = _itens_ov_parcial(itens_rows, analise) if pendentes else itens_rows
            stub = pedido_service.criar_pedido_stub_crm({**opp_atual, **update}, itens, str(usuario.id))
        except Exception:
            stub = None

    if stub:
        update["gerado_ov_id"] = stub["id"]
        update["gerado_ov_ref"] = stub["numero_pedido"]

    base = {**update,
            "repasse_status": "CONCLUIDO" if stub else "AGUARDANDO",
            "repasse_em": agora, "repasse_nota": nota}
    if pendencia is not None:
        base["pendencia"] = pendencia
    try:
        db.table("crm_oportunidades").update(base).eq("id", oportunidade_id).execute()
    except Exception:
        # v25/v29 pendentes — ganha do mesmo jeito, só sem entrar na fila nem
        # registrar a pendência. Melhor perder o registro do que travar a venda.
        db.table("crm_oportunidades").update(update).eq("id", oportunidade_id).execute()

    _log_evento(db, oportunidade_id, "🏆 Oportunidade marcada como GANHA", str(usuario.id))
    if stub:
        _log_evento(db, oportunidade_id,
                    f"📦 OV {stub['numero_pedido']} criada direto no kanban da Expedição "
                    "(aguardando completar número real e data)", str(usuario.id))
    if pendencia:
        faltas = ", ".join(
            f"{i.get('codigo') or '—'} {float(i.get('qtd_pendente') or 0):g} un"
            for i in pendencia.get("itens") or [])
        _log_evento(
            db, oportunidade_id,
            ("⏳ Aguardando produção — nenhuma OV foi aberta. " if aguardar
             else "📦 Seguiu com o material disponível. ")
            + f"Pendência de estoque: {faltas} (R$ {float(pendencia.get('valor') or 0):,.2f})",
            str(usuario.id))

    opp = obter_oportunidade(oportunidade_id)
    if pendencia:
        pend_txt = (
            f"\n\n⚠️ **Pendência de estoque: R$ {float(pendencia.get('valor') or 0):,.2f}**\n"
            + "\n".join(f"· {i.get('codigo') or '—'} — faltam {float(i.get('qtd_pendente') or 0):g} un"
                        for i in pendencia.get("itens") or [])
            + (f"\nSemiacabado vira PA por volta de {pendencia.get('previsao_sa')}."
               if pendencia.get("cobre_com_sa") else ""))
    else:
        pend_txt = ""
    if aguardar:
        destino = ("\n\nNENHUMA OV foi aberta — a venda está aguardando produção. "
                   "Quando o material chegar, libere a pendência no CRM para a OV nascer.")
    elif stub and pendencia:
        destino = ("\n\nA OV caiu no kanban da Expedição SÓ com o que temos em estoque. "
                   "O saldo entra depois como 2ª remessa, na mesma OV.")
    elif stub:
        destino = ("\n\nJá caiu no kanban da Expedição — operações de vendas completa o número "
                   "real da OV e a data de entrega direto no card.")
    else:
        destino = "\n\nOperações de vendas: cadastre a OV no app pelo painel Repasse do CRM."
    _notificar_comercial(
        f"🏆 **Venda ganha**\n\n"
        f"**{opp.get('titulo')}**\n"
        f"Cliente: {opp.get('cliente') or '—'}\n"
        f"Valor: R$ {float(opp.get('valor_estimado') or 0):,.2f}\n"
        f"Comercial: {usuario.nome}\n"
        + (f"Recado: {opp.get('repasse_nota')}\n" if opp.get("repasse_nota") else "")
        + pend_txt + destino
    )
    return opp


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
    """Cadastra no app a OV já emitida no D365, fechando o repasse.

    `numero_pedido` é o número que veio do D365 — o app não emite OV lá, ele
    registra a que operações de vendas acabou de criar. É o último passo do
    repasse: daqui em diante a OV segue o fluxo logístico normal.
    """
    from app.services import pedido_service
    from app.models.schemas import ItemPedidoCreate, PedidoCreate

    db = get_service_db()
    o = db.table("crm_oportunidades").select("*").eq("id", oportunidade_id).single().execute().data
    if not o:
        raise HTTPException(status_code=404, detail="Oportunidade não encontrada")
    if o.get("gerado_ov_id"):
        raise HTTPException(status_code=400, detail="Esta oportunidade já gerou uma OV.")
    # A OV nasce de venda fechada. Sem esta guarda dava para cadastrar OV de
    # oportunidade ainda em negociação, e o funil passava a mentir.
    if o.get("estagio") != "GANHO":
        raise HTTPException(
            status_code=422,
            detail="Só oportunidade GANHA gera OV — marque como ganha antes.")
    if not o.get("cliente_id"):
        raise HTTPException(status_code=400, detail="Defina o cliente da oportunidade antes de gerar a OV.")

    itens = db.table("crm_oportunidade_itens").select("*").eq("oportunidade_id", oportunidade_id).execute().data
    itens_validos = [i for i in itens if i.get("produto_id") and float(i.get("qtd") or 0) > 0]
    if not itens_validos:
        raise HTTPException(status_code=422, detail="A oportunidade precisa ter itens (produto e quantidade) para gerar a OV.")

    # Cadastro manual da OV precisa obedecer à MESMA decisão de estoque do ganho.
    # Sem isto, quem passasse por aqui em vez do fluxo automático emitiria a OV com
    # a quantidade cheia e a pendência viraria promessa duplicada.
    pend = o.get("pendencia") or {}
    if pend and not pend.get("resolvido_em"):
        atendida_por_produto: dict = {}
        for ip in pend.get("itens") or []:
            if ip.get("produto_id"):
                atendida_por_produto[ip["produto_id"]] = float(ip.get("qtd_atendida") or 0)
        ajustados = []
        for i in itens_validos:
            if i["produto_id"] in atendida_por_produto:
                q = atendida_por_produto[i["produto_id"]]
                if q <= 0:
                    continue
                ajustados.append({**i, "qtd": q})
            else:
                ajustados.append(i)
        if not ajustados:
            raise HTTPException(
                status_code=409,
                detail="Toda a quantidade desta venda está pendente de estoque — não há o que "
                       "faturar ainda. Libere a pendência quando o material chegar.")
        itens_validos = ajustados

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
    vinculo = {"gerado_ov_id": ov.get("id"), "gerado_ov_ref": ov.get("numero_pedido"),
               "atualizado_em": _agora()}
    try:
        db.table("crm_oportunidades").update({**vinculo, "repasse_status": "CONCLUIDO"})\
            .eq("id", oportunidade_id).execute()
    except Exception:
        db.table("crm_oportunidades").update(vinculo).eq("id", oportunidade_id).execute()

    _log_evento(db, oportunidade_id,
                f"📦 OV {ov.get('numero_pedido')} cadastrada — repasse concluído, segue no fluxo logístico",
                str(usuario.id))
    # Fecha o ciclo para o comercial: ele abriu o repasse e agora sabe o número
    # da OV sem precisar perguntar.
    _notificar_comercial(
        f"📦 **OV cadastrada — repasse concluído**\n\n"
        f"**{o.get('titulo')}**\n"
        f"OV: {ov.get('numero_pedido')}\n"
        f"Cadastrada por: {usuario.nome}\n\n"
        f"Segue agora no fluxo normal da expedição.")
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

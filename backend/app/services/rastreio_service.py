# -*- coding: utf-8 -*-
"""Onde está cada carga CIF que já saiu daqui.

A informação existe — no site da BRIX e no grupo de WhatsApp da RR —, mas vive
fora do sistema: quem cobrou o comprovante ontem é a única pessoa que sabe o que
a transportadora respondeu. Aqui cada consulta vira um evento preso à OV, e o
estado de cada carga sai do evento mais recente.

Só CIF: no FOB quem contrata o frete é o cliente, e cobrar entrega de um frete
que não é nosso seria inventar responsabilidade.

A conta de "exige atenção" é deliberadamente dura: carga sem notícia há dias
conta como problema, porque o silêncio da transportadora é justamente o que faz
a entrega atrasada aparecer tarde demais.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from app.core.database import get_service_db

# Situações que a equipe lança, na ordem em que a carga costuma andar.
SITUACOES = {
    "EM_TRANSITO":          {"rotulo": "Em trânsito",            "atencao": False, "fim": False},
    "SAIU_PARA_ENTREGA":    {"rotulo": "Saiu para entrega",      "atencao": False, "fim": False},
    "AGENDADA":             {"rotulo": "Entrega agendada",       "atencao": False, "fim": False},
    "ENTREGUE":             {"rotulo": "Entregue",               "atencao": False, "fim": False},
    "COMPROVANTE_RECEBIDO": {"rotulo": "Comprovante recebido",   "atencao": False, "fim": True},
    "OCORRENCIA":           {"rotulo": "Ocorrência",             "atencao": True,  "fim": False},
    "RECUSADA":             {"rotulo": "Recusada pelo cliente",  "atencao": True,  "fim": False},
    "EXTRAVIO":             {"rotulo": "Extravio",               "atencao": True,  "fim": False},
    "DEVOLUCAO":            {"rotulo": "Em devolução",           "atencao": True,  "fim": False},
    "SEM_INFORMACAO":       {"rotulo": "Transportadora não informou", "atencao": True, "fim": False},
}
ENTREGA = ("ENTREGUE", "COMPROVANTE_RECEBIDO")

# Status de OV que significam "já saiu ou está para sair daqui".
_EM_ROTA = ("AGUARD_COLETA", "COLETADO", "EXPEDIDO")

# Dias corridos sem nenhuma notícia antes de a carga virar cobrança.
DIAS_SEM_NOTICIA = 3


def _hoje() -> date:
    return date.today()


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dia(valor) -> Optional[date]:
    """A data de um campo que tanto pode vir como data quanto como timestamp."""
    if not valor:
        return None
    try:
        return date.fromisoformat(str(valor)[:10])
    except ValueError:
        return None


def _resumir(pedido: dict, eventos: list) -> dict:
    """O estado de uma carga a partir dos eventos lançados nela."""
    eventos = sorted(eventos, key=lambda e: str(e.get("ocorrido_em") or ""))
    ultimo = eventos[-1] if eventos else None

    entrega = next((e for e in eventos if e["situacao"] in ENTREGA), None)
    comprovante = next((e for e in eventos if e["situacao"] == "COMPROVANTE_RECEBIDO"), None)

    # A previsão vale a mais recente: a transportadora repactua prazo, e cobrar
    # pela data velha é discutir com ela sobre um combinado que já mudou.
    repactuadas = [e["nova_previsao"] for e in eventos if e.get("nova_previsao")]
    previsao = _dia(repactuadas[-1]) if repactuadas else _dia(pedido.get("data_prevista_entrega"))

    saida = (_dia(pedido.get("data_real_coleta")) or _dia(pedido.get("data_faturamento"))
             or _dia(pedido.get("criado_em")))
    ultima_noticia = _dia(ultimo["ocorrido_em"]) if ultimo else saida
    sem_noticia = (_hoje() - ultima_noticia).days if ultima_noticia else None

    situacao = ultimo["situacao"] if ultimo else "SEM_LANCAMENTO"
    meta = SITUACOES.get(situacao, {"rotulo": "Sem acompanhamento", "atencao": False, "fim": False})

    atrasada = bool(previsao and not entrega and previsao < _hoje())
    calada = bool(not entrega and sem_noticia is not None and sem_noticia >= DIAS_SEM_NOTICIA)
    atencao = meta["atencao"] or atrasada or calada

    if comprovante:
        aba = "encerradas"
    elif entrega:
        aba = "sem_comprovante"
    elif atencao:
        aba = "atencao"
    else:
        aba = "transito"

    motivos = []
    if meta["atencao"]:
        motivos.append(meta["rotulo"])
    if atrasada:
        motivos.append("Passou da previsão (%s)" % previsao.strftime("%d/%m"))
    if calada:
        motivos.append("Sem notícia há %d dias" % sem_noticia)

    return {
        "situacao": situacao,
        "situacao_rotulo": meta["rotulo"],
        # separar "ninguem acompanhou ainda" de "a transportadora deu problema":
        # as duas exigem acao, mas nao a mesma acao
        "sem_lancamento": not eventos,
        "aba": aba,
        "atencao": atencao,
        "motivos": motivos,
        "previsao": previsao.isoformat() if previsao else None,
        "previsao_repactuada": bool(repactuadas),
        "saida": saida.isoformat() if saida else None,
        "dias_desde_saida": (_hoje() - saida).days if saida else None,
        "dias_sem_noticia": sem_noticia,
        "entregue_em": entrega["ocorrido_em"] if entrega else None,
        "recebedor": (entrega or {}).get("recebedor"),
        "documento_recebedor": (entrega or {}).get("documento_recebedor"),
        "comprovante_em": comprovante["ocorrido_em"] if comprovante else None,
        "ultimo_evento": ultimo,
        "eventos": eventos,
    }


def _pedidos_em_rota(desde: Optional[date], ate: Optional[date]) -> list:
    db = get_service_db()
    pedidos, offset = [], 0
    while True:
        bloco = (db.table("pedidos")
                 .select("id, numero_pedido, numero_nf, status, tipo_frete, local_entrega, "
                         "endereco_entrega, prioridade, valor_nf, valor_produtos, "
                         "data_faturamento, data_real_coleta, data_prevista_entrega, "
                         "data_esperada_cliente, codigo_rastreio, criado_em, "
                         "transportadoras(nome), clientes(nome)")
                 .in_("status", list(_EM_ROTA)).limit(1000).offset(offset).execute().data)
        pedidos += bloco
        if len(bloco) < 1000:
            break
        offset += 1000

    saida = []
    for p in pedidos:
        if not (p.get("tipo_frete") or "").startswith("CIF"):
            continue
        quando = (_dia(p.get("data_real_coleta")) or _dia(p.get("data_faturamento"))
                  or _dia(p.get("criado_em")))
        if desde and (not quando or quando < desde):
            continue
        if ate and quando and quando > ate:
            continue
        saida.append(p)
    return saida


def _eventos_de(ids: list) -> dict:
    """Eventos por pedido. Em lotes porque o filtro `in` viaja na URL."""
    db, por_pedido = get_service_db(), {}
    for i in range(0, len(ids), 40):
        for e in (db.table("rastreios").select("*")
                  .in_("pedido_id", ids[i:i + 40]).execute().data):
            por_pedido.setdefault(e["pedido_id"], []).append(e)
    return por_pedido


def painel(desde: Optional[date] = None, ate: Optional[date] = None,
           transportadora: Optional[str] = None) -> dict:
    """Todas as cargas CIF em rota, já separadas pelo que cada uma exige."""
    pedidos = _pedidos_em_rota(desde, ate)
    if transportadora:
        alvo = transportadora.strip().upper()
        pedidos = [p for p in pedidos
                   if ((p.get("transportadoras") or {}).get("nome") or "").upper() == alvo]

    eventos = _eventos_de([p["id"] for p in pedidos]) if pedidos else {}

    linhas = []
    for p in pedidos:
        r = _resumir(p, eventos.get(p["id"], []))
        linhas.append({
            "pedido_id": p["id"],
            "numero_pedido": p.get("numero_pedido"),
            "numero_nf": p.get("numero_nf"),
            "status": p.get("status"),
            "cliente": (p.get("clientes") or {}).get("nome"),
            "transportadora": (p.get("transportadoras") or {}).get("nome"),
            "destino": p.get("local_entrega"),
            "endereco": p.get("endereco_entrega"),
            "prioridade": p.get("prioridade"),
            "valor_nf": p.get("valor_nf") or p.get("valor_produtos"),
            "data_esperada_cliente": p.get("data_esperada_cliente"),
            "codigo_rastreio": p.get("codigo_rastreio"),
            **r,
        })

    # Quem precisa de ação primeiro: atrasada há mais tempo no topo.
    ordem = {"atencao": 0, "transito": 1, "sem_comprovante": 2, "encerradas": 3}
    linhas.sort(key=lambda l: (ordem.get(l["aba"], 9), -(l["dias_desde_saida"] or 0)))

    contagem = {k: 0 for k in ordem}
    for l in linhas:
        contagem[l["aba"]] = contagem.get(l["aba"], 0) + 1

    por_transportadora = {}
    for l in linhas:
        nome = l["transportadora"] or "Sem transportadora"
        t = por_transportadora.setdefault(nome, {"total": 0, "atencao": 0, "em_aberto": 0})
        t["total"] += 1
        t["atencao"] += 1 if l["aba"] == "atencao" else 0
        t["em_aberto"] += 0 if l["aba"] == "encerradas" else 1

    return {"linhas": linhas, "contagem": contagem,
            "por_transportadora": por_transportadora,
            "situacoes": [{"valor": k, **v} for k, v in SITUACOES.items()]}


def historico(pedido_id: str) -> list:
    db = get_service_db()
    eventos = (db.table("rastreios")
               .select("*, usuarios(nome)")
               .eq("pedido_id", str(pedido_id)).execute().data)
    return sorted(eventos, key=lambda e: str(e.get("ocorrido_em") or ""), reverse=True)


def lancar(pedido_id: str, dados: dict, usuario_id: Optional[str] = None) -> dict:
    """Registra o que a transportadora informou nesta carga."""
    situacao = (dados.get("situacao") or "").upper()
    if situacao not in SITUACOES:
        raise ValueError("Situação inválida: %s" % situacao)

    db = get_service_db()
    pedido = db.table("pedidos").select("id, tipo_frete, status").eq(
        "id", str(pedido_id)).execute().data
    if not pedido:
        raise ValueError("OV não encontrada")
    if not (pedido[0].get("tipo_frete") or "").startswith("CIF"):
        raise ValueError("Esta OV não é CIF — o frete é do cliente, não há o que rastrear aqui")

    evento = {
        "pedido_id": str(pedido_id),
        "situacao": situacao,
        "ocorrido_em": dados.get("ocorrido_em") or _agora(),
        "fonte": dados.get("fonte"),
        "descricao": (dados.get("descricao") or "").strip() or None,
        "recebedor": (dados.get("recebedor") or "").strip() or None,
        "documento_recebedor": (dados.get("documento_recebedor") or "").strip() or None,
        "nova_previsao": dados.get("nova_previsao") or None,
        "usuario_id": str(usuario_id) if usuario_id else None,
        "criado_em": _agora(),
    }
    criado = db.table("rastreios").insert(evento).execute().data

    # A previsão repactuada vale para o resto do app (programação de coleta,
    # cobrança do comercial), não só para esta tela.
    if evento["nova_previsao"]:
        db.table("pedidos").update(
            {"data_prevista_entrega": evento["nova_previsao"]}).eq("id", str(pedido_id)).execute()

    return (criado or [evento])[0]


def apagar(evento_id: str) -> None:
    """Desfaz um lançamento errado — o histórico só serve se puder ser corrigido."""
    get_service_db().table("rastreios").delete().eq("id", str(evento_id)).execute()

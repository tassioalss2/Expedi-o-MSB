# -*- coding: utf-8 -*-
"""Onde está cada carga CIF que saiu daqui nos últimos dias.

A informação existe — no portal da BRIX e no grupo de WhatsApp da RR —, mas vive
fora do sistema: quem cobrou o comprovante ontem é a única pessoa que sabe o que
a transportadora respondeu. Aqui cada consulta vira um evento preso à OV.

O controle começa na SEGUNDA DA SEMANA PASSADA, de propósito. A primeira versão
abria o mês inteiro e trazia 61 cargas, contra 13 em aberto no portal da BRIX:
a diferença não era problema de entrega, era histórico que ninguém ia acompanhar.
Controle que nasce com fila impossível não é usado.

Só CIF: no FOB quem contrata o frete é o cliente, e cobrar entrega de um frete
que não é nosso seria inventar responsabilidade.

Cada carga explica por que está onde está — `explicacao` carrega a regra e os
números que a classificaram, para a tela poder responder "por quê?" sem que
ninguém precise adivinhar a conta.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from app.core.database import get_service_db

# Seis situações, não dez. A lista longa (extravio, devolução, recusa…) fazia a
# equipe parar para escolher entre rótulos parecidos; o que varia de verdade
# entra na descrição, que é texto livre.
SITUACOES = {
    "EM_TRANSITO":          {"rotulo": "Em trânsito",                "atencao": False},
    "SAIU_PARA_ENTREGA":    {"rotulo": "Saiu para entrega",          "atencao": False},
    "ENTREGUE":             {"rotulo": "Entregue",                   "atencao": False},
    "COMPROVANTE_RECEBIDO": {"rotulo": "Entregue, canhoto recebido", "atencao": False},
    "PROBLEMA":             {"rotulo": "Problema na entrega",        "atencao": True},
    "SEM_RESPOSTA":         {"rotulo": "Transportadora não respondeu", "atencao": True},
}
ENTREGA = ("ENTREGUE", "COMPROVANTE_RECEBIDO")

_EM_ROTA = ("AGUARD_COLETA", "COLETADO", "EXPEDIDO")

# Dias corridos sem notícia antes de a carga virar cobrança.
DIAS_SEM_NOTICIA = 3


def corte_padrao(hoje: Optional[date] = None) -> date:
    """Segunda-feira da semana passada — onde este controle começa."""
    hoje = hoje or date.today()
    return hoje - timedelta(days=hoje.weekday() + 7)


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _dia(valor) -> Optional[date]:
    if not valor:
        return None
    try:
        return date.fromisoformat(str(valor)[:10])
    except ValueError:
        return None


def _br(d: Optional[date]) -> str:
    return d.strftime("%d/%m") if d else "—"


def _resumir(pedido: dict, eventos: list, hoje: date) -> dict:
    """O estado de uma carga, com a conta aberta de como ele foi decidido."""
    eventos = sorted(eventos, key=lambda e: str(e.get("ocorrido_em") or ""))
    ultimo = eventos[-1] if eventos else None

    entrega = next((e for e in eventos if e["situacao"] in ENTREGA), None)
    comprovante = next((e for e in eventos if e["situacao"] == "COMPROVANTE_RECEBIDO"), None)

    # A previsão que vale é a mais recente: a transportadora repactua prazo, e
    # cobrar pela data velha é discutir sobre um combinado que já mudou.
    repactuadas = [e["nova_previsao"] for e in eventos if e.get("nova_previsao")]
    previsao = _dia(repactuadas[-1]) if repactuadas else _dia(pedido.get("data_prevista_entrega"))

    saida = (_dia(pedido.get("data_real_coleta")) or _dia(pedido.get("data_faturamento"))
             or _dia(pedido.get("criado_em")))
    ultima_noticia = _dia(ultimo["ocorrido_em"]) if ultimo else saida
    sem_noticia = (hoje - ultima_noticia).days if ultima_noticia else None

    situacao = ultimo["situacao"] if ultimo else "SEM_LANCAMENTO"
    meta = SITUACOES.get(situacao, {"rotulo": "Ninguém acompanhou ainda", "atencao": False})

    atrasada = bool(previsao and not entrega and previsao < hoje)
    calada = bool(not entrega and sem_noticia is not None and sem_noticia >= DIAS_SEM_NOTICIA)
    atencao = meta["atencao"] or atrasada or calada

    if comprovante:
        grupo = "concluidas"
    elif entrega:
        grupo = "canhoto"
    else:
        grupo = "aberto"

    # Cada alerta carrega a regra e o número que a disparou: é o que a tela
    # mostra quando alguém clica em "por quê?".
    alertas = []
    if meta["atencao"]:
        alertas.append({"texto": meta["rotulo"],
                        "porque": "Foi o que a equipe lançou no último acompanhamento%s."
                                  % (" — " + ultimo["descricao"] if ultimo and ultimo.get("descricao") else "")})
    if atrasada:
        alertas.append({"texto": "Passou da previsão (%s)" % _br(previsao),
                        "porque": "A entrega estava prevista para %s e ainda não há lançamento de entrega. "
                                  "Hoje é %s." % (_br(previsao), _br(hoje))})
    if calada:
        alertas.append({"texto": "Sem notícia há %d dias" % sem_noticia,
                        "porque": "A última informação desta carga é de %s%s. A partir de %d dias "
                                  "sem notícia a carga entra aqui, porque o silêncio da transportadora "
                                  "é o que faz o atraso aparecer tarde."
                                  % (_br(ultima_noticia),
                                     " (saída da carga, nenhum acompanhamento lançado)" if not ultimo else "",
                                     DIAS_SEM_NOTICIA)})

    explicacao = {
        "grupo": {
            "aberto": "Saiu daqui e ainda não há lançamento de entrega.",
            "canhoto": "Entrega lançada, mas o canhoto ainda não foi recebido.",
            "concluidas": "Entregue e com canhoto em mãos — nada mais a cobrar.",
        }[grupo],
        "saida": "Saída em %s (%s)." % (
            _br(saida),
            "coleta registrada" if _dia(pedido.get("data_real_coleta")) else "data do faturamento"),
        "previsao": ("Previsão %s, repactuada pela transportadora no acompanhamento."
                     % _br(previsao)) if repactuadas else
                    ("Previsão %s, do prazo da OV." % _br(previsao)) if previsao else
                    "Esta OV não tem previsão de entrega preenchida.",
        "situacao": ("Último acompanhamento: %s, em %s." % (meta["rotulo"], _br(ultima_noticia)))
                    if ultimo else "Nenhum acompanhamento foi lançado nesta carga ainda.",
    }

    return {
        "situacao": situacao,
        "situacao_rotulo": meta["rotulo"],
        "sem_lancamento": not eventos,
        "grupo": grupo,
        "atencao": atencao,
        "alertas": alertas,
        "explicacao": explicacao,
        "previsao": previsao.isoformat() if previsao else None,
        "previsao_repactuada": bool(repactuadas),
        "saida": saida.isoformat() if saida else None,
        "dias_desde_saida": (hoje - saida).days if saida else None,
        "dias_sem_noticia": sem_noticia,
        "entregue_em": entrega["ocorrido_em"] if entrega else None,
        "recebedor": (entrega or {}).get("recebedor"),
        "comprovante_em": comprovante["ocorrido_em"] if comprovante else None,
        "eventos": eventos,
    }


def _pedidos_em_rota(desde: date) -> list:
    db = get_service_db()
    pedidos, offset = [], 0
    while True:
        bloco = (db.table("pedidos")
                 .select("id, numero_pedido, numero_nf, status, tipo_frete, local_entrega, "
                         "endereco_entrega, prioridade, valor_nf, valor_produtos, tipo_operacao, "
                         "data_faturamento, data_real_coleta, data_prevista_entrega, "
                         "codigo_rastreio, criado_em, transportadoras(nome), clientes(nome)")
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
        if not quando or quando < desde:
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


def painel(desde: Optional[date] = None, transportadora: Optional[str] = None) -> dict:
    """As cargas CIF que saíram desde o corte, prontas para a tela."""
    hoje = date.today()
    desde = desde or corte_padrao(hoje)

    pedidos = _pedidos_em_rota(desde)
    if transportadora:
        alvo = transportadora.strip().upper()
        pedidos = [p for p in pedidos
                   if ((p.get("transportadoras") or {}).get("nome") or "").upper() == alvo]

    eventos = _eventos_de([p["id"] for p in pedidos]) if pedidos else {}

    linhas = []
    for p in pedidos:
        r = _resumir(p, eventos.get(p["id"], []), hoje)
        linhas.append({
            "pedido_id": p["id"],
            "numero_pedido": p.get("numero_pedido"),
            "numero_nf": (p.get("numero_nf") or "").lstrip("0") or None,
            "cliente": (p.get("clientes") or {}).get("nome"),
            "transportadora": (p.get("transportadoras") or {}).get("nome"),
            "destino": p.get("local_entrega"),
            "endereco": p.get("endereco_entrega"),
            "prioridade": p.get("prioridade"),
            # Amostra, bonificação e consignado andam na mesma esteira da
            # venda, mas a cobrança de entrega muda de tom conforme o que vai
            # dentro da caixa.
            "tipo_operacao": p.get("tipo_operacao"),
            "valor_nf": p.get("valor_nf") or p.get("valor_produtos"),
            "codigo_rastreio": p.get("codigo_rastreio"),
            **r,
        })

    # Pela data que o cliente espera a carga: a mais próxima primeiro. Como
    # previsão vencida é a mais "próxima" de todas, o atraso sobe sozinho ao
    # topo — sem precisar de uma regra à parte para isso. Carga sem previsão vai
    # para o fim, porque não há data para cobrar.
    linhas.sort(key=lambda l: (l["previsao"] is None, l["previsao"] or "",
                               l["numero_nf"] or ""))

    contagem = {"aberto": 0, "canhoto": 0, "concluidas": 0, "atencao": 0}
    for l in linhas:
        contagem[l["grupo"]] += 1
        contagem["atencao"] += 1 if l["atencao"] else 0

    # Por transportadora, porque a cobranca e por transportadora: o portal da
    # BRIX de manha, o grupo da RR durante o dia.
    por_transportadora = {}
    for l in linhas:
        nome = l["transportadora"] or "Sem transportadora"
        t = por_transportadora.setdefault(
            nome, {"total": 0, "aberto": 0, "canhoto": 0, "concluidas": 0, "atencao": 0})
        t["total"] += 1
        t[l["grupo"]] += 1
        t["atencao"] += 1 if l["atencao"] else 0

    transportadoras = sorted({l["transportadora"] for l in linhas if l["transportadora"]})

    return {
        "desde": desde.isoformat(),
        "hoje": hoje.isoformat(),
        "linhas": linhas,
        "contagem": contagem,
        "transportadoras": transportadoras,
        "por_transportadora": por_transportadora,
        "situacoes": [{"valor": k, **v} for k, v in SITUACOES.items()],
        "regras": {
            "corte": "A tela mostra o que saiu daqui a partir de %s — a segunda-feira da semana "
                     "passada. Cargas mais antigas ficam de fora: o controle começa agora."
                     % _br(desde),
            "cif": "Só frete CIF. No FOB quem contrata a transportadora é o cliente, e a entrega "
                   "não é nossa para cobrar.",
            "aberto": "Saiu daqui e ainda não há lançamento de entrega.",
            "canhoto": "Entrega lançada, mas sem o canhoto — é a cobrança diária com a transportadora.",
            "concluidas": "Entregue e com canhoto recebido.",
            "atencao": "Carga que passou da previsão, que teve problema lançado, ou que está há %d "
                       "dias ou mais sem nenhuma notícia." % DIAS_SEM_NOTICIA,
        },
    }


def historico(pedido_id: str) -> list:
    db = get_service_db()
    eventos = (db.table("rastreios").select("*, usuarios(nome)")
               .eq("pedido_id", str(pedido_id)).execute().data)
    return sorted(eventos, key=lambda e: str(e.get("ocorrido_em") or ""), reverse=True)


def lancar(pedido_id: str, dados: dict, usuario_id: Optional[str] = None) -> dict:
    """Registra o que a transportadora informou nesta carga."""
    situacao = (dados.get("situacao") or "").upper()
    if situacao not in SITUACOES:
        raise ValueError("Situação inválida: %s" % situacao)

    db = get_service_db()
    pedido = db.table("pedidos").select("id, tipo_frete").eq("id", str(pedido_id)).execute().data
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

    # A previsão repactuada vale para o resto do app, não só para esta tela.
    if evento["nova_previsao"]:
        db.table("pedidos").update(
            {"data_prevista_entrega": evento["nova_previsao"]}).eq("id", str(pedido_id)).execute()

    return (criado or [evento])[0]


def apagar(evento_id: str) -> None:
    """Desfaz um lançamento errado — o histórico só serve se puder ser corrigido."""
    get_service_db().table("rastreios").delete().eq("id", str(evento_id)).execute()

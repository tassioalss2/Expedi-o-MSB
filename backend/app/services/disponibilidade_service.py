"""Quanto do que a venda pede a MSB tem para entregar HOJE.

O comercial fechava venda sem saber se havia material, e a falta só aparecia na
expedição — depois de a OV já estar emitida no D365 e prometida ao cliente. Este
módulo responde a pergunta antes, no momento em que ela ainda muda a decisão.

"Não tem" é uma resposta ruim para decidir, então a resposta vem em três camadas:

    agora          produto acabado já livre  →  PA − comprometido pelas OVs abertas
    ~2 dias úteis  semiacabado               →  o PCP converte SA em PA em ~2 dias
    depois         só na previsão do PCP     →  data informada por quem acompanha

A camada "agora" é o MESMO número da tela Estoque (`estoque_service.listar`), de
propósito: se cada tela calculasse o seu, comercial e PCP passariam a discutir
qual das duas está certa em vez de resolver a falta.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from app.core.database import get_service_db
from app.services import estoque_service

# Prazo que o PCP leva para converter semiacabado em produto acabado. É uma
# média informada pela operação, não um compromisso do PCP — por isso o app
# mostra a data como previsão e não como promessa.
DIAS_UTEIS_SA = 2


def _hoje_brt() -> date:
    return (datetime.now(timezone.utc) - timedelta(hours=3)).date()


def _mais_dias_uteis(inicio: date, dias: int) -> date:
    """Sem calendário de feriado: só pula fim de semana. Errar um feriado para
    frente é aceitável numa previsão; errar o dia da semana não era."""
    d = inicio
    restantes = dias
    while restantes > 0:
        d = d + timedelta(days=1)
        if d.weekday() < 5:
            restantes -= 1
    return d


def _codigo_por_produto_id(db, produto_ids: list) -> dict:
    """Os itens da oportunidade podem ter só o produto_id; o snapshot do PCP é
    por código, então é preciso traduzir antes de cruzar."""
    ids = [p for p in produto_ids if p]
    if not ids:
        return {}
    mapa: dict = {}
    for i in range(0, len(ids), 40):
        rows = db.table("produtos").select("id, codigo, descricao")\
            .in_("id", ids[i:i + 40]).execute().data
        for r in rows:
            mapa[r["id"]] = {"codigo": (r.get("codigo") or "").strip().upper(),
                             "descricao": r.get("descricao")}
    return mapa


def analisar(itens: list, sincronizar: bool = False) -> dict:
    """Cruza os itens pedidos com o estoque e devolve o que dá para atender.

    `itens`: [{produto_id?, codigo?, descricao?, qtd, valor_unitario?, ref?}]

    `ref` é devolvido intacto em cada item da resposta. Quem chama usa isso para
    reencontrar a linha de origem — itens com qtd zero são descartados aqui, então
    a posição na lista de saída NÃO corresponde à de entrada.

    Passe `sincronizar=True` quando o resultado vai VINCULAR uma decisão (o
    ganho da venda) — vale o round trip no PCP para não decidir com a foto de
    ontem. Para exibição que só informa, deixe False e a tela abre na hora.
    """
    db = get_service_db()
    pedidos = [i for i in (itens or []) if float(i.get("qtd") or 0) > 0]

    hoje = _hoje_brt()
    previsao_sa = _mais_dias_uteis(hoje, DIAS_UTEIS_SA).isoformat()
    vazio = {"itens": [], "tem_falta": False, "tudo_disponivel": True,
             "valor_pendente": 0.0, "qtd_pendente_total": 0.0,
             "cobre_com_sa": True, "previsao_sa": previsao_sa,
             "data_ref": None, "desatualizado": False, "sem_dado": []}
    if not pedidos:
        return vazio

    faltando_codigo = [i.get("produto_id") for i in pedidos if not i.get("codigo")]
    por_pid = _codigo_por_produto_id(db, faltando_codigo)

    estoque = estoque_service.listar(sincronizar_se_preciso=sincronizar)
    por_codigo = {(r.get("codigo") or "").strip().upper(): r for r in (estoque.get("itens") or [])}

    # Rateio sequencial: dois itens da mesma oportunidade podem pedir o MESMO
    # código (tamanhos diferentes cadastrados juntos, ou item repetido). Sem
    # descontar o que já foi prometido ao item anterior, o app prometeria a
    # mesma unidade duas vezes e a falta reapareceria na expedição.
    ja_alocado: dict = {}

    saida = []
    valor_pendente = 0.0
    qtd_pendente_total = 0.0
    cobre_com_sa = True
    sem_dado = []

    for it in pedidos:
        qtd = float(it.get("qtd") or 0)
        vu = float(it.get("valor_unitario") or 0)
        cod = (it.get("codigo") or "").strip().upper()
        desc = it.get("descricao")
        if not cod and it.get("produto_id"):
            info = por_pid.get(it["produto_id"]) or {}
            cod = info.get("codigo") or ""
            desc = desc or info.get("descricao")

        row = por_codigo.get(cod)
        if row is None:
            # Código que o PCP não acompanha (ou item ainda sem cadastro). Não
            # dá para afirmar que falta — afirmar isso travaria a venda por uma
            # lacuna de dado nossa. Marca como sem informação e segue.
            sem_dado.append(cod or (desc or "item sem código"))
            saida.append({
                "ref": it.get("ref"),
                "produto_id": it.get("produto_id"), "codigo": cod or None,
                "descricao": desc, "qtd_pedida": qtd,
                "disponivel": None, "estoque_sa": None,
                "qtd_atendida": qtd, "qtd_pendente": 0.0,
                "valor_unitario": vu, "valor_pendente": 0.0,
                "sem_dado": True, "cobre_com_sa": None, "status": "SEM_DADO",
            })
            continue

        disponivel = float(row.get("disponivel") or 0)
        sa = float(row.get("estoque_sa") or 0)
        # Quanto deste código já foi prometido a itens ANTERIORES desta análise.
        # Sem devolver isso, quem recebe zero não tem como saber se o estoque
        # está vazio ou se a fila levou tudo — e são coisas muito diferentes.
        reservado_antes = ja_alocado.get(cod, 0.0)
        livre = max(0.0, disponivel - reservado_antes)
        atendida = min(qtd, livre)
        pendente = round(qtd - atendida, 3)
        ja_alocado[cod] = ja_alocado.get(cod, 0.0) + atendida

        # O SA já comprometido com itens anteriores desta mesma análise também
        # não pode ser prometido de novo.
        sa_livre = max(0.0, sa - max(0.0, ja_alocado.get(cod, 0.0) - disponivel))
        item_cobre_sa = pendente <= sa_livre
        if pendente > 0 and not item_cobre_sa:
            cobre_com_sa = False

        vp = round(pendente * vu, 2)
        valor_pendente += vp
        qtd_pendente_total += pendente

        saida.append({
            "ref": it.get("ref"),
            "produto_id": it.get("produto_id"), "codigo": cod, "descricao": desc or row.get("descricao"),
            "qtd_pedida": qtd,
            "disponivel": round(disponivel),
            "estoque_sa": round(sa),
            # O que a fila levou antes deste item. `disponivel - reservado_antes`
            # é o que sobrou para ele.
            "reservado_antes": round(reservado_antes, 3),
            "qtd_atendida": atendida,
            "qtd_pendente": pendente,
            "valor_unitario": vu,
            "valor_pendente": vp,
            "sem_dado": False,
            # Falta agora, mas o semiacabado cobre: dá para prometer o prazo do
            # SA em vez de mandar o cliente esperar sem data.
            "cobre_com_sa": bool(pendente > 0 and item_cobre_sa),
            "status": "OK" if pendente <= 0 else ("SA" if item_cobre_sa else "FALTA"),
        })

    tem_falta = qtd_pendente_total > 0
    return {
        "itens": saida,
        "tem_falta": tem_falta,
        "tudo_disponivel": not tem_falta,
        "valor_pendente": round(valor_pendente, 2),
        "qtd_pendente_total": round(qtd_pendente_total, 3),
        "cobre_com_sa": bool(tem_falta and cobre_com_sa),
        "previsao_sa": previsao_sa,
        "data_ref": estoque.get("data_ref"),
        # A foto do PCP é de hoje ou é de ontem? Quem decide precisa saber.
        "desatualizado": bool(estoque.get("desatualizado")),
        "sem_dado": sem_dado,
    }


def analisar_oportunidade(oportunidade_id: str, sincronizar: bool = False) -> dict:
    """A mesma análise, montada a partir dos itens já gravados na oportunidade."""
    db = get_service_db()
    itens = db.table("crm_oportunidade_itens").select("*")\
        .eq("oportunidade_id", oportunidade_id).order("id").execute().data
    return analisar(entrada_de_itens_crm(itens), sincronizar=sincronizar)


def entrada_de_itens_crm(itens_rows: list) -> list:
    """Linhas de `crm_oportunidade_itens` no formato de `analisar`, carimbando o
    índice em `ref` para quem chama reencontrar a linha depois."""
    return [{
        "ref": idx,
        "produto_id": i.get("produto_id"),
        "codigo": i.get("codigo"),
        "descricao": i.get("descricao"),
        "qtd": float(i.get("qtd") or 0),
        "valor_unitario": float(i.get("valor_unitario") or 0),
    } for idx, i in enumerate(itens_rows)]


def itens_pendentes(analise: dict) -> list:
    """Só o saldo — o que vira pendência e, depois, a 2ª remessa."""
    return [i for i in (analise.get("itens") or []) if float(i.get("qtd_pendente") or 0) > 0]


def itens_atendidos(analise: dict) -> list:
    """Só o que dá para entregar agora — é isto que vai para a expedição."""
    return [i for i in (analise.get("itens") or []) if float(i.get("qtd_atendida") or 0) > 0]


def previsao_pcp_do_item(codigo: str) -> Optional[str]:
    """Data em que o PCP prevê ter o item, quando alguém já informou. Hoje o app
    não recebe plano de produção do PCP; a data vem preenchida à mão na
    pendência. Existe como função para o dia em que a integração trouxer o plano
    e só este ponto precisar mudar."""
    return None

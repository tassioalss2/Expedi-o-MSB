# -*- coding: utf-8 -*-
"""O frete que a BRIX vai cobrar nesta carga, pela tabela contratada.

Tabela convencional de outubro/2026, origem Lauro de Freitas/BA. A conta é a
mesma para todo destino:

    peso taxado  = maior entre o peso real e o peso cubado (m³ × fator)
    frete-peso   = maior(peso taxado, peso mínimo do destino) × tarifa por kg
    coleta       = R$ 22,00 até 10 kg + R$ 0,49 por kg acima
    entrega      = R$ 49,50 (capital), R$ 71,50 (grande capital) ou R$ 165,00
                   (interior/redespacho; R$ 209,00 no Norte), + excedente por kg
    ad valorem   = 0,333% do valor da NF
    GRIS         = 0,05% do valor da NF (0,02% em São Paulo)

O "peso mínimo" da tabela é a tarifa mínima dividida pela tarifa por kg — por
isso a fórmula acima já devolve R$ 110,88 em qualquer carga leve, sem precisar
de um caso especial.

O que esta conta NÃO cobre, e por isso o resultado é ESTIMATIVA: pedágio, ICMS,
hora parada, taxa de emergência, veículo dedicado (R$ 2,20/km) e qualquer acordo
fora da tabela. Cubagem fora do
padrão continua sendo cotada com eles antes do faturamento.
"""
import json
import math
import unicodedata
from datetime import date
from pathlib import Path
from typing import Optional

_TABELA: list = [None]


def _sem_acento(t: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", str(t or ""))
                   if not unicodedata.combining(c)).strip().upper()


def tabela() -> dict:
    if _TABELA[0] is None:
        try:
            caminho = Path(__file__).resolve().parent.parent / "data" / "tabela_frete_brix.json"
            _TABELA[0] = json.loads(caminho.read_text(encoding="utf-8"))
        except Exception as exc:
            print("tabela de frete indisponivel: %s" % str(exc)[:140])
            _TABELA[0] = {"destinos": []}
    return _TABELA[0]


def _achar_destino(cidade: Optional[str], uf: Optional[str]) -> tuple:
    """(destino, como_achou). Cidade exata primeiro; depois a capital da UF.

    Quando a cidade não está na tabela, a carga vai por REDESPACHO: a BRIX leva
    até a capital e outra transportadora faz o trecho final, que é cobrado à
    parte. Devolver a linha da capital serve de piso — e o chamador precisa
    dizer que falta o trecho, senão a estimativa vira promessa.
    """
    t = tabela()
    alvo_cidade, alvo_uf = _sem_acento(cidade), _sem_acento(uf)
    if alvo_cidade:
        for d in t.get("destinos", []):
            if _sem_acento(d["cidade"]) == alvo_cidade and (
                    not alvo_uf or d["uf"] == alvo_uf):
                return d, "cidade"
    if alvo_uf:
        for d in t.get("destinos", []):
            if d["uf"] == alvo_uf:
                return d, "capital_da_uf"
    return None, "nao_encontrado"


_RE_NUM = __import__("re").compile(r"\d+(?:[.,]\d+)?")


def volume_m3(descricao: Optional[str]) -> float:
    """m³ de uma caixa, lido da descrição do tipo cadastrado.

    O cadastro guarda a medida no texto, em dois formatos que convivem:
    "(C 1,19 x L 0,17 x A 0,11)" em metros e "(57,0 x 26,5 x 34,5)" em
    centímetros. A unidade se descobre pela ordem de grandeza — caixa de 3
    metros não existe aqui, e 0,05 m é uma caixa de 5 cm.

    Sem três números no texto (o "Envelope P/ Amostras" é assim), devolve 0:
    volume desconhecido não vira volume zero por engano, vira ausência — quem
    chama decide o que fazer.
    """
    t = descricao or ""
    if "(" in t and ")" in t:
        t = t[t.index("(") + 1:t.rindex(")")]
    nums = [float(n.replace(",", ".")) for n in _RE_NUM.findall(t)]
    if len(nums) < 3:
        return 0.0
    c, l, a = nums[:3]
    if max(c, l, a) > 3:          # centímetros
        c, l, a = c / 100, l / 100, a / 100
    return round(c * l * a, 5)


def somar_dias_uteis(inicio, dias: int):
    """A data que cai N dias úteis DEPOIS da coleta.

    O prazo conta da coleta, mas o dia da coleta não é o primeiro dia de
    viagem: a carga sai e o relógio começa no dia seguinte (confirmado pelo
    Tássio em 22/10/2026). Coletada numa quinta, com 3 dias úteis, chega na
    terça — sexta, segunda, terça.

    Feriado também não conta: a conta sai do calendário da MSB, que conhece os
    nacionais, os da Bahia e os de Lauro de Freitas.
    """
    from app.services import calendario
    return calendario.somar_dias_uteis(inicio, dias)


def prazo_de_entrega(uf: Optional[str], cidade: Optional[str], saida=None) -> dict:
    """Quando a carga chega, pelo prazo contratado do destino."""
    from datetime import date as _date
    saida = saida or _date.today()
    destino, como = _achar_destino(cidade, uf)
    if not destino:
        return {"encontrado": False,
                "motivo": "Destino fora da tabela — prazo a combinar com a transportadora."}
    # Cidade do interior entrega por redespacho, e o prazo que vale é o dele.
    dias = (destino.get("prazo_redespacho") if como == "capital_da_uf"
            else destino.get("prazo_capital")) or 0
    return {
        "encontrado": True,
        "transportadora": tabela().get("transportadora"),
        "destino": "%s/%s" % (destino["cidade"], destino["uf"]),
        "por_capital": como == "capital_da_uf",
        "dias_uteis": dias,
        "saida": saida.isoformat(),
        "data_prevista": somar_dias_uteis(saida, dias).isoformat(),
    }


def _taxa_por_faixa(faixa: dict, peso: float) -> float:
    """Taxa de coleta/entrega: um fixo até 10 kg e um por kg acima disso."""
    if not faixa:
        return 0.0
    base = float(faixa.get("ate_10kg") or 0)
    excedente = max(float(peso or 0) - 10.0, 0.0) * float(faixa.get("excedente_kg") or 0)
    return base + excedente


def _tipo_de_entrega(destino: dict, como: str, cidade: Optional[str] = None) -> str:
    """CAPITAL quando a cidade é ponto atendido; fora da tabela vai por redespacho.

    A tabela tem três faixas de entrega — capital, grande capital (região
    metropolitana) e interior. A tabela não diz quem é "grande capital", então
    a lista fica em grande_capital no JSON, para ser preenchida à medida que a
    BRIX confirmar. Sem a cidade nessa lista, o destino fora da tabela entra
    como interior, que é o cenário caro: superestimar avisa, subestimar engana —
    e o aviso diz quanto cai se for grande capital.
    """
    if como == "cidade":
        return "CAPITAL"
    uf = (destino or {}).get("uf")
    metro = [_sem_acento(c) for c in (tabela().get("grande_capital") or {}).get(uf, [])]
    if cidade and _sem_acento(cidade) in metro:
        return "GRANDE_CAPITAL"
    if uf in (tabela().get("ufs_norte") or []):
        return "INTERIOR_NORTE"
    return "INTERIOR_REDESPACHO"


def _restricoes(uf: str, valor_nf: float, peso_taxado: float, como: str) -> list:
    """Regras de PGR da tabela que travam o embarque antes de ele sair."""
    t, alertas = tabela(), []
    r = t.get("restricoes") or {}
    redesp = r.get("redespacho_ba_mg") or {}
    if (como == "capital_da_uf" and uf in (redesp.get("ufs") or [])
            and (float(valor_nf or 0) > float(redesp.get("valor_nf_max") or 0)
                 or float(peso_taxado or 0) > float(redesp.get("peso_max_kg") or 0))):
        alertas.append(redesp.get("texto"))
    rj = r.get("rio_de_janeiro") or {}
    if uf in (rj.get("ufs") or []) and float(valor_nf or 0) > float(rj.get("dedicada_acima") or 0):
        alertas.append(rj.get("texto"))
    pgr = r.get("pgr_carga_geral") or {}
    if float(valor_nf or 0) > float(pgr.get("valor_nf_max") or 0):
        alertas.append(pgr.get("texto"))
    cap = r.get("capacidade_veiculo") or {}
    if float(peso_taxado or 0) > float(cap.get("peso_max_kg") or 0):
        alertas.append(cap.get("texto"))
    return [a for a in alertas if a]


def estimar(uf: Optional[str], cidade: Optional[str] = None,
            peso_kg: float = 0, m3: float = 0, valor_nf: float = 0) -> dict:
    """Quanto esta carga custa pela tabela, com a conta aberta."""
    t = tabela()
    destino, como = _achar_destino(cidade, uf)
    fator = float(t.get("fator_cubagem_kg_m3") or 300)
    peso_cubado = round(float(m3 or 0) * fator, 2)
    peso_taxado = max(float(peso_kg or 0), peso_cubado)

    if not destino:
        return {
            "encontrado": False,
            "motivo": "Destino fora da tabela da BRIX — precisa de cotação.",
            "peso_real_kg": round(float(peso_kg or 0), 2),
            "peso_cubado_kg": peso_cubado,
            "peso_taxado_kg": round(peso_taxado, 2),
        }

    peso_cobrado = max(peso_taxado, float(destino["peso_minimo_kg"]))
    # A tarifa mínima é um valor declarado (R$ 110,88), não o produto do peso
    # mínimo pela tarifa: em Brasília, 36,35 × 3,05 dá 110,8675 e a carga leve
    # saía um centavo abaixo do que a transportadora cobra. Quem manda é o
    # maior dos dois.
    frete_peso = max(peso_cobrado * float(destino["tarifa_kg"]),
                     float(t.get("tarifa_minima") or 0))

    # Coleta e entrega são cobradas por envio, em cima do peso taxado — não do
    # peso mínimo, que é artifício da tarifa aérea.
    tipo_entrega = _tipo_de_entrega(destino, como, cidade)
    taxa_coleta = _taxa_por_faixa(t.get("taxa_coleta"), peso_taxado)
    taxa_entrega = _taxa_por_faixa((t.get("taxas_entrega") or {}).get(tipo_entrega), peso_taxado)

    ad_valorem = float(valor_nf or 0) * float(t.get("ad_valorem_pct") or 0) / 100
    gris_pct = float(destino.get("gris_pct", t.get("gris_pct_padrao") or 0))
    gris = float(valor_nf or 0) * gris_pct / 100
    total = frete_peso + taxa_coleta + taxa_entrega + ad_valorem + gris

    avisos = []
    if como == "capital_da_uf":
        alternativa = _taxa_por_faixa((t.get("taxas_entrega") or {}).get("GRANDE_CAPITAL"),
                                      peso_taxado)
        avisos.append(
            "Cidade fora da tabela: frete-peso calculado pela capital %s/%s e entrega "
            "cobrada como interior/redespacho (R$ %.2f). Se a BRIX tratar o destino como "
            "grande capital, a taxa de entrega cai para R$ %.2f."
            % (destino["cidade"], destino["uf"], taxa_entrega, alternativa))
    avisos += _restricoes(destino["uf"], valor_nf, peso_taxado, como)

    return {
        "encontrado": True,
        "transportadora": t.get("transportadora"),
        "vigencia": t.get("vigencia"),
        "destino": "%s/%s" % (destino["cidade"], destino["uf"]),
        "por_capital": como == "capital_da_uf",
        # Redespacho e PGR têm consequência em dinheiro e em veículo: dizer isso
        # é o que separa estimativa de promessa.
        "aviso": " ".join(avisos) if avisos else None,
        "avisos": avisos,
        "peso_real_kg": round(float(peso_kg or 0), 2),
        "peso_cubado_kg": peso_cubado,
        "peso_taxado_kg": round(peso_taxado, 2),
        "peso_cobrado_kg": round(peso_cobrado, 2),
        "usou_peso_minimo": peso_cobrado > peso_taxado + 0.001,
        "fator_cubagem": fator,
        "tarifa_kg": float(destino["tarifa_kg"]),
        "frete_peso": round(frete_peso, 2),
        "tipo_entrega": tipo_entrega,
        "taxa_coleta": round(taxa_coleta, 2),
        "taxa_entrega": round(taxa_entrega, 2),
        "ad_valorem": round(ad_valorem, 2),
        "ad_valorem_pct": float(t.get("ad_valorem_pct") or 0),
        "gris": round(gris, 2),
        "gris_pct": gris_pct,
        "total": round(total, 2),
        "prazo_capital": destino.get("prazo_capital"),
        "prazo_redespacho": destino.get("prazo_redespacho"),
        "premissa_cubagem": t.get("observacao_fator"),
        # O resto da tabela não entra na conta, mas decide dinheiro depois do
        # embarque: emergência, hora parada, reentrega, devolução e o ICMS que
        # vem por fora. Viajam junto com a estimativa para o app poder mostrar.
        "referencias": {
            "taxa_emergencia": t.get("taxa_emergencia"),
            "hora_parada": t.get("hora_parada"),
            "reentrega_pct": t.get("reentrega_pct"),
            "devolucao_pct": t.get("devolucao_pct"),
            "coleta_improdutiva_pct": t.get("coleta_improdutiva_pct"),
            "interior_dedicado_km": t.get("interior_dedicado_km"),
            "pagamento": t.get("pagamento"),
            "nao_incluido": t.get("nao_incluido"),
        },
    }


# ---------------------------------------------------------------------------
# Proximo Voo: a entrega expressa da BRIX, usada quando o prazo convencional
# nao atende. E outra tabela, nao um acrescimo na convencional — a conta muda
# inteira: o frete-peso vira R$ 308,00 + R$ 44,00 por quilo (escada de meio em
# meio quilo, ate 30 kg), e coleta e entrega tambem sao mais caras.
# ---------------------------------------------------------------------------

_TABELA_VOO: list = [None]


def tabela_proximo_voo() -> dict:
    if _TABELA_VOO[0] is None:
        try:
            caminho = (Path(__file__).resolve().parent.parent / "data"
                       / "tabela_frete_brix_proximo_voo.json")
            _TABELA_VOO[0] = json.loads(caminho.read_text(encoding="utf-8"))
        except Exception as exc:
            print("tabela proximo voo indisponivel: %s" % str(exc)[:140])
            _TABELA_VOO[0] = {"destinos": []}
    return _TABELA_VOO[0]


def _destino_voo(cidade: Optional[str], uf: Optional[str]) -> tuple:
    """Mesma logica da convencional: cidade exata e, se nao achar, capital da UF."""
    t = tabela_proximo_voo()
    alvo = _sem_acento(cidade)
    if alvo:
        for d in t.get("destinos", []):
            if _sem_acento(d["cidade"]) == alvo:
                return d, "cidade"
    if uf:
        for d in t.get("destinos", []):
            if _sem_acento(d["uf"]) == _sem_acento(uf):
                return d, "capital_da_uf"
    return None, None


def estimar_proximo_voo(uf: Optional[str], cidade: Optional[str] = None,
                        peso_kg: float = 0, m3: float = 0,
                        valor_nf: float = 0) -> dict:
    """Quanto a mesma carga custa indo no proximo voo."""
    t = tabela_proximo_voo()
    destino, como = _destino_voo(cidade, uf)
    fator = float(t.get("fator_cubagem_kg_m3") or 166.67)
    peso_cubado = round(float(m3 or 0) * fator, 2)
    peso_taxado = max(float(peso_kg or 0), peso_cubado)

    if not destino:
        return {"encontrado": False,
                "motivo": "Destino fora da tabela de Proximo Voo — precisa de cotacao.",
                "peso_taxado_kg": round(peso_taxado, 2)}

    regra = t.get("frete_peso") or {}
    passo = float(regra.get("passo_kg") or 0.5)
    teto = float(regra.get("peso_maximo_kg") or 30)
    # A tabela e uma escada: quem pesa 2,1 kg paga a faixa de 2,5 kg.
    faixas = math.ceil(max(peso_taxado, passo) / passo)
    peso_cobrado = round(faixas * passo, 2)
    frete_peso = float(regra.get("base") or 0) + float(regra.get("por_kg") or 0) * peso_cobrado

    tipo_entrega = "CAPITAL" if como == "cidade" else "GRANDE_CAPITAL"
    taxa_coleta = _taxa_por_faixa(t.get("taxa_coleta"), peso_taxado)
    taxa_entrega = _taxa_por_faixa((t.get("taxas_entrega") or {}).get(tipo_entrega), peso_taxado)
    ad_valorem = float(valor_nf or 0) * float(t.get("ad_valorem_pct") or 0) / 100
    total = frete_peso + taxa_coleta + taxa_entrega + ad_valorem

    avisos = []
    if peso_cobrado > teto:
        avisos.append("Carga de %.1f kg passa do teto de %.0f kg da tabela expressa: "
                      "o valor acima e extrapolacao e precisa de cotacao."
                      % (peso_cobrado, teto))
    if como == "capital_da_uf":
        avisos.append(
            "%s nao esta na tabela expressa, que so cobre capitais. O valor acima usa %s/%s "
            "como referencia, mas no Proximo Voo o interior e atendido por VEICULO DEDICADO "
            "(R$ %.2f por km rodado, ida e volta): este numero nao e cotacao, e ordem de grandeza."
            % ((cidade or "A cidade").strip().title(), destino["cidade"], destino["uf"],
               float(t.get("interior_dedicado_km") or 0)))
    if float(valor_nf or 0) > 199999.99:
        avisos.append("Nota acima de R$ 199.999,99: carga geral precisa de consulta previa a BRIX.")
    if _sem_acento(destino["uf"]) == "RJ" and float(valor_nf or 0) > 150000:
        avisos.append("Rio de Janeiro acima de R$ 150 mil so com entrega dedicada "
                      "(acima de R$ 200 mil, escolta e carro dedicado).")
    if not float(t.get("gris_pct_padrao") or 0):
        avisos.append("A tabela expressa nao menciona GRIS — confirmar com a BRIX antes de fechar preco.")

    return {
        "encontrado": True,
        "transportadora": t.get("transportadora"),
        "tabela": t.get("tabela"),
        "vigencia": t.get("vigencia"),
        "destino": "%s/%s" % (destino["cidade"], destino["uf"]),
        "por_capital": como == "capital_da_uf",
        "peso_real_kg": round(float(peso_kg or 0), 2),
        "peso_cubado_kg": peso_cubado,
        "peso_taxado_kg": round(peso_taxado, 2),
        "peso_cobrado_kg": peso_cobrado,
        "fator_cubagem": fator,
        "tarifa_kg": float(regra.get("por_kg") or 0),
        "frete_peso": round(frete_peso, 2),
        "tipo_entrega": tipo_entrega,
        "taxa_coleta": round(taxa_coleta, 2),
        "taxa_entrega": round(taxa_entrega, 2),
        "ad_valorem": round(ad_valorem, 2),
        "ad_valorem_pct": float(t.get("ad_valorem_pct") or 0),
        "gris": 0.0,
        "gris_pct": 0.0,
        "total": round(total, 2),
        "prazo": destino.get("prazo"),
        # A tela le prazo_capital; o expresso tem um prazo so.
        "prazo_capital": destino.get("prazo"),
        "premissa_cubagem": t.get("observacao_fator"),
        "aviso": " ".join(avisos) if avisos else None,
        "avisos": avisos,
        "referencias": {
            "taxa_emergencia_capitais": t.get("taxa_emergencia_capitais"),
            "taxa_produto_perigoso": t.get("taxa_produto_perigoso"),
            "hora_parada": t.get("hora_parada"),
            "reentrega_pct": t.get("reentrega_pct"),
            "devolucao_pct": t.get("devolucao_pct"),
            "coleta_improdutiva_pct": t.get("coleta_improdutiva_pct"),
            "interior_dedicado_km": t.get("interior_dedicado_km"),
            "capacidade_veiculo_kg": t.get("capacidade_veiculo_kg"),
            "pagamento": t.get("pagamento"),
            "nao_incluido": t.get("nao_incluido"),
        },
    }


def comparar_modalidades(uf: Optional[str], cidade: Optional[str] = None,
                         peso_kg: float = 0, m3: float = 0,
                         valor_nf: float = 0) -> dict:
    """As duas tabelas lado a lado: o que custa a mais e quantos dias isso compra.

    Quem decide pagar expresso precisa ver as duas contas juntas. Separadas,
    a decisao vira "quanto custa" sem o "para ganhar o que".
    """
    conv = estimar(uf, cidade, peso_kg, m3, valor_nf)
    voo = estimar_proximo_voo(uf, cidade, peso_kg, m3, valor_nf)

    diferenca = dias = None
    if conv.get("encontrado") and voo.get("encontrado"):
        diferenca = round(float(voo["total"]) - float(conv["total"]), 2)
        prazo_conv = conv.get("prazo_capital")
        if prazo_conv and voo.get("prazo"):
            dias = int(prazo_conv) - int(voo["prazo"])

    return {
        "convencional": conv,
        "proximo_voo": voo,
        "diferenca": diferenca,
        "dias_ganhos": dias,
        "custo_por_dia_ganho": (round(diferenca / dias, 2)
                                if diferenca is not None and dias else None),
    }


def escolher_modalidade(uf: Optional[str], cidade: Optional[str] = None,
                        peso_kg: float = 0, m3: float = 0, valor_nf: float = 0,
                        data_entrega=None, saida=None) -> dict:
    """Qual modalidade atende a data combinada com o cliente.

    O padrao e sempre CONVENCIONAL: expresso custa de tres a quatro vezes mais
    e so se justifica quando o prazo contratado nao alcanca a data. A conta e
    de data, nao de preco — por isso ela mora aqui, e nao na tela.

    Sem data de entrega, devolve convencional sem sequer cotar o expresso.
    """
    from app.services import calendario

    base = saida or date.today()
    if isinstance(base, str):
        base = date.fromisoformat(base)
    alvo = data_entrega
    if isinstance(alvo, str):
        alvo = date.fromisoformat(alvo) if alvo else None

    conv = estimar(uf, cidade, peso_kg, m3, valor_nf)
    prazo_conv = (conv.get("prazo_redespacho") if conv.get("por_capital")
                  else conv.get("prazo_capital"))
    chegada_conv = (calendario.somar_dias_uteis(base, int(prazo_conv))
                    if conv.get("encontrado") and prazo_conv else None)

    resultado = {
        "data_entrega_alvo": alvo.isoformat() if alvo else None,
        "saida": base.isoformat(),
        "chegada_convencional": chegada_conv.isoformat() if chegada_conv else None,
        "prazo_convencional": prazo_conv,
    }

    if not alvo or not conv.get("encontrado"):
        resultado.update({"modalidade": "CONVENCIONAL", "estimativa": conv,
                          "alternativa": None,
                          "motivo": "Sem data de entrega definida: vale o convencional, que e o padrao."
                                    if not alvo else conv.get("motivo")})
        return resultado

    if chegada_conv and chegada_conv <= alvo:
        folga = calendario.dias_uteis_entre(chegada_conv, alvo)
        resultado.update({
            "modalidade": "CONVENCIONAL",
            "estimativa": conv,
            "alternativa": None,
            "motivo": ("O convencional chega em %s, dentro da data combinada (%s)%s."
                       % (chegada_conv.strftime("%d/%m"), alvo.strftime("%d/%m"),
                          " com %d dia(s) util(eis) de folga" % folga if folga else "")),
        })
        return resultado

    voo = estimar_proximo_voo(uf, cidade, peso_kg, m3, valor_nf)
    chegada_voo = (calendario.somar_dias_uteis(base, int(voo["prazo"]))
                   if voo.get("encontrado") and voo.get("prazo") else None)
    resultado["chegada_expresso"] = chegada_voo.isoformat() if chegada_voo else None
    resultado["prazo_expresso"] = voo.get("prazo")
    if conv.get("encontrado") and voo.get("encontrado"):
        resultado["diferenca"] = round(float(voo["total"]) - float(conv["total"]), 2)

    atraso = calendario.dias_uteis_entre(alvo, chegada_conv) if chegada_conv else None
    motivo = ("O convencional chegaria em %s, %s dia(s) util(eis) depois da data combinada (%s)."
              % (chegada_conv.strftime("%d/%m"), atraso, alvo.strftime("%d/%m"))
              if chegada_conv else "O convencional nao cobre este destino.")

    if chegada_voo and chegada_voo <= alvo:
        resultado.update({
            "modalidade": "EXPRESSO",
            "estimativa": voo,
            "alternativa": conv,
            "motivo": motivo + " O Proximo Voo chega em %s." % chegada_voo.strftime("%d/%m"),
        })
        return resultado

    resultado.update({
        "modalidade": "EXPRESSO",
        "estimativa": voo,
        "alternativa": conv,
        "nem_expresso_alcanca": True,
        "motivo": motivo + (" Nem o Proximo Voo alcanca: chegaria em %s."
                            % chegada_voo.strftime("%d/%m") if chegada_voo
                            else " O destino nao esta na tabela expressa."),
    })
    return resultado

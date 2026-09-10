# -*- coding: utf-8 -*-
"""O que o órgão exige que conste na nota fiscal, lido do e-mail dele.

Por que isto existe: a nota emitida sem o que o órgão pediu volta. Está no
próprio corpus — "Solicitacao de Cancelamento e Correcao da NF nº 000.020.570",
"Carta de correcao - NF 20208" (descrição divergente da ata do pregão) — e está
na fala da Emanoela num dos e-mails lidos: "no e-mail abaixo nao tem os dados
que precisamos colocar na NF". Cada retorno desses é um faturamento que atrasa
um mês.

Hoje essa exigência mora no meio de um e-mail de 60 linhas, diferente em cada
órgão, e quem fatura tem de reler tudo. Aqui ela vira lista.

COMO LÊ. Duas coisas, e a diferença entre elas importa:

  · o PADRÃO, que o Tássio definiu em 10/09/2026: NE e pregão na venda direta e
    na consignação, AF no comunicado de uso. Vale mesmo que o e-mail não peça —
    é o que sempre vai na nota. Quem resolve isso é `exigencias_do_caso`.

  · o que ESTE e-mail pede além disso, que é o que esta análise extrai.

Ancorada na menção à nota fiscal: só procura exigência dentro de uma janela em
volta de "nota fiscal" / "faturamento" / "faturar". Sem essa âncora, "número do
pregão" casaria com o assunto de qualquer e-mail e a lista viraria ruído — e uma
lista de exigências em que não se confia é pior que nenhuma, porque quem fatura
volta a reler o e-mail inteiro e passa a ignorar a tela.

Nunca inventa valor: o que a regra devolve é o RÓTULO da exigência e o TRECHO
onde o órgão pediu. O valor só aparece quando o próprio texto o traz (o e-mail
para onde mandar a nota, o CNPJ de faturamento) ou quando o caso já o conhece
(a NE, o pregão). Exigência detectada sem valor aparece com o trecho — o trecho
é a instrução, e é ele que a pessoa precisa ler.
"""
import re
import unicodedata
from typing import Optional

# Onde uma exigência pode estar: perto de onde o órgão fala da nota. A janela é
# assimétrica de propósito — o pedido vem DEPOIS ("a nota fiscal deverá conter
# as seguintes informações: ..."), às vezes em bullets nas linhas seguintes.
_ANCORA = re.compile(r"nota\s+fiscal|notas\s+fiscais|\bnf[\s.:e]|faturamento|faturar", re.I)
_ANTES, _DEPOIS = 90, 420

# As exigências, na ordem em que fazem sentido para quem emite. O gatilho já foi
# medido contra os 273 e-mails da janela — cada um veio de um pedido real, e não
# de exigência que eu imaginei que existisse.
_REGRAS: list[tuple] = [
    ("NE", "Número da nota de empenho",
     r"(?:constar|informar|inserir|conter|n\.?o?\.?|numero|n[uú]mero)"
     r"[^.;:\n]{0,40}(?:nota\s+de\s+empenho|empenho)"),
    ("PREGAO", "Número do pregão / dispensa",
     r"(?:numero|n\.?o?\.?)\s*d[oe]\s*(?:pregao|preg[aã]o|dispensa)"
     r"|numero\s+d[ae]\s+(?:ata|arp)|pregao\s+ou\s+dispensa"),
    ("AF", "Número da AF / OF / OC",
     r"(?:numero|n\.?o?\.?|n\b)\s*d[ae]?\s*(?:af|of|oc)\b"
     r"|(?:numero|n\.?o?\.?)\s*d[ae]\s*(?:autorizacao|ordem)\s+de\s+fornecimento"
     r"|numero\s+do\s+pedido|com\s+n\s*d[ao]\s+af"),
    ("PROCESSO", "Número do processo",
     r"(?:numero|n\.?o?\.?)\s*d[oe]\s*processo|processo\s*\(rodape\)"),
    ("BANCO", "Dados bancários da empresa",
     r"dados\s+bancarios|conta\s+bancaria|dados\s+da\s+conta"),
    ("TUSS_ANVISA", "Código TUSS e registro ANVISA dos materiais",
     r"\btuss\b|\banvisa\b"),
    ("LOTE", "Lote e validade dos produtos",
     r"lote\s+e\s+validade|validade\s+dos\s+produtos"),
    ("RETENCAO", "Retenção de tributos / IN 1.234",
     r"retencao\s+d[eo]\s+(?:imposto|ir\b|tributo)|1\.?234[/-]?2012"
     r"|enquadramento|imposto\s+de\s+renda"),
    ("DESTINATARIO", "Faturar para a razão social / CNPJ indicados",
     r"faturar\s+em\s+nome|razao\s+social|emitida\s+para\s+o\s+cnpj"
     r"|dados\s+para\s+(?:a\s+)?emissao"),
    ("DESCRICAO", "Descrição do item igual à do empenho / ata",
     r"descri(?:cao|tivo)[^.;:\n]{0,60}(?:conforme|constante|consta|igual|de\s+acordo)"
     r"|conforme[^.;:\n]{0,30}(?:nota\s+de\s+empenho|ata|arp|ordem\s+de\s+compra)"),
    ("CERTIDOES", "Certidões de regularidade junto com a nota",
     r"certid(?:ao|oes)\s+(?:negativa|conjunta|de\s+regularidade)|certificado\s+de\s+regularidade"
     r"|\bfgts\b|\bcndt\b"),
    ("ENVIAR_PARA", "Enviar a nota para",
     r"encaminhad[ao]\s+para\s+o?\s*e-?mail|enviar\s+(?:a\s+)?(?:nf|nota)"
     r"|envio\s+de\s+nota\s+fiscal\s+eletronica|enviada?\s+para\s+o?\s*e-?mail"),
]
_COMPILADAS = [(c, r, re.compile(g, re.I)) for c, r, g in _REGRAS]

# Valores que o próprio texto entrega. Só estes dois: são os que mudam de órgão
# para órgão e que ninguém tem de cabeça.
_EMAIL = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}")
_CNPJ = re.compile(r"\d{2}[.\s]?\d{3}[.\s]?\d{3}[/\s]?\d{4}[-\s]?\d{2}")
# O nosso próprio CNPJ e os nossos e-mails não são destino de nada: aparecem em
# toda assinatura e em todo "faturado contra a MSB".
_NOSSOS_CNPJ = ("07289402", "07.289.402")
_NOSSOS_DOMINIOS = ("msbbrasil.com", "biomedical.com.br")


def _sem_acento(s) -> str:
    return unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode()


def _limpa(s: str) -> str:
    """Uma linha só, sem os pedaços que todo e-mail carrega e ninguém lê."""
    s = re.sub(r"\s+", " ", s)
    s = re.sub(r"<[^>]{0,200}>", " ", s)            # <mailto:...>, <https://...>
    s = re.sub(r"⚠.{0,200}?acione a TI!?", " ", s, flags=re.I)
    return re.sub(r"\s+", " ", s).strip()


def _trecho(janela: str, m: re.Match) -> str:
    """A frase em volta do achado, cortada onde uma frase acaba de verdade."""
    ini, fim = m.start(), m.end()
    esq = max((janela.rfind(c, 0, ini) for c in ".;:*•"), default=-1)
    # O "*" tambem fecha: nos e-mails que listam as exigencias em bullets, cada
    # bullet e uma exigencia, e sem cortar ali o trecho de uma vinha com a
    # seguinte pendurada ("n.o do processo (rodape) * Lote e Validade").
    dir_ = min((p for p in (janela.find(c, fim) for c in ".;•*") if p > 0),
               default=len(janela))
    return janela[esq + 1:dir_].strip(" -*•")[:220].strip()


def exigencias_no_texto(corpo: Optional[str]) -> list[dict]:
    """As exigências que ESTE texto pede, uma vez cada, com o trecho de origem.

    Devolve [{"chave", "rotulo", "valor", "trecho"}]. `valor` só vem preenchido
    quando o texto o entrega (e-mail de destino, CNPJ de faturamento).
    """
    texto = _limpa(_sem_acento(corpo))
    if not texto:
        return []

    # Janelas ancoradas na menção à nota. Sobrepostas de propósito: a exigência
    # às vezes está numa lista logo depois de "a nota deverá conter:".
    janelas = [texto[max(0, a.start() - _ANTES):a.end() + _DEPOIS]
               for a in _ANCORA.finditer(texto)]
    if not janelas:
        return []

    achadas: dict[str, dict] = {}
    for janela in janelas:
        for chave, rotulo, gatilho in _COMPILADAS:
            if chave in achadas:
                continue
            m = gatilho.search(janela)
            if not m:
                continue
            achadas[chave] = {
                "chave": chave, "rotulo": rotulo, "valor": None,
                "trecho": _trecho(janela, m),
            }
            if chave == "ENVIAR_PARA":
                achadas[chave]["valor"] = _destino(janela, m)
            elif chave == "DESTINATARIO":
                achadas[chave]["valor"] = _cnpj_de_faturamento(janela)
            if not achadas[chave]["valor"]:
                achadas[chave].pop("valor")
                achadas[chave]["valor"] = None

    ordem = {c: i for i, (c, _r, _g) in enumerate(_REGRAS)}
    return sorted(achadas.values(), key=lambda x: ordem[x["chave"]])


def _destino(janela: str, m: re.Match) -> Optional[str]:
    """O e-mail para onde a nota vai, quando o texto diz. Nunca o nosso."""
    for e in _EMAIL.finditer(janela[m.start():m.start() + 300]):
        end = e.group(0).lower()
        if not any(d in end for d in _NOSSOS_DOMINIOS):
            return end
    return None


def _cnpj_de_faturamento(janela: str) -> Optional[str]:
    """O CNPJ contra o qual faturar, quando o texto o traz. Nunca o nosso."""
    for c in _CNPJ.finditer(janela):
        bruto = c.group(0)
        if not any(n in bruto.replace(" ", "") for n in _NOSSOS_CNPJ):
            return bruto.strip()
    return None


# A guia do hospital, achatada em texto, traz a AF numa posição previsível: os
# cabeçalhos primeiro ("DESCRIÇÃO CIASC / CÓD. CIASC / CÓD. SUS / AF/OF /
# EMPENHO / QDE."), os valores depois, na mesma ordem. Então o primeiro número
# no formato N/AAAA depois de "AF/OF" é a AF.
#
# Medido em 10/09/2026: acha a AF em 29 dos 68 comunicados de uso que estavam
# sem ela, e o trecho de origem vai junto para conferência.
#
# Lê SÓ a AF, e não o empenho que vem ao lado, de propósito: o empenho dessa
# guia é o guarda-chuva do contrato inteiro (18716/2026 aparece em 20 casos de
# pacientes diferentes). Certo para a AF dele, e caro de errar se alguém o
# copiar para a nota de outro caso.
_CAB_GUIA = re.compile(r"AF\s*/\s*OF", re.I)
_NUM_BARRA = re.compile(r"\b\d{3,6}\s*/\s*20\d{2}\b")


def af_da_guia(corpo: Optional[str]) -> tuple:
    """A AF lida da guia do hospital: (numero, trecho). (None, None) se não há."""
    texto = _limpa(_sem_acento(corpo))
    m = _CAB_GUIA.search(texto)
    if not m:
        return None, None
    achado = _NUM_BARRA.search(texto[m.end():m.end() + 700])
    if not achado:
        return None, None
    return achado.group(0).replace(" ", ""), texto[m.start():m.start() + 200].strip()


# ── dados que o comunicado de uso exige ────────────────────────────────────
# A demanda de comunicado de uso não nasce sem paciente, prontuário e data do
# procedimento — é o que identifica o caso e o que evita processar o mesmo
# procedimento duas vezes. Até 10/09/2026 a tela não pedia nada disso, então o
# botão "gerar demanda" só sabia dar erro nos 70 comunicados abertos.
#
# E não precisava pedir na mão: a guia do hospital traz os três, e o assunto
# repete paciente e data. Ler é melhor que digitar — o que se digita de novo é
# o que se digita errado.
_PACIENTE = re.compile(r"Paciente\s*:?\s*([A-Z][A-Z' ]{4,60}?)\s*(?:Data|RA\b|Medico|Prontuario|Procedimento)", re.I)
_PRONTUARIO = re.compile(r"Prontuario\s*:?\s*(\d{3,12})", re.I)
# "sa.da" e não "saida": o Í de SAÍDA chega corrompido em parte dos assuntos
# ("DATA DA SAADA"), e é do assunto que vem a data em 19 dos comunicados.
_DATA = re.compile(
    r"Data\s*(?:d[ae]\s*)?(?:cirurgia|sa.{0,2}da|procedimento)\s*:?\s*(\d{2}/\d{2}/\d{4})", re.I)
# O assunto do e-mail é a segunda fonte, e nele o nome vem antes do "-".
_PACIENTE_ASSUNTO = re.compile(r"DE NOTA\s*:?\s*([A-Z][A-Z' ]{4,60}?)\s*-\s*DATA", re.I)
_DATA_ASSUNTO = re.compile(r"DATA D[AE] SA.{0,2}DA\s*:?\s*(\d{2}/\d{2}/\d{4})", re.I)


def dados_do_comunicado(assunto: Optional[str], corpo: Optional[str]) -> dict:
    """Paciente, prontuário e data do procedimento, lidos do e-mail.

    Devolve só o que achou — chave ausente é chave não lida, nunca um palpite.
    O corpo (a guia do hospital) vence o assunto, que é resumo.
    """
    achado: dict = {}
    texto = _limpa(_sem_acento(corpo))
    tit = _limpa(_sem_acento(assunto))

    m = _PACIENTE.search(texto) or _PACIENTE_ASSUNTO.search(tit)
    if m:
        nome = re.sub(r"\s+", " ", m.group(1)).strip()
        if len(nome) > 4:
            achado["nome_paciente"] = nome
    m = _PRONTUARIO.search(texto)
    if m:
        achado["prontuario"] = m.group(1)
    m = _DATA.search(texto) or _DATA_ASSUNTO.search(tit)
    if m:
        d, mes, a = m.group(1).split("/")
        achado["data_procedimento"] = "%s-%s-%s" % (a, mes, d)
    return achado


# Exigências que valem SEMPRE, por tipo de operação. Dito pelo Tássio em
# 10/09/2026: "de modo geral é o número da NE e do PE ou da AF". Vão na lista
# mesmo quando o e-mail não pede, porque a nota sem elas volta.
#
# Cada item é um grupo de ALTERNATIVAS, e não uma exigência solta — é o "ou" da
# frase dele. O documento que autoriza o fornecimento é a NE em quase todo
# órgão, mas o HC/UNICAMP consignado trabalha por AF e nunca emite empenho:
# exigir NE ali marcaria 147 casos como "faltando" um número que não existe, e
# uma lista de pendências onde 3 de 4 são falsas é pior que nenhuma lista —
# quem fatura volta a reler o e-mail inteiro.
_SEMPRE = {
    "VENDA_DIRETA": (("NE", "AF"), ("PREGAO",)),
    "CONSIGNACAO": (("NE", "AF"), ("PREGAO",)),
    "COMUNICADO_USO": (("AF", "NE"),),
    "AMOSTRA": (),
    "OUTRO": (),
}
# Como chamar o grupo quando NENHUMA das alternativas tem valor: aí a tela está
# pedindo um número que ninguém leu ainda, e tem de dizer o que serve.
_ROTULO_FALTA = {
    ("NE", "AF"): "Número da nota de empenho (ou da AF)",
    ("AF", "NE"): "Número da AF (ou da nota de empenho)",
    ("PREGAO",): "Número do pregão / dispensa",
}
_ROTULO = {c: r for c, r, _g in _REGRAS}


def exigencias_do_caso(tipo: Optional[str], corpos: list,
                       valores: Optional[dict] = None) -> list[dict]:
    """A lista final do card: o padrão do tipo + o que os e-mails pedem.

    `valores` traz o que o caso já sabe ({"NE": "2026NE002825", "PREGAO":
    "90124/2025", "AF": "8828/2026"}) para a exigência aparecer com o número
    pronto. Exigência do padrão sem valor conhecido continua na lista, com
    `valor` nulo — é assim que a tela pode dizer "falta o número do pregão"
    em vez de deixar quem fatura descobrir depois que a nota voltou.
    """
    # O que o caso sabe vence o que eu leio agora do corpo: o número que veio do
    # anexo ou da chave do grupo já foi conferido por outro caminho.
    valores = {k: v for k, v in (valores or {}).items() if v}
    trechos_do_valor: dict[str, str] = {}
    if not valores.get("AF"):
        for corpo in corpos:
            af, trecho = af_da_guia(corpo)
            if af:
                valores["AF"], trechos_do_valor["AF"] = af, trecho
                break

    achadas: dict[str, dict] = {}
    for corpo in corpos:
        for e in exigencias_no_texto(corpo):
            atual = achadas.get(e["chave"])
            # Entre dois e-mails que pedem o mesmo, fica o que traz valor.
            if not atual or (e.get("valor") and not atual.get("valor")):
                e["origem"] = "EMAIL"
                achadas[e["chave"]] = e

    for grupo in _SEMPRE.get(tipo or "OUTRO", ()):
        # Das alternativas, entra a que o caso realmente tem. Nenhuma tem?
        # Entra uma linha só, dizendo o que serve, e sem valor — é pendência.
        tem = [c for c in grupo if valores.get(c)]
        for chave in (tem or grupo[:1]):
            if chave in achadas:
                achadas[chave]["origem"] = "PADRAO_E_EMAIL"
            else:
                achadas[chave] = {
                    "chave": chave,
                    "rotulo": _ROTULO[chave] if tem else _ROTULO_FALTA.get(
                        tuple(grupo), _ROTULO[chave]),
                    "valor": None, "trecho": None, "origem": "PADRAO"}

    for chave, valor in valores.items():
        if chave in achadas and valor and not achadas[chave].get("valor"):
            achadas[chave]["valor"] = valor
            # Valor que eu li do corpo agora leva o trecho: é a diferença entre
            # "o app sabe" e "o app deduziu, confira aqui".
            if chave in trechos_do_valor and not achadas[chave].get("trecho"):
                achadas[chave]["trecho"] = trechos_do_valor[chave]

    ordem = {c: i for i, (c, _r, _g) in enumerate(_REGRAS)}
    return sorted(achadas.values(), key=lambda x: ordem.get(x["chave"], 99))

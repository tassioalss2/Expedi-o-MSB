# -*- coding: utf-8 -*-
"""Confere a fatura de frete da transportadora contra as nossas OVs.

A transportadora manda a cada 15 dias um zip com os CT-e do período (XML e
DACTE em PDF) e o boleto. A operadora abria DACTE por DACTE, somava à mão e
comparava — procurando CT-e repetido e CT-e que não é da MSB.

Cinco testes, e os dois últimos são os que a conferência manual não consegue
fazer, porque ela não tem o frete previsto da OV do lado:

  1 a soma dos CT-e bate com a soma dos boletos?
  2 algum CT-e repetido? (pela CHAVE, não pelo número)
  3 algum CT-e sem a MSB nas pontas?
  4 o frete cobrado bate com o previsto na OV daquela NF?
  5 saiu NF pela transportadora no período e não tem CT-e?

Medido no período de 16 a 31/08 da RR: 42 CT-e, R$ 25.505,75, soma exata com os
boletos, zero duplicado, zero de terceiro — e mesmo assim 16 cobranças diferentes
do previsto (R$ 1.826,39 a mais) e 7 CT-e de NF que o app não conhece
(R$ 11.277,59, um deles de R$ 8.304,20 com destino Biomedical). A soma fechar
não quer dizer que está certo.

LÊ O XML, NÃO O PDF. O CT-e eletrônico é o documento fiscal; o DACTE é só a
representação impressa dele. O PDF entra apenas para o boleto, e de lá sai só o
que a LINHA DIGITÁVEL garante — ver `_boleto`.
"""
import io
import re
import zipfile
from datetime import date, timedelta
from typing import Optional
from xml.etree import ElementTree as ET

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.schemas import UsuarioOut

NS = {"c": "http://www.portalfiscal.inf.br/cte"}
# O CNPJ da MSB. É por ele que se separa "frete nosso" de "frete de outro
# cliente da transportadora", que é uma das coisas que a operadora procura.
CNPJ_MSB = "06167295000171"
MESES_DE_HISTORICO = 3


def _texto(no, caminho: str) -> Optional[str]:
    achado = no.find(caminho, NS) if no is not None else None
    return (achado.text or "").strip() if achado is not None and achado.text else None


def _le_cte(conteudo: bytes) -> Optional[dict]:
    """Um CT-e a partir do XML. None quando o arquivo não é um CT-e."""
    try:
        inf = ET.fromstring(conteudo).find(".//c:infCte", NS)
    except ET.ParseError:
        return None
    if inf is None:
        return None
    ide, rem, dest = (inf.find("c:ide", NS), inf.find("c:rem", NS),
                      inf.find("c:dest", NS))
    return {
        "numero": _texto(ide, "c:nCT"),
        "chave": (inf.get("Id") or "").replace("CTe", ""),
        "emissao": (_texto(ide, "c:dhEmi") or "")[:10] or None,
        "valor": float(_texto(inf.find("c:vPrest", NS), "c:vTPrest") or 0),
        "remetente": _texto(rem, "c:xNome"),
        "rem_cnpj": _texto(rem, "c:CNPJ"),
        "destinatario": _texto(dest, "c:xNome"),
        "dest_cnpj": _texto(dest, "c:CNPJ"),
        "emitente": _texto(inf.find("c:emit", NS), "c:xNome"),
        "emit_cnpj": _texto(inf.find("c:emit", NS), "c:CNPJ"),
        # A NF-e transportada vem pela chave de 44 dígitos; as posições 25..34
        # são o número da nota. É daí que sai o cruzamento com as nossas OVs.
        "notas": [n.text[25:34].lstrip("0")
                  for n in inf.findall(".//c:infNFe/c:chave", NS) if n.text],
    }


# A linha digitável do boleto: 5 campos, e o último traz fator de vencimento (4
# dígitos) + valor em centavos (10). Ler daqui e não de "Valor do Documento" é
# o que torna a leitura independente do layout do PDF — o texto extraído muda
# conforme a biblioteca, a linha digitável é regra do sistema bancário.
_LINHA_DIGITAVEL = re.compile(
    r"\b\d{3}-?\d\s+\d{5}\.\d{5}\s+\d{5}\.\d{6}\s+\d{5}\.\d{6}\s+\d\s+(\d{14})\b")
# Fator de vencimento: 1000 = 22/02/2025 (o fator reiniciou nessa data).
_BASE_FATOR = date(2025, 2, 22)


def _boleto(conteudo: bytes, nome: str) -> Optional[dict]:
    """Valor e vencimento de um boleto, pela linha digitável."""
    try:
        from pypdf import PdfReader
        leitor = PdfReader(io.BytesIO(conteudo))
        texto = "\n".join((p.extract_text() or "") for p in leitor.pages)
    except Exception:
        return None
    m = _LINHA_DIGITAVEL.search(texto)
    if not m:
        return None
    campo = m.group(1)
    fator, centavos = int(campo[:4]), int(campo[4:])
    return {
        "arquivo": nome,
        "valor": round(centavos / 100.0, 2),
        "vencimento": (_BASE_FATOR + timedelta(days=fator - 1000)).isoformat()
        if fator >= 1000 else None,
    }


def _so_digitos(v) -> str:
    return re.sub(r"\D", "", str(v or "")).lstrip("0")


def _numeros_de_nf(v) -> list:
    """Os numeros de NF de um campo que pode ter mais de um.

    A OV016455 guarda "20540 / 20541" — duas notas no mesmo campo. Limpando os
    nao-digitos de uma vez sai "2054020541", que nao casa com nota nenhuma: foi
    assim que o CT-e 94000 apareceu como "NF nao esta no app" quando a OV existe
    e o frete previsto bate exatamente com o cobrado.
    """
    partes = re.split(r"[^0-9]+", str(v or ""))
    return [x.lstrip("0") for x in partes if x.strip("0")]


# Sufixo societário não identifica ninguém: "RR CARGO - EIRELI - ME" é a mesma
# transportadora que "RR CARGO" e que "Rr" no cadastro.
_SO_SOCIETARIO = {"EIRELI", "ME", "LTDA", "SA", "EPP", "MEI", "TRANSPORTES",
                  "TRANSPORTE", "LOGISTICA", "EXPRESS", "CARGO", "DO", "DE", "DA"}


def _tokens_transportadora(nome: str) -> set:
    palavras = re.findall(r"[A-Z0-9]{2,}", str(nome or "").upper())
    uteis = {p for p in palavras if p not in _SO_SOCIETARIO}
    # Se sobrar vazio (o nome era só genérico), vale o que havia — melhor
    # comparar por palavra fraca do que não comparar.
    return uteis or set(palavras)


def _mesma_transportadora(emitente: str, cadastro: str) -> bool:
    """O emitente do CT-e e a transportadora do pedido são a mesma empresa?"""
    a, b = _tokens_transportadora(emitente), _tokens_transportadora(cadastro)
    return bool(a and b and (a & b))


# ── a cotação, que acontece no WhatsApp ──────────────────────────────────────
# O frete é cotado por WhatsApp com a transportadora: a MSB manda um bloco de
# cubagem que já traz a OV, e ela responde com o valor. Sem isso, "cobrou
# diferente do previsto" acusa cobrança que foi combinada — medido na conversa
# de 19/08 a 15/09: das 32 OVs com CT-e, 11 tinham valor diferente do previsto
# na OV E o valor cobrado estava cotado no chat. Ou seja: a cobrança estava
# certa e o desatualizado era o nosso registro.
_MSG = re.compile(
    r"^\[(\d{1,2})/(\d{1,2})/(\d{2}), ([\d:]+\s*[AP]M)\]\s*([^:]+):\s*(.*)$")
_REAIS = re.compile(r"R\$\s*([\d]{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})")
_OV_NO_TEXTO = re.compile(r"\bOV\s*0*(\d{5,6})\b", re.I)


def ler_conversa(conteudo: bytes, nome: str = "") -> dict:
    """Os valores que a transportadora citou na conversa, com data e contexto.

    Aceita o .txt da exportação do WhatsApp ou o zip que a exportação gera.

    Guarda VALOR e não "a cotação da OV X": a conversa é contínua e entre uma
    cubagem e a próxima passam várias negociações — amarrar cada valor a uma OV
    pela ordem erraria. O cruzamento é feito por valor, que é indício forte e
    honesto, e a tela diz que é indício.
    """
    texto = ""
    if nome.lower().endswith(".zip") or conteudo[:2] == b"PK":
        try:
            z = zipfile.ZipFile(io.BytesIO(conteudo))
            for interno in z.namelist():
                if interno.lower().endswith(".txt"):
                    texto = z.read(interno).decode("utf-8", "replace")
                    break
        except zipfile.BadZipFile:
            texto = ""
    else:
        texto = conteudo.decode("utf-8", "replace")
    if not texto.strip():
        raise HTTPException(422, "não encontrei o texto da conversa — exporte o "
                                 "chat pelo WhatsApp e mande o .txt ou o .zip")

    mensagens = []
    for linha in texto.splitlines():
        m = _MSG.match(linha)
        if m:
            mes, dia, ano, _hora, autor, resto = m.groups()
            mensagens.append({"data": "20%s-%02d-%02d" % (ano, int(mes), int(dia)),
                              "autor": autor.strip(), "texto": resto})
        elif mensagens:
            mensagens[-1]["texto"] += "\n" + linha

    valores, ovs = [], {}
    for m in mensagens:
        for n in _OV_NO_TEXTO.findall(m["texto"]):
            ovs.setdefault("OV0%s" % n, m["data"])
        # Só o que a TRANSPORTADORA disse: valor que nós mesmos escrevemos não é
        # cotação, é o que pedimos ou repetimos.
        if not ("RR" in m["autor"].upper() or "ALEX" in m["autor"].upper()):
            continue
        for v in _REAIS.findall(m["texto"]):
            valores.append({
                "data": m["data"],
                "valor": float(v.replace(".", "").replace(",", ".")),
                "emergencial": "emergenc" in m["texto"].lower(),
                "trecho": " ".join(m["texto"].split())[:120],
            })
    return {"mensagens": len(mensagens), "valores": valores,
            "ovs_citadas": ovs,
            "de": mensagens[0]["data"] if mensagens else None,
            "ate": mensagens[-1]["data"] if mensagens else None}


def ler_pacote(conteudo: bytes) -> dict:
    """Abre o zip e devolve os CT-e e os boletos que encontrou."""
    try:
        z = zipfile.ZipFile(io.BytesIO(conteudo))
    except zipfile.BadZipFile:
        raise HTTPException(422, "o arquivo não é um zip — mande o pacote que a "
                                 "transportadora enviou, sem descompactar")
    ctes, boletos, ignorados = [], [], []
    for nome in z.namelist():
        if nome.endswith("/"):
            continue
        baixo = nome.lower()
        dados = z.read(nome)
        if baixo.endswith(".xml"):
            cte = _le_cte(dados)
            (ctes if cte else ignorados).append(cte or nome)
        elif baixo.endswith(".pdf") and "boleto" in baixo:
            b = _boleto(dados, nome.rsplit("/", 1)[-1])
            (boletos if b else ignorados).append(b or nome)
        else:
            # DACTE em PDF e relatórios não são lidos: o XML já tem tudo, e ler
            # a versão impressa do mesmo documento só acrescentaria risco.
            ignorados.append(nome)
    if not ctes:
        raise HTTPException(422, "nenhum CT-e (XML) no pacote — a conferência lê "
                                 "o XML, não o DACTE em PDF")
    return {"ctes": ctes, "boletos": boletos, "ignorados": ignorados}


def conferir(conteudo: bytes, arquivo: str, transportadora: Optional[str] = None,
             gravar: bool = True, usuario: Optional[UsuarioOut] = None,
             conversa: Optional[bytes] = None, conversa_nome: str = "") -> dict:
    """A conferência inteira. `gravar=False` só analisa, sem tocar no banco.

    `conversa` é a exportação do WhatsApp onde o frete é cotado. Com ela, uma
    cobrança diferente do previsto deixa de ser acusação e ganha resposta: ou o
    valor foi cotado — e aí o desatualizado é o NOSSO registro —, ou não foi
    cotado em lugar nenhum, e esse é o caso que vale contestar.
    """
    pacote = ler_pacote(conteudo)
    ctes, boletos = pacote["ctes"], pacote["boletos"]

    total_ctes = round(sum(c["valor"] for c in ctes), 2)
    total_bol = round(sum(b["valor"] for b in boletos), 2)

    # ── 2 · repetidos ────────────────────────────────────────────────────────
    vezes_chave: dict = {}
    for c in ctes:
        vezes_chave[c["chave"]] = vezes_chave.get(c["chave"], 0) + 1
    duplicados = {k: v for k, v in vezes_chave.items() if v > 1}
    # A mesma NF cobrada em dois CT-e diferentes é o outro jeito de cobrar duas
    # vezes, e não aparece na contagem de chaves.
    nota_em: dict = {}
    for c in ctes:
        for n in c["notas"]:
            nota_em.setdefault(n, []).append(c["numero"])
    notas_repetidas = {n: v for n, v in nota_em.items() if len(v) > 1}

    # ── 3 · é nosso? ─────────────────────────────────────────────────────────
    de_terceiro = [c for c in ctes
                   if CNPJ_MSB not in str(c["rem_cnpj"])
                   and CNPJ_MSB not in str(c["dest_cnpj"])]

    # ── 4 e 5 · contra as nossas OVs ────────────────────────────────────────
    db = get_service_db()
    pedidos = []
    for off in range(0, 40000, 1000):
        b = db.table("pedidos").select(
            "numero_pedido, numero_nf, valor_frete, tipo_frete, "
            "transportadora_id, data_faturamento, criado_em")\
            .limit(1000).offset(off).execute().data
        pedidos += b
        if len(b) < 1000:
            break
    por_nf: dict = {}
    for p in pedidos:
        for n in _numeros_de_nf(p.get("numero_nf")):
            por_nf.setdefault(n, p)

    linhas = []
    for c in ctes:
        p = next((por_nf[n] for n in c["notas"] if n in por_nf), None)
        previsto = float(p.get("valor_frete") or 0) if p else None
        # A MSB como DESTINATARIO e o remetente sendo outro: frete de
        # ENTRADA — devolucao ou retorno. A nota ai e do remetente, entao ela
        # nunca vai estar em `pedidos`, e chamar isso de "NF desconhecida" faz
        # parecer falha de cadastro. Foi o Tassio quem apontou: "tem um frete de
        # devolucao da Arquimed pra MSB que a gente nao registrou no app".
        de_entrada = (CNPJ_MSB in str(c["dest_cnpj"])
                      and CNPJ_MSB not in str(c["rem_cnpj"]))
        if duplicados.get(c["chave"]):
            situacao = "DUPLICADO"
        elif c in de_terceiro:
            situacao = "NAO_E_NOSSO"
        elif de_entrada:
            situacao = "FRETE_DE_ENTRADA"
        elif p is None:
            situacao = "NF_DESCONHECIDA"
        elif abs((previsto or 0) - c["valor"]) >= 0.01:
            situacao = "VALOR_DIFERENTE"
        else:
            situacao = "OK"
        linhas.append({**c, "situacao": situacao, "previsto": previsto,
                       "ov": p.get("numero_pedido") if p else None})

    # ── a cotação do WhatsApp ────────────────────────────────────────────────
    # Cruza por VALOR: o número cobrado aparece entre os que a transportadora
    # citou? É indício forte, não prova — dois fretes podem ter o mesmo valor —,
    # e a tela diz isso. Mas separa o que foi combinado do que não foi, que é a
    # diferença entre "cobrança a mais" e "nosso registro desatualizado".
    cot = None
    if conversa:
        cot = ler_conversa(conversa, conversa_nome)
        citados = cot["valores"]
        for l in linhas:
            achados_iguais = [v for v in citados
                              if abs(v["valor"] - l["valor"]) < 0.01]
            l["cotado"] = bool(achados_iguais)
            l["cotado_em"] = sorted({v["data"] for v in achados_iguais})[:3] or None
            l["cotado_emergencial"] = any(v["emergencial"] for v in achados_iguais)
            # A FRASE da transportadora. É a evidência do número, e sem ela a
            # tela pede confiança em vez de mostrar de onde o "cotado" saiu.
            l["cotado_trecho"] = achados_iguais[0]["trecho"] if achados_iguais else None

    # ── 5 · NF nossa sem CT-e ───────────────────────────────────────────────
    datas = sorted(c["emissao"] for c in ctes if c["emissao"])
    de, ate = (datas[0], datas[-1]) if datas else (None, None)
    cobradas = {n for c in ctes for n in c["notas"]}
    # A transportadora vem do EMITENTE do CT-e, e não de um campo que a tela
    # precisa preencher. Sem isso a lista de "saiu e não tem CT-e" trazia notas
    # de TODAS as transportadoras: na fatura da RR apareciam 15 notas, entre
    # elas a OV016406, que foi pela BRIX — e o Tássio perguntou, com razão, o
    # que ela estava fazendo ali. São 3 quando só a RR entra.
    nome_transp = str(transportadora or (ctes[0].get("emitente") if ctes else "")
                      or "").strip().upper()
    transportadoras = {x["id"]: str(x.get("nome") or "").upper() for x in
                       db.table("transportadoras").select("id, nome")
                       .limit(500).execute().data}

    def _dia(p) -> str:
        for k in ("data_faturamento", "criado_em"):
            v = str(p.get(k) or "")[:10]
            if v:
                return v
        return ""

    sem_cte = []
    if de and ate:
        for p in pedidos:
            if (p.get("tipo_frete") or "") != "CIF_SEM_VALOR":
                continue
            if not (de <= _dia(p) <= ate):
                continue
            if nome_transp and not _mesma_transportadora(
                    nome_transp, transportadoras.get(p.get("transportadora_id"), "")):
                continue
            if any(n in cobradas for n in _numeros_de_nf(p.get("numero_nf"))):
                continue
            sem_cte.append({"ov": p.get("numero_pedido"), "nf": p.get("numero_nf"),
                            "previsto": float(p.get("valor_frete") or 0)})

    def _soma(sit):
        return round(sum(l["valor"] for l in linhas if l["situacao"] == sit), 2)

    achados = {
        "diferenca_soma": round(total_ctes - total_bol, 2),
        "duplicados": duplicados,
        "notas_repetidas": notas_repetidas,
        "de_terceiro": len(de_terceiro),
        "valor_diferente": len([l for l in linhas if l["situacao"] == "VALOR_DIFERENTE"]),
        "soma_das_diferencas": round(sum(
            l["valor"] - (l["previsto"] or 0)
            for l in linhas if l["situacao"] == "VALOR_DIFERENTE"), 2),
        "nf_desconhecida": len([l for l in linhas if l["situacao"] == "NF_DESCONHECIDA"]),
        "valor_nf_desconhecida": _soma("NF_DESCONHECIDA"),
        "frete_de_entrada": len([l for l in linhas if l["situacao"] == "FRETE_DE_ENTRADA"]),
        "valor_frete_de_entrada": _soma("FRETE_DE_ENTRADA"),
        "sem_cte": sem_cte,
        "ignorados": len(pacote["ignorados"]),
    }

    # O que a conversa acrescenta, e que muda a leitura dos achados acima: uma
    # cobrança diferente do previsto E cotada não é problema; a mesma cobrança
    # SEM cotação é o que se contesta com a transportadora.
    if cot is not None:
        divergentes = [l for l in linhas if l["situacao"] == "VALOR_DIFERENTE"]
        sem_cotacao = [l for l in divergentes if not l.get("cotado")]
        achados["conversa"] = {
            "mensagens": cot["mensagens"],
            "valores_citados": len(cot["valores"]),
            "de": cot["de"], "ate": cot["ate"],
            "cobrado_confirmado": len(divergentes) - len(sem_cotacao),
            "cobrado_sem_cotacao": len(sem_cotacao),
            "valor_sem_cotacao": round(sum(
                l["valor"] - (l["previsto"] or 0) for l in sem_cotacao), 2),
        }

    resultado = {
        "transportadora": (ctes[0].get("emitente") if ctes else None) or transportadora,
        "periodo_de": de, "periodo_ate": ate,
        "vencimento": next((b["vencimento"] for b in boletos if b.get("vencimento")), None),
        "total_ctes": total_ctes, "total_boletos": total_bol,
        "qtd_ctes": len(ctes), "qtd_boletos": len(boletos),
        "boletos": boletos, "achados": achados, "ctes": linhas,
        "arquivo": arquivo,
    }
    if gravar:
        resultado["id"] = _grava(resultado, usuario)
    return resultado


def _grava(r: dict, usuario: Optional[UsuarioOut]) -> Optional[str]:
    """Guarda a conferência e apaga o que passou de 3 meses.

    A limpeza roda aqui, e não num job: não há agendador no servidor, e o que
    não roda junto com o uso não roda nunca. Retenção pedida pelo Tássio para o
    app não pesar.
    """
    db = get_service_db()
    try:
        linha = db.table("frete_conferencias").insert({
            "transportadora": r["transportadora"],
            "periodo_de": r["periodo_de"], "periodo_ate": r["periodo_ate"],
            "vencimento": r["vencimento"],
            "total_boletos": r["total_boletos"], "total_ctes": r["total_ctes"],
            "qtd_ctes": r["qtd_ctes"], "qtd_boletos": r["qtd_boletos"],
            "achados": r["achados"], "arquivo": r["arquivo"],
            "criado_por": str(usuario.id) if usuario else None,
        }).execute().data[0]
    except Exception as e:
        # Sem a v47 a conferência continua valendo na tela — ela só não fica
        # guardada. Melhor isso do que recusar o trabalho.
        print("conferencia de frete nao foi gravada: %s" % str(e)[:160])
        return None

    for c in r["ctes"]:
        try:
            db.table("frete_conferencia_ctes").insert({
                "conferencia_id": linha["id"], "numero": c["numero"],
                "chave": c["chave"], "emissao": c["emissao"], "valor": c["valor"],
                "remetente": c["remetente"], "destinatario": c["destinatario"],
                "notas": c["notas"], "situacao": c["situacao"],
                "previsto": c["previsto"], "ov": c["ov"],
            }).execute()
        except Exception as e:
            print("CT-e %s nao gravado: %s" % (c["numero"], str(e)[:100]))

    _limpa_antigas(db)
    return linha["id"]


def _limpa_antigas(db) -> int:
    from datetime import datetime, timezone
    corte = (datetime.now(timezone.utc) - timedelta(days=30 * MESES_DE_HISTORICO))
    try:
        velhas = db.table("frete_conferencias").select("id")\
            .lt("criado_em", corte.isoformat()).limit(500).execute().data
        for v in velhas:
            db.table("frete_conferencias").delete().eq("id", v["id"]).execute()
        return len(velhas)
    except Exception:
        return 0


def gastos(meses: int = 6) -> dict:
    """Quanto a MSB gasta de frete, por transportadora e por mês.

    Só CIF SEM VALOR: é o frete que a MSB paga. FOB é do cliente e
    NAO_UTILIZAR_TERCEIROS não gera fatura — misturar os três daria um número
    que não corresponde a nenhuma conta a pagar.

    Devolve junto os pedidos SEM transportadora, porque eles não somem do gasto:
    medido em 15/09/2026 são 78 pedidos e R$ 17.896,13, quase um terço do total.
    Sem essa lista, o relatório mostraria menos do que a empresa gasta e ninguém
    saberia por quê.
    """
    db = get_service_db()
    pedidos = []
    for off in range(0, 40000, 1000):
        b = db.table("pedidos").select(
            "numero_pedido, numero_nf, valor_nf, valor_frete, tipo_frete, "
            "transportadora_id, cliente_id, local_entrega, status, "
            "data_faturamento, criado_em").limit(1000).offset(off).execute().data
        pedidos += b
        if len(b) < 1000:
            break
    transp = {t["id"]: t.get("nome") for t in
              db.table("transportadoras").select("id, nome, ativo")
              .limit(500).execute().data}
    clientes = {}
    for off in range(0, 40000, 1000):
        b = db.table("clientes").select("id, codigo, nome").limit(1000)\
            .offset(off).execute().data
        clientes.update({c["id"]: c for c in b})
        if len(b) < 1000:
            break

    def _quando(p) -> str:
        for k in ("data_faturamento", "criado_em"):
            v = str(p.get(k) or "")[:10]
            if v:
                return v
        return ""

    cif = [p for p in pedidos if (p.get("tipo_frete") or "") == "CIF_SEM_VALOR"]
    meses_vistos = sorted({_quando(p)[:7] for p in cif if _quando(p)}, reverse=True)
    janela = meses_vistos[:max(1, meses)]

    linhas: dict = {}
    for p in cif:
        mes = _quando(p)[:7]
        if mes not in janela:
            continue
        nome = transp.get(p.get("transportadora_id")) or None
        chave = (mes, nome or "")
        alvo = linhas.setdefault(chave, {"mes": mes, "transportadora": nome,
                                         "notas": 0, "valor": 0.0})
        alvo["notas"] += 1
        alvo["valor"] = round(alvo["valor"] + float(p.get("valor_frete") or 0), 2)

    sem_transportadora = []
    for p in cif:
        if p.get("transportadora_id"):
            continue
        cli = clientes.get(p.get("cliente_id")) or {}
        sem_transportadora.append({
            "ov": p.get("numero_pedido"), "nf": p.get("numero_nf"),
            "valor_frete": float(p.get("valor_frete") or 0),
            "valor_nf": float(p.get("valor_nf") or 0),
            "cliente": cli.get("nome"), "local_entrega": p.get("local_entrega"),
            "quando": _quando(p), "status": p.get("status"),
        })
    sem_transportadora.sort(key=lambda x: (x["quando"] or ""), reverse=True)

    return {
        "meses": janela,
        "linhas": sorted(linhas.values(),
                         key=lambda x: (x["mes"], -x["valor"]), reverse=True),
        "sem_transportadora": sem_transportadora,
        "total_sem_transportadora": round(
            sum(x["valor_frete"] for x in sem_transportadora), 2),
        "transportadoras": sorted(
            [{"id": i, "nome": n} for i, n in transp.items() if n],
            key=lambda x: str(x["nome"]).upper()),
    }


def definir_transportadora(numero_pedido: str, transportadora_id: str,
                           usuario: Optional[UsuarioOut] = None) -> dict:
    """Diz qual transportadora levou um pedido que estava sem.

    Só preenche o que falta e só isso: não mexe em valor de frete, tipo nem
    status. Quem informa é quem sabe, e o resto do pedido não é assunto desta
    tela.
    """
    db = get_service_db()
    alvo = str(numero_pedido or "").strip().upper()
    achado = db.table("pedidos").select("id, numero_pedido, transportadora_id")\
        .eq("numero_pedido", alvo).execute().data
    if not achado:
        raise HTTPException(404, "OV %s não existe" % alvo)
    t = db.table("transportadoras").select("id, nome")\
        .eq("id", str(transportadora_id)).execute().data
    if not t:
        raise HTTPException(404, "transportadora não encontrada")
    db.table("pedidos").update({"transportadora_id": str(transportadora_id)})\
        .eq("id", achado[0]["id"]).execute()
    return {"ov": achado[0]["numero_pedido"], "transportadora": t[0]["nome"]}


def analise_ov(numero: str) -> dict:
    """O que a conferência sabe de UMA OV, com o veredito em palavras.

    Nasceu de uma pergunta do Tássio sobre a OV016406: "o que tá de errado com
    essa OV nos fretes?". A resposta era "nada — ela foi pela BRIX", e ele teve
    de me perguntar para saber. Cada ponto aqui devolve `ok` (verdadeiro, falso
    ou nulo quando não dá para dizer) e a frase que explica, para a tela não
    precisar interpretar número nenhum.
    """
    db = get_service_db()
    alvo = str(numero or "").strip().upper()
    pedidos = []
    for off in range(0, 40000, 1000):
        b = db.table("pedidos").select("*").limit(1000).offset(off).execute().data
        pedidos += b
        if len(b) < 1000:
            break
    p = next((x for x in pedidos
              if str(x.get("numero_pedido") or "").strip().upper() == alvo), None)
    if not p:
        raise HTTPException(404, "OV %s não existe no app" % alvo)

    transp = ""
    if p.get("transportadora_id"):
        achado = db.table("transportadoras").select("nome")\
            .eq("id", p["transportadora_id"]).execute().data
        transp = (achado[0]["nome"] if achado else "") or ""
    cliente = ""
    if p.get("cliente_id"):
        achado = db.table("clientes").select("codigo, nome")\
            .eq("id", p["cliente_id"]).execute().data
        if achado:
            cliente = "%s · %s" % (achado[0].get("codigo"), achado[0].get("nome"))

    nfs = _numeros_de_nf(p.get("numero_nf"))
    nf = nfs[0] if nfs else ""
    previsto = float(p.get("valor_frete") or 0)
    tipo = (p.get("tipo_frete") or "").upper()

    # Os CT-e que já cobraram esta nota, em qualquer conferência guardada (v47).
    # Um CT-e por CHAVE, e não um por linha: a mesma fatura pode ter sido
    # conferida mais de uma vez, e aí o mesmo CT-e existe em várias
    # conferências. Sem isto a análise repetia "CT-e 94113 cobrou R$ 383,42"
    # seis vezes, como se fossem seis cobranças.
    cobrancas = []
    try:
        vistos = set()
        linhas = db.table("frete_conferencia_ctes").select("*")\
            .limit(4000).execute().data
        for l in linhas:
            notas = [str(x).lstrip("0") for x in (l.get("notas") or [])]
            ident = l.get("chave") or l.get("numero")
            if nfs and (set(nfs) & set(notas)) and ident not in vistos:
                vistos.add(ident)
                cobrancas.append(l)
    except Exception:
        cobrancas = []

    pontos = []
    # 1 · o frete é nosso?
    if tipo == "CIF_SEM_VALOR":
        pontos.append({"ok": True, "titulo": "Frete pago pela MSB",
                       "detalhe": "CIF sem valor — entra na conferência da fatura."})
    else:
        pontos.append({"ok": None, "titulo": "Não é frete pago pela MSB",
                       "detalhe": "Tipo %s. A fatura da transportadora não cobre "
                                  "esta OV." % (tipo or "não informado")})
    # 2 · quem levou
    pontos.append({
        "ok": None if not transp else True,
        "titulo": "Transportadora: %s" % (transp or "não informada"),
        "detalhe": "A conferência de uma transportadora não mostra OV de outra — "
                   "cada fatura cobre só o que ela levou."
        if transp else "Sem transportadora no pedido, não dá para dizer em qual "
                       "fatura esta OV deveria aparecer.",
    })
    # 3 · foi cobrada?
    if not nf:
        pontos.append({"ok": None, "titulo": "Sem nota fiscal",
                       "detalhe": "Sem NF não há como casar com CT-e nenhum."})
    elif not cobrancas:
        pontos.append({
            "ok": None, "titulo": "Nenhum CT-e cobrou esta nota ainda",
            "detalhe": "Não apareceu em nenhuma conferência guardada. Ou entra "
                       "no próximo boleto, ou a transportadora não cobrou.",
        })
    else:
        for c in cobrancas:
            valor = float(c.get("valor") or 0)
            dif = round(valor - previsto, 2)
            if abs(dif) < 0.01:
                pontos.append({
                    "ok": True,
                    "titulo": "CT-e %s cobrou %s — igual ao previsto"
                              % (c.get("numero"), _reais(valor)),
                    "detalhe": "Confere com o frete da OV.",
                })
            else:
                pontos.append({
                    "ok": False,
                    "titulo": "CT-e %s cobrou %s, previsto %s (%s%s)"
                              % (c.get("numero"), _reais(valor), _reais(previsto),
                                 "+" if dif > 0 else "", _reais(dif)),
                    "detalhe": "Confira se este valor foi cotado com a "
                               "transportadora — se não foi, é o que se contesta.",
                })
    tudo_certo = all(pt["ok"] is not False for pt in pontos)
    return {
        "ov": p.get("numero_pedido"), "nf": p.get("numero_nf"),
        "valor_nf": p.get("valor_nf"), "previsto": previsto,
        "tipo_frete": p.get("tipo_frete"), "transportadora": transp,
        "cliente": cliente, "local_entrega": p.get("local_entrega"),
        "status": p.get("status"),
        "faturada_em": str(p.get("data_faturamento") or "")[:10] or None,
        "cobrancas": cobrancas, "pontos": pontos, "tudo_certo": tudo_certo,
    }


def _reais(v) -> str:
    return "R$ %s" % format(float(v or 0), ",.2f").replace(",", "X")\
        .replace(".", ",").replace("X", ".")


def listar(limite: int = 24) -> list[dict]:
    """O histórico — os últimos 3 meses, do mais novo para o mais antigo."""
    db = get_service_db()
    try:
        return db.table("frete_conferencias").select("*")\
            .order("criado_em", desc=True).limit(limite).execute().data
    except Exception:
        return []


def detalhe(conferencia_id: str) -> dict:
    db = get_service_db()
    cab = db.table("frete_conferencias").select("*").eq("id", conferencia_id)\
        .execute().data
    if not cab:
        raise HTTPException(404, "conferência não encontrada")
    ctes = db.table("frete_conferencia_ctes").select("*")\
        .eq("conferencia_id", conferencia_id).limit(2000).execute().data
    ordem = {"DUPLICADO": 0, "NAO_E_NOSSO": 1, "NF_DESCONHECIDA": 2,
             "FRETE_DE_ENTRADA": 3, "VALOR_DIFERENTE": 4, "OK": 5}
    ctes.sort(key=lambda c: (ordem.get(c.get("situacao"), 9), -float(c.get("valor") or 0)))
    return {**cab[0], "ctes": ctes}

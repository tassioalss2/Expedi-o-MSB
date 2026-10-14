# -*- coding: utf-8 -*-
"""Espelho das notas fiscais do D365 — a fonte de verdade do faturamento.

POR QUE EXISTE
--------------
Hoje o faturamento do app é derivado da operação: uma OV do kanban recebe NF e
vira faturamento. Isso funciona enquanto tudo o que a MSB fatura passa pela
nossa operação. Quando a licitação passar para a Bio, o comunicado de uso vai
ser emitido por quem não usa o app — a nota continua saindo pela MSB, mas o
app não fica sabendo, e o faturamento mostrado fica curto.

A conciliação de 01 a 14/10/2026 já mostrava a diferença antes de a Bio
assumir: 19 notas (R$ 10.965,06) existiam no D365 e não no app — 15 de
consignação e 4 de venda a não contribuinte, exatamente o tipo de nota que vai
crescer.

A saída é separar as duas coisas: o KANBAN continua sendo a operação (o que a
logística tem de fazer) e o FATURAMENTO passa a ser o que o D365 emitiu,
venha de onde vier. Este módulo guarda esse espelho e confronta as duas pontas.

O export usado é o "DynamicsExport" de notas fiscais, uma linha por NF:
Finalidade · Número · Série · ID do estabelecimento fiscal · Modelo · Status ·
Conta · Emissor · Nome · Data do documento · Data de lançamento · Hora ·
Valor total · Valor total de produtos · CNPJ/CPF · IE · Direção ·
Tipo de empresa · Chave de acesso · Descrição da operação.
"""
import io
import unicodedata
from datetime import datetime, date
from typing import Optional

import pandas as pd

from app.core.database import get_service_db
from app.models.schemas import UsuarioOut


# ── Leitura do arquivo ────────────────────────────────────────────────────────

def _sem_acento(s: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", str(s or ""))
                   if not unicodedata.combining(c)).strip().lower()


# Cada campo do espelho e os cabeçalhos que o D365 usa para ele. Casa sem
# acento e sem caixa, porque o export vem do idioma do usuário e um "Número"
# virando "Numero" não pode quebrar a importação.
COLUNAS = {
    "numero":          ["numero", "numero da nota fiscal", "nf"],
    "serie":           ["serie"],
    "estabelecimento": ["id do estabelecimento fiscal", "estabelecimento"],
    "modelo":          ["modelo"],
    "finalidade":      ["finalidade"],
    "status":          ["status"],
    "direcao":         ["direcao"],
    "cliente_conta":   ["conta", "codigo do cliente"],
    "cliente_nome":    ["nome", "cliente"],
    "cnpj":            ["cnpj/cpf", "cnpj"],
    "data_documento":  ["data do documento", "data"],
    "data_lancamento": ["data de lancamento"],
    "valor_total":     ["valor total"],
    "valor_produtos":  ["valor total de produtos"],
    "operacao":        ["descricao da operacao", "operacao"],
    "chave_acesso":    ["chave de acesso"],
}

OBRIGATORIAS = ("numero", "data_documento", "valor_total")


def _mapear_colunas(df: pd.DataFrame) -> dict:
    achadas = {}
    disponiveis = {_sem_acento(c): c for c in df.columns}
    for campo, nomes in COLUNAS.items():
        for n in nomes:
            if n in disponiveis:
                achadas[campo] = disponiveis[n]
                break
    return achadas


def chave_nf(numero) -> str:
    """Só os dígitos, sem zeros à esquerda.

    O D365 exporta 000021124 e a operadora digita 21124 no app. Sem normalizar,
    a mesma nota aparece como duas — e a conciliação acusaria um buraco que não
    existe.
    """
    d = "".join(c for c in str(numero or "") if c.isdigit())
    return d.lstrip("0") or d


def _data(v) -> Optional[str]:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    if isinstance(v, (datetime, date)):
        return str(v)[:10]
    t = str(v).strip()
    if not t or t.lower() == "nat":
        return None
    for fmt in ("%Y-%m-%d", "%d/%m/%Y", "%d/%m/%y"):
        try:
            return datetime.strptime(t[:10], fmt).date().isoformat()
        except ValueError:
            continue
    return t[:10]


def _num(v) -> float:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return 0.0
    if isinstance(v, (int, float)):
        return float(v)
    t = str(v).strip().replace("R$", "").replace(" ", "")
    if "," in t and "." in t:
        t = t.replace(".", "").replace(",", ".")
    elif "," in t:
        t = t.replace(",", ".")
    try:
        return float(t)
    except ValueError:
        return 0.0


def _txt(v) -> Optional[str]:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    t = str(v).strip()
    return t or None


# ── Natureza da operação ──────────────────────────────────────────────────────
#
# A operação fiscal do D365 diz as DUAS coisas que o app precisa saber — a
# natureza (é receita? é comunicado de uso?) e de onde a venda veio (licitação
# ou comercial). A regra é do Tássio, 14/10/2026:
#
#   · "destinada a não contribuinte"          → venda DIRETA de LICITAÇÃO
#   · "remetida anteriormente em consignação" → COMUNICADO DE USO (licitação)
#   · qualquer outra                          → venda normal, NÃO é licitação
#
# A ordem importa: "destinada a não contri" é um caso particular de "venda de
# produção do estabelecimento", então tem de ser testada antes. Operação que
# não casa com nada entra sem classificação, e a tela pede — chutar a natureza
# de uma nota é chutar se ela conta como receita.
MAPA_OPERACAO = (
    ("destinada a nao contri",        ("VENDA_NORMAL",   "LICITACAO")),
    ("remet ant consignacao",         ("COMUNICADO_USO", "LICITACAO")),
    ("consignacao mercantil",         ("COMUNICADO_USO", "LICITACAO")),
    ("venda de producao do estabelecimento", ("VENDA_NORMAL", "COMERCIAL")),
    ("venda de mercadoria adquirida", ("VENDA_NORMAL",   "COMERCIAL")),
    ("exportacao",                    ("EXPORTACAO",     "COMERCIAL")),
    ("devolucao",                     ("DEVOLUCAO",      None)),
    ("remessa",                       ("REMESSA",        None)),
    ("bonificacao",                   ("BONIFICACAO",    None)),
    ("amostra",                       ("AMOSTRA",        None)),
)

# Praticamente toda licitação é vascular. Serve de palpite inicial para a nota
# que NÃO passou pelo app — sem ela, o faturamento da Bio entraria sem linha e
# sumiria do placar por canal. Raro não é nunca: a tela deixa corrigir a nota.
LINHA_PADRAO_LICITACAO = "VASCULAR"


def classificar(texto: Optional[str]) -> tuple:
    """(tipo_operacao, origem_venda) a partir da descrição da operação."""
    t = _sem_acento(texto)
    if not t:
        return None, None
    for marca, (tipo, origem) in MAPA_OPERACAO:
        if marca in t:
            return tipo, origem
    return None, None


def tipo_da_operacao(texto: Optional[str]) -> Optional[str]:
    return classificar(texto)[0]


# ── Importação ────────────────────────────────────────────────────────────────

def _pagina(db, tabela: str, cols: str) -> list:
    out = []
    for off in range(0, 100000, 1000):
        lote = db.table(tabela).select(cols).limit(1000).offset(off).execute().data
        out += lote
        if len(lote) < 1000:
            break
    return out


def importar(conteudo: bytes, nome_arquivo: str, usuario: UsuarioOut) -> dict:
    """Lê o export e grava o espelho. Reimportar o mesmo período não duplica.

    A identidade da nota é número + série + estabelecimento. As notas do arquivo
    são regravadas inteiras: o espelho não guarda nada digitado à mão, então
    refazer a linha a partir do D365 é sempre o certo.
    """
    try:
        if nome_arquivo.lower().endswith(".csv"):
            df = pd.read_csv(io.BytesIO(conteudo), sep=";")
        else:
            df = pd.read_excel(io.BytesIO(conteudo))
    except Exception as e:
        return {"erro": f"Não consegui ler o arquivo: {e}", "importadas": 0}

    col = _mapear_colunas(df)
    faltando = [c for c in OBRIGATORIAS if c not in col]
    if faltando:
        return {
            "erro": "O arquivo não parece ser o export de notas do D365 — faltam as "
                    "colunas: " + ", ".join(faltando),
            "colunas_encontradas": list(df.columns)[:30],
            "importadas": 0,
        }

    db = get_service_db()

    # Clientes pelo código do D365 (coluna "Conta") e OVs pelo número da NF:
    # as duas pontas que ligam a nota ao que o app já sabe.
    clientes = {}
    for c in _pagina(db, "clientes", "id, codigo"):
        if c.get("codigo"):
            clientes[str(c["codigo"]).strip().upper()] = c["id"]
    ovs = {}
    for p in _pagina(db, "pedidos", "id, numero_nf, status"):
        k = chave_nf(p.get("numero_nf"))
        if k and p.get("status") != "CANCELADO":
            ovs[k] = p["id"]

    linhas, sem_classificacao = [], {}
    for _, r in df.iterrows():
        numero = _txt(r[col["numero"]])
        if not numero:
            continue
        operacao = _txt(r[col["operacao"]]) if "operacao" in col else None
        tipo, origem = classificar(operacao)
        if operacao and not tipo:
            sem_classificacao[operacao] = sem_classificacao.get(operacao, 0) + 1
        conta = (_txt(r[col["cliente_conta"]]) if "cliente_conta" in col else None)
        chave = chave_nf(numero)
        linhas.append({
            "numero": numero,
            "serie": _txt(r[col["serie"]]) if "serie" in col else None,
            "estabelecimento": _txt(r[col["estabelecimento"]]) if "estabelecimento" in col else None,
            "chave_numero": chave,
            "modelo": _txt(r[col["modelo"]]) if "modelo" in col else None,
            "finalidade": _txt(r[col["finalidade"]]) if "finalidade" in col else None,
            "status": _txt(r[col["status"]]) if "status" in col else None,
            "direcao": _txt(r[col["direcao"]]) if "direcao" in col else None,
            "cliente_conta": conta,
            "cliente_nome": _txt(r[col["cliente_nome"]]) if "cliente_nome" in col else None,
            "cnpj": _txt(r[col["cnpj"]]) if "cnpj" in col else None,
            "cliente_id": clientes.get((conta or "").strip().upper()),
            "data_documento": _data(r[col["data_documento"]]),
            "data_lancamento": _data(r[col["data_lancamento"]]) if "data_lancamento" in col else None,
            "valor_total": round(_num(r[col["valor_total"]]), 2),
            "valor_produtos": round(_num(r[col["valor_produtos"]]), 2) if "valor_produtos" in col else None,
            "operacao": operacao,
            "tipo_operacao": tipo,
            "origem_venda": origem,
            # Nota COM OV não usa a linha daqui: a OV manda, item a item, e é
            # rateio melhor do que qualquer palpite. Sem OV, licitação nasce
            # vascular e o resto fica sem linha até alguém dizer.
            "linha": (None if ovs.get(chave)
                      else (LINHA_PADRAO_LICITACAO if origem == "LICITACAO" else None)),
            "chave_acesso": _txt(r[col["chave_acesso"]]) if "chave_acesso" in col else None,
            "pedido_id": ovs.get(chave),
            "arquivo": nome_arquivo,
            "importado_por": str(usuario.id),
        })

    if not linhas:
        return {"erro": "O arquivo não tem nenhuma nota.", "importadas": 0}

    # Regrava as notas deste arquivo: apaga só as que vieram nele (por chave do
    # número) e insere de novo. Nenhuma nota fora do arquivo é tocada.
    #
    # A linha corrigida à mão sobrevive: é a única informação do espelho que não
    # vem do D365, e perdê-la a cada reimportação faria o operador corrigir a
    # mesma nota todo dia.
    chaves = sorted({l["chave_numero"] for l in linhas})
    ajustadas = {}
    for i in range(0, len(chaves), 40):
        lote = chaves[i:i + 40]
        for n in db.table("notas_d365").select("chave_numero, linha, linha_ajustada")                .in_("chave_numero", lote).execute().data:
            if n.get("linha_ajustada"):
                ajustadas[n["chave_numero"]] = n.get("linha")
        db.table("notas_d365").delete().in_("chave_numero", lote).execute()
    for l in linhas:
        if l["chave_numero"] in ajustadas:
            l["linha"] = ajustadas[l["chave_numero"]]
            l["linha_ajustada"] = True
    for i in range(0, len(linhas), 200):
        db.table("notas_d365").insert(linhas[i:i + 200]).execute()

    datas = [l["data_documento"] for l in linhas if l["data_documento"]]
    # O export traz as canceladas, e ainda bem: é assim que uma nota que morreu
    # depois de importada some do faturamento sem ninguém avisar o app. Elas
    # entram no espelho (o registro é a verdade do D365) e ficam fora da conta.
    saidas = [l for l in linhas if _vale_como_faturamento(l)]
    return {
        "importadas": len(linhas),
        "canceladas": sum(1 for l in linhas if not _aprovada(l)),
        "periodo_ini": min(datas) if datas else None,
        "periodo_fim": max(datas) if datas else None,
        # Transfer price (Biomedical) fica fora do faturamento, aqui como em
        # todo o resto do app.
        "valor_total": round(sum(l["valor_total"] for l in saidas
                                 if not eh_transfer_price(l.get("cliente_nome"))), 2),
        "valor_transfer": round(sum(l["valor_total"] for l in saidas
                                    if eh_transfer_price(l.get("cliente_nome"))), 2),
        "com_ov": sum(1 for l in linhas if l["pedido_id"]),
        "sem_ov": sum(1 for l in linhas if not l["pedido_id"]),
        "operacoes_sem_classificacao": [
            {"operacao": k, "qtd": v} for k, v in sorted(
                sem_classificacao.items(), key=lambda x: -x[1])],
        "por_tipo": _agrupar_por_tipo(
            [l for l in saidas if not eh_transfer_price(l.get("cliente_nome"))]),
    }


def _aprovada(nota: dict) -> bool:
    """Nota viva. O D365 exporta a cancelada também, e ela não é faturamento."""
    return str(nota.get("status") or "Aprovado").strip().lower().startswith("aprov")


def eh_transfer_price(nome: Optional[str]) -> bool:
    """Nota para a Biomedical: repasse dentro do grupo, não receita da MSB.

    Mesma regra do resto do app (`_eh_biomedical` em api/pedidos.py): casa por
    nome do cliente. O espelho guarda a nota como qualquer outra — ela existe e
    a logística a movimenta —, mas ela fica fora do faturamento e da meta, e a
    conciliação a mostra à parte para ninguém achar que sumiu por engano.
    """
    return "BIOMEDICAL" in (nome or "").upper()


def _vale_como_faturamento(nota: dict) -> bool:
    """Saída aprovada. Entrada é devolução e tem tratamento próprio no app."""
    return _aprovada(nota) and (nota.get("direcao") or "Saída") == "Saída"


def _agrupar_por_tipo(linhas: list) -> list:
    agg = {}
    for l in linhas:
        k = l.get("tipo_operacao") or "A CLASSIFICAR"
        g = agg.setdefault(k, {"tipo": k, "qtd": 0, "valor": 0.0})
        g["qtd"] += 1
        g["valor"] = round(g["valor"] + float(l.get("valor_total") or 0), 2)
    return sorted(agg.values(), key=lambda x: -x["valor"])


def _agrupar(linhas: list, chave) -> list:
    agg = {}
    for l in linhas:
        k = chave(l)
        g = agg.setdefault(k, {"chave": k, "qtd": 0, "valor": 0.0})
        g["qtd"] += 1
        g["valor"] = round(g["valor"] + float(l.get("valor_total") or 0), 2)
    return sorted(agg.values(), key=lambda x: -x["valor"])


def ajustar_linha(nota_id: str, linha: Optional[str]) -> dict:
    """Corrige a linha comercial de uma nota que não passou pelo app.

    Licitação nasce vascular porque é lá que ela cai quase sempre; quando vier
    um Uro ou um RealClosure, a correção é aqui e vale só para esta nota — não
    vira regra, porque a exceção não é o caso.
    """
    valor = (linha or "").strip().upper() or None
    if valor and valor not in ("URO", "VASCULAR", "REALCLOSURE"):
        raise ValueError("Linha inválida: use URO, VASCULAR ou REALCLOSURE.")
    db = get_service_db()
    r = db.table("notas_d365").update({
        "linha": valor, "linha_ajustada": True,
    }).eq("id", nota_id).execute().data
    return (r or [{}])[0]


# ── Conciliação ───────────────────────────────────────────────────────────────

def conciliacao(ini: str, fim: str) -> dict:
    """As duas pontas lado a lado no período: o que o D365 emitiu e o que o app
    registrou.

    Três buracos possíveis, e cada um tem um dono:
      · nota no D365 sem OV no app — comunicado de uso de quem não usa o app,
        ou OV que alguém esqueceu de faturar aqui;
      · OV faturada no app sem nota no D365 — número digitado errado, ou
        faturamento que não existiu;
      · a mesma nota com valor ou data diferente nos dois lados.
    """
    db = get_service_db()

    notas = db.table("notas_d365").select(
        "id, numero, chave_numero, serie, cliente_nome, cliente_conta, data_documento, "
        "valor_total, operacao, tipo_operacao, origem_venda, linha, linha_ajustada, "
        "direcao, status, pedido_id"
    ).gte("data_documento", ini).lte("data_documento", fim).limit(5000).execute().data

    notas = [n for n in notas if _vale_como_faturamento(n)]
    # Transfer price sai das duas pontas ao mesmo tempo: se saísse só de uma, a
    # diferença entre D365 e app passaria a ser o próprio transfer price.
    notas_transfer = [n for n in notas if eh_transfer_price(n.get("cliente_nome"))]
    notas = [n for n in notas if not eh_transfer_price(n.get("cliente_nome"))]

    peds = db.table("pedidos").select(
        "id, numero_pedido, numero_nf, valor_nf, data_faturamento, status, "
        "tipo_operacao, cliente_id, clientes(nome)"
    ).gte("data_faturamento", f"{ini}T00:00:00").lte("data_faturamento", f"{fim}T23:59:59")\
        .limit(5000).execute().data

    app, app_transfer = {}, {}
    for p in peds:
        k = chave_nf(p.get("numero_nf"))
        if not k or p.get("status") == "CANCELADO":
            continue
        if eh_transfer_price((p.get("clientes") or {}).get("nome")):
            app_transfer[k] = p
        else:
            app[k] = p
    d365 = {n["chave_numero"]: n for n in notas}

    so_d365, so_app, divergentes = [], [], []
    for k, n in d365.items():
        if k in app:
            p = app[k]
            va, vd = round(float(p.get("valor_nf") or 0), 2), round(float(n.get("valor_total") or 0), 2)
            da = str(p.get("data_faturamento") or "")[:10]
            dd = str(n.get("data_documento") or "")[:10]
            if abs(va - vd) > 0.01 or (da and dd and da != dd):
                divergentes.append({
                    "nf": n["numero"], "ov": p.get("numero_pedido"), "pedido_id": p.get("id"),
                    "valor_app": va, "valor_d365": vd, "data_app": da, "data_d365": dd,
                    "cliente": n.get("cliente_nome"),
                })
        else:
            so_d365.append({
                "id": n.get("id"),
                "nf": n["numero"], "data": n.get("data_documento"),
                "cliente": n.get("cliente_nome"), "cliente_conta": n.get("cliente_conta"),
                "valor": round(float(n.get("valor_total") or 0), 2),
                "operacao": n.get("operacao"), "tipo_operacao": n.get("tipo_operacao"),
                "origem_venda": n.get("origem_venda"),
                "linha": n.get("linha"), "linha_ajustada": n.get("linha_ajustada"),
            })
    for k, p in app.items():
        if k not in d365:
            so_app.append({
                "nf": p.get("numero_nf"), "ov": p.get("numero_pedido"), "pedido_id": p.get("id"),
                "data": str(p.get("data_faturamento") or "")[:10],
                "valor": round(float(p.get("valor_nf") or 0), 2),
                "cliente": (p.get("clientes") or {}).get("nome"),
                "tipo_operacao": p.get("tipo_operacao"),
            })

    so_d365.sort(key=lambda x: -x["valor"])
    so_app.sort(key=lambda x: -x["valor"])
    total_d365 = round(sum(float(n.get("valor_total") or 0) for n in notas), 2)
    total_app = round(sum(float(p.get("valor_nf") or 0) for p in app.values()), 2)
    return {
        "periodo": {"ini": ini, "fim": fim},
        "d365": {"qtd": len(d365), "valor": total_d365},
        "app": {"qtd": len(app), "valor": total_app},
        "diferenca": round(total_d365 - total_app, 2),
        "casam": len(d365) - len(so_d365),
        "so_d365": so_d365,
        "so_app": so_app,
        "divergentes": sorted(divergentes, key=lambda x: -abs(x["valor_d365"] - x["valor_app"])),
        # Fora da conta, à vista: o material existe e a logística o movimenta,
        # mas repasse dentro do grupo não é faturamento da MSB.
        "transfer": {
            "d365_qtd": len(notas_transfer),
            "d365_valor": round(sum(float(n.get("valor_total") or 0) for n in notas_transfer), 2),
            "app_qtd": len(app_transfer),
            "app_valor": round(sum(float(p.get("valor_nf") or 0) for p in app_transfer.values()), 2),
            "notas": sorted([{
                "id": n.get("id"), "nf": n["numero"], "data": n.get("data_documento"),
                "cliente": n.get("cliente_nome"),
                "valor": round(float(n.get("valor_total") or 0), 2),
                "no_app": n["chave_numero"] in app_transfer,
            } for n in notas_transfer], key=lambda x: -x["valor"]),
        },
        "por_tipo": _agrupar_por_tipo(notas),
        "por_origem": _agrupar(notas, lambda n: n.get("origem_venda") or "COMERCIAL"),
        # Linha das notas que NÃO passaram pelo app: é o pedaço do faturamento
        # que o placar por canal perderia quando a licitação sair daqui.
        "linha_sem_ov": _agrupar([n for n in notas if not n.get("pedido_id")],
                                 lambda n: n.get("linha") or "SEM LINHA"),
        # Sem nota importada no período não há conciliação a fazer: a tela diz
        # "importe o export do mês" em vez de acusar um buraco de 100%. Conta o
        # transfer price também: mês só com nota de Biomedical tem espelho.
        "sem_espelho": len(d365) + len(notas_transfer) == 0,
    }

# -*- coding: utf-8 -*-
"""Importação da Base de Notas Fiscais do BI, item a item.

O espelho do D365 resolve a NOTA. Esta base resolve o ITEM — quanto saiu de
cada produto, a que preço, para quem, em que vertical. É a informação que o
app perde quando as OVs deixam de nascer aqui.

Duas regras que valem para sempre:

1. **Não é fonte de receita.** O faturamento continua vindo de onde vem.
   Somar esta base com `notas_d365` contaria a mesma venda duas vezes. Aqui
   ela enriquece: quantidade, preço, produto, vertical, vendedor.

2. **A linha de TOTAL do arquivo é conferência, não dado.** O BI exporta uma
   linha "TOTAL DO FILTRO" com a soma do período. Ela é descartada da carga e
   usada para conferir: se a soma das linhas não bater com ela, o arquivo veio
   truncado e a importação avisa em vez de gravar um mês pela metade.
"""
import io
from datetime import date, datetime, timezone
from typing import Optional

from openpyxl import load_workbook

from app.core.database import get_service_db

ABA = "Base de NF"

# As colunas como o BI as nomeia. Mudou o nome no BI? É aqui que se acerta, e
# a importação avisa qual faltou em vez de gravar a coluna vazia.
COL = {
    "empresa": "Empresa",
    "unidade_negocio": "Unidade de Negócio",
    "numero_fatura": "Número da fatura",
    "seq_item": "Nº seq. item fat.",
    "competencia": "Ano/Mês do faturamento",
    "data_faturamento": "Data do faturamento",
    "comissionado": "Comissionado",
    "vendedor": "Vendedor",
    "sales_vertical": "Sales Vertical",
    "paciente": "Paciente",
    "classificacao": "Classificação",
    "operacao": "Operação",
    "tipo_cliente": "Tipo de cliente",
    "cliente_codigo": "Cód. Cliente",
    "cliente_nome": "Cliente",
    "cliente_faturamento": "Cliente (Faturamento)",
    "uf": "Cód. Estado",
    "cidade": "Cidade",
    "familia": "Família",
    "produto_codigo": "Cód. produto",
    "produto_nome": "Produto",
    "valor": "Faturamento",
    "quantidade": "Faturamento (quantidade)",
    "preco": "Preço",
    "margem_frete": "Margem - Frete",
}
OBRIGATORIAS = ["numero_fatura", "seq_item", "valor", "quantidade"]

# Medido contra o cadastro de produtos do app em 16/11/2026, sem divergência.
# O BI separa mais fino que a meta: GENERAL SALES e PI & CI são duas verticais
# na mesma linha daqui.
VERTICAL_PARA_LINHA = {
    "UROLOGIA": "URO",
    "GENERAL SALES": "VASCULAR",
    "PI & CI": "VASCULAR",
    "REALCLOSURE": "REALCLOSURE",
}


def _txt(v) -> Optional[str]:
    t = ("" if v is None else str(v)).strip()
    return t or None


def _num(v) -> Optional[float]:
    if v in (None, ""):
        return None
    try:
        return float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None


def _data(v) -> Optional[str]:
    if isinstance(v, datetime):
        return v.date().isoformat()
    if isinstance(v, date):
        return v.isoformat()
    t = _txt(v)
    if not t:
        return None
    try:
        return datetime.fromisoformat(t.replace("Z", "+00:00")).date().isoformat()
    except ValueError:
        return None


def _eh_total(linha: dict) -> bool:
    """A linha de soma que o BI acrescenta no fim."""
    return str(linha.get("Empresa") or "").strip().upper().startswith("TOTAL")


def ler(conteudo: bytes) -> dict:
    """Lê o arquivo e devolve as linhas mapeadas, mais a linha de conferência."""
    wb = load_workbook(io.BytesIO(conteudo), read_only=True, data_only=True)
    ws = wb[ABA] if ABA in wb.sheetnames else wb.worksheets[0]
    brutas = list(ws.iter_rows(values_only=True))
    wb.close()
    if len(brutas) < 2:
        raise ValueError("A planilha está vazia.")

    cab = [str(c).strip() if c is not None else "" for c in brutas[0]]
    faltando = [nome for campo, nome in COL.items()
                if campo in OBRIGATORIAS and nome not in cab]
    if faltando:
        raise ValueError("A planilha não tem a(s) coluna(s): %s. "
                         "Confira se é a Base de Notas Fiscais do BI."
                         % ", ".join(faltando))

    dicts = [dict(zip(cab, r)) for r in brutas[1:]]
    total = next((d for d in dicts if _eh_total(d)), None)
    dados = [d for d in dicts if not _eh_total(d)
             and _txt(d.get(COL["numero_fatura"])) and _txt(d.get(COL["seq_item"]))]
    return {"dados": dados, "total": total, "colunas": cab}


def _mapear(d: dict) -> dict:
    v = {campo: d.get(nome) for campo, nome in COL.items()}
    vertical = (_txt(v["sales_vertical"]) or "").upper()
    return {
        "numero_fatura": _txt(v["numero_fatura"]),
        "seq_item": _txt(v["seq_item"]),
        "empresa": _txt(v["empresa"]),
        "unidade_negocio": _txt(v["unidade_negocio"]),
        "competencia": _txt(v["competencia"]),
        "data_faturamento": _data(v["data_faturamento"]),
        "comissionado": _txt(v["comissionado"]),
        "vendedor": _txt(v["vendedor"]),
        "sales_vertical": _txt(v["sales_vertical"]),
        "linha": VERTICAL_PARA_LINHA.get(vertical),
        "paciente": _txt(v["paciente"]),
        "classificacao": _txt(v["classificacao"]),
        "operacao": _txt(v["operacao"]),
        "tipo_cliente": _txt(v["tipo_cliente"]),
        "cliente_codigo": _txt(v["cliente_codigo"]),
        "cliente_nome": _txt(v["cliente_nome"]),
        "cliente_faturamento": _txt(v["cliente_faturamento"]),
        "uf": (_txt(v["uf"]) or "")[:2].upper() or None,
        "cidade": _txt(v["cidade"]),
        "familia": _txt(v["familia"]),
        "produto_codigo": _txt(v["produto_codigo"]),
        "produto_nome": _txt(v["produto_nome"]),
        "valor": _num(v["valor"]),
        "quantidade": _num(v["quantidade"]),
        "preco": _num(v["preco"]),
        "margem_frete": _num(v["margem_frete"]),
    }


def _conferir(linhas: list, total: Optional[dict]) -> dict:
    """A soma das linhas bate com a linha de TOTAL do arquivo?

    Sem esta conferência, um arquivo truncado entra calado e o mês fica com
    menos venda do que teve — e ninguém descobre até alguém comparar com o
    D365 na mão.
    """
    soma_v = round(sum(l["valor"] or 0 for l in linhas), 2)
    soma_q = round(sum(l["quantidade"] or 0 for l in linhas), 2)
    if not total:
        return {"tem_total": False, "bate": None, "soma_valor": soma_v,
                "soma_quantidade": soma_q,
                "aviso": "O arquivo não traz a linha de TOTAL do BI — não há "
                         "como conferir se ele veio inteiro."}
    tv = round(_num(total.get(COL["valor"])) or 0, 2)
    tq = round(_num(total.get(COL["quantidade"])) or 0, 2)
    bate = abs(soma_v - tv) < 0.02 and abs(soma_q - tq) < 0.01
    return {
        "tem_total": True, "bate": bate,
        "soma_valor": soma_v, "soma_quantidade": soma_q,
        "total_valor": tv, "total_quantidade": tq,
        "aviso": None if bate else (
            "A soma das linhas (R$ %.2f / %.0f un) não bate com o TOTAL do "
            "arquivo (R$ %.2f / %.0f un). O arquivo pode ter vindo truncado — "
            "nada foi gravado." % (soma_v, soma_q, tv, tq)),
    }


def previa(conteudo: bytes, arquivo: str = "") -> dict:
    return _rodar(conteudo, arquivo, gravar=False, usuario=None)


def importar(conteudo: bytes, arquivo: str = "", usuario=None) -> dict:
    return _rodar(conteudo, arquivo, gravar=True, usuario=usuario)


def _rodar(conteudo: bytes, arquivo: str, gravar: bool, usuario) -> dict:
    lido = ler(conteudo)
    linhas = [_mapear(d) for d in lido["dados"]]
    if not linhas:
        raise ValueError("Não encontrei nenhuma linha de item na planilha.")

    conferencia = _conferir(linhas, lido["total"])
    if conferencia.get("bate") is False:
        raise ValueError(conferencia["aviso"])

    db = get_service_db()

    # Liga ao cadastro de produtos pelo código. Produto que o app não conhece
    # não impede a carga — entra sem o vínculo e é relatado, porque a venda
    # aconteceu e esconder isso seria pior do que um cadastro incompleto.
    cods = sorted({l["produto_codigo"] for l in linhas if l["produto_codigo"]})
    prods = {}
    for i in range(0, len(cods), 40):
        try:
            for p in db.table("produtos").select("id, codigo").in_(
                    "codigo", cods[i:i + 40]).execute().data:
                prods[str(p["codigo"]).strip()] = p["id"]
        except Exception as exc:
            print("produtos indisponiveis: %s" % str(exc)[:140])
    sem_cadastro = sorted({l["produto_codigo"] for l in linhas
                           if l["produto_codigo"] and l["produto_codigo"] not in prods})
    sem_vertical = sorted({l["numero_fatura"] for l in linhas if not l["linha"]})

    if gravar:
        agora = datetime.now(timezone.utc).isoformat()
        for l in linhas:
            l["produto_id"] = prods.get(l["produto_codigo"])
            l["arquivo"] = arquivo or None
            l["importado_em"] = agora
            l["atualizado_em"] = agora
            if usuario is not None and getattr(usuario, "id", None):
                l["importado_por"] = str(usuario.id)
        for i in range(0, len(linhas), 300):
            db.table("notas_bi_itens").upsert(
                linhas[i:i + 300],
                on_conflict="numero_fatura,seq_item").execute()

    devol = [l for l in linhas if (l["valor"] or 0) < 0]
    competencias = sorted({l["competencia"] for l in linhas if l["competencia"]})
    return {
        "gravou": gravar,
        "arquivo": arquivo,
        "linhas": len(linhas),
        "notas": len({l["numero_fatura"] for l in linhas}),
        "produtos": len(cods),
        "competencias": competencias,
        "de": min((l["data_faturamento"] for l in linhas if l["data_faturamento"]), default=None),
        "ate": max((l["data_faturamento"] for l in linhas if l["data_faturamento"]), default=None),
        "conferencia": conferencia,
        "devolucoes": {"linhas": len(devol),
                       "valor": round(sum(l["valor"] or 0 for l in devol), 2)},
        "produtos_sem_cadastro": sem_cadastro,
        "notas_sem_vertical": sem_vertical,
        "vendedor_informado": sum(
            1 for l in linhas
            if l["vendedor"] and l["vendedor"].upper() not in
            ("SEM COMISSIONAMENTO", "SEM VENDEDOR")),
    }

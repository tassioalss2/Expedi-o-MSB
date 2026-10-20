# -*- coding: utf-8 -*-
"""A programação de coleta do dia, no modelo que a BRIX pediu.

Eles montam o carro a partir desta planilha, então ela vale mais do que a
mensagem avulsa no grupo: uma linha por nota, com o que decide o veículo e a
rota — agendamento, prazo, volume e valor.

O modelo veio deles (PROGRAMAÇÃO MSB.xlsx): título, cabeçalho em duas linhas
mescladas e as colunas Data · NF · Modalidade · Com agendamento · Prazo ·
Volume · Valor NF · Observações. Reproduzir o formato é o que permite colar no
grupo sem ninguém reformatar nada.
"""
import io
from datetime import date, datetime

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from app.core.database import get_service_db

AZUL = "1F3864"
CINZA = "F2F2F2"
_PRIORIDADE = {"CRITICA": "CRÍTICA", "ALTA": "ALTA", "NORMAL": "Normal"}


def _br_data(iso) -> str:
    t = str(iso or "")[:10]
    return "%s/%s/%s" % (t[8:10], t[5:7], t[0:4]) if len(t) == 10 else ""


def _br_data_hora(iso) -> str:
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        return d.strftime("%d/%m/%Y %H:%M")
    except Exception:
        return _br_data(iso)


def listar(dia: date, transportadora: str = "BRIX") -> list:
    """As cargas que saem: faturadas no dia, ou já faturadas e esperando coleta.

    As duas coisas de propósito — o que foi faturado hoje é o que entra no carro
    de hoje, e o que ficou de ontem sem coletar continua esperando. Programação
    que esquece a carga de ontem é a que deixa nota parada no estoque.
    """
    db = get_service_db()
    alvo = (transportadora or "").strip().upper()

    peds = db.table("pedidos").select(
        "id, numero_pedido, numero_nf, status, valor_nf, prioridade, forma_venda, "
        "local_entrega, data_faturamento, data_prevista_entrega, coleta_agendada_em, "
        "coleta_agendada_obs, observacoes, transportadora_id, clientes(nome), "
        "transportadoras(nome)"
    ).in_("status", ["FATURADO", "AGUARD_COLETA"]).limit(2000).execute().data

    saida = []
    for p in peds:
        nome_t = ((p.get("transportadoras") or {}).get("nome") or "").upper()
        if alvo and alvo not in nome_t:
            continue
        faturada_em = str(p.get("data_faturamento") or "")[:10]
        # Faturada hoje OU faturada antes e ainda não coletada.
        if faturada_em and faturada_em > dia.isoformat():
            continue
        saida.append(p)

    cub = {}
    if saida:
        ids = [p["id"] for p in saida]
        for i in range(0, len(ids), 40):
            for c in db.table("cubagem").select(
                    "pedido_id, num_caixas, peso_kg").in_(
                    "pedido_id", ids[i:i + 40]).execute().data:
                cub[c["pedido_id"]] = c

    linhas = []
    for p in saida:
        c = cub.get(p["id"]) or {}
        volume = ""
        if c.get("num_caixas"):
            volume = "%s vol" % c["num_caixas"]
            if c.get("peso_kg"):
                volume += " · %s kg" % str(c["peso_kg"]).replace(".", ",")
        obs = []
        pr = _PRIORIDADE.get(p.get("prioridade") or "", "")
        if pr and pr != "Normal":
            obs.append("PRIORIDADE %s" % pr)
        if p.get("coleta_agendada_obs"):
            obs.append(p["coleta_agendada_obs"])
        if p.get("observacoes"):
            obs.append(str(p["observacoes"])[:120])
        linhas.append({
            "data": _br_data(p.get("data_faturamento")) or _br_data(dia.isoformat()),
            "nf": p.get("numero_nf") or "",
            "ov": p.get("numero_pedido") or "",
            "cliente": (p.get("clientes") or {}).get("nome") or "",
            "destino": p.get("local_entrega") or "",
            "modalidade": ("LICITAÇÃO" if (p.get("forma_venda") or "") == "LICITACAO"
                           else "Distribuidor"),
            "agendamento": _br_data_hora(p.get("coleta_agendada_em")) or "NÃO",
            "prazo": _br_data(p.get("data_prevista_entrega")),
            "volume": volume,
            "valor_nf": float(p.get("valor_nf") or 0),
            "observacoes": " · ".join(obs),
            "sem_cubagem": not c.get("num_caixas"),
        })
    linhas.sort(key=lambda x: (x["agendamento"] == "NÃO", x["prazo"] or "9", x["nf"]))
    return linhas


def planilha(dia: date, transportadora: str = "BRIX") -> bytes:
    """O xlsx no formato que eles mandaram."""
    linhas = listar(dia, transportadora)

    wb = Workbook()
    ws = wb.active
    ws.title = "Programação"
    ws.sheet_view.showGridLines = False

    ws.merge_cells("B2:J2")
    t = ws["B2"]
    t.value = "PROGRAMAÇÃO DE COLETA"
    t.font = Font(bold=True, size=14, color="FFFFFF")
    t.fill = PatternFill("solid", fgColor=AZUL)
    t.alignment = Alignment(horizontal="center", vertical="center")
    ws.row_dimensions[2].height = 26

    ws["B3"] = "MSB Medical System do Brasil · %s · transportadora %s" % (
        dia.strftime("%d/%m/%Y"), transportadora)
    ws["B3"].font = Font(size=10, color="595959")

    cab = ["Data", "NF", "OV", "Cliente", "Destino", "Modalidade",
           "COM AGENDAMENTO", "Prazo", "Volume", "Valor NF", "Observações"]
    borda = Border(*[Side(style="thin", color="BFBFBF")] * 4)
    for j, nome in enumerate(cab, start=2):
        c = ws.cell(row=5, column=j, value=nome)
        c.font = Font(bold=True, color="FFFFFF", size=10)
        c.fill = PatternFill("solid", fgColor=AZUL)
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        c.border = borda
    ws.row_dimensions[5].height = 30

    r = 6
    for l in linhas:
        vals = [l["data"], l["nf"], l["ov"], l["cliente"][:46], l["destino"],
                l["modalidade"], l["agendamento"], l["prazo"], l["volume"],
                l["valor_nf"], l["observacoes"]]
        for j, v in enumerate(vals, start=2):
            c = ws.cell(row=r, column=j, value=v)
            c.border = borda
            c.font = Font(size=10)
            c.alignment = Alignment(vertical="center",
                                    wrap_text=(j in (5, 6, 12)),
                                    horizontal="center" if j in (2, 7, 8, 9) else "left")
        ws.cell(row=r, column=11).number_format = 'R$ #,##0.00'
        # Agendamento e prioridade são o que muda a rota do carro: ficam em cor.
        if l["agendamento"] != "NÃO":
            cel = ws.cell(row=r, column=8)
            cel.fill = PatternFill("solid", fgColor="FFF2CC")
            cel.font = Font(size=10, bold=True, color="7F6000")
        if "PRIORIDADE" in (l["observacoes"] or ""):
            ws.cell(row=r, column=12).font = Font(size=10, bold=True, color="C00000")
        if l["sem_cubagem"]:
            ws.cell(row=r, column=10).value = "a cubar"
            ws.cell(row=r, column=10).font = Font(size=10, italic=True, color="BF8F00")
        if r % 2 == 0:
            for j in range(2, 13):
                if not ws.cell(row=r, column=j).fill.fgColor.rgb or \
                        ws.cell(row=r, column=j).fill.fgColor.rgb == "00000000":
                    ws.cell(row=r, column=j).fill = PatternFill("solid", fgColor=CINZA)
        r += 1

    if linhas:
        ws.cell(row=r, column=10, value="TOTAL").font = Font(bold=True)
        tot = ws.cell(row=r, column=11, value=sum(l["valor_nf"] for l in linhas))
        tot.number_format = 'R$ #,##0.00'
        tot.font = Font(bold=True)
        ws.cell(row=r, column=3, value="%d nota(s)" % len(linhas)).font = Font(bold=True)
    else:
        ws.cell(row=6, column=2, value="Nenhuma carga para coletar neste dia.").font = \
            Font(size=10, italic=True, color="808080")

    for j, w in enumerate([11, 12, 12, 34, 24, 15, 19, 12, 18, 14, 42], start=2):
        ws.column_dimensions[get_column_letter(j)].width = w
    ws.freeze_panes = "B6"

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()

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
from datetime import date, datetime, timedelta, timezone

from openpyxl import Workbook
from openpyxl.styles import Alignment, Border, Font, PatternFill, Side
from openpyxl.utils import get_column_letter

from app.core.database import get_service_db

AZUL = "1F3864"
CINZA = "F2F2F2"
_PRIORIDADE = {"CRITICA": "CRÍTICA", "ALTA": "ALTA", "NORMAL": "Normal"}


def modalidade(destino_local: str, prazo_cliente, saida: date,
               tipo_frete: str = "") -> tuple:
    """Convencional ou Expressa — a pergunta é se o prazo da tabela dá conta.

    A tabela da BRIX promete, por destino, um prazo em dias úteis. Se o cliente
    espera a carga antes disso, o convencional não chega: a carga tem de ir
    como expressa, que é cotada à parte. Essa é a decisão que eles precisam ver
    na planilha — pela programação é que montam o carro.

    Sem data prometida ao cliente ou com destino fora da tabela, não dá para
    afirmar nem um nem outro: devolve "a definir" em vez de chutar convencional
    e deixar a carga atrasar calada.

    No FOB a escolha não é nossa: quem contratou o frete foi o cliente, e a
    expressa que a planilha sugeriria seria conta dele. A carga continua na
    programação — a transportadora vem buscar no nosso dock do mesmo jeito —
    mas sem palpite de modalidade.
    """
    from app.services import tabela_frete_service
    from app.services.home_service import _dias_uteis

    if (tipo_frete or "").upper().startswith("FOB"):
        return "FOB — CLIENTE", "frete contratado pelo cliente — não é custo nosso"

    local = (destino_local or "").strip()
    cidade = uf = None
    if "/" in local:
        cidade, uf = local.rsplit("/", 1)
        cidade, uf = cidade.strip(), uf.strip().upper()[:2]
    if not uf:
        return "A DEFINIR", "sem destino na OV"

    est = tabela_frete_service.estimar(uf, cidade)
    if not est.get("encontrado"):
        return "A DEFINIR", "destino fora da tabela — cotar"
    # Cidade do interior: o prazo que vale é o do redespacho, não o da capital.
    prazo_tabela = (est.get("prazo_redespacho") if est.get("por_capital")
                    else est.get("prazo_capital")) or 0

    if not prazo_cliente:
        return "CONVENCIONAL", "sem prazo do cliente — tabela entrega em %d dia(s) útil(eis)" % prazo_tabela

    try:
        alvo = date.fromisoformat(str(prazo_cliente)[:10])
    except Exception:
        return "A DEFINIR", "prazo do cliente ilegível"

    # O prazo da tabela conta a partir da COLETA (confirmado com a BRIX em
    # 20/10/2026), então o dia da coleta entra na conta.
    disponivel = _dias_uteis(saida, alvo)
    if disponivel >= prazo_tabela:
        return "CONVENCIONAL", "tabela: %d dia(s) · disponível: %d" % (prazo_tabela, disponivel)
    return "EXPRESSA", "tabela: %d dia(s) · disponível: %d — convencional não chega" % (
        prazo_tabela, disponivel)


def _hoje_brt() -> date:
    """O servidor roda em UTC. Depois das 21h de Brasília `date.today()` já é o
    dia seguinte lá, e a programação "de hoje" viraria a de amanhã — justo no
    horário em que alguém ainda está fechando o carro."""
    return (datetime.now(timezone.utc) - timedelta(hours=3)).date()


def _br_data(iso) -> str:
    t = str(iso or "")[:10]
    return "%s/%s/%s" % (t[8:10], t[5:7], t[0:4]) if len(t) == 10 else ""


def _hora_brt(iso) -> str:
    """Só a hora, já em Brasília — o banco grava tudo em UTC."""
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        if d.tzinfo:
            d = d.astimezone(timezone(timedelta(hours=-3)))
        return d.strftime("%Hh%M")
    except Exception:
        return ""


def _br_data_hora(iso) -> str:
    if not iso:
        return ""
    try:
        d = datetime.fromisoformat(str(iso).replace("Z", "+00:00"))
        return d.strftime("%d/%m/%Y %H:%M")
    except Exception:
        return _br_data(iso)


_RE_AGENDA = __import__("re").compile(
    r"agend(a|ar|ada|ado|amento|e|ando)", __import__("re").IGNORECASE)
_RE_NAO_AGENDA = __import__("re").compile(
    r"(sem|nao|não|dispensa|desnecessari|desnecessári)[^.;]{0,40}agend",
    __import__("re").IGNORECASE)


def pede_agendamento(texto) -> bool:
    """O cliente exige agendar a entrega, ou só informou como entregar?

    Ter instruções de entrega não é agendamento: a maioria dos hospitais manda
    endereço, portão, horário de recebimento e telefone, e a carga chega sem
    marcar nada. Só é agendamento quando o próprio texto pede — "precisa ser
    agendada", "com agendamento prévio", o link de agendamento da EBSERH.

    Marcar tudo como "A AGENDAR" fazia a transportadora ligar para cliente que
    não pede ligação, e enchia a coluna de ruído até ninguém mais olhar para
    ela (apontado pelo Tássio em 22/10/2026).
    """
    t = str(texto or "")
    if not t.strip() or not _RE_AGENDA.search(t):
        return False
    # "sem necessidade de agendamento" fala de agendamento para dizer que não há.
    return not _RE_NAO_AGENDA.search(t)


_CAMPOS = (
    "id, numero_pedido, numero_nf, status, valor_nf, prioridade, forma_venda, "
    "tipo_frete, "
    "local_entrega, data_faturamento, data_prevista_entrega, coleta_agendada_em, "
    "coleta_agendada_obs, observacoes, transportadora_id, clientes(nome), "
    "transportadoras(nome)"
)


def listar(dia: date, transportadora: str = "BRIX") -> list:
    """As cargas do dia, para conferir antes de mandar para a transportadora.

    HOJE e um dia PASSADO são perguntas diferentes, e por isso a busca é outra:

      · hoje é "o que está esperando o carro" — tudo em FATURADO ou
        AGUARD_COLETA, inclusive a carga de ontem que não foi coletada.
        Programação que esquece a carga de ontem deixa nota parada no estoque;
      · um dia passado é "o que saiu naquele dia", e aí o status de agora não
        serve: a carga de ontem já está EXPEDIDO, e a lista voltava VAZIA. Para
        trás a pergunta se responde pelo faturamento daquele dia, que não muda
        depois.

    Em qualquer um dos dois entra também o que o carro JÁ LEVOU no dia. Quando
    a transportadora passa mais de uma vez, a planilha da segunda viagem sem as
    notas da manhã parece um dia menor do que foi, e ninguém consegue conferir
    o que já saiu contra o que ainda está no dock (pedido do Tássio em
    30/10/2026). A carga coletada vai marcada, não misturada com a que espera.

    A reconstrução do dia passado tem um limite honesto: ela lista o que foi
    FATURADO naquele dia. O que já estava esperando desde antes não dá para
    recuperar — o app guarda o status de agora, não o de ontem.
    """
    db = get_service_db()
    alvo = (transportadora or "").strip().upper()
    passado = dia < _hoje_brt()

    if passado:
        peds = db.table("pedidos").select(_CAMPOS)\
            .gte("data_faturamento", dia.isoformat())\
            .lte("data_faturamento", dia.isoformat() + "T23:59:59")\
            .neq("status", "CANCELADO").limit(2000).execute().data
    else:
        peds = db.table("pedidos").select(_CAMPOS)\
            .in_("status", ["FATURADO", "AGUARD_COLETA"]).limit(2000).execute().data

    # O que o carro já levou no dia. A fonte é a coleta registrada no app, não
    # o status: `coletas.data_real` é a data que o operador informou como a da
    # coleta de verdade, e não se mexe depois.
    # A janela é a do dia de Brasília, não a do dia UTC: o banco grava em UTC,
    # e uma coleta das 22h daqui já é o dia seguinte lá.
    ja_saiu = {}
    for c in db.table("coletas").select(
            "pedido_id, data_real, protocolo, motorista, placa")\
            .gte("data_real", dia.isoformat() + "T03:00:00")\
            .lte("data_real", (dia + timedelta(days=1)).isoformat() + "T02:59:59")\
            .limit(2000).execute().data:
        pid = c.get("pedido_id")
        if pid and str(c.get("data_real") or "") >= str(
                (ja_saiu.get(pid) or {}).get("data_real") or ""):
            ja_saiu[pid] = c

    vistos = {p["id"] for p in peds}
    faltam = [pid for pid in ja_saiu if pid not in vistos]
    for i in range(0, len(faltam), 40):
        peds += db.table("pedidos").select(_CAMPOS)\
            .in_("id", faltam[i:i + 40]).execute().data

    saida = []
    for p in peds:
        nome_t = ((p.get("transportadoras") or {}).get("nome") or "").upper()
        if alvo and alvo not in nome_t:
            continue
        faturada_em = str(p.get("data_faturamento") or "")[:10]
        # Faturada hoje OU faturada antes e ainda não coletada.
        if not passado and faturada_em and faturada_em > dia.isoformat():
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
        # Só o que o motorista e a torre da transportadora precisam saber:
        # urgência, como entregar e por que a carga é expressa. A observação
        # interna da OV NÃO entra — "liberado acima do estoque da última foto"
        # é conversa nossa, e enche a coluna de ruído que ninguém lê.
        obs = []
        pr = _PRIORIDADE.get(p.get("prioridade") or "", "")
        if pr and pr != "Normal":
            obs.append("PRIORIDADE %s" % pr)
        if p.get("coleta_agendada_obs"):
            obs.append(p["coleta_agendada_obs"])
        modo, porque = modalidade(p.get("local_entrega"),
                                  p.get("data_prevista_entrega"), dia,
                                  p.get("tipo_frete"))
        if modo == "EXPRESSA":
            obs.insert(0, "EXPRESSA — %s" % porque)
        col = ja_saiu.get(p["id"])
        if col:
            # A hora diz qual viagem levou a carga — é o que permite conferir a
            # segunda passagem do dia contra a primeira.
            marca = ("JÁ COLETADA %s" % _hora_brt(col.get("data_real"))).strip()
            quem = " · ".join(x for x in (col.get("placa"), col.get("motorista"))
                              if x)
            if col.get("protocolo"):
                quem = (quem + " · prot. " + col["protocolo"]).strip(" ·")
            if quem:
                obs.append("Coletada nesta data: %s" % quem)
        else:
            # Num dia passado "aguarda coleta" seria mentira: a carga já saiu,
            # só não naquele dia. O que a planilha pode afirmar é isso.
            marca = "NÃO COLETADA NO DIA" if passado else "AGUARDA COLETA"
        linhas.append({
            "situacao": marca,
            "ja_coletada": bool(col),
            "data": _br_data(p.get("data_faturamento")) or _br_data(dia.isoformat()),
            "nf": p.get("numero_nf") or "",
            "ov": p.get("numero_pedido") or "",
            "cliente": (p.get("clientes") or {}).get("nome") or "",
            "destino": p.get("local_entrega") or "",
            # Serviço contratado, não tipo de venda: é o que decide se a carga
            # cabe no prazo da tabela ou precisa de expressa, cotada à parte.
            "modalidade": modo,
            "modalidade_porque": porque,
            "tipo_venda": ("LICITAÇÃO" if (p.get("forma_venda") or "") == "LICITACAO"
                           else "Distribuidor"),
            # Três estados, não dois: marcado, a marcar pela transportadora
            # (temos as instruções) e sem agendamento nenhum.
            "agendamento": (_br_data_hora(p.get("coleta_agendada_em"))
                            or ("A AGENDAR" if pede_agendamento(p.get("coleta_agendada_obs"))
                                else "NÃO")),
            "prazo": _br_data(p.get("data_prevista_entrega")),
            "volume": volume,
            "valor_nf": float(p.get("valor_nf") or 0),
            "observacoes": " · ".join(obs),
            "sem_cubagem": not c.get("num_caixas"),
        })
    # O que ainda espera o carro vem primeiro — é o que a transportadora tem de
    # fazer hoje. O que já saiu fica embaixo, para conferência.
    # Depois: expressa primeiro porque muda a decisão do carro; agendada em
    # seguida; FOB por último porque a modalidade ali não é escolha nossa.
    linhas.sort(key=lambda x: (x["ja_coletada"],
                               x["modalidade"].startswith("FOB"),
                               x["modalidade"] != "EXPRESSA",
                               x["agendamento"] == "NÃO", x["prazo"] or "9", x["nf"]))
    # As instruções de entrega são para o motorista: vão inteiras, não cortadas.
    for l in linhas:
        if l["agendamento"] == "A AGENDAR":
            l["observacoes"] = ("AGENDAR COM O CLIENTE · " + l["observacoes"]).strip(" ·")
    return linhas


def planilha(dia: date, transportadora: str = "BRIX") -> bytes:
    """O xlsx no formato que eles mandaram."""
    linhas = listar(dia, transportadora)

    wb = Workbook()
    ws = wb.active
    ws.title = "Programação"
    ws.sheet_view.showGridLines = False

    ws.merge_cells("B2:N2")
    t = ws["B2"]
    t.value = "PROGRAMAÇÃO DE COLETA"
    t.font = Font(bold=True, size=14, color="FFFFFF")
    t.fill = PatternFill("solid", fgColor=AZUL)
    t.alignment = Alignment(horizontal="center", vertical="center")
    ws.row_dimensions[2].height = 26

    espera = [l for l in linhas if not l["ja_coletada"]]
    coletadas = [l for l in linhas if l["ja_coletada"]]
    # Num dia passado a planilha não pede coleta nenhuma: ela reconstrói o dia.
    pedindo = any(l["situacao"] == "AGUARDA COLETA" for l in espera)
    rotulo_total = "TOTAL A COLETAR" if pedindo else "TOTAL"
    resumo = "MSB Medical System do Brasil · %s · transportadora %s" % (
        dia.strftime("%d/%m/%Y"), transportadora)
    if coletadas:
        # A segunda viagem do dia precisa saber o que sobrou, não o total.
        resumo += " · %d nota(s) %s · %d já coletada(s) nesta data" % (
            len(espera), "a coletar" if pedindo else "não coletada(s) no dia",
            len(coletadas))
    ws["B3"] = resumo
    ws["B3"].font = Font(size=10, color="595959")

    cab = ["Data", "Situação", "NF", "OV", "Cliente", "Destino", "Modalidade",
           "Tipo de venda", "COM AGENDAMENTO", "Prazo", "Volume", "Valor NF",
           "Observações"]
    COL = {nome: j for j, nome in enumerate(cab, start=2)}
    borda = Border(*[Side(style="thin", color="BFBFBF")] * 4)
    for j, nome in enumerate(cab, start=2):
        c = ws.cell(row=5, column=j, value=nome)
        c.font = Font(bold=True, color="FFFFFF", size=10)
        c.fill = PatternFill("solid", fgColor=AZUL)
        c.alignment = Alignment(horizontal="center", vertical="center", wrap_text=True)
        c.border = borda
    ws.row_dimensions[5].height = 30

    centrada = (COL["Data"], COL["Situação"], COL["Modalidade"],
                COL["Tipo de venda"], COL["COM AGENDAMENTO"], COL["Prazo"])
    quebra = (COL["Cliente"], COL["Destino"], COL["Observações"])

    r = 6
    for l in linhas:
        vals = [l["data"], l["situacao"], l["nf"], l["ov"], l["cliente"][:46],
                l["destino"], l["modalidade"], l["tipo_venda"], l["agendamento"],
                l["prazo"], l["volume"], l["valor_nf"], l["observacoes"]]
        # A carga que já saiu está ali para conferência, não para ser carregada:
        # fica cinza e em itálico, para o olho não confundir com o que espera.
        base = (Font(size=10, italic=True, color="808080") if l["ja_coletada"]
                else Font(size=10))
        for j, v in enumerate(vals, start=2):
            c = ws.cell(row=r, column=j, value=v)
            c.border = borda
            c.font = base
            c.alignment = Alignment(vertical="center",
                                    wrap_text=(j in quebra),
                                    horizontal="center" if j in centrada else "left")
        ws.cell(row=r, column=COL["Valor NF"]).number_format = 'R$ #,##0.00'
        cel = ws.cell(row=r, column=COL["Situação"])
        if l["ja_coletada"]:
            cel.fill = PatternFill("solid", fgColor="E2EFDA")
            cel.font = Font(size=10, bold=True, color="375623")
        else:
            cel.font = Font(size=10, bold=True, color="1F3864")
        if l["ja_coletada"]:
            # O resto do destaque abaixo é para decidir o carro; nada disso vale
            # para carga que já foi embora.
            r += 1
            continue
        # Agendamento e prioridade são o que muda a rota do carro: ficam em cor.
        if l["agendamento"] != "NÃO":
            cel = ws.cell(row=r, column=COL["COM AGENDAMENTO"])
            cel.fill = PatternFill("solid", fgColor="FFF2CC")
            cel.font = Font(size=10, bold=True, color="7F6000")
        if "PRIORIDADE" in (l["observacoes"] or ""):
            ws.cell(row=r, column=COL["Observações"]).font = \
                Font(size=10, bold=True, color="C00000")
        # Expressa é a exceção cara: tem de saltar aos olhos de quem monta o carro.
        if l["modalidade"] == "EXPRESSA":
            cel = ws.cell(row=r, column=COL["Modalidade"])
            cel.fill = PatternFill("solid", fgColor="FFC7CE")
            cel.font = Font(size=10, bold=True, color="9C0006")
        elif l["modalidade"] == "A DEFINIR":
            ws.cell(row=r, column=COL["Modalidade"]).font = \
                Font(size=10, italic=True, color="BF8F00")
        elif l["modalidade"].startswith("FOB"):
            # Apagada de propósito: a carga está na lista para ser coletada,
            # mas a modalidade é decisão de quem paga, e não somos nós.
            ws.cell(row=r, column=COL["Modalidade"]).font = \
                Font(size=10, italic=True, color="808080")
        if l["sem_cubagem"]:
            ws.cell(row=r, column=COL["Volume"]).value = "a cubar"
            ws.cell(row=r, column=COL["Volume"]).font = \
                Font(size=10, italic=True, color="BF8F00")
        if r % 2 == 0:
            for j in range(2, 2 + len(cab)):
                if not ws.cell(row=r, column=j).fill.fgColor.rgb or \
                        ws.cell(row=r, column=j).fill.fgColor.rgb == "00000000":
                    ws.cell(row=r, column=j).fill = PatternFill("solid", fgColor=CINZA)
        r += 1

    if linhas:
        # O total que interessa ao carro é o do que ainda espera. O que já saiu
        # vai somado à parte, na linha de baixo, para conferir o dia inteiro.
        if espera:
            ws.cell(row=r, column=COL["Volume"], value=rotulo_total).font = Font(bold=True)
            tot = ws.cell(row=r, column=COL["Valor NF"],
                          value=sum(l["valor_nf"] for l in espera))
            tot.number_format = 'R$ #,##0.00'
            tot.font = Font(bold=True)
            ws.cell(row=r, column=COL["NF"],
                    value="%d nota(s)" % len(espera)).font = Font(bold=True)
        if coletadas:
            if espera:
                r += 1
            cinza = Font(bold=True, size=10, color="808080")
            ws.cell(row=r, column=COL["Volume"], value="JÁ COLETADAS").font = cinza
            tot = ws.cell(row=r, column=COL["Valor NF"],
                          value=sum(l["valor_nf"] for l in coletadas))
            tot.number_format = 'R$ #,##0.00'
            tot.font = cinza
            ws.cell(row=r, column=COL["NF"],
                    value="%d nota(s)" % len(coletadas)).font = cinza
    else:
        ws.cell(row=6, column=2, value="Nenhuma carga para coletar neste dia.").font = \
            Font(size=10, italic=True, color="808080")

    for j, w in enumerate([11, 17, 12, 12, 32, 22, 14, 14, 19, 12, 17, 14, 44],
                          start=2):
        ws.column_dimensions[get_column_letter(j)].width = w
    ws.freeze_panes = "B6"

    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()

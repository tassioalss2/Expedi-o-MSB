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
from app.models.enums import OPERACOES_FATURAMENTO, conta_faturamento
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
    "emissor":         ["emissor da nota fiscal", "emissor"],
}

OBRIGATORIAS = ("numero", "data_documento", "valor_total")

# Sem estas o arquivo até importa, mas não serve para o que foi feito. A
# primeira é a que decide se a nota é VENDA — sem ela nenhuma nota entra no
# faturamento e a tela fica vazia sem dizer por quê, que foi o que aconteceu no
# export de 20/10/2026.
RECOMENDADAS = {
    "operacao": ("Descrição da operação", "sem ela não dá para separar venda de "
                 "remessa, amostra ou compra — nenhuma nota entra no faturamento"),
    "valor_produtos": ("Valor total de produtos", "sem ela o frete embutido na nota "
                       "entra como venda"),
}


def _mapear_colunas(df: pd.DataFrame) -> dict:
    achadas = {}
    disponiveis = {_sem_acento(c): c for c in df.columns}
    for campo, nomes in COLUNAS.items():
        for n in nomes:
            if n in disponiveis:
                achadas[campo] = disponiveis[n]
                break
    return achadas


def _so_digitos(v) -> str:
    return "".join(c for c in str(v or "") if c.isdigit())


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
    # "Remessa merc consignação mercantil" é o material SAINDO para o cliente,
    # não a venda dele. A regra de baixo pegava as duas pelo "consignacao
    # mercantil" e três remessas entraram como faturamento em outubro, R$ 18 mil
    # de receita que não existia. A venda vem depois, no comunicado de uso.
    ("remessa merc consignacao",      ("CONSIGNADO",     "LICITACAO")),
    ("remessa em consignacao",        ("CONSIGNADO",     "LICITACAO")),
    ("consignacao mercantil",         ("COMUNICADO_USO", "LICITACAO")),
    ("venda de producao do estabelecimento", ("VENDA_NORMAL", "COMERCIAL")),
    ("venda de mercadoria adquirida", ("VENDA_NORMAL",   "COMERCIAL")),
    # O D365 escreve a mesma operacao abreviada em algumas notas ("Venda merc
    # adquirida ou receb terceiros"), e "mercadoria" por extenso nao casa com
    # "merc". Casou com nada, e a NF 21335 (MEDINTERP, R$ 50.000) ficou pedindo
    # classificacao todo mes. Nao da para encurtar para "adquirida" sozinho:
    # "Devolucao de venda de merc adquirida" tem a mesma palavra e viraria
    # receita, porque esta regra e testada antes das de devolucao.
    ("venda merc adquirida",          ("VENDA_NORMAL",   "COMERCIAL")),
    ("exportacao",                    ("EXPORTACAO",     "COMERCIAL")),
    # As de baixo não são receita. Vêm do export sem filtro (o livro fiscal
    # inteiro) e precisam de nome para não caírem em "a classificar" todo mês.
    # Amostra e bonificação vêm ANTES de "remessa": as duas se chamam
    # "Remessa amostra grátis" e "Remessa bonificação, doação ou brinde", e
    # quem casasse com "remessa" primeiro apagaria a natureza delas.
    ("amostra",                       ("AMOSTRA",            None)),
    ("bonificacao",                   ("BONIFICACAO_DOACAO", None)),
    ("doacao",                        ("BONIFICACAO_DOACAO", None)),
    ("brinde",                        ("BONIFICACAO_DOACAO", None)),
    ("comodato",                      ("COMODATO",           None)),
    # Devolucao SIMBOLICA nao e venda desfeita: e o acerto fiscal do material
    # que estava em consignacao e foi usado — anda junto com o comunicado de
    # uso, nos mesmos clientes. Somada as devolucoes de verdade, ela inflava o
    # estorno de outubro de R$ 20.033,60 para R$ 32.379,71. Vem antes das
    # outras para nao ser capturada por elas.
    ("dev simb",                      ("DEVOLUCAO_SIMBOLICA", None)),
    ("devolucao",                     ("DEVOLUCAO",      None)),
    ("dev venda",                     ("DEVOLUCAO",      None)),
    ("remessa",                       ("REMESSA",        None)),
    ("ret merc",                      ("RETORNO",        None)),
    ("compra",                        ("COMPRA",         None)),
    ("aquis",                         ("COMPRA",         None)),
    ("ent bem",                       ("ENTRADA",        None)),
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


def classificar_na_leitura(notas: list) -> list:
    """Aplica o mapa às notas que foram importadas antes de ele aprender.

    A classificação acontece na importação e fica gravada. Então, toda vez que
    eu ensino uma operação nova ao app, as notas que já estão no espelho
    continuam pedindo classificação até alguém reimportar o mês — e ninguém
    reimporta um mês fechado só por causa disso. Aqui a tradução vale na hora
    da leitura, sem escrever nada: o espelho continua sendo o que o D365 disse.
    """
    for n in notas:
        if not n.get("tipo_operacao") and n.get("operacao"):
            tipo, origem = classificar(n.get("operacao"))
            if tipo:
                n["tipo_operacao"] = tipo
                n["origem_venda"] = n.get("origem_venda") or origem
    return notas


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
        # Tudo como TEXTO. O pandas transformava "000021124" em 21124 e a chave
        # de acesso de 44 dígitos em 2.926e+43 — número de nota é identificador,
        # não quantidade. Data e valor são convertidos aqui embaixo, na mão.
        if nome_arquivo.lower().endswith(".csv"):
            df = pd.read_csv(io.BytesIO(conteudo), sep=";", dtype=str)
        else:
            df = pd.read_excel(io.BytesIO(conteudo), dtype=str)
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

    # Coluna que falta e muda o resultado: avisa ALTO, porque o arquivo importa
    # bonito e a tela fica vazia depois — o erro só aparece onde ninguém liga
    # com a importação.
    avisos = ["Faltou a coluna \"%s\" no export: %s." % RECOMENDADAS[c]
              for c in RECOMENDADAS if c not in col]

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
        serie = _txt(r[col["serie"]]) if "serie" in col else None
        cnpj = _txt(r[col["cnpj"]]) if "cnpj" in col else None
        direcao = _txt(r[col["direcao"]]) if "direcao" in col else None
        status = _txt(r[col["status"]]) if "status" in col else None
        emissor = _txt(r[col["emissor"]]) if "emissor" in col else None
        # A nota de ENTRADA é numerada pelo fornecedor: o número sozinho não
        # identifica nada. O CNPJ e a direção entram na chave; o status fica
        # fora dela, para a reimportação substituir a versão anterior.
        # Só ASCII, sem vírgula e sem espaço: esta chave viaja na URL do
        # PostgREST num filtro `in.(…)`, e acento ou vírgula ali quebra a
        # consulta de um jeito difícil de enxergar.
        chave_nota = "-".join([
            _sem_acento(direcao) or "x", chave or numero, _so_digitos(serie),
            _so_digitos(cnpj) or _sem_acento(conta).replace("-", "") or "x"])
        linhas.append({
            "numero": numero,
            "serie": serie,
            "estabelecimento": _txt(r[col["estabelecimento"]]) if "estabelecimento" in col else None,
            "chave_numero": chave,
            "chave_nota": chave_nota,
            "identidade": chave_nota + "-" + (_sem_acento(status) or "x"),
            "emissor": emissor,
            "modelo": _txt(r[col["modelo"]]) if "modelo" in col else None,
            "finalidade": _txt(r[col["finalidade"]]) if "finalidade" in col else None,
            "status": status,
            "direcao": direcao,
            "cliente_conta": conta,
            "cliente_nome": _txt(r[col["cliente_nome"]]) if "cliente_nome" in col else None,
            "cnpj": cnpj,
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
            # Sempre presente, mesmo falso. O PostgREST recusa a gravação em
            # lote quando os objetos não têm exatamente as mesmas chaves
            # ("All object keys must match"), e esta era acrescentada só nas
            # notas que tinham linha corrigida à mão. Enquanto ninguém corrigia
            # nenhuma, todos os objetos eram iguais e o defeito não aparecia;
            # bastou existir UMA correção para a gravação inteira ser recusada.
            "linha_ajustada": False,
            "chave_acesso": _txt(r[col["chave_acesso"]]) if "chave_acesso" in col else None,
            "pedido_id": ovs.get(chave),
            "arquivo": nome_arquivo,
            "importado_por": str(usuario.id),
        })

    if not linhas:
        return {"erro": "O arquivo não tem nenhuma nota.", "importadas": 0}

    # Regrava as notas deste arquivo. Nenhuma nota fora do arquivo é tocada.
    #
    # A ORDEM aqui não é detalhe: GRAVA primeiro, APAGA depois.
    #
    # Antes era o contrário — apagava todas as chaves do arquivo e só então
    # inseria. Entre as duas coisas o espelho ficava vazio, e qualquer soluço
    # na inserção (rede, timeout, uma linha recusada) deixava assim: como o
    # export é o livro fiscal inteiro, "todas as chaves do arquivo" é tudo. Foi
    # o que aconteceu em 29/10/2026 — a tabela zerou, o faturamento do painel
    # perdeu o que não vinha de OV e as devoluções sumiram das metas.
    #
    # Agora o upsert por `identidade` reescreve cada nota no lugar, então em
    # nenhum instante a nota deixa de existir. Se algo falhar no meio, o que
    # sobra é o espelho antigo misturado com o novo — e esse é o lado certo de
    # falhar: dado a mais se conserta reimportando, dado a menos ninguém vê.
    #
    # A linha corrigida à mão sobrevive: é a única informação do espelho que não
    # vem do D365, e perdê-la a cada reimportação faria o operador corrigir a
    # mesma nota todo dia.
    chaves = sorted({l["chave_nota"] for l in linhas})
    ajustadas: dict = {}
    existentes: dict = {}          # chave_nota -> {identidades no banco}
    for i in range(0, len(chaves), 40):
        lote = chaves[i:i + 40]
        for n in db.table("notas_d365").select(
                "chave_nota, identidade, linha, linha_ajustada"
        ).in_("chave_nota", lote).execute().data:
            if n.get("linha_ajustada"):
                ajustadas[n["chave_nota"]] = n.get("linha")
            existentes.setdefault(n["chave_nota"], set()).add(n.get("identidade"))

    for l in linhas:
        if l["chave_nota"] in ajustadas:
            l["linha"] = ajustadas[l["chave_nota"]]
            l["linha_ajustada"] = True

    for i in range(0, len(linhas), 200):
        db.table("notas_d365").upsert(linhas[i:i + 200], on_conflict="identidade").execute()

    # Só agora o que sobrou: a versão antiga de uma nota cujo status mudou (a
    # aprovada que virou cancelada), que tem a mesma chave e outra identidade.
    no_arquivo = {l["identidade"] for l in linhas}
    obsoletas = sorted({ident for chave, idents in existentes.items()
                        for ident in idents
                        if ident and ident not in no_arquivo})
    for i in range(0, len(obsoletas), 40):
        db.table("notas_d365").delete().in_("identidade", obsoletas[i:i + 40]).execute()

    datas = [l["data_documento"] for l in linhas if l["data_documento"]]
    # O export traz as canceladas, e ainda bem: é assim que uma nota que morreu
    # depois de importada some do faturamento sem ninguém avisar o app. Elas
    # entram no espelho (o registro é a verdade do D365) e ficam fora da conta.
    saidas = [l for l in linhas if _vale_como_faturamento(l)]
    return {
        "importadas": len(linhas),
        "avisos": avisos,
        # Sem natureza nenhuma classificada o espelho nao serve para faturamento:
        # a tela precisa dizer isso em vez de parecer que nada foi importado.
        "sem_classificacao": sum(1 for l in saidas if _eh_receita(l)) == 0,
        "canceladas": sum(1 for l in linhas if not _aprovada(l)),
        "periodo_ini": min(datas) if datas else None,
        "periodo_fim": max(datas) if datas else None,
        # Transfer price (Biomedical) fica fora do faturamento, aqui como em
        # todo o resto do app.
        "valor_total": round(sum(valor_da_nota(l) for l in saidas
                                 if _eh_receita(l)
                                 and not eh_transfer_price(l.get("cliente_nome"))), 2),
        "valor_transfer": round(sum(valor_da_nota(l) for l in saidas
                                    if _eh_receita(l)
                                    and eh_transfer_price(l.get("cliente_nome"))), 2),
        "com_ov": sum(1 for l in linhas if l["pedido_id"]),
        "sem_ov": sum(1 for l in linhas if not l["pedido_id"]),
        "operacoes_sem_classificacao": [
            {"operacao": k, "qtd": v} for k, v in sorted(
                sem_classificacao.items(), key=lambda x: -x[1])],
        "por_tipo": _agrupar_por_tipo(
            [l for l in saidas if not eh_transfer_price(l.get("cliente_nome"))]),
    }


def valor_da_ov(pedido: dict) -> float:
    """O faturamento da OV sem o frete, igual ao Painel Comercial.

    O `valor_nf` é a nota inteira; quando o frete vai embutido nela, o painel
    conta `valor_produtos`. Comparar o total daqui com os produtos do D365
    acusaria divergência onde só há frete.
    """
    v = pedido.get("valor_produtos")
    try:
        v = float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        v = 0.0
    return v if v > 0 else float(pedido.get("valor_nf") or 0)


def valor_da_nota(nota: dict) -> float:
    """O que conta como faturamento nesta nota: o valor dos PRODUTOS.

    "Valor total" do D365 inclui o frete embutido na nota; o faturamento do app
    é vendas SEM frete, e o frete tem conta própria (ressarcido × custo). Somar
    o total aqui faria a mesma nota valer uma coisa no painel e outra na
    conciliação — foi o que aconteceu com a NF 21077, R$ 247.705,63 de total
    contra R$ 245.219,97 de produtos.

    Sem o valor de produtos (export antigo, coluna ausente), cai no total: é o
    melhor que existe, e no export real só 3 das 61 notas tinham frete embutido.
    """
    v = nota.get("valor_produtos")
    try:
        v = float(v) if v is not None else 0.0
    except (TypeError, ValueError):
        v = 0.0
    return v if v > 0 else float(nota.get("valor_total") or 0)


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


def _eh_receita(nota: dict) -> bool:
    """Natureza de venda, dita explicitamente.

    O export sem filtro traz o livro fiscal inteiro — compra, remessa para
    industrialização, amostra, comodato. Nada disso é faturamento, e o que eu
    ainda não sei traduzir também não entra: nota sem natureza conhecida fica
    de fora e aparece em "a classificar".
    """
    return (nota.get("tipo_operacao") or "") in OPERACOES_FATURAMENTO


def _vale_como_faturamento(nota: dict) -> bool:
    """Saída aprovada. Entrada é devolução e tem tratamento próprio no app."""
    return _aprovada(nota) and (nota.get("direcao") or "Saída") == "Saída"


def _agrupar_por_tipo(linhas: list) -> list:
    agg = {}
    for l in linhas:
        k = l.get("tipo_operacao") or "A CLASSIFICAR"
        g = agg.setdefault(k, {"tipo": k, "qtd": 0, "valor": 0.0})
        g["qtd"] += 1
        g["valor"] = round(g["valor"] + valor_da_nota(l), 2)
    return sorted(agg.values(), key=lambda x: -x["valor"])


def _agrupar(linhas: list, chave) -> list:
    agg = {}
    for l in linhas:
        k = chave(l)
        g = agg.setdefault(k, {"chave": k, "qtd": 0, "valor": 0.0})
        g["qtd"] += 1
        g["valor"] = round(g["valor"] + valor_da_nota(l), 2)
    return sorted(agg.values(), key=lambda x: -x["valor"])


def importar_base_itens(conteudo: bytes, nome_arquivo: str) -> dict:
    """Preenche a LINHA das notas do espelho a partir da base item a item.

    O espelho do D365 é nota a nota: ele sabe o valor e a natureza, e não sabe
    o que tinha dentro. A base de itens sabe — uma linha por item de fatura,
    com família e produto —, e a família responde a linha comercial pelo mesmo
    mapa que o resto do app usa (`linha_produto`).

    É por isso que as duas planilhas convivem em vez de uma substituir a outra:
    o export de notas é o que foi faturado, e atualiza o dia inteiro; a base de
    itens é o que foi vendido, e atualiza algumas vezes ao dia. A linha de uma
    nota não muda durante o dia, então o atraso dela não atrapalha.

    Duas formas de casar, nessa ordem:

      1. pelo NÚMERO da nota — o caso normal;
      2. só para DEVOLUÇÃO que sobrou: por cliente + valor. A devolução costuma
         vir em nota do PRÓPRIO cliente (a H W devolveu com a numeração dela),
         e aí o número não existe do nosso lado — mas a nota de crédito está na
         base, negativa, com o mesmo cliente e o mesmo valor. Só vale quando há
         UM candidato; com dois, fica sem linha, porque metade de um palpite é
         pior do que nenhum.

    Não mexe em nota que já tem linha: correção feita à mão continua valendo.
    """
    from app.services import linha_produto

    try:
        if nome_arquivo.lower().endswith(".csv"):
            df = pd.read_csv(io.BytesIO(conteudo), sep=";", dtype=str)
        else:
            df = pd.read_excel(io.BytesIO(conteudo), dtype=str)
    except Exception as e:
        return {"erro": "Não consegui ler o arquivo: %s" % e, "atualizadas": 0}

    cols = {_sem_acento(c): c for c in df.columns}

    def _col(exato: str, *pedacos: str):
        """Nome exato primeiro; só depois o pedaço.

        Procurar só por pedaço erra feio nesta planilha: "faturamento" casa
        antes com "Ano/Mês do faturamento" (202610) do que com a receita, e
        "cliente" casa com "Tipo de cliente" (DISTRIBUIDOR) antes do nome. Nos
        dois casos a importação rodava bonito e respondia errado.
        """
        if exato in cols:
            return cols[exato]
        for chave, original in cols.items():
            if pedacos and all(p in chave for p in pedacos):
                return original
        return None

    c_nf = _col("numero da fatura", "numero", "fatura")
    c_fam = _col("familia", "familia")
    c_val = _col("faturamento")          # a receita, e só ela
    c_cli = _col("cliente")              # o nome, não o tipo
    if not (c_nf and c_fam and c_val):
        return {"erro": "Não parece a base de notas item a item: faltam as colunas de "
                        "número da fatura, família e faturamento.",
                "colunas_encontradas": list(df.columns)[:30], "atualizadas": 0}

    def _texto(v) -> str:
        # Célula vazia vem como NaN (float) mesmo com dtype=str.
        return "" if v is None or v != v else str(v).strip()

    def _numero(v) -> str:
        return _texto(v).lstrip("0")

    def _valor(v) -> float:
        try:
            return float(str(v).replace(".", "").replace(",", ".")) if "," in str(v) else float(v)
        except (TypeError, ValueError):
            return 0.0

    # Linha de cada NF: a que concentra mais VALOR entre os itens dela. Mesma
    # regra do rateio das OVs — um cateter caro e cinquenta fios baratos não
    # repartem meio a meio.
    por_nf: dict = {}
    creditos: list = []          # linhas negativas, para casar devolução
    for _, r in df.iterrows():
        linha = linha_produto.linha_da_familia(_texto(r[c_fam]))
        if not linha:
            continue
        valor = _valor(r[c_val])
        por_nf.setdefault(_numero(r[c_nf]), {})
        por_nf[_numero(r[c_nf])][linha] = por_nf[_numero(r[c_nf])].get(linha, 0.0) + abs(valor)
        if valor < 0 and c_cli:
            creditos.append({"cliente": _texto(r[c_cli]).upper(),
                             "valor": round(abs(valor), 2), "linha": linha})
    por_nf = {nf: max(p, key=p.get) for nf, p in por_nf.items() if p}

    db = get_service_db()
    notas = db.table("notas_d365").select(
        "id, numero, chave_numero, cliente_nome, valor_total, valor_produtos, "
        "tipo_operacao, linha, pedido_id, direcao, status").limit(20000).execute().data

    por_numero, por_valor, ja_tinha, com_ov = 0, 0, 0, 0
    sem_resposta: list = []
    for n in notas:
        if n.get("linha"):
            ja_tinha += 1
            continue
        # Nota COM OV não usa a linha daqui: a OV manda, item a item, e o
        # rateio dela é por valor de cada item — melhor do que a linha
        # predominante da nota. Preencher aqui só encheria o espelho de um
        # dado que ninguém lê. A devolução é a exceção: ela não tem OV deste
        # lado nem quando parece ter.
        if n.get("pedido_id") and n.get("tipo_operacao") != "DEVOLUCAO":
            com_ov += 1
            continue
        linha = por_nf.get(_numero(n.get("chave_numero")) or _numero(n.get("numero")))
        origem = "numero"
        if not linha and n.get("tipo_operacao") == "DEVOLUCAO":
            nome = (n.get("cliente_nome") or "").strip().upper()
            alvo = round(valor_da_nota(n), 2)
            candidatos = {c["linha"] for c in creditos
                          if c["cliente"] == nome and abs(c["valor"] - alvo) < 0.01}
            if len(candidatos) == 1:
                linha, origem = candidatos.pop(), "valor"
        if not linha:
            if n.get("tipo_operacao") == "DEVOLUCAO":
                sem_resposta.append({"nf": n.get("numero"), "cliente": n.get("cliente_nome"),
                                     "valor": round(valor_da_nota(n), 2)})
            continue
        db.table("notas_d365").update({"linha": linha, "linha_ajustada": True})\
            .eq("id", n["id"]).execute()
        if origem == "numero":
            por_numero += 1
        else:
            por_valor += 1

    return {
        "arquivo": nome_arquivo,
        "notas_na_planilha": len(por_nf),
        "atualizadas": por_numero + por_valor,
        "por_numero": por_numero,
        "por_valor": por_valor,
        "ja_tinham_linha": ja_tinha,
        # Fora da conta de propósito: nota com OV tira a linha da própria OV.
        "com_ov_nao_precisam": com_ov,
        "devolucoes_sem_resposta": sem_resposta,
    }


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

def _ultima_importacao(db) -> Optional[dict]:
    """A última subida do export: quando, qual arquivo, quem e quantas notas.

    A importação substitui o espelho inteiro, então todas as notas carregam o
    mesmo carimbo — basta ler o mais recente e contar quantas vieram com ele.
    """
    recente = (db.table("notas_d365").select("importado_em, importado_por, arquivo")
               .order("importado_em", desc=True).limit(1).execute().data)
    if not recente:
        return None
    r = recente[0]
    quando = r.get("importado_em")
    if not quando:
        return None
    nome = None
    if r.get("importado_por"):
        u = db.table("usuarios").select("nome").eq("id", r["importado_por"]).execute().data
        nome = (u[0].get("nome") if u else None)
    # Conta pelo ARQUIVO, não pelo carimbo: cada linha grava o seu próprio
    # importado_em e eles diferem nos microssegundos — comparar o timestamp
    # exato contava 133 de 333 notas da mesma subida.
    da_leva = [n for n in _pagina(db, "notas_d365", "arquivo")
               if n.get("arquivo") == r.get("arquivo")]
    return {"quando": quando, "arquivo": r.get("arquivo"), "por": nome,
            "notas": len(da_leva)}



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
        "valor_total, valor_produtos, operacao, tipo_operacao, origem_venda, linha, linha_ajustada, "
        "direcao, status, pedido_id"
    ).gte("data_documento", ini).lte("data_documento", fim).limit(5000).execute().data
    classificar_na_leitura(notas)

    # Saída aprovada é tudo o que a MSB emitiu e vale; dentro disso, só venda é
    # faturamento. Com o export sem filtro vem o livro inteiro — remessa para
    # industrialização de R$ 233 mil, amostra, comodato —, e somar isso como
    # receita seria pior do que não ter espelho nenhum.
    notas_periodo = list(notas)
    vivas = [n for n in notas if _vale_como_faturamento(n)]
    receita = [n for n in vivas if _eh_receita(n)]
    # Transfer price sai das duas pontas ao mesmo tempo: se saísse só de uma, a
    # diferença entre D365 e app passaria a ser o próprio transfer price.
    notas_transfer = [n for n in receita if eh_transfer_price(n.get("cliente_nome"))]
    notas = [n for n in receita if not eh_transfer_price(n.get("cliente_nome"))]

    peds = db.table("pedidos").select(
        "id, numero_pedido, numero_nf, valor_nf, valor_produtos, data_faturamento, status, "
        "tipo_operacao, cliente_id, clientes(nome)"
    ).gte("data_faturamento", f"{ini}T00:00:00").lte("data_faturamento", f"{fim}T23:59:59")\
        .limit(5000).execute().data
    # Bonificação, amostra e consignado geram NF e NÃO são faturamento — o
    # Painel Comercial já os deixa de fora, e a conciliação tem de olhar para a
    # mesma coisa, senão a diferença entre as duas pontas vira uma doação.
    peds = [p for p in peds if conta_faturamento(p.get("tipo_operacao"))]

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

    comunicado = [n for n in vivas if n.get("tipo_operacao") == "COMUNICADO_USO"]
    # As devolucoes sao notas de ENTRADA: nao passam por _vale_como_faturamento,
    # que so olha a saida aprovada.
    aprovadas = [n for n in notas_periodo if _aprovada(n)]
    devolucoes = [n for n in aprovadas if n.get("tipo_operacao") == "DEVOLUCAO"]
    simbolicas = [n for n in aprovadas if n.get("tipo_operacao") == "DEVOLUCAO_SIMBOLICA"]

    so_d365, so_app, divergentes = [], [], []
    for k, n in d365.items():
        if k in app:
            p = app[k]
            va, vd = round(valor_da_ov(p), 2), round(valor_da_nota(n), 2)
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
                "valor": round(valor_da_nota(n), 2),
                "operacao": n.get("operacao"), "tipo_operacao": n.get("tipo_operacao"),
                "origem_venda": n.get("origem_venda"),
                "linha": n.get("linha"), "linha_ajustada": n.get("linha_ajustada"),
            })
    for k, p in app.items():
        if k not in d365:
            so_app.append({
                "nf": p.get("numero_nf"), "ov": p.get("numero_pedido"), "pedido_id": p.get("id"),
                "data": str(p.get("data_faturamento") or "")[:10],
                "valor": round(valor_da_ov(p), 2),
                "cliente": (p.get("clientes") or {}).get("nome"),
                "tipo_operacao": p.get("tipo_operacao"),
            })

    so_d365.sort(key=lambda x: -x["valor"])
    so_app.sort(key=lambda x: -x["valor"])
    total_d365 = round(sum(valor_da_nota(n) for n in notas), 2)
    total_app = round(sum(valor_da_ov(p) for p in app.values()), 2)
    return {
        "periodo": {"ini": ini, "fim": fim},
        # Quando o espelho foi atualizado pela última vez. Sem isto a tela não
        # distingue "o D365 e o app batem" de "o arquivo é de três dias atrás".
        "ultima_importacao": _ultima_importacao(db),
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
            "d365_valor": round(sum(valor_da_nota(n) for n in notas_transfer), 2),
            "app_qtd": len(app_transfer),
            "app_valor": round(sum(valor_da_ov(p) for p in app_transfer.values()), 2),
            "notas": sorted([{
                "id": n.get("id"), "nf": n["numero"], "data": n.get("data_documento"),
                "cliente": n.get("cliente_nome"),
                "valor": round(valor_da_nota(n), 2),
                "no_app": n["chave_numero"] in app_transfer,
            } for n in notas_transfer], key=lambda x: -x["valor"]),
        },
        # Devolucao e venda desfeita: o faturamento bruto continua sendo o que
        # saiu, e o liquido e o que ficou. Os dois aparecem, porque a meta olha
        # um e o caixa olha o outro.
        "devolucoes": {
            "qtd": len(devolucoes),
            "valor": round(sum(valor_da_nota(n) for n in devolucoes), 2),
            "liquido": round(total_d365 - sum(valor_da_nota(n) for n in devolucoes), 2),
            "notas": sorted([{
                "id": n.get("id"), "nf": n["numero"], "data": n.get("data_documento"),
                "cliente": n.get("cliente_nome"),
                "valor": round(valor_da_nota(n), 2),
                "operacao": n.get("operacao"),
                "ov": (app.get(n["chave_numero"]) or {}).get("numero_pedido"),
                # A linha da devolução decide de QUAL meta o estorno sai. O
                # D365 não diz, e o espelho não guarda item: quem sabe é quem
                # olha a nota. Sem isso, a devolução some do total e não sai de
                # meta nenhuma.
                "linha": n.get("linha"), "linha_ajustada": n.get("linha_ajustada"),
            } for n in devolucoes], key=lambda x: (str(x["data"] or ""), x["nf"])),
            "simbolicas_qtd": len(simbolicas),
            "simbolicas_valor": round(sum(valor_da_nota(n) for n in simbolicas), 2),
        },
        # Comunicado de uso tem dona: quem emite essas notas no D365 quer
        # conferir, quando o relatorio sobe, o que foi lancado em nome dela.
        # Elas ja estao somadas no faturamento acima — isto aqui e a lista,
        # nao um bloco a parte da conta.
        "comunicado_uso": {
            "qtd": len(comunicado),
            "valor": round(sum(valor_da_nota(n) for n in comunicado), 2),
            "notas": sorted([{
                "id": n.get("id"), "nf": n["numero"], "data": n.get("data_documento"),
                "cliente": n.get("cliente_nome"), "cliente_conta": n.get("cliente_conta"),
                "valor": round(valor_da_nota(n), 2),
                "operacao": n.get("operacao"),
                "origem_venda": n.get("origem_venda"),
                "linha": n.get("linha"), "linha_ajustada": n.get("linha_ajustada"),
                "ov": (app.get(n["chave_numero"]) or app_transfer.get(n["chave_numero"]) or {})
                      .get("numero_pedido"),
            } for n in comunicado], key=lambda x: (str(x["data"] or ""), x["nf"])),
            "por_cliente": _agrupar(comunicado, lambda n: n.get("cliente_nome") or "(sem cliente)"),
        },
        "por_tipo": _agrupar_por_tipo(notas),
        # Operação que o app ainda não sabe traduzir. Fica FORA do faturamento
        # até alguém dizer o que é — e aparece aqui para que seja dito.
        "a_classificar": _agrupar([n for n in vivas if not n.get("tipo_operacao")],
                                  lambda n: n.get("operacao") or "(sem descrição)"),
        # O que a MSB emitiu e NÃO é venda: remessa para industrialização,
        # amostra, bonificação, comodato. Fica à vista porque passa pela
        # logística, e fora do faturamento porque não é receita.
        "saidas_sem_receita": _agrupar(
            [n for n in vivas if not _eh_receita(n) and n.get("tipo_operacao")],
            lambda n: n.get("tipo_operacao")),
        "por_origem": _agrupar(notas, lambda n: n.get("origem_venda") or "COMERCIAL"),
        # Linha das notas que NÃO passaram pelo app: é o pedaço do faturamento
        # que o placar por canal perderia quando a licitação sair daqui.
        "linha_sem_ov": _agrupar([n for n in notas if not n.get("pedido_id")],
                                 lambda n: n.get("linha") or "SEM LINHA"),
        # Sem nota importada no período não há conciliação a fazer: a tela diz
        # "importe o export do mês" em vez de acusar um buraco de 100%. Conta o
        # transfer price também: mês só com nota de Biomedical tem espelho.
        "sem_espelho": len(notas_periodo) == 0,
        # Importou, mas sem a coluna que diz a natureza da nota: a tela tem de
        # mandar reexportar em vez de dizer "nenhuma nota importada".
        "importadas_sem_natureza": sum(1 for n in notas_periodo
                                       if not n.get("tipo_operacao")),
        "notas_no_periodo": len(notas_periodo),
    }


# ── Complemento: o faturamento que não passa pelo app ─────────────────────────

VAZIO = {"qtd": 0, "valor": 0.0, "por_dia": {}, "por_linha": {},
         "licitacao": {"qtd": 0, "valor": 0.0}, "notas": []}

VAZIO_DEVOLUCAO = {"qtd": 0, "valor": 0.0, "por_linha": {},
                   "sem_linha": {"qtd": 0, "valor": 0.0}, "notas": []}


def devolucoes_do_periodo(ini: str, fim: str) -> dict:
    """Venda desfeita no período — o que a meta tem de devolver.

    Fica fora daqui, de propósito:

      · DEVOLUCAO_SIMBOLICA, que não é venda desfeita: é o acerto fiscal do
        material que estava em consignação e foi usado. Somá-la inflaria o
        estorno de outubro de R$ 51.705,85 para R$ 84 mil, estornando vendas
        que aconteceram;
      · transfer price, que não entrou na receita e por isso não sai dela.

    A devolução vem só do espelho: ela é nota de ENTRADA e não nasce de OV
    nenhuma — em outubro, as 6 que existem não têm OV do lado de cá.

    `por_linha` só tem o que dá para afirmar. A nota de devolução chega sem
    linha (o D365 não diz, e o espelho não guarda item), então o normal é cair
    tudo em `sem_linha` até alguém dizer qual é, na tela do faturamento
    conferido. Chutar a linha aqui seria tirar dinheiro da meta de alguém no
    palpite.
    """
    db = get_service_db()
    notas = db.table("notas_d365").select(
        "id, numero, chave_numero, cliente_nome, data_documento, valor_total, "
        "valor_produtos, operacao, tipo_operacao, origem_venda, linha, linha_ajustada, "
        "direcao, status"
    ).gte("data_documento", ini).lte("data_documento", fim).limit(5000).execute().data
    classificar_na_leitura(notas)

    devolucoes = [n for n in notas
                  if _aprovada(n)
                  and n.get("tipo_operacao") == "DEVOLUCAO"
                  and not eh_transfer_price(n.get("cliente_nome"))
                  and "ESTERILIZE" not in (n.get("cliente_nome") or "").upper()]
    if not devolucoes:
        return {**VAZIO_DEVOLUCAO, "por_linha": {}, "sem_linha": {"qtd": 0, "valor": 0.0},
                "notas": []}

    por_linha: dict = {}
    sem_linha = {"qtd": 0, "valor": 0.0}
    for n in devolucoes:
        v = valor_da_nota(n)
        alvo = por_linha.setdefault(n["linha"], {"qtd": 0, "valor": 0.0}) if n.get("linha") else sem_linha
        alvo["qtd"] += 1
        alvo["valor"] = round(alvo["valor"] + v, 2)

    return {
        "qtd": len(devolucoes),
        "valor": round(sum(valor_da_nota(n) for n in devolucoes), 2),
        "por_linha": por_linha,
        "sem_linha": sem_linha,
        "notas": sorted([{
            "id": n.get("id"), "nf": n.get("numero"), "data": n.get("data_documento"),
            "cliente": n.get("cliente_nome"), "valor": round(valor_da_nota(n), 2),
            "operacao": n.get("operacao"), "linha": n.get("linha"),
            "linha_ajustada": n.get("linha_ajustada"),
        } for n in devolucoes], key=lambda x: (str(x["data"] or ""), x["nf"])),
    }


def complemento_do_periodo(ini: str, fim: str) -> dict:
    """As notas do espelho que NÃO têm OV no app — e só elas.

    É o modelo híbrido que o Tássio pediu (14/10/2026), e ele vem do desenho da
    operação, não de preferência de ninguém:

      · venda normal e venda direta de licitação continuam nascendo no app, com
        kanban e expedição nossos — o faturamento delas sai da OV, como hoje,
        e nada muda;
      · comunicado de uso não passa por aqui: a Bio emite no D365 e não há o que
        a logística faça. Essa nota só existe no espelho.

    Somar as duas fontes direto contaria em dobro tudo o que passou pelo app.
    Por isso o complemento é a DIFERENÇA: nota do D365 sem NF correspondente em
    nenhuma OV viva. O par é conferido ao vivo (e não pelo `pedido_id` gravado
    na importação), senão uma OV faturada depois do import entraria duas vezes.

    Fora: transfer price, devolução, bonificação, amostra e consignado — o que
    não é receita de venda não vira faturamento só porque veio do D365.
    """
    db = get_service_db()
    notas = db.table("notas_d365").select(
        "id, numero, chave_numero, cliente_nome, data_documento, valor_total, "
        "valor_produtos, operacao, tipo_operacao, origem_venda, linha, direcao, status"
    ).gte("data_documento", ini).lte("data_documento", fim).limit(5000).execute().data
    classificar_na_leitura(notas)

    notas = [n for n in notas
             if _vale_como_faturamento(n)
             and not eh_transfer_price(n.get("cliente_nome"))
             # Tipo EXPLÍCITO, não o default: `conta_faturamento(None)` trata
             # nulo como venda normal — regra boa para a OV antiga do app, que
             # nasceu antes do campo existir, e perigosa aqui. Com o export sem
             # filtro, uma operação que eu ainda não sei traduzir (remessa para
             # conserto, por exemplo) entraria como receita. Nota sem natureza
             # conhecida fica de fora e aparece em "a classificar".
             and _eh_receita(n)]
    if not notas:
        return dict(VAZIO)

    # Quais desses números já existem como NF de alguma OV viva. O app guarda
    # ora "21083", ora "000021083" — as duas formas vão na consulta.
    chaves = sorted({n["chave_numero"] for n in notas})
    variantes = []
    for c in chaves:
        # TODOS os zeros à esquerda possíveis, não só "nenhum" e "nove dígitos".
        # A OV017097 gravou a NF como "0021178" — um zero — e escapou das duas
        # variantes que eu testava: a nota entrou como se não tivesse OV e foi
        # somada em cima dela, inflando o dia em R$ 7.840,00.
        variantes.extend({c.zfill(n) for n in range(len(c), 10)})
    no_app = set()
    for i in range(0, len(variantes), 40):
        rows = db.table("pedidos").select("numero_nf, status")\
            .in_("numero_nf", variantes[i:i + 40])\
            .neq("status", "CANCELADO").execute().data
        for r in rows:
            no_app.add(chave_nf(r.get("numero_nf")))

    orfas = [n for n in notas if n["chave_numero"] not in no_app]
    if not orfas:
        return dict(VAZIO)

    por_dia: dict = {}
    por_linha: dict = {}
    licit = {"qtd": 0, "valor": 0.0}
    for n in orfas:
        v = valor_da_nota(n)
        dia = str(n.get("data_documento") or "")[:10]
        d = por_dia.setdefault(dia, {"qtd": 0, "valor": 0.0})
        d["qtd"] += 1
        d["valor"] = round(d["valor"] + v, 2)
        linha = n.get("linha") or "SEM_LINHA"
        g = por_linha.setdefault(linha, {"qtd": 0, "valor": 0.0})
        g["qtd"] += 1
        g["valor"] = round(g["valor"] + v, 2)
        if (n.get("origem_venda") or "") == "LICITACAO":
            licit["qtd"] += 1
            licit["valor"] = round(licit["valor"] + v, 2)

    return {
        "qtd": len(orfas),
        "valor": round(sum(valor_da_nota(n) for n in orfas), 2),
        "por_dia": por_dia,
        "por_linha": por_linha,
        "licitacao": licit,
        "notas": sorted([{
            "id": n.get("id"), "nf": n.get("numero"), "data": n.get("data_documento"),
            "cliente": n.get("cliente_nome"), "valor": round(valor_da_nota(n), 2),
            "tipo_operacao": n.get("tipo_operacao"), "linha": n.get("linha"),
            "origem_venda": n.get("origem_venda"),
        } for n in orfas], key=lambda x: -x["valor"]),
    }

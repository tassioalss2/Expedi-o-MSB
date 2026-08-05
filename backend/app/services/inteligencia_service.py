"""Inteligência de mercado e estratégia comercial.

Saiu de dentro do CRM e virou módulo próprio: o público é a diretoria, e o
conteúdo não depende do funil — depende do faturamento faturado, do custo e do
estoque.

Duas camadas, de propósito:
  OPERACIONAL — o que fazer esta semana: quem parou de comprar, quem caiu, qual
    produto vai faltar, onde o preço está abaixo do público.
  ESTRATÉGICA — 19 meses com custo: margem por segmento/linha/região,
    sazonalidade, e o plano por linha para fechar o gap da meta.

Construída sobre os dados que a empresa REALMENTE tem, com a mesma definição de
venda do Painel Comercial — a versão anterior somava coisa que não é venda e
ficava em branco por depender de janelas impossíveis.

O que mudou e por quê:

1. ESCOPO. Antes contava tudo que não estava cancelado, pelo `criado_em`, com o
   `valor_nf` cru. Isso incluía Biomedical (transfer price, venda intragrupo que
   não é mercado), bonificação, amostra e consignado, contava OV não faturada e
   somava frete como se fosse receita. Agora usa exatamente o mesmo critério do
   Painel Comercial: NF de fato FATURADA (via movimentações), só operações de
   venda, sem frete e sem transfer price. Sem isso os números da Inteligência
   nunca fechariam com o resto do app.

2. JANELA REAL. O win-back exigia 90 dias de inatividade num app que só tem
   faturamento desde 29/05/2026 — matematicamente impossível, por isso os KPIs
   viviam zerados. Agora a comparação é entre dois períodos de tamanho igual
   dentro do que existe, e a resposta diz qual janela usou.

3. BASE GRANDE DE VERDADE. O sinal mais rico não está nas 2 mês de OVs daqui: está
   nos 6 meses fechados de quantidade vendida por produto que vêm do D365 via
   PCP (`sales_history`), cruzados com estoque disponível e cobertura. É o que
   permite dizer "isto vende e vai faltar" e "isto está parado consumindo
   capital" — decisões que dão dinheiro.

4. NADA EM BRANCO SEM EXPLICAÇÃO. Cada bloco devolve `disponivel` e `motivo`,
   para a tela dizer o que falta em vez de mostrar um painel vazio.

Não existe custo/CMV por produto no banco (nem em `produtos`, nem em lugar
nenhum), então margem real não é calculável hoje — o mais próximo é o preço
praticado, que esta análise usa como referência.
"""
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from app.core.database import get_service_db
from app.services import linha_produto

# Mesma regra do Painel Comercial (app/api/pedidos.py): só estas naturezas são
# faturamento; as outras geram NF mas não são venda.
_OPERACOES_VENDA = {"VENDA_NORMAL", "COMUNICADO_USO"}

# Empresas do próprio grupo: a venda para elas é transfer price, não mercado.
# Critério por nome, igual ao resto do app (o cadastro não tem flag de grupo).
_NOMES_GRUPO = ("BIOMEDICAL", "ESTERILIZE")

_JANELA_PADRAO = 30
_LIMITE = 5000

# Teto de linhas por resposta do PostgREST (padrão do Supabase). Ler tabela
# grande sem paginar trunca em silêncio: pedir 20000 devolve 1000 sem erro.
_PAGINA = 1000

# Receita mínima para um cliente/produto entrar nos rankings de margem. Sem isso
# a lista enche de caso pontual de R$ 300 com margem estranha, escondendo o que
# de fato move dinheiro.
_MIN_RECEITA_RANKING = 50_000.0


def _hoje_brt() -> date:
    return datetime.now(timezone(timedelta(hours=-3))).date()


def _ler_tudo(db, tabela: str, cols: str, ordem: str) -> list:
    """Lê a tabela inteira paginando pelo teto do PostgREST."""
    out: list = []
    off = 0
    while True:
        lote = db.table(tabela).select(cols).order(ordem).limit(_PAGINA).offset(off).execute().data
        if not lote:
            break
        out += lote
        if len(lote) < _PAGINA:
            break
        off += len(lote)
    return out


def _eh_grupo(nome: Optional[str]) -> bool:
    n = (nome or "").upper()
    return any(g in n for g in _NOMES_GRUPO)


def _valor_liquido(p: dict) -> float:
    """Faturamento sem frete de uma NF — idêntico ao `faturamento_sem_frete` do
    Painel Comercial. CIF (com ou sem valor) é frete e sai; FOB é do cliente e
    nunca entrou."""
    bruto = float(p.get("valor_nf") or 0)
    frete = float(p.get("valor_frete") or 0)
    if p.get("tipo_frete") in ("CIF_SEM_VALOR", "CIF_COM_VALOR"):
        bruto -= frete
    return bruto


def _canal_base(canal: Optional[str]) -> str:
    if canal == "LICITACAO_URO":
        return "URO"
    if canal == "LICITACAO_VASCULAR":
        return "VASCULAR"
    return canal or "SEM_CANAL"


def _eh_licitacao(canal: Optional[str]) -> bool:
    return canal in ("LICITACAO_URO", "LICITACAO_VASCULAR", "LICITACAO")


def _faturados(db, inicio: date, fim: date) -> dict:
    """pedido_id -> data de faturamento (BRT). Mesma lógica de
    `_faturados_no_periodo` em app/api/pedidos.py: a data que vale é a da
    movimentação para FATURADO, não a criação nem a última atualização."""
    janela_ini = (inicio - timedelta(days=1)).isoformat()
    janela_fim = (fim + timedelta(days=1)).isoformat()
    try:
        movs = db.table("movimentacoes").select("pedido_id, criado_em")\
            .eq("status_novo", "FATURADO")\
            .gte("criado_em", f"{janela_ini}T00:00:00")\
            .lte("criado_em", f"{janela_fim}T23:59:59").limit(_LIMITE).execute().data
    except Exception:
        return {}
    out: dict = {}
    for m in movs:
        ts, pid = m.get("criado_em"), m.get("pedido_id")
        if not ts or not pid:
            continue
        try:
            d = datetime.fromisoformat(ts.replace("Z", "+00:00"))
            dia = (d.astimezone(timezone.utc) - timedelta(hours=3)).date()
        except Exception:
            continue
        if inicio <= dia <= fim:
            out[pid] = dia.isoformat()
    return out


def _base_vendas(db, inicio: date, fim: date) -> list:
    """Uma linha por NF faturada no período, já no escopo correto de venda."""
    faturados = _faturados(db, inicio, fim)
    if not faturados:
        return []
    ids = list(faturados.keys())
    linhas: list = []
    for i in range(0, len(ids), 80):
        lote = ids[i:i + 80]
        rows = db.table("pedidos").select(
            "id, cliente_id, canal, tipo_operacao, tipo_frete, status, "
            "valor_nf, valor_frete, numero_pedido, clientes(nome)"
        ).in_("id", lote).execute().data
        for p in rows:
            if p.get("status") == "CANCELADO":
                continue
            if (p.get("tipo_operacao") or "VENDA_NORMAL") not in _OPERACOES_VENDA:
                continue
            nome = (p.get("clientes") or {}).get("nome")
            if _eh_grupo(nome):
                continue
            valor = _valor_liquido(p)
            if valor <= 0:
                continue
            linhas.append({
                "pedido_id": p["id"],
                "numero": p.get("numero_pedido"),
                "cliente_id": p.get("cliente_id"),
                "cliente": nome or "—",
                "canal": _canal_base(p.get("canal")),
                "licitacao": _eh_licitacao(p.get("canal")),
                "valor": valor,
                "data": faturados[p["id"]],
            })
    return linhas


def _por_cliente(linhas: list) -> dict:
    agg: dict = {}
    for l in linhas:
        cid = l["cliente_id"] or l["cliente"]
        c = agg.setdefault(cid, {"cliente_id": l["cliente_id"], "cliente": l["cliente"],
                                 "valor": 0.0, "nfs": 0, "canais": {}, "ultima": None})
        c["valor"] += l["valor"]
        c["nfs"] += 1
        c["canais"][l["canal"]] = c["canais"].get(l["canal"], 0) + 1
        if c["ultima"] is None or l["data"] > c["ultima"]:
            c["ultima"] = l["data"]
    for c in agg.values():
        c["valor"] = round(c["valor"], 2)
        c["canal"] = max(c["canais"], key=c["canais"].get) if c["canais"] else None
        c.pop("canais")
    return agg


# ── Curva ABC e concentração ────────────────────────────────────────────────────

def _curva_abc(clientes: dict) -> dict:
    """Pareto de clientes: A = até 80% do faturamento, B = até 95%, C = cauda.

    Serve para responder "quem eu não posso perder" e medir concentração — se
    um cliente sozinho é 30% da receita, isso é risco, não conquista.
    """
    lista = sorted(clientes.values(), key=lambda c: -c["valor"])
    total = sum(c["valor"] for c in lista)
    if total <= 0:
        return {"disponivel": False, "motivo": "Sem faturamento no período.",
                "classes": [], "clientes": [], "concentracao": {}}

    acum = 0.0
    saida = []
    contagem = {"A": 0, "B": 0, "C": 0}
    valor_classe = {"A": 0.0, "B": 0.0, "C": 0.0}
    for c in lista:
        acum += c["valor"]
        pct_acum = acum / total * 100
        classe = "A" if pct_acum <= 80 else ("B" if pct_acum <= 95 else "C")
        contagem[classe] += 1
        valor_classe[classe] += c["valor"]
        saida.append({**c, "pct": round(c["valor"] / total * 100, 1),
                      "pct_acumulado": round(pct_acum, 1), "classe": classe})

    top1 = lista[0]["valor"] / total * 100 if lista else 0
    top5 = sum(c["valor"] for c in lista[:5]) / total * 100
    return {
        "disponivel": True,
        "total": round(total, 2),
        "classes": [{"classe": k, "clientes": contagem[k], "valor": round(valor_classe[k], 2),
                     "pct": round(valor_classe[k] / total * 100, 1)} for k in ("A", "B", "C")],
        "clientes": saida,
        "concentracao": {
            "top1_pct": round(top1, 1),
            "top1_cliente": lista[0]["cliente"] if lista else None,
            "top5_pct": round(top5, 1),
            # Acima de 30% num só cliente, a carteira depende dele.
            "risco": "ALTO" if top1 >= 30 else ("MEDIO" if top1 >= 20 else "BAIXO"),
        },
    }


# ── Movimento da carteira: quem parou, quem caiu, quem é novo ───────────────────

def _movimento_carteira(atual: dict, anterior: dict, janela: int) -> dict:
    """Compara dois períodos de tamanho igual. É o win-back honesto: em vez de
    exigir 90 dias de inatividade (impossível numa base de 2 meses), pergunta
    "comprou antes e não comprou agora?"."""
    ids_atual = set(atual.keys())
    ids_ant = set(anterior.keys())

    pararam = []
    for cid in ids_ant - ids_atual:
        c = anterior[cid]
        pararam.append({"cliente_id": c["cliente_id"], "cliente": c["cliente"],
                        "valor_anterior": c["valor"], "nfs_anterior": c["nfs"],
                        "ultima_compra": c["ultima"], "canal": c.get("canal")})
    pararam.sort(key=lambda x: -x["valor_anterior"])

    caindo = []
    for cid in ids_atual & ids_ant:
        va, vb = atual[cid]["valor"], anterior[cid]["valor"]
        if vb <= 0:
            continue
        var = (va - vb) / vb * 100
        if var <= -30:
            caindo.append({"cliente_id": atual[cid]["cliente_id"], "cliente": atual[cid]["cliente"],
                           "valor_atual": va, "valor_anterior": vb,
                           "variacao_pct": round(var, 1), "canal": atual[cid].get("canal")})
    caindo.sort(key=lambda x: x["variacao_pct"])

    novos = []
    for cid in ids_atual - ids_ant:
        c = atual[cid]
        novos.append({"cliente_id": c["cliente_id"], "cliente": c["cliente"],
                      "valor": c["valor"], "nfs": c["nfs"], "canal": c.get("canal")})
    novos.sort(key=lambda x: -x["valor"])

    return {
        "disponivel": bool(ids_atual or ids_ant),
        "janela_dias": janela,
        "pararam": pararam[:15],
        "pararam_total": round(sum(p["valor_anterior"] for p in pararam), 2),
        "caindo": caindo[:15],
        "novos": novos[:15],
        "novos_total": round(sum(n["valor"] for n in novos), 2),
    }


# ── Radar de produtos: onde está o dinheiro na mesa ─────────────────────────────

_ACOES = {
    "RUPTURA": {
        "label": "Vende e vai faltar",
        "acao": "Puxar produção/compra — cada dia sem estoque é venda perdida",
    },
    "EM_ALTA": {
        "label": "Demanda crescendo",
        "acao": "Garantir estoque e ofertar ativamente antes do concorrente",
    },
    "EM_QUEDA": {
        "label": "Demanda caindo",
        "acao": "Investigar qual cliente parou de comprar",
    },
    "PARADO": {
        "label": "Estoque parado",
        "acao": "Capital imobilizado — empurrar em campanha ou bonificação",
    },
}


def _radar_produtos() -> dict:
    """Cruza 6 meses de venda real (D365 via PCP) com estoque disponível.

    É a parte com mais sinal da Inteligência: 176 produtos com histórico mensal
    fechado, contra 2 meses de OVs aqui dentro. Responde onde a empresa está
    perdendo venda por falta e onde está com capital parado.
    """
    try:
        from app.services import estoque_service
        dados = estoque_service.listar(sincronizar_se_preciso=False)
    except Exception:
        return {"disponivel": False, "motivo": "Não foi possível ler o estoque do PCP.",
                "grupos": [], "itens": []}

    itens = dados.get("itens") or []
    if not itens:
        return {"disponivel": False,
                "motivo": "Sem foto de estoque do PCP ainda. Abra a aba Estoque uma vez para sincronizar.",
                "grupos": [], "itens": []}

    classificados = []
    for i in itens:
        consumo = float(i.get("consumo_medio") or 0)
        cob = i.get("cobertura_disponivel")
        tend = i.get("tendencia_pct")
        disp = float(i.get("disponivel") or 0)

        acao = None
        # Ordem importa: ruptura com demanda é o mais caro, vem primeiro.
        if consumo > 0 and (cob is not None and cob < 1):
            acao = "RUPTURA"
        elif tend is not None and tend >= 25 and consumo > 0:
            acao = "EM_ALTA"
        elif tend is not None and tend <= -25 and consumo > 0:
            acao = "EM_QUEDA"
        elif disp > 0 and (consumo <= 0 or (cob is not None and cob >= 12)):
            acao = "PARADO"
        if not acao:
            continue

        classificados.append({
            "codigo": i.get("codigo"), "descricao": i.get("descricao"),
            "familia": i.get("familia"), "linha": i.get("linha"),
            "disponivel": i.get("disponivel"), "consumo_medio": i.get("consumo_medio"),
            "cobertura": cob, "tendencia_pct": tend,
            "media_3m": i.get("media_3m"), "media_3m_anterior": i.get("media_3m_anterior"),
            "vendido_mes_atual": i.get("vendido_mes_atual"),
            "acao": acao,
        })

    grupos = []
    for chave, cfg in _ACOES.items():
        do_grupo = [c for c in classificados if c["acao"] == chave]
        if chave == "RUPTURA":
            do_grupo.sort(key=lambda x: -(x["consumo_medio"] or 0))
        elif chave == "EM_ALTA":
            do_grupo.sort(key=lambda x: -(x["tendencia_pct"] or 0))
        elif chave == "EM_QUEDA":
            do_grupo.sort(key=lambda x: (x["tendencia_pct"] or 0))
        else:
            do_grupo.sort(key=lambda x: -(x["disponivel"] or 0))
        grupos.append({"chave": chave, "label": cfg["label"], "acao": cfg["acao"],
                       "total": len(do_grupo), "itens": do_grupo[:12]})

    return {
        "disponivel": True,
        "data_ref": dados.get("data_ref"),
        "ultimo_mes_fechado": dados.get("ultimo_mes_fechado"),
        "base_produtos": len(itens),
        "grupos": grupos,
    }


# ── Preço: privado vs público ganho ─────────────────────────────────────────────

def _precos(db) -> dict:
    """Preço médio praticado na venda privada contra o preço que ganhou licitação.

    O preço público é registro de disputa vencida — é a referência de mercado
    mais concreta que existe no banco. Quando o privado está abaixo dele, muito
    provavelmente há margem sendo entregue sem necessidade.
    """
    privado: dict = {}
    try:
        itens = db.table("itens_pedido").select(
            "pedido_id, produto_id, qtd_solicitada, valor_unitario"
        ).limit(_LIMITE).execute().data
    except Exception:
        itens = []
    com_preco = [i for i in itens if i.get("valor_unitario")]

    cod_por_pid: dict = {}
    pids = list({i["produto_id"] for i in com_preco if i.get("produto_id")})
    for i in range(0, len(pids), 80):
        lote = pids[i:i + 80]
        if not lote:
            continue
        for p in db.table("produtos").select("id, codigo, descricao").in_("id", lote).execute().data:
            cod_por_pid[p["id"]] = p

    for it in com_preco:
        pr = cod_por_pid.get(it.get("produto_id"))
        if not pr:
            continue
        cod = (pr.get("codigo") or "").strip().upper()
        e = privado.setdefault(cod, {"codigo": pr.get("codigo"), "descricao": pr.get("descricao"),
                                     "soma": 0.0, "qtd": 0})
        e["soma"] += float(it["valor_unitario"])
        e["qtd"] += 1

    publico: dict = {}
    try:
        for ei in db.table("empenho_itens").select("codigo, valor_unitario").limit(_LIMITE).execute().data:
            v = ei.get("valor_unitario")
            cod = (ei.get("codigo") or "").strip().upper()
            if not cod or not v:
                continue
            e = publico.setdefault(cod, {"soma": 0.0, "qtd": 0})
            e["soma"] += float(v)
            e["qtd"] += 1
    except Exception:
        pass

    comparacao = []
    for cod, pv in privado.items():
        pb = publico.get(cod)
        if not pb or pb["qtd"] == 0 or pv["qtd"] == 0:
            continue
        media_priv = pv["soma"] / pv["qtd"]
        media_pub = pb["soma"] / pb["qtd"]
        if media_pub <= 0:
            continue
        dif = (media_priv - media_pub) / media_pub * 100
        comparacao.append({
            "codigo": pv["codigo"], "descricao": pv["descricao"],
            "preco_privado": round(media_priv, 2), "preco_publico": round(media_pub, 2),
            "diferenca_pct": round(dif, 1),
            "amostras_privado": pv["qtd"], "amostras_publico": pb["qtd"],
        })
    comparacao.sort(key=lambda x: x["diferenca_pct"])

    if not comparacao:
        motivo = ("Precisa de preço unitário nas OVs privadas E em empenhos do mesmo produto. "
                  f"Hoje: {len(com_preco)} item(ns) de OV com preço, {len(publico)} código(s) em empenho.")
        return {"disponivel": False, "motivo": motivo, "itens": [],
                "abaixo_do_publico": 0}

    return {
        "disponivel": True,
        "itens": comparacao[:20],
        "abaixo_do_publico": sum(1 for c in comparacao if c["diferenca_pct"] < -5),
    }


# ── Rentabilidade: 19 meses de faturamento item a item, com custo ───────────────
#
# Vem de `faturamento_itens` (export do D365, carregado por
# faturamento_import_service). É a única fonte do app com CUSTO, então é a única
# que responde margem — e traz de brinde o que a tabela `clientes` nunca teve:
# tipo de cliente, UF e cidade.

def _pct(receita: float, custo: float):
    return round((receita - custo) / receita * 100, 1) if receita > 0 else None


def _agrupar(linhas: list, campo: str) -> list:
    agg: dict = {}
    for l in linhas:
        k = l.get(campo) or "—"
        a = agg.setdefault(k, {"chave": k, "receita": 0.0, "custo": 0.0, "qtd": 0.0, "linhas": 0})
        a["receita"] += float(l.get("receita") or 0)
        a["custo"] += float(l.get("custo_total") or 0)
        a["qtd"] += float(l.get("qtd") or 0)
        a["linhas"] += 1
    saida = []
    for a in agg.values():
        saida.append({**a, "receita": round(a["receita"], 2), "custo": round(a["custo"], 2),
                      "qtd": round(a["qtd"]), "margem_pct": _pct(a["receita"], a["custo"])})
    return sorted(saida, key=lambda x: -x["receita"])


def _rentabilidade(db) -> dict:
    """Margem por segmento, produto, cliente, região e mês.

    A margem usa custo MÉDIO por produto (as duas planilhas de origem não
    compartilham chave de transação — uma identifica pela fatura, a outra pela
    OV). Serve para comparar segmentos e encontrar onde a margem vaza; não serve
    para auditar uma NF específica.
    """
    try:
        linhas = _ler_tudo(db, "faturamento_itens",
                           "competencia, cliente_nome, cliente_tipo, uf, vertical, familia, "
                           "produto_codigo, produto_descricao, qtd, receita, custo_total",
                           "competencia")
    except Exception:
        return {"disponivel": False,
                "motivo": "Base histórica não encontrada. Rode a migration v26 e importe as "
                          "planilhas de faturamento do D365.",
                "meses": []}

    if not linhas:
        return {"disponivel": False,
                "motivo": "Base histórica vazia. Importe faturamento_2025_2026.xlsx e "
                          "historico_faturamento.xlsx pelo faturamento_import_service.",
                "meses": []}

    receita = sum(float(l.get("receita") or 0) for l in linhas)
    custo = sum(float(l.get("custo_total") or 0) for l in linhas)

    meses = _agrupar(linhas, "competencia")
    meses.sort(key=lambda x: x["chave"])

    # Tendência da margem: média dos 3 meses mais recentes contra os 3 anteriores.
    # É o que revela margem escorrendo aos poucos, que o número global esconde.
    tend = None
    validos = [m for m in meses if m["margem_pct"] is not None]
    if len(validos) >= 6:
        rec3 = sum(m["margem_pct"] for m in validos[-3:]) / 3
        ant3 = sum(m["margem_pct"] for m in validos[-6:-3]) / 3
        tend = {
            "margem_3m": round(rec3, 1),
            "margem_3m_anterior": round(ant3, 1),
            "delta_pp": round(rec3 - ant3, 1),
            # Cada ponto percentual sobre a receita média mensal recente.
            "impacto_mes": round((rec3 - ant3) / 100 * (sum(m["receita"] for m in validos[-3:]) / 3), 2),
        }

    produtos = _agrupar(linhas, "produto_codigo")
    desc_prod = {}
    for l in linhas:
        c = l.get("produto_codigo")
        if c and c not in desc_prod:
            desc_prod[c] = l.get("produto_descricao")
    for p in produtos:
        p["descricao"] = desc_prod.get(p["chave"])

    relevantes = [p for p in produtos if p["receita"] >= _MIN_RECEITA_RANKING and p["margem_pct"] is not None]
    clientes = [c for c in _agrupar(linhas, "cliente_nome")
                if c["receita"] >= _MIN_RECEITA_RANKING and c["margem_pct"] is not None]

    return {
        "disponivel": True,
        "periodo": {"de": meses[0]["chave"], "ate": meses[-1]["chave"], "meses": len(meses)},
        "linhas": len(linhas),
        "receita": round(receita, 2),
        "custo": round(custo, 2),
        "margem_pct": _pct(receita, custo),
        "tendencia": tend,
        "meses": meses,
        "por_tipo_cliente": _agrupar(linhas, "cliente_tipo"),
        # 1% de corte: o export tem um resíduo de vertical em branco (R$ 10 mil
        # em 19 meses) que só polui a leitura do resumo.
        "por_vertical": [v for v in _agrupar(linhas, "vertical")
                         if receita <= 0 or v["receita"] / receita >= 0.01],
        "por_uf": _agrupar(linhas, "uf")[:12],
        "produtos_piores": sorted(relevantes, key=lambda x: x["margem_pct"])[:10],
        "produtos_melhores": sorted(relevantes, key=lambda x: -x["margem_pct"])[:10],
        "clientes_piores": sorted(clientes, key=lambda x: x["margem_pct"])[:10],
        "min_receita_ranking": _MIN_RECEITA_RANKING,
    }


# ── Estratégia por linha: como fechar o gap da meta ─────────────────────────────
#
# A linha do produto vem de `linha_produto`: cadastro (produtos.linha) primeiro,
# família como fallback — necessário aqui porque o histórico do D365 tem itens
# que nunca entraram na tabela produtos.
LINHA_LABEL = linha_produto.LINHA_LABEL

# Recompra: só entra cliente com pelo menos 3 compras na linha (sem isso não há
# padrão, é evento isolado) e atraso de 30% acima do próprio intervalo médio.
_MIN_COMPRAS_PADRAO = 3
_FATOR_ATRASO = 1.3


def _dias_uteis_restantes(hoje: date) -> int:
    from calendar import monthrange
    ultimo = monthrange(hoje.year, hoje.month)[1]
    return sum(1 for d in range(hoje.day, ultimo + 1)
               if date(hoje.year, hoje.month, d).weekday() < 5)


def _linha_de(codigo: Optional[str], familia: Optional[str],
              por_codigo: Optional[dict] = None) -> Optional[str]:
    return linha_produto.resolver(codigo, familia, por_codigo)


def estrategias(db) -> dict:
    """Plano por linha para fechar o gap da meta, com alavancas quantificadas.

    Cada alavanca nomeia clientes ou produtos e diz quanto vale — estratégia sem
    número e sem nome não vira ação. O potencial de cada uma é comparado ao gap,
    para a diretoria ver o que sozinho já resolve e o que é complemento.
    """
    hoje = _hoje_brt()
    comp = hoje.strftime("%Y-%m")

    try:
        linhas_fat = _ler_tudo(db, "faturamento_itens",
                               "competencia, familia, cliente_nome, produto_codigo, "
                               "produto_descricao, receita, custo_total, qtd", "competencia")
    except Exception:
        linhas_fat = []
    if not linhas_fat:
        return {"disponivel": False,
                "motivo": "Base histórica de faturamento não carregada — sem ela não há como "
                          "calcular ciclo de recompra nem margem por linha.",
                "linhas": []}

    linha_por_codigo = linha_produto.mapa_por_codigo(db)
    for l in linhas_fat:
        l["_linha"] = _linha_de(l.get("produto_codigo"), l.get("familia"), linha_por_codigo)

    meses = sorted({l["competencia"] for l in linhas_fat})
    ultimo = meses[-1]
    pos = {m: i for i, m in enumerate(meses)}

    try:
        metas = {m["canal"]: float(m.get("valor") or 0)
                 for m in db.table("metas_faturamento").select("canal, valor")
                 .eq("competencia", comp).execute().data}
    except Exception:
        metas = {}

    # Estoque para a alavanca de ruptura (best-effort: sistema externo).
    try:
        from app.services import estoque_service
        est = {i["codigo"]: i for i in (estoque_service.listar(sincronizar_se_preciso=False).get("itens") or [])}
    except Exception:
        est = {}

    precos_pub = _precos(db)
    pub_por_cod = {p["codigo"]: p for p in (precos_pub.get("itens") or [])}

    saida = []
    for linha in ("URO", "VASCULAR", "REALCLOSURE"):
        da_linha = [l for l in linhas_fat if l["_linha"] == linha]
        if not da_linha:
            continue

        por_mes: dict = {}
        for l in da_linha:
            por_mes[l["competencia"]] = por_mes.get(l["competencia"], 0.0) + float(l.get("receita") or 0)
        realizado = round(por_mes.get(comp, 0.0), 2)
        meta = metas.get(linha, 0.0)
        gap = round(max(0.0, meta - realizado), 2)

        ult12 = [por_mes.get(m, 0.0) for m in meses[-12:]]
        media12 = round(sum(ult12) / len(ult12), 2) if ult12 else 0.0
        meta_vs_media = round(meta / media12 * 100, 0) if media12 > 0 else None

        # ── Alavanca 1: recompra atrasada (a mais forte) ──────────────────────
        ciclo: dict = {}
        for l in da_linha:
            c = ciclo.setdefault(l["cliente_nome"], {})
            c[l["competencia"]] = c.get(l["competencia"], 0.0) + float(l.get("receita") or 0)

        atrasados = []
        for cliente, mm in ciclo.items():
            compras = sorted(pos[m] for m in mm)
            if len(compras) < _MIN_COMPRAS_PADRAO:
                continue
            ints = [b - a for a, b in zip(compras, compras[1:])]
            intervalo = sum(ints) / len(ints) if ints else 0
            parado = pos[ultimo] - compras[-1]
            if intervalo <= 0 or parado < 1 or parado <= intervalo * _FATOR_ATRASO:
                continue
            atrasados.append({
                "cliente": cliente,
                "intervalo_meses": round(intervalo, 1),
                "meses_parado": parado,
                "ticket_medio": round(sum(mm.values()) / len(mm), 2),
                "compras": len(compras),
            })
        atrasados.sort(key=lambda x: -x["ticket_medio"])
        pot_recompra = round(sum(a["ticket_medio"] for a in atrasados), 2)

        # ── Alavanca 2: queda de 3m contra 3m ────────────────────────────────
        caindo = []
        if len(meses) >= 6:
            rec3, ant3 = meses[-3:], meses[-6:-3]
            for cliente, mm in ciclo.items():
                a = sum(mm.get(m, 0.0) for m in rec3) / 3
                b = sum(mm.get(m, 0.0) for m in ant3) / 3
                if b <= 0 or a >= b * 0.7:
                    continue
                caindo.append({"cliente": cliente, "media_atual": round(a, 2),
                               "media_anterior": round(b, 2), "recuperavel": round(b - a, 2),
                               "queda_pct": round((a - b) / b * 100, 1)})
            caindo.sort(key=lambda x: -x["recuperavel"])
        pot_queda = round(sum(c["recuperavel"] for c in caindo), 2)

        # ── Alavanca 3: ruptura travando venda ───────────────────────────────
        cods_linha = {l["produto_codigo"] for l in da_linha if l.get("produto_codigo")}
        preco_med: dict = {}
        for l in da_linha:
            cod, q, r = l.get("produto_codigo"), float(l.get("qtd") or 0), float(l.get("receita") or 0)
            if cod and q > 0:
                p = preco_med.setdefault(cod, [0.0, 0.0])
                p[0] += r
                p[1] += q
        rupturas = []
        for cod in cods_linha:
            e = est.get(cod)
            if not e:
                continue
            consumo = float(e.get("consumo_medio") or 0)
            cob = e.get("cobertura_disponivel")
            if consumo <= 0 or cob is None or cob >= 1:
                continue
            pm = preco_med.get(cod)
            unit = (pm[0] / pm[1]) if (pm and pm[1] > 0) else 0
            # Receita de um mês de demanda que o estoque não cobre.
            falta_mes = max(0.0, consumo - float(e.get("disponivel") or 0))
            rupturas.append({
                "codigo": cod, "descricao": e.get("descricao"),
                "disponivel": e.get("disponivel"), "consumo_medio": consumo,
                "cobertura": cob, "preco_medio": round(unit, 2),
                "receita_travada": round(falta_mes * unit, 2),
            })
        rupturas.sort(key=lambda x: -x["receita_travada"])
        pot_ruptura = round(sum(r["receita_travada"] for r in rupturas), 2)

        # ── Alavanca 4: preço abaixo do público ──────────────────────────────
        abaixo = []
        for cod in cods_linha:
            p = pub_por_cod.get(cod)
            if not p or p["diferenca_pct"] >= -5:
                continue
            pm = preco_med.get(cod)
            qtd_mes = (pm[1] / max(1, len(meses))) if pm else 0
            ganho = (p["preco_publico"] - p["preco_privado"]) * qtd_mes
            abaixo.append({**p, "qtd_mes": round(qtd_mes, 1), "ganho_mes": round(ganho, 2)})
        abaixo.sort(key=lambda x: -x["ganho_mes"])
        pot_preco = round(sum(a["ganho_mes"] for a in abaixo), 2)

        # ── Mix: onde cada real vendido rende mais margem ────────────────────
        prod_agg: dict = {}
        for l in da_linha:
            cod = l.get("produto_codigo")
            if not cod:
                continue
            a = prod_agg.setdefault(cod, {"chave": cod, "descricao": l.get("produto_descricao"),
                                          "receita": 0.0, "custo": 0.0})
            a["receita"] += float(l.get("receita") or 0)
            a["custo"] += float(l.get("custo_total") or 0)
        mix = [{**a, "receita": round(a["receita"], 2), "margem_pct": _pct(a["receita"], a["custo"])}
               for a in prod_agg.values() if a["receita"] >= _MIN_RECEITA_RANKING]
        mix_top = sorted([m for m in mix if m["margem_pct"] is not None],
                         key=lambda x: -x["margem_pct"])[:5]
        mix_pior = sorted([m for m in mix if m["margem_pct"] is not None],
                          key=lambda x: x["margem_pct"])[:5]

        receita_linha = sum(float(l.get("receita") or 0) for l in da_linha)
        custo_linha = sum(float(l.get("custo_total") or 0) for l in da_linha)

        def _alav(tipo, titulo, valor, acao, itens):
            return {"tipo": tipo, "titulo": titulo, "valor": valor, "acao": acao,
                    "cobre_gap_pct": round(valor / gap * 100, 0) if gap > 0 else None,
                    "itens": itens}

        alavancas = [
            _alav("RECOMPRA",
                  f"{len(atrasados)} cliente(s) com recompra atrasada",
                  pot_recompra,
                  "Ligar para estes clientes: eles compram em ciclo e o ciclo venceu. "
                  "É a receita mais barata de trazer — já compraram antes.",
                  atrasados[:12]),
            _alav("QUEDA",
                  f"{len(caindo)} cliente(s) comprando menos que antes",
                  pot_queda,
                  "Entender o que mudou: preço, concorrente ou desabastecimento. "
                  "O valor é a diferença para o patamar que eles já tinham.",
                  caindo[:12]),
            _alav("RUPTURA",
                  f"{len(rupturas)} produto(s) sem estoque para a demanda",
                  pot_ruptura,
                  "Venda que não acontece por falta de material. Puxar produção "
                  "resolve sem precisar de esforço comercial.",
                  rupturas[:12]),
            _alav("PRECO",
                  f"{len(abaixo)} produto(s) abaixo do preço que ganha licitação",
                  pot_preco,
                  "Corrigir tabela: o mercado público já paga mais por este item. "
                  "Ganho de margem sem vender uma unidade a mais.",
                  abaixo[:12]),
        ]
        alavancas.sort(key=lambda a: -a["valor"])
        potencial = round(sum(a["valor"] for a in alavancas), 2)

        # Diagnóstico: meta muito acima da média histórica não é problema de
        # execução do mês, é meta fora da capacidade instalada. Dizer isso é mais
        # útil do que fingir que a diferença sai só de esforço.
        if meta <= 0:
            diagnostico = "Sem meta cadastrada para esta linha neste mês."
        elif meta_vs_media and meta_vs_media >= 140:
            diagnostico = (f"A meta é {meta_vs_media:.0f}% da média dos últimos 12 meses "
                           f"({_fmt(media12)}/mês). O gap não fecha só com esforço de venda: "
                           f"exige entrada nova ou revisão da meta.")
        elif meta_vs_media and meta_vs_media >= 110:
            diagnostico = (f"A meta pede {meta_vs_media:.0f}% da média histórica — é esticada, "
                           f"mas alcançável trabalhando a carteira existente.")
        else:
            diagnostico = "A meta está dentro do patamar histórico da linha."

        saida.append({
            "linha": linha,
            "label": LINHA_LABEL[linha],
            "meta": round(meta, 2),
            "realizado": realizado,
            "atingido_pct": round(realizado / meta * 100, 1) if meta > 0 else None,
            "gap": gap,
            "media_12m": media12,
            "meta_vs_media_pct": meta_vs_media,
            "receita_historica": round(receita_linha, 2),
            "margem_pct": _pct(receita_linha, custo_linha),
            "diagnostico": diagnostico,
            "potencial_total": potencial,
            "potencial_cobre_gap_pct": round(potencial / gap * 100, 0) if gap > 0 else None,
            "alavancas": alavancas,
            "mix_melhores": mix_top,
            "mix_piores": mix_pior,
        })

    meta_total = round(sum(s["meta"] for s in saida), 2)
    real_total = round(sum(s["realizado"] for s in saida), 2)
    return {
        "disponivel": True,
        "competencia": comp,
        "dias_uteis_restantes": _dias_uteis_restantes(hoje),
        "meta_total": meta_total,
        "realizado_total": real_total,
        "gap_total": round(max(0.0, meta_total - real_total), 2),
        "atingido_pct": round(real_total / meta_total * 100, 1) if meta_total > 0 else None,
        "potencial_total": round(sum(s["potencial_total"] for s in saida), 2),
        "base_ate": ultimo,
        "linhas": saida,
        "familias_sem_linha": sorted({(l.get("familia") or "?") for l in linhas_fat
                                      if l["_linha"] is None}),
    }


def _fmt(v: float) -> str:
    return f"R$ {v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")


# ── Perdas no funil (CRM) ───────────────────────────────────────────────────────

def _analise_perdas(db) -> dict:
    """Por que a gente perde — por motivo codificado, com concorrente e gap."""
    from app.services.crm_service import MOTIVOS_PERDA
    try:
        rows = db.table("crm_oportunidades").select(
            "motivo_perda_codigo, concorrente, preco_vencedor, valor_estimado, canal"
        ).eq("estagio", "PERDIDO").eq("ativo", True).limit(_LIMITE).execute().data
    except Exception:
        return {"disponivel": False, "motivo": "Tabela do CRM indisponível.",
                "total": 0, "por_motivo": [], "concorrentes": []}

    if not rows:
        return {"disponivel": False,
                "motivo": "Nenhuma oportunidade marcada como perdida ainda. Cada perda registrada com "
                          "motivo, concorrente e preço do vencedor alimenta esta análise.",
                "total": 0, "por_motivo": [], "concorrentes": []}

    por_motivo: dict = {}
    concorrentes: dict = {}
    for r in rows:
        cod = r.get("motivo_perda_codigo") or "OUTRO"
        valor = float(r.get("valor_estimado") or 0)
        m = por_motivo.setdefault(cod, {"codigo": cod, "label": MOTIVOS_PERDA.get(cod, cod),
                                        "qtd": 0, "valor": 0.0})
        m["qtd"] += 1
        m["valor"] += valor
        nome = (r.get("concorrente") or "").strip()
        if nome:
            c = concorrentes.setdefault(nome.upper(), {"nome": nome, "qtd": 0, "valor": 0.0,
                                                       "difs": []})
            c["qtd"] += 1
            c["valor"] += valor
            pv = r.get("preco_vencedor")
            if pv is not None and valor > 0:
                c["difs"].append((valor - float(pv)) / valor * 100)

    for m in por_motivo.values():
        m["valor"] = round(m["valor"], 2)
    for c in concorrentes.values():
        c["valor"] = round(c["valor"], 2)
        difs = c.pop("difs")
        c["gap_medio_pct"] = round(sum(difs) / len(difs), 1) if difs else None

    return {
        "disponivel": True,
        "total": len(rows),
        "por_motivo": sorted(por_motivo.values(), key=lambda x: -x["qtd"]),
        "concorrentes": sorted(concorrentes.values(), key=lambda x: -x["qtd"])[:10],
    }


# ── Dashboard ───────────────────────────────────────────────────────────────────

def dashboard_inteligencia(janela_dias: int = _JANELA_PADRAO) -> dict:
    db = get_service_db()
    hoje = _hoje_brt()

    # Período total analisado: dois janelas iguais, para comparar movimento.
    fim_atual = hoje
    ini_atual = hoje - timedelta(days=janela_dias)
    fim_ant = ini_atual
    ini_ant = ini_atual - timedelta(days=janela_dias)

    vendas_atual = _base_vendas(db, ini_atual, fim_atual)
    vendas_ant = _base_vendas(db, ini_ant, fim_ant)
    todas = vendas_atual + vendas_ant

    cli_atual = _por_cliente(vendas_atual)
    cli_ant = _por_cliente(vendas_ant)

    faturamento_atual = round(sum(l["valor"] for l in vendas_atual), 2)
    faturamento_ant = round(sum(l["valor"] for l in vendas_ant), 2)
    variacao = (round((faturamento_atual - faturamento_ant) / faturamento_ant * 100, 1)
                if faturamento_ant > 0 else None)

    por_canal: dict = {}
    for l in todas:
        c = por_canal.setdefault(l["canal"], {"canal": l["canal"], "valor": 0.0, "nfs": 0,
                                              "licitacao": 0.0})
        c["valor"] += l["valor"]
        c["nfs"] += 1
        if l["licitacao"]:
            c["licitacao"] += l["valor"]
    canais = sorted(({**c, "valor": round(c["valor"], 2), "licitacao": round(c["licitacao"], 2)}
                     for c in por_canal.values()), key=lambda x: -x["valor"])

    return {
        "periodo": {
            "atual": {"inicio": ini_atual.isoformat(), "fim": fim_atual.isoformat(),
                      "faturamento": faturamento_atual, "nfs": len(vendas_atual),
                      "clientes": len(cli_atual)},
            "anterior": {"inicio": ini_ant.isoformat(), "fim": fim_ant.isoformat(),
                         "faturamento": faturamento_ant, "nfs": len(vendas_ant),
                         "clientes": len(cli_ant)},
            "variacao_pct": variacao,
            "janela_dias": janela_dias,
        },
        "escopo": "NF faturada · sem frete · exclui transfer price (grupo), bonificação, amostra e consignado",
        "ticket_medio": round(faturamento_atual / len(vendas_atual), 2) if vendas_atual else 0,
        "canais": canais,
        # Plano por linha para fechar o gap da meta — o bloco que a diretoria lê
        # primeiro. Vem antes por isso.
        "estrategias": estrategias(db),
        "abc": _curva_abc(_por_cliente(todas)),
        "carteira": _movimento_carteira(cli_atual, cli_ant, janela_dias),
        "produtos": _radar_produtos(),
        # 19 meses com custo — a parte estratégica. As de cima são operacionais
        # (o que fazer esta semana); esta responde onde a margem está vazando.
        "rentabilidade": _rentabilidade(db),
        "precos": _precos(db),
        "perdas": _analise_perdas(db),
    }

"""Estoque disponível: foto do PCP de manhã, descontando as OVs do nosso app.

O PCP atualiza o estoque uma vez ao dia (planilha do D365 -> app deles). O nosso
app precisa mostrar o estoque ao longo do dia, então:

    disponível = foto do PCP (manhã) − comprometido pelas OVs

E o comprometido é sempre RECALCULADO das OVs reais, nunca decrementado num
saldo guardado. Saldo mutável acumula desvio e não dá para auditar; recalculando,
o número se autocorrige e a foto da manhã seguinte zera qualquer resíduo.

Quais OVs contam como comprometido
----------------------------------
Descoberto cruzando 3.836 OVs com saída física do D365 contra os status daqui: o
D365 baixa o estoque no FATURAMENTO (antes disso o material continua fisicamente
no estoque; LIBERADO/EM_COTACAO_FRETE apareceram com 0 baixas, EXPEDIDO com 249).

Então conta como comprometido toda OV não cancelada que:
  a) ainda não faturou — o material está na foto do PCP e já tem dono; ou
  b) faturou DEPOIS da foto — estava na foto de hoje e já saiu.

Sem o item (b) o número ficaria otimista durante o dia: material faturado hoje
saiu do estoque, mas a foto da manhã ainda o continha.

O que NÃO conta: OV cancelada, e OV que já havia faturado ANTES da foto — essa
o PCP já descontou, contar de novo seria baixa dupla.
"""
from datetime import date, datetime, timedelta, timezone

from app.core.database import get_service_db
from app.services import pcp_estoque_service

# Status em que o material ainda está fisicamente no estoque (o D365 só baixa no
# faturamento). BLOQUEADO entra: o material continua lá e segue reservado.
_STATUS_ABERTOS = [
    "AGUARD_CREDITO", "LIBERADO", "EM_INVENTARIO", "AGUARD_VERIFICACAO",
    "DIVERGENCIA", "AGUARD_TRATATIVA", "EM_PROCESSO_SISTEMICO",
    "EM_COTACAO_FRETE", "AGUARD_TRANSPORTADORA", "AGUARD_FATURAMENTO",
    "BLOQUEADO",
]
# Já saiu do estoque físico.
_STATUS_FATURADOS = ["FATURADO", "AGUARD_COLETA", "COLETADO", "EXPEDIDO"]

_FAIXA_CRITICO, _FAIXA_ATENCAO, _FAIXA_ADEQUADO, _FAIXA_ALTO = 1.0, 2.0, 6.0, 12.0

# A view do PCP (pa_coverage) não tem coluna "linha" — só família. O app deles
# tem as duas (família = tipo específico do produto; linha = Urologia/Vascular/
# Acessórios). Mapeamento conferido item a item contra a tela deles.
_FAMILIA_LINHA = {
    "BAINHA INTRODUTORA URETERAL": "Urologia",
    "BAINHA SPEED CROSS": "Vascular",
    "BAINHA SPEED CROSS TWIST": "Vascular",
    "CAMERA DE DRENAGEM": "Vascular",
    "CATETER ARTERIAL": "Vascular",
    "CATETER BALAO PTA": "Vascular",
    "CATETER DIAGNOSTICO": "Vascular",
    "CATETER EMBOLECTOMIA": "Vascular",
    "CATETER LACO SNARE": "Vascular",
    "DILATADOR URETERAL": "Urologia",
    "ELETRODO TEMPORARIO": "Vascular",
    "FIBRA LASER UROLOGIA": "Urologia",
    "FIO GUIA HIDROFILICO": "Vascular",
    "FIO GUIA HIDROFILICO UROLOGICO": "Urologia",
    "FIO GUIA TEFLONADO": "Vascular",
    "INSUFLADOR": "Vascular",
    "INTRODUTOR FEMORAL": "Vascular",
    "IRRIGADOR URETERAL": "Urologia",
    "KIT DUPLO J": "Urologia",
    "PIGTAIL CENTIMETRADO": "Vascular",
    "REALCLOSURE": "Vascular",
    "SONDA BASKET": "Urologia",
    "SONDA URETERAL DUPLO J": "Urologia",
    "TUNELIZADOR": "Vascular",
    "URETERESCOPIOS FLEXIVEIS": "Urologia",
}


def _norm_familia(familia) -> str:
    return " ".join((familia or "").strip().upper().split())


def _linha_da_familia(familia) -> str:
    # Sem correspondência (família nova que o PCP ainda não tinha quando
    # conferimos): cai em "Outros" em vez de sumir da lista.
    return _FAMILIA_LINHA.get(_norm_familia(familia), "Outros")


def _hoje_brt() -> date:
    return (datetime.now(timezone.utc) - timedelta(hours=3)).date()


def _status_cobertura(cobertura, consumo_medio: float) -> str:
    if consumo_medio <= 0 or cobertura is None:
        return "SEM_GIRO"
    if cobertura < _FAIXA_CRITICO:
        return "CRITICO"
    if cobertura < _FAIXA_ATENCAO:
        return "ATENCAO"
    if cobertura < _FAIXA_ADEQUADO:
        return "ADEQUADO"
    if cobertura < _FAIXA_ALTO:
        return "ALTO"
    return "EXCESSIVO"


# ── Sincronização da foto do PCP ────────────────────────────────────────────────

def _snapshot_do_dia(db, dia: date) -> list:
    try:
        return db.table("estoque_pcp_snapshot").select("*").eq("data_ref", dia.isoformat()).execute().data
    except Exception:
        # Tabela ainda não migrada (v19) — degrada sem quebrar a tela.
        return []


def sincronizar(forcar: bool = False) -> dict:
    """Grava a foto do PCP do dia. Idempotente: se já existe foto de hoje e
    `forcar` é falso, não faz nada (a primeira abertura do dia sincroniza; o
    botão 'Sincronizar agora' passa forcar=True)."""
    db = get_service_db()
    dia = _hoje_brt()

    existente = _snapshot_do_dia(db, dia)
    if existente and not forcar:
        return {"sincronizou": False, "motivo": "ja_sincronizado_hoje",
                "itens": len(existente), "data_ref": dia.isoformat()}

    if not pcp_estoque_service.integracao_ativa():
        return {"sincronizou": False, "motivo": "integracao_desligada", "itens": 0,
                "data_ref": dia.isoformat()}

    dados = pcp_estoque_service.buscar_cobertura_pcp()
    if not dados:
        # PCP fora do ar: mantém a foto anterior em vez de gravar uma vazia.
        return {"sincronizou": False, "motivo": "pcp_indisponivel",
                "itens": len(existente), "data_ref": dia.isoformat()}

    agora = datetime.now(timezone.utc).isoformat()
    linhas = [{
        "data_ref": dia.isoformat(),
        "codigo": c["codigo"],
        "descricao": c.get("descricao"),
        "familia": c.get("familia"),
        "estoque_pa": c.get("estoque") or 0,
        "estoque_sa": c.get("estoque_sa") or 0,
        "estoque_total": c.get("estoque_total") or 0,
        "consumo_medio": c.get("consumo_medio") or 0,
        "cobertura_meses": c.get("cobertura_meses"),
        "sincronizado_em": agora,
    } for c in dados.values() if c.get("codigo")]

    try:
        if existente:
            # Re-sincronização do mesmo dia: troca a foto (unique data_ref+codigo).
            db.table("estoque_pcp_snapshot").delete().eq("data_ref", dia.isoformat()).execute()
        for i in range(0, len(linhas), 200):
            db.table("estoque_pcp_snapshot").insert(linhas[i:i + 200]).execute()
    except Exception:
        # Tabela ainda não migrada (v19).
        return {"sincronizou": False, "motivo": "tabela_ausente", "itens": 0,
                "data_ref": dia.isoformat()}

    return {"sincronizou": True, "motivo": None, "itens": len(linhas),
            "data_ref": dia.isoformat(), "sincronizado_em": agora}


# ── Comprometido pelas OVs ──────────────────────────────────────────────────────

def _ts_para_filtro(momento: str) -> str:
    """Timestamp em formato seguro para a query string. O offset '+00:00' quebra
    o filtro (o '+' não é escapado e o PostgREST lê como espaço), então usa 'Z'."""
    if not momento:
        return ""
    try:
        dt = datetime.fromisoformat(momento.replace("Z", "+00:00"))
    except Exception:
        return momento.split("+")[0]
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S") + "Z"


def _ovs_faturadas_apos(db, momento: str) -> list:
    """pedido_ids que passaram para FATURADO depois da foto — estavam nela e já
    saíram, então ainda contam como baixa do dia."""
    filtro = _ts_para_filtro(momento)
    if not filtro:
        return []
    movs = db.table("movimentacoes").select("pedido_id, criado_em")\
        .eq("status_novo", "FATURADO").gte("criado_em", filtro).execute().data
    return list({m["pedido_id"] for m in movs if m.get("pedido_id")})


def _comprometido_por_produto(db, sincronizado_em: str) -> dict:
    """produto_id -> qtd comprometida (ver regra no docstring do módulo)."""
    ids = set()
    for i in range(0, len(_STATUS_ABERTOS), 10):
        lote = _STATUS_ABERTOS[i:i + 10]
        for p in db.table("pedidos").select("id").in_("status", lote).execute().data:
            ids.add(p["id"])
    ids.update(_ovs_faturadas_apos(db, sincronizado_em))
    if not ids:
        return {}

    ids = list(ids)
    comprometido: dict = {}
    for i in range(0, len(ids), 40):
        itens = db.table("itens_pedido").select("produto_id, qtd_solicitada")\
            .in_("pedido_id", ids[i:i + 40]).execute().data
        for it in itens:
            pid = it.get("produto_id")
            if pid:
                comprometido[pid] = comprometido.get(pid, 0.0) + float(it.get("qtd_solicitada") or 0)
    return comprometido


def _codigo_por_produto_id(db) -> dict:
    """produto_id -> codigo. O cruzamento com o PCP é pelo código do produto."""
    prods = db.table("produtos").select("id, codigo").execute().data
    return {p["id"]: (p.get("codigo") or "").strip().upper() for p in prods if p.get("codigo")}


def comprometido_detalhe(codigo: str) -> dict:
    """As OVs por trás do número de 'comprometido' de um código — para o usuário
    clicar e ver de onde vem, em vez de confiar cegamente na conta."""
    db = get_service_db()
    cod = (codigo or "").strip().upper()

    produtos = db.table("produtos").select("id").ilike("codigo", cod).execute().data
    produto_ids = [p["id"] for p in produtos]
    if not produto_ids:
        return {"codigo": codigo, "ovs": []}

    dia = _hoje_brt()
    snapshot = _snapshot_do_dia(db, dia)
    if not snapshot:
        ultimas = db.table("estoque_pcp_snapshot").select("data_ref")\
            .order("data_ref", desc=True).limit(1).execute().data
        if ultimas:
            snapshot = _snapshot_do_dia(db, date.fromisoformat(ultimas[0]["data_ref"]))
    sincronizado_em = snapshot[0].get("sincronizado_em") if snapshot else None

    ids_abertos = set()
    for i in range(0, len(_STATUS_ABERTOS), 10):
        lote = _STATUS_ABERTOS[i:i + 10]
        for p in db.table("pedidos").select("id").in_("status", lote).execute().data:
            ids_abertos.add(p["id"])
    ids_faturados_depois = set(_ovs_faturadas_apos(db, sincronizado_em))
    ids_relevantes = ids_abertos | ids_faturados_depois
    if not ids_relevantes:
        return {"codigo": codigo, "ovs": []}

    itens = []
    for i in range(0, len(produto_ids), 40):
        lote = produto_ids[i:i + 40]
        itens += db.table("itens_pedido").select("pedido_id, qtd_solicitada")\
            .in_("produto_id", lote).execute().data
    pedido_ids = [it["pedido_id"] for it in itens if it.get("pedido_id") in ids_relevantes]
    if not pedido_ids:
        return {"codigo": codigo, "ovs": []}

    qtd_por_pedido: dict = {}
    for it in itens:
        pid = it.get("pedido_id")
        if pid in ids_relevantes:
            qtd_por_pedido[pid] = qtd_por_pedido.get(pid, 0.0) + float(it.get("qtd_solicitada") or 0)

    pedidos = []
    for i in range(0, len(pedido_ids), 40):
        pedidos += db.table("pedidos").select("id, numero_pedido, status, cliente_id, criado_em")\
            .in_("id", pedido_ids[i:i + 40]).execute().data
    cliente_ids = list({p["cliente_id"] for p in pedidos if p.get("cliente_id")})
    clientes = {}
    for i in range(0, len(cliente_ids), 40):
        for c in db.table("clientes").select("id, nome").in_("id", cliente_ids[i:i + 40]).execute().data:
            clientes[c["id"]] = c.get("nome")

    ovs = [{
        "pedido_id": p["id"],
        "numero_pedido": p.get("numero_pedido"),
        "status": p.get("status"),
        "cliente": clientes.get(p.get("cliente_id")),
        "qtd": round(qtd_por_pedido.get(p["id"], 0.0)),
        "criado_em": p.get("criado_em"),
        "faturada_depois_da_foto": p.get("status") not in _STATUS_ABERTOS,
    } for p in pedidos]
    ovs.sort(key=lambda o: o["criado_em"] or "", reverse=True)
    return {"codigo": codigo, "ovs": ovs}


# ── Consulta ────────────────────────────────────────────────────────────────────

def listar(sincronizar_se_preciso: bool = True) -> dict:
    """Estoque disponível por item: foto do PCP menos o comprometido pelas OVs."""
    db = get_service_db()
    dia = _hoje_brt()

    sync = None
    if sincronizar_se_preciso:
        sync = sincronizar()

    snapshot = _snapshot_do_dia(db, dia)
    if not snapshot:
        # Sem foto de hoje (PCP fora do ar na 1ª abertura, ou integração
        # desligada): cai para a última foto disponível, sinalizando a data.
        try:
            ultimas = db.table("estoque_pcp_snapshot").select("data_ref")\
                .order("data_ref", desc=True).limit(1).execute().data
        except Exception:
            ultimas = []
        if not ultimas:
            return {"itens": [], "data_ref": None, "sincronizado_em": None,
                    "desatualizado": True, "sync": sync,
                    "integracao": pcp_estoque_service.integracao_ativa()}
        dia = date.fromisoformat(ultimas[0]["data_ref"])
        snapshot = _snapshot_do_dia(db, dia)

    sincronizado_em = snapshot[0].get("sincronizado_em") if snapshot else None
    comprometido_por_pid = _comprometido_por_produto(db, sincronizado_em)

    # Agrupa o comprometido por código (o snapshot é por código).
    cod_por_pid = _codigo_por_produto_id(db)
    comprometido_por_codigo: dict = {}
    for pid, qtd in comprometido_por_pid.items():
        cod = cod_por_pid.get(pid)
        if cod:
            comprometido_por_codigo[cod] = comprometido_por_codigo.get(cod, 0.0) + qtd

    itens = []
    for row in snapshot:
        cod = (row.get("codigo") or "").strip().upper()
        pa = float(row.get("estoque_pa") or 0)
        sa = float(row.get("estoque_sa") or 0)
        comp = comprometido_por_codigo.get(cod, 0.0)
        # Pode ficar negativo: a foto é de manhã e mais OVs entraram do que havia
        # material. Mostrar negativo é o sinal, não um erro para esconder.
        disponivel = pa - comp
        consumo = float(row.get("consumo_medio") or 0)
        cobertura_pcp = row.get("cobertura_meses")
        cobertura_pcp = float(cobertura_pcp) if cobertura_pcp is not None else None
        # Cobertura do disponível (PA+SA já comprometidos descontados), que é a
        # que responde "por quanto tempo ainda dá conta".
        cob_disp = round((disponivel + sa) / consumo, 1) if consumo > 0 else None
        itens.append({
            "codigo": row.get("codigo"),
            "descricao": row.get("descricao"),
            "familia": row.get("familia"),
            "linha": _linha_da_familia(row.get("familia")),
            "estoque_pcp": round(pa),
            "estoque_sa": round(sa),
            "comprometido": round(comp),
            "disponivel": round(disponivel),
            "consumo_medio": round(consumo, 1),
            "cobertura_pcp": cobertura_pcp,
            "cobertura_disponivel": cob_disp,
            "status": _status_cobertura(cob_disp, consumo),
        })

    itens.sort(key=lambda i: (i["cobertura_disponivel"] is None, i["cobertura_disponivel"] or 0))
    return {
        "itens": itens,
        "data_ref": dia.isoformat(),
        "sincronizado_em": sincronizado_em,
        "desatualizado": dia != _hoje_brt(),
        "sync": sync,
        "integracao": pcp_estoque_service.integracao_ativa(),
    }

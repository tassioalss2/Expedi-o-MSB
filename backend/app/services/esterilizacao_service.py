import math
from datetime import date, datetime, timezone
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.enums_esterilizacao import (
    STATUS_ENCERRADOS,
    TRANSICOES_CARGA,
    StatusCarga,
)
from app.models.schemas_esterilizacao import (
    CargaCreate,
    CargaUpdate,
    ItemCargaCreate,
    LiberarCargaRequest,
    ReplanejamentoRequest,
    RegistrarEnvioRequest,
    RegistrarRetornoRequest,
    SimularCargaRequest,
)


# ── Utilitários ───────────────────────────────────────────────────────────────

def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _hoje() -> date:
    return date.today()


def _gerar_numero_carga() -> str:
    db = get_service_db()
    hoje = _hoje()
    prefixo = f"EST-{hoje.year}-"
    result = db.table("cargas_esterilizacao").select("numero_carga").ilike("numero_carga", f"{prefixo}%").execute()
    existentes = result.data or []
    if not existentes:
        return f"{prefixo}001"
    numeros = []
    for r in existentes:
        try:
            numeros.append(int(r["numero_carga"].split("-")[-1]))
        except (ValueError, IndexError):
            pass
    proximo = (max(numeros) + 1) if numeros else 1
    return f"{prefixo}{proximo:03d}"


def _calcular_item(codigo_sa: str, quantidade: int, tipo_caixa_override: Optional[str] = None) -> dict:
    db = get_service_db()
    produto = db.table("produtos_estereis").select("*").eq("codigo_sa", codigo_sa).single().execute().data
    if not produto:
        raise HTTPException(status_code=404, detail=f"Produto SA '{codigo_sa}' não encontrado no cadastro de produtos estéreis")

    tipo_caixa = tipo_caixa_override or produto.get("tipo_caixa_padrao") or "VERDE"

    qtd_por_cx_map = {
        "VERDE":    produto.get("qtd_padrao_cx_verde"),
        "BRANCA":   produto.get("qtd_padrao_cx_branca"),
        "AMARELA":  produto.get("qtd_padrao_cx_amarela"),
        "VERMELHA": produto.get("qtd_padrao_cx_vermelha"),
    }
    qtd_por_cx = qtd_por_cx_map.get(tipo_caixa) or 1
    quantidade_caixas = math.ceil(quantidade / qtd_por_cx)

    tempo_prod_seg = produto.get("tempo_producao_seg") or 0
    tempo_sep_seg = produto.get("tempo_separacao_seg") or 0
    tempo_prod_total_min = int((quantidade * tempo_prod_seg) / 60)
    tempo_sep_total_min = int((quantidade * tempo_sep_seg) / 60)
    valor_unit = float(produto.get("valor_unitario") or 0)

    return {
        "codigo_sa":                   codigo_sa,
        "codigo_pa":                   produto.get("codigo_pa"),
        "descricao_produto":           produto.get("descricao"),
        "familia":                     produto.get("familia"),
        "quantidade":                  quantidade,
        "quantidade_por_caixa":        qtd_por_cx,
        "tipo_caixa":                  tipo_caixa,
        "quantidade_caixas":           quantidade_caixas,
        "valor_unitario":              valor_unit,
        "valor_total":                 round(quantidade * valor_unit, 2),
        "tempo_producao_unitario_seg": tempo_prod_seg,
        "tempo_separacao_unitario_seg":tempo_sep_seg,
        "tempo_producao_total_min":    tempo_prod_total_min,
        "tempo_separacao_total_min":   tempo_sep_total_min,
        "tempo_total_min":             tempo_prod_total_min + tempo_sep_total_min,
    }


def _totais_dos_itens(itens: list[dict]) -> dict:
    total_pecas = sum(i["quantidade"] for i in itens)
    total_caixas = sum(i.get("quantidade_caixas") or 0 for i in itens)
    total_valor = sum(float(i.get("valor_total") or 0) for i in itens)
    total_tempo = sum(i.get("tempo_total_min") or 0 for i in itens)
    return {
        "quantidade_total_pecas":   total_pecas,
        "quantidade_total_caixas":  total_caixas,
        "valor_total":              round(total_valor, 2),
        "tempo_total_estimado_min": total_tempo,
    }


def _enriquecer_carga(carga: dict, itens: Optional[list] = None) -> dict:
    hoje = _hoje()
    status = carga.get("status", "")
    data_saida_str = carga.get("data_saida_prevista")
    data_saida = date.fromisoformat(data_saida_str) if data_saida_str else None

    atrasada = (
        data_saida is not None
        and data_saida < hoje
        and status not in {s.value for s in STATUS_ENCERRADOS}
    )

    dias_para_saida = None
    if data_saida:
        dias_para_saida = (data_saida - hoje).days

    carga["atrasada"] = atrasada
    carga["dias_para_saida"] = dias_para_saida

    if itens is not None:
        carga["itens"] = itens
        familias = [i.get("familia") for i in itens if i.get("familia")]
        if familias:
            from collections import Counter
            carga["familia_principal"] = Counter(familias).most_common(1)[0][0]
        else:
            carga["familia_principal"] = None
    else:
        carga["itens"] = []
        carga["familia_principal"] = None

    return carga


def _registrar_historico(id_carga: str, campo: str, anterior, novo, usuario: str, motivo: Optional[str] = None):
    db = get_service_db()
    db.table("historico_carga").insert({
        "id_carga":       id_carga,
        "campo_alterado": campo,
        "valor_anterior": str(anterior) if anterior is not None else None,
        "valor_novo":     str(novo) if novo is not None else None,
        "usuario":        usuario,
        "motivo":         motivo,
        "criado_em":      _agora(),
    }).execute()


# ── Produtos Estéreis ─────────────────────────────────────────────────────────

def listar_produtos(familia: Optional[str] = None, busca: Optional[str] = None, ativo_only: bool = True):
    db = get_service_db()
    q = db.table("produtos_estereis").select("*").order("descricao")
    if ativo_only:
        q = q.eq("ativo", True)
    if familia:
        q = q.eq("familia", familia)
    result = q.execute()
    produtos = result.data or []
    if busca:
        busca_lower = busca.lower()
        produtos = [
            p for p in produtos
            if busca_lower in (p.get("descricao") or "").lower()
            or busca_lower in (p.get("codigo_sa") or "").lower()
            or busca_lower in (p.get("codigo_pa") or "").lower()
        ]
    return produtos


def criar_produto(payload, usuario_nome: str):
    db = get_service_db()
    existe = db.table("produtos_estereis").select("codigo_sa").eq("codigo_sa", payload.codigo_sa).execute()
    if existe.data:
        raise HTTPException(status_code=400, detail=f"Código SA '{payload.codigo_sa}' já cadastrado")
    data = payload.model_dump()
    if data.get("tipo_caixa_padrao"):
        data["tipo_caixa_padrao"] = data["tipo_caixa_padrao"].value if hasattr(data["tipo_caixa_padrao"], "value") else data["tipo_caixa_padrao"]
    result = db.table("produtos_estereis").insert(data).execute()
    return result.data[0]


def atualizar_produto(codigo_sa: str, payload, usuario_nome: str):
    db = get_service_db()
    existe = db.table("produtos_estereis").select("codigo_sa").eq("codigo_sa", codigo_sa).execute()
    if not existe.data:
        raise HTTPException(status_code=404, detail="Produto não encontrado")
    data = {k: v for k, v in payload.model_dump().items() if v is not None}
    if "tipo_caixa_padrao" in data and hasattr(data["tipo_caixa_padrao"], "value"):
        data["tipo_caixa_padrao"] = data["tipo_caixa_padrao"].value
    db.table("produtos_estereis").update(data).eq("codigo_sa", codigo_sa).execute()
    return db.table("produtos_estereis").select("*").eq("codigo_sa", codigo_sa).single().execute().data


def familias_disponiveis() -> list[str]:
    db = get_service_db()
    result = db.table("produtos_estereis").select("familia").eq("ativo", True).execute()
    familias = sorted({r["familia"] for r in (result.data or []) if r.get("familia")})
    return familias


# ── Cargas ────────────────────────────────────────────────────────────────────

def criar_carga(payload: CargaCreate, usuario_nome: str) -> dict:
    if not payload.itens:
        raise HTTPException(status_code=422, detail="A carga precisa ter pelo menos um item")

    db = get_service_db()
    numero_carga = _gerar_numero_carga()
    hoje = _hoje()
    mes = payload.data_saida_prevista.month
    semana = payload.data_saida_prevista.isocalendar()[1]
    ano = payload.data_saida_prevista.year

    # Calcula itens enriquecidos
    itens_calculados = []
    for item in payload.itens:
        tipo_cx = item.tipo_caixa.value if item.tipo_caixa else None
        calc = _calcular_item(item.codigo_sa, item.quantidade, tipo_cx)
        calc["modelo_carga"] = item.modelo_carga
        calc["observacao"] = item.observacao
        itens_calculados.append(calc)

    totais = _totais_dos_itens(itens_calculados)

    carga_data = {
        "numero_carga":              numero_carga,
        "mes_referencia":            mes,
        "semana_referencia":         semana,
        "ano_referencia":            ano,
        "data_saida_prevista":       payload.data_saida_prevista.isoformat(),
        "data_retorno_prevista":     payload.data_retorno_prevista.isoformat() if payload.data_retorno_prevista else None,
        "data_inicio_planejada":     payload.data_inicio_planejada.isoformat() if payload.data_inicio_planejada else None,
        "hora_inicio_planejada":     str(payload.hora_inicio_planejada) if payload.hora_inicio_planejada else None,
        "status":                    StatusCarga.PLANEJADA.value,
        "prioridade":                payload.prioridade.value,
        "responsavel_planejamento":  payload.responsavel_planejamento,
        "responsavel_operacao":      payload.responsavel_operacao,
        "observacao":                payload.observacao,
        "criado_em":                 _agora(),
        **totais,
    }
    result = db.table("cargas_esterilizacao").insert(carga_data).execute()
    carga = result.data[0]
    id_carga = carga["id"]

    # Insere itens
    for item_calc in itens_calculados:
        item_calc["id_carga"] = id_carga
        item_calc["criado_em"] = _agora()
    db.table("itens_carga").insert(itens_calculados).execute()

    _registrar_historico(id_carga, "status", None, StatusCarga.PLANEJADA.value, usuario_nome, "Carga criada")

    return obter_carga(id_carga)


def listar_cargas(
    status: Optional[str] = None,
    mes: Optional[int] = None,
    ano: Optional[int] = None,
    prioridade: Optional[str] = None,
    atrasadas: Optional[bool] = None,
    data_saida_inicio: Optional[date] = None,
    data_saida_fim: Optional[date] = None,
) -> list[dict]:
    db = get_service_db()
    q = db.table("cargas_esterilizacao").select("*").order("data_saida_prevista")

    if status:
        q = q.eq("status", status)
    if mes:
        q = q.eq("mes_referencia", mes)
    if ano:
        q = q.eq("ano_referencia", ano)
    if prioridade:
        q = q.eq("prioridade", prioridade)
    if data_saida_inicio:
        q = q.gte("data_saida_prevista", data_saida_inicio.isoformat())
    if data_saida_fim:
        q = q.lte("data_saida_prevista", data_saida_fim.isoformat())

    cargas = q.execute().data or []

    # Enriquece com itens para família principal
    resultado = []
    for c in cargas:
        itens_res = db.table("itens_carga").select("familia, quantidade").eq("id_carga", c["id"]).execute()
        itens = itens_res.data or []
        c = _enriquecer_carga(c, itens)
        if atrasadas is True and not c["atrasada"]:
            continue
        if atrasadas is False and c["atrasada"]:
            continue
        resultado.append(c)

    return resultado


def obter_carga(id_carga: str) -> dict:
    db = get_service_db()
    carga_res = db.table("cargas_esterilizacao").select("*").eq("id", id_carga).single().execute()
    if not carga_res.data:
        raise HTTPException(status_code=404, detail="Carga não encontrada")
    carga = carga_res.data

    itens_res = db.table("itens_carga").select("*").eq("id_carga", id_carga).execute()
    itens = itens_res.data or []

    return _enriquecer_carga(carga, itens)


def atualizar_carga(id_carga: str, payload: CargaUpdate, usuario_nome: str) -> dict:
    db = get_service_db()
    carga_atual = db.table("cargas_esterilizacao").select("*").eq("id", id_carga).single().execute().data
    if not carga_atual:
        raise HTTPException(status_code=404, detail="Carga não encontrada")

    if carga_atual["status"] in (StatusCarga.CANCELADA.value, StatusCarga.RETORNADA.value):
        raise HTTPException(status_code=422, detail="Carga encerrada não pode ser alterada")

    campos = payload.model_dump(exclude_none=True)
    if "data_saida_prevista" in campos:
        campos["data_saida_prevista"] = campos["data_saida_prevista"].isoformat()
        if payload.motivo_replanejamento is None:
            raise HTTPException(status_code=422, detail="Replanejamento de data exige justificativa (motivo_replanejamento)")
        _registrar_historico(id_carga, "data_saida_prevista",
                             carga_atual["data_saida_prevista"],
                             campos["data_saida_prevista"],
                             usuario_nome, payload.motivo_replanejamento)
    if "data_inicio_planejada" in campos:
        campos["data_inicio_planejada"] = campos["data_inicio_planejada"].isoformat()
    if "data_retorno_prevista" in campos:
        campos["data_retorno_prevista"] = campos["data_retorno_prevista"].isoformat()
    if "hora_inicio_planejada" in campos:
        campos["hora_inicio_planejada"] = str(campos["hora_inicio_planejada"])
    if "prioridade" in campos and hasattr(campos["prioridade"], "value"):
        campos["prioridade"] = campos["prioridade"].value

    db.table("cargas_esterilizacao").update(campos).eq("id", id_carga).execute()
    return obter_carga(id_carga)


def liberar_carga(id_carga: str, payload: LiberarCargaRequest, usuario_nome: str) -> dict:
    db = get_service_db()
    carga = db.table("cargas_esterilizacao").select("*").eq("id", id_carga).single().execute().data
    if not carga:
        raise HTTPException(status_code=404, detail="Carga não encontrada")

    if carga["status"] != StatusCarga.PLANEJADA.value:
        raise HTTPException(status_code=422, detail=f"Apenas cargas 'PLANEJADA' podem ser liberadas. Status atual: {carga['status']}")

    itens = db.table("itens_carga").select("id").eq("id_carga", id_carga).execute().data or []
    if not itens:
        raise HTTPException(status_code=422, detail="Não é possível liberar carga sem itens")

    db.table("cargas_esterilizacao").update({
        "status": StatusCarga.LIBERADA.value,
        "responsavel_planejamento": payload.responsavel,
    }).eq("id", id_carga).execute()

    _registrar_historico(id_carga, "status", StatusCarga.PLANEJADA.value, StatusCarga.LIBERADA.value,
                         usuario_nome, f"Liberada por {payload.responsavel}")
    return obter_carga(id_carga)


def alterar_status(id_carga: str, novo_status: StatusCarga, usuario_nome: str, observacao: Optional[str] = None) -> dict:
    db = get_service_db()
    carga = db.table("cargas_esterilizacao").select("*").eq("id", id_carga).single().execute().data
    if not carga:
        raise HTTPException(status_code=404, detail="Carga não encontrada")

    status_atual = StatusCarga(carga["status"])
    transicoes_ok = TRANSICOES_CARGA.get(status_atual, [])

    if novo_status not in transicoes_ok:
        raise HTTPException(
            status_code=422,
            detail=f"Transição de '{status_atual.value}' para '{novo_status.value}' não permitida"
        )

    atualizacao = {"status": novo_status.value}
    db.table("cargas_esterilizacao").update(atualizacao).eq("id", id_carga).execute()
    _registrar_historico(id_carga, "status", status_atual.value, novo_status.value, usuario_nome, observacao)
    return obter_carga(id_carga)


def bloquear_carga(id_carga: str, motivo: str, usuario_nome: str) -> dict:
    db = get_service_db()
    carga = db.table("cargas_esterilizacao").select("*").eq("id", id_carga).single().execute().data
    if not carga:
        raise HTTPException(status_code=404, detail="Carga não encontrada")
    if not motivo or not motivo.strip():
        raise HTTPException(status_code=422, detail="Motivo de bloqueio é obrigatório")

    status_atual = carga["status"]
    db.table("cargas_esterilizacao").update({
        "status": StatusCarga.BLOQUEADA.value,
        "motivo_bloqueio": motivo,
    }).eq("id", id_carga).execute()
    _registrar_historico(id_carga, "status", status_atual, StatusCarga.BLOQUEADA.value, usuario_nome, motivo)
    return obter_carga(id_carga)


def registrar_envio(id_carga: str, payload: RegistrarEnvioRequest, usuario_nome: str) -> dict:
    db = get_service_db()
    carga = db.table("cargas_esterilizacao").select("*").eq("id", id_carga).single().execute().data
    if not carga:
        raise HTTPException(status_code=404, detail="Carga não encontrada")
    if carga["status"] != StatusCarga.PRONTA.value:
        raise HTTPException(status_code=422, detail="Apenas cargas 'PRONTA' podem ser enviadas para Esterilize")

    db.table("cargas_esterilizacao").update({
        "status": StatusCarga.ENVIADA.value,
        "data_saida_real": payload.data_saida_real.isoformat(),
    }).eq("id", id_carga).execute()
    _registrar_historico(id_carga, "status", StatusCarga.PRONTA.value, StatusCarga.ENVIADA.value,
                         usuario_nome, payload.observacao or "Enviada para Esterilize")
    return obter_carga(id_carga)


def registrar_retorno(id_carga: str, payload: RegistrarRetornoRequest, usuario_nome: str) -> dict:
    db = get_service_db()
    carga = db.table("cargas_esterilizacao").select("*").eq("id", id_carga).single().execute().data
    if not carga:
        raise HTTPException(status_code=404, detail="Carga não encontrada")
    if carga["status"] != StatusCarga.ENVIADA.value:
        raise HTTPException(status_code=422, detail="Apenas cargas 'ENVIADA' podem ter retorno registrado")

    db.table("cargas_esterilizacao").update({
        "status": StatusCarga.RETORNADA.value,
        "data_retorno_real": payload.data_retorno_real.isoformat(),
    }).eq("id", id_carga).execute()
    _registrar_historico(id_carga, "status", StatusCarga.ENVIADA.value, StatusCarga.RETORNADA.value,
                         usuario_nome, payload.observacao or "Retornada da Esterilize")
    return obter_carga(id_carga)


def adicionar_item(id_carga: str, payload: ItemCargaCreate, usuario_nome: str) -> dict:
    db = get_service_db()
    carga = db.table("cargas_esterilizacao").select("*").eq("id", id_carga).single().execute().data
    if not carga:
        raise HTTPException(status_code=404, detail="Carga não encontrada")
    if carga["status"] not in (StatusCarga.PLANEJADA.value, StatusCarga.LIBERADA.value):
        raise HTTPException(status_code=422, detail="Itens só podem ser adicionados em cargas PLANEJADA ou LIBERADA")

    existente = db.table("itens_carga").select("id").eq("id_carga", id_carga).eq("codigo_sa", payload.codigo_sa).execute()
    if existente.data:
        raise HTTPException(status_code=400, detail=f"Código SA '{payload.codigo_sa}' já está nesta carga")

    tipo_cx = payload.tipo_caixa.value if payload.tipo_caixa else None
    calc = _calcular_item(payload.codigo_sa, payload.quantidade, tipo_cx)
    calc["id_carga"] = id_carga
    calc["modelo_carga"] = payload.modelo_carga
    calc["observacao"] = payload.observacao
    calc["criado_em"] = _agora()

    db.table("itens_carga").insert(calc).execute()
    _recalcular_totais_carga(id_carga)
    _registrar_historico(id_carga, "item_adicionado", None, payload.codigo_sa, usuario_nome)
    return obter_carga(id_carga)


def remover_item(id_carga: str, item_id: str, usuario_nome: str) -> dict:
    db = get_service_db()
    carga = db.table("cargas_esterilizacao").select("status").eq("id", id_carga).single().execute().data
    if not carga:
        raise HTTPException(status_code=404, detail="Carga não encontrada")
    if carga["status"] not in (StatusCarga.PLANEJADA.value, StatusCarga.LIBERADA.value):
        raise HTTPException(status_code=422, detail="Itens só podem ser removidos de cargas PLANEJADA ou LIBERADA")

    item = db.table("itens_carga").select("codigo_sa").eq("id", item_id).eq("id_carga", id_carga).execute()
    if not item.data:
        raise HTTPException(status_code=404, detail="Item não encontrado nesta carga")

    db.table("itens_carga").delete().eq("id", item_id).execute()
    _recalcular_totais_carga(id_carga)
    _registrar_historico(id_carga, "item_removido", item.data[0]["codigo_sa"], None, usuario_nome)
    return obter_carga(id_carga)


def _recalcular_totais_carga(id_carga: str):
    db = get_service_db()
    itens = db.table("itens_carga").select("*").eq("id_carga", id_carga).execute().data or []
    totais = _totais_dos_itens(itens)
    db.table("cargas_esterilizacao").update(totais).eq("id", id_carga).execute()


# ── Apontamentos ──────────────────────────────────────────────────────────────

def iniciar_etapa(id_carga: str, etapa: str, operador: str, usuario_nome: str) -> dict:
    db = get_service_db()
    carga = db.table("cargas_esterilizacao").select("status").eq("id", id_carga).single().execute().data
    if not carga:
        raise HTTPException(status_code=404, detail="Carga não encontrada")

    apontamento = {
        "id_carga":    id_carga,
        "etapa":       etapa,
        "operador":    operador,
        "data_inicio": _agora(),
        "status":      "INICIADO",
        "criado_em":   _agora(),
    }
    result = db.table("apontamentos_carga").insert(apontamento).execute()

    # Progride status automaticamente conforme etapa
    mapa_etapa_status = {
        "PRODUCAO":    StatusCarga.EM_PRODUCAO,
        "SEPARACAO":   StatusCarga.EM_SEPARACAO,
        "CONFERENCIA": StatusCarga.EM_CONFERENCIA,
    }
    novo_status = mapa_etapa_status.get(etapa)
    if novo_status and carga["status"] not in (novo_status.value,):
        try:
            alterar_status(id_carga, novo_status, usuario_nome, f"Etapa {etapa} iniciada por {operador}")
        except HTTPException:
            pass  # se a transição não for permitida, apenas registra o apontamento

    return result.data[0]


def concluir_etapa(id_carga: str, apontamento_id: str, observacao: Optional[str],
                   problema: Optional[str], usuario_nome: str) -> dict:
    db = get_service_db()
    apt = db.table("apontamentos_carga").select("*").eq("id", apontamento_id).eq("id_carga", id_carga).single().execute().data
    if not apt:
        raise HTTPException(status_code=404, detail="Apontamento não encontrado")

    agora = _agora()
    inicio = datetime.fromisoformat(apt["data_inicio"].replace("Z", "+00:00"))
    fim = datetime.fromisoformat(agora.replace("Z", "+00:00"))
    duracao_min = int((fim - inicio).total_seconds() / 60)

    db.table("apontamentos_carga").update({
        "data_fim":         agora,
        "duracao_real_min": duracao_min,
        "status":           "CONCLUIDO",
        "observacao":       observacao,
        "problema_reportado": problema,
    }).eq("id", apontamento_id).execute()

    return db.table("apontamentos_carga").select("*").eq("id", apontamento_id).single().execute().data


def listar_apontamentos(id_carga: str) -> list[dict]:
    db = get_service_db()
    result = db.table("apontamentos_carga").select("*").eq("id_carga", id_carga).order("data_inicio", desc=True).execute()
    return result.data or []


# ── Histórico ─────────────────────────────────────────────────────────────────

def listar_historico(id_carga: str) -> list[dict]:
    db = get_service_db()
    result = db.table("historico_carga").select("*").eq("id_carga", id_carga).order("criado_em", desc=True).execute()
    return result.data or []


# ── Simulação ─────────────────────────────────────────────────────────────────

def simular_carga(payload: SimularCargaRequest) -> dict:
    itens_out = []
    alertas = []
    total_pecas = 0
    total_caixas = 0
    total_valor = 0.0
    total_tempo_prod = 0
    total_tempo_sep = 0

    for item in payload.itens:
        tipo_cx = item.tipo_caixa.value if item.tipo_caixa else None
        try:
            calc = _calcular_item(item.codigo_sa, item.quantidade, tipo_cx)
        except HTTPException as e:
            alertas.append(f"SA '{item.codigo_sa}': {e.detail}")
            continue

        if not calc["quantidade_por_caixa"]:
            alertas.append(f"SA '{item.codigo_sa}': sem quantidade padrão por caixa cadastrada")
        if not calc["tempo_producao_unitario_seg"] and not calc["tempo_separacao_unitario_seg"]:
            alertas.append(f"SA '{item.codigo_sa}': sem tempo padrão cadastrado — estimativa pode estar incorreta")

        itens_out.append({
            "codigo_sa":                  calc["codigo_sa"],
            "descricao":                  calc["descricao_produto"],
            "quantidade":                 calc["quantidade"],
            "quantidade_por_caixa":       calc["quantidade_por_caixa"],
            "tipo_caixa":                 calc["tipo_caixa"],
            "quantidade_caixas":          calc["quantidade_caixas"],
            "tempo_producao_total_min":   calc["tempo_producao_total_min"],
            "tempo_separacao_total_min":  calc["tempo_separacao_total_min"],
            "tempo_total_min":            calc["tempo_total_min"],
            "valor_total":                calc["valor_total"],
        })

        total_pecas += calc["quantidade"]
        total_caixas += calc["quantidade_caixas"]
        total_valor += calc["valor_total"]
        total_tempo_prod += calc["tempo_producao_total_min"]
        total_tempo_sep += calc["tempo_separacao_total_min"]

    total_tempo = total_tempo_prod + total_tempo_sep
    horas_dia = 8 * 60
    dias_necessarios = round(total_tempo / horas_dia, 1) if horas_dia else 0

    return {
        "itens":                    itens_out,
        "total_pecas":              total_pecas,
        "total_caixas":             total_caixas,
        "total_tempo_producao_min": total_tempo_prod,
        "total_tempo_separacao_min":total_tempo_sep,
        "total_tempo_min":          total_tempo,
        "total_valor":              round(total_valor, 2),
        "dias_necessarios":         dias_necessarios,
        "alertas":                  alertas,
    }


# ── Dashboard ─────────────────────────────────────────────────────────────────

def dashboard(mes: int, ano: int) -> dict:
    db = get_service_db()
    cargas = db.table("cargas_esterilizacao").select("*").eq("mes_referencia", mes).eq("ano_referencia", ano).execute().data or []

    hoje = _hoje()
    contagem: dict[str, int] = {}
    atrasadas = 0
    total_pecas = 0
    total_caixas = 0
    valor_mes = 0.0
    cargas_enviadas_no_prazo = 0
    total_enviadas = 0
    soma_ciclo = 0
    cnt_ciclo = 0

    for c in cargas:
        status = c.get("status", "")
        contagem[status] = contagem.get(status, 0) + 1
        total_pecas += c.get("quantidade_total_pecas") or 0
        total_caixas += c.get("quantidade_total_caixas") or 0
        valor_mes += float(c.get("valor_total") or 0)

        # Atraso
        ds = c.get("data_saida_prevista")
        if ds and status not in {s.value for s in STATUS_ENCERRADOS}:
            if date.fromisoformat(ds) < hoje:
                atrasadas += 1

        # Aderência ao plano
        if status in (StatusCarga.ENVIADA.value, StatusCarga.RETORNADA.value):
            total_enviadas += 1
            ds_prev = c.get("data_saida_prevista")
            ds_real = c.get("data_saida_real")
            if ds_prev and ds_real and date.fromisoformat(ds_real) <= date.fromisoformat(ds_prev):
                cargas_enviadas_no_prazo += 1

        # Ciclo médio
        criado = c.get("criado_em")
        ds_real = c.get("data_saida_real")
        if criado and ds_real:
            try:
                t0 = datetime.fromisoformat(criado.replace("Z", "+00:00"))
                t1 = datetime.fromisoformat(ds_real + "T00:00:00+00:00")
                soma_ciclo += (t1 - t0).total_seconds() / 60
                cnt_ciclo += 1
            except Exception:
                pass

    aderencia = round((cargas_enviadas_no_prazo / total_enviadas * 100), 1) if total_enviadas else 0.0
    ciclo_medio = round(soma_ciclo / cnt_ciclo, 0) if cnt_ciclo else None

    return {
        "mes_referencia":        mes,
        "ano_referencia":        ano,
        "total_cargas":          len(cargas),
        "planejadas":            contagem.get("PLANEJADA", 0),
        "liberadas":             contagem.get("LIBERADA", 0),
        "em_producao":           contagem.get("EM_PRODUCAO", 0),
        "em_separacao":          contagem.get("EM_SEPARACAO", 0),
        "em_conferencia":        contagem.get("EM_CONFERENCIA", 0),
        "prontas":               contagem.get("PRONTA", 0),
        "enviadas":              contagem.get("ENVIADA", 0),
        "retornadas":            contagem.get("RETORNADA", 0),
        "atrasadas":             atrasadas,
        "bloqueadas":            contagem.get("BLOQUEADA", 0),
        "canceladas":            contagem.get("CANCELADA", 0),
        "total_pecas_mes":       total_pecas,
        "total_caixas_mes":      total_caixas,
        "valor_total_mes":       round(valor_mes, 2),
        "aderencia_plan":        aderencia,
        "tempo_medio_ciclo_min": ciclo_medio,
    }

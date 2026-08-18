"""CRM · Cotações / Propostas comerciais.

Gera cotações a partir de uma oportunidade (ou avulsas), com itens, descontos,
frete e condições. Calcula totais no servidor. O status ACEITA pode marcar a
oportunidade vinculada como ganha.

Toda cotação nasce PERSISTIDA (mesmo em rascunho): a proposta impressa é sempre
reimprimível pela aba Cotações, sem depender de a aba de impressão ficar aberta.
"""
from datetime import datetime, timedelta, timezone
from typing import Optional

from fastapi import HTTPException

from app.core.database import get_service_db
from app.models.schemas import CotacaoCreate, CotacaoUpdate, UsuarioOut

_STATUS = ["RASCUNHO", "ENVIADA", "ACEITA", "RECUSADA"]

# Validade sugerida da proposta. É recomendação, não regra: o comercial altera
# livremente — preço de importado muda, e às vezes o cliente pede prazo maior.
VALIDADE_SUGERIDA_DIAS = 15

# Campos que o modelo de orçamento imprime e que nem sempre existem no cadastro.
# Não bloqueiam nada: a proposta sai sem eles. Servem para a tela pedir.
_CAMPOS_PROPOSTA = [
    ("cliente", "Razão social do cliente"),
    ("cliente_cnpj", "CNPJ"),
    ("endereco", "Endereço"),
    ("endereco_cidade", "Cidade"),
    ("endereco_uf", "UF"),
    ("contato_nome", "Nome do contato"),
    ("contato_email", "E-mail do contato"),
    ("condicao_pagamento", "Condição de pagamento"),
    ("prazo_entrega", "Prazo de entrega"),
    ("validade", "Validade da proposta"),
]


def validade_sugerida() -> str:
    return (datetime.now(timezone.utc) + timedelta(days=VALIDADE_SUGERIDA_DIAS)).date().isoformat()


def _agora() -> str:
    return datetime.now(timezone.utc).isoformat()


def _gerar_numero(db) -> str:
    existentes = db.table("crm_cotacoes").select("id").execute().data
    return f"COT-{len(existentes) + 1:04d}"


def _totais(itens: list, frete: float, desconto_pct: float) -> tuple:
    bruto = 0.0
    for it in itens:
        q = float(it.get("qtd") or 0)
        vu = float(it.get("valor_unitario") or 0)
        dpct = float(it.get("desconto_pct") or 0)
        bruto += q * vu * (1 - dpct / 100)
    total = bruto * (1 - float(desconto_pct or 0) / 100) + float(frete or 0)
    return round(bruto, 2), round(total, 2)


def _itens_in(itens, cotacao_id: str) -> list:
    out = []
    for it in itens or []:
        out.append({
            "cotacao_id": cotacao_id,
            "produto_id": str(it.produto_id) if it.produto_id else None,
            "codigo": it.codigo,
            "descricao": it.descricao,
            "qtd": float(it.qtd or 0),
            "valor_unitario": float(it.valor_unitario or 0),
            "desconto_pct": float(it.desconto_pct or 0),
        })
    return out


def _serializar(c: dict, itens: Optional[list] = None) -> dict:
    out = {
        "id": c["id"],
        "numero": c.get("numero"),
        "cliente_id": c.get("cliente_id"),
        "cliente": (c.get("clientes") or {}).get("nome") if c.get("clientes") else None,
        # O que o vendedor digitou na cotação vence o cadastro: `clientes.cnpj`
        # costuma estar vazio, e a proposta é o documento que vai para o cliente.
        "cliente_cnpj": c.get("cliente_cnpj") or ((c.get("clientes") or {}).get("cnpj") if c.get("clientes") else None),
        "contato_nome": c.get("contato_nome"),
        "contato_email": c.get("contato_email"),
        "contato_id": c.get("contato_id"),
        "oportunidade_id": c.get("oportunidade_id"),
        "canal": c.get("canal"),
        "forma_venda": c.get("forma_venda"),
        "status": c.get("status"),
        "validade": c.get("validade"),
        "condicao_pagamento": c.get("condicao_pagamento"),
        "prazo_entrega": c.get("prazo_entrega"),
        "frete": float(c.get("frete") or 0),
        "desconto_pct": float(c.get("desconto_pct") or 0),
        "observacao": c.get("observacao"),
        "endereco": c.get("endereco"),
        "endereco_bairro": c.get("endereco_bairro"),
        "endereco_cidade": c.get("endereco_cidade"),
        "endereco_uf": c.get("endereco_uf"),
        "endereco_cep": c.get("endereco_cep"),
        "valor_bruto": float(c.get("valor_bruto") or 0),
        "valor_total": float(c.get("valor_total") or 0),
        "criado_em": c.get("criado_em"),
        "enviada_em": c.get("enviada_em"),
        "responsavel": (c.get("usuarios") or {}).get("nome") if c.get("usuarios") else None,
        "responsavel_email": (c.get("usuarios") or {}).get("email") if c.get("usuarios") else None,
        "itens": itens if itens is not None else None,
    }
    out["validade_sugerida"] = validade_sugerida()
    return out


def _pendencias(cot: dict) -> list:
    """Campos do orçamento ainda em branco. Só informativo — nada aqui impede
    gerar, enviar ou imprimir a proposta."""
    faltando = []
    for campo, label in _CAMPOS_PROPOSTA:
        valor = cot.get(campo)
        if campo == "contato_nome" and (cot.get("contato") or {}).get("nome"):
            continue
        if campo == "contato_email" and (cot.get("contato") or {}).get("email"):
            continue
        if not (str(valor).strip() if valor is not None else ""):
            faltando.append(label)
    return faltando


def listar_cotacoes(status: Optional[str] = None, oportunidade_id: Optional[str] = None) -> list:
    db = get_service_db()
    q = db.table("crm_cotacoes").select("*, clientes(nome, cnpj), usuarios(nome, email)").eq("ativo", True)
    if status:
        q = q.eq("status", status)
    if oportunidade_id:
        q = q.eq("oportunidade_id", oportunidade_id)
    rows = q.order("criado_em", desc=True).execute().data
    return [_serializar(r) for r in rows]


def obter_cotacao(cotacao_id: str) -> dict:
    db = get_service_db()
    c = db.table("crm_cotacoes").select("*, clientes(nome, cnpj), usuarios(nome, email)").eq("id", cotacao_id).single().execute().data
    if not c:
        raise HTTPException(status_code=404, detail="Cotação não encontrada")
    itens = db.table("crm_cotacao_itens").select("*").eq("cotacao_id", cotacao_id).execute().data
    itens_out = [{
        "produto_id": it.get("produto_id"),
        "codigo": it.get("codigo"),
        "descricao": it.get("descricao"),
        "qtd": float(it.get("qtd") or 0),
        "valor_unitario": float(it.get("valor_unitario") or 0),
        "desconto_pct": float(it.get("desconto_pct") or 0),
        "total": round(float(it.get("qtd") or 0) * float(it.get("valor_unitario") or 0) * (1 - float(it.get("desconto_pct") or 0) / 100), 2),
    } for it in itens]

    contato = None
    if c.get("contato_id"):
        cc = db.table("crm_contatos").select("nome, cargo, email, telefone").eq("id", c["contato_id"]).execute().data
        contato = cc[0] if cc else None
    out = _serializar(c, itens_out)
    out["contato"] = contato
    out["pendencias"] = _pendencias(out)
    return out


def _observacao_para_ov(cotacao: dict) -> Optional[str]:
    """O que a proposta combinou, no formato que a expedição lê na OV.

    Leva a observação e o prazo de entrega, identificando a proposta de origem —
    sem isso quem separa não sabe de onde veio a condição.
    """
    partes = []
    obs = (cotacao.get("observacao") or "").strip()
    if obs:
        partes.append(obs)
    prazo = (cotacao.get("prazo_entrega") or "").strip()
    if prazo:
        partes.append(f"Prazo de entrega: {prazo}")
    if not partes:
        return None
    return f"Da proposta {cotacao.get('numero') or ''}".strip() + ":\n" + "\n".join(partes)


def criar_cotacao(payload: CotacaoCreate, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    itens_dict = [{"qtd": i.qtd, "valor_unitario": i.valor_unitario, "desconto_pct": i.desconto_pct} for i in payload.itens]
    bruto, total = _totais(itens_dict, payload.frete, payload.desconto_pct)

    dados = {
        "numero": (payload.numero or "").strip() or _gerar_numero(db),
        "cliente_id": str(payload.cliente_id) if payload.cliente_id else None,
        "contato_id": str(payload.contato_id) if payload.contato_id else None,
        "oportunidade_id": str(payload.oportunidade_id) if payload.oportunidade_id else None,
        "canal": payload.canal,
        # A linha da proposta sai dos itens; aqui fica só direta ou licitação.
        "forma_venda": (payload.forma_venda.value if hasattr(payload.forma_venda, "value")
                        else payload.forma_venda),
        "status": "RASCUNHO",
        "validade": payload.validade.isoformat() if payload.validade else None,
        "condicao_pagamento": payload.condicao_pagamento,
        "prazo_entrega": payload.prazo_entrega,
        "frete": float(payload.frete or 0),
        "desconto_pct": float(payload.desconto_pct or 0),
        "observacao": payload.observacao,
        "cliente_cnpj": payload.cliente_cnpj,
        "contato_nome": payload.contato_nome,
        "contato_email": payload.contato_email,
        "endereco": payload.endereco,
        "endereco_bairro": payload.endereco_bairro,
        "endereco_cidade": payload.endereco_cidade,
        "endereco_uf": payload.endereco_uf,
        "endereco_cep": payload.endereco_cep,
        "valor_bruto": bruto,
        "valor_total": total,
        "responsavel_id": str(usuario.id),
        "ativo": True,
    }
    row = _inserir_tolerante(db, dados)

    if payload.itens:
        db.table("crm_cotacao_itens").insert(_itens_in(payload.itens, row["id"])).execute()
    return obter_cotacao(row["id"])


def _inserir_tolerante(db, dados: dict) -> dict:
    """Insere a cotação; sem a coluna `forma_venda` (migration v14), insere sem ela.

    O deploy do código sobe antes do SQL rodar, e uma proposta não pode deixar de
    ser criada por causa de um campo de classificação.
    """
    try:
        return db.table("crm_cotacoes").insert(dados).execute().data[0]
    except Exception:
        if "forma_venda" not in dados:
            raise
        dados = {k: v for k, v in dados.items() if k != "forma_venda"}
        return db.table("crm_cotacoes").insert(dados).execute().data[0]


def atualizar_cotacao(cotacao_id: str, payload: CotacaoUpdate, usuario: UsuarioOut) -> dict:
    db = get_service_db()
    atual = db.table("crm_cotacoes").select("*").eq("id", cotacao_id).single().execute().data
    if not atual:
        raise HTTPException(status_code=404, detail="Cotação não encontrada")

    update: dict = {"atualizado_em": _agora()}
    if payload.numero is not None:
        update["numero"] = payload.numero.strip()
    if payload.cliente_id is not None:
        update["cliente_id"] = str(payload.cliente_id)
    if payload.contato_id is not None:
        update["contato_id"] = str(payload.contato_id) if payload.contato_id else None
    # "não veio no corpo" é diferente de "veio vazio". Testar `is not None`
    # confundia os dois: apagar a observação (ou qualquer texto) na tela mandava
    # null e o servidor mantinha o texto antigo — não dava para corrigir um texto
    # errado deixando o campo em branco. `model_fields_set` diz o que a tela
    # realmente mandou, então mudar o status (que envia só `status`) continua sem
    # encostar nos outros campos.
    enviados = payload.model_fields_set
    for campo in ("canal", "forma_venda", "condicao_pagamento", "prazo_entrega", "observacao",
                  "cliente_cnpj", "contato_nome", "contato_email",
                  "endereco", "endereco_bairro", "endereco_cidade", "endereco_uf", "endereco_cep"):
        if campo in enviados:
            val = getattr(payload, campo)
            update[campo] = val.strip() or None if isinstance(val, str) else val
    if payload.validade is not None:
        update["validade"] = payload.validade.isoformat()
    if payload.frete is not None:
        update["frete"] = float(payload.frete)
    if payload.desconto_pct is not None:
        update["desconto_pct"] = float(payload.desconto_pct)

    if payload.status is not None:
        if payload.status not in _STATUS:
            raise HTTPException(status_code=422, detail="Status de cotação inválido")
        update["status"] = payload.status
        if payload.status == "ENVIADA" and not atual.get("enviada_em"):
            update["enviada_em"] = _agora()
        if payload.status in ("ACEITA", "RECUSADA"):
            update["respondida_em"] = _agora()

    # Substitui itens se enviados
    if payload.itens is not None:
        db.table("crm_cotacao_itens").delete().eq("cotacao_id", cotacao_id).execute()
        if payload.itens:
            db.table("crm_cotacao_itens").insert(_itens_in(payload.itens, cotacao_id)).execute()

    # Recalcula totais com o estado resultante
    itens_rows = db.table("crm_cotacao_itens").select("qtd, valor_unitario, desconto_pct").eq("cotacao_id", cotacao_id).execute().data
    frete = update.get("frete", atual.get("frete") or 0)
    desc = update.get("desconto_pct", atual.get("desconto_pct") or 0)
    bruto, total = _totais(itens_rows, frete, desc)
    update["valor_bruto"] = bruto
    update["valor_total"] = total

    try:
        db.table("crm_cotacoes").update(update).eq("id", cotacao_id).execute()
    except Exception:
        # Migration v14 pendente: salva o resto da cotação e deixa a forma de venda.
        if "forma_venda" not in update:
            raise
        update.pop("forma_venda")
        db.table("crm_cotacoes").update(update).eq("id", cotacao_id).execute()

    # Cotação aceita → marca a oportunidade vinculada como ganha
    if payload.status == "ACEITA" and atual.get("oportunidade_id"):
        try:
            from app.services import crm_service
            crm_service.ganhar_oportunidade(atual["oportunidade_id"], usuario)
        except Exception:
            pass

    return obter_cotacao(cotacao_id)


def duplicar_cotacao(cotacao_id: str, usuario: UsuarioOut) -> dict:
    """Nova cotação a partir de uma existente, para revisar itens/valores.

    Proposta enviada não deve ser editada — o cliente já tem aquele PDF na mão.
    Revisão de preço é uma proposta NOVA (número novo, validade recontada), e a
    anterior fica no histórico mostrando o que foi ofertado antes."""
    db = get_service_db()
    base = db.table("crm_cotacoes").select("*").eq("id", cotacao_id).single().execute().data
    if not base:
        raise HTTPException(status_code=404, detail="Cotação não encontrada")

    nova = _inserir_tolerante(db, {
        "numero": _gerar_numero(db),
        "cliente_id": base.get("cliente_id"),
        "contato_id": base.get("contato_id"),
        "oportunidade_id": base.get("oportunidade_id"),
        "canal": base.get("canal"),
        "forma_venda": base.get("forma_venda"),
        "status": "RASCUNHO",
        "validade": validade_sugerida(),
        "condicao_pagamento": base.get("condicao_pagamento"),
        "prazo_entrega": base.get("prazo_entrega"),
        "frete": float(base.get("frete") or 0),
        "desconto_pct": float(base.get("desconto_pct") or 0),
        "observacao": base.get("observacao"),
        "cliente_cnpj": base.get("cliente_cnpj"),
        "contato_nome": base.get("contato_nome"),
        "contato_email": base.get("contato_email"),
        "endereco": base.get("endereco"),
        "endereco_bairro": base.get("endereco_bairro"),
        "endereco_cidade": base.get("endereco_cidade"),
        "endereco_uf": base.get("endereco_uf"),
        "endereco_cep": base.get("endereco_cep"),
        "valor_bruto": float(base.get("valor_bruto") or 0),
        "valor_total": float(base.get("valor_total") or 0),
        "responsavel_id": str(usuario.id),
        "ativo": True,
    })

    itens = db.table("crm_cotacao_itens").select("*").eq("cotacao_id", cotacao_id).execute().data
    if itens:
        db.table("crm_cotacao_itens").insert([{
            "cotacao_id": nova["id"],
            "produto_id": i.get("produto_id"),
            "codigo": i.get("codigo"),
            "descricao": i.get("descricao"),
            "qtd": float(i.get("qtd") or 0),
            "valor_unitario": float(i.get("valor_unitario") or 0),
            "desconto_pct": float(i.get("desconto_pct") or 0),
        } for i in itens]).execute()

    if base.get("oportunidade_id"):
        try:
            from app.services import crm_service
            crm_service._log_evento(
                db, base["oportunidade_id"],
                f"📄 Proposta revisada: {nova['numero']} (a partir de {base.get('numero')})",
                str(usuario.id))
        except Exception:
            pass

    return obter_cotacao(nova["id"])


def gerar_ov(cotacao_id: str, payload, usuario: UsuarioOut) -> dict:
    """Converte uma cotação ACEITA em OV no fluxo logístico, herdando cliente,
    canal, itens e PREÇOS (com desconto por item aplicado) — sem redigitar nada."""
    from app.models.schemas import ItemPedidoCreate, PedidoCreate
    from app.services import crm_service, pedido_service

    db = get_service_db()
    c = db.table("crm_cotacoes").select("*").eq("id", cotacao_id).single().execute().data
    if not c:
        raise HTTPException(status_code=404, detail="Cotação não encontrada")
    if c.get("status") != "ACEITA":
        raise HTTPException(status_code=400, detail="Só cotações ACEITAS podem gerar OV.")
    if not c.get("cliente_id"):
        raise HTTPException(status_code=400, detail="A cotação precisa ter um cliente para gerar a OV.")

    itens = db.table("crm_cotacao_itens").select("*").eq("cotacao_id", cotacao_id).execute().data
    itens_validos = [i for i in itens if i.get("produto_id") and float(i.get("qtd") or 0) > 0]
    if not itens_validos:
        raise HTTPException(status_code=422, detail="A cotação precisa ter itens (produto e quantidade) para gerar a OV.")

    def _preco_liquido(i: dict):
        vu = float(i.get("valor_unitario") or 0)
        desc = float(i.get("desconto_pct") or 0)
        liq = round(vu * (1 - desc / 100), 4)
        return liq or None

    ov = pedido_service.criar_pedido(
        PedidoCreate(
            numero_pedido=payload.numero_pedido.strip().upper(),
            cliente_id=c["cliente_id"],
            tipo_frete=payload.tipo_frete or "FOB",
            tipo_operacao="VENDA_NORMAL",
            forma_venda=c.get("forma_venda"),
            canal=c.get("canal"),
            local_entrega=payload.local_entrega,
            data_prevista_entrega=payload.data_prevista_entrega,
            # O operador confirma no formulário (já vem preenchida com a da cotação),
            # porque a condição pode ter mudado entre a proposta e o fechamento.
            condicao_pagamento=payload.condicao_pagamento,
            # A observação da proposta desce para a OV. É onde o vendedor escreve
            # o que foi combinado com o cliente ("frete FOB", "retira na MSB",
            # prazos) — quem separa e fatura precisa disso, e antes a informação
            # morria na cotação.
            observacoes=_observacao_para_ov(c),
            valor_frete=float(c.get("frete") or 0) or None,
            itens=[ItemPedidoCreate(produto_id=i["produto_id"], qtd_solicitada=float(i["qtd"]),
                                    valor_unitario=_preco_liquido(i)) for i in itens_validos],
        ),
        usuario,
    )

    # Se há oportunidade vinculada, registra a OV nela também.
    opp_id = c.get("oportunidade_id")
    if opp_id:
        o = db.table("crm_oportunidades").select("gerado_ov_id").eq("id", opp_id).single().execute().data
        if o and not o.get("gerado_ov_id"):
            db.table("crm_oportunidades").update({
                "gerado_ov_id": ov.get("id"), "gerado_ov_ref": ov.get("numero_pedido"), "atualizado_em": _agora(),
            }).eq("id", opp_id).execute()
            crm_service._log_evento(db, opp_id, f"📦 OV gerada a partir da cotação {c.get('numero')}: {ov.get('numero_pedido')}", str(usuario.id))

    out = obter_cotacao(cotacao_id)
    out["ov_gerada_id"] = ov.get("id")
    out["ov_gerada_ref"] = ov.get("numero_pedido")
    return out


def excluir_cotacao(cotacao_id: str) -> dict:
    db = get_service_db()
    db.table("crm_cotacoes").update({"ativo": False, "atualizado_em": _agora()}).eq("id", cotacao_id).execute()
    return {"ok": True}

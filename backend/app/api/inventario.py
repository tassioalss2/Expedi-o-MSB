from uuid import UUID
from typing import Optional

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel

from app.core.deps import get_current_user, lider_ou_superior
from app.models.schemas import (
    AdicionarPedidoPalletRequest,
    CubagemCreate,
    InventarioSalvar,
    PalletCreate,
    UsuarioOut,
    VerificarFisicoRequest,
)
from app.services import inventario_service
from app.models.enums import StatusPedido, TipoFrete

router = APIRouter(tags=["inventario"])


# ── Inventário Contínuo ───────────────────────────────────────

@router.post("/pedidos/{pedido_id}/inventario")
def salvar_inventario(
    pedido_id: UUID,
    payload: InventarioSalvar,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.salvar_inventario(str(pedido_id), payload, usuario)


@router.get("/inventario/ultimo-lote")
def ultimo_inventario_lote(
    codigo: str = Query(...),
    lote: str = Query(...),
    _: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.ultimo_inventario_lote(codigo, lote)


@router.get("/pedidos/{pedido_id}/inventario")
def listar_inventario(
    pedido_id: UUID,
    _: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.listar_inventario(str(pedido_id))


class TratativaDivergenciaRequest(BaseModel):
    acao: str  # "corrigir_inventario" | "resolver"
    justificativa: str


@router.post("/pedidos/{pedido_id}/divergencia/tratar")
def tratar_divergencia(
    pedido_id: UUID,
    payload: TratativaDivergenciaRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    from app.core.database import get_service_db
    from app.services.inventario_service import _agora, _get_usuario_real
    from app.models.enums import StatusPedido

    db = get_service_db()
    uid = _get_usuario_real(str(usuario.id))

    # Fecha a ocorrência aberta relacionada
    ocorrencias = db.table("ocorrencias").select("id").eq("pedido_id", str(pedido_id)).eq("status", "ABERTA").execute().data
    for oc in ocorrencias:
        db.table("ocorrencias").update({
            "status": "FECHADA",
            "resolucao": payload.justificativa,
            "resolvido_por": uid,
            "resolvido_em": _agora(),
        }).eq("id", oc["id"]).execute()

    if payload.acao == "corrigir_inventario":
        # Volta para EM_INVENTARIO para corrigir os dados
        db.table("pedidos").update({
            "status": StatusPedido.EM_INVENTARIO.value,
            "atualizado_em": _agora(),
        }).eq("id", str(pedido_id)).execute()
        db.table("movimentacoes").insert({
            "pedido_id": str(pedido_id),
            "status_anterior": StatusPedido.DIVERGENCIA.value,
            "status_novo": StatusPedido.EM_INVENTARIO.value,
            "usuario_id": uid,
            "observacao": f"Divergência tratada — corrigindo inventário: {payload.justificativa}",
            "criado_em": _agora(),
        }).execute()
        return {"ok": True, "proximo": "EM_INVENTARIO", "mensagem": "Inventário reaberto para correção"}
    else:
        # Resolve e avança para processo sistêmico
        db.table("pedidos").update({
            "status": StatusPedido.EM_PROCESSO_SISTEMICO.value,
            "atualizado_em": _agora(),
        }).eq("id", str(pedido_id)).execute()
        db.table("movimentacoes").insert({
            "pedido_id": str(pedido_id),
            "status_anterior": StatusPedido.DIVERGENCIA.value,
            "status_novo": StatusPedido.EM_PROCESSO_SISTEMICO.value,
            "usuario_id": uid,
            "observacao": f"Divergência resolvida: {payload.justificativa}",
            "criado_em": _agora(),
        }).execute()
        return {"ok": True, "proximo": "EM_PROCESSO_SISTEMICO", "mensagem": "Divergência resolvida — prosseguir no D365"}


@router.post("/pedidos/{pedido_id}/inventario/verificar")
def verificar_fisico(
    pedido_id: UUID,
    payload: VerificarFisicoRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.verificar_fisico(str(pedido_id), payload, usuario)


# ── Cubagem ───────────────────────────────────────────────────

@router.post("/pedidos/{pedido_id}/cubagem")
def registrar_cubagem(
    pedido_id: UUID,
    payload: CubagemCreate,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.registrar_cubagem(str(pedido_id), payload, usuario)


@router.get("/pedidos/{pedido_id}/cubagem")
def obter_cubagem(
    pedido_id: UUID,
    _: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.obter_cubagem(str(pedido_id))


# ── Pallets ───────────────────────────────────────────────────

@router.post("/pallets", status_code=201)
def criar_pallet(
    payload: PalletCreate,
    usuario: UsuarioOut = Depends(lider_ou_superior),
):
    return inventario_service.criar_pallet(payload, usuario)


@router.get("/pallets")
def listar_pallets(
    status: Optional[str] = Query(None),
    _: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.listar_pallets(status)


@router.get("/relatorio/coletas-realizadas")
def relatorio_coletas_realizadas(
    data_inicio: str = Query(...),
    data_fim: str = Query(...),
    _: UsuarioOut = Depends(get_current_user),
):
    from app.core.database import get_service_db
    db = get_service_db()

    # Busca pallet_pedidos coletados no período
    registros = db.table("pallet_pedidos").select(
        "*, pedidos(numero_pedido, numero_nf, transportadora_id, transportadoras(nome), clientes(nome)), pallets(codigo, transportadoras(nome))"
    ).eq("status", "COLETADO").gte("coletado_em", f"{data_inicio}T00:00:00").lte("coletado_em", f"{data_fim}T23:59:59").execute().data

    resultado = []
    for r in registros:
        pedido = r.get("pedidos") or {}
        pallet = r.get("pallets") or {}
        # Transportadora real da OV (pode ser diferente do pallet para OUTROS)
        transp_ov = (pedido.get("transportadoras") or {}).get("nome") or "—"
        transp_pallet = (pallet.get("transportadoras") or {}).get("nome") or "—"
        resultado.append({
            "numero_pedido": pedido.get("numero_pedido", "—"),
            "numero_nf": pedido.get("numero_nf"),
            "cliente": (pedido.get("clientes") or {}).get("nome", "—"),
            "transportadora": transp_ov,          # transportadora real da OV
            "pallet": transp_pallet,              # transportadora do pallet
            "pallet_codigo": pallet.get("codigo", "—"),
            "adicionado_em": r.get("adicionado_em"),
            "coletado_em": r.get("coletado_em"),
            "num_caixas": r.get("num_caixas"),
        })

    return resultado


@router.post("/pallets/{pallet_id}/pedidos")
def adicionar_pedido_pallet(
    pallet_id: UUID,
    payload: AdicionarPedidoPalletRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.adicionar_pedido_pallet(str(pallet_id), payload, usuario)


@router.post("/ocorrencias/{ocorrencia_id}/excluir")
def excluir_ocorrencia(ocorrencia_id: str, _: UsuarioOut = Depends(get_current_user)):
    from app.core.database import get_service_db
    db = get_service_db()
    db.table("ocorrencias").delete().eq("id", ocorrencia_id).execute()
    return {"ok": True}


@router.post("/pallets/{pallet_id}/fechar")
def fechar_pallet(
    pallet_id: UUID,
    usuario: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.fechar_pallet(str(pallet_id))


class AlterarTransportadoraRequest(BaseModel):
    transportadora_id: str
    motivo: Optional[str] = None
    registrar_ocorrencia: bool = True
    transportadora_nome_real: Optional[str] = None  # preenchido quando selecionado "OUTROS"


class AlterarTipoFreteRequest(BaseModel):
    tipo_frete: TipoFrete
    # Opcional: exigir texto para toda troca de frete fazia a pessoa digitar
    # "correcao" so para o botao liberar, e um campo assim nao informa nada a
    # quem le depois. Quando ha motivo de verdade ele entra na ocorrencia.
    motivo: Optional[str] = None
    valor_frete: Optional[float] = None  # obrigatório quando o novo tipo é CIF


@router.post("/pedidos/{pedido_id}/alterar-tipo-frete")
def alterar_tipo_frete(
    pedido_id: UUID,
    payload: AlterarTipoFreteRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    """Altera o tipo de frete e registra a correção como ocorrência obrigatória."""
    from fastapi import HTTPException
    from app.core.database import get_service_db
    from app.services.inventario_service import _agora, _get_usuario_real

    motivo = (payload.motivo or "").strip()

    db = get_service_db()
    # `numero_nf` e `valor_produtos` fazem parte da decisão, não são enfeite: é
    # com eles que se sabe se a OV já faturou (aí o frete entra na face da nota).
    # Sem eles no select, `pedido.get("numero_nf")` era sempre None e o recálculo
    # de `valor_nf` abaixo — escrito justamente por causa da OV016168, que ficou
    # R$ 102,01 fora do faturamento de agosto — nunca chegou a rodar.
    pedido = db.table("pedidos").select(
        "numero_pedido,status,tipo_frete,valor_frete,numero_nf,valor_produtos"
    ).eq("id", str(pedido_id)).single().execute().data
    if not pedido:
        raise HTTPException(status_code=404, detail="Pedido não encontrado")

    frete_anterior = pedido.get("tipo_frete") or TipoFrete.FOB.value
    frete_novo = payload.tipo_frete.value
    mesmo_tipo = frete_anterior == frete_novo

    # Valor do frete no CIF: quase sempre ele ainda NÃO existe na hora de mudar o
    # tipo. Quem muda para CIF muda porque vai cotar, e a cotação é o passo
    # seguinte — exigir o valor aqui obrigava a inventar um número ou a desistir
    # da mudança, e aí o tipo de frete da OV ficava errado no controle.
    #
    # Então o valor é opcional, e sem ele a OV vai para "Cotação de frete", que
    # é onde ela deve estar. O controle não se perde: `registrar_faturamento`
    # continua exigindo o frete do CIF, então nada fatura sem cotação.
    #
    # Duas exceções, onde o valor continua obrigatório:
    #   - o tipo não mudou: aí só o valor teria o que alterar
    #   - a OV já faturou: o frete entra na face da nota (`valor_nf`), e mexer
    #     no tipo sem o valor deixaria o total brigando com o D365
    eh_cif = frete_novo in (TipoFrete.CIF_COM_VALOR.value, TipoFrete.CIF_SEM_VALOR.value)
    valor_frete_novo = None
    if eh_cif:
        if payload.valor_frete is not None and payload.valor_frete > 0:
            valor_frete_novo = round(float(payload.valor_frete), 2)
        elif mesmo_tipo:
            raise HTTPException(status_code=422, detail=(
                "O tipo de frete não mudou — informe o valor, que é o que sobraria "
                "para alterar."))
        elif pedido.get("numero_nf"):
            raise HTTPException(status_code=422, detail=(
                "Esta OV já faturou: o frete do CIF entra no valor da nota, então ele "
                "é obrigatório aqui para o total não divergir do D365."))
    else:
        valor_frete_novo = 0.0

    frete_anterior_valor = float(pedido.get("valor_frete") or 0)
    if mesmo_tipo and abs((valor_frete_novo or 0) - frete_anterior_valor) < 0.005:
        raise HTTPException(status_code=400, detail="Nada foi alterado — mude o tipo ou o valor do frete.")

    uid = _get_usuario_real(str(usuario.id))
    labels = {
        TipoFrete.FOB.value: "FOB",
        TipoFrete.CIF_COM_VALOR.value: "CIF com Valor NF",
        TipoFrete.CIF_SEM_VALOR.value: "CIF sem Valor NF",
        TipoFrete.NAO_UTILIZAR_TERCEIROS.value: "Não utilizar - Frete terceiros",
    }
    agora = _agora()

    def _brl(v) -> str:
        # None = ainda não cotado. Dizer isso é melhor do que escrever "R$ 0,00",
        # que no histórico se lê como frete de graça.
        if v is None:
            return "a cotar"
        return f"R$ {v:,.2f}".replace(",", "X").replace(".", ",").replace("X", ".")

    update_frete: dict = {
        "tipo_frete": frete_novo,
        "valor_frete": valor_frete_novo,
        "atualizado_em": agora,
    }
    # Em OV já faturada, `valor_nf` é o total COM o frete embutido (convenção CIF do
    # app), então mexer no frete sem recalcular o total deixa os dois brigando: o
    # faturamento passa a sair de `valor_nf - frete` e o resultado não é mais a face
    # da nota. Caso real: OV016168 teve o frete corrigido de R$ 340,20 para R$ 442,21
    # e o valor_nf ficou no total antigo — R$ 102,01 a menos no faturamento de agosto
    # contra o D365.
    valor_produtos = float(pedido.get("valor_produtos") or 0)
    if pedido.get("numero_nf") and valor_produtos > 0 and valor_frete_novo is not None:
        update_frete["valor_nf"] = round(valor_produtos + valor_frete_novo, 2)
    db.table("pedidos").update(update_frete).eq("id", str(pedido_id)).execute()

    # O ramo do frete e escolhido na cubagem, pelo tipo daquele momento: CIF vai
    # cotar, FOB espera a transportadora do cliente. Mudar o tipo DEPOIS deixava a
    # OV no ramo errado — pedindo cotacao de um frete que o cliente paga, ou
    # esperando uma transportadora que nao vem. Aqui ela troca de ramo junto.
    etapa_refeita = None
    if not mesmo_tipo:
        # Aqui NÃO vale o atalho do FOB-com-transportadora da cubagem: a OV
        # vinha de CIF, e a transportadora no cadastro foi escolhida por NÓS
        # para cotar o frete — não é a que o cliente mandou coletar. Pular a
        # coluna faturaria uma NF com a transportadora errada.
        destino = (StatusPedido.EM_COTACAO_FRETE.value if eh_cif
                   else StatusPedido.AGUARD_TRANSPORTADORA.value)
        # Virou CIF e o valor ficou para depois: a OV TEM de ir cotar, mesmo que
        # estivesse pronta para faturar. Sem isso ela ficaria em "Aguardando
        # faturamento" e o faturamento a recusaria por falta do frete — parada
        # sem ninguém saber por quê.
        origens = [StatusPedido.EM_COTACAO_FRETE.value,
                   StatusPedido.AGUARD_TRANSPORTADORA.value]
        if eh_cif and valor_frete_novo is None:
            origens.append(StatusPedido.AGUARD_FATURAMENTO.value)
        if pedido["status"] in origens and pedido["status"] != destino:
            from app.services.inventario_service import alterar_status
            alterar_status(
                str(pedido_id), destino, usuario,
                "Tipo de frete alterado para %s — etapa refeita: %s"
                % (labels.get(frete_novo, frete_novo),
                   "aguardando cotacao de frete" if eh_cif
                   else "aguardando transportadora do cliente"))
            etapa_refeita = destino

    linha_valor = f"\n• Valor do frete: {_brl(valor_frete_novo)}" if eh_cif else ""
    # Sem motivo a linha inteira sai do texto: "• Motivo:" vazio na ocorrência
    # parece campo que alguém esqueceu de preencher, e não escolha de não
    # escrever nada.
    linha_motivo = f"• Motivo: {motivo}" if motivo else ""
    sufixo_motivo = f" {motivo}" if motivo else ""
    if mesmo_tipo:
        tipo_ocorrencia = "Correção de Valor do Frete"
        titulo_desc = (
            f"Valor do frete corrigido na OV {pedido['numero_pedido']} (tipo {labels.get(frete_novo, frete_novo)} mantido).\n"
            f"• De: {_brl(frete_anterior_valor)}\n"
            f"• Para: {_brl(valor_frete_novo)}\n"
            f"{linha_motivo}"
        )
    else:
        tipo_ocorrencia = "Alteração de Tipo de Frete"
        titulo_desc = (
            f"Tipo de frete alterado na OV {pedido['numero_pedido']}.\n"
            f"• De: {labels.get(frete_anterior, frete_anterior)} ({_brl(frete_anterior_valor)})\n"
            f"• Para: {labels.get(frete_novo, frete_novo)}{linha_valor}\n"
            f"{linha_motivo}"
        )
    db.table("ocorrencias").insert({
        "pedido_id": str(pedido_id),
        "tipo": tipo_ocorrencia,
        # rstrip: sem motivo a descricao terminava numa linha em branco.
        "descricao": titulo_desc.rstrip(),
        "responsavel_id": uid,
        "status": "ABERTA",
        "criado_em": agora,
    }).execute()

    db.table("movimentacoes").insert({
        "pedido_id": str(pedido_id),
        "status_anterior": pedido["status"],
        "status_novo": etapa_refeita or pedido["status"],
        "usuario_id": uid,
        "observacao": (
            f"Valor do frete corrigido ({labels.get(frete_novo, frete_novo)}): "
            f"{_brl(frete_anterior_valor)} → {_brl(valor_frete_novo)}.{sufixo_motivo}"
            if mesmo_tipo else
            f"Tipo de frete alterado: {labels.get(frete_anterior, frete_anterior)} "
            f"→ {labels.get(frete_novo, frete_novo)}"
            f"{' (' + _brl(valor_frete_novo) + ')' if eh_cif else ''}.{sufixo_motivo}"
        ),
        "criado_em": agora,
    }).execute()

    return {
        "ok": True,
        "tipo_frete_anterior": frete_anterior,
        "tipo_frete_novo": frete_novo,
        "valor_frete": valor_frete_novo,
        # A tela avisa quando a OV trocou de etapa, senao a pessoa corrige o frete
        # e nao entende por que o proximo passo mudou.
        "etapa_refeita": etapa_refeita,
    }


@router.post("/pedidos/{pedido_id}/alterar-transportadora")
def alterar_transportadora(
    pedido_id: UUID,
    payload: AlterarTransportadoraRequest,
    usuario: UsuarioOut = Depends(get_current_user),
):
    from app.core.database import get_service_db
    from app.services.inventario_service import _agora, _get_usuario_real

    db = get_service_db()
    uid = _get_usuario_real(str(usuario.id))

    # Busca pedido atual
    pedido = db.table("pedidos").select("*, transportadoras(nome)").eq("id", str(pedido_id)).single().execute().data
    if not pedido:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Pedido não encontrado")

    transp_antiga = (pedido.get("transportadoras") or {}).get("nome", "—")

    # Busca nova transportadora
    nova_transp = db.table("transportadoras").select("id,nome").eq("id", payload.transportadora_id).single().execute().data
    if not nova_transp:
        from fastapi import HTTPException
        raise HTTPException(status_code=404, detail="Transportadora não encontrada")

    transp_nova = nova_transp["nome"]
    # Quando "OUTROS" é selecionado e operador informou o nome real, exibir ambos
    transp_nova_label = (
        f"OUTROS ({payload.transportadora_nome_real.strip()})"
        if payload.transportadora_nome_real and payload.transportadora_nome_real.strip()
        else transp_nova
    )

    # Atualiza transportadora no pedido; se nome real informado, salva em observacoes
    update_data: dict = {"transportadora_id": payload.transportadora_id, "atualizado_em": _agora()}
    if payload.transportadora_nome_real and payload.transportadora_nome_real.strip():
        obs_atual = pedido.get("observacoes") or ""
        nota = f"[Transp. real: {payload.transportadora_nome_real.strip()}]"
        # Substitui nota anterior se já existia
        import re as _re
        obs_atual = _re.sub(r'\[Transp\. real:[^\]]*\]', '', obs_atual).strip()
        update_data["observacoes"] = f"{obs_atual} {nota}".strip() if obs_atual else nota
    db.table("pedidos").update(update_data).eq("id", str(pedido_id)).execute()

    # Verifica se OV está em algum pallet e move se necessário
    PALLET_FIXOS = {"BRIX": "PLT-BRIX", "RR CARGO": "PLT-RR CARGO", "CORREIOS": "PLT-CORREIOS"}
    novo_pallet_codigo = PALLET_FIXOS.get(transp_nova.upper(), "PLT-OUTROS")

    pp_atual = db.table("pallet_pedidos").select("id,pallet_id").eq("pedido_id", str(pedido_id)).eq("status", "AGUARDANDO").execute().data
    if pp_atual:
        novo_pallet = db.table("pallets").select("id,codigo").eq("codigo", novo_pallet_codigo).single().execute().data
        if novo_pallet and pp_atual[0]["pallet_id"] != novo_pallet["id"]:
            # Move para o pallet correto
            db.table("pallet_pedidos").update({
                "pallet_id": novo_pallet["id"],
            }).eq("id", pp_atual[0]["id"]).execute()
            pallet_msg = f"OV movida do pallet anterior para {novo_pallet_codigo}."
        else:
            pallet_msg = "Pallet não alterado (mesma categoria)."
    else:
        pallet_msg = "OV não estava em nenhum pallet ativo."

    # Registra ocorrência apenas se solicitado
    if payload.registrar_ocorrencia:
        db.table("ocorrencias").insert({
            "pedido_id": str(pedido_id),
            "tipo": "Erro de Transportadora na NF",
            "descricao": (
                f"Transportadora alterada por erro na emissão da NF.\n"
                f"• De: {transp_antiga}\n"
                f"• Para: {transp_nova_label}\n"
                f"• Motivo: {payload.motivo or '—'}\n"
                f"• {pallet_msg}"
            ),
            "responsavel_id": uid,
            "status": "ABERTA",
            "criado_em": _agora(),
        }).execute()

    # Registra movimentação
    db.table("movimentacoes").insert({
        "pedido_id": str(pedido_id),
        "status_anterior": pedido["status"],
        "status_novo": pedido["status"],
        "usuario_id": uid,
        "observacao": f"Transportadora alterada: {transp_antiga} → {transp_nova_label}. {payload.motivo or ''}".strip(". "),
        "criado_em": _agora(),
    }).execute()

    return {
        "ok": True,
        "transportadora_anterior": transp_antiga,
        "transportadora_nova": transp_nova_label,
        "pallet": pallet_msg,
    }


class ColetaRequest(BaseModel):
    pedido_ids: Optional[list[str]] = None


@router.post("/pallets/{pallet_id}/coletar")
def confirmar_coleta_pallet(
    pallet_id: UUID,
    payload: ColetaRequest = ColetaRequest(),
    usuario: UsuarioOut = Depends(get_current_user),
):
    return inventario_service.confirmar_coleta_pallet(str(pallet_id), usuario, payload.pedido_ids)

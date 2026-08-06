"""Converte as oportunidades parqueadas em DESAFIOS em pendências de estoque.

Antes de existir a coluna "Pendência de estoque", o comercial usou o estágio
DESAFIOS como estacionamento: criou oportunidades chamadas "Pendencia <cliente>"
só para não perder o controle do que estava esperando material. A tabela
crm_desafios está vazia — nenhum desafio real foi registrado, confirmando o uso.

Este script transforma esses registros em pendências de verdade, com o detalhe
item a item, para eles aparecerem na coluna própria e poderem ser liberados
quando o material chegar.

O que faz em cada oportunidade:
  · monta `pendencia` com decisao AGUARDAR e origem MANUAL — nenhuma delas tem OV
    (gerado_ov_id nulo), então o saldo é a quantidade INTEIRA de cada item;
  · NÃO mexe no estágio. A coluna de pendência é virtual: o card sai da coluna
    Desafios sozinho enquanto a pendência estiver aberta. Mudar o estágio aqui
    seria decidir, no lugar do comercial, que essas vendas estão ganhas.

Idempotente: pula quem já tem pendência gravada.

    python backfill_pendencia_desafios.py            # simula
    python backfill_pendencia_desafios.py --aplicar   # grava
"""
import sys
from datetime import datetime, timezone

sys.path.insert(0, ".")
from dotenv import load_dotenv

load_dotenv()

from app.core.database import get_service_db  # noqa: E402

APLICAR = "--aplicar" in sys.argv


def main() -> int:
    db = get_service_db()

    try:
        opps = db.table("crm_oportunidades").select(
            "id, titulo, valor_estimado, cliente_id, canal, estagio, gerado_ov_id, pendencia"
        ).eq("estagio", "DESAFIOS").eq("ativo", True).execute().data
    except Exception as exc:
        print(f"Nao consegui ler as oportunidades: {exc}")
        print("Se o erro menciona a coluna 'pendencia', rode a migration v29 primeiro:")
        print("  database/migracao_crm_pendencia_v29.sql")
        return 1

    if not opps:
        print("Nenhuma oportunidade no estagio DESAFIOS. Nada a fazer.")
        return 0

    agora = datetime.now(timezone.utc).isoformat()
    total_valor = 0.0
    convertidas = 0
    puladas = 0

    for o in opps:
        titulo = o.get("titulo") or "(sem titulo)"

        if o.get("pendencia"):
            print(f"  = {titulo}: ja tem pendencia gravada, pulando")
            puladas += 1
            continue

        itens_rows = db.table("crm_oportunidade_itens").select("*")\
            .eq("oportunidade_id", o["id"]).order("id").execute().data
        validos = [i for i in itens_rows if float(i.get("qtd") or 0) > 0]
        if not validos:
            print(f"  ! {titulo}: sem itens — nao da para detalhar a pendencia, pulando")
            puladas += 1
            continue

        if o.get("gerado_ov_id"):
            # Se ja existe OV, parte do material saiu e o saldo nao e a quantidade
            # inteira. Nao ha como adivinhar quanto — melhor reportar do que gravar
            # um numero inventado.
            print(f"  ! {titulo}: ja tem OV vinculada — o saldo nao e a qtd inteira, pulando")
            puladas += 1
            continue

        itens = []
        valor = 0.0
        for idx, i in enumerate(validos):
            qtd = float(i.get("qtd") or 0)
            vu = float(i.get("valor_unitario") or 0)
            vp = round(qtd * vu, 2)
            valor += vp
            itens.append({
                "ref": idx,
                "produto_id": i.get("produto_id"),
                "codigo": i.get("codigo"),
                "descricao": i.get("descricao"),
                "qtd_pedida": qtd,
                "disponivel": None,
                "estoque_sa": None,
                # Nada foi entregue: nenhuma dessas vendas gerou OV.
                "qtd_atendida": 0.0,
                "qtd_pendente": qtd,
                "valor_unitario": vu,
                "valor_pendente": vp,
                "sem_dado": False,
                "cobre_com_sa": None,
                "status": "FALTA",
            })

        valor = round(valor, 2)
        total_valor += valor
        estimado = float(o.get("valor_estimado") or 0)
        alerta = ""
        if estimado and abs(estimado - valor) > 0.01:
            alerta = f"  (atencao: valor_estimado R$ {estimado:,.2f} difere da soma dos itens)"

        pendencia = {
            "decisao": "AGUARDAR",
            "origem": "MANUAL",
            "decidido_em": agora,
            "decidido_por": None,
            "observacao": "Pendencia que estava controlada a mao no estagio Desafios, "
                          "migrada para a coluna de pendencia de estoque.",
            "valor": valor,
            "itens": itens,
            "previsao_sa": None,
            "cobre_com_sa": None,
            "previsao_pcp": None,
            "resolvido_em": None,
            "resolucao": None,
        }

        print(f"  > {titulo}: R$ {valor:,.2f} em {len(itens)} item(ns){alerta}")
        for it in itens:
            print(f"       {it['codigo'] or '—'}  faltam {it['qtd_pendente']:g}  "
                  f"R$ {it['valor_pendente']:,.2f}")

        if APLICAR:
            db.table("crm_oportunidades").update({
                "pendencia": pendencia, "atualizado_em": agora,
            }).eq("id", o["id"]).execute()
        convertidas += 1

    print()
    print(f"{'APLICADO' if APLICAR else 'SIMULACAO'}: "
          f"{convertidas} convertida(s), {puladas} pulada(s), "
          f"total R$ {total_valor:,.2f}")
    if not APLICAR and convertidas:
        print("Rode de novo com --aplicar para gravar.")
    return 0


if __name__ == "__main__":
    sys.exit(main())

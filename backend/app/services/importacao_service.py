"""
Importação de pedidos via CSV ou Excel.

Colunas esperadas no arquivo:
numero_pedido, cliente_codigo, produto_codigo, lote, qtd_solicitada,
data_prevista_entrega (DD/MM/AAAA), transportadora (opcional), prioridade (opcional)
"""
import io
from datetime import datetime

import pandas as pd

from app.core.database import get_service_db
from app.models.enums import Prioridade, StatusPedido
from app.models.schemas import UsuarioOut


COLUNAS_OBRIGATORIAS = {"numero_pedido", "cliente_codigo", "produto_codigo", "lote",
                        "qtd_solicitada", "data_prevista_entrega"}


def importar_arquivo(conteudo: bytes, nome_arquivo: str, usuario: UsuarioOut) -> dict:
    try:
        if nome_arquivo.endswith(".csv"):
            df = pd.read_csv(io.BytesIO(conteudo), sep=";", dtype=str)
        else:
            df = pd.read_excel(io.BytesIO(conteudo), dtype=str)
    except Exception as e:
        return {"total": 0, "importados": 0, "erros": [{"linha": 0, "erro": f"Erro ao ler arquivo: {e}"}]}

    df.columns = [c.strip().lower().replace(" ", "_") for c in df.columns]
    faltando = COLUNAS_OBRIGATORIAS - set(df.columns)
    if faltando:
        return {"total": 0, "importados": 0, "erros": [{"linha": 0, "erro": f"Colunas obrigatórias ausentes: {faltando}"}]}

    db = get_service_db()
    erros = []
    importados = 0

    # Agrupa por pedido para criar pedido + itens
    for numero_pedido, grupo in df.groupby("numero_pedido"):
        try:
            # Verifica duplicidade
            existe = db.table("pedidos").select("id").eq("numero_pedido", str(numero_pedido)).execute()
            if existe.data:
                erros.append({"linha": grupo.index[0] + 2, "erro": f"Pedido {numero_pedido} já existe"})
                continue

            primeira = grupo.iloc[0]

            # Resolve cliente
            cliente = db.table("clientes").select("id").eq("codigo", str(primeira["cliente_codigo"]).strip()).execute()
            if not cliente.data:
                erros.append({"linha": grupo.index[0] + 2, "erro": f"Cliente '{primeira['cliente_codigo']}' não encontrado"})
                continue

            # Data
            try:
                data_prev = datetime.strptime(str(primeira["data_prevista_entrega"]).strip(), "%d/%m/%Y").date()
            except ValueError:
                erros.append({"linha": grupo.index[0] + 2, "erro": "Data inválida, use DD/MM/AAAA"})
                continue

            prioridade = str(primeira.get("prioridade", "NORMAL")).strip().upper()
            if prioridade not in Prioridade.__members__:
                prioridade = Prioridade.NORMAL.value

            pedido_data = {
                "numero_pedido": str(numero_pedido).strip(),
                "cliente_id": cliente.data[0]["id"],
                "status": StatusPedido.LIBERADO.value,
                "prioridade": prioridade,
                "data_prevista_entrega": data_prev.isoformat(),
                "criado_por": str(usuario.id),
            }

            pedido_result = db.table("pedidos").insert(pedido_data).execute()
            pedido_id = pedido_result.data[0]["id"]

            # Itens
            itens = []
            for _, row in grupo.iterrows():
                produto = db.table("produtos").select("id").eq("codigo", str(row["produto_codigo"]).strip()).execute()
                if not produto.data:
                    erros.append({"linha": row.name + 2, "erro": f"Produto '{row['produto_codigo']}' não encontrado"})
                    continue

                lote = db.table("lotes").select("id")\
                    .eq("produto_id", produto.data[0]["id"])\
                    .eq("numero_lote", str(row["lote"]).strip())\
                    .execute()

                itens.append({
                    "pedido_id": pedido_id,
                    "produto_id": produto.data[0]["id"],
                    "lote_id": lote.data[0]["id"] if lote.data else None,
                    "qtd_solicitada": float(str(row["qtd_solicitada"]).replace(",", ".")),
                    "status_item": "PENDENTE",
                })

            if itens:
                db.table("itens_pedido").insert(itens).execute()

            db.table("movimentacoes").insert({
                "pedido_id": pedido_id,
                "status_anterior": None,
                "status_novo": StatusPedido.LIBERADO.value,
                "usuario_id": str(usuario.id),
                "observacao": "Importado via arquivo",
            }).execute()

            importados += 1

        except Exception as e:
            erros.append({"linha": grupo.index[0] + 2, "erro": str(e)})

    return {"total": len(df["numero_pedido"].unique()), "importados": importados, "erros": erros}

"""
Fila de impressão — etiquetas de inventário e espelhos de carga.
O Print Agent (Windows) busca jobs pendentes neste endpoint a cada 1 segundo.
Evita o problema de CORS/Private-Network-Access do Chrome ao conectar em localhost.
"""
from typing import Any, Optional

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict

from app.core.database import get_service_db
from app.core.deps import get_current_user
from app.models.schemas import UsuarioOut

router = APIRouter(tags=["impressao"])


class EtiquetaPayload(BaseModel):
    """Payload flexível — suporta etiquetas de inventário e espelhos de carga."""
    model_config = ConfigDict(extra='allow')

    tipo: str = 'inventario'

    # Inventário
    codigo: Optional[str] = None
    lote: Optional[str] = None
    validade: Optional[str] = None
    quantidade: Optional[int] = None
    operador: Optional[str] = ''
    data_inventario: Optional[str] = None

    # Espelho de carga
    numero_nf: Optional[str] = None
    numero_pedido: Optional[str] = None
    caixa: Optional[int] = None
    total_caixas: Optional[int] = None
    data: Optional[str] = None


@router.post("/impressao")
def enfileirar_etiqueta(
    payload: EtiquetaPayload,
    usuario: UsuarioOut = Depends(get_current_user),
):
    """Frontend chama isso ao verificar um item ou registrar NF — enfileira a impressão."""
    db = get_service_db()
    result = db.table("fila_impressao").insert({
        "payload": payload.model_dump(),
        "status": "pendente",
    }).execute()
    job_id = result.data[0]["id"] if result.data else None
    return {"ok": True, "id": job_id}

"""
Fila de impressão — etiquetas de inventário.
O Print Agent (Windows) busca jobs pendentes neste endpoint a cada 1 segundo.
Evita o problema de CORS/Private-Network-Access do Chrome ao conectar em localhost.
"""
from typing import Optional

from fastapi import APIRouter, Depends

from app.core.database import get_service_db
from app.core.deps import get_current_user
from app.models.schemas import UsuarioOut
from pydantic import BaseModel

router = APIRouter(tags=["impressao"])


class EtiquetaPayload(BaseModel):
    codigo: str
    lote: str
    validade: Optional[str] = None
    quantidade: int
    operador: Optional[str] = ""
    data_inventario: str


@router.post("/impressao")
def enfileirar_etiqueta(
    payload: EtiquetaPayload,
    usuario: UsuarioOut = Depends(get_current_user),
):
    """Frontend chama isso ao verificar um item — enfileira a impressão."""
    db = get_service_db()
    result = db.table("fila_impressao").insert({
        "payload": payload.model_dump(),
        "status": "pendente",
    }).execute()
    job_id = result.data[0]["id"] if result.data else None
    return {"ok": True, "id": job_id}

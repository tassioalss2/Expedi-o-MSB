from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.auth import router as auth_router
from app.api.cadastros import router as cadastros_router
from app.api.impressao import router as impressao_router
from app.api.inventario import router as inventario_router
from app.api.inventario_continuo import router as inventario_continuo_router
from app.api.pedidos import router as pedidos_router

app = FastAPI(
    title="ACE-MSB — Aplicativo de Controle de Expedição",
    version="1.0.0",
    description="API de gestão de expedição da MSB Biomedical",
)

import os
ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # Produção: qualquer origem (Vercel gera URLs dinâmicas)
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(auth_router, prefix="/api/v1")
app.include_router(pedidos_router, prefix="/api/v1")
app.include_router(cadastros_router, prefix="/api/v1")
app.include_router(inventario_router, prefix="/api/v1")
app.include_router(inventario_continuo_router, prefix="/api/v1")
app.include_router(impressao_router, prefix="/api/v1")


@app.get("/health")
def health():
    return {"status": "ok", "app": "ACE-MSB"}

from typing import Optional
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    supabase_url: str
    supabase_key: str
    supabase_service_key: str
    secret_key: str
    algorithm: str = "HS256"
    access_token_expire_minutes: int = 480
    # Webhook do canal Teams da Expedição (opcional — se vazio, notificação é ignorada)
    teams_webhook_expedicao: Optional[str] = None
    # Canal do repasse comercial → operações de vendas. Se vazio, cai no canal da
    # Expedição: melhor o aviso sair no canal errado do que não sair.
    teams_webhook_comercial: Optional[str] = None
    # App de cobertura de estoque do PCP (opcional — projeto Supabase deles, só
    # leitura). Precisam estar declarados aqui: o Settings recusa variável extra,
    # então uma var não declarada no ambiente derruba o boot do backend.
    pcp_supabase_url: Optional[str] = None
    pcp_supabase_key: Optional[str] = None
    # Dynamics 365 F&O (opcional, SÓ LEITURA — ver app/services/d365_service.py).
    # Sem as quatro primeiras a integração fica desligada e o app segue como antes.
    d365_resource: Optional[str] = None       # https://<ambiente>.operations.dynamics.com
    d365_tenant_id: Optional[str] = None
    d365_client_id: Optional[str] = None
    d365_client_secret: Optional[str] = None
    d365_empresa: Optional[str] = None        # dataAreaId, quando há mais de uma empresa

    class Config:
        env_file = ".env"


settings = Settings()

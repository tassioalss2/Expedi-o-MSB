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

    class Config:
        env_file = ".env"


settings = Settings()

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

    class Config:
        env_file = ".env"


settings = Settings()

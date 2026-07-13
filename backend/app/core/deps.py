from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.database import get_service_db
from app.core.security import decode_token
from app.models.enums import PerfilUsuario
from app.models.schemas import UsuarioOut

bearer = HTTPBearer(auto_error=False)

_NAO_AUTENTICADO = HTTPException(
    status_code=status.HTTP_401_UNAUTHORIZED,
    detail="Não autenticado",
    headers={"WWW-Authenticate": "Bearer"},
)


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer),
) -> UsuarioOut:
    """Valida o JWT e carrega o usuário real (ativo) do banco.

    Qualquer falha (sem token, token inválido/expirado, usuário inexistente
    ou inativo) resulta em 401 — o frontend trata o 401 deslogando.
    """
    if not credentials or not credentials.credentials:
        raise _NAO_AUTENTICADO

    payload = decode_token(credentials.credentials)
    if not payload or not payload.get("sub"):
        raise _NAO_AUTENTICADO

    db = get_service_db()
    res = (
        db.table("usuarios")
        .select("*")
        .eq("id", payload["sub"])
        .eq("ativo", True)
        .single()
        .execute()
    )
    if not res.data:
        raise _NAO_AUTENTICADO

    return UsuarioOut(**res.data)


def require_perfil(*perfis: PerfilUsuario):
    """Exige que o usuário tenha um dos perfis informados. ADMIN sempre passa."""
    permitidos = {p.value for p in perfis} | {PerfilUsuario.ADMIN.value}

    def checker(usuario: UsuarioOut = Depends(get_current_user)) -> UsuarioOut:
        perfil = usuario.perfil.value if hasattr(usuario.perfil, "value") else usuario.perfil
        if perfil not in permitidos:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Você não tem permissão para esta ação",
            )
        return usuario

    return checker


def lider_ou_superior(usuario: UsuarioOut = Depends(get_current_user)) -> UsuarioOut:
    """Permite apenas Líder, Supervisor, Gerência e Admin."""
    permitidos = {
        PerfilUsuario.LIDER.value,
        PerfilUsuario.SUPERVISOR.value,
        PerfilUsuario.GERENCIA.value,
        PerfilUsuario.ADMIN.value,
    }
    perfil = usuario.perfil.value if hasattr(usuario.perfil, "value") else usuario.perfil
    if perfil not in permitidos:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Ação restrita a líderes ou superiores",
        )
    return usuario

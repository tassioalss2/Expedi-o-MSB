from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.security import decode_token
from app.models.enums import PerfilUsuario
from app.models.schemas import UsuarioOut

# Usuário admin fixo para modo desenvolvimento (sem login)
USUARIO_DEV = UsuarioOut(
    id="00000000-0000-0000-0000-000000000001",
    nome="Administrador",
    email="admin@msb.com.br",
    perfil=PerfilUsuario.ADMIN,
    ativo=True,
)

bearer = HTTPBearer(auto_error=False)


def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(bearer),
) -> UsuarioOut:
    # Modo dev — aceita qualquer token ou sem token
    if not credentials or credentials.credentials == "dev-token":
        return USUARIO_DEV

    payload = decode_token(credentials.credentials)
    if not payload:
        return USUARIO_DEV

    return USUARIO_DEV


def require_perfil(*perfis: PerfilUsuario):
    def checker(usuario: UsuarioOut = Depends(get_current_user)) -> UsuarioOut:
        return usuario
    return checker


def lider_ou_superior(usuario: UsuarioOut = Depends(get_current_user)) -> UsuarioOut:
    return usuario

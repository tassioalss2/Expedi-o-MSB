from fastapi import APIRouter, Depends, HTTPException, status

from app.core.database import get_service_db
from app.core.deps import get_current_user, require_perfil
from app.core.security import create_access_token, hash_password, verify_password
from app.models.enums import PerfilUsuario
from app.models.schemas import (
    LoginRequest,
    SenhaUpdate,
    TokenResponse,
    UsuarioCreate,
    UsuarioOut,
    UsuarioUpdate,
)

router = APIRouter(prefix="/auth", tags=["auth"])

# Somente Admin gerencia usuários
somente_admin = require_perfil(PerfilUsuario.ADMIN)


@router.post("/login", response_model=TokenResponse)
def login(payload: LoginRequest):
    db = get_service_db()
    result = db.table("usuarios").select("*").eq("email", payload.email).eq("ativo", True).single().execute()

    if not result.data or not verify_password(payload.senha, result.data["senha_hash"]):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Email ou senha inválidos")

    usuario = UsuarioOut(**result.data)
    token = create_access_token({"sub": str(usuario.id), "perfil": usuario.perfil})
    return TokenResponse(access_token=token, usuario=usuario)


@router.get("/me", response_model=UsuarioOut)
def me(usuario: UsuarioOut = Depends(get_current_user)):
    return usuario


# ── Gestão de usuários (Admin) ──────────────────────────────────────────────

@router.get("/usuarios", response_model=list[UsuarioOut])
def listar_usuarios(_: UsuarioOut = Depends(somente_admin)):
    db = get_service_db()
    res = db.table("usuarios").select("*").order("nome").execute()
    return [UsuarioOut(**u) for u in res.data]


@router.post("/usuarios", response_model=UsuarioOut, status_code=201)
def criar_usuario(payload: UsuarioCreate, _: UsuarioOut = Depends(somente_admin)):
    db = get_service_db()

    existe = db.table("usuarios").select("id").eq("email", payload.email).execute()
    if existe.data:
        raise HTTPException(status_code=400, detail="Email já cadastrado")

    result = db.table("usuarios").insert({
        "nome": payload.nome,
        "email": payload.email,
        "senha_hash": hash_password(payload.senha),
        "perfil": payload.perfil.value,
        "ativo": True,
    }).execute()
    return UsuarioOut(**result.data[0])


@router.patch("/usuarios/{usuario_id}", response_model=UsuarioOut)
def atualizar_usuario(
    usuario_id: str,
    payload: UsuarioUpdate,
    admin: UsuarioOut = Depends(somente_admin),
):
    db = get_service_db()

    alvo = db.table("usuarios").select("*").eq("id", usuario_id).single().execute()
    if not alvo.data:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")

    campos: dict = {}
    if payload.nome is not None:
        campos["nome"] = payload.nome
    if payload.perfil is not None:
        campos["perfil"] = payload.perfil.value
    if payload.ativo is not None:
        # Impede o admin de desativar ou rebaixar a si mesmo (evita lockout).
        if str(admin.id) == usuario_id and payload.ativo is False:
            raise HTTPException(status_code=400, detail="Você não pode desativar o próprio usuário")
        campos["ativo"] = payload.ativo
    if payload.perfil is not None and str(admin.id) == usuario_id and payload.perfil != PerfilUsuario.ADMIN:
        raise HTTPException(status_code=400, detail="Você não pode remover o próprio acesso de Admin")

    if not campos:
        return UsuarioOut(**alvo.data)

    res = db.table("usuarios").update(campos).eq("id", usuario_id).execute()
    return UsuarioOut(**res.data[0])


@router.post("/usuarios/{usuario_id}/senha", status_code=204)
def redefinir_senha(
    usuario_id: str,
    payload: SenhaUpdate,
    _: UsuarioOut = Depends(somente_admin),
):
    if not payload.nova_senha or len(payload.nova_senha) < 6:
        raise HTTPException(status_code=400, detail="A senha deve ter ao menos 6 caracteres")

    db = get_service_db()
    alvo = db.table("usuarios").select("id").eq("id", usuario_id).single().execute()
    if not alvo.data:
        raise HTTPException(status_code=404, detail="Usuário não encontrado")

    db.table("usuarios").update({"senha_hash": hash_password(payload.nova_senha)}).eq("id", usuario_id).execute()
    return None

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.database import get_service_db
from app.core.deps import get_current_user
from app.core.security import create_access_token, hash_password, verify_password
from app.models.schemas import LoginRequest, TokenResponse, UsuarioCreate, UsuarioOut

router = APIRouter(prefix="/auth", tags=["auth"])


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


@router.post("/usuarios", response_model=UsuarioOut, status_code=201)
def criar_usuario(payload: UsuarioCreate, _: UsuarioOut = Depends(get_current_user)):
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

# ACE-MSB — Como Instalar e Rodar

## Pré-requisitos

- Python 3.11+
- Node.js 18+
- Conta gratuita no Supabase (supabase.com)

---

## 1. Configurar o Supabase (banco de dados)

1. Acesse supabase.com e crie um projeto
2. Vá em **SQL Editor** e cole todo o conteúdo do arquivo `backend/database/schema.sql`
3. Clique em **Run** — isso cria todas as tabelas e o usuário admin inicial
4. Vá em **Project Settings > API** e copie:
   - `Project URL`
   - `anon public` key
   - `service_role` key (fica em Secret)

---

## 2. Configurar o Backend (Python / FastAPI)

```bash
cd backend

# Copiar arquivo de variáveis
copy .env.example .env
```

Edite o `.env` com os dados do Supabase:
```
SUPABASE_URL=https://xxxxxxxxxxx.supabase.co
SUPABASE_KEY=eyJ...   (anon key)
SUPABASE_SERVICE_KEY=eyJ...   (service_role key)
SECRET_KEY=qualquer-string-longa-e-aleatoria-aqui
```

```bash
# Criar ambiente virtual
python -m venv venv

# Ativar (Windows)
venv\Scripts\activate

# Instalar dependências
pip install -r requirements.txt

# Rodar o servidor
uvicorn main:app --reload --port 8000
```

O backend estará em: http://localhost:8000
Documentação automática da API: http://localhost:8000/docs

---

## 3. Configurar o Frontend (React)

```bash
cd frontend

# Instalar dependências
npm install

# Rodar em desenvolvimento
npm run dev
```

O frontend estará em: http://localhost:5173

---

## 4. Primeiro acesso

Login padrão (criado pelo schema.sql):
- **Email:** admin@msb.com.br
- **Senha:** Admin@MSB2024

> **Importante:** Troque a senha após o primeiro login!

---

## 5. Estrutura de pastas

```
ACE-MSB/
├── backend/
│   ├── app/
│   │   ├── api/          ← Rotas da API
│   │   ├── core/         ← Config, auth, banco
│   │   ├── models/       ← Schemas e enums
│   │   └── services/     ← Lógica de negócio
│   ├── database/
│   │   └── schema.sql    ← SQL para criar as tabelas
│   ├── main.py           ← Entry point FastAPI
│   ├── requirements.txt
│   └── .env.example
└── frontend/
    ├── src/
    │   ├── components/   ← Componentes reutilizáveis
    │   ├── pages/        ← Telas do app
    │   ├── store/        ← Estado global (Zustand)
    │   ├── lib/          ← API client, configs
    │   └── types/        ← TypeScript types
    └── package.json
```

---

## 6. Importar pedidos por CSV

O sistema aceita importação de pedidos via arquivo CSV (separador `;`) ou Excel.

**Colunas obrigatórias:**
```
numero_pedido ; cliente_codigo ; produto_codigo ; lote ; qtd_solicitada ; data_prevista_entrega
```

**Colunas opcionais:**
```
transportadora ; prioridade (NORMAL/ALTA/CRITICA)
```

**Formato da data:** DD/MM/AAAA

**Exemplo:**
```csv
numero_pedido;cliente_codigo;produto_codigo;lote;qtd_solicitada;data_prevista_entrega;prioridade
PED-001;CLI001;PROD-ABC;LOT2024-01;10;15/06/2026;ALTA
PED-001;CLI001;PROD-XYZ;LOT2024-02;5;15/06/2026;ALTA
PED-002;CLI002;PROD-ABC;LOT2024-01;20;20/06/2026;NORMAL
```

> Pedidos com múltiplos itens: repita o número do pedido, um item por linha.

---

## 7. Perfis de acesso

| Perfil | O que pode fazer |
|--------|-----------------|
| OPERADOR | Separar pedidos |
| CONFERENTE | Conferir pedidos |
| LIDER | Tudo acima + tratativas, bloqueios, fechar ocorrências |
| SUPERVISOR | Igual ao LIDER |
| FATURAMENTO | Registrar NF |
| QUALIDADE | Ver tudo, criar ocorrências |
| GERENCIA | Ver tudo, dashboards completos |
| ADMIN | Acesso total |

---

## 8. Deploy em produção (opcional)

**Backend:** Railway.app ou Render.com
- Aponte para o arquivo `main.py`
- Configure as variáveis de ambiente da seção 2

**Frontend:**
```bash
npm run build
```
- Faça upload da pasta `dist/` para Netlify, Vercel ou qualquer servidor web estático

---

## Suporte

Em caso de dúvidas, abra uma ocorrência no sistema ou entre em contato com a TI MSB.

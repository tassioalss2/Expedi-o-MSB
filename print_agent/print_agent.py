"""
MSB Print Agent v3.4
====================
Agente de impressao para Zebra TLP 2844.

Nova arquitetura: o agente e um CLIENTE que consulta a fila de impressao
no Supabase a cada 1 segundo. Elimina o problema de CORS/Private-Network-Access
do Chrome 149+ que bloqueava conexoes browser->localhost.

Fluxo:
  App (Vercel HTTPS) --> Backend Render --> fila_impressao (Supabase)
  Print Agent        --> Supabase REST API --> busca job --> imprime

Uso:
  python print_agent.py
  (ou double-click no MSB_PrintAgent.exe)
"""

import json
import sys
import time
from datetime import datetime

# ── Verificar pywin32 ─────────────────────────────────────────────────────────
try:
    import win32print
    import win32ui
    import win32con
except ImportError:
    print("\n" + "="*55)
    print("  ERRO: pywin32 nao instalado!")
    print("  Execute: pip install pywin32")
    print("="*55 + "\n")
    input("Pressione ENTER para sair...")
    sys.exit(1)

try:
    import requests
except ImportError:
    print("\n" + "="*55)
    print("  ERRO: requests nao instalado!")
    print("  Execute: pip install requests")
    print("="*55 + "\n")
    input("Pressione ENTER para sair...")
    sys.exit(1)

# Pillow — opcional para renderizar logo. Se ausente, usa texto.
try:
    from PIL import Image, ImageWin
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

# ── Configuracao Supabase ─────────────────────────────────────────────────────
SUPABASE_URL = "https://lgpsqwgvepdfilknggec.supabase.co"
SUPABASE_KEY = (
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9"
    ".eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxncHNxd2d2ZXBkZmlsa25nZ2VjIiwicm9sZSI6"
    "InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc4MDM3ODY0NywiZXhwIjoyMDk1OTU0NjQ3fQ"
    ".9gnrlLZshPQq5effMXO-Km1z_HWvWonme9nWaUjm09A"
)

POLL_INTERVAL = 1  # segundos entre consultas

HEADERS = {
    "apikey": SUPABASE_KEY,
    "Authorization": f"Bearer {SUPABASE_KEY}",
    "Content-Type": "application/json",
    "Prefer": "return=representation",
}

# ── Logo MSB — carrega do arquivo PNG na mesma pasta do EXE ──────────────────
import os as _os

def _get_logo_path() -> str:
    """Retorna o caminho da logo. Funciona em script .py e em EXE PyInstaller."""
    if getattr(sys, 'frozen', False):
        base = sys._MEIPASS          # pasta temporaria do PyInstaller
    else:
        base = _os.path.dirname(_os.path.abspath(__file__))
    return _os.path.join(base, 'msb_logo.png')

LOGO_PATH = _get_logo_path()


# ── Supabase REST helpers ─────────────────────────────────────────────────────

def buscar_proximo_job() -> dict | None:
    """Busca o proximo job pendente na fila de impressao."""
    url = (
        f"{SUPABASE_URL}/rest/v1/fila_impressao"
        "?status=eq.pendente&order=criado_em.asc&limit=1"
    )
    resp = requests.get(url, headers=HEADERS, timeout=5)
    resp.raise_for_status()
    data = resp.json()
    return data[0] if data else None


def atualizar_status(job_id: str, status: str) -> None:
    """Atualiza o status de um job na fila."""
    url = f"{SUPABASE_URL}/rest/v1/fila_impressao?id=eq.{job_id}"
    requests.patch(url, headers=HEADERS, json={"status": status}, timeout=5)


# ── Impressora ────────────────────────────────────────────────────────────────

def encontrar_tlp2844() -> str | None:
    """
    Busca a TLP 2844 nas impressoras instaladas no Windows.
    Prioriza a impressora compartilhada em rede (ex: 'em MSB-512HW').
    """
    try:
        impressoras = win32print.EnumPrinters(
            win32print.PRINTER_ENUM_LOCAL | win32print.PRINTER_ENUM_CONNECTIONS,
            None, 2
        )

        print("\n  Impressoras encontradas:")
        nomes = [p['pPrinterName'] for p in impressoras]
        for n in nomes:
            print(f"    - {n}")

        candidatas = [n for n in nomes if '2844' in n.lower() or 'tlp' in n.lower()]

        if not candidatas:
            candidatas = [n for n in nomes
                          if 'zd230' not in n.lower()
                          and ('zdesigner' in n.lower() or 'zebra' in n.lower())]

        if not candidatas:
            return None

        # Prefere a que tem referencia de rede
        for n in candidatas:
            nl = n.lower()
            if 'msb' in nl or '512' in nl or 'em ' in nl or '\\\\' in nl:
                return n

        return candidatas[-1]

    except Exception as e:
        print(f"  Erro ao listar impressoras: {e}")
    return None


# ── GDI helpers ───────────────────────────────────────────────────────────────

def formatar_data(iso: str) -> str:
    """Converte ISO para DD/MM/YYYY."""
    try:
        dt = datetime.fromisoformat(iso.replace('Z', '+00:00'))
        return dt.strftime('%d/%m/%Y')
    except Exception:
        return iso[:10] if len(iso) >= 10 else iso


MESES_PT = ['janeiro','fevereiro','marco','abril','maio','junho',
            'julho','agosto','setembro','outubro','novembro','dezembro']

COR_PRETO  = 0x000000
COR_BRANCO = 0xFFFFFF


# ── Code 39 Barcode ───────────────────────────────────────────────────────────
# Cada simbolo: 9 elementos alternando barra/espaco (B S B S B S B S B).
# 1 = largo (wide), 0 = estreito (narrow). Exatamente 3 elementos largos por simbolo.
_C39 = {
    '0':(0,0,0,1,1,0,1,0,0), '1':(1,0,0,1,0,0,0,0,1),
    '2':(0,0,1,1,0,0,0,0,1), '3':(1,0,1,1,0,0,0,0,0),
    '4':(0,0,0,1,0,1,0,0,1), '5':(1,0,0,1,0,1,0,0,0),
    '6':(0,0,1,1,0,1,0,0,0), '7':(0,0,0,1,0,0,0,1,1),
    '8':(1,0,0,1,0,0,0,1,0), '9':(0,0,1,1,0,0,0,1,0),
    'A':(1,0,0,0,1,0,0,0,1), 'B':(0,0,1,0,1,0,0,0,1),
    'C':(1,0,1,0,1,0,0,0,0), 'D':(0,0,0,0,1,0,1,0,1),
    'E':(1,0,0,0,1,0,1,0,0), 'F':(0,0,1,0,1,0,1,0,0),
    'G':(0,0,0,0,1,1,0,0,1), 'H':(1,0,0,0,1,1,0,0,0),
    'I':(0,0,1,0,1,1,0,0,0), 'J':(0,0,0,0,1,0,0,1,1),
    'K':(1,0,0,0,0,0,1,0,1), 'L':(0,0,1,0,0,0,1,0,1),
    'M':(1,0,1,0,0,0,1,0,0), 'N':(0,0,0,0,0,1,1,0,1),
    'O':(1,0,0,0,0,1,1,0,0), 'P':(0,0,1,0,0,1,1,0,0),
    'Q':(0,0,0,0,0,0,1,1,1), 'R':(1,0,0,0,0,0,1,1,0),
    'S':(0,0,1,0,0,0,1,1,0), 'T':(0,0,0,0,0,1,0,1,1),
    'U':(1,1,0,0,0,0,0,0,1), 'V':(0,1,1,0,0,0,0,0,1),
    'W':(1,1,1,0,0,0,0,0,0), 'X':(0,1,0,0,0,1,0,0,1),
    'Y':(1,1,0,0,0,1,0,0,0), 'Z':(0,1,1,0,0,1,0,0,0),
    '-':(0,1,0,0,0,0,0,1,1), '.':(1,1,0,0,0,0,0,1,0),
    ' ':(0,1,1,0,0,0,0,1,0), '$':(0,1,0,1,0,1,0,0,0),
    '/':(0,1,0,1,0,0,0,1,0), '+':(0,1,0,0,0,1,0,1,0),
    '%':(0,0,0,1,0,1,0,1,0), '*':(0,1,0,0,0,1,1,0,0),
}

def _c39_largura(texto: str, N: int, W: int) -> int:
    """Calcula a largura total do barcode em pixels (sem desenhar)."""
    chars = ['*'] + [c for c in texto.upper() if c in _C39] + ['*']
    n_sim    = len(chars)
    n_wide   = n_sim * 3
    n_narrow = n_sim * 6 + (n_sim - 1)   # 6 narrow/sym + (n-1) gaps inter-char
    return n_narrow * N + n_wide * W

def _c39_draw(hdc, texto: str, x0: int, y0: int, h: int, N: int = 2, W: int = 5) -> int:
    """
    Desenha barcode Code 39 no HDC. Argumentos em pixels.
    Posicoes pares (0,2,4,6,8) = barras pretas; impares = espacos brancos.
    Retorna a largura total desenhada em pixels.
    """
    chars = ['*'] + [c for c in texto.upper() if c in _C39] + ['*']
    x = x0
    for i, c in enumerate(chars):
        for j, e in enumerate(_C39[c]):
            larg = W if e else N
            cor  = COR_PRETO if j % 2 == 0 else COR_BRANCO
            hdc.FillSolidRect((x, y0, x + larg, y0 + h), cor)
            x += larg
        if i < len(chars) - 1:
            hdc.FillSolidRect((x, y0, x + N, y0 + h), COR_BRANCO)  # gap inter-char
            x += N
    return x - x0


# ── Espelho de Carga ──────────────────────────────────────────────────────────

def imprimir_espelho_gdi(dados: dict, nome_impressora: str) -> None:
    """
    MSB Print Agent v3.4 — Layout v3.3 + barcode Code 39 da OV.
    Papel 100 mm x 60 mm — Zebra TLP 2844 (203 DPI, monocromatico).

    Estrutura:
      Zona 1 ( 0-17 mm): Logo MSB real + numero da NF
      Zona 2 (17-38 mm): Contador de volume MUITO grande (X / Y)
      Zona 3 (38-60 mm): REMETENTE bar + endereco (col. esq) | barcode OV (col. dir)
      Faixa (85-100mm):  CUIDADO - FRAGIL (preto, texto branco 90 graus)

    Zona 3 — divisao de colunas:
      Coluna esq  (x= 2-43mm): endereco do remetente + data + OV texto
      Coluna dir  (x=44-83mm): barcode Code 39 da OV centralizado + texto legivel
    """
    hdc = win32ui.CreateDC()
    hdc.CreatePrinterDC(nome_impressora)

    dpi_x = hdc.GetDeviceCaps(win32con.LOGPIXELSX)
    dpi_y = hdc.GetDeviceCaps(win32con.LOGPIXELSY)

    def px(mm, eixo='x'):
        return int(mm * (dpi_x if eixo == 'x' else dpi_y) / 25.4)

    def mk_font(pt, bold=False, angulo=0):
        return win32ui.CreateFont({
            'name': 'Arial',
            'height': -int(pt * dpi_y / 72),
            'weight': 700 if bold else 400,
            'charset': 0,
            'escapement': angulo * 10,
            'orientation': angulo * 10,
        })

    def txt(s, x_mm, y_mm, pt, bold=False, cor=COR_PRETO, angulo=0):
        hdc.SetTextColor(cor)
        f = mk_font(pt, bold, angulo)
        old = hdc.SelectObject(f)
        hdc.TextOut(px(x_mm), px(y_mm, 'y'), s)
        w, _ = hdc.GetTextExtent(s)
        hdc.SelectObject(old)
        return w

    def linha_h(x0_mm, y_mm, x1_mm, esp=1):
        pen = win32ui.CreatePen(0, esp, COR_PRETO)
        old = hdc.SelectObject(pen)
        hdc.MoveTo((px(x0_mm), px(y_mm, 'y')))
        hdc.LineTo((px(x1_mm), px(y_mm, 'y')))
        hdc.SelectObject(old)

    def linha_v(x_mm, y0_mm, y1_mm, esp=1):
        pen = win32ui.CreatePen(0, esp, COR_PRETO)
        old = hdc.SelectObject(pen)
        hdc.MoveTo((px(x_mm), px(y0_mm, 'y')))
        hdc.LineTo((px(x_mm), px(y1_mm, 'y')))
        hdc.SelectObject(old)

    def rect_borda(x0, y0, x1, y1, esp=1):
        pen = win32ui.CreatePen(0, esp, COR_PRETO)
        old = hdc.SelectObject(pen)
        hdc.MoveTo((px(x0), px(y0, 'y')))
        hdc.LineTo((px(x1), px(y0, 'y')))
        hdc.LineTo((px(x1), px(y1, 'y')))
        hdc.LineTo((px(x0), px(y1, 'y')))
        hdc.LineTo((px(x0), px(y0, 'y')))
        hdc.SelectObject(old)

    # ── Dados ─────────────────────────────────────────────────────────────────
    caixa  = dados.get('caixa', 1)
    total  = dados.get('total_caixas', 1)
    nf_num = str(dados.get('numero_nf', ''))
    ov     = str(dados.get('numero_pedido', ''))
    iso    = dados.get('data', '')

    try:
        dt = datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone()
        hora_str = dt.strftime('%H:%M')
        data_str = dt.strftime('%d/%m/%Y')
    except Exception:
        hora_str = ''
        data_str = ''

    # Constantes de layout (mm)
    M      = 2      # margem esquerda
    FX     = 85     # inicio da faixa FRAGIL
    LW     = 100    # largura total
    LH     = 60     # altura total
    BC_SEP = 44     # separador vertical: endereco | barcode (mm)

    hdc.StartDoc("Espelho MSB")
    hdc.StartPage()
    hdc.SetBkMode(1)  # TRANSPARENT

    # =========================================================================
    # FAIXA CUIDADO-FRAGIL  (x: 85-100 mm, altura total, fundo preto)
    # =========================================================================
    hdc.FillSolidRect((px(FX), 0, px(LW), px(LH, 'y')), COR_PRETO)
    hdc.SetTextColor(COR_BRANCO)
    f_fr = mk_font(10, bold=True, angulo=90)
    old_f = hdc.SelectObject(f_fr)
    _txt_fragil = "CUIDADO  -  FRAGIL"
    w_fr, _ = hdc.GetTextExtent(_txt_fragil)
    y_fr = (px(LH, 'y') + w_fr) // 2
    h_fr = int(10 * dpi_y / 72)
    x_fr = px(FX) + (px(LW) - px(FX) - h_fr) // 2
    hdc.TextOut(x_fr, y_fr, _txt_fragil)
    hdc.SelectObject(old_f)

    # =========================================================================
    # ZONA 1 — LOGO + NF  (y: 0-17 mm)
    # =========================================================================

    logo_x, logo_y, logo_w, logo_h = M, 0.5, 32.0, 16.0

    logo_ok = False
    if HAS_PIL:
        try:
            img  = Image.open(LOGO_PATH).convert('RGBA')
            bg   = Image.new('RGB', img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[3])
            gray = bg.convert('L').point(lambda v: 0 if v < 210 else 255)
            rgb  = gray.convert('RGB')
            tw   = px(logo_w)
            th   = px(logo_h, 'y')
            resized = rgb.resize((tw, th), Image.LANCZOS)
            dib  = ImageWin.Dib(resized)
            x1   = px(logo_x)
            y1   = px(logo_y, 'y')
            dib.draw(hdc.GetHandleOutput(), (x1, y1, x1 + tw, y1 + th))
            logo_ok = True
        except Exception as e:
            print(f"  [Logo] Erro ao renderizar: {e}")

    if not logo_ok:
        hdc.SetTextColor(COR_PRETO)
        f_msb = mk_font(18, bold=True)
        old_f = hdc.SelectObject(f_msb)
        hdc.TextOut(px(3), px(2, 'y'), "mSb")
        w_msb, _ = hdc.GetTextExtent("mSb")
        hdc.SelectObject(old_f)
        f_reg = mk_font(7)
        old_f = hdc.SelectObject(f_reg)
        hdc.SetTextColor(COR_PRETO)
        hdc.TextOut(px(3) + w_msb, px(1, 'y'), "R")
        hdc.SelectObject(old_f)
        txt("Medical System do Brasil", 3, 12, 5.5, cor=COR_PRETO)

    rect_borda(logo_x, logo_y, logo_x + logo_w, logo_y + logo_h, esp=1)
    linha_v(logo_x + logo_w + 1, 0.5, 17, esp=1)

    txt("NF", 37, 1.0, 9, bold=True, cor=COR_PRETO)
    txt(nf_num, 37, 5.5, 26, bold=True, cor=COR_PRETO)

    linha_h(M, 17, FX - M, esp=2)

    # =========================================================================
    # ZONA 2 — VOLUME X / Y  (y: 17-38 mm)
    # =========================================================================

    f_vol = mk_font(7, bold=True)
    old_f = hdc.SelectObject(f_vol)
    hdc.SetTextColor(COR_PRETO)
    w_vol, _ = hdc.GetTextExtent("VOLUME")
    hdc.TextOut((px(FX) - w_vol) // 2, px(18.5, 'y'), "VOLUME")
    hdc.SelectObject(old_f)

    s_cx  = str(caixa)
    s_sep = "  /  "
    s_tot = str(total)

    f_cx = mk_font(38, bold=True)
    old_f = hdc.SelectObject(f_cx)
    hdc.SetTextColor(COR_PRETO)
    w1, _ = hdc.GetTextExtent(s_cx)
    w2, _ = hdc.GetTextExtent(s_sep)
    w3, _ = hdc.GetTextExtent(s_tot)
    total_w = w1 + w2 + w3
    x0 = max(px(M), (px(FX) - total_w) // 2)
    hdc.TextOut(x0, px(21, 'y'), s_cx + s_sep + s_tot)
    hdc.SelectObject(old_f)

    linha_h(M, 38, FX - M, esp=2)

    # =========================================================================
    # ZONA 3 — REMETENTE (col.esq) | BARCODE OV (col.dir)  (y: 38-60 mm)
    # =========================================================================

    # Header "REMETENTE" — fundo preto, texto branco (largura total)
    hdc.FillSolidRect((px(M), px(38.3, 'y'), px(FX - M), px(43, 'y')), COR_PRETO)
    txt("REMETENTE", 3.5, 38.9, 7, bold=True, cor=COR_BRANCO)

    # Separador vertical das colunas (abaixo do header REMETENTE)
    linha_v(BC_SEP, 43, LH, esp=1)

    # Coluna esquerda — endereco (x=2-43mm)
    y_e  = 43.2
    step = 2.15

    txt("MSB MEDICAL SYSTEM DO BRASIL",       M, y_e,          6.5, bold=True)
    txt("Rua Araponga, 364 — Pitangueiras",    M, y_e + step,   5.5)
    txt("Lauro de Freitas — Bahia",            M, y_e + 2*step, 5.5)
    txt("CEP: 42.701-330",                     M, y_e + 3*step, 5.5)
    txt("(71) 3024-4015",                      M, y_e + 4*step, 5.5)
    txt(f"{data_str}  {hora_str}h",            M, y_e + 5*step, 5.5)
    txt(f"OV: {ov}",                           M, y_e + 6*step, 6, bold=True)

    # Coluna direita — barcode Code 39 da OV (x=44.5-83mm)
    bc_x0_mm  = BC_SEP + 0.5
    avail_px  = px(FX - M - bc_x0_mm)   # pixels disponiveis na coluna

    ov_cod = ''.join(c for c in ov.upper() if c in _C39)
    if ov_cod:
        # Escolhe N e W para caber na largura disponivel (fallback progressivo)
        N, W = 2, 5
        if _c39_largura(ov_cod, N, W) > avail_px:
            N, W = 2, 4
        if _c39_largura(ov_cod, N, W) > avail_px:
            N, W = 1, 3

        bc_h_px  = px(11.5, 'y')       # altura das barras
        bc_y0_px = px(43.5, 'y')       # inicio (logo abaixo do header REMETENTE)
        bc_w_px  = _c39_largura(ov_cod, N, W)

        # Centraliza horizontalmente na coluna direita
        bc_x0_px = px(bc_x0_mm) + max(0, (avail_px - bc_w_px) // 2)

        _c39_draw(hdc, ov_cod, bc_x0_px, bc_y0_px, bc_h_px, N, W)

        # Texto legivel (human-readable) abaixo do barcode, centralizado
        f_hr  = mk_font(6, bold=True)
        old_f = hdc.SelectObject(f_hr)
        hdc.SetTextColor(COR_PRETO)
        w_hr, _ = hdc.GetTextExtent(ov)
        hdc.TextOut(bc_x0_px + max(0, (bc_w_px - w_hr) // 2),
                    bc_y0_px + bc_h_px + px(1.2, 'y'), ov)
        hdc.SelectObject(old_f)

    hdc.EndPage()
    hdc.EndDoc()
    hdc.DeleteDC()


# ── Etiqueta de Inventario ────────────────────────────────────────────────────

def imprimir_gdi(dados: dict, nome_impressora: str) -> None:
    """
    Imprime etiqueta via GDI usando o driver ZDesigner.
    O driver ja tem a etiqueta configurada (100mm x 60mm, gap 3mm).
    """
    hdc = win32ui.CreateDC()
    hdc.CreatePrinterDC(nome_impressora)

    dpi_x = hdc.GetDeviceCaps(win32con.LOGPIXELSX)
    dpi_y = hdc.GetDeviceCaps(win32con.LOGPIXELSY)

    def mm_x(mm): return int(mm * dpi_x / 25.4)
    def mm_y(mm): return int(mm * dpi_y / 25.4)

    font_h = -int(19.5 * dpi_y / 72)
    font = win32ui.CreateFont({
        'name': 'Arial',
        'height': font_h,
        'weight': 900,
        'charset': 0,
    })

    val = dados.get('validade') or '---'
    data = formatar_data(dados.get('data_inventario', ''))

    linhas = [
        f"ITEM: {dados.get('codigo', '')}",
        f"LOTE: {dados.get('lote', '')}",
        f"VAL: {val}",
        f"QNT: {dados.get('quantidade', 0)} UNIDADES",
        f"Nome: {dados.get('operador', '')}",
        f"INVENTARIO: {data}",
    ]

    hdc.StartDoc("Etiqueta MSB")
    hdc.StartPage()
    old_font = hdc.SelectObject(font)

    x       = mm_x(1.5)
    y_base  = mm_y(1.5)
    y_step  = mm_y(9.5)

    for i, texto in enumerate(linhas):
        hdc.TextOut(x, y_base + i * y_step, texto)

    hdc.SelectObject(old_font)
    hdc.EndPage()
    hdc.EndDoc()
    hdc.DeleteDC()


# ── Logging ───────────────────────────────────────────────────────────────────

def log(msg: str):
    hora = datetime.now().strftime('%H:%M:%S')
    print(f"  [{hora}] {msg}")


# ── Loop principal ────────────────────────────────────────────────────────────

def polling_loop(nome_impressora: str) -> None:
    """
    Consulta a fila de impressao no Supabase a cada POLL_INTERVAL segundos.
    Quando encontra um job pendente, imprime e marca como concluido.
    """
    erros_consecutivos = 0

    while True:
        try:
            job = buscar_proximo_job()

            if job:
                job_id  = job["id"]
                payload = job.get("payload", {})
                tipo    = payload.get("tipo", "inventario")

                atualizar_status(job_id, "processando")

                if tipo == "espelho":
                    total_cx = int(payload.get('total_caixas', 1))
                    nf_ref   = payload.get('numero_nf', '')
                    for cx in range(1, total_cx + 1):
                        payload_cx = {**payload, 'caixa': cx}
                        imprimir_espelho_gdi(payload_cx, nome_impressora)
                        if cx < total_cx:
                            time.sleep(1.5)  # Aguarda Zebra avançar o papel
                    desc = f"Espelho NF{nf_ref} x{total_cx}"
                else:
                    imprimir_gdi(payload, nome_impressora)
                    desc = payload.get("codigo", "?")

                atualizar_status(job_id, "concluido")
                log(f"OK  {desc} -> {nome_impressora}")
                erros_consecutivos = 0

        except requests.exceptions.ConnectionError:
            erros_consecutivos += 1
            if erros_consecutivos == 1:
                log("Sem conexao com internet — aguardando...")
        except Exception as e:
            erros_consecutivos += 1
            log(f"ERRO ({erros_consecutivos}): {e}")

        time.sleep(POLL_INTERVAL)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    import os
    os.system('cls' if os.name == 'nt' else 'clear')
    print("\n" + "="*55)
    print("  MSB Print Agent v3.4")
    print("="*55)

    logo_status = "com logo real (Pillow)" if HAS_PIL else "fallback texto (Pillow nao instalado)"
    print(f"\n  Logo: {logo_status}")

    print("\n  Buscando impressora TLP 2844...")
    printer = encontrar_tlp2844()

    if not printer:
        print("\n  ERRO: Impressora TLP 2844 nao encontrada!")
        print("  Verifique se o driver ZDesigner TLP 2844 esta instalado.")
        input("\n  Pressione ENTER para sair...")
        sys.exit(1)

    print(f"\n  Impressora   : {printer}")
    print(f"  Fila         : Supabase (nuvem)")
    print(f"  Intervalo    : {POLL_INTERVAL}s")
    print(f"\n  Aguardando trabalhos de impressao...")
    print(f"  (feche esta janela ou pressione Ctrl+C para parar)\n")
    print("-"*55)

    try:
        polling_loop(printer)
    except KeyboardInterrupt:
        print("\n\n  Agente encerrado.")


if __name__ == '__main__':
    main()

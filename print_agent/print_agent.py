"""
MSB Print Agent v3.1
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


# ── GDI Printing ──────────────────────────────────────────────────────────────

def formatar_data(iso: str) -> str:
    """Converte ISO para DD/MM/YYYY."""
    try:
        dt = datetime.fromisoformat(iso.replace('Z', '+00:00'))
        return dt.strftime('%d/%m/%Y')
    except Exception:
        return iso[:10] if len(iso) >= 10 else iso


MESES_PT = ['janeiro','fevereiro','marco','abril','maio','junho',
            'julho','agosto','setembro','outubro','novembro','dezembro']

# Cores Win32 COLORREF = 0x00BBGGRR
COR_PRETO    = 0x000000
COR_BRANCO   = 0xFFFFFF
COR_VERMELHO = 0x0000FF   # RGB(255,0,0)


def imprimir_espelho_gdi(dados: dict, nome_impressora: str) -> None:
    """
    Imprime etiqueta espelho de carga — layout fiel ao modelo MSB.
    Zonas: [logo+NF] | [caixa X/Y grande] | [remetente+OV]
    Papel 100mm x 60mm, TLP 2844.
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
        w, h = hdc.GetTextExtent(s)
        hdc.SelectObject(old)
        return w

    # ── Dados ─────────────────────────────────────────────────────────────────
    caixa  = dados.get('caixa', 1)
    total  = dados.get('total_caixas', 1)
    nf_num = dados.get('numero_nf', '')
    ov     = dados.get('numero_pedido', '')
    iso    = dados.get('data', '')

    # Hora e data em horario local (astimezone converte UTC -> fuso do PC)
    try:
        dt = datetime.fromisoformat(iso.replace('Z', '+00:00')).astimezone()
        hora_str   = dt.strftime('%H:%M')
        data_longa = (f"Lauro de Freitas,   {dt.day} de "
                      f"{MESES_PT[dt.month-1]},   {dt.year}")
    except Exception:
        hora_str   = ''
        data_longa = ''

    # Constantes de layout (mm)
    M   = 2     # margem
    FX  = 85    # inicio da faixa FRAGIL
    LW  = 100   # largura total
    LH  = 60    # altura total

    hdc.StartDoc("Espelho MSB")
    hdc.StartPage()
    hdc.SetBkMode(1)   # TRANSPARENT

    # =========================================================================
    # FAIXA DIREITA: CUIDADO - FRAGIL (fundo preto, texto branco 90 graus)
    # =========================================================================
    hdc.FillSolidRect((px(FX), 0, px(LW), px(LH, 'y')), COR_PRETO)
    hdc.SetTextColor(COR_BRANCO)
    f = mk_font(10, bold=True, angulo=90)
    old_f = hdc.SelectObject(f)
    hdc.TextOut(px(FX + 4), px(57, 'y'), "CUIDADO  -  FRAGIL")
    hdc.SelectObject(old_f)

    # =========================================================================
    # ZONA 1 — LOGO + NF  (0..15mm)
    # =========================================================================
    # Borda do bloco logo (retangulo)
    pen2 = win32ui.CreatePen(0, 2, COR_PRETO)
    old_pen = hdc.SelectObject(pen2)
    hdc.MoveTo((px(M),   px(1,    'y')))
    hdc.LineTo((px(34),  px(1,    'y')))
    hdc.LineTo((px(34),  px(14.5, 'y')))
    hdc.LineTo((px(M),   px(14.5, 'y')))
    hdc.LineTo((px(M),   px(1,    'y')))
    hdc.SelectObject(old_pen)

    txt("mSb",                   3,  1.8,  14, bold=True,  cor=COR_PRETO)
    txt("Medical System do Brasil", 3, 10.8,  5, bold=False, cor=COR_PRETO)

    # Separador vertical (ja incluido pela borda do logo acima)
    # "NF" label
    txt("NF", 36, 1.5, 10, bold=True, cor=COR_PRETO)

    # NF numero em vermelho
    txt(nf_num, 46, 1.5, 18, bold=True, cor=COR_VERMELHO)

    # Linha divisoria zona 1 / zona 2
    pen1 = win32ui.CreatePen(0, 1, COR_PRETO)
    old_pen = hdc.SelectObject(pen1)
    hdc.MoveTo((px(M),       px(15.5, 'y')))
    hdc.LineTo((px(FX - M),  px(15.5, 'y')))
    hdc.SelectObject(old_pen)

    # =========================================================================
    # ZONA 2 — CAIXA X / Y  (16..36mm) — preto e vermelho
    # =========================================================================
    s1 = str(caixa)
    s2 = " / "
    s3 = str(total)
    f_cx = mk_font(28, bold=True)
    old_f = hdc.SelectObject(f_cx)
    w1, _ = hdc.GetTextExtent(s1)
    w2, _ = hdc.GetTextExtent(s2)
    w3, _ = hdc.GetTextExtent(s3)
    total_w = w1 + w2 + w3
    x0 = max(px(M), (px(FX) - total_w) // 2)
    y_cx = px(18.5, 'y')

    hdc.SetTextColor(COR_PRETO)
    hdc.TextOut(x0, y_cx, s1)
    hdc.SetTextColor(COR_VERMELHO)
    hdc.TextOut(x0 + w1, y_cx, s2 + s3)
    hdc.SelectObject(old_f)

    # Linha divisoria zona 2 / remetente
    old_pen = hdc.SelectObject(pen1)
    hdc.MoveTo((px(M),       px(36.5, 'y')))
    hdc.LineTo((px(FX - M),  px(36.5, 'y')))
    hdc.SelectObject(old_pen)

    # =========================================================================
    # ZONA 3 — REMETENTE + ENDERECO + OV  (37..60mm)
    # =========================================================================
    # Header "REMETENTE" (fundo preto, texto branco)
    hdc.FillSolidRect((px(M), px(37, 'y'), px(FX - M), px(42.5, 'y')), COR_PRETO)
    txt("REMETENTE", 3.5, 38, 7, bold=True, cor=COR_BRANCO)

    # Nome empresa
    txt("MSB MEDICAL SYSTEM DO BRASIL", M, 43, 6.5, bold=True, cor=COR_PRETO)

    # Linhas de endereco
    linhas = [
        "Rua Araponga, 364, Qd1, Lote 19",
        "Bairro Pitangueiras - Lauro de Freitas | BA",
        "Cep:42.701-330 - Telefone: (71) 3024-4015",
        "Site: www.msbbrasil.com - E-mail: msb@msbbrasil.com",
    ]
    y_e = 46.0
    for ln in linhas:
        txt(ln, M, y_e, 5.2, bold=False, cor=COR_PRETO)
        y_e += 2.8

    # Hora + data longa
    txt(f"{hora_str}      {data_longa}", M, y_e, 5.2, bold=False, cor=COR_PRETO)

    # OV em destaque na parte de baixo
    txt(f"OV: {ov}", M, 56.5, 7, bold=True, cor=COR_PRETO)

    hdc.EndPage()
    hdc.EndDoc()
    hdc.DeleteDC()


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
                    imprimir_espelho_gdi(payload, nome_impressora)
                    desc = f"Espelho NF{payload.get('numero_nf','')} {payload.get('caixa','')}/{payload.get('total_caixas','')}"
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
    print("  MSB Print Agent v3.1")
    print("="*55)

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

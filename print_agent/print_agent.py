"""
MSB Print Agent v3.0
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


MESES_PT = ['janeiro','fevereiro','março','abril','maio','junho',
            'julho','agosto','setembro','outubro','novembro','dezembro']


def imprimir_espelho_gdi(dados: dict, nome_impressora: str) -> None:
    """
    Imprime etiqueta espelho de carga (NF + OV + caixa X/Y + endereço MSB).
    Mesmo papel 100mm × 60mm da TLP 2844.
    """
    hdc = win32ui.CreateDC()
    hdc.CreatePrinterDC(nome_impressora)

    dpi_x = hdc.GetDeviceCaps(win32con.LOGPIXELSX)
    dpi_y = hdc.GetDeviceCaps(win32con.LOGPIXELSY)

    def mm_x(mm): return int(mm * dpi_x / 25.4)
    def mm_y(mm): return int(mm * dpi_y / 25.4)

    def mk_font(pt, bold=False, angle_deg=0):
        return win32ui.CreateFont({
            'name': 'Arial',
            'height': -int(pt * dpi_y / 72),
            'weight': 700 if bold else 400,
            'charset': 0,
            'escapement': angle_deg * 10,
            'orientation': angle_deg * 10,
        })

    # Dados
    caixa  = dados.get('caixa', 1)
    total  = dados.get('total_caixas', 1)
    nf_num = dados.get('numero_nf', '')
    ov     = dados.get('numero_pedido', '')
    iso    = dados.get('data', '')

    # Formata data estilo "Lauro de Freitas, 11 de junho de 2026"
    try:
        dt = datetime.fromisoformat(iso.replace('Z', '+00:00'))
        data_ext = f"Lauro de Freitas, {dt.day} de {MESES_PT[dt.month-1]} de {dt.year}"
        hora_str = dt.strftime('%H:%M')
    except Exception:
        data_ext = iso[:10] if iso else ''
        hora_str = ''

    faixa_x  = mm_x(85)   # faixa CUIDADO FRAGIL começa em 85mm
    label_w  = mm_x(100)
    label_h  = mm_y(60)

    hdc.StartDoc("Espelho MSB")
    hdc.StartPage()
    hdc.SetBkMode(1)  # TRANSPARENT

    # ── Faixa lateral CUIDADO - FRAGIL ──────────────────────────────────────
    hdc.FillSolidRect((faixa_x, 0, label_w, label_h), 0x000000)
    hdc.SetTextColor(0xFFFFFF)
    f = mk_font(10, bold=True, angle_deg=90)
    old_f = hdc.SelectObject(f)
    hdc.TextOut(faixa_x + mm_x(4), mm_y(56), "CUIDADO  -  FRAGIL")
    hdc.SelectObject(old_f)

    hdc.SetTextColor(0x000000)

    # ── NF ──────────────────────────────────────────────────────────────────
    f = mk_font(10, bold=True)
    old_f = hdc.SelectObject(f)
    hdc.TextOut(mm_x(2), mm_y(2), "NF")
    hdc.SelectObject(old_f)

    f = mk_font(20, bold=True)
    old_f = hdc.SelectObject(f)
    hdc.TextOut(mm_x(14), mm_y(1.5), nf_num)
    hdc.SelectObject(old_f)

    # ── OV ──────────────────────────────────────────────────────────────────
    f = mk_font(11, bold=True)
    old_f = hdc.SelectObject(f)
    hdc.TextOut(mm_x(2), mm_y(13), f"OV: {ov}")
    hdc.SelectObject(old_f)

    # ── Caixa X / Y (grande, centralizado) ──────────────────────────────────
    texto_cx = f"{caixa} / {total}"
    f = mk_font(28, bold=True)
    old_f = hdc.SelectObject(f)
    tw, _ = hdc.GetTextExtent(texto_cx)
    x_cx = max(mm_x(2), (faixa_x - tw) // 2)
    hdc.TextOut(x_cx, mm_y(19), texto_cx)
    hdc.SelectObject(old_f)

    # ── Header REMETENTE ────────────────────────────────────────────────────
    hdc.FillSolidRect((mm_x(2), mm_y(39), faixa_x - mm_x(1), mm_y(45)), 0x000000)
    hdc.SetTextColor(0xFFFFFF)
    f = mk_font(7, bold=True)
    old_f = hdc.SelectObject(f)
    hdc.TextOut(mm_x(3), mm_y(40), "REMETENTE")
    hdc.SelectObject(old_f)

    hdc.SetTextColor(0x000000)

    # ── Endereço ────────────────────────────────────────────────────────────
    f = mk_font(7, bold=True)
    old_f = hdc.SelectObject(f)
    hdc.TextOut(mm_x(2), mm_y(46), "MSB MEDICAL SYSTEM DO BRASIL")
    hdc.SelectObject(old_f)

    f = mk_font(6, bold=False)
    old_f = hdc.SelectObject(f)
    hdc.TextOut(mm_x(2), mm_y(50.5),
                "Rua Araponga, 364, Qd1, Lote 19 - Pitangueiras - Lauro de Freitas/BA  CEP: 42.701-330")
    hdc.TextOut(mm_x(2), mm_y(55.5),
                f"{hora_str}   {data_ext}")
    hdc.SelectObject(old_f)

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
    print("  MSB Print Agent v3.0")
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

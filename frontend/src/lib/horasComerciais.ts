/**
 * Calcula horas comerciais entre duas datas.
 * Horário comercial: 08:00–18:00, segunda a sexta (10h/dia útil).
 */
export function calcHorasComerciais(inicio: Date, fim: Date): number {
  if (fim <= inicio) return 0

  const INICIO_DIA = 8   // 08:00
  const FIM_DIA = 18     // 18:00
  const HORAS_DIA = FIM_DIA - INICIO_DIA // 10h por dia útil

  let total = 0
  const cur = new Date(inicio)

  // Avança até o início do próximo horário comercial se necessário
  const diaSemana = cur.getDay()
  if (diaSemana === 0) { cur.setDate(cur.getDate() + 1); cur.setHours(INICIO_DIA, 0, 0, 0) }
  if (diaSemana === 6) { cur.setDate(cur.getDate() + 2); cur.setHours(INICIO_DIA, 0, 0, 0) }
  if (cur.getHours() >= FIM_DIA) { cur.setDate(cur.getDate() + 1); cur.setHours(INICIO_DIA, 0, 0, 0) }
  if (cur.getHours() < INICIO_DIA) { cur.setHours(INICIO_DIA, 0, 0, 0) }

  while (cur < fim) {
    const diaAtual = cur.getDay()
    // Pula fim de semana
    if (diaAtual === 0 || diaAtual === 6) {
      cur.setDate(cur.getDate() + (diaAtual === 6 ? 2 : 1))
      cur.setHours(INICIO_DIA, 0, 0, 0)
      continue
    }

    const fimHojeDia = new Date(cur)
    fimHojeDia.setHours(FIM_DIA, 0, 0, 0)

    const fimRef = fim < fimHojeDia ? fim : fimHojeDia
    const inicioRef = cur.getHours() < INICIO_DIA ? new Date(cur.setHours(INICIO_DIA, 0, 0, 0)) : cur

    if (fimRef > inicioRef) {
      total += (fimRef.getTime() - inicioRef.getTime()) / 3600000
    }

    // Avança para o próximo dia útil
    cur.setDate(cur.getDate() + 1)
    cur.setHours(INICIO_DIA, 0, 0, 0)
  }

  return Math.round(total * 10) / 10 // arredonda em 1 decimal
}

export function formatarTempo(horas: number): string {
  if (horas < 1) {
    const min = Math.round(horas * 60)
    return `${min}min`
  }
  const h = Math.floor(horas)
  const min = Math.round((horas - h) * 60)
  if (min === 0) return `${h}h`
  return `${h}h ${min}min`
}

export function corSLA(horas: number, slaHoras = 2): string {
  if (horas <= slaHoras) return 'text-green-600'
  if (horas <= slaHoras * 2) return 'text-yellow-600'
  return 'text-red-600'
}

export function bgSLA(horas: number, slaHoras = 2): string {
  if (horas <= slaHoras) return 'bg-green-50 border-green-200'
  if (horas <= slaHoras * 2) return 'bg-yellow-50 border-yellow-200'
  return 'bg-red-50 border-red-200'
}

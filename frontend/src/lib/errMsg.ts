/**
 * Extrai uma string legível de qualquer erro do axios/FastAPI.
 * FastAPI retorna detail como string ou como array de objetos Pydantic.
 */
export function errMsg(e: any, fallback = 'Ocorreu um erro'): string {
  const detail = e?.response?.data?.detail
  if (!detail) return fallback
  if (typeof detail === 'string') return detail
  if (Array.isArray(detail) && detail.length > 0) {
    const first = detail[0]
    return first?.msg || first?.message || fallback
  }
  return fallback
}

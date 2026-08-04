// `new Date().toISOString()` converte para UTC antes de cortar a data. No
// Brasil (UTC-3), entre 21h e 23h59 isso já é "o dia seguinte" em UTC — um
// filtro de "hoje" feito com `.toISOString().slice(0, 10)` nesse intervalo
// aponta para amanhã. Use estas funções (getters locais, sem conversão de
// fuso) em qualquer lugar que precise da data de hoje no calendário local.
export function dataLocal(d: Date): string {
  const ano = d.getFullYear()
  const mes = String(d.getMonth() + 1).padStart(2, '0')
  const dia = String(d.getDate()).padStart(2, '0')
  return `${ano}-${mes}-${dia}`
}

export function hojeLocal(): string {
  return dataLocal(new Date())
}

/** Transfer price: venda para a Biomedical, empresa do mesmo grupo.
 *
 *  NÃO conta para meta nem para "Vendas" — é repasse dentro do grupo, não
 *  receita nova. O backend já aplica isso nos agregados (`_eh_biomedical` em
 *  api/pedidos.py, que exclui Transfer Price das metas, do faturamento e dos
 *  painéis). Esta função existe para as TELAS não afirmarem o contrário: o
 *  rodapé dos itens dizia "Conta para a meta: Uro R$ 4.000 (100%)" numa OV da
 *  Biomedical, que não conta para meta nenhuma.
 *
 *  Mesma regra do backend, de propósito: casa por nome do cliente. Se a
 *  identificação mudar lá (para um campo próprio, por exemplo), muda aqui também.
 */
export function ehTransferPrice(clienteNome?: string | null): boolean {
  return (clienteNome || '').toUpperCase().includes('BIOMEDICAL')
}

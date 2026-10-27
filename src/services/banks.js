// Reconhece o banco pelo nome da conta. Conexões feitas pelo Meu Pluggy chegam com o nome do
// serviço ("MeuPluggy"), mas a conta traz o banco de verdade (ex.: "Nu Pagamentos S.A.").
const BANKS = [
  [/nu pagamentos|nubank/i, 'Nubank'],
  [/banco inter|\binter\b/i, 'Inter'],
  [/ita[uú]/i, 'Itaú'],
  [/mercado ?pago/i, 'Mercado Pago'],
  [/santander/i, 'Santander'],
  [/picpay/i, 'PicPay'],
  [/banco do brasil|\bbb\b/i, 'Banco do Brasil'],
  [/bradesco/i, 'Bradesco'],
  [/\bc6\b/i, 'C6 Bank'],
  [/btg/i, 'BTG Pactual'],
  [/caixa/i, 'Caixa'],
  [/sicoob/i, 'Sicoob'],
  [/\bxp\b/i, 'XP'],
]

export function bankFrom(text) {
  const t = String(text ?? '')
  return BANKS.find(([re]) => re.test(t))?.[1] ?? null
}

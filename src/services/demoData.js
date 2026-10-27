// Parcelamentos fictícios, só para demonstrar a tela (nada é gravado)
const day = (offset) => new Date(Date.now() - offset * 86_400_000).toLocaleDateString('sv-SE')

const PURCHASES = [
  { name: 'iPhone 15 - Magazine Luiza', amount: 449.9, number: 4, total: 12, category: 'Shopping', ago: 5 },
  { name: 'Notebook - Kabum', amount: 312.5, number: 7, total: 10, category: 'Shopping', ago: 12 },
  { name: 'Passagem aérea - LATAM', amount: 215.0, number: 2, total: 6, category: 'Travel', ago: 9 },
  { name: 'Curso de inglês - Wizard', amount: 189.0, number: 3, total: 3, category: 'Education', ago: 20 },
  { name: 'Tênis - Nike', amount: 129.9, number: 5, total: 5, category: 'Shopping', ago: 30 },
]

export function demoInstallments() {
  return PURCHASES.map((p) => ({
    institution: 'Pluggy Bank',
    accountType: 'CREDIT',
    date: day(p.ago),
    description: p.name,
    amount: -p.amount,
    type: 'DEBIT',
    category: p.category,
    categoryPt: null,
    installment: { number: p.number, total: p.total },
  }))
}

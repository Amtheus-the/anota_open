import { Router } from 'express'
import { requireAuth, requireAccess } from '../middleware/auth.js'
import { loadFinancials } from '../services/financial.js'
import { buildCategories, buildCards } from '../services/visionCategories.js'
import { demoInstallments } from '../services/demoData.js'
import { buildVision, buildTransactions, buildInstallments, buildSubscriptions } from '../services/vision.js'

const router = Router()
router.use(requireAuth, requireAccess)

// Tudo que a tela Vision mostra, numa chamada só
router.get('/overview', async (req, res) => {
  const financials = await loadFinancials(req.userId)
  if (financials.accounts.length === 0) return res.json({ connected: false })
  res.json({ connected: true, ...buildVision(financials) })
})

// Aba Transações: filtros e paginação são aplicados aqui
router.get('/transactions', async (req, res) => {
  const financials = await loadFinancials(req.userId)
  if (financials.accounts.length === 0) return res.json({ connected: false })
  res.json({ connected: true, ...buildTransactions(financials, req.query) })
})

// Aba Parcelamentos
router.get('/installments', async (req, res) => {
  const financials = await loadFinancials(req.userId)
  if (financials.accounts.length === 0) return res.json({ connected: false })
  // ?demo=1 (só fora de produção): mistura parcelamentos de exemplo para ver a tela preenchida
  const data = req.query.demo === '1' && process.env.NODE_ENV !== 'production'
    ? { ...financials, transactions: [...financials.transactions, ...demoInstallments()] }
    : financials
  res.json({ connected: true, ...buildInstallments(data, req.query) })
})

// Aba Assinaturas
router.get('/subscriptions', async (req, res) => {
  const financials = await loadFinancials(req.userId)
  if (financials.accounts.length === 0) return res.json({ connected: false })
  res.json({ connected: true, ...buildSubscriptions(financials, req.query) })
})

// Aba Categorias
router.get('/categories', async (req, res) => {
  const financials = await loadFinancials(req.userId)
  if (financials.accounts.length === 0) return res.json({ connected: false })
  res.json({ connected: true, ...buildCategories(financials, req.query) })
})

// Aba Cartões
router.get('/cards', async (req, res) => {
  const financials = await loadFinancials(req.userId)
  if (financials.accounts.length === 0) return res.json({ connected: false })
  res.json({ connected: true, ...buildCards(financials, req.query) })
})

export default router

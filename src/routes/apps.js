import { Router } from 'express'
import rateLimit from 'express-rate-limit'
import { config } from '../config.js'
import { requireAuth, requireAccess } from '../middleware/auth.js'
import { HttpError } from '../utils/validators.js'
import { APPS, deleteCalendarEvent } from '../services/apps.js'
import { composioConfigured, listConnections, removeConnections, startConnection } from '../services/composio.js'

// Apps conectados do usuário (Gmail etc.). O login em si acontece na Composio e no app de origem, numa janela à parte.
const router = Router()
router.use(requireAuth)
router.use(requireAccess)
router.use(rateLimit({ windowMs: 15 * 60 * 1000, limit: 300, standardHeaders: true, legacyHeaders: false }))

const appBySlug = (slug) => APPS.find((app) => app.slug === slug)

router.get('/', async (req, res) => {
  const available = composioConfigured()
  const connected = available ? await listConnections(req.userId) : []
  res.json({
    available,
    apps: APPS.map(({ slug, name, text, ready }) => ({
      slug,
      name,
      text,
      status: connected.some((c) => c.app === slug) ? 'connected' : available && ready ? 'available' : 'soon',
    })),
  })
})

router.post('/:slug/connect', async (req, res) => {
  const app = appBySlug(req.params.slug)
  if (!app || !app.ready) throw new HttpError(404, 'Este app ainda não está disponível')
  if (!composioConfigured()) throw new HttpError(503, 'As conexões com apps ainda não estão ativadas')
  const redirectUrl = await startConnection(req.userId, app.slug, `${config.frontendUrl}/apps/callback`)
  res.json({ redirectUrl })
})

// Desfazer um evento criado pelo chat (botão "Desfazer" do cartão do evento)
router.delete('/googlecalendar/events/:eventId', async (req, res) => {
  if (!composioConfigured()) throw new HttpError(503, 'As conexões com apps ainda não estão ativadas')
  const result = await deleteCalendarEvent(req.userId, req.params.eventId, req.query.calendarId)
  if (result.needsConnection) throw new HttpError(409, 'O Google Calendar não está conectado')
  res.json({ ok: true })
})

router.delete('/:slug', async (req, res) => {
  const app = appBySlug(req.params.slug)
  if (!app) throw new HttpError(404, 'App não encontrado')
  if (!composioConfigured()) throw new HttpError(503, 'As conexões com apps ainda não estão ativadas')
  await removeConnections(req.userId, app.slug)
  res.json({ ok: true })
})

export default router

import express from 'express'
import cors from 'cors'
import helmet from 'helmet'
import rateLimit from 'express-rate-limit'
import { config, assertConfig } from './config.js'
import { pool } from './db.js'
import authRoutes from './routes/auth.js'
import chatRoutes from './routes/chat.js'
import openFinanceRoutes from './routes/openFinance.js'
import visionRoutes from './routes/vision.js'
import logoRoutes from './routes/logo.js'
import agentsRoutes from './routes/agents.js'
import statusPage from './routes/status.js'
import { startAgentRunner } from './services/agentRunner.js'

assertConfig()

const app = express()
app.disable('x-powered-by')
// atrás do proxy da hospedagem o IP real vem em X-Forwarded-For; sem isso o rate limit enxerga um IP só
// (não depende de NODE_ENV: se o painel da hospedagem esquecer a variável, o limite continua certo; TRUST_PROXY=0 desliga)
app.set('trust proxy', Number(process.env.TRUST_PROXY ?? 1))
app.use(helmet())
app.use(cors({ origin: config.frontendUrl }))
app.use(express.json({ limit: '100kb' }))

app.get('/api/health', async (_req, res) => {
  let database = 'ok'
  try {
    await pool.query('SELECT 1')
  } catch {
    database = 'indisponível'
  }
  res.json({
    status: 'ok',
    database,
    openai: Boolean(config.openai.apiKey),
    openFinance: Boolean(config.openFinance.clientId && config.openFinance.clientSecret),
  })
})

// Página de status (servidor, banco e variáveis): útil para achar erro de deploy. Só mostra sim/não e o código do erro.
const statusLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false })
app.get(['/', '/status'], statusLimiter, statusPage)

// Limite de tentativas nas rotas de login/cadastro (força bruta e abuso de envio de código)
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false })
// a checagem de sessão (/me) roda a cada carregamento de página: não conta no limite de login
app.use('/api/auth', (req, res, next) => (req.method === 'GET' && req.path === '/me' ? next() : authLimiter(req, res, next)), authRoutes)
// cada mensagem pode gerar até 3 chamadas à OpenAI: limita o ritmo por IP para conter o custo
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Muitas mensagens em pouco tempo. Aguarde um instante' },
})
app.use('/api/chat/messages', (req, res, next) => (req.method === 'POST' ? chatLimiter(req, res, next) : next()))
app.use('/api/chat', chatRoutes)
app.use('/api/open-finance', openFinanceRoutes)
app.use('/api/vision', visionRoutes)
app.use('/api/logo', logoRoutes)
app.use('/api/agents', agentsRoutes)

app.use((_req, res) => res.status(404).json({ error: 'Rota não encontrada' }))

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  if (err.status) return res.status(err.status).json({ error: err.message })
  if (err.code === 'ECONNREFUSED' || err.code === 'ER_ACCESS_DENIED_ERROR' || err.code === 'ER_BAD_DB_ERROR') {
    console.error('[db]', err.code, err.message)
    return res.status(503).json({ error: 'Banco de dados indisponível' })
  }
  console.error(err)
  res.status(500).json({ error: 'Erro interno' })
})

app.listen(config.port, (err) => {
  if (err) {
    console.error('[servidor] não consegui abrir a porta', config.port, err.code ?? '', err.message)
    process.exit(1)
  }
  console.log(`Anota Grana API na porta ${config.port} (${config.isProd ? 'produção' : 'desenvolvimento'}, PORT=${process.env.PORT ?? 'não definida'})`)
})
// ajuda a descobrir, nos logs da hospedagem, se e por que o processo está sendo encerrado
process.on('exit', (code) => console.log(`[servidor] processo encerrando (código ${code})`))
process.on('SIGTERM', () => {
  console.log('[servidor] recebeu SIGTERM da hospedagem')
  process.exit(0)
})
startAgentRunner()

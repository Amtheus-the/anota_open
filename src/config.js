import 'dotenv/config'

const env = process.env

export const config = {
  // a Hostinger entrega a porta em PORT e, segundo a documentação dela, o padrão esperado é 3000; localmente o .env define 3001
  port: Number(env.PORT ?? 3000),
  frontendUrl: env.FRONTEND_URL ?? 'http://localhost:5173',
  isProd: env.NODE_ENV === 'production',
  db: {
    host: env.DB_HOST ?? 'localhost',
    port: Number(env.DB_PORT ?? 3306),
    user: env.DB_USER ?? 'root',
    password: env.DB_PASSWORD ?? '',
    database: env.DB_NAME ?? 'pierre',
  },
  jwt: {
    secret: env.JWT_SECRET,
    expiresIn: env.JWT_EXPIRES_IN ?? '7d',
  },
  openai: {
    apiKey: env.OPENAI_API_KEY,
    model: env.OPENAI_MODEL ?? 'gpt-4o-mini',
  },
  whatsapp: {
    baseUrl: env.WHATSAPP_API_URL || 'https://api.w-api.app',
    instanceId: env.WHATSAPP_INSTANCE_ID,
    token: env.WHATSAPP_TOKEN,
    // segredo que vai na URL do webhook de mensagens recebidas (a W-API não assina as chamadas); sem ele o webhook fica desligado
    webhookSecret: env.WHATSAPP_WEBHOOK_SECRET,
  },
  openFinance: {
    baseUrl: env.OPEN_FINANCE_BASE_URL || 'https://api.pluggy.ai',
    clientId: env.OPEN_FINANCE_CLIENT_ID,
    clientSecret: env.OPEN_FINANCE_CLIENT_SECRET,
  },
}

export function assertConfig() {
  if (!config.jwt.secret || config.jwt.secret.length < 16) {
    throw new Error('JWT_SECRET ausente ou curto demais (use ao menos 16 caracteres) no arquivo .env')
  }
}

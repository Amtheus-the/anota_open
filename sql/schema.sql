CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  cpf           CHAR(11)     NOT NULL UNIQUE,
  phone         VARCHAR(15)  NOT NULL UNIQUE,
  email         VARCHAR(255) NOT NULL UNIQUE,
  name          VARCHAR(255) NULL,
  birth_date    DATE         NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  plan          VARCHAR(20)  NOT NULL DEFAULT 'free',
  plan_expires_at DATE       NULL,
  terms_accepted_at DATETIME NULL,
  terms_version VARCHAR(20)  NULL,
  whatsapp_optout_at DATETIME NULL,
  created_at    TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Pagamentos dos planos (registrados à mão no painel /admin até existir cobrança automática)
CREATE TABLE IF NOT EXISTS payments (
  id      INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NULL,
  plan    VARCHAR(20)  NOT NULL,
  months  TINYINT UNSIGNED NOT NULL DEFAULT 1,
  amount  DECIMAL(10,2) NOT NULL,
  method  VARCHAR(20)  NOT NULL DEFAULT 'pix',
  status  ENUM('paid','refunded') NOT NULL DEFAULT 'paid',
  note    VARCHAR(255) NULL,
  external_id VARCHAR(60) NULL,
  paid_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_external (external_id),
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  INDEX idx_paid_at (paid_at),
  INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Códigos de verificação enviados por WhatsApp/SMS (guardados só como hash)
CREATE TABLE IF NOT EXISTS verification_codes (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  phone      VARCHAR(15) NOT NULL,
  code_hash  VARCHAR(255) NOT NULL,
  attempts   TINYINT UNSIGNED NOT NULL DEFAULT 0,
  expires_at DATETIME NOT NULL,
  used_at    DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_phone (phone)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Conexões bancárias (Items da Pluggy) via Open Finance
CREATE TABLE IF NOT EXISTS connected_accounts (
  id                INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id           INT UNSIGNED NOT NULL,
  institution       VARCHAR(120) NOT NULL,
  provider_item_id  VARCHAR(120) NULL,
  status            ENUM('pending','connected','error','revoked') NOT NULL DEFAULT 'pending',
  created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_user_item (user_id, provider_item_id),
  INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Conversas do chat (a lista "Recentes" do menu)
CREATE TABLE IF NOT EXISTS conversations (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    INT UNSIGNED NOT NULL,
  title      VARCHAR(120) NOT NULL DEFAULT 'Nova conversa',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_user_updated (user_id, updated_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Mensagens de cada conversa
-- (bancos criados antes das conversas recebem a coluna conversation_id pela migração do db:init)
CREATE TABLE IF NOT EXISTS chat_messages (
  id              INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id         INT UNSIGNED NOT NULL,
  conversation_id INT UNSIGNED NULL,
  role            ENUM('user','assistant') NOT NULL,
  content         TEXT NOT NULL,
  widgets         MEDIUMTEXT NULL,
  steps           INT UNSIGNED NOT NULL DEFAULT 0,
  created_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
  INDEX idx_user_created (user_id, created_at),
  INDEX idx_conversation (conversation_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Agentes do usuário (criados pelo chat ou pela tela de agentes)
-- agent_key é o agente do catálogo (faro, prisma, teto, faisca, juizo); NULL nos criados à mão
CREATE TABLE IF NOT EXISTS user_agents (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id    INT UNSIGNED NOT NULL,
  agent_key  VARCHAR(20) NULL,
  name       VARCHAR(60) NOT NULL,
  text       VARCHAR(255) NOT NULL,
  frequency  VARCHAR(60) NOT NULL DEFAULT 'Todo dia às 9h',
  spend_limit DECIMAL(12,2) NULL,
  active     TINYINT(1) NOT NULL DEFAULT 1,
  last_run_date DATE NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  UNIQUE KEY uq_user_agent (user_id, name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Mensagens recebidas pelo WhatsApp já processadas (a W-API pode reenviar o mesmo aviso)
CREATE TABLE IF NOT EXISTS whatsapp_inbound (
  id         INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  message_id VARCHAR(100) NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE KEY uq_message (message_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Avisos já enviados pelos agentes (a chave identifica o fato, para não avisar duas vezes)
CREATE TABLE IF NOT EXISTS agent_alerts (
  id            INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_agent_id INT UNSIGNED NOT NULL,
  dedupe_key    VARCHAR(255) NOT NULL,
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_agent_id) REFERENCES user_agents(id) ON DELETE CASCADE,
  UNIQUE KEY uq_agent_alert (user_agent_id, dedupe_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Assinaturas por Pix Automático (Asaas): uma autorização por tentativa de assinar
CREATE TABLE IF NOT EXISTS subscriptions (
  id                      INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id                 INT UNSIGNED NULL,
  plan                    VARCHAR(20)  NOT NULL DEFAULT 'pro',
  value                   DECIMAL(10,2) NOT NULL,
  asaas_customer_id       VARCHAR(60)  NOT NULL,
  asaas_authorization_id  VARCHAR(60)  NOT NULL,
  status                  ENUM('pending','active','cancelled','refused','expired') NOT NULL DEFAULT 'pending',
  created_at              TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  activated_at            DATETIME     NULL,
  cancelled_at            DATETIME     NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  UNIQUE KEY uq_authorization (asaas_authorization_id),
  INDEX idx_user (user_id),
  INDEX idx_customer (asaas_customer_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

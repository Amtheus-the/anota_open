-- Rode UMA vez no phpMyAdmin (aba SQL) do banco da Hostinger, antes de usar o painel /admin.
ALTER TABLE users
  ADD COLUMN plan VARCHAR(20) NOT NULL DEFAULT 'free' AFTER password_hash,
  ADD COLUMN plan_expires_at DATE NULL AFTER plan;

CREATE TABLE IF NOT EXISTS payments (
  id      INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  user_id INT UNSIGNED NOT NULL,
  plan    VARCHAR(20)  NOT NULL,
  months  TINYINT UNSIGNED NOT NULL DEFAULT 1,
  amount  DECIMAL(10,2) NOT NULL,
  method  VARCHAR(20)  NOT NULL DEFAULT 'pix',
  status  ENUM('paid','refunded') NOT NULL DEFAULT 'paid',
  note    VARCHAR(255) NULL,
  paid_at TIMESTAMP    NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  INDEX idx_paid_at (paid_at),
  INDEX idx_user (user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

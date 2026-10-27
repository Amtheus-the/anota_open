import mysql from 'mysql2/promise'
import { config } from './config.js'

// O pool é criado sem conectar: o servidor sobe mesmo com o MySQL desligado
// e cada rota que usa o banco responde com erro claro.
export const pool = mysql.createPool({
  ...config.db,
  waitForConnections: true,
  connectionLimit: 10,
  charset: 'utf8mb4',
  dateStrings: true,
})

export async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params)
  return rows
}

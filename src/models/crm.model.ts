import { db } from '../config/db.js';

export interface Cliente {
  telefone: string;
  nome: string | null;
  nif: string | null;
  morada: string | null;
  email: string | null;
  estado_registo: string;
  primeiro_contacto: Date;
  ultimo_contacto: Date;
  registado_em: Date | null;
  total_contactos: number;
  activo: boolean;
}

export interface CRMStats {
  total_clientes: number;
  registados: number;
  activos_30dias: number;
  novos_semana: number;
  com_nif: number;
  com_morada: number;
}

/**
 * Retrieves a client by phone number and updates their last contact date & total contact count.
 */
export async function obterEActualizarCliente(telefone: string): Promise<Cliente | null> {
  const { rows } = await db.query(
    `SELECT * FROM clientes WHERE telefone = $1`,
    [telefone]
  );
  if (!rows.length) return null;

  // Update last contact timestamp and increment total contacts count
  await db.query(
    `UPDATE clientes
     SET ultimo_contacto = NOW(),
         total_contactos = total_contactos + 1
     WHERE telefone = $1`,
    [telefone]
  );

  return rows[0];
}

/**
 * Retrieves a client by phone number without updating metadata.
 */
export async function obterClientePorTelefone(telefone: string): Promise<Cliente | null> {
  const { rows } = await db.query(
    `SELECT * FROM clientes WHERE telefone = $1`,
    [telefone]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Creates a pre-registration entry for a new client.
 */
export async function criarPreRegistoCliente(telefone: string, estadoRegisto: string): Promise<void> {
  await db.query(
    `INSERT INTO clientes (telefone, estado_registo, primeiro_contacto, ultimo_contacto)
     VALUES ($1, $2, NOW(), NOW())
     ON CONFLICT (telefone) DO NOTHING`,
    [telefone, estadoRegisto]
  );
}

/**
 * Updates columns for a client record.
 */
export async function actualizarCliente(telefone: string, campos: Partial<Cliente>): Promise<void> {
  const chaves = Object.keys(campos);
  if (!chaves.length) return;

  const setClauses = chaves.map((chave, index) => `"${chave}" = $${index + 2}`).join(', ');
  const valores = chaves.map((chave) => (campos as any)[chave]);

  await db.query(
    `UPDATE clientes SET ${setClauses} WHERE telefone = $1`,
    [telefone, ...valores]
  );
}

/**
 * Retrieves clients based on segment rules.
 */
export async function obterClientesPorSegmento(segmento: string, limite: number): Promise<{ telefone: string; nome: string | null }[]> {
  const queries: { [key: string]: { sql: string; hasParams: boolean } } = {
    todos: {
      sql: `SELECT telefone, nome FROM clientes WHERE estado_registo = 'completo' AND activo = true ORDER BY ultimo_contacto DESC LIMIT $1`,
      hasParams: true
    },
    inativos_30dias: {
      sql: `SELECT telefone, nome FROM clientes WHERE estado_registo = 'completo' AND activo = true AND ultimo_contacto < NOW() - INTERVAL '30 days' LIMIT $1`,
      hasParams: true
    },
    diesel: {
      sql: `SELECT DISTINCT c.telefone, c.nome FROM clientes c JOIN sessoes_viatura sv ON sv.telefone = c.telefone WHERE c.estado_registo = 'completo' AND sv.combustivel ILIKE '%diesel%' LIMIT $1`,
      hasParams: true
    },
    luanda: {
      sql: `SELECT telefone, nome FROM clientes WHERE estado_registo = 'completo' AND activo = true AND morada ILIKE '%luanda%' LIMIT $1`,
      hasParams: true
    },
    frequentes: {
      sql: `SELECT c.telefone, c.nome, COUNT(p.id) AS total_pedidos FROM clientes c JOIN pedidos p ON p.telefone_cliente = c.telefone WHERE c.estado_registo = 'completo' GROUP BY c.telefone, c.nome HAVING COUNT(p.id) >= 3 ORDER BY total_pedidos DESC LIMIT $1`,
      hasParams: true
    },
    sem_pedidos: {
      sql: `SELECT c.telefone, c.nome FROM clientes c WHERE c.estado_registo = 'completo' AND c.activo = true AND NOT EXISTS (SELECT 1 FROM pedidos p WHERE p.telefone_cliente = c.telefone) LIMIT $1`,
      hasParams: true
    },
    toyota: {
      sql: `SELECT DISTINCT c.telefone, c.nome FROM clientes c JOIN sessoes_viatura sv ON sv.telefone = c.telefone WHERE c.estado_registo = 'completo' AND sv.marca ILIKE '%toyota%' LIMIT $1`,
      hasParams: true
    },
    novos_7dias: {
      sql: `SELECT telefone, nome FROM clientes WHERE estado_registo = 'completo' AND registado_em > NOW() - INTERVAL '7 days' LIMIT $1`,
      hasParams: true
    }
  };

  const queryObj = queries[segmento] || queries.todos;
  const { rows } = await db.query(queryObj.sql, [limite]);
  return rows;
}

/**
 * Registers an outbound campaign message send record.
 */
export async function registarCampanhaEnviada(telefone: string, segmento: string): Promise<void> {
  await db.query(
    `INSERT INTO campanhas_enviadas (telefone, segmento, enviado_em)
     VALUES ($1, $2, NOW())`,
    [telefone, segmento]
  );
}

/**
 * Aggregates analytical statistics for CRM dashboard.
 */
export async function obterEstatisticasCRM(): Promise<CRMStats> {
  const { rows } = await db.query(`
    SELECT
      COUNT(*)::int                                               AS total_clientes,
      COUNT(*) FILTER (WHERE estado_registo = 'completo')::int    AS registados,
      COUNT(*) FILTER (
        WHERE ultimo_contacto > NOW() - INTERVAL '30 days'
      )::int                                                      AS activos_30dias,
      COUNT(*) FILTER (
        WHERE registado_em > NOW() - INTERVAL '7 days'
      )::int                                                      AS novos_semana,
      COUNT(*) FILTER (WHERE nif IS NOT NULL)::int                AS com_nif,
      COUNT(*) FILTER (WHERE morada IS NOT NULL)::int             AS com_morada
    FROM clientes
  `);
  return rows[0];
}

import { db } from '../config/db.js';

export interface PecaItem {
  id?: number;
  nome: string;
  referencia: string;
  preco: number;
  quantidade: number;
  prazo_entrega: string;
  fornecedor?: string;
  fornecedor_id?: number;
  avaliacao_fornecedor?: number;
}

export interface ViaturaSessao {
  telefone: string;
  vin: string | null;
  marca: string;
  modelo: string;
  ano: string;
  numero_motor: string | null;
  matricula: string | null;
  cilindrada: string | null;
  combustivel: string | null;
  actualizado_em: Date;
}

export interface ViaturaRecolha {
  telefone: string;
  estado: string;
  vin_tentado: string | null;
  marca: string | null;
  modelo: string | null;
  ano: string | null;
  numero_motor: string | null;
  criado_em: Date;
}

export interface PedidoAdminInfo {
  numero: string;
  cliente: string;
  peca: string;
  referencia: string;
  fornecedor: string;
  preco: number;
  criado_em: Date;
  hora: string;
  tem_comprovativo: boolean;
  metodo_pagamento?: string;
  requer_comprovativo?: boolean;
}

/**
 * Searches the unified inventory for compatible parts.
 * Limits result to top 5 cheapest parts.
 */
export async function buscarPecasNoInventario({
  peca,
  marca_veiculo,
  modelo,
  ano,
}: {
  peca: string;
  marca_veiculo?: string | null;
  modelo?: string | null;
  ano?: string | null;
}): Promise<PecaItem[]> {
  const { rows } = await db.query(
    `
    SELECT
      p.id,
      p.nome,
      p.referencia,
      p.preco,
      p.quantidade,
      p.prazo_entrega,
      f.nome AS fornecedor,
      f.avaliacao AS avaliacao_fornecedor
    FROM pecas p
    JOIN fornecedores f ON f.id = p.fornecedor_id
    JOIN compatibilidades c ON c.peca_id = p.id
    JOIN veiculos v ON v.id = c.veiculo_id
    WHERE
      p.quantidade > 0
      AND p.activo = true
      AND to_tsvector('portuguese', p.nome || ' ' || p.categoria || ' ' || COALESCE(p.sinonimos, ''))
          @@ plainto_tsquery('portuguese', $1)
      AND (
        v.marca ILIKE $2 OR $2 IS NULL
      )
      AND (
        v.modelo ILIKE $3 OR $3 IS NULL
      )
      AND (
        v.ano_inicio <= $4::int AND v.ano_fim >= $4::int
        OR $4 IS NULL
      )
    ORDER BY
      p.preco ASC,
      f.avaliacao DESC
    LIMIT 5
    `,
    [peca, marca_veiculo || null, modelo || null, ano ? parseInt(ano, 10) : null]
  );
  return rows;
}

/**
 * Registers a waitlist entry when a part is out of stock.
 */
export async function registarPedidoPendente({
  telefone,
  peca,
  marca_veiculo,
  modelo,
  ano,
  numeroMotor
}: {
  telefone: string;
  peca: string;
  marca_veiculo?: string | null;
  modelo?: string | null;
  ano?: string | null;
  numeroMotor?: string | null;
}): Promise<void> {
  await db.query(
    `INSERT INTO pedidos_pendentes (telefone, peca, marca_veiculo, modelo, ano, numero_motor, criado_em)
     VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
    [telefone, peca, marca_veiculo || null, modelo || null, ano || null, numeroMotor || null]
  );
}

/**
 * Retrieves the client's active vehicle session (expires after 4 hours).
 */
export async function obterViaturaCliente(telefone: string): Promise<ViaturaSessao | null> {
  const { rows } = await db.query(
    `SELECT * FROM sessoes_viatura
     WHERE telefone = $1
       AND actualizado_em > NOW() - INTERVAL '4 hours'`,
    [telefone]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Saves/updates a vehicle session for a client.
 */
export async function salvarSessaoViatura(
  telefone: string,
  dados: Partial<ViaturaSessao>
): Promise<void> {
  await db.query(
    `INSERT INTO sessoes_viatura
       (telefone, vin, marca, modelo, ano, numero_motor, matricula, cilindrada, combustivel, actualizado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
     ON CONFLICT (telefone)
     DO UPDATE SET
       vin = COALESCE($2, sessoes_viatura.vin),
       marca = COALESCE($3, sessoes_viatura.marca),
       modelo = COALESCE($4, sessoes_viatura.modelo),
       ano = COALESCE($5, sessoes_viatura.ano),
       numero_motor = COALESCE($6, sessoes_viatura.numero_motor),
       matricula = COALESCE($7, sessoes_viatura.matricula),
       cilindrada = COALESCE($8, sessoes_viatura.cilindrada),
       combustivel = COALESCE($9, sessoes_viatura.combustivel),
       actualizado_em = NOW()`,
    [
      telefone,
      dados.vin || null,
      dados.marca || null,
      dados.modelo || null,
      dados.ano || null,
      dados.numero_motor || null,
      dados.matricula || null,
      dados.cilindrada || null,
      dados.combustivel || null,
    ]
  );
}

/**
 * Deletes vehicle session.
 */
export async function limparSessaoViatura(telefone: string): Promise<void> {
  await db.query("DELETE FROM sessoes_viatura WHERE telefone = $1", [telefone]);
}

/**
 * Saves a decoded VIN response in cache.
 */
export async function salvarVinCache(
  vin: string,
  dados: {
    marca: string;
    modelo: string;
    ano: string;
    tipo?: string | null;
    motorizacao?: string | null;
    combustivel?: string | null;
    pais_fabrico?: string | null;
  }
): Promise<void> {
  await db.query(
    `INSERT INTO vin_cache (vin, marca, modelo, ano, tipo, motorizacao, combustivel, pais_fabrico)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (vin) DO NOTHING`,
    [
      vin.toUpperCase(),
      dados.marca,
      dados.modelo,
      dados.ano,
      dados.tipo || null,
      dados.motorizacao || null,
      dados.combustivel || null,
      dados.pais_fabrico || null,
    ]
  );
}

/**
 * Fetches cached VIN response.
 */
export async function obterVinCache(vin: string): Promise<any | null> {
  const { rows } = await db.query(
    "SELECT * FROM vin_cache WHERE vin = $1",
    [vin.toUpperCase()]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Begins a manual vehicle details collection process.
 */
export async function iniciarRecolhaManual(telefone: string, estado: string, vinTentado: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO recolha_viatura (telefone, estado, vin_tentado, criado_em)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (telefone)
     DO UPDATE SET estado = $2, vin_tentado = $3, marca = NULL,
                   modelo = NULL, ano = NULL, numero_motor = NULL,
                   criado_em = NOW()`,
    [telefone, estado, vinTentado]
  );
}

/**
 * Returns ongoing manual details collection process state.
 */
export async function obterRecolhaManualActiva(telefone: string): Promise<ViaturaRecolha | null> {
  const { rows } = await db.query(
    `SELECT * FROM recolha_viatura
     WHERE telefone = $1
       AND estado != 'completo'
       AND criado_em > NOW() - INTERVAL '30 minutes'`,
    [telefone]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Updates manual collection state values.
 */
export async function actualizarRecolhaManual(telefone: string, campos: Partial<ViaturaRecolha>): Promise<void> {
  const chaves = Object.keys(campos);
  if (!chaves.length) return;

  const setClauses = chaves.map((chave, index) => `"${chave}" = $${index + 2}`).join(', ');
  const valores = chaves.map((chave) => (campos as any)[chave]);

  await db.query(
    `UPDATE recolha_viatura SET ${setClauses} WHERE telefone = $1`,
    [telefone, ...valores]
  );
}

/**
 * Inserts a new order into the orders log.
 */
export async function criarPedido(
  numeroPedido: string,
  telefone: string,
  item: PecaItem
): Promise<void> {
  await db.query(
    `INSERT INTO pedidos (numero, telefone_cliente, peca_id, fornecedor_id, quantidade, preco_unitario, estado, criado_em)
     VALUES ($1, $2, $3, $4, 1, $5, 'aguarda_pagamento', NOW())`,
    [numeroPedido, telefone, item.id, item.fornecedor_id, item.preco]
  );
}

/**
 * Fetches last pending order waiting for billing selection or verification.
 */
export async function obterUltimoPedidoPorEstado(telefone: string, estados: string[]): Promise<any | null> {
  const { rows } = await db.query(
    `SELECT * FROM pedidos
     WHERE telefone_cliente = $1
       AND estado = ANY($2::text[])
     ORDER BY criado_em DESC LIMIT 1`,
    [telefone, estados]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Updates state of a given order.
 */
export async function actualizarEstadoPedido(numeroPedido: string, estado: string, camposAdicionais: any = {}): Promise<void> {
  const setClauses = [`estado = $2`, `actualizado_em = NOW()`];
  const params: any[] = [numeroPedido, estado];

  if (camposAdicionais.aprovado_por) {
    setClauses.push(`aprovado_por = $${setClauses.length + 2}`);
    params.push(camposAdicionais.aprovado_por);
    setClauses.push(`aprovado_em = NOW()`);
  }

  if (camposAdicionais.metodo_pagamento) {
    setClauses.push(`metodo_pagamento = $${setClauses.length + 2}`);
    params.push(camposAdicionais.metodo_pagamento);
  }

  await db.query(
    `UPDATE pedidos SET ${setClauses.join(', ')} WHERE numero = $1`,
    params
  );
}

/**
 * Registers user payment proof metadata.
 */
export async function registarComprovativo(pedidoNumero: string, mediaId: string, tipoMedia: string | null = null): Promise<void> {
  await db.query(
    `INSERT INTO comprovativos (pedido_numero, media_id, tipo_media, criado_em)
     VALUES ($1, $2, $3, NOW())
     ON CONFLICT (pedido_numero) DO UPDATE SET media_id = $2, tipo_media = $3`,
    [pedidoNumero, mediaId, tipoMedia]
  );
}

/**
 * Increments and issues a unique order document serial (RP-YYYY-XXXXX).
 */
export async function gerarNumeroPedido(): Promise<string> {
  const ano = new Date().getFullYear();
  const resultado = await db.query(
    `INSERT INTO contadores_pedido (ano, ultimo_numero)
     VALUES ($1, 1)
     ON CONFLICT (ano)
     DO UPDATE SET ultimo_numero = contadores_pedido.ultimo_numero + 1
     RETURNING ultimo_numero`,
    [ano]
  );
  const numero = resultado.rows[0].ultimo_numero;
  return `RP-${ano}-${String(numero).padStart(5, "0")}`;
}

/**
 * Retrieves orders awaiting approval.
 */
export async function obterPedidosPendentesAprovacao(): Promise<PedidoAdminInfo[]> {
  const { rows } = await db.query(`
    SELECT
      p.numero, p.telefone_cliente AS cliente,
      p.preco_unitario AS preco, p.criado_em,
      pc.nome AS peca, pc.referencia,
      f.nome AS fornecedor,
      p.metodo_pagamento,
      to_char(p.criado_em, 'HH24:MI') AS hora,
      EXISTS (
        SELECT 1 FROM comprovativos c WHERE c.pedido_numero = p.numero
      ) AS tem_comprovativo,
      (p.metodo_pagamento = 'transferencia' OR p.metodo_pagamento = 'deposito' OR p.metodo_pagamento = 'multicaixa_express') AS requer_comprovativo
    FROM pedidos p
    JOIN pecas pc ON pc.id = p.peca_id
    JOIN fornecedores f ON f.id = p.fornecedor_id
    WHERE p.estado IN ('aguarda_pagamento', 'comprovativo_recebido', 'aguarda_comprovativo', 'aguarda_confirmacao_agente')
    ORDER BY p.criado_em DESC
  `);
  return rows;
}

/**
 * Retrieves orders approved on the current date.
 */
export async function obterPedidosAprovadosHoje(): Promise<any[]> {
  const { rows } = await db.query(`
    SELECT
      p.numero, p.telefone_cliente AS cliente,
      p.preco_unitario AS preco,
      pc.nome AS peca,
      to_char(p.aprovado_em, 'HH24:MI') AS hora
    FROM pedidos p
    JOIN pecas pc ON pc.id = p.peca_id
    WHERE p.estado = 'aprovado'
      AND p.aprovado_em::date = CURRENT_DATE
    ORDER BY p.aprovado_em DESC
  `);
  return rows;
}

/**
 * Details of a single order.
 */
export async function obterPedidoPorNumero(numero: string): Promise<any | null> {
  const { rows } = await db.query(
    `SELECT p.*, pc.nome as nome_peca, pc.referencia, f.nome as nome_fornecedor
     FROM pedidos p
     JOIN pecas pc ON pc.id = p.peca_id
     JOIN fornecedores f ON f.id = p.fornecedor_id
     WHERE p.numero = $1`,
    [numero]
  );
  return rows.length ? rows[0] : null;
}

/**
 * Core operation: Batch updates of parsed Excel shop items.
 * Performs clean upsert mapping to vendor_id and SKU reference.
 */
export async function importarPecasBatch(
  fornecedorId: number,
  artigos: { referencia: string; nome: string; preco: number; quantidade: number }[]
): Promise<{ inseridos: number; actualizados: number; desactivados: number }> {
  let inseridos = 0;
  let actualizados = 0;
  
  const client = await db.connect();
  try {
    await client.query("BEGIN");

    const referenciasRecebidas = new Set(artigos.map((a) => a.referencia));

    for (const artigo of artigos) {
      if (!artigo.referencia || !artigo.nome) continue;

      const result = await client.query(
        `INSERT INTO pecas (fornecedor_id, referencia, nome, preco, quantidade, activo, actualizado_em)
         VALUES ($1, $2, $3, $4, $5, true, NOW())
         ON CONFLICT (fornecedor_id, referencia)
         DO UPDATE SET
           nome = EXCLUDED.nome,
           preco = EXCLUDED.preco,
           quantidade = EXCLUDED.quantidade,
           activo = true,
           actualizado_em = NOW()
         RETURNING (xmax = 0) AS foi_inserido`,
        [fornecedorId, artigo.referencia, artigo.nome, artigo.preco, artigo.quantidade]
      );

      if (result.rows[0]?.foi_inserido) {
        inseridos++;
      } else {
        actualizados++;
      }
    }

    // Deactivate items from this supplier that are missing in the new document import
    const resultDesativados = await client.query(
      `UPDATE pecas
       SET activo = false, quantidade = 0, actualizado_em = NOW()
       WHERE fornecedor_id = $1
         AND activo = true
         AND referencia != ALL($2::text[])`,
      [fornecedorId, [...referenciasRecebidas]]
    );

    const desactivados = resultDesativados.rowCount || 0;

    await client.query("COMMIT");

    // Log the synchronization event
    await db.query(
      `INSERT INTO logs_sincronizacao (fornecedor_id, inseridos, actualizados, desactivados, criado_em)
       VALUES ($1, $2, $3, $4, NOW())`,
      [fornecedorId, inseridos, actualizados, desactivados]
    );

    return { inseridos, actualizados, desactivados };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

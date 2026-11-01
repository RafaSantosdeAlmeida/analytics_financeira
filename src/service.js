import { createHash } from 'node:crypto';
import { parseAndStageCsv, stageRow } from './ingestion.js';

const supportedTypes = new Set([
  'EMPRESAS',
  'SETOR_SUBSETOR_SEGMENTO',
  'PLANO_CONTA_EMPRESA',
  'PLANO_CONTA_SEGMENTO',
  'DFP_DRE',
]);

export function ingestCsv(database, file) {
  const parsed = parseAndStageCsv(file.buffer);
  if (!supportedTypes.has(parsed.type)) throw new Error('Tipo de CSV não suportado.');

  const hash = createHash('sha256').update(file.buffer).digest('hex');
  database.exec('BEGIN IMMEDIATE');

  try {
    const insertBatch = database.prepare(`
      INSERT INTO ingestion_lote (
        tipo_arquivo, nome_arquivo, hash_sha256, delimitador, encoding_arquivo,
        status_lote, qtd_linhas_arquivo, qtd_linhas_raw, qtd_linhas_staging,
        qtd_linhas_validas, qtd_linhas_invalidas
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0)
    `);
    const result = insertBatch.run(
      parsed.type,
      file.originalname,
      hash,
      parsed.delimiter,
      parsed.encoding,
      'RECEBIDO',
      parsed.records.length,
      parsed.records.length,
    );
    const batchId = Number(result.lastInsertRowid);
    const insertRaw = database.prepare(`
      INSERT INTO raw_linha (id_lote, numero_linha_origem, dados_json)
      VALUES (?, ?, ?)
    `);

    parsed.records.forEach((record, index) => {
      insertRaw.run(batchId, index + 2, JSON.stringify(record));
    });

    database.prepare('UPDATE ingestion_lote SET finalizado_em = CURRENT_TIMESTAMP WHERE id_lote = ?')
      .run(batchId);
    database.exec('COMMIT');
    return getBatch(database, batchId);
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }
}

export function stageBatch(database, batchId) {
  const batch = getBatch(database, batchId);
  if (!batch) throw new Error('Lote não encontrado.');
  if (batch.qtd_linhas_staging) return batch;

  const rawRows = database.prepare(`
    SELECT id_raw_linha, dados_json FROM raw_linha
    WHERE id_lote = ? ORDER BY numero_linha_origem
  `).all(batchId);
  if (!rawRows.length) throw new Error('O lote não contém linhas raw para processar.');

  database.exec('BEGIN IMMEDIATE');
  try {
    const insertStage = database.prepare(`
      INSERT INTO stg_linha (
        id_lote, id_raw_linha, dados_json, status_validacao, erro_validacao
      ) VALUES (?, ?, ?, ?, ?)
    `);
    let validCount = 0;
    let invalidCount = 0;

    for (const raw of rawRows) {
      const staged = stageRow(batch.tipo_arquivo, JSON.parse(raw.dados_json));
      insertStage.run(
        batchId,
        raw.id_raw_linha,
        JSON.stringify(staged.data),
        staged.status,
        staged.error,
      );
      if (staged.status === 'VALIDO') validCount += 1;
      else invalidCount += 1;
    }

    database.prepare(`
      UPDATE ingestion_lote SET
        status_lote = ?, qtd_linhas_staging = ?,
        qtd_linhas_validas = ?, qtd_linhas_invalidas = ?,
        finalizado_em = CURRENT_TIMESTAMP
      WHERE id_lote = ?
    `).run(
      invalidCount ? 'CONCLUIDO_COM_ERROS' : 'CONCLUIDO',
      rawRows.length,
      validCount,
      invalidCount,
      batchId,
    );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  return getBatch(database, batchId);
}

export function getBatch(database, batchId) {
  const batch = database.prepare('SELECT * FROM ingestion_lote WHERE id_lote = ?').get(batchId);
  if (!batch) return null;

  const counts = database.prepare(`
    SELECT status_validacao, COUNT(*) AS quantidade
    FROM stg_linha
    WHERE id_lote = ?
    GROUP BY status_validacao
  `).all(batchId);
  return {
    ...batch,
    contagem_status: Object.fromEntries(counts.map((row) => [row.status_validacao, row.quantidade])),
  };
}

export function listBatches(database) {
  return database.prepare(`
    SELECT b.*,
      (SELECT COUNT(*) FROM stg_linha s WHERE s.id_lote = b.id_lote AND s.status_validacao = 'VALIDO') AS validas,
      (SELECT COUNT(*) FROM stg_linha s WHERE s.id_lote = b.id_lote AND s.status_validacao = 'INVALIDO') AS invalidas,
      (SELECT COUNT(*) FROM stg_linha s WHERE s.id_lote = b.id_lote AND s.status_validacao = 'REVISAR') AS revisar
    FROM ingestion_lote b
    ORDER BY b.id_lote DESC
  `).all();
}

export function getBatchRows(database, batchId, layer, limit, offset) {
  if (!['raw', 'staging'].includes(layer)) throw new Error('Camada inválida.');
  const table = layer === 'raw' ? 'raw_linha' : 'stg_linha';
  const rows = layer === 'raw'
    ? database.prepare(`
        SELECT id_raw_linha AS id, numero_linha_origem, dados_json
        FROM ${table} WHERE id_lote = ? ORDER BY numero_linha_origem LIMIT ? OFFSET ?
      `).all(batchId, limit, offset)
    : database.prepare(`
        SELECT id_stg_linha AS id, id_raw_linha, dados_json, status_validacao, erro_validacao
        FROM ${table} WHERE id_lote = ? ORDER BY id_stg_linha LIMIT ? OFFSET ?
      `).all(batchId, limit, offset);

  return rows.map((row) => ({
    ...row,
    dados: JSON.parse(row.dados_json),
    dados_json: undefined,
  }));
}

function value(database, query, ...parameters) {
  const row = database.prepare(query).get(...parameters);
  return row ? Object.values(row)[0] : null;
}

function ensureSectorPath(database, row) {
  database.prepare('INSERT INTO setor (nome_setor) VALUES (?) ON CONFLICT DO NOTHING')
    .run(row.setor);
  const sectorId = value(database, 'SELECT id_setor FROM setor WHERE nome_setor = ?', row.setor);
  database.prepare(`
    INSERT INTO subsetor (id_setor, nome_subsetor) VALUES (?, ?)
    ON CONFLICT DO NOTHING
  `).run(sectorId, row.subsetor);
  const subsectorId = value(database, `
    SELECT id_subsetor FROM subsetor WHERE id_setor = ? AND nome_subsetor = ?
  `, sectorId, row.subsetor);
  database.prepare(`
    INSERT INTO segmento (id_subsetor, nome_segmento) VALUES (?, ?)
    ON CONFLICT DO NOTHING
  `).run(subsectorId, row.segmento);
  return value(database, `
    SELECT id_segmento FROM segmento WHERE id_subsetor = ? AND nome_segmento = ?
  `, subsectorId, row.segmento);
}

function requireRow(database, query, errorMessage, ...parameters) {
  const row = database.prepare(query).get(...parameters);
  if (!row) throw new Error(errorMessage);
  return row;
}

function persistCompany(database, row) {
  const segmentId = ensureSectorPath(database, row);
  database.prepare(`
    INSERT INTO empresas (
      cnpj_cia, denom_cia, codigo_negociacao, id_segmento
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(cnpj_cia) DO UPDATE SET
      denom_cia = excluded.denom_cia,
      codigo_negociacao = excluded.codigo_negociacao,
      id_segmento = excluded.id_segmento
  `).run(row.cnpj_cia, row.denom_cia, row.codigo_negociacao, segmentId);
}

function persistCompanyPlan(database, row) {
  const company = requireRow(
    database,
    'SELECT id_empresa FROM empresas WHERE cnpj_cia = ?',
    `Empresa ${row.cnpj_origem} não carregada; importe empresas.csv primeiro.`,
    row.cnpj_cia,
  );
  database.prepare(`
    INSERT INTO plano_conta_empresa (id_empresa, cd_conta, nivel_conta, ds_conta_empresa)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id_empresa, cd_conta) DO UPDATE SET
      nivel_conta = excluded.nivel_conta,
      ds_conta_empresa = excluded.ds_conta_empresa
  `).run(company.id_empresa, row.cd_conta, row.nivel_conta, row.ds_conta_empresa);
}

function persistSegmentPlan(database, row) {
  const segmentId = ensureSectorPath(database, row);
  database.prepare(`
    INSERT INTO plano_conta_segmento (
      id_segmento, cd_conta, nivel_conta, ds_conta_segmento
    ) VALUES (?, ?, ?, ?)
    ON CONFLICT(id_segmento, cd_conta) DO UPDATE SET
      nivel_conta = excluded.nivel_conta,
      ds_conta_segmento = excluded.ds_conta_segmento
  `).run(segmentId, row.cd_conta, row.nivel_conta, row.ds_conta_segmento);
}

function persistHierarchy(database, row) {
  ensureSectorPath(database, row);
}

function persistDre(database, row, batchId) {
  if (row.ordem_exerc !== 'ULTIMO') {
    throw new Error('Somente linhas com ordem_exerc ULTIMO podem ser persistidas.');
  }

  const company = requireRow(
    database,
    'SELECT id_empresa, id_segmento FROM empresas WHERE cnpj_cia = ?',
    `Empresa ${row.cnpj_cia_origem} não carregada ou sem classificação; importe empresas.csv primeiro.`,
    row.cnpj_cia,
  );
  const companyAccount = requireRow(
    database,
    `SELECT id_plano_conta_empresa FROM plano_conta_empresa
     WHERE id_empresa = ? AND cd_conta = ?`,
    `Conta empresarial ${row.cd_conta} não carregada para ${row.cnpj_cia_origem}.`,
    company.id_empresa,
    row.cd_conta,
  );
  const segmentAccount = database.prepare(`
    SELECT id_plano_conta_segmento FROM plano_conta_segmento
    WHERE id_segmento = ? AND cd_conta = ?
  `).get(company.id_segmento, row.cd_conta);
  const period = database.prepare(`
    INSERT INTO periodos (
      periodo, tipo_periodo, dt_ini_exerc, dt_fim_exerc, ano_exerc
    ) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(periodo, tipo_periodo) DO NOTHING
  `).run(row.periodo, row.tipo_periodo, row.dt_ini_exerc, row.dt_fim_exerc,
    Number(row.dt_fim_exerc.slice(0, 4)));
  const periodRow = requireRow(
    database,
    `SELECT id_periodo, dt_ini_exerc, dt_fim_exerc FROM periodos
     WHERE periodo = ? AND tipo_periodo = ?`,
    'Período não foi encontrado após a carga.',
    row.periodo,
    row.tipo_periodo,
  );

  if (periodRow.dt_ini_exerc !== row.dt_ini_exerc || periodRow.dt_fim_exerc !== row.dt_fim_exerc) {
    throw new Error(`O período ${row.periodo} já existe com outro intervalo de datas.`);
  }

  database.prepare('UPDATE empresas SET denom_cia = ?, cd_cvm = ? WHERE id_empresa = ?')
    .run(row.denom_cia, row.cd_cvm, company.id_empresa);
  database.prepare(`
    INSERT INTO demonstracao_financeira (
      id_empresa, id_periodo, id_plano_conta_empresa, id_plano_conta_segmento,
      grupo_dfp, dt_refer, versao, ordem_exerc, st_conta_fixa, moeda,
      escala_moeda, vl_conta, id_lote_origem
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id_empresa, id_periodo, id_plano_conta_empresa, grupo_dfp)
    DO UPDATE SET
      id_plano_conta_segmento = excluded.id_plano_conta_segmento,
      dt_refer = excluded.dt_refer,
      versao = excluded.versao,
      ordem_exerc = excluded.ordem_exerc,
      st_conta_fixa = excluded.st_conta_fixa,
      moeda = excluded.moeda,
      escala_moeda = excluded.escala_moeda,
      vl_conta = excluded.vl_conta,
      id_lote_origem = excluded.id_lote_origem
    WHERE excluded.dt_refer > demonstracao_financeira.dt_refer
      OR (excluded.dt_refer = demonstracao_financeira.dt_refer
        AND excluded.versao >= demonstracao_financeira.versao)
  `).run(
    company.id_empresa,
    periodRow.id_periodo,
    companyAccount.id_plano_conta_empresa,
    segmentAccount?.id_plano_conta_segmento ?? null,
    row.grupo_dfp,
    row.dt_refer,
    row.versao,
    row.ordem_exerc,
    row.st_conta_fixa,
    row.moeda,
    row.escala_moeda,
    row.vl_conta,
    batchId,
  );
}

function persistRow(database, type, row, batchId) {
  switch (type) {
    case 'EMPRESAS':
      persistCompany(database, row);
      return;
    case 'SETOR_SUBSETOR_SEGMENTO':
      persistHierarchy(database, row);
      return;
    case 'PLANO_CONTA_EMPRESA':
      persistCompanyPlan(database, row);
      return;
    case 'PLANO_CONTA_SEGMENTO':
      persistSegmentPlan(database, row);
      return;
    case 'DFP_DRE':
      persistDre(database, row, batchId);
      return;
    default:
      throw new Error(`Tipo de arquivo não suportado: ${type}`);
  }
}

export function persistBatch(database, batchId) {
  const batch = getBatch(database, batchId);
  if (!batch) throw new Error('Lote não encontrado.');
  if (!batch.qtd_linhas_staging) throw new Error('Envie o lote para staging antes de persistir.');
  if (!batch.qtd_linhas_staging) throw new Error('Envie o lote para staging antes de persistir.');
  const rows = database.prepare(`
    SELECT id_stg_linha, dados_json, status_validacao
    FROM stg_linha
    WHERE id_lote = ? AND status_validacao IN ('VALIDO', 'REVISAR')
    ORDER BY id_stg_linha
  `).all(batchId);
  const updateStage = database.prepare(`
    UPDATE stg_linha SET status_validacao = ?, erro_validacao = ?,
      processado_em = CURRENT_TIMESTAMP WHERE id_stg_linha = ?
  `);
  let persisted = 0;
  let needsReview = 0;

  database.exec('BEGIN IMMEDIATE');
  try {
    for (const row of rows) {
      const savepoint = `linha_${row.id_stg_linha}`;
      database.exec(`SAVEPOINT ${savepoint}`);
      try {
        persistRow(database, batch.tipo_arquivo, JSON.parse(row.dados_json), batchId);
        database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        updateStage.run('VALIDO', null, row.id_stg_linha);
        persisted += 1;
      } catch (error) {
        database.exec(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        database.exec(`RELEASE SAVEPOINT ${savepoint}`);
        updateStage.run('REVISAR', error.message, row.id_stg_linha);
        needsReview += 1;
      }
    }

    const invalidCount = value(database,
      "SELECT COUNT(*) FROM stg_linha WHERE id_lote = ? AND status_validacao = 'INVALIDO'",
      batchId);
    database.prepare(`
      UPDATE ingestion_lote SET
        status_lote = ?,
        qtd_linhas_validas = ?,
        qtd_linhas_invalidas = ?,
        persistido_em = CURRENT_TIMESTAMP,
        mensagem_erro = ?
      WHERE id_lote = ?
    `).run(
      invalidCount || needsReview ? 'CONCLUIDO_COM_ERROS' : 'CONCLUIDO',
      persisted,
      invalidCount + needsReview,
      needsReview ? `${needsReview} linha(s) aguardam dependências ou correção.` : null,
      batchId,
    );
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  }

  return { lote: getBatch(database, batchId), persistidas: persisted, revisar: needsReview };
}
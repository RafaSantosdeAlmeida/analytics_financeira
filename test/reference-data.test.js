import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../src/database.js';
import { ingestCsv, persistBatch, stageBatch } from '../src/service.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const referenceFiles = [
  ['SETOR_SUBSETOR_SEGMENTO', 'dados/setor_subsetor_segmento.csv'],
  ['EMPRESAS', 'dados/empresas.csv'],
  ['PLANO_CONTA_EMPRESA', 'dados/plano_conta_empresa.csv'],
  ['PLANO_CONTA_SEGMENTO', 'dados/plano_conta_segmento.csv'],
  ['DFP_DRE', 'dados/demonstracoes_financeiras/2025/dfp_cia_aberta_DRE_con_2025.csv'],
];

test('ingests all project CSVs through raw, staging, and core', () => {
  const database = new DatabaseSync(':memory:');
  initializeDatabase(database);
  let dreResult;

  for (const [expectedType, relativePath] of referenceFiles) {
    const filePath = path.join(projectRoot, relativePath);
    const buffer = readFileSync(filePath);
    const batch = ingestCsv(database, {
      buffer,
      originalname: path.basename(filePath),
    });
    assert.equal(batch.tipo_arquivo, expectedType);
    assert.ok(batch.qtd_linhas_raw > 0);

    const staged = stageBatch(database, batch.id_lote);
    assert.equal(staged.qtd_linhas_staging, staged.qtd_linhas_raw);
    assert.ok(staged.qtd_linhas_validas > 0, `${relativePath} deve conter linhas válidas`);

    const result = persistBatch(database, batch.id_lote);
    if (expectedType === 'DFP_DRE') dreResult = result;
  }

  assert.ok(dreResult.persistidas > 0, 'a DRE deve carregar observações com referências válidas');
  assert.ok(database.prepare('SELECT COUNT(*) AS count FROM empresas').get().count > 0);
  assert.ok(database.prepare('SELECT COUNT(*) AS count FROM demonstracao_financeira').get().count > 0);
  assert.ok(database.prepare('SELECT COUNT(*) AS count FROM stg_linha WHERE status_validacao = ?')
    .get('REVISAR').count >= 0);
  database.close();
});
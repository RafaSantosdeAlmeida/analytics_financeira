import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../src/database.js';

test('initializes the complete SQLite schema with foreign keys enabled', () => {
  const database = new DatabaseSync(':memory:');

  initializeDatabase(database);

  const tableNames = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map((row) => row.name);
  const foreignKeys = database.prepare('PRAGMA foreign_keys').get().foreign_keys;

  assert.ok(tableNames.includes('raw_linha'));
  assert.ok(tableNames.includes('stg_linha'));
  assert.ok(tableNames.includes('demonstracao_financeira'));
  assert.equal(foreignKeys, 1);
  assert.doesNotThrow(() => initializeDatabase(database));
  database.close();
});

test('migrates the segment account foreign key to nullable without losing facts', () => {
  const database = new DatabaseSync(':memory:');
  initializeDatabase(database);
  database.exec(`
    INSERT INTO setor (id_setor, nome_setor) VALUES (1, 'Financeiro');
    INSERT INTO subsetor (id_subsetor, id_setor, nome_subsetor)
      VALUES (1, 1, 'Intermediarios Financeiros');
    INSERT INTO segmento (id_segmento, id_subsetor, nome_segmento)
      VALUES (1, 1, 'Bancos');
    INSERT INTO empresas (id_empresa, cnpj_cia, denom_cia, id_segmento)
      VALUES (1, '00000000000191', 'Empresa A', 1);
    INSERT INTO periodos (id_periodo, periodo, tipo_periodo, dt_ini_exerc, dt_fim_exerc, ano_exerc)
      VALUES (1, '2025', 'ANUAL', '2025-01-01', '2025-12-31', 2025);
    INSERT INTO plano_conta_empresa
      (id_plano_conta_empresa, id_empresa, cd_conta, nivel_conta, ds_conta_empresa)
      VALUES (1, 1, '3.04', 1, 'Conta raiz');
    INSERT INTO plano_conta_segmento
      (id_plano_conta_segmento, id_segmento, cd_conta, nivel_conta, ds_conta_segmento)
      VALUES (1, 1, '3.04', 1, 'Conta raiz');
    INSERT INTO ingestion_lote
      (id_lote, tipo_arquivo, nome_arquivo, hash_sha256, delimitador, encoding_arquivo, status_lote)
      VALUES (1, 'DFP_DRE', 'dre.csv', '${'a'.repeat(64)}', ';', 'UTF-8', 'CONCLUIDO');

    DROP TABLE demonstracao_financeira;
    CREATE TABLE demonstracao_financeira (
      id_demonstracao_financeira INTEGER PRIMARY KEY,
      id_empresa INTEGER NOT NULL REFERENCES empresas(id_empresa),
      id_periodo INTEGER NOT NULL REFERENCES periodos(id_periodo),
      id_plano_conta_empresa INTEGER NOT NULL,
      id_plano_conta_segmento INTEGER NOT NULL
        REFERENCES plano_conta_segmento(id_plano_conta_segmento),
      grupo_dfp TEXT NOT NULL CHECK (grupo_dfp IN ('INDIVIDUAL', 'CONSOLIDADO')),
      dt_refer TEXT NOT NULL,
      versao INTEGER NOT NULL,
      ordem_exerc TEXT NOT NULL,
      st_conta_fixa INTEGER NOT NULL CHECK (st_conta_fixa IN (0, 1)),
      moeda TEXT NOT NULL,
      escala_moeda TEXT NOT NULL,
      vl_conta REAL NOT NULL,
      id_lote_origem INTEGER NOT NULL REFERENCES ingestion_lote(id_lote),
      UNIQUE (id_empresa, id_periodo, id_plano_conta_empresa, grupo_dfp),
      FOREIGN KEY (id_plano_conta_empresa, id_empresa)
        REFERENCES plano_conta_empresa(id_plano_conta_empresa, id_empresa)
    );
    INSERT INTO demonstracao_financeira VALUES
      (1, 1, 1, 1, 1, 'CONSOLIDADO', '2025-12-31', 1, 'ULTIMO', 1, 'REAL', 'MIL', 10, 1);
  `);

  initializeDatabase(database);

  const column = database.prepare('PRAGMA table_info(demonstracao_financeira)')
    .all().find((item) => item.name === 'id_plano_conta_segmento');
  const migratedFact = database.prepare(`
    SELECT id_demonstracao_financeira, id_plano_conta_segmento, vl_conta
    FROM demonstracao_financeira
  `).get();
  database.prepare(`
    INSERT INTO plano_conta_empresa
      (id_plano_conta_empresa, id_empresa, cd_conta, nivel_conta, ds_conta_empresa)
    VALUES (2, 1, '3.04.01', 2, 'Conta detalhada')
  `).run();
  database.prepare(`
    INSERT INTO demonstracao_financeira (
      id_empresa, id_periodo, id_plano_conta_empresa, id_plano_conta_segmento,
      grupo_dfp, dt_refer, versao, ordem_exerc, st_conta_fixa,
      moeda, escala_moeda, vl_conta, id_lote_origem
    ) VALUES (1, 1, 2, NULL, 'CONSOLIDADO', '2025-12-31', 1, 'ULTIMO', 1,
      'REAL', 'MIL', 5, 1)
  `).run();

  assert.equal(column.notnull, 0);
  assert.deepEqual({ ...migratedFact }, {
    id_demonstracao_financeira: 1,
    id_plano_conta_segmento: 1,
    vl_conta: 10,
  });
  assert.equal(database.prepare(`
    SELECT COUNT(*) AS count FROM demonstracao_financeira WHERE id_plano_conta_segmento IS NULL
  `).get().count, 1);
  assert.equal(database.prepare('PRAGMA foreign_key_check').all().length, 0);
  database.close();
});
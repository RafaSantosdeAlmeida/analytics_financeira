import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../src/database.js';
import { queryAnalysis } from '../src/analysis.js';
import {
  countBatchRows,
  getBatch,
  getBatchRows,
  ingestCsv,
  persistBatch,
  stageBatch,
} from '../src/service.js';

const cnpj = '00.000.000/0001-91';
     
function upload(database, type, content, filename = `${type}.csv`) {
  return ingestCsv(database, {
    buffer: Buffer.from(content, 'utf8'),
    originalname: filename,
  });
}

function annualDre(group = 'DF Consolidado - Demonstracao do Resultado', order = 'ULTIMO') {
  const header = [
    'CNPJ_CIA', 'DT_REFER', 'VERSAO', 'DENOM_CIA', 'CD_CVM', 'GRUPO_DFP',
    'MOEDA', 'ESCALA_MOEDA', 'ORDEM_EXERC', 'DT_INI_EXERC', 'DT_FIM_EXERC',
    'CD_CONTA', 'DS_CONTA', 'VL_CONTA', 'ST_CONTA_FIXA',
  ].join(';');
  const rows = ['3.04;Despesa operacional;-125.5', '3.04.01;Despesa detalhada;-125.5']
    .map((account) => {
      const [code, description, amount] = account.split(';');
      return [
    cnpj, '2025-12-31', '1', 'Empresa A', '001234', group, 'REAL', 'MIL',
        order, '2025-01-01', '2025-12-31', code, description, amount, 'S',
      ].join(';');
    });
  return `${header}\n${rows.join('\n')}\n`;
}

function loadDimensions(database) {
  const companies = [
    'CNPJ,NOME_EMPRESA,CODIGO,SETOR,SUBSETOR,SEGMENTO',
    `${cnpj},Empresa A,EMPA,Financeiro,Intermediarios Financeiros,Bancos`,
  ].join('\n');
  const companyPlan = [
    'CNPJ_CIA;CD_CONTA;NIVEL_CONTA;DS_CONTA_EMPRESA',
    `${cnpj};3.04;1;Despesa operacional`,
    `${cnpj};3.04.01;2;Despesa detalhada`,
  ].join('\n');
  const segmentPlan = [
    'SETOR;SUBSETOR;SEGMENTO;CD_CONTA;NIVEL_CONTA;DS_CONTA_SEGMENTO',
    'Financeiro;Intermediarios Financeiros;Bancos;3.04;1;Despesas operacionais',
  ].join('\n');

  for (const [type, content, filename] of [
    ['SETOR_SUBSETOR_SEGMENTO',
      'SETOR;SUBSETOR;SEGMENTO\nFinanceiro;Intermediarios Financeiros;Bancos\n'],
    ['EMPRESAS', companies, 'empresas.csv'],
    ['PLANO_CONTA_EMPRESA', companyPlan, 'plano_conta_empresa.csv'],
    ['PLANO_CONTA_SEGMENTO', segmentPlan, 'plano_conta_segmento.csv'],
  ]) {
    const batch = upload(database, type, content, filename ?? `${type}.csv`);
    stageBatch(database, batch.id_lote);
    persistBatch(database, batch.id_lote);
  }
}

test('persists raw, staging, and DRE core rows with idempotent retries', () => {
  const database = new DatabaseSync(':memory:');
  initializeDatabase(database);
  loadDimensions(database);

  const dreBatch = upload(database, 'DFP_DRE', annualDre(), 'dre.csv');
  assert.equal(dreBatch.qtd_linhas_staging, 0);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM stg_linha WHERE id_lote = ?')
    .get(dreBatch.id_lote).count, 0);
  const stagedDreBatch = stageBatch(database, dreBatch.id_lote);
  assert.equal(stagedDreBatch.contagem_status.VALIDO, 2);
  const result = persistBatch(database, dreBatch.id_lote);

  assert.equal(result.persistidas, 2);
  assert.equal(result.revisar, 0);
  assert.equal(getBatch(database, dreBatch.id_lote).contagem_status.VALIDO, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM raw_linha WHERE id_lote = ?')
    .get(dreBatch.id_lote).count, 2);

  const facts = database.prepare(`
    SELECT pc.cd_conta AS conta_empresa, ps.cd_conta AS conta_segmento,
      d.grupo_dfp, d.vl_conta, p.tipo_periodo, p.periodo
    FROM demonstracao_financeira d
    JOIN periodos p ON p.id_periodo = d.id_periodo
    JOIN plano_conta_empresa pc ON pc.id_plano_conta_empresa = d.id_plano_conta_empresa
    LEFT JOIN plano_conta_segmento ps ON ps.id_plano_conta_segmento = d.id_plano_conta_segmento
    ORDER BY pc.cd_conta
  `).all().map((row) => ({ ...row }));
  assert.deepEqual(facts.map((row) => [row.conta_empresa, row.conta_segmento]), [
    ['3.04', '3.04'],
    ['3.04.01', null],
  ]);
  assert.ok(facts.every((row) => row.grupo_dfp === 'CONSOLIDADO'
    && row.vl_conta === -125.5 && row.tipo_periodo === 'ANUAL' && row.periodo === '2025'));

  const individual = queryAnalysis(database, 'individual', {
    companyId: 1,
    accountCode: '3.04.01',
    tipoPeriodo: 'ANUAL',
    grupoDfp: 'CONSOLIDADO',
  });
  assert.equal(individual.series[0].data.length, 1);
  assert.equal(individual.linhas.find((row) => row.cd_conta === '3.04.01')
    .cd_conta_segmento, null);

  persistBatch(database, dreBatch.id_lote);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM demonstracao_financeira')
    .get().count, 2);
  database.close();
});

test('counts distinct validation errors per invalid row in descending order', () => {
  const database = new DatabaseSync(':memory:');
  initializeDatabase(database);
  const batch = upload(database, 'SETOR_SUBSETOR_SEGMENTO', [
    'SETOR;SUBSETOR;SEGMENTO',
    'Financeiro;Bancos;Banco A',
    'Financeiro;Bancos;Banco B',
    'Financeiro;Bancos;Banco C',
    'Financeiro;Bancos;Banco D',
    'Financeiro;Bancos;Banco E',
    'Financeiro;Bancos;Banco F',
    'Financeiro;Bancos;Banco G',
  ].join('\n'));
  stageBatch(database, batch.id_lote);

  const stagedRows = database.prepare(`
    SELECT id_stg_linha FROM stg_linha WHERE id_lote = ? ORDER BY id_stg_linha
  `).all(batch.id_lote);
  const update = database.prepare(`
    UPDATE stg_linha SET status_validacao = ?, erro_validacao = ? WHERE id_stg_linha = ?
  `);
  update.run('INVALIDO', 'Erro B; Erro A; Erro A', stagedRows[0].id_stg_linha);
  update.run('INVALIDO', 'Erro A', stagedRows[1].id_stg_linha);
  update.run('INVALIDO', 'Erro C', stagedRows[2].id_stg_linha);
  update.run('REVISAR', 'Empresa 28.201.130/0001-01 não carregada; importe empresas.csv primeiro.',
    stagedRows[3].id_stg_linha);
  update.run('REVISAR', 'Empresa 19.014.221/0001-47 não carregada; importe empresas.csv primeiro.',
    stagedRows[4].id_stg_linha);
  update.run('REVISAR', 'O período 4T2025 já existe com outro intervalo de datas.',
    stagedRows[5].id_stg_linha);
  update.run('REVISAR', 'O período 3T2025 já existe com outro intervalo de datas.',
    stagedRows[6].id_stg_linha);

  const result = getBatch(database, batch.id_lote);
  assert.deepEqual(result.contagem_erros_validacao, [
    { tipo: 'Erro A', quantidade: 2 },
    { tipo: 'Erro B', quantidade: 1 },
    { tipo: 'Erro C', quantidade: 1 },
  ]);
  assert.deepEqual(result.contagem_erros_revisao, [
    { tipo: 'Empresa {CNPJ} não carregada; importe empresas.csv primeiro.', quantidade: 2 },
    { tipo: 'O período {período} já existe com outro intervalo de datas.', quantidade: 2 },
  ]);
  database.close();
});

test('returns no validation-error counts before staging', () => {
  const database = new DatabaseSync(':memory:');
  initializeDatabase(database);
  const batch = upload(database, 'SETOR_SUBSETOR_SEGMENTO', [
    'SETOR;SUBSETOR;SEGMENTO',
    'Financeiro;Bancos;Banco A',
  ].join('\n'));

  const result = getBatch(database, batch.id_lote);
  assert.deepEqual(result.contagem_erros_validacao, []);
  assert.deepEqual(result.contagem_erros_revisao, []);
  database.close();
});

test('filters staging columns across the batch and paginates the filtered rows', () => {
  const database = new DatabaseSync(':memory:');
  initializeDatabase(database);
  const batch = upload(database, 'SETOR_SUBSETOR_SEGMENTO', [
    'SETOR;SUBSETOR;SEGMENTO',
    'Financeiro;Bancos;Banco A',
    'Financeiro;Bancos;Banco B',
    'Financeiro;Bancos;Banco C',
  ].join('\n'));
  stageBatch(database, batch.id_lote);
  database.prepare(`
    UPDATE stg_linha SET status_validacao = 'INVALIDO', erro_validacao = 'Campo inválido'
    WHERE id_lote = ? AND id_stg_linha = (
      SELECT MIN(id_stg_linha) FROM stg_linha WHERE id_lote = ?
    )
  `).run(batch.id_lote, batch.id_lote);

  const filters = { 'dados.segmento': 'banco', status_validacao: 'inval' };
  assert.equal(countBatchRows(database, batch.id_lote, 'staging', filters), 1);
  assert.equal(getBatchRows(database, batch.id_lote, 'staging', 10, 0, filters)[0].dados.segmento,
    'Banco A');

  const allMatches = { 'dados.segmento': 'BANCO' };
  assert.equal(countBatchRows(database, batch.id_lote, 'staging', allMatches), 3);
  assert.deepEqual(getBatchRows(database, batch.id_lote, 'staging', 1, 1, allMatches)
    .map((row) => row.dados.segmento), ['Banco B']);
  database.close();
});

test('keeps DRE in review until missing account plans are loaded, then retries it', () => {
  const database = new DatabaseSync(':memory:');
  initializeDatabase(database);
  const companyBatch = upload(database, 'EMPRESAS', [
    'CNPJ,NOME_EMPRESA,CODIGO,SETOR,SUBSETOR,SEGMENTO',
    `${cnpj},Empresa A,EMPA,Financeiro,Intermediarios Financeiros,Bancos`,
  ].join('\n'));
  stageBatch(database, companyBatch.id_lote);
  persistBatch(database, companyBatch.id_lote);
  const dreBatch = upload(database, 'DFP_DRE', annualDre(), 'dre.csv');
  stageBatch(database, dreBatch.id_lote);

  const firstTry = persistBatch(database, dreBatch.id_lote);
  assert.equal(firstTry.revisar, 2);
  assert.equal(firstTry.lote.contagem_status.REVISAR, 2);

  const companyPlanBatch = upload(database, 'PLANO_CONTA_EMPRESA', [
    'CNPJ_CIA;CD_CONTA;NIVEL_CONTA;DS_CONTA_EMPRESA',
    `${cnpj};3.04;1;Despesa operacional`,
    `${cnpj};3.04.01;2;Despesa detalhada`,
  ].join('\n'));
  stageBatch(database, companyPlanBatch.id_lote);
  const segmentPlanBatch = upload(database, 'PLANO_CONTA_SEGMENTO', [
    'SETOR;SUBSETOR;SEGMENTO;CD_CONTA;NIVEL_CONTA;DS_CONTA_SEGMENTO',
    'Financeiro;Intermediarios Financeiros;Bancos;3.04;1;Despesas operacionais',
  ].join('\n'));
  stageBatch(database, segmentPlanBatch.id_lote);
  persistBatch(database, companyPlanBatch.id_lote);
  persistBatch(database, segmentPlanBatch.id_lote);

  const retry = persistBatch(database, dreBatch.id_lote);
  assert.equal(retry.persistidas, 2);
  assert.equal(retry.lote.contagem_status.VALIDO, 2);
  database.close();
});

test('never persists DRE rows whose exercise order is not ULTIMO', () => {
  const database = new DatabaseSync(':memory:');
  initializeDatabase(database);
  loadDimensions(database);

  const batch = upload(database, 'DFP_DRE', annualDre(undefined, 'PENÚLTIMO'), 'dre.csv');
  stageBatch(database, batch.id_lote);
  assert.equal(getBatch(database, batch.id_lote).contagem_status.INVALIDO, 2);

  const invalidRows = database.prepare(`
    SELECT id_stg_linha, dados_json FROM stg_linha WHERE id_lote = ?
  `).all(batch.id_lote);
  const forceValid = database.prepare(`
    UPDATE stg_linha SET status_validacao = 'VALIDO', dados_json = ? WHERE id_stg_linha = ?
  `);
  for (const row of invalidRows) {
    forceValid.run(row.dados_json, row.id_stg_linha);
  }

  const result = persistBatch(database, batch.id_lote);

  assert.equal(result.persistidas, 0);
  assert.equal(result.revisar, 2);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM demonstracao_financeira')
    .get().count, 0);
  database.close();
});
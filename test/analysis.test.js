import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { initializeDatabase } from '../src/database.js';
import { queryAnalysis } from '../src/analysis.js';
import { ingestCsv, persistBatch, stageBatch } from '../src/service.js';

const companies = [
  ['00.000.000/0001-91', 'Empresa A', 'A'],
  ['00.000.000/0002-72', 'Empresa B', 'B'],
];

function uploadAndPersist(database, type, content, filename) {
  const batch = ingestCsv(database, {
    buffer: Buffer.from(content, 'utf8'),
    originalname: filename,
  });
  stageBatch(database, batch.id_lote);
  persistBatch(database, batch.id_lote);
}

function createAnalysisDatabase(secondCurrency = 'REAL') {
  const database = new DatabaseSync(':memory:');
  initializeDatabase(database);
  uploadAndPersist(database, 'EMPRESAS', [
    'CNPJ,NOME_EMPRESA,CODIGO,SETOR,SUBSETOR,SEGMENTO',
    ...companies.map(([cnpj, name, ticker]) =>
      `${cnpj},${name},${ticker},Financeiro,Intermediarios Financeiros,Bancos`),
  ].join('\n'), 'empresas.csv');
  uploadAndPersist(database, 'PLANO_CONTA_EMPRESA', [
    'CNPJ_CIA;CD_CONTA;NIVEL_CONTA;DS_CONTA_EMPRESA',
    ...companies.flatMap(([cnpj]) => [
      `${cnpj};3.01;1;Receita`,
      `${cnpj};3.02;1;Custo`,
    ]),
  ].join('\n'), 'plano_conta_empresa.csv');
  uploadAndPersist(database, 'PLANO_CONTA_SEGMENTO', [
    'SETOR;SUBSETOR;SEGMENTO;CD_CONTA;NIVEL_CONTA;DS_CONTA_SEGMENTO',
    'Financeiro;Intermediarios Financeiros;Bancos;3.01;1;Receita',
    'Financeiro;Intermediarios Financeiros;Bancos;3.02;1;Custo',
  ].join('\n'), 'plano_conta_segmento.csv');

  const header = [
    'CNPJ_CIA', 'DT_REFER', 'VERSAO', 'DENOM_CIA', 'CD_CVM', 'GRUPO_DFP',
    'MOEDA', 'ESCALA_MOEDA', 'ORDEM_EXERC', 'DT_INI_EXERC', 'DT_FIM_EXERC',
    'CD_CONTA', 'DS_CONTA', 'VL_CONTA', 'ST_CONTA_FIXA',
  ].join(';');
  const rows = companies.flatMap(([cnpj, name], index) => [
    ['3.01', 'Receita', (index + 1) * 10],
    ['3.02', 'Custo', (index + 1) * 5],
  ].map(([account, description, amount]) => [
    cnpj,
    '2025-12-31',
    '1',
    name,
    `00${index + 1}`,
    'DF Consolidado - Demonstracao do Resultado',
    index === 1 ? secondCurrency : 'REAL',
    index === 1 ? 'UNIDADE' : 'MIL',
    'ULTIMO',
    '2025-01-01',
    '2025-12-31',
    account,
    description,
    String(amount),
    'S',
  ].join(';')));
  uploadAndPersist(database, 'DFP_DRE', `${header}\n${rows.join('\n')}\n`, 'dre.csv');
  return database;
}

test('builds comparison series and account bars with normalized scales', () => {
  const database = createAnalysisDatabase();
  const result = queryAnalysis(database, 'comparative', {
    companyIds: [1, 2],
    accountCode: '3.01',
    tipoPeriodo: 'ANUAL',
    grupoDfp: 'CONSOLIDADO',
    axisSecondary: true,
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
  });

  assert.equal(result.series.length, 2);
  assert.equal(result.series[0].data.length, 1);
  assert.equal(result.barras.length, 4);
  assert.equal(result.series[0].data[0].y, 10_000);
  assert.equal(result.series[1].data[0].y, 20);
  assert.equal(result.eixoSecundario, true);
  database.close();
});

test('rejects mixed currencies and secondary axis for more than two companies', () => {
  const mixedDatabase = createAnalysisDatabase('USD');
  assert.throws(() => queryAnalysis(mixedDatabase, 'comparative', {
    companyIds: [1, 2],
    accountCode: '3.01',
    tipoPeriodo: 'ANUAL',
    grupoDfp: 'CONSOLIDADO',
  }), (error) => error.statusCode === 409);
  assert.throws(() => queryAnalysis(mixedDatabase, 'comparative', {
    companyIds: [1, 2, 3],
    accountCode: '3.01',
    tipoPeriodo: 'ANUAL',
    axisSecondary: true,
  }), /eixo secundário disponível somente para duas empresas/i);
  mixedDatabase.close();
});
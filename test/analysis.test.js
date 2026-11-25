import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { inflateSync } from 'node:zlib';
import PDFDocument from 'pdfkit';
import { initializeDatabase } from '../src/database.js';
import { getFilterOptions, queryAnalysis } from '../src/analysis.js';
import { ingestCsv, persistBatch, stageBatch } from '../src/service.js';
import {
  buildFinancialReportData,
  chartLegendRows,
  generateFinancialReportPdf,
} from '../src/financial-report.js';
  
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

function createAnalysisDatabase(secondCurrency = 'REAL', companyList = companies) {
  const database = new DatabaseSync(':memory:');
  initializeDatabase(database);
  uploadAndPersist(database, 'EMPRESAS', [
    'CNPJ,NOME_EMPRESA,CODIGO,SETOR,SUBSETOR,SEGMENTO',
    ...companyList.map(([cnpj, name, ticker]) =>
      `${cnpj},${name},${ticker},Financeiro,Intermediarios Financeiros,Bancos`),
  ].join('\n'), 'empresas.csv');
  uploadAndPersist(database, 'PLANO_CONTA_EMPRESA', [
    'CNPJ_CIA;CD_CONTA;NIVEL_CONTA;DS_CONTA_EMPRESA',
    ...companyList.flatMap(([cnpj]) => [
      `${cnpj};3.01;1;Receita`,
      `${cnpj};3.01.01;2;Receita operacional`,
      `${cnpj};3.01.02;2;Outras receitas`,
      `${cnpj};3.02;1;Custo`,
      `${cnpj};8.44;1;Conta principal dinâmica`,
    ]),
  ].join('\n'), 'plano_conta_empresa.csv');
  uploadAndPersist(database, 'PLANO_CONTA_SEGMENTO', [
    'SETOR;SUBSETOR;SEGMENTO;CD_CONTA;NIVEL_CONTA;DS_CONTA_SEGMENTO',
    'Financeiro;Intermediarios Financeiros;Bancos;3.01;1;Receita',
    'Financeiro;Intermediarios Financeiros;Bancos;3.01.01;2;Receita operacional',
    'Financeiro;Intermediarios Financeiros;Bancos;3.01.02;2;Outras receitas',
    'Financeiro;Intermediarios Financeiros;Bancos;3.02;1;Custo',
    'Financeiro;Intermediarios Financeiros;Bancos;8.44;1;Conta principal dinâmica',
  ].join('\n'), 'plano_conta_segmento.csv');

  const header = [
    'CNPJ_CIA', 'DT_REFER', 'VERSAO', 'DENOM_CIA', 'CD_CVM', 'GRUPO_DFP',
    'MOEDA', 'ESCALA_MOEDA', 'ORDEM_EXERC', 'DT_INI_EXERC', 'DT_FIM_EXERC',
    'CD_CONTA', 'DS_CONTA', 'VL_CONTA', 'ST_CONTA_FIXA',
  ].join(';');
  const accountsByCompany = companyList.map((_, index) => {
    if (index === 0) return [
      ['3.01', 'Receita', 10],
      ['3.01.01', 'Receita operacional', 40],
      ['3.01.02', 'Outras receitas', 60],
      ['3.02', 'Custo', 5],
      ['8.44', 'Conta principal dinâmica', 2],
    ];
    if (index === 1) return [
      ['3.01.01', 'Receita operacional', 12],
      ['3.01.02', 'Outras receitas', 8],
      ['3.02', 'Custo', 10],
      ['8.44', 'Conta principal dinâmica', 3],
    ];
    return [
      ['3.01', 'Receita', (index + 1) * 10],
      ['3.02', 'Custo', (index + 1) * 5],
      ['8.44', 'Conta principal dinâmica', index + 1],
    ];
  });
  const rows = companyList.flatMap(([cnpj, name], index) => accountsByCompany[index].map(
    ([account, description, amount]) => [
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

function addDetailedAccounts(database, count) {
  const cnpj = companies[0][0];
  const descriptions = Array.from({ length: count }, (_, index) => {
    const description = index === 0
      ? `LONG_ACCOUNT_START ${'Long descriptive account text '.repeat(500)} LONG_ACCOUNT_END`
      : `Detailed account ${index + 1}`;
    return [
      `3.04.01.${String(index + 1).padStart(3, '0')}`,
      description,
      index + 1,
    ];
  });
  uploadAndPersist(database, 'PLANO_CONTA_EMPRESA', [
    'CNPJ_CIA;CD_CONTA;NIVEL_CONTA;DS_CONTA_EMPRESA',
    `${cnpj};3.04;1;Despesas operacionais`,
    ...descriptions.map(([code, description]) =>
      `${cnpj};${code};3;${description}`),
  ].join('\n'), 'detailed_accounts.csv');

  const header = [
    'CNPJ_CIA', 'DT_REFER', 'VERSAO', 'DENOM_CIA', 'CD_CVM', 'GRUPO_DFP',
    'MOEDA', 'ESCALA_MOEDA', 'ORDEM_EXERC', 'DT_INI_EXERC', 'DT_FIM_EXERC',
    'CD_CONTA', 'DS_CONTA', 'VL_CONTA', 'ST_CONTA_FIXA',
  ].join(';');
  const rows = descriptions.map(([code, description, amount]) => [
    cnpj,
    '2025-12-31',
    '1',
    companies[0][1],
    '001',
    'DF Consolidado - Demonstracao do Resultado',
    'REAL',
    'MIL',
    'ULTIMO',
    '2025-01-01',
    '2025-12-31',
    code,
    description,
    String(amount),
    'S',
  ].join(';'));
  uploadAndPersist(database, 'DFP_DRE', `${header}\n${rows.join('\n')}\n`, 'detailed_dre.csv');
}

function extractPdfText(pdf) {
  const source = pdf.toString('latin1');
  return [...source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
    .map(([, stream]) => inflateSync(Buffer.from(stream, 'latin1')).toString('latin1'))
    .flatMap((content) => [...content.matchAll(/<([0-9A-Fa-f]+)>/g)]
      .map(([, hex]) => Buffer.from(hex, 'hex').toString('latin1')))
    .join('\n')
    .replace(/\s+/g, '');
}

function extractPdfTextPositions(pdf) {
  const source = pdf.toString('latin1');
  return [...source.matchAll(/stream\r?\n([\s\S]*?)\r?\nendstream/g)]
    .flatMap(([, stream]) => {
      const content = inflateSync(Buffer.from(stream, 'latin1')).toString('latin1');
      return [...content.matchAll(/1 0 0 1 [-\d.]+ ([-\d.]+) Tm/g)]
        .map(([, y]) => Number(y));
    });
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
  assert.equal(result.barras.length, 6);
  assert.equal(result.series[0].data[0].y, 10_000);
  assert.equal(result.series[1].data[0].y, 20);
  assert.equal(result.linhasVisao.some((row) => row.cd_conta === '8.44'), true);
  assert.equal(result.linhasVisao.some((row) => row.cd_conta === '3.01.01'), false);
  assert.equal(
    result.linhasVisao.find((row) => row.id_empresa === 1 && row.cd_conta === '3.01')
      .origem_valor,
    'Valor reportado',
  );
  assert.equal(
    result.linhasVisao.find((row) => row.id_empresa === 2 && row.cd_conta === '3.01')
      .origem_valor,
    'Consolidado dos descendentes',
  );
  assert.equal(result.eixoSecundario, true);
  database.close();
});

test('defaults to principal accounts and offers analytic accounts as a detail option', () => {
  const database = createAnalysisDatabase();
  const principalOptions = getFilterOptions(database, {
    mode: 'individual',
    companyId: 1,
  }).accounts;
  const detailedOptions = getFilterOptions(database, {
    mode: 'individual',
    companyId: 1,
    includeDetails: true,
  }).accounts;

  assert.deepEqual(principalOptions.map((account) => account.cd_conta), ['3.01', '3.02', '8.44']);
  assert.equal(detailedOptions.length, 5);
  const result = queryAnalysis(database, 'individual', {
    companyId: 1,
    accountCode: '3.01',
    tipoPeriodo: 'ANUAL',
    grupoDfp: 'CONSOLIDADO',
  });
  const detailedResult = queryAnalysis(database, 'individual', {
    companyId: 1,
    accountCode: '3.01',
    tipoPeriodo: 'ANUAL',
    grupoDfp: 'CONSOLIDADO',
    includeDetails: true,
  });
  assert.equal(result.linhasVisao.length, 3);
  assert.equal(detailedResult.linhasVisao.length, 5);
  assert.equal(result.series[0].data[0].y, 10_000);
  database.close();
});

test('uses the nearest reported subtotal without adding its child accounts', () => {
  const database = createAnalysisDatabase();
  const cnpj = companies[0][0];
  uploadAndPersist(database, 'PLANO_CONTA_EMPRESA', [
    'CNPJ_CIA;CD_CONTA;NIVEL_CONTA;DS_CONTA_EMPRESA',
    `${cnpj};3.04.01;2;Subtotal operacional`,
    `${cnpj};3.04.01.001;3;Conta filha A`,
    `${cnpj};3.04.01.002;3;Conta filha B`,
  ].join('\n'), 'nested_accounts.csv');

  const header = [
    'CNPJ_CIA', 'DT_REFER', 'VERSAO', 'DENOM_CIA', 'CD_CVM', 'GRUPO_DFP',
    'MOEDA', 'ESCALA_MOEDA', 'ORDEM_EXERC', 'DT_INI_EXERC', 'DT_FIM_EXERC',
    'CD_CONTA', 'DS_CONTA', 'VL_CONTA', 'ST_CONTA_FIXA',
  ].join(';');
  const rows = [
    ['3.04.01', 'Subtotal operacional', '123'],
    ['3.04.01.001', 'Conta filha A', '90'],
    ['3.04.01.002', 'Conta filha B', '80'],
  ].map(([code, description, value]) => [
    cnpj,
    '2025-12-31',
    '1',
    'Empresa A',
    '001',
    'DF Consolidado - Demonstracao do Resultado',
    'REAL',
    'MIL',
    'ULTIMO',
    '2025-01-01',
    '2025-12-31',
    code,
    description,
    value,
    'S',
  ].join(';'));
  uploadAndPersist(database, 'DFP_DRE', `${header}\n${rows.join('\n')}\n`, 'nested_dre.csv');

  const result = queryAnalysis(database, 'individual', {
    companyId: 1,
    accountCode: '3.04',
    tipoPeriodo: 'ANUAL',
    grupoDfp: 'CONSOLIDADO',
  });
  const consolidated = result.linhasVisao.find((row) => row.cd_conta === '3.04');
  assert.equal(consolidated.valor_normalizado, 123_000);
  assert.equal(consolidated.origem_valor, 'Consolidado dos descendentes');
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

test('builds a financial report from the filtered SQLite analysis and generates a PDF', async () => {
  const database = createAnalysisDatabase();
  const report = buildFinancialReportData(database, 'individual', {
    companyIds: [1],
    accountCode: '3.01',
    tipoPeriodo: 'ANUAL',
    grupoDfp: 'CONSOLIDADO',
    periodStart: '2025-01-01',
    periodEnd: '2025-12-31',
    includeDetails: true,
  });

  assert.equal(report.companies.length, 1);
  assert.equal(report.rows.length, 5);
  assert.equal(report.sourceRows.length, 5);
  assert.equal(
    report.metricIndex.get('1|2025-12-31').get('revenue').value,
    10_000,
  );
  const pdf = await generateFinancialReportPdf(report);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.includes(Buffer.from('%%EOF')));
  const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;
  const extractedText = extractPdfText(pdf);
  const pageLabels = [...extractedText.matchAll(/P(?:á|\?)gina(\d+)de(\d+)/g)];
  assert.equal(pageLabels.length, pageCount);
  assert.deepEqual(
    pageLabels.map(([, page]) => Number(page)).sort((left, right) => left - right),
    Array.from({ length: pageCount }, (_, index) => index + 1),
  );
  assert.ok(pageLabels.every(([, , total]) => Number(total) === pageCount));
  database.close();
});

test('preserves long table cells and all detailed rows across PDF pages', async () => {
  const database = createAnalysisDatabase();
  addDetailedAccounts(database, 1_000);
  const report = buildFinancialReportData(database, 'individual', {
    companyIds: [1],
    accountCode: '3.01',
    tipoPeriodo: 'ANUAL',
    grupoDfp: 'CONSOLIDADO',
    includeDetails: true,
  });
  const consolidatedExpense = report.principalRows.find((row) => row.cd_conta === '3.04');
  assert.equal(consolidatedExpense.valor_normalizado, 500_500_000);
  const pdf = await generateFinancialReportPdf(report);
  const extractedText = extractPdfText(pdf);
  const pageCount = (pdf.toString('latin1').match(/\/Type\s*\/Page\b/g) ?? []).length;
  const pageLabels = [...extractedText.matchAll(/P(?:á|\?)gina(\d+)de(\d+)/g)];
  const textPositions = extractPdfTextPositions(pdf);

  assert.ok(pageCount > 2);
  assert.equal(pageLabels.length, pageCount);
  assert.ok(extractedText.includes('LONG_ACCOUNT_START'));
  assert.ok(extractedText.includes('LONG_ACCOUNT_END'));
  assert.ok((extractedText.match(/Escala/g) ?? []).length > 1);
  for (let index = 1; index <= 1_000; index += 1) {
    assert.ok(extractedText.includes(`3.04.01.${String(index).padStart(3, '0')}`));
  }
  assert.ok(textPositions.every((y) => y >= 0 && y <= 842));
  database.close();
});

test('lays out every company legend label across multiple rows', async () => {
  const labels = Array.from({ length: 6 }, (_, index) =>
    `Company ${index + 1} with a deliberately long identifying name`);
  const doc = new PDFDocument({ size: 'A4' });
  const finished = new Promise((resolve, reject) => {
    doc.on('error', reject);
    doc.on('end', resolve);
    doc.resume();
  });
  const layout = chartLegendRows(doc, labels.map((label) => ({
    company: { codigo_negociacao: '', denom_cia: label },
  })), 515);
  doc.end();
  await finished;

  const laidOutLabels = layout.rows.flatMap((row) =>
    row.items.map((item) => item.label));
  assert.deepEqual(laidOutLabels, labels);
  assert.ok(layout.rows.length > 1);
});

test('identifies plotted series when a comparative report contains more than six companies', async () => {
  const manyCompanies = Array.from({ length: 7 }, (_, index) => [
    String(10000000000000 + index),
    `Company ${index + 1} with a long financial-report label`,
    `SERIES_${String(index + 1).padStart(2, '0')}`,
  ]);
  const database = createAnalysisDatabase('REAL', manyCompanies);
  const report = buildFinancialReportData(database, 'comparative', {
    companyIds: manyCompanies.map((_, index) => index + 1),
    accountCode: '3.01',
    tipoPeriodo: 'ANUAL',
    grupoDfp: 'CONSOLIDADO',
  });
  const pdf = await generateFinancialReportPdf(report);
  const extractedText = extractPdfText(pdf);

  assert.equal(report.analysis.series.length, 7);
  assert.ok(extractedText.includes('tabelacompletainclui7.'));
  for (const [, , ticker] of manyCompanies) {
    assert.ok(extractedText.includes(ticker));
  }
  database.close();
});
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseAndStageCsv } from '../src/ingestion.js';

const cnpj = '00.000.000/0001-91';

test('detects the five supported CSV layouts by their headers', () => {
  const fixtures = [
    [
      'CNPJ,NOME_EMPRESA,CODIGO,SETOR,SUBSETOR,SEGMENTO',
      `${cnpj},Banco A,BNKA,Financeiro,Bancos,Bancos`,
      'EMPRESAS',
    ],
    [
      'SETOR;SUBSETOR;SEGMENTO',
      'Financeiro;Intermediários Financeiros;Bancos',
      'SETOR_SUBSETOR_SEGMENTO',
    ],
    [
      'CNPJ_CIA;CD_CONTA;NIVEL_CONTA;DS_CONTA_EMPRESA',
      `${cnpj};3.01;1;Receita`,
      'PLANO_CONTA_EMPRESA',
    ],
    [
      'SETOR;SUBSETOR;SEGMENTO;CD_CONTA;NIVEL_CONTA;DS_CONTA_SEGMENTO',
      'Financeiro;Intermediários Financeiros;Bancos;3.01;1;Receita',
      'PLANO_CONTA_SEGMENTO',
    ],
  ];

  for (const [header, row, expectedType] of fixtures) {
    const result = parseAndStageCsv(Buffer.from(`${header}\n${row}\n`, 'utf8'));
    assert.equal(result.type, expectedType);
    assert.equal(result.stagedRows[0].status, 'VALIDO');
  }
});

test('normalizes company CNPJ and reads UTF-8 BOM', () => {
  const csv = '\uFEFFCNPJ,NOME_EMPRESA,CODIGO,SETOR,SUBSETOR,SEGMENTO\n'
    + `${cnpj},Banco A,BNKA,Financeiro,Bancos,Bancos\n`;
  const result = parseAndStageCsv(Buffer.from(csv, 'utf8'));

  assert.equal(result.encoding, 'utf-8-sig');
  assert.equal(result.stagedRows[0].data.cnpj_cia, '00000000000191');
});

test('decodes Windows-1252 DRE text and classifies annual periods', () => {
  const header = [
    'CNPJ_CIA', 'DT_REFER', 'VERSAO', 'DENOM_CIA', 'CD_CVM', 'GRUPO_DFP',
    'MOEDA', 'ESCALA_MOEDA', 'ORDEM_EXERC', 'DT_INI_EXERC', 'DT_FIM_EXERC',
    'CD_CONTA', 'DS_CONTA', 'VL_CONTA', 'ST_CONTA_FIXA',
  ].join(';');
  const row = [
    cnpj, '2025-12-31', '1', 'Banco A', '001023',
    'DF Consolidado - Demonstração do Resultado', 'REAL', 'MIL', 'ÚLTIMO',
    '2025-01-01', '2025-12-31', '3.01', 'Receita', '1250.50', 'S',
  ].join(';');
  const result = parseAndStageCsv(Buffer.from(`${header}\n${row}\n`, 'latin1'));

  assert.equal(result.type, 'DFP_DRE');
  assert.equal(result.encoding, 'windows-1252');
  assert.equal(result.stagedRows[0].status, 'VALIDO');
  assert.equal(result.stagedRows[0].data.ordem_exerc, 'ULTIMO');
  assert.equal(result.stagedRows[0].data.tipo_periodo, 'ANUAL');
  assert.equal(result.stagedRows[0].data.grupo_dfp, 'CONSOLIDADO');
});

test('rejects DRE rows whose exercise order is not exactly ULTIMO', () => {
  const header = [
    'CNPJ_CIA', 'DT_REFER', 'VERSAO', 'DENOM_CIA', 'CD_CVM', 'GRUPO_DFP',
    'MOEDA', 'ESCALA_MOEDA', 'ORDEM_EXERC', 'DT_INI_EXERC', 'DT_FIM_EXERC',
    'CD_CONTA', 'DS_CONTA', 'VL_CONTA', 'ST_CONTA_FIXA',
  ].join(';');
  const row = [
    cnpj, '2025-12-31', '1', 'Banco A', '001023',
    'DF Consolidado - Demonstração do Resultado', 'REAL', 'MIL', 'PENÚLTIMO',
    '2025-01-01', '2025-12-31', '3.01', 'Receita', '1250.50', 'S',
  ].join(';');
  const result = parseAndStageCsv(Buffer.from(`${header}\n${row}\n`, 'utf8'));

  assert.equal(result.stagedRows[0].data.ordem_exerc, 'PENULTIMO');
  assert.equal(result.stagedRows[0].status, 'INVALIDO');
  assert.match(result.stagedRows[0].error, /ordem_exerc deve ser ULTIMO/);
});

test('marks empty DRE values invalid instead of converting them to zero', () => {
  const header = [
    'CNPJ_CIA', 'DT_REFER', 'VERSAO', 'DENOM_CIA', 'CD_CVM', 'GRUPO_DFP',
    'MOEDA', 'ESCALA_MOEDA', 'ORDEM_EXERC', 'DT_INI_EXERC', 'DT_FIM_EXERC',
    'CD_CONTA', 'DS_CONTA', 'VL_CONTA', 'ST_CONTA_FIXA',
  ].join(';');
  const row = [
    cnpj, '2025-12-31', '1', 'Banco A', '001023', 'DF Individual', 'REAL', 'MIL',
    'ÚLTIMO', '2025-01-01', '2025-12-31', '3.01', 'Receita', '', 'S',
  ].join(';');
  const result = parseAndStageCsv(Buffer.from(`${header}\n${row}\n`, 'latin1'));

  assert.equal(result.stagedRows[0].status, 'INVALIDO');
  assert.match(result.stagedRows[0].error, /vl_conta_origem vazio/);
});
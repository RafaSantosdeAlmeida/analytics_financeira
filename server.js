import express from 'express';
import multer from 'multer';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import ExcelJS from 'exceljs';
import { getFilterOptions, queryAnalysis } from './src/analysis.js';
import { initializeDatabase } from './src/database.js';
import {
  getBatch,
  getBatchRows,
  ingestCsv,
  listBatches,
  persistBatch,
  stageBatch,
} from './src/service.js';

const app = express();
const port = Number(process.env.PORT ?? 3000);
const root = path.dirname(fileURLToPath(import.meta.url));
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 100 * 1024 * 1024, files: 1, fields: 5 },
  fileFilter: (_request, file, callback) => {
    if (path.extname(file.originalname).toLowerCase() !== '.csv') {
      callback(new Error('Envie um arquivo com extensão .csv.'));
      return;
    }
    callback(null, true);
  },
});
const database = new DatabaseSync(
  process.env.DATABASE_PATH ?? path.join(root, 'analytics_financeira.sqlite'),
);
database.exec('PRAGMA foreign_keys = ON');
initializeDatabase(database);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(root, 'public')));
app.use('/vendor', express.static(path.join(root, 'node_modules', 'chart.js', 'dist')));

app.get('/api/health', (_request, response) => {
  response.json({ status: 'ok', database: 'sqlite' });
});

app.get('/api/ingestions', (_request, response) => {
  response.json({ lotes: listBatches(database) });
});

app.post('/api/ingestions', upload.single('file'), (request, response, next) => {
  try {
    if (!request.file) {
      response.status(400).json({ error: 'Selecione um arquivo CSV.' });
      return;
    }
    response.status(201).json({ lote: ingestCsv(database, request.file) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/ingestions/:id', (request, response) => {
  const batchId = Number(request.params.id);
  const batch = getBatch(database, batchId);
  if (!batch) {
    response.status(404).json({ error: 'Lote não encontrado.' });
    return;
  }

  const layer = request.query.layer === 'raw' ? 'raw' : 'staging';
  const limit = Math.max(1, Math.min(500, Number(request.query.limit) || 100));
  const offset = Math.max(0, Number(request.query.offset) || 0);
  const table = layer === 'raw' ? 'raw_linha' : 'stg_linha';
  const total = database.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE id_lote = ?`)
    .get(batchId).count;
  response.json({
    lote: batch,
    camada: layer,
    total,
    limite: limit,
    deslocamento: offset,
    linhas: getBatchRows(database, batchId, layer, limit, offset),
  });
});

app.post('/api/ingestions/:id/stage', (request, response, next) => {
  try {
    response.json({ lote: stageBatch(database, Number(request.params.id)) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/ingestions/:id/persist', (request, response, next) => {
  try {
    const result = persistBatch(database, Number(request.params.id));
    response.json(result);
  } catch (error) {
    next(error);
  }
});

app.get('/api/options', (request, response) => {
  response.json(getFilterOptions(database, {
    mode: request.query.mode,
    setor: request.query.setor,
    subsetor: request.query.subsetor,
    segmento: request.query.segmento,
    companyId: request.query.companyId,
    tipoPeriodo: request.query.tipoPeriodo,
    grupoDfp: request.query.grupoDfp,
  }));
});

function analysisParams(query) {
  return {
    companyIds: query.companyIds,
    accountCode: query.accountCode,
    tipoPeriodo: query.tipoPeriodo,
    grupoDfp: query.grupoDfp,
    periodStart: query.periodStart,
    periodEnd: query.periodEnd,
    axisSecondary: query.axisSecondary === 'true',
  };
}

app.get('/api/analysis/:mode', (request, response, next) => {
  try {
    response.json(queryAnalysis(database, request.params.mode, analysisParams(request.query)));
  } catch (error) {
    next(error);
  }
});

const exportColumns = [
  ['cnpj_cia', 'CNPJ'],
  ['denom_cia', 'Empresa'],
  ['codigo_negociacao', 'Código'],
  ['setor', 'Setor'],
  ['subsetor', 'Subsetor'],
  ['segmento', 'Segmento'],
  ['periodo', 'Período'],
  ['tipo_periodo', 'Tipo de período'],
  ['grupo_dfp', 'Modalidade'],
  ['dt_ini_exerc', 'Início do exercício'],
  ['dt_fim_exerc', 'Fim do exercício'],
  ['cd_conta', 'Código da conta'],
  ['ds_conta_empresa', 'Conta da empresa'],
  ['cd_conta_segmento', 'Conta do segmento'],
  ['ds_conta_segmento', 'Descrição do segmento'],
  ['moeda', 'Moeda'],
  ['escala_moeda', 'Escala'],
  ['vl_conta', 'Valor reportado'],
  ['st_conta_fixa', 'Conta fixa'],
];

function exportRows(mode, query) {
  return queryAnalysis(database, mode, analysisParams(query)).linhas;
}

app.get('/api/export/:mode', async (request, response, next) => {
  try {
    const rows = exportRows(request.params.mode, request.query);
    const format = request.query.format === 'xlsx' ? 'xlsx' : 'csv';
    const baseName = `analytics-financeira-${request.params.mode}`;

    if (format === 'csv') {
      const escape = (value) => {
        const text = value === null || value === undefined ? '' : String(value);
        return `"${text.replaceAll('"', '""')}"`;
      };
      const csv = [
        exportColumns.map(([, title]) => escape(title)).join(';'),
        ...rows.map((row) => exportColumns.map(([key]) => escape(row[key])).join(';')),
      ].join('\r\n');
      response.setHeader('Content-Type', 'text/csv; charset=utf-8');
      response.setHeader('Content-Disposition', `attachment; filename="${baseName}.csv"`);
      response.send(`\uFEFF${csv}`);
      return;
    }

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Análise');
    worksheet.columns = exportColumns.map(([key, header]) => ({ key, header, width: 22 }));
    worksheet.addRows(rows);
    response.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    response.setHeader('Content-Disposition', `attachment; filename="${baseName}.xlsx"`);
    await workbook.xlsx.write(response);
    response.end();
  } catch (error) {
    next(error);
  }
});

app.use((error, _request, response, _next) => {
  const status = error.statusCode ?? (error instanceof multer.MulterError ? 413 : 400);
  response.status(status).json({ error: error.message || 'Falha ao processar a solicitação.' });
});

app.listen(port, () => {
  console.log(`Analytics Financeira disponível em http://localhost:${port}`);
});
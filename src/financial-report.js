import PDFDocument from 'pdfkit';
import { queryAnalysis } from './analysis.js';

const MARGIN = 40;
const FOOTER_SPACE = 52;
const PDF_BOTTOM_MARGIN = 32;
const TABLE_HEADER_HEIGHT = 20;
const CHART_HEIGHT = 164;
const TABLE_ROW_MIN_HEIGHT = 19;
const TABLE_CELL_PADDING = 4;
const COLORS = {
  ink: '#1d2926',
  muted: '#6f7d77',
  line: '#dce4df',
  pale: '#f3f7f3',
  green: '#176b53',
  greenDark: '#124e3e',
  greenSoft: '#e6f2ec',
  coral: '#b85f49',
  blue: '#477a99',
  yellow: '#d7a643',
};
const CHART_COLORS = ['#176b53', '#e47d61', '#477a99', '#d7a643', '#745e8b', '#64a58d'];
const FIXED_METRICS = [
  { key: 'revenue', title: 'Receita total', code: '3.01' },
  { key: 'costs', title: 'Custos e despesas diretas', code: '3.02' },
  { key: 'gross', title: 'Resultado bruto', code: '3.03' },
  { key: 'operatingExpenses', title: 'Despesas/receitas operacionais', code: '3.04' },
];
const OPTIONAL_METRICS = [
  {
    key: 'operatingResult',
    title: 'Resultado operacional',
    matches: (description) => description.includes('resultado antes do resultado financeiro')
      || description === 'resultado operacional',
  },
  {
    key: 'financialResult',
    title: 'Resultado financeiro',
    matches: (description) => description === 'resultado financeiro',
  },
  {
    key: 'finalResult',
    title: 'Resultado final',
    matches: (description) => /lucro.*prejuizo.*consolidado do periodo/.test(description)
      || /lucro liquido.*do periodo/.test(description)
      || /prejuizo liquido.*do periodo/.test(description),
  },
];
const METRICS = [...FIXED_METRICS, ...OPTIONAL_METRICS];

function companyIdsFrom(value) {
  const source = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(source.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function normalizeText(value) {
  return String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function accountCode(row, mode) {
  return mode === 'comparative' ? row.cd_conta_segmento ?? row.cd_conta : row.cd_conta;
}

function accountDescription(row, mode) {
  return mode === 'comparative'
    ? row.ds_conta_segmento ?? row.ds_conta_empresa
    : row.ds_conta_empresa;
}

function isRootCode(code) {
  return /^\d+\.\d+$/.test(String(code ?? ''));
}

function findMetricRow(rows, metric, mode) {
  return rows.find((row) => {
    const code = accountCode(row, mode);
    if (metric.code) return code === metric.code;
    return isRootCode(code) && metric.matches(normalizeText(accountDescription(row, mode)));
  }) ?? null;
}

function dateLabel(value) {
  if (!value) return 'Não informado';
  const date = String(value).slice(0, 10);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  return match ? `${match[3]}/${match[2]}/${match[1]}` : String(value);
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))];
}

function makeMetricIndex(rows, companies, periods, mode) {
  const rowsByCompanyPeriod = new Map();
  for (const row of rows) {
    const key = `${row.id_empresa}|${row.dt_fim_exerc}`;
    if (!rowsByCompanyPeriod.has(key)) rowsByCompanyPeriod.set(key, []);
    rowsByCompanyPeriod.get(key).push(row);
  }

  const index = new Map();
  for (const company of companies) {
    for (const period of periods) {
      const periodRows = rowsByCompanyPeriod.get(`${company.id_empresa}|${period.dt_fim_exerc}`) ?? [];
      const metrics = new Map();
      for (const metric of METRICS) {
        const row = findMetricRow(periodRows, metric, mode);
        metrics.set(metric.key, row ? {
          value: row.valor_normalizado,
          row,
        } : null);
      }
      index.set(`${company.id_empresa}|${period.dt_fim_exerc}`, metrics);
    }
  }
  return index;
}

function selectedMetric(index, companyId, period, metricKey) {
  return index.get(`${companyId}|${period.dt_fim_exerc}`)?.get(metricKey) ?? null;
}

function formatUpdate(value) {
  if (!value) return null;
  const parsed = new Date(`${String(value).replace(' ', 'T')}Z`);
  return Number.isNaN(parsed.valueOf())
    ? String(value)
    : new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
      timeZone: 'UTC',
    }).format(parsed);
}

export function buildFinancialReportData(database, mode, params = {}) {
  const analysis = queryAnalysis(database, mode, params);
  const companyIds = companyIdsFrom(params.companyIds ?? params.companyId);
  const companies = companyIds.length
    ? database.prepare(`
        SELECT e.id_empresa, e.cnpj_cia, e.denom_cia, e.codigo_negociacao,
          st.nome_setor AS setor, ss.nome_subsetor AS subsetor, sg.nome_segmento AS segmento
        FROM empresas e
        JOIN segmento sg ON sg.id_segmento = e.id_segmento
        JOIN subsetor ss ON ss.id_subsetor = sg.id_subsetor
        JOIN setor st ON st.id_setor = ss.id_setor
        WHERE e.id_empresa IN (${companyIds.map(() => '?').join(', ')})
        ORDER BY e.denom_cia
      `).all(...companyIds)
    : [];
  const rows = params.includeDetails ? analysis.linhas : analysis.linhasPrincipais;
  const sourceRows = analysis.linhas;
  const principalRows = analysis.linhasPrincipais;
  const periods = [...new Map(sourceRows.map((row) => [row.dt_fim_exerc, {
    periodo: row.periodo,
    dt_fim_exerc: row.dt_fim_exerc,
    dt_ini_exerc: row.dt_ini_exerc,
  }])).values()].sort((a, b) => a.dt_fim_exerc.localeCompare(b.dt_fim_exerc));
  const metricIndex = makeMetricIndex(principalRows, companies, periods, mode);
  const currencies = uniqueValues(sourceRows.map((row) => row.moeda));
  const latestPeriod = periods.at(-1) ?? null;
  const lastUpdate = database.prepare(`
    SELECT MAX(persistido_em) AS ultima_atualizacao
    FROM ingestion_lote
    WHERE persistido_em IS NOT NULL AND qtd_linhas_validas > 0
  `).get()?.ultima_atualizacao ?? null;
  const companyDescriptions = {
    setor: uniqueValues(companies.map((company) => company.setor)),
    subsetor: uniqueValues(companies.map((company) => company.subsetor)),
    segmento: uniqueValues(companies.map((company) => company.segmento)),
  };
  const requestedRange = params.periodStart || params.periodEnd
    ? `${dateLabel(params.periodStart)} a ${dateLabel(params.periodEnd)}`
    : periods.length
      ? `${dateLabel(periods[0].dt_fim_exerc)} a ${dateLabel(periods.at(-1).dt_fim_exerc)}`
      : 'Sem registros no período selecionado';

  return {
    mode,
    params,
    analysis,
    companies,
    rows,
    sourceRows,
    principalRows,
    periods,
    metricIndex,
    latestPeriod,
    currencies,
    companyDescriptions,
    generatedAt: new Date(),
    lastUpdate: formatUpdate(lastUpdate),
    requestedRange,
  };
}

function formatNumber(value, digits = 2) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return new Intl.NumberFormat('pt-BR', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value));
}

function formatMoney(value, currency) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '—';
  return `${formatNumber(value)}${currency ? ` ${currency}` : ''}`;
}

function formatPercent(value) {
  return value === null || value === undefined || !Number.isFinite(Number(value))
    ? '—'
    : `${formatNumber(value, 1)}%`;
}

function variation(current, previous) {
  if (current === null || previous === null) return null;
  const difference = current - previous;
  return {
    difference,
    percentage: previous === 0 ? null : (difference / Math.abs(previous)) * 100,
  };
}

function companyName(company) {
  const identifier = company.codigo_negociacao || company.cnpj_cia;
  return identifier ? `${company.denom_cia} (${identifier})` : company.denom_cia;
}

function rowCompanyName(data, row) {
  const company = data.companies.find((item) => item.id_empresa === row.id_empresa);
  return company?.codigo_negociacao || company?.denom_cia || `Empresa ${row.id_empresa}`;
}

function metricValue(data, company, period, key) {
  return selectedMetric(data.metricIndex, company.id_empresa, period, key)?.value ?? null;
}

function metricRow(data, company, period, key) {
  return selectedMetric(data.metricIndex, company.id_empresa, period, key)?.row ?? null;
}

function displayMetricTitle(metric, row, mode) {
  const code = row ? accountCode(row, mode) : metric.code;
  return code ? `${metric.title} (${code})` : metric.title;
}

function shortDateRange(data) {
  if (data.params.periodStart || data.params.periodEnd) return data.requestedRange;
  if (!data.periods.length) return data.requestedRange;
  return data.periods.length === 1
    ? data.periods[0].periodo
    : `${data.periods[0].periodo}–${data.periods.at(-1).periodo}`;
}

function prepareDocument(doc, section = '') {
  doc.addPage({
    size: 'A4',
    margins: { top: 52, bottom: PDF_BOTTOM_MARGIN, left: MARGIN, right: MARGIN },
  });
  const { width } = doc.page;
  doc.save();
  doc.fillColor(COLORS.greenDark).font('Helvetica-Bold').fontSize(8)
    .text('ANALYTICS FINANCEIRA', MARGIN, 22, { characterSpacing: 0.8 });
  if (section) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
      .text(section.toLocaleUpperCase('pt-BR'), width - 190, 22, {
        width: 150,
        align: 'right',
        ellipsis: true,
      });
  }
  doc.moveTo(MARGIN, 39).lineTo(width - MARGIN, 39).strokeColor(COLORS.line).lineWidth(0.7).stroke();
  doc.restore();
  doc.y = 56;
}

function startSection(doc, title, description = '', keepWithNext = 32) {
  const width = doc.page.width - 2 * MARGIN;
  doc.font('Helvetica').fontSize(9);
  const descriptionHeight = description
    ? doc.heightOfString(description, { width, lineGap: 2 }) + 10
    : 0;
  ensureSpace(doc, 55 + descriptionHeight + keepWithNext, title);
  doc.fillColor(COLORS.green).font('Helvetica-Bold').fontSize(8)
    .text('RELATÓRIO ANALÍTICO', MARGIN, doc.y, { characterSpacing: 0.6 });
  doc.moveDown(0.5);
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(20).text(title, MARGIN, doc.y);
  doc.moveDown(0.4);
  if (description) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9)
      .text(description, MARGIN, doc.y, { width: doc.page.width - 2 * MARGIN, lineGap: 2 });
  }
  doc.moveDown(0.9);
}

function ensureSpace(doc, height, section) {
  if (doc.y + height <= doc.page.height - FOOTER_SPACE) return;
  prepareDocument(doc, `${section} · continuação`);
}

function wrapTextToWidth(doc, value, width) {
  const lines = [];
  for (const sourceLine of String(value ?? '—').split(/\r\n|\n|\r/)) {
    let line = '';
    const tokens = sourceLine.match(/\S+\s*|\s+/g) ?? [''];
    for (const token of tokens) {
      if (doc.widthOfString(token) <= width) {
        if (line && doc.widthOfString(line + token) > width) {
          lines.push(line);
          line = token;
        } else {
          line += token;
        }
        continue;
      }

      for (const character of Array.from(token)) {
        if (line && doc.widthOfString(line + character) > width) {
          lines.push(line);
          line = '';
        }
        line += character;
      }
    }
    lines.push(line);
  }
  return lines;
}

function drawTable(doc, columns, rows, section) {
  const tableWidth = columns.reduce((total, column) => total + column.width, 0);
  const xStart = MARGIN;
  const drawHeader = () => {
    const y = doc.y;
    doc.save();
    doc.rect(xStart, y, tableWidth, TABLE_HEADER_HEIGHT).fill(COLORS.greenDark);
    doc.font('Helvetica-Bold').fontSize(7).fillColor('#ffffff');
    let x = xStart;
    for (const column of columns) {
      doc.text(column.title, x + 5, y + 5, {
        width: column.width - 10,
        height: 11,
        align: column.align ?? 'left',
        lineBreak: false,
        ellipsis: true,
      });
      x += column.width;
    }
    doc.restore();
    doc.y = y + TABLE_HEADER_HEIGHT;
  };

  if (!rows.length) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9)
      .text('Não há registros disponíveis para este recorte.', MARGIN, doc.y);
    doc.moveDown(0.8);
    return;
  }

  doc.font('Helvetica').fontSize(7.5);
  const lineHeight = doc.heightOfString('Ag', { lineGap: 1 });
  const pageBottom = doc.page.height - FOOTER_SPACE;
  const maxLinesPerPage = Math.max(1, Math.floor(
    (pageBottom - 56 - TABLE_HEADER_HEIGHT - TABLE_CELL_PADDING * 2) / lineHeight,
  ));
  const currentPageIndex = () => {
    const pageRange = doc.bufferedPageRange();
    return pageRange.start + pageRange.count - 1;
  };
  let headerPage = null;
  const drawHeaderOnCurrentPage = () => {
    const pageIndex = currentPageIndex();
    if (headerPage === pageIndex) return false;
    drawHeader();
    headerPage = pageIndex;
    return true;
  };

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    const cells = columns.map((column, columnIndex) =>
      wrapTextToWidth(doc, row[columnIndex], column.width - 10));
    const rowLineCount = Math.max(1, ...cells.map((lines) => lines.length));
    const fullRowHeight = Math.max(
      TABLE_ROW_MIN_HEIGHT,
      rowLineCount * lineHeight + TABLE_CELL_PADDING * 2,
    );
    if (rowLineCount <= maxLinesPerPage
      && doc.y + (headerPage === currentPageIndex() ? 0 : TABLE_HEADER_HEIGHT)
        + fullRowHeight > pageBottom) {
      prepareDocument(doc, `${section} · continuação`);
    }
    let lineOffset = 0;
    let fragment = 0;

    while (lineOffset < rowLineCount) {
      const needsHeader = headerPage !== currentPageIndex();
      const availableLines = Math.floor(
        (pageBottom - doc.y - (needsHeader ? TABLE_HEADER_HEIGHT : 0)
          - TABLE_CELL_PADDING * 2) / lineHeight,
      );
      if (availableLines < 1) {
        prepareDocument(doc, `${section} · continuação`);
        continue;
      }

      const fragmentLines = Math.min(rowLineCount - lineOffset, availableLines, maxLinesPerPage);
      const height = Math.max(
        TABLE_ROW_MIN_HEIGHT,
        fragmentLines * lineHeight + TABLE_CELL_PADDING * 2,
      );
      drawHeaderOnCurrentPage();
      const y = doc.y;
      if (index % 2 === 0) {
        doc.save();
        doc.rect(xStart, y, tableWidth, height).fill(COLORS.pale);
        doc.restore();
      }

      let x = xStart;
      for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
        const column = columns[columnIndex];
        let value = cells[columnIndex].slice(lineOffset, lineOffset + fragmentLines).join('\n');
        if (fragment > 0 && columnIndex === 0 && !value) value = '(continuação)';
        if (value) {
          doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7.5)
            .text(value, x + 5, y + TABLE_CELL_PADDING, {
              width: column.width - 10,
              height: height - TABLE_CELL_PADDING,
              align: column.align ?? 'left',
              lineGap: 1,
              ellipsis: false,
            });
        }
        x += column.width;
      }
      doc.moveTo(xStart, y + height).lineTo(xStart + tableWidth, y + height)
        .strokeColor(COLORS.line).lineWidth(0.35).stroke();
      doc.y = y + height;
      lineOffset += fragmentLines;
      fragment += 1;
      if (lineOffset < rowLineCount) {
        prepareDocument(doc, `${section} · continuação`);
      }
    }
  }
  doc.moveDown(0.7);
}

function drawParagraph(doc, text, section, options = {}) {
  const width = doc.page.width - 2 * MARGIN;
  doc.font(options.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(options.fontSize ?? 9);
  const height = doc.heightOfString(text, { width, lineGap: 2 }) + 2;
  ensureSpace(doc, height, section);
  doc.fillColor(options.color ?? COLORS.ink).text(text, MARGIN, doc.y, {
    width,
    lineGap: 2,
  });
  doc.moveDown(options.gap ?? 0.45);
}

function drawMetricCards(doc, data) {
  const company = data.companies[0];
  const period = data.latestPeriod;
  if (!company || !period) {
    drawParagraph(doc, 'Não há dados financeiros para calcular indicadores neste recorte.', 'Sumário executivo');
    return;
  }
  const metrics = METRICS.map((metric) => ({
    metric,
    row: metricRow(data, company, period, metric.key),
    value: metricValue(data, company, period, metric.key),
  }));
  const width = (doc.page.width - 2 * MARGIN - 12) / 2;
  const height = 55;
  const cardRows = Math.ceil(metrics.length / 2);
  const gridHeight = cardRows * height + (cardRows - 1) * 8 + 10;
  ensureSpace(doc, gridHeight, 'Sumário executivo');
  const gridStartY = doc.y;
  for (let index = 0; index < metrics.length; index += 1) {
    const item = metrics[index];
    const column = index % 2;
    const row = Math.floor(index / 2);
    const x = MARGIN + column * (width + 12);
    const y = gridStartY + row * (height + 8);
    doc.save();
    doc.roundedRect(x, y, width, height, 5).fill(COLORS.pale);
    doc.roundedRect(x, y, 3, height, 1.5).fill(COLORS.green);
    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(7.5)
      .text(displayMetricTitle(item.metric, item.row, data.mode), x + 12, y + 9, {
        width: width - 22,
        ellipsis: true,
        lineBreak: false,
      });
    doc.fillColor(item.value !== null && item.value < 0 ? COLORS.coral : COLORS.ink)
      .font('Helvetica-Bold').fontSize(12)
      .text(formatMoney(item.value, data.currencies[0]), x + 12, y + 25, {
        width: width - 22,
        ellipsis: true,
        lineBreak: false,
      });
    doc.restore();
  }
  doc.y = gridStartY + gridHeight;
}

function latestAndPrevious(data, company) {
  if (!data.periods.length) return { latest: null, previous: null };
  const latest = data.periods.at(-1);
  const previous = data.periods.at(-2) ?? null;
  return {
    latest: { period: latest, metrics: data.metricIndex.get(`${company.id_empresa}|${latest.dt_fim_exerc}`) },
    previous: previous
      ? { period: previous, metrics: data.metricIndex.get(`${company.id_empresa}|${previous.dt_fim_exerc}`) }
      : null,
  };
}

function createInsights(data) {
  const insights = [];
  for (const company of data.companies) {
    const { latest, previous } = latestAndPrevious(data, company);
    if (!latest || !previous) continue;
    for (const metric of METRICS) {
      const current = metricValue(data, company, latest.period, metric.key);
      const prior = metricValue(data, company, previous.period, metric.key);
      const change = variation(current, prior);
      if (change) insights.push({
        company: company.codigo_negociacao || company.denom_cia,
        metric: metric.title,
        period: latest.period.periodo,
        previousPeriod: previous.period.periodo,
        ...change,
      });
    }
  }
  return insights.sort((a, b) => Math.abs(b.difference) - Math.abs(a.difference)).slice(0, 6);
}

function drawExecutiveSummary(doc, data) {
  startSection(doc, '1. Sumário executivo',
    `Período de referência: ${shortDateRange(data)}. Valores analíticos normalizados para unidade-base conforme escala reportada; moeda ${data.currencies.join(', ') || 'não informada'}.`,
    data.mode === 'individual' ? 140 : 55);

  if (data.mode === 'individual') {
    drawMetricCards(doc, data);
  } else {
    const latest = data.latestPeriod;
    const columns = [
      { title: 'Empresa', width: 100 },
      { title: 'Receita 3.01', width: 78, align: 'right' },
      { title: 'Custos 3.02', width: 78, align: 'right' },
      { title: 'Resultado bruto', width: 82, align: 'right' },
      { title: 'Resultado financeiro', width: 92, align: 'right' },
      { title: 'Resultado final', width: 85, align: 'right' },
    ];
    const rows = latest ? data.companies.map((company) => columns.map((_, index) => {
      if (index === 0) return company.codigo_negociacao || company.denom_cia;
      const metricKey = ['revenue', 'costs', 'gross', 'financialResult', 'finalResult'][index - 1];
      return formatMoney(metricValue(data, company, latest, metricKey), data.currencies[0]);
    })) : [];
    drawParagraph(doc, latest
      ? `Resumo por empresa para o último período com dados (${latest.periodo}). Os valores não são somados entre empresas.`
      : 'Não há registros financeiros para os critérios selecionados.', 'Sumário executivo');
    drawTable(doc, columns, rows, 'Sumário executivo');
  }

  const principalAccounts = data.principalRows.filter((row) =>
    row.dt_fim_exerc === data.latestPeriod?.dt_fim_exerc
      && (data.mode === 'individual'
        ? row.nivel_conta === 1
        : row.nivel_conta_segmento === 1 && row.cd_conta_segmento !== null));
  if (principalAccounts.length) {
    drawParagraph(doc, `Contas principais no período final ${data.latestPeriod.periodo}:`,
      'Sumário executivo', { bold: true, gap: 0.35 });
    drawTable(doc, [
      { title: 'Empresa', width: 90 },
      { title: 'Código', width: 60 },
      { title: 'Conta principal', width: 255 },
      { title: 'Valor normalizado', width: 110, align: 'right' },
    ], principalAccounts.map((row) => [
      rowCompanyName(data, row),
      accountCode(row, data.mode),
      accountDescription(row, data.mode),
      formatMoney(row.valor_normalizado, row.moeda),
    ]), 'Sumário executivo');
  }

  const insights = createInsights(data);
  if (insights.length) {
    drawParagraph(doc, 'Variações observadas entre os dois períodos mais recentes disponíveis:', 'Sumário executivo', {
      bold: true,
      gap: 0.4,
    });
    for (const insight of insights) {
      const percent = insight.percentage === null
        ? 'percentual indisponível porque o valor anterior é zero'
        : `${formatPercent(insight.percentage)} sobre o valor absoluto anterior`;
      drawParagraph(doc,
        `${insight.company} · ${insight.metric}: ${insight.period} versus ${insight.previousPeriod}; variação ${formatMoney(insight.difference, data.currencies[0])} (${percent}).`,
        'Sumário executivo',
        { fontSize: 8, gap: 0.3 });
    }
  } else {
    drawParagraph(doc, 'Variações percentuais não calculadas: a base não contém dois períodos comparáveis para os indicadores disponíveis.', 'Sumário executivo', {
      color: COLORS.muted,
    });
  }
  drawParagraph(doc,
    'As rubricas são apresentadas conforme o código e a descrição existentes no plano de contas. Indicadores ausentes não são estimados.',
    'Sumário executivo',
    { fontSize: 8, color: COLORS.muted });
}

function criteriaValue(data, key, companyField) {
  if (data.params[key]) return data.params[key];
  const values = data.companyDescriptions[companyField] ?? [];
  return values.length ? values.join('; ') : 'Não informado';
}

function drawCriteria(doc, data) {
  startSection(doc, '2. Critérios da análise',
    'Parâmetros usados na consulta financeira que originou este documento.',
    TABLE_HEADER_HEIGHT + TABLE_ROW_MIN_HEIGHT);
  const companyLabel = data.companies.length === 1
    ? companyName(data.companies[0])
    : `${data.companies.length} empresas selecionadas`;
  const accountRow = data.rows.find((row) =>
    accountCode(row, data.mode) === data.params.accountCode);
  const criteria = [
    ['Empresa(s)', companyLabel],
    ['Setor', criteriaValue(data, 'setor', 'setor')],
    ['Subsetor', criteriaValue(data, 'subsetor', 'subsetor')],
    ['Segmento', criteriaValue(data, 'segmento', 'segmento')],
    ['Conta da análise', `${data.params.accountCode ?? 'Não informada'}${accountRow
      ? ` · ${accountDescription(accountRow, data.mode)}` : ''}`],
    ['Visão contábil', data.params.includeDetails ? 'Detalhada' : 'Contas principais'],
    ['Modalidade', data.params.grupoDfp ?? data.analysis.grupoDfp],
    ['Tipo de período', data.params.tipoPeriodo ?? data.analysis.tipoPeriodo],
    ['Intervalo', data.requestedRange],
    ['Data da última carga persistida', data.lastUpdate ?? 'Não disponível'],
    ['Data/hora de geração', new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'short',
      timeStyle: 'short',
    }).format(data.generatedAt)],
  ];
  drawTable(doc, [
    { title: 'Critério', width: 150 },
    { title: 'Valor', width: 365 },
  ], criteria, 'Critérios da análise');

  if (data.companies.length > 1) {
    drawParagraph(doc, 'Empresas incluídas no recorte:', 'Critérios da análise', { bold: true });
    const companyRows = data.companies.map((company) => [
      company.codigo_negociacao || '—',
      company.denom_cia,
      company.cnpj_cia,
      [company.setor, company.subsetor, company.segmento].filter(Boolean).join(' · '),
    ]);
    drawTable(doc, [
      { title: 'Código', width: 58 },
      { title: 'Empresa', width: 145 },
      { title: 'CNPJ', width: 95 },
      { title: 'Classificação', width: 217 },
    ], companyRows, 'Critérios da análise');
  }
}

function rowsForPrefix(data, prefix, { directOnly = true } = {}) {
  return data.rows.filter((row) => {
    const code = row.cd_conta;
    if (code === prefix) return true;
    if (!code.startsWith(`${prefix}.`)) return false;
    if (!directOnly) return true;
    return code.split('.').length === prefix.split('.').length + 1;
  });
}

function parentValue(data, row, prefix) {
  const company = data.companies.find((item) => item.id_empresa === row.id_empresa);
  const period = data.periods.find((item) => item.dt_fim_exerc === row.dt_fim_exerc);
  if (!company || !period) return null;
  const parent = metricRow(data, company, period, {
    '3.01': 'revenue',
    '3.02': 'costs',
    '3.03': 'gross',
    '3.04': 'operatingExpenses',
  }[prefix]);
  return parent?.valor_normalizado ?? null;
}

function accountTableRows(data, accountRows, prefix, { includeParticipation = true } = {}) {
  const rows = [...accountRows].sort((a, b) =>
    a.dt_fim_exerc.localeCompare(b.dt_fim_exerc)
      || rowCompanyName(data, a).localeCompare(rowCompanyName(data, b))
      || a.cd_conta.localeCompare(b.cd_conta));
  return rows.map((row) => {
    const parent = parentValue(data, row, prefix);
    const participation = row.cd_conta === prefix
      ? 100
      : parent === null || parent === 0
        ? null
        : (row.valor_normalizado / parent) * 100;
    return [
      row.periodo,
      rowCompanyName(data, row),
      row.cd_conta,
      row.ds_conta_empresa,
      formatMoney(row.valor_normalizado, row.moeda),
      includeParticipation ? formatPercent(participation) : row.escala_moeda,
    ];
  });
}

function chartPointValues(data, metricKey, company) {
  return data.periods.map((period) => metricValue(data, company, period, metricKey));
}

function chartNumber(value) {
  if (value === null || !Number.isFinite(value)) return '—';
  const abs = Math.abs(value);
  if (abs >= 1_000_000_000) return `${formatNumber(value / 1_000_000_000, 1)} bi`;
  if (abs >= 1_000_000) return `${formatNumber(value / 1_000_000, 1)} mi`;
  if (abs >= 1_000) return `${formatNumber(value / 1_000, 1)} mil`;
  return formatNumber(value, 0);
}

export function chartLegendRows(doc, series, chartWidth) {
  doc.font('Helvetica').fontSize(7);
  const lineHeight = doc.heightOfString('Ag', { lineGap: 1 });
  const rows = [];
  let current = { items: [], width: 0, height: lineHeight };

  for (const [index, item] of series.entries()) {
    const label = item.company.codigo_negociacao || item.company.denom_cia;
    const lines = wrapTextToWidth(doc, label, chartWidth - 18);
    const textWidth = Math.max(...lines.map((line) => doc.widthOfString(line)));
    const width = Math.min(chartWidth, Math.max(108, textWidth + 18));
    if (current.items.length && current.width + 8 + width > chartWidth) {
      rows.push(current);
      current = { items: [], width: 0, height: lineHeight };
    }
    current.items.push({
      label,
      lines,
      width,
      height: Math.max(lineHeight, lines.length * lineHeight),
      color: CHART_COLORS[index % CHART_COLORS.length],
    });
    current.width += (current.items.length > 1 ? 8 : 0) + width;
    current.height = Math.max(current.height, lines.length * lineHeight);
  }
  if (current.items.length) rows.push(current);
  return { rows, lineHeight };
}

function drawTrendChart(doc, data, metricKey, title, section) {
  const allSeries = data.companies.map((company) => ({
    company,
    values: chartPointValues(data, metricKey, company),
  })).filter((series) => series.values.some((value) => value !== null));
  const sortedSeries = [...allSeries].sort((a, b) =>
    Math.abs(b.values.at(-1) ?? 0) - Math.abs(a.values.at(-1) ?? 0));
  const visibleSeries = sortedSeries.slice(0, 6);
  const chartWidth = doc.page.width - 2 * MARGIN;
  const legend = chartLegendRows(doc, visibleSeries, chartWidth);
  const legendYFromTop = 28 + 90 + 18;
  const legendHeight = legend.rows.reduce((height, row) => height + row.height, 0)
    + Math.max(0, legend.rows.length - 1) * 4;
  const noteHeight = allSeries.length > visibleSeries.length ? 12 : 0;
  const contentHeight = allSeries.length && data.periods.length
    ? Math.max(CHART_HEIGHT,
    legendYFromTop + legendHeight + (legend.rows.length ? 6 : 0) + noteHeight + 4)
    : CHART_HEIGHT;
  ensureSpace(doc, contentHeight + 12, section);
  const chartX = MARGIN;
  const chartY = doc.y;
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10)
    .text(title, chartX, chartY, { lineBreak: false });
  const plotX = chartX + 54;
  const plotY = chartY + 28;
  const plotWidth = chartWidth - 68;
  const plotHeight = 90;
  if (!allSeries.length || !data.periods.length) {
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
      .text('Sem valores comparáveis para desenhar este gráfico.', chartX, plotY + 35);
    doc.y = chartY + CHART_HEIGHT;
    return;
  }
  const values = visibleSeries.flatMap((series) => series.values.filter((value) => value !== null));
  let min = Math.min(0, ...values);
  let max = Math.max(0, ...values);
  if (min === max) {
    min -= 1;
    max += 1;
  } else {
    const padding = (max - min) * 0.08;
    min -= padding;
    max += padding;
  }
  doc.save();
  for (let tick = 0; tick <= 4; tick += 1) {
    const value = max - ((max - min) * tick / 4);
    const y = plotY + (plotHeight * tick / 4);
    doc.moveTo(plotX, y).lineTo(plotX + plotWidth, y)
      .strokeColor(COLORS.line).lineWidth(0.45).stroke();
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.5)
      .text(chartNumber(value), chartX, y - 4, { width: 47, align: 'right', lineBreak: false });
  }
  const xPosition = (index) => data.periods.length === 1
    ? plotX + plotWidth / 2
    : plotX + (plotWidth * index / (data.periods.length - 1));
  const yPosition = (value) => plotY + (max - value) / (max - min) * plotHeight;
  const labelStep = Math.max(1, Math.ceil(data.periods.length / 8));
  data.periods.forEach((period, index) => {
    if (index % labelStep !== 0 && index !== data.periods.length - 1) return;
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(6.5)
      .text(String(period.periodo), xPosition(index) - 22, plotY + plotHeight + 5, {
        width: 44,
        align: 'center',
        lineBreak: false,
      });
  });
  visibleSeries.forEach((series, seriesIndex) => {
    let drawing = false;
    series.values.forEach((value, index) => {
      if (value === null) {
        drawing = false;
        return;
      }
      const x = xPosition(index);
      const y = yPosition(value);
      if (drawing) doc.lineTo(x, y);
      else doc.moveTo(x, y);
      drawing = true;
    });
    doc.strokeColor(CHART_COLORS[seriesIndex % CHART_COLORS.length])
      .lineWidth(1.7)
      .stroke();
  });
  doc.restore();

  let legendY = chartY + legendYFromTop;
  for (const row of legend.rows) {
    let legendX = chartX;
    for (const item of row.items) {
      doc.save();
      doc.moveTo(legendX, legendY + Math.min(5, row.height / 2))
        .lineTo(legendX + 9, legendY + Math.min(5, row.height / 2))
        .strokeColor(item.color).lineWidth(2).stroke();
      doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7)
        .text(item.lines.join('\n'), legendX + 13, legendY, {
          width: item.width - 13,
          height: item.height,
          lineGap: 1,
          ellipsis: false,
        });
      doc.restore();
      legendX += item.width + 8;
    }
    legendY += row.height + 4;
  }
  if (allSeries.length > visibleSeries.length) {
    doc.fillColor(COLORS.muted).font('Helvetica-Oblique').fontSize(7)
      .text(`Gráfico: 6 empresas com maior valor absoluto no período final; tabela completa inclui ${allSeries.length}.`,
        chartX, legendY + 2, { width: chartWidth, lineBreak: false });
  }
  doc.y = chartY + contentHeight;
  doc.moveDown(0.3);
}

function drawAccountSection(doc, data, { title, description, prefix, metricKey, chart = true, expenses = false }) {
  startSection(doc, title, description, chart && metricKey ? CHART_HEIGHT + 12 : 42);
  if (chart && metricKey) drawTrendChart(doc, data, metricKey, `Evolução — ${title.replace(/^\d+\.\s*/, '')}`, title);

  const accountRows = rowsForPrefix(data, prefix, {
    directOnly: !data.params.includeDetails,
  });
  const tableRows = accountTableRows(data, accountRows, prefix);
  drawTable(doc, [
    { title: 'Período', width: 50 },
    { title: 'Empresa', width: 65 },
    { title: 'Código', width: 52 },
    { title: 'Classificação contábil (descrição original)', width: 176 },
    { title: 'Valor normalizado', width: 100, align: 'right' },
    { title: 'Participação*', width: 72, align: 'right' },
  ], tableRows, title);
  if (expenses && data.params.includeDetails) {
    drawParagraph(doc,
      '* Participação calculada sobre a rubrica 3.04 para cada empresa e período. Cada conta mantém seu código e descrição original; contas não são reclassificadas nem somadas entre si.',
      title,
      { fontSize: 7.5, color: COLORS.muted });
    drawExpenseChart(doc, data, accountRows, title);
  } else {
    drawParagraph(doc,
      data.params.includeDetails
        ? '* Participação de cada subconta calculada sobre o total da rubrica indicada. As linhas de totais e subcontas são apresentadas separadamente e não devem ser somadas entre níveis.'
        : '* A visão principal usa o valor reportado na conta sintética; quando ausente, consolida os descendentes disponíveis sem somar pais e filhos.',
      title,
      { fontSize: 7.5, color: COLORS.muted });
  }
}

function drawExpenseChart(doc, data, rows, section) {
  const latest = data.latestPeriod;
  const latestRows = rows.filter((row) => latest
    && row.dt_fim_exerc === latest.dt_fim_exerc
    && row.cd_conta !== '3.04');
  const ranked = latestRows
    .map((row) => ({
      label: `${rowCompanyName(data, row)} · ${row.cd_conta} ${row.ds_conta_empresa}`,
      value: row.valor_normalizado,
    }))
    .sort((a, b) => Math.abs(b.value) - Math.abs(a.value))
    .slice(0, 8);
  if (!ranked.length) return;
  ensureSpace(doc, 50 + ranked.length * 18, section);
  const startY = doc.y;
  const width = doc.page.width - 2 * MARGIN;
  doc.fillColor(COLORS.ink).font('Helvetica-Bold').fontSize(10)
    .text(`Contas operacionais no período final (${latest.periodo})`, MARGIN, startY);
  const chartY = startY + 20;
  const labelWidth = 205;
  const barX = MARGIN + labelWidth;
  const valueWidth = 78;
  const barWidth = width - labelWidth - valueWidth - 6;
  const max = Math.max(1, ...ranked.map((item) => Math.abs(item.value)));
  ranked.forEach((item, index) => {
    const y = chartY + index * 18;
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7)
      .text(item.label, MARGIN, y + 4, { width: labelWidth - 8, ellipsis: true, lineBreak: false });
    doc.save();
    doc.roundedRect(barX, y + 3, barWidth, 8, 3).fill(COLORS.pale);
    doc.roundedRect(barX, y + 3, Math.max(2, barWidth * Math.abs(item.value) / max), 8, 3)
      .fill(item.value < 0 ? COLORS.coral : COLORS.green);
    doc.restore();
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(7)
      .text(formatMoney(item.value, data.currencies[0]), barX + barWidth + 5, y + 4, {
        width: valueWidth - 5,
        align: 'right',
        lineBreak: false,
        ellipsis: true,
      });
  });
  doc.y = chartY + ranked.length * 18 + 8;
  if (latestRows.length > ranked.length) {
    drawParagraph(doc, `Gráfico limitado às 8 contas com maior valor absoluto; a tabela acima mantém todas as rubricas do recorte.`,
      section, { fontSize: 7.5, color: COLORS.muted });
  }
}

function financialRootCodes(data) {
  const roots = new Map();
  for (const period of data.periods) {
    for (const company of data.companies) {
      const row = metricRow(data, company, period, 'financialResult');
      if (row) roots.set(`${company.id_empresa}|${period.dt_fim_exerc}`, row.cd_conta);
    }
  }
  return roots;
}

function drawFinancialResultSection(doc, data) {
  startSection(doc, '6. Análise do resultado financeiro',
    'Receitas, despesas e resultado financeiro são exibidos somente quando há rubricas correspondentes na DRE selecionada.',
    CHART_HEIGHT + 12);
  drawTrendChart(doc, data, 'financialResult', 'Resultado financeiro por período', 'Análise do resultado financeiro');

  const rootCodes = financialRootCodes(data);
  const rows = data.rows.filter((row) => {
    const rootCode = rootCodes.get(`${row.id_empresa}|${row.dt_fim_exerc}`);
    const code = accountCode(row, data.mode);
    return rootCode && (code === rootCode
      || (code.startsWith(`${rootCode}.`)
        && (data.params.includeDetails
          || code.split('.').length === rootCode.split('.').length + 1)));
  }).sort((a, b) => a.dt_fim_exerc.localeCompare(b.dt_fim_exerc)
    || rowCompanyName(data, a).localeCompare(rowCompanyName(data, b))
    || a.cd_conta.localeCompare(b.cd_conta));
  const tableRows = rows.map((row) => [
    row.periodo,
    rowCompanyName(data, row),
    accountCode(row, data.mode),
    accountDescription(row, data.mode),
    formatMoney(row.valor_normalizado, row.moeda),
  ]);
  drawTable(doc, [
    { title: 'Período', width: 55 },
    { title: 'Empresa', width: 75 },
    { title: 'Código', width: 55 },
    { title: 'Classificação contábil (descrição original)', width: 225 },
    { title: 'Valor normalizado', width: 105, align: 'right' },
  ], tableRows, 'Análise do resultado financeiro');
}

function drawComparativeSection(doc, data) {
  startSection(doc, '7. Análise comparativa',
    'Comparação por empresa e período, sem consolidar valores entre companhias. Percentuais de custos/despesas usam a magnitude da rubrica dividida pela receita.',
    55);
  if (!data.latestPeriod) {
    drawParagraph(doc, 'Não há dados suficientes para uma comparação no recorte selecionado.', 'Análise comparativa');
    return;
  }
  const period = data.latestPeriod;
  const tableRows = data.companies.map((company) => {
    const revenue = metricValue(data, company, period, 'revenue');
    const costs = metricValue(data, company, period, 'costs');
    const operating = metricValue(data, company, period, 'operatingExpenses');
    const gross = metricValue(data, company, period, 'gross');
    const costRatio = revenue && costs !== null ? formatPercent(Math.abs(costs / revenue) * 100) : '—';
    const operatingRatio = revenue && operating !== null
      ? formatPercent(Math.abs(operating / revenue) * 100)
      : '—';
    return [
      company.codigo_negociacao || company.denom_cia,
      formatMoney(revenue, data.currencies[0]),
      formatMoney(costs, data.currencies[0]),
      formatMoney(gross, data.currencies[0]),
      costRatio,
      operatingRatio,
    ];
  });
  drawParagraph(doc, `Indicadores do período final ${period.periodo}; custos referem-se à rubrica 3.02 e despesas/receitas operacionais à rubrica 3.04, quando presentes.`, 'Análise comparativa');
  drawTable(doc, [
    { title: 'Empresa', width: 90 },
    { title: 'Receita 3.01', width: 88, align: 'right' },
    { title: 'Custos 3.02', width: 88, align: 'right' },
    { title: 'Resultado bruto', width: 88, align: 'right' },
    { title: 'Custos/receita', width: 75, align: 'right' },
    { title: 'Rubrica 3.04/receita', width: 86, align: 'right' },
  ], tableRows, 'Análise comparativa');
  drawTrendChart(doc, data, 'revenue', 'Evolução da receita total por empresa', 'Análise comparativa');
}

function drawFullDetail(doc, data) {
  const detailRows = data.params.includeDetails ? data.sourceRows : data.rows;
  startSection(doc,
    data.params.includeDetails ? '8. Detalhamento da base financeira' : '8. Contas principais consolidadas',
    data.params.includeDetails
      ? 'Registros retornados pela mesma consulta do dashboard. Valores e escalas nesta seção permanecem conforme reportados na base.'
      : 'Contas principais por empresa e período; usa o valor reportado na conta sintética ou consolida os descendentes mais próximos quando o valor principal não existe.',
    42);
  const tableRows = detailRows.map((row) => [
    row.periodo,
    rowCompanyName(data, row),
    row.cd_conta,
    row.ds_conta_empresa,
    formatNumber(row.vl_conta),
    row.escala_moeda,
    row.moeda,
  ]);
  drawTable(doc, [
    { title: 'Período', width: 48 },
    { title: 'Empresa', width: 54 },
    { title: 'Código', width: 48 },
    { title: 'Conta (descrição original)', width: 175 },
    { title: 'Valor reportado', width: 78, align: 'right' },
    { title: 'Escala', width: 62 },
    { title: 'Moeda', width: 50 },
  ], tableRows, 'Detalhamento da base financeira');
}

function drawCover(doc, data) {
  const { width, height } = doc.page;
  doc.save();
  doc.rect(0, 0, width, 310).fill(COLORS.greenDark);
  doc.rect(0, 0, 11, height).fill(COLORS.green);
  doc.fillColor('#c9ef77').font('Helvetica-Bold').fontSize(9)
    .text('ANALYTICS FINANCEIRA', MARGIN + 12, 72, { characterSpacing: 1.1 });
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(30)
    .text('Relatório de\\nAnálise Financeira', MARGIN + 12, 112, {
      width: width - 2 * MARGIN - 24,
      lineGap: 4,
    });
  doc.fillColor('#e5f0e8').font('Helvetica').fontSize(12)
    .text(data.companies.length === 1
      ? companyName(data.companies[0])
      : `Análise comparativa · ${data.companies.length} empresas`,
    MARGIN + 12, 220, { width: width - 2 * MARGIN - 24, ellipsis: true });
  doc.fillColor('#d2dfd5').font('Helvetica').fontSize(9)
    .text(`Período: ${shortDateRange(data)}   ·   Modalidade: ${data.params.grupoDfp ?? data.analysis.grupoDfp}`,
      MARGIN + 12, 251, { width: width - 2 * MARGIN - 24, ellipsis: true });

  let y = 365;
  const coverCriteria = [
    ['Tipo de período', data.params.tipoPeriodo ?? data.analysis.tipoPeriodo],
    ['Conta de referência', data.params.accountCode ?? 'Não informada'],
    ['Setor', criteriaValue(data, 'setor', 'setor')],
    ['Subsetor', criteriaValue(data, 'subsetor', 'subsetor')],
    ['Segmento', criteriaValue(data, 'segmento', 'segmento')],
    ['Gerado em', new Intl.DateTimeFormat('pt-BR', {
      dateStyle: 'long',
      timeStyle: 'short',
    }).format(data.generatedAt)],
  ];
  for (const [label, value] of coverCriteria) {
    doc.fillColor(COLORS.muted).font('Helvetica-Bold').fontSize(8).text(label.toLocaleUpperCase('pt-BR'), MARGIN + 12, y);
    doc.fillColor(COLORS.ink).font('Helvetica').fontSize(10)
      .text(String(value ?? 'Não informado'), MARGIN + 12, y + 13, {
        width: width - 2 * MARGIN - 25,
        ellipsis: true,
      });
    y += 52;
  }
  doc.fillColor(COLORS.muted).font('Helvetica').fontSize(8)
    .text(`Última atualização persistida: ${data.lastUpdate ?? 'não disponível'}`,
      MARGIN + 12, height - 75);
  doc.restore();
}

function addPageNumbers(doc) {
  const pages = doc.bufferedPageRange();
  for (let index = pages.start; index < pages.start + pages.count; index += 1) {
    doc.switchToPage(index);
    const { width, height } = doc.page;
    const y = height - 42;
    doc.save();
    doc.moveTo(MARGIN, y - 7).lineTo(width - MARGIN, y - 7)
      .strokeColor(COLORS.line).lineWidth(0.5).stroke();
    doc.fillColor(COLORS.muted).font('Helvetica').fontSize(7)
      .text('Analytics Financeira · Relatório gerado a partir da base SQLite',
        MARGIN, y, { width: width - 2 * MARGIN - 80, lineBreak: false });
    doc.text(`Página ${index + 1} de ${pages.count}`,
      width - MARGIN - 75, y, { width: 75, align: 'right', lineBreak: false });
    doc.restore();
  }
}

export function generateFinancialReportPdf(data) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 52, bottom: PDF_BOTTOM_MARGIN, left: MARGIN, right: MARGIN },
      bufferPages: true,
      info: {
        Title: 'Relatório de Análise Financeira',
        Author: 'Analytics Financeira',
        Subject: 'Relatório analítico baseado em dados financeiros SQLite',
      },
    });
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('error', reject);
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    try {
      drawCover(doc, data);
      drawExecutiveSummary(doc, data);
      drawCriteria(doc, data);
      drawAccountSection(doc, data, {
        title: '3. Análise de receitas',
        description: data.params.includeDetails
          ? 'Receita pela rubrica 3.01 e suas contas subordinadas, preservando códigos e descrições do plano de contas.'
          : 'Valor principal da receita pela hierarquia de contas da empresa.',
        prefix: '3.01',
        metricKey: 'revenue',
      });
      drawAccountSection(doc, data, {
        title: '4. Análise de custos',
        description: data.params.includeDetails
          ? 'Custos pela rubrica 3.02 e suas contas subordinadas, preservando os valores reportados.'
          : 'Valor principal dos custos pela hierarquia de contas da empresa.',
        prefix: '3.02',
        metricKey: 'costs',
      });
      drawAccountSection(doc, data, {
        title: '5. Análise de despesas',
        description: data.params.includeDetails
          ? 'Rubrica 3.04 e suas contas subordinadas, preservando códigos e classificações contábeis originais.'
          : 'Valor principal das despesas pela hierarquia de contas da empresa.',
        prefix: '3.04',
        metricKey: 'operatingExpenses',
        expenses: true,
      });
      drawFinancialResultSection(doc, data);
      drawComparativeSection(doc, data);
      drawFullDetail(doc, data);
      addPageNumbers(doc);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

export async function createFinancialReportPdf(database, mode, params = {}) {
  const report = buildFinancialReportData(database, mode, params);
  return generateFinancialReportPdf(report);
}

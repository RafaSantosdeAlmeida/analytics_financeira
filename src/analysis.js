import { scaleMultiplier } from './ingestion.js';

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(', ');
}

function selectedCompanyIds(value) {
  const source = Array.isArray(value) ? value : String(value ?? '').split(',');
  return [...new Set(source.map(Number).filter((id) => Number.isInteger(id) && id > 0))];
}

function filterParameters(filters) {
  return [
    filters.setor ?? '', filters.setor ?? '',
    filters.subsetor ?? '', filters.subsetor ?? '',
    filters.segmento ?? '', filters.segmento ?? '',
  ];
}

export function getFilterOptions(database, filters = {}) {
  const hierarchy = database.prepare(`
    SELECT DISTINCT st.nome_setor AS setor,
      ss.nome_subsetor AS subsetor, sg.nome_segmento AS segmento
    FROM setor st
    LEFT JOIN subsetor ss ON ss.id_setor = st.id_setor
    LEFT JOIN segmento sg ON sg.id_subsetor = ss.id_subsetor
    ORDER BY st.nome_setor, ss.nome_subsetor, sg.nome_segmento
  `).all();
  const companies = database.prepare(`
    SELECT e.id_empresa, e.cnpj_cia, e.denom_cia, e.cd_cvm, e.codigo_negociacao,
      st.nome_setor AS setor, ss.nome_subsetor AS subsetor, sg.nome_segmento AS segmento
    FROM empresas e
    JOIN segmento sg ON sg.id_segmento = e.id_segmento
    JOIN subsetor ss ON ss.id_subsetor = sg.id_subsetor
    JOIN setor st ON st.id_setor = ss.id_setor
    WHERE (? = '' OR st.nome_setor = ?)
      AND (? = '' OR ss.nome_subsetor = ?)
      AND (? = '' OR sg.nome_segmento = ?)
    ORDER BY e.denom_cia
  `).all(...filterParameters(filters));
  const periodTypes = database.prepare(`
    SELECT DISTINCT p.tipo_periodo
    FROM periodos p
    JOIN demonstracao_financeira d ON d.id_periodo = p.id_periodo
    ORDER BY p.tipo_periodo
  `).all().map((row) => row.tipo_periodo);
  const groups = database.prepare(`
    SELECT DISTINCT grupo_dfp FROM demonstracao_financeira ORDER BY grupo_dfp
  `).all().map((row) => row.grupo_dfp);
  const periods = filters.tipoPeriodo
    ? database.prepare(`
        SELECT DISTINCT p.periodo, p.dt_fim_exerc
        FROM periodos p
        JOIN demonstracao_financeira d ON d.id_periodo = p.id_periodo
        WHERE p.tipo_periodo = ? AND (? = '' OR d.grupo_dfp = ?)
        ORDER BY p.dt_fim_exerc
      `).all(filters.tipoPeriodo, filters.grupoDfp ?? '', filters.grupoDfp ?? '')
    : [];

  let accounts = [];
  if (filters.mode === 'individual' && filters.companyId) {
    accounts = database.prepare(`
      SELECT DISTINCT p.cd_conta, p.nivel_conta, p.ds_conta_empresa AS descricao
      FROM plano_conta_empresa p
      WHERE p.id_empresa = ?
      ORDER BY p.cd_conta
    `).all(Number(filters.companyId));
  } else if (filters.mode === 'comparative' && filters.segmento) {
    const segmentId = findSegmentId(database, filters);
    if (segmentId) {
      accounts = database.prepare(`
        SELECT DISTINCT p.cd_conta, p.nivel_conta, p.ds_conta_segmento AS descricao
        FROM plano_conta_segmento p
        WHERE p.id_segmento = ? AND p.nivel_conta = 1
        ORDER BY p.cd_conta
      `).all(segmentId);
    }
  }

  return { hierarchy, companies, periodTypes, groups, periods, accounts };
}

function findSegmentId(database, filters) {
  return database.prepare(`
    SELECT sg.id_segmento
    FROM segmento sg
    JOIN subsetor ss ON ss.id_subsetor = sg.id_subsetor
    JOIN setor st ON st.id_setor = ss.id_setor
    WHERE (? = '' OR st.nome_setor = ?)
      AND (? = '' OR ss.nome_subsetor = ?)
      AND sg.nome_segmento = ?
    ORDER BY sg.id_segmento
    LIMIT 1
  `).get(
    filters.setor ?? '', filters.setor ?? '',
    filters.subsetor ?? '', filters.subsetor ?? '', filters.segmento,
  )?.id_segmento;
}

function normalizeValue(value, scale) {
  return value * scaleMultiplier(scale);
}

export function queryAnalysis(database, mode, params = {}) {
  if (!['individual', 'comparative'].includes(mode)) {
    throw new Error('Modo de análise inválido.');
  }

  const companies = selectedCompanyIds(params.companyIds ?? params.companyId);
  if (mode === 'individual' && companies.length !== 1) {
    throw new Error('Selecione uma empresa para a análise individual.');
  }
  if (mode === 'comparative' && companies.length < 2) {
    throw new Error('Selecione pelo menos duas empresas para a análise comparativa.');
  }
  if (params.axisSecondary && (mode !== 'comparative' || companies.length !== 2)) {
    throw new Error('Eixo secundário disponível somente para duas empresas.');
  }
  if (!params.accountCode || !params.tipoPeriodo) {
    throw new Error('Selecione a conta e o tipo de período.');
  }
  if (params.periodStart && params.periodEnd && params.periodStart > params.periodEnd) {
    throw new Error('O início do intervalo não pode ser posterior ao fim.');
  }

  const companyMarks = placeholders(companies.length);
  const rows = database.prepare(`
    SELECT
      e.id_empresa, e.cnpj_cia, e.denom_cia, e.codigo_negociacao,
      st.nome_setor AS setor, ss.nome_subsetor AS subsetor, sg.nome_segmento AS segmento,
      p.periodo, p.tipo_periodo, p.dt_ini_exerc, p.dt_fim_exerc,
      d.grupo_dfp, d.dt_refer, d.versao, d.ordem_exerc,
      pc.cd_conta, pc.nivel_conta, pc.ds_conta_empresa,
      ps.cd_conta AS cd_conta_segmento, ps.ds_conta_segmento,
      d.moeda, d.escala_moeda, d.vl_conta, d.st_conta_fixa
    FROM demonstracao_financeira d
    JOIN empresas e ON e.id_empresa = d.id_empresa
    JOIN segmento sg ON sg.id_segmento = e.id_segmento
    JOIN subsetor ss ON ss.id_subsetor = sg.id_subsetor
    JOIN setor st ON st.id_setor = ss.id_setor
    JOIN periodos p ON p.id_periodo = d.id_periodo
    JOIN plano_conta_empresa pc ON pc.id_plano_conta_empresa = d.id_plano_conta_empresa
    LEFT JOIN plano_conta_segmento ps ON ps.id_plano_conta_segmento = d.id_plano_conta_segmento
    WHERE e.id_empresa IN (${companyMarks})
      AND p.tipo_periodo = ?
      AND d.grupo_dfp = ?
      AND (? = '' OR p.dt_fim_exerc >= ?)
      AND (? = '' OR p.dt_fim_exerc <= ?)
    ORDER BY p.dt_fim_exerc, e.denom_cia, pc.cd_conta
  `).all(
    ...companies,
    params.tipoPeriodo,
    params.grupoDfp ?? 'CONSOLIDADO',
    params.periodStart ?? '', params.periodStart ?? '',
    params.periodEnd ?? '', params.periodEnd ?? '',
  );

  const currencies = [...new Set(rows.map((row) => row.moeda))];
  if (mode === 'comparative' && currencies.length > 1) {
    const error = new Error('Não é possível comparar moedas diferentes sem conversão cambial.');
    error.statusCode = 409;
    throw error;
  }

  const mappedRows = rows.map((row) => ({
    ...row,
    valor_normalizado: normalizeValue(row.vl_conta, row.escala_moeda),
  }));
  const lineRows = mappedRows.filter((row) => mode === 'individual'
    ? row.cd_conta === params.accountCode
    : row.cd_conta_segmento === params.accountCode);
  const latestDate = mappedRows.reduce(
    (latest, row) => row.dt_fim_exerc > latest ? row.dt_fim_exerc : latest,
    '',
  );
  const barRows = mappedRows.filter((row) => row.dt_fim_exerc === latestDate
    && (mode === 'individual'
      || (row.cd_conta_segmento !== null && row.cd_conta === row.cd_conta_segmento)));
  const companyNames = new Map(companies.map((id) => {
    const company = rows.find((row) => row.id_empresa === id);
    return [id, company?.codigo_negociacao || company?.denom_cia || `Empresa ${id}`];
  }));
  const seriesByCompany = new Map();

  for (const row of lineRows) {
    if (!seriesByCompany.has(row.id_empresa)) {
      seriesByCompany.set(row.id_empresa, {
        idEmpresa: row.id_empresa,
        label: companyNames.get(row.id_empresa),
        data: [],
      });
    }
    seriesByCompany.get(row.id_empresa).data.push({
      x: row.dt_fim_exerc,
      y: row.valor_normalizado,
      periodo: row.periodo,
    });
  }

  const bars = barRows.map((row) => ({
    idEmpresa: row.id_empresa,
    empresa: companyNames.get(row.id_empresa),
    cdConta: row.cd_conta,
    descricao: mode === 'individual' ? row.ds_conta_empresa : row.ds_conta_segmento,
    moeda: row.moeda,
    escala: row.escala_moeda,
    valor: row.vl_conta,
    valorNormalizado: row.valor_normalizado,
  }));

  return {
    mode,
    accountCode: params.accountCode,
    tipoPeriodo: params.tipoPeriodo,
    grupoDfp: params.grupoDfp ?? 'CONSOLIDADO',
    moeda: currencies[0] ?? null,
    eixoSecundario: Boolean(params.axisSecondary),
    dataBarras: latestDate || null,
    series: [...seriesByCompany.values()],
    barras: bars,
    linhas: mappedRows,
  };
}
import { parse } from 'csv-parse/sync';

const layouts = [
  {
    type: 'EMPRESAS',
    required: ['CNPJ', 'NOME_EMPRESA', 'CODIGO', 'SETOR', 'SUBSETOR', 'SEGMENTO'],
  },
  {
    type: 'SETOR_SUBSETOR_SEGMENTO',
    required: ['SETOR', 'SUBSETOR', 'SEGMENTO'],
  },
  {
    type: 'PLANO_CONTA_EMPRESA',
    required: ['CNPJ_CIA', 'CD_CONTA', 'NIVEL_CONTA', 'DS_CONTA_EMPRESA'],
  },
  {
    type: 'PLANO_CONTA_SEGMENTO',
    required: [
      'SETOR',
      'SUBSETOR',
      'SEGMENTO',
      'CD_CONTA',
      'NIVEL_CONTA',
      'DS_CONTA_SEGMENTO',
    ],
  },
  {
    type: 'DFP_DRE',
    required: [
      'CNPJ_CIA',
      'DT_REFER',
      'VERSAO',
      'DENOM_CIA',
      'CD_CVM',
      'GRUPO_DFP',
      'MOEDA',
      'ESCALA_MOEDA',
      'ORDEM_EXERC',
      'DT_INI_EXERC',
      'DT_FIM_EXERC',
      'CD_CONTA',
      'DS_CONTA',
      'VL_CONTA',
      'ST_CONTA_FIXA',
    ],
  },
];

const requiredTextByType = {
  EMPRESAS: ['cnpj_origem', 'denom_cia', 'codigo_negociacao', 'setor', 'subsetor', 'segmento'],
  SETOR_SUBSETOR_SEGMENTO: ['setor', 'subsetor', 'segmento'],
  PLANO_CONTA_EMPRESA: ['cnpj_origem', 'cd_conta', 'ds_conta_empresa'],
  PLANO_CONTA_SEGMENTO: ['setor', 'subsetor', 'segmento', 'cd_conta', 'ds_conta_segmento'],
  DFP_DRE: [
    'cnpj_cia_origem',
    'dt_refer',
    'denom_cia',
    'cd_cvm',
    'grupo_dfp_origem',
    'moeda',
    'escala_moeda',
    'ordem_exerc_origem',
    'dt_ini_exerc',
    'dt_fim_exerc',
    'cd_conta',
    'ds_conta',
    'vl_conta_origem',
    'st_conta_fixa_origem',
  ],
};

function normalizeHeader(value) {
  return String(value).replace(/^\uFEFF/, '').trim().toUpperCase();
}

function detectDelimiter(headerLine) {
  let commas = 0;
  let semicolons = 0;
  let quoted = false;

  for (let index = 0; index < headerLine.length; index += 1) {
    const character = headerLine[index];
    if (character === '"') {
      if (quoted && headerLine[index + 1] === '"') {
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (!quoted && character === ',') {
      commas += 1;
    } else if (!quoted && character === ';') {
      semicolons += 1;
    }
  }

  if (commas === semicolons) {
    throw new Error('Não foi possível identificar o delimitador do CSV.');
  }
  return commas > semicolons ? ',' : ';';
}

function decodeBuffer(buffer) {
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
    return { text, encoding: buffer[0] === 0xef ? 'utf-8-sig' : 'utf-8' };
  } catch {
    return { text: new TextDecoder('windows-1252').decode(buffer), encoding: 'windows-1252' };
  }
}

function identifyLayout(headers) {
  const headerSet = new Set(headers);
  const matches = layouts.filter((layout) =>
    layout.required.every((column) => headerSet.has(column)),
  ).sort((left, right) => right.required.length - left.required.length);

  if (!matches.length || matches[0].required.length === matches[1]?.required.length) {
    throw new Error('O cabeçalho não corresponde a um dos cinco layouts CSV aceitos.');
  }
  return matches[0];
}

function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function validDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function classifyPeriod(start, end) {
  if (!validDate(start) || !validDate(end) || start > end) return null;

  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);
  const days = (endDate - startDate) / 86_400_000;
  const endMonth = end.slice(5, 7);
  const endDay = end.slice(8, 10);
  const quarter = { '03-31': 1, '06-30': 2, '09-30': 3, '12-31': 4 }[
    `${endMonth}-${endDay}`
  ];

  if (days >= 330) return { type: 'ANUAL', period: end.slice(0, 4) };
  if (!quarter) return null;

  const yearStart = `${end.slice(0, 4)}-01-01`;
  const type = start === yearStart && quarter > 1
    ? 'TRIMESTRAL_ACUMULADO'
    : 'TRIMESTRAL';
  return { type, period: `${quarter}T${end.slice(0, 4)}` };
}

function parseInteger(value) {
  const normalized = String(value ?? '').trim();
  if (!/^\d+$/.test(normalized)) return null;
  return Number(normalized);
}

export function stageRow(type, source) {
  const value = (key) => String(source[key] ?? '').trim();
  let data;

  switch (type) {
    case 'EMPRESAS':
      data = {
        ...source,
        cnpj_origem: value('CNPJ'),
        cnpj_cia: digitsOnly(value('CNPJ')),
        denom_cia: value('NOME_EMPRESA'),
        codigo_negociacao: value('CODIGO'),
        setor: value('SETOR'),
        subsetor: value('SUBSETOR'),
        segmento: value('SEGMENTO'),
      };
      break;
    case 'SETOR_SUBSETOR_SEGMENTO':
      data = {
        ...source,
        setor: value('SETOR'),
        subsetor: value('SUBSETOR'),
        segmento: value('SEGMENTO'),
      };
      break;
    case 'PLANO_CONTA_EMPRESA':
      data = {
        ...source,
        cnpj_origem: value('CNPJ_CIA'),
        cnpj_cia: digitsOnly(value('CNPJ_CIA')),
        cd_conta: value('CD_CONTA'),
        nivel_conta: parseInteger(value('NIVEL_CONTA')),
        ds_conta_empresa: value('DS_CONTA_EMPRESA'),
      };
      break;
    case 'PLANO_CONTA_SEGMENTO':
      data = {
        ...source,
        setor: value('SETOR'),
        subsetor: value('SUBSETOR'),
        segmento: value('SEGMENTO'),
        cd_conta: value('CD_CONTA'),
        nivel_conta: parseInteger(value('NIVEL_CONTA')),
        ds_conta_segmento: value('DS_CONTA_SEGMENTO'),
      };
      break;
    case 'DFP_DRE': {
      const period = classifyPeriod(value('DT_INI_EXERC'), value('DT_FIM_EXERC'));
      const group = value('GRUPO_DFP').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
        .toUpperCase();
      const fixed = value('ST_CONTA_FIXA').toUpperCase();
      data = {
        ...source,
        cnpj_cia_origem: value('CNPJ_CIA'),
        cnpj_cia: digitsOnly(value('CNPJ_CIA')),
        dt_refer: value('DT_REFER'),
        versao: parseInteger(value('VERSAO')),
        denom_cia: value('DENOM_CIA'),
        cd_cvm: value('CD_CVM'),
        grupo_dfp_origem: value('GRUPO_DFP'),
        grupo_dfp: group.includes('CONSOLIDADO')
          ? 'CONSOLIDADO'
          : group.includes('INDIVIDUAL')
            ? 'INDIVIDUAL'
            : null,
        moeda: value('MOEDA'),
        escala_moeda: value('ESCALA_MOEDA').toUpperCase(),
        ordem_exerc_origem: value('ORDEM_EXERC'),
        ordem_exerc: groupOrder(value('ORDEM_EXERC')),
        dt_ini_exerc: value('DT_INI_EXERC'),
        dt_fim_exerc: value('DT_FIM_EXERC'),
        cd_conta: value('CD_CONTA'),
        ds_conta: value('DS_CONTA'),
        vl_conta_origem: value('VL_CONTA'),
        vl_conta: Number(value('VL_CONTA')),
        st_conta_fixa_origem: value('ST_CONTA_FIXA'),
        st_conta_fixa: fixed === 'S' ? 1 : fixed === 'N' ? 0 : null,
        tipo_periodo: period?.type ?? null,
        periodo: period?.period ?? null,
      };
      break;
    }
    default:
      throw new Error(`Layout não suportado: ${type}`);
  }

  const errors = [];
  for (const field of requiredTextByType[type]) {
    if (!data[field]) errors.push(`${field} vazio`);
  }

  if (['EMPRESAS', 'PLANO_CONTA_EMPRESA', 'DFP_DRE'].includes(type)
      && data.cnpj_cia?.length !== 14) {
    errors.push('CNPJ deve conter 14 dígitos');
  }

  if (type === 'PLANO_CONTA_EMPRESA' || type === 'PLANO_CONTA_SEGMENTO') {
    if (!data.nivel_conta || data.nivel_conta < 1) errors.push('nível da conta inválido');
    if (!/^\d+(?:\.\d+)+$/.test(data.cd_conta)) errors.push('código da conta inválido');
    if (data.nivel_conta !== data.cd_conta.split('.').length - 1) {
      errors.push('nível da conta não corresponde ao código');
    }
  }

  if (type === 'DFP_DRE') {
    if (!validDate(data.dt_refer)) errors.push('data de referência inválida');
    if (!data.versao || data.versao < 1) errors.push('versão inválida');
    if (!data.grupo_dfp) errors.push('grupo DFP deve indicar individual ou consolidado');
    if (!data.tipo_periodo) errors.push('intervalo não corresponde a período anual/trimestral');
    if (data.ordem_exerc !== 'ULTIMO') {
      errors.push('ordem_exerc deve ser ULTIMO para persistir a demonstração financeira');
    }
    if (!Number.isFinite(data.vl_conta)) errors.push('valor da conta inválido');
    if (data.st_conta_fixa === null) errors.push('indicador de conta fixa deve ser S ou N');
    if (!/^\d+(?:\.\d+)+$/.test(data.cd_conta)) errors.push('código da conta inválido');
  }

  return { data, status: errors.length ? 'INVALIDO' : 'VALIDO', error: errors.join('; ') || null };
}

function groupOrder(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toUpperCase();
}

export function parseAndStageCsv(buffer) {
  if (!buffer?.length) throw new Error('O arquivo enviado está vazio.');

  const { text, encoding } = decodeBuffer(buffer);
  const headerLine = text.split(/\r?\n/, 1)[0] ?? '';
  const delimiter = detectDelimiter(headerLine);
  let records;

  try {
    records = parse(text, {
      bom: true,
      columns: (headers) => headers.map(normalizeHeader),
      delimiter,
      skip_empty_lines: true,
      relax_column_count: false,
      relax_quotes: true,
    });
  } catch (error) {
    throw new Error(`CSV inválido: ${error.message}`);
  }

  const headers = records.columns ?? Object.keys(records[0] ?? {});
  const layout = identifyLayout(headers.map(normalizeHeader));
  const stagedRows = records.map((record) => stageRow(layout.type, record));

  return {
    type: layout.type,
    delimiter,
    encoding,
    records,
    stagedRows,
  };
}

export function scaleMultiplier(scale) {
  const normalized = String(scale ?? '').normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '').toUpperCase();
  if (normalized.includes('MILHAO')) return 1_000_000;
  if (normalized === 'MIL' || normalized.includes('MILHAR')) return 1_000;
  return 1;
}
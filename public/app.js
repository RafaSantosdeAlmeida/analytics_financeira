const palette = ['#176b53', '#e47d61', '#477a99', '#d7a643', '#745e8b', '#64a58d'];
const analysisHeaders = [
  ['cnpj_cia', 'CNPJ'],
  ['denom_cia', 'Empresa'],
  ['codigo_negociacao', 'Código'],
  ['setor', 'Setor'],
  ['subsetor', 'Subsetor'],
  ['segmento', 'Segmento'],
  ['periodo', 'Período'],
  ['tipo_periodo', 'Tipo de período'],
  ['grupo_dfp', 'Modalidade'],
  ['dt_ini_exerc', 'Início'],
  ['dt_fim_exerc', 'Fim'],
  ['cd_conta', 'Código da conta'],
  ['ds_conta_empresa', 'Conta da empresa'],
  ['cd_conta_segmento', 'Conta do segmento'],
  ['ds_conta_segmento', 'Descrição do segmento'],
  ['moeda', 'Moeda'],
  ['escala_moeda', 'Escala'],
  ['vl_conta', 'Valor'],
  ['st_conta_fixa', 'Fixa'],
];

const state = {
  activeBatchId: null,
  activeBatchLayer: 'raw',
  batches: [],
  analysisParams: { individual: null, comparative: null },
  charts: { individual: {}, comparative: {} },
};

const byId = (id) => document.getElementById(id);

function showToast(message, isError = false) {
  const toast = document.createElement('div');
  toast.className = `toast${isError ? ' is-error' : ''}`;
  toast.textContent = message;
  byId('toast-region').append(toast);
  window.setTimeout(() => toast.remove(), 4800);
}

async function request(url, options = {}) {
  const response = await fetch(url, options);
  const contentType = response.headers.get('content-type') ?? '';
  if (!response.ok) {
    const body = contentType.includes('application/json') ? await response.json() : null;
    throw new Error(body?.error ?? `Falha na solicitação (${response.status}).`);
  }
  return contentType.includes('application/json') ? response.json() : response;
}

function formatNumber(value) {
  if (value === null || value === undefined || value === '') return '—';
  const number = Number(value);
  return Number.isFinite(number)
    ? new Intl.NumberFormat('pt-BR', { maximumFractionDigits: 2 }).format(number)
    : String(value);
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleDateString('pt-BR');
}

function safeCell(value) {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

function makeTable(headers, rows, { statusField = null } = {}) {
  const table = document.createElement('table');
  const head = document.createElement('thead');
  const headerRow = document.createElement('tr');
  for (const header of headers) {
    const cell = document.createElement('th');
    cell.scope = 'col';
    cell.textContent = header.label;
    headerRow.append(cell);
  }
  head.append(headerRow);
  const body = document.createElement('tbody');

  for (const row of rows) {
    const tableRow = document.createElement('tr');
    for (const header of headers) {
      const cell = document.createElement('td');
      const value = row[header.key];
      if (header.key === statusField) {
        const pill = document.createElement('span');
        pill.className = `status-pill status-${value}`;
        pill.textContent = safeCell(value);
        cell.append(pill);
      } else {
        cell.textContent = header.key === 'cd_conta_segmento' && value == null
          ? 'NULL'
          : safeCell(value);
      }
      tableRow.append(cell);
    }
    body.append(tableRow);
  }

  if (!rows.length) {
    const emptyRow = document.createElement('tr');
    const emptyCell = document.createElement('td');
    emptyCell.colSpan = headers.length;
    emptyCell.className = 'empty-state';
    emptyCell.textContent = 'Nenhum registro nesta etapa.';
    emptyRow.append(emptyCell);
    body.append(emptyRow);
  }

  table.append(head, body);
  return table;
}

function renderRawTable(container, rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row.dados ?? {})))];
  const headers = [
    { key: 'numero_linha_origem', label: 'Linha' },
    ...columns.map((key) => ({ key: `dados.${key}`, label: key })),
  ];
  const normalized = rows.map((row) => {
    const output = { numero_linha_origem: row.numero_linha_origem };
    for (const key of columns) output[`dados.${key}`] = row.dados?.[key];
    return output;
  });
  container.replaceChildren(makeTable(headers, normalized));
}

function renderStagingTable(container, rows) {
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row.dados ?? {})))];
  const headers = [
    { key: 'id_raw_linha', label: 'Raw ID' },
    ...columns.map((key) => ({ key: `dados.${key}`, label: key })),
    { key: 'status_validacao', label: 'Status' },
    { key: 'erro_validacao', label: 'Erro de validação' },
  ];
  const normalized = rows.map((row) => {
    const output = {
      id_raw_linha: row.id_raw_linha,
      status_validacao: row.status_validacao,
      erro_validacao: row.erro_validacao,
    };
    for (const key of columns) output[`dados.${key}`] = row.dados?.[key];
    return output;
  });
  container.replaceChildren(makeTable(headers, normalized, { statusField: 'status_validacao' }));
}

function statCard(label, value, isError = false) {
  const card = document.createElement('div');
  card.className = `stat${isError ? ' is-error' : ''}`;
  const labelNode = document.createElement('span');
  labelNode.className = 'stat-label';
  labelNode.textContent = label;
  const valueNode = document.createElement('span');
  valueNode.className = 'stat-value';
  valueNode.textContent = formatNumber(value ?? 0);
  card.append(labelNode, valueNode);
  return card;
}

function renderStats(batch) {
  const stagingReady = batch.qtd_linhas_staging > 0;
  const cards = [
    ['Linhas raw', batch.qtd_linhas_raw],
    ['Na staging', stagingReady ? batch.qtd_linhas_staging : '—'],
    ['Válidas', stagingReady ? batch.contagem_status?.VALIDO ?? 0 : '—'],
    ['Inválidas / revisar', stagingReady
      ? (batch.contagem_status?.INVALIDO ?? 0) + (batch.contagem_status?.REVISAR ?? 0)
      : '—'],
  ];
  byId('batch-stats').replaceChildren(...cards.map(([label, count], index) =>
    statCard(label, count, index === 3 && stagingReady && count > 0)));
}

function renderPipeline(batch) {
  const stagingReady = batch.qtd_linhas_staging > 0;
  const persisted = Boolean(batch.persistido_em);
  const stages = [
    ['step-raw', true],
    ['step-staging', stagingReady],
    ['step-core', persisted],
  ];
  for (const [id, complete] of stages) {
    byId(id).classList.toggle('is-done', complete && id !== (state.activeBatchLayer === 'raw' ? 'step-raw' : ''));
    byId(id).classList.toggle('is-current',
      id === (state.activeBatchLayer === 'raw' ? 'step-raw'
        : state.activeBatchLayer === 'staging' ? 'step-staging' : 'step-core'));
  }
  byId('connector-raw').classList.toggle('is-done', stagingReady);
  byId('connector-staging').classList.toggle('is-done', persisted);
}

function renderBatchList() {
  byId('batch-count').textContent = String(state.batches.length);
  const list = byId('batch-list');
  if (!state.batches.length) {
    list.innerHTML = '<div class="empty-state">Nenhum lote carregado.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const batch of state.batches) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `batch-item${batch.id_lote === state.activeBatchId ? ' is-selected' : ''}`;
    const title = document.createElement('span');
    title.className = 'batch-item-title';
    title.textContent = batch.nome_arquivo;
    const meta = document.createElement('span');
    meta.className = 'batch-item-meta';
    const type = document.createElement('span');
    type.textContent = batch.tipo_arquivo;
    const count = document.createElement('span');
    count.textContent = `${batch.qtd_linhas_raw} linhas`;
    meta.append(type, count);
    button.append(title, meta);
    button.addEventListener('click', () => selectBatch(batch.id_lote));
    fragment.append(button);
  }
  list.replaceChildren(fragment);
}

async function refreshBatches() {
  const result = await request('/api/ingestions');
  state.batches = result.lotes;
  renderBatchList();
}

async function selectBatch(batchId, layer = null) {
  state.activeBatchId = Number(batchId);
  const requestedLayer = layer ?? 'raw';
  const result = await request(`/api/ingestions/${batchId}?layer=${requestedLayer}&limit=100`);
  if (!layer && result.lote.qtd_linhas_staging) return selectBatch(batchId, 'staging');
  state.activeBatchLayer = requestedLayer;
  renderBatch(result);
  renderBatchList();
}

function renderBatch(result) {
  const { lote: batch, linhas, total } = result;
  byId('batch-panel').hidden = false;
  byId('batch-title').textContent = batch.nome_arquivo;
  byId('batch-type').textContent = `${batch.tipo_arquivo} · lote ${batch.id_lote}`;
  byId('grid-title').textContent = `Tabela ${result.camada}`;
  byId('grid-caption').textContent = `${total} registros · exibindo ${linhas.length}`;
  renderStats(batch);
  renderPipeline(batch);

  const actions = [];
  if (result.camada === 'raw' && !batch.qtd_linhas_staging) {
    actions.push({ label: 'Enviar para staging', icon: '↘', action: () => sendToStaging(batch.id_lote) });
  }
  if (result.camada === 'staging' && batch.qtd_linhas_staging) {
    actions.push({ label: 'Ver raw', icon: '↖', action: () => selectBatch(batch.id_lote, 'raw') });
    actions.push({ label: 'Persistir dados válidos', icon: '✓', primary: true, action: () => persistCore(batch.id_lote) });
  }
  if (result.camada === 'raw' && batch.qtd_linhas_staging) {
    actions.push({ label: 'Ver staging', icon: '↘', action: () => selectBatch(batch.id_lote, 'staging') });
  }
  if (['CONCLUIDO', 'CONCLUIDO_COM_ERROS'].includes(batch.status_lote)
      && state.activeBatchLayer === 'staging') {
    actions.push({ label: 'Ver raw', icon: '↖', action: () => selectBatch(batch.id_lote, 'raw') });
  }
  byId('batch-actions').replaceChildren(...actions.map((item) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = `button ${item.primary ? 'button-primary' : 'button-secondary'}`;
    button.innerHTML = `<span class="button-icon" aria-hidden="true">${item.icon}</span>${item.label}`;
    button.addEventListener('click', item.action);
    return button;
  }));

  if (result.camada === 'raw') renderRawTable(byId('batch-grid'), linhas);
  else renderStagingTable(byId('batch-grid'), linhas);
}

async function sendToStaging(batchId) {
  try {
    await request(`/api/ingestions/${batchId}/stage`, { method: 'POST' });
    state.activeBatchLayer = 'staging';
    await refreshBatches();
    await selectBatch(batchId, 'staging');
    showToast('Dados enviados para staging. Revise as validações antes de persistir.');
  } catch (error) {
    showToast(error.message, true);
  }
}

async function persistCore(batchId) {
  try {
    const result = await request(`/api/ingestions/${batchId}/persist`, { method: 'POST' });
    state.activeBatchLayer = 'core';
    await refreshBatches();
    await selectBatch(batchId, 'staging');
    state.activeBatchLayer = 'core';
    renderPipeline(result.lote);
    showToast(`${result.persistidas} linha(s) persistida(s); ${result.revisar} aguardando correção ou dependências.`);
    await refreshAnalysisOptions();
  } catch (error) {
    showToast(error.message, true);
  }
}

function selectedValues(select) {
  return [...select.selectedOptions].map((option) => option.value).filter(Boolean);
}

function setOptions(select, rows, valueKey, labelBuilder, placeholder = 'Todos', selectedValue = '') {
  const options = [new Option(placeholder, '')];
  for (const row of rows) options.push(new Option(labelBuilder(row), String(row[valueKey])));
  select.replaceChildren(...options);
  if (selectedValue && [...select.options].some((option) => option.value === selectedValue)) {
    select.value = selectedValue;
  }
}

function filterValues(panel) {
  const result = {};
  for (const control of panel.querySelectorAll('[data-filter]')) {
    const key = control.dataset.filter;
    result[key] = control.multiple ? selectedValues(control) : control.value;
  }
  return result;
}

async function loadOptions(panel) {
  const mode = panel.dataset.mode;
  const filters = filterValues(panel);
  const query = new URLSearchParams({ mode });
  for (const key of ['setor', 'subsetor', 'segmento', 'companyId', 'tipoPeriodo', 'grupoDfp']) {
    if (filters[key]) query.set(key, filters[key]);
  }
  const options = await request(`/api/options?${query}`);
  const sector = panel.querySelector('[data-filter="setor"]');
  const subsector = panel.querySelector('[data-filter="subsetor"]');
  const segment = panel.querySelector('[data-filter="segmento"]');
  setOptions(sector, [...new Set(options.hierarchy.map((row) => row.setor))]
    .map((nome_setor) => ({ nome_setor })), 'nome_setor', (row) => row.nome_setor,
  'Todos os setores', filters.setor);
  setOptions(subsector, [...new Set(options.hierarchy
    .filter((row) => !filters.setor || row.setor === filters.setor)
    .map((row) => row.subsetor).filter(Boolean))]
    .map((nome_subsetor) => ({ nome_subsetor })), 'nome_subsetor', (row) => row.nome_subsetor,
  'Todos os subsetores', filters.subsetor);
  setOptions(segment, [...new Set(options.hierarchy
    .filter((row) => (!filters.setor || row.setor === filters.setor)
      && (!filters.subsetor || row.subsetor === filters.subsetor))
    .map((row) => row.segmento).filter(Boolean))]
    .map((nome_segmento) => ({ nome_segmento })), 'nome_segmento', (row) => row.nome_segmento,
  'Todos os segmentos', filters.segmento);

  const companySelect = panel.querySelector('[data-filter="companyId"], [data-filter="companyIds"]');
  if (companySelect) {
    const previous = companySelect.multiple ? filters.companyIds : filters.companyId;
    const companyOptions = options.companies.map((row) => ({
      id_empresa: row.id_empresa,
      label: `${row.denom_cia} (${row.codigo_negociacao || row.cnpj_cia})`,
    }));
    setOptions(companySelect, companyOptions, 'id_empresa', (row) => row.label,
      companySelect.multiple ? '' : 'Selecione uma empresa',
      companySelect.multiple ? '' : previous);
    if (companySelect.multiple && previous.length) {
      for (const option of companySelect.options) option.selected = previous.includes(option.value);
    }
  }

  const periodType = panel.querySelector('[data-filter="tipoPeriodo"]');
  setOptions(periodType, options.periodTypes.map((tipo_periodo) => ({ tipo_periodo })),
    'tipo_periodo', (row) => ({
      ANUAL: 'Anual',
      TRIMESTRAL: 'Trimestral',
      TRIMESTRAL_ACUMULADO: 'Trimestral acumulado',
    })[row.tipo_periodo] ?? row.tipo_periodo,
    'Selecione um tipo', filters.tipoPeriodo);

  const group = panel.querySelector('[data-filter="grupoDfp"]');
  if (group && options.groups.length) {
    const groupLabels = { CONSOLIDADO: 'Consolidado', INDIVIDUAL: 'Individual' };
    setOptions(group, options.groups.map((grupo_dfp) => ({ grupo_dfp })), 'grupo_dfp',
      (row) => groupLabels[row.grupo_dfp] ?? row.grupo_dfp,
      'Selecione', filters.grupoDfp || 'CONSOLIDADO');
  }

  const account = panel.querySelector('[data-filter="accountCode"]');
  const hasAccountOwner = mode === 'individual'
    ? Boolean(filters.companyId)
    : Boolean(filters.segmento);
  account.disabled = !hasAccountOwner;
  setOptions(account, options.accounts, 'cd_conta',
    (row) => `${row.cd_conta} · ${row.descricao}`,
    'Selecione uma conta', filters.accountCode);

  updateComparativeControls(panel);
}

function updateComparativeControls(panel) {
  if (panel.dataset.mode !== 'comparative') return;
  const companies = selectedValues(panel.querySelector('[data-filter="companyIds"]'));
  const toggle = panel.querySelector('[data-filter="axisSecondary"]');
  toggle.disabled = companies.length !== 2;
  if (companies.length !== 2) toggle.checked = false;
  byId('company-hint').textContent = companies.length < 2
    ? 'Selecione pelo menos duas empresas.'
    : companies.length === 2
      ? 'Eixo secundário disponível para duas empresas.'
      : 'Mais de duas empresas: eixo único.';
}

async function refreshAnalysisOptions() {
  for (const panel of document.querySelectorAll('.filter-panel')) {
    await loadOptions(panel);
  }
}

function analysisQuery(panel) {
  const values = filterValues(panel);
  const query = new URLSearchParams();
  const companies = panel.dataset.mode === 'individual'
    ? values.companyId ? [values.companyId] : []
    : values.companyIds;
  if (companies.length) query.set('companyIds', companies.join(','));
  for (const key of ['accountCode', 'tipoPeriodo', 'grupoDfp', 'periodStart', 'periodEnd']) {
    if (values[key]) query.set(key, values[key]);
  }
  if (values.axisSecondary) query.set('axisSecondary', 'true');
  return { values, query };
}

function chartLine(mode, result, axisSecondary) {
  const panel = byId(`view-${mode}`);
  const canvas = panel.querySelector('.line-canvas canvas');
  const datasets = result.series.map((series, index) => ({
    label: series.label,
    data: series.data.map((point) => point.y),
    borderColor: palette[index % palette.length],
    backgroundColor: palette[index % palette.length],
    borderWidth: 2,
    pointRadius: 3,
    pointHoverRadius: 5,
    tension: 0.26,
    yAxisID: axisSecondary && index === 1 ? 'y1' : 'y',
  }));
  const labels = result.series[0]?.data.map((point) => point.periodo) ?? [];
  state.charts[mode].line?.destroy();
  state.charts[mode].line = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { position: 'bottom', labels: { usePointStyle: true, boxWidth: 7, boxHeight: 7, color: '#66746d', font: { family: 'DM Sans', size: 10 } } },
        tooltip: { callbacks: { label: (context) => `${context.dataset.label}: ${formatNumber(context.parsed.y)}` } },
      },
      scales: {
        x: { grid: { display: false }, ticks: { color: '#829087', maxRotation: 0, font: { family: 'DM Mono', size: 9 } } },
        y: { beginAtZero: false, grid: { color: '#edf1ee' }, ticks: { color: '#829087', callback: (value) => compact(value), font: { family: 'DM Mono', size: 9 } } },
        ...(axisSecondary ? { y1: { position: 'right', beginAtZero: false, grid: { drawOnChartArea: false }, ticks: { color: palette[1], callback: (value) => compact(value), font: { family: 'DM Mono', size: 9 } } } } : {}),
      },
    },
  });
}

function compact(value) {
  const number = Number(value);
  if (Math.abs(number) >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1)} bi`;
  if (Math.abs(number) >= 1_000_000) return `${(number / 1_000_000).toFixed(1)} mi`;
  if (Math.abs(number) >= 1_000) return `${(number / 1_000).toFixed(1)} mil`;
  return formatNumber(number);
}

function chartBars(mode, result) {
  const panel = byId(`view-${mode}`);
  const canvas = panel.querySelector('.bar-canvas canvas');
  const bars = [...result.barras].sort((left, right) =>
    left.cdConta.localeCompare(right.cdConta, 'pt-BR', { numeric: true })
      || left.empresa.localeCompare(right.empresa, 'pt-BR'));
  const labels = bars.map((row) => mode === 'comparative'
    ? `${row.cdConta} · ${row.empresa}`
    : `${row.cdConta} · ${row.descricao}`);
  const values = bars.map((row) => row.valorNormalizado);
  const colors = bars.map((row) => {
    const index = result.series.findIndex((series) => series.idEmpresa === row.idEmpresa);
    return palette[Math.max(index, 0) % palette.length];
  });
  state.charts[mode].bar?.destroy();
  state.charts[mode].bar = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: colors, borderRadius: 2, barThickness: 15, maxBarThickness: 19 }] },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (context) => formatNumber(context.parsed.x) } },
      },
      scales: {
        x: { grid: { color: '#edf1ee' }, ticks: { color: '#829087', callback: compact, font: { family: 'DM Mono', size: 9 } } },
        y: { grid: { display: false }, ticks: { color: '#65736b', autoSkip: false, font: { family: 'DM Mono', size: 9 } } },
      },
    },
  });
}

function renderAnalysisTable(container, rows) {
  container.replaceChildren(makeTable(
    analysisHeaders.map(([key, label]) => ({ key, label })),
    rows,
  ));
}

async function runAnalysis(panel) {
  const mode = panel.dataset.mode;
  const { values, query } = analysisQuery(panel);
  try {
    const result = await request(`/api/analysis/${mode}?${query}`);
    const resultsPanel = byId(`view-${mode}`).querySelector('.analysis-results');
    const empty = byId(`view-${mode}`).querySelector('.analysis-empty');
    resultsPanel.hidden = false;
    empty.hidden = true;
    chartLine(mode, result, Boolean(values.axisSecondary));
    chartBars(mode, result);
    byId(`view-${mode}`).querySelector('[data-chart-currency]').textContent = result.moeda ?? 'Sem dados';
    byId(`view-${mode}`).querySelector('[data-chart-period]').textContent = result.dataBarras ? formatDate(result.dataBarras) : 'Sem dados';
    byId(`view-${mode}`).querySelector('[data-row-count]').textContent = `${result.linhas.length} registros`;
    renderAnalysisTable(byId(`view-${mode}`).querySelector('.analysis-table'), result.linhas);
    state.analysisParams[mode] = query;
    showToast(result.linhas.length ? 'Análise atualizada.' : 'Nenhum registro encontrado para esses filtros.');
  } catch (error) {
    showToast(error.message, true);
  }
}

function downloadExport(mode, format) {
  const query = state.analysisParams[mode];
  if (!query) {
    showToast('Gere uma análise antes de exportar.', true);
    return;
  }
  const downloadQuery = new URLSearchParams(query);
  downloadQuery.set('format', format);
  window.location.assign(`/api/export/${mode}?${downloadQuery}`);
}

function switchView(name) {
  for (const tab of document.querySelectorAll('.tab')) {
    const active = tab.dataset.view === name;
    tab.classList.toggle('is-active', active);
    tab.setAttribute('aria-selected', String(active));
  }
  for (const view of document.querySelectorAll('.view')) {
    const active = view.id === `view-${name}`;
    view.classList.toggle('is-active', active);
    view.hidden = !active;
  }
  if (name !== 'ingestion') refreshAnalysisOptions().catch((error) => showToast(error.message, true));
}

function bindUpload() {
  const input = byId('file-input');
  const form = byId('upload-form');
  const zone = form;
  byId('choose-file').addEventListener('click', () => input.click());
  input.addEventListener('change', () => {
    const file = input.files[0];
    byId('file-name').textContent = file?.name ?? 'Nenhum arquivo selecionado';
    byId('upload-button').disabled = !file;
  });
  for (const eventName of ['dragenter', 'dragover']) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.add('is-dragging');
    });
  }
  for (const eventName of ['dragleave', 'drop']) {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove('is-dragging');
    });
  }
  zone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    const transfer = new DataTransfer();
    transfer.items.add(file);
    input.files = transfer.files;
    input.dispatchEvent(new Event('change'));
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const file = input.files[0];
    if (!file) return;
    const data = new FormData();
    data.append('file', file);
    byId('upload-button').disabled = true;
    try {
      const result = await request('/api/ingestions', { method: 'POST', body: data });
      state.activeBatchId = result.lote.id_lote;
      state.activeBatchLayer = 'raw';
      await refreshBatches();
      await selectBatch(state.activeBatchId, 'raw');
      input.value = '';
      byId('file-name').textContent = 'Nenhum arquivo selecionado';
      showToast('Arquivo carregado na camada raw. Revise a origem antes de enviar para staging.');
    } catch (error) {
      showToast(error.message, true);
    } finally {
      byId('upload-button').disabled = !input.files.length;
    }
  });
}

function bindFilters() {
  for (const panel of document.querySelectorAll('.filter-panel')) {
    panel.addEventListener('change', (event) => {
      if (event.target.matches('[data-filter="axisSecondary"]')) return;
      if (event.target.matches('[data-filter="companyIds"]')) {
        updateComparativeControls(panel);
      }
      loadOptions(panel).catch((error) => showToast(error.message, true));
    });
    panel.querySelector('.run-analysis').addEventListener('click', () => runAnalysis(panel));
  }
}

function bindExports() {
  for (const mode of ['individual', 'comparative']) {
    byId(`view-${mode}`).querySelector('.export-csv')
      .addEventListener('click', () => downloadExport(mode, 'csv'));
    byId(`view-${mode}`).querySelector('.export-xlsx')
      .addEventListener('click', () => downloadExport(mode, 'xlsx'));
  }
}

async function initialize() {
  byId('today-label').textContent = new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit', month: 'short', year: 'numeric',
  }).format(new Date());
  for (const tab of document.querySelectorAll('.tab')) {
    tab.addEventListener('click', () => switchView(tab.dataset.view));
  }
  bindUpload();
  bindFilters();
  bindExports();

  try {
    await request('/api/health');
    byId('database-label').textContent = 'Banco conectado';
    byId('database-label').parentElement.classList.add('is-online');
    await refreshBatches();
    if (state.batches.length) await selectBatch(state.batches[0].id_lote);
    await refreshAnalysisOptions();
  } catch (error) {
    byId('database-label').textContent = 'Banco indisponível';
    showToast(error.message, true);
  }
}

initialize();
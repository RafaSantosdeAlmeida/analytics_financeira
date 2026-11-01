export function initializeDatabase(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS ingestion_lote (
      id_lote INTEGER PRIMARY KEY AUTOINCREMENT,
      tipo_arquivo TEXT NOT NULL,
      nome_arquivo TEXT NOT NULL,
      hash_sha256 TEXT NOT NULL,
      delimitador TEXT NOT NULL,
      encoding_arquivo TEXT NOT NULL,
      recebido_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      finalizado_em TEXT,
      status_lote TEXT NOT NULL DEFAULT 'PROCESSANDO',
      qtd_linhas_arquivo INTEGER NOT NULL DEFAULT 0,
      qtd_linhas_raw INTEGER NOT NULL DEFAULT 0,
      qtd_linhas_staging INTEGER NOT NULL DEFAULT 0,
      qtd_linhas_validas INTEGER NOT NULL DEFAULT 0,
      qtd_linhas_invalidas INTEGER NOT NULL DEFAULT 0,
      persistido_em TEXT,
      mensagem_erro TEXT
    );

    CREATE TABLE IF NOT EXISTS raw_linha (
      id_raw_linha INTEGER PRIMARY KEY AUTOINCREMENT,
      id_lote INTEGER NOT NULL REFERENCES ingestion_lote(id_lote),
      numero_linha_origem INTEGER NOT NULL,
      dados_json TEXT NOT NULL,
      UNIQUE (id_lote, numero_linha_origem)
    );

    CREATE TABLE IF NOT EXISTS stg_linha (
      id_stg_linha INTEGER PRIMARY KEY AUTOINCREMENT,
      id_lote INTEGER NOT NULL REFERENCES ingestion_lote(id_lote),
      id_raw_linha INTEGER NOT NULL UNIQUE REFERENCES raw_linha(id_raw_linha),
      dados_json TEXT NOT NULL,
      status_validacao TEXT NOT NULL DEFAULT 'PENDENTE'
        CHECK (status_validacao IN ('PENDENTE', 'VALIDO', 'INVALIDO', 'REVISAR')),
      erro_validacao TEXT,
      processado_em TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS setor (
      id_setor INTEGER PRIMARY KEY,
      nome_setor TEXT NOT NULL UNIQUE
    );

    CREATE TABLE IF NOT EXISTS subsetor (
      id_subsetor INTEGER PRIMARY KEY,
      id_setor INTEGER NOT NULL REFERENCES setor(id_setor),
      nome_subsetor TEXT NOT NULL,
      UNIQUE (id_setor, nome_subsetor)
    );

    CREATE TABLE IF NOT EXISTS segmento (
      id_segmento INTEGER PRIMARY KEY,
      id_subsetor INTEGER NOT NULL REFERENCES subsetor(id_subsetor),
      nome_segmento TEXT NOT NULL,
      UNIQUE (id_subsetor, nome_segmento)
    );

    CREATE TABLE IF NOT EXISTS empresas (
      id_empresa INTEGER PRIMARY KEY,
      cnpj_cia TEXT NOT NULL UNIQUE,
      denom_cia TEXT NOT NULL,
      cd_cvm TEXT,
      codigo_negociacao TEXT,
      id_segmento INTEGER NOT NULL REFERENCES segmento(id_segmento)
    );

    CREATE TABLE IF NOT EXISTS periodos (
      id_periodo INTEGER PRIMARY KEY,
      periodo TEXT NOT NULL,
      tipo_periodo TEXT NOT NULL,
      dt_ini_exerc TEXT NOT NULL,
      dt_fim_exerc TEXT NOT NULL,
      ano_exerc INTEGER NOT NULL,
      UNIQUE (periodo, tipo_periodo)
    );

    CREATE TABLE IF NOT EXISTS plano_conta_empresa (
      id_plano_conta_empresa INTEGER PRIMARY KEY,
      id_empresa INTEGER NOT NULL REFERENCES empresas(id_empresa),
      cd_conta TEXT NOT NULL,
      nivel_conta INTEGER NOT NULL,
      ds_conta_empresa TEXT NOT NULL,
      UNIQUE (id_empresa, cd_conta),
      UNIQUE (id_plano_conta_empresa, id_empresa)
    );

    CREATE TABLE IF NOT EXISTS plano_conta_segmento (
      id_plano_conta_segmento INTEGER PRIMARY KEY,
      id_segmento INTEGER NOT NULL REFERENCES segmento(id_segmento),
      cd_conta TEXT NOT NULL,
      nivel_conta INTEGER NOT NULL,
      ds_conta_segmento TEXT NOT NULL,
      UNIQUE (id_segmento, cd_conta)
    );

    CREATE TABLE IF NOT EXISTS demonstracao_financeira (
      id_demonstracao_financeira INTEGER PRIMARY KEY,
      id_empresa INTEGER NOT NULL REFERENCES empresas(id_empresa),
      id_periodo INTEGER NOT NULL REFERENCES periodos(id_periodo),
      id_plano_conta_empresa INTEGER NOT NULL,
      id_plano_conta_segmento INTEGER
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

    CREATE INDEX IF NOT EXISTS ix_stg_linha_lote_status
      ON stg_linha(id_lote, status_validacao);
    CREATE INDEX IF NOT EXISTS ix_empresa_segmento
      ON empresas(id_segmento);
    CREATE INDEX IF NOT EXISTS ix_periodo_ano
      ON periodos(ano_exerc);
    CREATE INDEX IF NOT EXISTS ix_demonstracao_empresa_periodo
      ON demonstracao_financeira(id_empresa, id_periodo);
  `);

  const segmentAccountColumn = database.prepare(
    'PRAGMA table_info(demonstracao_financeira)',
  ).all().find((column) => column.name === 'id_plano_conta_segmento');

  if (segmentAccountColumn?.notnull) {
    database.exec('PRAGMA foreign_keys = OFF');
    try {
      database.exec(`
        BEGIN IMMEDIATE;
        ALTER TABLE demonstracao_financeira RENAME TO demonstracao_financeira_legacy;
        CREATE TABLE demonstracao_financeira (
          id_demonstracao_financeira INTEGER PRIMARY KEY,
          id_empresa INTEGER NOT NULL REFERENCES empresas(id_empresa),
          id_periodo INTEGER NOT NULL REFERENCES periodos(id_periodo),
          id_plano_conta_empresa INTEGER NOT NULL,
          id_plano_conta_segmento INTEGER
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
        INSERT INTO demonstracao_financeira
        SELECT * FROM demonstracao_financeira_legacy;
        DROP TABLE demonstracao_financeira_legacy;
        CREATE INDEX ix_demonstracao_empresa_periodo
          ON demonstracao_financeira(id_empresa, id_periodo);
        COMMIT;
      `);
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    } finally {
      database.exec('PRAGMA foreign_keys = ON');
    }
  }
}
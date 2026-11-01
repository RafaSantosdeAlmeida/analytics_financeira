# Analytics Financeira

Aplicação local para ingestão dos cinco layouts CSV do projeto, armazenamento SQLite em camadas raw/staging/core e análise de demonstrações financeiras.

## Requisitos

- Node.js 24 ou superior
- npm

## Executar

Na pasta `analytics_financeira/`:

```powershell
npm install
npm start
```

Abra `http://localhost:3000`. Para desenvolvimento com reinício automático, use `npm run dev`. Para executar os testes, use `npm test`.

O banco `analytics_financeira.sqlite` é criado ao iniciar o servidor. Para usar outro caminho, defina `DATABASE_PATH`; para usar outra porta, defina `PORT`.

## Fluxo de ingestão

1. Envie um CSV, de até 100 MB. O tipo é identificado pelos cabeçalhos, não pelo nome do arquivo.
2. Revise as linhas guardadas na camada raw.
3. Use **Enviar para staging** para tipar e validar. Erros aparecem por linha e no resumo do lote.
4. Use **Persistir dados válidos** para carregar dimensões e fatos. Linhas com dependências ausentes permanecem em revisão e podem ser tentadas novamente após carregar os arquivos necessários.

Carregue as referências na ordem `setor_subsetor_segmento`, `empresas`, `plano_conta_empresa`, `plano_conta_segmento` e, por fim, DRE. Os dados aceitos são preservados na raw mesmo quando há erros na staging.

## Análises

- Individual: uma empresa e uma conta do plano empresarial.
- Comparativa: duas ou mais empresas e conta de nível 1 do plano do segmento. Eixo secundário disponível somente para duas empresas.
- Períodos anuais, trimestrais e trimestrais acumulados permanecem separados.
- Valores dos gráficos são normalizados pela escala reportada. Comparações entre moedas diferentes são bloqueadas; não há conversão cambial.
- As barras exibem as contas do período mais recente dentro do intervalo selecionado. Na análise comparativa, usam as contas-raiz de segmento para evitar somar níveis hierárquicos duplicados.

## Observações

O plano de contas por segmento contém contas de nível 1. A DRE é associada ao plano de segmento somente quando existe o mesmo código de conta; contas empresariais detalhadas sem correspondência ficam com a conta de segmento nula. A DRE preserva individual/consolidado e os valores/escala originais para consulta e exportação.

A ingestão reconhece UTF-8/UTF-8 BOM e Windows-1252/Latin-1, vírgula ou ponto e vírgula. Linhas que não encontram empresa ou conta correspondente ficam em `REVISAR`, com a causa registrada.

Na DRE, somente registros com `ORDEM_EXERC` normalizado como `ULTIMO` são válidos para persistência; registros `PENULTIMO` continuam na raw/staging como inválidos e não são gravados na `demonstracao_financeira`.
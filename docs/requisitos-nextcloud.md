# Levantamento de Requisitos: Integração do Plugin com Nextcloud

## 1. Visão Geral
Este documento apresenta o levantamento de requisitos para a integração do plugin de sincronização do Obsidian (MySync) com o ecossistema **Nextcloud**. O objetivo é expandir as capacidades do plugin atual para suportar servidores Nextcloud, oferecendo uma alternativa robusta e auto-hospedada (self-hosted) aos usuários para manter a sincronia de seus cofres (Vaults).

### Estado da implementação

A integração principal está implementada no endpoint WebDAV legado já usado pelo
plugin. O cliente lista a árvore sequencialmente com `PROPFIND Depth: 1`, exige
metadados e `ETag`, baixa com `GET If-Match` e grava/exclui com precondições HTTP.
Um snapshot local separado por URL, usuário, pasta remota, pasta local e opção de
configuração registra o último conteúdo confirmado sem armazenar a senha.

O primeiro pull faz uma mesclagem conservadora e nunca interpreta arquivos apenas
locais como exclusões. Mudanças concorrentes viram conflitos resolvíveis por
**Keep local**, **Keep remote**, **Keep both** ou **Delete**. Exclusões remotas de
10 ou mais arquivos que alcancem 25% do snapshot anterior exigem confirmação.
Falha ou listagem incompleta não atualiza o horário do último pull.

O escopo atual inclui Markdown, PDF, imagens reconhecidas e os arquivos de
configuração de primeiro nível permitidos. Permanecem fora do escopo certificados
autoassinados, E2EE, arquivos arbitrários e migração para outro endpoint WebDAV.

## 2. Possibilidades de Uso que o Nextcloud Oferece

O Nextcloud não é apenas um servidor de arquivos, mas uma plataforma rica. Integrar o Obsidian com o Nextcloud abre as seguintes possibilidades:

### 2.1. Sincronização via WebDAV (Core)
- **Acesso Nativo e Padronizado**: O Nextcloud possui suporte robusto ao protocolo WebDAV, permitindo leitura, escrita, deleção e listagem de arquivos markdown e anexos (imagens, PDFs).
- **Gerenciamento de Diretórios**: Facilita a recriação da estrutura de pastas exata do cofre do Obsidian remotamente de forma nativa.

### 2.2. Integração com o "Nextcloud Notes"
- **Ecossistema Único**: O Nextcloud possui um aplicativo oficial de anotações (Nextcloud Notes) que lê arquivos markdown de um diretório específico. O plugin pode sincronizar as notas do Obsidian diretamente nesta pasta, permitindo que sejam visualizadas e editadas nativamente via interface web do Nextcloud ou seu aplicativo mobile dedicado.

### 2.3. Controle de Versão e Retenção de Dados
- **File Versioning Automático**: O Nextcloud mantém versões anteriores de arquivos que sofrem modificações. O plugin pode delegar a segurança do histórico de edições ao servidor, mitigando acidentes ou perdas de dados críticas.
- **Lixeira (Trash bin)**: Arquivos deletados no Obsidian e sincronizados podem ser restaurados facilmente através da interface de lixeira do Nextcloud.

### 2.4. Compartilhamento e Colaboração
- **Links de Acesso**: Há o potencial de consumir as APIs do Nextcloud para gerar links de compartilhamento público de notas específicas do Obsidian com um único clique.
- **Colaboração de Equipe**: Múltiplos usuários do Nextcloud podem acessar pastas compartilhadas, viabilizando bases de conhecimento colaborativas sincronizadas pelo Obsidian.

### 2.5. Segurança e Privacidade (E2EE)
- **Criptografia Ponta-a-Ponta**: Pode-se explorar os módulos nativos de E2EE do Nextcloud, ou implementar encriptação client-side no Obsidian (antes do upload WebDAV) garantindo que nem o provedor do servidor Nextcloud consiga ler o conteúdo do Vault.

---

## 3. Princípios de Controle para Sincronização (Dispositivos ↔ Obsidian)

Ao usar o Nextcloud como fonte de verdade ("Source of Truth") e ponte para sincronizar múltiplos dispositivos executando o Obsidian, os seguintes controles são cruciais para assegurar a integridade dos dados:

### 3.1. Rastreamento de Estado (State Tracking) e Otimização
- **Uso de `ETag` (Entity Tag)**: A sincronização deve aproveitar os cabeçalhos `ETag` providos pelo WebDAV. O plugin precisa manter um registro local relacionando cada arquivo do Obsidian ao seu último `ETag` sincronizado. Isso possibilita identificar exatamente quais arquivos foram modificados no servidor sem precisar baixar seu conteúdo.
- **Sincronização Incremental**: Consultas à rede devem ser focadas em mudanças recentes (PROPFIND comparando o estado atual contra o cache). O carregamento/download completo do Vault deve ocorrer estritamente na primeira sincronização de um novo dispositivo.

### 3.2. Resolução de Conflitos (Conflict Resolution)
- **Evitar Perda de Dados ("No-Data-Loss")**: Se um arquivo for modificado simultaneamente em um dispositivo local e no servidor remoto (via outro dispositivo), o plugin deve:
  1. Detectar o conflito (o `ETag` do servidor e a data de modificação local diferem da base de conhecimento atual).
  2. Evitar sobrescrever às cegas.
  3. Gerar e salvar ambas as versões (ex: criando um arquivo nomeado `Nota (Conflito 2026-09-02).md`) e alertar o usuário para que faça a união (merge) manualmente.

### 3.3. Autenticação e Gestão de Segredos
- **App Passwords (Senhas de Aplicativo)**: Para respeitar os padrões de segurança moderna, o plugin não deve incentivar o uso da senha master do Nextcloud. O usuário deve gerar uma "App Password" (Senha de Dispositivo) específica. Dessa forma, o acesso pode ser revogado unilateralmente pelo servidor se o dispositivo for comprometido.
- **Armazenamento Seguro**: As credenciais e a URL do servidor Nextcloud devem ser armazenadas de forma segura nas configurações do plugin, sem exposição indevida no sistema de arquivos em modo de texto simples se existirem mecanismos sensíveis disponíveis (embora no Obsidian standard dados sejam salvos no `data.json`).

### 3.4. Controle e Propagação de Exclusões
- **Exclusão Segura (Bidirecional)**: O plugin precisará discernir se a ausência de um arquivo no servidor é um arquivo intencionalmente deletado ou apenas uma falha de carregamento.
- **Fail-safe de Exclusão em Massa**: Se um problema no servidor ou erro de configuração retornar uma lista vazia, o plugin deve ter um "freio de segurança" ("kill-switch") para não deletar os arquivos locais de imediato. Sugere-se exigir confirmação do usuário caso a sincronia determine que uma grande porcentagem do Vault será deletada.

### 3.5. Controle de Limite de Requisições (Rate Limiting e Performance)
- **Throttling e Filas Assíncronas**: Projetos no Obsidian podem conter milhares de notas curtas (Markdown). Requisições WebDAV individuais e excessivamente rápidas para cada arquivo podem engatilhar os sistemas anti-DDoS e Rate Limiters do Nextcloud/Servidor Web. O processo de sincronia deve utilizar filas com limitação de concorrência e processos em *background*.

### 3.6. Tratamento de Conectividade e Certificados
- **Conexões Resilientes**: O fluxo deve lidar graciosamente com ausência de conexão, guardando as pendências localmente e tentando novamente de forma automática.
- **Suporte para Certificados Locais (Self-Signed)**: Como muitos usuários rodam Nextcloud em ambientes locais (Home Labs), o plugin pode precisar de diretivas para ignorar erros estritos de SSL ou alertar sobre configurações de rede quando conexões TLS/HTTPS não puderem ser validadas.

---

## 4. Regras de Negócio e Boas Práticas: Vault Local vs. Remoto

O maior desafio da sincronização não é a cópia de arquivos, mas sim a orquestração do estado e das intenções do usuário. Para evitar perda de dados e confusão, os seguintes conceitos devem reger o fluxo.

### 4.1. Quem manda mais? (Source of Truth)
Nenhum dos lados (Local ou Remoto) é um "chefe absoluto". O conceito ideal é o de **Estado Compartilhado (Shared State)** guiado por uma linha do tempo.

- **O Nextcloud (Remoto)** atua como um "Hub Central" (Source of Truth do Estado Global). Ele não toma decisões, apenas informa: *"Isto é o que eu tenho, e esta é a data/`ETag` da última modificação que recebi"*.
- **O Plugin (Local)** atua como a inteligência do sistema. Ele é a Fonte de Verdade da **Intenção do Usuário** naquele dispositivo. É o cliente (plugin) que compara o que o Remote tem com o que o banco de dados interno de sincronia (Sync History) se lembrava da última vez.
- **A Regra de Ouro (Latest Wins)**: Quem tiver o timestamp de modificação mais recente (ou `ETag` atualizado) ganha e sobrescreve o mais antigo, **desde que** o arquivo não tenha sido modificado em ambos os lados ao mesmo tempo.

### 4.2. Quem controla o que será deletado, sobrescrito ou mantido?
A lógica de decisão de controle reside **exclusivamente no lado cliente (Plugin MySync)**. O Nextcloud via WebDAV não tem lógica de sincronização ativa, ele apenas obedece aos comandos (`PUT`, `DELETE`, `GET`) enviados pelo plugin.

Para o plugin decidir corretamente o que fazer, ele precisa de um **Banco de Dados Local de Histórico de Sincronia** (ex: o próprio PouchDB já utilizado, adaptado para guardar os `ETags` e caminhos conhecidos). O fluxo decisório baseia-se nisso:

#### Cenário de Sobrescrita (Upload vs Download)
- **Upload (Sobrescrevendo o Remoto):** Se a data de modificação da nota local for *mais recente* que o momento da última sincronização bem-sucedida, o plugin faz o upload e sobrescreve o arquivo remoto.
- **Download (Sobrescrevendo o Local):** Se o plugin consultar o servidor e ver que a nota tem um `ETag` *diferente* e data mais recente que a registrada no histórico local, o plugin baixa a nota, substituindo a versão local antiga.
- **Conflito (Ambos mudaram):** Se o arquivo local foi modificado, e o remoto *também* (outro `ETag`), o cliente **não** sobrescreve nenhum. Ele baixa a versão remota e a salva com um novo nome (ex: `Nota (Conflito).md`). Ambos são mantidos.

#### Cenário de Deleção
A exclusão exige muito cuidado. A ausência de um arquivo não basta, é preciso saber *por que* ele sumiu.
- **Usuário deleta nota no Obsidian:** O plugin percebe que o arquivo sumiu localmente, mas ele existia no Histórico Local. Isso significa que o usuário deletou de propósito. O cliente envia um comando `DELETE` para o Nextcloud.
- **Outro dispositivo deleta a nota no Remoto:** O plugin consulta o Nextcloud e nota que um arquivo sumiu lá (não está na lista WebDAV), mas ainda existe no cofre local e no Histórico Local. Isso significa que foi apagado via outro dispositivo. O cliente, então, deleta silenciosamente o arquivo do seu cofre Obsidian.
- **Proteção Contra Erros (Orphaned Files):** Se o plugin não conseguir alcançar a pasta no servidor, ele deve abortar a sincronia para evitar achar falsamente que "tudo foi deletado lá" e acabar apagando o Vault inteiro.

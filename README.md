# Olho D'Água — backend básico (API + banco de dados + fotos)

Este é um backend **de verdade**, testado e funcionando — não é mais uma simulação
dentro do navegador. As três peças que faltavam agora existem:

- **API HTTP real**, escrita só com o módulo nativo `http` do Node (sem frameworks,
  para não depender de instalar pacotes)
- **Banco de dados SQLite real**, gravado em `data/olho-dagua.db`, usando o módulo
  nativo `node:sqlite` do Node 22+ (não precisa instalar nada)
- **Armazenamento de fotos em disco**, na pasta `uploads/`, servidas por HTTP —
  é o mesmo padrão de um bucket de nuvem: a API decide onde o arquivo mora e
  guarda só a URL no banco

## Como rodar na sua máquina

Pré-requisito: **Node.js 22.5 ou mais recente** instalado
(baixe em nodejs.org caso não tenha).

```bash
cd olho-dagua-app
node server.js
```

Abra **http://localhost:3000** no navegador. Pronto — cliente e colaborador já
falam com a mesma API e o mesmo banco de dados.

Para testar em dois dispositivos diferentes na mesma rede (ex: celular e notebook),
descubra o IP local do computador que está rodando o servidor (`ipconfig` no
Windows ou `ifconfig`/`ip a` no Mac/Linux) e acesse `http://SEU-IP:3000` a
partir do outro aparelho.

## Publicar num link público de verdade

Isso é diferente do que fizemos com Cloudflare Pages/Netlify/GitHub Pages —
esses serviços só hospedam arquivos estáticos (HTML/CSS/JS) e **não rodam** um
servidor Node.js. Como este projeto tem uma API de verdade rodando em segundo
plano, ele precisa de um serviço que rode aplicações, não só arquivos. Opções
gratuitas para começar:

- **Render.com** — plano gratuito para "Web Service", conecta direto num
  repositório do GitHub
- **Railway.app** — parecido, com um pequeno crédito gratuito mensal
- **Fly.io** — também tem camada gratuita, mais indicado se já tiver alguma
  familiaridade com deploy

O passo geral em qualquer um deles é: subir este projeto para um repositório
no GitHub, conectar o repositório na plataforma escolhida, e configurar o
comando de start como `node server.js`.

## Limitações desta demo básica (de propósito)

Isso ainda **não é** o produto final — é o próximo degrau depois do protótipo
só em HTML. Coisas que faltam para produção real:

- **Autenticação real**: hoje qualquer pessoa pode "ser" qualquer cliente só
  digitando um nome. Precisa de login com senha/CPF/matrícula validados.
- **Banco de dados de produção**: SQLite em arquivo único funciona bem para
  poucos usuários simultâneos, mas para escala real (milhares de clientes)
  o ideal é migrar para PostgreSQL ou MySQL gerenciado na nuvem.
- **Armazenamento de fotos em nuvem de verdade**: hoje as fotos ficam no
  disco do próprio servidor. Isso funciona, mas não escala nem sobrevive
  a um redeploy em muitos serviços de hospedagem. O próximo passo é trocar
  a função `savePhoto()` em `server.js` por uma chamada para um bucket
  (Amazon S3, Google Cloud Storage, Cloudflare R2, etc.) — a lógica do
  resto do sistema não muda.
- **Validações e segurança**: sem limite de tamanho de foto por tipo de
  arquivo, sem proteção contra denúncias duplicadas/fraude, sem HTTPS,
  sem controle de acesso por papel de fato (o seletor de papel no painel
  hoje é só visual).
- **Conformidade com a LGPD**: consentimento do cliente, política de
  retenção de dados e fotos.

Ou seja: isso é uma demonstração de arquitetura funcionando de ponta a ponta,
com dados persistindo de verdade — mas para uso real da concessionária ainda
precisa do trabalho de hardening descrito no documento de especificação.

## Configuração recomendada para deploy com volume persistente

Esta versão aceita a variável de ambiente `STORAGE_DIR`. Em hospedagem, monte um
volume persistente e aponte `STORAGE_DIR` para esse diretório. O banco ficará em
`$STORAGE_DIR/data/olho-dagua.db` e as fotos em `$STORAGE_DIR/uploads/`.

### Railway

1. Suba esta pasta para um repositório GitHub.
2. Crie um projeto no Railway a partir do repositório.
3. Adicione um **Volume** ao serviço e monte-o em `/data`.
4. Nas variáveis do serviço, crie `STORAGE_DIR=/data`.
5. Gere um domínio público no serviço.

O `railway.json` já informa o comando `node server.js` e o health check
`/api/health`.

Deploy atualizado

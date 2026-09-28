# gitea-notify-action

GitHub Action для отправки уведомлений комментариями в существующие issues
Gitea. Получатели задаются ссылкой `to` или извлекаются из текста `changelog`.
Структура основана на TypeScript Action из `ref`, работа с API — на
`bot_post.ps1`.

## Подключение

Сохраните токен Gitea в секрете GitHub `GITEA_TOKEN`, а HTTPS-ссылку на issue —
в переменной `GITEA_ISSUE_URL`. Пользователь токена должен иметь доступ к issue
и право оставлять комментарии. Для токена с ограниченными разрешениями нужен
доступ на запись к issues. Runner должен иметь сетевой доступ к серверу Gitea.

Пример workflow внутри репозитория этого action:

```yaml
name: Notify Gitea
on: workflow_dispatch

permissions:
  contents: read

jobs:
  notify:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Send notification
        id: notify
        uses: aps-m/gitea-notify-action@master
        with:
          token: ${{ secrets.GITEA_TOKEN }}
          to: ${{ vars.GITEA_ISSUE_URL }}
          message: |
            ### Уведомление из GitHub Actions
            Репозиторий: ${{ github.repository }}
            Ветка: ${{ github.ref_name }}
            [Открыть запуск](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }})
```

Для другого репозитория опубликуйте этот проект вместе с каталогом `dist` и
замените `uses: ./` на `uses: OWNER/gitea-notify-action@REF`, где `OWNER` —
владелец, а `REF` — существующий тег или SHA коммита. Установка npm-зависимостей
в вызывающем workflow не требуется. Action использует Node.js 24; self-hosted
runner должен поддерживать `runs.using: node24`.

## Параметры

| Вход           | Обязательный | Описание                                           |
| -------------- | ------------ | -------------------------------------------------- |
| `token`        | Да           | Токен Gitea, передавайте через GitHub Secrets      |
| `to`           | Нет          | Ссылка вида `https://host/owner/repo/issues/42`    |
| `changelog`    | Нет          | Обработанный текст changelog со ссылками на issues |
| `message`      | Нет          | Текст комментария в Markdown                       |
| `message_file` | Нет          | Путь к UTF-8 файлу с текстом комментария           |

Нужно указать `to` или непустой `changelog`, а также непустой `message` или файл
с непустым текстом. Если заданы оба источника сообщения, сначала публикуется
содержимое файла, затем текст — двумя отдельными комментариями. Пустые строки и
файлы, содержащие только пробелы, пропускаются; если отправлять нечего, шаг
завершается ошибкой. В непустом тексте пробелы и переносы сохраняются.

## Уведомления по changelog

У `aps-m/read_changelog_action@v7` текст выбранной версии возвращается в output
`content`. Передайте его в `changelog`:

```yaml
- uses: actions/checkout@v4
- name: Read changelog for version 1.2.3
  id: changelog
  uses: aps-m/read_changelog_action@v7
  with:
    changelogfile: pre_release_changelog.md
    tag: '1.2.3'

- name: Notify issues from changelog
  uses: aps-m/gitea-notify-action@master
  with:
    token: ${{ secrets.GITEA_TOKEN }}
    changelog: ${{ steps.changelog.outputs.content }}
    message: |
      Версия 1.2.3 опубликована.
      [Открыть запуск](${{ github.server_url }}/${{ github.repository }}/actions/runs/${{ github.run_id }})
```

В changelog распознаются полные HTTPS-ссылки вида
`https://host/owner/repo/issues/42`: обычные URL, Markdown-ссылки
`[задача](https://host/owner/repo/issues/42)`, ссылки в угловых скобках и
определения ссылок Markdown. Короткие ссылки `#42`, относительные URL,
HTTP-ссылки и ссылки на pull requests или коммиты игнорируются.

Каждая уникальная задача получает заданные сообщения один раз за запуск: сначала
`message_file`, затем `message`. Сам `changelog` используется для поиска
получателей и автоматически не публикуется. Повторы ссылок, включая варианты с
query-параметрами, `#fragment` и завершающим слешем, объединяются. Задачи из
разных репозиториев обрабатываются отдельно, в порядке появления ссылок.

`to` можно не указывать. Если указаны и `to`, и `changelog`, задача из `to`
обрабатывается первой и добавляется к остальным без дублей. Если в непустом
changelog нет подходящих ссылок и `to` не задан, шаг успешно завершается с
`comment_count: 0`. Пустой changelog без `to` считается ошибкой входных данных.

Используйте changelog со ссылками на доверенные серверы Gitea: один и тот же
`token` отправляется на каждый найденный адрес issue.

## Сообщение из файла

Относительный путь `message_file` разрешается от рабочей директории шага (обычно
`GITHUB_WORKSPACE`). Файл должен быть получен через checkout, загрузку артефакта
или создан предыдущим шагом:

```yaml
- name: Send changelog
  uses: aps-m/gitea-notify-action@master
  with:
    token: ${{ secrets.GITEA_TOKEN }}
    to: https://git.example.com/gitea/team/project/issues/42
    message_file: CHANGELOG.md
    message: 'Публикация завершена.'
```

Поддерживаются установка Gitea в подпапке, нестандартный HTTPS-порт и
завершающий слеш в URL. Query-параметры и `#fragment` ссылки не передаются в
API. Текст передаётся в Gitea без преобразования Markdown. Telegram-параметры
`parse_mode` и `document` не используются; `message_file` отправляет текст, а не
вложение.

## Результаты и ошибки

| Выход           | Описание                                                  |
| --------------- | --------------------------------------------------------- |
| `comment_ids`   | JSON-массив ID созданных комментариев, например `[12,13]` |
| `comment_urls`  | JSON-массив ссылок на созданные комментарии               |
| `comment_count` | Количество успешно созданных комментариев                 |

После проверки входов выходы инициализируются значениями `[]`, `[]` и `0`, затем
обновляются после каждого успешного запроса по всем задачам. При ошибке запроса
результаты предыдущих сохраняются, дальнейшая отправка прекращается. Ошибки URL
в `to`, чтения файла, HTTP и сети завершают шаг ошибкой. Для необязательного
уведомления можно явно задать шагу `continue-on-error: true`.

Как в PowerShell-примере, используются HTTPS, заголовок
`Authorization: token ...`, UTF-8 JSON и таймаут 30 секунд на запрос, включая
чтение ответа. Редиректы не выполняются; при HTTP 3xx укажите конечную
HTTPS-ссылку. Токен маскируется в логах, текст сообщения и тело ошибки сервера
не выводятся.

Автоматических повторов нет. Повторный запуск создаёт новые комментарии. После
таймаута или повреждённого ответа сервер уже мог сохранить комментарий —
проверьте issue перед повторной отправкой.

## Разработка

Нужен Node.js 24 и npm:

```shell
npm ci
npm run format:write
npm run all
```

`all` проверяет типы, ESLint, форматирование, запускает тесты и собирает action
через `ncc`. После изменения исходников включайте обновлённый `dist` в коммит:
GitHub Actions запускает `dist/index.js`. CI также проверяет актуальность
сборки.

Тесты подменяют HTTP-запросы и проверяют URL, авторизацию, UTF-8, ошибки,
таймауты, отсутствие повторов и результаты частичной отправки. Реальные
комментарии в Gitea при запуске тестов не создаются.

Основные файлы: `action.yml`, `src/index.ts`, `src/main.ts`, `src/gitea.ts`,
`__tests__`, `dist` и `.github/workflows/ci.yml`.

Справка:
[Gitea: создание комментария](https://docs.gitea.com/api/1.25/operations/issue-create-comment/),
[GitHub: создание JavaScript Action](https://docs.github.com/en/actions/tutorials/create-actions/create-a-javascript-action).

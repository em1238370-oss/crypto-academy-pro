# Как правильно заполнить .env

Файл **.env** нужно править **в редакторе** (Cursor, VS Code, nano), а не вводить переменные в терминал — иначе кавычки и символ `!` ломают команды.

## Формат

Одна строка — одна переменная, без пробелов вокруг `=`:

```
TELEGRAM_API_ID=ваш_api_id_число
TELEGRAM_API_HASH=ваш_api_hash_строка
KRO_SHEET_ID=1C1NQwqmLRg59xgplnz5PeghRxaR_YY2lfSWZAJae6qM
KRO_CHECK_QUEUE_RANGE=check_queue!A2:B
KRO_SCAM_BASE_RANGE=scam_base!A2:H
```

## Google-ключ

**Вариант 1 — JSON в одну строку.**  
Скопируй весь JSON ключа сервисного аккаунта в одну строку (без переносов). В .env можно обернуть значение в **одинарные** кавычки, чтобы символы вроде `!` не мешали:

```
KRO_GOOGLE_CREDENTIALS_JSON='{"type":"service_account","project_id":"...","private_key_id":"...","private_key":"-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n","client_email":"...","client_id":"...","auth_uri":"...","token_uri":"...","auth_provider_x509_cert_url":"...","client_x509_cert_url":"..."}'
```

**Вариант 2 — путь к файлу.**  
Если ключ лежит в файле, например `credentials.json`:

```
GOOGLE_APPLICATION_CREDENTIALS=/Users/elizavetamedvedeva/путь/к/credentials.json
```

(Тогда строку `KRO_GOOGLE_CREDENTIALS_JSON` можно закомментировать или удалить.)

## Важно

- **TELEGRAM_API_HASH** — вставь свой API Hash с my.telegram.org (строка из раздела «API development tools»).
- **KRO_SHEET_ID** — проверь: в ID таблицы буква **l** (эль), а не цифра **1**: в середине должно быть `xgplnz5` и `YY2lf`.
- После сохранения .env в терминале выполни:  
  `set -a && source .env && set +a`  
  затем:  
  `python3 check_once.py @durov`  
  Номер телефона и код вводи **когда их запросит сам скрипт** в терминале, а не как отдельную команду.

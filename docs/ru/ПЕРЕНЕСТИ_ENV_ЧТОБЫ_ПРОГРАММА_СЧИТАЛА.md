# Куда перенести переменные, чтобы программа их подхватила

Программа (бэкенд, проверка каналов, kro-login) читает переменные **только из одного файла** в корне проекта:

```
/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1/.env
```

Файл должен называться именно **`.env`** и лежать в **корне** папки `crypto-academy-pro1` (рядом с `index.html`, `backend`, `scripts`).

---

## Если у тебя всё в документе `env_для_crypto_academy.txt`

### Вариант 1: Скопировать содержимое в .env

1. Открой **env_для_crypto_academy.txt** (в TextEdit или где он у тебя).
2. Выдели всё (`Cmd + A`), скопируй (`Cmd + C`).
3. Открой в редакторе файл **`.env`** в корне проекта:  
   `Documents/Crypto academy pro/crypto-academy-pro1/.env`  
   (если его нет — создай новый файл с именем `.env` в этой папке).
4. Вставь содержимое (`Cmd + V`) и сохрани файл.

После этого и сервер, и `node scripts/kro-login.js` будут использовать твои ключи (Telegram, Google, NOWPayments и т.д.).

### Вариант 2: Сохранить твой файл как .env в проекте

1. В TextEdit (или где открыт **env_для_crypto_academy.txt**) нажми «Сохранить как» / «Duplicate».
2. Укажи папку: **Documents → Crypto academy pro → crypto-academy-pro1**.
3. Имя файла задай: **`.env`** (точка в начале, без .txt).
4. Сохрани. Если спросит «использовать .env?» — да.
5. Старый `.env` в проекте, если был, можно заменить этим.

### Вариант 3: Через терминал (если файл уже в папке проекта)

Если ты положила **env_для_crypto_academy.txt** в папку `crypto-academy-pro1`, в терминале выполни:

```bash
cd "/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1"
cp "env_для_crypto_academy.txt" .env
```

Так содержимое твоего файла станет активным `.env`, и программа начнёт его считать.

---

## Проверка

После переноса запусти проверку (из корня проекта):

```bash
cd "/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1"
node -e "require('dotenv').config({path:'.env'}); console.log('KRO_SHEET_ID:', process.env.KRO_SHEET_ID ? 'есть' : 'нет'); console.log('TELEGRAM_API_ID:', process.env.TELEGRAM_API_ID ? 'есть' : 'нет'); console.log('KRO_GOOGLE_CREDENTIALS_JSON:', process.env.KRO_GOOGLE_CREDENTIALS_JSON ? 'есть' : 'нет');"
```

Должно вывести «есть» по всем трём — тогда сайт и проверка каналов будут использовать твои ключи.

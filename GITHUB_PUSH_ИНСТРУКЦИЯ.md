# Как обновить сайт: пушим в GitHub (решение проблемы доступа)

Чтобы на сайте заработала проверка каналов по ссылкам (те данные, что вы вносите), нужно успешно отправить код в GitHub — тогда Render сам обновит сайт.

У вас сейчас remote настроен на **SSH**, но SSH-ключа нет. Ниже два рабочих варианта.

---

## Вариант А: SSH (один раз настроили — пушите без паролей)

### Шаг 1. Создать SSH-ключ (в терминале у себя)

```bash
ssh-keygen -t ed25519 -C "github" -f ~/.ssh/id_ed25519 -N ""
```

(Просто нажмите Enter, если спросит passphrase — можно оставить пустым.)

### Шаг 2. Показать публичный ключ и скопировать его

```bash
cat ~/.ssh/id_ed25519.pub
```

Выделите **всю** строку (начинается с `ssh-ed25519` и заканчивается вашим email/комментарием), скопируйте (Cmd+C).

### Шаг 3. Добавить ключ в GitHub

1. Откройте: **https://github.com/settings/keys**
2. Кнопка **«New SSH key»**.
3. Title: например `Мой Mac`.
4. В поле **Key** вставьте скопированную строку.
5. **«Add SSH key»**.

### Шаг 4. Проверить и пушить

```bash
cd /Users/elizavetamedvedeva/Documents/GitHub/crypto-academy-pro
ssh -T git@github.com
git push origin main
```

Если после `ssh -T git@github.com` увидите приветствие от GitHub — ключ подхватился. Тогда `git push origin main` должен пройти, и сайт обновится.

---

## Вариант Б: Токен по HTTPS (если SSH не хотите настраивать)

### Шаг 1. Вернуть remote на HTTPS

```bash
cd /Users/elizavetamedvedeva/Documents/GitHub/crypto-academy-pro
git remote set-url origin https://github.com/em1238370-oss/crypto-academy-pro.git
```

### Шаг 2. Создать токен на GitHub

1. Откройте: **https://github.com/settings/tokens**
2. **Generate new token** → **Generate new token (classic)**.
3. Название: `push crypto-academy-pro`, галочка **repo**.
4. Сгенерируйте и **скопируйте токен** (один раз показывается).

### Шаг 3. Пушить

```bash
git push origin main
```

- **Username:** `em1238370-oss`
- **Password:** вставьте **токен** (не пароль от аккаунта).

Чтобы macOS запомнил учётные данные:

```bash
git config --global credential.helper osxkeychain
```

---

## После успешного push

- Код попадёт в репозиторий **em1238370-oss/crypto-academy-pro**.
- Render подхватит изменения и сам задеплоит сайт.
- На сайте появятся обновления, в том числе работа с данными по каналам (ссылки на каналы крипты и проверка по ним).

Если при выполнении шагов появится ошибка — скопируйте её сюда, разберём точечно.

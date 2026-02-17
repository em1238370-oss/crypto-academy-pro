# 🔄 Как обновить сайт через GitHub Desktop (как раньше)

## ⚠️ Важно: Две папки

У вас **две папки** с проектом:

1. **`/Users/macmini/crypto-website`** — возможно, её открывает GitHub Desktop
2. **`/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1`** — здесь все наши изменения

---

## ✅ Решение: Добавить правильную папку в GitHub Desktop

### Шаг 1. Откройте GitHub Desktop

### Шаг 2. Добавьте папку crypto-academy-pro1

1. Меню **File** → **Add Local Repository...**
2. Нажмите **Choose...** и выберите папку:
   ```
   Documents → Crypto academy pro → crypto-academy-pro1
   ```
   Полный путь: `/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1`
3. Нажмите **Add Repository**

### Шаг 3. Увидите кнопку Push origin

После добавления вы увидите:
- **5 commits** готовых к отправке
- Кнопку **Push origin**

### Шаг 4. Нажмите Push origin

Готово! Сайт обновится через 1–2 минуты на Render.

---

## 🔁 Если хотите продолжать работать через crypto-website

Тогда нужно **копировать файлы** из crypto-academy-pro1 в crypto-website вручную:

1. Откройте Finder
2. Скопируйте эти 3 файла из `crypto-academy-pro1` в `crypto-website` (замените существующие):
   - `sub-sites/crypto-coach/index.html`
   - `sub-sites/crypto-coach/styles.css`
   - `sub-sites/crypto-coach/scripts/table-modules.js`
3. Откройте GitHub Desktop (crypto-website)
4. Увидите Changes — нажмите **Commit** и **Push origin**

---

## 📍 Где лежат файлы

**crypto-academy-pro1** (все наши изменения):
```
/Users/macmini/Documents/Crypto academy pro/crypto-academy-pro1/
```

**crypto-website** (если GitHub Desktop открыт на ней):
```
/Users/macmini/crypto-website/
```

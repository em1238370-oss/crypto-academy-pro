# Как убрать «crypto-academy-pro» из адресной строки

В **коде** уже везде стоит **Prover Kriptu** (заголовок вкладки, название в навбаре и чате).

Адрес в браузере **crypto-academy-pro.onrender.com** задаётся **на Render**, не в коде. Чтобы он стал, например, **prover-kriptu.onrender.com**:

1. Зайди на [dashboard.render.com](https://dashboard.render.com).
2. Открой свой сервис (сейчас он называется **crypto-academy-pro**).
3. **Settings** → вверху есть поле **Name**.
4. Смени имя на **prover-kriptu** (латиницей, без пробелов).
5. Сохрани. Новый URL будет: **https://prover-kriptu.onrender.com**

После этого в адресной строке будет отображаться **prover-kriptu.onrender.com** вместо crypto-academy-pro.

Если не переименовывать сервис — заголовок вкладки и весь сайт уже показывают **Prover Kriptu** после деплоя последних изменений (после `git push` и обновления на Render).

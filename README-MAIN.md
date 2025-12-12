# Главный сайт - Crypto Academy Pro

Это главный сайт проекта. Здесь находится основной функционал с ChatGPT интеграцией и оплатой.

## Структура проекта

```
crypto-website/
├── backend/              # Backend сервер (Node.js)
│   ├── server.js         # Главный файл сервера
│   ├── .env              # Конфигурация (API ключи)
│   └── package.json      # Зависимости
├── scripts/
│   └── chatbot.js        # Логика чата
├── styles.css            # Стили главного сайта
├── index.html            # Главная страница
└── assets/               # Изображения и ресурсы
```

## Запуск

### Backend:
```bash
cd backend
npm run dev
```

### Frontend:
```bash
python3 -m http.server 5500
```

Сайт доступен на: `http://localhost:5500`

## Примечание

Это главный сайт. Новые сайты будут создаваться в отдельных папках и прикрепляться к этому главному сайту.


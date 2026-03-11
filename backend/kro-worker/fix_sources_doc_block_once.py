#!/usr/bin/env python3
"""
Однократное принудительное обновление блока «События за период» в документе Sources and Data.
Запуск (из домашней папки):
  cd ~/Documents/GitHub/crypto-academy-pro/backend/kro-worker && python3 fix_sources_doc_block_once.py
Режим без API (только файл, вставка вручную — если в браузере мешают расширения/TrustedScript):
  python3 fix_sources_doc_block_once.py --file-only
"""
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
# Подгружаем .env
for base in (SCRIPT_DIR, os.path.normpath(os.path.join(SCRIPT_DIR, '..', '..'))):
    for name in ('.env', 'env'):
        path = os.path.join(base, name)
        if os.path.isfile(path):
            with open(path, 'r', encoding='utf-8', errors='replace') as f:
                for line in f:
                    line = line.strip()
                    if not line or line.startswith('#') or '=' not in line:
                        continue
                    key, _, value = line.partition('=')
                    key, value = key.strip(), value.strip()
                    if (value.startswith("'") and value.endswith("'")) or (value.startswith('"') and value.endswith('"')):
                        value = value[1:-1]
                    if key and key not in os.environ:
                        os.environ[key] = value
            break

# Импорт после env
from update_live_log_5min import (
    load_log_lines,
    trim_log_to_start_date,
    format_live_log_grouped,
    update_doc_placeholder,
    PLACEHOLDER,
    START_DATE_DDMMYYYY,
    DEFAULT_SOURCES_DOC_ID,
)
DATA_DIR = os.path.join(os.path.dirname(SCRIPT_DIR), 'data')
PASTE_FILE = os.path.join(DATA_DIR, 'sources_doc_block_to_paste.txt')

def main():
    file_only = '--file-only' in sys.argv or '-f' in sys.argv

    doc_id = (os.environ.get('KRO_SOURCES_DOC_ID') or '').strip() or DEFAULT_SOURCES_DOC_ID
    if not doc_id:
        print('KRO_SOURCES_DOC_ID не задан. Задайте в .env или он возьмётся по умолчанию.', file=sys.stderr)
        doc_id = DEFAULT_SOURCES_DOC_ID

    lines = load_log_lines()
    lines = trim_log_to_start_date(lines, START_DATE_DDMMYYYY)
    formatted = format_live_log_grouped(lines)
    start_line = '%s 00:00 — Отчёт с этого дня (с 00:00).' % START_DATE_DDMMYYYY
    if formatted:
        content = start_line + '\n' + '\n'.join(formatted) + '\n' + PLACEHOLDER + '\n\nКанонический источник методологии\nОтчёт «СКАМ‑МОНИТОРИНГ | Source & Data» (PDF / Google Doc).'
    else:
        content = start_line + '\n' + PLACEHOLDER + '\n\nКанонический источник методологии\nОтчёт «СКАМ‑МОНИТОРИНГ | Source & Data» (PDF / Google Doc).'
    last_line = formatted[-1] if formatted else None

    os.makedirs(DATA_DIR, exist_ok=True)
    with open(PASTE_FILE, 'w', encoding='utf-8') as f:
        f.write(content)
    print('Текст блока записан в файл: %s' % PASTE_FILE, file=sys.stderr)

    url = 'https://docs.google.com/document/d/' + doc_id + '/edit'
    print('', file=sys.stderr)
    print('Документ (откройте именно эту ссылку):', file=sys.stderr)
    print(url, file=sys.stderr)
    print('', file=sys.stderr)

    if file_only:
        print('Режим --file-only: API не вызывается. Вставьте блок вручную:', file=sys.stderr)
        print('1. Откройте документ по ссылке выше (лучше в режиме инкогнито или отключите расширения — иначе могут мешать TrustedScript/расширения).', file=sys.stderr)
        print('2. В документе найдите строку «События за период — ниже».', file=sys.stderr)
        print('3. Выделите от неё всё до конца документа и удалите (Backspace).', file=sys.stderr)
        print('4. Откройте файл (скопируйте путь и откройте в Блокноте/TextEdit):', file=sys.stderr)
        print('   %s' % PASTE_FILE, file=sys.stderr)
        print('5. В файле: Cmd+A, Cmd+C. В документе: поставьте курсор на место удалённого, Cmd+V.', file=sys.stderr)
        print('6. Сохраните документ (Cmd+S).', file=sys.stderr)
        return

    print('Обновляю документ через API...', file=sys.stderr)
    ok = update_doc_placeholder(doc_id, content, last_line=last_line)
    if ok:
        print('', file=sys.stderr)
        print('Готово. Документ обновлён по API.', file=sys.stderr)
        print('Обновите страницу документа (Cmd+R). Если открыт другой документ — откройте ссылку выше.', file=sys.stderr)
    else:
        print('', file=sys.stderr)
        print('Обновление по API не удалось. Используйте ручную вставку:', file=sys.stderr)
        print('1. Откройте документ по ссылке выше.', file=sys.stderr)
        print('2. Найдите строку «События за период — ниже».', file=sys.stderr)
        print('3. Удалите от неё всё до раздела «Канонический источник» (или до конца документа).', file=sys.stderr)
        print('4. Откройте файл %s' % PASTE_FILE, file=sys.stderr)
        print('5. Скопируйте весь текст из файла (Cmd+A, Cmd+C) и вставьте в документ (Cmd+V) на место удалённого.', file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()

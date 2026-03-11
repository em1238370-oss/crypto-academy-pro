#!/usr/bin/env python3
"""
Однократное принудительное обновление блока «События за период» в документе Sources and Data.
Запуск: из папки kro-worker выполнить: python3 fix_sources_doc_block_once.py
После запуска открыть документ по выведенной ссылке и обновить страницу (F5).
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

def main():
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

    print('Обновляю документ %s...' % doc_id[:20] + '...', file=sys.stderr)
    ok = update_doc_placeholder(doc_id, content, last_line=last_line)
    if ok:
        url = 'https://docs.google.com/document/d/' + doc_id + '/edit'
        print('', file=sys.stderr)
        print('Готово. Документ обновлён.', file=sys.stderr)
        print('', file=sys.stderr)
        print('Откройте ссылку и обновите страницу (F5 или Cmd+R):', file=sys.stderr)
        print(url, file=sys.stderr)
        print('', file=sys.stderr)
        print('Если изменений не видно: закройте все вкладки с этим документом и откройте ссылку снова или откройте в режиме инкогнито.', file=sys.stderr)
    else:
        print('Ошибка обновления. Проверьте: 1) файл credentials.json в этой папке, 2) документ расшарен на email из ключа.', file=sys.stderr)
        sys.exit(1)

if __name__ == '__main__':
    main()

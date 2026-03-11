#!/usr/bin/env python3
"""
Проверка: какой документ видит API, есть ли в нём плейсхолдер «События за период — ниже».
Запуск: cd backend/kro-worker && python3 check_sources_doc.py
"""
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
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

from update_live_log_5min import (
    _get_creds,
    _find_all_placeholder_ranges,
    _find_first_log_line_index,
    PLACEHOLDER,
    DEFAULT_SOURCES_DOC_ID,
    ANCHOR_BEFORE_LOG,
)

def main():
    doc_id = (os.environ.get('KRO_SOURCES_DOC_ID') or '').strip() or DEFAULT_SOURCES_DOC_ID
    url = 'https://docs.google.com/document/d/' + doc_id + '/edit'

    print('ID документа (должен совпадать с тем, что в твоей ссылке):', doc_id, file=sys.stderr)
    print('URL документа:', url, file=sys.stderr)
    print('Твоя ссылка: https://docs.google.com/document/d/1VA3Vrt6sak_TXypqBqQalOWeOJHdQm20gz80s6rfi58/edit', file=sys.stderr)
    print('', file=sys.stderr)

    creds = _get_creds()
    if not creds:
        print('Ошибка: нет учётных данных Google (credentials.json или KRO_GOOGLE_CREDENTIALS_JSON в .env)', file=sys.stderr)
        sys.exit(1)
    from googleapiclient.discovery import build
    service = build('docs', 'v1', credentials=creds)
    try:
        doc = service.documents().get(documentId=doc_id).execute()
    except Exception as e:
        print('Ошибка при открытии документа:', e, file=sys.stderr)
        print('Проверь: 1) сервисный аккаунт имеет доступ к документу (Поделиться → добавить email из ключа); 2) ID документа верный.', file=sys.stderr)
        sys.exit(1)

    title = doc.get('title', '') or '(без названия)'
    body = doc.get('body', {})
    content = body.get('content', [])
    doc_len = content[-1].get('endIndex', 0) if content else 0

    print('Название документа по API:', title, file=sys.stderr)
    print('Длина документа (символов):', doc_len, file=sys.stderr)
    print('Ищем плейсхолдер: «%s»' % PLACEHOLDER, file=sys.stderr)

    ranges = _find_all_placeholder_ranges(service, doc_id, PLACEHOLDER)
    if not ranges:
        print('Плейсхолдер НЕ НАЙДЕН. Скрипт не сможет обновить блок.', file=sys.stderr)
        print('В документе в блоке «Обновления каждые 5 мин» должна быть ровно такая строка (скопируй):', file=sys.stderr)
        print('  События за период — ниже', file=sys.stderr)
        sys.exit(1)
    print('Найдено вхождений плейсхолдера:', len(ranges), file=sys.stderr)
    for i, (start, end) in enumerate(ranges):
        print('  Вхождение %s: позиции %s — %s' % (i + 1, start, end), file=sys.stderr)
    first_log = _find_first_log_line_index(service, doc_id)
    if first_log is not None:
        print('Первая строка лога (после «%s»): позиция %s' % (ANCHOR_BEFORE_LOG, first_log), file=sys.stderr)
        print('Если плейсхолдер только в конце: удалим от %s до конца (~%s символов).' % (first_log, doc_len - first_log), file=sys.stderr)
    else:
        print('Строку лога (DD.MM.YYYY HH:MM) после якоря не нашли.', file=sys.stderr)
    print('', file=sys.stderr)
    print('Всё ок: документ тот же, плейсхолдер есть. Запусти: python3 fix_sources_doc_block_once.py', file=sys.stderr)

if __name__ == '__main__':
    main()

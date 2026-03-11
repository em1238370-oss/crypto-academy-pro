#!/usr/bin/env python3
"""
Однократная синхронизация: записать весь текст из Sources-and-Data-ВСТАВИТЬ-В-GOOGLE-DOC.txt
в документ Google «Sources and Data». Все изменения — именно в этот документ.
Запуск: cd backend/kro-worker && python3 sync_sources_doc_from_file.py
"""
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.normpath(os.path.join(SCRIPT_DIR, '..', '..'))
for base in (SCRIPT_DIR, PROJECT_ROOT):
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

TXT_FILE = os.path.join(PROJECT_ROOT, 'Sources-and-Data-ВСТАВИТЬ-В-GOOGLE-DOC.txt')
DEFAULT_DOC_ID = '1VA3Vrt6sak_TXypqBqQalOWeOJHdQm20gz80s6rfi58'


def _get_creds():
    from update_live_log_5min import _get_creds as get_creds
    return get_creds()


def main():
    doc_id = (os.environ.get('KRO_SOURCES_DOC_ID') or '').strip() or DEFAULT_DOC_ID
    if not os.path.isfile(TXT_FILE):
        print('Файл не найден: %s' % TXT_FILE, file=sys.stderr)
        sys.exit(1)
    with open(TXT_FILE, 'r', encoding='utf-8') as f:
        full = f.read()
    # Текст от «Sources and Data» до конца (без инструкции ▼▼▼)
    start_marker = 'Sources and Data — источники и данные'
    idx = full.find(start_marker)
    if idx >= 0:
        text_to_insert = full[idx:].strip() + '\n'
    else:
        text_to_insert = full.strip() + '\n'

    creds = _get_creds()
    if not creds:
        print('Нет учётных данных Google (credentials.json или KRO_GOOGLE_CREDENTIALS_JSON)', file=sys.stderr)
        sys.exit(1)

    from googleapiclient.discovery import build
    service = build('docs', 'v1', credentials=creds)
    try:
        doc = service.documents().get(documentId=doc_id).execute()
    except Exception as e:
        print('Ошибка доступа к документу: %s' % e, file=sys.stderr)
        sys.exit(1)

    body = doc.get('body', {})
    content = body.get('content', [])
    end_index = content[-1].get('endIndex', 2) if content else 2
    # Удалить весь контент (индексы в API: 1-based, конец не включая последний \n часто даёт 400)
    delete_end = end_index - 1 if end_index > 2 else 1
    if delete_end <= 1:
        delete_end = 1

    requests = [
        {'deleteContentRange': {'range': {'startIndex': 1, 'endIndex': delete_end}}},
        {'insertText': {'location': {'index': 1}, 'text': text_to_insert}}
    ]
    try:
        service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
        print('Готово. Документ «Sources and Data» обновлён: в него записан весь текст из файла.', file=sys.stderr)
        print('URL: https://docs.google.com/document/d/%s/edit' % doc_id, file=sys.stderr)
    except Exception as e:
        if '400' in str(e) and 'newline' in str(e).lower():
            requests[0]['deleteContentRange']['range']['endIndex'] = delete_end - 1
            try:
                service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()
                print('Готово. Документ «Sources and Data» обновлён.', file=sys.stderr)
                print('URL: https://docs.google.com/document/d/%s/edit' % doc_id, file=sys.stderr)
            except Exception as e2:
                print('Ошибка: %s' % e2, file=sys.stderr)
                sys.exit(1)
        else:
            print('Ошибка: %s' % e, file=sys.stderr)
            sys.exit(1)


if __name__ == '__main__':
    main()

#!/usr/bin/env python3
"""
Вставить в Google Doc «Sources and Data» таблицу «Объекты и риск» (8 столбцов × 61 строка:
1 заголовок + до 60 объектов). Запускать один раз, если в документе ещё нет такой таблицы.

Запуск из backend/kro-worker:
  KRO_SOURCES_DOC_ID=... python3 insert_risk_table_into_sources_doc.py

Или из backend/ с переменной окружения. После вставки запустите update_sources_doc_once.py —
он заполнит таблицу данными из kro-12h-stats.json.
"""
import os
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '..'))

for base in (SCRIPT_DIR, BACKEND_DIR, os.path.normpath(os.path.join(BACKEND_DIR, '..'))):
    for name in ('env', '.env'):
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

from run_12h_monitor import (
    _discover_tables_in_doc,
    _get_table_cell_indices,
)

TABLE_8_HEADERS = [
    'Объект / ссылка',
    'Тип',
    'Источник',
    'Краткое описание',
    'VIP / деньги',
    'Жалобы / отзывы',
    'Признаки риска (флаги)',
    'Итоговый статус',
]


def get_service():
    creds = None
    json_str = os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON')
    json_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')
    if json_str:
        try:
            import json
            from google.oauth2 import service_account
            creds = service_account.Credentials.from_service_account_info(json.loads(json_str))
        except Exception:
            pass
    if not creds and json_path and os.path.isfile(json_path):
        try:
            from google.oauth2 import service_account
            creds = service_account.Credentials.from_service_account_file(json_path)
        except Exception:
            pass
    if not creds:
        for name in ('kro-google-credentials.json', 'credentials.json'):
            path = os.path.join(SCRIPT_DIR, name)
            if os.path.isfile(path):
                try:
                    from google.oauth2 import service_account
                    creds = service_account.Credentials.from_service_account_file(path)
                    break
                except Exception:
                    pass
    if not creds:
        print('Нет учётных данных. Задайте GOOGLE_APPLICATION_CREDENTIALS или положите kro-google-credentials.json в %s' % SCRIPT_DIR, file=sys.stderr)
        return None
    from googleapiclient.discovery import build
    return build('docs', 'v1', credentials=creds)


def main():
    doc_id = (os.environ.get('KRO_SOURCES_DOC_ID') or '').strip()
    if not doc_id:
        doc_id = '1VA3Vrt6sak_TXypqBqQalOWeOJHdQm20gz80s6rfi58'
        print('Используется документ по умолчанию. Чтобы задать свой: KRO_SOURCES_DOC_ID=...', file=sys.stderr)

    service = get_service()
    if not service:
        sys.exit(1)

    doc = service.documents().get(documentId=doc_id).execute()
    tables = _discover_tables_in_doc(doc)
    for t in tables:
        if t['cols'] == 8:
            print('В документе уже есть таблица на 8 столбцов. Ничего не вставляю.', file=sys.stderr)
            print('Запустите: python3 update_sources_doc_once.py — чтобы заполнить её данными.', file=sys.stderr)
            sys.exit(0)

    body = doc.get('body', {})
    content = body.get('content', [])
    end_index = content[-1].get('endIndex', 2) if content else 2
    if end_index <= 1:
        end_index = 2
    insert_index = max(1, end_index - 1)

    title = '\n\nТаблица «Объекты и риск» (данные за период):\n\n'
    requests = [
        {'insertText': {'location': {'index': insert_index}, 'text': title}},
    ]
    table_index = insert_index + len(title)
    requests.append({
        'insertTable': {
            'rows': 61,
            'columns': 8,
            'location': {'index': table_index},
        },
    })
    service.documents().batchUpdate(documentId=doc_id, body={'requests': requests}).execute()

    doc = service.documents().get(documentId=doc_id).execute()
    body = doc.get('body', {})
    cells = _get_table_cell_indices(body, table_index)
    if not cells:
        print('Таблица вставлена, но не удалось получить индексы ячеек. Заголовки заполните вручную.', file=sys.stderr)
        print('URL: https://docs.google.com/document/d/%s/edit' % doc_id, file=sys.stderr)
        sys.exit(0)

    cells_by_row = sorted(cells, key=lambda x: (x[0], x[1]))
    header_cells = [c for c in cells_by_row if c[0] == 0]
    for ci, h in enumerate(TABLE_8_HEADERS):
        if ci < len(header_cells):
            si = header_cells[ci][2]
            try:
                service.documents().batchUpdate(documentId=doc_id, body={'requests': [
                    {'insertText': {'location': {'index': si}, 'text': h[:500]}},
                ]}).execute()
            except Exception as e:
                print('Ячейка заголовка %s: %s' % (ci + 1, e), file=sys.stderr)

    try:
        service.documents().batchUpdate(documentId=doc_id, body={'requests': [{
            'updateTableCellStyle': {
                'tableCellStyle': {'backgroundColor': {'color': {'rgbColor': {'red': 0.9, 'green': 0.9, 'blue': 0.9}}}},
                'fields': 'backgroundColor',
                'tableRange': {
                    'tableCellLocation': {'tableStartLocation': {'index': table_index}, 'rowIndex': 0, 'columnIndex': 0},
                    'rowSpan': 1,
                    'columnSpan': 8,
                },
            },
        }]}).execute()
    except Exception:
        pass

    print('Таблица «Объекты и риск» (8×61) вставлена в конец документа. Заголовки заполнены.', file=sys.stderr)
    print('Дальше запустите: python3 update_sources_doc_once.py', file=sys.stderr)
    print('URL: https://docs.google.com/document/d/%s/edit' % doc_id)


if __name__ == '__main__':
    main()

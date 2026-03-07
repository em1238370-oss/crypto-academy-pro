#!/usr/bin/env python3
"""
Однократно подставить в Google Doc «Источники и данные» новую структуру (7 блоков).
Использует данные из kro-12h-stats.json; таблицы 4–5 могут быть пустыми.
Запуск из backend/kro-worker:
  python3 update_sources_doc_once.py
"""
import os
import warnings
# Убрать шум про Python 3.9 от google-auth / api_core
warnings.filterwarnings('ignore', category=FutureWarning)
import sys
import json
from datetime import timedelta

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '..'))
DATA_DIR = os.path.join(BACKEND_DIR, 'data')
STATS_FILE = os.path.join(DATA_DIR, 'kro-12h-stats.json')

# подгрузить env до импорта run_12h_monitor
for base in (SCRIPT_DIR, os.path.normpath(os.path.join(SCRIPT_DIR, '..', '..'))):
    for name in ('env', '.env'):
        path = os.path.join(base, name)
        if not os.path.isfile(path):
            continue
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
    _msk_now,
    build_sources_doc_text,
    update_sources_google_doc,
)

HOURS_12 = 12


def main():
    sources_doc_id = os.environ.get('KRO_SOURCES_DOC_ID', '').strip()
    if not sources_doc_id:
        print('KRO_SOURCES_DOC_ID не задан. Задайте в .env и запустите снова.', file=sys.stderr)
        sys.exit(1)

    now_msk_dt = _msk_now()
    date_str = now_msk_dt.strftime('%d.%m.%Y')
    if now_msk_dt.hour < 12:
        period_start = date_str + ' 00:00'
        period_end = date_str + ' 11:55'
    else:
        period_start = date_str + ' 12:00'
        period_end = date_str + ' 23:55'
    collect_time_msk = now_msk_dt.strftime('%d %B %H:%M MSK').replace('February', 'февраля').replace('March', 'марта').replace('January', 'января')

    stats = {}
    if os.path.isfile(STATS_FILE):
        try:
            with open(STATS_FILE, 'r', encoding='utf-8') as f:
                stats = json.load(f)
        except Exception as e:
            print('Не удалось загрузить %s: %s' % (STATS_FILE, e), file=sys.stderr)

    new_scams = stats.get('new_scam_channels', stats.get('new_scams', 0))
    losses_12h = stats.get('losses_12h', 0)
    telegram_channels = stats.get('telegram_channels', 0)
    courses_products = stats.get('courses_products', stats.get('courses', 0))
    top3 = stats.get('top3_today', stats.get('top3', []))
    report_url = stats.get('report_doc_url') or ''
    risk_rows = stats.get('risk_rows', [])
    complaints_rows = stats.get('complaints_rows', [])
    victims_12h = stats.get('victims_12h', 0)
    complaints_count = sum((r.get('complaints') or 0) for r in complaints_rows)
    unavailable_sources = stats.get('unavailable_sources', [])

    if not risk_rows and not complaints_rows:
        print('В kro-12h-stats.json нет risk_rows/complaints_rows — таблицы будут пустыми. Для полных данных запусти: python3 run_12h_monitor.py', file=sys.stderr)

    doc_text, structured_data = build_sources_doc_text(
        collect_time_msk,
        [],  # new_tgstat (не пересобираем, берём из risk_rows)
        [],  # telega_channels
        complaints_rows,
        new_scams,
        losses_12h,
        telegram_channels,
        courses_products,
        top3,
        report_url=report_url,
        period_start=period_start,
        period_end=period_end,
        victims_12h=victims_12h,
        complaints_count=complaints_count,
        risk_rows=risk_rows if risk_rows else None,
        unavailable_sources=unavailable_sources or None,
    )
    url = update_sources_google_doc(sources_doc_id, doc_text, structured_data)
    if url:
        print('Документ обновлён до структуры 7 блоков: %s' % url)
        print('Обнови страницу (F5) в браузере.')
    else:
        print('Не удалось обновить документ. См. stderr.', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()

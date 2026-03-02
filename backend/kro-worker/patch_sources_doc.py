#!/usr/bin/env python3
"""
Один раз запустите: python3 patch_sources_doc.py
Скрипт исправит run_12h_monitor.py: добавит _msk_now, build_sources_doc_text и изменит
update_sources_google_doc(doc_id, doc_text), чтобы документ «Источники и данные» заполнялся реальными данными.
"""
import os
import re

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
TARGET = os.path.join(SCRIPT_DIR, 'run_12h_monitor.py')

with open(TARGET, 'r', encoding='utf-8') as f:
    content = f.read()

# Уже пропатчено?
if 'def _msk_now():' in content and 'def build_sources_doc_text(' in content:
    print('Файл уже содержит _msk_now и build_sources_doc_text. Всё ок.')
    exit(0)

# Блок для вставки после SOURCES_DOC_TITLE
INSERT = '''
def _msk_now():
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo('Europe/Moscow'))
    except ImportError:
        return datetime.now(timezone.utc) + timedelta(hours=3)

def build_sources_doc_text(collect_time_msk, new_tgstat, telega_channels, complaints_rows,
                           new_scams_count, total_losses_12h, telegram_channels_count,
                           courses, top3, report_url=None):
    lines = [
        '# СКАМ-МОНИТОРИНГ КРИПТО | АВТООТЧЁТ', '',
        '%s → ТВОЯ ПРОВЕРКА (15 мин)' % collect_time_msk, '',
        '——— ГОТОВЫЕ ЦИФРЫ ДЛЯ САЙТА ———', '',
        'Новых скам-каналов | %s' % new_scams_count,
        'Потери за 12 ч | %s ₽' % total_losses_12h,
        'Telegram каналов | %s' % telegram_channels_count,
        'Курсов/продуктов | %s' % courses, '', 'ТОП-3 СЕГОДНЯ:', ''
    ]
    for i, t in enumerate((top3 or [])[:3], 1):
        ch = t.get('channel') or t.get('name') or '—'
        losses = t.get('losses') or t.get('sum') or 0
        complaints = t.get('complaints', 0)
        lines.append('  %s. %s — %s ₽, жалоб: %s' % (i, ch, losses, complaints))
    if not (top3 or []):
        lines.append('  (нет данных)')
    lines.extend(['', '——— SOURCE & DATA ———', ''])
    lines.append('TGStat → %s' % collect_time_msk)
    for row in (new_tgstat or [])[:25]:
        ch, date = row.get('channel', '—'), row.get('date', '—')
        link = row.get('link', 'https://t.me/' + str(ch).lstrip('@'))
        lines.append('  ✓ %s | %s | %s' % (date, ch, link))
    lines.extend(['', 'Telega → %s' % collect_time_msk])
    for row in (telega_channels or [])[:25]:
        lines.append('  ✓ %s | %s' % (row.get('channel', '—'), row.get('link', '—')))
    lines.extend(['', 'ЖАЛОБЫ:'])
    for row in (complaints_rows or [])[:30]:
        lines.append('  %s — жалоб: %s, потери: %s ₽' % (row.get('channel', '—'), row.get('complaints', 0), row.get('losses', 0)))
    lines.extend(['', '——— ЧЕКЛИСТ ———', 'Время сбора: %s' % collect_time_msk, 'Статус: ЖДУ ТВОЕГО ✅ / ❌', ''])
    lines.append(report_url or '(отчёт после 11:00 или 23:00 MSK)')
    return '\\n'.join(lines)

'''

# 1) Вставить _msk_now и build_sources_doc_text после SOURCES_DOC_TITLE
old_anchor = "SOURCES_DOC_TITLE = 'KRO: источники данных и ссылки'\n\ndef _get_sources_doc_text"
if old_anchor in content:
    content = content.replace(
        old_anchor,
        "SOURCES_DOC_TITLE = 'KRO: источники данных и ссылки'\n" + INSERT + "def _get_sources_doc_text",
        1
    )
    print('Добавлены _msk_now и build_sources_doc_text.')
else:
    print('Якорь 1 не найден, пропуск вставки функций.')

# 2) Заменить сигнатуру update_sources_google_doc
content = content.replace(
    "def update_sources_google_doc(doc_id, report_title=None, report_url=None):\n    \"\"\"\n    Обновляет единый Google Doc «Источники и данные»: подставляет текст с источниками и ссылками\n    и ссылку на последний автоотчёт. Нужен KRO_SOURCES_DOC_ID в env (ID из URL документа).\n    \"\"\"",
    "def update_sources_google_doc(doc_id, doc_text):\n    \"\"\"Пишет в документ «Источники и данные» готовый текст doc_text.\"\"\"",
    1
)
content = content.replace(
    "    text = _get_sources_doc_text(report_title, report_url)",
    "    text = doc_text",
    1
)

# 3) Заменить вызов в main()
old_main = """    # 5b) Обновить единый Google Doc «Источники и данные»
    sources_doc_id = os.environ.get('KRO_SOURCES_DOC_ID', '').strip()
    if sources_doc_id:
        print('Обновляю Google Doc «Источники и данные»...', flush=True)
        url = update_sources_google_doc(
            sources_doc_id,
            report_title=title if report_doc_url else None,
            report_url=report_doc_url
        )"""

new_main = """    # 5b) Обновить документ «Источники и данные» — текст собираем здесь
    sources_doc_id = os.environ.get('KRO_SOURCES_DOC_ID', '').strip()
    if sources_doc_id:
        print('Обновляю Google Doc «Источники и данные»...', flush=True)
        now_msk_dt = _msk_now()
        collect_time_msk = now_msk_dt.strftime('%d %%B %%H:%%M MSK').replace('February', 'февраля').replace('March', 'марта').replace('January', 'января')
        doc_text = build_sources_doc_text(
            collect_time_msk, new_tgstat, telega_channels, complaints_rows,
            new_scams_count, total_losses_12h, len(complaints_rows), 0, top3,
            report_doc_url
        )
        url = update_sources_google_doc(sources_doc_id, doc_text)"""

# В new_main strftime использует %% для экранирования в replace
new_main = new_main.replace('%%', '%')

if old_main in content:
    content = content.replace(old_main, new_main, 1)
    print('Обновлён вызов в main().')
else:
    print('Блок main() не найден (возможно уже обновлён).')

with open(TARGET, 'w', encoding='utf-8') as f:
    f.write(content)

print('Готово. Запустите: MODE=collect python3 run_12h_monitor.py')

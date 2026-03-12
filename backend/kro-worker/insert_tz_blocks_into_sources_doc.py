#!/usr/bin/env python3
"""
Вставить в Google Doc «Sources and Data» пять блоков ТЗ (точечно, без перезаписи документа):
1) Правила по времени — после «Все каналы и детали по ним фиксируются только в таблице.»
2) Маршрут поиска — после «никаких списков @каналов и «(3/6 рисков)» в логах.»
3–5) Чек‑лист, Честность данных, Пример строки — после «только как резюме предыдущих столбцов.»

Запуск из backend/kro-worker (или из корня с GOOGLE_APPLICATION_CREDENTIALS):
  python3 insert_tz_blocks_into_sources_doc.py

Требования: документ доступен сервисному аккаунту (Поделиться → редактор = client_email из credentials).
"""
import os
import re
import sys

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '..'))
PROJECT_ROOT = os.path.normpath(os.path.join(BACKEND_DIR, '..'))

for base in (SCRIPT_DIR, BACKEND_DIR, PROJECT_ROOT):
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

DOC_ID = os.environ.get('KRO_SOURCES_DOC_ID', '1VA3Vrt6sak_TXypqBqQalOWeOJHdQm20gz80s6rfi58').strip() or '1VA3Vrt6sak_TXypqBqQalOWeOJHdQm20gz80s6rfi58'

# Тексты пяти блоков (как в Sources-and-Data-ВСТАВИТЬ-В-GOOGLE-DOC.txt)
BLOCK_1 = """

Правила по времени (обязательно)
1. Для каждого дня в документе используется только один диапазон:
   — Период: DD.MM.YYYY 00:00 – DD.MM.YYYY 23:55 (MSK)
   — Время формирования: DD месяц, 23:55 MSK
2. Внутри «Временной линии дня» время всегда идёт по порядку, от 00:00 до 23:55.
3. Каждое значение HH:MM можно использовать только один раз за день.
   Если уже записана строка на 03:00, в этот день второй строки «03:00 — …» быть не должно.
4. Пример правильной последовательности (00:00, 00:05, 00:10, 00:20, 00:30):
   — 00:00 — Начат сбор данных за период 00:00–23:55.
   — 00:05 — Выполнен широкий тематический поиск по крипто‑сигналам: проверены несколько Telegram‑каталогов, группы запросов по сигналам, VIP и риску.
   — 00:10 — Выполнен только базовый проход по доступным каталогам и кэшу жалоб; для полного отрицательного вывода нужен расширенный поиск по Telegram и интернету.
   — 00:20 — По широкому поиску подтверждены новые релевантные объекты; начата проверка описаний, закрепов и последних постов.
   — 00:30 — Новых подтверждённых объектов за интервал не выявлено; фильтрация велась по крипто‑сигналам, VIP, психотоксичности и нарушениям риск‑менеджмента.
5. В лог по времени запрещено вставлять длинные списки каналов. Лог фиксирует только:
   — какие типы источников проверены,
   — какие группы запросов использовались,
   — 1–3 конкретные ссылки на реально проверенные страницы/каналы,
   — был ли проход широким или только базовым,
   — были ли ошибки/недоступные источники.
"""

BLOCK_2 = """

Маршрут поиска (где и как искать)

Шаг 1. Поиск каналов (Telegram)
1. Поиск должен быть широким: используй несколько Telegram‑каталогов, глобальный поиск Telegram, чаты/группы с жалобами и хотя бы одну свежую интернет‑подборку или обзор.
2. Используй несколько групп запросов:
   — сигналы и сделки: signal, signals, сигналы, trade, trading, entry, long, short, take profit, stop loss, TP, SL;
   — доход и чудеса: доход, заработок, profit, passive income, x2, x5, 100%, гарантия, без риска, risk free;
   — VIP и приват: VIP, закрытый канал, private, inner circle, подписка, плати, курс, обучение, приватный чат;
   — азарт и нарушение риска: отбить убыток, отыграться, слил, слив, залить, плечо, левередж, high risk, всё плечом.
2а. В каждом 5‑минутном отчёте обязательно указывай 1–3 конкретные ссылки на реально проверенные страницы поиска, каталоги, найденные каналы или чаты жалоб.
3. Отбирай только те каналы, которые: связаны с криптой/трейдингом; дают сигналы или обещают доход; продают VIP, курсы, платные подписки.
3. Каналы, которые просто дают новости/аналитику без продажи сигналов и дохода, отмечай как «крипто‑канал (новости)» и статус «без риска (новости/аналитика)» или вообще не включай в таблицу риска.

Шаг 2. Поиск жалоб в Telegram
1. Используй чаты, посвящённые скаму и жалобам (которые уже заданы в настройках), и ищи там: по названию/юзернейму канала (@username); по словам «скам», «обманули», «развод», «слил депозит», «мошенники».
2. Фиксируй: сколько разных людей жалуются (по никам); какие формулировки они используют («после оплаты VIP заблокировали», «слил депозит по их сигналам»).
3. В таблицу в столбец «Жалобы / отзывы» пиши короткое резюме:
   «2 человека в чате X пишут, что после сигналов канала слили депозит (без суммы).»
   «В чате Y жалуются, что после оплаты VIP автор перестаёт отвечать.»

Шаг 3. Поиск отзывов в интернете
Для каждого найденного канала/сайта делай запросы в поиске:
1. «имя канала» + отзывы
2. «имя канала» + scam
3. «имя канала» + обман
4. «имя канала» + развод
5. «имя канала» + жалобы
Ищи: форумы по трейдингу/крипте; комментарии под статьями; посты в соцсетях, где люди обсуждают этот канал/бот/сайт.
В таблицу заноси только то, что реально нашли. Если ничего не нашли — честно пиши:
«По доступным открытым источникам жалоб не найдено; если поиск был ограниченным, это нужно указать отдельно.»
"""

BLOCK_3 = """

Для каждого сигнального канала (чек‑лист)
Проверь и запись по каждому каналу:
1. Структура: новый или старый канал (примерно по дате создания/активности); есть ли VIP/платная подписка, курс, закрытый клуб; есть ли обещания дохода («x2 за день», «без риска», «гарантированная прибыль»).
2. Поведение: использует ли картинки монет со стрелками вверх/вниз; даёт ли поверхностные «обоснования» на 3–5 строк без сценариев риска; постоянно ли зовёт в VIP/личку («пиши в ЛС», «успей в VIP»); показывает ли убытки или только прибыльные сделки.
3. Жалобы: есть ли реальные жалобы в чатах и интернете; есть ли истории про слив депозита, обман с VIP, блокировку после оплаты; есть ли указанные суммы потерь (если да — фиксируй).
Всё это отражать в «Кратком описании», «VIP / деньги», «Жалобах / отзывах», «Признаках риска (флаги)» и «Итоговом статусе».
"""

BLOCK_4 = """

Честность данных
1. Все выводы должны опираться только на: реальные посты и описание канала; реальные сообщения в чатах; реальные страницы и комментарии в интернете.
2. Запрещено: придумывать жалобы и суммы потерь; придумывать признаки риска («мошенники», «кидают»), если это не подтверждается контентом или жалобами; приписывать каналу то, чего нет в его постах.
3. Разрешено и правильно: писать «жалоб не найдено»; писать «цена не указана»; писать «мало данных, объект под наблюдением», если реально мало информации.
"""

BLOCK_5 = """

Пример строки таблицы («как надо»)
Одна строка по всем 8 столбцам (формат):
• Объект / ссылка: @ExampleSignal (ссылка на https://t.me/ExampleSignal)
• Тип: сигнал‑канал
• Источник: поиск в Telegram
• Краткое описание: «Канал даёт сигналы по криптовалютам, обещает быстрый рост депозита и высокий процент успешных сделок.»
• VIP / деньги: «Продаёт VIP‑подписку, в постах указана цена 15 000₽ / месяц, приглашает писать в личку.»
• Жалобы / отзывы: «2 человека в чате X пишут, что после сигналов канала слили депозит (без указания суммы). В интернете найдено обсуждение на форуме Y, где жалуются, что после оплаты VIP автор перестаёт отвечать.»
• Признаки риска (флаги): «новый канал (< 14 дней); есть дорогой VIP; обещания высокого дохода без описания рисков; много картинок монет со стрелками вверх; показывает только прибыльные сделки; есть жалобы на слив депозита и отсутствие связи после оплаты VIP.»
• Итоговый статус: «в риске (структура + поведение + жалобы)»
Все такие описания должны быть основаны на реально найденном. Если подтвердить нельзя — лучше написать «нет данных» или «жалоб не найдено», чем придумать.
"""


def _paragraph_text(para):
    out = []
    for pe in para.get('elements', []):
        out.append(pe.get('textRun', {}).get('content', ''))
    return ''.join(out)


def _iter_text_segments(content):
    """Рекурсивно обходим body.content (и вложенные в таблицы), выдаём (startIndex, text) в порядке документа."""
    if not content:
        return
    for elem in content:
        si = elem.get('startIndex')
        if si is None:
            continue
        if 'paragraph' in elem:
            text = _paragraph_text(elem['paragraph'])
            if text:
                yield (si, text)
        elif 'table' in elem:
            for row in elem['table'].get('tableRows', []):
                for cell in row.get('tableCells', []):
                    for sub in _iter_text_segments(cell.get('content', [])):
                        yield sub


def _find_anchor_end_index(service, doc_id, pattern):
    """Найти в документе конец первого вхождения pattern; вернуть endIndex (после которого вставлять)."""
    doc = service.documents().get(documentId=doc_id).execute()
    body = doc.get('body', {})
    content = body.get('content', [])
    segments = list(_iter_text_segments(content))
    full = ''.join(t for _, t in segments)
    m = re.search(pattern, full)
    if not m:
        return None
    off_start, off_end = m.start(), m.end()
    cum = 0
    for si, text in segments:
        if cum <= off_start < cum + len(text):
            return si + (off_end - cum)
        cum += len(text)
    return None


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
    service = get_service()
    if not service:
        sys.exit(1)

    doc = service.documents().get(documentId=DOC_ID).execute()
    body = doc.get('body', {})
    content = body.get('content', [])
    full_text = ''.join(t for _, t in _iter_text_segments(content))
    if 'Правила по времени (обязательно)' in full_text and 'Маршрут поиска (где и как искать)' in full_text:
        print('Пять блоков ТЗ уже есть в документе. Ничего не вставляю.', file=sys.stderr)
        print('Документ: https://docs.google.com/document/d/%s/edit' % DOC_ID)
        return

    # Якоря: уникальные фразы, после которых вставляем блоки (регулярки допускают вариации)
    anchors = [
        (re.compile(r'Все каналы и детали по ним фиксируются только в таблице\.?'), BLOCK_1),
        (re.compile(r'никаких списков\s*@каналов[^.]*в логах\.?'), BLOCK_2),
        (re.compile(r'только как резюме предыдущих столбцов\.?'), BLOCK_3 + BLOCK_4 + BLOCK_5),
    ]

    indices = []
    for pattern, block in anchors:
        idx = _find_anchor_end_index(service, DOC_ID, pattern)
        if idx is None:
            # Пробуем укороченные варианты
            if 'только в таблице' in pattern.pattern:
                idx = _find_anchor_end_index(service, DOC_ID, re.compile(r'только в таблице\.?'))
            elif 'в логах' in pattern.pattern:
                idx = _find_anchor_end_index(service, DOC_ID, re.compile(r'в логах\.?'))
            elif 'предыдущих столбцов' in pattern.pattern:
                idx = _find_anchor_end_index(service, DOC_ID, re.compile(r'предыдущих столбцов\.?'))
        if idx is None:
            print('Не найден якорь в документе: %s' % pattern.pattern[:50], file=sys.stderr)
            sys.exit(1)
        indices.append((idx, block))

    # Вставки — с конца документа к началу, чтобы индексы не сдвигались
    indices.sort(key=lambda x: -x[0])

    for idx, block in indices:
        req = [{'insertText': {'location': {'index': idx}, 'text': block}}]
        service.documents().batchUpdate(documentId=DOC_ID, body={'requests': req}).execute()
        print('Вставлен блок после индекса %s' % idx, file=sys.stderr)

    print('Готово. Документ: https://docs.google.com/document/d/%s/edit' % DOC_ID)


if __name__ == '__main__':
    main()

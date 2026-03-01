"""
TGStat API client for KRO checker (criteria 1–3: growth, reach, channel age).
Requires TGSTAT_API_KEY in env. On failure or missing key, returns None so check_once continues.
"""
import os
import re
import time
from datetime import datetime, timezone

TGSTAT_API_KEY = (os.environ.get('TGSTAT_API_KEY') or '').strip()
TGSTAT_BASE = 'https://api.tgstat.ru'
REQUEST_TIMEOUT = 10


def _channel_id_for_api(channel_id):
    """Normalize channel identifier for TGStat (e.g. @name or t.me/name)."""
    s = (channel_id or '').strip()
    if not s:
        return None
    if s.startswith('t.me/+'):
        return s
    if s.startswith('t.me/'):
        return s
    if s.startswith('@'):
        return s
    return '@' + s


def _fetch(path, params):
    """GET request to TGStat API. Returns None on error."""
    if not TGSTAT_API_KEY:
        return None
    params = dict(params)
    params['token'] = TGSTAT_API_KEY
    try:
        import urllib.request
        import urllib.parse
        url = TGSTAT_BASE + path + '?' + urllib.parse.urlencode(params)
        req = urllib.request.Request(url, headers={'User-Agent': 'KRO-Checker/1.0'})
        with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT) as resp:
            data = resp.read().decode('utf-8')
            import json
            return json.loads(data)
    except Exception:
        return None


def fetch_channel_stats(channel_id):
    """
    Fetches TGStat data for the channel. Returns a dict with:
    - subscriber_growth_per_day: int or None (subscribers only on S+ plan)
    - growth_anomaly: 0 or 100 (>5000/day)
    - reach_ratio: float 0..1 (avg_post_reach/participants_count) or None
    - dead_ratio: 0 or 100 (reach < 5% of subscribers)
    - channel_age_days: int or None (from channels/get created_at)
    - rename_count: None (not in API)
    - participants_count: int or None
    Returns None if API key missing or request fails.
    """
    cid = _channel_id_for_api(channel_id)
    if not cid:
        return None
    out = {
        'subscriber_growth_per_day': None,
        'growth_anomaly': 0,
        'reach_ratio': None,
        'dead_ratio': 0,
        'channel_age_days': None,
        'rename_count': None,
        'participants_count': None,
    }
    # channels/stat — participants_count, avg_post_reach
    stat = _fetch('/channels/stat', {'channelId': cid})
    if stat and stat.get('status') == 'ok':
        r = stat.get('response') or {}
        participants = r.get('participants_count')
        avg_reach = r.get('avg_post_reach')
        if participants is not None:
            out['participants_count'] = int(participants)
        if participants and participants > 0 and avg_reach is not None:
            out['reach_ratio'] = round(int(avg_reach) / int(participants), 4)
            if out['reach_ratio'] < 0.05:
                out['dead_ratio'] = 100
    time.sleep(0.5)
    # channels/get — created_at for channel age
    get_resp = _fetch('/channels/get', {'channelId': cid})
    if get_resp and get_resp.get('status') == 'ok':
        r = get_resp.get('response') or {}
        created = r.get('created_at')
        if created is not None:
            try:
                ts = int(created)
                now = int(datetime.now(timezone.utc).timestamp())
                out['channel_age_days'] = max(0, (now - ts) // 86400)
            except (TypeError, ValueError):
                pass
    time.sleep(0.5)
    # channels/subscribers (S+ plan) — growth per day
    sub = _fetch('/channels/subscribers', {'channelId': cid, 'group': 'day'})
    if sub and sub.get('status') == 'ok':
        arr = sub.get('response') or []
        if len(arr) >= 2:
            try:
                a, b = int(arr[0].get('participants_count', 0)), int(arr[1].get('participants_count', 0))
                growth = abs(a - b)
                out['subscriber_growth_per_day'] = growth
                if growth > 5000:
                    out['growth_anomaly'] = 100
            except (TypeError, ValueError, KeyError):
                pass
    return out


def search_channels(query, country='ru', limit=100):
    """
    Search channels by keyword. Requires TGStat API Stat (S+) plan.
    Returns list of dicts: username, link, title, participants_count, created_at (unix ts), or [] on error.
    """
    if not TGSTAT_API_KEY:
        return []
    params = {'q': query, 'country': country, 'limit': min(100, max(1, limit)), 'peer_type': 'channel'}
    try:
        data = _fetch('/channels/search', params)
        if not data or data.get('status') != 'ok':
            return []
        items = (data.get('response') or {}).get('items') or []
        return [
            {
                'username': (x.get('username') or '').strip() or ('@' + (x.get('link') or '').replace('https://t.me/', '').replace('t.me/', '')),
                'link': (x.get('link') or '').strip() or ('https://t.me/' + (x.get('username') or '').lstrip('@')),
                'title': (x.get('title') or '').strip(),
                'participants_count': int(x.get('participants_count', 0)) if x.get('participants_count') is not None else None,
                'created_at': int(x['created_at']) if x.get('created_at') is not None else None,
            }
            for x in items
        ]
    except Exception:
        return []

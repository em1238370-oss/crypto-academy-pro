#!/usr/bin/env python3
"""
One-time script: replace the "Sources and Data" Google Doc content
with a single line pointing to the /monitor page.
"""
import os
import sys
import warnings
warnings.filterwarnings('ignore', category=FutureWarning)

SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
BACKEND_DIR = os.path.normpath(os.path.join(SCRIPT_DIR, '..'))

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
                if (value.startswith("'") and value.endswith("'")) or \
                   (value.startswith('"') and value.endswith('"')):
                    value = value[1:-1]
                if key and key not in os.environ:
                    os.environ[key] = value
        break

MONITOR_URL = 'https://crypto-academy-pro.onrender.com/monitor'
NEW_TEXT = f'Актуальные данные системы мониторинга: {MONITOR_URL}'


def get_creds():
    import json as _json
    json_str = os.environ.get('KRO_GOOGLE_CREDENTIALS_JSON')
    json_path = os.environ.get('GOOGLE_APPLICATION_CREDENTIALS')

    search_dirs = [SCRIPT_DIR, os.getcwd(), os.path.join(BACKEND_DIR, 'kro-worker')]

    try:
        from google.oauth2 import service_account
        scopes = ['https://www.googleapis.com/auth/documents']

        if json_str:
            return service_account.Credentials.from_service_account_info(
                _json.loads(json_str), scopes=scopes)
        if json_path and os.path.isfile(json_path):
            return service_account.Credentials.from_service_account_file(
                json_path, scopes=scopes)
        for d in search_dirs:
            for name in ('credentials.json', 'kro-google-credentials.json'):
                p = os.path.join(d, name)
                if os.path.isfile(p):
                    return service_account.Credentials.from_service_account_file(
                        p, scopes=scopes)
    except Exception as e:
        print(f'get_creds error: {e}', file=sys.stderr)
    return None


def replace_doc(doc_id, new_text):
    creds = get_creds()
    if not creds:
        print('No Google credentials found.', file=sys.stderr)
        return False
    try:
        from googleapiclient.discovery import build
        service = build('docs', 'v1', credentials=creds)

        doc = service.documents().get(documentId=doc_id).execute()
        content = doc.get('body', {}).get('content', [])
        end_index = 1
        for elem in content:
            ei = elem.get('endIndex', 1)
            if ei > end_index:
                end_index = ei
        # keep last newline (docs always has it)
        delete_end = max(1, end_index - 1)

        requests = []
        if delete_end > 1:
            requests.append({'deleteContentRange': {
                'range': {'startIndex': 1, 'endIndex': delete_end}
            }})
        requests.append({'insertText': {
            'location': {'index': 1},
            'text': new_text
        }})

        service.documents().batchUpdate(
            documentId=doc_id,
            body={'requests': requests}
        ).execute()
        print(f'Doc updated: https://docs.google.com/document/d/{doc_id}/edit')
        return True
    except Exception as e:
        print(f'replace_doc error: {e}', file=sys.stderr)
        return False


def main():
    doc_id = os.environ.get('KRO_SOURCES_DOC_ID', '').strip()
    if not doc_id:
        print('KRO_SOURCES_DOC_ID not set. Set it in .env and re-run.', file=sys.stderr)
        sys.exit(1)
    print(f'Replacing doc {doc_id} with monitor link…')
    ok = replace_doc(doc_id, NEW_TEXT)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()

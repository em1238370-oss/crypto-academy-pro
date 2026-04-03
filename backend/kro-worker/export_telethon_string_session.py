#!/usr/bin/env python3
"""
Алиас для convert_session.py — та же одна строка StringSession для KRO_TELEGRAM_SESSION_STRING.

Предпочтительно:

  cd backend/kro-worker && python3 convert_session.py
"""
from __future__ import annotations

import asyncio

from convert_session import main

if __name__ == '__main__':
    asyncio.run(main())

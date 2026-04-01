# -*- coding: utf-8 -*-
"""Per-RPC timeouts for Telethon (KRO_TELETHON_RPC_TIMEOUT, default 10s)."""
from __future__ import annotations

import asyncio
import os
from typing import Any, List, TypeVar

T = TypeVar('T')

TELETHON_RPC_TIMEOUT = float(os.environ.get('KRO_TELETHON_RPC_TIMEOUT', '10') or '10')


async def tw_call(coro, timeout: float | None = None) -> Any:
    t = TELETHON_RPC_TIMEOUT if timeout is None else timeout
    return await asyncio.wait_for(coro, timeout=t)


async def tw_collect_messages(
    client,
    entity,
    *,
    limit: int = 40,
    per_msg_timeout: float | None = None,
) -> List[Any]:
    """
    Pull up to `limit` messages; each __anext__ is bounded by per_msg_timeout
    (default TELETHON_RPC_TIMEOUT). Stops on timeout or end of iterator.
    """
    t = TELETHON_RPC_TIMEOUT if per_msg_timeout is None else per_msg_timeout
    out: List[Any] = []
    agen = client.iter_messages(entity, limit=limit)
    ait = agen.__aiter__()
    while len(out) < limit:
        try:
            msg = await asyncio.wait_for(ait.__anext__(), timeout=t)
        except (StopAsyncIteration, asyncio.TimeoutError):
            break
        out.append(msg)
    return out

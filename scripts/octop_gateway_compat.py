"""Pinned Octop startup adapter for structured platform policy refusals."""
from __future__ import annotations


def policy_error(exc):
    seen = set()
    while isinstance(exc, BaseException) and id(exc) not in seen:
        seen.add(id(exc))
        body = getattr(exc, "body", None)
        if isinstance(body, dict):
            error = body.get("error", body)
            if isinstance(error, dict) and error.get("type") == "policy_denied":
                if getattr(exc, "status_code", None) == 403:
                    return error
        exc = exc.__cause__ or (None if exc.__suppress_context__ else exc.__context__)
    return None


def install():
    from octop.i18n.domains import stream
    from langchain.agents.middleware import model_retry

    original_format = stream.format_stream_error
    original_retry = model_retry.should_retry_exception

    def format_error(exc, locale="en"):
        error = policy_error(exc)
        if error and error.get("code") in {"no_quota", "quota_insufficient"}:
            if str(locale).lower().startswith("zh"):
                return "当前用途的可用额度不足，请在平台查看额度或申请追加。"
            return "Insufficient platform quota for this purpose. Check or request quota in the platform."
        return original_format(exc, locale)

    def should_retry(exc, retry_on):
        if policy_error(exc):
            return False
        return original_retry(exc, retry_on)

    stream.format_stream_error = format_error
    model_retry.should_retry_exception = should_retry

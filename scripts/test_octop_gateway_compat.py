import unittest
import httpx
from openai import PermissionDeniedError, AuthenticationError, InternalServerError
from octop_gateway_compat import install, policy_error

install()
from octop.i18n.domains.stream import format_stream_error
from langchain.agents.middleware.model_retry import should_retry_exception


def error(cls, status, body):
    return cls("upstream refusal", response=httpx.Response(status, request=httpx.Request("POST", "http://127.0.0.1/v1/chat/completions")), body=body)


class GatewayCompatTest(unittest.TestCase):
    def test_quota_refusal_and_wrapped_cause(self):
        cause = error(PermissionDeniedError, 403, {"error": {"type": "policy_denied", "code": "quota_insufficient"}})
        wrapped = RuntimeError("wrapped")
        wrapped.__cause__ = cause
        self.assertIn("额度不足", format_stream_error(wrapped, "zh"))
        self.assertIn("Insufficient platform quota", format_stream_error(wrapped, "en"))
        self.assertFalse(should_retry_exception(wrapped, lambda _: True))

    def test_denied_without_quota_has_no_quota_message(self):
        cause = error(PermissionDeniedError, 403, {"type": "policy_denied", "code": "model_not_open"})
        self.assertFalse(should_retry_exception(cause, lambda _: True))
        self.assertNotIn("额度不足", format_stream_error(cause, "zh"))

    def test_unrelated_errors_keep_original_retry_policy(self):
        for cause in [error(AuthenticationError, 401, {"type": "authentication_error"}), error(InternalServerError, 500, {"type": "upstream_error"})]:
            self.assertIsNone(policy_error(cause))
            self.assertTrue(should_retry_exception(cause, lambda _: True))
            self.assertFalse(should_retry_exception(cause, lambda _: False))

    def test_strings_and_cycles_are_not_trusted_policy(self):
        self.assertIsNone(policy_error("policy_denied quota_insufficient"))
        cause = RuntimeError("cycle")
        cause.__cause__ = cause
        self.assertIsNone(policy_error(cause))


if __name__ == "__main__":
    unittest.main()

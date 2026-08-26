import json
import logging

from app import logsetup
from app.config import settings
from app.logsetup import JsonFormatter, configure_logging
from app.middleware import RequestIdLogFilter, request_id_var


def _record(msg="hello", exc_info=None):
    return logging.LogRecord(
        name="app.test",
        level=logging.INFO,
        pathname=__file__,
        lineno=1,
        msg=msg,
        args=None,
        exc_info=exc_info,
    )


def test_json_formatter_emits_one_parseable_line():
    line = JsonFormatter().format(_record())
    assert "\n" not in line
    payload = json.loads(line)
    assert payload["level"] == "INFO"
    assert payload["logger"] == "app.test"
    assert payload["msg"] == "hello"
    assert payload["ts"].endswith("+00:00")


def test_json_formatter_carries_the_request_id():
    token = request_id_var.set("abc123def456")
    try:
        record = _record()
        RequestIdLogFilter().filter(record)
        assert json.loads(JsonFormatter().format(record))["request_id"] == "abc123def456"
    finally:
        request_id_var.reset(token)


def test_request_id_defaults_when_the_filter_never_ran():
    assert json.loads(JsonFormatter().format(_record()))["request_id"] == "-"


def test_multiline_message_stays_on_one_line():
    line = JsonFormatter().format(_record("first\nsecond"))
    assert "\n" not in line
    assert json.loads(line)["msg"] == "first\nsecond"


def test_exception_traceback_goes_in_exc():
    try:
        raise ValueError("boom")
    except ValueError:
        import sys

        record = _record("failed", exc_info=sys.exc_info())
    payload = json.loads(JsonFormatter().format(record))
    assert "ValueError: boom" in payload["exc"]
    assert "\n" not in JsonFormatter().format(record)


def test_json_log_format_installs_the_json_formatter(monkeypatch, restore_root_logging):
    monkeypatch.setattr(settings, "log_format", "json")
    configure_logging()
    assert all(
        isinstance(h.formatter, JsonFormatter) for h in logging.getLogger().handlers
    )


def test_invalid_log_format_falls_back_to_text(monkeypatch, restore_root_logging, caplog):
    monkeypatch.setattr(settings, "log_format", "yaml")
    with caplog.at_level(logging.WARNING, logger=""):
        configure_logging()
    assert not any(
        isinstance(h.formatter, JsonFormatter) for h in logging.getLogger().handlers
    )
    assert "LOG_FORMAT" in caplog.text


def test_text_is_the_default(monkeypatch, restore_root_logging):
    monkeypatch.setattr(settings, "log_format", "text")
    configure_logging()
    assert not any(
        isinstance(h.formatter, JsonFormatter) for h in logging.getLogger().handlers
    )
    assert logsetup.TEXT_FORMAT.count("%(request_id)s") == 1

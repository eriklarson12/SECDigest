import datetime
import json
import logging

from app.config import settings
from app.middleware import RequestIdLogFilter


TEXT_FORMAT = "%(asctime)s %(levelname)s [%(request_id)s] %(name)s: %(message)s"


class JsonFormatter(logging.Formatter):
    """One JSON object per line, so `heroku logs --tail | jq` and log drains can read it."""

    def format(self, record: logging.LogRecord) -> str:
        payload = {
            "ts": datetime.datetime.fromtimestamp(
                record.created, datetime.timezone.utc
            ).isoformat(),
            "level": record.levelname,
            # Supplied by RequestIdLogFilter; "-" outside a request
            "request_id": getattr(record, "request_id", "-"),
            "logger": record.name,
            "msg": record.getMessage(),
        }
        if record.exc_info:
            payload["exc"] = self.formatException(record.exc_info)
        return json.dumps(payload)


def configure_logging() -> None:
    """Install the root handler, the request-ID filter, and the LOG_FORMAT renderer."""
    logging.basicConfig(level=logging.INFO, format=TEXT_FORMAT)
    root = logging.getLogger()
    # Filter first: the text format references %(request_id)s, so a warning
    # logged before this is attached would fail to render.
    for handler in root.handlers:
        handler.addFilter(RequestIdLogFilter())

    log_format = settings.log_format.strip().lower()
    if log_format not in ("text", "json"):
        root.warning("Unknown LOG_FORMAT %r, using text", settings.log_format)
        log_format = "text"

    if log_format == "json":
        for handler in root.handlers:
            handler.setFormatter(JsonFormatter())

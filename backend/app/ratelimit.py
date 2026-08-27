from slowapi import Limiter
from slowapi.util import get_remote_address


# headers_enabled makes slowapi write X-RateLimit-* on every limited response.
# It injects them into the endpoint's `response: Response` parameter, so every
# @limiter.limit endpoint MUST declare one or the request raises at return.
limiter = Limiter(key_func=get_remote_address, headers_enabled=True)

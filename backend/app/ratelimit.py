from slowapi import Limiter
from slowapi.util import get_remote_address


# headers_enabled makes slowapi write X-RateLimit-* on every limited response.
# It injects them into the endpoint's `response: Response` parameter, so every
# @limiter.limit endpoint MUST declare one or the request raises at return.
# key_style defaults to "url", which keys the budget on the concrete request path: every
# CIK and every analysis id would get its own allowance on a path-parameterized route.
# "endpoint" keys on the view function, so a limit is a budget per route.
limiter = Limiter(
    key_func=get_remote_address, headers_enabled=True, key_style="endpoint"
)

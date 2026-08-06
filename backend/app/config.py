from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    gemini_api_key: str = ""
    gemini_model: str = "gemini-2.5-flash"
    # Retried once on quota exhaustion of the primary model; "" disables
    gemini_fallback_model: str = "gemini-2.5-flash-lite"
    max_filing_chars: int = 600_000
    daily_analysis_cap: int = 200
    max_request_bytes: int = 10_000
    supabase_url: str = ""
    supabase_key: str = ""
    sec_user_agent: str = "SECDigest admin@example.com"
    frontend_url: str = "http://localhost:3000"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()

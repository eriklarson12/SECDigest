from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    gemini_api_key: str = ""
    gemini_model: str = "gemini-3.6-flash"
    # Retried once on quota exhaustion of the primary model; "" disables
    gemini_fallback_model: str = "gemini-3.5-flash-lite"
    # Q&A runs on its own model: RPD is metered per model, so questions draw on
    # a separate daily pool from analyses. "" routes Q&A back to gemini_model.
    gemini_qa_model: str = "gemini-3.5-flash-lite"
    # Embeddings for filing Q&A (768-dim via output_dimensionality)
    gemini_embed_model: str = "gemini-embedding-001"
    max_filing_chars: int = 600_000
    daily_analysis_cap: int = 200
    max_request_bytes: int = 10_000
    supabase_url: str = ""
    supabase_key: str = ""
    sec_user_agent: str = "SECDigest admin@example.com"
    frontend_url: str = "http://localhost:3000"
    # "text" | "json"; anything else warns at startup and renders as text
    log_format: str = "text"

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8"}


settings = Settings()

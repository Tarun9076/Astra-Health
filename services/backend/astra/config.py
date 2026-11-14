from pathlib import Path

from pydantic import AliasChoices, Field
from pydantic_settings import BaseSettings, SettingsConfigDict

from astra.core.enums import NodeRole

BACKEND_ROOT = Path(__file__).resolve().parent.parent
REPO_ROOT = BACKEND_ROOT.parent.parent


class Settings(BaseSettings):
    """All configuration comes from ASTRA_* environment variables or services/backend/.env (LLD §18)."""

    model_config = SettingsConfigDict(env_prefix="ASTRA_", env_file=BACKEND_ROOT / ".env", extra="ignore")

    node_role: NodeRole = NodeRole.HABITAT
    node_id: str = "HAB-ARES-1"
    peer_url: str | None = "http://localhost:8001"
    mission_code: str = "ARES-1"

    database_url: str = "sqlite:///habitat.db"
    protocols_path: Path = REPO_ROOT / "protocols"
    kb_path: Path = REPO_ROOT / "knowledge"
    models_path: Path = BACKEND_ROOT / "models"
    cors_origins: list[str] = ["http://localhost:5173"]

    # auto = Claude if a key is set, else Ollama if reachable, else template (TDD ADR-07)
    llm_provider: str = "auto"
    llm_model: str = "claude-opus-5-5"
    ollama_url: str = "http://localhost:11434"
    # Read without the ASTRA_ prefix, the same name the anthropic SDK uses.
    anthropic_api_key: str | None = Field(default=None, validation_alias=AliasChoices("ANTHROPIC_API_KEY"))

    # External data (Ground node fetches; cached to files for offline demos).
    nasa_api_key: str | None = None  # api.nasa.gov key for DONKI space weather; empty = disabled
    jwt_secret: str = "dev-only-change-me"  # set a random value in .env
    access_token_minutes: int = 12 * 60  # long enough for a demo day
    bcrypt_rounds: int = 12  # tests lower this to 4 for speed


settings = Settings()

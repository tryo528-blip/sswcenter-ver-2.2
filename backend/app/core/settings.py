from __future__ import annotations

import tempfile
from enum import StrEnum
from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict
from sqlalchemy.engine import make_url


class Environment(StrEnum):
    DEVELOPMENT = "development"
    TEST = "test"
    PRODUCTION = "production"


def _database_name(database_url: str) -> str:
    return make_url(database_url).database or ""


def assert_safe_test_database_url(database_url: str) -> None:
    url = make_url(database_url)
    database_name = url.database or ""
    if url.get_backend_name() != "postgresql":
        raise ValueError("Wave 0 tests require PostgreSQL; SQLite and substitutes are forbidden")
    if not database_name.endswith(("_test", "_review")):
        raise ValueError("test database name must end with _test or _review")


def assert_migration_database_url(database_url: str) -> None:
    url = make_url(database_url)
    database_name = url.database or ""
    if url.get_backend_name() != "postgresql":
        raise ValueError("Alembic migrations require PostgreSQL")
    if database_name in {"postgres", "template0", "template1"}:
        raise ValueError("Alembic migrations refuse PostgreSQL maintenance databases")


def assert_safe_test_data_root(data_root: Path) -> None:
    resolved = data_root.expanduser().resolve()
    temporary_root = Path(tempfile.gettempdir()).resolve()
    if not resolved.is_relative_to(temporary_root):
        raise ValueError("test data root must stay inside the operating-system temporary directory")
    if not resolved.name.startswith("sswcenter-"):
        raise ValueError("test data root directory name must start with sswcenter-")


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        env_prefix="SSWCENTER_",
        extra="ignore",
    )

    environment: Environment = Environment.DEVELOPMENT
    app_version: str = "0.1.0"
    database_url: str | None = None
    data_root: Path | None = None

    dev_login_bypass: bool = False
    session_cookie_name: str = "sswcenter_session"
    csrf_cookie_name: str = "sswcenter_csrf"
    device_cookie_name: str = "sswcenter_device"
    csrf_header_name: str = "X-CSRF-Token"
    cookie_secure: bool = False
    session_idle_minutes: int = 30
    session_absolute_minutes: int = 480

    pin_pepper: SecretStr | None = None
    pin_lookup_key: SecretStr | None = None
    csrf_signing_key: SecretStr | None = None
    resident_number_key_v1: SecretStr | None = None
    resident_number_lookup_key: SecretStr | None = None
    resident_number_active_key_version: int = 1
    # Dedicated W1D certification-transition HMAC key (not CSRF/pin/app secret).
    transition_token_key: SecretStr | None = None

    @model_validator(mode="after")
    def validate_environment_safety(self) -> Settings:
        if self.session_idle_minutes <= 0 or self.session_absolute_minutes <= 0:
            raise ValueError("session expiration values must be positive")
        if self.session_idle_minutes > self.session_absolute_minutes:
            raise ValueError("idle session expiration cannot exceed absolute expiration")
        if self.resident_number_active_key_version != 1:
            raise ValueError("only resident-number key version 1 is configured")

        if self.environment is Environment.TEST:
            if self.database_url is None:
                raise ValueError("test environment requires SSWCENTER_DATABASE_URL")
            assert_safe_test_database_url(self.database_url)
            if self.data_root is None:
                raise ValueError("test environment requires SSWCENTER_DATA_ROOT")
            assert_safe_test_data_root(self.data_root)

        if self.environment is Environment.PRODUCTION:
            if self.dev_login_bypass:
                raise ValueError("development login bypass is forbidden in production")
            if self.database_url is None:
                raise ValueError("production requires SSWCENTER_DATABASE_URL")
            assert_migration_database_url(self.database_url)
            url = make_url(self.database_url)
            if url.get_backend_name() != "postgresql":
                raise ValueError("production requires PostgreSQL")
            if url.host not in {"127.0.0.1", "localhost", "::1"}:
                raise ValueError("production PostgreSQL must use a loopback host")
            if self.data_root is None or not self.data_root.is_absolute():
                raise ValueError("production requires an absolute SSWCENTER_DATA_ROOT")
            if not self.cookie_secure:
                raise ValueError("production session cookies must be Secure")
            if self.pin_pepper is None or self.pin_lookup_key is None:
                raise ValueError("production PIN secrets must be configured outside the repository")
            if self.csrf_signing_key is None:
                raise ValueError("production CSRF signing key must be configured")
            if self.resident_number_key_v1 is None or self.resident_number_lookup_key is None:
                raise ValueError(
                    "production resident-number encryption and lookup keys must be configured"
                )
            if self.transition_token_key is None:
                raise ValueError(
                    "production requires SSWCENTER_TRANSITION_TOKEN_KEY "
                    "(dedicated certification-transition token HMAC key)"
                )

        # Non-production: explicit fallback when unset (tests/dev only).
        if self.environment is not Environment.PRODUCTION and self.transition_token_key is None:
            self.transition_token_key = SecretStr(
                "sswcenter-dev-transition-token-key-not-for-production"
            )

        return self

    @property
    def database_name(self) -> str | None:
        if self.database_url is None:
            return None
        return _database_name(self.database_url)

    def secret_value(self, name: str) -> str:
        configured = {
            "pin_pepper": self.pin_pepper,
            "pin_lookup_key": self.pin_lookup_key,
            "csrf_signing_key": self.csrf_signing_key,
        }[name]
        if configured is not None:
            return configured.get_secret_value()
        if self.environment is Environment.PRODUCTION:
            raise RuntimeError(f"{name} is required in production")
        return f"sswcenter-{self.environment.value}-{name}-only"


@lru_cache
def get_settings() -> Settings:
    return Settings()

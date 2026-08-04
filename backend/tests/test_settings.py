import pytest
from pydantic import ValidationError

from app.core.settings import (
    Environment,
    Settings,
    assert_migration_database_url,
    assert_safe_test_data_root,
    assert_safe_test_database_url,
)


def test_test_database_guard_accepts_isolated_postgres_names() -> None:
    assert_safe_test_database_url("postgresql+psycopg://user:secret@127.0.0.1/sswcenter_test")
    assert_safe_test_database_url("postgresql+psycopg://user:secret@127.0.0.1/review_review")


@pytest.mark.parametrize(
    "database_url",
    [
        "sqlite:///test.db",
        "postgresql+psycopg://user:secret@127.0.0.1/sswcenter",
        "postgresql+psycopg://user:secret@127.0.0.1/production",
    ],
)
def test_test_database_guard_rejects_unsafe_targets(database_url: str) -> None:
    with pytest.raises(ValueError):
        assert_safe_test_database_url(database_url)


@pytest.mark.parametrize(
    "database_url",
    [
        "postgresql+psycopg://postgres@127.0.0.1/postgres",
        "postgresql+psycopg://postgres@127.0.0.1/template0",
        "postgresql+psycopg://postgres@127.0.0.1/template1",
    ],
)
def test_alembic_guard_rejects_maintenance_databases(database_url: str) -> None:
    with pytest.raises(ValueError, match="maintenance"):
        assert_migration_database_url(database_url)


def test_production_refuses_development_login_bypass() -> None:
    with pytest.raises(ValidationError, match="development login bypass"):
        Settings(
            environment=Environment.PRODUCTION,
            database_url="postgresql+psycopg://app:secret@127.0.0.1/sswcenter",
            data_root="C:/ProgramData/SSWCenter/data",
            dev_login_bypass=True,
            cookie_secure=True,
            pin_pepper="pepper",
            pin_lookup_key="lookup",
            csrf_signing_key="csrf",
        )


def test_test_data_root_guard_accepts_only_named_temporary_directory(tmp_path: object) -> None:
    from pathlib import Path

    safe_root = Path(str(tmp_path)) / "sswcenter-test-data"
    assert_safe_test_data_root(safe_root)

    with pytest.raises(ValueError, match="temporary directory"):
        assert_safe_test_data_root(Path("C:/ProgramData/SSWCenter/data"))


def test_test_environment_requires_isolated_database_and_file_root(tmp_path: object) -> None:
    from pathlib import Path

    safe_root = Path(str(tmp_path)) / "sswcenter-test-data"
    settings = Settings(
        environment=Environment.TEST,
        database_url="postgresql+psycopg://user:secret@127.0.0.1/sswcenter_test",
        data_root=safe_root,
    )
    assert settings.environment is Environment.TEST

    with pytest.raises(ValidationError, match="SSWCENTER_DATA_ROOT"):
        Settings(
            environment=Environment.TEST,
            database_url="postgresql+psycopg://user:secret@127.0.0.1/sswcenter_test",
        )

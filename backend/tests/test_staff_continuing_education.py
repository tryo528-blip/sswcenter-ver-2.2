from pathlib import Path
from types import SimpleNamespace

from app.domains.staff.schemas import TrainingCycleType
from app.domains.staff.service import StaffService

REPO_ROOT = Path(__file__).resolve().parents[2]
MIGRATION = (
    REPO_ROOT / "backend" / "alembic" / "versions" / "20260802_0013_staff_continuing_education.py"
)
POSTCHECK = REPO_ROOT / "backend" / "app" / "db" / "postcheck_w1a_vs1.py"


def test_continuing_education_migration_extends_catalog_without_rewriting_vs3() -> None:
    source = MIGRATION.read_text(encoding="utf-8")
    assert "20260801_0012_w1e_care_assignment" in source
    assert "CONTINUING_EDUCATION" in source
    assert "'보수교육', 'BIENNIAL'" in source
    assert source.count("op.f(_CYCLE_CONSTRAINT)") == 4
    assert TrainingCycleType.BIENNIAL.value == "BIENNIAL"


def test_biennial_training_uses_a_calendar_year_period() -> None:
    course = SimpleNamespace(cycle_type="BIENNIAL")
    assert StaffService._validate_periodic_course_and_period(course, "2026") == "2026"


def test_postcheck_preserves_historical_catalog_and_accepts_new_head() -> None:
    source = POSTCHECK.read_text(encoding="utf-8")
    assert 'CONTINUING_EDUCATION_REVISION = "20260802_0013_staff_continuing_education"' in source
    assert "W1E_LINEAGE_REVISIONS" in source
    assert "include_continuing_education" in source
    assert "STAFF_CONTINUING_EDUCATION_DB_POSTCHECK_OK" in source
